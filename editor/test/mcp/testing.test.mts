import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { getProjectCodeTests, runProjectCodeTests, setProjectCodeTests } from "../../src/mcp/testing/code-tests";
import { exportTestingRunReport, runTesting } from "../../src/mcp/testing/runner";
import { clearTestingRuns, createTestCase, createTestSuite, deleteTestCase, getTestingCapabilities, getTestingState, setTestingSettings } from "../../src/mcp/testing/state";

describe("mcp/testing", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const forceUpdate = vi.fn();
	const options = {
		editor: {
			state: { packageManager: "npm" },
			layout: {
				inspector: { forceUpdate },
				preview: { canvas: null, play: { state: { playing: false }, stop: vi.fn() } },
			},
		},
	} as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-testing-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		forceUpdate.mockClear();
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		scene.dispose();
		engine.dispose();
		await rm(projectDirectory, { recursive: true, force: true });
	});

	test("migrates legacy state and enforces exact revisions for suite and case authoring", () => {
		scene.metadata = {
			babylonEditorSceneTests: [{ id: "legacy-case", name: "Legacy case", assertions: [] }],
		};
		const migrated = getTestingState(scene);
		expect(migrated).toMatchObject({ version: 2, revision: 0, suites: [{ id: "legacy-scene-tests", mode: "play", tests: [{ id: "legacy-case" }] }] });
		expect(getTestingCapabilities(scene)).toMatchObject({ modes: expect.arrayContaining(["edit", "play", "connected-player", "headless", "project-code"]) });

		const withSuite = createTestSuite(scene, { expectedRevision: 0, id: "edit-suite", name: "Edit suite", mode: "edit" }, options);
		expect(withSuite.revision).toBe(1);
		expect(() => createTestSuite(scene, { expectedRevision: 0, name: "Stale", mode: "edit" }, options)).toThrow("stale");
		const withCase = createTestCase(
			scene,
			{
				expectedRevision: 1,
				suiteId: "edit-suite",
				test: { id: "edit-case", name: "Edit case", kind: "scene", assertions: [] },
			},
			options
		);
		expect(withCase.revision).toBe(2);
		expect(deleteTestCase(scene, { expectedRevision: 2, suiteId: "edit-suite", testId: "edit-case", confirm: true }, options).revision).toBe(3);
		expect(setTestingSettings(scene, { expectedRevision: 3, settings: { defaultTimeoutMs: 2500 } }, options).settings.defaultTimeoutMs).toBe(2500);
	});

	test("runs Edit cases against the live scene, restores mutations, retains and exports reports", async () => {
		const subject = new TransformNode("Subject", scene);
		subject.position.set(1, 2, 3);
		createTestSuite(scene, { expectedRevision: 0, id: "edit-suite", name: "Edit suite", mode: "edit" }, options);
		const authored = createTestCase(
			scene,
			{
				expectedRevision: 1,
				suiteId: "edit-suite",
				test: {
					id: "position-case",
					name: "Position case",
					kind: "scene",
					steps: [{ type: "set-node-position", nodeId: subject.id, value: [8, 9, 10] }],
					assertions: [{ type: "node-position", nodeId: subject.id, equals: [8, 9, 10] }],
				},
			},
			options
		);
		const report = await runTesting(scene, { expectedRevision: authored.revision, modes: ["edit"] }, options);
		expect(report).toMatchObject({ target: "editor-edit", status: "passed", summary: { total: 1, passed: 1 } });
		expect(subject.position.asArray()).toEqual([1, 2, 3]);
		expect(getTestingState(scene).runs[0].id).toBe(report.id);

		const exported = await exportTestingRunReport(scene, { runId: report.id, format: "junit", path: ".bjseditor/test-results/edit.xml" });
		expect(exported).toMatchObject({ exported: true, format: "junit" });
		expect(await readFile(join(projectDirectory, ".bjseditor/test-results/edit.xml"), "utf8")).toContain("<testsuite");
		expect(clearTestingRuns(scene, { expectedRevision: authored.revision, runIds: [report.id], confirm: true }, options).runs).toHaveLength(0);
	});

	test("discovers and runs bounded project-owned code-test scripts", async () => {
		await writeFile(
			join(projectDirectory, "package.json"),
			JSON.stringify({
				scripts: { test: "node -e \"console.log('code-tests-ok')\"", coverage: "node -e \"console.log('coverage-ok')\"" },
				devDependencies: { vitest: "1.0.0" },
			}),
			"utf8"
		);
		await writeFile(join(projectDirectory, "sample.test.ts"), "export {};\n", "utf8");
		const discovered = await getProjectCodeTests(scene);
		expect(discovered).toMatchObject({ revision: 0, framework: "vitest", configuredScriptAvailable: true, discoveredFiles: ["sample.test.ts"] });
		await expect(setProjectCodeTests(scene, { expectedRevision: 9, timeoutMs: 2000 }, options)).rejects.toThrow("stale");
		const configured = await setProjectCodeTests(scene, { expectedRevision: 0, timeoutMs: 10_000, maximumOutputBytes: 16_384 }, options);
		const result = await runProjectCodeTests(scene, { expectedRevision: configured.revision, confirm: true }, options);
		expect(result).toMatchObject({ status: "passed", exitCode: 0, packageScript: "test" });
		expect(result.output).toContain("code-tests-ok");
	});

	test.skipIf(process.platform === "win32")(
		"a timed-out code-test run also ends the processes its package script started",
		async () => {
			const pidFile = join(projectDirectory, "grandchild.pid");
			// The package manager runs node, which never exits on its own and keeps the output pipe open.
			const hang = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
			await writeFile(join(projectDirectory, "package.json"), JSON.stringify({ scripts: { test: hang } }), "utf8");
			const configured = await setProjectCodeTests(scene, { expectedRevision: 0, timeoutMs: 1_000 }, options);

			const result = await runProjectCodeTests(scene, { expectedRevision: configured.revision, confirm: true }, options);
			expect(result.status).toBe("timed-out");

			const grandchild = Number(await readFile(pidFile, "utf8"));
			const alive = (): boolean => {
				try {
					process.kill(grandchild, 0);
					return true;
				} catch {
					return false;
				}
			};
			for (let attempt = 0; attempt < 50 && alive(); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(alive()).toBe(false);
			expect((await getProjectCodeTests(scene)).active).toBeNull();
		},
		30_000
	);
});

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NullEngine, Scene, SceneSerializer, TransformNode, Vector3 } from "babylonjs";
import { createPortableTestingState } from "babylonjs-editor-tools";
import { afterEach, describe, expect, test } from "vitest";

import { runHeadlessTesting } from "../src/test/testing.mjs";

describe("headless testing CLI", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	test("runs exported scene assertions and writes JUnit", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-testing-cli-"));
		directories.push(project);
		const sceneDirectory = join(project, "public", "scene");
		await mkdir(sceneDirectory, { recursive: true });
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const subject = new TransformNode("Subject", scene);
		subject.id = "subject";
		subject.position.copyFrom(new Vector3(1, 2, 3));
		const state = createPortableTestingState();
		state.suites.push({
			id: "headless-suite",
			name: "Headless Suite",
			enabled: true,
			mode: "edit",
			categories: ["ci"],
			beforeEach: [],
			afterEach: [],
			tests: [
				{
					id: "subject-position",
					name: "Subject position",
					enabled: true,
					kind: "scene",
					categories: ["smoke"],
					repeat: 1,
					setup: [],
					steps: [],
					teardown: [],
					assertions: [{ type: "node-position", nodeId: subject.id, equals: [1, 2, 3] }],
				},
			],
		});
		scene.metadata = { babylonEditorTesting: state };
		await writeFile(join(sceneDirectory, "example.babylon"), JSON.stringify(SceneSerializer.Serialize(scene)), "utf8");
		scene.dispose();
		engine.dispose();

		const report = await runHeadlessTesting(project, { modes: ["edit"], categories: ["smoke"], report: "reports/tests.xml", format: "junit" });
		expect(report).toMatchObject({ target: "headless", status: "passed", summary: { total: 1, passed: 1 } });
		expect(await readFile(join(project, "reports", "tests.xml"), "utf8")).toContain('tests="1"');
	});

	test("rejects scene and report traversal outside the project", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-testing-cli-safe-"));
		directories.push(project);
		await mkdir(join(project, "public", "scene"), { recursive: true });
		await expect(runHeadlessTesting(project, { scene: "../../outside", modes: ["edit"], format: "json" })).rejects.toThrow("inside public/scene");
	});
});

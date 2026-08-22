import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readFile, remove, writeFile, writeJSON } from "fs-extra";
import { realpath, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { listProjectPackages, projectPackageCommand, setProjectDevelopmentPackageTechnicalName } from "../../src/mcp/project/packages";
import { cancelProjectPackageProcess, getActiveProjectPackageProcess, runProjectPackageProcess } from "../../src/mcp/project/package-manager/process";
import { externalEditorCandidatePaths } from "../../src/mcp/project/project";

describe("mcp/project-packages", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "", packageManager: "yarn" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-packages-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		options.editor.state.projectPath = projectConfiguration.path;
		await writeJSON(join(directory, "package.json"), { name: "sample-game", dependencies: { babylonjs: "^9.0.0" }, devDependencies: { typescript: "^5.0.0" } });
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("lists configured direct dependencies without changing the project", async () => {
		await writeFile(join(directory, "yarn.lock"), 'babylonjs@^9.0.0:\n  version "9.9.1"\n');
		expect(await listProjectPackages(scene, {}, options)).toMatchObject({
			packageManager: "yarn",
			name: "sample-game",
			dependencies: { babylonjs: "^9.0.0" },
			devDependencies: { typescript: "^5.0.0" },
			directDependencies: [
				{ name: "babylonjs", specification: "^9.0.0", dependencyType: "dependencies" },
				{ name: "typescript", specification: "^5.0.0", dependencyType: "devDependencies" },
			],
			lockfiles: [expect.objectContaining({ path: "yarn.lock", format: "yarn", authoritative: true, outsideProject: false })],
		});
		expect((await listProjectPackages(scene, {}, options)).fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("atomically edits the complete development technical name under exact manifest leases", async () => {
		const before = await listProjectPackages(scene, {}, options);
		await expect(
			setProjectDevelopmentPackageTechnicalName(
				scene,
				{
					technicalName: "@studio/renamed-game",
					expectedTechnicalName: "sample-game",
					expectedFingerprint: before.fingerprint,
					expectedManifestSha256: before.manifest.sha256,
				},
				options
			)
		).rejects.toThrow(/confirm must be true/);
		const changed = await setProjectDevelopmentPackageTechnicalName(
			scene,
			{
				technicalName: "@studio/renamed-game",
				expectedTechnicalName: "sample-game",
				expectedFingerprint: before.fingerprint,
				expectedManifestSha256: before.manifest.sha256,
				confirm: true,
			},
			options
		);
		expect(changed).toMatchObject({ changed: true, previousTechnicalName: "sample-game", technicalName: "@studio/renamed-game", path: "package.json" });
		expect(changed.manifestSha256).not.toBe(before.manifest.sha256);
		expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toMatchObject({
			name: "@studio/renamed-game",
			dependencies: { babylonjs: "^9.0.0" },
		});
		await expect(
			setProjectDevelopmentPackageTechnicalName(
				scene,
				{
					technicalName: "other-game",
					expectedTechnicalName: "sample-game",
					expectedFingerprint: before.fingerprint,
					expectedManifestSha256: before.manifest.sha256,
					confirm: true,
				},
				options
			)
		).rejects.toThrow(/Package state changed/);
	});

	test("builds shell-free commands for all configured managers", () => {
		expect(projectPackageCommand("yarn", "update", "babylonjs")).toMatchObject({
			command: "yarn",
			args: ["upgrade", "babylonjs", "--non-interactive", "--ignore-scripts", "--no-progress"],
		});
		expect(projectPackageCommand("npm", "update", "babylonjs")).toMatchObject({ command: "npm", args: expect.arrayContaining(["update", "babylonjs", "--ignore-scripts"]) });
		expect(projectPackageCommand("npm", "update", "babylonjs", { version: "9.9.1" })).toMatchObject({
			command: "npm",
			args: expect.arrayContaining(["install", "babylonjs@9.9.1", "--save-exact"]),
		});
		expect(projectPackageCommand("bun", "update", "babylonjs", { version: "latest" })).toMatchObject({
			command: "bun",
			args: ["update", "babylonjs@latest", "--exact", "--ignore-scripts"],
		});
		expect(projectPackageCommand("pnpm", "install", "babylonjs", { version: "9.9.1", dependencyType: "devDependencies" })).toMatchObject({
			command: "pnpm",
			args: ["add", "babylonjs@9.9.1", "--save-dev", "--save-exact", "--reporter=append-only", "--ignore-scripts"],
		});
		expect(() => projectPackageCommand("npm", "install", "babylonjs", { version: "9.9.1;touch" })).toThrow(/exclude whitespace or control characters/);
		expect(() => projectPackageCommand("npm", "install", "-bad")).toThrow(/normal npm package identifier/);
	});

	test("detects an ancestor workspace and reports the authoritative root lockfile", async () => {
		const workspaceRoot = join(directory, "workspace");
		const projectRoot = join(workspaceRoot, "packages", "game");
		await ensureDir(projectRoot);
		await writeJSON(join(workspaceRoot, "package.json"), { private: true, workspaces: ["packages/*"] });
		await writeFile(join(workspaceRoot, "yarn.lock"), 'babylonjs@^9.0.0:\n  version "9.9.1"\n');
		await writeJSON(join(projectRoot, "package.json"), { name: "workspace-game", dependencies: { babylonjs: "^9.0.0" } });
		options.editor.state.projectPath = join(projectRoot, "Game.bjseditor");
		const result = await listProjectPackages(scene, {}, options);
		const realWorkspaceRoot = await realpath(workspaceRoot);
		expect(result.workspace).toEqual({ root: realWorkspaceRoot, relativePath: "packages/game", lockfileMutationRequiresOptIn: true });
		expect(result.lockfiles).toEqual([expect.objectContaining({ path: join(realWorkspaceRoot, "yarn.lock"), authoritative: true, outsideProject: true })]);
	});

	test.skipIf(process.platform === "win32")("rejects a symbolic-link package manifest", async () => {
		await remove(join(directory, "package.json"));
		await writeJSON(join(directory, "manifest-target.json"), { name: "redirected" });
		await symlink(join(directory, "manifest-target.json"), join(directory, "package.json"));
		await expect(listProjectPackages(scene, {}, options)).rejects.toThrow(/regular file.*symbolic link/);
	});

	test("bounds package-process output and reports truncation", async () => {
		const result = await runProjectPackageProcess(
			scene,
			directory,
			{ command: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(30000))'], display: "node bounded-output" },
			{ kind: "test-output", timeoutMs: 5_000, maximumOutputBytes: 16_384 }
		);
		expect(result.status).toBe("succeeded");
		expect(result.outputTruncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16_384);
	});

	test("times out and cancels the single active package process", async () => {
		const timedOut = await runProjectPackageProcess(
			scene,
			directory,
			{ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], display: "node timeout" },
			{ kind: "test-timeout", timeoutMs: 1_000, maximumOutputBytes: 16_384 }
		);
		expect(timedOut.status).toBe("timed-out");

		const running = runProjectPackageProcess(
			scene,
			directory,
			{ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], display: "node cancel" },
			{ kind: "test-cancel", timeoutMs: 10_000, maximumOutputBytes: 16_384 }
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const active = getActiveProjectPackageProcess(scene);
		expect(active).toMatchObject({ kind: "test-cancel" });
		expect(await cancelProjectPackageProcess(scene, { operationId: active.id })).toMatchObject({ canceled: true, operationId: active.id });
		expect((await running).status).toBe("canceled");
	});

	test("provides safe absolute graphical-editor candidates for each supported platform", () => {
		expect(externalEditorCandidatePaths("darwin")).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Visual Studio Code", command: expect.stringContaining("Visual Studio Code.app") })])
		);
		expect(externalEditorCandidatePaths("win32")).toEqual(expect.arrayContaining([expect.objectContaining({ command: expect.stringContaining("code.cmd") })]));
		expect(externalEditorCandidatePaths("linux")).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/usr/bin/code" })]));
	});
});

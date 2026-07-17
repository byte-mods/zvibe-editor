import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mkdtemp, remove, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { listProjectPackages, projectPackageCommand } from "../../src/mcp/project/packages";
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
		expect(await listProjectPackages(scene, {}, options)).toMatchObject({
			packageManager: "yarn",
			name: "sample-game",
			dependencies: { babylonjs: "^9.0.0" },
			devDependencies: { typescript: "^5.0.0" },
		});
	});

	test("selects safe package-manager update commands without executing them", () => {
		expect(projectPackageCommand("yarn", "update", "babylonjs")).toBe("yarn upgrade babylonjs");
		expect(projectPackageCommand("npm", "update", "babylonjs")).toBe("npm update babylonjs");
		expect(projectPackageCommand("npm", "update", "babylonjs", "9.9.1")).toBe("npm install babylonjs@9.9.1");
		expect(projectPackageCommand("bun", "update", "babylonjs", "latest")).toBe("bun update babylonjs@latest");
	});

	test("provides safe absolute graphical-editor candidates for each supported platform", () => {
		expect(externalEditorCandidatePaths("darwin")).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Visual Studio Code", command: expect.stringContaining("Visual Studio Code.app") })])
		);
		expect(externalEditorCandidatePaths("win32")).toEqual(expect.arrayContaining([expect.objectContaining({ command: expect.stringContaining("code.cmd") })]));
		expect(externalEditorCandidatePaths("linux")).toEqual(expect.arrayContaining([expect.objectContaining({ command: "/usr/bin/code" })]));
	});
});

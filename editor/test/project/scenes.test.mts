import { mkdtemp, mkdir, readJSON, remove, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { afterEach, describe, expect, test } from "vitest";

import { createSceneTemplate, discoverProjectScenes, instantiateSceneTemplate, normalizeSceneBuildSettings, renameSceneInBuildSettings } from "../../src/project/scenes";

describe("project/scenes", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((path) => remove(path)));
	});

	async function createProjectDirectory(): Promise<string> {
		const path = await mkdtemp(join(tmpdir(), "zvibe-scenes-"));
		temporaryDirectories.push(path);
		return path;
	}

	async function createScene(projectDirectory: string, path: string): Promise<void> {
		await mkdir(join(projectDirectory, path, "meshes"), { recursive: true });
		await writeJSON(join(projectDirectory, path, "config.json"), { source: path });
		await writeJSON(join(projectDirectory, path, "meshes", "mesh.json"), { meshes: [{ delayLoadingFile: `${path}/geometries/mesh.bin` }] });
	}

	test("migrates legacy projects deterministically and keeps the active scene first", () => {
		expect(normalizeSceneBuildSettings(undefined, "/assets/LevelB.scene", ["assets/LevelA.scene", "assets/LevelB.scene"])).toEqual({
			version: 1,
			scenes: [
				{ path: "assets/LevelB.scene", enabled: true },
				{ path: "assets/LevelA.scene", enabled: true },
			],
		});
	});

	test("preserves authored order and disabled state while pruning stale and appending new scenes", () => {
		const settings = normalizeSceneBuildSettings(
			{
				version: 1,
				scenes: [
					{ path: "assets/B.scene", enabled: false },
					{ path: "assets/Missing.scene", enabled: true },
					{ path: "assets/A.scene", enabled: true },
				],
			},
			null,
			["assets/A.scene", "assets/B.scene", "assets/C.scene"]
		);

		expect(settings.scenes).toEqual([
			{ path: "assets/B.scene", enabled: false },
			{ path: "assets/A.scene", enabled: true },
			{ path: "assets/C.scene", enabled: true },
		]);
		expect(renameSceneInBuildSettings(settings, "assets/B.scene", "assets/Renamed.scene").scenes[0]).toEqual({ path: "assets/Renamed.scene", enabled: false });
	});

	test("creates and instantiates a self-contained scene template with rewritten scene-local paths", async () => {
		const projectDirectory = await createProjectDirectory();
		await createScene(projectDirectory, "assets/Source.scene");

		const template = await createSceneTemplate(projectDirectory, {
			sourcePath: "assets/Source.scene",
			templatePath: "assets/templates/Gameplay.scenetemplate",
			name: "Gameplay",
		});
		expect(template).toMatchObject({ version: 1, name: "Gameplay", sourceScenePath: "assets/Source.scene" });

		await instantiateSceneTemplate(projectDirectory, {
			templatePath: template.path,
			destinationPath: "assets/Generated.scene",
		});
		const mesh = await readJSON(join(projectDirectory, "assets/Generated.scene/meshes/mesh.json"));
		expect(mesh.meshes[0].delayLoadingFile).toBe("assets/Generated.scene/geometries/mesh.bin");

		expect(await discoverProjectScenes(projectDirectory)).toEqual(["assets/Generated.scene", "assets/Source.scene"]);
	});

	test("rejects paths that escape the project", async () => {
		const projectDirectory = await createProjectDirectory();
		await createScene(projectDirectory, "assets/Source.scene");

		await expect(
			createSceneTemplate(projectDirectory, {
				sourcePath: "assets/Source.scene",
				templatePath: "../Escaped.scenetemplate",
			})
		).rejects.toThrow("project-relative");
	});
});

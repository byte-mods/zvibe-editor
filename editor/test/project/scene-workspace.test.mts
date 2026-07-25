import { tmpdir } from "os";
import { join } from "path/posix";

import { mkdir, mkdtemp, readJSON, remove, writeJSON } from "fs-extra";
import { describe, expect, test } from "vitest";

import { activateSceneInWorkspaceSettings, maximumLoadedAuthoringScenes, normalizeSceneWorkspaceSettings, readSceneWorkspaceSettings } from "../../src/project/scene-workspace";

describe("project/scene-workspace", () => {
	test("migrates a legacy project to one active lighting scene", () => {
		expect(normalizeSceneWorkspaceSettings(undefined, "/assets/Main.scene", ["assets/Menu.scene", "assets/Main.scene"])).toEqual({
			version: 1,
			loadedScenes: ["assets/Main.scene"],
			activeScene: "assets/Main.scene",
			lightingScene: "assets/Main.scene",
		});
	});

	test("prunes stale and duplicate paths while preserving loaded order", () => {
		const settings = normalizeSceneWorkspaceSettings(
			{
				version: 1,
				loadedScenes: ["assets/B.scene", "assets/A.scene", "assets/B.scene", "assets/Missing.scene"],
				activeScene: "assets/A.scene",
				lightingScene: "assets/B.scene",
			},
			null,
			["assets/A.scene", "assets/B.scene"]
		);

		expect(settings).toEqual({
			version: 1,
			loadedScenes: ["assets/B.scene", "assets/A.scene"],
			activeScene: "assets/A.scene",
			lightingScene: "assets/B.scene",
		});
	});

	test("keeps active and lighting scenes loaded under the workspace bound", () => {
		const discovered = Array.from({ length: maximumLoadedAuthoringScenes + 2 }, (_, index) => `assets/${index}.scene`);
		const settings = normalizeSceneWorkspaceSettings(
			{
				version: 1,
				loadedScenes: discovered,
				activeScene: discovered.at(-1)!,
				lightingScene: discovered.at(-2)!,
			},
			null,
			discovered
		);

		expect(settings.loadedScenes).toHaveLength(maximumLoadedAuthoringScenes);
		expect(settings.loadedScenes.slice(-2)).toEqual([discovered.at(-2), discovered.at(-1)]);
		expect(settings.loadedScenes).toContain(settings.activeScene);
		expect(settings.loadedScenes).toContain(settings.lightingScene);
	});

	test("bounds malformed persisted arrays before normalization", () => {
		const settings = normalizeSceneWorkspaceSettings(
			{
				version: 1,
				loadedScenes: Array.from({ length: 10_000 }, () => "assets/Main.scene"),
				activeScene: "assets/Main.scene",
				lightingScene: "assets/Main.scene",
			},
			null,
			["assets/Main.scene"]
		);

		expect(settings.loadedScenes).toEqual(["assets/Main.scene"]);
	});

	test("reads and migrates the workspace from a legacy project file", async () => {
		const projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-workspace-"));
		try {
			await mkdir(join(projectDirectory, "assets/Main.scene"), { recursive: true });
			const projectPath = join(projectDirectory, "project.bjseditor");
			await writeJSON(projectPath, { lastOpenedScene: "/assets/Main.scene" });

			await expect(readSceneWorkspaceSettings(projectPath)).resolves.toEqual({
				version: 1,
				loadedScenes: ["assets/Main.scene"],
				activeScene: "assets/Main.scene",
				lightingScene: "assets/Main.scene",
			});
		} finally {
			await remove(projectDirectory);
		}
	});

	test("preserves additive scenes for loaded activation and resets legacy open to one scene", () => {
		const workspace = {
			version: 1 as const,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/A.scene",
			lightingScene: "assets/A.scene",
		};
		const discovered = ["assets/A.scene", "assets/B.scene", "assets/C.scene"];

		expect(activateSceneInWorkspaceSettings(workspace, "assets/B.scene", discovered)).toMatchObject({
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/B.scene",
			lightingScene: "assets/A.scene",
		});
		expect(activateSceneInWorkspaceSettings(workspace, "assets/C.scene", discovered)).toEqual({
			version: 1,
			loadedScenes: ["assets/C.scene"],
			activeScene: "assets/C.scene",
			lightingScene: "assets/C.scene",
		});
	});

	test("ships every starter project with an explicit single-scene workspace", async () => {
		for (const template of ["electron", "nextjs", "nuxtjs", "solidjs", "vanillajs"]) {
			const project = await readJSON(join(process.cwd(), "..", "templates", template, "project.bjseditor"));
			expect(project.sceneWorkspace).toEqual({
				version: 1,
				loadedScenes: ["assets/example.scene"],
				activeScene: "assets/example.scene",
				lightingScene: "assets/example.scene",
			});
		}
	});
});

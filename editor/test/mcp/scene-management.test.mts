import { mkdtemp, mkdir, remove, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { NullEngine, Scene } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/project/save/save", () => ({
	saveProject: vi.fn(async () => undefined),
	saveProjectForRestart: vi.fn(async () => undefined),
	saveProjectConfiguration: vi.fn(async () => ({})),
}));

import { projectConfiguration } from "../../src/project/configuration";
import { EditorSceneManager } from "../../src/editor/dialogs/scene-manager/scene-manager";
import {
	createProjectSceneTemplate,
	createScene as createManagedScene,
	deleteProjectSceneTemplate,
	getSceneBuildSettings,
	instantiateProjectSceneTemplate,
	listProjectSceneTemplates,
	listScenes,
	setSceneBuildSettings,
} from "../../src/mcp/scene/scene";

describe("mcp/scene-management", () => {
	let projectDirectory: string;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(async () => {
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-mcp-scenes-"));
		await Promise.all([createScene("assets/A.scene"), createScene("assets/B.scene")]);
		projectConfiguration.path = join(projectDirectory, "project.bjseditor");

		engine = new NullEngine();
		scene = new Scene(engine);
		editor = {
			state: {
				projectPath: projectConfiguration.path,
				lastOpenedScenePath: join(projectDirectory, "assets/A.scene"),
				sceneBuildSettings: {
					version: 1,
					scenes: [
						{ path: "assets/A.scene", enabled: true },
						{ path: "assets/B.scene", enabled: false },
					],
				},
			},
			setState(update: any, callback?: () => void): void {
				Object.assign(this.state, typeof update === "function" ? update(this.state) : update);
				callback?.();
			},
			layout: { assets: { refresh: vi.fn() } },
		};
	});

	afterEach(async () => {
		projectConfiguration.path = null;
		scene.dispose();
		engine.dispose();
		await remove(projectDirectory);
	});

	async function createScene(path: string): Promise<void> {
		await mkdir(join(projectDirectory, path, "meshes"), { recursive: true });
		await writeJSON(join(projectDirectory, path, "config.json"), {});
		await writeJSON(join(projectDirectory, path, "meshes/mesh.json"), { path: `${path}/geometries/mesh.bin` });
	}

	test("lists bounded build metadata and replaces order under an exact fingerprint lease", async () => {
		const page = await listScenes(scene, { offset: 1, limit: 1 }, { editor });
		expect(page).toMatchObject({ total: 2, offset: 1, limit: 1, hasMore: false, scenes: [{ path: "assets/B.scene", enabled: false, buildIndex: 1 }] });

		const current = await getSceneBuildSettings(scene, {}, { editor });
		expect(current.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		await expect(setSceneBuildSettings(scene, { expectedFingerprint: "0".repeat(64), scenes: current.scenes }, { editor })).rejects.toThrow("changed after inspection");

		const updated = await setSceneBuildSettings(
			scene,
			{
				expectedFingerprint: current.fingerprint,
				scenes: [
					{ path: "assets/B.scene", enabled: true },
					{ path: "assets/A.scene", enabled: false },
				],
			},
			{ editor }
		);
		expect(updated.scenes).toEqual([
			{ path: "assets/B.scene", enabled: true },
			{ path: "assets/A.scene", enabled: false },
		]);
		expect(editor.state.sceneBuildSettings).toEqual({ version: 1, scenes: updated.scenes });
	});

	test("rejects hidden scene paths that project discovery cannot retain", async () => {
		await expect(createManagedScene(scene, { path: "scenes/.hidden.scene" }, { editor })).rejects.toThrow("hidden path segments");
	});

	test("exposes template creation, bounded listing, instantiation, and guarded deletion", async () => {
		const created = await createProjectSceneTemplate(scene, { sourcePath: "assets/A.scene", templatePath: "assets/templates/A.scenetemplate", name: "A Template" }, { editor });
		expect(created).toMatchObject({ created: true, template: { name: "A Template", path: "assets/templates/A.scenetemplate" } });

		expect(await listProjectSceneTemplates(scene, { limit: 1 }, { editor })).toMatchObject({ total: 1, templates: [{ name: "A Template" }] });
		const instantiated = await instantiateProjectSceneTemplate(
			scene,
			{ templatePath: "assets/templates/A.scenetemplate", destinationPath: "assets/Generated.scene" },
			{ editor }
		);
		expect(instantiated).toMatchObject({ created: true, path: "assets/Generated.scene" });
		expect(editor.state.sceneBuildSettings.scenes.at(-1)).toEqual({ path: "assets/Generated.scene", enabled: true });

		await expect(deleteProjectSceneTemplate(scene, { path: "assets/templates/A.scenetemplate" }, { editor })).rejects.toThrow("confirm");
		expect(await deleteProjectSceneTemplate(scene, { path: "assets/templates/A.scenetemplate", confirm: true }, { editor })).toEqual({
			deleted: true,
			path: "assets/templates/A.scenetemplate",
		});
	});

	test("restores the opening build settings when the Scene Manager is cancelled", () => {
		const onClose = vi.fn();
		const manager = new EditorSceneManager({ editor, open: true, onClose });
		(manager as any).state.originalSceneBuildSettings = structuredClone(editor.state.sceneBuildSettings);
		editor.state.sceneBuildSettings = { version: 1, scenes: [{ path: "assets/B.scene", enabled: true }] };

		(manager as any)._cancel();

		expect(editor.state.sceneBuildSettings.scenes).toEqual([
			{ path: "assets/A.scene", enabled: true },
			{ path: "assets/B.scene", enabled: false },
		]);
		expect(onClose).toHaveBeenCalledOnce();
	});
});

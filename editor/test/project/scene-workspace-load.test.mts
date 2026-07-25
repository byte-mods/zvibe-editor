import { NullEngine, Scene, TransformNode } from "babylonjs";
import { afterEach, describe, expect, test, vi } from "vitest";

import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";
import { createSceneLoadResult } from "../../src/project/load/result";
import {
	loadAuthoringSceneAdditive,
	loadSceneWorkspace,
	reloadAuthoringScene,
	replaceWithSingleSceneWorkspace,
	setLightingAuthoringScene,
	unloadAuthoringScene,
} from "../../src/project/load/workspace";

const scenes: Scene[] = [];

afterEach(() => scenes.splice(0).forEach((scene) => scene.dispose()));

function createEditor() {
	const scene = new Scene(new NullEngine());
	scenes.push(scene);
	const sceneWorkspace = new EditorSceneWorkspace();
	const settings = {
		version: 1 as const,
		loadedScenes: ["assets/A.scene", "assets/B.scene"],
		activeScene: "assets/B.scene",
		lightingScene: "assets/A.scene",
	};
	sceneWorkspace.configure(settings);
	const setRenderScene = vi.fn();
	const reset = vi.fn(async () => undefined);
	return { editor: { layout: { preview: { scene, setRenderScene, reset } }, sceneWorkspace } as any, scene, sceneWorkspace, settings, setRenderScene, reset };
}

describe("project/load additive workspace", () => {
	test("loads in authored order, applies only lighting configuration, and claims exact results", async () => {
		const { editor, scene, sceneWorkspace, settings } = createEditor();
		const calls: { path: string; applySceneConfiguration: boolean; deferReady: boolean }[] = [];
		const nodes: TransformNode[] = [];
		const loader = vi.fn(async (_editor, _projectDirectory, scenePath, options) => {
			calls.push({ path: scenePath, applySceneConfiguration: !!options?.applySceneConfiguration, deferReady: !!options?.deferReady });
			const result = createSceneLoadResult();
			const node = new TransformNode(scenePath, scene);
			nodes.push(node);
			result.transformNodes.push(node);
			result.configuration = { path: scenePath };
			return result;
		});

		await loadSceneWorkspace(editor, "/project", settings, loader);

		expect(calls).toEqual([
			{ path: "/project/assets/A.scene", applySceneConfiguration: true, deferReady: true },
			{ path: "/project/assets/B.scene", applySceneConfiguration: false, deferReady: false },
		]);
		expect(sceneWorkspace.getOwner(nodes[0])).toBe("assets/A.scene");
		expect(sceneWorkspace.getOwner(nodes[1])).toBe("assets/B.scene");
		expect(sceneWorkspace.getLoadedSceneConfiguration("assets/B.scene")).toEqual({ path: "/project/assets/B.scene" });
	});

	test("rolls back completed handles and claims when a later load fails", async () => {
		const { editor, scene, sceneWorkspace, settings, setRenderScene } = createEditor();
		const loadedNode = new TransformNode("Loaded", scene);
		let calls = 0;
		const loader = vi.fn(async () => {
			if (calls++) throw new Error("broken scene");
			const result = createSceneLoadResult();
			result.transformNodes.push(loadedNode);
			return result;
		});

		await expect(loadSceneWorkspace(editor, "/project", settings, loader)).rejects.toThrow("broken scene");

		expect(scene.transformNodes).not.toContain(loadedNode);
		expect(sceneWorkspace.getOwner(loadedNode)).toBeNull();
		expect(sceneWorkspace.getLoadedSceneStates().every((state) => state.ownedObjectCount === 0)).toBe(true);
		expect(setRenderScene).toHaveBeenCalledWith(true);
	});

	test("routes legacy reset-and-open through a one-scene owned workspace", async () => {
		const { editor, sceneWorkspace, reset } = createEditor();
		const result = createSceneLoadResult();
		const loadedNode = new TransformNode("Only", editor.layout.preview.scene);
		result.transformNodes.push(loadedNode);
		const loader = vi.fn(async () => result);

		await replaceWithSingleSceneWorkspace(editor, "/project", "/project/assets/Only.scene", loader);

		expect(reset).toHaveBeenCalledOnce();
		expect(sceneWorkspace.getSettings()).toEqual({
			version: 1,
			loadedScenes: ["assets/Only.scene"],
			activeScene: "assets/Only.scene",
			lightingScene: "assets/Only.scene",
		});
		expect(sceneWorkspace.getOwner(loadedNode)).toBe("assets/Only.scene");
	});

	test("loads one additional scene without replacing existing ownership", async () => {
		const { editor, scene, sceneWorkspace } = createEditor();
		const existing = new TransformNode("Existing", scene);
		sceneWorkspace.claimObjects("assets/A.scene", [existing]);
		const added = new TransformNode("Added", scene);
		let loadedResult = createSceneLoadResult();
		const loader = vi.fn(async (_editor, _projectDirectory, _scenePath, options) => {
			loadedResult = createSceneLoadResult();
			loadedResult.transformNodes.push(added);
			loadedResult.configuration = { name: "C" };
			expect(options).toMatchObject({ applySceneConfiguration: false, deferReady: false });
			return loadedResult;
		});

		expect(await loadAuthoringSceneAdditive(editor, "/project", "assets/C.scene", { makeActive: true }, loader)).toBe(true);
		expect(sceneWorkspace.getOwner(existing)).toBe("assets/A.scene");
		expect(sceneWorkspace.getOwner(added)).toBe("assets/C.scene");
		expect(sceneWorkspace.getSettings()).toMatchObject({
			loadedScenes: ["assets/A.scene", "assets/B.scene", "assets/C.scene"],
			activeScene: "assets/C.scene",
			lightingScene: "assets/A.scene",
		});
		expect(await loadAuthoringSceneAdditive(editor, "/project", "assets/C.scene", undefined, loader)).toBe(false);
		expect(loader).toHaveBeenCalledOnce();
		sceneWorkspace.setLoadedSceneConfiguration("assets/C.scene", { name: "C2" });
		expect(loadedResult.configuration).toEqual({ name: "C2" });
	});

	test("rolls additive settings back when loading fails and rejects escaping paths", async () => {
		const { editor, sceneWorkspace, settings, setRenderScene } = createEditor();
		const loader = vi.fn(async () => {
			throw new Error("broken additive scene");
		});

		await expect(loadAuthoringSceneAdditive(editor, "/project", "assets/C.scene", undefined, loader)).rejects.toThrow("broken additive scene");
		expect(sceneWorkspace.getSettings()).toEqual(settings);
		expect(setRenderScene).toHaveBeenCalledWith(true);
		await expect(loadAuthoringSceneAdditive(editor, "/project", "../outside.scene", undefined, loader)).rejects.toThrow("contained by the project");
	});

	test("switches lighting through the retained handle and reapplies fallback on unload", async () => {
		const { editor, sceneWorkspace } = createEditor();
		const disposeA = vi.fn();
		const applyA = vi.fn();
		const applyB = vi.fn();
		sceneWorkspace.setLoadedSceneHandle("assets/A.scene", { configuration: {}, applyLighting: applyA, dispose: disposeA });
		sceneWorkspace.setLoadedSceneHandle("assets/B.scene", { configuration: {}, applyLighting: applyB, dispose: vi.fn() });

		await setLightingAuthoringScene(editor, "assets/B.scene");
		expect(applyB).toHaveBeenCalledOnce();
		expect(sceneWorkspace.getSettings().lightingScene).toBe("assets/B.scene");

		await unloadAuthoringScene(editor, "assets/B.scene");
		expect(applyA).toHaveBeenCalledOnce();
		expect(sceneWorkspace.getSettings()).toMatchObject({ loadedScenes: ["assets/A.scene"], activeScene: "assets/A.scene", lightingScene: "assets/A.scene" });
		await expect(unloadAuthoringScene(editor, "assets/A.scene")).rejects.toThrow("last authored scene");
		expect(disposeA).not.toHaveBeenCalled();
	});

	test("reverts one scene in place while preserving workspace order and flags", async () => {
		const { editor, scene, sceneWorkspace, settings } = createEditor();
		const oldNode = new TransformNode("Old B", scene);
		const oldDispose = vi.fn(() => oldNode.dispose());
		sceneWorkspace.claimObjects("assets/B.scene", [oldNode]);
		sceneWorkspace.setLoadedSceneHandle("assets/B.scene", { configuration: { version: "old" }, dispose: oldDispose });
		sceneWorkspace.setDirty("assets/B.scene");
		const newNode = new TransformNode("New B", scene);
		const loader = vi.fn(async (_editor, _projectDirectory, scenePath, options) => {
			expect(scenePath).toBe("/project/assets/B.scene");
			expect(options).toMatchObject({ applySceneConfiguration: false, deferReady: false });
			const result = createSceneLoadResult();
			result.transformNodes.push(newNode);
			result.configuration = { version: "disk" };
			return result;
		});

		await reloadAuthoringScene(editor, "/project", "assets/B.scene", loader);

		expect(oldDispose).toHaveBeenCalledOnce();
		expect(sceneWorkspace.getSettings()).toEqual(settings);
		expect(sceneWorkspace.getOwner(oldNode)).toBeNull();
		expect(sceneWorkspace.getOwner(newNode)).toBe("assets/B.scene");
		expect(sceneWorkspace.getLoadedSceneConfiguration("assets/B.scene")).toEqual({ version: "disk" });
		expect(sceneWorkspace.getLoadedSceneStates()[1].isDirty).toBe(false);
	});
});

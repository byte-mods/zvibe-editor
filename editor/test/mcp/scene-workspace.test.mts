import { mkdtemp, mkdir, remove } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { Mesh, NullEngine, Scene } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const actionMocks = vi.hoisted(() => ({
	load: vi.fn(),
	revert: vi.fn(),
	save: vi.fn(),
	setActive: vi.fn(),
	setLighting: vi.fn(),
	unload: vi.fn(),
	move: vi.fn(),
}));

vi.mock("../../src/project/scene-workspace-actions", () => ({
	loadSceneIntoWorkspace: actionMocks.load,
	revertWorkspaceScene: actionMocks.revert,
	saveWorkspaceScene: actionMocks.save,
	setActiveWorkspaceScene: actionMocks.setActive,
	setLightingWorkspaceScene: actionMocks.setLighting,
	unloadWorkspaceScene: actionMocks.unload,
}));

vi.mock("../../src/editor/layout/graph/move", () => ({
	moveSceneObjectsToScene: actionMocks.move,
}));

import { projectConfiguration } from "../../src/project/configuration";
import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";
import { planSceneObjectMove } from "../../src/project/scene-workspace-move";
import {
	getSceneWorkspace,
	inspectSceneObjectMove,
	loadSceneAdditive,
	moveSceneObjects,
	revertLoadedWorkspaceScene,
	saveLoadedWorkspaceScene,
	setActiveSceneWorkspace,
	setLightingSceneWorkspace,
	unloadSceneAdditive,
} from "../../src/mcp/scene/workspace";

describe("mcp/additive-scene-workspace", () => {
	let projectDirectory: string;
	let engine: NullEngine;
	let scene: Scene;
	let workspace: EditorSceneWorkspace;
	let editor: any;
	let aRoot: Mesh;
	let aChild: Mesh;
	let bRoot: Mesh;

	beforeEach(async () => {
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-mcp-workspace-"));
		await Promise.all(["assets/A.scene", "assets/B.scene", "assets/C.scene"].map((path) => mkdir(join(projectDirectory, path), { recursive: true })));
		projectConfiguration.path = join(projectDirectory, "project.bjseditor");

		engine = new NullEngine();
		scene = new Scene(engine);
		workspace = new EditorSceneWorkspace();
		workspace.configure({
			version: 1,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/A.scene",
			lightingScene: "assets/A.scene",
		});
		aRoot = new Mesh("A Root", scene);
		aRoot.id = "a-root";
		aChild = new Mesh("A Child", scene);
		aChild.id = "a-child";
		aChild.parent = aRoot;
		bRoot = new Mesh("B Root", scene);
		bRoot.id = "b-root";
		workspace.claimObjects("assets/A.scene", [aRoot, aChild]);
		workspace.claimObjects("assets/B.scene", [bRoot]);

		editor = {
			sceneWorkspace: workspace,
			layout: {
				preview: { scene, clusteredLightContainer: { lights: [] } },
				graph: { refresh: vi.fn(async () => undefined) },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		};

		actionMocks.load.mockImplementation(async (targetEditor: any, path: string, makeActive: boolean) => {
			const loaded = !targetEditor.sceneWorkspace.getSettings().loadedScenes.includes(path);
			if (loaded) targetEditor.sceneWorkspace.addLoadedScene(path);
			if (makeActive) targetEditor.sceneWorkspace.setActiveScene(path);
			return loaded;
		});
		actionMocks.setActive.mockImplementation(async (targetEditor: any, path: string) => targetEditor.sceneWorkspace.setActiveScene(path));
		actionMocks.setLighting.mockImplementation(async (targetEditor: any, path: string) => targetEditor.sceneWorkspace.setLightingScene(path));
		actionMocks.save.mockImplementation(async (targetEditor: any, path: string) => targetEditor.sceneWorkspace.setDirty(path, false));
		actionMocks.revert.mockImplementation(async (targetEditor: any, path: string) => targetEditor.sceneWorkspace.setDirty(path, false));
		actionMocks.unload.mockImplementation(async (targetEditor: any, path: string) => targetEditor.sceneWorkspace.removeLoadedScene(path));
		actionMocks.move.mockImplementation((targetEditor: any, objects: object[], target: string) => {
			const plan = planSceneObjectMove(scene, targetEditor.sceneWorkspace, objects, target);
			targetEditor.sceneWorkspace.claimObjects(target, plan.objects, true);
			return plan;
		});
	});

	afterEach(async () => {
		vi.clearAllMocks();
		projectConfiguration.path = null;
		scene.dispose();
		engine.dispose();
		await remove(projectDirectory);
	});

	test("returns independent roots and enforces exact lifecycle leases", async () => {
		const initial = getSceneWorkspace(scene, {}, { editor });
		expect(initial).toMatchObject({
			activeScene: "assets/A.scene",
			lightingScene: "assets/A.scene",
			scenes: [
				{ path: "assets/A.scene", rootNodes: [{ id: "a-root", name: "A Root" }] },
				{ path: "assets/B.scene", rootNodes: [{ id: "b-root", name: "B Root" }] },
			],
		});
		expect(initial.fingerprint).toMatch(/^[a-f0-9]{64}$/);

		await expect(setActiveSceneWorkspace(scene, { path: "assets/B.scene", expectedFingerprint: "0".repeat(64) }, { editor })).rejects.toThrow("changed after inspection");
		const active = await setActiveSceneWorkspace(scene, { path: "assets/B.scene", expectedFingerprint: initial.fingerprint }, { editor });
		expect(active.activeScene).toBe("assets/B.scene");

		const lighting = await setLightingSceneWorkspace(scene, { path: "assets/B.scene", expectedFingerprint: active.workspace.fingerprint }, { editor });
		expect(lighting.lightingScene).toBe("assets/B.scene");
		workspace.setDirty("assets/B.scene");
		const dirty = getSceneWorkspace(scene, {}, { editor });
		const saved = await saveLoadedWorkspaceScene(scene, { path: "assets/B.scene", expectedFingerprint: dirty.fingerprint }, { editor });
		expect(saved.workspace.scenes.find((value: any) => value.path === "assets/B.scene").isDirty).toBe(false);
	});

	test("loads, confirmation-reverts, and confirmation-unloads one scene without resetting the others", async () => {
		const initial = getSceneWorkspace(scene, {}, { editor });
		const loaded = await loadSceneAdditive(scene, { path: "assets/C.scene", expectedFingerprint: initial.fingerprint, makeActive: true }, { editor });
		expect(loaded).toMatchObject({ loaded: true, path: "assets/C.scene", workspace: { activeScene: "assets/C.scene" } });

		workspace.setDirty("assets/B.scene");
		const dirty = getSceneWorkspace(scene, {}, { editor });
		await expect(revertLoadedWorkspaceScene(scene, { path: "assets/B.scene", expectedFingerprint: dirty.fingerprint }, { editor })).rejects.toThrow("confirm");
		const reverted = await revertLoadedWorkspaceScene(scene, { path: "assets/B.scene", expectedFingerprint: dirty.fingerprint, confirm: true }, { editor });
		expect(reverted.workspace.scenes.find((value: any) => value.path === "assets/B.scene").isDirty).toBe(false);

		workspace.setDirty("assets/C.scene");
		const beforeUnload = getSceneWorkspace(scene, {}, { editor });
		await expect(unloadSceneAdditive(scene, { path: "assets/C.scene", expectedFingerprint: beforeUnload.fingerprint }, { editor })).rejects.toThrow("unsaved edits");
		const unloaded = await unloadSceneAdditive(scene, { path: "assets/C.scene", expectedFingerprint: beforeUnload.fingerprint, confirm: true }, { editor });
		expect(unloaded.workspace.scenes.map((value: any) => value.path)).toEqual(["assets/A.scene", "assets/B.scene"]);
	});

	test("leases and applies complete cross-scene root/dependency moves", async () => {
		const inspected = inspectSceneObjectMove(scene, { nodeIds: [aRoot.id], targetScene: "assets/B.scene" }, { editor });
		expect(inspected).toMatchObject({
			targetScene: "assets/B.scene",
			sourceScenes: ["assets/A.scene"],
			rootNodes: [{ id: "a-root", name: "A Root" }],
			resourceCount: 2,
		});
		expect(inspected.planFingerprint).toMatch(/^[a-f0-9]{64}$/);

		await expect(moveSceneObjects(scene, { nodeIds: [aRoot.id], targetScene: "assets/B.scene", expectedPlanFingerprint: "0".repeat(64) }, { editor })).rejects.toThrow(
			"plan changed"
		);
		const moved = await moveSceneObjects(scene, { nodeIds: [aRoot.id], targetScene: "assets/B.scene", expectedPlanFingerprint: inspected.planFingerprint }, { editor });
		expect(moved.moved).toBe(true);
		expect(workspace.getOwner(aRoot)).toBe("assets/B.scene");
		expect(workspace.getOwner(aChild)).toBe("assets/B.scene");
	});
});

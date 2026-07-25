import { createHash } from "crypto";
import { dirname, join, normalize, relative } from "path/posix";

import { pathExists } from "fs-extra";

import { Node, Scene } from "babylonjs";

import { moveSceneObjectsToScene } from "../../editor/layout/graph/move";
import { projectConfiguration } from "../../project/configuration";
import { getAuthoringSceneRootNodes } from "../../project/scene-hierarchy";
import { ISceneObjectMovePlan, planSceneObjectMove } from "../../project/scene-workspace-move";
import {
	loadSceneIntoWorkspace,
	revertWorkspaceScene,
	saveWorkspaceScene,
	setActiveWorkspaceScene,
	setLightingWorkspaceScene,
	unloadWorkspaceScene,
} from "../../project/scene-workspace-actions";

import { IMCPActionOptions } from "../action";

interface IWorkspaceScenePath {
	absolutePath: string;
	relativePath: string;
}

function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveWorkspaceScenePath(path: string): IWorkspaceScenePath {
	const projectDirectory = getProjectDirectory();
	const absolutePath = normalize(path.startsWith("/") ? path : join(projectDirectory, path));
	if (!absolutePath.startsWith(`${projectDirectory}/`) || !absolutePath.endsWith(".scene")) {
		throw new Error("Scene paths must be project-relative paths ending in .scene.");
	}
	return { absolutePath, relativePath: relative(projectDirectory, absolutePath) };
}

function nodeSummary(node: Node): { id: string; name: string; type: string } {
	return { id: node.id, name: node.name, type: node.getClassName() };
}

function workspaceSnapshot(scene: Scene, options: IMCPActionOptions): any {
	const editor = options.editor;
	const clusteredLights = editor.layout.preview.clusteredLightContainer?.lights ?? [];
	const settings = editor.sceneWorkspace.getSettings();
	const scenes = editor.sceneWorkspace.getLoadedSceneStates().map((state) => ({
		...state,
		rootNodes: getAuthoringSceneRootNodes(scene, editor.sceneWorkspace, state.path, [...clusteredLights]).map(nodeSummary),
	}));
	const value = { version: 1, activeScene: settings.activeScene, lightingScene: settings.lightingScene, scenes };
	return { ...value, fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

function assertWorkspaceFingerprint(scene: Scene, data: any, options: IMCPActionOptions): void {
	if (data.expectedFingerprint !== workspaceSnapshot(scene, options).fingerprint) {
		throw new Error("The additive scene workspace changed after inspection. Call get_scene_workspace again and retry with its fingerprint.");
	}
}

function assertLoadedScene(options: IMCPActionOptions, path: string): void {
	if (!options.editor.sceneWorkspace.getSettings().loadedScenes.includes(path)) {
		throw new Error(`Scene is not loaded for authoring: ${path}`);
	}
}

async function refreshWorkspace(options: IMCPActionOptions): Promise<void> {
	await options.editor.layout.graph.refresh();
	options.editor.layout.inspector.setEditedObject(options.editor.layout.preview.scene);
	options.editor.layout.inspector.forceUpdate();
}

/** Returns the exact loaded-scene workspace, independent roots, flags, counts, and mutation lease. */
export function getSceneWorkspace(scene: Scene, _data: any, options: IMCPActionOptions): any {
	return workspaceSnapshot(scene, options);
}

/** Loads one authored scene without resetting any already loaded scene. */
export async function loadSceneAdditive(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertWorkspaceFingerprint(scene, data, options);
	const path = resolveWorkspaceScenePath(data.path);
	if (!(await pathExists(path.absolutePath))) {
		throw new Error(`Scene not found: ${path.relativePath}`);
	}
	const loaded = await loadSceneIntoWorkspace(options.editor, path.relativePath, data.makeActive === true);
	await refreshWorkspace(options);
	return { loaded, path: path.relativePath, workspace: workspaceSnapshot(scene, options) };
}

/** Selects which loaded scene owns newly authored root content. */
export async function setActiveSceneWorkspace(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertWorkspaceFingerprint(scene, data, options);
	const path = resolveWorkspaceScenePath(data.path).relativePath;
	assertLoadedScene(options, path);
	await setActiveWorkspaceScene(options.editor, path);
	await refreshWorkspace(options);
	return { activeScene: path, workspace: workspaceSnapshot(scene, options) };
}

/** Selects which loaded scene supplies global lighting and render configuration. */
export async function setLightingSceneWorkspace(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertWorkspaceFingerprint(scene, data, options);
	const path = resolveWorkspaceScenePath(data.path).relativePath;
	assertLoadedScene(options, path);
	await setLightingWorkspaceScene(options.editor, path);
	await refreshWorkspace(options);
	return { lightingScene: path, workspace: workspaceSnapshot(scene, options) };
}

/** Saves exactly one loaded authored scene and clears only its dirty flag. */
export async function saveLoadedWorkspaceScene(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertWorkspaceFingerprint(scene, data, options);
	const path = resolveWorkspaceScenePath(data.path).relativePath;
	assertLoadedScene(options, path);
	await saveWorkspaceScene(options.editor, path);
	await refreshWorkspace(options);
	return { saved: true, path, workspace: workspaceSnapshot(scene, options) };
}

/** Discards one loaded scene's in-memory edits and reloads its exact authored resources. */
export async function revertLoadedWorkspaceScene(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Reverting a loaded scene discards its in-memory edits. Retry with confirm: true.");
	}
	assertWorkspaceFingerprint(scene, data, options);
	const path = resolveWorkspaceScenePath(data.path).relativePath;
	assertLoadedScene(options, path);
	await revertWorkspaceScene(options.editor, path);
	await refreshWorkspace(options);
	return { reverted: true, path, workspace: workspaceSnapshot(scene, options) };
}

/** Unloads one authored scene while preserving every other scene and deterministic active/lighting fallbacks. */
export async function unloadSceneAdditive(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertWorkspaceFingerprint(scene, data, options);
	const path = resolveWorkspaceScenePath(data.path).relativePath;
	const state = options.editor.sceneWorkspace.getLoadedSceneStates().find((candidate) => candidate.path === path);
	if (!state) {
		throw new Error(`Scene is not loaded for authoring: ${path}`);
	}
	if (state.isDirty && data.confirm !== true) {
		throw new Error("Unloading this scene discards unsaved edits. Retry with confirm: true.");
	}
	await unloadWorkspaceScene(options.editor, path);
	await refreshWorkspace(options);
	return { unloaded: true, path, workspace: workspaceSnapshot(scene, options) };
}

function resolveMoveNodes(scene: Scene, nodeIds: string[]): Node[] {
	const nodes: Node[] = [];
	for (const id of nodeIds) {
		const node = scene.getNodeById(id);
		if (!node) {
			throw new Error(`Node not found: ${id}`);
		}
		if (!nodes.includes(node)) {
			nodes.push(node);
		}
	}
	return nodes;
}

function describeMovePlan(plan: ISceneObjectMovePlan): any {
	const resources = plan.objects.map((object: any) => ({
		id: typeof object.id === "string" ? object.id : null,
		name: typeof object.name === "string" ? object.name : null,
		type: typeof object.getClassName === "function" ? object.getClassName() : (object.constructor?.name ?? "Object"),
		from: plan.previousOwners.get(object) ?? null,
	}));
	const value = {
		targetScene: plan.targetScene,
		sourceScenes: [...plan.sourceScenes].sort(),
		rootNodes: plan.rootNodes.map(nodeSummary),
		resources,
		resourceCount: resources.length,
	};
	return { ...value, planFingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

function createMovePlan(scene: Scene, data: any, options: IMCPActionOptions): ISceneObjectMovePlan {
	const targetScene = resolveWorkspaceScenePath(data.targetScene).relativePath;
	return planSceneObjectMove(scene, options.editor.sceneWorkspace, resolveMoveNodes(scene, data.nodeIds), targetScene);
}

/** Plans a lossless scene-root transfer and returns its exact dependency lease without mutation. */
export function inspectSceneObjectMove(scene: Scene, data: any, options: IMCPActionOptions): any {
	return describeMovePlan(createMovePlan(scene, data, options));
}

/** Applies the exact inspected root/dependency transfer with editor undo/redo support. */
export async function moveSceneObjects(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const plan = createMovePlan(scene, data, options);
	const description = describeMovePlan(plan);
	if (data.expectedPlanFingerprint !== description.planFingerprint) {
		throw new Error("The scene-object move plan changed after inspection. Call inspect_scene_object_move again and retry with its planFingerprint.");
	}
	moveSceneObjectsToScene(options.editor, plan.rootNodes, plan.targetScene);
	await refreshWorkspace(options);
	return { moved: true, ...description, workspace: workspaceSnapshot(scene, options) };
}

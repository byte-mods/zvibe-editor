import { dirname, join, basename, relative, normalize } from "path/posix";
import { copy, mkdir, pathExists, remove } from "fs-extra";
import { createHash } from "crypto";

import { Camera, FreeCamera, Scene, Vector3 } from "babylonjs";

import { saveProject, saveProjectConfiguration } from "../../project/save/save";
import { ensureSceneFolders, saveScene as saveSceneToDisk } from "../../project/save/scene";
import { createNewSceneDefaultNodes } from "../../project/load/default";
import { replaceWithSingleSceneWorkspace } from "../../project/load/workspace";
import { createSceneLoadResult } from "../../project/load/result";
import { renameScene } from "../../tools/scene/rename";
import { createSceneLink } from "../../tools/scene/scene-link";
import { isSceneLinkNode } from "../../tools/guards/scene";
import { SceneLinkNode } from "../../editor/nodes/scene-link";
import { projectConfiguration } from "../../project/configuration";
import {
	addSceneToBuildSettings,
	createSceneTemplate,
	deleteSceneTemplate,
	discoverProjectScenes,
	instantiateSceneTemplate,
	listSceneTemplates,
	normalizeSceneBuildSettings,
	removeSceneFromBuildSettings,
} from "../../project/scenes";
import { IEditorSceneBuildSettings } from "../../project/typings";

import { IMCPActionOptions } from "../action";
import { deepSet } from "../tools/resolve";

export interface IPhysicsCollisionLayer {
	name: string;
	bit: number;
	collidesWith: number;
}

function getSceneBuildSettingsFingerprint(settings: IEditorSceneBuildSettings): string {
	return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

async function getCurrentSceneBuildSettings(options: IMCPActionOptions): Promise<IEditorSceneBuildSettings> {
	const directory = getProjectDirectory();
	const activeScenePath = options.editor.state.lastOpenedScenePath ? relative(directory, options.editor.state.lastOpenedScenePath) : null;
	const settings = normalizeSceneBuildSettings(options.editor.state.sceneBuildSettings, activeScenePath, await discoverProjectScenes(directory));
	if (settings.scenes.length > 512) {
		throw new Error("Scene management supports at most 512 scene assets per project.");
	}
	return settings;
}

function paginate<T>(items: T[], data: any): { items: T[]; offset: number; limit: number; total: number; hasMore: boolean; nextOffset: number | null } {
	const offset = Number.isInteger(data?.offset) && data.offset >= 0 ? data.offset : 0;
	const limit = Number.isInteger(data?.limit) ? Math.min(100, Math.max(1, data.limit)) : 50;
	const page = items.slice(offset, offset + limit);
	const nextOffset = offset + page.length < items.length ? offset + page.length : null;
	return { items: page, offset, limit, total: items.length, hasMore: nextOffset !== null, nextOffset };
}

/**
 * Returns the absolute path of the project directory.
 */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	return dirname(projectConfiguration.path);
}

function resolveScenePath(path: string): string {
	const directory = getProjectDirectory();
	const scenePath = normalize(join(directory, path));
	if (!scenePath.startsWith(`${directory}/`) || !scenePath.endsWith(".scene")) {
		throw new Error("Scene paths must be project-relative paths ending in .scene.");
	}

	return scenePath;
}

async function setActiveScenePath(options: IMCPActionOptions, scenePath: string): Promise<void> {
	await new Promise<void>((resolve) => options.editor.setState({ lastOpenedScenePath: scenePath }, resolve));
	await saveProjectConfiguration(options.editor);
}

async function refreshSceneEditor(options: IMCPActionOptions): Promise<void> {
	await options.editor.layout.graph.refresh();
	options.editor.layout.inspector.setEditedObject(options.editor.layout.preview.scene);
	options.editor.layout.assets.refresh();
}

/**
 * Lists all the `.scene` assets available in the project.
 */
export async function listScenes(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const directory = getProjectDirectory();
	const activeScenePath = options.editor.state.lastOpenedScenePath;
	const settings = await getCurrentSceneBuildSettings(options);
	const page = paginate(settings.scenes, data);

	return {
		scenes: page.items.map((entry, pageIndex) => {
			const path = join(directory, entry.path);
			return {
				name: basename(path, ".scene"),
				path: entry.path,
				isActive: !!activeScenePath && join(activeScenePath) === join(path),
				enabled: entry.enabled,
				buildIndex: page.offset + pageIndex,
			};
		}),
		offset: page.offset,
		limit: page.limit,
		total: page.total,
		hasMore: page.hasMore,
		nextOffset: page.nextOffset,
	};
}

export async function getSceneBuildSettings(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const settings = await getCurrentSceneBuildSettings(options);
	return { ...settings, fingerprint: getSceneBuildSettingsFingerprint(settings) };
}

export async function setSceneBuildSettings(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const current = await getCurrentSceneBuildSettings(options);
	if (data.expectedFingerprint !== getSceneBuildSettingsFingerprint(current)) {
		throw new Error("Scene build settings changed after inspection. Call get_scene_build_settings again and retry with its fingerprint.");
	}
	if (!Array.isArray(data.scenes) || data.scenes.length > 512) {
		throw new Error("Scene build settings require an array of at most 512 scenes.");
	}

	const discovered = await discoverProjectScenes(getProjectDirectory());
	const discoveredSet = new Set(discovered);
	const inputPaths = new Set<string>();
	for (const entry of data.scenes) {
		if (!entry || typeof entry.path !== "string" || typeof entry.enabled !== "boolean" || !discoveredSet.has(entry.path)) {
			throw new Error(`Unknown or invalid scene build entry: ${entry?.path ?? "<missing>"}`);
		}
		if (inputPaths.has(entry.path)) {
			throw new Error(`Scene build entries must be unique: ${entry.path}`);
		}
		inputPaths.add(entry.path);
	}
	if (inputPaths.size !== discoveredSet.size) {
		throw new Error("Scene build settings must include every discovered .scene asset exactly once. Disable scenes instead of omitting them.");
	}

	const sceneBuildSettings: IEditorSceneBuildSettings = { version: 1, scenes: data.scenes.map((entry: any) => ({ path: entry.path, enabled: entry.enabled })) };
	await new Promise<void>((resolve) => options.editor.setState({ sceneBuildSettings }, resolve));
	await saveProjectConfiguration(options.editor);

	return { ...sceneBuildSettings, fingerprint: getSceneBuildSettingsFingerprint(sceneBuildSettings) };
}

export async function listProjectSceneTemplates(_scene: Scene, data: any): Promise<any> {
	const page = paginate(await listSceneTemplates(getProjectDirectory()), data);
	return { templates: page.items, offset: page.offset, limit: page.limit, total: page.total, hasMore: page.hasMore, nextOffset: page.nextOffset };
}

export async function createProjectSceneTemplate(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const directory = getProjectDirectory();
	const sourceAbsolutePath = resolveScenePath(data.sourcePath);
	if (sourceAbsolutePath === options.editor.state.lastOpenedScenePath) {
		await saveProject(options.editor);
	}
	const template = await createSceneTemplate(directory, data);
	options.editor.layout.assets.refresh();
	return { created: true, template };
}

export async function instantiateProjectSceneTemplate(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const result = await instantiateSceneTemplate(getProjectDirectory(), data);
	const sceneBuildSettings = addSceneToBuildSettings(options.editor.state.sceneBuildSettings, result.path);
	await new Promise<void>((resolve) => options.editor.setState({ sceneBuildSettings }, resolve));
	await saveProjectConfiguration(options.editor);
	options.editor.layout.assets.refresh();
	return { created: true, ...result };
}

export async function deleteProjectSceneTemplate(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a scene template is destructive. Retry with confirm: true after verifying the path.");
	}
	const result = await deleteSceneTemplate(getProjectDirectory(), data.path);
	options.editor.layout.assets.refresh();
	return result;
}

/**
 * Returns the name/path of the currently edited scene with entity counts.
 */
export function getActiveScene(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const directory = getProjectDirectory();
	const activeScenePath = options.editor.state.lastOpenedScenePath;

	return {
		name: activeScenePath ? basename(activeScenePath, ".scene") : null,
		path: activeScenePath ? relative(directory, activeScenePath) : null,
		meshCount: scene.meshes.length,
		lightCount: scene.lights.length,
		materialCount: scene.materials.length,
	};
}

/**
 * Saves the current scene/project.
 */
export async function saveScene(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	await saveProject(options.editor);

	return { saved: true };
}

/**
 * Creates a new scene with the editor's default camera, ground, box, and directional light.
 */
export async function createScene(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const scenePath = resolveScenePath(data.path);
	if (await pathExists(scenePath)) {
		throw new Error(`A scene already exists at: ${data.path}`);
	}

	await mkdir(dirname(scenePath), { recursive: true });
	await ensureSceneFolders(scenePath);
	await options.editor.layout.preview.reset();

	const result = createSceneLoadResult();
	createNewSceneDefaultNodes(options.editor, result);
	await saveSceneToDisk(options.editor, getProjectDirectory(), scenePath);
	await replaceWithSingleSceneWorkspace(options.editor, getProjectDirectory(), scenePath);
	await new Promise<void>((resolve) =>
		options.editor.setState({ sceneBuildSettings: addSceneToBuildSettings(options.editor.state.sceneBuildSettings, relative(getProjectDirectory(), scenePath)) }, resolve)
	);
	await setActiveScenePath(options, scenePath);
	await refreshSceneEditor(options);

	return { created: true, path: relative(getProjectDirectory(), scenePath) };
}

/**
 * Opens an existing project scene in the editor.
 */
export async function openScene(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const scenePath = resolveScenePath(data.path);
	if (!(await pathExists(scenePath))) {
		throw new Error(`Scene not found: ${data.path}`);
	}

	await replaceWithSingleSceneWorkspace(options.editor, getProjectDirectory(), scenePath);
	await new Promise<void>((resolve) =>
		options.editor.setState({ sceneBuildSettings: addSceneToBuildSettings(options.editor.state.sceneBuildSettings, relative(getProjectDirectory(), scenePath)) }, resolve)
	);
	await setActiveScenePath(options, scenePath);
	await refreshSceneEditor(options);

	return { opened: true, path: relative(getProjectDirectory(), scenePath) };
}

/**
 * Duplicates a scene asset and updates internal references to the new scene path.
 */
export async function duplicateScene(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const sourcePath = resolveScenePath(data.sourcePath);
	const destinationPath = resolveScenePath(data.destinationPath);
	if (!(await pathExists(sourcePath))) {
		throw new Error(`Scene not found: ${data.sourcePath}`);
	}
	if (await pathExists(destinationPath)) {
		throw new Error(`A scene already exists at: ${data.destinationPath}`);
	}

	await copy(sourcePath, destinationPath);
	await renameScene(sourcePath, destinationPath);
	const sceneBuildSettings = addSceneToBuildSettings(options.editor.state.sceneBuildSettings, relative(getProjectDirectory(), destinationPath));
	await new Promise<void>((resolve) => options.editor.setState({ sceneBuildSettings }, resolve));
	await saveProjectConfiguration(options.editor);
	options.editor.layout.assets.refresh();

	return { duplicated: true, path: relative(getProjectDirectory(), destinationPath) };
}

/**
 * Deletes a non-active scene after explicit confirmation.
 */
export async function deleteScene(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a scene is destructive. Retry with confirm: true after verifying the path.");
	}

	const scenePath = resolveScenePath(data.path);
	if (scenePath === options.editor.state.lastOpenedScenePath) {
		throw new Error("The active scene cannot be deleted. Open another scene first.");
	}
	if (!(await pathExists(scenePath))) {
		throw new Error(`Scene not found: ${data.path}`);
	}

	await remove(scenePath);
	const sceneBuildSettings = removeSceneFromBuildSettings(options.editor.state.sceneBuildSettings, relative(getProjectDirectory(), scenePath));
	await new Promise<void>((resolve) => options.editor.setState({ sceneBuildSettings }, resolve));
	await saveProjectConfiguration(options.editor);
	options.editor.layout.assets.refresh();

	return { deleted: true, path: relative(getProjectDirectory(), scenePath) };
}

export function listSceneLinks(scene: Scene): any {
	return {
		sceneLinks: scene.transformNodes.filter(isSceneLinkNode).map((node) => ({ id: node.id, name: node.name, relativePath: node.relativePath })),
	};
}

export async function createSceneLinkNode(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const scenePath = resolveScenePath(data.path);
	if (!(await pathExists(scenePath))) {
		throw new Error(`Scene not found: ${data.path}`);
	}

	const node = await createSceneLink(options.editor, scenePath);
	if (!node) {
		throw new Error("Unable to create scene link because no project is open.");
	}
	if (data.name) {
		node.name = data.name;
	}
	await options.editor.layout.graph.refresh();
	options.editor.layout.graph.setSelectedNode(node);
	options.editor.layout.inspector.setEditedObject(node);

	return { id: node.id, name: node.name, relativePath: node.relativePath };
}

export async function reloadSceneLink(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = scene.transformNodes.find((entry) => isSceneLinkNode(entry) && (entry.id === data.nodeId || entry.name === data.nodeName)) as SceneLinkNode | undefined;
	if (!node) {
		throw new Error(`Scene link not found: ${data.nodeId ?? data.nodeName}`);
	}

	await node.reload();
	await options.editor.layout.graph.refresh();
	options.editor.layout.inspector.setEditedObject(node);

	return { reloaded: true, id: node.id, name: node.name, relativePath: node.relativePath };
}

/**
 * Returns the current scene-level settings.
 */
export function getSceneSettings(scene: Scene): any {
	return {
		clearColor: [scene.clearColor.r, scene.clearColor.g, scene.clearColor.b, scene.clearColor.a],
		ambientColor: [scene.ambientColor.r, scene.ambientColor.g, scene.ambientColor.b],
		environmentTexture: scene.environmentTexture?.name ?? null,
		environmentIntensity: scene.environmentIntensity,
		fogMode: scene.fogMode,
		fogColor: [scene.fogColor.r, scene.fogColor.g, scene.fogColor.b],
		fogStart: scene.fogStart,
		fogEnd: scene.fogEnd,
		fogDensity: scene.fogDensity,
		activeCamera: scene.activeCamera?.name ?? null,
	};
}

/**
 * Sets scene-level settings using dotted property paths.
 */
export function setSceneSettings(scene: Scene, data: any, options: IMCPActionOptions): any {
	const properties = data.properties ?? {};

	for (const path of Object.keys(properties)) {
		deepSet(scene, path, properties[path]);
	}

	options.editor.layout.inspector.forceUpdate();

	return getSceneSettings(scene);
}

/** Returns persisted orthographic 2D scene-authoring configuration. */
export function get2DSceneMode(scene: Scene): any {
	return structuredClone(scene.metadata?.babylonEditor2DMode ?? { enabled: false, cameraId: null, orthographicSize: 500 });
}

/** Enables/disables an orthographic camera setup for sprite/tile/2D physics authoring. */
export function set2DSceneMode(scene: Scene, data: any, options: IMCPActionOptions): any {
	scene.metadata ??= {};
	const previous = get2DSceneMode(scene);
	if (!data.enabled) {
		const camera = previous.cameraId ? scene.getCameraById(previous.cameraId) : null;
		if (camera) {
			camera.mode = Camera.PERSPECTIVE_CAMERA;
		}
		scene.metadata.babylonEditor2DMode = { ...previous, enabled: false };
		options.editor.layout.inspector.forceUpdate();
		return get2DSceneMode(scene);
	}

	let camera = data.cameraId ? scene.getCameraById(data.cameraId) : scene.activeCamera;
	if (!camera) {
		const createdCamera = new FreeCamera("2D Camera", new Vector3(0, 0, -1000), scene);
		createdCamera.setTarget(Vector3.Zero());
		scene.activeCamera = createdCamera;
		camera = createdCamera;
	}
	const orthographicSize = data.orthographicSize ?? previous.orthographicSize ?? 500;
	if (!(orthographicSize > 0)) {
		throw new Error("2D orthographicSize must be greater than zero.");
	}
	const aspectRatio = data.aspectRatio ?? 1;
	if (!(aspectRatio > 0)) {
		throw new Error("2D aspectRatio must be greater than zero.");
	}
	camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
	camera.orthoLeft = -orthographicSize * aspectRatio;
	camera.orthoRight = orthographicSize * aspectRatio;
	camera.orthoBottom = -orthographicSize;
	camera.orthoTop = orthographicSize;
	scene.metadata.babylonEditor2DMode = { enabled: true, cameraId: camera.id, orthographicSize, aspectRatio };
	options.editor.layout.inspector.forceUpdate();
	return get2DSceneMode(scene);
}

/** Reads the persisted named 3D physics collision layers for this scene. */
export function getPhysicsCollisionLayers(scene: Scene): any {
	return structuredClone(scene.metadata?.babylonEditorPhysicsCollisionLayers ?? { layers: [{ name: "Default", bit: 1, collidesWith: 0xffffffff }] });
}

/** Resolves a named collision layer, including the implicit default layer of a new scene. */
export function findPhysicsCollisionLayer(scene: Scene, name: string): IPhysicsCollisionLayer | undefined {
	return getPhysicsCollisionLayers(scene).layers.find((layer: IPhysicsCollisionLayer) => layer.name === name);
}

/** Replaces named 3D physics collision layers after validating unique single-bit memberships. */
export function setPhysicsCollisionLayers(scene: Scene, data: any, options: IMCPActionOptions): any {
	const layers = data.layers as IPhysicsCollisionLayer[];
	if (!Array.isArray(layers) || !layers.length || layers.length > 16) {
		throw new Error("Physics collision layers require from one to sixteen layers.");
	}
	const names = new Set<string>();
	const bits = new Set<number>();
	for (const layer of layers) {
		if (!layer?.name?.trim() || names.has(layer.name)) {
			throw new Error("Physics collision layer names must be non-empty and unique.");
		}
		if (!Number.isInteger(layer.bit) || layer.bit <= 0 || layer.bit > 0x8000 || (layer.bit & (layer.bit - 1)) !== 0 || bits.has(layer.bit)) {
			throw new Error("Each physics collision layer needs a unique single membership bit from 1 through 32768.");
		}
		if (!Number.isInteger(layer.collidesWith) || layer.collidesWith < 0 || layer.collidesWith > 0xffff) {
			throw new Error("Physics collision layer collidesWith must be a 16-bit non-negative mask.");
		}
		names.add(layer.name);
		bits.add(layer.bit);
	}
	scene.metadata ??= {};
	scene.metadata.babylonEditorPhysicsCollisionLayers = { layers: layers.map((layer) => ({ name: layer.name.trim(), bit: layer.bit, collidesWith: layer.collidesWith })) };
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getPhysicsCollisionLayers(scene);
}

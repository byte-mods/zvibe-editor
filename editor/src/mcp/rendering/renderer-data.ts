import { join, relative } from "path/posix";

import { pathExists, remove } from "fs-extra";
import { Scene, Tools } from "babylonjs";
import {
	configureRendererDataSelections,
	getDeferredLightingRuntime,
	getDeferredLightingRuntimes,
	getRendererDataRuntime,
	IRendererDataAssetSnapshot,
	IRendererDataSelections,
	IRendererDataSettings,
	rendererDataRenderingPaths,
	rendererDataSelectionsMetadataKey,
	rendererDataSettingsPreset,
	validateRendererDataSelections,
	validateRendererDataSettings,
} from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";
import { IMCPActionOptions } from "../action";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths } from "../assets/registry";
import {
	readBoundedRenderingAsset,
	renderingAssetHash,
	renderingAssetProjectDirectory,
	renderingAssetRelativePath,
	secureRenderingAssetPath,
	writeAtomicRenderingAsset,
} from "./rendering-asset-file";

const assetType = "babylon-editor-renderer-data" as const;
const currentAssetVersion = 1 as const;
const maximumAssetBytes = 256 * 1024;
const maximumListedAssets = 512;

interface IRendererDataAsset {
	version: 1;
	type: typeof assetType;
	id: string;
	name: string;
	revision: number;
	settings: IRendererDataSettings;
}

function validateAsset(value: unknown, path: string): IRendererDataAsset {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Renderer-data asset at ${path} must be an object.`);
	}
	const source = value as Record<string, unknown>;
	const unknown = Object.keys(source).filter((key) => !["version", "type", "id", "name", "revision", "settings"].includes(key));
	if (unknown.length) {
		throw new Error(`Renderer-data asset at ${path} contains unknown fields: ${unknown.join(", ")}.`);
	}
	if (source.version !== currentAssetVersion || source.type !== assetType) {
		throw new Error(`Renderer-data asset at ${path} is invalid or uses an unsupported version.`);
	}
	if (typeof source.id !== "string" || !source.id.trim() || source.id.length > 128) {
		throw new Error(`Renderer-data asset at ${path} requires an id containing 1–128 characters.`);
	}
	if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128) {
		throw new Error(`Renderer-data asset at ${path} requires a name containing 1–128 characters.`);
	}
	if (!Number.isInteger(source.revision) || (source.revision as number) < 1) {
		throw new Error(`Renderer-data asset at ${path} requires a positive integer revision.`);
	}
	return {
		version: 1,
		type: assetType,
		id: source.id,
		name: source.name.trim(),
		revision: source.revision as number,
		settings: validateRendererDataSettings(source.settings),
	};
}

async function readAsset(path: unknown): Promise<{ asset: IRendererDataAsset; absolutePath: string; relativePath: string; contentRevision: string }> {
	const value = await readBoundedRenderingAsset(path, ".rendererdata.json", "Renderer-data asset", maximumAssetBytes);
	const asset = validateAsset(value.source, value.relativePath);
	return { asset, absolutePath: value.absolutePath, relativePath: value.relativePath, contentRevision: renderingAssetHash(asset) };
}

function summary(asset: IRendererDataAsset, path: string): any {
	return {
		path,
		id: asset.id,
		name: asset.name,
		version: asset.version,
		assetRevision: asset.revision,
		contentRevision: renderingAssetHash(asset),
		renderingPath: asset.settings.renderingPath,
		fallbackToForward: asset.settings.fallbackToForward,
		layerMask: asset.settings.layerMask,
		postProcessesEnabled: asset.settings.postProcessesEnabled,
		depthTextureMode: asset.settings.depthTexture.mode,
		depthPrimingMode: asset.settings.depthPrimingMode,
		rendererFeatureCount: asset.settings.rendererFeatureInstanceIds?.length ?? null,
	};
}

async function writeAsset(absolutePath: string, asset: IRendererDataAsset): Promise<void> {
	await writeAtomicRenderingAsset(absolutePath, asset, maximumAssetBytes, (source) => validateAsset(source, renderingAssetRelativePath(absolutePath)));
}

function selections(scene: Scene): IRendererDataSelections {
	scene.metadata ??= {};
	const value = validateRendererDataSelections(scene.metadata[rendererDataSelectionsMetadataKey]);
	scene.metadata[rendererDataSelectionsMetadataKey] = value;
	return value;
}

function snapshot(value: Awaited<ReturnType<typeof readAsset>>): IRendererDataAssetSnapshot {
	return {
		version: 1,
		path: value.relativePath,
		id: value.asset.id,
		name: value.asset.name,
		assetRevision: value.asset.revision,
		contentRevision: value.contentRevision,
		settings: structuredClone(value.asset.settings),
	};
}

function publishSelections(scene: Scene, previous: IRendererDataSelections, next: IRendererDataSelections, options: IMCPActionOptions): any {
	scene.metadata[rendererDataSelectionsMetadataKey] = validateRendererDataSelections(next);
	const runtime = configureRendererDataSelections(scene as any);
	if (!runtime.configured && (next.default || next.cameras.length)) {
		scene.metadata[rendererDataSelectionsMetadataKey] = previous;
		configureRendererDataSelections(scene as any);
		throw new Error(`Renderer-data selection could not be activated: ${runtime.errors.join(" ")}`);
	}
	options.editor.layout.inspector.forceUpdate();
	return runtime;
}

/** Creates one reusable, closed, versioned renderer-data project asset. */
export async function createRendererDataAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = await secureRenderingAssetPath(data.path, ".rendererdata.json", "Renderer-data asset");
	if (await pathExists(absolutePath)) {
		throw new Error(`Renderer-data asset already exists at ${data.path}. Use update_renderer_data_asset with its exact content revision.`);
	}
	const renderingPath = data.settings?.renderingPath ?? data.renderingPath ?? "forward";
	if (!rendererDataRenderingPaths.includes(renderingPath)) {
		throw new Error("Renderer-data renderingPath must be forward, forward-plus, or deferred.");
	}
	const settings = validateRendererDataSettings(data.settings ?? rendererDataSettingsPreset(renderingPath));
	const asset = validateAsset({ version: 1, type: assetType, id: Tools.RandomId(), name: data.name, revision: 1, settings }, String(data.path));
	await writeAsset(absolutePath, asset);
	options.editor.layout.assets.refresh();
	return summary(asset, renderingAssetRelativePath(absolutePath));
}

/** Lists renderer-data assets plus exact current default/per-camera assignments. */
export async function listRendererDataAssets(scene: Scene, data: any): Promise<any> {
	const root = renderingAssetProjectDirectory();
	const paths = (await normalizedGlob(join(root, "**/*.rendererdata.json"), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] })) as string[];
	const assets: any[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const search = data.search?.toLowerCase();
	for (const path of paths.sort().slice(0, maximumListedAssets)) {
		try {
			const value = await readAsset(relative(root, path));
			const item = summary(value.asset, value.relativePath);
			if (!search || item.path.toLowerCase().includes(search) || item.name.toLowerCase().includes(search)) {
				assets.push(item);
			}
		} catch (error) {
			if (errors.length < 32) {
				errors.push({ path: relative(root, path).replace(/\\/g, "/"), error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 64;
	return {
		assets: assets.slice(offset, offset + limit),
		page: { total: assets.length, offset, count: Math.max(0, Math.min(limit, assets.length - offset)), hasMore: offset + limit < assets.length },
		errors,
		truncated: paths.length > maximumListedAssets,
		selections: selections(scene),
		runtime: getRendererDataRuntime(scene as any),
	};
}

/** Reads one exact renderer-data asset without mutating scene state. */
export async function getRendererDataAsset(_scene: Scene, data: any): Promise<any> {
	const value = await readAsset(data.path);
	return { ...summary(value.asset, value.relativePath), asset: structuredClone(value.asset) };
}

/** Replaces one exact renderer-data asset revision atomically. Existing scene snapshots remain intentionally unchanged until reassigned. */
export async function updateRendererDataAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Renderer-data asset revision is stale. Expected ${value.contentRevision}.`);
	}
	const asset = validateAsset(
		{
			...value.asset,
			name: data.name ?? value.asset.name,
			revision: value.asset.revision + 1,
			settings: data.settings ?? value.asset.settings,
		},
		value.relativePath
	);
	await writeAsset(value.absolutePath, asset);
	options.editor.layout.assets.refresh();
	return summary(asset, value.relativePath);
}

/** Assigns an exact renderer-data file snapshot as the default renderer or one camera override. */
export async function assignRendererData(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Renderer-data asset revision is stale. Expected ${value.contentRevision}.`);
	}
	const previous = selections(scene);
	if (data.selectionRevision !== previous.revision) {
		throw new Error(`Renderer-data selection revision is stale. Expected ${previous.revision}.`);
	}
	const asset = snapshot(value);
	const next = structuredClone(previous);
	next.revision++;
	if (data.cameraId) {
		const camera = scene.getCameraById(data.cameraId);
		if (!camera) {
			throw new Error(`Camera not found: ${data.cameraId}`);
		}
		next.cameras = [...next.cameras.filter((entry) => entry.cameraId !== camera.id), { cameraId: camera.id, asset }];
	} else {
		next.default = asset;
	}
	const runtime = publishSelections(scene, previous, next, options);
	return { assigned: true, target: data.cameraId ? { type: "camera", cameraId: data.cameraId } : { type: "default" }, selections: next, runtime };
}

/** Clears one exact default or camera renderer selection and restores owned runtime state. */
export function clearRendererDataAssignment(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = selections(scene);
	if (data.selectionRevision !== previous.revision) {
		throw new Error(`Renderer-data selection revision is stale. Expected ${previous.revision}.`);
	}
	const next = structuredClone(previous);
	if (data.cameraId) {
		if (!next.cameras.some((entry) => entry.cameraId === data.cameraId)) {
			throw new Error(`Camera ${data.cameraId} has no renderer-data override.`);
		}
		next.cameras = next.cameras.filter((entry) => entry.cameraId !== data.cameraId);
	} else {
		if (!next.default) {
			throw new Error("No default renderer-data asset is assigned.");
		}
		next.default = null;
	}
	next.revision++;
	const runtime = publishSelections(scene, previous, next, options);
	return { cleared: true, target: data.cameraId ? { type: "camera", cameraId: data.cameraId } : { type: "default" }, selections: next, runtime };
}

/** Reads persisted selection leases and exact Babylon runtime/fallback evidence. */
export function getRendererDataState(scene: Scene): any {
	return { selections: selections(scene), runtime: getRendererDataRuntime(scene as any) };
}

/** Reads bounded deferred decal, emissive, native shadow-filter, IBL, and forward-composition evidence for selected cameras. */
export function getDeferredLightingState(scene: Scene, data: any = {}): any {
	const current = selections(scene);
	const rendererDataRuntime = getRendererDataRuntime(scene as any);
	const requestedCameras = rendererDataRuntime.cameras.filter((camera) => camera.requestedRenderingPath === "deferred" && (!data.cameraId || camera.cameraId === data.cameraId));
	if (data.cameraId && !scene.getCameraById(data.cameraId)) {
		throw new Error(`Camera not found: ${data.cameraId}`);
	}
	return {
		selectionRevision: current.revision,
		requestedCameras,
		runtime: data.cameraId ? getDeferredLightingRuntime(scene as any, data.cameraId) : getDeferredLightingRuntime(scene as any),
		runtimes: data.cameraId ? [getDeferredLightingRuntime(scene as any, data.cameraId)] : getDeferredLightingRuntimes(scene as any),
	};
}

/** Rebuilds the exact selected deferred decal/emissive/IBL/shadow/forward runtime without changing the persisted asset snapshot. */
export function rebuildDeferredLighting(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = selections(scene);
	if (data.selectionRevision !== current.revision) {
		throw new Error(`Renderer-data selection revision is stale. Expected ${current.revision}.`);
	}
	const camera = scene.getCameraById(data.cameraId);
	if (!camera) {
		throw new Error(`Camera not found: ${data.cameraId}`);
	}
	const selected = current.cameras.find((entry) => entry.cameraId === camera.id)?.asset ?? current.default;
	if (!selected) {
		throw new Error(`Camera ${camera.id} has no renderer-data selection.`);
	}
	if (selected.settings.renderingPath !== "deferred") {
		throw new Error(`Camera ${camera.id} requests ${selected.settings.renderingPath}, not deferred rendering.`);
	}
	const rendererDataRuntime = configureRendererDataSelections(scene as any);
	options.editor.layout.inspector.forceUpdate();
	const cameraRuntime = rendererDataRuntime.cameras.find((entry) => entry.cameraId === camera.id);
	if (!cameraRuntime) {
		throw new Error(`Deferred runtime evidence was not produced for camera ${camera.id}.`);
	}
	return {
		rebuilt: true,
		selectionRevision: current.revision,
		camera: cameraRuntime,
		runtime: getDeferredLightingRuntime(scene as any, camera.id),
	};
}

/** Deletes an exact renderer-data asset only when the current scene does not reference it. */
export async function deleteRendererDataAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Renderer-data asset revision is stale. Expected ${value.contentRevision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Deleting a renderer-data asset requires confirm: true.");
	}
	const current = selections(scene);
	const references = [current.default, ...current.cameras.map((entry) => entry.asset)].filter((asset) => asset?.id === value.asset.id);
	if (references.length) {
		throw new Error(`Renderer-data asset "${value.asset.name}" is assigned ${references.length} time${references.length === 1 ? "" : "s"} in this scene.`);
	}
	await remove(value.absolutePath);
	const metadataPath = `${value.absolutePath}${ASSET_META_SUFFIX}`;
	if (await pathExists(metadataPath)) {
		await remove(metadataPath);
	}
	await refreshAssetRegistryPaths([value.absolutePath]);
	if (await pathExists(metadataPath)) {
		await remove(metadataPath);
	}
	options.editor.layout.assets.refresh();
	return {
		deleted: true,
		path: value.relativePath,
		id: value.asset.id,
		assetRevision: value.asset.revision,
		contentRevision: value.contentRevision,
		metadataDeleted: !(await pathExists(metadataPath)),
	};
}

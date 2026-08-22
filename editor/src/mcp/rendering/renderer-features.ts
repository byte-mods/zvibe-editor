import { join, relative } from "path/posix";

import { pathExists, remove } from "fs-extra";
import { Camera, Scene, Tools } from "babylonjs";
import {
	configureCustomRenderPassFrameIsolation,
	customRenderPassInjectionPoints,
	getCustomRenderPassSchedule,
	ICustomRenderPassDefinition,
	sortCustomRenderPassGraph,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";
import { IMCPActionOptions } from "../action";
import {
	readBoundedRenderingAsset,
	renderingAssetHash,
	renderingAssetProjectDirectory,
	renderingAssetRelativePath,
	secureRenderingAssetPath,
	writeAtomicRenderingAsset,
} from "./rendering-asset-file";

const assetType = "babylon-editor-renderer-feature";
const currentAssetVersion = 1 as const;
const maximumAssetBytes = 4 * 1024 * 1024;
const maximumListedAssets = 512;
const instancesMetadataKey = "babylonEditorRendererFeatureInstances";

export interface IRendererFeatureCameraFilter {
	cameraIds: string[];
	excludeCameraIds: string[];
	projection: "any" | "perspective" | "orthographic";
	layerMask: number | null;
}

interface IRendererFeatureAsset {
	version: 1;
	type: typeof assetType;
	id: string;
	name: string;
	revision: number;
	passes: ICustomRenderPassDefinition[];
}

interface IRendererFeatureInstance {
	version: 1;
	id: string;
	name: string;
	revision: number;
	enabled: boolean;
	order: number;
	prefix: string;
	assetPath: string;
	assetId: string;
	assetVersion: 1;
	assetRevision: string;
	cameraFilter: IRendererFeatureCameraFilter;
	passes: Array<{ sourcePassId: string; generatedPassId: string; name: string; enabled: boolean; order: number }>;
	outputs: Array<{ sourceName: string; generatedName: string }>;
}

function defaultCameraFilter(): IRendererFeatureCameraFilter {
	return { cameraIds: [], excludeCameraIds: [], projection: "any", layerMask: null };
}

function normalizeCameraFilter(value: unknown): IRendererFeatureCameraFilter {
	const source = (value ?? {}) as Partial<IRendererFeatureCameraFilter>;
	const defaults = defaultCameraFilter();
	const filter: IRendererFeatureCameraFilter = {
		cameraIds: [...(source.cameraIds ?? defaults.cameraIds)],
		excludeCameraIds: [...(source.excludeCameraIds ?? defaults.excludeCameraIds)],
		projection: source.projection ?? defaults.projection,
		layerMask: source.layerMask ?? defaults.layerMask,
	};
	for (const [label, values] of [
		["cameraIds", filter.cameraIds],
		["excludeCameraIds", filter.excludeCameraIds],
	] as const) {
		if (values.length > 64 || values.some((item) => typeof item !== "string" || !item.trim() || item.length > 256) || new Set(values).size !== values.length) {
			throw new Error(`Renderer-feature ${label} must contain at most 64 unique bounded camera ids.`);
		}
	}
	if (!["any", "perspective", "orthographic"].includes(filter.projection)) {
		throw new Error("Renderer-feature projection must be any, perspective, or orthographic.");
	}
	if (filter.layerMask !== null && (!Number.isInteger(filter.layerMask) || filter.layerMask < 0 || filter.layerMask > 4_294_967_295)) {
		throw new Error("Renderer-feature layerMask must be null or an unsigned 32-bit integer.");
	}
	return filter;
}

function normalizePasses(value: unknown, path: string): ICustomRenderPassDefinition[] {
	if (!Array.isArray(value)) {
		throw new Error(`Renderer-feature asset at ${path} must contain a passes array.`);
	}
	if (value.length > 64) {
		throw new Error(`Renderer-feature asset at ${path} supports at most 64 passes.`);
	}
	const passes = structuredClone(value) as ICustomRenderPassDefinition[];
	passes.forEach((pass) => (pass.rendererFeature = null));
	if (passes.some((pass) => typeof pass.id !== "string" || pass.id.length > 256 || typeof pass.name !== "string" || pass.name.length > 256)) {
		throw new Error(`Renderer-feature asset at ${path} pass ids and names must contain at most 256 characters.`);
	}
	try {
		return sortCustomRenderPassGraph(passes);
	} catch (error) {
		throw new Error(`Renderer-feature asset at ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateAsset(value: unknown, path: string): IRendererFeatureAsset {
	const source = value as Partial<IRendererFeatureAsset>;
	if (source?.version !== currentAssetVersion || source.type !== assetType) {
		throw new Error(`Renderer-feature asset at ${path} is invalid or uses an unsupported version.`);
	}
	if (typeof source.id !== "string" || !source.id.trim() || source.id.length > 128) {
		throw new Error(`Renderer-feature asset at ${path} requires a bounded non-empty id.`);
	}
	if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128) {
		throw new Error(`Renderer-feature asset at ${path} requires a name containing 1–128 characters.`);
	}
	if (!Number.isInteger(source.revision) || source.revision! < 1) {
		throw new Error(`Renderer-feature asset at ${path} requires a positive integer revision.`);
	}
	const passes = normalizePasses(source.passes, path);
	if (!passes.length) {
		throw new Error(`Renderer-feature asset at ${path} requires at least one pass.`);
	}
	return { version: 1, type: assetType, id: source.id, name: source.name.trim(), revision: source.revision!, passes };
}

async function readAsset(path: unknown): Promise<{ asset: IRendererFeatureAsset; absolutePath: string; relativePath: string; contentRevision: string }> {
	const value = await readBoundedRenderingAsset(path, ".renderfeature.json", "Renderer-feature asset", maximumAssetBytes);
	const asset = validateAsset(value.source, String(path));
	return { asset, absolutePath: value.absolutePath, relativePath: value.relativePath, contentRevision: renderingAssetHash(asset) };
}

function summary(asset: IRendererFeatureAsset, path: string): any {
	const schedule = getCustomRenderPassSchedule(structuredClone(asset.passes));
	return {
		path,
		id: asset.id,
		name: asset.name,
		version: asset.version,
		assetRevision: asset.revision,
		contentRevision: renderingAssetHash(asset),
		passCount: asset.passes.length,
		resourceCount: schedule.outputs.length,
		injectionPoints: Object.fromEntries(customRenderPassInjectionPoints.map((point) => [point, asset.passes.filter((pass) => pass.injectionPoint === point).length])),
	};
}

async function writeAsset(absolutePath: string, asset: IRendererFeatureAsset): Promise<void> {
	await writeAtomicRenderingAsset(absolutePath, asset, maximumAssetBytes, (source) => {
		validateAsset(source, renderingAssetRelativePath(absolutePath));
	});
}

function scenePasses(scene: Scene): ICustomRenderPassDefinition[] {
	scene.metadata ??= {};
	const values = (scene.metadata.babylonEditorCustomRenderPasses ??= []) as ICustomRenderPassDefinition[];
	sortCustomRenderPassGraph(values);
	return values;
}

function validateInstance(value: unknown): IRendererFeatureInstance {
	const source = value as IRendererFeatureInstance;
	if (!source || source.version !== 1 || typeof source.id !== "string" || !source.id.trim() || source.id.length > 128) {
		throw new Error("Renderer-feature instance has invalid version or identity.");
	}
	if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128 || !Number.isInteger(source.revision) || source.revision < 1) {
		throw new Error(`Renderer-feature instance "${source.id}" has invalid name or revision.`);
	}
	if (typeof source.enabled !== "boolean" || !Number.isInteger(source.order) || source.order < -1000 || source.order > 1000) {
		throw new Error(`Renderer-feature instance "${source.name}" has invalid enabled state or order.`);
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(source.prefix)) {
		throw new Error(`Renderer-feature instance "${source.name}" has an invalid shader-safe prefix.`);
	}
	if (![source.assetPath, source.assetId, source.assetRevision].every((item) => typeof item === "string" && item.trim()) || source.assetVersion !== 1) {
		throw new Error(`Renderer-feature instance "${source.name}" has invalid asset provenance.`);
	}
	const cameraFilter = normalizeCameraFilter(source.cameraFilter);
	if (!Array.isArray(source.passes) || !source.passes.length || source.passes.length > 64 || !Array.isArray(source.outputs) || source.outputs.length > 256) {
		throw new Error(`Renderer-feature instance "${source.name}" has invalid bounded pass/output mappings.`);
	}
	const generatedIds = new Set<string>();
	for (const pass of source.passes) {
		if (
			![pass.sourcePassId, pass.generatedPassId, pass.name].every((item) => typeof item === "string" && item.trim()) ||
			typeof pass.enabled !== "boolean" ||
			!Number.isFinite(pass.order) ||
			generatedIds.has(pass.generatedPassId)
		) {
			throw new Error(`Renderer-feature instance "${source.name}" has an invalid pass mapping.`);
		}
		generatedIds.add(pass.generatedPassId);
	}
	const generatedOutputs = new Set<string>();
	for (const output of source.outputs) {
		if (!output.sourceName?.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(output.generatedName) || generatedOutputs.has(output.generatedName)) {
			throw new Error(`Renderer-feature instance "${source.name}" has an invalid output mapping.`);
		}
		generatedOutputs.add(output.generatedName);
	}
	return { ...structuredClone(source), cameraFilter };
}

function instances(scene: Scene): IRendererFeatureInstance[] {
	scene.metadata ??= {};
	const values = ((scene.metadata[instancesMetadataKey] ??= []) as unknown[]).map(validateInstance);
	if (values.length > 64 || new Set(values.map((value) => value.id)).size !== values.length || new Set(values.map((value) => value.prefix)).size !== values.length) {
		throw new Error("A scene supports at most 64 renderer-feature instances with unique ids and prefixes.");
	}
	scene.metadata[instancesMetadataKey] = values;
	return values;
}

function resolveInstance(scene: Scene, data: any): IRendererFeatureInstance {
	const values = instances(scene);
	const byId = data.instanceId ? values.find((candidate) => candidate.id === data.instanceId) : undefined;
	const byName = data.instanceName ? values.filter((candidate) => candidate.name === data.instanceName) : [];
	if (byName.length > 1 && !data.instanceId) {
		throw new Error(`Renderer-feature instance name "${data.instanceName}" is ambiguous. Use instanceId.`);
	}
	if (byId && byName.length && byName[0].id !== byId.id) {
		throw new Error("instanceId and instanceName select different renderer-feature instances.");
	}
	const value = byId ?? byName[0];
	if (!value) {
		throw new Error("Renderer-feature instance not found. Provide instanceId (preferred) or instanceName.");
	}
	return value;
}

function outputNames(pass: ICustomRenderPassDefinition): string[] {
	return [pass.output, ...pass.additionalOutputs.map((output) => output.name)].filter((value): value is string => Boolean(value));
}

function generatedPasses(
	asset: IRendererFeatureAsset,
	instance: Omit<IRendererFeatureInstance, "passes" | "outputs">
): { passes: ICustomRenderPassDefinition[]; mappings: IRendererFeatureInstance } {
	const idMap = new Map(asset.passes.map((pass) => [pass.id, `${instance.prefix}_${pass.id}`]));
	const sourceOutputs = asset.passes.flatMap(outputNames);
	const outputMap = new Map(sourceOutputs.map((name) => [name, `${instance.prefix}_${name}`]));
	const passes = asset.passes.map((source) => {
		const pass = structuredClone(source);
		pass.id = idMap.get(source.id)!;
		pass.name = `${instance.name} / ${source.name}`;
		pass.enabled = instance.enabled && source.enabled;
		pass.order = instance.order * 100_000 + source.order;
		pass.dependencies = source.dependencies.map((id) => idMap.get(id)!);
		pass.output = source.output ? outputMap.get(source.output)! : null;
		pass.additionalOutputs = source.additionalOutputs.map((output) => ({ ...output, name: outputMap.get(output.name)! }));
		if (pass.copySource.source === "pass" && pass.copySource.output) {
			pass.copySource.output = outputMap.get(pass.copySource.output)!;
		}
		pass.inputs = Object.fromEntries(
			Object.entries(pass.inputs).map(([name, input]) => [name, input.source === "pass" && input.output ? { ...input, output: outputMap.get(input.output)! } : input])
		);
		pass.rendererFeature = {
			instanceId: instance.id,
			assetId: asset.id,
			assetPath: instance.assetPath,
			assetRevision: instance.assetRevision,
			sourcePassId: source.id,
			sourceEnabled: source.enabled,
			sourceOrder: source.order,
			cameraFilter: structuredClone(instance.cameraFilter),
		};
		return pass;
	});
	const mappings: IRendererFeatureInstance = {
		...structuredClone(instance),
		passes: asset.passes.map((pass) => ({ sourcePassId: pass.id, generatedPassId: idMap.get(pass.id)!, name: pass.name, enabled: pass.enabled, order: pass.order })),
		outputs: sourceOutputs.map((name) => ({ sourceName: name, generatedName: outputMap.get(name)! })),
	};
	return { passes, mappings };
}

function cameraMatches(filter: IRendererFeatureCameraFilter, camera: Camera | null): boolean {
	if (!camera) {
		return false;
	}
	if (filter.cameraIds.length && !filter.cameraIds.includes(camera.id)) {
		return false;
	}
	if (filter.excludeCameraIds.includes(camera.id)) {
		return false;
	}
	if (filter.projection === "orthographic" && camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) {
		return false;
	}
	if (filter.projection === "perspective" && camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
		return false;
	}
	if (filter.layerMask !== null && (camera.layerMask & filter.layerMask) === 0) {
		return false;
	}
	return true;
}

function publish(scene: Scene, nextPasses: ICustomRenderPassDefinition[], nextInstances: IRendererFeatureInstance[], options: IMCPActionOptions): any {
	const previousPasses = structuredClone(scenePasses(scene));
	const previousInstances = structuredClone(instances(scene));
	const validatedPasses = sortCustomRenderPassGraph(structuredClone(nextPasses));
	const validatedInstances = nextInstances.map(validateInstance);
	try {
		scene.metadata.babylonEditorCustomRenderPasses = validatedPasses;
		scene.metadata[instancesMetadataKey] = validatedInstances;
		const preview = scene.activeCamera
			? configureCustomRenderPassFrameIsolation(scene as any, scene.activeCamera as any, validatedPasses, null, getProjectAssetsRootUrl() ?? "")
			: { isolationPassId: null, executionOrder: [], activePassCount: 0 };
		options.editor.layout.inspector.forceUpdate();
		return preview;
	} catch (error) {
		scene.metadata.babylonEditorCustomRenderPasses = previousPasses;
		scene.metadata[instancesMetadataKey] = previousInstances;
		if (scene.activeCamera) {
			try {
				configureCustomRenderPassFrameIsolation(scene as any, scene.activeCamera as any, previousPasses, null, getProjectAssetsRootUrl() ?? "");
			} catch {
				// Preserve the publication error; normal render diagnostics expose rollback failure.
			}
		}
		throw error;
	}
}

/** Saves a dependency-closed subset of base passes as a reusable renderer-feature asset. */
export async function saveRendererFeatureAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!Array.isArray(data.passIds) || !data.passIds.length || data.passIds.length > 64 || new Set(data.passIds).size !== data.passIds.length) {
		throw new Error("Saving a renderer feature requires 1–64 unique passIds.");
	}
	const selected = scenePasses(scene).filter((pass) => data.passIds.includes(pass.id));
	if (selected.length !== data.passIds.length) {
		throw new Error("One or more selected renderer-feature pass ids were not found.");
	}
	if (selected.some((pass) => pass.rendererFeature)) {
		throw new Error("Save base passes, not passes already owned by a renderer-feature instance.");
	}
	const selectedIds = new Set(data.passIds);
	for (const pass of selected) {
		const missingDependencies = pass.dependencies.filter((id) => !selectedIds.has(id));
		if (missingDependencies.length) {
			throw new Error(`Renderer-feature pass "${pass.name}" requires unselected dependencies: ${missingDependencies.join(", ")}. Include its complete dependency closure.`);
		}
	}
	const absolutePath = await secureRenderingAssetPath(data.path, ".renderfeature.json", "Renderer-feature asset");
	const existing = (await pathExists(absolutePath)) ? await readAsset(data.path) : null;
	if (existing) {
		if (data.overwrite !== true) {
			throw new Error(`Renderer-feature asset exists at ${data.path}. Set overwrite: true and provide expectedRevision to replace it.`);
		}
		if (data.expectedRevision !== existing.contentRevision) {
			throw new Error(`Renderer-feature asset revision is stale. Expected ${existing.contentRevision}.`);
		}
	}
	const asset = validateAsset(
		{
			version: 1,
			type: assetType,
			id: existing?.asset.id ?? Tools.RandomId(),
			name: (data.assetName ?? existing?.asset.name ?? "Renderer Feature").trim(),
			revision: existing ? existing.asset.revision + 1 : 1,
			passes: selected.map((pass) => ({ ...structuredClone(pass), rendererFeature: null })),
		},
		String(data.path)
	);
	await writeAsset(absolutePath, asset);
	options.editor.layout.assets.refresh();
	return summary(asset, renderingAssetRelativePath(absolutePath));
}

/** Lists bounded reusable renderer-feature assets. */
export async function listRendererFeatureAssets(_scene: Scene, data: any): Promise<any> {
	const root = renderingAssetProjectDirectory();
	const paths = (await normalizedGlob(join(root, "**/*.renderfeature.json"), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] })) as string[];
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
	};
}

/** Reads one renderer-feature asset and its complete bounded subpass graph. */
export async function getRendererFeatureAsset(_scene: Scene, data: any): Promise<any> {
	const value = await readAsset(data.path);
	return { ...summary(value.asset, value.relativePath), asset: structuredClone(value.asset) };
}

/** Instantiates one exact feature revision with namespaced pass/resource identities and camera filtering. */
export async function instantiateRendererFeature(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Renderer-feature asset revision is stale. Expected ${value.contentRevision}.`);
	}
	const existing = instances(scene);
	const prefix =
		data.prefix?.trim() ||
		`feature_${Tools.RandomId()
			.replace(/[^A-Za-z0-9_]/g, "_")
			.slice(0, 12)}`;
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(prefix)) {
		throw new Error("Renderer-feature prefix must be a shader-safe identifier containing at most 64 characters.");
	}
	const id = data.instanceId?.trim() || prefix;
	if (existing.some((instance) => instance.id === id || instance.prefix === prefix)) {
		throw new Error(`Renderer-feature instance id or prefix already exists: ${id}`);
	}
	const base = {
		version: 1 as const,
		id,
		name: data.instanceName?.trim() || value.asset.name,
		revision: 1,
		enabled: data.enabled ?? true,
		order: data.order ?? 0,
		prefix,
		assetPath: value.relativePath,
		assetId: value.asset.id,
		assetVersion: 1 as const,
		assetRevision: value.contentRevision,
		cameraFilter: normalizeCameraFilter(data.cameraFilter),
	};
	const generated = generatedPasses(value.asset, base);
	const preview = publish(scene, [...scenePasses(scene), ...generated.passes], [...existing, generated.mappings], options);
	return { instance: structuredClone(generated.mappings), generatedPassIds: generated.passes.map((pass) => pass.id), preview };
}

/** Lists bounded renderer-feature instances and exact active-camera filter state. */
export function listRendererFeatureInstances(scene: Scene, data: any): any {
	const values = instances(scene);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 64;
	const filtered = values.filter(
		(value) => !data.search || value.name.toLowerCase().includes(data.search.toLowerCase()) || value.id.toLowerCase().includes(data.search.toLowerCase())
	);
	return {
		instances: filtered
			.slice(offset, offset + limit)
			.map((value) => ({ ...structuredClone(value), activeForCamera: value.enabled && cameraMatches(value.cameraFilter, scene.activeCamera) })),
		page: { total: filtered.length, offset, count: Math.max(0, Math.min(limit, filtered.length - offset)), hasMore: offset + limit < filtered.length },
		activeCameraId: scene.activeCamera?.id ?? null,
	};
}

/** Updates one exact instance revision and atomically reapplies enabled/order/camera-filter state to every owned pass. */
export function setRendererFeatureInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = instances(scene);
	const current = resolveInstance(scene, data);
	if (data.revision !== current.revision) {
		throw new Error(`Renderer-feature instance revision is stale. Expected ${current.revision}.`);
	}
	const next = validateInstance({
		...structuredClone(current),
		...(data.name !== undefined ? { name: data.name } : {}),
		...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
		...(data.order !== undefined ? { order: data.order } : {}),
		...(data.cameraFilter !== undefined ? { cameraFilter: normalizeCameraFilter(data.cameraFilter) } : {}),
		revision: current.revision + 1,
	});
	const nextPasses = scenePasses(scene).map((pass) => {
		if (pass.rendererFeature?.instanceId !== current.id) {
			return pass;
		}
		const mapping = next.passes.find((candidate) => candidate.generatedPassId === pass.id)!;
		return {
			...structuredClone(pass),
			name: `${next.name} / ${mapping.name}`,
			enabled: next.enabled && mapping.enabled,
			order: next.order * 100_000 + mapping.order,
			rendererFeature: { ...structuredClone(pass.rendererFeature), cameraFilter: structuredClone(next.cameraFilter) },
		};
	});
	const nextInstances = values.map((value) => (value.id === current.id ? next : value));
	const preview = publish(scene, nextPasses, nextInstances, options);
	return { instance: structuredClone(next), preview };
}

/** Reads missing/outdated/current asset state and active-camera injection evidence for feature instances. */
export async function getRendererFeatureDiagnostics(scene: Scene, data: any): Promise<any> {
	const values = instances(scene);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 64;
	const diagnostics: any[] = [];
	for (const instance of values) {
		try {
			const asset = await readAsset(instance.assetPath);
			diagnostics.push({
				instanceId: instance.id,
				name: instance.name,
				status: asset.contentRevision === instance.assetRevision ? "current" : "outdated",
				assetRevision: instance.assetRevision,
				latestAssetRevision: asset.contentRevision,
				refreshable: true,
				activeForCamera: instance.enabled && cameraMatches(instance.cameraFilter, scene.activeCamera),
				activePassCount: scenePasses(scene).filter(
					(pass) => pass.rendererFeature?.instanceId === instance.id && pass.enabled && cameraMatches(instance.cameraFilter, scene.activeCamera)
				).length,
				injectionPoints: Object.fromEntries(
					customRenderPassInjectionPoints.map((point) => [
						point,
						scenePasses(scene).filter((pass) => pass.rendererFeature?.instanceId === instance.id && pass.injectionPoint === point).length,
					])
				),
			});
		} catch (error) {
			diagnostics.push({
				instanceId: instance.id,
				name: instance.name,
				status: "missing",
				assetRevision: instance.assetRevision,
				latestAssetRevision: null,
				refreshable: false,
				activeForCamera: false,
				activePassCount: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return {
		diagnostics: diagnostics.slice(offset, offset + limit),
		page: { total: diagnostics.length, offset, count: Math.max(0, Math.min(limit, diagnostics.length - offset)), hasMore: offset + limit < diagnostics.length },
		activeCameraId: scene.activeCamera?.id ?? null,
	};
}

/** Refreshes one instance from an exact latest asset revision while preserving stable namespace and rejecting broken external references atomically. */
export async function refreshRendererFeatureInstance(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const values = instances(scene);
	const current = resolveInstance(scene, data);
	if (data.revision !== current.revision) {
		throw new Error(`Renderer-feature instance revision is stale. Expected ${current.revision}.`);
	}
	const asset = await readAsset(current.assetPath);
	if (data.expectedAssetRevision !== asset.contentRevision) {
		throw new Error(`Renderer-feature asset revision is stale. Expected ${asset.contentRevision}.`);
	}
	const base = {
		...structuredClone(current),
		revision: current.revision + 1,
		assetId: asset.asset.id,
		assetVersion: 1 as const,
		assetRevision: asset.contentRevision,
	};
	const generated = generatedPasses(asset.asset, base);
	const nextPasses = [...scenePasses(scene).filter((pass) => pass.rendererFeature?.instanceId !== current.id), ...generated.passes];
	const nextInstances = values.map((value) => (value.id === current.id ? generated.mappings : value));
	const preview = publish(scene, nextPasses, nextInstances, options);
	return { instance: structuredClone(generated.mappings), generatedPassIds: generated.passes.map((pass) => pass.id), preview };
}

/** Deletes one exact instance after proving no external pass depends on its namespaced passes or outputs. */
export function deleteRendererFeatureInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a renderer-feature instance requires confirm: true.");
	}
	const values = instances(scene);
	const current = resolveInstance(scene, data);
	if (data.revision !== current.revision) {
		throw new Error(`Renderer-feature instance revision is stale. Expected ${current.revision}.`);
	}
	const passIds = new Set(current.passes.map((pass) => pass.generatedPassId));
	const outputs = new Set(current.outputs.map((output) => output.generatedName));
	const externalReferences = scenePasses(scene)
		.filter((pass) => pass.rendererFeature?.instanceId !== current.id)
		.filter(
			(pass) =>
				pass.dependencies.some((id) => passIds.has(id)) ||
				(pass.copySource.source === "pass" && Boolean(pass.copySource.output && outputs.has(pass.copySource.output))) ||
				Object.values(pass.inputs).some((input) => input.source === "pass" && Boolean(input.output && outputs.has(input.output)))
		)
		.map((pass) => pass.name);
	if (externalReferences.length) {
		throw new Error(`Disconnect external passes before deleting renderer feature "${current.name}": ${externalReferences.join(", ")}.`);
	}
	const preview = publish(
		scene,
		scenePasses(scene).filter((pass) => pass.rendererFeature?.instanceId !== current.id),
		values.filter((value) => value.id !== current.id),
		options
	);
	return { deleted: true, instanceId: current.id, removedPassIds: [...passIds], preview };
}

/** Deletes one unreferenced exact renderer-feature asset revision after literal confirmation. */
export async function deleteRendererFeatureAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a renderer-feature asset requires confirm: true.");
	}
	const value = await readAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Renderer-feature asset revision is stale. Expected ${value.contentRevision}.`);
	}
	const references = instances(scene).filter((instance) => instance.assetPath === value.relativePath || instance.assetId === value.asset.id);
	if (references.length) {
		throw new Error(`Delete renderer-feature instances before deleting this asset: ${references.map((instance) => instance.name).join(", ")}.`);
	}
	await remove(value.absolutePath);
	options.editor.layout.assets.refresh();
	return { deleted: true, path: value.relativePath, id: value.asset.id, contentRevision: value.contentRevision };
}

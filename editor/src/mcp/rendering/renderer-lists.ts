import { Scene, Tools } from "babylonjs";
import {
	applyCustomRenderPassGraph,
	configureRenderingGroups,
	IRendererListDefinition,
	IRenderingGroupDefinition,
	IRenderingLayerDefinition,
	rendererListsMetadataKey,
	renderingGroupsMetadataKey,
	renderingLayersMetadataKey,
	resolveRendererList as resolveSharedRendererList,
	setNativeLightRenderingLayerMasks,
	setNativeRenderingLayerMask,
	validateRendererLists,
	validateRenderingGroups,
	validateRenderingLayers,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { isAbstractMesh, isCamera, isLight } from "../../tools/guards/nodes";
import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

function layers(scene: Scene): IRenderingLayerDefinition[] {
	scene.metadata ??= {};
	const values = validateRenderingLayers(scene.metadata[renderingLayersMetadataKey]);
	scene.metadata[renderingLayersMetadataKey] = values;
	return values;
}

function groups(scene: Scene): IRenderingGroupDefinition[] {
	scene.metadata ??= {};
	const values = validateRenderingGroups(scene.metadata[renderingGroupsMetadataKey]);
	scene.metadata[renderingGroupsMetadataKey] = values;
	return values;
}

function lists(scene: Scene): IRendererListDefinition[] {
	scene.metadata ??= {};
	const values = validateRendererLists(scene.metadata[rendererListsMetadataKey]);
	scene.metadata[rendererListsMetadataKey] = values;
	return values;
}

function layer(scene: Scene, data: any): IRenderingLayerDefinition {
	const value = layers(scene).find((candidate) => candidate.id === data.layerId || candidate.name === data.layerName);
	if (!value) {
		throw new Error("Rendering layer not found. Provide layerId (preferred) or exact layerName.");
	}
	return value;
}

function rendererList(scene: Scene, data: any): IRendererListDefinition {
	const value = lists(scene).find((candidate) => candidate.id === data.rendererListId || candidate.name === data.rendererListName);
	if (!value) {
		throw new Error("Renderer list not found. Provide rendererListId (preferred) or exact rendererListName.");
	}
	return value;
}

function assertRevision(value: { revision: number; name: string }, revision: unknown): void {
	if (revision !== value.revision) {
		throw new Error(`Stale revision for "${value.name}". Expected ${value.revision}.`);
	}
}

function maskFromInput(scene: Scene, data: any): number {
	if (data.mask !== undefined) {
		return data.mask >>> 0;
	}
	const values = data.layerIds as string[];
	const definitions = layers(scene);
	const missing = values.filter((id) => !definitions.some((definition) => definition.id === id));
	if (missing.length) {
		throw new Error(`Unknown rendering layer ids: ${missing.join(", ")}.`);
	}
	return values.reduce((mask, id) => mask | (2 ** definitions.find((definition) => definition.id === id)!.bit), 0) >>> 0;
}

function refreshRendererListPasses(scene: Scene, options: IMCPActionOptions): { applied: boolean; error: string | null } {
	let result = { applied: false, error: null as string | null };
	const passes = (scene.metadata?.babylonEditorCustomRenderPasses ?? []) as any[];
	if (scene.activeCamera && passes.some((pass) => pass.passType === "raster" && pass.rasterSettings?.rendererListId)) {
		try {
			applyCustomRenderPassGraph(scene as any, scene.activeCamera as any, passes, getProjectAssetsRootUrl() ?? "");
			result = { applied: true, error: null };
		} catch (error) {
			result = { applied: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	options.editor.layout.graph.refresh();
	options.editor.layout.inspector.forceUpdate();
	return result;
}

interface IRendererListMutationSnapshot {
	layers: IRenderingLayerDefinition[];
	lists: IRendererListDefinition[];
	meshes: { id: string; layerMask: number; renderingGroupId: number; alphaIndex: number }[];
	cameras: { id: string; layerMask: number }[];
	lights: { id: string; includeMask: number; excludeMask: number }[];
}

function captureMutationSnapshot(scene: Scene): IRendererListMutationSnapshot {
	return {
		layers: structuredClone(layers(scene)),
		lists: structuredClone(lists(scene)),
		meshes: scene.meshes.map((mesh) => ({ id: mesh.id, layerMask: mesh.layerMask >>> 0, renderingGroupId: mesh.renderingGroupId, alphaIndex: mesh.alphaIndex })),
		cameras: scene.cameras.map((camera) => ({ id: camera.id, layerMask: camera.layerMask >>> 0 })),
		lights: scene.lights.map((light) => ({ id: light.id, includeMask: light.includeOnlyWithLayerMask >>> 0, excludeMask: light.excludeWithLayerMask >>> 0 })),
	};
}

function restoreMutationSnapshot(scene: Scene, snapshot: IRendererListMutationSnapshot): void {
	scene.metadata ??= {};
	scene.metadata[renderingLayersMetadataKey] = structuredClone(snapshot.layers);
	scene.metadata[rendererListsMetadataKey] = structuredClone(snapshot.lists);
	for (const state of snapshot.meshes) {
		const mesh = scene.getMeshById(state.id);
		if (mesh) {
			mesh.layerMask = state.layerMask;
			mesh.renderingGroupId = state.renderingGroupId;
			mesh.alphaIndex = state.alphaIndex;
		}
	}
	for (const state of snapshot.cameras) {
		const camera = scene.getCameraById(state.id);
		if (camera) {
			camera.layerMask = state.layerMask;
		}
	}
	for (const state of snapshot.lights) {
		const light = scene.getLightById(state.id);
		if (light) {
			light.includeOnlyWithLayerMask = state.includeMask;
			light.excludeWithLayerMask = state.excludeMask;
		}
	}
}

function mutateAndRefresh<T>(scene: Scene, options: IMCPActionOptions, mutate: () => T): { value: T; runtime: { applied: boolean; error: string | null } } {
	const snapshot = captureMutationSnapshot(scene);
	try {
		const value = mutate();
		const runtime = refreshRendererListPasses(scene, options);
		if (runtime.error) {
			throw new Error(runtime.error);
		}
		return { value, runtime };
	} catch (error) {
		restoreMutationSnapshot(scene, snapshot);
		const rollback = refreshRendererListPasses(scene, options);
		const message = error instanceof Error ? error.message : String(error);
		if (rollback.error) {
			throw new Error(`Renderer-list mutation failed and rollback runtime rebuild also failed: ${message}; rollback: ${rollback.error}`);
		}
		throw new Error(`Renderer-list mutation failed; all layer, list, node, camera, and light changes were rolled back: ${message}`);
	}
}

function defaultGroup(groupId: number): IRenderingGroupDefinition {
	return {
		version: 1,
		groupId,
		name: `Rendering Group ${groupId}`,
		revision: 1,
		autoClearDepthStencil: true,
		clearDepth: true,
		clearStencil: true,
		opaqueSort: "none",
		alphaTestSort: "none",
		transparentSort: "defaultTransparent",
	};
}

/** Lists named 32-bit rendering layers and all four native rendering-group policies. */
export function listRenderingLayers(scene: Scene): any {
	const persistedGroups = groups(scene);
	return {
		layers: structuredClone(layers(scene)),
		groups: [0, 1, 2, 3].map((groupId) => {
			const persisted = persistedGroups.find((group) => group.groupId === groupId);
			return { ...structuredClone(persisted ?? defaultGroup(groupId)), authored: Boolean(persisted) };
		}),
		usage: {
			meshes: scene.meshes.map((mesh) => ({
				id: mesh.id,
				name: mesh.name,
				mask: mesh.layerMask >>> 0,
				renderingGroupId: mesh.renderingGroupId,
				alphaIndex: mesh.alphaIndex,
			})),
			cameras: scene.cameras.map((camera) => ({ id: camera.id, name: camera.name, mask: camera.layerMask >>> 0 })),
			lights: scene.lights.map((light) => ({
				id: light.id,
				name: light.name,
				includeMask: light.includeOnlyWithLayerMask >>> 0,
				excludeMask: light.excludeWithLayerMask >>> 0,
			})),
		},
	};
}

/** Creates one uniquely named rendering-layer bit. */
export function createRenderingLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = layers(scene);
	if (values.length >= 32) {
		throw new Error("Rendering layer limit reached (32).");
	}
	if (values.some((value) => value.name === data.name)) {
		throw new Error(`Rendering layer "${data.name}" already exists.`);
	}
	const usedBits = new Set(values.map((value) => value.bit));
	const bit = data.bit ?? [0, ...Array.from({ length: 31 }, (_, index) => index + 1)].find((candidate) => !usedBits.has(candidate));
	if (bit === undefined || usedBits.has(bit)) {
		throw new Error(`Rendering layer bit ${String(bit)} is already assigned or unavailable.`);
	}
	const value: IRenderingLayerDefinition = { version: 1, id: Tools.RandomId(), name: data.name, revision: 1, bit };
	scene.metadata[renderingLayersMetadataKey] = validateRenderingLayers([...values, value]);
	options.editor.layout.inspector.forceUpdate();
	return { layer: structuredClone(value) };
}

/** Renames a layer or migrates its bit across every current consumer atomically. */
export function setRenderingLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = layers(scene);
	const current = layer(scene, data);
	assertRevision(current, data.revision);
	if (data.name !== undefined && values.some((value) => value.id !== current.id && value.name === data.name)) {
		throw new Error(`Rendering layer "${data.name}" already exists.`);
	}
	const nextBit = data.bit ?? current.bit;
	if (values.some((value) => value.id !== current.id && value.bit === nextBit)) {
		throw new Error(`Rendering layer bit ${nextBit} is already assigned.`);
	}
	if (nextBit !== current.bit && data.migrateAssignments !== true) {
		throw new Error("Changing a layer bit requires migrateAssignments: true.");
	}
	const updated = { ...current, name: data.name ?? current.name, bit: nextBit, revision: current.revision + 1 };
	const transaction = mutateAndRefresh(scene, options, () => {
		const previousMask = 2 ** current.bit;
		const nextMask = 2 ** nextBit;
		const migrate = (mask: number): number => (mask & previousMask ? (mask & ~previousMask) | nextMask : mask) >>> 0;
		if (nextBit !== current.bit) {
			scene.meshes.forEach((mesh) => (mesh.layerMask = migrate(mesh.layerMask)));
			scene.cameras.forEach((camera) => (camera.layerMask = migrate(camera.layerMask)));
			scene.lights.forEach((light) => {
				light.includeOnlyWithLayerMask = migrate(light.includeOnlyWithLayerMask);
				light.excludeWithLayerMask = migrate(light.excludeWithLayerMask);
			});
			const migratedLists = lists(scene).map((list) => ({
				...list,
				includeLayerMask: list.includeLayerMask === null ? null : migrate(list.includeLayerMask),
				excludeLayerMask: migrate(list.excludeLayerMask),
			}));
			scene.metadata[rendererListsMetadataKey] = validateRendererLists(migratedLists);
		}
		scene.metadata[renderingLayersMetadataKey] = validateRenderingLayers(values.map((value) => (value.id === current.id ? updated : value)));
		return updated;
	});
	const runtime = transaction.runtime;
	return { layer: structuredClone(updated), runtime };
}

/** Deletes one named layer and optionally clears its bit from every consumer. */
export function deleteRenderingLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a rendering layer requires confirm: true.");
	}
	const values = layers(scene);
	const current = layer(scene, data);
	assertRevision(current, data.revision);
	const mask = 2 ** current.bit;
	const consumers = [
		...scene.meshes.filter((mesh) => (mesh.layerMask & mask) !== 0).map((mesh) => `mesh:${mesh.id}`),
		...scene.cameras.filter((camera) => (camera.layerMask & mask) !== 0).map((camera) => `camera:${camera.id}`),
		...scene.lights.filter((light) => ((light.includeOnlyWithLayerMask | light.excludeWithLayerMask) & mask) !== 0).map((light) => `light:${light.id}`),
		...lists(scene)
			.filter((list) => ((list.includeLayerMask ?? 0) & mask) !== 0 || (list.excludeLayerMask & mask) !== 0)
			.map((list) => `renderer-list:${list.id}`),
	];
	if (consumers.length && data.clearAssignments !== true) {
		throw new Error(
			`Rendering layer "${current.name}" is in use by ${consumers.slice(0, 16).join(", ")}${consumers.length > 16 ? "…" : ""}; retry with clearAssignments: true.`
		);
	}
	const transaction = mutateAndRefresh(scene, options, () => {
		const clear = (value: number): number => (value & ~mask) >>> 0;
		if (consumers.length) {
			scene.meshes.forEach((mesh) => (mesh.layerMask = clear(mesh.layerMask)));
			scene.cameras.forEach((camera) => (camera.layerMask = clear(camera.layerMask)));
			scene.lights.forEach((light) => {
				light.includeOnlyWithLayerMask = clear(light.includeOnlyWithLayerMask);
				light.excludeWithLayerMask = clear(light.excludeWithLayerMask);
			});
			scene.metadata[rendererListsMetadataKey] = validateRendererLists(
				lists(scene).map((list) => ({
					...list,
					includeLayerMask: list.includeLayerMask === null ? null : clear(list.includeLayerMask),
					excludeLayerMask: clear(list.excludeLayerMask),
				}))
			);
		}
		scene.metadata[renderingLayersMetadataKey] = values.filter((value) => value.id !== current.id);
	});
	const runtime = transaction.runtime;
	return { deleted: true, id: current.id, clearedConsumers: consumers.length, runtime };
}

/** Sets native mesh/camera rendering-layer masks and mesh group/order state. */
export function setNodeRenderingLayers(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isAbstractMesh(node) && !isCamera(node)) {
		throw new Error(`Node "${node.name}" is not a mesh or camera.`);
	}
	const mask = maskFromInput(scene, data);
	const transaction = mutateAndRefresh(scene, options, () => {
		setNativeRenderingLayerMask(node as any, mask);
		if (isAbstractMesh(node)) {
			if (data.renderingGroupId !== undefined) {
				node.renderingGroupId = data.renderingGroupId;
			}
			if (data.alphaIndex !== undefined) {
				node.alphaIndex = data.alphaIndex;
			}
		}
	});
	const runtime = transaction.runtime;
	return {
		nodeId: node.id,
		nodeType: isCamera(node) ? "camera" : "mesh",
		mask: node.layerMask >>> 0,
		renderingGroupId: isAbstractMesh(node) ? node.renderingGroupId : null,
		alphaIndex: isAbstractMesh(node) ? node.alphaIndex : null,
		runtime,
	};
}

/** Sets Babylon light include/exclude layer masks. */
export function setLightRenderingLayers(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}
	const includeMask = data.includeMask !== undefined ? data.includeMask >>> 0 : maskFromInput(scene, { layerIds: data.includeLayerIds });
	const excludeMask = data.excludeMask !== undefined ? data.excludeMask >>> 0 : maskFromInput(scene, { layerIds: data.excludeLayerIds });
	if ((includeMask & excludeMask) !== 0) {
		throw new Error("Light include and exclude rendering-layer masks must not overlap.");
	}
	const transaction = mutateAndRefresh(scene, options, () => setNativeLightRenderingLayerMasks(node as any, includeMask, excludeMask));
	const masks = transaction.value;
	const runtime = transaction.runtime;
	return { nodeId: node.id, ...masks, runtime };
}

/** Sets one native rendering-group clear/sort policy under an exact revision. */
export function setRenderingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = groups(scene);
	const current = values.find((value) => value.groupId === data.groupId) ?? defaultGroup(data.groupId);
	assertRevision(current, data.revision);
	const updated = {
		...current,
		...Object.fromEntries(
			["name", "autoClearDepthStencil", "clearDepth", "clearStencil", "opaqueSort", "alphaTestSort", "transparentSort"]
				.filter((key) => data[key] !== undefined)
				.map((key) => [key, data[key]])
		),
		revision: current.revision + 1,
	};
	scene.metadata[renderingGroupsMetadataKey] = validateRenderingGroups([...values.filter((value) => value.groupId !== data.groupId), updated]);
	configureRenderingGroups(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return { group: { ...structuredClone(updated), authored: true } };
}

/** Removes one authored rendering-group policy and reapplies Babylon defaults. */
export function resetRenderingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Resetting a rendering group requires confirm: true.");
	}
	const values = groups(scene);
	const current = values.find((value) => value.groupId === data.groupId);
	if (!current) {
		throw new Error(`Rendering group ${data.groupId} has no authored policy to reset.`);
	}
	assertRevision(current, data.revision);
	scene.metadata[renderingGroupsMetadataKey] = values.filter((value) => value.groupId !== current.groupId);
	configureRenderingGroups(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return { reset: true, group: { ...defaultGroup(current.groupId), authored: false } };
}

/** Lists reusable renderer-list descriptors with paged resolved counts. */
export function listRendererLists(scene: Scene, data: any = {}): any {
	const values = lists(scene);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 32;
	const page = values.slice(offset, offset + limit).map((value) => {
		try {
			const resolved = resolveSharedRendererList(scene as any, value);
			return { ...structuredClone(value), valid: true, error: null, resolvedMeshCount: resolved.meshes.length, queueCounts: resolved.runtime.queueCounts };
		} catch (error) {
			return { ...structuredClone(value), valid: false, error: error instanceof Error ? error.message : String(error), resolvedMeshCount: 0, queueCounts: null };
		}
	});
	return { lists: page, offset, limit, total: values.length, hasMore: offset + page.length < values.length };
}

/** Creates one reusable renderer-list descriptor. */
export function createRendererList(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = lists(scene);
	if (values.length >= 64) {
		throw new Error("Renderer list limit reached (64).");
	}
	if (values.some((value) => value.name === data.name)) {
		throw new Error(`Renderer list "${data.name}" already exists.`);
	}
	const value: IRendererListDefinition = {
		version: 1,
		id: Tools.RandomId(),
		name: data.name,
		revision: 1,
		enabled: data.enabled ?? true,
		cameraId: data.cameraId ?? null,
		meshIds: data.meshIds ?? [],
		includeDescendants: data.includeDescendants ?? false,
		includeLayerMask: data.includeLayerMask ?? null,
		excludeLayerMask: data.excludeLayerMask ?? 0,
		respectCameraLayerMask: data.respectCameraLayerMask ?? true,
		renderingGroupIds: data.renderingGroupIds ?? [],
		queue: data.queue ?? "all",
		sortMode: data.sortMode ?? "defaultTransparent",
		includeDisabled: data.includeDisabled ?? false,
		includeInvisible: data.includeInvisible ?? false,
	};
	const normalized = validateRendererLists([...values, value]);
	const created = normalized.find((candidate) => candidate.id === value.id)!;
	if (created.enabled) {
		resolveSharedRendererList(scene as any, created);
	}
	scene.metadata[rendererListsMetadataKey] = normalized;
	options.editor.layout.inspector.forceUpdate();
	return { rendererList: structuredClone(created) };
}

/** Updates one renderer list under an exact revision and refreshes every assigned pass. */
export function setRendererList(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = lists(scene);
	const current = rendererList(scene, data);
	assertRevision(current, data.revision);
	if (data.name !== undefined && values.some((value) => value !== current && value.name === data.name)) {
		throw new Error(`Renderer list "${data.name}" already exists.`);
	}
	const fields = [
		"name",
		"enabled",
		"cameraId",
		"meshIds",
		"includeDescendants",
		"includeLayerMask",
		"excludeLayerMask",
		"respectCameraLayerMask",
		"renderingGroupIds",
		"queue",
		"sortMode",
		"includeDisabled",
		"includeInvisible",
	];
	const updated = {
		...current,
		...Object.fromEntries(fields.filter((key) => data[key] !== undefined).map((key) => [key, data[key]])),
		revision: current.revision + 1,
	};
	const normalized = validateRendererLists(values.map((value) => (value.id === current.id ? updated : value)));
	const result = normalized.find((value) => value.id === current.id)!;
	if (result.enabled) {
		resolveSharedRendererList(scene as any, result);
	}
	const transaction = mutateAndRefresh(scene, options, () => {
		scene.metadata[rendererListsMetadataKey] = normalized;
		return result;
	});
	const runtime = transaction.runtime;
	return { rendererList: structuredClone(result), runtime };
}

/** Resolves and pages the exact live draw candidates for one renderer list. */
export function resolveRendererList(scene: Scene, data: any): any {
	const value = rendererList(scene, data);
	const resolved = resolveSharedRendererList(scene as any, value).runtime;
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 128;
	return {
		...structuredClone(resolved),
		meshes: structuredClone(resolved.meshes.slice(offset, offset + limit)),
		offset,
		limit,
		totalMeshes: resolved.meshes.length,
		hasMore: offset + Math.min(limit, resolved.meshes.length - offset) < resolved.meshes.length,
	};
}

/** Deletes one renderer list only when no raster pass still references it. */
export function deleteRendererList(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a renderer list requires confirm: true.");
	}
	const values = lists(scene);
	const current = rendererList(scene, data);
	assertRevision(current, data.revision);
	const references = ((scene.metadata?.babylonEditorCustomRenderPasses ?? []) as any[]).filter((pass) => pass.rasterSettings?.rendererListId === current.id);
	if (references.length) {
		throw new Error(`Renderer list "${current.name}" is referenced by raster passes: ${references.map((pass) => pass.name).join(", ")}.`);
	}
	scene.metadata[rendererListsMetadataKey] = values.filter((value) => value.id !== current.id);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: current.id };
}

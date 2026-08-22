import { Camera } from "@babylonjs/core/Cameras/camera";
import { Light } from "@babylonjs/core/Lights/light";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import { Scene } from "@babylonjs/core/scene";

export const renderingLayersMetadataKey = "babylonEditorRenderingLayers";
export const renderingGroupsMetadataKey = "babylonEditorRenderingGroups";
export const rendererListsMetadataKey = "babylonEditorRendererLists";

export type RenderingQueue = "all" | "opaque" | "alphaTest" | "transparent";
export type RenderingSortMode = "none" | "frontToBack" | "backToFront" | "material" | "defaultTransparent";

export interface IRenderingLayerDefinition {
	version: 1;
	id: string;
	name: string;
	revision: number;
	bit: number;
}

export interface IRenderingGroupDefinition {
	version: 1;
	groupId: number;
	name: string;
	revision: number;
	autoClearDepthStencil: boolean;
	clearDepth: boolean;
	clearStencil: boolean;
	opaqueSort: RenderingSortMode;
	alphaTestSort: RenderingSortMode;
	transparentSort: RenderingSortMode;
}

export interface IRendererListDefinition {
	version: 1;
	id: string;
	name: string;
	revision: number;
	enabled: boolean;
	cameraId: string | null;
	meshIds: string[];
	includeDescendants: boolean;
	includeLayerMask: number | null;
	excludeLayerMask: number;
	respectCameraLayerMask: boolean;
	renderingGroupIds: number[];
	queue: RenderingQueue;
	sortMode: RenderingSortMode;
	includeDisabled: boolean;
	includeInvisible: boolean;
}

export interface IResolvedRendererListMesh {
	id: string;
	name: string;
	layerMask: number;
	renderingGroupId: number;
	alphaIndex: number;
	queues: Exclude<RenderingQueue, "all">[];
}

export interface IResolvedRendererList {
	backend: "bounded-babylon-renderer-list-v1";
	id: string;
	name: string;
	revision: number;
	enabled: boolean;
	cameraId: string | null;
	cameraName: string | null;
	meshes: IResolvedRendererListMesh[];
	queueCounts: Record<Exclude<RenderingQueue, "all">, number>;
	filters: {
		rootMeshIds: string[];
		includeDescendants: boolean;
		includeLayerMask: number | null;
		excludeLayerMask: number;
		respectCameraLayerMask: boolean;
		renderingGroupIds: number[];
		queue: RenderingQueue;
		sortMode: RenderingSortMode;
		includeDisabled: boolean;
		includeInvisible: boolean;
	};
}

const queueValues: RenderingQueue[] = ["all", "opaque", "alphaTest", "transparent"];
const sortValues: RenderingSortMode[] = ["none", "frontToBack", "backToFront", "material", "defaultTransparent"];

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
}

function boundedString(value: unknown, label: string, maximum = 128): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters.`);
	}
	return value;
}

function boolean(value: unknown, label: string, fallback?: boolean): boolean {
	if (value === undefined && fallback !== undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value as number;
}

function unsignedMask(value: unknown, label: string, nullable = false): number | null {
	if (nullable && value === null) {
		return null;
	}
	return integer(value, label, 0, 4_294_967_295) >>> 0;
}

function normalizeUniqueStrings(value: unknown, label: string, maximum: number): string[] {
	if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 256)) {
		throw new Error(`${label} must contain at most ${maximum} bounded non-empty strings.`);
	}
	if (new Set(value).size !== value.length) {
		throw new Error(`${label} must not contain duplicates.`);
	}
	return [...value];
}

function normalizeLayer(value: unknown, index: number): IRenderingLayerDefinition {
	const entry = object(value, `Rendering layer ${index}`);
	rejectUnknownKeys(entry, ["version", "id", "name", "revision", "bit"], `Rendering layer ${index}`);
	return {
		version: integer(entry.version ?? 1, `Rendering layer ${index} version`, 1, 1) as 1,
		id: boundedString(entry.id, `Rendering layer ${index} id`),
		name: boundedString(entry.name, `Rendering layer ${index} name`),
		revision: integer(entry.revision, `Rendering layer ${index} revision`, 1, Number.MAX_SAFE_INTEGER),
		bit: integer(entry.bit, `Rendering layer ${index} bit`, 0, 31),
	};
}

/** Validates the project-visible names assigned to Babylon's native 32-bit layer mask. */
export function validateRenderingLayers(value: unknown): IRenderingLayerDefinition[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 32) {
		throw new Error("Rendering layers must be an array with at most 32 entries.");
	}
	const layers = value.map(normalizeLayer);
	for (const field of ["id", "name", "bit"] as const) {
		const values = layers.map((layer) => layer[field]);
		if (new Set(values).size !== values.length) {
			throw new Error(`Rendering layer ${field} values must be unique.`);
		}
	}
	return layers;
}

function normalizeSort(value: unknown, label: string, fallback: RenderingSortMode): RenderingSortMode {
	const result = value ?? fallback;
	if (!sortValues.includes(result as RenderingSortMode)) {
		throw new Error(`${label} has an unsupported sort mode.`);
	}
	return result as RenderingSortMode;
}

function normalizeGroup(value: unknown, index: number): IRenderingGroupDefinition {
	const entry = object(value, `Rendering group ${index}`);
	rejectUnknownKeys(
		entry,
		["version", "groupId", "name", "revision", "autoClearDepthStencil", "clearDepth", "clearStencil", "opaqueSort", "alphaTestSort", "transparentSort"],
		`Rendering group ${index}`
	);
	return {
		version: integer(entry.version ?? 1, `Rendering group ${index} version`, 1, 1) as 1,
		groupId: integer(entry.groupId, `Rendering group ${index} groupId`, 0, 3),
		name: boundedString(entry.name, `Rendering group ${index} name`),
		revision: integer(entry.revision, `Rendering group ${index} revision`, 1, Number.MAX_SAFE_INTEGER),
		autoClearDepthStencil: boolean(entry.autoClearDepthStencil, `Rendering group ${index} autoClearDepthStencil`, true),
		clearDepth: boolean(entry.clearDepth, `Rendering group ${index} clearDepth`, true),
		clearStencil: boolean(entry.clearStencil, `Rendering group ${index} clearStencil`, true),
		opaqueSort: normalizeSort(entry.opaqueSort, `Rendering group ${index} opaqueSort`, "none"),
		alphaTestSort: normalizeSort(entry.alphaTestSort, `Rendering group ${index} alphaTestSort`, "none"),
		transparentSort: normalizeSort(entry.transparentSort, `Rendering group ${index} transparentSort`, "defaultTransparent"),
	};
}

/** Validates the four native Babylon rendering-group policies. */
export function validateRenderingGroups(value: unknown): IRenderingGroupDefinition[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 4) {
		throw new Error("Rendering groups must be an array with at most 4 entries.");
	}
	const groups = value.map(normalizeGroup);
	if (new Set(groups.map((group) => group.groupId)).size !== groups.length) {
		throw new Error("Rendering group ids must be unique.");
	}
	return groups;
}

function normalizeRendererList(value: unknown, index: number): IRendererListDefinition {
	const entry = object(value, `Renderer list ${index}`);
	rejectUnknownKeys(
		entry,
		[
			"version",
			"id",
			"name",
			"revision",
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
		],
		`Renderer list ${index}`
	);
	const cameraId = entry.cameraId ?? null;
	if (cameraId !== null && (typeof cameraId !== "string" || !cameraId.trim() || cameraId.length > 256)) {
		throw new Error(`Renderer list ${index} cameraId must be null or a bounded non-empty string.`);
	}
	const renderingGroupIds = entry.renderingGroupIds ?? [];
	if (!Array.isArray(renderingGroupIds) || renderingGroupIds.length > 4) {
		throw new Error(`Renderer list ${index} renderingGroupIds must contain at most four entries.`);
	}
	const normalizedGroups = renderingGroupIds.map((groupId, groupIndex) => integer(groupId, `Renderer list ${index} renderingGroupIds[${groupIndex}]`, 0, 3));
	if (new Set(normalizedGroups).size !== normalizedGroups.length) {
		throw new Error(`Renderer list ${index} renderingGroupIds must be unique.`);
	}
	const queue = entry.queue ?? "all";
	if (!queueValues.includes(queue as RenderingQueue)) {
		throw new Error(`Renderer list ${index} queue is unsupported.`);
	}
	return {
		version: integer(entry.version ?? 1, `Renderer list ${index} version`, 1, 1) as 1,
		id: boundedString(entry.id, `Renderer list ${index} id`),
		name: boundedString(entry.name, `Renderer list ${index} name`),
		revision: integer(entry.revision, `Renderer list ${index} revision`, 1, Number.MAX_SAFE_INTEGER),
		enabled: boolean(entry.enabled, `Renderer list ${index} enabled`, true),
		cameraId,
		meshIds: normalizeUniqueStrings(entry.meshIds ?? [], `Renderer list ${index} meshIds`, 4096),
		includeDescendants: boolean(entry.includeDescendants, `Renderer list ${index} includeDescendants`, false),
		includeLayerMask: unsignedMask(entry.includeLayerMask ?? null, `Renderer list ${index} includeLayerMask`, true),
		excludeLayerMask: unsignedMask(entry.excludeLayerMask ?? 0, `Renderer list ${index} excludeLayerMask`)!,
		respectCameraLayerMask: boolean(entry.respectCameraLayerMask, `Renderer list ${index} respectCameraLayerMask`, true),
		renderingGroupIds: normalizedGroups,
		queue: queue as RenderingQueue,
		sortMode: normalizeSort(entry.sortMode, `Renderer list ${index} sortMode`, "defaultTransparent"),
		includeDisabled: boolean(entry.includeDisabled, `Renderer list ${index} includeDisabled`, false),
		includeInvisible: boolean(entry.includeInvisible, `Renderer list ${index} includeInvisible`, false),
	};
}

/** Validates reusable, versioned renderer-list descriptors. */
export function validateRendererLists(value: unknown): IRendererListDefinition[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 64) {
		throw new Error("Renderer lists must be an array with at most 64 entries.");
	}
	const lists = value.map(normalizeRendererList);
	for (const field of ["id", "name"] as const) {
		const values = lists.map((list) => list[field]);
		if (new Set(values).size !== values.length) {
			throw new Error(`Renderer list ${field} values must be unique.`);
		}
	}
	return lists;
}

function sortComparator(mode: RenderingSortMode): ((first: any, second: any) => number) | null {
	if (mode === "frontToBack") {
		return RenderingGroup.frontToBackSortCompare;
	}
	if (mode === "backToFront") {
		return RenderingGroup.backToFrontSortCompare;
	}
	if (mode === "material") {
		return RenderingGroup.PainterSortCompare;
	}
	if (mode === "defaultTransparent") {
		return RenderingGroup.defaultTransparentSortCompare;
	}
	return null;
}

/** Applies persisted sorting and depth/stencil-clear policies to Babylon's four native rendering groups. */
export function configureRenderingGroups(scene: Scene): IRenderingGroupDefinition[] {
	scene.metadata ??= {};
	const groups = validateRenderingGroups(scene.metadata[renderingGroupsMetadataKey]);
	scene.metadata[renderingGroupsMetadataKey] = groups;
	for (let groupId = 0; groupId < 4; groupId++) {
		const group = groups.find((candidate) => candidate.groupId === groupId);
		scene.setRenderingOrder(
			groupId,
			sortComparator(group?.opaqueSort ?? "none"),
			sortComparator(group?.alphaTestSort ?? "none"),
			sortComparator(group?.transparentSort ?? "defaultTransparent")
		);
		scene.setRenderingAutoClearDepthStencil(groupId, group?.autoClearDepthStencil ?? true, group?.clearDepth ?? true, group?.clearStencil ?? true);
	}
	return structuredClone(groups);
}

function queuesForMesh(mesh: AbstractMesh): Exclude<RenderingQueue, "all">[] {
	const queues = new Set<Exclude<RenderingQueue, "all">>();
	for (const subMesh of mesh.subMeshes ?? []) {
		const material = subMesh.getMaterial();
		if (!material) {
			continue;
		}
		if (material.needAlphaBlendingForMesh(mesh)) {
			queues.add("transparent");
		} else if (material.needAlphaTestingForMesh(mesh)) {
			queues.add("alphaTest");
		} else {
			queues.add("opaque");
		}
	}
	if (!queues.size) {
		queues.add("opaque");
	}
	return [...queues];
}

/** Resolves one renderer list against current scene/camera/mesh state without mutating it. */
export function resolveRendererList(
	scene: Scene,
	definition: IRendererListDefinition,
	defaultCamera?: Camera | null
): { runtime: IResolvedRendererList; camera: Camera | null; meshes: AbstractMesh[] } {
	const camera = definition.cameraId ? scene.getCameraById(definition.cameraId) : (defaultCamera ?? scene.activeCamera);
	if (definition.cameraId && !camera) {
		throw new Error(`Renderer list "${definition.name}" references missing camera "${definition.cameraId}".`);
	}
	const missingMeshIds = definition.meshIds.filter((id) => !scene.getMeshById(id));
	if (missingMeshIds.length) {
		throw new Error(`Renderer list "${definition.name}" references missing mesh ids: ${missingMeshIds.join(", ")}.`);
	}
	const selected = definition.meshIds.length ? definition.meshIds.map((id) => scene.getMeshById(id)!) : [...scene.meshes];
	if (definition.includeDescendants && definition.meshIds.length) {
		for (const mesh of [...selected]) {
			selected.push(...mesh.getChildMeshes(false));
		}
	}
	const unique = [...new Map(selected.map((mesh) => [mesh.id, mesh])).values()];
	const entries = unique
		.map((mesh) => ({ mesh, queues: queuesForMesh(mesh) }))
		.filter(({ mesh, queues }) => {
			const layerMask = mesh.layerMask >>> 0;
			if (!definition.includeDisabled && !mesh.isEnabled()) {
				return false;
			}
			if (!definition.includeInvisible && (!mesh.isVisible || mesh.visibility <= 0)) {
				return false;
			}
			if (definition.includeLayerMask !== null && (layerMask & definition.includeLayerMask) === 0) {
				return false;
			}
			if (definition.excludeLayerMask !== 0 && (layerMask & definition.excludeLayerMask) !== 0) {
				return false;
			}
			if (definition.respectCameraLayerMask && camera && (layerMask & (camera.layerMask >>> 0)) === 0) {
				return false;
			}
			if (definition.renderingGroupIds.length && !definition.renderingGroupIds.includes(mesh.renderingGroupId)) {
				return false;
			}
			if (definition.queue !== "all" && !queues.includes(definition.queue)) {
				return false;
			}
			return true;
		});
	const meshes = entries.map((entry) => entry.mesh);
	const runtimeMeshes = entries.map(({ mesh, queues }) => ({
		id: mesh.id,
		name: mesh.name,
		layerMask: mesh.layerMask >>> 0,
		renderingGroupId: mesh.renderingGroupId,
		alphaIndex: mesh.alphaIndex,
		queues,
	}));
	return {
		camera,
		meshes,
		runtime: {
			backend: "bounded-babylon-renderer-list-v1",
			id: definition.id,
			name: definition.name,
			revision: definition.revision,
			enabled: definition.enabled,
			cameraId: camera?.id ?? null,
			cameraName: camera?.name ?? null,
			meshes: runtimeMeshes,
			queueCounts: {
				opaque: runtimeMeshes.filter((mesh) => mesh.queues.includes("opaque")).length,
				alphaTest: runtimeMeshes.filter((mesh) => mesh.queues.includes("alphaTest")).length,
				transparent: runtimeMeshes.filter((mesh) => mesh.queues.includes("transparent")).length,
			},
			filters: {
				rootMeshIds: [...definition.meshIds],
				includeDescendants: definition.includeDescendants,
				includeLayerMask: definition.includeLayerMask,
				excludeLayerMask: definition.excludeLayerMask,
				respectCameraLayerMask: definition.respectCameraLayerMask,
				renderingGroupIds: [...definition.renderingGroupIds],
				queue: definition.queue,
				sortMode: definition.sortMode,
				includeDisabled: definition.includeDisabled,
				includeInvisible: definition.includeInvisible,
			},
		},
	};
}

/** Validates all persisted layer/list state and reapplies native group policies. */
export function configureRendererLists(scene: Scene): { layers: IRenderingLayerDefinition[]; groups: IRenderingGroupDefinition[]; lists: IRendererListDefinition[] } {
	scene.metadata ??= {};
	const layers = validateRenderingLayers(scene.metadata[renderingLayersMetadataKey]);
	const lists = validateRendererLists(scene.metadata[rendererListsMetadataKey]);
	scene.metadata[renderingLayersMetadataKey] = layers;
	scene.metadata[rendererListsMetadataKey] = lists;
	const groups = configureRenderingGroups(scene);
	for (const list of lists) {
		if (list.enabled) {
			resolveRendererList(scene, list);
		}
	}
	return { layers: structuredClone(layers), groups, lists: structuredClone(lists) };
}

/** Applies a named layer mask to a mesh or camera through Babylon's native layerMask. */
export function setNativeRenderingLayerMask(target: AbstractMesh | Camera, mask: number): number {
	target.layerMask = unsignedMask(mask, "Rendering layer mask")!;
	return target.layerMask >>> 0;
}

/** Applies include/exclude rendering-layer masks to a Babylon light. */
export function setNativeLightRenderingLayerMasks(light: Light, includeMask: number, excludeMask: number): { includeMask: number; excludeMask: number } {
	light.includeOnlyWithLayerMask = unsignedMask(includeMask, "Light include mask")!;
	light.excludeWithLayerMask = unsignedMask(excludeMask, "Light exclude mask")!;
	return { includeMask: light.includeOnlyWithLayerMask >>> 0, excludeMask: light.excludeWithLayerMask >>> 0 };
}

import { createHash, randomUUID } from "crypto";
import { readFile, lstat, realpath, stat } from "fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "path/posix";
import { pathToFileURL } from "url";

import { Color3, Color4, Light, Material, MultiMaterial, PBRMaterial, Scene } from "babylonjs";
import { lightProbeVolumesMetadataKey, validateLightProbeVolumes } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";
import { readBakedGlobalIlluminationManifest } from "./baked-gi";
import { listReflectionProbes } from "./lights";

export const lightingSearchMetadataKey = "babylonEditorLightingSearch";
export const lightingSearchProviders = ["lights", "mesh-renderers", "lightmaps", "reflection-probes", "probe-volumes", "materials", "lighting-settings"] as const;
export const lightingSearchPipelines = ["all", "native-forward", "clustered-forward", "portable-deferred", "baked-gi"] as const;
export const lightingSearchOperators = ["eq", "ne", "contains", "gt", "gte", "lt", "lte"] as const;

export type LightingSearchProvider = (typeof lightingSearchProviders)[number];
export type LightingSearchPipeline = (typeof lightingSearchPipelines)[number];
export type LightingSearchOperator = (typeof lightingSearchOperators)[number];

export interface ILightingSearchFilter {
	field: string;
	operator: LightingSearchOperator;
	value: string | number | boolean;
}

export interface ILightingSearchCustomQuery {
	version: 1;
	id: string;
	name: string;
	parentId: string | null;
	revision: number;
	provider: LightingSearchProvider;
	search: string;
	pipeline: LightingSearchPipeline;
	filters: ILightingSearchFilter[];
	columns: string[];
}

export interface ILightingSearchState {
	version: 1;
	revision: number;
	customQueries: ILightingSearchCustomQuery[];
}

export interface ILightingSearchItem {
	provider: LightingSearchProvider;
	id: string;
	name: string;
	type: string;
	pipelines: Exclude<LightingSearchPipeline, "all">[];
	properties: Record<string, unknown>;
	editableProperties: string[];
	fingerprint: string;
}

interface ILightingSearchQueryNode {
	id: string;
	parentId: string | null;
	name: string;
	kind: "folder" | "query";
	builtIn: boolean;
	revision: number | null;
	provider: LightingSearchProvider | null;
	search: string;
	pipeline: LightingSearchPipeline;
	filters: ILightingSearchFilter[];
	columns: string[];
}

const maximumCustomQueries = 128;
const maximumFilters = 16;
const maximumColumns = 24;
const maximumPreviewBytes = 64 * 1024 * 1024;
const fieldPattern = /^[A-Za-z][A-Za-z0-9]*$/;

function defaultState(): ILightingSearchState {
	return { version: 1, revision: 1, customQueries: [] };
}

function boundedText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
		throw new Error(`${field} must be ${allowEmpty ? "a" : "a non-empty"} string no longer than ${maximum} characters.`);
	}
	return allowEmpty ? value : value.trim();
}

function validateFilter(value: unknown, field: string): ILightingSearchFilter {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object.`);
	}
	const source = value as Record<string, unknown>;
	const unknown = Object.keys(source).filter((key) => !["field", "operator", "value"].includes(key));
	if (unknown.length) {
		throw new Error(`${field} contains unsupported fields: ${unknown.join(", ")}.`);
	}
	const filterField = boundedText(source.field, `${field}.field`, 64);
	if (!fieldPattern.test(filterField)) {
		throw new Error(`${field}.field must start with a letter and contain only letters or digits.`);
	}
	if (!lightingSearchOperators.includes(source.operator as LightingSearchOperator)) {
		throw new Error(`${field}.operator is unsupported.`);
	}
	if (!["string", "number", "boolean"].includes(typeof source.value) || (typeof source.value === "number" && !Number.isFinite(source.value))) {
		throw new Error(`${field}.value must be a bounded string, finite number, or Boolean.`);
	}
	if (typeof source.value === "string" && source.value.length > 256) {
		throw new Error(`${field}.value strings must be no longer than 256 characters.`);
	}
	return { field: filterField, operator: source.operator as LightingSearchOperator, value: source.value as string | number | boolean };
}

function validateFilters(value: unknown, field = "filters"): ILightingSearchFilter[] {
	if (!Array.isArray(value) || value.length > maximumFilters) {
		throw new Error(`${field} must contain at most ${maximumFilters} filters.`);
	}
	return value.map((entry, index) => validateFilter(entry, `${field}[${index}]`));
}

function validateColumns(value: unknown, field = "columns"): string[] {
	if (!Array.isArray(value) || value.length > maximumColumns) {
		throw new Error(`${field} must contain at most ${maximumColumns} column names.`);
	}
	const columns = value.map((entry, index) => {
		const column = boundedText(entry, `${field}[${index}]`, 64);
		if (!fieldPattern.test(column)) {
			throw new Error(`${field}[${index}] must start with a letter and contain only letters or digits.`);
		}
		return column;
	});
	if (new Set(columns).size !== columns.length) {
		throw new Error(`${field} must not contain duplicates.`);
	}
	return columns;
}

function validateCustomQuery(value: unknown, index: number): ILightingSearchCustomQuery {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Lighting Search query ${index} must be an object.`);
	}
	const source = value as Record<string, unknown>;
	const allowed = ["version", "id", "name", "parentId", "revision", "provider", "search", "pipeline", "filters", "columns"];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Lighting Search query ${index} contains unsupported fields: ${unknown.join(", ")}.`);
	}
	if ((source.version ?? 1) !== 1 || !Number.isInteger(source.revision) || (source.revision as number) < 1) {
		throw new Error(`Lighting Search query ${index} requires version 1 and a positive revision.`);
	}
	if (!lightingSearchProviders.includes(source.provider as LightingSearchProvider) || !lightingSearchPipelines.includes(source.pipeline as LightingSearchPipeline)) {
		throw new Error(`Lighting Search query ${index} has an unsupported provider or pipeline.`);
	}
	return {
		version: 1,
		id: boundedText(source.id, `Lighting Search query ${index} id`, 128),
		name: boundedText(source.name, `Lighting Search query ${index} name`, 128),
		parentId: source.parentId === null || source.parentId === undefined ? null : boundedText(source.parentId, `Lighting Search query ${index} parentId`, 128),
		revision: source.revision as number,
		provider: source.provider as LightingSearchProvider,
		search: boundedText(source.search ?? "", `Lighting Search query ${index} search`, 512, true),
		pipeline: source.pipeline as LightingSearchPipeline,
		filters: validateFilters(source.filters ?? [], `Lighting Search query ${index} filters`),
		columns: validateColumns(source.columns ?? [], `Lighting Search query ${index} columns`),
	};
}

function validateState(value: unknown): ILightingSearchState {
	if (value === undefined || value === null) {
		return defaultState();
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Lighting Search state must be an object.");
	}
	const source = value as Record<string, unknown>;
	const unknown = Object.keys(source).filter((key) => !["version", "revision", "customQueries"].includes(key));
	if (unknown.length || source.version !== 1 || !Number.isInteger(source.revision) || (source.revision as number) < 1) {
		throw new Error("Lighting Search state is malformed or uses an unsupported version.");
	}
	if (!Array.isArray(source.customQueries) || source.customQueries.length > maximumCustomQueries) {
		throw new Error(`Lighting Search state supports at most ${maximumCustomQueries} custom queries.`);
	}
	const customQueries = source.customQueries.map(validateCustomQuery);
	if (new Set(customQueries.map((query) => query.id)).size !== customQueries.length) {
		throw new Error("Lighting Search custom query ids must be unique.");
	}
	return { version: 1, revision: source.revision as number, customQueries };
}

function readState(scene: Scene): ILightingSearchState {
	return validateState(scene.metadata?.[lightingSearchMetadataKey]);
}

function stateFingerprint(state: ILightingSearchState): string {
	return `lighting-search-sha256-v1:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`;
}

function itemFingerprint(provider: LightingSearchProvider, id: string, values: unknown): string {
	return `lighting-search-item-sha256-v1:${createHash("sha256")
		.update(JSON.stringify([provider, id, values]))
		.digest("hex")}`;
}

function refreshUI(options: IMCPActionOptions): void {
	void options.editor.layout.lightingSearch?.refresh?.();
	void options.editor.layout.graph?.refresh?.();
	options.editor.layout.inspector?.forceUpdate?.();
}

function publishState(scene: Scene, state: ILightingSearchState, options: IMCPActionOptions): ILightingSearchState {
	const before = scene.metadata?.[lightingSearchMetadataKey] ? structuredClone(scene.metadata[lightingSearchMetadataKey]) : null;
	const after = validateState(state);
	scene.metadata ??= {};
	scene.metadata[lightingSearchMetadataKey] = structuredClone(after);
	registerUndoRedo({
		undo: () => {
			if (before) {
				scene.metadata![lightingSearchMetadataKey] = structuredClone(before);
			} else {
				delete scene.metadata![lightingSearchMetadataKey];
			}
		},
		redo: () => (scene.metadata![lightingSearchMetadataKey] = structuredClone(after)),
		action: () => refreshUI(options),
	});
	refreshUI(options);
	return after;
}

function assertStateLease(state: ILightingSearchState, data: Record<string, unknown>): void {
	const fingerprint = stateFingerprint(state);
	if (data.expectedRevision !== state.revision || data.expectedFingerprint !== fingerprint) {
		throw new Error(`Lighting Search query tree changed. Inspect it again and use expectedRevision ${state.revision} with expectedFingerprint "${fingerprint}".`);
	}
}

const builtInQueryTree: ILightingSearchQueryNode[] = [
	{ id: "lights", parentId: null, name: "Lights", kind: "folder", builtIn: true, revision: null, provider: null, search: "", pipeline: "all", filters: [], columns: [] },
	{
		id: "lights-all",
		parentId: "lights",
		name: "All Lights",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "lights",
		search: "",
		pipeline: "all",
		filters: [],
		columns: ["name", "type", "enabled", "intensity", "shadowed", "clustered"],
	},
	{
		id: "lights-shadowed",
		parentId: "lights",
		name: "Shadowed Lights",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "lights",
		search: "",
		pipeline: "native-forward",
		filters: [{ field: "shadowed", operator: "eq", value: true }],
		columns: ["name", "type", "intensity", "shadowed"],
	},
	{
		id: "lights-clustered",
		parentId: "lights",
		name: "Clustered Lights",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "lights",
		search: "",
		pipeline: "clustered-forward",
		filters: [{ field: "clustered", operator: "eq", value: true }],
		columns: ["name", "type", "intensity", "range"],
	},
	{ id: "renderers", parentId: null, name: "Renderers", kind: "folder", builtIn: true, revision: null, provider: null, search: "", pipeline: "all", filters: [], columns: [] },
	{
		id: "renderers-all",
		parentId: "renderers",
		name: "All Mesh Renderers",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "mesh-renderers",
		search: "",
		pipeline: "all",
		filters: [],
		columns: ["name", "enabled", "visibility", "receiveShadows", "lightmapped"],
	},
	{
		id: "renderers-lightmapped",
		parentId: "renderers",
		name: "Lightmapped Renderers",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "mesh-renderers",
		search: "",
		pipeline: "baked-gi",
		filters: [{ field: "lightmapped", operator: "eq", value: true }],
		columns: ["name", "materialName", "lightmapped", "receiveShadows"],
	},
	{ id: "lightmaps", parentId: null, name: "Lightmaps", kind: "folder", builtIn: true, revision: null, provider: null, search: "", pipeline: "all", filters: [], columns: [] },
	{
		id: "lightmaps-all",
		parentId: "lightmaps",
		name: "Baked Lightmaps",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "lightmaps",
		search: "",
		pipeline: "baked-gi",
		filters: [],
		columns: ["name", "index", "width", "height", "format", "compression", "coveragePercent", "overlapTexels"],
	},
	{
		id: "lightmaps-overlap",
		parentId: "lightmaps",
		name: "UV Overlaps",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "lightmaps",
		search: "",
		pipeline: "baked-gi",
		filters: [{ field: "overlapTexels", operator: "gt", value: 0 }],
		columns: ["name", "overlapTexels", "coveredTexels", "uvSource"],
	},
	{ id: "probes", parentId: null, name: "Probes", kind: "folder", builtIn: true, revision: null, provider: null, search: "", pipeline: "all", filters: [], columns: [] },
	{
		id: "reflection-probes-all",
		parentId: "probes",
		name: "Reflection Probes",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "reflection-probes",
		search: "",
		pipeline: "all",
		filters: [],
		columns: ["name", "size", "ready", "importance", "blendDistance"],
	},
	{
		id: "probe-volumes-all",
		parentId: "probes",
		name: "Adaptive Probe Volumes",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "probe-volumes",
		search: "",
		pipeline: "baked-gi",
		filters: [],
		columns: ["name", "enabled", "priority", "probeCount", "cellCount"],
	},
	{ id: "materials", parentId: null, name: "Materials", kind: "folder", builtIn: true, revision: null, provider: null, search: "", pipeline: "all", filters: [], columns: [] },
	{
		id: "materials-emissive",
		parentId: "materials",
		name: "Emissive Materials",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "materials",
		search: "",
		pipeline: "all",
		filters: [{ field: "emissive", operator: "eq", value: true }],
		columns: ["name", "type", "emissive", "emissiveIntensity", "lightmapped"],
	},
	{ id: "settings", parentId: null, name: "Settings", kind: "folder", builtIn: true, revision: null, provider: null, search: "", pipeline: "all", filters: [], columns: [] },
	{
		id: "lighting-settings",
		parentId: "settings",
		name: "Scene Lighting Settings",
		kind: "query",
		builtIn: true,
		revision: null,
		provider: "lighting-settings",
		search: "",
		pipeline: "all",
		filters: [],
		columns: ["name", "environmentIntensity", "fogEnabled"],
	},
];

function customQueryNode(query: ILightingSearchCustomQuery): ILightingSearchQueryNode {
	return { ...structuredClone(query), kind: "query", builtIn: false };
}

/** Reads capabilities, exact query-tree lease, built-in queries, and persisted project queries. */
export function inspectLightingSearch(scene: Scene): Record<string, unknown> {
	const state = readState(scene);
	return {
		version: 1,
		backend: "bounded-babylon-lighting-search-v1",
		state: structuredClone(state),
		fingerprint: stateFingerprint(state),
		providers: [...lightingSearchProviders],
		pipelines: [...lightingSearchPipelines],
		operators: [...lightingSearchOperators],
		bounds: {
			customQueries: maximumCustomQueries,
			filtersPerQuery: maximumFilters,
			columnsPerQuery: maximumColumns,
			pageSize: 100,
			previewBytes: maximumPreviewBytes,
			exposureEV: [-16, 16],
		},
		queryTree: [...builtInQueryTree.map((entry) => structuredClone(entry)), ...state.customQueries.map(customQueryNode)],
		editableProviders: ["lights", "mesh-renderers", "materials", "lighting-settings"],
		limitations: [
			"Portable Babylon providers and pipelines; no Unity Search, URP, HDRP, or Progressive Lightmapper API identity.",
			"Generated or assigned project-contained 2D lightmaps are previewable; engine-private and remote texture sources are read-only metadata.",
		],
	};
}

/** Creates or updates one custom exact-leased query-tree node. */
export function saveLightingSearchQuery(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const state = readState(scene);
	assertStateLease(state, data);
	const input = data.query as Record<string, unknown>;
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("query must be an object.");
	}
	const unknownQueryFields = Object.keys(input).filter((key) => !["name", "parentId", "provider", "search", "pipeline", "filters", "columns"].includes(key));
	if (unknownQueryFields.length) {
		throw new Error(`query contains unsupported fields: ${unknownQueryFields.join(", ")}.`);
	}
	const id = data.id ? boundedText(data.id, "id", 128) : randomUUID();
	const current = state.customQueries.find((query) => query.id === id);
	if (current && data.expectedQueryRevision !== current.revision) {
		throw new Error(`Lighting Search query "${current.name}" changed. Retry with expectedQueryRevision ${current.revision}.`);
	}
	if (!current && data.expectedQueryRevision !== undefined) {
		throw new Error("expectedQueryRevision is valid only when updating an existing custom query.");
	}
	if (!current && state.customQueries.length >= maximumCustomQueries) {
		throw new Error(`Lighting Search supports at most ${maximumCustomQueries} custom queries.`);
	}
	const candidate = validateCustomQuery(
		{
			version: 1,
			id,
			name: input.name,
			parentId: input.parentId ?? null,
			revision: (current?.revision ?? 0) + 1,
			provider: input.provider,
			search: input.search ?? "",
			pipeline: input.pipeline ?? "all",
			filters: input.filters ?? [],
			columns: input.columns ?? [],
		},
		current ? state.customQueries.indexOf(current) : state.customQueries.length
	);
	if (builtInQueryTree.some((entry) => entry.id === candidate.id)) {
		throw new Error(`Custom query id "${candidate.id}" conflicts with an immutable built-in query.`);
	}
	if (candidate.parentId && !builtInQueryTree.some((entry) => entry.id === candidate.parentId && entry.kind === "folder")) {
		throw new Error("Custom queries may be placed only below an immutable built-in folder id or at the root.");
	}
	const next: ILightingSearchState = {
		version: 1,
		revision: state.revision + 1,
		customQueries: current ? state.customQueries.map((query) => (query.id === id ? candidate : query)) : [...state.customQueries, candidate],
	};
	const published = publishState(scene, next, options);
	return { query: structuredClone(candidate), state: published, fingerprint: stateFingerprint(published), created: !current };
}

/** Deletes one custom query; immutable built-ins cannot be removed. */
export function deleteLightingSearchQuery(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	if (data.confirm !== true) {
		throw new Error("Deleting a custom Lighting Search query requires confirm=true.");
	}
	const state = readState(scene);
	assertStateLease(state, data);
	const id = boundedText(data.id, "id", 128);
	const current = state.customQueries.find((query) => query.id === id);
	if (!current) {
		if (builtInQueryTree.some((entry) => entry.id === id)) {
			throw new Error(`Built-in Lighting Search query "${id}" is immutable.`);
		}
		throw new Error(`Custom Lighting Search query "${id}" was not found.`);
	}
	if (data.expectedQueryRevision !== current.revision) {
		throw new Error(`Lighting Search query "${current.name}" changed. Retry with expectedQueryRevision ${current.revision}.`);
	}
	const next = publishState(scene, { version: 1, revision: state.revision + 1, customQueries: state.customQueries.filter((query) => query.id !== id) }, options);
	return { deleted: true, id, name: current.name, revision: current.revision, state: next, fingerprint: stateFingerprint(next) };
}

function color3(value: Color3 | undefined): number[] | null {
	return value ? value.asArray() : null;
}

function materialLeaves(material: Material | null): Material[] {
	return material instanceof MultiMaterial ? material.subMaterials.filter((entry): entry is Material => Boolean(entry)) : material ? [material] : [];
}

function materialLightmap(material: Material | null): any | null {
	return (
		materialLeaves(material)
			.map((entry) => (entry as any).lightmapTexture)
			.find(Boolean) ?? null
	);
}

function lightItems(scene: Scene, options?: IMCPActionOptions): ILightingSearchItem[] {
	const clustered = ((options?.editor.layout.preview?.clusteredLightContainer?.lights ?? []) as Light[]).filter(Boolean);
	const clusteredSet = new Set(clustered);
	const lights = [...scene.lights, ...clustered.filter((light) => !scene.lights.includes(light))];
	return lights.map((light) => {
		const source = light as any;
		const values = {
			name: light.name,
			enabled: light.isEnabled(),
			intensity: source.intensity ?? 1,
			diffuse: color3(source.diffuse),
			specular: color3(source.specular),
			range: Number.isFinite(source.range) ? source.range : null,
			angle: Number.isFinite(source.angle) ? source.angle : null,
			shadowed: Boolean(source.getShadowGenerator?.()),
			clustered: clusteredSet.has(light),
			includeOnlyWithLayerMask: source.includeOnlyWithLayerMask >>> 0,
			excludeWithLayerMask: source.excludeWithLayerMask >>> 0,
		};
		const pipelines: Exclude<LightingSearchPipeline, "all">[] = values.clustered
			? ["clustered-forward", "portable-deferred"]
			: ["native-forward", "portable-deferred", "baked-gi"];
		return {
			provider: "lights",
			id: light.id,
			name: light.name,
			type: light.getClassName(),
			pipelines,
			properties: values,
			editableProperties: ["name", "enabled", "intensity", "diffuse", "specular", "range", "angle", "includeOnlyWithLayerMask", "excludeWithLayerMask"],
			fingerprint: itemFingerprint("lights", light.id, values),
		};
	});
}

function meshItems(scene: Scene): ILightingSearchItem[] {
	return scene.meshes
		.filter((mesh) => !mesh.doNotSerialize)
		.map((mesh) => {
			const lightmap = materialLightmap(mesh.material);
			const values = {
				name: mesh.name,
				enabled: mesh.isEnabled(),
				visibility: mesh.visibility,
				receiveShadows: mesh.receiveShadows,
				renderingGroupId: mesh.renderingGroupId,
				layerMask: mesh.layerMask >>> 0,
				materialId: mesh.material?.id ?? null,
				materialName: mesh.material?.name ?? null,
				lightmapped: Boolean(lightmap),
				lightmapName: lightmap?.name ?? null,
			};
			return {
				provider: "mesh-renderers",
				id: mesh.id,
				name: mesh.name,
				type: mesh.getClassName(),
				pipelines: ["native-forward", "clustered-forward", "portable-deferred", "baked-gi"],
				properties: values,
				editableProperties: ["name", "enabled", "visibility", "receiveShadows", "renderingGroupId", "layerMask"],
				fingerprint: itemFingerprint("mesh-renderers", mesh.id, values),
			};
		});
}

function lightmapItems(scene: Scene): ILightingSearchItem[] {
	const manifest = readBakedGlobalIlluminationManifest(scene);
	const entries = new Map(manifest?.meshEntries.map((entry, index) => [entry.meshId, { entry, index }]) ?? []);
	return scene.meshes.flatMap((mesh) => {
		const texture = materialLightmap(mesh.material);
		const manifestEntry = entries.get(mesh.id);
		if (!texture && !manifestEntry) {
			return [];
		}
		const size = texture?.getSize?.() ?? { width: manifest?.resolution ?? 0, height: manifest?.resolution ?? 0 };
		let path = manifestEntry?.entry.lightmapPath ?? texture?.name ?? texture?.url ?? "";
		if (isAbsolute(path) && projectConfiguration.path) {
			const root = dirname(projectConfiguration.path);
			const contained = relative(root, path);
			if (contained && contained !== ".." && !contained.startsWith("../")) {
				path = contained;
			}
		}
		const format = extname(path).replace(".", "").toLowerCase() || "runtime";
		const coveredTexels = manifestEntry?.entry.coveredTexels ?? null;
		const values = {
			index: manifestEntry?.index ?? 0,
			meshId: mesh.id,
			meshName: mesh.name,
			path,
			width: size.width ?? 0,
			height: size.height ?? 0,
			format,
			compression: ["ktx", "ktx2", "dds"].includes(format) ? format : "none",
			coordinatesIndex: texture?.coordinatesIndex ?? manifestEntry?.entry.coordinatesIndex ?? 0,
			intensity: texture?.level ?? 1,
			useAsShadowmap: materialLeaves(mesh.material).some((material) => Boolean((material as any).useLightmapAsShadowmap)),
			uvSource: manifestEntry?.entry.uvSource ?? null,
			coveredTexels,
			overlapTexels: manifestEntry?.entry.overlapTexels ?? null,
			saturatedTexels: manifestEntry?.entry.saturatedTexels ?? null,
			coveragePercent: coveredTexels === null || !size.width || !size.height ? null : Number(((coveredTexels / (size.width * size.height)) * 100).toFixed(3)),
			bakeId: manifest?.bakeId ?? null,
		};
		const id = `lightmap:${mesh.id}`;
		return [
			{
				provider: "lightmaps",
				id,
				name: `${mesh.name} Lightmap`,
				type: "Lightmap2D",
				pipelines: ["native-forward", "portable-deferred", "baked-gi"],
				properties: values,
				editableProperties: [],
				fingerprint: itemFingerprint("lightmaps", id, values),
			},
		];
	});
}

function reflectionProbeItems(scene: Scene): ILightingSearchItem[] {
	return (listReflectionProbes(scene, { offset: 0, limit: 50 }).probes as any[]).map((probe) => {
		const values = { ...probe };
		delete values.id;
		delete values.name;
		return {
			provider: "reflection-probes",
			id: probe.id,
			name: probe.name,
			type: "ReflectionProbe",
			pipelines: ["native-forward", "portable-deferred", "baked-gi"],
			properties: values,
			editableProperties: [],
			fingerprint: itemFingerprint("reflection-probes", probe.id, values),
		};
	});
}

function probeVolumeItems(scene: Scene): ILightingSearchItem[] {
	return validateLightProbeVolumes(scene.metadata?.[lightProbeVolumesMetadataKey]).map((volume) => {
		const values = {
			enabled: volume.enabled,
			priority: volume.priority,
			minimum: volume.minimum,
			maximum: volume.maximum,
			baseResolution: volume.baseResolution,
			adaptiveLevels: volume.adaptiveLevels,
			blendDistance: volume.blendDistance,
			probeCount: volume.bake?.probes.length ?? 0,
			cellCount: volume.bake?.cells.length ?? 0,
			baked: Boolean(volume.bake),
		};
		return {
			provider: "probe-volumes",
			id: volume.id,
			name: volume.name,
			type: "AdaptiveProbeVolume",
			pipelines: ["native-forward", "portable-deferred", "baked-gi"],
			properties: values,
			editableProperties: [],
			fingerprint: itemFingerprint("probe-volumes", volume.id, values),
		};
	});
}

function materialItems(scene: Scene): ILightingSearchItem[] {
	return scene.materials
		.filter((material) => !material.doNotSerialize)
		.map((material) => {
			const source = material as any;
			const emissiveColor = source.emissiveColor instanceof Color3 ? source.emissiveColor.asArray() : null;
			const emissive = Boolean(emissiveColor?.some((value: number) => value > 0.000001) || (source.emissiveTexture && source.emissiveTexture.isReady?.()));
			const values = {
				name: material.name,
				alpha: material.alpha,
				backFaceCulling: material.backFaceCulling,
				wireframe: material.wireframe,
				emissive,
				emissiveColor,
				emissiveIntensity: Number.isFinite(source.emissiveIntensity) ? source.emissiveIntensity : 1,
				lightmapped: Boolean(source.lightmapTexture),
				lightmapName: source.lightmapTexture?.name ?? null,
			};
			return {
				provider: "materials",
				id: material.id,
				name: material.name,
				type: material.getClassName(),
				pipelines: ["native-forward", "clustered-forward", "portable-deferred", "baked-gi"],
				properties: values,
				editableProperties: [
					"name",
					"alpha",
					"backFaceCulling",
					"wireframe",
					...(source.emissiveColor instanceof Color3 ? ["emissiveColor"] : []),
					...(material instanceof PBRMaterial ? ["emissiveIntensity"] : []),
				],
				fingerprint: itemFingerprint("materials", material.id, values),
			};
		});
}

function settingsItems(scene: Scene): ILightingSearchItem[] {
	const values = {
		name: "Active Scene",
		environmentIntensity: scene.environmentIntensity,
		ambientColor: scene.ambientColor.asArray(),
		clearColor: scene.clearColor.asArray(),
		fogEnabled: scene.fogEnabled,
	};
	return [
		{
			provider: "lighting-settings",
			id: "active-scene",
			name: values.name,
			type: "SceneLightingSettings",
			pipelines: ["native-forward", "clustered-forward", "portable-deferred", "baked-gi"],
			properties: values,
			editableProperties: ["environmentIntensity", "ambientColor", "clearColor", "fogEnabled"],
			fingerprint: itemFingerprint("lighting-settings", "active-scene", values),
		},
	];
}

function collectItems(scene: Scene, provider: LightingSearchProvider, options?: IMCPActionOptions): ILightingSearchItem[] {
	switch (provider) {
		case "lights":
			return lightItems(scene, options);
		case "mesh-renderers":
			return meshItems(scene);
		case "lightmaps":
			return lightmapItems(scene);
		case "reflection-probes":
			return reflectionProbeItems(scene);
		case "probe-volumes":
			return probeVolumeItems(scene);
		case "materials":
			return materialItems(scene);
		case "lighting-settings":
			return settingsItems(scene);
	}
}

function fieldValue(item: ILightingSearchItem, field: string): unknown {
	if (field === "id" || field === "name" || field === "type" || field === "provider") {
		return item[field];
	}
	return item.properties[field];
}

function matchesFilter(item: ILightingSearchItem, filter: ILightingSearchFilter): boolean {
	const actual = fieldValue(item, filter.field);
	if (actual === undefined) {
		return false;
	}
	if (filter.operator === "contains") {
		return String(actual).toLowerCase().includes(String(filter.value).toLowerCase());
	}
	if (["gt", "gte", "lt", "lte"].includes(filter.operator)) {
		if (typeof actual !== "number" || typeof filter.value !== "number") {
			return false;
		}
		return filter.operator === "gt"
			? actual > filter.value
			: filter.operator === "gte"
				? actual >= filter.value
				: filter.operator === "lt"
					? actual < filter.value
					: actual <= filter.value;
	}
	const equal = typeof actual === "string" && typeof filter.value === "string" ? actual.toLowerCase() === filter.value.toLowerCase() : actual === filter.value;
	return filter.operator === "eq" ? equal : !equal;
}

function resolveQuery(
	scene: Scene,
	data: Record<string, unknown>
): { provider: LightingSearchProvider; search: string; pipeline: LightingSearchPipeline; filters: ILightingSearchFilter[]; columns: string[]; queryId: string | null } {
	if (data.queryId && data.provider) {
		throw new Error("Provide exactly one Lighting Search queryId or provider, not both.");
	}
	if (data.queryId) {
		const id = boundedText(data.queryId, "queryId", 128);
		const query = [...builtInQueryTree, ...readState(scene).customQueries.map(customQueryNode)].find((entry) => entry.id === id);
		if (!query || query.kind !== "query" || !query.provider) {
			throw new Error(`Lighting Search query "${id}" was not found or is a folder.`);
		}
		return { provider: query.provider, search: query.search, pipeline: query.pipeline, filters: query.filters, columns: query.columns, queryId: id };
	}
	if (!lightingSearchProviders.includes(data.provider as LightingSearchProvider)) {
		throw new Error("Provide a valid provider or queryId.");
	}
	const pipeline = (data.pipeline ?? "all") as LightingSearchPipeline;
	if (!lightingSearchPipelines.includes(pipeline)) {
		throw new Error("Lighting Search pipeline selector is unsupported.");
	}
	return {
		provider: data.provider as LightingSearchProvider,
		search: boundedText(data.search ?? "", "search", 512, true),
		pipeline,
		filters: validateFilters(data.filters ?? []),
		columns: validateColumns(data.columns ?? []),
		queryId: null,
	};
}

/** Runs one stable bounded lighting-provider query with pipeline selection, filtering, sorting, and pagination. */
export function queryLightingSearch(scene: Scene, data: Record<string, unknown> = {}, options?: IMCPActionOptions): Record<string, unknown> {
	const query = resolveQuery(scene, data);
	const search = (data.search === undefined ? query.search : boundedText(data.search, "search", 512, true)).trim().toLowerCase();
	const pipeline = (data.pipeline === undefined ? query.pipeline : data.pipeline) as LightingSearchPipeline;
	if (!lightingSearchPipelines.includes(pipeline)) {
		throw new Error("Lighting Search pipeline selector is unsupported.");
	}
	const filters = data.filters === undefined ? query.filters : validateFilters(data.filters);
	const sortField = data.sortField === undefined ? "name" : boundedText(data.sortField, "sortField", 64);
	if (!fieldPattern.test(sortField)) {
		throw new Error("sortField must start with a letter and contain only letters or digits.");
	}
	const sortDirection = data.sortDirection ?? "asc";
	if (!["asc", "desc"].includes(sortDirection as string)) {
		throw new Error("sortDirection must be asc or desc.");
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	if (!Number.isInteger(offset) || (offset as number) < 0 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
		throw new Error("Lighting Search pagination requires offset >= 0 and limit from 1 through 100.");
	}
	const rows = collectItems(scene, query.provider, options)
		.filter((item) => pipeline === "all" || item.pipelines.includes(pipeline as Exclude<LightingSearchPipeline, "all">))
		.filter((item) => !search || `${item.name} ${item.type} ${JSON.stringify(item.properties)}`.toLowerCase().includes(search))
		.filter((item) => filters.every((filter) => matchesFilter(item, filter)))
		.sort((left, right) => {
			const leftValue = fieldValue(left, sortField);
			const rightValue = fieldValue(right, sortField);
			const compare =
				typeof leftValue === "number" && typeof rightValue === "number" ? leftValue - rightValue : String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
			return (sortDirection === "desc" ? -compare : compare) || left.id.localeCompare(right.id);
		});
	const page = rows.slice(offset as number, (offset as number) + (limit as number));
	return {
		query: { ...query, search, pipeline, filters, sortField, sortDirection },
		total: rows.length,
		count: page.length,
		offset,
		hasMore: (offset as number) + page.length < rows.length,
		nextOffset: (offset as number) + page.length < rows.length ? (offset as number) + page.length : null,
		columns: data.columns === undefined ? query.columns : validateColumns(data.columns),
		items: page.map((item) => structuredClone(item)),
	};
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is open. Open a project before previewing a lightmap file.");
	}
	return dirname(projectConfiguration.path);
}

async function resolvePreviewPath(path: string): Promise<{ absolutePath: string; projectRelativePath: string }> {
	if (!path || isAbsolute(path)) {
		throw new Error("Lighting Search previews require a project-relative lightmap path.");
	}
	const root = projectDirectory();
	const absolutePath = join(root, path);
	const containment = relative(root, absolutePath);
	if (!containment || containment === ".." || containment.startsWith("../")) {
		throw new Error("Lighting Search lightmap previews must stay inside the open project.");
	}
	const info = await lstat(absolutePath).catch(() => null);
	if (!info || !info.isFile() || info.isSymbolicLink()) {
		throw new Error(`Lighting Search lightmap preview file does not exist or is unsafe: ${path}.`);
	}
	const canonicalRoot = await realpath(root);
	const canonicalPath = await realpath(absolutePath);
	const canonicalContainment = relative(canonicalRoot, canonicalPath);
	if (canonicalContainment === ".." || canonicalContainment.startsWith("../")) {
		throw new Error("Lighting Search lightmap preview resolves outside the canonical project directory.");
	}
	return { absolutePath, projectRelativePath: containment };
}

/** Returns exact project-contained lightmap preview evidence with bounded exposure. */
export async function getLightingSearchLightmapPreview(scene: Scene, data: Record<string, unknown>, options?: IMCPActionOptions): Promise<Record<string, unknown>> {
	const id = boundedText(data.id, "id", 256);
	const item = lightmapItems(scene).find((candidate) => candidate.id === id);
	if (!item) {
		throw new Error(`Lighting Search lightmap "${id}" was not found. Query the lightmaps provider again.`);
	}
	if (data.expectedFingerprint !== item.fingerprint) {
		throw new Error(`Lighting Search lightmap changed. Query it again and use expectedFingerprint "${item.fingerprint}".`);
	}
	const exposureEV = data.exposureEV ?? 0;
	if (typeof exposureEV !== "number" || !Number.isFinite(exposureEV) || exposureEV < -16 || exposureEV > 16) {
		throw new Error("Lighting Search lightmap exposureEV must be from -16 through 16.");
	}
	const { absolutePath, projectRelativePath } = await resolvePreviewPath(String(item.properties.path ?? ""));
	const info = await stat(absolutePath);
	if (info.size > maximumPreviewBytes) {
		throw new Error(`Lighting Search lightmap preview is ${info.size} bytes; the safe maximum is ${maximumPreviewBytes}.`);
	}
	const bytes = await readFile(absolutePath);
	const result = {
		item: structuredClone(item),
		projectRelativePath,
		previewUrl: pathToFileURL(absolutePath).href,
		mimeType:
			extname(absolutePath).toLowerCase() === ".png"
				? "image/png"
				: extname(absolutePath).toLowerCase() === ".jpg" || extname(absolutePath).toLowerCase() === ".jpeg"
					? "image/jpeg"
					: "application/octet-stream",
		bytes: info.size,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		exposureEV,
		exposureMultiplier: 2 ** exposureEV,
	};
	if (options) {
		options.editor.layout.selectTab("lighting-search");
		options.editor.layout.lightingSearch?.showPreview?.(result);
	}
	return result;
}

function assertKeys(properties: Record<string, unknown>, allowed: string[], field: string): void {
	const unknown = Object.keys(properties).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${field} contains unsupported properties: ${unknown.join(", ")}.`);
	}
	if (!Object.keys(properties).length) {
		throw new Error(`${field} requires at least one property.`);
	}
}

function finiteNumber(value: unknown, field: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${field} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
	const result = finiteNumber(value, field, minimum, maximum);
	if (!Number.isInteger(result)) {
		throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
	}
	return result;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a Boolean.`);
	}
	return value;
}

function color(value: unknown, field: string, alpha = false): number[] {
	const length = alpha ? 4 : 3;
	if (!Array.isArray(value) || value.length !== length || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1)) {
		throw new Error(`${field} must contain ${length} finite values from 0 through 1.`);
	}
	return [...value];
}

function unsigned(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 4_294_967_295) {
		throw new Error(`${field} must be an unsigned 32-bit integer.`);
	}
	return (value as number) >>> 0;
}

function cloneEditable(target: any, keys: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const value = target[key];
		result[key] = value instanceof Color3 || value instanceof Color4 ? value.asArray() : typeof value === "function" ? undefined : value;
	}
	return result;
}

function applyOperation(scene: Scene, operation: Record<string, unknown>, options: IMCPActionOptions): { restore: () => void; redo: () => void } {
	const provider = operation.provider as LightingSearchProvider;
	const id = operation.id as string;
	const properties = operation.properties as Record<string, unknown>;
	if (provider === "lights") {
		const clustered = ((options.editor.layout.preview?.clusteredLightContainer?.lights ?? []) as Light[]).filter(Boolean);
		const target = scene.getLightById(id) ?? clustered.find((light) => light.id === id);
		if (!target) {
			throw new Error(`Light "${id}" was not found.`);
		}
		const allowed = ["name", "enabled", "intensity", "diffuse", "specular", "range", "angle", "includeOnlyWithLayerMask", "excludeWithLayerMask"];
		assertKeys(properties, allowed, `Light "${target.name}" properties`);
		const before = {
			...cloneEditable(target as any, ["name", "intensity", "diffuse", "specular", "range", "angle", "includeOnlyWithLayerMask", "excludeWithLayerMask"]),
			enabled: target.isEnabled(),
		};
		const apply = (values: Record<string, unknown>, validate = true) => {
			if (values.name !== undefined) {
				target.name = boundedText(values.name, "light.name", 256);
			}
			if (values.enabled !== undefined) {
				target.setEnabled(boolean(values.enabled, "light.enabled"));
			}
			for (const key of ["intensity", "range", "angle"] as const) {
				if (values[key] !== undefined) {
					(target as any)[key] = validate ? finiteNumber(values[key], `light.${key}`, 0, 10_000_000) : values[key];
				}
			}
			for (const key of ["diffuse", "specular"] as const) {
				if (values[key] !== undefined) {
					(target as any)[key].copyFrom(Color3.FromArray(color(values[key], `light.${key}`)));
				}
			}
			for (const key of ["includeOnlyWithLayerMask", "excludeWithLayerMask"] as const) {
				if (values[key] !== undefined) {
					(target as any)[key] = unsigned(values[key], `light.${key}`);
				}
			}
		};
		apply(properties);
		const after = {
			...cloneEditable(target as any, ["name", "intensity", "diffuse", "specular", "range", "angle", "includeOnlyWithLayerMask", "excludeWithLayerMask"]),
			enabled: target.isEnabled(),
		};
		return { restore: () => apply(before, false), redo: () => apply(after, false) };
	}
	if (provider === "mesh-renderers") {
		const target = scene.getMeshById(id);
		if (!target) {
			throw new Error(`Mesh renderer "${id}" was not found.`);
		}
		assertKeys(properties, ["name", "enabled", "visibility", "receiveShadows", "renderingGroupId", "layerMask"], `Mesh renderer "${target.name}" properties`);
		const before = {
			name: target.name,
			enabled: target.isEnabled(),
			visibility: target.visibility,
			receiveShadows: target.receiveShadows,
			renderingGroupId: target.renderingGroupId,
			layerMask: target.layerMask >>> 0,
		};
		const apply = (values: Record<string, unknown>) => {
			if (values.name !== undefined) {
				target.name = boundedText(values.name, "mesh.name", 256);
			}
			if (values.enabled !== undefined) {
				target.setEnabled(boolean(values.enabled, "mesh.enabled"));
			}
			if (values.visibility !== undefined) {
				target.visibility = finiteNumber(values.visibility, "mesh.visibility", 0, 1);
			}
			if (values.receiveShadows !== undefined) {
				target.receiveShadows = boolean(values.receiveShadows, "mesh.receiveShadows");
			}
			if (values.renderingGroupId !== undefined) {
				target.renderingGroupId = integer(values.renderingGroupId, "mesh.renderingGroupId", 0, 3);
			}
			if (values.layerMask !== undefined) {
				target.layerMask = unsigned(values.layerMask, "mesh.layerMask");
			}
		};
		apply(properties);
		const after = {
			name: target.name,
			enabled: target.isEnabled(),
			visibility: target.visibility,
			receiveShadows: target.receiveShadows,
			renderingGroupId: target.renderingGroupId,
			layerMask: target.layerMask >>> 0,
		};
		return { restore: () => apply(before), redo: () => apply(after) };
	}
	if (provider === "materials") {
		const target = scene.getMaterialById(id);
		if (!target) {
			throw new Error(`Material "${id}" was not found.`);
		}
		const source = target as any;
		assertKeys(properties, ["name", "alpha", "backFaceCulling", "wireframe", "emissiveColor", "emissiveIntensity"], `Material "${target.name}" properties`);
		if (properties.emissiveColor !== undefined && !(source.emissiveColor instanceof Color3)) {
			throw new Error(`Material "${target.name}" does not expose emissiveColor.`);
		}
		if (properties.emissiveIntensity !== undefined && !(target instanceof PBRMaterial)) {
			throw new Error(`Material "${target.name}" does not expose emissiveIntensity.`);
		}
		const before = {
			name: target.name,
			alpha: target.alpha,
			backFaceCulling: target.backFaceCulling,
			wireframe: target.wireframe,
			emissiveColor: source.emissiveColor?.asArray?.(),
			emissiveIntensity: source.emissiveIntensity,
		};
		const apply = (values: Record<string, unknown>) => {
			if (values.name !== undefined) {
				target.name = boundedText(values.name, "material.name", 256);
			}
			if (values.alpha !== undefined) {
				target.alpha = finiteNumber(values.alpha, "material.alpha", 0, 1);
			}
			if (values.backFaceCulling !== undefined) {
				target.backFaceCulling = boolean(values.backFaceCulling, "material.backFaceCulling");
			}
			if (values.wireframe !== undefined) {
				target.wireframe = boolean(values.wireframe, "material.wireframe");
			}
			if (values.emissiveColor !== undefined) {
				source.emissiveColor.copyFrom(Color3.FromArray(color(values.emissiveColor, "material.emissiveColor")));
			}
			if (values.emissiveIntensity !== undefined) {
				source.emissiveIntensity = finiteNumber(values.emissiveIntensity, "material.emissiveIntensity", 0, 1_000_000);
			}
		};
		apply(properties);
		const after = {
			name: target.name,
			alpha: target.alpha,
			backFaceCulling: target.backFaceCulling,
			wireframe: target.wireframe,
			emissiveColor: source.emissiveColor?.asArray?.(),
			emissiveIntensity: source.emissiveIntensity,
		};
		return { restore: () => apply(before), redo: () => apply(after) };
	}
	if (provider === "lighting-settings") {
		if (id !== "active-scene") {
			throw new Error(`Lighting settings item "${id}" was not found.`);
		}
		assertKeys(properties, ["environmentIntensity", "ambientColor", "clearColor", "fogEnabled"], "Scene lighting properties");
		const before = {
			environmentIntensity: scene.environmentIntensity,
			ambientColor: scene.ambientColor.asArray(),
			clearColor: scene.clearColor.asArray(),
			fogEnabled: scene.fogEnabled,
		};
		const apply = (values: Record<string, unknown>) => {
			if (values.environmentIntensity !== undefined) {
				scene.environmentIntensity = finiteNumber(values.environmentIntensity, "scene.environmentIntensity", 0, 1_000_000);
			}
			if (values.ambientColor !== undefined) {
				scene.ambientColor.copyFrom(Color3.FromArray(color(values.ambientColor, "scene.ambientColor")));
			}
			if (values.clearColor !== undefined) {
				scene.clearColor.copyFrom(Color4.FromArray(color(values.clearColor, "scene.clearColor", true)));
			}
			if (values.fogEnabled !== undefined) {
				scene.fogEnabled = boolean(values.fogEnabled, "scene.fogEnabled");
			}
		};
		apply(properties);
		const after = {
			environmentIntensity: scene.environmentIntensity,
			ambientColor: scene.ambientColor.asArray(),
			clearColor: scene.clearColor.asArray(),
			fogEnabled: scene.fogEnabled,
		};
		return { restore: () => apply(before), redo: () => apply(after) };
	}
	throw new Error(`Lighting Search provider "${provider}" is read-only. Use its dedicated exact-revision tool where available.`);
}

/** Atomically edits up to 50 exact-fingerprint Lighting Search rows with rollback and Undo/Redo. */
export function setLightingSearchProperties(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	if (!Array.isArray(data.operations) || data.operations.length < 1 || data.operations.length > 50) {
		throw new Error("Lighting Search property editing requires 1 through 50 operations.");
	}
	const operations = data.operations as Record<string, unknown>[];
	const identities = new Set<string>();
	for (const [index, operation] of operations.entries()) {
		if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
			throw new Error(`operations[${index}] must be an object.`);
		}
		const unknownOperationFields = Object.keys(operation).filter((key) => !["provider", "id", "expectedFingerprint", "properties"].includes(key));
		if (unknownOperationFields.length) {
			throw new Error(`operations[${index}] contains unsupported fields: ${unknownOperationFields.join(", ")}.`);
		}
		const provider = operation.provider as LightingSearchProvider;
		if (!["lights", "mesh-renderers", "materials", "lighting-settings"].includes(provider)) {
			throw new Error(`operations[${index}].provider is read-only or unsupported.`);
		}
		const id = boundedText(operation.id, `operations[${index}].id`, 256);
		const identity = `${provider}:${id}`;
		if (identities.has(identity)) {
			throw new Error(`Lighting Search operations contain duplicate target ${identity}.`);
		}
		identities.add(identity);
		if (!operation.properties || typeof operation.properties !== "object" || Array.isArray(operation.properties)) {
			throw new Error(`operations[${index}].properties must be an object.`);
		}
		const current = collectItems(scene, provider, options).find((item) => item.id === id);
		if (!current) {
			throw new Error(`Lighting Search target ${identity} was not found.`);
		}
		if (operation.expectedFingerprint !== current.fingerprint) {
			throw new Error(`Lighting Search target ${identity} changed. Query it again and use expectedFingerprint "${current.fingerprint}".`);
		}
	}
	const applied: { restore: () => void; redo: () => void }[] = [];
	try {
		for (const operation of operations) {
			applied.push(applyOperation(scene, operation, options));
		}
	} catch (error) {
		for (const entry of applied.reverse()) {
			entry.restore();
		}
		throw new Error(`Lighting Search batch edit failed; every prior change was rolled back. ${error instanceof Error ? error.message : String(error)}`);
	}
	registerUndoRedo({
		undo: () => [...applied].reverse().forEach((entry) => entry.restore()),
		redo: () => applied.forEach((entry) => entry.redo()),
		action: () => refreshUI(options),
	});
	refreshUI(options);
	return {
		updated: applied.length,
		items: operations.map((operation) => collectItems(scene, operation.provider as LightingSearchProvider, options).find((item) => item.id === operation.id)),
	};
}

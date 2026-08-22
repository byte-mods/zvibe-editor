import { AssetContainer } from "@babylonjs/core/assetContainer";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";

import {
	ECSFieldType,
	ECSFieldValue,
	IECSComponentTypeDefinition,
	IECSConfiguration,
	IECSFieldDefinition,
	IECSMetadataHost,
	getECSFieldArity,
	getSceneECSConfiguration,
	normalizeECSFieldValue,
	normalizeECSConfiguration,
	normalizeEntityComponentData,
	isECSComponentTypeRegistered,
} from "./model";
import { getECSStableHash } from "./hash";
import { getSerializedGameObjectComponentStack } from "../loading/game-object-components";

export const ECS_BAKED_WORLD_VERSION = 1 as const;
export const ECS_MAX_AUTHORED_ENTITIES = 100_000;

export type ECSTypedArray = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array;
export type ECSBakeMode = "full" | "incremental";

export interface IBakedECSColumn {
	componentId: string;
	fieldId: string;
	type: ECSFieldType;
	arity: number;
	values: ECSTypedArray;
}

export interface IBakedECSChunk {
	id: string;
	bucketKey: string;
	sectionId: string;
	archetype: string;
	componentIds: string[];
	entityIds: string[];
	entityNames: string[];
	parentEntityIds: Array<string | null>;
	hiddenInHierarchy: boolean[];
	authoredEntities: boolean[];
	sourceHashes: string[];
	columns: Record<string, IBakedECSColumn>;
	count: number;
	capacity: number;
}

export interface IECSSourceLease {
	entityId: string;
	sectionId: string;
	bucketKey: string;
	sourceHash: string;
}

export interface IBakedECSSection {
	id: string;
	name: string;
	autoLoad: boolean;
	loaded: boolean;
	priority: number;
	entityCount: number;
	activeEntityCount: number;
	chunkCount: number;
}

export interface IBakedECSWorld {
	version: typeof ECS_BAKED_WORLD_VERSION;
	generation: number;
	configurationRevision: number;
	configurationHash: string;
	entityCount: number;
	activeEntityCount: number;
	chunks: IBakedECSChunk[];
	activeChunkIds: string[];
	sections: IBakedECSSection[];
	sourceLeases: Record<string, IECSSourceLease>;
	diagnostics: string[];
}

export interface IECSBakeOptions {
	mode?: ECSBakeMode;
	expectedGeneration?: number;
	/** Exact hashes returned by a previous bake; stale editors must re-inspect. */
	expectedSourceHashes?: Record<string, string>;
}

export interface IECSBakeReport {
	mode: ECSBakeMode;
	fullRebuild: boolean;
	previousGeneration: number | null;
	generation: number;
	changedSourceIds: string[];
	removedSourceIds: string[];
	reusedSourceIds: string[];
	rebuiltBucketKeys: string[];
	reusedBucketKeys: string[];
}

export interface IECSBakeResult {
	world: IBakedECSWorld;
	report: IECSBakeReport;
}

export interface IECSWorldSnapshotOptions {
	includeValues?: boolean;
	chunkOffset?: number;
	chunkLimit?: number;
}

interface IECSBakeSource {
	entityId: string;
	entityName: string;
	parentEntityId: string | null;
	hiddenInHierarchy: boolean;
	sectionId: string;
	archetype: string;
	bucketKey: string;
	componentIds: string[];
	components: Record<string, Record<string, ECSFieldValue>>;
	sourceHash: string;
}

interface IECSBakeState {
	configuration: IECSConfiguration;
	configurationHash: string;
	sources: Map<string, IECSBakeSource>;
	buckets: Map<string, IBakedECSChunk[]>;
	loadedSections: Set<string>;
	world: IBakedECSWorld;
}

interface IComposeWorldInput {
	configuration: IECSConfiguration;
	configurationHash: string;
	generation: number;
	buckets: ReadonlyMap<string, IBakedECSChunk[]>;
	sources: ReadonlyMap<string, IECSBakeSource>;
	loadedSections: ReadonlySet<string>;
	diagnostics: string[];
}

const columnKey = (componentId: string, fieldId: string): string => `${componentId}.${fieldId}`;

function getNodes(source: Scene | AssetContainer): Node[] {
	const nodes = [...source.transformNodes, ...source.meshes, ...source.lights, ...source.cameras];
	const byId = new Map<string, Node>();
	for (const node of nodes) {
		if (!node.id) {
			throw new Error("ECS baking requires every authored node to have a non-empty id.");
		}
		const existing = byId.get(node.id);
		if (existing && existing !== node) {
			throw new Error(`ECS baking found duplicate node id "${node.id}".`);
		}
		byId.set(node.id, node);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function transformValues(node: Node): Record<string, ECSFieldValue> {
	const transform = node as Node & {
		position?: { asArray(): number[] };
		rotation?: { asArray(): number[] };
		rotationQuaternion?: { asArray(): number[] } | null;
		scaling?: { asArray(): number[] };
	};
	const rotation = transform.rotationQuaternion?.asArray() ?? Quaternion.FromEulerAngles(...((transform.rotation?.asArray() ?? [0, 0, 0]) as [number, number, number])).asArray();
	return {
		position: transform.position?.asArray() ?? [0, 0, 0],
		rotation,
		scale: transform.scaling?.asArray() ?? [1, 1, 1],
	};
}

function assertFieldBounds(field: IECSFieldDefinition, value: ECSFieldValue, path: string): void {
	const lanes = Array.isArray(value) ? value : [value];
	for (const lane of lanes) {
		if (typeof lane !== "number") {
			continue;
		}
		if (field.minimum !== undefined && lane < field.minimum) {
			throw new Error(`${path} is below minimum ${field.minimum}.`);
		}
		if (field.maximum !== undefined && lane > field.maximum) {
			throw new Error(`${path} exceeds maximum ${field.maximum}.`);
		}
	}
}

function normalizeComponentValues(component: IECSComponentTypeDefinition, value: Record<string, ECSFieldValue>, path: string): Record<string, ECSFieldValue> {
	const fields = new Set(component.fields.map((field) => field.id));
	for (const fieldId of Object.keys(value)) {
		if (!fields.has(fieldId)) {
			throw new Error(`${path} contains unknown field "${fieldId}".`);
		}
	}
	return Object.fromEntries(
		component.fields.map((field) => {
			const normalized = normalizeECSFieldValue(field.type, value[field.id] ?? field.defaultValue, `${path}.${field.id}`);
			assertFieldBounds(field, normalized, `${path}.${field.id}`);
			return [field.id, normalized];
		})
	);
}

function collectSources(source: Scene | AssetContainer, configuration: IECSConfiguration): { sources: Map<string, IECSBakeSource>; diagnostics: string[] } {
	const componentDefinitions = new Map(configuration.componentTypes.map((component) => [component.id, component]));
	const sectionIds = new Set(configuration.sections.map((section) => section.id));
	const sources = new Map<string, IECSBakeSource>();
	const diagnostics = new Set<string>();
	const nodes = getNodes(source);
	const entityNodeIds = new Set(
		nodes.filter((node) => getSerializedGameObjectComponentStack(node)?.components.some((component) => component.type === "entity" && component.enabled)).map((node) => node.id)
	);

	for (const node of nodes) {
		const stack = getSerializedGameObjectComponentStack(node);
		const descriptor = stack?.components.find((component) => component.type === "entity" && component.enabled);
		if (!descriptor) {
			continue;
		}
		const authored = normalizeEntityComponentData(descriptor.data);
		if (!authored.bakingEnabled) {
			continue;
		}
		if (!sectionIds.has(authored.sectionId)) {
			throw new Error(`Entity "${node.id}" references unknown ECS section "${authored.sectionId}".`);
		}
		const components: Record<string, Record<string, ECSFieldValue>> = { transform: transformValues(node) };
		for (const [componentId, values] of Object.entries(authored.components).sort(([a], [b]) => a.localeCompare(b))) {
			const definition = componentDefinitions.get(componentId);
			if (!definition) {
				throw new Error(`Entity "${node.id}" references unknown ECS component "${componentId}".`);
			}
			if (definition.builtIn) {
				throw new Error(`Entity "${node.id}" cannot author built-in ECS component "${componentId}" directly.`);
			}
			if (!isECSComponentTypeRegistered(configuration, componentId)) {
				throw new Error(
					`Entity "${node.id}" uses unregistered ECS component "${componentId}". Explicitly register it or enable auto-registration for assembly "${definition.assembly}".`
				);
			}
			components[componentId] = normalizeComponentValues(definition, values, `Entity "${node.id}" component "${componentId}"`);
		}
		if (Object.keys(authored.values).length) {
			components.legacy = Object.fromEntries(Object.entries(authored.values).sort(([a], [b]) => a.localeCompare(b)));
			diagnostics.add("Legacy numeric Entity values were baked into read-only legacy.* f64 columns; migrate them to a configured typed component for system access.");
		}
		const componentIds = Object.keys(components).sort();
		const bucketKey = `${authored.sectionId}:${getECSStableHash({ archetype: authored.archetype, componentIds })}`;
		let parent = node.parent;
		while (parent && !entityNodeIds.has(parent.id)) {
			parent = parent.parent;
		}
		const entityName = (node.name || node.id).slice(0, 120);
		const parentEntityId = parent?.id ?? null;
		const sourceHash = getECSStableHash({
			entityId: node.id,
			entityName,
			parentEntityId,
			hiddenInHierarchy: authored.hiddenInHierarchy,
			sectionId: authored.sectionId,
			archetype: authored.archetype,
			components,
		});
		sources.set(node.id, {
			entityId: node.id,
			entityName,
			parentEntityId,
			hiddenInHierarchy: authored.hiddenInHierarchy,
			sectionId: authored.sectionId,
			archetype: authored.archetype,
			bucketKey,
			componentIds,
			components,
			sourceHash,
		});
		if (sources.size > ECS_MAX_AUTHORED_ENTITIES) {
			throw new Error(`ECS baking exceeds the ${ECS_MAX_AUTHORED_ENTITIES} authored-entity limit.`);
		}
	}

	return { sources, diagnostics: [...diagnostics].sort() };
}

function createTypedArray(type: ECSFieldType, length: number): ECSTypedArray {
	switch (type) {
		case "f64":
			return new Float64Array(length);
		case "i32":
			return new Int32Array(length);
		case "u32":
			return new Uint32Array(length);
		case "bool":
			return new Uint8Array(length);
		default:
			return new Float32Array(length);
	}
}

function writeField(target: ECSTypedArray, row: number, arity: number, value: ECSFieldValue): void {
	const lanes = Array.isArray(value) ? value : [typeof value === "boolean" ? (value ? 1 : 0) : value];
	for (let lane = 0; lane < arity; lane++) {
		target[row * arity + lane] = lanes[lane] ?? 0;
	}
}

function bucketFieldDefinitions(sources: readonly IECSBakeSource[], configuration: IECSConfiguration): Array<{ componentId: string; field: IECSFieldDefinition }> {
	const componentIds = new Set(sources[0].componentIds);
	const result = configuration.componentTypes
		.filter((component) => componentIds.has(component.id))
		.flatMap((component) => component.fields.map((field) => ({ componentId: component.id, field })));
	if (componentIds.has("legacy")) {
		const legacyFields = [...new Set(sources.flatMap((source) => Object.keys(source.components.legacy ?? {})))].sort();
		result.push(...legacyFields.map((fieldId) => ({ componentId: "legacy", field: { id: fieldId, name: fieldId, type: "f64" as const, defaultValue: 0 } })));
	}
	return result.sort((a, b) => columnKey(a.componentId, a.field.id).localeCompare(columnKey(b.componentId, b.field.id)));
}

function buildBucket(bucketKey: string, sources: readonly IECSBakeSource[], configuration: IECSConfiguration): IBakedECSChunk[] {
	const ordered = [...sources].sort((a, b) => a.entityId.localeCompare(b.entityId));
	const definitions = bucketFieldDefinitions(ordered, configuration);
	const chunks: IBakedECSChunk[] = [];
	for (let offset = 0; offset < ordered.length; offset += configuration.settings.chunkCapacity) {
		const page = ordered.slice(offset, offset + configuration.settings.chunkCapacity);
		const columns: Record<string, IBakedECSColumn> = {};
		for (const { componentId, field } of definitions) {
			const arity = getECSFieldArity(field.type);
			const values = createTypedArray(field.type, page.length * arity);
			page.forEach((entry, row) => writeField(values, row, arity, entry.components[componentId]?.[field.id] ?? field.defaultValue));
			columns[columnKey(componentId, field.id)] = { componentId, fieldId: field.id, type: field.type, arity, values };
		}
		const sourceHashes = page.map((entry) => entry.sourceHash);
		chunks.push({
			id: `ecs-chunk-${getECSStableHash({ bucketKey, page: offset / configuration.settings.chunkCapacity, sourceHashes })}`,
			bucketKey,
			sectionId: page[0].sectionId,
			archetype: page[0].archetype,
			componentIds: [...page[0].componentIds],
			entityIds: page.map((entry) => entry.entityId),
			entityNames: page.map((entry) => entry.entityName),
			parentEntityIds: page.map((entry) => entry.parentEntityId),
			hiddenInHierarchy: page.map((entry) => entry.hiddenInHierarchy),
			authoredEntities: page.map(() => true),
			sourceHashes,
			columns,
			count: page.length,
			capacity: configuration.settings.chunkCapacity,
		});
	}
	return chunks;
}

function composeWorld({ configuration, configurationHash, generation, buckets, sources, loadedSections, diagnostics }: IComposeWorldInput): IBakedECSWorld {
	const chunks = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, entries]) => entries);
	const activeChunkIds = chunks.filter((chunk) => loadedSections.has(chunk.sectionId)).map((chunk) => chunk.id);
	const sections = [...configuration.sections]
		.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
		.map((section) => {
			const sectionChunks = chunks.filter((chunk) => chunk.sectionId === section.id);
			const entityCount = sectionChunks.reduce((total, chunk) => total + chunk.count, 0);
			return {
				...section,
				loaded: loadedSections.has(section.id),
				entityCount,
				activeEntityCount: loadedSections.has(section.id) ? entityCount : 0,
				chunkCount: sectionChunks.length,
			};
		});
	const sourceLeases = Object.fromEntries(
		[...sources.values()]
			.sort((a, b) => a.entityId.localeCompare(b.entityId))
			.map((entry) => [entry.entityId, { entityId: entry.entityId, sectionId: entry.sectionId, bucketKey: entry.bucketKey, sourceHash: entry.sourceHash }])
	);
	return {
		version: ECS_BAKED_WORLD_VERSION,
		generation,
		configurationRevision: configuration.revision,
		configurationHash,
		entityCount: chunks.reduce((total, chunk) => total + chunk.count, 0),
		activeEntityCount: chunks.filter((chunk) => loadedSections.has(chunk.sectionId)).reduce((total, chunk) => total + chunk.count, 0),
		chunks,
		activeChunkIds,
		sections,
		sourceLeases,
		diagnostics,
	};
}

/**
 * Retained deterministic baker. Incremental runs reuse entire unaffected
 * archetype/section buckets, preserving their typed-array identities.
 */
export class ECSBaker {
	private _state: IECSBakeState | null = null;

	public get world(): IBakedECSWorld | null {
		return this._state?.world ?? null;
	}

	public bake(source: Scene | AssetContainer, configuration = getSceneECSConfiguration(source as unknown as IECSMetadataHost), options: IECSBakeOptions = {}): IECSBakeResult {
		// Retain an owned validated snapshot. Otherwise a caller could mutate its
		// object after baking and silently desynchronize section state from hashes.
		configuration = normalizeECSConfiguration(configuration);
		const mode = options.mode ?? (this._state ? "incremental" : "full");
		if (mode !== "full" && mode !== "incremental") {
			throw new Error('ECS bake mode must be "full" or "incremental".');
		}
		const previous = this._state;
		if (options.expectedGeneration !== undefined && previous?.world.generation !== options.expectedGeneration) {
			throw new Error(`ECS bake generation changed; expected ${options.expectedGeneration}, current ${previous?.world.generation ?? "none"}.`);
		}
		for (const [entityId, expectedHash] of Object.entries(options.expectedSourceHashes ?? {})) {
			const currentHash = previous?.sources.get(entityId)?.sourceHash;
			if (currentHash !== expectedHash) {
				throw new Error(`ECS source lease changed for entity "${entityId}"; re-inspect before baking.`);
			}
		}
		const configurationHash = getECSStableHash(configuration);
		const collected = collectSources(source, configuration);
		const fullRebuild = mode === "full" || !previous || previous.configurationHash !== configurationHash;
		const changedSourceIds: string[] = [];
		const removedSourceIds: string[] = [];
		const reusedSourceIds: string[] = [];
		const affectedBuckets = new Set<string>();

		for (const [entityId, current] of collected.sources) {
			const old = previous?.sources.get(entityId);
			if (!fullRebuild && old?.sourceHash === current.sourceHash && old.bucketKey === current.bucketKey) {
				reusedSourceIds.push(entityId);
			} else {
				changedSourceIds.push(entityId);
				affectedBuckets.add(current.bucketKey);
				if (old) {
					affectedBuckets.add(old.bucketKey);
				}
			}
		}
		for (const [entityId, old] of previous?.sources ?? []) {
			if (!collected.sources.has(entityId)) {
				removedSourceIds.push(entityId);
				affectedBuckets.add(old.bucketKey);
			}
		}
		if (fullRebuild) {
			for (const entry of collected.sources.values()) {
				affectedBuckets.add(entry.bucketKey);
			}
		}

		const grouped = new Map<string, IECSBakeSource[]>();
		for (const entry of collected.sources.values()) {
			const bucket = grouped.get(entry.bucketKey) ?? [];
			bucket.push(entry);
			grouped.set(entry.bucketKey, bucket);
		}
		const buckets = new Map<string, IBakedECSChunk[]>();
		const rebuiltBucketKeys: string[] = [];
		const reusedBucketKeys: string[] = [];
		for (const [bucketKey, entries] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			const reusable = !fullRebuild && !affectedBuckets.has(bucketKey) ? previous?.buckets.get(bucketKey) : undefined;
			if (reusable) {
				buckets.set(bucketKey, reusable);
				reusedBucketKeys.push(bucketKey);
			} else {
				buckets.set(bucketKey, buildBucket(bucketKey, entries, configuration));
				rebuiltBucketKeys.push(bucketKey);
			}
		}

		const sectionIds = new Set(configuration.sections.map((section) => section.id));
		const loadedSections = new Set(
			previous && !fullRebuild
				? [...previous.loadedSections].filter((sectionId) => sectionIds.has(sectionId))
				: configuration.sections.filter((section) => section.autoLoad).map((section) => section.id)
		);
		for (const section of configuration.sections) {
			if (!previous?.loadedSections.has(section.id) && section.autoLoad) {
				loadedSections.add(section.id);
			}
		}
		const generation = (previous?.world.generation ?? 0) + 1;
		const world = composeWorld({ configuration, configurationHash, generation, buckets, sources: collected.sources, loadedSections, diagnostics: collected.diagnostics });
		this._state = { configuration, configurationHash, sources: collected.sources, buckets, loadedSections, world };
		return {
			world,
			report: {
				mode,
				fullRebuild,
				previousGeneration: previous?.world.generation ?? null,
				generation,
				changedSourceIds: changedSourceIds.sort(),
				removedSourceIds: removedSourceIds.sort(),
				reusedSourceIds: reusedSourceIds.sort(),
				rebuiltBucketKeys: rebuiltBucketKeys.sort(),
				reusedBucketKeys: reusedBucketKeys.sort(),
			},
		};
	}

	public setSectionLoaded(sectionId: string, loaded: boolean, expectedGeneration?: number): IBakedECSWorld {
		if (!this._state) {
			throw new Error("ECS world has not been baked.");
		}
		if (expectedGeneration !== undefined && expectedGeneration !== this._state.world.generation) {
			throw new Error(`ECS world generation changed; expected ${expectedGeneration}, current ${this._state.world.generation}.`);
		}
		const section = this._state.world.sections.find((entry) => entry.id === sectionId);
		if (!section) {
			throw new Error(`Unknown ECS section "${sectionId}".`);
		}
		if (section.loaded === loaded) {
			return this._state.world;
		}
		loaded ? this._state.loadedSections.add(sectionId) : this._state.loadedSections.delete(sectionId);
		const world = composeWorld({
			configuration: this._state.configuration,
			configurationHash: this._state.configurationHash,
			generation: this._state.world.generation + 1,
			buckets: this._state.buckets,
			sources: this._state.sources,
			loadedSections: this._state.loadedSections,
			diagnostics: this._state.world.diagnostics,
		});
		this._state.world = world;
		return world;
	}
}

/** JSON-safe, bounded debugger/MCP projection of typed ECS storage. */
export function createECSWorldSnapshot(world: IBakedECSWorld, options: IECSWorldSnapshotOptions = {}): Record<string, unknown> {
	const offset = Math.max(0, Math.floor(options.chunkOffset ?? 0));
	const limit = Math.min(256, Math.max(1, Math.floor(options.chunkLimit ?? 64)));
	const chunks = world.chunks.slice(offset, offset + limit).map((chunk) => ({
		id: chunk.id,
		bucketKey: chunk.bucketKey,
		sectionId: chunk.sectionId,
		archetype: chunk.archetype,
		componentIds: [...chunk.componentIds],
		entityIds: [...chunk.entityIds],
		entityNames: [...chunk.entityNames],
		parentEntityIds: [...chunk.parentEntityIds],
		hiddenInHierarchy: [...chunk.hiddenInHierarchy],
		authoredEntities: [...chunk.authoredEntities],
		count: chunk.count,
		capacity: chunk.capacity,
		columns: Object.fromEntries(
			Object.entries(chunk.columns).map(([key, column]) => [
				key,
				{
					componentId: column.componentId,
					fieldId: column.fieldId,
					type: column.type,
					arity: column.arity,
					...(options.includeValues ? { values: Array.from(column.values) } : {}),
				},
			])
		),
	}));
	const returnedEntityIds = new Set(chunks.flatMap((chunk) => chunk.entityIds));
	return {
		version: world.version,
		generation: world.generation,
		configurationRevision: world.configurationRevision,
		configurationHash: world.configurationHash,
		entityCount: world.entityCount,
		activeEntityCount: world.activeEntityCount,
		sections: world.sections.map((section) => ({ ...section })),
		diagnostics: [...world.diagnostics],
		sourceLeases: Object.fromEntries(
			Object.entries(world.sourceLeases)
				.filter(([entityId]) => returnedEntityIds.has(entityId))
				.map(([entityId, lease]) => [entityId, { ...lease }])
		),
		pagination: { offset, limit, returned: chunks.length, total: world.chunks.length, hasMore: offset + chunks.length < world.chunks.length },
		chunks,
	};
}

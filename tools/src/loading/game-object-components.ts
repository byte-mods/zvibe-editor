import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import { AssetContainer } from "@babylonjs/core/assetContainer";

export const gameObjectComponentStackVersion = 1;

export type GameObjectComponentType = "data" | "script" | "physics3d" | "network" | "entity";

/** Who owns the authoritative state of a replicated node. */
export type NetworkAuthority = "server" | "owner";

/**
 * Authored replication settings for one networked node.
 *
 * This is the first-party multiplayer component model: it is pure authored
 * data, so it round-trips through the normal component stack and is readable
 * at runtime by whichever transport/netcode layer the project uses. The editor
 * does not ship a transport — it authors the contract that one consumes.
 */
export interface INetworkComponentData extends Record<string, unknown> {
	/** Stable replication id, unique per scene. */
	networkId: string;
	authority: NetworkAuthority;
	syncTransform: boolean;
	syncAnimation: boolean;
	/** Replication rate in Hz. */
	sendRateHz: number;
	/** Smooth remote transforms between snapshots. */
	interpolate: boolean;
}

/**
 * Authored entity (ECS) settings for one node.
 *
 * This is the authoring + baking half of an entities workflow: the scene graph
 * stays the authoring surface, and marked nodes bake into a flat,
 * struct-of-arrays buffer that a data-oriented runtime can iterate without
 * touching Babylon nodes. The editor does not ship a job scheduler.
 */
export interface IEntityComponentData extends Record<string, unknown> {
	/** Archetype name grouping entities that share a component layout. */
	archetype: string;
	/** Numeric fields baked into parallel arrays, in stable key order. */
	values: Record<string, number>;
	/** Exclude from baking without removing the authored component. */
	bakingEnabled: boolean;
}

/** One baked archetype chunk: parallel arrays, not an array of objects. */
export interface IBakedEntityArchetype {
	archetype: string;
	/** Node ids in baked order; index i in every field array maps to entityIds[i]. */
	entityIds: string[];
	/** Field name → dense numeric column aligned to `entityIds`. */
	fields: Record<string, number[]>;
	count: number;
}

export interface IBakedEntityWorld {
	version: 1;
	archetypes: IBakedEntityArchetype[];
	entityCount: number;
}

/** Normalizes authored entity data, never throwing on malformed input. */
export function normalizeEntityComponentData(data: Readonly<Record<string, unknown>>): IEntityComponentData {
	const rawValues = data.values;
	const values: Record<string, number> = {};
	if (rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)) {
		Object.entries(rawValues as Record<string, unknown>)
			.filter(([, value]) => typeof value === "number" && Number.isFinite(value))
			.forEach(([key, value]) => (values[key] = value as number));
	}

	return {
		...data,
		archetype: typeof data.archetype === "string" && data.archetype.trim() ? data.archetype.trim() : "Default",
		values,
		bakingEnabled: data.bakingEnabled !== false,
	};
}

/**
 * Bakes every enabled entity component in the scene into archetype chunks.
 *
 * Fields are unioned per archetype and every column is densified to the same
 * length, so a missing authored value becomes 0 rather than a hole — a
 * data-oriented consumer can index any column by entity index without
 * per-entity presence checks. Archetypes and field columns are emitted in
 * sorted order so the bake is deterministic across runs.
 */
export function bakeEntityWorld(scene: Scene | AssetContainer): IBakedEntityWorld {
	const nodes = [...scene.transformNodes, ...scene.meshes, ...scene.lights, ...scene.cameras];
	const grouped = new Map<string, { ids: string[]; rows: Record<string, number>[] }>();

	nodes.forEach((node) => {
		const stack = getSerializedGameObjectComponentStack(node);
		const authored = stack?.components.find((component) => component.type === "entity" && component.enabled);
		if (!authored) {
			return;
		}
		const normalized = normalizeEntityComponentData(authored.data);
		if (!normalized.bakingEnabled) {
			return;
		}
		const bucket = grouped.get(normalized.archetype) ?? { ids: [], rows: [] };
		bucket.ids.push(node.id);
		bucket.rows.push(normalized.values);
		grouped.set(normalized.archetype, bucket);
	});

	const archetypes: IBakedEntityArchetype[] = [...grouped.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([archetype, bucket]) => {
			const fieldNames = [...new Set(bucket.rows.flatMap((row) => Object.keys(row)))].sort();
			const fields: Record<string, number[]> = {};
			fieldNames.forEach((name) => (fields[name] = bucket.rows.map((row) => row[name] ?? 0)));
			return { archetype, entityIds: [...bucket.ids], fields, count: bucket.ids.length };
		});

	return {
		version: 1,
		archetypes,
		entityCount: archetypes.reduce((total, archetype) => total + archetype.count, 0),
	};
}

export interface ISerializedGameObjectComponent {
	id: string;
	type: GameObjectComponentType;
	enabled: boolean;
	data: Record<string, unknown>;
}

export interface ISerializedGameObjectComponentStack {
	version: typeof gameObjectComponentStackVersion;
	components: ISerializedGameObjectComponent[];
}

export interface IRuntimeGameObjectComponent {
	id: string;
	type: GameObjectComponentType;
	enabled: boolean;
	order: number;
	data: Readonly<Record<string, unknown>>;
}

const runtimeComponents = new WeakMap<Node, readonly IRuntimeGameObjectComponent[]>();

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isSerializedComponent(value: unknown): value is ISerializedGameObjectComponent {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const component = value as Partial<ISerializedGameObjectComponent>;
	return (
		typeof component.id === "string" &&
		component.id.length > 0 &&
		(component.type === "data" || component.type === "script" || component.type === "physics3d" || component.type === "network" || component.type === "entity") &&
		typeof component.enabled === "boolean" &&
		Boolean(component.data) &&
		typeof component.data === "object" &&
		!Array.isArray(component.data)
	);
}

/**
 * Normalizes an authored network component payload, clamping every field to a
 * safe range. Malformed authored data must never prevent a scene from loading,
 * so unknown/invalid values fall back to conservative defaults rather than
 * throwing: server authority, transform-only sync at 20Hz with interpolation.
 */
export function normalizeNetworkComponentData(data: Readonly<Record<string, unknown>>): INetworkComponentData {
	const rawRate = typeof data.sendRateHz === "number" && Number.isFinite(data.sendRateHz) ? data.sendRateHz : 20;

	return {
		...data,
		networkId: typeof data.networkId === "string" && data.networkId.length > 0 ? data.networkId : "",
		authority: data.authority === "owner" ? "owner" : "server",
		syncTransform: data.syncTransform !== false,
		syncAnimation: data.syncAnimation === true,
		sendRateHz: Math.min(120, Math.max(1, Math.round(rawRate))),
		interpolate: data.interpolate !== false,
	};
}

/**
 * Reads the exact versioned component stack persisted by the editor.
 * Malformed or future-version data is ignored at runtime instead of preventing a scene from loading.
 */
export function getSerializedGameObjectComponentStack(node: Node): ISerializedGameObjectComponentStack | null {
	const stack = node.metadata?.babylonEditorComponentStack as Partial<ISerializedGameObjectComponentStack> | undefined;
	if (!stack || stack.version !== gameObjectComponentStackVersion || !Array.isArray(stack.components) || !stack.components.every(isSerializedComponent)) {
		return null;
	}

	return {
		version: gameObjectComponentStackVersion,
		components: stack.components.map((component) => ({
			id: component.id,
			type: component.type,
			enabled: component.enabled,
			data: cloneJsonObject(component.data),
		})),
	};
}

/** Returns the immutable runtime component view for one loaded node. */
export function getRuntimeGameObjectComponents(node: Node): readonly IRuntimeGameObjectComponent[] {
	return runtimeComponents.get(node) ?? [];
}

/** Returns one enabled runtime component by stable id. */
export function getRuntimeGameObjectComponent(node: Node, componentId: string): IRuntimeGameObjectComponent | null {
	return getRuntimeGameObjectComponents(node).find((component) => component.id === componentId) ?? null;
}

/** Returns every enabled runtime component of one registered type in authored order. */
export function getRuntimeGameObjectComponentsByType(node: Node, type: GameObjectComponentType): readonly IRuntimeGameObjectComponent[] {
	return getRuntimeGameObjectComponents(node).filter((component) => component.type === type);
}

/**
 * Materializes authored custom-data and network components before behavior scripts start.
 * Script and physics rows remain lifecycle adapters over their established runtime systems and are not duplicated here.
 */
export function configureGameObjectComponents(scene: Scene | AssetContainer): void {
	const nodes = [...scene.transformNodes, ...scene.meshes, ...scene.lights, ...scene.cameras];
	nodes.forEach((node) => {
		const stack = getSerializedGameObjectComponentStack(node);
		const components =
			stack?.components
				.map((component, order) => ({ component, order }))
				.filter(({ component }) => (component.type === "data" || component.type === "network" || component.type === "entity") && component.enabled)
				.map(({ component, order }) => {
					let data: Record<string, unknown>;
					if (component.type === "network") {
						data = normalizeNetworkComponentData(component.data);
					} else if (component.type === "entity") {
						data = normalizeEntityComponentData(component.data);
					} else {
						data = cloneJsonObject(component.data);
					}
					return Object.freeze({
						id: component.id,
						type: component.type,
						enabled: true,
						order: order + 1,
						data: Object.freeze(data),
					});
				}) ?? [];

		runtimeComponents.set(node, Object.freeze(components));
	});
}

/**
 * Returns the normalized replication settings for one node, or `null` when the
 * node is not networked. Netcode layers read this to decide what to replicate;
 * it never throws on malformed authored data.
 */
export function getNetworkComponentData(node: Node): INetworkComponentData | null {
	const component = getRuntimeGameObjectComponentsByType(node, "network")[0];
	return component ? normalizeNetworkComponentData(component.data) : null;
}

/** Removes runtime component views for nodes that are being unloaded or explicitly disposed. */
export function clearRuntimeGameObjectComponents(nodes: readonly Node[]): void {
	nodes.forEach((node) => runtimeComponents.delete(node));
}

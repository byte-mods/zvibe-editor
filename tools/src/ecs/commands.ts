import { IBakedECSChunk, IBakedECSWorld, ECSTypedArray } from "./baker";
import { getECSStableHash } from "./hash";
import { ECSFieldValue, IECSConfiguration, normalizeECSFieldValue } from "./model";

export const ECS_MAX_QUEUED_COMMANDS = 10_000;
export const ECS_MAX_RUNTIME_ENTITIES = 1_000_000;

export type ECSRuntimeCommand =
	| { kind: "set-field"; entityId: string; componentId: string; fieldId: string; value: ECSFieldValue }
	| { kind: "destroy-entity"; entityId: string }
	| { kind: "instantiate-entity"; sourceEntityId: string; entityId: string }
	| { kind: "set-section-loaded"; sectionId: string; loaded: boolean };

interface IQueuedECSCommand {
	command: ECSRuntimeCommand;
	expectedGeneration: number;
}

function cloneTypedArray(values: ECSTypedArray): ECSTypedArray {
	if (values instanceof Float64Array) {
		return new Float64Array(values);
	}
	if (values instanceof Float32Array) {
		return new Float32Array(values);
	}
	if (values instanceof Int32Array) {
		return new Int32Array(values);
	}
	if (values instanceof Uint32Array) {
		return new Uint32Array(values);
	}
	return new Uint8Array(values);
}

function createTypedArrayLike(values: ECSTypedArray, length: number): ECSTypedArray {
	if (values instanceof Float64Array) {
		return new Float64Array(length);
	}
	if (values instanceof Float32Array) {
		return new Float32Array(length);
	}
	if (values instanceof Int32Array) {
		return new Int32Array(length);
	}
	if (values instanceof Uint32Array) {
		return new Uint32Array(length);
	}
	return new Uint8Array(length);
}

function cloneWorld(world: IBakedECSWorld): IBakedECSWorld {
	return {
		...world,
		chunks: world.chunks.map((chunk) => ({
			...chunk,
			componentIds: [...chunk.componentIds],
			entityIds: [...chunk.entityIds],
			entityNames: [...chunk.entityNames],
			parentEntityIds: [...chunk.parentEntityIds],
			hiddenInHierarchy: [...chunk.hiddenInHierarchy],
			authoredEntities: [...chunk.authoredEntities],
			sourceHashes: [...chunk.sourceHashes],
			columns: Object.fromEntries(Object.entries(chunk.columns).map(([key, column]) => [key, { ...column, values: cloneTypedArray(column.values) }])),
		})),
		activeChunkIds: [...world.activeChunkIds],
		sections: world.sections.map((section) => ({ ...section })),
		sourceLeases: Object.fromEntries(Object.entries(world.sourceLeases).map(([key, lease]) => [key, { ...lease }])),
		diagnostics: [...world.diagnostics],
	};
}

function findEntity(world: IBakedECSWorld, entityId: string): { chunk: IBakedECSChunk; row: number } {
	for (const chunk of world.chunks) {
		const row = chunk.entityIds.indexOf(entityId);
		if (row !== -1) {
			return { chunk, row };
		}
	}
	throw new Error(`ECS entity "${entityId}" was not found.`);
}

function refreshWorld(world: IBakedECSWorld): void {
	const loadedSections = new Set(world.sections.filter((section) => section.loaded).map((section) => section.id));
	world.activeChunkIds = world.chunks.filter((chunk) => loadedSections.has(chunk.sectionId)).map((chunk) => chunk.id);
	world.entityCount = world.chunks.reduce((total, chunk) => total + chunk.count, 0);
	world.activeEntityCount = world.chunks.filter((chunk) => loadedSections.has(chunk.sectionId)).reduce((total, chunk) => total + chunk.count, 0);
	for (const section of world.sections) {
		const chunks = world.chunks.filter((chunk) => chunk.sectionId === section.id);
		section.chunkCount = chunks.length;
		section.entityCount = chunks.reduce((total, chunk) => total + chunk.count, 0);
		section.activeEntityCount = section.loaded ? section.entityCount : 0;
	}
}

function setField(world: IBakedECSWorld, configuration: IECSConfiguration, command: Extract<ECSRuntimeCommand, { kind: "set-field" }>): void {
	const { chunk, row } = findEntity(world, command.entityId);
	const key = `${command.componentId}.${command.fieldId}`;
	const column = chunk.columns[key];
	if (!column) {
		throw new Error(`ECS entity "${command.entityId}" does not contain field "${key}".`);
	}
	const field = configuration.componentTypes.find((component) => component.id === command.componentId)?.fields.find((entry) => entry.id === command.fieldId);
	if (!field) {
		throw new Error(`ECS field "${key}" is not authorable at runtime.`);
	}
	const normalized = normalizeECSFieldValue(field.type, command.value, `ECS command ${command.entityId}.${key}`);
	const lanes = Array.isArray(normalized) ? normalized : [typeof normalized === "boolean" ? (normalized ? 1 : 0) : normalized];
	for (const lane of lanes) {
		if (typeof lane === "number" && ((field.minimum !== undefined && lane < field.minimum) || (field.maximum !== undefined && lane > field.maximum))) {
			throw new Error(`ECS command ${command.entityId}.${key} is outside configured bounds.`);
		}
	}
	for (let lane = 0; lane < column.arity; lane++) {
		column.values[row * column.arity + lane] = lanes[lane];
	}
}

function destroyEntity(world: IBakedECSWorld, entityId: string): void {
	const { chunk, row } = findEntity(world, entityId);
	if (chunk.count === 1) {
		world.chunks = world.chunks.filter((entry) => entry !== chunk);
	} else {
		chunk.entityIds.splice(row, 1);
		chunk.entityNames.splice(row, 1);
		chunk.parentEntityIds.splice(row, 1);
		chunk.hiddenInHierarchy.splice(row, 1);
		chunk.authoredEntities.splice(row, 1);
		chunk.sourceHashes.splice(row, 1);
		for (const column of Object.values(chunk.columns)) {
			const next = createTypedArrayLike(column.values, (chunk.count - 1) * column.arity);
			const start = row * column.arity;
			next.set(column.values.subarray(0, start), 0);
			next.set(column.values.subarray(start + column.arity), start);
			column.values = next;
		}
		chunk.count--;
	}
	delete world.sourceLeases[entityId];
}

function instantiateEntity(world: IBakedECSWorld, command: Extract<ECSRuntimeCommand, { kind: "instantiate-entity" }>): void {
	if (!command.entityId || world.sourceLeases[command.entityId] || world.chunks.some((chunk) => chunk.entityIds.includes(command.entityId))) {
		throw new Error(`ECS entity id "${command.entityId}" is empty or already exists.`);
	}
	if (world.entityCount >= ECS_MAX_RUNTIME_ENTITIES) {
		throw new Error(`ECS runtime exceeds the ${ECS_MAX_RUNTIME_ENTITIES} entity limit.`);
	}
	const { chunk, row } = findEntity(world, command.sourceEntityId);
	let target = chunk;
	if (chunk.count >= chunk.capacity) {
		target = {
			...chunk,
			id: `ecs-runtime-chunk-${getECSStableHash({ source: command.sourceEntityId, entity: command.entityId, generation: world.generation })}`,
			entityIds: [],
			entityNames: [],
			parentEntityIds: [],
			hiddenInHierarchy: [],
			authoredEntities: [],
			sourceHashes: [],
			columns: Object.fromEntries(Object.entries(chunk.columns).map(([key, column]) => [key, { ...column, values: createTypedArrayLike(column.values, 0) }])),
			count: 0,
		};
		world.chunks.push(target);
	}
	for (const [key, sourceColumn] of Object.entries(chunk.columns)) {
		const targetColumn = target.columns[key];
		const next = createTypedArrayLike(targetColumn.values, (target.count + 1) * targetColumn.arity);
		next.set(targetColumn.values);
		for (let lane = 0; lane < targetColumn.arity; lane++) {
			next[target.count * targetColumn.arity + lane] = sourceColumn.values[row * sourceColumn.arity + lane];
		}
		targetColumn.values = next;
	}
	const sourceHash = `runtime-${getECSStableHash({ sourceHash: chunk.sourceHashes[row], entityId: command.entityId })}`;
	target.entityIds.push(command.entityId);
	target.entityNames.push(command.entityId);
	target.parentEntityIds.push(null);
	target.hiddenInHierarchy.push(chunk.hiddenInHierarchy[row]);
	target.authoredEntities.push(false);
	target.sourceHashes.push(sourceHash);
	target.count++;
	world.sourceLeases[command.entityId] = { entityId: command.entityId, sectionId: target.sectionId, bucketKey: target.bucketKey, sourceHash };
}

function applyCommand(world: IBakedECSWorld, configuration: IECSConfiguration, command: ECSRuntimeCommand): void {
	switch (command.kind) {
		case "set-field":
			setField(world, configuration, command);
			break;
		case "destroy-entity":
			destroyEntity(world, command.entityId);
			break;
		case "instantiate-entity":
			instantiateEntity(world, command);
			break;
		case "set-section-loaded": {
			const section = world.sections.find((entry) => entry.id === command.sectionId);
			if (!section) {
				throw new Error(`Unknown ECS section "${command.sectionId}".`);
			}
			section.loaded = command.loaded;
			break;
		}
	}
}

/** Atomic deferred structural mutation queue, played back after system iteration. */
export class ECSCommandBuffer {
	private readonly _commands: IQueuedECSCommand[] = [];

	public get count(): number {
		return this._commands.length;
	}

	public enqueue(command: ECSRuntimeCommand, expectedGeneration: number): void {
		if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
			throw new Error("ECS command expectedGeneration must be a positive integer.");
		}
		if (this._commands.length >= ECS_MAX_QUEUED_COMMANDS) {
			throw new Error(`ECS command buffer exceeds ${ECS_MAX_QUEUED_COMMANDS} commands.`);
		}
		this._commands.push({ command, expectedGeneration });
	}

	public clear(): void {
		this._commands.length = 0;
	}

	public playback(world: IBakedECSWorld, configuration: IECSConfiguration): { world: IBakedECSWorld; applied: number } {
		if (!this._commands.length) {
			return { world, applied: 0 };
		}
		const commands = this._commands.splice(0);
		for (const queued of commands) {
			if (queued.expectedGeneration !== world.generation) {
				throw new Error(`ECS command generation changed; expected ${queued.expectedGeneration}, current ${world.generation}.`);
			}
		}
		const candidate = cloneWorld(world);
		for (const queued of commands) {
			applyCommand(candidate, configuration, queued.command);
		}
		candidate.generation++;
		refreshWorld(candidate);
		return { world: candidate, applied: commands.length };
	}
}

/** Bounded debugger query over runtime entities and optional column values. */
export function queryECSWorld(
	world: IBakedECSWorld,
	query: {
		all?: string[];
		any?: string[];
		none?: string[];
		sectionId?: string;
		loadedOnly?: boolean;
		includeValues?: boolean;
		search?: string;
		showHidden?: boolean;
		origin?: "authoring" | "runtime";
		offset?: number;
		limit?: number;
	} = {}
): Record<string, unknown> {
	const all = new Set(query.all ?? []);
	const any = new Set(query.any ?? []);
	const none = new Set(query.none ?? []);
	const activeChunks = new Set(world.activeChunkIds);
	const rows: Array<Record<string, unknown>> = [];
	for (const chunk of world.chunks) {
		const components = new Set(chunk.componentIds);
		if (
			(query.sectionId && chunk.sectionId !== query.sectionId) ||
			(query.loadedOnly && !activeChunks.has(chunk.id)) ||
			![...all].every((id) => components.has(id)) ||
			(any.size > 0 && ![...any].some((id) => components.has(id))) ||
			[...none].some((id) => components.has(id))
		) {
			continue;
		}
		for (let row = 0; row < chunk.count; row++) {
			const origin = chunk.authoredEntities[row] ? "authoring" : "runtime";
			const search = query.search?.trim().toLowerCase();
			const searchable = `${chunk.entityIds[row]} ${chunk.entityNames[row]} ${chunk.archetype} ${chunk.sectionId} ${chunk.componentIds.join(" ")}`.toLowerCase();
			if ((!query.showHidden && chunk.hiddenInHierarchy[row]) || (query.origin && origin !== query.origin) || (search && !searchable.includes(search))) {
				continue;
			}
			const values = query.includeValues
				? Object.fromEntries(Object.entries(chunk.columns).map(([key, column]) => [key, Array.from(column.values.slice(row * column.arity, (row + 1) * column.arity))]))
				: undefined;
			rows.push({
				entityId: chunk.entityIds[row],
				name: chunk.entityNames[row],
				parentEntityId: chunk.parentEntityIds[row],
				hiddenInHierarchy: chunk.hiddenInHierarchy[row],
				origin,
				sectionId: chunk.sectionId,
				archetype: chunk.archetype,
				componentIds: [...chunk.componentIds],
				chunkId: chunk.id,
				row,
				...(values ? { values } : {}),
			});
		}
	}
	const offset = Math.max(0, Math.floor(query.offset ?? 0));
	const limit = Math.min(1000, Math.max(1, Math.floor(query.limit ?? 100)));
	return {
		total: rows.length,
		offset,
		limit,
		returned: rows.slice(offset, offset + limit).length,
		hasMore: offset + limit < rows.length,
		entities: rows.slice(offset, offset + limit),
	};
}

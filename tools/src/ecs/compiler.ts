import { IBakedECSChunk } from "./baker";
import { getECSStableHash } from "./hash";
import {
	ECSFieldType,
	ECSOperationKind,
	ECSSystemPhase,
	IECSConfiguration,
	IECSQueryDefinition,
	normalizeECSConfiguration,
	getECSFieldArity,
	isECSComponentTypeRegistered,
} from "./model";

export const ECS_COMPILED_SCHEDULE_VERSION = 1 as const;
export const ECS_PORTABLE_KERNEL_BACKEND = "portable-typed-array" as const;

export interface ICompiledECSOperation {
	id: string;
	kind: ECSOperationKind;
	targetKey: string;
	targetType: ECSFieldType;
	targetArity: number;
	sourceKey?: string;
	sourceType?: ECSFieldType;
	constant: number;
	minimum?: number;
	maximum?: number;
	useDeltaTime: boolean;
}

export interface ICompiledECSSystem {
	id: string;
	name: string;
	namespace: string;
	phase: ECSSystemPhase;
	order: number;
	query: IECSQueryDefinition;
	readKeys: string[];
	writeKeys: string[];
	dependsOn: string[];
	operations: ICompiledECSOperation[];
	workerEligible: boolean;
}

export interface ICompiledECSBatch {
	index: number;
	systemIds: string[];
}

export interface ICompiledECSPhaseSchedule {
	phase: ECSSystemPhase;
	batches: ICompiledECSBatch[];
}

export interface ICompiledECSSchedule {
	version: typeof ECS_COMPILED_SCHEDULE_VERSION;
	configurationHash: string;
	scheduleHash: string;
	backend: typeof ECS_PORTABLE_KERNEL_BACKEND;
	systems: Record<string, ICompiledECSSystem>;
	phases: Record<ECSSystemPhase, ICompiledECSPhaseSchedule>;
	diagnostics: string[];
}

const phaseOrder: Record<ECSSystemPhase, number> = { fixed: 0, update: 1, late: 2 };
const fieldKey = (componentId: string, fieldId: string): string => `${componentId}.${fieldId}`;

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
		Object.freeze(value);
	}
	return value;
}

function intersects(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
	for (const value of first) {
		if (second.has(value)) {
			return true;
		}
	}
	return false;
}

function systemsConflict(first: ICompiledECSSystem, second: ICompiledECSSystem): boolean {
	const firstReads = new Set(first.readKeys);
	const firstWrites = new Set(first.writeKeys);
	const secondReads = new Set(second.readKeys);
	const secondWrites = new Set(second.writeKeys);
	return intersects(firstWrites, secondWrites) || intersects(firstWrites, secondReads) || intersects(secondWrites, firstReads);
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
	if (from !== to) {
		edges.get(from)!.add(to);
	}
}

function topologicalOrder(systems: readonly ICompiledECSSystem[], edges: ReadonlyMap<string, ReadonlySet<string>>): ICompiledECSSystem[] {
	const byId = new Map(systems.map((system) => [system.id, system]));
	const indegree = new Map(systems.map((system) => [system.id, 0]));
	for (const targets of edges.values()) {
		for (const target of targets) {
			indegree.set(target, (indegree.get(target) ?? 0) + 1);
		}
	}
	const compare = (a: ICompiledECSSystem, b: ICompiledECSSystem): number => a.order - b.order || a.id.localeCompare(b.id);
	const ready = systems.filter((system) => indegree.get(system.id) === 0).sort(compare);
	const ordered: ICompiledECSSystem[] = [];
	while (ready.length) {
		const system = ready.shift()!;
		ordered.push(system);
		for (const target of edges.get(system.id) ?? []) {
			const next = indegree.get(target)! - 1;
			indegree.set(target, next);
			if (next === 0) {
				ready.push(byId.get(target)!);
				ready.sort(compare);
			}
		}
	}
	if (ordered.length !== systems.length) {
		const cyclic = systems
			.filter((system) => !ordered.includes(system))
			.map((system) => system.id)
			.sort();
		throw new Error(`ECS system dependency cycle detected: ${cyclic.join(", ")}.`);
	}
	return ordered;
}

function createPhaseSchedule(phase: ECSSystemPhase, systems: readonly ICompiledECSSystem[]): ICompiledECSPhaseSchedule {
	const explicitEdges = new Map(systems.map((system) => [system.id, new Set<string>()]));
	const ids = new Set(systems.map((system) => system.id));
	for (const system of systems) {
		for (const dependency of system.dependsOn) {
			if (ids.has(dependency)) {
				addEdge(explicitEdges, dependency, system.id);
			}
		}
	}
	const explicitOrder = topologicalOrder(systems, explicitEdges);
	const position = new Map(explicitOrder.map((system, index) => [system.id, index]));
	const edges = new Map([...explicitEdges].map(([id, targets]) => [id, new Set(targets)]));
	for (let firstIndex = 0; firstIndex < systems.length; firstIndex++) {
		for (let secondIndex = firstIndex + 1; secondIndex < systems.length; secondIndex++) {
			const first = systems[firstIndex];
			const second = systems[secondIndex];
			if (systemsConflict(first, second)) {
				const [from, to] = position.get(first.id)! < position.get(second.id)! ? [first.id, second.id] : [second.id, first.id];
				addEdge(edges, from, to);
			}
		}
	}

	const ordered = topologicalOrder(systems, edges);
	const indegree = new Map(systems.map((system) => [system.id, 0]));
	for (const targets of edges.values()) {
		for (const target of targets) {
			indegree.set(target, indegree.get(target)! + 1);
		}
	}
	const remaining = new Set(ordered.map((system) => system.id));
	const batches: ICompiledECSBatch[] = [];
	while (remaining.size) {
		const systemIds = ordered.filter((system) => remaining.has(system.id) && indegree.get(system.id) === 0).map((system) => system.id);
		if (!systemIds.length) {
			throw new Error(`ECS ${phase} schedule could not create a dependency batch.`);
		}
		batches.push({ index: batches.length, systemIds });
		for (const systemId of systemIds) {
			remaining.delete(systemId);
			for (const target of edges.get(systemId) ?? []) {
				indegree.set(target, indegree.get(target)! - 1);
			}
		}
	}
	return { phase, batches };
}

/**
 * Compiles declarative systems into immutable numeric operation plans and a
 * conflict-free dependency schedule. This portable backend is Burst-style in
 * data layout only; it does not claim Unity Burst LLVM/native compilation.
 */
export function compileECSConfiguration(value: IECSConfiguration): ICompiledECSSchedule {
	const configuration = normalizeECSConfiguration(value);
	const fields = new Map(
		configuration.componentTypes.flatMap((component) => component.fields.map((field) => [fieldKey(component.id, field.id), { componentId: component.id, field }] as const))
	);
	const authoredSystems = new Map(configuration.systems.map((system) => [system.id, system]));
	const systems: ICompiledECSSystem[] = configuration.systems
		.filter((system) => system.enabled)
		.map((system) => {
			const referencedComponents = new Set([
				...system.query.all,
				...system.query.any,
				...system.query.none,
				...system.reads.map((reference) => reference.componentId),
				...system.writes.map((reference) => reference.componentId),
			]);
			for (const componentId of referencedComponents) {
				if (!isECSComponentTypeRegistered(configuration, componentId)) {
					throw new Error(`ECS system "${system.id}" references unregistered component "${componentId}". Update its assembly registration policy before compiling.`);
				}
			}
			for (const dependencyId of system.dependsOn) {
				const dependency = authoredSystems.get(dependencyId)!;
				if (dependency.enabled && phaseOrder[dependency.phase] > phaseOrder[system.phase]) {
					throw new Error(`ECS system "${system.id}" cannot depend on later ${dependency.phase} system "${dependencyId}".`);
				}
			}
			const accessedComponents = new Set([...system.reads, ...system.writes].map((reference) => reference.componentId));
			for (const componentId of accessedComponents) {
				if (!system.query.all.includes(componentId)) {
					throw new Error(`ECS system "${system.id}" must include accessed component "${componentId}" in query.all.`);
				}
			}
			const operations = system.operations.map((operation): ICompiledECSOperation => {
				const targetKey = fieldKey(operation.target.componentId, operation.target.fieldId);
				const target = fields.get(targetKey)!.field;
				const sourceKey = operation.source ? fieldKey(operation.source.componentId, operation.source.fieldId) : undefined;
				const source = sourceKey ? fields.get(sourceKey)!.field : undefined;
				if (["set", "add", "multiply"].includes(operation.kind) && operation.constant === undefined) {
					throw new Error(`ECS operation "${system.id}.${operation.id}" requires constant.`);
				}
				if (target.type === "bool" && operation.kind !== "copy") {
					throw new Error(`ECS operation "${system.id}.${operation.id}" cannot apply ${operation.kind} to a boolean field.`);
				}
				if (source && getECSFieldArity(source.type) !== getECSFieldArity(target.type)) {
					throw new Error(`ECS operation "${system.id}.${operation.id}" requires source and target fields with equal lane counts.`);
				}
				if (operation.kind === "copy" && source && (target.type === "bool") !== (source.type === "bool")) {
					throw new Error(`ECS operation "${system.id}.${operation.id}" cannot copy between boolean and numeric fields.`);
				}
				return {
					id: operation.id,
					kind: operation.kind,
					targetKey,
					targetType: target.type,
					targetArity: getECSFieldArity(target.type),
					sourceKey,
					sourceType: source?.type,
					constant: operation.constant ?? 1,
					minimum: operation.minimum,
					maximum: operation.maximum,
					useDeltaTime: operation.useDeltaTime,
				};
			});
			return {
				id: system.id,
				name: system.name,
				namespace: system.namespace,
				phase: system.phase,
				order: system.order,
				query: {
					all: [...system.query.all],
					any: [...system.query.any],
					none: [...system.query.none],
				},
				readKeys: system.reads.map((reference) => fieldKey(reference.componentId, reference.fieldId)).sort(),
				writeKeys: system.writes.map((reference) => fieldKey(reference.componentId, reference.fieldId)).sort(),
				dependsOn: system.dependsOn.filter((dependencyId) => authoredSystems.get(dependencyId)?.enabled).sort(),
				operations,
				workerEligible: operations.length > 0,
			};
		});
	const systemRecord = Object.fromEntries(systems.map((system) => [system.id, system]));
	const phases = Object.fromEntries(
		(["fixed", "update", "late"] as const).map((phase) => [
			phase,
			createPhaseSchedule(
				phase,
				systems.filter((system) => system.phase === phase)
			),
		])
	) as Record<ECSSystemPhase, ICompiledECSPhaseSchedule>;
	const configurationHash = getECSStableHash(configuration);
	const scheduleShape = { configurationHash, systems: systemRecord, phases };
	return deepFreeze({
		version: ECS_COMPILED_SCHEDULE_VERSION,
		configurationHash,
		scheduleHash: getECSStableHash(scheduleShape),
		backend: ECS_PORTABLE_KERNEL_BACKEND,
		systems: systemRecord,
		phases,
		diagnostics: ["Portable typed-array kernels are enabled. This is not Unity Burst LLVM/native compilation and does not produce native machine-code binaries."],
	});
}

/** Returns whether an archetype chunk is included by a compiled system query. */
export function matchesCompiledECSQuery(chunk: IBakedECSChunk, query: IECSQueryDefinition): boolean {
	const components = new Set(chunk.componentIds);
	return query.all.every((id) => components.has(id)) && (!query.any.length || query.any.some((id) => components.has(id))) && query.none.every((id) => !components.has(id));
}

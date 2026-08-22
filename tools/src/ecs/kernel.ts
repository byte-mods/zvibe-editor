import { IBakedECSChunk } from "./baker";
import { ICompiledECSOperation, ICompiledECSSystem, matchesCompiledECSQuery } from "./compiler";

function executeOperation(operation: ICompiledECSOperation, chunk: IBakedECSChunk, deltaSeconds: number): number {
	const target = chunk.columns[operation.targetKey];
	if (!target) {
		throw new Error(`ECS chunk "${chunk.id}" is missing compiled target column "${operation.targetKey}".`);
	}
	const source = operation.sourceKey ? chunk.columns[operation.sourceKey] : undefined;
	if (operation.sourceKey && !source) {
		throw new Error(`ECS chunk "${chunk.id}" is missing compiled source column "${operation.sourceKey}".`);
	}
	const factor = operation.useDeltaTime ? deltaSeconds : 1;
	const lanes = chunk.count * operation.targetArity;
	for (let index = 0; index < lanes; index++) {
		switch (operation.kind) {
			case "set":
				target.values[index] = operation.constant * factor;
				break;
			case "add":
				target.values[index] += operation.constant * factor;
				break;
			case "multiply":
				target.values[index] *= operation.constant * factor;
				break;
			case "copy":
				target.values[index] = source!.values[index] * factor;
				break;
			case "integrate":
				target.values[index] += source!.values[index] * operation.constant * factor;
				break;
			case "clamp":
				target.values[index] = Math.min(operation.maximum!, Math.max(operation.minimum!, target.values[index]));
				break;
		}
	}
	return lanes;
}

/** Executes one prevalidated portable kernel without allocating per entity. */
export function executeCompiledECSSystemOnChunk(system: ICompiledECSSystem, chunk: IBakedECSChunk, deltaSeconds: number): number {
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
		throw new Error("ECS deltaSeconds must be finite and between 0 and 1.");
	}
	if (!matchesCompiledECSQuery(chunk, system.query)) {
		return 0;
	}
	let scalarWrites = 0;
	for (const operation of system.operations) {
		scalarWrites += executeOperation(operation, chunk, deltaSeconds);
	}
	return scalarWrites;
}

import { createHash } from "crypto";

import { NodeParticleBlock, NodeParticleBlockConnectionPointTypes, NodeParticleSystemSet, Scene } from "babylonjs";

import { isNodeParticleSystemSetMesh } from "../../tools/guards/particles";
import { NodeParticleSystemSetMesh } from "../../editor/nodes/node-particle-system";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

interface IBlockSelector {
	blockId?: number;
	blockName?: string;
}

const maximumBlocks = 512;

function resolveSetNode(scene: Scene, data: Record<string, unknown>): NodeParticleSystemSetMesh {
	const node = resolveNode({ scene, nodeId: data.nodeId as string | undefined, nodeName: data.nodeName as string | undefined });
	if (!isNodeParticleSystemSetMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Node Particle System Set.`);
	}
	if (!node.nodeParticleSystemSet) {
		throw new Error(`Node Particle System "${node.name}" has no graph.`);
	}
	return node;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonical(child)])
		);
	}
	return value;
}

function fingerprint(set: NodeParticleSystemSet): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(set.serialize())))
		.digest("hex");
}

function typeName(type: NodeParticleBlockConnectionPointTypes): string {
	return NodeParticleBlockConnectionPointTypes[type] ?? String(type);
}

function edges(set: NodeParticleSystemSet): Array<{
	id: string;
	sourceBlockId: number;
	sourceBlockName: string;
	sourceOutput: string;
	targetBlockId: number;
	targetBlockName: string;
	targetInput: string;
}> {
	return set.attachedBlocks.flatMap((block) =>
		block.outputs.flatMap((output) =>
			output.endpoints.map((endpoint) => ({
				id: `${block.uniqueId}:${output.name}->${endpoint.ownerBlock.uniqueId}:${endpoint.name}`,
				sourceBlockId: block.uniqueId,
				sourceBlockName: block.name,
				sourceOutput: output.name,
				targetBlockId: endpoint.ownerBlock.uniqueId,
				targetBlockName: endpoint.ownerBlock.name,
				targetInput: endpoint.name,
			}))
		)
	);
}

function reachableIds(set: NodeParticleSystemSet): Set<number> {
	const result = new Set<number>();
	const visit = (block: NodeParticleBlock): void => {
		if (result.has(block.uniqueId)) {
			return;
		}
		result.add(block.uniqueId);
		for (const input of block.inputs) {
			if (input.connectedPoint) {
				visit(input.connectedPoint.ownerBlock);
			}
		}
	};
	for (const block of set.systemBlocks) {
		visit(block);
	}
	return result;
}

function resolveBlock(set: NodeParticleSystemSet, selector: IBlockSelector, role: string): NodeParticleBlock {
	if (selector.blockId !== undefined) {
		const block = set.attachedBlocks.find((candidate) => candidate.uniqueId === selector.blockId);
		if (!block) {
			throw new Error(`${role} block id was not found: ${selector.blockId}. Read get_node_particle_code_graph again.`);
		}
		return block;
	}
	const name = selector.blockName?.trim();
	if (!name) {
		throw new Error(`${role} requires blockId or blockName.`);
	}
	const matches = set.attachedBlocks.filter((candidate) => candidate.name === name);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `${role} block name is ambiguous: ${name}. Use blockId.` : `${role} block was not found: ${name}.`);
	}
	return matches[0];
}

function blockCanReach(start: NodeParticleBlock, target: NodeParticleBlock, visited = new Set<number>()): boolean {
	if (start === target) {
		return true;
	}
	if (visited.has(start.uniqueId)) {
		return false;
	}
	visited.add(start.uniqueId);
	return start.outputs.some((output) => output.endpoints.some((endpoint) => blockCanReach(endpoint.ownerBlock, target, visited)));
}

function summarizeBlock(block: NodeParticleBlock, reachable: Set<number>): Record<string, unknown> {
	return {
		id: block.uniqueId,
		name: block.name,
		className: block.getClassName(),
		reachable: reachable.has(block.uniqueId),
		isSystem: block.isSystem,
		isInput: block.isInput,
		isDebug: block.isDebug,
		inputs: block.inputs.map((input) => ({
			name: input.name,
			type: input.type,
			typeName: typeName(input.type),
			optional: input.isOptional,
			connected: input.isConnected,
			value: input.isConnected ? undefined : structuredClone(input.value),
			valueMin: structuredClone(input.valueMin),
			valueMax: structuredClone(input.valueMax),
			source: input.connectedPoint
				? { blockId: input.connectedPoint.ownerBlock.uniqueId, blockName: input.connectedPoint.ownerBlock.name, output: input.connectedPoint.name }
				: null,
		})),
		outputs: block.outputs.map((output) => ({ name: output.name, type: output.type, typeName: typeName(output.type), endpointCount: output.endpoints.length })),
	};
}

/** Returns the shared bounded visual VFX port graph used by MCP and the Inspector. */
export function getNodeParticleCodeGraph(scene: Scene, data: Record<string, unknown>): Record<string, unknown> {
	const node = resolveSetNode(scene, data);
	const set = node.nodeParticleSystemSet!;
	if (set.attachedBlocks.length > maximumBlocks) {
		throw new Error(`Node Particle graph has ${set.attachedBlocks.length} blocks; at most ${maximumBlocks} are supported.`);
	}
	const offset = data.offset === undefined ? 0 : Number(data.offset);
	const limit = data.limit === undefined ? 64 : Number(data.limit);
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error("Node Particle graph offset must be a non-negative integer.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("Node Particle graph limit must be from 1 through 256.");
	}
	const query = typeof data.query === "string" ? data.query.trim().toLowerCase() : "";
	const all = [...set.attachedBlocks]
		.sort((left, right) => left.uniqueId - right.uniqueId)
		.filter((block) => !query || block.name.toLowerCase().includes(query) || block.getClassName().toLowerCase().includes(query));
	const selected = all.slice(offset, offset + limit);
	const selectedIds = new Set(selected.map((block) => block.uniqueId));
	const graphEdges = edges(set);
	const reachable = reachableIds(set);
	return {
		node: toNodeSummary(node),
		totalCount: all.length,
		count: selected.length,
		offset,
		limit,
		hasMore: offset + selected.length < all.length,
		nextOffset: offset + selected.length < all.length ? offset + selected.length : null,
		nodes: selected.map((block) => summarizeBlock(block, reachable)),
		edges: graphEdges.filter((edge) => selectedIds.has(edge.sourceBlockId) || selectedIds.has(edge.targetBlockId)),
		edgeCount: graphEdges.length,
		reachableBlockCount: reachable.size,
		systemBlockCount: set.systemBlocks.length,
		fingerprint: fingerprint(set),
	};
}

function candidateFor(set: NodeParticleSystemSet): NodeParticleSystemSet {
	const serialized = set.serialize();
	const candidate = NodeParticleSystemSet.Parse({ ...serialized, id: (set as any).id, uniqueId: (set as any).uniqueId });
	if (candidate.attachedBlocks.length !== set.attachedBlocks.length) {
		candidate.dispose();
		throw new Error("Node Particle graph contains an unregistered block type and cannot be edited safely.");
	}
	for (let index = 0; index < candidate.attachedBlocks.length; index++) {
		candidate.attachedBlocks[index].uniqueId = set.attachedBlocks[index].uniqueId;
	}
	return candidate;
}

async function publish(node: NodeParticleSystemSetMesh, candidate: NodeParticleSystemSet, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const serialized = { ...candidate.serialize(), id: (candidate as any).id, uniqueId: (candidate as any).uniqueId };
	await node.buildNodeParticleSystemSet(serialized);
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(node));
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getNodeParticleCodeGraph(node.getScene(), { nodeId: node.id, limit: 256 });
}

/** Connects exact VFX graph ports and publishes only after the rebuilt graph succeeds. */
export async function connectNodeParticleBlocks(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const node = resolveSetNode(scene, data);
	const candidate = candidateFor(node.nodeParticleSystemSet!);
	try {
		const source = resolveBlock(candidate, { blockId: data.sourceBlockId as number | undefined, blockName: data.sourceBlockName as string | undefined }, "Source");
		const target = resolveBlock(candidate, { blockId: data.targetBlockId as number | undefined, blockName: data.targetBlockName as string | undefined }, "Target");
		const output = source.outputs.find((port) => port.name === String(data.sourceOutput));
		const input = target.inputs.find((port) => port.name === String(data.targetInput));
		if (!output) {
			throw new Error(`Source output was not found: ${source.name}.${String(data.sourceOutput)}.`);
		}
		if (!input) {
			throw new Error(`Target input was not found: ${target.name}.${String(data.targetInput)}.`);
		}
		if (input.connectedPoint === output) {
			return getNodeParticleCodeGraph(scene, { nodeId: node.id, limit: 256 });
		}
		if (source === target || blockCanReach(target, source)) {
			throw new Error(`Connecting ${source.name}.${output.name} to ${target.name}.${input.name} would create a VFX graph cycle.`);
		}
		if (!output.canConnectTo(input)) {
			throw new Error(`Incompatible or cyclic VFX ports: ${source.name}.${output.name} cannot connect to ${target.name}.${input.name}.`);
		}
		const previous = input.connectedPoint;
		if (previous && data.replace !== true) {
			throw new Error(`Target input ${target.name}.${input.name} is already connected. Pass replace=true to replace it.`);
		}
		if (previous) {
			previous.disconnectFrom(input);
		}
		output.connectTo(input);
		return await publish(node, candidate, options);
	} finally {
		candidate.dispose();
	}
}

/** Disconnects one exact VFX graph input with optional stale-source guards. */
export async function disconnectNodeParticleBlocks(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const node = resolveSetNode(scene, data);
	const candidate = candidateFor(node.nodeParticleSystemSet!);
	try {
		const target = resolveBlock(candidate, { blockId: data.targetBlockId as number | undefined, blockName: data.targetBlockName as string | undefined }, "Target");
		const input = target.inputs.find((port) => port.name === String(data.targetInput));
		if (!input) {
			throw new Error(`Target input was not found: ${target.name}.${String(data.targetInput)}.`);
		}
		const previous = input.connectedPoint;
		if (!previous) {
			return getNodeParticleCodeGraph(scene, { nodeId: node.id, limit: 256 });
		}
		if (data.sourceBlockId !== undefined && previous.ownerBlock.uniqueId !== data.sourceBlockId) {
			throw new Error("The VFX edge source changed after inspection.");
		}
		if (data.sourceBlockName !== undefined && previous.ownerBlock.name !== data.sourceBlockName) {
			throw new Error("The VFX edge source name changed after inspection.");
		}
		if (data.sourceOutput !== undefined && previous.name !== data.sourceOutput) {
			throw new Error("The VFX edge source output changed after inspection.");
		}
		previous.disconnectFrom(input);
		return await publish(node, candidate, options);
	} finally {
		candidate.dispose();
	}
}

function coerceInputValue(type: NodeParticleBlockConnectionPointTypes, value: unknown): unknown {
	if ([NodeParticleBlockConnectionPointTypes.Float, NodeParticleBlockConnectionPointTypes.Int].includes(type) && typeof value !== "number") {
		throw new Error(`VFX input ${typeName(type)} requires a number.`);
	}
	return structuredClone(value);
}

/** Updates one disconnected embedded input value and atomically rebuilds the VFX graph. */
export async function setNodeParticleBlockInput(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const node = resolveSetNode(scene, data);
	const candidate = candidateFor(node.nodeParticleSystemSet!);
	try {
		const block = resolveBlock(candidate, { blockId: data.blockId as number | undefined, blockName: data.blockName as string | undefined }, "Block");
		const input = block.inputs.find((port) => port.name === String(data.input));
		if (!input) {
			throw new Error(`VFX input was not found: ${block.name}.${String(data.input)}.`);
		}
		if (input.isConnected) {
			throw new Error(`VFX input ${block.name}.${input.name} is connected; disconnect it before setting an embedded value.`);
		}
		input.value = coerceInputValue(input.type, data.value);
		return await publish(node, candidate, options);
	} finally {
		candidate.dispose();
	}
}

/** Builds an isolated clone and returns actionable VFX graph diagnostics without changing the scene graph. */
export async function validateNodeParticleCodeGraph(scene: Scene, data: Record<string, unknown>): Promise<Record<string, unknown>> {
	const node = resolveSetNode(scene, data);
	const set = node.nodeParticleSystemSet!;
	const candidate = candidateFor(set);
	const errors: string[] = [];
	let builtSystems = 0;
	let builtSet: any = null;
	try {
		builtSet = await candidate.buildAsync(scene, false);
		builtSystems = builtSet.systems.length;
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		builtSet?.dispose();
		candidate.dispose();
	}
	const reachable = reachableIds(set);
	const disconnectedRequiredInputs = set.attachedBlocks.flatMap((block) =>
		block.inputs.filter((input) => !input.isOptional && !input.isConnected && (input.value === null || input.value === undefined)).map((input) => `${block.name}.${input.name}`)
	);
	return {
		node: toNodeSummary(node),
		valid: errors.length === 0,
		errors: [...new Set(errors)],
		warnings: [
			...(disconnectedRequiredInputs.length ? [`Required inputs are disconnected: ${disconnectedRequiredInputs.join(", ")}.`] : []),
			...(reachable.size < set.attachedBlocks.length ? [`${set.attachedBlocks.length - reachable.size} block(s) cannot reach a SystemBlock.`] : []),
		],
		statistics: {
			blockCount: set.attachedBlocks.length,
			edgeCount: edges(set).length,
			reachableBlockCount: reachable.size,
			systemBlockCount: set.systemBlocks.length,
			builtSystemCount: builtSystems,
		},
		fingerprint: fingerprint(set),
	};
}

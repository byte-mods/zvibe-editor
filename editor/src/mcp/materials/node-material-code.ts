import { createHash } from "crypto";

import {
	Color3,
	Color4,
	CustomBlock,
	InputBlock,
	NodeMaterial,
	NodeMaterialBlock,
	NodeMaterialBlockConnectionPointTypes,
	NodeMaterialConnectionPoint,
	Scene,
	Vector2,
	Vector3,
	Vector4,
} from "babylonjs";

import { isNodeMaterial } from "../../tools/guards/material";

import { IMCPActionOptions } from "../action";
import { resolveMaterial } from "../tools/resolve";

interface INodeMaterialOptimizationSettings {
	stripUnreachable: boolean;
	simplifyIdentityMath: boolean;
	foldConstants: boolean;
	mergeDuplicateConstants: boolean;
	minifyCustomCode: boolean;
}

interface INodeMaterialOptimizationAction {
	type: "removeUnreachable" | "simplifyIdentityMath" | "foldConstants" | "mergeDuplicateConstant" | "minifyCustomCode";
	blockId: number;
	blockName: string;
	detail: string;
	charactersBefore?: number;
	charactersAfter?: number;
}

interface INodeMaterialPortSelector {
	blockId?: number;
	blockName?: string;
}

const maximumGraphBlocks = 512;
const maximumCustomCodeCharacters = 65536;

function resolveNodeMaterial(scene: Scene, materialId: string): NodeMaterial {
	const material = resolveMaterial({ scene, materialId });
	if (!isNodeMaterial(material)) {
		throw new Error(`Material "${material.name}" is not a Node Material.`);
	}
	return material;
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

function graphFingerprint(material: NodeMaterial, settings?: INodeMaterialOptimizationSettings): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical({ graph: material.serialize(), settings })))
		.digest("hex");
}

function connectionTypeName(type: NodeMaterialBlockConnectionPointTypes): string {
	return NodeMaterialBlockConnectionPointTypes[type] ?? String(type);
}

function getReachableBlockIds(material: NodeMaterial): Set<number> {
	const reachable = new Set<number>();
	const visit = (block: NodeMaterialBlock): void => {
		if (reachable.has(block.uniqueId)) {
			return;
		}
		reachable.add(block.uniqueId);
		for (const input of block.inputs) {
			if (input.connectedPoint) {
				visit(input.connectedPoint.ownerBlock);
			}
		}
	};
	for (const output of [...material._vertexOutputNodes, ...material._fragmentOutputNodes]) {
		visit(output);
	}
	return reachable;
}

function getGraphEdges(material: NodeMaterial): Array<{
	id: string;
	sourceBlockId: number;
	sourceBlockName: string;
	sourceOutput: string;
	targetBlockId: number;
	targetBlockName: string;
	targetInput: string;
}> {
	return material.attachedBlocks.flatMap((block) =>
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

function summarizeBlock(block: NodeMaterialBlock, reachable: Set<number>, includeCode: boolean): Record<string, unknown> {
	const isCustom = block.getClassName() === "CustomBlock";
	const options = isCustom ? structuredClone((block as CustomBlock).options ?? {}) : undefined;
	if (options && !includeCode) {
		const code = Array.isArray(options.code) ? options.code.join("\n") : "";
		options.codeCharacterCount = code.length;
		delete options.code;
	}
	return {
		id: block.uniqueId,
		name: block.name,
		className: block.getClassName(),
		target: block.target,
		reachable: reachable.has(block.uniqueId),
		custom: isCustom,
		inputs: block.inputs.map((input) => ({
			name: input.name,
			type: input.type,
			typeName: connectionTypeName(input.type),
			optional: input.isOptional,
			connected: input.isConnected,
			source: input.connectedPoint
				? { blockId: input.connectedPoint.ownerBlock.uniqueId, blockName: input.connectedPoint.ownerBlock.name, output: input.connectedPoint.name }
				: null,
		})),
		outputs: block.outputs.map((output) => ({
			name: output.name,
			type: output.type,
			typeName: connectionTypeName(output.type),
			endpointCount: output.endpoints.length,
		})),
		...(options ? { options } : {}),
	};
}

/** Returns a bounded, context-efficient port graph used by both MCP and the visual Inspector canvas. */
export function getNodeMaterialCodeGraph(scene: Scene, data: Record<string, unknown>): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, String(data.materialId));
	if (material.attachedBlocks.length > maximumGraphBlocks) {
		throw new Error(`Node Material has ${material.attachedBlocks.length} blocks; the visual code graph supports at most ${maximumGraphBlocks}.`);
	}
	const offset = data.offset === undefined ? 0 : Number(data.offset);
	const limit = data.limit === undefined ? 64 : Number(data.limit);
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error("Node Material code-graph offset must be a non-negative integer.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("Node Material code-graph limit must be an integer from 1 through 256.");
	}
	const includeCode = data.includeCode === true;
	const query = typeof data.query === "string" ? data.query.trim().toLowerCase() : "";
	const reachable = getReachableBlockIds(material);
	const allNodes = [...material.attachedBlocks]
		.sort((left, right) => left.uniqueId - right.uniqueId)
		.filter((block) => !query || block.name.toLowerCase().includes(query) || block.getClassName().toLowerCase().includes(query));
	const selected = allNodes.slice(offset, offset + limit);
	const selectedIds = new Set(selected.map((block) => block.uniqueId));
	const allEdges = getGraphEdges(material);
	const edges = allEdges.filter((edge) => selectedIds.has(edge.sourceBlockId) || selectedIds.has(edge.targetBlockId));
	return {
		materialId: material.id,
		materialName: material.name,
		totalCount: allNodes.length,
		count: selected.length,
		offset,
		limit,
		hasMore: offset + selected.length < allNodes.length,
		nextOffset: offset + selected.length < allNodes.length ? offset + selected.length : null,
		nodes: selected.map((block) => summarizeBlock(block, reachable, includeCode)),
		edges,
		edgeCount: allEdges.length,
		customBlockCount: material.attachedBlocks.filter((block) => block.getClassName() === "CustomBlock").length,
		reachableBlockCount: reachable.size,
		fingerprint: graphFingerprint(material),
	};
}

function resolveGraphBlock(material: NodeMaterial, selector: INodeMaterialPortSelector, role: string): NodeMaterialBlock {
	if (selector.blockId !== undefined) {
		const block = material.attachedBlocks.find((candidate) => candidate.uniqueId === selector.blockId);
		if (!block) {
			throw new Error(`${role} block id was not found: ${selector.blockId}. Read get_node_material_code_graph again.`);
		}
		return block;
	}
	const name = selector.blockName?.trim();
	if (!name) {
		throw new Error(`${role} requires blockId or blockName.`);
	}
	const matches = material.attachedBlocks.filter((candidate) => candidate.name === name);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `${role} block name is ambiguous: ${name}. Use its numeric blockId.` : `${role} block name was not found: ${name}.`);
	}
	return matches[0];
}

function blockCanReach(start: NodeMaterialBlock, target: NodeMaterialBlock, visited = new Set<number>()): boolean {
	if (start === target) {
		return true;
	}
	if (visited.has(start.uniqueId)) {
		return false;
	}
	visited.add(start.uniqueId);
	return start.outputs.some((output) => output.endpoints.some((endpoint) => blockCanReach(endpoint.ownerBlock, target, visited)));
}

function refreshInspector(material: NodeMaterial, options: IMCPActionOptions): void {
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
}

/** Connects one exact output port to one exact input port with type, occupancy, and cycle checks. */
export function connectNodeMaterialBlocks(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, String(data.materialId));
	const source = resolveGraphBlock(material, { blockId: data.sourceBlockId as number | undefined, blockName: data.sourceBlockName as string | undefined }, "Source");
	const target = resolveGraphBlock(material, { blockId: data.targetBlockId as number | undefined, blockName: data.targetBlockName as string | undefined }, "Target");
	if (source === target || blockCanReach(target, source)) {
		throw new Error(`Connecting "${source.name}" to "${target.name}" would create a shader graph cycle.`);
	}
	const output = source.getOutputByName(String(data.sourceOutput));
	if (!output) {
		throw new Error(`Source output was not found: ${source.name}.${String(data.sourceOutput)}.`);
	}
	const input = target.getInputByName(String(data.targetInput));
	if (!input) {
		throw new Error(`Target input was not found: ${target.name}.${String(data.targetInput)}.`);
	}
	if (input.connectedPoint === output) {
		return {
			materialId: material.id,
			connected: false,
			alreadyConnected: true,
			edge: getGraphEdges(material).find((edge) => edge.targetBlockId === target.uniqueId && edge.targetInput === input.name),
		};
	}
	if (!output.canConnectTo(input)) {
		throw new Error(
			`Incompatible shader ports: ${source.name}.${output.name} (${connectionTypeName(output.type)}) cannot connect to ${target.name}.${input.name} (${connectionTypeName(input.type)}).`
		);
	}
	const previous = input.connectedPoint;
	if (previous && data.replace !== true) {
		throw new Error(
			`Target input ${target.name}.${input.name} is already connected to ${previous.ownerBlock.name}.${previous.name}. Pass replace=true to replace it atomically.`
		);
	}
	try {
		if (previous) {
			previous.disconnectFrom(input);
		}
		output.connectTo(input);
	} catch (error) {
		if (input.connectedPoint === output) {
			output.disconnectFrom(input);
		}
		if (previous) {
			previous.connectTo(input);
		}
		throw error;
	}
	refreshInspector(material, options);
	return {
		materialId: material.id,
		connected: true,
		replaced: previous ? { sourceBlockId: previous.ownerBlock.uniqueId, sourceBlockName: previous.ownerBlock.name, sourceOutput: previous.name } : null,
		edge: getGraphEdges(material).find(
			(edge) => edge.sourceBlockId === source.uniqueId && edge.sourceOutput === output.name && edge.targetBlockId === target.uniqueId && edge.targetInput === input.name
		),
	};
}

/** Disconnects the current source from one exact input port, optionally guarding its source identity. */
export function disconnectNodeMaterialBlocks(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, String(data.materialId));
	const target = resolveGraphBlock(material, { blockId: data.targetBlockId as number | undefined, blockName: data.targetBlockName as string | undefined }, "Target");
	const input = target.getInputByName(String(data.targetInput));
	if (!input) {
		throw new Error(`Target input was not found: ${target.name}.${String(data.targetInput)}.`);
	}
	const previous = input.connectedPoint;
	if (!previous) {
		return { materialId: material.id, disconnected: false, alreadyDisconnected: true };
	}
	if (data.sourceBlockId !== undefined && previous.ownerBlock.uniqueId !== data.sourceBlockId) {
		throw new Error(`Target input is connected to block ${previous.ownerBlock.uniqueId}, not expected block ${String(data.sourceBlockId)}.`);
	}
	if (data.sourceBlockName !== undefined && previous.ownerBlock.name !== data.sourceBlockName) {
		throw new Error(`Target input is connected to "${previous.ownerBlock.name}", not expected source "${String(data.sourceBlockName)}".`);
	}
	if (data.sourceOutput !== undefined && previous.name !== data.sourceOutput) {
		throw new Error(`Target input is connected from output "${previous.name}", not expected output "${String(data.sourceOutput)}".`);
	}
	const edge = getGraphEdges(material).find((candidate) => candidate.targetBlockId === target.uniqueId && candidate.targetInput === input.name);
	previous.disconnectFrom(input);
	refreshInspector(material, options);
	return { materialId: material.id, disconnected: true, edge };
}

function replaceCustomBlock(material: NodeMaterial, block: CustomBlock, nextOptions: Record<string, unknown>): CustomBlock {
	const index = material.attachedBlocks.indexOf(block);
	if (index < 0) {
		throw new Error(`Custom block "${block.name}" is not attached to the material.`);
	}
	const upstream = block.inputs.map((input) => ({ inputName: input.name, source: input.connectedPoint })).filter((entry) => entry.source) as Array<{
		inputName: string;
		source: NodeMaterialConnectionPoint;
	}>;
	const downstream = block.outputs.flatMap((output) => output.endpoints.map((endpoint) => ({ outputName: output.name, endpoint })));
	const replacement = new CustomBlock(block.name);
	replacement.options = structuredClone(nextOptions);
	replacement.comments = block.comments;
	replacement.visibleInInspector = block.visibleInInspector;
	try {
		for (const entry of upstream) {
			entry.source.disconnectFrom(block.getInputByName(entry.inputName)!);
		}
		for (const entry of downstream) {
			block.getOutputByName(entry.outputName)!.disconnectFrom(entry.endpoint);
		}
		for (const entry of upstream) {
			const input = replacement.getInputByName(entry.inputName);
			if (!input || !entry.source.canConnectTo(input)) {
				throw new Error(`Updated custom block input is incompatible: ${entry.inputName}.`);
			}
			entry.source.connectTo(input);
		}
		for (const entry of downstream) {
			const output = replacement.getOutputByName(entry.outputName);
			if (!output || !output.canConnectTo(entry.endpoint)) {
				throw new Error(`Updated custom block output is incompatible: ${entry.outputName}.`);
			}
			output.connectTo(entry.endpoint);
		}
		material.attachedBlocks[index] = replacement;
		return replacement;
	} catch (error) {
		for (const input of replacement.inputs) {
			if (input.connectedPoint) {
				input.connectedPoint.disconnectFrom(input);
			}
		}
		for (const output of replacement.outputs) {
			for (const endpoint of [...output.endpoints]) {
				output.disconnectFrom(endpoint);
			}
		}
		for (const entry of upstream) {
			entry.source.connectTo(block.getInputByName(entry.inputName)!);
		}
		for (const entry of downstream) {
			block.getOutputByName(entry.outputName)!.connectTo(entry.endpoint);
		}
		throw error;
	}
}

/** Updates trusted GLSL and stage metadata while preserving all existing port connections atomically. */
export function setNodeMaterialCustomBlock(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, String(data.materialId));
	const resolved = resolveGraphBlock(material, { blockId: data.blockId as number | undefined, blockName: data.name as string | undefined }, "Custom");
	if (resolved.getClassName() !== "CustomBlock") {
		throw new Error(`Block "${resolved.name}" is ${resolved.getClassName()}, not a CustomBlock.`);
	}
	const block = resolved as CustomBlock;
	const nextOptions = structuredClone(block.options ?? {}) as Record<string, unknown>;
	if (data.functionName !== undefined) {
		const functionName = String(data.functionName).trim();
		if (!functionName) {
			throw new Error("Custom block functionName must be non-empty.");
		}
		nextOptions.functionName = functionName;
	}
	if (data.code !== undefined) {
		const code = String(data.code).replace(/\r\n/g, "\n");
		if (!code.trim()) {
			throw new Error("Custom block code must be non-empty.");
		}
		if (code.length > maximumCustomCodeCharacters) {
			throw new Error(`Custom block code exceeds ${maximumCustomCodeCharacters} characters.`);
		}
		nextOptions.code = code.split("\n");
	}
	if (data.target !== undefined) {
		if (!["Vertex", "Fragment", "VertexAndFragment"].includes(String(data.target))) {
			throw new Error(`Unsupported custom block target: ${String(data.target)}.`);
		}
		nextOptions.target = data.target;
	}
	if (data.functionName === undefined && data.code === undefined && data.target === undefined) {
		throw new Error("Set at least one of functionName, code, or target.");
	}
	const replacement = replaceCustomBlock(material, block, nextOptions);
	refreshInspector(material, options);
	return { materialId: material.id, block: summarizeBlock(replacement, getReachableBlockIds(material), true), fingerprint: graphFingerprint(material) };
}

function normalizeOptimizationSettings(data: Record<string, unknown>): INodeMaterialOptimizationSettings {
	const settings = (data.settings ?? {}) as Record<string, unknown>;
	return {
		stripUnreachable: settings.stripUnreachable !== false,
		simplifyIdentityMath: settings.simplifyIdentityMath !== false,
		foldConstants: settings.foldConstants !== false,
		mergeDuplicateConstants: settings.mergeDuplicateConstants !== false,
		minifyCustomCode: settings.minifyCustomCode !== false,
	};
}

function valueArray(value: unknown): number[] | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return [value];
	}
	if (Array.isArray(value) && value.length && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
		return [...value];
	}
	if (value && typeof value === "object" && "asArray" in value && typeof (value as { asArray: unknown }).asArray === "function") {
		const array = (value as { asArray(): number[] }).asArray();
		return array.length && array.every(Number.isFinite) ? array : null;
	}
	return null;
}

function isIdentityValue(value: unknown, identity: number): boolean {
	const values = valueArray(value);
	return Boolean(values?.length) && values!.every((entry) => entry === identity);
}

function materialValueForType(type: NodeMaterialBlockConnectionPointTypes, values: number[]): unknown {
	if (values.length === 1) {
		return values[0];
	}
	switch (type) {
		case NodeMaterialBlockConnectionPointTypes.Vector2:
			return Vector2.FromArray(values);
		case NodeMaterialBlockConnectionPointTypes.Vector3:
			return Vector3.FromArray(values);
		case NodeMaterialBlockConnectionPointTypes.Vector4:
			return Vector4.FromArray(values);
		case NodeMaterialBlockConnectionPointTypes.Color3:
			return Color3.FromArray(values);
		case NodeMaterialBlockConnectionPointTypes.Color4:
			return Color4.FromArray(values);
		default:
			return values;
	}
}

function broadcastValues(left: number[], right: number[]): [number[], number[]] | null {
	if (left.length === right.length) {
		return [left, right];
	}
	if (left.length === 1) {
		return [Array(right.length).fill(left[0]), right];
	}
	if (right.length === 1) {
		return [left, Array(left.length).fill(right[0])];
	}
	return null;
}

function minifyGlsl(code: string): string {
	let result = "";
	let index = 0;
	let blockComment = false;
	while (index < code.length) {
		if (blockComment) {
			if (code[index] === "*" && code[index + 1] === "/") {
				blockComment = false;
				index += 2;
			} else {
				if (code[index] === "\n") {
					result += "\n";
				}
				index++;
			}
			continue;
		}
		if (code[index] === "/" && code[index + 1] === "*") {
			blockComment = true;
			index += 2;
			continue;
		}
		if (code[index] === "/" && code[index + 1] === "/") {
			while (index < code.length && code[index] !== "\n") {
				index++;
			}
			continue;
		}
		result += code[index++];
	}
	return result
		.split("\n")
		.map((line) => line.trim().replace(/[\t ]+/g, " "))
		.filter(Boolean)
		.join("\n");
}

function removeBlock(material: NodeMaterial, block: NodeMaterialBlock): void {
	for (const input of block.inputs) {
		if (input.connectedPoint) {
			input.connectedPoint.disconnectFrom(input);
		}
	}
	for (const output of block.outputs) {
		for (const endpoint of [...output.endpoints]) {
			output.disconnectFrom(endpoint);
		}
	}
	material.attachedBlocks = material.attachedBlocks.filter((candidate) => candidate !== block);
}

function rewireOutput(output: NodeMaterialConnectionPoint, replacement: NodeMaterialConnectionPoint): boolean {
	const endpoints = [...output.endpoints];
	if (!endpoints.length || endpoints.some((endpoint) => !replacement.canConnectTo(endpoint))) {
		return false;
	}
	for (const endpoint of endpoints) {
		output.disconnectFrom(endpoint);
		replacement.connectTo(endpoint);
	}
	return true;
}

function applyNodeMaterialOptimization(material: NodeMaterial, settings: INodeMaterialOptimizationSettings): INodeMaterialOptimizationAction[] {
	const actions: INodeMaterialOptimizationAction[] = [];
	if (settings.stripUnreachable) {
		const reachable = getReachableBlockIds(material);
		for (const block of [...material.attachedBlocks]) {
			if (!reachable.has(block.uniqueId)) {
				actions.push({ type: "removeUnreachable", blockId: block.uniqueId, blockName: block.name, detail: `${block.getClassName()} has no path to an output.` });
				removeBlock(material, block);
			}
		}
	}

	if (settings.simplifyIdentityMath) {
		for (const block of [...material.attachedBlocks]) {
			const className = block.getClassName();
			if (!["AddBlock", "SubtractBlock", "MultiplyBlock", "DivideBlock"].includes(className) || block.inputs.length < 2 || !block.outputs.length) {
				continue;
			}
			const left = block.inputs[0].connectedPoint;
			const right = block.inputs[1].connectedPoint;
			if (!left || !right) {
				continue;
			}
			const leftValue = left.ownerBlock instanceof InputBlock && left.ownerBlock.isConstant ? left.ownerBlock.value : undefined;
			const rightValue = right.ownerBlock instanceof InputBlock && right.ownerBlock.isConstant ? right.ownerBlock.value : undefined;
			let replacement: NodeMaterialConnectionPoint | null = null;
			if (className === "AddBlock" && isIdentityValue(leftValue, 0)) {
				replacement = right;
			} else if (className === "AddBlock" && isIdentityValue(rightValue, 0)) {
				replacement = left;
			} else if (className === "SubtractBlock" && isIdentityValue(rightValue, 0)) {
				replacement = left;
			} else if (className === "MultiplyBlock" && isIdentityValue(leftValue, 1)) {
				replacement = right;
			} else if (className === "MultiplyBlock" && isIdentityValue(rightValue, 1)) {
				replacement = left;
			} else if (className === "MultiplyBlock" && isIdentityValue(leftValue, 0)) {
				replacement = left;
			} else if (className === "MultiplyBlock" && isIdentityValue(rightValue, 0)) {
				replacement = right;
			} else if (className === "DivideBlock" && isIdentityValue(rightValue, 1)) {
				replacement = left;
			}
			if (replacement && rewireOutput(block.outputs[0], replacement)) {
				actions.push({
					type: "simplifyIdentityMath",
					blockId: block.uniqueId,
					blockName: block.name,
					detail: `${className} was replaced by ${replacement.ownerBlock.name}.${replacement.name}.`,
				});
				removeBlock(material, block);
			}
		}
	}

	if (settings.foldConstants) {
		for (const block of [...material.attachedBlocks]) {
			const className = block.getClassName();
			if (!["AddBlock", "SubtractBlock", "MultiplyBlock", "DivideBlock"].includes(className) || block.inputs.length < 2 || !block.outputs.length) {
				continue;
			}
			const leftSource = block.inputs[0].connectedPoint?.ownerBlock;
			const rightSource = block.inputs[1].connectedPoint?.ownerBlock;
			if (!(leftSource instanceof InputBlock) || !(rightSource instanceof InputBlock) || !leftSource.isConstant || !rightSource.isConstant) {
				continue;
			}
			const broadcast = broadcastValues(valueArray(leftSource.value) ?? [], valueArray(rightSource.value) ?? []);
			if (!broadcast) {
				continue;
			}
			const [left, right] = broadcast;
			if (className === "DivideBlock" && right.some((value) => value === 0)) {
				continue;
			}
			const result = left.map((value, index) => {
				switch (className) {
					case "AddBlock":
						return value + right[index];
					case "SubtractBlock":
						return value - right[index];
					case "MultiplyBlock":
						return value * right[index];
					default:
						return value / right[index];
				}
			});
			if (!result.every(Number.isFinite)) {
				continue;
			}
			const folded = new InputBlock(`${block.name} (Folded)`, undefined, block.outputs[0].type);
			folded.isConstant = true;
			folded.value = materialValueForType(block.outputs[0].type, result);
			material.attachedBlocks.push(folded);
			if (!rewireOutput(block.outputs[0], folded.output)) {
				removeBlock(material, folded);
				continue;
			}
			actions.push({
				type: "foldConstants",
				blockId: block.uniqueId,
				blockName: block.name,
				detail: `${className} folded to ${JSON.stringify(result.length === 1 ? result[0] : result)}.`,
			});
			removeBlock(material, block);
		}
	}

	if (settings.mergeDuplicateConstants) {
		const canonicalInputs = new Map<string, InputBlock>();
		for (const block of [...material.attachedBlocks]) {
			if (!(block instanceof InputBlock) || !block.isConstant || !valueArray(block.value)?.length) {
				continue;
			}
			const key = JSON.stringify(canonical({ type: block.type, value: valueArray(block.value), gamma: block.convertToGammaSpace, linear: block.convertToLinearSpace }));
			const existing = canonicalInputs.get(key);
			if (!existing) {
				canonicalInputs.set(key, block);
				continue;
			}
			if (rewireOutput(block.output, existing.output)) {
				actions.push({ type: "mergeDuplicateConstant", blockId: block.uniqueId, blockName: block.name, detail: `Merged into ${existing.name} (${existing.uniqueId}).` });
				removeBlock(material, block);
			}
		}
	}

	if (settings.minifyCustomCode) {
		const reachable = getReachableBlockIds(material);
		for (const block of [...material.attachedBlocks]) {
			if (block.getClassName() !== "CustomBlock" || !reachable.has(block.uniqueId)) {
				continue;
			}
			const custom = block as CustomBlock;
			const options = structuredClone(custom.options ?? {}) as Record<string, unknown>;
			const code = Array.isArray(options.code) ? options.code.join("\n") : "";
			const minified = minifyGlsl(code);
			if (!minified || minified.length >= code.length) {
				continue;
			}
			options.code = minified.split("\n");
			const replacement = replaceCustomBlock(material, custom, options);
			actions.push({
				type: "minifyCustomCode",
				blockId: replacement.uniqueId,
				blockName: replacement.name,
				detail: `Removed comments and redundant whitespace from connected custom GLSL.`,
				charactersBefore: code.length,
				charactersAfter: minified.length,
			});
		}
	}

	if (settings.stripUnreachable) {
		const reachable = getReachableBlockIds(material);
		for (const block of [...material.attachedBlocks]) {
			if (!reachable.has(block.uniqueId)) {
				actions.push({
					type: "removeUnreachable",
					blockId: block.uniqueId,
					blockName: block.name,
					detail: `${block.getClassName()} became unreachable after optimization.`,
				});
				removeBlock(material, block);
			}
		}
	}
	return actions;
}

function buildNodeMaterial(material: NodeMaterial): { valid: boolean; errors: string[]; compiledShaderCharacters: number } {
	const errors: string[] = [];
	const observer = material.onBuildErrorObservable.add((message) => errors.push(message));
	try {
		material.build(false, true, false);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		material.onBuildErrorObservable.remove(observer);
	}
	let compiledShaderCharacters = 0;
	try {
		compiledShaderCharacters = material.compiledShaders.length;
	} catch {
		// Invalid graphs have no compiled shader evidence.
	}
	return { valid: errors.length === 0, errors: [...new Set(errors)], compiledShaderCharacters };
}

function createOptimizationCandidate(material: NodeMaterial): NodeMaterial {
	const candidate = NodeMaterial.Parse(material.serialize(), material.getScene(), "");
	candidate.metadata = structuredClone(material.metadata ?? {});
	return candidate;
}

function optimizationPlan(material: NodeMaterial, settings: INodeMaterialOptimizationSettings): Record<string, unknown> {
	const beforeBuild = buildNodeMaterial(material);
	const candidate = createOptimizationCandidate(material);
	try {
		const beforeSerializedCharacters = JSON.stringify(material.serialize()).length;
		const beforeBlockCount = material.attachedBlocks.length;
		const actions = applyNodeMaterialOptimization(candidate, settings);
		const afterBuild = buildNodeMaterial(candidate);
		return {
			materialId: material.id,
			fingerprint: graphFingerprint(material, settings),
			settings,
			actionCount: actions.length,
			actions,
			before: {
				blockCount: beforeBlockCount,
				serializedCharacters: beforeSerializedCharacters,
				compiledShaderCharacters: beforeBuild.compiledShaderCharacters,
				valid: beforeBuild.valid,
				errors: beforeBuild.errors,
			},
			after: {
				blockCount: candidate.attachedBlocks.length,
				serializedCharacters: JSON.stringify(candidate.serialize()).length,
				compiledShaderCharacters: afterBuild.compiledShaderCharacters,
				valid: afterBuild.valid,
				errors: afterBuild.errors,
			},
		};
	} finally {
		candidate.dispose(false, false);
	}
}

/** Builds an exact dry-run candidate and returns the bounded optimization lease without mutating the active material. */
export function inspectNodeMaterialOptimization(scene: Scene, data: Record<string, unknown>): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, String(data.materialId));
	if (material.attachedBlocks.length > maximumGraphBlocks) {
		throw new Error(`Node Material optimization supports at most ${maximumGraphBlocks} blocks.`);
	}
	return optimizationPlan(material, normalizeOptimizationSettings(data));
}

/** Reproduces an exact optimization lease on a clone, compiles it, and atomically swaps it into the scene. */
export function optimizeNodeMaterialGraph(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, String(data.materialId));
	if (data.confirm !== true) {
		throw new Error("Node Material optimization requires confirm=true after inspecting the exact plan.");
	}
	const settings = normalizeOptimizationSettings(data);
	const expectedFingerprint = String(data.expectedFingerprint ?? "");
	const currentFingerprint = graphFingerprint(material, settings);
	if (expectedFingerprint !== currentFingerprint) {
		throw new Error("Node Material graph or optimization settings changed after inspection. Inspect the optimization plan again.");
	}
	const candidate = createOptimizationCandidate(material);
	const previousId = material.id;
	const previousName = material.name;
	const previousUniqueId = material.uniqueId;
	const previousMetadata = structuredClone(material.metadata ?? {});
	try {
		const actions = applyNodeMaterialOptimization(candidate, settings);
		const build = buildNodeMaterial(candidate);
		if (!build.valid) {
			throw new Error(`Optimized Node Material did not compile; the original was preserved: ${build.errors.join(" ")}`);
		}
		candidate.id = previousId;
		candidate.name = previousName;
		candidate.uniqueId = previousUniqueId;
		candidate.metadata = previousMetadata;
		for (const mesh of scene.meshes.filter((mesh) => mesh.material === material)) {
			mesh.material = candidate;
		}
		material.dispose(false, false);
		refreshInspector(candidate, options);
		return {
			materialId: candidate.id,
			optimized: true,
			settings,
			actionCount: actions.length,
			actions,
			blockCount: candidate.attachedBlocks.length,
			compiledShaderCharacters: build.compiledShaderCharacters,
			fingerprint: graphFingerprint(candidate, settings),
		};
	} catch (error) {
		candidate.dispose(false, false);
		throw error;
	}
}

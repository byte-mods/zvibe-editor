import { Scene, Tools } from "babylonjs";
import {
	compileComputeNodeGraph,
	createDefaultComputeNodeGraph,
	IComputeNodeGraph,
	IComputeNodeGraphNode,
	ICustomRenderPassDefinition,
	validateComputeNodeGraphStructure,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { listCustomRenderPasses, setCustomRenderPass } from "./custom-passes";

function computePass(scene: Scene, data: any): ICustomRenderPassDefinition {
	listCustomRenderPasses(scene);
	const value = ((scene.metadata?.babylonEditorCustomRenderPasses ?? []) as ICustomRenderPassDefinition[]).find((pass) => pass.id === data.id || pass.name === data.name);
	if (!value) {
		throw new Error("Compute pass not found. Provide id (preferred) or name.");
	}
	if (value.passType !== "compute") {
		throw new Error(`Custom render pass "${value.name}" is not a compute pass.`);
	}
	return value;
}

function graph(value: ICustomRenderPassDefinition): IComputeNodeGraph {
	if (!value.computeSettings.nodeGraph) {
		throw new Error(`Compute pass "${value.name}" has no node graph. Initialize or set one first.`);
	}
	return value.computeSettings.nodeGraph;
}

function compileOptions(value: ICustomRenderPassDefinition): any {
	return {
		outputBindingName: value.computeSettings.outputBindingName,
		outputGroup: value.computeSettings.outputGroup,
		outputBinding: value.computeSettings.outputBinding,
		outputType: value.outputType,
		textureInputs: Object.entries(value.inputs).map(([name, input]) => ({ name, group: input.group!, binding: input.binding! })),
		uniformBuffers: value.computeSettings.uniformBuffers,
		storageBuffers: value.computeSettings.storageBuffers,
	};
}

function persistGraph(value: ICustomRenderPassDefinition, next: IComputeNodeGraph, options: IMCPActionOptions): IComputeNodeGraph {
	validateComputeNodeGraphStructure(next);
	value.computeSettings.nodeGraph = structuredClone(next);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value.computeSettings.nodeGraph);
}

export function getCustomComputeNodeGraph(scene: Scene, data: any): any {
	const value = computePass(scene, data);
	return { passId: value.id, passName: value.name, graph: structuredClone(value.computeSettings.nodeGraph), wgsl: value.computeSettings.wgsl };
}

export function initializeCustomComputeNodeGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const next = data.replace || !value.computeSettings.nodeGraph ? createDefaultComputeNodeGraph() : value.computeSettings.nodeGraph;
	persistGraph(value, next, options);
	return compileCustomComputeNodeGraph(scene, { id: value.id }, options);
}

export function setCustomComputeNodeGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const candidate = structuredClone(data.graph);
	validateComputeNodeGraphStructure(candidate);
	if (data.compile !== false) {
		compileComputeNodeGraph(candidate, compileOptions(value));
	}
	const next = persistGraph(value, candidate, options);
	return data.compile === false ? { passId: value.id, graph: next, compiled: false } : compileCustomComputeNodeGraph(scene, { id: value.id }, options);
}

export function addCustomComputeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const current = graph(value);
	const node: IComputeNodeGraphNode = {
		id: data.node.id ?? Tools.RandomId(),
		type: data.node.type,
		position: structuredClone(data.node.position ?? [40, 40]),
		...(data.node.value !== undefined ? { value: structuredClone(data.node.value) } : {}),
		...(data.node.scalarValue !== undefined ? { scalarValue: data.node.scalarValue } : {}),
		...(data.node.resourceName !== undefined ? { resourceName: data.node.resourceName } : {}),
		...(data.node.fieldName !== undefined ? { fieldName: data.node.fieldName } : {}),
		...(data.node.component !== undefined ? { component: data.node.component } : {}),
		...(data.node.swizzle !== undefined ? { swizzle: data.node.swizzle } : {}),
		...(data.node.comparison !== undefined ? { comparison: data.node.comparison } : {}),
	};
	const next = { ...structuredClone(current), nodes: [...structuredClone(current.nodes), node] };
	persistGraph(value, next, options);
	return { passId: value.id, node: structuredClone(node) };
}

export function setCustomComputeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const current = graph(value);
	const existing = current.nodes.find((node) => node.id === data.nodeId);
	if (!existing) {
		throw new Error(`Compute node "${data.nodeId}" was not found.`);
	}
	const replacement = { ...existing, ...structuredClone(data.update), id: existing.id };
	const next = { ...structuredClone(current), nodes: current.nodes.map((node) => (node.id === existing.id ? replacement : structuredClone(node))) };
	persistGraph(value, next, options);
	return { passId: value.id, node: structuredClone(replacement) };
}

export function deleteCustomComputeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const current = graph(value);
	if (!current.nodes.some((node) => node.id === data.nodeId)) {
		throw new Error(`Compute node "${data.nodeId}" was not found.`);
	}
	const next = {
		...structuredClone(current),
		nodes: current.nodes.filter((node) => node.id !== data.nodeId),
		edges: current.edges.filter((edge) => edge.from !== data.nodeId && edge.to !== data.nodeId),
	};
	persistGraph(value, next, options);
	return { deleted: true, passId: value.id, nodeId: data.nodeId };
}

export function connectCustomComputeNodes(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const current = graph(value);
	const edge = { from: data.from, fromPort: "value" as const, to: data.to, toPort: data.toPort };
	const next = { ...structuredClone(current), edges: [...structuredClone(current.edges), edge] };
	persistGraph(value, next, options);
	return { passId: value.id, edge };
}

export function disconnectCustomComputeNodes(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const current = graph(value);
	const index = current.edges.findIndex((edge) => edge.from === data.from && edge.to === data.to && edge.toPort === data.toPort);
	if (index < 0) {
		throw new Error("Compute graph connection was not found.");
	}
	const edges = structuredClone(current.edges);
	const [edge] = edges.splice(index, 1);
	persistGraph(value, { ...structuredClone(current), edges }, options);
	return { disconnected: true, passId: value.id, edge };
}

export function compileCustomComputeNodeGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const compilation = compileComputeNodeGraph(graph(value), compileOptions(value));
	const updated = setCustomRenderPass(
		scene,
		{ id: value.id, computeSettings: { ...value.computeSettings, nodeGraph: structuredClone(value.computeSettings.nodeGraph), wgsl: compilation.wgsl } },
		options
	);
	return { passId: value.id, graph: structuredClone(updated.computeSettings.nodeGraph), ...compilation, preview: updated.preview };
}

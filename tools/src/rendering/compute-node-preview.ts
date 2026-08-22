import {
	ComputeNodeValueType,
	getComputeNodeExecutionOrder,
	getComputeNodeInputTypes,
	getComputeNodeOutputType,
	IComputeNodeGraph,
	IComputeNodeGraphNode,
	validateComputeNodeGraphStructure,
} from "./compute-node-graph";

export interface IComputeNodePreviewOptions {
	invocationId: [number, number, number];
	outputSize: [number, number];
	textureSamples?: Record<string, [number, number, number, number]>;
	uniformValues?: Record<string, Record<string, number[]>>;
	storageBuffers?: Record<string, { dataType: "float32" | "int32" | "uint32"; data: number[] }>;
}

export interface IComputeNodePreviewEntry {
	nodeId: string;
	type: string;
	valueType: ComputeNodeValueType | null;
	status: "ready" | "warning" | "unavailable";
	value?: number[];
	message?: string;
	sideEffect?: { kind: "texture-store" | "storage-store"; resource: string; index: number[]; value: number[] };
}

export interface IComputeNodeGraphAnalysis {
	valid: boolean;
	complete: boolean;
	diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; nodeId?: string; port?: string }>;
	disconnectedInputs: Array<{ nodeId: string; port: string; type: ComputeNodeValueType }>;
	deadNodeIds: string[];
	statistics: { nodeCount: number; edgeCount: number; subgraphInstanceCount: number; resourceNodeCount: number; sinkCount: number };
}

function finiteVector(value: unknown, length: number, label: string): number[] {
	if (!Array.isArray(value) || value.length !== length || value.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
		throw new Error(`${label} must contain ${length} finite numbers.`);
	}
	return [...value];
}

function vector4(value: number[]): number[] {
	return [value[0] ?? 0, value[1] ?? value[0] ?? 0, value[2] ?? value[0] ?? 0, value[3] ?? value[0] ?? 0];
}

/** Statically inspects topology, missing inputs, dead values, resources, and tracked subgraphs without compiling or dispatching. */
export function analyzeComputeNodeGraph(graph: IComputeNodeGraph): IComputeNodeGraphAnalysis {
	const diagnostics: IComputeNodeGraphAnalysis["diagnostics"] = [];
	try {
		validateComputeNodeGraphStructure(graph);
	} catch (error) {
		return {
			valid: false,
			complete: false,
			diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : String(error) }],
			disconnectedInputs: [],
			deadNodeIds: [],
			statistics: {
				nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
				edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : 0,
				subgraphInstanceCount: Array.isArray(graph?.subgraphInstances) ? graph.subgraphInstances.length : 0,
				resourceNodeCount: 0,
				sinkCount: 0,
			},
		};
	}
	const connected = new Set(graph.edges.map((edge) => `${edge.to}.${edge.toPort}`));
	const disconnectedInputs = graph.nodes.flatMap((node) =>
		Object.entries(getComputeNodeInputTypes(node.type))
			.filter(([port]) => !connected.has(`${node.id}.${port}`))
			.map(([port, type]) => ({ nodeId: node.id, port, type }))
	);
	disconnectedInputs.forEach((input) =>
		diagnostics.push({ severity: "error", message: `Required ${input.type} input is disconnected.`, nodeId: input.nodeId, port: input.port })
	);
	const sinks = new Set(graph.nodes.filter((node) => node.type === "output-store" || node.type === "storage-store").map((node) => node.id));
	const reachesSink = new Set(sinks);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of graph.edges) {
			if (reachesSink.has(edge.to) && !reachesSink.has(edge.from)) {
				reachesSink.add(edge.from);
				changed = true;
			}
		}
	}
	const deadNodeIds = graph.nodes.filter((node) => !reachesSink.has(node.id)).map((node) => node.id);
	deadNodeIds.forEach((nodeId) => diagnostics.push({ severity: "warning", message: "Node does not contribute to an output or storage side effect.", nodeId }));
	if (!diagnostics.length) {
		diagnostics.push({ severity: "info", message: "Graph topology is complete and every node contributes to a sink." });
	}
	return {
		valid: true,
		complete: disconnectedInputs.length === 0,
		diagnostics,
		disconnectedInputs,
		deadNodeIds,
		statistics: {
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			subgraphInstanceCount: graph.subgraphInstances?.length ?? 0,
			resourceNodeCount: graph.nodes.filter((node) => ["texture-load", "uniform-color", "storage-load", "storage-store"].includes(node.type)).length,
			sinkCount: sinks.size,
		},
	};
}

/** Evaluates one representative invocation on the CPU for node previews; it never mutates textures or buffers. */
export function evaluateComputeNodeGraphPreview(
	graph: IComputeNodeGraph,
	options: IComputeNodePreviewOptions
): { invocationId: number[]; outputSize: number[]; entries: IComputeNodePreviewEntry[] } {
	const invocationId = finiteVector(options.invocationId, 3, "Preview invocationId");
	const outputSize = finiteVector(options.outputSize, 2, "Preview outputSize");
	if (outputSize.some((component) => component < 1 || !Number.isInteger(component))) {
		throw new Error("Preview outputSize values must be positive integers.");
	}
	const ordered = getComputeNodeExecutionOrder(graph, true);
	const incoming = new Map(graph.edges.map((edge) => [`${edge.to}.${edge.toPort}`, edge.from]));
	const entries = new Map<string, IComputeNodePreviewEntry>();
	const input = (node: IComputeNodeGraphNode, port: string): IComputeNodePreviewEntry => entries.get(incoming.get(`${node.id}.${port}`)!)!;
	const unavailable = (node: IComputeNodeGraphNode, message: string): IComputeNodePreviewEntry => ({
		nodeId: node.id,
		type: node.type,
		valueType: getComputeNodeOutputType(node.type),
		status: "unavailable",
		message,
	});
	const ready = (node: IComputeNodeGraphNode, value: number[], message?: string): IComputeNodePreviewEntry => {
		const nonFinite = value.some((component) => !Number.isFinite(component));
		return {
			nodeId: node.id,
			type: node.type,
			valueType: getComputeNodeOutputType(node.type),
			status: nonFinite ? "warning" : "ready",
			value,
			...(nonFinite ? { message: message ?? "Preview produced a non-finite value." } : {}),
		};
	};
	const values = (node: IComputeNodeGraphNode, ports: string[]): number[][] | null => {
		const sources = ports.map((port) => input(node, port));
		return sources.some((source) => source.status === "unavailable" || !source.value) ? null : sources.map((source) => vector4(source.value!));
	};
	for (const node of ordered) {
		let entry: IComputeNodePreviewEntry;
		if (node.type === "global-id") {
			entry = ready(node, invocationId);
		} else if (node.type === "output-size") {
			entry = ready(node, outputSize);
		} else if (node.type === "constant-color") {
			entry = ready(node, node.value!);
		} else if (node.type === "constant-scalar") {
			entry = ready(node, [node.scalarValue!]);
		} else if (node.type === "uv-color") {
			const source = values(node, ["id", "size"]);
			entry = source ? ready(node, [source[0][0] / source[1][0], source[0][1] / source[1][1], 0.5, 1]) : unavailable(node, "UV preview depends on an unavailable input.");
		} else if (node.type === "texture-load") {
			const sample = node.resourceName ? options.textureSamples?.[node.resourceName] : undefined;
			entry = sample
				? ready(node, finiteVector(sample, 4, `Texture sample ${node.resourceName}`))
				: unavailable(node, `Provide textureSamples.${node.resourceName} for a deterministic CPU preview.`);
		} else if (node.type === "uniform-color") {
			const value = node.resourceName && node.fieldName ? options.uniformValues?.[node.resourceName]?.[node.fieldName] : undefined;
			entry = value
				? ready(node, finiteVector(value, 4, `Uniform ${node.resourceName}.${node.fieldName}`))
				: unavailable(node, `Uniform ${node.resourceName}.${node.fieldName} has no preview value.`);
		} else if (node.type === "storage-load") {
			const id = input(node, "id");
			const buffer = node.resourceName ? options.storageBuffers?.[node.resourceName] : undefined;
			if (!id.value || !buffer?.data.length) {
				entry = unavailable(node, `Storage buffer ${node.resourceName} or invocation index is unavailable.`);
			} else {
				const index = Math.min(buffer.data.length - 1, Math.max(0, Math.floor(id.value[0])));
				entry = ready(node, [buffer.data[index], buffer.data[index], buffer.data[index], buffer.data[index]]);
			}
		} else if (["add", "subtract", "multiply", "divide", "minimum", "maximum"].includes(node.type)) {
			const source = values(node, ["a", "b"]);
			if (!source) {
				entry = unavailable(node, `${node.type} preview depends on an unavailable input.`);
			} else {
				const value = source[0].map((component, index) =>
					node.type === "add"
						? component + source[1][index]
						: node.type === "subtract"
							? component - source[1][index]
							: node.type === "multiply"
								? component * source[1][index]
								: node.type === "divide"
									? component / source[1][index]
									: node.type === "minimum"
										? Math.min(component, source[1][index])
										: Math.max(component, source[1][index])
				);
				entry = ready(node, value);
			}
		} else if (node.type === "lerp") {
			const source = values(node, ["a", "b", "factor"]);
			entry = source
				? ready(
						node,
						source[0].map((component, index) => component + (source[1][index] - component) * source[2][index])
					)
				: unavailable(node, "Lerp preview depends on an unavailable input.");
		} else if (node.type === "clamp") {
			const source = values(node, ["value", "minimum", "maximum"]);
			entry = source
				? ready(
						node,
						source[0].map((component, index) => Math.min(source[2][index], Math.max(source[1][index], component)))
					)
				: unavailable(node, "Clamp preview depends on an unavailable input.");
		} else if (["abs", "sin", "cos"].includes(node.type)) {
			const source = values(node, ["value"]);
			entry = source
				? ready(
						node,
						source[0].map((component) => (node.type === "abs" ? Math.abs(component) : node.type === "sin" ? Math.sin(component) : Math.cos(component)))
					)
				: unavailable(node, `${node.type} preview depends on an unavailable input.`);
		} else if (node.type === "normalize") {
			const source = values(node, ["value"]);
			if (!source) {
				entry = unavailable(node, "Normalize preview depends on an unavailable input.");
			} else {
				const length = Math.max(Math.hypot(...source[0]), 0.000001);
				entry = ready(
					node,
					source[0].map((component) => component / length)
				);
			}
		} else if (node.type === "dot") {
			const source = values(node, ["a", "b"]);
			if (!source) {
				entry = unavailable(node, "Dot preview depends on an unavailable input.");
			} else {
				const dot = source[0].reduce((total, component, index) => total + component * source[1][index], 0);
				entry = ready(node, [dot, dot, dot, dot]);
			}
		} else if (node.type === "length") {
			const source = values(node, ["value"]);
			if (!source) {
				entry = unavailable(node, "Length preview depends on an unavailable input.");
			} else {
				const length = Math.hypot(...source[0]);
				entry = ready(node, [length, length, length, length]);
			}
		} else if (node.type === "select") {
			const source = values(node, ["whenFalse", "whenTrue", "condition"]);
			entry = source
				? ready(
						node,
						source[0].map((component, index) => (source[2][index] >= 0.5 ? source[1][index] : component))
					)
				: unavailable(node, "Select preview depends on an unavailable input.");
		} else if (node.type === "combine-vector") {
			const source = values(node, ["x", "y", "z", "w"]);
			entry = source
				? ready(
						node,
						source.map((value) => value[0])
					)
				: unavailable(node, "Combine-vector preview depends on an unavailable scalar input.");
		} else if (node.type === "split-component") {
			const source = values(node, ["value"]);
			const index = { x: 0, y: 1, z: 2, w: 3 }[node.component!];
			entry = source ? ready(node, [source[0][index]]) : unavailable(node, "Split-component preview depends on an unavailable vector input.");
		} else if (node.type === "splat") {
			const source = values(node, ["value"]);
			entry = source ? ready(node, [source[0][0], source[0][0], source[0][0], source[0][0]]) : unavailable(node, "Splat preview depends on an unavailable scalar input.");
		} else if (node.type === "swizzle") {
			const source = values(node, ["value"]);
			const indices = [...node.swizzle!].map((component) => ({ x: 0, y: 1, z: 2, w: 3 })[component as "x" | "y" | "z" | "w"]);
			entry = source
				? ready(
						node,
						indices.map((index) => source[0][index])
					)
				: unavailable(node, "Swizzle preview depends on an unavailable vector input.");
		} else if (node.type === "compare") {
			const source = values(node, ["a", "b"]);
			entry = source
				? ready(
						node,
						source[0].map((component, index) => {
							const other = source[1][index];
							const result =
								node.comparison === "equal"
									? component === other
									: node.comparison === "notEqual"
										? component !== other
										: node.comparison === "less"
											? component < other
											: node.comparison === "lessEqual"
												? component <= other
												: node.comparison === "greater"
													? component > other
													: component >= other;
							return result ? 1 : 0;
						})
					)
				: unavailable(node, "Compare preview depends on an unavailable input.");
		} else if (node.type === "boolean-not") {
			const source = values(node, ["value"]);
			entry = source
				? ready(
						node,
						source[0].map((component) => (component ? 0 : 1))
					)
				: unavailable(node, "Boolean-not preview depends on an unavailable input.");
		} else if (node.type === "boolean-and" || node.type === "boolean-or") {
			const source = values(node, ["a", "b"]);
			entry = source
				? ready(
						node,
						source[0].map((component, index) => ((node.type === "boolean-and" ? component && source[1][index] : component || source[1][index]) ? 1 : 0))
					)
				: unavailable(node, `${node.type} preview depends on an unavailable input.`);
		} else if (node.type === "branch") {
			const source = values(node, ["whenFalse", "whenTrue", "condition"]);
			entry = source
				? ready(
						node,
						source[0].map((component, index) => (source[2][index] ? source[1][index] : component))
					)
				: unavailable(node, "Branch preview depends on an unavailable input.");
		} else if (node.type === "storage-store") {
			const id = input(node, "id");
			const value = input(node, "value");
			const buffer = node.resourceName ? options.storageBuffers?.[node.resourceName] : undefined;
			entry =
				!id.value || !value.value || !buffer?.data.length
					? unavailable(node, `Storage store ${node.resourceName} depends on unavailable data.`)
					: {
							nodeId: node.id,
							type: node.type,
							valueType: null,
							status: "ready",
							sideEffect: {
								kind: "storage-store",
								resource: node.resourceName!,
								index: [Math.min(buffer.data.length - 1, Math.max(0, Math.floor(id.value[0])))],
								value: [value.value[0]],
							},
						};
		} else {
			const id = input(node, "id");
			const color = input(node, "color");
			entry =
				!id.value || !color.value
					? unavailable(node, "Output store depends on unavailable data.")
					: {
							nodeId: node.id,
							type: node.type,
							valueType: null,
							status: "ready",
							sideEffect: { kind: "texture-store", resource: "output", index: id.value.slice(0, 2), value: vector4(color.value) },
						};
		}
		entries.set(node.id, entry);
	}
	return { invocationId, outputSize, entries: ordered.map((node) => entries.get(node.id)!) };
}

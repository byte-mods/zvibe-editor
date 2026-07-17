export type ComputeNodeType =
	| "global-id"
	| "output-size"
	| "constant-color"
	| "constant-scalar"
	| "uv-color"
	| "texture-load"
	| "uniform-color"
	| "storage-load"
	| "add"
	| "subtract"
	| "multiply"
	| "divide"
	| "minimum"
	| "maximum"
	| "lerp"
	| "clamp"
	| "abs"
	| "sin"
	| "cos"
	| "normalize"
	| "dot"
	| "length"
	| "select"
	| "combine-vector"
	| "split-component"
	| "splat"
	| "swizzle"
	| "compare"
	| "boolean-not"
	| "boolean-and"
	| "boolean-or"
	| "branch"
	| "storage-store"
	| "output-store";

export interface IComputeNodeGraphNode {
	id: string;
	type: ComputeNodeType;
	position: [number, number];
	value?: [number, number, number, number];
	scalarValue?: number;
	resourceName?: string;
	fieldName?: string;
	component?: "x" | "y" | "z" | "w";
	swizzle?: string;
	comparison?: "equal" | "notEqual" | "less" | "lessEqual" | "greater" | "greaterEqual";
}

export interface IComputeNodeGraphEdge {
	from: string;
	fromPort: "value";
	to: string;
	toPort: string;
}

export type ComputeNodeValueType = "f32" | "vec3u" | "vec2u" | "vec4f" | "vec4b";

export interface IComputeNodeSubgraphPort {
	name: string;
	nodeId: string;
	port: string;
	type: ComputeNodeValueType;
}

export interface IComputeNodeSubgraphInstance {
	id: string;
	prefix: string;
	assetPath: string;
	assetName: string;
	assetVersion: 1 | 2;
	assetRevision: string;
	nodeIds: string[];
	inputs: IComputeNodeSubgraphPort[];
	output: IComputeNodeSubgraphPort;
	position: [number, number];
	collapsed: boolean;
}

export interface IComputeNodeGraph {
	version: 1;
	nodes: IComputeNodeGraphNode[];
	edges: IComputeNodeGraphEdge[];
	subgraphInstances?: IComputeNodeSubgraphInstance[];
}

export interface IComputeNodeGraphCompileOptions {
	outputBindingName: string;
	outputGroup: number;
	outputBinding: number;
	outputType: "uint8" | "halfFloat" | "float";
	textureInputs: Array<{ name: string; group: number; binding: number }>;
	uniformBuffers: Array<{
		name: string;
		group: number;
		binding: number;
		uniforms: Array<{ name: string; type: "float" | "vec2" | "vec3" | "vec4" | "int" | "uint" }>;
	}>;
	storageBuffers: Array<{
		name: string;
		group: number;
		binding: number;
		dataType: "float32" | "int32" | "uint32";
		access: "read" | "write" | "readWrite";
	}>;
}

export interface IComputeNodeGraphCompilation {
	wgsl: string;
	executionOrder: string[];
	diagnostics: Array<{ severity: "info"; message: string }>;
}

const outputTypes: Partial<Record<ComputeNodeType, ComputeNodeValueType>> = {
	"global-id": "vec3u",
	"output-size": "vec2u",
	"constant-color": "vec4f",
	"constant-scalar": "f32",
	"uv-color": "vec4f",
	"texture-load": "vec4f",
	"uniform-color": "vec4f",
	"storage-load": "vec4f",
	add: "vec4f",
	subtract: "vec4f",
	multiply: "vec4f",
	divide: "vec4f",
	minimum: "vec4f",
	maximum: "vec4f",
	lerp: "vec4f",
	clamp: "vec4f",
	abs: "vec4f",
	sin: "vec4f",
	cos: "vec4f",
	normalize: "vec4f",
	dot: "vec4f",
	length: "vec4f",
	select: "vec4f",
	"combine-vector": "vec4f",
	"split-component": "f32",
	splat: "vec4f",
	swizzle: "vec4f",
	compare: "vec4b",
	"boolean-not": "vec4b",
	"boolean-and": "vec4b",
	"boolean-or": "vec4b",
	branch: "vec4f",
};

const inputTypes: Partial<Record<ComputeNodeType, Record<string, ComputeNodeValueType>>> = {
	"uv-color": { id: "vec3u", size: "vec2u" },
	"texture-load": { id: "vec3u" },
	"storage-load": { id: "vec3u" },
	add: { a: "vec4f", b: "vec4f" },
	subtract: { a: "vec4f", b: "vec4f" },
	multiply: { a: "vec4f", b: "vec4f" },
	divide: { a: "vec4f", b: "vec4f" },
	minimum: { a: "vec4f", b: "vec4f" },
	maximum: { a: "vec4f", b: "vec4f" },
	lerp: { a: "vec4f", b: "vec4f", factor: "vec4f" },
	clamp: { value: "vec4f", minimum: "vec4f", maximum: "vec4f" },
	abs: { value: "vec4f" },
	sin: { value: "vec4f" },
	cos: { value: "vec4f" },
	normalize: { value: "vec4f" },
	dot: { a: "vec4f", b: "vec4f" },
	length: { value: "vec4f" },
	select: { whenFalse: "vec4f", whenTrue: "vec4f", condition: "vec4f" },
	"combine-vector": { x: "f32", y: "f32", z: "f32", w: "f32" },
	"split-component": { value: "vec4f" },
	splat: { value: "f32" },
	swizzle: { value: "vec4f" },
	compare: { a: "vec4f", b: "vec4f" },
	"boolean-not": { value: "vec4b" },
	"boolean-and": { a: "vec4b", b: "vec4b" },
	"boolean-or": { a: "vec4b", b: "vec4b" },
	branch: { whenFalse: "vec4f", whenTrue: "vec4f", condition: "vec4b" },
	"storage-store": { id: "vec3u", value: "vec4f" },
	"output-store": { id: "vec3u", color: "vec4f" },
};

const sinkTypes = new Set<ComputeNodeType>(["storage-store", "output-store"]);

function identifier(value: string): string {
	return `node_${value.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function float(value: number): string {
	if (!Number.isFinite(value)) throw new Error("Compute node color values must be finite.");
	return Number.isInteger(value) ? `${value}.0` : String(value);
}

function validateGraph(graph: IComputeNodeGraph, requireComplete: boolean, requireOutputStore = true): Map<string, IComputeNodeGraphNode> {
	if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
		throw new Error("Compute node graph must use version 1 with nodes and edges arrays.");
	if (!graph.nodes.length || graph.nodes.length > 128) throw new Error("Compute node graph requires 1 through 128 nodes.");
	if (graph.edges.length > 256) throw new Error("Compute node graph supports at most 256 edges.");
	const byId = new Map<string, IComputeNodeGraphNode>();
	const identifiers = new Map<string, string>();
	for (const node of graph.nodes) {
		if (!node.id?.trim() || byId.has(node.id)) throw new Error(`Compute node id "${node.id}" is empty or duplicated.`);
		if (!outputTypes[node.type] && !sinkTypes.has(node.type)) throw new Error(`Unsupported compute node type "${node.type}".`);
		const wgslIdentifier = identifier(node.id);
		if (identifiers.has(wgslIdentifier)) throw new Error(`Compute node ids "${identifiers.get(wgslIdentifier)}" and "${node.id}" generate the same WGSL identifier.`);
		identifiers.set(wgslIdentifier, node.id);
		if (!Array.isArray(node.position) || node.position.length !== 2 || node.position.some((coordinate) => !Number.isFinite(coordinate)))
			throw new Error(`Compute node "${node.id}" position must be a finite [x, y] pair.`);
		if (node.type === "constant-color" && (!Array.isArray(node.value) || node.value.length !== 4 || node.value.some((value) => !Number.isFinite(value))))
			throw new Error(`Constant-color node "${node.id}" requires four finite values.`);
		if (node.type === "constant-scalar" && !Number.isFinite(node.scalarValue)) throw new Error(`Constant-scalar node "${node.id}" requires one finite scalarValue.`);
		if (node.type === "split-component" && !["x", "y", "z", "w"].includes(node.component ?? ""))
			throw new Error(`Split-component node "${node.id}" requires component x, y, z, or w.`);
		if (node.type === "swizzle" && !/^[xyzw]{4}$/.test(node.swizzle ?? "")) throw new Error(`Swizzle node "${node.id}" requires exactly four xyzw components.`);
		if (node.type === "compare" && !["equal", "notEqual", "less", "lessEqual", "greater", "greaterEqual"].includes(node.comparison ?? ""))
			throw new Error(`Compare node "${node.id}" requires a supported comparison operation.`);
		byId.set(node.id, node);
	}
	if (graph.subgraphInstances !== undefined && !Array.isArray(graph.subgraphInstances)) throw new Error("Compute node graph subgraphInstances must be an array when provided.");
	const instanceIds = new Set<string>();
	const instancePrefixes = new Set<string>();
	const ownedNodes = new Set<string>();
	for (const instance of graph.subgraphInstances ?? []) {
		if (!instance.id?.trim() || instanceIds.has(instance.id)) throw new Error(`Compute subgraph instance id "${instance.id}" is empty or duplicated.`);
		instanceIds.add(instance.id);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(instance.prefix) || instancePrefixes.has(instance.prefix))
			throw new Error(`Compute subgraph instance prefix "${instance.prefix}" is invalid or duplicated.`);
		instancePrefixes.add(instance.prefix);
		if (
			!instance.assetPath?.toLowerCase().endsWith(".computegraph.json") ||
			!instance.assetName?.trim() ||
			![1, 2].includes(instance.assetVersion) ||
			!/^[a-f0-9]{64}$/.test(instance.assetRevision)
		)
			throw new Error(`Compute subgraph instance "${instance.id}" has invalid asset dependency metadata.`);
		if (
			!Array.isArray(instance.position) ||
			instance.position.length !== 2 ||
			instance.position.some((coordinate) => !Number.isFinite(coordinate)) ||
			typeof instance.collapsed !== "boolean"
		)
			throw new Error(`Compute subgraph instance "${instance.id}" has invalid canvas state.`);
		if (!Array.isArray(instance.nodeIds) || !instance.nodeIds.length || new Set(instance.nodeIds).size !== instance.nodeIds.length)
			throw new Error(`Compute subgraph instance "${instance.id}" must own unique expanded node ids.`);
		const nodeIds = new Set(instance.nodeIds);
		for (const nodeId of nodeIds) {
			if (!byId.has(nodeId) || !nodeId.startsWith(`${instance.prefix}_`))
				throw new Error(`Compute subgraph instance "${instance.id}" references invalid expanded node "${nodeId}".`);
			if (ownedNodes.has(nodeId)) throw new Error(`Compute node "${nodeId}" is owned by more than one subgraph instance.`);
			ownedNodes.add(nodeId);
		}
		if (!Array.isArray(instance.inputs) || !instance.output) throw new Error(`Compute subgraph instance "${instance.id}" is missing its typed interface.`);
		const inputNames = new Set<string>();
		const inputKeys = new Set<string>();
		for (const input of instance.inputs) {
			const key = `${input.nodeId}.${input.port}`;
			const node = byId.get(input.nodeId);
			if (
				!input.name?.trim() ||
				inputNames.has(input.name) ||
				inputKeys.has(key) ||
				!nodeIds.has(input.nodeId) ||
				getComputeNodeInputTypes(node!.type)[input.port] !== input.type
			)
				throw new Error(`Compute subgraph instance "${instance.id}" has invalid or duplicate input "${input.name}".`);
			inputNames.add(input.name);
			inputKeys.add(key);
		}
		const outputNode = byId.get(instance.output.nodeId);
		if (
			!instance.output.name?.trim() ||
			instance.output.port !== "value" ||
			!nodeIds.has(instance.output.nodeId) ||
			getComputeNodeOutputType(outputNode!.type) !== instance.output.type
		)
			throw new Error(`Compute subgraph instance "${instance.id}" has an invalid output interface.`);
	}
	if (requireOutputStore && graph.nodes.filter((node) => node.type === "output-store").length !== 1)
		throw new Error("Compute node graph requires exactly one output-store node.");
	const connectedInputs = new Set<string>();
	for (const edge of graph.edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) throw new Error("Every compute graph edge must connect existing nodes.");
		if (edge.from === edge.to) throw new Error(`Compute node "${edge.from}" cannot connect to itself.`);
		if (edge.fromPort !== "value" || !outputTypes[from.type]) throw new Error(`Compute edge from "${edge.from}" must use its value output.`);
		const expected = inputTypes[to.type]?.[edge.toPort];
		if (!expected) throw new Error(`Compute node "${to.id}" has no input port "${edge.toPort}".`);
		if (outputTypes[from.type] !== expected) throw new Error(`Compute edge ${from.id}→${to.id}.${edge.toPort} has incompatible ${outputTypes[from.type]}→${expected} types.`);
		const key = `${to.id}:${edge.toPort}`;
		if (connectedInputs.has(key)) throw new Error(`Compute node input "${key}" is connected more than once.`);
		connectedInputs.add(key);
	}
	if (requireComplete)
		for (const node of graph.nodes) {
			for (const port of Object.keys(inputTypes[node.type] ?? {}))
				if (!connectedInputs.has(`${node.id}:${port}`)) throw new Error(`Compute node "${node.id}" requires input "${port}".`);
		}
	return byId;
}

function orderGraph(graph: IComputeNodeGraph, byId: Map<string, IComputeNodeGraphNode>): IComputeNodeGraphNode[] {
	const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
	const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
	for (const edge of graph.edges) {
		indegree.set(edge.to, indegree.get(edge.to)! + 1);
		outgoing.get(edge.from)!.push(edge.to);
	}
	const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).sort((a, b) => a.id.localeCompare(b.id));
	const ordered: IComputeNodeGraphNode[] = [];
	while (ready.length) {
		const node = ready.shift()!;
		ordered.push(node);
		for (const id of outgoing.get(node.id)!) {
			indegree.set(id, indegree.get(id)! - 1);
			if (indegree.get(id) === 0) {
				ready.push(byId.get(id)!);
				ready.sort((a, b) => a.id.localeCompare(b.id));
			}
		}
	}
	if (ordered.length !== graph.nodes.length) throw new Error("Compute node graph contains a cycle.");
	return ordered;
}

function wgslUniformType(type: string): string {
	if (type === "float") return "f32";
	if (type === "int") return "i32";
	if (type === "uint") return "u32";
	return `${type}<f32>`;
}

/** Validates and compiles a typed compute node graph into complete WGSL source. */
export function compileComputeNodeGraph(graph: IComputeNodeGraph, options: IComputeNodeGraphCompileOptions): IComputeNodeGraphCompilation {
	const byId = validateGraph(graph, true);
	const ordered = orderGraph(graph, byId);
	const incoming = new Map(graph.edges.map((edge) => [`${edge.to}:${edge.toPort}`, edge.from]));
	const textureNames = new Set(options.textureInputs.map((input) => input.name));
	const uniformFields = new Map(options.uniformBuffers.map((buffer) => [buffer.name, new Map(buffer.uniforms.map((uniform) => [uniform.name, uniform.type]))]));
	const storageBuffers = new Map(options.storageBuffers.map((buffer) => [buffer.name, buffer]));
	for (const node of graph.nodes) {
		if (node.type === "texture-load" && (!node.resourceName || !textureNames.has(node.resourceName)))
			throw new Error(`Texture-load node "${node.id}" references missing compute texture input "${node.resourceName}".`);
		if (node.type === "uniform-color") {
			const type = node.resourceName && node.fieldName ? uniformFields.get(node.resourceName)?.get(node.fieldName) : undefined;
			if (type !== "vec4") throw new Error(`Uniform-color node "${node.id}" requires an existing vec4 field.`);
		}
		if (node.type === "storage-load" || node.type === "storage-store") {
			const buffer = node.resourceName ? storageBuffers.get(node.resourceName) : undefined;
			if (!buffer) throw new Error(`${node.type} node "${node.id}" references missing compute storage buffer "${node.resourceName}".`);
			if (node.type === "storage-load" && buffer.access === "write") throw new Error(`Storage-load node "${node.id}" cannot read write-only buffer "${buffer.name}".`);
			if (node.type === "storage-store" && buffer.access === "read") throw new Error(`Storage-store node "${node.id}" cannot write read-only buffer "${buffer.name}".`);
		}
	}
	const storageFormat = options.outputType === "float" ? "rgba32float" : options.outputType === "halfFloat" ? "rgba16float" : "rgba8unorm";
	const declarations = [`@group(${options.outputGroup}) @binding(${options.outputBinding}) var ${options.outputBindingName} : texture_storage_2d<${storageFormat}, write>;`];
	options.textureInputs.forEach((input) => declarations.push(`@group(${input.group}) @binding(${input.binding}) var ${input.name} : texture_2d<f32>;`));
	options.uniformBuffers.forEach((buffer, index) => {
		const structName = `ComputeNodeUniforms${index}`;
		declarations.push(`struct ${structName} { ${buffer.uniforms.map((uniform) => `${uniform.name}: ${wgslUniformType(uniform.type)}`).join(", ")} };`);
		declarations.push(`@group(${buffer.group}) @binding(${buffer.binding}) var<uniform> ${buffer.name} : ${structName};`);
	});
	options.storageBuffers.forEach((buffer) => {
		const elementType = buffer.dataType === "float32" ? "f32" : buffer.dataType === "int32" ? "i32" : "u32";
		declarations.push(
			`@group(${buffer.group}) @binding(${buffer.binding}) var<storage, ${buffer.access === "read" ? "read" : "read_write"}> ${buffer.name} : array<${elementType}>;`
		);
	});
	const expression = new Map<string, string>();
	const lines = ["\tlet outputSize = textureDimensions(" + options.outputBindingName + ");", "\tif (id.x >= outputSize.x || id.y >= outputSize.y) { return; }"];
	const input = (node: IComputeNodeGraphNode, port: string): string => expression.get(incoming.get(`${node.id}:${port}`)!)!;
	for (const node of ordered) {
		const variable = identifier(node.id);
		if (node.type === "global-id") expression.set(node.id, "id");
		else if (node.type === "output-size") expression.set(node.id, "outputSize");
		else if (node.type === "constant-color") expression.set(node.id, `vec4<f32>(${node.value!.map(float).join(", ")})`);
		else if (node.type === "constant-scalar") expression.set(node.id, float(node.scalarValue!));
		else if (node.type === "uv-color") {
			lines.push(`\tlet ${variable} = vec4<f32>(vec2<f32>(${input(node, "id")}.xy) / vec2<f32>(${input(node, "size")}), 0.5, 1.0);`);
			expression.set(node.id, variable);
		} else if (node.type === "texture-load") {
			lines.push(
				`\tlet ${variable} = textureLoad(${node.resourceName}, min(vec2<i32>(${input(node, "id")}.xy), vec2<i32>(textureDimensions(${node.resourceName})) - vec2<i32>(1)), 0);`
			);
			expression.set(node.id, variable);
		} else if (node.type === "uniform-color") expression.set(node.id, `${node.resourceName}.${node.fieldName}`);
		else if (node.type === "storage-load") {
			const buffer = storageBuffers.get(node.resourceName!)!;
			const scalar = buffer.dataType === "float32" ? `${node.resourceName}[${variable}_index]` : `f32(${node.resourceName}[${variable}_index])`;
			lines.push(`\tlet ${variable}_index = min(${input(node, "id")}.x, arrayLength(&${node.resourceName}) - 1u);`);
			lines.push(`\tlet ${variable} = vec4<f32>(${scalar});`);
			expression.set(node.id, variable);
		} else if (node.type === "add" || node.type === "subtract" || node.type === "multiply" || node.type === "divide") {
			const operator = node.type === "add" ? "+" : node.type === "subtract" ? "-" : node.type === "multiply" ? "*" : "/";
			lines.push(`\tlet ${variable} = ${input(node, "a")} ${operator} ${input(node, "b")};`);
			expression.set(node.id, variable);
		} else if (node.type === "minimum" || node.type === "maximum") {
			lines.push(`\tlet ${variable} = ${node.type === "minimum" ? "min" : "max"}(${input(node, "a")}, ${input(node, "b")});`);
			expression.set(node.id, variable);
		} else if (node.type === "lerp") {
			lines.push(`\tlet ${variable} = mix(${input(node, "a")}, ${input(node, "b")}, ${input(node, "factor")});`);
			expression.set(node.id, variable);
		} else if (node.type === "clamp") {
			lines.push(`\tlet ${variable} = clamp(${input(node, "value")}, ${input(node, "minimum")}, ${input(node, "maximum")});`);
			expression.set(node.id, variable);
		} else if (node.type === "abs" || node.type === "sin" || node.type === "cos") {
			lines.push(`\tlet ${variable} = ${node.type}(${input(node, "value")});`);
			expression.set(node.id, variable);
		} else if (node.type === "normalize") {
			lines.push(`\tlet ${variable}_value = ${input(node, "value")};`);
			lines.push(`\tlet ${variable} = ${variable}_value / max(length(${variable}_value), 0.000001);`);
			expression.set(node.id, variable);
		} else if (node.type === "dot") {
			lines.push(`\tlet ${variable} = vec4<f32>(dot(${input(node, "a")}, ${input(node, "b")}));`);
			expression.set(node.id, variable);
		} else if (node.type === "length") {
			lines.push(`\tlet ${variable} = vec4<f32>(length(${input(node, "value")}));`);
			expression.set(node.id, variable);
		} else if (node.type === "select") {
			lines.push(`\tlet ${variable} = select(${input(node, "whenFalse")}, ${input(node, "whenTrue")}, ${input(node, "condition")} >= vec4<f32>(0.5));`);
			expression.set(node.id, variable);
		} else if (node.type === "combine-vector") {
			lines.push(`\tlet ${variable} = vec4<f32>(${input(node, "x")}, ${input(node, "y")}, ${input(node, "z")}, ${input(node, "w")});`);
			expression.set(node.id, variable);
		} else if (node.type === "split-component") {
			lines.push(`\tlet ${variable} = ${input(node, "value")}.${node.component};`);
			expression.set(node.id, variable);
		} else if (node.type === "splat") {
			lines.push(`\tlet ${variable} = vec4<f32>(${input(node, "value")});`);
			expression.set(node.id, variable);
		} else if (node.type === "swizzle") {
			lines.push(`\tlet ${variable} = ${input(node, "value")}.${node.swizzle};`);
			expression.set(node.id, variable);
		} else if (node.type === "compare") {
			const operator =
				node.comparison === "equal"
					? "=="
					: node.comparison === "notEqual"
						? "!="
						: node.comparison === "less"
							? "<"
							: node.comparison === "lessEqual"
								? "<="
								: node.comparison === "greater"
									? ">"
									: ">=";
			lines.push(`\tlet ${variable} = ${input(node, "a")} ${operator} ${input(node, "b")};`);
			expression.set(node.id, variable);
		} else if (node.type === "boolean-not") {
			lines.push(`\tlet ${variable} = !${input(node, "value")};`);
			expression.set(node.id, variable);
		} else if (node.type === "boolean-and") {
			lines.push(`\tlet ${variable} = ${input(node, "a")} & ${input(node, "b")};`);
			expression.set(node.id, variable);
		} else if (node.type === "boolean-or") {
			lines.push(`\tlet ${variable} = ${input(node, "a")} | ${input(node, "b")};`);
			expression.set(node.id, variable);
		} else if (node.type === "branch") {
			lines.push(`\tlet ${variable} = select(${input(node, "whenFalse")}, ${input(node, "whenTrue")}, ${input(node, "condition")});`);
			expression.set(node.id, variable);
		} else if (node.type === "storage-store") {
			const buffer = storageBuffers.get(node.resourceName!)!;
			const source = `${input(node, "value")}.x`;
			const storedValue = buffer.dataType === "float32" ? source : buffer.dataType === "int32" ? `i32(round(${source}))` : `u32(max(round(${source}), 0.0))`;
			lines.push(`\tlet ${variable}_index = min(${input(node, "id")}.x, arrayLength(&${node.resourceName}) - 1u);`);
			lines.push(`\t${node.resourceName}[${variable}_index] = ${storedValue};`);
		} else if (node.type === "output-store") lines.push(`\ttextureStore(${options.outputBindingName}, vec2<i32>(${input(node, "id")}.xy), ${input(node, "color")});`);
	}
	return {
		wgsl: `${declarations.join("\n")}\n\n@compute @workgroup_size(8, 8, 1)\nfn main(@builtin(global_invocation_id) id : vec3<u32>) {\n${lines.join("\n")}\n}`,
		executionOrder: ordered.map((node) => node.id),
		diagnostics: [{ severity: "info", message: `Compiled ${ordered.length} nodes and ${graph.edges.length} typed edges.` }],
	};
}

/** Validates node/edge identity, port types, and cycles while allowing temporarily disconnected inputs during authoring. */
export function validateComputeNodeGraphStructure(graph: IComputeNodeGraph): void {
	const byId = validateGraph(graph, false);
	orderGraph(graph, byId);
}

/** Returns a copy of the typed input-port contract for one compute node type. */
export function getComputeNodeInputTypes(type: ComputeNodeType): Record<string, ComputeNodeValueType> {
	return { ...(inputTypes[type] ?? {}) };
}

/** Returns the typed value output for a compute node, or null for side-effect/output sinks. */
export function getComputeNodeOutputType(type: ComputeNodeType): ComputeNodeValueType | null {
	return outputTypes[type] ?? null;
}

/** Validates a reusable pure graph fragment while allowing its boundary input ports to remain disconnected. */
export function validateComputeNodeGraphFragment(fragment: IComputeNodeGraph): void {
	if (fragment.nodes.some((node) => sinkTypes.has(node.type))) throw new Error("Reusable compute subgraphs cannot contain storage-store or output-store sink nodes.");
	const byId = validateGraph(fragment, false, false);
	orderGraph(fragment, byId);
}

/** Returns deterministic topological node order, optionally requiring every typed input to be connected. */
export function getComputeNodeExecutionOrder(graph: IComputeNodeGraph, requireComplete = true): IComputeNodeGraphNode[] {
	const byId = validateGraph(graph, requireComplete);
	return orderGraph(graph, byId).map((node) => structuredClone(node));
}

/** Creates the default UV-gradient graph used when converting an authored WGSL pass to nodes. */
export function createDefaultComputeNodeGraph(): IComputeNodeGraph {
	return {
		version: 1,
		nodes: [
			{ id: "globalId", type: "global-id", position: [20, 40] },
			{ id: "outputSize", type: "output-size", position: [20, 140] },
			{ id: "uvColor", type: "uv-color", position: [240, 80] },
			{ id: "output", type: "output-store", position: [470, 80] },
		],
		edges: [
			{ from: "globalId", fromPort: "value", to: "uvColor", toPort: "id" },
			{ from: "outputSize", fromPort: "value", to: "uvColor", toPort: "size" },
			{ from: "globalId", fromPort: "value", to: "output", toPort: "id" },
			{ from: "uvColor", fromPort: "value", to: "output", toPort: "color" },
		],
	};
}

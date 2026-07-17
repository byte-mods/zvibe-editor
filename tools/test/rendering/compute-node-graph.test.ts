import { describe, expect, test } from "vitest";

import {
	compileComputeNodeGraph,
	createDefaultComputeNodeGraph,
	getComputeNodeInputTypes,
	getComputeNodeOutputType,
	IComputeNodeGraph,
	IComputeNodeGraphCompileOptions,
	validateComputeNodeGraphFragment,
	validateComputeNodeGraphStructure,
} from "../../src";

const options: IComputeNodeGraphCompileOptions = {
	outputBindingName: "outputTexture",
	outputGroup: 0,
	outputBinding: 0,
	outputType: "uint8",
	textureInputs: [],
	uniformBuffers: [],
	storageBuffers: [],
};

describe("compute node graph", () => {
	test("compiles the starter graph into complete typed WGSL", () => {
		const result = compileComputeNodeGraph(createDefaultComputeNodeGraph(), options);
		expect(result.executionOrder).toEqual(["globalId", "outputSize", "uvColor", "output"]);
		expect(result.wgsl).toContain("texture_storage_2d<rgba8unorm, write>");
		expect(result.wgsl).toContain("@compute @workgroup_size(8, 8, 1)");
		expect(result.wgsl).toContain("textureStore(outputTexture");
		expect(result.diagnostics[0].message).toContain("4 nodes and 4 typed edges");
	});

	test("declares texture, uniform and storage resources and compiles resource nodes", () => {
		const graph: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "sample", type: "texture-load", position: [100, 0], resourceName: "sourceTexture" },
				{ id: "tint", type: "uniform-color", position: [100, 100], resourceName: "settings", fieldName: "tint" },
				{ id: "multiply", type: "multiply", position: [240, 40] },
				{ id: "output", type: "output-store", position: [420, 40] },
			],
			edges: [
				{ from: "id", fromPort: "value", to: "sample", toPort: "id" },
				{ from: "sample", fromPort: "value", to: "multiply", toPort: "a" },
				{ from: "tint", fromPort: "value", to: "multiply", toPort: "b" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "multiply", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const result = compileComputeNodeGraph(graph, {
			...options,
			outputType: "halfFloat",
			textureInputs: [{ name: "sourceTexture", group: 0, binding: 1 }],
			uniformBuffers: [{ name: "settings", group: 0, binding: 2, uniforms: [{ name: "tint", type: "vec4" }] }],
			storageBuffers: [{ name: "values", group: 0, binding: 3, dataType: "float32", access: "readWrite" }],
		});
		expect(result.wgsl).toContain("texture_storage_2d<rgba16float, write>");
		expect(result.wgsl).toContain("var sourceTexture : texture_2d<f32>");
		expect(result.wgsl).toContain("tint: vec4<f32>");
		expect(result.wgsl).toContain("var<storage, read_write> values : array<f32>");
		expect(result.wgsl).toContain("textureLoad(sourceTexture");
		expect(result.wgsl).toContain("settings.tint");
	});

	test("allows incomplete authoring but rejects incomplete compilation and incompatible connections", () => {
		const incomplete = createDefaultComputeNodeGraph();
		incomplete.edges = incomplete.edges.filter((edge) => !(edge.to === "output" && edge.toPort === "color"));
		expect(() => validateComputeNodeGraphStructure(incomplete)).not.toThrow();
		expect(() => compileComputeNodeGraph(incomplete, options)).toThrow('requires input "color"');

		const incompatible = createDefaultComputeNodeGraph();
		incompatible.edges[3] = { from: "outputSize", fromPort: "value", to: "output", toPort: "color" };
		expect(() => validateComputeNodeGraphStructure(incompatible)).toThrow("incompatible vec2u→vec4f");
	});

	test("rejects cycles and missing resource bindings", () => {
		const cyclic: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "a", type: "add", position: [100, 0] },
				{ id: "b", type: "add", position: [200, 0] },
				{ id: "color", type: "constant-color", position: [0, 100], value: [1, 1, 1, 1] },
				{ id: "output", type: "output-store", position: [300, 0] },
			],
			edges: [
				{ from: "b", fromPort: "value", to: "a", toPort: "a" },
				{ from: "color", fromPort: "value", to: "a", toPort: "b" },
				{ from: "a", fromPort: "value", to: "b", toPort: "a" },
				{ from: "color", fromPort: "value", to: "b", toPort: "b" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "b", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		expect(() => validateComputeNodeGraphStructure(cyclic)).toThrow("cycle");

		const missingTexture: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "sample", type: "texture-load", position: [100, 0], resourceName: "missing" },
				{ id: "output", type: "output-store", position: [200, 0] },
			],
			edges: [
				{ from: "id", fromPort: "value", to: "sample", toPort: "id" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "sample", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		expect(() => compileComputeNodeGraph(missingTexture, options)).toThrow('missing compute texture input "missing"');
	});

	test("compiles vector math and conditional-selection nodes", () => {
		const graph: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "a", type: "constant-color", position: [0, 60], value: [0.1, 0.2, 0.3, 0.4] },
				{ id: "b", type: "constant-color", position: [0, 120], value: [1, 1, 1, 1] },
				{ id: "factor", type: "constant-color", position: [0, 180], value: [0.75, 0.75, 0.75, 0.75] },
				...["add", "subtract", "multiply", "divide", "minimum", "maximum", "lerp", "clamp", "abs", "sin", "cos", "normalize", "dot", "length", "select"].map(
					(type, index) => ({ id: type, type: type as any, position: [180 + index * 20, 80] as [number, number] })
				),
				{ id: "output", type: "output-store", position: [560, 80] },
			],
			edges: [
				{ from: "a", fromPort: "value", to: "add", toPort: "a" },
				{ from: "b", fromPort: "value", to: "add", toPort: "b" },
				{ from: "add", fromPort: "value", to: "subtract", toPort: "a" },
				{ from: "b", fromPort: "value", to: "subtract", toPort: "b" },
				{ from: "subtract", fromPort: "value", to: "multiply", toPort: "a" },
				{ from: "b", fromPort: "value", to: "multiply", toPort: "b" },
				{ from: "multiply", fromPort: "value", to: "divide", toPort: "a" },
				{ from: "b", fromPort: "value", to: "divide", toPort: "b" },
				{ from: "divide", fromPort: "value", to: "minimum", toPort: "a" },
				{ from: "a", fromPort: "value", to: "minimum", toPort: "b" },
				{ from: "minimum", fromPort: "value", to: "maximum", toPort: "a" },
				{ from: "b", fromPort: "value", to: "maximum", toPort: "b" },
				{ from: "maximum", fromPort: "value", to: "lerp", toPort: "a" },
				{ from: "b", fromPort: "value", to: "lerp", toPort: "b" },
				{ from: "factor", fromPort: "value", to: "lerp", toPort: "factor" },
				{ from: "lerp", fromPort: "value", to: "clamp", toPort: "value" },
				{ from: "a", fromPort: "value", to: "clamp", toPort: "minimum" },
				{ from: "b", fromPort: "value", to: "clamp", toPort: "maximum" },
				{ from: "clamp", fromPort: "value", to: "abs", toPort: "value" },
				{ from: "abs", fromPort: "value", to: "sin", toPort: "value" },
				{ from: "sin", fromPort: "value", to: "cos", toPort: "value" },
				{ from: "cos", fromPort: "value", to: "normalize", toPort: "value" },
				{ from: "normalize", fromPort: "value", to: "dot", toPort: "a" },
				{ from: "a", fromPort: "value", to: "dot", toPort: "b" },
				{ from: "dot", fromPort: "value", to: "length", toPort: "value" },
				{ from: "a", fromPort: "value", to: "select", toPort: "whenFalse" },
				{ from: "length", fromPort: "value", to: "select", toPort: "whenTrue" },
				{ from: "factor", fromPort: "value", to: "select", toPort: "condition" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "select", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const wgsl = compileComputeNodeGraph(graph, options).wgsl;
		expect(wgsl).toContain("node_add = vec4<f32>(0.1, 0.2, 0.3, 0.4) + vec4<f32>(1.0, 1.0, 1.0, 1.0)");
		expect(wgsl).toContain("node_lerp = mix(");
		expect(wgsl).toContain("node_clamp = clamp(");
		expect(wgsl).toContain("node_normalize_value / max(length(node_normalize_value), 0.000001)");
		expect(wgsl).toContain("vec4<f32>(dot(");
		expect(wgsl).toContain("node_select = select(");
	});

	test("compiles scalar/vector conversion, swizzle, typed comparison, Boolean logic, and branch nodes", () => {
		const graph: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "low", type: "constant-color", position: [0, 60], value: [0.1, 0.2, 0.3, 0.4] },
				{ id: "x", type: "constant-scalar", position: [0, 120], scalarValue: 0.25 },
				{ id: "y", type: "constant-scalar", position: [0, 160], scalarValue: 0.5 },
				{ id: "z", type: "constant-scalar", position: [0, 200], scalarValue: 0.75 },
				{ id: "w", type: "constant-scalar", position: [0, 240], scalarValue: 1 },
				{ id: "combine", type: "combine-vector", position: [150, 160] },
				{ id: "split", type: "split-component", position: [280, 160], component: "z" },
				{ id: "splat", type: "splat", position: [400, 160] },
				{ id: "swizzle", type: "swizzle", position: [280, 80], swizzle: "wzyx" },
				{ id: "compare", type: "compare", position: [520, 100], comparison: "greater" },
				{ id: "not", type: "boolean-not", position: [640, 120] },
				{ id: "and", type: "boolean-and", position: [760, 120] },
				{ id: "or", type: "boolean-or", position: [880, 120] },
				{ id: "branch", type: "branch", position: [1000, 100] },
				{ id: "output", type: "output-store", position: [1140, 100] },
			],
			edges: [
				...(["x", "y", "z", "w"] as const).map((port) => ({ from: port, fromPort: "value" as const, to: "combine", toPort: port })),
				{ from: "combine", fromPort: "value", to: "split", toPort: "value" },
				{ from: "split", fromPort: "value", to: "splat", toPort: "value" },
				{ from: "combine", fromPort: "value", to: "swizzle", toPort: "value" },
				{ from: "swizzle", fromPort: "value", to: "compare", toPort: "a" },
				{ from: "splat", fromPort: "value", to: "compare", toPort: "b" },
				{ from: "compare", fromPort: "value", to: "not", toPort: "value" },
				{ from: "compare", fromPort: "value", to: "and", toPort: "a" },
				{ from: "not", fromPort: "value", to: "and", toPort: "b" },
				{ from: "and", fromPort: "value", to: "or", toPort: "a" },
				{ from: "compare", fromPort: "value", to: "or", toPort: "b" },
				{ from: "low", fromPort: "value", to: "branch", toPort: "whenFalse" },
				{ from: "swizzle", fromPort: "value", to: "branch", toPort: "whenTrue" },
				{ from: "or", fromPort: "value", to: "branch", toPort: "condition" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "branch", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const wgsl = compileComputeNodeGraph(graph, options).wgsl;
		expect(wgsl).toContain("node_combine = vec4<f32>(0.25, 0.5, 0.75, 1.0)");
		expect(wgsl).toContain("node_split = node_combine.z");
		expect(wgsl).toContain("node_swizzle = node_combine.wzyx");
		expect(wgsl).toContain("node_compare = node_swizzle > node_splat");
		expect(wgsl).toContain("node_not = !node_compare");
		expect(wgsl).toContain("node_and = node_compare & node_not");
		expect(wgsl).toContain("node_or = node_and | node_compare");
		expect(wgsl).toContain("node_branch = select(vec4<f32>(0.1, 0.2, 0.3, 0.4), node_swizzle, node_or)");

		const invalid = structuredClone(graph);
		invalid.nodes.find((node) => node.id === "swizzle")!.swizzle = "xyz";
		expect(() => compileComputeNodeGraph(invalid, options)).toThrow("exactly four xyzw components");
	});

	test("compiles typed storage-buffer load/store nodes and enforces declared access", () => {
		const graph: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "load", type: "storage-load", position: [120, 0], resourceName: "values" },
				{ id: "scale", type: "constant-color", position: [120, 80], value: [2, 2, 2, 2] },
				{ id: "product", type: "multiply", position: [250, 40] },
				{ id: "store", type: "storage-store", position: [390, 0], resourceName: "values" },
				{ id: "output", type: "output-store", position: [390, 100] },
			],
			edges: [
				{ from: "id", fromPort: "value", to: "load", toPort: "id" },
				{ from: "load", fromPort: "value", to: "product", toPort: "a" },
				{ from: "scale", fromPort: "value", to: "product", toPort: "b" },
				{ from: "id", fromPort: "value", to: "store", toPort: "id" },
				{ from: "product", fromPort: "value", to: "store", toPort: "value" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "product", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const storageOptions = { ...options, storageBuffers: [{ name: "values", group: 0, binding: 2, dataType: "uint32" as const, access: "readWrite" as const }] };
		const wgsl = compileComputeNodeGraph(graph, storageOptions).wgsl;
		expect(wgsl).toContain("arrayLength(&values) - 1u");
		expect(wgsl).toContain("vec4<f32>(f32(values[node_load_index]))");
		expect(wgsl).toContain("values[node_store_index] = u32(max(round(node_product.x), 0.0));");

		expect(() => compileComputeNodeGraph(graph, { ...storageOptions, storageBuffers: [{ ...storageOptions.storageBuffers[0], access: "read" }] })).toThrow(
			"cannot write read-only buffer"
		);
		expect(() => compileComputeNodeGraph(graph, { ...storageOptions, storageBuffers: [{ ...storageOptions.storageBuffers[0], access: "write" }] })).toThrow(
			"cannot read write-only buffer"
		);
	});

	test("rejects node ids that collide after WGSL identifier sanitization", () => {
		const graph = createDefaultComputeNodeGraph();
		graph.nodes.push({ id: "a-b", type: "constant-color", position: [0, 0], value: [1, 1, 1, 1] });
		graph.nodes.push({ id: "a_b", type: "constant-color", position: [0, 0], value: [1, 1, 1, 1] });
		expect(() => validateComputeNodeGraphStructure(graph)).toThrow("generate the same WGSL identifier");
	});

	test("validates pure reusable fragments and exposes their typed interface contracts", () => {
		const fragment: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "multiply", type: "multiply", position: [100, 0] },
				{ id: "clamp", type: "clamp", position: [220, 0] },
			],
			edges: [{ from: "multiply", fromPort: "value", to: "clamp", toPort: "value" }],
		};
		expect(() => validateComputeNodeGraphFragment(fragment)).not.toThrow();
		expect(getComputeNodeInputTypes("clamp")).toEqual({ value: "vec4f", minimum: "vec4f", maximum: "vec4f" });
		expect(getComputeNodeOutputType("clamp")).toBe("vec4f");
		expect(getComputeNodeOutputType("storage-store")).toBeNull();

		fragment.nodes.push({ id: "sink", type: "output-store", position: [340, 0] });
		expect(() => validateComputeNodeGraphFragment(fragment)).toThrow("cannot contain storage-store or output-store");
	});

	test("validates tracked subgraph instance ownership, interface, revision, and canvas state", () => {
		const graph = createDefaultComputeNodeGraph();
		graph.nodes.push({ id: "fx_color", type: "constant-color", position: [600, 200], value: [1, 0, 0, 1] });
		graph.subgraphInstances = [
			{
				id: "fx",
				prefix: "fx",
				assetPath: "assets/compute/fx.computegraph.json",
				assetName: "FX",
				assetVersion: 1,
				assetRevision: "a".repeat(64),
				nodeIds: ["fx_color"],
				inputs: [],
				output: { name: "output", nodeId: "fx_color", port: "value", type: "vec4f" },
				position: [600, 200],
				collapsed: true,
			},
		];
		expect(() => validateComputeNodeGraphStructure(graph)).not.toThrow();
		graph.subgraphInstances[0].assetRevision = "invalid";
		expect(() => validateComputeNodeGraphStructure(graph)).toThrow("invalid asset dependency metadata");
	});
});

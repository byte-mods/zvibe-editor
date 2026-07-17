import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph } from "babylonjs-editor-tools";

import {
	addCustomComputeNode,
	compileCustomComputeNodeGraph,
	connectCustomComputeNodes,
	deleteCustomComputeNode,
	disconnectCustomComputeNodes,
	getCustomComputeNodeGraph,
	initializeCustomComputeNodeGraph,
	setCustomComputeNode,
	setCustomComputeNodeGraph,
} from "../../src/mcp/rendering/compute-graph";
import { createCustomRenderPass } from "../../src/mcp/rendering/custom-passes";

describe("mcp/compute-node-graph", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
	});

	afterEach(() => {
		disposeCustomRenderPassGraph(camera as any);
		scene.dispose();
		engine.dispose();
	});

	function createPass(): any {
		return createCustomRenderPass(scene, { name: "Nodes", passType: "compute", output: "nodeOutput" }, options);
	}

	test("initializes, compiles and reads a persisted node graph", () => {
		const pass = createPass();
		const result = initializeCustomComputeNodeGraph(scene, { id: pass.id }, options);
		expect(result).toMatchObject({ passId: pass.id, executionOrder: ["globalId", "outputSize", "uvColor", "output"] });
		expect(result.wgsl).toContain("@compute @workgroup_size(8, 8, 1)");
		expect(result.preview).toMatchObject({ applied: false, error: expect.stringContaining("WebGPU") });
		expect(getCustomComputeNodeGraph(scene, { id: pass.id })).toMatchObject({ passId: pass.id, graph: { version: 1, nodes: expect.any(Array) }, wgsl: result.wgsl });
	});

	test("authors nodes and typed connections before recompiling generated WGSL", () => {
		const pass = createPass();
		initializeCustomComputeNodeGraph(scene, { id: pass.id }, options);
		disconnectCustomComputeNodes(scene, { id: pass.id, from: "uvColor", to: "output", toPort: "color" }, options);
		const added = addCustomComputeNode(scene, { id: pass.id, node: { id: "solid", type: "constant-color", position: [260, 220], value: [1, 0.25, 0.5, 1] } }, options);
		expect(added.node).toMatchObject({ id: "solid", type: "constant-color" });
		setCustomComputeNode(scene, { id: pass.id, nodeId: "solid", update: { value: [0.1, 0.2, 0.3, 1], position: [300, 230] } }, options);
		connectCustomComputeNodes(scene, { id: pass.id, from: "solid", to: "output", toPort: "color" }, options);
		const compiled = compileCustomComputeNodeGraph(scene, { id: pass.id }, options);
		expect(compiled.wgsl).toContain("vec4<f32>(0.1, 0.2, 0.3, 1.0)");
		expect(compiled.graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "solid", position: [300, 230] })]));
		expect(() => connectCustomComputeNodes(scene, { id: pass.id, from: "outputSize", to: "output", toPort: "color" }, options)).toThrow("incompatible");
		expect(() => deleteCustomComputeNode(scene, { id: pass.id, nodeId: "output" }, options)).toThrow("exactly one output-store");
	});

	test("persists conversion and typed-control node properties through generic MCP actions", () => {
		const pass = createPass();
		initializeCustomComputeNodeGraph(scene, { id: pass.id }, options);
		addCustomComputeNode(scene, { id: pass.id, node: { id: "scalar", type: "constant-scalar", position: [20, 260], scalarValue: 0.75 } }, options);
		addCustomComputeNode(scene, { id: pass.id, node: { id: "swizzle", type: "swizzle", position: [180, 260], swizzle: "wzyx" } }, options);
		addCustomComputeNode(scene, { id: pass.id, node: { id: "compare", type: "compare", position: [340, 260], comparison: "lessEqual" } }, options);
		setCustomComputeNode(scene, { id: pass.id, nodeId: "swizzle", update: { swizzle: "xxxx" } }, options);
		expect(getCustomComputeNodeGraph(scene, { id: pass.id }).graph.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "scalar", scalarValue: 0.75 }),
				expect.objectContaining({ id: "swizzle", swizzle: "xxxx" }),
				expect.objectContaining({ id: "compare", comparison: "lessEqual" }),
			])
		);
		const before = getCustomComputeNodeGraph(scene, { id: pass.id });
		expect(() => setCustomComputeNode(scene, { id: pass.id, nodeId: "swizzle", update: { swizzle: "xyz" } }, options)).toThrow("exactly four xyzw components");
		expect(getCustomComputeNodeGraph(scene, { id: pass.id })).toEqual(before);
	});

	test("persists an incomplete whole graph only when compilation is deferred", () => {
		const pass = createPass();
		initializeCustomComputeNodeGraph(scene, { id: pass.id }, options);
		const current = getCustomComputeNodeGraph(scene, { id: pass.id }).graph;
		current.edges = current.edges.filter((edge: any) => edge.toPort !== "color");
		expect(setCustomComputeNodeGraph(scene, { id: pass.id, graph: current, compile: false }, options)).toMatchObject({ passId: pass.id, compiled: false });
		expect(() => compileCustomComputeNodeGraph(scene, { id: pass.id }, options)).toThrow('requires input "color"');
	});

	test("compiles math and storage nodes through the editor action path without corrupting a valid graph on rejection", () => {
		const pass = createCustomRenderPass(
			scene,
			{
				name: "Storage Nodes",
				passType: "compute",
				output: "storageNodeOutput",
				computeSettings: {
					wgsl: `@group(0) @binding(0) var outputTexture : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<storage, read_write> values : array<f32>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
	let size = textureDimensions(outputTexture);
	if (id.x >= size.x || id.y >= size.y) { return; }
	textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(values[min(id.x, arrayLength(&values) - 1u)]));
}`,
					storageBuffers: [{ name: "values", group: 0, binding: 1, dataType: "float32", data: [0.25, 0.5, 0.75, 1], access: "readWrite" }],
				},
			},
			options
		);
		const graph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "load", type: "storage-load", position: [100, 0], resourceName: "values" },
				{ id: "factor", type: "constant-color", position: [100, 80], value: [2, 2, 2, 2] },
				{ id: "multiply", type: "multiply", position: [220, 40] },
				{ id: "store", type: "storage-store", position: [350, 0], resourceName: "values" },
				{ id: "output", type: "output-store", position: [350, 100] },
			],
			edges: [
				{ from: "id", fromPort: "value", to: "load", toPort: "id" },
				{ from: "load", fromPort: "value", to: "multiply", toPort: "a" },
				{ from: "factor", fromPort: "value", to: "multiply", toPort: "b" },
				{ from: "id", fromPort: "value", to: "store", toPort: "id" },
				{ from: "multiply", fromPort: "value", to: "store", toPort: "value" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "multiply", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const compiled = setCustomComputeNodeGraph(scene, { id: pass.id, graph }, options);
		expect(compiled.wgsl).toContain("values[node_store_index] = node_multiply.x");
		const before = getCustomComputeNodeGraph(scene, { id: pass.id });
		const invalid = structuredClone(graph);
		invalid.nodes.find((node: any) => node.id === "load")!.resourceName = "missing";
		expect(() => setCustomComputeNodeGraph(scene, { id: pass.id, graph: invalid }, options)).toThrow("missing compute storage buffer");
		expect(getCustomComputeNodeGraph(scene, { id: pass.id })).toEqual(before);
	});
});

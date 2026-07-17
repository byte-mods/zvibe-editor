import { describe, expect, test } from "vitest";

import { analyzeComputeNodeGraph, createDefaultComputeNodeGraph, evaluateComputeNodeGraphPreview, IComputeNodeGraph } from "../../src";

describe("compute node preview and analysis", () => {
	test("evaluates the default graph at a representative invocation without mutating output", () => {
		const result = evaluateComputeNodeGraphPreview(createDefaultComputeNodeGraph(), { invocationId: [4, 2, 0], outputSize: [8, 4] });
		expect(result.entries.find((entry) => entry.nodeId === "uvColor")).toMatchObject({ status: "ready", value: [0.5, 0.5, 0.5, 1] });
		expect(result.entries.find((entry) => entry.nodeId === "output")).toMatchObject({
			status: "ready",
			sideEffect: { kind: "texture-store", resource: "output", index: [4, 2], value: [0.5, 0.5, 0.5, 1] },
		});
	});

	test("propagates texture, uniform and authored storage values through math nodes", () => {
		const graph: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "texture", type: "texture-load", position: [100, 0], resourceName: "source" },
				{ id: "tint", type: "uniform-color", position: [100, 80], resourceName: "params", fieldName: "tint" },
				{ id: "storage", type: "storage-load", position: [100, 160], resourceName: "values" },
				{ id: "add", type: "add", position: [240, 40] },
				{ id: "multiply", type: "multiply", position: [380, 80] },
				{ id: "output", type: "output-store", position: [520, 80] },
			],
			edges: [
				{ from: "id", fromPort: "value", to: "texture", toPort: "id" },
				{ from: "id", fromPort: "value", to: "storage", toPort: "id" },
				{ from: "texture", fromPort: "value", to: "add", toPort: "a" },
				{ from: "tint", fromPort: "value", to: "add", toPort: "b" },
				{ from: "add", fromPort: "value", to: "multiply", toPort: "a" },
				{ from: "storage", fromPort: "value", to: "multiply", toPort: "b" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "multiply", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const result = evaluateComputeNodeGraphPreview(graph, {
			invocationId: [2, 0, 0],
			outputSize: [4, 4],
			textureSamples: { source: [0.1, 0.2, 0.3, 0.4] },
			uniformValues: { params: { tint: [0.4, 0.3, 0.2, 0.1] } },
			storageBuffers: { values: { dataType: "float32", data: [0.5, 1, 2, 4] } },
		});
		expect(result.entries.find((entry) => entry.nodeId === "multiply")).toMatchObject({ status: "ready", value: [1, 1, 1, 1] });
		expect(result.entries.find((entry) => entry.nodeId === "output")?.sideEffect?.value).toEqual([1, 1, 1, 1]);

		const unavailable = evaluateComputeNodeGraphPreview(graph, {
			invocationId: [0, 0, 0],
			outputSize: [1, 1],
			uniformValues: { params: { tint: [1, 1, 1, 1] } },
			storageBuffers: { values: { dataType: "float32", data: [1] } },
		});
		expect(unavailable.entries.find((entry) => entry.nodeId === "texture")).toMatchObject({ status: "unavailable", message: expect.stringContaining("textureSamples.source") });
		expect(unavailable.entries.find((entry) => entry.nodeId === "output")).toMatchObject({ status: "unavailable" });
	});

	test("reports disconnected inputs and dead values without compiling", () => {
		const graph = createDefaultComputeNodeGraph();
		graph.nodes.push({ id: "dead", type: "constant-color", position: [0, 240], value: [1, 0, 0, 1] });
		graph.edges = graph.edges.filter((edge) => !(edge.to === "output" && edge.toPort === "color"));
		const analysis = analyzeComputeNodeGraph(graph);
		expect(analysis).toMatchObject({ valid: true, complete: false, disconnectedInputs: [{ nodeId: "output", port: "color", type: "vec4f" }] });
		expect(analysis.deadNodeIds).toEqual(expect.arrayContaining(["uvColor", "dead"]));
		expect(analysis.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", nodeId: "output", port: "color" })]));
	});

	test("previews scalar/vector conversions, typed comparisons, Boolean logic, and branch control", () => {
		const graph: IComputeNodeGraph = {
			version: 1,
			nodes: [
				{ id: "id", type: "global-id", position: [0, 0] },
				{ id: "low", type: "constant-color", position: [0, 40], value: [0.1, 0.2, 0.3, 0.4] },
				{ id: "x", type: "constant-scalar", position: [0, 80], scalarValue: 0.25 },
				{ id: "y", type: "constant-scalar", position: [0, 120], scalarValue: 0.5 },
				{ id: "z", type: "constant-scalar", position: [0, 160], scalarValue: 0.75 },
				{ id: "w", type: "constant-scalar", position: [0, 200], scalarValue: 1 },
				{ id: "combine", type: "combine-vector", position: [120, 120] },
				{ id: "split", type: "split-component", position: [240, 160], component: "z" },
				{ id: "splat", type: "splat", position: [360, 160] },
				{ id: "swizzle", type: "swizzle", position: [240, 80], swizzle: "wzyx" },
				{ id: "compare", type: "compare", position: [480, 100], comparison: "greater" },
				{ id: "not", type: "boolean-not", position: [600, 100] },
				{ id: "or", type: "boolean-or", position: [720, 100] },
				{ id: "branch", type: "branch", position: [840, 100] },
				{ id: "output", type: "output-store", position: [960, 100] },
			],
			edges: [
				...(["x", "y", "z", "w"] as const).map((port) => ({ from: port, fromPort: "value" as const, to: "combine", toPort: port })),
				{ from: "combine", fromPort: "value", to: "split", toPort: "value" },
				{ from: "split", fromPort: "value", to: "splat", toPort: "value" },
				{ from: "combine", fromPort: "value", to: "swizzle", toPort: "value" },
				{ from: "swizzle", fromPort: "value", to: "compare", toPort: "a" },
				{ from: "splat", fromPort: "value", to: "compare", toPort: "b" },
				{ from: "compare", fromPort: "value", to: "not", toPort: "value" },
				{ from: "compare", fromPort: "value", to: "or", toPort: "a" },
				{ from: "not", fromPort: "value", to: "or", toPort: "b" },
				{ from: "low", fromPort: "value", to: "branch", toPort: "whenFalse" },
				{ from: "swizzle", fromPort: "value", to: "branch", toPort: "whenTrue" },
				{ from: "or", fromPort: "value", to: "branch", toPort: "condition" },
				{ from: "id", fromPort: "value", to: "output", toPort: "id" },
				{ from: "branch", fromPort: "value", to: "output", toPort: "color" },
			],
		};
		const result = evaluateComputeNodeGraphPreview(graph, { invocationId: [0, 0, 0], outputSize: [1, 1] });
		expect(result.entries.find((entry) => entry.nodeId === "combine")).toMatchObject({ valueType: "vec4f", value: [0.25, 0.5, 0.75, 1] });
		expect(result.entries.find((entry) => entry.nodeId === "split")).toMatchObject({ valueType: "f32", value: [0.75] });
		expect(result.entries.find((entry) => entry.nodeId === "compare")).toMatchObject({ valueType: "vec4b", value: [1, 0, 0, 0] });
		expect(result.entries.find((entry) => entry.nodeId === "or")).toMatchObject({ value: [1, 1, 1, 1] });
		expect(result.entries.find((entry) => entry.nodeId === "branch")).toMatchObject({ value: [1, 0.75, 0.5, 0.25] });
	});

	test("validates preview coordinates and dimensions", () => {
		expect(() => evaluateComputeNodeGraphPreview(createDefaultComputeNodeGraph(), { invocationId: [0, 0, 0], outputSize: [0, 1] })).toThrow("positive integers");
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph } from "babylonjs-editor-tools";

import { debugCustomComputeNodeGraph, getCustomComputeNodeProfile, previewCustomComputeNodeGraph } from "../../src/mcp/rendering/compute-debug";
import { disconnectCustomComputeNodes, initializeCustomComputeNodeGraph } from "../../src/mcp/rendering/compute-graph";
import { createCustomRenderPass } from "../../src/mcp/rendering/custom-passes";

describe("mcp/compute-debug", () => {
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

	function pass(): any {
		const value = createCustomRenderPass(scene, { name: "Debug Nodes", passType: "compute", output: "debugOutput" }, options);
		initializeCustomComputeNodeGraph(scene, { id: value.id }, options);
		return value;
	}

	test("previews selected nodes and combines compiler, runtime, and honest profiling diagnostics", () => {
		const value = pass();
		const preview = previewCustomComputeNodeGraph(scene, { id: value.id, invocationId: [4, 2, 0], outputSize: [8, 4], nodeIds: ["uvColor", "output"] });
		expect(preview.entries).toEqual([
			expect.objectContaining({ nodeId: "uvColor", status: "ready", value: [0.5, 0.5, 0.5, 1] }),
			expect.objectContaining({ nodeId: "output", status: "ready", sideEffect: { kind: "texture-store", resource: "output", index: [4, 2], value: [0.5, 0.5, 0.5, 1] } }),
		]);

		const debug = debugCustomComputeNodeGraph(scene, { id: value.id, invocationId: [4, 2, 0], outputSize: [8, 4], includeWgsl: true });
		expect(debug).toMatchObject({
			analysis: { valid: true, complete: true, deadNodeIds: [] },
			compiler: { ready: true, error: null, executionOrder: ["globalId", "outputSize", "uvColor", "output"], wgsl: expect.stringContaining("@compute") },
			preview: { ready: true, error: null },
			runtime: { graphReady: true, target: null },
			profiling: {
				cpuDispatchScope: "per-pass CPU submission only",
				dispatchCount: 0,
				gpuTimingScope: "isolated custom compute pass hardware timestamp",
				gpuTimingAvailable: false,
				gpuPassSampleCount: 0,
			},
		});
		const profile = getCustomComputeNodeProfile(scene, { id: value.id });
		expect(profile).toMatchObject({
			runtimeAvailable: false,
			dispatch: null,
			gpu: {
				scope: "isolated custom compute pass",
				supported: false,
				available: false,
				note: expect.stringContaining("hardware timestamp counter"),
			},
		});
	});

	test("returns actionable disconnected-input analysis without pretending compilation or preview succeeded", () => {
		const value = pass();
		disconnectCustomComputeNodes(scene, { id: value.id, from: "uvColor", to: "output", toPort: "color" }, options);
		const debug = debugCustomComputeNodeGraph(scene, { id: value.id });
		expect(debug).toMatchObject({
			analysis: { valid: true, complete: false, disconnectedInputs: [{ nodeId: "output", port: "color", type: "vec4f" }] },
			compiler: { ready: false, error: null, executionOrder: [] },
			preview: { ready: false, error: null, entries: [] },
		});
	});
});

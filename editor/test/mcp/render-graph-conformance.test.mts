import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { createCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import { clearRenderGraphConformance, getRenderGraphConformance, runRenderGraphConformance } from "../../src/mcp/rendering/render-graph-conformance";

describe("mcp/render-graph-conformance", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				preview: { setRenderScene: vi.fn() },
				inspector: { forceUpdate: vi.fn() },
				graph: { refresh: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
		Object.defineProperty(engine, "webGLVersion", { configurable: true, value: 2 });
		scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Conformance Camera", new Vector3(0, 0, -5), scene);
		scene.metadata = { babylonEditorCustomRenderPasses: [] };
		vi.clearAllMocks();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("runs, leases, invalidates, records an honest failure, and clears current WebGL2 evidence", async () => {
		const initial = getRenderGraphConformance(scene);
		expect(initial).toMatchObject({ revision: null, current: false, capabilities: { backend: "webgl2" }, coverage: { webgl2: "notRun", webgpu: "notRun", portable: false } });

		const passed = await runRenderGraphConformance(scene, { expectedRevision: null, frameCount: 1 }, options);
		expect(passed).toMatchObject({
			revision: 1,
			current: true,
			coverage: { webgl2: "passed", webgpu: "notRun", portable: false },
			runs: { webgl2: { backend: "webgl2", passed: true, frameCount: 1, current: true } },
		});
		expect(options.editor.layout.preview.setRenderScene).toHaveBeenCalledWith(true);
		await expect(runRenderGraphConformance(scene, { expectedRevision: null, frameCount: 1 }, options)).rejects.toThrow("revision is stale");

		createCustomRenderPass(
			scene,
			{
				name: "WebGPU Compute Requirement",
				passType: "compute",
				output: "computedColor",
				computeSettings: { dispatch: [1, 1, 1], dispatchMode: "everyFrame" },
			},
			options
		);
		const changed = getRenderGraphConformance(scene);
		expect(changed).toMatchObject({ revision: 1, current: false, coverage: { webgl2: "notRun", webgpu: "notRun" } });
		expect(changed.targets.webgl2.blockers).toEqual(["1 native compute pass(es) require WebGPU."]);

		const failed = await runRenderGraphConformance(scene, { expectedRevision: 1, frameCount: 1 }, options);
		expect(failed).toMatchObject({
			revision: 2,
			current: true,
			coverage: { webgl2: "failed", webgpu: "notRun", portable: false },
			runs: { webgl2: { passed: false, current: true, error: expect.stringContaining("WebGPU backend") }, webgpu: null },
		});
		expect(() => clearRenderGraphConformance(scene, { revision: 1, confirm: true }, options)).toThrow("revision is stale");
		expect(clearRenderGraphConformance(scene, { revision: 2, confirm: true }, options)).toMatchObject({ cleared: true, revision: 2 });
		expect(getRenderGraphConformance(scene)).toMatchObject({ revision: null, current: false, coverage: { webgl2: "notRun", webgpu: "notRun" } });
	});
});

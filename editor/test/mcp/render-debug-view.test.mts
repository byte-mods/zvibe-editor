import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CreateBox, FreeCamera, HemisphericLight, NullEngine, PointLight, Scene, SceneSerializer, StandardMaterial, Vector3 } from "babylonjs";

import { captureRenderDebugView, getRenderDebugView, setRenderDebugView } from "../../src/mcp/diagnostics/render-debug";

describe("mcp/render-debug-view", () => {
	let engine: NullEngine;
	let scene: Scene;
	let material: StandardMaterial;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 320, renderHeight: 180 });
		scene = new Scene(engine);
		const camera = new FreeCamera("Debug Camera", new Vector3(0, 0, -10), scene);
		camera.setTarget(Vector3.Zero());
		scene.activeCamera = camera;
		const mesh = CreateBox("Debug Box", { size: 2 }, scene);
		material = new StandardMaterial("Authored Material", scene);
		mesh.material = material;
		new HemisphericLight("Ambient", Vector3.Up(), scene);
		new PointLight("Point", new Vector3(0, 2, -2), scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	test("exact-leases transient overdraw and light-complexity views without replacing authored materials", () => {
		const baselineTargets = scene.customRenderTargets.length;
		const baselineLayers = scene.layers.length;
		const baselineMaterials = scene.materials.length;
		const baselineTextures = scene.textures.length;
		expect(getRenderDebugView(scene)).toMatchObject({ revision: 1, mode: "disabled", active: false });

		const overdraw = setRenderDebugView(scene, { expectedRevision: 1, mode: "overdraw", maximumOverdraw: 12 }, options);
		expect(overdraw).toMatchObject({ revision: 2, mode: "overdraw", active: true, maximumOverdraw: 12, meshCount: 1, lightCount: 2 });
		expect(scene.customRenderTargets).toHaveLength(baselineTargets + 1);
		expect(scene.layers).toHaveLength(baselineLayers + 1);
		expect(scene.getMeshByName("Debug Box")?.material).toBe(material);
		expect(JSON.stringify(SceneSerializer.Serialize(scene))).not.toContain("Babylon Editor Render Debug View");
		expect(() => setRenderDebugView(scene, { expectedRevision: 1, mode: "disabled" }, options)).toThrow("revision is stale");

		const complexity = setRenderDebugView(scene, { expectedRevision: 2, mode: "light-complexity", maximumLightCount: 4 }, options);
		expect(complexity).toMatchObject({ revision: 3, mode: "light-complexity", active: true, maximumLightCount: 4, meshCount: 1, lightCount: 2 });
		expect(complexity.lightCountHistogram).toEqual([0, 0, 1, 0, 0]);
		expect(scene.getMeshByName("Debug Box")?.material).toBe(material);
		expect(scene.customRenderTargets).toHaveLength(baselineTargets + 1);
		expect(scene.layers).toHaveLength(baselineLayers + 1);

		const disabled = setRenderDebugView(scene, { expectedRevision: 3, mode: "disabled" }, options);
		expect(disabled).toMatchObject({ revision: 4, mode: "disabled", active: false, meshCount: 0 });
		expect(scene.customRenderTargets).toHaveLength(baselineTargets);
		expect(scene.layers).toHaveLength(baselineLayers);
		expect(scene.materials).toHaveLength(baselineMaterials);
		expect(scene.textures).toHaveLength(baselineTextures);
		expect(scene.getMeshByName("Debug Box")?.material).toBe(material);
	});

	test("rejects invalid reconfiguration atomically and returns bounded capture evidence", async () => {
		const overdraw = setRenderDebugView(scene, { expectedRevision: 1, mode: "overdraw", maximumOverdraw: 8 }, options);
		const baselineTargets = scene.customRenderTargets.length;
		const baselineLayers = scene.layers.length;

		expect(() => setRenderDebugView(scene, { expectedRevision: 2, mode: "overdraw", maximumOverdraw: 3 }, options)).toThrow(
			"maximumOverdraw must be an integer from 4 through 32"
		);
		expect(getRenderDebugView(scene)).toMatchObject({ revision: overdraw.revision, mode: "overdraw", maximumOverdraw: 8 });
		expect(scene.customRenderTargets).toHaveLength(baselineTargets);
		expect(scene.layers).toHaveLength(baselineLayers);
		const baselineMaterials = scene.materials.length;
		const baselineTextures = scene.textures.length;
		const addObserver = vi.spyOn(scene.onBeforeRenderObservable, "add").mockImplementationOnce(() => {
			throw new Error("forced diagnostic allocation failure");
		});
		expect(() => setRenderDebugView(scene, { expectedRevision: 2, mode: "light-complexity", maximumLightCount: 4 }, options)).toThrow("forced diagnostic allocation failure");
		addObserver.mockRestore();
		expect(getRenderDebugView(scene)).toMatchObject({ revision: 2, mode: "overdraw", maximumOverdraw: 8 });
		expect(scene.customRenderTargets).toHaveLength(baselineTargets);
		expect(scene.layers).toHaveLength(baselineLayers);
		expect(scene.materials).toHaveLength(baselineMaterials);
		expect(scene.textures).toHaveLength(baselineTextures);

		vi.spyOn(scene.customRenderTargets.at(-1)!, "readPixels").mockResolvedValue(new Uint8Array(320 * 180 * 4).fill(16));
		const capture = await captureRenderDebugView(scene, { expectedRevision: 2, width: 160, height: 90, includeImage: true });
		expect(capture).toMatchObject({ revision: 2, mode: "overdraw", pixelCount: 320 * 180 });
		expect(capture.pixelSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(capture.preview).toMatchObject({ width: 160, height: 90 });
		expect(capture.preview.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(capture.preview.pngBase64).toEqual(expect.any(String));
		await expect(captureRenderDebugView(scene, { expectedRevision: 1 })).rejects.toThrow("revision is stale");
	});

	test("bounds the transient target while preserving a large preview aspect ratio", () => {
		vi.spyOn(engine, "getRenderWidth").mockReturnValue(8000);
		vi.spyOn(engine, "getRenderHeight").mockReturnValue(4000);
		const report = setRenderDebugView(scene, { expectedRevision: 1, mode: "light-complexity" }, options);
		expect(report).toMatchObject({ width: 2048, height: 1024, meshCount: 1 });
		expect(report.width * report.height).toBeLessThanOrEqual(2048 * 2048);
	});
});

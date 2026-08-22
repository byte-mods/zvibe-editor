import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { getDynamicResolution, resetDynamicResolutionRuntime, setDynamicResolution } from "../../src/mcp/rendering/dynamic-resolution";
import { applyRenderingProfile, createRenderingProfile } from "../../src/mcp/rendering/profiles";

describe("mcp/dynamic-resolution", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, preview: { scene: null } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("updates, activates, reads, resets, and strictly leases one shared adaptive policy", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const created = createRenderingProfile(scene, { name: "Adaptive Web", target: "web-performance", configurations }, options);
		const configured = setDynamicResolution(
			scene,
			{
				id: created.id,
				revision: created.revision,
				configuration: { mode: "adaptive", minimumScale: 0.5, maximumScale: 1, initialScale: 0.75, targetFrameRate: 60, sampleFrames: 4 },
			},
			options
		);
		expect(configured.profile).toMatchObject({ revision: 2, active: false, configuration: { mode: "adaptive", sampleFrames: 4 } });
		expect(() => setDynamicResolution(scene, { id: created.id, revision: 1, configuration: { mode: "fixed" } }, options)).toThrow("lease is stale");
		expect(() => setDynamicResolution(scene, { id: created.id, revision: 2, configuration: { unexpected: true } }, options)).toThrow("Unknown dynamic resolution field");

		applyRenderingProfile(scene, { id: created.id, revision: 2, nodeId: camera.id, activateProject: true }, options);
		expect(getDynamicResolution(scene)).toMatchObject({
			profile: { id: created.id, revision: 2, active: true, configuration: { mode: "adaptive" } },
			runtime: { backend: "bounded-adaptive-dynamic-resolution-v1", running: true, requestedScale: 0.75, measurement: "engine-frame-cadence-ms" },
		});
		expect(resetDynamicResolutionRuntime(scene, { id: created.id, revision: 2 }, options)).toMatchObject({
			profileId: created.id,
			profileRevision: 2,
			runtime: { lastDecision: "reset", totalFrames: 0 },
		});
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { getRenderReconstruction, resetRenderReconstructionHistory, setRenderReconstruction } from "../../src/mcp/rendering/render-reconstruction";
import { applyRenderingProfile, clearActiveRenderingProfile, createRenderingProfile } from "../../src/mcp/rendering/profiles";

describe("mcp/render-reconstruction", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, preview: { scene: null } } } } as any;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 320, renderHeight: 180 });
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("updates, activates, reads, resets, and strictly leases one shared temporal policy", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const created = createRenderingProfile(scene, { name: "Temporal Desktop", target: "desktop", configurations }, options);
		const configured = setRenderReconstruction(
			scene,
			{
				id: created.id,
				revision: created.revision,
				configuration: { mode: "temporal", sharpness: 0.5, historyWeight: 0.8, jitterSamples: 16, reprojectHistory: false },
			},
			options
		);
		expect(configured.profile).toMatchObject({
			revision: 2,
			active: false,
			configuration: { mode: "temporal", sharpness: 0.5, historyWeight: 0.8, jitterSamples: 16, reprojectHistory: false },
		});
		expect(() => setRenderReconstruction(scene, { id: created.id, revision: 1, configuration: { mode: "spatial" } }, options)).toThrow("lease is stale");
		expect(() => setRenderReconstruction(scene, { id: created.id, revision: 2, configuration: { unexpected: true } }, options)).toThrow("Unknown render reconstruction field");

		applyRenderingProfile(scene, { id: created.id, revision: 2, nodeId: camera.id, activateProject: true }, options);
		expect(getRenderReconstruction(scene)).toMatchObject({
			profile: { id: created.id, revision: 2, active: true, configuration: { mode: "temporal" } },
			runtime: {
				backend: "bounded-full-resolution-reconstruction-v1",
				running: true,
				mode: "temporal",
				velocityRequested: false,
				postProcessOrder: ["Edge-Adaptive Spatial Reconstruction", "Velocity-Reprojected Temporal Reconstruction", "Present Temporal Reconstruction History"],
			},
		});
		expect(resetRenderReconstructionHistory(scene, { id: created.id, revision: 2 }, options)).toMatchObject({
			id: created.id,
			revision: 2,
			runtime: { historyFrames: 0, historyValid: false, lastHistoryResetReason: "History reset requested through the exact MCP profile lease." },
		});
		expect(() => resetRenderReconstructionHistory(scene, { id: created.id, revision: 1 }, options)).toThrow("lease is stale");
		expect(clearActiveRenderingProfile(scene, { id: created.id, revision: 2, confirm: true }, options)).toMatchObject({
			runtime: { reconstruction: { configured: false, running: false } },
		});
	});
});

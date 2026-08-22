import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, PassPostProcess, PostProcess, Scene, Vector3 } from "@babylonjs/core";

import { configureDynamicResolution, dynamicResolutionPreset, getDynamicResolutionScaleConsumerId } from "../../src/loading/dynamic-resolution";
import {
	configureRenderReconstruction,
	getRenderReconstructionRuntime,
	renderReconstructionPreset,
	resetRenderReconstructionHistory,
	stopRenderReconstruction,
	validateRenderReconstructionConfiguration,
} from "../../src/loading/render-reconstruction";

describe("loading/render-reconstruction", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		engine.setSize(320, 180);
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("validates a closed bounded policy and rejects unknown or invalid values", () => {
		expect(validateRenderReconstructionConfiguration(undefined)).toEqual(renderReconstructionPreset());
		expect(validateRenderReconstructionConfiguration({ mode: "temporal", jitterSamples: 16 })).toMatchObject({
			version: 1,
			mode: "temporal",
			jitterSamples: 16,
		});
		expect(() => validateRenderReconstructionConfiguration({ mode: "vendor-upscaler" })).toThrow("mode is invalid");
		expect(() => validateRenderReconstructionConfiguration({ unexpected: true })).toThrow("Unknown render reconstruction field");
	});

	test("inserts a low-resolution spatial stage and full-resolution boundary without disturbing existing relative order", () => {
		const before = new PassPostProcess("Before", 1, null, undefined, engine);
		const after = new PassPostProcess("After", 1, null, undefined, engine);
		camera.attachPostProcess(before);
		camera.attachPostProcess(after);
		const runtime = configureRenderReconstruction(scene, camera, "desktop", 4, { ...renderReconstructionPreset(), mode: "spatial" }, 0.5);
		expect(runtime).toMatchObject({
			configured: true,
			running: true,
			profileId: "desktop",
			profileRevision: 4,
			mode: "spatial",
			sourceScale: 0.5,
			spatialAlgorithm: "bounded-edge-adaptive-spatial-v1",
		});
		expect(runtime.postProcessOrder).toEqual(["Edge-Adaptive Spatial Reconstruction", "Full-Resolution Reconstruction Boundary", "Before", "After"]);
		expect(getDynamicResolutionScaleConsumerId(scene)).toBe("render-reconstruction-source");
		stopRenderReconstruction(scene);
		expect((camera as unknown as { _postProcesses: Array<PostProcess | null> })._postProcesses.filter(Boolean).map((value) => value!.name)).toEqual(["Before", "After"]);
		expect(getDynamicResolutionScaleConsumerId(scene)).toBeNull();
	});

	test("routes fixed dynamic resolution to the reconstruction source instead of hardware presentation size", () => {
		let hardwareScalingLevel = 1;
		vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScalingLevel);
		vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((value) => {
			hardwareScalingLevel = value;
		});
		configureRenderReconstruction(scene, camera, "desktop", 2, { ...renderReconstructionPreset(), mode: "spatial" }, 1);
		const dynamic = configureDynamicResolution(scene, "desktop", 2, { ...dynamicResolutionPreset(), mode: "fixed", fixedScale: 0.5 }, 1);
		scene.render();
		expect(dynamic).toMatchObject({ requestedScale: 0.5, effectiveScale: 0.5, hardwareScalingLevel: 1 });
		expect(getRenderReconstructionRuntime(scene)).toMatchObject({
			sourceScale: 0.5,
			effectiveSourceScale: 0.5,
			outputSize: { width: engine.getRenderWidth(), height: engine.getRenderHeight() },
		});
		expect(hardwareScalingLevel).toBe(1);
	});

	test("creates temporal history, supports exact reset, and rejects a second temporal pipeline", () => {
		const temporal = configureRenderReconstruction(scene, camera, "desktop", 3, { ...renderReconstructionPreset(), mode: "temporal", reprojectHistory: false }, 0.75);
		expect(temporal).toMatchObject({
			mode: "temporal",
			temporalAlgorithm: "bounded-history-clamped-temporal-v1",
			velocityRequested: false,
			postProcessOrder: ["Edge-Adaptive Spatial Reconstruction", "Velocity-Reprojected Temporal Reconstruction", "Present Temporal Reconstruction History"],
		});
		expect(resetRenderReconstructionHistory(scene, "Unit-test reset.")).toMatchObject({ historyValid: false, historyFrames: 0, lastHistoryResetReason: "Unit-test reset." });
		stopRenderReconstruction(scene);
		const taa = new PassPostProcess("TAA", 1, null, undefined, engine);
		camera.attachPostProcess(taa);
		expect(() => configureRenderReconstruction(scene, camera, "desktop", 4, { ...renderReconstructionPreset(), mode: "temporal" }, 1)).toThrow(
			'cannot be combined with the existing "TAA"'
		);
	});
});

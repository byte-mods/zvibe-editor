import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import {
	configureDynamicResolution,
	dynamicResolutionPreset,
	getDynamicResolutionRuntime,
	resetDynamicResolutionRuntime,
	sampleDynamicResolutionFrame,
	validateDynamicResolutionConfiguration,
} from "../../src/loading/dynamic-resolution";
import { applyRenderingProfileQuality, IRenderingProfile, renderingProfilePreset, restoreRenderingProfileBaseline } from "../../src/loading/rendering-profiles";
import { renderReconstructionPreset } from "../../src/loading/render-reconstruction";

describe("loading/dynamic-resolution", () => {
	let engine: NullEngine;
	let scene: Scene;
	let hardwareScalingLevel: number;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		hardwareScalingLevel = 1;
		vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScalingLevel);
		vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((value) => {
			hardwareScalingLevel = value;
		});
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.restoreAllMocks();
	});

	test("validates a closed bounded configuration and rejects inconsistent scales", () => {
		expect(validateDynamicResolutionConfiguration(undefined, 0.75)).toMatchObject({ version: 1, mode: "disabled", initialScale: 0.75, fixedScale: 0.75 });
		expect(() => validateDynamicResolutionConfiguration({ ...dynamicResolutionPreset(), unknown: true })).toThrow("Unknown dynamic resolution field");
		expect(() => validateDynamicResolutionConfiguration({ ...dynamicResolutionPreset(), minimumScale: 1, maximumScale: 0.5 })).toThrow(
			"minimumScale cannot exceed maximumScale"
		);
	});

	test("adapts only after complete cadence windows and honors asymmetric cooldown", () => {
		const configuration = {
			...dynamicResolutionPreset(),
			mode: "adaptive" as const,
			minimumScale: 0.5,
			maximumScale: 1,
			initialScale: 1,
			targetFrameRate: 60,
			sampleFrames: 3,
			cooldownFrames: 2,
			downscaleStep: 0.2,
			upscaleStep: 0.1,
		};
		configureDynamicResolution(scene, "profile", 4, configuration, 1);
		expect(getDynamicResolutionRuntime(scene)).toMatchObject({ running: true, requestedScale: 1, effectiveScale: 1, profileRevision: 4 });

		sampleDynamicResolutionFrame(scene, 25);
		sampleDynamicResolutionFrame(scene, 25);
		expect(getDynamicResolutionRuntime(scene).requestedScale).toBe(1);
		sampleDynamicResolutionFrame(scene, 25);
		expect(getDynamicResolutionRuntime(scene)).toMatchObject({ requestedScale: 0.8, effectiveScale: 0.8, lastDecision: "downscale", cooldownRemaining: 2 });

		sampleDynamicResolutionFrame(scene, 8);
		sampleDynamicResolutionFrame(scene, 8);
		expect(getDynamicResolutionRuntime(scene).requestedScale).toBe(0.8);
		sampleDynamicResolutionFrame(scene, 8);
		expect(getDynamicResolutionRuntime(scene)).toMatchObject({
			requestedScale: 0.9,
			effectiveScale: 0.9,
			lastDecision: "upscale",
			scaleChanges: [{ decision: "downscale" }, { decision: "upscale" }],
		});
	});

	test("samples the real scene render observer used by editor and exported runtimes", () => {
		new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = scene.cameras[0];
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(25);
		configureDynamicResolution(scene, "exported-profile", 1, { ...dynamicResolutionPreset(), mode: "adaptive", sampleFrames: 2, cooldownFrames: 0, downscaleStep: 0.25 }, 1);
		scene.render();
		scene.render();
		expect(getDynamicResolutionRuntime(scene)).toMatchObject({ totalFrames: 2, acceptedSamples: 2, requestedScale: 0.75, lastDecision: "downscale" });
	});

	test("resets evidence and rendering-profile clear restores the exact pre-activation scale", () => {
		hardwareScalingLevel = 1.25;
		const quality = { ...renderingProfilePreset("desktop"), renderScale: 1 };
		const profile: IRenderingProfile = {
			version: 4,
			id: "fixed",
			name: "Fixed",
			revision: 2,
			target: "desktop",
			quality,
			dynamicResolution: { ...dynamicResolutionPreset(), mode: "fixed", fixedScale: 0.5 },
			reconstruction: renderReconstructionPreset(),
			requirements: {},
			configurations: {},
		};
		const runtime = applyRenderingProfileQuality(scene, profile, undefined, false);
		expect(runtime.dynamicResolution).toMatchObject({ mode: "fixed", running: false, requestedScale: 0.5, effectiveScale: 0.5 });
		expect(hardwareScalingLevel).toBe(2);
		expect(resetDynamicResolutionRuntime(scene)).toMatchObject({ lastDecision: "reset", requestedScale: 0.5, totalFrames: 0 });
		restoreRenderingProfileBaseline(scene);
		expect(hardwareScalingLevel).toBe(1.25);
		expect(getDynamicResolutionRuntime(scene)).toMatchObject({ configured: false, running: false });
	});
});

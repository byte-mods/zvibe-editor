import { describe, expect, test } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import {
	activeRenderingProfileMetadataKey,
	applyRenderingProfileQuality,
	configureActiveRenderingProfile,
	IRenderingProfile,
	renderingProfilePreset,
	restoreRenderingProfileBaseline,
	validateRenderingProfiles,
} from "../../src/loading/rendering-profiles";
import { renderReconstructionPreset } from "../../src/loading/render-reconstruction";

function profile(overrides: Partial<IRenderingProfile> = {}): IRenderingProfile {
	const quality = renderingProfilePreset("desktop");
	return {
		version: 4,
		id: "desktop",
		name: "Desktop High",
		revision: 1,
		target: "desktop",
		quality,
		dynamicResolution: {
			version: 1,
			mode: "disabled",
			minimumScale: 0.5,
			maximumScale: 1,
			initialScale: 1,
			fixedScale: 1,
			targetFrameRate: 60,
			sampleFrames: 30,
			cooldownFrames: 30,
			downscaleFrameTimeRatio: 1.1,
			upscaleFrameTimeRatio: 0.8,
			downscaleStep: 0.1,
			upscaleStep: 0.05,
			upscaler: "browser-linear",
		},
		reconstruction: renderReconstructionPreset(),
		requirements: {},
		configurations: {},
		...overrides,
	};
}

describe("loading/rendering-profiles", () => {
	test("migrates legacy camera profiles into bounded version-4 project profiles", () => {
		const values = validateRenderingProfiles([{ id: "legacy", name: "Legacy", configurations: { default: null } }]);
		expect(values[0]).toMatchObject({
			version: 4,
			revision: 1,
			target: "custom",
			configurations: { default: null },
			dynamicResolution: { mode: "disabled" },
			reconstruction: { mode: "disabled" },
		});
		expect(values[0].quality).toEqual(renderingProfilePreset("custom"));
	});

	test("applies exact quality and runtime state through the shared scene backend", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = scene.cameras[0];
		const value = profile({
			quality: { ...renderingProfilePreset("desktop"), textures: "medium", shadows: "low", lods: "very-low", renderScale: 0.5, performancePriority: "aggressive" },
		});
		const runtime = applyRenderingProfileQuality(scene, value, undefined, false);
		expect(runtime).toMatchObject({
			configured: true,
			compatible: true,
			activeProfileId: "desktop",
			capabilities: { backend: "NullEngine" },
			applied: {
				textures: "medium",
				shadows: "low",
				lods: "very-low",
				renderScale: 0.5,
				hardwareScalingLevel: 1,
				performancePriority: "aggressive",
				cameraProfileApplied: false,
			},
		});
		expect(scene.loadingTexturesQuality).toBe("medium");
		expect(scene.performancePriority).toBe(2);
		expect(restoreRenderingProfileBaseline(scene)).toMatchObject({ configured: false, activeProfileId: null });
		expect(scene.performancePriority).toBe(0);
		scene.dispose();
		engine.dispose();
	});

	test("reports incompatible requirements without mutating the requested render scale", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const before = engine.getHardwareScalingLevel();
		const runtime = applyRenderingProfileQuality(
			scene,
			profile({ requirements: { webgpu: true, computeShaders: true }, quality: { ...renderingProfilePreset("desktop"), renderScale: 2 } })
		);
		expect(runtime.compatible).toBe(false);
		expect(runtime.errors).toEqual(expect.arrayContaining(["Required capability webgpu is unavailable.", "Required capability computeShaders is unavailable."]));
		expect(runtime.applied).toBeNull();
		expect(engine.getHardwareScalingLevel()).toBe(before);
		scene.dispose();
		engine.dispose();
	});

	test("restores the persisted active profile and rejects malformed closed quality data", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = { babylonEditorRenderingProfiles: [profile()], [activeRenderingProfileMetadataKey]: "desktop" };
		expect(configureActiveRenderingProfile(scene, undefined, false)).toMatchObject({ configured: true, activeProfileName: "Desktop High" });
		expect(() => validateRenderingProfiles([profile({ quality: { ...renderingProfilePreset("desktop"), unexpected: true } as any })])).toThrow(
			"Unknown rendering profile quality field"
		);
		scene.dispose();
		engine.dispose();
	});
});

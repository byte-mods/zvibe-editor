import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { applyRenderingConfigurations } from "../../src/loading/rendering";
import { blendRenderingConfiguration, getRenderingVolumeBlendFactor, getRenderingVolumeContributions } from "../../src/loading/rendering-volume-blend";
import { configureRenderingVolumes } from "../../src/loading/rendering-volumes";
import {
	customColorPostProcessCameraConfigurations,
	disposeCustomColorPostProcess,
	getCustomColorPostProcess,
	serializeCustomColorPostProcess,
} from "../../src/rendering/custom-color";
import { applyRenderingConfigurationForCamera } from "../../src/rendering/tools";

describe("loading/rendering", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
	});

	afterEach(() => {
		disposeCustomColorPostProcess();
		customColorPostProcessCameraConfigurations.clear();
		scene.dispose();
		engine.dispose();
	});

	test("restores persisted custom color render-pass configuration", () => {
		const configuration = { tint: [0.8, 0.9, 1], tintStrength: 0.25, saturation: 1.1, contrast: 1.05, brightness: 0.02 };
		applyRenderingConfigurations(scene, [{ cameraId: camera.id, customColorPostProcess: configuration }]);
		expect(customColorPostProcessCameraConfigurations.get(camera)).toEqual(configuration);
	});

	test("applies a persisted custom color render pass to its camera", () => {
		const configuration = { tint: [0.8, 0.9, 1], tintStrength: 0.25, saturation: 1.1, contrast: 1.05, brightness: 0.02 };
		customColorPostProcessCameraConfigurations.set(camera, configuration);
		applyRenderingConfigurationForCamera(camera, "");
		expect(getCustomColorPostProcess()).toBeTruthy();
		expect(serializeCustomColorPostProcess()).toEqual(configuration);
	});

	test("calculates weighted rendering-volume edge falloff", () => {
		const volume = { center: [0, 0, 0], size: [20, 20, 20], priority: 1, blendDistance: 10, weight: 0.8 };
		expect(getRenderingVolumeBlendFactor(volume, [0, 0, 0])).toBe(0.8);
		expect(getRenderingVolumeBlendFactor(volume, [15, 0, 0])).toBeCloseTo(0.4);
		expect(getRenderingVolumeBlendFactor(volume, [20, 0, 0])).toBe(0);
	});

	test("orders overlaps by priority and recursively blends numeric settings", () => {
		const low = { id: "low", center: [0, 0, 0], size: [20, 20, 20], priority: 1 };
		const high = { id: "high", center: [0, 0, 0], size: [20, 20, 20], priority: 2, weight: 0.5 };
		expect(getRenderingVolumeContributions([high, low], [0, 0, 0]).map((entry) => entry.volume.id)).toEqual(["low", "high"]);
		expect(
			blendRenderingConfiguration(
				{ customColor: { brightness: 0, tint: [1, 1, 1], enabled: false } },
				{ customColor: { brightness: 1, tint: [0, 0.5, 1], enabled: true } },
				0.25
			)
		).toEqual({ customColor: { brightness: 0.25, tint: [0.75, 0.875, 1], enabled: false } });
	});

	test("applies and restores a blended volume in an exported scene", () => {
		const baseline = { tint: [1, 1, 1], tintStrength: 0, saturation: 1, contrast: 1, brightness: 0 };
		const override = { ...baseline, brightness: 1 };
		customColorPostProcessCameraConfigurations.set(camera, baseline);
		scene.activeCamera = camera;
		scene.metadata = {
			babylonEditorRenderingProfiles: [{ id: "profile", configurations: { customColor: override } }],
			babylonEditorRenderingVolumes: [
				{ id: "volume", profileId: "profile", center: [0, 0, 0], size: [20, 20, 20], priority: 0, blendDistance: 10, weight: 1, enabled: true },
			],
		};
		configureRenderingVolumes(scene, "");
		camera.position.x = 15;
		camera.computeWorldMatrix();
		scene.render();
		expect(customColorPostProcessCameraConfigurations.get(camera)?.brightness).toBeCloseTo(0.5);
		camera.position.x = 20;
		camera.computeWorldMatrix();
		scene.render();
		expect(customColorPostProcessCameraConfigurations.get(camera)).toEqual(baseline);
	});
});

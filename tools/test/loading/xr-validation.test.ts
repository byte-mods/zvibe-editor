import { describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";

import { createDefaultXRConfiguration, setSceneXRConfiguration } from "../../src/loading/xr-model";
import { validateXRTarget } from "../../src/loading/xr-validation";

function createScene(): { engine: NullEngine; scene: Scene } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	new FreeCamera("camera", Vector3.Zero(), scene);
	return { engine, scene };
}

describe("loading/xr-validation", () => {
	test("reports stable scene-reference errors and portable semantics warnings", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.session.mode = "immersive-vr";
		configuration.session.optionalFeatures = ["hit-test"];
		configuration.origin.originNodeId = "missing-origin";
		configuration.origin.cameraId = "missing-camera";
		configuration.origin.floorMeshIds = ["missing-floor"];
		configuration.simulation.environmentMeshIds = ["missing-environment"];
		configuration.interactables = [
			{
				id: "missing-interaction",
				name: "Missing Interaction",
				meshId: "missing-mesh",
				enabled: true,
				modes: ["select"],
				interactionLayers: ["default"],
				rotateWithController: true,
				dragSmoothing: 0.2,
				hapticAmplitude: 0,
				hapticDurationMs: 0,
			},
		];
		setSceneXRConfiguration(scene, configuration);

		const report = await validateXRTarget(scene, { target: "web" });
		expect(report.valid).toBe(false);
		expect(report.errors.map((entry) => entry.code)).toEqual([
			"XR_ORIGIN_NODE_MISSING",
			"XR_CAMERA_MISSING",
			"XR_FLOOR_MESH_MISSING",
			"XR_SIMULATION_ENVIRONMENT_MISSING",
			"XR_INTERACTABLE_MESH_MISSING",
		]);
		expect(report.warnings.map((entry) => entry.code)).toContain("XR_AR_FEATURE_IN_VR");
		expect(report.info).toEqual([expect.objectContaining({ code: "XR_NATIVE_PROVIDER_BOUNDARY" })]);
		scene.dispose();
		engine.dispose();
	});

	test("separates deterministic build validation from current-device capability probing", async () => {
		const { engine, scene } = createScene();
		const floor = MeshBuilder.CreateGround("floor", {}, scene);
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.origin.cameraId = "camera";
		configuration.origin.floorMeshIds = [floor.id];
		configuration.interaction.handTracking = false;
		setSceneXRConfiguration(scene, configuration);

		const buildReport = await validateXRTarget(scene, { target: "web" });
		expect(buildReport).toMatchObject({ valid: true, capabilities: { secureContext: null, webXRApi: null, sessionSupported: null, portableRuntime: "webxr" } });
		const unsupported = await validateXRTarget(scene, {
			target: "web",
			checkCurrentDevice: true,
			capabilityProbe: { secureContext: false, webXRApi: false, isSessionSupported: vi.fn(async () => true) },
		});
		expect(unsupported.valid).toBe(false);
		expect(unsupported.errors.map((entry) => entry.code)).toEqual(["XR_INSECURE_CONTEXT", "XR_API_UNAVAILABLE"]);

		const supportedProbe = vi.fn(async () => true);
		const supported = await validateXRTarget(scene, {
			target: "electron-web",
			checkCurrentDevice: true,
			capabilityProbe: { secureContext: true, webXRApi: true, isSessionSupported: supportedProbe },
		});
		expect(supported.valid).toBe(true);
		expect(supported.capabilities).toMatchObject({ target: "electron-web", secureContext: true, webXRApi: true, sessionSupported: true });
		expect(supportedProbe).toHaveBeenCalledWith("immersive-vr");
		scene.dispose();
		engine.dispose();
	});

	test("reports disabled XR as a target error unless an authoring audit explicitly permits it", async () => {
		const { engine, scene } = createScene();
		expect(await validateXRTarget(scene)).toMatchObject({ valid: false, errors: [expect.objectContaining({ code: "XR_DISABLED" })] });
		expect(await validateXRTarget(scene, { requireEnabled: false })).toMatchObject({ valid: true });
		scene.dispose();
		engine.dispose();
	});
});

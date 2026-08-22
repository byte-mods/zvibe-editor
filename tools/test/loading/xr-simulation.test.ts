import { describe, expect, test } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

import { createDefaultXRConfiguration, setSceneXRConfiguration } from "../../src/loading/xr-model";
import { getXRSimulationSnapshot, getXRSimulator, simulateXRInput, startXRSimulation, stopXRSimulation } from "../../src/loading/xr-simulation";

function createScene(): { engine: NullEngine; scene: Scene; camera: FreeCamera } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const camera = new FreeCamera("camera", new Vector3(1, 2, 3), scene);
	scene.activeCamera = camera;
	return { engine, scene, camera };
}

describe("loading/xr-simulation", () => {
	test("simulates deterministic ray grab, controller motion, release, and exact transform restoration", () => {
		const { engine, scene, camera } = createScene();
		const origin = new TransformNode("xr-origin", scene);
		origin.position.x = 300;
		camera.parent = origin;
		const box = MeshBuilder.CreateBox("box", { size: 50 }, scene);
		box.position.x = 300;
		box.position.z = 200;
		box.computeWorldMatrix(true);
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.simulation.enabled = true;
		configuration.origin.originNodeId = origin.id;
		configuration.origin.cameraId = camera.id;
		configuration.simulation.rightController.position = [0, 0, 0];
		configuration.interactables = [
			{
				id: "box-interaction",
				name: "Box Interaction",
				meshId: box.id,
				enabled: true,
				modes: ["select", "grab"],
				interactionLayers: ["default"],
				rotateWithController: true,
				dragSmoothing: 0.2,
				hapticAmplitude: 0,
				hapticDurationMs: 0,
			},
		];
		setSceneXRConfiguration(scene, configuration);

		expect(startXRSimulation(scene, { now: () => 42 })).toMatchObject({ phase: "active", configurationRevision: 1 });
		expect(camera.position.asArray()).toEqual([0, 170, 0]);
		const grabbed = simulateXRInput(scene, { type: "press-select", device: "right", interactionMode: "grab", interactionLayers: ["default"] });
		expect(grabbed).toMatchObject({
			rays: [expect.objectContaining({ hit: true, meshId: box.id })],
			heldInteractables: [{ controller: "right", interactableId: "box-interaction" }],
		});
		simulateXRInput(scene, { type: "move-pose", device: "right", deltaPosition: [1, 0, 0], deltaRotation: [0, 30, 0] });
		expect(box.absolutePosition.asArray()).toEqual([400, 0, 200]);
		expect(box.rotationQuaternion).not.toBeNull();
		simulateXRInput(scene, { type: "release-select", device: "right" });
		expect(getXRSimulationSnapshot(scene)?.heldInteractables).toEqual([]);

		const stopped = stopXRSimulation(scene);
		expect(stopped?.trace.map((entry) => entry.type)).toEqual(["start", "grab", "pose", "release", "stop"]);
		expect(stopped?.trace.every((entry) => entry.timestamp === 42)).toBe(true);
		expect(box.position.asArray()).toEqual([300, 0, 200]);
		expect(box.rotationQuaternion).toBeNull();
		expect(camera.position.asArray()).toEqual([1, 2, 3]);
		expect(getXRSimulator(scene)).toBeNull();
		scene.dispose();
		engine.dispose();
	});

	test("supports teleport floors, layer-filtered misses, child-mesh picks, and bounded traces", () => {
		const { engine, scene } = createScene();
		const root = MeshBuilder.CreateBox("teleport-root", { size: 10 }, scene);
		root.position.z = 500;
		const child = MeshBuilder.CreateBox("teleport-child", { size: 50 }, scene);
		child.parent = root;
		child.position.z = -100;
		root.computeWorldMatrix(true);
		child.computeWorldMatrix(true);
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.simulation.enabled = true;
		configuration.simulation.rightController.position = [0, 0, 0];
		configuration.origin.floorMeshIds = [root.id];
		configuration.maxTraceEvents = 16;
		setSceneXRConfiguration(scene, configuration);

		startXRSimulation(scene, { now: () => 7 });
		const teleported = simulateXRInput(scene, { type: "press-select", device: "right", interactionMode: "teleport" });
		expect(teleported.rays[0]).toMatchObject({ hit: true, meshId: child.id });
		expect(teleported.devices.find((device) => device.device === "headset")?.position[2]).toBeGreaterThanOrEqual(4);
		simulateXRInput(scene, { type: "set-pose", device: "right", rotation: [0, 180, 0] });
		const missed = simulateXRInput(scene, { type: "press-select", device: "right", interactionMode: "teleport", interactionLayers: ["blocked"] });
		expect(missed.rays.at(-1)).toMatchObject({ hit: false, meshId: null });
		for (let index = 0; index < 20; index++) {
			simulateXRInput(scene, { type: "set-pose", device: "right", rotation: [0, 180 + index, 0] });
		}
		expect(getXRSimulationSnapshot(scene)?.trace).toHaveLength(16);
		stopXRSimulation(scene);
		scene.dispose();
		engine.dispose();
	});

	test("rejects disabled simulation, headset button input, inactive input, and restores on scene disposal", () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		setSceneXRConfiguration(scene, configuration);
		expect(() => startXRSimulation(scene)).toThrow("simulation must be enabled");
		configuration.simulation.enabled = true;
		setSceneXRConfiguration(scene, configuration);
		const started = startXRSimulation(scene);
		expect(startXRSimulation(scene).trace).toEqual(started.trace);
		expect(() => simulateXRInput(scene, { type: "press-select", device: "headset" })).toThrow("requires the left or right controller");
		expect(() => simulateXRInput(scene, { type: "set-pose", device: "right", position: [0, 0, 0], unknown: true } as never)).toThrow("unsupported fields");
		const beforeInvalidPose = getXRSimulationSnapshot(scene)?.devices.find((device) => device.device === "right")?.position;
		expect(() => simulateXRInput(scene, { type: "set-pose", device: "right", position: [200_000, 0, 0] })).toThrow("must remain");
		expect(getXRSimulationSnapshot(scene)?.devices.find((device) => device.device === "right")?.position).toEqual(beforeInvalidPose);
		scene.dispose();
		expect(getXRSimulator(scene)).toBeNull();
		expect(() => simulateXRInput(scene, { type: "set-pose", device: "right", position: [0, 0, 0] })).toThrow("not active");
		engine.dispose();
	});
});

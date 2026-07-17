import { describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import { configureVirtualCameras } from "../../src/loading/virtual-cameras";

describe("loading/virtual-cameras", () => {
	test("restores the selected virtual camera and advances its spline dolly in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spline = MeshBuilder.CreateLines("Path", { points: [Vector3.Zero(), new Vector3(0, 0, 100)] }, scene);
		spline.metadata = { type: "Spline", points: [[0, 0, 0], [0, 0, 100]], closed: false };
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.metadata = {
			babylonEditorActiveVirtualCameraId: "rail",
			babylonEditorVirtualCameras: [{ id: "rail", cameraId: camera.id, offset: [0, 0, 0], priority: 0, dolly: { splineId: spline.id, t: 0, speed: 100, loop: false, orientToPath: true } }],
		};
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);

		configureVirtualCameras(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(scene.activeCamera).toBe(camera);
		expect(camera.position.z).toBe(50);
		expect(scene.metadata.babylonEditorVirtualCameras[0].dolly.t).toBe(0.5);
		scene.dispose();
		engine.dispose();
	});

	test("follows the weighted center of a persisted target group", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const left = MeshBuilder.CreateBox("Left", { size: 1 }, scene);
		left.position.x = -20;
		const right = MeshBuilder.CreateBox("Right", { size: 1 }, scene);
		right.position.x = 20;
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.metadata = {
			babylonEditorActiveVirtualCameraId: "group",
			babylonEditorCameraTargetGroups: [{ id: "players", members: [{ nodeId: left.id, weight: 1 }, { nodeId: right.id, weight: 3 }] }],
			babylonEditorVirtualCameras: [{ id: "group", cameraId: camera.id, offset: [0, 10, -20], priority: 0, followTargetGroupId: "players" }],
		};

		configureVirtualCameras(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(camera.position.asArray()).toEqual([10, 10, -20]);
		scene.dispose();
		engine.dispose();
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import {
	activateVirtualCamera,
	createVirtualCamera,
	deleteCameraTargetGroup,
	listCameraTargetGroups,
	setCameraTargetGroup,
	setVirtualCameraDolly,
	setVirtualCameraTargetGroups,
} from "../../src/mcp/virtual-cameras/virtual-cameras";
import { deleteCameraImpulseSource, fireCameraImpulse, listCameraImpulseSources, setCameraImpulseSource } from "../../src/mcp/virtual-cameras/impulses";

describe("mcp/virtual-cameras", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists a spline dolly and applies its authored camera pose", () => {
		const spline = MeshBuilder.CreateLines("Dolly Path", { points: [Vector3.Zero(), new Vector3(100, 0, 0)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[100, 0, 0],
			],
			closed: false,
		};
		const camera = new FreeCamera("Dolly Camera", Vector3.Zero(), scene);
		const virtualCamera = createVirtualCamera(scene, { name: "Rail", cameraId: camera.id }, options);

		const result = setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: spline.id, t: 0.5, speed: 25, loop: false, orientToPath: true }, options);
		expect(result.dolly).toEqual({ splineId: spline.id, t: 0.5, speed: 25, loop: false, orientToPath: true });
		expect(camera.position.x).toBe(50);
		activateVirtualCamera(scene, { virtualCameraId: virtualCamera.id }, options);
		expect(scene.metadata.babylonEditorActiveVirtualCameraId).toBe(virtualCamera.id);
	});

	test("updates and detaches a persisted spline dolly without deleting its virtual camera", () => {
		const spline = MeshBuilder.CreateLines("Dolly Path", { points: [Vector3.Zero(), new Vector3(100, 0, 0)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[100, 0, 0],
			],
			closed: false,
		};
		const camera = new FreeCamera("Dolly Camera", Vector3.Zero(), scene);
		const virtualCamera = createVirtualCamera(scene, { name: "Rail", cameraId: camera.id }, options);

		setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: spline.id, t: 0, speed: 25, loop: true, orientToPath: true }, options);
		const updated = setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: spline.id, t: 0.75, speed: 50, loop: false, orientToPath: false }, options);
		expect(updated.dolly).toEqual({ splineId: spline.id, t: 0.75, speed: 50, loop: false, orientToPath: false });
		const detached = setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: null }, options);
		expect(detached).toMatchObject({ id: virtualCamera.id });
		expect(detached).not.toHaveProperty("dolly");
	});

	test("moves a virtual camera to the weighted center of a persisted target group", () => {
		const left = MeshBuilder.CreateBox("Left", { size: 1 }, scene);
		left.position.x = -20;
		const right = MeshBuilder.CreateBox("Right", { size: 1 }, scene);
		right.position.x = 20;
		const camera = new FreeCamera("Group Camera", new Vector3(0, 10, -20), scene);
		const group = setCameraTargetGroup(
			scene,
			{
				name: "Players",
				members: [
					{ nodeId: left.id, weight: 1 },
					{ nodeId: right.id, weight: 3 },
				],
			},
			options
		);
		const virtualCamera = createVirtualCamera(scene, { name: "Group Shot", cameraId: camera.id }, options);

		setVirtualCameraTargetGroups(scene, { virtualCameraId: virtualCamera.id, followTargetGroupId: group.id }, options);
		expect(camera.position.x).toBe(10);
		expect(listCameraTargetGroups(scene).targetGroups).toHaveLength(1);
		expect(deleteCameraTargetGroup(scene, { targetGroupId: group.id }, options)).toMatchObject({ deleted: true });
	});

	test("persists and fires a decaying camera impulse in the editor preview", () => {
		const camera = new FreeCamera("Impulse Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const source = setCameraImpulseSource(scene, { name: "Explosion", amplitude: 10, duration: 1, frequency: 0.5, direction: [1, 0, 0] }, options);
		expect(listCameraImpulseSources(scene).impulseSources).toHaveLength(1);
		expect(fireCameraImpulse(scene, { impulseId: source.id }, options)).toMatchObject({ fired: true, impulseId: source.id });
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(camera.position.x).toBe(5);
		expect(deleteCameraImpulseSource(scene, { impulseId: source.id }, options)).toMatchObject({ deleted: true });
	});
});

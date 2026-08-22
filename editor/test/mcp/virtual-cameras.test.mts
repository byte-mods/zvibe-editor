import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "babylonjs";

import {
	activateVirtualCamera,
	controlVirtualCameraPathTimelinePlayback,
	createVirtualCamera,
	deleteCameraTargetGroup,
	deleteCameraNoiseProfile,
	getVirtualCameraRuntime,
	getVirtualCameraPathTimeline,
	listCameraNoiseProfiles,
	listCameraTargetGroups,
	setCameraNoiseProfile,
	setCameraTargetGroup,
	setVirtualCameraDeoccluder,
	setVirtualCameraDolly,
	setVirtualCameraPathTimeline,
	setVirtualCameraImpulseListener,
	setVirtualCameraNoise,
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

	test("authors and controls an exact-revision spline camera path timeline", () => {
		const spline = MeshBuilder.CreateLines("Timeline Path", { points: [Vector3.Zero(), new Vector3(200, 0, 0)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[200, 0, 0],
			],
			closed: false,
		};
		const camera = new FreeCamera("Timeline Camera", Vector3.Zero(), scene);
		const virtualCamera = createVirtualCamera(scene, { name: "Timeline Shot", cameraId: camera.id }, options);
		setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: spline.id, t: 0, speed: 0, loop: false, orientToPath: true }, options);

		const created = setVirtualCameraPathTimeline(
			scene,
			{
				virtualCameraId: virtualCamera.id,
				duration: 4,
				autoPlay: false,
				wrapMode: "pingPong",
				keys: [
					{ time: 0, t: 0, easing: "easeInOut" },
					{ time: 2, t: 0.25, easing: "linear" },
					{ time: 4, t: 1, easing: "linear" },
				],
			},
			options
		);
		expect(created.timeline).toMatchObject({ revision: 1, duration: 4, wrapMode: "pingPong" });
		expect(created.timeline.keys.every((key: any) => key.id)).toBe(true);
		expect(controlVirtualCameraPathTimelinePlayback(scene, { virtualCameraId: virtualCamera.id, expectedRevision: 1, action: "seek", time: 2 }, options)).toMatchObject({
			runtime: { time: 2, pathT: 0.25, playing: false },
		});
		expect(camera.position.x).toBeCloseTo(50, 6);
		expect(controlVirtualCameraPathTimelinePlayback(scene, { virtualCameraId: virtualCamera.id, expectedRevision: 1, action: "play" }, options).runtime.playing).toBe(true);
		expect(getVirtualCameraPathTimeline(scene, { virtualCameraId: virtualCamera.id })).toMatchObject({ timeline: { revision: 1 }, runtime: { time: 2, playing: true } });
	});

	test("rejects stale or invalid timeline changes atomically and clears only under the exact revision", () => {
		const spline = MeshBuilder.CreateLines("Strict Path", { points: [Vector3.Zero(), new Vector3(100, 0, 0)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[100, 0, 0],
			],
			closed: false,
		};
		const camera = new FreeCamera("Strict Camera", Vector3.Zero(), scene);
		const virtualCamera = createVirtualCamera(scene, { name: "Strict Shot", cameraId: camera.id }, options);
		setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: spline.id }, options);
		const created = setVirtualCameraPathTimeline(
			scene,
			{
				virtualCameraId: virtualCamera.id,
				duration: 2,
				keys: [
					{ id: "a", time: 0, t: 0 },
					{ id: "b", time: 2, t: 1 },
				],
			},
			options
		);

		expect(() => setVirtualCameraPathTimeline(scene, { virtualCameraId: virtualCamera.id, expectedRevision: 0, autoPlay: true }, options)).toThrow("stale");
		expect(() =>
			setVirtualCameraPathTimeline(
				scene,
				{
					virtualCameraId: virtualCamera.id,
					expectedRevision: 1,
					keys: [
						{ id: "a", time: 0, t: 0 },
						{ id: "b", time: 0, t: 1 },
					],
				},
				options
			)
		).toThrow("strictly increasing");
		expect(getVirtualCameraPathTimeline(scene, { virtualCameraId: virtualCamera.id }).timeline).toEqual(created.timeline);
		expect(() => setVirtualCameraPathTimeline(scene, { virtualCameraId: virtualCamera.id, expectedRevision: 2, clear: true }, options)).toThrow("stale");
		expect(() => setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: null }, options)).toThrow("Delete the virtual camera's spline path timeline");
		expect(setVirtualCameraPathTimeline(scene, { virtualCameraId: virtualCamera.id, expectedRevision: 1, clear: true }, options)).toEqual({
			cleared: true,
			virtualCameraId: virtualCamera.id,
			revision: 1,
		});
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

	test("authors layered noise, deocclusion, listener channels, and strict runtime evidence", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 10 }, scene);
		const obstacle = MeshBuilder.CreateBox("Obstacle", { size: 20 }, scene);
		obstacle.position.z = -50;
		target.computeWorldMatrix(true);
		obstacle.computeWorldMatrix(true);
		const camera = new FreeCamera("Procedural Camera", new Vector3(0, 0, -100), scene);
		const virtualCamera = createVirtualCamera(scene, { name: "Procedural", cameraId: camera.id, lookAtNodeId: target.id }, options);
		const profile = setCameraNoiseProfile(
			scene,
			{
				name: "Handheld",
				position: { x: [{ amplitude: 2, frequency: 1, nonRandom: true }], y: [], z: [] },
				rotation: { x: [], y: [{ amplitude: 1, frequency: 0.5 }], z: [] },
			},
			options
		);
		expect(listCameraNoiseProfiles(scene).noiseProfiles).toHaveLength(1);
		setVirtualCameraNoise(scene, { virtualCameraId: virtualCamera.id, noiseProfileId: profile.id, amplitudeGain: 2, frequencyGain: 1, seed: 7 }, options);
		setVirtualCameraImpulseListener(scene, { virtualCameraId: virtualCamera.id, channelMask: 4 }, options);
		const result = setVirtualCameraDeoccluder(
			scene,
			{
				virtualCameraId: virtualCamera.id,
				enabled: true,
				avoidObstacles: true,
				strategy: "pullForward",
				ignoreNodeIds: [target.id],
				cameraRadius: 5,
				damping: 0,
				dampingWhenOccluded: 0,
				shotQuality: { enabled: true, optimalDistance: 50, nearLimit: 1, farLimit: 200 },
			},
			options
		);
		expect(result.runtime.cameraDisplaced).toBe(true);
		expect(result.runtime.obstacleNodeId).toBe(obstacle.id);
		expect(getVirtualCameraRuntime(scene, { virtualCameraId: virtualCamera.id })).toMatchObject({ evaluated: true, virtualCamera: { impulseChannelMask: 4 } });
		expect(() => deleteCameraNoiseProfile(scene, { noiseProfileId: profile.id }, options)).toThrow("still referenced");
		expect(deleteCameraNoiseProfile(scene, { noiseProfileId: profile.id, force: true }, options)).toMatchObject({ deleted: true, clearedVirtualCameraCount: 1 });
	});

	test("persists collision-triggered profile impulses and rejects invalid references", () => {
		const camera = new FreeCamera("Impulse Camera", Vector3.Zero(), scene);
		const collider = MeshBuilder.CreateBox("Impact Body", { size: 1 }, scene);
		const profile = setCameraNoiseProfile(
			scene,
			{ name: "Impact Noise", position: { x: [{ amplitude: 1, frequency: 1 }], y: [], z: [] }, rotation: { x: [], y: [], z: [] } },
			options
		);
		const source = setCameraImpulseSource(
			scene,
			{
				name: "Collision Impact",
				cameraId: camera.id,
				amplitude: 2,
				duration: 0.5,
				frequency: 1,
				direction: [1, 0, 0],
				channelMask: 8,
				noiseProfileId: profile.id,
				trigger: { type: "collision", nodeId: collider.id, minimumImpact: 0.5, includeContinued: false, cooldownSeconds: 0.1, useImpactDirection: true },
			},
			options
		);
		expect(source).toMatchObject({ noiseProfileId: profile.id, channelMask: 8, trigger: { nodeId: collider.id } });
		expect(() => setCameraImpulseSource(scene, { ...source, impulseId: source.id, noiseProfileId: "missing" }, options)).toThrow("was not found");
	});
});

import { describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import { clearVirtualCameraRuntimeState, configureVirtualCameras, controlVirtualCameraPathTimeline, evaluateVirtualCamera } from "../../src/loading/virtual-cameras";

describe("loading/virtual-cameras", () => {
	test("restores the selected virtual camera and advances its spline dolly in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spline = MeshBuilder.CreateLines("Path", { points: [Vector3.Zero(), new Vector3(0, 0, 100)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[0, 0, 100],
			],
			closed: false,
		};
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.metadata = {
			babylonEditorActiveVirtualCameraId: "rail",
			babylonEditorVirtualCameras: [
				{ id: "rail", cameraId: camera.id, offset: [0, 0, 0], priority: 0, dolly: { splineId: spline.id, t: 0, speed: 100, loop: false, orientToPath: true } },
			],
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

	test("plays, seeks, and pauses an eased spline camera timeline in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spline = MeshBuilder.CreateLines("Timeline Path", { points: [Vector3.Zero(), new Vector3(100, 0, 0)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[100, 0, 0],
			],
			closed: false,
		};
		const camera = new FreeCamera("Timeline Camera", Vector3.Zero(), scene);
		const virtualCamera = {
			id: "timeline",
			cameraId: camera.id,
			offset: [0, 0, 0],
			priority: 0,
			dolly: { splineId: spline.id, t: 0, speed: 0, loop: false, orientToPath: true },
			pathTimeline: {
				version: 1 as const,
				revision: 1,
				duration: 2,
				autoPlay: true,
				wrapMode: "once" as const,
				keys: [
					{ id: "start", time: 0, t: 0, easing: "easeIn" as const },
					{ id: "end", time: 2, t: 1, easing: "linear" as const },
				],
			},
		};

		const first = evaluateVirtualCamera(scene, virtualCamera, 1, false);
		expect(first.pathTimeline).toMatchObject({ time: 1, pathT: 0.25, playing: true, fromKeyId: "start", toKeyId: "end" });
		expect(camera.position.x).toBeCloseTo(25, 6);
		expect(controlVirtualCameraPathTimeline(scene, virtualCamera, "seek", 1.5)).toMatchObject({ time: 1.5, pathT: 0.5625 });
		expect(camera.position.x).toBeCloseTo(56.25, 6);
		expect(controlVirtualCameraPathTimeline(scene, virtualCamera, "pause").playing).toBe(false);
		expect(evaluateVirtualCamera(scene, virtualCamera, 1, false).pathTimeline?.time).toBe(1.5);
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
			babylonEditorCameraTargetGroups: [
				{
					id: "players",
					members: [
						{ nodeId: left.id, weight: 1 },
						{ nodeId: right.id, weight: 3 },
					],
				},
			],
			babylonEditorVirtualCameras: [{ id: "group", cameraId: camera.id, offset: [0, 10, -20], priority: 0, followTargetGroupId: "players" }],
		};

		configureVirtualCameras(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(camera.position.asArray()).toEqual([10, 10, -20]);
		scene.dispose();
		engine.dispose();
	});

	test("deoccludes a target, reports shot quality, and applies layered correction noise", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const target = MeshBuilder.CreateBox("Target", { size: 10 }, scene);
		const obstacle = MeshBuilder.CreateBox("Obstacle", { size: 20 }, scene);
		obstacle.position.z = -50;
		const camera = new FreeCamera("Camera", new Vector3(0, 0, -100), scene);
		scene.metadata = {
			babylonEditorCameraNoiseProfiles: [
				{ id: "shake", name: "Shake", position: { x: [{ amplitude: 2, frequency: 1, nonRandom: true }], y: [], z: [] }, rotation: { x: [], y: [], z: [] } },
			],
		};
		const virtualCamera = {
			id: "collision-shot",
			cameraId: camera.id,
			lookAtNodeId: target.id,
			offset: [0, 0, 0],
			priority: 0,
			noise: { profileId: "shake", enabled: true, amplitudeGain: 1, frequencyGain: 1, pivotOffset: [0, 0, 0], seed: 1 },
			deoccluder: {
				enabled: true,
				avoidObstacles: true,
				strategy: "pullForward" as const,
				collideLayerMask: 0x0fffffff,
				transparentLayerMask: 0,
				ignoreNodeIds: [target.id],
				minimumDistanceFromTarget: 1,
				distanceLimit: 0,
				cameraRadius: 5,
				minimumOcclusionTime: 0,
				damping: 0,
				dampingWhenOccluded: 0,
				maximumEffort: 4,
				shotQuality: { enabled: true, optimalDistance: 50, nearLimit: 1, farLimit: 200, maximumQualityBoost: 0.5 },
			},
		};
		const state = evaluateVirtualCamera(scene, virtualCamera, 0.25);

		expect(state.cameraDisplaced).toBe(true);
		expect(state.obstacleNodeId).toBe(obstacle.id);
		expect(state.displacementDistance).toBeGreaterThan(50);
		expect(state.targetObscured).toBe(false);
		expect(state.shotQuality).toBeGreaterThan(0);
		expect(state.noiseProfileId).toBe("shake");
		expect(state.noisePositionOffset[0]).toBeCloseTo(2, 6);
		expect(camera.position.x).toBeCloseTo(2, 6);
		clearVirtualCameraRuntimeState(scene, virtualCamera.id);
		expect(camera.position.x).toBeCloseTo(0, 6);
		scene.dispose();
		engine.dispose();
	});
});

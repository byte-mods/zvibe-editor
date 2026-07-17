import { describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import { configureSplineFollowers } from "../../src/loading/splines";

describe("loading/splines", () => {
	test("advances persisted followers at centimeters per second and orients them along the path", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spline = MeshBuilder.CreateLines("Path", { points: [Vector3.Zero(), new Vector3(100, 0, 0)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[100, 0, 0],
			],
			closed: false,
		};
		const follower = MeshBuilder.CreateBox("Follower", { size: 1 }, scene);
		follower.metadata = { babylonEditorSplineFollower: { splineId: spline.id, speed: 100, t: 0, loop: false, orientToPath: true } };
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);

		configureSplineFollowers(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(follower.metadata.babylonEditorSplineFollower.t).toBe(0.5);
		expect(follower.position.x).toBe(50);
		expect(follower.rotation.y).toBeCloseTo(Math.PI / 2);
		scene.dispose();
		engine.dispose();
	});

	test("moves cameras along authored spline paths", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spline = MeshBuilder.CreateLines("Camera Path", { points: [Vector3.Zero(), new Vector3(0, 0, 100)] }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[0, 0, 100],
			],
			closed: false,
		};
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		camera.metadata = { babylonEditorSplineFollower: { splineId: spline.id, speed: 100, t: 0, loop: false, orientToPath: true } };
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);

		configureSplineFollowers(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(camera.position.z).toBe(50);
		expect(camera.rotation.y).toBe(0);
		scene.dispose();
		engine.dispose();
	});
});

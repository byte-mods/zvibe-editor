import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { deleteSplineFollower, listSplineFollowers, setSplineFollower } from "../../src/mcp/splines/splines";

describe("mcp/spline-followers", () => {
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

	test("persists a follower configuration and moves it to the requested authored distance", () => {
		const spline = MeshBuilder.CreateGround("Path", { width: 1, height: 1 }, scene);
		spline.metadata = {
			type: "Spline",
			points: [
				[0, 0, 0],
				[100, 0, 0],
			],
			radius: 1,
			tessellation: 3,
			closed: false,
		};
		const follower = MeshBuilder.CreateBox("Follower", { size: 1 }, scene);
		const result = setSplineFollower(scene, { nodeId: follower.id, splineId: spline.id, t: 0.5, speed: 40, loop: false, orientToPath: true }, options);
		expect(result.follower).toEqual({ splineId: spline.id, t: 0.5, speed: 40, loop: false, orientToPath: true });
		expect(listSplineFollowers(scene).followers).toHaveLength(1);
		expect(follower.position.x).toBe(50);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(follower.position.x).toBe(70);
		expect(follower.metadata.babylonEditorSplineFollower.t).toBe(0.5);
		expect(deleteSplineFollower(scene, { nodeId: follower.id }, options)).toMatchObject({ deleted: true });
		expect(follower.metadata.babylonEditorSplineFollower).toBeUndefined();
	});
});

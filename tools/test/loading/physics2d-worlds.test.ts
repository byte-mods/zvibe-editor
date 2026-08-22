import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene, TransformNode } from "@babylonjs/core";

import { configurePhysics2D, getPhysics2DDebugSnapshot, setPhysics2DSimulationPaused, stepPausedPhysics2DSimulation } from "../../src/loading/physics2d";

describe("loading/physics2d worlds", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("writes an XZ world pose and publishes direct transform callbacks", () => {
		const body = new TransformNode("body", scene);
		scene.metadata = {
			babylonEditorPhysics2DSettings: {
				version: 3,
				revision: 1,
				worlds: [
					{ id: "default", name: "Default" },
					{ id: "floor", name: "Floor", transformPlane: { mode: "xz", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 0, 1] }, transformWriteMode: "direct" },
				],
			},
			babylonEditorPhysics2D: [{ nodeId: body.id, worldId: "floor", collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [10, 20] }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		const result = stepPausedPhysics2DSimulation(scene, 0.1);

		expect(body.position.asArray()).toEqual([1, 0, 2]);
		expect(result.worlds).toEqual([{ id: "floor", enabled: true, bodies: 1, joints: 0, contactFilterMode: "layers" }]);
		expect(result.transformWriteEvents).toMatchObject([{ nodeId: body.id, worldId: "floor", mode: "direct", applied: [1, 2, 0], tweening: false }]);
	});

	test("partitions contacts and emits camera-scoped automatic then custom debug primitives", () => {
		const first = new TransformNode("first", scene);
		const second = new TransformNode("second", scene);
		scene.metadata = {
			babylonEditorPhysics2DSettings: {
				worlds: [
					{ id: "default", name: "Default", worldDrawing: true, alwaysDraw: true },
					{ id: "other", name: "Other", worldDrawing: true, alwaysDraw: true, contactFilterMode: "all" },
				],
			},
			babylonEditorPhysics2D: [
				{ nodeId: first.id, worldId: "default", collider: { shape: "circle", radius: 10 }, gravity: [0, 0] },
				{ nodeId: second.id, worldId: "other", collider: { shape: "circle", radius: 10 }, gravity: [0, 0] },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);
		expect(stepPausedPhysics2DSimulation(scene, 0.01).collisions).toBe(0);

		const snapshot = getPhysics2DDebugSnapshot(scene, {
			customElements: [
				{
					id: "axis",
					worldId: "default",
					points: [
						[0, 0],
						[10, 0],
					],
				},
			],
		});
		expect(snapshot.primitives.map((primitive) => primitive.order)).toEqual(["automatic", "custom", "automatic"]);
		expect(snapshot.primitives.some((primitive) => primitive.id === "custom:axis" && primitive.kind === "custom")).toBe(true);
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "@babylonjs/core";

import { configurePhysics2D } from "../../src/loading/physics2d";

describe("loading/physics2d", () => {
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

	test("restores point effectors and attracts exported 2D bodies", () => {
		const body = new TransformNode("Body", scene);
		const source = new TransformNode("Source", scene);
		source.position.x = 100;
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }],
			babylonEditorPhysics2DEffectors: [{ id: "attract", nodeId: source.id, radius: 200, force: 1000, falloff: 1, enabled: true }],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(body.position.x).toBeGreaterThan(0);
	});

	test("restores directional Area effectors in exported games", () => {
		const body = new TransformNode("Area Body", scene);
		const source = new TransformNode("Area Source", scene);
		source.position.x = 100;
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }],
			babylonEditorPhysics2DEffectors: [{ id: "wind", nodeId: source.id, type: "area", radius: 200, force: 1000, falloff: 1, forceAngle: 90, enabled: true }],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(body.position.y).toBeGreaterThan(0);
	});

	test("restores tangential Surface effectors in exported games", () => {
		const body = new TransformNode("Surface Body", scene);
		const source = new TransformNode("Surface Source", scene);
		body.position.x = 100;
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }],
			babylonEditorPhysics2DEffectors: [{ id: "conveyor", nodeId: source.id, type: "surface", radius: 100, surfaceThickness: 20, force: 1000, falloff: 1, enabled: true }],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(body.position.y).toBeLessThan(0);
	});

	test("restores one-way Platform Effectors in exported games", () => {
		const platform = new TransformNode("Platform", scene);
		const descending = new TransformNode("Descending", scene);
		const ascending = new TransformNode("Ascending", scene);
		descending.position.y = 14;
		ascending.position.y = -14;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: platform.id, bodyType: "static", collider: { shape: "box", size: [100, 10] } },
				{ nodeId: descending.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [0, -100] },
				{ nodeId: ascending.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [0, 100] },
			],
			babylonEditorPhysics2DEffectors: [{ id: "platform", nodeId: platform.id, type: "platform", platformAngle: 90, enabled: true }],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(descending.position.y).toBeGreaterThanOrEqual(15);
		expect(ascending.position.y).toBeLessThan(0);
	});

	test("restores convex polygon trigger colliders in exported games", () => {
		const polygon = new TransformNode("Polygon", scene);
		const circle = new TransformNode("Circle", scene);
		circle.position.x = 45;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: polygon.id,
					bodyType: "static",
					collider: {
						shape: "polygon",
						points: [
							[-50, -50],
							[50, -50],
							[50, 50],
							[-50, 50],
						],
					},
					isTrigger: true,
				},
				{ nodeId: circle.id, bodyType: "static", collider: { shape: "circle", radius: 10 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: polygon.id, secondNodeId: circle.id }]);
	});

	test("restores persisted concave polygon parts without filling the notch", () => {
		const polygon = new TransformNode("Concave", scene);
		const solid = new TransformNode("Solid", scene);
		const notch = new TransformNode("Notch", scene);
		solid.position.set(0, -30, 0);
		notch.position.set(20, 20, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: polygon.id,
					bodyType: "static",
					isTrigger: true,
					collider: {
						shape: "polygon",
						points: [
							[-50, -50],
							[50, -50],
							[50, -10],
							[-10, -10],
							[-10, 50],
							[-50, 50],
						],
						parts: [
							[
								[-50, -50],
								[50, -50],
								[50, -10],
							],
							[
								[-50, -50],
								[50, -10],
								[-10, -10],
							],
							[
								[-50, 50],
								[-50, -50],
								[-10, -10],
							],
							[
								[-10, -10],
								[-10, 50],
								[-50, 50],
							],
						],
					},
				},
				{ nodeId: solid.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: notch.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: polygon.id, secondNodeId: solid.id }]);
	});

	test("restores pivot-hinge joints in exported games", () => {
		const pivot = new TransformNode("Pivot", scene);
		const arm = new TransformNode("Arm", scene);
		arm.position.x = 100;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: pivot.id, bodyType: "static", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
				{ nodeId: arm.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0], velocity: [0, 100] },
			],
			babylonEditorPhysics2DJoints: [{ id: "hinge", type: "hinge", firstNodeId: pivot.id, secondNodeId: arm.id, firstAnchor: [0, 0], secondAnchor: [-100, 0] }],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(arm.position.y).toBeCloseTo(0, 4);
	});

	test("restores pivot-hinge angular limits in exported games", () => {
		const pivot = new TransformNode("Angle Pivot", scene);
		const arm = new TransformNode("Angle Arm", scene);
		arm.position.x = 100;
		arm.rotation.z = 1;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: pivot.id, bodyType: "static", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
				{ nodeId: arm.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
			],
			babylonEditorPhysics2DJoints: [
				{
					id: "hinge",
					type: "hinge",
					firstNodeId: pivot.id,
					secondNodeId: arm.id,
					firstAnchor: [0, 0],
					secondAnchor: [-100, 0],
					referenceAngle: 0,
					minAngle: -0.1,
					maxAngle: 0.1,
				},
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(arm.rotation.z).toBeCloseTo(0.1, 5);
	});

	test("restores pivot-hinge motors in exported games", () => {
		const pivot = new TransformNode("Motor Pivot", scene);
		const arm = new TransformNode("Motor Arm", scene);
		arm.position.x = 100;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: pivot.id, bodyType: "static", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
				{ nodeId: arm.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
			],
			babylonEditorPhysics2DJoints: [
				{ id: "motor", type: "hinge", firstNodeId: pivot.id, secondNodeId: arm.id, firstAnchor: [0, 0], secondAnchor: [-100, 0], motorSpeed: 2, maxMotorTorque: 10000 },
			],
			babylonEditorPhysics2DSettings: { solverIterations: 4 },
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(arm.rotation.z).toBeCloseTo(0.032, 5);
	});
});

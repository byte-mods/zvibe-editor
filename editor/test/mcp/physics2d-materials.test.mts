import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import {
	createPhysics2DEffector,
	createPhysics2DJoint,
	createPhysics2DMaterial,
	deletePhysics2DEffector,
	deletePhysics2DMaterial,
	listPhysics2D,
	listPhysics2DEffectors,
	listPhysics2DJoints,
	listPhysics2DMaterials,
	setPhysics2DJoint,
	getPhysics2DSettings,
	setPhysics2DSettings,
	setPhysics2DBody,
	setPhysics2DMaterial,
} from "../../src/mcp/physics2d/physics2d";

describe("mcp/physics2d materials", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists reusable material properties and assigns them to bodies", () => {
		const material = createPhysics2DMaterial(scene, { name: "Rubber", friction: 0.8, restitution: 0.7 }, options);
		setPhysics2DMaterial(scene, { id: material.id, friction: 0.6 }, options);
		const node = new TransformNode("Ball", scene);
		const body = setPhysics2DBody(scene, { nodeId: node.id, collider: { shape: "circle", radius: 10 }, materialId: material.id }, options);

		expect(body.materialId).toBe(material.id);
		expect(listPhysics2DMaterials(scene).materials).toEqual([{ id: material.id, name: "Rubber", friction: 0.6, restitution: 0.7 }]);
		expect(listPhysics2D(scene).bodies[0].material).toMatchObject({ id: material.id, friction: 0.6, restitution: 0.7 });
		expect(() => deletePhysics2DMaterial(scene, { id: material.id }, options)).toThrow("assigned");
	});

	test("persists scene-level 2D solver iterations", () => {
		expect(setPhysics2DSettings(scene, { solverIterations: 6 }, options)).toEqual({ solverIterations: 6 });
		expect(getPhysics2DSettings(scene)).toEqual({ solverIterations: 6 });
		expect(() => setPhysics2DSettings(scene, { solverIterations: 17 }, options)).toThrow("solverIterations");
	});

	test("clears a material assignment without replacing the body configuration", () => {
		const material = createPhysics2DMaterial(scene, { name: "Ice", friction: 0.05 }, options);
		const node = new TransformNode("Crate", scene);
		setPhysics2DBody(scene, { nodeId: node.id, bodyType: "static", collider: { shape: "circle", radius: 25 }, materialId: material.id }, options);
		const result = setPhysics2DBody(scene, { nodeId: node.id, materialId: null }, options);

		expect(result).toMatchObject({ bodyType: "static", collider: { shape: "circle", radius: 25 }, materialId: null });
	});

	test("reports trigger overlaps without resolving the bodies apart", () => {
		const first = new TransformNode("First Trigger", scene);
		const second = new TransformNode("Second Trigger", scene);
		setPhysics2DBody(scene, { nodeId: first.id, bodyType: "static", collider: { shape: "box", size: [100, 100] }, isTrigger: true }, options);
		setPhysics2DBody(scene, { nodeId: second.id, bodyType: "static", collider: { shape: "box", size: [100, 100] } }, options);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const result = listPhysics2D(scene);
		expect(result.triggers).toEqual([{ firstNodeId: first.id, secondNodeId: second.id }]);
		expect(first.position.asArray()).toEqual([0, 0, 0]);
		expect(second.position.asArray()).toEqual([0, 0, 0]);
	});

	test("persists convex polygon colliders and detects circle overlaps", () => {
		const polygon = new TransformNode("Polygon Trigger", scene);
		const circle = new TransformNode("Circle", scene);
		circle.position.x = 45;
		const collider = {
			shape: "polygon",
			points: [
				[-50, -50],
				[50, -50],
				[50, 50],
				[-50, 50],
			],
		};
		setPhysics2DBody(scene, { nodeId: polygon.id, bodyType: "static", collider, isTrigger: true }, options);
		setPhysics2DBody(scene, { nodeId: circle.id, bodyType: "static", collider: { shape: "circle", radius: 10 } }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2D(scene).bodies[0].collider).toMatchObject(collider);
		expect(listPhysics2D(scene).bodies[0].collider.parts).toHaveLength(1);
		expect(listPhysics2D(scene).triggers).toEqual([{ firstNodeId: polygon.id, secondNodeId: circle.id }]);
	});

	test("decomposes simple concave polygon outlines and preserves empty concave notches", () => {
		const polygon = new TransformNode("Concave Trigger", scene);
		const solid = new TransformNode("Solid", scene);
		const notch = new TransformNode("Notch", scene);
		solid.position.set(0, -30, 0);
		notch.position.set(20, 20, 0);
		const body = setPhysics2DBody(
			scene,
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
				},
			},
			options
		);
		setPhysics2DBody(scene, { nodeId: solid.id, bodyType: "static", collider: { shape: "circle", radius: 5 } }, options);
		setPhysics2DBody(scene, { nodeId: notch.id, bodyType: "static", collider: { shape: "circle", radius: 5 } }, options);

		expect(body.collider.parts).toHaveLength(4);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2D(scene).triggers).toEqual([{ firstNodeId: polygon.id, secondNodeId: solid.id }]);
		expect(() =>
			setPhysics2DBody(
				scene,
				{
					nodeId: polygon.id,
					collider: {
						shape: "polygon",
						points: [
							[-10, -10],
							[10, 10],
							[-10, 10],
							[10, -10],
						],
					},
				},
				options
			)
		).toThrow("self-intersections");
	});

	test("persists point effectors and accelerates nearby dynamic bodies", () => {
		const body = new TransformNode("Dynamic Body", scene);
		const source = new TransformNode("Effector Source", scene);
		source.position.x = 100;
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }, options);
		const effector = createPhysics2DEffector(scene, { nodeId: source.id, radius: 200, force: 1000 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2DEffectors(scene).effectors).toEqual([expect.objectContaining({ id: effector.id, nodeId: source.id, radius: 200, force: 1000 })]);
		expect(listPhysics2D(scene).bodies[0].velocity[0]).toBeGreaterThan(0);
		expect(deletePhysics2DEffector(scene, { id: effector.id }, options)).toEqual({ deleted: true, id: effector.id });
	});

	test("applies directional Area Effector force and persists its type", () => {
		const body = new TransformNode("Area Body", scene);
		const source = new TransformNode("Area Source", scene);
		source.position.x = 100;
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }, options);
		const effector = createPhysics2DEffector(scene, { nodeId: source.id, type: "area", radius: 200, force: 1000, forceAngle: 90 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2DEffectors(scene).effectors).toEqual([expect.objectContaining({ id: effector.id, type: "area", forceAngle: 90 })]);
		expect(listPhysics2D(scene).bodies[0].velocity[1]).toBeGreaterThan(0);
	});

	test("applies Surface Effector force only at the configured ring", () => {
		const body = new TransformNode("Surface Body", scene);
		const source = new TransformNode("Surface Source", scene);
		body.position.x = 100;
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }, options);
		const effector = createPhysics2DEffector(scene, { nodeId: source.id, type: "surface", radius: 100, surfaceThickness: 20, force: 1000 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2DEffectors(scene).effectors).toEqual([expect.objectContaining({ id: effector.id, type: "surface", surfaceThickness: 20 })]);
		expect(listPhysics2D(scene).bodies[0].velocity[1]).toBeLessThan(0);
	});

	test("Platform Effectors block descending bodies but allow ascent from below", () => {
		const platform = new TransformNode("Platform", scene);
		const descending = new TransformNode("Descending", scene);
		const ascending = new TransformNode("Ascending", scene);
		descending.position.y = 14;
		ascending.position.y = -14;
		setPhysics2DBody(scene, { nodeId: platform.id, bodyType: "static", collider: { shape: "box", size: [100, 10] } }, options);
		setPhysics2DBody(scene, { nodeId: descending.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [0, -100] }, options);
		setPhysics2DBody(scene, { nodeId: ascending.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [0, 100] }, options);
		const effector = createPhysics2DEffector(scene, { nodeId: platform.id, type: "platform", platformAngle: 90 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2DEffectors(scene).effectors).toEqual([expect.objectContaining({ id: effector.id, type: "platform", platformAngle: 90 })]);
		expect(descending.position.y).toBeGreaterThanOrEqual(15);
		expect(ascending.position.y).toBeLessThan(0);
	});

	test("persists a pivot-hinge joint and maintains its authored shared anchor", () => {
		const pivot = new TransformNode("Pivot", scene);
		const arm = new TransformNode("Arm", scene);
		arm.position.x = 100;
		setPhysics2DBody(scene, { nodeId: pivot.id, bodyType: "static", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] }, options);
		setPhysics2DBody(scene, { nodeId: arm.id, collider: { shape: "circle", radius: 5 }, gravity: [0, 0], velocity: [0, 100] }, options);
		const joint = createPhysics2DJoint(scene, { type: "hinge", firstNodeId: pivot.id, secondNodeId: arm.id, anchor: [0, 0] }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2DJoints(scene).joints).toEqual([expect.objectContaining({ id: joint.id, type: "hinge", firstAnchor: [0, 0], secondAnchor: [-100, 0] })]);
		expect(arm.position.y).toBeCloseTo(0, 4);
	});

	test("clamps a pivot-hinge relative angle to its authored limits", () => {
		const pivot = new TransformNode("Angle Pivot", scene);
		const arm = new TransformNode("Angle Arm", scene);
		arm.position.x = 100;
		setPhysics2DBody(scene, { nodeId: pivot.id, bodyType: "static", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] }, options);
		setPhysics2DBody(scene, { nodeId: arm.id, collider: { shape: "circle", radius: 5 }, gravity: [0, 0] }, options);
		createPhysics2DJoint(scene, { type: "hinge", firstNodeId: pivot.id, secondNodeId: arm.id, anchor: [0, 0], minAngle: -0.1, maxAngle: 0.1 }, options);
		arm.rotation.z = 1;

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(arm.rotation.z).toBeCloseTo(0.1, 5);
	});

	test("persists and applies a pivot-hinge motor through the shared 2D solver", () => {
		const pivot = new TransformNode("Motor Pivot", scene);
		const arm = new TransformNode("Motor Arm", scene);
		arm.position.x = 100;
		setPhysics2DBody(scene, { nodeId: pivot.id, bodyType: "static", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] }, options);
		setPhysics2DBody(scene, { nodeId: arm.id, collider: { shape: "circle", radius: 5 }, gravity: [0, 0] }, options);
		const joint = createPhysics2DJoint(scene, { type: "hinge", firstNodeId: pivot.id, secondNodeId: arm.id, anchor: [0, 0], motorSpeed: 2, maxMotorTorque: 10000 }, options);
		const updated = setPhysics2DJoint(scene, { id: joint.id, motorSpeed: 3 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(updated).toMatchObject({ id: joint.id, motorSpeed: 3, maxMotorTorque: 10000 });
		expect(arm.rotation.z).toBeCloseTo(0.048, 5);
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import {
	createPhysics2DEffector,
	createPhysics2DJoint,
	createPhysics2DMaterial,
	deletePhysics2DJoint,
	deletePhysics2DEffector,
	deletePhysics2DMaterial,
	listPhysics2D,
	listPhysics2DEffectors,
	listPhysics2DJoints,
	listPhysics2DMaterials,
	setPhysics2DJoint,
	setPhysics2DEffector,
	getPhysics2DSettings,
	setPhysics2DSettings,
	setPhysics2DBody,
	setPhysics2DMaterial,
} from "../../src/mcp/physics2d/physics2d";

function jointAnchor(node: TransformNode, local: [number, number]): [number, number] {
	const cosine = Math.cos(node.rotation.z);
	const sine = Math.sin(node.rotation.z);
	return [node.position.x + local[0] * cosine - local[1] * sine, node.position.y + local[0] * sine + local[1] * cosine];
}

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
		const updatedMaterial = setPhysics2DMaterial(scene, { id: material.id, expectedRevision: material.revision, friction: 0.6 }, options);
		const node = new TransformNode("Ball", scene);
		const body = setPhysics2DBody(scene, { nodeId: node.id, collider: { shape: "circle", radius: 10 }, materialId: material.id }, options);

		expect(body.materialId).toBe(material.id);
		expect(listPhysics2DMaterials(scene).materials).toEqual([{ version: 1, revision: 2, id: material.id, name: "Rubber", friction: 0.6, restitution: 0.7 }]);
		expect(listPhysics2D(scene).bodies[0].material).toMatchObject({ id: material.id, friction: 0.6, restitution: 0.7 });
		expect(updatedMaterial).toMatchObject({ version: 1, revision: 2 });
		expect(() => deletePhysics2DMaterial(scene, { id: material.id, expectedRevision: updatedMaterial.revision }, options)).toThrow("assigned");
	});

	test("guards material updates with exact revisions and rejects invalid patches atomically", () => {
		const material = createPhysics2DMaterial(scene, { id: "ice", name: "Ice", friction: 0.05, restitution: 0 }, options);
		expect(material).toEqual({ version: 1, revision: 1, id: "ice", name: "Ice", friction: 0.05, restitution: 0 });
		expect(() => setPhysics2DMaterial(scene, { id: "ice", expectedRevision: 2, friction: 0.2 }, options)).toThrow("current revision is 1");
		expect(() => setPhysics2DMaterial(scene, { id: "ice", expectedRevision: 1, name: " " }, options)).toThrow("requires");
		expect(listPhysics2DMaterials(scene).materials).toEqual([material]);

		const updated = setPhysics2DMaterial(scene, { id: "ice", expectedRevision: 1, restitution: 0.1 }, options);
		expect(updated).toMatchObject({ revision: 2, restitution: 0.1 });
		expect(() => deletePhysics2DMaterial(scene, { id: "ice", expectedRevision: 1 }, options)).toThrow("current revision is 2");
		expect(deletePhysics2DMaterial(scene, { id: "ice", expectedRevision: 2 }, options)).toEqual({ deleted: true, id: "ice" });
	});

	test("persists scene-level 2D solver iterations", () => {
		expect(setPhysics2DSettings(scene, { solverIterations: 6 }, options)).toMatchObject({
			version: 3,
			revision: 2,
			velocityIterations: 6,
			positionIterations: 6,
			worlds: [{ id: "default", velocityIterations: 6, positionIterations: 6 }],
		});
		expect(getPhysics2DSettings(scene)).toMatchObject({
			version: 3,
			revision: 2,
			velocityIterations: 6,
			positionIterations: 6,
			worlds: [{ id: "default", velocityIterations: 6, positionIterations: 6 }],
		});
		expect(() => setPhysics2DSettings(scene, { solverIterations: 17 }, options)).toThrow("solverIterations");
	});

	test("clears a material assignment without replacing the body configuration", () => {
		const material = createPhysics2DMaterial(scene, { name: "Ice", friction: 0.05 }, options);
		const node = new TransformNode("Crate", scene);
		setPhysics2DBody(scene, { nodeId: node.id, bodyType: "static", collider: { shape: "circle", radius: 25 }, materialId: material.id }, options);
		const result = setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, materialId: null }, options);

		expect(result).toMatchObject({ version: 3, revision: 2, bodyType: "static", collider: { shape: "circle", radius: 25 } });
		expect(result).not.toHaveProperty("materialId");
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

		expect(body.collider.parts).toHaveLength(2);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listPhysics2D(scene).triggers).toEqual([{ firstNodeId: polygon.id, secondNodeId: solid.id }]);
		expect(() =>
			setPhysics2DBody(
				scene,
				{
					nodeId: polygon.id,
					expectedRevision: body.revision,
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
		).toThrow("self-intersecting");
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
		expect(deletePhysics2DEffector(scene, { id: effector.id, expectedRevision: effector.revision }, options)).toEqual({ deleted: true, id: effector.id });
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

	test("atomically creates, lists, and updates every v2 Effector property surface", () => {
		const source = new TransformNode("Complete Effector Source", scene);
		setPhysics2DBody(scene, { nodeId: source.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, usedByEffector: true }, options);
		createPhysics2DEffector(
			scene,
			{
				id: "complete-point",
				nodeId: source.id,
				type: "point",
				forceMagnitude: 10,
				forceVariation: 2,
				distanceScale: 3,
				linearDrag: 4,
				angularDrag: 5,
				forceSource: "collider",
				forceTarget: "collider",
				forceMode: "inverse-squared",
				useColliderMask: true,
				colliderMask: 4,
			},
			options
		);
		createPhysics2DEffector(
			scene,
			{
				id: "complete-area",
				nodeId: source.id,
				type: "area",
				forceMagnitude: 20,
				forceVariation: 3,
				forceAngle: 45,
				useGlobalAngle: false,
				linearDrag: 6,
				angularDrag: 7,
				forceTarget: "collider",
			},
			options
		);
		createPhysics2DEffector(
			scene,
			{
				id: "complete-surface",
				nodeId: source.id,
				type: "surface",
				speed: 30,
				speedVariation: -4,
				forceScale: 0.5,
				useContactForce: true,
				useFriction: false,
				useBounce: false,
			},
			options
		);
		createPhysics2DEffector(
			scene,
			{
				id: "complete-platform",
				nodeId: source.id,
				type: "platform",
				rotationalOffset: 15,
				useOneWay: false,
				useOneWayGrouping: true,
				surfaceArc: 120,
				useSideFriction: false,
				useSideBounce: false,
				sideArc: 30,
			},
			options
		);
		createPhysics2DEffector(
			scene,
			{
				id: "complete-buoyancy",
				nodeId: source.id,
				type: "buoyancy",
				surfaceLevel: 8,
				density: 2,
				linearDrag: 3,
				angularDrag: 4,
				flowAngle: 90,
				flowMagnitude: 5,
				flowVariation: -1,
			},
			options
		);

		expect(listPhysics2DEffectors(scene).effectors).toEqual([
			expect.objectContaining({
				id: "complete-point",
				forceMagnitude: 10,
				forceVariation: 2,
				distanceScale: 3,
				forceSource: "collider",
				forceTarget: "collider",
				forceMode: "inverse-squared",
			}),
			expect.objectContaining({ id: "complete-area", forceMagnitude: 20, forceVariation: 3, forceAngle: 45, useGlobalAngle: false, forceTarget: "collider" }),
			expect.objectContaining({ id: "complete-surface", speed: 30, speedVariation: -4, forceScale: 0.5, useContactForce: true, useFriction: false, useBounce: false }),
			expect.objectContaining({
				id: "complete-platform",
				rotationalOffset: 15,
				usesLegacyWorldAngle: false,
				useOneWay: false,
				useOneWayGrouping: true,
				surfaceArc: 120,
				useSideFriction: false,
				useSideBounce: false,
				sideArc: 30,
			}),
			expect.objectContaining({ id: "complete-buoyancy", surfaceLevel: 8, density: 2, flowAngle: 90, flowMagnitude: 5, flowVariation: -1 }),
		]);

		expect(setPhysics2DEffector(scene, { id: "complete-point", expectedRevision: 1, forceMagnitude: 11, forceMode: "constant" }, options)).toMatchObject({
			revision: 2,
			forceMagnitude: 11,
			forceMode: "constant",
		});
		expect(setPhysics2DEffector(scene, { id: "complete-area", expectedRevision: 1, useGlobalAngle: true, forceTarget: "rigidbody" }, options)).toMatchObject({
			revision: 2,
			useGlobalAngle: true,
			forceTarget: "rigidbody",
		});
		expect(setPhysics2DEffector(scene, { id: "complete-surface", expectedRevision: 1, speed: 31, useBounce: true }, options)).toMatchObject({
			revision: 2,
			speed: 31,
			useBounce: true,
		});
		expect(setPhysics2DEffector(scene, { id: "complete-platform", expectedRevision: 1, rotationalOffset: 20, sideArc: 40 }, options)).toMatchObject({
			revision: 2,
			rotationalOffset: 20,
			usesLegacyWorldAngle: false,
			sideArc: 40,
		});
		expect(setPhysics2DEffector(scene, { id: "complete-buoyancy", expectedRevision: 1, flowVariation: -2 }, options)).toMatchObject({
			revision: 2,
			flowVariation: -2,
		});

		const before = structuredClone(scene.metadata.babylonEditorPhysics2DEffectors);
		expect(() => setPhysics2DEffector(scene, { id: "complete-surface", expectedRevision: 2, forceScale: 2 }, options)).toThrow("invalid");
		expect(() => setPhysics2DEffector(scene, { id: "complete-surface", expectedRevision: 2, distanceScale: 2 }, options)).toThrow("not valid for that type");
		expect(() => createPhysics2DEffector(scene, { id: "invalid-area", nodeId: source.id, type: "area", forceMode: "constant" }, options)).toThrow("not valid for that type");
		expect(scene.metadata.babylonEditorPhysics2DEffectors).toEqual(before);
	});

	test("preserves legacy Platform world angles until rotationalOffset is explicitly authored", () => {
		const platform = new TransformNode("Legacy Platform Transition", scene);
		setPhysics2DBody(scene, { nodeId: platform.id, bodyType: "static", collider: { shape: "box", size: [100, 10] }, usedByEffector: true }, options);
		const legacy = createPhysics2DEffector(scene, { id: "legacy-platform-transition", nodeId: platform.id, type: "platform", platformAngle: 45 }, options);
		expect(legacy).toMatchObject({ platformAngle: 45, rotationalOffset: 0, usesLegacyWorldAngle: true });

		expect(setPhysics2DEffector(scene, { id: legacy.id, expectedRevision: 1, rotationalOffset: 10 }, options)).toMatchObject({
			revision: 2,
			rotationalOffset: 10,
			usesLegacyWorldAngle: false,
		});
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
		expect(jointAnchor(arm, [-100, 0])).toEqual([expect.closeTo(0, 2), expect.closeTo(0, 2)]);
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
		const updated = setPhysics2DJoint(scene, { id: joint.id, expectedRevision: joint.revision, motorSpeed: 3 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(updated).toMatchObject({ id: joint.id, motorSpeed: 3, maxMotorTorque: 10000 });
		expect(Math.hypot(...jointAnchor(arm, [-100, 0]))).toBeLessThan(0.02);
		expect(listPhysics2D(scene).bodies.find((body: any) => body.nodeId === arm.id).angularVelocity).toBeCloseTo(1.598, 3);
	});

	test("authors every Unity 2D joint family through one versioned editor contract", () => {
		const first = new TransformNode("First Joint Body", scene);
		const second = new TransformNode("Second Joint Body", scene);
		second.position.x = 100;
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, options);
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, options);
		for (const type of ["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "wheel"]) {
			createPhysics2DJoint(scene, { id: `joint-${type}`, type, firstNodeId: first.id, secondNodeId: second.id }, options);
		}
		createPhysics2DJoint(scene, { id: "joint-target", type: "target", firstNodeId: first.id, target: [25, 50] }, options);

		const joints = listPhysics2DJoints(scene).joints;
		expect(joints).toHaveLength(9);
		expect(joints.map((joint: any) => joint.type)).toEqual(["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "wheel", "target"]);
		expect(joints.every((joint: any) => joint.version === 2 && joint.revision === 1)).toBe(true);
		expect(joints.find((joint: any) => joint.type === "fixed")).toMatchObject({ autoConfigureConnectedAnchor: false, referenceAngle: 0 });
		expect(joints.find((joint: any) => joint.type === "target")).not.toHaveProperty("secondNodeId");
	});

	test("keeps failed joint updates atomic and requires an exact revision for updates and deletion", () => {
		const first = new TransformNode("Lease First", scene);
		const second = new TransformNode("Lease Second", scene);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, options);
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, options);
		const joint = createPhysics2DJoint(scene, { id: "leased-hinge", type: "hinge", firstNodeId: first.id, secondNodeId: second.id }, options);
		const before = structuredClone(scene.metadata.babylonEditorPhysics2DJoints);
		const nonBody = new TransformNode("Not A Body", scene);

		expect(() => setPhysics2DJoint(scene, { id: joint.id, motorSpeed: 4 }, options)).toThrow("stale");
		expect(() => setPhysics2DJoint(scene, { id: joint.id, expectedRevision: 1, minAngle: 2, maxAngle: 1 }, options)).toThrow("invalid angle");
		expect(() => setPhysics2DJoint(scene, { id: joint.id, expectedRevision: 1, secondNodeId: nonBody.id }, options)).toThrow("authored 2D bodies");
		expect(scene.metadata.babylonEditorPhysics2DJoints).toEqual(before);
		const updated = setPhysics2DJoint(scene, { id: joint.id, expectedRevision: 1, useMotor: true, motorSpeed: 4 }, options);
		expect(updated).toMatchObject({ revision: 2, useMotor: true, motorSpeed: 4 });
		expect(() => deletePhysics2DJoint(scene, { id: joint.id, expectedRevision: 1 }, options)).toThrow("stale");
		expect(deletePhysics2DJoint(scene, { id: joint.id, expectedRevision: 2 }, options)).toEqual({ deleted: true, id: joint.id });
	});

	test("normalizes legacy joint reads without mutating saved metadata", () => {
		scene.metadata = {
			babylonEditorPhysics2DJoints: [{ id: "legacy", type: "hinge", firstNodeId: "first", secondNodeId: "second", minAngle: -0.2, maxAngle: 0.2 }],
		};

		expect(listPhysics2DJoints(scene).joints[0]).toMatchObject({ version: 2, revision: 1, useLimits: true, autoConfigureConnectedAnchor: true });
		expect(scene.metadata.babylonEditorPhysics2DJoints[0]).not.toHaveProperty("version");
	});

	test("stores rotated body anchors locally and fixed-world anchors in world space", () => {
		const body = new TransformNode("Rotated Joint Body", scene);
		body.position.set(10, 20, 0);
		body.rotation.z = Math.PI / 2;
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "circle", radius: 10 } }, options);

		const joint = createPhysics2DJoint(scene, { id: "world-hinge", type: "hinge", firstNodeId: body.id, anchor: [10, 70] }, options);
		expect(joint.firstAnchor[0]).toBeCloseTo(50, 10);
		expect(joint.firstAnchor[1]).toBeCloseTo(0, 10);
		expect(joint).toMatchObject({ secondAnchor: [10, 70], autoConfigureConnectedAnchor: false });
		expect(joint).not.toHaveProperty("secondNodeId");
	});

	test("stores Relative Joint offsets in the first body's rotated local frame", () => {
		const first = new TransformNode("Relative Frame", scene);
		const second = new TransformNode("Relative Body", scene);
		first.rotation.z = Math.PI / 2;
		second.position.y = 100;
		setPhysics2DBody(scene, { nodeId: first.id, bodyType: "static", collider: { shape: "circle", radius: 10 } }, options);
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, options);

		const joint = createPhysics2DJoint(scene, { id: "relative-frame", type: "relative", firstNodeId: first.id, secondNodeId: second.id }, options);
		expect(joint.linearOffset[0]).toBeCloseTo(100, 10);
		expect(joint.linearOffset[1]).toBeCloseTo(0, 10);
	});

	test("authors and revision-guards Buoyancy Effectors without partial failed writes", () => {
		const water = new TransformNode("Water Volume", scene);
		setPhysics2DBody(scene, { nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [500, 200] } }, options);
		const effector = createPhysics2DEffector(
			scene,
			{ id: "water", nodeId: water.id, type: "buoyancy", surfaceLevel: 50, density: 2, linearDrag: 3, angularDrag: 4, flowAngle: 30, flowMagnitude: 100 },
			options
		);
		expect(effector).toMatchObject({ version: 2, revision: 1, type: "buoyancy", surfaceLevel: 50, density: 2, linearDrag: 3, angularDrag: 4 });
		const before = structuredClone(scene.metadata.babylonEditorPhysics2DEffectors);

		expect(() => setPhysics2DEffector(scene, { id: effector.id, density: 3 }, options)).toThrow("stale");
		expect(() => setPhysics2DEffector(scene, { id: effector.id, expectedRevision: 1, density: -1 }, options)).toThrow("invalid");
		expect(scene.metadata.babylonEditorPhysics2DEffectors).toEqual(before);
		const updated = setPhysics2DEffector(scene, { id: effector.id, expectedRevision: 1, density: 3 }, options);
		expect(updated).toMatchObject({ revision: 2, density: 3 });
		expect(() => deletePhysics2DEffector(scene, { id: effector.id, expectedRevision: 1 }, options)).toThrow("stale");
		expect(deletePhysics2DEffector(scene, { id: effector.id, expectedRevision: 2 }, options)).toEqual({ deleted: true, id: effector.id });
	});

	test("creates a live Buoyancy Effector through MCP-authored scene state", () => {
		const water = new TransformNode("MCP Water", scene);
		const body = new TransformNode("MCP Floating Body", scene);
		body.position.y = -50;
		setPhysics2DBody(scene, { nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true, usedByEffector: true }, options);
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "box", size: [20, 20], density: 1 }, useAutoMass: true, gravity: [0, -100], usedByEffector: false }, options);
		createPhysics2DEffector(scene, { id: "live-water", nodeId: water.id, type: "buoyancy", density: 1, linearDrag: 0, angularDrag: 0 }, options);

		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const state = listPhysics2D(scene).bodies.find((candidate) => candidate.nodeId === body.id);
		expect(state.velocity[1]).toBeCloseTo(0, 8);
		expect(listPhysics2DEffectors(scene).effectors).toEqual([expect.objectContaining({ id: "live-water", type: "buoyancy", density: 1 })]);
	});
});

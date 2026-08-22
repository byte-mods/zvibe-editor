import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import {
	applyPhysics2DBodyForce,
	applyPhysics2DBodyTorque,
	getPhysics2DPolygonCollider,
	listPhysics2D,
	setPhysics2DBody,
	setPhysics2DPolygonCollider,
	setPhysics2DRuntimeVelocity,
} from "../../src/mcp/physics2d/physics2d";

describe("mcp/physics2d body contract", () => {
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

	test("persists the complete versioned angular and mass contract", () => {
		const node = new TransformNode("Capsule", scene);
		const body = setPhysics2DBody(
			scene,
			{
				nodeId: node.id,
				bodyType: "kinematic",
				collider: { shape: "capsule", size: [40, 100], direction: "vertical", offset: [5, -3], density: 0.002 },
				velocity: [12, -4],
				angularVelocity: 2,
				mass: 5,
				useAutoMass: true,
				inertia: 900,
				useAutoInertia: false,
				centerOfMass: [2, 1],
				useAutoCenterOfMass: false,
				angularDamping: 0.2,
				freezePositionX: true,
				freezeRotation: true,
				collisionDetection: "continuous",
			},
			options
		);

		expect(body).toMatchObject({
			version: 3,
			revision: 1,
			bodyType: "kinematic",
			collider: { shape: "capsule", size: [40, 100], direction: "vertical", offset: [5, -3], density: 0.002 },
			velocity: [12, -4],
			angularVelocity: 2,
			mass: 5,
			useAutoMass: true,
			inertia: 900,
			useAutoInertia: false,
			centerOfMass: [2, 1],
			useAutoCenterOfMass: false,
			angularDamping: 0.2,
			freezePositionX: true,
			freezeRotation: true,
			collisionDetection: "continuous",
		});
		const listed = listPhysics2D(scene).bodies[0];
		expect(listed.runtime).toMatchObject({ active: true, bodyType: "kinematic", revision: 1, velocity: [12, -4], angularVelocity: 2, inverseMass: 0, inverseInertia: 0 });
	});

	test("requires exact revisions and rejects stale or malformed updates atomically", () => {
		const node = new TransformNode("Guarded", scene);
		setPhysics2DBody(scene, { nodeId: node.id, collider: { shape: "circle", radius: 10 } }, options);

		expect(() => setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 2, mass: 4 }, options)).toThrow("current revision is 1");
		expect(() => setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, angularVelocity: Number.NaN }, options)).toThrow("out-of-range");
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({ revision: 1, mass: 1, angularVelocity: 0 });

		const updated = setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, mass: 4, useAutoMass: false, angularVelocity: 3 }, options);
		expect(updated).toMatchObject({ version: 3, revision: 2, mass: 4, angularVelocity: 3 });
		expect(() => setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, mass: 7 }, options)).toThrow("current revision is 2");
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({ revision: 2, mass: 4, angularVelocity: 3 });
	});

	test("derives Edge Collider 2D parts and applies exact-leased transient commands", () => {
		const node = new TransformNode("Runtime Edge", scene);
		const body = setPhysics2DBody(
			scene,
			{
				nodeId: node.id,
				expectedRevision: 0,
				collider: {
					shape: "edge",
					points: [
						[-10, 0],
						[10, 0],
						[10, 20],
					],
					edgeRadius: 2,
				},
				gravity: [0, 0],
			},
			options
		);
		expect(body.collider).toMatchObject({ shape: "edge", edgeRadius: 2 });
		expect(body.collider.parts).toHaveLength(2);

		const velocity = setPhysics2DRuntimeVelocity(scene, { nodeId: node.id, expectedRevision: 1, velocity: [25, -5], angularVelocity: 2 }, options);
		expect(velocity).toMatchObject({ revision: 1, persistedStateChanged: false, runtime: { velocity: [25, -5], angularVelocity: 2 } });
		const impulse = applyPhysics2DBodyForce(scene, { nodeId: node.id, expectedRevision: 1, value: [1, 0], mode: "impulse" }, options);
		expect(impulse.runtime.velocity[0]).toBeGreaterThan(25);
		const torque = applyPhysics2DBodyTorque(scene, { nodeId: node.id, expectedRevision: 1, value: 1, mode: "impulse" }, options);
		expect(torque.runtime.angularVelocity).toBeGreaterThan(2);
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({ revision: 1, velocity: impulse.runtime.velocity });

		setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, mass: 2 }, options);
		expect(() => applyPhysics2DBodyForce(scene, { nodeId: node.id, expectedRevision: 1, value: [1, 0] }, options)).toThrow("current revision is 2");
	});

	test("upgrades an unversioned legacy body through revision one", () => {
		const node = new TransformNode("Legacy", scene);
		scene.metadata = { babylonEditorPhysics2D: [{ nodeId: node.id, bodyType: "dynamic", collider: { shape: "box", size: [20, 30] }, gravity: [0, 0] }] };
		const legacyView = listPhysics2D(scene).bodies[0];

		expect(legacyView).toMatchObject({ version: 3, revision: 1, runtime: { active: true, revision: 1 } });
		const updated = setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: legacyView.revision, angularDamping: 0.3 }, options);

		expect(updated).toMatchObject({ version: 3, revision: 2, angularDamping: 0.3, collider: { shape: "box", size: [20, 30], offset: [0, 0], density: 0.001 } });
	});

	test("rejects malformed optional editor fields without mutating the body", () => {
		const node = new TransformNode("Optional Fields", scene);
		setPhysics2DBody(scene, { nodeId: node.id, collider: { shape: "circle", radius: 10 } }, options);

		expect(() => setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, materialId: "" }, options)).toThrow("non-empty string");
		expect(() => setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, layerOverrides: null }, options)).toThrow("must be an object");
		expect(() =>
			setPhysics2DBody(
				scene,
				{
					nodeId: node.id,
					expectedRevision: 1,
					collider: {
						shape: "polygon",
						points: [
							[0, 0],
							[10, 0],
							[0, 10],
						],
						delaunayFlipCount: Number.NaN,
					},
				},
				options
			)
		).toThrow("delaunayFlipCount");
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({ revision: 1, collider: { shape: "circle", radius: 10 } });
	});

	test("clears contact overrides and preserves common collider fields across compound polygon edits", () => {
		const node = new TransformNode("Complete Collider", scene);
		setPhysics2DBody(
			scene,
			{
				nodeId: node.id,
				collider: {
					shape: "polygon",
					offset: [7, -3],
					density: 0.02,
					points: [
						[-10, -10],
						[10, -10],
						[0, 10],
					],
				},
				friction: 0.7,
				restitution: 0.4,
			},
			options
		);
		const cleared = setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, friction: null, restitution: null }, options);
		expect(cleared).not.toHaveProperty("friction");
		expect(cleared).not.toHaveProperty("restitution");

		const polygon = getPhysics2DPolygonCollider(scene, { nodeId: node.id });
		setPhysics2DPolygonCollider(
			scene,
			{
				nodeId: node.id,
				expectedRevision: polygon.revision,
				contours: [
					{
						id: "outer",
						points: [
							[-20, -20],
							[20, -20],
							[0, 20],
						],
						holes: [],
					},
				],
			},
			options
		);
		expect(listPhysics2D(scene).bodies[0].collider).toMatchObject({ offset: [7, -3], density: 0.02 });
	});
});

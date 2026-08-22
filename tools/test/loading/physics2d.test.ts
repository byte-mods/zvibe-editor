import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "@babylonjs/core";

import {
	configurePhysics2D,
	applyPhysics2DForce,
	applyPhysics2DTorque,
	getPhysics2DBodyRuntimeState,
	getPhysics2DJointRuntimeState,
	getPhysics2DSimulationControl,
	listPhysics2DJointRuntimeStates,
	setPhysics2DSimulationPaused,
	setPhysics2DBodyRuntimeVelocity,
	stepPausedPhysics2DSimulation,
} from "../../src/loading/physics2d";
import { decomposePhysics2DPolygonContours } from "../../src/loading/physics2d-polygons";
import { MaxPhysics2DJoints } from "../../src/loading/physics2d-joints";
import { MaxPhysics2DBodies } from "../../src/loading/physics2d-types";

function jointAnchor(node: TransformNode, local: [number, number]): [number, number] {
	const cosine = Math.cos(node.rotation.z);
	const sine = Math.sin(node.rotation.z);
	return [node.position.x + local[0] * cosine - local[1] * sine, node.position.y + local[0] * sine + local[1] * cosine];
}

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

	test("applies Point Effectors inside their source collider with mask and force source/target semantics", () => {
		const source = new TransformNode("Point Source Collider", scene);
		const matched = new TransformNode("Point Matched", scene);
		const masked = new TransformNode("Point Masked", scene);
		const outside = new TransformNode("Point Outside", scene);
		matched.position.x = 40;
		masked.position.x = -40;
		outside.position.x = 250;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: source.id, bodyType: "static", collider: { shape: "circle", radius: 100, offset: [60, 0] }, isTrigger: true, usedByEffector: true },
				{
					nodeId: matched.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5, offset: [0, 20] },
					gravity: [0, 0],
					mass: 2,
					useAutoMass: false,
					inertia: 100,
					useAutoInertia: false,
					centerOfMass: [0, 0],
					useAutoCenterOfMass: false,
					collisionLayer: 1,
					usedByEffector: false,
				},
				{ nodeId: masked.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0], collisionLayer: 2 },
				{ nodeId: outside.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0], collisionLayer: 1 },
			],
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "collider-point",
					nodeId: source.id,
					type: "point",
					forceMagnitude: 100,
					forceMode: "constant",
					forceSource: "collider",
					forceTarget: "collider",
					useColliderMask: true,
					colliderMask: 2,
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const matchedState = getPhysics2DBodyRuntimeState(scene, matched.id);
		expect(matchedState.velocity[0]).toBeLessThan(0);
		expect(matchedState.velocity[1]).toBeGreaterThan(0);
		expect(matchedState.angularVelocity).toBeGreaterThan(0);
		expect(getPhysics2DBodyRuntimeState(scene, masked.id).velocity).toEqual([0, 0]);
		expect(getPhysics2DBodyRuntimeState(scene, outside.id).velocity).toEqual([0, 0]);
	});

	test("requires Used by Effector on the Point Effector source collider", () => {
		const source = new TransformNode("Disabled Point Source", scene);
		const body = new TransformNode("Disabled Point Target", scene);
		body.position.x = 40;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: source.id, bodyType: "static", collider: { shape: "circle", radius: 100 }, isTrigger: true, usedByEffector: false },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
			],
			babylonEditorPhysics2DEffectors: [{ version: 2, id: "disabled-point", nodeId: source.id, type: "point", forceMagnitude: 100, forceMode: "constant" }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity).toEqual([0, 0]);
	});

	test("applies inverse-distance Point force using rigidbody centers", () => {
		const source = new TransformNode("Inverse Point Source", scene);
		const near = new TransformNode("Inverse Point Near", scene);
		const far = new TransformNode("Inverse Point Far", scene);
		near.position.x = 50;
		far.position.x = 150;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: source.id, bodyType: "static", collider: { shape: "box", size: [400, 200] }, isTrigger: true, usedByEffector: true },
				{ nodeId: near.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
				{ nodeId: far.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0] },
			],
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "inverse-point",
					nodeId: source.id,
					type: "point",
					forceMagnitude: 10,
					forceMode: "inverse-linear",
					forceSource: "rigidbody",
					forceTarget: "rigidbody",
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const nearVelocity = getPhysics2DBodyRuntimeState(scene, near.id).velocity[0];
		const farVelocity = getPhysics2DBodyRuntimeState(scene, far.id).velocity[0];
		expect(nearVelocity).toBeGreaterThan(farVelocity);
		expect(farVelocity).toBeGreaterThan(0);
	});

	test("samples Point force variation deterministically on each successful frame", () => {
		const source = new TransformNode("Varying Point Source", scene);
		const body = new TransformNode("Varying Point Body", scene);
		body.position.x = 50;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: source.id, bodyType: "static", collider: { shape: "circle", radius: 500 }, isTrigger: true, usedByEffector: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0], linearDamping: 0 },
			],
			babylonEditorPhysics2DEffectors: [
				{ version: 2, id: "varying-point", nodeId: source.id, type: "point", forceMagnitude: 100, forceVariation: 50, forceMode: "constant" },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.01);
		const firstIncrement = getPhysics2DBodyRuntimeState(scene, body.id).velocity[0];
		stepPausedPhysics2DSimulation(scene, 0.01);
		const secondIncrement = getPhysics2DBodyRuntimeState(scene, body.id).velocity[0] - firstIncrement;
		expect(secondIncrement).not.toBeCloseTo(firstIncrement, 8);
	});

	test("applies local-angle Area force, drag, collider targeting, and masks inside the source collider", () => {
		const source = new TransformNode("Area Source Collider", scene);
		const matched = new TransformNode("Area Matched", scene);
		const masked = new TransformNode("Area Masked", scene);
		const outside = new TransformNode("Area Outside", scene);
		source.rotation.z = Math.PI / 2;
		matched.position.x = 20;
		masked.position.x = -20;
		outside.position.x = 200;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: source.id, bodyType: "static", collider: { shape: "box", size: [200, 100] }, isTrigger: true, usedByEffector: true },
				{
					nodeId: matched.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5, offset: [10, 0] },
					gravity: [0, 0],
					velocity: [100, 0],
					angularVelocity: 10,
					angularDamping: 0,
					mass: 2,
					useAutoMass: false,
					inertia: 100,
					useAutoInertia: false,
					centerOfMass: [0, 0],
					useAutoCenterOfMass: false,
					collisionLayer: 1,
					usedByEffector: false,
				},
				{ nodeId: masked.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0], collisionLayer: 2 },
				{ nodeId: outside.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, gravity: [0, 0], collisionLayer: 1 },
			],
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "collider-area",
					nodeId: source.id,
					type: "area",
					forceMagnitude: 100,
					forceAngle: 0,
					useGlobalAngle: false,
					forceTarget: "collider",
					linearDrag: 1,
					angularDrag: 1,
					useColliderMask: true,
					colliderMask: 2,
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const matchedState = getPhysics2DBodyRuntimeState(scene, matched.id);
		expect(matchedState.velocity[0]).toBeGreaterThan(0);
		expect(matchedState.velocity[0]).toBeLessThan(100);
		expect(matchedState.velocity[1]).toBeGreaterThan(0);
		expect(matchedState.angularVelocity).toBeGreaterThan(10);
		expect(getPhysics2DBodyRuntimeState(scene, masked.id).velocity).toEqual([0, 0]);
		expect(getPhysics2DBodyRuntimeState(scene, outside.id).velocity).toEqual([0, 0]);
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

	test("drives Surface Effector contact speed and contact-point rotation", () => {
		const surface = new TransformNode("Contact Surface", scene);
		const body = new TransformNode("Contact Surface Body", scene);
		body.position.y = 14;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: surface.id, bodyType: "static", collider: { shape: "box", size: [200, 20] }, isTrigger: true, usedByEffector: true },
				{
					nodeId: body.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5 },
					gravity: [0, 0],
					angularDamping: 0,
					inertia: 100,
					useAutoInertia: false,
				},
			],
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "contact-belt",
					nodeId: surface.id,
					type: "surface",
					speed: 100,
					speedVariation: -20,
					forceScale: 1,
					useContactForce: true,
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const state = getPhysics2DBodyRuntimeState(scene, body.id);
		expect(state.velocity[0]).toBeGreaterThan(0);
		expect(state.velocity[0]).toBeLessThan(100);
		expect(state.angularVelocity).toBeGreaterThan(0);
	});

	test("uses Surface Effector masks to remove friction and bounce only for selected contacts", () => {
		const surface = new TransformNode("Selective Surface", scene);
		const matched = new TransformNode("Selective Surface Matched", scene);
		const excluded = new TransformNode("Selective Surface Excluded", scene);
		matched.position.set(-50, 14, 0);
		excluded.position.set(50, 14, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: surface.id,
					bodyType: "static",
					collider: { shape: "box", size: [200, 20] },
					usedByEffector: true,
					friction: 1,
					restitution: 1,
				},
				{
					nodeId: matched.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5 },
					gravity: [0, 0],
					velocity: [100, -100],
					freezeRotation: true,
					collisionLayer: 1,
					friction: 1,
					restitution: 1,
				},
				{
					nodeId: excluded.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5 },
					gravity: [0, 0],
					velocity: [100, -100],
					freezeRotation: true,
					collisionLayer: 2,
					friction: 1,
					restitution: 1,
				},
			],
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "selective-surface",
					nodeId: surface.id,
					type: "surface",
					forceScale: 0,
					useFriction: false,
					useBounce: false,
					useColliderMask: true,
					colliderMask: 2,
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const matchedState = getPhysics2DBodyRuntimeState(scene, matched.id);
		const excludedState = getPhysics2DBodyRuntimeState(scene, excluded.id);
		expect(matchedState.velocity[0]).toBeCloseTo(100, 8);
		expect(matchedState.velocity[1]).toBeCloseTo(0, 8);
		expect(excludedState.velocity[0]).toBeCloseTo(0, 8);
		expect(excludedState.velocity[1]).toBeGreaterThan(0);
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

	test("uses Platform Effector local-up rotation and authored surface arc for one-way contacts", () => {
		const platform = new TransformNode("Rotated Platform", scene);
		const surfaceSide = new TransformNode("Rotated Platform Surface", scene);
		const passThroughSide = new TransformNode("Rotated Platform Pass Through", scene);
		platform.rotation.z = Math.PI / 2;
		surfaceSide.position.x = -14;
		passThroughSide.position.x = 14;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: platform.id, bodyType: "static", collider: { shape: "box", size: [100, 10] }, usedByEffector: true },
				{ nodeId: surfaceSide.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [100, 0] },
				{ nodeId: passThroughSide.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, 0], velocity: [-100, 0] },
			],
			babylonEditorPhysics2DEffectors: [{ version: 2, id: "rotated-platform", nodeId: platform.id, type: "platform", rotationalOffset: 0, useOneWay: true, surfaceArc: 60 }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(surfaceSide.position.x).toBeLessThanOrEqual(-15);
		expect(passThroughSide.position.x).toBeLessThan(14);
	});

	test("removes Platform Effector side friction and bounce only inside its side arc and mask", () => {
		const platform = new TransformNode("Side Platform", scene);
		const matched = new TransformNode("Side Platform Matched", scene);
		const excluded = new TransformNode("Side Platform Excluded", scene);
		matched.position.x = 54;
		excluded.position.x = -54;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: platform.id,
					bodyType: "static",
					collider: { shape: "box", size: [100, 100] },
					usedByEffector: true,
					friction: 1,
					restitution: 1,
				},
				{
					nodeId: matched.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5 },
					gravity: [0, 0],
					velocity: [-100, 100],
					freezeRotation: true,
					collisionLayer: 1,
					friction: 1,
					restitution: 1,
				},
				{
					nodeId: excluded.id,
					bodyType: "dynamic",
					collider: { shape: "circle", radius: 5 },
					gravity: [0, 0],
					velocity: [100, 100],
					freezeRotation: true,
					collisionLayer: 2,
					friction: 1,
					restitution: 1,
				},
			],
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "side-platform",
					nodeId: platform.id,
					type: "platform",
					useOneWay: false,
					useSideFriction: false,
					useSideBounce: false,
					sideArc: 30,
					useColliderMask: true,
					colliderMask: 2,
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const matchedState = getPhysics2DBodyRuntimeState(scene, matched.id);
		const excludedState = getPhysics2DBodyRuntimeState(scene, excluded.id);
		expect(matchedState.velocity[0]).toBeCloseTo(0, 8);
		expect(matchedState.velocity[1]).toBeCloseTo(100, 8);
		expect(excludedState.velocity[0]).toBeLessThan(0);
		expect(excludedState.velocity[1]).toBeCloseTo(0, 8);
	});

	test("cancels gravity for a fully submerged equal-density body", () => {
		const water = new TransformNode("Water", scene);
		const body = new TransformNode("Floating Body", scene);
		body.position.y = -50;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [20, 20], density: 1 }, useAutoMass: true, gravity: [0, -100] },
			],
			babylonEditorPhysics2DEffectors: [{ id: "water", nodeId: water.id, type: "buoyancy", surfaceLevel: 0, density: 1, linearDrag: 0, angularDrag: 0 }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity[1]).toBeCloseTo(0, 8);
	});

	test("uses clipped submerged area for partial buoyancy", () => {
		const water = new TransformNode("Partial Water", scene);
		const body = new TransformNode("Half Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [20, 20], density: 1 }, useAutoMass: true, gravity: [0, -100] },
			],
			babylonEditorPhysics2DEffectors: [{ id: "partial-water", nodeId: water.id, type: "buoyancy", surfaceLevel: 0, density: 1, linearDrag: 0, angularDrag: 0 }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity[1]).toBeCloseTo(-1, 8);
	});

	test("keeps buoyancy flow world-aligned and applies submerged linear and angular drag", () => {
		const water = new TransformNode("Rotated Water", scene);
		const body = new TransformNode("Flow Body", scene);
		water.rotation.z = Math.PI / 2;
		body.position.x = 20;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10] }, gravity: [0, 0], velocity: [100, 0], angularVelocity: 10, angularDamping: 0 },
			],
			babylonEditorPhysics2DEffectors: [
				{ id: "flow", nodeId: water.id, type: "buoyancy", surfaceLevel: 0, density: 0, linearDrag: 2, angularDrag: 2, flowAngle: 0, flowMagnitude: 50 },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const state = getPhysics2DBodyRuntimeState(scene, body.id);
		expect(state.velocity[0]).toBeGreaterThan(100);
		expect(state.velocity[1]).toBeCloseTo(0, 8);
		expect(state.angularVelocity).toBeGreaterThan(9);
		expect(state.angularVelocity).toBeLessThan(10);
	});

	test("honors Buoyancy Effector collider masks without treating targets as Used by Effector sources", () => {
		const water = new TransformNode("Masked Water", scene);
		const matched = new TransformNode("Matched Body", scene);
		const excluded = new TransformNode("Excluded Body", scene);
		const optedOut = new TransformNode("Opted Out Body", scene);
		matched.position.set(-30, -20, 0);
		excluded.position.set(0, -20, 0);
		optedOut.position.set(30, -20, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true },
				{ nodeId: matched.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10], density: 1 }, useAutoMass: true, gravity: [0, -100], collisionLayer: 1 },
				{ nodeId: excluded.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10], density: 1 }, useAutoMass: true, gravity: [0, -100], collisionLayer: 2 },
				{
					nodeId: optedOut.id,
					bodyType: "dynamic",
					collider: { shape: "box", size: [10, 10], density: 1 },
					useAutoMass: true,
					gravity: [0, -100],
					collisionLayer: 1,
					usedByEffector: false,
				},
			],
			babylonEditorPhysics2DEffectors: [
				{ id: "masked", nodeId: water.id, type: "buoyancy", density: 1, linearDrag: 0, angularDrag: 0, useColliderMask: true, colliderMask: 2 },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, matched.id).velocity[1]).toBeCloseTo(0, 8);
		expect(getPhysics2DBodyRuntimeState(scene, excluded.id).velocity[1]).toBeCloseTo(-2, 8);
		expect(getPhysics2DBodyRuntimeState(scene, optedOut.id).velocity[1]).toBeCloseTo(0, 8);
	});

	test("requires Used by Effector on the Buoyancy source collider", () => {
		const water = new TransformNode("Disabled Water", scene);
		const body = new TransformNode("Disabled Water Body", scene);
		body.position.y = -20;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true, usedByEffector: false },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10], density: 1 }, useAutoMass: true, gravity: [0, -100] },
			],
			babylonEditorPhysics2DEffectors: [{ version: 2, id: "disabled-water", nodeId: water.id, type: "buoyancy", density: 1, linearDrag: 0, angularDrag: 0 }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity[1]).toBeCloseTo(-2, 8);
	});

	test("keeps the Buoyancy surface horizontal when the source rotates", () => {
		const water = new TransformNode("World Surface Water", scene);
		const body = new TransformNode("World Surface Body", scene);
		water.rotation.z = Math.PI / 2;
		body.position.y = 50;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true, usedByEffector: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10], density: 1 }, useAutoMass: true, gravity: [0, -100] },
			],
			babylonEditorPhysics2DEffectors: [{ version: 2, id: "world-surface", nodeId: water.id, type: "buoyancy", surfaceLevel: 0, density: 1, linearDrag: 0, angularDrag: 0 }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity[1]).toBeCloseTo(-2, 8);
	});

	test("scales the Buoyancy world-Y surface offset by the source transform", () => {
		const water = new TransformNode("Scaled Surface Water", scene);
		const body = new TransformNode("Scaled Surface Body", scene);
		water.scaling.y = 2;
		body.position.y = 30;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [200, 200] }, isTrigger: true, usedByEffector: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10], density: 1 }, useAutoMass: true, gravity: [0, -100] },
			],
			babylonEditorPhysics2DEffectors: [
				{ version: 2, id: "scaled-surface", nodeId: water.id, type: "buoyancy", surfaceLevel: 20, density: 1, linearDrag: 0, angularDrag: 0 },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity[1]).toBeCloseTo(0, 8);
	});

	test("samples signed Buoyancy flow variation on each successful frame", () => {
		const water = new TransformNode("Varying Flow Water", scene);
		const body = new TransformNode("Varying Flow Body", scene);
		body.position.y = -20;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: water.id, bodyType: "static", collider: { shape: "box", size: [400, 200] }, isTrigger: true, usedByEffector: true },
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "box", size: [10, 10] }, gravity: [0, 0], linearDamping: 0 },
			],
			babylonEditorPhysics2DEffectors: [
				{ version: 2, id: "varying-flow", nodeId: water.id, type: "buoyancy", density: 0, linearDrag: 0, angularDrag: 0, flowMagnitude: 100, flowVariation: -50 },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.01);
		const firstIncrement = getPhysics2DBodyRuntimeState(scene, body.id).velocity[0];
		stepPausedPhysics2DSimulation(scene, 0.01);
		const secondIncrement = getPhysics2DBodyRuntimeState(scene, body.id).velocity[0] - firstIncrement;
		expect(firstIncrement).toBeGreaterThan(0);
		expect(secondIncrement).not.toBeCloseTo(firstIncrement, 8);
	});

	test("restores convex polygon trigger colliders in exported games", () => {
		const polygon = new TransformNode("Polygon", scene);
		const circle = new TransformNode("Circle", scene);
		polygon.rotation.z = Math.PI / 2;
		circle.position.y = 65;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: polygon.id,
					bodyType: "static",
					collider: {
						shape: "polygon",
						offset: [20, 0],
						points: [
							[-50, -5],
							[50, -5],
							[50, 5],
							[-50, 5],
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

	test("applies body rotation and collider offset to box collision geometry", () => {
		const box = new TransformNode("Rotated Offset Box", scene);
		const circle = new TransformNode("Circle", scene);
		box.rotation.z = Math.PI / 2;
		circle.position.y = 65;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: box.id, bodyType: "static", isTrigger: true, collider: { shape: "box", size: [100, 10], offset: [20, 0] } },
				{ nodeId: circle.id, bodyType: "static", collider: { shape: "circle", radius: 10 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: box.id, secondNodeId: circle.id }]);
	});

	test("rotates circle collider offsets with their body", () => {
		const offsetCircle = new TransformNode("Offset Circle", scene);
		const target = new TransformNode("Target", scene);
		offsetCircle.rotation.z = Math.PI / 2;
		target.position.y = 40;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: offsetCircle.id, bodyType: "static", isTrigger: true, collider: { shape: "circle", radius: 10, offset: [40, 0] } },
				{ nodeId: target.id, bodyType: "static", collider: { shape: "circle", radius: 10 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: offsetCircle.id, secondNodeId: target.id }]);
	});

	test("uses rounded capsule ends instead of the capsule bounding box", () => {
		const capsule = new TransformNode("Capsule", scene);
		const roundedEnd = new TransformNode("Rounded End", scene);
		const emptyCorner = new TransformNode("Empty Corner", scene);
		roundedEnd.position.set(0, 49, 0);
		emptyCorner.position.set(9, 49, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: capsule.id, bodyType: "static", isTrigger: true, collider: { shape: "capsule", size: [20, 100], direction: "vertical" } },
				{ nodeId: roundedEnd.id, bodyType: "static", collider: { shape: "circle", radius: 2 } },
				{ nodeId: emptyCorner.id, bodyType: "static", collider: { shape: "circle", radius: 2 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: capsule.id, secondNodeId: roundedEnd.id }]);
	});

	test("keeps raw edge chains open and collides only near their segments", () => {
		const edge = new TransformNode("Open Edge", scene);
		const onEdge = new TransformNode("On Edge", scene);
		const insideOpenChain = new TransformNode("Inside Open Chain", scene);
		onEdge.position.set(-25, 25, 0);
		insideOpenChain.position.set(0, 10, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: edge.id,
					bodyType: "static",
					isTrigger: true,
					collider: {
						shape: "edge",
						edgeRadius: 3,
						points: [
							[-50, 0],
							[0, 50],
							[50, 0],
						],
					},
				},
				{ nodeId: onEdge.id, bodyType: "static", collider: { shape: "circle", radius: 2 } },
				{ nodeId: insideOpenChain.id, bodyType: "static", collider: { shape: "circle", radius: 2 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: edge.id, secondNodeId: onEdge.id }]);
	});

	test("restores generated Sprite Shape edge parts in exported games", () => {
		const edge = new TransformNode("Sprite Shape Edge", scene);
		const circle = new TransformNode("Circle", scene);
		edge.rotation.z = Math.PI / 2;
		circle.position.y = 115;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: edge.id,
					bodyType: "static",
					isTrigger: true,
					collider: {
						shape: "edge",
						model: "unity-sprite-shape-edge-collider-v1",
						offset: [20, 0],
						points: [
							[-100, 0],
							[100, 0],
						],
						parts: [
							[
								[-100, 5],
								[100, 5],
								[100, -5],
								[-100, -5],
							],
						],
						edgeRadius: 5,
					},
				},
				{ nodeId: circle.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: edge.id, secondNodeId: circle.id }]);
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

	test("restores compound polygon islands while leaving authored holes empty", () => {
		const polygon = new TransformNode("Compound", scene);
		const solid = new TransformNode("Solid", scene);
		const hole = new TransformNode("Hole", scene);
		const island = new TransformNode("Island", scene);
		solid.position.x = -30;
		island.position.x = 90;
		const decomposition = decomposePhysics2DPolygonContours([
			{
				id: "main",
				points: [
					[-50, -50],
					[50, -50],
					[50, 50],
					[-50, 50],
				],
				holes: [
					{
						id: "opening",
						points: [
							[-10, -10],
							[-10, 10],
							[10, 10],
							[10, -10],
						],
					},
				],
			},
			{
				id: "island",
				points: [
					[80, -10],
					[100, -10],
					[100, 10],
					[80, 10],
				],
				holes: [],
			},
		]);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: polygon.id,
					bodyType: "static",
					isTrigger: true,
					collider: { shape: "polygon", version: 2, revision: 1, contours: decomposition.contours, points: decomposition.contours[0].points, parts: decomposition.parts },
				},
				{ nodeId: solid.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: hole.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: island.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([
			{ firstNodeId: polygon.id, secondNodeId: solid.id },
			{ firstNodeId: polygon.id, secondNodeId: island.id },
		]);
	});

	test("honors prioritized include and exclude layer overrides", () => {
		const first = new TransformNode("First", scene);
		const second = new TransformNode("Second", scene);
		const firstBody = {
			nodeId: first.id,
			bodyType: "static",
			collider: { shape: "circle", radius: 10 },
			isTrigger: true,
			collisionLayer: 0,
			layerOverrides: { priority: 0, excludeLayers: 2 },
		};
		const secondBody = { nodeId: second.id, bodyType: "static", collider: { shape: "circle", radius: 10 }, collisionLayer: 1 };
		scene.metadata = { babylonEditorPhysics2D: [firstBody, secondBody] };

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([]);

		scene.dispose();
		scene = new Scene(engine);
		const allowedFirst = new TransformNode("Allowed First", scene);
		const allowedSecond = new TransformNode("Allowed Second", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ ...firstBody, nodeId: allowedFirst.id },
				{ ...secondBody, nodeId: allowedSecond.id, layerOverrides: { priority: 1, includeLayers: 1 } },
			],
		};
		configurePhysics2D(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: allowedFirst.id, secondNodeId: allowedSecond.id }]);
	});

	test("honors contact-capture and callback masks for trigger reporting", () => {
		const first = new TransformNode("First", scene);
		const second = new TransformNode("Second", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: first.id,
					bodyType: "static",
					collider: { shape: "circle", radius: 10 },
					isTrigger: true,
					collisionLayer: 0,
					layerOverrides: { callbackLayers: 0, contactCaptureLayers: 0 },
				},
				{
					nodeId: second.id,
					bodyType: "static",
					collider: { shape: "circle", radius: 10 },
					collisionLayer: 1,
					layerOverrides: { callbackLayers: 0, contactCaptureLayers: 0 },
				},
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scene.physics2DTriggerEvents).toEqual([]);
	});

	test("honors force-send and force-receive layer overrides", () => {
		const platform = new TransformNode("Platform", scene);
		const body = new TransformNode("Body", scene);
		body.position.x = 8;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: platform.id,
					bodyType: "static",
					collider: { shape: "box", size: [10, 10] },
					collisionLayer: 0,
					layerOverrides: { forceSendLayers: 0 },
				},
				{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 }, collisionLayer: 1, gravity: [0, 0] },
			],
		};

		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(body.position.x).toBe(8);
	});

	test("uses inverse mass for collision impulses", () => {
		const light = new TransformNode("Light Body", scene);
		const heavy = new TransformNode("Heavy Body", scene);
		heavy.position.x = 9.5;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: light.id, bodyType: "dynamic", mass: 1, gravity: [0, 0], velocity: [100, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: heavy.id, bodyType: "dynamic", mass: 3, gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.01);
		expect(getPhysics2DBodyRuntimeState(scene, light.id).velocity[0]).toBeCloseTo(25, 5);
		expect(getPhysics2DBodyRuntimeState(scene, heavy.id).velocity[0]).toBeCloseTo(25, 5);
	});

	test("separates coincident circles with a deterministic contact normal", () => {
		const first = new TransformNode("First Coincident Circle", scene);
		const second = new TransformNode("Second Coincident Circle", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: first.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: second.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.01);
		expect(first.position.x).toBeCloseTo(-5, 8);
		expect(second.position.x).toBeCloseTo(5, 8);
	});

	test("produces angular response from off-center collision contacts", () => {
		const box = new TransformNode("Dynamic Box", scene);
		const obstacle = new TransformNode("Offset Obstacle", scene);
		obstacle.position.set(8, 4, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: box.id,
					bodyType: "dynamic",
					mass: 1,
					inertia: 100,
					useAutoInertia: false,
					gravity: [0, 0],
					angularDamping: 0,
					velocity: [100, 0],
					collider: { shape: "box", size: [10, 10] },
				},
				{ nodeId: obstacle.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.01);
		expect(Math.abs(getPhysics2DBodyRuntimeState(scene, box.id).angularVelocity)).toBeGreaterThan(0.01);
	});

	test("uses velocity iterations independently from position iterations", () => {
		const first = new TransformNode("First Chain Body", scene);
		const second = new TransformNode("Second Chain Body", scene);
		const third = new TransformNode("Third Chain Body", scene);
		second.position.x = 8.5;
		third.position.x = 17;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: first.id, bodyType: "dynamic", gravity: [0, 0], velocity: [100, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: second.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: third.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 4, positionIterations: 1 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.01);
		expect(getPhysics2DBodyRuntimeState(scene, first.id).velocity[0]).toBeCloseTo(33.59375, 5);
		expect(getPhysics2DBodyRuntimeState(scene, second.id).velocity[0]).toBeCloseTo(33.203125, 5);
		expect(getPhysics2DBodyRuntimeState(scene, third.id).velocity[0]).toBeCloseTo(33.203125, 5);
	});

	test("prevents continuous dynamic bodies from tunneling through thin static colliders", () => {
		const body = new TransformNode("Continuous Body", scene);
		const wall = new TransformNode("Thin Wall", scene);
		wall.position.x = 50;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: body.id,
					bodyType: "dynamic",
					collisionDetection: "continuous",
					gravity: [0, 0],
					velocity: [1000, 0],
					collider: { shape: "circle", radius: 5 },
				},
				{ nodeId: wall.id, bodyType: "static", collider: { shape: "box", size: [4, 100] } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		const result = stepPausedPhysics2DSimulation(scene, 0.1);
		expect(body.position.x).toBeCloseTo(43, 5);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity[0]).toBeCloseTo(0, 5);
		expect(result.collisions).toBe(1);
	});

	test("reports a swept trigger only once across continuous substeps", () => {
		const body = new TransformNode("Continuous Trigger Body", scene);
		const trigger = new TransformNode("Thin Trigger", scene);
		trigger.position.x = 50;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: body.id,
					bodyType: "dynamic",
					collisionDetection: "continuous",
					gravity: [0, 0],
					velocity: [1000, 0],
					collider: { shape: "circle", radius: 5 },
				},
				{ nodeId: trigger.id, bodyType: "static", isTrigger: true, collider: { shape: "box", size: [4, 100] } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		const result = stepPausedPhysics2DSimulation(scene, 0.1);
		expect(body.position.x).toBeCloseTo(100, 5);
		expect(result.triggers).toEqual([{ firstNodeId: body.id, secondNodeId: trigger.id }]);
		expect(scene.physics2DTriggerEvents).toEqual(result.triggers);
	});

	test("rejects excessive continuous substeps atomically", () => {
		const body = new TransformNode("Bounded Continuous Body", scene);
		const wall = new TransformNode("Microscopic Wall", scene);
		wall.position.x = 500;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: body.id,
					bodyType: "dynamic",
					collisionDetection: "continuous",
					gravity: [0, 0],
					velocity: [10_000, 0],
					collider: { shape: "circle", radius: 5 },
				},
				{ nodeId: wall.id, bodyType: "static", collider: { shape: "box", size: [0.001, 100] } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		expect(() => stepPausedPhysics2DSimulation(scene, 0.1)).toThrow("exceeding the bounded limit of 64");
		expect(body.position.asArray()).toEqual([0, 0, 0]);
		expect(getPhysics2DBodyRuntimeState(scene, body.id).velocity).toEqual([10_000, 0]);
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
		expect(jointAnchor(arm, [-100, 0])).toEqual([expect.closeTo(0, 2), expect.closeTo(0, 2)]);
		expect(arm.rotation.z).toBeGreaterThan(0);
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
		expect(jointAnchor(arm, [-100, 0])).toEqual([expect.closeTo(0, 2), expect.closeTo(0, 2)]);
		expect(getPhysics2DBodyRuntimeState(scene, arm.id).angularVelocity).toBeCloseTo(1.598, 3);
		expect(getPhysics2DJointRuntimeState(scene, "motor").reactionTorque).toBeCloseTo(10_000, 4);
	});

	test("solves Distance Joint anchors by inverse mass and reports reaction force", () => {
		const light = new TransformNode("Light Distance Body", scene);
		const heavy = new TransformNode("Heavy Distance Body", scene);
		heavy.position.x = 200;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: light.id, bodyType: "dynamic", mass: 1, gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: heavy.id, bodyType: "dynamic", mass: 3, gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{ id: "distance", type: "distance", firstNodeId: light.id, secondNodeId: heavy.id, firstAnchor: [0, 0], secondAnchor: [0, 0], distance: 100 },
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const lightMovement = light.position.x;
		const heavyMovement = 200 - heavy.position.x;
		expect(heavy.position.x - light.position.x).toBeCloseTo(100, 4);
		expect(lightMovement / heavyMovement).toBeCloseTo(3, 3);
		expect(Math.abs(getPhysics2DJointRuntimeState(scene, "distance").reactionForce[0])).toBeGreaterThan(0);
	});

	test("keeps Fixed Joint translation and rotation offsets rigid", () => {
		const base = new TransformNode("Fixed Base", scene);
		const body = new TransformNode("Fixed Body", scene);
		body.position.x = 100;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: base.id, bodyType: "static", gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], velocity: [0, 100], angularVelocity: 2, angularDamping: 0, collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{
					id: "fixed",
					type: "fixed",
					firstNodeId: base.id,
					secondNodeId: body.id,
					firstAnchor: [0, 0],
					secondAnchor: [-100, 0],
					referenceAngle: 0,
					frequency: 0,
					dampingRatio: 1,
				},
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(jointAnchor(body, [-100, 0])).toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3)]);
		expect(body.rotation.z).toBeCloseTo(0, 3);
	});

	test("keeps a rotated local Hinge anchor attached to the fixed world", () => {
		const body = new TransformNode("World Hinge Body", scene);
		body.position.x = 100;
		body.rotation.z = Math.PI / 2;
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], velocity: [100, 0], collider: { shape: "circle", radius: 5 } }],
			babylonEditorPhysics2DJoints: [{ id: "world", type: "hinge", firstNodeId: body.id, firstAnchor: [50, 0], secondAnchor: [100, 50] }],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(jointAnchor(body, [50, 0])).toEqual([expect.closeTo(100, 3), expect.closeTo(50, 3)]);
		expect(getPhysics2DJointRuntimeState(scene, "world")).toMatchObject({ active: true, connected: true, broken: false });
	});

	test("suppresses connected-body collisions unless the joint enables them", () => {
		const first = new TransformNode("Connected First", scene);
		const second = new TransformNode("Connected Second", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: first.id, bodyType: "static", collider: { shape: "circle", radius: 10 } },
				{ nodeId: second.id, bodyType: "static", collider: { shape: "circle", radius: 10 } },
			],
			babylonEditorPhysics2DJoints: [{ id: "connected", type: "distance", firstNodeId: first.id, secondNodeId: second.id, distance: 0, enableCollision: false }],
		};
		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);

		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getPhysics2DSimulationControl(scene).collisions).toBe(0);
		scene.metadata.babylonEditorPhysics2DJoints = [{ ...scene.metadata.babylonEditorPhysics2DJoints[0], revision: 2, enableCollision: true }];
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getPhysics2DSimulationControl(scene).collisions).toBe(1);
	});

	test("applies Ignore, Callback Only, Disable, and Destroy joint break actions once", () => {
		const actions = ["ignore", "callback-only", "disable", "destroy"] as const;
		const bodies = actions.map((action, index) => {
			const body = new TransformNode(`${action} body`, scene);
			body.position.x = index * 200;
			return body;
		});
		scene.metadata = {
			babylonEditorPhysics2D: bodies.map((body) => ({ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } })),
			babylonEditorPhysics2DJoints: bodies.map((body, index) => ({
				id: actions[index],
				type: "hinge",
				firstNodeId: body.id,
				firstAnchor: [0, 0],
				secondAnchor: [body.position.x, body.position.y],
				breakAction: actions[index],
				breakForce: 0.01,
			})),
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);
		const observed: string[] = [];
		scene.onPhysics2DJointBreakObservable?.add((event) => observed.push(event.action));
		bodies.forEach((body) => applyPhysics2DForce(scene, body.id, [0, 1], "impulse"));

		const stepped = stepPausedPhysics2DSimulation(scene, 0.02);
		expect(stepped.jointBreakEvents.map((event) => event.action)).toEqual(["callback-only", "disable", "destroy"]);
		expect(observed).toEqual(["callback-only", "disable", "destroy"]);
		expect(listPhysics2DJointRuntimeStates(scene).map((joint) => [joint.id, joint.broken])).toEqual([
			["ignore", false],
			["callback-only", false],
			["disable", true],
			["destroy", true],
		]);
		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(getPhysics2DSimulationControl(scene).jointBreakEvents).toEqual([]);
	});

	test("reports invalid and duplicate joint metadata without solving it", () => {
		const first = new TransformNode("Diagnostic First", scene);
		const second = new TransformNode("Diagnostic Second", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: first.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: second.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{ id: "valid", type: "distance", firstNodeId: first.id, secondNodeId: second.id, distance: 10 },
				{ id: "missing", type: "distance", firstNodeId: first.id, secondNodeId: "not-active", distance: 10 },
				{ id: "valid", type: "distance", firstNodeId: first.id, secondNodeId: second.id, distance: 10 },
				{ id: "bad-type", type: "unsupported", firstNodeId: first.id, secondNodeId: second.id },
			],
		};

		configurePhysics2D(scene);
		expect(getPhysics2DSimulationControl(scene)).toMatchObject({ registeredJoints: 1, enabledJoints: 1, invalidJointCount: 3, jointMetadataTruncated: false });
		expect(getPhysics2DSimulationControl(scene).invalidJoints.map((joint) => joint.id)).toEqual(["missing", "valid", "bad-type"]);
	});

	test("bounds joint metadata and rejects excessive solver work before moving bodies", () => {
		const body = new TransformNode("Bounded Joint Body", scene);
		const wall = new TransformNode("Bounded Joint Wall", scene);
		wall.position.x = 1000;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: body.id, bodyType: "dynamic", collisionDetection: "continuous", gravity: [0, 0], velocity: [3200, 0], collider: { shape: "circle", radius: 5 } },
				{ nodeId: wall.id, bodyType: "static", collider: { shape: "box", size: [10, 100] } },
			],
			babylonEditorPhysics2DJoints: Array.from({ length: MaxPhysics2DJoints + 1 }, (_value, index) => ({
				id: `joint-${index}`,
				type: "distance",
				firstNodeId: body.id,
				secondNodeId: wall.id,
				distance: 1000,
			})),
			babylonEditorPhysics2DSettings: { velocityIterations: 16, positionIterations: 16 },
		};
		configurePhysics2D(scene);
		expect(getPhysics2DSimulationControl(scene)).toMatchObject({ registeredJoints: MaxPhysics2DJoints, invalidJointCount: 1, jointMetadataTruncated: true });
		setPhysics2DSimulationPaused(scene, true);

		expect(() => stepPausedPhysics2DSimulation(scene, 0.1)).toThrow("joint");
		expect(body.position.asArray()).toEqual([0, 0, 0]);
	});

	test("applies Spring Joint frequency and damping along the authored anchors", () => {
		const anchor = new TransformNode("Spring Anchor", scene);
		const body = new TransformNode("Spring Body", scene);
		body.position.x = 200;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: anchor.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{
					id: "spring",
					type: "spring",
					firstNodeId: anchor.id,
					secondNodeId: body.id,
					firstAnchor: [0, 0],
					secondAnchor: [0, 0],
					distance: 100,
					frequency: 2,
					dampingRatio: 1,
				},
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(body.position.x).toBeGreaterThan(100);
		expect(body.position.x).toBeLessThan(200);
		expect(Math.abs(getPhysics2DJointRuntimeState(scene, "spring").reactionForce[0])).toBeGreaterThan(0);
	});

	test("constrains Slider Joint perpendicular motion, angle, limits, and motor force", () => {
		const track = new TransformNode("Slider Track", scene);
		const body = new TransformNode("Slider Body", scene);
		body.position.set(50, 50, 0);
		body.rotation.z = 0.5;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: track.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], angularDamping: 0, collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{
					id: "slider",
					type: "slider",
					firstNodeId: track.id,
					secondNodeId: body.id,
					firstAnchor: [0, 0],
					secondAnchor: [0, 0],
					angle: 0,
					referenceAngle: 0,
					useLimits: true,
					lowerTranslation: 0,
					upperTranslation: 60,
					useMotor: true,
					motorSpeed: 100,
					maxMotorForce: 10_000,
				},
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.1);
		expect(body.position.x).toBeGreaterThan(50);
		expect(body.position.x).toBeLessThanOrEqual(60.01);
		expect(body.position.y).toBeCloseTo(0, 3);
		expect(body.rotation.z).toBeCloseTo(0, 3);
	});

	test("combines Wheel Joint suspension, line constraint, and free rotation motor", () => {
		const chassis = new TransformNode("Wheel Chassis", scene);
		const wheel = new TransformNode("Wheel", scene);
		wheel.position.set(20, 50, 0);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: chassis.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: wheel.id, bodyType: "dynamic", gravity: [0, 0], angularDamping: 0, collider: { shape: "circle", radius: 10 } },
			],
			babylonEditorPhysics2DJoints: [
				{
					id: "wheel",
					type: "wheel",
					firstNodeId: chassis.id,
					secondNodeId: wheel.id,
					firstAnchor: [0, 0],
					secondAnchor: [0, 0],
					angle: Math.PI / 2,
					frequency: 2,
					dampingRatio: 1,
					useMotor: true,
					motorSpeed: 5,
					maxMotorTorque: 10_000,
				},
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(wheel.position.x).toBeCloseTo(0, 3);
		expect(wheel.position.y).toBeGreaterThan(0);
		expect(wheel.position.y).toBeLessThan(50);
		expect(wheel.rotation.z).toBeGreaterThan(0);
	});

	test("caps Friction Joint linear and angular drag by authored force and torque", () => {
		const surface = new TransformNode("Friction Surface", scene);
		const body = new TransformNode("Friction Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: surface.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], velocity: [100, 50], angularVelocity: 2, angularDamping: 0, collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{ id: "friction", type: "friction", firstNodeId: surface.id, secondNodeId: body.id, firstAnchor: [0, 0], secondAnchor: [0, 0], maxForce: 1, maxTorque: 1 },
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		const state = getPhysics2DBodyRuntimeState(scene, body.id);
		const reaction = getPhysics2DJointRuntimeState(scene, "friction");
		expect(state.velocity[0]).toBeLessThan(100);
		expect(state.velocity[1]).toBeLessThan(50);
		expect(state.angularVelocity).toBeLessThan(2);
		expect(Math.hypot(...reaction.reactionForce)).toBeLessThanOrEqual(1.000001);
		expect(Math.abs(reaction.reactionTorque)).toBeLessThanOrEqual(1.000001);
	});

	test("drives Relative Joint linear and angular offsets under bounded correction", () => {
		const reference = new TransformNode("Relative Reference", scene);
		const body = new TransformNode("Relative Body", scene);
		body.position.x = 100;
		body.rotation.z = 1;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: reference.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], angularDamping: 0, collider: { shape: "circle", radius: 5 } },
			],
			babylonEditorPhysics2DJoints: [
				{
					id: "relative",
					type: "relative",
					firstNodeId: reference.id,
					secondNodeId: body.id,
					linearOffset: [50, 0],
					angularOffset: 0,
					maxForce: 10_000,
					maxTorque: 10_000,
					correctionScale: 0.5,
				},
			],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		stepPausedPhysics2DSimulation(scene, 0.02);
		expect(body.position.x).toBeGreaterThan(50);
		expect(body.position.x).toBeLessThan(100);
		expect(body.rotation.z).toBeGreaterThan(0);
		expect(body.rotation.z).toBeLessThan(1);
	});

	test("moves Target Joint bodies toward a fixed world point under spring force", () => {
		const body = new TransformNode("Target Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], collider: { shape: "circle", radius: 5 } }],
			babylonEditorPhysics2DJoints: [{ id: "target", type: "target", firstNodeId: body.id, target: [100, 50], maxForce: 100, frequency: 5, dampingRatio: 1 }],
			babylonEditorPhysics2DSettings: { velocityIterations: 8, positionIterations: 8 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		const before = Math.hypot(100 - body.position.x, 50 - body.position.y);
		for (let index = 0; index < 10; index++) {
			stepPausedPhysics2DSimulation(scene, 0.02);
		}
		const after = Math.hypot(100 - body.position.x, 50 - body.position.y);
		expect(after).toBeLessThan(before);
		expect(body.position.x).toBeGreaterThan(0);
		expect(body.position.y).toBeGreaterThan(0);
		expect(Math.hypot(...getPhysics2DJointRuntimeState(scene, "target").reactionForce)).toBeLessThanOrEqual(100.000001);
	});

	test("pauses automatic Physics 2D and advances one exact manual frame", () => {
		const body = new TransformNode("Manual Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, -100], velocity: [0, 0] }],
		};
		configurePhysics2D(scene);
		configurePhysics2D(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);

		expect(setPhysics2DSimulationPaused(scene, true)).toMatchObject({ paused: true, registeredBodies: 1, dynamicBodies: 1 });
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(body.position.y).toBe(0);

		const stepped = stepPausedPhysics2DSimulation(scene, 0.02);
		expect(stepped).toMatchObject({ paused: true, steppedBodies: 1, totalManualSteps: 1, totalManualSeconds: 0.02, lastStepSeconds: 0.02 });
		expect(body.position.y).toBeCloseTo(-0.04, 8);
		expect(getPhysics2DSimulationControl(scene).totalAutomaticSteps).toBe(0);

		setPhysics2DSimulationPaused(scene, false);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getPhysics2DSimulationControl(scene)).toMatchObject({ paused: false, totalAutomaticSteps: 1 });
	});

	test("manual Physics 2D reports trigger evidence through the shared runtime", () => {
		const trigger = new TransformNode("Trigger", scene);
		const body = new TransformNode("Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: trigger.id, bodyType: "static", collider: { shape: "circle", radius: 10 }, isTrigger: true },
				{ nodeId: body.id, bodyType: "static", collider: { shape: "circle", radius: 10 } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		const stepped = stepPausedPhysics2DSimulation(scene, 0.02);
		expect(stepped).toMatchObject({ steppedBodies: 2, collisions: 0, triggers: [{ firstNodeId: trigger.id, secondNodeId: body.id }] });
		expect(scene.physics2DTriggerEvents).toEqual([{ firstNodeId: trigger.id, secondNodeId: body.id }]);
	});

	test("normalizes typed mass and angular state into shared runtime diagnostics", () => {
		const body = new TransformNode("Typed Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: body.id,
					bodyType: "kinematic",
					revision: 4,
					collider: { shape: "box", size: [100, 50], density: 0.002 },
					velocity: [12, -3],
					angularVelocity: 2.5,
					useAutoMass: true,
				},
			],
		};

		configurePhysics2D(scene);
		const state = getPhysics2DBodyRuntimeState(scene, body.id);
		expect(state).toMatchObject({
			active: true,
			bodyType: "kinematic",
			revision: 4,
			velocity: [12, -3],
			angularVelocity: 2.5,
			mass: 10,
			inverseMass: 0,
		});
		state.centerOfMass[0] = 999;
		expect(getPhysics2DBodyRuntimeState(scene, body.id).centerOfMass).toEqual([0, 0]);
		expect(getPhysics2DSimulationControl(scene)).toMatchObject({ registeredBodies: 1, dynamicBodies: 0, kinematicBodies: 1, staticBodies: 0, invalidBodyCount: 0 });
	});

	test("reports malformed duplicate and missing-node metadata without stepping it", () => {
		const valid = new TransformNode("Valid", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: valid.id, bodyType: "dynamic", collider: { shape: "circle", radius: 5 } },
				{ nodeId: valid.id, bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: "missing", bodyType: "static", collider: { shape: "circle", radius: 5 } },
				{ nodeId: "malformed", bodyType: "dynamic", collider: { shape: "circle", radius: Number.NaN } },
			],
		};

		configurePhysics2D(scene);
		const control = getPhysics2DSimulationControl(scene);
		expect(control).toMatchObject({ registeredBodies: 1, invalidBodyCount: 3, metadataTruncated: false });
		expect(control.invalidBodies.map((body) => body.nodeId)).toEqual([valid.id, "missing", "malformed"]);
		expect(getPhysics2DBodyRuntimeState(scene, "missing").active).toBe(false);
	});

	test("bounds malformed metadata diagnostics without constructing excess bodies", () => {
		scene.metadata = {
			babylonEditorPhysics2D: Array.from({ length: MaxPhysics2DBodies + 1 }, (_value, index) => ({
				nodeId: `missing-${index}`,
				bodyType: "static",
				collider: { shape: "circle", radius: 5 },
			})),
		};

		configurePhysics2D(scene);
		expect(getPhysics2DSimulationControl(scene)).toMatchObject({ registeredBodies: 0, invalidBodyCount: MaxPhysics2DBodies + 1, metadataTruncated: true });
		expect(getPhysics2DSimulationControl(scene).invalidBodies).toHaveLength(64);
	});

	test("integrates mass-aware force and torque with explicit centimeter units", () => {
		const body = new TransformNode("Forced Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: body.id,
					bodyType: "dynamic",
					mass: 2,
					inertia: 200,
					useAutoInertia: false,
					gravity: [0, 0],
					angularDamping: 0,
					collider: { shape: "circle", radius: 5 },
				},
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		expect(applyPhysics2DForce(scene, body.id, [10, 0])).toMatchObject({ accumulatedForce: [10, 0], velocity: [0, 0] });
		expect(applyPhysics2DTorque(scene, body.id, 20)).toMatchObject({ accumulatedTorque: 20, angularVelocity: 0 });
		stepPausedPhysics2DSimulation(scene, 0.1);

		expect(body.position.x).toBeCloseTo(5, 8);
		expect(body.rotation.z).toBeCloseTo(0.1, 8);
		expect(getPhysics2DBodyRuntimeState(scene, body.id)).toMatchObject({ velocity: [50, 0], angularVelocity: 1, accumulatedForce: [0, 0], accumulatedTorque: 0 });
	});

	test("applies off-center impulse and kinematic velocity without force response", () => {
		const dynamic = new TransformNode("Impulse Body", scene);
		const kinematic = new TransformNode("Kinematic Body", scene);
		kinematic.position.x = 1000;
		scene.metadata = {
			babylonEditorPhysics2D: [
				{
					nodeId: dynamic.id,
					bodyType: "dynamic",
					mass: 2,
					inertia: 200,
					useAutoInertia: false,
					gravity: [0, 0],
					angularDamping: 0,
					collider: { shape: "circle", radius: 5 },
				},
				{ nodeId: kinematic.id, bodyType: "kinematic", velocity: [0, 0], angularVelocity: 0, collider: { shape: "box", size: [10, 10] } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		applyPhysics2DForce(scene, dynamic.id, [0, 10], "impulse", [10, 0]);
		setPhysics2DBodyRuntimeVelocity(scene, kinematic.id, [20, -10], 2);
		expect(() => applyPhysics2DForce(scene, kinematic.id, [1, 0])).toThrow("forces require dynamic");
		stepPausedPhysics2DSimulation(scene, 0.01);

		expect(dynamic.position.y).toBeCloseTo(5, 8);
		expect(dynamic.rotation.z).toBeCloseTo(0.5, 8);
		expect(kinematic.position.asArray()).toEqual([1000.2, -0.1, 0]);
		expect(kinematic.rotation.z).toBeCloseTo(0.02, 8);
	});

	test("enforces axis and rotation freezes on runtime velocity", () => {
		const body = new TransformNode("Frozen Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [
				{ nodeId: body.id, bodyType: "dynamic", freezePositionX: true, freezeRotation: true, gravity: [0, 0], collider: { shape: "circle", radius: 5 } },
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		expect(setPhysics2DBodyRuntimeVelocity(scene, body.id, [10, 20], 3)).toMatchObject({ velocity: [0, 20], angularVelocity: 0 });
		expect(applyPhysics2DForce(scene, body.id, [10, 0], "impulse")).toMatchObject({ velocity: [0, 20], angularVelocity: 0 });
		stepPausedPhysics2DSimulation(scene, 0.1);
		expect(body.position.asArray()).toEqual([0, 2, 0]);
		expect(body.rotation.z).toBe(0);
	});

	test("restores consumed commands and angular state when a manual frame fails", () => {
		const body = new TransformNode("Rollback Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], angularDamping: 0, collider: { shape: "circle", radius: 5 } }],
			babylonEditorPhysics2DJoints: [
				Object.defineProperty({}, "firstNodeId", {
					get: () => {
						throw new Error("joint failure");
					},
				}),
			],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);
		applyPhysics2DForce(scene, body.id, [10, 0]);
		applyPhysics2DTorque(scene, body.id, 10);

		expect(() => stepPausedPhysics2DSimulation(scene, 0.1)).toThrow("joint failure");
		expect(body.position.asArray()).toEqual([0, 0, 0]);
		expect(body.rotation.z).toBe(0);
		expect(getPhysics2DBodyRuntimeState(scene, body.id)).toMatchObject({ velocity: [0, 0], angularVelocity: 0, accumulatedForce: [10, 0], accumulatedTorque: 10 });
	});

	test("rejects overflowing impulses atomically", () => {
		const body = new TransformNode("Bounded Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", mass: 0.001, gravity: [0, 0], collider: { shape: "circle", radius: 5 } }],
		};
		configurePhysics2D(scene);

		expect(() => applyPhysics2DForce(scene, body.id, [1_000_000_000, 0], "impulse")).toThrow("bounded runtime velocity");
		expect(getPhysics2DBodyRuntimeState(scene, body.id)).toMatchObject({ velocity: [0, 0], angularVelocity: 0, accumulatedForce: [0, 0], accumulatedTorque: 0 });
	});

	test("keeps velocity replacement atomic when angular validation fails", () => {
		const body = new TransformNode("Atomic Velocity Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", gravity: [0, 0], velocity: [1, 2], angularVelocity: 3, collider: { shape: "circle", radius: 5 } }],
		};
		configurePhysics2D(scene);

		expect(() => setPhysics2DBodyRuntimeVelocity(scene, body.id, [10, 20], Number.NaN)).toThrow("angularVelocity must be finite");
		expect(getPhysics2DBodyRuntimeState(scene, body.id)).toMatchObject({ velocity: [1, 2], angularVelocity: 3 });
	});

	test("rejects overflowing fixed-step integration before mutating bodies", () => {
		const body = new TransformNode("Overflow Step Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", gravity: [1_000_000, 0], gravityScale: 100, collider: { shape: "circle", radius: 5 } }],
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		expect(() => stepPausedPhysics2DSimulation(scene, 0.1)).toThrow("bounded runtime velocity");
		expect(body.position.asArray()).toEqual([0, 0, 0]);
		expect(getPhysics2DBodyRuntimeState(scene, body.id)).toMatchObject({ velocity: [0, 0], angularVelocity: 0 });
	});
});

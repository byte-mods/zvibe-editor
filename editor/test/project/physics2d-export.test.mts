import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { configurePhysics2DExportMetadata } from "../../src/project/export/physics2d";

describe("project/export Physics 2D metadata", () => {
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

	test("exports normalized joint, effector, and split-solver metadata", () => {
		const firstAnchor = [1, 2];
		scene.metadata = {
			babylonEditorPhysics2DJoints: [{ id: "hinge", type: "hinge", firstNodeId: "first", secondNodeId: "second", firstAnchor, secondAnchor: [3, 4] }],
			babylonEditorPhysics2DEffectors: [{ id: "point", nodeId: "source", radius: 200, force: 500 }],
			babylonEditorPhysics2DSettings: { version: 2, revision: 1, velocityIterations: 8, positionIterations: 4 },
		};
		const data = { metadata: { sentinel: true } };

		configurePhysics2DExportMetadata(data, scene);

		expect(data.metadata).toMatchObject({
			sentinel: true,
			babylonEditorPhysics2DJoints: [{ version: 2, revision: 1, id: "hinge", type: "hinge", firstAnchor: [1, 2], secondAnchor: [3, 4] }],
			babylonEditorPhysics2DEffectors: [{ version: 2, revision: 1, id: "point", type: "point", radius: 200, force: 500 }],
			babylonEditorPhysics2DSettings: { version: 3, revision: 1, velocityIterations: 8, positionIterations: 4 },
		});
		firstAnchor[0] = 99;
		expect(data.metadata.babylonEditorPhysics2DJoints[0].firstAnchor).toEqual([1, 2]);
	});

	test("exports every detached v2 Effector property without aliasing scene metadata", () => {
		scene.metadata = {
			babylonEditorPhysics2DEffectors: [
				{
					version: 2,
					id: "point",
					nodeId: "point-source",
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
				{
					version: 2,
					id: "area",
					nodeId: "area-source",
					type: "area",
					forceMagnitude: 20,
					forceVariation: 3,
					forceAngle: 45,
					useGlobalAngle: false,
					linearDrag: 6,
					angularDrag: 7,
					forceTarget: "collider",
				},
				{
					version: 2,
					id: "surface",
					nodeId: "surface-source",
					type: "surface",
					speed: 30,
					speedVariation: -4,
					forceScale: 0.5,
					useContactForce: true,
					useFriction: false,
					useBounce: false,
				},
				{
					version: 2,
					id: "platform",
					nodeId: "platform-source",
					type: "platform",
					rotationalOffset: 15,
					useOneWay: false,
					useOneWayGrouping: true,
					surfaceArc: 120,
					useSideFriction: false,
					useSideBounce: false,
					sideArc: 30,
				},
				{
					version: 2,
					id: "buoyancy",
					nodeId: "water-source",
					type: "buoyancy",
					surfaceLevel: 8,
					density: 2,
					linearDrag: 3,
					angularDrag: 4,
					flowAngle: 90,
					flowMagnitude: 5,
					flowVariation: -1,
				},
			],
		};
		const data: any = { metadata: {} };

		configurePhysics2DExportMetadata(data, scene);

		expect(data.metadata.babylonEditorPhysics2DEffectors).toEqual([
			expect.objectContaining({
				id: "point",
				forceMagnitude: 10,
				forceVariation: 2,
				distanceScale: 3,
				forceSource: "collider",
				forceTarget: "collider",
				forceMode: "inverse-squared",
			}),
			expect.objectContaining({ id: "area", forceMagnitude: 20, forceVariation: 3, forceAngle: 45, useGlobalAngle: false, forceTarget: "collider" }),
			expect.objectContaining({ id: "surface", speed: 30, speedVariation: -4, forceScale: 0.5, useContactForce: true, useFriction: false, useBounce: false }),
			expect.objectContaining({
				id: "platform",
				rotationalOffset: 15,
				usesLegacyWorldAngle: false,
				useOneWay: false,
				useOneWayGrouping: true,
				surfaceArc: 120,
				useSideFriction: false,
				useSideBounce: false,
				sideArc: 30,
			}),
			expect.objectContaining({ id: "buoyancy", surfaceLevel: 8, density: 2, linearDrag: 3, angularDrag: 4, flowAngle: 90, flowMagnitude: 5, flowVariation: -1 }),
		]);
		scene.metadata.babylonEditorPhysics2DEffectors[0].forceMagnitude = 999;
		expect(data.metadata.babylonEditorPhysics2DEffectors[0].forceMagnitude).toBe(10);
	});

	test("rejects malformed collections before changing export metadata", () => {
		scene.metadata = {
			babylonEditorPhysics2DJoints: [{ id: "bad", type: "spring", firstNodeId: "first", frequency: Number.NaN }],
			babylonEditorPhysics2DEffectors: [],
		};
		const data = { metadata: { sentinel: true } };

		expect(() => configurePhysics2DExportMetadata(data, scene)).toThrow("Cannot export invalid Physics 2D joint");
		expect(data).toEqual({ metadata: { sentinel: true } });
	});

	test("rejects malformed solver settings before changing export metadata", () => {
		scene.metadata = { babylonEditorPhysics2DJoints: [], babylonEditorPhysics2DEffectors: [], babylonEditorPhysics2DSettings: { positionIterations: 17 } };
		const data = { metadata: { sentinel: true } };

		expect(() => configurePhysics2DExportMetadata(data, scene)).toThrow("positionIterations");
		expect(data).toEqual({ metadata: { sentinel: true } });
	});
});

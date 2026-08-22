import { describe, expect, test } from "vitest";

import {
	MaxPhysics2DEffectors,
	MaxPhysics2DJoints,
	normalizePhysics2DEffectorConfiguration,
	normalizePhysics2DEffectorConfigurations,
	normalizePhysics2DJointConfiguration,
	normalizePhysics2DJointConfigurations,
	Physics2DEffectorContractVersion,
	Physics2DJointContractVersion,
	physics2DJointTypes,
} from "../../src/loading/physics2d-joints";

const bodies = { id: "joint-1", firstNodeId: "body-a", secondNodeId: "body-b" };

describe("loading/physics2d-joints", () => {
	test("normalizes every Unity 2D joint family into the versioned contract", () => {
		for (const type of physics2DJointTypes) {
			const candidate = type === "target" ? { id: `joint-${type}`, type, firstNodeId: "body-a", target: [25, 50] } : { ...bodies, id: `joint-${type}`, type };
			const normalized = normalizePhysics2DJointConfiguration(candidate);

			expect(normalized).toMatchObject({
				ok: true,
				value: {
					version: Physics2DJointContractVersion,
					revision: 1,
					id: `joint-${type}`,
					type,
					firstNodeId: "body-a",
					enabled: true,
					enableCollision: false,
					breakAction: "destroy",
				},
			});
		}
	});

	test("migrates legacy hinge fields without aliasing mutable anchors", () => {
		const firstAnchor = [1, 2];
		const legacy = {
			...bodies,
			type: "hinge",
			firstAnchor,
			secondAnchor: [-10, 4],
			referenceAngle: 0.25,
			minAngle: -0.5,
			maxAngle: 0.75,
			motorSpeed: 2,
			maxMotorTorque: 500,
		};
		const normalized = normalizePhysics2DJointConfiguration(legacy);

		expect(normalized).toMatchObject({
			ok: true,
			value: {
				type: "hinge",
				firstAnchor: [1, 2],
				secondAnchor: [-10, 4],
				autoConfigureConnectedAnchor: false,
				useLimits: true,
				minAngle: -0.5,
				maxAngle: 0.75,
				useMotor: true,
				motorSpeed: 2,
				maxMotorTorque: 500,
			},
		});
		firstAnchor[0] = 99;
		expect(normalized.ok && normalized.value.type === "hinge" ? normalized.value.firstAnchor : null).toEqual([1, 2]);
	});

	test("marks anchor-less legacy joints for one-time connected-anchor capture", () => {
		const normalized = normalizePhysics2DJointConfiguration({ ...bodies, type: "fixed", distance: 100 });

		expect(normalized).toMatchObject({
			ok: true,
			value: {
				type: "fixed",
				firstAnchor: [0, 0],
				secondAnchor: [0, 0],
				autoConfigureConnectedAnchor: true,
				referenceAngle: 0,
			},
		});
	});

	test("supports fixed-world connections while Target remains world-only", () => {
		expect(normalizePhysics2DJointConfiguration({ id: "world-hinge", type: "hinge", firstNodeId: "body-a", secondAnchor: [100, 50] })).toMatchObject({
			ok: true,
			value: { secondAnchor: [100, 50] },
		});
		expect(normalizePhysics2DJointConfiguration({ ...bodies, type: "target", target: [0, 0] })).toEqual({
			ok: false,
			error: "Physics 2D target joint contains invalid identity, connection, revision, break, or collision fields.",
		});
	});

	test("rejects non-finite, inverted, self-connected, duplicate, and unbounded joint data", () => {
		expect(normalizePhysics2DJointConfiguration({ ...bodies, type: "hinge", minAngle: 2, maxAngle: 1 }).ok).toBe(false);
		expect(normalizePhysics2DJointConfiguration({ ...bodies, type: "slider", lowerTranslation: 2, upperTranslation: 1 }).ok).toBe(false);
		expect(normalizePhysics2DJointConfiguration({ ...bodies, type: "spring", frequency: Number.NaN }).ok).toBe(false);
		expect(normalizePhysics2DJointConfiguration({ ...bodies, secondNodeId: bodies.firstNodeId }).ok).toBe(false);
		expect(normalizePhysics2DJointConfigurations([bodies, bodies])).toMatchObject({ ok: false, error: expect.stringContaining("duplicated") });
		expect(normalizePhysics2DJointConfigurations(Array.from({ length: MaxPhysics2DJoints + 1 }))).toMatchObject({ ok: false, error: expect.stringContaining("at most") });
	});

	test("migrates existing effectors and normalizes the complete buoyancy surface", () => {
		expect(normalizePhysics2DEffectorConfiguration({ id: "point-1", nodeId: "source" })).toEqual({
			ok: true,
			value: {
				version: Physics2DEffectorContractVersion,
				revision: 1,
				id: "point-1",
				type: "point",
				nodeId: "source",
				enabled: true,
				radius: 100,
				force: 1000,
				falloff: 1,
				forceMagnitude: 1000,
				forceVariation: 0,
				distanceScale: 1,
				linearDrag: 0,
				angularDrag: 0,
				forceSource: "rigidbody",
				forceTarget: "rigidbody",
				forceMode: "inverse-linear",
				useColliderMask: false,
				colliderMask: 0xffffffff,
			},
		});
		expect(
			normalizePhysics2DEffectorConfiguration({
				id: "water-1",
				nodeId: "water-volume",
				type: "buoyancy",
				surfaceLevel: 20,
				density: 2,
				linearDrag: 3,
				angularDrag: 4,
				flowAngle: 45,
				flowMagnitude: 100,
				flowVariation: 10,
				useColliderMask: true,
				colliderMask: 5,
			})
		).toMatchObject({
			ok: true,
			value: {
				type: "buoyancy",
				surfaceLevel: 20,
				density: 2,
				linearDrag: 3,
				angularDrag: 4,
				flowAngle: 45,
				flowMagnitude: 100,
				flowVariation: 10,
				useColliderMask: true,
				colliderMask: 5,
			},
		});
	});

	test("migrates legacy force fields and normalizes every Unity effector property surface", () => {
		expect(normalizePhysics2DEffectorConfiguration({ id: "point", nodeId: "source", force: 250, falloff: 2 })).toMatchObject({
			ok: true,
			value: { version: 2, type: "point", forceMagnitude: 250, forceMode: "inverse-squared", forceSource: "rigidbody", forceTarget: "rigidbody" },
		});
		expect(normalizePhysics2DEffectorConfiguration({ id: "legacy-platform", nodeId: "floor", type: "platform", platformAngle: 45 })).toMatchObject({
			ok: true,
			value: { type: "platform", platformAngle: 45, rotationalOffset: 0, usesLegacyWorldAngle: true },
		});
		expect(
			normalizePhysics2DEffectorConfiguration({
				version: 2,
				id: "area",
				nodeId: "wind",
				type: "area",
				forceMagnitude: 20,
				forceVariation: 3,
				linearDrag: 4,
				angularDrag: 5,
				forceTarget: "collider",
				useGlobalAngle: false,
			})
		).toMatchObject({
			ok: true,
			value: { type: "area", forceMagnitude: 20, forceVariation: 3, linearDrag: 4, angularDrag: 5, forceTarget: "collider", useGlobalAngle: false },
		});
		expect(
			normalizePhysics2DEffectorConfiguration({
				version: 2,
				id: "surface",
				nodeId: "belt",
				type: "surface",
				speed: 50,
				speedVariation: -5,
				forceScale: 0.5,
				useContactForce: true,
				useFriction: false,
				useBounce: false,
			})
		).toMatchObject({
			ok: true,
			value: { type: "surface", speed: 50, speedVariation: -5, forceScale: 0.5, useContactForce: true, useFriction: false, useBounce: false },
		});
		expect(
			normalizePhysics2DEffectorConfiguration({
				version: 2,
				id: "platform",
				nodeId: "floor",
				type: "platform",
				rotationalOffset: 15,
				useOneWay: false,
				useOneWayGrouping: true,
				surfaceArc: 120,
				useSideFriction: false,
				useSideBounce: false,
				sideArc: 30,
				useColliderMask: true,
				colliderMask: 4,
			})
		).toMatchObject({
			ok: true,
			value: {
				type: "platform",
				rotationalOffset: 15,
				usesLegacyWorldAngle: false,
				useOneWay: false,
				useOneWayGrouping: true,
				surfaceArc: 120,
				useSideFriction: false,
				useSideBounce: false,
				sideArc: 30,
				colliderMask: 4,
			},
		});
	});

	test("rejects malformed, duplicate, and unbounded effector data atomically", () => {
		expect(normalizePhysics2DEffectorConfiguration({ id: "water", nodeId: "volume", type: "buoyancy", density: -1 }).ok).toBe(false);
		expect(normalizePhysics2DEffectorConfiguration({ version: 2, id: "point", nodeId: "source", forceMode: "logarithmic" }).ok).toBe(false);
		expect(normalizePhysics2DEffectorConfiguration({ version: 2, id: "point", nodeId: "source", linearDrag: null }).ok).toBe(false);
		expect(normalizePhysics2DEffectorConfiguration({ version: 2, id: "area", nodeId: "source", type: "area", colliderMask: -1 }).ok).toBe(false);
		expect(normalizePhysics2DEffectorConfiguration({ version: 2, id: "flow", nodeId: "source", type: "buoyancy", flowVariation: -5 })).toMatchObject({
			ok: true,
			value: { flowVariation: -5 },
		});
		expect(normalizePhysics2DEffectorConfiguration({ version: 2, id: "platform", nodeId: "source", type: "platform", surfaceArc: 361 }).ok).toBe(false);
		expect(normalizePhysics2DEffectorConfiguration({ version: 2, id: "platform", nodeId: "source", type: "platform", sideArc: 181 }).ok).toBe(false);
		const effector = { id: "point-1", nodeId: "source" };
		expect(normalizePhysics2DEffectorConfigurations([effector, effector])).toMatchObject({ ok: false, error: expect.stringContaining("duplicated") });
		expect(normalizePhysics2DEffectorConfigurations(Array.from({ length: MaxPhysics2DEffectors + 1 }))).toMatchObject({ ok: false, error: expect.stringContaining("at most") });
	});
});

import { describe, expect, test } from "vitest";

import { Physics2DBodyContractVersion, normalizePhysics2DBodyConfiguration } from "../../src/loading/physics2d-types";

describe("loading/physics2d-types", () => {
	test("normalizes legacy bodies into the versioned angular contract", () => {
		const result = normalizePhysics2DBodyConfiguration({ nodeId: "body", bodyType: "dynamic", collider: { shape: "box", size: [40, 20] } });

		expect(result).toEqual({
			ok: true,
			value: expect.objectContaining({
				version: Physics2DBodyContractVersion,
				revision: 1,
				bodyType: "dynamic",
				velocity: [0, 0],
				angularVelocity: 0,
				mass: 1,
				inertia: 1,
				useAutoInertia: true,
				centerOfMass: [0, 0],
				collisionDetection: "discrete",
				collider: expect.objectContaining({ shape: "box", size: [40, 20], offset: [0, 0] }),
			}),
		});
	});

	test("accepts kinematic capsule authoring and explicit angular properties", () => {
		const result = normalizePhysics2DBodyConfiguration({
			nodeId: "capsule",
			bodyType: "kinematic",
			revision: 7,
			collider: { shape: "capsule", size: [20, 60], direction: "vertical", offset: [3, -4] },
			velocity: [10, -20],
			angularVelocity: 2.5,
			mass: 4,
			useAutoMass: false,
			inertia: 12,
			useAutoInertia: false,
			centerOfMass: [1, 2],
			freezePositionX: true,
			freezeRotation: true,
			collisionDetection: "continuous",
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				bodyType: "kinematic",
				revision: 7,
				velocity: [10, -20],
				angularVelocity: 2.5,
				mass: 4,
				inertia: 12,
				useAutoInertia: false,
				centerOfMass: [1, 2],
				freezePositionX: true,
				freezeRotation: true,
				collisionDetection: "continuous",
				collider: expect.objectContaining({ shape: "capsule", size: [20, 60], direction: "vertical", offset: [3, -4] }),
			},
		});
	});

	test("rejects malformed and unbounded metadata without mutating the source", () => {
		const source = { nodeId: "bad", bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, angularVelocity: Number.NaN };
		const snapshot = { ...source, collider: { ...source.collider } };

		expect(normalizePhysics2DBodyConfiguration(source)).toEqual({ ok: false, error: 'Physics 2D body "bad" contains non-finite or out-of-range values.' });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, mass: 0 })).toMatchObject({ ok: false });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, friction: Number.NaN })).toMatchObject({ ok: false });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, collider: { shape: "circle", radius: 10, density: Number.NaN } })).toMatchObject({ ok: false });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, enabled: "false" })).toMatchObject({ ok: false });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, version: Physics2DBodyContractVersion + 1 })).toMatchObject({ ok: false });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, velocity: [undefined, 0] })).toMatchObject({ ok: false });
		expect(normalizePhysics2DBodyConfiguration({ ...source, angularVelocity: 0, bodyType: { toString: () => "dynamic" } })).toMatchObject({ ok: false });
		expect(
			normalizePhysics2DBodyConfiguration({
				...source,
				angularVelocity: 0,
				collider: {
					shape: "edge",
					points: [
						[0, 0],
						[0, 0],
					],
				},
			})
		).toMatchObject({ ok: false });
		expect(
			normalizePhysics2DBodyConfiguration({
				...source,
				angularVelocity: 0,
				collider: {
					shape: "polygon",
					points: [
						[0, 0],
						[1, 1],
					],
				},
			})
		).toMatchObject({ ok: false });
		expect(
			normalizePhysics2DBodyConfiguration({
				...source,
				angularVelocity: 0,
				collider: {
					shape: "polygon",
					points: [
						[0, 0],
						[10, 0],
						[0, 10],
					],
					contours: [{ id: "outer", points: [[0, 0]], holes: [] }],
				},
			})
		).toMatchObject({ ok: false });
		expect(source).toEqual(snapshot);
	});
});

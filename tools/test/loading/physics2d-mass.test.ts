import { describe, expect, test } from "vitest";

import { computePhysics2DMassProperties } from "../../src/loading/physics2d-mass";
import { normalizePhysics2DBodyConfiguration } from "../../src/loading/physics2d-types";

/** Keeps fixtures on the same public validation path used by scene metadata. */
function body(value: Record<string, unknown>) {
	const result = normalizePhysics2DBodyConfiguration(value);
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result.value;
}

describe("loading/physics2d-mass", () => {
	test("computes box auto mass center and inertia in centimeter units", () => {
		const result = computePhysics2DMassProperties(
			body({ nodeId: "box", bodyType: "dynamic", useAutoMass: true, collider: { shape: "box", size: [100, 50], offset: [10, -5], density: 0.002 } })
		);

		expect(result.mass).toBeCloseTo(10, 8);
		expect(result.centerOfMass).toEqual([10, -5]);
		expect(result.inertia).toBeCloseTo((10 * (100 ** 2 + 50 ** 2)) / 12, 8);
		expect(result.inverseMass).toBeCloseTo(0.1, 8);
	});

	test("applies the parallel-axis term for a custom center of mass", () => {
		const result = computePhysics2DMassProperties(
			body({ nodeId: "circle", bodyType: "dynamic", mass: 4, centerOfMass: [10, 0], useAutoCenterOfMass: false, collider: { shape: "circle", radius: 5 } })
		);

		expect(result.mass).toBe(4);
		expect(result.centerOfMass).toEqual([10, 0]);
		expect(result.inertia).toBeCloseTo(450, 8);
	});

	test("computes finite capsule and polygon moments", () => {
		const capsule = computePhysics2DMassProperties(
			body({ nodeId: "capsule", bodyType: "dynamic", useAutoMass: true, collider: { shape: "capsule", size: [20, 60], density: 0.001 } })
		);
		const polygon = computePhysics2DMassProperties(
			body({
				nodeId: "polygon",
				bodyType: "dynamic",
				useAutoMass: true,
				collider: {
					shape: "polygon",
					density: 0.01,
					points: [
						[0, 0],
						[10, 0],
						[0, 10],
					],
				},
			})
		);

		expect(capsule.mass).toBeCloseTo((20 * 40 + Math.PI * 100) * 0.001, 8);
		expect(capsule.inertia).toBeGreaterThan(0);
		expect(polygon.mass).toBeCloseTo(0.5, 8);
		expect(polygon.centerOfMass[0]).toBeCloseTo(10 / 3, 8);
		expect(polygon.centerOfMass[1]).toBeCloseTo(10 / 3, 8);
		expect(Number.isFinite(polygon.inertia)).toBe(true);
	});

	test("combines compound polygon parts regardless of winding", () => {
		const result = computePhysics2DMassProperties(
			body({
				nodeId: "compound",
				bodyType: "dynamic",
				useAutoMass: true,
				collider: {
					shape: "polygon",
					density: 0.01,
					points: [
						[0, 0],
						[10, 0],
						[0, 10],
					],
					parts: [
						[
							[0, 0],
							[10, 0],
							[0, 10],
						],
						[
							[20, 0],
							[20, 10],
							[30, 0],
						],
					],
				},
			})
		);

		expect(result.mass).toBeCloseTo(1, 8);
		expect(result.centerOfMass[0]).toBeCloseTo(40 / 3, 8);
		expect(result.centerOfMass[1]).toBeCloseTo(10 / 3, 8);
		expect(result.inertia).toBeGreaterThan(0);
	});

	test("uses thick open-edge segments for automatic mass properties", () => {
		const result = computePhysics2DMassProperties(
			body({
				nodeId: "edge",
				bodyType: "dynamic",
				useAutoMass: true,
				collider: {
					shape: "edge",
					edgeRadius: 2,
					density: 0.01,
					offset: [5, 0],
					points: [
						[0, 0],
						[10, 0],
						[20, 0],
					],
				},
			})
		);

		expect(result.mass).toBeCloseTo(2 * (4 * 10 + Math.PI * 4) * 0.01, 8);
		expect(result.centerOfMass).toEqual([15, 0]);
		expect(result.inertia).toBeGreaterThan(0);
	});

	test("disables inverse response for non-dynamic and frozen bodies", () => {
		const kinematic = computePhysics2DMassProperties(body({ nodeId: "kinematic", bodyType: "kinematic", collider: { shape: "circle", radius: 5 } }));
		const frozen = computePhysics2DMassProperties(body({ nodeId: "frozen", bodyType: "dynamic", freezeRotation: true, collider: { shape: "circle", radius: 5 } }));

		expect(kinematic).toMatchObject({ inverseMass: 0, inverseInertia: 0 });
		expect(frozen.inverseMass).toBeGreaterThan(0);
		expect(frozen.inverseInertia).toBe(0);
	});
});

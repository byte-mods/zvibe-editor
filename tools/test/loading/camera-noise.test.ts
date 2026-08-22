import { describe, expect, test } from "vitest";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { evaluateCameraNoiseProfile, ICameraNoiseProfile, validateCameraNoiseProfile } from "../../src/loading/camera-noise";

describe("loading/camera-noise", () => {
	const profile: ICameraNoiseProfile = {
		id: "handheld",
		name: "Handheld",
		position: { x: [{ amplitude: 10, frequency: 1, nonRandom: true }], y: [], z: [] },
		rotation: { x: [], y: [{ amplitude: 5, frequency: 0.5, nonRandom: true }], z: [] },
	};

	test("evaluates deterministic layered position, rotation, gains, and pivot correction", () => {
		validateCameraNoiseProfile(profile);
		const sample = evaluateCameraNoiseProfile(profile, 0.25, 42, 2, 1, new Vector3(0, 0, 100));
		expect(sample.position.x).toBeCloseTo(20, 6);
		expect(sample.rotationRadians.y * (180 / Math.PI)).toBeCloseTo(5 * Math.SQRT1_2 * 2, 6);
		expect(sample.pivotPosition.length()).toBeGreaterThan(0);
		expect(evaluateCameraNoiseProfile(profile, 0.25, 42, 2, 1).position.asArray()).toEqual(evaluateCameraNoiseProfile(profile, 0.25, 42, 2, 1).position.asArray());
	});

	test("rejects unbounded or empty profiles", () => {
		expect(() => validateCameraNoiseProfile({ ...profile, position: { x: [], y: [], z: [] }, rotation: { x: [], y: [], z: [] } })).toThrow("at least one");
		expect(() => validateCameraNoiseProfile({ ...profile, position: { ...profile.position, x: [{ amplitude: 1, frequency: 121 }] } })).toThrow("0..120 Hz");
	});
});

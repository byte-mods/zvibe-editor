import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";

import {
	configureReflectionProbes,
	getReflectionProbeInfluenceWeight,
	reflectionProbeMetadataKey,
	validateReflectionProbeBlendDistance,
} from "../../src/loading/reflection-probes";

describe("loading/reflection-probes", () => {
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

	test("restores serialized influence bounds and clears disabled projection without changing probe identity", () => {
		const projected = new ReflectionProbe("Projected", 32, scene);
		projected.position.set(1, 2, 3);
		projected.metadata = {
			[reflectionProbeMetadataKey]: {
				version: 1,
				id: "projected-id",
				revision: 7,
				boxProjection: true,
				influencePosition: [10, 20, 30],
				influenceSize: [100, 200, 300],
			},
		};
		const infinite = new ReflectionProbe("Infinite", 32, scene);
		infinite.cubeTexture.boundingBoxPosition = Vector3.One();
		infinite.cubeTexture.boundingBoxSize = Vector3.One();
		infinite.metadata = { [reflectionProbeMetadataKey]: { version: 1, id: "infinite-id", revision: 2, boxProjection: false } };

		expect(configureReflectionProbes(scene)).toBe(2);
		expect(projected.cubeTexture.boundingBoxPosition?.asArray()).toEqual([10, 20, 30]);
		expect(projected.cubeTexture.boundingBoxSize?.asArray()).toEqual([100, 200, 300]);
		expect(infinite.cubeTexture.boundingBoxPosition).toBeNull();
		expect(infinite.cubeTexture.boundingBoxSize).toBeNull();
		expect(projected.metadata[reflectionProbeMetadataKey]).toMatchObject({ id: "projected-id", revision: 7 });
	});

	test("evaluates and validates the exact Unity-style inner-edge influence fade", () => {
		expect(getReflectionProbeInfluenceWeight([0, 0, 0], [0, 0, 0], [20, 20, 20], 4)).toBe(1);
		expect(getReflectionProbeInfluenceWeight([8, 0, 0], [0, 0, 0], [20, 20, 20], 4)).toBeCloseTo(0.5);
		expect(getReflectionProbeInfluenceWeight([10, 0, 0], [0, 0, 0], [20, 20, 20], 4)).toBe(0);
		expect(getReflectionProbeInfluenceWeight([11, 0, 0], [0, 0, 0], [20, 20, 20], 4)).toBe(0);
		expect(getReflectionProbeInfluenceWeight([10, 0, 0], [0, 0, 0], [20, 20, 20], 0)).toBe(1);
		expect(() => validateReflectionProbeBlendDistance([20, 10, 30], 5)).not.toThrow();
		expect(() => validateReflectionProbeBlendDistance([20, 10, 30], 5.01)).toThrow("half the smallest");
	});
});

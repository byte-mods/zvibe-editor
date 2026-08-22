import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "@babylonjs/core";

import {
	getHybridPhysicsSolverRuntime,
	normalizeHybridPhysicsSolverConfiguration,
	solveHybridPhysicsLinearSystem,
	stepHybridPhysicsSolver,
} from "../../src/loading/physics-hybrid-solver";

describe("loading/physics-hybrid-solver", () => {
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

	test("normalizes bounded defaults and rejects malformed gear rows", () => {
		expect(normalizeHybridPhysicsSolverConfiguration(undefined)).toMatchObject({
			ok: true,
			value: { version: 1, revision: 1, enabled: true, maximumRows: 128, gearCouplings: [] },
		});
		expect(
			normalizeHybridPhysicsSolverConfiguration({
				gearCouplings: [
					{
						id: "gear",
						name: "Gear",
						enabled: true,
						bodyANodeId: "a",
						bodyBNodeId: "b",
						axisA: [2, 0, 0],
						axisB: [0, 0, 1],
						ratio: 1,
						targetVelocity: 0,
						maximumImpulse: 10,
					},
				],
			}).ok
		).toBe(false);
		expect(normalizeHybridPhysicsSolverConfiguration({ maximumRows: 257 }).ok).toBe(false);
	});

	test("solves multiple stiff rows as one coupled system", () => {
		const result = solveHybridPhysicsLinearSystem(
			[
				{ id: "a", inverseMass: 0, inverseInertia: 1, linearVelocity: [0, 0, 0], angularVelocity: [4, 0, 0] },
				{ id: "b", inverseMass: 0, inverseInertia: 1, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
				{ id: "c", inverseMass: 0, inverseInertia: 1, linearVelocity: [0, 0, 0], angularVelocity: [-2, 0, 0] },
			],
			[
				{
					id: "ab",
					bodyAId: "a",
					bodyBId: "b",
					linearA: [0, 0, 0],
					angularA: [1, 0, 0],
					linearB: [0, 0, 0],
					angularB: [1, 0, 0],
					targetVelocity: 0,
					positionError: 0,
				},
				{
					id: "bc",
					bodyAId: "b",
					bodyBId: "c",
					linearA: [0, 0, 0],
					angularA: [1, 0, 0],
					linearB: [0, 0, 0],
					angularB: [1, 0, 0],
					targetVelocity: 0,
					positionError: 0,
				},
			],
			1 / 60,
			{ positionErrorBias: 0.2, regularization: 0.000000001, maximumImpulse: 1000 }
		);

		expect(result.rowCount).toBe(2);
		expect(result.maximumResidualBefore).toBe(4);
		expect(result.maximumResidualAfter).toBeLessThan(0.000001);
		expect(result.bodies.map((body) => body.angularVelocity[0])).toEqual(expect.arrayContaining([expect.any(Number)]));
	});

	test("does no direct work when no selected row exists", () => {
		const result = stepHybridPhysicsSolver(scene, 1 / 60);
		expect(result).toMatchObject({ processedFrames: 0, skippedFrames: 1, rowCount: 0, lastSkippedReason: "No active direct joint or gear row requires processing." });
		expect(getHybridPhysicsSolverRuntime(scene)).toMatchObject({ attached: true, frames: 1, processedFrames: 0 });
	});
});

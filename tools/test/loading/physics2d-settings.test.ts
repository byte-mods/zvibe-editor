import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene, TransformNode } from "@babylonjs/core";

import { configurePhysics2D, setPhysics2DSimulationPaused, stepPausedPhysics2DSimulation } from "../../src/loading/physics2d";
import { normalizePhysics2DSettingsConfiguration } from "../../src/loading/physics2d-settings";

describe("loading/physics2d-settings", () => {
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

	test("migrates legacy iterations into an independent detached v3 world view", () => {
		const legacy = { solverIterations: 6 };
		const normalized = normalizePhysics2DSettingsConfiguration(legacy);

		expect(normalized).toMatchObject({
			ok: true,
			value: {
				version: 3,
				revision: 1,
				maximumWorlds: 8,
				velocityIterations: 6,
				positionIterations: 6,
				worlds: [{ id: "default", velocityIterations: 6, positionIterations: 6, transformPlane: { mode: "xy" }, contactFilterMode: "layers" }],
			},
		});
		expect(legacy).toEqual({ solverIterations: 6 });
	});

	test("lets split values override the legacy fallback independently", () => {
		expect(normalizePhysics2DSettingsConfiguration({ solverIterations: 6, velocityIterations: 8 })).toMatchObject({
			ok: true,
			value: { version: 3, revision: 1, velocityIterations: 8, positionIterations: 6, worlds: [{ id: "default", velocityIterations: 8, positionIterations: 6 }] },
		});
	});

	test("rejects malformed versions revisions and either solver bound", () => {
		for (const value of [null, { version: 4 }, { revision: 0 }, { solverIterations: 0 }, { velocityIterations: 17 }, { positionIterations: 1.5 }]) {
			expect(normalizePhysics2DSettingsConfiguration(value).ok).toBe(false);
		}
	});

	test("validates bounded worlds and orthonormal custom transform planes", () => {
		const normalized = normalizePhysics2DSettingsConfiguration({
			worlds: [
				{ id: "default", name: "Default" },
				{
					id: "wall",
					name: "Wall",
					transformPlane: { mode: "custom", origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1] },
					transformWriteMode: "tween",
					contactFilterMode: "none",
				},
			],
		});

		expect(normalized).toMatchObject({ ok: true, value: { worlds: [{ id: "default" }, { id: "wall", transformWriteMode: "tween", contactFilterMode: "none" }] } });
		expect(
			normalizePhysics2DSettingsConfiguration({
				worlds: [{ id: "default" }, { id: "bad", transformPlane: { mode: "custom", origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [1, 0, 0] } }],
			}).ok
		).toBe(false);
	});

	test("fails a runtime frame instead of silently replacing malformed persisted settings", () => {
		const body = new TransformNode("Body", scene);
		scene.metadata = {
			babylonEditorPhysics2D: [{ nodeId: body.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }],
			babylonEditorPhysics2DSettings: { velocityIterations: 4, positionIterations: 99 },
		};
		configurePhysics2D(scene);
		setPhysics2DSimulationPaused(scene, true);

		expect(() => stepPausedPhysics2DSimulation(scene, 0.01)).toThrow("positionIterations");
		expect(body.position.asArray()).toEqual([0, 0, 0]);
	});
});

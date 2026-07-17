import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Color3, NullEngine, PointLight, Scene, Vector3 } from "babylonjs";

import { blendLightingScenario, createLightingScenario } from "../../src/mcp/lights/lights";

describe("mcp/lighting-scenario-blend", () => {
	let engine: NullEngine;
	let scene: Scene;
	let light: PointLight;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		light = new PointLight("Lamp", new Vector3(100, 0, 0), scene);
		light.intensity = 2;
		light.diffuse = new Color3(1, 0, 0);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		scene.dispose();
		engine.dispose();
	});

	test("cross-fades captured realtime light state and supports an immediate blend", () => {
		const scenario = createLightingScenario(scene, { name: "Night" }, options);
		light.intensity = 0;
		light.diffuse = new Color3(0, 0, 1);
		light.position.copyFromFloats(0, 0, 0);
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);
		blendLightingScenario(scene, { id: scenario.id, durationMs: 100 }, options);
		now.mockReturnValue(50);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(light.intensity).toBe(1);
		expect(light.diffuse.r).toBeCloseTo(0.5);
		expect(light.diffuse.b).toBeCloseTo(0.5);
		expect(light.position.x).toBe(50);
		now.mockReturnValue(100);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(light.intensity).toBe(2);
		expect(light.diffuse.asArray()).toEqual([1, 0, 0]);
		light.intensity = 0.25;
		blendLightingScenario(scene, { id: scenario.id, durationMs: 0 }, options);
		expect(light.intensity).toBe(2);
	});
});

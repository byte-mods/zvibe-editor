import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DirectionalLight, NullEngine, Scene, Vector3 } from "babylonjs";

import { applyLightingScenario, createLightingScenario, deleteLightingScenario, listLightingScenarios } from "../../src/mcp/lights/lights";

describe("mcp/lighting-scenarios", () => {
	let engine: NullEngine;
	let scene: Scene;
	let light: DirectionalLight;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		light = new DirectionalLight("Sun", new Vector3(0, -1, 0), scene);
		light.intensity = 2;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("captures, restores, lists, and deletes realtime light scenarios", () => {
		const scenario = createLightingScenario(scene, { name: "Day" }, options);
		light.intensity = 0.2;
		light.setEnabled(false);
		expect(applyLightingScenario(scene, { id: scenario.id }, options)).toMatchObject({ appliedLightIds: [light.id], missingLightNames: [] });
		expect(light.intensity).toBe(2);
		expect(light.isEnabled()).toBe(true);
		expect(listLightingScenarios(scene).scenarios).toHaveLength(1);
		expect(deleteLightingScenario(scene, { name: "Day" }, options)).toMatchObject({ deleted: true });
	});

	test("rejects duplicate names and reports missing scenario lights", () => {
		const scenario = createLightingScenario(scene, { name: "Day" }, options);
		expect(() => createLightingScenario(scene, { name: "Day" }, options)).toThrow("already exists");
		light.dispose();
		expect(applyLightingScenario(scene, { id: scenario.id }, options)).toMatchObject({ appliedLightIds: [], missingLightNames: ["Sun"] });
	});
});

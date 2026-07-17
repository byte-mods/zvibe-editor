import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, NullEngine, ParticleSystem, Scene } from "babylonjs";

import { applyVfxBudgetProfile, createVfxBudgetProfile, deleteVfxBudgetProfile, listVfxBudgetProfiles, setVfxBudgetProfile } from "../../src/mcp/particles/particles";

describe("mcp/vfx-budget-profiles", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		const system = new ParticleSystem("Sparks", 100, scene);
		system.emitter = new Mesh("Emitter", scene);
		system.emitRate = 20;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists and applies capacity/emission quality budgets", () => {
		const profile = createVfxBudgetProfile(scene, { name: "Mobile", capacityScale: 0.5, emissionScale: 0.25, maxCapacity: 40 }, options);
		expect(applyVfxBudgetProfile(scene, { id: profile.id }, options).systems).toMatchObject([{ name: "Sparks", capacity: 40, emitRate: 5 }]);
		expect(setVfxBudgetProfile(scene, { id: profile.id, emissionScale: 1 }, options)).toMatchObject({ emissionScale: 1 });
		expect(listVfxBudgetProfiles(scene).profiles).toHaveLength(1);
		expect(deleteVfxBudgetProfile(scene, { id: profile.id }, options)).toMatchObject({ deleted: true });
	});

	test("validates profile scale and capacity constraints", () => {
		expect(() => createVfxBudgetProfile(scene, { name: "Bad", capacityScale: 0, emissionScale: 1 }, options)).toThrow("capacityScale");
		expect(() => createVfxBudgetProfile(scene, { name: "Bad", capacityScale: 1, emissionScale: 1, maxCapacity: 0 }, options)).toThrow("maxCapacity");
	});
});

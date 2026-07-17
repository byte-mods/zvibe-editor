import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, NullEngine, ParticleSystem, Scene, Vector3 } from "babylonjs";

import { applyParticleVectorFields, getParticleVectorFields, setParticleVectorFields } from "../../src/mcp/particles/vector-fields";

describe("mcp/particle-vector-fields", () => {
	let engine: NullEngine;
	let scene: Scene;
	let system: ParticleSystem;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		system = new ParticleSystem("Wind", 10, scene);
		system.emitter = new Mesh("Emitter", scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists bounded vector fields and applies force only inside bounds", () => {
		const fields = [{ min: [-1, -1, -1], max: [1, 1, 1], direction: [1, 0, 0], strength: 10 }];
		expect(setParticleVectorFields(scene, { particleSystemId: system.id, fields }, options).fields).toEqual(fields);
		const inside = { position: new Vector3(0, 0, 0), direction: Vector3.Zero() };
		const outside = { position: new Vector3(2, 0, 0), direction: Vector3.Zero() };
		expect(applyParticleVectorFields([inside, outside], fields, 0.5)).toBe(1);
		expect(inside.direction.asArray()).toEqual([5, 0, 0]);
		expect(outside.direction.asArray()).toEqual([0, 0, 0]);
		expect(getParticleVectorFields(scene, { particleSystemId: system.id }).fields).toEqual(fields);
	});

	test("validates field bounds and limits", () => {
		expect(() =>
			setParticleVectorFields(scene, { particleSystemId: system.id, fields: [{ min: [1, 0, 0], max: [1, 1, 1], direction: [1, 0, 0], strength: 1 }] }, options)
		).toThrow("min must be less");
		expect(() =>
			setParticleVectorFields(
				scene,
				{ particleSystemId: system.id, fields: Array.from({ length: 9 }, () => ({ min: [0, 0, 0], max: [1, 1, 1], direction: [1, 0, 0], strength: 1 })) },
				options
			)
		).toThrow("zero to eight");
	});
});

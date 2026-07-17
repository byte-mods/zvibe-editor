import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, NullEngine, ParticleSystem, Scene, Vector3 } from "babylonjs";

import { applyParticleTextureVectorFields, getParticleTextureVectorFields, setParticleTextureVectorFields } from "../../src/mcp/particles/texture-vector-fields";

describe("mcp/particle-texture-vector-fields", () => {
	let engine: NullEngine;
	let scene: Scene;
	let system: ParticleSystem;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		system = new ParticleSystem("Wind", 16, scene);
		system.emitter = new Mesh("Emitter", scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists and samples RGB vector grids in the XZ bounds", () => {
		const fields = [{ min: [-1, -1, -1], max: [1, 1, 1], strength: 2, width: 2, height: 1, vectors: [1, 0, 0, 0, 0, 1], sourcePath: "assets/wind.png" }];
		setParticleTextureVectorFields(scene, { particleSystemId: system.id, fields }, options);
		expect(getParticleTextureVectorFields(scene, { particleSystemId: system.id }).fields).toEqual(fields);
		const particles = [
			{ position: new Vector3(-1, 0, 0), direction: Vector3.Zero() },
			{ position: new Vector3(1, 0, 0), direction: Vector3.Zero() },
		];
		expect(applyParticleTextureVectorFields(particles, fields, 0.5)).toBe(2);
		expect(particles[0].direction.asArray()).toEqual([1, 0, 0]);
		expect(particles[1].direction.asArray()).toEqual([0, 0, 1]);
	});

	test("validates portable grid dimensions and data", () => {
		expect(() =>
			setParticleTextureVectorFields(
				scene,
				{ particleSystemId: system.id, fields: [{ min: [0, 0, 0], max: [1, 1, 1], strength: 1, width: 2, height: 2, vectors: [], sourcePath: "bad.png" }] },
				options
			)
		).toThrow("exactly");
	});

	test("samples independent depth slices across XYZ space", () => {
		const fields = [{ min: [-1, -1, -1], max: [1, 1, 1], strength: 1, width: 1, height: 1, depth: 2, vectors: [1, 0, 0, 0, 1, 0], sourcePath: "assets/volume-0.png" }];
		const particles = [
			{ position: new Vector3(0, 0, -1), direction: Vector3.Zero() },
			{ position: new Vector3(0, 0, 1), direction: Vector3.Zero() },
		];
		expect(applyParticleTextureVectorFields(particles, fields, 1)).toBe(2);
		expect(particles[0].direction.asArray()).toEqual([1, 0, 0]);
		expect(particles[1].direction.asArray()).toEqual([0, 1, 0]);
	});
});

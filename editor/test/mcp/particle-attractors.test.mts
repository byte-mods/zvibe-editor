import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, ParticleSystem, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { getParticleAttractors, setParticleAttractors } from "../../src/mcp/particles/particles";

describe("mcp/particle-attractors", () => {
	let engine: NullEngine;
	let scene: Scene;
	let particles: ParticleSystem;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		particles = new ParticleSystem("Force Field", 16, scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("replaces native particle attractors and serializes their configuration", () => {
		const result = setParticleAttractors(
			scene,
			{
				particleSystemId: particles.id,
				attractors: [
					{ position: [10, 20, 30], strength: 2 },
					{ position: [-5, 0, 1], strength: -3 },
				],
			},
			options
		);
		expect(result.attractors).toEqual([
			{ position: [10, 20, 30], strength: 2 },
			{ position: [-5, 0, 1], strength: -3 },
		]);
		expect(getParticleAttractors(scene, { particleSystemId: particles.id }).attractors).toEqual(result.attractors);
		expect(particles.serialize().attractors).toHaveLength(2);
	});

	test("validates field count, finite positions, and strength", () => {
		expect(() => setParticleAttractors(scene, { particleSystemId: particles.id, attractors: [{ position: [0, 0], strength: 1 }] }, options)).toThrow("position");
		expect(() => setParticleAttractors(scene, { particleSystemId: particles.id, attractors: [{ position: [0, 0, 0], strength: Number.NaN }] }, options)).toThrow("strength");
	});
});

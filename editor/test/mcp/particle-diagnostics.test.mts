import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, ParticleSystem, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { validateParticleSystem } from "../../src/mcp/particles/particles";

describe("mcp/particle-diagnostics", () => {
	let engine: NullEngine;
	let scene: Scene;
	let system: ParticleSystem;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		system = new ParticleSystem("Sparks", 100, scene);
		system.emitter = MeshBuilder.CreateBox("Emitter", { size: 1 }, scene);
		system.emitRate = 20;
		system.minLifeTime = 1;
		system.maxLifeTime = 3;
		system.minSize = 0.1;
		system.maxSize = 1;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reports a valid effect and estimates peak alive particles", () => {
		const result = validateParticleSystem(scene, { particleSystemId: system.id });
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.budget).toMatchObject({ capacity: 100, emitRate: 20, maxLifeTime: 3, estimatedAliveParticles: 60 });
		expect(result.warnings.join(" ")).toContain("No particle texture");
	});

	test("reports invalid emitter and life range settings", () => {
		system.emitter = null as any;
		system.maxLifeTime = 0.5;
		const result = validateParticleSystem(scene, { particleSystemId: system.id });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("No emitter");
		expect(result.errors.join(" ")).toContain("maxLifeTime");
	});
});

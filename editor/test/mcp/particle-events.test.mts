import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GPUParticleSystem, Mesh, NullEngine, ParticleSystem, Scene } from "babylonjs";

import { getParticleEvents, setParticleEvents, triggerParticleEvent } from "../../src/mcp/particles/events";

describe("mcp/particle-events", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		for (const System of [ParticleSystem, GPUParticleSystem]) {
			const system = new System(System === ParticleSystem ? "CPU" : "GPU", 32, scene) as any;
			system.emitter = new Mesh(`${system.name} Emitter`, scene);
		}
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists and fires named CPU/GPU particle burst events", () => {
		const [cpu, gpu] = scene.particleSystems as any[];
		setParticleEvents(scene, { particleSystemId: cpu.id, events: [{ name: "Impact", count: 3 }] }, options);
		setParticleEvents(
			scene,
			{
				particleSystemId: gpu.id,
				events: [
					{ name: "Impact", count: 5 },
					{ name: "Disabled", count: 4, enabled: false },
				],
			},
			options
		);
		expect(getParticleEvents(scene, { particleSystemId: gpu.id }).events).toEqual([
			{ name: "Impact", count: 5 },
			{ name: "Disabled", count: 4, enabled: false },
		]);
		expect(triggerParticleEvent(scene, { eventName: "Impact" }, options)).toMatchObject({
			totalCount: 8,
			triggered: [
				{ particleSystemId: cpu.id, count: 3 },
				{ particleSystemId: gpu.id, count: 5 },
			],
		});
		expect(cpu.manualEmitCount).toBe(3);
		expect(gpu.manualEmitCount).toBe(5);
	});

	test("validates event configuration and reports nonmatching triggers", () => {
		const [cpu] = scene.particleSystems;
		expect(() => setParticleEvents(scene, { particleSystemId: cpu.id, events: [{ name: "", count: 1 }] }, options)).toThrow("non-empty");
		expect(() =>
			setParticleEvents(
				scene,
				{
					particleSystemId: cpu.id,
					events: [
						{ name: "A", count: 1 },
						{ name: "A", count: 2 },
					],
				},
				options
			)
		).toThrow("duplicated");
		expect(() => triggerParticleEvent(scene, { eventName: "Missing" }, options)).toThrow("No enabled");
	});
});

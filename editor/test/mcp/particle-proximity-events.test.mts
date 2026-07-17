import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, NullEngine, ParticleSystem, Scene, Vector3 } from "babylonjs";

import { getParticleProximityEvents, setParticleProximityEvents } from "../../src/mcp/particles/proximity-events";

describe("mcp/particle-proximity-events", () => {
	let engine: NullEngine;
	let scene: Scene;
	let source: ParticleSystem;
	let target: ParticleSystem;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		source = new ParticleSystem("Source", 8, scene);
		target = new ParticleSystem("Target", 8, scene);
		source.emitter = new Mesh("SourceEmitter", scene);
		target.emitter = new Mesh("TargetEmitter", scene);
	});
	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists a bounded CPU proximity burst and emits into the target", () => {
		const events = [{ targetParticleSystemId: target.id, radius: 1, count: 3, cooldownMs: 1000 }];
		setParticleProximityEvents(scene, { particleSystemId: source.id, events }, options);
		expect(getParticleProximityEvents(scene, { particleSystemId: source.id }).events).toEqual(events);
		(source as any).particles.push({ position: Vector3.Zero() });
		(target as any).particles.push({ position: new Vector3(0.5, 0, 0) });
		target.start();
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect((target as any).manualEmitCount).toBe(3);
	});

	test("rejects missing target systems", () => {
		expect(() => setParticleProximityEvents(scene, { particleSystemId: source.id, events: [{ targetParticleSystemId: "missing", radius: 1, count: 1 }] }, options)).toThrow(
			"target particle system"
		);
	});
});

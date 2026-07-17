import { describe, expect, test } from "vitest";

import { NullEngine, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";

import { configureParticleCollisions } from "../../src/loading/particle-collisions";

describe("loading/particle-collisions", () => {
	test("restores CPU particle plane collisions in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const system = new ParticleSystem("Particles", 10, scene);
		scene.metadata = { babylonEditorParticleCollisionPlanes: { [system.id]: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 1 }] } };
		(system.particles as any[]).push({ position: new Vector3(0, -2, 0), direction: new Vector3(0, -3, 0) });

		configureParticleCollisions(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		const particle = (system.particles as any[])[0];
		expect(particle.position.y).toBe(0);
		expect(particle.direction.y).toBe(3);
		scene.dispose();
		engine.dispose();
	});
});

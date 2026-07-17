import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, ParticleSystem, Scene, Vector3 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { getParticleCollisionPlanes, getParticleCollisionSpheres, setParticleCollisionPlanes, setParticleCollisionSpheres } from "../../src/mcp/particles/collisions";

describe("mcp/particle-collisions", () => {
	let engine: NullEngine;
	let scene: Scene;
	let system: ParticleSystem;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		system = new ParticleSystem("Particles", 10, scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists CPU collision planes and reflects a particle with restitution", () => {
		const result = setParticleCollisionPlanes(scene, { particleSystemId: system.id, planes: [{ position: [0, 0, 0], normal: [0, 2, 0], restitution: 0.5 }] }, options);
		expect(result.planes).toEqual([{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }]);
		(system.particles as any[]).push({ position: new Vector3(0, -1, 0), direction: new Vector3(0, -4, 0) });
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const particle = (system.particles as any[])[0];
		expect(particle.position.y).toBe(0);
		expect(particle.direction.y).toBe(2);
		expect(getParticleCollisionPlanes(scene, { particleSystemId: system.id }).planes).toHaveLength(1);
	});

	test("persists CPU collision spheres and projects particles outward", () => {
		setParticleCollisionSpheres(scene, { particleSystemId: system.id, spheres: [{ center: [0, 0, 0], radius: 5, restitution: 0.5 }] }, options);
		(system.particles as any[]).push({ position: new Vector3(0, 0, 0), direction: new Vector3(0, -4, 0) });
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const particle = (system.particles as any[])[0];
		expect(particle.position.y).toBe(5);
		expect(particle.direction.y).toBe(2);
		expect(getParticleCollisionSpheres(scene, { particleSystemId: system.id }).spheres).toHaveLength(1);
	});
});

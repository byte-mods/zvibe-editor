import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { configureParticleTextureVectorFields } from "../../src/loading/particle-texture-vector-fields";

describe("loading/particle-texture-vector-fields", () => {
	let engine: NullEngine;
	let scene: Scene;
	let particles: ParticleSystem;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		particles = new ParticleSystem("Wind", 16, scene);
		particles.emitter = new Mesh("Emitter", scene);
		scene.metadata = {
			babylonEditorParticleTextureVectorFields: {
				[particles.id]: [{ min: [-1, -1, -1], max: [1, 1, 1], strength: 2, width: 1, height: 1, vectors: [1, 0, 0] }],
			},
		};
		(particles.particles as any[]).push({ position: Vector3.Zero(), direction: Vector3.Zero() });
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("restores image-sampled vector grids for exported CPU particle effects", () => {
		configureParticleTextureVectorFields(scene);
		engine.getDeltaTime = () => 500;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect((particles.particles as any[])[0].direction.asArray()).toEqual([1, 0, 0]);
	});
});

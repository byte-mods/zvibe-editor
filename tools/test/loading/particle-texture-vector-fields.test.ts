import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

const nativeMocks = vi.hoisted(() => ({ configureGpuParticleTextureVectorFields: vi.fn() }));

vi.mock("../../src/loading/gpu-particle-texture-vector-fields", () => nativeMocks);

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

	test("restores the same portable grids through native GPU configuration", () => {
		const gpu: any = { id: "gpu-wind", getClassName: () => "GPUParticleSystem", dispose: vi.fn() };
		scene.particleSystems.push(gpu);
		const field = { min: [0, 0, 0], max: [1, 1, 1], strength: 1, width: 1, height: 1, depth: 1, vectors: [0, 1, 0] };
		scene.metadata.babylonEditorParticleTextureVectorFields[gpu.id] = [field];
		configureParticleTextureVectorFields(scene);
		expect(nativeMocks.configureGpuParticleTextureVectorFields).toHaveBeenCalledWith(gpu, [field]);
	});
});

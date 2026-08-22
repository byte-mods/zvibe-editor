import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, ParticleSystem, Scene, Vector3 } from "babylonjs";

const toolMocks = vi.hoisted(() => ({
	configureGpuParticleCollisions: vi.fn(),
	getGpuParticleCollisionRuntimeEvidence: vi.fn(() => ({
		nativeGpu: true,
		backend: "webgl2-transform-feedback",
		executionModel: "bounded-native-gpu-collision-volumes-v1",
		enabled: true,
		planeCount: 1,
		sphereCount: 1,
	})),
}));

vi.mock("babylonjs-editor-tools", () => toolMocks);

import { getParticleCollisionPlanes, getParticleCollisionSpheres, setParticleCollisionPlanes, setParticleCollisionSpheres } from "../../src/mcp/particles/collisions";

describe("mcp/particle-collisions", () => {
	let engine: NullEngine;
	let scene: Scene;
	let system: ParticleSystem;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		vi.clearAllMocks();
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

	test("configures GPU collision planes and spheres through the shared native backend", () => {
		const gpu: any = { id: "gpu-id", name: "GPU", getClassName: () => "GPUParticleSystem", dispose: vi.fn() };
		scene.particleSystems.push(gpu);

		const planes = setParticleCollisionPlanes(scene, { particleSystemId: gpu.id, planes: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.75 }] }, options);
		const spheres = setParticleCollisionSpheres(scene, { particleSystemId: gpu.id, spheres: [{ center: [1, 2, 3], radius: 4, restitution: 0.25 }] }, options);

		expect(toolMocks.configureGpuParticleCollisions).toHaveBeenLastCalledWith(gpu, planes.planes, spheres.spheres);
		expect(planes.runtime.nativeGpu).toBe(true);
		expect(spheres.runtime.backend).toBe("webgl2-transform-feedback");
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
	});

	test("rolls persisted GPU configuration back when native backend setup rejects", () => {
		const gpu: any = { id: "gpu-failure", name: "GPU Failure", getClassName: () => "GPUParticleSystem", dispose: vi.fn() };
		scene.particleSystems.push(gpu);
		toolMocks.configureGpuParticleCollisions.mockImplementationOnce(() => {
			throw new Error("shader mismatch");
		});

		expect(() => setParticleCollisionPlanes(scene, { particleSystemId: gpu.id, planes: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }] }, options)).toThrow(
			"shader mismatch"
		);
		expect(scene.metadata.babylonEditorParticleCollisionPlanes[gpu.id]).toBeUndefined();
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
	});

	test("prevents removing the final volume while native GPU collision events are enabled", () => {
		const gpu: any = { id: "gpu-events", name: "GPU Events", getClassName: () => "GPUParticleSystem", dispose: vi.fn() };
		scene.particleSystems.push(gpu);
		scene.metadata = {
			babylonEditorParticleCollisionPlanes: { [gpu.id]: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }] },
			babylonEditorGpuParticleCollisionEvents: { [gpu.id]: { enabled: true } },
		};
		expect(() => setParticleCollisionPlanes(scene, { particleSystemId: gpu.id, planes: [] }, options)).toThrow("Disable native GPU collision events");
		expect(scene.metadata.babylonEditorParticleCollisionPlanes[gpu.id]).toHaveLength(1);
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
	});
});

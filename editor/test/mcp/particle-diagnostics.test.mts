import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, ParticleSystem, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { deleteParticleSystem, setParticleSystemPlaying, validateParticleSystem } from "../../src/mcp/particles/particles";
import { OWNED_PARTICLE_EMITTER_METADATA_KEY } from "../../src/mcp/particles/emitter";

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

	test("starts and stops a particle system without implicit simulation", async () => {
		const started = await setParticleSystemPlaying(scene, { particleSystemId: system.id, playing: true });
		expect(started.isStarted).toBe(true);
		expect(started.simulation).toEqual({ requestedSteps: 0, executedSteps: 0, ready: false });
		const stopped = await setParticleSystemPlaying(scene, { particleSystemId: system.id, playing: false });
		expect(stopped.simulation.executedSteps).toBe(0);
	});

	test("executes every requested GPU simulation step despite Babylon's same-render-id suppression", async () => {
		const renderIds: number[] = [];
		const gpu: any = {
			id: "gpu-steps",
			name: "GPU Steps",
			emitter: system.emitter,
			_currentRenderId: 42,
			start: vi.fn(),
			isStarted: () => true,
			isReady: () => true,
			animate: vi.fn(),
			render: vi.fn(() => {
				renderIds.push(gpu._currentRenderId);
				gpu._currentRenderId = 42;
			}),
			getClassName: () => "GPUParticleSystem",
			getScene: () => scene,
			dispose: vi.fn(),
		};
		scene.particleSystems.push(gpu);
		const result = await setParticleSystemPlaying(scene, { particleSystemId: gpu.id, playing: true, simulationSteps: 3 });
		expect(result.simulation).toEqual({ requestedSteps: 3, executedSteps: 3, ready: true });
		expect(gpu.animate).toHaveBeenCalledTimes(3);
		expect(gpu.render).toHaveBeenCalledTimes(3);
		expect(renderIds).toEqual([-1, -1, -1]);
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
	});

	test("deletes a native system and cascades every persisted particle reference", () => {
		const target = new ParticleSystem("Target", 10, scene);
		for (const key of [
			"babylonEditorParticleCollisionPlanes",
			"babylonEditorParticleCollisionSpheres",
			"babylonEditorGpuParticleInteractions",
			"babylonEditorGpuParticleCollisionEvents",
			"babylonEditorParticleEvents",
			"babylonEditorParticleTextureVectorFields",
			"babylonEditorParticleVectorFields",
		]) {
			scene.metadata ??= {};
			scene.metadata[key] = { [system.id]: [{ persisted: true }] };
		}
		scene.metadata.babylonEditorParticleProximityEvents = {
			[system.id]: [{ targetParticleSystemId: target.id, radius: 1, count: 1 }],
			[target.id]: [{ targetParticleSystemId: system.id, radius: 1, count: 1 }],
		};
		const options = { editor: { layout: { graph: { refresh: vi.fn() }, inspector: { setEditedObject: vi.fn() } } } } as any;

		expect(deleteParticleSystem(scene, { particleSystemId: system.id }, options)).toEqual({ deleted: true, particleSystemId: system.id, particleSystemName: "Sparks" });
		expect(scene.particleSystems).not.toContain(system);
		for (const key of [
			"babylonEditorParticleCollisionPlanes",
			"babylonEditorParticleCollisionSpheres",
			"babylonEditorGpuParticleInteractions",
			"babylonEditorGpuParticleCollisionEvents",
			"babylonEditorParticleEvents",
			"babylonEditorParticleTextureVectorFields",
			"babylonEditorParticleVectorFields",
		]) {
			expect(scene.metadata[key][system.id]).toBeUndefined();
		}
		expect(scene.metadata.babylonEditorParticleProximityEvents[system.id]).toBeUndefined();
		expect(scene.metadata.babylonEditorParticleProximityEvents[target.id]).toEqual([]);
	});

	test("deletes an editor-owned emitter with its last particle system", () => {
		const emitter = system.emitter as any;
		emitter.metadata = { [OWNED_PARTICLE_EMITTER_METADATA_KEY]: true };
		const options = { editor: { layout: { graph: { refresh: vi.fn() }, inspector: { setEditedObject: vi.fn() } } } } as any;

		deleteParticleSystem(scene, { particleSystemId: system.id }, options);

		expect(scene.getNodeById(emitter.id)).toBeNull();
	});
});

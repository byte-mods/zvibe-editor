import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

const toolMocks = vi.hoisted(() => ({
	configureGpuParticleCollisionEvents: vi.fn(),
	configureGpuParticleCollisions: vi.fn(),
	getGpuParticleCollisionEventRuntimeEvidence: vi.fn(() => ({
		nativeGpu: true,
		backend: "webgl2-transform-feedback",
		executionModel: "bounded-webgl2-collision-event-texture-v1",
		enabled: false,
		supported: true,
		unsupportedReason: null,
		shaderInstalled: true,
		hooksInstalled: true,
		lastCompiledWithEvents: false,
		nativeDispatchCount: 0,
		maximumSourceParticles: 0,
		spawnCount: 0,
		reservedOutputParticles: 0,
		requiredParticleCapacity: 0,
		eventTextureReady: false,
		eventTextureSize: [0, 0, 0],
		eventCaptureCount: 0,
		eventCaptureInputCount: 0,
		collisionEventCandidateUpperBound: 0,
		gpuReadback: false,
		oneFrameLatency: true,
	})),
}));

vi.mock("babylonjs-editor-tools", () => toolMocks);

import { getGpuParticleCollisionEvents, setGpuParticleCollisionEvents } from "../../src/mcp/particles/gpu-collision-events";

describe("mcp/gpu-particle-collision-events", () => {
	let engine: NullEngine;
	let scene: Scene;
	let gpu: any;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		vi.clearAllMocks();
		engine = new NullEngine();
		scene = new Scene(engine);
		gpu = { id: "gpu-events", name: "GPU Events", getClassName: () => "GPUParticleSystem", getCapacity: () => 512 };
		scene.particleSystems.push(gpu);
	});

	afterEach(() => {
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
		scene.dispose();
		engine.dispose();
	});

	test("returns explicit defaults and exact native evidence", () => {
		const result = getGpuParticleCollisionEvents(scene, { particleSystemId: gpu.id });
		expect(result.configuration).toEqual({
			enabled: false,
			maximumSourceParticles: 128,
			spawnCount: 2,
			lifetime: 1,
			speed: 30,
			size: 5,
			inheritVelocity: 0.5,
			spread: 0.5,
			color: [1, 0.5, 0.1, 1],
		});
		expect(result.runtime).toMatchObject({ backend: "webgl2-transform-feedback", gpuReadback: false, oneFrameLatency: true });
	});

	test("persists and applies bounded output after a native collision volume exists", () => {
		scene.metadata = { babylonEditorParticleCollisionPlanes: { [gpu.id]: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }] } };
		const result = setGpuParticleCollisionEvents(
			scene,
			{
				particleSystemId: gpu.id,
				enabled: true,
				maximumSourceParticles: 64,
				spawnCount: 3,
				lifetime: 0.75,
				speed: 45,
				size: 6,
				inheritVelocity: 0.6,
				spread: 0.35,
				color: [1, 0.25, 0.1, 1],
			},
			options
		);
		expect(result.configuration).toMatchObject({ enabled: true, maximumSourceParticles: 64, spawnCount: 3 });
		expect(scene.metadata.babylonEditorGpuParticleCollisionEvents[gpu.id]).toEqual(result.configuration);
		expect(toolMocks.configureGpuParticleCollisions).toHaveBeenCalledOnce();
		expect(toolMocks.configureGpuParticleCollisionEvents).toHaveBeenCalledWith(gpu, result.configuration);
		expect(options.editor.layout.inspector.setEditedObject).toHaveBeenCalledWith(gpu);
	});

	test("rejects missing volumes, unsafe capacity, invalid values, and unknown settings", () => {
		expect(() => setGpuParticleCollisionEvents(scene, { particleSystemId: gpu.id, enabled: true }, options)).toThrow("collision plane or sphere");
		scene.metadata.babylonEditorParticleCollisionSpheres = { [gpu.id]: [{ center: [0, 0, 0], radius: 10, restitution: 0.5 }] };
		expect(() => setGpuParticleCollisionEvents(scene, { particleSystemId: gpu.id, maximumSourceParticles: 200, spawnCount: 2 }, options)).toThrow("capacity 600");
		expect(() => setGpuParticleCollisionEvents(scene, { particleSystemId: gpu.id, spread: 2 }, options)).toThrow("spread");
		expect(() => setGpuParticleCollisionEvents(scene, { particleSystemId: gpu.id, arbitrary: true }, options)).toThrow("Unknown");
	});

	test("rolls metadata back when native resource setup fails", () => {
		scene.metadata = { babylonEditorParticleCollisionPlanes: { [gpu.id]: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }] } };
		toolMocks.configureGpuParticleCollisionEvents.mockImplementationOnce(() => {
			throw new Error("float event framebuffer unavailable");
		});
		expect(() => setGpuParticleCollisionEvents(scene, { particleSystemId: gpu.id, enabled: true }, options)).toThrow("float event framebuffer unavailable");
		expect(scene.metadata.babylonEditorGpuParticleCollisionEvents[gpu.id]).toBeUndefined();
	});
});

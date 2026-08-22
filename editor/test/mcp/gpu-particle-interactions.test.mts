import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, ParticleSystem, Scene } from "babylonjs";

const toolMocks = vi.hoisted(() => ({
	configureGpuParticleInteractions: vi.fn(),
	getGpuParticleInteractionRuntimeEvidence: vi.fn(() => ({
		nativeGpu: true,
		backend: "webgl2-transform-feedback",
		executionModel: "bounded-webgl2-occupancy-field-collision-v1",
		enabled: true,
		supported: true,
		unsupportedReason: null,
		shaderInstalled: true,
		hooksInstalled: true,
		lastCompiledWithInteractions: false,
		nativeDispatchCount: 0,
		configuredMaximumParticles: 256,
		configuredMaximumNeighbors: 12,
		activeParticleLimit: 0,
		pairTestUpperBound: 0,
		occupancyFieldReady: true,
		occupancyGridResolution: 32,
		occupancyTextureSize: [1024, 32],
		occupancyBuildCount: 1,
		occupancyInputParticleCount: 32,
		occupancySampleUpperBound: 864,
		occupancyNeighborStencil: "3x3x3",
	})),
}));

vi.mock("babylonjs-editor-tools", () => toolMocks);

import { getGpuParticleInteractions, setGpuParticleInteractions } from "../../src/mcp/particles/gpu-interactions";

describe("mcp/gpu-particle-interactions", () => {
	let engine: NullEngine;
	let scene: Scene;
	let gpu: any;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		vi.clearAllMocks();
		engine = new NullEngine();
		scene = new Scene(engine);
		gpu = { id: "gpu-id", name: "GPU Sparks", getClassName: () => "GPUParticleSystem", dispose: vi.fn() };
		scene.particleSystems.push(gpu);
	});

	afterEach(() => {
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
		scene.dispose();
		engine.dispose();
	});

	test("returns explicit defaults and native WebGL2 occupancy support evidence before authoring", () => {
		const result = getGpuParticleInteractions(scene, { particleSystemId: gpu.id });
		expect(result.configuration).toEqual({
			enabled: false,
			radius: 10,
			restitution: 0.5,
			separationStrength: 1,
			maximumParticles: 1024,
			maximumNeighbors: 16,
			boundsMin: [-500, -500, -500],
			boundsMax: [500, 500, 500],
			gridResolution: 32,
		});
		expect(result.runtime).toMatchObject({ backend: "webgl2-transform-feedback", supported: true, hooksInstalled: true, occupancyFieldReady: true });
	});

	test("merges, persists, and applies a bounded native WebGPU target configuration", () => {
		const result = setGpuParticleInteractions(
			scene,
			{
				particleSystemId: gpu.id,
				enabled: true,
				radius: 25,
				restitution: 0.8,
				separationStrength: 0.7,
				maximumParticles: 256,
				maximumNeighbors: 12,
				boundsMin: [-200, -100, -200],
				boundsMax: [200, 300, 200],
				gridResolution: 24,
			},
			options
		);
		expect(result.configuration).toEqual({
			enabled: true,
			radius: 25,
			restitution: 0.8,
			separationStrength: 0.7,
			maximumParticles: 256,
			maximumNeighbors: 12,
			boundsMin: [-200, -100, -200],
			boundsMax: [200, 300, 200],
			gridResolution: 24,
		});
		expect(scene.metadata.babylonEditorGpuParticleInteractions[gpu.id]).toEqual(result.configuration);
		expect(toolMocks.configureGpuParticleInteractions).toHaveBeenCalledWith(gpu, result.configuration);
		expect(options.editor.layout.inspector.setEditedObject).toHaveBeenCalledWith(gpu);
	});

	test("rejects invalid physical and workload bounds before persistence", () => {
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, radius: 0 }, options)).toThrow("radius");
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, restitution: 1.1 }, options)).toThrow("restitution");
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, separationStrength: -0.1 }, options)).toThrow("separationStrength");
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, maximumParticles: 4097 }, options)).toThrow("maximumParticles");
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, maximumParticles: 8, maximumNeighbors: 8 }, options)).toThrow("less than maximumParticles");
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, boundsMin: [0, 0, 0], boundsMax: [1, 0, 1] }, options)).toThrow("greater than min on axis 1");
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, gridResolution: 65 }, options)).toThrow("gridResolution");
		expect(scene.metadata.babylonEditorGpuParticleInteractions[gpu.id]).toBeUndefined();
		expect(toolMocks.configureGpuParticleInteractions).not.toHaveBeenCalled();
	});

	test("rejects CPU systems and atomically rolls metadata back after native setup failure", () => {
		const cpu = new ParticleSystem("CPU", 10, scene);
		expect(() => getGpuParticleInteractions(scene, { particleSystemId: cpu.id })).toThrow("require a GPU particle system");

		toolMocks.configureGpuParticleInteractions.mockImplementationOnce(() => {
			throw new Error("WGSL layout mismatch");
		});
		expect(() => setGpuParticleInteractions(scene, { particleSystemId: gpu.id, enabled: true }, options)).toThrow("WGSL layout mismatch");
		expect(scene.metadata.babylonEditorGpuParticleInteractions[gpu.id]).toBeUndefined();
	});
});

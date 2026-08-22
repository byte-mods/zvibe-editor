import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";

const toolMocks = vi.hoisted(() => ({
	configureGpuParticleTextureVectorFields: vi.fn(),
	getGpuParticleTextureVectorFieldRuntimeEvidence: vi.fn(() => ({
		nativeGpu: true,
		backend: "webgl2-transform-feedback",
		executionModel: "native-gpu-rgba8-3d-vector-field-atlas-v1",
		enabled: true,
		supported: true,
		unsupportedReason: null,
		shaderInstalled: true,
		hooksInstalled: true,
		lastCompiledWithVectorFields: false,
		nativeDispatchCount: 0,
		fieldCount: 1,
		atlasReady: true,
		atlasDimensions: [2, 1, 2],
		atlasVoxelCount: 4,
		activeParticleCount: 0,
		sampleUpperBound: 0,
		sampling: "trilinear-3d",
		encoding: "rgba8-signed-vector-with-per-field-scale",
		gpuReadback: false,
	})),
}));

vi.mock("babylonjs-editor-tools", () => toolMocks);

import { projectConfiguration } from "../../src/project/configuration";
import { createParticleTextureVectorField, getParticleTextureVectorFields, setParticleTextureVectorFields } from "../../src/mcp/particles/texture-vector-fields";

const field = {
	min: [-10, -10, -10],
	max: [10, 10, 10],
	strength: 5,
	width: 2,
	height: 1,
	depth: 2,
	vectors: [1, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0],
	sourcePath: "assets/wind-0.png",
	enabled: true,
};

describe("mcp/gpu-particle-texture-vector-fields", () => {
	let engine: NullEngine;
	let scene: Scene;
	let gpu: any;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		vi.clearAllMocks();
		engine = new NullEngine();
		scene = new Scene(engine);
		gpu = { id: "gpu-vector", name: "GPU Vector", getClassName: () => "GPUParticleSystem" };
		scene.particleSystems.push(gpu);
	});

	afterEach(() => {
		scene.particleSystems.splice(scene.particleSystems.indexOf(gpu), 1);
		scene.dispose();
		engine.dispose();
	});

	test("persists and applies portable depth grids to native GPU particles", () => {
		const result = setParticleTextureVectorFields(scene, { particleSystemId: gpu.id, fields: [field] }, options);
		expect(scene.metadata.babylonEditorParticleTextureVectorFields[gpu.id]).toEqual([field]);
		expect(toolMocks.configureGpuParticleTextureVectorFields).toHaveBeenCalledWith(gpu, [field]);
		expect(result).toMatchObject({
			particleSystemId: gpu.id,
			particleSystemName: gpu.name,
			fields: [field],
			runtime: { backend: "webgl2-transform-feedback", atlasDimensions: [2, 1, 2], gpuReadback: false },
		});
		expect(options.editor.layout.inspector.setEditedObject).toHaveBeenCalledWith(gpu);
	});

	test("rolls native runtime and metadata back when replacement upload fails", () => {
		setParticleTextureVectorFields(scene, { particleSystemId: gpu.id, fields: [field] }, options);
		toolMocks.configureGpuParticleTextureVectorFields.mockImplementationOnce(() => {
			throw new Error("3D texture limit exceeded");
		});
		expect(() => setParticleTextureVectorFields(scene, { particleSystemId: gpu.id, fields: [{ ...field, strength: 9 }] }, options)).toThrow("3D texture limit exceeded");
		expect(scene.metadata.babylonEditorParticleTextureVectorFields[gpu.id]).toEqual([field]);
		expect(toolMocks.configureGpuParticleTextureVectorFields).toHaveBeenLastCalledWith(gpu, [field]);
	});

	test("imports ordered RGB image slices and uploads the embedded 3D grid to the GPU", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-gpu-vector-field-"));
		const previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		try {
			const first = join(directory, "wind-0.png");
			const second = join(directory, "wind-1.png");
			await sharp(Buffer.from([255, 128, 0, 255]), { raw: { width: 1, height: 1, channels: 4 } })
				.png()
				.toFile(first);
			await sharp(Buffer.from([128, 255, 128, 255]), { raw: { width: 1, height: 1, channels: 4 } })
				.png()
				.toFile(second);
			const result = await createParticleTextureVectorField(
				scene,
				{ particleSystemId: gpu.id, sourcePaths: [first, second], min: [-1, -1, -1], max: [1, 1, 1], strength: 4, width: 1, height: 1 },
				options
			);
			expect(result.fields[0]).toMatchObject({ width: 1, height: 1, depth: 2, strength: 4, sourcePath: "wind-0.png" });
			expect(result.fields[0].vectors).toHaveLength(6);
			expect(result.fields[0].vectors[0]).toBe(1);
			expect(result.fields[0].vectors[2]).toBe(-1);
			expect(toolMocks.configureGpuParticleTextureVectorFields).toHaveBeenCalledWith(gpu, result.fields);
		} finally {
			projectConfiguration.path = previousPath;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects malformed grids before native resource mutation", () => {
		expect(() => setParticleTextureVectorFields(scene, { particleSystemId: gpu.id, fields: [{ ...field, depth: 3 }] }, options)).toThrow("exactly");
		expect(() => setParticleTextureVectorFields(scene, { particleSystemId: gpu.id, fields: [{ ...field, enabled: "yes" }] }, options)).toThrow("enabled must be a boolean");
		expect(toolMocks.configureGpuParticleTextureVectorFields).not.toHaveBeenCalled();
	});
});

import { describe, expect, test, vi } from "vitest";

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

const textureState = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock("@babylonjs/core/Materials/Textures/rawTexture3D", () => ({
	RawTexture3D: class {
		public name = "";
		public wrapU = 0;
		public wrapV = 0;
		public wrapR = 0;
		public disposed = false;

		public constructor(
			public data: Uint8Array,
			public width: number,
			public height: number,
			public depth: number
		) {
			textureState.instances.push(this);
		}

		public isReady(): boolean {
			return true;
		}

		public dispose(): void {
			this.disposed = true;
		}
	},
}));

import {
	buildGpuParticleTextureVectorFieldAtlas,
	configureGpuParticleTextureVectorFields,
	getGpuParticleTextureVectorFieldRuntimeEvidence,
	installGpuParticleTextureVectorFieldShaders,
} from "../../src/loading/gpu-particle-texture-vector-fields";

const fields = [
	{
		min: [-10, -20, -30],
		max: [10, 20, 30],
		strength: 2,
		width: 2,
		height: 1,
		depth: 2,
		vectors: [2, 0, -2, 0, 1, 0, -1, 0, 1, 0.5, -0.5, 0],
		sourcePath: "assets/wind-0.png",
	},
];

function createWebGpuSystem(): { system: any; platform: any; layout: string[]; values: Map<string, unknown>; dispatches: number[]; textures: any[] } {
	const layout: string[] = [];
	const values = new Map<string, unknown>();
	const dispatches: number[] = [];
	const textures: any[] = [];
	const platform: any = {
		createUpdateBuffer(defines: string) {
			this.compiledDefines = defines;
			this._simParamsComputeShader = { addUniform: (name: string) => layout.push(name) };
			this._updateComputeShader = {
				options: { bindingsMapping: {} },
				setTexture: (name: string, texture: unknown) => textures.push([name, texture]),
			};
			return {};
		},
		updateParticleBuffer(_index: number, _target: unknown, count: number) {
			dispatches.push(count);
		},
		isUpdateBufferCreated: () => true,
		isUpdateBufferReady: () => true,
	};
	const system: any = {
		id: "gpu-vector-field",
		name: "GPU Wind",
		_platform: platform,
		_currentActiveCount: 24,
		_updateBuffer: {
			setInt: (name: string, value: number) => values.set(name, value),
			setFloat3: (name: string, ...value: number[]) => values.set(name, value),
			setFloat4: (name: string, ...value: number[]) => values.set(name, value),
		},
		_resetEffect: vi.fn(),
		getClassName: () => "GPUParticleSystem",
		getScene: () => ({ getEngine: () => ({ isWebGPU: true, _device: { limits: { maxTextureDimension3D: 2048 } } }) }),
		onDisposeObservable: { addOnce: vi.fn() },
	};
	return { system, platform, layout, values, dispatches, textures };
}

describe("loading/gpu-particle-texture-vector-fields", () => {
	test("packs differently sized depth stacks into one bounded signed-vector 3D atlas", () => {
		const atlas = buildGpuParticleTextureVectorFieldAtlas([
			...fields,
			{ min: [0, 0, 0], max: [1, 1, 1], strength: 1, width: 1, height: 2, depth: 1, vectors: [0, 0, 0, 1, -1, 0], sourcePath: "second.png" },
		]);
		expect(atlas).toMatchObject({ width: 2, height: 2, depth: 3 });
		expect(atlas?.data).toHaveLength(2 * 2 * 3 * 4);
		expect(atlas?.descriptors).toEqual([
			{ min: [-10, -20, -30], inverseSize: [0.05, 0.025, 1 / 60], resolutionOffset: [2, 1, 2, 0], strengthScale: 4 },
			{ min: [0, 0, 0], inverseSize: [1, 1, 1], resolutionOffset: [1, 2, 1, 2], strengthScale: 1 },
		]);
		expect(atlas?.data.slice(0, 4)).toEqual(new Uint8Array([255, 128, 0, 255]));
	});

	test("injects native sampler3D/texture_3d code exactly once", () => {
		installGpuParticleTextureVectorFieldShaders();
		installGpuParticleTextureVectorFieldShaders();
		const glsl = ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader;
		const wgsl = ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader;
		expect(glsl).toContain("ZVIBE_NATIVE_WEBGL2_TEXTURE_3D_VECTOR_FIELD_V1");
		expect(glsl).toContain("uniform sampler3D zvibeTextureVectorFieldAtlas");
		expect(wgsl).toContain("ZVIBE_NATIVE_WEBGPU_TEXTURE_3D_VECTOR_FIELD_V1");
		expect(wgsl).toContain("zvibeTextureVectorFieldAtlas : texture_3d<f32>");
		expect(glsl.match(/ZVIBE_NATIVE_WEBGL2_TEXTURE_3D_VECTOR_FIELD_V1/g)).toHaveLength(1);
		expect(wgsl.match(/ZVIBE_NATIVE_WEBGPU_TEXTURE_3D_VECTOR_FIELD_V1/g)).toHaveLength(1);
	});

	test("binds and samples the atlas in a native WebGPU update with exact no-readback evidence", () => {
		const { system, platform, layout, values, dispatches, textures } = createWebGpuSystem();
		configureGpuParticleTextureVectorFields(system, fields);
		platform.createUpdateBuffer("#define BASE");
		platform.updateParticleBuffer(0, {}, 24);

		expect(platform.compiledDefines).toContain("#define ZVIBE_GPU_TEXTURE_VECTOR_FIELDS");
		expect(platform._updateComputeShader.options.bindingsMapping.zvibeTextureVectorFieldAtlas).toEqual({ group: 1, binding: 17 });
		expect(layout).toContain("zvibeTextureVectorFieldAtlasInverseSize");
		expect(values.get("zvibeTextureVectorFieldCount")).toBe(1);
		expect(values.get("zvibeTextureVectorFieldAtlasInverseSize")).toEqual([0.5, 1, 0.5]);
		expect(textures[0][0]).toBe("zvibeTextureVectorFieldAtlas");
		expect(dispatches).toEqual([24]);
		expect(getGpuParticleTextureVectorFieldRuntimeEvidence(system)).toMatchObject({
			backend: "webgpu-compute",
			executionModel: "native-gpu-rgba8-3d-vector-field-atlas-v1",
			enabled: true,
			fieldCount: 1,
			atlasReady: true,
			atlasDimensions: [2, 1, 2],
			atlasVoxelCount: 4,
			activeParticleCount: 24,
			sampleUpperBound: 24,
			nativeDispatchCount: 1,
			gpuReadback: false,
		});
	});

	test("disposes replaced atlases and rejects invalid portable grids before publication", () => {
		textureState.instances.length = 0;
		const { system } = createWebGpuSystem();
		configureGpuParticleTextureVectorFields(system, fields);
		const first = textureState.instances[0];
		configureGpuParticleTextureVectorFields(system, [{ ...fields[0], strength: 3 }]);
		expect(first.disposed).toBe(true);
		expect(() => configureGpuParticleTextureVectorFields(system, [{ ...fields[0], vectors: [] }])).toThrow("exactly");
		expect(() => buildGpuParticleTextureVectorFieldAtlas([{ ...fields[0], enabled: "yes" } as any])).toThrow("enabled must be a boolean");
		expect(getGpuParticleTextureVectorFieldRuntimeEvidence(system)).toMatchObject({ enabled: true, fieldCount: 1 });
	});
});

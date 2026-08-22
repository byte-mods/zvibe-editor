import { describe, expect, test, vi } from "vitest";

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";

import { configureGpuParticleCollisions, getGpuParticleCollisionRuntimeEvidence, installGpuParticleCollisionShaders } from "../../src/loading/gpu-particle-collisions";
import { configureGpuParticleInteractions, getGpuParticleInteractionRuntimeEvidence, installGpuParticleInteractionShader } from "../../src/loading/gpu-particle-interactions";
import { configureParticleInteractions } from "../../src/loading/particle-interactions";

const interactionConfiguration = {
	enabled: true,
	radius: 12,
	restitution: 0.75,
	separationStrength: 0.6,
	maximumParticles: 256,
	maximumNeighbors: 24,
	boundsMin: [-100, -100, -100],
	boundsMax: [100, 100, 100],
	gridResolution: 16,
};

function createWebGpuSystem(): { system: any; platform: any; compiled: { defines: string }; layout: string[]; values: Map<string, number>; updates: number[] } {
	const compiled = { defines: "" };
	const layout: string[] = [];
	const values = new Map<string, number>();
	const updates: number[] = [];
	const platform: any = {
		createUpdateBuffer(defines: string) {
			compiled.defines = defines;
			this._simParamsComputeShader = { addUniform: (name: string) => layout.push(name) };
			return {};
		},
		updateParticleBuffer(_index: number, _target: unknown, count: number) {
			updates.push(count);
		},
	};
	const system: any = {
		_platform: platform,
		_currentActiveCount: 32,
		_updateBuffer: {
			setFloat: (name: string, value: number) => values.set(name, value),
			setInt: (name: string, value: number) => values.set(name, value),
			setFloat4: () => undefined,
		},
		_resetEffect: () => undefined,
		getClassName: () => "GPUParticleSystem",
		getScene: () => ({ getEngine: () => ({ isWebGPU: true }) }),
	};
	return { system, platform, compiled, layout, values, updates };
}

describe("loading/particle-interactions", () => {
	test("injects bounded pairwise WebGPU code once after Babylon's complete native uniform layout", () => {
		installGpuParticleCollisionShaders();
		installGpuParticleInteractionShader();
		const wgsl = ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader;
		const gravityIndex = wgsl.indexOf("gravity : vec3<f32>,");
		const collisionIndex = wgsl.indexOf("ZVIBE_NATIVE_GPU_COLLISION_VOLUMES_V1");
		const interactionIndex = wgsl.indexOf("ZVIBE_NATIVE_WEBGPU_PAIRWISE_PARTICLE_COLLISION_V1");
		const uniformEndIndex = wgsl.indexOf("};@binding(0) @group(0) var<uniform> params : SimParams;");

		expect(gravityIndex).toBeGreaterThan(0);
		expect(collisionIndex).toBeGreaterThan(gravityIndex);
		expect(interactionIndex).toBeGreaterThan(collisionIndex);
		expect(uniformEndIndex).toBeGreaterThan(interactionIndex);
		expect(wgsl).toContain("if (i32(index)<params.zvibeInteractionMaximumParticles)");
		expect(wgsl).toContain("particlesIn.particles[zvibeInteractionOtherIndex].age+timeDelta");
		expect(wgsl).toContain("zvibeInteractionNeighborCount>=params.zvibeInteractionMaximumNeighbors");
		const glsl = ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader;
		expect(glsl).toContain("ZVIBE_NATIVE_WEBGL2_OCCUPANCY_FIELD_COLLISION_V1");
		expect(glsl).toContain("texelFetch(zvibeInteractionOccupancySampler");
		expect(glsl).toContain("zvibeInteractionZ=-1; zvibeInteractionZ<=1");
		installGpuParticleInteractionShader();
		expect(ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader.match(/ZVIBE_NATIVE_WEBGPU_PAIRWISE_PARTICLE_COLLISION_V1/g)).toHaveLength(1);
		expect(ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader.match(/ZVIBE_NATIVE_WEBGL2_OCCUPANCY_FIELD_COLLISION_V1/g)).toHaveLength(1);
	});

	test("composes collision-volume and pairwise WebGPU hooks with matching custom UBO order", () => {
		const { system, platform, compiled, layout, values, updates } = createWebGpuSystem();
		configureGpuParticleCollisions(system, [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }], []);
		configureGpuParticleInteractions(system, interactionConfiguration);
		platform.createUpdateBuffer("#define BASE");
		platform.updateParticleBuffer(0, null, 32);

		expect(compiled.defines).toContain("#define ZVIBE_GPU_COLLISIONS");
		expect(compiled.defines).toContain("#define ZVIBE_GPU_PARTICLE_INTERACTIONS");
		expect(layout.indexOf("zvibeCollisionPlaneCount")).toBeLessThan(layout.indexOf("zvibeInteractionRadius"));
		expect(layout.slice(-5)).toEqual([
			"zvibeInteractionRadius",
			"zvibeInteractionRestitution",
			"zvibeInteractionSeparationStrength",
			"zvibeInteractionMaximumParticles",
			"zvibeInteractionMaximumNeighbors",
		]);
		expect(values.get("zvibeInteractionRadius")).toBe(12);
		expect(values.get("zvibeInteractionRestitution")).toBe(0.75);
		expect(values.get("zvibeInteractionSeparationStrength")).toBe(0.6);
		expect(values.get("zvibeInteractionMaximumParticles")).toBe(256);
		expect(values.get("zvibeInteractionMaximumNeighbors")).toBe(24);
		expect(updates).toEqual([32]);
		expect(getGpuParticleCollisionRuntimeEvidence(system).nativeDispatchCount).toBe(1);
		expect(getGpuParticleInteractionRuntimeEvidence(system)).toMatchObject({
			nativeGpu: true,
			backend: "webgpu-compute",
			executionModel: "bounded-webgpu-pairwise-particle-collision-v1",
			enabled: true,
			supported: true,
			hooksInstalled: true,
			lastCompiledWithInteractions: true,
			nativeDispatchCount: 1,
			activeParticleLimit: 32,
			pairTestUpperBound: 992,
		});
	});

	test("rejects enabled occupancy interaction on a non-WebGL2 backend without installing a CPU fallback", () => {
		const platform: any = {
			_updateEffectOptions: { uniformsNames: [], samplers: [] },
			_baseUniformsNamesLength: 0,
			createUpdateBuffer: () => ({}),
			updateParticleBuffer: () => undefined,
		};
		const system: any = {
			id: "gpu-webgl",
			_platform: platform,
			_resetEffect: () => undefined,
			getClassName: () => "GPUParticleSystem",
			getScene: () => ({ getEngine: () => ({ isWebGPU: false, webGLVersion: 1 }) }),
		};
		expect(() => configureGpuParticleInteractions(system, interactionConfiguration)).toThrow("require a WebGL2 engine");
		const evidence = configureGpuParticleInteractions(system, { ...interactionConfiguration, enabled: false });
		expect(evidence).toMatchObject({
			backend: "webgl2-transform-feedback",
			enabled: false,
			supported: false,
			hooksInstalled: true,
			nativeDispatchCount: 0,
		});
		expect(evidence.unsupportedReason).toContain("require WebGL2");
	});

	test("builds and samples a bounded GPU-only WebGL2 occupancy field before transform feedback", () => {
		const drawArrays = vi.fn();
		const texture = {
			name: "",
			_texture: { _hardwareTexture: { underlyingResource: {} } },
			dispose: vi.fn(),
			isReady: () => true,
		};
		const textureSpy = vi.spyOn(RawTexture, "CreateRGBATexture").mockReturnValue(texture as any);
		let attributeIndex = 0;
		const gl: any = {
			FRAMEBUFFER: 1,
			FRAMEBUFFER_BINDING: 2,
			COLOR_ATTACHMENT0: 3,
			TEXTURE_2D: 4,
			FRAMEBUFFER_COMPLETE: 5,
			VERTEX_SHADER: 6,
			FRAGMENT_SHADER: 7,
			COMPILE_STATUS: 8,
			LINK_STATUS: 9,
			VIEWPORT: 10,
			SCISSOR_TEST: 11,
			BLEND: 12,
			DEPTH_TEST: 13,
			CULL_FACE: 14,
			RASTERIZER_DISCARD: 15,
			COLOR_WRITEMASK: 16,
			COLOR_CLEAR_VALUE: 17,
			BLEND_SRC_RGB: 18,
			BLEND_DST_RGB: 19,
			BLEND_SRC_ALPHA: 20,
			BLEND_DST_ALPHA: 21,
			BLEND_EQUATION_RGB: 22,
			BLEND_EQUATION_ALPHA: 23,
			COLOR_BUFFER_BIT: 24,
			FUNC_ADD: 25,
			ONE: 26,
			ARRAY_BUFFER: 27,
			FLOAT: 28,
			POINTS: 29,
			createFramebuffer: () => ({}),
			bindFramebuffer: () => undefined,
			framebufferTexture2D: () => undefined,
			checkFramebufferStatus: () => 5,
			deleteFramebuffer: () => undefined,
			createShader: () => ({}),
			shaderSource: () => undefined,
			compileShader: () => undefined,
			getShaderParameter: () => true,
			getShaderInfoLog: () => "",
			deleteShader: () => undefined,
			createProgram: () => ({}),
			attachShader: () => undefined,
			linkProgram: () => undefined,
			getProgramParameter: () => true,
			getProgramInfoLog: () => "",
			deleteProgram: () => undefined,
			getAttribLocation: () => attributeIndex++,
			getUniformLocation: () => ({}),
			getParameter(parameter: number) {
				if (parameter === this.VIEWPORT) return [0, 0, 800, 600];
				if (parameter === this.COLOR_WRITEMASK) return [true, true, true, true];
				if (parameter === this.COLOR_CLEAR_VALUE) return [0, 0, 0, 0];
				if (parameter === this.FRAMEBUFFER_BINDING) return null;
				if (parameter === this.BLEND_EQUATION_RGB || parameter === this.BLEND_EQUATION_ALPHA) return this.FUNC_ADD;
				return this.ONE;
			},
			isEnabled: () => false,
			createVertexArray: () => ({}),
			deleteVertexArray: () => undefined,
			bindVertexArray: () => undefined,
			bindBuffer: () => undefined,
			enableVertexAttribArray: () => undefined,
			vertexAttribPointer: () => undefined,
			viewport: () => undefined,
			disable: () => undefined,
			enable: () => undefined,
			colorMask: () => undefined,
			clearColor: () => undefined,
			clear: () => undefined,
			blendEquation: () => undefined,
			blendFunc: () => undefined,
			useProgram: () => undefined,
			uniform3fv: () => undefined,
			uniform3f: () => undefined,
			uniform1f: () => undefined,
			drawArrays,
			blendEquationSeparate: () => undefined,
			blendFuncSeparate: () => undefined,
		};
		const engine: any = {
			isWebGPU: false,
			webGLVersion: 2,
			_gl: gl,
			getCaps: () => ({ maxTextureSize: 4096 }),
			wipeCaches: vi.fn(),
			enableEffect: vi.fn(),
		};
		const updateEffect = { setTexture: vi.fn() };
		const compiled = { defines: "" };
		const values = new Map<string, unknown>();
		const platform: any = {
			_updateEffectOptions: { uniformsNames: [], samplers: [] },
			_baseUniformsNamesLength: 0,
			createUpdateBuffer(defines: string) {
				compiled.defines = defines;
				this._updateEffect = updateEffect;
				return {};
			},
			updateParticleBuffer: vi.fn(),
		};
		const scene = { getEngine: () => engine };
		const system: any = {
			id: "webgl2-gpu",
			name: "WebGL2 GPU",
			_platform: platform,
			_currentActiveCount: 10,
			_attributesStrideSize: 21,
			_sourceBuffer: { getBuffer: () => ({ underlyingResource: {} }) },
			_updateBuffer: {
				setFloat: (name: string, value: number) => values.set(name, value),
				setInt: (name: string, value: number) => values.set(name, value),
				setFloat3: (name: string, ...value: number[]) => values.set(name, value),
			},
			_resetEffect: () => undefined,
			getClassName: () => "GPUParticleSystem",
			getScene: () => scene,
			onDisposeObservable: { addOnce: () => undefined },
		};
		try {
			const configured = configureGpuParticleInteractions(system, interactionConfiguration);
			platform.createUpdateBuffer("#define BASE");
			platform.updateParticleBuffer(0, null, 10);
			const evidence = getGpuParticleInteractionRuntimeEvidence(system);
			expect(configured).toMatchObject({
				backend: "webgl2-transform-feedback",
				executionModel: "bounded-webgl2-occupancy-field-collision-v1",
				enabled: true,
				supported: true,
				occupancyFieldReady: true,
				occupancyTextureSize: [256, 16],
			});
			expect(compiled.defines).toContain("#define ZVIBE_GPU_PARTICLE_INTERACTIONS");
			expect(platform._updateEffectOptions.samplers).toContain("zvibeInteractionOccupancySampler");
			expect(drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 10);
			expect(updateEffect.setTexture).toHaveBeenCalledWith("zvibeInteractionOccupancySampler", texture);
			expect(values.get("zvibeInteractionBoundsMin")).toEqual([-100, -100, -100]);
			expect(evidence).toMatchObject({
				lastCompiledWithInteractions: true,
				nativeDispatchCount: 1,
				occupancyBuildCount: 1,
				occupancyInputParticleCount: 10,
				occupancySampleUpperBound: 270,
				occupancyNeighborStencil: "3x3x3",
			});
		} finally {
			textureSpy.mockRestore();
		}
	});

	test("restores persisted configurations and disables the native define through a rebuild", () => {
		const { system, platform, compiled } = createWebGpuSystem();
		system.id = "restored-gpu";
		const scene: any = {
			metadata: { babylonEditorGpuParticleInteractions: { [system.id]: interactionConfiguration } },
			particleSystems: [system],
		};
		configureParticleInteractions(scene);
		platform.createUpdateBuffer("");
		expect(compiled.defines).toContain("ZVIBE_GPU_PARTICLE_INTERACTIONS");

		configureGpuParticleInteractions(system, { ...interactionConfiguration, enabled: false });
		platform.createUpdateBuffer("");
		expect(compiled.defines).not.toContain("ZVIBE_GPU_PARTICLE_INTERACTIONS");
		expect(getGpuParticleInteractionRuntimeEvidence(system).enabled).toBe(false);
	});
});

import { describe, expect, test } from "vitest";

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { NullEngine, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";

import { configureParticleCollisions } from "../../src/loading/particle-collisions";
import { configureGpuParticleCollisions, getGpuParticleCollisionRuntimeEvidence, installGpuParticleCollisionShaders } from "../../src/loading/gpu-particle-collisions";

describe("loading/particle-collisions", () => {
	test("restores CPU particle plane collisions in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const system = new ParticleSystem("Particles", 10, scene);
		scene.metadata = { babylonEditorParticleCollisionPlanes: { [system.id]: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 1 }] } };
		(system.particles as any[]).push({ position: new Vector3(0, -2, 0), direction: new Vector3(0, -3, 0) });

		configureParticleCollisions(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		const particle = (system.particles as any[])[0];
		expect(particle.position.y).toBe(0);
		expect(particle.direction.y).toBe(3);
		scene.dispose();
		engine.dispose();
	});

	test("injects guarded native collision code into GLSL and WGSL exactly once", () => {
		installGpuParticleCollisionShaders();
		const glsl = ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader;
		const wgsl = ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader;
		expect(glsl).toContain("ZVIBE_NATIVE_GPU_COLLISION_VOLUMES_V1");
		expect(glsl).toContain("zvibeCollisionPosition=outPosition");
		expect(wgsl).toContain("ZVIBE_NATIVE_GPU_COLLISION_VOLUMES_V1");
		expect(wgsl).toContain("particlesOut.particles[index].position=zvibeCollisionPosition");
		installGpuParticleCollisionShaders();
		expect(ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader.match(/ZVIBE_NATIVE_GPU_COLLISION_VOLUMES_V1/g)).toHaveLength(1);
		expect(ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader.match(/ZVIBE_NATIVE_GPU_COLLISION_VOLUMES_V1/g)).toHaveLength(1);
	});

	test("hooks WebGL2 transform feedback with native defines and bounded uniforms", () => {
		let compiledDefines = "";
		let updateCount = 0;
		const values = new Map<string, number[]>();
		const platform: any = {
			_updateEffectOptions: { uniformsNames: [] },
			_baseUniformsNamesLength: 0,
			createUpdateBuffer(defines: string) {
				compiledDefines = defines;
				return {};
			},
			updateParticleBuffer() {
				updateCount++;
			},
		};
		const system: any = {
			_platform: platform,
			_updateBuffer: {
				setInt: (name: string, value: number) => values.set(name, [value]),
				setFloat4: (name: string, ...value: number[]) => values.set(name, value),
			},
			_resetEffect: () => undefined,
			getClassName: () => "GPUParticleSystem",
			getScene: () => ({ getEngine: () => ({ isWebGPU: false }) }),
		};

		const result = configureGpuParticleCollisions(
			system,
			[{ position: [0, 2, 0], normal: [0, 1, 0], restitution: 0.75 }],
			[{ center: [1, 2, 3], radius: 4, restitution: 0.25 }]
		);
		platform.createUpdateBuffer("#define BASE");
		platform.updateParticleBuffer(0, null, 10);

		expect(result).toMatchObject({
			nativeGpu: true,
			backend: "webgl2-transform-feedback",
			executionModel: "bounded-native-gpu-collision-volumes-v1",
			enabled: true,
			planeCount: 1,
			sphereCount: 1,
			shaderInstalled: true,
			hooksInstalled: true,
		});
		expect(compiledDefines).toContain("#define ZVIBE_GPU_COLLISIONS");
		expect(platform._updateEffectOptions.uniformsNames).toContain("zvibeCollisionPlanePositionRestitution0");
		expect(values.get("zvibeCollisionPlanePositionRestitution0")).toEqual([0, 2, 0, 0.75]);
		expect(values.get("zvibeCollisionSphereCenterRadius0")).toEqual([1, 2, 3, 4]);
		expect(updateCount).toBe(1);
		expect(getGpuParticleCollisionRuntimeEvidence(system).nativeDispatchCount).toBe(1);
	});

	test("hooks WebGPU compute with the collision UBO layout and disables by rebuilding without the define", () => {
		let compiledDefines = "";
		const layout: string[] = [];
		const platform: any = {
			createUpdateBuffer(defines: string) {
				compiledDefines = defines;
				this._simParamsComputeShader = { addUniform: (name: string) => layout.push(name) };
				return {};
			},
			updateParticleBuffer() {},
		};
		let resets = 0;
		const system: any = {
			_platform: platform,
			_updateBuffer: { setInt: () => undefined, setFloat4: () => undefined },
			_resetEffect: () => resets++,
			getClassName: () => "GPUParticleSystem",
			getScene: () => ({ getEngine: () => ({ isWebGPU: true }) }),
		};

		configureGpuParticleCollisions(system, [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 1 }], []);
		platform.createUpdateBuffer("");
		expect(compiledDefines).toContain("#define ZVIBE_GPU_COLLISIONS");
		expect(layout).toContain("zvibeCollisionPlaneCount");
		expect(layout).toContain("zvibeCollisionSphereRestitution7");

		configureGpuParticleCollisions(system, [], []);
		platform.createUpdateBuffer("");
		expect(compiledDefines).not.toContain("ZVIBE_GPU_COLLISIONS");
		expect(getGpuParticleCollisionRuntimeEvidence(system).enabled).toBe(false);
		expect(resets).toBe(2);
	});
});

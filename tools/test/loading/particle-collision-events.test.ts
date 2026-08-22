import { describe, expect, test } from "vitest";

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

import {
	configureGpuParticleCollisionEvents,
	getGpuParticleCollisionEventRuntimeEvidence,
	installGpuParticleCollisionEventShaders,
} from "../../src/loading/gpu-particle-collision-events";
import { configureGpuParticleCollisions } from "../../src/loading/gpu-particle-collisions";
import { configureParticleCollisionEvents } from "../../src/loading/particle-collision-events";

const configuration = {
	enabled: true,
	maximumSourceParticles: 64,
	spawnCount: 2,
	lifetime: 0.75,
	speed: 45,
	size: 6,
	inheritVelocity: 0.6,
	spread: 0.35,
	color: [1, 0.25, 0.1, 1],
};

function createWebGpuSystem(): { system: any; platform: any; layout: string[]; values: Map<string, unknown>; dispatched: any[][] } {
	const layout: string[] = [];
	const values = new Map<string, unknown>();
	const dispatched: any[][] = [];
	const platform: any = {
		createUpdateBuffer() {
			this._simParamsComputeShader = { addUniform: (name: string) => layout.push(name) };
			return {};
		},
		updateParticleBuffer(...args: any[]) {
			dispatched.push(args);
		},
	};
	const system: any = {
		id: "gpu-events",
		name: "GPU Events",
		_platform: platform,
		_currentActiveCount: 8,
		_emitIndex: 70,
		_emitCount: 5,
		_updateBuffer: {
			setInt: (name: string, value: number) => values.set(name, value),
			setFloat: (name: string, value: number) => values.set(name, value),
			setFloat4: (name: string, ...value: number[]) => values.set(name, value),
		},
		_resetEffect: () => undefined,
		getCapacity: () => 512,
		getClassName: () => "GPUParticleSystem",
		getScene: () => ({ getEngine: () => ({ isWebGPU: true }) }),
		onDisposeObservable: { addOnce: () => undefined },
	};
	return { system, platform, layout, values, dispatched };
}

describe("loading/particle-collision-events", () => {
	test("injects guarded collision markers and backend-specific GPU event outputs exactly once", () => {
		installGpuParticleCollisionEventShaders();
		const glsl = ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader;
		const wgsl = ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader;
		expect(glsl).toContain("ZVIBE_NATIVE_WEBGL2_COLLISION_EVENT_TEXTURE_V1");
		expect(glsl).toContain("outSeed.w=gl_VertexID<zvibeCollisionEventSourceLimit && zvibeCollisionOccurred");
		expect(glsl).toContain("zvibeCollisionEventPositionSampler");
		expect(wgsl).toContain("ZVIBE_NATIVE_WEBGPU_COLLISION_EVENT_OUTPUT_V1");
		expect(wgsl).toContain("zvibeCollisionEventSource.seed.w<0.0");
		installGpuParticleCollisionEventShaders();
		expect(ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader.match(/ZVIBE_NATIVE_WEBGL2_COLLISION_EVENT_TEXTURE_V1/g)).toHaveLength(1);
		expect(ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader.match(/ZVIBE_NATIVE_WEBGPU_COLLISION_EVENT_OUTPUT_V1/g)).toHaveLength(1);
	});

	test("reserves bounded same-system output slots and composes WebGPU UBO hooks without readback", () => {
		const { system, platform, layout, values, dispatched } = createWebGpuSystem();
		configureGpuParticleCollisions(system, [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }], []);
		configureGpuParticleCollisionEvents(system, configuration);
		platform.createUpdateBuffer("#define BASE");
		platform.updateParticleBuffer(0, {}, 8);

		expect(layout.indexOf("zvibeCollisionPlaneCount")).toBeLessThan(layout.indexOf("zvibeCollisionEventSourceLimit"));
		expect(layout.slice(-9)).toEqual([
			"zvibeCollisionEventSourceLimit",
			"zvibeCollisionEventSpawnCount",
			"zvibeCollisionEventTotalCount",
			"zvibeCollisionEventLifetime",
			"zvibeCollisionEventSpeed",
			"zvibeCollisionEventSize",
			"zvibeCollisionEventInheritVelocity",
			"zvibeCollisionEventSpread",
			"zvibeCollisionEventColor",
		]);
		expect(system._currentActiveCount).toBe(192);
		expect(dispatched[0][2]).toBe(192);
		expect(values.get("currentCount")).toBe(192);
		expect(values.get("emitIndex")).toBe(6);
		expect(values.get("zvibeCollisionEventColor")).toEqual([1, 0.25, 0.1, 1]);
		expect(getGpuParticleCollisionEventRuntimeEvidence(system)).toMatchObject({
			backend: "webgpu-compute",
			executionModel: "bounded-webgpu-collision-event-output-v1",
			enabled: true,
			supported: true,
			lastCompiledWithEvents: true,
			nativeDispatchCount: 1,
			maximumSourceParticles: 64,
			spawnCount: 2,
			reservedOutputParticles: 128,
			requiredParticleCapacity: 192,
			gpuReadback: false,
			oneFrameLatency: true,
		});
	});

	test("restores persisted event outputs and rejects capacity overflow", () => {
		const { system } = createWebGpuSystem();
		const scene: any = {
			metadata: { babylonEditorGpuParticleCollisionEvents: { [system.id]: configuration } },
			particleSystems: [system],
		};
		configureParticleCollisionEvents(scene);
		expect(getGpuParticleCollisionEventRuntimeEvidence(system).enabled).toBe(true);
		expect(() => configureGpuParticleCollisionEvents(system, { ...configuration, maximumSourceParticles: 200, spawnCount: 2 })).toThrow("capacity 600");
	});
});

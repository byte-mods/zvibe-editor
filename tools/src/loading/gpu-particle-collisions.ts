import "@babylonjs/core/Shaders/gpuUpdateParticles.vertex";
import "@babylonjs/core/ShadersWGSL/gpuUpdateParticles.compute";

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

export interface IParticleCollisionPlane {
	position: number[];
	normal: number[];
	restitution: number;
}

export interface IParticleCollisionSphere {
	center: number[];
	radius: number;
	restitution: number;
}

export interface IGpuParticleCollisionRuntimeEvidence {
	nativeGpu: true;
	backend: "webgl2-transform-feedback" | "webgpu-compute";
	executionModel: "bounded-native-gpu-collision-volumes-v1";
	enabled: boolean;
	planeCount: number;
	sphereCount: number;
	shaderInstalled: boolean;
	hooksInstalled: boolean;
	updateBufferCreated: boolean;
	updateBufferReady: boolean;
	lastCompiledWithCollisions: boolean;
	nativeDispatchCount: number;
}

type ICollisionConfiguration = {
	planes: IParticleCollisionPlane[];
	spheres: IParticleCollisionSphere[];
};

const maxCollisionVolumes = 8;
const shaderDefine = "ZVIBE_GPU_COLLISIONS";
const shaderMarker = "ZVIBE_NATIVE_GPU_COLLISION_VOLUMES_V1";
const configurations = new WeakMap<object, ICollisionConfiguration>();
const installedSystems = new WeakSet<object>();
const runtimeStates = new WeakMap<object, { lastCompiledWithCollisions: boolean; nativeDispatchCount: number }>();

function uniformNames(): string[] {
	const result = ["zvibeCollisionPlaneCount", "zvibeCollisionSphereCount"];
	for (let index = 0; index < maxCollisionVolumes; index++) {
		result.push(
			`zvibeCollisionPlanePositionRestitution${index}`,
			`zvibeCollisionPlaneNormal${index}`,
			`zvibeCollisionSphereCenterRadius${index}`,
			`zvibeCollisionSphereRestitution${index}`
		);
	}
	return result;
}

function glslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${shaderMarker}
uniform int zvibeCollisionPlaneCount;
uniform int zvibeCollisionSphereCount;
${Array.from({ length: maxCollisionVolumes }, (_, index) => `uniform vec4 zvibeCollisionPlanePositionRestitution${index};\nuniform vec4 zvibeCollisionPlaneNormal${index};\nuniform vec4 zvibeCollisionSphereCenterRadius${index};\nuniform vec4 zvibeCollisionSphereRestitution${index};`).join("\n")}
#endif
`;
}

function glslCollisionBlock(): string {
	const planes = Array.from(
		{ length: maxCollisionVolumes },
		(_, index) => `
if (zvibeCollisionPlaneCount>${index}) {
	vec3 zvibePlaneNormal${index}=normalize(zvibeCollisionPlaneNormal${index}.xyz);
	float zvibePlaneDistance${index}=dot(zvibeCollisionPosition-zvibeCollisionPlanePositionRestitution${index}.xyz,zvibePlaneNormal${index});
	float zvibePlaneVelocity${index}=dot(updatedDirection,zvibePlaneNormal${index});
	if (zvibePlaneDistance${index}<0.0 && zvibePlaneVelocity${index}<0.0) {
		zvibeCollisionOccurred=true;
		zvibeCollisionPosition-=zvibePlaneNormal${index}*zvibePlaneDistance${index};
		updatedDirection-=zvibePlaneNormal${index}*((1.0+zvibeCollisionPlanePositionRestitution${index}.w)*zvibePlaneVelocity${index});
	}
}`
	).join("\n");
	const spheres = Array.from(
		{ length: maxCollisionVolumes },
		(_, index) => `
if (zvibeCollisionSphereCount>${index}) {
	vec3 zvibeSphereDelta${index}=zvibeCollisionPosition-zvibeCollisionSphereCenterRadius${index}.xyz;
	float zvibeSphereDistance${index}=length(zvibeSphereDelta${index});
	if (zvibeSphereDistance${index}<zvibeCollisionSphereCenterRadius${index}.w) {
		zvibeCollisionOccurred=true;
		vec3 zvibeSphereNormal${index}=zvibeSphereDistance${index}>0.000001 ? zvibeSphereDelta${index}/zvibeSphereDistance${index} : vec3(0.0,1.0,0.0);
		zvibeCollisionPosition=zvibeCollisionSphereCenterRadius${index}.xyz+zvibeSphereNormal${index}*zvibeCollisionSphereCenterRadius${index}.w;
		float zvibeSphereVelocity${index}=dot(updatedDirection,zvibeSphereNormal${index});
		if (zvibeSphereVelocity${index}<0.0) updatedDirection-=zvibeSphereNormal${index}*((1.0+zvibeCollisionSphereRestitution${index}.x)*zvibeSphereVelocity${index});
	}
}`
	).join("\n");
	return `
#ifdef ${shaderDefine}
vec3 zvibeCollisionPosition=outPosition;
bool zvibeCollisionOccurred=false;
${planes}
${spheres}
outPosition=zvibeCollisionPosition;
#ifdef ZVIBE_GPU_COLLISION_EVENTS
outSeed.w=gl_VertexID<zvibeCollisionEventSourceLimit && zvibeCollisionOccurred ? -max(abs(outSeed.w),0.000001) : abs(outSeed.w);
#endif
#endif
`;
}

function wgslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${shaderMarker}
zvibeCollisionPlaneCount : i32,
zvibeCollisionSphereCount : i32,
${Array.from({ length: maxCollisionVolumes }, (_, index) => `zvibeCollisionPlanePositionRestitution${index} : vec4<f32>,\nzvibeCollisionPlaneNormal${index} : vec4<f32>,\nzvibeCollisionSphereCenterRadius${index} : vec4<f32>,\nzvibeCollisionSphereRestitution${index} : vec4<f32>,`).join("\n")}
#endif
`;
}

function wgslCollisionBlock(): string {
	const planes = Array.from(
		{ length: maxCollisionVolumes },
		(_, index) => `
if (params.zvibeCollisionPlaneCount>${index}) {
	let zvibePlaneNormal${index} : vec3<f32>=normalize(params.zvibeCollisionPlaneNormal${index}.xyz);
	let zvibePlaneDistance${index} : f32=dot(zvibeCollisionPosition-params.zvibeCollisionPlanePositionRestitution${index}.xyz,zvibePlaneNormal${index});
	let zvibePlaneVelocity${index} : f32=dot(updatedDirection,zvibePlaneNormal${index});
	if (zvibePlaneDistance${index}<0.0 && zvibePlaneVelocity${index}<0.0) {
		zvibeCollisionOccurred=true;
		zvibeCollisionPosition=zvibeCollisionPosition-zvibePlaneNormal${index}*zvibePlaneDistance${index};
		updatedDirection=updatedDirection-zvibePlaneNormal${index}*((1.0+params.zvibeCollisionPlanePositionRestitution${index}.w)*zvibePlaneVelocity${index});
	}
}`
	).join("\n");
	const spheres = Array.from(
		{ length: maxCollisionVolumes },
		(_, index) => `
if (params.zvibeCollisionSphereCount>${index}) {
	let zvibeSphereDelta${index} : vec3<f32>=zvibeCollisionPosition-params.zvibeCollisionSphereCenterRadius${index}.xyz;
	let zvibeSphereDistance${index} : f32=length(zvibeSphereDelta${index});
	if (zvibeSphereDistance${index}<params.zvibeCollisionSphereCenterRadius${index}.w) {
		zvibeCollisionOccurred=true;
		var zvibeSphereNormal${index} : vec3<f32>=vec3<f32>(0.0,1.0,0.0);
		if (zvibeSphereDistance${index}>0.000001) {zvibeSphereNormal${index}=zvibeSphereDelta${index}/zvibeSphereDistance${index};}
		zvibeCollisionPosition=params.zvibeCollisionSphereCenterRadius${index}.xyz+zvibeSphereNormal${index}*params.zvibeCollisionSphereCenterRadius${index}.w;
		let zvibeSphereVelocity${index} : f32=dot(updatedDirection,zvibeSphereNormal${index});
		if (zvibeSphereVelocity${index}<0.0) {updatedDirection=updatedDirection-zvibeSphereNormal${index}*((1.0+params.zvibeCollisionSphereRestitution${index}.x)*zvibeSphereVelocity${index});}
	}
}`
	).join("\n");
	return `
#ifdef ${shaderDefine}
var zvibeCollisionPosition : vec3<f32>=particlesOut.particles[index].position;
var zvibeCollisionOccurred : bool=false;
${planes}
${spheres}
particlesOut.particles[index].position=zvibeCollisionPosition;
#ifdef ZVIBE_GPU_COLLISION_EVENTS
particlesOut.particles[index].seed.w=select(abs(particlesOut.particles[index].seed.w),-max(abs(particlesOut.particles[index].seed.w),0.000001),i32(index)<params.zvibeCollisionEventSourceLimit && zvibeCollisionOccurred);
#endif
#endif
`;
}

function replaceOnce(source: string, needle: string, replacement: string, language: string): string {
	const index = source.indexOf(needle);
	if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
		throw new Error(`Babylon ${language} GPU particle shader changed; native collision injection point is not exact.`);
	}
	return source.replace(needle, replacement);
}

/** Installs guarded collision code into Babylon's shared GPU update shaders exactly once. */
export function installGpuParticleCollisionShaders(): void {
	const glslName = "gpuUpdateParticlesVertexShader";
	const wgslName = "gpuUpdateParticlesComputeShader";
	let glsl = ShaderStore.ShadersStore[glslName];
	let wgsl = ShaderStore.ShadersStoreWGSL[wgslName];
	if (!glsl || !wgsl) {
		throw new Error("Babylon GPU particle update shaders are not registered.");
	}
	if (!glsl.includes(shaderMarker)) {
		glsl = replaceOnce(glsl, "uniform vec3 gravity;", `${glslUniforms()}\nuniform vec3 gravity;`, "GLSL");
		glsl = replaceOnce(glsl, "outDirection=updatedDirection;", `${glslCollisionBlock()}\noutDirection=updatedDirection;`, "GLSL");
		ShaderStore.ShadersStore[glslName] = glsl;
	}
	if (!wgsl.includes(shaderMarker)) {
		wgsl = replaceOnce(wgsl, "};@binding(0) @group(0) var<uniform> params : SimParams;", `${wgslUniforms()}\n};@binding(0) @group(0) var<uniform> params : SimParams;`, "WGSL");
		wgsl = replaceOnce(
			wgsl,
			"particlesOut.particles[index].direction=updatedDirection;",
			`${wgslCollisionBlock()}\nparticlesOut.particles[index].direction=updatedDirection;`,
			"WGSL"
		);
		ShaderStore.ShadersStoreWGSL[wgslName] = wgsl;
	}
}

function addWebGpuUniformLayout(platform: any): void {
	const buffer = platform._simParamsComputeShader;
	buffer.addUniform("zvibeCollisionPlaneCount", 1);
	buffer.addUniform("zvibeCollisionSphereCount", 1);
	for (let index = 0; index < maxCollisionVolumes; index++) {
		buffer.addUniform(`zvibeCollisionPlanePositionRestitution${index}`, 4);
		buffer.addUniform(`zvibeCollisionPlaneNormal${index}`, 4);
		buffer.addUniform(`zvibeCollisionSphereCenterRadius${index}`, 4);
		buffer.addUniform(`zvibeCollisionSphereRestitution${index}`, 4);
	}
}

function setCollisionUniforms(system: any): void {
	const configuration = configurations.get(system) ?? { planes: [], spheres: [] };
	const buffer = system._updateBuffer;
	buffer.setInt("zvibeCollisionPlaneCount", configuration.planes.length);
	buffer.setInt("zvibeCollisionSphereCount", configuration.spheres.length);
	for (let index = 0; index < maxCollisionVolumes; index++) {
		const plane = configuration.planes[index];
		const sphere = configuration.spheres[index];
		buffer.setFloat4(`zvibeCollisionPlanePositionRestitution${index}`, plane?.position[0] ?? 0, plane?.position[1] ?? 0, plane?.position[2] ?? 0, plane?.restitution ?? 0);
		buffer.setFloat4(`zvibeCollisionPlaneNormal${index}`, plane?.normal[0] ?? 0, plane?.normal[1] ?? 1, plane?.normal[2] ?? 0, 0);
		buffer.setFloat4(`zvibeCollisionSphereCenterRadius${index}`, sphere?.center[0] ?? 0, sphere?.center[1] ?? 0, sphere?.center[2] ?? 0, sphere?.radius ?? 0);
		buffer.setFloat4(`zvibeCollisionSphereRestitution${index}`, sphere?.restitution ?? 0, 0, 0, 0);
	}
}

function installSystemHooks(system: any): void {
	if (installedSystems.has(system)) {
		return;
	}
	installGpuParticleCollisionShaders();
	const platform = system._platform;
	if (!platform?.createUpdateBuffer || !platform?.updateParticleBuffer) {
		throw new Error("Unsupported Babylon GPU particle platform internals.");
	}
	if (platform._updateEffectOptions) {
		const names = uniformNames();
		platform._updateEffectOptions.uniformsNames.push(...names);
		platform._baseUniformsNamesLength += names.length;
	}
	const originalCreateUpdateBuffer = platform.createUpdateBuffer.bind(platform);
	platform.createUpdateBuffer = (defines: string): any => {
		const configuration = configurations.get(system);
		const configuredDefines = configuration?.planes.length || configuration?.spheres.length ? `${defines}\n#define ${shaderDefine}` : defines;
		const accessor = originalCreateUpdateBuffer(configuredDefines);
		const state = runtimeStates.get(system);
		if (state) {
			state.lastCompiledWithCollisions = configuredDefines.includes(`#define ${shaderDefine}`);
		}
		if (platform._simParamsComputeShader && configuredDefines.includes(`#define ${shaderDefine}`)) {
			addWebGpuUniformLayout(platform);
		}
		return accessor;
	};
	const originalUpdateParticleBuffer = platform.updateParticleBuffer.bind(platform);
	platform.updateParticleBuffer = (...args: any[]): void => {
		const configuration = configurations.get(system);
		if (configuration?.planes.length || configuration?.spheres.length) {
			setCollisionUniforms(system);
		}
		originalUpdateParticleBuffer(...args);
		if (configuration?.planes.length || configuration?.spheres.length) {
			const state = runtimeStates.get(system);
			if (state) {
				state.nativeDispatchCount++;
			}
		}
	};
	runtimeStates.set(system, { lastCompiledWithCollisions: false, nativeDispatchCount: 0 });
	installedSystems.add(system);
}

/** Configures native plane/sphere collision execution for one Babylon GPU particle system. */
export function configureGpuParticleCollisions(system: any, planes: IParticleCollisionPlane[], spheres: IParticleCollisionSphere[]): IGpuParticleCollisionRuntimeEvidence {
	if (system.getClassName?.() !== "GPUParticleSystem") {
		throw new Error("Native GPU particle collisions require a GPUParticleSystem.");
	}
	if (planes.length > maxCollisionVolumes || spheres.length > maxCollisionVolumes) {
		throw new Error(`Native GPU particle collisions support at most ${maxCollisionVolumes} planes and spheres.`);
	}
	installSystemHooks(system);
	configurations.set(system, { planes: structuredClone(planes), spheres: structuredClone(spheres) });
	system._resetEffect();
	// Babylon's private reset assigns an empty cache key, which can equal a valid define set. A sentinel guarantees the next readiness pass recreates the native update program.
	system._cachedUpdateDefines = "__zvibe_gpu_collision_configuration_changed__";
	return getGpuParticleCollisionRuntimeEvidence(system);
}

/** Returns exact native-backend evidence for one configured GPU particle system. */
export function getGpuParticleCollisionRuntimeEvidence(system: any): IGpuParticleCollisionRuntimeEvidence {
	const configuration = configurations.get(system) ?? { planes: [], spheres: [] };
	const state = runtimeStates.get(system) ?? { lastCompiledWithCollisions: false, nativeDispatchCount: 0 };
	const platform = system._platform;
	return {
		nativeGpu: true,
		backend: system.getScene?.()?.getEngine?.().isWebGPU ? "webgpu-compute" : "webgl2-transform-feedback",
		executionModel: "bounded-native-gpu-collision-volumes-v1",
		enabled: Boolean(configuration.planes.length || configuration.spheres.length),
		planeCount: configuration.planes.length,
		sphereCount: configuration.spheres.length,
		shaderInstalled:
			ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader?.includes(shaderMarker) === true &&
			ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader?.includes(shaderMarker) === true,
		hooksInstalled: installedSystems.has(system),
		updateBufferCreated: platform?.isUpdateBufferCreated?.() ?? false,
		updateBufferReady: platform?.isUpdateBufferReady?.() ?? false,
		lastCompiledWithCollisions: state.lastCompiledWithCollisions,
		nativeDispatchCount: state.nativeDispatchCount,
	};
}

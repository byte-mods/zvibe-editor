import "@babylonjs/core/Shaders/gpuUpdateParticles.vertex";
import "@babylonjs/core/ShadersWGSL/gpuUpdateParticles.compute";

import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

import { installGpuParticleCollisionShaders } from "./gpu-particle-collisions";

export interface IGpuParticleCollisionEventConfiguration {
	enabled: boolean;
	maximumSourceParticles: number;
	spawnCount: number;
	lifetime: number;
	speed: number;
	size: number;
	inheritVelocity: number;
	spread: number;
	color: number[];
}

export interface IGpuParticleCollisionEventRuntimeEvidence {
	nativeGpu: true;
	backend: "webgl2-transform-feedback" | "webgpu-compute";
	executionModel: "bounded-webgl2-collision-event-texture-v1" | "bounded-webgpu-collision-event-output-v1";
	enabled: boolean;
	supported: boolean;
	unsupportedReason: string | null;
	shaderInstalled: boolean;
	hooksInstalled: boolean;
	lastCompiledWithEvents: boolean;
	nativeDispatchCount: number;
	activeParticleCount: number;
	updateBufferCreated: boolean;
	updateBufferReady: boolean;
	maximumSourceParticles: number;
	spawnCount: number;
	reservedOutputParticles: number;
	requiredParticleCapacity: number;
	eventTextureReady: boolean;
	eventTextureSize: number[];
	eventCaptureCount: number;
	eventCaptureInputCount: number;
	collisionEventCandidateUpperBound: number;
	gpuReadback: false;
	oneFrameLatency: true;
}

type IRuntimeState = {
	lastCompiledWithEvents: boolean;
	nativeDispatchCount: number;
	eventCaptureCount: number;
	eventCaptureInputCount: number;
};

type IWebGlEventResources = {
	width: number;
	positionTexture: RawTexture;
	directionTexture: RawTexture;
	framebuffer: any;
	program: any;
	positionLocation: number;
	seedLocation: number;
	directionLocation: number;
	vertexArrays: Map<any, any>;
};

const shaderDefine = "ZVIBE_GPU_COLLISION_EVENTS";
const glslMarker = "ZVIBE_NATIVE_WEBGL2_COLLISION_EVENT_TEXTURE_V1";
const wgslMarker = "ZVIBE_NATIVE_WEBGPU_COLLISION_EVENT_OUTPUT_V1";
const configurations = new WeakMap<object, IGpuParticleCollisionEventConfiguration | null>();
const installedSystems = new WeakSet<object>();
const runtimeStates = new WeakMap<object, IRuntimeState>();
const webGlResources = new WeakMap<object, IWebGlEventResources>();

function validateConfiguration(system: any, configuration: IGpuParticleCollisionEventConfiguration): void {
	if (!Number.isInteger(configuration.maximumSourceParticles) || configuration.maximumSourceParticles < 1 || configuration.maximumSourceParticles > 2048) {
		throw new Error("GPU collision-event maximumSourceParticles must be an integer from 1 to 2048.");
	}
	if (!Number.isInteger(configuration.spawnCount) || configuration.spawnCount < 1 || configuration.spawnCount > 4) {
		throw new Error("GPU collision-event spawnCount must be an integer from 1 to 4.");
	}
	for (const [name, value, minimum, maximum] of [
		["lifetime", configuration.lifetime, 0.001, 3600],
		["speed", configuration.speed, 0, 100000],
		["size", configuration.size, 0.0001, 100000],
		["inheritVelocity", configuration.inheritVelocity, 0, 1],
		["spread", configuration.spread, 0, 1],
	] as Array<[string, number, number, number]>) {
		if (!Number.isFinite(value) || value < minimum || value > maximum) {
			throw new Error(`GPU collision-event ${name} must be from ${minimum} to ${maximum}.`);
		}
	}
	if (!Array.isArray(configuration.color) || configuration.color.length !== 4 || configuration.color.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
		throw new Error("GPU collision-event color must contain four values from 0 to 1.");
	}
	const required = configuration.maximumSourceParticles * (1 + configuration.spawnCount);
	const capacity = system.getCapacity?.() ?? system._capacity ?? 0;
	if (required > 4096) {
		throw new Error("GPU collision-event source and output regions may contain at most 4096 particles in total.");
	}
	if (required > capacity) {
		throw new Error(`GPU collision-event output requires capacity ${required}, but the particle system capacity is ${capacity}.`);
	}
}

function replaceOnce(source: string, needle: string, replacement: string, language: string): string {
	const index = source.indexOf(needle);
	if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
		throw new Error(`Babylon ${language} GPU particle shader changed; collision-event injection point is not exact.`);
	}
	return source.replace(needle, replacement);
}

function replaceEveryExact(source: string, needle: string, replacement: string, expected: number, language: string): string {
	const count = source.split(needle).length - 1;
	if (count !== expected) {
		throw new Error(`Babylon ${language} GPU particle shader changed; expected ${expected} collision-event seed/emission sites and found ${count}.`);
	}
	return source.split(needle).join(replacement);
}

function replaceLast(source: string, needle: string, replacement: string, language: string): string {
	const index = source.lastIndexOf(needle);
	if (index < 0) {
		throw new Error(`Babylon ${language} GPU particle shader changed; collision-event output site is missing.`);
	}
	return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

function glslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${glslMarker}
uniform sampler2D zvibeCollisionEventPositionSampler;
uniform sampler2D zvibeCollisionEventDirectionSampler;
uniform int zvibeCollisionEventSourceLimit;
uniform int zvibeCollisionEventSpawnCount;
uniform int zvibeCollisionEventTotalCount;
uniform float zvibeCollisionEventLifetime;
uniform float zvibeCollisionEventSpeed;
uniform float zvibeCollisionEventSize;
uniform float zvibeCollisionEventInheritVelocity;
uniform float zvibeCollisionEventSpread;
uniform vec4 zvibeCollisionEventColor;
#endif
`;
}

function wgslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${wgslMarker}
zvibeCollisionEventSourceLimit : i32,
zvibeCollisionEventSpawnCount : i32,
zvibeCollisionEventTotalCount : i32,
zvibeCollisionEventLifetime : f32,
zvibeCollisionEventSpeed : f32,
zvibeCollisionEventSize : f32,
zvibeCollisionEventInheritVelocity : f32,
zvibeCollisionEventSpread : f32,
zvibeCollisionEventColor : vec4<f32>,
#endif
`;
}

function glslSourceEmissionGuard(): string {
	return `
#ifdef ${shaderDefine}
if (gl_VertexID>=zvibeCollisionEventSourceLimit) {shouldEmit=false;}
#ifdef EMITRATECTRL
else {
	float zvibeCollisionEventOffset=float(gl_VertexID)-mod(emitIndex,float(zvibeCollisionEventSourceLimit));
	if (zvibeCollisionEventOffset<0.0) {zvibeCollisionEventOffset+=float(zvibeCollisionEventSourceLimit);}
	shouldEmit=zvibeCollisionEventOffset<min(emitCount,float(zvibeCollisionEventSourceLimit)) && stopFactor!=0.0;
}
#endif
#endif
`;
}

function wgslSourceEmissionGuard(): string {
	return `
#ifdef ${shaderDefine}
if (i32(index)>=params.zvibeCollisionEventSourceLimit) {shouldEmit=false;}
#ifdef EMITRATECTRL
else {
	var zvibeCollisionEventOffset : f32=vertexID-(params.emitIndex % f32(params.zvibeCollisionEventSourceLimit));
	if (zvibeCollisionEventOffset<0.0) {zvibeCollisionEventOffset+=f32(params.zvibeCollisionEventSourceLimit);}
	shouldEmit=zvibeCollisionEventOffset<min(params.emitCount,f32(params.zvibeCollisionEventSourceLimit)) && params.stopFactor!=0.0;
}
#endif
#endif
`;
}

function glslOutputBlock(): string {
	return `
#ifdef ${shaderDefine}
if (gl_VertexID>=zvibeCollisionEventSourceLimit && gl_VertexID<zvibeCollisionEventTotalCount) {
	int zvibeCollisionEventOutputIndex=gl_VertexID-zvibeCollisionEventSourceLimit;
	int zvibeCollisionEventParentIndex=zvibeCollisionEventOutputIndex/zvibeCollisionEventSpawnCount;
	int zvibeCollisionEventLane=zvibeCollisionEventOutputIndex-zvibeCollisionEventParentIndex*zvibeCollisionEventSpawnCount;
	vec4 zvibeCollisionEventPosition=texelFetch(zvibeCollisionEventPositionSampler,ivec2(zvibeCollisionEventParentIndex,0),0);
	vec4 zvibeCollisionEventDirection=texelFetch(zvibeCollisionEventDirectionSampler,ivec2(zvibeCollisionEventParentIndex,0),0);
	if (zvibeCollisionEventPosition.w>0.5) {
		float zvibeCollisionEventHash=float(zvibeCollisionEventParentIndex*17+zvibeCollisionEventLane*131)+abs(seed.x)*997.0;
		vec3 zvibeCollisionEventRandom=fract(sin(vec3(zvibeCollisionEventHash,zvibeCollisionEventHash+19.19,zvibeCollisionEventHash+73.73))*43758.5453)*2.0-1.0;
		if (dot(zvibeCollisionEventRandom,zvibeCollisionEventRandom)<0.000001) {zvibeCollisionEventRandom=vec3(0.0,1.0,0.0);}
		vec3 zvibeCollisionEventInherited=length(zvibeCollisionEventDirection.xyz)>0.000001 ? normalize(zvibeCollisionEventDirection.xyz) : vec3(0.0,1.0,0.0);
		vec3 zvibeCollisionEventVelocity=mix(normalize(zvibeCollisionEventRandom),zvibeCollisionEventInherited,zvibeCollisionEventInheritVelocity);
		zvibeCollisionEventVelocity=normalize(mix(zvibeCollisionEventVelocity,normalize(zvibeCollisionEventRandom),zvibeCollisionEventSpread));
		outPosition=zvibeCollisionEventPosition.xyz;
		outAge=0.0;
		outLife=zvibeCollisionEventLifetime;
		outSeed=vec4(abs(seed.xyz),abs(seed.w));
		outSize=vec3(zvibeCollisionEventSize,1.0,1.0);
		outDirection=zvibeCollisionEventVelocity*zvibeCollisionEventSpeed;
#ifndef COLORGRADIENTS
		outColor=zvibeCollisionEventColor;
#endif
	} else if (newAge>=life) {
		outPosition=position;
		outAge=max(life,0.0);
		outLife=max(life,0.0001);
		outSeed=vec4(abs(seed.xyz),abs(seed.w));
		outSize=vec3(zvibeCollisionEventSize,1.0,1.0);
		outDirection=vec3(0.0);
	}
}
#endif
`;
}

function wgslOutputBlock(): string {
	return `
#ifdef ${shaderDefine}
if (i32(index)>=params.zvibeCollisionEventSourceLimit && i32(index)<params.zvibeCollisionEventTotalCount) {
	let zvibeCollisionEventOutputIndex : i32=i32(index)-params.zvibeCollisionEventSourceLimit;
	let zvibeCollisionEventParentIndex : i32=zvibeCollisionEventOutputIndex/params.zvibeCollisionEventSpawnCount;
	let zvibeCollisionEventLane : i32=zvibeCollisionEventOutputIndex-zvibeCollisionEventParentIndex*params.zvibeCollisionEventSpawnCount;
	let zvibeCollisionEventSource=particlesIn.particles[u32(zvibeCollisionEventParentIndex)];
	if (zvibeCollisionEventSource.seed.w<0.0) {
		let zvibeCollisionEventHash : f32=f32(zvibeCollisionEventParentIndex*17+zvibeCollisionEventLane*131)+abs(seed.x)*997.0;
		var zvibeCollisionEventRandom : vec3<f32>=fract(sin(vec3<f32>(zvibeCollisionEventHash,zvibeCollisionEventHash+19.19,zvibeCollisionEventHash+73.73))*43758.5453)*2.0-vec3<f32>(1.0);
		if (dot(zvibeCollisionEventRandom,zvibeCollisionEventRandom)<0.000001) {zvibeCollisionEventRandom=vec3<f32>(0.0,1.0,0.0);}
		var zvibeCollisionEventInherited : vec3<f32>=vec3<f32>(0.0,1.0,0.0);
		if (length(zvibeCollisionEventSource.direction)>0.000001) {zvibeCollisionEventInherited=normalize(zvibeCollisionEventSource.direction);}
		var zvibeCollisionEventVelocity : vec3<f32>=mix(normalize(zvibeCollisionEventRandom),zvibeCollisionEventInherited,params.zvibeCollisionEventInheritVelocity);
		zvibeCollisionEventVelocity=normalize(mix(zvibeCollisionEventVelocity,normalize(zvibeCollisionEventRandom),params.zvibeCollisionEventSpread));
		particlesOut.particles[index].position=zvibeCollisionEventSource.position;
		particlesOut.particles[index].age=0.0;
		particlesOut.particles[index].life=params.zvibeCollisionEventLifetime;
		particlesOut.particles[index].seed=abs(seed);
		particlesOut.particles[index].size=vec3<f32>(params.zvibeCollisionEventSize,1.0,1.0);
		particlesOut.particles[index].direction=zvibeCollisionEventVelocity*params.zvibeCollisionEventSpeed;
#ifndef COLORGRADIENTS
		particlesOut.particles[index].color=params.zvibeCollisionEventColor;
#endif
	} else if (newAge>=life) {
		particlesOut.particles[index].position=particlesIn.particles[index].position;
		particlesOut.particles[index].age=max(life,0.0);
		particlesOut.particles[index].life=max(life,0.0001);
		particlesOut.particles[index].seed=abs(seed);
		particlesOut.particles[index].size=vec3<f32>(params.zvibeCollisionEventSize,1.0,1.0);
		particlesOut.particles[index].direction=vec3<f32>(0.0);
	}
}
#endif
`;
}

/** Installs guarded same-system collision-event output into Babylon's native GPU update shaders. */
export function installGpuParticleCollisionEventShaders(): void {
	installGpuParticleCollisionShaders();
	const glslName = "gpuUpdateParticlesVertexShader";
	const wgslName = "gpuUpdateParticlesComputeShader";
	let glsl = ShaderStore.ShadersStore[glslName];
	let wgsl = ShaderStore.ShadersStoreWGSL[wgslName];
	if (!glsl || !wgsl) {
		throw new Error("Babylon GPU particle update shaders are not registered.");
	}
	if (!glsl.includes(glslMarker)) {
		glsl = replaceEveryExact(glsl, "outSeed=seed;", "outSeed=vec4(seed.xyz,abs(seed.w));", 2, "GLSL");
		glsl = replaceOnce(glsl, "getRandomVec3(seed.w)", "getRandomVec3(abs(seed.w))", "GLSL");
		glsl = replaceOnce(glsl, "*seed.w;", "*abs(seed.w);", "GLSL");
		glsl = replaceOnce(glsl, "uniform vec3 gravity;", `${glslUniforms()}\nuniform vec3 gravity;`, "GLSL");
		glsl = replaceOnce(glsl, "#endif\nif (shouldEmit) {", `#endif\n${glslSourceEmissionGuard()}\nif (shouldEmit) {`, "GLSL");
		glsl = replaceLast(glsl, "}}", `${glslOutputBlock()}\n}}`, "GLSL");
		ShaderStore.ShadersStore[glslName] = glsl;
	}
	if (!wgsl.includes(wgslMarker)) {
		wgsl = replaceEveryExact(wgsl, "particlesOut.particles[index].seed=seed;", "particlesOut.particles[index].seed=vec4<f32>(seed.xyz,abs(seed.w));", 2, "WGSL");
		wgsl = replaceOnce(wgsl, "getRandomVec3(seed.w,vertexID)", "getRandomVec3(abs(seed.w),vertexID)", "WGSL");
		wgsl = replaceOnce(wgsl, "*seed.w);", "*abs(seed.w));", "WGSL");
		wgsl = replaceEveryExact(wgsl, "let shouldEmit : bool=", "var shouldEmit : bool=", 2, "WGSL");
		wgsl = replaceOnce(wgsl, "};@binding(0) @group(0) var<uniform> params : SimParams;", `${wgslUniforms()}\n};@binding(0) @group(0) var<uniform> params : SimParams;`, "WGSL");
		wgsl = replaceOnce(wgsl, "#endif\nif (shouldEmit) {", `#endif\n${wgslSourceEmissionGuard()}\nif (shouldEmit) {`, "WGSL");
		wgsl = replaceLast(wgsl, "}}", `${wgslOutputBlock()}\n}}`, "WGSL");
		ShaderStore.ShadersStoreWGSL[wgslName] = wgsl;
	}
}

function compileShader(gl: any, type: number, source: string): any {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const message = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`WebGL2 collision-event shader compilation failed: ${message}`);
	}
	return shader;
}

function createEventTexture(system: any, width: number, suffix: string): RawTexture {
	const texture = RawTexture.CreateRGBATexture(new Float32Array(width * 4), width, 1, system.getScene(), false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
	texture.name = `${system.name} GPU Collision Event ${suffix}`;
	return texture;
}

function createWebGlResources(system: any, configuration: IGpuParticleCollisionEventConfiguration): IWebGlEventResources {
	const engine = system.getScene?.()?.getEngine?.();
	const gl = engine?._gl;
	if (!gl || (engine.webGLVersion ?? 0) < 2) {
		throw new Error("Native GPU collision events require WebGL2 or WebGPU.");
	}
	if (!gl.getExtension("EXT_color_buffer_float")) {
		throw new Error("Native WebGL2 collision events require EXT_color_buffer_float for GPU-only position and velocity transport.");
	}
	if (configuration.maximumSourceParticles > engine.getCaps().maxTextureSize) {
		throw new Error(`Collision-event source width ${configuration.maximumSourceParticles} exceeds this WebGL2 target's ${engine.getCaps().maxTextureSize} texture limit.`);
	}
	const positionTexture = createEventTexture(system, configuration.maximumSourceParticles, "Positions");
	const directionTexture = createEventTexture(system, configuration.maximumSourceParticles, "Directions");
	const framebuffer = gl.createFramebuffer();
	const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, (positionTexture as any)._texture?._hardwareTexture?.underlyingResource, 0);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, (directionTexture as any)._texture?._hardwareTexture?.underlyingResource, 0);
	gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
	const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
	gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
	if (status !== gl.FRAMEBUFFER_COMPLETE) {
		gl.deleteFramebuffer(framebuffer);
		positionTexture.dispose();
		directionTexture.dispose();
		throw new Error(`WebGL2 collision-event framebuffer is incomplete (${status}).`);
	}
	const vertex = compileShader(
		gl,
		gl.VERTEX_SHADER,
		`#version 300 es
in vec3 position;
in vec4 seed;
in vec3 direction;
out vec3 eventPosition;
out vec3 eventDirection;
flat out float eventFlag;
uniform float eventTextureWidth;
void main() {
	eventPosition=position;
	eventDirection=direction;
	eventFlag=seed.w<0.0 ? 1.0 : 0.0;
	gl_Position=vec4((float(gl_VertexID)+0.5)/eventTextureWidth*2.0-1.0,0.0,0.0,1.0);
	gl_PointSize=1.0;
}`
	);
	const fragment = compileShader(
		gl,
		gl.FRAGMENT_SHADER,
		`#version 300 es
precision highp float;
in vec3 eventPosition;
in vec3 eventDirection;
flat in float eventFlag;
layout(location=0) out vec4 positionEvent;
layout(location=1) out vec4 directionEvent;
void main() {
	positionEvent=vec4(eventPosition,eventFlag);
	directionEvent=vec4(eventDirection,eventFlag);
}`
	);
	const program = gl.createProgram();
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const message = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		gl.deleteFramebuffer(framebuffer);
		positionTexture.dispose();
		directionTexture.dispose();
		throw new Error(`WebGL2 collision-event program link failed: ${message}`);
	}
	gl.useProgram(program);
	gl.uniform1f(gl.getUniformLocation(program, "eventTextureWidth"), configuration.maximumSourceParticles);
	gl.useProgram(null);
	return {
		width: configuration.maximumSourceParticles,
		positionTexture,
		directionTexture,
		framebuffer,
		program,
		positionLocation: gl.getAttribLocation(program, "position"),
		seedLocation: gl.getAttribLocation(program, "seed"),
		directionLocation: gl.getAttribLocation(program, "direction"),
		vertexArrays: new Map(),
	};
}

function disposeWebGlResources(system: any, resources: IWebGlEventResources | undefined): void {
	if (!resources) {
		return;
	}
	const gl = system.getScene?.()?.getEngine?.()?._gl;
	if (gl) {
		for (const vertexArray of resources.vertexArrays.values()) {
			gl.deleteVertexArray(vertexArray);
		}
		gl.deleteProgram(resources.program);
		gl.deleteFramebuffer(resources.framebuffer);
	}
	resources.positionTexture.dispose();
	resources.directionTexture.dispose();
	if (webGlResources.get(system) === resources) {
		webGlResources.delete(system);
	}
}

function eventVertexArray(system: any, resources: IWebGlEventResources, targetBuffer: any): any {
	const gl = system.getScene().getEngine()._gl;
	const buffer = targetBuffer?.getBuffer?.()?.underlyingResource;
	if (!buffer) {
		throw new Error("WebGL2 collision-event target buffer is not initialized.");
	}
	const existing = resources.vertexArrays.get(buffer);
	if (existing) {
		return existing;
	}
	const vertexArray = gl.createVertexArray();
	gl.bindVertexArray(vertexArray);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	const stride = system._attributesStrideSize * 4;
	for (const [location, size, offset] of [
		[resources.positionLocation, 3, 0],
		[resources.seedLocation, 4, 8 * 4],
		[resources.directionLocation, 3, 12 * 4],
	] as number[][]) {
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
	}
	gl.bindVertexArray(null);
	resources.vertexArrays.set(buffer, vertexArray);
	return vertexArray;
}

function captureWebGlEvents(system: any, targetBuffer: any): void {
	const configuration = configurations.get(system);
	const resources = webGlResources.get(system);
	if (!configuration?.enabled || !resources) {
		return;
	}
	const engine = system.getScene().getEngine();
	const gl = engine._gl;
	const viewport = gl.getParameter(gl.VIEWPORT);
	const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const scissor = gl.isEnabled(gl.SCISSOR_TEST);
	const blend = gl.isEnabled(gl.BLEND);
	const depth = gl.isEnabled(gl.DEPTH_TEST);
	const cull = gl.isEnabled(gl.CULL_FACE);
	const discard = gl.isEnabled(gl.RASTERIZER_DISCARD);
	const colorMask = gl.getParameter(gl.COLOR_WRITEMASK);
	const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE);
	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
		gl.viewport(0, 0, resources.width, 1);
		gl.disable(gl.SCISSOR_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.RASTERIZER_DISCARD);
		gl.colorMask(true, true, true, true);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(resources.program);
		gl.bindVertexArray(eventVertexArray(system, resources, targetBuffer));
		gl.drawArrays(gl.POINTS, 0, configuration.maximumSourceParticles);
		const state = runtimeStates.get(system);
		if (state) {
			state.eventCaptureCount++;
			state.eventCaptureInputCount = configuration.maximumSourceParticles;
		}
	} finally {
		gl.bindVertexArray(null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
		gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
		gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
		for (const [capability, enabled] of [
			[gl.SCISSOR_TEST, scissor],
			[gl.BLEND, blend],
			[gl.DEPTH_TEST, depth],
			[gl.CULL_FACE, cull],
			[gl.RASTERIZER_DISCARD, discard],
		] as Array<[number, boolean]>) {
			enabled ? gl.enable(capability) : gl.disable(capability);
		}
		engine.wipeCaches(true);
		engine.enableEffect(system._platform._updateEffect);
	}
}

function webGlSupport(system: any, configuration: IGpuParticleCollisionEventConfiguration | null): { supported: boolean; reason: string | null } {
	const engine = system.getScene?.()?.getEngine?.();
	const gl = engine?._gl;
	if (!gl || (engine.webGLVersion ?? 0) < 2) {
		return { supported: false, reason: "Native GPU collision events require WebGL2 or WebGPU." };
	}
	if (!gl.getExtension("EXT_color_buffer_float")) {
		return { supported: false, reason: "WebGL2 collision events require EXT_color_buffer_float." };
	}
	if ((configuration?.maximumSourceParticles ?? 0) > engine.getCaps().maxTextureSize) {
		return { supported: false, reason: "Configured collision-event source width exceeds the WebGL2 texture limit." };
	}
	return { supported: true, reason: null };
}

function setUniforms(system: any, configuration: IGpuParticleCollisionEventConfiguration): void {
	const buffer = system._updateBuffer;
	const total = configuration.maximumSourceParticles * (1 + configuration.spawnCount);
	buffer.setInt("zvibeCollisionEventSourceLimit", configuration.maximumSourceParticles);
	buffer.setInt("zvibeCollisionEventSpawnCount", configuration.spawnCount);
	buffer.setInt("zvibeCollisionEventTotalCount", total);
	buffer.setFloat("zvibeCollisionEventLifetime", configuration.lifetime);
	buffer.setFloat("zvibeCollisionEventSpeed", configuration.speed);
	buffer.setFloat("zvibeCollisionEventSize", configuration.size);
	buffer.setFloat("zvibeCollisionEventInheritVelocity", configuration.inheritVelocity);
	buffer.setFloat("zvibeCollisionEventSpread", configuration.spread);
	buffer.setFloat4("zvibeCollisionEventColor", configuration.color[0], configuration.color[1], configuration.color[2], configuration.color[3]);
	buffer.setFloat("currentCount", total);
	buffer.setFloat("emitIndex", Math.max(0, system._emitIndex ?? 0) % configuration.maximumSourceParticles);
	buffer.setFloat("emitCount", Math.min(Math.max(0, system._emitCount ?? 0), configuration.maximumSourceParticles));
}

function addWebGpuUniformLayout(platform: any): void {
	const buffer = platform._simParamsComputeShader;
	buffer.addUniform("zvibeCollisionEventSourceLimit", 1);
	buffer.addUniform("zvibeCollisionEventSpawnCount", 1);
	buffer.addUniform("zvibeCollisionEventTotalCount", 1);
	buffer.addUniform("zvibeCollisionEventLifetime", 1);
	buffer.addUniform("zvibeCollisionEventSpeed", 1);
	buffer.addUniform("zvibeCollisionEventSize", 1);
	buffer.addUniform("zvibeCollisionEventInheritVelocity", 1);
	buffer.addUniform("zvibeCollisionEventSpread", 1);
	buffer.addUniform("zvibeCollisionEventColor", 4);
}

function installSystemHooks(system: any): void {
	if (installedSystems.has(system)) {
		return;
	}
	installGpuParticleCollisionEventShaders();
	const platform = system._platform;
	if (!platform?.createUpdateBuffer || !platform?.updateParticleBuffer) {
		throw new Error("Unsupported Babylon GPU particle platform internals.");
	}
	const isWebGpu = system.getScene().getEngine().isWebGPU === true;
	if (!isWebGpu) {
		const names = [
			"zvibeCollisionEventSourceLimit",
			"zvibeCollisionEventSpawnCount",
			"zvibeCollisionEventTotalCount",
			"zvibeCollisionEventLifetime",
			"zvibeCollisionEventSpeed",
			"zvibeCollisionEventSize",
			"zvibeCollisionEventInheritVelocity",
			"zvibeCollisionEventSpread",
			"zvibeCollisionEventColor",
		];
		platform._updateEffectOptions.uniformsNames.push(...names);
		platform._baseUniformsNamesLength += names.length;
		platform._updateEffectOptions.samplers.push("zvibeCollisionEventPositionSampler", "zvibeCollisionEventDirectionSampler");
	}
	const originalCreateUpdateBuffer = platform.createUpdateBuffer.bind(platform);
	platform.createUpdateBuffer = (defines: string): any => {
		const configuration = configurations.get(system);
		const support = isWebGpu ? { supported: true } : webGlSupport(system, configuration ?? null);
		const configuredDefines = configuration?.enabled && support.supported ? `${defines}\n#define ${shaderDefine}` : defines;
		const accessor = originalCreateUpdateBuffer(configuredDefines);
		const state = runtimeStates.get(system);
		if (state) {
			state.lastCompiledWithEvents = configuredDefines.includes(`#define ${shaderDefine}`);
		}
		if (isWebGpu && configuredDefines.includes(`#define ${shaderDefine}`)) {
			addWebGpuUniformLayout(platform);
		}
		return accessor;
	};
	const originalUpdateParticleBuffer = platform.updateParticleBuffer.bind(platform);
	platform.updateParticleBuffer = (...args: any[]): void => {
		const configuration = configurations.get(system);
		if (!configuration?.enabled) {
			originalUpdateParticleBuffer(...args);
			return;
		}
		const total = configuration.maximumSourceParticles * (1 + configuration.spawnCount);
		system._currentActiveCount = total;
		args[2] = total;
		setUniforms(system, configuration);
		if (!isWebGpu) {
			const resources = webGlResources.get(system);
			platform._updateEffect.setTexture("zvibeCollisionEventPositionSampler", resources?.positionTexture);
			platform._updateEffect.setTexture("zvibeCollisionEventDirectionSampler", resources?.directionTexture);
		}
		originalUpdateParticleBuffer(...args);
		if (!isWebGpu) {
			captureWebGlEvents(system, args[1]);
		}
		const state = runtimeStates.get(system);
		if (state) {
			state.nativeDispatchCount++;
		}
	};
	runtimeStates.set(system, { lastCompiledWithEvents: false, nativeDispatchCount: 0, eventCaptureCount: 0, eventCaptureInputCount: 0 });
	system.onDisposeObservable?.addOnce(() => disposeWebGlResources(system, webGlResources.get(system)));
	installedSystems.add(system);
}

/** Configures bounded collision-triggered secondary particles inside one native GPU particle system. */
export function configureGpuParticleCollisionEvents(system: any, configuration: IGpuParticleCollisionEventConfiguration | null): IGpuParticleCollisionEventRuntimeEvidence {
	if (system.getClassName?.() !== "GPUParticleSystem") {
		throw new Error("Native GPU collision events require a GPUParticleSystem.");
	}
	if (configuration) {
		validateConfiguration(system, configuration);
	}
	const previous = configurations.get(system);
	const existingResources = webGlResources.get(system);
	const isWebGpu = system.getScene?.()?.getEngine?.().isWebGPU === true;
	let replacementResources: IWebGlEventResources | undefined;
	try {
		if (!isWebGpu && configuration?.enabled && existingResources?.width !== configuration.maximumSourceParticles) {
			replacementResources = createWebGlResources(system, configuration);
		}
		configurations.set(system, configuration ? structuredClone(configuration) : null);
		installSystemHooks(system);
		if (configuration?.enabled) {
			system._currentActiveCount = configuration.maximumSourceParticles * (1 + configuration.spawnCount);
		}
		system._resetEffect();
		system._cachedUpdateDefines = "__zvibe_gpu_collision_event_configuration_changed__";
		if (!isWebGpu) {
			if (replacementResources) {
				webGlResources.set(system, replacementResources);
				disposeWebGlResources(system, existingResources);
			} else if (!configuration?.enabled) {
				disposeWebGlResources(system, existingResources);
			}
		}
		if (!configuration?.enabled && previous?.enabled) {
			system._currentActiveCount = Math.min(system._currentActiveCount ?? 0, previous.maximumSourceParticles);
		}
	} catch (error) {
		if (replacementResources) {
			disposeWebGlResources(system, replacementResources);
		}
		configurations.set(system, previous ?? null);
		throw error;
	}
	return getGpuParticleCollisionEventRuntimeEvidence(system);
}

/** Returns exact native collision-event output evidence without reading particle data back to the CPU. */
export function getGpuParticleCollisionEventRuntimeEvidence(system: any): IGpuParticleCollisionEventRuntimeEvidence {
	const configuration = configurations.get(system);
	const state = runtimeStates.get(system) ?? { lastCompiledWithEvents: false, nativeDispatchCount: 0, eventCaptureCount: 0, eventCaptureInputCount: 0 };
	const isWebGpu = system.getScene?.()?.getEngine?.().isWebGPU === true;
	const resources = webGlResources.get(system);
	const support = isWebGpu ? { supported: true, reason: null } : webGlSupport(system, configuration ?? null);
	const maximumSourceParticles = configuration?.maximumSourceParticles ?? 0;
	const spawnCount = configuration?.spawnCount ?? 0;
	const reservedOutputParticles = maximumSourceParticles * spawnCount;
	return {
		nativeGpu: true,
		backend: isWebGpu ? "webgpu-compute" : "webgl2-transform-feedback",
		executionModel: isWebGpu ? "bounded-webgpu-collision-event-output-v1" : "bounded-webgl2-collision-event-texture-v1",
		enabled: configuration?.enabled === true,
		supported: support.supported,
		unsupportedReason: support.reason,
		shaderInstalled: isWebGpu
			? ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader?.includes(wgslMarker) === true
			: ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader?.includes(glslMarker) === true,
		hooksInstalled: installedSystems.has(system),
		lastCompiledWithEvents: state.lastCompiledWithEvents,
		nativeDispatchCount: state.nativeDispatchCount,
		activeParticleCount: Math.max(0, Math.floor(system._currentActiveCount ?? 0)),
		updateBufferCreated: system._platform?.isUpdateBufferCreated?.() ?? false,
		updateBufferReady: system._platform?.isUpdateBufferReady?.() ?? false,
		maximumSourceParticles,
		spawnCount,
		reservedOutputParticles,
		requiredParticleCapacity: maximumSourceParticles + reservedOutputParticles,
		eventTextureReady: !isWebGpu && Boolean(resources?.positionTexture.isReady() && resources.directionTexture.isReady()),
		eventTextureSize: resources ? [resources.width, 1, 2] : [0, 0, 0],
		eventCaptureCount: state.eventCaptureCount,
		eventCaptureInputCount: state.eventCaptureInputCount,
		collisionEventCandidateUpperBound: reservedOutputParticles,
		gpuReadback: false,
		oneFrameLatency: true,
	};
}

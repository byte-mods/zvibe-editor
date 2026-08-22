import "@babylonjs/core/Shaders/gpuUpdateParticles.vertex";
import "@babylonjs/core/ShadersWGSL/gpuUpdateParticles.compute";

import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

export interface IGpuParticleInteractionConfiguration {
	enabled: boolean;
	radius: number;
	restitution: number;
	separationStrength: number;
	maximumParticles: number;
	maximumNeighbors: number;
	boundsMin: number[];
	boundsMax: number[];
	gridResolution: number;
}

export interface IGpuParticleInteractionRuntimeEvidence {
	nativeGpu: true;
	backend: "webgpu-compute" | "webgl2-transform-feedback";
	executionModel: "bounded-webgpu-pairwise-particle-collision-v1" | "bounded-webgl2-occupancy-field-collision-v1";
	enabled: boolean;
	supported: boolean;
	unsupportedReason: string | null;
	shaderInstalled: boolean;
	hooksInstalled: boolean;
	lastCompiledWithInteractions: boolean;
	nativeDispatchCount: number;
	configuredMaximumParticles: number;
	configuredMaximumNeighbors: number;
	activeParticleLimit: number;
	pairTestUpperBound: number;
	occupancyFieldReady: boolean;
	occupancyGridResolution: number;
	occupancyTextureSize: number[];
	occupancyBuildCount: number;
	occupancyInputParticleCount: number;
	occupancySampleUpperBound: number;
	occupancyNeighborStencil: "3x3x3" | null;
}

type IRuntimeState = {
	lastCompiledWithInteractions: boolean;
	nativeDispatchCount: number;
	occupancyBuildCount: number;
	occupancyInputParticleCount: number;
};

type IOccupancyResources = {
	resolution: number;
	width: number;
	height: number;
	texture: RawTexture;
	framebuffer: any;
	program: any;
	positionLocation: number;
	ageLocation: number;
	lifeLocation: number;
	boundsMinLocation: any;
	boundsSizeLocation: any;
	resolutionLocation: any;
	vertexArrays: Map<any, any>;
};

const shaderDefine = "ZVIBE_GPU_PARTICLE_INTERACTIONS";
const webGpuShaderMarker = "ZVIBE_NATIVE_WEBGPU_PAIRWISE_PARTICLE_COLLISION_V1";
const webGlShaderMarker = "ZVIBE_NATIVE_WEBGL2_OCCUPANCY_FIELD_COLLISION_V1";
const configurations = new WeakMap<object, IGpuParticleInteractionConfiguration | null>();
const installedSystems = new WeakSet<object>();
const runtimeStates = new WeakMap<object, IRuntimeState>();
const occupancyResources = new WeakMap<object, IOccupancyResources>();

const defaultBoundsMin = [-500, -500, -500];
const defaultBoundsMax = [500, 500, 500];

function normalizeConfiguration(configuration: IGpuParticleInteractionConfiguration): IGpuParticleInteractionConfiguration {
	return {
		...structuredClone(configuration),
		boundsMin: [...(configuration.boundsMin ?? defaultBoundsMin)],
		boundsMax: [...(configuration.boundsMax ?? defaultBoundsMax)],
		gridResolution: configuration.gridResolution ?? 32,
	};
}

function validateConfiguration(configuration: IGpuParticleInteractionConfiguration): void {
	if (!Array.isArray(configuration.boundsMin) || !Array.isArray(configuration.boundsMax) || configuration.boundsMin.length !== 3 || configuration.boundsMax.length !== 3) {
		throw new Error("GPU particle interaction occupancy bounds must each contain three numbers.");
	}
	for (let axis = 0; axis < 3; axis++) {
		if (!Number.isFinite(configuration.boundsMin[axis]) || !Number.isFinite(configuration.boundsMax[axis]) || configuration.boundsMax[axis] <= configuration.boundsMin[axis]) {
			throw new Error(`GPU particle interaction occupancy bounds require a finite max greater than min on axis ${axis}.`);
		}
	}
	if (!Number.isInteger(configuration.gridResolution) || configuration.gridResolution < 4 || configuration.gridResolution > 64) {
		throw new Error("GPU particle interaction gridResolution must be an integer from 4 to 64.");
	}
}

function wgslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${webGpuShaderMarker}
zvibeInteractionRadius : f32,
zvibeInteractionRestitution : f32,
zvibeInteractionSeparationStrength : f32,
zvibeInteractionMaximumParticles : i32,
zvibeInteractionMaximumNeighbors : i32,
#endif
`;
}

function wgslInteractionBlock(): string {
	return `
#ifdef ${shaderDefine}
if (i32(index)<params.zvibeInteractionMaximumParticles) {
	var zvibeInteractionNeighborCount : i32=0;
	let zvibeInteractionLimit : i32=min(i32(params.currentCount),params.zvibeInteractionMaximumParticles);
	for (var zvibeInteractionIndex : i32=0; zvibeInteractionIndex<zvibeInteractionLimit; zvibeInteractionIndex=zvibeInteractionIndex+1) {
		if (zvibeInteractionIndex==i32(index)) {continue;}
		let zvibeInteractionOtherIndex : u32=u32(zvibeInteractionIndex);
		if (particlesIn.particles[zvibeInteractionOtherIndex].age+timeDelta>=particlesIn.particles[zvibeInteractionOtherIndex].life) {continue;}
		let zvibeInteractionOtherPosition : vec3<f32>=particlesIn.particles[zvibeInteractionOtherIndex].position;
		let zvibeInteractionDelta : vec3<f32>=particlesOut.particles[index].position-zvibeInteractionOtherPosition;
		let zvibeInteractionDistanceSquared : f32=dot(zvibeInteractionDelta,zvibeInteractionDelta);
		if (zvibeInteractionDistanceSquared<params.zvibeInteractionRadius*params.zvibeInteractionRadius) {
			var zvibeInteractionDistance : f32=0.0;
			var zvibeInteractionNormal : vec3<f32>=select(vec3<f32>(-1.0,0.0,0.0),vec3<f32>(1.0,0.0,0.0),index>zvibeInteractionOtherIndex);
			if (zvibeInteractionDistanceSquared>0.0000000001) {
				zvibeInteractionDistance=sqrt(zvibeInteractionDistanceSquared);
				zvibeInteractionNormal=zvibeInteractionDelta/zvibeInteractionDistance;
			}
			let zvibeInteractionOtherDirection : vec3<f32>=particlesIn.particles[zvibeInteractionOtherIndex].direction;
			let zvibeInteractionClosingVelocity : f32=dot(updatedDirection-zvibeInteractionOtherDirection,zvibeInteractionNormal);
			if (zvibeInteractionClosingVelocity<0.0) {
				updatedDirection=updatedDirection-zvibeInteractionNormal*((1.0+params.zvibeInteractionRestitution)*zvibeInteractionClosingVelocity*0.5);
			}
			particlesOut.particles[index].position=particlesOut.particles[index].position+zvibeInteractionNormal*((params.zvibeInteractionRadius-zvibeInteractionDistance)*params.zvibeInteractionSeparationStrength*0.5);
			zvibeInteractionNeighborCount=zvibeInteractionNeighborCount+1;
			if (zvibeInteractionNeighborCount>=params.zvibeInteractionMaximumNeighbors) {break;}
		}
	}
}
#endif
`;
}

function glslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${webGlShaderMarker}
uniform sampler2D zvibeInteractionOccupancySampler;
uniform vec3 zvibeInteractionBoundsMin;
uniform vec3 zvibeInteractionBoundsSize;
uniform float zvibeInteractionGridResolution;
uniform float zvibeInteractionRadius;
uniform float zvibeInteractionRestitution;
uniform float zvibeInteractionSeparationStrength;
uniform int zvibeInteractionMaximumParticles;
uniform int zvibeInteractionMaximumNeighbors;
#endif
`;
}

function glslInteractionBlock(): string {
	return `
#ifdef ${shaderDefine}
if (gl_VertexID<zvibeInteractionMaximumParticles) {
	vec3 zvibeInteractionNormalized=(outPosition-zvibeInteractionBoundsMin)/zvibeInteractionBoundsSize;
	if (all(greaterThanEqual(zvibeInteractionNormalized,vec3(0.0))) && all(lessThan(zvibeInteractionNormalized,vec3(1.0)))) {
		int zvibeInteractionResolution=int(zvibeInteractionGridResolution);
		ivec3 zvibeInteractionCell=clamp(ivec3(floor(zvibeInteractionNormalized*zvibeInteractionGridResolution)),ivec3(0),ivec3(zvibeInteractionResolution-1));
		vec3 zvibeInteractionCellSize=zvibeInteractionBoundsSize/zvibeInteractionGridResolution;
		float zvibeInteractionReach=zvibeInteractionRadius+0.5*length(zvibeInteractionCellSize);
		vec3 zvibeInteractionForce=vec3(0.0);
		int zvibeInteractionNeighborCount=0;
		for (int zvibeInteractionZ=-1; zvibeInteractionZ<=1; zvibeInteractionZ++) {
			for (int zvibeInteractionY=-1; zvibeInteractionY<=1; zvibeInteractionY++) {
				for (int zvibeInteractionX=-1; zvibeInteractionX<=1; zvibeInteractionX++) {
					ivec3 zvibeInteractionOtherCell=zvibeInteractionCell+ivec3(zvibeInteractionX,zvibeInteractionY,zvibeInteractionZ);
					if (any(lessThan(zvibeInteractionOtherCell,ivec3(0))) || any(greaterThanEqual(zvibeInteractionOtherCell,ivec3(zvibeInteractionResolution))) || zvibeInteractionNeighborCount>=zvibeInteractionMaximumNeighbors) {continue;}
					ivec2 zvibeInteractionTexel=ivec2(zvibeInteractionOtherCell.x+zvibeInteractionOtherCell.y*zvibeInteractionResolution,zvibeInteractionOtherCell.z);
					float zvibeInteractionDensity=texelFetch(zvibeInteractionOccupancySampler,zvibeInteractionTexel,0).r*255.0;
					if (all(equal(zvibeInteractionOtherCell,zvibeInteractionCell))) {zvibeInteractionDensity=max(0.0,zvibeInteractionDensity-1.0);}
					if (zvibeInteractionDensity<0.5) {continue;}
					vec3 zvibeInteractionOtherCenter=zvibeInteractionBoundsMin+(vec3(zvibeInteractionOtherCell)+vec3(0.5))*zvibeInteractionCellSize;
					vec3 zvibeInteractionDelta=outPosition-zvibeInteractionOtherCenter;
					float zvibeInteractionDistance=length(zvibeInteractionDelta);
					if (zvibeInteractionDistance>=zvibeInteractionReach) {continue;}
					vec3 zvibeInteractionNormal;
					if (zvibeInteractionDistance>0.000001) {zvibeInteractionNormal=zvibeInteractionDelta/zvibeInteractionDistance;}
					else {zvibeInteractionNormal=normalize(seed.xyz*2.0-vec3(1.0)+vec3(0.0001,0.0002,0.0003));}
					float zvibeInteractionAccepted=min(zvibeInteractionDensity,float(zvibeInteractionMaximumNeighbors-zvibeInteractionNeighborCount));
					zvibeInteractionForce+=zvibeInteractionNormal*zvibeInteractionAccepted*(1.0-zvibeInteractionDistance/zvibeInteractionReach);
					zvibeInteractionNeighborCount+=int(ceil(zvibeInteractionAccepted));
				}
			}
		}
		float zvibeInteractionForceLength=length(zvibeInteractionForce);
		if (zvibeInteractionForceLength>0.000001) {
			vec3 zvibeInteractionNormal=zvibeInteractionForce/zvibeInteractionForceLength;
			float zvibeInteractionVelocity=dot(updatedDirection,zvibeInteractionNormal);
			if (zvibeInteractionVelocity<0.0) {updatedDirection-=zvibeInteractionNormal*((1.0+zvibeInteractionRestitution)*zvibeInteractionVelocity);}
			outPosition+=zvibeInteractionNormal*zvibeInteractionRadius*zvibeInteractionSeparationStrength*min(1.0,zvibeInteractionForceLength)*0.5;
		}
	}
}
#endif
`;
}

function replaceOnce(source: string, needle: string, replacement: string, language: string): string {
	const index = source.indexOf(needle);
	if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
		throw new Error(`Babylon ${language} GPU particle shader changed; pairwise interaction injection point is not exact.`);
	}
	return source.replace(needle, replacement);
}

/** Installs guarded native pairwise/occupancy collision code into Babylon's GPU particle shaders. */
export function installGpuParticleInteractionShader(): void {
	const wgslName = "gpuUpdateParticlesComputeShader";
	const glslName = "gpuUpdateParticlesVertexShader";
	let wgsl = ShaderStore.ShadersStoreWGSL[wgslName];
	let glsl = ShaderStore.ShadersStore[glslName];
	if (!wgsl || !glsl) {
		throw new Error("Babylon GPU particle update shaders are not registered.");
	}
	if (!wgsl.includes(webGpuShaderMarker)) {
		wgsl = replaceOnce(wgsl, "};@binding(0) @group(0) var<uniform> params : SimParams;", `${wgslUniforms()}\n};@binding(0) @group(0) var<uniform> params : SimParams;`, "WGSL");
		wgsl = replaceOnce(
			wgsl,
			"particlesOut.particles[index].direction=updatedDirection;",
			`${wgslInteractionBlock()}\nparticlesOut.particles[index].direction=updatedDirection;`,
			"WGSL"
		);
		ShaderStore.ShadersStoreWGSL[wgslName] = wgsl;
	}
	if (!glsl.includes(webGlShaderMarker)) {
		glsl = replaceOnce(glsl, "uniform vec3 gravity;", `${glslUniforms()}\nuniform vec3 gravity;`, "GLSL");
		glsl = replaceOnce(glsl, "outDirection=updatedDirection;", `${glslInteractionBlock()}\noutDirection=updatedDirection;`, "GLSL");
		ShaderStore.ShadersStore[glslName] = glsl;
	}
}

function compileShader(gl: any, type: number, source: string): any {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const message = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`WebGL2 occupancy shader compilation failed: ${message}`);
	}
	return shader;
}

function createOccupancyResources(system: any, configuration: IGpuParticleInteractionConfiguration): IOccupancyResources {
	const engine = system.getScene?.()?.getEngine?.();
	const gl = engine?._gl;
	if (!gl || (engine.webGLVersion ?? 0) < 2) {
		throw new Error("Native occupancy-field particle interactions require a WebGL2 engine.");
	}
	const resolution = configuration.gridResolution;
	const width = resolution * resolution;
	const height = resolution;
	if (width > engine.getCaps().maxTextureSize) {
		throw new Error(`Occupancy grid ${resolution} requires texture width ${width}, above this WebGL2 target's ${engine.getCaps().maxTextureSize} limit.`);
	}
	const texture = RawTexture.CreateRGBATexture(
		new Uint8Array(width * height * 4),
		width,
		height,
		system.getScene?.() ?? engine,
		false,
		false,
		Texture.NEAREST_SAMPLINGMODE,
		Constants.TEXTURETYPE_UNSIGNED_BYTE
	);
	texture.name = `${system.name} GPU Particle Occupancy Field`;
	const framebuffer = gl.createFramebuffer();
	const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, (texture as any)._texture?._hardwareTexture?.underlyingResource, 0);
	const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
	gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
	if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
		gl.deleteFramebuffer(framebuffer);
		texture.dispose();
		throw new Error(`WebGL2 occupancy framebuffer is incomplete (${framebufferStatus}).`);
	}
	const vertex = compileShader(
		gl,
		gl.VERTEX_SHADER,
		`#version 300 es
in vec3 position;
in float age;
in float life;
uniform vec3 boundsMin;
uniform vec3 boundsSize;
uniform float gridResolution;
void main() {
	vec3 normalized=(position-boundsMin)/boundsSize;
	bool zvibeActiveParticle=life>0.0 && age<life && all(greaterThanEqual(normalized,vec3(0.0))) && all(lessThan(normalized,vec3(1.0)));
	if (!zvibeActiveParticle) {gl_Position=vec4(2.0,2.0,0.0,1.0);gl_PointSize=1.0;return;}
	ivec3 cell=clamp(ivec3(floor(normalized*gridResolution)),ivec3(0),ivec3(int(gridResolution)-1));
	float width=gridResolution*gridResolution;
	float zvibeFlatIndex=float(cell.x+cell.y*int(gridResolution));
	gl_Position=vec4((zvibeFlatIndex+0.5)/width*2.0-1.0,(float(cell.z)+0.5)/gridResolution*2.0-1.0,0.0,1.0);
	gl_PointSize=1.0;
}`
	);
	const fragment = compileShader(
		gl,
		gl.FRAGMENT_SHADER,
		`#version 300 es
precision highp float;
out vec4 occupancy;
void main() {occupancy=vec4(1.0/255.0,0.0,0.0,0.0);}`
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
		texture.dispose();
		throw new Error(`WebGL2 occupancy program link failed: ${message}`);
	}
	return {
		resolution,
		width,
		height,
		texture,
		framebuffer,
		program,
		positionLocation: gl.getAttribLocation(program, "position"),
		ageLocation: gl.getAttribLocation(program, "age"),
		lifeLocation: gl.getAttribLocation(program, "life"),
		boundsMinLocation: gl.getUniformLocation(program, "boundsMin"),
		boundsSizeLocation: gl.getUniformLocation(program, "boundsSize"),
		resolutionLocation: gl.getUniformLocation(program, "gridResolution"),
		vertexArrays: new Map(),
	};
}

function disposeOccupancyResources(system: any, resources: IOccupancyResources | undefined): void {
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
	resources.texture.dispose();
	if (occupancyResources.get(system) === resources) {
		occupancyResources.delete(system);
	}
}

function occupancyVertexArray(system: any, resources: IOccupancyResources): any {
	const gl = system.getScene().getEngine()._gl;
	const source = system._sourceBuffer?.getBuffer?.();
	const buffer = source?.underlyingResource;
	if (!buffer) {
		throw new Error("WebGL2 particle source buffer is not initialized for occupancy rasterization.");
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
		[resources.ageLocation, 1, 3 * 4],
		[resources.lifeLocation, 1, 7 * 4],
	] as number[][]) {
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
	}
	gl.bindVertexArray(null);
	resources.vertexArrays.set(buffer, vertexArray);
	return vertexArray;
}

function buildOccupancyField(system: any, currentActiveCount: number): void {
	const configuration = configurations.get(system);
	const resources = occupancyResources.get(system);
	if (!configuration?.enabled || !resources) {
		return;
	}
	const engine = system.getScene().getEngine();
	const gl = engine._gl;
	const viewport = gl.getParameter(gl.VIEWPORT);
	const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const scissorEnabled = gl.isEnabled(gl.SCISSOR_TEST);
	const blendEnabled = gl.isEnabled(gl.BLEND);
	const depthEnabled = gl.isEnabled(gl.DEPTH_TEST);
	const cullEnabled = gl.isEnabled(gl.CULL_FACE);
	const discardEnabled = gl.isEnabled(gl.RASTERIZER_DISCARD);
	const colorMask = gl.getParameter(gl.COLOR_WRITEMASK);
	const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE);
	const blendSourceRgb = gl.getParameter(gl.BLEND_SRC_RGB);
	const blendDestinationRgb = gl.getParameter(gl.BLEND_DST_RGB);
	const blendSourceAlpha = gl.getParameter(gl.BLEND_SRC_ALPHA);
	const blendDestinationAlpha = gl.getParameter(gl.BLEND_DST_ALPHA);
	const blendEquationRgb = gl.getParameter(gl.BLEND_EQUATION_RGB);
	const blendEquationAlpha = gl.getParameter(gl.BLEND_EQUATION_ALPHA);
	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
		gl.viewport(0, 0, resources.width, resources.height);
		gl.disable(gl.SCISSOR_TEST);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.RASTERIZER_DISCARD);
		gl.colorMask(true, true, true, true);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE);
		gl.useProgram(resources.program);
		gl.uniform3fv(resources.boundsMinLocation, configuration.boundsMin);
		gl.uniform3f(
			resources.boundsSizeLocation,
			configuration.boundsMax[0] - configuration.boundsMin[0],
			configuration.boundsMax[1] - configuration.boundsMin[1],
			configuration.boundsMax[2] - configuration.boundsMin[2]
		);
		gl.uniform1f(resources.resolutionLocation, configuration.gridResolution);
		gl.bindVertexArray(occupancyVertexArray(system, resources));
		const inputCount = Math.min(Math.max(0, currentActiveCount), configuration.maximumParticles);
		gl.drawArrays(gl.POINTS, 0, inputCount);
		const state = runtimeStates.get(system);
		if (state) {
			state.occupancyBuildCount++;
			state.occupancyInputParticleCount = inputCount;
		}
	} finally {
		gl.bindVertexArray(null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
		gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
		gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
		gl.blendEquationSeparate(blendEquationRgb, blendEquationAlpha);
		gl.blendFuncSeparate(blendSourceRgb, blendDestinationRgb, blendSourceAlpha, blendDestinationAlpha);
		for (const [capability, enabled] of [
			[gl.SCISSOR_TEST, scissorEnabled],
			[gl.BLEND, blendEnabled],
			[gl.DEPTH_TEST, depthEnabled],
			[gl.CULL_FACE, cullEnabled],
			[gl.RASTERIZER_DISCARD, discardEnabled],
		] as Array<[number, boolean]>) {
			enabled ? gl.enable(capability) : gl.disable(capability);
		}
		engine.wipeCaches(true);
		engine.enableEffect(system._platform._updateEffect);
	}
}

function webGlSupport(system: any, configuration: IGpuParticleInteractionConfiguration | null): { supported: boolean; reason: string | null } {
	const engine = system.getScene?.()?.getEngine?.();
	if (!engine?._gl || (engine.webGLVersion ?? 0) < 2) {
		return { supported: false, reason: "Native occupancy-field particle interactions require WebGL2." };
	}
	const width = (configuration?.gridResolution ?? 0) ** 2;
	if (width > engine.getCaps().maxTextureSize) {
		return { supported: false, reason: `Occupancy grid requires texture width ${width}, above this target's ${engine.getCaps().maxTextureSize} limit.` };
	}
	return { supported: true, reason: null };
}

function setUniforms(system: any): void {
	const configuration = configurations.get(system);
	if (!configuration?.enabled) {
		return;
	}
	const buffer = system._updateBuffer;
	buffer.setFloat("zvibeInteractionRadius", configuration.radius);
	buffer.setFloat("zvibeInteractionRestitution", configuration.restitution);
	buffer.setFloat("zvibeInteractionSeparationStrength", configuration.separationStrength);
	buffer.setInt("zvibeInteractionMaximumParticles", configuration.maximumParticles);
	buffer.setInt("zvibeInteractionMaximumNeighbors", configuration.maximumNeighbors);
	if (!system.getScene().getEngine().isWebGPU) {
		buffer.setFloat3("zvibeInteractionBoundsMin", configuration.boundsMin[0], configuration.boundsMin[1], configuration.boundsMin[2]);
		buffer.setFloat3(
			"zvibeInteractionBoundsSize",
			configuration.boundsMax[0] - configuration.boundsMin[0],
			configuration.boundsMax[1] - configuration.boundsMin[1],
			configuration.boundsMax[2] - configuration.boundsMin[2]
		);
		buffer.setFloat("zvibeInteractionGridResolution", configuration.gridResolution);
	}
}

function installSystemHooks(system: any): void {
	if (installedSystems.has(system)) {
		return;
	}
	installGpuParticleInteractionShader();
	const platform = system._platform;
	if (!platform?.createUpdateBuffer || !platform?.updateParticleBuffer) {
		throw new Error("Unsupported Babylon GPU particle platform internals.");
	}
	const isWebGpu = system.getScene().getEngine().isWebGPU === true;
	if (!isWebGpu) {
		const uniformNames = [
			"zvibeInteractionBoundsMin",
			"zvibeInteractionBoundsSize",
			"zvibeInteractionGridResolution",
			"zvibeInteractionRadius",
			"zvibeInteractionRestitution",
			"zvibeInteractionSeparationStrength",
			"zvibeInteractionMaximumParticles",
			"zvibeInteractionMaximumNeighbors",
		];
		platform._updateEffectOptions.uniformsNames.push(...uniformNames);
		platform._baseUniformsNamesLength += uniformNames.length;
		platform._updateEffectOptions.samplers.push("zvibeInteractionOccupancySampler");
	}
	const originalCreateUpdateBuffer = platform.createUpdateBuffer.bind(platform);
	platform.createUpdateBuffer = (defines: string): any => {
		const configuration = configurations.get(system);
		const support = isWebGpu ? { supported: true } : webGlSupport(system, configuration ?? null);
		const configuredDefines = configuration?.enabled && support.supported ? `${defines}\n#define ${shaderDefine}` : defines;
		const accessor = originalCreateUpdateBuffer(configuredDefines);
		const state = runtimeStates.get(system);
		if (state) {
			state.lastCompiledWithInteractions = configuredDefines.includes(`#define ${shaderDefine}`);
		}
		if (isWebGpu && configuration?.enabled) {
			const buffer = platform._simParamsComputeShader;
			buffer.addUniform("zvibeInteractionRadius", 1);
			buffer.addUniform("zvibeInteractionRestitution", 1);
			buffer.addUniform("zvibeInteractionSeparationStrength", 1);
			buffer.addUniform("zvibeInteractionMaximumParticles", 1);
			buffer.addUniform("zvibeInteractionMaximumNeighbors", 1);
		}
		return accessor;
	};
	const originalUpdateParticleBuffer = platform.updateParticleBuffer.bind(platform);
	platform.updateParticleBuffer = (...args: any[]): void => {
		const configuration = configurations.get(system);
		if (configuration?.enabled) {
			if (!isWebGpu) {
				buildOccupancyField(system, args[2] ?? 0);
				platform._updateEffect.setTexture("zvibeInteractionOccupancySampler", occupancyResources.get(system)?.texture);
			}
			setUniforms(system);
		}
		originalUpdateParticleBuffer(...args);
		if (configuration?.enabled) {
			const state = runtimeStates.get(system);
			if (state) {
				state.nativeDispatchCount++;
			}
		}
	};
	runtimeStates.set(system, { lastCompiledWithInteractions: false, nativeDispatchCount: 0, occupancyBuildCount: 0, occupancyInputParticleCount: 0 });
	system.onDisposeObservable?.addOnce(() => disposeOccupancyResources(system, occupancyResources.get(system)));
	installedSystems.add(system);
}

/** Configures bounded native pairwise/occupancy particle collision on a Babylon GPU particle system. */
export function configureGpuParticleInteractions(system: any, configuration: IGpuParticleInteractionConfiguration | null): IGpuParticleInteractionRuntimeEvidence {
	if (system.getClassName?.() !== "GPUParticleSystem") {
		throw new Error("Native GPU particle interactions require a GPUParticleSystem.");
	}
	const next = configuration ? normalizeConfiguration(configuration) : null;
	if (next) {
		validateConfiguration(next);
	}
	const previous = configurations.get(system);
	const isWebGpu = system.getScene?.()?.getEngine?.().isWebGPU === true;
	const existingResources = occupancyResources.get(system);
	let replacementResources: IOccupancyResources | undefined;
	try {
		if (!isWebGpu && next?.enabled && existingResources?.resolution !== next.gridResolution) {
			replacementResources = createOccupancyResources(system, next);
		}
		configurations.set(system, next);
		installSystemHooks(system);
		system._resetEffect();
		system._cachedUpdateDefines = "__zvibe_gpu_particle_interaction_configuration_changed__";
		if (!isWebGpu) {
			if (replacementResources) {
				occupancyResources.set(system, replacementResources);
				disposeOccupancyResources(system, existingResources);
			} else if (!next?.enabled) {
				disposeOccupancyResources(system, existingResources);
			}
		}
	} catch (error) {
		if (replacementResources) {
			disposeOccupancyResources(system, replacementResources);
		}
		configurations.set(system, previous ?? null);
		throw error;
	}
	return getGpuParticleInteractionRuntimeEvidence(system);
}

/** Returns exact backend/support/dispatch evidence for pairwise GPU particle interaction. */
export function getGpuParticleInteractionRuntimeEvidence(system: any): IGpuParticleInteractionRuntimeEvidence {
	const isWebGpu = system.getScene?.()?.getEngine?.().isWebGPU === true;
	const configuration = configurations.get(system);
	const state = runtimeStates.get(system) ?? { lastCompiledWithInteractions: false, nativeDispatchCount: 0, occupancyBuildCount: 0, occupancyInputParticleCount: 0 };
	const resources = occupancyResources.get(system);
	const support = isWebGpu ? { supported: true, reason: null } : webGlSupport(system, configuration ?? null);
	const configuredMaximumParticles = configuration?.maximumParticles ?? 0;
	const configuredMaximumNeighbors = configuration?.maximumNeighbors ?? 0;
	const activeParticleLimit = configuration?.enabled ? Math.min(Math.max(0, Math.floor(system._currentActiveCount ?? 0)), configuredMaximumParticles) : 0;
	return {
		nativeGpu: true,
		backend: isWebGpu ? "webgpu-compute" : "webgl2-transform-feedback",
		executionModel: isWebGpu ? "bounded-webgpu-pairwise-particle-collision-v1" : "bounded-webgl2-occupancy-field-collision-v1",
		enabled: configuration?.enabled === true,
		supported: support.supported,
		unsupportedReason: support.reason,
		shaderInstalled: isWebGpu
			? ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader?.includes(webGpuShaderMarker) === true
			: ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader?.includes(webGlShaderMarker) === true,
		hooksInstalled: installedSystems.has(system),
		lastCompiledWithInteractions: state.lastCompiledWithInteractions,
		nativeDispatchCount: state.nativeDispatchCount,
		configuredMaximumParticles,
		configuredMaximumNeighbors,
		activeParticleLimit,
		pairTestUpperBound: isWebGpu ? activeParticleLimit * Math.max(0, activeParticleLimit - 1) : 0,
		occupancyFieldReady: !isWebGpu && Boolean(resources?.texture.isReady()),
		occupancyGridResolution: configuration?.gridResolution ?? 0,
		occupancyTextureSize: resources ? [resources.width, resources.height] : [0, 0],
		occupancyBuildCount: state.occupancyBuildCount,
		occupancyInputParticleCount: state.occupancyInputParticleCount,
		occupancySampleUpperBound: isWebGpu ? 0 : activeParticleLimit * 27,
		occupancyNeighborStencil: isWebGpu ? null : "3x3x3",
	};
}

import "@babylonjs/core/Shaders/gpuUpdateParticles.vertex";
import "@babylonjs/core/ShadersWGSL/gpuUpdateParticles.compute";

import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { RawTexture3D } from "@babylonjs/core/Materials/Textures/rawTexture3D";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

export interface IParticleTextureVectorField {
	min: number[];
	max: number[];
	strength: number;
	width: number;
	height: number;
	depth?: number;
	vectors: number[];
	sourcePath?: string;
	enabled?: boolean;
}

export interface IGpuParticleTextureVectorFieldRuntimeEvidence {
	nativeGpu: true;
	backend: "webgpu-compute" | "webgl2-transform-feedback";
	executionModel: "native-gpu-rgba8-3d-vector-field-atlas-v1";
	enabled: boolean;
	supported: boolean;
	unsupportedReason: string | null;
	shaderInstalled: boolean;
	hooksInstalled: boolean;
	lastCompiledWithVectorFields: boolean;
	nativeDispatchCount: number;
	fieldCount: number;
	atlasReady: boolean;
	atlasDimensions: number[];
	atlasVoxelCount: number;
	activeParticleCount: number;
	sampleUpperBound: number;
	sampling: "trilinear-3d";
	encoding: "rgba8-signed-vector-with-per-field-scale";
	gpuReadback: false;
}

export interface IGpuParticleTextureVectorFieldAtlasData {
	width: number;
	height: number;
	depth: number;
	data: Uint8Array;
	descriptors: Array<{
		min: number[];
		inverseSize: number[];
		resolutionOffset: number[];
		strengthScale: number;
	}>;
}

type IAtlasResources = IGpuParticleTextureVectorFieldAtlasData & { texture: RawTexture3D };
type IRuntimeState = { lastCompiledWithVectorFields: boolean; nativeDispatchCount: number };

const maxFields = 8;
const maxResolution = 64;
const maxAtlasVoxels = maxFields * maxResolution * maxResolution * maxResolution;
const shaderDefine = "ZVIBE_GPU_TEXTURE_VECTOR_FIELDS";
const glslMarker = "ZVIBE_NATIVE_WEBGL2_TEXTURE_3D_VECTOR_FIELD_V1";
const wgslMarker = "ZVIBE_NATIVE_WEBGPU_TEXTURE_3D_VECTOR_FIELD_V1";
const configurations = new WeakMap<object, IParticleTextureVectorField[]>();
const installedSystems = new WeakSet<object>();
const runtimeStates = new WeakMap<object, IRuntimeState>();
const atlasResources = new WeakMap<object, IAtlasResources>();

function validateField(field: IParticleTextureVectorField, index: number): void {
	if (![field.min, field.max].every((value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite))) {
		throw new Error(`Texture vector field ${index} min and max must contain three finite values.`);
	}
	if (field.min.some((value, axis) => value >= field.max[axis])) {
		throw new Error(`Texture vector field ${index} min must be less than max on every axis.`);
	}
	if (!Number.isFinite(field.strength)) {
		throw new Error(`Texture vector field ${index} strength must be finite.`);
	}
	if (field.enabled !== undefined && typeof field.enabled !== "boolean") {
		throw new Error(`Texture vector field ${index} enabled must be a boolean when provided.`);
	}
	const depth = field.depth ?? 1;
	if (
		!Number.isInteger(field.width) ||
		!Number.isInteger(field.height) ||
		!Number.isInteger(depth) ||
		field.width < 1 ||
		field.height < 1 ||
		depth < 1 ||
		field.width > maxResolution ||
		field.height > maxResolution ||
		depth > maxResolution
	) {
		throw new Error(`Texture vector field ${index} resolution must be from 1×1×1 through ${maxResolution}×${maxResolution}×${maxResolution}.`);
	}
	if (!Array.isArray(field.vectors) || field.vectors.length !== field.width * field.height * depth * 3 || field.vectors.some((value) => !Number.isFinite(value))) {
		throw new Error(`Texture vector field ${index} must contain exactly width × height × depth × 3 finite vector values.`);
	}
}

/** Builds one bounded 3D atlas without creating a GPU resource. Exported for deterministic validation and tests. */
export function buildGpuParticleTextureVectorFieldAtlas(fields: IParticleTextureVectorField[]): IGpuParticleTextureVectorFieldAtlasData | null {
	if (!Array.isArray(fields) || fields.length > maxFields) {
		throw new Error(`Texture vector fields must contain from zero to ${maxFields} fields.`);
	}
	fields.forEach(validateField);
	const enabled = fields.filter((field) => field.enabled !== false);
	if (!enabled.length) {
		return null;
	}
	const width = Math.max(...enabled.map((field) => field.width));
	const height = Math.max(...enabled.map((field) => field.height));
	const depth = enabled.reduce((sum, field) => sum + (field.depth ?? 1), 0);
	const voxelCount = width * height * depth;
	if (voxelCount > maxAtlasVoxels) {
		throw new Error(`GPU texture vector-field atlas requires ${voxelCount} voxels, above the ${maxAtlasVoxels} bound.`);
	}
	const data = new Uint8Array(voxelCount * 4);
	const descriptors: IGpuParticleTextureVectorFieldAtlasData["descriptors"] = [];
	let depthOffset = 0;
	for (const field of enabled) {
		const fieldDepth = field.depth ?? 1;
		const vectorScale = Math.max(1, ...field.vectors.map(Math.abs));
		for (let z = 0; z < fieldDepth; z++) {
			for (let y = 0; y < field.height; y++) {
				for (let x = 0; x < field.width; x++) {
					const source = ((z * field.height + y) * field.width + x) * 3;
					const target = (((z + depthOffset) * height + y) * width + x) * 4;
					for (let component = 0; component < 3; component++) {
						const normalized = Math.max(-1, Math.min(1, field.vectors[source + component] / vectorScale));
						data[target + component] = Math.round((normalized * 0.5 + 0.5) * 255);
					}
					data[target + 3] = 255;
				}
			}
		}
		descriptors.push({
			min: [...field.min],
			inverseSize: field.max.map((value, axis) => 1 / (value - field.min[axis])),
			resolutionOffset: [field.width, field.height, fieldDepth, depthOffset],
			strengthScale: field.strength * vectorScale,
		});
		depthOffset += fieldDepth;
	}
	return { width, height, depth, data, descriptors };
}

function glslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${glslMarker}
precision highp sampler3D;
uniform sampler3D zvibeTextureVectorFieldAtlas;
uniform int zvibeTextureVectorFieldCount;
uniform vec3 zvibeTextureVectorFieldAtlasInverseSize;
${Array.from({ length: maxFields }, (_, index) => `uniform vec4 zvibeTextureVectorFieldMinStrength${index};\nuniform vec4 zvibeTextureVectorFieldInverseSize${index};\nuniform vec4 zvibeTextureVectorFieldResolutionOffset${index};`).join("\n")}
#endif
`;
}

function glslFieldBlock(index: number): string {
	return `
if (zvibeTextureVectorFieldCount>${index}) {
	vec3 zvibeFieldLocal${index}=(outPosition-zvibeTextureVectorFieldMinStrength${index}.xyz)*zvibeTextureVectorFieldInverseSize${index}.xyz;
	if (all(greaterThanEqual(zvibeFieldLocal${index},vec3(0.0))) && all(lessThanEqual(zvibeFieldLocal${index},vec3(1.0)))) {
		vec4 zvibeFieldResolution${index}=zvibeTextureVectorFieldResolutionOffset${index};
		vec3 zvibeFieldAtlasUv${index}=vec3(
			(zvibeFieldLocal${index}.x*(zvibeFieldResolution${index}.x-1.0)+0.5)*zvibeTextureVectorFieldAtlasInverseSize.x,
			(zvibeFieldLocal${index}.y*(zvibeFieldResolution${index}.y-1.0)+0.5)*zvibeTextureVectorFieldAtlasInverseSize.y,
			(zvibeFieldResolution${index}.w+zvibeFieldLocal${index}.z*(zvibeFieldResolution${index}.z-1.0)+0.5)*zvibeTextureVectorFieldAtlasInverseSize.z
		);
		vec3 zvibeFieldVector${index}=texture(zvibeTextureVectorFieldAtlas,zvibeFieldAtlasUv${index}).xyz*2.0-vec3(1.0);
		updatedDirection+=zvibeFieldVector${index}*zvibeTextureVectorFieldMinStrength${index}.w*timeDelta;
	}
}`;
}

function glslApplication(): string {
	return `
#ifdef ${shaderDefine}
${Array.from({ length: maxFields }, (_, index) => glslFieldBlock(index)).join("\n")}
#endif
`;
}

function wgslUniforms(): string {
	return `
#ifdef ${shaderDefine}
// ${wgslMarker}
zvibeTextureVectorFieldCount : i32,
zvibeTextureVectorFieldAtlasInverseSize : vec3<f32>,
${Array.from({ length: maxFields }, (_, index) => `zvibeTextureVectorFieldMinStrength${index} : vec4<f32>,\nzvibeTextureVectorFieldInverseSize${index} : vec4<f32>,\nzvibeTextureVectorFieldResolutionOffset${index} : vec4<f32>,`).join("\n")}
#endif
`;
}

function wgslFieldBlock(index: number): string {
	return `
if (params.zvibeTextureVectorFieldCount>${index}) {
	let zvibeFieldLocal${index} : vec3<f32>=(particlesOut.particles[index].position-params.zvibeTextureVectorFieldMinStrength${index}.xyz)*params.zvibeTextureVectorFieldInverseSize${index}.xyz;
	if (all(zvibeFieldLocal${index}>=vec3<f32>(0.0)) && all(zvibeFieldLocal${index}<=vec3<f32>(1.0))) {
		let zvibeFieldResolution${index} : vec4<f32>=params.zvibeTextureVectorFieldResolutionOffset${index};
		let zvibeFieldAtlasUv${index} : vec3<f32>=vec3<f32>(
			(zvibeFieldLocal${index}.x*(zvibeFieldResolution${index}.x-1.0)+0.5)*params.zvibeTextureVectorFieldAtlasInverseSize.x,
			(zvibeFieldLocal${index}.y*(zvibeFieldResolution${index}.y-1.0)+0.5)*params.zvibeTextureVectorFieldAtlasInverseSize.y,
			(zvibeFieldResolution${index}.w+zvibeFieldLocal${index}.z*(zvibeFieldResolution${index}.z-1.0)+0.5)*params.zvibeTextureVectorFieldAtlasInverseSize.z
		);
		let zvibeFieldVector${index} : vec3<f32>=textureSampleLevel(zvibeTextureVectorFieldAtlas,zvibeTextureVectorFieldSampler,zvibeFieldAtlasUv${index},0.0).xyz*2.0-vec3<f32>(1.0);
		updatedDirection=updatedDirection+zvibeFieldVector${index}*params.zvibeTextureVectorFieldMinStrength${index}.w*timeDelta;
	}
}`;
}

function wgslApplication(): string {
	return `
#ifdef ${shaderDefine}
${Array.from({ length: maxFields }, (_, index) => wgslFieldBlock(index)).join("\n")}
#endif
`;
}

function replaceOnce(source: string, needle: string, replacement: string, language: string): string {
	const index = source.indexOf(needle);
	if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
		throw new Error(`Babylon ${language} GPU particle shader changed; texture vector-field injection point is not exact.`);
	}
	return source.replace(needle, replacement);
}

/** Installs guarded native 3D-vector-texture sampling into Babylon's two GPU update shaders. */
export function installGpuParticleTextureVectorFieldShaders(): void {
	const glslName = "gpuUpdateParticlesVertexShader";
	const wgslName = "gpuUpdateParticlesComputeShader";
	let glsl = ShaderStore.ShadersStore[glslName];
	let wgsl = ShaderStore.ShadersStoreWGSL[wgslName];
	if (!glsl || !wgsl) {
		throw new Error("Babylon GPU particle update shaders are not registered.");
	}
	if (!glsl.includes(glslMarker)) {
		glsl = replaceOnce(glsl, "uniform vec3 gravity;", `${glslUniforms()}\nuniform vec3 gravity;`, "GLSL");
		glsl = replaceOnce(glsl, "outDirection=updatedDirection;", `${glslApplication()}\noutDirection=updatedDirection;`, "GLSL");
		ShaderStore.ShadersStore[glslName] = glsl;
	}
	if (!wgsl.includes(wgslMarker)) {
		wgsl = replaceOnce(wgsl, "};@binding(0) @group(0) var<uniform> params : SimParams;", `${wgslUniforms()}\n};@binding(0) @group(0) var<uniform> params : SimParams;`, "WGSL");
		wgsl = replaceOnce(
			wgsl,
			"@binding(1) @group(0) var<storage,read> particlesIn : Particles;",
			`@binding(16) @group(1) var zvibeTextureVectorFieldSampler : sampler;\n@binding(17) @group(1) var zvibeTextureVectorFieldAtlas : texture_3d<f32>;\n@binding(1) @group(0) var<storage,read> particlesIn : Particles;`,
			"WGSL"
		);
		wgsl = replaceOnce(
			wgsl,
			"particlesOut.particles[index].direction=updatedDirection;",
			`${wgslApplication()}\nparticlesOut.particles[index].direction=updatedDirection;`,
			"WGSL"
		);
		ShaderStore.ShadersStoreWGSL[wgslName] = wgsl;
	}
}

function support(system: any, atlas: IGpuParticleTextureVectorFieldAtlasData | null): { supported: boolean; reason: string | null } {
	const engine = system.getScene?.()?.getEngine?.();
	if (!engine) {
		return { supported: false, reason: "GPU particle system is not attached to an engine." };
	}
	if (!engine.isWebGPU && (engine.webGLVersion ?? 0) < 2) {
		return { supported: false, reason: "Native 3D texture vector fields require WebGL2 or WebGPU." };
	}
	if (!atlas) {
		return { supported: true, reason: null };
	}
	const glMaximum = engine._gl?.MAX_3D_TEXTURE_SIZE ? engine._gl.getParameter(engine._gl.MAX_3D_TEXTURE_SIZE) : Number.POSITIVE_INFINITY;
	const webGpuMaximum = engine._device?.limits?.maxTextureDimension3D ?? Number.POSITIVE_INFINITY;
	const maximum = Math.min(glMaximum, webGpuMaximum);
	if (Math.max(atlas.width, atlas.height, atlas.depth) > maximum) {
		return { supported: false, reason: `Vector-field atlas ${atlas.width}×${atlas.height}×${atlas.depth} exceeds this GPU's ${maximum} 3D-texture limit.` };
	}
	return { supported: true, reason: null };
}

function createAtlasResources(system: any, fields: IParticleTextureVectorField[]): IAtlasResources | undefined {
	const atlas = buildGpuParticleTextureVectorFieldAtlas(fields);
	if (!atlas) {
		return undefined;
	}
	const availability = support(system, atlas);
	if (!availability.supported) {
		throw new Error(availability.reason ?? "Native 3D texture vector fields are unsupported.");
	}
	const texture = new RawTexture3D(
		atlas.data,
		atlas.width,
		atlas.height,
		atlas.depth,
		Constants.TEXTUREFORMAT_RGBA,
		system.getScene(),
		false,
		false,
		Texture.TRILINEAR_SAMPLINGMODE,
		Constants.TEXTURETYPE_UNSIGNED_BYTE
	);
	texture.name = `${system.name} Native GPU Vector Field Atlas`;
	texture.wrapU = Texture.CLAMP_ADDRESSMODE;
	texture.wrapV = Texture.CLAMP_ADDRESSMODE;
	texture.wrapR = Texture.CLAMP_ADDRESSMODE;
	return { ...atlas, texture };
}

function disposeResources(system: any, resources: IAtlasResources | undefined): void {
	if (!resources) {
		return;
	}
	resources.texture.dispose();
	if (atlasResources.get(system) === resources) {
		atlasResources.delete(system);
	}
}

function uniformNames(): string[] {
	const result = ["zvibeTextureVectorFieldCount", "zvibeTextureVectorFieldAtlasInverseSize"];
	for (let index = 0; index < maxFields; index++) {
		result.push(`zvibeTextureVectorFieldMinStrength${index}`, `zvibeTextureVectorFieldInverseSize${index}`, `zvibeTextureVectorFieldResolutionOffset${index}`);
	}
	return result;
}

function addWebGpuUniformLayout(platform: any): void {
	const buffer = platform._simParamsComputeShader;
	buffer.addUniform("zvibeTextureVectorFieldCount", 1);
	buffer.addUniform("zvibeTextureVectorFieldAtlasInverseSize", 3);
	for (let index = 0; index < maxFields; index++) {
		buffer.addUniform(`zvibeTextureVectorFieldMinStrength${index}`, 4);
		buffer.addUniform(`zvibeTextureVectorFieldInverseSize${index}`, 4);
		buffer.addUniform(`zvibeTextureVectorFieldResolutionOffset${index}`, 4);
	}
}

function setUniforms(system: any, resources: IAtlasResources): void {
	const buffer = system._updateBuffer;
	buffer.setInt("zvibeTextureVectorFieldCount", resources.descriptors.length);
	buffer.setFloat3("zvibeTextureVectorFieldAtlasInverseSize", 1 / resources.width, 1 / resources.height, 1 / resources.depth);
	for (let index = 0; index < maxFields; index++) {
		const descriptor = resources.descriptors[index];
		buffer.setFloat4(`zvibeTextureVectorFieldMinStrength${index}`, descriptor?.min[0] ?? 0, descriptor?.min[1] ?? 0, descriptor?.min[2] ?? 0, descriptor?.strengthScale ?? 0);
		buffer.setFloat4(`zvibeTextureVectorFieldInverseSize${index}`, descriptor?.inverseSize[0] ?? 0, descriptor?.inverseSize[1] ?? 0, descriptor?.inverseSize[2] ?? 0, 0);
		buffer.setFloat4(
			`zvibeTextureVectorFieldResolutionOffset${index}`,
			descriptor?.resolutionOffset[0] ?? 0,
			descriptor?.resolutionOffset[1] ?? 0,
			descriptor?.resolutionOffset[2] ?? 0,
			descriptor?.resolutionOffset[3] ?? 0
		);
	}
}

function installSystemHooks(system: any): void {
	if (installedSystems.has(system)) {
		return;
	}
	installGpuParticleTextureVectorFieldShaders();
	const platform = system._platform;
	if (!platform?.createUpdateBuffer || !platform?.updateParticleBuffer) {
		throw new Error("Unsupported Babylon GPU particle platform internals.");
	}
	const isWebGpu = system.getScene().getEngine().isWebGPU === true;
	if (!isWebGpu) {
		const names = uniformNames();
		platform._updateEffectOptions.uniformsNames.push(...names);
		platform._baseUniformsNamesLength += names.length;
		platform._updateEffectOptions.samplers.push("zvibeTextureVectorFieldAtlas");
	}
	const originalCreateUpdateBuffer = platform.createUpdateBuffer.bind(platform);
	platform.createUpdateBuffer = (defines: string): any => {
		const resources = atlasResources.get(system);
		const configuredDefines = resources ? `${defines}\n#define ${shaderDefine}` : defines;
		const accessor = originalCreateUpdateBuffer(configuredDefines);
		const state = runtimeStates.get(system);
		if (state) {
			state.lastCompiledWithVectorFields = configuredDefines.includes(`#define ${shaderDefine}`);
		}
		if (isWebGpu && resources) {
			addWebGpuUniformLayout(platform);
			const mapping = platform._updateComputeShader?.options?.bindingsMapping;
			if (!mapping) {
				throw new Error("Babylon WebGPU particle binding map is unavailable for the 3D vector-field texture.");
			}
			mapping.zvibeTextureVectorFieldAtlas = { group: 1, binding: 17 };
		}
		return accessor;
	};
	const originalUpdateParticleBuffer = platform.updateParticleBuffer.bind(platform);
	platform.updateParticleBuffer = (...args: any[]): void => {
		const resources = atlasResources.get(system);
		if (resources) {
			setUniforms(system, resources);
			if (isWebGpu) {
				platform._updateComputeShader.setTexture("zvibeTextureVectorFieldAtlas", resources.texture);
			} else {
				platform._updateEffect.setTexture("zvibeTextureVectorFieldAtlas", resources.texture);
			}
		}
		originalUpdateParticleBuffer(...args);
		if (resources) {
			const state = runtimeStates.get(system);
			if (state) {
				state.nativeDispatchCount++;
			}
		}
	};
	runtimeStates.set(system, { lastCompiledWithVectorFields: false, nativeDispatchCount: 0 });
	system.onDisposeObservable?.addOnce(() => disposeResources(system, atlasResources.get(system)));
	installedSystems.add(system);
}

/** Atomically uploads portable vector grids to a native 3D texture and attaches native update-shader sampling. */
export function configureGpuParticleTextureVectorFields(system: any, fields: IParticleTextureVectorField[] | null): IGpuParticleTextureVectorFieldRuntimeEvidence {
	if (system.getClassName?.() !== "GPUParticleSystem") {
		throw new Error("Native GPU texture vector fields require a GPUParticleSystem.");
	}
	const next = structuredClone(fields ?? []);
	const previous = configurations.get(system) ?? [];
	const existingResources = atlasResources.get(system);
	let replacement: IAtlasResources | undefined;
	try {
		replacement = createAtlasResources(system, next);
		installSystemHooks(system);
		configurations.set(system, next);
		if (replacement) {
			atlasResources.set(system, replacement);
		} else {
			atlasResources.delete(system);
		}
		system._resetEffect();
		system._cachedUpdateDefines = "__zvibe_gpu_texture_vector_field_configuration_changed__";
		disposeResources(system, existingResources);
	} catch (error) {
		if (replacement) {
			if (atlasResources.get(system) === replacement) {
				atlasResources.delete(system);
			}
			replacement.texture.dispose();
		}
		configurations.set(system, previous);
		if (existingResources) {
			atlasResources.set(system, existingResources);
		} else {
			atlasResources.delete(system);
		}
		throw error;
	}
	return getGpuParticleTextureVectorFieldRuntimeEvidence(system);
}

/** Returns exact backend/atlas/dispatch evidence without particle or texture readback. */
export function getGpuParticleTextureVectorFieldRuntimeEvidence(system: any): IGpuParticleTextureVectorFieldRuntimeEvidence {
	const resources = atlasResources.get(system);
	const state = runtimeStates.get(system) ?? { lastCompiledWithVectorFields: false, nativeDispatchCount: 0 };
	const availability = support(system, resources ?? null);
	const activeParticleCount = Math.max(0, Math.floor(system._currentActiveCount ?? 0));
	return {
		nativeGpu: true,
		backend: system.getScene?.()?.getEngine?.().isWebGPU ? "webgpu-compute" : "webgl2-transform-feedback",
		executionModel: "native-gpu-rgba8-3d-vector-field-atlas-v1",
		enabled: Boolean(resources),
		supported: availability.supported,
		unsupportedReason: availability.reason,
		shaderInstalled:
			ShaderStore.ShadersStore.gpuUpdateParticlesVertexShader?.includes(glslMarker) === true &&
			ShaderStore.ShadersStoreWGSL.gpuUpdateParticlesComputeShader?.includes(wgslMarker) === true,
		hooksInstalled: installedSystems.has(system),
		lastCompiledWithVectorFields: state.lastCompiledWithVectorFields,
		nativeDispatchCount: state.nativeDispatchCount,
		fieldCount: resources?.descriptors.length ?? 0,
		atlasReady: resources?.texture.isReady() ?? false,
		atlasDimensions: resources ? [resources.width, resources.height, resources.depth] : [0, 0, 0],
		atlasVoxelCount: resources ? resources.width * resources.height * resources.depth : 0,
		activeParticleCount,
		sampleUpperBound: activeParticleCount * (resources?.descriptors.length ?? 0),
		sampling: "trilinear-3d",
		encoding: "rgba8-signed-vector-with-per-field-scale",
		gpuReadback: false,
	};
}

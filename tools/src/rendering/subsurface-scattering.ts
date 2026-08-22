import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import "@babylonjs/core/Rendering/prePassRenderer";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import "@babylonjs/core/Rendering/subSurfaceSceneComponent";
import "@babylonjs/core/Shaders/subSurfaceScattering.fragment";
import "@babylonjs/core/ShadersWGSL/subSurfaceScattering.fragment";

import {
	clearSubsurfaceTransportRuntime,
	configureSubsurfaceTransport,
	refreshSubsurfaceTransportRuntime,
	ISubsurfaceTransportCache,
	ISubsurfaceTransportRuntimeEvidence,
	validateSubsurfaceTransportCache,
} from "./subsurface-transport";

export const diffusionProfileAssetType = "babylon-editor-diffusion-profile" as const;
export const diffusionProfileAssetVersion = 1 as const;
export const diffusionProfileAssetExtension = ".diffusionprofile.json" as const;
export const subsurfaceMaterialMetadataKey = "babylonEditorSubsurfaceScattering" as const;
export const subsurfaceRuntimeSettingsMetadataKey = "babylonEditorSubsurfaceRuntimeSettings" as const;
export const subsurfaceMaximumProfiles = 15;

export type SubsurfaceMaterialMode = "subsurface-scattering" | "translucent";
export type SubsurfaceQuality = "low" | "medium" | "high" | "custom";
export type SubsurfaceTransportMode = "screen-space" | "baked-ray-traced";

export interface IDiffusionProfileAsset {
	version: 1;
	type: typeof diffusionProfileAssetType;
	id: string;
	name: string;
	revision: number;
	scatteringDistance: [number, number, number];
	transmissionTint: [number, number, number];
	thicknessRemap: [number, number];
	worldScale: number;
	indexOfRefraction: number;
}

export interface ISubsurfaceProfileSnapshot extends IDiffusionProfileAsset {
	path: string | null;
	contentRevision: string | null;
}

export interface ISubsurfaceMaterialMetadata {
	version: 3;
	revision: number;
	mode: SubsurfaceMaterialMode;
	profile: ISubsurfaceProfileSnapshot;
	subsurfaceMask: number;
	subsurfaceMaskTexture: Record<string, unknown> | null;
	transmissionEnabled: boolean;
	transmissionIntensity: number;
	thicknessMultiplier: number;
	useThicknessTexture: boolean;
	transportCaches: ISubsurfaceTransportCache[];
}

export interface ISubsurfaceRuntimeSettings {
	version: 2;
	revision: number;
	enabled: boolean;
	quality: SubsurfaceQuality;
	sampleBudget: number;
	metersPerUnit: number;
	transportMode: SubsurfaceTransportMode;
	transportIntensity: number;
}

export interface ISubsurfaceRuntimeProfileEvidence {
	index: number;
	id: string;
	name: string;
	revision: number;
	path: string | null;
	contentRevision: string | null;
	scatteringDistance: [number, number, number];
	effectiveScatteringDistance: [number, number, number];
	transmissionTint: [number, number, number];
	thicknessRemap: [number, number];
	worldScale: number;
	indexOfRefraction: number;
	materialCount: number;
}

export interface ISubsurfaceRuntimeMaterialEvidence {
	materialId: string;
	materialName: string;
	revision: number;
	mode: SubsurfaceMaterialMode;
	profileId: string;
	profileIndex: number;
	subsurfaceMask: number;
	transmissionEnabled: boolean;
	transmissionIntensity: number;
	minimumThickness: number;
	maximumThickness: number;
	thicknessTextureName: string | null;
	subsurfaceMaskTextureName: string | null;
	subsurfaceMaskTextureUrl: string | null;
	subsurfaceMaskTextureReady: boolean;
	subsurfaceMaskChannel: "red";
	texturesReady: boolean;
}

export interface ISubsurfaceRuntimeEvidence {
	configured: boolean;
	ready: boolean;
	backend: "babylon-native-burley-screen-space-mask-v3";
	shaderLanguage: "GLSL" | "WGSL";
	profileCapacity: 15;
	profileCount: number;
	materialCount: number;
	scatteringMaterialCount: number;
	transmissionMaterialCount: number;
	quality: SubsurfaceQuality;
	sampleBudget: number;
	metersPerUnit: number;
	prePassEnabled: boolean;
	postProcessReady: boolean;
	maskTargetAllocated: boolean;
	maskTargetReady: boolean;
	maskTargetWidth: number;
	maskTargetHeight: number;
	maskMeshCount: number;
	maskTextureCount: number;
	maskRenderedFrames: number;
	frameId: number;
	profiles: ISubsurfaceRuntimeProfileEvidence[];
	materials: ISubsurfaceRuntimeMaterialEvidence[];
	transport: ISubsurfaceTransportRuntimeEvidence;
	limitations: string[];
	warnings: string[];
	errors: string[];
}

const limitations = [
	"The realtime blur remains Babylon's native Burley screen-space pre-pass. Optional camera-independent transport caches are produced by a bounded static CPU ray tracer rather than hardware DXR and must be re-baked after signed geometry, profile, or lighting changes.",
	"The portable diffusion profile supports Unity-style scattering distance, transmission tint, thickness remap, world scale, and index of refraction. Babylon's native shader consumes the resulting per-channel millimetre scattering distances.",
	"A material-wide scalar multiplies an optional independent red-channel subsurface mask texture. Thickness textures remain separate native transmission inputs.",
	"The shared custom deferred renderer routes authored subsurface PBR materials through Babylon's native forward/pre-pass composition instead of evaluating them as ordinary deferred materials.",
];

interface ISubsurfaceMaskState {
	target: RenderTargetTexture;
	materials: Material[];
	postProcessObserver: Observer<Effect> | null;
	disposeObserver: Observer<Scene> | null;
	meshCount: number;
	textureCount: number;
	renderedFrames: number;
}

const runtimeMaskTextures = new WeakMap<PBRMaterial, BaseTexture>();
const maskStates = new WeakMap<Scene, ISubsurfaceMaskState>();
const activeMaskScenes = new Set<Scene>();
const ownedPrePassScenes = new WeakSet<Scene>();
let originalGlslSubsurfaceShader: string | null = null;
let originalWgslSubsurfaceShader: string | null = null;

const defaultRuntimeSettings: ISubsurfaceRuntimeSettings = {
	version: 2,
	revision: 1,
	enabled: true,
	quality: "high",
	sampleBudget: 64,
	metersPerUnit: 0.01,
	transportMode: "screen-space",
	transportIntensity: 1,
};

const reports = new WeakMap<Scene, ISubsurfaceRuntimeEvidence>();

function isPBRMaterial(material: Material): material is PBRMaterial {
	return (material instanceof PBRMaterial || material.getClassName() === "PBRMaterial") && "subSurface" in material;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function tuple3(value: unknown, label: string, minimum: number, maximum: number): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3) {
		throw new Error(`${label} must contain exactly three numbers.`);
	}
	return value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`, minimum, maximum)) as [number, number, number];
}

function tuple2(value: unknown, label: string, minimum: number, maximum: number): [number, number] {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error(`${label} must contain exactly two numbers.`);
	}
	const result = value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`, minimum, maximum)) as [number, number];
	if (result[1] < result[0]) {
		throw new Error(`${label} maximum must be greater than or equal to its minimum.`);
	}
	return result;
}

function boundedString(value: unknown, label: string, maximum = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1–${maximum} characters.`);
	}
	return value.trim();
}

export function diffusionProfilePreset(name = "Skin"): IDiffusionProfileAsset {
	return {
		version: 1,
		type: diffusionProfileAssetType,
		id: `diffusion-profile-${Math.random().toString(36).slice(2, 12)}`,
		name,
		revision: 1,
		scatteringDistance: [1, 0.35, 0.2],
		transmissionTint: [1, 0.35, 0.25],
		thicknessRemap: [0, 5],
		worldScale: 1,
		indexOfRefraction: 1.4,
	};
}

export function validateDiffusionProfileAsset(value: unknown): IDiffusionProfileAsset {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Diffusion profile must be an object.");
	}
	const source = value as Record<string, unknown>;
	const fields = ["version", "type", "id", "name", "revision", "scatteringDistance", "transmissionTint", "thicknessRemap", "worldScale", "indexOfRefraction"];
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`Diffusion profile contains unknown fields: ${unknown.join(", ")}.`);
	}
	if (source.version !== diffusionProfileAssetVersion || source.type !== diffusionProfileAssetType) {
		throw new Error("Diffusion profile uses an unsupported type or version.");
	}
	if (!Number.isInteger(source.revision) || (source.revision as number) < 1) {
		throw new Error("Diffusion profile revision must be a positive integer.");
	}
	return {
		version: 1,
		type: diffusionProfileAssetType,
		id: boundedString(source.id, "Diffusion profile id", 128),
		name: boundedString(source.name, "Diffusion profile name", 128),
		revision: source.revision as number,
		scatteringDistance: tuple3(source.scatteringDistance, "Diffusion profile scatteringDistance", 0.001, 1000),
		transmissionTint: tuple3(source.transmissionTint, "Diffusion profile transmissionTint", 0, 1),
		thicknessRemap: tuple2(source.thicknessRemap, "Diffusion profile thicknessRemap", 0, 10000),
		worldScale: finiteNumber(source.worldScale, "Diffusion profile worldScale", 0.001, 1000),
		indexOfRefraction: finiteNumber(source.indexOfRefraction, "Diffusion profile indexOfRefraction", 1, 3),
	};
}

function validateSnapshot(value: unknown): ISubsurfaceProfileSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Subsurface material profile snapshot must be an object.");
	}
	const source = value as Record<string, unknown>;
	const profile = validateDiffusionProfileAsset(Object.fromEntries(Object.entries(source).filter(([key]) => key !== "path" && key !== "contentRevision")));
	const path = source.path === null ? null : boundedString(source.path, "Diffusion profile path", 1024);
	const contentRevision = source.contentRevision === null ? null : boundedString(source.contentRevision, "Diffusion profile content revision", 128);
	return { ...profile, path, contentRevision };
}

function validateSerializedMaskTexture(value: unknown): Record<string, unknown> | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Subsurface mask texture snapshot must be an object or null.");
	}
	const source = structuredClone(value as Record<string, unknown>);
	if (source.isCube === true) {
		throw new Error("Subsurface mask texture must be a 2D texture.");
	}
	const name = source.name;
	const url = source.url;
	if ((typeof name !== "string" || !name.trim()) && (typeof url !== "string" || !url.trim())) {
		throw new Error("Subsurface mask texture snapshot requires a non-empty name or URL.");
	}
	if (JSON.stringify(source).length > 1_000_000) {
		throw new Error("Subsurface mask texture snapshot exceeds the 1 MB portable metadata limit.");
	}
	return source;
}

export function validateSubsurfaceMaterialMetadata(value: unknown): ISubsurfaceMaterialMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Subsurface material metadata must be an object.");
	}
	const source = value as Record<string, unknown>;
	const fields = [
		"version",
		"revision",
		"mode",
		"profile",
		"subsurfaceMask",
		"subsurfaceMaskTexture",
		"transmissionEnabled",
		"transmissionIntensity",
		"thicknessMultiplier",
		"useThicknessTexture",
		"transportCaches",
	];
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`Subsurface material metadata contains unknown fields: ${unknown.join(", ")}.`);
	}
	if (![1, 2, 3].includes(source.version as number) || !Number.isInteger(source.revision) || (source.revision as number) < 1) {
		throw new Error("Subsurface material metadata requires version 1, 2, or 3 and a positive integer revision.");
	}
	if (source.mode !== "subsurface-scattering" && source.mode !== "translucent") {
		throw new Error("Subsurface material mode must be subsurface-scattering or translucent.");
	}
	if (typeof source.transmissionEnabled !== "boolean" || typeof source.useThicknessTexture !== "boolean") {
		throw new Error("Subsurface transmissionEnabled and useThicknessTexture must be booleans.");
	}
	return {
		version: 3,
		revision: source.revision as number,
		mode: source.mode,
		profile: validateSnapshot(source.profile),
		subsurfaceMask: finiteNumber(source.subsurfaceMask, "Subsurface mask", 0, 1),
		subsurfaceMaskTexture: source.version === 1 ? null : validateSerializedMaskTexture(source.subsurfaceMaskTexture),
		transmissionEnabled: source.transmissionEnabled,
		transmissionIntensity: finiteNumber(source.transmissionIntensity, "Subsurface transmissionIntensity", 0, 16),
		thicknessMultiplier: finiteNumber(source.thicknessMultiplier, "Subsurface thicknessMultiplier", 0, 1000),
		useThicknessTexture: source.useThicknessTexture,
		transportCaches:
			source.version === 3
				? (() => {
						if (!Array.isArray(source.transportCaches) || source.transportCaches.length > 128) {
							throw new Error("Subsurface transportCaches must contain at most 128 entries.");
						}
						const caches = source.transportCaches.map(validateSubsurfaceTransportCache);
						if (new Set(caches.map((cache) => cache.meshId)).size !== caches.length) {
							throw new Error("Subsurface transportCaches must contain at most one cache per meshId.");
						}
						return caches;
					})()
				: [],
	};
}

export function validateSubsurfaceRuntimeSettings(value: unknown): ISubsurfaceRuntimeSettings {
	if (value === undefined || value === null) {
		return structuredClone(defaultRuntimeSettings);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Subsurface runtime settings must be an object.");
	}
	const source = value as Record<string, unknown>;
	const fields = ["version", "revision", "enabled", "quality", "sampleBudget", "metersPerUnit", "transportMode", "transportIntensity"];
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`Subsurface runtime settings contain unknown fields: ${unknown.join(", ")}.`);
	}
	if ((source.version !== 1 && source.version !== 2) || !Number.isInteger(source.revision) || (source.revision as number) < 1) {
		throw new Error("Subsurface runtime settings require version 1 or 2 and a positive integer revision.");
	}
	if (typeof source.enabled !== "boolean" || !["low", "medium", "high", "custom"].includes(source.quality as string)) {
		throw new Error("Subsurface runtime enabled/quality settings are invalid.");
	}
	const transportMode = source.version === 1 ? "screen-space" : source.transportMode;
	if (transportMode !== "screen-space" && transportMode !== "baked-ray-traced") {
		throw new Error("Subsurface runtime transportMode must be screen-space or baked-ray-traced.");
	}
	return {
		version: 2,
		revision: source.revision as number,
		enabled: source.enabled,
		quality: source.quality as SubsurfaceQuality,
		sampleBudget: Math.trunc(finiteNumber(source.sampleBudget, "Subsurface sampleBudget", 8, 256)),
		metersPerUnit: finiteNumber(source.metersPerUnit, "Subsurface metersPerUnit", 0.000001, 1000),
		transportMode,
		transportIntensity: source.version === 1 ? 1 : finiteNumber(source.transportIntensity, "Subsurface transportIntensity", 0, 16),
	};
}

export function getSubsurfaceMaterialMetadata(material: PBRMaterial): ISubsurfaceMaterialMetadata | null {
	const value = material.metadata?.[subsurfaceMaterialMetadataKey];
	return value === undefined ? null : validateSubsurfaceMaterialMetadata(value);
}

export function setSubsurfaceMaterialMetadata(material: PBRMaterial, value: unknown | null): void {
	material.metadata ??= {};
	if (value) {
		material.metadata[subsurfaceMaterialMetadataKey] = validateSubsurfaceMaterialMetadata(value);
	} else {
		delete material.metadata[subsurfaceMaterialMetadataKey];
		runtimeMaskTextures.delete(material);
	}
}

export function getSubsurfaceMaskTexture(material: PBRMaterial): BaseTexture | null {
	return runtimeMaskTextures.get(material) ?? null;
}

export function setSubsurfaceMaskTexture(material: PBRMaterial, texture: BaseTexture | null): void {
	if (texture?.isCube) {
		throw new Error("Subsurface mask texture must be a 2D texture.");
	}
	if (texture) {
		texture.gammaSpace = false;
		runtimeMaskTextures.set(material, texture);
	} else {
		runtimeMaskTextures.delete(material);
	}
}

export function serializeSubsurfaceMaskTexture(texture: BaseTexture | null): Record<string, unknown> | null {
	if (!texture) {
		return null;
	}
	if (texture.isCube) {
		throw new Error("Subsurface mask texture must be a 2D texture.");
	}
	const snapshot = texture.serialize?.() as Record<string, unknown> | null;
	if (!snapshot) {
		throw new Error(`Subsurface mask texture "${texture.name}" could not be serialized for portable loading.`);
	}
	return validateSerializedMaskTexture(snapshot);
}

export function getSubsurfaceRuntimeSettings(scene: Scene): ISubsurfaceRuntimeSettings {
	return validateSubsurfaceRuntimeSettings(scene.metadata?.[subsurfaceRuntimeSettingsMetadataKey]);
}

function patchShaderContract(sampleBudget: number): void {
	const glslInclude = ShaderStore.IncludesShadersStore.diffusionProfile;
	if (glslInclude) {
		ShaderStore.IncludesShadersStore.diffusionProfile = glslInclude
			.replace(/diffusionS\[\d+\]/, `diffusionS[${subsurfaceMaximumProfiles}]`)
			.replace(/diffusionD\[\d+\]/, `diffusionD[${subsurfaceMaximumProfiles}]`)
			.replace(/filterRadii\[\d+\]/, `filterRadii[${subsurfaceMaximumProfiles}]`);
	}
	const wgslInclude = ShaderStore.IncludesShadersStoreWGSL.diffusionProfile;
	if (wgslInclude) {
		ShaderStore.IncludesShadersStoreWGSL.diffusionProfile = wgslInclude
			.replace(/array<vec3f,\d+>/, `array<vec3f,${subsurfaceMaximumProfiles}>`)
			.replace(/array<f32,\d+>/g, `array<f32,${subsurfaceMaximumProfiles}>`);
	}
	originalGlslSubsurfaceShader ??= ShaderStore.ShadersStore.subSurfaceScatteringPixelShader ?? null;
	originalWgslSubsurfaceShader ??= ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader ?? null;
	if (!originalGlslSubsurfaceShader || !originalWgslSubsurfaceShader) {
		throw new Error("Babylon's native GLSL/WGSL subsurface shaders are unavailable.");
	}
	const glslShader = originalGlslSubsurfaceShader
		.replace(/const int _SssSampleBudget=\d+;/, `const int _SssSampleBudget=${sampleBudget};`)
		.replace("uniform sampler2D albedoSampler;", "uniform sampler2D albedoSampler;uniform sampler2D subsurfaceMaskSampler;uniform float subsurfaceMaskEnabled;")
		.replace(
			/vec3 irradiance\s*=textureSample\.rgb;/,
			"float sampleSubsurfaceMask=mix(1.0,texture2D(subsurfaceMaskSampler,position).r,subsurfaceMaskEnabled);vec3 irradiance=textureSample.rgb*sampleSubsurfaceMask;"
		)
		.replace(
			"vec4 inputColor=texture2D(textureSampler,vUV);",
			"vec4 inputColor=texture2D(textureSampler,vUV);float centerSubsurfaceMask=mix(1.0,texture2D(subsurfaceMaskSampler,vUV).r,subsurfaceMaskEnabled);"
		)
		.replace("gl_FragColor=vec4(inputColor.rgb+albedo*centerIrradiance,1.0);", "gl_FragColor=vec4(inputColor.rgb+centerSubsurfaceMask*albedo*centerIrradiance,1.0);")
		.replace(
			"gl_FragColor=vec4(inputColor.rgb+albedo*max(totalIrradiance/totalWeight,vec3(0.0)),1.);",
			"gl_FragColor=vec4(inputColor.rgb+centerSubsurfaceMask*albedo*max(totalIrradiance/totalWeight,vec3(0.0)),1.);"
		);
	const wgslShader = originalWgslSubsurfaceShader
		.replace(/const _SssSampleBudget=\d+u;/, `const _SssSampleBudget=${sampleBudget}u;`)
		.replace(
			"var albedoSamplerSampler: sampler;var albedoSampler: texture_2d<f32>;",
			"var albedoSamplerSampler: sampler;var albedoSampler: texture_2d<f32>;var subsurfaceMaskSamplerSampler: sampler;var subsurfaceMaskSampler: texture_2d<f32>;uniform subsurfaceMaskEnabled: f32;"
		)
		.replace(
			"let irradiance =textureRead.rgb;",
			"let sampleSubsurfaceMask=mix(1.0,textureSampleLevel(subsurfaceMaskSampler,subsurfaceMaskSamplerSampler,position,0.).r,uniforms.subsurfaceMaskEnabled);let irradiance=textureRead.rgb*sampleSubsurfaceMask;"
		)
		.replace(
			"let inputColor=textureSampleLevel(textureSampler,textureSamplerSampler,fragmentInputs.vUV,0.);",
			"let inputColor=textureSampleLevel(textureSampler,textureSamplerSampler,fragmentInputs.vUV,0.);let centerSubsurfaceMask=mix(1.0,textureSampleLevel(subsurfaceMaskSampler,subsurfaceMaskSamplerSampler,fragmentInputs.vUV,0.).r,uniforms.subsurfaceMaskEnabled);"
		)
		.replace(
			"fragmentOutputs.color=vec4f(inputColor.rgb+albedo*centerIrradiance,1.0);",
			"fragmentOutputs.color=vec4f(inputColor.rgb+centerSubsurfaceMask*albedo*centerIrradiance,1.0);"
		)
		.replace(
			"fragmentOutputs.color=vec4f(inputColor.rgb+albedo*max(totalIrradiance/totalWeight,vec3f(0.0)),1.);",
			"fragmentOutputs.color=vec4f(inputColor.rgb+centerSubsurfaceMask*albedo*max(totalIrradiance/totalWeight,vec3f(0.0)),1.);"
		);
	if (
		!glslShader.includes("subsurfaceMaskSampler") ||
		!glslShader.includes("centerSubsurfaceMask*albedo") ||
		!wgslShader.includes("subsurfaceMaskSampler") ||
		!wgslShader.includes("centerSubsurfaceMask*albedo")
	) {
		throw new Error("Babylon's native subsurface shader contract changed; the independent mask extension was not installed.");
	}
	ShaderStore.ShadersStore.subSurfaceScatteringPixelShader = glslShader;
	ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader = wgslShader;
}

function restoreShaderContract(): void {
	if (activeMaskScenes.size) {
		return;
	}
	if (originalGlslSubsurfaceShader) {
		ShaderStore.ShadersStore.subSurfaceScatteringPixelShader = originalGlslSubsurfaceShader;
	}
	if (originalWgslSubsurfaceShader) {
		ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader = originalWgslSubsurfaceShader;
	}
}

function rehydrateSubsurfaceMaskTexture(scene: Scene, material: PBRMaterial, metadata: ISubsurfaceMaterialMetadata, rootUrl: string): BaseTexture | null {
	const existing = getSubsurfaceMaskTexture(material);
	if (existing || !metadata.subsurfaceMaskTexture) {
		return existing;
	}
	const texture = Texture.Parse(structuredClone(metadata.subsurfaceMaskTexture), scene, rootUrl);
	if (!texture) {
		throw new Error(`Material "${material.name}" subsurface mask texture could not be parsed.`);
	}
	setSubsurfaceMaskTexture(material, texture);
	return texture;
}

function createMaskMaterial(scene: Scene, source: PBRMaterial | null, texture: BaseTexture | null, scalar: number): StandardMaterial {
	const material = new StandardMaterial(source ? `Subsurface Mask · ${source.name}` : "Subsurface Mask · Zero", scene);
	material.doNotSerialize = true;
	material.disableLighting = true;
	material.alpha = 1;
	material.transparencyMode = Material.MATERIAL_OPAQUE;
	material.disableDepthWrite = false;
	material.backFaceCulling = source?.backFaceCulling ?? true;
	material.sideOrientation = source?.sideOrientation ?? Material.CounterClockWiseSideOrientation;
	material.zOffset = source?.zOffset ?? 0;
	material.zOffsetUnits = source?.zOffsetUnits ?? 0;
	material.ambientColor = Color3.Black();
	material.diffuseColor = Color3.Black();
	material.diffuseTexture = null;
	material.specularColor = Color3.Black();
	material.specularTexture = null;
	material.opacityTexture = null;
	material.reflectionTexture = null;
	material.emissiveTexture = texture;
	material.emissiveColor = new Color3(scalar, scalar, scalar);
	return material;
}

function stopSubsurfaceMaskRuntime(scene: Scene): void {
	const state = maskStates.get(scene);
	if (!state) {
		return;
	}
	maskStates.delete(scene);
	activeMaskScenes.delete(scene);
	const postProcess = scene.subSurfaceConfiguration?.postProcess;
	if (postProcess && state.postProcessObserver) {
		postProcess.onApplyObservable.remove(state.postProcessObserver);
	}
	if (state.disposeObserver) {
		scene.onDisposeObservable.remove(state.disposeObserver);
	}
	const targetIndex = scene.customRenderTargets.indexOf(state.target);
	if (targetIndex !== -1) {
		scene.customRenderTargets.splice(targetIndex, 1);
	}
	state.target.dispose();
	for (const material of state.materials) {
		material.dispose(false, false);
	}
	restoreShaderContract();
	if (!activeMaskScenes.size && !scene.isDisposed && postProcess) {
		postProcess.updateEffect();
	}
}

function configureSubsurfaceMaskTarget(
	scene: Scene,
	configuration: NonNullable<Scene["subSurfaceConfiguration"]>,
	candidates: Array<{ material: PBRMaterial; metadata: ISubsurfaceMaterialMetadata; maskTexture: BaseTexture | null }>
): ISubsurfaceMaskState {
	const engine = scene.getEngine();
	const target = new RenderTargetTexture(
		"Babylon Editor Subsurface Mask",
		{ width: Math.max(1, engine.getRenderWidth()), height: Math.max(1, engine.getRenderHeight()) },
		scene,
		false,
		true,
		Constants.TEXTURETYPE_UNSIGNED_BYTE
	);
	target.activeCamera = scene.activeCamera;
	target.renderParticles = false;
	target.renderSprites = false;
	target.ignoreCameraViewport = false;
	target.clearColor = new Color4(0, 0, 0, 0);
	target.gammaSpace = false;
	target.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
	const materials: Material[] = [];
	const materialMap = new Map<Material, Material>();
	for (const candidate of candidates) {
		const maskMaterial = createMaskMaterial(scene, candidate.material, candidate.maskTexture, candidate.metadata.subsurfaceMask);
		materials.push(maskMaterial);
		materialMap.set(candidate.material, maskMaterial);
	}
	const zeroMaterial = createMaskMaterial(scene, null, null, 0);
	materials.push(zeroMaterial);
	const renderList = scene.meshes.filter((mesh) => {
		const source = mesh.material;
		if (!source) {
			return false;
		}
		const direct = materialMap.get(source);
		if (direct) {
			target.setMaterialForRendering(mesh, direct);
			return true;
		}
		const subMaterials = (source as Material & { subMaterials?: Array<Material | null> }).subMaterials;
		if (!subMaterials?.some((subMaterial) => Boolean(subMaterial && materialMap.has(subMaterial)))) {
			return false;
		}
		target.setMaterialForRendering(
			mesh,
			subMaterials.map((subMaterial) => (subMaterial ? (materialMap.get(subMaterial) ?? zeroMaterial) : zeroMaterial))
		);
		return true;
	});
	target.renderList = renderList;
	const state: ISubsurfaceMaskState = {
		target,
		materials,
		postProcessObserver: null,
		disposeObserver: null,
		meshCount: renderList.length,
		textureCount: new Set(candidates.map((candidate) => candidate.maskTexture?.uniqueId).filter((id): id is number => id !== undefined)).size,
		renderedFrames: 0,
	};
	target.onBeforeRenderObservable.add(() => {
		const width = Math.max(1, engine.getRenderWidth());
		const height = Math.max(1, engine.getRenderHeight());
		const size = target.getSize();
		if (size.width !== width || size.height !== height) {
			target.resize({ width, height });
		}
		target.activeCamera = scene.activeCamera;
	});
	target.onAfterRenderObservable.add(() => state.renderedFrames++);
	scene.customRenderTargets.push(target);
	maskStates.set(scene, state);
	activeMaskScenes.add(scene);
	const postProcess = configuration.postProcess;
	if (!postProcess) {
		stopSubsurfaceMaskRuntime(scene);
		throw new Error("Babylon's native subsurface post-process was not created.");
	}
	postProcess.updateEffect(
		null,
		["texelSize", "viewportSize", "metersPerUnit", "subsurfaceMaskEnabled"],
		["diffusionS", "diffusionD", "filterRadii", "irradianceSampler", "depthSampler", "albedoSampler", "subsurfaceMaskSampler"]
	);
	state.postProcessObserver = postProcess.onApplyObservable.add((effect) => {
		effect.setTexture("subsurfaceMaskSampler", target);
		effect.setFloat("subsurfaceMaskEnabled", 1);
	});
	state.disposeObserver = scene.onDisposeObservable.add(() => stopSubsurfaceMaskRuntime(scene));
	return state;
}

function effectiveDistance(metadata: ISubsurfaceMaterialMetadata): [number, number, number] {
	const scale = metadata.profile.worldScale;
	return metadata.profile.scatteringDistance.map((value) => Math.max(0.001, value * scale)) as [number, number, number];
}

function applyProfileArrays(
	configuration: NonNullable<Scene["subSurfaceConfiguration"]>,
	profiles: Array<{ profile: ISubsurfaceProfileSnapshot; distance: [number, number, number] }>
): void {
	configuration.clearAllDiffusionProfiles();
	for (const { distance } of profiles) {
		const color = Color3.FromArray(distance);
		configuration.ssDiffusionS.push(color.r, color.b, color.g);
		configuration.ssDiffusionD.push(Math.max(color.r, color.g, color.b));
		configuration.ssFilterRadii.push(configuration.getDiffusionProfileParameters(color));
		configuration.ssDiffusionProfileColors.push(color);
	}
}

function emptyReport(scene: Scene, settings: ISubsurfaceRuntimeSettings, errors: string[] = []): ISubsurfaceRuntimeEvidence {
	const transport = configureSubsurfaceTransport(scene, [], settings.enabled && settings.transportMode === "baked-ray-traced", settings.transportIntensity);
	return {
		configured: false,
		ready: false,
		backend: "babylon-native-burley-screen-space-mask-v3",
		shaderLanguage: scene.getEngine().isWebGPU ? "WGSL" : "GLSL",
		profileCapacity: 15,
		profileCount: 0,
		materialCount: 0,
		scatteringMaterialCount: 0,
		transmissionMaterialCount: 0,
		quality: settings.quality,
		sampleBudget: settings.sampleBudget,
		metersPerUnit: settings.metersPerUnit,
		prePassEnabled: Boolean(scene.prePassRenderer),
		postProcessReady: false,
		maskTargetAllocated: false,
		maskTargetReady: false,
		maskTargetWidth: 0,
		maskTargetHeight: 0,
		maskMeshCount: 0,
		maskTextureCount: 0,
		maskRenderedFrames: 0,
		frameId: scene.getFrameId(),
		profiles: [],
		materials: [],
		transport,
		limitations: [...limitations],
		warnings: [],
		errors,
	};
}

function releaseOwnedNativeSubsurface(scene: Scene): void {
	const configuration = scene.subSurfaceConfiguration;
	if (configuration) {
		configuration.enabled = false;
	}
	if (!ownedPrePassScenes.has(scene)) {
		return;
	}
	const otherEnabledConfigurations = ((scene.prePassRenderer as any)?._effectConfigurations as Array<{ enabled?: boolean }> | undefined)?.some(
		(entry) => entry !== configuration && entry.enabled
	);
	if (otherEnabledConfigurations) {
		ownedPrePassScenes.delete(scene);
		return;
	}
	scene.disableSubSurfaceForPrePass();
	scene.disablePrePassRenderer();
	ownedPrePassScenes.delete(scene);
}

function deactivateManagedSubsurface(scene: Scene, candidates: Array<{ material: PBRMaterial }>): void {
	for (const { material } of candidates) {
		material.subSurface.isScatteringEnabled = false;
		material.subSurface.isTranslucencyEnabled = false;
	}
	const hasUnmanagedScattering = scene.materials.some(
		(material) => isPBRMaterial(material) && material.metadata?.[subsurfaceMaterialMetadataKey] === undefined && material.subSurface.isScatteringEnabled
	);
	if (!hasUnmanagedScattering) {
		releaseOwnedNativeSubsurface(scene);
	}
}

export function configureSubsurfaceScattering(scene: Scene, rootUrl = ""): ISubsurfaceRuntimeEvidence {
	stopSubsurfaceMaskRuntime(scene);
	const settings = getSubsurfaceRuntimeSettings(scene);
	const candidates: Array<{ material: PBRMaterial; metadata: ISubsurfaceMaterialMetadata; maskTexture: BaseTexture | null }> = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	for (const material of scene.materials) {
		if (!isPBRMaterial(material) || material.doNotSerialize) {
			continue;
		}
		const raw = material.metadata?.[subsurfaceMaterialMetadataKey];
		if (raw === undefined) {
			continue;
		}
		try {
			const metadata = validateSubsurfaceMaterialMetadata(raw);
			candidates.push({ material, metadata, maskTexture: rehydrateSubsurfaceMaskTexture(scene, material, metadata, rootUrl) });
		} catch (error) {
			errors.push(`Material "${material.name}" has invalid subsurface metadata: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!settings.enabled || candidates.length === 0 || errors.length) {
		deactivateManagedSubsurface(scene, candidates);
		const report = emptyReport(scene, settings, errors);
		report.materialCount = candidates.length;
		reports.set(scene, report);
		return report;
	}

	const profileMap = new Map<string, { profile: ISubsurfaceProfileSnapshot; distance: [number, number, number]; materials: typeof candidates }>();
	for (const candidate of candidates) {
		const distance = effectiveDistance(candidate.metadata);
		const key = `${candidate.metadata.profile.id}|${distance.join(",")}`;
		const existing = profileMap.get(key);
		if (existing) {
			existing.materials.push(candidate);
		} else {
			profileMap.set(key, { profile: candidate.metadata.profile, distance, materials: [candidate] });
		}
	}
	const profileValues = [...profileMap.values()].sort((left, right) => left.profile.name.localeCompare(right.profile.name) || left.profile.id.localeCompare(right.profile.id));
	if (profileValues.length > subsurfaceMaximumProfiles) {
		errors.push(`Scene requires ${profileValues.length} effective diffusion profiles; the Unity-compatible view limit is ${subsurfaceMaximumProfiles}.`);
		deactivateManagedSubsurface(scene, candidates);
		const report = emptyReport(scene, settings, errors);
		report.materialCount = candidates.length;
		reports.set(scene, report);
		return report;
	}

	try {
		patchShaderContract(settings.sampleBudget);
	} catch (error) {
		restoreShaderContract();
		deactivateManagedSubsurface(scene, candidates);
		const report = emptyReport(scene, settings, [error instanceof Error ? error.message : String(error)]);
		report.materialCount = candidates.length;
		reports.set(scene, report);
		return report;
	}
	const hadPrePassRenderer = Boolean(scene.prePassRenderer);
	const configuration = scene.enableSubSurfaceForPrePass();
	if (!configuration) {
		restoreShaderContract();
		deactivateManagedSubsurface(scene, candidates);
		const report = emptyReport(scene, settings, ["Babylon could not enable its native pre-pass subsurface configuration on this device."]);
		report.materialCount = candidates.length;
		reports.set(scene, report);
		return report;
	}
	if (!hadPrePassRenderer) {
		ownedPrePassScenes.add(scene);
	}
	configuration.enabled = true;
	configuration.metersPerUnit = settings.metersPerUnit;
	applyProfileArrays(configuration, profileValues);
	if (!configuration.postProcess) {
		configuration.createPostProcess();
	}

	const indexByKey = new Map<string, number>();
	profileValues.forEach((value, index) => indexByKey.set(`${value.profile.id}|${value.distance.join(",")}`, index));
	const materialEvidence: ISubsurfaceRuntimeMaterialEvidence[] = [];
	for (const { material, metadata, maskTexture } of candidates) {
		const distance = effectiveDistance(metadata);
		const profileIndex = indexByKey.get(`${metadata.profile.id}|${distance.join(",")}`)!;
		const subSurface = material.subSurface as any;
		subSurface._scatteringDiffusionProfileIndex = profileIndex;
		subSurface.isScatteringEnabled = metadata.mode === "subsurface-scattering" && metadata.subsurfaceMask > 0;
		subSurface.isTranslucencyEnabled = metadata.mode === "translucent" || metadata.transmissionEnabled;
		subSurface.isRefractionEnabled = false;
		subSurface.translucencyIntensity = metadata.transmissionIntensity;
		subSurface.translucencyColor = Color3.FromArray(metadata.profile.transmissionTint);
		subSurface.tintColor = Color3.FromArray(metadata.profile.transmissionTint);
		subSurface.diffusionDistance = Color3.FromArray(distance);
		subSurface.indexOfRefraction = metadata.profile.indexOfRefraction;
		subSurface.minimumThickness = metadata.profile.thicknessRemap[0] * metadata.thicknessMultiplier;
		subSurface.maximumThickness = metadata.profile.thicknessRemap[1] * metadata.thicknessMultiplier;
		subSurface.useMaskFromThicknessTexture = metadata.useThicknessTexture;
		material.markAsDirty(63);
		const texture = subSurface.thicknessTexture;
		if (metadata.useThicknessTexture && !texture) {
			warnings.push(`Material "${material.name}" requests a thickness texture but none is assigned.`);
		}
		const maskTextureValue = maskTexture as (BaseTexture & { url?: string }) | null;
		materialEvidence.push({
			materialId: material.id,
			materialName: material.name,
			revision: metadata.revision,
			mode: metadata.mode,
			profileId: metadata.profile.id,
			profileIndex,
			subsurfaceMask: metadata.subsurfaceMask,
			transmissionEnabled: subSurface.isTranslucencyEnabled,
			transmissionIntensity: metadata.transmissionIntensity,
			minimumThickness: subSurface.minimumThickness,
			maximumThickness: subSurface.maximumThickness,
			thicknessTextureName: texture?.name ?? null,
			subsurfaceMaskTextureName: maskTexture?.name ?? null,
			subsurfaceMaskTextureUrl: typeof maskTextureValue?.url === "string" ? maskTextureValue.url : null,
			subsurfaceMaskTextureReady: maskTexture?.isReadyOrNotBlocking() ?? true,
			subsurfaceMaskChannel: "red",
			texturesReady: (!texture || texture.isReadyOrNotBlocking()) && (!maskTexture || maskTexture.isReadyOrNotBlocking()),
		});
	}
	let maskState: ISubsurfaceMaskState;
	try {
		maskState = configureSubsurfaceMaskTarget(scene, configuration, candidates);
	} catch (error) {
		stopSubsurfaceMaskRuntime(scene);
		deactivateManagedSubsurface(scene, candidates);
		const report = emptyReport(scene, settings, [`Subsurface mask target could not be activated: ${error instanceof Error ? error.message : String(error)}`]);
		report.materialCount = candidates.length;
		reports.set(scene, report);
		return report;
	}

	const profileEvidence: ISubsurfaceRuntimeProfileEvidence[] = profileValues.map((value, index) => ({
		index,
		id: value.profile.id,
		name: value.profile.name,
		revision: value.profile.revision,
		path: value.profile.path,
		contentRevision: value.profile.contentRevision,
		scatteringDistance: [...value.profile.scatteringDistance],
		effectiveScatteringDistance: [...value.distance],
		transmissionTint: [...value.profile.transmissionTint],
		thicknessRemap: [...value.profile.thicknessRemap],
		worldScale: value.profile.worldScale,
		indexOfRefraction: value.profile.indexOfRefraction,
		materialCount: value.materials.length,
	}));
	const postProcessReady = Boolean(configuration.postProcess?.isReady());
	const maskTargetSize = maskState.target.getSize();
	const maskTargetReady = maskState.target.isReadyForRendering();
	const transport = configureSubsurfaceTransport(
		scene,
		candidates.map(({ material, metadata }) => ({
			material,
			profileId: metadata.profile.id,
			profileRevision: metadata.profile.revision,
			profileContentRevision: metadata.profile.contentRevision,
			caches: metadata.transportCaches,
		})),
		settings.enabled && settings.transportMode === "baked-ray-traced",
		settings.transportIntensity,
		rootUrl
	);
	warnings.push(...transport.warnings);
	const report: ISubsurfaceRuntimeEvidence = {
		configured: true,
		ready: Boolean(scene.prePassRenderer) && postProcessReady && maskTargetReady && materialEvidence.every((material) => material.texturesReady) && transport.ready,
		backend: "babylon-native-burley-screen-space-mask-v3",
		shaderLanguage: scene.getEngine().isWebGPU ? "WGSL" : "GLSL",
		profileCapacity: 15,
		profileCount: profileEvidence.length,
		materialCount: materialEvidence.length,
		scatteringMaterialCount: materialEvidence.filter((material) => material.mode === "subsurface-scattering" && material.subsurfaceMask > 0).length,
		transmissionMaterialCount: materialEvidence.filter((material) => material.transmissionEnabled).length,
		quality: settings.quality,
		sampleBudget: settings.sampleBudget,
		metersPerUnit: settings.metersPerUnit,
		prePassEnabled: Boolean(scene.prePassRenderer),
		postProcessReady,
		maskTargetAllocated: true,
		maskTargetReady,
		maskTargetWidth: maskTargetSize.width,
		maskTargetHeight: maskTargetSize.height,
		maskMeshCount: maskState.meshCount,
		maskTextureCount: maskState.textureCount,
		maskRenderedFrames: maskState.renderedFrames,
		frameId: scene.getFrameId(),
		profiles: profileEvidence,
		materials: materialEvidence,
		transport,
		limitations: [...limitations],
		warnings: [...new Set(warnings)],
		errors: [],
	};
	reports.set(scene, report);
	return report;
}

export function getSubsurfaceRuntime(scene: Scene): ISubsurfaceRuntimeEvidence {
	const report = reports.get(scene) ?? configureSubsurfaceScattering(scene);
	const postProcessReady = Boolean(scene.subSurfaceConfiguration?.postProcess?.isReady());
	const maskState = maskStates.get(scene);
	const maskTargetReady = Boolean(maskState?.target.isReadyForRendering());
	const maskTargetSize = maskState?.target.getSize();
	const transport = refreshSubsurfaceTransportRuntime(scene);
	return {
		...report,
		ready: report.configured && report.prePassEnabled && postProcessReady && maskTargetReady && report.materials.every((material) => material.texturesReady) && transport.ready,
		frameId: scene.getFrameId(),
		postProcessReady,
		maskTargetAllocated: Boolean(maskState),
		maskTargetReady,
		maskTargetWidth: maskTargetSize?.width ?? 0,
		maskTargetHeight: maskTargetSize?.height ?? 0,
		maskMeshCount: maskState?.meshCount ?? 0,
		maskTextureCount: maskState?.textureCount ?? 0,
		maskRenderedFrames: maskState?.renderedFrames ?? 0,
		transport,
	};
}

export function clearSubsurfaceRuntimeReport(scene: Scene): void {
	stopSubsurfaceMaskRuntime(scene);
	clearSubsurfaceTransportRuntime(scene);
	reports.delete(scene);
}

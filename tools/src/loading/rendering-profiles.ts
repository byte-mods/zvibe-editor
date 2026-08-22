import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";

import { applyRenderingConfigurationForCamera } from "../rendering/tools";
import { customColorPostProcessCameraConfigurations } from "../rendering/custom-color";
import { defaultPipelineCameraConfigurations } from "../rendering/default-pipeline";
import { motionBlurPostProcessCameraConfigurations } from "../rendering/motion-blur";
import { ssaoRenderingPipelineCameraConfigurations } from "../rendering/ssao";
import { ssrRenderingPipelineCameraConfigurations } from "../rendering/ssr";
import { taaRenderingPipelineCameraConfigurations } from "../rendering/taa";
import { vlsPostProcessCameraConfigurations } from "../rendering/vls";
import { applyShadowsQuality } from "../tools/light";
import { applyMeshesLODQuality } from "../tools/mesh";
import { applyTexturesQuality } from "../tools/texture";
import type { SceneLoaderQualitySelector } from "./loader";
import {
	configureDynamicResolution,
	getDynamicResolutionRuntime,
	IDynamicResolutionConfiguration,
	IDynamicResolutionRuntimeEvidence,
	stopDynamicResolution,
	validateDynamicResolutionConfiguration,
} from "./dynamic-resolution";
import {
	configureRenderReconstruction,
	getRenderReconstructionRuntime,
	IRenderReconstructionConfiguration,
	IRenderReconstructionRuntimeEvidence,
	stopRenderReconstruction,
	validateRenderReconstructionConfiguration,
} from "./render-reconstruction";

export const renderingProfilesMetadataKey = "babylonEditorRenderingProfiles";
export const activeRenderingProfileMetadataKey = "babylonEditorActiveRenderingProfileId";
export const renderingProfileRuntimeBackend = "bounded-project-render-pipeline-profile-v1";

export const renderingProfileTargets = ["web-performance", "mobile", "desktop", "xr", "custom"] as const;
export type RenderingProfileTarget = (typeof renderingProfileTargets)[number];
export const renderingPerformancePriorities = ["backward-compatible", "intermediate", "aggressive"] as const;
export type RenderingPerformancePriority = (typeof renderingPerformancePriorities)[number];

export interface IRenderingProfileRequirements {
	webgl2?: boolean;
	webgpu?: boolean;
	drawBuffers?: boolean;
	floatRenderTargets?: boolean;
	halfFloatRenderTargets?: boolean;
	depthTexture?: boolean;
	computeShaders?: boolean;
	multiview?: boolean;
	minimumTextureSize?: number;
	minimumDrawBuffers?: number;
	minimumMsaaSamples?: number;
}

export interface IRenderingProfileQuality {
	textures: SceneLoaderQualitySelector;
	shadows: SceneLoaderQualitySelector;
	lods: SceneLoaderQualitySelector;
	renderScale: number;
	performancePriority: RenderingPerformancePriority;
	shadowsEnabled: boolean;
	particlesEnabled: boolean;
	postProcessesEnabled: boolean;
	skipPointerMovePicking: boolean;
}

export interface IRenderingProfile {
	version: 4;
	id: string;
	name: string;
	revision: number;
	target: RenderingProfileTarget;
	quality: IRenderingProfileQuality;
	dynamicResolution: IDynamicResolutionConfiguration;
	reconstruction: IRenderReconstructionConfiguration;
	requirements: IRenderingProfileRequirements;
	configurations: Record<string, unknown>;
}

export interface IRenderingCapabilityEvidence {
	backend: "WebGPU" | "WebGL2" | "WebGL1" | "NullEngine" | "Unknown";
	webgl2: boolean;
	webgpu: boolean;
	drawBuffers: boolean;
	floatRenderTargets: boolean;
	halfFloatRenderTargets: boolean;
	depthTexture: boolean;
	computeShaders: boolean;
	multiview: boolean;
	maximumTextureSize: number;
	maximumDrawBuffers: number;
	maximumMsaaSamples: number;
}

export interface IRenderingProfileRuntimeEvidence {
	backend: typeof renderingProfileRuntimeBackend;
	configured: boolean;
	activeProfileId: string | null;
	activeProfileName: string | null;
	activeRevision: number | null;
	compatible: boolean;
	errors: string[];
	warnings: string[];
	capabilities: IRenderingCapabilityEvidence;
	dynamicResolution: IDynamicResolutionRuntimeEvidence;
	reconstruction: IRenderReconstructionRuntimeEvidence;
	applied: {
		textures: SceneLoaderQualitySelector;
		shadows: SceneLoaderQualitySelector;
		lods: SceneLoaderQualitySelector;
		renderScale: number;
		hardwareScalingLevel: number;
		performancePriority: RenderingPerformancePriority;
		shadowsEnabled: boolean;
		particlesEnabled: boolean;
		postProcessesEnabled: boolean;
		skipPointerMovePicking: boolean;
		cameraProfileApplied: boolean;
		texturesReloaded: boolean;
	} | null;
}

const qualities = ["very-low", "low", "medium", "high"] as const;
const postProcessTypes = ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"] as const;
const maximumProfiles = 32;
const runtimeBaselines = new WeakMap<
	Scene,
	{
		loadingQuality: SceneLoaderQualitySelector;
		textures: SceneLoaderQualitySelector;
		shadows: SceneLoaderQualitySelector;
		lods: SceneLoaderQualitySelector;
		hardwareScalingLevel: number;
		performancePriority: ScenePerformancePriority;
		shadowsEnabled: boolean;
		particlesEnabled: boolean;
		postProcessesEnabled: boolean;
		skipPointerMovePicking: boolean;
	}
>();

const presetQuality: Record<Exclude<RenderingProfileTarget, "custom">, IRenderingProfileQuality> = {
	"web-performance": {
		textures: "medium",
		shadows: "low",
		lods: "low",
		renderScale: 0.75,
		performancePriority: "aggressive",
		shadowsEnabled: true,
		particlesEnabled: true,
		postProcessesEnabled: true,
		skipPointerMovePicking: true,
	},
	mobile: {
		textures: "low",
		shadows: "very-low",
		lods: "very-low",
		renderScale: 0.6,
		performancePriority: "aggressive",
		shadowsEnabled: true,
		particlesEnabled: true,
		postProcessesEnabled: true,
		skipPointerMovePicking: true,
	},
	desktop: {
		textures: "high",
		shadows: "high",
		lods: "high",
		renderScale: 1,
		performancePriority: "backward-compatible",
		shadowsEnabled: true,
		particlesEnabled: true,
		postProcessesEnabled: true,
		skipPointerMovePicking: false,
	},
	xr: {
		textures: "medium",
		shadows: "low",
		lods: "medium",
		renderScale: 1,
		performancePriority: "intermediate",
		shadowsEnabled: true,
		particlesEnabled: true,
		postProcessesEnabled: true,
		skipPointerMovePicking: true,
	},
};

export function renderingProfilePreset(target: RenderingProfileTarget): IRenderingProfileQuality {
	return structuredClone(target === "custom" ? presetQuality.desktop : presetQuality[target]);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum: number, maximum: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
		throw new Error(`${label} must be ${integer ? "an integer" : "a finite number"} from ${minimum} through ${maximum}.`);
	}
	return value;
}

function validateRequirements(value: unknown): IRenderingProfileRequirements {
	const source = value === undefined ? {} : record(value, "Rendering profile requirements");
	const allowed = [
		"webgl2",
		"webgpu",
		"drawBuffers",
		"floatRenderTargets",
		"halfFloatRenderTargets",
		"depthTexture",
		"computeShaders",
		"multiview",
		"minimumTextureSize",
		"minimumDrawBuffers",
		"minimumMsaaSamples",
	];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown rendering capability requirement: ${unknown.join(", ")}.`);
	}
	for (const key of allowed.slice(0, 8)) {
		if (source[key] !== undefined && typeof source[key] !== "boolean") {
			throw new Error(`Rendering capability requirement ${key} must be boolean.`);
		}
	}
	const result = structuredClone(source) as IRenderingProfileRequirements;
	if (result.minimumTextureSize !== undefined) {
		finite(result.minimumTextureSize, "minimumTextureSize", 256, 65_536, true);
	}
	if (result.minimumDrawBuffers !== undefined) {
		finite(result.minimumDrawBuffers, "minimumDrawBuffers", 1, 16, true);
	}
	if (result.minimumMsaaSamples !== undefined) {
		finite(result.minimumMsaaSamples, "minimumMsaaSamples", 1, 16, true);
	}
	return result;
}

function validateQuality(value: unknown, target: RenderingProfileTarget): IRenderingProfileQuality {
	const source = value === undefined ? renderingProfilePreset(target) : record(value, "Rendering profile quality");
	const required = ["textures", "shadows", "lods", "renderScale", "performancePriority", "shadowsEnabled", "particlesEnabled", "postProcessesEnabled", "skipPointerMovePicking"];
	const unknown = Object.keys(source).filter((key) => !required.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown rendering profile quality field: ${unknown.join(", ")}.`);
	}
	for (const key of ["textures", "shadows", "lods"] as const) {
		if (!qualities.includes(source[key] as SceneLoaderQualitySelector)) {
			throw new Error(`Rendering profile ${key} quality is invalid.`);
		}
	}
	if (!renderingPerformancePriorities.includes(source.performancePriority as RenderingPerformancePriority)) {
		throw new Error("Rendering profile performancePriority is invalid.");
	}
	for (const key of ["shadowsEnabled", "particlesEnabled", "postProcessesEnabled", "skipPointerMovePicking"] as const) {
		if (typeof source[key] !== "boolean") {
			throw new Error(`Rendering profile ${key} must be boolean.`);
		}
	}
	finite(source.renderScale, "Rendering profile renderScale", 0.25, 2);
	return structuredClone(source) as unknown as IRenderingProfileQuality;
}

function validateConfigurations(value: unknown): Record<string, unknown> {
	const source = record(value ?? {}, "Rendering profile configurations");
	const unknown = Object.keys(source).filter((key) => !postProcessTypes.includes(key as (typeof postProcessTypes)[number]));
	if (unknown.length) {
		throw new Error(`Unsupported rendering profile post-process type "${unknown[0]}".`);
	}
	for (const [key, configuration] of Object.entries(source)) {
		if (configuration !== null && (typeof configuration !== "object" || Array.isArray(configuration))) {
			throw new Error(`Rendering profile configuration for "${key}" must be an object or null.`);
		}
	}
	return structuredClone(source);
}

function validateProfile(value: unknown, index: number): IRenderingProfile {
	const source = record(value, `Rendering profile ${index}`);
	if (source.version !== undefined && ![1, 2, 3, 4].includes(source.version as number)) {
		throw new Error(`Rendering profile ${index} version must be 1, 2, 3, or 4.`);
	}
	const target = (source.target ?? "custom") as RenderingProfileTarget;
	if (!renderingProfileTargets.includes(target)) {
		throw new Error(`Rendering profile ${index} target is invalid.`);
	}
	if (typeof source.id !== "string" || !source.id || typeof source.name !== "string" || !source.name.trim()) {
		throw new Error(`Rendering profile ${index} requires non-empty id and name.`);
	}
	const revision = source.revision === undefined ? 1 : finite(source.revision, `Rendering profile ${index} revision`, 1, Number.MAX_SAFE_INTEGER, true);
	const quality = validateQuality(source.quality, target);
	const reconstruction = validateRenderReconstructionConfiguration(source.reconstruction);
	const configurations = validateConfigurations(source.configurations);
	if (reconstruction.mode === "temporal" && configurations.taa !== undefined && configurations.taa !== null) {
		throw new Error(`Rendering profile ${index} cannot enable both TAA and temporal reconstruction.`);
	}
	return {
		version: 4,
		id: source.id,
		name: source.name,
		revision,
		target,
		quality,
		dynamicResolution: validateDynamicResolutionConfiguration(source.dynamicResolution, quality.renderScale),
		reconstruction,
		requirements: validateRequirements(source.requirements),
		configurations,
	};
}

export function validateRenderingProfiles(value: unknown): IRenderingProfile[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumProfiles) {
		throw new Error(`Rendering profiles must be an array with at most ${maximumProfiles} entries.`);
	}
	const profiles = value.map(validateProfile);
	if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length || new Set(profiles.map((profile) => profile.name)).size !== profiles.length) {
		throw new Error("Rendering profile ids and names must be unique.");
	}
	return profiles;
}

export function inspectRenderingCapabilities(scene: Scene): IRenderingCapabilityEvidence {
	const engine = scene.getEngine();
	const caps = engine.getCaps();
	const className = engine.getClassName();
	const constructorName = engine.constructor.name;
	const webgpu = engine.isWebGPU;
	const webglVersion = typeof (engine as unknown as { webGLVersion?: number }).webGLVersion === "number" ? (engine as unknown as { webGLVersion: number }).webGLVersion : 0;
	const backend =
		className === "NullEngine" || constructorName === "NullEngine" ? "NullEngine" : webgpu ? "WebGPU" : webglVersion >= 2 ? "WebGL2" : webglVersion > 0 ? "WebGL1" : "Unknown";
	return {
		backend,
		webgl2: webglVersion >= 2,
		webgpu,
		drawBuffers: Boolean(caps.drawBuffersExtension),
		floatRenderTargets: Boolean(caps.textureFloat && caps.textureFloatRender),
		halfFloatRenderTargets: Boolean(caps.textureHalfFloat && caps.textureHalfFloatRender),
		depthTexture: Boolean(caps.depthTextureExtension),
		computeShaders: Boolean(caps.supportComputeShaders),
		multiview: Boolean(caps.multiview || caps.oculusMultiview),
		maximumTextureSize: caps.maxTextureSize,
		maximumDrawBuffers: caps.maxDrawBuffers ?? 1,
		maximumMsaaSamples: caps.maxMSAASamples,
	};
}

export function validateRenderingProfileCapabilities(
	profile: IRenderingProfile,
	capabilities: IRenderingCapabilityEvidence
): { compatible: boolean; errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const required = profile.requirements;
	for (const key of ["webgl2", "webgpu", "drawBuffers", "floatRenderTargets", "halfFloatRenderTargets", "depthTexture", "computeShaders", "multiview"] as const) {
		if (required[key] && !capabilities[key]) {
			errors.push(`Required capability ${key} is unavailable.`);
		}
	}
	if ((required.minimumTextureSize ?? 0) > capabilities.maximumTextureSize) {
		errors.push(`Required texture size ${required.minimumTextureSize} exceeds ${capabilities.maximumTextureSize}.`);
	}
	if ((required.minimumDrawBuffers ?? 0) > capabilities.maximumDrawBuffers) {
		errors.push(`Required draw buffers ${required.minimumDrawBuffers} exceeds ${capabilities.maximumDrawBuffers}.`);
	}
	if ((required.minimumMsaaSamples ?? 0) > capabilities.maximumMsaaSamples) {
		errors.push(`Required MSAA samples ${required.minimumMsaaSamples} exceeds ${capabilities.maximumMsaaSamples}.`);
	}
	const warnings: string[] = [];
	if (profile.target === "xr" && !capabilities.multiview) {
		warnings.push("XR multiview is unavailable; stereo rendering may use a slower fallback.");
	}
	if (profile.quality.renderScale > 1 && capabilities.maximumTextureSize < 4096) {
		warnings.push("Supersampling may exceed the available render-target size on this device.");
	}
	return { compatible: errors.length === 0, errors, warnings };
}

export function applyRenderingProfileConfigurations(camera: Camera, profile: Pick<IRenderingProfile, "configurations">, rootUrl: string): void {
	const configurations = profile.configurations as Record<string, any>;
	ssaoRenderingPipelineCameraConfigurations.set(camera, configurations.ssao ?? null);
	vlsPostProcessCameraConfigurations.set(camera, configurations.vls ?? null);
	ssrRenderingPipelineCameraConfigurations.set(camera, configurations.ssr ?? null);
	motionBlurPostProcessCameraConfigurations.set(camera, configurations.motionBlur ?? null);
	defaultPipelineCameraConfigurations.set(camera, configurations.default ?? null);
	taaRenderingPipelineCameraConfigurations.set(camera, configurations.taa ?? null);
	customColorPostProcessCameraConfigurations.set(camera, configurations.customColor ?? null);
	applyRenderingConfigurationForCamera(camera, rootUrl);
}

function priority(value: RenderingPerformancePriority): ScenePerformancePriority {
	return value === "aggressive"
		? ScenePerformancePriority.Aggressive
		: value === "intermediate"
			? ScenePerformancePriority.Intermediate
			: ScenePerformancePriority.BackwardCompatible;
}

export function applyRenderingProfileQuality(scene: Scene, profile: IRenderingProfile, rootUrl?: string, applyCamera = true): IRenderingProfileRuntimeEvidence {
	const capabilities = inspectRenderingCapabilities(scene);
	const validation = validateRenderingProfileCapabilities(profile, capabilities);
	if (!validation.compatible) {
		return {
			backend: renderingProfileRuntimeBackend,
			configured: false,
			activeProfileId: profile.id,
			activeProfileName: profile.name,
			activeRevision: profile.revision,
			...validation,
			capabilities,
			dynamicResolution: getDynamicResolutionRuntime(scene),
			reconstruction: getRenderReconstructionRuntime(scene),
			applied: null,
		};
	}
	const quality = profile.quality;
	if (!runtimeBaselines.has(scene)) {
		runtimeBaselines.set(scene, {
			loadingQuality: scene.loadingQuality ?? "high",
			textures: scene.loadingTexturesQuality ?? "high",
			shadows: scene.loadingShadowsQuality ?? "high",
			lods: scene.loadingLodsQuality ?? "high",
			hardwareScalingLevel: scene.getEngine().getHardwareScalingLevel(),
			performancePriority: scene.performancePriority,
			shadowsEnabled: scene.shadowsEnabled,
			particlesEnabled: scene.particlesEnabled,
			postProcessesEnabled: scene.postProcessesEnabled,
			skipPointerMovePicking: scene.skipPointerMovePicking,
		});
	}
	scene.loadingQuality = quality.textures;
	scene.loadingShadowsQuality = quality.shadows;
	scene.loadingLodsQuality = quality.lods;
	const texturesReloaded = rootUrl !== undefined;
	if (texturesReloaded) {
		applyTexturesQuality(quality.textures, scene, rootUrl);
	} else {
		scene.loadingTexturesQuality = quality.textures;
	}
	applyShadowsQuality(quality.shadows, scene);
	applyMeshesLODQuality(quality.lods, scene);
	const engine = scene.getEngine();
	scene.performancePriority = priority(quality.performancePriority);
	scene.shadowsEnabled = quality.shadowsEnabled;
	scene.particlesEnabled = quality.particlesEnabled;
	scene.postProcessesEnabled = quality.postProcessesEnabled;
	scene.skipPointerMovePicking = quality.skipPointerMovePicking;
	const cameraProfileApplied = Boolean(scene.activeCamera && applyCamera);
	if (scene.activeCamera && applyCamera) {
		applyRenderingProfileConfigurations(scene.activeCamera, profile, rootUrl ?? "");
	}
	if (profile.reconstruction.mode === "disabled") {
		engine.setHardwareScalingLevel(1 / quality.renderScale);
	}
	const reconstruction = configureRenderReconstruction(scene, scene.activeCamera, profile.id, profile.revision, profile.reconstruction, quality.renderScale);
	const dynamicResolution = configureDynamicResolution(scene, profile.id, profile.revision, profile.dynamicResolution, quality.renderScale);
	return {
		backend: renderingProfileRuntimeBackend,
		configured: true,
		activeProfileId: profile.id,
		activeProfileName: profile.name,
		activeRevision: profile.revision,
		...validation,
		capabilities,
		dynamicResolution,
		reconstruction,
		applied: {
			textures: quality.textures,
			shadows: quality.shadows,
			lods: quality.lods,
			renderScale: quality.renderScale,
			hardwareScalingLevel: engine.getHardwareScalingLevel(),
			performancePriority: quality.performancePriority,
			shadowsEnabled: scene.shadowsEnabled,
			particlesEnabled: scene.particlesEnabled,
			postProcessesEnabled: scene.postProcessesEnabled,
			skipPointerMovePicking: scene.skipPointerMovePicking,
			cameraProfileApplied,
			texturesReloaded,
		},
	};
}

function emptyRuntime(scene: Scene, error: string | null = null): IRenderingProfileRuntimeEvidence {
	return {
		backend: renderingProfileRuntimeBackend,
		configured: false,
		activeProfileId: null,
		activeProfileName: null,
		activeRevision: null,
		compatible: error === null,
		errors: error ? [error] : [],
		warnings: [],
		capabilities: inspectRenderingCapabilities(scene),
		dynamicResolution: getDynamicResolutionRuntime(scene),
		reconstruction: getRenderReconstructionRuntime(scene),
		applied: null,
	};
}

/** Clears the active project profile and restores the exact pre-activation global runtime baseline when available. */
export function restoreRenderingProfileBaseline(scene: Scene): IRenderingProfileRuntimeEvidence {
	stopDynamicResolution(scene);
	stopRenderReconstruction(scene);
	const baseline = runtimeBaselines.get(scene);
	if (baseline) {
		scene.loadingQuality = baseline.loadingQuality;
		scene.loadingTexturesQuality = baseline.textures;
		scene.loadingShadowsQuality = baseline.shadows;
		scene.loadingLodsQuality = baseline.lods;
		scene.getEngine().setHardwareScalingLevel(baseline.hardwareScalingLevel);
		scene.performancePriority = baseline.performancePriority;
		scene.shadowsEnabled = baseline.shadowsEnabled;
		scene.particlesEnabled = baseline.particlesEnabled;
		scene.postProcessesEnabled = baseline.postProcessesEnabled;
		scene.skipPointerMovePicking = baseline.skipPointerMovePicking;
		runtimeBaselines.delete(scene);
	}
	return (scene.renderingProfileRuntime = emptyRuntime(scene));
}

declare module "@babylonjs/core/scene" {
	// Babylon module augmentation must retain the engine's public Scene name.
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		renderingProfileRuntime?: IRenderingProfileRuntimeEvidence;
	}
}

/** Validates persisted profiles and applies the active project render-pipeline asset. */
export function configureActiveRenderingProfile(scene: Scene, rootUrl?: string, applyCamera = true): IRenderingProfileRuntimeEvidence {
	try {
		const profiles = validateRenderingProfiles(scene.metadata?.[renderingProfilesMetadataKey]);
		if (scene.metadata) {
			scene.metadata[renderingProfilesMetadataKey] = profiles;
		}
		const activeId = scene.metadata?.[activeRenderingProfileMetadataKey];
		if (activeId === undefined || activeId === null) {
			stopDynamicResolution(scene);
			stopRenderReconstruction(scene);
			return (scene.renderingProfileRuntime = emptyRuntime(scene));
		}
		if (typeof activeId !== "string") {
			throw new Error("Active rendering profile id must be a string or null.");
		}
		const profile = profiles.find((candidate) => candidate.id === activeId);
		if (!profile) {
			throw new Error(`Active rendering profile "${activeId}" was not found.`);
		}
		return (scene.renderingProfileRuntime = applyRenderingProfileQuality(scene, profile, rootUrl, applyCamera));
	} catch (error) {
		stopDynamicResolution(scene);
		stopRenderReconstruction(scene);
		return (scene.renderingProfileRuntime = emptyRuntime(scene, error instanceof Error ? error.message : String(error)));
	}
}

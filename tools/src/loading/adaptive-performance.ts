import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";

import { applyShadowsQuality } from "../tools/light";
import { applyMeshesLODQuality } from "../tools/mesh";
import type { SceneLoaderQualitySelector } from "./loader";
import { getDynamicResolutionRuntime } from "./dynamic-resolution";

export const adaptivePerformanceMetadataKey = "babylonEditorAdaptivePerformance";
export const adaptivePerformanceRuntimeBackend = "bounded-adaptive-performance-v1";
export const adaptivePerformanceVersion = 1 as const;

export const adaptivePerformanceProviders = ["auto", "basic", "apple"] as const;
export const adaptivePerformancePlatforms = ["web", "electron", "android", "ios", "tvos", "visionos", "unknown"] as const;
export const adaptivePerformanceThermalStates = ["unknown", "nominal", "fair", "serious", "critical"] as const;
export const adaptivePerformanceBottlenecks = ["unknown", "cpu", "gpu", "target-frame-rate"] as const;
export const adaptivePerformanceScalerIds = ["render-scale", "lod-quality", "shadow-quality", "view-distance", "post-process", "particles"] as const;
export const adaptivePerformanceScalerTargets = ["cpu", "gpu", "fillrate", "all"] as const;
export const adaptivePerformanceVisualImpacts = ["low", "medium", "high"] as const;

export type AdaptivePerformanceProvider = (typeof adaptivePerformanceProviders)[number];
export type AdaptivePerformancePlatform = (typeof adaptivePerformancePlatforms)[number];
export type AdaptivePerformanceThermalState = (typeof adaptivePerformanceThermalStates)[number];
export type AdaptivePerformanceBottleneck = (typeof adaptivePerformanceBottlenecks)[number];
export type AdaptivePerformanceScalerId = (typeof adaptivePerformanceScalerIds)[number];
export type AdaptivePerformanceScalerTarget = (typeof adaptivePerformanceScalerTargets)[number];
export type AdaptivePerformanceVisualImpact = (typeof adaptivePerformanceVisualImpacts)[number];

export interface IAdaptivePerformanceScalerConfiguration {
	id: AdaptivePerformanceScalerId;
	enabled: boolean;
	minimumScale: number;
	maximumScale: number;
	maximumLevel: number;
	visualImpact: AdaptivePerformanceVisualImpact;
	target: AdaptivePerformanceScalerTarget;
}

export interface IAdaptivePerformanceConfiguration {
	version: typeof adaptivePerformanceVersion;
	revision: number;
	enabled: boolean;
	provider: AdaptivePerformanceProvider;
	platform: AdaptivePerformancePlatform;
	targetFrameRate: number;
	sampleFrames: number;
	thermalActionDelaySeconds: number;
	performanceActionDelaySeconds: number;
	downscaleFrameTimeRatio: number;
	upscaleFrameTimeRatio: number;
	scalers: IAdaptivePerformanceScalerConfiguration[];
}

export interface IAdaptivePerformanceProviderSample {
	thermalState?: AdaptivePerformanceThermalState;
	temperatureLevel?: number | null;
	lowPowerMode?: boolean | null;
	cpuFrameTimeMs?: number | null;
	gpuFrameTimeMs?: number | null;
	frameTimeMs?: number | null;
}

export interface IAdaptivePerformanceScalerRuntime {
	id: AdaptivePerformanceScalerId;
	enabled: boolean;
	level: number;
	maximumLevel: number;
	scale: number;
	visualImpact: AdaptivePerformanceVisualImpact;
	target: AdaptivePerformanceScalerTarget;
	lastApplied: string;
}

export interface IAdaptivePerformanceActionEvidence {
	frame: number;
	reason: "thermal" | "performance" | "recovery";
	direction: "decrease-quality" | "increase-quality";
	scalerId: AdaptivePerformanceScalerId;
	fromLevel: number;
	toLevel: number;
	thermalState: AdaptivePerformanceThermalState;
	bottleneck: AdaptivePerformanceBottleneck;
}

export interface IAdaptivePerformanceProviderEventEvidence {
	frame: number;
	source: "basic" | "apple-native" | "editor-simulation" | "script";
	thermalState: AdaptivePerformanceThermalState;
	temperatureLevel: number | null;
	lowPowerMode: boolean | null;
}

export interface IAdaptivePerformanceRuntimeEvidence {
	backend: typeof adaptivePerformanceRuntimeBackend;
	configured: boolean;
	configurationRevision: number | null;
	running: boolean;
	requestedProvider: AdaptivePerformanceProvider;
	activeProvider: "basic" | "apple" | null;
	providerAvailable: boolean;
	providerSource: "frame-cadence" | "apple-native-bridge" | "basic-fallback" | "none";
	platform: AdaptivePerformancePlatform;
	measurement: "engine-frame-cadence-with-optional-provider-timings";
	targetFrameRate: number;
	targetFrameTimeMs: number;
	totalFrames: number;
	acceptedSamples: number;
	ignoredSamples: number;
	windowSamples: number;
	averageFrameTimeMs: number | null;
	averageCpuFrameTimeMs: number | null;
	averageGpuFrameTimeMs: number | null;
	bottleneck: AdaptivePerformanceBottleneck;
	thermalState: AdaptivePerformanceThermalState;
	temperatureLevel: number | null;
	lowPowerMode: boolean | null;
	thermalWarning: boolean;
	qualityIndex: number;
	lastDecision: "initial" | "collecting" | "hold" | "decrease-quality" | "increase-quality" | "reset" | "stopped";
	lastReason: string;
	scalers: IAdaptivePerformanceScalerRuntime[];
	actions: IAdaptivePerformanceActionEvidence[];
	providerEvents: IAdaptivePerformanceProviderEventEvidence[];
	warnings: string[];
	errors: string[];
}

interface IAdaptivePerformanceBaseline {
	hardwareScalingLevel: number;
	shadowsEnabled: boolean;
	particlesEnabled: boolean;
	postProcessesEnabled: boolean;
	lods: SceneLoaderQualitySelector;
	shadows: SceneLoaderQualitySelector;
	cameraMaxZ: number | null;
}

interface IAdaptivePerformanceController {
	configuration: IAdaptivePerformanceConfiguration;
	runtime: IAdaptivePerformanceRuntimeEvidence;
	baseline: IAdaptivePerformanceBaseline;
	frameSamples: number[];
	cpuSamples: number[];
	gpuSamples: number[];
	elapsedMs: number;
	lastThermalActionMs: number;
	lastPerformanceActionMs: number;
	renderObserver: Observer<Scene> | null;
	disposeObserver: Observer<Scene> | null;
	providerCleanup: (() => void) | null;
}

interface IAppleBridgeSubscription {
	remove(): void | Promise<void>;
}

interface IAppleAdaptivePerformanceBridge {
	getState?: () => IAdaptivePerformanceProviderSample | Promise<IAdaptivePerformanceProviderSample>;
	addListener?: (
		eventName: "thermalStateChanged",
		callback: (sample: IAdaptivePerformanceProviderSample) => void
	) => IAppleBridgeSubscription | Promise<IAppleBridgeSubscription>;
}

const maximumHistory = 64;
const controllers = new WeakMap<Scene, IAdaptivePerformanceController>();

const scalerDefaults: Record<AdaptivePerformanceScalerId, Omit<IAdaptivePerformanceScalerConfiguration, "id">> = {
	"render-scale": { enabled: true, minimumScale: 0.5, maximumScale: 1, maximumLevel: 4, visualImpact: "medium", target: "fillrate" },
	"lod-quality": { enabled: true, minimumScale: 0.25, maximumScale: 1, maximumLevel: 3, visualImpact: "medium", target: "gpu" },
	"shadow-quality": { enabled: true, minimumScale: 0.125, maximumScale: 1, maximumLevel: 3, visualImpact: "low", target: "gpu" },
	"view-distance": { enabled: true, minimumScale: 0.4, maximumScale: 1, maximumLevel: 4, visualImpact: "medium", target: "cpu" },
	"post-process": { enabled: true, minimumScale: 0, maximumScale: 1, maximumLevel: 1, visualImpact: "low", target: "fillrate" },
	particles: { enabled: true, minimumScale: 0, maximumScale: 1, maximumLevel: 1, visualImpact: "low", target: "all" },
};

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

function rounded(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function average(values: readonly number[]): number | null {
	return values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function inferPlatform(): AdaptivePerformancePlatform {
	const processLike = (globalThis as unknown as { process?: { versions?: { electron?: string } } }).process;
	if (processLike?.versions?.electron) {
		return "electron";
	}
	const navigatorLike = (globalThis as unknown as { navigator?: { userAgent?: string } }).navigator;
	const userAgent = navigatorLike?.userAgent?.toLowerCase() ?? "";
	if (/iphone|ipad|ipod/.test(userAgent)) {
		return "ios";
	}
	if (userAgent.includes("android")) {
		return "android";
	}
	return userAgent ? "web" : "unknown";
}

function defaultScalers(): IAdaptivePerformanceScalerConfiguration[] {
	return adaptivePerformanceScalerIds.map((id) => ({ id, ...structuredClone(scalerDefaults[id]) }));
}

export function adaptivePerformancePreset(): IAdaptivePerformanceConfiguration {
	return {
		version: adaptivePerformanceVersion,
		revision: 1,
		enabled: false,
		provider: "auto",
		platform: inferPlatform(),
		targetFrameRate: 60,
		sampleFrames: 30,
		thermalActionDelaySeconds: 1,
		performanceActionDelaySeconds: 1,
		downscaleFrameTimeRatio: 1.1,
		upscaleFrameTimeRatio: 0.8,
		scalers: defaultScalers(),
	};
}

function validateScaler(value: unknown, index: number): IAdaptivePerformanceScalerConfiguration {
	const source = record(value, `Adaptive Performance scaler ${index}`);
	const allowed = ["id", "enabled", "minimumScale", "maximumScale", "maximumLevel", "visualImpact", "target"];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown Adaptive Performance scaler field: ${unknown.join(", ")}.`);
	}
	if (!adaptivePerformanceScalerIds.includes(source.id as AdaptivePerformanceScalerId)) {
		throw new Error(`Adaptive Performance scaler ${index} id is invalid.`);
	}
	const id = source.id as AdaptivePerformanceScalerId;
	const fallback = scalerDefaults[id];
	if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
		throw new Error(`Adaptive Performance scaler ${id} enabled must be boolean.`);
	}
	const result: IAdaptivePerformanceScalerConfiguration = {
		id,
		enabled: source.enabled ?? fallback.enabled,
		minimumScale: finite(source.minimumScale ?? fallback.minimumScale, `${id} minimumScale`, 0, 2),
		maximumScale: finite(source.maximumScale ?? fallback.maximumScale, `${id} maximumScale`, 0, 2),
		maximumLevel: finite(source.maximumLevel ?? fallback.maximumLevel, `${id} maximumLevel`, 1, 32, true),
		visualImpact: (source.visualImpact ?? fallback.visualImpact) as AdaptivePerformanceVisualImpact,
		target: (source.target ?? fallback.target) as AdaptivePerformanceScalerTarget,
	};
	if (result.minimumScale > result.maximumScale) {
		throw new Error(`Adaptive Performance scaler ${id} minimumScale cannot exceed maximumScale.`);
	}
	if (!adaptivePerformanceVisualImpacts.includes(result.visualImpact)) {
		throw new Error(`Adaptive Performance scaler ${id} visualImpact is invalid.`);
	}
	if (!adaptivePerformanceScalerTargets.includes(result.target)) {
		throw new Error(`Adaptive Performance scaler ${id} target is invalid.`);
	}
	return result;
}

export function validateAdaptivePerformanceConfiguration(value: unknown): IAdaptivePerformanceConfiguration {
	if (value === undefined || value === null) {
		return adaptivePerformancePreset();
	}
	const source = record(value, "Adaptive Performance configuration");
	const allowed = [
		"version",
		"revision",
		"enabled",
		"provider",
		"platform",
		"targetFrameRate",
		"sampleFrames",
		"thermalActionDelaySeconds",
		"performanceActionDelaySeconds",
		"downscaleFrameTimeRatio",
		"upscaleFrameTimeRatio",
		"scalers",
	];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown Adaptive Performance configuration field: ${unknown.join(", ")}.`);
	}
	if (source.version !== undefined && source.version !== adaptivePerformanceVersion) {
		throw new Error("Adaptive Performance configuration version must be 1.");
	}
	const fallback = adaptivePerformancePreset();
	if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
		throw new Error("Adaptive Performance enabled must be boolean.");
	}
	const provider = (source.provider ?? fallback.provider) as AdaptivePerformanceProvider;
	const platform = (source.platform ?? fallback.platform) as AdaptivePerformancePlatform;
	if (!adaptivePerformanceProviders.includes(provider)) {
		throw new Error("Adaptive Performance provider is invalid.");
	}
	if (!adaptivePerformancePlatforms.includes(platform)) {
		throw new Error("Adaptive Performance platform is invalid.");
	}
	const scalerValues = source.scalers ?? fallback.scalers;
	if (!Array.isArray(scalerValues) || scalerValues.length > adaptivePerformanceScalerIds.length) {
		throw new Error(`Adaptive Performance scalers must be an array with at most ${adaptivePerformanceScalerIds.length} entries.`);
	}
	const supplied = scalerValues.map(validateScaler);
	if (new Set(supplied.map((scaler) => scaler.id)).size !== supplied.length) {
		throw new Error("Adaptive Performance scaler ids must be unique.");
	}
	const scalers = adaptivePerformanceScalerIds.map(
		(id) => supplied.find((scaler) => scaler.id === id) ?? ({ id, ...structuredClone(scalerDefaults[id]) } as IAdaptivePerformanceScalerConfiguration)
	);
	const result: IAdaptivePerformanceConfiguration = {
		version: adaptivePerformanceVersion,
		revision: finite(source.revision ?? fallback.revision, "Adaptive Performance revision", 1, Number.MAX_SAFE_INTEGER, true),
		enabled: source.enabled ?? fallback.enabled,
		provider,
		platform,
		targetFrameRate: finite(source.targetFrameRate ?? fallback.targetFrameRate, "Adaptive Performance targetFrameRate", 15, 240),
		sampleFrames: finite(source.sampleFrames ?? fallback.sampleFrames, "Adaptive Performance sampleFrames", 2, 240, true),
		thermalActionDelaySeconds: finite(source.thermalActionDelaySeconds ?? fallback.thermalActionDelaySeconds, "Adaptive Performance thermalActionDelaySeconds", 0, 600),
		performanceActionDelaySeconds: finite(
			source.performanceActionDelaySeconds ?? fallback.performanceActionDelaySeconds,
			"Adaptive Performance performanceActionDelaySeconds",
			0,
			600
		),
		downscaleFrameTimeRatio: finite(source.downscaleFrameTimeRatio ?? fallback.downscaleFrameTimeRatio, "Adaptive Performance downscaleFrameTimeRatio", 1.01, 3),
		upscaleFrameTimeRatio: finite(source.upscaleFrameTimeRatio ?? fallback.upscaleFrameTimeRatio, "Adaptive Performance upscaleFrameTimeRatio", 0.1, 0.99),
		scalers,
	};
	return result;
}

function resolveAppleBridge(): IAppleAdaptivePerformanceBridge | null {
	const root = globalThis as unknown as {
		ZvibeAdaptivePerformance?: IAppleAdaptivePerformanceBridge;
		Capacitor?: { Plugins?: { ZvibeAdaptivePerformance?: IAppleAdaptivePerformanceBridge } };
	};
	return root.ZvibeAdaptivePerformance ?? root.Capacitor?.Plugins?.ZvibeAdaptivePerformance ?? null;
}

function platformSupportsApple(platform: AdaptivePerformancePlatform): boolean {
	return platform === "ios" || platform === "tvos" || platform === "visionos";
}

function captureBaseline(scene: Scene): IAdaptivePerformanceBaseline {
	return {
		hardwareScalingLevel: scene.getEngine().getHardwareScalingLevel(),
		shadowsEnabled: scene.shadowsEnabled,
		particlesEnabled: scene.particlesEnabled,
		postProcessesEnabled: scene.postProcessesEnabled,
		lods: scene.loadingLodsQuality ?? "high",
		shadows: scene.loadingShadowsQuality ?? "high",
		cameraMaxZ: scene.activeCamera?.maxZ ?? null,
	};
}

function scalerScale(configuration: IAdaptivePerformanceScalerConfiguration, level: number): number {
	return rounded(configuration.maximumScale - (level / configuration.maximumLevel) * (configuration.maximumScale - configuration.minimumScale));
}

function qualityForLevel(level: number, maximumLevel: number): SceneLoaderQualitySelector {
	const ratio = level / maximumLevel;
	return ratio <= 0 ? "high" : ratio <= 1 / 3 ? "medium" : ratio <= 2 / 3 ? "low" : "very-low";
}

function replaceWarning(runtime: IAdaptivePerformanceRuntimeEvidence, prefix: string, value: string | null): void {
	runtime.warnings = runtime.warnings.filter((warning) => !warning.startsWith(prefix));
	if (value) {
		runtime.warnings.push(`${prefix}${value}`);
	}
}

function applyScaler(scene: Scene, controller: IAdaptivePerformanceController, scaler: IAdaptivePerformanceScalerRuntime): void {
	const configuration = controller.configuration.scalers.find((candidate) => candidate.id === scaler.id)!;
	const scale = scalerScale(configuration, scaler.level);
	scaler.scale = scale;
	switch (scaler.id) {
		case "render-scale": {
			const dynamicResolution = getDynamicResolutionRuntime(scene);
			if (dynamicResolution.running) {
				scaler.lastApplied = "Skipped because the active adaptive dynamic-resolution runtime owns hardware scaling.";
				replaceWarning(controller.runtime, "Render scale conflict: ", scaler.lastApplied);
				return;
			}
			scene.getEngine().setHardwareScalingLevel(controller.baseline.hardwareScalingLevel / Math.max(0.01, scale));
			scaler.lastApplied = `Hardware scale multiplier ${scale}.`;
			replaceWarning(controller.runtime, "Render scale conflict: ", null);
			return;
		}
		case "lod-quality": {
			const quality = qualityForLevel(scaler.level, scaler.maximumLevel);
			scene.loadingLodsQuality = quality;
			applyMeshesLODQuality(quality, scene);
			scaler.lastApplied = `Mesh LOD quality ${quality}.`;
			return;
		}
		case "shadow-quality": {
			const quality = qualityForLevel(scaler.level, scaler.maximumLevel);
			scene.loadingShadowsQuality = quality;
			applyShadowsQuality(quality, scene);
			scene.shadowsEnabled = controller.baseline.shadowsEnabled && scale > 0;
			scaler.lastApplied = `Shadow quality ${quality}; shadows ${scene.shadowsEnabled ? "enabled" : "disabled"}.`;
			return;
		}
		case "view-distance":
			if (scene.activeCamera && controller.baseline.cameraMaxZ !== null) {
				scene.activeCamera.maxZ = controller.baseline.cameraMaxZ * Math.max(0.01, scale);
				scaler.lastApplied = `Camera maxZ ${rounded(scene.activeCamera.maxZ)}.`;
			} else {
				scaler.lastApplied = "No active-camera baseline was available.";
			}
			return;
		case "post-process":
			scene.postProcessesEnabled = controller.baseline.postProcessesEnabled && scaler.level === 0;
			scaler.lastApplied = `Post-processes ${scene.postProcessesEnabled ? "enabled" : "disabled"}.`;
			return;
		case "particles":
			scene.particlesEnabled = controller.baseline.particlesEnabled && scaler.level === 0;
			scaler.lastApplied = `Particles ${scene.particlesEnabled ? "enabled" : "disabled"}.`;
	}
}

function restoreBaseline(scene: Scene, controller: IAdaptivePerformanceController): void {
	const baseline = controller.baseline;
	scene.getEngine().setHardwareScalingLevel(baseline.hardwareScalingLevel);
	scene.shadowsEnabled = baseline.shadowsEnabled;
	scene.particlesEnabled = baseline.particlesEnabled;
	scene.postProcessesEnabled = baseline.postProcessesEnabled;
	scene.loadingLodsQuality = baseline.lods;
	scene.loadingShadowsQuality = baseline.shadows;
	applyMeshesLODQuality(baseline.lods, scene);
	applyShadowsQuality(baseline.shadows, scene);
	if (scene.activeCamera && baseline.cameraMaxZ !== null) {
		scene.activeCamera.maxZ = baseline.cameraMaxZ;
	}
}

function impactRank(value: AdaptivePerformanceVisualImpact): number {
	return value === "low" ? 0 : value === "medium" ? 1 : 2;
}

function targetMatches(target: AdaptivePerformanceScalerTarget, bottleneck: AdaptivePerformanceBottleneck): boolean {
	if (target === "all" || bottleneck === "unknown") {
		return true;
	}
	if (target === "fillrate") {
		return bottleneck === "gpu";
	}
	return target === bottleneck;
}

function selectScaler(controller: IAdaptivePerformanceController, direction: "decrease-quality" | "increase-quality"): IAdaptivePerformanceScalerRuntime | null {
	const candidates = controller.runtime.scalers.filter((scaler) => scaler.enabled && (direction === "decrease-quality" ? scaler.level < scaler.maximumLevel : scaler.level > 0));
	candidates.sort((left, right) => {
		const leftMatch = targetMatches(left.target, controller.runtime.bottleneck) ? 0 : 1;
		const rightMatch = targetMatches(right.target, controller.runtime.bottleneck) ? 0 : 1;
		if (leftMatch !== rightMatch) {
			return leftMatch - rightMatch;
		}
		const impact =
			direction === "decrease-quality" ? impactRank(left.visualImpact) - impactRank(right.visualImpact) : impactRank(right.visualImpact) - impactRank(left.visualImpact);
		if (impact !== 0) {
			return impact;
		}
		return left.id.localeCompare(right.id);
	});
	return candidates[0] ?? null;
}

function qualityIndex(runtime: IAdaptivePerformanceRuntimeEvidence): number {
	const enabled = runtime.scalers.filter((scaler) => scaler.enabled);
	if (!enabled.length) {
		return 1;
	}
	const degradation = enabled.reduce((sum, scaler) => sum + scaler.level / scaler.maximumLevel, 0) / enabled.length;
	return rounded(Math.max(0, 1 - degradation));
}

function changeOneScaler(
	scene: Scene,
	controller: IAdaptivePerformanceController,
	direction: "decrease-quality" | "increase-quality",
	reason: IAdaptivePerformanceActionEvidence["reason"]
): boolean {
	const scaler = selectScaler(controller, direction);
	if (!scaler) {
		return false;
	}
	const fromLevel = scaler.level;
	scaler.level += direction === "decrease-quality" ? 1 : -1;
	applyScaler(scene, controller, scaler);
	controller.runtime.actions.push({
		frame: controller.runtime.totalFrames,
		reason,
		direction,
		scalerId: scaler.id,
		fromLevel,
		toLevel: scaler.level,
		thermalState: controller.runtime.thermalState,
		bottleneck: controller.runtime.bottleneck,
	});
	if (controller.runtime.actions.length > maximumHistory) {
		controller.runtime.actions.shift();
	}
	controller.runtime.qualityIndex = qualityIndex(controller.runtime);
	controller.runtime.lastDecision = direction;
	controller.runtime.lastReason = `${reason === "thermal" ? "Thermal pressure" : reason === "performance" ? "Frame pressure" : "Recovered headroom"} changed ${scaler.id} from level ${fromLevel} to ${scaler.level}.`;
	return true;
}

function classifyBottleneck(runtime: IAdaptivePerformanceRuntimeEvidence): AdaptivePerformanceBottleneck {
	const cpu = runtime.averageCpuFrameTimeMs;
	const gpu = runtime.averageGpuFrameTimeMs;
	const frame = runtime.averageFrameTimeMs;
	if (cpu !== null && gpu !== null) {
		return cpu > gpu * 1.1 ? "cpu" : gpu > cpu * 1.1 ? "gpu" : "unknown";
	}
	if (frame !== null && frame <= runtime.targetFrameTimeMs * 1.05) {
		return "target-frame-rate";
	}
	return "unknown";
}

function thermalPressure(state: AdaptivePerformanceThermalState): number {
	return state === "critical" ? 3 : state === "serious" ? 2 : state === "fair" ? 1 : 0;
}

function recordProviderEvent(
	controller: IAdaptivePerformanceController,
	sample: IAdaptivePerformanceProviderSample,
	source: IAdaptivePerformanceProviderEventEvidence["source"]
): void {
	controller.runtime.providerEvents.push({
		frame: controller.runtime.totalFrames,
		source,
		thermalState: sample.thermalState ?? controller.runtime.thermalState,
		temperatureLevel: sample.temperatureLevel ?? controller.runtime.temperatureLevel,
		lowPowerMode: sample.lowPowerMode ?? controller.runtime.lowPowerMode,
	});
	if (controller.runtime.providerEvents.length > maximumHistory) {
		controller.runtime.providerEvents.shift();
	}
}

function validateProviderSample(value: unknown): IAdaptivePerformanceProviderSample {
	const source = record(value, "Adaptive Performance provider sample");
	const allowed = ["thermalState", "temperatureLevel", "lowPowerMode", "cpuFrameTimeMs", "gpuFrameTimeMs", "frameTimeMs"];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown Adaptive Performance provider sample field: ${unknown.join(", ")}.`);
	}
	if (source.thermalState !== undefined && !adaptivePerformanceThermalStates.includes(source.thermalState as AdaptivePerformanceThermalState)) {
		throw new Error("Adaptive Performance thermalState is invalid.");
	}
	if (source.lowPowerMode !== undefined && source.lowPowerMode !== null && typeof source.lowPowerMode !== "boolean") {
		throw new Error("Adaptive Performance lowPowerMode must be boolean or null.");
	}
	const result: IAdaptivePerformanceProviderSample = {
		thermalState: source.thermalState as AdaptivePerformanceThermalState | undefined,
		lowPowerMode: source.lowPowerMode as boolean | null | undefined,
	};
	for (const key of ["temperatureLevel", "cpuFrameTimeMs", "gpuFrameTimeMs", "frameTimeMs"] as const) {
		if (source[key] === undefined || source[key] === null) {
			result[key] = source[key] as null | undefined;
			continue;
		}
		const maximum = key === "temperatureLevel" ? 1 : 1000;
		result[key] = finite(source[key], `Adaptive Performance ${key}`, 0, maximum);
	}
	return result;
}

function applyProviderSample(
	scene: Scene,
	controller: IAdaptivePerformanceController,
	sampleValue: unknown,
	source: IAdaptivePerformanceProviderEventEvidence["source"]
): IAdaptivePerformanceRuntimeEvidence {
	const sample = validateProviderSample(sampleValue);
	if (sample.thermalState !== undefined) {
		controller.runtime.thermalState = sample.thermalState;
		controller.runtime.thermalWarning = sample.thermalState === "serious" || sample.thermalState === "critical";
	}
	if (sample.temperatureLevel !== undefined) {
		controller.runtime.temperatureLevel = sample.temperatureLevel;
	}
	if (sample.lowPowerMode !== undefined) {
		controller.runtime.lowPowerMode = sample.lowPowerMode;
	}
	if (sample.cpuFrameTimeMs !== undefined && sample.cpuFrameTimeMs !== null) {
		controller.cpuSamples.push(sample.cpuFrameTimeMs);
	}
	if (sample.gpuFrameTimeMs !== undefined && sample.gpuFrameTimeMs !== null) {
		controller.gpuSamples.push(sample.gpuFrameTimeMs);
	}
	if (sample.frameTimeMs !== undefined && sample.frameTimeMs !== null) {
		sampleAdaptivePerformanceFrame(scene, sample.frameTimeMs, sample.cpuFrameTimeMs ?? null, sample.gpuFrameTimeMs ?? null);
	}
	recordProviderEvent(controller, sample, source);
	return controller.runtime;
}

async function connectAppleProvider(scene: Scene, controller: IAdaptivePerformanceController, bridge: IAppleAdaptivePerformanceBridge): Promise<void> {
	try {
		if (bridge.getState) {
			applyProviderSample(scene, controller, await bridge.getState(), "apple-native");
		}
		if (bridge.addListener) {
			const subscription = await bridge.addListener("thermalStateChanged", (sample) => {
				if (controllers.get(scene) === controller) {
					applyProviderSample(scene, controller, sample, "apple-native");
				}
			});
			if (controllers.get(scene) === controller) {
				controller.providerCleanup = () => void subscription.remove();
			} else {
				await subscription.remove();
			}
		}
	} catch (error) {
		controller.runtime.errors.push(`Apple provider bridge failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function emptyRuntime(): IAdaptivePerformanceRuntimeEvidence {
	return {
		backend: adaptivePerformanceRuntimeBackend,
		configured: false,
		configurationRevision: null,
		running: false,
		requestedProvider: "auto",
		activeProvider: null,
		providerAvailable: false,
		providerSource: "none",
		platform: "unknown",
		measurement: "engine-frame-cadence-with-optional-provider-timings",
		targetFrameRate: 60,
		targetFrameTimeMs: rounded(1000 / 60),
		totalFrames: 0,
		acceptedSamples: 0,
		ignoredSamples: 0,
		windowSamples: 0,
		averageFrameTimeMs: null,
		averageCpuFrameTimeMs: null,
		averageGpuFrameTimeMs: null,
		bottleneck: "unknown",
		thermalState: "unknown",
		temperatureLevel: null,
		lowPowerMode: null,
		thermalWarning: false,
		qualityIndex: 1,
		lastDecision: "stopped",
		lastReason: "No Adaptive Performance runtime is configured.",
		scalers: [],
		actions: [],
		providerEvents: [],
		warnings: [],
		errors: [],
	};
}

/** Feeds one measured frame into the Basic provider/indexer. Optional CPU/GPU timings improve bottleneck classification without being fabricated. */
export function sampleAdaptivePerformanceFrame(
	scene: Scene,
	frameTimeMs: number,
	cpuFrameTimeMs: number | null = null,
	gpuFrameTimeMs: number | null = null
): IAdaptivePerformanceRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller || !controller.runtime.running) {
		return controller?.runtime ?? emptyRuntime();
	}
	const runtime = controller.runtime;
	runtime.totalFrames++;
	if (!Number.isFinite(frameTimeMs) || frameTimeMs < 1 || frameTimeMs > 1000) {
		runtime.ignoredSamples++;
		runtime.lastDecision = "hold";
		runtime.lastReason = "Ignored an invalid or out-of-range frame-cadence sample.";
		return runtime;
	}
	runtime.acceptedSamples++;
	controller.elapsedMs += frameTimeMs;
	controller.frameSamples.push(frameTimeMs);
	if (cpuFrameTimeMs !== null && Number.isFinite(cpuFrameTimeMs) && cpuFrameTimeMs >= 0 && cpuFrameTimeMs <= 1000) {
		controller.cpuSamples.push(cpuFrameTimeMs);
	}
	if (gpuFrameTimeMs !== null && Number.isFinite(gpuFrameTimeMs) && gpuFrameTimeMs >= 0 && gpuFrameTimeMs <= 1000) {
		controller.gpuSamples.push(gpuFrameTimeMs);
	}
	for (const samples of [controller.frameSamples, controller.cpuSamples, controller.gpuSamples]) {
		while (samples.length > controller.configuration.sampleFrames) {
			samples.shift();
		}
	}
	runtime.windowSamples = controller.frameSamples.length;
	runtime.averageFrameTimeMs = average(controller.frameSamples);
	runtime.averageCpuFrameTimeMs = average(controller.cpuSamples);
	runtime.averageGpuFrameTimeMs = average(controller.gpuSamples);
	runtime.bottleneck = classifyBottleneck(runtime);
	if (controller.frameSamples.length < controller.configuration.sampleFrames) {
		runtime.lastDecision = "collecting";
		runtime.lastReason = `Collecting ${controller.configuration.sampleFrames} Basic-provider frame samples.`;
		return runtime;
	}
	const thermal = thermalPressure(runtime.thermalState);
	const thermalDelay = controller.configuration.thermalActionDelaySeconds * 1000;
	if (thermal > 0 && controller.elapsedMs - controller.lastThermalActionMs >= thermalDelay) {
		if (changeOneScaler(scene, controller, "decrease-quality", "thermal")) {
			controller.lastThermalActionMs = controller.elapsedMs;
			controller.frameSamples.length = 0;
			runtime.windowSamples = 0;
			return runtime;
		}
	}
	const performanceDelay = controller.configuration.performanceActionDelaySeconds * 1000;
	if (controller.elapsedMs - controller.lastPerformanceActionMs < performanceDelay) {
		runtime.lastDecision = "hold";
		runtime.lastReason = "Waiting for the configured performance action delay.";
		return runtime;
	}
	const frame = runtime.averageFrameTimeMs!;
	if (frame > runtime.targetFrameTimeMs * controller.configuration.downscaleFrameTimeRatio) {
		if (changeOneScaler(scene, controller, "decrease-quality", "performance")) {
			controller.lastPerformanceActionMs = controller.elapsedMs;
		}
	} else if (thermal === 0 && frame < runtime.targetFrameTimeMs * controller.configuration.upscaleFrameTimeRatio) {
		if (changeOneScaler(scene, controller, "increase-quality", "recovery")) {
			controller.lastPerformanceActionMs = controller.elapsedMs;
		}
	} else {
		runtime.lastDecision = "hold";
		runtime.lastReason =
			thermal > 0 ? "Thermal pressure is active but every enabled scaler is at its minimum quality." : "Frame time is inside the configured hysteresis band.";
	}
	controller.frameSamples.length = 0;
	runtime.windowSamples = 0;
	return runtime;
}

/** Injects a strict provider sample from a project bridge or attached script. */
export function submitAdaptivePerformanceSample(scene: Scene, sample: unknown): IAdaptivePerformanceRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("No active Adaptive Performance runtime is configured.");
	}
	return applyProviderSample(scene, controller, sample, "script");
}

/** Applies a clearly labeled editor-only Apple thermal simulation without claiming hardware evidence. */
export function simulateAdaptivePerformanceThermalState(
	scene: Scene,
	state: AdaptivePerformanceThermalState,
	temperatureLevel: number | null = null,
	lowPowerMode: boolean | null = null
): IAdaptivePerformanceRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("No active Adaptive Performance runtime is configured.");
	}
	return applyProviderSample(scene, controller, { thermalState: state, temperatureLevel, lowPowerMode }, "editor-simulation");
}

/** Restores every scaler-owned baseline and releases provider/render observers. */
export function stopAdaptivePerformance(scene: Scene): IAdaptivePerformanceRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		return (scene.adaptivePerformanceRuntime = emptyRuntime());
	}
	controller.renderObserver?.remove();
	controller.disposeObserver?.remove();
	controller.providerCleanup?.();
	restoreBaseline(scene, controller);
	controller.runtime.running = false;
	controller.runtime.lastDecision = "stopped";
	controller.runtime.lastReason = "Adaptive Performance stopped and restored every scaler-owned baseline.";
	controllers.delete(scene);
	return (scene.adaptivePerformanceRuntime = emptyRuntime());
}

/** Configures the same Basic/Apple provider, indexer, and scaler runtime for editor preview and exported players. */
export function configureAdaptivePerformance(scene: Scene, value: unknown = scene.metadata?.[adaptivePerformanceMetadataKey]): IAdaptivePerformanceRuntimeEvidence {
	stopAdaptivePerformance(scene);
	const configuration = validateAdaptivePerformanceConfiguration(value);
	const appleBridge = resolveAppleBridge();
	const appleRequested = configuration.provider === "apple" || (configuration.provider === "auto" && platformSupportsApple(configuration.platform));
	const appleAvailable = appleRequested && platformSupportsApple(configuration.platform) && appleBridge !== null;
	const activeProvider: "basic" | "apple" = appleAvailable ? "apple" : "basic";
	const warnings: string[] = [];
	if (appleRequested && !appleAvailable) {
		warnings.push("Apple native thermal bridge is unavailable; the Basic frame-cadence provider is active and thermal state remains unknown until injected or simulated.");
	}
	if (configuration.provider === "apple" && !platformSupportsApple(configuration.platform)) {
		warnings.push(`Apple provider was requested for ${configuration.platform}; native thermal integration is supported only for iOS, tvOS, and visionOS.`);
	}
	const runtime: IAdaptivePerformanceRuntimeEvidence = {
		...emptyRuntime(),
		configured: true,
		configurationRevision: configuration.revision,
		running: configuration.enabled,
		requestedProvider: configuration.provider,
		activeProvider,
		providerAvailable: configuration.provider !== "apple" || appleAvailable,
		providerSource: appleAvailable ? "apple-native-bridge" : appleRequested ? "basic-fallback" : "frame-cadence",
		platform: configuration.platform,
		targetFrameRate: configuration.targetFrameRate,
		targetFrameTimeMs: rounded(1000 / configuration.targetFrameRate),
		lastDecision: "initial",
		lastReason: configuration.enabled
			? `${activeProvider === "apple" ? "Apple" : "Basic"} provider is collecting its first sample window.`
			: "Adaptive Performance is authored but disabled.",
		scalers: configuration.scalers.map((scaler) => ({
			id: scaler.id,
			enabled: scaler.enabled,
			level: 0,
			maximumLevel: scaler.maximumLevel,
			scale: scaler.maximumScale,
			visualImpact: scaler.visualImpact,
			target: scaler.target,
			lastApplied: "Baseline quality is active.",
		})),
		warnings,
	};
	const controller: IAdaptivePerformanceController = {
		configuration,
		runtime,
		baseline: captureBaseline(scene),
		frameSamples: [],
		cpuSamples: [],
		gpuSamples: [],
		elapsedMs: 0,
		lastThermalActionMs: -configuration.thermalActionDelaySeconds * 1000,
		lastPerformanceActionMs: -configuration.performanceActionDelaySeconds * 1000,
		renderObserver: null,
		disposeObserver: null,
		providerCleanup: null,
	};
	controllers.set(scene, controller);
	if (configuration.enabled) {
		controller.renderObserver = scene.onAfterRenderObservable.add(() => sampleAdaptivePerformanceFrame(scene, scene.getEngine().getDeltaTime()));
	}
	controller.disposeObserver = scene.onDisposeObservable.add(() => stopAdaptivePerformance(scene));
	if (configuration.enabled && appleAvailable && appleBridge) {
		void connectAppleProvider(scene, controller, appleBridge);
	}
	return (scene.adaptivePerformanceRuntime = runtime);
}

/** Resets transient warnings, timings, thermal state, and scaler levels under the current authored configuration. */
export function resetAdaptivePerformanceRuntime(scene: Scene): IAdaptivePerformanceRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("No active Adaptive Performance runtime is configured.");
	}
	restoreBaseline(scene, controller);
	controller.frameSamples.length = 0;
	controller.cpuSamples.length = 0;
	controller.gpuSamples.length = 0;
	controller.elapsedMs = 0;
	controller.lastThermalActionMs = -controller.configuration.thermalActionDelaySeconds * 1000;
	controller.lastPerformanceActionMs = -controller.configuration.performanceActionDelaySeconds * 1000;
	const runtime = controller.runtime;
	runtime.totalFrames = 0;
	runtime.acceptedSamples = 0;
	runtime.ignoredSamples = 0;
	runtime.windowSamples = 0;
	runtime.averageFrameTimeMs = null;
	runtime.averageCpuFrameTimeMs = null;
	runtime.averageGpuFrameTimeMs = null;
	runtime.bottleneck = "unknown";
	runtime.thermalState = "unknown";
	runtime.temperatureLevel = null;
	runtime.lowPowerMode = null;
	runtime.thermalWarning = false;
	runtime.qualityIndex = 1;
	runtime.actions = [];
	runtime.providerEvents = [];
	runtime.errors = [];
	runtime.scalers = controller.configuration.scalers.map((scaler) => ({
		id: scaler.id,
		enabled: scaler.enabled,
		level: 0,
		maximumLevel: scaler.maximumLevel,
		scale: scaler.maximumScale,
		visualImpact: scaler.visualImpact,
		target: scaler.target,
		lastApplied: "Baseline quality is active.",
	}));
	runtime.lastDecision = "reset";
	runtime.lastReason = "Adaptive Performance evidence and scaler levels were reset under the current configuration lease.";
	return runtime;
}

export function getAdaptivePerformanceRuntime(scene: Scene): IAdaptivePerformanceRuntimeEvidence {
	return scene.adaptivePerformanceRuntime ?? emptyRuntime();
}

export function getAdaptivePerformanceCapabilities(): object {
	return {
		version: adaptivePerformanceVersion,
		providers: [
			{ id: "basic", platforms: ["web", "electron", "android", "ios", "tvos", "visionos"], signals: ["frame-cadence", "optional-cpu-timing", "optional-gpu-timing"] },
			{
				id: "apple",
				platforms: ["ios", "tvos", "visionos"],
				signals: ["thermal-state", "temperature-level", "low-power-mode"],
				bridge: "Capacitor.Plugins.ZvibeAdaptivePerformance or globalThis.ZvibeAdaptivePerformance",
			},
		],
		scalers: adaptivePerformanceScalerIds.map((id) => ({ id, ...structuredClone(scalerDefaults[id]) })),
		thermalStates: adaptivePerformanceThermalStates,
		bottlenecks: adaptivePerformanceBottlenecks,
		boundaries: [
			"Basic provider frame cadence does not fabricate CPU or GPU timings.",
			"Apple hardware evidence requires the generated native bridge to be compiled into an iOS, tvOS, or visionOS host.",
			"The separate automatic iOS Serious/Critical 30/15 FPS policy belongs to parity row #732.",
		],
	};
}

declare module "@babylonjs/core/scene" {
	// Babylon module augmentation must retain the engine's public Scene name.
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		adaptivePerformanceRuntime?: IAdaptivePerformanceRuntimeEvidence;
	}
}

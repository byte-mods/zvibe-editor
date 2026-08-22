import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";

export const dynamicResolutionRuntimeBackend = "bounded-adaptive-dynamic-resolution-v1";
export const dynamicResolutionModes = ["disabled", "fixed", "adaptive"] as const;
export const dynamicResolutionUpscalers = ["browser-linear", "browser-pixelated"] as const;

export type DynamicResolutionMode = (typeof dynamicResolutionModes)[number];
export type DynamicResolutionUpscaler = (typeof dynamicResolutionUpscalers)[number];

export interface IDynamicResolutionConfiguration {
	version: 1;
	mode: DynamicResolutionMode;
	minimumScale: number;
	maximumScale: number;
	initialScale: number;
	fixedScale: number;
	targetFrameRate: number;
	sampleFrames: number;
	cooldownFrames: number;
	downscaleFrameTimeRatio: number;
	upscaleFrameTimeRatio: number;
	downscaleStep: number;
	upscaleStep: number;
	upscaler: DynamicResolutionUpscaler;
}

export interface IDynamicResolutionScaleChange {
	frame: number;
	averageFrameTimeMs: number;
	fromScale: number;
	toScale: number;
	decision: "downscale" | "upscale";
}

export interface IDynamicResolutionRuntimeEvidence {
	backend: typeof dynamicResolutionRuntimeBackend;
	configured: boolean;
	profileId: string | null;
	profileRevision: number | null;
	mode: DynamicResolutionMode;
	running: boolean;
	upscaler: DynamicResolutionUpscaler;
	measurement: "engine-frame-cadence-ms";
	requestedScale: number;
	effectiveScale: number;
	hardwareScalingLevel: number;
	targetFrameRate: number;
	targetFrameTimeMs: number;
	averageFrameTimeMs: number | null;
	minimumScale: number;
	maximumScale: number;
	totalFrames: number;
	acceptedSamples: number;
	ignoredSamples: number;
	windowSamples: number;
	cooldownRemaining: number;
	lastDecision: "initial" | "hold" | "downscale" | "upscale" | "reset" | "stopped";
	lastReason: string;
	scaleChanges: IDynamicResolutionScaleChange[];
	warnings: string[];
}

interface IDynamicResolutionController {
	configuration: IDynamicResolutionConfiguration;
	runtime: IDynamicResolutionRuntimeEvidence;
	samples: number[];
	renderObserver: Observer<Scene> | null;
	disposeObserver: Observer<Scene> | null;
	baselineImageRendering: string | null;
}

export interface IDynamicResolutionScaleConsumerResult {
	effectiveScale: number;
	warnings?: string[];
}

export interface IDynamicResolutionScaleConsumer {
	id: string;
	applyScale: (scale: number) => IDynamicResolutionScaleConsumerResult;
}

const maximumHistory = 64;
const controllers = new WeakMap<Scene, IDynamicResolutionController>();
const scaleConsumers = new WeakMap<Scene, IDynamicResolutionScaleConsumer>();

/** Registers one scene-owned reconstruction target as the dynamic-resolution scale destination. */
export function registerDynamicResolutionScaleConsumer(scene: Scene, consumer: IDynamicResolutionScaleConsumer | null): void {
	if (consumer) {
		scaleConsumers.set(scene, consumer);
	} else {
		scaleConsumers.delete(scene);
	}
}

export function getDynamicResolutionScaleConsumerId(scene: Scene): string | null {
	return scaleConsumers.get(scene)?.id ?? null;
}

function object(value: unknown, label: string): Record<string, unknown> {
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

function effectiveScale(scene: Scene): number {
	const level = scene.getEngine().getHardwareScalingLevel();
	return level > 0 && Number.isFinite(level) ? rounded(1 / level) : 1;
}

function renderingCanvas(scene: Scene): (HTMLCanvasElement & { style: CSSStyleDeclaration }) | null {
	const canvas = scene.getEngine().getRenderingCanvas();
	return canvas?.style ? canvas : null;
}

export function dynamicResolutionPreset(baseRenderScale = 1): IDynamicResolutionConfiguration {
	const scale = Math.min(2, Math.max(0.25, baseRenderScale));
	return {
		version: 1,
		mode: "disabled",
		minimumScale: Math.min(0.5, scale),
		maximumScale: Math.max(1, scale),
		initialScale: scale,
		fixedScale: scale,
		targetFrameRate: 60,
		sampleFrames: 30,
		cooldownFrames: 30,
		downscaleFrameTimeRatio: 1.1,
		upscaleFrameTimeRatio: 0.8,
		downscaleStep: 0.1,
		upscaleStep: 0.05,
		upscaler: "browser-linear",
	};
}

export function validateDynamicResolutionConfiguration(value: unknown, baseRenderScale = 1): IDynamicResolutionConfiguration {
	if (value === undefined || value === null) {
		return dynamicResolutionPreset(baseRenderScale);
	}
	const source = object(value, "Dynamic resolution configuration");
	const allowed = [
		"version",
		"mode",
		"minimumScale",
		"maximumScale",
		"initialScale",
		"fixedScale",
		"targetFrameRate",
		"sampleFrames",
		"cooldownFrames",
		"downscaleFrameTimeRatio",
		"upscaleFrameTimeRatio",
		"downscaleStep",
		"upscaleStep",
		"upscaler",
	];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown dynamic resolution field: ${unknown.join(", ")}.`);
	}
	if (source.version !== undefined && source.version !== 1) {
		throw new Error("Dynamic resolution configuration version must be 1.");
	}
	const fallback = dynamicResolutionPreset(baseRenderScale);
	const mode = (source.mode ?? fallback.mode) as DynamicResolutionMode;
	const upscaler = (source.upscaler ?? fallback.upscaler) as DynamicResolutionUpscaler;
	if (!dynamicResolutionModes.includes(mode)) {
		throw new Error("Dynamic resolution mode is invalid.");
	}
	if (!dynamicResolutionUpscalers.includes(upscaler)) {
		throw new Error("Dynamic resolution upscaler is invalid.");
	}
	const result: IDynamicResolutionConfiguration = {
		version: 1,
		mode,
		minimumScale: finite(source.minimumScale ?? fallback.minimumScale, "Dynamic resolution minimumScale", 0.25, 2),
		maximumScale: finite(source.maximumScale ?? fallback.maximumScale, "Dynamic resolution maximumScale", 0.25, 2),
		initialScale: finite(source.initialScale ?? fallback.initialScale, "Dynamic resolution initialScale", 0.25, 2),
		fixedScale: finite(source.fixedScale ?? fallback.fixedScale, "Dynamic resolution fixedScale", 0.25, 2),
		targetFrameRate: finite(source.targetFrameRate ?? fallback.targetFrameRate, "Dynamic resolution targetFrameRate", 15, 240),
		sampleFrames: finite(source.sampleFrames ?? fallback.sampleFrames, "Dynamic resolution sampleFrames", 2, 240, true),
		cooldownFrames: finite(source.cooldownFrames ?? fallback.cooldownFrames, "Dynamic resolution cooldownFrames", 0, 600, true),
		downscaleFrameTimeRatio: finite(source.downscaleFrameTimeRatio ?? fallback.downscaleFrameTimeRatio, "Dynamic resolution downscaleFrameTimeRatio", 1.01, 3),
		upscaleFrameTimeRatio: finite(source.upscaleFrameTimeRatio ?? fallback.upscaleFrameTimeRatio, "Dynamic resolution upscaleFrameTimeRatio", 0.1, 0.99),
		downscaleStep: finite(source.downscaleStep ?? fallback.downscaleStep, "Dynamic resolution downscaleStep", 0.01, 0.5),
		upscaleStep: finite(source.upscaleStep ?? fallback.upscaleStep, "Dynamic resolution upscaleStep", 0.01, 0.5),
		upscaler,
	};
	if (result.minimumScale > result.maximumScale) {
		throw new Error("Dynamic resolution minimumScale cannot exceed maximumScale.");
	}
	for (const property of ["initialScale", "fixedScale"] as const) {
		if (result[property] < result.minimumScale || result[property] > result.maximumScale) {
			throw new Error(`Dynamic resolution ${property} must be between minimumScale and maximumScale.`);
		}
	}
	return result;
}

function emptyRuntime(scene: Scene): IDynamicResolutionRuntimeEvidence {
	return {
		backend: dynamicResolutionRuntimeBackend,
		configured: false,
		profileId: null,
		profileRevision: null,
		mode: "disabled",
		running: false,
		upscaler: "browser-linear",
		measurement: "engine-frame-cadence-ms",
		requestedScale: effectiveScale(scene),
		effectiveScale: effectiveScale(scene),
		hardwareScalingLevel: scene.getEngine().getHardwareScalingLevel(),
		targetFrameRate: 60,
		targetFrameTimeMs: 1000 / 60,
		averageFrameTimeMs: null,
		minimumScale: 1,
		maximumScale: 1,
		totalFrames: 0,
		acceptedSamples: 0,
		ignoredSamples: 0,
		windowSamples: 0,
		cooldownRemaining: 0,
		lastDecision: "stopped",
		lastReason: "No active rendering profile owns dynamic resolution.",
		scaleChanges: [],
		warnings: [],
	};
}

function setPresentationMode(scene: Scene, upscaler: DynamicResolutionUpscaler): string | null {
	const canvas = renderingCanvas(scene);
	if (!canvas) {
		return null;
	}
	const baseline = canvas.style.imageRendering;
	canvas.style.imageRendering = upscaler === "browser-pixelated" ? "pixelated" : "auto";
	return baseline;
}

function setScale(scene: Scene, controller: IDynamicResolutionController, scale: number): void {
	const bounded = rounded(Math.min(controller.configuration.maximumScale, Math.max(controller.configuration.minimumScale, scale)));
	controller.runtime.requestedScale = bounded;
	const consumer = scaleConsumers.get(scene);
	if (consumer) {
		const result = consumer.applyScale(bounded);
		controller.runtime.hardwareScalingLevel = scene.getEngine().getHardwareScalingLevel();
		controller.runtime.effectiveScale = rounded(result.effectiveScale);
		controller.runtime.warnings = [...(result.warnings ?? [])];
	} else {
		scene.getEngine().setHardwareScalingLevel(1 / bounded);
		controller.runtime.hardwareScalingLevel = scene.getEngine().getHardwareScalingLevel();
		controller.runtime.effectiveScale = effectiveScale(scene);
		const mismatch = Math.abs(controller.runtime.effectiveScale - bounded) > 0.001;
		controller.runtime.warnings = mismatch ? [`The ${scene.getEngine().getClassName()} backend did not expose the requested hardware scaling level.`] : [];
	}
}

function average(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Feeds one measured frame into the bounded adaptive controller. Exported for deterministic runtime tests and diagnostics. */
export function sampleDynamicResolutionFrame(scene: Scene, frameTimeMs: number): IDynamicResolutionRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller || !controller.runtime.running) {
		return controller?.runtime ?? emptyRuntime(scene);
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
	controller.samples.push(frameTimeMs);
	if (controller.samples.length > controller.configuration.sampleFrames) {
		controller.samples.shift();
	}
	runtime.windowSamples = controller.samples.length;
	runtime.averageFrameTimeMs = rounded(average(controller.samples));
	if (runtime.cooldownRemaining > 0) {
		runtime.cooldownRemaining--;
		runtime.lastDecision = "hold";
		runtime.lastReason = "Waiting for the configured scale-change cooldown.";
		return runtime;
	}
	if (controller.samples.length < controller.configuration.sampleFrames) {
		runtime.lastDecision = "hold";
		runtime.lastReason = `Collecting ${controller.configuration.sampleFrames} frame-cadence samples.`;
		return runtime;
	}
	const fromScale = runtime.requestedScale;
	const target = runtime.targetFrameTimeMs;
	let decision: "downscale" | "upscale" | null = null;
	let toScale = fromScale;
	if (runtime.averageFrameTimeMs > target * controller.configuration.downscaleFrameTimeRatio && fromScale > controller.configuration.minimumScale) {
		decision = "downscale";
		toScale = Math.max(controller.configuration.minimumScale, fromScale - controller.configuration.downscaleStep);
	} else if (runtime.averageFrameTimeMs < target * controller.configuration.upscaleFrameTimeRatio && fromScale < controller.configuration.maximumScale) {
		decision = "upscale";
		toScale = Math.min(controller.configuration.maximumScale, fromScale + controller.configuration.upscaleStep);
	}
	if (!decision || rounded(toScale) === rounded(fromScale)) {
		runtime.lastDecision = "hold";
		runtime.lastReason =
			runtime.averageFrameTimeMs > target * controller.configuration.downscaleFrameTimeRatio
				? "Frame time exceeds the downscale threshold, but the minimum scale is active."
				: runtime.averageFrameTimeMs < target * controller.configuration.upscaleFrameTimeRatio
					? "Frame time is below the upscale threshold, but the maximum scale is active."
					: "Average frame time is inside the configured hysteresis band.";
		return runtime;
	}
	setScale(scene, controller, toScale);
	runtime.lastDecision = decision;
	runtime.lastReason = `${decision === "downscale" ? "Reduced" : "Increased"} requested render scale after a complete sample window.`;
	runtime.cooldownRemaining = controller.configuration.cooldownFrames;
	runtime.scaleChanges.push({
		frame: runtime.totalFrames,
		averageFrameTimeMs: runtime.averageFrameTimeMs,
		fromScale: rounded(fromScale),
		toScale: runtime.requestedScale,
		decision,
	});
	if (runtime.scaleChanges.length > maximumHistory) {
		runtime.scaleChanges.shift();
	}
	controller.samples.length = 0;
	runtime.windowSamples = 0;
	return runtime;
}

/** Removes the live observer and restores only the presentation reconstruction mode. Render scale restoration belongs to the rendering-profile baseline. */
export function stopDynamicResolution(scene: Scene): IDynamicResolutionRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		return (scene.dynamicResolutionRuntime = emptyRuntime(scene));
	}
	controller.renderObserver?.remove();
	controller.disposeObserver?.remove();
	const canvas = renderingCanvas(scene);
	if (canvas && controller.baselineImageRendering !== null) {
		canvas.style.imageRendering = controller.baselineImageRendering;
	}
	controller.runtime.running = false;
	controller.runtime.lastDecision = "stopped";
	controller.runtime.lastReason = "Dynamic-resolution runtime stopped; rendering-profile baseline owns scale restoration.";
	controllers.delete(scene);
	return (scene.dynamicResolutionRuntime = emptyRuntime(scene));
}

/** Applies one validated profile-owned fixed or adaptive scale policy to editor and exported runtimes. */
export function configureDynamicResolution(scene: Scene, profileId: string, profileRevision: number, value: unknown, baseRenderScale: number): IDynamicResolutionRuntimeEvidence {
	stopDynamicResolution(scene);
	const configuration = validateDynamicResolutionConfiguration(value, baseRenderScale);
	const requestedScale = configuration.mode === "disabled" ? baseRenderScale : configuration.mode === "fixed" ? configuration.fixedScale : configuration.initialScale;
	const runtime: IDynamicResolutionRuntimeEvidence = {
		backend: dynamicResolutionRuntimeBackend,
		configured: true,
		profileId,
		profileRevision,
		mode: configuration.mode,
		running: configuration.mode === "adaptive",
		upscaler: configuration.upscaler,
		measurement: "engine-frame-cadence-ms",
		requestedScale,
		effectiveScale: effectiveScale(scene),
		hardwareScalingLevel: scene.getEngine().getHardwareScalingLevel(),
		targetFrameRate: configuration.targetFrameRate,
		targetFrameTimeMs: rounded(1000 / configuration.targetFrameRate),
		averageFrameTimeMs: null,
		minimumScale: configuration.minimumScale,
		maximumScale: configuration.maximumScale,
		totalFrames: 0,
		acceptedSamples: 0,
		ignoredSamples: 0,
		windowSamples: 0,
		cooldownRemaining: 0,
		lastDecision: "initial",
		lastReason:
			configuration.mode === "adaptive"
				? "Adaptive controller is collecting its first frame-cadence window."
				: configuration.mode === "fixed"
					? "Fixed dynamic-resolution scale applied."
					: "Dynamic resolution is disabled; the profile's static render scale is active.",
		scaleChanges: [],
		warnings: [],
	};
	const controller: IDynamicResolutionController = {
		configuration,
		runtime,
		samples: [],
		renderObserver: null,
		disposeObserver: null,
		baselineImageRendering: setPresentationMode(scene, configuration.upscaler),
	};
	controllers.set(scene, controller);
	setScale(scene, controller, requestedScale);
	if (configuration.mode === "adaptive") {
		controller.renderObserver = scene.onAfterRenderObservable.add(() => sampleDynamicResolutionFrame(scene, scene.getEngine().getDeltaTime()));
	}
	controller.disposeObserver = scene.onDisposeObservable.add(() => stopDynamicResolution(scene));
	return (scene.dynamicResolutionRuntime = runtime);
}

/** Clears measurements and returns an active fixed/adaptive policy to its configured initial scale without changing persisted settings. */
export function resetDynamicResolutionRuntime(scene: Scene): IDynamicResolutionRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("No active dynamic-resolution runtime is configured.");
	}
	controller.samples.length = 0;
	const runtime = controller.runtime;
	runtime.totalFrames = 0;
	runtime.acceptedSamples = 0;
	runtime.ignoredSamples = 0;
	runtime.windowSamples = 0;
	runtime.cooldownRemaining = 0;
	runtime.averageFrameTimeMs = null;
	runtime.scaleChanges = [];
	runtime.lastDecision = "reset";
	runtime.lastReason = "Runtime measurements were reset under the current profile lease.";
	const scale =
		controller.configuration.mode === "fixed"
			? controller.configuration.fixedScale
			: controller.configuration.mode === "adaptive"
				? controller.configuration.initialScale
				: runtime.requestedScale;
	setScale(scene, controller, scale);
	return runtime;
}

export function getDynamicResolutionRuntime(scene: Scene): IDynamicResolutionRuntimeEvidence {
	return scene.dynamicResolutionRuntime ?? emptyRuntime(scene);
}

declare module "@babylonjs/core/scene" {
	// Babylon module augmentation must retain the engine's public Scene name.
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		dynamicResolutionRuntime?: IDynamicResolutionRuntimeEvidence;
	}
}

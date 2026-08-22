import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";

import { AdaptivePerformanceThermalState, adaptivePerformanceThermalStates, getAdaptivePerformanceRuntime } from "./adaptive-performance";

export const mobileSystemMetadataKey = "babylonEditorMobileSystem";
export const mobileSystemVersion = 1 as const;
export const mobileSystemRuntimeBackend = "zvibe-mobile-system-v1";

export const mobileSystemPlatforms = ["auto", "web", "electron", "android", "ios", "tvos", "visionos", "unknown"] as const;
export const androidWindowInsetTypes = [
	"statusBars",
	"navigationBars",
	"ime",
	"displayCutout",
	"systemGestures",
	"mandatorySystemGestures",
	"tappableElement",
	"captionBar",
] as const;
export const androidSystemBarsBehaviors = ["default", "show-transient-bars-by-swipe"] as const;

export type MobileSystemPlatform = (typeof mobileSystemPlatforms)[number];
export type AndroidWindowInsetType = (typeof androidWindowInsetTypes)[number];
export type AndroidSystemBarsBehavior = (typeof androidSystemBarsBehaviors)[number];

export interface IAndroidWindowInsetConfiguration {
	enabled: boolean;
	decorFitsSystemWindows: boolean;
	requestedVisibleWindowInsets: AndroidWindowInsetType[];
	systemBarsBehavior: AndroidSystemBarsBehavior;
}

export interface IIosThermalFrameRateConfiguration {
	enabled: boolean;
	seriousThermalStateFps: number;
	criticalThermalStateFps: number;
}

export interface IMobileSystemConfiguration {
	version: typeof mobileSystemVersion;
	revision: number;
	platform: MobileSystemPlatform;
	android: IAndroidWindowInsetConfiguration;
	iosThermalFrameRate: IIosThermalFrameRateConfiguration;
}

export interface IWindowInsets {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface IAndroidWindowInsetsSample {
	insets: IWindowInsets;
	visibleWindowInsets: AndroidWindowInsetType[];
	decorFitsSystemWindows?: boolean;
	systemBarsBehavior?: AndroidSystemBarsBehavior;
}

export interface IMobileSystemEventEvidence {
	sequence: number;
	type: "configured" | "window-insets" | "thermal-state" | "frame-rendered" | "frame-skipped" | "reset";
	source: "android-native" | "apple-native" | "browser-fallback" | "editor-simulation" | "adaptive-performance" | "runtime";
	detail: string;
}

export interface IMobileSystemRuntimeEvidence {
	backend: typeof mobileSystemRuntimeBackend;
	configured: boolean;
	configurationRevision: number | null;
	platform: Exclude<MobileSystemPlatform, "auto">;
	androidBridgeAvailable: boolean;
	androidPolicyApplied: boolean;
	windowInsets: IWindowInsets;
	visibleWindowInsets: AndroidWindowInsetType[];
	windowInsetsSource: "none" | "android-native" | "browser-fallback" | "editor-simulation";
	appleBridgeAvailable: boolean;
	thermalState: AdaptivePerformanceThermalState;
	thermalSource: "none" | "apple-native" | "editor-simulation" | "adaptive-performance";
	appliedTargetFrameRate: number | null;
	renderedFrames: number;
	skippedFrames: number;
	events: IMobileSystemEventEvidence[];
	warnings: string[];
	errors: string[];
}

interface INativeSubscription {
	remove(): void | Promise<void>;
}

interface IAndroidWindowInsetsBridge {
	getState?: () => IAndroidWindowInsetsSample | Promise<IAndroidWindowInsetsSample>;
	applyPolicy?: (policy: IAndroidWindowInsetConfiguration) => void | Promise<void>;
	addListener?: (eventName: "windowInsetsChanged", callback: (sample: IAndroidWindowInsetsSample) => void) => INativeSubscription | Promise<INativeSubscription>;
}

interface IAppleThermalBridge {
	getState?: () => { thermalState?: AdaptivePerformanceThermalState } | Promise<{ thermalState?: AdaptivePerformanceThermalState }>;
	addListener?: (
		eventName: "thermalStateChanged",
		callback: (sample: { thermalState?: AdaptivePerformanceThermalState }) => void
	) => INativeSubscription | Promise<INativeSubscription>;
}

interface IMobileSystemController {
	scene: Scene;
	configuration: IMobileSystemConfiguration;
	runtime: IMobileSystemRuntimeEvidence;
	gate: ThermalFrameRateGate;
	originalRender: Scene["render"] | null;
	wrappedRender: Scene["render"] | null;
	disposeObserver: Observer<Scene> | null;
	cleanups: Array<() => void>;
}

const controllers = new WeakMap<Scene, IMobileSystemController>();
const maximumEvidence = 64;

function addError(controller: IMobileSystemController, message: string): void {
	controller.runtime.errors.push(message);
	while (controller.runtime.errors.length > maximumEvidence) {
		controller.runtime.errors.shift();
	}
}

function addWarning(runtime: IMobileSystemRuntimeEvidence, message: string): void {
	runtime.warnings.push(message);
	while (runtime.warnings.length > maximumEvidence) {
		runtime.warnings.shift();
	}
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function assertKnownFields(source: Record<string, unknown>, fields: readonly string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be Boolean.`);
	}
	return value;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || Number(result) < minimum || Number(result) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(result);
}

function inferPlatform(): Exclude<MobileSystemPlatform, "auto"> {
	const root = globalThis as unknown as { process?: { versions?: { electron?: string } }; navigator?: { userAgent?: string; platform?: string } };
	if (root.process?.versions?.electron) {
		return "electron";
	}
	const identity = `${root.navigator?.userAgent ?? ""} ${root.navigator?.platform ?? ""}`.toLowerCase();
	if (identity.includes("android")) {
		return "android";
	}
	if (/iphone|ipad|ipod/.test(identity)) {
		return "ios";
	}
	return identity.trim() ? "web" : "unknown";
}

export function createDefaultMobileSystemConfiguration(): IMobileSystemConfiguration {
	return {
		version: mobileSystemVersion,
		revision: 1,
		platform: "auto",
		android: {
			enabled: true,
			decorFitsSystemWindows: true,
			requestedVisibleWindowInsets: ["statusBars", "navigationBars"],
			systemBarsBehavior: "default",
		},
		iosThermalFrameRate: {
			enabled: true,
			seriousThermalStateFps: 30,
			criticalThermalStateFps: 15,
		},
	};
}

/** Migrates and strictly validates the authored Android/iOS runtime policy. */
export function validateMobileSystemConfiguration(value: unknown): IMobileSystemConfiguration {
	if (value === undefined || value === null) {
		return createDefaultMobileSystemConfiguration();
	}
	const source = asRecord(value, "Mobile System configuration");
	assertKnownFields(source, ["version", "revision", "platform", "android", "iosThermalFrameRate"], "Mobile System configuration");
	if (source.version !== undefined && source.version !== mobileSystemVersion) {
		throw new Error("Mobile System configuration version must be 1.");
	}
	const defaults = createDefaultMobileSystemConfiguration();
	const platform = (source.platform ?? defaults.platform) as MobileSystemPlatform;
	if (!mobileSystemPlatforms.includes(platform)) {
		throw new Error("Mobile System platform is invalid.");
	}
	const android = source.android === undefined ? {} : asRecord(source.android, "Android window-inset policy");
	assertKnownFields(android, ["enabled", "decorFitsSystemWindows", "requestedVisibleWindowInsets", "systemBarsBehavior"], "Android window-inset policy");
	const requested = android.requestedVisibleWindowInsets ?? defaults.android.requestedVisibleWindowInsets;
	if (!Array.isArray(requested) || requested.length > androidWindowInsetTypes.length) {
		throw new Error(`requestedVisibleWindowInsets must contain at most ${androidWindowInsetTypes.length} inset types.`);
	}
	const requestedVisibleWindowInsets = requested.map(String) as AndroidWindowInsetType[];
	if (
		new Set(requestedVisibleWindowInsets).size !== requestedVisibleWindowInsets.length ||
		requestedVisibleWindowInsets.some((entry) => !androidWindowInsetTypes.includes(entry))
	) {
		throw new Error("requestedVisibleWindowInsets must contain unique supported inset types.");
	}
	const systemBarsBehavior = (android.systemBarsBehavior ?? defaults.android.systemBarsBehavior) as AndroidSystemBarsBehavior;
	if (!androidSystemBarsBehaviors.includes(systemBarsBehavior)) {
		throw new Error("Android systemBarsBehavior is invalid.");
	}
	const ios = source.iosThermalFrameRate === undefined ? {} : asRecord(source.iosThermalFrameRate, "iOS thermal frame-rate policy");
	assertKnownFields(ios, ["enabled", "seriousThermalStateFps", "criticalThermalStateFps"], "iOS thermal frame-rate policy");
	const seriousThermalStateFps = integer(ios.seriousThermalStateFps, defaults.iosThermalFrameRate.seriousThermalStateFps, 1, 240, "Serious thermal-state FPS");
	const criticalThermalStateFps = integer(ios.criticalThermalStateFps, defaults.iosThermalFrameRate.criticalThermalStateFps, 1, 240, "Critical thermal-state FPS");
	if (criticalThermalStateFps > seriousThermalStateFps) {
		throw new Error("Critical thermal-state FPS cannot exceed Serious thermal-state FPS.");
	}
	return {
		version: mobileSystemVersion,
		revision: integer(source.revision, defaults.revision, 1, Number.MAX_SAFE_INTEGER, "Mobile System revision"),
		platform,
		android: {
			enabled: boolean(android.enabled, defaults.android.enabled, "Android window-inset policy enabled"),
			decorFitsSystemWindows: boolean(android.decorFitsSystemWindows, defaults.android.decorFitsSystemWindows, "Android decorFitsSystemWindows"),
			requestedVisibleWindowInsets,
			systemBarsBehavior,
		},
		iosThermalFrameRate: {
			enabled: boolean(ios.enabled, defaults.iosThermalFrameRate.enabled, "iOS thermal frame-rate policy enabled"),
			seriousThermalStateFps,
			criticalThermalStateFps,
		},
	};
}

function zeroInsets(): IWindowInsets {
	return { left: 0, top: 0, right: 0, bottom: 0 };
}

function emptyRuntime(): IMobileSystemRuntimeEvidence {
	return {
		backend: mobileSystemRuntimeBackend,
		configured: false,
		configurationRevision: null,
		platform: "unknown",
		androidBridgeAvailable: false,
		androidPolicyApplied: false,
		windowInsets: zeroInsets(),
		visibleWindowInsets: [],
		windowInsetsSource: "none",
		appleBridgeAvailable: false,
		thermalState: "unknown",
		thermalSource: "none",
		appliedTargetFrameRate: null,
		renderedFrames: 0,
		skippedFrames: 0,
		events: [],
		warnings: [],
		errors: [],
	};
}

function addEvent(controller: IMobileSystemController, event: Omit<IMobileSystemEventEvidence, "sequence">): void {
	controller.runtime.events.push({ sequence: (controller.runtime.events.at(-1)?.sequence ?? 0) + 1, ...event });
	while (controller.runtime.events.length > maximumEvidence) {
		controller.runtime.events.shift();
	}
}

function validateInsets(value: unknown): IWindowInsets {
	const source = asRecord(value, "Window insets");
	assertKnownFields(source, ["left", "top", "right", "bottom"], "Window insets");
	const result = {} as IWindowInsets;
	for (const key of ["left", "top", "right", "bottom"] as const) {
		if (typeof source[key] !== "number" || !Number.isFinite(source[key]) || source[key] < 0 || source[key] > 16_384) {
			throw new Error(`Window inset ${key} must be a finite pixel value from 0 through 16384.`);
		}
		result[key] = Math.round(source[key] * 1000) / 1000;
	}
	return result;
}

function applyInsetsSample(controller: IMobileSystemController, value: unknown, source: IMobileSystemRuntimeEvidence["windowInsetsSource"]): void {
	const sample = asRecord(value, "Android window-insets sample");
	assertKnownFields(sample, ["insets", "visibleWindowInsets", "decorFitsSystemWindows", "systemBarsBehavior"], "Android window-insets sample");
	const visible = sample.visibleWindowInsets;
	if (!Array.isArray(visible) || visible.length > androidWindowInsetTypes.length) {
		throw new Error("Android visibleWindowInsets must be a bounded array.");
	}
	const types = visible.map(String) as AndroidWindowInsetType[];
	if (new Set(types).size !== types.length || types.some((entry) => !androidWindowInsetTypes.includes(entry))) {
		throw new Error("Android visibleWindowInsets contains an unsupported or duplicate type.");
	}
	controller.runtime.windowInsets = validateInsets(sample.insets);
	controller.runtime.visibleWindowInsets = types;
	controller.runtime.windowInsetsSource = source;
	addEvent(controller, {
		type: "window-insets",
		source: source === "android-native" ? "android-native" : source === "editor-simulation" ? "editor-simulation" : "browser-fallback",
		detail: JSON.stringify(controller.runtime.windowInsets),
	});
}

function applyThermalSample(controller: IMobileSystemController, value: unknown, source: Exclude<IMobileSystemRuntimeEvidence["thermalSource"], "none">): void {
	const sample = asRecord(value, "Apple thermal sample");
	assertKnownFields(sample, ["thermalState"], "Apple thermal sample");
	if (!adaptivePerformanceThermalStates.includes(sample.thermalState as AdaptivePerformanceThermalState)) {
		throw new Error("Apple thermalState is invalid.");
	}
	controller.runtime.thermalState = sample.thermalState as AdaptivePerformanceThermalState;
	controller.runtime.thermalSource = source;
	controller.gate.setThermalState(controller.runtime.thermalState);
	controller.runtime.appliedTargetFrameRate = controller.gate.targetFrameRate;
	addEvent(controller, { type: "thermal-state", source, detail: `${controller.runtime.thermalState}:${controller.runtime.appliedTargetFrameRate ?? "uncapped"}` });
}

function resolveAndroidBridge(): IAndroidWindowInsetsBridge | null {
	const root = globalThis as unknown as {
		ZvibeWindowInsets?: IAndroidWindowInsetsBridge;
		Capacitor?: { Plugins?: { ZvibeWindowInsets?: IAndroidWindowInsetsBridge } };
	};
	return root.ZvibeWindowInsets ?? root.Capacitor?.Plugins?.ZvibeWindowInsets ?? null;
}

function resolveAppleBridge(): IAppleThermalBridge | null {
	const root = globalThis as unknown as {
		ZvibeAdaptivePerformance?: IAppleThermalBridge;
		Capacitor?: { Plugins?: { ZvibeAdaptivePerformance?: IAppleThermalBridge } };
	};
	return root.ZvibeAdaptivePerformance ?? root.Capacitor?.Plugins?.ZvibeAdaptivePerformance ?? null;
}

function browserInsetsSample(): IAndroidWindowInsetsSample | null {
	if (typeof document === "undefined" || !document.body) {
		return null;
	}
	const probe = document.createElement("div");
	Object.assign(probe.style, {
		position: "fixed",
		visibility: "hidden",
		pointerEvents: "none",
		padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
	});
	document.body.appendChild(probe);
	const style = getComputedStyle(probe);
	const result = {
		insets: {
			left: Number.parseFloat(style.paddingLeft) || 0,
			top: Number.parseFloat(style.paddingTop) || 0,
			right: Number.parseFloat(style.paddingRight) || 0,
			bottom: Number.parseFloat(style.paddingBottom) || 0,
		},
		visibleWindowInsets: [] as AndroidWindowInsetType[],
	};
	probe.remove();
	return result;
}

function connectBrowserInsets(controller: IMobileSystemController): boolean {
	const update = (): void => {
		if (controllers.get(controller.scene) !== controller) {
			return;
		}
		const sample = browserInsetsSample();
		if (sample) {
			applyInsetsSample(controller, sample, "browser-fallback");
		}
	};
	update();
	if (typeof window !== "undefined") {
		window.addEventListener("resize", update);
		window.visualViewport?.addEventListener("resize", update);
		controller.cleanups.push(() => {
			window.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("resize", update);
		});
	}
	return controller.runtime.windowInsetsSource === "browser-fallback";
}

/** Deterministic frame gate used by exported render loops and the scene render wrapper. */
export class ThermalFrameRateGate {
	private readonly _configuration: IIosThermalFrameRateConfiguration;
	private _thermalState: AdaptivePerformanceThermalState = "unknown";
	private _lastAcceptedAt: number | null = null;

	public constructor(configuration: IIosThermalFrameRateConfiguration) {
		this._configuration = structuredClone(configuration);
	}

	public get targetFrameRate(): number | null {
		if (!this._configuration.enabled) {
			return null;
		}
		return this._thermalState === "critical"
			? this._configuration.criticalThermalStateFps
			: this._thermalState === "serious"
				? this._configuration.seriousThermalStateFps
				: null;
	}

	public setThermalState(state: AdaptivePerformanceThermalState): void {
		if (state !== this._thermalState) {
			this._thermalState = state;
			this._lastAcceptedAt = null;
		}
	}

	public shouldRender(nowMs: number): boolean {
		if (!Number.isFinite(nowMs)) {
			return false;
		}
		const target = this.targetFrameRate;
		if (target === null || this._lastAcceptedAt === null || nowMs < this._lastAcceptedAt || nowMs - this._lastAcceptedAt >= 1000 / target - 0.25) {
			this._lastAcceptedAt = nowMs;
			return true;
		}
		return false;
	}

	public reset(): void {
		this._thermalState = "unknown";
		this._lastAcceptedAt = null;
	}
}

async function connectAndroid(controller: IMobileSystemController, bridge: IAndroidWindowInsetsBridge): Promise<void> {
	try {
		await bridge.applyPolicy?.(structuredClone(controller.configuration.android));
		if (controllers.get(controller.scene) !== controller) {
			return;
		}
		controller.runtime.androidPolicyApplied = Boolean(bridge.applyPolicy);
		if (bridge.getState) {
			const sample = await bridge.getState();
			if (controllers.get(controller.scene) !== controller) {
				return;
			}
			applyInsetsSample(controller, sample, "android-native");
		}
		if (bridge.addListener) {
			const subscription = await bridge.addListener("windowInsetsChanged", (sample) => {
				if (controllers.get(controller.scene) === controller) {
					try {
						applyInsetsSample(controller, sample, "android-native");
					} catch (error) {
						addError(controller, `Android window-insets event was rejected: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			});
			if (controllers.get(controller.scene) === controller) {
				controller.cleanups.push(() => void subscription.remove());
			} else {
				await subscription.remove();
			}
		}
	} catch (error) {
		if (controllers.get(controller.scene) === controller) {
			addError(controller, `Android window-insets bridge failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function connectApple(controller: IMobileSystemController, bridge: IAppleThermalBridge): Promise<void> {
	try {
		if (bridge.getState) {
			const state = await bridge.getState();
			if (controllers.get(controller.scene) === controller && state.thermalState !== undefined) {
				applyThermalSample(controller, state, "apple-native");
			}
		}
		if (bridge.addListener) {
			const subscription = await bridge.addListener("thermalStateChanged", (sample) => {
				if (controllers.get(controller.scene) === controller && sample.thermalState !== undefined) {
					try {
						applyThermalSample(controller, sample, "apple-native");
					} catch (error) {
						addError(controller, `Apple thermal event was rejected: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			});
			if (controllers.get(controller.scene) === controller) {
				controller.cleanups.push(() => void subscription.remove());
			} else {
				await subscription.remove();
			}
		}
	} catch (error) {
		if (controllers.get(controller.scene) === controller) {
			addError(controller, `Apple thermal bridge failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function installFrameGate(scene: Scene, controller: IMobileSystemController): void {
	if (!["ios", "tvos", "visionos"].includes(controller.runtime.platform) || !controller.configuration.iosThermalFrameRate.enabled) {
		return;
	}
	const originalRender = scene.render;
	controller.originalRender = originalRender;
	const wrappedRender = function (this: Scene, updateCameras?: boolean, ignoreAnimations?: boolean): void {
		const active = controllers.get(scene);
		if (!active) {
			return originalRender.call(scene, updateCameras, ignoreAnimations);
		}
		if (active.runtime.thermalSource === "none" || active.runtime.thermalSource === "adaptive-performance") {
			const adaptive = getAdaptivePerformanceRuntime(scene);
			if (adaptive.thermalState !== "unknown" || active.runtime.thermalSource === "adaptive-performance") {
				applyThermalSample(active, { thermalState: adaptive.thermalState }, "adaptive-performance");
			}
		}
		active.runtime.appliedTargetFrameRate = active.gate.targetFrameRate;
		if (!active.gate.shouldRender(performance.now())) {
			active.runtime.skippedFrames++;
			if (active.runtime.skippedFrames <= 4 || active.runtime.skippedFrames % 120 === 0) {
				addEvent(active, { type: "frame-skipped", source: "runtime", detail: `target=${active.runtime.appliedTargetFrameRate}` });
			}
			return;
		}
		active.runtime.renderedFrames++;
		return originalRender.call(scene, updateCameras, ignoreAnimations);
	};
	controller.wrappedRender = wrappedRender;
	(scene as unknown as { render: Scene["render"] }).render = wrappedRender;
}

/** Disposes native listeners and restores the exact Scene.render function baseline. */
export function stopMobileSystemRuntime(scene: Scene): IMobileSystemRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		return (scene.mobileSystemRuntime = emptyRuntime());
	}
	for (const cleanup of controller.cleanups.splice(0)) {
		cleanup();
	}
	controller.disposeObserver?.remove();
	if (controller.originalRender && controller.wrappedRender && scene.render === controller.wrappedRender) {
		(scene as unknown as { render: Scene["render"] }).render = controller.originalRender;
	}
	controllers.delete(scene);
	return (scene.mobileSystemRuntime = emptyRuntime());
}

/** Applies Android inset policy/events and Apple thermal frame pacing for preview and exported scenes. */
export function configureMobileSystemRuntime(scene: Scene, value: unknown = scene.metadata?.[mobileSystemMetadataKey]): IMobileSystemRuntimeEvidence {
	stopMobileSystemRuntime(scene);
	const configuration = validateMobileSystemConfiguration(value);
	const platform = configuration.platform === "auto" ? inferPlatform() : configuration.platform;
	const androidBridge = resolveAndroidBridge();
	const appleBridge = resolveAppleBridge();
	const androidBridgeAvailable = Boolean(androidBridge?.applyPolicy && androidBridge?.getState && androidBridge?.addListener);
	const appleBridgeAvailable = Boolean(appleBridge?.getState && appleBridge?.addListener);
	const runtime: IMobileSystemRuntimeEvidence = {
		...emptyRuntime(),
		configured: true,
		configurationRevision: configuration.revision,
		platform,
		androidBridgeAvailable,
		appleBridgeAvailable,
	};
	const controller: IMobileSystemController = {
		scene,
		configuration,
		runtime,
		gate: new ThermalFrameRateGate(configuration.iosThermalFrameRate),
		originalRender: null,
		wrappedRender: null,
		disposeObserver: null,
		cleanups: [],
	};
	controllers.set(scene, controller);
	addEvent(controller, { type: "configured", source: "runtime", detail: `platform=${platform};revision=${configuration.revision}` });
	if (platform === "android" && configuration.android.enabled) {
		if (androidBridgeAvailable && androidBridge) {
			void connectAndroid(controller, androidBridge);
		} else {
			connectBrowserInsets(controller);
			addWarning(runtime, "Android native window-insets bridge is unavailable; CSS safe-area evidence cannot report per-inset-type visibility or control system bars.");
		}
	}
	if (["ios", "tvos", "visionos"].includes(platform) && configuration.iosThermalFrameRate.enabled) {
		if (appleBridgeAvailable && appleBridge) {
			void connectApple(controller, appleBridge);
		} else {
			addWarning(runtime, "Apple thermal bridge is unavailable; automatic 30/15 FPS limits activate only after real provider evidence or labeled editor simulation.");
		}
		installFrameGate(scene, controller);
	}
	controller.disposeObserver = scene.onDisposeObservable.add(() => stopMobileSystemRuntime(scene));
	return (scene.mobileSystemRuntime = runtime);
}

/** Injects bounded non-hardware evidence for editor verification. */
export function simulateMobileSystemState(
	scene: Scene,
	value: { windowInsets?: IWindowInsets; visibleWindowInsets?: AndroidWindowInsetType[]; thermalState?: AdaptivePerformanceThermalState }
): IMobileSystemRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("No active Mobile System runtime is configured.");
	}
	if (value.windowInsets !== undefined || value.visibleWindowInsets !== undefined) {
		applyInsetsSample(controller, { insets: value.windowInsets ?? zeroInsets(), visibleWindowInsets: value.visibleWindowInsets ?? [] }, "editor-simulation");
	}
	if (value.thermalState !== undefined) {
		applyThermalSample(controller, { thermalState: value.thermalState }, "editor-simulation");
	}
	return controller.runtime;
}

/** Clears transient evidence without changing the exact authored revision. */
export function resetMobileSystemRuntime(scene: Scene): IMobileSystemRuntimeEvidence {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("No active Mobile System runtime is configured.");
	}
	controller.gate.reset();
	controller.runtime.windowInsets = zeroInsets();
	controller.runtime.visibleWindowInsets = [];
	controller.runtime.windowInsetsSource = "none";
	controller.runtime.thermalState = "unknown";
	controller.runtime.thermalSource = "none";
	controller.runtime.appliedTargetFrameRate = null;
	controller.runtime.renderedFrames = 0;
	controller.runtime.skippedFrames = 0;
	controller.runtime.events = [];
	controller.runtime.errors = [];
	addEvent(controller, { type: "reset", source: "runtime", detail: "Transient Mobile System evidence cleared." });
	return controller.runtime;
}

export function getMobileSystemRuntime(scene: Scene): IMobileSystemRuntimeEvidence {
	return scene.mobileSystemRuntime ?? emptyRuntime();
}

export function getMobileSystemCapabilities(): object {
	return {
		version: mobileSystemVersion,
		android: {
			requestedVisibleWindowInsets: androidWindowInsetTypes,
			systemBarsBehaviors: androidSystemBarsBehaviors,
			bridge: "Capacitor.Plugins.ZvibeWindowInsets or globalThis.ZvibeWindowInsets",
		},
		iosThermalFrameRate: { defaultEnabled: true, seriousDefaultFps: 30, criticalDefaultFps: 15, sharedThermalEvidence: "ZvibeAdaptivePerformance" },
		boundaries: [
			"CSS safe-area fallback reports pixel insets but cannot control Android system bars or prove per-type visibility.",
			"Editor simulation is always labeled and is not hardware evidence.",
			"Frame pacing skips Scene.render work while retaining the host engine render loop and restores the exact render function on disposal.",
		],
	};
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		mobileSystemRuntime?: IMobileSystemRuntimeEvidence;
	}
}

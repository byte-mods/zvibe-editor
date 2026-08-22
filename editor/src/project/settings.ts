import {
	editorProjectSettingsVersion,
	EditorAssetSerializationMode,
	EditorDefaultBehaviorMode,
	EditorPlayerColorSpace,
	EditorPlayerFullscreenMode,
	EditorPlayerRenderingBackend,
	EditorProjectBuildTarget,
	IEditorAssetPipelineSettings,
	IEditorImportAcceleratorSettings,
	IEditorPlatformSettingsOverride,
	IEditorPlayerDisplaySettings,
	IEditorPlayerRenderingSettings,
	IEditorPlayerRuntimeSettings,
	IEditorProjectSettings,
} from "./typings";

const buildTargets: EditorProjectBuildTarget[] = ["web", "electron", "headless", "android", "ios"];

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return values.includes(value as T) ? (value as T) : fallback;
}

function normalizeDisplay(value: unknown, fallback: IEditorPlayerDisplaySettings): IEditorPlayerDisplaySettings {
	const source = record(value);
	return {
		defaultWidth: boundedInteger(source.defaultWidth, fallback.defaultWidth, 1, 16384),
		defaultHeight: boundedInteger(source.defaultHeight, fallback.defaultHeight, 1, 16384),
		fullscreenMode: choice<EditorPlayerFullscreenMode>(source.fullscreenMode, ["windowed", "fullscreen", "borderless"], fallback.fullscreenMode),
		resizableWindow: source.resizableWindow === undefined ? fallback.resizableWindow : source.resizableWindow === true,
		runInBackground: source.runInBackground === undefined ? fallback.runInBackground : source.runInBackground === true,
		allowHighDpi: source.allowHighDpi === undefined ? fallback.allowHighDpi : source.allowHighDpi === true,
	};
}

function normalizeRendering(value: unknown, fallback: IEditorPlayerRenderingSettings): IEditorPlayerRenderingSettings {
	const source = record(value);
	return {
		colorSpace: choice<EditorPlayerColorSpace>(source.colorSpace, ["gamma", "linear"], fallback.colorSpace),
		renderingBackend: choice<EditorPlayerRenderingBackend>(source.renderingBackend, ["auto", "webgl2", "webgpu"], fallback.renderingBackend),
		powerPreference: choice(source.powerPreference, ["default", "high-performance", "low-power"], fallback.powerPreference),
		targetFrameRate: boundedInteger(source.targetFrameRate, fallback.targetFrameRate, -1, 1000),
		maximumDevicePixelRatio: boundedNumber(source.maximumDevicePixelRatio, fallback.maximumDevicePixelRatio, 0.25, 8),
		preserveDrawingBuffer: source.preserveDrawingBuffer === undefined ? fallback.preserveDrawingBuffer : source.preserveDrawingBuffer === true,
	};
}

function normalizeRuntime(value: unknown, fallback: IEditorPlayerRuntimeSettings): IEditorPlayerRuntimeSettings {
	const source = record(value);
	return {
		showBabylonLoadingScreen: source.showBabylonLoadingScreen === undefined ? fallback.showBabylonLoadingScreen : source.showBabylonLoadingScreen === true,
		disableContextMenu: source.disableContextMenu === undefined ? fallback.disableContextMenu : source.disableContextMenu === true,
		dataCaching: source.dataCaching === undefined ? fallback.dataCaching : source.dataCaching === true,
		deterministicLockstep: source.deterministicLockstep === undefined ? fallback.deterministicLockstep : source.deterministicLockstep === true,
		lockstepMaxSteps: boundedInteger(source.lockstepMaxSteps, fallback.lockstepMaxSteps, 1, 64),
	};
}

/** Normalizes both the version-2 contract and legacy cache-server spellings so upgraded enabled projects keep their opt-in policy. */
function normalizeImportAccelerator(value: unknown, fallback: IEditorImportAcceleratorSettings): IEditorImportAcceleratorSettings {
	const source = record(value);
	return {
		enabled: source.enabled === true,
		endpoint: boundedText(source.endpoint, fallback.endpoint, 2048),
		namespacePrefix: boundedText(source.namespacePrefix ?? source.namespace, fallback.namespacePrefix, 128),
		downloadEnabled: source.downloadEnabled === undefined ? fallback.downloadEnabled : source.downloadEnabled === true,
		uploadEnabled: source.uploadEnabled === undefined ? fallback.uploadEnabled : source.uploadEnabled === true,
		authenticationEnvironmentVariable:
			typeof source.authenticationEnvironmentVariable === "string"
				? source.authenticationEnvironmentVariable.trim().slice(0, 128)
				: fallback.authenticationEnvironmentVariable,
		contentValidation: choice(source.contentValidation, ["disabled", "uploadOnly", "enabled", "required"], fallback.contentValidation),
		downloadBatchSize: boundedInteger(source.downloadBatchSize, fallback.downloadBatchSize, 1, 32),
		requestTimeoutMilliseconds: boundedInteger(source.requestTimeoutMilliseconds, fallback.requestTimeoutMilliseconds, 1_000, 300_000),
		maximumResultSizeBytes: boundedInteger(source.maximumResultSizeBytes, fallback.maximumResultSizeBytes, 1_048_576, 2_147_483_648),
	};
}

export function createDefaultProjectSettings(projectName = "Zvibe Game"): IEditorProjectSettings {
	return {
		version: editorProjectSettingsVersion,
		revision: 0,
		identity: { companyName: "Default Company", productName: projectName, version: "1.0.0", applicationId: "com.default.zvibegame" },
		display: { defaultWidth: 1920, defaultHeight: 1080, fullscreenMode: "windowed", resizableWindow: true, runInBackground: true, allowHighDpi: true },
		rendering: {
			colorSpace: "linear",
			renderingBackend: "auto",
			powerPreference: "high-performance",
			targetFrameRate: 60,
			maximumDevicePixelRatio: 2,
			preserveDrawingBuffer: false,
		},
		runtime: { showBabylonLoadingScreen: true, disableContextMenu: true, dataCaching: true, deterministicLockstep: false, lockstepMaxSteps: 4 },
		assetPipeline: {
			autoRefresh: true,
			autoRefreshOnFocus: true,
			directoryMonitoring: true,
			importWorkerCount: 4,
			serializationMode: "forceText",
			reduceVersionControlNoise: true,
			accelerator: {
				enabled: false,
				endpoint: "http://127.0.0.1:10080",
				namespacePrefix: "default",
				downloadEnabled: true,
				uploadEnabled: true,
				authenticationEnvironmentVariable: "",
				contentValidation: "enabled",
				downloadBatchSize: 8,
				requestTimeoutMilliseconds: 30_000,
				maximumResultSizeBytes: 536_870_912,
			},
		},
		playMode: { reloadScene: true, reloadScripts: true, muteAudio: false, maximizeOnPlay: false },
		defaultBehaviorMode: "3d",
		platformOverrides: {},
	};
}

function normalizeAssetPipeline(value: unknown, fallback: IEditorAssetPipelineSettings): IEditorAssetPipelineSettings {
	const source = record(value);
	const serializationMode = choice<EditorAssetSerializationMode>(source.serializationMode, ["forceText", "mixed", "forceBinary"], fallback.serializationMode);
	const legacyAccelerator = {
		enabled: source.cacheServerEnabled,
		endpoint: source.cacheServerEndpoint,
		namespacePrefix: source.cacheServerNamespace,
		downloadEnabled: source.cacheServerDownloadEnabled,
		uploadEnabled: source.cacheServerUploadEnabled,
	};
	return {
		autoRefresh: source.autoRefresh === undefined ? fallback.autoRefresh : source.autoRefresh === true,
		autoRefreshOnFocus: source.autoRefreshOnFocus === undefined ? fallback.autoRefreshOnFocus : source.autoRefreshOnFocus === true,
		directoryMonitoring: source.directoryMonitoring === undefined ? fallback.directoryMonitoring : source.directoryMonitoring === true,
		importWorkerCount: boundedInteger(source.importWorkerCount, fallback.importWorkerCount, 1, 32),
		serializationMode,
		reduceVersionControlNoise:
			serializationMode === "forceBinary"
				? false
				: source.reduceVersionControlNoise === undefined
					? fallback.reduceVersionControlNoise
					: source.reduceVersionControlNoise === true,
		accelerator: normalizeImportAccelerator(source.accelerator ?? source.importAccelerator ?? source.cacheServer ?? legacyAccelerator, fallback.accelerator),
	};
}

function normalizePlatformOverrides(value: unknown, defaults: IEditorProjectSettings): IEditorProjectSettings["platformOverrides"] {
	const source = record(value);
	const result: Partial<Record<EditorProjectBuildTarget, IEditorPlatformSettingsOverride>> = {};
	for (const target of buildTargets) {
		if (!source[target] || typeof source[target] !== "object" || Array.isArray(source[target])) {
			continue;
		}
		const override = record(source[target]);
		const normalized: IEditorPlatformSettingsOverride = {};
		if (override.display !== undefined) {
			normalized.display = normalizeDisplay({ ...defaults.display, ...record(override.display) }, defaults.display);
		}
		if (override.rendering !== undefined) {
			normalized.rendering = normalizeRendering({ ...defaults.rendering, ...record(override.rendering) }, defaults.rendering);
		}
		if (override.runtime !== undefined) {
			normalized.runtime = normalizeRuntime({ ...defaults.runtime, ...record(override.runtime) }, defaults.runtime);
		}
		result[target] = normalized;
	}
	return result;
}

/** Migrates legacy/untrusted settings into the complete current schema. */
export function normalizeProjectSettings(value: unknown, projectName?: string): IEditorProjectSettings {
	const source = record(value);
	const defaults = createDefaultProjectSettings(projectName);
	const identity = record(source.identity);
	const playMode = record(source.playMode);
	const settings: IEditorProjectSettings = {
		version: editorProjectSettingsVersion,
		revision: boundedInteger(source.revision, 0, 0, Number.MAX_SAFE_INTEGER),
		identity: {
			companyName: boundedText(identity.companyName, defaults.identity.companyName, 128),
			productName: boundedText(identity.productName, defaults.identity.productName, 128),
			version: boundedText(identity.version, defaults.identity.version, 64),
			applicationId: boundedText(identity.applicationId, defaults.identity.applicationId, 255),
		},
		display: normalizeDisplay(source.display, defaults.display),
		rendering: normalizeRendering(source.rendering, defaults.rendering),
		runtime: normalizeRuntime(source.runtime, defaults.runtime),
		assetPipeline: normalizeAssetPipeline(source.assetPipeline, defaults.assetPipeline),
		playMode: {
			reloadScene: playMode.reloadScene === undefined ? defaults.playMode.reloadScene : playMode.reloadScene === true,
			reloadScripts: playMode.reloadScripts === undefined ? defaults.playMode.reloadScripts : playMode.reloadScripts === true,
			muteAudio: playMode.muteAudio === undefined ? defaults.playMode.muteAudio : playMode.muteAudio === true,
			maximizeOnPlay: playMode.maximizeOnPlay === undefined ? defaults.playMode.maximizeOnPlay : playMode.maximizeOnPlay === true,
		},
		defaultBehaviorMode: choice<EditorDefaultBehaviorMode>(source.defaultBehaviorMode, ["2d", "3d"], defaults.defaultBehaviorMode),
		platformOverrides: {},
	};
	settings.platformOverrides = normalizePlatformOverrides(source.platformOverrides, settings);
	validateProjectSettings(settings);
	return settings;
}

/** Rejects invalid settings instead of silently weakening an MCP mutation. */
export function validateProjectSettings(settings: IEditorProjectSettings): void {
	if (settings.version !== editorProjectSettingsVersion || !Number.isSafeInteger(settings.revision) || settings.revision < 0) {
		throw new Error("Project Settings version or revision is invalid.");
	}
	if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/.test(settings.identity.applicationId)) {
		throw new Error("Player applicationId must be a reverse-domain identifier.");
	}
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(settings.identity.version)) {
		throw new Error("Player version must be semantic version text such as 1.0.0.");
	}
	if (settings.rendering.targetFrameRate !== -1 && settings.rendering.targetFrameRate < 1) {
		throw new Error("targetFrameRate must be -1 or between 1 and 1000.");
	}
	if (settings.assetPipeline.serializationMode === "forceBinary" && settings.assetPipeline.reduceVersionControlNoise) {
		throw new Error("reduceVersionControlNoise applies to text serialization and cannot be enabled with forceBinary.");
	}
	const accelerator = settings.assetPipeline.accelerator;
	let endpoint: URL;
	try {
		endpoint = new URL(accelerator.endpoint);
	} catch {
		throw new Error("Import Accelerator endpoint must be an absolute HTTP(S) URL.");
	}
	const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "::1" || endpoint.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
	if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
		throw new Error("Import Accelerator requires HTTPS, except for loopback HTTP, and does not allow URL credentials, query text, or fragments.");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accelerator.namespacePrefix)) {
		throw new Error("Import Accelerator namespacePrefix must contain only letters, numbers, dots, underscores, and hyphens.");
	}
	if (accelerator.authenticationEnvironmentVariable && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(accelerator.authenticationEnvironmentVariable)) {
		throw new Error("Import Accelerator authenticationEnvironmentVariable must be a valid environment-variable name.");
	}
}

/** Resolves common settings with one bounded target override for build/runtime use. */
export function resolveProjectSettingsForTarget(settings: IEditorProjectSettings, target: EditorProjectBuildTarget): IEditorProjectSettings {
	const override = settings.platformOverrides[target];
	return {
		...structuredClone(settings),
		display: { ...settings.display, ...override?.display },
		rendering: { ...settings.rendering, ...override?.rendering },
		runtime: { ...settings.runtime, ...override?.runtime },
	};
}

/** Atomically merges a nested settings patch under an exact optimistic revision. */
export function updateProjectSettings(current: IEditorProjectSettings, expectedRevision: number, patch: Partial<IEditorProjectSettings>): IEditorProjectSettings {
	if (expectedRevision !== current.revision) {
		throw new Error(`Stale Project Settings revision ${expectedRevision}; current revision is ${current.revision}.`);
	}
	const merged = {
		...current,
		...patch,
		identity: { ...current.identity, ...record(patch.identity) },
		display: { ...current.display, ...record(patch.display) },
		rendering: { ...current.rendering, ...record(patch.rendering) },
		runtime: { ...current.runtime, ...record(patch.runtime) },
		assetPipeline: {
			...current.assetPipeline,
			...record(patch.assetPipeline),
			accelerator: { ...current.assetPipeline.accelerator, ...record(record(patch.assetPipeline).accelerator) },
		},
		playMode: { ...current.playMode, ...record(patch.playMode) },
		platformOverrides: patch.platformOverrides === undefined ? current.platformOverrides : patch.platformOverrides,
		revision: current.revision + 1,
	};
	const result = normalizeProjectSettings(merged, current.identity.productName);
	validateProjectSettings(result);
	return result;
}

import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import type { Scene } from "@babylonjs/core/scene";

import { configureDeferredLighting, getDeferredLightingRuntime, IDeferredLightingRuntimeEvidence, stopDeferredLighting } from "../rendering/deferred-lighting";

export const rendererDataSelectionsMetadataKey = "babylonEditorRendererDataSelections";
export const rendererDataRuntimeBackend = "bounded-babylon-renderer-data-v1" as const;

export const rendererDataRenderingPaths = ["forward", "forward-plus", "deferred"] as const;
export type RendererDataRenderingPath = (typeof rendererDataRenderingPaths)[number];
export const rendererDataDepthTextureModes = ["disabled", "linear", "non-linear", "camera-space-z"] as const;
export type RendererDataDepthTextureMode = (typeof rendererDataDepthTextureModes)[number];
export const rendererDataDepthPrimingModes = ["disabled", "auto", "forced"] as const;
export type RendererDataDepthPrimingMode = (typeof rendererDataDepthPrimingModes)[number];

export interface IRendererDataSettings {
	version: 1;
	renderingPath: RendererDataRenderingPath;
	fallbackToForward: boolean;
	layerMask: number;
	postProcessesEnabled: boolean;
	depthTexture: {
		mode: RendererDataDepthTextureMode;
		force32BitsFloat: boolean;
		includeTransparent: boolean;
	};
	depthPrimingMode: RendererDataDepthPrimingMode;
	forwardPlus: {
		horizontalTiles: number;
		verticalTiles: number;
		depthSlices: number;
		maxRange: number;
	};
	rendererFeatureInstanceIds: string[] | null;
}

export interface IRendererDataAssetSnapshot {
	version: 1;
	path: string;
	id: string;
	name: string;
	assetRevision: number;
	contentRevision: string;
	settings: IRendererDataSettings;
}

export interface IRendererDataCameraSelection {
	cameraId: string;
	asset: IRendererDataAssetSnapshot;
}

export interface IRendererDataSelections {
	version: 1;
	revision: number;
	default: IRendererDataAssetSnapshot | null;
	cameras: IRendererDataCameraSelection[];
}

export interface IRendererDataCameraRuntime {
	cameraId: string;
	cameraName: string;
	source: "default" | "camera";
	asset: Omit<IRendererDataAssetSnapshot, "settings">;
	requestedRenderingPath: RendererDataRenderingPath;
	effectiveRenderingPath: "forward" | "forward-plus" | "deferred";
	layerMask: number;
	postProcessesEnabled: boolean;
	depthPrimingMode: RendererDataDepthPrimingMode;
	depthTexture: {
		requestedMode: RendererDataDepthTextureMode;
		active: boolean;
		owned: boolean;
		ready: boolean;
		width: number;
		height: number;
		includeTransparent: boolean;
	};
	forwardPlus: {
		active: boolean;
		supported: boolean;
		containerName: string | null;
		lightCount: number;
		horizontalTiles: number;
		verticalTiles: number;
		depthSlices: number;
		maxRange: number;
	};
	deferred: IDeferredLightingRuntimeEvidence | null;
	rendererFeatureInstanceIds: string[] | null;
	warnings: string[];
	errors: string[];
}

export interface IRendererDataRuntime {
	backend: typeof rendererDataRuntimeBackend;
	configured: boolean;
	revision: number | null;
	defaultAssetId: string | null;
	cameras: IRendererDataCameraRuntime[];
	warnings: string[];
	errors: string[];
}

interface IDepthBaseline {
	renderer: DepthRenderer;
	owned: boolean;
	enabled: boolean;
	forceDepthWriteTransparentMeshes: boolean;
	useOnlyInActiveCamera: boolean;
}

interface IClusteredBaseline {
	container: ClusteredLightContainer;
	enabled: boolean;
	horizontalTiles: number;
	verticalTiles: number;
	depthSlices: number;
	maxRange: number;
}

interface IRendererDataRuntimeState {
	selections: IRendererDataSelections;
	settingsByCameraId: Map<string, IRendererDataSettings>;
	cameraBaselines: Map<Camera, number>;
	depthBaselines: Map<Camera, IDepthBaseline>;
	clusteredBaselines: Map<ClusteredLightContainer, IClusteredBaseline>;
	postProcessesEnabled: boolean;
	beforeCameraObserver: Observer<Camera> | null;
	afterCameraObserver: Observer<Camera> | null;
	newCameraObserver: Observer<Camera> | null;
	cameraRemovedObserver: Observer<Camera> | null;
	newMeshObserver: Observer<unknown> | null;
	meshRemovedObserver: Observer<unknown> | null;
	newLightObserver: Observer<unknown> | null;
	lightRemovedObserver: Observer<unknown> | null;
	cameraRefreshTimeout: ReturnType<typeof setTimeout> | null;
	disposeObserver: Observer<Scene> | null;
	report: IRendererDataRuntime;
}

const runtimeStates = new WeakMap<Scene, IRendererDataRuntimeState>();
const runtimeReports = new WeakMap<Scene, IRendererDataRuntime>();

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
}

function string(value: unknown, label: string, maximum = 4096): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1–${maximum} characters.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

export function rendererDataSettingsPreset(renderingPath: RendererDataRenderingPath = "forward"): IRendererDataSettings {
	return {
		version: 1,
		renderingPath,
		fallbackToForward: true,
		layerMask: 0x0fffffff,
		postProcessesEnabled: true,
		depthTexture: { mode: "disabled", force32BitsFloat: false, includeTransparent: false },
		depthPrimingMode: "auto",
		forwardPlus: { horizontalTiles: 12, verticalTiles: 12, depthSlices: 8, maxRange: 10_000 },
		rendererFeatureInstanceIds: null,
	};
}

export function validateRendererDataSettings(value: unknown): IRendererDataSettings {
	const source = object(value, "Renderer-data settings");
	rejectUnknownKeys(
		source,
		["version", "renderingPath", "fallbackToForward", "layerMask", "postProcessesEnabled", "depthTexture", "depthPrimingMode", "forwardPlus", "rendererFeatureInstanceIds"],
		"Renderer-data settings"
	);
	if (source.version !== 1) {
		throw new Error("Renderer-data settings version must be 1.");
	}
	if (!rendererDataRenderingPaths.includes(source.renderingPath as RendererDataRenderingPath)) {
		throw new Error("Renderer-data renderingPath must be forward, forward-plus, or deferred.");
	}
	if (typeof source.fallbackToForward !== "boolean" || typeof source.postProcessesEnabled !== "boolean") {
		throw new Error("Renderer-data fallbackToForward and postProcessesEnabled must be boolean.");
	}
	const depthTexture = object(source.depthTexture, "Renderer-data depthTexture");
	rejectUnknownKeys(depthTexture, ["mode", "force32BitsFloat", "includeTransparent"], "Renderer-data depthTexture");
	if (!rendererDataDepthTextureModes.includes(depthTexture.mode as RendererDataDepthTextureMode)) {
		throw new Error("Renderer-data depthTexture.mode is invalid.");
	}
	if (typeof depthTexture.force32BitsFloat !== "boolean" || typeof depthTexture.includeTransparent !== "boolean") {
		throw new Error("Renderer-data depth-texture flags must be boolean.");
	}
	if (!rendererDataDepthPrimingModes.includes(source.depthPrimingMode as RendererDataDepthPrimingMode)) {
		throw new Error("Renderer-data depthPrimingMode must be disabled, auto, or forced.");
	}
	const forwardPlus = object(source.forwardPlus, "Renderer-data forwardPlus");
	rejectUnknownKeys(forwardPlus, ["horizontalTiles", "verticalTiles", "depthSlices", "maxRange"], "Renderer-data forwardPlus");
	let rendererFeatureInstanceIds: string[] | null = null;
	if (source.rendererFeatureInstanceIds !== null) {
		if (
			!Array.isArray(source.rendererFeatureInstanceIds) ||
			source.rendererFeatureInstanceIds.length > 64 ||
			source.rendererFeatureInstanceIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 128) ||
			new Set(source.rendererFeatureInstanceIds).size !== source.rendererFeatureInstanceIds.length
		) {
			throw new Error("Renderer-data rendererFeatureInstanceIds must be null or at most 64 unique bounded ids.");
		}
		rendererFeatureInstanceIds = [...source.rendererFeatureInstanceIds];
	}
	return {
		version: 1,
		renderingPath: source.renderingPath as RendererDataRenderingPath,
		fallbackToForward: source.fallbackToForward,
		layerMask: integer(source.layerMask, "Renderer-data layerMask", 0, 4_294_967_295),
		postProcessesEnabled: source.postProcessesEnabled,
		depthTexture: {
			mode: depthTexture.mode as RendererDataDepthTextureMode,
			force32BitsFloat: depthTexture.force32BitsFloat,
			includeTransparent: depthTexture.includeTransparent,
		},
		depthPrimingMode: source.depthPrimingMode as RendererDataDepthPrimingMode,
		forwardPlus: {
			horizontalTiles: integer(forwardPlus.horizontalTiles, "Renderer-data forwardPlus.horizontalTiles", 1, 256),
			verticalTiles: integer(forwardPlus.verticalTiles, "Renderer-data forwardPlus.verticalTiles", 1, 256),
			depthSlices: integer(forwardPlus.depthSlices, "Renderer-data forwardPlus.depthSlices", 1, 256),
			maxRange: finite(forwardPlus.maxRange, "Renderer-data forwardPlus.maxRange", 0.01, 1_000_000),
		},
		rendererFeatureInstanceIds,
	};
}

export function validateRendererDataAssetSnapshot(value: unknown, label = "Renderer-data asset snapshot"): IRendererDataAssetSnapshot {
	const source = object(value, label);
	rejectUnknownKeys(source, ["version", "path", "id", "name", "assetRevision", "contentRevision", "settings"], label);
	if (source.version !== 1) {
		throw new Error(`${label} version must be 1.`);
	}
	return {
		version: 1,
		path: string(source.path, `${label} path`),
		id: string(source.id, `${label} id`, 128),
		name: string(source.name, `${label} name`, 128),
		assetRevision: integer(source.assetRevision, `${label} assetRevision`, 1, Number.MAX_SAFE_INTEGER),
		contentRevision: string(source.contentRevision, `${label} contentRevision`, 128),
		settings: validateRendererDataSettings(source.settings),
	};
}

export function validateRendererDataSelections(value: unknown): IRendererDataSelections {
	if (value === undefined || value === null) {
		return { version: 1, revision: 1, default: null, cameras: [] };
	}
	const source = object(value, "Renderer-data selections");
	rejectUnknownKeys(source, ["version", "revision", "default", "cameras"], "Renderer-data selections");
	if (source.version !== 1 || !Array.isArray(source.cameras) || source.cameras.length > 64) {
		throw new Error("Renderer-data selections require version 1 and at most 64 camera overrides.");
	}
	const cameras = source.cameras.map((entry, index): IRendererDataCameraSelection => {
		const camera = object(entry, `Renderer-data camera selection ${index}`);
		rejectUnknownKeys(camera, ["cameraId", "asset"], `Renderer-data camera selection ${index}`);
		return { cameraId: string(camera.cameraId, `Renderer-data camera selection ${index} cameraId`, 256), asset: validateRendererDataAssetSnapshot(camera.asset) };
	});
	if (new Set(cameras.map((entry) => entry.cameraId)).size !== cameras.length) {
		throw new Error("Renderer-data camera overrides must use unique camera ids.");
	}
	return {
		version: 1,
		revision: integer(source.revision, "Renderer-data selections revision", 1, Number.MAX_SAFE_INTEGER),
		default: source.default === null ? null : validateRendererDataAssetSnapshot(source.default),
		cameras,
	};
}

function inactiveRuntime(error?: string): IRendererDataRuntime {
	return {
		backend: rendererDataRuntimeBackend,
		configured: false,
		revision: null,
		defaultAssetId: null,
		cameras: [],
		warnings: [],
		errors: error ? [error] : [],
	};
}

function clusteredContainer(scene: Scene): ClusteredLightContainer | null {
	return (scene.lights.find((light) => light.getClassName() === "ClusteredLightContainer") as ClusteredLightContainer | undefined) ?? null;
}

function selectedAsset(selections: IRendererDataSelections, camera: Camera): { source: "default" | "camera"; asset: IRendererDataAssetSnapshot } | null {
	const override = selections.cameras.find((entry) => entry.cameraId === camera.id);
	return override ? { source: "camera", asset: override.asset } : selections.default ? { source: "default", asset: selections.default } : null;
}

function existingDepthRenderer(scene: Scene, camera: Camera): DepthRenderer | null {
	return ((scene as unknown as { _depthRenderer?: Record<string, DepthRenderer> })._depthRenderer?.[camera.id] as DepthRenderer | undefined) ?? null;
}

function applyDepthRenderer(scene: Scene, camera: Camera, settings: IRendererDataSettings): IDepthBaseline | null {
	const required = settings.depthTexture.mode !== "disabled" || settings.depthPrimingMode === "forced";
	if (!required) {
		return null;
	}
	const existing = existingDepthRenderer(scene, camera);
	const renderer =
		existing ??
		scene.enableDepthRenderer(
			camera,
			settings.depthTexture.mode === "non-linear",
			settings.depthTexture.force32BitsFloat,
			undefined,
			settings.depthTexture.mode === "camera-space-z"
		);
	const baseline: IDepthBaseline = {
		renderer,
		owned: existing === null,
		enabled: renderer.enabled,
		forceDepthWriteTransparentMeshes: renderer.forceDepthWriteTransparentMeshes,
		useOnlyInActiveCamera: renderer.useOnlyInActiveCamera,
	};
	renderer.enabled = true;
	renderer.forceDepthWriteTransparentMeshes = settings.depthTexture.includeTransparent;
	renderer.useOnlyInActiveCamera = true;
	return baseline;
}

function depthRuntime(settings: IRendererDataSettings, baseline: IDepthBaseline | null): IRendererDataCameraRuntime["depthTexture"] {
	const depthMap = baseline?.renderer.getDepthMap();
	const size = depthMap?.getSize();
	return {
		requestedMode: settings.depthTexture.mode,
		active: Boolean(baseline?.renderer.enabled),
		owned: baseline?.owned ?? false,
		ready: Boolean(depthMap?.isReady()),
		width: size?.width ?? 0,
		height: size?.height ?? 0,
		includeTransparent: settings.depthTexture.includeTransparent,
	};
}

function releaseRuntime(scene: Scene): IRendererDataRuntime {
	stopDeferredLighting(scene);
	const state = runtimeStates.get(scene);
	if (!state) {
		const report = inactiveRuntime();
		runtimeReports.set(scene, report);
		return report;
	}
	if (state.beforeCameraObserver) {
		scene.onBeforeCameraRenderObservable.remove(state.beforeCameraObserver);
	}
	if (state.afterCameraObserver) {
		scene.onAfterCameraRenderObservable.remove(state.afterCameraObserver);
	}
	if (state.newCameraObserver) {
		scene.onNewCameraAddedObservable.remove(state.newCameraObserver);
	}
	if (state.cameraRemovedObserver) {
		scene.onCameraRemovedObservable.remove(state.cameraRemovedObserver);
	}
	if (state.newMeshObserver) {
		scene.onNewMeshAddedObservable.remove(state.newMeshObserver);
	}
	if (state.meshRemovedObserver) {
		scene.onMeshRemovedObservable.remove(state.meshRemovedObserver);
	}
	if (state.newLightObserver) {
		scene.onNewLightAddedObservable.remove(state.newLightObserver);
	}
	if (state.lightRemovedObserver) {
		scene.onLightRemovedObservable.remove(state.lightRemovedObserver);
	}
	if (state.cameraRefreshTimeout !== null) {
		clearTimeout(state.cameraRefreshTimeout);
		state.cameraRefreshTimeout = null;
	}
	if (state.disposeObserver) {
		scene.onDisposeObservable.remove(state.disposeObserver);
	}
	for (const [camera, mask] of state.cameraBaselines) {
		if (!camera.isDisposed()) {
			camera.layerMask = mask;
		}
	}
	for (const [camera, baseline] of state.depthBaselines) {
		if (baseline.owned) {
			if (!camera.isDisposed()) {
				scene.disableDepthRenderer(camera);
			}
		} else {
			baseline.renderer.enabled = baseline.enabled;
			baseline.renderer.forceDepthWriteTransparentMeshes = baseline.forceDepthWriteTransparentMeshes;
			baseline.renderer.useOnlyInActiveCamera = baseline.useOnlyInActiveCamera;
		}
	}
	for (const baseline of state.clusteredBaselines.values()) {
		if (baseline.container.isEnabled() !== baseline.enabled) {
			baseline.container.setEnabled(baseline.enabled);
		}
		baseline.container.horizontalTiles = baseline.horizontalTiles;
		baseline.container.verticalTiles = baseline.verticalTiles;
		baseline.container.depthSlices = baseline.depthSlices;
		baseline.container.maxRange = baseline.maxRange;
	}
	scene.postProcessesEnabled = state.postProcessesEnabled;
	runtimeStates.delete(scene);
	const report = inactiveRuntime();
	runtimeReports.set(scene, report);
	return report;
}

function runtimeForCamera(
	scene: Scene,
	camera: Camera,
	source: "default" | "camera",
	asset: IRendererDataAssetSnapshot,
	depth: IDepthBaseline | null,
	deferredResolution: { runtime: IDeferredLightingRuntimeEvidence | null; selectionError: string | null }
): IRendererDataCameraRuntime {
	const settings = asset.settings;
	const deferred = deferredResolution.runtime;
	const deferredSelectionError = deferredResolution.selectionError;
	const warnings: string[] = [];
	const errors: string[] = [];
	const clustered = clusteredContainer(scene);
	const supported = Boolean(clustered?.isSupported);
	let effectiveRenderingPath: "forward" | "forward-plus" | "deferred" = "forward";
	if (settings.renderingPath === "forward-plus") {
		if (supported) {
			effectiveRenderingPath = "forward-plus";
		} else if (settings.fallbackToForward) {
			warnings.push("Forward+ was requested, but no supported Babylon ClusteredLightContainer is available; native forward fallback is active.");
		} else {
			errors.push("Forward+ requires a supported Babylon ClusteredLightContainer on this device.");
		}
	} else if (settings.renderingPath === "deferred") {
		if (deferred?.active) {
			effectiveRenderingPath = "deferred";
			warnings.push(...deferred.warnings);
		} else if (settings.fallbackToForward) {
			warnings.push(
				`Deferred was requested, but the bounded native path is unavailable; native forward fallback is active. ${deferredSelectionError ?? deferred?.errors.join(" ") ?? "No runtime evidence is available."}`
			);
		} else {
			errors.push(`Deferred rendering is unavailable. ${deferredSelectionError ?? deferred?.errors.join(" ") ?? "No runtime evidence is available."}`);
		}
	}
	const missingFeatures = (settings.rendererFeatureInstanceIds ?? []).filter(
		(id) => !(scene.metadata?.babylonEditorRendererFeatureInstances ?? []).some((instance: { id?: string }) => instance.id === id)
	);
	if (missingFeatures.length) {
		errors.push(`Renderer-data references missing renderer-feature instance ids: ${missingFeatures.join(", ")}.`);
	}
	return {
		cameraId: camera.id,
		cameraName: camera.name,
		source,
		asset: {
			version: asset.version,
			path: asset.path,
			id: asset.id,
			name: asset.name,
			assetRevision: asset.assetRevision,
			contentRevision: asset.contentRevision,
		},
		requestedRenderingPath: settings.renderingPath,
		effectiveRenderingPath,
		layerMask: camera.layerMask >>> 0,
		postProcessesEnabled: settings.postProcessesEnabled,
		depthPrimingMode: settings.depthPrimingMode,
		depthTexture: depthRuntime(settings, depth),
		forwardPlus: {
			active: effectiveRenderingPath === "forward-plus",
			supported,
			containerName: clustered?.name ?? null,
			lightCount: clustered?.lights.length ?? 0,
			...settings.forwardPlus,
		},
		deferred,
		rendererFeatureInstanceIds: settings.rendererFeatureInstanceIds ? [...settings.rendererFeatureInstanceIds] : null,
		warnings,
		errors,
	};
}

/** Applies persisted default/per-camera renderer-data snapshots through Babylon-native state. */
export function configureRendererDataSelections(scene: Scene): IRendererDataRuntime {
	releaseRuntime(scene);
	try {
		const selections = validateRendererDataSelections(scene.metadata?.[rendererDataSelectionsMetadataKey]);
		if (scene.metadata) {
			scene.metadata[rendererDataSelectionsMetadataKey] = selections;
		}
		if (!selections.default && !selections.cameras.length) {
			return inactiveRuntime();
		}
		const unknownCameraIds = selections.cameras.filter((entry) => !scene.getCameraById(entry.cameraId)).map((entry) => entry.cameraId);
		if (unknownCameraIds.length) {
			throw new Error(`Renderer-data selections reference missing camera ids: ${unknownCameraIds.join(", ")}.`);
		}
		const settingsByCameraId = new Map<string, IRendererDataSettings>();
		const cameraBaselines = new Map<Camera, number>();
		const depthBaselines = new Map<Camera, IDepthBaseline>();
		const clusteredBaselines = new Map<ClusteredLightContainer, IClusteredBaseline>();
		const cameraRuntimes: IRendererDataCameraRuntime[] = [];
		for (const camera of scene.cameras) {
			const selected = selectedAsset(selections, camera);
			if (!selected) {
				continue;
			}
			const settings = selected.asset.settings;
			settingsByCameraId.set(camera.id, settings);
			cameraBaselines.set(camera, camera.layerMask >>> 0);
			camera.layerMask = settings.layerMask;
			const depth = applyDepthRenderer(scene, camera, settings);
			if (depth) {
				depthBaselines.set(camera, depth);
			}
			const clustered = clusteredContainer(scene);
			if (clustered && !clusteredBaselines.has(clustered)) {
				clusteredBaselines.set(clustered, {
					container: clustered,
					enabled: clustered.isEnabled(),
					horizontalTiles: clustered.horizontalTiles,
					verticalTiles: clustered.verticalTiles,
					depthSlices: clustered.depthSlices,
					maxRange: clustered.maxRange,
				});
			}
			const deferredRuntime = settings.renderingPath === "deferred" ? configureDeferredLighting(scene, camera) : null;
			cameraRuntimes.push(
				runtimeForCamera(scene, camera, selected.source, selected.asset, depth, {
					runtime: deferredRuntime,
					selectionError: null,
				})
			);
		}
		const errors = cameraRuntimes.flatMap((camera) => camera.errors.map((error) => `${camera.cameraName}: ${error}`));
		const warnings = cameraRuntimes.flatMap((camera) => camera.warnings.map((warning) => `${camera.cameraName}: ${warning}`));
		const activeForwardPlusSettings = cameraRuntimes
			.filter((camera) => camera.forwardPlus.active)
			.map((camera) => JSON.stringify(camera.forwardPlus))
			.filter((value, index, values) => values.indexOf(value) === index);
		if (activeForwardPlusSettings.length > 1) {
			errors.push("All cameras using the shared Babylon ClusteredLightContainer must use identical Forward+ tile, slice, and range settings.");
		}
		if (errors.length) {
			stopDeferredLighting(scene);
			for (const [camera, mask] of cameraBaselines) {
				camera.layerMask = mask;
			}
			for (const [camera, depth] of depthBaselines) {
				if (depth.owned) {
					scene.disableDepthRenderer(camera);
				} else {
					depth.renderer.enabled = depth.enabled;
					depth.renderer.forceDepthWriteTransparentMeshes = depth.forceDepthWriteTransparentMeshes;
					depth.renderer.useOnlyInActiveCamera = depth.useOnlyInActiveCamera;
				}
			}
			const report: IRendererDataRuntime = {
				backend: rendererDataRuntimeBackend,
				configured: false,
				revision: selections.revision,
				defaultAssetId: selections.default?.id ?? null,
				cameras: cameraRuntimes,
				warnings,
				errors,
			};
			runtimeReports.set(scene, report);
			return report;
		}
		const forwardPlusSettings = cameraRuntimes.find((camera) => camera.forwardPlus.active)?.forwardPlus;
		if (forwardPlusSettings) {
			for (const baseline of clusteredBaselines.values()) {
				baseline.container.horizontalTiles = forwardPlusSettings.horizontalTiles;
				baseline.container.verticalTiles = forwardPlusSettings.verticalTiles;
				baseline.container.depthSlices = forwardPlusSettings.depthSlices;
				baseline.container.maxRange = forwardPlusSettings.maxRange;
			}
		}
		const report: IRendererDataRuntime = {
			backend: rendererDataRuntimeBackend,
			configured: true,
			revision: selections.revision,
			defaultAssetId: selections.default?.id ?? null,
			cameras: cameraRuntimes,
			warnings,
			errors: [],
		};
		const state: IRendererDataRuntimeState = {
			selections,
			settingsByCameraId,
			cameraBaselines,
			depthBaselines,
			clusteredBaselines,
			postProcessesEnabled: scene.postProcessesEnabled,
			beforeCameraObserver: null,
			afterCameraObserver: null,
			newCameraObserver: null,
			cameraRemovedObserver: null,
			newMeshObserver: null,
			meshRemovedObserver: null,
			newLightObserver: null,
			lightRemovedObserver: null,
			cameraRefreshTimeout: null,
			disposeObserver: null,
			report,
		};
		state.beforeCameraObserver = scene.onBeforeCameraRenderObservable.add((camera) => {
			const settings = state.settingsByCameraId.get(camera.id);
			if (!settings) {
				return;
			}
			scene.postProcessesEnabled = settings.postProcessesEnabled;
			for (const baseline of state.clusteredBaselines.values()) {
				const enabled = settings.renderingPath === "forward-plus" && baseline.container.isSupported;
				if (baseline.container.isEnabled() !== enabled) {
					baseline.container.setEnabled(enabled);
				}
			}
		});
		state.afterCameraObserver = scene.onAfterCameraRenderObservable.add(() => {
			scene.postProcessesEnabled = state.postProcessesEnabled;
			for (const baseline of state.clusteredBaselines.values()) {
				if (baseline.container.isEnabled() !== baseline.enabled) {
					baseline.container.setEnabled(baseline.enabled);
				}
			}
		});
		const scheduleCameraRefresh = (): void => {
			if (state.cameraRefreshTimeout !== null) {
				return;
			}
			state.cameraRefreshTimeout = setTimeout(() => {
				state.cameraRefreshTimeout = null;
				if (runtimeStates.get(scene) === state) {
					configureRendererDataSelections(scene);
				}
			}, 0);
		};
		state.newCameraObserver = scene.onNewCameraAddedObservable.add(scheduleCameraRefresh);
		state.cameraRemovedObserver = scene.onCameraRemovedObservable.add(scheduleCameraRefresh);
		state.newMeshObserver = scene.onNewMeshAddedObservable.add(scheduleCameraRefresh);
		state.meshRemovedObserver = scene.onMeshRemovedObservable.add(scheduleCameraRefresh);
		state.newLightObserver = scene.onNewLightAddedObservable.add(scheduleCameraRefresh);
		state.lightRemovedObserver = scene.onLightRemovedObservable.add(scheduleCameraRefresh);
		state.disposeObserver = scene.onDisposeObservable.add(() => {
			runtimeStates.delete(scene);
			runtimeReports.delete(scene);
		});
		runtimeStates.set(scene, state);
		runtimeReports.set(scene, report);
		return structuredClone(report);
	} catch (error) {
		const report = inactiveRuntime(error instanceof Error ? error.message : String(error));
		runtimeReports.set(scene, report);
		return report;
	}
}

/** Restores exact camera/depth/cluster/post-process baselines owned by renderer-data selection. */
export function restoreRendererDataSelectionsBaseline(scene: Scene): IRendererDataRuntime {
	return releaseRuntime(scene);
}

/** Returns immutable runtime evidence for renderer-data selection and fallbacks. */
export function getRendererDataRuntime(scene: Scene): IRendererDataRuntime {
	const report = structuredClone(runtimeReports.get(scene) ?? inactiveRuntime());
	for (const camera of report.cameras) {
		if (camera.requestedRenderingPath === "deferred") {
			camera.deferred = getDeferredLightingRuntime(scene, camera.cameraId);
		}
	}
	return report;
}

/** Lets renderer-feature execution honor the selected renderer-data feature list for a camera. */
export function rendererDataAllowsFeature(scene: Scene, camera: Camera, instanceId: string): boolean {
	const settings = runtimeStates.get(scene)?.settingsByCameraId.get(camera.id);
	return settings?.rendererFeatureInstanceIds === null || settings?.rendererFeatureInstanceIds === undefined || settings.rendererFeatureInstanceIds.includes(instanceId);
}

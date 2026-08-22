import { Camera } from "@babylonjs/core/Cameras/camera";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Scene } from "@babylonjs/core/scene";

export const cameraStacksMetadataKey = "babylonEditorCameraStacks";
export const activeCameraStackMetadataKey = "babylonEditorActiveCameraStack";

export const cameraStackViewportModes = ["inherit-base", "camera"] as const;
export type CameraStackViewportMode = (typeof cameraStackViewportModes)[number];

export interface ICameraStackOverlay {
	id: string;
	cameraId: string;
	enabled: boolean;
	order: number;
	clearColor: boolean;
	clearDepth: boolean;
	postProcessing: boolean;
	viewportMode: CameraStackViewportMode;
}

export interface ICameraStack {
	version: 1;
	id: string;
	name: string;
	revision: number;
	enabled: boolean;
	baseCameraId: string;
	baseClearColor: boolean;
	baseClearDepth: boolean;
	overlays: ICameraStackOverlay[];
}

export interface IActiveCameraStackLease {
	id: string;
	revision: number;
}

export interface ICameraStackClearOperation {
	cameraId: string;
	role: "base" | "overlay";
	clearColor: boolean;
	clearDepth: boolean;
}

export interface ICameraStackRuntimeCamera {
	cameraId: string;
	cameraName: string;
	role: "base" | "overlay";
	overlayId: string | null;
	renderOrder: number;
	clearColor: boolean;
	clearDepth: boolean;
	postProcessing: boolean;
	viewportMode: "base" | CameraStackViewportMode;
	viewport: [number, number, number, number];
	layerMask: number;
	postProcessCount: number;
}

export interface ICameraStackRuntime {
	backend: "bounded-babylon-base-overlay-camera-stack-v1";
	active: boolean;
	stackId: string | null;
	stackName: string | null;
	revision: number | null;
	valid: boolean;
	error: string | null;
	cameras: ICameraStackRuntimeCamera[];
	frameId: number | null;
	renderedCameraIds: string[];
	clearOperations: ICameraStackClearOperation[];
	suppressedPostProcessCameraIds: string[];
	limitations: string[];
}

interface ICameraBaseline {
	camera: Camera;
	viewport: Viewport;
}

interface IRuntimeState {
	stack: ICameraStack;
	base: Camera;
	overlays: { definition: ICameraStackOverlay; camera: Camera }[];
	baselineActiveCamera: Camera | null;
	baselineActiveCameras: Camera[] | null;
	cameraBaselines: ICameraBaseline[];
	hadOwnClearFrameBuffer: boolean;
	originalClearFrameBuffer: (camera: Camera | null) => void;
	beforeRenderObserver: any;
	beforeCameraObserver: any;
	afterCameraObserver: any;
	afterRenderObserver: any;
	disposeObserver: any;
	suppressedPostProcesses: Map<Camera, any[]>;
	runtime: ICameraStackRuntime;
}

const runtimeStates = new WeakMap<Scene, IRuntimeState>();
const runtimeReports = new WeakMap<Scene, ICameraStackRuntime>();

function inactiveRuntime(error: string | null = null): ICameraStackRuntime {
	return {
		backend: "bounded-babylon-base-overlay-camera-stack-v1",
		active: false,
		stackId: null,
		stackName: null,
		revision: null,
		valid: error === null,
		error,
		cameras: [],
		frameId: null,
		renderedCameraIds: [],
		clearOperations: [],
		suppressedPostProcessCameraIds: [],
		limitations: [
			"Camera stacks target the shared default framebuffer; camera output render targets and camera rigs are rejected.",
			"The postProcessing flag permits or suppresses each camera's attached Babylon post-process chain; it does not synthesize missing camera effects.",
		],
	};
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum = 128): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters.`);
	}
	return value;
}

function boolean(value: unknown, label: string, fallback?: boolean): boolean {
	if (value === undefined && fallback !== undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value as number;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
}

function normalizeOverlay(value: unknown, index: number): ICameraStackOverlay {
	const entry = object(value, `Camera stack overlay ${index}`);
	rejectUnknownKeys(entry, ["id", "cameraId", "enabled", "order", "clearColor", "clearDepth", "postProcessing", "viewportMode"], `Camera stack overlay ${index}`);
	const viewportMode = entry.viewportMode ?? "inherit-base";
	if (!cameraStackViewportModes.includes(viewportMode as CameraStackViewportMode)) {
		throw new Error(`Camera stack overlay ${index} viewportMode must be "inherit-base" or "camera".`);
	}
	return {
		id: string(entry.id, `Camera stack overlay ${index} id`),
		cameraId: string(entry.cameraId, `Camera stack overlay ${index} cameraId`),
		enabled: boolean(entry.enabled, `Camera stack overlay ${index} enabled`, true),
		order: integer(entry.order ?? index, `Camera stack overlay ${index} order`, -1000, 1000),
		clearColor: boolean(entry.clearColor, `Camera stack overlay ${index} clearColor`, false),
		clearDepth: boolean(entry.clearDepth, `Camera stack overlay ${index} clearDepth`, true),
		postProcessing: boolean(entry.postProcessing, `Camera stack overlay ${index} postProcessing`, false),
		viewportMode: viewportMode as CameraStackViewportMode,
	};
}

function normalizeStack(value: unknown, index: number): ICameraStack {
	const entry = object(value, `Camera stack ${index}`);
	rejectUnknownKeys(entry, ["version", "id", "name", "revision", "enabled", "baseCameraId", "baseClearColor", "baseClearDepth", "overlays"], `Camera stack ${index}`);
	const overlaysValue = entry.overlays ?? [];
	if (!Array.isArray(overlaysValue) || overlaysValue.length > 8) {
		throw new Error(`Camera stack ${index} overlays must be an array with at most 8 entries.`);
	}
	const overlays = overlaysValue.map(normalizeOverlay);
	const overlayIds = new Set<string>();
	const overlayCameraIds = new Set<string>();
	for (const overlay of overlays) {
		if (overlayIds.has(overlay.id)) {
			throw new Error(`Camera stack ${index} has duplicate overlay id "${overlay.id}".`);
		}
		if (overlayCameraIds.has(overlay.cameraId)) {
			throw new Error(`Camera stack ${index} uses camera "${overlay.cameraId}" more than once as an overlay.`);
		}
		overlayIds.add(overlay.id);
		overlayCameraIds.add(overlay.cameraId);
	}
	const baseCameraId = string(entry.baseCameraId, `Camera stack ${index} baseCameraId`);
	if (overlayCameraIds.has(baseCameraId)) {
		throw new Error(`Camera stack ${index} cannot also use its base camera as an overlay.`);
	}
	return {
		version: integer(entry.version ?? 1, `Camera stack ${index} version`, 1, 1) as 1,
		id: string(entry.id, `Camera stack ${index} id`),
		name: string(entry.name, `Camera stack ${index} name`),
		revision: integer(entry.revision, `Camera stack ${index} revision`, 1, Number.MAX_SAFE_INTEGER),
		enabled: boolean(entry.enabled, `Camera stack ${index} enabled`, true),
		baseCameraId,
		baseClearColor: boolean(entry.baseClearColor, `Camera stack ${index} baseClearColor`, true),
		baseClearDepth: boolean(entry.baseClearDepth, `Camera stack ${index} baseClearDepth`, true),
		overlays,
	};
}

/** Validates and normalizes the bounded persisted camera-stack collection. */
export function validateCameraStacks(value: unknown): ICameraStack[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 32) {
		throw new Error("Camera stacks must be an array with at most 32 entries.");
	}
	const stacks = value.map(normalizeStack);
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const stack of stacks) {
		if (ids.has(stack.id)) {
			throw new Error(`Duplicate camera stack id "${stack.id}".`);
		}
		if (names.has(stack.name)) {
			throw new Error(`Duplicate camera stack name "${stack.name}".`);
		}
		ids.add(stack.id);
		names.add(stack.name);
	}
	return stacks;
}

/** Validates that a camera stack can execute on the current Babylon scene. */
export function validateCameraStackForScene(scene: Scene, stack: ICameraStack): { base: Camera; overlays: { definition: ICameraStackOverlay; camera: Camera }[] } {
	if (!stack.enabled) {
		throw new Error(`Camera stack "${stack.name}" is disabled.`);
	}
	const resolve = (cameraId: string, role: string): Camera => {
		const camera = scene.getCameraById(cameraId);
		if (!camera) {
			throw new Error(`Camera stack "${stack.name}" ${role} camera "${cameraId}" was not found.`);
		}
		if (camera.cameraRigMode !== Camera.RIG_MODE_NONE) {
			throw new Error(`Camera stack "${stack.name}" ${role} camera "${camera.name}" uses a camera rig, which is not supported by the bounded stack runtime.`);
		}
		if (camera.outputRenderTarget) {
			throw new Error(`Camera stack "${stack.name}" ${role} camera "${camera.name}" has an output render target; stacks require the shared default framebuffer.`);
		}
		return camera;
	};
	const base = resolve(stack.baseCameraId, "base");
	const overlays = stack.overlays
		.filter((overlay) => overlay.enabled)
		.map((definition) => ({ definition, camera: resolve(definition.cameraId, "overlay") }))
		.sort((first, second) => first.definition.order - second.definition.order || stack.overlays.indexOf(first.definition) - stack.overlays.indexOf(second.definition));
	return { base, overlays };
}

function viewportArray(viewport: Viewport): [number, number, number, number] {
	return [viewport.x, viewport.y, viewport.width, viewport.height];
}

function runtimeCamera(camera: Camera, role: "base" | "overlay", renderOrder: number, overlay: ICameraStackOverlay | null, stack: ICameraStack): ICameraStackRuntimeCamera {
	return {
		cameraId: camera.id,
		cameraName: camera.name,
		role,
		overlayId: overlay?.id ?? null,
		renderOrder,
		clearColor: overlay?.clearColor ?? stack.baseClearColor,
		clearDepth: overlay?.clearDepth ?? stack.baseClearDepth,
		postProcessing: overlay?.postProcessing ?? true,
		viewportMode: overlay?.viewportMode ?? "base",
		viewport: viewportArray(camera.viewport),
		layerMask: camera.layerMask >>> 0,
		postProcessCount: ((camera as any)._postProcesses as any[] | undefined)?.filter(Boolean).length ?? 0,
	};
}

function restoreSuppressedPostProcesses(state: IRuntimeState): void {
	for (const [camera, postProcesses] of state.suppressedPostProcesses) {
		(camera as any)._postProcesses = postProcesses;
	}
	state.suppressedPostProcesses.clear();
}

function removeRuntime(scene: Scene, restoreScene: boolean): ICameraStackRuntime {
	const state = runtimeStates.get(scene);
	if (!state) {
		const report = inactiveRuntime();
		runtimeReports.set(scene, report);
		return report;
	}
	restoreSuppressedPostProcesses(state);
	scene.onBeforeRenderObservable.remove(state.beforeRenderObserver);
	scene.onBeforeCameraRenderObservable.remove(state.beforeCameraObserver);
	scene.onAfterCameraRenderObservable.remove(state.afterCameraObserver);
	scene.onAfterRenderObservable.remove(state.afterRenderObserver);
	scene.onDisposeObservable.remove(state.disposeObserver);
	const sceneAny = scene as any;
	if (state.hadOwnClearFrameBuffer) {
		sceneAny._clearFrameBuffer = state.originalClearFrameBuffer;
	} else {
		delete sceneAny._clearFrameBuffer;
	}
	for (const baseline of state.cameraBaselines) {
		baseline.camera.viewport = baseline.viewport;
	}
	if (restoreScene && !scene.isDisposed) {
		scene.activeCameras = state.baselineActiveCameras ? [...state.baselineActiveCameras] : null;
		scene.activeCamera = state.baselineActiveCamera;
	}
	runtimeStates.delete(scene);
	const report = inactiveRuntime();
	runtimeReports.set(scene, report);
	return report;
}

/** Restores the exact pre-stack camera selection, viewports, clear hook, and post-process arrays. */
export function restoreCameraStackBaseline(scene: Scene): ICameraStackRuntime {
	return removeRuntime(scene, true);
}

function activateCameraStack(scene: Scene, stack: ICameraStack): ICameraStackRuntime {
	const resolved = validateCameraStackForScene(scene, stack);
	removeRuntime(scene, true);
	const sceneAny = scene as any;
	const cameraBaselines = resolved.overlays.map(({ camera }) => ({
		camera,
		viewport: new Viewport(camera.viewport.x, camera.viewport.y, camera.viewport.width, camera.viewport.height),
	}));
	const runtime: ICameraStackRuntime = {
		...inactiveRuntime(),
		active: true,
		stackId: stack.id,
		stackName: stack.name,
		revision: stack.revision,
		valid: true,
		cameras: [
			runtimeCamera(resolved.base, "base", 0, null, stack),
			...resolved.overlays.map(({ definition, camera }, index) => runtimeCamera(camera, "overlay", index + 1, definition, stack)),
		],
	};
	const originalClearFrameBuffer = sceneAny._clearFrameBuffer as (camera: Camera | null) => void;
	const state: IRuntimeState = {
		stack,
		base: resolved.base,
		overlays: resolved.overlays,
		baselineActiveCamera: scene.activeCamera,
		baselineActiveCameras: scene.activeCameras ? [...scene.activeCameras] : null,
		cameraBaselines,
		hadOwnClearFrameBuffer: Object.prototype.hasOwnProperty.call(sceneAny, "_clearFrameBuffer"),
		originalClearFrameBuffer,
		beforeRenderObserver: null,
		beforeCameraObserver: null,
		afterCameraObserver: null,
		afterRenderObserver: null,
		disposeObserver: null,
		suppressedPostProcesses: new Map(),
		runtime,
	};
	runtimeStates.set(scene, state);
	runtimeReports.set(scene, runtime);

	sceneAny._clearFrameBuffer = (camera: Camera | null): void => {
		const role = camera === state.base ? "base" : "overlay";
		const overlay = state.overlays.find((entry) => entry.camera === camera)?.definition;
		if (camera !== state.base && !overlay) {
			state.originalClearFrameBuffer.call(scene, camera);
			return;
		}
		const clearColor = overlay?.clearColor ?? state.stack.baseClearColor;
		const clearDepth = overlay?.clearDepth ?? state.stack.baseClearDepth;
		if (clearColor || clearDepth) {
			scene.getEngine().clear(clearColor ? scene.clearColor : null, clearColor, clearDepth, clearDepth);
		}
		sceneAny._defaultFrameBufferCleared = true;
		state.runtime.clearOperations.push({ cameraId: camera!.id, role, clearColor, clearDepth });
	};

	state.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
		state.runtime.frameId = scene.getFrameId();
		state.runtime.renderedCameraIds = [];
		state.runtime.clearOperations = [];
		state.runtime.suppressedPostProcessCameraIds = [];
		for (const { definition, camera } of state.overlays) {
			if (definition.viewportMode === "inherit-base") {
				camera.viewport = new Viewport(state.base.viewport.x, state.base.viewport.y, state.base.viewport.width, state.base.viewport.height);
			}
		}
		state.runtime.cameras = [
			runtimeCamera(state.base, "base", 0, null, state.stack),
			...state.overlays.map(({ definition, camera }, index) => runtimeCamera(camera, "overlay", index + 1, definition, state.stack)),
		];
	});
	state.beforeCameraObserver = scene.onBeforeCameraRenderObservable.add((camera) => {
		state.runtime.renderedCameraIds.push(camera.id);
		const overlay = state.overlays.find((entry) => entry.camera === camera)?.definition;
		if (overlay && !overlay.postProcessing) {
			const postProcesses = (camera as any)._postProcesses as any[] | undefined;
			if (postProcesses?.some(Boolean) && !state.suppressedPostProcesses.has(camera)) {
				state.suppressedPostProcesses.set(camera, postProcesses);
				(camera as any)._postProcesses = [];
				state.runtime.suppressedPostProcessCameraIds.push(camera.id);
			}
		}
	});
	state.afterCameraObserver = scene.onAfterCameraRenderObservable.add((camera) => {
		const postProcesses = state.suppressedPostProcesses.get(camera);
		if (postProcesses) {
			(camera as any)._postProcesses = postProcesses;
			state.suppressedPostProcesses.delete(camera);
		}
	});
	state.afterRenderObserver = scene.onAfterRenderObservable.add(() => restoreSuppressedPostProcesses(state));
	state.disposeObserver = scene.onDisposeObservable.add(() => removeRuntime(scene, false));

	scene.activeCamera = resolved.base;
	scene.activeCameras = [resolved.base, ...resolved.overlays.map((entry) => entry.camera)];
	return runtime;
}

/** Applies the exact persisted active stack lease, or restores the baseline when no lease exists. */
export function configureCameraStacks(scene: Scene): ICameraStackRuntime {
	try {
		const stacks = validateCameraStacks(scene.metadata?.[cameraStacksMetadataKey]);
		if (scene.metadata) {
			scene.metadata[cameraStacksMetadataKey] = stacks;
		}
		const active = scene.metadata?.[activeCameraStackMetadataKey] as IActiveCameraStackLease | null | undefined;
		if (active === undefined || active === null) {
			return removeRuntime(scene, true);
		}
		const lease = object(active, "Active camera stack lease");
		rejectUnknownKeys(lease, ["id", "revision"], "Active camera stack lease");
		const id = string(lease.id, "Active camera stack id");
		const revision = integer(lease.revision, "Active camera stack revision", 1, Number.MAX_SAFE_INTEGER);
		const stack = stacks.find((candidate) => candidate.id === id);
		if (!stack) {
			throw new Error(`Active camera stack "${id}" was not found.`);
		}
		if (stack.revision !== revision) {
			throw new Error(`Active camera stack lease is stale. Expected revision ${stack.revision}.`);
		}
		return activateCameraStack(scene, stack);
	} catch (error) {
		removeRuntime(scene, true);
		const report = inactiveRuntime(error instanceof Error ? error.message : String(error));
		runtimeReports.set(scene, report);
		return report;
	}
}

/** Returns immutable bounded runtime evidence for the currently configured camera stack. */
export function getCameraStackRuntime(scene: Scene): ICameraStackRuntime {
	return structuredClone(runtimeReports.get(scene) ?? inactiveRuntime());
}

import { Scene, Tools } from "babylonjs";
import {
	activeCameraStackMetadataKey,
	cameraStacksMetadataKey,
	configureCameraStacks,
	getCameraStackRuntime as getSharedCameraStackRuntime,
	ICameraStack,
	ICameraStackOverlay,
	restoreCameraStackBaseline,
	validateCameraStackForScene,
	validateCameraStacks,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

function stacks(scene: Scene): ICameraStack[] {
	scene.metadata ??= {};
	const values = validateCameraStacks(scene.metadata[cameraStacksMetadataKey]);
	scene.metadata[cameraStacksMetadataKey] = values;
	return values;
}

function stack(scene: Scene, data: any): ICameraStack {
	const values = stacks(scene);
	const value = data.stackId ? values.find((candidate) => candidate.id === data.stackId) : data.stackName ? values.find((candidate) => candidate.name === data.stackName) : null;
	if (!value) {
		throw new Error("Camera stack not found. Provide stackId (preferred) or an exact stackName.");
	}
	return value;
}

function validateReferences(scene: Scene, value: ICameraStack): void {
	validateCameraStackForScene(scene as any, {
		...value,
		enabled: true,
		overlays: value.overlays.map((overlay) => ({ ...overlay, enabled: true })),
	});
}

function activeLease(scene: Scene): { id: string; revision: number } | null {
	const value = scene.metadata?.[activeCameraStackMetadataKey];
	return value && typeof value.id === "string" && Number.isInteger(value.revision) ? { id: value.id, revision: value.revision } : null;
}

function publish(scene: Scene, previous: ICameraStack[], next: ICameraStack[], changedId: string): { active: boolean; runtime: any } {
	const previousLease = activeLease(scene);
	scene.metadata[cameraStacksMetadataKey] = validateCameraStacks(next);
	const active = previousLease?.id === changedId;
	if (!active) {
		return { active: false, runtime: getSharedCameraStackRuntime(scene as any) };
	}
	const changed = next.find((candidate) => candidate.id === changedId)!;
	if (!changed.enabled) {
		scene.metadata[cameraStacksMetadataKey] = previous;
		throw new Error("Disable the active camera stack only after clearing its active lease.");
	}
	scene.metadata[activeCameraStackMetadataKey] = { id: changed.id, revision: changed.revision };
	const runtime = configureCameraStacks(scene as any);
	if (!runtime.valid) {
		scene.metadata[cameraStacksMetadataKey] = previous;
		scene.metadata[activeCameraStackMetadataKey] = previousLease;
		configureCameraStacks(scene as any);
		throw new Error(`Camera stack update could not be applied atomically: ${runtime.error}`);
	}
	return { active: true, runtime };
}

function forceUpdate(options: IMCPActionOptions): void {
	options.editor.layout.inspector.forceUpdate();
}

/** Lists bounded versioned base/overlay camera stacks, the active lease, and available cameras. */
export function listCameraStacks(scene: Scene, data: any = {}): any {
	const values = stacks(scene);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 32;
	const page = values.slice(offset, offset + limit);
	const cameras = scene.cameras.slice(0, 64).map((camera) => ({
		id: camera.id,
		name: camera.name,
		className: camera.getClassName(),
		layerMask: camera.layerMask >>> 0,
		cameraRigMode: camera.cameraRigMode,
		hasOutputRenderTarget: Boolean(camera.outputRenderTarget),
		viewport: [camera.viewport.x, camera.viewport.y, camera.viewport.width, camera.viewport.height],
		postProcessCount: ((camera as any)._postProcesses as any[] | undefined)?.filter(Boolean).length ?? 0,
	}));
	return {
		stacks: structuredClone(page),
		offset,
		limit,
		total: values.length,
		hasMore: offset + page.length < values.length,
		active: activeLease(scene),
		cameras,
		camerasTruncated: scene.cameras.length > cameras.length,
		runtime: getSharedCameraStackRuntime(scene as any),
	};
}

/** Creates a versioned stack with one base camera and no overlays. */
export function createCameraStack(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = stacks(scene);
	if (values.length >= 32) {
		throw new Error("Camera stack limit reached (32). Delete an unused stack before creating another.");
	}
	if (values.some((candidate) => candidate.name === data.name)) {
		throw new Error(`Camera stack "${data.name}" already exists.`);
	}
	const value: ICameraStack = {
		version: 1,
		id: Tools.RandomId(),
		name: data.name,
		revision: 1,
		enabled: data.enabled ?? true,
		baseCameraId: data.baseCameraId,
		baseClearColor: data.baseClearColor ?? true,
		baseClearDepth: data.baseClearDepth ?? true,
		overlays: [],
	};
	validateReferences(scene, value);
	scene.metadata[cameraStacksMetadataKey] = validateCameraStacks([...values, value]);
	forceUpdate(options);
	return { stack: structuredClone(value), runtime: getSharedCameraStackRuntime(scene as any) };
}

/** Version-leased update of stack identity, base camera, enabled state, and base clear policy. */
export function setCameraStack(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = stacks(scene);
	const value = stack(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Camera stack revision is stale. Expected ${value.revision}.`);
	}
	const candidate: ICameraStack = {
		...structuredClone(value),
		...(data.newName !== undefined ? { name: data.newName } : {}),
		...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
		...(data.baseCameraId !== undefined ? { baseCameraId: data.baseCameraId } : {}),
		...(data.baseClearColor !== undefined ? { baseClearColor: data.baseClearColor } : {}),
		...(data.baseClearDepth !== undefined ? { baseClearDepth: data.baseClearDepth } : {}),
		revision: value.revision + 1,
	};
	if (values.some((other) => other.id !== value.id && other.name === candidate.name)) {
		throw new Error(`Camera stack "${candidate.name}" already exists.`);
	}
	validateReferences(scene, candidate);
	const previous = structuredClone(values);
	const next = values.map((entry) => (entry.id === value.id ? candidate : entry));
	const publication = publish(scene, previous, next, value.id);
	forceUpdate(options);
	return { stack: structuredClone(candidate), ...publication };
}

/** Adds one uniquely identified overlay camera under an exact stack revision. */
export function addCameraStackOverlay(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = stacks(scene);
	const value = stack(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Camera stack revision is stale. Expected ${value.revision}.`);
	}
	if (value.overlays.length >= 8) {
		throw new Error(`Camera stack "${value.name}" already has the maximum 8 overlays.`);
	}
	const overlay: ICameraStackOverlay = {
		id: Tools.RandomId(),
		cameraId: data.cameraId,
		enabled: data.enabled ?? true,
		order: data.order ?? value.overlays.length,
		clearColor: data.clearColor ?? false,
		clearDepth: data.clearDepth ?? true,
		postProcessing: data.postProcessing ?? false,
		viewportMode: data.viewportMode ?? "inherit-base",
	};
	const candidate = { ...structuredClone(value), revision: value.revision + 1, overlays: [...structuredClone(value.overlays), overlay] };
	validateReferences(scene, candidate);
	const previous = structuredClone(values);
	const publication = publish(
		scene,
		previous,
		values.map((entry) => (entry.id === value.id ? candidate : entry)),
		value.id
	);
	forceUpdate(options);
	return { stack: structuredClone(candidate), overlay: structuredClone(overlay), ...publication };
}

/** Updates one overlay's camera, ordering, clear, viewport, or post-processing policy under an exact stack revision. */
export function setCameraStackOverlay(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = stacks(scene);
	const value = stack(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Camera stack revision is stale. Expected ${value.revision}.`);
	}
	const overlay = value.overlays.find((candidate) => candidate.id === data.overlayId);
	if (!overlay) {
		throw new Error(`Camera stack overlay "${data.overlayId}" was not found.`);
	}
	const updated: ICameraStackOverlay = {
		...structuredClone(overlay),
		...(data.cameraId !== undefined ? { cameraId: data.cameraId } : {}),
		...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
		...(data.order !== undefined ? { order: data.order } : {}),
		...(data.clearColor !== undefined ? { clearColor: data.clearColor } : {}),
		...(data.clearDepth !== undefined ? { clearDepth: data.clearDepth } : {}),
		...(data.postProcessing !== undefined ? { postProcessing: data.postProcessing } : {}),
		...(data.viewportMode !== undefined ? { viewportMode: data.viewportMode } : {}),
	};
	const candidate = {
		...structuredClone(value),
		revision: value.revision + 1,
		overlays: value.overlays.map((entry) => (entry.id === overlay.id ? updated : structuredClone(entry))),
	};
	validateReferences(scene, candidate);
	const previous = structuredClone(values);
	const publication = publish(
		scene,
		previous,
		values.map((entry) => (entry.id === value.id ? candidate : entry)),
		value.id
	);
	forceUpdate(options);
	return { stack: structuredClone(candidate), overlay: structuredClone(updated), ...publication };
}

/** Removes one overlay under an exact stack revision and atomically reapplies an active stack. */
export function removeCameraStackOverlay(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = stacks(scene);
	const value = stack(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Camera stack revision is stale. Expected ${value.revision}.`);
	}
	const overlay = value.overlays.find((candidate) => candidate.id === data.overlayId);
	if (!overlay) {
		throw new Error(`Camera stack overlay "${data.overlayId}" was not found.`);
	}
	const candidate = { ...structuredClone(value), revision: value.revision + 1, overlays: value.overlays.filter((entry) => entry.id !== overlay.id) };
	const previous = structuredClone(values);
	const publication = publish(
		scene,
		previous,
		values.map((entry) => (entry.id === value.id ? candidate : entry)),
		value.id
	);
	forceUpdate(options);
	return { removed: true, overlayId: overlay.id, stack: structuredClone(candidate), ...publication };
}

/** Activates a stack under its exact version lease and changes Babylon's ordered active camera list atomically. */
export function applyCameraStack(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = stack(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Camera stack revision is stale. Expected ${value.revision}.`);
	}
	validateReferences(scene, value);
	const previousLease = activeLease(scene);
	scene.metadata[activeCameraStackMetadataKey] = { id: value.id, revision: value.revision };
	const runtime = configureCameraStacks(scene as any);
	if (!runtime.valid) {
		scene.metadata[activeCameraStackMetadataKey] = previousLease;
		configureCameraStacks(scene as any);
		throw new Error(`Camera stack could not be applied atomically: ${runtime.error}`);
	}
	forceUpdate(options);
	return { applied: true, stack: structuredClone(value), runtime };
}

/** Clears the exact active stack lease and restores the pre-activation camera selection and viewport state. */
export function clearActiveCameraStack(scene: Scene, data: any, options: IMCPActionOptions): any {
	const lease = activeLease(scene);
	if (!lease) {
		throw new Error("No active camera stack is configured.");
	}
	if (data.stackId !== lease.id || data.revision !== lease.revision) {
		throw new Error(`Active camera stack lease is stale. Expected id ${lease.id} revision ${lease.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Clearing the active camera stack requires confirm: true.");
	}
	scene.metadata[activeCameraStackMetadataKey] = null;
	const runtime = restoreCameraStackBaseline(scene as any);
	forceUpdate(options);
	return { cleared: true, stackId: lease.id, revision: lease.revision, runtime };
}

/** Deletes one inactive stack under an exact version lease and literal confirmation. */
export function deleteCameraStack(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = stacks(scene);
	const value = stack(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Camera stack revision is stale. Expected ${value.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Deleting a camera stack requires confirm: true.");
	}
	if (activeLease(scene)?.id === value.id) {
		throw new Error(`Camera stack "${value.name}" is active. Clear it before deletion.`);
	}
	scene.metadata[cameraStacksMetadataKey] = values.filter((candidate) => candidate.id !== value.id);
	forceUpdate(options);
	return { deleted: true, stackId: value.id, revision: value.revision };
}

/** Returns current ordered-camera, clear, viewport, and post-process runtime evidence. */
export function getCameraStackRuntime(scene: Scene): any {
	return getSharedCameraStackRuntime(scene as any);
}

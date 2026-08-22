import { Color4, LinesMesh, MeshBuilder, Observer, Scene, Vector3 } from "babylonjs";

import { setNodeSerializable, setNodeVisibleInGraph } from "../../tools/node/metadata";

import { IMCPActionOptions } from "../action";
import { IPhysicsContactEvent, physicsContactEventTypes } from "./contact-history-types";
import { IPhysicsEditorTarget, resolvePhysicsEditorTarget } from "./target";

export { physicsContactEventTypes } from "./contact-history-types";
export type { IPhysicsContactEvent, PhysicsContactEventType } from "./contact-history-types";

/** Owns one rolling capture and the exact callback state that must be restored on every exit path. */
interface IPhysicsContactCapture {
	target: "editor" | "play";
	startedAt: number;
	maxEvents: number;
	includeContinued: boolean;
	events: IPhysicsContactEvent[];
	droppedEvents: number;
	nextSequence: number;
	observer: any;
	disposeObserver: Observer<Scene> | null;
	observable: any;
	previousCallbackStates: Map<any, boolean>;
	owner: object | null;
}

/** Owns scene-local live debug overlays independently from replay-session overlays. */
interface IPhysicsContactVisualization {
	enabled: boolean;
	normalScale: number;
	pointSize: number;
	lifetimeMs: number;
	overlays: Map<LinesMesh, ReturnType<typeof setTimeout>>;
	disposeObserver: Observer<Scene> | null;
}

const captures = new WeakMap<Scene, IPhysicsContactCapture>();
const captureOwners = new WeakMap<object, Scene>();
const visualizations = new WeakMap<Scene, IPhysicsContactVisualization>();

/** Keeps an active capture addressable if Play starts or stops while recording. */
function resolveContactTarget(scene: Scene, options?: IMCPActionOptions): IPhysicsEditorTarget {
	const ownedScene = options ? captureOwners.get(options.editor) : null;
	const capture = ownedScene ? captures.get(ownedScene) : null;
	if (ownedScene && capture) {
		const play = options?.editor.layout.preview?.play;
		return { scene: ownedScene, target: capture.target, play: capture.target === "play" && play?.canPlayScene && play.scene === ownedScene ? play : null };
	}
	return resolvePhysicsEditorTarget(scene, options);
}

/** Creates scene-owned visualization state whose timers cannot outlive scene disposal. */
function visualization(scene: Scene): IPhysicsContactVisualization {
	let value = visualizations.get(scene);
	if (!value) {
		value = { enabled: false, normalScale: 100, pointSize: 12, lifetimeMs: 2000, overlays: new Map(), disposeObserver: null };
		visualizations.set(scene, value);
		value.disposeObserver = scene.onDisposeObservable.addOnce(() => {
			disposeContactOverlays(scene);
			visualizations.delete(scene);
		});
	}
	return value;
}

/** Disposes every transient overlay without creating replacement scene state. */
export function disposeContactOverlays(scene: Scene): void {
	const state = visualizations.get(scene);
	if (!state) {
		return;
	}
	for (const [mesh, timer] of state.overlays) {
		clearTimeout(timer);
		mesh.dispose(false, true);
	}
	state.overlays.clear();
}

/** Builds one non-pickable, non-serialized contact cross for capture or history replay ownership. */
export function createPhysicsContactOverlay(
	scene: Scene,
	event: Pick<IPhysicsContactEvent, "point" | "normal"> | any,
	settings?: { normalScale?: number; pointSize?: number }
): LinesMesh | null {
	if (!event.point) {
		return null;
	}
	const current = visualization(scene);
	const point = event.point.clone?.() ?? Vector3.FromArray(event.point.asArray?.() ?? event.point);
	const normal = event.normal ? (event.normal.clone?.() ?? Vector3.FromArray(event.normal.asArray?.() ?? event.normal)).normalize() : Vector3.Up();
	const size = settings?.pointSize ?? current.pointSize;
	const lines = [
		[point.add(new Vector3(-size, 0, 0)), point.add(new Vector3(size, 0, 0))],
		[point.add(new Vector3(0, -size, 0)), point.add(new Vector3(0, size, 0))],
		[point.add(new Vector3(0, 0, -size)), point.add(new Vector3(0, 0, size))],
		[point, point.add(normal.scale(settings?.normalScale ?? current.normalScale))],
	];
	const cross = new Color4(1, 0.75, 0, 1);
	const normalColor = new Color4(1, 0.15, 0.1, 1);
	const mesh = MeshBuilder.CreateLineSystem(
		"Physics Contact Debug",
		{
			lines,
			colors: [
				[cross, cross],
				[cross, cross],
				[cross, cross],
				[normalColor, normalColor],
			],
			useVertexAlpha: false,
		},
		scene
	);
	mesh.isPickable = false;
	mesh.alwaysSelectAsActiveMesh = true;
	mesh.renderingGroupId = 3;
	setNodeSerializable(mesh, false);
	setNodeVisibleInGraph(mesh, false);
	return mesh;
}

/** Adds a lifetime-bounded live overlay while replay overlays retain separate ownership. */
function visualizeContact(scene: Scene, event: any): void {
	const state = visualization(scene);
	if (!state.enabled) {
		return;
	}
	const mesh = createPhysicsContactOverlay(scene, event);
	if (!mesh) {
		return;
	}
	const timer = setTimeout(() => {
		state.overlays.delete(mesh);
		mesh.dispose(false, true);
	}, state.lifetimeMs);
	state.overlays.set(mesh, timer);
}

/** Copies only finite XYZ components so engine-owned vectors never leak into persisted snapshots. */
function vectorArray(value: any): [number, number, number] | null {
	const array = value?.asArray?.() ?? value;
	return Array.isArray(array) && array.length >= 3 && array.slice(0, 3).every(Number.isFinite) ? [array[0], array[1], array[2]] : null;
}

/** Converts engine callbacks into the closed detached event shape used by saved histories. */
function serializeContact(event: any, elapsedMs: number, sequence: number): IPhysicsContactEvent {
	const collider = event.collider?.transformNode;
	const collidedAgainst = event.collidedAgainst?.transformNode;
	return {
		sequence,
		elapsedMs: Math.round(elapsedMs * 1000) / 1000,
		type: event.type,
		colliderNodeId: collider?.id ?? null,
		colliderName: collider?.name ?? null,
		colliderIndex: Number.isInteger(event.colliderIndex) ? event.colliderIndex : 0,
		collidedAgainstNodeId: collidedAgainst?.id ?? null,
		collidedAgainstName: collidedAgainst?.name ?? null,
		collidedAgainstIndex: Number.isInteger(event.collidedAgainstIndex) ? event.collidedAgainstIndex : 0,
		point: vectorArray(event.point),
		normal: vectorArray(event.normal),
		distance: Number.isFinite(event.distance) ? event.distance : null,
		impulse: Number.isFinite(event.impulse) ? event.impulse : null,
	};
}

/** Releases an observer and restores every body even if one body rejects restoration. */
function releaseCapture(scene: Scene, state: IPhysicsContactCapture, suppressErrors: boolean, removeDisposeObserver = true): void {
	const errors: string[] = [];
	try {
		if (state.observer) {
			state.observable.remove(state.observer);
		}
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (removeDisposeObserver && state.disposeObserver) {
		scene.onDisposeObservable.remove(state.disposeObserver);
	}
	for (const [body, enabled] of state.previousCallbackStates) {
		try {
			body.setCollisionCallbackEnabled(enabled);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	disposeContactOverlays(scene);
	captures.delete(scene);
	if (state.owner && captureOwners.get(state.owner) === scene) {
		captureOwners.delete(state.owner);
	}
	if (errors.length && !suppressErrors) {
		throw new Error(`Physics contact capture cleanup failed: ${errors.join(" ")}`);
	}
}

/** Starts one atomic, target-aware contact capture and rolls callback changes back if setup fails. */
export function startPhysicsContactCapture(scene: Scene, data: any, options: IMCPActionOptions): any {
	const owner = options?.editor ?? null;
	const ownedScene = owner ? captureOwners.get(owner) : null;
	if (ownedScene && captures.has(ownedScene)) {
		throw new Error("A physics contact capture is already active. Stop it before starting another capture.");
	}
	const target = resolvePhysicsEditorTarget(scene, options);
	if (captures.has(target.scene)) {
		throw new Error("A physics contact capture is already active. Stop it before starting another capture.");
	}
	const maxEvents = data.maxEvents ?? 256;
	if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) {
		throw new Error("maxEvents must be an integer from 1 through 1000.");
	}
	if (data.includeContinued !== undefined && typeof data.includeContinued !== "boolean") {
		throw new Error("includeContinued must be a boolean.");
	}
	const engine = target.scene.getPhysicsEngine() as any;
	const observable = engine?.getPhysicsPlugin?.()?.onCollisionObservable;
	if (!observable?.add) {
		throw new Error("The active physics plugin does not expose collision contact events.");
	}
	const state: IPhysicsContactCapture = {
		target: target.target,
		startedAt: performance.now(),
		maxEvents,
		includeContinued: data.includeContinued ?? false,
		events: [],
		droppedEvents: 0,
		nextSequence: 0,
		observer: null,
		disposeObserver: null,
		observable,
		previousCallbackStates: new Map(),
		owner,
	};
	try {
		for (const mesh of target.scene.meshes) {
			const body = mesh.physicsAggregate?.body as any;
			if (!body?.setCollisionCallbackEnabled || state.previousCallbackStates.has(body)) {
				continue;
			}
			state.previousCallbackStates.set(body, body._collisionCBEnabled === true);
			body.setCollisionCallbackEnabled(true);
		}
		state.observer = observable.add((event: any) => {
			if (!physicsContactEventTypes.includes(event.type) || (!state.includeContinued && event.type === "COLLISION_CONTINUED")) {
				return;
			}
			if (state.events.length >= state.maxEvents) {
				state.events.shift();
				state.droppedEvents++;
			}
			state.events.push(serializeContact(event, performance.now() - state.startedAt, state.nextSequence++));
			visualizeContact(target.scene, event);
		});
		state.disposeObserver = target.scene.onDisposeObservable.addOnce(() => releaseCapture(target.scene, state, true, false));
		captures.set(target.scene, state);
		if (owner) {
			captureOwners.set(owner, target.scene);
		}
	} catch (error) {
		releaseCapture(target.scene, state, true);
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	return { target: target.target, active: true, maxEvents, includeContinued: state.includeContinued, capturedBodyCount: state.previousCallbackStates.size };
}

/** Reads the active capture without losing its owner when the editor changes Play state. */
export function getPhysicsContactCapture(scene: Scene, _data?: any, options?: IMCPActionOptions): any {
	const target = resolveContactTarget(scene, options);
	const state = captures.get(target.scene);
	if (!state) {
		return { target: target.target, active: false, eventCount: 0, droppedEvents: 0, events: [], visualization: getPhysicsContactVisualization(scene, {}, options) };
	}
	return {
		target: target.target,
		active: true,
		maxEvents: state.maxEvents,
		includeContinued: state.includeContinued,
		elapsedMs: Math.round((performance.now() - state.startedAt) * 1000) / 1000,
		eventCount: state.events.length,
		droppedEvents: state.droppedEvents,
		capturedBodyCount: state.previousCallbackStates.size,
		events: structuredClone(state.events),
		visualization: getPhysicsContactVisualization(scene, {}, options),
	};
}

/** Reads detached events for an already resolved scene without creating visualization state or changing target ownership. */
export function getPhysicsContactEventsForScene(scene: Scene): IPhysicsContactEvent[] {
	return structuredClone(captures.get(scene)?.events ?? []);
}

/** Reads visualization settings from the same scene that owns the current capture. */
export function getPhysicsContactVisualization(scene: Scene, _data?: any, options?: IMCPActionOptions): any {
	const target = resolveContactTarget(scene, options);
	const state = visualization(target.scene);
	return {
		target: target.target,
		enabled: state.enabled,
		normalScale: state.normalScale,
		pointSize: state.pointSize,
		lifetimeMs: state.lifetimeMs,
		activeOverlayCount: state.overlays.size,
	};
}

/** Applies validated visualization settings to the exact scene that owns the current capture. */
export function setPhysicsContactVisualization(scene: Scene, data: any, options: IMCPActionOptions): any {
	const target = resolveContactTarget(scene, options);
	const state = visualization(target.scene);
	if (data.normalScale !== undefined && (!Number.isFinite(data.normalScale) || data.normalScale < 1 || data.normalScale > 10000)) {
		throw new Error("normalScale must be from 1 through 10000 editor centimeters.");
	}
	if (data.pointSize !== undefined && (!Number.isFinite(data.pointSize) || data.pointSize < 1 || data.pointSize > 1000)) {
		throw new Error("pointSize must be from 1 through 1000 editor centimeters.");
	}
	if (data.lifetimeMs !== undefined && (!Number.isFinite(data.lifetimeMs) || data.lifetimeMs < 50 || data.lifetimeMs > 60000)) {
		throw new Error("lifetimeMs must be from 50 through 60000 milliseconds.");
	}
	if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
		throw new Error("enabled must be a boolean.");
	}
	if (data.clear !== undefined && typeof data.clear !== "boolean") {
		throw new Error("clear must be a boolean.");
	}
	if (data.normalScale !== undefined) {
		state.normalScale = data.normalScale;
	}
	if (data.pointSize !== undefined) {
		state.pointSize = data.pointSize;
	}
	if (data.lifetimeMs !== undefined) {
		state.lifetimeMs = data.lifetimeMs;
	}
	if (data.enabled !== undefined) {
		state.enabled = data.enabled;
	}
	if (!state.enabled || data.clear === true) {
		disposeContactOverlays(target.scene);
	}
	options.editor.layout.inspector.forceUpdate();
	return getPhysicsContactVisualization(scene, {}, options);
}

/** Clears only the active target's rolling buffer while preserving capture ownership and callbacks. */
export function clearPhysicsContactCapture(scene: Scene, _data?: any, options?: IMCPActionOptions): any {
	const target = resolveContactTarget(scene, options);
	const state = captures.get(target.scene);
	if (!state) {
		throw new Error("No physics contact capture is active.");
	}
	state.events.length = 0;
	state.droppedEvents = 0;
	disposeContactOverlays(target.scene);
	return { target: target.target, cleared: true, active: true };
}

/** Stops the owner capture, returns its final detached snapshot, and restores callback state exactly once. */
export function stopPhysicsContactCapture(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const target = resolveContactTarget(scene, options);
	const state = captures.get(target.scene);
	if (!state) {
		throw new Error("No physics contact capture is active.");
	}
	const result = getPhysicsContactCapture(scene, {}, options);
	releaseCapture(target.scene, state, false);
	options.editor.layout.inspector.forceUpdate();
	return { ...result, target: target.target, active: false, stopped: true };
}

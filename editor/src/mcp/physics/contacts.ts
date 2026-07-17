import { Color4, LinesMesh, MeshBuilder, Scene, Vector3 } from "babylonjs";

import { setNodeSerializable, setNodeVisibleInGraph } from "../../tools/node/metadata";

import { IMCPActionOptions } from "../action";

interface IPhysicsContactCapture {
	startedAt: number;
	maxEvents: number;
	includeContinued: boolean;
	events: any[];
	droppedEvents: number;
	observer: any;
	observable: any;
	previousCallbackStates: Map<any, boolean>;
}

const captures = new WeakMap<Scene, IPhysicsContactCapture>();
const visualizations = new WeakMap<
	Scene,
	{ enabled: boolean; normalScale: number; pointSize: number; lifetimeMs: number; overlays: Map<LinesMesh, ReturnType<typeof setTimeout>> }
>();

function visualization(scene: Scene): { enabled: boolean; normalScale: number; pointSize: number; lifetimeMs: number; overlays: Map<LinesMesh, ReturnType<typeof setTimeout>> } {
	let value = visualizations.get(scene);
	if (!value) {
		value = { enabled: false, normalScale: 100, pointSize: 12, lifetimeMs: 2000, overlays: new Map() };
		visualizations.set(scene, value);
	}
	return value;
}

function disposeContactOverlays(scene: Scene): void {
	const state = visualization(scene);
	for (const [mesh, timer] of state.overlays) {
		clearTimeout(timer);
		mesh.dispose(false, true);
	}
	state.overlays.clear();
}

function visualizeContact(scene: Scene, event: any): void {
	const state = visualization(scene);
	if (!state.enabled || !event.point) return;
	const point = event.point.clone?.() ?? Vector3.FromArray(event.point.asArray?.() ?? event.point);
	const normal = event.normal ? (event.normal.clone?.() ?? Vector3.FromArray(event.normal.asArray?.() ?? event.normal)).normalize() : Vector3.Up();
	const size = state.pointSize;
	const lines = [
		[point.add(new Vector3(-size, 0, 0)), point.add(new Vector3(size, 0, 0))],
		[point.add(new Vector3(0, -size, 0)), point.add(new Vector3(0, size, 0))],
		[point.add(new Vector3(0, 0, -size)), point.add(new Vector3(0, 0, size))],
		[point, point.add(normal.scale(state.normalScale))],
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
	const timer = setTimeout(() => {
		state.overlays.delete(mesh);
		mesh.dispose(false, true);
	}, state.lifetimeMs);
	state.overlays.set(mesh, timer);
}

function serializeContact(event: any, elapsedMs: number): any {
	const collider = event.collider?.transformNode;
	const collidedAgainst = event.collidedAgainst?.transformNode;
	return {
		elapsedMs: Math.round(elapsedMs * 1000) / 1000,
		type: event.type,
		colliderNodeId: collider?.id ?? null,
		colliderName: collider?.name ?? null,
		colliderIndex: event.colliderIndex ?? 0,
		collidedAgainstNodeId: collidedAgainst?.id ?? null,
		collidedAgainstName: collidedAgainst?.name ?? null,
		collidedAgainstIndex: event.collidedAgainstIndex ?? 0,
		point: event.point?.asArray?.() ?? null,
		normal: event.normal?.asArray?.() ?? null,
		distance: Number.isFinite(event.distance) ? event.distance : null,
		impulse: Number.isFinite(event.impulse) ? event.impulse : null,
	};
}

export function startPhysicsContactCapture(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (captures.has(scene)) throw new Error("A physics contact capture is already active. Stop it before starting another capture.");
	const engine = scene.getPhysicsEngine() as any;
	const observable = engine?.getPhysicsPlugin?.()?.onCollisionObservable;
	if (!observable?.add) throw new Error("The active physics plugin does not expose collision contact events.");
	const maxEvents = data.maxEvents ?? 256;
	if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new Error("maxEvents must be an integer from 1 through 1000.");
	const state: IPhysicsContactCapture = {
		startedAt: performance.now(),
		maxEvents,
		includeContinued: data.includeContinued ?? false,
		events: [],
		droppedEvents: 0,
		observer: null,
		observable,
		previousCallbackStates: new Map(),
	};
	for (const mesh of scene.meshes) {
		const body = mesh.physicsAggregate?.body as any;
		if (!body?.setCollisionCallbackEnabled || state.previousCallbackStates.has(body)) continue;
		state.previousCallbackStates.set(body, body._collisionCBEnabled === true);
		body.setCollisionCallbackEnabled(true);
	}
	state.observer = observable.add((event: any) => {
		if (!state.includeContinued && event.type === "COLLISION_CONTINUED") return;
		if (state.events.length >= state.maxEvents) {
			state.events.shift();
			state.droppedEvents++;
		}
		state.events.push(serializeContact(event, performance.now() - state.startedAt));
		visualizeContact(scene, event);
	});
	captures.set(scene, state);
	options.editor.layout.inspector.forceUpdate();
	return { active: true, maxEvents, includeContinued: state.includeContinued, capturedBodyCount: state.previousCallbackStates.size };
}

export function getPhysicsContactCapture(scene: Scene): any {
	const state = captures.get(scene);
	if (!state) return { active: false, eventCount: 0, droppedEvents: 0, events: [], visualization: getPhysicsContactVisualization(scene) };
	return {
		active: true,
		maxEvents: state.maxEvents,
		includeContinued: state.includeContinued,
		elapsedMs: Math.round((performance.now() - state.startedAt) * 1000) / 1000,
		eventCount: state.events.length,
		droppedEvents: state.droppedEvents,
		capturedBodyCount: state.previousCallbackStates.size,
		events: structuredClone(state.events),
		visualization: getPhysicsContactVisualization(scene),
	};
}

export function getPhysicsContactVisualization(scene: Scene): any {
	const state = visualization(scene);
	return { enabled: state.enabled, normalScale: state.normalScale, pointSize: state.pointSize, lifetimeMs: state.lifetimeMs, activeOverlayCount: state.overlays.size };
}

export function setPhysicsContactVisualization(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = visualization(scene);
	if (data.normalScale !== undefined && (!Number.isFinite(data.normalScale) || data.normalScale < 1 || data.normalScale > 10000))
		throw new Error("normalScale must be from 1 through 10000 editor centimeters.");
	if (data.pointSize !== undefined && (!Number.isFinite(data.pointSize) || data.pointSize < 1 || data.pointSize > 1000))
		throw new Error("pointSize must be from 1 through 1000 editor centimeters.");
	if (data.lifetimeMs !== undefined && (!Number.isFinite(data.lifetimeMs) || data.lifetimeMs < 50 || data.lifetimeMs > 60000))
		throw new Error("lifetimeMs must be from 50 through 60000 milliseconds.");
	if (data.normalScale !== undefined) state.normalScale = data.normalScale;
	if (data.pointSize !== undefined) state.pointSize = data.pointSize;
	if (data.lifetimeMs !== undefined) state.lifetimeMs = data.lifetimeMs;
	if (data.enabled !== undefined) state.enabled = data.enabled;
	if (!state.enabled || data.clear === true) disposeContactOverlays(scene);
	options.editor.layout.inspector.forceUpdate();
	return getPhysicsContactVisualization(scene);
}

export function clearPhysicsContactCapture(scene: Scene): any {
	const state = captures.get(scene);
	if (!state) throw new Error("No physics contact capture is active.");
	state.events.length = 0;
	state.droppedEvents = 0;
	disposeContactOverlays(scene);
	return { cleared: true, active: true };
}

export function stopPhysicsContactCapture(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const state = captures.get(scene);
	if (!state) throw new Error("No physics contact capture is active.");
	state.observable.remove(state.observer);
	for (const [body, enabled] of state.previousCallbackStates) body.setCollisionCallbackEnabled(enabled);
	const result = getPhysicsContactCapture(scene);
	disposeContactOverlays(scene);
	captures.delete(scene);
	options.editor.layout.inspector.forceUpdate();
	return { ...result, active: false, stopped: true };
}

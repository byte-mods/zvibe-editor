import { LinesMesh, Observer, Scene, Tools } from "babylonjs";

import { IMCPActionOptions } from "../action";
import {
	filterPhysicsContactHistoryEvents,
	IPhysicsContactHistoryFilter,
	summarizePhysicsContactHistoryEvents,
	validatePhysicsContactHistoryFilter,
} from "./contact-history-filters";
import { readPhysicsContactHistoryAsset } from "./contact-history-assets";
import { IPhysicsContactEvent, PhysicsContactTarget } from "./contact-history-types";
import { createPhysicsContactOverlay, getPhysicsContactCapture } from "./contacts";
import { IPhysicsEditorTarget, resolvePhysicsEditorTarget } from "./target";

const maximumReplayOverlays = 256;

interface IPhysicsContactHistoryReplay {
	sessionId: string;
	sessionRevision: number;
	target: PhysicsContactTarget;
	scene: Scene;
	owner: object | null;
	path: string;
	assetId: string;
	assetRevision: number;
	contentRevision: string;
	durationMs: number;
	filter: IPhysicsContactHistoryFilter;
	events: IPhysicsContactEvent[];
	cursorMs: number;
	selectedEventIndex: number;
	playing: boolean;
	loop: boolean;
	playbackRate: number;
	trailMs: number;
	normalScale: number;
	pointSize: number;
	overlays: Set<LinesMesh>;
	visibleEventCount: number;
	overlayTruncatedCount: number;
	visualizationKey: string;
	observer: Observer<Scene> | null;
	disposeObserver: Observer<Scene> | null;
	workspaceCleanup: (() => void) | null;
	forceUpdate: () => void;
	lastInspectorUpdate: number;
	renderFrame: number;
}

const replays = new WeakMap<Scene, IPhysicsContactHistoryReplay>();
const replayOwners = new WeakMap<object, Scene>();

/** Resolves an existing owner session before considering a newly ready Play/Edit target. */
function resolveReplayTarget(scene: Scene, options?: IMCPActionOptions): IPhysicsEditorTarget {
	const ownedScene = options ? replayOwners.get(options.editor) : null;
	const replay = ownedScene ? replays.get(ownedScene) : null;
	if (ownedScene && replay) {
		const play = options?.editor.layout.preview?.play;
		return { scene: ownedScene, target: replay.target, play: replay.target === "play" && play?.canPlayScene && play.scene === ownedScene ? play : null };
	}
	return resolvePhysicsEditorTarget(scene, options);
}

/** Returns the last filtered event at or before a cursor in O(log n), including equal-time events deterministically. */
function eventIndexAt(events: readonly IPhysicsContactEvent[], cursorMs: number): number {
	let low = 0;
	let high = events.length - 1;
	let result = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (events[middle].elapsedMs <= cursorMs) {
			result = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}

/** Clears only replay-owned meshes; live-capture timers and overlays remain independent. */
function disposeReplayOverlays(state: IPhysicsContactHistoryReplay): void {
	state.overlays.forEach((overlay) => overlay.dispose(false, true));
	state.overlays.clear();
	state.visibleEventCount = 0;
	state.overlayTruncatedCount = 0;
	state.visualizationKey = "";
}

/** Rebuilds a deterministic bounded trail only when its visible event sequence changes. */
function renderReplayOverlays(state: IPhysicsContactHistoryReplay): void {
	const minimum = Math.max(0, state.cursorMs - state.trailMs);
	const candidates = state.events.filter((event) => event.point && event.elapsedMs >= minimum && event.elapsedMs <= state.cursorMs);
	const visible = candidates.slice(-maximumReplayOverlays);
	const key = `${state.normalScale}:${state.pointSize}:${visible.map((event) => event.sequence).join(",")}`;
	state.visibleEventCount = candidates.length;
	state.overlayTruncatedCount = candidates.length - visible.length;
	if (key === state.visualizationKey) {
		return;
	}
	disposeReplayOverlays(state);
	for (const event of visible) {
		const overlay = createPhysicsContactOverlay(state.scene, event, { normalScale: state.normalScale, pointSize: state.pointSize });
		if (overlay) {
			overlay.name = "Physics Contact Replay";
			state.overlays.add(overlay);
		}
	}
	state.visibleEventCount = candidates.length;
	state.overlayTruncatedCount = candidates.length - visible.length;
	state.visualizationKey = key;
}

/** Releases observers, workspace subscription, and overlays exactly once on every stop path. */
function releaseReplay(state: IPhysicsContactHistoryReplay, removeDisposeObserver = true): void {
	if (state.observer) {
		state.scene.onBeforeRenderObservable.remove(state.observer);
		state.observer = null;
	}
	if (removeDisposeObserver && state.disposeObserver) {
		state.scene.onDisposeObservable.remove(state.disposeObserver);
	}
	state.disposeObserver = null;
	state.workspaceCleanup?.();
	state.workspaceCleanup = null;
	disposeReplayOverlays(state);
	replays.delete(state.scene);
	if (state.owner && replayOwners.get(state.owner) === state.scene) {
		replayOwners.delete(state.owner);
	}
}

/** Advances only replay state from bounded render delta; no physics API or callback observable is invoked. */
function advanceReplay(state: IPhysicsContactHistoryReplay): void {
	if (!state.playing) {
		return;
	}
	const deltaMs = Math.max(0, Math.min(state.scene.getEngine().getDeltaTime(), 1000)) * state.playbackRate;
	let next = state.cursorMs + deltaMs;
	if (next >= state.durationMs) {
		if (state.loop && state.durationMs > 0) {
			next %= state.durationMs;
		} else {
			next = state.durationMs;
			state.playing = false;
		}
	}
	state.cursorMs = next;
	state.selectedEventIndex = eventIndexAt(state.events, next);
	state.renderFrame++;
	renderReplayOverlays(state);
	const now = performance.now();
	if (!state.playing || now - state.lastInspectorUpdate >= 100) {
		state.lastInspectorUpdate = now;
		state.forceUpdate();
	}
}

/** Produces detached replay evidence and explicitly denies simulation/callback execution. */
function status(state: IPhysicsContactHistoryReplay): any {
	const selected = state.events[state.selectedEventIndex] ?? null;
	return {
		target: state.target,
		active: true,
		sessionId: state.sessionId,
		sessionRevision: state.sessionRevision,
		path: state.path,
		assetId: state.assetId,
		assetRevision: state.assetRevision,
		contentRevision: state.contentRevision,
		durationMs: state.durationMs,
		cursorMs: state.cursorMs,
		playing: state.playing,
		loop: state.loop,
		playbackRate: state.playbackRate,
		trailMs: state.trailMs,
		normalScale: state.normalScale,
		pointSize: state.pointSize,
		filter: structuredClone(state.filter),
		filteredSummary: summarizePhysicsContactHistoryEvents(state.events),
		selectedEventIndex: state.selectedEventIndex,
		selectedEvent: selected ? structuredClone(selected) : null,
		visibleEventCount: state.visibleEventCount,
		activeOverlayCount: state.overlays.size,
		overlayTruncatedCount: state.overlayTruncatedCount,
		renderFrame: state.renderFrame,
		physicsAdvanced: false,
		callbacksReexecuted: false,
	};
}

function setting(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
	const result = value ?? fallback;
	if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || result > maximum) {
		throw new Error(`${name} must be from ${minimum} through ${maximum}.`);
	}
	return result;
}

/** Starts one exact-revision replay on ready Play or Edit after proving capture ownership is inactive. */
export async function startPhysicsContactHistoryReplay(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const owner = options.editor;
	const ownedScene = replayOwners.get(owner);
	if ((ownedScene && replays.has(ownedScene)) || replays.has(resolvePhysicsEditorTarget(scene, options).scene)) {
		throw new Error("A physics contact history replay is already active. Stop it before starting another replay.");
	}
	if (getPhysicsContactCapture(scene, {}, options).active) {
		throw new Error("Stop the active physics contact capture before starting history replay so overlay ownership stays unambiguous.");
	}
	const target = resolvePhysicsEditorTarget(scene, options);
	const value = await readPhysicsContactHistoryAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Physics contact history revision is stale. Expected ${value.contentRevision}.`);
	}
	const filter = validatePhysicsContactHistoryFilter(data.filter ?? {}, value.asset.durationMs);
	const events = filterPhysicsContactHistoryEvents(value.asset.events, filter);
	const cursorMs = setting(data.cursorMs, "cursorMs", 0, value.asset.durationMs, 0);
	const state: IPhysicsContactHistoryReplay = {
		sessionId: Tools.RandomId(),
		sessionRevision: 1,
		target: target.target,
		scene: target.scene,
		owner,
		path: value.relativePath,
		assetId: value.asset.id,
		assetRevision: value.asset.revision,
		contentRevision: value.contentRevision,
		durationMs: value.asset.durationMs,
		filter,
		events,
		cursorMs,
		selectedEventIndex: eventIndexAt(events, cursorMs),
		playing: data.playing ?? false,
		loop: data.loop ?? false,
		playbackRate: setting(data.playbackRate, "playbackRate", 0.1, 10, 1),
		trailMs: setting(data.trailMs, "trailMs", 0, 60000, 250),
		normalScale: setting(data.normalScale, "normalScale", 1, 10000, 100),
		pointSize: setting(data.pointSize, "pointSize", 1, 1000, 12),
		overlays: new Set(),
		visibleEventCount: 0,
		overlayTruncatedCount: 0,
		visualizationKey: "",
		observer: null,
		disposeObserver: null,
		workspaceCleanup: null,
		forceUpdate: () => options.editor.layout.inspector.forceUpdate(),
		lastInspectorUpdate: 0,
		renderFrame: 0,
	};
	if (typeof state.playing !== "boolean" || typeof state.loop !== "boolean") {
		throw new Error("playing and loop must be booleans.");
	}
	state.playing &&= state.durationMs > 0;
	state.observer = target.scene.onBeforeRenderObservable.add(() => advanceReplay(state));
	state.disposeObserver = target.scene.onDisposeObservable.addOnce(() => releaseReplay(state, false));
	const activeScene = options.editor.sceneWorkspace?.getSettings().activeScene ?? null;
	if (activeScene && options.editor.sceneWorkspace?.subscribe) {
		state.workspaceCleanup = options.editor.sceneWorkspace.subscribe(() => {
			if (options.editor.sceneWorkspace.getSettings().activeScene !== activeScene && replays.get(state.scene) === state) {
				releaseReplay(state);
				state.forceUpdate();
			}
		});
	}
	replays.set(target.scene, state);
	replayOwners.set(owner, target.scene);
	renderReplayOverlays(state);
	state.forceUpdate();
	return { started: true, ...status(state) };
}

/** Reads an owner-stable replay even if Play readiness changes after start. */
export function getPhysicsContactHistoryReplay(scene: Scene, _data?: any, options?: IMCPActionOptions): any {
	const target = resolveReplayTarget(scene, options);
	const state = replays.get(target.scene);
	return state ? status(state) : { target: target.target, active: false, physicsAdvanced: false, callbacksReexecuted: false };
}

/** Applies one exact-leased replay command without touching live physics or replaying callbacks. */
export function controlPhysicsContactHistoryReplay(scene: Scene, data: any, options: IMCPActionOptions): any {
	const target = resolveReplayTarget(scene, options);
	const state = replays.get(target.scene);
	if (!state) {
		throw new Error("No physics contact history replay is active.");
	}
	if (data.sessionId !== state.sessionId || data.expectedSessionRevision !== state.sessionRevision) {
		throw new Error(`Physics contact replay session is stale. Expected sessionId ${state.sessionId} and sessionRevision ${state.sessionRevision}.`);
	}
	if (!["play", "pause", "seek", "step", "configure", "stop"].includes(data.command)) {
		throw new Error("Replay command must be play, pause, seek, step, configure, or stop.");
	}
	let cursorMs = state.cursorMs;
	let selectedEventIndex = state.selectedEventIndex;
	let playing = state.playing;
	let loop = state.loop;
	let playbackRate = state.playbackRate;
	let trailMs = state.trailMs;
	let normalScale = state.normalScale;
	let pointSize = state.pointSize;
	let invalidateVisualization = false;
	if (data.command === "play") {
		if (cursorMs >= state.durationMs && !loop) {
			cursorMs = 0;
			selectedEventIndex = eventIndexAt(state.events, 0);
		}
		playing = state.durationMs > 0;
	} else if (data.command === "pause") {
		playing = false;
	} else if (data.command === "seek") {
		if (data.cursorMs === undefined) {
			throw new Error("seek requires cursorMs.");
		}
		cursorMs = setting(data.cursorMs, "cursorMs", 0, state.durationMs, state.cursorMs);
		selectedEventIndex = eventIndexAt(state.events, cursorMs);
	} else if (data.command === "step") {
		if (playing) {
			throw new Error("Pause replay before stepping through contact events.");
		}
		if (!state.events.length) {
			throw new Error("The current replay filter contains no events to step through.");
		}
		const delta = data.eventDelta ?? 1;
		if (!Number.isInteger(delta) || delta === 0 || delta < -100 || delta > 100) {
			throw new Error("eventDelta must be a non-zero integer from -100 through 100.");
		}
		selectedEventIndex = Math.max(0, Math.min(state.events.length - 1, selectedEventIndex + delta));
		cursorMs = state.events[selectedEventIndex].elapsedMs;
	} else if (data.command === "configure") {
		if ([data.playbackRate, data.trailMs, data.normalScale, data.pointSize, data.loop].every((value) => value === undefined)) {
			throw new Error("configure requires at least one replay setting.");
		}
		playbackRate = setting(data.playbackRate, "playbackRate", 0.1, 10, playbackRate);
		trailMs = setting(data.trailMs, "trailMs", 0, 60000, trailMs);
		normalScale = setting(data.normalScale, "normalScale", 1, 10000, normalScale);
		pointSize = setting(data.pointSize, "pointSize", 1, 1000, pointSize);
		if (data.loop !== undefined) {
			if (typeof data.loop !== "boolean") {
				throw new Error("loop must be a boolean.");
			}
			loop = data.loop;
		}
		invalidateVisualization = true;
	}
	state.sessionRevision++;
	if (data.command === "stop") {
		const result = status(state);
		releaseReplay(state);
		state.forceUpdate();
		return { ...result, active: false, playing: false, stopped: true };
	}
	state.cursorMs = cursorMs;
	state.selectedEventIndex = selectedEventIndex;
	state.playing = playing;
	state.loop = loop;
	state.playbackRate = playbackRate;
	state.trailMs = trailMs;
	state.normalScale = normalScale;
	state.pointSize = pointSize;
	if (invalidateVisualization) {
		state.visualizationKey = "";
	}
	renderReplayOverlays(state);
	state.forceUpdate();
	return { command: data.command, ...status(state) };
}

/** Stops a matching replay before its immutable source asset is removed. */
export function stopPhysicsContactHistoryReplayForAsset(scene: Scene, path: string, options: IMCPActionOptions): boolean {
	const target = resolveReplayTarget(scene, options);
	const state = replays.get(target.scene);
	if (!state || state.path !== path) {
		return false;
	}
	releaseReplay(state);
	state.forceUpdate();
	return true;
}

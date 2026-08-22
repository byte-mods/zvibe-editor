import { LinesMesh, Observer, Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { createPhysicsForceBodySamplingState, IPhysicsForceBodySamplingState, samplePhysicsBodyNetForces } from "./force-body-vectors";
import { collectPhysicsForceVectors, IPhysicsForceVectorQuery } from "./force-vector-collector";
import { createPhysicsForceVectorOverlay } from "./force-vector-renderer";
import {
	defaultPhysicsForceVisualizationSettings,
	IPhysicsForceVisualizationSettings,
	isPhysicsForceVectorCategory,
	PhysicsForceVectorCategory,
} from "./force-visualization-types";
import { IPhysicsEditorTarget, resolvePhysicsEditorTarget } from "./target";

interface IPhysicsForceVisualizationState {
	scene: Scene;
	target: "editor" | "play";
	owner: object | null;
	revision: number;
	enabled: boolean;
	settings: IPhysicsForceVisualizationSettings;
	sampling: IPhysicsForceBodySamplingState;
	overlay: LinesMesh | null;
	renderObserver: Observer<Scene> | null;
	physicsObserver: Observer<Scene> | null;
	disposeObserver: Observer<Scene> | null;
	workspaceCleanup: (() => void) | null;
	forceUpdate: () => void;
	lastRefreshTime: number;
	lastRefreshAt: number | null;
	lastInspectorUpdate: number;
	refreshCount: number;
	renderedVectorCount: number;
	renderedLineCount: number;
	lastError: { message: string; timestamp: number } | null;
}

const states = new WeakMap<Scene, IPhysicsForceVisualizationState>();
const owners = new WeakMap<object, Scene>();

function cloneSettings(settings: IPhysicsForceVisualizationSettings): IPhysicsForceVisualizationSettings {
	return { ...settings, categories: [...settings.categories], bodyNodeIds: [...settings.bodyNodeIds] };
}

/** Resolves an enabled owner-stable visualization before following a changed Play/Edit target. */
function resolveVisualizationTarget(scene: Scene, options?: IMCPActionOptions): IPhysicsEditorTarget {
	const ownedScene = options ? owners.get(options.editor) : null;
	const ownedState = ownedScene ? states.get(ownedScene) : null;
	if (ownedScene && ownedState?.enabled) {
		const play = options?.editor.layout.preview?.play;
		return { scene: ownedScene, target: ownedState.target, play: ownedState.target === "play" && play?.canPlayScene && play.scene === ownedScene ? play : null };
	}
	return resolvePhysicsEditorTarget(scene, options);
}

function disposeOverlay(state: IPhysicsForceVisualizationState): void {
	state.overlay?.dispose(false, true);
	state.overlay = null;
	state.renderedVectorCount = 0;
	state.renderedLineCount = 0;
}

/** Keeps an unmounting Inspector from turning successful diagnostic cleanup into a renderer exception. */
function requestInspectorUpdate(state: IPhysicsForceVisualizationState): void {
	try {
		state.forceUpdate();
	} catch (error) {
		state.lastError ??= { message: `Inspector refresh failed: ${error instanceof Error ? error.message : String(error)}`, timestamp: Date.now() };
	}
}

/** Releases runtime ownership while preserving revisioned settings for later re-enablement. */
function detachVisualization(state: IPhysicsForceVisualizationState): void {
	if (state.renderObserver) {
		state.scene.onBeforeRenderObservable.remove(state.renderObserver);
		state.renderObserver = null;
	}
	if (state.physicsObserver) {
		(state.scene as any).onAfterPhysicsObservable?.remove(state.physicsObserver);
		state.physicsObserver = null;
	}
	state.workspaceCleanup?.();
	state.workspaceCleanup = null;
	disposeOverlay(state);
	state.sampling = createPhysicsForceBodySamplingState();
	state.enabled = false;
	if (state.owner && owners.get(state.owner) === state.scene) {
		owners.delete(state.owner);
	}
}

/** Disposes scene-local state without retaining a dead Play or Edit scene as an owner target. */
function disposeState(state: IPhysicsForceVisualizationState, removeDisposeObserver: boolean): void {
	detachVisualization(state);
	if (removeDisposeObserver && state.disposeObserver) {
		state.scene.onDisposeObservable.remove(state.disposeObserver);
	}
	state.disposeObserver = null;
	states.delete(state.scene);
}

function visualizationState(target: IPhysicsEditorTarget, options?: IMCPActionOptions): IPhysicsForceVisualizationState {
	let state = states.get(target.scene);
	if (!state) {
		state = {
			scene: target.scene,
			target: target.target,
			owner: options?.editor ?? null,
			revision: 1,
			enabled: false,
			settings: cloneSettings(defaultPhysicsForceVisualizationSettings),
			sampling: createPhysicsForceBodySamplingState(),
			overlay: null,
			renderObserver: null,
			physicsObserver: null,
			disposeObserver: null,
			workspaceCleanup: null,
			forceUpdate: () => options?.editor.layout.inspector.forceUpdate(),
			lastRefreshTime: 0,
			lastRefreshAt: null,
			lastInspectorUpdate: 0,
			refreshCount: 0,
			renderedVectorCount: 0,
			renderedLineCount: 0,
			lastError: null,
		};
		states.set(target.scene, state);
		state.disposeObserver = target.scene.onDisposeObservable.addOnce(() => disposeState(state!, false));
	} else if (options) {
		state.owner ??= options.editor;
		state.forceUpdate = () => options.editor.layout.inspector.forceUpdate();
	}
	return state;
}

function finiteSetting(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
	const result = value ?? fallback;
	if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || result > maximum) {
		throw new Error(`${name} must be from ${minimum} through ${maximum}.`);
	}
	return result;
}

function integerSetting(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || (result as number) < minimum || (result as number) > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
	}
	return result as number;
}

function categories(value: unknown, fallback: readonly PhysicsForceVectorCategory[]): PhysicsForceVectorCategory[] {
	if (value === undefined) {
		return [...fallback];
	}
	if (!Array.isArray(value) || value.length < 1 || value.length > 8 || !value.every(isPhysicsForceVectorCategory) || new Set(value).size !== value.length) {
		throw new Error("categories must contain 1 through 8 unique supported force-vector categories.");
	}
	return [...value];
}

function bodyNodeIds(value: unknown, fallback: readonly string[]): string[] {
	if (value === undefined) {
		return [...fallback];
	}
	if (
		!Array.isArray(value) ||
		value.length > 64 ||
		!value.every((id) => typeof id === "string" && id === id.trim() && id.length >= 1 && id.length <= 256) ||
		new Set(value).size !== value.length
	) {
		throw new Error("bodyNodeIds must contain at most 64 unique non-empty trimmed node ids of at most 256 characters.");
	}
	return [...value];
}

function validateQuery(data: any): IPhysicsForceVectorQuery {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Physics force visualization query must be an object.");
	}
	const allowed = new Set(["endpoint", "collaborationToken", "categories", "bodyNodeIds", "offset", "limit"]);
	const unknown = Object.keys(data).filter((key) => !allowed.has(key));
	if (unknown.length) {
		throw new Error(`Unknown physics force visualization query field: ${unknown[0]}.`);
	}
	return {
		categories: data.categories === undefined ? undefined : categories(data.categories, []),
		bodyNodeIds: data.bodyNodeIds === undefined ? undefined : bodyNodeIds(data.bodyNodeIds, []),
		offset: data.offset === undefined ? undefined : integerSetting(data.offset, "offset", 0, 1_000_000, 0),
		limit: data.limit === undefined ? undefined : integerSetting(data.limit, "limit", 1, 100, 50),
	};
}

function validateUpdate(data: any, state: IPhysicsForceVisualizationState): { settings: IPhysicsForceVisualizationSettings; enabled: boolean; clear: boolean } {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Physics force visualization update must be an object.");
	}
	const settingNames = [
		"categories",
		"bodyNodeIds",
		"maximumVectors",
		"refreshIntervalMs",
		"forceScale",
		"impulseScale",
		"velocityScale",
		"angularVelocityScale",
		"directionScale",
		"separationScale",
		"pointSize",
	] as const;
	const allowed = new Set(["endpoint", "collaborationToken", "expectedRevision", "enabled", "clear", ...settingNames]);
	const unknown = Object.keys(data).filter((key) => !allowed.has(key));
	if (unknown.length) {
		throw new Error(`Unknown physics force visualization update field: ${unknown[0]}.`);
	}
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 1 || data.expectedRevision !== state.revision) {
		throw new Error(`Physics force visualization revision is stale. Expected ${state.revision}.`);
	}
	if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
		throw new Error("enabled must be a boolean.");
	}
	if (data.clear !== undefined && typeof data.clear !== "boolean") {
		throw new Error("clear must be a boolean.");
	}
	if (![data.enabled, data.clear, ...settingNames.map((name) => data[name])].some((value) => value !== undefined)) {
		throw new Error("Provide enabled, clear, or at least one visualization setting to update.");
	}
	const current = state.settings;
	return {
		enabled: data.enabled ?? state.enabled,
		clear: data.clear ?? false,
		settings: {
			categories: categories(data.categories, current.categories),
			bodyNodeIds: bodyNodeIds(data.bodyNodeIds, current.bodyNodeIds),
			maximumVectors: integerSetting(data.maximumVectors, "maximumVectors", 1, 512, current.maximumVectors),
			refreshIntervalMs: integerSetting(data.refreshIntervalMs, "refreshIntervalMs", 16, 2000, current.refreshIntervalMs),
			forceScale: finiteSetting(data.forceScale, "forceScale", 0.0001, 1000, current.forceScale),
			impulseScale: finiteSetting(data.impulseScale, "impulseScale", 0.0001, 10_000, current.impulseScale),
			velocityScale: finiteSetting(data.velocityScale, "velocityScale", 0.0001, 1000, current.velocityScale),
			angularVelocityScale: finiteSetting(data.angularVelocityScale, "angularVelocityScale", 0.0001, 10_000, current.angularVelocityScale),
			directionScale: finiteSetting(data.directionScale, "directionScale", 1, 10_000, current.directionScale),
			separationScale: finiteSetting(data.separationScale, "separationScale", 0.0001, 1000, current.separationScale),
			pointSize: finiteSetting(data.pointSize, "pointSize", 1, 1000, current.pointSize),
		},
	};
}

/** Builds and atomically swaps one snapshot overlay; a failed rebuild retains the last good overlay. */
function refreshVisualization(state: IPhysicsForceVisualizationState, forceInspectorUpdate: boolean): void {
	const snapshot = collectPhysicsForceVectors(state.scene, state.sampling, state.settings, { offset: 0, limit: 100 });
	const nextOverlay = createPhysicsForceVectorOverlay(state.scene, snapshot.displayedVectors, state.settings);
	const previous = state.overlay;
	state.overlay = nextOverlay;
	state.renderedVectorCount = snapshot.visibleVectorCount;
	state.renderedLineCount = nextOverlay ? nextOverlay.getTotalVertices() / 2 : 0;
	state.lastRefreshTime = performance.now();
	state.lastRefreshAt = Date.now();
	state.refreshCount++;
	state.lastError = null;
	previous?.dispose(false, true);
	const now = performance.now();
	if (forceInspectorUpdate || now - state.lastInspectorUpdate >= 100) {
		state.lastInspectorUpdate = now;
		requestInspectorUpdate(state);
	}
}

/** Refreshes on a bounded render cadence and contains renderer errors inside diagnostic state. */
function updateVisualization(state: IPhysicsForceVisualizationState): void {
	if (performance.now() - state.lastRefreshTime < state.settings.refreshIntervalMs) {
		return;
	}
	try {
		refreshVisualization(state, false);
	} catch (error) {
		state.lastError = { message: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
		requestInspectorUpdate(state);
	}
}

/** Attaches post-physics sampling and pre-render drawing without invoking a physics step or body setter. */
function attachVisualization(state: IPhysicsForceVisualizationState, options: IMCPActionOptions): void {
	const afterPhysicsObservable = (state.scene as any).onAfterPhysicsObservable;
	state.physicsObserver = afterPhysicsObservable?.add ? afterPhysicsObservable.add(() => samplePhysicsBodyNetForces(state.scene, state.sampling)) : null;
	state.renderObserver = state.scene.onBeforeRenderObservable.add(() => updateVisualization(state));
	const activeScene = options.editor.sceneWorkspace?.getSettings().activeScene ?? null;
	if (activeScene && options.editor.sceneWorkspace?.subscribe) {
		state.workspaceCleanup = options.editor.sceneWorkspace.subscribe(() => {
			if (options.editor.sceneWorkspace.getSettings().activeScene !== activeScene && states.get(state.scene) === state) {
				disposeState(state, true);
				requestInspectorUpdate(state);
			}
		});
	}
}

function status(state: IPhysicsForceVisualizationState, query: IPhysicsForceVectorQuery): any {
	const snapshot = collectPhysicsForceVectors(state.scene, state.sampling, state.settings, query);
	return {
		target: state.target,
		revision: state.revision,
		enabled: state.enabled,
		settings: cloneSettings(state.settings),
		vectors: snapshot.vectors,
		page: snapshot.page,
		availableVectorCount: snapshot.availableVectorCount,
		truncatedVectorCount: snapshot.truncatedVectorCount,
		visibleVectorCount: snapshot.visibleVectorCount,
		categoryCounts: snapshot.categoryCounts,
		renderedVectorCount: state.renderedVectorCount,
		renderedLineCount: state.renderedLineCount,
		activeOverlayCount: state.overlay ? 1 : 0,
		refreshCount: state.refreshCount,
		lastRefreshAt: state.lastRefreshAt,
		sampling: {
			sampleCount: state.sampling.sampleCount,
			lastDeltaSeconds: state.sampling.lastDeltaSeconds,
			derivedNetForceCount: state.sampling.netForces.size,
		},
		lastError: state.lastError ? { ...state.lastError } : null,
		physicsAdvanced: false,
		bodiesMutated: false,
		originalAppliedForcesAvailable: false,
		constraintReactionForcesAvailable: false,
		limitations: [
			"Net force is derived from completed linear-velocity samples as mass × delta velocity / delta time.",
			"Contact vectors require an active physics contact capture because the engine does not retain historical contacts.",
			"The engine does not expose original applied-force commands or constraint reaction forces for retrieval.",
		],
	};
}

/** Reads one detached, filtered, paginated evidence snapshot without advancing or mutating physics. */
export function getPhysicsForceVisualization(scene: Scene, data: any = {}, options?: IMCPActionOptions): any {
	const query = validateQuery(data);
	const target = resolveVisualizationTarget(scene, options);
	return status(visualizationState(target, options), query);
}

/** Applies one exact-revision settings/enablement update atomically, then returns the same read model. */
export function setPhysicsForceVisualization(scene: Scene, data: any, options: IMCPActionOptions): any {
	const target = resolveVisualizationTarget(scene, options);
	const state = visualizationState(target, options);
	const update = validateUpdate(data, state);
	const wasEnabled = state.enabled;
	const previousSettings = state.settings;
	const previousSampling = state.sampling;
	const nextSampling = update.clear || !update.enabled || (!wasEnabled && update.enabled) ? createPhysicsForceBodySamplingState() : previousSampling;
	let preparedOverlay: LinesMesh | null | undefined;
	let preparedVectorCount = 0;
	let preparedLineCount = 0;
	if (update.enabled) {
		if (update.clear || !wasEnabled) {
			samplePhysicsBodyNetForces(state.scene, nextSampling);
		}
		const snapshot = collectPhysicsForceVectors(state.scene, nextSampling, update.settings, { offset: 0, limit: 100 });
		preparedOverlay = createPhysicsForceVectorOverlay(state.scene, snapshot.displayedVectors, update.settings);
		preparedVectorCount = snapshot.visibleVectorCount;
		preparedLineCount = preparedOverlay ? preparedOverlay.getTotalVertices() / 2 : 0;
	}
	try {
		if (wasEnabled && !update.enabled) {
			detachVisualization(state);
		}
		state.settings = update.settings;
		state.sampling = nextSampling;
		if (update.enabled) {
			const previousOverlay = state.overlay;
			state.overlay = preparedOverlay ?? null;
			preparedOverlay = undefined;
			state.renderedVectorCount = preparedVectorCount;
			state.renderedLineCount = preparedLineCount;
			state.lastRefreshTime = performance.now();
			state.lastRefreshAt = Date.now();
			state.refreshCount++;
			state.lastError = null;
			previousOverlay?.dispose(false, true);
			if (!wasEnabled) {
				state.enabled = true;
				state.owner = options.editor;
				attachVisualization(state, options);
				owners.set(options.editor, state.scene);
			}
		}
		state.revision++;
		requestInspectorUpdate(state);
	} catch (error) {
		preparedOverlay?.dispose(false, true);
		state.settings = previousSettings;
		state.sampling = previousSampling;
		if (!wasEnabled) {
			detachVisualization(state);
		}
		throw error;
	}
	return status(state, {});
}

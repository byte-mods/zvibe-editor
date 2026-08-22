import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { createHash } from "node:crypto";
import { ensureDir, move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";

import { Scene, Animation, AnimationGroup, AnimationKeyInterpolation, Vector2, Vector3, Color3, Color4, Quaternion } from "babylonjs";
import {
	configureAnimationEvents,
	configureUnityAnimationClipRuntime,
	getUnityAnimationClipRuntimeEvidence,
	IUnityAnimationObjectReferenceBinding,
	IUnityAnimationObjectReferenceCurve,
	normalizeAnimationEventConfigurations,
	UNITY_ANIMATION_CLIP_METADATA_KEY,
	validateUnityAnimationDestinationPropertyPath,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl, projectConfiguration } from "../../project/configuration";
import { cloneAnimationCurveKey, getAutoSmoothedAnimationKeys } from "../../tools/animation/curve";

import { IMCPActionOptions } from "../action";
import { resolveNode, coerceValueForExistingProperty } from "../tools/resolve";
import { getUnityAnimationSourceEvidence, UNITY_ANIMATION_SOURCE_METADATA_KEY } from "../assets/unity-animator-dependencies";

interface IAnimationRuntimeBreakpoint {
	id: string;
	frame: number;
	enabled: boolean;
}

interface IAnimationRuntimeTraceEntry {
	sequence: number;
	kind: "play" | "pause" | "loop" | "end" | "frameBreakpoint" | "step";
	runtimeSeconds: number;
	frame: number | null;
	loopCount: number;
	breakpointIds: string[];
	details?: Record<string, unknown>;
}

interface IAnimationRuntimeDebugState {
	groupId: number;
	groupName: string;
	breakpoints: IAnimationRuntimeBreakpoint[];
	history: IAnimationRuntimeTraceEntry[];
	droppedHistoryCount: number;
	nextSequence: number;
	runtimeSeconds: number;
	loopCount: number;
	lastFrame: number | null;
	revision: number;
	observersAttached: boolean;
}

const maximumAnimationRuntimeHistory = 256;
const animationRuntimeDebugStates = new WeakMap<Scene, Map<number, IAnimationRuntimeDebugState>>();
const animationRuntimeSceneObservers = new WeakMap<Scene, any>();

function animationRuntimeStateMap(scene: Scene): Map<number, IAnimationRuntimeDebugState> {
	let states = animationRuntimeDebugStates.get(scene);
	if (!states) {
		states = new Map();
		animationRuntimeDebugStates.set(scene, states);
	}
	return states;
}

function currentAnimationGroupFrame(group: AnimationGroup): number | null {
	if (!group.isStarted || !group.animatables.length) {
		return null;
	}
	const frame = group.getCurrentFrame();
	return Number.isFinite(frame) ? frame : null;
}

function recordAnimationRuntimeTrace(
	state: IAnimationRuntimeDebugState,
	kind: IAnimationRuntimeTraceEntry["kind"],
	frame: number | null,
	breakpointIds: string[] = [],
	details?: Record<string, unknown>
): IAnimationRuntimeTraceEntry {
	const entry: IAnimationRuntimeTraceEntry = {
		sequence: state.nextSequence++,
		kind,
		runtimeSeconds: state.runtimeSeconds,
		frame,
		loopCount: state.loopCount,
		breakpointIds,
		...(details ? { details } : {}),
	};
	state.history.push(entry);
	if (state.history.length > maximumAnimationRuntimeHistory) {
		const removed = state.history.length - maximumAnimationRuntimeHistory;
		state.history.splice(0, removed);
		state.droppedHistoryCount += removed;
	}
	state.revision++;
	return entry;
}

function animationRuntimeCrossedBreakpointsAlong(
	state: IAnimationRuntimeDebugState,
	group: AnimationGroup,
	previousFrame: number,
	currentFrame: number,
	forward: boolean,
	wrapped: boolean
): IAnimationRuntimeBreakpoint[] {
	const matches = state.breakpoints.filter((breakpoint) => {
		if (!breakpoint.enabled) {
			return false;
		}
		if (forward) {
			return wrapped ? breakpoint.frame > previousFrame || breakpoint.frame <= currentFrame : breakpoint.frame > previousFrame && breakpoint.frame <= currentFrame;
		}
		return wrapped ? breakpoint.frame < previousFrame || breakpoint.frame >= currentFrame : breakpoint.frame < previousFrame && breakpoint.frame >= currentFrame;
	});
	return matches.sort((left, right) => {
		const distance = (frame: number): number =>
			forward
				? frame > previousFrame
					? frame - previousFrame
					: group.to - previousFrame + (frame - group.from)
				: frame < previousFrame
					? previousFrame - frame
					: previousFrame - group.from + (group.to - frame);
		return distance(left.frame) - distance(right.frame) || left.frame - right.frame || left.id.localeCompare(right.id);
	});
}

function animationRuntimeCrossedBreakpoints(state: IAnimationRuntimeDebugState, group: AnimationGroup, previousFrame: number, currentFrame: number): IAnimationRuntimeBreakpoint[] {
	const forward = group.speedRatio >= 0;
	const wrapped = group.loopAnimation && (forward ? currentFrame < previousFrame : currentFrame > previousFrame);
	return animationRuntimeCrossedBreakpointsAlong(state, group, previousFrame, currentFrame, forward, wrapped);
}

function attachAnimationRuntimeObservers(group: AnimationGroup, state: IAnimationRuntimeDebugState): void {
	if (state.observersAttached) {
		return;
	}
	state.observersAttached = true;
	group.onAnimationGroupPlayObservable.add(() => {
		state.lastFrame = currentAnimationGroupFrame(group);
		recordAnimationRuntimeTrace(state, "play", state.lastFrame);
	});
	group.onAnimationGroupPauseObservable.add(() => {
		state.lastFrame = currentAnimationGroupFrame(group);
		recordAnimationRuntimeTrace(state, "pause", state.lastFrame);
	});
	group.onAnimationGroupLoopObservable.add(() => {
		state.loopCount++;
		recordAnimationRuntimeTrace(state, "loop", currentAnimationGroupFrame(group));
	});
	group.onAnimationGroupEndObservable.add(() => {
		state.lastFrame = currentAnimationGroupFrame(group);
		recordAnimationRuntimeTrace(state, "end", state.lastFrame);
	});
}

function ensureAnimationRuntimeSceneObserver(scene: Scene): void {
	if (animationRuntimeSceneObservers.has(scene)) {
		return;
	}
	const observer = scene.onAfterAnimationsObservable.add(() => {
		const states = animationRuntimeStateMap(scene);
		const deltaSeconds = Math.max(0, scene.getEngine().getDeltaTime()) / 1000;
		for (const [groupId, state] of states) {
			const group = scene.animationGroups.find((candidate) => candidate.uniqueId === groupId);
			if (!group) {
				states.delete(groupId);
				continue;
			}
			const frame = currentAnimationGroupFrame(group);
			if (group.isPlaying) {
				state.runtimeSeconds += deltaSeconds;
			}
			if (group.isPlaying && frame !== null && state.lastFrame !== null && frame !== state.lastFrame) {
				const crossed = animationRuntimeCrossedBreakpoints(state, group, state.lastFrame, frame);
				if (crossed.length) {
					const breakpointFrame = crossed[0].frame;
					const breakpointIds = crossed.filter((breakpoint) => breakpoint.frame === breakpointFrame).map((breakpoint) => breakpoint.id);
					group.goToFrame(breakpointFrame, true);
					state.lastFrame = breakpointFrame;
					recordAnimationRuntimeTrace(state, "frameBreakpoint", breakpointFrame, breakpointIds, { source: "livePlayback" });
					group.pause();
					continue;
				}
			}
			state.lastFrame = frame;
		}
	});
	animationRuntimeSceneObservers.set(scene, observer);
	scene.onDisposeObservable.addOnce(() => {
		scene.onAfterAnimationsObservable.remove(observer);
		animationRuntimeSceneObservers.delete(scene);
		animationRuntimeDebugStates.delete(scene);
	});
}

function getAnimationRuntimeDebugState(scene: Scene, group: AnimationGroup): IAnimationRuntimeDebugState {
	ensureAnimationRuntimeSceneObserver(scene);
	const states = animationRuntimeStateMap(scene);
	let state = states.get(group.uniqueId);
	if (!state) {
		state = {
			groupId: group.uniqueId,
			groupName: group.name,
			breakpoints: [],
			history: [],
			droppedHistoryCount: 0,
			nextSequence: 1,
			runtimeSeconds: 0,
			loopCount: 0,
			lastFrame: currentAnimationGroupFrame(group),
			revision: 0,
			observersAttached: false,
		};
		states.set(group.uniqueId, state);
	}
	state.groupName = group.name;
	attachAnimationRuntimeObservers(group, state);
	return state;
}

function animationRuntimeFingerprint(group: AnimationGroup, state: IAnimationRuntimeDebugState): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				groupId: group.uniqueId,
				name: group.name,
				breakpoints: state.breakpoints,
				isStarted: group.isStarted,
				isPlaying: group.isPlaying,
				loopAnimation: group.loopAnimation,
				speedRatio: group.speedRatio,
				weight: group.weight,
				revision: state.revision,
				lastSequence: state.history[state.history.length - 1]?.sequence ?? 0,
			})
		)
		.digest("hex");
}

/**
 * Lists the scene's animation groups (imported clips + authored ones).
 */
export function listAnimationGroups(scene: Scene): any {
	return {
		groups: scene.animationGroups.map((group) => ({
			name: group.name,
			from: group.from,
			to: group.to,
			isPlaying: group.isPlaying,
			targetedAnimationCount: group.targetedAnimations.length,
		})),
	};
}

/**
 * Plays an animation group in the editor preview (e.g. to preview a character's idle clip).
 */
export function playAnimationGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = scene.getAnimationGroupByName(data.name);

	if (!group) {
		throw new Error(`Animation group not found: ${data.name}`);
	}

	const loop = data.loop ?? true;

	if (data.from !== undefined || data.to !== undefined) {
		group.start(loop, data.speed, data.from ?? group.from, data.to ?? group.to);
	} else {
		group.play(loop);

		if (data.speed !== undefined) {
			group.speedRatio = data.speed;
		}
	}

	// Reflect the playing state in the scene's Animation Groups inspector.
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();

	return {
		playing: true,
		name: group.name,
	};
}

/**
 * Stops a playing animation group, or all groups when no name is provided.
 */
export function stopAnimationGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.name) {
		const group = scene.getAnimationGroupByName(data.name);

		if (!group) {
			throw new Error(`Animation group not found: ${data.name}`);
		}

		group.stop();
	} else {
		scene.animationGroups.forEach((group) => group.stop());
	}

	// Reflect the stopped state in the scene's Animation Groups inspector.
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();

	return {
		stopped: true,
	};
}

/**
 * Resolves the loop mode constant from the contract's "cycle"|"constant"|"relative" string.
 */
function resolveLoopMode(loopMode?: string): number {
	switch (loopMode) {
		case "constant":
			return Animation.ANIMATIONLOOPMODE_CONSTANT;
		case "relative":
			return Animation.ANIMATIONLOOPMODE_RELATIVE;
		case "cycle":
		default:
			return Animation.ANIMATIONLOOPMODE_CYCLE;
	}
}

/**
 * Walks the given dotted path on the target object and returns the resolved value, or
 * `undefined` if any segment along the path is null/undefined.
 */
function resolvePathValue(target: any, path: string): any {
	const parts = path.split(".");

	let current = target;
	for (const part of parts) {
		if (current === null || current === undefined) {
			return undefined;
		}
		current = current[part];
	}

	return current;
}

/**
 * Infers the Babylon `ANIMATIONTYPE_*` constant from the resolved current value at the target property,
 * falling back to the shape of the first key's value when the path cannot be resolved.
 */
function resolveDataType(currentValue: any, firstKeyValue: any): number {
	if (currentValue instanceof Vector2) {
		return Animation.ANIMATIONTYPE_VECTOR2;
	}
	if (currentValue instanceof Vector3) {
		return Animation.ANIMATIONTYPE_VECTOR3;
	}
	if (currentValue instanceof Color3) {
		return Animation.ANIMATIONTYPE_COLOR3;
	}
	if (currentValue instanceof Color4) {
		return Animation.ANIMATIONTYPE_COLOR4;
	}
	if (currentValue instanceof Quaternion) {
		return Animation.ANIMATIONTYPE_QUATERNION;
	}
	if (typeof currentValue === "number") {
		return Animation.ANIMATIONTYPE_FLOAT;
	}

	// Fall back to the shape of the first key's value.
	if (typeof firstKeyValue === "number") {
		return Animation.ANIMATIONTYPE_FLOAT;
	}
	if (Array.isArray(firstKeyValue) && firstKeyValue.length === 3) {
		return Animation.ANIMATIONTYPE_VECTOR3;
	}

	throw new Error("Unable to infer the animation data type from the target property or the provided keys.");
}

/**
 * Coerces the given key value to match the resolved animation data type.
 */
function coerceKeyValue(value: any, currentValue: any, dataType: number): any {
	if (currentValue !== undefined) {
		return coerceValueForExistingProperty(currentValue, value);
	}

	if (Array.isArray(value)) {
		switch (dataType) {
			case Animation.ANIMATIONTYPE_VECTOR2:
				return new Vector2(value[0] ?? 0, value[1] ?? 0);
			case Animation.ANIMATIONTYPE_VECTOR3:
				return new Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
			case Animation.ANIMATIONTYPE_COLOR3:
				return new Color3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
			case Animation.ANIMATIONTYPE_COLOR4:
				return new Color4(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1);
			case Animation.ANIMATIONTYPE_QUATERNION:
				return new Quaternion(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1);
		}
	}

	return value;
}

/**
 * Authors a keyframe `AnimationGroup` targeting a node property (e.g. a door opening animates `rotation.y`).
 * Builds a Babylon `Animation` from the provided keys, wraps it in a named `AnimationGroup` and adds it to the scene.
 */
export function createAnimation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	const currentValue = resolvePathValue(node, data.targetProperty);
	const dataType = resolveDataType(currentValue, data.keys?.[0]?.value);

	const framesPerSecond = data.framesPerSecond ?? 60;
	const loopMode = resolveLoopMode(data.loopMode);

	const animation = new Animation(data.name, data.targetProperty, framesPerSecond, dataType, loopMode);

	animation.setKeys(
		(data.keys ?? []).map((key: any) => ({
			frame: key.frame,
			value: coerceKeyValue(key.value, currentValue, dataType),
			...(key.inTangent !== undefined ? { inTangent: coerceKeyValue(key.inTangent, currentValue, dataType) } : {}),
			...(key.outTangent !== undefined ? { outTangent: coerceKeyValue(key.outTangent, currentValue, dataType) } : {}),
			interpolation: key.interpolation === "step" ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE,
		}))
	);

	// Dispose any existing group with the same name so re-authoring a clip replaces it.
	const existingGroup = scene.getAnimationGroupByName(data.name);
	existingGroup?.dispose();

	const group = new AnimationGroup(data.name, scene);
	group.addTargetedAnimation(animation, node);

	// The scene's Animation Groups inspector seeds its list from `scene.animationGroups` on mount, so
	// set the scene as the edited object to make the new group appear (a bare forceUpdate would not re-pull it).
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();

	return {
		name: group.name,
		from: group.from,
		to: group.to,
		targetedAnimationCount: group.targetedAnimations.length,
	};
}

/**
 * Removes an animation group from the scene (disposes it).
 */
export function deleteAnimationGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = scene.getAnimationGroupByName(data.name);

	if (!group) {
		throw new Error(`Animation group not found: ${data.name}`);
	}

	animationRuntimeDebugStates.get(scene)?.delete(group.uniqueId);
	const remainingEventConfigurations = eventConfigurations(scene).filter((configuration) => configuration.groupName !== group.name);
	if (remainingEventConfigurations.length) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorAnimationEvents = remainingEventConfigurations;
	} else if (scene.metadata) {
		delete scene.metadata.babylonEditorAnimationEvents;
	}
	group.dispose();
	configureAnimationEvents(scene as any);

	// Re-seed the scene's Animation Groups inspector so the removed group disappears from the list.
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();

	return {
		deleted: true,
	};
}

function resolveGroup(scene: Scene, name: string): AnimationGroup {
	const group = scene.getAnimationGroupByName(name);
	if (!group) {
		throw new Error(`Animation group not found: ${name}`);
	}
	return group;
}

function eventConfigurations(scene: Scene): any[] {
	return normalizeAnimationEventConfigurations(scene.metadata?.babylonEditorAnimationEvents);
}

/** Restores persisted animation-event callbacks after animation groups have loaded. */
export function restoreAnimationEvents(scene: Scene): void {
	configureAnimationEvents(scene as any);
}

/** Lists persisted animation events and recent callback activity. */
export function listAnimationEvents(scene: Scene, data: any): any {
	const configurations = eventConfigurations(scene);
	const matching = data.name ? configurations.filter((configuration) => configuration.groupName === data.name) : configurations;
	return {
		groups: structuredClone(matching),
		targetRevision: data.name ? (matching[0]?.revision ?? 0) : null,
		recentEvents: structuredClone(scene.metadata?.babylonEditorAnimationEventLog ?? []),
	};
}

/** Replaces one animation group's persisted frame-event callbacks. */
export function setAnimationEvents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const configurations = eventConfigurations(scene);
	const index = configurations.findIndex((candidate) => candidate.groupName === group.name);
	const currentRevision = index === -1 ? 0 : configurations[index].revision;
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== currentRevision) {
		throw new Error(`Animation Events for "${group.name}" changed. Inspect them again and use expectedRevision ${currentRevision}.`);
	}
	if (currentRevision === Number.MAX_SAFE_INTEGER) {
		throw new Error(`Animation Events for "${group.name}" reached the maximum supported revision.`);
	}
	const configuration = normalizeAnimationEventConfigurations([{ groupName: group.name, revision: currentRevision + 1, events: data.events }])[0];
	if (index === -1) {
		configurations.push(configuration);
	} else {
		configurations[index] = configuration;
	}
	scene.metadata ??= {};
	scene.metadata.babylonEditorAnimationEvents = configurations;
	configureAnimationEvents(scene as any);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return listAnimationEvents(scene, { name: group.name });
}

function resolveProjectPath(path: string): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const projectDirectory = dirname(projectConfiguration.path);
	const absolutePath = normalize(isAbsolute(path) ? path : join(projectDirectory, path));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("Animation paths must stay inside the open project directory.");
	}
	return absolutePath;
}

/** Reads all tracks and keys in a hand-editable AnimationGroup. */
export function getAnimationGroup(scene: Scene, data: any): any {
	const group = resolveGroup(scene, data.name);
	return {
		name: group.name,
		from: group.from,
		to: group.to,
		graph: group.serialize(),
		tracks: group.targetedAnimations.map((targeted, index) => ({
			index,
			targetName: targeted.target.name ?? null,
			targetId: targeted.target.id ?? null,
			property: targeted.animation.targetProperty,
			framePerSecond: targeted.animation.framePerSecond,
			loopMode: targeted.animation.loopMode,
			keys: targeted.animation.getKeys(),
		})),
	};
}

/** Replaces the keyframes of a single AnimationGroup track. */
export function setAnimationKeys(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const targeted = group.targetedAnimations[data.trackIndex];
	if (!targeted) {
		throw new Error(`Track index ${data.trackIndex} does not exist in animation group "${group.name}".`);
	}
	const currentValue = resolvePathValue(targeted.target, targeted.animation.targetProperty);
	targeted.animation.setKeys(
		data.keys.map((key: any) => ({
			frame: key.frame,
			value: coerceKeyValue(key.value, currentValue, targeted.animation.dataType),
			...(key.inTangent !== undefined ? { inTangent: coerceKeyValue(key.inTangent, currentValue, targeted.animation.dataType) } : {}),
			...(key.outTangent !== undefined ? { outTangent: coerceKeyValue(key.outTangent, currentValue, targeted.animation.dataType) } : {}),
			interpolation: key.interpolation === "step" ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE,
		}))
	);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getAnimationGroup(scene, { name: group.name });
}

/** Replaces a scalar track's keys for the interactive curve-editor workflow. */
export function setAnimationCurveKeys(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const targeted = group.targetedAnimations[data.trackIndex];
	if (!targeted) {
		throw new Error(`Track index ${data.trackIndex} does not exist in animation group "${group.name}".`);
	}
	if (targeted.animation.dataType !== Animation.ANIMATIONTYPE_FLOAT) {
		throw new Error(`Track ${data.trackIndex} is not scalar. Use set_animation_keys for vector, color, or quaternion tracks.`);
	}
	if (!Array.isArray(data.keys) || !data.keys.length) {
		throw new Error("Curve keys must contain at least one scalar key.");
	}
	const frames = new Set<number>();
	for (const key of data.keys) {
		if (!Number.isFinite(key.frame) || key.frame < 0) {
			throw new Error("Curve key frames must be finite numbers greater than or equal to zero.");
		}
		if (!Number.isFinite(key.value)) {
			throw new Error("Curve key values must be finite numbers.");
		}
		if (key.inTangent !== undefined && !Number.isFinite(key.inTangent)) {
			throw new Error("Curve incoming tangents must be finite numbers.");
		}
		if (key.outTangent !== undefined && !Number.isFinite(key.outTangent)) {
			throw new Error("Curve outgoing tangents must be finite numbers.");
		}
		if (frames.has(key.frame)) {
			throw new Error(`Curve keys cannot share frame ${key.frame}.`);
		}
		frames.add(key.frame);
	}
	return setAnimationKeys(scene, data, options);
}

function getAnimationCurveComponentCount(dataType: number): number {
	if (dataType === Animation.ANIMATIONTYPE_VECTOR2) {
		return 2;
	}
	if (dataType === Animation.ANIMATIONTYPE_VECTOR3 || dataType === Animation.ANIMATIONTYPE_COLOR3) {
		return 3;
	}
	if (dataType === Animation.ANIMATIONTYPE_QUATERNION || dataType === Animation.ANIMATIONTYPE_COLOR4) {
		return 4;
	}
	return 0;
}

function animationValueComponents(value: any): number[] {
	if (typeof value === "number") {
		return [value];
	}
	const components = value?.asArray?.();
	return Array.isArray(components) ? components.slice(0, 4) : [];
}

function animationComponentLabels(dataType: number): string[] {
	if (dataType === Animation.ANIMATIONTYPE_FLOAT) {
		return ["Value"];
	}
	if (dataType === Animation.ANIMATIONTYPE_COLOR3 || dataType === Animation.ANIMATIONTYPE_COLOR4) {
		return ["R", "G", "B", "A"].slice(0, getAnimationCurveComponentCount(dataType));
	}
	return ["X", "Y", "Z", "W"].slice(0, getAnimationCurveComponentCount(dataType));
}

const animationTangentModesMetadataKey = "babylonEditorAnimationTangentModes";

function animationTargetIdentity(target: any): string {
	return String(target.id ?? target.uniqueId ?? target.name ?? "unknown");
}

function tangentModeConfigurations(group: AnimationGroup): any[] {
	group.metadata ??= {};
	const configurations = group.metadata[animationTangentModesMetadataKey];
	if (!Array.isArray(configurations)) {
		group.metadata[animationTangentModesMetadataKey] = [];
	}
	return group.metadata[animationTangentModesMetadataKey];
}

function activeTangentModeConfigurations(group: AnimationGroup): any[] {
	return tangentModeConfigurations(group).filter((configuration) => {
		const targeted = group.targetedAnimations.find(
			(candidate) => animationTargetIdentity(candidate.target) === configuration.targetId && candidate.animation.targetProperty === configuration.property
		);
		if (!targeted || !Number.isInteger(configuration.component) || configuration.component < 0) {
			return false;
		}
		const componentCount = Math.max(1, getAnimationCurveComponentCount(targeted.animation.dataType));
		return configuration.component < componentCount && targeted.animation.getKeys().some((key) => key.frame === configuration.frame);
	});
}

function tangentModeFor(group: AnimationGroup, targeted: any, frame: number, component: number): any {
	return activeTangentModeConfigurations(group).find(
		(configuration) =>
			configuration.targetId === animationTargetIdentity(targeted.target) &&
			configuration.property === targeted.animation.targetProperty &&
			configuration.frame === frame &&
			configuration.component === component
	);
}

function animationWindowFingerprint(group: AnimationGroup): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				name: group.name,
				tangentModes: activeTangentModeConfigurations(group)
					.slice()
					.sort((left, right) =>
						`${left.targetId}:${left.property}:${left.frame}:${left.component}`.localeCompare(`${right.targetId}:${right.property}:${right.frame}:${right.component}`)
					),
				tracks: group.targetedAnimations.map((targeted, index) => ({
					index,
					targetId: targeted.target.id ?? null,
					targetName: targeted.target.name ?? null,
					property: targeted.animation.targetProperty,
					fps: targeted.animation.framePerSecond,
					dataType: targeted.animation.dataType,
					loopMode: targeted.animation.loopMode,
					keys: targeted.animation.getKeys().map((key) => ({
						frame: key.frame,
						value: animationValueComponents(key.value),
						inTangent: key.inTangent === undefined ? null : animationValueComponents(key.inTangent),
						outTangent: key.outTangent === undefined ? null : animationValueComponents(key.outTangent),
						interpolation: key.interpolation ?? AnimationKeyInterpolation.NONE,
					})),
				})),
			})
		)
		.digest("hex");
}

/** Returns a clip-centric, component-aware model for the standalone Animation Window. */
export function getAnimationWindow(scene: Scene, data: any): any {
	const group = resolveGroup(scene, data.name);
	const tracks = group.targetedAnimations.map((targeted, index) => {
		const labels = animationComponentLabels(targeted.animation.dataType);
		return {
			index,
			targetName: targeted.target.name ?? null,
			targetId: targeted.target.id ?? null,
			property: targeted.animation.targetProperty,
			framesPerSecond: targeted.animation.framePerSecond,
			dataType: targeted.animation.dataType,
			loopMode: targeted.animation.loopMode,
			componentLabels: labels,
			keys: targeted.animation.getKeys().map((key) => ({
				frame: key.frame,
				values: animationValueComponents(key.value),
				inTangents: key.inTangent === undefined ? null : animationValueComponents(key.inTangent),
				outTangents: key.outTangent === undefined ? null : animationValueComponents(key.outTangent),
				interpolation: key.interpolation === AnimationKeyInterpolation.STEP ? "step" : "linear",
				tangentModes: labels.map((_, component) => tangentModeFor(group, targeted, key.frame, component) ?? null),
			})),
		};
	});
	const frames = tracks.flatMap((track) => track.keys.map((key) => key.frame));
	const from = frames.length ? Math.min(...frames) : group.from;
	const to = frames.length ? Math.max(...frames) : group.to;
	const uniqueFrames = new Set(frames);
	return {
		name: group.name,
		fingerprint: animationWindowFingerprint(group),
		from,
		to,
		durationFrames: Math.max(0, to - from),
		durationSeconds: Math.max(0, to - from) / Math.max(1, tracks[0]?.framesPerSecond ?? 60),
		trackCount: tracks.length,
		keyCount: frames.length,
		uniqueFrameCount: uniqueFrames.size,
		tracks,
		events: structuredClone(eventConfigurations(scene).find((configuration) => configuration.groupName === group.name)?.events ?? []),
	};
}

function boundedAnimationRuntimeInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || (resolved as number) < minimum || (resolved as number) > maximum) {
		throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
	}
	return resolved as number;
}

function animationRuntimeStatus(group: AnimationGroup): "stopped" | "playing" | "paused" {
	return !group.isStarted ? "stopped" : group.isPlaying ? "playing" : "paused";
}

function animationRuntimeValue(value: any): number[] | null {
	const components = animationValueComponents(value);
	return components.length && components.every(Number.isFinite) ? components : null;
}

function animationRuntimeDivergence(current: number[] | null, evaluated: number[] | null): number | null {
	if (!current || !evaluated || current.length !== evaluated.length) {
		return null;
	}
	return current.reduce((maximum, component, index) => Math.max(maximum, Math.abs(component - evaluated[index])), 0);
}

function animationRuntimeDebuggerSnapshot(scene: Scene, group: AnimationGroup, state: IAnimationRuntimeDebugState, data: any = {}): any {
	const trackOffset = boundedAnimationRuntimeInteger(data.trackOffset, 0, 0, 1000000, "Animation runtime trackOffset");
	const trackLimit = boundedAnimationRuntimeInteger(data.trackLimit, 64, 1, 256, "Animation runtime trackLimit");
	const historyLimit = boundedAnimationRuntimeInteger(data.historyLimit, 64, 1, maximumAnimationRuntimeHistory, "Animation runtime historyLimit");
	const eventLimit = boundedAnimationRuntimeInteger(data.eventLimit, 32, 1, 128, "Animation runtime eventLimit");
	const currentFrame = currentAnimationGroupFrame(group);
	const frameSpan = Math.max(0, group.to - group.from);
	const allTracks = group.targetedAnimations.map((targeted, index) => {
		const currentValue = animationRuntimeValue(resolvePathValue(targeted.target, targeted.animation.targetProperty));
		const evaluatedValue = currentFrame === null ? null : animationRuntimeValue(targeted.animation.evaluate(currentFrame));
		return {
			index,
			targetName: targeted.target.name ?? null,
			targetId: targeted.target.id ?? null,
			property: targeted.animation.targetProperty,
			framesPerSecond: targeted.animation.framePerSecond,
			dataType: targeted.animation.dataType,
			currentValue,
			evaluatedValue,
			maximumComponentDivergence: animationRuntimeDivergence(currentValue, evaluatedValue),
		};
	});
	const tracks = allTracks.slice(trackOffset, trackOffset + trackLimit);
	const matchingEvents = (scene.metadata?.babylonEditorAnimationEventLog ?? []).filter((entry: any) => entry.groupName === group.name);
	const retainedBeforeHistory = Math.max(0, state.history.length - historyLimit);
	return {
		name: group.name,
		groupId: group.uniqueId,
		fingerprint: animationRuntimeFingerprint(group, state),
		status: animationRuntimeStatus(group),
		isStarted: group.isStarted,
		isPlaying: group.isPlaying,
		currentFrame,
		from: group.from,
		to: group.to,
		normalizedFrame: currentFrame === null || frameSpan === 0 ? null : Math.min(1, Math.max(0, (currentFrame - group.from) / frameSpan)),
		loopAnimation: group.loopAnimation,
		loopCount: state.loopCount,
		speedRatio: group.speedRatio,
		weight: group.weight,
		runtimeSeconds: state.runtimeSeconds,
		animatables: group.animatables.map((animatable, index) => ({
			index,
			masterFrame: animatable.masterFrame,
			elapsedMilliseconds: animatable.elapsedTime,
			fromFrame: animatable.fromFrame,
			toFrame: animatable.toFrame,
			paused: animatable.paused,
			loopAnimation: animatable.loopAnimation,
			speedRatio: animatable.speedRatio,
			weight: animatable.weight,
		})),
		trackPage: {
			offset: trackOffset,
			limit: trackLimit,
			count: tracks.length,
			total: allTracks.length,
			hasMore: trackOffset + tracks.length < allTracks.length,
			nextOffset: trackOffset + tracks.length < allTracks.length ? trackOffset + tracks.length : null,
		},
		tracks,
		breakpoints: structuredClone(state.breakpoints),
		history: structuredClone(state.history.slice(-historyLimit)),
		historyEvidence: {
			retainedCount: state.history.length,
			returnedCount: Math.min(historyLimit, state.history.length),
			droppedCount: state.droppedHistoryCount,
			truncatedCount: state.droppedHistoryCount + retainedBeforeHistory,
		},
		recentEvents: structuredClone(matchingEvents.slice(-eventLimit)),
		recentEventEvidence: {
			retainedMatchingCount: matchingEvents.length,
			returnedCount: Math.min(eventLimit, matchingEvents.length),
			truncatedCount: Math.max(0, matchingEvents.length - eventLimit),
		},
	};
}

/** Returns live standalone AnimationGroup playback, sampled values, events, breakpoints, and bounded trace evidence. */
export function getAnimationRuntimeDebug(scene: Scene, data: any): any {
	const group = resolveGroup(scene, data.name);
	const state = getAnimationRuntimeDebugState(scene, group);
	return animationRuntimeDebuggerSnapshot(scene, group, state, data);
}

function validateAnimationRuntimeBreakpoints(group: AnimationGroup, value: unknown): IAnimationRuntimeBreakpoint[] {
	if (!Array.isArray(value) || value.length > 64) {
		throw new Error("Animation runtime breakpoints must be a complete array containing at most 64 entries.");
	}
	const ids = new Set<string>();
	return value.map((breakpoint: any) => {
		if (typeof breakpoint?.id !== "string" || breakpoint.id.length < 1 || breakpoint.id.length > 128) {
			throw new Error("Every animation runtime breakpoint id must contain 1 through 128 characters.");
		}
		if (ids.has(breakpoint.id)) {
			throw new Error(`Animation runtime breakpoint id "${breakpoint.id}" is duplicated.`);
		}
		ids.add(breakpoint.id);
		if (!Number.isFinite(breakpoint.frame) || breakpoint.frame < group.from || breakpoint.frame > group.to) {
			throw new Error(`Animation runtime breakpoint "${breakpoint.id}" must use a finite frame between ${group.from} and ${group.to}.`);
		}
		if (typeof breakpoint.enabled !== "boolean") {
			throw new Error(`Animation runtime breakpoint "${breakpoint.id}" requires an enabled Boolean.`);
		}
		return { id: breakpoint.id, frame: breakpoint.frame, enabled: breakpoint.enabled };
	});
}

/** Atomically configures one runtime-only standalone AnimationGroup debugger under its exact fingerprint. */
export function setAnimationRuntimeDebug(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const state = getAnimationRuntimeDebugState(scene, group);
	if (data.expectedFingerprint !== animationRuntimeFingerprint(group, state)) {
		throw new Error("Animation runtime debugger changed after inspection. Call get_animation_runtime_debug again and use its exact fingerprint.");
	}
	if (
		data.paused === undefined &&
		data.breakpoints === undefined &&
		data.clearHistory !== true &&
		data.speedRatio === undefined &&
		data.weight === undefined &&
		data.loopAnimation === undefined
	) {
		throw new Error("Provide paused, breakpoints, clearHistory=true, speedRatio, weight, or loopAnimation.");
	}
	const breakpoints = data.breakpoints === undefined ? null : validateAnimationRuntimeBreakpoints(group, data.breakpoints);
	if (data.paused !== undefined && !group.isStarted) {
		throw new Error(`Animation group "${group.name}" must be started before it can be paused or resumed.`);
	}
	if (data.speedRatio !== undefined && (!Number.isFinite(data.speedRatio) || data.speedRatio === 0 || Math.abs(data.speedRatio) > 100)) {
		throw new Error("Animation runtime speedRatio must be finite, non-zero, and between -100 and 100.");
	}
	if (data.weight !== undefined && (!Number.isFinite(data.weight) || data.weight < -1 || data.weight > 1)) {
		throw new Error("Animation runtime weight must be finite and between -1 and 1.");
	}
	if (data.loopAnimation !== undefined && typeof data.loopAnimation !== "boolean") {
		throw new Error("Animation runtime loopAnimation must be a Boolean.");
	}

	let configurationChanged = false;
	if (breakpoints && JSON.stringify(breakpoints) !== JSON.stringify(state.breakpoints)) {
		state.breakpoints = breakpoints;
		configurationChanged = true;
	}
	if (data.clearHistory === true) {
		state.history = [];
		state.droppedHistoryCount = 0;
		state.nextSequence = 1;
		configurationChanged = true;
	}
	if (data.speedRatio !== undefined && data.speedRatio !== group.speedRatio) {
		group.speedRatio = data.speedRatio;
		configurationChanged = true;
	}
	if (data.weight !== undefined && data.weight !== group.weight) {
		group.weight = data.weight;
		configurationChanged = true;
	}
	if (data.loopAnimation !== undefined && data.loopAnimation !== group.loopAnimation) {
		group.loopAnimation = data.loopAnimation;
		configurationChanged = true;
	}
	if (configurationChanged) {
		state.revision++;
	}
	if (data.paused === true && group.isPlaying) {
		group.pause();
	} else if (data.paused === false && !group.isPlaying) {
		group.restart();
	}
	state.lastFrame = currentAnimationGroupFrame(group);
	options.editor.layout.inspector.forceUpdate();
	return animationRuntimeDebuggerSnapshot(scene, group, state, data);
}

function advanceAnimationRuntimeFrame(group: AnimationGroup, currentFrame: number, frameDelta: number): { frame: number; wraps: number; travelledFrames: number } {
	const minimum = group.from;
	const maximum = group.to;
	const span = maximum - minimum;
	if (!group.loopAnimation || span <= 0) {
		const frame = Math.min(maximum, Math.max(minimum, currentFrame + frameDelta));
		return { frame, wraps: 0, travelledFrames: Math.abs(frame - currentFrame) };
	}
	const rawFrame = currentFrame + frameDelta;
	if (frameDelta > 0 && rawFrame > maximum) {
		const wraps = Math.ceil((rawFrame - maximum) / span);
		return { frame: rawFrame - wraps * span, wraps, travelledFrames: Math.abs(frameDelta) };
	}
	if (frameDelta < 0 && rawFrame < minimum) {
		const wraps = Math.ceil((minimum - rawFrame) / span);
		return { frame: rawFrame + wraps * span, wraps, travelledFrames: Math.abs(frameDelta) };
	}
	return { frame: rawFrame, wraps: 0, travelledFrames: Math.abs(frameDelta) };
}

function animationRuntimeDistanceToFrame(group: AnimationGroup, currentFrame: number, targetFrame: number, forward: boolean, wrapped: boolean): number {
	if (!wrapped) {
		return Math.abs(targetFrame - currentFrame);
	}
	return forward ? group.to - currentFrame + (targetFrame - group.from) : currentFrame - group.from + (group.to - targetFrame);
}

/** Deterministically samples a started, paused standalone AnimationGroup by a bounded number of exact frame steps. */
export function stepAnimationRuntimeDebug(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const state = getAnimationRuntimeDebugState(scene, group);
	if (data.expectedFingerprint !== animationRuntimeFingerprint(group, state)) {
		throw new Error("Animation runtime debugger changed after inspection. Call get_animation_runtime_debug again and use its exact fingerprint.");
	}
	if (!group.isStarted || group.isPlaying) {
		throw new Error(`Animation group "${group.name}" must be started and paused before deterministic stepping.`);
	}
	const frameDelta = data.frameDelta ?? 1;
	const steps = boundedAnimationRuntimeInteger(data.steps, 1, 1, 120, "Animation runtime steps");
	if (!Number.isFinite(frameDelta) || frameDelta === 0 || Math.abs(frameDelta) > 10000 || Math.abs(frameDelta * steps) > 10000) {
		throw new Error("Animation runtime frameDelta must be finite and non-zero, and the requested total must not exceed 10000 frames.");
	}
	const startingFrame = currentAnimationGroupFrame(group);
	if (startingFrame === null) {
		throw new Error(`Animation group "${group.name}" has no active animatable frame to step.`);
	}
	const framesPerSecond = Math.max(1, group.targetedAnimations[0]?.animation.framePerSecond ?? 60);
	let currentFrame = startingFrame;
	let completedSteps = 0;
	let wrapCount = 0;
	let travelledFrames = 0;
	let hitBreakpoints: IAnimationRuntimeBreakpoint[] = [];
	for (let step = 0; step < steps; step++) {
		const advanced = advanceAnimationRuntimeFrame(group, currentFrame, frameDelta);
		const forward = frameDelta > 0;
		const crossed = animationRuntimeCrossedBreakpointsAlong(state, group, currentFrame, advanced.frame, forward, advanced.wraps > 0);
		if (crossed.length) {
			const breakpointFrame = crossed[0].frame;
			hitBreakpoints = crossed.filter((breakpoint) => breakpoint.frame === breakpointFrame);
			const wrappedBeforeHit = forward ? breakpointFrame <= currentFrame : breakpointFrame >= currentFrame;
			wrapCount += wrappedBeforeHit ? 1 : 0;
			travelledFrames += animationRuntimeDistanceToFrame(group, currentFrame, breakpointFrame, forward, wrappedBeforeHit);
			currentFrame = breakpointFrame;
			group.goToFrame(currentFrame, true);
			completedSteps++;
			break;
		}
		currentFrame = advanced.frame;
		wrapCount += advanced.wraps;
		travelledFrames += advanced.travelledFrames;
		group.goToFrame(currentFrame, true);
		completedSteps++;
	}
	state.loopCount += wrapCount;
	state.runtimeSeconds += travelledFrames / framesPerSecond;
	state.lastFrame = currentFrame;
	if (hitBreakpoints.length) {
		recordAnimationRuntimeTrace(
			state,
			"frameBreakpoint",
			currentFrame,
			hitBreakpoints.map((breakpoint) => breakpoint.id),
			{ source: "deterministicStep", requestedSteps: steps, completedSteps, frameDelta, wraps: wrapCount }
		);
	} else {
		recordAnimationRuntimeTrace(state, "step", currentFrame, [], {
			requestedSteps: steps,
			completedSteps,
			frameDelta,
			fromFrame: startingFrame,
			toFrame: currentFrame,
			wraps: wrapCount,
		});
	}
	options.editor.layout.inspector.forceUpdate();
	return {
		...animationRuntimeDebuggerSnapshot(scene, group, state, data),
		stepped: {
			requestedSteps: steps,
			completedSteps,
			frameDelta,
			fromFrame: startingFrame,
			toFrame: currentFrame,
			wraps: wrapCount,
			haltedByBreakpoint: hitBreakpoints.length > 0,
			breakpointIds: hitBreakpoints.map((breakpoint) => breakpoint.id),
		},
	};
}

const animationPropertySegmentPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbiddenAnimationPropertySegments = new Set(["__proto__", "prototype", "constructor"]);

function validateAnimationPropertyPath(property: unknown): string {
	if (typeof property !== "string" || property.length < 1 || property.length > 512) {
		throw new Error("Animation recording property paths must contain 1 through 512 characters.");
	}
	const segments = property.split(".");
	if (segments.length > 16 || segments.some((segment) => !animationPropertySegmentPattern.test(segment) || forbiddenAnimationPropertySegments.has(segment))) {
		throw new Error(`Animation recording property path "${property}" is invalid or unsafe.`);
	}
	return property;
}

function cloneRecordedAnimationValue(value: any): any {
	return value?.clone?.() ?? value;
}

function validateRecordedAnimationValue(value: any): { dataType: number; values: number[]; value: any } {
	let dataType: number;
	try {
		dataType = resolveDataType(value, undefined);
	} catch {
		throw new Error("Animation recording supports only finite number, Vector2, Vector3, Quaternion, Color3, and Color4 Inspector values.");
	}
	const values = animationValueComponents(value);
	if (!values.length || values.some((component) => !Number.isFinite(component))) {
		throw new Error("Animation recording supports only finite number, Vector2, Vector3, Quaternion, Color3, and Color4 Inspector values.");
	}
	return { dataType, values, value: cloneRecordedAnimationValue(value) };
}

/**
 * Atomically records current Inspector property values at one frame. Existing tracks are keyed in place;
 * missing node-property tracks are created in the same AnimationGroup.
 */
export function recordAnimationWindowProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const currentFingerprint = animationWindowFingerprint(group);
	if (data.expectedFingerprint !== currentFingerprint) {
		throw new Error("Animation clip changed after inspection. Call get_animation_window again and use its exact fingerprint.");
	}
	if (!Number.isFinite(data.frame) || data.frame < 0 || data.frame > 1000000000) {
		throw new Error("Animation recording frame must be finite and between 0 and 1000000000.");
	}
	if (!Array.isArray(data.entries) || data.entries.length < 1 || data.entries.length > 128) {
		throw new Error("Animation recording requires 1 through 128 property entries.");
	}

	const defaultFramesPerSecond = group.targetedAnimations[0]?.animation.framePerSecond ?? 60;
	const defaultLoopMode = group.targetedAnimations[0]?.animation.loopMode ?? Animation.ANIMATIONLOOPMODE_CYCLE;
	const identities = new Set<string>();
	const planned = data.entries.map((entry: any) => {
		const property = validateAnimationPropertyPath(entry.property);
		if (entry.interpolation !== undefined && entry.interpolation !== "linear" && entry.interpolation !== "step") {
			throw new Error("Animation recording interpolation must be linear or step.");
		}
		if (entry.loopMode !== undefined && !["cycle", "constant", "relative"].includes(entry.loopMode)) {
			throw new Error("Animation recording loopMode must be cycle, constant, or relative.");
		}
		const usesTrack = entry.targetTrackIndex !== undefined;
		const usesNode = entry.nodeId !== undefined || entry.nodeName !== undefined;
		if (usesTrack === usesNode) {
			throw new Error("Each animation recording entry must use exactly one target mode: targetTrackIndex or nodeId/nodeName.");
		}
		let target: any;
		if (usesTrack) {
			if (!Number.isInteger(entry.targetTrackIndex) || entry.targetTrackIndex < 0 || entry.targetTrackIndex >= group.targetedAnimations.length) {
				throw new Error(`Animation recording track index "${entry.targetTrackIndex}" does not exist.`);
			}
			target = group.targetedAnimations[entry.targetTrackIndex].target;
		} else {
			target = resolveNode({ scene, nodeId: entry.nodeId, nodeName: entry.nodeName });
		}
		const targetIdentity = target.id ?? target.uniqueId ?? target.name;
		const identity = `${targetIdentity}:${property}`;
		if (identities.has(identity)) {
			throw new Error(`Animation recording duplicates target property "${property}".`);
		}
		identities.add(identity);
		const currentValue = resolvePathValue(target, property);
		if (currentValue === undefined || currentValue === null) {
			throw new Error(`Animation recording property "${property}" does not resolve on target "${target.name ?? target.id ?? "unknown"}".`);
		}
		const normalized = validateRecordedAnimationValue(currentValue);
		const existingIndex = group.targetedAnimations.findIndex((candidate) => candidate.target === target && candidate.animation.targetProperty === property);
		const existing = existingIndex === -1 ? null : group.targetedAnimations[existingIndex];
		if (existing && existing.animation.dataType !== normalized.dataType) {
			throw new Error(`Animation recording property "${property}" does not match existing track ${existingIndex}'s data type.`);
		}
		const framesPerSecond = entry.framesPerSecond ?? defaultFramesPerSecond;
		if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 1000) {
			throw new Error("Animation recording framesPerSecond must be finite and between 1 and 1000.");
		}
		return { entry, property, target, existing, existingIndex, framesPerSecond, normalized };
	});

	const originals = group.targetedAnimations.map((targeted) => targeted.animation.getKeys().map(cloneAnimationCurveKey));
	const addedAnimations: Animation[] = [];
	const recorded: any[] = [];
	try {
		for (const plan of planned) {
			const interpolation = plan.entry.interpolation === "step" ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE;
			let effectiveInterpolation = interpolation;
			let trackIndex = plan.existingIndex;
			let replacedKey = false;
			if (plan.existing) {
				const keys = plan.existing.animation.getKeys().map(cloneAnimationCurveKey);
				const index = keys.findIndex((key) => key.frame === data.frame);
				if (index === -1) {
					keys.push({ frame: data.frame, value: plan.normalized.value, interpolation });
				} else {
					replacedKey = true;
					keys[index] = {
						...keys[index],
						value: plan.normalized.value,
						...(plan.entry.interpolation === undefined ? {} : { interpolation }),
					};
				}
				keys.sort((left, right) => left.frame - right.frame);
				effectiveInterpolation = keys.find((key) => key.frame === data.frame)?.interpolation ?? AnimationKeyInterpolation.NONE;
				plan.existing.animation.setKeys(keys);
			} else {
				const animation = new Animation(
					`${plan.target.name ?? plan.target.id ?? "Target"} ${plan.property}`,
					plan.property,
					plan.framesPerSecond,
					plan.normalized.dataType,
					plan.entry.loopMode === undefined ? defaultLoopMode : resolveLoopMode(plan.entry.loopMode)
				);
				animation.setKeys([{ frame: data.frame, value: plan.normalized.value, interpolation }]);
				group.addTargetedAnimation(animation, plan.target);
				addedAnimations.push(animation);
				trackIndex = group.targetedAnimations.length - 1;
			}
			recorded.push({
				targetName: plan.target.name ?? null,
				targetId: plan.target.id ?? null,
				property: plan.property,
				trackIndex,
				createdTrack: !plan.existing,
				replacedKey,
				frame: data.frame,
				values: plan.normalized.values,
				dataType: plan.normalized.dataType,
				interpolation: effectiveInterpolation === AnimationKeyInterpolation.STEP ? "step" : "linear",
			});
		}
	} catch (error) {
		group.targetedAnimations.slice(0, originals.length).forEach((targeted, index) => targeted.animation.setKeys(originals[index]));
		addedAnimations.forEach((animation) => group.removeTargetedAnimation(animation));
		throw error;
	}

	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.animations?.forceUpdate?.();
	return { recordedCount: recorded.length, recorded, window: getAnimationWindow(scene, { name: group.name }) };
}

function animationScalarComponent(value: any, component: number): number {
	const scalar = typeof value === "number" ? value : value?.asArray?.()[component];
	if (!Number.isFinite(scalar)) {
		throw new Error(`Animation tangent component ${component} is not finite.`);
	}
	return scalar;
}

function animationSegmentSlope(first: any, second: any, component: number): number {
	const duration = second.frame - first.frame;
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error("Animation tangent keys must have unique ascending frames.");
	}
	return (animationScalarComponent(second.value, component) - animationScalarComponent(first.value, component)) / duration;
}

function automaticAnimationTangent(keys: any[], index: number, component: number): number {
	const previous = keys[index - 1];
	const current = keys[index];
	const next = keys[index + 1];
	if (previous && next) {
		return (animationScalarComponent(next.value, component) - animationScalarComponent(previous.value, component)) / (next.frame - previous.frame);
	}
	if (previous) {
		return animationSegmentSlope(previous, current, component);
	}
	if (next) {
		return animationSegmentSlope(current, next, component);
	}
	return 0;
}

function clampedAutomaticAnimationTangent(keys: any[], index: number, component: number): number {
	const previous = keys[index - 1];
	const current = keys[index];
	const next = keys[index + 1];
	if (!previous || !next) {
		return automaticAnimationTangent(keys, index, component);
	}
	const previousSlope = animationSegmentSlope(previous, current, component);
	const nextSlope = animationSegmentSlope(current, next, component);
	if (previousSlope === 0 || nextSlope === 0 || Math.sign(previousSlope) !== Math.sign(nextSlope)) {
		return 0;
	}
	const previousDuration = current.frame - previous.frame;
	const nextDuration = next.frame - current.frame;
	const previousWeight = 2 * nextDuration + previousDuration;
	const nextWeight = nextDuration + 2 * previousDuration;
	return (previousWeight + nextWeight) / (previousWeight / previousSlope + nextWeight / nextSlope);
}

function setAnimationKeyTangentComponent(key: any, property: "inTangent" | "outTangent", component: number, scalar: number): void {
	if (typeof key.value === "number") {
		key[property] = scalar;
		return;
	}
	key[property] = setAnimationValueComponent(key[property] ?? key.value, component, scalar, key[property] === undefined);
}

function currentAnimationKeyTangentComponent(key: any, property: "inTangent" | "outTangent", component: number): number {
	if (typeof key[property] === "number") {
		return key[property];
	}
	return key[property]?.asArray?.()[component] ?? 0;
}

function validateAnimationTangentModeInput(data: any): void {
	if (!["auto", "clampedAuto", "linear", "freeSmooth", "broken", "weighted"].includes(data.mode)) {
		throw new Error(`Unsupported Animation Window tangent mode "${data.mode}".`);
	}
	for (const [name, value] of [
		["tangent", data.tangent],
		["inTangent", data.inTangent],
		["outTangent", data.outTangent],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < -1000000000 || value > 1000000000)) {
			throw new Error(`Animation Window ${name} must be finite and between -1000000000 and 1000000000.`);
		}
	}
	for (const [name, value] of [
		["inWeight", data.inWeight],
		["outWeight", data.outWeight],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0.01 || value > 1)) {
			throw new Error(`Animation Window ${name} must be finite and between 0.01 and 1.`);
		}
	}
	const hasManual = data.tangent !== undefined || data.inTangent !== undefined || data.outTangent !== undefined || data.inWeight !== undefined || data.outWeight !== undefined;
	if (["auto", "clampedAuto", "linear"].includes(data.mode) && hasManual) {
		throw new Error(`${data.mode} tangent mode does not accept manual tangent or weight values.`);
	}
	if (
		data.mode === "freeSmooth" &&
		(data.tangent === undefined || data.inTangent !== undefined || data.outTangent !== undefined || data.inWeight !== undefined || data.outWeight !== undefined)
	) {
		throw new Error("freeSmooth tangent mode requires only tangent.");
	}
	if (
		data.mode === "broken" &&
		((data.inTangent === undefined && data.outTangent === undefined) || data.tangent !== undefined || data.inWeight !== undefined || data.outWeight !== undefined)
	) {
		throw new Error("broken tangent mode requires inTangent, outTangent, or both, without weights.");
	}
	if (
		data.mode === "weighted" &&
		(data.inTangent === undefined || data.outTangent === undefined || data.inWeight === undefined || data.outWeight === undefined || data.tangent !== undefined)
	) {
		throw new Error("weighted tangent mode requires inTangent, outTangent, inWeight, and outWeight.");
	}
}

/** Applies exact leased tangent modes to selected Animation Window key components. */
export function setAnimationWindowTangentModes(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const currentFingerprint = animationWindowFingerprint(group);
	if (data.expectedFingerprint !== currentFingerprint) {
		throw new Error("Animation clip changed after inspection. Call get_animation_window again and use its exact fingerprint.");
	}
	validateAnimationTangentModeInput(data);
	const selection = normalizeAnimationWindowSelection(group, data.selection);
	const expanded: Array<{ trackIndex: number; frame: number; component: number }> = [];
	const identities = new Set<string>();
	for (const item of selection) {
		const animation = group.targetedAnimations[item.trackIndex].animation;
		const componentCount = Math.max(1, getAnimationCurveComponentCount(animation.dataType));
		const components = item.component === undefined ? Array.from({ length: componentCount }, (_, component) => component) : [item.component];
		for (const component of components) {
			const identity = `${item.trackIndex}:${item.frame}:${component}`;
			if (identities.has(identity)) {
				throw new Error(`Animation Window tangent selection overlaps ${identity}.`);
			}
			identities.add(identity);
			expanded.push({ trackIndex: item.trackIndex, frame: item.frame, component });
		}
	}

	const originals = group.targetedAnimations.map((targeted) => targeted.animation.getKeys().map(cloneAnimationCurveKey));
	const working = originals.map((keys) => keys.map(cloneAnimationCurveKey));
	const priorConfigurations = structuredClone(tangentModeConfigurations(group));
	const configurations = activeTangentModeConfigurations(group).filter((configuration) => {
		const trackIndex = group.targetedAnimations.findIndex(
			(targeted) => animationTargetIdentity(targeted.target) === configuration.targetId && targeted.animation.targetProperty === configuration.property
		);
		return !expanded.some((item) => item.trackIndex === trackIndex && item.frame === configuration.frame && item.component === configuration.component);
	});
	const changed: any[] = [];
	for (const item of expanded) {
		const targeted = group.targetedAnimations[item.trackIndex];
		const keys = working[item.trackIndex];
		const keyIndex = keys.findIndex((key) => key.frame === item.frame);
		const key = keys[keyIndex];
		let authoredInTangent: number;
		let authoredOutTangent: number;
		let inWeight: number | null = null;
		let outWeight: number | null = null;
		if (data.mode === "auto") {
			authoredInTangent = authoredOutTangent = automaticAnimationTangent(keys, keyIndex, item.component);
		} else if (data.mode === "clampedAuto") {
			authoredInTangent = authoredOutTangent = clampedAutomaticAnimationTangent(keys, keyIndex, item.component);
		} else if (data.mode === "linear") {
			authoredInTangent = keyIndex > 0 ? animationSegmentSlope(keys[keyIndex - 1], key, item.component) : automaticAnimationTangent(keys, keyIndex, item.component);
			authoredOutTangent =
				keyIndex < keys.length - 1 ? animationSegmentSlope(key, keys[keyIndex + 1], item.component) : automaticAnimationTangent(keys, keyIndex, item.component);
		} else if (data.mode === "freeSmooth") {
			authoredInTangent = authoredOutTangent = data.tangent;
		} else if (data.mode === "broken") {
			authoredInTangent = data.inTangent ?? currentAnimationKeyTangentComponent(key, "inTangent", item.component);
			authoredOutTangent = data.outTangent ?? currentAnimationKeyTangentComponent(key, "outTangent", item.component);
		} else {
			authoredInTangent = data.inTangent;
			authoredOutTangent = data.outTangent;
			inWeight = data.inWeight;
			outWeight = data.outWeight;
		}
		const effectiveInTangent = data.mode === "weighted" ? authoredInTangent * 3 * inWeight! : authoredInTangent;
		const effectiveOutTangent = data.mode === "weighted" ? authoredOutTangent * 3 * outWeight! : authoredOutTangent;
		setAnimationKeyTangentComponent(key, "inTangent", item.component, effectiveInTangent);
		setAnimationKeyTangentComponent(key, "outTangent", item.component, effectiveOutTangent);
		key.interpolation = AnimationKeyInterpolation.NONE;
		key.lockedTangent = !["broken", "weighted"].includes(data.mode);
		const configuration = {
			targetId: animationTargetIdentity(targeted.target),
			property: targeted.animation.targetProperty,
			frame: item.frame,
			component: item.component,
			mode: data.mode,
			authoredInTangent,
			authoredOutTangent,
			inWeight,
			outWeight,
			effectiveInTangent,
			effectiveOutTangent,
			locked: key.lockedTangent,
		};
		configurations.push(configuration);
		changed.push({ trackIndex: item.trackIndex, ...configuration });
	}

	try {
		group.targetedAnimations.forEach((targeted, trackIndex) => targeted.animation.setKeys(working[trackIndex]));
		group.metadata[animationTangentModesMetadataKey] = configurations;
	} catch (error) {
		group.targetedAnimations.forEach((targeted, trackIndex) => targeted.animation.setKeys(originals[trackIndex]));
		group.metadata[animationTangentModesMetadataKey] = priorConfigurations;
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.animations?.forceUpdate?.();
	return { mode: data.mode, changedComponentCount: changed.length, changed, window: getAnimationWindow(scene, { name: group.name }) };
}

function normalizeAnimationWindowSelection(group: AnimationGroup, selection: any[]): Array<{ trackIndex: number; frame: number; component?: number }> {
	if (!Array.isArray(selection) || selection.length < 1 || selection.length > 2048) {
		throw new Error("Animation Window edits require 1 through 2048 selected keys.");
	}
	const normalized: Array<{ trackIndex: number; frame: number; component?: number }> = [];
	const identities = new Set<string>();
	for (const item of selection) {
		if (!Number.isInteger(item.trackIndex) || item.trackIndex < 0 || item.trackIndex >= group.targetedAnimations.length) {
			throw new Error(`Animation Window track index "${item.trackIndex}" does not exist.`);
		}
		if (!Number.isFinite(item.frame) || item.frame < 0) {
			throw new Error("Animation Window selected frames must be finite numbers greater than or equal to zero.");
		}
		const track = group.targetedAnimations[item.trackIndex].animation;
		if (!track.getKeys().some((key) => key.frame === item.frame)) {
			throw new Error(`Track ${item.trackIndex} has no key at frame ${item.frame}. Refresh the Animation Window and retry.`);
		}
		const componentCount = Math.max(1, getAnimationCurveComponentCount(track.dataType));
		if (item.component !== undefined && (!Number.isInteger(item.component) || item.component < 0 || item.component >= componentCount)) {
			throw new Error(`Track ${item.trackIndex} supports component indices 0 through ${componentCount - 1}.`);
		}
		const identity = `${item.trackIndex}:${item.frame}:${item.component ?? "*"}`;
		if (identities.has(identity)) {
			throw new Error(`Animation Window selection duplicates ${identity}.`);
		}
		identities.add(identity);
		normalized.push({ trackIndex: item.trackIndex, frame: item.frame, ...(item.component === undefined ? {} : { component: item.component }) });
	}
	return normalized;
}

function offsetAnimationKeyValue(key: any, component: number, delta: number): void {
	if (typeof key.value === "number") {
		if (component !== 0) {
			throw new Error("Scalar animation keys only support component 0.");
		}
		key.value += delta;
		return;
	}
	const components = animationValueComponents(key.value);
	if (component < 0 || component >= components.length) {
		throw new Error(`Animation value does not contain component ${component}.`);
	}
	key.value = setAnimationValueComponent(key.value, component, components[component] + delta);
}

function remapAnimationTangentModes(group: AnimationGroup, selection: Array<{ trackIndex: number; frame: number; component?: number }>, operation: string, data: any): any[] {
	const configurations = activeTangentModeConfigurations(group);
	if (!["move", "scale", "duplicate", "delete"].includes(operation)) {
		return configurations;
	}
	const frameDelta = Number(data.frameDelta ?? 0);
	const frameScale = Number(data.frameScale ?? 1);
	const pivotFrame = Number(data.pivotFrame ?? 0);
	const result: any[] = [];
	for (const configuration of configurations) {
		const trackIndex = group.targetedAnimations.findIndex(
			(targeted) => animationTargetIdentity(targeted.target) === configuration.targetId && targeted.animation.targetProperty === configuration.property
		);
		const selected = selection.some(
			(item) => item.trackIndex === trackIndex && item.frame === configuration.frame && (item.component === undefined || item.component === configuration.component)
		);
		if (!selected) {
			result.push(configuration);
			continue;
		}
		if (operation === "delete") {
			continue;
		}
		const frame = operation === "scale" ? pivotFrame + (configuration.frame - pivotFrame) * frameScale + frameDelta : configuration.frame + frameDelta;
		if (operation === "duplicate") {
			result.push(configuration, { ...configuration, frame });
		} else {
			result.push({ ...configuration, frame });
		}
	}
	return result;
}

/**
 * Applies an atomic multi-track Animation Window key operation using an exact clip fingerprint.
 * Selection is addressed by stable track index + source frame, with optional curve component.
 */
export function editAnimationWindowKeys(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const currentFingerprint = animationWindowFingerprint(group);
	if (data.expectedFingerprint !== currentFingerprint) {
		throw new Error("Animation clip changed after inspection. Call get_animation_window again and use its exact fingerprint.");
	}
	const selection = normalizeAnimationWindowSelection(group, data.selection);
	const operation = data.operation;
	if (!["move", "scale", "duplicate", "delete", "setInterpolation", "offsetValue"].includes(operation)) {
		throw new Error(`Unsupported Animation Window operation "${operation}".`);
	}
	if ((operation === "offsetValue" || (operation === "move" && Number(data.valueDelta ?? 0) !== 0)) && selection.some((item) => item.component === undefined)) {
		throw new Error("Animation Window value edits require an explicit component on every selected curve key.");
	}
	const originals = group.targetedAnimations.map((targeted) => targeted.animation.getKeys().map(cloneAnimationCurveKey));
	const working = originals.map((keys) => keys.map(cloneAnimationCurveKey));
	const selectedFramesByTrack = new Map<number, Set<number>>();
	for (const item of selection) {
		const frames = selectedFramesByTrack.get(item.trackIndex) ?? new Set<number>();
		frames.add(item.frame);
		selectedFramesByTrack.set(item.trackIndex, frames);
	}
	let changedKeyCount = 0;
	if (operation === "delete") {
		for (const [trackIndex, selectedFrames] of selectedFramesByTrack) {
			working[trackIndex] = working[trackIndex].filter((key) => !selectedFrames.has(key.frame));
			if (!working[trackIndex].length) {
				throw new Error(`Deleting the selection would leave track ${trackIndex} without keys.`);
			}
			changedKeyCount += selectedFrames.size;
		}
	} else if (operation === "offsetValue") {
		const delta = Number(data.valueDelta);
		if (!Number.isFinite(delta) || delta < -1000000000 || delta > 1000000000) {
			throw new Error("Animation Window valueDelta must be finite and between -1000000000 and 1000000000.");
		}
		for (const item of selection) {
			const component = item.component ?? 0;
			const key = working[item.trackIndex].find((candidate) => candidate.frame === item.frame)!;
			offsetAnimationKeyValue(key, component, delta);
			changedKeyCount++;
		}
	} else if (operation === "setInterpolation") {
		if (data.interpolation !== "linear" && data.interpolation !== "step") {
			throw new Error("Animation Window setInterpolation requires interpolation=linear or step.");
		}
		for (const [trackIndex, selectedFrames] of selectedFramesByTrack) {
			for (const key of working[trackIndex]) {
				if (selectedFrames.has(key.frame)) {
					key.interpolation = data.interpolation === "step" ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE;
					changedKeyCount++;
				}
			}
		}
	} else {
		const frameDelta = Number(data.frameDelta ?? 0);
		const scale = Number(data.frameScale ?? 1);
		const pivot = Number(data.pivotFrame ?? 0);
		const valueDelta = data.valueDelta === undefined ? 0 : Number(data.valueDelta);
		if (!Number.isFinite(frameDelta) || frameDelta < -1000000 || frameDelta > 1000000) {
			throw new Error("Animation Window frameDelta must be finite and between -1000000 and 1000000.");
		}
		if (!Number.isFinite(scale) || scale < 0.001 || scale > 1000) {
			throw new Error("Animation Window frameScale must be finite and between 0.001 and 1000.");
		}
		if (!Number.isFinite(pivot) || pivot < 0 || pivot > 1000000000) {
			throw new Error("Animation Window pivotFrame must be finite and between 0 and 1000000000.");
		}
		if (!Number.isFinite(valueDelta) || valueDelta < -1000000000 || valueDelta > 1000000000) {
			throw new Error("Animation Window valueDelta must be finite and between -1000000000 and 1000000000.");
		}
		if (operation === "duplicate" && frameDelta === 0) {
			throw new Error("Duplicating Animation Window keys requires a non-zero frameDelta.");
		}
		if (operation === "move" && frameDelta === 0 && valueDelta === 0) {
			throw new Error("Moving Animation Window keys requires a non-zero frameDelta or valueDelta.");
		}
		for (const [trackIndex, selectedFrames] of selectedFramesByTrack) {
			const selectedKeys = working[trackIndex].filter((key) => selectedFrames.has(key.frame));
			if (operation === "move" && valueDelta !== 0) {
				for (const item of selection.filter((candidate) => candidate.trackIndex === trackIndex)) {
					const key = selectedKeys.find((candidate) => candidate.frame === item.frame)!;
					offsetAnimationKeyValue(key, item.component ?? 0, valueDelta);
				}
			}
			const targets = selectedKeys.map((key) => ({
				key,
				frame: operation === "scale" ? pivot + (key.frame - pivot) * scale + frameDelta : key.frame + frameDelta,
			}));
			for (const target of targets) {
				if (!Number.isFinite(target.frame) || target.frame < 0 || target.frame > 1000000000) {
					throw new Error(`Animation Window operation produces invalid frame ${target.frame} on track ${trackIndex}.`);
				}
			}
			if (operation === "duplicate") {
				working[trackIndex].push(...targets.map((target) => ({ ...cloneAnimationCurveKey(target.key), frame: target.frame })));
			} else {
				targets.forEach((target) => (target.key.frame = target.frame));
			}
			changedKeyCount += selectedKeys.length;
		}
	}
	for (let trackIndex = 0; trackIndex < working.length; trackIndex++) {
		const frames = new Set<number>();
		for (const key of working[trackIndex]) {
			if (frames.has(key.frame)) {
				throw new Error(`Animation Window operation creates duplicate frame ${key.frame} on track ${trackIndex}.`);
			}
			frames.add(key.frame);
		}
		working[trackIndex].sort((left, right) => left.frame - right.frame);
	}
	const tangentModes = remapAnimationTangentModes(group, selection, operation, data);
	group.targetedAnimations.forEach((targeted, trackIndex) => targeted.animation.setKeys(working[trackIndex]));
	group.metadata[animationTangentModesMetadataKey] = tangentModes;
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { operation, changedKeyCount, window: getAnimationWindow(scene, { name: group.name }) };
}

/** Opens the shared standalone Animation Window on one existing clip. */
export function openAnimationWindow(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	options.editor.layout.selectTab("animations");
	options.editor.layout.animations.openAnimationWindow(group.name);
	return { opened: true, name: group.name, mode: "animation-window" };
}

function setAnimationValueComponent(value: any, component: number, scalar: number, zeroOtherComponents = false): any {
	const clone = value.clone?.() ?? value;
	const values = clone.asArray?.();
	if (!Array.isArray(values) || typeof clone.copyFromFloats !== "function") {
		throw new Error("This animation value type does not support component curve editing.");
	}
	const updated = zeroOtherComponents ? values.map(() => 0) : [...values];
	updated[component] = scalar;
	clone.copyFromFloats(...updated);
	return clone;
}

/** Replaces one component curve of a vector, color, or quaternion track while preserving every other component at each existing frame. */
export function setAnimationCurveComponentKeys(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const targeted = group.targetedAnimations[data.trackIndex];
	if (!targeted) {
		throw new Error(`Track index ${data.trackIndex} does not exist in animation group "${group.name}".`);
	}
	const componentCount = getAnimationCurveComponentCount(targeted.animation.dataType);
	if (!componentCount) {
		throw new Error(`Track ${data.trackIndex} is scalar or unsupported. Use set_animation_curve_keys for scalar tracks.`);
	}
	if (!Number.isInteger(data.component) || data.component < 0 || data.component >= componentCount) {
		throw new Error(`Track ${data.trackIndex} supports component indices 0 through ${componentCount - 1}.`);
	}
	if (!Array.isArray(data.keys) || !data.keys.length) {
		throw new Error("Component curve keys must contain at least one key.");
	}
	const existing = targeted.animation
		.getKeys()
		.slice()
		.sort((first, second) => first.frame - second.frame);
	if (existing.length !== data.keys.length) {
		throw new Error("Component curve keys must provide exactly one key for every existing vector track frame.");
	}
	const incoming = new Map<number, any>();
	for (const key of data.keys) {
		if (!Number.isFinite(key.frame) || key.frame < 0 || !Number.isFinite(key.value)) {
			throw new Error("Component curve frames and values must be finite, with frames greater than or equal to zero.");
		}
		if (key.inTangent !== undefined && !Number.isFinite(key.inTangent)) {
			throw new Error("Component curve incoming tangents must be finite numbers.");
		}
		if (key.outTangent !== undefined && !Number.isFinite(key.outTangent)) {
			throw new Error("Component curve outgoing tangents must be finite numbers.");
		}
		if (incoming.has(key.frame)) {
			throw new Error(`Component curve keys cannot share frame ${key.frame}.`);
		}
		incoming.set(key.frame, key);
	}
	if (existing.some((key) => !incoming.has(key.frame))) {
		throw new Error("Component curve key frames must match the existing vector track frames exactly.");
	}
	targeted.animation.setKeys(
		existing.map((existingKey) => {
			const key = incoming.get(existingKey.frame);
			return {
				frame: existingKey.frame,
				value: setAnimationValueComponent(existingKey.value, data.component, key.value),
				...(key.inTangent !== undefined
					? { inTangent: setAnimationValueComponent(existingKey.inTangent ?? existingKey.value, data.component, key.inTangent, existingKey.inTangent === undefined) }
					: existingKey.inTangent !== undefined
						? { inTangent: existingKey.inTangent }
						: {}),
				...(key.outTangent !== undefined
					? { outTangent: setAnimationValueComponent(existingKey.outTangent ?? existingKey.value, data.component, key.outTangent, existingKey.outTangent === undefined) }
					: existingKey.outTangent !== undefined
						? { outTangent: existingKey.outTangent }
						: {}),
				interpolation:
					key.interpolation === "step" ? AnimationKeyInterpolation.STEP : key.interpolation === "linear" ? AnimationKeyInterpolation.NONE : existingKey.interpolation,
			};
		})
	);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getAnimationGroup(scene, { name: group.name });
}

/** Updates one or both Hermite tangents for selected scalar or vector-curve keys without replacing their values. */
export function setAnimationCurveTangents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const targeted = group.targetedAnimations[data.trackIndex];
	if (!targeted) {
		throw new Error(`Track index ${data.trackIndex} does not exist in animation group "${group.name}".`);
	}
	const componentCount = getAnimationCurveComponentCount(targeted.animation.dataType);
	const component = data.component ?? 0;
	if (componentCount && (!Number.isInteger(component) || component < 0 || component >= componentCount)) {
		throw new Error(`Track ${data.trackIndex} supports component indices 0 through ${componentCount - 1}.`);
	}
	if (!componentCount && component !== 0) {
		throw new Error(`Track ${data.trackIndex} is scalar and only supports component 0.`);
	}
	if (!Array.isArray(data.keys) || !data.keys.length) {
		throw new Error("Curve tangent edits require at least one key.");
	}
	const edits = new Map<number, any>();
	for (const key of data.keys) {
		if (!Number.isFinite(key.frame)) {
			throw new Error("Curve tangent frames must be finite.");
		}
		if (key.inTangent === undefined && key.outTangent === undefined) {
			throw new Error("Each curve tangent edit requires inTangent, outTangent, or both.");
		}
		if (key.inTangent !== undefined && !Number.isFinite(key.inTangent)) {
			throw new Error("Curve incoming tangents must be finite numbers.");
		}
		if (key.outTangent !== undefined && !Number.isFinite(key.outTangent)) {
			throw new Error("Curve outgoing tangents must be finite numbers.");
		}
		if (edits.has(key.frame)) {
			throw new Error(`Curve tangent edits cannot share frame ${key.frame}.`);
		}
		edits.set(key.frame, key);
	}
	const existing = targeted.animation.getKeys();
	if ([...edits.keys()].some((frame) => !existing.some((key) => key.frame === frame))) {
		throw new Error("Every curve tangent edit frame must match an existing track key.");
	}
	targeted.animation.setKeys(
		existing.map((existingKey) => {
			const edit = edits.get(existingKey.frame);
			if (!edit) {
				return existingKey;
			}
			return {
				...existingKey,
				...(edit.inTangent !== undefined
					? {
							inTangent: componentCount
								? setAnimationValueComponent(existingKey.inTangent ?? existingKey.value, component, edit.inTangent, existingKey.inTangent === undefined)
								: edit.inTangent,
						}
					: {}),
				...(edit.outTangent !== undefined
					? {
							outTangent: componentCount
								? setAnimationValueComponent(existingKey.outTangent ?? existingKey.value, component, edit.outTangent, existingKey.outTangent === undefined)
								: edit.outTangent,
						}
					: {}),
			};
		})
	);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getAnimationGroup(scene, { name: group.name });
}

/** Recalculates centered tangents for every non-stepped key in a scalar, vector, color, or quaternion track. */
export function autoSmoothAnimationCurveTangents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const targeted = group.targetedAnimations[data.trackIndex];
	if (!targeted) {
		throw new Error(`Track index ${data.trackIndex} does not exist in animation group "${group.name}".`);
	}
	if (targeted.animation.getKeys().length < 2) {
		throw new Error("Automatic curve smoothing requires at least two keys.");
	}
	targeted.animation.setKeys(getAutoSmoothedAnimationKeys(targeted.animation.getKeys()));
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getAnimationGroup(scene, { name: group.name });
}

/** Samples one scalar or vector component of an AnimationGroup track for curve-editor visualization and external tools. */
export function sampleAnimationCurve(scene: Scene, data: any): any {
	const group = resolveGroup(scene, data.name);
	const targeted = group.targetedAnimations[data.trackIndex];
	if (!targeted) {
		throw new Error(`Track index ${data.trackIndex} does not exist in animation group "${group.name}".`);
	}
	const component = data.component ?? 0;
	if (!Number.isInteger(component) || component < 0 || component > 3) {
		throw new Error("Animation curve component must be an integer from 0 through 3.");
	}
	const samples = data.samples ?? 64;
	if (!Number.isInteger(samples) || samples < 2 || samples > 512) {
		throw new Error("Animation curve samples must be an integer from 2 through 512.");
	}
	const keys = targeted.animation
		.getKeys()
		.slice()
		.sort((first, second) => first.frame - second.frame);
	if (!keys.length) {
		return { name: group.name, trackIndex: data.trackIndex, component, samples: [] };
	}
	const valueOf = (value: any): number => (typeof value === "number" ? value : Array.isArray(value) ? value[component] : value.asArray?.()[component]) ?? 0;
	const from = data.from ?? keys[0].frame;
	const to = data.to ?? keys[keys.length - 1].frame;
	if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
		throw new Error("Animation curve range requires finite from/to frames with to >= from.");
	}
	const evaluate = (frame: number): number => valueOf(targeted.animation.evaluate(frame));
	return {
		name: group.name,
		trackIndex: data.trackIndex,
		property: targeted.animation.targetProperty,
		component,
		samples: Array.from({ length: samples }, (_, index) => {
			const frame = from + ((to - from) * index) / (samples - 1);
			return { frame, value: evaluate(frame) };
		}),
	};
}

/** Saves a serialized AnimationGroup to a project-relative JSON file. */
export async function exportAnimationGroup(scene: Scene, data: any): Promise<any> {
	const group = resolveGroup(scene, data.name);
	const absolutePath = resolveProjectPath(data.path);
	if ((await pathExists(absolutePath)) && data.overwrite !== true) {
		throw new Error(`Animation file exists at ${data.path}. Set overwrite: true to replace it.`);
	}
	await ensureDir(dirname(absolutePath));
	const temporaryPath = `${absolutePath}.${process.pid}-${Date.now()}.animation-export.tmp`;
	await remove(temporaryPath);
	try {
		await writeJSON(temporaryPath, group.serialize(), { spaces: "\t", encoding: "utf-8" });
		await move(temporaryPath, absolutePath, { overwrite: data.overwrite === true });
	} catch (error) {
		await remove(temporaryPath).catch(() => undefined);
		throw error;
	}
	return { exported: true, path: relative(dirname(projectConfiguration.path!), absolutePath) };
}

function restoreImportedAnimationTangentModes(group: AnimationGroup, serialized: any, resolvedTargets: Map<any, any>): number {
	const rawModes = serialized.metadata?.[animationTangentModesMetadataKey];
	if (rawModes === undefined) {
		return 0;
	}
	if (!Array.isArray(rawModes) || rawModes.length > 2_000_000) {
		throw new Error("Imported animation tangent metadata must be an array of at most 2,000,000 component entries.");
	}
	const sourceTargets = new Map<string, any>();
	for (const targeted of serialized.targetedAnimations) {
		const sourceTarget = String(targeted.targetId ?? targeted.targetName ?? "").trim();
		const target = resolvedTargets.get(targeted);
		const existing = sourceTargets.get(sourceTarget);
		if (existing && existing !== target) {
			throw new Error(`Animation source target "${sourceTarget}" resolves to multiple live targets.`);
		}
		sourceTargets.set(sourceTarget, target);
	}
	const working = new Map<any, any[]>();
	const remapped: any[] = [];
	const identities = new Set<string>();
	for (const [index, raw] of rawModes.entries()) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`Animation tangent metadata entry ${index} must be an object.`);
		}
		const sourceTarget = String(raw.targetId ?? "").trim();
		const property = typeof raw.property === "string" ? raw.property.trim() : "";
		const frame = raw.frame;
		const component = raw.component;
		const effectiveInTangent = raw.effectiveInTangent;
		const effectiveOutTangent = raw.effectiveOutTangent;
		if (!sourceTarget || sourceTarget.length > 512 || !property || property.length > 512) {
			throw new Error(`Animation tangent metadata entry ${index} requires bounded target and property identities.`);
		}
		if (!Number.isFinite(frame) || !Number.isInteger(component) || component < 0 || component > 3) {
			throw new Error(`Animation tangent metadata entry ${index} requires a finite frame and component from 0 through 3.`);
		}
		if (!Number.isFinite(effectiveInTangent) || !Number.isFinite(effectiveOutTangent)) {
			throw new Error(`Animation tangent metadata entry ${index} requires finite effective tangents.`);
		}
		const target = sourceTargets.get(sourceTarget);
		if (!target) {
			throw new Error(`Animation tangent metadata target "${sourceTarget}" cannot be resolved.`);
		}
		const targeted = group.targetedAnimations.find((candidate) => candidate.target === target && candidate.animation.targetProperty === property);
		if (!targeted) {
			throw new Error(`Animation tangent metadata track "${sourceTarget} · ${property}" cannot be resolved.`);
		}
		const componentCount = Math.max(1, getAnimationCurveComponentCount(targeted.animation.dataType));
		if (component >= componentCount) {
			throw new Error(`Animation tangent metadata component ${component} exceeds track "${property}".`);
		}
		const keyIdentity = `${sourceTarget}:${property}:${frame}:${component}`;
		if (identities.has(keyIdentity)) {
			throw new Error(`Animation tangent metadata duplicates ${keyIdentity}.`);
		}
		identities.add(keyIdentity);
		const keys = working.get(targeted) ?? targeted.animation.getKeys().map(cloneAnimationCurveKey);
		working.set(targeted, keys);
		const key = keys.find((candidate) => candidate.frame === frame);
		if (!key) {
			throw new Error(`Animation tangent metadata frame ${frame} does not exist on track "${property}".`);
		}
		setAnimationKeyTangentComponent(key, "inTangent", component, effectiveInTangent as number);
		setAnimationKeyTangentComponent(key, "outTangent", component, effectiveOutTangent as number);
		key.interpolation = AnimationKeyInterpolation.NONE;
		key.lockedTangent = raw.locked === true;
		remapped.push({ ...structuredClone(raw), targetId: animationTargetIdentity(target) });
	}
	for (const [targeted, keys] of working) {
		targeted.animation.setKeys(keys);
	}
	group.metadata ??= {};
	group.metadata[animationTangentModesMetadataKey] = remapped;
	return remapped.length;
}

function serializedUnityObjectReferenceCurves(serialized: Record<string, any>): IUnityAnimationObjectReferenceCurve[] {
	const metadata = serialized.metadata?.[UNITY_ANIMATION_CLIP_METADATA_KEY];
	return metadata && typeof metadata === "object" && !Array.isArray(metadata) && Array.isArray(metadata.objectReferenceCurves)
		? (metadata.objectReferenceCurves as IUnityAnimationObjectReferenceCurve[])
		: [];
}

async function compileUnityObjectReferenceBindings(
	scene: Scene,
	curves: IUnityAnimationObjectReferenceCurve[],
	requested: unknown
): Promise<IUnityAnimationObjectReferenceBinding[]> {
	const inputs = Array.isArray(requested) ? requested : [];
	if (inputs.length !== curves.length) {
		throw new Error(`Unity object-reference import requires exactly ${curves.length} curve binding(s); received ${inputs.length}.`);
	}
	const expectedCurves = new Map(curves.map((curve) => [curve.id, curve]));
	const compiled: IUnityAnimationObjectReferenceBinding[] = [];
	for (const [bindingIndex, candidate] of inputs.entries()) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error(`Unity object-reference curve binding ${bindingIndex} must be an object.`);
		}
		const input = candidate as Record<string, any>;
		const curveId = typeof input.curveId === "string" ? input.curveId.trim() : "";
		const curve = expectedCurves.get(curveId);
		if (!curve) {
			throw new Error(`Unity object-reference curve binding ${bindingIndex} uses unknown or duplicate curveId "${curveId}".`);
		}
		expectedCurves.delete(curveId);
		const propertyPath = validateUnityAnimationDestinationPropertyPath(typeof input.propertyPath === "string" ? input.propertyPath : "");
		const references = Array.isArray(input.references) ? input.references : [];
		if (references.length !== curve.references.length) {
			throw new Error(`Unity object-reference curve "${curve.id}" requires exactly ${curve.references.length} reference value binding(s).`);
		}
		const expectedReferences = new Set(curve.references.map((reference) => reference.key));
		const compiledReferences: IUnityAnimationObjectReferenceBinding["references"] = [];
		for (const [referenceIndex, referenceCandidate] of references.entries()) {
			if (!referenceCandidate || typeof referenceCandidate !== "object" || Array.isArray(referenceCandidate)) {
				throw new Error(`Unity object-reference curve "${curve.id}" reference binding ${referenceIndex} must be an object.`);
			}
			const referenceInput = referenceCandidate as Record<string, any>;
			const referenceKey = typeof referenceInput.referenceKey === "string" ? referenceInput.referenceKey : "";
			if (!expectedReferences.delete(referenceKey)) {
				throw new Error(`Unity object-reference curve "${curve.id}" uses unknown or duplicate referenceKey "${referenceKey}".`);
			}
			const value = referenceInput.value;
			if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") {
				throw new Error(`Unity object-reference curve "${curve.id}" reference "${referenceKey}" requires one typed value object.`);
			}
			if (value.kind === "null") {
				compiledReferences.push({ referenceKey, value: { kind: "null" } });
			} else if (value.kind === "number") {
				if (typeof value.value !== "number" || !Number.isFinite(value.value) || Math.abs(value.value) > 1_000_000_000) {
					throw new Error(`Unity object-reference number binding "${referenceKey}" must be finite and within ±1,000,000,000.`);
				}
				compiledReferences.push({ referenceKey, value: { kind: "number", value: value.value } });
			} else if (value.kind === "boolean") {
				if (typeof value.value !== "boolean") {
					throw new Error(`Unity object-reference boolean binding "${referenceKey}" requires a boolean value.`);
				}
				compiledReferences.push({ referenceKey, value: { kind: "boolean", value: value.value } });
			} else if (value.kind === "string") {
				if (typeof value.value !== "string" || value.value.length > 4096) {
					throw new Error(`Unity object-reference string binding "${referenceKey}" requires at most 4096 characters.`);
				}
				compiledReferences.push({ referenceKey, value: { kind: "string", value: value.value } });
			} else if (value.kind === "node") {
				if ((value.nodeId ? 1 : 0) + (value.nodeName ? 1 : 0) !== 1) {
					throw new Error(`Unity object-reference node binding "${referenceKey}" requires exactly one nodeId or nodeName.`);
				}
				const node = resolveNode({ scene, nodeId: value.nodeId, nodeName: value.nodeName });
				compiledReferences.push({ referenceKey, value: { kind: "node", id: node.id } });
			} else if (value.kind === "material") {
				if ((value.materialId ? 1 : 0) + (value.materialName ? 1 : 0) !== 1) {
					throw new Error(`Unity object-reference material binding "${referenceKey}" requires exactly one materialId or materialName.`);
				}
				const matches = value.materialId
					? scene.materials.filter((material) => material.id === value.materialId)
					: scene.materials.filter((material) => material.name === value.materialName);
				if (matches.length !== 1) {
					throw new Error(`Unity object-reference material binding "${referenceKey}" resolved ${matches.length} material(s); exactly one is required.`);
				}
				compiledReferences.push({ referenceKey, value: { kind: "material", id: matches[0].id } });
			} else if (value.kind === "texture") {
				if (typeof value.path !== "string" || !value.path.trim() || value.path.length > 1024) {
					throw new Error(`Unity object-reference texture binding "${referenceKey}" requires a project-relative path.`);
				}
				const absolutePath = resolveProjectPath(value.path);
				if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
					throw new Error(`Unity object-reference texture binding "${referenceKey}" does not resolve to an existing project file.`);
				}
				compiledReferences.push({
					referenceKey,
					value: { kind: "texture", path: relative(dirname(projectConfiguration.path!), absolutePath).replace(/\\/g, "/") },
				});
			} else {
				throw new Error(`Unity object-reference binding "${referenceKey}" kind must be null, number, boolean, string, node, material, or texture.`);
			}
		}
		compiled.push({ curveId, propertyPath, references: compiledReferences });
	}
	return compiled;
}

/** Imports an AnimationGroup previously serialized by the editor. */
export async function importAnimationGroup(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath))) {
		throw new Error("Animation imports require an existing project file.");
	}
	const details = await stat(absolutePath);
	if (details.isDirectory()) {
		throw new Error("Animation imports require an existing project file.");
	}
	if (details.size > 64 * 1024 * 1024) {
		throw new Error("Animation import files are limited to 64 MiB.");
	}
	const serialized = await readJSON(absolutePath, { encoding: "utf-8" });
	const unitySource = data.unitySourceAssetPath ? await getUnityAnimationSourceEvidence(resolveProjectPath(data.unitySourceAssetPath), data.unityFileId ?? "7400000") : null;
	if (data.unitySourceAssetPath && !unitySource) {
		throw new Error("The Unity source asset has no exact indexed .meta GUID/content evidence. Refresh the Asset Registry before importing.");
	}
	if (!serialized || typeof serialized !== "object" || Array.isArray(serialized) || !Array.isArray(serialized.targetedAnimations)) {
		throw new Error("Animation import files must contain one serialized AnimationGroup object.");
	}
	if (serialized.targetedAnimations.length < 1 || serialized.targetedAnimations.length > 8192) {
		throw new Error("Animation imports require between 1 and 8192 targeted tracks.");
	}
	const keyCount = serialized.targetedAnimations.reduce((sum: number, targeted: any) => sum + (Array.isArray(targeted?.animation?.keys) ? targeted.animation.keys.length : 0), 0);
	if (keyCount > 2_000_000) {
		throw new Error("Animation imports are limited to 2,000,000 keys.");
	}
	const unityObjectReferenceCurves = serializedUnityObjectReferenceCurves(serialized);
	const unityObjectReferenceBindings = await compileUnityObjectReferenceBindings(scene, unityObjectReferenceCurves, data.objectReferenceBindings);
	const requestedBindings = Array.isArray(data.targetBindings) ? data.targetBindings : [];
	if (requestedBindings.length > 2048) {
		throw new Error("Animation imports support at most 2048 explicit target bindings.");
	}
	const bindings = new Map<string, { target: any; evidence: Record<string, unknown> }>();
	for (const [index, binding] of requestedBindings.entries()) {
		if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
			throw new Error(`Animation target binding ${index} must be an object.`);
		}
		const sourceTarget = typeof binding.sourceTarget === "string" ? binding.sourceTarget.trim() : "";
		if (!sourceTarget || sourceTarget.length > 512) {
			throw new Error(`Animation target binding ${index} requires a sourceTarget from 1 through 512 characters.`);
		}
		if (bindings.has(sourceTarget)) {
			throw new Error(`Animation target binding sourceTarget "${sourceTarget}" is duplicated.`);
		}
		if (binding.kind === "node") {
			if ((binding.nodeId ? 1 : 0) + (binding.nodeName ? 1 : 0) !== 1) {
				throw new Error(`Node binding "${sourceTarget}" requires exactly one of nodeId or nodeName.`);
			}
			const node = resolveNode({ scene, nodeId: binding.nodeId, nodeName: binding.nodeName });
			bindings.set(sourceTarget, { target: node, evidence: { sourceTarget, kind: "node", targetId: node.id, targetName: node.name } });
		} else if (binding.kind === "morphTarget") {
			if ((binding.meshId ? 1 : 0) + (binding.meshName ? 1 : 0) !== 1 || typeof binding.morphTargetName !== "string" || !binding.morphTargetName.trim()) {
				throw new Error(`Morph-target binding "${sourceTarget}" requires exactly one meshId/meshName and one non-empty morphTargetName.`);
			}
			const mesh = resolveNode({ scene, nodeId: binding.meshId, nodeName: binding.meshName }) as any;
			const manager = mesh.morphTargetManager;
			if (!manager) {
				throw new Error(`Morph-target binding mesh "${mesh.name}" has no MorphTargetManager.`);
			}
			const matches = Array.from({ length: manager.numTargets }, (_, targetIndex) => manager.getTarget(targetIndex)).filter(
				(target: any) => target.name === binding.morphTargetName
			);
			if (matches.length !== 1) {
				throw new Error(
					`Morph-target binding "${sourceTarget}" resolved ${matches.length} targets named "${binding.morphTargetName}" on mesh "${mesh.name}"; exactly one is required.`
				);
			}
			const target = matches[0] as any;
			bindings.set(sourceTarget, {
				target,
				evidence: { sourceTarget, kind: "morphTarget", meshId: mesh.id, meshName: mesh.name, targetId: target.id, targetName: target.name },
			});
		} else if (binding.kind === "sprite") {
			if (typeof binding.spriteName !== "string" || !binding.spriteName.trim() || (binding.managerName !== undefined && typeof binding.managerName !== "string")) {
				throw new Error(`Sprite binding "${sourceTarget}" requires a non-empty spriteName and optional managerName.`);
			}
			const managers = (scene.spriteManagers ?? []).filter((manager) => !binding.managerName || manager.name === binding.managerName);
			const matches = managers.flatMap((manager) => manager.sprites.filter((sprite) => sprite.name === binding.spriteName).map((sprite) => ({ manager, sprite })));
			if (matches.length !== 1) {
				throw new Error(`Sprite binding "${sourceTarget}" resolved ${matches.length} sprite(s); provide an exact managerName when names are ambiguous.`);
			}
			bindings.set(sourceTarget, {
				target: matches[0].sprite,
				evidence: { sourceTarget, kind: "sprite", managerName: matches[0].manager.name, targetName: matches[0].sprite.name },
			});
		} else {
			throw new Error(`Animation target binding "${sourceTarget}" kind must be node, morphTarget, or sprite.`);
		}
	}
	const resolvedTargets = new Map<any, any>();
	const usedBindings = new Set<string>();
	for (const [index, targeted] of serialized.targetedAnimations.entries()) {
		if (!targeted || typeof targeted !== "object" || Array.isArray(targeted) || !targeted.animation || typeof targeted.animation !== "object") {
			throw new Error(`Animation target ${index} must contain a serialized animation object.`);
		}
		const sourceTarget = String(targeted.targetId ?? targeted.targetName ?? "").trim();
		if (!sourceTarget || sourceTarget.length > 512) {
			throw new Error(`Animation target ${index} requires targetId or targetName from 1 through 512 characters.`);
		}
		const explicit = bindings.get(sourceTarget);
		let target = explicit?.target;
		if (explicit) {
			usedBindings.add(sourceTarget);
		} else if (targeted.animation.property === "influence") {
			target = scene.getMorphTargetById(sourceTarget);
		} else {
			target = scene.getNodeById(sourceTarget) ?? scene.getNodeByName(String(targeted.targetName ?? sourceTarget));
		}
		if (!target) {
			throw new Error(`Animation target "${sourceTarget}" cannot be resolved. Provide an exact targetBindings entry before importing.`);
		}
		resolvedTargets.set(targeted, target);
	}
	const unusedBindings = [...bindings.keys()].filter((sourceTarget) => !usedBindings.has(sourceTarget));
	if (unusedBindings.length) {
		throw new Error(`Animation target binding(s) do not match this clip: ${unusedBindings.join(", ")}.`);
	}
	const finalName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : serialized.name;
	if (typeof finalName !== "string" || !finalName || finalName.length > 256) {
		throw new Error("Imported AnimationGroup names must contain 1 through 256 characters.");
	}
	const existing = scene.getAnimationGroupByName(finalName);
	if (existing && data.replaceExisting !== true) {
		throw new Error(`AnimationGroup "${finalName}" already exists. Set replaceExisting=true to replace it after successful validation.`);
	}
	const groupsBefore = new Set(scene.animationGroups);
	let group: AnimationGroup;
	try {
		group = AnimationGroup.Parse(serialized, scene, (targeted) => resolvedTargets.get(targeted) ?? null);
		if (group.targetedAnimations.length !== serialized.targetedAnimations.length) {
			throw new Error("AnimationGroup parsing did not retain every validated target track.");
		}
		restoreImportedAnimationTangentModes(group, serialized, resolvedTargets);
	} catch (error) {
		for (const created of scene.animationGroups.filter((candidate) => !groupsBefore.has(candidate))) {
			created.dispose();
		}
		throw error;
	}
	group.name = finalName;
	try {
		group.metadata = {
			...(group.metadata && typeof group.metadata === "object" ? group.metadata : {}),
			babylonEditorAnimationImportBindings: [...bindings.values()].map((binding) => binding.evidence),
			...(unitySource ? { [UNITY_ANIMATION_SOURCE_METADATA_KEY]: unitySource } : {}),
		};
		if (unityObjectReferenceCurves.length) {
			const unityMetadata = group.metadata[UNITY_ANIMATION_CLIP_METADATA_KEY];
			if (!unityMetadata || typeof unityMetadata !== "object" || Array.isArray(unityMetadata)) {
				throw new Error("Converted Unity object-reference tracks are missing their persisted clip metadata.");
			}
			unityMetadata.objectReferenceBindings = structuredClone(unityObjectReferenceBindings);
		}
		configureUnityAnimationClipRuntime(scene as any, getProjectAssetsRootUrl() ?? "");
	} catch (error) {
		group.dispose();
		throw error;
	}
	if (existing && existing !== group) {
		existing.dispose();
	}
	const unityRuntimeEvidence = getUnityAnimationClipRuntimeEvidence(group as any);
	if (data.preserveInspectorSelection !== true) {
		options.editor.layout.inspector.setEditedObject(scene);
		options.editor.layout.inspector.forceUpdate();
	}
	return {
		imported: true,
		replaced: existing !== null,
		path: relative(dirname(projectConfiguration.path!), absolutePath).replace(/\\/g, "/"),
		bindingCount: bindings.size,
		bindings: [...bindings.values()].map((binding) => binding.evidence),
		objectReferenceBindingCount: unityObjectReferenceBindings.length,
		objectReferenceBindings: structuredClone(unityObjectReferenceBindings),
		unityRuntimeEvidence: unityRuntimeEvidence ?? null,
		unitySource,
		...getAnimationGroup(scene, { name: group.name }),
	};
}

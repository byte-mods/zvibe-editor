import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { createHash } from "node:crypto";
import { pathExists, readJSON, writeJSON } from "fs-extra";

import { Scene, Animation, AnimationEvent, AnimationGroup, AnimationKeyInterpolation, Vector2, Vector3, Color3, Quaternion } from "babylonjs";

import { projectConfiguration } from "../../project/configuration";
import { cloneAnimationCurveKey, getAutoSmoothedAnimationKeys } from "../../tools/animation/curve";

import { IMCPActionOptions } from "../action";
import { resolveNode, coerceValueForExistingProperty } from "../tools/resolve";

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

	group.dispose();

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
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorAnimationEvents ??= []);
}

function executeAnimationEvent(scene: Scene, groupName: string, event: any): void {
	const log = (scene.metadata.babylonEditorAnimationEventLog ??= []);
	log.push({ groupName, frame: event.frame, action: event.action, parameter: event.parameter ?? null });
	if (log.length > 128) {
		log.splice(0, log.length - 128);
	}
	if (event.action === "setEnabled") {
		const node = resolveNode({ scene, nodeId: event.nodeId, nodeName: event.nodeName });
		node.setEnabled(event.enabled ?? true);
	} else if (event.action === "playAnimationGroup") {
		resolveGroup(scene, event.animationGroupName).play(event.loop ?? true);
	} else if (event.action === "stopAnimationGroup") {
		resolveGroup(scene, event.animationGroupName).stop();
	}
}

function attachAnimationEvents(scene: Scene, group: AnimationGroup, events: any[]): void {
	const animation = group.targetedAnimations[0]?.animation;
	if (!animation) {
		throw new Error(`Animation group "${group.name}" has no tracks to receive animation events.`);
	}
	for (const frame of new Set(animation.getEvents().map((event) => event.frame))) {
		animation.removeEvents(frame);
	}
	for (const event of events) {
		animation.addEvent(new AnimationEvent(event.frame, () => executeAnimationEvent(scene, group.name, event), event.onlyOnce ?? false));
	}
}

/** Restores persisted animation-event callbacks after animation groups have loaded. */
export function restoreAnimationEvents(scene: Scene): void {
	for (const configuration of eventConfigurations(scene)) {
		const group = scene.getAnimationGroupByName(configuration.groupName);
		if (group) {
			attachAnimationEvents(scene, group, configuration.events);
		}
	}
}

/** Lists persisted animation events and recent callback activity. */
export function listAnimationEvents(scene: Scene, data: any): any {
	const configurations = eventConfigurations(scene);
	const matching = data.name ? configurations.filter((configuration) => configuration.groupName === data.name) : configurations;
	return { groups: structuredClone(matching), recentEvents: structuredClone(scene.metadata?.babylonEditorAnimationEventLog ?? []) };
}

/** Replaces one animation group's persisted frame-event callbacks. */
export function setAnimationEvents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const group = resolveGroup(scene, data.name);
	const events = data.events ?? [];
	if (!Array.isArray(events)) {
		throw new Error("Animation events must be an array.");
	}
	for (const event of events) {
		if (!Number.isFinite(event.frame)) {
			throw new Error("Every animation event frame must be finite.");
		}
		if (!(["log", "setEnabled", "playAnimationGroup", "stopAnimationGroup"] as const).includes(event.action)) {
			throw new Error(`Unsupported animation event action "${event.action}".`);
		}
		if (event.action === "setEnabled" && !event.nodeId && !event.nodeName) {
			throw new Error("setEnabled animation events require nodeId or nodeName.");
		}
		if ((event.action === "playAnimationGroup" || event.action === "stopAnimationGroup") && !event.animationGroupName) {
			throw new Error(`${event.action} animation events require animationGroupName.`);
		}
	}
	const configuration = { groupName: group.name, events: structuredClone(events) };
	const index = eventConfigurations(scene).findIndex((candidate) => candidate.groupName === group.name);
	if (index === -1) {
		eventConfigurations(scene).push(configuration);
	} else {
		eventConfigurations(scene)[index] = configuration;
	}
	attachAnimationEvents(scene, group, events);
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

function animationWindowFingerprint(group: AnimationGroup): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				name: group.name,
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
	group.targetedAnimations.forEach((targeted, trackIndex) => targeted.animation.setKeys(working[trackIndex]));
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
	const evaluate = (frame: number): number => {
		const rightIndex = keys.findIndex((key) => key.frame >= frame);
		if (rightIndex <= 0) {
			return valueOf(keys[0].value);
		}
		if (rightIndex === -1) {
			return valueOf(keys[keys.length - 1].value);
		}
		const left = keys[rightIndex - 1];
		const right = keys[rightIndex];
		if (left.interpolation === AnimationKeyInterpolation.STEP) {
			return valueOf(left.value);
		}
		const amount = (frame - left.frame) / (right.frame - left.frame);
		return valueOf(left.value) + (valueOf(right.value) - valueOf(left.value)) * amount;
	};
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
	await writeJSON(absolutePath, group.serialize(), { spaces: "\t", encoding: "utf-8" });
	return { exported: true, path: relative(dirname(projectConfiguration.path!), absolutePath) };
}

/** Imports an AnimationGroup previously serialized by the editor. */
export async function importAnimationGroup(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	const serialized = await readJSON(absolutePath, { encoding: "utf-8" });
	const existing = scene.getAnimationGroupByName(data.name ?? serialized.name);
	existing?.dispose();
	const group = AnimationGroup.Parse(serialized, scene);
	if (data.name) {
		group.name = data.name;
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getAnimationGroup(scene, { name: group.name });
}

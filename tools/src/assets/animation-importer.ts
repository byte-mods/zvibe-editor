import { basename, extname } from "path/posix";

import { Animation } from "@babylonjs/core/Animations/animation";
import { IAnimationKey } from "@babylonjs/core/Animations/animationKey";

import {
	AnimatorControllerImportFormat,
	convertUnityAnimatorController,
	IAnimatorControllerAvatarMaskBinding,
	IAnimatorControllerMotionBinding,
	isImportedAnimatorControllerDocument,
} from "./unity-animator-controller";

export interface IAnimationImporterSettings {
	importClips: boolean;
	resampleRate: number;
	compression: "none" | "keyframeReduction";
	loopByDefault: boolean;
	rootMotionNode: string;
}

export type AnimationImporterSourceKind = "animation-group" | "animation-track-set" | "animator-controller";

export interface IAnimationImporterTrackResult {
	name: string;
	property: string;
	target: string | null;
	sourceFramesPerSecond: number;
	outputFramesPerSecond: number;
	from: number;
	to: number;
	durationSeconds: number;
	sourceKeyCount: number;
	sampledKeyCount: number;
	outputKeyCount: number;
}

export interface IAnimationImporterClipResult {
	name: string;
	from: number;
	to: number;
	durationSeconds: number;
	trackCount: number;
	sourceKeyCount: number;
	sampledKeyCount: number;
	outputKeyCount: number;
	loop: boolean;
}

export interface IAnimationImporterRootMotionResult {
	requestedNode: string;
	resolved: boolean;
	trackCount: number;
	properties: string[];
}

export interface IAnimationImporterResult {
	sourcePath: string;
	outputPath: string;
	sourceKind: AnimationImporterSourceKind;
	settings: IAnimationImporterSettings;
	sourceBytes: number;
	clips: IAnimationImporterClipResult[];
	tracks: IAnimationImporterTrackResult[];
	rootMotion: IAnimationImporterRootMotionResult | null;
	controllerStateCount: number;
	controllerTransitionCount: number;
	controllerFormat?: AnimatorControllerImportFormat;
	controllerLayerCount?: number;
	controllerParameterCount?: number;
	controllerBlendTreeCount?: number;
	controllerMotionBindings?: IAnimatorControllerMotionBinding[];
	controllerAvatarMaskBindings?: IAnimatorControllerAvatarMaskBinding[];
	controllerUnsupportedFeatures?: string[];
	sourceKeyCount: number;
	sampledKeyCount: number;
	outputKeyCount: number;
	reducedKeyCount: number;
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface IExecutedAnimationImport {
	document: unknown;
	sourceKind: AnimationImporterSourceKind;
	clips: IAnimationImporterClipResult[];
	tracks: IAnimationImporterTrackResult[];
	rootMotion: IAnimationImporterRootMotionResult | null;
	controllerStateCount: number;
	controllerTransitionCount: number;
	controllerFormat?: AnimatorControllerImportFormat;
	controllerLayerCount?: number;
	controllerParameterCount?: number;
	controllerBlendTreeCount?: number;
	controllerMotionBindings?: IAnimatorControllerMotionBinding[];
	controllerAvatarMaskBindings?: IAnimatorControllerAvatarMaskBinding[];
	controllerUnsupportedFeatures?: string[];
	sourceKeyCount: number;
	sampledKeyCount: number;
	outputKeyCount: number;
	errors: string[];
	warnings: string[];
}

const MAX_CLIPS = 512;
const MAX_TRACKS = 8192;
const MAX_KEYS = 2_000_000;
const KEY_REDUCTION_TOLERANCE = 0.00001;

export function normalizeAnimationImporterSettings(settings: Record<string, unknown>): IAnimationImporterSettings {
	const resampleRate = typeof settings.resampleRate === "number" && Number.isFinite(settings.resampleRate) ? Math.round(settings.resampleRate) : 60;
	return {
		importClips: settings.importClips !== false,
		resampleRate: Math.min(240, Math.max(1, resampleRate)),
		compression: settings.compression === "none" ? "none" : "keyframeReduction",
		loopByDefault: settings.loopByDefault === true,
		rootMotionNode: typeof settings.rootMotionNode === "string" ? settings.rootMotionNode.trim().slice(0, 512) : "",
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function animationTarget(targeted: Record<string, unknown>): string | null {
	const value = targeted.targetName ?? targeted.targetId ?? targeted.targetUniqueId;
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function valueComponents(value: unknown): number[] | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return [value];
	}
	if (value && typeof value === "object") {
		const array = (value as { asArray?: () => unknown }).asArray?.();
		if (Array.isArray(array) && array.every((component) => typeof component === "number" && Number.isFinite(component))) {
			return array;
		}
	}
	return null;
}

function canRemoveKey(previous: IAnimationKey, current: IAnimationKey, next: IAnimationKey): boolean {
	const previousValues = valueComponents(previous.value);
	const currentValues = valueComponents(current.value);
	const nextValues = valueComponents(next.value);
	if (!previousValues || !currentValues || !nextValues || previousValues.length !== currentValues.length || currentValues.length !== nextValues.length) {
		return false;
	}
	const frameRange = next.frame - previous.frame;
	if (!Number.isFinite(frameRange) || frameRange <= 0) {
		return false;
	}
	const amount = (current.frame - previous.frame) / frameRange;
	return currentValues.every(
		(component, index) => Math.abs(component - (previousValues[index] + (nextValues[index] - previousValues[index]) * amount)) <= KEY_REDUCTION_TOLERANCE
	);
}

function reduceKeys(keys: IAnimationKey[]): IAnimationKey[] {
	let result = keys;
	let changed = true;
	while (changed && result.length > 2) {
		changed = false;
		const next: IAnimationKey[] = [result[0]];
		for (let index = 1; index < result.length - 1; index++) {
			if (canRemoveKey(next[next.length - 1], result[index], result[index + 1])) {
				changed = true;
			} else {
				next.push(result[index]);
			}
		}
		next.push(result[result.length - 1]);
		result = next;
	}
	return result;
}

function resampleAnimation(
	serialized: Record<string, unknown>,
	settings: IAnimationImporterSettings
): { serialized: Record<string, unknown>; result: Omit<IAnimationImporterTrackResult, "target"> } {
	const animation = Animation.Parse(serialized);
	const sourceFramesPerSecond = animation.framePerSecond;
	if (!Number.isFinite(sourceFramesPerSecond) || sourceFramesPerSecond <= 0) {
		throw new Error(`Animation "${animation.name}" has an invalid frame rate.`);
	}
	const sourceKeys = animation
		.getKeys()
		.slice()
		.sort((left, right) => left.frame - right.frame);
	if (!sourceKeys.length) {
		throw new Error(`Animation "${animation.name}" has no keys.`);
	}
	if (sourceKeys.some((key) => !Number.isFinite(key.frame))) {
		throw new Error(`Animation "${animation.name}" contains a non-finite key frame.`);
	}
	const sourceFrom = sourceKeys[0].frame;
	const sourceTo = sourceKeys[sourceKeys.length - 1].frame;
	const fromSeconds = sourceFrom / sourceFramesPerSecond;
	const toSeconds = sourceTo / sourceFramesPerSecond;
	const durationSeconds = Math.max(0, toSeconds - fromSeconds);
	const sampleCount = durationSeconds === 0 ? 0 : Math.max(1, Math.ceil(durationSeconds * settings.resampleRate));
	let outputKeys: IAnimationKey[] = Array.from({ length: sampleCount + 1 }, (_, index) => {
		const amount = sampleCount === 0 ? 0 : index / sampleCount;
		const sourceFrame = sourceFrom + (sourceTo - sourceFrom) * amount;
		const outputFrame = (fromSeconds + durationSeconds * amount) * settings.resampleRate;
		return { frame: outputFrame, value: animation.evaluate(sourceFrame) };
	});
	const sampledKeyCount = outputKeys.length;
	if (settings.compression === "keyframeReduction") {
		outputKeys = reduceKeys(outputKeys);
	}
	animation.framePerSecond = settings.resampleRate;
	animation.loopMode = settings.loopByDefault ? Animation.ANIMATIONLOOPMODE_CYCLE : Animation.ANIMATIONLOOPMODE_CONSTANT;
	animation.setKeys(outputKeys);
	const output = animation.serialize() as Record<string, unknown>;
	return {
		serialized: output,
		result: {
			name: animation.name,
			property: animation.targetProperty,
			sourceFramesPerSecond,
			outputFramesPerSecond: settings.resampleRate,
			from: outputKeys[0].frame,
			to: outputKeys[outputKeys.length - 1].frame,
			durationSeconds,
			sourceKeyCount: sourceKeys.length,
			sampledKeyCount,
			outputKeyCount: outputKeys.length,
		},
	};
}

interface IProcessedAnimationTrackEntry {
	animation: Record<string, unknown>;
	target: string | null;
	sourceIndex: number;
}

function processTracks(
	entries: Array<{ animation: Record<string, unknown>; target: string | null }>,
	settings: IAnimationImporterSettings
): { entries: IProcessedAnimationTrackEntry[]; tracks: IAnimationImporterTrackResult[]; errors: string[] } {
	if (entries.length > MAX_TRACKS) {
		return { entries: [], tracks: [], errors: [`Animation assets are limited to ${MAX_TRACKS} tracks.`] };
	}
	const sourceKeyCount = entries.reduce((sum, entry) => sum + (Array.isArray(entry.animation.keys) ? entry.animation.keys.length : 0), 0);
	if (sourceKeyCount > MAX_KEYS) {
		return { entries: [], tracks: [], errors: [`Animation assets are limited to ${MAX_KEYS} source keys.`] };
	}
	const output: IProcessedAnimationTrackEntry[] = [];
	const tracks: IAnimationImporterTrackResult[] = [];
	const errors: string[] = [];
	for (const [sourceIndex, entry] of entries.entries()) {
		try {
			const processed = resampleAnimation(entry.animation, settings);
			output.push({ animation: processed.serialized, target: entry.target, sourceIndex });
			tracks.push({ ...processed.result, target: entry.target });
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { entries: output, tracks, errors };
}

function clipFromTracks(name: string, tracks: IAnimationImporterTrackResult[], loop: boolean): IAnimationImporterClipResult {
	const from = tracks.length ? Math.min(...tracks.map((track) => track.from)) : 0;
	const to = tracks.length ? Math.max(...tracks.map((track) => track.to)) : 0;
	return {
		name,
		from,
		to,
		durationSeconds: tracks.length ? Math.max(...tracks.map((track) => track.durationSeconds)) : 0,
		trackCount: tracks.length,
		sourceKeyCount: tracks.reduce((sum, track) => sum + track.sourceKeyCount, 0),
		sampledKeyCount: tracks.reduce((sum, track) => sum + track.sampledKeyCount, 0),
		outputKeyCount: tracks.reduce((sum, track) => sum + track.outputKeyCount, 0),
		loop,
	};
}

function rootMotionResult(targetedAnimations: Record<string, unknown>[], settings: IAnimationImporterSettings): IAnimationImporterRootMotionResult | null {
	if (!settings.rootMotionNode) {
		return null;
	}
	const matched = targetedAnimations.filter((targeted) => animationTarget(targeted) === settings.rootMotionNode);
	const properties = [
		...new Set(
			matched
				.map((targeted) => record(targeted.animation)?.property)
				.filter(
					(property): property is string => typeof property === "string" && (property === "position" || property === "rotationQuaternion" || property === "rotation.y")
				)
		),
	];
	return {
		requestedNode: settings.rootMotionNode,
		resolved: properties.length > 0,
		trackCount: properties.length,
		properties,
	};
}

function processAnimationGroup(document: Record<string, unknown>, settings: IAnimationImporterSettings): IExecutedAnimationImport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const targetedAnimations = Array.isArray(document.targetedAnimations)
		? document.targetedAnimations.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
		: [];
	const rootMotion = rootMotionResult(targetedAnimations, settings);
	if (rootMotion && !rootMotion.resolved) {
		errors.push(`Root motion node "${settings.rootMotionNode}" has no position or Y-rotation track in this animation group.`);
	}
	if (!settings.importClips) {
		return {
			document: { ...structuredClone(document), from: 0, to: 0, loopAnimation: settings.loopByDefault, targetedAnimations: [] },
			sourceKind: "animation-group",
			clips: [],
			tracks: [],
			rootMotion,
			controllerStateCount: 0,
			controllerTransitionCount: 0,
			sourceKeyCount: targetedAnimations.reduce(
				(sum, targeted) => sum + (Array.isArray(record(targeted.animation)?.keys) ? (record(targeted.animation)!.keys as unknown[]).length : 0),
				0
			),
			sampledKeyCount: 0,
			outputKeyCount: 0,
			errors,
			warnings: ["Clip import is disabled; the processed animation group contains no tracks."],
		};
	}
	const validTargeted = targetedAnimations
		.map((targeted) => ({ targeted, animation: record(targeted.animation) }))
		.filter((entry): entry is { targeted: Record<string, unknown>; animation: Record<string, unknown> } => entry.animation !== null);
	if (validTargeted.length !== targetedAnimations.length) {
		errors.push("Every targeted animation entry must contain a serialized animation object.");
	}
	const entries = validTargeted.map((entry) => ({ animation: entry.animation, target: animationTarget(entry.targeted) }));
	const processed = processTracks(entries, settings);
	errors.push(...processed.errors);
	if (!entries.length) {
		errors.push("Animation group contains no valid targeted animation tracks.");
	}
	const processedTargetedAnimations = processed.entries.map((entry) => ({
		...structuredClone(validTargeted[entry.sourceIndex].targeted),
		animation: entry.animation,
	}));
	const clipName = typeof document.name === "string" && document.name.trim() ? document.name : "Animation";
	const clip = clipFromTracks(clipName, processed.tracks, settings.loopByDefault);
	return {
		document: {
			...structuredClone(document),
			from: clip.from,
			to: clip.to,
			loopAnimation: settings.loopByDefault,
			targetedAnimations: processedTargetedAnimations,
		},
		sourceKind: "animation-group",
		clips: [clip],
		tracks: processed.tracks,
		rootMotion,
		controllerStateCount: 0,
		controllerTransitionCount: 0,
		sourceKeyCount: clip.sourceKeyCount,
		sampledKeyCount: clip.sampledKeyCount,
		outputKeyCount: clip.outputKeyCount,
		errors,
		warnings,
	};
}

function processAnimationTrackSet(document: unknown[], sourcePath: string, settings: IAnimationImporterSettings): IExecutedAnimationImport {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (settings.rootMotionNode) {
		errors.push("Root motion node selection requires an AnimationGroup with target identities; legacy animation track sets do not contain targets.");
	}
	const entries = document
		.map(record)
		.filter((entry): entry is Record<string, unknown> => entry !== null)
		.map((animation) => ({ animation, target: null }));
	if (!settings.importClips) {
		return {
			document: [],
			sourceKind: "animation-track-set",
			clips: [],
			tracks: [],
			rootMotion: settings.rootMotionNode ? { requestedNode: settings.rootMotionNode, resolved: false, trackCount: 0, properties: [] } : null,
			controllerStateCount: 0,
			controllerTransitionCount: 0,
			sourceKeyCount: entries.reduce((sum, entry) => sum + (Array.isArray(entry.animation.keys) ? entry.animation.keys.length : 0), 0),
			sampledKeyCount: 0,
			outputKeyCount: 0,
			errors,
			warnings: ["Clip import is disabled; the processed animation track set is empty."],
		};
	}
	const processed = processTracks(entries, settings);
	errors.push(...processed.errors);
	if (!entries.length) {
		errors.push("Animation track set contains no serialized animations.");
	}
	const clipName = basename(sourcePath, extname(sourcePath)) || "Animations";
	const clip = clipFromTracks(clipName, processed.tracks, settings.loopByDefault);
	return {
		document: processed.entries.map((entry) => entry.animation),
		sourceKind: "animation-track-set",
		clips: [clip],
		tracks: processed.tracks,
		rootMotion: settings.rootMotionNode ? { requestedNode: settings.rootMotionNode, resolved: false, trackCount: 0, properties: [] } : null,
		controllerStateCount: 0,
		controllerTransitionCount: 0,
		sourceKeyCount: clip.sourceKeyCount,
		sampledKeyCount: clip.sampledKeyCount,
		outputKeyCount: clip.outputKeyCount,
		errors,
		warnings,
	};
}

function processAnimatorController(document: Record<string, unknown>, settings: IAnimationImporterSettings): IExecutedAnimationImport {
	const errors: string[] = [];
	const warnings: string[] = ["Resampling, key reduction, and loop defaults apply to animation clips, not Animator Controller documents."];
	const imported = isImportedAnimatorControllerDocument(document);
	const controller = imported ? record(document.controller)! : document;
	const machines = [
		controller,
		...((Array.isArray(controller.layers) ? controller.layers : []) as unknown[]),
		...((Array.isArray(controller.subgraphs) ? controller.subgraphs : []) as unknown[]),
	]
		.map(record)
		.filter((machine): machine is Record<string, unknown> => machine !== null);
	const states = machines.flatMap((machine) =>
		Array.isArray(machine.states) ? machine.states.map(record).filter((state): state is Record<string, unknown> => state !== null) : []
	);
	const transitions = machines.flatMap((machine) =>
		Array.isArray(machine.transitions) ? machine.transitions.map(record).filter((transition): transition is Record<string, unknown> => transition !== null) : []
	);
	const directStates = Array.isArray(controller.states) ? controller.states.map(record).filter((state): state is Record<string, unknown> => state !== null) : [];
	if (states.length > MAX_CLIPS) {
		errors.push(`Animator Controllers are limited to ${MAX_CLIPS} states.`);
	}
	const names = directStates.map((state) => state.name).filter((name): name is string => typeof name === "string" && name.length > 0);
	if (names.length !== directStates.length) {
		errors.push("Every Animator Controller state requires a non-empty name.");
	}
	if (new Set(names).size !== names.length) {
		errors.push("Animator Controller state names must be unique.");
	}
	const known = new Set(names);
	for (const transition of imported
		? []
		: Array.isArray(controller.transitions)
			? controller.transitions.map(record).filter((value): value is Record<string, unknown> => value !== null)
			: []) {
		const validFrom = typeof transition.from === "string" && (known.has(transition.from) || transition.from === "$any");
		const validTo = typeof transition.to === "string" && (known.has(transition.to) || transition.to === "$exit");
		if (!validFrom || !validTo) {
			errors.push("Every Animator Controller transition must reference existing from/to state names.");
			break;
		}
	}
	if (settings.rootMotionNode) {
		warnings.push("The importer rootMotionNode field is clip-specific; Animator Controller root motion remains in the controller's own rootMotion configuration.");
	}
	return {
		document: structuredClone(document),
		sourceKind: "animator-controller",
		clips: [],
		tracks: [],
		rootMotion: null,
		controllerStateCount: states.length,
		controllerTransitionCount: transitions.length,
		controllerFormat: imported ? document.sourceFormat : "babylon-json",
		controllerLayerCount: imported ? document.controller.layers.length + 1 : Array.isArray(controller.layers) ? controller.layers.length + 1 : 1,
		controllerParameterCount: imported ? Object.keys(document.controller.parameters).length : Object.keys(record(controller.parameters) ?? {}).length,
		controllerBlendTreeCount: states.filter((state) => record(state.blendTree) !== null).length,
		controllerMotionBindings: imported ? structuredClone(document.motionBindings) : [],
		controllerAvatarMaskBindings: imported ? structuredClone(document.avatarMaskBindings) : [],
		controllerUnsupportedFeatures: imported ? [...document.unsupportedFeatures] : [],
		sourceKeyCount: 0,
		sampledKeyCount: 0,
		outputKeyCount: 0,
		errors,
		warnings,
	};
}

/** Parses JSON animation assets or converts Unity multi-document YAML Animator Controllers before executing the shared importer contract. */
export function executeAnimationImporterSource(source: string, sourcePath: string, settings: IAnimationImporterSettings): IExecutedAnimationImport {
	const extension = extname(sourcePath).toLowerCase();
	const trimmed = source.trimStart();
	if ((extension === ".controller" || extension === ".animator") && (trimmed.startsWith("%YAML") || /^---\s+!u!\d+/m.test(trimmed))) {
		const conversion = convertUnityAnimatorController(source, sourcePath);
		return {
			document: conversion.document,
			sourceKind: "animator-controller",
			clips: [],
			tracks: [],
			rootMotion: null,
			controllerStateCount: conversion.stateCount,
			controllerTransitionCount: conversion.transitionCount,
			controllerFormat: "unity-yaml",
			controllerLayerCount: conversion.layerCount,
			controllerParameterCount: conversion.parameterCount,
			controllerBlendTreeCount: conversion.blendTreeCount,
			controllerMotionBindings: conversion.document.motionBindings,
			controllerAvatarMaskBindings: conversion.document.avatarMaskBindings,
			controllerUnsupportedFeatures: conversion.document.unsupportedFeatures,
			sourceKeyCount: 0,
			sampledKeyCount: 0,
			outputKeyCount: 0,
			errors: conversion.errors,
			warnings: conversion.warnings,
		};
	}
	let document: unknown;
	try {
		document = JSON.parse(source);
	} catch (error) {
		throw new Error(`Animation JSON or Unity Controller YAML is malformed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return executeAnimationImporterDocument(document, sourcePath, settings);
}

/** Executes the format-aware portion of the Animation Importer without reading or writing files. */
export function executeAnimationImporterDocument(document: unknown, sourcePath: string, settings: IAnimationImporterSettings): IExecutedAnimationImport {
	if (Array.isArray(document)) {
		return processAnimationTrackSet(document, sourcePath, settings);
	}
	const source = record(document);
	if (!source) {
		throw new Error("Animation asset JSON must be an object or an array of serialized animations.");
	}
	if (Array.isArray(source.targetedAnimations)) {
		return processAnimationGroup(source, settings);
	}
	if (
		Array.isArray(source.states) ||
		Array.isArray(source.transitions) ||
		extname(sourcePath).toLowerCase() === ".animator" ||
		extname(sourcePath).toLowerCase() === ".controller"
	) {
		return processAnimatorController(source, settings);
	}
	throw new Error("Animation JSON is neither a serialized AnimationGroup, legacy animation track set, nor Animator Controller.");
}

import { basenamePortablePath as basename, extnamePortablePath as extname } from "./portable-path";

import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationKeyInterpolation, IAnimationKey } from "@babylonjs/core/Animations/animationKey";

import {
	AnimatorControllerImportFormat,
	convertUnityAnimatorController,
	IAnimatorControllerAvatarMaskBinding,
	IAnimatorControllerBehaviourBinding,
	IAnimatorControllerMotionBinding,
	IUnityAnimatorControllerCompatibility,
	isImportedAnimatorControllerDocument,
} from "./unity-animator-controller";
import { convertUnityAnimationClip } from "./unity-animation-clip";
import { IUnityAnimationObjectReferenceCurve } from "../loading/unity-animation-clip-runtime";

export type AnimationImporterCompression = "none" | "keyframeReduction" | "keyframeReductionAndCompression" | "optimal";

export interface IAnimationImporterSettings {
	importClips: boolean;
	resampleCurves: boolean;
	resampleRate: number;
	compression: AnimationImporterCompression;
	positionErrorPercent: number;
	rotationErrorDegrees: number;
	scaleErrorPercent: number;
	floatError: number;
	quantizationBits: number;
	removeConstantScaleCurves: boolean;
	loopByDefault: boolean;
	rootMotionNode: string;
}

export type AnimationImporterSourceKind = "animation-group" | "animation-track-set" | "unity-animation-clip" | "animator-controller";

export type AnimationImporterSourceFormat =
	| "babylon-animation-group-json"
	| "babylon-animation-track-set-json"
	| "unity-animation-clip-yaml"
	| "babylon-animator-json"
	| "unity-animator-yaml";

export interface IAnimationImporterCompressionResult {
	requested: AnimationImporterCompression;
	effective: AnimationImporterCompression;
	errorMetric: "position-percent" | "rotation-degrees" | "scale-percent" | "absolute";
	allowedError: number;
	maximumObservedError: number;
	quantizationBits: number | null;
	protectedKeyCount: number;
	removedKeyCount: number;
}

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
	compression: IAnimationImporterCompressionResult;
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
	eventCount: number;
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
	sourceFormat: AnimationImporterSourceFormat;
	outputFormat: "babylon-animation-group-json" | "babylon-animation-track-set-json" | "babylon-animator-json";
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
	controllerBehaviourBindings?: IAnimatorControllerBehaviourBinding[];
	controllerBehaviourBindingCount?: number;
	controllerCompatibility?: IUnityAnimatorControllerCompatibility;
	controllerUnsupportedFeatures?: string[];
	activeStateCurveCount?: number;
	compressedRotationCurveCount?: number;
	objectReferenceCurves?: IUnityAnimationObjectReferenceCurve[];
	sourceKeyCount: number;
	sampledKeyCount: number;
	outputKeyCount: number;
	reducedKeyCount: number;
	removedConstantScaleTrackCount: number;
	roundTripSafe: boolean;
	preservedFeatures: string[];
	approximatedFeatures: string[];
	unsupportedFeatures: string[];
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface IExecutedAnimationImport {
	document: unknown;
	sourceKind: AnimationImporterSourceKind;
	sourceFormat: AnimationImporterSourceFormat;
	outputFormat: "babylon-animation-group-json" | "babylon-animation-track-set-json" | "babylon-animator-json";
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
	controllerBehaviourBindings?: IAnimatorControllerBehaviourBinding[];
	controllerBehaviourBindingCount?: number;
	controllerCompatibility?: IUnityAnimatorControllerCompatibility;
	controllerUnsupportedFeatures?: string[];
	activeStateCurveCount?: number;
	compressedRotationCurveCount?: number;
	objectReferenceCurves?: IUnityAnimationObjectReferenceCurve[];
	sourceKeyCount: number;
	sampledKeyCount: number;
	outputKeyCount: number;
	removedConstantScaleTrackCount: number;
	roundTripSafe: boolean;
	preservedFeatures: string[];
	approximatedFeatures: string[];
	unsupportedFeatures: string[];
	errors: string[];
	warnings: string[];
}

const MAX_CLIPS = 512;
const MAX_TRACKS = 8192;
const MAX_KEYS = 2_000_000;
const MAX_REDUCTION_SAMPLE_VISITS = 16_000_000;
const defaultPositionErrorPercent = 0.5;
const defaultRotationErrorDegrees = 0.5;
const defaultScaleErrorPercent = 0.5;
const defaultFloatError = 0.0005;

export function normalizeAnimationImporterSettings(settings: Record<string, unknown>): IAnimationImporterSettings {
	const resampleRate = typeof settings.resampleRate === "number" && Number.isFinite(settings.resampleRate) ? Math.round(settings.resampleRate) : 60;
	const compression = ["none", "keyframeReduction", "keyframeReductionAndCompression", "optimal"].includes(String(settings.compression))
		? (settings.compression as AnimationImporterCompression)
		: "keyframeReduction";
	const bounded = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
		typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
	return {
		importClips: settings.importClips !== false,
		resampleCurves: settings.resampleCurves !== false,
		resampleRate: Math.min(240, Math.max(1, resampleRate)),
		compression,
		positionErrorPercent: bounded(settings.positionErrorPercent, defaultPositionErrorPercent, 0, 100),
		rotationErrorDegrees: bounded(settings.rotationErrorDegrees, defaultRotationErrorDegrees, 0, 180),
		scaleErrorPercent: bounded(settings.scaleErrorPercent, defaultScaleErrorPercent, 0, 100),
		floatError: bounded(settings.floatError, defaultFloatError, 0, 1000000),
		quantizationBits: Math.round(bounded(settings.quantizationBits, 16, 8, 24)),
		removeConstantScaleCurves: settings.removeConstantScaleCurves === true,
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

type AnimationErrorMetric = IAnimationImporterCompressionResult["errorMetric"];

function cloneAnimationKey(key: IAnimationKey): IAnimationKey {
	const clone = (value: unknown): unknown => (value && typeof value === "object" && "clone" in value && typeof value.clone === "function" ? value.clone() : value);
	return {
		...key,
		value: clone(key.value),
		...(key.inTangent !== undefined ? { inTangent: clone(key.inTangent) } : {}),
		...(key.outTangent !== undefined ? { outTangent: clone(key.outTangent) } : {}),
	};
}

function compressionMetric(property: string, dataType: number, settings: IAnimationImporterSettings): { metric: AnimationErrorMetric; allowed: number } {
	const normalized = property.toLowerCase();
	if (normalized.includes("position")) {
		return { metric: "position-percent", allowed: settings.positionErrorPercent };
	}
	if (dataType === Animation.ANIMATIONTYPE_QUATERNION || normalized.includes("rotation")) {
		return { metric: "rotation-degrees", allowed: settings.rotationErrorDegrees };
	}
	if (normalized.includes("scal")) {
		return { metric: "scale-percent", allowed: settings.scaleErrorPercent };
	}
	return { metric: "absolute", allowed: settings.floatError };
}

function normalizedQuaternion(components: number[]): number[] {
	const length = Math.hypot(...components);
	return length > Number.EPSILON ? components.map((component) => component / length) : [0, 0, 0, 1];
}

function interpolateComponents(first: number[], second: number[], amount: number, quaternion: boolean): number[] {
	if (!quaternion) {
		return first.map((component, index) => component + (second[index] - component) * amount);
	}
	let left = normalizedQuaternion(first);
	let right = normalizedQuaternion(second);
	let dot = left.reduce((sum, component, index) => sum + component * right[index], 0);
	if (dot < 0) {
		right = right.map((component) => -component);
		dot = -dot;
	}
	if (dot > 0.9995) {
		return normalizedQuaternion(left.map((component, index) => component + (right[index] - component) * amount));
	}
	const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
	const denominator = Math.sin(angle);
	const leftWeight = Math.sin((1 - amount) * angle) / denominator;
	const rightWeight = Math.sin(amount * angle) / denominator;
	return left.map((component, index) => component * leftWeight + right[index] * rightWeight);
}

function positionRange(keys: IAnimationKey[]): number {
	const components = keys.map((key) => valueComponents(key.value)).filter((value): value is number[] => value !== null);
	if (!components.length) {
		return 1;
	}
	const dimensions = components[0].length;
	const minimum = Array(dimensions).fill(Number.POSITIVE_INFINITY);
	const maximum = Array(dimensions).fill(Number.NEGATIVE_INFINITY);
	for (const value of components) {
		for (let component = 0; component < dimensions; component++) {
			minimum[component] = Math.min(minimum[component], value[component]);
			maximum[component] = Math.max(maximum[component], value[component]);
		}
	}
	return Math.max(1e-9, Math.hypot(...minimum.map((value, index) => maximum[index] - value)));
}

function measuredError(expected: number[], actual: number[], metric: AnimationErrorMetric, range: number, quaternion: boolean): number {
	if (metric === "position-percent") {
		return (Math.hypot(...expected.map((component, index) => component - actual[index])) / range) * 100;
	}
	if (metric === "rotation-degrees") {
		if (quaternion) {
			const left = normalizedQuaternion(expected);
			const right = normalizedQuaternion(actual);
			const dot = Math.abs(left.reduce((sum, component, index) => sum + component * right[index], 0));
			return (2 * Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
		}
		return Math.max(...expected.map((component, index) => (Math.abs(component - actual[index]) * 180) / Math.PI));
	}
	if (metric === "scale-percent") {
		return Math.max(...expected.map((component, index) => (Math.abs(component - actual[index]) / Math.max(1e-9, Math.abs(component))) * 100));
	}
	return Math.max(...expected.map((component, index) => Math.abs(component - actual[index])));
}

function protectedAnimationKeyIndices(keys: IAnimationKey[]): Set<number> {
	const protectedIndices = new Set<number>([0, keys.length - 1]);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (key.interpolation === AnimationKeyInterpolation.STEP || key.inTangent !== undefined || key.outTangent !== undefined) {
			protectedIndices.add(index);
			if (key.interpolation === AnimationKeyInterpolation.STEP && index + 1 < keys.length) {
				protectedIndices.add(index + 1);
			}
		}
	}
	return protectedIndices;
}

function reduceKeysWithinError(
	keys: IAnimationKey[],
	dataType: number,
	metric: AnimationErrorMetric,
	allowedError: number
): { keys: IAnimationKey[]; maximumObservedError: number; protectedKeyCount: number } {
	if (keys.length <= 2) {
		return { keys: keys.map(cloneAnimationKey), maximumObservedError: 0, protectedKeyCount: keys.length };
	}
	const quaternion = dataType === Animation.ANIMATIONTYPE_QUATERNION;
	const range = positionRange(keys);
	const protectedIndices = protectedAnimationKeyIndices(keys);
	const kept = new Set(protectedIndices);
	const segments = [...protectedIndices]
		.sort((left, right) => left - right)
		.slice(1)
		.map((end, index, anchors) => [index === 0 ? 0 : anchors[index - 1], end] as [number, number]);
	let visits = 0;
	while (segments.length) {
		const [start, end] = segments.pop()!;
		if (end - start <= 1) {
			continue;
		}
		const first = valueComponents(keys[start].value);
		const last = valueComponents(keys[end].value);
		if (!first || !last || first.length !== last.length) {
			for (let index = start + 1; index < end; index++) {
				kept.add(index);
			}
			continue;
		}
		let maximumError = -1;
		let maximumIndex = -1;
		for (let index = start + 1; index < end; index++) {
			visits++;
			if (visits > MAX_REDUCTION_SAMPLE_VISITS) {
				return { keys: keys.map(cloneAnimationKey), maximumObservedError: 0, protectedKeyCount: keys.length };
			}
			const expected = valueComponents(keys[index].value);
			if (!expected || expected.length !== first.length) {
				maximumIndex = index;
				maximumError = Number.POSITIVE_INFINITY;
				break;
			}
			const amount = (keys[index].frame - keys[start].frame) / (keys[end].frame - keys[start].frame);
			const actual = interpolateComponents(first, last, amount, quaternion);
			const error = measuredError(expected, actual, metric, range, quaternion);
			if (error > maximumError) {
				maximumError = error;
				maximumIndex = index;
			}
		}
		if (maximumIndex !== -1 && maximumError > allowedError) {
			kept.add(maximumIndex);
			segments.push([start, maximumIndex], [maximumIndex, end]);
		}
	}
	const output = [...kept].sort((left, right) => left - right).map((index) => cloneAnimationKey(keys[index]));
	return { keys: output, maximumObservedError: maximumCurveError(keys, output, dataType, metric), protectedKeyCount: protectedIndices.size };
}

function maximumCurveError(reference: IAnimationKey[], candidate: IAnimationKey[], dataType: number, metric: AnimationErrorMetric): number {
	const quaternion = dataType === Animation.ANIMATIONTYPE_QUATERNION;
	const range = positionRange(reference);
	let maximum = 0;
	let segment = 0;
	for (const referenceKey of reference) {
		while (segment < candidate.length - 2 && referenceKey.frame > candidate[segment + 1].frame) {
			segment++;
		}
		const left = candidate[segment];
		const right = candidate[Math.min(segment + 1, candidate.length - 1)];
		const expected = valueComponents(referenceKey.value);
		const leftValues = valueComponents(left.value);
		const rightValues = valueComponents(right.value);
		if (!expected || !leftValues || !rightValues || expected.length !== leftValues.length || leftValues.length !== rightValues.length) {
			return Number.POSITIVE_INFINITY;
		}
		const amount = right.frame === left.frame ? 0 : Math.min(1, Math.max(0, (referenceKey.frame - left.frame) / (right.frame - left.frame)));
		const actual = left.interpolation === AnimationKeyInterpolation.STEP ? leftValues : interpolateComponents(leftValues, rightValues, amount, quaternion);
		maximum = Math.max(maximum, measuredError(expected, actual, metric, range, quaternion));
	}
	return maximum;
}

function valueFromComponents(template: unknown, components: number[], quaternion: boolean): unknown {
	if (typeof template === "number") {
		return components[0];
	}
	if (!template || typeof template !== "object" || !("clone" in template) || typeof template.clone !== "function") {
		return template;
	}
	const result = template.clone() as { copyFromFloats?: (...values: number[]) => unknown; copyFromArray?: (values: number[]) => unknown; normalize?: () => unknown };
	if (typeof result.copyFromFloats === "function") {
		result.copyFromFloats(...components);
	} else if (typeof result.copyFromArray === "function") {
		result.copyFromArray(components);
	}
	if (quaternion && typeof result.normalize === "function") {
		result.normalize();
	}
	return result;
}

function quantizeAnimationKeys(keys: IAnimationKey[], reference: IAnimationKey[], dataType: number, bits: number): IAnimationKey[] {
	const referenceComponents = reference.map((key) => valueComponents(key.value)).filter((value): value is number[] => value !== null);
	if (!referenceComponents.length) {
		return keys.map(cloneAnimationKey);
	}
	const dimensions = referenceComponents[0].length;
	const minimum = Array(dimensions).fill(Number.POSITIVE_INFINITY);
	const maximum = Array(dimensions).fill(Number.NEGATIVE_INFINITY);
	for (const values of referenceComponents) {
		for (let component = 0; component < dimensions; component++) {
			minimum[component] = Math.min(minimum[component], values[component]);
			maximum[component] = Math.max(maximum[component], values[component]);
		}
	}
	const levels = 2 ** bits - 1;
	const quaternion = dataType === Animation.ANIMATIONTYPE_QUATERNION;
	return keys.map((key) => {
		const values = valueComponents(key.value);
		if (!values) {
			return cloneAnimationKey(key);
		}
		const quantized = values.map((value, component) => {
			const span = maximum[component] - minimum[component];
			return span <= Number.EPSILON ? minimum[component] : minimum[component] + (Math.round(((value - minimum[component]) / span) * levels) / levels) * span;
		});
		return { ...cloneAnimationKey(key), value: valueFromComponents(key.value, quantized, quaternion) };
	});
}

function parseSerializedAnimation(serialized: Record<string, unknown>): Animation {
	if (serialized.dataType !== Animation.ANIMATIONTYPE_QUATERNION || !Array.isArray(serialized.keys)) {
		return Animation.Parse(serialized);
	}
	const normalized = structuredClone(serialized);
	for (const key of normalized.keys as Array<Record<string, unknown>>) {
		if (!Array.isArray(key.values) || !Array.isArray(key.values[4])) {
			continue;
		}
		const [x, y, z, w, nestedIn, nestedOut, interpolation] = key.values;
		const inTangent = Array.isArray(nestedIn) && nestedIn.length === 4 ? nestedIn : [0, 0, 0, 0];
		const outTangent = Array.isArray(nestedOut) && nestedOut.length === 4 ? nestedOut : [0, 0, 0, 0];
		key.values = [x, y, z, w, ...inTangent, ...outTangent, ...(interpolation === undefined ? [] : [interpolation])];
	}
	return Animation.Parse(normalized);
}

function resampleAnimation(
	serialized: Record<string, unknown>,
	settings: IAnimationImporterSettings,
	loop: boolean,
	authoredTangentFrames: ReadonlySet<number> = new Set()
): { serialized: Record<string, unknown>; result: Omit<IAnimationImporterTrackResult, "target"> } {
	const animation = parseSerializedAnimation(serialized);
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
	if (sourceKeys.some((key, index) => index > 0 && key.frame <= sourceKeys[index - 1].frame)) {
		throw new Error(`Animation "${animation.name}" key frames must be unique and ascending.`);
	}
	const sourceFrom = sourceKeys[0].frame;
	const sourceTo = sourceKeys[sourceKeys.length - 1].frame;
	const fromSeconds = sourceFrom / sourceFramesPerSecond;
	const toSeconds = sourceTo / sourceFramesPerSecond;
	const durationSeconds = Math.max(0, toSeconds - fromSeconds);
	if (!Number.isFinite(durationSeconds)) {
		throw new Error(`Animation "${animation.name}" has an excessive or non-finite duration.`);
	}
	const isDiscreteStepTrack = sourceKeys.every((key) => key.interpolation === AnimationKeyInterpolation.STEP);
	const sampleCount = durationSeconds === 0 ? 0 : Math.max(1, Math.ceil(durationSeconds * settings.resampleRate));
	if (settings.resampleCurves && !isDiscreteStepTrack && sampleCount + 1 > MAX_KEYS) {
		throw new Error(`Animation "${animation.name}" would exceed ${MAX_KEYS.toLocaleString()} keys at ${settings.resampleRate} FPS.`);
	}
	let referenceKeys: IAnimationKey[];
	if (settings.resampleCurves && isDiscreteStepTrack) {
		referenceKeys = sourceKeys.map((key) => ({ ...cloneAnimationKey(key), frame: (key.frame / sourceFramesPerSecond) * settings.resampleRate }));
	} else if (settings.resampleCurves) {
		referenceKeys = Array.from({ length: sampleCount + 1 }, (_, index) => {
			const amount = sampleCount === 0 ? 0 : index / sampleCount;
			const sourceFrame = sourceFrom + (sourceTo - sourceFrom) * amount;
			const outputFrame = (fromSeconds + durationSeconds * amount) * settings.resampleRate;
			const sourceIndex = Math.max(
				0,
				sourceKeys.findLastIndex((key) => key.frame <= sourceFrame)
			);
			return {
				frame: outputFrame,
				value: animation.evaluate(sourceFrame),
				interpolation: sourceKeys[sourceIndex].interpolation === AnimationKeyInterpolation.STEP ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE,
			};
		});
	} else {
		referenceKeys = sourceKeys.map(cloneAnimationKey);
	}
	const sampledKeyCount = referenceKeys.length;
	const requestedMetric = compressionMetric(animation.targetProperty, animation.dataType, settings);
	let outputKeys = referenceKeys.map(cloneAnimationKey);
	let effectiveCompression: AnimationImporterCompression = "none";
	let maximumObservedError = 0;
	let quantizationBits: number | null = null;
	const protectedIndices = protectedAnimationKeyIndices(referenceKeys);
	for (const frame of authoredTangentFrames) {
		const index = referenceKeys.findIndex((key) => key.frame === frame);
		if (index !== -1) {
			protectedIndices.add(index);
		}
	}
	let protectedKeyCount = protectedIndices.size;
	const hasAuthoredTangents =
		!settings.resampleCurves && (authoredTangentFrames.size > 0 || referenceKeys.some((key) => key.inTangent !== undefined || key.outTangent !== undefined));
	const hasStepKeys = referenceKeys.some((key) => key.interpolation === AnimationKeyInterpolation.STEP);
	if (settings.compression !== "none" && !hasAuthoredTangents) {
		const reduced = reduceKeysWithinError(referenceKeys, animation.dataType, requestedMetric.metric, requestedMetric.allowed);
		outputKeys = reduced.keys;
		maximumObservedError = reduced.maximumObservedError;
		protectedKeyCount = reduced.protectedKeyCount;
		effectiveCompression = "keyframeReduction";
		if (!hasStepKeys && (settings.compression === "keyframeReductionAndCompression" || settings.compression === "optimal")) {
			for (let bits = settings.quantizationBits; bits <= 24; bits++) {
				const candidate = quantizeAnimationKeys(outputKeys, referenceKeys, animation.dataType, bits);
				const error = maximumCurveError(referenceKeys, candidate, animation.dataType, requestedMetric.metric);
				if (
					error <= requestedMetric.allowed &&
					(settings.compression === "keyframeReductionAndCompression" || JSON.stringify(candidate).length < JSON.stringify(outputKeys).length)
				) {
					outputKeys = candidate;
					maximumObservedError = error;
					quantizationBits = bits;
					effectiveCompression = "keyframeReductionAndCompression";
					break;
				}
			}
		}
	}
	animation.framePerSecond = settings.resampleCurves ? settings.resampleRate : sourceFramesPerSecond;
	animation.loopMode = loop ? Animation.ANIMATIONLOOPMODE_CYCLE : Animation.ANIMATIONLOOPMODE_CONSTANT;
	animation.setKeys(outputKeys);
	const output = animation.serialize() as Record<string, unknown>;
	return {
		serialized: output,
		result: {
			name: animation.name,
			property: animation.targetProperty,
			sourceFramesPerSecond,
			outputFramesPerSecond: animation.framePerSecond,
			from: outputKeys[0].frame,
			to: outputKeys[outputKeys.length - 1].frame,
			durationSeconds,
			sourceKeyCount: sourceKeys.length,
			sampledKeyCount,
			outputKeyCount: outputKeys.length,
			compression: {
				requested: settings.compression,
				effective: effectiveCompression,
				errorMetric: requestedMetric.metric,
				allowedError: requestedMetric.allowed,
				maximumObservedError,
				quantizationBits,
				protectedKeyCount,
				removedKeyCount: sampledKeyCount - outputKeys.length,
			},
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
	settings: IAnimationImporterSettings,
	loop = settings.loopByDefault,
	tangentModes: readonly Record<string, unknown>[] = []
): { entries: IProcessedAnimationTrackEntry[]; tracks: IAnimationImporterTrackResult[]; sourceKeyCount: number; removedConstantScaleTrackCount: number; errors: string[] } {
	if (entries.length > MAX_TRACKS) {
		return { entries: [], tracks: [], sourceKeyCount: 0, removedConstantScaleTrackCount: 0, errors: [`Animation assets are limited to ${MAX_TRACKS} tracks.`] };
	}
	const sourceKeyCount = entries.reduce((sum, entry) => sum + (Array.isArray(entry.animation.keys) ? entry.animation.keys.length : 0), 0);
	if (sourceKeyCount > MAX_KEYS) {
		return { entries: [], tracks: [], sourceKeyCount, removedConstantScaleTrackCount: 0, errors: [`Animation assets are limited to ${MAX_KEYS} source keys.`] };
	}
	const output: IProcessedAnimationTrackEntry[] = [];
	const tracks: IAnimationImporterTrackResult[] = [];
	const errors: string[] = [];
	let removedConstantScaleTrackCount = 0;
	for (const [sourceIndex, entry] of entries.entries()) {
		try {
			if (settings.removeConstantScaleCurves) {
				const source = parseSerializedAnimation(entry.animation);
				const property = source.targetProperty.toLowerCase();
				const expectedComponents = property === "scaling" ? [1, 1, 1] : property.startsWith("scaling.") ? [1] : null;
				const constantDefaultScale =
					expectedComponents !== null &&
					source.getKeys().length > 0 &&
					source.getKeys().every((key) => {
						const values = valueComponents(key.value);
						return values?.length === expectedComponents.length && values.every((value, index) => Math.abs(value - expectedComponents[index]) <= Number.EPSILON);
					});
				if (constantDefaultScale) {
					removedConstantScaleTrackCount++;
					continue;
				}
			}
			const property = typeof entry.animation.property === "string" ? entry.animation.property : "";
			const authoredTangentFrames = new Set(
				tangentModes
					.filter((mode) => String(mode.targetId ?? "") === entry.target && mode.property === property && Number.isFinite(mode.frame))
					.map((mode) => Number(mode.frame))
			);
			const processed = resampleAnimation(entry.animation, settings, loop, authoredTangentFrames);
			output.push({ animation: processed.serialized, target: entry.target, sourceIndex });
			tracks.push({ ...processed.result, target: entry.target });
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { entries: output, tracks, sourceKeyCount, removedConstantScaleTrackCount, errors };
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
		eventCount: 0,
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
	const effectiveLoop = document.loopAnimation === true || settings.loopByDefault;
	const roundTripSafe =
		settings.importClips &&
		!settings.resampleCurves &&
		settings.compression === "none" &&
		!settings.removeConstantScaleCurves &&
		effectiveLoop === (document.loopAnimation === true);
	if (rootMotion && !rootMotion.resolved) {
		errors.push(`Root motion node "${settings.rootMotionNode}" has no position or Y-rotation track in this animation group.`);
	}
	if (!settings.importClips) {
		return {
			document: { ...structuredClone(document), from: 0, to: 0, loopAnimation: effectiveLoop, targetedAnimations: [] },
			sourceKind: "animation-group",
			sourceFormat: "babylon-animation-group-json",
			outputFormat: "babylon-animation-group-json",
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
			removedConstantScaleTrackCount: 0,
			roundTripSafe: false,
			preservedFeatures: ["AnimationGroup name, metadata, and loop intent remain in the empty processed container."],
			approximatedFeatures: [],
			unsupportedFeatures: [],
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
	const metadata = record(document.metadata);
	const tangentModes = Array.isArray(metadata?.babylonEditorAnimationTangentModes)
		? metadata.babylonEditorAnimationTangentModes.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
		: [];
	const processed = processTracks(entries, settings, effectiveLoop, tangentModes);
	errors.push(...processed.errors);
	if (!entries.length) {
		errors.push("Animation group contains no valid targeted animation tracks.");
	}
	const processedTargetedAnimations = processed.entries.map((entry) => ({
		...structuredClone(validTargeted[entry.sourceIndex].targeted),
		animation: entry.animation,
	}));
	const outputMetadata = document.metadata === undefined ? undefined : structuredClone(document.metadata);
	if (settings.resampleCurves && outputMetadata && typeof outputMetadata === "object" && !Array.isArray(outputMetadata)) {
		delete (outputMetadata as Record<string, unknown>).babylonEditorAnimationTangentModes;
	} else if (outputMetadata && typeof outputMetadata === "object" && !Array.isArray(outputMetadata)) {
		const metadataRecord = outputMetadata as Record<string, unknown>;
		if (Array.isArray(metadataRecord.babylonEditorAnimationTangentModes)) {
			const surviving = new Set<string>();
			for (const targeted of processedTargetedAnimations) {
				const target = animationTarget(targeted);
				const animation = record(targeted.animation);
				if (!target || !animation || typeof animation.property !== "string" || !Array.isArray(animation.keys)) {
					continue;
				}
				for (const key of animation.keys) {
					const frame = record(key)?.frame;
					if (typeof frame === "number" && Number.isFinite(frame)) {
						surviving.add(`${target}\0${animation.property}\0${frame}`);
					}
				}
			}
			metadataRecord.babylonEditorAnimationTangentModes = metadataRecord.babylonEditorAnimationTangentModes.filter((mode) => {
				const entry = record(mode);
				return (
					entry !== null &&
					typeof entry.targetId === "string" &&
					typeof entry.property === "string" &&
					typeof entry.frame === "number" &&
					surviving.has(`${entry.targetId}\0${entry.property}\0${entry.frame}`)
				);
			});
		}
	}
	const clipName = typeof document.name === "string" && document.name.trim() ? document.name : "Animation";
	const clip = { ...clipFromTracks(clipName, processed.tracks, effectiveLoop), sourceKeyCount: processed.sourceKeyCount };
	return {
		document: {
			...structuredClone(document),
			...(outputMetadata === undefined ? {} : { metadata: outputMetadata }),
			from: clip.from,
			to: clip.to,
			loopAnimation: effectiveLoop,
			targetedAnimations: processedTargetedAnimations,
		},
		sourceKind: "animation-group",
		sourceFormat: "babylon-animation-group-json",
		outputFormat: "babylon-animation-group-json",
		clips: [clip],
		tracks: processed.tracks,
		rootMotion,
		controllerStateCount: 0,
		controllerTransitionCount: 0,
		sourceKeyCount: clip.sourceKeyCount,
		sampledKeyCount: clip.sampledKeyCount,
		outputKeyCount: clip.outputKeyCount,
		removedConstantScaleTrackCount: processed.removedConstantScaleTrackCount,
		roundTripSafe,
		preservedFeatures: [
			"AnimationGroup target bindings, track properties/types, name, metadata, and source loop intent are preserved.",
			...(settings.resampleCurves ? [] : ["Source key times, interpolation, tangents, and frame rates are preserved before optional error-bounded compression."]),
		],
		approximatedFeatures: settings.resampleCurves ? ["Authored curves are baked through Babylon evaluation at the requested sample rate."] : [],
		unsupportedFeatures: [],
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
			sourceFormat: "babylon-animation-track-set-json",
			outputFormat: "babylon-animation-track-set-json",
			clips: [],
			tracks: [],
			rootMotion: settings.rootMotionNode ? { requestedNode: settings.rootMotionNode, resolved: false, trackCount: 0, properties: [] } : null,
			controllerStateCount: 0,
			controllerTransitionCount: 0,
			sourceKeyCount: entries.reduce((sum, entry) => sum + (Array.isArray(entry.animation.keys) ? entry.animation.keys.length : 0), 0),
			sampledKeyCount: 0,
			outputKeyCount: 0,
			removedConstantScaleTrackCount: 0,
			roundTripSafe: false,
			preservedFeatures: [],
			approximatedFeatures: [],
			unsupportedFeatures: ["Legacy track sets do not carry AnimationGroup target bindings, events, or group metadata."],
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
	const clip = { ...clipFromTracks(clipName, processed.tracks, settings.loopByDefault), sourceKeyCount: processed.sourceKeyCount };
	return {
		document: processed.entries.map((entry) => entry.animation),
		sourceKind: "animation-track-set",
		sourceFormat: "babylon-animation-track-set-json",
		outputFormat: "babylon-animation-track-set-json",
		clips: [clip],
		tracks: processed.tracks,
		rootMotion: settings.rootMotionNode ? { requestedNode: settings.rootMotionNode, resolved: false, trackCount: 0, properties: [] } : null,
		controllerStateCount: 0,
		controllerTransitionCount: 0,
		sourceKeyCount: clip.sourceKeyCount,
		sampledKeyCount: clip.sampledKeyCount,
		outputKeyCount: clip.outputKeyCount,
		removedConstantScaleTrackCount: processed.removedConstantScaleTrackCount,
		roundTripSafe: !settings.resampleCurves && settings.compression === "none" && !settings.removeConstantScaleCurves,
		preservedFeatures: [
			"Legacy animation names, properties, types, frame rates, loop modes, and keys are preserved.",
			...(settings.resampleCurves ? [] : ["Source key times, interpolation, and tangents are preserved before optional error-bounded compression."]),
		],
		approximatedFeatures: settings.resampleCurves ? ["Authored curves are baked through Babylon evaluation at the requested sample rate."] : [],
		unsupportedFeatures: ["Legacy track sets do not carry AnimationGroup target bindings, events, or group metadata."],
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
		sourceFormat: imported && document.sourceFormat === "unity-yaml" ? "unity-animator-yaml" : "babylon-animator-json",
		outputFormat: "babylon-animator-json",
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
		controllerBehaviourBindings: imported ? structuredClone(document.behaviourBindings ?? []) : [],
		controllerBehaviourBindingCount: imported ? (document.behaviourBindings?.length ?? 0) : 0,
		controllerCompatibility: imported ? structuredClone(document.compatibility) : undefined,
		controllerUnsupportedFeatures: imported ? [...document.unsupportedFeatures] : [],
		sourceKeyCount: 0,
		sampledKeyCount: 0,
		outputKeyCount: 0,
		removedConstantScaleTrackCount: 0,
		roundTripSafe: !imported,
		preservedFeatures: ["Animator layers, parameters, states, transitions, Blend Trees, external binding requirements, and diagnostics are preserved."],
		approximatedFeatures: [],
		unsupportedFeatures: imported ? [...document.unsupportedFeatures] : [],
		errors,
		warnings,
	};
}

/** Parses JSON animation assets or converts Unity multi-document YAML Animator Controllers before executing the shared importer contract. */
export function executeAnimationImporterSource(source: string, sourcePath: string, settings: IAnimationImporterSettings): IExecutedAnimationImport {
	const extension = extname(sourcePath).toLowerCase();
	const trimmed = source.trimStart();
	if (extension === ".anim" && (trimmed.startsWith("%YAML") || /^---\s+!u!74\b/m.test(trimmed))) {
		const conversion = convertUnityAnimationClip(source, sourcePath);
		const processed = processAnimationGroup(conversion.document, settings);
		return {
			...processed,
			sourceKind: "unity-animation-clip",
			sourceFormat: "unity-animation-clip-yaml",
			clips: processed.clips.map((clip) => ({ ...clip, eventCount: conversion.eventCount })),
			roundTripSafe: false,
			activeStateCurveCount: conversion.activeStateCurveCount,
			compressedRotationCurveCount: conversion.compressedRotationCurveCount,
			objectReferenceCurves: structuredClone(conversion.objectReferenceCurves),
			preservedFeatures: [...new Set([...processed.preservedFeatures, ...conversion.preservedFeatures])],
			approximatedFeatures: [...new Set([...processed.approximatedFeatures, ...conversion.approximatedFeatures])],
			unsupportedFeatures: [...new Set([...processed.unsupportedFeatures, ...conversion.unsupportedFeatures])],
			errors: [...new Set([...conversion.errors, ...processed.errors])],
			warnings: [...new Set([...conversion.warnings, ...processed.warnings])],
		};
	}
	if ((extension === ".controller" || extension === ".animator") && (trimmed.startsWith("%YAML") || /^---\s+!u!\d+/m.test(trimmed))) {
		const conversion = convertUnityAnimatorController(source, sourcePath);
		return {
			document: conversion.document,
			sourceKind: "animator-controller",
			sourceFormat: "unity-animator-yaml",
			outputFormat: "babylon-animator-json",
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
			controllerBehaviourBindings: conversion.document.behaviourBindings,
			controllerBehaviourBindingCount: conversion.document.behaviourBindings.length,
			controllerCompatibility: structuredClone(conversion.document.compatibility),
			controllerUnsupportedFeatures: conversion.document.unsupportedFeatures,
			sourceKeyCount: 0,
			sampledKeyCount: 0,
			outputKeyCount: 0,
			removedConstantScaleTrackCount: 0,
			roundTripSafe: false,
			preservedFeatures: [
				"Unity Animator serialization versions/field variants, static state playback, layers, parameters, state machines, transitions, Blend Trees, and external Motion/AvatarMask/MonoBehaviour bindings are converted.",
			],
			approximatedFeatures: [],
			unsupportedFeatures: [...conversion.document.unsupportedFeatures],
			errors: conversion.errors,
			warnings: conversion.warnings,
		};
	}
	let document: unknown;
	try {
		document = JSON.parse(source);
	} catch (error) {
		throw new Error(`Animation JSON or supported Unity YAML is malformed: ${error instanceof Error ? error.message : String(error)}`);
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

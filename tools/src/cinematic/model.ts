import { getECSStableHash } from "../ecs/hash";

/** Defines the persisted, engine-independent contract used by editor and MCP timeline operations. */

export const cinematicDocumentVersion = 2 as const;

export const cinematicDocumentLimits = {
	maximumTracks: 256,
	maximumClips: 4096,
	maximumKeysAndMarkers: 10_000,
	maximumRecorderProfiles: 32,
	maximumFramesPerSecond: 240,
	maximumDurationFrames: 20_736_000,
} as const;

/** Controls transport behavior when playback reaches a document boundary. */
export type TCinematicWrapMode = "once" | "loop" | "hold";
/** Chooses whether duration follows authored content or an explicit project setting. */
export type TCinematicDurationMode = "automatic" | "fixed";
/** Defines supported property-lane interpolation strategies. */
export type TCinematicInterpolation = "linear" | "step" | "cubic";
/** Defines easing envelopes shared by clip blend regions. */
export type TCinematicEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";
/** Defines clip behavior outside its authored interval. */
export type TCinematicExtrapolation = "none" | "hold" | "loop" | "pingPong" | "continue";
/** Bounds marker payloads to portable, serializable JSON data. */
export type TCinematicJsonValue = null | boolean | number | string | TCinematicJsonValue[] | { [key: string]: TCinematicJsonValue };
/** Represents Babylon scalar, Boolean, vector/color/quaternion, or matrix property data. */
export type TCinematicPropertyValue = number | boolean | number[];

/** Stores one interpolated property key with optional authored tangents. */
export interface ICinematicPropertyKey {
	id: string;
	type: "key";
	frame: number;
	value: TCinematicPropertyValue;
	interpolation: TCinematicInterpolation;
	inTangent?: TCinematicPropertyValue;
	outTangent?: TCinematicPropertyValue;
}

/** Stores both sides of an intentional discontinuity at one exact frame. */
export interface ICinematicPropertyCut {
	id: string;
	type: "cut";
	frame: number;
	incomingValue: TCinematicPropertyValue;
	outgoingValue: TCinematicPropertyValue;
}

/** Lets property lanes contain continuous keys and explicit discontinuities. */
export type TCinematicPropertyKey = ICinematicPropertyKey | ICinematicPropertyCut;

/** Defines timing, blending, enablement, and extrapolation shared by every clip. */
export interface ICinematicClipBase {
	id: string;
	name: string;
	startFrame: number;
	durationFrames: number;
	clipInFrame: number;
	timeScale: number;
	enabled: boolean;
	blendInFrames: number;
	blendOutFrames: number;
	easeIn: TCinematicEasing;
	easeOut: TCinematicEasing;
	preExtrapolation: TCinematicExtrapolation;
	postExtrapolation: TCinematicExtrapolation;
}

/** References a bounded source range in a Babylon animation group. */
export interface ICinematicAnimationClip extends ICinematicClipBase {
	type: "animation";
	animationGroupId: string;
	sourceStartFrame: number;
	sourceEndFrame: number;
	loopCount: number;
}

/** References a sound and its authored gain/loop behavior. */
export interface ICinematicAudioClip extends ICinematicClipBase {
	type: "audio";
	soundId: string;
	volume: number;
	loop: boolean;
}

/** References one persistent Video Player and its Timeline-specific audio/loop overrides. */
export interface ICinematicVideoClip extends ICinematicClipBase {
	type: "video";
	videoPlayerId: string;
	volume: number;
	loop: boolean;
	muteAudio: boolean;
}

/** Authors a scene-node enabled state over a clip interval. */
export interface ICinematicActivationClip extends ICinematicClipBase {
	type: "activation";
	nodeId: string;
	active: boolean;
}

/** Authors an active camera shot and transition style. */
export interface ICinematicCameraClip extends ICinematicClipBase {
	type: "camera";
	cameraId: string;
	blendMode: "cut" | "crossFade";
}

/** Authors transport commands for particle systems or nested cinematic assets. */
export interface ICinematicControlClip extends ICinematicClipBase {
	type: "control";
	targetType: "particleSystem" | "cinematic";
	targetId: string;
	action: "play" | "stop";
}

/** Activates a named deterministic capture profile over a clip interval. */
export interface ICinematicRecorderClip extends ICinematicClipBase {
	type: "recorder";
	profileId: string;
}

/** Discriminates every clip kind supported by version-2 timelines. */
export type TCinematicClip =
	| ICinematicAnimationClip
	| ICinematicAudioClip
	| ICinematicVideoClip
	| ICinematicActivationClip
	| ICinematicCameraClip
	| ICinematicControlClip
	| ICinematicRecorderClip;

/** Stores a signal/event occurrence with replay and seek semantics. */
export interface ICinematicMarker {
	id: string;
	name: string;
	type: "signal" | "event";
	frame: number;
	emitOnce: boolean;
	retroactive: boolean;
	payload: TCinematicJsonValue;
}

/** Defines hierarchy, ordering, authoring locks, and playback selection shared by tracks. */
export interface ICinematicTrackBase {
	id: string;
	name: string;
	type: "group" | "property" | "animation" | "audio" | "video" | "activation" | "camera" | "signal" | "control" | "recorder";
	order: number;
	parentId: string | null;
	muted: boolean;
	solo: boolean;
	locked: boolean;
	color: string;
}

/** Groups child tracks and persists authoring collapse state. */
export interface ICinematicGroupTrack extends ICinematicTrackBase {
	type: "group";
	collapsed: boolean;
}

/** Binds a property curve to a scene node or rendering pipeline. */
export interface ICinematicPropertyTrack extends ICinematicTrackBase {
	type: "property";
	targetType: "node" | "renderingPipeline";
	targetId: string | null;
	propertyPath: string;
	keys: TCinematicPropertyKey[];
}

/** Sequences animation clips with an optional automated group weight. */
export interface ICinematicAnimationTrack extends ICinematicTrackBase {
	type: "animation";
	clips: ICinematicAnimationClip[];
	weightKeys: TCinematicPropertyKey[];
}

/** Sequences sounds with an optional automated track volume. */
export interface ICinematicAudioTrack extends ICinematicTrackBase {
	type: "audio";
	clips: ICinematicAudioClip[];
	volumeKeys: TCinematicPropertyKey[];
}

/** Sequences persistent Video Players using deterministic Timeline time. */
export interface ICinematicVideoTrack extends ICinematicTrackBase {
	type: "video";
	clips: ICinematicVideoClip[];
}

/** Sequences node enable/disable intervals. */
export interface ICinematicActivationTrack extends ICinematicTrackBase {
	type: "activation";
	clips: ICinematicActivationClip[];
}

/** Sequences camera shots and authored blends. */
export interface ICinematicCameraTrack extends ICinematicTrackBase {
	type: "camera";
	clips: ICinematicCameraClip[];
}

/** Orders named signals and event payloads on the timeline. */
export interface ICinematicSignalTrack extends ICinematicTrackBase {
	type: "signal";
	markers: ICinematicMarker[];
}

/** Sequences nested cinematic and particle-system control commands. */
export interface ICinematicControlTrack extends ICinematicTrackBase {
	type: "control";
	clips: ICinematicControlClip[];
}

/** Sequences capture windows that reference document recorder profiles. */
export interface ICinematicRecorderTrack extends ICinematicTrackBase {
	type: "recorder";
	clips: ICinematicRecorderClip[];
}

/** Discriminates every track kind supported by version-2 timelines. */
export type TCinematicTrack =
	| ICinematicGroupTrack
	| ICinematicPropertyTrack
	| ICinematicAnimationTrack
	| ICinematicAudioTrack
	| ICinematicVideoTrack
	| ICinematicActivationTrack
	| ICinematicCameraTrack
	| ICinematicSignalTrack
	| ICinematicControlTrack
	| ICinematicRecorderTrack;

/** Defines one reusable and bounded offline capture preset. */
export interface ICinematicRecorderProfile {
	id: string;
	name: string;
	format: "webm" | "mp4" | "png" | "jpeg" | "webp";
	width: number;
	height: number;
	framesPerSecond: number;
	quality: number;
	includeAudio: boolean;
}

/** Defines the complete versioned asset shared by persistence, runtime, editor, and MCP. */
export interface ICinematicDocument {
	version: typeof cinematicDocumentVersion;
	id: string;
	revision: number;
	name: string;
	framesPerSecond: number;
	outputFramesPerSecond: number;
	durationMode: TCinematicDurationMode;
	durationFrames: number;
	wrapMode: TCinematicWrapMode;
	tracks: TCinematicTrack[];
	recorderProfiles: ICinematicRecorderProfile[];
}

/** Supplies asset identity context when a legacy document has no persisted ID. */
export interface ICinematicNormalizationOptions {
	identitySeed?: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const colorPattern = /^#[0-9a-fA-F]{6}$/;
const trackTypes: TCinematicTrack["type"][] = ["group", "property", "animation", "audio", "video", "activation", "camera", "signal", "control", "recorder"];
const clipTypes: TCinematicClip["type"][] = ["animation", "audio", "video", "activation", "camera", "control", "recorder"];
const easingValues: TCinematicEasing[] = ["linear", "easeIn", "easeOut", "easeInOut"];
const extrapolationValues: TCinematicExtrapolation[] = ["none", "hold", "loop", "pingPong", "continue"];
const interpolationValues: TCinematicInterpolation[] = ["linear", "step", "cubic"];

/** Rejects arrays and primitives before any untrusted document field is inspected. */
function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

/** Keeps the persisted schema closed so misspelled or future fields cannot silently disappear. */
function assertKeys(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknownKey = Object.keys(source).find((key) => !allowed.includes(key));
	if (unknownKey) {
		throw new Error(`${label} contains unsupported field "${unknownKey}".`);
	}
}

/** Bounds human-readable text and rejects line-oriented control characters. */
function text(value: unknown, label: string, maximum = 128): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} must contain 1-${maximum} characters without control line breaks.`);
	}
	return value.trim();
}

/** Restricts persisted identifiers to a portable format shared by files, UI, and MCP. */
function id(value: unknown, label: string): string {
	const result = text(value, label);
	if (!idPattern.test(result)) {
		throw new Error(`${label} must use letters, numbers, dot, underscore, colon, or dash.`);
	}
	return result;
}

/** Prevents prototype traversal while retaining Babylon's dotted property bindings. */
function propertyPath(value: unknown, label: string): string {
	const result = text(value, label, 512);
	const parts = result.split(".");
	if (parts.length > 8 || parts.some((part) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) {
		throw new Error(`${label} must contain at most eight safe dotted identifier segments.`);
	}
	return result;
}

/** Stops NaN, infinity, and extreme numeric payloads from entering playback state. */
function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be finite and within ${minimum}..${maximum}.`);
	}
	return value;
}

/** Enforces exact counters and revisions where fractional values are never meaningful. */
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be a safe integer within ${minimum}..${maximum}.`);
	}
	return value as number;
}

/** Avoids truthy coercion in persisted editor settings. */
function bool(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be Boolean.`);
	}
	return value;
}

/** Bounds arbitrary marker payloads so one asset cannot exhaust editor or agent context. */
function jsonValue(value: unknown, label: string, depth = 0, budget = { entries: 0 }): TCinematicJsonValue {
	if (depth > 8 || ++budget.entries > 2048) {
		throw new Error(`${label} exceeds the bounded JSON depth or entry count.`);
	}
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`${label} numbers must be finite.`);
		}
		return value;
	}
	if (typeof value === "string") {
		if (value.length > 32_768 || value.includes("\0")) {
			throw new Error(`${label} strings must contain at most 32,768 characters and no null bytes.`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > 256) {
			throw new Error(`${label} arrays support at most 256 entries.`);
		}
		return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1, budget));
	}
	const source = object(value, label);
	if (Object.keys(source).length > 256) {
		throw new Error(`${label} objects support at most 256 fields.`);
	}
	const entries: [string, TCinematicJsonValue][] = [];
	const normalizedKeys = new Set<string>();
	for (const [key, entry] of Object.entries(source)) {
		const normalizedKey = text(key, `${label} field`, 128);
		if (["__proto__", "constructor", "prototype"].includes(normalizedKey) || normalizedKeys.has(normalizedKey)) {
			throw new Error(`${label} contains an unsafe or duplicate normalized field.`);
		}
		normalizedKeys.add(normalizedKey);
		entries.push([normalizedKey, jsonValue(entry, `${label}.${key}`, depth + 1, budget)]);
	}
	return Object.fromEntries(entries);
}

/** Produces repeatable migration IDs without random or process-global state. */
function generatedId(kind: string, seed: unknown): string {
	return `${kind}-${getECSStableHash(seed)}`;
}

/** Limits animatable values to Babylon-compatible scalar, Boolean, vector, color, quaternion, and matrix shapes. */
function propertyValue(value: unknown, label: string): TCinematicPropertyValue {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return finite(value, label, -Number.MAX_VALUE, Number.MAX_VALUE);
	}
	if (!Array.isArray(value) || ![2, 3, 4, 16].includes(value.length)) {
		throw new Error(`${label} must be a finite scalar, Boolean, or a 2/3/4/16-component numeric value.`);
	}
	return value.map((entry, index) => finite(entry, `${label}[${index}]`, -Number.MAX_VALUE, Number.MAX_VALUE));
}

/** Prevents interpolation between values with incompatible runtime representations. */
function assertPropertyValueCompatibility(left: TCinematicPropertyValue, right: TCinematicPropertyValue, label: string): void {
	const compatible = typeof left === typeof right && (!Array.isArray(left) || (Array.isArray(right) && left.length === right.length));
	if (!compatible) {
		throw new Error(`${label} values must use the same scalar or vector type.`);
	}
}

/** Normalizes regular keys and discontinuous cuts into one strictly discriminated representation. */
function propertyKey(value: unknown, label: string, fallbackId?: string): TCinematicPropertyKey {
	const source = object(value, label);
	if (source.type === "cut") {
		assertKeys(source, ["id", "type", "frame", "incomingValue", "outgoingValue"], label);
		const incomingValue = propertyValue(source.incomingValue, `${label} incomingValue`);
		const outgoingValue = propertyValue(source.outgoingValue, `${label} outgoingValue`);
		assertPropertyValueCompatibility(incomingValue, outgoingValue, label);
		return {
			id: id(source.id ?? fallbackId, `${label} id`),
			type: "cut",
			frame: finite(source.frame, `${label} frame`, 0, cinematicDocumentLimits.maximumDurationFrames),
			incomingValue,
			outgoingValue,
		};
	}
	assertKeys(source, ["id", "type", "frame", "value", "interpolation", "inTangent", "outTangent"], label);
	if (source.type !== "key") {
		throw new Error(`${label} type must be key or cut.`);
	}
	const interpolation = source.interpolation ?? "linear";
	if (!interpolationValues.includes(interpolation as TCinematicInterpolation)) {
		throw new Error(`${label} interpolation must be linear, step, or cubic.`);
	}
	const result: ICinematicPropertyKey = {
		id: id(source.id ?? fallbackId, `${label} id`),
		type: "key",
		frame: finite(source.frame, `${label} frame`, 0, cinematicDocumentLimits.maximumDurationFrames),
		value: propertyValue(source.value, `${label} value`),
		interpolation: interpolation as TCinematicInterpolation,
		...(source.inTangent === undefined || source.inTangent === null ? {} : { inTangent: propertyValue(source.inTangent, `${label} inTangent`) }),
		...(source.outTangent === undefined || source.outTangent === null ? {} : { outTangent: propertyValue(source.outTangent, `${label} outTangent`) }),
	};
	if (result.inTangent !== undefined) {
		assertPropertyValueCompatibility(result.value, result.inTangent, `${label} inTangent`);
	}
	if (result.outTangent !== undefined) {
		assertPropertyValueCompatibility(result.value, result.outTangent, `${label} outTangent`);
	}
	if (typeof result.value === "boolean" && (result.inTangent !== undefined || result.outTangent !== undefined || result.interpolation === "cubic")) {
		throw new Error(`${label} Boolean values support only linear or step interpolation without tangents.`);
	}
	return result;
}

/** Sorts validated keys so evaluators can perform deterministic interval lookup. */
function propertyKeys(value: unknown, label: string): TCinematicPropertyKey[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array.`);
	}
	const result = value.map((entry, index) => propertyKey(entry, `${label} ${index}`)).sort((a, b) => a.frame - b.frame);
	for (let index = 1; index < result.length; ++index) {
		if (result[index - 1].frame === result[index].frame) {
			throw new Error(`${label} cannot contain more than one key at frame ${result[index].frame}.`);
		}
	}
	const first = result[0];
	if (first) {
		const reference = first.type === "cut" ? first.outgoingValue : first.value;
		for (const key of result) {
			assertPropertyValueCompatibility(reference, key.type === "cut" ? key.incomingValue : key.value, label);
			if (key.type === "cut") {
				assertPropertyValueCompatibility(reference, key.outgoingValue, label);
			}
		}
	}
	return result;
}

/** Applies lane-specific scalar bounds after the general key schema has been normalized. */
function boundedScalarKeys(keys: readonly TCinematicPropertyKey[], label: string, minimum: number, maximum: number): void {
	for (const key of keys) {
		const values = key.type === "key" ? [key.value] : [key.incomingValue, key.outgoingValue];
		if (values.some((value) => typeof value !== "number" || value < minimum || value > maximum)) {
			throw new Error(`${label} values must be scalar and within ${minimum}..${maximum}.`);
		}
	}
}

/** Validates timing, blending, and extrapolation shared by every clip kind. */
function clipBase(source: Record<string, unknown>, label: string): ICinematicClipBase {
	const durationFrames = finite(source.durationFrames, `${label} durationFrames`, 0.000_001, cinematicDocumentLimits.maximumDurationFrames);
	const blendInFrames = finite(source.blendInFrames, `${label} blendInFrames`, 0, durationFrames);
	const blendOutFrames = finite(source.blendOutFrames, `${label} blendOutFrames`, 0, durationFrames);
	if (blendInFrames + blendOutFrames > durationFrames) {
		throw new Error(`${label} blend regions cannot exceed its duration.`);
	}
	const timeScale = finite(source.timeScale, `${label} timeScale`, -100, 100);
	if (Math.abs(timeScale) < 0.01) {
		throw new Error(`${label} timeScale magnitude must be at least 0.01.`);
	}
	if (!easingValues.includes(source.easeIn as TCinematicEasing) || !easingValues.includes(source.easeOut as TCinematicEasing)) {
		throw new Error(`${label} easing must be linear, easeIn, easeOut, or easeInOut.`);
	}
	if (!extrapolationValues.includes(source.preExtrapolation as TCinematicExtrapolation) || !extrapolationValues.includes(source.postExtrapolation as TCinematicExtrapolation)) {
		throw new Error(`${label} extrapolation mode is unsupported.`);
	}
	return {
		id: id(source.id, `${label} id`),
		name: text(source.name, `${label} name`),
		startFrame: finite(source.startFrame, `${label} startFrame`, 0, cinematicDocumentLimits.maximumDurationFrames),
		durationFrames,
		clipInFrame: finite(source.clipInFrame, `${label} clipInFrame`, 0, cinematicDocumentLimits.maximumDurationFrames),
		timeScale,
		enabled: bool(source.enabled, `${label} enabled`),
		blendInFrames,
		blendOutFrames,
		easeIn: source.easeIn as TCinematicEasing,
		easeOut: source.easeOut as TCinematicEasing,
		preExtrapolation: source.preExtrapolation as TCinematicExtrapolation,
		postExtrapolation: source.postExtrapolation as TCinematicExtrapolation,
	};
}

/** Closes each typed clip schema before returning its runtime-safe discriminated value. */
function clip(value: unknown, expectedType: TCinematicClip["type"], label: string): TCinematicClip {
	const source = object(value, label);
	if (source.type !== expectedType || !clipTypes.includes(source.type as TCinematicClip["type"])) {
		throw new Error(`${label} type must be ${expectedType}.`);
	}
	const common = [
		"id",
		"type",
		"name",
		"startFrame",
		"durationFrames",
		"clipInFrame",
		"timeScale",
		"enabled",
		"blendInFrames",
		"blendOutFrames",
		"easeIn",
		"easeOut",
		"preExtrapolation",
		"postExtrapolation",
	];
	const base = clipBase(source, label);
	switch (expectedType) {
		case "animation":
			assertKeys(source, [...common, "animationGroupId", "sourceStartFrame", "sourceEndFrame", "loopCount"], label);
			const sourceStartFrame = finite(source.sourceStartFrame, `${label} sourceStartFrame`, 0, cinematicDocumentLimits.maximumDurationFrames);
			const sourceEndFrame = finite(source.sourceEndFrame, `${label} sourceEndFrame`, sourceStartFrame, cinematicDocumentLimits.maximumDurationFrames);
			return {
				...base,
				type: "animation",
				animationGroupId: text(source.animationGroupId, `${label} animationGroupId`, 256),
				sourceStartFrame,
				sourceEndFrame,
				loopCount: integer(source.loopCount, `${label} loopCount`, 0, 10_000),
			};
		case "audio":
			assertKeys(source, [...common, "soundId", "volume", "loop"], label);
			if (base.timeScale <= 0) {
				throw new Error(`${label} audio timeScale must be positive because Babylon audio does not support reverse playback.`);
			}
			if (base.clipInFrame + base.durationFrames * base.timeScale > cinematicDocumentLimits.maximumDurationFrames) {
				throw new Error(`${label} audio source range exceeds the maximum frame ${cinematicDocumentLimits.maximumDurationFrames}.`);
			}
			return {
				...base,
				type: "audio",
				soundId: text(source.soundId, `${label} soundId`, 256),
				volume: finite(source.volume, `${label} volume`, 0, 8),
				loop: bool(source.loop, `${label} loop`),
			};
		case "video":
			assertKeys(source, [...common, "videoPlayerId", "volume", "loop", "muteAudio"], label);
			if (base.timeScale <= 0) {
				throw new Error(`${label} video timeScale must be positive because browser video does not support reverse playback.`);
			}
			if (base.clipInFrame + base.durationFrames * base.timeScale > cinematicDocumentLimits.maximumDurationFrames) {
				throw new Error(`${label} video source range exceeds the maximum frame ${cinematicDocumentLimits.maximumDurationFrames}.`);
			}
			return {
				...base,
				type: "video",
				videoPlayerId: id(source.videoPlayerId, `${label} videoPlayerId`),
				volume: finite(source.volume, `${label} volume`, 0, 1),
				loop: bool(source.loop, `${label} loop`),
				muteAudio: bool(source.muteAudio, `${label} muteAudio`),
			};
		case "activation":
			assertKeys(source, [...common, "nodeId", "active"], label);
			return { ...base, type: "activation", nodeId: text(source.nodeId, `${label} nodeId`, 256), active: bool(source.active, `${label} active`) };
		case "camera":
			assertKeys(source, [...common, "cameraId", "blendMode"], label);
			if (source.blendMode !== "cut" && source.blendMode !== "crossFade") {
				throw new Error(`${label} blendMode must be cut or crossFade.`);
			}
			return { ...base, type: "camera", cameraId: text(source.cameraId, `${label} cameraId`, 256), blendMode: source.blendMode };
		case "control":
			assertKeys(source, [...common, "targetType", "targetId", "action"], label);
			if (source.targetType !== "particleSystem" && source.targetType !== "cinematic") {
				throw new Error(`${label} targetType must be particleSystem or cinematic.`);
			}
			if (source.action !== "play" && source.action !== "stop") {
				throw new Error(`${label} action must be play or stop.`);
			}
			const targetId = text(source.targetId, `${label} targetId`, 1024);
			if (
				source.targetType === "cinematic" &&
				(targetId.startsWith("/") ||
					targetId.includes("\\") ||
					!targetId.endsWith(".cinematic") ||
					targetId.split("/").some((part) => !part || part === "." || part === ".."))
			) {
				throw new Error(`${label} cinematic targetId must be a normalized project-relative .cinematic path.`);
			}
			return { ...base, type: "control", targetType: source.targetType, targetId, action: source.action };
		case "recorder":
			assertKeys(source, [...common, "profileId"], label);
			return { ...base, type: "recorder", profileId: id(source.profileId, `${label} profileId`) };
	}
}

/** Normalizes timeline signals while bounding arbitrary user payloads. */
function marker(value: unknown, label: string): ICinematicMarker {
	const source = object(value, label);
	assertKeys(source, ["id", "name", "type", "frame", "emitOnce", "retroactive", "payload"], label);
	if (source.type !== "signal" && source.type !== "event") {
		throw new Error(`${label} type must be signal or event.`);
	}
	return {
		id: id(source.id, `${label} id`),
		name: text(source.name, `${label} name`),
		type: source.type,
		frame: finite(source.frame, `${label} frame`, 0, cinematicDocumentLimits.maximumDurationFrames),
		emitOnce: bool(source.emitOnce, `${label} emitOnce`),
		retroactive: bool(source.retroactive, `${label} retroactive`),
		payload: jsonValue(source.payload, `${label} payload`),
	};
}

/** Validates hierarchy and authoring flags common to all timeline tracks. */
function trackBase(source: Record<string, unknown>, label: string): ICinematicTrackBase {
	if (!trackTypes.includes(source.type as TCinematicTrack["type"])) {
		throw new Error(`${label} type is unsupported.`);
	}
	const color = source.color;
	if (typeof color !== "string" || !colorPattern.test(color)) {
		throw new Error(`${label} color must use #RRGGBB.`);
	}
	return {
		id: id(source.id, `${label} id`),
		name: text(source.name, `${label} name`),
		type: source.type as TCinematicTrack["type"],
		order: integer(source.order, `${label} order`, 0, cinematicDocumentLimits.maximumTracks - 1),
		parentId: source.parentId === null ? null : id(source.parentId, `${label} parentId`),
		muted: bool(source.muted, `${label} muted`),
		solo: bool(source.solo, `${label} solo`),
		locked: bool(source.locked, `${label} locked`),
		color,
	};
}

/** Converts one untrusted track object into the exact schema required by its discriminator. */
function track(value: unknown, label: string): TCinematicTrack {
	const source = object(value, label);
	const common = ["id", "name", "type", "order", "parentId", "muted", "solo", "locked", "color"];
	const base = trackBase(source, label);
	switch (base.type) {
		case "group":
			assertKeys(source, [...common, "collapsed"], label);
			return { ...base, type: "group", collapsed: bool(source.collapsed, `${label} collapsed`) };
		case "property":
			assertKeys(source, [...common, "targetType", "targetId", "propertyPath", "keys"], label);
			if (source.targetType !== "node" && source.targetType !== "renderingPipeline") {
				throw new Error(`${label} targetType must be node or renderingPipeline.`);
			}
			const targetId = source.targetId === null ? null : text(source.targetId, `${label} targetId`, 256);
			if ((source.targetType === "node" && targetId === null) || (source.targetType === "renderingPipeline" && targetId !== null)) {
				throw new Error(`${label} node bindings require targetId while renderingPipeline bindings require null.`);
			}
			return {
				...base,
				type: "property",
				targetType: source.targetType,
				targetId,
				propertyPath: propertyPath(source.propertyPath, `${label} propertyPath`),
				keys: propertyKeys(source.keys, `${label} keys`),
			};
		case "animation":
			assertKeys(source, [...common, "clips", "weightKeys"], label);
			const weightKeys = propertyKeys(source.weightKeys, `${label} weightKeys`);
			boundedScalarKeys(weightKeys, `${label} weightKeys`, 0, 1);
			return {
				...base,
				type: "animation",
				clips: normalizeClips(source.clips, "animation", `${label} clips`),
				weightKeys,
			};
		case "audio":
			assertKeys(source, [...common, "clips", "volumeKeys"], label);
			const volumeKeys = propertyKeys(source.volumeKeys, `${label} volumeKeys`);
			boundedScalarKeys(volumeKeys, `${label} volumeKeys`, 0, 8);
			return { ...base, type: "audio", clips: normalizeClips(source.clips, "audio", `${label} clips`), volumeKeys };
		case "video":
		case "activation":
		case "camera":
		case "control":
		case "recorder":
			assertKeys(source, [...common, "clips"], label);
			return { ...base, type: base.type, clips: normalizeClips(source.clips, base.type, `${label} clips`) } as TCinematicTrack;
		case "signal":
			assertKeys(source, [...common, "markers"], label);
			if (!Array.isArray(source.markers)) {
				throw new Error(`${label} markers must be an array.`);
			}
			return { ...base, type: "signal", markers: source.markers.map((entry, index) => marker(entry, `${label} marker ${index}`)).sort((a, b) => a.frame - b.frame) };
	}
}

/** Preserves clip type narrowing while normalizing and ordering an authored lane. */
function normalizeClips<T extends TCinematicClip["type"]>(value: unknown, type: T, label: string): Extract<TCinematicClip, { type: T }>[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array.`);
	}
	return value.map((entry, index) => clip(entry, type, `${label} ${index}`) as Extract<TCinematicClip, { type: T }>).sort((a, b) => a.startFrame - b.startFrame);
}

/** Bounds capture presets so invalid resolutions or encodings fail at asset load time. */
function recorderProfile(value: unknown, label: string): ICinematicRecorderProfile {
	const source = object(value, label);
	assertKeys(source, ["id", "name", "format", "width", "height", "framesPerSecond", "quality", "includeAudio"], label);
	if (!["webm", "mp4", "png", "jpeg", "webp"].includes(String(source.format))) {
		throw new Error(`${label} format is unsupported.`);
	}
	return {
		id: id(source.id, `${label} id`),
		name: text(source.name, `${label} name`),
		format: source.format as ICinematicRecorderProfile["format"],
		width: integer(source.width, `${label} width`, 16, 8192),
		height: integer(source.height, `${label} height`, 16, 8192),
		framesPerSecond: finite(source.framesPerSecond, `${label} framesPerSecond`, 1, cinematicDocumentLimits.maximumFramesPerSecond),
		quality: finite(source.quality, `${label} quality`, 0, 1),
		includeAudio: bool(source.includeAudio, `${label} includeAudio`),
	};
}

/** Supplies stable authoring defaults while splitting combined legacy tracks. */
function defaultTrackBase(type: TCinematicTrack["type"], order: number, seed: unknown): ICinematicTrackBase {
	return {
		id: generatedId(type, seed),
		name: `${type[0].toUpperCase()}${type.slice(1)} Track`,
		type,
		order,
		parentId: null,
		muted: false,
		solo: false,
		locked: false,
		color: type === "audio" ? "#22C55E" : type === "signal" ? "#F59E0B" : "#64748B",
	};
}

/** Retains legacy curve values, tangents, and cuts while assigning stable key identity. */
function legacyPropertyKey(value: unknown, seed: unknown): TCinematicPropertyKey {
	const source = object(value, "Legacy cinematic key");
	const keyId = source.id === undefined ? generatedId("key", seed) : id(source.id, "Legacy cinematic key id");
	if (source.type === "cut") {
		const incoming = object(source.key1, "Legacy cinematic cut incoming key");
		const outgoing = object(source.key2, "Legacy cinematic cut outgoing key");
		return {
			id: keyId,
			type: "cut",
			frame: finite(incoming.frame, "Legacy cinematic cut frame", 0, cinematicDocumentLimits.maximumDurationFrames),
			incomingValue: propertyValue(incoming.value, "Legacy cinematic cut incoming value"),
			outgoingValue: propertyValue(outgoing.value, "Legacy cinematic cut outgoing value"),
		};
	}
	const normalizedValue = propertyValue(source.value, "Legacy cinematic key value");
	return {
		id: keyId,
		type: "key",
		frame: finite(source.frame, "Legacy cinematic key frame", 0, cinematicDocumentLimits.maximumDurationFrames),
		value: normalizedValue,
		interpolation:
			typeof normalizedValue === "boolean" || source.interpolation === 1 || source.interpolation === "step"
				? "step"
				: source.inTangent !== undefined || source.outTangent !== undefined
					? "cubic"
					: "linear",
		...(source.inTangent === undefined || source.inTangent === null ? {} : { inTangent: propertyValue(source.inTangent, "Legacy cinematic key inTangent") }),
		...(source.outTangent === undefined || source.outTangent === null ? {} : { outTangent: propertyValue(source.outTangent, "Legacy cinematic key outTangent") }),
	};
}

/** Preserves reverse playback but rejects legacy zero-speed clips that can never advance. */
function legacySpeed(value: unknown, label: string): number {
	if (value === undefined) {
		return 1;
	}
	const result = finite(value, label, -100, 100);
	if (Math.abs(result) < 0.01) {
		throw new Error(`${label} magnitude must be at least 0.01.`);
	}
	return result;
}

/** Maps original sparse clip timing into the complete version-2 clip contract. */
function legacyClipBase(type: TCinematicClip["type"], source: Record<string, unknown>, startFrame: number, durationFrames: number, seed: unknown): ICinematicClipBase {
	const normalizedDuration = Math.max(0.000_001, durationFrames);
	const blendInFrames = finite(source.blendInFrames ?? 0, `Legacy ${type} clip blendInFrames`, 0, normalizedDuration);
	const blendOutFrames = finite(source.blendOutFrames ?? 0, `Legacy ${type} clip blendOutFrames`, 0, normalizedDuration);
	const easeIn = source.easeIn ?? "linear";
	const easeOut = source.easeOut ?? "linear";
	const preExtrapolation = source.preExtrapolation ?? "none";
	const postExtrapolation = source.postExtrapolation ?? "none";
	if (!easingValues.includes(easeIn as TCinematicEasing) || !easingValues.includes(easeOut as TCinematicEasing)) {
		throw new Error(`Legacy ${type} clip easing is unsupported.`);
	}
	if (!extrapolationValues.includes(preExtrapolation as TCinematicExtrapolation) || !extrapolationValues.includes(postExtrapolation as TCinematicExtrapolation)) {
		throw new Error(`Legacy ${type} clip extrapolation is unsupported.`);
	}
	return {
		id: source.id === undefined ? generatedId("clip", seed) : id(source.id, `Legacy ${type} clip id`),
		name: source.name === undefined ? `${type[0].toUpperCase()}${type.slice(1)} Clip` : text(source.name, `Legacy ${type} clip name`),
		startFrame,
		durationFrames: normalizedDuration,
		clipInFrame: finite(source.clipInFrame ?? 0, `Legacy ${type} clip clipInFrame`, 0, cinematicDocumentLimits.maximumDurationFrames),
		timeScale: legacySpeed(source.speed, `Legacy ${type} clip speed`),
		enabled: source.enabled === undefined ? true : bool(source.enabled, `Legacy ${type} clip enabled`),
		blendInFrames,
		blendOutFrames,
		easeIn: easeIn as TCinematicEasing,
		easeOut: easeOut as TCinematicEasing,
		preExtrapolation: preExtrapolation as TCinematicExtrapolation,
		postExtrapolation: postExtrapolation as TCinematicExtrapolation,
	};
}

/** Converts the original optional-field track shape into lossless typed tracks. */
function migrateLegacyTrack(value: unknown, legacyIndex: number, startOrder: number): TCinematicTrack[] {
	const source = object(value, `Legacy cinematic track ${legacyIndex}`);
	const result: TCinematicTrack[] = [];
	const addBase = (type: TCinematicTrack["type"]): ICinematicTrackBase => {
		const base = defaultTrackBase(type, startOrder + result.length, { legacyIndex, type, source });
		if (!result.length && source._id !== undefined) {
			base.id = id(source._id, `Legacy cinematic track ${legacyIndex} id`);
		}
		return base;
	};
	if (source.propertyPath !== undefined || source.keyFrameAnimations !== undefined) {
		const keys = Array.isArray(source.keyFrameAnimations)
			? source.keyFrameAnimations.map((entry, index) => legacyPropertyKey(entry, { legacyIndex, type: "property", index, entry }))
			: [];
		result.push({
			...addBase("property"),
			type: "property",
			targetType: source.defaultRenderingPipeline === true ? "renderingPipeline" : "node",
			targetId: source.defaultRenderingPipeline === true ? null : text(source.node, "Legacy property target id", 256),
			propertyPath: propertyPath(source.propertyPath, "Legacy property path"),
			keys,
		});
	}
	if (source.animationGroup !== undefined || source.animationGroups !== undefined) {
		const animationGroupId = text(source.animationGroup, "Legacy animation group id", 256);
		const clips = (Array.isArray(source.animationGroups) ? source.animationGroups : []).map((entry, index): ICinematicAnimationClip => {
			const clipSource = object(entry, `Legacy animation clip ${index}`);
			const startFrame = finite(clipSource.frame, `Legacy animation clip ${index} frame`, 0, cinematicDocumentLimits.maximumDurationFrames);
			const sourceStartFrame = finite(clipSource.startFrame, `Legacy animation clip ${index} startFrame`, 0, cinematicDocumentLimits.maximumDurationFrames);
			const sourceEndFrame = finite(clipSource.endFrame, `Legacy animation clip ${index} endFrame`, sourceStartFrame, cinematicDocumentLimits.maximumDurationFrames);
			const loopCount = clipSource.repeatCount === undefined ? 0 : integer(clipSource.repeatCount, `Legacy animation clip ${index} repeatCount`, 0, 10_000);
			const speed = legacySpeed(clipSource.speed, `Legacy animation clip ${index} speed`);
			const base = legacyClipBase("animation", clipSource, startFrame, ((sourceEndFrame - sourceStartFrame) * (loopCount + 1)) / Math.abs(speed), {
				legacyIndex,
				type: "animation",
				index,
				entry,
			});
			return { ...base, type: "animation", animationGroupId, sourceStartFrame, sourceEndFrame, loopCount };
		});
		const weightKeys = Array.isArray(source.animationGroupWeight)
			? source.animationGroupWeight.map((entry, index) => legacyPropertyKey(entry, { legacyIndex, type: "weight", index, entry }))
			: [];
		result.push({ ...addBase("animation"), type: "animation", clips, weightKeys });
	}
	if (source.sound !== undefined || source.sounds !== undefined) {
		const soundId = text(source.sound, "Legacy sound id", 256);
		const clips = (Array.isArray(source.sounds) ? source.sounds : []).map((entry, index): ICinematicAudioClip => {
			const clipSource = object(entry, `Legacy audio clip ${index}`);
			const startFrame = finite(clipSource.frame, `Legacy audio clip ${index} frame`, 0, cinematicDocumentLimits.maximumDurationFrames);
			const clipInFrame = finite(clipSource.startFrame, `Legacy audio clip ${index} startFrame`, 0, cinematicDocumentLimits.maximumDurationFrames);
			const sourceEndFrame = finite(clipSource.endFrame, `Legacy audio clip ${index} endFrame`, clipInFrame, cinematicDocumentLimits.maximumDurationFrames);
			const speed = legacySpeed(clipSource.speed, `Legacy audio clip ${index} speed`);
			return {
				...legacyClipBase("audio", clipSource, startFrame, (sourceEndFrame - clipInFrame) / Math.abs(speed), { legacyIndex, type: "audio", index, entry }),
				type: "audio",
				clipInFrame,
				soundId,
				volume: finite(clipSource.volume ?? 1, `Legacy audio clip ${index} volume`, 0, 8),
				loop: clipSource.loop === undefined ? false : bool(clipSource.loop, `Legacy audio clip ${index} loop`),
			};
		});
		const volumeKeys = Array.isArray(source.soundVolume)
			? source.soundVolume.map((entry, index) => legacyPropertyKey(entry, { legacyIndex, type: "volume", index, entry }))
			: [];
		result.push({ ...addBase("audio"), type: "audio", clips, volumeKeys });
	}
	if (source.keyFrameEvents !== undefined) {
		const markers = (Array.isArray(source.keyFrameEvents) ? source.keyFrameEvents : []).map((entry, index): ICinematicMarker => {
			const event = object(entry, `Legacy event ${index}`);
			const data = event.data === undefined ? null : jsonValue(event.data, `Legacy event ${index} payload`);
			const eventData = data && typeof data === "object" && !Array.isArray(data) ? data : null;
			const eventName = typeof event.name === "string" ? event.name : eventData && typeof eventData.eventName === "string" ? eventData.eventName : `Event ${index + 1}`;
			const markerType = event.markerType === "signal" || event.markerType === "event" ? event.markerType : eventData?.type === "event" ? "signal" : "event";
			return {
				id: event.id === undefined ? generatedId("marker", { legacyIndex, index, entry }) : id(event.id, `Legacy event ${index} id`),
				name: text(eventName, `Legacy event ${index} name`),
				type: markerType,
				frame: finite(event.frame, `Legacy event ${index} frame`, 0, cinematicDocumentLimits.maximumDurationFrames),
				emitOnce: event.emitOnce === undefined ? false : bool(event.emitOnce, `Legacy event ${index} emitOnce`),
				retroactive: event.retroactive === undefined ? false : bool(event.retroactive, `Legacy event ${index} retroactive`),
				payload: data,
			};
		});
		result.push({ ...addBase("signal"), type: "signal", markers });
	}
	if (!result.length) {
		throw new Error(`Legacy cinematic track ${legacyIndex} does not contain a supported track payload.`);
	}
	return result;
}

/** Calculates the last authored frame across keys, markers, and clips in O(n). */
export function getCinematicContentEndFrame(value: Pick<ICinematicDocument, "tracks">): number {
	let result = 0;
	for (const track of value.tracks) {
		if (track.type === "property") {
			for (const key of track.keys) {
				result = Math.max(result, key.frame);
			}
		} else if (track.type === "animation") {
			for (const key of track.weightKeys) {
				result = Math.max(result, key.frame);
			}
			for (const clip of track.clips) {
				result = Math.max(result, clip.startFrame + clip.durationFrames);
			}
		} else if (track.type === "audio") {
			for (const key of track.volumeKeys) {
				result = Math.max(result, key.frame);
			}
			for (const clip of track.clips) {
				result = Math.max(result, clip.startFrame + clip.durationFrames);
			}
		} else if (track.type === "signal") {
			for (const marker of track.markers) {
				result = Math.max(result, marker.frame);
			}
		} else if (track.type !== "group") {
			for (const clip of track.clips) {
				result = Math.max(result, clip.startFrame + clip.durationFrames);
			}
		}
	}
	return result;
}

/** Enforces document-wide identity, hierarchy, reference, count, and duration invariants. */
function validateRelationships(value: ICinematicDocument): void {
	const trackIds = new Set<string>();
	const orders = new Set<number>();
	const profileIds = new Set<string>();
	const clipIds = new Set<string>();
	const keyIds = new Set<string>();
	const markerIds = new Set<string>();
	let clipCount = 0;
	let keyAndMarkerCount = 0;
	for (const profile of value.recorderProfiles) {
		if (profileIds.has(profile.id)) {
			throw new Error(`Recorder profile id "${profile.id}" is duplicated.`);
		}
		profileIds.add(profile.id);
	}
	for (const track of value.tracks) {
		if (trackIds.has(track.id)) {
			throw new Error(`Cinematic track id "${track.id}" is duplicated.`);
		}
		if (orders.has(track.order)) {
			throw new Error(`Cinematic track order ${track.order} is duplicated.`);
		}
		trackIds.add(track.id);
		orders.add(track.order);
		if (track.type === "property") {
			keyAndMarkerCount += track.keys.length;
			for (const key of track.keys) {
				if (keyIds.has(key.id)) {
					throw new Error(`Cinematic key id "${key.id}" is duplicated.`);
				}
				keyIds.add(key.id);
			}
		} else if (track.type === "animation") {
			clipCount += track.clips.length;
			keyAndMarkerCount += track.weightKeys.length;
			for (const key of track.weightKeys) {
				if (keyIds.has(key.id)) {
					throw new Error(`Cinematic key id "${key.id}" is duplicated.`);
				}
				keyIds.add(key.id);
			}
		} else if (track.type === "audio") {
			clipCount += track.clips.length;
			keyAndMarkerCount += track.volumeKeys.length;
			for (const key of track.volumeKeys) {
				if (keyIds.has(key.id)) {
					throw new Error(`Cinematic key id "${key.id}" is duplicated.`);
				}
				keyIds.add(key.id);
			}
		} else if (track.type === "signal") {
			keyAndMarkerCount += track.markers.length;
			for (const marker of track.markers) {
				if (markerIds.has(marker.id)) {
					throw new Error(`Cinematic marker id "${marker.id}" is duplicated.`);
				}
				markerIds.add(marker.id);
			}
		} else if (track.type !== "group") {
			clipCount += track.clips.length;
		}
		if ("clips" in track) {
			for (const clip of track.clips) {
				if (clipIds.has(clip.id)) {
					throw new Error(`Cinematic clip id "${clip.id}" is duplicated.`);
				}
				clipIds.add(clip.id);
			}
		}
		if (track.type === "recorder" && track.clips.some((clip) => !profileIds.has(clip.profileId))) {
			throw new Error(`Recorder track "${track.id}" references an unknown profile.`);
		}
	}
	if (clipCount > cinematicDocumentLimits.maximumClips || keyAndMarkerCount > cinematicDocumentLimits.maximumKeysAndMarkers) {
		throw new Error("Cinematic clip, key, or marker count exceeds the document limits.");
	}
	for (const track of value.tracks) {
		if (track.parentId === null) {
			continue;
		}
		const parent = value.tracks.find((candidate) => candidate.id === track.parentId);
		if (!parent || parent.type !== "group") {
			throw new Error(`Cinematic track "${track.id}" must reference an existing group parent.`);
		}
		const visited = new Set<string>([track.id]);
		let current: TCinematicTrack | undefined = parent;
		while (current) {
			if (visited.has(current.id)) {
				throw new Error(`Cinematic track group cycle includes "${current.id}".`);
			}
			visited.add(current.id);
			const parentId = current.parentId;
			current = parentId === null ? undefined : value.tracks.find((candidate) => candidate.id === parentId);
		}
	}
	const contentEnd = getCinematicContentEndFrame(value);
	if (contentEnd > cinematicDocumentLimits.maximumDurationFrames) {
		throw new Error(`Cinematic content ends after the maximum frame ${cinematicDocumentLimits.maximumDurationFrames}.`);
	}
	if (value.durationMode === "automatic") {
		value.durationFrames = contentEnd;
	} else if (value.durationFrames < contentEnd) {
		throw new Error(`Fixed cinematic duration ${value.durationFrames} ends before authored content at frame ${contentEnd}.`);
	}
}

/** Builds a fresh canonical document so validation never trusts caller-owned object identity. */
function normalizeVersion2(value: unknown): ICinematicDocument {
	const source = object(value, "Cinematic document");
	assertKeys(
		source,
		["version", "id", "revision", "name", "framesPerSecond", "outputFramesPerSecond", "durationMode", "durationFrames", "wrapMode", "tracks", "recorderProfiles"],
		"Cinematic document"
	);
	if (source.version !== cinematicDocumentVersion) {
		throw new Error(`Cinematic document version is unsupported: ${String(source.version)}.`);
	}
	if (source.durationMode !== "automatic" && source.durationMode !== "fixed") {
		throw new Error("Cinematic durationMode must be automatic or fixed.");
	}
	if (source.wrapMode !== "once" && source.wrapMode !== "loop" && source.wrapMode !== "hold") {
		throw new Error("Cinematic wrapMode must be once, loop, or hold.");
	}
	if (!Array.isArray(source.tracks) || source.tracks.length > cinematicDocumentLimits.maximumTracks) {
		throw new Error(`Cinematic supports at most ${cinematicDocumentLimits.maximumTracks} tracks.`);
	}
	if (!Array.isArray(source.recorderProfiles) || source.recorderProfiles.length > cinematicDocumentLimits.maximumRecorderProfiles) {
		throw new Error(`Cinematic supports at most ${cinematicDocumentLimits.maximumRecorderProfiles} recorder profiles.`);
	}
	const result: ICinematicDocument = {
		version: cinematicDocumentVersion,
		id: id(source.id, "Cinematic id"),
		revision: integer(source.revision, "Cinematic revision", 0, Number.MAX_SAFE_INTEGER),
		name: text(source.name, "Cinematic name"),
		framesPerSecond: finite(source.framesPerSecond, "Cinematic framesPerSecond", 1, cinematicDocumentLimits.maximumFramesPerSecond),
		outputFramesPerSecond: finite(source.outputFramesPerSecond, "Cinematic outputFramesPerSecond", 1, cinematicDocumentLimits.maximumFramesPerSecond),
		durationMode: source.durationMode,
		durationFrames: finite(source.durationFrames, "Cinematic durationFrames", 0, cinematicDocumentLimits.maximumDurationFrames),
		wrapMode: source.wrapMode,
		tracks: source.tracks.map((entry, index) => track(entry, `Cinematic track ${index}`)).sort((a, b) => a.order - b.order),
		recorderProfiles: source.recorderProfiles.map((entry, index) => recorderProfile(entry, `Recorder profile ${index}`)),
	};
	validateRelationships(result);
	return result;
}

/** Migrates an original cinematic asset into the version-2 typed document. */
export function migrateLegacyCinematic(value: unknown, options: ICinematicNormalizationOptions = {}): ICinematicDocument {
	const source = object(value, "Legacy cinematic");
	if (source.version !== undefined && source.version !== 1) {
		throw new Error(`Legacy cinematic version is unsupported: ${String(source.version)}.`);
	}
	if (!Array.isArray(source.tracks) || source.tracks.length > cinematicDocumentLimits.maximumTracks) {
		throw new Error(`Legacy cinematic supports at most ${cinematicDocumentLimits.maximumTracks} tracks.`);
	}
	const tracks: TCinematicTrack[] = [];
	for (const [index, entry] of source.tracks.entries()) {
		tracks.push(...migrateLegacyTrack(entry, index, tracks.length));
	}
	if (tracks.length > cinematicDocumentLimits.maximumTracks) {
		throw new Error(`Migrated cinematic exceeds ${cinematicDocumentLimits.maximumTracks} typed tracks.`);
	}
	const candidate: ICinematicDocument = {
		version: cinematicDocumentVersion,
		id: generatedId("cinematic", { identitySeed: options.identitySeed ?? null, name: source.name ?? "New Cinematic", tracks: source.tracks }),
		revision: 0,
		name: text(source.name ?? "New Cinematic", "Legacy cinematic name"),
		framesPerSecond: finite(source.framesPerSecond ?? 60, "Legacy cinematic framesPerSecond", 1, cinematicDocumentLimits.maximumFramesPerSecond),
		outputFramesPerSecond: finite(
			source.outputFramesPerSecond ?? source.framesPerSecond ?? 60,
			"Legacy cinematic outputFramesPerSecond",
			1,
			cinematicDocumentLimits.maximumFramesPerSecond
		),
		durationMode: "automatic",
		durationFrames: 0,
		wrapMode: "once",
		tracks,
		recorderProfiles: [],
	};
	candidate.durationFrames = getCinematicContentEndFrame(candidate);
	return normalizeVersion2(candidate);
}

/** Normalizes version-2 assets and transparently migrates the editor's original format. */
export function normalizeCinematicDocument(value: unknown, options: ICinematicNormalizationOptions = {}): ICinematicDocument {
	const source = object(value, "Cinematic document");
	return source.version === cinematicDocumentVersion ? normalizeVersion2(source) : migrateLegacyCinematic(source, options);
}

/** Creates a bounded empty document; callers may replace the deterministic id before persistence. */
export function createCinematicDocument(name = "New Cinematic", documentId?: string): ICinematicDocument {
	return normalizeVersion2({
		version: cinematicDocumentVersion,
		id: documentId ?? generatedId("cinematic", { name }),
		revision: 0,
		name,
		framesPerSecond: 60,
		outputFramesPerSecond: 60,
		durationMode: "automatic",
		durationFrames: 0,
		wrapMode: "once",
		tracks: [],
		recorderProfiles: [],
	});
}

/** Forks an asset with new path-seeded identity while preserving all authored timeline content. */
export function forkCinematicDocument(value: ICinematicDocument, identitySeed: string): ICinematicDocument {
	const normalized = normalizeVersion2(value);
	return normalizeVersion2({ ...normalized, id: generatedId("cinematic", { identitySeed, source: normalized.id }), revision: 0 });
}

/** Stable content fingerprint is shared by editor UI and exact-leased MCP mutations. */
export function getCinematicFingerprint(value: ICinematicDocument): string {
	return getECSStableHash(normalizeVersion2(value));
}

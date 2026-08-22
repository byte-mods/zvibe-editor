import {
	ICinematicClipBase,
	ICinematicDocument,
	ICinematicMarker,
	TCinematicClip,
	TCinematicEasing,
	TCinematicPropertyKey,
	TCinematicPropertyValue,
	TCinematicTrack,
	normalizeCinematicDocument,
} from "./model";

export type TCinematicPlaybackDirection = 1 | -1;

/** Describes one engine-independent clip contribution at a requested timeline frame. */
export interface ICinematicClipSample {
	trackId: string;
	clipId: string;
	type: TCinematicClip["type"];
	phase: "before" | "inside" | "after";
	timelineFrame: number;
	localFrame: number;
	sourceFrame: number;
	weight: number;
}

/** Carries an evaluated binding without mutating the bound Babylon object. */
export interface ICinematicPropertySample {
	trackId: string;
	targetType: "node" | "renderingPipeline";
	targetId: string | null;
	propertyPath: string;
	value: TCinematicPropertyValue;
}

/** Identifies the animation group and weighted source frame an adapter should apply. */
export interface ICinematicAnimationSample extends ICinematicClipSample {
	type: "animation";
	animationGroupId: string;
}

/** Identifies the sound, offset, and effective volume an adapter should apply. */
export interface ICinematicAudioSample extends ICinematicClipSample {
	type: "audio";
	soundId: string;
	volume: number;
	loop: boolean;
}

/** Identifies the persistent Video Player and Timeline playback overrides to apply. */
export interface ICinematicVideoSample extends ICinematicClipSample {
	type: "video";
	videoPlayerId: string;
	volume: number;
	loop: boolean;
	muteAudio: boolean;
	playbackSpeed: number;
}

/** Describes the desired enabled state of a scene node. */
export interface ICinematicActivationSample extends ICinematicClipSample {
	type: "activation";
	nodeId: string;
	active: boolean;
}

/** Describes an active camera shot and its authored transition. */
export interface ICinematicCameraSample extends ICinematicClipSample {
	type: "camera";
	cameraId: string;
	blendMode: "cut" | "crossFade";
}

/** Describes a nested timeline or particle-system transport command. */
export interface ICinematicControlSample extends ICinematicClipSample {
	type: "control";
	targetType: "particleSystem" | "cinematic";
	targetId: string;
	action: "play" | "stop";
}

/** Selects the capture preset active at the evaluated frame. */
export interface ICinematicRecorderSample extends ICinematicClipSample {
	type: "recorder";
	profileId: string;
}

/** Groups all deterministic track contributions for one timeline frame. */
export interface ICinematicFrameEvaluation {
	frame: number;
	properties: ICinematicPropertySample[];
	animations: ICinematicAnimationSample[];
	audio: ICinematicAudioSample[];
	videos: ICinematicVideoSample[];
	activations: ICinematicActivationSample[];
	cameras: ICinematicCameraSample[];
	controls: ICinematicControlSample[];
	recorders: ICinematicRecorderSample[];
}

/** Preserves track and loop provenance for a traversed signal marker. */
export interface ICinematicMarkerOccurrence {
	trackId: string;
	marker: ICinematicMarker;
	cycle: number;
}

/** Controls traversal direction, loops, seek semantics, and caller-owned emit history. */
export interface ICinematicMarkerQueryOptions {
	direction?: TCinematicPlaybackDirection;
	wrapCount?: number;
	mode?: "playback" | "seek";
	emittedMarkerIds?: ReadonlySet<string>;
}

/** Configures initial transport state without starting playback implicitly. */
export interface ICinematicClockOptions {
	frame?: number;
	direction?: TCinematicPlaybackDirection;
	speed?: number;
}

/** Reports an exact transport transition and the markers crossed by it. */
export interface ICinematicAdvanceResult {
	previousFrame: number;
	frame: number;
	wrapCount: number;
	completed: boolean;
	markers: ICinematicMarkerOccurrence[];
}

/** Carries normalized clip-local time without exposing internal timing helpers. */
interface ICinematicResolvedClipTime {
	phase: ICinematicClipSample["phase"];
	localFrame: number;
}

/** Defines one inclusive/exclusive marker scan segment across a timeline cycle. */
interface ICinematicMarkerRange {
	fromFrame: number;
	toFrame: number;
	direction: TCinematicPlaybackDirection;
	cycle: number;
	includeStart: boolean;
}

/** Prevents evaluated vector-like arrays from aliasing persisted key values. */
function clonePropertyValue(value: TCinematicPropertyValue): TCinematicPropertyValue {
	return Array.isArray(value) ? [...value] : value;
}

/** Selects the value seen immediately before a regular key or discontinuous cut. */
function keyIncomingValue(value: TCinematicPropertyKey): TCinematicPropertyValue {
	return value.type === "cut" ? value.incomingValue : value.value;
}

/** Selects the value seen immediately after a regular key or discontinuous cut. */
function keyOutgoingValue(value: TCinematicPropertyKey): TCinematicPropertyValue {
	return value.type === "cut" ? value.outgoingValue : value.value;
}

/** Lets scalar and vector Hermite evaluation share one numerical solver. */
function component(value: TCinematicPropertyValue, index: number): number {
	return Array.isArray(value) ? value[index] : (value as number);
}

/** Applies component-wise linear interpolation while returning fresh array values. */
function interpolateComponents(left: TCinematicPropertyValue, right: TCinematicPropertyValue, amount: number): TCinematicPropertyValue {
	if (!Array.isArray(left) || !Array.isArray(right)) {
		return (left as number) + ((right as number) - (left as number)) * amount;
	}
	return left.map((entry, index) => entry + (right[index] - entry) * amount);
}

/** Matches Babylon-style frame-scaled Hermite interpolation for scalar and vector lanes. */
function cubicComponents(
	left: TCinematicPropertyValue,
	right: TCinematicPropertyValue,
	leftTangent: TCinematicPropertyValue,
	rightTangent: TCinematicPropertyValue,
	amount: number,
	frameDelta: number
): TCinematicPropertyValue {
	const h00 = 2 * amount * amount * amount - 3 * amount * amount + 1;
	const h10 = amount * amount * amount - 2 * amount * amount + amount;
	const h01 = -2 * amount * amount * amount + 3 * amount * amount;
	const h11 = amount * amount * amount - amount * amount;
	const solve = (index: number): number =>
		h00 * component(left, index) + h10 * component(leftTangent, index) * frameDelta + h01 * component(right, index) + h11 * component(rightTangent, index) * frameDelta;
	return Array.isArray(left) ? left.map((_entry, index) => solve(index)) : solve(0);
}

/** Uses the interval slope when an author has not supplied an explicit tangent. */
function defaultTangent(left: TCinematicPropertyValue, right: TCinematicPropertyValue, frameDelta: number): TCinematicPropertyValue {
	if (!Array.isArray(left) || !Array.isArray(right)) {
		return ((right as number) - (left as number)) / frameDelta;
	}
	return left.map((entry, index) => (right[index] - entry) / frameDelta);
}

/** Converts normalized blend progress into one of the persisted easing curves. */
function easing(value: number, mode: TCinematicEasing): number {
	const amount = Math.min(1, Math.max(0, value));
	switch (mode) {
		case "easeIn":
			return amount * amount;
		case "easeOut":
			return 1 - (1 - amount) * (1 - amount);
		case "easeInOut":
			return amount < 0.5 ? 2 * amount * amount : 1 - Math.pow(-2 * amount + 2, 2) / 2;
		default:
			return amount;
	}
}

/** Keeps reverse and forward wrapping in the same non-negative timeline domain. */
function positiveModulo(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor;
}

/** Enforces direction at JavaScript runtime in addition to TypeScript narrowing. */
function playbackDirection(value: unknown): TCinematicPlaybackDirection {
	if (value !== 1 && value !== -1) {
		throw new Error("Cinematic playback direction must be 1 or -1.");
	}
	return value;
}

/** Maps time outside a clip according to its finite extrapolation contract. */
function extrapolatedLocalFrame(value: number, duration: number, mode: ICinematicClipBase["preExtrapolation"]): number | null {
	switch (mode) {
		case "none":
			return null;
		case "hold":
			return value < 0 ? 0 : duration;
		case "loop":
			return positiveModulo(value, duration);
		case "pingPong": {
			const period = duration * 2;
			const wrapped = positiveModulo(value, period);
			return wrapped <= duration ? wrapped : period - wrapped;
		}
		case "continue":
			return value;
	}
}

/** Distinguishes inactive, authored, and extrapolated clip time before sampling. */
function resolveClipTime(clip: ICinematicClipBase, frame: number): ICinematicResolvedClipTime | null {
	const relative = frame - clip.startFrame;
	if (relative < 0) {
		const localFrame = extrapolatedLocalFrame(relative, clip.durationFrames, clip.preExtrapolation);
		return localFrame === null ? null : { phase: "before", localFrame };
	}
	if (relative >= clip.durationFrames) {
		const localFrame = extrapolatedLocalFrame(relative, clip.durationFrames, clip.postExtrapolation);
		return localFrame === null ? null : { phase: "after", localFrame };
	}
	return { phase: "inside", localFrame: relative };
}

/** Combines bounded blend-in and blend-out envelopes into one clip weight. */
function clipWeight(clip: ICinematicClipBase, time: ICinematicResolvedClipTime): number {
	if (time.phase !== "inside") {
		return 1;
	}
	const blendIn = clip.blendInFrames ? easing(time.localFrame / clip.blendInFrames, clip.easeIn) : 1;
	const blendOut = clip.blendOutFrames ? 1 - easing((time.localFrame - (clip.durationFrames - clip.blendOutFrames)) / clip.blendOutFrames, clip.easeOut) : 1;
	return Math.min(blendIn, blendOut);
}

/** Resolves source ranges, repeat counts, clip-in, and reverse playback without engine state. */
function animationSourceFrame(clip: Extract<TCinematicClip, { type: "animation" }>, localFrame: number): number {
	const span = clip.sourceEndFrame - clip.sourceStartFrame;
	if (!span) {
		return clip.sourceStartFrame;
	}
	const progress = clip.clipInFrame + localFrame * Math.abs(clip.timeScale);
	const maximumProgress = span * (clip.loopCount + 1);
	if (progress >= maximumProgress) {
		return clip.timeScale > 0 ? clip.sourceEndFrame : clip.sourceStartFrame;
	}
	const wrapped = positiveModulo(progress, span);
	return clip.timeScale > 0 ? clip.sourceStartFrame + wrapped : clip.sourceEndFrame - wrapped;
}

/** Produces common timing output before typed tracks attach their adapter-specific identity. */
function sampleClip(trackId: string, clip: TCinematicClip, frame: number): ICinematicClipSample | null {
	if (!clip.enabled) {
		return null;
	}
	const time = resolveClipTime(clip, frame);
	if (!time) {
		return null;
	}
	return {
		trackId,
		clipId: clip.id,
		type: clip.type,
		phase: time.phase,
		timelineFrame: frame,
		localFrame: time.localFrame,
		sourceFrame: clip.type === "animation" ? animationSourceFrame(clip, time.localFrame) : clip.clipInFrame + time.localFrame * clip.timeScale,
		weight: clipWeight(clip, time),
	};
}

/** Resolves a bounded ancestor chain for hierarchical mute and solo semantics. */
function parentTracks(document: ICinematicDocument, track: TCinematicTrack): TCinematicTrack[] {
	const result: TCinematicTrack[] = [];
	const visited = new Set<string>([track.id]);
	let parentId = track.parentId;
	while (parentId !== null) {
		if (visited.has(parentId)) {
			break;
		}
		visited.add(parentId);
		const parent = document.tracks.find((candidate) => candidate.id === parentId);
		if (!parent) {
			break;
		}
		result.push(parent);
		parentId = parent.parentId;
	}
	return result;
}

/** Selects playable leaf tracks after applying ancestor mute and solo branches. */
function activeTracks(document: ICinematicDocument): TCinematicTrack[] {
	const hasSolo = document.tracks.some((track) => track.solo);
	return document.tracks.filter((track) => {
		if (track.type === "group" || track.muted) {
			return false;
		}
		const parents = parentTracks(document, track);
		if (parents.some((parent) => parent.muted)) {
			return false;
		}
		return !hasSolo || track.solo || parents.some((parent) => parent.solo);
	});
}

/** Evaluates a normalized property lane at any finite frame without mutating its keys. */
export function sampleCinematicPropertyKeys(keys: readonly TCinematicPropertyKey[], frame: number, direction: TCinematicPlaybackDirection = 1): TCinematicPropertyValue | null {
	if (!Number.isFinite(frame)) {
		throw new Error("Cinematic sample frame must be finite.");
	}
	playbackDirection(direction);
	if (!keys.length) {
		return null;
	}
	const exact = [...keys].reverse().find((key) => key.frame === frame);
	if (exact) {
		return clonePropertyValue(direction === 1 ? keyOutgoingValue(exact) : keyIncomingValue(exact));
	}
	const rightIndex = keys.findIndex((key) => key.frame > frame);
	if (rightIndex === 0) {
		return clonePropertyValue(keyIncomingValue(keys[0]));
	}
	if (rightIndex === -1) {
		return clonePropertyValue(keyOutgoingValue(keys[keys.length - 1]));
	}
	const leftKey = keys[rightIndex - 1];
	const rightKey = keys[rightIndex];
	const left = keyOutgoingValue(leftKey);
	const right = keyIncomingValue(rightKey);
	if (typeof left === "boolean" || typeof right === "boolean" || (leftKey.type === "key" && leftKey.interpolation === "step")) {
		return clonePropertyValue(left);
	}
	const frameDelta = rightKey.frame - leftKey.frame;
	const amount = (frame - leftKey.frame) / frameDelta;
	if (leftKey.type !== "key" || leftKey.interpolation !== "cubic") {
		return interpolateComponents(left, right, amount);
	}
	const tangent = defaultTangent(left, right, frameDelta);
	return cubicComponents(left, right, leftKey.outTangent ?? tangent, rightKey.type === "key" ? (rightKey.inTangent ?? tangent) : tangent, amount, frameDelta);
}

/** Evaluates all active typed tracks into an engine-independent frame snapshot. */
export function evaluateCinematicFrame(document: ICinematicDocument, frame: number, direction: TCinematicPlaybackDirection = 1): ICinematicFrameEvaluation {
	if (!Number.isFinite(frame) || frame < 0 || frame > document.durationFrames) {
		throw new Error(`Cinematic evaluation frame must be within 0..${document.durationFrames}.`);
	}
	playbackDirection(direction);
	const result: ICinematicFrameEvaluation = { frame, properties: [], animations: [], audio: [], videos: [], activations: [], cameras: [], controls: [], recorders: [] };
	const sampleFrame = document.wrapMode === "hold" && frame === document.durationFrames && frame > 0 ? Math.max(0, frame - 0.000_001) : frame;
	for (const track of activeTracks(document)) {
		if (track.type === "property") {
			const value = sampleCinematicPropertyKeys(track.keys, sampleFrame, direction);
			if (value !== null) {
				result.properties.push({ trackId: track.id, targetType: track.targetType, targetId: track.targetId, propertyPath: track.propertyPath, value });
			}
			continue;
		}
		if (track.type === "signal") {
			continue;
		}
		if (track.type === "group") {
			continue;
		}
		const automatedWeight = track.type === "animation" ? sampleCinematicPropertyKeys(track.weightKeys, sampleFrame, direction) : null;
		const automatedVolume = track.type === "audio" ? sampleCinematicPropertyKeys(track.volumeKeys, sampleFrame, direction) : null;
		for (const clip of track.clips) {
			const sample = sampleClip(track.id, clip, sampleFrame);
			if (!sample) {
				continue;
			}
			switch (clip.type) {
				case "animation":
					result.animations.push({
						...sample,
						type: "animation",
						animationGroupId: clip.animationGroupId,
						weight: sample.weight * (typeof automatedWeight === "number" ? automatedWeight : 1),
					});
					break;
				case "audio":
					result.audio.push({
						...sample,
						type: "audio",
						soundId: clip.soundId,
						volume: clip.volume * sample.weight * (typeof automatedVolume === "number" ? automatedVolume : 1),
						loop: clip.loop,
					});
					break;
				case "video":
					result.videos.push({
						...sample,
						type: "video",
						videoPlayerId: clip.videoPlayerId,
						volume: clip.volume * sample.weight,
						loop: clip.loop,
						muteAudio: clip.muteAudio,
						playbackSpeed: clip.timeScale,
					});
					break;
				case "activation":
					result.activations.push({ ...sample, type: "activation", nodeId: clip.nodeId, active: clip.active });
					break;
				case "camera":
					result.cameras.push({ ...sample, type: "camera", cameraId: clip.cameraId, blendMode: clip.blendMode });
					break;
				case "control":
					result.controls.push({ ...sample, type: "control", targetType: clip.targetType, targetId: clip.targetId, action: clip.action });
					break;
				case "recorder":
					result.recorders.push({ ...sample, type: "recorder", profileId: clip.profileId });
					break;
			}
		}
	}
	return result;
}

/** Scans one non-wrapping traversal segment with explicit endpoint semantics. */
function markersForRange(
	document: ICinematicDocument,
	range: ICinematicMarkerRange,
	emittedMarkerIds: ReadonlySet<string>,
	mode: "playback" | "seek"
): ICinematicMarkerOccurrence[] {
	const result: ICinematicMarkerOccurrence[] = [];
	for (const track of activeTracks(document)) {
		if (track.type !== "signal") {
			continue;
		}
		for (const marker of track.markers) {
			const afterStart =
				range.direction === 1
					? range.includeStart
						? marker.frame >= range.fromFrame
						: marker.frame > range.fromFrame
					: range.includeStart
						? marker.frame <= range.fromFrame
						: marker.frame < range.fromFrame;
			const beforeEnd = range.direction === 1 ? marker.frame <= range.toFrame : marker.frame >= range.toFrame;
			if (afterStart && beforeEnd && !(mode === "seek" && !marker.retroactive) && !(marker.emitOnce && emittedMarkerIds.has(marker.id))) {
				result.push({ trackId: track.id, marker: structuredClone(marker), cycle: range.cycle });
			}
		}
	}
	return result.sort(
		(left, right) => range.direction * (left.marker.frame - right.marker.frame) || left.trackId.localeCompare(right.trackId) || left.marker.id.localeCompare(right.marker.id)
	);
}

/** Deduplicates emit-once markers both across prior state and within a multi-loop query. */
function filterEmitOnce(occurrences: readonly ICinematicMarkerOccurrence[], emittedMarkerIds: ReadonlySet<string>): ICinematicMarkerOccurrence[] {
	const seen = new Set(emittedMarkerIds);
	return occurrences.filter((occurrence) => {
		if (!occurrence.marker.emitOnce) {
			return true;
		}
		if (seen.has(occurrence.marker.id)) {
			return false;
		}
		seen.add(occurrence.marker.id);
		return true;
	});
}

/** Returns markers in traversal order across a bounded number of forward or reverse wraps. */
export function getCinematicMarkersBetween(
	document: ICinematicDocument,
	fromFrame: number,
	toFrame: number,
	options: ICinematicMarkerQueryOptions = {}
): ICinematicMarkerOccurrence[] {
	const direction = options.direction ?? 1;
	const wrapCount = options.wrapCount ?? 0;
	const mode = options.mode ?? "playback";
	const emitted = options.emittedMarkerIds ?? new Set<string>();
	playbackDirection(direction);
	if (mode !== "playback" && mode !== "seek") {
		throw new Error("Cinematic marker query mode must be playback or seek.");
	}
	if (![fromFrame, toFrame].every((frame) => Number.isFinite(frame) && frame >= 0 && frame <= document.durationFrames)) {
		throw new Error(`Cinematic marker query frames must be within 0..${document.durationFrames}.`);
	}
	if (!Number.isSafeInteger(wrapCount) || wrapCount < 0 || wrapCount > 1000) {
		throw new Error("Cinematic marker query wrapCount must be an integer within 0..1000.");
	}
	if (!wrapCount) {
		if ((direction === 1 && toFrame < fromFrame) || (direction === -1 && toFrame > fromFrame)) {
			throw new Error("Cinematic marker query direction does not reach its destination without wrapping.");
		}
		return filterEmitOnce(markersForRange(document, { fromFrame, toFrame, direction, cycle: 0, includeStart: false }, emitted, mode), emitted);
	}
	if (!document.durationFrames) {
		throw new Error("A zero-duration cinematic cannot be queried with wrapping.");
	}
	const boundary = direction === 1 ? document.durationFrames : 0;
	const restart = direction === 1 ? 0 : document.durationFrames;
	const result = markersForRange(document, { fromFrame, toFrame: boundary, direction, cycle: 0, includeStart: false }, emitted, mode);
	for (let cycle = 1; cycle < wrapCount; ++cycle) {
		result.push(...markersForRange(document, { fromFrame: restart, toFrame: boundary, direction, cycle, includeStart: true }, emitted, mode));
	}
	result.push(...markersForRange(document, { fromFrame: restart, toFrame, direction, cycle: wrapCount, includeStart: true }, emitted, mode));
	return filterEmitOnce(result, emitted);
}

/** Owns deterministic transport and marker history for one normalized cinematic document. */
export class CinematicPlaybackClock {
	private readonly _document: ICinematicDocument;
	private readonly _emittedMarkerIds = new Set<string>();
	private _frame: number;
	private _direction: TCinematicPlaybackDirection;
	private _speed: number;
	private _playing = false;

	/** Normalizes and isolates input so callers cannot mutate playback state out of band. */
	public constructor(document: ICinematicDocument, options: ICinematicClockOptions = {}) {
		this._document = normalizeCinematicDocument(document);
		this._frame = options.frame ?? 0;
		this._direction = options.direction ?? 1;
		this._speed = options.speed ?? 1;
		this.seek(this._frame);
		this.setDirection(this._direction);
		this.setSpeed(this._speed);
	}

	/** Returns a defensive document snapshot for inspectors and adapters. */
	public get document(): ICinematicDocument {
		return structuredClone(this._document);
	}

	/** Exposes the exact current timeline frame, including subframes. */
	public get frame(): number {
		return this._frame;
	}

	/** Reports whether real-time advance calls currently affect transport. */
	public get playing(): boolean {
		return this._playing;
	}

	/** Reports the active forward or reverse traversal direction. */
	public get direction(): TCinematicPlaybackDirection {
		return this._direction;
	}

	/** Reports the bounded playback-rate multiplier. */
	public get speed(): number {
		return this._speed;
	}

	/** Enables real-time advances without changing the current frame. */
	public play(): void {
		this._playing = true;
	}

	/** Suspends real-time advances while preserving the current frame and emit history. */
	public pause(): void {
		this._playing = false;
	}

	/** Resets transport to its directional origin and starts a new emit-once session. */
	public stop(): void {
		this._playing = false;
		this._frame = this._direction === 1 ? 0 : this._document.durationFrames;
		this._emittedMarkerIds.clear();
	}

	/** Changes traversal direction after runtime validation. */
	public setDirection(value: TCinematicPlaybackDirection): void {
		this._direction = playbackDirection(value);
	}

	/** Bounds playback rate so one tick cannot create unmanageable traversal work. */
	public setSpeed(value: number): void {
		if (!Number.isFinite(value) || value < 0.01 || value > 100) {
			throw new Error("Cinematic playback speed must be finite and within 0.01..100.");
		}
		this._speed = value;
	}

	/** Moves directly to a frame and optionally emits only markers authored as retroactive. */
	public seek(frame: number, emitRetroactive = false): ICinematicMarkerOccurrence[] {
		if (!Number.isFinite(frame) || frame < 0 || frame > this._document.durationFrames) {
			throw new Error(`Cinematic seek frame must be within 0..${this._document.durationFrames}.`);
		}
		const markers = emitRetroactive
			? getCinematicMarkersBetween(this._document, this._frame, frame, {
					direction: frame >= this._frame ? 1 : -1,
					mode: "seek",
					emittedMarkerIds: this._emittedMarkerIds,
				})
			: [];
		this._frame = frame;
		this._rememberMarkers(markers);
		return markers;
	}

	/** Advances an exact integer number of authored frames even while paused. */
	public step(frameCount = 1): ICinematicAdvanceResult {
		if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 1_000_000) {
			throw new Error("Cinematic step frameCount must be an integer within 1..1,000,000.");
		}
		return this._advanceFrames(frameCount * this._direction);
	}

	/** Converts bounded wall-clock time into deterministic authored-frame traversal. */
	public advance(deltaSeconds: number): ICinematicAdvanceResult {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 86_400) {
			throw new Error("Cinematic advance deltaSeconds must be finite and within 0..86,400.");
		}
		if (!this._playing || deltaSeconds === 0) {
			return { previousFrame: this._frame, frame: this._frame, wrapCount: 0, completed: false, markers: [] };
		}
		return this._advanceFrames(deltaSeconds * this._document.framesPerSecond * this._speed * this._direction);
	}

	/** Evaluates the isolated document at the clock's current transport state. */
	public evaluate(): ICinematicFrameEvaluation {
		return evaluateCinematicFrame(this._document, this._frame, this._direction);
	}

	/** Centralizes wrap, completion, and marker semantics for step and real-time advance. */
	private _advanceFrames(deltaFrames: number): ICinematicAdvanceResult {
		const previousFrame = this._frame;
		const duration = this._document.durationFrames;
		if (!duration) {
			this._playing = false;
			return { previousFrame, frame: 0, wrapCount: 0, completed: true, markers: [] };
		}
		const rawFrame = previousFrame + deltaFrames;
		let wrapCount = 0;
		let completed = false;
		if (this._document.wrapMode === "loop") {
			if (rawFrame >= duration) {
				wrapCount = Math.floor(rawFrame / duration);
			} else if (rawFrame < 0) {
				wrapCount = Math.ceil(-rawFrame / duration);
			}
			if (wrapCount > 1000) {
				throw new Error("One cinematic clock advance cannot cross more than 1000 loops.");
			}
			this._frame = positiveModulo(rawFrame, duration);
		} else {
			this._frame = Math.min(duration, Math.max(0, rawFrame));
			completed = rawFrame >= duration || rawFrame <= 0;
			if (completed) {
				this._playing = false;
			}
		}
		const markers = getCinematicMarkersBetween(this._document, previousFrame, this._frame, {
			direction: deltaFrames >= 0 ? 1 : -1,
			wrapCount,
			emittedMarkerIds: this._emittedMarkerIds,
		});
		this._rememberMarkers(markers);
		return { previousFrame, frame: this._frame, wrapCount, completed, markers };
	}

	/** Records only emit-once IDs so ordinary signals can repeat every loop. */
	private _rememberMarkers(markers: readonly ICinematicMarkerOccurrence[]): void {
		for (const occurrence of markers) {
			if (occurrence.marker.emitOnce) {
				this._emittedMarkerIds.add(occurrence.marker.id);
			}
		}
	}
}

export type TSplineCameraTimelineEasing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "step";
export type TSplineCameraTimelineWrapMode = "once" | "loop" | "pingPong";

export interface ISplineCameraTimelineKey {
	id: string;
	time: number;
	t: number;
	easing: TSplineCameraTimelineEasing;
}

export interface ISplineCameraTimeline {
	version: 1;
	revision: number;
	duration: number;
	autoPlay: boolean;
	wrapMode: TSplineCameraTimelineWrapMode;
	keys: ISplineCameraTimelineKey[];
}

export interface ISplineCameraTimelineSample {
	time: number;
	t: number;
	fromKeyId: string;
	toKeyId: string;
	segmentAmount: number;
	easedAmount: number;
}

export interface ISplineCameraTimelineAdvance {
	time: number;
	direction: 1 | -1;
	playing: boolean;
	boundaryCrossings: number;
}

const easingValues: TSplineCameraTimelineEasing[] = ["linear", "easeIn", "easeOut", "easeInOut", "step"];
const wrapValues: TSplineCameraTimelineWrapMode[] = ["once", "loop", "pingPong"];

function assertFiniteRange(value: number, name: string, minimum: number, maximum: number): void {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be finite and within ${minimum}..${maximum}.`);
	}
}

/** Validates one bounded, exact-revision camera-path timeline without changing it. */
export function validateSplineCameraTimeline(value: ISplineCameraTimeline): void {
	if (value.version !== 1) {
		throw new Error("Spline camera timeline version must be 1.");
	}
	if (!Number.isInteger(value.revision) || value.revision < 1) {
		throw new Error("Spline camera timeline revision must be a positive integer.");
	}
	assertFiniteRange(value.duration, "Timeline duration", 0.01, 86_400);
	if (typeof value.autoPlay !== "boolean") {
		throw new Error("Timeline autoPlay must be a Boolean.");
	}
	if (!wrapValues.includes(value.wrapMode)) {
		throw new Error("Timeline wrapMode must be once, loop, or pingPong.");
	}
	if (!Array.isArray(value.keys) || value.keys.length < 2 || value.keys.length > 512) {
		throw new Error("A spline camera timeline requires 2 through 512 keys.");
	}
	const ids = new Set<string>();
	let previousTime = -1;
	for (const [index, key] of value.keys.entries()) {
		if (typeof key.id !== "string" || !key.id || key.id.length > 256 || ids.has(key.id)) {
			throw new Error("Timeline key ids must be unique strings containing 1 through 256 characters.");
		}
		ids.add(key.id);
		assertFiniteRange(key.time, `Timeline key ${index} time`, 0, value.duration);
		assertFiniteRange(key.t, `Timeline key ${index} path position`, 0, 1);
		if (key.time <= previousTime) {
			throw new Error("Timeline key times must be strictly increasing.");
		}
		if (!easingValues.includes(key.easing)) {
			throw new Error("Timeline key easing must be linear, easeIn, easeOut, easeInOut, or step.");
		}
		previousTime = key.time;
	}
	if (value.keys[0].time !== 0 || value.keys[value.keys.length - 1].time !== value.duration) {
		throw new Error("Timeline keys must include exact endpoints at time 0 and duration.");
	}
}

function ease(value: number, mode: TSplineCameraTimelineEasing): number {
	switch (mode) {
		case "easeIn":
			return value * value;
		case "easeOut":
			return 1 - (1 - value) * (1 - value);
		case "easeInOut":
			return value < 0.5 ? 2 * value * value : 1 - 2 * (1 - value) * (1 - value);
		case "step":
			return value >= 1 ? 1 : 0;
		default:
			return value;
	}
}

/** Samples normalized spline distance from the key immediately before the requested timeline time. */
export function sampleSplineCameraTimeline(value: ISplineCameraTimeline, time: number): ISplineCameraTimelineSample {
	validateSplineCameraTimeline(value);
	const boundedTime = Math.max(0, Math.min(value.duration, time));
	let toIndex = value.keys.findIndex((key) => key.time >= boundedTime);
	if (toIndex <= 0) {
		toIndex = Math.min(1, value.keys.length - 1);
	}
	const from = value.keys[toIndex - 1];
	const to = value.keys[toIndex];
	const segmentAmount = to.time === from.time ? 1 : Math.max(0, Math.min(1, (boundedTime - from.time) / (to.time - from.time)));
	const easedAmount = ease(segmentAmount, from.easing);
	return {
		time: boundedTime,
		t: from.t + (to.t - from.t) * easedAmount,
		fromKeyId: from.id,
		toKeyId: to.id,
		segmentAmount,
		easedAmount,
	};
}

/** Advances one timeline clock without mutating persisted authoring data. */
export function advanceSplineCameraTimeline(
	time: number,
	deltaSeconds: number,
	duration: number,
	wrapMode: TSplineCameraTimelineWrapMode,
	direction: 1 | -1
): ISplineCameraTimelineAdvance {
	assertFiniteRange(time, "Timeline playback time", 0, duration);
	assertFiniteRange(deltaSeconds, "Timeline delta", 0, 86_400);
	if (wrapMode === "once") {
		const next = Math.max(0, Math.min(duration, time + deltaSeconds * direction));
		return { time: next, direction, playing: direction > 0 ? next < duration : next > 0, boundaryCrossings: next === time + deltaSeconds * direction ? 0 : 1 };
	}
	if (wrapMode === "loop") {
		const unwrapped = time + deltaSeconds;
		const boundaryCrossings = Math.max(0, Math.floor(unwrapped / duration));
		return { time: ((unwrapped % duration) + duration) % duration, direction: 1, playing: true, boundaryCrossings };
	}
	const period = duration * 2;
	const phase = direction > 0 ? time : period - time;
	const nextPhase = phase + deltaSeconds;
	const normalized = ((nextPhase % period) + period) % period;
	const nextDirection: 1 | -1 = normalized <= duration ? 1 : -1;
	const nextTime = nextDirection > 0 ? normalized : period - normalized;
	return {
		time: nextTime,
		direction: nextDirection,
		playing: true,
		boundaryCrossings: Math.max(0, Math.floor(nextPhase / duration) - Math.floor(phase / duration)),
	};
}

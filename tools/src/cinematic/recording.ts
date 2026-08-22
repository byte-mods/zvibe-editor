import { ICinematicDocument, ICinematicRecorderProfile, cinematicDocumentLimits, normalizeCinematicDocument } from "./model";

export const maximumCinematicCaptureFrames = 1_000_000;

/** Selects a half-open timeline interval for deterministic capture. */
export interface ICinematicCaptureRange {
	startFrame?: number;
	endFrame?: number;
}

/** Describes one bounded capture without allocating an entry for every output frame. */
export interface ICinematicCapturePlan {
	documentId: string;
	documentRevision: number;
	profile: ICinematicRecorderProfile;
	startFrame: number;
	endFrame: number;
	frameCount: number;
	timelineFramesPerOutputFrame: number;
}

/** Maps an output frame index to exact timeline time and monotonic media time. */
export interface ICinematicCaptureSample {
	index: number;
	timelineFrame: number;
	timestampMicroseconds: number;
}

/** Validates and freezes a recorder profile plus range into a bounded deterministic plan. */
export function createCinematicCapturePlan(document: ICinematicDocument, profileId: string, range: ICinematicCaptureRange = {}): ICinematicCapturePlan {
	const current = normalizeCinematicDocument(document);
	const profile = current.recorderProfiles.find((candidate) => candidate.id === profileId);
	if (!profile) {
		throw new Error(`Cinematic recorder profile "${profileId}" was not found.`);
	}
	const startFrame = range.startFrame ?? 0;
	const endFrame = range.endFrame ?? current.durationFrames;
	for (const [label, value] of [
		["start", startFrame],
		["end", endFrame],
	] as const) {
		if (!Number.isFinite(value) || value < 0 || value > cinematicDocumentLimits.maximumDurationFrames) {
			throw new Error(`Cinematic capture ${label} frame must be finite and within 0..${cinematicDocumentLimits.maximumDurationFrames}.`);
		}
	}
	if (endFrame <= startFrame) {
		throw new Error("Cinematic capture end frame must be greater than its start frame.");
	}
	if (endFrame > current.durationFrames) {
		throw new Error(`Cinematic capture end frame ${endFrame} exceeds document duration ${current.durationFrames}.`);
	}
	const timelineFramesPerOutputFrame = current.framesPerSecond / profile.framesPerSecond;
	const frameCount = Math.ceil((endFrame - startFrame) / timelineFramesPerOutputFrame);
	if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > maximumCinematicCaptureFrames) {
		throw new Error(`Cinematic captures are limited to ${maximumCinematicCaptureFrames.toLocaleString()} output frames.`);
	}
	return {
		documentId: current.id,
		documentRevision: current.revision,
		profile: structuredClone(profile),
		startFrame,
		endFrame,
		frameCount,
		timelineFramesPerOutputFrame,
	};
}

/** Resolves one plan index lazily so long captures remain constant-memory. */
export function getCinematicCaptureSample(plan: ICinematicCapturePlan, index: number): ICinematicCaptureSample {
	if (!Number.isSafeInteger(index) || index < 0 || index >= plan.frameCount) {
		throw new Error(`Cinematic capture index must be within 0..${Math.max(0, plan.frameCount - 1)}.`);
	}
	return {
		index,
		timelineFrame: Math.min(plan.endFrame, plan.startFrame + index * plan.timelineFramesPerOutputFrame),
		timestampMicroseconds: Math.round((index * 1_000_000) / plan.profile.framesPerSecond),
	};
}

import { describe, expect, test } from "vitest";

import { createCinematicCapturePlan, createCinematicDocument, createCinematicRecorderProfile, getCinematicCaptureSample } from "../../src";

function documentWithProfile() {
	let document = createCinematicDocument("Capture", "capture");
	document = { ...document, framesPerSecond: 30, durationMode: "fixed", durationFrames: 60 };
	return createCinematicRecorderProfile(document, document.revision, {
		id: "output",
		name: "Output",
		format: "webm",
		width: 1920,
		height: 1080,
		framesPerSecond: 60,
		quality: 0.9,
		includeAudio: false,
	});
}

describe("cinematic deterministic capture plans", () => {
	test("maps output FPS to exact fractional timeline frames and media timestamps", () => {
		const document = documentWithProfile();
		const plan = createCinematicCapturePlan(document, "output", { startFrame: 10, endFrame: 40 });

		expect(plan).toMatchObject({ frameCount: 60, startFrame: 10, endFrame: 40, timelineFramesPerOutputFrame: 0.5 });
		expect(getCinematicCaptureSample(plan, 0)).toEqual({ index: 0, timelineFrame: 10, timestampMicroseconds: 0 });
		expect(getCinematicCaptureSample(plan, 1)).toEqual({ index: 1, timelineFrame: 10.5, timestampMicroseconds: 16667 });
		expect(getCinematicCaptureSample(plan, 59)).toEqual({ index: 59, timelineFrame: 39.5, timestampMicroseconds: 983333 });
	});

	test("rejects missing profiles, invalid ranges, overflow, and invalid sample indexes", () => {
		const document = documentWithProfile();
		expect(() => createCinematicCapturePlan(document, "missing")).toThrow("was not found");
		expect(() => createCinematicCapturePlan(document, "output", { startFrame: 20, endFrame: 20 })).toThrow("greater");
		expect(() => createCinematicCapturePlan(document, "output", { endFrame: 61 })).toThrow("exceeds");
		const plan = createCinematicCapturePlan(document, "output");
		expect(() => getCinematicCaptureSample(plan, -1)).toThrow("within");
		expect(() => getCinematicCaptureSample(plan, plan.frameCount)).toThrow("within");
	});
});

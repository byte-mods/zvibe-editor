import { describe, expect, test } from "vitest";

import { advanceSplineCameraTimeline, ISplineCameraTimeline, sampleSplineCameraTimeline, validateSplineCameraTimeline } from "../../src/loading/spline-camera-timeline";

function timeline(): ISplineCameraTimeline {
	return {
		version: 1,
		revision: 1,
		duration: 4,
		autoPlay: false,
		wrapMode: "once",
		keys: [
			{ id: "start", time: 0, t: 0, easing: "easeIn" },
			{ id: "middle", time: 2, t: 0.5, easing: "step" },
			{ id: "end", time: 4, t: 1, easing: "linear" },
		],
	};
}

describe("loading/spline-camera-timeline", () => {
	test("samples outgoing easing and stepped holds deterministically", () => {
		const value = timeline();
		expect(sampleSplineCameraTimeline(value, 1)).toMatchObject({ t: 0.125, fromKeyId: "start", toKeyId: "middle", segmentAmount: 0.5, easedAmount: 0.25 });
		expect(sampleSplineCameraTimeline(value, 3)).toMatchObject({ t: 0.5, fromKeyId: "middle", toKeyId: "end", segmentAmount: 0.5, easedAmount: 0 });
		expect(sampleSplineCameraTimeline(value, 4).t).toBe(1);
	});

	test("advances once, loop, and ping-pong clocks without mutating authoring data", () => {
		expect(advanceSplineCameraTimeline(3.5, 1, 4, "once", 1)).toEqual({ time: 4, direction: 1, playing: false, boundaryCrossings: 1 });
		expect(advanceSplineCameraTimeline(3.5, 1, 4, "loop", 1)).toEqual({ time: 0.5, direction: 1, playing: true, boundaryCrossings: 1 });
		expect(advanceSplineCameraTimeline(3.5, 1, 4, "pingPong", 1)).toEqual({ time: 3.5, direction: -1, playing: true, boundaryCrossings: 1 });
	});

	test("rejects duplicate, unordered, missing-endpoint, and out-of-range keys", () => {
		const duplicate = timeline();
		duplicate.keys[1].id = duplicate.keys[0].id;
		expect(() => validateSplineCameraTimeline(duplicate)).toThrow("unique");
		const unordered = timeline();
		unordered.keys[1].time = 4;
		expect(() => validateSplineCameraTimeline(unordered)).toThrow("strictly increasing");
		const missingEndpoint = timeline();
		missingEndpoint.keys[2].time = 3;
		expect(() => validateSplineCameraTimeline(missingEndpoint)).toThrow("exact endpoints");
		const outOfRange = timeline();
		outOfRange.keys[1].t = 2;
		expect(() => validateSplineCameraTimeline(outOfRange)).toThrow("path position");
	});
});

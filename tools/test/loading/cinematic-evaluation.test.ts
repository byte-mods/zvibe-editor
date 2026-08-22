import { describe, expect, test } from "vitest";

import {
	CinematicPlaybackClock,
	createCinematicDocument,
	evaluateCinematicFrame,
	getCinematicMarkersBetween,
	normalizeCinematicDocument,
	sampleCinematicPropertyKeys,
} from "../../src";

function trackBase(id: string, type: string, order: number, parentId: string | null = null) {
	return { id, name: id, type, order, parentId, muted: false, solo: false, locked: false, color: "#445566" };
}

function clipBase(id: string, type: string, startFrame = 0, durationFrames = 10) {
	return {
		id,
		type,
		name: id,
		startFrame,
		durationFrames,
		clipInFrame: 0,
		timeScale: 1,
		enabled: true,
		blendInFrames: 0,
		blendOutFrames: 0,
		easeIn: "linear",
		easeOut: "linear",
		preExtrapolation: "none",
		postExtrapolation: "none",
	};
}

describe("cinematic deterministic evaluation", () => {
	test("samples linear, cubic, step, and directional cut values", () => {
		const linear = [
			{ id: "a", type: "key" as const, frame: 0, value: 0, interpolation: "linear" as const },
			{ id: "b", type: "key" as const, frame: 10, value: 10, interpolation: "linear" as const },
		];
		expect(sampleCinematicPropertyKeys(linear, 5)).toBe(5);

		const cubic = [
			{ id: "a", type: "key" as const, frame: 0, value: [0, 0], interpolation: "cubic" as const, outTangent: [1, 2] },
			{ id: "b", type: "key" as const, frame: 10, value: [10, 20], interpolation: "linear" as const, inTangent: [1, 2] },
		];
		expect(sampleCinematicPropertyKeys(cubic, 5)).toEqual([5, 10]);

		const stepped = [
			{ id: "a", type: "key" as const, frame: 0, value: true, interpolation: "step" as const },
			{ id: "b", type: "key" as const, frame: 10, value: false, interpolation: "step" as const },
		];
		expect(sampleCinematicPropertyKeys(stepped, 9)).toBe(true);

		const cut = [{ id: "cut", type: "cut" as const, frame: 5, incomingValue: 1, outgoingValue: 2 }];
		expect(sampleCinematicPropertyKeys(cut, 5, 1)).toBe(2);
		expect(sampleCinematicPropertyKeys(cut, 5, -1)).toBe(1);
		expect(() => sampleCinematicPropertyKeys(cut, 5, 0 as 1)).toThrow("direction must be 1 or -1");
	});

	test("honors group solo/mute state and evaluates every typed clip deterministically", () => {
		const document = normalizeCinematicDocument({
			...createCinematicDocument("Evaluation", "evaluation"),
			durationMode: "fixed",
			durationFrames: 20,
			recorderProfiles: [{ id: "capture", name: "Capture", format: "webm", width: 1920, height: 1080, framesPerSecond: 30, quality: 1, includeAudio: true }],
			tracks: [
				{ ...trackBase("solo", "group", 0), type: "group", solo: true, collapsed: false },
				{
					...trackBase("property", "property", 1, "solo"),
					type: "property",
					targetType: "node",
					targetId: "hero",
					propertyPath: "position.x",
					keys: [
						{ id: "p0", type: "key", frame: 0, value: 0, interpolation: "linear" },
						{ id: "p1", type: "key", frame: 10, value: 10, interpolation: "linear" },
					],
				},
				{
					...trackBase("animation", "animation", 2, "solo"),
					type: "animation",
					clips: [{ ...clipBase("walk", "animation"), type: "animation", animationGroupId: "Walk", sourceStartFrame: 10, sourceEndFrame: 20, loopCount: 0 }],
					weightKeys: [
						{ id: "w0", type: "key", frame: 0, value: 0.5, interpolation: "linear" },
						{ id: "w1", type: "key", frame: 10, value: 0.5, interpolation: "linear" },
					],
				},
				{
					...trackBase("audio", "audio", 3, "solo"),
					type: "audio",
					clips: [{ ...clipBase("voice", "audio"), type: "audio", soundId: "Voice", volume: 0.5, loop: false }],
					volumeKeys: [
						{ id: "v0", type: "key", frame: 0, value: 0.5, interpolation: "linear" },
						{ id: "v1", type: "key", frame: 10, value: 0.5, interpolation: "linear" },
					],
				},
				{
					...trackBase("activation", "activation", 4, "solo"),
					type: "activation",
					clips: [{ ...clipBase("active", "activation"), type: "activation", nodeId: "hero", active: true }],
				},
				{
					...trackBase("camera", "camera", 5, "solo"),
					type: "camera",
					clips: [{ ...clipBase("shot", "camera"), type: "camera", cameraId: "Camera", blendMode: "crossFade" }],
				},
				{
					...trackBase("control", "control", 6, "solo"),
					type: "control",
					clips: [{ ...clipBase("nested", "control"), type: "control", targetType: "cinematic", targetId: "cinematics/child.cinematic", action: "play" }],
				},
				{ ...trackBase("recorder", "recorder", 7, "solo"), type: "recorder", clips: [{ ...clipBase("record", "recorder"), type: "recorder", profileId: "capture" }] },
				{
					...trackBase("video", "video", 8, "solo"),
					type: "video",
					clips: [{ ...clipBase("intro", "video"), type: "video", videoPlayerId: "intro-player", volume: 0.8, loop: true, muteAudio: false, timeScale: 2 }],
				},
				{
					...trackBase("suppressed", "property", 9),
					type: "property",
					targetType: "node",
					targetId: "other",
					propertyPath: "position.x",
					keys: [{ id: "other", type: "key", frame: 0, value: 99, interpolation: "step" }],
				},
			],
		});

		const evaluation = evaluateCinematicFrame(document, 5);
		expect(evaluation.properties).toEqual([{ trackId: "property", targetType: "node", targetId: "hero", propertyPath: "position.x", value: 5 }]);
		expect(evaluation.animations).toMatchObject([{ clipId: "walk", sourceFrame: 15, weight: 0.5, animationGroupId: "Walk" }]);
		expect(evaluation.audio).toMatchObject([{ clipId: "voice", sourceFrame: 5, volume: 0.25, soundId: "Voice" }]);
		expect(evaluation.activations).toHaveLength(1);
		expect(evaluation.cameras).toHaveLength(1);
		expect(evaluation.controls).toHaveLength(1);
		expect(evaluation.recorders).toHaveLength(1);
		expect(evaluation.videos).toMatchObject([{ clipId: "intro", videoPlayerId: "intro-player", sourceFrame: 10, playbackSpeed: 2, volume: 0.8, loop: true }]);
	});

	test("evaluates blends, reverse animation time, extrapolation, and document hold", () => {
		const base = {
			...clipBase("reverse", "animation", 10, 10),
			type: "animation",
			animationGroupId: "Reverse",
			sourceStartFrame: 0,
			sourceEndFrame: 10,
			loopCount: 1,
			timeScale: -2,
			blendInFrames: 2,
			blendOutFrames: 2,
			preExtrapolation: "hold",
			postExtrapolation: "loop",
		};
		const document = normalizeCinematicDocument({
			...createCinematicDocument("Timing", "timing"),
			durationMode: "fixed",
			durationFrames: 30,
			tracks: [{ ...trackBase("animation", "animation", 0), type: "animation", clips: [base], weightKeys: [] }],
		});
		expect(evaluateCinematicFrame(document, 11).animations[0]).toMatchObject({ phase: "inside", localFrame: 1, sourceFrame: 8, weight: 0.5 });
		expect(evaluateCinematicFrame(document, 22).animations[0]).toMatchObject({ phase: "after", localFrame: 2, sourceFrame: 6, weight: 1 });
		expect(evaluateCinematicFrame(document, 0).animations[0]).toMatchObject({ phase: "before", localFrame: 0, sourceFrame: 10, weight: 1 });

		const hold = normalizeCinematicDocument({
			...document,
			wrapMode: "hold",
			durationFrames: 20,
			tracks: [{ ...trackBase("animation", "animation", 0), type: "animation", clips: [{ ...base, postExtrapolation: "none" }], weightKeys: [] }],
		});
		expect(evaluateCinematicFrame(hold, 20).animations).toHaveLength(1);
	});

	test("traverses looped markers once and advances a bounded playback clock", () => {
		const document = normalizeCinematicDocument({
			...createCinematicDocument("Markers", "markers"),
			framesPerSecond: 10,
			outputFramesPerSecond: 10,
			durationMode: "fixed",
			durationFrames: 10,
			wrapMode: "loop",
			tracks: [
				{
					...trackBase("signals", "signal", 0),
					type: "signal",
					markers: [
						{ id: "origin", name: "Origin", type: "signal", frame: 0, emitOnce: false, retroactive: false, payload: null },
						{ id: "once", name: "Once", type: "signal", frame: 3, emitOnce: true, retroactive: false, payload: { value: 1 } },
						{ id: "retro", name: "Retro", type: "event", frame: 9, emitOnce: false, retroactive: true, payload: "late" },
					],
				},
			],
		});

		const looped = getCinematicMarkersBetween(document, 2, 4, { wrapCount: 1 });
		expect(looped.map((entry) => [entry.marker.id, entry.cycle])).toEqual([
			["once", 0],
			["retro", 0],
			["origin", 1],
		]);

		const clock = new CinematicPlaybackClock(document, { frame: 2 });
		clock.play();
		const advanced = clock.advance(1.2);
		expect(advanced).toMatchObject({ previousFrame: 2, frame: 4, wrapCount: 1, completed: false });
		expect(advanced.markers.map((entry) => entry.marker.id)).toEqual(["once", "retro", "origin"]);
		expect(clock.evaluate().frame).toBe(4);
		clock.document.tracks.length = 0;
		expect(clock.evaluate().frame).toBe(4);
		expect(clock.document.tracks).toHaveLength(1);
		expect(clock.seek(9, true).map((entry) => entry.marker.id)).toEqual(["retro"]);
		expect(() => clock.setSpeed(0)).toThrow("0.01..100");
	});
});

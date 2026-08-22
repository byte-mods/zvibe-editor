import { describe, expect, test } from "vitest";

import { createCinematicDocument, getCinematicContentEndFrame, getCinematicFingerprint, normalizeCinematicDocument } from "../../src/cinematic/model";

function clipBase(id: string, startFrame: number, durationFrames: number) {
	return {
		id,
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

describe("cinematic version-2 model", () => {
	test("migrates every legacy track payload without losing timing or event data", () => {
		const migrated = normalizeCinematicDocument({
			name: "Legacy Intro",
			framesPerSecond: 30,
			outputFramesPerSecond: 60,
			tracks: [
				{
					node: "camera",
					propertyPath: "position",
					keyFrameAnimations: [
						{ type: "key", frame: 0, value: [0, 0, 0] },
						{ type: "cut", key1: { frame: 30, value: [1, 0, 0] }, key2: { frame: 30, value: [2, 0, 0] } },
					],
				},
				{ animationGroup: "Walk", animationGroups: [{ type: "group", frame: 10, speed: 2, startFrame: 5, endFrame: 45, repeatCount: 1 }] },
				{ sound: "Voice", sounds: [{ type: "sound", frame: 5, startFrame: 10, endFrame: 40 }] },
				{ keyFrameEvents: [{ type: "event", frame: 25, data: { type: "event", eventName: "door-open", nested: { safe: true } } }] },
			],
		});

		expect(migrated).toMatchObject({
			version: 2,
			revision: 0,
			name: "Legacy Intro",
			framesPerSecond: 30,
			outputFramesPerSecond: 60,
			durationMode: "automatic",
			wrapMode: "once",
		});
		expect(migrated.tracks.map((track) => track.type)).toEqual(["property", "animation", "audio", "signal"]);
		expect(migrated.tracks[1]).toMatchObject({
			type: "animation",
			clips: [{ startFrame: 10, durationFrames: 40, clipInFrame: 0, timeScale: 2, sourceStartFrame: 5, sourceEndFrame: 45, loopCount: 1 }],
		});
		expect(migrated.tracks[2]).toMatchObject({ type: "audio", clips: [{ startFrame: 5, durationFrames: 30, clipInFrame: 10, soundId: "Voice" }] });
		expect(migrated.tracks[3]).toMatchObject({
			type: "signal",
			markers: [{ name: "door-open", frame: 25, payload: { type: "event", eventName: "door-open", nested: { safe: true } } }],
		});
		expect(migrated.durationFrames).toBe(50);
		expect(normalizeCinematicDocument({ name: "Legacy Intro", framesPerSecond: 30, outputFramesPerSecond: 60, tracks: [] }).id).toBe(
			normalizeCinematicDocument({ name: "Legacy Intro", framesPerSecond: 30, outputFramesPerSecond: 60, tracks: [] }).id
		);
		expect(normalizeCinematicDocument({ name: "Legacy Intro", tracks: [] }, { identitySeed: "assets/a.cinematic" }).id).not.toBe(
			normalizeCinematicDocument({ name: "Legacy Intro", tracks: [] }, { identitySeed: "assets/b.cinematic" }).id
		);
	});

	test("normalizes typed tracks, hierarchy, recorder profiles, and automatic duration", () => {
		const value = {
			...createCinematicDocument("Shot", "shot"),
			recorderProfiles: [{ id: "movie", name: "Movie", format: "webm", width: 1920, height: 1080, framesPerSecond: 30, quality: 0.8, includeAudio: true }],
			tracks: [
				{ id: "folder", name: "Shots", type: "group", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#112233", collapsed: false },
				{
					id: "camera",
					name: "Camera",
					type: "camera",
					order: 1,
					parentId: "folder",
					muted: false,
					solo: true,
					locked: false,
					color: "#334455",
					clips: [{ ...clipBase("shot-a", 10, 30), type: "camera", cameraId: "CameraA", blendMode: "crossFade" }],
				},
				{
					id: "capture",
					name: "Capture",
					type: "recorder",
					order: 2,
					parentId: null,
					muted: false,
					solo: false,
					locked: false,
					color: "#556677",
					clips: [{ ...clipBase("capture-a", 0, 50), type: "recorder", profileId: "movie" }],
				},
				{
					id: "video",
					name: "Video",
					type: "video",
					order: 3,
					parentId: null,
					muted: false,
					solo: false,
					locked: false,
					color: "#06B6D4",
					clips: [{ ...clipBase("video-a", 20, 40), type: "video", videoPlayerId: "intro-player", volume: 0.75, loop: false, muteAudio: true }],
				},
			],
		};
		const normalized = normalizeCinematicDocument(value);
		expect(normalized.durationFrames).toBe(60);
		expect(getCinematicContentEndFrame(normalized)).toBe(60);
		expect(normalized.tracks[3]).toMatchObject({ type: "video", clips: [{ videoPlayerId: "intro-player", volume: 0.75, muteAudio: true }] });
		expect(getCinematicFingerprint(normalized)).toMatch(/^[a-f0-9]{16}$/);
		expect(getCinematicFingerprint(normalized)).toBe(getCinematicFingerprint(structuredClone(normalized)));
	});

	test("rejects malformed, stale-prone, unbounded, and relationally invalid documents", () => {
		const base = createCinematicDocument("Invalid", "invalid");
		expect(() => normalizeCinematicDocument({ ...base, surprise: true })).toThrow("unsupported field");
		expect(() => normalizeCinematicDocument({ ...base, framesPerSecond: 0 })).toThrow("framesPerSecond");
		expect(() => normalizeCinematicDocument({ ...base, revision: -1 })).toThrow("revision");
		expect(() =>
			normalizeCinematicDocument({
				name: "Legacy",
				tracks: [{ node: "node", propertyPath: "metadata.__proto__.value", keyFrameAnimations: [{ type: "key", frame: 0, value: 1 }] }],
			})
		).toThrow("safe dotted identifier");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{
						id: "property",
						name: "Property",
						type: "property",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#000000",
						targetType: "node",
						targetId: null,
						propertyPath: "position",
						keys: [],
					},
				],
			})
		).toThrow("node bindings require targetId");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{
						id: "property",
						name: "Property",
						type: "property",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#000000",
						targetType: "node",
						targetId: "node",
						propertyPath: "position",
						keys: [{ id: "unsafe", type: "key", frame: 0, value: { arbitrary: true }, interpolation: "linear" }],
					},
				],
			})
		).toThrow("finite scalar");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{
						id: "property",
						name: "Property",
						type: "property",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#000000",
						targetType: "node",
						targetId: "node",
						propertyPath: "position",
						keys: [{ id: "wrong", type: "wat", frame: 0, value: 0, interpolation: "linear" }],
					},
				],
			})
		).toThrow("type must be key or cut");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{
						id: "property",
						name: "Property",
						type: "property",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#000000",
						targetType: "node",
						targetId: "node",
						propertyPath: "position",
						keys: [
							{ id: "scalar", type: "key", frame: 0, value: 0, interpolation: "linear" },
							{ id: "vector", type: "key", frame: 1, value: [0, 1, 2], interpolation: "linear" },
						],
					},
				],
			})
		).toThrow("same scalar or vector type");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{ id: "a", name: "A", type: "group", order: 0, parentId: "b", muted: false, solo: false, locked: false, color: "#000000", collapsed: false },
					{ id: "b", name: "B", type: "group", order: 1, parentId: "a", muted: false, solo: false, locked: false, color: "#000000", collapsed: false },
				],
			})
		).toThrow("cycle");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				durationMode: "fixed",
				durationFrames: 5,
				recorderProfiles: [{ id: "movie", name: "Movie", format: "webm", width: 1920, height: 1080, framesPerSecond: 30, quality: 0.8, includeAudio: false }],
				tracks: [
					{
						id: "recorder",
						name: "Recorder",
						type: "recorder",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#000000",
						clips: [{ ...clipBase("capture", 0, 10), type: "recorder", profileId: "movie" }],
					},
				],
			})
		).toThrow("ends before authored content");
		expect(() => normalizeCinematicDocument({ ...base, tracks: Array.from({ length: 257 }, () => ({})) })).toThrow("at most 256 tracks");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{
						id: "animation",
						name: "Animation",
						type: "animation",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#000000",
						clips: [],
						weightKeys: [{ id: "weight", type: "key", frame: 0, value: 2, interpolation: "linear" }],
					},
				],
			})
		).toThrow("within 0..1");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{
						id: "video",
						name: "Video",
						type: "video",
						order: 0,
						parentId: null,
						muted: false,
						solo: false,
						locked: false,
						color: "#06B6D4",
						clips: [{ ...clipBase("reverse", 0, 10), type: "video", timeScale: -1, videoPlayerId: "player", volume: 1, loop: false, muteAudio: false }],
					},
				],
			})
		).toThrow("does not support reverse playback");
		expect(() =>
			normalizeCinematicDocument({
				...base,
				tracks: [
					{ id: "duplicate", name: "A", type: "group", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#000000", collapsed: false },
					{ id: "duplicate", name: "B", type: "group", order: 1, parentId: null, muted: false, solo: false, locked: false, color: "#000000", collapsed: false },
				],
			})
		).toThrow("duplicated");
	});
});

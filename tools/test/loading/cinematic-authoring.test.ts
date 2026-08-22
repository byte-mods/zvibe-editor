import { describe, expect, test } from "vitest";

import {
	createCinematicClip,
	createCinematicDocument,
	createCinematicKey,
	createCinematicRecorderProfile,
	createCinematicTrack,
	deleteCinematicClip,
	deleteCinematicRecorderProfile,
	deleteCinematicTrack,
	moveCinematicTrack,
	setCinematicSettings,
	updateCinematicClip,
	updateCinematicKey,
	updateCinematicTrack,
} from "../../src";

function trackBase(id: string, type: string, parentId: string | null = null) {
	return { id, name: id, type, order: 0, parentId, muted: false, solo: false, locked: false, color: "#334455" };
}

function clipBase(id: string, type: string) {
	return {
		id,
		type,
		name: id,
		startFrame: 0,
		durationFrames: 10,
		clipInFrame: 0,
		timeScale: 1,
		enabled: true,
		blendInFrames: 0,
		blendOutFrames: 0,
		easeIn: "linear" as const,
		easeOut: "linear" as const,
		preExtrapolation: "none" as const,
		postExtrapolation: "none" as const,
	};
}

describe("cinematic exact-revision authoring", () => {
	test("supports granular track, key, clip, hierarchy, and recorder mutations", () => {
		let document = createCinematicDocument("Authoring", "authoring");
		document = setCinematicSettings(document, 0, { framesPerSecond: 30, outputFramesPerSecond: 60, wrapMode: "loop" });
		document = createCinematicTrack(document, 1, { ...trackBase("group", "group"), type: "group", collapsed: false });
		document = createCinematicTrack(document, 2, {
			...trackBase("property", "property", "group"),
			type: "property",
			targetType: "node",
			targetId: "hero",
			propertyPath: "position.x",
			keys: [],
		});
		document = updateCinematicTrack(document, 3, "group", { locked: true });
		expect(() => createCinematicKey(document, 4, "property", "property", { id: "blocked", type: "key", frame: 0, value: 0, interpolation: "linear" })).toThrow("locked");
		document = updateCinematicTrack(document, 4, "group", { locked: false });
		document = createCinematicKey(document, 5, "property", "property", { id: "key", type: "key", frame: 0, value: 0, interpolation: "linear" });
		document = updateCinematicKey(document, 6, "property", "property", "key", {
			id: "key",
			type: "key",
			frame: 5,
			value: 5,
			interpolation: "cubic",
			inTangent: 1,
			outTangent: 1,
		});

		document = createCinematicTrack(document, 7, { ...trackBase("animation", "animation"), type: "animation", clips: [], weightKeys: [] });
		document = createCinematicClip(document, 8, "animation", {
			...clipBase("walk", "animation"),
			type: "animation",
			animationGroupId: "Walk",
			sourceStartFrame: 0,
			sourceEndFrame: 10,
			loopCount: 0,
		});
		document = updateCinematicClip(document, 9, "animation", "walk", { startFrame: 10, blendInFrames: 2 });
		document = moveCinematicTrack(document, 10, "animation", 1, "group");
		document = createCinematicTrack(document, 11, { ...trackBase("video", "video"), type: "video", clips: [] });
		document = createCinematicClip(document, 12, "video", {
			...clipBase("intro", "video"),
			type: "video",
			videoPlayerId: "intro-player",
			volume: 0.8,
			loop: false,
			muteAudio: true,
		});

		document = createCinematicRecorderProfile(document, 13, {
			id: "capture",
			name: "Capture",
			format: "webm",
			width: 1920,
			height: 1080,
			framesPerSecond: 30,
			quality: 1,
			includeAudio: true,
		});
		document = createCinematicTrack(document, 14, { ...trackBase("recorder", "recorder"), type: "recorder", clips: [] });
		document = createCinematicClip(document, 15, "recorder", { ...clipBase("record", "recorder"), type: "recorder", profileId: "capture" });
		expect(() => deleteCinematicRecorderProfile(document, 16, "capture")).toThrow("still referenced");
		document = deleteCinematicClip(document, 16, "recorder", "record");
		document = deleteCinematicRecorderProfile(document, 17, "capture");

		expect(document).toMatchObject({ revision: 18, framesPerSecond: 30, outputFramesPerSecond: 60, wrapMode: "loop" });
		expect(document.tracks.map((track) => [track.id, track.order, track.parentId])).toEqual([
			["group", 0, null],
			["animation", 1, "group"],
			["property", 2, "group"],
			["video", 3, null],
			["recorder", 4, null],
		]);
		expect(document.tracks.find((track) => track.id === "property")).toMatchObject({ keys: [{ id: "key", frame: 5, value: 5, interpolation: "cubic" }] });
		expect(document.tracks.find((track) => track.id === "animation")).toMatchObject({ clips: [{ id: "walk", startFrame: 10, blendInFrames: 2 }] });
		expect(document.tracks.find((track) => track.id === "video")).toMatchObject({ clips: [{ id: "intro", videoPlayerId: "intro-player", muteAudio: true }] });
	});

	test("rejects stale, illegal, locked, and destructive hierarchy mutations atomically", () => {
		let document = createCinematicDocument("Safety", "safety");
		document = createCinematicTrack(document, 0, { ...trackBase("group", "group"), type: "group", collapsed: false });
		document = createCinematicTrack(document, 1, {
			...trackBase("property", "property", "group"),
			type: "property",
			targetType: "node",
			targetId: "hero",
			propertyPath: "position.x",
			keys: [],
		});
		const snapshot = structuredClone(document);
		expect(() => updateCinematicTrack(document, 1, "property", { name: "Stale" })).toThrow("revision is stale");
		expect(() => updateCinematicTrack(document, 2, "property", { type: "audio" })).toThrow("cannot change field");
		expect(() => moveCinematicTrack(document, 2, "group", 1, "property")).toThrow("group parent");
		expect(() => deleteCinematicTrack(document, 2, "group")).toThrow("descendant");
		expect(document).toEqual(snapshot);
		document = updateCinematicTrack(document, 2, "property", { locked: true });
		expect(() => deleteCinematicTrack(document, 3, "group", true)).toThrow("descendant track");
		document = updateCinematicTrack(document, 3, "property", { locked: false });
		document = updateCinematicTrack(document, 4, "group", { locked: true });
		expect(() =>
			createCinematicTrack(document, 5, {
				...trackBase("child", "property", "group"),
				type: "property",
				targetType: "node",
				targetId: "hero",
				propertyPath: "position.x",
				keys: [],
			})
		).toThrow("unlocked group parent");
		document = updateCinematicTrack(document, 5, "group", { locked: false });
		document = deleteCinematicTrack(document, 6, "group", true);
		expect(document.tracks).toEqual([]);
		expect(document.revision).toBe(7);
	});
});

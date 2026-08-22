import { describe, expect, test } from "vitest";

import { createCinematicDocument, getLegacyCinematicUnsupportedTracks, mergeLegacyCinematic, normalizeCinematicDocument, toLegacyCinematic } from "../../src";

function trackBase(id: string, type: string, order: number, parentId: string | null = null) {
	return { id, name: id, type, order, parentId, muted: false, solo: false, locked: false, color: "#334455" };
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
		easeIn: "linear",
		easeOut: "linear",
		preExtrapolation: "none",
		postExtrapolation: "none",
	};
}

function document() {
	return normalizeCinematicDocument({
		...createCinematicDocument("Compatibility", "compatibility"),
		durationMode: "fixed",
		durationFrames: 20,
		tracks: [
			{ ...trackBase("group", "group", 0), type: "group", collapsed: false },
			{
				...trackBase("property", "property", 1, "group"),
				type: "property",
				targetType: "node",
				targetId: "hero",
				propertyPath: "position.x",
				keys: [
					{ id: "key-a", type: "key", frame: 0, value: 0, interpolation: "linear" },
					{ id: "key-b", type: "key", frame: 10, value: 10, interpolation: "step" },
				],
			},
			{
				...trackBase("animation", "animation", 2),
				type: "animation",
				clips: [{ ...clipBase("walk", "animation"), type: "animation", animationGroupId: "Walk", sourceStartFrame: 0, sourceEndFrame: 10, loopCount: 0 }],
				weightKeys: [],
			},
			{
				...trackBase("audio", "audio", 3),
				type: "audio",
				clips: [{ ...clipBase("voice", "audio"), type: "audio", soundId: "Voice", timeScale: 2, volume: 0.75, loop: true, blendInFrames: 2 }],
				volumeKeys: [],
			},
			{
				...trackBase("signals", "signal", 4),
				type: "signal",
				markers: [{ id: "marker", name: "Door", type: "signal", frame: 5, emitOnce: true, retroactive: true, payload: { nested: [1, true] } }],
			},
			{
				...trackBase("camera", "camera", 5),
				type: "camera",
				clips: [{ ...clipBase("shot", "camera"), type: "camera", cameraId: "Camera", blendMode: "cut" }],
			},
		],
	});
}

describe("cinematic legacy compatibility", () => {
	test("round-trips editable lanes while preserving typed-only tracks and identity", () => {
		const current = document();
		const legacy = toLegacyCinematic(current);
		expect(legacy.tracks.map((track) => track._id)).toEqual(["property", "animation", "audio", "signals"]);
		expect(legacy.tracks[0].keyFrameAnimations?.[1]).toMatchObject({ id: "key-b", interpolation: 1 });
		expect(legacy.tracks[2].sounds?.[0]).toMatchObject({ id: "voice", speed: 2, volume: 0.75, loop: true, blendInFrames: 2, endFrame: 20 });
		expect(legacy.tracks[3].keyFrameEvents?.[0]).toMatchObject({
			id: "marker",
			name: "Door",
			markerType: "signal",
			emitOnce: true,
			retroactive: true,
			data: { nested: [1, true] },
		});
		expect(mergeLegacyCinematic(current, structuredClone(legacy)).tracks.find((track) => track.id === "audio")).toMatchObject({
			clips: [{ id: "voice", durationFrames: 10, timeScale: 2, volume: 0.75, loop: true, blendInFrames: 2 }],
		});

		legacy.name = "Edited";
		const editedKey = legacy.tracks[0].keyFrameAnimations![0];
		if (editedKey.type !== "key") {
			throw new Error("Expected a regular legacy key.");
		}
		editedKey.value = 4;
		legacy.tracks.splice(2, 1);
		const merged = mergeLegacyCinematic(current, legacy);

		expect(merged.name).toBe("Edited");
		expect(merged.tracks.map((track) => track.id)).toEqual(["group", "property", "animation", "signals", "camera"]);
		expect(merged.tracks.find((track) => track.id === "property")).toMatchObject({
			parentId: "group",
			keys: [
				{ id: "key-a", value: 4 },
				{ id: "key-b", interpolation: "step" },
			],
		});
		expect(merged.tracks.find((track) => track.id === "signals")).toMatchObject({
			markers: [{ id: "marker", name: "Door", type: "signal", emitOnce: true, retroactive: true, payload: { nested: [1, true] } }],
		});
		expect(merged.tracks.find((track) => track.id === "camera")).toMatchObject({
			...(current.tracks.find((track) => track.id === "camera") as object),
			order: 4,
		});
		expect(getLegacyCinematicUnsupportedTracks(merged).map((track) => track.type)).toEqual(["group", "camera"]);
	});

	test("refuses to flatten mixed-source lanes instead of silently changing them", () => {
		const current = document();
		const animation = current.tracks.find((track) => track.type === "animation")!;
		if (animation.type !== "animation") {
			throw new Error("Expected animation track.");
		}
		animation.clips.push({ ...animation.clips[0], id: "run", animationGroupId: "Run", startFrame: 10 });
		expect(() => toLegacyCinematic(normalizeCinematicDocument(current))).toThrow("multiple animation groups");
	});
});

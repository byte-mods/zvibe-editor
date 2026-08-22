import { describe, expect, test } from "vitest";

import { buildAsepriteSpriteAnimations } from "../../src/mcp/assets/aseprite-animation";

function result(): any {
	return {
		settings: { includeHiddenLayers: false, pixelsPerUnit: 100 },
		document: {
			width: 20,
			height: 10,
			pixelRatio: { width: 2, height: 1 },
			frameCount: 3,
			frameDurationsMs: [50, 125, 75],
			layers: [
				{ index: 0, name: "Root", type: "group", parentIndex: null, visible: true },
				{ index: 1, name: "Hero", type: "image", parentIndex: 0, visible: true },
				{ index: 2, name: "Hidden", type: "image", parentIndex: 0, visible: false },
			],
			celUserData: [
				{ frameIndex: 1, layerIndex: 1, text: "Footstep", color: [1, 2, 3, 255] },
				{ frameIndex: 1, layerIndex: 2, text: "Hidden event" },
			],
		},
		atlas: {
			frameTags: [
				{ name: "Run", from: 0, to: 2, direction: "pingpong", repeat: 2 },
				{ name: "Run", from: 0, to: 2, direction: "pingpong_reverse", repeat: 1 },
			],
			frames: [
				{ name: "composite/frame-0000", frameIndex: 0, layerIndex: null, empty: false, frame: { w: 8, h: 4 }, pivot: { x: 0.25, y: 0.75 } },
				{ name: "composite/frame-0001", frameIndex: 1, layerIndex: null, empty: false, frame: { w: 6, h: 3 }, pivot: { x: 0.5, y: 0.5 } },
				{ name: "layer/frame-0000", frameIndex: 0, layerIndex: 1, empty: false, frame: { w: 4, h: 2 }, pivot: { x: 0.5, y: 0.5 } },
				{ name: "layer/frame-0001", frameIndex: 1, layerIndex: 1, empty: true, frame: { w: 1, h: 1 }, pivot: { x: 0.5, y: 0.5 } },
			],
		},
	};
}

describe("Aseprite sprite animation projection", () => {
	test("expands both ping-pong directions with exact timing, events, pivots, and missing-frame visibility", () => {
		const animations = buildAsepriteSpriteAnimations(result(), null);
		expect(animations.map((animation) => animation.name)).toEqual(["Run", "Run (2)"]);
		expect(animations[0].frames?.map((frame) => frame.sourceFrame)).toEqual([0, 1, 2, 1]);
		expect(animations[1].frames?.map((frame) => frame.sourceFrame)).toEqual([2, 1, 0, 1]);
		expect(animations[0]).toMatchObject({ repeat: 2, loop: true, delay: 50 });
		expect(animations[0].frames?.[0]).toMatchObject({ durationMs: 50, visible: true, localTransform: { position: [4, 1, 0], width: 16, height: 4 } });
		expect(animations[0].frames?.[1].events).toEqual([{ text: "Footstep", color: [1, 2, 3, 255] }]);
		expect(animations[0].frames?.[2]).toMatchObject({ cellRef: null, cellIndex: null, durationMs: 75, visible: false });
	});

	test("keeps layer events scoped and marks empty or omitted layer frames invisible", () => {
		const frames = buildAsepriteSpriteAnimations(result(), 1)[0].frames!;
		expect(frames[0]).toMatchObject({ visible: true, localTransform: { position: [0, 0, 0.001], width: 8, height: 2 } });
		expect(frames[1]).toMatchObject({ visible: false, events: [{ text: "Footstep", color: [1, 2, 3, 255] }] });
		expect(frames[2]).toMatchObject({ cellRef: null, visible: false, localTransform: { width: 40, height: 10 } });
	});

	test("creates a default infinite sequence and rejects event fan-out beyond the runtime bound", () => {
		const value = result();
		value.atlas.frameTags = [];
		expect(buildAsepriteSpriteAnimations(value, null)[0]).toMatchObject({ name: "Default", repeat: 0, loop: true, frames: [{ sourceFrame: 0 }, { sourceFrame: 1 }, { sourceFrame: 2 }] });
		value.document.celUserData = Array.from({ length: 33 }, (_, index) => ({ frameIndex: 0, layerIndex: 1, text: `Event ${index}` }));
		expect(() => buildAsepriteSpriteAnimations(value, null)).toThrow(/at most 32/i);
	});
});

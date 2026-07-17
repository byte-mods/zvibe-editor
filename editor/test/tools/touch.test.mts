import { describe, expect, test } from "vitest";

import { toNormalizedTouchPosition } from "../../src/tools/input/touch";

describe("tools/input/touch", () => {
	test("normalizes preview pointer positions and clamps out-of-bounds input", () => {
		const bounds = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;
		expect(toNormalizedTouchPosition(bounds, 200, 75)).toEqual([0.5, 0.25]);
		expect(toNormalizedTouchPosition(bounds, -10, 200)).toEqual([0, 1]);
	});

	test("uses the center point when the preview surface has no usable size", () => {
		expect(toNormalizedTouchPosition({ left: 0, top: 0, width: 0, height: 10 } as DOMRect, 0, 0)).toEqual([0.5, 0.5]);
	});
});

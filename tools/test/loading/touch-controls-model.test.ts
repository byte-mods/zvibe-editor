import { describe, expect, test } from "vitest";

import { createDefaultTouchControlsConfiguration, normalizeTouchControlsConfiguration, validateTouchControlsConfiguration } from "../../src/loading/touch-controls-model";

describe("touch controls model", () => {
	test("normalizes a legacy button and stick into stable bounded authoring", () => {
		const configuration = normalizeTouchControlsConfiguration({
			enabled: true,
			controls: [
				{ id: "jump", name: "Jump", controlPath: "<touch>/jump", rect: { x: 0.8, y: 0.7, width: 0.15, height: 0.2 } },
				{ id: "move", name: "Move", type: "stick", controlPath: "<touch>/move", rect: { x: 0.05, y: 0.65, width: 0.25, height: 0.25 } },
			],
		});
		validateTouchControlsConfiguration(configuration);
		expect(configuration).toMatchObject({
			version: 1,
			revision: 1,
			enabled: true,
			controls: [
				{ id: "jump", type: "button", buttonValue: 1 },
				{ id: "move", type: "stick", stickAxis: "both", stickDeadzone: 0.125 },
			],
		});
	});

	test("keeps absent authoring disabled and non-mutating", () => {
		const defaults = createDefaultTouchControlsConfiguration();
		expect(normalizeTouchControlsConfiguration(undefined)).toEqual(defaults);
		expect(defaults).toMatchObject({ enabled: false, controls: [], visibleInEditor: true, respectSafeArea: true });
	});

	test("rejects duplicate paths, off-canvas rects, malformed colors, and oversized collections", () => {
		const base = normalizeTouchControlsConfiguration({
			enabled: true,
			controls: [{ id: "jump", name: "Jump", controlPath: "<touch>/jump", rect: { x: 0.8, y: 0.7, width: 0.15, height: 0.2 } }],
		});
		expect(() => validateTouchControlsConfiguration({ ...base, controls: [...base.controls, { ...base.controls[0], id: "fire", name: "Fire" }] })).toThrow("unique bounded");
		expect(() => validateTouchControlsConfiguration({ ...base, controls: [{ ...base.controls[0], rect: { x: 0.9, y: 0.9, width: 0.2, height: 0.2 } }] })).toThrow(
			"viewport bounds"
		);
		expect(() => validateTouchControlsConfiguration({ ...base, controls: [{ ...base.controls[0], backgroundColor: "red" }] })).toThrow("#RRGGBB");
		expect(() => validateTouchControlsConfiguration({ ...base, controls: Array.from({ length: 33 }, (_, index) => ({ ...base.controls[0], id: `id-${index}` })) })).toThrow(
			"at most 32"
		);
	});
});

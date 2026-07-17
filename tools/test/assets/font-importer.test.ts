import { describe, expect, test } from "vitest";

import { getFontImporterCodepoints, normalizeFontImporterSettings, validateFontImporterSource } from "../../src/assets/font-importer";

describe("font importer", () => {
	test("normalizes settings and derives stable unique Unicode codepoints", () => {
		const settings = normalizeFontImporterSettings({
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "AΩA😀",
			fontSize: 64,
			padding: 5,
			distanceRange: 8,
		});
		expect(settings).toEqual({
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "AΩA😀",
			fontSize: 64,
			padding: 5,
			distanceRange: 8,
		});
		expect(getFontImporterCodepoints(settings)).toEqual([65, 937, 128512]);
		expect(getFontImporterCodepoints({ ...settings, characterSet: "ascii" })).toHaveLength(95);
		expect(getFontImporterCodepoints({ ...settings, characterSet: "latin1" })).toHaveLength(224);
	});

	test("rejects unsupported sources, empty generated sets, WOFF2 atlas generation, and excessive sets", () => {
		const settings = normalizeFontImporterSettings({
			renderMode: "sdf",
			characterSet: "custom",
			customCharacters: "",
			fontSize: 48,
			padding: 4,
			distanceRange: 4,
		});
		expect(() => validateFontImporterSource("font.txt", settings)).toThrow("supports TTF");
		expect(() => validateFontImporterSource("font.ttf", settings)).toThrow("at least one character");
		expect(() => validateFontImporterSource("font.woff2", { ...settings, customCharacters: "A" })).toThrow("dynamic mode");
		expect(() =>
			validateFontImporterSource("font.otf", {
				...settings,
				customCharacters: Array.from({ length: 4097 }, (_, index) => String.fromCodePoint(index + 0x1000)).join(""),
			})
		).toThrow("4,096");
		expect(() => validateFontImporterSource("font.woff2", { ...settings, renderMode: "dynamic" })).not.toThrow();
	});
});

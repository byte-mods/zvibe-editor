import { describe, expect, test } from "vitest";

import { IFontAtlasCharacter, IFontAtlasManifest } from "../../src/assets/font-importer";
import { ILoadedImportedFont } from "../../src/loading/fonts";
import { createDefaultGUIAtlasTextAssignment, layoutGUIAtlasText, normalizeGUIAtlasTextAssignment, parseGUIAtlasRichText } from "../../src/loading/gui-atlas-text";

function glyph(character: string, xAdvance = 10): IFontAtlasCharacter {
	return {
		id: character.codePointAt(0)!,
		char: character,
		page: 0,
		x: 0,
		y: 0,
		width: character === " " ? 0 : 8,
		height: character === " " ? 0 : 10,
		xAdvance,
		xOffset: 0,
		yOffset: 0,
	};
}

function font(path: string, renderMode: ILoadedImportedFont["renderMode"], characters: string[]): ILoadedImportedFont {
	const manifest: IFontAtlasManifest = {
		version: 1,
		renderMode,
		family: path,
		fontSize: 10,
		padding: 2,
		distanceRange: 4,
		lineHeight: 10,
		base: 8,
		ascender: 8,
		descender: -2,
		pages: ["page.png"],
		characters: characters.map((character) => glyph(character, character === " " ? 5 : 10)),
		kernings: characters.includes("A") && characters.includes("V") ? [{ first: 65, second: 86, amount: -2 }] : [],
		missingCodepoints: [],
		dynamicFontPath: null,
		sourceFontPath: "source.ttf",
	};
	return {
		authoredPath: path,
		renderMode,
		family: `Family-${path}`,
		manifestUrl: `${path}.font.json`,
		manifest,
		pageUrls: [`${path}.page.png`],
		dynamicFontUrl: null,
		sourceFontUrl: `${path}.source.ttf`,
	};
}

describe("GUI atlas-rich-text layout", () => {
	test("normalizes bounded assignments and rejects unsafe font or surface input", () => {
		const assignment = { ...createDefaultGUIAtlasTextAssignment("title", ["assets/title.ttf"]), width: 1024, height: 256 };
		expect(normalizeGUIAtlasTextAssignment(assignment)).toMatchObject({ model: "unity-atlas-rich-text-v1", controlId: "title", color: "#ffffffff" });
		expect(() => normalizeGUIAtlasTextAssignment({ ...assignment, fontAssetPaths: ["../outside.ttf"] })).toThrow(/project-relative/);
		expect(() => normalizeGUIAtlasTextAssignment({ ...assignment, fontAssetPaths: ["assets/title.ttf", "assets/title.ttf"] })).toThrow(/unique/);
		expect(() => normalizeGUIAtlasTextAssignment({ ...assignment, width: 4096, height: 4096 })).toThrow(/8,388,608/);
	});

	test("parses the supported nested TMP-style rich-text subset without consuming invalid tags", () => {
		const assignment = {
			...createDefaultGUIAtlasTextAssignment("title", ["assets/title.ttf"]),
			fontSize: 20,
			text: "<b>A<i>B</i></b><color=#0f08>C</color><size=150%>D</size><br><bad>E</bad>",
		};
		const parsed = parseGUIAtlasRichText(assignment);
		expect(parsed.tagCount).toBe(9);
		expect(
			parsed.tokens
				.slice(0, 4)
				.map((token) => ({ character: token.character, bold: token.style.bold, italic: token.style.italic, color: token.style.color, size: token.style.fontSize }))
		).toEqual([
			{ character: "A", bold: true, italic: false, color: "#ffffffff", size: 20 },
			{ character: "B", bold: true, italic: true, color: "#ffffffff", size: 20 },
			{ character: "C", bold: false, italic: false, color: "#00ff0088", size: 20 },
			{ character: "D", bold: false, italic: false, color: "#ffffffff", size: 30 },
		]);
		expect(parsed.tokens.some((token) => token.newline)).toBe(true);
		expect(parsed.tokens.map((token) => token.character).join("")).toContain("<bad>E</bad>");
	});

	test("lays out kerning, ordered fallback, rich styles, and bounded runtime glyph population", () => {
		const primary = font("assets/primary.ttf", "bitmap", ["A", "V", " ", "?", "…"]);
		const fallback = font("assets/fallback.ttf", "msdf", ["Ω", "…"]);
		const assignment = {
			...createDefaultGUIAtlasTextAssignment("title", [primary.authoredPath, fallback.authoredPath]),
			text: "<b>AV</b> Ω 🙂",
			fontSize: 10,
			width: 200,
			height: 40,
		};
		const result = layoutGUIAtlasText(assignment, [primary, fallback]);
		expect(result.evidence).toMatchObject({ lineCount: 1, fallbackUseCount: 1, runtimeGlyphCount: 1, populatedCodepoints: [0x1f642], missingCodepoints: [0x1f642] });
		expect(result.evidence.renderModes).toMatchObject({ bitmap: 4, msdf: 1, dynamic: 1 });
		expect(result.placements.find((placement) => placement.character === "Ω")?.assetIndex).toBe(1);
		expect(result.placements.find((placement) => placement.character === "🙂")?.dynamic).toBe(true);
		expect(result.placements[1].x).toBeLessThan(10);
	});

	test("wraps and emits an ellipsis when bounded height hides later lines", () => {
		const primary = font("assets/primary.ttf", "sdf", ["A", " ", "…", "?"]);
		const assignment = {
			...createDefaultGUIAtlasTextAssignment("title", [primary.authoredPath]),
			text: "A A A A A A",
			fontSize: 10,
			width: 25,
			height: 12,
			wrapMode: "word" as const,
			overflowMode: "ellipsis" as const,
			populateMissingGlyphs: false,
		};
		const result = layoutGUIAtlasText(assignment, [primary]);
		expect(result.evidence).toMatchObject({ lineCount: 1, truncated: true });
		expect(result.evidence.clippedGlyphCount).toBeGreaterThan(0);
		expect(result.placements.at(-1)?.renderCharacter).toBe("…");
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, pathExists, readFile, readJSON, remove, stat, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import sharp from "sharp";
import { Scene } from "babylonjs";
import { normalizeFontImporterSettings } from "babylonjs-editor-tools";

import {
	applyFontImporterArtifact,
	getFontImporterArtifactStatus,
	parseOpenTypeBaseAlignmentMetrics,
	processFontImporterOutput,
	projectFontUnicodeVerticalOrientation,
	renderProjectFontText,
	renderProjectFontTextStyleRuns,
} from "../../src/mcp/assets/font-importer";
import { applyFontImporter, getFontImporterResult } from "../../src/mcp/assets/assets";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

const fixture = join(import.meta.dirname, "../../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");
const smallCapsFixture = join(import.meta.dirname, "../fixtures/fonts/Geist-Smcp-Test.ttf.base64");
const proportionalMetricsFixture = join(import.meta.dirname, "../fixtures/fonts/Geist-Palt-Test.ttf.base64");
const kanaFixture = join(import.meta.dirname, "../fixtures/fonts/Hiragino-Hkna-Test.otf.base64");
const rubyFixture = join(import.meta.dirname, "../fixtures/fonts/Hiragino-Ruby-Test.otf.base64");
const japaneseAlternatesFixture = join(import.meta.dirname, "../fixtures/fonts/Hiragino-Japanese-Alternates-Test.otf.base64");
const localizedFormsFixture = join(import.meta.dirname, "../fixtures/fonts/Geist-Locl-Test.ttf.base64");
const engineData2Fixture = join(import.meta.dirname, "../fixtures/fonts/Geist-EngineData2-Test.ttf.base64");
const characterOpenTypeFixture = join(import.meta.dirname, "../fixtures/fonts/Zvibe-Character-OpenType-Test.ttf.base64");
const figureStyleFixture = join(import.meta.dirname, "../fixtures/fonts/Zvibe-Figure-Style-Test.ttf.base64");
const connectionFormsFixture = join(import.meta.dirname, "../fixtures/fonts/Zvibe-Connection-Forms-Test.ttf.base64");
const contextualLigaturesFixture = join(import.meta.dirname, "../fixtures/fonts/Zvibe-Contextual-Ligatures-Test.ttf.base64");
const hindiNumbersFixture = join(import.meta.dirname, "../fixtures/fonts/Zvibe-Hindi-Numbers-Test.ttf.base64");

function openTypeBaseFixture(orientation: "horizontal" | "vertical" = "horizontal"): Uint8Array {
	const bytes = Buffer.alloc(120);
	bytes.writeUInt16BE(1, 0);
	bytes.writeUInt16BE(0, 2);
	bytes.writeUInt16BE(orientation === "horizontal" ? 8 : 0, 4);
	bytes.writeUInt16BE(orientation === "vertical" ? 8 : 0, 6);
	bytes.writeUInt16BE(4, 8);
	bytes.writeUInt16BE(18, 10);
	bytes.writeUInt16BE(3, 12);
	bytes.write("icfb", 14, "ascii");
	bytes.write("icft", 18, "ascii");
	bytes.write("romn", 22, "ascii");
	bytes.writeUInt16BE(2, 26);
	bytes.write("DFLT", 28, "ascii");
	bytes.writeUInt16BE(14, 32);
	bytes.write("hani", 34, "ascii");
	bytes.writeUInt16BE(42, 38);
	for (const [baseScript, values] of [
		[40, [-70, 830, 0]],
		[68, [-80, 840, 10]],
	] as const) {
		bytes.writeUInt16BE(6, baseScript);
		bytes.writeUInt16BE(0, baseScript + 2);
		bytes.writeUInt16BE(0, baseScript + 4);
		const baseValues = baseScript + 6;
		bytes.writeUInt16BE(2, baseValues);
		bytes.writeUInt16BE(3, baseValues + 2);
		bytes.writeUInt16BE(10, baseValues + 4);
		bytes.writeUInt16BE(14, baseValues + 6);
		bytes.writeUInt16BE(18, baseValues + 8);
		values.forEach((value, index) => {
			bytes.writeUInt16BE(1, baseValues + 10 + index * 4);
			bytes.writeInt16BE(value, baseValues + 12 + index * 4);
		});
	}
	return bytes.subarray(0, 96);
}

describe("executed font importer", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let source: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-font-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		source = join(directory, "assets", "game.ttf");
		await copyFile(fixture, source);
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("generates dynamic, bitmap, SDF, and genuine multi-channel MSDF artifacts", async () => {
		const baseSettings = normalizeFontImporterSettings({
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "AVgΩ",
			fontSize: 48,
			padding: 4,
			distanceRange: 6,
		});
		const dynamic = await processFontImporterOutput(source, join(directory, "dynamic", "game.ttf"), { ...baseSettings, renderMode: "dynamic" });
		expect(dynamic).toMatchObject({ renderMode: "dynamic", glyphCount: 0, pages: [], dynamicFontPath: expect.stringMatching(/game\.ttf$/) });
		expect((await stat(dynamic.dynamicFontPath!)).size).toBe((await stat(source)).size);

		const bitmap = await processFontImporterOutput(source, join(directory, "bitmap", "game.ttf"), { ...baseSettings, renderMode: "bitmap" });
		const sdf = await processFontImporterOutput(source, join(directory, "sdf", "game.ttf"), { ...baseSettings, renderMode: "sdf" });
		const msdf = await processFontImporterOutput(source, join(directory, "msdf", "game.ttf"), baseSettings);
		for (const result of [bitmap, sdf, msdf]) {
			expect(result.glyphCount).toBeGreaterThanOrEqual(3);
			expect(result.pages).toHaveLength(1);
			expect(await pathExists(result.manifestPath)).toBe(true);
			expect(await readJSON(result.manifestPath)).toMatchObject({
				version: 1,
				renderMode: result.renderMode,
				fontSize: 48,
				padding: 4,
				distanceRange: 6,
				pages: ["game.font-0.png"],
				characters: expect.arrayContaining([expect.objectContaining({ id: 65, char: "A", page: 0 })]),
			});
		}

		const bitmapPixels = await sharp(bitmap.pages[0].path).ensureAlpha().raw().toBuffer();
		for (let offset = 0; offset < bitmapPixels.length; offset += 4) {
			expect(bitmapPixels[offset]).toBe(255);
			expect(bitmapPixels[offset + 1]).toBe(255);
			expect(bitmapPixels[offset + 2]).toBe(255);
		}
		const sdfPixels = await sharp(sdf.pages[0].path).ensureAlpha().raw().toBuffer();
		for (let offset = 0; offset < sdfPixels.length; offset += 4) {
			expect(sdfPixels[offset]).toBe(sdfPixels[offset + 1]);
			expect(sdfPixels[offset + 1]).toBe(sdfPixels[offset + 2]);
		}
		const msdfPixels = await sharp(msdf.pages[0].path).ensureAlpha().raw().toBuffer();
		expect(
			Array.from({ length: msdfPixels.length / 4 }, (_, index) => index * 4).some(
				(offset) => msdfPixels[offset] !== msdfPixels[offset + 1] || msdfPixels[offset + 1] !== msdfPixels[offset + 2]
			)
		).toBe(true);
	});

	test("leases, applies, invalidates, and exposes font artifacts through MCP", async () => {
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = {
			...metadata.importer.settings,
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "Babylon 361",
			fontSize: 40,
			distanceRange: 5,
		};
		await writeAssetMetadata(source, metadata);

		const planned = await getFontImporterArtifactStatus(source);
		expect(planned).toMatchObject({ current: false, exists: false, result: null });
		const applied = await applyFontImporterArtifact(source, planned.fingerprint);
		expect(applied).toMatchObject({
			current: true,
			result: {
				renderMode: "msdf",
				glyphCount: expect.any(Number),
				sourceFontPath: expect.stringContaining("game.ttf"),
				pages: [expect.objectContaining({ width: expect.any(Number) })],
			},
		});
		expect(await pathExists(applied.result!.manifestPath)).toBe(true);
		expect(await readFile(applied.result!.sourceFontPath!)).toEqual(await readFile(source));

		metadata.importer.settings.fontSize = 44;
		await writeAssetMetadata(source, metadata);
		expect(await getFontImporterArtifactStatus(source)).toMatchObject({ current: false, exists: true });
		await expect(applyFontImporterArtifact(source, planned.fingerprint)).rejects.toThrow("plan changed");

		const scene = {} as Scene;
		const mcpPlan = await getFontImporterResult(scene, { path: "assets/game.ttf" });
		expect(mcpPlan).toMatchObject({ current: false, path: "assets/game.ttf", artifactDirectory: expect.stringContaining(".bjseditor/imported-assets/") });
		await expect(applyFontImporter(scene, { path: "assets/game.ttf", expectedFingerprint: mcpPlan.fingerprint, confirm: false }, {} as never)).rejects.toThrow("confirm=true");
		const refresh = vi.fn();
		const mcpResult = await applyFontImporter(scene, { path: "assets/game.ttf", expectedFingerprint: mcpPlan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh } } },
		} as never);
		expect(mcpResult).toMatchObject({
			applied: true,
			current: true,
			result: { sourcePath: "assets/game.ttf", outputDirectory: expect.stringContaining(".bjseditor/imported-assets/"), renderMode: "msdf" },
		});
		expect(JSON.stringify(mcpResult)).not.toContain(directory);
		expect(refresh).toHaveBeenCalledOnce();
		expect(await readFile(join(directory, mcpResult.manifestPath), "utf-8")).toContain(mcpResult.fingerprint);
	});

	test("rasterizes deterministic multi-style text with exact colors and authored faux styles", async () => {
		const fontBytes = await readFile(source);
		const options = {
			runs: [
				{
					text: "RED",
					fontPath: source,
					fontBytes,
					fontSize: 20,
					tracking: 0,
					color: [240, 30, 20, 255] as [number, number, number, number],
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: "Geist Regular",
					fauxBold: false,
					fauxItalic: false,
				},
				{
					text: "blue",
					fontPath: source,
					fontBytes,
					fontSize: 30,
					tracking: 80,
					color: [20, 80, 240, 220] as [number, number, number, number],
					sourceStyleRunIndex: 1,
					fontIndex: 0,
					fontName: "Geist Regular",
					fauxBold: true,
					fauxItalic: true,
				},
			],
			width: 160,
			height: 64,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 1,
		};
		const first = await renderProjectFontTextStyleRuns(options);
		const second = await renderProjectFontTextStyleRuns(options);
		expect(first).toMatchObject({
			executionModel: "bounded-project-font-text-style-runs-v1",
			glyphCount: 7,
			uniqueGlyphCount: 7,
			styleRuns: [
				{ sourceStyleRunIndex: 0, length: 3, glyphCount: 3, fauxBold: false, fauxItalic: false, fauxBoldPixels: 0, fauxItalicShear: 0 },
				{
					sourceStyleRunIndex: 1,
					length: 4,
					glyphCount: 4,
					fauxBold: true,
					fauxItalic: true,
					fauxBoldPixels: 1,
					fauxItalicShear: expect.closeTo(Math.tan((12 * Math.PI) / 180), 12),
				},
			],
		});
		expect(first.pixels).toEqual(second.pixels);
		const colors = Array.from({ length: first.pixels.length / 4 }, (_, index) => [...first.pixels.subarray(index * 4, index * 4 + 4)]).filter((color) => color[3] > 0);
		expect(colors.some((color) => color[0] === 240 && color[1] === 30 && color[2] === 20)).toBe(true);
		expect(colors.some((color) => color[0] === 20 && color[1] === 80 && color[2] === 240 && color[3] <= 220)).toBe(true);
	});

	test("executes authored character scale, baseline shift, underline, and strikethrough in legacy and shaped style runs", async () => {
		const fontBytes = await readFile(source);
		const run = {
			text: "STYLE",
			fontPath: source,
			fontBytes,
			fontSize: 32,
			tracking: 20,
			color: [230, 70, 40, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
			horizontalScale: 140,
			verticalScale: 75,
			baselineShift: 6,
			underline: true,
			strikethrough: true,
		};
		const base = { runs: [run], width: 240, height: 90, lineHeight: null, justification: "left" as const, offsetX: 4, offsetY: 8 };
		const legacy = await renderProjectFontTextStyleRuns(base);
		const shaped = await renderProjectFontTextStyleRuns({ ...base, shaping: { direction: "ltr" as const } });
		const unstyled = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...run, horizontalScale: 100, verticalScale: 100, baselineShift: 0, underline: false, strikethrough: false }],
		});
		for (const result of [legacy, shaped]) {
			expect(result.styleRuns[0]).toMatchObject({
				horizontalScale: 140,
				verticalScale: 75,
				baselineShift: 6,
				underline: true,
				strikethrough: true,
				decorationThickness: 1,
				characterStyleExecutionModel: "bounded-authored-character-style-v1",
			});
			expect(result.inkBounds).not.toBeNull();
			expect(Array.from(result.pixels).some((value, index) => index % 4 === 3 && value === 255)).toBe(true);
		}
		expect(legacy.executionModel).toBe("bounded-project-font-text-style-runs-v1");
		expect(shaped.executionModel).toBe("bounded-project-font-harfbuzz-style-runs-v1");
		expect(legacy.pixels).not.toEqual(unstyled.pixels);
	});

	test("executes authored paragraph-run justification, indents, spacing, and exact evidence in legacy and shaped paths", async () => {
		const fontBytes = await readFile(source);
		const options = {
			runs: [
				{
					text: "A A\nBB",
					fontPath: source,
					fontBytes,
					fontSize: 28,
					tracking: 0,
					color: [220, 90, 30, 255] as [number, number, number, number],
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: "Geist Regular",
					fauxBold: false,
					fauxItalic: false,
				},
			],
			paragraphRuns: [
				{
					sourceParagraphRunIndex: 0,
					start: 0,
					length: 4,
					justification: "justify-all" as const,
					firstLineIndent: 2,
					startIndent: 5,
					endIndent: 7,
					spaceBefore: 3,
					spaceAfter: 4,
					autoHyphenate: true,
					hyphenatedWordSize: 5,
					preHyphen: 2,
					postHyphen: 2,
					consecutiveHyphens: 2,
					hyphenationZone: 36,
					autoLeading: 1.2,
					everyLineComposer: true,
				},
				{
					sourceParagraphRunIndex: 1,
					start: 4,
					length: 2,
					justification: "right" as const,
					firstLineIndent: 1,
					startIndent: 6,
					endIndent: 8,
					spaceBefore: 5,
					spaceAfter: 2,
					autoHyphenate: false,
					hyphenatedWordSize: 5,
					preHyphen: 2,
					postHyphen: 2,
					consecutiveHyphens: 2,
					hyphenationZone: 36,
					autoLeading: null,
					everyLineComposer: false,
				},
			],
			width: 200,
			height: 130,
			lineHeight: 40,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 4,
		};
		const legacy = await renderProjectFontTextStyleRuns(options);
		const shaped = await renderProjectFontTextStyleRuns({ ...options, shaping: { direction: "ltr" as const } });
		for (const result of [legacy, shaped]) {
			expect(result.paragraphRuns).toEqual([
				{
					...options.paragraphRuns[0],
					lineIndices: [0],
					lineCount: 1,
					appliedLineHeight: 40,
					lineHeights: [40],
					lineHeightSources: ["request"],
					lineHeightSource: "request",
					lineBreakModel: "authored-paragraph-breaks-v1",
					hyphenatedLineCount: 0,
					insertedHyphenCount: 0,
					hyphenationLanguages: [],
					hyphenationExecutionModel: "disabled",
					composerExecutionModel: "bounded-single-line-composer-v1",
					executionModel: "bounded-authored-paragraph-run-layout-v1",
				},
				{
					...options.paragraphRuns[1],
					lineIndices: [1],
					lineCount: 1,
					appliedLineHeight: 40,
					lineHeights: [40],
					lineHeightSources: ["request"],
					lineHeightSource: "request",
					lineBreakModel: "authored-paragraph-breaks-v1",
					hyphenatedLineCount: 0,
					insertedHyphenCount: 0,
					hyphenationLanguages: [],
					hyphenationExecutionModel: "disabled",
					composerExecutionModel: "bounded-single-line-composer-v1",
					executionModel: "bounded-authored-paragraph-run-layout-v1",
				},
			]);
			expect(result.inkBounds).not.toBeNull();
			expect(result.inkBounds!.top).toBeGreaterThanOrEqual(7);
			// Glyph ink may overhang the authored advance box by a bounded antialias pixel.
			expect(result.inkBounds!.right).toBeLessThanOrEqual(194);
		}
		expect(legacy.executionModel).toBe("bounded-project-font-text-style-runs-v1");
		expect(shaped.executionModel).toBe("bounded-project-font-harfbuzz-style-runs-v1");
	});

	test("wraps authored box text at bounded whitespace opportunities with exact layout evidence", async () => {
		const fontBytes = await readFile(source);
		const text = "ONE TWO THREE FOUR";
		const options = {
			runs: [
				{
					text,
					fontPath: source,
					fontBytes,
					fontSize: 24,
					tracking: 0,
					color: [230, 120, 40, 255],
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: "Geist Regular",
					fauxBold: false,
					fauxItalic: false,
				},
			],
			paragraphRuns: [
				{
					sourceParagraphRunIndex: 0,
					start: 0,
					length: text.length,
					justification: "justify-left",
					firstLineIndent: 3,
					startIndent: 4,
					endIndent: 5,
					spaceBefore: 2,
					spaceAfter: 3,
					autoHyphenate: false,
					hyphenatedWordSize: 5,
					preHyphen: 2,
					postHyphen: 2,
					consecutiveHyphens: 2,
					hyphenationZone: 36,
					autoLeading: 1.2,
					everyLineComposer: false,
				},
			],
			boxLayout: { left: 6, top: 7, right: 106, bottom: 135 },
			width: 140,
			height: 150,
			lineHeight: null,
			justification: "left",
			offsetX: 0,
			offsetY: 0,
		};
		const result = await renderProjectFontTextStyleRuns(options);
		expect(result.boxLayout).toMatchObject({
			left: 6,
			top: 7,
			right: 106,
			bottom: 135,
			authoredLineCount: 1,
			composedLineCount: 4,
			softBreakCount: 3,
			hyphenatedLineCount: 0,
			insertedHyphenCount: 0,
			hyphenationLanguages: [],
			overflowLineCount: 0,
			wrapModel: "bounded-whitespace-cluster-wrap-v1",
			composerModel: "bounded-single-line-composer-v1",
			executionModel: "bounded-authored-box-text-layout-v1",
		});
		expect(result.paragraphRuns[0]).toMatchObject({
			lineIndices: [0, 1, 2, 3],
			lineCount: 4,
			lineBreakModel: "bounded-authored-box-wrap-v1",
		});
		expect(result.lineCount).toBe(4);
		expect(result.inkBounds).not.toBeNull();
		expect(result.inkBounds!.left).toBeGreaterThanOrEqual(6);
		expect(result.inkBounds!.right).toBeLessThanOrEqual(107);
		for (const shaping of [{ direction: "ltr" as const }, { direction: "ltr" as const, bidirectional: true }]) {
			const shaped = await renderProjectFontTextStyleRuns({ ...options, shaping });
			expect(shaped.boxLayout).toMatchObject({ authoredLineCount: 1, softBreakCount: 3, overflowLineCount: 0 });
			expect(shaped.paragraphRuns[0]).toMatchObject({ lineCount: 4, lineBreakModel: "bounded-authored-box-wrap-v1" });
			expect(shaped.lineCount).toBe(4);
			expect(shaped.inkBounds).not.toBeNull();
		}
		const vertical = await renderProjectFontTextStyleRuns({
			...options,
			orientation: "vertical",
			boxLayout: { left: 5, top: 6, right: 135, bottom: 136 },
			width: 150,
			height: 150,
		});
		expect(vertical.boxLayout).toMatchObject({ authoredLineCount: 1, softBreakCount: 3, overflowLineCount: 0 });
		expect(vertical.paragraphRuns[0]).toMatchObject({ lineCount: 4, lineBreakModel: "bounded-authored-box-wrap-v1" });
		expect(vertical.lineCount).toBe(4);
		expect(vertical.inkBounds).not.toBeNull();
		await expect(renderProjectFontTextStyleRuns({ ...options, boxLayout: { left: 10, top: 0, right: 10, bottom: 40 } })).rejects.toThrow("positive area");
	});

	test("executes authored dictionary hyphenation and bounded every-line composition in legacy and shaped box text", async () => {
		const fontBytes = await readFile(source);
		const text = "characteristically extraordinary localization";
		const paragraph = {
			sourceParagraphRunIndex: 0,
			start: 0,
			length: text.length,
			justification: "left" as const,
			firstLineIndent: 0,
			startIndent: 0,
			endIndent: 0,
			spaceBefore: 0,
			spaceAfter: 0,
			autoHyphenate: true,
			hyphenatedWordSize: 5,
			preHyphen: 2,
			postHyphen: 2,
			consecutiveHyphens: 3,
			hyphenationZone: 0,
			autoLeading: 1.2,
			everyLineComposer: true,
		};
		const options = {
			runs: [
				{
					text,
					fontPath: source,
					fontBytes,
					fontSize: 24,
					tracking: 0,
					color: [230, 120, 40, 255] as [number, number, number, number],
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: "Geist Regular",
					language: 1,
					fauxBold: false,
					fauxItalic: false,
				},
			],
			paragraphRuns: [paragraph],
			boxLayout: { left: 4, top: 4, right: 154, bottom: 244 },
			width: 170,
			height: 250,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 0,
			offsetY: 0,
		};
		for (const shaping of [undefined, { direction: "ltr" as const }, { direction: "ltr" as const, bidirectional: true }]) {
			const result = await renderProjectFontTextStyleRuns({ ...options, shaping });
			expect(result.boxLayout).toMatchObject({
				wrapModel: "bounded-dictionary-hyphenation-wrap-v1",
				composerModel: "bounded-every-line-composer-v1",
				hyphenationLanguages: ["en-US"],
				overflowLineCount: 0,
			});
			expect(result.boxLayout!.insertedHyphenCount).toBeGreaterThan(0);
			expect(result.boxLayout!.lines.filter((line) => line.insertedHyphen).length).toBe(result.boxLayout!.insertedHyphenCount);
			expect(result.paragraphRuns[0]).toMatchObject({
				lineBreakModel: "bounded-authored-box-hyphenation-v1",
				hyphenationExecutionModel: "bounded-liang-pattern-hyphenation-v1",
				composerExecutionModel: "bounded-every-line-composer-v1",
				hyphenationLanguages: ["en-US"],
			});
		}
		const everyLine = await renderProjectFontTextStyleRuns(options);
		const singleLine = await renderProjectFontTextStyleRuns({ ...options, paragraphRuns: [{ ...paragraph, everyLineComposer: false }] });
		const ragScore = (result: Awaited<ReturnType<typeof renderProjectFontTextStyleRuns>>): number =>
			result.boxLayout!.lines.slice(0, -1).reduce((score, line) => score + Math.pow(Math.max(0, line.available - line.advance), 2), 0);
		expect(ragScore(everyLine)).toBeLessThanOrEqual(ragScore(singleLine));
		const vertical = await renderProjectFontTextStyleRuns({
			...options,
			orientation: "vertical",
			boxLayout: { left: 4, top: 4, right: 164, bottom: 154 },
			width: 170,
			height: 170,
		});
		expect(vertical.boxLayout).toMatchObject({ wrapModel: "bounded-dictionary-hyphenation-wrap-v1", composerModel: "bounded-every-line-composer-v1" });
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [{ ...options.runs[0], language: 999 }] })).rejects.toThrow("language index 999");
		await expect(renderProjectFontTextStyleRuns({ ...options, paragraphRuns: [{ ...paragraph, hyphenatedWordSize: 5.5 }] })).rejects.toThrow(
			"invalid auto-leading, hyphenation, or composer evidence"
		);
	});

	test("executes authored no-break style spans across legacy, HarfBuzz, BiDi, and vertical box composition", async () => {
		const fontBytes = await readFile(source);
		const text = "ONE TWO THREE";
		const run = {
			fontPath: source,
			fontBytes,
			fontSize: 24,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		};
		const options = {
			runs: [
				{ ...run, text: "ONE TWO", sourceStyleRunIndex: 0, noBreak: true },
				{ ...run, text: " THREE", sourceStyleRunIndex: 1, noBreak: false },
			],
			paragraphRuns: [
				{
					sourceParagraphRunIndex: 0,
					start: 0,
					length: text.length,
					justification: "left" as const,
					firstLineIndent: 0,
					startIndent: 0,
					endIndent: 0,
					spaceBefore: 0,
					spaceAfter: 0,
					autoHyphenate: false,
					hyphenatedWordSize: 5,
					preHyphen: 2,
					postHyphen: 2,
					consecutiveHyphens: 2,
					hyphenationZone: 36,
					autoLeading: 1.2,
					everyLineComposer: false,
				},
			],
			boxLayout: { left: 4, top: 4, right: 84, bottom: 164 },
			width: 180,
			height: 180,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 0,
			offsetY: 0,
		};
		for (const shaping of [undefined, { direction: "ltr" as const }, { direction: "ltr" as const, bidirectional: true }]) {
			const result = await renderProjectFontTextStyleRuns({ ...options, shaping });
			expect(result.styleRuns).toEqual([
				expect.objectContaining({ noBreak: true, noBreakExecutionModel: "bounded-authored-no-break-v1" }),
				expect.objectContaining({ noBreak: false, noBreakExecutionModel: "disabled" }),
			]);
			expect(result.boxLayout).toMatchObject({
				noBreakRunCount: 1,
				noBreakExecutionModel: "bounded-authored-no-break-v1",
				composedLineCount: 2,
			});
			expect(result.boxLayout!.noBreakPreventedBreakCount).toBeGreaterThan(0);
			expect(result.boxLayout!.lines[0]).toMatchObject({ logicalStart: 0, logicalEnd: 7, overflow: true });
		}
		const withoutNoBreak = await renderProjectFontTextStyleRuns({ ...options, runs: options.runs.map((candidate) => ({ ...candidate, noBreak: false })) });
		expect(withoutNoBreak.boxLayout).toMatchObject({ noBreakRunCount: 0, noBreakPreventedBreakCount: 0, noBreakExecutionModel: "disabled", composedLineCount: 3 });
		const vertical = await renderProjectFontTextStyleRuns({
			...options,
			orientation: "vertical",
			boxLayout: { left: 4, top: 4, right: 164, bottom: 84 },
		});
		expect(vertical.boxLayout).toMatchObject({ noBreakRunCount: 1, noBreakExecutionModel: "bounded-authored-no-break-v1", composedLineCount: 2 });
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [{ ...options.runs[0], noBreak: "yes" as never }, options.runs[1]] })).rejects.toThrow(
			"noBreak must be Boolean"
		);
	});

	test("executes authored auto-kerning and standard/discretionary ligature switches with exact per-run feature boundaries", async () => {
		const fontBytes = await readFile(source);
		const run = {
			text: "fi",
			fontPath: source,
			fontBytes,
			fontSize: 48,
			tracking: 0,
			autoKerning: true,
			ligatures: true,
			discretionaryLigatures: false,
			color: [240, 120, 20, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		};
		const base = {
			runs: [run],
			width: 180,
			height: 100,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
		};
		const enabled = await renderProjectFontTextStyleRuns(base);
		expect(enabled).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-style-runs-v1",
			shaping: { engine: "harfbuzz" },
			styleRuns: [
				{
					autoKerning: true,
					ligatures: true,
					discretionaryLigatures: false,
					effectiveOpenTypeFeatures: [
						{ tag: "kern", value: 1 },
						{ tag: "liga", value: 1 },
						{ tag: "dlig", value: 0 },
					],
					openTypeFeatureExecutionModel: "bounded-authored-opentype-features-v1",
					glyphCount: 1,
				},
			],
		});
		const disabledLigature = await renderProjectFontTextStyleRuns({ ...base, runs: [{ ...run, ligatures: false }] });
		expect(disabledLigature.styleRuns[0]).toMatchObject({ ligatures: false, glyphCount: 2 });
		expect(disabledLigature.pixels).not.toEqual(enabled.pixels);
		const authoredOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...run, ligatures: false }],
			shaping: { direction: "ltr", features: [{ tag: "liga", value: 1 }] },
		});
		expect(authoredOverride.styleRuns[0]).toMatchObject({ effectiveOpenTypeFeatures: expect.arrayContaining([{ tag: "liga", value: 0 }]), glyphCount: 2 });

		const joined = await renderProjectFontTextStyleRuns({
			...base,
			runs: [
				{ ...run, text: "f", sourceStyleRunIndex: 0 },
				{ ...run, text: "i", sourceStyleRunIndex: 1, color: [20, 100, 240, 255] as [number, number, number, number] },
			],
			shaping: { direction: "ltr", joinAcrossStyleRuns: true },
		});
		expect(joined.shapedGlyphs).toHaveLength(1);
		const incompatible = await renderProjectFontTextStyleRuns({
			...base,
			runs: [
				{ ...run, text: "f", sourceStyleRunIndex: 0 },
				{ ...run, text: "i", sourceStyleRunIndex: 1, ligatures: false },
			],
			shaping: { direction: "ltr", joinAcrossStyleRuns: true },
		});
		expect(incompatible.shapedGlyphs).toHaveLength(2);
		const bidiIncompatible = await renderProjectFontTextStyleRuns({
			...base,
			runs: [
				{ ...run, text: "f", sourceStyleRunIndex: 0 },
				{ ...run, text: "i", sourceStyleRunIndex: 1, ligatures: false },
			],
			shaping: { direction: "ltr", bidirectional: true, joinAcrossStyleRuns: true },
		});
		expect(bidiIncompatible).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1" });
		expect(bidiIncompatible.shapedGlyphs).toHaveLength(2);

		const kerningBase = {
			...base,
			runs: [{ ...run, text: "AV" }],
			boxLayout: { left: 0, top: 0, right: 170, bottom: 90 },
		};
		const kerned = await renderProjectFontTextStyleRuns(kerningBase);
		const unkerned = await renderProjectFontTextStyleRuns({ ...kerningBase, runs: [{ ...kerningBase.runs[0], autoKerning: false }] });
		expect(kerned.boxLayout!.lines[0].advance).toBeLessThan(unkerned.boxLayout!.lines[0].advance);
		const vertical = await renderProjectFontTextStyleRuns({ ...base, orientation: "vertical" });
		expect(vertical).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-vertical-style-runs-v1",
			styleRuns: [{ openTypeFeatureExecutionModel: "bounded-authored-opentype-features-v1" }],
		});
		for (const field of ["autoKerning", "ligatures", "discretionaryLigatures"] as const) {
			await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...run, [field]: "yes" as never }] })).rejects.toThrow(`${field} must be Boolean or null`);
		}
	});

	test("executes authored proportional metrics through exact OpenType palt positioning and caller-feature precedence", async () => {
		const fontBytes = Buffer.from((await readFile(proportionalMetricsFixture, "utf8")).trim(), "base64");
		const makeRun = (proportionalMetrics: boolean | null) => ({
			text: "Aa",
			fontPath: join(directory, "assets", "palt.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			proportionalMetrics,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Palt Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 220, height: 120, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 20 };
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(disabled).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-style-runs-v1",
			styleRuns: [
				{
					proportionalMetrics: false,
					proportionalMetricsFeatureSupported: true,
					proportionalMetricsExecutionModel: "bounded-authored-proportional-metrics-v1",
					effectiveOpenTypeFeatures: [{ tag: "palt", value: 0 }],
				},
			],
		});
		expect(enabled.styleRuns[0]).toMatchObject({
			proportionalMetrics: true,
			proportionalMetricsFeatureSupported: true,
			proportionalMetricsExecutionModel: "bounded-authored-proportional-metrics-v1",
			effectiveOpenTypeFeatures: [{ tag: "palt", value: 1 }],
		});
		expect(disabled.shapedGlyphs.map((glyph) => glyph.xAdvance)).toEqual([668, 551]);
		expect(enabled.shapedGlyphs.map((glyph) => glyph.xAdvance)).toEqual([468, 451]);
		expect(enabled.pixels).not.toEqual(disabled.pixels);

		const authoredOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(false)],
			shaping: { direction: "ltr", features: [{ tag: "palt", value: 1 }] },
		});
		expect(authoredOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag: "palt", value: 0 }]);
		expect(authoredOverride.shapedGlyphs.map((glyph) => glyph.xAdvance)).toEqual([668, 551]);

		const unsupported = await renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), fontPath: source, fontBytes: await readFile(source) }] });
		expect(unsupported.styleRuns[0]).toMatchObject({
			proportionalMetrics: true,
			proportionalMetricsFeatureSupported: false,
			proportionalMetricsExecutionModel: "bounded-authored-proportional-metrics-v1",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), proportionalMetrics: 1 as never }] })).rejects.toThrow(
			"proportionalMetrics must be Boolean or null"
		);
	});

	test("executes authored Kana through exact OpenType hkna substitution and caller-feature precedence", async () => {
		const fontBytes = Buffer.from((await readFile(kanaFixture, "utf8")).trim(), "base64");
		const makeRun = (kana: boolean | null) => ({
			text: "かなカナ",
			fontPath: join(directory, "assets", "hkna.otf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			kana,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Hiragino Hkna Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 260, height: 120, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 20 };
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(disabled.styleRuns[0]).toMatchObject({
			kana: false,
			kanaFeatureSupported: true,
			kanaExecutionModel: "bounded-authored-kana-v1",
			effectiveOpenTypeFeatures: [{ tag: "hkna", value: 0 }],
		});
		expect(enabled.styleRuns[0]).toMatchObject({
			kana: true,
			kanaFeatureSupported: true,
			kanaExecutionModel: "bounded-authored-kana-v1",
			effectiveOpenTypeFeatures: [{ tag: "hkna", value: 1 }],
		});
		expect(disabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2, 3, 4]);
		expect(enabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([5, 6, 7, 8]);

		const authoredOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(false)],
			shaping: { direction: "ltr", features: [{ tag: "hkna", value: 1 }] },
		});
		expect(authoredOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag: "hkna", value: 0 }]);
		expect(authoredOverride.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2, 3, 4]);

		const unsupportedBytes = Buffer.from(fontBytes);
		unsupportedBytes.write("zzzz", unsupportedBytes.indexOf(Buffer.from("hkna")), "ascii");
		const unsupported = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...makeRun(true), fontPath: join(directory, "assets", "no-hkna.otf"), fontBytes: unsupportedBytes }],
		});
		expect(unsupported.styleRuns[0]).toMatchObject({
			kana: true,
			kanaFeatureSupported: false,
			kanaExecutionModel: "bounded-authored-kana-v1",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), kana: 1 as never }] })).rejects.toThrow("kana must be Boolean or null");
	});

	test("executes authored Ruby through exact OpenType ruby substitution and caller-feature precedence", async () => {
		const fontBytes = Buffer.from((await readFile(rubyFixture, "utf8")).trim(), "base64");
		const makeRun = (ruby: boolean | null) => ({
			text: "あいうえお",
			fontPath: join(directory, "assets", "ruby.otf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			ruby,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Hiragino Ruby Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 300, height: 120, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 20 };
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(disabled.styleRuns[0]).toMatchObject({
			ruby: false,
			rubyFeatureSupported: true,
			rubyExecutionModel: "bounded-authored-ruby-v1",
			effectiveOpenTypeFeatures: [{ tag: "ruby", value: 0 }],
		});
		expect(enabled.styleRuns[0]).toMatchObject({
			ruby: true,
			rubyFeatureSupported: true,
			rubyExecutionModel: "bounded-authored-ruby-v1",
			effectiveOpenTypeFeatures: [{ tag: "ruby", value: 1 }],
		});
		expect(disabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2, 3, 4, 5]);
		expect(enabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([6, 7, 8, 9, 10]);

		const authoredOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(false)],
			shaping: { direction: "ltr", features: [{ tag: "ruby", value: 1 }] },
		});
		expect(authoredOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag: "ruby", value: 0 }]);
		expect(authoredOverride.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2, 3, 4, 5]);

		const unsupportedBytes = Buffer.from(fontBytes);
		unsupportedBytes.write("zzzz", unsupportedBytes.indexOf(Buffer.from("ruby")), "ascii");
		const unsupported = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...makeRun(true), fontPath: join(directory, "assets", "no-ruby.otf"), fontBytes: unsupportedBytes }],
		});
		expect(unsupported.styleRuns[0]).toMatchObject({
			ruby: true,
			rubyFeatureSupported: false,
			rubyExecutionModel: "bounded-authored-ruby-v1",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), ruby: 1 as never }] })).rejects.toThrow("ruby must be Boolean or null");
	});

	test("executes authored Japanese alternate modes through mutually exclusive trad, expt, and jp78 substitutions", async () => {
		const fontBytes = Buffer.from((await readFile(japaneseAlternatesFixture, "utf8")).trim(), "base64");
		const makeRun = (japaneseAlternateFeature: "normal" | "traditional" | "expert" | "jis78" | null) => ({
			text: "あいうえお",
			fontPath: join(directory, "assets", "japanese-alternates.otf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			japaneseAlternateFeature,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Hiragino Japanese Alternates Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 300, height: 120, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 20 };
		const expected = [
			["normal", null, [1, 2, 3, 4, 5], [0, 0, 0]],
			["traditional", "trad", [6, 7, 8, 9, 10], [1, 0, 0]],
			["expert", "expt", [10, 9, 8, 7, 6], [0, 1, 0]],
			["jis78", "jp78", [7, 8, 9, 10, 6], [0, 0, 1]],
		] as const;
		for (const [mode, tag, glyphIds, values] of expected) {
			const rendered = await renderProjectFontTextStyleRuns({
				...base,
				runs: [makeRun(mode)],
				shaping: {
					direction: "ltr",
					features: [
						{ tag: "trad", value: 1 },
						{ tag: "expt", value: 1 },
						{ tag: "jp78", value: 1 },
					],
				},
			});
			expect(rendered.styleRuns[0]).toMatchObject({
				japaneseAlternateFeature: mode,
				japaneseAlternateFeatureTag: tag,
				japaneseAlternateFeatureSupported: true,
				japaneseAlternateFeatureAvailableTags: ["trad", "expt", "jp78"],
				japaneseAlternateFeatureExecutionModel: "bounded-authored-japanese-alternate-feature-v1",
				effectiveOpenTypeFeatures: [
					{ tag: "trad", value: values[0] },
					{ tag: "expt", value: values[1] },
					{ tag: "jp78", value: values[2] },
				],
			});
			expect(rendered.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual(glyphIds);
		}

		const unsupportedBytes = Buffer.from(fontBytes);
		for (let offset = unsupportedBytes.indexOf(Buffer.from("trad")); offset >= 0; offset = unsupportedBytes.indexOf(Buffer.from("trad"), offset + 4)) {
			unsupportedBytes.write("zzzz", offset, "ascii");
		}
		const unsupported = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...makeRun("traditional"), fontPath: join(directory, "assets", "no-trad.otf"), fontBytes: unsupportedBytes }],
		});
		expect(unsupported.styleRuns[0]).toMatchObject({
			japaneseAlternateFeature: "traditional",
			japaneseAlternateFeatureTag: "trad",
			japaneseAlternateFeatureSupported: false,
			japaneseAlternateFeatureAvailableTags: ["expt", "jp78"],
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("normal"), japaneseAlternateFeature: "unknown" as never }] })).rejects.toThrow(
			"japaneseAlternateFeature must be normal, traditional, expert, jis78, or null"
		);
	});

	test("executes global EngineData2 fractions, ordinals, and stylistic alternates through exact frac, ordn, and salt substitutions", async () => {
		const fontBytes = Buffer.from((await readFile(engineData2Fixture, "utf8")).trim(), "base64");
		const makeRun = (features: { fractions?: boolean | null; ordinals?: boolean | null; stylisticAlternates?: boolean | null }) => ({
			text: "123",
			fontPath: join(directory, "assets", "engine-data2.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			...features,
			engineData2StyleRunIndex: 4,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist EngineData2 Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 240, height: 120, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 20 };
		const expected = [
			["fractions", "frac", [1, 4, 5]],
			["ordinals", "ordn", [6, 7, 8]],
			["stylisticAlternates", "salt", [5, 1, 4]],
		] as const;
		for (const [field, tag, enabledGlyphs] of expected) {
			const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ [field]: false })] });
			const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ [field]: true })] });
			expect(disabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([9, 10, 11]);
			expect(enabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual(enabledGlyphs);
			expect(enabled.styleRuns[0]).toMatchObject({
				[field]: true,
				[`${field}FeatureSupported`]: true,
				engineData2StyleRunIndex: 4,
				engineData2ExecutionModel: "bounded-global-txt2-engine-data2-v1",
				stylisticOpenTypeExecutionModel: "bounded-authored-stylistic-opentype-v1",
				effectiveOpenTypeFeatures: [{ tag, value: 1 }],
			});
			const callerOverride = await renderProjectFontTextStyleRuns({
				...base,
				runs: [makeRun({ [field]: false })],
				shaping: { direction: "ltr", features: [{ tag, value: 1 }] },
			});
			expect(callerOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag, value: 0 }]);
			expect(callerOverride.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([9, 10, 11]);
		}
		const all = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ fractions: false, ordinals: true, stylisticAlternates: false })] });
		expect(all.styleRuns[0]).toMatchObject({
			fractionsFeatureSupported: true,
			ordinalsFeatureSupported: true,
			stylisticAlternatesFeatureSupported: true,
			effectiveOpenTypeFeatures: [
				{ tag: "frac", value: 0 },
				{ tag: "ordn", value: 1 },
				{ tag: "salt", value: 0 },
			],
		});
		for (const field of ["fractions", "ordinals", "stylisticAlternates"] as const) {
			await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ [field]: 1 as never })] })).rejects.toThrow(`${field} must be Boolean or null`);
		}
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun({ fractions: true }), engineData2StyleRunIndex: 256 }] })).rejects.toThrow(
			"engineData2StyleRunIndex must be an integer between 0 and 255"
		);
	});

	test("executes authored OldStyle, Swash, Titling, Ornaments, and SlashedZero through exact registered OpenType substitutions", async () => {
		const fontBytes = Buffer.from((await readFile(characterOpenTypeFixture, "utf8")).trim(), "base64");
		const makeRun = (features: { oldStyle?: boolean | null; swash?: boolean | null; titling?: boolean | null; ornaments?: boolean | null; slashedZero?: boolean | null }) => ({
			text: "A0",
			fontPath: join(directory, "assets", "character-opentype.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			...features,
			color: [30, 180, 240, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Zvibe Character OpenType Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 180, height: 120, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 20 };
		const expected = [
			["oldStyle", "onum", [1, 6]],
			["swash", "swsh", [3, 2]],
			["titling", "titl", [4, 2]],
			["ornaments", "ornm", [5, 2]],
			["slashedZero", "zero", [1, 7]],
		] as const;
		for (const [field, tag, enabledGlyphs] of expected) {
			const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ [field]: false })] });
			const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ [field]: true })] });
			expect(disabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2]);
			expect(enabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual(enabledGlyphs);
			expect(enabled.styleRuns[0]).toMatchObject({
				[field]: true,
				[`${field}FeatureSupported`]: true,
				characterOpenTypeExecutionModel: "bounded-authored-character-opentype-v1",
				effectiveOpenTypeFeatures: [{ tag, value: 1 }],
			});
			const callerOverride = await renderProjectFontTextStyleRuns({
				...base,
				runs: [makeRun({ [field]: false })],
				shaping: { direction: "ltr", features: [{ tag, value: 1 }] },
			});
			expect(callerOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag, value: 0 }]);
			expect(callerOverride.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2]);
		}
		const unsupportedFontBytes = Buffer.from(fontBytes);
		let swashFeatureOffset = unsupportedFontBytes.indexOf("swsh");
		expect(swashFeatureOffset).toBeGreaterThanOrEqual(0);
		while (swashFeatureOffset >= 0) {
			unsupportedFontBytes.write("zzzz", swashFeatureOffset, "ascii");
			swashFeatureOffset = unsupportedFontBytes.indexOf("swsh", swashFeatureOffset + 4);
		}
		const unsupported = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...makeRun({ swash: true }), fontBytes: unsupportedFontBytes }],
		});
		expect(unsupported.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 2]);
		expect(unsupported.styleRuns[0]).toMatchObject({
			swash: true,
			swashFeatureSupported: false,
			characterOpenTypeExecutionModel: "bounded-authored-character-opentype-v1",
			effectiveOpenTypeFeatures: [{ tag: "swsh", value: 1 }],
		});
		for (const field of ["oldStyle", "swash", "titling", "ornaments", "slashedZero"] as const) {
			await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ [field]: 1 as never })] })).rejects.toThrow(`${field} must be Boolean or null`);
		}
	});

	test("executes authored ConnectionForms as exact contextual alternates", async () => {
		const fontBytes = Buffer.from((await readFile(connectionFormsFixture, "utf8")).trim(), "base64");
		const makeRun = (connectionForms: boolean) => ({
			text: "A",
			fontPath: join(directory, "assets", "connection-forms.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			connectionForms,
			color: [180, 120, 240, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Zvibe Connection Forms Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 100, height: 90, lineHeight: null, justification: "left" as const, offsetX: 12, offsetY: 12 };
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(disabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		expect(enabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([3]);
		expect(enabled.styleRuns[0]).toMatchObject({
			connectionForms: true,
			connectionFormsFeatureSupported: true,
			connectionFormsExecutionModel: "bounded-authored-connection-forms-v1",
			effectiveOpenTypeFeatures: [{ tag: "calt", value: 1 }],
		});
		const callerOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(false)],
			shaping: { direction: "ltr", features: [{ tag: "calt", value: 1 }] },
		});
		expect(callerOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag: "calt", value: 0 }]);
		expect(callerOverride.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		const unsupportedFontBytes = Buffer.from(fontBytes);
		let featureOffset = unsupportedFontBytes.indexOf("calt");
		expect(featureOffset).toBeGreaterThanOrEqual(0);
		while (featureOffset >= 0) {
			unsupportedFontBytes.write("zzzz", featureOffset, "ascii");
			featureOffset = unsupportedFontBytes.indexOf("calt", featureOffset + 4);
		}
		const unsupported = await renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), fontBytes: unsupportedFontBytes }] });
		expect(unsupported.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		expect(unsupported.styleRuns[0]).toMatchObject({
			connectionForms: true,
			connectionFormsFeatureSupported: false,
			connectionFormsExecutionModel: "bounded-authored-connection-forms-v1",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), connectionForms: 1 as never }] })).rejects.toThrow(
			"connectionForms must be Boolean or null"
		);
	});

	test("executes authored ContextualLigatures as exact contextual ligatures", async () => {
		const fontBytes = Buffer.from((await readFile(contextualLigaturesFixture, "utf8")).trim(), "base64");
		const makeRun = (contextualLigatures: boolean) => ({
			text: "A",
			fontPath: join(directory, "assets", "contextual-ligatures.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			contextualLigatures,
			color: [80, 210, 170, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Zvibe Contextual Ligatures Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 100, height: 90, lineHeight: null, justification: "left" as const, offsetX: 12, offsetY: 12 };
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(disabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		expect(enabled.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([3]);
		expect(enabled.styleRuns[0]).toMatchObject({
			contextualLigatures: true,
			contextualLigaturesFeatureSupported: true,
			contextualLigaturesExecutionModel: "bounded-authored-contextual-ligatures-v1",
			effectiveOpenTypeFeatures: [{ tag: "clig", value: 1 }],
		});
		const callerOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(false)],
			shaping: { direction: "ltr", features: [{ tag: "clig", value: 1 }] },
		});
		expect(callerOverride.styleRuns[0].effectiveOpenTypeFeatures).toEqual([{ tag: "clig", value: 0 }]);
		expect(callerOverride.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		const unsupportedFontBytes = Buffer.from(fontBytes);
		let featureOffset = unsupportedFontBytes.indexOf("clig");
		expect(featureOffset).toBeGreaterThanOrEqual(0);
		while (featureOffset >= 0) {
			unsupportedFontBytes.write("zzzz", featureOffset, "ascii");
			featureOffset = unsupportedFontBytes.indexOf("clig", featureOffset + 4);
		}
		const unsupported = await renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), fontBytes: unsupportedFontBytes }] });
		expect(unsupported.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		expect(unsupported.styleRuns[0]).toMatchObject({
			contextualLigatures: true,
			contextualLigaturesFeatureSupported: false,
			contextualLigaturesExecutionModel: "bounded-authored-contextual-ligatures-v1",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), contextualLigatures: 1 as never }] })).rejects.toThrow(
			"contextualLigatures must be Boolean or null"
		);
	});

	test("executes authored HindiNumbers as exact Arabic/Western or Hindi/Arabic-Indic digits", async () => {
		const fontBytes = Buffer.from((await readFile(hindiNumbersFixture, "utf8")).trim(), "base64");
		const makeRun = (hindiNumbers: boolean, text = "0") => ({
			text,
			fontPath: join(directory, "assets", "hindi-numbers.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			hindiNumbers,
			color: [240, 170, 70, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Zvibe Hindi Numbers Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 100, height: 90, lineHeight: null, justification: "left" as const, offsetX: 12, offsetY: 12 };
		const western = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const hindi = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(western.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([2]);
		expect(hindi.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([6]);
		expect(western.styleRuns[0]).toMatchObject({
			hindiNumbers: false,
			hindiNumbersAffectedCharacterCount: 0,
			hindiNumbersEffectiveDigits: "arabic-western",
			hindiNumbersExecutionModel: "bounded-authored-hindi-numbers-v1",
		});
		expect(hindi.styleRuns[0]).toMatchObject({
			hindiNumbers: true,
			hindiNumbersAffectedCharacterCount: 1,
			hindiNumbersEffectiveDigits: "hindi-arabic-indic",
			hindiNumbersExecutionModel: "bounded-authored-hindi-numbers-v1",
		});
		const joined = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(false), { ...makeRun(true), sourceStyleRunIndex: 1 }],
			shaping: { direction: "ltr", joinAcrossStyleRuns: true },
		});
		expect(joined.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([2, 6]);
		await expect(
			renderProjectFontTextStyleRuns({
				...base,
				runs: [{ ...makeRun(true), fontBytes: Buffer.from((await readFile(contextualLigaturesFixture, "utf8")).trim(), "base64") }],
			})
		).rejects.toThrow("missing authored Hindi digit codepoint(s): U+0660");
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), hindiNumbers: 1 as never }] })).rejects.toThrow("hindiNumbers must be Boolean or null");
	});

	test("executes authored CharacterDirection as exact per-style-run Unicode BiDi overrides", async () => {
		const fontPath = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(import.meta.dirname, "../fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		const fontBytes = await readFile(fontPath);
		const makeRun = (text: string, sourceStyleRunIndex: number, characterDirection: "default" | "left-to-right" | "right-to-left") => ({
			text,
			fontPath,
			fontBytes,
			fontSize: 42,
			tracking: 0,
			characterDirection,
			color: [240, 170, 70, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Amiri Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 320, height: 90, lineHeight: null, justification: "left" as const, offsetX: 12, offsetY: 12 };
		const rendered = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun("ABC", 0, "default"), makeRun("DEF", 1, "left-to-right"), makeRun("GHI", 2, "right-to-left")],
			shaping: { direction: "ltr", bidirectional: false, joinAcrossStyleRuns: true },
		});
		expect(rendered.executionModel).toBe("bounded-project-font-harfbuzz-bidi-cross-style-runs-v1");
		expect(rendered.shaping?.bidirectional).toMatchObject({ baseDirection: "ltr", codePointCount: 9, controlCount: 0 });
		expect(rendered.styleRuns).toMatchObject([
			{
				characterDirection: "default",
				characterDirectionOverrideCharacterCount: 0,
				characterDirectionResolvedEmbeddingLevels: [0],
				characterDirectionExecutionModel: "bounded-authored-character-direction-v1",
			},
			{
				characterDirection: "left-to-right",
				characterDirectionOverrideCharacterCount: 3,
				characterDirectionResolvedEmbeddingLevels: [0],
				characterDirectionExecutionModel: "bounded-authored-character-direction-v1",
			},
			{
				characterDirection: "right-to-left",
				characterDirectionOverrideCharacterCount: 3,
				characterDirectionResolvedEmbeddingLevels: [1],
				characterDirectionExecutionModel: "bounded-authored-character-direction-v1",
			},
		]);
		expect(rendered.styleRuns[2].shapedGlyphs.map((glyph) => glyph.cluster)).toEqual([8, 7, 6]);
		expect(rendered.shaping?.bidirectional?.visualRuns.map((run) => run.sourceStyleRunIndices)).toEqual([[0], [1], [2]]);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("ABC", 0, "default"), characterDirection: "sideways" as never }] })).rejects.toThrow(
			"characterDirection must be default, left-to-right, right-to-left, or null"
		);
	});

	test("executes authored Kashida as contextual Arabic elongation only on fully justified lines", async () => {
		const fontPath = join(directory, "assets", "Amiri-Kashida.ttf");
		await copyFile(join(import.meta.dirname, "../fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		const fontBytes = await readFile(fontPath);
		const makeRun = (kashida: boolean) => ({
			text: "سلام",
			fontPath,
			fontBytes,
			fontSize: 42,
			tracking: 0,
			kashida,
			color: [230, 160, 60, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Amiri Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const paragraphRun = {
			sourceParagraphRunIndex: 0,
			start: 0,
			length: 4,
			justification: "justify-all" as const,
			firstLineIndent: 0,
			startIndent: 0,
			endIndent: 0,
			spaceBefore: 0,
			spaceAfter: 0,
			autoHyphenate: false,
			hyphenatedWordSize: 5,
			preHyphen: 2,
			postHyphen: 2,
			consecutiveHyphens: 2,
			hyphenationZone: 36,
			autoLeading: 1.2,
			everyLineComposer: false,
		};
		const base = {
			width: 260,
			height: 90,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 0,
			offsetY: 4,
			paragraphRuns: [paragraphRun],
			boxLayout: { left: 4, top: 4, right: 220, bottom: 86 },
			shaping: { direction: "rtl" as const, script: "Arab", language: "ar", bidirectional: true },
		};
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(false)] });
		const enabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(true)] });
		expect(disabled.styleRuns[0]).toMatchObject({
			kashida: false,
			kashidaEligibleJoinCount: 0,
			kashidaInsertedCount: 0,
			kashidaInsertedAdvance: 0,
			kashidaExecutionModel: "bounded-authored-kashida-justification-v1",
		});
		expect(enabled.styleRuns[0]).toMatchObject({
			kashida: true,
			kashidaExecutionModel: "bounded-authored-kashida-justification-v1",
		});
		expect(enabled.styleRuns[0].kashidaEligibleJoinCount).toBeGreaterThan(0);
		expect(enabled.styleRuns[0].kashidaInsertedCount).toBeGreaterThan(0);
		expect(enabled.styleRuns[0].kashidaInsertedAdvance).toBeGreaterThan(0);
		expect(enabled.boxLayout!.lines[0].advance).toBeGreaterThan(disabled.boxLayout!.lines[0].advance);
		expect(enabled.styleRuns[0].shapedGlyphs.length).toBeGreaterThan(disabled.styleRuns[0].shapedGlyphs.length);
		const inactive = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(true)],
			paragraphRuns: [{ ...paragraphRun, justification: "right" }],
		});
		expect(inactive.styleRuns[0]).toMatchObject({
			kashida: true,
			kashidaEligibleJoinCount: 0,
			kashidaInsertedCount: 0,
			kashidaExecutionModel: "inactive-not-fully-justified",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun(true), kashida: 1 as never }] })).rejects.toThrow("kashida must be Boolean or null");
	});

	test("executes authored DiacriticPos presets over exact HarfBuzz mark positioning", async () => {
		const fontPath = join(directory, "assets", "Amiri-Diacritics.ttf");
		await copyFile(join(import.meta.dirname, "../fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		const fontBytes = await readFile(fontPath);
		const makeRun = (diacriticPosition: "opentype" | "loose" | "medium" | "tight", text = "كُتِبَ") => ({
			text,
			fontPath,
			fontBytes,
			fontSize: 42,
			tracking: 0,
			diacriticPosition,
			color: [240, 190, 70, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Amiri Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = {
			width: 260,
			height: 110,
			lineHeight: null,
			justification: "center" as const,
			offsetX: 0,
			offsetY: 12,
			shaping: { direction: "rtl" as const, script: "Arab", language: "ar", bidirectional: true },
		};
		const opentype = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("opentype")] });
		const loose = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("loose")] });
		const medium = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("medium")] });
		const tight = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("tight")] });
		for (const [mode, rendered] of [
			["opentype", opentype],
			["loose", loose],
			["medium", medium],
			["tight", tight],
		] as const) {
			expect(rendered.styleRuns[0]).toMatchObject({
				diacriticPosition: mode,
				diacriticAffectedGlyphCount: 3,
				diacriticExecutionModel: "bounded-authored-diacritic-position-v1",
			});
			expect(rendered.styleRuns[0].diacriticGlyphs.map((glyph) => glyph.placement).sort()).toEqual(["above", "above", "below"]);
		}
		expect(opentype.styleRuns[0].diacriticGlyphs.map((glyph) => glyph.authoredVerticalShift)).toEqual([0, 0, 0]);
		expect(loose.styleRuns[0].diacriticGlyphs.map((glyph) => Math.abs(glyph.authoredVerticalShift))).toEqual([5.04, 5.04, 5.04]);
		expect(medium.styleRuns[0].diacriticGlyphs.map((glyph) => Math.abs(glyph.authoredVerticalShift))).toEqual([2.52, 2.52, 2.52]);
		expect(tight.styleRuns[0].diacriticGlyphs.map((glyph) => Math.abs(glyph.authoredVerticalShift))).toEqual([0.84, 0.84, 0.84]);
		expect(Buffer.compare(Buffer.from(opentype.pixels), Buffer.from(loose.pixels))).not.toBe(0);
		expect(Buffer.compare(Buffer.from(loose.pixels), Buffer.from(medium.pixels))).not.toBe(0);
		expect(Buffer.compare(Buffer.from(medium.pixels), Buffer.from(tight.pixels))).not.toBe(0);
		const inactive = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("medium", "سلام")] });
		expect(inactive.styleRuns[0]).toMatchObject({
			diacriticPosition: "medium",
			diacriticAffectedGlyphCount: 0,
			diacriticGlyphs: [],
			diacriticExecutionModel: "inactive-no-combining-diacritics",
		});
		const vertical = await renderProjectFontTextStyleRuns({ ...base, orientation: "vertical", runs: [makeRun("medium")] });
		expect(vertical.styleRuns[0]).toMatchObject({
			diacriticPosition: "medium",
			diacriticAffectedGlyphCount: 0,
			diacriticGlyphs: [],
			diacriticExecutionModel: "inactive-vertical-text",
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("medium"), diacriticPosition: "floating" as never }] })).rejects.toThrow(
			"diacriticPosition must be opentype, loose, medium, tight, or null"
		);
	});

	test("executes authored FigureStyle as mutually explicit lining, oldstyle, proportional, and tabular figure features", async () => {
		const fontBytes = Buffer.from((await readFile(figureStyleFixture, "utf8")).trim(), "base64");
		const makeRun = (figureStyle: "default" | "tabular-lining" | "proportional-oldstyle" | "proportional-lining" | "tabular-oldstyle") => ({
			text: "0",
			fontPath: join(directory, "assets", "figure-style.ttf"),
			fontBytes,
			fontSize: 48,
			tracking: 0,
			figureStyle,
			color: [120, 220, 80, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Zvibe Figure Style Test",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 120, height: 100, lineHeight: null, justification: "left" as const, offsetX: 12, offsetY: 12 };
		const expected = [
			["default", 2, [0, 0, 0, 0]],
			["tabular-lining", 4, [1, 0, 0, 1]],
			["proportional-oldstyle", 5, [0, 1, 1, 0]],
			["proportional-lining", 3, [1, 0, 1, 0]],
			["tabular-oldstyle", 7, [0, 1, 0, 1]],
		] as const;
		const tags = ["lnum", "onum", "pnum", "tnum"];
		for (const [figureStyle, glyphId, values] of expected) {
			const rendered = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(figureStyle)] });
			expect(rendered.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([glyphId]);
			expect(tags.map((tag) => rendered.styleRuns[0].effectiveOpenTypeFeatures.find((feature) => feature.tag === tag)?.value)).toEqual(values);
			expect(rendered.styleRuns[0]).toMatchObject({
				figureStyle,
				figureStyleLiningFeatureSupported: true,
				figureStyleOldStyleFeatureSupported: true,
				figureStyleProportionalFeatureSupported: true,
				figureStyleTabularFeatureSupported: true,
				figureStyleExecutionModel: "bounded-authored-figure-style-v1",
			});
		}
		const callerOverride = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun("proportional-lining")],
			shaping: { direction: "ltr", features: tags.map((tag) => ({ tag, value: 1 })) },
		});
		expect(tags.map((tag) => callerOverride.styleRuns[0].effectiveOpenTypeFeatures.find((feature) => feature.tag === tag)?.value)).toEqual([1, 0, 1, 0]);
		const oldStyleConflict = await renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("proportional-lining"), oldStyle: true }] });
		expect(oldStyleConflict.styleRuns[0].effectiveOpenTypeFeatures.find((feature) => feature.tag === "onum")?.value).toBe(0);
		expect(oldStyleConflict.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([3]);
		const unsupportedFontBytes = Buffer.from(fontBytes);
		let proportionalFeatureOffset = unsupportedFontBytes.indexOf("pnum");
		expect(proportionalFeatureOffset).toBeGreaterThanOrEqual(0);
		while (proportionalFeatureOffset >= 0) {
			unsupportedFontBytes.write("zzzz", proportionalFeatureOffset, "ascii");
			proportionalFeatureOffset = unsupportedFontBytes.indexOf("pnum", proportionalFeatureOffset + 4);
		}
		const unsupported = await renderProjectFontTextStyleRuns({
			...base,
			runs: [{ ...makeRun("proportional-lining"), fontBytes: unsupportedFontBytes }],
		});
		expect(unsupported.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1]);
		expect(unsupported.styleRuns[0]).toMatchObject({ figureStyleProportionalFeatureSupported: false, figureStyleExecutionModel: "bounded-authored-figure-style-v1" });
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("default"), figureStyle: "unsupported" as never }] })).rejects.toThrow(
			"figureStyle must be default, tabular-lining, proportional-oldstyle, proportional-lining, tabular-oldstyle, or null"
		);
	});

	test("executes authored Wari-chu as bounded balanced sublines in horizontal and vertical text", async () => {
		const fontBytes = await readFile(source);
		const makeRun = (wariChuJustification: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all" | "auto") => ({
			text: "ABCDEFGH",
			fontPath: source,
			fontBytes,
			fontSize: 48,
			tracking: 20,
			wariChuEnabled: true,
			wariChuLineCount: 2,
			wariChuLineGap: 2,
			wariChuScale: 0.5,
			wariChuWidow: 2,
			wariChuOrphan: 2,
			wariChuJustification,
			color: [240, 120, 20, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 260, height: 150, lineHeight: null, justification: "left" as const, offsetX: 10, offsetY: 10 };
		const expected = new Map([
			["left", ["left", "left"]],
			["right", ["right", "right"]],
			["center", ["center", "center"]],
			["justify-left", ["justify", "left"]],
			["justify-right", ["justify", "right"]],
			["justify-center", ["justify", "center"]],
			["justify-all", ["justify", "justify"]],
			["auto", ["justify", "left"]],
		] as const);
		for (const [justification, resolved] of expected) {
			const rendered = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(justification)] });
			const evidence = rendered.styleRuns[0];
			expect(evidence).toMatchObject({
				wariChuEnabled: true,
				wariChuLineCount: 2,
				wariChuLineGap: 2,
				wariChuScale: 0.5,
				wariChuWidow: 2,
				wariChuOrphan: 2,
				wariChuJustification: justification,
				wariChuExecutionModel: "bounded-authored-wari-chu-v1",
			});
			expect(evidence.wariChuBlocks).toHaveLength(1);
			expect(evidence.wariChuBlocks[0].rows).toHaveLength(2);
			expect(evidence.wariChuBlocks[0].rows.map((row) => row.resolvedJustification)).toEqual(resolved);
			expect(evidence.wariChuBlocks[0].rows.reduce((sum, row) => sum + row.clusterCount, 0)).toBe(8);
			expect(evidence.wariChuBlocks[0].crossSpan).toBe(50);
			expect(rendered.inkBounds).not.toBeNull();
		}

		const vertical = await renderProjectFontTextStyleRuns({ ...base, orientation: "vertical", runs: [makeRun("auto")] });
		expect(vertical.styleRuns[0].wariChuBlocks[0]).toMatchObject({ crossSpan: 50, rows: [{ rowIndex: 0 }, { rowIndex: 1 }] });
		expect(vertical.inkBounds).not.toBeNull();

		const atomic = await renderProjectFontTextStyleRuns({
			...base,
			boxLayout: { left: 0, top: 0, right: 20, bottom: 120 },
			runs: [makeRun("auto")],
		});
		expect(atomic.boxLayout).toMatchObject({ composedLineCount: 1, softBreakCount: 0, overflowLineCount: 1 });

		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("auto"), wariChuLineCount: 1 }] })).rejects.toThrow(
			"wariChuLineCount must be an integer between 2 and 16"
		);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("auto"), wariChuScale: 1.1 }] })).rejects.toThrow("wariChuScale must be between 0.1 and 1");
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("auto"), wariChuWidow: 5, wariChuOrphan: 5 }] })).rejects.toThrow(
			"requires at least 10 shaped clusters"
		);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("auto"), baselineDirection: "tate-chu-yoko" as const }] })).rejects.toThrow(
			"cannot combine Wari-chu with Tate-Chu-Yoko"
		);
	});

	test("executes authored pair-specific manual kerning additively at exact UTF-16 style boundaries", async () => {
		const fontBytes = await readFile(source);
		const run = {
			text: "A",
			fontPath: source,
			fontBytes,
			fontSize: 48,
			tracking: 50,
			kerning: 0,
			color: [240, 120, 20, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		};
		const options = {
			runs: [run, { ...run, text: "V", sourceStyleRunIndex: 1, kerning: 250 }, { ...run, sourceStyleRunIndex: 2, kerning: -125 }],
			boxLayout: { left: 0, top: 0, right: 170, bottom: 90 },
			width: 180,
			height: 100,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
		};
		const legacy = await renderProjectFontTextStyleRuns(options);
		const legacyZero = await renderProjectFontTextStyleRuns({ ...options, runs: options.runs.map((candidate) => ({ ...candidate, kerning: 0 })) });
		expect(legacy.boxLayout!.lines[0].advance - legacyZero.boxLayout!.lines[0].advance).toBeCloseTo(6, 6);
		expect(legacy.styleRuns).toEqual([
			expect.objectContaining({ kerning: 0, manualKerningBoundaryUtf16: null, manualKerningPixels: 0, manualKerningExecutionModel: "disabled" }),
			expect.objectContaining({
				kerning: 250,
				manualKerningBoundaryUtf16: 1,
				manualKerningPixels: 12,
				manualKerningAppliedBoundaryCount: 1,
				manualKerningExecutionModel: "bounded-authored-manual-kerning-v1",
			}),
			expect.objectContaining({
				kerning: -125,
				manualKerningBoundaryUtf16: 2,
				manualKerningPixels: -6,
				manualKerningAppliedBoundaryCount: 1,
				manualKerningExecutionModel: "bounded-authored-manual-kerning-v1",
			}),
		]);

		const shapedOptions = {
			...options,
			runs: options.runs.map((candidate) => ({ ...candidate, autoKerning: false, ligatures: true })),
			shaping: { direction: "ltr" as const, joinAcrossStyleRuns: true },
		};
		const shaped = await renderProjectFontTextStyleRuns(shapedOptions);
		const shapedZero = await renderProjectFontTextStyleRuns({ ...shapedOptions, runs: shapedOptions.runs.map((candidate) => ({ ...candidate, kerning: 0 })) });
		expect(shaped.boxLayout!.lines[0].advance - shapedZero.boxLayout!.lines[0].advance).toBeCloseTo(6, 6);
		expect(shaped.styleRuns[1]).toMatchObject({
			manualKerningBoundaryUtf16: 1,
			manualKerningPixels: 12,
			manualKerningAppliedBoundaryCount: 1,
			manualKerningExecutionModel: "bounded-authored-manual-kerning-v1",
		});

		const ligatureBase = {
			...options,
			runs: [
				{ ...run, text: "f", autoKerning: false, ligatures: true },
				{ ...run, text: "i", sourceStyleRunIndex: 1, autoKerning: false, ligatures: true, kerning: 200 },
			],
			shaping: { direction: "ltr" as const, joinAcrossStyleRuns: true },
		};
		const splitLigature = await renderProjectFontTextStyleRuns(ligatureBase);
		const joinedLigature = await renderProjectFontTextStyleRuns({ ...ligatureBase, runs: ligatureBase.runs.map((candidate) => ({ ...candidate, kerning: 0 })) });
		expect(splitLigature.shapedGlyphs).toHaveLength(2);
		expect(joinedLigature.shapedGlyphs).toHaveLength(1);

		const bidi = await renderProjectFontTextStyleRuns({ ...shapedOptions, shaping: { direction: "rtl", bidirectional: true, joinAcrossStyleRuns: true } });
		expect(bidi).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1" });
		expect(bidi.styleRuns[1]).toMatchObject({ manualKerningPixels: 12, manualKerningExecutionModel: "bounded-authored-manual-kerning-v1" });
		const vertical = await renderProjectFontTextStyleRuns({ ...shapedOptions, orientation: "vertical" });
		expect(vertical).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1" });
		expect(vertical.styleRuns[1]).toMatchObject({ manualKerningPixels: 12, manualKerningExecutionModel: "bounded-authored-manual-kerning-v1" });
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [{ ...run, kerning: 100 }, ...options.runs.slice(1)] })).rejects.toThrow(
			"without a preceding character boundary"
		);
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [run, { ...run, sourceStyleRunIndex: 1, kerning: 1001 }] })).rejects.toThrow(
			"manual kerning must be null or between"
		);
	});

	test("executes authored character auto/explicit leading using the largest value on each line", async () => {
		const fontBytes = await readFile(source);
		const makeRun = (text: string, sourceStyleRunIndex: number, autoLeading: boolean, leading: number) => ({
			text,
			fontPath: source,
			fontBytes,
			fontSize: 20,
			tracking: 0,
			autoLeading,
			leading,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const runs = [makeRun("A", 0, false, 30), makeRun("B\n", 1, false, 52), makeRun("C\n", 2, true, 999), makeRun("D", 3, false, 40)];
		const paragraphRuns = [
			{
				sourceParagraphRunIndex: 0,
				start: 0,
				length: 6,
				justification: "left" as const,
				firstLineIndent: 0,
				startIndent: 0,
				endIndent: 0,
				spaceBefore: 0,
				spaceAfter: 0,
				autoHyphenate: false,
				hyphenatedWordSize: 5,
				preHyphen: 2,
				postHyphen: 2,
				consecutiveHyphens: 2,
				hyphenationZone: 36,
				autoLeading: 1.5,
				everyLineComposer: false,
			},
		];
		const options = {
			runs,
			paragraphRuns,
			boxLayout: { left: 0, top: 0, right: 140, bottom: 180 },
			width: 140,
			height: 180,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
		};
		for (const result of [
			await renderProjectFontTextStyleRuns(options),
			await renderProjectFontTextStyleRuns({ ...options, shaping: { direction: "ltr" as const } }),
			await renderProjectFontTextStyleRuns({ ...options, orientation: "vertical" as const }),
		]) {
			expect(result.lineHeight).toBe(52);
			expect(result.paragraphRuns[0]).toMatchObject({
				lineIndices: [0, 1, 2],
				lineHeights: [52, 30, 40],
				lineHeightSources: ["authored-explicit-leading", "authored-auto-leading", "authored-explicit-leading"],
				appliedLineHeight: 52,
				lineHeightSource: "authored-explicit-leading",
			});
			expect(result.styleRuns).toMatchObject([
				{ autoLeading: false, leading: 30, leadingAppliedLineIndices: [], leadingAppliedLineHeights: [], leadingExecutionModel: "bounded-authored-character-leading-v1" },
				{
					autoLeading: false,
					leading: 52,
					leadingAppliedLineIndices: [0],
					leadingAppliedLineHeights: [52],
					leadingExecutionModel: "bounded-authored-character-leading-v1",
				},
				{
					autoLeading: true,
					leading: 999,
					leadingAppliedLineIndices: [1],
					leadingAppliedLineHeights: [30],
					leadingExecutionModel: "bounded-authored-character-leading-v1",
				},
				{
					autoLeading: false,
					leading: 40,
					leadingAppliedLineIndices: [2],
					leadingAppliedLineHeights: [40],
					leadingExecutionModel: "bounded-authored-character-leading-v1",
				},
			]);
			expect(result.boxLayout!.lines).toMatchObject([
				{ lineIndex: 0, lineHeight: 52, lineHeightSource: "authored-explicit-leading", leadingSourceStyleRunIndices: [1] },
				{ lineIndex: 1, lineHeight: 30, lineHeightSource: "authored-auto-leading", leadingSourceStyleRunIndices: [2] },
				{ lineIndex: 2, lineHeight: 40, lineHeightSource: "authored-explicit-leading", leadingSourceStyleRunIndices: [3] },
			]);
		}
		const override = await renderProjectFontTextStyleRuns({ ...options, lineHeight: 44 });
		expect(override.paragraphRuns[0]).toMatchObject({ lineHeights: [44, 44, 44], lineHeightSources: ["request", "request", "request"] });
		expect(override.styleRuns.every((run) => run.leadingAppliedLineIndices.length === 0)).toBe(true);
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [{ ...runs[0], autoLeading: false, leading: 0 }, ...runs.slice(1)] })).rejects.toThrow(
			"requires explicit leading"
		);
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [{ ...runs[0], autoLeading: "yes" as never }, ...runs.slice(1)] })).rejects.toThrow(
			"autoLeading must be Boolean"
		);
		await expect(renderProjectFontTextStyleRuns({ ...options, runs: [{ ...runs[0], leading: 2049 }, ...runs.slice(1)] })).rejects.toThrow("leading must be null or between");
	});

	test("executes authored normal, all-caps, and OpenType-or-faux small-caps character styles", async () => {
		const fontBytes = await readFile(source);
		const makeRun = (text: string, sourceStyleRunIndex: number, fontCaps: "normal" | "small-caps" | "all-caps" | null) => ({
			text,
			fontPath: source,
			fontBytes,
			fontSize: 48,
			tracking: 0,
			fontCaps,
			smallCapScale: 0.65,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = {
			width: 260,
			height: 100,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
		};
		const normal = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("Abß", 0, "normal")] });
		expect(normal).toMatchObject({
			executionModel: "bounded-project-font-text-style-runs-v1",
			styleRuns: [
				{
					fontCaps: "normal",
					smallCapScale: 0.65,
					capsAppliedScale: 1,
					capsAffectedCharacterCount: 0,
					capsGlyphSource: "disabled",
					capsExecutionModel: "bounded-authored-font-caps-v1",
				},
			],
		});
		const allCaps = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("Abß", 0, "all-caps")] });
		const uppercaseReference = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun("ABSS", 0, null)],
			shaping: { direction: "ltr" as const },
		});
		expect(allCaps).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-style-runs-v1",
			styleRuns: [
				{
					fontCaps: "all-caps",
					smallCapScale: 0.65,
					capsAppliedScale: 1,
					capsAffectedCharacterCount: 2,
					capsGlyphSource: "unicode-uppercase",
					capsExecutionModel: "bounded-authored-font-caps-v1",
				},
			],
		});
		expect(allCaps.pixels).toEqual(uppercaseReference.pixels);
		expect(allCaps.shapedGlyphs.map((glyph) => glyph.cluster)).toEqual([0, 1, 2, 2]);

		const smallCaps = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("aA", 0, "small-caps")] });
		expect(smallCaps).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-style-runs-v1",
			styleRuns: [
				{
					fontCaps: "small-caps",
					smallCapScale: 0.65,
					capsAppliedScale: 0.65,
					capsAffectedCharacterCount: 1,
					capsGlyphSource: "faux-small-caps",
					capsExecutionModel: "bounded-authored-font-caps-v1",
				},
			],
		});
		expect(smallCaps.pixels).not.toEqual((await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("AA", 0, null)], shaping: { direction: "ltr" } })).pixels);
		const openTypeFontBytes = Buffer.from((await readFile(smallCapsFixture, "utf8")).trim(), "base64");
		const openTypeRun = { ...makeRun("aA", 0, "small-caps"), fontPath: join(directory, "assets", "smcp.ttf"), fontBytes: openTypeFontBytes };
		const openTypeSmallCaps = await renderProjectFontTextStyleRuns({ ...base, runs: [openTypeRun] });
		expect(openTypeSmallCaps).toMatchObject({
			styleRuns: [
				{
					fontCaps: "small-caps",
					smallCapScale: 0.65,
					capsAppliedScale: 1,
					capsAffectedCharacterCount: 1,
					capsGlyphSource: "opentype-smcp",
					capsExecutionModel: "bounded-authored-font-caps-v1",
				},
			],
		});
		expect(openTypeSmallCaps.shapedGlyphs[0].glyphId).toBe(openTypeSmallCaps.shapedGlyphs[1].glyphId);
		const bidi = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun("ab (12)", 0, "all-caps")],
			shaping: { direction: "ltr", bidirectional: true },
		});
		expect(bidi).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-bidi-style-runs-v1", styleRuns: [{ capsAffectedCharacterCount: 2 }] });
		const vertical = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("ab", 0, "small-caps")], orientation: "vertical" });
		expect(vertical).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-vertical-style-runs-v1", styleRuns: [{ capsGlyphSource: "faux-small-caps" }] });
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("a", 0, null), fontCaps: "title-caps" as never }] })).rejects.toThrow(
			"fontCaps must be normal, small-caps, all-caps, or null"
		);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("a", 0, "small-caps"), smallCapScale: 0.05 }] })).rejects.toThrow(
			"smallCapScale must be between 0.1 and 1"
		);
	});

	test("executes authored normal, OpenType, and faux superscript/subscript baselines", async () => {
		const geistBytes = await readFile(source);
		const fauxBytes = Buffer.from((await readFile(smallCapsFixture, "utf8")).trim(), "base64");
		const makeRun = (text: string, sourceStyleRunIndex: number, fontBaseline: "normal" | "superscript" | "subscript" | null, fontBytes = geistBytes) => ({
			text,
			fontPath: source,
			fontBytes,
			fontSize: 48,
			tracking: 0,
			fontBaseline,
			fontBaselineScale: 0.6,
			fontBaselinePosition: 0.4,
			baselineShift: 2,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 260, height: 120, lineHeight: null, justification: "left" as const, offsetX: 2, offsetY: 24 };
		const native = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun("a", 0, "superscript"), makeRun("a", 1, "subscript")],
			shaping: {
				direction: "ltr",
				features: [
					{ tag: "sups", value: 0 },
					{ tag: "subs", value: 0 },
				],
			},
		});
		expect(native.styleRuns).toMatchObject([
			{
				fontBaseline: "superscript",
				fontBaselineScale: 0.6,
				fontBaselinePosition: 0.4,
				fontBaselineAppliedScale: 1,
				fontBaselineAppliedShift: 2,
				fontBaselineEffectiveFeature: "sups",
				fontBaselineGlyphSource: "opentype-sups",
				fontBaselineExecutionModel: "bounded-authored-font-baseline-v1",
			},
			{
				fontBaseline: "subscript",
				fontBaselineAppliedScale: 1,
				fontBaselineAppliedShift: 2,
				fontBaselineEffectiveFeature: "subs",
				fontBaselineGlyphSource: "opentype-subs",
				fontBaselineExecutionModel: "bounded-authored-font-baseline-v1",
			},
		]);
		const faux = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("a", 0, "superscript", fauxBytes), makeRun("a", 1, "subscript", fauxBytes)] });
		expect(faux.styleRuns).toMatchObject([
			{
				fontBaseline: "superscript",
				fontBaselineAppliedScale: 0.6,
				fontBaselineAppliedShift: 21.2,
				fontBaselineGlyphSource: "faux-superscript",
			},
			{
				fontBaseline: "subscript",
				fontBaselineAppliedScale: 0.6,
				fontBaselineAppliedShift: -17.2,
				fontBaselineGlyphSource: "faux-subscript",
			},
		]);
		expect(faux.pixels).not.toEqual(native.pixels);
		const vertical = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("a", 0, "superscript", fauxBytes)], orientation: "vertical" });
		expect(vertical).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-vertical-style-runs-v1", styleRuns: [{ fontBaselineAppliedShift: 21.2 }] });
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("a", 0, null), fontBaseline: "raised" as never }] })).rejects.toThrow(
			"fontBaseline must be normal, superscript, subscript, or null"
		);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("a", 0, "superscript"), fontBaselineScale: 0.05 }] })).rejects.toThrow(
			"fontBaselineScale must be between 0.1 and 1"
		);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("a", 0, "superscript"), fontBaselinePosition: 2.1 }] })).rejects.toThrow(
			"fontBaselinePosition must be between 0 and 2"
		);
	});

	test("executes authored Tsume from exact glyph ink bounds without scaling glyphs", async () => {
		const fontBytes = await readFile(source);
		const makeRun = (tsume: number | null) => ({
			text: "HATA",
			fontPath: source,
			fontBytes,
			fontSize: 48,
			tracking: 0,
			tsume,
			color: [240, 120, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 320, height: 180, lineHeight: null, justification: "left" as const, offsetX: 32, offsetY: 32 };
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(null)], shaping: { direction: "ltr" } });
		const zero = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(0)] });
		const half = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(0.5)] });
		const full = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(1)] });
		expect(zero.styleRuns[0]).toMatchObject({
			tsume: 0,
			tsumeAppliedGlyphCount: 0,
			tsumeLeadingTrim: 0,
			tsumeTrailingTrim: 0,
			tsumeAdvanceReduction: 0,
			tsumeExecutionModel: "bounded-authored-tsume-v1",
		});
		expect(zero.pixels).toEqual(disabled.pixels);
		expect(half.styleRuns[0]).toMatchObject({ tsume: 0.5, tsumeAppliedGlyphCount: 4, tsumeExecutionModel: "bounded-authored-tsume-v1" });
		expect(full.styleRuns[0]).toMatchObject({ tsume: 1, tsumeAppliedGlyphCount: 4, tsumeExecutionModel: "bounded-authored-tsume-v1" });
		expect(full.styleRuns[0].tsumeAdvanceReduction).toBeCloseTo(half.styleRuns[0].tsumeAdvanceReduction * 2, 5);
		expect(full.styleRuns[0].tsumeGlyphs).toHaveLength(4);
		for (const glyph of full.styleRuns[0].tsumeGlyphs) {
			expect(glyph.advanceAfter).toBeCloseTo(glyph.advanceBefore - glyph.leadingTrim - glyph.trailingTrim, 5);
		}
		expect(full.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual(disabled.shapedGlyphs.map((glyph) => glyph.glyphId));
		const visiblePixelCount = (pixels: Uint8Array): number => pixels.reduce((count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0), 0);
		expect(Math.abs(visiblePixelCount(full.pixels) - visiblePixelCount(disabled.pixels))).toBeLessThanOrEqual(4);
		const vertical = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(0.75)], orientation: "vertical" });
		expect(vertical).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-vertical-style-runs-v1",
			styleRuns: [{ tsume: 0.75, tsumeExecutionModel: "bounded-authored-tsume-v1" }],
		});
		expect(vertical.styleRuns[0].tsumeAdvanceReduction).toBeGreaterThan(0);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(-0.01)] })).rejects.toThrow("tsume must be null or between 0 and 1");
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(1.01)] })).rejects.toThrow("tsume must be null or between 0 and 1");
	});

	test("decodes bounded OpenType BASE coordinates for exact ICF alignment", async () => {
		expect(parseOpenTypeBaseAlignmentMetrics(openTypeBaseFixture(), "horizontal", "hani")).toEqual({
			script: "hani",
			defaultBaselineTag: "romn",
			coordinates: {
				icfb: { value: -80, format: 1 },
				icft: { value: 840, format: 1 },
				romn: { value: 10, format: 1 },
			},
		});
		expect(parseOpenTypeBaseAlignmentMetrics(openTypeBaseFixture(), "vertical", "hani")).toBeNull();
		expect(parseOpenTypeBaseAlignmentMetrics(openTypeBaseFixture("vertical"), "vertical", "hani")?.coordinates).toEqual({
			icfb: { value: -80, format: 1 },
			icft: { value: 840, format: 1 },
			romn: { value: 10, format: 1 },
		});
		const malformed = openTypeBaseFixture();
		malformed[9] = 0xff;
		await expect(Promise.resolve().then(() => parseOpenTypeBaseAlignmentMetrics(malformed, "horizontal", "hani"))).rejects.toThrow("exceeds the bounded table data");
	});

	test("aligns smaller glyphs to each line's largest rendered character through all Photoshop em and Roman modes", async () => {
		const fontBytes = await readFile(source);
		const makeRun = (
			text: string,
			fontSize: number,
			sourceStyleRunIndex: number,
			styleRunAlignment: "em-box-bottom-left" | "em-box-center" | "roman-baseline" | "em-box-top-right"
		) => ({
			text,
			fontPath: source,
			fontBytes,
			fontSize,
			tracking: 0,
			color: [255, 255, 255, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
			styleRunAlignment,
		});
		const render = (alignment: "em-box-bottom-left" | "em-box-center" | "roman-baseline" | "em-box-top-right", orientation: "horizontal" | "vertical" = "horizontal") =>
			renderProjectFontTextStyleRuns({
				runs: [makeRun("A", 48, 0, alignment), makeRun("A", 24, 1, alignment)],
				width: 220,
				height: 160,
				orientation,
				lineHeight: null,
				justification: "left",
				offsetX: 20,
				offsetY: 20,
			});
		const [bottom, center, roman, top] = await Promise.all([render("em-box-bottom-left"), render("em-box-center"), render("roman-baseline"), render("em-box-top-right")]);
		const shift = (result: Awaited<ReturnType<typeof renderProjectFontTextStyleRuns>>): number => result.styleRuns[1].styleRunAlignmentGlyphs[0].appliedShift;
		expect(shift(roman)).toBe(0);
		expect(shift(top) - shift(center)).toBeCloseTo(12, 5);
		expect(shift(center) - shift(bottom)).toBeCloseTo(12, 5);
		expect(top.styleRuns[1]).toMatchObject({
			styleRunAlignment: "em-box-top-right",
			styleRunAlignmentExecutionModel: "bounded-authored-style-run-alignment-v1",
			styleRunAlignmentGlyphs: [expect.objectContaining({ lineIndex: 0, referenceSourceStyleRunIndex: 0, referenceEmSize: 48, glyphEmSize: 24, metricSource: "em-box" })],
		});
		const verticalRight = await render("em-box-top-right", "vertical");
		const verticalCenter = await render("em-box-center", "vertical");
		const verticalLeft = await render("em-box-bottom-left", "vertical");
		expect(shift(verticalRight)).toBe(12);
		expect(shift(verticalCenter)).toBe(0);
		expect(shift(verticalLeft)).toBe(-12);
		await expect(
			renderProjectFontTextStyleRuns({
				runs: [makeRun("A", 48, 0, "em-box-center"), { ...makeRun("A", 24, 1, "em-box-center"), styleRunAlignment: "invalid" as never }],
				width: 220,
				height: 160,
				lineHeight: null,
				justification: "left",
				offsetX: 20,
				offsetY: 20,
			})
		).rejects.toThrow("styleRunAlignment must be");
	});

	test("executes exact OpenType BASE ICF coordinates and rejects missing required metrics", async () => {
		const fontBytes = await readFile(source);
		const run = (fontSize: number, sourceStyleRunIndex: number) => ({
			text: "A",
			fontPath: source,
			fontBytes,
			fontSize,
			tracking: 0,
			color: [255, 255, 255, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
			styleRunAlignment: "icf-top-right" as const,
		});
		const options = {
			runs: [run(48, 0), run(24, 1)],
			width: 220,
			height: 160,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 20,
			offsetY: 20,
			shaping: { direction: "ltr" as const, script: "hani" },
		};
		await expect(renderProjectFontTextStyleRuns(options)).rejects.toThrow("lacks exact OpenType BASE horizontal icft coordinates");
		const hb = await import("harfbuzzjs");
		const original = hb.Face.prototype.referenceTable;
		const referenceTable = vi.spyOn(hb.Face.prototype, "referenceTable").mockImplementation(function (table: string): Uint8Array | undefined {
			return table === "BASE" ? openTypeBaseFixture() : original.call(this, table);
		});
		try {
			const rendered = await renderProjectFontTextStyleRuns(options);
			expect(rendered.styleRuns[1]).toMatchObject({
				styleRunAlignment: "icf-top-right",
				styleRunAlignmentExecutionModel: "bounded-authored-style-run-alignment-v1",
				styleRunAlignmentGlyphs: [
					expect.objectContaining({
						referenceEmSize: 48,
						glyphEmSize: 24,
						referenceCoordinate: 40.32,
						glyphCoordinate: 20.16,
						appliedShift: 20.16,
						metricSource: "opentype-base",
						baseScript: "hani",
						referenceBaseScript: "hani",
						baseTag: "icft",
						baseCoordinateFormat: 1,
						referenceBaseCoordinateFormat: 1,
					}),
				],
			});
		} finally {
			referenceTable.mockRestore();
		}
		const verticalReferenceTable = vi.spyOn(hb.Face.prototype, "referenceTable").mockImplementation(function (table: string): Uint8Array | undefined {
			return table === "BASE" ? openTypeBaseFixture("vertical") : original.call(this, table);
		});
		try {
			const vertical = await renderProjectFontTextStyleRuns({ ...options, orientation: "vertical" });
			expect(vertical.styleRuns[1].styleRunAlignmentGlyphs[0]).toMatchObject({
				referenceCoordinate: 16.32,
				glyphCoordinate: 8.16,
				appliedShift: 8.16,
				baseTag: "icft",
			});
			const romanRuns = options.runs.map((entry) => ({ ...entry, styleRunAlignment: "roman-baseline" as const }));
			const verticalRoman = await renderProjectFontTextStyleRuns({ ...options, runs: romanRuns, orientation: "vertical" });
			expect(verticalRoman.styleRuns[1].styleRunAlignmentGlyphs[0]).toMatchObject({
				referenceCoordinate: -23.52,
				glyphCoordinate: -11.76,
				appliedShift: -11.76,
				baseTag: "romn",
			});
		} finally {
			verticalReferenceTable.mockRestore();
		}
	});

	test("rasterizes vertical TySh columns through exact HarfBuzz top-to-bottom metrics", async () => {
		const options = {
			text: "VERT\nICAL",
			width: 180,
			height: 220,
			orientation: "vertical" as const,
			fontSize: 36,
			lineHeight: 44,
			tracking: 20,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 3,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		const first = await renderProjectFontText(source, options);
		const second = await renderProjectFontText(source, options);
		expect(first).toMatchObject({
			orientation: "vertical",
			executionModel: "bounded-project-font-harfbuzz-vertical-text-raster-v1",
			lineCount: 2,
			glyphCount: 8,
			uniqueGlyphCount: 8,
			lineHeight: 44,
			shaping: { engine: "harfbuzz", version: "14.2.1", direction: "ltr" },
		});
		expect(first.shapedGlyphs).toHaveLength(8);
		expect(first.shapedGlyphs.every((glyph) => glyph.xAdvance === 0 && glyph.yAdvance < 0)).toBe(true);
		expect(first.pixels).toEqual(second.pixels);
		expect(first.inkBounds).not.toBeNull();
		const visibleColumns = new Set<number>();
		for (let pixel = 0; pixel < first.pixels.length / 4; ++pixel) {
			if (first.pixels[pixel * 4 + 3] > 0) visibleColumns.add(Math.floor((pixel % options.width) / 44));
		}
		expect(visibleColumns.size).toBeGreaterThanOrEqual(2);
	});

	test("executes authored upright, mixed, and tate-chu-yoko baseline direction with Unicode vertical-orientation evidence", async () => {
		expect(projectFontUnicodeVerticalOrientation("A")).toBe("R");
		expect(projectFontUnicodeVerticalOrientation("漢")).toBe("U");
		expect(projectFontUnicodeVerticalOrientation("ぁ")).toBe("Tu");
		expect(projectFontUnicodeVerticalOrientation("〈")).toBe("Tr");
		expect(() => projectFontUnicodeVerticalOrientation("AB")).toThrow("exactly one Unicode scalar");

		const fontBytes = await readFile(source);
		const makeRun = (text: string, baselineDirection: "upright" | "mixed" | "tate-chu-yoko") => ({
			text,
			fontPath: source,
			fontBytes,
			fontSize: 40,
			tracking: 0,
			baselineDirection,
			color: [245, 100, 30, 255] as [number, number, number, number],
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
		});
		const base = { width: 180, height: 220, lineHeight: 48, justification: "left" as const, offsetX: 16, offsetY: 16, orientation: "vertical" as const };
		const upright = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("A©", "upright")] });
		expect(upright.styleRuns[0]).toMatchObject({
			baselineDirection: "upright",
			baselineDirectionExecutionModel: "bounded-authored-baseline-direction-v1",
			baselineDirectionGlyphs: [
				{ unicodeVerticalOrientation: "R", renderedOrientation: "upright", shapingDirection: "ttb", rotationDegrees: 0 },
				{ unicodeVerticalOrientation: "U", renderedOrientation: "upright", shapingDirection: "ttb", rotationDegrees: 0 },
			],
		});

		const mixed = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("A©", "mixed")] });
		expect(mixed.styleRuns[0]).toMatchObject({
			baselineDirection: "mixed",
			baselineDirectionExecutionModel: "bounded-authored-baseline-direction-v1",
			baselineDirectionGlyphs: [
				{ unicodeVerticalOrientation: "R", renderedOrientation: "sideways-clockwise", shapingDirection: "ltr", rotationDegrees: 90 },
				{ unicodeVerticalOrientation: "U", renderedOrientation: "upright", shapingDirection: "ttb", rotationDegrees: 0 },
			],
		});
		expect(mixed.pixels).not.toEqual(upright.pixels);

		const tateChuYoko = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun("12", "tate-chu-yoko")] });
		expect(tateChuYoko.styleRuns[0]).toMatchObject({
			baselineDirection: "tate-chu-yoko",
			baselineDirectionExecutionModel: "bounded-authored-baseline-direction-v1",
			baselineDirectionGlyphs: [
				{ unicodeVerticalOrientation: "R", renderedOrientation: "tate-chu-yoko-horizontal", shapingDirection: "ltr", rotationDegrees: 0 },
				{ unicodeVerticalOrientation: "R", renderedOrientation: "tate-chu-yoko-horizontal", shapingDirection: "ltr", rotationDegrees: 0 },
			],
			tateChuYokoBlocks: [{ lineIndex: 0, logicalStart: 0, logicalEnd: 2, glyphCount: 2, cellAdvance: 40 }],
		});
		expect(tateChuYoko.styleRuns[0].tateChuYokoBlocks[0].rawAdvance).toBeGreaterThan(0);
		expect(tateChuYoko.styleRuns[0].tateChuYokoBlocks[0].fittedAdvance).toBeLessThanOrEqual(40);
		expect(tateChuYoko.styleRuns[0].tateChuYokoBlocks[0].fitScale).toBeGreaterThan(0);
		expect(tateChuYoko.styleRuns[0].tateChuYokoBlocks[0].fitScale).toBeLessThanOrEqual(1);

		const horizontal = await renderProjectFontTextStyleRuns({ ...base, orientation: "horizontal", runs: [makeRun("A", "mixed")] });
		expect(horizontal.styleRuns[0]).toMatchObject({
			baselineDirectionExecutionModel: "horizontal-no-op",
			baselineDirectionGlyphs: [{ renderedOrientation: "horizontal-no-op", shapingDirection: "ltr", rotationDegrees: 0 }],
		});
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [{ ...makeRun("A", "mixed"), baselineDirection: "invalid" as "mixed" }] })).rejects.toThrow(
			"baselineDirection must be upright, mixed, tate-chu-yoko, or null"
		);
	});

	test("preserves authored style ownership and colors in a vertical HarfBuzz column", async () => {
		const fontBytes = await readFile(source);
		const result = await renderProjectFontTextStyleRuns({
			runs: [
				{
					text: "AB",
					fontPath: source,
					fontBytes,
					fontSize: 34,
					tracking: 0,
					color: [240, 30, 20, 255],
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: "Geist Regular",
					fauxBold: false,
					fauxItalic: false,
					horizontalScale: 80,
					verticalScale: 120,
					baselineShift: 3,
					underline: true,
				},
				{
					text: "CD",
					fontPath: source,
					fontBytes,
					fontSize: 34,
					tracking: 0,
					color: [20, 80, 240, 220],
					sourceStyleRunIndex: 1,
					fontIndex: 0,
					fontName: "Geist Regular",
					fauxBold: true,
					fauxItalic: false,
					strikethrough: true,
				},
			],
			paragraphRuns: [
				{
					sourceParagraphRunIndex: 0,
					start: 0,
					length: 4,
					justification: "center",
					firstLineIndent: 2,
					startIndent: 3,
					endIndent: 4,
					spaceBefore: 5,
					spaceAfter: 6,
					autoHyphenate: false,
					hyphenatedWordSize: 5,
					preHyphen: 2,
					postHyphen: 2,
					consecutiveHyphens: 2,
					hyphenationZone: 36,
					autoLeading: 1.2,
					everyLineComposer: true,
				},
			],
			width: 100,
			height: 180,
			orientation: "vertical",
			lineHeight: 44,
			justification: "left",
			offsetX: 2,
			offsetY: 2,
		});
		expect(result).toMatchObject({
			orientation: "vertical",
			executionModel: "bounded-project-font-harfbuzz-vertical-style-runs-v1",
			glyphCount: 4,
			styleRuns: [
				{
					sourceStyleRunIndex: 0,
					glyphCount: 2,
					color: [240, 30, 20, 255],
					horizontalScale: 80,
					verticalScale: 120,
					baselineShift: 3,
					underline: true,
					characterStyleExecutionModel: "bounded-authored-character-style-v1",
				},
				{ sourceStyleRunIndex: 1, glyphCount: 2, color: [20, 80, 240, 220], fauxBoldPixels: 1, strikethrough: true },
			],
		});
		expect(result.paragraphRuns).toMatchObject([
			{
				sourceParagraphRunIndex: 0,
				justification: "center",
				lineIndices: [0],
				appliedLineHeight: 44,
				lineHeightSource: "request",
				executionModel: "bounded-authored-paragraph-run-layout-v1",
			},
		]);
		const colors = Array.from({ length: result.pixels.length / 4 }, (_, index) => [...result.pixels.subarray(index * 4, index * 4 + 4)]).filter((color) => color[3] > 0);
		expect(colors.some((color) => color[0] === 240 && color[1] === 30 && color[2] === 20)).toBe(true);
		expect(colors.some((color) => color[0] === 20 && color[1] === 80 && color[2] === 240 && color[3] <= 220)).toBe(true);
	});

	test("shapes Arabic GSUB/GPOS glyphs through HarfBuzz and rasterizes exact glyph IDs deterministically", async () => {
		const arabicFont = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(import.meta.dirname, "../fixtures/fonts/Amiri-Regular.ttf"), arabicFont);
		const options = {
			text: "سلام",
			width: 180,
			height: 80,
			fontSize: 48,
			lineHeight: null,
			tracking: 0,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
			color: [245, 220, 60, 255] as [number, number, number, number],
			shaping: { direction: "rtl" as const, script: "Arab", language: "ar", features: [{ tag: "rlig", value: 1 }] },
		};
		const first = await renderProjectFontText(arabicFont, options);
		const second = await renderProjectFontText(arabicFont, options);
		expect(first).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-text-raster-v1",
			lineCount: 1,
			glyphCount: 4,
			uniqueGlyphCount: 4,
			shaping: {
				engine: "harfbuzz",
				version: "14.2.1",
				direction: "rtl",
				script: "Arab",
				language: "ar",
				features: [{ tag: "rlig", value: 1 }],
				styleBoundaryModel: "isolated-font-style-runs-v1",
			},
		});
		expect(first.shapedGlyphs).toHaveLength(4);
		expect(first.shapedGlyphs.map((glyph) => glyph.cluster)).toEqual([3, 2, 1, 0]);
		expect(first.shapedGlyphs.every((glyph) => glyph.glyphId > 0 && glyph.xAdvance > 0 && glyph.yAdvance === 0)).toBe(true);
		expect(first.pixels).toEqual(second.pixels);
		expect(first.inkBounds).not.toBeNull();
		expect(Array.from(first.pixels).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);

		const withoutRequiredLigatures = await renderProjectFontText(arabicFont, {
			...options,
			shaping: { ...options.shaping, features: [{ tag: "rlig", value: 0 }] },
		});
		expect(withoutRequiredLigatures.shapedGlyphs.map((glyph) => glyph.glyphId)).not.toEqual(first.shapedGlyphs.map((glyph) => glyph.glyphId));
		expect(withoutRequiredLigatures.pixels).not.toEqual(first.pixels);
		await expect(renderProjectFontText(arabicFont, { ...options, shaping: { direction: "auto" as never } })).rejects.toThrow("direction must be ltr or rtl");
		await expect(renderProjectFontText(arabicFont, { ...options, shaping: { direction: "rtl", script: "Arabic" } })).rejects.toThrow("four-letter");
		await expect(
			renderProjectFontText(arabicFont, {
				...options,
				shaping: {
					direction: "rtl",
					features: [
						{ tag: "rlig", value: 1 },
						{ tag: "rlig", value: 0 },
					],
				},
			})
		).rejects.toThrow("must be unique");
	});

	test("resolves mixed Latin, Arabic, and numeric visual runs before HarfBuzz shaping", async () => {
		const arabicFont = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(import.meta.dirname, "../fixtures/fonts/Amiri-Regular.ttf"), arabicFont);
		const options = {
			text: "ABC سلام 123 DEF",
			width: 320,
			height: 80,
			fontSize: 42,
			lineHeight: null,
			tracking: 0,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
			color: [245, 220, 60, 255] as [number, number, number, number],
			shaping: { direction: "ltr" as const, language: "ar", bidirectional: true },
		};
		const first = await renderProjectFontText(arabicFont, options);
		const second = await renderProjectFontText(arabicFont, options);
		expect(first).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-bidi-text-raster-v1",
			lineCount: 1,
			shaping: {
				engine: "harfbuzz",
				version: "14.2.1",
				direction: "ltr",
				script: null,
				language: "ar",
				bidirectional: {
					engine: "bidi-js",
					version: "1.0.3",
					unicodeVersion: "13.0.0",
					executionModel: "bounded-uax9-bidi-runs-v1",
					baseDirection: "ltr",
					paragraphCount: 1,
					codePointCount: 16,
					controlCount: 0,
					visualRuns: [
						{ visualIndex: 0, logicalStart: 0, logicalLength: 4, embeddingLevel: 0, direction: "ltr", sourceStyleRunIndex: 0 },
						{ visualIndex: 1, logicalStart: 9, logicalLength: 3, embeddingLevel: 2, direction: "ltr", sourceStyleRunIndex: 0 },
						{ visualIndex: 2, logicalStart: 4, logicalLength: 5, embeddingLevel: 1, direction: "rtl", sourceStyleRunIndex: 0 },
						{ visualIndex: 3, logicalStart: 12, logicalLength: 4, embeddingLevel: 0, direction: "ltr", sourceStyleRunIndex: 0 },
					],
				},
			},
		});
		expect(first.pixels).toEqual(second.pixels);
		expect(first.shapedGlyphs.every((glyph) => glyph.glyphId > 0)).toBe(true);
		expect(first.inkBounds).not.toBeNull();
		const fontBytes = await readFile(arabicFont);
		const styled = await renderProjectFontTextStyleRuns({
			runs: [
				{
					text: "ABC ",
					fontPath: arabicFont,
					fontBytes,
					fontSize: 42,
					tracking: 0,
					color: [240, 40, 30, 255],
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: "Amiri Regular",
					fauxBold: false,
					fauxItalic: false,
				},
				{
					text: "سلام 123",
					fontPath: arabicFont,
					fontBytes,
					fontSize: 42,
					tracking: 0,
					color: [30, 100, 240, 255],
					sourceStyleRunIndex: 1,
					fontIndex: 0,
					fontName: "Amiri Regular",
					fauxBold: true,
					fauxItalic: false,
				},
				{
					text: " DEF",
					fontPath: arabicFont,
					fontBytes,
					fontSize: 42,
					tracking: 0,
					color: [240, 40, 30, 255],
					sourceStyleRunIndex: 2,
					fontIndex: 0,
					fontName: "Amiri Regular",
					fauxBold: false,
					fauxItalic: false,
				},
			],
			width: 320,
			height: 80,
			lineHeight: null,
			justification: "left",
			offsetX: 2,
			offsetY: 2,
			shaping: options.shaping,
		});
		expect(styled.executionModel).toBe("bounded-project-font-harfbuzz-bidi-style-runs-v1");
		expect(styled.shaping!.bidirectional!.visualRuns.map((run) => run.sourceStyleRunIndex)).toEqual([0, 1, 1, 2]);
		expect(styled.styleRuns.map((run) => run.glyphCount)).toEqual([3, 7, 3]);
		const controlled = await renderProjectFontText(arabicFont, {
			...options,
			text: "A\r\n\u2067(سلام)\u2069 \u{1ee00}",
			height: 160,
			shaping: { direction: "rtl", language: "ar", bidirectional: true },
		});
		expect(controlled).toMatchObject({
			lineCount: 2,
			shaping: {
				bidirectional: {
					baseDirection: "rtl",
					paragraphCount: 2,
					codePointCount: 11,
					controlCount: 2,
					mirroredCharacterCount: 2,
				},
			},
		});
		expect(controlled.shapedGlyphs.some((glyph) => glyph.cluster === 12 && glyph.glyphId === 1062)).toBe(true);
		expect(controlled.shapedGlyphs.some((glyph) => glyph.cluster === 13)).toBe(false);
		expect(controlled.shapedGlyphs.find((glyph) => glyph.cluster === 4)?.glyphId).toBe(4);
		expect(controlled.shapedGlyphs.find((glyph) => glyph.cluster === 9)?.glyphId).toBe(3);
		expect(controlled.shaping!.bidirectional!.visualRuns.some((run) => run.logicalStart <= 12 && run.logicalStart + run.logicalLength >= 14)).toBe(true);
		const uniformRtl = await renderProjectFontText(arabicFont, { ...options, shaping: { direction: "rtl", language: "ar" } });
		expect(uniformRtl.executionModel).toBe("bounded-project-font-harfbuzz-text-raster-v1");
		expect(uniformRtl.pixels).not.toEqual(first.pixels);
		await expect(renderProjectFontText(arabicFont, { ...options, shaping: { direction: "ltr", bidirectional: "yes" as never } })).rejects.toThrow("must be a Boolean");
	});

	test("preserves Arabic joining and cluster-owned styles across matching-font style boundaries", async () => {
		const arabicFont = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(import.meta.dirname, "../fixtures/fonts/Amiri-Regular.ttf"), arabicFont);
		const fontBytes = await readFile(arabicFont);
		const runs = [
			{
				text: "سل",
				fontPath: arabicFont,
				fontBytes,
				fontSize: 48,
				tracking: 0,
				color: [240, 40, 30, 255] as [number, number, number, number],
				sourceStyleRunIndex: 0,
				fontIndex: 0,
				fontName: "Amiri Regular",
				fauxBold: false,
				fauxItalic: false,
			},
			{
				text: "ام",
				fontPath: arabicFont,
				fontBytes,
				fontSize: 48,
				tracking: 0,
				color: [30, 100, 240, 255] as [number, number, number, number],
				sourceStyleRunIndex: 1,
				fontIndex: 0,
				fontName: "Amiri Regular",
				fauxBold: false,
				fauxItalic: false,
			},
		];
		const base = {
			runs,
			width: 180,
			height: 80,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
		};
		const isolated = await renderProjectFontTextStyleRuns({ ...base, shaping: { direction: "rtl", script: "Arab", language: "ar" } });
		const joined = await renderProjectFontTextStyleRuns({
			...base,
			shaping: { direction: "rtl", script: "Arab", language: "ar", joinAcrossStyleRuns: true },
		});
		const uniform = await renderProjectFontText(arabicFont, {
			text: "سلام",
			width: 180,
			height: 80,
			fontSize: 48,
			lineHeight: null,
			tracking: 0,
			justification: "left",
			offsetX: 2,
			offsetY: 2,
			color: [255, 255, 255, 255],
			shaping: { direction: "rtl", script: "Arab", language: "ar" },
		});
		expect(joined).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-cross-style-runs-v1",
			shaping: { styleBoundaryModel: "shared-font-cross-style-clusters-v1" },
			styleRuns: [{ glyphCount: 2 }, { glyphCount: 2 }],
		});
		const glyphByCluster = (glyphs: typeof joined.shapedGlyphs) =>
			[...glyphs].sort((left, right) => left.cluster - right.cluster).map((glyph) => [glyph.cluster, glyph.glyphId]);
		expect(glyphByCluster(joined.shapedGlyphs)).toEqual(glyphByCluster(uniform.shapedGlyphs));
		expect(glyphByCluster(isolated.shapedGlyphs)).not.toEqual(glyphByCluster(uniform.shapedGlyphs));
		const colors = Array.from({ length: joined.pixels.length / 4 }, (_, index) => [...joined.pixels.subarray(index * 4, index * 4 + 4)]).filter((color) => color[3] > 0);
		expect(colors.some((color) => color[0] === 240 && color[1] === 40 && color[2] === 30)).toBe(true);
		expect(colors.some((color) => color[0] === 30 && color[1] === 100 && color[2] === 240)).toBe(true);
		const latinFontBytes = await readFile(source);
		const latinRuns = [
			{ ...runs[0], text: "f", fontPath: source, fontBytes: latinFontBytes, fontName: "Geist Regular" },
			{ ...runs[1], text: "i", fontPath: source, fontBytes: latinFontBytes, fontName: "Geist Regular" },
		];
		const latinBase = { ...base, runs: latinRuns };
		const isolatedLigature = await renderProjectFontTextStyleRuns({
			...latinBase,
			shaping: { direction: "ltr", script: "Latn", features: [{ tag: "liga", value: 1 }] },
		});
		const joinedLigature = await renderProjectFontTextStyleRuns({
			...latinBase,
			shaping: { direction: "ltr", script: "Latn", features: [{ tag: "liga", value: 1 }], joinAcrossStyleRuns: true },
		});
		expect(isolatedLigature.shapedGlyphs).toHaveLength(2);
		expect(joinedLigature.shapedGlyphs).toHaveLength(1);
		expect(joinedLigature.styleRuns.map((run) => run.glyphCount)).toEqual([1, 0]);
		expect(joinedLigature.shapedGlyphs[0].cluster).toBe(0);
		const bidi = await renderProjectFontTextStyleRuns({
			...base,
			shaping: { direction: "rtl", script: "Arab", language: "ar", bidirectional: true, joinAcrossStyleRuns: true },
		});
		expect(bidi.executionModel).toBe("bounded-project-font-harfbuzz-bidi-cross-style-runs-v1");
		expect(bidi.shaping!.bidirectional!.visualRuns).toEqual([expect.objectContaining({ sourceStyleRunIndices: [0, 1], crossStyle: true, glyphCount: 4 })]);
		await expect(renderProjectFontTextStyleRuns({ ...base, shaping: { direction: "rtl", joinAcrossStyleRuns: "yes" as never } })).rejects.toThrow("must be a Boolean");
	});

	test("applies authored Photoshop Language to HarfBuzz localized forms and run boundaries", async () => {
		const localizedFont = join(directory, "assets", "Geist-Locl-Test.ttf");
		const fontBytes = Buffer.from((await readFile(localizedFormsFixture, "utf-8")).trim(), "base64");
		await writeFile(localizedFont, fontBytes);
		const makeRun = (language: number | null, sourceStyleRunIndex = 0) => ({
			text: "A",
			fontPath: localizedFont,
			fontBytes,
			fontSize: 48,
			tracking: 0,
			color: [255, 255, 255, 255] as [number, number, number, number],
			sourceStyleRunIndex,
			fontIndex: 0,
			fontName: "Geist Locl Test",
			fauxBold: false,
			fauxItalic: false,
			language,
		});
		const base = {
			width: 160,
			height: 80,
			lineHeight: null,
			justification: "left" as const,
			offsetX: 2,
			offsetY: 2,
		};
		const english = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(0)] });
		const german = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(6)], shaping: { direction: "ltr", script: "Latn", language: "en" } });
		expect(english.executionModel).toBe("bounded-project-font-harfbuzz-style-runs-v1");
		expect(german).toMatchObject({
			shaping: { language: "en" },
			styleRuns: [
				{
					photoshopLanguageIndex: 6,
					photoshopLanguage: "de-DE-1996",
					effectiveShapingLanguage: "de-DE-1996",
					languageSource: "authored",
					languageExecutionModel: "bounded-authored-photoshop-language-v1",
				},
			],
		});
		expect(german.shapedGlyphs[0].glyphId).not.toBe(english.shapedGlyphs[0].glyphId);
		expect(german.pixels).not.toEqual(english.pixels);

		const requestLanguage = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(null)], shaping: { direction: "ltr", script: "Latn", language: "en" } });
		expect(requestLanguage.styleRuns[0]).toMatchObject({
			photoshopLanguageIndex: null,
			photoshopLanguage: null,
			effectiveShapingLanguage: "en",
			languageSource: "request",
			languageExecutionModel: "disabled",
		});

		const separatedLanguages = await renderProjectFontTextStyleRuns({
			...base,
			runs: [makeRun(0), makeRun(6, 1)],
			shaping: { direction: "ltr", script: "Latn", language: "en", joinAcrossStyleRuns: true },
		});
		expect(separatedLanguages.shapedGlyphs).toHaveLength(2);
		expect(separatedLanguages.styleRuns.map((run) => run.effectiveShapingLanguage)).toEqual(["en-US", "de-DE-1996"]);
		expect(separatedLanguages.shapedGlyphs[0].glyphId).not.toBe(separatedLanguages.shapedGlyphs[1].glyphId);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun(999)] })).rejects.toThrow("PSD authored language does not support Photoshop language index 999.");
	});

	test("executes bounded authored fill and centered MSDF stroke paint in both raster paths", async () => {
		const fontBytes = await readFile(source);
		type StyleRun = Parameters<typeof renderProjectFontTextStyleRuns>[0]["runs"][number];
		const makeRun = (overrides: Partial<StyleRun> = {}): StyleRun => ({
			text: "O",
			fontPath: source,
			fontBytes,
			fontSize: 64,
			tracking: 0,
			color: [240, 30, 20, 255] as [number, number, number, number],
			strokeColor: [20, 80, 240, 255] as [number, number, number, number],
			fillEnabled: true,
			strokeEnabled: true,
			fillFirst: true,
			outlineWidth: 8,
			sourceStyleRunIndex: 0,
			fontIndex: 0,
			fontName: "Geist Regular",
			fauxBold: false,
			fauxItalic: false,
			...overrides,
		});
		const base = { width: 120, height: 100, lineHeight: null, justification: "left" as const, offsetX: 16, offsetY: 8 };
		const fillOnly = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ strokeEnabled: false })] });
		const strokeOnly = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ fillEnabled: false })] });
		const fillThenStroke = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun()] });
		const strokeThenFill = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ fillFirst: false })] });
		const disabled = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ fillEnabled: false, strokeEnabled: false })] });

		expect(fillOnly.styleRuns[0]).toMatchObject({
			fillEnabled: true,
			strokeEnabled: false,
			fillFirst: true,
			outlineWidth: 8,
			strokeColor: [20, 80, 240, 255],
			strokePixelCount: 0,
			textPaintExecutionModel: "bounded-authored-text-fill-stroke-v1",
			strokeRasterModel: "disabled",
		});
		expect(fillOnly.styleRuns[0].fillPixelCount).toBeGreaterThan(0);
		expect(strokeOnly.styleRuns[0].fillPixelCount).toBe(0);
		expect(strokeOnly.styleRuns[0].strokePixelCount).toBeGreaterThan(0);
		expect(strokeOnly.styleRuns[0].strokeRasterModel).toBe("bounded-msdf-centered-outline-v1");
		expect(fillThenStroke.pixels).not.toEqual(strokeThenFill.pixels);
		expect(disabled.pixels.every((value, index) => index % 4 !== 3 || value === 0)).toBe(true);

		const shaped = await renderProjectFontTextStyleRuns({ ...base, runs: [makeRun()], shaping: { direction: "ltr" } });
		expect(shaped.styleRuns[0]).toMatchObject({
			fillPixelCount: expect.any(Number),
			strokePixelCount: expect.any(Number),
			strokeRasterModel: "bounded-msdf-centered-outline-v1",
		});
		expect(shaped.styleRuns[0].fillPixelCount).toBeGreaterThan(0);
		expect(shaped.styleRuns[0].strokePixelCount).toBeGreaterThan(0);
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ strokeColor: undefined })] })).rejects.toThrow("requires an exact strokeColor");
		await expect(renderProjectFontTextStyleRuns({ ...base, runs: [makeRun({ outlineWidth: 129 })] })).rejects.toThrow("outlineWidth must be null or between 0 and 128");
	});
});

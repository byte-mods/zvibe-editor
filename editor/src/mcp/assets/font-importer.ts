import { createHash } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";
import { constants as vmConstants, runInThisContext } from "vm";
import { copyFile, ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";

import sharp from "sharp";
import type { Glyph, Msdfgen as MsdfgenInstance } from "msdfgen-wasm";
import { hyphenateSync as hyphenateDanish } from "hyphen/da";
import { hyphenateSync as hyphenateGermanTraditional } from "hyphen/de-1901";
import { hyphenateSync as hyphenateGerman } from "hyphen/de-1996";
import { hyphenateSync as hyphenateSwissGerman } from "hyphen/de-ch-1901";
import { hyphenateSync as hyphenateEnglishGb } from "hyphen/en-gb";
import { hyphenateSync as hyphenateEnglishUs } from "hyphen/en-us";
import { hyphenateSync as hyphenateSpanish } from "hyphen/es";
import { hyphenateSync as hyphenateFinnish } from "hyphen/fi";
import { hyphenateSync as hyphenateFrench } from "hyphen/fr";
import { hyphenateSync as hyphenateItalian } from "hyphen/it";
import { hyphenateSync as hyphenateDutch } from "hyphen/nl";
import { hyphenateSync as hyphenateNorwegianNynorsk } from "hyphen/nn";
import { hyphenateSync as hyphenateNorwegian } from "hyphen/no";
import { hyphenateSync as hyphenatePortuguese } from "hyphen/pt";
import { hyphenateSync as hyphenateSwedish } from "hyphen/sv";
import unicodeVerticalOrientationTr from "@unicode/unicode-13.0.0/Vertical_Orientation/Tr/regex";
import unicodeVerticalOrientationTu from "@unicode/unicode-13.0.0/Vertical_Orientation/Tu/regex";
import unicodeVerticalOrientationU from "@unicode/unicode-13.0.0/Vertical_Orientation/U/regex";
import {
	getFontImporterCodepoints,
	IFontAtlasCharacter,
	IFontAtlasKerning,
	IFontAtlasManifest,
	IFontAtlasPage,
	IFontImporterSettings,
	IFontImportResult,
	normalizeFontImporterSettings,
	validateFontImporterSource,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { readAssetMetadata } from "./registry";

const { Msdfgen } = require("msdfgen-wasm") as typeof import("msdfgen-wasm");

interface IBidiEmbeddingLevels {
	levels: Uint8Array;
	paragraphs: Array<{ start: number; end: number; level: number }>;
}

interface IBidiApi {
	getBidiCharTypeName(character: string): string;
	getEmbeddingLevels(text: string, baseDirection: "ltr" | "rtl"): IBidiEmbeddingLevels;
	getReorderSegments(text: string, embeddingLevels: IBidiEmbeddingLevels, start?: number, end?: number): number[][];
	getMirroredCharactersMap(text: string, embeddingLevels: Uint8Array, start?: number, end?: number): Map<number, string>;
}

const bidi = (require("bidi-js") as () => IBidiApi)();
const bidiVersion = (require("bidi-js/package.json") as { version: string }).version;

/** Returns the exact Unicode 13 Vertical_Orientation class used by the PSD vertical-layout renderer. */
export function projectFontUnicodeVerticalOrientation(character: string): ProjectFontUnicodeVerticalOrientation {
	if (Array.from(character).length !== 1) {
		throw new Error("Unicode Vertical_Orientation classification requires exactly one Unicode scalar value.");
	}
	if (unicodeVerticalOrientationU.test(character)) {
		return "U";
	}
	if (unicodeVerticalOrientationTu.test(character)) {
		return "Tu";
	}
	return unicodeVerticalOrientationTr.test(character) ? "Tr" : "R";
}

type HarfBuzzApi = typeof import("harfbuzzjs");
type InternalGlyph = Glyph & { _ptr: number };
interface IMsdfgenInternal {
	_module: {
		HEAPF64: Float64Array;
		HEAPU32: Uint32Array;
		_loadGlyph(glyphIndex: number, output: number, preprocess: number): number;
		_destroyGlyph(pointer: number): void;
	};
	_tmp: number;
	_glyphs: InternalGlyph[] | null;
	_glyphMap: Map<number, InternalGlyph> | null;
}

let harfBuzzPromise: Promise<HarfBuzzApi> | null = null;

function getHarfBuzz(): Promise<HarfBuzzApi> {
	// TypeScript emits CommonJS here, while harfbuzzjs is async ESM/WASM. The main-context loader preserves a native fixed-specifier import in Electron and Vitest.
	harfBuzzPromise ??= runInThisContext('import("harfbuzzjs")', {
		filename: "babylonjs-editor-harfbuzz-loader.mjs",
		importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
	}) as Promise<HarfBuzzApi>;
	return harfBuzzPromise;
}

export function normalizeProjectFontTextShaping(options: IProjectFontTextShapingOptions): Required<Omit<IProjectFontTextShapingOptions, "script" | "language">> & {
	script: string | null;
	language: string | null;
} {
	if (!options || (options.direction !== "ltr" && options.direction !== "rtl")) {
		throw new Error("PSD complex-text shaping direction must be ltr or rtl.");
	}
	const script = options.script?.trim() || null;
	if (script !== null && !/^[A-Za-z]{4}$/.test(script)) {
		throw new Error("PSD complex-text shaping script must be a four-letter ISO 15924/OpenType script tag.");
	}
	const language = options.language?.trim() || null;
	if (language !== null && (language.length > 35 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(language))) {
		throw new Error("PSD complex-text shaping language must be a valid 1-35 character BCP 47 language tag.");
	}
	const features = options.features ?? [];
	if (!Array.isArray(features) || features.length > 32) {
		throw new Error("PSD complex-text shaping supports at most 32 OpenType features.");
	}
	const normalizedFeatures = features.map((feature, index) => {
		if (!feature || typeof feature.tag !== "string" || !/^[\x20-\x7E]{4}$/.test(feature.tag)) {
			throw new Error(`PSD complex-text shaping feature ${index} requires an exact four-character ASCII tag.`);
		}
		if (!Number.isSafeInteger(feature.value) || feature.value < 0 || feature.value > 65_535) {
			throw new Error(`PSD complex-text shaping feature ${index} value must be an integer between 0 and 65,535.`);
		}
		return { tag: feature.tag, value: feature.value };
	});
	if (new Set(normalizedFeatures.map((feature) => feature.tag)).size !== normalizedFeatures.length) {
		throw new Error("PSD complex-text shaping feature tags must be unique.");
	}
	if (options.bidirectional !== undefined && typeof options.bidirectional !== "boolean") {
		throw new Error("PSD complex-text bidirectional shaping must be a Boolean when provided.");
	}
	if (options.joinAcrossStyleRuns !== undefined && typeof options.joinAcrossStyleRuns !== "boolean") {
		throw new Error("PSD complex-text cross-style joining must be a Boolean when provided.");
	}
	return {
		direction: options.direction,
		script,
		language,
		features: normalizedFeatures,
		bidirectional: options.bidirectional ?? false,
		joinAcrossStyleRuns: options.joinAcrossStyleRuns ?? false,
	};
}

function loadExactGlyphIds(generator: MsdfgenInstance, glyphIds: number[]): Map<number, Glyph> {
	const internal = generator as unknown as IMsdfgenInternal;
	if (!internal._module || typeof internal._module._loadGlyph !== "function" || typeof internal._module._destroyGlyph !== "function" || !Number.isSafeInteger(internal._tmp)) {
		throw new Error("Installed MSDF rasterizer does not expose the exact glyph-ID bridge required for complex text shaping.");
	}
	if (internal._glyphs) {
		for (const glyph of internal._glyphs) {
			internal._module._destroyGlyph(glyph._ptr);
		}
	}
	internal._glyphs = [];
	internal._glyphMap = new Map();
	const metrics = internal._module.HEAPF64.subarray((internal._tmp + 8) / 8);
	for (const glyphId of glyphIds) {
		const errorCode = internal._module._loadGlyph(glyphId, internal._tmp, 1);
		if (errorCode !== 0) {
			throw new Error(`MSDF rasterizer could not load shaped glyph ID ${glyphId} (error ${errorCode}).`);
		}
		const glyph: InternalGlyph = {
			index: glyphId,
			unicode: glyphId,
			advance: metrics[0],
			left: metrics[1],
			bottom: metrics[2],
			right: metrics[3],
			top: metrics[4],
			kerning: [],
			_ptr: internal._module.HEAPU32[internal._tmp / 4],
		};
		internal._glyphs.push(glyph);
		internal._glyphMap.set(glyphId, glyph);
	}
	return new Map(internal._glyphs.map((glyph) => [glyph.index, glyph]));
}

export interface IFontImporterArtifactStatus {
	path: string;
	artifactDirectory: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IFontImportResult | null;
}

export interface IProjectFontTextRenderOptions {
	text: string;
	width: number;
	height: number;
	orientation?: "horizontal" | "vertical";
	fontSize: number;
	lineHeight: number | null;
	tracking: number;
	justification: "left" | "center" | "right";
	offsetX: number;
	offsetY: number;
	color: [number, number, number, number];
	shaping?: IProjectFontTextShapingOptions;
}

export interface IProjectFontTextShapingFeature {
	tag: string;
	value: number;
}

export interface IProjectFontTextShapingOptions {
	direction: "ltr" | "rtl";
	script?: string | null;
	language?: string | null;
	features?: IProjectFontTextShapingFeature[];
	bidirectional?: boolean;
	joinAcrossStyleRuns?: boolean;
}

export interface IProjectFontShapedGlyphEvidence {
	glyphId: number;
	cluster: number;
	flags: number;
	xAdvance: number;
	yAdvance: number;
	xOffset: number;
	yOffset: number;
}

export interface IProjectFontBidiVisualRunEvidence {
	lineIndex: number;
	visualIndex: number;
	logicalStart: number;
	logicalLength: number;
	embeddingLevel: number;
	direction: "ltr" | "rtl";
	sourceStyleRunIndex: number;
	sourceStyleRunIndices: number[];
	crossStyle: boolean;
	glyphCount: number;
}

export interface IProjectFontBidiEvidence {
	engine: "bidi-js";
	version: string;
	unicodeVersion: "13.0.0";
	executionModel: "bounded-uax9-bidi-runs-v1";
	baseDirection: "ltr" | "rtl";
	paragraphCount: number;
	codePointCount: number;
	controlCount: number;
	mirroredCharacterCount: number;
	visualRuns: IProjectFontBidiVisualRunEvidence[];
}

export interface IProjectFontTextShapingEvidence {
	engine: "harfbuzz";
	version: string;
	direction: "ltr" | "rtl";
	script: string | null;
	language: string | null;
	features: IProjectFontTextShapingFeature[];
	styleBoundaryModel: "isolated-font-style-runs-v1" | "shared-font-cross-style-clusters-v1";
	bidirectional: IProjectFontBidiEvidence | null;
}

export interface IProjectFontTextRenderResult {
	pixels: Uint8Array;
	orientation: "horizontal" | "vertical";
	lineCount: number;
	glyphCount: number;
	uniqueGlyphCount: number;
	lineHeight: number;
	inkBounds: { left: number; top: number; right: number; bottom: number } | null;
	clippedPixelCount: number;
	shaping: IProjectFontTextShapingEvidence | null;
	shapedGlyphs: IProjectFontShapedGlyphEvidence[];
	executionModel:
		| "bounded-project-font-text-raster-v1"
		| "bounded-project-font-harfbuzz-text-raster-v1"
		| "bounded-project-font-harfbuzz-bidi-text-raster-v1"
		| "bounded-project-font-harfbuzz-vertical-text-raster-v1"
		| "bounded-project-font-harfbuzz-bidi-vertical-text-raster-v1";
}

export interface IProjectFontTextStyleRunOptions {
	text: string;
	fontPath: string;
	fontBytes: Uint8Array;
	fontSize: number;
	tracking: number;
	autoLeading?: boolean | null;
	leading?: number | null;
	kerning?: number | null;
	autoKerning?: boolean | null;
	ligatures?: boolean | null;
	discretionaryLigatures?: boolean | null;
	color: [number, number, number, number];
	strokeColor?: [number, number, number, number] | null;
	fillEnabled?: boolean | null;
	strokeEnabled?: boolean | null;
	fillFirst?: boolean | null;
	outlineWidth?: number | null;
	sourceStyleRunIndex: number;
	fontIndex: number;
	fontName: string | null;
	language?: number | null;
	fauxBold: boolean;
	fauxItalic: boolean;
	fontCaps?: "normal" | "small-caps" | "all-caps" | null;
	smallCapScale?: number;
	fontBaseline?: "normal" | "superscript" | "subscript" | null;
	fontBaselineScale?: number;
	fontBaselinePosition?: number;
	baselineDirection?: ProjectFontBaselineDirection | null;
	proportionalMetrics?: boolean | null;
	kana?: boolean | null;
	ruby?: boolean | null;
	japaneseAlternateFeature?: ProjectFontJapaneseAlternateFeature | null;
	fractions?: boolean | null;
	ordinals?: boolean | null;
	stylisticAlternates?: boolean | null;
	oldStyle?: boolean | null;
	swash?: boolean | null;
	titling?: boolean | null;
	ornaments?: boolean | null;
	slashedZero?: boolean | null;
	connectionForms?: boolean | null;
	contextualLigatures?: boolean | null;
	hindiNumbers?: boolean | null;
	kashida?: boolean | null;
	diacriticPosition?: ProjectFontDiacriticPosition | null;
	characterDirection?: ProjectFontCharacterDirection | null;
	figureStyle?: ProjectFontFigureStyle | null;
	engineData2StyleRunIndex?: number | null;
	wariChuEnabled?: boolean | null;
	wariChuLineCount?: number | null;
	wariChuLineGap?: number | null;
	wariChuScale?: number | null;
	wariChuWidow?: number | null;
	wariChuOrphan?: number | null;
	wariChuJustification?: ProjectFontWariChuJustification | null;
	tsume?: number | null;
	styleRunAlignment?: ProjectFontStyleRunAlignment | null;
	horizontalScale?: number;
	verticalScale?: number;
	baselineShift?: number;
	underline?: boolean;
	strikethrough?: boolean;
	noBreak?: boolean;
}

export type ProjectFontStyleRunAlignment = "em-box-bottom-left" | "icf-bottom-left" | "em-box-center" | "roman-baseline" | "icf-top-right" | "em-box-top-right";
export type ProjectFontBaselineDirection = "upright" | "mixed" | "tate-chu-yoko";
export type ProjectFontJapaneseAlternateFeature = "normal" | "traditional" | "expert" | "jis78";
export type ProjectFontJapaneseAlternateFeatureTag = "trad" | "expt" | "jp78";
export type ProjectFontFigureStyle = "default" | "tabular-lining" | "proportional-oldstyle" | "proportional-lining" | "tabular-oldstyle";
export type ProjectFontCharacterDirection = "default" | "left-to-right" | "right-to-left";
export type ProjectFontDiacriticPosition = "opentype" | "loose" | "medium" | "tight";
export type ProjectFontWariChuJustification = "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all" | "auto";
export type ProjectFontUnicodeVerticalOrientation = "U" | "Tu" | "R" | "Tr";

export interface IOpenTypeBaseAlignmentMetrics {
	script: string;
	defaultBaselineTag: string;
	coordinates: Partial<Record<"icfb" | "icft" | "romn", { value: number; format: 1 | 2 | 3 }>>;
}

export interface IProjectFontTextParagraphRunOptions {
	sourceParagraphRunIndex: number;
	start: number;
	length: number;
	justification: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all";
	firstLineIndent: number;
	startIndent: number;
	endIndent: number;
	spaceBefore: number;
	spaceAfter: number;
	autoHyphenate: boolean;
	hyphenatedWordSize: number;
	preHyphen: number;
	postHyphen: number;
	consecutiveHyphens: number;
	hyphenationZone: number;
	autoLeading: number | null;
	everyLineComposer: boolean;
}

export interface IProjectFontTextParagraphRunEvidence extends IProjectFontTextParagraphRunOptions {
	lineIndices: number[];
	lineCount: number;
	appliedLineHeight: number;
	lineHeights: number[];
	lineHeightSources: ProjectFontLineHeightSource[];
	lineHeightSource: ProjectFontLineHeightSource;
	lineBreakModel: "authored-paragraph-breaks-v1" | "bounded-authored-box-wrap-v1" | "bounded-authored-box-hyphenation-v1";
	hyphenatedLineCount: number;
	insertedHyphenCount: number;
	hyphenationLanguages: string[];
	hyphenationExecutionModel: "disabled" | "bounded-liang-pattern-hyphenation-v1";
	composerExecutionModel: "bounded-single-line-composer-v1" | "bounded-every-line-composer-v1";
	executionModel: "bounded-authored-paragraph-run-layout-v1";
}

export interface IProjectFontTextBoxLayoutOptions {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface IProjectFontTextBoxLayoutEvidence extends IProjectFontTextBoxLayoutOptions {
	authoredLineCount: number;
	composedLineCount: number;
	softBreakCount: number;
	overflowLineCount: number;
	hyphenatedLineCount: number;
	insertedHyphenCount: number;
	hyphenationLanguages: string[];
	noBreakRunCount: number;
	noBreakPreventedBreakCount: number;
	noBreakExecutionModel: "disabled" | "bounded-authored-no-break-v1";
	wrapModel: "bounded-whitespace-cluster-wrap-v1" | "bounded-dictionary-hyphenation-wrap-v1";
	composerModel: "bounded-single-line-composer-v1" | "bounded-every-line-composer-v1" | "mixed-authored-composers-v1";
	lines: Array<{
		lineIndex: number;
		logicalStart: number;
		logicalEnd: number;
		advance: number;
		available: number;
		lineHeight: number;
		lineHeightSource: ProjectFontLineHeightSource;
		leadingSourceStyleRunIndices: number[];
		softWrapped: boolean;
		insertedHyphen: boolean;
		hyphenationLanguage: string | null;
		overflow: boolean;
	}>;
	executionModel: "bounded-authored-box-text-layout-v1";
}

export interface IProjectFontTextStyleRunsOptions {
	runs: IProjectFontTextStyleRunOptions[];
	paragraphRuns?: IProjectFontTextParagraphRunOptions[];
	boxLayout?: IProjectFontTextBoxLayoutOptions;
	width: number;
	height: number;
	orientation?: "horizontal" | "vertical";
	lineHeight: number | null;
	justification: "left" | "center" | "right";
	offsetX: number;
	offsetY: number;
	shaping?: IProjectFontTextShapingOptions;
}

export interface IProjectFontTextStyleRunRenderEvidence extends Omit<
	IProjectFontTextStyleRunOptions,
	| "text"
	| "fontBytes"
	| "horizontalScale"
	| "verticalScale"
	| "baselineShift"
	| "underline"
	| "strikethrough"
	| "noBreak"
	| "kerning"
	| "autoLeading"
	| "leading"
	| "autoKerning"
	| "ligatures"
	| "discretionaryLigatures"
	| "strokeColor"
	| "fillEnabled"
	| "strokeEnabled"
	| "fillFirst"
	| "outlineWidth"
	| "fontCaps"
	| "smallCapScale"
	| "fontBaseline"
	| "fontBaselineScale"
	| "fontBaselinePosition"
	| "baselineDirection"
	| "language"
	| "wariChuEnabled"
	| "wariChuLineCount"
	| "wariChuLineGap"
	| "wariChuScale"
	| "wariChuWidow"
	| "wariChuOrphan"
	| "wariChuJustification"
	| "tsume"
	| "styleRunAlignment"
> {
	length: number;
	fillEnabled: boolean;
	strokeEnabled: boolean;
	strokeColor: [number, number, number, number] | null;
	fillFirst: boolean;
	outlineWidth: number;
	fillPixelCount: number;
	strokePixelCount: number;
	textPaintExecutionModel: "disabled" | "bounded-authored-text-fill-stroke-v1";
	strokeRasterModel: "disabled" | "bounded-msdf-centered-outline-v1";
	photoshopLanguageIndex: number | null;
	photoshopLanguage: string | null;
	effectiveShapingLanguage: string | null;
	languageSource: "authored" | "request" | "default";
	languageExecutionModel: "disabled" | "bounded-authored-photoshop-language-v1";
	glyphCount: number;
	fauxBoldPixels: number;
	fauxItalicShear: number;
	horizontalScale: number;
	verticalScale: number;
	baselineShift: number;
	underline: boolean;
	strikethrough: boolean;
	noBreak: boolean;
	noBreakExecutionModel: "disabled" | "bounded-authored-no-break-v1";
	autoLeading: boolean | null;
	leading: number | null;
	leadingAppliedLineIndices: number[];
	leadingAppliedLineHeights: number[];
	leadingExecutionModel: "disabled" | "bounded-authored-character-leading-v1";
	kerning: number | null;
	manualKerningBoundaryUtf16: number | null;
	manualKerningPixels: number;
	manualKerningAppliedBoundaryCount: number;
	manualKerningExecutionModel: "disabled" | "bounded-authored-manual-kerning-v1";
	autoKerning: boolean | null;
	ligatures: boolean | null;
	discretionaryLigatures: boolean | null;
	fontCaps: "normal" | "small-caps" | "all-caps" | null;
	smallCapScale: number;
	capsAppliedScale: number;
	capsAffectedCharacterCount: number;
	capsGlyphSource: "disabled" | "unicode-uppercase" | "opentype-smcp" | "faux-small-caps";
	capsExecutionModel: "disabled" | "bounded-authored-font-caps-v1";
	fontBaseline: "normal" | "superscript" | "subscript" | null;
	fontBaselineScale: number;
	fontBaselinePosition: number;
	fontBaselineAppliedScale: number;
	fontBaselineAppliedShift: number;
	fontBaselineEffectiveFeature: "sups" | "subs" | null;
	fontBaselineGlyphSource: "disabled" | "opentype-sups" | "opentype-subs" | "faux-superscript" | "faux-subscript";
	fontBaselineExecutionModel: "disabled" | "bounded-authored-font-baseline-v1";
	baselineDirection: ProjectFontBaselineDirection | null;
	baselineDirectionGlyphs: Array<{
		glyphId: number;
		cluster: number;
		lineIndex: number;
		unicodeVerticalOrientation: ProjectFontUnicodeVerticalOrientation | null;
		renderedOrientation: "upright" | "sideways-clockwise" | "tate-chu-yoko-horizontal" | "horizontal-no-op";
		shapingDirection: "ttb" | "ltr" | "rtl";
		rotationDegrees: 0 | 90;
	}>;
	tateChuYokoBlocks: Array<{
		lineIndex: number;
		logicalStart: number;
		logicalEnd: number;
		glyphCount: number;
		rawAdvance: number;
		fittedAdvance: number;
		cellAdvance: number;
		fitScale: number;
	}>;
	baselineDirectionExecutionModel: "disabled" | "horizontal-no-op" | "bounded-authored-baseline-direction-v1";
	proportionalMetrics: boolean | null;
	proportionalMetricsFeatureSupported: boolean;
	proportionalMetricsExecutionModel: "disabled" | "bounded-authored-proportional-metrics-v1";
	kana: boolean | null;
	kanaFeatureSupported: boolean;
	kanaExecutionModel: "disabled" | "bounded-authored-kana-v1";
	ruby: boolean | null;
	rubyFeatureSupported: boolean;
	rubyExecutionModel: "disabled" | "bounded-authored-ruby-v1";
	japaneseAlternateFeature: ProjectFontJapaneseAlternateFeature | null;
	japaneseAlternateFeatureTag: ProjectFontJapaneseAlternateFeatureTag | null;
	japaneseAlternateFeatureSupported: boolean;
	japaneseAlternateFeatureAvailableTags: ProjectFontJapaneseAlternateFeatureTag[];
	japaneseAlternateFeatureExecutionModel: "disabled" | "bounded-authored-japanese-alternate-feature-v1";
	fractions: boolean | null;
	fractionsFeatureSupported: boolean;
	ordinals: boolean | null;
	ordinalsFeatureSupported: boolean;
	stylisticAlternates: boolean | null;
	stylisticAlternatesFeatureSupported: boolean;
	oldStyle: boolean | null;
	oldStyleFeatureSupported: boolean;
	swash: boolean | null;
	swashFeatureSupported: boolean;
	titling: boolean | null;
	titlingFeatureSupported: boolean;
	ornaments: boolean | null;
	ornamentsFeatureSupported: boolean;
	slashedZero: boolean | null;
	slashedZeroFeatureSupported: boolean;
	characterOpenTypeExecutionModel: "disabled" | "bounded-authored-character-opentype-v1";
	connectionForms: boolean | null;
	connectionFormsFeatureSupported: boolean;
	connectionFormsExecutionModel: "disabled" | "bounded-authored-connection-forms-v1";
	contextualLigatures: boolean | null;
	contextualLigaturesFeatureSupported: boolean;
	contextualLigaturesExecutionModel: "disabled" | "bounded-authored-contextual-ligatures-v1";
	hindiNumbers: boolean | null;
	hindiNumbersAffectedCharacterCount: number;
	hindiNumbersEffectiveDigits: "default" | "arabic-western" | "hindi-arabic-indic";
	hindiNumbersExecutionModel: "disabled" | "bounded-authored-hindi-numbers-v1";
	kashida: boolean | null;
	kashidaEligibleJoinCount: number;
	kashidaInsertedCount: number;
	kashidaInsertedAdvance: number;
	kashidaExecutionModel: "disabled" | "inactive-not-fully-justified" | "bounded-authored-kashida-justification-v1";
	diacriticPosition: ProjectFontDiacriticPosition | null;
	diacriticAffectedGlyphCount: number;
	diacriticGlyphs: Array<{
		glyphId: number;
		cluster: number;
		placement: "above" | "below";
		authoredVerticalShift: number;
		originalXOffset: number;
		originalYOffset: number;
		effectiveXOffset: number;
		effectiveYOffset: number;
	}>;
	diacriticExecutionModel: "disabled" | "inactive-no-combining-diacritics" | "inactive-vertical-text" | "bounded-authored-diacritic-position-v1";
	characterDirection: ProjectFontCharacterDirection | null;
	characterDirectionOverrideCharacterCount: number;
	characterDirectionResolvedEmbeddingLevels: number[];
	characterDirectionExecutionModel: "disabled" | "bounded-authored-character-direction-v1";
	figureStyle: ProjectFontFigureStyle | null;
	figureStyleLiningFeatureSupported: boolean;
	figureStyleOldStyleFeatureSupported: boolean;
	figureStyleProportionalFeatureSupported: boolean;
	figureStyleTabularFeatureSupported: boolean;
	figureStyleExecutionModel: "disabled" | "bounded-authored-figure-style-v1";
	engineData2StyleRunIndex: number | null;
	engineData2ExecutionModel: "disabled" | "bounded-global-txt2-engine-data2-v1";
	stylisticOpenTypeExecutionModel: "disabled" | "bounded-authored-stylistic-opentype-v1";
	wariChuEnabled: boolean | null;
	wariChuLineCount: number;
	wariChuLineGap: number;
	wariChuScale: number;
	wariChuWidow: number;
	wariChuOrphan: number;
	wariChuJustification: ProjectFontWariChuJustification;
	wariChuBlocks: Array<{
		lineIndex: number;
		logicalStart: number;
		logicalEnd: number;
		cellAdvance: number;
		crossSpan: number;
		rows: Array<{
			rowIndex: number;
			logicalStart: number;
			logicalEnd: number;
			clusterCount: number;
			glyphCount: number;
			rawAdvance: number;
			alignedStart: number;
			extraClusterSpacing: number;
			resolvedJustification: "left" | "right" | "center" | "justify";
		}>;
	}>;
	wariChuExecutionModel: "disabled" | "bounded-authored-wari-chu-v1";
	tsume: number | null;
	tsumeAppliedGlyphCount: number;
	tsumeLeadingTrim: number;
	tsumeTrailingTrim: number;
	tsumeAdvanceReduction: number;
	tsumeGlyphs: Array<{
		glyphId: number;
		cluster: number;
		leadingTrim: number;
		trailingTrim: number;
		advanceBefore: number;
		advanceAfter: number;
	}>;
	tsumeExecutionModel: "disabled" | "bounded-authored-tsume-v1";
	styleRunAlignment: ProjectFontStyleRunAlignment | null;
	styleRunAlignmentGlyphs: Array<{
		glyphId: number;
		cluster: number;
		lineIndex: number;
		referenceSourceStyleRunIndex: number;
		referenceEmSize: number;
		glyphEmSize: number;
		referenceCoordinate: number;
		glyphCoordinate: number;
		appliedShift: number;
		metricSource: "em-box" | "roman-baseline" | "opentype-base";
		baseScript: string | null;
		referenceBaseScript: string | null;
		baseTag: "icfb" | "icft" | "romn" | null;
		baseCoordinateFormat: 1 | 2 | 3 | null;
		referenceBaseCoordinateFormat: 1 | 2 | 3 | null;
	}>;
	styleRunAlignmentExecutionModel: "disabled" | "bounded-authored-style-run-alignment-v1";
	effectiveOpenTypeFeatures: Array<{
		tag:
			| "kern"
			| "liga"
			| "dlig"
			| "palt"
			| "hkna"
			| "ruby"
			| "frac"
			| "ordn"
			| "salt"
			| "lnum"
			| "onum"
			| "pnum"
			| "tnum"
			| "swsh"
			| "titl"
			| "ornm"
			| "zero"
			| "calt"
			| "clig"
			| ProjectFontJapaneseAlternateFeatureTag;
		value: 0 | 1;
	}>;
	openTypeFeatureExecutionModel: "disabled" | "bounded-authored-opentype-features-v1";
	decorationThickness: number;
	characterStyleExecutionModel: "bounded-authored-character-style-v1";
	shapedGlyphs: IProjectFontShapedGlyphEvidence[];
}

export interface IProjectFontTextStyleRunsRenderResult extends Omit<IProjectFontTextRenderResult, "executionModel"> {
	pixels: Uint8Array;
	styleRuns: IProjectFontTextStyleRunRenderEvidence[];
	paragraphRuns: IProjectFontTextParagraphRunEvidence[];
	boxLayout: IProjectFontTextBoxLayoutEvidence | null;
	shaping: IProjectFontTextShapingEvidence | null;
	executionModel:
		| "bounded-project-font-text-style-runs-v1"
		| "bounded-project-font-harfbuzz-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-style-runs-v1"
		| "bounded-project-font-harfbuzz-cross-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1"
		| "bounded-project-font-harfbuzz-vertical-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-vertical-style-runs-v1"
		| "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-vertical-cross-style-runs-v1";
}

interface IProjectFontParagraphLineLayout {
	primaryStart: number;
	crossPosition: number;
	lineHeight: number;
	lineHeightSource: ProjectFontLineHeightSource;
	leadingRunIndices: number[];
	justification: IProjectFontTextParagraphRunOptions["justification"] | "left" | "center" | "right";
	extraWordSpacing: number;
}

type ProjectFontLineHeightSource = "request" | "authored-explicit-leading" | "authored-auto-leading" | "font-metrics";

interface IProjectFontResolvedLineHeight {
	lineHeight: number;
	source: ProjectFontLineHeightSource;
	leadingRunIndices: number[];
}

type ProjectFontAuthoredOpenTypeFeature = {
	tag:
		| "kern"
		| "liga"
		| "dlig"
		| "palt"
		| "hkna"
		| "ruby"
		| "frac"
		| "ordn"
		| "salt"
		| "lnum"
		| "onum"
		| "pnum"
		| "tnum"
		| "swsh"
		| "titl"
		| "ornm"
		| "zero"
		| "calt"
		| "clig"
		| ProjectFontJapaneseAlternateFeatureTag;
	value: 0 | 1;
};

const projectFontJapaneseAlternateFeatureTags: ProjectFontJapaneseAlternateFeatureTag[] = ["trad", "expt", "jp78"];

function projectFontJapaneseAlternateFeatureTag(feature: ProjectFontJapaneseAlternateFeature | null | undefined): ProjectFontJapaneseAlternateFeatureTag | null {
	return feature === "traditional" ? "trad" : feature === "expert" ? "expt" : feature === "jis78" ? "jp78" : null;
}

function projectFontAuthoredOpenTypeFeatures(run: IProjectFontTextStyleRunOptions): ProjectFontAuthoredOpenTypeFeature[] {
	const result: ProjectFontAuthoredOpenTypeFeature[] = [];
	if (run.autoKerning !== undefined && run.autoKerning !== null) {
		result.push({ tag: "kern", value: run.autoKerning ? 1 : 0 });
	}
	if (run.ligatures !== undefined && run.ligatures !== null) {
		result.push({ tag: "liga", value: run.ligatures ? 1 : 0 });
	}
	if (run.discretionaryLigatures !== undefined && run.discretionaryLigatures !== null) {
		result.push({ tag: "dlig", value: run.discretionaryLigatures ? 1 : 0 });
	}
	if (run.proportionalMetrics !== undefined && run.proportionalMetrics !== null) {
		result.push({ tag: "palt", value: run.proportionalMetrics ? 1 : 0 });
	}
	if (run.kana !== undefined && run.kana !== null) {
		result.push({ tag: "hkna", value: run.kana ? 1 : 0 });
	}
	if (run.ruby !== undefined && run.ruby !== null) {
		result.push({ tag: "ruby", value: run.ruby ? 1 : 0 });
	}
	if (run.japaneseAlternateFeature !== undefined && run.japaneseAlternateFeature !== null) {
		const selectedTag = projectFontJapaneseAlternateFeatureTag(run.japaneseAlternateFeature);
		result.push(...projectFontJapaneseAlternateFeatureTags.map((tag) => ({ tag, value: tag === selectedTag ? 1 : 0 }) as ProjectFontAuthoredOpenTypeFeature));
	}
	if (run.fractions !== undefined && run.fractions !== null) {
		result.push({ tag: "frac", value: run.fractions ? 1 : 0 });
	}
	if (run.ordinals !== undefined && run.ordinals !== null) {
		result.push({ tag: "ordn", value: run.ordinals ? 1 : 0 });
	}
	if (run.stylisticAlternates !== undefined && run.stylisticAlternates !== null) {
		result.push({ tag: "salt", value: run.stylisticAlternates ? 1 : 0 });
	}
	if (run.oldStyle !== undefined && run.oldStyle !== null) {
		result.push({ tag: "onum", value: run.oldStyle ? 1 : 0 });
	}
	if (run.swash !== undefined && run.swash !== null) {
		result.push({ tag: "swsh", value: run.swash ? 1 : 0 });
	}
	if (run.titling !== undefined && run.titling !== null) {
		result.push({ tag: "titl", value: run.titling ? 1 : 0 });
	}
	if (run.ornaments !== undefined && run.ornaments !== null) {
		result.push({ tag: "ornm", value: run.ornaments ? 1 : 0 });
	}
	if (run.slashedZero !== undefined && run.slashedZero !== null) {
		result.push({ tag: "zero", value: run.slashedZero ? 1 : 0 });
	}
	if (run.connectionForms !== undefined && run.connectionForms !== null) {
		result.push({ tag: "calt", value: run.connectionForms ? 1 : 0 });
	}
	if (run.contextualLigatures !== undefined && run.contextualLigatures !== null) {
		result.push({ tag: "clig", value: run.contextualLigatures ? 1 : 0 });
	}
	if (run.figureStyle !== undefined && run.figureStyle !== null) {
		const lining = run.figureStyle === "tabular-lining" || run.figureStyle === "proportional-lining";
		const oldStyle = run.figureStyle === "proportional-oldstyle" || run.figureStyle === "tabular-oldstyle";
		const proportional = run.figureStyle === "proportional-oldstyle" || run.figureStyle === "proportional-lining";
		const tabular = run.figureStyle === "tabular-lining" || run.figureStyle === "tabular-oldstyle";
		result.push(
			{ tag: "lnum", value: lining ? 1 : 0 },
			{ tag: "onum", value: oldStyle ? 1 : 0 },
			{ tag: "pnum", value: proportional ? 1 : 0 },
			{ tag: "tnum", value: tabular ? 1 : 0 }
		);
	}
	const effective = new Map<ProjectFontAuthoredOpenTypeFeature["tag"], 0 | 1>();
	for (const feature of result) {
		effective.set(feature.tag, feature.value);
	}
	return [...effective].map(([tag, value]) => ({ tag, value }));
}

function projectFontEffectiveOpenTypeFeatures(run: IProjectFontTextStyleRunOptions, globalFeatures: IProjectFontTextShapingFeature[]): Array<{ tag: string; value: number }> {
	const result = new Map(globalFeatures.map((feature) => [feature.tag, feature.value]));
	for (const feature of projectFontAuthoredOpenTypeFeatures(run)) {
		result.set(feature.tag, feature.value);
	}
	return [...result].map(([tag, value]) => ({ tag, value }));
}

function projectFontStyleRunStarts(runs: IProjectFontTextStyleRunOptions[]): number[] {
	const result: number[] = [];
	let offset = 0;
	for (const run of runs) {
		result.push(offset);
		offset += run.text.length;
	}
	return result;
}

function projectFontManualKerningOwnerRun(leftRunIndex: number, rightRunIndex: number, runs: IProjectFontTextStyleRunOptions[]): number | null {
	if (leftRunIndex === rightRunIndex || Math.abs(leftRunIndex - rightRunIndex) !== 1) {
		return null;
	}
	const ownerRunIndex = Math.max(leftRunIndex, rightRunIndex);
	return (runs[ownerRunIndex].kerning ?? 0) === 0 ? null : ownerRunIndex;
}

interface IProjectFontLogicalLine {
	text: string;
	logicalStart: number;
	logicalEnd: number;
	firstInParagraph: boolean;
	lastInParagraph: boolean;
	softWrapped: boolean;
	insertedHyphen: boolean;
	hyphenationLanguage: string | null;
}

type ProjectFontHyphenator = (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string;

interface IProjectFontPhotoshopLanguage {
	language: string;
	hyphenate: ProjectFontHyphenator;
}

const projectFontPhotoshopLanguages = new Map<number, IProjectFontPhotoshopLanguage>([
	[0, { language: "en-US", hyphenate: hyphenateEnglishUs }],
	[1, { language: "en-US", hyphenate: hyphenateEnglishUs }],
	[2, { language: "en-GB", hyphenate: hyphenateEnglishGb }],
	[3, { language: "fr", hyphenate: hyphenateFrench }],
	[4, { language: "fr-CA", hyphenate: hyphenateFrench }],
	[5, { language: "fi", hyphenate: hyphenateFinnish }],
	[6, { language: "de-DE-1996", hyphenate: hyphenateGerman }],
	[7, { language: "de-DE-1901", hyphenate: hyphenateGermanTraditional }],
	[8, { language: "de-CH-1901", hyphenate: hyphenateSwissGerman }],
	[9, { language: "it", hyphenate: hyphenateItalian }],
	[10, { language: "no", hyphenate: hyphenateNorwegian }],
	[11, { language: "nn", hyphenate: hyphenateNorwegianNynorsk }],
	[12, { language: "pt", hyphenate: hyphenatePortuguese }],
	[13, { language: "pt-BR", hyphenate: hyphenatePortuguese }],
	[14, { language: "es", hyphenate: hyphenateSpanish }],
	[15, { language: "sv", hyphenate: hyphenateSwedish }],
	[16, { language: "nl", hyphenate: hyphenateDutch }],
	[17, { language: "da", hyphenate: hyphenateDanish }],
]);

function projectFontPhotoshopLanguage(index: number): IProjectFontPhotoshopLanguage {
	const language = projectFontPhotoshopLanguages.get(index);
	if (!language) {
		throw new Error(`PSD authored language does not support Photoshop language index ${index}.`);
	}
	return language;
}

interface IProjectFontBoxBreakCandidate {
	logicalEnd: number;
	nextLogicalStart: number;
	insertedHyphen: boolean;
	hyphenRunIndex: number | null;
	hyphenationLanguage: string | null;
}

interface IProjectFontBoxCompositionOptions {
	fullText: string;
	authoredLine: IProjectFontLogicalLine;
	paragraphRun: IProjectFontTextParagraphRunOptions | undefined;
	styleRuns: IProjectFontTextStyleRunOptions[];
	primarySpan: (firstLine: boolean) => number;
	measure: (logicalStart: number, logicalEnd: number, hyphenRunIndex: number | null) => number;
	canBreakAt: (logicalOffset: number) => boolean;
	onNoBreakPreventedBreak?: () => void;
}

function projectFontStyleRunIndexAt(runs: IProjectFontTextStyleRunOptions[], logicalOffset: number): number {
	let start = 0;
	for (let index = 0; index < runs.length; ++index) {
		const end = start + runs[index].text.length;
		if (logicalOffset >= start && logicalOffset < end) {
			return index;
		}
		start = end;
	}
	return Math.max(0, runs.length - 1);
}

function resolveProjectFontLineHeights(
	options: IProjectFontTextStyleRunsOptions,
	logicalLines: IProjectFontLogicalLine[],
	naturalRunLineHeights: number[]
): IProjectFontResolvedLineHeight[] {
	if (naturalRunLineHeights.length !== options.runs.length || naturalRunLineHeights.some((value) => !Number.isFinite(value) || value <= 0)) {
		throw new Error("PSD character-leading layout requires one positive natural line height per style run.");
	}
	const starts = projectFontStyleRunStarts(options.runs);
	const fullTextLength = options.runs.reduce((length, run) => length + run.text.length, 0);
	return logicalLines.map((line) => {
		if (options.lineHeight !== null) {
			return { lineHeight: options.lineHeight, source: "request", leadingRunIndices: [] };
		}
		const paragraphRun =
			options.paragraphRuns?.find((run) => line.logicalStart >= run.start && line.logicalStart < run.start + run.length) ??
			options.paragraphRuns?.[options.paragraphRuns.length - 1];
		const overlappingRunIndices: number[] = [];
		for (let runIndex = 0; runIndex < options.runs.length; ++runIndex) {
			const start = starts[runIndex];
			const end = start + options.runs[runIndex].text.length;
			if (line.logicalStart === line.logicalEnd ? line.logicalStart >= start && line.logicalStart <= end : start < line.logicalEnd && end > line.logicalStart) {
				overlappingRunIndices.push(runIndex);
			}
		}
		if (!overlappingRunIndices.length) {
			overlappingRunIndices.push(projectFontStyleRunIndexAt(options.runs, Math.max(0, Math.min(fullTextLength - 1, line.logicalStart))));
		}
		const candidates = overlappingRunIndices.map((runIndex) => {
			const run = options.runs[runIndex];
			if (run.autoLeading === false || (run.autoLeading === null && run.leading !== null && run.leading !== undefined && run.leading > 0)) {
				return { runIndex, value: run.leading!, source: "authored-explicit-leading" as const, authored: true };
			}
			if (
				run.autoLeading === true ||
				((run.autoLeading === null || run.autoLeading === undefined) && paragraphRun?.autoLeading !== null && paragraphRun?.autoLeading !== undefined)
			) {
				return {
					runIndex,
					value: run.fontSize * (paragraphRun?.autoLeading ?? 1.2),
					source: "authored-auto-leading" as const,
					authored: run.autoLeading === true,
				};
			}
			return { runIndex, value: naturalRunLineHeights[runIndex], source: "font-metrics" as const, authored: false };
		});
		const lineHeight = Math.max(...candidates.map((candidate) => candidate.value));
		const governing = candidates.filter((candidate) => Math.abs(candidate.value - lineHeight) <= 1e-9);
		const source = governing.some((candidate) => candidate.source === "authored-explicit-leading")
			? "authored-explicit-leading"
			: governing.some((candidate) => candidate.source === "authored-auto-leading")
				? "authored-auto-leading"
				: "font-metrics";
		return { lineHeight, source, leadingRunIndices: governing.filter((candidate) => candidate.authored).map((candidate) => candidate.runIndex) };
	});
}

function projectFontNoBreakAllowsCandidate(runs: IProjectFontTextStyleRunOptions[], authoredLine: IProjectFontLogicalLine, candidate: IProjectFontBoxBreakCandidate): boolean {
	if (candidate.nextLogicalStart >= authoredLine.logicalEnd) {
		return true;
	}
	let runStart = 0;
	for (const run of runs) {
		const runEnd = runStart + run.text.length;
		if ((run.noBreak === true || run.baselineDirection === "tate-chu-yoko") && runStart < candidate.logicalEnd && runEnd > candidate.logicalEnd) {
			return false;
		}
		runStart = runEnd;
	}
	return true;
}

function projectFontDictionaryBreaks(
	word: string,
	wordStart: number,
	runIndex: number,
	run: IProjectFontTextStyleRunOptions,
	paragraph: IProjectFontTextParagraphRunOptions
): IProjectFontBoxBreakCandidate[] {
	const dictionary = projectFontPhotoshopLanguage(run.language ?? 0);
	const characters = Array.from(word);
	if (characters.length < paragraph.hyphenatedWordSize) {
		return [];
	}
	const hyphenated = dictionary.hyphenate(word, { hyphenChar: "\u00ad", minWordLength: paragraph.hyphenatedWordSize });
	const result: IProjectFontBoxBreakCandidate[] = [];
	let prefix = "";
	const segments = hyphenated.split("\u00ad");
	for (let index = 0; index < segments.length - 1; ++index) {
		prefix += segments[index];
		const before = Array.from(prefix).length;
		const after = characters.length - before;
		const logicalEnd = wordStart + prefix.length;
		if (before >= paragraph.preHyphen && after >= paragraph.postHyphen) {
			result.push({
				logicalEnd,
				nextLogicalStart: logicalEnd,
				insertedHyphen: true,
				hyphenRunIndex: runIndex,
				hyphenationLanguage: dictionary.language,
			});
		}
	}
	return result;
}

function projectFontBoxBreakCandidates(options: IProjectFontBoxCompositionOptions): IProjectFontBoxBreakCandidate[] {
	const { authoredLine, fullText, paragraphRun } = options;
	const result: IProjectFontBoxBreakCandidate[] = [];
	let offset = authoredLine.logicalStart;
	while (offset < authoredLine.logicalEnd) {
		const character = String.fromCodePoint(fullText.codePointAt(offset)!);
		if (/\s/u.test(character)) {
			const logicalEnd = offset;
			offset += character.length;
			while (offset < authoredLine.logicalEnd) {
				const next = String.fromCodePoint(fullText.codePointAt(offset)!);
				if (!/\s/u.test(next)) {
					break;
				}
				offset += next.length;
			}
			result.push({ logicalEnd, nextLogicalStart: offset, insertedHyphen: false, hyphenRunIndex: null, hyphenationLanguage: null });
			continue;
		}
		if (/[-\u2010\u2011]/u.test(character)) {
			offset += character.length;
			result.push({ logicalEnd: offset, nextLogicalStart: offset, insertedHyphen: false, hyphenRunIndex: null, hyphenationLanguage: null });
			continue;
		}
		if (paragraphRun?.autoHyphenate && /\p{L}/u.test(character)) {
			const wordStart = offset;
			offset += character.length;
			while (offset < authoredLine.logicalEnd) {
				const next = String.fromCodePoint(fullText.codePointAt(offset)!);
				if (!/[\p{L}\p{M}'’]/u.test(next)) {
					break;
				}
				offset += next.length;
			}
			const runIndex = projectFontStyleRunIndexAt(options.styleRuns, wordStart);
			result.push(...projectFontDictionaryBreaks(fullText.slice(wordStart, offset), wordStart, runIndex, options.styleRuns[runIndex], paragraphRun));
			continue;
		}
		offset += character.length;
	}
	let terminalEnd = authoredLine.logicalEnd;
	while (terminalEnd > authoredLine.logicalStart && /\s/u.test(fullText[terminalEnd - 1])) {
		terminalEnd--;
	}
	result.push({
		logicalEnd: terminalEnd,
		nextLogicalStart: authoredLine.logicalEnd,
		insertedHyphen: false,
		hyphenRunIndex: null,
		hyphenationLanguage: null,
	});
	return result
		.filter((candidate) => {
			if (candidate.logicalEnd <= authoredLine.logicalStart || !options.canBreakAt(candidate.logicalEnd)) {
				return false;
			}
			if (!projectFontNoBreakAllowsCandidate(options.styleRuns, authoredLine, candidate)) {
				options.onNoBreakPreventedBreak?.();
				return false;
			}
			return true;
		})
		.sort((left, right) => left.logicalEnd - right.logicalEnd || Number(left.insertedHyphen) - Number(right.insertedHyphen));
}

function composeProjectFontAuthoredBoxLine(options: IProjectFontBoxCompositionOptions): IProjectFontLogicalLine[] {
	const candidates = projectFontBoxBreakCandidates(options);
	if (!candidates.length) {
		return [options.authoredLine];
	}
	if (candidates.length > 4096) {
		throw new Error("PSD box-text composition supports at most 4,096 break opportunities per authored paragraph.");
	}
	const paragraph = options.paragraphRun;
	const lineFromCandidate = (start: number, candidate: IProjectFontBoxBreakCandidate, lineIndex: number, terminal: boolean): IProjectFontLogicalLine => ({
		text: options.fullText.slice(start, candidate.logicalEnd) + (candidate.insertedHyphen ? "-" : ""),
		logicalStart: start,
		logicalEnd: candidate.logicalEnd,
		firstInParagraph: lineIndex === 0,
		lastInParagraph: terminal,
		softWrapped: lineIndex > 0,
		insertedHyphen: candidate.insertedHyphen,
		hyphenationLanguage: candidate.hyphenationLanguage,
	});
	const validCandidates = (
		start: number,
		lineIndex: number,
		consecutiveHyphens: number
	): Array<{ candidate: IProjectFontBoxBreakCandidate; advance: number; overflow: number }> => {
		const span = options.primarySpan(lineIndex === 0);
		const result: Array<{ candidate: IProjectFontBoxBreakCandidate; advance: number; overflow: number }> = [];
		for (const candidate of candidates) {
			if (candidate.logicalEnd <= start || candidate.nextLogicalStart <= start || (candidate.insertedHyphen && consecutiveHyphens >= (paragraph?.consecutiveHyphens ?? 2))) {
				continue;
			}
			const advance = options.measure(start, candidate.logicalEnd, candidate.hyphenRunIndex);
			const overflow = Math.max(0, advance - span);
			result.push({ candidate, advance, overflow });
			if (overflow > 0 && result.some((entry) => entry.overflow === 0)) {
				break;
			}
		}
		return result;
	};
	const composeGreedy = (): IProjectFontLogicalLine[] => {
		const result: IProjectFontLogicalLine[] = [];
		let start = options.authoredLine.logicalStart;
		let consecutiveHyphens = 0;
		while (start < options.authoredLine.logicalEnd) {
			const available = validCandidates(start, result.length, consecutiveHyphens);
			const fitting = available.filter((entry) => entry.overflow === 0);
			let selected = fitting[fitting.length - 1] ?? available[0];
			if (!selected) {
				throw new Error("PSD box-text composer could not advance through the authored paragraph.");
			}
			if (selected.candidate.insertedHyphen && paragraph && !paragraph.justification.startsWith("justify")) {
				const natural = [...fitting].reverse().find((entry) => !entry.candidate.insertedHyphen);
				const naturalSlack = natural ? options.primarySpan(result.length === 0) - natural.advance : Number.POSITIVE_INFINITY;
				if (natural && naturalSlack <= paragraph.hyphenationZone) {
					selected = natural;
				}
			}
			const terminal = selected.candidate.nextLogicalStart >= options.authoredLine.logicalEnd;
			result.push(lineFromCandidate(start, selected.candidate, result.length, terminal));
			consecutiveHyphens = selected.candidate.insertedHyphen ? consecutiveHyphens + 1 : 0;
			start = selected.candidate.nextLogicalStart;
		}
		return result;
	};
	if (!paragraph?.everyLineComposer) {
		return composeGreedy();
	}
	type Solution = { cost: number; lines: IProjectFontLogicalLine[] };
	const memo = new Map<string, Solution | null>();
	const solve = (start: number, lineIndex: number, consecutiveHyphens: number): Solution | null => {
		if (start >= options.authoredLine.logicalEnd) {
			return { cost: 0, lines: [] };
		}
		const key = `${start}:${lineIndex}:${consecutiveHyphens}`;
		if (memo.has(key)) {
			return memo.get(key)!;
		}
		let best: Solution | null = null;
		const available = validCandidates(start, lineIndex, consecutiveHyphens);
		const natural = [...available].reverse().find((entry) => entry.overflow === 0 && !entry.candidate.insertedHyphen);
		for (const entry of available) {
			if (
				entry.candidate.insertedHyphen &&
				paragraph &&
				!paragraph.justification.startsWith("justify") &&
				natural &&
				options.primarySpan(lineIndex === 0) - natural.advance <= paragraph.hyphenationZone
			) {
				continue;
			}
			const terminal = entry.candidate.nextLogicalStart >= options.authoredLine.logicalEnd;
			const next = solve(entry.candidate.nextLogicalStart, lineIndex + 1, entry.candidate.insertedHyphen ? consecutiveHyphens + 1 : 0);
			if (!next) {
				continue;
			}
			const span = options.primarySpan(lineIndex === 0);
			const slack = Math.max(0, span - entry.advance);
			const overflowPenalty = entry.overflow * entry.overflow * 1000;
			const ragPenalty = slack * slack * (terminal ? 0.1 : 1);
			const hyphenPenalty = entry.candidate.insertedHyphen ? Math.max(100, span * span * 0.02) : 0;
			const cost = overflowPenalty + ragPenalty + hyphenPenalty + next.cost;
			if (!best || cost < best.cost) {
				best = { cost, lines: [lineFromCandidate(start, entry.candidate, lineIndex, terminal), ...next.lines] };
			}
		}
		memo.set(key, best);
		return best;
	};
	return solve(options.authoredLine.logicalStart, 0, 0)?.lines ?? composeGreedy();
}

function projectFontBoxComposerModel(options: IProjectFontTextStyleRunsOptions): IProjectFontTextBoxLayoutEvidence["composerModel"] {
	const values = new Set((options.paragraphRuns ?? []).map((run) => run.everyLineComposer));
	return values.size > 1 ? "mixed-authored-composers-v1" : values.has(true) ? "bounded-every-line-composer-v1" : "bounded-single-line-composer-v1";
}

function authoredProjectFontLogicalLines(fullText: string): IProjectFontLogicalLine[] {
	const result: IProjectFontLogicalLine[] = [];
	let logicalStart = 0;
	for (const text of fullText.split("\n")) {
		const logicalEnd = logicalStart + text.length;
		result.push({ text, logicalStart, logicalEnd, firstInParagraph: true, lastInParagraph: true, softWrapped: false, insertedHyphen: false, hyphenationLanguage: null });
		logicalStart = logicalEnd + 1;
	}
	return result;
}

function validateProjectFontTextBoxLayout(value: IProjectFontTextBoxLayoutOptions | undefined): IProjectFontTextBoxLayoutOptions | null {
	if (value === undefined) {
		return null;
	}
	if (![value.left, value.top, value.right, value.bottom].every((entry) => Number.isFinite(entry) && Math.abs(entry) <= 32_768)) {
		throw new Error("PSD authored box-text bounds must contain finite values between -32,768 and 32,768 pixels.");
	}
	if (value.right <= value.left || value.bottom <= value.top || (value.right - value.left) * (value.bottom - value.top) > 67_108_864) {
		throw new Error("PSD authored box-text bounds must have a positive area no larger than 67,108,864 square pixels.");
	}
	return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
}

function prepareProjectFontParagraphLineLayouts(
	options: IProjectFontTextStyleRunsOptions,
	lineAdvances: number[],
	naturalRunLineHeights: number[],
	logicalLines: IProjectFontLogicalLine[] = authoredProjectFontLogicalLines(options.runs.map((run) => run.text).join("")),
	kashidaJustifiedLineIndices: ReadonlySet<number> = new Set()
): { lines: IProjectFontParagraphLineLayout[]; evidence: IProjectFontTextParagraphRunEvidence[] } {
	const orientation = options.orientation ?? "horizontal";
	const vertical = orientation === "vertical";
	const fullText = options.runs.map((run) => run.text).join("");
	if (logicalLines.length !== lineAdvances.length) {
		throw new Error(`PSD paragraph layout produced ${lineAdvances.length} raster lines for ${logicalLines.length} logical text lines.`);
	}
	const resolvedLineHeights = resolveProjectFontLineHeights(options, logicalLines, naturalRunLineHeights);
	const boxLayout = validateProjectFontTextBoxLayout(options.boxLayout);
	if (!options.paragraphRuns?.length) {
		return {
			lines: lineAdvances.map((advance, lineIndex) => {
				const resolvedLeading = resolvedLineHeights[lineIndex];
				const primaryMinimum = vertical ? (boxLayout?.top ?? 0) + options.offsetY : (boxLayout?.left ?? 0) + options.offsetX;
				const primaryMaximum = vertical ? (boxLayout?.bottom ?? options.height) : (boxLayout?.right ?? options.width);
				return {
					primaryStart:
						options.justification === "center"
							? primaryMinimum + (primaryMaximum - primaryMinimum - advance) / 2
							: options.justification === "right"
								? primaryMaximum - advance
								: primaryMinimum,
					crossPosition: vertical
						? (boxLayout?.right ?? options.width) -
							options.offsetX -
							resolvedLineHeights.slice(0, lineIndex).reduce((sum, entry) => sum + entry.lineHeight, 0) -
							resolvedLeading.lineHeight / 2
						: (boxLayout?.top ?? 0) + options.offsetY + resolvedLineHeights.slice(0, lineIndex).reduce((sum, entry) => sum + entry.lineHeight, 0),
					lineHeight: resolvedLeading.lineHeight,
					lineHeightSource: resolvedLeading.source,
					leadingRunIndices: resolvedLeading.leadingRunIndices,
					justification: options.justification,
					extraWordSpacing: 0,
				};
			}),
			evidence: [],
		};
	}
	if (options.paragraphRuns.length > 64) {
		throw new Error("PSD authored paragraph layout supports at most 64 paragraph runs.");
	}
	let coveredLength = 0;
	for (const run of options.paragraphRuns) {
		if (!Number.isSafeInteger(run.sourceParagraphRunIndex) || run.sourceParagraphRunIndex < 0 || !Number.isSafeInteger(run.start) || run.start !== coveredLength) {
			throw new Error("PSD paragraph runs require ordered contiguous non-negative source indices and UTF-16 starts.");
		}
		if (!Number.isSafeInteger(run.length) || run.length < 1 || run.start + run.length > fullText.length) {
			throw new Error(`PSD paragraph run ${run.sourceParagraphRunIndex} has an invalid UTF-16 length.`);
		}
		const end = run.start + run.length;
		if (
			(run.start > 0 && /[\uD800-\uDBFF]/.test(fullText[run.start - 1]) && /[\uDC00-\uDFFF]/.test(fullText[run.start])) ||
			(end < fullText.length && /[\uD800-\uDBFF]/.test(fullText[end - 1]) && /[\uDC00-\uDFFF]/.test(fullText[end]))
		) {
			throw new Error(`PSD paragraph run ${run.sourceParagraphRunIndex} splits a Unicode surrogate pair.`);
		}
		for (const [label, value] of [
			["firstLineIndent", run.firstLineIndent],
			["startIndent", run.startIndent],
			["endIndent", run.endIndent],
			["spaceBefore", run.spaceBefore],
			["spaceAfter", run.spaceAfter],
		] as const) {
			if (!Number.isFinite(value) || value < -4096 || value > 4096) {
				throw new Error(`PSD paragraph run ${run.sourceParagraphRunIndex} ${label} must be between -4,096 and 4,096 pixels.`);
			}
		}
		if (
			(run.autoLeading !== null && (!Number.isFinite(run.autoLeading) || run.autoLeading < 0.25 || run.autoLeading > 10)) ||
			typeof run.autoHyphenate !== "boolean" ||
			typeof run.everyLineComposer !== "boolean" ||
			!Number.isSafeInteger(run.hyphenatedWordSize) ||
			run.hyphenatedWordSize < 2 ||
			run.hyphenatedWordSize > 25 ||
			!Number.isSafeInteger(run.preHyphen) ||
			run.preHyphen < 1 ||
			run.preHyphen > 15 ||
			!Number.isSafeInteger(run.postHyphen) ||
			run.postHyphen < 1 ||
			run.postHyphen > 15 ||
			!Number.isSafeInteger(run.consecutiveHyphens) ||
			run.consecutiveHyphens < 2 ||
			run.consecutiveHyphens > 25 ||
			!Number.isFinite(run.hyphenationZone) ||
			run.hyphenationZone < 0 ||
			run.hyphenationZone > 8640
		) {
			throw new Error(`PSD paragraph run ${run.sourceParagraphRunIndex} has invalid auto-leading, hyphenation, or composer evidence.`);
		}
		coveredLength = end;
	}
	if (coveredLength !== fullText.length) {
		throw new Error(`PSD paragraph-run lengths cover ${coveredLength} of ${fullText.length} UTF-16 code units.`);
	}
	const evidence = options.paragraphRuns.map(
		(run): IProjectFontTextParagraphRunEvidence => ({
			...run,
			lineIndices: [],
			lineCount: 0,
			appliedLineHeight: 0,
			lineHeights: [],
			lineHeightSources: [],
			lineHeightSource: options.lineHeight !== null ? "request" : "font-metrics",
			lineBreakModel: logicalLines.some((line) => line.softWrapped && line.logicalStart >= run.start && line.logicalStart < run.start + run.length)
				? logicalLines.some((line) => line.insertedHyphen && line.logicalStart >= run.start && line.logicalStart < run.start + run.length)
					? "bounded-authored-box-hyphenation-v1"
					: "bounded-authored-box-wrap-v1"
				: "authored-paragraph-breaks-v1",
			hyphenatedLineCount: 0,
			insertedHyphenCount: 0,
			hyphenationLanguages: [],
			hyphenationExecutionModel: run.autoHyphenate && boxLayout ? "bounded-liang-pattern-hyphenation-v1" : "disabled",
			composerExecutionModel: run.everyLineComposer && boxLayout ? "bounded-every-line-composer-v1" : "bounded-single-line-composer-v1",
			executionModel: "bounded-authored-paragraph-run-layout-v1",
		})
	);
	const lines: IProjectFontParagraphLineLayout[] = [];
	let crossCursor = vertical ? (boxLayout?.right ?? options.width) - options.offsetX : (boxLayout?.top ?? 0) + options.offsetY;
	for (let lineIndex = 0; lineIndex < logicalLines.length; ++lineIndex) {
		const logicalLine = logicalLines[lineIndex];
		const runIndex = options.paragraphRuns.findIndex((run) => logicalLine.logicalStart >= run.start && logicalLine.logicalStart < run.start + run.length);
		const effectiveRunIndex = runIndex >= 0 ? runIndex : options.paragraphRuns.length - 1;
		const run = options.paragraphRuns[effectiveRunIndex];
		const resolvedLeading = resolvedLineHeights[lineIndex];
		const lineHeight = resolvedLeading.lineHeight;
		if (logicalLine.logicalEnd > run.start + run.length) {
			throw new Error(`PSD paragraph run ${run.sourceParagraphRunIndex} ends inside authored paragraph line ${lineIndex}.`);
		}
		evidence[effectiveRunIndex].lineIndices.push(lineIndex);
		evidence[effectiveRunIndex].lineCount++;
		evidence[effectiveRunIndex].lineHeights.push(lineHeight);
		evidence[effectiveRunIndex].lineHeightSources.push(resolvedLeading.source);
		if (lineHeight >= evidence[effectiveRunIndex].appliedLineHeight) {
			evidence[effectiveRunIndex].appliedLineHeight = lineHeight;
			evidence[effectiveRunIndex].lineHeightSource = resolvedLeading.source;
		}
		if (logicalLine.insertedHyphen) {
			evidence[effectiveRunIndex].hyphenatedLineCount++;
			evidence[effectiveRunIndex].insertedHyphenCount++;
			if (logicalLine.hyphenationLanguage && !evidence[effectiveRunIndex].hyphenationLanguages.includes(logicalLine.hyphenationLanguage)) {
				evidence[effectiveRunIndex].hyphenationLanguages.push(logicalLine.hyphenationLanguage);
			}
		}
		if (logicalLine.firstInParagraph) {
			crossCursor += vertical ? -run.spaceBefore : run.spaceBefore;
		}
		const primaryMinimum =
			(vertical ? (boxLayout?.top ?? 0) + options.offsetY : (boxLayout?.left ?? 0) + options.offsetX) +
			run.startIndent +
			(logicalLine.firstInParagraph ? run.firstLineIndent : 0);
		const primaryMaximum = (vertical ? (boxLayout?.bottom ?? options.height) : (boxLayout?.right ?? options.width)) - run.endIndent;
		if (primaryMaximum <= primaryMinimum) {
			throw new Error(`PSD paragraph run ${run.sourceParagraphRunIndex} indents leave no positive primary-axis layout span.`);
		}
		const available = primaryMaximum - primaryMinimum;
		const advance = lineAdvances[lineIndex];
		const terminalJustification =
			run.justification === "justify-left" ? "left" : run.justification === "justify-right" ? "right" : run.justification === "justify-center" ? "center" : run.justification;
		const fullyJustified = run.justification === "justify-all" || (run.justification.startsWith("justify-") && !logicalLine.lastInParagraph);
		const primaryStart = fullyJustified
			? primaryMinimum
			: terminalJustification === "center"
				? primaryMinimum + (available - advance) / 2
				: terminalJustification === "right"
					? primaryMaximum - advance
					: primaryMinimum;
		const wordGapCount = Array.from(logicalLine.text).filter((character) => character === " ").length;
		lines.push({
			primaryStart,
			crossPosition: vertical ? crossCursor - lineHeight / 2 : crossCursor,
			lineHeight,
			lineHeightSource: resolvedLeading.source,
			leadingRunIndices: resolvedLeading.leadingRunIndices,
			justification: run.justification,
			extraWordSpacing: fullyJustified && !kashidaJustifiedLineIndices.has(lineIndex) && wordGapCount > 0 ? Math.max(0, available - advance) / wordGapCount : 0,
		});
		crossCursor += vertical ? -lineHeight : lineHeight;
		if (logicalLine.lastInParagraph) {
			crossCursor += vertical ? -run.spaceAfter : run.spaceAfter;
		}
	}
	return { lines, evidence };
}
function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

async function contentHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

async function fontImporterFingerprint(path: string, settings: IFontImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

function fontFamily(path: string): string {
	return basename(path, extname(path)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "ImportedFont";
}

async function convertMsdfPage(png: Uint8Array, renderMode: IFontImporterSettings["renderMode"], distanceRange: number): Promise<Buffer> {
	if (renderMode === "msdf") {
		return Buffer.from(png);
	}
	const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const output = Buffer.alloc(info.width * info.height * 4);
	for (let offset = 0; offset < data.length; offset += 4) {
		const channels = [data[offset], data[offset + 1], data[offset + 2]].sort((left, right) => left - right);
		const distance = channels[1];
		if (renderMode === "sdf") {
			output[offset] = distance;
			output[offset + 1] = distance;
			output[offset + 2] = distance;
			output[offset + 3] = data[offset + 3];
		} else {
			const transition = Math.max(1, 128 / Math.max(1, distanceRange));
			const alpha = Math.max(0, Math.min(255, Math.round(((distance - 128) / transition + 0.5) * 255)));
			output[offset] = 255;
			output[offset + 1] = 255;
			output[offset + 2] = 255;
			output[offset + 3] = Math.min(alpha, data[offset + 3]);
		}
	}
	return sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
		.png()
		.toBuffer();
}

function projectFontMsdfPaintCoverage(pixels: Uint8Array, offset: number, distanceRange: number, outlineWidth: number): { fillAlpha: number; strokeAlpha: number } {
	const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]].sort((left, right) => left - right);
	const signedDistance = (channels[1] - 128) / (128 / Math.max(1, distanceRange));
	const sourceAlpha = pixels[offset + 3];
	const fillAlpha = Math.min(sourceAlpha, Math.max(0, Math.min(255, Math.round((signedDistance + 0.5) * 255))));
	const strokeAlpha = outlineWidth > 0 ? Math.min(sourceAlpha, Math.max(0, Math.min(255, Math.round((outlineWidth / 2 - Math.abs(signedDistance) + 0.5) * 255)))) : 0;
	return { fillAlpha, strokeAlpha };
}

/** Rasterizes bounded horizontal or vertical text with one explicit project font and no system-font fallback. */
export async function renderProjectFontText(sourcePath: string, options: IProjectFontTextRenderOptions, sourceBytes?: Uint8Array): Promise<IProjectFontTextRenderResult> {
	const orientation = options.orientation ?? "horizontal";
	if (orientation !== "horizontal" && orientation !== "vertical") {
		throw new Error("PSD text raster orientation must be horizontal or vertical.");
	}
	validateFontImporterSource(sourcePath, {
		renderMode: "bitmap",
		characterSet: "custom",
		customCharacters: options.text || " ",
		fontSize: options.fontSize,
		padding: 1,
		distanceRange: 4,
	});
	if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width < 1 || options.height < 1 || options.width * options.height > 67_108_864) {
		throw new Error("PSD text raster canvas must contain 1-67,108,864 pixels.");
	}
	if (!Number.isFinite(options.fontSize) || options.fontSize < 1 || options.fontSize > 512) {
		throw new Error("PSD text raster fontSize must be between 1 and 512 pixels.");
	}
	if (options.lineHeight !== null && (!Number.isFinite(options.lineHeight) || options.lineHeight < 1 || options.lineHeight > 2048)) {
		throw new Error("PSD text raster lineHeight must be null or between 1 and 2,048 pixels.");
	}
	if (!Number.isFinite(options.tracking) || options.tracking < -1000 || options.tracking > 10_000) {
		throw new Error("PSD text raster tracking must be between -1,000 and 10,000 thousandths of an em.");
	}
	if (![options.offsetX, options.offsetY].every((value) => Number.isFinite(value) && Math.abs(value) <= 32_768)) {
		throw new Error("PSD text raster offsets must be finite values between -32,768 and 32,768 pixels.");
	}
	if (options.shaping || orientation === "vertical") {
		const fontBytes = sourceBytes ?? (await readFile(sourcePath));
		const styled = await renderProjectFontTextStyleRuns({
			runs: [
				{
					text: options.text,
					fontPath: sourcePath,
					fontBytes,
					fontSize: options.fontSize,
					tracking: options.tracking,
					color: options.color,
					sourceStyleRunIndex: 0,
					fontIndex: 0,
					fontName: null,
					fauxBold: false,
					fauxItalic: false,
				},
			],
			width: options.width,
			height: options.height,
			orientation,
			lineHeight: options.lineHeight,
			justification: options.justification,
			offsetX: options.offsetX,
			offsetY: options.offsetY,
			shaping: options.shaping ?? { direction: "ltr" },
		});
		return {
			pixels: styled.pixels,
			orientation,
			lineCount: styled.lineCount,
			glyphCount: styled.glyphCount,
			uniqueGlyphCount: styled.uniqueGlyphCount,
			lineHeight: styled.lineHeight,
			inkBounds: styled.inkBounds,
			clippedPixelCount: styled.clippedPixelCount,
			shaping: styled.shaping,
			shapedGlyphs: styled.styleRuns[0].shapedGlyphs,
			executionModel:
				orientation === "vertical"
					? styled.shaping?.bidirectional
						? "bounded-project-font-harfbuzz-bidi-vertical-text-raster-v1"
						: "bounded-project-font-harfbuzz-vertical-text-raster-v1"
					: styled.shaping?.bidirectional
						? "bounded-project-font-harfbuzz-bidi-text-raster-v1"
						: "bounded-project-font-harfbuzz-text-raster-v1",
		};
	}
	const codepoints = [
		...new Set(Array.from(options.text, (character) => character.codePointAt(0)!).filter((codepoint) => codepoint !== 10 && codepoint !== 13 && codepoint !== 9)),
	];
	if (codepoints.length > 1024) {
		throw new Error("PSD text rasterization supports at most 1,024 unique glyphs per layer.");
	}
	const wasm = await readFile(require.resolve("msdfgen-wasm/wasm"));
	const generator = await Msdfgen.create(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
	generator.loadFont(sourceBytes ?? (await readFile(sourcePath)));
	generator.loadGlyphs(codepoints, { preprocess: true });
	const glyphByCodepoint = new Map(generator.glyphs.map((glyph) => [glyph.unicode, glyph]));
	const missingCodepoints = codepoints.filter((codepoint) => !glyphByCodepoint.has(codepoint));
	if (missingCodepoints.length) {
		throw new Error(
			`Project font is missing required PSD text codepoint(s): ${missingCodepoints.map((codepoint) => `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`).join(", ")}.`
		);
	}
	const distanceRange = 4;
	const bins = generator.packGlyphs(
		{ size: options.fontSize, range: distanceRange, edgeColoring: "inktrap", edgeThresholdAngle: 3, scanline: false },
		{ maxWidth: 2048, maxHeight: 2048, padding: 1, pot: true, smart: true, allowRotation: false }
	);
	const atlasPages = await Promise.all(
		bins.map(async (bin) => {
			const png = await convertMsdfPage(generator.createAtlasImage(bin), "bitmap", distanceRange);
			const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			return { bin, pixels: decoded.data, width: decoded.info.width };
		})
	);
	type GlyphPlacement = { x: number; y: number; width: number; height: number; page: number; xOffset: number; yOffset: number; xAdvance: number };
	const placements = new Map<number, GlyphPlacement>();
	for (let page = 0; page < atlasPages.length; ++page) {
		for (const rectangle of atlasPages[page].bin.rects) {
			const range = rectangle.msdfData.range;
			placements.set(rectangle.glyph.unicode, {
				x: rectangle.x,
				y: rectangle.y,
				width: rectangle.width,
				height: rectangle.height,
				page,
				xOffset: (rectangle.glyph.left - range / 2) * options.fontSize,
				yOffset: (generator.metrics.ascenderY - (rectangle.glyph.top + range / 2)) * options.fontSize,
				xAdvance: rectangle.glyph.advance * options.fontSize,
			});
		}
	}
	const lines = options.text.replace(/\r\n?/g, "\n").split("\n");
	const trackingPixels = (options.tracking * options.fontSize) / 1000;
	const measureLine = (characters: string[]): number => {
		let width = 0;
		for (let index = 0; index < characters.length; ++index) {
			const codepoint = characters[index].codePointAt(0)!;
			if (codepoint === 9) {
				width += generator.metrics.tabAdvance * options.fontSize;
				continue;
			}
			const glyph = glyphByCodepoint.get(codepoint)!;
			width += glyph.advance * options.fontSize;
			const next = characters[index + 1]?.codePointAt(0);
			if (next !== undefined) {
				width += trackingPixels + (glyph.kerning.find(([candidate]) => candidate.unicode === next)?.[1] ?? 0) * options.fontSize;
			}
		}
		return width;
	};
	const output = new Uint8Array(options.width * options.height * 4);
	const effectiveLineHeight = options.lineHeight ?? generator.metrics.lineHeight * options.fontSize;
	let glyphCount = 0;
	let clippedPixelCount = 0;
	let inkLeft = options.width;
	let inkTop = options.height;
	let inkRight = 0;
	let inkBottom = 0;
	const blendPixel = (destination: number, alpha: number): void => {
		const sourceAlpha = (alpha / 255) * (options.color[3] / 255);
		if (sourceAlpha <= 0) {
			return;
		}
		const destinationAlpha = output[destination + 3] / 255;
		const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
		for (let channel = 0; channel < 3; ++channel) {
			const premultiplied = options.color[channel] * sourceAlpha + output[destination + channel] * destinationAlpha * (1 - sourceAlpha);
			output[destination + channel] = outputAlpha > 0 ? Math.round(premultiplied / outputAlpha) : 0;
		}
		output[destination + 3] = Math.round(outputAlpha * 255);
	};
	for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
		const characters = Array.from(lines[lineIndex]);
		const measured = measureLine(characters);
		let cursorX = options.offsetX + (options.justification === "center" ? (options.width - measured) / 2 : options.justification === "right" ? options.width - measured : 0);
		const lineTop = options.offsetY + lineIndex * effectiveLineHeight;
		for (let index = 0; index < characters.length; ++index) {
			const codepoint = characters[index].codePointAt(0)!;
			if (codepoint === 9) {
				cursorX += generator.metrics.tabAdvance * options.fontSize;
				continue;
			}
			const glyph = glyphByCodepoint.get(codepoint)!;
			const placement = placements.get(codepoint);
			if (placement && placement.width > 0 && placement.height > 0) {
				glyphCount++;
				const page = atlasPages[placement.page];
				const destinationLeft = Math.round(cursorX + placement.xOffset);
				const destinationTop = Math.round(lineTop + placement.yOffset);
				for (let y = 0; y < placement.height; ++y) {
					for (let x = 0; x < placement.width; ++x) {
						const alpha = page.pixels[((placement.y + y) * page.width + placement.x + x) * 4 + 3];
						if (!alpha) {
							continue;
						}
						const destinationX = destinationLeft + x;
						const destinationY = destinationTop + y;
						if (destinationX < 0 || destinationY < 0 || destinationX >= options.width || destinationY >= options.height) {
							clippedPixelCount++;
							continue;
						}
						blendPixel((destinationY * options.width + destinationX) * 4, alpha);
						inkLeft = Math.min(inkLeft, destinationX);
						inkTop = Math.min(inkTop, destinationY);
						inkRight = Math.max(inkRight, destinationX + 1);
						inkBottom = Math.max(inkBottom, destinationY + 1);
					}
				}
			}
			cursorX += placement?.xAdvance ?? glyph.advance * options.fontSize;
			const next = characters[index + 1]?.codePointAt(0);
			if (next !== undefined) {
				cursorX += trackingPixels + (glyph.kerning.find(([candidate]) => candidate.unicode === next)?.[1] ?? 0) * options.fontSize;
			}
		}
	}
	return {
		pixels: output,
		orientation,
		lineCount: lines.length,
		glyphCount,
		uniqueGlyphCount: codepoints.length,
		lineHeight: effectiveLineHeight,
		inkBounds: inkRight > inkLeft && inkBottom > inkTop ? { left: inkLeft, top: inkTop, right: inkRight, bottom: inkBottom } : null,
		clippedPixelCount,
		shaping: null,
		shapedGlyphs: [],
		executionModel: "bounded-project-font-text-raster-v1",
	};
}

interface INormalizedBidiCodePoint {
	character: string;
	logicalStart: number;
	logicalLength: number;
	runIndex: number;
	control: boolean;
	characterDirection: ProjectFontCharacterDirection | null;
}

const bidiControlCodepoints = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const bidiSupplementaryProxyByType: Record<string, string> = {
	L: "A",
	R: "א",
	AL: "ا",
	EN: "1",
	ES: "+",
	ET: "$",
	AN: "١",
	CS: ",",
	NSM: "\u0300",
	BN: "\u00ad",
	B: "\n",
	S: "\t",
	WS: " ",
	ON: "!",
	LRE: "\u202a",
	LRO: "\u202d",
	RLE: "\u202b",
	RLO: "\u202e",
	PDF: "\u202c",
	LRI: "\u2066",
	RLI: "\u2067",
	FSI: "\u2068",
	PDI: "\u2069",
};

function normalizeBidiTextLines(runs: IProjectFontTextStyleRunOptions[]): INormalizedBidiCodePoint[][] {
	const originalText = runs.map((run) => run.text).join("");
	const runByCodeUnit: number[] = [];
	for (let runIndex = 0; runIndex < runs.length; ++runIndex) {
		for (let index = 0; index < runs[runIndex].text.length; ++index) {
			runByCodeUnit.push(runIndex);
		}
	}
	const lines: INormalizedBidiCodePoint[][] = [[]];
	for (let index = 0; index < originalText.length; ) {
		if (originalText[index] === "\r" || originalText[index] === "\n") {
			index += originalText[index] === "\r" && originalText[index + 1] === "\n" ? 2 : 1;
			lines.push([]);
			continue;
		}
		const codepoint = originalText.codePointAt(index)!;
		const character = String.fromCodePoint(codepoint);
		if (character.length === 2 && runByCodeUnit[index] !== runByCodeUnit[index + 1]) {
			throw new Error("PSD complex-text style boundaries cannot split a UTF-16 surrogate pair.");
		}
		lines[lines.length - 1].push({
			character,
			logicalStart: index,
			logicalLength: character.length,
			runIndex: runByCodeUnit[index],
			control: bidiControlCodepoints.has(codepoint),
			characterDirection: runs[runByCodeUnit[index]].characterDirection ?? null,
		});
		index += character.length;
	}
	return lines;
}

function bidiProxyCharacter(character: string, characterDirection: ProjectFontCharacterDirection | null, control: boolean): string {
	if (!control && characterDirection === "left-to-right") {
		return "A";
	}
	if (!control && characterDirection === "right-to-left") {
		return "א";
	}
	if (character.length === 1) {
		return character;
	}
	const type = bidi.getBidiCharTypeName(character);
	const proxy = bidiSupplementaryProxyByType[type];
	if (!proxy) {
		throw new Error(`Unicode BiDi implementation returned unsupported supplementary character type ${type}.`);
	}
	return proxy;
}

function projectFontCharacterDirectionOverrideCharacterCount(text: string, characterDirection: IProjectFontTextStyleRunOptions["characterDirection"]): number {
	if (characterDirection !== "left-to-right" && characterDirection !== "right-to-left") {
		return 0;
	}
	return Array.from(text).filter((character) => !/[\r\n\t]/.test(character) && !bidiControlCodepoints.has(character.codePointAt(0)!)).length;
}

function projectFontIsLowercaseCharacter(character: string): boolean {
	const uppercase = character.toUpperCase();
	return uppercase !== character && character.toLowerCase() === character;
}

function projectFontCapsAffectedCharacterCount(text: string, fontCaps: IProjectFontTextStyleRunOptions["fontCaps"]): number {
	if (fontCaps !== "small-caps" && fontCaps !== "all-caps") {
		return 0;
	}
	return Array.from(text).filter((character) => projectFontIsLowercaseCharacter(character)).length;
}

function projectFontHindiNumbersText(text: string, hindiNumbers: IProjectFontTextStyleRunOptions["hindiNumbers"]): string {
	if (hindiNumbers !== true) {
		return text;
	}
	return text.replace(/[0-9]/g, (digit) => String.fromCodePoint(0x0660 + Number(digit)));
}

function projectFontHindiNumbersAffectedCharacterCount(text: string, hindiNumbers: IProjectFontTextStyleRunOptions["hindiNumbers"]): number {
	return hindiNumbers === true ? (text.match(/[0-9]/g) ?? []).length : 0;
}

const projectFontBelowDiacriticRanges: Array<number | [number, number]> = [
	0x0591,
	0x0596,
	0x059a,
	0x059b,
	[0x05a2, 0x05a7],
	0x05aa,
	0x05ad,
	[0x05b0, 0x05b8],
	0x05bb,
	0x05c5,
	0x05c7,
	0x061a,
	0x064d,
	0x0650,
	[0x0655, 0x0656],
	0x065c,
	0x065f,
	0x06e3,
	0x06ea,
	0x06ed,
	0x0731,
	0x0734,
	[0x0737, 0x0739],
	[0x073b, 0x073c],
	0x073e,
	0x0742,
	0x0744,
	0x0746,
	0x0748,
	0x07f2,
	0x07fd,
	0x08d3,
	0x08e3,
	0x08e6,
	0x08e9,
	[0x08ed, 0x08ef],
	0x08f6,
	[0x08f9, 0x08fa],
];

function projectFontDiacriticPlacement(character: string, yOffset: number): "above" | "below" {
	if (yOffset < 0) {
		return "below";
	}
	if (yOffset > 0) {
		return "above";
	}
	return projectFontCodePointInRanges(character.codePointAt(0)!, projectFontBelowDiacriticRanges) ? "below" : "above";
}

function projectFontDiacriticPositionEmShift(position: ProjectFontDiacriticPosition): number {
	return position === "loose" ? 0.12 : position === "medium" ? 0.06 : position === "tight" ? -0.02 : 0;
}

type ProjectFontArabicJoiningType = "dual" | "right" | "left" | "causing" | "none";
type ProjectFontKashidaCandidate = { insertionOffset: number; ownerLogicalStart: number; ownerRunIndex: number };

const projectFontArabicDualJoiningRanges: Array<number | [number, number]> = [
	0x0620,
	0x0626,
	0x0628,
	[0x062a, 0x062e],
	[0x0633, 0x063f],
	[0x0641, 0x0647],
	[0x0649, 0x064a],
	[0x066e, 0x066f],
	[0x0678, 0x0687],
	[0x069a, 0x06bf],
	[0x06c1, 0x06c2],
	0x06cc,
	0x06ce,
	[0x06d0, 0x06d1],
	[0x06fa, 0x06fc],
	0x06ff,
	[0x0750, 0x0758],
	[0x075c, 0x076a],
	[0x076d, 0x0770],
	0x0772,
	[0x0775, 0x0777],
	[0x077a, 0x077f],
	[0x08a0, 0x08a9],
	[0x08af, 0x08b0],
	[0x08b3, 0x08b4],
	[0x08b6, 0x08b8],
	[0x08ba, 0x08c7],
];
const projectFontArabicRightJoiningRanges: Array<number | [number, number]> = [
	[0x0622, 0x0625],
	0x0627,
	0x0629,
	[0x062f, 0x0632],
	0x0648,
	[0x0671, 0x0673],
	[0x0675, 0x0677],
	[0x0688, 0x0699],
	0x06c0,
	[0x06c3, 0x06cb],
	0x06cd,
	0x06cf,
	[0x06d2, 0x06d3],
	0x06d5,
	[0x06ee, 0x06ef],
	[0x0759, 0x075b],
	[0x076b, 0x076c],
	0x0771,
	[0x0773, 0x0774],
	[0x0778, 0x0779],
	[0x08aa, 0x08ac],
	0x08ae,
	[0x08b1, 0x08b2],
	0x08b9,
];

function projectFontCodePointInRanges(codepoint: number, ranges: Array<number | [number, number]>): boolean {
	return ranges.some((range) => (typeof range === "number" ? codepoint === range : codepoint >= range[0] && codepoint <= range[1]));
}

function projectFontArabicJoiningType(character: string): ProjectFontArabicJoiningType {
	const codepoint = character.codePointAt(0)!;
	if (codepoint === 0x0640 || codepoint === 0x200d) {
		return "causing";
	}
	if (projectFontCodePointInRanges(codepoint, projectFontArabicDualJoiningRanges)) {
		return "dual";
	}
	if (projectFontCodePointInRanges(codepoint, projectFontArabicRightJoiningRanges)) {
		return "right";
	}
	return "none";
}

function projectFontKashidaCandidates(
	text: string,
	logicalStart: number,
	runAt: (logicalOffset: number) => number,
	runs: IProjectFontTextStyleRunOptions[]
): ProjectFontKashidaCandidate[] {
	const entries: Array<{ character: string; logicalStart: number; joiningType: ProjectFontArabicJoiningType; transparent: boolean }> = [];
	let offset = logicalStart;
	for (const character of Array.from(text)) {
		entries.push({ character, logicalStart: offset, joiningType: projectFontArabicJoiningType(character), transparent: /\p{Mark}/u.test(character) });
		offset += character.length;
	}
	const result: ProjectFontKashidaCandidate[] = [];
	let leftIndex = -1;
	for (let rightIndex = 0; rightIndex < entries.length; ++rightIndex) {
		const right = entries[rightIndex];
		if (right.transparent) {
			continue;
		}
		if (leftIndex >= 0) {
			const left = entries[leftIndex];
			const ownerRunIndex = runAt(left.logicalStart);
			const leftConnectsForward = left.joiningType === "dual" || left.joiningType === "left" || left.joiningType === "causing";
			const rightConnectsBackward = right.joiningType === "dual" || right.joiningType === "right" || right.joiningType === "causing";
			if (leftConnectsForward && rightConnectsBackward && runs[ownerRunIndex]?.kashida === true) {
				result.push({ insertionOffset: right.logicalStart, ownerLogicalStart: left.logicalStart, ownerRunIndex });
			}
		}
		leftIndex = rightIndex;
	}
	return result;
}

function projectFontBaselineFeature(run: IProjectFontTextStyleRunOptions, featureTags: string[]): "sups" | "subs" | null {
	const tag = run.fontBaseline === "superscript" ? "sups" : run.fontBaseline === "subscript" ? "subs" : null;
	return tag && featureTags.includes(tag) ? tag : null;
}

function projectFontBaselineAppliedScale(run: IProjectFontTextStyleRunOptions, feature: "sups" | "subs" | null): number {
	return (run.fontBaseline === "superscript" || run.fontBaseline === "subscript") && feature === null ? (run.fontBaselineScale ?? 0.583) : 1;
}

function projectFontBaselineAppliedShift(run: IProjectFontTextStyleRunOptions, feature: "sups" | "subs" | null): number {
	const explicitShift = run.baselineShift ?? 0;
	if (feature !== null || (run.fontBaseline !== "superscript" && run.fontBaseline !== "subscript")) {
		return explicitShift;
	}
	const direction = run.fontBaseline === "superscript" ? 1 : -1;
	return Math.round((explicitShift + direction * run.fontSize * (run.fontBaselinePosition ?? 0.333)) * 1_000_000) / 1_000_000;
}

/** Reads the exact unhinted design-unit coordinates needed for Photoshop ICF and vertical Roman style-run alignment. */
export function parseOpenTypeBaseAlignmentMetrics(
	table: Uint8Array | undefined,
	orientation: "horizontal" | "vertical",
	preferredScript: string | null
): IOpenTypeBaseAlignmentMetrics | null {
	if (!table?.length) {
		return null;
	}
	const ensure = (offset: number, length: number, label: string): void => {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > table.length) {
			throw new Error(`OpenType BASE ${label} exceeds the bounded table data.`);
		}
	};
	const uint16 = (offset: number, label: string): number => {
		ensure(offset, 2, label);
		return (table[offset] << 8) | table[offset + 1];
	};
	const int16 = (offset: number, label: string): number => {
		const value = uint16(offset, label);
		return value & 0x8000 ? value - 0x10000 : value;
	};
	const tag = (offset: number, label: string): string => {
		ensure(offset, 4, label);
		return String.fromCharCode(table[offset], table[offset + 1], table[offset + 2], table[offset + 3]);
	};
	ensure(0, 8, "header");
	const majorVersion = uint16(0, "major version");
	const minorVersion = uint16(2, "minor version");
	if (majorVersion !== 1 || (minorVersion !== 0 && minorVersion !== 1)) {
		throw new Error(`OpenType BASE version ${majorVersion}.${minorVersion} is unsupported; expected 1.0 or 1.1.`);
	}
	const axisOffset = uint16(orientation === "horizontal" ? 4 : 6, `${orientation} axis offset`);
	if (axisOffset === 0) {
		return null;
	}
	ensure(axisOffset, 4, `${orientation} axis`);
	const tagListOffset = uint16(axisOffset, `${orientation} BaseTagList offset`);
	const scriptListOffset = uint16(axisOffset + 2, `${orientation} BaseScriptList offset`);
	if (tagListOffset === 0 || scriptListOffset === 0) {
		return null;
	}
	const tagList = axisOffset + tagListOffset;
	const tagCount = uint16(tagList, "BaseTagList count");
	if (tagCount < 1 || tagCount > 64) {
		throw new Error("OpenType BASE must contain between 1 and 64 baseline tags.");
	}
	ensure(tagList + 2, tagCount * 4, "BaseTagList records");
	const tags = Array.from({ length: tagCount }, (_, index) => tag(tagList + 2 + index * 4, `baseline tag ${index}`));
	if (new Set(tags).size !== tags.length) {
		throw new Error("OpenType BASE contains duplicate baseline tags.");
	}
	const scriptList = axisOffset + scriptListOffset;
	const scriptCount = uint16(scriptList, "BaseScriptList count");
	if (scriptCount < 1 || scriptCount > 256) {
		throw new Error("OpenType BASE must contain between 1 and 256 script records.");
	}
	ensure(scriptList + 2, scriptCount * 6, "BaseScriptList records");
	const scripts = Array.from({ length: scriptCount }, (_, index) => ({
		tag: tag(scriptList + 2 + index * 6, `script tag ${index}`),
		offset: uint16(scriptList + 6 + index * 6, `script offset ${index}`),
	}));
	const requested = preferredScript?.toLowerCase() ?? null;
	const selected =
		(requested ? scripts.find((script) => script.tag.toLowerCase() === requested) : undefined) ??
		scripts.find((script) => script.tag === "DFLT") ??
		scripts.find((script) => script.tag === "hani") ??
		scripts[0];
	if (selected.offset === 0) {
		throw new Error(`OpenType BASE script ${selected.tag} has a null BaseScript offset.`);
	}
	const baseScript = scriptList + selected.offset;
	ensure(baseScript, 6, `BaseScript ${selected.tag}`);
	const baseValuesOffset = uint16(baseScript, `BaseScript ${selected.tag} BaseValues offset`);
	if (baseValuesOffset === 0) {
		return null;
	}
	const baseValues = baseScript + baseValuesOffset;
	const defaultBaselineIndex = uint16(baseValues, `BaseValues ${selected.tag} default baseline index`);
	const coordinateCount = uint16(baseValues + 2, `BaseValues ${selected.tag} coordinate count`);
	if (coordinateCount !== tagCount || defaultBaselineIndex >= tagCount) {
		throw new Error(`OpenType BASE script ${selected.tag} has inconsistent baseline coordinates.`);
	}
	ensure(baseValues + 4, coordinateCount * 2, `BaseValues ${selected.tag} coordinate offsets`);
	const coordinates: IOpenTypeBaseAlignmentMetrics["coordinates"] = {};
	for (const requiredTag of ["icfb", "icft", "romn"] as const) {
		const index = tags.indexOf(requiredTag);
		if (index < 0) {
			continue;
		}
		const coordinateOffset = uint16(baseValues + 4 + index * 2, `${selected.tag}/${requiredTag} coordinate offset`);
		if (coordinateOffset === 0) {
			continue;
		}
		const coordinate = baseValues + coordinateOffset;
		const format = uint16(coordinate, `${selected.tag}/${requiredTag} coordinate format`);
		if (format !== 1 && format !== 2 && format !== 3) {
			throw new Error(`OpenType BASE ${selected.tag}/${requiredTag} uses unsupported coordinate format ${format}.`);
		}
		ensure(coordinate, format === 1 ? 4 : format === 2 ? 8 : 6, `${selected.tag}/${requiredTag} coordinate`);
		coordinates[requiredTag] = { value: int16(coordinate + 2, `${selected.tag}/${requiredTag} coordinate value`), format };
	}
	return { script: selected.tag, defaultBaselineTag: tags[defaultBaselineIndex], coordinates };
}

function projectFontPreferredBaseScript(text: string, shapedScript: string | null): string | null {
	if (shapedScript) {
		return shapedScript;
	}
	for (const character of Array.from(text)) {
		const codepoint = character.codePointAt(0)!;
		if ((codepoint >= 0x4e00 && codepoint <= 0x9fff) || (codepoint >= 0x3400 && codepoint <= 0x4dbf) || (codepoint >= 0x20000 && codepoint <= 0x3134f)) {
			return "hani";
		}
		if ((codepoint >= 0x3040 && codepoint <= 0x30ff) || (codepoint >= 0x31f0 && codepoint <= 0x31ff)) {
			return "kana";
		}
		if ((codepoint >= 0xac00 && codepoint <= 0xd7af) || (codepoint >= 0x1100 && codepoint <= 0x11ff)) {
			return "hang";
		}
	}
	return null;
}

async function renderProjectFontTextStyleRunsShaped(options: IProjectFontTextStyleRunsOptions, wasm: Buffer): Promise<IProjectFontTextStyleRunsRenderResult> {
	const shaping = normalizeProjectFontTextShaping(options.shaping!);
	const orientation = options.orientation ?? "horizontal";
	const vertical = orientation === "vertical";
	const runStarts = projectFontStyleRunStarts(options.runs);
	const authoredText = options.runs.map((run) => run.text).join("");
	const runPhotoshopLanguages = options.runs.map((run) => (run.language === null || run.language === undefined ? null : projectFontPhotoshopLanguage(run.language)));
	const runEffectiveLanguages = runPhotoshopLanguages.map((language) => language?.language ?? shaping.language);
	const hb = await getHarfBuzz();
	const runUpems: number[] = [];
	const runFonts: InstanceType<HarfBuzzApi["Font"]>[] = [];
	const runSupportsOpenTypeSmallCaps: boolean[] = [];
	const runSupportsOpenTypeProportionalMetrics: boolean[] = [];
	const runSupportsOpenTypeKana: boolean[] = [];
	const runSupportsOpenTypeRuby: boolean[] = [];
	const runSupportsOpenTypeFractions: boolean[] = [];
	const runSupportsOpenTypeOrdinals: boolean[] = [];
	const runSupportsOpenTypeStylisticAlternates: boolean[] = [];
	const runSupportsOpenTypeOldStyle: boolean[] = [];
	const runSupportsOpenTypeSwash: boolean[] = [];
	const runSupportsOpenTypeTitling: boolean[] = [];
	const runSupportsOpenTypeOrnaments: boolean[] = [];
	const runSupportsOpenTypeSlashedZero: boolean[] = [];
	const runSupportsOpenTypeConnectionForms: boolean[] = [];
	const runSupportsOpenTypeContextualLigatures: boolean[] = [];
	const runSupportsOpenTypeLiningFigures: boolean[] = [];
	const runSupportsOpenTypeProportionalFigures: boolean[] = [];
	const runSupportsOpenTypeTabularFigures: boolean[] = [];
	const runOpenTypeJapaneseAlternateFeatureTags: ProjectFontJapaneseAlternateFeatureTag[][] = [];
	const runOpenTypeFeatureTags: string[][] = [];
	const runBaseAlignmentMetrics: Array<IOpenTypeBaseAlignmentMetrics | null> = [];
	const needsOpenTypeBaseAlignment = options.runs.some(
		(run) => run.styleRunAlignment === "icf-bottom-left" || run.styleRunAlignment === "icf-top-right" || (vertical && run.styleRunAlignment === "roman-baseline")
	);
	for (const run of options.runs) {
		const bytes = run.fontBytes.buffer.slice(run.fontBytes.byteOffset, run.fontBytes.byteOffset + run.fontBytes.byteLength) as ArrayBuffer;
		const blob = new hb.Blob(bytes);
		const face = new hb.Face(blob, 0);
		const font = new hb.Font(face);
		font.setScale(face.upem, face.upem);
		if (run.hindiNumbers === true) {
			const requiredHindiDigits = [...new Set(Array.from(run.text.matchAll(/[0-9]/g), (match) => 0x0660 + Number(match[0])))];
			const missingHindiDigits = requiredHindiDigits.filter((codepoint) => font.nominalGlyph(codepoint) === undefined);
			if (missingHindiDigits.length) {
				throw new Error(
					`Project font for PSD style run ${run.sourceStyleRunIndex} is missing authored Hindi digit codepoint(s): ${missingHindiDigits.map((codepoint) => `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`).join(", ")}.`
				);
			}
		}
		runUpems.push(face.upem);
		runFonts.push(font);
		const featureTags = face.getTableFeatureTags("GSUB");
		const positioningFeatureTags = face.getTableFeatureTags("GPOS");
		runOpenTypeFeatureTags.push(featureTags);
		runSupportsOpenTypeSmallCaps.push(featureTags.includes("smcp"));
		runSupportsOpenTypeProportionalMetrics.push(positioningFeatureTags.includes("palt"));
		runSupportsOpenTypeKana.push(featureTags.includes("hkna"));
		runSupportsOpenTypeRuby.push(featureTags.includes("ruby"));
		runSupportsOpenTypeFractions.push(featureTags.includes("frac"));
		runSupportsOpenTypeOrdinals.push(featureTags.includes("ordn"));
		runSupportsOpenTypeStylisticAlternates.push(featureTags.includes("salt"));
		runSupportsOpenTypeOldStyle.push(featureTags.includes("onum"));
		runSupportsOpenTypeSwash.push(featureTags.includes("swsh"));
		runSupportsOpenTypeTitling.push(featureTags.includes("titl"));
		runSupportsOpenTypeOrnaments.push(featureTags.includes("ornm"));
		runSupportsOpenTypeSlashedZero.push(featureTags.includes("zero"));
		runSupportsOpenTypeConnectionForms.push(featureTags.includes("calt"));
		runSupportsOpenTypeContextualLigatures.push(featureTags.includes("clig"));
		runSupportsOpenTypeLiningFigures.push(featureTags.includes("lnum"));
		runSupportsOpenTypeProportionalFigures.push(featureTags.includes("pnum"));
		runSupportsOpenTypeTabularFigures.push(featureTags.includes("tnum"));
		runOpenTypeJapaneseAlternateFeatureTags.push(projectFontJapaneseAlternateFeatureTags.filter((tag) => featureTags.includes(tag)));
		runBaseAlignmentMetrics.push(
			needsOpenTypeBaseAlignment
				? parseOpenTypeBaseAlignmentMetrics(face.referenceTable("BASE"), orientation, projectFontPreferredBaseScript(run.text, shaping.script))
				: null
		);
	}
	const runBaselineFeatures = options.runs.map((run, runIndex) => projectFontBaselineFeature(run, runOpenTypeFeatureTags[runIndex]));
	const effectiveFeatures = options.runs.map((run, runIndex) => [
		...projectFontEffectiveOpenTypeFeatures(run, shaping.features).filter(
			(feature) =>
				(run.fontCaps !== "small-caps" || feature.tag !== "smcp") &&
				(!(run.fontBaseline === "superscript" || run.fontBaseline === "subscript") || !["sups", "subs"].includes(feature.tag))
		),
		...(run.fontCaps === "small-caps" && runSupportsOpenTypeSmallCaps[runIndex] ? [{ tag: "smcp", value: 1 }] : []),
		...(runBaselineFeatures[runIndex] ? [{ tag: runBaselineFeatures[runIndex]!, value: 1 }] : []),
	]);
	const runFeatureSignatures = effectiveFeatures.map((features, runIndex) =>
		JSON.stringify({
			features: [...features].sort((left, right) => left.tag.localeCompare(right.tag)).map((feature) => [feature.tag, feature.value]),
			language: runEffectiveLanguages[runIndex],
			fontCaps: options.runs[runIndex].fontCaps === "small-caps" || options.runs[runIndex].fontCaps === "all-caps" ? options.runs[runIndex].fontCaps : null,
			openTypeSmallCaps: runSupportsOpenTypeSmallCaps[runIndex],
			smallCapScale: options.runs[runIndex].fontCaps === "small-caps" && !runSupportsOpenTypeSmallCaps[runIndex] ? (options.runs[runIndex].smallCapScale ?? 0.7) : null,
			fontBaseline: options.runs[runIndex].fontBaseline === "superscript" || options.runs[runIndex].fontBaseline === "subscript" ? options.runs[runIndex].fontBaseline : null,
			fontBaselineFeature: runBaselineFeatures[runIndex],
			fontBaselineScale: projectFontBaselineAppliedScale(options.runs[runIndex], runBaselineFeatures[runIndex]),
			fontBaselinePosition:
				runBaselineFeatures[runIndex] === null && (options.runs[runIndex].fontBaseline === "superscript" || options.runs[runIndex].fontBaseline === "subscript")
					? (options.runs[runIndex].fontBaselinePosition ?? 0.333)
					: null,
			baselineDirection: options.runs[runIndex].baselineDirection ?? null,
			tateChuYokoBoundary: options.runs[runIndex].baselineDirection === "tate-chu-yoko" ? options.runs[runIndex].sourceStyleRunIndex : null,
			proportionalMetrics: options.runs[runIndex].proportionalMetrics ?? null,
			kana: options.runs[runIndex].kana ?? null,
			ruby: options.runs[runIndex].ruby ?? null,
			japaneseAlternateFeature: options.runs[runIndex].japaneseAlternateFeature ?? null,
			fractions: options.runs[runIndex].fractions ?? null,
			ordinals: options.runs[runIndex].ordinals ?? null,
			stylisticAlternates: options.runs[runIndex].stylisticAlternates ?? null,
			oldStyle: options.runs[runIndex].oldStyle ?? null,
			swash: options.runs[runIndex].swash ?? null,
			titling: options.runs[runIndex].titling ?? null,
			ornaments: options.runs[runIndex].ornaments ?? null,
			slashedZero: options.runs[runIndex].slashedZero ?? null,
			connectionForms: options.runs[runIndex].connectionForms ?? null,
			contextualLigatures: options.runs[runIndex].contextualLigatures ?? null,
			hindiNumbers: options.runs[runIndex].hindiNumbers ?? null,
			kashida: options.runs[runIndex].kashida ?? null,
			diacriticPosition: options.runs[runIndex].diacriticPosition ?? null,
			characterDirection: options.runs[runIndex].characterDirection ?? null,
			figureStyle: options.runs[runIndex].figureStyle ?? null,
			wariChu:
				options.runs[runIndex].wariChuEnabled === true
					? {
							lineCount: options.runs[runIndex].wariChuLineCount ?? 2,
							lineGap: options.runs[runIndex].wariChuLineGap ?? 0,
							scale: options.runs[runIndex].wariChuScale ?? 0.5,
							widow: options.runs[runIndex].wariChuWidow ?? 2,
							orphan: options.runs[runIndex].wariChuOrphan ?? 2,
							justification: options.runs[runIndex].wariChuJustification ?? "auto",
							sourceStyleRunIndex: options.runs[runIndex].sourceStyleRunIndex,
						}
					: null,
			tsume: options.runs[runIndex].tsume ?? null,
			styleRunAlignment: options.runs[runIndex].styleRunAlignment ?? null,
		})
	);
	const runFeatures = effectiveFeatures.map((features, runIndex) =>
		features.map((feature, featureIndex) => {
			const parsed = hb.Feature.fromString(`${feature.tag}=${feature.value}`);
			if (!parsed) {
				throw new Error(
					`HarfBuzz rejected PSD style run ${options.runs[runIndex].sourceStyleRunIndex} OpenType feature ${featureIndex} (${feature.tag}=${feature.value}).`
				);
			}
			return parsed;
		})
	);
	type BaselineGlyphOrientation = "upright" | "sideways-clockwise" | "tate-chu-yoko-horizontal" | "horizontal-no-op";
	type ShapedGlyph = IProjectFontShapedGlyphEvidence & {
		runIndex: number;
		wordSpace: boolean;
		renderScale: number;
		baselineGlyphOrientation: BaselineGlyphOrientation;
		unicodeVerticalOrientation: ProjectFontUnicodeVerticalOrientation | null;
		shapingDirection: "ttb" | "ltr" | "rtl";
		virtualHyphen?: boolean;
	};
	type ShapedGroup = { runIndex: number; glyphs: ShapedGlyph[]; tab: boolean; logicalStart: number; bidiRun: IProjectFontBidiVisualRunEvidence | null };
	type GlyphPlacement = { x: number; y: number; width: number; height: number; page: number; xOffset: number; range: number };
	type PreparedRun = {
		request: IProjectFontTextStyleRunOptions;
		generator: MsdfgenInstance;
		upem: number;
		baseAlignmentMetrics: IOpenTypeBaseAlignmentMetrics | null;
		glyphById: Map<number, Glyph>;
		placements: Map<number, GlyphPlacement>;
		atlasPages: Array<{ pixels: Buffer; width: number; distanceRange: number }>;
		shapedGlyphs: ShapedGlyph[];
		glyphCount: number;
		fillPixelCount: number;
		strokePixelCount: number;
	};
	const hasManualKerningBoundary = (leftRunIndex: number, rightRunIndex: number): boolean => projectFontManualKerningOwnerRun(leftRunIndex, rightRunIndex, options.runs) !== null;
	const lines: ShapedGroup[][] = [[]];
	const runGlyphs: ShapedGlyph[][] = options.runs.map(() => []);
	const runFontIdentities = options.runs.map((run) => createHash("sha256").update(run.fontBytes).digest("hex"));
	const shapePiece = (
		fontRunIndex: number,
		piece: string,
		logicalStart: number,
		direction: "ltr" | "rtl",
		ownerAtCluster: (cluster: number) => number = () => fontRunIndex,
		settings: { register?: boolean; sourceLogicalStarts?: number[] } = {}
	): ShapedGlyph[] => {
		const run = options.runs[fontRunIndex];
		const register = settings.register !== false;
		const sourceLogicalStarts = settings.sourceLogicalStarts;
		type SourceEntry = { character: string; logicalStart: number; verticalOrientation: ProjectFontUnicodeVerticalOrientation };
		const sourceEntries: SourceEntry[] = [];
		let sourceOffset = 0;
		for (const character of Array.from(piece)) {
			const sourceLogicalStart = sourceLogicalStarts?.[sourceOffset] ?? logicalStart + sourceOffset;
			sourceEntries.push({ character, logicalStart: sourceLogicalStart, verticalOrientation: projectFontUnicodeVerticalOrientation(character) });
			sourceOffset += character.length;
		}
		const shapeSegment = (entries: SourceEntry[], baselineGlyphOrientation: BaselineGlyphOrientation): ShapedGlyph[] => {
			let shapedText = "";
			const logicalByCodeUnit: number[] = [];
			const renderScaleByCodeUnit: number[] = [];
			const wordSpaceByCodeUnit: boolean[] = [];
			const verticalOrientationByCodeUnit: ProjectFontUnicodeVerticalOrientation[] = [];
			for (const entry of entries) {
				const fauxSmallCaps = run.fontCaps === "small-caps" && !runSupportsOpenTypeSmallCaps[fontRunIndex] && projectFontIsLowercaseCharacter(entry.character);
				const capsTransformed = (run.fontCaps === "all-caps" || fauxSmallCaps) && !/[\r\n\t]/.test(entry.character) ? entry.character.toUpperCase() : entry.character;
				const transformed = projectFontHindiNumbersText(capsTransformed, run.hindiNumbers);
				const transformedStart = shapedText.length;
				shapedText += transformed;
				for (let index = transformedStart; index < shapedText.length; ++index) {
					logicalByCodeUnit[index] = entry.logicalStart;
					renderScaleByCodeUnit[index] =
						(fauxSmallCaps ? (run.smallCapScale ?? 0.7) : 1) *
						projectFontBaselineAppliedScale(run, runBaselineFeatures[fontRunIndex]) *
						(run.wariChuEnabled === true ? (run.wariChuScale ?? 0.5) : 1);
					wordSpaceByCodeUnit[index] = entry.character === " ";
					verticalOrientationByCodeUnit[index] = entry.verticalOrientation;
				}
			}
			const shapingDirection: ShapedGlyph["shapingDirection"] = vertical && baselineGlyphOrientation === "upright" ? "ttb" : direction === "rtl" ? "rtl" : "ltr";
			const buffer = new hb.Buffer();
			buffer.addText(shapedText);
			buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_CHARACTERS);
			buffer.guessSegmentProperties();
			buffer.setDirection(shapingDirection === "ttb" ? hb.Direction.TTB : shapingDirection === "rtl" ? hb.Direction.RTL : hb.Direction.LTR);
			if (shaping.script) {
				buffer.setScript(shaping.script);
			}
			if (runEffectiveLanguages[fontRunIndex]) {
				buffer.setLanguage(runEffectiveLanguages[fontRunIndex]!);
			}
			hb.shape(runFonts[fontRunIndex], buffer, runFeatures[fontRunIndex]);
			return buffer.getGlyphInfosAndPositions().map((glyph): ShapedGlyph => {
				const mappedLogicalStart = logicalByCodeUnit[glyph.cluster] ?? entries[0]?.logicalStart ?? logicalStart;
				return {
					runIndex: ownerAtCluster(mappedLogicalStart),
					wordSpace: wordSpaceByCodeUnit[glyph.cluster] ?? false,
					renderScale: renderScaleByCodeUnit[glyph.cluster] ?? 1,
					baselineGlyphOrientation,
					unicodeVerticalOrientation: vertical ? (verticalOrientationByCodeUnit[glyph.cluster] ?? null) : null,
					shapingDirection,
					glyphId: glyph.codepoint,
					cluster: mappedLogicalStart,
					flags: glyph.flags,
					xAdvance: glyph.xAdvance ?? 0,
					yAdvance: glyph.yAdvance ?? 0,
					xOffset: glyph.xOffset ?? 0,
					yOffset: glyph.yOffset ?? 0,
				};
			});
		};
		const segments: Array<{ entries: SourceEntry[]; orientation: BaselineGlyphOrientation }> = [];
		const appendSegment = (entry: SourceEntry, orientation: BaselineGlyphOrientation): void => {
			const last = segments.at(-1);
			if (last?.orientation === orientation) {
				last.entries.push(entry);
			} else {
				segments.push({ entries: [entry], orientation });
			}
		};
		for (const entry of sourceEntries) {
			const orientation: BaselineGlyphOrientation = !vertical
				? "horizontal-no-op"
				: run.baselineDirection === "tate-chu-yoko"
					? "tate-chu-yoko-horizontal"
					: run.baselineDirection === "mixed" && (entry.verticalOrientation === "R" || entry.verticalOrientation === "Tr")
						? "sideways-clockwise"
						: "upright";
			appendSegment(entry, orientation);
		}
		const glyphs = segments.flatMap((segment) => shapeSegment(segment.entries, segment.orientation));
		const missing = glyphs.filter((glyph) => glyph.glyphId === 0).map((glyph) => glyph.cluster);
		if (missing.length) {
			throw new Error(`Project font for PSD style run ${run.sourceStyleRunIndex} is missing shaped cluster(s): ${[...new Set(missing)].join(", ")}.`);
		}
		if (register) {
			for (const glyph of glyphs) {
				runGlyphs[glyph.runIndex].push(glyph);
			}
		}
		return glyphs;
	};
	const ownerForEntries = (entries: ReturnType<typeof normalizeBidiTextLines>[number], cluster: number): number => {
		const exact = entries.find((entry) => cluster >= entry.logicalStart && cluster < entry.logicalStart + entry.logicalLength);
		if (exact) {
			return exact.runIndex;
		}
		for (let index = entries.length - 1; index >= 0; --index) {
			if (cluster >= entries[index].logicalStart) {
				return entries[index].runIndex;
			}
		}
		return entries[0].runIndex;
	};
	let bidiEvidence: IProjectFontBidiEvidence | null = null;
	if (shaping.bidirectional) {
		const normalizedLines = normalizeBidiTextLines(options.runs);
		lines.length = 0;
		let codePointCount = 0;
		let controlCount = 0;
		let mirroredCharacterCount = 0;
		const visualRuns: IProjectFontBidiVisualRunEvidence[] = [];
		for (let lineIndex = 0; lineIndex < normalizedLines.length; ++lineIndex) {
			const entries = normalizedLines[lineIndex];
			codePointCount += entries.length;
			const proxyText = entries.map((entry) => bidiProxyCharacter(entry.character, entry.characterDirection, entry.control)).join("");
			const embedding = bidi.getEmbeddingLevels(proxyText, shaping.direction);
			const mirrorText = entries.map((entry) => bidiProxyCharacter(entry.character, null, entry.control)).join("");
			const mirroredCharacters = bidi.getMirroredCharactersMap(mirrorText, embedding.levels);
			const visualIndices = entries.map((_, index) => index);
			for (const [start, end] of bidi.getReorderSegments(proxyText, embedding)) {
				for (let left = start, right = end; left < right; ++left, --right) {
					[visualIndices[left], visualIndices[right]] = [visualIndices[right], visualIndices[left]];
				}
			}
			const line: ShapedGroup[] = [];
			let pending: number[] = [];
			const flush = (): void => {
				if (!pending.length) {
					return;
				}
				const first = entries[pending[0]];
				const level = embedding.levels[pending[0]];
				const logicalIndices = [...pending].sort((left, right) => left - right);
				const logicalEntries = logicalIndices.map((index) => entries[index]);
				const logicalStart = logicalEntries[0].logicalStart;
				const logicalEnd = logicalEntries[logicalEntries.length - 1].logicalStart + logicalEntries[logicalEntries.length - 1].logicalLength;
				const direction = level % 2 === 0 ? "ltr" : "rtl";
				const glyphs = shapePiece(
					first.runIndex,
					logicalIndices
						.map((proxyIndex) => {
							if (mirroredCharacters.has(proxyIndex)) {
								mirroredCharacterCount++;
							}
							// HarfBuzz applies the Unicode mirrored glyph for odd-direction runs; replacing the character here would mirror it twice.
							return entries[proxyIndex].character;
						})
						.join(""),
					logicalStart,
					direction,
					(cluster) => ownerForEntries(logicalEntries, cluster),
					{
						sourceLogicalStarts: logicalEntries.flatMap((entry) => Array.from({ length: entry.character.length }, () => entry.logicalStart)),
					}
				);
				const sourceStyleRunIndices = [...new Set(logicalEntries.map((entry) => options.runs[entry.runIndex].sourceStyleRunIndex))];
				const evidence: IProjectFontBidiVisualRunEvidence = {
					lineIndex,
					visualIndex: line.length,
					logicalStart,
					logicalLength: logicalEnd - logicalStart,
					embeddingLevel: level,
					direction,
					sourceStyleRunIndex: options.runs[first.runIndex].sourceStyleRunIndex,
					sourceStyleRunIndices,
					crossStyle: sourceStyleRunIndices.length > 1,
					glyphCount: glyphs.length,
				};
				visualRuns.push(evidence);
				line.push({ runIndex: first.runIndex, glyphs, tab: false, logicalStart, bidiRun: evidence });
				pending = [];
			};
			for (const logicalIndex of visualIndices) {
				const entry = entries[logicalIndex];
				if (entry.control) {
					flush();
					controlCount++;
					continue;
				}
				if (entry.character === "\t") {
					flush();
					const evidence: IProjectFontBidiVisualRunEvidence = {
						lineIndex,
						visualIndex: line.length,
						logicalStart: entry.logicalStart,
						logicalLength: 1,
						embeddingLevel: embedding.levels[logicalIndex],
						direction: embedding.levels[logicalIndex] % 2 === 0 ? "ltr" : "rtl",
						sourceStyleRunIndex: options.runs[entry.runIndex].sourceStyleRunIndex,
						sourceStyleRunIndices: [options.runs[entry.runIndex].sourceStyleRunIndex],
						crossStyle: false,
						glyphCount: 0,
					};
					visualRuns.push(evidence);
					line.push({ runIndex: entry.runIndex, glyphs: [], tab: true, logicalStart: entry.logicalStart, bidiRun: evidence });
					continue;
				}
				const previousIndex = pending[pending.length - 1];
				const level = embedding.levels[logicalIndex];
				const expectedStep = level % 2 === 0 ? 1 : -1;
				if (
					pending.length &&
					((entries[previousIndex].runIndex !== entry.runIndex &&
						(hasManualKerningBoundary(entries[previousIndex].runIndex, entry.runIndex) ||
							!shaping.joinAcrossStyleRuns ||
							runFontIdentities[entries[previousIndex].runIndex] !== runFontIdentities[entry.runIndex] ||
							runFeatureSignatures[entries[previousIndex].runIndex] !== runFeatureSignatures[entry.runIndex])) ||
						embedding.levels[previousIndex] !== level ||
						logicalIndex !== previousIndex + expectedStep)
				) {
					flush();
				}
				pending.push(logicalIndex);
			}
			flush();
			lines.push(line);
		}
		bidiEvidence = {
			engine: "bidi-js",
			version: bidiVersion,
			unicodeVersion: "13.0.0",
			executionModel: "bounded-uax9-bidi-runs-v1",
			baseDirection: shaping.direction,
			paragraphCount: normalizedLines.length,
			codePointCount,
			controlCount,
			mirroredCharacterCount,
			visualRuns,
		};
	} else if (shaping.joinAcrossStyleRuns) {
		const normalizedLines = normalizeBidiTextLines(options.runs);
		lines.length = 0;
		for (const entries of normalizedLines) {
			const line: ShapedGroup[] = [];
			let pending: typeof entries = [];
			const flush = (): void => {
				if (!pending.length) {
					return;
				}
				const logicalStart = pending[0].logicalStart;
				const glyphs = shapePiece(
					pending[0].runIndex,
					pending.map((entry) => entry.character).join(""),
					logicalStart,
					shaping.direction,
					(cluster) => ownerForEntries(pending, cluster),
					{
						sourceLogicalStarts: pending.flatMap((entry) => Array.from({ length: entry.character.length }, () => entry.logicalStart)),
					}
				);
				line.push({ runIndex: pending[0].runIndex, glyphs, tab: false, logicalStart, bidiRun: null });
				pending = [];
			};
			for (const entry of entries) {
				if (entry.character === "\t") {
					flush();
					line.push({ runIndex: entry.runIndex, glyphs: [], tab: true, logicalStart: entry.logicalStart, bidiRun: null });
					continue;
				}
				if (
					pending.length &&
					(hasManualKerningBoundary(pending[pending.length - 1].runIndex, entry.runIndex) ||
						runFontIdentities[pending[pending.length - 1].runIndex] !== runFontIdentities[entry.runIndex] ||
						runFeatureSignatures[pending[pending.length - 1].runIndex] !== runFeatureSignatures[entry.runIndex])
				) {
					flush();
				}
				pending.push(entry);
			}
			flush();
			lines.push(line);
		}
	} else {
		let globalRunOffset = 0;
		for (let runIndex = 0; runIndex < options.runs.length; ++runIndex) {
			const normalizedText = options.runs[runIndex].text.replace(/\r\n?/g, "\n");
			let runOffset = globalRunOffset;
			const lineParts = normalizedText.split("\n");
			for (let linePartIndex = 0; linePartIndex < lineParts.length; ++linePartIndex) {
				const pieces = lineParts[linePartIndex].match(/[^\t]+|\t/g) ?? [];
				for (const piece of pieces) {
					if (piece === "\t") {
						lines[lines.length - 1].push({ runIndex, glyphs: [], tab: true, logicalStart: runOffset, bidiRun: null });
						runOffset++;
						continue;
					}
					const glyphs = shapePiece(runIndex, piece, runOffset, shaping.direction);
					lines[lines.length - 1].push({ runIndex, glyphs, tab: false, logicalStart: runOffset, bidiRun: null });
					runOffset += piece.length;
				}
				if (linePartIndex < lineParts.length - 1) {
					lines.push([]);
					runOffset++;
				}
			}
			globalRunOffset += normalizedText.length;
		}
	}
	const kashidaAtlasGlyphs: ShapedGlyph[][] = options.runs.map(() => []);
	if (!vertical && options.runs.some((run) => run.kashida === true)) {
		const fullText = options.runs.map((run) => run.text).join("");
		const runAt = (logicalOffset: number): number => projectFontStyleRunIndexAt(options.runs, logicalOffset);
		for (const candidate of projectFontKashidaCandidates(fullText, 0, runAt, options.runs)) {
			const rightRunIndex = runAt(candidate.insertionOffset);
			if (
				runFontIdentities[candidate.ownerRunIndex] !== runFontIdentities[rightRunIndex] ||
				runFeatureSignatures[candidate.ownerRunIndex] !== runFeatureSignatures[rightRunIndex]
			) {
				continue;
			}
			const rightCharacter = Array.from(fullText.slice(candidate.insertionOffset))[0];
			if (!rightCharacter) {
				continue;
			}
			const context = `${fullText.slice(candidate.ownerLogicalStart, candidate.insertionOffset)}\u0640\u0640\u0640${rightCharacter}`;
			for (const direction of ["ltr", "rtl"] as const) {
				kashidaAtlasGlyphs[candidate.ownerRunIndex].push(
					...shapePiece(candidate.ownerRunIndex, context, candidate.ownerLogicalStart, direction, () => candidate.ownerRunIndex, { register: false })
				);
			}
		}
	}
	const needsVirtualHyphens = options.boxLayout !== undefined && options.paragraphRuns?.some((run) => run.autoHyphenate) === true;
	const virtualHyphens = options.runs.map((_, runIndex) =>
		needsVirtualHyphens
			? {
					ltr: shapePiece(runIndex, "-", 0, "ltr", () => runIndex, { register: false }),
					rtl: shapePiece(runIndex, "-", 0, "rtl", () => runIndex, { register: false }),
				}
			: { ltr: [], rtl: [] }
	);
	const uniqueFontGlyphPairs = new Set<string>();
	for (let runIndex = 0; runIndex < options.runs.length; ++runIndex) {
		for (const glyph of [...runGlyphs[runIndex], ...virtualHyphens[runIndex].ltr, ...virtualHyphens[runIndex].rtl, ...kashidaAtlasGlyphs[runIndex]]) {
			uniqueFontGlyphPairs.add(`${options.runs[runIndex].fontPath}\0${glyph.glyphId}`);
		}
	}
	if (uniqueFontGlyphPairs.size > 1024) {
		throw new Error("PSD complex-text shaping supports at most 1,024 unique font/glyph-ID pairs per layer.");
	}
	const preparedRuns: PreparedRun[] = [];
	for (let runIndex = 0; runIndex < options.runs.length; ++runIndex) {
		const run = options.runs[runIndex];
		const glyphIds = [
			...new Set([...runGlyphs[runIndex], ...virtualHyphens[runIndex].ltr, ...virtualHyphens[runIndex].rtl, ...kashidaAtlasGlyphs[runIndex]].map((glyph) => glyph.glyphId)),
		];
		const generator = await Msdfgen.create(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
		generator.loadFont(run.fontBytes);
		const glyphById = loadExactGlyphIds(generator, glyphIds);
		const distanceRange = Math.max(4, Math.ceil((run.strokeEnabled === false ? 0 : (run.outlineWidth ?? 1)) / 2 + 1));
		const bins = generator.packGlyphs(
			{ size: run.fontSize, range: distanceRange, edgeColoring: "inktrap", edgeThresholdAngle: 3, scanline: false },
			{ maxWidth: 2048, maxHeight: 2048, padding: 1, pot: true, smart: true, allowRotation: false }
		);
		const atlasPages = await Promise.all(
			bins.map(async (bin) => {
				const decoded = await sharp(generator.createAtlasImage(bin)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
				return { pixels: decoded.data, width: decoded.info.width, distanceRange };
			})
		);
		const placements = new Map<number, GlyphPlacement>();
		for (let page = 0; page < bins.length; ++page) {
			for (const rectangle of bins[page].rects) {
				placements.set(rectangle.glyph.index, {
					x: rectangle.x,
					y: rectangle.y,
					width: rectangle.width,
					height: rectangle.height,
					page,
					xOffset: (rectangle.glyph.left - rectangle.msdfData.range / 2) * run.fontSize,
					range: rectangle.msdfData.range,
				});
			}
		}
		preparedRuns.push({
			request: run,
			generator,
			upem: runUpems[runIndex],
			baseAlignmentMetrics: runBaseAlignmentMetrics[runIndex],
			glyphById,
			placements,
			atlasPages,
			shapedGlyphs: runGlyphs[runIndex],
			glyphCount: 0,
			fillPixelCount: 0,
			strokePixelCount: 0,
		});
	}
	const fauxBoldPixels = (run: IProjectFontTextStyleRunOptions): number => (run.fauxBold ? Math.min(8, Math.max(1, Math.round(run.fontSize / 24))) : 0);
	const horizontalScale = (run: IProjectFontTextStyleRunOptions): number => (run.horizontalScale ?? 100) / 100;
	const verticalScale = (run: IProjectFontTextStyleRunOptions): number => (run.verticalScale ?? 100) / 100;
	const primaryScale = (run: IProjectFontTextStyleRunOptions): number => (vertical ? verticalScale(run) : horizontalScale(run));
	type DiacriticGlyphAdjustment = {
		placement: "above" | "below";
		authoredVerticalShift: number;
		effectiveYOffset: number;
	};
	const diacriticAdjustment = (glyph: ShapedGlyph, character: string): DiacriticGlyphAdjustment | null => {
		const run = preparedRuns[glyph.runIndex];
		const position = run.request.diacriticPosition;
		if (vertical || position === null || position === undefined) {
			return null;
		}
		const placement = projectFontDiacriticPlacement(character, glyph.yOffset);
		const direction = placement === "above" ? 1 : -1;
		const authoredVerticalShift = projectFontDiacriticPositionEmShift(position) * run.request.fontSize * verticalScale(run.request) * glyph.renderScale * direction;
		const fontUnitShift =
			run.request.fontSize * verticalScale(run.request) * glyph.renderScale === 0
				? 0
				: (authoredVerticalShift * run.upem) / (run.request.fontSize * verticalScale(run.request) * glyph.renderScale);
		return { placement, authoredVerticalShift, effectiveYOffset: glyph.yOffset + fontUnitShift };
	};
	const combiningMarksAtCluster = (cluster: number): string[] => {
		const characters = Array.from(authoredText.slice(cluster));
		const start = /\p{Mark}/u.test(characters[0] ?? "") ? 0 : 1;
		const marks: string[] = [];
		for (let index = start; index < characters.length && /\p{Mark}/u.test(characters[index]); ++index) {
			marks.push(characters[index]);
		}
		return marks;
	};
	const glyphUsesHorizontalMetrics = (glyph: ShapedGlyph): boolean =>
		!vertical || glyph.baselineGlyphOrientation === "sideways-clockwise" || glyph.baselineGlyphOrientation === "tate-chu-yoko-horizontal";
	const glyphPrimaryScale = (glyph: ShapedGlyph): number => {
		const run = preparedRuns[glyph.runIndex].request;
		return glyphUsesHorizontalMetrics(glyph) ? horizontalScale(run) : verticalScale(run);
	};
	type TsumeAdjustment = {
		leadingTrim: number;
		trailingTrim: number;
		advanceBefore: number;
		advanceAfter: number;
	};
	const tsumeAdjustment = (shapedGlyph: ShapedGlyph): TsumeAdjustment => {
		const run = preparedRuns[shapedGlyph.runIndex];
		const glyph = run.glyphById.get(shapedGlyph.glyphId)!;
		const amount = run.request.tsume ?? 0;
		const horizontalMetrics = glyphUsesHorizontalMetrics(shapedGlyph);
		const advanceBefore =
			(((horizontalMetrics ? shapedGlyph.xAdvance : Math.abs(shapedGlyph.yAdvance)) * run.request.fontSize * shapedGlyph.renderScale) / run.upem) *
			glyphPrimaryScale(shapedGlyph);
		if (amount <= 0 || advanceBefore <= 0) {
			return { leadingTrim: 0, trailingTrim: 0, advanceBefore, advanceAfter: advanceBefore };
		}
		const inkStart = !horizontalMetrics
			? -(shapedGlyph.yOffset / run.upem + glyph.top) * run.request.fontSize * shapedGlyph.renderScale * verticalScale(run.request)
			: (shapedGlyph.xOffset / run.upem + glyph.left) * run.request.fontSize * shapedGlyph.renderScale * horizontalScale(run.request);
		const inkEnd = !horizontalMetrics
			? -(shapedGlyph.yOffset / run.upem + glyph.bottom) * run.request.fontSize * shapedGlyph.renderScale * verticalScale(run.request)
			: (shapedGlyph.xOffset / run.upem + glyph.right) * run.request.fontSize * shapedGlyph.renderScale * horizontalScale(run.request);
		const inkMinimum = Math.min(inkStart, inkEnd);
		const inkMaximum = Math.max(inkStart, inkEnd);
		const leadingTrim = Math.max(0, inkMinimum) * amount;
		const trailingTrim = Math.max(0, advanceBefore - inkMaximum) * amount;
		const reduction = Math.min(advanceBefore, leadingTrim + trailingTrim);
		const reductionScale = leadingTrim + trailingTrim > 0 ? reduction / (leadingTrim + trailingTrim) : 0;
		return {
			leadingTrim: leadingTrim * reductionScale,
			trailingTrim: trailingTrim * reductionScale,
			advanceBefore,
			advanceAfter: advanceBefore - reduction,
		};
	};
	const manualKerningPixels = (runIndex: number, orientation?: BaselineGlyphOrientation): number => {
		const scale =
			vertical && (orientation === "sideways-clockwise" || orientation === "tate-chu-yoko-horizontal")
				? horizontalScale(options.runs[runIndex])
				: primaryScale(options.runs[runIndex]);
		return (((options.runs[runIndex].kerning ?? 0) * options.runs[runIndex].fontSize) / 1000) * scale;
	};
	const manualKerningBetween = (left: ShapedGlyph, right: ShapedGlyph): number => {
		const ownerRunIndex = projectFontManualKerningOwnerRun(left.runIndex, right.runIndex, options.runs);
		return ownerRunIndex === null ? 0 : manualKerningPixels(ownerRunIndex, left.baselineGlyphOrientation);
	};
	const nextShapedGlyphAt = (groups: ShapedGroup[], groupIndex: number, glyphIndex: number): ShapedGlyph | undefined => {
		const group = groups[groupIndex];
		const local = group.glyphs[glyphIndex + 1];
		if (local) {
			return local;
		}
		const nextGroup = groups[groupIndex + 1];
		return nextGroup && !nextGroup.tab ? nextGroup.glyphs[0] : undefined;
	};
	type WariChuRowMetrics = {
		rowIndex: number;
		glyphs: ShapedGlyph[];
		logicalStart: number;
		logicalEnd: number;
		clusterCount: number;
		rawAdvance: number;
		alignedStart: number;
		extraClusterSpacing: number;
		resolvedJustification: "left" | "right" | "center" | "justify";
	};
	type WariChuMetrics = { cellAdvance: number; crossSpan: number; rows: WariChuRowMetrics[] };
	const wariChuMetricsCache = new WeakMap<ShapedGroup, WariChuMetrics | null>();
	const rawGroupAdvance = (group: ShapedGroup): number => {
		if (group.tab) {
			const run = preparedRuns[group.runIndex];
			return run.generator.metrics.tabAdvance * run.request.fontSize * primaryScale(run.request);
		}
		if (vertical && group.glyphs.every((glyph) => glyph.baselineGlyphOrientation === "tate-chu-yoko-horizontal")) {
			return Math.max(
				...group.glyphs.map((glyph) => {
					const run = preparedRuns[glyph.runIndex];
					return run.request.fontSize * glyph.renderScale * verticalScale(run.request);
				})
			);
		}
		return group.glyphs.reduce((width, glyph) => {
			const run = preparedRuns[glyph.runIndex];
			const tsume = tsumeAdjustment(glyph);
			return width + tsume.advanceAfter + fauxBoldPixels(run.request) * glyph.renderScale;
		}, 0);
	};
	const wariChuMetrics = (group: ShapedGroup): WariChuMetrics | null => {
		const cached = wariChuMetricsCache.get(group);
		if (cached !== undefined) {
			return cached;
		}
		if (!group.glyphs.length || !group.glyphs.every((glyph) => glyph.runIndex === group.runIndex) || preparedRuns[group.runIndex].request.wariChuEnabled !== true) {
			wariChuMetricsCache.set(group, null);
			return null;
		}
		const run = preparedRuns[group.runIndex];
		const lineCount = run.request.wariChuLineCount ?? 2;
		const widow = run.request.wariChuWidow ?? 2;
		const orphan = run.request.wariChuOrphan ?? 2;
		const scale = run.request.wariChuScale ?? 0.5;
		const justification = run.request.wariChuJustification ?? "auto";
		type ClusterUnit = { cluster: number; glyphs: ShapedGlyph[] };
		const units: ClusterUnit[] = [];
		for (const glyph of group.glyphs) {
			const previous = units.at(-1);
			if (previous?.cluster === glyph.cluster) {
				previous.glyphs.push(glyph);
			} else {
				units.push({ cluster: glyph.cluster, glyphs: [glyph] });
			}
		}
		const minimumCounts = Array.from({ length: lineCount }, (_, index) => (index === 0 ? widow : index === lineCount - 1 ? orphan : Math.max(widow, orphan)));
		const requiredClusters = minimumCounts.reduce((sum, count) => sum + count, 0);
		if (units.length < requiredClusters) {
			throw new Error(
				`PSD styled-text run ${run.request.sourceStyleRunIndex} Wari-chu requires at least ${requiredClusters} shaped clusters for ${lineCount} sublines with widow ${widow} and orphan ${orphan}; found ${units.length}.`
			);
		}
		const flattened = (start: number, end: number): ShapedGlyph[] => units.slice(start, end).flatMap((unit) => unit.glyphs);
		const measure = (start: number, end: number): number => {
			const glyphs = flattened(start, end);
			let result = 0;
			for (let index = 0; index < glyphs.length; ++index) {
				const glyph = glyphs[index];
				result += tsumeAdjustment(glyph).advanceAfter + fauxBoldPixels(run.request) * glyph.renderScale;
				if (index + 1 < glyphs.length) {
					result += ((run.request.tracking * run.request.fontSize) / 1000) * glyphPrimaryScale(glyph) * scale + manualKerningBetween(glyph, glyphs[index + 1]) * scale;
				}
			}
			return result;
		};
		const targetAdvance = measure(0, units.length) / lineCount;
		type Partition = { score: number; boundaries: number[] };
		const memo = new Map<string, Partition | null>();
		const partition = (rowIndex: number, start: number): Partition | null => {
			const key = `${rowIndex}:${start}`;
			if (memo.has(key)) {
				return memo.get(key)!;
			}
			const minimum = minimumCounts[rowIndex];
			if (rowIndex === lineCount - 1) {
				const result = units.length - start >= minimum ? { score: Math.pow(measure(start, units.length) - targetAdvance, 2), boundaries: [units.length] } : null;
				memo.set(key, result);
				return result;
			}
			const remainingMinimum = minimumCounts.slice(rowIndex + 1).reduce((sum, count) => sum + count, 0);
			let best: Partition | null = null;
			for (let end = start + minimum; end <= units.length - remainingMinimum; ++end) {
				const tail = partition(rowIndex + 1, end);
				if (!tail) {
					continue;
				}
				const score = Math.pow(measure(start, end) - targetAdvance, 2) + tail.score;
				if (!best || score < best.score || (score === best.score && end < best.boundaries[0])) {
					best = { score, boundaries: [end, ...tail.boundaries] };
				}
			}
			memo.set(key, best);
			return best;
		};
		const selected = partition(0, 0);
		if (!selected) {
			throw new Error(`PSD styled-text run ${run.request.sourceStyleRunIndex} Wari-chu could not satisfy its authored subline break constraints.`);
		}
		let start = 0;
		const rawRows = selected.boundaries.map((end, rowIndex) => {
			const glyphs = flattened(start, end);
			const result = { rowIndex, start, end, glyphs, rawAdvance: measure(start, end) };
			start = end;
			return result;
		});
		const cellAdvance = Math.max(...rawRows.map((row) => row.rawAdvance));
		const rows = rawRows.map((row): WariChuRowMetrics => {
			const finalRow = row.rowIndex === rawRows.length - 1;
			const resolvedJustification: WariChuRowMetrics["resolvedJustification"] =
				justification === "left"
					? "left"
					: justification === "right"
						? "right"
						: justification === "center"
							? "center"
							: justification === "justify-all" || (!finalRow && ["justify-left", "justify-right", "justify-center", "auto"].includes(justification))
								? "justify"
								: justification === "justify-right"
									? "right"
									: justification === "justify-center"
										? "center"
										: "left";
			const alignedStart = resolvedJustification === "right" ? cellAdvance - row.rawAdvance : resolvedJustification === "center" ? (cellAdvance - row.rawAdvance) / 2 : 0;
			const extraClusterSpacing = resolvedJustification === "justify" && row.end - row.start > 1 ? (cellAdvance - row.rawAdvance) / (row.end - row.start - 1) : 0;
			const nextBoundary = rawRows[row.rowIndex + 1]?.start;
			return {
				rowIndex: row.rowIndex,
				glyphs: row.glyphs,
				logicalStart: Math.min(...row.glyphs.map((glyph) => glyph.cluster)),
				logicalEnd: nextBoundary === undefined ? Math.max(...row.glyphs.map((glyph) => glyph.cluster)) + 1 : units[nextBoundary].cluster,
				clusterCount: row.end - row.start,
				rawAdvance: row.rawAdvance,
				alignedStart,
				extraClusterSpacing,
				resolvedJustification,
			};
		});
		const crossScale = vertical ? horizontalScale(run.request) : verticalScale(run.request);
		const metrics = {
			cellAdvance,
			crossSpan: lineCount * run.request.fontSize * scale * crossScale + (lineCount - 1) * (run.request.wariChuLineGap ?? 0),
			rows,
		};
		wariChuMetricsCache.set(group, metrics);
		return metrics;
	};
	const groupAdvance = (group: ShapedGroup): number => wariChuMetrics(group)?.cellAdvance ?? rawGroupAdvance(group);
	const tateChuYokoMetrics = (group: ShapedGroup): { rawAdvance: number; fittedAdvance: number; cellAdvance: number; fitScale: number } | null => {
		if (!vertical || !group.glyphs.length || !group.glyphs.every((glyph) => glyph.baselineGlyphOrientation === "tate-chu-yoko-horizontal")) {
			return null;
		}
		let rawAdvance = 0;
		for (let glyphIndex = 0; glyphIndex < group.glyphs.length; ++glyphIndex) {
			const glyph = group.glyphs[glyphIndex];
			const run = preparedRuns[glyph.runIndex];
			rawAdvance += tsumeAdjustment(glyph).advanceAfter + fauxBoldPixels(run.request) * glyph.renderScale;
			const next = group.glyphs[glyphIndex + 1];
			if (next) {
				rawAdvance += ((run.request.tracking * run.request.fontSize) / 1000) * horizontalScale(run.request) + manualKerningBetween(glyph, next);
			}
		}
		const cellAdvance = groupAdvance(group);
		const cellWidth = Math.max(
			...group.glyphs.map((glyph) => {
				const run = preparedRuns[glyph.runIndex];
				return run.request.fontSize * glyph.renderScale * horizontalScale(run.request);
			})
		);
		const fitScale = rawAdvance > 0 ? Math.min(1, cellWidth / rawAdvance) : 1;
		return { rawAdvance, fittedAdvance: rawAdvance * fitScale, cellAdvance, fitScale };
	};
	const shapedGroupsAdvance = (groups: ShapedGroup[]): number => {
		let result = groups.reduce((sum, group) => sum + groupAdvance(group), 0);
		for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
			for (let glyphIndex = 0; glyphIndex < groups[groupIndex].glyphs.length; ++glyphIndex) {
				const glyph = groups[groupIndex].glyphs[glyphIndex];
				const next = nextShapedGlyphAt(groups, groupIndex, glyphIndex);
				if (
					next &&
					!(tateChuYokoMetrics(groups[groupIndex]) && glyphIndex + 1 < groups[groupIndex].glyphs.length) &&
					!(wariChuMetrics(groups[groupIndex]) && glyphIndex + 1 < groups[groupIndex].glyphs.length)
				) {
					const run = preparedRuns[glyph.runIndex];
					result += ((run.request.tracking * run.request.fontSize) / 1000) * glyphPrimaryScale(glyph) + manualKerningBetween(glyph, next);
				}
			}
		}
		return result;
	};
	const authoredLogicalLines = authoredProjectFontLogicalLines(options.runs.map((run) => run.text).join(""));
	let logicalLines = authoredLogicalLines;
	let noBreakPreventedBreakCount = 0;
	const boxLayout = validateProjectFontTextBoxLayout(options.boxLayout);
	if (boxLayout) {
		const fullText = options.runs.map((run) => run.text).join("");
		const authoredShapedLines = [...lines];
		const composedLines: ShapedGroup[][] = [];
		const composedLogicalLines: IProjectFontLogicalLine[] = [];
		const slicedGroups = (groups: ShapedGroup[], logicalStart: number, logicalEnd: number, hyphenRunIndex: number | null): ShapedGroup[] => {
			const sliced = groups
				.map((group) =>
					group.tab
						? group.logicalStart >= logicalStart && group.logicalStart < logicalEnd
							? { ...group }
							: null
						: {
								...group,
								glyphs: group.glyphs.filter((glyph) => glyph.cluster >= logicalStart && glyph.cluster < logicalEnd),
							}
				)
				.filter((group): group is ShapedGroup => group !== null && (group.tab || group.glyphs.length > 0));
			if (hyphenRunIndex !== null) {
				const direction = sliced.findLast((group) => group.bidiRun)?.bidiRun?.direction ?? shaping.direction;
				const glyphs = virtualHyphens[hyphenRunIndex][direction].map((glyph) => ({
					...glyph,
					runIndex: hyphenRunIndex,
					cluster: logicalEnd,
					wordSpace: false,
					virtualHyphen: true,
				}));
				const hyphenGroup: ShapedGroup = { runIndex: hyphenRunIndex, glyphs, tab: false, logicalStart: logicalEnd, bidiRun: null };
				if (direction === "rtl" && !vertical) {
					sliced.unshift(hyphenGroup);
				} else {
					sliced.push(hyphenGroup);
				}
			}
			return sliced;
		};
		for (let authoredLineIndex = 0; authoredLineIndex < authoredShapedLines.length; ++authoredLineIndex) {
			const authoredLine = authoredLogicalLines[authoredLineIndex];
			const authoredGroups = authoredShapedLines[authoredLineIndex];
			if (!authoredGroups.length) {
				composedLines.push([]);
				composedLogicalLines.push(authoredLine);
				continue;
			}
			const paragraphRun =
				options.paragraphRuns?.find((run) => authoredLine.logicalStart >= run.start && authoredLine.logicalStart < run.start + run.length) ??
				options.paragraphRuns?.[options.paragraphRuns.length - 1];
			const primarySpan = (firstLine: boolean): number => {
				const result =
					(vertical ? boxLayout.bottom - boxLayout.top : boxLayout.right - boxLayout.left) -
					(paragraphRun?.startIndent ?? 0) -
					(paragraphRun?.endIndent ?? 0) -
					(firstLine ? (paragraphRun?.firstLineIndent ?? 0) : 0);
				if (result <= 0) {
					throw new Error(`PSD paragraph run ${paragraphRun?.sourceParagraphRunIndex ?? 0} indents leave no positive authored box-text wrapping span.`);
				}
				return result;
			};
			const clusterBoundaries = new Set<number>([authoredLine.logicalStart, authoredLine.logicalEnd]);
			for (const group of authoredGroups) {
				if (group.tab) {
					clusterBoundaries.add(group.logicalStart);
					clusterBoundaries.add(group.logicalStart + 1);
				} else {
					for (const glyph of group.glyphs) {
						clusterBoundaries.add(glyph.cluster);
					}
				}
			}
			const composition = composeProjectFontAuthoredBoxLine({
				fullText,
				authoredLine,
				paragraphRun,
				styleRuns: options.runs,
				primarySpan,
				canBreakAt: (logicalOffset) =>
					clusterBoundaries.has(logicalOffset) &&
					!options.runs.some(
						(run, runIndex) => run.wariChuEnabled === true && logicalOffset > runStarts[runIndex] && logicalOffset < runStarts[runIndex] + run.text.length
					),
				onNoBreakPreventedBreak: () => noBreakPreventedBreakCount++,
				measure: (logicalStart, logicalEnd, hyphenRunIndex) => shapedGroupsAdvance(slicedGroups(authoredGroups, logicalStart, logicalEnd, hyphenRunIndex)),
			});
			for (const logicalLine of composition) {
				const hyphenRunIndex = logicalLine.insertedHyphen ? projectFontStyleRunIndexAt(options.runs, Math.max(logicalLine.logicalStart, logicalLine.logicalEnd - 1)) : null;
				composedLines.push(slicedGroups(authoredGroups, logicalLine.logicalStart, logicalLine.logicalEnd, hyphenRunIndex));
				composedLogicalLines.push(logicalLine);
			}
		}
		lines.splice(0, lines.length, ...composedLines);
		logicalLines = composedLogicalLines;
		if (bidiEvidence) {
			const visualRuns: IProjectFontBidiVisualRunEvidence[] = [];
			for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
				for (let visualIndex = 0; visualIndex < lines[lineIndex].length; ++visualIndex) {
					const group = lines[lineIndex][visualIndex];
					if (!group.bidiRun) {
						continue;
					}
					const clusters = group.glyphs.map((glyph) => glyph.cluster);
					const logicalStart = clusters.length ? Math.min(...clusters) : group.logicalStart;
					const logicalEnd = clusters.length ? Math.max(...clusters) + 1 : logicalStart + 1;
					const evidence = {
						...group.bidiRun,
						lineIndex,
						visualIndex,
						logicalStart,
						logicalLength: logicalEnd - logicalStart,
						glyphCount: group.glyphs.length,
					};
					group.bidiRun = evidence;
					visualRuns.push(evidence);
				}
			}
			bidiEvidence = { ...bidiEvidence, visualRuns };
		}
	}
	const kashidaEligibleJoinCounts = options.runs.map(() => 0);
	const kashidaInsertedCounts = options.runs.map(() => 0);
	const kashidaInsertedAdvances = options.runs.map(() => 0);
	const kashidaFullyJustifiedRunIndices = new Set<number>();
	const kashidaJustifiedLineIndices = new Set<number>();
	if (!vertical && boxLayout && options.paragraphRuns?.length && options.runs.some((run) => run.kashida !== null && run.kashida !== undefined)) {
		const fullText = options.runs.map((run) => run.text).join("");
		const runAt = (logicalOffset: number): number => projectFontStyleRunIndexAt(options.runs, logicalOffset);
		for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
			const logicalLine = logicalLines[lineIndex];
			const paragraphRun =
				options.paragraphRuns.find((run) => logicalLine.logicalStart >= run.start && logicalLine.logicalStart < run.start + run.length) ??
				options.paragraphRuns[options.paragraphRuns.length - 1];
			const fullyJustified = paragraphRun.justification === "justify-all" || (paragraphRun.justification.startsWith("justify-") && !logicalLine.lastInParagraph);
			if (!fullyJustified) {
				continue;
			}
			for (let logicalOffset = logicalLine.logicalStart; logicalOffset < logicalLine.logicalEnd; ) {
				const runIndex = runAt(logicalOffset);
				if (options.runs[runIndex].kashida !== null && options.runs[runIndex].kashida !== undefined) {
					kashidaFullyJustifiedRunIndices.add(runIndex);
				}
				logicalOffset = Math.min(logicalLine.logicalEnd, runStarts[runIndex] + options.runs[runIndex].text.length);
			}
			type LineKashidaCandidate = ProjectFontKashidaCandidate & { groupIndex: number; key: string };
			const lineCandidates: LineKashidaCandidate[] = [];
			const groups = lines[lineIndex];
			const logicalGroupStarts = [...new Set(groups.filter((group) => !group.tab).map((group) => group.bidiRun?.logicalStart ?? group.logicalStart))].sort(
				(left, right) => left - right
			);
			for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
				const group = groups[groupIndex];
				if (group.tab || !group.glyphs.length) {
					continue;
				}
				const logicalStart = group.bidiRun?.logicalStart ?? group.logicalStart;
				const nextLogicalStart = logicalGroupStarts.find((entry) => entry > logicalStart);
				const logicalEnd = group.bidiRun ? logicalStart + group.bidiRun.logicalLength : Math.min(logicalLine.logicalEnd, nextLogicalStart ?? logicalLine.logicalEnd);
				for (const candidate of projectFontKashidaCandidates(fullText.slice(logicalStart, logicalEnd), logicalStart, runAt, options.runs)) {
					const rightRunIndex = runAt(candidate.insertionOffset);
					if (
						runFontIdentities[candidate.ownerRunIndex] !== runFontIdentities[rightRunIndex] ||
						runFeatureSignatures[candidate.ownerRunIndex] !== runFeatureSignatures[rightRunIndex]
					) {
						continue;
					}
					lineCandidates.push({ ...candidate, groupIndex, key: `${groupIndex}:${candidate.insertionOffset}` });
					kashidaEligibleJoinCounts[candidate.ownerRunIndex]++;
				}
			}
			if (!lineCandidates.length) {
				continue;
			}
			kashidaJustifiedLineIndices.add(lineIndex);
			const available =
				boxLayout.right - boxLayout.left - paragraphRun.startIndent - paragraphRun.endIndent - (logicalLine.firstInParagraph ? paragraphRun.firstLineIndent : 0);
			let currentAdvance = shapedGroupsAdvance(groups);
			if (available <= currentAdvance) {
				continue;
			}
			const counts = new Map<string, number>();
			const shapeGroupWithCounts = (groupIndex: number, nextCounts: ReadonlyMap<string, number>): ShapedGlyph[] => {
				const group = groups[groupIndex];
				const logicalStart = group.bidiRun?.logicalStart ?? group.logicalStart;
				const nextLogicalStart = logicalGroupStarts.find((entry) => entry > logicalStart);
				const logicalEnd = group.bidiRun ? logicalStart + group.bidiRun.logicalLength : Math.min(logicalLine.logicalEnd, nextLogicalStart ?? logicalLine.logicalEnd);
				const candidates = lineCandidates.filter((candidate) => candidate.groupIndex === groupIndex);
				let shapedText = "";
				const sourceLogicalStarts: number[] = [];
				for (let logicalOffset = logicalStart; logicalOffset < logicalEnd; ) {
					for (const candidate of candidates.filter((entry) => entry.insertionOffset === logicalOffset)) {
						for (let count = 0; count < (nextCounts.get(candidate.key) ?? 0); ++count) {
							shapedText += "\u0640";
							sourceLogicalStarts.push(candidate.ownerLogicalStart);
						}
					}
					const character = Array.from(fullText.slice(logicalOffset))[0];
					if (!character) {
						break;
					}
					shapedText += character;
					for (let index = 0; index < character.length; ++index) {
						sourceLogicalStarts.push(logicalOffset);
					}
					logicalOffset += character.length;
				}
				const direction = group.bidiRun?.direction ?? shaping.direction;
				return shapePiece(group.runIndex, shapedText, logicalStart, direction, runAt, { register: false, sourceLogicalStarts });
			};
			for (let inserted = 0; inserted < 64; ++inserted) {
				let selected: { candidate: LineKashidaCandidate; glyphs: ShapedGlyph[]; advance: number; delta: number } | null = null;
				const leastUsed = Math.min(...lineCandidates.map((candidate) => counts.get(candidate.key) ?? 0));
				for (const candidate of lineCandidates.filter((entry) => (counts.get(entry.key) ?? 0) === leastUsed)) {
					const trialCounts = new Map(counts);
					trialCounts.set(candidate.key, (trialCounts.get(candidate.key) ?? 0) + 1);
					const glyphs = shapeGroupWithCounts(candidate.groupIndex, trialCounts);
					const trialGroups = groups.map((group, groupIndex) => (groupIndex === candidate.groupIndex ? { ...group, glyphs } : group));
					const advance = shapedGroupsAdvance(trialGroups);
					const delta = advance - currentAdvance;
					if (delta <= 0 || advance > available + 0.001) {
						continue;
					}
					if (!selected || advance > selected.advance || (advance === selected.advance && candidate.insertionOffset < selected.candidate.insertionOffset)) {
						selected = { candidate, glyphs, advance, delta };
					}
				}
				if (!selected) {
					break;
				}
				counts.set(selected.candidate.key, (counts.get(selected.candidate.key) ?? 0) + 1);
				groups[selected.candidate.groupIndex].glyphs = selected.glyphs;
				currentAdvance = selected.advance;
				kashidaInsertedCounts[selected.candidate.ownerRunIndex]++;
				kashidaInsertedAdvances[selected.candidate.ownerRunIndex] += selected.delta;
			}
		}
		const actualGlyphs = options.runs.map(() => [] as ShapedGlyph[]);
		for (const line of lines) {
			for (const glyph of line.flatMap((group) => group.glyphs)) {
				actualGlyphs[glyph.runIndex].push(glyph);
			}
		}
		for (let runIndex = 0; runIndex < preparedRuns.length; ++runIndex) {
			preparedRuns[runIndex].shapedGlyphs = actualGlyphs[runIndex];
		}
	}
	const lineAdvances = lines.map(shapedGroupsAdvance);
	const maximumAscender = Math.max(...preparedRuns.map((run) => run.generator.metrics.ascenderY * run.request.fontSize * verticalScale(run.request)));
	type StyleRunAlignmentAdjustment = {
		lineIndex: number;
		referenceSourceStyleRunIndex: number;
		referenceEmSize: number;
		glyphEmSize: number;
		referenceCoordinate: number;
		glyphCoordinate: number;
		appliedShift: number;
		metricSource: "em-box" | "roman-baseline" | "opentype-base";
		baseScript: string | null;
		referenceBaseScript: string | null;
		baseTag: "icfb" | "icft" | "romn" | null;
		baseCoordinateFormat: 1 | 2 | 3 | null;
		referenceBaseCoordinateFormat: 1 | 2 | 3 | null;
	};
	const alignmentAdjustments = new Map<ShapedGlyph, StyleRunAlignmentAdjustment>();
	const diacriticAdjustments = new Map<ShapedGlyph, DiacriticGlyphAdjustment>();
	const consumedDiacriticMarks = new Map<string, number>();
	for (const glyph of lines.flatMap((groups) => groups.flatMap((group) => group.glyphs))) {
		const marks = combiningMarksAtCluster(glyph.cluster);
		const key = `${glyph.runIndex}:${glyph.cluster}`;
		const consumed = consumedDiacriticMarks.get(key) ?? 0;
		const character = glyph.xAdvance === 0 && glyph.yAdvance === 0 ? marks[consumed] : undefined;
		const adjustment = character ? diacriticAdjustment(glyph, character) : null;
		if (adjustment) {
			diacriticAdjustments.set(glyph, adjustment);
			consumedDiacriticMarks.set(key, consumed + 1);
		}
	}
	const effectiveCrossEmSize = (glyph: ShapedGlyph): number => {
		const run = preparedRuns[glyph.runIndex];
		const crossScale =
			vertical && (glyph.baselineGlyphOrientation === "sideways-clockwise" || glyph.baselineGlyphOrientation === "tate-chu-yoko-horizontal")
				? verticalScale(run.request)
				: vertical
					? horizontalScale(run.request)
					: verticalScale(run.request);
		return run.request.fontSize * glyph.renderScale * crossScale;
	};
	const alignmentCoordinate = (
		alignment: ProjectFontStyleRunAlignment,
		glyph: ShapedGlyph
	): Omit<
		StyleRunAlignmentAdjustment,
		"lineIndex" | "referenceSourceStyleRunIndex" | "referenceEmSize" | "glyphEmSize" | "referenceCoordinate" | "glyphCoordinate" | "appliedShift"
	> & {
		coordinate: number;
	} => {
		const run = preparedRuns[glyph.runIndex];
		const emSize = effectiveCrossEmSize(glyph);
		if (alignment === "em-box-bottom-left" || alignment === "em-box-center" || alignment === "em-box-top-right") {
			const coordinate = vertical
				? alignment === "em-box-bottom-left"
					? -emSize / 2
					: alignment === "em-box-top-right"
						? emSize / 2
						: 0
				: alignment === "em-box-bottom-left"
					? (run.generator.metrics.ascenderY - 1) * emSize
					: alignment === "em-box-top-right"
						? run.generator.metrics.ascenderY * emSize
						: (run.generator.metrics.ascenderY - 0.5) * emSize;
			return {
				coordinate,
				metricSource: "em-box",
				baseScript: null,
				referenceBaseScript: null,
				baseTag: null,
				baseCoordinateFormat: null,
				referenceBaseCoordinateFormat: null,
			};
		}
		if (alignment === "roman-baseline" && !vertical) {
			return {
				coordinate: 0,
				metricSource: "roman-baseline",
				baseScript: null,
				referenceBaseScript: null,
				baseTag: null,
				baseCoordinateFormat: null,
				referenceBaseCoordinateFormat: null,
			};
		}
		const baseTag = alignment === "icf-bottom-left" ? "icfb" : alignment === "icf-top-right" ? "icft" : "romn";
		const metric = run.baseAlignmentMetrics?.coordinates[baseTag];
		if (!run.baseAlignmentMetrics || !metric) {
			throw new Error(
				`Project font for PSD style run ${run.request.sourceStyleRunIndex} lacks exact OpenType BASE ${vertical ? "vertical" : "horizontal"} ${baseTag} coordinates required by ${alignment}.`
			);
		}
		const coordinate = (metric.value / run.upem - (vertical ? 0.5 : 0)) * emSize;
		return {
			coordinate,
			metricSource: "opentype-base",
			baseScript: run.baseAlignmentMetrics.script,
			referenceBaseScript: null,
			baseTag,
			baseCoordinateFormat: metric.format,
			referenceBaseCoordinateFormat: null,
		};
	};
	for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
		const glyphs = lines[lineIndex].flatMap((group) => group.glyphs);
		if (!glyphs.length) {
			continue;
		}
		const referenceGlyph = glyphs.reduce((largest, glyph) => (effectiveCrossEmSize(glyph) > effectiveCrossEmSize(largest) ? glyph : largest));
		for (const glyph of glyphs) {
			const alignment = preparedRuns[glyph.runIndex].request.styleRunAlignment;
			if (alignment === undefined || alignment === null) {
				continue;
			}
			const reference = alignmentCoordinate(alignment, referenceGlyph);
			const current = alignmentCoordinate(alignment, glyph);
			alignmentAdjustments.set(glyph, {
				lineIndex,
				referenceSourceStyleRunIndex: preparedRuns[referenceGlyph.runIndex].request.sourceStyleRunIndex,
				referenceEmSize: effectiveCrossEmSize(referenceGlyph),
				glyphEmSize: effectiveCrossEmSize(glyph),
				referenceCoordinate: reference.coordinate,
				glyphCoordinate: current.coordinate,
				appliedShift: reference.coordinate - current.coordinate,
				metricSource: current.metricSource,
				baseScript: current.baseScript,
				referenceBaseScript: reference.baseScript,
				baseTag: current.baseTag,
				baseCoordinateFormat: current.baseCoordinateFormat,
				referenceBaseCoordinateFormat: reference.baseCoordinateFormat,
			});
		}
	}
	const paragraphLayout = prepareProjectFontParagraphLineLayouts(
		options,
		lineAdvances,
		preparedRuns.map((run) => run.generator.metrics.lineHeight * run.request.fontSize * (vertical ? horizontalScale(run.request) : verticalScale(run.request))),
		logicalLines,
		kashidaJustifiedLineIndices
	);
	const boxLayoutEvidence: IProjectFontTextBoxLayoutEvidence | null = boxLayout
		? {
				...boxLayout,
				authoredLineCount: authoredLogicalLines.length,
				composedLineCount: logicalLines.length,
				softBreakCount: logicalLines.filter((line) => line.softWrapped).length,
				hyphenatedLineCount: logicalLines.filter((line) => line.insertedHyphen).length,
				insertedHyphenCount: logicalLines.filter((line) => line.insertedHyphen).length,
				hyphenationLanguages: [...new Set(logicalLines.map((line) => line.hyphenationLanguage).filter((language): language is string => language !== null))],
				noBreakRunCount: options.runs.filter((run) => run.noBreak === true).length,
				noBreakPreventedBreakCount,
				noBreakExecutionModel: options.runs.some((run) => run.noBreak === true) ? "bounded-authored-no-break-v1" : "disabled",
				overflowLineCount: lineAdvances.filter((advance, lineIndex) => {
					const line = logicalLines[lineIndex];
					const paragraphRun =
						options.paragraphRuns?.find((run) => line.logicalStart >= run.start && line.logicalStart < run.start + run.length) ??
						options.paragraphRuns?.[options.paragraphRuns.length - 1];
					const primarySpan =
						(vertical ? boxLayout.bottom - boxLayout.top : boxLayout.right - boxLayout.left) -
						(paragraphRun?.startIndent ?? 0) -
						(paragraphRun?.endIndent ?? 0) -
						(line.firstInParagraph ? (paragraphRun?.firstLineIndent ?? 0) : 0);
					const layout = paragraphLayout.lines[lineIndex];
					const crossOverflow = vertical
						? layout.crossPosition - layout.lineHeight / 2 < boxLayout.left || layout.crossPosition + layout.lineHeight / 2 > boxLayout.right
						: layout.crossPosition < boxLayout.top || layout.crossPosition + layout.lineHeight > boxLayout.bottom;
					return advance > primarySpan || crossOverflow;
				}).length,
				wrapModel: logicalLines.some((line) => line.insertedHyphen) ? "bounded-dictionary-hyphenation-wrap-v1" : "bounded-whitespace-cluster-wrap-v1",
				composerModel: projectFontBoxComposerModel(options),
				lines: logicalLines.map((line, lineIndex) => {
					const paragraphRun =
						options.paragraphRuns?.find((run) => line.logicalStart >= run.start && line.logicalStart < run.start + run.length) ??
						options.paragraphRuns?.[options.paragraphRuns.length - 1];
					const available =
						(vertical ? boxLayout.bottom - boxLayout.top : boxLayout.right - boxLayout.left) -
						(paragraphRun?.startIndent ?? 0) -
						(paragraphRun?.endIndent ?? 0) -
						(line.firstInParagraph ? (paragraphRun?.firstLineIndent ?? 0) : 0);
					return {
						lineIndex,
						logicalStart: line.logicalStart,
						logicalEnd: line.logicalEnd,
						advance: lineAdvances[lineIndex],
						available,
						lineHeight: paragraphLayout.lines[lineIndex].lineHeight,
						lineHeightSource: paragraphLayout.lines[lineIndex].lineHeightSource,
						leadingSourceStyleRunIndices: paragraphLayout.lines[lineIndex].leadingRunIndices.map((runIndex) => options.runs[runIndex].sourceStyleRunIndex),
						softWrapped: line.softWrapped,
						insertedHyphen: line.insertedHyphen,
						hyphenationLanguage: line.hyphenationLanguage,
						overflow: lineAdvances[lineIndex] > available,
					};
				}),
				executionModel: "bounded-authored-box-text-layout-v1",
			}
		: null;
	const output = new Uint8Array(options.width * options.height * 4);
	let glyphCount = 0;
	let clippedPixelCount = 0;
	let inkLeft = options.width;
	let inkTop = options.height;
	let inkRight = 0;
	let inkBottom = 0;
	const blendPixel = (destination: number, alpha: number, color: [number, number, number, number]): void => {
		const sourceAlpha = (alpha / 255) * (color[3] / 255);
		if (sourceAlpha <= 0) {
			return;
		}
		const destinationAlpha = output[destination + 3] / 255;
		const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
		for (let channel = 0; channel < 3; ++channel) {
			const premultiplied = color[channel] * sourceAlpha + output[destination + channel] * destinationAlpha * (1 - sourceAlpha);
			output[destination + channel] = outputAlpha > 0 ? Math.round(premultiplied / outputAlpha) : 0;
		}
		output[destination + 3] = Math.round(outputAlpha * 255);
	};
	const paintTextPixel = (run: PreparedRun, x: number, y: number, fillAlpha: number, strokeAlpha: number): boolean => {
		const fillEnabled = run.request.fillEnabled ?? true;
		const strokeEnabled = run.request.strokeEnabled ?? false;
		const operations = run.request.fillFirst === false ? (["stroke", "fill"] as const) : (["fill", "stroke"] as const);
		let painted = false;
		for (const operation of operations) {
			if (operation === "fill" && fillEnabled && fillAlpha > 0 && run.request.color[3] > 0) {
				blendPixel((y * options.width + x) * 4, fillAlpha, run.request.color);
				run.fillPixelCount++;
				painted = true;
			} else if (operation === "stroke" && strokeEnabled && strokeAlpha > 0 && run.request.strokeColor && run.request.strokeColor[3] > 0) {
				blendPixel((y * options.width + x) * 4, strokeAlpha, run.request.strokeColor);
				run.strokePixelCount++;
				painted = true;
			}
		}
		if (painted) {
			inkLeft = Math.min(inkLeft, x);
			inkTop = Math.min(inkTop, y);
			inkRight = Math.max(inkRight, x + 1);
			inkBottom = Math.max(inkBottom, y + 1);
		}
		return painted;
	};
	const paintDecoration = (
		run: IProjectFontTextStyleRunOptions,
		primaryStart: number,
		primaryEnd: number,
		baseline: number,
		renderScale: number,
		forceHorizontal = false
	): void => {
		if ((!run.underline && !run.strikethrough) || run.fillEnabled === false) {
			return;
		}
		const horizontalLayout = !vertical || forceHorizontal;
		const crossScale = (horizontalLayout ? verticalScale(run) : horizontalScale(run)) * renderScale;
		const thickness = Math.max(1, Math.round(run.fontSize * 0.06 * crossScale));
		const paintLine = (cross: number): void => {
			const primaryMinimum = Math.floor(Math.min(primaryStart, primaryEnd));
			const primaryMaximum = Math.ceil(Math.max(primaryStart, primaryEnd));
			for (let primary = primaryMinimum; primary < primaryMaximum; ++primary) {
				for (let offset = 0; offset < thickness; ++offset) {
					const x = horizontalLayout ? primary : Math.round(cross) + offset;
					const y = horizontalLayout ? Math.round(cross) + offset : primary;
					if (x < 0 || y < 0 || x >= options.width || y >= options.height) {
						clippedPixelCount++;
						continue;
					}
					blendPixel((y * options.width + x) * 4, 255, run.color);
					inkLeft = Math.min(inkLeft, x);
					inkTop = Math.min(inkTop, y);
					inkRight = Math.max(inkRight, x + 1);
					inkBottom = Math.max(inkBottom, y + 1);
				}
			}
		};
		if (run.underline) {
			paintLine(baseline + run.fontSize * 0.08 * crossScale);
		}
		if (run.strikethrough) {
			paintLine(baseline - run.fontSize * 0.3 * crossScale);
		}
	};
	const paintWariChuGroup = (group: ShapedGroup, metrics: WariChuMetrics, primaryStart: number, lineTop: number, columnCenter: number): void => {
		const groupRun = preparedRuns[group.runIndex];
		const request = groupRun.request;
		const scale = request.wariChuScale ?? 0.5;
		const gap = request.wariChuLineGap ?? 0;
		const parentCrossSpan = request.fontSize * (vertical ? horizontalScale(request) : verticalScale(request));
		const sublineCrossSpan = parentCrossSpan * scale;
		const parentTop = lineTop + maximumAscender - groupRun.generator.metrics.ascenderY * request.fontSize * verticalScale(request);
		for (const row of metrics.rows) {
			let rowCursor = primaryStart + row.alignedStart;
			const rowCross = vertical
				? columnCenter + metrics.crossSpan / 2 - sublineCrossSpan / 2 - row.rowIndex * (sublineCrossSpan + gap)
				: parentTop + (parentCrossSpan - metrics.crossSpan) / 2 + row.rowIndex * (sublineCrossSpan + gap) + groupRun.generator.metrics.ascenderY * sublineCrossSpan;
			for (let glyphIndex = 0; glyphIndex < row.glyphs.length; ++glyphIndex) {
				const shapedGlyph = row.glyphs[glyphIndex];
				const nextGlyph = row.glyphs[glyphIndex + 1];
				const run = preparedRuns[shapedGlyph.runIndex];
				const glyph = run.glyphById.get(shapedGlyph.glyphId)!;
				const placement = run.placements.get(shapedGlyph.glyphId);
				const glyphHorizontalScale = horizontalScale(run.request) * shapedGlyph.renderScale;
				const glyphVerticalScale = verticalScale(run.request) * shapedGlyph.renderScale;
				const crossShift =
					projectFontBaselineAppliedShift(run.request, runBaselineFeatures[shapedGlyph.runIndex]) + (alignmentAdjustments.get(shapedGlyph)?.appliedShift ?? 0);
				const diacriticShift = diacriticAdjustments.get(shapedGlyph)?.authoredVerticalShift ?? 0;
				const tsume = tsumeAdjustment(shapedGlyph);
				const sideways = vertical && shapedGlyph.baselineGlyphOrientation === "sideways-clockwise";
				if (placement && placement.width > 0 && placement.height > 0) {
					glyphCount++;
					run.glyphCount++;
					const page = run.atlasPages[placement.page];
					const sidewaysBaseX = ((shapedGlyph.xOffset * run.request.fontSize) / run.upem + placement.xOffset) * glyphHorizontalScale;
					const sidewaysBaseY = -(shapedGlyph.yOffset / run.upem + glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale;
					const destinationLeft = sideways
						? 0
						: Math.round(
								(vertical ? rowCross + crossShift : rowCursor - tsume.leadingTrim) +
									((shapedGlyph.xOffset * run.request.fontSize) / run.upem + placement.xOffset) * glyphHorizontalScale
							);
					const destinationTop = sideways
						? 0
						: Math.round(
								vertical
									? rowCursor - tsume.leadingTrim - (shapedGlyph.yOffset / run.upem + glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale
									: rowCross -
											(glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale -
											((shapedGlyph.yOffset * run.request.fontSize) / run.upem) * glyphVerticalScale -
											crossShift -
											diacriticShift
							);
					const boldPixels = Math.round(fauxBoldPixels(run.request) * shapedGlyph.renderScale);
					const italicShear = run.request.fauxItalic ? Math.tan((12 * Math.PI) / 180) : 0;
					const scaledWidth = Math.max(1, Math.round(placement.width * glyphHorizontalScale));
					const scaledHeight = Math.max(1, Math.round(placement.height * glyphVerticalScale));
					for (let y = 0; y < scaledHeight; ++y) {
						for (let x = 0; x < scaledWidth; ++x) {
							const sourceX = Math.min(placement.width - 1, Math.floor(x / glyphHorizontalScale));
							const sourceY = Math.min(placement.height - 1, Math.floor(y / glyphVerticalScale));
							const coverage = projectFontMsdfPaintCoverage(
								page.pixels,
								((placement.y + sourceY) * page.width + placement.x + sourceX) * 4,
								page.distanceRange,
								run.request.outlineWidth ?? 1
							);
							if (!coverage.fillAlpha && !coverage.strokeAlpha) {
								continue;
							}
							const italicOffset = Math.round((scaledHeight - 1 - y) * italicShear);
							for (let boldOffset = 0; boldOffset <= boldPixels; ++boldOffset) {
								const destinationX = sideways ? Math.round(rowCross + crossShift - (sidewaysBaseY + y)) : destinationLeft + x + italicOffset + boldOffset;
								const destinationY = sideways ? Math.round(rowCursor - tsume.leadingTrim + sidewaysBaseX + x + italicOffset + boldOffset) : destinationTop + y;
								if (destinationX < 0 || destinationY < 0 || destinationX >= options.width || destinationY >= options.height) {
									clippedPixelCount++;
									continue;
								}
								paintTextPixel(run, destinationX, destinationY, coverage.fillAlpha, coverage.strokeAlpha);
							}
						}
					}
				}
				const clusterBoundary = nextGlyph !== undefined && nextGlyph.cluster !== shapedGlyph.cluster;
				const advance =
					tsume.advanceAfter +
					fauxBoldPixels(run.request) * shapedGlyph.renderScale +
					(nextGlyph
						? ((run.request.tracking * run.request.fontSize) / 1000) * glyphPrimaryScale(shapedGlyph) * scale + manualKerningBetween(shapedGlyph, nextGlyph) * scale
						: 0) +
					(clusterBoundary ? row.extraClusterSpacing : 0);
				paintDecoration(run.request, rowCursor, rowCursor + advance, vertical ? rowCross + crossShift : rowCross - crossShift, shapedGlyph.renderScale, false);
				rowCursor += advance;
			}
		}
	};
	for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
		const groups = shaping.bidirectional ? lines[lineIndex] : !vertical && shaping.direction === "rtl" ? [...lines[lineIndex]].reverse() : lines[lineIndex];
		let cursorX = vertical ? 0 : paragraphLayout.lines[lineIndex].primaryStart;
		let cursorY = vertical ? paragraphLayout.lines[lineIndex].primaryStart : 0;
		const lineTop = vertical ? 0 : paragraphLayout.lines[lineIndex].crossPosition;
		const columnCenter = vertical ? paragraphLayout.lines[lineIndex].crossPosition : 0;
		for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
			const group = groups[groupIndex];
			if (group.tab) {
				if (vertical) {
					cursorY += groupAdvance(group);
				} else {
					cursorX += groupAdvance(group);
				}
				continue;
			}
			const wariChu = wariChuMetrics(group);
			if (wariChu) {
				paintWariChuGroup(group, wariChu, vertical ? cursorY : cursorX, lineTop, columnCenter);
				const lastGlyph = group.glyphs.at(-1)!;
				const nextGroupGlyph = nextShapedGlyphAt(groups, groupIndex, group.glyphs.length - 1);
				const lastRun = preparedRuns[lastGlyph.runIndex];
				const outerAdvance =
					wariChu.cellAdvance +
					(nextGroupGlyph
						? ((lastRun.request.tracking * lastRun.request.fontSize) / 1000) * glyphPrimaryScale(lastGlyph) + manualKerningBetween(lastGlyph, nextGroupGlyph)
						: 0) +
					(lastGlyph.wordSpace ? paragraphLayout.lines[lineIndex].extraWordSpacing : 0);
				if (vertical) {
					cursorY += outerAdvance;
				} else {
					cursorX += outerAdvance;
				}
				continue;
			}
			const tateChuYoko = tateChuYokoMetrics(group);
			if (tateChuYoko) {
				let blockCursor = columnCenter - tateChuYoko.fittedAdvance / 2;
				for (let glyphIndex = 0; glyphIndex < group.glyphs.length; ++glyphIndex) {
					const shapedGlyph = group.glyphs[glyphIndex];
					const nextGlyph = group.glyphs[glyphIndex + 1];
					const run = preparedRuns[shapedGlyph.runIndex];
					const glyph = run.glyphById.get(shapedGlyph.glyphId)!;
					const placement = run.placements.get(shapedGlyph.glyphId);
					const tsume = tsumeAdjustment(shapedGlyph);
					const glyphHorizontalScale = horizontalScale(run.request) * shapedGlyph.renderScale * tateChuYoko.fitScale;
					const glyphVerticalScale = verticalScale(run.request) * shapedGlyph.renderScale * tateChuYoko.fitScale;
					const crossShift =
						projectFontBaselineAppliedShift(run.request, runBaselineFeatures[shapedGlyph.runIndex]) + (alignmentAdjustments.get(shapedGlyph)?.appliedShift ?? 0);
					const baseline =
						cursorY +
						tateChuYoko.cellAdvance / 2 +
						(run.generator.metrics.ascenderY - 0.5) * run.request.fontSize * shapedGlyph.renderScale * verticalScale(run.request) * tateChuYoko.fitScale;
					if (placement && placement.width > 0 && placement.height > 0) {
						glyphCount++;
						run.glyphCount++;
						const page = run.atlasPages[placement.page];
						const destinationLeft = Math.round(
							blockCursor -
								tsume.leadingTrim * tateChuYoko.fitScale +
								crossShift +
								((shapedGlyph.xOffset * run.request.fontSize) / run.upem + placement.xOffset) * glyphHorizontalScale
						);
						const destinationTop = Math.round(
							baseline -
								(glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale -
								((shapedGlyph.yOffset * run.request.fontSize) / run.upem) * glyphVerticalScale
						);
						const boldPixels = Math.round(fauxBoldPixels(run.request) * shapedGlyph.renderScale * tateChuYoko.fitScale);
						const italicShear = run.request.fauxItalic ? Math.tan((12 * Math.PI) / 180) : 0;
						const scaledWidth = Math.max(1, Math.round(placement.width * glyphHorizontalScale));
						const scaledHeight = Math.max(1, Math.round(placement.height * glyphVerticalScale));
						for (let y = 0; y < scaledHeight; ++y) {
							for (let x = 0; x < scaledWidth; ++x) {
								const sourceX = Math.min(placement.width - 1, Math.floor(x / glyphHorizontalScale));
								const sourceY = Math.min(placement.height - 1, Math.floor(y / glyphVerticalScale));
								const coverage = projectFontMsdfPaintCoverage(
									page.pixels,
									((placement.y + sourceY) * page.width + placement.x + sourceX) * 4,
									page.distanceRange,
									run.request.outlineWidth ?? 1
								);
								if (!coverage.fillAlpha && !coverage.strokeAlpha) {
									continue;
								}
								const italicOffset = Math.round((scaledHeight - 1 - y) * italicShear);
								for (let boldOffset = 0; boldOffset <= boldPixels; ++boldOffset) {
									const destinationX = destinationLeft + x + italicOffset + boldOffset;
									const destinationY = destinationTop + y;
									if (destinationX < 0 || destinationY < 0 || destinationX >= options.width || destinationY >= options.height) {
										clippedPixelCount++;
										continue;
									}
									paintTextPixel(run, destinationX, destinationY, coverage.fillAlpha, coverage.strokeAlpha);
								}
							}
						}
					}
					const rawGlyphAdvance =
						tsume.advanceAfter +
						fauxBoldPixels(run.request) * shapedGlyph.renderScale +
						(nextGlyph ? ((run.request.tracking * run.request.fontSize) / 1000) * horizontalScale(run.request) + manualKerningBetween(shapedGlyph, nextGlyph) : 0);
					const fittedGlyphAdvance = rawGlyphAdvance * tateChuYoko.fitScale;
					paintDecoration(run.request, blockCursor, blockCursor + fittedGlyphAdvance, baseline, shapedGlyph.renderScale * tateChuYoko.fitScale, true);
					blockCursor += fittedGlyphAdvance;
				}
				const lastGlyph = group.glyphs.at(-1)!;
				const nextGroupGlyph = nextShapedGlyphAt(groups, groupIndex, group.glyphs.length - 1);
				const lastRun = preparedRuns[lastGlyph.runIndex];
				cursorY +=
					tateChuYoko.cellAdvance +
					(nextGroupGlyph
						? ((lastRun.request.tracking * lastRun.request.fontSize) / 1000) * glyphPrimaryScale(lastGlyph) + manualKerningBetween(lastGlyph, nextGroupGlyph)
						: 0) +
					(lastGlyph.wordSpace ? paragraphLayout.lines[lineIndex].extraWordSpacing : 0);
				continue;
			}
			for (let glyphIndex = 0; glyphIndex < group.glyphs.length; ++glyphIndex) {
				const shapedGlyph = group.glyphs[glyphIndex];
				const nextShapedGlyph = nextShapedGlyphAt(groups, groupIndex, glyphIndex);
				const run = preparedRuns[shapedGlyph.runIndex];
				const glyph = run.glyphById.get(shapedGlyph.glyphId)!;
				const placement = run.placements.get(shapedGlyph.glyphId);
				const runHorizontalScale = horizontalScale(run.request);
				const runVerticalScale = verticalScale(run.request);
				const glyphHorizontalScale = runHorizontalScale * shapedGlyph.renderScale;
				const glyphVerticalScale = runVerticalScale * shapedGlyph.renderScale;
				const baselineShift =
					projectFontBaselineAppliedShift(run.request, runBaselineFeatures[shapedGlyph.runIndex]) + (alignmentAdjustments.get(shapedGlyph)?.appliedShift ?? 0);
				const diacriticShift = diacriticAdjustments.get(shapedGlyph)?.authoredVerticalShift ?? 0;
				const tsume = tsumeAdjustment(shapedGlyph);
				const sideways = vertical && shapedGlyph.baselineGlyphOrientation === "sideways-clockwise";
				if (placement && placement.width > 0 && placement.height > 0) {
					glyphCount++;
					run.glyphCount++;
					const page = run.atlasPages[placement.page];
					const sidewaysBaseX = ((shapedGlyph.xOffset * run.request.fontSize) / run.upem + placement.xOffset) * glyphHorizontalScale;
					const sidewaysBaseY = -(shapedGlyph.yOffset / run.upem + glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale;
					const destinationLeft = sideways
						? 0
						: Math.round(
								(vertical ? columnCenter + baselineShift : cursorX - tsume.leadingTrim) +
									((shapedGlyph.xOffset * run.request.fontSize) / run.upem + placement.xOffset) * glyphHorizontalScale
							);
					const destinationTop = sideways
						? 0
						: Math.round(
								vertical
									? cursorY - tsume.leadingTrim - (shapedGlyph.yOffset / run.upem + glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale
									: lineTop +
											maximumAscender -
											(glyph.top + placement.range / 2) * run.request.fontSize * glyphVerticalScale -
											((shapedGlyph.yOffset * run.request.fontSize) / run.upem) * glyphVerticalScale -
											baselineShift -
											diacriticShift
							);
					const boldPixels = Math.round(fauxBoldPixels(run.request) * shapedGlyph.renderScale);
					const italicShear = run.request.fauxItalic ? Math.tan((12 * Math.PI) / 180) : 0;
					const scaledWidth = Math.max(1, Math.round(placement.width * glyphHorizontalScale));
					const scaledHeight = Math.max(1, Math.round(placement.height * glyphVerticalScale));
					for (let y = 0; y < scaledHeight; ++y) {
						for (let x = 0; x < scaledWidth; ++x) {
							const sourceX = Math.min(placement.width - 1, Math.floor(x / glyphHorizontalScale));
							const sourceY = Math.min(placement.height - 1, Math.floor(y / glyphVerticalScale));
							const coverage = projectFontMsdfPaintCoverage(
								page.pixels,
								((placement.y + sourceY) * page.width + placement.x + sourceX) * 4,
								page.distanceRange,
								run.request.outlineWidth ?? 1
							);
							if (!coverage.fillAlpha && !coverage.strokeAlpha) {
								continue;
							}
							const italicOffset = Math.round((scaledHeight - 1 - y) * italicShear);
							for (let boldOffset = 0; boldOffset <= boldPixels; ++boldOffset) {
								const destinationX = sideways ? Math.round(columnCenter + baselineShift - (sidewaysBaseY + y)) : destinationLeft + x + italicOffset + boldOffset;
								const destinationY = sideways ? Math.round(cursorY - tsume.leadingTrim + sidewaysBaseX + x + italicOffset + boldOffset) : destinationTop + y;
								if (destinationX < 0 || destinationY < 0 || destinationX >= options.width || destinationY >= options.height) {
									clippedPixelCount++;
									continue;
								}
								paintTextPixel(run, destinationX, destinationY, coverage.fillAlpha, coverage.strokeAlpha);
							}
						}
					}
				}
				const advance =
					tsume.advanceAfter +
					fauxBoldPixels(run.request) * shapedGlyph.renderScale +
					(nextShapedGlyph ? ((run.request.tracking * run.request.fontSize) / 1000) * glyphPrimaryScale(shapedGlyph) : 0) +
					(nextShapedGlyph ? manualKerningBetween(shapedGlyph, nextShapedGlyph) : 0) +
					(shapedGlyph.wordSpace ? paragraphLayout.lines[lineIndex].extraWordSpacing : 0);
				paintDecoration(
					run.request,
					vertical ? cursorY : cursorX,
					(vertical ? cursorY : cursorX) + advance,
					vertical ? columnCenter + baselineShift : lineTop + maximumAscender - baselineShift,
					sideways ? shapedGlyph.renderScale * (verticalScale(run.request) / horizontalScale(run.request)) : shapedGlyph.renderScale
				);
				if (vertical) {
					cursorY += advance;
				} else {
					cursorX += advance;
				}
			}
		}
	}
	const manualKerningAppliedCounts = options.runs.map(() => 0);
	for (const groups of lines) {
		for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
			for (let glyphIndex = 0; glyphIndex < groups[groupIndex].glyphs.length; ++glyphIndex) {
				const glyph = groups[groupIndex].glyphs[glyphIndex];
				const next = nextShapedGlyphAt(groups, groupIndex, glyphIndex);
				const ownerRunIndex = next ? projectFontManualKerningOwnerRun(glyph.runIndex, next.runIndex, options.runs) : null;
				if (ownerRunIndex !== null) {
					manualKerningAppliedCounts[ownerRunIndex]++;
				}
			}
		}
	}
	const roundTsume = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
	const styleRunAlignmentGlyphEvidenceByRun = preparedRuns.map((_run, runIndex) =>
		lines.flatMap((groups) =>
			groups.flatMap((group) =>
				group.glyphs.flatMap((glyph) => {
					if (glyph.runIndex !== runIndex) {
						return [];
					}
					const adjustment = alignmentAdjustments.get(glyph);
					return adjustment
						? [
								{
									glyphId: glyph.glyphId,
									cluster: glyph.cluster,
									...adjustment,
									referenceEmSize: roundTsume(adjustment.referenceEmSize),
									glyphEmSize: roundTsume(adjustment.glyphEmSize),
									referenceCoordinate: roundTsume(adjustment.referenceCoordinate),
									glyphCoordinate: roundTsume(adjustment.glyphCoordinate),
									appliedShift: roundTsume(adjustment.appliedShift),
								},
							]
						: [];
				})
			)
		)
	);
	const tsumeGlyphEvidenceByRun = preparedRuns.map((run) =>
		run.request.tsume === null || run.request.tsume === undefined
			? []
			: run.shapedGlyphs.map((glyph) => {
					const adjustment = tsumeAdjustment(glyph);
					return {
						glyphId: glyph.glyphId,
						cluster: glyph.cluster,
						leadingTrim: roundTsume(adjustment.leadingTrim),
						trailingTrim: roundTsume(adjustment.trailingTrim),
						advanceBefore: roundTsume(adjustment.advanceBefore),
						advanceAfter: roundTsume(adjustment.advanceAfter),
					};
				})
	);
	const baselineDirectionGlyphEvidenceByRun = preparedRuns.map((run, runIndex) =>
		run.request.baselineDirection === null || run.request.baselineDirection === undefined
			? []
			: lines.flatMap((groups, lineIndex) =>
					groups.flatMap((group) =>
						group.glyphs.flatMap((glyph) =>
							glyph.runIndex === runIndex
								? [
										{
											glyphId: glyph.glyphId,
											cluster: glyph.cluster,
											lineIndex,
											unicodeVerticalOrientation: glyph.unicodeVerticalOrientation,
											renderedOrientation: glyph.baselineGlyphOrientation,
											shapingDirection: glyph.shapingDirection,
											rotationDegrees: glyph.baselineGlyphOrientation === "sideways-clockwise" ? (90 as const) : (0 as const),
										},
									]
								: []
						)
					)
				)
	);
	const diacriticGlyphEvidenceByRun = preparedRuns.map((_run, runIndex) =>
		lines.flatMap((groups) =>
			groups.flatMap((group) =>
				group.glyphs.flatMap((glyph) => {
					const adjustment = diacriticAdjustments.get(glyph);
					return glyph.runIndex === runIndex && adjustment
						? [
								{
									glyphId: glyph.glyphId,
									cluster: glyph.cluster,
									placement: adjustment.placement,
									authoredVerticalShift: roundTsume(adjustment.authoredVerticalShift) || 0,
									originalXOffset: glyph.xOffset,
									originalYOffset: glyph.yOffset,
									effectiveXOffset: glyph.xOffset,
									effectiveYOffset: roundTsume(adjustment.effectiveYOffset),
								},
							]
						: [];
				})
			)
		)
	);
	const tateChuYokoBlocksByRun = preparedRuns.map((_run, runIndex) => {
		const runStart = runStarts[runIndex];
		const runEnd = runStart + options.runs[runIndex].text.length;
		return lines.flatMap((groups, lineIndex) =>
			groups.flatMap((group) => {
				const metrics = tateChuYokoMetrics(group);
				if (!metrics || !group.glyphs.some((glyph) => glyph.runIndex === runIndex)) {
					return [];
				}
				return [
					{
						lineIndex,
						logicalStart: Math.max(logicalLines[lineIndex].logicalStart, runStart),
						logicalEnd: Math.min(logicalLines[lineIndex].logicalEnd, runEnd),
						glyphCount: group.glyphs.filter((glyph) => glyph.runIndex === runIndex).length,
						rawAdvance: roundTsume(metrics.rawAdvance),
						fittedAdvance: roundTsume(metrics.fittedAdvance),
						cellAdvance: roundTsume(metrics.cellAdvance),
						fitScale: roundTsume(metrics.fitScale),
					},
				];
			})
		);
	});
	const wariChuBlocksByRun = preparedRuns.map((_run, runIndex) =>
		lines.flatMap((groups, lineIndex) =>
			groups.flatMap((group) => {
				const metrics = wariChuMetrics(group);
				if (!metrics || group.runIndex !== runIndex) {
					return [];
				}
				return [
					{
						lineIndex,
						logicalStart: Math.min(...metrics.rows.map((row) => row.logicalStart)),
						logicalEnd: Math.max(...metrics.rows.map((row) => row.logicalEnd)),
						cellAdvance: roundTsume(metrics.cellAdvance),
						crossSpan: roundTsume(metrics.crossSpan),
						rows: metrics.rows.map((row) => ({
							rowIndex: row.rowIndex,
							logicalStart: row.logicalStart,
							logicalEnd: row.logicalEnd,
							clusterCount: row.clusterCount,
							glyphCount: row.glyphs.length,
							rawAdvance: roundTsume(row.rawAdvance),
							alignedStart: roundTsume(row.alignedStart),
							extraClusterSpacing: roundTsume(row.extraClusterSpacing),
							resolvedJustification: row.resolvedJustification,
						})),
					},
				];
			})
		)
	);
	return {
		pixels: output,
		orientation,
		lineCount: lines.length,
		glyphCount,
		uniqueGlyphCount: uniqueFontGlyphPairs.size,
		lineHeight: Math.max(...paragraphLayout.lines.map((line) => line.lineHeight)),
		inkBounds: inkRight > inkLeft && inkBottom > inkTop ? { left: inkLeft, top: inkTop, right: inkRight, bottom: inkBottom } : null,
		clippedPixelCount,
		shapedGlyphs: preparedRuns.flatMap((run) =>
			run.shapedGlyphs.map(
				({
					runIndex: _runIndex,
					wordSpace: _wordSpace,
					renderScale: _renderScale,
					baselineGlyphOrientation: _baselineGlyphOrientation,
					unicodeVerticalOrientation: _unicodeVerticalOrientation,
					shapingDirection: _shapingDirection,
					virtualHyphen: _virtualHyphen,
					...glyph
				}) => glyph
			)
		),
		shaping: {
			engine: "harfbuzz",
			version: hb.versionString(),
			direction: shaping.direction,
			script: shaping.script,
			language: shaping.language,
			features: shaping.features,
			styleBoundaryModel: shaping.joinAcrossStyleRuns ? "shared-font-cross-style-clusters-v1" : "isolated-font-style-runs-v1",
			bidirectional: bidiEvidence,
		},
		styleRuns: preparedRuns.map((run, runIndex) => ({
			fontPath: run.request.fontPath,
			fontSize: run.request.fontSize,
			tracking: run.request.tracking,
			color: run.request.color,
			fillEnabled: run.request.fillEnabled ?? true,
			strokeEnabled: run.request.strokeEnabled ?? false,
			strokeColor: run.request.strokeColor ?? null,
			fillFirst: run.request.fillFirst ?? true,
			outlineWidth: run.request.outlineWidth ?? 1,
			fillPixelCount: run.fillPixelCount,
			strokePixelCount: run.strokePixelCount,
			textPaintExecutionModel:
				run.request.fillEnabled !== undefined ||
				run.request.strokeEnabled !== undefined ||
				run.request.strokeColor !== undefined ||
				run.request.fillFirst !== undefined ||
				run.request.outlineWidth !== undefined
					? "bounded-authored-text-fill-stroke-v1"
					: "disabled",
			strokeRasterModel: run.request.strokeEnabled ? "bounded-msdf-centered-outline-v1" : "disabled",
			sourceStyleRunIndex: run.request.sourceStyleRunIndex,
			fontIndex: run.request.fontIndex,
			fontName: run.request.fontName,
			photoshopLanguageIndex: run.request.language ?? null,
			photoshopLanguage: runPhotoshopLanguages[runIndex]?.language ?? null,
			effectiveShapingLanguage: runEffectiveLanguages[runIndex],
			languageSource: runPhotoshopLanguages[runIndex] ? "authored" : shaping.language ? "request" : "default",
			languageExecutionModel: runPhotoshopLanguages[runIndex] ? "bounded-authored-photoshop-language-v1" : "disabled",
			fauxBold: run.request.fauxBold,
			fauxItalic: run.request.fauxItalic,
			horizontalScale: run.request.horizontalScale ?? 100,
			verticalScale: run.request.verticalScale ?? 100,
			baselineShift: run.request.baselineShift ?? 0,
			underline: run.request.underline ?? false,
			strikethrough: run.request.strikethrough ?? false,
			noBreak: run.request.noBreak ?? false,
			noBreakExecutionModel: run.request.noBreak ? "bounded-authored-no-break-v1" : "disabled",
			autoLeading: run.request.autoLeading ?? null,
			leading: run.request.leading ?? null,
			leadingAppliedLineIndices: paragraphLayout.lines.flatMap((line, lineIndex) => (line.leadingRunIndices.includes(runIndex) ? [lineIndex] : [])),
			leadingAppliedLineHeights: paragraphLayout.lines.flatMap((line) => (line.leadingRunIndices.includes(runIndex) ? [line.lineHeight] : [])),
			leadingExecutionModel:
				(run.request.autoLeading !== undefined && run.request.autoLeading !== null) || (run.request.leading !== undefined && run.request.leading !== null)
					? "bounded-authored-character-leading-v1"
					: "disabled",
			kerning: run.request.kerning ?? null,
			manualKerningBoundaryUtf16: (run.request.kerning ?? 0) !== 0 ? runStarts[runIndex] : null,
			manualKerningPixels: (run.request.kerning ?? 0) !== 0 ? manualKerningPixels(runIndex, run.shapedGlyphs[0]?.baselineGlyphOrientation) : 0,
			manualKerningAppliedBoundaryCount: manualKerningAppliedCounts[runIndex],
			manualKerningExecutionModel: (run.request.kerning ?? 0) !== 0 ? "bounded-authored-manual-kerning-v1" : "disabled",
			autoKerning: run.request.autoKerning ?? null,
			ligatures: run.request.ligatures ?? null,
			discretionaryLigatures: run.request.discretionaryLigatures ?? null,
			fontCaps: run.request.fontCaps ?? null,
			smallCapScale: run.request.smallCapScale ?? 0.7,
			capsAppliedScale: run.request.fontCaps === "small-caps" && !runSupportsOpenTypeSmallCaps[runIndex] ? (run.request.smallCapScale ?? 0.7) : 1,
			capsAffectedCharacterCount: projectFontCapsAffectedCharacterCount(run.request.text, run.request.fontCaps),
			capsGlyphSource:
				run.request.fontCaps === "all-caps"
					? "unicode-uppercase"
					: run.request.fontCaps === "small-caps"
						? runSupportsOpenTypeSmallCaps[runIndex]
							? "opentype-smcp"
							: "faux-small-caps"
						: "disabled",
			capsExecutionModel: run.request.fontCaps === null || run.request.fontCaps === undefined ? "disabled" : "bounded-authored-font-caps-v1",
			fontBaseline: run.request.fontBaseline ?? null,
			fontBaselineScale: run.request.fontBaselineScale ?? 0.583,
			fontBaselinePosition: run.request.fontBaselinePosition ?? 0.333,
			fontBaselineAppliedScale: projectFontBaselineAppliedScale(run.request, runBaselineFeatures[runIndex]),
			fontBaselineAppliedShift: projectFontBaselineAppliedShift(run.request, runBaselineFeatures[runIndex]),
			fontBaselineEffectiveFeature: runBaselineFeatures[runIndex],
			fontBaselineGlyphSource:
				runBaselineFeatures[runIndex] === "sups"
					? "opentype-sups"
					: runBaselineFeatures[runIndex] === "subs"
						? "opentype-subs"
						: run.request.fontBaseline === "superscript"
							? "faux-superscript"
							: run.request.fontBaseline === "subscript"
								? "faux-subscript"
								: "disabled",
			fontBaselineExecutionModel: run.request.fontBaseline === null || run.request.fontBaseline === undefined ? "disabled" : "bounded-authored-font-baseline-v1",
			baselineDirection: run.request.baselineDirection ?? null,
			baselineDirectionGlyphs: baselineDirectionGlyphEvidenceByRun[runIndex],
			tateChuYokoBlocks: tateChuYokoBlocksByRun[runIndex],
			baselineDirectionExecutionModel:
				run.request.baselineDirection === null || run.request.baselineDirection === undefined
					? "disabled"
					: vertical
						? "bounded-authored-baseline-direction-v1"
						: "horizontal-no-op",
			proportionalMetrics: run.request.proportionalMetrics ?? null,
			proportionalMetricsFeatureSupported: runSupportsOpenTypeProportionalMetrics[runIndex],
			proportionalMetricsExecutionModel:
				run.request.proportionalMetrics === null || run.request.proportionalMetrics === undefined ? "disabled" : "bounded-authored-proportional-metrics-v1",
			kana: run.request.kana ?? null,
			kanaFeatureSupported: runSupportsOpenTypeKana[runIndex],
			kanaExecutionModel: run.request.kana === null || run.request.kana === undefined ? "disabled" : "bounded-authored-kana-v1",
			ruby: run.request.ruby ?? null,
			rubyFeatureSupported: runSupportsOpenTypeRuby[runIndex],
			rubyExecutionModel: run.request.ruby === null || run.request.ruby === undefined ? "disabled" : "bounded-authored-ruby-v1",
			japaneseAlternateFeature: run.request.japaneseAlternateFeature ?? null,
			japaneseAlternateFeatureTag: projectFontJapaneseAlternateFeatureTag(run.request.japaneseAlternateFeature),
			japaneseAlternateFeatureSupported:
				run.request.japaneseAlternateFeature === "normal" ||
				(projectFontJapaneseAlternateFeatureTag(run.request.japaneseAlternateFeature) !== null &&
					runOpenTypeJapaneseAlternateFeatureTags[runIndex].includes(projectFontJapaneseAlternateFeatureTag(run.request.japaneseAlternateFeature)!)),
			japaneseAlternateFeatureAvailableTags: runOpenTypeJapaneseAlternateFeatureTags[runIndex],
			japaneseAlternateFeatureExecutionModel:
				run.request.japaneseAlternateFeature === null || run.request.japaneseAlternateFeature === undefined ? "disabled" : "bounded-authored-japanese-alternate-feature-v1",
			fractions: run.request.fractions ?? null,
			fractionsFeatureSupported: runSupportsOpenTypeFractions[runIndex],
			ordinals: run.request.ordinals ?? null,
			ordinalsFeatureSupported: runSupportsOpenTypeOrdinals[runIndex],
			stylisticAlternates: run.request.stylisticAlternates ?? null,
			stylisticAlternatesFeatureSupported: runSupportsOpenTypeStylisticAlternates[runIndex],
			oldStyle: run.request.oldStyle ?? null,
			oldStyleFeatureSupported: runSupportsOpenTypeOldStyle[runIndex],
			swash: run.request.swash ?? null,
			swashFeatureSupported: runSupportsOpenTypeSwash[runIndex],
			titling: run.request.titling ?? null,
			titlingFeatureSupported: runSupportsOpenTypeTitling[runIndex],
			ornaments: run.request.ornaments ?? null,
			ornamentsFeatureSupported: runSupportsOpenTypeOrnaments[runIndex],
			slashedZero: run.request.slashedZero ?? null,
			slashedZeroFeatureSupported: runSupportsOpenTypeSlashedZero[runIndex],
			characterOpenTypeExecutionModel:
				run.request.oldStyle !== null && run.request.oldStyle !== undefined
					? "bounded-authored-character-opentype-v1"
					: run.request.swash !== null && run.request.swash !== undefined
						? "bounded-authored-character-opentype-v1"
						: run.request.titling !== null && run.request.titling !== undefined
							? "bounded-authored-character-opentype-v1"
							: run.request.ornaments !== null && run.request.ornaments !== undefined
								? "bounded-authored-character-opentype-v1"
								: run.request.slashedZero !== null && run.request.slashedZero !== undefined
									? "bounded-authored-character-opentype-v1"
									: "disabled",
			connectionForms: run.request.connectionForms ?? null,
			connectionFormsFeatureSupported: runSupportsOpenTypeConnectionForms[runIndex],
			connectionFormsExecutionModel: run.request.connectionForms === null || run.request.connectionForms === undefined ? "disabled" : "bounded-authored-connection-forms-v1",
			contextualLigatures: run.request.contextualLigatures ?? null,
			contextualLigaturesFeatureSupported: runSupportsOpenTypeContextualLigatures[runIndex],
			contextualLigaturesExecutionModel:
				run.request.contextualLigatures === null || run.request.contextualLigatures === undefined ? "disabled" : "bounded-authored-contextual-ligatures-v1",
			hindiNumbers: run.request.hindiNumbers ?? null,
			hindiNumbersAffectedCharacterCount: projectFontHindiNumbersAffectedCharacterCount(run.request.text, run.request.hindiNumbers),
			hindiNumbersEffectiveDigits: run.request.hindiNumbers === true ? "hindi-arabic-indic" : run.request.hindiNumbers === false ? "arabic-western" : "default",
			hindiNumbersExecutionModel: run.request.hindiNumbers === null || run.request.hindiNumbers === undefined ? "disabled" : "bounded-authored-hindi-numbers-v1",
			characterDirection: run.request.characterDirection ?? null,
			characterDirectionOverrideCharacterCount: projectFontCharacterDirectionOverrideCharacterCount(run.request.text, run.request.characterDirection),
			characterDirectionResolvedEmbeddingLevels: [
				...new Set(
					(bidiEvidence?.visualRuns ?? [])
						.filter((visualRun) => visualRun.sourceStyleRunIndices.includes(run.request.sourceStyleRunIndex))
						.map((visualRun) => visualRun.embeddingLevel)
				),
			].sort((left, right) => left - right),
			characterDirectionExecutionModel:
				run.request.characterDirection === null || run.request.characterDirection === undefined ? "disabled" : "bounded-authored-character-direction-v1",
			kashida: run.request.kashida ?? null,
			kashidaEligibleJoinCount: kashidaEligibleJoinCounts[runIndex],
			kashidaInsertedCount: kashidaInsertedCounts[runIndex],
			kashidaInsertedAdvance: Math.round(kashidaInsertedAdvances[runIndex] * 1_000_000) / 1_000_000,
			kashidaExecutionModel:
				run.request.kashida === null || run.request.kashida === undefined
					? "disabled"
					: kashidaFullyJustifiedRunIndices.has(runIndex)
						? "bounded-authored-kashida-justification-v1"
						: "inactive-not-fully-justified",
			diacriticPosition: run.request.diacriticPosition ?? null,
			diacriticAffectedGlyphCount: diacriticGlyphEvidenceByRun[runIndex].length,
			diacriticGlyphs: diacriticGlyphEvidenceByRun[runIndex],
			diacriticExecutionModel:
				run.request.diacriticPosition === null || run.request.diacriticPosition === undefined
					? "disabled"
					: vertical
						? "inactive-vertical-text"
						: diacriticGlyphEvidenceByRun[runIndex].length
							? "bounded-authored-diacritic-position-v1"
							: "inactive-no-combining-diacritics",
			figureStyle: run.request.figureStyle ?? null,
			figureStyleLiningFeatureSupported: runSupportsOpenTypeLiningFigures[runIndex],
			figureStyleOldStyleFeatureSupported: runSupportsOpenTypeOldStyle[runIndex],
			figureStyleProportionalFeatureSupported: runSupportsOpenTypeProportionalFigures[runIndex],
			figureStyleTabularFeatureSupported: runSupportsOpenTypeTabularFigures[runIndex],
			figureStyleExecutionModel: run.request.figureStyle === null || run.request.figureStyle === undefined ? "disabled" : "bounded-authored-figure-style-v1",
			engineData2StyleRunIndex: run.request.engineData2StyleRunIndex ?? null,
			engineData2ExecutionModel:
				run.request.fractions !== null && run.request.fractions !== undefined
					? "bounded-global-txt2-engine-data2-v1"
					: run.request.ordinals !== null && run.request.ordinals !== undefined
						? "bounded-global-txt2-engine-data2-v1"
						: run.request.stylisticAlternates !== null && run.request.stylisticAlternates !== undefined
							? "bounded-global-txt2-engine-data2-v1"
							: "disabled",
			stylisticOpenTypeExecutionModel:
				run.request.fractions !== null && run.request.fractions !== undefined
					? "bounded-authored-stylistic-opentype-v1"
					: run.request.ordinals !== null && run.request.ordinals !== undefined
						? "bounded-authored-stylistic-opentype-v1"
						: run.request.stylisticAlternates !== null && run.request.stylisticAlternates !== undefined
							? "bounded-authored-stylistic-opentype-v1"
							: "disabled",
			wariChuEnabled: run.request.wariChuEnabled ?? null,
			wariChuLineCount: run.request.wariChuLineCount ?? 2,
			wariChuLineGap: run.request.wariChuLineGap ?? 0,
			wariChuScale: run.request.wariChuScale ?? 0.5,
			wariChuWidow: run.request.wariChuWidow ?? 2,
			wariChuOrphan: run.request.wariChuOrphan ?? 2,
			wariChuJustification: run.request.wariChuJustification ?? "auto",
			wariChuBlocks: wariChuBlocksByRun[runIndex],
			wariChuExecutionModel: run.request.wariChuEnabled === null || run.request.wariChuEnabled === undefined ? "disabled" : "bounded-authored-wari-chu-v1",
			tsume: run.request.tsume ?? null,
			tsumeAppliedGlyphCount: tsumeGlyphEvidenceByRun[runIndex].filter((glyph) => glyph.advanceAfter < glyph.advanceBefore).length,
			tsumeLeadingTrim: roundTsume(tsumeGlyphEvidenceByRun[runIndex].reduce((sum, glyph) => sum + glyph.leadingTrim, 0)),
			tsumeTrailingTrim: roundTsume(tsumeGlyphEvidenceByRun[runIndex].reduce((sum, glyph) => sum + glyph.trailingTrim, 0)),
			tsumeAdvanceReduction: roundTsume(tsumeGlyphEvidenceByRun[runIndex].reduce((sum, glyph) => sum + (glyph.advanceBefore - glyph.advanceAfter), 0)),
			tsumeGlyphs: tsumeGlyphEvidenceByRun[runIndex],
			tsumeExecutionModel: run.request.tsume === null || run.request.tsume === undefined ? "disabled" : "bounded-authored-tsume-v1",
			styleRunAlignment: run.request.styleRunAlignment ?? null,
			styleRunAlignmentGlyphs: styleRunAlignmentGlyphEvidenceByRun[runIndex],
			styleRunAlignmentExecutionModel:
				run.request.styleRunAlignment === null || run.request.styleRunAlignment === undefined ? "disabled" : "bounded-authored-style-run-alignment-v1",
			effectiveOpenTypeFeatures: projectFontAuthoredOpenTypeFeatures(run.request),
			openTypeFeatureExecutionModel: projectFontAuthoredOpenTypeFeatures(run.request).length ? "bounded-authored-opentype-features-v1" : "disabled",
			length: run.request.text.length,
			glyphCount: run.glyphCount,
			fauxBoldPixels: fauxBoldPixels(run.request),
			fauxItalicShear: run.request.fauxItalic ? Math.tan((12 * Math.PI) / 180) : 0,
			decorationThickness: Math.max(1, Math.round(run.request.fontSize * 0.06 * (vertical ? horizontalScale(run.request) : verticalScale(run.request)))),
			characterStyleExecutionModel: "bounded-authored-character-style-v1",
			shapedGlyphs: run.shapedGlyphs.map(
				({
					runIndex: _runIndex,
					wordSpace: _wordSpace,
					renderScale: _renderScale,
					baselineGlyphOrientation: _baselineGlyphOrientation,
					unicodeVerticalOrientation: _unicodeVerticalOrientation,
					shapingDirection: _shapingDirection,
					virtualHyphen: _virtualHyphen,
					...glyph
				}) => glyph
			),
		})),
		paragraphRuns: paragraphLayout.evidence,
		boxLayout: boxLayoutEvidence,
		executionModel: vertical
			? shaping.joinAcrossStyleRuns
				? shaping.bidirectional
					? "bounded-project-font-harfbuzz-bidi-vertical-cross-style-runs-v1"
					: "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1"
				: shaping.bidirectional
					? "bounded-project-font-harfbuzz-bidi-vertical-style-runs-v1"
					: "bounded-project-font-harfbuzz-vertical-style-runs-v1"
			: shaping.joinAcrossStyleRuns
				? shaping.bidirectional
					? "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1"
					: "bounded-project-font-harfbuzz-cross-style-runs-v1"
				: shaping.bidirectional
					? "bounded-project-font-harfbuzz-bidi-style-runs-v1"
					: "bounded-project-font-harfbuzz-style-runs-v1",
	};
}

/** Rasterizes bounded horizontal or vertical text with exact authored style runs and explicit project-font bindings. */
export async function renderProjectFontTextStyleRuns(options: IProjectFontTextStyleRunsOptions): Promise<IProjectFontTextStyleRunsRenderResult> {
	const orientation = options.orientation ?? "horizontal";
	if (orientation !== "horizontal" && orientation !== "vertical") {
		throw new Error("PSD styled-text raster orientation must be horizontal or vertical.");
	}
	if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width < 1 || options.height < 1 || options.width * options.height > 67_108_864) {
		throw new Error("PSD styled-text raster canvas must contain 1-67,108,864 pixels.");
	}
	validateProjectFontTextBoxLayout(options.boxLayout);
	if (!Array.isArray(options.runs) || options.runs.length < 1 || options.runs.length > 64) {
		throw new Error("PSD styled-text rasterization requires 1-64 exact style runs.");
	}
	if (options.runs.reduce((length, run) => length + run.text.length, 0) > 8192) {
		throw new Error("PSD styled-text rasterization supports at most 8,192 UTF-16 code units.");
	}
	if (options.lineHeight !== null && (!Number.isFinite(options.lineHeight) || options.lineHeight < 1 || options.lineHeight > 2048)) {
		throw new Error("PSD styled-text raster lineHeight must be null or between 1 and 2,048 pixels.");
	}
	if (![options.offsetX, options.offsetY].every((value) => Number.isFinite(value) && Math.abs(value) <= 32_768)) {
		throw new Error("PSD styled-text raster offsets must be finite values between -32,768 and 32,768 pixels.");
	}
	const needsHyphenGlyph = options.boxLayout !== undefined && options.paragraphRuns?.some((run) => run.autoHyphenate) === true;
	const allCodepoints = new Set<string>();
	for (const run of options.runs) {
		if (!Number.isSafeInteger(run.sourceStyleRunIndex) || run.sourceStyleRunIndex < 0 || !Number.isSafeInteger(run.fontIndex) || run.fontIndex < 0) {
			throw new Error("PSD styled-text runs require non-negative integer source-style and font indices.");
		}
		if (!Number.isFinite(run.fontSize) || run.fontSize < 1 || run.fontSize > 512) {
			throw new Error("PSD styled-text run fontSize must be between 1 and 512 pixels.");
		}
		if (!Number.isFinite(run.tracking) || run.tracking < -1000 || run.tracking > 10_000) {
			throw new Error("PSD styled-text run tracking must be between -1,000 and 10,000 thousandths of an em.");
		}
		if (run.autoLeading !== undefined && run.autoLeading !== null && typeof run.autoLeading !== "boolean") {
			throw new Error("PSD styled-text run autoLeading must be Boolean or null.");
		}
		if (run.leading !== undefined && run.leading !== null && (!Number.isFinite(run.leading) || run.leading < 0 || run.leading > 2048)) {
			throw new Error("PSD styled-text run leading must be null or between 0 and 2,048 pixels.");
		}
		if (run.autoLeading === false && (run.leading === undefined || run.leading === null || run.leading < 1)) {
			throw new Error("PSD styled-text run with autoLeading=false requires explicit leading between 1 and 2,048 pixels.");
		}
		if (run.kerning !== undefined && run.kerning !== null && (!Number.isFinite(run.kerning) || run.kerning < -1000 || run.kerning > 1000)) {
			throw new Error("PSD styled-text run manual kerning must be null or between -1,000 and 1,000 thousandths of an em.");
		}
		const horizontalScale = run.horizontalScale ?? 100;
		const verticalScale = run.verticalScale ?? 100;
		const baselineShift = run.baselineShift ?? 0;
		if (!Number.isFinite(horizontalScale) || horizontalScale < 1 || horizontalScale > 1000) {
			throw new Error("PSD styled-text run horizontalScale must be between 1 and 1,000 percent.");
		}
		if (!Number.isFinite(verticalScale) || verticalScale < 1 || verticalScale > 1000) {
			throw new Error("PSD styled-text run verticalScale must be between 1 and 1,000 percent.");
		}
		if (!Number.isFinite(baselineShift) || baselineShift < -2048 || baselineShift > 2048) {
			throw new Error("PSD styled-text run baselineShift must be between -2,048 and 2,048 pixels.");
		}
		if ((run.underline !== undefined && typeof run.underline !== "boolean") || (run.strikethrough !== undefined && typeof run.strikethrough !== "boolean")) {
			throw new Error("PSD styled-text run underline and strikethrough values must be Boolean.");
		}
		if (run.noBreak !== undefined && typeof run.noBreak !== "boolean") {
			throw new Error("PSD styled-text run noBreak must be Boolean.");
		}
		if (run.fontCaps !== undefined && run.fontCaps !== null && !["normal", "small-caps", "all-caps"].includes(run.fontCaps)) {
			throw new Error("PSD styled-text run fontCaps must be normal, small-caps, all-caps, or null.");
		}
		if (run.smallCapScale !== undefined && (!Number.isFinite(run.smallCapScale) || run.smallCapScale < 0.1 || run.smallCapScale > 1)) {
			throw new Error("PSD styled-text run smallCapScale must be between 0.1 and 1.");
		}
		if (run.fontBaseline !== undefined && run.fontBaseline !== null && !["normal", "superscript", "subscript"].includes(run.fontBaseline)) {
			throw new Error("PSD styled-text run fontBaseline must be normal, superscript, subscript, or null.");
		}
		if (run.fontBaselineScale !== undefined && (!Number.isFinite(run.fontBaselineScale) || run.fontBaselineScale < 0.1 || run.fontBaselineScale > 1)) {
			throw new Error("PSD styled-text run fontBaselineScale must be between 0.1 and 1.");
		}
		if (run.fontBaselinePosition !== undefined && (!Number.isFinite(run.fontBaselinePosition) || run.fontBaselinePosition < 0 || run.fontBaselinePosition > 2)) {
			throw new Error("PSD styled-text run fontBaselinePosition must be between 0 and 2.");
		}
		if (run.baselineDirection !== undefined && run.baselineDirection !== null && !["upright", "mixed", "tate-chu-yoko"].includes(run.baselineDirection)) {
			throw new Error("PSD styled-text run baselineDirection must be upright, mixed, tate-chu-yoko, or null.");
		}
		if (run.proportionalMetrics !== undefined && run.proportionalMetrics !== null && typeof run.proportionalMetrics !== "boolean") {
			throw new Error("PSD styled-text run proportionalMetrics must be Boolean or null.");
		}
		if (run.kana !== undefined && run.kana !== null && typeof run.kana !== "boolean") {
			throw new Error("PSD styled-text run kana must be Boolean or null.");
		}
		if (run.ruby !== undefined && run.ruby !== null && typeof run.ruby !== "boolean") {
			throw new Error("PSD styled-text run ruby must be Boolean or null.");
		}
		if (
			run.japaneseAlternateFeature !== undefined &&
			run.japaneseAlternateFeature !== null &&
			!["normal", "traditional", "expert", "jis78"].includes(run.japaneseAlternateFeature)
		) {
			throw new Error("PSD styled-text run japaneseAlternateFeature must be normal, traditional, expert, jis78, or null.");
		}
		for (const [name, value] of [
			["fractions", run.fractions],
			["ordinals", run.ordinals],
			["stylisticAlternates", run.stylisticAlternates],
			["oldStyle", run.oldStyle],
			["swash", run.swash],
			["titling", run.titling],
			["ornaments", run.ornaments],
			["slashedZero", run.slashedZero],
			["connectionForms", run.connectionForms],
			["contextualLigatures", run.contextualLigatures],
			["hindiNumbers", run.hindiNumbers],
		] as const) {
			if (value !== undefined && value !== null && typeof value !== "boolean") {
				throw new Error(`PSD styled-text run ${name} must be Boolean or null.`);
			}
		}
		if (run.characterDirection !== undefined && run.characterDirection !== null && !["default", "left-to-right", "right-to-left"].includes(run.characterDirection)) {
			throw new Error("PSD styled-text run characterDirection must be default, left-to-right, right-to-left, or null.");
		}
		if (run.diacriticPosition !== undefined && run.diacriticPosition !== null && !["opentype", "loose", "medium", "tight"].includes(run.diacriticPosition)) {
			throw new Error("PSD styled-text run diacriticPosition must be opentype, loose, medium, tight, or null.");
		}
		if (
			run.figureStyle !== undefined &&
			run.figureStyle !== null &&
			!["default", "tabular-lining", "proportional-oldstyle", "proportional-lining", "tabular-oldstyle"].includes(run.figureStyle)
		) {
			throw new Error("PSD styled-text run figureStyle must be default, tabular-lining, proportional-oldstyle, proportional-lining, tabular-oldstyle, or null.");
		}
		if (
			run.engineData2StyleRunIndex !== undefined &&
			run.engineData2StyleRunIndex !== null &&
			(!Number.isSafeInteger(run.engineData2StyleRunIndex) || run.engineData2StyleRunIndex < 0 || run.engineData2StyleRunIndex > 255)
		) {
			throw new Error("PSD styled-text run engineData2StyleRunIndex must be an integer between 0 and 255 or null.");
		}
		if (run.wariChuEnabled !== undefined && run.wariChuEnabled !== null && typeof run.wariChuEnabled !== "boolean") {
			throw new Error("PSD styled-text run wariChuEnabled must be Boolean or null.");
		}
		if (
			run.wariChuLineCount !== undefined &&
			run.wariChuLineCount !== null &&
			(!Number.isSafeInteger(run.wariChuLineCount) || run.wariChuLineCount < 2 || run.wariChuLineCount > 16)
		) {
			throw new Error("PSD styled-text run wariChuLineCount must be an integer between 2 and 16.");
		}
		if (run.wariChuLineGap !== undefined && run.wariChuLineGap !== null && (!Number.isFinite(run.wariChuLineGap) || run.wariChuLineGap < 0 || run.wariChuLineGap > 512)) {
			throw new Error("PSD styled-text run wariChuLineGap must be between 0 and 512 pixels.");
		}
		if (run.wariChuScale !== undefined && run.wariChuScale !== null && (!Number.isFinite(run.wariChuScale) || run.wariChuScale < 0.1 || run.wariChuScale > 1)) {
			throw new Error("PSD styled-text run wariChuScale must be between 0.1 and 1.");
		}
		for (const [label, value] of [
			["wariChuWidow", run.wariChuWidow],
			["wariChuOrphan", run.wariChuOrphan],
		] as const) {
			if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 64)) {
				throw new Error(`PSD styled-text run ${label} must be an integer between 1 and 64.`);
			}
		}
		if (
			run.wariChuJustification !== undefined &&
			run.wariChuJustification !== null &&
			!["left", "right", "center", "justify-left", "justify-right", "justify-center", "justify-all", "auto"].includes(run.wariChuJustification)
		) {
			throw new Error("PSD styled-text run wariChuJustification must be left, right, center, justify-left, justify-right, justify-center, justify-all, auto, or null.");
		}
		if (run.wariChuEnabled === true) {
			if (!run.text || /[\r\n\t]/.test(run.text)) {
				throw new Error(`PSD styled-text run ${run.sourceStyleRunIndex} enabled Wari-chu must contain renderable text on exactly one authored line.`);
			}
			if (run.baselineDirection === "tate-chu-yoko") {
				throw new Error(`PSD styled-text run ${run.sourceStyleRunIndex} cannot combine Wari-chu with Tate-Chu-Yoko.`);
			}
		}
		if (run.tsume !== undefined && run.tsume !== null && (!Number.isFinite(run.tsume) || run.tsume < 0 || run.tsume > 1)) {
			throw new Error("PSD styled-text run tsume must be null or between 0 and 1.");
		}
		if (
			run.styleRunAlignment !== undefined &&
			run.styleRunAlignment !== null &&
			!["em-box-bottom-left", "icf-bottom-left", "em-box-center", "roman-baseline", "icf-top-right", "em-box-top-right"].includes(run.styleRunAlignment)
		) {
			throw new Error(
				"PSD styled-text run styleRunAlignment must be em-box-bottom-left, icf-bottom-left, em-box-center, roman-baseline, icf-top-right, em-box-top-right, or null."
			);
		}
		for (const [label, value] of [
			["autoKerning", run.autoKerning],
			["ligatures", run.ligatures],
			["discretionaryLigatures", run.discretionaryLigatures],
			["kashida", run.kashida],
		] as const) {
			if (value !== undefined && value !== null && typeof value !== "boolean") {
				throw new Error(`PSD styled-text run ${label} must be Boolean or null.`);
			}
		}
		if (run.language !== undefined && run.language !== null && (!Number.isSafeInteger(run.language) || run.language < 0 || run.language > 65_535)) {
			throw new Error("PSD styled-text run language must be null or a non-negative integer no larger than 65,535.");
		}
		if (run.language !== undefined && run.language !== null) {
			projectFontPhotoshopLanguage(run.language);
		}
		if (!Array.isArray(run.color) || run.color.length !== 4 || run.color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
			throw new Error("PSD styled-text run color must contain exact RGBA8 channels.");
		}
		for (const [label, value] of [
			["fillEnabled", run.fillEnabled],
			["strokeEnabled", run.strokeEnabled],
			["fillFirst", run.fillFirst],
		] as const) {
			if (value !== undefined && value !== null && typeof value !== "boolean") {
				throw new Error(`PSD styled-text run ${label} must be Boolean or null.`);
			}
		}
		if (
			run.strokeColor !== undefined &&
			run.strokeColor !== null &&
			(!Array.isArray(run.strokeColor) || run.strokeColor.length !== 4 || run.strokeColor.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255))
		) {
			throw new Error("PSD styled-text run strokeColor must be null or contain exact RGBA8 channels.");
		}
		if (run.strokeEnabled === true && (run.strokeColor === null || run.strokeColor === undefined)) {
			throw new Error("PSD styled-text run with strokeEnabled=true requires an exact strokeColor.");
		}
		if (run.outlineWidth !== undefined && run.outlineWidth !== null && (!Number.isFinite(run.outlineWidth) || run.outlineWidth < 0 || run.outlineWidth > 128)) {
			throw new Error("PSD styled-text run outlineWidth must be null or between 0 and 128 pixels.");
		}
		const effectiveText = projectFontHindiNumbersText(run.text, run.hindiNumbers);
		validateFontImporterSource(run.fontPath, {
			renderMode: "bitmap",
			characterSet: "custom",
			customCharacters: effectiveText || " ",
			fontSize: run.fontSize,
			padding: 1,
			distanceRange: 4,
		});
		for (const character of Array.from(effectiveText)) {
			const codepoint = character.codePointAt(0)!;
			if (codepoint !== 10 && codepoint !== 13 && codepoint !== 9) {
				allCodepoints.add(`${run.fontPath}\0${codepoint}`);
			}
		}
		if (needsHyphenGlyph) {
			allCodepoints.add(`${run.fontPath}\0${"-".codePointAt(0)!}`);
		}
	}
	if (allCodepoints.size > 1024) {
		throw new Error("PSD styled-text rasterization supports at most 1,024 unique font/glyph pairs per layer.");
	}
	const fullText = options.runs.map((run) => run.text).join("");
	const runStarts = projectFontStyleRunStarts(options.runs);
	for (let runIndex = 0; runIndex < options.runs.length; ++runIndex) {
		if ((options.runs[runIndex].kerning ?? 0) === 0) {
			continue;
		}
		const boundary = runStarts[runIndex];
		if (boundary === 0) {
			throw new Error(`PSD styled-text run ${options.runs[runIndex].sourceStyleRunIndex} has nonzero manual kerning without a preceding character boundary.`);
		}
		const previousCharacter = Array.from(fullText.slice(0, boundary)).at(-1);
		const nextCharacter = Array.from(fullText.slice(boundary))[0];
		if (!previousCharacter || !nextCharacter || /[\r\n\t]/.test(previousCharacter) || /[\r\n\t]/.test(nextCharacter)) {
			throw new Error(`PSD styled-text run ${options.runs[runIndex].sourceStyleRunIndex} manual kerning must address two renderable characters on one authored line.`);
		}
	}
	const wasm = await readFile(require.resolve("msdfgen-wasm/wasm"));
	const hasAuthoredOpenTypeFeatures = options.runs.some((run) => projectFontAuthoredOpenTypeFeatures(run).length > 0);
	const hasExecutableFontCaps = options.runs.some((run) => run.fontCaps === "small-caps" || run.fontCaps === "all-caps");
	const hasExecutableFontBaseline = options.runs.some((run) => run.fontBaseline === "superscript" || run.fontBaseline === "subscript");
	const hasAuthoredBaselineDirection = options.runs.some((run) => run.baselineDirection !== undefined && run.baselineDirection !== null);
	const hasAuthoredTsume = options.runs.some((run) => run.tsume !== undefined && run.tsume !== null);
	const hasAuthoredStyleRunAlignment = options.runs.some((run) => run.styleRunAlignment !== undefined && run.styleRunAlignment !== null);
	const hasAuthoredWariChu = options.runs.some((run) => run.wariChuEnabled !== undefined && run.wariChuEnabled !== null);
	const hasAuthoredLanguage = options.runs.some((run) => run.language !== undefined && run.language !== null);
	const hasAuthoredHindiNumbers = options.runs.some((run) => run.hindiNumbers !== undefined && run.hindiNumbers !== null);
	const hasAuthoredKashida = options.runs.some((run) => run.kashida !== undefined && run.kashida !== null);
	const hasExecutableDiacriticPosition = options.runs.some((run) => run.diacriticPosition !== undefined && run.diacriticPosition !== null && /\p{Mark}/u.test(run.text));
	const hasExecutableKashida =
		hasAuthoredKashida &&
		options.boxLayout !== undefined &&
		options.paragraphRuns?.some((run) => run.justification.startsWith("justify-")) === true &&
		/\p{Script_Extensions=Arabic}/u.test(options.runs.map((run) => run.text).join(""));
	const hasAuthoredCharacterDirection = options.runs.some((run) => run.characterDirection !== undefined && run.characterDirection !== null);
	if (
		options.shaping ||
		orientation === "vertical" ||
		hasAuthoredOpenTypeFeatures ||
		hasExecutableFontCaps ||
		hasExecutableFontBaseline ||
		hasAuthoredBaselineDirection ||
		hasAuthoredTsume ||
		hasAuthoredStyleRunAlignment ||
		hasAuthoredWariChu ||
		hasAuthoredLanguage ||
		hasAuthoredHindiNumbers ||
		hasExecutableKashida ||
		hasExecutableDiacriticPosition ||
		hasAuthoredCharacterDirection
	) {
		const requestedShaping = options.shaping ?? { direction: "ltr" as const };
		return renderProjectFontTextStyleRunsShaped(
			{ ...options, orientation, shaping: hasAuthoredCharacterDirection ? { ...requestedShaping, bidirectional: true } : requestedShaping },
			wasm
		);
	}
	type GlyphPlacement = { x: number; y: number; width: number; height: number; page: number; xOffset: number; xAdvance: number; range: number };
	type PreparedRun = {
		request: IProjectFontTextStyleRunOptions;
		generator: MsdfgenInstance;
		glyphByCodepoint: Map<number, Glyph>;
		placements: Map<number, GlyphPlacement>;
		atlasPages: Array<{ pixels: Buffer; width: number; distanceRange: number }>;
		glyphCount: number;
		fillPixelCount: number;
		strokePixelCount: number;
	};
	const preparedRuns: PreparedRun[] = [];
	for (const run of options.runs) {
		const codepoints = [
			...new Set(Array.from(run.text, (character) => character.codePointAt(0)!).filter((codepoint) => codepoint !== 10 && codepoint !== 13 && codepoint !== 9)),
		];
		if (needsHyphenGlyph && !codepoints.includes(45)) {
			codepoints.push(45);
		}
		const generator = await Msdfgen.create(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
		generator.loadFont(run.fontBytes);
		generator.loadGlyphs(codepoints, { preprocess: true });
		const glyphByCodepoint = new Map(generator.glyphs.map((glyph) => [glyph.unicode, glyph]));
		const missingCodepoints = codepoints.filter((codepoint) => !glyphByCodepoint.has(codepoint));
		if (missingCodepoints.length) {
			throw new Error(
				`Project font for PSD style run ${run.sourceStyleRunIndex} is missing codepoint(s): ${missingCodepoints.map((codepoint) => `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`).join(", ")}.`
			);
		}
		const distanceRange = Math.max(4, Math.ceil((run.strokeEnabled === false ? 0 : (run.outlineWidth ?? 1)) / 2 + 1));
		const bins = generator.packGlyphs(
			{ size: run.fontSize, range: distanceRange, edgeColoring: "inktrap", edgeThresholdAngle: 3, scanline: false },
			{ maxWidth: 2048, maxHeight: 2048, padding: 1, pot: true, smart: true, allowRotation: false }
		);
		const atlasPages = await Promise.all(
			bins.map(async (bin) => {
				const decoded = await sharp(generator.createAtlasImage(bin)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
				return { pixels: decoded.data, width: decoded.info.width, distanceRange };
			})
		);
		const placements = new Map<number, GlyphPlacement>();
		for (let page = 0; page < bins.length; ++page) {
			for (const rectangle of bins[page].rects) {
				placements.set(rectangle.glyph.unicode, {
					x: rectangle.x,
					y: rectangle.y,
					width: rectangle.width,
					height: rectangle.height,
					page,
					xOffset: (rectangle.glyph.left - rectangle.msdfData.range / 2) * run.fontSize,
					xAdvance: rectangle.glyph.advance * run.fontSize,
					range: rectangle.msdfData.range,
				});
			}
		}
		preparedRuns.push({ request: run, generator, glyphByCodepoint, placements, atlasPages, glyphCount: 0, fillPixelCount: 0, strokePixelCount: 0 });
	}
	type Token = { character: string; codepoint: number; runIndex: number; logicalStart: number; logicalLength: number; virtualHyphen?: boolean };
	const authoredLogicalLines = authoredProjectFontLogicalLines(options.runs.map((run) => run.text).join(""));
	const authoredTokenLines: Token[][] = [[]];
	let noBreakPreventedBreakCount = 0;
	let logicalOffset = 0;
	for (let runIndex = 0; runIndex < preparedRuns.length; ++runIndex) {
		for (const character of Array.from(preparedRuns[runIndex].request.text.replace(/\r\n?/g, "\n"))) {
			if (character === "\n") {
				authoredTokenLines.push([]);
			} else {
				authoredTokenLines[authoredTokenLines.length - 1].push({
					character,
					codepoint: character.codePointAt(0)!,
					runIndex,
					logicalStart: logicalOffset,
					logicalLength: character.length,
				});
			}
			logicalOffset += character.length;
		}
	}
	const horizontalScale = (run: IProjectFontTextStyleRunOptions): number => (run.horizontalScale ?? 100) / 100;
	const verticalScale = (run: IProjectFontTextStyleRunOptions): number => (run.verticalScale ?? 100) / 100;
	const advance = (token: Token, next: Token | undefined): number => {
		const run = preparedRuns[token.runIndex];
		if (token.codepoint === 9) {
			return run.generator.metrics.tabAdvance * run.request.fontSize * horizontalScale(run.request);
		}
		const glyph = run.glyphByCodepoint.get(token.codepoint)!;
		let result =
			glyph.advance * run.request.fontSize * horizontalScale(run.request) + (run.request.fauxBold ? Math.min(8, Math.max(1, Math.round(run.request.fontSize / 24))) : 0);
		if (next) {
			result += ((run.request.tracking * run.request.fontSize) / 1000) * horizontalScale(run.request);
			const nextRun = preparedRuns[next.runIndex];
			const manualKerningOwner = projectFontManualKerningOwnerRun(token.runIndex, next.runIndex, options.runs);
			if (manualKerningOwner !== null) {
				const owner = preparedRuns[manualKerningOwner].request;
				result += (((owner.kerning ?? 0) * owner.fontSize) / 1000) * horizontalScale(owner);
			}
			if (run.request.fontPath === nextRun.request.fontPath && run.request.fontSize === nextRun.request.fontSize && next.codepoint !== 9) {
				result += (glyph.kerning.find(([candidate]) => candidate.unicode === next.codepoint)?.[1] ?? 0) * run.request.fontSize * horizontalScale(run.request);
			}
		}
		return result;
	};
	const measureTokens = (tokens: Token[]): number => tokens.reduce((width, token, index) => width + advance(token, tokens[index + 1]), 0);
	const boxLayout = validateProjectFontTextBoxLayout(options.boxLayout);
	const lines: Token[][] = [];
	const logicalLines: IProjectFontLogicalLine[] = [];
	for (let authoredLineIndex = 0; authoredLineIndex < authoredTokenLines.length; ++authoredLineIndex) {
		const authoredTokens = authoredTokenLines[authoredLineIndex];
		const authoredLine = authoredLogicalLines[authoredLineIndex];
		if (!boxLayout || !authoredTokens.length) {
			lines.push(authoredTokens);
			logicalLines.push(authoredLine);
			continue;
		}
		const paragraphRun =
			options.paragraphRuns?.find((run) => authoredLine.logicalStart >= run.start && authoredLine.logicalStart < run.start + run.length) ??
			options.paragraphRuns?.[options.paragraphRuns.length - 1];
		const primarySpan = (firstLine: boolean): number => {
			const result =
				boxLayout.right - boxLayout.left - (paragraphRun?.startIndent ?? 0) - (paragraphRun?.endIndent ?? 0) - (firstLine ? (paragraphRun?.firstLineIndent ?? 0) : 0);
			if (result <= 0) {
				throw new Error(`PSD paragraph run ${paragraphRun?.sourceParagraphRunIndex ?? 0} indents leave no positive authored box-text wrapping span.`);
			}
			return result;
		};
		const sliceTokens = (logicalStart: number, logicalEnd: number, hyphenRunIndex: number | null): Token[] => {
			const result = authoredTokens.filter((token) => token.logicalStart >= logicalStart && token.logicalStart < logicalEnd);
			if (hyphenRunIndex !== null) {
				result.push({ character: "-", codepoint: 45, runIndex: hyphenRunIndex, logicalStart: logicalEnd, logicalLength: 0, virtualHyphen: true });
			}
			return result;
		};
		const composition = composeProjectFontAuthoredBoxLine({
			fullText: options.runs.map((run) => run.text).join(""),
			authoredLine,
			paragraphRun,
			styleRuns: options.runs,
			primarySpan,
			canBreakAt: () => true,
			onNoBreakPreventedBreak: () => noBreakPreventedBreakCount++,
			measure: (logicalStart, logicalEnd, hyphenRunIndex) => measureTokens(sliceTokens(logicalStart, logicalEnd, hyphenRunIndex)),
		});
		for (const logicalLine of composition) {
			const hyphenRunIndex = logicalLine.insertedHyphen ? projectFontStyleRunIndexAt(options.runs, Math.max(logicalLine.logicalStart, logicalLine.logicalEnd - 1)) : null;
			lines.push(sliceTokens(logicalLine.logicalStart, logicalLine.logicalEnd, hyphenRunIndex));
			logicalLines.push(logicalLine);
		}
	}
	const lineWidths = lines.map(measureTokens);
	const maximumAscender = Math.max(...preparedRuns.map((run) => run.generator.metrics.ascenderY * run.request.fontSize * verticalScale(run.request)));
	const paragraphLayout = prepareProjectFontParagraphLineLayouts(
		options,
		lineWidths,
		preparedRuns.map((run) => run.generator.metrics.lineHeight * run.request.fontSize * verticalScale(run.request)),
		logicalLines
	);
	const boxLayoutEvidence: IProjectFontTextBoxLayoutEvidence | null = boxLayout
		? {
				...boxLayout,
				authoredLineCount: authoredLogicalLines.length,
				composedLineCount: logicalLines.length,
				softBreakCount: logicalLines.filter((line) => line.softWrapped).length,
				hyphenatedLineCount: logicalLines.filter((line) => line.insertedHyphen).length,
				insertedHyphenCount: logicalLines.filter((line) => line.insertedHyphen).length,
				hyphenationLanguages: [...new Set(logicalLines.map((line) => line.hyphenationLanguage).filter((language): language is string => language !== null))],
				noBreakRunCount: options.runs.filter((run) => run.noBreak === true).length,
				noBreakPreventedBreakCount,
				noBreakExecutionModel: options.runs.some((run) => run.noBreak === true) ? "bounded-authored-no-break-v1" : "disabled",
				overflowLineCount: lineWidths.filter((width, lineIndex) => {
					const line = logicalLines[lineIndex];
					const paragraphRun =
						options.paragraphRuns?.find((run) => line.logicalStart >= run.start && line.logicalStart < run.start + run.length) ??
						options.paragraphRuns?.[options.paragraphRuns.length - 1];
					const span =
						boxLayout.right -
						boxLayout.left -
						(paragraphRun?.startIndent ?? 0) -
						(paragraphRun?.endIndent ?? 0) -
						(line.firstInParagraph ? (paragraphRun?.firstLineIndent ?? 0) : 0);
					const layout = paragraphLayout.lines[lineIndex];
					return width > span || layout.crossPosition < boxLayout.top || layout.crossPosition + layout.lineHeight > boxLayout.bottom;
				}).length,
				wrapModel: logicalLines.some((line) => line.insertedHyphen) ? "bounded-dictionary-hyphenation-wrap-v1" : "bounded-whitespace-cluster-wrap-v1",
				composerModel: projectFontBoxComposerModel(options),
				lines: logicalLines.map((line, lineIndex) => {
					const paragraphRun =
						options.paragraphRuns?.find((run) => line.logicalStart >= run.start && line.logicalStart < run.start + run.length) ??
						options.paragraphRuns?.[options.paragraphRuns.length - 1];
					const available =
						boxLayout.right -
						boxLayout.left -
						(paragraphRun?.startIndent ?? 0) -
						(paragraphRun?.endIndent ?? 0) -
						(line.firstInParagraph ? (paragraphRun?.firstLineIndent ?? 0) : 0);
					return {
						lineIndex,
						logicalStart: line.logicalStart,
						logicalEnd: line.logicalEnd,
						advance: lineWidths[lineIndex],
						available,
						lineHeight: paragraphLayout.lines[lineIndex].lineHeight,
						lineHeightSource: paragraphLayout.lines[lineIndex].lineHeightSource,
						leadingSourceStyleRunIndices: paragraphLayout.lines[lineIndex].leadingRunIndices.map((runIndex) => options.runs[runIndex].sourceStyleRunIndex),
						softWrapped: line.softWrapped,
						insertedHyphen: line.insertedHyphen,
						hyphenationLanguage: line.hyphenationLanguage,
						overflow: lineWidths[lineIndex] > available,
					};
				}),
				executionModel: "bounded-authored-box-text-layout-v1",
			}
		: null;
	const output = new Uint8Array(options.width * options.height * 4);
	let glyphCount = 0;
	let clippedPixelCount = 0;
	let inkLeft = options.width;
	let inkTop = options.height;
	let inkRight = 0;
	let inkBottom = 0;
	const blendPixel = (destination: number, alpha: number, color: [number, number, number, number]): void => {
		const sourceAlpha = (alpha / 255) * (color[3] / 255);
		if (sourceAlpha <= 0) {
			return;
		}
		const destinationAlpha = output[destination + 3] / 255;
		const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
		for (let channel = 0; channel < 3; ++channel) {
			const premultiplied = color[channel] * sourceAlpha + output[destination + channel] * destinationAlpha * (1 - sourceAlpha);
			output[destination + channel] = outputAlpha > 0 ? Math.round(premultiplied / outputAlpha) : 0;
		}
		output[destination + 3] = Math.round(outputAlpha * 255);
	};
	const paintTextPixel = (run: PreparedRun, x: number, y: number, fillAlpha: number, strokeAlpha: number): boolean => {
		const fillEnabled = run.request.fillEnabled ?? true;
		const strokeEnabled = run.request.strokeEnabled ?? false;
		const operations = run.request.fillFirst === false ? (["stroke", "fill"] as const) : (["fill", "stroke"] as const);
		let painted = false;
		for (const operation of operations) {
			if (operation === "fill" && fillEnabled && fillAlpha > 0 && run.request.color[3] > 0) {
				blendPixel((y * options.width + x) * 4, fillAlpha, run.request.color);
				run.fillPixelCount++;
				painted = true;
			} else if (operation === "stroke" && strokeEnabled && strokeAlpha > 0 && run.request.strokeColor && run.request.strokeColor[3] > 0) {
				blendPixel((y * options.width + x) * 4, strokeAlpha, run.request.strokeColor);
				run.strokePixelCount++;
				painted = true;
			}
		}
		if (painted) {
			inkLeft = Math.min(inkLeft, x);
			inkTop = Math.min(inkTop, y);
			inkRight = Math.max(inkRight, x + 1);
			inkBottom = Math.max(inkBottom, y + 1);
		}
		return painted;
	};
	const paintHorizontalDecoration = (run: IProjectFontTextStyleRunOptions, start: number, end: number, baseline: number): void => {
		if ((!run.underline && !run.strikethrough) || run.fillEnabled === false) {
			return;
		}
		const scale = verticalScale(run);
		const thickness = Math.max(1, Math.round(run.fontSize * 0.06 * scale));
		const paintLine = (y: number): void => {
			for (let x = Math.floor(Math.min(start, end)); x < Math.ceil(Math.max(start, end)); ++x) {
				for (let offset = 0; offset < thickness; ++offset) {
					const destinationY = Math.round(y) + offset;
					if (x < 0 || destinationY < 0 || x >= options.width || destinationY >= options.height) {
						clippedPixelCount++;
						continue;
					}
					blendPixel((destinationY * options.width + x) * 4, 255, run.color);
					inkLeft = Math.min(inkLeft, x);
					inkTop = Math.min(inkTop, destinationY);
					inkRight = Math.max(inkRight, x + 1);
					inkBottom = Math.max(inkBottom, destinationY + 1);
				}
			}
		};
		if (run.underline) {
			paintLine(baseline + run.fontSize * 0.08 * scale);
		}
		if (run.strikethrough) {
			paintLine(baseline - run.fontSize * 0.3 * scale);
		}
	};
	for (let lineIndex = 0; lineIndex < lines.length; ++lineIndex) {
		const line = lines[lineIndex];
		let cursorX = paragraphLayout.lines[lineIndex].primaryStart;
		const lineTop = paragraphLayout.lines[lineIndex].crossPosition;
		for (let index = 0; index < line.length; ++index) {
			const token = line[index];
			const run = preparedRuns[token.runIndex];
			const runHorizontalScale = horizontalScale(run.request);
			const runVerticalScale = verticalScale(run.request);
			const baselineShift = run.request.baselineShift ?? 0;
			if (token.codepoint !== 9) {
				const placement = run.placements.get(token.codepoint);
				if (placement && placement.width > 0 && placement.height > 0) {
					glyphCount++;
					run.glyphCount++;
					const page = run.atlasPages[placement.page];
					const glyph = run.glyphByCodepoint.get(token.codepoint)!;
					const destinationLeft = Math.round(cursorX + placement.xOffset * runHorizontalScale);
					const destinationTop = Math.round(lineTop + maximumAscender - (glyph.top + placement.range / 2) * run.request.fontSize * runVerticalScale - baselineShift);
					const fauxBoldPixels = run.request.fauxBold ? Math.min(8, Math.max(1, Math.round(run.request.fontSize / 24))) : 0;
					const fauxItalicShear = run.request.fauxItalic ? Math.tan((12 * Math.PI) / 180) : 0;
					const scaledWidth = Math.max(1, Math.round(placement.width * runHorizontalScale));
					const scaledHeight = Math.max(1, Math.round(placement.height * runVerticalScale));
					for (let y = 0; y < scaledHeight; ++y) {
						for (let x = 0; x < scaledWidth; ++x) {
							const sourceX = Math.min(placement.width - 1, Math.floor(x / runHorizontalScale));
							const sourceY = Math.min(placement.height - 1, Math.floor(y / runVerticalScale));
							const coverage = projectFontMsdfPaintCoverage(
								page.pixels,
								((placement.y + sourceY) * page.width + placement.x + sourceX) * 4,
								page.distanceRange,
								run.request.outlineWidth ?? 1
							);
							if (!coverage.fillAlpha && !coverage.strokeAlpha) {
								continue;
							}
							const italicOffset = Math.round((scaledHeight - 1 - y) * fauxItalicShear);
							for (let boldOffset = 0; boldOffset <= fauxBoldPixels; ++boldOffset) {
								const destinationX = destinationLeft + x + italicOffset + boldOffset;
								const destinationY = destinationTop + y;
								if (destinationX < 0 || destinationY < 0 || destinationX >= options.width || destinationY >= options.height) {
									clippedPixelCount++;
									continue;
								}
								paintTextPixel(run, destinationX, destinationY, coverage.fillAlpha, coverage.strokeAlpha);
							}
						}
					}
				}
			}
			const tokenAdvance = advance(token, line[index + 1]) + (token.character === " " ? paragraphLayout.lines[lineIndex].extraWordSpacing : 0);
			paintHorizontalDecoration(run.request, cursorX, cursorX + tokenAdvance, lineTop + maximumAscender - baselineShift);
			cursorX += tokenAdvance;
		}
	}
	const manualKerningAppliedCounts = options.runs.map(() => 0);
	for (const line of lines) {
		for (let tokenIndex = 0; tokenIndex < line.length - 1; ++tokenIndex) {
			const ownerRunIndex = projectFontManualKerningOwnerRun(line[tokenIndex].runIndex, line[tokenIndex + 1].runIndex, options.runs);
			if (ownerRunIndex !== null) {
				manualKerningAppliedCounts[ownerRunIndex]++;
			}
		}
	}
	return {
		pixels: output,
		orientation,
		lineCount: lines.length,
		glyphCount,
		uniqueGlyphCount: allCodepoints.size,
		lineHeight: Math.max(...paragraphLayout.lines.map((line) => line.lineHeight)),
		inkBounds: inkRight > inkLeft && inkBottom > inkTop ? { left: inkLeft, top: inkTop, right: inkRight, bottom: inkBottom } : null,
		clippedPixelCount,
		shaping: null,
		shapedGlyphs: [],
		styleRuns: preparedRuns.map((run, runIndex) => ({
			fontPath: run.request.fontPath,
			fontSize: run.request.fontSize,
			tracking: run.request.tracking,
			color: run.request.color,
			fillEnabled: run.request.fillEnabled ?? true,
			strokeEnabled: run.request.strokeEnabled ?? false,
			strokeColor: run.request.strokeColor ?? null,
			fillFirst: run.request.fillFirst ?? true,
			outlineWidth: run.request.outlineWidth ?? 1,
			fillPixelCount: run.fillPixelCount,
			strokePixelCount: run.strokePixelCount,
			textPaintExecutionModel:
				run.request.fillEnabled !== undefined ||
				run.request.strokeEnabled !== undefined ||
				run.request.strokeColor !== undefined ||
				run.request.fillFirst !== undefined ||
				run.request.outlineWidth !== undefined
					? "bounded-authored-text-fill-stroke-v1"
					: "disabled",
			strokeRasterModel: run.request.strokeEnabled ? "bounded-msdf-centered-outline-v1" : "disabled",
			sourceStyleRunIndex: run.request.sourceStyleRunIndex,
			fontIndex: run.request.fontIndex,
			fontName: run.request.fontName,
			photoshopLanguageIndex: run.request.language ?? null,
			photoshopLanguage: run.request.language === null || run.request.language === undefined ? null : projectFontPhotoshopLanguage(run.request.language).language,
			effectiveShapingLanguage: run.request.language === null || run.request.language === undefined ? null : projectFontPhotoshopLanguage(run.request.language).language,
			languageSource: run.request.language === null || run.request.language === undefined ? "default" : "authored",
			languageExecutionModel: run.request.language === null || run.request.language === undefined ? "disabled" : "bounded-authored-photoshop-language-v1",
			fauxBold: run.request.fauxBold,
			fauxItalic: run.request.fauxItalic,
			horizontalScale: run.request.horizontalScale ?? 100,
			verticalScale: run.request.verticalScale ?? 100,
			baselineShift: run.request.baselineShift ?? 0,
			underline: run.request.underline ?? false,
			strikethrough: run.request.strikethrough ?? false,
			noBreak: run.request.noBreak ?? false,
			noBreakExecutionModel: run.request.noBreak ? "bounded-authored-no-break-v1" : "disabled",
			autoLeading: run.request.autoLeading ?? null,
			leading: run.request.leading ?? null,
			leadingAppliedLineIndices: paragraphLayout.lines.flatMap((line, lineIndex) => (line.leadingRunIndices.includes(runIndex) ? [lineIndex] : [])),
			leadingAppliedLineHeights: paragraphLayout.lines.flatMap((line) => (line.leadingRunIndices.includes(runIndex) ? [line.lineHeight] : [])),
			leadingExecutionModel:
				(run.request.autoLeading !== undefined && run.request.autoLeading !== null) || (run.request.leading !== undefined && run.request.leading !== null)
					? "bounded-authored-character-leading-v1"
					: "disabled",
			kerning: run.request.kerning ?? null,
			manualKerningBoundaryUtf16: (run.request.kerning ?? 0) !== 0 ? runStarts[runIndex] : null,
			manualKerningPixels: (run.request.kerning ?? 0) !== 0 ? (((run.request.kerning ?? 0) * run.request.fontSize) / 1000) * horizontalScale(run.request) : 0,
			manualKerningAppliedBoundaryCount: manualKerningAppliedCounts[runIndex],
			manualKerningExecutionModel: (run.request.kerning ?? 0) !== 0 ? "bounded-authored-manual-kerning-v1" : "disabled",
			autoKerning: run.request.autoKerning ?? null,
			ligatures: run.request.ligatures ?? null,
			discretionaryLigatures: run.request.discretionaryLigatures ?? null,
			fontCaps: run.request.fontCaps ?? null,
			smallCapScale: run.request.smallCapScale ?? 0.7,
			capsAppliedScale: 1,
			capsAffectedCharacterCount: projectFontCapsAffectedCharacterCount(run.request.text, run.request.fontCaps),
			capsGlyphSource: "disabled",
			capsExecutionModel: run.request.fontCaps === null || run.request.fontCaps === undefined ? "disabled" : "bounded-authored-font-caps-v1",
			fontBaseline: run.request.fontBaseline ?? null,
			fontBaselineScale: run.request.fontBaselineScale ?? 0.583,
			fontBaselinePosition: run.request.fontBaselinePosition ?? 0.333,
			fontBaselineAppliedScale: 1,
			fontBaselineAppliedShift: run.request.baselineShift ?? 0,
			fontBaselineEffectiveFeature: null,
			fontBaselineGlyphSource: "disabled",
			fontBaselineExecutionModel: run.request.fontBaseline === null || run.request.fontBaseline === undefined ? "disabled" : "bounded-authored-font-baseline-v1",
			baselineDirection: run.request.baselineDirection ?? null,
			baselineDirectionGlyphs: [],
			tateChuYokoBlocks: [],
			baselineDirectionExecutionModel: "disabled",
			proportionalMetrics: run.request.proportionalMetrics ?? null,
			proportionalMetricsFeatureSupported: false,
			proportionalMetricsExecutionModel: "disabled",
			kana: run.request.kana ?? null,
			kanaFeatureSupported: false,
			kanaExecutionModel: "disabled",
			ruby: run.request.ruby ?? null,
			rubyFeatureSupported: false,
			rubyExecutionModel: "disabled",
			japaneseAlternateFeature: run.request.japaneseAlternateFeature ?? null,
			japaneseAlternateFeatureTag: projectFontJapaneseAlternateFeatureTag(run.request.japaneseAlternateFeature),
			japaneseAlternateFeatureSupported: run.request.japaneseAlternateFeature === "normal",
			japaneseAlternateFeatureAvailableTags: [],
			japaneseAlternateFeatureExecutionModel: "disabled",
			fractions: run.request.fractions ?? null,
			fractionsFeatureSupported: false,
			ordinals: run.request.ordinals ?? null,
			ordinalsFeatureSupported: false,
			stylisticAlternates: run.request.stylisticAlternates ?? null,
			stylisticAlternatesFeatureSupported: false,
			oldStyle: run.request.oldStyle ?? null,
			oldStyleFeatureSupported: false,
			swash: run.request.swash ?? null,
			swashFeatureSupported: false,
			titling: run.request.titling ?? null,
			titlingFeatureSupported: false,
			ornaments: run.request.ornaments ?? null,
			ornamentsFeatureSupported: false,
			slashedZero: run.request.slashedZero ?? null,
			slashedZeroFeatureSupported: false,
			characterOpenTypeExecutionModel: "disabled",
			connectionForms: run.request.connectionForms ?? null,
			connectionFormsFeatureSupported: false,
			connectionFormsExecutionModel: "disabled",
			contextualLigatures: run.request.contextualLigatures ?? null,
			contextualLigaturesFeatureSupported: false,
			contextualLigaturesExecutionModel: "disabled",
			hindiNumbers: run.request.hindiNumbers ?? null,
			hindiNumbersAffectedCharacterCount: 0,
			hindiNumbersEffectiveDigits: "default",
			hindiNumbersExecutionModel: "disabled",
			kashida: run.request.kashida ?? null,
			kashidaEligibleJoinCount: 0,
			kashidaInsertedCount: 0,
			kashidaInsertedAdvance: 0,
			kashidaExecutionModel: "disabled",
			diacriticPosition: run.request.diacriticPosition ?? null,
			diacriticAffectedGlyphCount: 0,
			diacriticGlyphs: [],
			diacriticExecutionModel: run.request.diacriticPosition === null || run.request.diacriticPosition === undefined ? "disabled" : "inactive-no-combining-diacritics",
			characterDirection: run.request.characterDirection ?? null,
			characterDirectionOverrideCharacterCount: 0,
			characterDirectionResolvedEmbeddingLevels: [],
			characterDirectionExecutionModel: "disabled",
			figureStyle: run.request.figureStyle ?? null,
			figureStyleLiningFeatureSupported: false,
			figureStyleOldStyleFeatureSupported: false,
			figureStyleProportionalFeatureSupported: false,
			figureStyleTabularFeatureSupported: false,
			figureStyleExecutionModel: "disabled",
			engineData2StyleRunIndex: run.request.engineData2StyleRunIndex ?? null,
			engineData2ExecutionModel: "disabled",
			stylisticOpenTypeExecutionModel: "disabled",
			wariChuEnabled: run.request.wariChuEnabled ?? null,
			wariChuLineCount: run.request.wariChuLineCount ?? 2,
			wariChuLineGap: run.request.wariChuLineGap ?? 0,
			wariChuScale: run.request.wariChuScale ?? 0.5,
			wariChuWidow: run.request.wariChuWidow ?? 2,
			wariChuOrphan: run.request.wariChuOrphan ?? 2,
			wariChuJustification: run.request.wariChuJustification ?? "auto",
			wariChuBlocks: [],
			wariChuExecutionModel: "disabled",
			tsume: run.request.tsume ?? null,
			tsumeAppliedGlyphCount: 0,
			tsumeLeadingTrim: 0,
			tsumeTrailingTrim: 0,
			tsumeAdvanceReduction: 0,
			tsumeGlyphs: [],
			tsumeExecutionModel: run.request.tsume === null || run.request.tsume === undefined ? "disabled" : "bounded-authored-tsume-v1",
			styleRunAlignment: run.request.styleRunAlignment ?? null,
			styleRunAlignmentGlyphs: [],
			styleRunAlignmentExecutionModel: "disabled",
			effectiveOpenTypeFeatures: [],
			openTypeFeatureExecutionModel: "disabled",
			length: run.request.text.length,
			glyphCount: run.glyphCount,
			fauxBoldPixels: run.request.fauxBold ? Math.min(8, Math.max(1, Math.round(run.request.fontSize / 24))) : 0,
			fauxItalicShear: run.request.fauxItalic ? Math.tan((12 * Math.PI) / 180) : 0,
			decorationThickness: Math.max(1, Math.round(run.request.fontSize * 0.06 * verticalScale(run.request))),
			characterStyleExecutionModel: "bounded-authored-character-style-v1",
			shapedGlyphs: [],
		})),
		paragraphRuns: paragraphLayout.evidence,
		boxLayout: boxLayoutEvidence,
		executionModel: "bounded-project-font-text-style-runs-v1",
	};
}

/** Generates one dynamic or bitmap/SDF/MSDF font artifact set at the requested destination. */
export async function processFontImporterOutput(sourcePath: string, requestedOutputPath: string, settings: IFontImporterSettings): Promise<IFontImportResult> {
	validateFontImporterSource(sourcePath, settings);
	const sourceDetails = await stat(sourcePath);
	const outputDirectory = dirname(requestedOutputPath);
	const base = basename(requestedOutputPath, extname(requestedOutputPath));
	const manifestPath = join(outputDirectory, `${base}.font.json`);
	const family = fontFamily(sourcePath);
	await ensureDir(outputDirectory);

	if (settings.renderMode === "dynamic") {
		await copyFile(sourcePath, requestedOutputPath);
		const dynamicManifest: IFontAtlasManifest = {
			version: 1,
			renderMode: "dynamic",
			family,
			fontSize: settings.fontSize,
			padding: settings.padding,
			distanceRange: settings.distanceRange,
			lineHeight: settings.fontSize,
			base: settings.fontSize,
			ascender: settings.fontSize,
			descender: 0,
			pages: [],
			characters: [],
			kernings: [],
			missingCodepoints: [],
			dynamicFontPath: basename(requestedOutputPath),
			sourceFontPath: basename(requestedOutputPath),
		};
		await writeJSON(manifestPath, dynamicManifest, { spaces: "\t" });
		return {
			sourcePath,
			outputDirectory,
			manifestPath,
			renderMode: "dynamic",
			settings,
			family,
			sourceBytes: sourceDetails.size,
			glyphCount: 0,
			missingCodepoints: [],
			pages: [],
			dynamicFontPath: requestedOutputPath,
			sourceFontPath: requestedOutputPath,
		};
	}

	await copyFile(sourcePath, requestedOutputPath);
	const wasm = await readFile(require.resolve("msdfgen-wasm/wasm"));
	const generator = await Msdfgen.create(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
	generator.loadFont(await readFile(sourcePath));
	const requestedCodepoints = getFontImporterCodepoints(settings);
	generator.loadGlyphs(requestedCodepoints, { preprocess: true });
	const presentCodepoints = new Set(generator.glyphs.map((glyph) => glyph.unicode));
	const missingCodepoints = requestedCodepoints.filter((codepoint) => !presentCodepoints.has(codepoint));
	const msdfOptions = { size: settings.fontSize, range: settings.distanceRange, edgeColoring: "inktrap" as const, edgeThresholdAngle: 3, scanline: false };
	const bins = generator.packGlyphs(msdfOptions, {
		maxWidth: 2048,
		maxHeight: 2048,
		padding: settings.padding,
		pot: true,
		smart: true,
		allowRotation: false,
	});
	const round = (value: number): number => Math.round(value * settings.fontSize * 100) / 100;
	const characters: IFontAtlasCharacter[] = [];
	const kernings: IFontAtlasKerning[] = [];
	const pages: IFontAtlasPage[] = [];
	for (let page = 0; page < bins.length; page++) {
		const bin = bins[page];
		const pageName = `${base}.font-${page}.png`;
		const pagePath = join(outputDirectory, pageName);
		const image = await convertMsdfPage(generator.createAtlasImage(bin), settings.renderMode, settings.distanceRange);
		await writeFile(pagePath, image);
		pages.push({ path: pagePath, width: bin.width, height: bin.height, bytes: image.length });
		for (const rectangle of bin.rects) {
			const glyph = rectangle.glyph;
			const range = rectangle.msdfData.range;
			const hasSize = rectangle.width > 0 && rectangle.height > 0;
			characters.push({
				id: glyph.unicode,
				char: String.fromCodePoint(glyph.unicode),
				page,
				x: rectangle.x,
				y: rectangle.y,
				width: rectangle.width,
				height: rectangle.height,
				xAdvance: round(glyph.advance),
				xOffset: hasSize ? round(glyph.left - range / 2) : 0,
				yOffset: hasSize ? round(generator.metrics.ascenderY - (glyph.top + range / 2)) : 0,
				rotated: rectangle.rot || undefined,
			});
			for (const [second, amount] of glyph.kerning) {
				kernings.push({ first: glyph.unicode, second: second.unicode, amount: round(amount) });
			}
		}
	}
	const manifest: IFontAtlasManifest = {
		version: 1,
		renderMode: settings.renderMode,
		family,
		fontSize: settings.fontSize,
		padding: settings.padding,
		distanceRange: settings.distanceRange,
		lineHeight: round(generator.metrics.lineHeight),
		base: round(generator.metrics.ascenderY),
		ascender: round(generator.metrics.ascenderY),
		descender: round(generator.metrics.descenderY),
		pages: pages.map((page) => basename(page.path)),
		characters: characters.sort((left, right) => left.id - right.id),
		kernings,
		missingCodepoints,
		dynamicFontPath: null,
		sourceFontPath: basename(requestedOutputPath),
	};
	await writeJSON(manifestPath, manifest, { spaces: "\t" });
	return {
		sourcePath,
		outputDirectory,
		manifestPath,
		renderMode: settings.renderMode,
		settings,
		family,
		sourceBytes: sourceDetails.size,
		glyphCount: characters.length,
		missingCodepoints,
		pages,
		dynamicFontPath: null,
		sourceFontPath: requestedOutputPath,
	};
}

async function artifactPaths(path: string): Promise<{ artifactDirectory: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const artifactDirectory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactDirectory, manifestPath: join(artifactDirectory, "font-import.json") };
}

/** Inspects whether the deterministic imported font artifact matches the source and effective settings. */
export async function getFontImporterArtifactStatus(path: string): Promise<IFontImporterArtifactStatus> {
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "font") {
		throw new Error("Font importer artifacts are only available for font assets.");
	}
	const settings = normalizeFontImporterSettings(metadata.importer.settings);
	validateFontImporterSource(path, settings);
	const fingerprint = await fontImporterFingerprint(path, settings);
	const { artifactDirectory, manifestPath } = await artifactPaths(path);
	let result: IFontImportResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result as IFontImportResult;
		}
	} catch {
		// A missing or malformed lease manifest makes the artifact stale.
	}
	const exists = result ? await pathExists(result.manifestPath) : await pathExists(artifactDirectory);
	return { path, artifactDirectory, manifestPath, fingerprint, current: result !== null && exists, exists, result };
}

/** Applies one exact-fingerprint font importer and atomically replaces its project-local artifact directory. */
export async function applyFontImporterArtifact(path: string, expectedFingerprint: string): Promise<IFontImporterArtifactStatus> {
	return applyImporterArtifactWithAccelerator({
		kind: "font",
		sourcePath: path,
		expectedFingerprint,
		inspect: () => getFontImporterArtifactStatus(path),
		applyLocal: () => applyFontImporterArtifactLocally(path, expectedFingerprint),
	});
}

async function applyFontImporterArtifactLocally(path: string, expectedFingerprint: string): Promise<IFontImporterArtifactStatus> {
	const status = await getFontImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Font importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeFontImporterSettings(metadata.importer.settings);
	const temporaryDirectory = `${status.artifactDirectory}.tmp-${process.pid}-${Date.now()}`;
	await remove(temporaryDirectory);
	try {
		const requestedOutput = join(temporaryDirectory, basename(path));
		const generated = await processFontImporterOutput(path, requestedOutput, settings);
		await remove(status.artifactDirectory);
		await ensureDir(dirname(status.artifactDirectory));
		await move(temporaryDirectory, status.artifactDirectory, { overwrite: true });
		const remap = (value: string): string => value.replace(temporaryDirectory, status.artifactDirectory);
		const result: IFontImportResult = {
			...generated,
			outputDirectory: status.artifactDirectory,
			manifestPath: remap(generated.manifestPath),
			pages: generated.pages.map((page) => ({ ...page, path: remap(page.path) })),
			dynamicFontPath: generated.dynamicFontPath ? remap(generated.dynamicFontPath) : null,
			sourceFontPath: generated.sourceFontPath ? remap(generated.sourceFontPath) : null,
		};
		await writeJSON(status.manifestPath, { version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporaryDirectory).catch(() => undefined);
		throw error;
	}
}

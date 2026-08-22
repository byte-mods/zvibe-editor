import { createHash, randomUUID } from "crypto";
import { isAbsolute as isNativeAbsolute, normalize as normalizeNativePath } from "path";
import { basename, dirname, extname, join, relative, resolve } from "path/posix";

import { ensureDir, move, pathExists, readFile, remove, stat, writeFile } from "fs-extra";
import sharp from "sharp";

import {
	applyPsdLayerAdjustment,
	applyPsdSmartFilters,
	decodePsd,
	decodeTga,
	decodePsdAdjustmentMasks,
	decodePsdLayerMasks,
	decodePsdPatterns,
	decodePsdLayers,
	decodePsdSmartFilterMasks,
	decodePsdSmartObjectResources,
	inspectPsdNestedSmartObjectDocuments,
	IDecodedPsdSmartObjectResource,
	IDecodedPsdPattern,
	IDecodedPsdLayer,
	IDecodedPsdSmartFilterMask,
	inspectPsdLayers,
	IPsdEmbeddedPatternInfo,
	IPsdLayerEffectContourInfo,
	IPsdLayerBevelEffectInfo,
	IPsdLayerDocumentInfo,
	IPsdLayerDropShadowEffectInfo,
	IPsdLayerInfo,
	IPsdLayerAdjustmentInfo,
	IPsdLayerInnerGlowEffectInfo,
	IPsdLayerInnerShadowEffectInfo,
	IPsdLayerGradientInfo,
	IPsdLayerGradientOverlayEffectInfo,
	IPsdLayerOuterGlowEffectInfo,
	IPsdLayerPatternInfo,
	IPsdLayerPatternOverlayEffectInfo,
	IPsdNestedSmartObjectDocumentInfo,
	PsdSmartObjectPresetWarpStyle,
	IPsdSmartFilterInfo,
	IPsdDisplacementMapBinding,
	IPsdDisplacementMapBindingEvidence as IPsdDisplacementMapRuntimeEvidence,
	IPsdShapeBlurKernelBinding,
	IPsdLayerSatinEffectInfo,
	IPsdLayerSolidFillEffectInfo,
	IPsdLayerStrokeEffectInfo,
	IPsdModernLayerEffectDescriptorInfo,
	PsdModernLayerEffectDescriptorKey,
	PSD_SMART_OBJECT_PRESET_WARP_STYLES,
	renderPsdSmartObjectPlacement,
	renderPsdSmartObjectPresetWarpPlacement,
	renderPsdSmartObjectQuiltWarpPlacement,
	renderPsdSmartObjectWarpPlacement,
	samplePsdPatternPixel,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import {
	IProjectFontShapedGlyphEvidence,
	IProjectFontTextBoxLayoutEvidence,
	IProjectFontTextBoxLayoutOptions,
	IProjectFontTextParagraphRunEvidence,
	IProjectFontTextParagraphRunOptions,
	IProjectFontTextRenderResult,
	IProjectFontTextShapingOptions,
	normalizeProjectFontTextShaping,
	renderProjectFontText,
	renderProjectFontTextStyleRuns,
} from "./font-importer";

const MAXIMUM_SOURCE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_EXTRACTED_LAYERS = 512;
const MAXIMUM_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAXIMUM_EFFECT_BAKE_PIXELS = 4_194_304;
const MAXIMUM_GROUP_COMPOSITE_DEPTH = 32;
const SUPPORTED_CLIPPING_BLEND_MODES = new Set([
	"norm",
	"mul ",
	"scrn",
	"over",
	"dark",
	"lite",
	"div ",
	"idiv",
	"hLit",
	"sLit",
	"diff",
	"smud",
	"lddg",
	"lbrn",
	"fsub",
	"fdiv",
	"hue ",
	"sat ",
	"colr",
	"lum ",
]);
const PSD_FILL_OPACITY_MODULATING_BLEND_MODES = new Set(["div ", "idiv", "lddg", "lbrn", "vLit", "lLit", "hMix", "diff"]);

type Rgb = [number, number, number];
type PsdBakeEntry =
	| { type: "solidFill"; effect: IPsdLayerSolidFillEffectInfo }
	| { type: "innerShadow"; effect: IPsdLayerInnerShadowEffectInfo }
	| { type: "innerGlow"; effect: IPsdLayerInnerGlowEffectInfo }
	| { type: "dropShadow"; effect: IPsdLayerDropShadowEffectInfo }
	| { type: "outerGlow"; effect: IPsdLayerOuterGlowEffectInfo }
	| { type: "bevel"; effect: IPsdLayerBevelEffectInfo }
	| { type: "satin"; effect: IPsdLayerSatinEffectInfo }
	| { type: "stroke"; effect: IPsdLayerStrokeEffectInfo }
	| { type: "gradientOverlay"; effect: IPsdLayerGradientOverlayEffectInfo }
	| { type: "patternOverlay"; effect: IPsdLayerPatternOverlayEffectInfo };
type PsdEffectBakePhase = "all" | "behind" | "foreground";

export interface IPsdLayerExtractionOptions {
	destinationFolder?: string;
	includeHidden?: boolean;
	applyOpacity?: boolean;
	applyLayerEffects?: boolean;
	applyAdjustments?: boolean;
	compositeClippingGroups?: boolean;
	compositeGroups?: boolean;
	layerIndices?: number[];
	textRenders?: IPsdTextRenderRequest[];
	extractSmartObjectPayloads?: boolean;
	smartObjectResourceIds?: string[];
	smartObjectExternalBindings?: IPsdSmartObjectExternalBindingRequest[];
	shapeBlurKernelBindings?: IPsdShapeBlurKernelBindingRequest[];
	displacementMapBindings?: IPsdDisplacementMapBindingRequest[];
	inspectNestedSmartObjects?: boolean;
	nestedSmartObjectMaximumDepth?: number;
	renderEmbeddedSmartObjects?: boolean;
	renderExternalSmartObjects?: boolean;
	smartObjectRenderLayerIndices?: number[];
}

export interface IPsdSmartObjectExternalBindingRequest {
	resourceIndex: number;
	sourcePath: string;
	allowSizeMismatch?: boolean;
}

export interface IPsdShapeBlurKernelBindingRequest {
	shapeId: string;
	sourcePath: string;
	coverageSource?: "auto" | "alpha" | "luminance";
	invert?: boolean;
}

export interface IPsdDisplacementMapBindingRequest {
	layerIndex: number;
	filterIndex: number;
	sourcePath: string;
}

export interface IPsdDisplacementMapBindingEvidence extends IPsdDisplacementMapRuntimeEvidence {
	layerIndex: number;
	layerName: string;
	storedSignature: string;
	storedPath: string;
}

export interface IPsdShapeBlurKernelBindingEvidence {
	shapeId: string;
	shapeName: string;
	sourcePath: string;
	sourceHash: string;
	sourceBytes: number;
	width: number;
	height: number;
	requestedCoverageSource: "auto" | "alpha" | "luminance";
	effectiveCoverageSource: "alpha" | "luminance";
	invert: boolean;
	coverageMinimum: number;
	coverageMaximum: number;
	nonZeroSampleCount: number;
	executionModel: "bounded-custom-shape-blur-kernel-binding-v1";
}

export interface IPsdTextRenderRequest {
	layerIndex: number;
	text?: string;
	fontPath: string;
	fontSize?: number;
	lineHeight?: number | null;
	tracking?: number;
	justification?: "left" | "center" | "right";
	offsetX?: number;
	offsetY?: number;
	color?: [number, number, number, number];
	useAuthoredStyleRuns?: boolean;
	styleRunFontBindings?: Array<{ fontIndex: number; fontPath: string }>;
	shaping?: IProjectFontTextShapingOptions;
	applyAuthoredWarp?: boolean;
	applyAuthoredBoxLayout?: boolean;
}

interface IPsdAppliedTextWarpBase {
	style: string;
	left: number;
	top: number;
	width: number;
	height: number;
	tessellation: number;
}

export type IPsdAppliedTextWarp =
	| (IPsdAppliedTextWarpBase & {
			type: "preset";
			value: number;
			perspective: number;
			perspectiveOther: number;
			rotate: "horizontal" | "vertical";
			executionModel: "bounded-analytical-preset-text-warp-v1";
	  })
	| (IPsdAppliedTextWarpBase & {
			type: "tensor";
			uOrder: number;
			vOrder: number;
			meshPointCount: number;
			executionModel: "bounded-bezier-text-warp-v1";
	  })
	| (IPsdAppliedTextWarpBase & {
			type: "quilt";
			uOrder: number;
			vOrder: number;
			deformNumRows: number;
			deformNumCols: number;
			meshPointCount: number;
			quiltSliceX: number[];
			quiltSliceY: number[];
			executionModel: "bounded-piecewise-bezier-text-quilt-warp-v1";
	  });

export interface IPsdAppliedTextStyleRun {
	sourceStyleRunIndex: number;
	start: number;
	length: number;
	fontIndex: number;
	fontName: string | null;
	fontPath: string;
	fontHash: string;
	fontBytes: number;
	photoshopLanguageIndex: number | null;
	photoshopLanguage: string | null;
	effectiveShapingLanguage: string | null;
	languageSource: "authored" | "request" | "default";
	languageExecutionModel: "disabled" | "bounded-authored-photoshop-language-v1";
	fontSize: number;
	tracking: number;
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
	effectiveOpenTypeFeatures: Array<{
		tag:
			| "kern"
			| "liga"
			| "dlig"
			| "palt"
			| "hkna"
			| "ruby"
			| "trad"
			| "expt"
			| "jp78"
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
			| "clig";
		value: 0 | 1;
	}>;
	openTypeFeatureExecutionModel: "disabled" | "bounded-authored-opentype-features-v1";
	color: [number, number, number, number];
	fillEnabled: boolean;
	strokeEnabled: boolean;
	strokeColor: [number, number, number, number] | null;
	fillFirst: boolean;
	outlineWidth: number;
	fillPixelCount: number;
	strokePixelCount: number;
	textPaintExecutionModel: "disabled" | "bounded-authored-text-fill-stroke-v1";
	strokeRasterModel: "disabled" | "bounded-msdf-centered-outline-v1";
	fauxBold: boolean;
	fauxItalic: boolean;
	fontCaps: "normal" | "small-caps" | "all-caps" | null;
	smallCapScale: number;
	capsAppliedScale: number;
	fauxBoldPixels: number;
	fauxItalicShear: number;
	horizontalScale: number;
	verticalScale: number;
	baselineShift: number;
	underline: boolean;
	strikethrough: boolean;
	noBreak: boolean;
	noBreakExecutionModel: "disabled" | "bounded-authored-no-break-v1";
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
	baselineDirection: "upright" | "mixed" | "tate-chu-yoko" | null;
	baselineDirectionGlyphs: Array<{
		glyphId: number;
		cluster: number;
		lineIndex: number;
		unicodeVerticalOrientation: "U" | "Tu" | "R" | "Tr" | null;
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
	japaneseAlternateFeature: "normal" | "traditional" | "expert" | "jis78" | null;
	japaneseAlternateFeatureTag: "trad" | "expt" | "jp78" | null;
	japaneseAlternateFeatureSupported: boolean;
	japaneseAlternateFeatureAvailableTags: Array<"trad" | "expt" | "jp78">;
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
	diacriticPosition: "opentype" | "loose" | "medium" | "tight" | null;
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
	characterDirection: "default" | "left-to-right" | "right-to-left" | null;
	characterDirectionOverrideCharacterCount: number;
	characterDirectionResolvedEmbeddingLevels: number[];
	characterDirectionExecutionModel: "disabled" | "bounded-authored-character-direction-v1";
	figureStyle: "default" | "tabular-lining" | "proportional-oldstyle" | "proportional-lining" | "tabular-oldstyle" | null;
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
	wariChuJustification: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all" | "auto";
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
	styleRunAlignment: "em-box-bottom-left" | "icf-bottom-left" | "em-box-center" | "roman-baseline" | "icf-top-right" | "em-box-top-right" | null;
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
	decorationThickness: number;
	characterStyleExecutionModel: "bounded-authored-character-style-v1";
	glyphCount: number;
	shapedGlyphs: IProjectFontShapedGlyphEvidence[];
}

export interface IPsdAppliedTextRender extends Omit<IProjectFontTextRenderResult, "pixels" | "executionModel"> {
	layerIndex: number;
	layerId: number | null;
	layerName: string;
	text: string;
	fontPath: string;
	fontHash: string;
	fontBytes: number;
	fontSize: number;
	tracking: number;
	justification: "left" | "center" | "right";
	offsetX: number;
	offsetY: number;
	color: [number, number, number, number];
	maskExecutionModel: "bounded-layer-mask-v1";
	maskCoverageMinimum: number;
	maskCoverageMaximum: number;
	fontFallback: "none";
	styleSynthesis: "none" | "authored-faux-bold-italic-v1";
	styleRuns: IPsdAppliedTextStyleRun[];
	paragraphRuns: IProjectFontTextParagraphRunEvidence[];
	boxLayout: IProjectFontTextBoxLayoutEvidence | null;
	authoredWarp: IPsdAppliedTextWarp | null;
	executionModel:
		| "bounded-project-font-text-raster-v1"
		| "bounded-project-font-text-style-runs-v1"
		| "bounded-project-font-harfbuzz-text-raster-v1"
		| "bounded-project-font-harfbuzz-style-runs-v1"
		| "bounded-project-font-harfbuzz-cross-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-text-raster-v1"
		| "bounded-project-font-harfbuzz-bidi-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1"
		| "bounded-project-font-harfbuzz-vertical-text-raster-v1"
		| "bounded-project-font-harfbuzz-bidi-vertical-text-raster-v1"
		| "bounded-project-font-harfbuzz-vertical-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-vertical-style-runs-v1"
		| "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1"
		| "bounded-project-font-harfbuzz-bidi-vertical-cross-style-runs-v1";
}

export interface IPsdAppliedSmartObjectRender {
	sourceKind: "embedded" | "external";
	sourcePath: string | null;
	sourceFormat: string;
	layerIndex: number;
	layerId: number | null;
	layerName: string;
	resourceIndex: number;
	resourceId: string;
	resourceName: string;
	resourceFileType: string;
	resourceHash: string;
	resourceBytes: number;
	sourceWidth: number;
	sourceHeight: number;
	transformSource: "transform" | "nonAffineTransform";
	corners: [number, number, number, number, number, number, number, number];
	left: number;
	top: number;
	width: number;
	height: number;
	sampling: "premultiplied-bilinear";
	warpStyle: string;
	warpValue: number;
	warpPerspective: number;
	warpPerspectiveOther: number;
	warpRotate: "horizontal" | "vertical" | "unknown";
	uOrder: number | null;
	vOrder: number | null;
	deformNumRows: number | null;
	deformNumCols: number | null;
	meshPointCount: number;
	quiltSliceX: number[];
	quiltSliceY: number[];
	tessellation: number | null;
	filterCount: number;
	smartFilterStackEnabled: boolean;
	appliedSmartFilters: IPsdSmartFilterInfo[];
	smartFilterExecutionModel: "bounded-smart-filter-stack-v1" | null;
	smartFilterMaskEnabled: boolean;
	smartFilterMaskLinked: boolean | null;
	smartFilterMaskExtendWithWhite: boolean | null;
	smartFilterMaskId: string | null;
	smartFilterMaskSourceKey: "FEid" | "FXid" | null;
	smartFilterMaskDepth: 8 | 16 | 32 | null;
	smartFilterMaskCompression: "raw" | "rle" | "zip" | "zipPrediction" | null;
	smartFilterMaskLeft: number | null;
	smartFilterMaskTop: number | null;
	smartFilterMaskWidth: number | null;
	smartFilterMaskHeight: number | null;
	smartFilterMaskCoverageMinimum: number | null;
	smartFilterMaskCoverageMaximum: number | null;
	smartFilterMaskExecutionModel: "bounded-smart-filter-mask-v1" | null;
	maskExecutionModel: "bounded-layer-mask-v1";
	maskCoverageMinimum: number;
	maskCoverageMaximum: number;
	executionModel:
		| "bounded-projective-smart-object-v1"
		| "bounded-analytical-preset-smart-object-warp-v1"
		| "bounded-bezier-smart-object-warp-v1"
		| "bounded-piecewise-bezier-smart-object-quilt-warp-v1";
}

interface IPsdAppliedLayerEffectBase {
	layerIndex: number;
	layerName: string;
	effectIndex: number;
	blendMode: string;
	opacity: number;
	source?: "lfx2";
	descriptorKey?: PsdModernLayerEffectDescriptorKey;
	descriptorListIndex?: number | null;
}

function effectDescriptorEvidence(effect: IPsdModernLayerEffectDescriptorInfo): Pick<IPsdAppliedLayerEffectBase, "descriptorKey" | "descriptorListIndex"> {
	return { descriptorKey: effect.descriptorKey, descriptorListIndex: effect.descriptorListIndex };
}

interface IPsdAppliedColoredLayerEffectBase extends IPsdAppliedLayerEffectBase {
	color: [number, number, number, 255];
}

interface IPsdAppliedShadowEvidence {
	blur: number;
	intensity: number;
	angle: number;
	distance: number;
	useGlobalAngle: boolean;
	present?: boolean;
	showInDialog?: boolean;
	choke?: number;
	antialiased?: boolean;
	noise?: number;
	contour?: IPsdLayerEffectContourInfo | null;
	layerConceals?: boolean;
	executionModel?: "bounded-shadow-v2";
}

interface IPsdAppliedGlowEvidence {
	blur: number;
	intensity: number;
	present?: boolean;
	showInDialog?: boolean;
	choke?: number;
	antialiased?: boolean;
	noise?: number;
	range?: number;
	jitter?: number;
	glowSource?: "edge" | "center" | "unknown";
	technique?: "softer" | "precise" | "unknown";
	contour?: IPsdLayerInnerGlowEffectInfo["contour"];
	executionModel?: "bounded-glow-v2";
}

export type IPsdAppliedLayerEffect =
	| (IPsdAppliedColoredLayerEffectBase & { key: "sofi"; type: "solidFill" })
	| (IPsdAppliedColoredLayerEffectBase & IPsdAppliedShadowEvidence & { key: "isdw"; type: "innerShadow" })
	| (IPsdAppliedColoredLayerEffectBase & IPsdAppliedGlowEvidence & { key: "iglw"; type: "innerGlow"; invert: boolean })
	| (IPsdAppliedColoredLayerEffectBase & IPsdAppliedShadowEvidence & { key: "dsdw"; type: "dropShadow" })
	| (IPsdAppliedColoredLayerEffectBase & IPsdAppliedGlowEvidence & { key: "oglw"; type: "outerGlow" })
	| (IPsdAppliedLayerEffectBase & {
			key: "FrFX";
			type: "stroke";
			position: "outside" | "center" | "inside";
			fillType: "solidColor" | "gradient" | "pattern";
			color: [number, number, number, 255] | null;
			gradient: IPsdLayerGradientInfo | null;
			pattern: IPsdLayerPatternInfo | null;
			embeddedPattern: IPsdEmbeddedPatternInfo | null;
			size: number;
			sizeUnits: string;
			present: boolean;
			showInDialog: boolean;
	  })
	| (IPsdAppliedLayerEffectBase & {
			key: "GrFl";
			type: "gradientOverlay";
			gradient: IPsdLayerGradientInfo;
			present: boolean;
			showInDialog: boolean;
	  })
	| (IPsdAppliedLayerEffectBase & {
			key: "patternFill";
			type: "patternOverlay";
			pattern: IPsdLayerPatternInfo;
			embeddedPattern: IPsdEmbeddedPatternInfo;
			present: boolean;
			showInDialog: boolean;
	  })
	| {
			layerIndex: number;
			layerName: string;
			effectIndex: number;
			descriptorKey?: PsdModernLayerEffectDescriptorKey;
			descriptorListIndex?: number | null;
			key: "bevl";
			type: "bevel";
			angle: number;
			strength: number;
			blur: number;
			highlightBlendMode: string;
			shadowBlendMode: string;
			highlightOpacity: number;
			shadowOpacity: number;
			highlightColor: [number, number, number, 255];
			shadowColor: [number, number, number, 255];
			style: number;
			styleName: string;
			useGlobalAngle: boolean;
			direction: number;
			source?: "lfx2";
			present?: boolean;
			showInDialog?: boolean;
			size?: number;
			depth?: number;
			soften?: number;
			altitude?: number;
			technique?: IPsdLayerBevelEffectInfo["technique"];
			useShape?: boolean;
			useTexture?: boolean;
			antialiasGloss?: boolean;
			contour?: IPsdLayerBevelEffectInfo["contour"];
			shapeContour?: IPsdLayerBevelEffectInfo["shapeContour"];
			shapeRange?: number;
			shapeRangeUnits?: string;
			texturePattern?: IPsdLayerPatternInfo | null;
			embeddedTexturePattern?: IPsdEmbeddedPatternInfo | null;
			textureDepth?: number;
			textureDepthUnits?: string;
			textureInvert?: boolean;
			executionModel?: "bounded-bevel-v1" | "bounded-bevel-v2";
	  }
	| (IPsdAppliedColoredLayerEffectBase & {
			key: "ChFX";
			type: "satin";
			angle: number;
			distance: number;
			size: number;
			antialiased: boolean;
			invert: boolean;
			present: boolean;
			showInDialog: boolean;
			contour: IPsdLayerSatinEffectInfo["contour"];
			executionModel: "bounded-satin-v1";
	  });

export interface IPsdLayerExtractionItem {
	layerIndex: number;
	layerId: number | null;
	name: string;
	visible: boolean;
	opacity: number;
	left: number;
	top: number;
	width: number;
	height: number;
	path: string;
	byteLength: number;
	contentHash: string;
	action: "create" | "reuse" | "conflict";
	solidColorFill: IPsdLayerInfo["solidColorFill"] | null;
	patternFill: IPsdLayerInfo["patternFill"] | null;
	gradientFill: IPsdLayerInfo["gradientFill"] | null;
	vectorFill: IPsdLayerInfo["vectorFill"] | null;
	vectorStroke: IPsdLayerInfo["vectorStroke"] | null;
	vectorOrigination: IPsdLayerInfo["vectorOrigination"] | null;
	vectorRenderingVersion: IPsdLayerInfo["vectorRenderingVersion"] | null;
	pathList: IPsdLayerInfo["pathList"] | null;
	textLayer:
		| (NonNullable<IPsdLayerInfo["text"]> & {
				rasterExecutionModel:
					| "embedded-text-raster-v1"
					| "bounded-project-font-text-raster-v1"
					| "bounded-project-font-text-style-runs-v1"
					| "bounded-project-font-harfbuzz-text-raster-v1"
					| "bounded-project-font-harfbuzz-style-runs-v1"
					| "bounded-project-font-harfbuzz-cross-style-runs-v1"
					| "bounded-project-font-harfbuzz-bidi-text-raster-v1"
					| "bounded-project-font-harfbuzz-bidi-style-runs-v1"
					| "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1"
					| "bounded-project-font-harfbuzz-vertical-text-raster-v1"
					| "bounded-project-font-harfbuzz-bidi-vertical-text-raster-v1"
					| "bounded-project-font-harfbuzz-vertical-style-runs-v1"
					| "bounded-project-font-harfbuzz-bidi-vertical-style-runs-v1"
					| "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1"
					| "bounded-project-font-harfbuzz-bidi-vertical-cross-style-runs-v1";
		  })
		| null;
	smartObjectLayer:
		| (NonNullable<IPsdLayerInfo["smartObject"]> & {
				rasterExecutionModel:
					| "embedded-smart-object-raster-v1"
					| "bounded-projective-smart-object-v1"
					| "bounded-analytical-preset-smart-object-warp-v1"
					| "bounded-bezier-smart-object-warp-v1"
					| "bounded-piecewise-bezier-smart-object-quilt-warp-v1";
		  })
		| null;
	appliedTextRenders: IPsdAppliedTextRender[];
	appliedSmartObjectRenders: IPsdAppliedSmartObjectRender[];
	warnings: string[];
	appliedMasks: Array<
		| {
				type: "primary" | "realUser";
				channelId: -2 | -3;
				left: number;
				top: number;
				width: number;
				height: number;
				defaultColor: number;
				inverted: boolean;
				positionRelativeToLayer: boolean;
				density: number | null;
				feather: number | null;
				executionModel: "bounded-mask-parameters-v1";
		  }
		| {
				type: "vector";
				sourceKey: "vmsk" | "vsms";
				inverted: boolean;
				notLinked: boolean;
				initialFill: 0 | 1;
				fillRule: "evenOdd";
				subpathCount: number;
				knotCount: number;
				density: number | null;
				feather: number | null;
				executionModel: "bounded-vector-mask-v1";
		  }
	>;
	appliedLayerStyleMask: {
		sourceKey: "lmgm";
		layerMaskAsGlobalMask: true;
		application: "final-layer-and-effects-crossfade";
		maskCoverageMinimum: number;
		maskCoverageMaximum: number;
		executionModel: "bounded-layer-mask-hides-effects-v1";
	} | null;
	appliedVectorStyleMask: {
		sourceKey: "vmgm";
		vectorMaskAsGlobalMask: true;
		application: "final-layer-and-effects-crossfade";
		maskCoverageMinimum: number;
		maskCoverageMaximum: number;
		executionModel: "bounded-vector-mask-hides-effects-v1";
	} | null;
	appliedInteriorEffectBlending: Array<{
		layerIndex: number;
		layerId: number | null;
		name: string;
		sourceKey: "infx";
		blendInteriorEffectsAsGroup: boolean;
		layerBlendMode: string;
		application: "interior-effects-then-layer-blend" | "layer-blend-then-interior-effects";
		interiorEffectTypes: IPsdAppliedLayerEffect["type"][];
		executionModel: "bounded-blend-interior-effects-as-group-v1";
	}>;
	appliedClippedLayerBlending: Array<{
		baseLayerIndex: number;
		baseLayerId: number | null;
		baseLayerName: string;
		sourceKey: "clbl";
		blendClippedLayersAsGroup: boolean;
		baseBlendMode: string;
		clippedLayerIndices: number[];
		clippedLayerNames: string[];
		clippedBlendModes: string[];
		application: "clipped-composite-then-base-blend" | "base-blend-then-independent-clipped-blends";
		executionModel: "bounded-blend-clipped-layers-as-group-v1";
	}>;
	appliedTransparencyShaping: Array<{
		layerIndex: number;
		layerId: number | null;
		name: string;
		sourceKey: "tsly";
		transparencyShapesLayer: boolean;
		fillOpacity: number;
		application: "transparency-shapes-effects" | "bounds-shape-effects-transparency-as-fill";
		effectTypes: IPsdAppliedLayerEffect["type"][];
		executionModel: "bounded-transparency-shapes-layer-v1";
	}>;
	appliedKnockouts: Array<{
		layerIndex: number;
		layerId: number | null;
		name: string;
		sourceKey: "knko";
		knockout: "shallow" | "deep";
		fillOpacity: number;
		stoppingBoundary: "containing-group" | "clipping-base" | "background" | "transparency";
		destinationLayerIndices: number[];
		executionModel: "bounded-knockout-v1";
	}>;
	appliedGroupMasks: Array<{
		groupIndex: number;
		groupId: number | null;
		name: string;
		executionModel:
			| "bounded-group-mask-v1"
			| "bounded-backdrop-pass-through-mask-v1"
			| "bounded-backdrop-pass-through-mask-effects-v1"
			| "bounded-backdrop-pass-through-blends-mask-v1"
			| "bounded-nested-backdrop-pass-through-mask-v1"
			| "bounded-nested-backdrop-pass-through-mask-effects-v1"
			| "bounded-nested-backdrop-pass-through-mask-adjustments-v1"
			| "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1";
		application: "isolated-alpha" | "backdrop-interpolation";
		maskCoverageMinimum: number;
		maskCoverageMaximum: number;
	}>;
	appliedAdjustments: Array<{
		layerIndex: number;
		layerId: number | null;
		name: string;
		key: IPsdLayerAdjustmentInfo["key"];
		opacity: number;
		clipping: boolean;
		settings: IPsdLayerAdjustmentInfo;
		executionModel: "bounded-adjustment-v1";
		maskExecutionModel: "bounded-adjustment-mask-v1" | null;
		maskCoverageMinimum: number | null;
		maskCoverageMaximum: number | null;
		groupExecutionModel: "bounded-pass-through-groups-v1" | null;
		crossedGroupIndices: number[];
	}>;
	appliedLayerEffects: IPsdAppliedLayerEffect[];
	clippedLayerIndices: number[];
	clippedLayerNames: string[];
	blendModes: string[];
	groupComposite: {
		executionModel:
			| "bounded-isolated-group-v1"
			| "bounded-nested-isolated-group-v1"
			| "bounded-pass-through-flatten-v1"
			| "bounded-knockout-group-v1"
			| "bounded-backdrop-pass-through-opacity-v1"
			| "bounded-backdrop-pass-through-mask-v1"
			| "bounded-backdrop-pass-through-mask-effects-v1"
			| "bounded-backdrop-pass-through-effects-v1"
			| "bounded-backdrop-pass-through-adjustments-v1"
			| "bounded-backdrop-pass-through-blends-v1"
			| "bounded-backdrop-pass-through-blends-mask-v1"
			| "bounded-backdrop-pass-through-blends-effects-v1"
			| "bounded-backdrop-pass-through-blends-effects-behind-v1"
			| "bounded-backdrop-pass-through-blends-adjustments-v1"
			| "bounded-nested-backdrop-pass-through-v1"
			| "bounded-nested-backdrop-pass-through-blends-v1"
			| "bounded-nested-backdrop-pass-through-mask-v1"
			| "bounded-nested-backdrop-pass-through-mask-effects-v1"
			| "bounded-nested-backdrop-pass-through-mask-adjustments-v1"
			| "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1"
			| "bounded-nested-backdrop-pass-through-effects-v1"
			| "bounded-nested-backdrop-pass-through-effects-adjustments-v1"
			| "bounded-nested-backdrop-pass-through-adjustments-v1";
		groupStartIndex: number;
		groupEndIndex: number;
		groupOpacity: number;
		backdropLayerIndices: number[];
		backdropBlendModes: string[];
		backdropIncluded: boolean;
		childLayerIndices: number[];
		childLayerNames: string[];
		blendModes: string[];
		nestedGroupIndices: number[];
		passThroughGroupIndices: number[];
		maximumDepth: number;
	} | null;
}

export interface IPsdSmartObjectPayloadExtractionItem {
	resourceIndex: number;
	resourceId: string;
	name: string;
	fileType: string;
	sourceKey: IDecodedPsdSmartObjectResource["sourceKey"];
	recordSignature: "liFD" | "liFE";
	sourceType: "embedded" | "externalBinding";
	sourcePath: string | null;
	declaredFileSize: number | null;
	sizeMatches: boolean | null;
	associatedLayerIndices: number[];
	path: string;
	byteLength: number;
	contentHash: string;
	action: "create" | "reuse" | "conflict";
	executionModel: "bounded-smart-object-payload-publication-v1";
}

export interface IPsdGroupCompositeInfo {
	groupStartIndex: number;
	groupEndIndex: number;
	name: string;
	visible: boolean;
	blendMode: string;
	executionModel:
		| "bounded-isolated-group-v1"
		| "bounded-nested-isolated-group-v1"
		| "bounded-pass-through-flatten-v1"
		| "bounded-knockout-group-v1"
		| "bounded-backdrop-pass-through-opacity-v1"
		| "bounded-backdrop-pass-through-mask-v1"
		| "bounded-backdrop-pass-through-mask-effects-v1"
		| "bounded-backdrop-pass-through-effects-v1"
		| "bounded-backdrop-pass-through-adjustments-v1"
		| "bounded-backdrop-pass-through-blends-v1"
		| "bounded-backdrop-pass-through-blends-mask-v1"
		| "bounded-backdrop-pass-through-blends-effects-v1"
		| "bounded-backdrop-pass-through-blends-effects-behind-v1"
		| "bounded-backdrop-pass-through-blends-adjustments-v1"
		| "bounded-nested-backdrop-pass-through-v1"
		| "bounded-nested-backdrop-pass-through-blends-v1"
		| "bounded-nested-backdrop-pass-through-mask-v1"
		| "bounded-nested-backdrop-pass-through-mask-effects-v1"
		| "bounded-nested-backdrop-pass-through-mask-adjustments-v1"
		| "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1"
		| "bounded-nested-backdrop-pass-through-effects-v1"
		| "bounded-nested-backdrop-pass-through-effects-adjustments-v1"
		| "bounded-nested-backdrop-pass-through-adjustments-v1";
	supported: boolean;
	requiresParentBackdrop: boolean;
	groupOpacity: number;
	backdropLayerIndices: number[];
	backdropBlendModes: string[];
	backdropIncluded: boolean;
	childLayerIndices: number[];
	directChildLayerIndices: number[];
	nestedGroupIndices: number[];
	passThroughGroupIndices: number[];
	maximumDepth: number;
	warnings: string[];
}

export interface IPsdLayerExtractionStatus {
	version: 1;
	path: string;
	destinationFolder: string;
	includeHidden: boolean;
	applyOpacity: boolean;
	applyLayerEffects: boolean;
	applyAdjustments: boolean;
	compositeClippingGroups: boolean;
	compositeGroups: boolean;
	requestedLayerIndices: number[] | null;
	requestedTextRenders: IPsdTextRenderRequest[];
	extractSmartObjectPayloads: boolean;
	requestedSmartObjectResourceIds: string[] | null;
	requestedSmartObjectExternalBindings: Array<Required<IPsdSmartObjectExternalBindingRequest>>;
	shapeBlurKernelBindings: IPsdShapeBlurKernelBindingEvidence[];
	displacementMapBindings: IPsdDisplacementMapBindingEvidence[];
	inspectNestedSmartObjects: boolean;
	nestedSmartObjectMaximumDepth: number;
	renderEmbeddedSmartObjects: boolean;
	renderExternalSmartObjects: boolean;
	requestedSmartObjectRenderLayerIndices: number[] | null;
	nestedSmartObjectDocuments: IPsdNestedSmartObjectDocumentInfo[];
	nestedSmartObjectInspectedCount: number;
	nestedSmartObjectBlockedCount: number;
	fingerprint: string;
	document: IPsdLayerDocumentInfo;
	groupComposites: IPsdGroupCompositeInfo[];
	items: IPsdLayerExtractionItem[];
	smartObjectPayloads: IPsdSmartObjectPayloadExtractionItem[];
	selectedLayerCount: number;
	createdCount: number;
	reusedCount: number;
	conflictCount: number;
	smartObjectPayloadCreatedCount: number;
	smartObjectPayloadReusedCount: number;
	smartObjectPayloadConflictCount: number;
	totalOutputBytes: number;
}

interface IPreparedPsdLayerExtraction {
	status: IPsdLayerExtractionStatus;
	bytesByPath: Map<string, Buffer>;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function portablePath(path: string): string {
	return relative(projectDirectory(), path).replace(/\\/g, "/");
}

function assertContained(path: string, label: string): void {
	const root = projectDirectory();
	if (path !== root && !path.startsWith(`${root}/`)) {
		throw new Error(`${label} must stay inside the open project directory.`);
	}
}

function resolveDestinationFolder(sourcePath: string, value?: string): string {
	const root = projectDirectory();
	const sourcePortable = portablePath(sourcePath);
	const defaultName = `${basename(sourcePortable, extname(sourcePortable)).replace(/[^A-Za-z0-9._-]+/g, "_") || "psd"}_layers`;
	const portable = value?.trim().replace(/\\/g, "/") || join(dirname(sourcePortable), defaultName);
	if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
		throw new Error("PSD layer destinationFolder must be project-relative.");
	}
	const absolute = resolve(root, portable);
	assertContained(absolute, "PSD layer destinationFolder");
	return absolute;
}

function normalizeLayerIndices(value?: number[]): number[] | null {
	if (value === undefined) {
		return null;
	}
	if (!Array.isArray(value) || value.length > MAXIMUM_EXTRACTED_LAYERS) {
		throw new Error(`layerIndices must contain at most ${MAXIMUM_EXTRACTED_LAYERS} entries.`);
	}
	const result = [...new Set(value)];
	if (result.length !== value.length || result.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= 4096)) {
		throw new Error("layerIndices must contain unique integer PSD layer indices between 0 and 4095.");
	}
	return result.sort((left, right) => left - right);
}

function normalizeSmartObjectRenderLayerIndices(enabled: boolean, value?: number[]): number[] | null {
	if (value === undefined) {
		return null;
	}
	if (!enabled) {
		throw new Error("smartObjectRenderLayerIndices requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true.");
	}
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("smartObjectRenderLayerIndices must contain at most 128 entries.");
	}
	const result = [...new Set(value)];
	if (result.length !== value.length || result.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= 4096)) {
		throw new Error("smartObjectRenderLayerIndices must contain unique integer PSD layer indices between 0 and 4095.");
	}
	return result.sort((left, right) => left - right);
}

async function decodeExternalSmartObjectRaster(sourcePath: string, data: Buffer): Promise<{ width: number; height: number; pixels: Uint8Array; format: string }> {
	const extension = extname(sourcePath).toLowerCase();
	if (extension === ".psd" || extension === ".psb") {
		const decoded = decodePsd(data);
		return { ...decoded, format: decoded.format };
	}
	if (extension === ".tga") {
		const decoded = decodeTga(data);
		return { ...decoded, format: "tga" };
	}
	if (extension === ".hdr" || extension === ".exr") {
		throw new Error(`External smart-object source format ${extension || "unknown"} is not supported by bounded RGBA8 rendering.`);
	}
	const decoded = await sharp(data, { limitInputPixels: MAXIMUM_EFFECT_BAKE_PIXELS, pages: 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	if (decoded.info.width * decoded.info.height > MAXIMUM_EFFECT_BAKE_PIXELS || decoded.info.channels !== 4) {
		throw new Error("External smart-object source must decode to at most 4,194,304 RGBA8 pixels.");
	}
	return { width: decoded.info.width, height: decoded.info.height, pixels: new Uint8Array(decoded.data), format: extension.slice(1) || "raster" };
}

function normalizeSmartObjectResourceIds(value?: string[]): string[] | null {
	if (value === undefined) {
		return null;
	}
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("smartObjectResourceIds must contain at most 128 entries.");
	}
	const result = value.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
	if (result.some((entry) => !entry || entry.length > 255 || entry.includes("\0")) || new Set(result).size !== result.length) {
		throw new Error("smartObjectResourceIds must contain unique non-empty IDs of at most 255 characters and no NUL bytes.");
	}
	return result.sort();
}

function normalizeNestedSmartObjectMaximumDepth(enabled: boolean, value?: number): number {
	if (value === undefined) {
		return 4;
	}
	if (!enabled) {
		throw new Error("nestedSmartObjectMaximumDepth requires inspectNestedSmartObjects=true.");
	}
	if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
		throw new Error("nestedSmartObjectMaximumDepth must be an integer between 1 and 8.");
	}
	return value;
}

async function prepareSmartObjectExternalBindings(
	document: IPsdLayerDocumentInfo,
	value?: IPsdSmartObjectExternalBindingRequest[]
): Promise<Array<{ request: Required<IPsdSmartObjectExternalBindingRequest>; resource: IPsdLayerDocumentInfo["smartObjectResources"][number]; data: Buffer }>> {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("smartObjectExternalBindings must contain at most 128 entries.");
	}
	const indices = new Set<number>();
	const prepared: Array<{ request: Required<IPsdSmartObjectExternalBindingRequest>; resource: IPsdLayerDocumentInfo["smartObjectResources"][number]; data: Buffer }> = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.resourceIndex) || raw.resourceIndex < 0 || raw.resourceIndex >= document.smartObjectResources.length) {
			throw new Error("Each smartObjectExternalBindings entry must reference an existing non-negative integer resourceIndex.");
		}
		if (indices.has(raw.resourceIndex)) {
			throw new Error(`smartObjectExternalBindings contains duplicate resourceIndex ${raw.resourceIndex}.`);
		}
		indices.add(raw.resourceIndex);
		const resource = document.smartObjectResources[raw.resourceIndex];
		if (resource.index !== raw.resourceIndex || resource.type !== "external" || !resource.external) {
			throw new Error(`Smart-object resource ${raw.resourceIndex} is not an external liFE record.`);
		}
		if (typeof raw.sourcePath !== "string" || !raw.sourcePath.trim() || raw.sourcePath.length > 4096 || raw.sourcePath.includes("\0")) {
			throw new Error(`External smart-object resource ${raw.resourceIndex} sourcePath must be a non-empty absolute path of at most 4,096 characters with no NUL bytes.`);
		}
		const sourcePath = normalizeNativePath(raw.sourcePath.trim());
		if (!isNativeAbsolute(sourcePath)) {
			throw new Error(`External smart-object resource ${raw.resourceIndex} sourcePath must be an absolute local file path supplied explicitly by the user.`);
		}
		if (!(await pathExists(sourcePath))) {
			throw new Error(`External smart-object resource ${raw.resourceIndex} sourcePath does not exist: ${sourcePath}`);
		}
		const details = await stat(sourcePath);
		if (!details.isFile() || details.size > MAXIMUM_EXTRACTED_BYTES) {
			throw new Error(`External smart-object resource ${raw.resourceIndex} sourcePath must be a file no larger than 256 MiB.`);
		}
		const allowSizeMismatch = raw.allowSizeMismatch === true;
		if (resource.external.fileSize > 0 && resource.external.fileSize !== details.size && !allowSizeMismatch) {
			throw new Error(
				`External smart-object resource ${raw.resourceIndex} declares ${resource.external.fileSize} bytes but the selected file has ${details.size}; set allowSizeMismatch=true only after reviewing the replacement.`
			);
		}
		prepared.push({ request: { resourceIndex: raw.resourceIndex, sourcePath, allowSizeMismatch }, resource, data: await readFile(sourcePath) });
	}
	return prepared;
}

interface IPreparedPsdShapeBlurKernelBinding {
	request: Required<IPsdShapeBlurKernelBindingRequest>;
	evidence: IPsdShapeBlurKernelBindingEvidence;
	kernel: IPsdShapeBlurKernelBinding;
}

async function prepareShapeBlurKernelBindings(document: IPsdLayerDocumentInfo, value?: IPsdShapeBlurKernelBindingRequest[]): Promise<IPreparedPsdShapeBlurKernelBinding[]> {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("shapeBlurKernelBindings must contain at most 128 entries.");
	}
	const shapes = new Map<string, string>();
	for (const layer of document.layers) {
		for (const filter of layer.smartObject?.smartFilters ?? []) {
			if (filter.type === "shapeBlur" && filter.shapeBlur?.kernel !== "heartCard") {
				shapes.set(filter.shapeBlur!.customShape.id, filter.shapeBlur!.customShape.name);
			}
		}
	}
	const ids = new Set<string>();
	const prepared: IPreparedPsdShapeBlurKernelBinding[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || typeof raw.shapeId !== "string" || !raw.shapeId.trim() || raw.shapeId.length > 1024 || raw.shapeId.includes("\0")) {
			throw new Error("Each shapeBlurKernelBindings entry requires an exact non-empty shapeId of at most 1,024 characters and no NUL bytes.");
		}
		const shapeId = raw.shapeId.trim();
		if (ids.has(shapeId)) {
			throw new Error(`shapeBlurKernelBindings contains duplicate shapeId ${JSON.stringify(shapeId)}.`);
		}
		ids.add(shapeId);
		const shapeName = shapes.get(shapeId);
		if (!shapeName) {
			throw new Error(`shapeBlurKernelBindings references ${JSON.stringify(shapeId)}, which is not an unresolved Shape Blur preset in this document.`);
		}
		if (typeof raw.sourcePath !== "string" || !raw.sourcePath.trim() || raw.sourcePath.length > 4096 || raw.sourcePath.includes("\0")) {
			throw new Error(`Shape Blur kernel ${shapeId} sourcePath must be a non-empty project asset path of at most 4,096 characters with no NUL bytes.`);
		}
		const requestedPath = normalizeNativePath(raw.sourcePath.trim());
		const absolutePath = isNativeAbsolute(requestedPath) ? requestedPath : resolve(projectDirectory(), requestedPath.replace(/\\/g, "/"));
		assertContained(absolutePath, `Shape Blur kernel ${shapeId} sourcePath`);
		if (!(await pathExists(absolutePath))) {
			throw new Error(`Shape Blur kernel ${shapeId} sourcePath does not exist: ${absolutePath}`);
		}
		const details = await stat(absolutePath);
		if (!details.isFile() || details.size > 32 * 1024 * 1024) {
			throw new Error(`Shape Blur kernel ${shapeId} sourcePath must be a file no larger than 32 MiB.`);
		}
		const data = await readFile(absolutePath);
		const decoded = await decodeExternalSmartObjectRaster(absolutePath, data);
		if (decoded.width > 1024 || decoded.height > 1024 || decoded.width * decoded.height > 1_048_576) {
			throw new Error(`Shape Blur kernel ${shapeId} must decode to at most 1024×1024 and 1,048,576 pixels.`);
		}
		const requestedCoverageSource = raw.coverageSource ?? "auto";
		if (!new Set(["auto", "alpha", "luminance"]).has(requestedCoverageSource)) {
			throw new Error(`Shape Blur kernel ${shapeId} coverageSource must be auto, alpha, or luminance.`);
		}
		const hasTransparency = decoded.pixels.some((sample, index) => index % 4 === 3 && sample !== 255);
		const effectiveCoverageSource = requestedCoverageSource === "auto" ? (hasTransparency ? "alpha" : "luminance") : requestedCoverageSource;
		const invert = raw.invert === true;
		const coverage = new Uint8Array(decoded.width * decoded.height);
		let coverageMinimum = 255;
		let coverageMaximum = 0;
		let nonZeroSampleCount = 0;
		for (let pixel = 0; pixel < coverage.length; ++pixel) {
			const offset = pixel * 4;
			const sample =
				effectiveCoverageSource === "alpha"
					? decoded.pixels[offset + 3]
					: Math.round(decoded.pixels[offset] * 0.2126 + decoded.pixels[offset + 1] * 0.7152 + decoded.pixels[offset + 2] * 0.0722);
			coverage[pixel] = invert ? 255 - sample : sample;
			coverageMinimum = Math.min(coverageMinimum, coverage[pixel]);
			coverageMaximum = Math.max(coverageMaximum, coverage[pixel]);
			nonZeroSampleCount += coverage[pixel] > 0 ? 1 : 0;
		}
		if (nonZeroSampleCount === 0) {
			throw new Error(`Shape Blur kernel ${shapeId} produces empty coverage after ${effectiveCoverageSource}${invert ? " inversion" : " extraction"}.`);
		}
		const sourcePath = portablePath(absolutePath);
		const request = { shapeId, sourcePath, coverageSource: requestedCoverageSource, invert } satisfies Required<IPsdShapeBlurKernelBindingRequest>;
		prepared.push({
			request,
			evidence: {
				shapeId,
				shapeName,
				sourcePath,
				sourceHash: createHash("sha256").update(data).digest("hex"),
				sourceBytes: data.byteLength,
				width: decoded.width,
				height: decoded.height,
				requestedCoverageSource,
				effectiveCoverageSource,
				invert,
				coverageMinimum,
				coverageMaximum,
				nonZeroSampleCount,
				executionModel: "bounded-custom-shape-blur-kernel-binding-v1",
			},
			kernel: { shapeId, width: decoded.width, height: decoded.height, coverage },
		});
	}
	return prepared;
}

interface IPreparedPsdDisplacementMapBinding {
	request: IPsdDisplacementMapBindingRequest;
	runtimeEvidence: IPsdDisplacementMapRuntimeEvidence;
	evidence: IPsdDisplacementMapBindingEvidence;
	binding: IPsdDisplacementMapBinding;
}

async function prepareDisplacementMapBindings(document: IPsdLayerDocumentInfo, value?: IPsdDisplacementMapBindingRequest[]): Promise<IPreparedPsdDisplacementMapBinding[]> {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("displacementMapBindings must contain at most 128 entries.");
	}
	const keys = new Set<string>();
	const prepared: IPreparedPsdDisplacementMapBinding[] = [];
	for (const raw of value) {
		if (
			!raw ||
			typeof raw !== "object" ||
			!Number.isSafeInteger(raw.layerIndex) ||
			raw.layerIndex < 0 ||
			raw.layerIndex >= document.layers.length ||
			!Number.isSafeInteger(raw.filterIndex) ||
			raw.filterIndex < 0 ||
			raw.filterIndex >= 128
		) {
			throw new Error("Each displacementMapBindings entry must reference one existing non-negative integer layerIndex and bounded filterIndex.");
		}
		const key = `${raw.layerIndex}:${raw.filterIndex}`;
		if (keys.has(key)) {
			throw new Error(`displacementMapBindings contains duplicate layer/filter key ${key}.`);
		}
		keys.add(key);
		const layer = document.layers[raw.layerIndex];
		const filter = layer.smartObject?.smartFilters[raw.filterIndex];
		if (!filter || filter.index !== raw.filterIndex || filter.type !== "displace" || !filter.displace) {
			throw new Error(`displacementMapBindings ${key} does not reference one valid Displace smart filter in this document.`);
		}
		if (typeof raw.sourcePath !== "string" || !raw.sourcePath.trim() || raw.sourcePath.length > 4096 || raw.sourcePath.includes("\0")) {
			throw new Error(`Displace map ${key} sourcePath must be a non-empty project asset path of at most 4,096 characters with no NUL bytes.`);
		}
		const requestedPath = normalizeNativePath(raw.sourcePath.trim());
		const absolutePath = isNativeAbsolute(requestedPath) ? requestedPath : resolve(projectDirectory(), requestedPath.replace(/\\/g, "/"));
		assertContained(absolutePath, `Displace map ${key} sourcePath`);
		const extension = extname(absolutePath).toLowerCase();
		if (extension !== ".psd" && extension !== ".psb") {
			throw new Error(`Displace map ${key} must be a flattened Photoshop .psd or .psb asset; ${extension || "extensionless"} sources are unsupported.`);
		}
		if (!(await pathExists(absolutePath))) {
			throw new Error(`Displace map ${key} sourcePath does not exist: ${absolutePath}`);
		}
		const details = await stat(absolutePath);
		if (!details.isFile() || details.size <= 0 || details.size > 32 * 1024 * 1024) {
			throw new Error(`Displace map ${key} sourcePath must be a non-empty file no larger than 32 MiB.`);
		}
		const data = await readFile(absolutePath);
		let decoded: ReturnType<typeof decodePsd>;
		try {
			decoded = decodePsd(data);
		} catch (error) {
			throw new Error(`Displace map ${key} must decode as one bounded flattened RGB or Grayscale PSD/PSB merged composite: ${String(error)}`);
		}
		const sourcePath = portablePath(absolutePath);
		const runtimeEvidence: IPsdDisplacementMapRuntimeEvidence = {
			filterIndex: raw.filterIndex,
			sourcePath,
			sourceHash: createHash("sha256").update(data).digest("hex"),
			sourceBytes: data.byteLength,
			format: decoded.version === 1 ? "psd" : "psb",
			documentVersion: decoded.version,
			depth: decoded.depth,
			colorMode: decoded.colorMode,
			channelMapping: decoded.colorMode === "rgb" ? "red-horizontal-green-vertical" : "grayscale-both-axes",
			width: decoded.width,
			height: decoded.height,
			executionModel: "bounded-explicit-psd-displacement-map-binding-v1",
		};
		prepared.push({
			request: { layerIndex: raw.layerIndex, filterIndex: raw.filterIndex, sourcePath },
			runtimeEvidence,
			evidence: {
				...runtimeEvidence,
				layerIndex: raw.layerIndex,
				layerName: layer.name,
				storedSignature: filter.displace.displacementFile.signature,
				storedPath: filter.displace.displacementFile.path,
			},
			binding: { ...runtimeEvidence, pixels: decoded.pixels },
		});
	}
	return prepared;
}

interface IPreparedPsdTextRender {
	request: Required<Omit<IPsdTextRenderRequest, "lineHeight" | "shaping">> & { lineHeight: number | null; shaping: IProjectFontTextShapingOptions | null };
	absoluteFontPath: string;
	fontHash: string;
	fontBytes: number;
	fontData: Buffer;
	styleRuns: Array<{
		sourceStyleRunIndex: number;
		start: number;
		length: number;
		text: string;
		fontIndex: number;
		fontName: string | null;
		language: number | null;
		fontPath: string;
		absoluteFontPath: string;
		fontHash: string;
		fontBytes: number;
		fontData: Buffer;
		fontSize: number;
		tracking: number;
		autoLeading: boolean | null;
		leading: number | null;
		kerning: number | null;
		autoKerning: boolean | null;
		ligatures: boolean | null;
		discretionaryLigatures: boolean | null;
		color: [number, number, number, number];
		fillEnabled: boolean;
		strokeEnabled: boolean;
		strokeColor: [number, number, number, number] | null;
		fillFirst: boolean;
		outlineWidth: number;
		fauxBold: boolean;
		fauxItalic: boolean;
		fontCaps: "normal" | "small-caps" | "all-caps" | null;
		smallCapScale: number;
		fontBaseline: "normal" | "superscript" | "subscript" | null;
		fontBaselineScale: number;
		fontBaselinePosition: number;
		baselineDirection: "upright" | "mixed" | "tate-chu-yoko" | null;
		proportionalMetrics: boolean | null;
		kana: boolean | null;
		ruby: boolean | null;
		japaneseAlternateFeature: "normal" | "traditional" | "expert" | "jis78" | null;
		fractions: boolean | null;
		ordinals: boolean | null;
		stylisticAlternates: boolean | null;
		oldStyle: boolean | null;
		swash: boolean | null;
		titling: boolean | null;
		ornaments: boolean | null;
		slashedZero: boolean | null;
		connectionForms: boolean | null;
		contextualLigatures: boolean | null;
		hindiNumbers: boolean | null;
		kashida: boolean | null;
		diacriticPosition: "opentype" | "loose" | "medium" | "tight" | null;
		characterDirection: "default" | "left-to-right" | "right-to-left" | null;
		figureStyle: "default" | "tabular-lining" | "proportional-oldstyle" | "proportional-lining" | "tabular-oldstyle" | null;
		engineData2StyleRunIndex: number | null;
		wariChuEnabled: boolean | null;
		wariChuLineCount: number | null;
		wariChuLineGap: number | null;
		wariChuScale: number | null;
		wariChuWidow: number | null;
		wariChuOrphan: number | null;
		wariChuJustification: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all" | "auto" | null;
		tsume: number | null;
		styleRunAlignment: "em-box-bottom-left" | "icf-bottom-left" | "em-box-center" | "roman-baseline" | "icf-top-right" | "em-box-top-right" | null;
		horizontalScale: number;
		verticalScale: number;
		baselineShift: number;
		underline: boolean;
		strikethrough: boolean;
		noBreak: boolean;
	}>;
	paragraphRuns: IProjectFontTextParagraphRunOptions[];
	boxLayout: IProjectFontTextBoxLayoutOptions | null;
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isFinite(result) || result < minimum || result > maximum) {
		throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}.`);
	}
	return result;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = finiteNumber(value, fallback, minimum, maximum, label);
	if (!Number.isSafeInteger(result)) {
		throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
	}
	return result;
}

async function readPsdProjectFont(rawPath: unknown, label: string): Promise<{ absolutePath: string; portablePath: string; hash: string; bytes: number; data: Buffer }> {
	if (typeof rawPath !== "string" || !rawPath.trim()) {
		throw new Error(`${label} requires a project-relative fontPath.`);
	}
	const requestedPath = rawPath.trim().replace(/\\/g, "/");
	if (requestedPath.startsWith("/") || /^[A-Za-z]:\//.test(requestedPath)) {
		throw new Error(`${label} fontPath must be project-relative.`);
	}
	const absolutePath = resolve(projectDirectory(), requestedPath);
	assertContained(absolutePath, `${label} fontPath`);
	const extension = extname(absolutePath).toLowerCase();
	if (![".ttf", ".otf", ".woff"].includes(extension) || !(await pathExists(absolutePath))) {
		throw new Error(`${label} fontPath must reference an existing project TTF, OTF, or WOFF asset; WOFF2 cannot be deterministically rasterized.`);
	}
	const details = await stat(absolutePath);
	if (!details.isFile() || details.size > 32 * 1024 * 1024) {
		throw new Error(`${label} project font must be a file no larger than 32 MiB.`);
	}
	const data = await readFile(absolutePath);
	return { absolutePath, portablePath: portablePath(absolutePath), hash: createHash("sha256").update(data).digest("hex"), bytes: details.size, data };
}

async function preparePsdTextRenders(document: IPsdLayerDocumentInfo, value?: IPsdTextRenderRequest[]): Promise<Map<number, IPreparedPsdTextRender>> {
	if (value === undefined) {
		return new Map();
	}
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("textRenders must contain at most 128 PSD text-layer requests.");
	}
	const result = new Map<number, IPreparedPsdTextRender>();
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.layerIndex) || raw.layerIndex < 0 || raw.layerIndex >= document.layerCount) {
			throw new Error("Each textRenders entry must reference an existing non-negative integer layerIndex.");
		}
		if (result.has(raw.layerIndex)) {
			throw new Error(`textRenders contains duplicate layerIndex ${raw.layerIndex}.`);
		}
		const layer = document.layers[raw.layerIndex];
		if (!layer.text || layer.kind !== "pixel" || !layer.extractionSupported) {
			throw new Error(`PSD layer ${raw.layerIndex} is not an extractable TySh text layer.`);
		}
		if (layer.text.orientation !== "horizontal" && layer.text.orientation !== "vertical") {
			throw new Error(`PSD layer ${raw.layerIndex} has an unknown text orientation and cannot be rerasterized safely.`);
		}
		if (raw.applyAuthoredWarp !== undefined && typeof raw.applyAuthoredWarp !== "boolean") {
			throw new Error(`PSD layer ${raw.layerIndex} applyAuthoredWarp must be a Boolean when provided.`);
		}
		if (raw.applyAuthoredBoxLayout !== undefined && typeof raw.applyAuthoredBoxLayout !== "boolean") {
			throw new Error(`PSD layer ${raw.layerIndex} applyAuthoredBoxLayout must be a Boolean when provided.`);
		}
		const applyAuthoredWarp = raw.applyAuthoredWarp === true;
		const applyAuthoredBoxLayout = raw.applyAuthoredBoxLayout === true;
		const authoredWarp = layer.text.warp;
		const hasCustomEnvelope = authoredWarp.meshExecutionModel !== null;
		if (authoredWarp.style === "warpNone" && !hasCustomEnvelope && applyAuthoredWarp) {
			throw new Error(`PSD layer ${raw.layerIndex} has no authored text warp to apply.`);
		}
		if (authoredWarp.style !== "warpNone" || hasCustomEnvelope) {
			if (!applyAuthoredWarp) {
				throw new Error(`PSD layer ${raw.layerIndex} uses warp style ${authoredWarp.style}; set applyAuthoredWarp=true to execute the exact supported warp.`);
			}
			if (!hasCustomEnvelope && !(PSD_SMART_OBJECT_PRESET_WARP_STYLES as readonly string[]).includes(authoredWarp.style)) {
				throw new Error(
					`PSD layer ${raw.layerIndex} uses unsupported text warp style ${authoredWarp.style}${authoredWarp.meshWarning ? `: ${authoredWarp.meshWarning}` : "."}`
				);
			}
			if (!hasCustomEnvelope && authoredWarp.rotate !== "horizontal" && authoredWarp.rotate !== "vertical") {
				throw new Error(`PSD layer ${raw.layerIndex} text warp requires a horizontal or vertical authored warp orientation.`);
			}
		}
		const text = raw.text === undefined ? layer.text.text : String(raw.text).replace(/\r\n?/g, "\n");
		if (text.length > 8192 || text.includes("\0")) {
			throw new Error(`PSD layer ${raw.layerIndex} replacement text must contain at most 8,192 characters and no NUL bytes.`);
		}
		const fontAsset = await readPsdProjectFont(raw.fontPath, `PSD layer ${raw.layerIndex} text render`);
		const defaultStyle = layer.text.styleRuns[0];
		const defaultParagraph = layer.text.paragraphRuns[0];
		const fontSize = finiteNumber(raw.fontSize, defaultStyle?.fontSize ?? 32, 1, 512, `PSD layer ${raw.layerIndex} fontSize`);
		const lineHeight =
			raw.lineHeight === undefined || raw.lineHeight === null ? null : finiteNumber(raw.lineHeight, fontSize, 1, 2048, `PSD layer ${raw.layerIndex} lineHeight`);
		const tracking = finiteNumber(raw.tracking, defaultStyle?.tracking ?? 0, -1000, 10_000, `PSD layer ${raw.layerIndex} tracking`);
		const offsetX = finiteNumber(raw.offsetX, 0, -32_768, 32_768, `PSD layer ${raw.layerIndex} offsetX`);
		const offsetY = finiteNumber(raw.offsetY, 0, -32_768, 32_768, `PSD layer ${raw.layerIndex} offsetY`);
		const justification =
			raw.justification ?? (defaultParagraph?.justification === "center" || defaultParagraph?.justification === "right" ? defaultParagraph.justification : "left");
		if (!["left", "center", "right"].includes(justification)) {
			throw new Error(`PSD layer ${raw.layerIndex} justification must be left, center, or right.`);
		}
		const color = raw.color ?? defaultStyle?.fillColor ?? [255, 255, 255, 255];
		if (!Array.isArray(color) || color.length !== 4 || color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
			throw new Error(`PSD layer ${raw.layerIndex} color must contain four integer RGBA channels between 0 and 255.`);
		}
		const useAuthoredStyleRuns = raw.useAuthoredStyleRuns === true;
		const shaping = raw.shaping ? normalizeProjectFontTextShaping(raw.shaping) : null;
		let boxLayout: IProjectFontTextBoxLayoutOptions | null = null;
		if (applyAuthoredBoxLayout) {
			if (!useAuthoredStyleRuns || raw.text !== undefined) {
				throw new Error(`PSD layer ${raw.layerIndex} applyAuthoredBoxLayout requires exact authored style runs and no replacement text.`);
			}
			if (layer.text.shapeType !== "box" || !layer.text.boxBounds) {
				throw new Error(`PSD layer ${raw.layerIndex} has no exact authored box-text geometry to apply.`);
			}
			const [left, top, right, bottom] = layer.text.boxBounds;
			if (![left, top, right, bottom].every((entry) => Number.isFinite(entry)) || right <= left || bottom <= top) {
				throw new Error(`PSD layer ${raw.layerIndex} authored BoxBounds must describe a finite positive rectangle.`);
			}
			boxLayout = { left, top, right, bottom };
		}
		const rawBindings = raw.styleRunFontBindings ?? [];
		if (!Array.isArray(rawBindings) || rawBindings.length > 64) {
			throw new Error(`PSD layer ${raw.layerIndex} styleRunFontBindings must contain at most 64 entries.`);
		}
		const bindingPaths = new Map<number, string>();
		for (const binding of rawBindings) {
			if (!binding || !Number.isSafeInteger(binding.fontIndex) || binding.fontIndex < 0 || typeof binding.fontPath !== "string" || !binding.fontPath.trim()) {
				throw new Error(`PSD layer ${raw.layerIndex} styleRunFontBindings require a non-negative fontIndex and project-relative fontPath.`);
			}
			if (bindingPaths.has(binding.fontIndex)) {
				throw new Error(`PSD layer ${raw.layerIndex} styleRunFontBindings contains duplicate fontIndex ${binding.fontIndex}.`);
			}
			bindingPaths.set(binding.fontIndex, binding.fontPath);
		}
		if (rawBindings.length && !useAuthoredStyleRuns) {
			throw new Error(`PSD layer ${raw.layerIndex} styleRunFontBindings require useAuthoredStyleRuns=true.`);
		}
		const styleRuns: IPreparedPsdTextRender["styleRuns"] = [];
		const paragraphRuns: IPreparedPsdTextRender["paragraphRuns"] = [];
		if (useAuthoredStyleRuns) {
			if (raw.text !== undefined) {
				throw new Error(`PSD layer ${raw.layerIndex} authored style runs require omitting replacement text so exact TySh run lengths remain valid.`);
			}
			if (!layer.text.styleRuns.length || layer.text.styleRuns.length > 64) {
				throw new Error(`PSD layer ${raw.layerIndex} authored style-run rendering requires 1-64 decoded runs.`);
			}
			let start = 0;
			for (let sourceStyleRunIndex = 0; sourceStyleRunIndex < layer.text.styleRuns.length; ++sourceStyleRunIndex) {
				const style = layer.text.styleRuns[sourceStyleRunIndex];
				if (!Number.isSafeInteger(style.length) || style.length < 1 || start + style.length > text.length) {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an invalid UTF-16 length.`);
				}
				const end = start + style.length;
				if (
					(start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start])) ||
					(end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]))
				) {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} splits a Unicode surrogate pair.`);
				}
				const fillEnabled = style.fillEnabled ?? true;
				const strokeEnabled = style.strokeEnabled ?? false;
				const fillFirst = style.fillFirst ?? true;
				const outlineWidth = finiteNumber(style.outlineWidth ?? 1, 1, 0, 128, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} OutlineWidth`);
				if (style.fontIndex === null || style.fontIndex < 0 || style.fontSize === null || style.tracking === null || (fillEnabled && style.fillColor === null)) {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} lacks exact font, size, tracking, or enabled fill-color evidence.`);
				}
				if (strokeEnabled && style.strokeColor === null) {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} enables stroke without exact StrokeColor evidence.`);
				}
				const runFont = await readPsdProjectFont(bindingPaths.get(style.fontIndex) ?? raw.fontPath, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex}`);
				const leading = style.leading === null ? null : finiteNumber(style.leading, 0, 0, 2048, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} leading`);
				if (style.fontCaps === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported FontCaps value.`);
				}
				if (style.fontBaseline === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported FontBaseline value.`);
				}
				if (style.baselineDirection === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported BaselineDirection value.`);
				}
				if (style.japaneseAlternateFeature === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported JapaneseAlternateFeature value.`);
				}
				if (style.figureStyle === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported FigureStyle value.`);
				}
				if (style.characterDirection === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported CharacterDirection value.`);
				}
				if (style.kashida === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported Kashida value.`);
				}
				if (style.diacriticPosition === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported DiacriticPos value.`);
				}
				if (style.wariChuJustification === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported WariChuJustification value.`);
				}
				if (style.styleRunAlignment === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} has an unsupported StyleRunAlignment value.`);
				}
				if (style.autoLeading === false && (leading === null || leading < 1)) {
					throw new Error(`PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} with autoLeading=false requires explicit leading between 1 and 2,048 pixels.`);
				}
				styleRuns.push({
					sourceStyleRunIndex,
					start,
					length: style.length,
					text: text.slice(start, end),
					fontIndex: style.fontIndex,
					fontName: style.fontName,
					language: style.language,
					fontPath: runFont.portablePath,
					absoluteFontPath: runFont.absolutePath,
					fontHash: runFont.hash,
					fontBytes: runFont.bytes,
					fontData: runFont.data,
					fontSize: finiteNumber(style.fontSize, fontSize, 1, 512, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} fontSize`),
					tracking: finiteNumber(style.tracking, tracking, -1000, 10_000, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} tracking`),
					autoLeading: style.autoLeading,
					leading,
					kerning:
						style.kerning === null ? null : finiteNumber(style.kerning, 0, -1000, 1000, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} manual kerning`),
					autoKerning: style.autoKerning,
					ligatures: style.ligatures,
					discretionaryLigatures: style.discretionaryLigatures,
					color: style.fillColor ?? [0, 0, 0, 0],
					fillEnabled,
					strokeEnabled,
					strokeColor: style.strokeColor,
					fillFirst,
					outlineWidth,
					fauxBold: style.fauxBold,
					fauxItalic: style.fauxItalic,
					fontCaps: style.fontCaps,
					smallCapScale: finiteNumber(layer.text.smallCapSize ?? 0.7, 0.7, 0.1, 1, `PSD layer ${raw.layerIndex} SmallCapSize`),
					fontBaseline: style.fontBaseline,
					fontBaselineScale: finiteNumber(
						style.fontBaseline === "subscript" ? (layer.text.subscriptSize ?? 0.583) : (layer.text.superscriptSize ?? 0.583),
						0.583,
						0.1,
						1,
						`PSD layer ${raw.layerIndex} ${style.fontBaseline === "subscript" ? "SubscriptSize" : "SuperscriptSize"}`
					),
					fontBaselinePosition: finiteNumber(
						style.fontBaseline === "subscript" ? (layer.text.subscriptPosition ?? 0.333) : (layer.text.superscriptPosition ?? 0.333),
						0.333,
						0,
						2,
						`PSD layer ${raw.layerIndex} ${style.fontBaseline === "subscript" ? "SubscriptPosition" : "SuperscriptPosition"}`
					),
					baselineDirection: style.baselineDirection,
					proportionalMetrics: style.proportionalMetrics,
					kana: style.kana,
					ruby: style.ruby,
					japaneseAlternateFeature: style.japaneseAlternateFeature,
					fractions: style.fractions,
					ordinals: style.ordinals,
					stylisticAlternates: style.stylisticAlternates,
					oldStyle: style.oldStyle,
					swash: style.swash,
					titling: style.titling,
					ornaments: style.ornaments,
					slashedZero: style.slashedZero,
					connectionForms: style.connectionForms,
					contextualLigatures: style.contextualLigatures,
					hindiNumbers: style.hindiNumbers,
					kashida: style.kashida === null ? null : style.kashida === "on",
					diacriticPosition: style.diacriticPosition,
					characterDirection: style.characterDirection,
					figureStyle: style.figureStyle,
					engineData2StyleRunIndex: style.engineData2StyleRunIndex,
					wariChuEnabled: style.wariChuEnabled,
					wariChuLineCount:
						style.wariChuLineCount === null
							? null
							: finiteNumber(style.wariChuLineCount, 2, 2, 16, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} WariChuLineCount`),
					wariChuLineGap:
						style.wariChuLineGap === null
							? null
							: finiteNumber(style.wariChuLineGap, 0, 0, 512, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} WariChuLineGap`),
					wariChuScale:
						style.wariChuScale === null
							? null
							: finiteNumber(style.wariChuScale, 0.5, 0.1, 1, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} WariChuSubLineScale`),
					wariChuWidow:
						style.wariChuWidow === null
							? null
							: finiteNumber(style.wariChuWidow, 2, 1, 64, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} WariChuWidowAmount`),
					wariChuOrphan:
						style.wariChuOrphan === null
							? null
							: finiteNumber(style.wariChuOrphan, 2, 1, 64, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} WariChuOrphanAmount`),
					wariChuJustification: style.wariChuJustification,
					tsume: style.tsume === null ? null : finiteNumber(style.tsume, 0, 0, 1, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} Tsume`),
					styleRunAlignment: style.styleRunAlignment,
					horizontalScale: finiteNumber(style.horizontalScale ?? 100, 100, 1, 1000, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} horizontalScale`),
					verticalScale: finiteNumber(style.verticalScale ?? 100, 100, 1, 1000, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} verticalScale`),
					baselineShift: finiteNumber(style.baselineShift ?? 0, 0, -2048, 2048, `PSD layer ${raw.layerIndex} style run ${sourceStyleRunIndex} baselineShift`),
					underline: style.underline,
					strikethrough: style.strikethrough,
					noBreak: style.noBreak ?? false,
				});
				start = end;
			}
			if (start !== text.length) {
				throw new Error(`PSD layer ${raw.layerIndex} style-run lengths cover ${start} of ${text.length} UTF-16 code units.`);
			}
			if (!layer.text.paragraphRuns.length || layer.text.paragraphRuns.length > 64) {
				throw new Error(`PSD layer ${raw.layerIndex} authored paragraph rendering requires 1-64 decoded paragraph runs.`);
			}
			let paragraphStart = 0;
			for (let sourceParagraphRunIndex = 0; sourceParagraphRunIndex < layer.text.paragraphRuns.length; ++sourceParagraphRunIndex) {
				const paragraph = layer.text.paragraphRuns[sourceParagraphRunIndex];
				if (!Number.isSafeInteger(paragraph.length) || paragraph.length < 1 || paragraphStart + paragraph.length > text.length) {
					throw new Error(`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} has an invalid UTF-16 length.`);
				}
				const paragraphEnd = paragraphStart + paragraph.length;
				if (
					(paragraphStart > 0 && /[\uD800-\uDBFF]/.test(text[paragraphStart - 1]) && /[\uDC00-\uDFFF]/.test(text[paragraphStart])) ||
					(paragraphEnd < text.length && /[\uD800-\uDBFF]/.test(text[paragraphEnd - 1]) && /[\uDC00-\uDFFF]/.test(text[paragraphEnd]))
				) {
					throw new Error(`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} splits a Unicode surrogate pair.`);
				}
				if (paragraph.justification === "unknown") {
					throw new Error(`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} has unknown justification semantics.`);
				}
				paragraphRuns.push({
					sourceParagraphRunIndex,
					start: paragraphStart,
					length: paragraph.length,
					justification: paragraph.justification,
					firstLineIndent: finiteNumber(
						paragraph.firstLineIndent ?? 0,
						0,
						-4096,
						4096,
						`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} firstLineIndent`
					),
					startIndent: finiteNumber(paragraph.startIndent ?? 0, 0, -4096, 4096, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} startIndent`),
					endIndent: finiteNumber(paragraph.endIndent ?? 0, 0, -4096, 4096, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} endIndent`),
					spaceBefore: finiteNumber(paragraph.spaceBefore ?? 0, 0, -4096, 4096, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} spaceBefore`),
					spaceAfter: finiteNumber(paragraph.spaceAfter ?? 0, 0, -4096, 4096, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} spaceAfter`),
					autoHyphenate: paragraph.autoHyphenate ?? false,
					hyphenatedWordSize: boundedInteger(
						paragraph.hyphenatedWordSize ?? 5,
						5,
						2,
						25,
						`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} hyphenatedWordSize`
					),
					preHyphen: boundedInteger(paragraph.preHyphen ?? 2, 2, 1, 15, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} preHyphen`),
					postHyphen: boundedInteger(paragraph.postHyphen ?? 2, 2, 1, 15, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} postHyphen`),
					consecutiveHyphens: boundedInteger(
						paragraph.consecutiveHyphens ?? 2,
						2,
						2,
						25,
						`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} consecutiveHyphens`
					),
					hyphenationZone: finiteNumber(
						paragraph.hyphenationZone ?? 36,
						36,
						0,
						8640,
						`PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} hyphenationZone`
					),
					autoLeading:
						paragraph.autoLeading === null
							? null
							: finiteNumber(paragraph.autoLeading, 1.2, 0.25, 10, `PSD layer ${raw.layerIndex} paragraph run ${sourceParagraphRunIndex} autoLeading`),
					everyLineComposer: paragraph.everyLineComposer ?? false,
				});
				paragraphStart = paragraphEnd;
			}
			if (paragraphStart !== text.length) {
				throw new Error(`PSD layer ${raw.layerIndex} paragraph-run lengths cover ${paragraphStart} of ${text.length} UTF-16 code units.`);
			}
		}
		result.set(raw.layerIndex, {
			request: {
				layerIndex: raw.layerIndex,
				text,
				fontPath: fontAsset.portablePath,
				fontSize,
				lineHeight,
				tracking,
				justification: justification as "left" | "center" | "right",
				offsetX,
				offsetY,
				color: color as [number, number, number, number],
				useAuthoredStyleRuns,
				styleRunFontBindings: rawBindings,
				shaping,
				applyAuthoredWarp,
				applyAuthoredBoxLayout,
			},
			absoluteFontPath: fontAsset.absolutePath,
			fontHash: fontAsset.hash,
			fontBytes: fontAsset.bytes,
			fontData: fontAsset.data,
			styleRuns,
			paragraphRuns,
			boxLayout,
		});
	}
	return result;
}

function portableLayerName(layer: IPsdLayerInfo): string {
	const prefix = String(layer.index + 1).padStart(4, "0");
	let name = layer.name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[<>:"/\\|?*]/g, "_")
		.split("")
		.map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
		.join("")
		.replace(/[. ]+$/g, "")
		.trim();
	if (!name || name === "." || name === "..") {
		name = `Layer_${layer.index + 1}`;
	}
	name = name.slice(0, 120);
	return `${prefix}-${name}.png`;
}

function portableSmartObjectPayloadName(resource: IDecodedPsdSmartObjectResource): string {
	const prefix = String(resource.index + 1).padStart(4, "0");
	const hintedExtension = extname(resource.name).toLowerCase();
	const fileTypeExtension = resource.fileType
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 8);
	const extension = /^\.[a-z0-9]{1,12}$/.test(hintedExtension) ? hintedExtension : fileTypeExtension ? `.${fileTypeExtension === "jpeg" ? "jpg" : fileTypeExtension}` : ".bin";
	let name = basename(resource.name, hintedExtension)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[<>:"/\\|?*]/g, "_")
		.split("")
		.map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
		.join("")
		.replace(/[. ]+$/g, "")
		.trim();
	if (!name || name === "." || name === "..") {
		name = `Smart_Object_${resource.index + 1}`;
	}
	return `${prefix}-${name.slice(0, 120)}${extension}`;
}

async function encodeLayer(layer: ReturnType<typeof decodePsdLayers>[number], applyOpacity: boolean): Promise<Buffer> {
	const pixels = Buffer.from(layer.pixels);
	if (applyOpacity && layer.opacity < 255) {
		for (let offset = 3; offset < pixels.byteLength; offset += 4) {
			pixels[offset] = Math.round((pixels[offset] * layer.opacity) / 255);
		}
	}
	return sharp(pixels, { raw: { width: layer.width, height: layer.height, channels: 4 }, limitInputPixels: 67_108_864 })
		.png({ compressionLevel: 9, adaptiveFiltering: true })
		.toBuffer();
}

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function blendChannel(mode: string, backdrop: number, source: number): number {
	switch (mode) {
		case "mul ":
			return backdrop * source;
		case "scrn":
			return backdrop + source - backdrop * source;
		case "over":
			return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
		case "dark":
			return Math.min(backdrop, source);
		case "lite":
			return Math.max(backdrop, source);
		case "div ":
			return source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
		case "idiv":
			return source <= 0 ? 0 : 1 - Math.min(1, (1 - backdrop) / source);
		case "hLit":
			return source <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
		case "sLit": {
			const curve = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
			return source <= 0.5 ? backdrop - (1 - 2 * source) * backdrop * (1 - backdrop) : backdrop + (2 * source - 1) * (curve - backdrop);
		}
		case "diff":
			return Math.abs(backdrop - source);
		case "smud":
			return backdrop + source - 2 * backdrop * source;
		case "lddg":
			return Math.min(1, backdrop + source);
		case "lbrn":
			return Math.max(0, backdrop + source - 1);
		case "fsub":
			return Math.max(0, backdrop - source);
		case "fdiv":
			return source <= 0 ? 1 : Math.min(1, backdrop / source);
		default:
			return source;
	}
}

function luminosity(color: Rgb): number {
	return color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
}

function saturation(color: Rgb): number {
	return Math.max(...color) - Math.min(...color);
}

function clipColor(color: Rgb): Rgb {
	const lightness = luminosity(color);
	const minimum = Math.min(...color);
	const maximum = Math.max(...color);
	let result: Rgb = [...color];
	if (minimum < 0) {
		result = result.map((channel) => lightness + ((channel - lightness) * lightness) / (lightness - minimum)) as Rgb;
	}
	if (maximum > 1) {
		result = result.map((channel) => lightness + ((channel - lightness) * (1 - lightness)) / (maximum - lightness)) as Rgb;
	}
	return result;
}

function setLuminosity(color: Rgb, value: number): Rgb {
	const difference = value - luminosity(color);
	return clipColor(color.map((channel) => channel + difference) as Rgb);
}

function setSaturation(color: Rgb, value: number): Rgb {
	const result: Rgb = [...color];
	const indices = [0, 1, 2].sort((left, right) => result[left] - result[right]);
	const [minimum, middle, maximum] = indices;
	if (result[maximum] > result[minimum]) {
		result[middle] = ((result[middle] - result[minimum]) * value) / (result[maximum] - result[minimum]);
		result[maximum] = value;
	} else {
		result[middle] = 0;
		result[maximum] = 0;
	}
	result[minimum] = 0;
	return result;
}

function blendColor(mode: string, backdrop: Rgb, source: Rgb): Rgb {
	switch (mode) {
		case "hue ":
			return setLuminosity(setSaturation(source, saturation(backdrop)), luminosity(backdrop));
		case "sat ":
			return setLuminosity(setSaturation(backdrop, saturation(source)), luminosity(backdrop));
		case "colr":
			return setLuminosity(source, luminosity(backdrop));
		case "lum ":
			return setLuminosity(backdrop, luminosity(source));
		default:
			return backdrop.map((channel, index) => blendChannel(mode, channel, source[index])) as Rgb;
	}
}

function restrictedRgbChannelIndices(layer: Pick<IPsdLayerInfo, "channelBlendingRestrictions">): ReadonlySet<number> {
	const restricted = layer.channelBlendingRestrictions?.restrictedChannels ?? [];
	if (restricted.includes("gray")) {
		return new Set([0, 1, 2]);
	}
	return new Set([...(restricted.includes("red") ? [0] : []), ...(restricted.includes("green") ? [1] : []), ...(restricted.includes("blue") ? [2] : [])]);
}

function boxBlurMask(mask: Float32Array, width: number, height: number, radius: number, outside: number): Float32Array {
	if (radius <= 0) {
		return mask;
	}
	const diameter = radius * 2 + 1;
	const horizontal = new Float32Array(mask.length);
	for (let y = 0; y < height; ++y) {
		let sum = (radius + Math.max(0, radius - (width - 1))) * outside;
		for (let x = 0; x <= radius && x < width; ++x) {
			sum += mask[y * width + x];
		}
		for (let x = 0; x < width; ++x) {
			horizontal[y * width + x] = sum / diameter;
			const removed = x - radius;
			const added = x + radius + 1;
			sum -= removed >= 0 ? mask[y * width + removed] : outside;
			sum += added < width ? mask[y * width + added] : outside;
		}
	}
	const output = new Float32Array(mask.length);
	for (let x = 0; x < width; ++x) {
		let sum = (radius + Math.max(0, radius - (height - 1))) * outside;
		for (let y = 0; y <= radius && y < height; ++y) {
			sum += horizontal[y * width + x];
		}
		for (let y = 0; y < height; ++y) {
			output[y * width + x] = sum / diameter;
			const removed = y - radius;
			const added = y + radius + 1;
			sum -= removed >= 0 ? horizontal[removed * width + x] : outside;
			sum += added < height ? horizontal[added * width + x] : outside;
		}
	}
	return output;
}

function sampleEffectContour(contour: IPsdLayerEffectContourInfo | null | undefined, value: number): number {
	const clamped = Math.max(0, Math.min(1, value));
	if (!contour?.valid || contour.points.length < 2) {
		return clamped;
	}
	const x = clamped * 255;
	let right = contour.points.findIndex((point) => point.x >= x);
	if (right < 0) {
		right = contour.points.length - 1;
	}
	if (right === 0) {
		return contour.points[0].y / 255;
	}
	const left = contour.points[right - 1];
	const next = contour.points[right];
	const amount = next.x === left.x ? 1 : (x - left.x) / (next.x - left.x);
	return Math.max(0, Math.min(1, (left.y + (next.y - left.y) * amount) / 255));
}

function sampleBevelProfile(effect: IPsdLayerBevelEffectInfo, value: number): number {
	let field = Math.max(0, Math.min(1, value));
	if (effect.useShape) {
		field = sampleEffectContour(effect.shapeContour, Math.min(1, field * (100 / Math.max(1, effect.shapeRange ?? 50))));
	}
	if (effect.technique === "chisel hard") {
		return field > 1e-6 ? 1 : 0;
	}
	if (effect.technique === "chisel soft") {
		return Math.sqrt(field);
	}
	return field;
}

function dilateEffectMask(mask: Float32Array, width: number, height: number, radius: number, outside: number): Float32Array {
	if (radius <= 0) {
		return mask;
	}
	const neighborhood = boxBlurMask(mask, width, height, Math.ceil(radius), outside);
	return neighborhood.map((value) => (value > 1e-6 ? 1 : 0));
}

function effectNoiseValue(x: number, y: number, layerIndex: number, effectIndex: number, salt = 0): number {
	let value = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(layerIndex + 1, 0x2c9277b5) ^ Math.imul(effectIndex + 1, 0x7f4a7c15) ^ Math.imul(salt, 0x6c8e9cf5);
	value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
	value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
	return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function distanceToEffectMask(mask: Float32Array, width: number, height: number, outsideTarget: boolean): Float32Array {
	const distance = new Float32Array(mask.length);
	const diagonal = Math.SQRT2;
	for (let y = 0; y < height; ++y) {
		for (let x = 0; x < width; ++x) {
			const pixel = y * width + x;
			distance[pixel] = Math.max(0, 1 - mask[pixel]);
			if (mask[pixel] <= 1e-6) {
				distance[pixel] = outsideTarget && (x === 0 || y === 0 || x === width - 1 || y === height - 1) ? 1 : Number.POSITIVE_INFINITY;
			}
			if (x > 0) {
				distance[pixel] = Math.min(distance[pixel], distance[pixel - 1] + 1);
			}
			if (y > 0) {
				distance[pixel] = Math.min(distance[pixel], distance[pixel - width] + 1);
				if (x > 0) {
					distance[pixel] = Math.min(distance[pixel], distance[pixel - width - 1] + diagonal);
				}
				if (x + 1 < width) {
					distance[pixel] = Math.min(distance[pixel], distance[pixel - width + 1] + diagonal);
				}
			}
		}
	}
	for (let y = height - 1; y >= 0; --y) {
		for (let x = width - 1; x >= 0; --x) {
			const pixel = y * width + x;
			if (x + 1 < width) {
				distance[pixel] = Math.min(distance[pixel], distance[pixel + 1] + 1);
			}
			if (y + 1 < height) {
				distance[pixel] = Math.min(distance[pixel], distance[pixel + width] + 1);
				if (x > 0) {
					distance[pixel] = Math.min(distance[pixel], distance[pixel + width - 1] + diagonal);
				}
				if (x + 1 < width) {
					distance[pixel] = Math.min(distance[pixel], distance[pixel + width + 1] + diagonal);
				}
			}
		}
	}
	return distance;
}

function createModernGlowField(
	effect: IPsdLayerInnerGlowEffectInfo | IPsdLayerOuterGlowEffectInfo,
	alpha: Float32Array,
	width: number,
	height: number,
	inner: boolean
): Float32Array {
	const mask = inner ? alpha.map((value) => 1 - value) : alpha;
	if (effect.technique === "precise") {
		const distance = distanceToEffectMask(mask, width, height, inner);
		if (inner && effect.glowSource === "center") {
			let maximum = 0;
			for (let pixel = 0; pixel < distance.length; ++pixel) {
				if (alpha[pixel] > 1e-6 && Number.isFinite(distance[pixel])) {
					maximum = Math.max(maximum, distance[pixel]);
				}
			}
			const span = Math.max(1, maximum - (effect.choke ?? 0));
			return distance.map((value, pixel) => (alpha[pixel] <= 1e-6 ? 0 : Math.max(0, Math.min(1, (value - (effect.choke ?? 0)) / span))));
		}
		const spread = Math.max(1, effect.blur + 1);
		return distance.map((value) => Math.max(0, Math.min(1, 1 - Math.max(0, value - (effect.choke ?? 0)) / spread)));
	}
	const choked = dilateEffectMask(mask, width, height, effect.choke ?? 0, inner ? 1 : 0);
	const blurred = boxBlurMask(choked, width, height, Math.round(effect.blur), inner ? 1 : 0);
	return inner && effect.glowSource === "center" ? blurred.map((value) => 1 - value) : blurred;
}

interface IPsdGlowSamplingContext {
	width: number;
	height: number;
	coordinateSpace: IPsdGradientCoordinateSpace;
	layerIndex: number;
}

function sampleGlowField(effect: IPsdLayerInnerGlowEffectInfo | IPsdLayerOuterGlowEffectInfo, fields: Float32Array, pixel: number, context: IPsdGlowSamplingContext): number {
	const x = pixel % context.width;
	const y = Math.floor(pixel / context.width);
	const documentX = context.coordinateSpace.outputLeft + x;
	const documentY = context.coordinateSpace.outputTop + y;
	const jitterRadius = Math.ceil((effect.blur * (effect.jitter ?? 0)) / 100);
	let sampledPixel = pixel;
	if (jitterRadius > 0) {
		const offsetX = Math.round((effectNoiseValue(documentX, documentY, context.layerIndex, effect.index, 1) * 2 - 1) * jitterRadius);
		const offsetY = Math.round((effectNoiseValue(documentX, documentY, context.layerIndex, effect.index, 2) * 2 - 1) * jitterRadius);
		const sampledX = Math.max(0, Math.min(context.width - 1, x + offsetX));
		const sampledY = Math.max(0, Math.min(context.height - 1, y + offsetY));
		sampledPixel = sampledY * context.width + sampledX;
	}
	const range = Math.max(1, effect.range ?? 50);
	let field = sampleEffectContour(effect.contour, Math.pow(Math.max(0, Math.min(1, fields[sampledPixel])), 50 / range));
	if (effect.antialiased === false) {
		field = Math.round(field * 255) / 255;
	}
	const noise = (effect.noise ?? 0) / 100;
	if (noise > 0) {
		const random = effectNoiseValue(documentX, documentY, context.layerIndex, effect.index);
		field *= 1 - noise + random * noise * 2;
	}
	return Math.max(0, Math.min(1, field));
}

function sampleShadowField(
	effect: IPsdLayerInnerShadowEffectInfo | IPsdLayerDropShadowEffectInfo,
	value: number,
	x: number,
	y: number,
	coordinateSpace: IPsdGradientCoordinateSpace,
	layerIndex: number
): number {
	let field = sampleEffectContour(effect.contour, value);
	if (effect.source === "lfx2" && effect.antialiased === false) {
		field = Math.round(field * 255) / 255;
	}
	const noise = effect.source === "lfx2" ? (effect.noise ?? 0) / 100 : 0;
	if (noise > 0) {
		const random = effectNoiseValue(coordinateSpace.outputLeft + x, coordinateSpace.outputTop + y, layerIndex, effect.index);
		field *= 1 - noise + random * noise * 2;
	}
	return Math.max(0, Math.min(1, field));
}

function blendEffectPixel(output: Uint8Array, offset: number, source: Rgb, amount: number, blendMode: string, expandAlpha: boolean = false): void {
	if (amount <= 0) {
		return;
	}
	const backdrop = [output[offset] / 255, output[offset + 1] / 255, output[offset + 2] / 255] satisfies Rgb;
	const blended = blendColor(blendMode, backdrop, source);
	for (let channel = 0; channel < 3; ++channel) {
		output[offset + channel] = clampByte(backdrop[channel] * (1 - amount) + blended[channel] * amount);
	}
	if (expandAlpha) {
		output[offset + 3] = Math.max(output[offset + 3], clampByte(Math.min(1, amount)));
	}
}

function blendEffectBehindPixel(output: Uint8Array, offset: number, source: Rgb, amount: number): void {
	if (amount <= 0) {
		return;
	}
	const foregroundAlpha = output[offset + 3] / 255;
	const backgroundAlpha = Math.min(1, amount);
	const outputAlpha = foregroundAlpha + backgroundAlpha * (1 - foregroundAlpha);
	if (outputAlpha <= 0) {
		return;
	}
	for (let channel = 0; channel < 3; ++channel) {
		const foreground = output[offset + channel] / 255;
		output[offset + channel] = clampByte((foreground * foregroundAlpha + source[channel] * backgroundAlpha * (1 - foregroundAlpha)) / outputAlpha);
	}
	output[offset + 3] = clampByte(outputAlpha);
}

function blendEffectOverPixel(output: Uint8Array, offset: number, source: Rgb, amount: number, blendMode: string): void {
	const sourceAlpha = Math.max(0, Math.min(1, amount));
	if (sourceAlpha <= 0) {
		return;
	}
	const backdropAlpha = output[offset + 3] / 255;
	const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
	const backdrop = [output[offset] / 255, output[offset + 1] / 255, output[offset + 2] / 255] satisfies Rgb;
	const blended = blendColor(blendMode, backdrop, source);
	for (let channel = 0; channel < 3; ++channel) {
		const premultiplied =
			(1 - sourceAlpha) * backdrop[channel] * backdropAlpha + (1 - backdropAlpha) * source[channel] * sourceAlpha + backdropAlpha * sourceAlpha * blended[channel];
		output[offset + channel] = clampByte(outputAlpha > 0 ? premultiplied / outputAlpha : 0);
	}
	output[offset + 3] = clampByte(outputAlpha);
}

function resolvedPattern(pattern: IPsdLayerPatternInfo | null, patterns: Map<number, IDecodedPsdPattern>): IDecodedPsdPattern | null {
	return pattern?.resolvedPatternIndex === null || pattern?.resolvedPatternIndex === undefined ? null : (patterns.get(pattern.resolvedPatternIndex) ?? null);
}

function publicPattern(pattern: IDecodedPsdPattern | null): IPsdEmbeddedPatternInfo | null {
	if (!pattern) {
		return null;
	}
	const { pixels: _pixels, ...result } = pattern;
	return result;
}

function strokeHasRenderableFill(effect: IPsdLayerStrokeEffectInfo, patterns: Map<number, IDecodedPsdPattern>): boolean {
	return (
		(effect.fillType === "solidColor" && effect.color.rgba !== null) ||
		(effect.fillType === "gradient" && effect.gradient?.bakeSupported === true) ||
		(effect.fillType === "pattern" && resolvedPattern(effect.pattern, patterns) !== null)
	);
}

function remapGradientMidpoint(value: number, midpoint: number): number {
	if (value <= 0 || value >= 1 || midpoint <= 0 || midpoint >= 1) {
		return Math.max(0, Math.min(1, value));
	}
	return value <= midpoint ? (value / midpoint) * 0.5 : 0.5 + ((value - midpoint) / (1 - midpoint)) * 0.5;
}

function sampleGradientStops<T extends { location: number; midpoint: number }>(stops: T[], position: number): { left: T; right: T; amount: number } {
	const clamped = Math.max(0, Math.min(1, position));
	if (clamped <= stops[0].location) {
		return { left: stops[0], right: stops[0], amount: 0 };
	}
	for (let index = 1; index < stops.length; ++index) {
		const right = stops[index];
		if (clamped <= right.location) {
			const left = stops[index - 1];
			const span = right.location - left.location;
			const amount = span <= 0 ? 1 : remapGradientMidpoint((clamped - left.location) / span, left.midpoint);
			return { left, right, amount };
		}
	}
	const last = stops[stops.length - 1];
	return { left: last, right: last, amount: 0 };
}

interface IPsdGradientCoordinateSpace {
	width: number;
	height: number;
	documentWidth: number;
	documentHeight: number;
	outputLeft: number;
	outputTop: number;
}

function samplePattern(
	pattern: IPsdLayerPatternInfo,
	decoded: IDecodedPsdPattern,
	x: number,
	y: number,
	coordinateSpace: IPsdGradientCoordinateSpace
): { color: Rgb; opacity: number } {
	const rgba = samplePsdPatternPixel(pattern, decoded, x, y, coordinateSpace);
	return {
		color: [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255],
		opacity: rgba[3] / 255,
	};
}

function gradientPosition(gradient: IPsdLayerGradientInfo, x: number, y: number, coordinateSpace: IPsdGradientCoordinateSpace): number {
	const scale = gradient.scale / 100;
	const basisWidth = gradient.align ? coordinateSpace.width : coordinateSpace.documentWidth;
	const basisHeight = gradient.align ? coordinateSpace.height : coordinateSpace.documentHeight;
	const basisX = gradient.align ? x + 0.5 : coordinateSpace.outputLeft + x + 0.5;
	const basisY = gradient.align ? y + 0.5 : coordinateSpace.outputTop + y + 0.5;
	const normalizedX = (basisX / basisWidth - 0.5 - gradient.offsetX / 100) / scale;
	const normalizedY = (basisY / basisHeight - 0.5 - gradient.offsetY / 100) / scale;
	const radians = (gradient.angle * Math.PI) / 180;
	const projected = normalizedX * Math.cos(radians) - normalizedY * Math.sin(radians);
	let result = 0;
	if (gradient.style === "linear") {
		result = 0.5 + projected;
	} else if (gradient.style === "radial") {
		result = Math.hypot(normalizedX, normalizedY) * 2;
	} else if (gradient.style === "angle") {
		result = ((Math.atan2(normalizedY, normalizedX) - radians) / (Math.PI * 2) + 1) % 1;
	} else if (gradient.style === "reflected") {
		result = Math.abs(projected) * 2;
	} else if (gradient.style === "diamond") {
		result = (Math.abs(normalizedX) + Math.abs(normalizedY)) * 2;
	}
	const clamped = Math.max(0, Math.min(1, result));
	return gradient.reverse ? 1 - clamped : clamped;
}

function interpolationAmount(gradient: IPsdLayerGradientInfo, amount: number): number {
	const clamped = Math.max(0, Math.min(1, amount));
	if (gradient.interpolation === "classic") {
		return clamped * clamped * (3 - 2 * clamped);
	}
	if (gradient.interpolation === "smooth") {
		return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
	}
	return clamped;
}

function srgbToLinear(value: number): number {
	return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
	const clamped = Math.max(0, Math.min(1, value));
	return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function srgbToOklab(color: Rgb): Rgb {
	const red = srgbToLinear(color[0]);
	const green = srgbToLinear(color[1]);
	const blue = srgbToLinear(color[2]);
	const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
	const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
	const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
	return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function oklabToSrgb(color: Rgb): Rgb {
	const l = color[0] + 0.3963377774 * color[1] + 0.2158037573 * color[2];
	const m = color[0] - 0.1055613458 * color[1] - 0.0638541728 * color[2];
	const s = color[0] - 0.0894841775 * color[1] - 1.291485548 * color[2];
	const l3 = l * l * l;
	const m3 = m * m * m;
	const s3 = s * s * s;
	return [
		linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
		linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
		linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
	];
}

function interpolateGradientColor(gradient: IPsdLayerGradientInfo, left: Rgb, right: Rgb, amount: number): Rgb {
	const adjusted = interpolationAmount(gradient, amount);
	if (gradient.interpolation === "linear") {
		return left.map((channel, index) => linearToSrgb(srgbToLinear(channel) + (srgbToLinear(right[index]) - srgbToLinear(channel)) * adjusted)) as Rgb;
	}
	if (gradient.interpolation === "perceptual") {
		const leftOklab = srgbToOklab(left);
		const rightOklab = srgbToOklab(right);
		return oklabToSrgb(leftOklab.map((channel, index) => channel + (rightOklab[index] - channel) * adjusted) as Rgb);
	}
	return left.map((channel, index) => channel + (right[index] - channel) * adjusted) as Rgb;
}

const GRADIENT_DITHER_8X8 = [
	0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17,
	45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];

function ditherGradientColor(color: Rgb, x: number, y: number): Rgb {
	const adjustment = ((GRADIENT_DITHER_8X8[((y & 7) << 3) | (x & 7)] + 0.5) / 64 - 0.5) / 255;
	return color.map((channel) => Math.max(0, Math.min(1, channel + adjustment))) as Rgb;
}

interface IPsdNoiseGradientSample {
	color: Rgb;
	opacity: number;
}

function noiseGradientRandom(seed: number): () => number {
	let state = seed >>> 0;
	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function hsbToRgb(hue: number, saturation: number, brightness: number): Rgb {
	const h = ((hue % 1) + 1) % 1;
	const sector = h * 6;
	const index = Math.floor(sector);
	const fraction = sector - index;
	const p = brightness * (1 - saturation);
	const q = brightness * (1 - saturation * fraction);
	const t = brightness * (1 - saturation * (1 - fraction));
	switch (index % 6) {
		case 0:
			return [brightness, t, p];
		case 1:
			return [q, brightness, p];
		case 2:
			return [p, brightness, t];
		case 3:
			return [p, q, brightness];
		case 4:
			return [t, p, brightness];
		default:
			return [brightness, p, q];
	}
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
	const h = ((hue % 1) + 1) % 1;
	const channel = (offset: number): number => {
		const position = (offset + h * 12) % 12;
		const chroma = saturation * Math.min(lightness, 1 - lightness);
		return lightness - chroma * Math.max(-1, Math.min(position - 3, 9 - position, 1));
	};
	return [channel(0), channel(8), channel(4)];
}

function labToRgb(lightness: number, aChannel: number, bChannel: number): Rgb {
	const l = lightness * 100;
	const a = aChannel * 255 - 128;
	const b = bChannel * 255 - 128;
	const fy = (l + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - b / 200;
	const inverse = (value: number): number => {
		const cube = value * value * value;
		return cube > 216 / 24389 ? cube : (116 * value - 16) / (24389 / 27);
	};
	const x = inverse(fx) * 0.95047;
	const y = inverse(fy);
	const z = inverse(fz) * 1.08883;
	const convert = (value: number): number => (value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(Math.max(0, value), 1 / 2.4) - 0.055);
	return [
		Math.max(0, Math.min(1, convert(x * 3.2404542 + y * -1.5371385 + z * -0.4985314))),
		Math.max(0, Math.min(1, convert(x * -0.969266 + y * 1.8760108 + z * 0.041556))),
		Math.max(0, Math.min(1, convert(x * 0.0556434 + y * -0.2040259 + z * 1.0572252))),
	];
}

function noiseChannelsToRgb(gradient: IPsdLayerGradientInfo, channels: number[]): Rgb {
	let color: Rgb;
	if (gradient.colorModel === "hsb") {
		color = hsbToRgb(channels[0], channels[1], channels[2]);
	} else if (gradient.colorModel === "hsl") {
		color = hslToRgb(channels[0], channels[1], channels[2]);
	} else if (gradient.colorModel === "lab") {
		color = labToRgb(channels[0], channels[1], channels[2]);
	} else {
		color = [channels[0], channels[1], channels[2]];
	}
	if (gradient.restrictColors) {
		const luminance = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
		color = color.map((channel) => luminance + (channel - luminance) * 0.75) as Rgb;
	}
	return color.map((channel) => Math.max(0, Math.min(1, channel))) as Rgb;
}

function createNoiseGradientSamples(gradient: IPsdLayerGradientInfo): IPsdNoiseGradientSample[] {
	const random = noiseGradientRandom(gradient.randomSeed!);
	let channels = Array.from({ length: 256 }, () => gradient.minimum!.map((minimum, index) => minimum + random() * (gradient.maximum![index] - minimum)));
	const radius = Math.round((1 - gradient.roughness!) * 24);
	if (radius > 0) {
		for (let pass = 0; pass < 2; ++pass) {
			const smoothed = channels.map(() => [0, 0, 0, 0]);
			for (let index = 0; index < channels.length; ++index) {
				let count = 0;
				for (let sample = Math.max(0, index - radius); sample <= Math.min(channels.length - 1, index + radius); ++sample) {
					for (let channel = 0; channel < 4; ++channel) {
						smoothed[index][channel] += channels[sample][channel];
					}
					++count;
				}
				for (let channel = 0; channel < 4; ++channel) {
					smoothed[index][channel] /= count;
				}
			}
			channels = smoothed;
		}
	}
	return channels.map((values) => ({ color: noiseChannelsToRgb(gradient, values), opacity: gradient.addTransparency ? values[3] : 1 }));
}

function sampleGradient(
	gradient: IPsdLayerGradientInfo,
	x: number,
	y: number,
	noiseSamples: IPsdNoiseGradientSample[] | null,
	coordinateSpace: IPsdGradientCoordinateSpace
): { color: Rgb; opacity: number } {
	const position = gradientPosition(gradient, x, y, coordinateSpace);
	let result: { color: Rgb; opacity: number };
	if (gradient.type === "noise") {
		const exact = position * (noiseSamples!.length - 1);
		const left = Math.floor(exact);
		const right = Math.min(noiseSamples!.length - 1, left + 1);
		const amount = exact - left;
		result = {
			color: noiseSamples![left].color.map((channel, index) => channel + (noiseSamples![right].color[index] - channel) * amount) as Rgb,
			opacity: noiseSamples![left].opacity + (noiseSamples![right].opacity - noiseSamples![left].opacity) * amount,
		};
	} else {
		const colors = sampleGradientStops(gradient.colorStops, position);
		const leftColor = colors.left.color.rgba!;
		const rightColor = colors.right.color.rgba!;
		const opacity = sampleGradientStops(gradient.opacityStops, position);
		result = {
			color: interpolateGradientColor(
				gradient,
				[leftColor[0] / 255, leftColor[1] / 255, leftColor[2] / 255],
				[rightColor[0] / 255, rightColor[1] / 255, rightColor[2] / 255],
				colors.amount
			),
			opacity: (opacity.left.opacity + (opacity.right.opacity - opacity.left.opacity) * interpolationAmount(gradient, opacity.amount)) / 100,
		};
	}
	return gradient.dither ? { ...result, color: ditherGradientColor(result.color, coordinateSpace.outputLeft + x, coordinateSpace.outputTop + y) } : result;
}

function applyPsdFillOpacity(layer: IDecodedPsdLayer): IDecodedPsdLayer {
	if (layer.fillOpacity === 255) {
		return layer;
	}
	const pixels = new Uint8Array(layer.pixels);
	for (let offset = 3; offset < pixels.length; offset += 4) {
		pixels[offset] = Math.round((pixels[offset] * layer.fillOpacity) / 255);
	}
	return { ...layer, fillOpacity: 255, pixels };
}

function opaquePsdEffectShape(layer: IDecodedPsdLayer): IDecodedPsdLayer {
	const pixels = new Uint8Array(layer.pixels);
	for (let offset = 3; offset < pixels.length; offset += 4) {
		pixels[offset] = 255;
	}
	return { ...layer, opacity: 255, fillOpacity: 255, blendMode: "norm", pixels };
}

function assertPsdTransparencyFillBlendSupported(layer: IDecodedPsdLayer): void {
	if (
		layer.advancedBlending.transparencyShapesLayer === false &&
		PSD_FILL_OPACITY_MODULATING_BLEND_MODES.has(layer.blendMode) &&
		(layer.fillOpacity < 255 || layer.pixels.some((value, offset) => offset % 4 === 3 && value < 255))
	) {
		throw new Error(
			`PSD layer ${layer.name} (${layer.index}) declares tsly=false with partial transparency/fill and modulating blend mode ${layer.blendMode}; exact Photoshop fill-opacity blend modulation is outside the bounded tsly model.`
		);
	}
}

function bakeAuthoredLayerEffects(
	layer: IDecodedPsdLayer,
	document: IPsdLayerDocumentInfo,
	patterns: Map<number, IDecodedPsdPattern>
): {
	layer: IDecodedPsdLayer;
	applied: IPsdAppliedLayerEffect[];
	evidence: IPsdLayerExtractionItem["appliedTransparencyShaping"][number] | null;
} {
	const transparencyShapesLayer = layer.advancedBlending.transparencyShapesLayer;
	assertPsdTransparencyFillBlendSupported(layer);
	if (transparencyShapesLayer === false && ((layer.mask && !layer.mask.disabled) || (layer.vectorMask && !layer.vectorMask.disabled))) {
		throw new Error(
			`PSD layer ${layer.name} (${layer.index}) declares tsly=false with a layer/vector mask; exact combined transparency-shape and mask ordering is outside the bounded tsly model.`
		);
	}
	const effectShape = transparencyShapesLayer === false ? opaquePsdEffectShape(layer) : layer;
	const content = applyPsdFillOpacity(layer);
	const baked = bakeLayerEffects(content, document, patterns, effectShape, "all", transparencyShapesLayer === false);
	const effectTypes = [...new Set(baked.applied.map((effect) => effect.type))];
	return {
		...baked,
		evidence:
			transparencyShapesLayer !== null && effectTypes.length
				? {
						layerIndex: layer.index,
						layerId: layer.id,
						name: layer.name,
						sourceKey: "tsly",
						transparencyShapesLayer,
						fillOpacity: layer.fillOpacity,
						application: transparencyShapesLayer ? "transparency-shapes-effects" : "bounds-shape-effects-transparency-as-fill",
						effectTypes,
						executionModel: "bounded-transparency-shapes-layer-v1",
					}
				: null,
	};
}

function bakeLayerEffects(
	layer: IDecodedPsdLayer,
	document: IPsdLayerDocumentInfo,
	patterns: Map<number, IDecodedPsdPattern>,
	effectShape: IDecodedPsdLayer = layer,
	phase: PsdEffectBakePhase = "all",
	expandTransparencyShapeAlpha: boolean = false
): { layer: IDecodedPsdLayer; applied: IPsdAppliedLayerEffect[] } {
	if (!layer.effects?.visible) {
		return { layer, applied: [] };
	}
	const applied: IPsdAppliedLayerEffect[] = [];
	const effects: PsdBakeEntry[] = [
		...layer.effects.solidFills.map((effect) => ({ type: "solidFill" as const, effect })),
		...layer.effects.innerShadows.map((effect) => ({ type: "innerShadow" as const, effect })),
		...layer.effects.innerGlows.map((effect) => ({ type: "innerGlow" as const, effect })),
		...layer.effects.dropShadows.map((effect) => ({ type: "dropShadow" as const, effect })),
		...layer.effects.outerGlows.map((effect) => ({ type: "outerGlow" as const, effect })),
		...(layer.effects.bevels ?? []).map((effect) => ({ type: "bevel" as const, effect })),
		...(layer.effects.satins ?? []).map((effect) => ({ type: "satin" as const, effect })),
		...(layer.effects.strokes ?? []).map((effect) => ({ type: "stroke" as const, effect })),
		...(layer.effects.gradientOverlays ?? []).map((effect) => ({ type: "gradientOverlay" as const, effect })),
		...(layer.effects.patternOverlays ?? []).map((effect) => ({ type: "patternOverlay" as const, effect })),
	].sort((left, right) => left.effect.index - right.effect.index);
	let leftPadding = 0;
	let rightPadding = 0;
	let topPadding = 0;
	let bottomPadding = 0;
	for (const entry of effects) {
		if (entry.type === "bevel") {
			if (
				entry.effect.enabled &&
				entry.effect.bakeSupported &&
				entry.effect.source === "lfx2" &&
				entry.effect.style !== 2 &&
				entry.effect.highlightColor.rgba &&
				entry.effect.shadowColor.rgba &&
				SUPPORTED_CLIPPING_BLEND_MODES.has(entry.effect.highlightBlendMode) &&
				SUPPORTED_CLIPPING_BLEND_MODES.has(entry.effect.shadowBlendMode)
			) {
				const padding = Math.ceil(Math.max(entry.effect.size ?? entry.effect.strength, entry.effect.strength) + (entry.effect.soften ?? entry.effect.blur));
				leftPadding = Math.max(leftPadding, padding);
				rightPadding = Math.max(rightPadding, padding);
				topPadding = Math.max(topPadding, padding);
				bottomPadding = Math.max(bottomPadding, padding);
			}
			continue;
		}
		if (entry.type === "stroke") {
			if (
				entry.effect.enabled &&
				entry.effect.bakeSupported &&
				strokeHasRenderableFill(entry.effect, patterns) &&
				SUPPORTED_CLIPPING_BLEND_MODES.has(entry.effect.blendMode)
			) {
				const padding = entry.effect.position === "outside" ? Math.ceil(entry.effect.size) : entry.effect.position === "center" ? Math.ceil(entry.effect.size / 2) : 0;
				leftPadding = Math.max(leftPadding, padding);
				rightPadding = Math.max(rightPadding, padding);
				topPadding = Math.max(topPadding, padding);
				bottomPadding = Math.max(bottomPadding, padding);
			}
			continue;
		}
		if (
			(entry.type !== "dropShadow" && entry.type !== "outerGlow") ||
			!entry.effect.enabled ||
			!entry.effect.bakeSupported ||
			!entry.effect.color.rgba ||
			!SUPPORTED_CLIPPING_BLEND_MODES.has(entry.effect.blendMode)
		) {
			continue;
		}
		if (entry.type === "outerGlow") {
			const jitterPadding = entry.effect.source === "lfx2" ? Math.ceil((entry.effect.blur * (entry.effect.jitter ?? 0)) / 100) : 0;
			const radius = Math.ceil(entry.effect.blur + (entry.effect.choke ?? 0) + jitterPadding);
			leftPadding = Math.max(leftPadding, radius);
			rightPadding = Math.max(rightPadding, radius);
			topPadding = Math.max(topPadding, radius);
			bottomPadding = Math.max(bottomPadding, radius);
		} else {
			const radians = (entry.effect.angle * Math.PI) / 180;
			const offsetX = Math.round(Math.cos(radians) * entry.effect.distance);
			const offsetY = Math.round(-Math.sin(radians) * entry.effect.distance);
			const radius = Math.ceil(entry.effect.blur + (entry.effect.choke ?? 0));
			leftPadding = Math.max(leftPadding, radius + Math.max(0, -offsetX));
			rightPadding = Math.max(rightPadding, radius + Math.max(0, offsetX));
			topPadding = Math.max(topPadding, radius + Math.max(0, -offsetY));
			bottomPadding = Math.max(bottomPadding, radius + Math.max(0, offsetY));
		}
	}
	const expandedWidth = effectShape.width + leftPadding + rightPadding;
	const expandedHeight = effectShape.height + topPadding + bottomPadding;
	const canExpand = expandedWidth <= 30_000 && expandedHeight <= 30_000 && expandedWidth * expandedHeight <= MAXIMUM_EFFECT_BAKE_PIXELS;
	if (!canExpand) {
		leftPadding = rightPadding = topPadding = bottomPadding = 0;
	}
	const effectLeft = effectShape.left - leftPadding;
	const effectTop = effectShape.top - topPadding;
	const effectRight = effectShape.right + rightPadding;
	const effectBottom = effectShape.bottom + bottomPadding;
	const outputLeft = Math.min(layer.left, effectLeft);
	const outputTop = Math.min(layer.top, effectTop);
	const outputRight = Math.max(layer.right, effectRight);
	const outputBottom = Math.max(layer.bottom, effectBottom);
	const width = outputRight - outputLeft;
	const height = outputBottom - outputTop;
	const shapePixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < effectShape.height; ++y) {
		shapePixels.set(
			effectShape.pixels.subarray(y * effectShape.width * 4, (y + 1) * effectShape.width * 4),
			((effectShape.top - outputTop + y) * width + effectShape.left - outputLeft) * 4
		);
	}
	const output = new Uint8Array(width * height * 4);
	for (let y = 0; y < layer.height; ++y) {
		output.set(layer.pixels.subarray(y * layer.width * 4, (y + 1) * layer.width * 4), ((layer.top - outputTop + y) * width + layer.left - outputLeft) * 4);
	}
	const outputLayer: IDecodedPsdLayer = {
		...layer,
		left: outputLeft,
		top: outputTop,
		right: outputRight,
		bottom: outputBottom,
		width,
		height,
		pixels: output,
	};
	const gradientCoordinateSpace: IPsdGradientCoordinateSpace = {
		width,
		height,
		documentWidth: document.width,
		documentHeight: document.height,
		outputLeft: outputLayer.left,
		outputTop: outputLayer.top,
	};
	for (const entry of effects) {
		if (entry.type === "stroke") {
			const effect = entry.effect;
			const effectColor = effect.color.rgba;
			const applyBehind = phase !== "foreground" && (effect.position === "outside" || effect.position === "center");
			const applyForeground = phase !== "behind" && (effect.position === "inside" || effect.position === "center");
			if (
				!effect.enabled ||
				!effect.bakeSupported ||
				(!applyBehind && !applyForeground) ||
				!strokeHasRenderableFill(effect, patterns) ||
				!SUPPORTED_CLIPPING_BLEND_MODES.has(effect.blendMode) ||
				width * height > MAXIMUM_EFFECT_BAKE_PIXELS ||
				((effect.position === "outside" || effect.position === "center") && !canExpand)
			) {
				continue;
			}
			const radius = effect.position === "center" ? Math.ceil(effect.size / 2) : Math.ceil(effect.size);
			const noiseSamples = effect.gradient?.type === "noise" ? createNoiseGradientSamples(effect.gradient) : null;
			const embeddedPattern = resolvedPattern(effect.pattern, patterns);
			const alpha = new Float32Array(width * height);
			for (let pixel = 0; pixel < alpha.length; ++pixel) {
				alpha[pixel] = shapePixels[pixel * 4 + 3] / 255;
			}
			const neighborhood = boxBlurMask(alpha, width, height, radius, 0);
			const opacity = effect.opacity / 100;
			for (let pixel = 0; pixel < alpha.length; ++pixel) {
				const dilated = neighborhood[pixel] > 0 ? 1 : 0;
				const eroded = neighborhood[pixel] >= 1 - 1e-6 ? 1 : 0;
				const x = pixel % width;
				const y = Math.floor(pixel / width);
				const sampled =
					effect.fillType === "gradient"
						? sampleGradient(effect.gradient!, x, y, noiseSamples, gradientCoordinateSpace)
						: effect.fillType === "pattern"
							? samplePattern(effect.pattern!, embeddedPattern!, x, y, gradientCoordinateSpace)
							: { color: [effectColor![0] / 255, effectColor![1] / 255, effectColor![2] / 255] satisfies Rgb, opacity: 1 };
				const outsideAmount = Math.max(0, dilated - alpha[pixel]) * opacity * sampled.opacity;
				const insideAmount = Math.max(0, alpha[pixel] - eroded) * opacity * sampled.opacity;
				if (applyBehind) {
					if (phase === "behind") {
						blendEffectOverPixel(output, pixel * 4, sampled.color, outsideAmount, effect.blendMode);
					} else {
						blendEffectBehindPixel(output, pixel * 4, sampled.color, outsideAmount);
					}
				}
				if (applyForeground) {
					blendEffectPixel(output, pixel * 4, sampled.color, insideAmount, effect.blendMode, expandTransparencyShapeAlpha);
				}
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "FrFX",
				type: "stroke",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				color: effectColor,
				position: effect.position as "outside" | "center" | "inside",
				fillType: effect.fillType as "solidColor" | "gradient" | "pattern",
				gradient: effect.gradient,
				pattern: effect.pattern,
				embeddedPattern: publicPattern(embeddedPattern),
				size: effect.size,
				sizeUnits: effect.sizeUnits,
				present: effect.present,
				showInDialog: effect.showInDialog,
			});
			continue;
		}
		if (entry.type === "gradientOverlay") {
			const effect = entry.effect;
			if (
				phase === "behind" ||
				!effect.enabled ||
				!effect.bakeSupported ||
				!SUPPORTED_CLIPPING_BLEND_MODES.has(effect.blendMode) ||
				width * height > MAXIMUM_EFFECT_BAKE_PIXELS
			) {
				continue;
			}
			const opacity = effect.opacity / 100;
			const noiseSamples = effect.gradient.type === "noise" ? createNoiseGradientSamples(effect.gradient) : null;
			for (let pixel = 0; pixel < width * height; ++pixel) {
				const shapeAlpha = shapePixels[pixel * 4 + 3] / 255;
				if (shapeAlpha <= 0) {
					continue;
				}
				const x = pixel % width;
				const y = Math.floor(pixel / width);
				const sampled = sampleGradient(effect.gradient, x, y, noiseSamples, gradientCoordinateSpace);
				blendEffectPixel(output, pixel * 4, sampled.color, shapeAlpha * opacity * sampled.opacity, effect.blendMode, expandTransparencyShapeAlpha);
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "GrFl",
				type: "gradientOverlay",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				source: effect.source,
				gradient: effect.gradient,
				present: effect.present,
				showInDialog: effect.showInDialog,
			});
			continue;
		}
		if (entry.type === "patternOverlay") {
			const effect = entry.effect;
			const embeddedPattern = resolvedPattern(effect.pattern, patterns);
			if (
				phase === "behind" ||
				!effect.enabled ||
				!effect.bakeSupported ||
				!embeddedPattern ||
				!SUPPORTED_CLIPPING_BLEND_MODES.has(effect.blendMode) ||
				width * height > MAXIMUM_EFFECT_BAKE_PIXELS
			) {
				continue;
			}
			const opacity = effect.opacity / 100;
			for (let pixel = 0; pixel < width * height; ++pixel) {
				const shapeAlpha = shapePixels[pixel * 4 + 3] / 255;
				if (shapeAlpha <= 0) {
					continue;
				}
				const x = pixel % width;
				const y = Math.floor(pixel / width);
				const sampled = samplePattern(effect.pattern, embeddedPattern, x, y, gradientCoordinateSpace);
				blendEffectPixel(output, pixel * 4, sampled.color, shapeAlpha * opacity * sampled.opacity, effect.blendMode, expandTransparencyShapeAlpha);
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "patternFill",
				type: "patternOverlay",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				pattern: effect.pattern,
				embeddedPattern: publicPattern(embeddedPattern)!,
				present: effect.present,
				showInDialog: effect.showInDialog,
			});
			continue;
		}
		if (entry.type === "bevel") {
			const effect = entry.effect;
			const executionStyle = effect.source === "lfx2" ? effect.style : 2;
			const applyBehind = phase !== "foreground" && executionStyle !== 2;
			const applyForeground = phase !== "behind" && executionStyle !== 1;
			const highlightColor = effect.highlightColor.rgba;
			const shadowColor = effect.shadowColor.rgba;
			const embeddedTexturePattern = resolvedPattern(effect.texturePattern ?? null, patterns);
			if (
				!effect.enabled ||
				!effect.bakeSupported ||
				(!applyBehind && !applyForeground) ||
				!highlightColor ||
				!shadowColor ||
				(effect.useTexture && !embeddedTexturePattern) ||
				!SUPPORTED_CLIPPING_BLEND_MODES.has(effect.highlightBlendMode) ||
				!SUPPORTED_CLIPPING_BLEND_MODES.has(effect.shadowBlendMode) ||
				width * height > MAXIMUM_EFFECT_BAKE_PIXELS ||
				(executionStyle !== 2 && !canExpand)
			) {
				continue;
			}
			const highlightSource = [highlightColor[0] / 255, highlightColor[1] / 255, highlightColor[2] / 255] satisfies Rgb;
			const shadowSource = [shadowColor[0] / 255, shadowColor[1] / 255, shadowColor[2] / 255] satisfies Rgb;
			const radians = (effect.angle * Math.PI) / 180;
			const depth = Math.max(1, effect.strength);
			let offsetX = Math.round(Math.cos(radians) * depth);
			let offsetY = Math.round(-Math.sin(radians) * depth);
			if (offsetX === 0 && offsetY === 0) {
				offsetX = 1;
			}
			const innerHighlightMask = new Float32Array(width * height);
			const innerShadowMask = new Float32Array(width * height);
			const outerHighlightMask = new Float32Array(width * height);
			const outerShadowMask = new Float32Array(width * height);
			for (let y = 0; y < height; ++y) {
				for (let x = 0; x < width; ++x) {
					const pixel = y * width + x;
					const alpha = shapePixels[pixel * 4 + 3] / 255;
					const highlightX = x - offsetX;
					const highlightY = y - offsetY;
					const shadowX = x + offsetX;
					const shadowY = y + offsetY;
					const highlightSample =
						highlightX < 0 || highlightX >= width || highlightY < 0 || highlightY >= height ? 0 : shapePixels[(highlightY * width + highlightX) * 4 + 3] / 255;
					const shadowSample = shadowX < 0 || shadowX >= width || shadowY < 0 || shadowY >= height ? 0 : shapePixels[(shadowY * width + shadowX) * 4 + 3] / 255;
					innerHighlightMask[pixel] = Math.max(0, alpha - highlightSample);
					innerShadowMask[pixel] = Math.max(0, alpha - shadowSample);
					outerHighlightMask[pixel] = Math.max(0, highlightSample - alpha);
					outerShadowMask[pixel] = Math.max(0, shadowSample - alpha);
				}
			}
			const blurRadius = Math.round(effect.source === "lfx2" ? (effect.soften ?? 0) : effect.blur);
			const innerHighlighted = boxBlurMask(effect.direction === 0 ? innerHighlightMask : innerShadowMask, width, height, blurRadius, 0);
			const innerShadowed = boxBlurMask(effect.direction === 0 ? innerShadowMask : innerHighlightMask, width, height, blurRadius, 0);
			const outerHighlighted = boxBlurMask(effect.direction === 0 ? outerHighlightMask : outerShadowMask, width, height, blurRadius, 0);
			const outerShadowed = boxBlurMask(effect.direction === 0 ? outerShadowMask : outerHighlightMask, width, height, blurRadius, 0);
			const altitudeStrength = effect.source === "lfx2" ? Math.sin(((effect.altitude ?? 30) * Math.PI) / 180) : 1;
			for (let pixel = 0; pixel < innerHighlighted.length; ++pixel) {
				const shapeAlpha = shapePixels[pixel * 4 + 3] / 255;
				let insideHighlight = !applyForeground || executionStyle === 1 ? 0 : executionStyle === 4 ? innerShadowed[pixel] : innerHighlighted[pixel];
				let insideShadow = !applyForeground || executionStyle === 1 ? 0 : executionStyle === 4 ? innerHighlighted[pixel] : innerShadowed[pixel];
				let outsideHighlight = !applyBehind || executionStyle === 2 ? 0 : outerHighlighted[pixel];
				let outsideShadow = !applyBehind || executionStyle === 2 ? 0 : outerShadowed[pixel];
				if (phase !== "behind" && effect.useTexture && effect.texturePattern && embeddedTexturePattern && shapeAlpha > 0) {
					const x = pixel % width;
					const y = Math.floor(pixel / width);
					const current = samplePattern(effect.texturePattern, embeddedTexturePattern, x, y, gradientCoordinateSpace);
					const shifted = samplePattern(effect.texturePattern, embeddedTexturePattern, x - offsetX, y - offsetY, gradientCoordinateSpace);
					const polarity = effect.textureInvert ? -1 : 1;
					const textureField =
						(luminosity(current.color) * current.opacity - luminosity(shifted.color) * shifted.opacity) * polarity * ((effect.textureDepth ?? 100) / 100);
					insideHighlight += Math.max(0, textureField) * shapeAlpha;
					insideShadow += Math.max(0, -textureField) * shapeAlpha;
				}
				const highlightField = sampleEffectContour(effect.contour, sampleBevelProfile(effect, insideHighlight));
				const shadowField = sampleEffectContour(effect.contour, sampleBevelProfile(effect, insideShadow));
				const outsideHighlightField = sampleEffectContour(effect.contour, sampleBevelProfile(effect, outsideHighlight));
				const outsideShadowField = sampleEffectContour(effect.contour, sampleBevelProfile(effect, outsideShadow));
				blendEffectPixel(
					output,
					pixel * 4,
					highlightSource,
					Math.min(1, shapeAlpha * highlightField * altitudeStrength * (effect.highlightOpacity / 100)),
					effect.highlightBlendMode,
					expandTransparencyShapeAlpha
				);
				blendEffectPixel(
					output,
					pixel * 4,
					shadowSource,
					Math.min(1, shapeAlpha * shadowField * altitudeStrength * (effect.shadowOpacity / 100)),
					effect.shadowBlendMode,
					expandTransparencyShapeAlpha
				);
				const outsideHighlightAmount = Math.min(1, (1 - shapeAlpha) * outsideHighlightField * altitudeStrength * (effect.highlightOpacity / 100));
				const outsideShadowAmount = Math.min(1, (1 - shapeAlpha) * outsideShadowField * altitudeStrength * (effect.shadowOpacity / 100));
				if (phase === "behind") {
					blendEffectOverPixel(output, pixel * 4, highlightSource, outsideHighlightAmount, effect.highlightBlendMode);
					blendEffectOverPixel(output, pixel * 4, shadowSource, outsideShadowAmount, effect.shadowBlendMode);
				} else {
					blendEffectBehindPixel(output, pixel * 4, highlightSource, outsideHighlightAmount);
					blendEffectBehindPixel(output, pixel * 4, shadowSource, outsideShadowAmount);
				}
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "bevl",
				type: "bevel",
				angle: effect.angle,
				strength: effect.strength,
				blur: effect.blur,
				highlightBlendMode: effect.highlightBlendMode,
				shadowBlendMode: effect.shadowBlendMode,
				highlightOpacity: effect.highlightOpacity,
				shadowOpacity: effect.shadowOpacity,
				highlightColor,
				shadowColor,
				style: effect.style,
				styleName: effect.styleName,
				useGlobalAngle: effect.useGlobalAngle,
				direction: effect.direction,
				source: effect.source,
				present: effect.present,
				showInDialog: effect.showInDialog,
				size: effect.size,
				depth: effect.depth,
				soften: effect.soften,
				altitude: effect.altitude,
				technique: effect.technique,
				useShape: effect.useShape,
				useTexture: effect.useTexture,
				antialiasGloss: effect.antialiasGloss,
				contour: effect.contour,
				shapeContour: effect.shapeContour,
				shapeRange: effect.shapeRange,
				shapeRangeUnits: effect.shapeRangeUnits,
				texturePattern: effect.texturePattern,
				embeddedTexturePattern: publicPattern(embeddedTexturePattern),
				textureDepth: effect.textureDepth,
				textureDepthUnits: effect.textureDepthUnits,
				textureInvert: effect.textureInvert,
				executionModel: effect.executionModel,
			});
			continue;
		}
		if (entry.type === "satin") {
			const effect = entry.effect;
			const effectColor = effect.color.rgba;
			if (
				phase === "behind" ||
				!effect.enabled ||
				!effect.bakeSupported ||
				!effectColor ||
				!SUPPORTED_CLIPPING_BLEND_MODES.has(effect.blendMode) ||
				width * height > MAXIMUM_EFFECT_BAKE_PIXELS
			) {
				continue;
			}
			const radians = (effect.angle * Math.PI) / 180;
			const offsetX = Math.round(Math.cos(radians) * effect.distance);
			const offsetY = Math.round(-Math.sin(radians) * effect.distance);
			const forward = new Float32Array(width * height);
			const backward = new Float32Array(width * height);
			for (let y = 0; y < height; ++y) {
				for (let x = 0; x < width; ++x) {
					const pixel = y * width + x;
					const forwardX = x - offsetX;
					const forwardY = y - offsetY;
					const backwardX = x + offsetX;
					const backwardY = y + offsetY;
					forward[pixel] = forwardX < 0 || forwardX >= width || forwardY < 0 || forwardY >= height ? 0 : shapePixels[(forwardY * width + forwardX) * 4 + 3] / 255;
					backward[pixel] = backwardX < 0 || backwardX >= width || backwardY < 0 || backwardY >= height ? 0 : shapePixels[(backwardY * width + backwardX) * 4 + 3] / 255;
				}
			}
			const blurredForward = boxBlurMask(forward, width, height, Math.round(effect.size), 0);
			const blurredBackward = boxBlurMask(backward, width, height, Math.round(effect.size), 0);
			const source = [effectColor[0] / 255, effectColor[1] / 255, effectColor[2] / 255] satisfies Rgb;
			for (let pixel = 0; pixel < blurredForward.length; ++pixel) {
				const shapeAlpha = shapePixels[pixel * 4 + 3] / 255;
				const rawField = Math.abs(blurredForward[pixel] - blurredBackward[pixel]);
				const contoured = sampleEffectContour(effect.contour, rawField);
				const field = effect.invert ? 1 - contoured : contoured;
				blendEffectPixel(output, pixel * 4, source, Math.min(1, shapeAlpha * field * (effect.opacity / 100)), effect.blendMode, expandTransparencyShapeAlpha);
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "ChFX",
				type: "satin",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				source: effect.source,
				color: effectColor,
				angle: effect.angle,
				distance: effect.distance,
				size: effect.size,
				antialiased: effect.antialiased,
				invert: effect.invert,
				present: effect.present,
				showInDialog: effect.showInDialog,
				contour: effect.contour,
				executionModel: effect.executionModel,
			});
			continue;
		}
		const commonEffect = entry.effect;
		const behindEffect = entry.type === "dropShadow" || entry.type === "outerGlow";
		if (
			(phase === "behind" && !behindEffect) ||
			(phase === "foreground" && behindEffect) ||
			!commonEffect.enabled ||
			!commonEffect.bakeSupported ||
			!commonEffect.color.rgba ||
			!SUPPORTED_CLIPPING_BLEND_MODES.has(commonEffect.blendMode)
		) {
			continue;
		}
		const effectColor = commonEffect.color.rgba;
		const source = [effectColor[0] / 255, effectColor[1] / 255, effectColor[2] / 255] satisfies Rgb;
		if (entry.type === "solidFill") {
			const effect = entry.effect;
			const effectAlpha = effect.opacity / (effect.source === "lfx2" ? 100 : 255);
			for (let offset = 0; offset < output.byteLength; offset += 4) {
				if (shapePixels[offset + 3] !== 0) {
					blendEffectPixel(output, offset, source, effectAlpha, effect.blendMode, expandTransparencyShapeAlpha);
				}
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "sofi",
				type: "solidFill",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				source: effect.source,
				color: effectColor,
			});
			continue;
		}
		if (width * height > MAXIMUM_EFFECT_BAKE_PIXELS || ((entry.type === "dropShadow" || entry.type === "outerGlow") && !canExpand)) {
			continue;
		}
		const mask = new Float32Array(width * height);
		if (entry.type === "innerShadow") {
			const effect = entry.effect;
			const radians = (effect.angle * Math.PI) / 180;
			const offsetX = Math.round(Math.cos(radians) * effect.distance);
			const offsetY = Math.round(-Math.sin(radians) * effect.distance);
			for (let y = 0; y < height; ++y) {
				for (let x = 0; x < width; ++x) {
					const sourceX = x - offsetX;
					const sourceY = y - offsetY;
					mask[y * width + x] = sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height ? 1 : 1 - shapePixels[(sourceY * width + sourceX) * 4 + 3] / 255;
				}
			}
			const choked = dilateEffectMask(mask, width, height, effect.source === "lfx2" ? (effect.choke ?? 0) : 0, 1);
			const blurred = boxBlurMask(choked, width, height, Math.round(effect.blur), 1);
			const strength = (effect.intensity / 100) * (effect.opacity / 100);
			for (let pixel = 0; pixel < blurred.length; ++pixel) {
				const shapeAlpha = shapePixels[pixel * 4 + 3] / 255;
				const x = pixel % width;
				const y = Math.floor(pixel / width);
				const field = sampleShadowField(effect, blurred[pixel], x, y, gradientCoordinateSpace, layer.index);
				blendEffectPixel(output, pixel * 4, source, Math.min(1, shapeAlpha * field * strength), effect.blendMode, expandTransparencyShapeAlpha);
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "isdw",
				type: "innerShadow",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				color: effectColor,
				blur: effect.blur,
				intensity: effect.intensity,
				angle: effect.angle,
				distance: effect.distance,
				useGlobalAngle: effect.useGlobalAngle,
				source: effect.source,
				present: effect.present,
				showInDialog: effect.showInDialog,
				choke: effect.choke,
				antialiased: effect.antialiased,
				noise: effect.noise,
				contour: effect.contour,
				executionModel: effect.executionModel,
			});
		} else if (entry.type === "innerGlow") {
			const effect = entry.effect;
			for (let pixel = 0; pixel < mask.length; ++pixel) {
				mask[pixel] = shapePixels[pixel * 4 + 3] / 255;
			}
			const fields =
				effect.source === "lfx2"
					? createModernGlowField(effect, mask, width, height, true)
					: boxBlurMask(
							mask.map((value) => 1 - value),
							width,
							height,
							effect.blur,
							1
						);
			const strength = (effect.intensity / 100) * (effect.opacity / 100);
			const samplingContext = { width, height, coordinateSpace: gradientCoordinateSpace, layerIndex: layer.index } satisfies IPsdGlowSamplingContext;
			for (let pixel = 0; pixel < fields.length; ++pixel) {
				const shapeAlpha = shapePixels[pixel * 4 + 3] / 255;
				const sampled = effect.source === "lfx2" ? sampleGlowField(effect, fields, pixel, samplingContext) : fields[pixel];
				const field = effect.invert ? 1 - sampled : sampled;
				blendEffectPixel(output, pixel * 4, source, Math.min(1, shapeAlpha * field * strength), effect.blendMode, expandTransparencyShapeAlpha);
			}
			applied.push({
				...effectDescriptorEvidence(effect),
				layerIndex: layer.index,
				layerName: layer.name,
				effectIndex: effect.index,
				key: "iglw",
				type: "innerGlow",
				blendMode: effect.blendMode,
				opacity: effect.opacity,
				color: effectColor,
				blur: effect.blur,
				intensity: effect.intensity,
				invert: effect.invert,
				source: effect.source,
				present: effect.present,
				showInDialog: effect.showInDialog,
				choke: effect.choke,
				antialiased: effect.antialiased,
				noise: effect.noise,
				range: effect.range,
				jitter: effect.jitter,
				glowSource: effect.glowSource,
				technique: effect.technique,
				contour: effect.contour,
				executionModel: effect.executionModel,
			});
		} else {
			const outerEffect = entry.effect;
			if (entry.type === "dropShadow") {
				const shadowEffect = entry.effect;
				const radians = (shadowEffect.angle * Math.PI) / 180;
				const offsetX = Math.round(Math.cos(radians) * shadowEffect.distance);
				const offsetY = Math.round(-Math.sin(radians) * shadowEffect.distance);
				for (let y = 0; y < height; ++y) {
					for (let x = 0; x < width; ++x) {
						const sourceX = x - offsetX;
						const sourceY = y - offsetY;
						mask[y * width + x] = sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height ? 0 : shapePixels[(sourceY * width + sourceX) * 4 + 3] / 255;
					}
				}
			} else {
				for (let pixel = 0; pixel < mask.length; ++pixel) {
					mask[pixel] = shapePixels[pixel * 4 + 3] / 255;
				}
			}
			const shadowEffect = entry.type === "dropShadow" ? entry.effect : null;
			const glowEffect = entry.type === "outerGlow" && entry.effect.source === "lfx2" ? entry.effect : null;
			const choked = dilateEffectMask(mask, width, height, shadowEffect?.source === "lfx2" ? (shadowEffect.choke ?? 0) : 0, 0);
			const fields = glowEffect ? createModernGlowField(glowEffect, mask, width, height, false) : boxBlurMask(choked, width, height, Math.round(outerEffect.blur), 0);
			const strength = (outerEffect.intensity / 100) * (outerEffect.opacity / 100);
			const samplingContext = { width, height, coordinateSpace: gradientCoordinateSpace, layerIndex: layer.index } satisfies IPsdGlowSamplingContext;
			for (let pixel = 0; pixel < fields.length; ++pixel) {
				const x = pixel % width;
				const y = Math.floor(pixel / width);
				const field = shadowEffect
					? sampleShadowField(shadowEffect, fields[pixel], x, y, gradientCoordinateSpace, layer.index)
					: glowEffect
						? sampleGlowField(glowEffect, fields, pixel, samplingContext)
						: fields[pixel];
				const amount = Math.min(1, field * strength);
				if (phase === "behind") {
					blendEffectOverPixel(output, pixel * 4, source, amount, outerEffect.blendMode);
				} else {
					blendEffectBehindPixel(output, pixel * 4, source, amount);
				}
			}
			if (entry.type === "dropShadow") {
				const effect = entry.effect;
				applied.push({
					...effectDescriptorEvidence(effect),
					layerIndex: layer.index,
					layerName: layer.name,
					effectIndex: effect.index,
					key: "dsdw",
					type: "dropShadow",
					blendMode: effect.blendMode,
					opacity: effect.opacity,
					color: effectColor,
					blur: effect.blur,
					intensity: effect.intensity,
					angle: effect.angle,
					distance: effect.distance,
					useGlobalAngle: effect.useGlobalAngle,
					source: effect.source,
					present: effect.present,
					showInDialog: effect.showInDialog,
					choke: effect.choke,
					antialiased: effect.antialiased,
					noise: effect.noise,
					contour: effect.contour,
					layerConceals: effect.layerConceals,
					executionModel: effect.executionModel,
				});
			} else {
				const effect = entry.effect;
				applied.push({
					...effectDescriptorEvidence(effect),
					layerIndex: layer.index,
					layerName: layer.name,
					effectIndex: effect.index,
					key: "oglw",
					type: "outerGlow",
					blendMode: effect.blendMode,
					opacity: effect.opacity,
					color: effectColor,
					blur: effect.blur,
					intensity: effect.intensity,
					source: effect.source,
					present: effect.present,
					showInDialog: effect.showInDialog,
					choke: effect.choke,
					antialiased: effect.antialiased,
					noise: effect.noise,
					range: effect.range,
					jitter: effect.jitter,
					glowSource: effect.glowSource,
					technique: effect.technique,
					contour: effect.contour,
					executionModel: effect.executionModel,
				});
			}
		}
	}
	return { layer: applied.length ? outputLayer : layer, applied };
}

function extractionWarnings(layer: IDecodedPsdLayer | IPsdLayerInfo, applied: Set<string>, compositedGroup = false): string[] {
	return layer.warnings.filter((warning) => {
		if (compositedGroup && warning === "Blend mode pass is not composited into an isolated sprite.") {
			return false;
		}
		const match = /^Layer effect (sofi|GrFl|isdw|iglw|dsdw|oglw|bevl|ChFX|FrFX|patternFill) #(\d+)/.exec(warning);
		return !match || !applied.has(`${layer.index}:${match[1]}:${Number(match[2]) - 1}`);
	});
}

function compositeClippingLayers(base: IDecodedPsdLayer, clippingLayers: IDecodedPsdLayer[], shape: IDecodedPsdLayer = base): IDecodedPsdLayer {
	const output = new Uint8Array(base.pixels);
	const baseAlpha = new Uint8Array(base.width * base.height);
	for (let y = 0; y < shape.height; ++y) {
		const baseY = shape.top + y - base.top;
		if (baseY < 0 || baseY >= base.height) {
			continue;
		}
		for (let x = 0; x < shape.width; ++x) {
			const baseX = shape.left + x - base.left;
			if (baseX >= 0 && baseX < base.width) {
				baseAlpha[baseY * base.width + baseX] = shape.pixels[(y * shape.width + x) * 4 + 3];
			}
		}
	}
	for (const layer of clippingLayers) {
		const restrictedChannels = restrictedRgbChannelIndices(layer);
		for (let y = 0; y < layer.height; ++y) {
			const baseY = layer.top + y - base.top;
			if (baseY < 0 || baseY >= base.height) {
				continue;
			}
			for (let x = 0; x < layer.width; ++x) {
				const baseX = layer.left + x - base.left;
				if (baseX < 0 || baseX >= base.width) {
					continue;
				}
				const sourceOffset = (y * layer.width + x) * 4;
				const destinationPixel = baseY * base.width + baseX;
				const destinationOffset = destinationPixel * 4;
				const shapeAlpha = baseAlpha[destinationPixel] / 255;
				const sourceAlpha = (layer.pixels[sourceOffset + 3] / 255) * (layer.opacity / 255) * shapeAlpha;
				if (sourceAlpha <= 0) {
					continue;
				}
				const backdrop = [output[destinationOffset] / 255, output[destinationOffset + 1] / 255, output[destinationOffset + 2] / 255] satisfies Rgb;
				const source = [layer.pixels[sourceOffset] / 255, layer.pixels[sourceOffset + 1] / 255, layer.pixels[sourceOffset + 2] / 255] satisfies Rgb;
				const blended = blendColor(layer.blendMode, backdrop, source);
				for (let channel = 0; channel < 3; ++channel) {
					if (!restrictedChannels.has(channel)) {
						output[destinationOffset + channel] = clampByte(backdrop[channel] * (1 - sourceAlpha) + blended[channel] * sourceAlpha);
					}
				}
				output[destinationOffset + 3] = base.pixels[destinationOffset + 3];
			}
		}
	}
	return { ...base, pixels: output };
}

function clippingGroups(document: IPsdLayerDocumentInfo): Map<number, number[]> {
	const result = new Map<number, number[]>();
	for (let baseIndex = 0; baseIndex < document.layers.length; ++baseIndex) {
		const base = document.layers[baseIndex];
		if (base.kind !== "pixel" || base.clipping) {
			continue;
		}
		const clipped: number[] = [];
		for (let index = baseIndex - 1; index >= 0; --index) {
			const candidate = document.layers[index];
			if ((candidate.kind !== "pixel" && candidate.kind !== "adjustment") || !candidate.clipping) {
				break;
			}
			clipped.push(index);
		}
		if (clipped.length) {
			result.set(baseIndex, clipped);
		}
	}
	return result;
}

function layerGroupScopes(document: IPsdLayerDocumentInfo): Map<number, number[]> {
	const result = new Map<number, number[]>();
	const stack: number[] = [];
	for (let index = document.layers.length - 1; index >= 0; --index) {
		const layer = document.layers[index];
		if (layer.kind === "groupEnd") {
			stack.pop();
			result.set(layer.index, [...stack]);
			continue;
		}
		result.set(layer.index, [...stack]);
		if (layer.kind === "groupStart") {
			stack.push(layer.index);
		}
	}
	return result;
}

function groupCompositeInfos(document: IPsdLayerDocumentInfo, applyLayerEffects: boolean, applyAdjustments: boolean): IPsdGroupCompositeInfo[] {
	const starts: number[] = [];
	const pairs: Array<{ start: number; end: number }> = [];
	for (let index = document.layers.length - 1; index >= 0; --index) {
		const layer = document.layers[index];
		if (layer.kind === "groupStart") {
			starts.push(index);
		} else if (layer.kind === "groupEnd") {
			const start = starts.pop();
			if (start !== undefined) {
				pairs.push({ start, end: index });
			}
		}
	}
	const pairByStart = new Map(pairs.map((pair) => [pair.start, pair]));
	const clipping = clippingGroups(document);
	const clippedIndices = new Set([...clipping.values()].flat());
	const directChildren = (pair: { start: number; end: number }): IPsdLayerInfo[] => {
		const result: IPsdLayerInfo[] = [];
		for (let index = pair.start - 1; index > pair.end; --index) {
			const child = document.layers[index];
			if (child.kind === "groupStart") {
				const nestedPair = pairByStart.get(index);
				if (!nestedPair || nestedPair.end <= pair.end) {
					result.push(child);
					continue;
				}
				result.push(child);
				index = nestedPair.end;
				continue;
			}
			if (child.kind !== "groupEnd") {
				result.push(child);
			}
		}
		return result;
	};
	const cache = new Map<number, IPsdGroupCompositeInfo>();
	const inspect = (pair: { start: number; end: number }): IPsdGroupCompositeInfo => {
		const cached = cache.get(pair.start);
		if (cached) {
			return cached;
		}
		const group = document.layers[pair.start];
		const children = directChildren(pair);
		const nested = children
			.filter((child) => child.kind === "groupStart")
			.map((child) => pairByStart.get(child.index))
			.filter((candidate): candidate is { start: number; end: number } => candidate !== undefined)
			.map(inspect);
		const warnings: string[] = [];
		const passThrough = group.blendMode === "pass";
		const parentPair = pairs.find((candidate) => candidate.start > pair.start && candidate.end < pair.end);
		const backdropLayers = parentPair ? [] : document.layers.slice(pair.start + 1).filter((candidate) => candidate.visible);
		const boundedBackdrop =
			backdropLayers.length > 0 &&
			backdropLayers.every(
				(candidate) =>
					candidate.kind === "pixel" &&
					!candidate.clipping &&
					SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode) &&
					(!candidate.mask || candidate.mask.disabled) &&
					(!candidate.vectorMask || candidate.vectorMask.disabled) &&
					!hasEnabledLayerEffects(candidate)
			);
		const hasGroupMask = Boolean((group.mask && !group.mask.disabled) || (group.vectorMask && !group.vectorMask.disabled));
		const hasGroupEffects = hasEnabledLayerEffects(group);
		const visiblePixelChildren = children.filter((child) => child.visible && child.kind === "pixel");
		const hasKnockoutChild = visiblePixelChildren.some((child) => child.advancedBlending.knockout !== "none");
		const hasNonNormalChild = visiblePixelChildren.some((child) => !child.clipping && child.blendMode !== "norm");
		const hasNonNormalBackdrop = backdropLayers.some((candidate) => candidate.blendMode !== "norm");
		const backdropMaskEffectsExecution =
			passThrough &&
			applyLayerEffects &&
			hasGroupMask &&
			hasGroupEffects &&
			enabledLayerEffectsAreBakeSupported(group) &&
			boundedBackdrop &&
			adjustmentMaskIsSupported(group);
		const freeAdjustments = children.filter((child) => child.visible && child.kind === "adjustment" && !child.clipping);
		const backdropAdjustmentsExecution =
			passThrough &&
			applyAdjustments &&
			freeAdjustments.length > 0 &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			boundedBackdrop &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			!nested.some((candidate) => candidate.visible);
		const backdropBlendAdjustmentsExecution =
			backdropAdjustmentsExecution && hasNonNormalChild && visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode));
		const backdropEffectsExecution = passThrough && applyLayerEffects && hasGroupEffects && enabledLayerEffectsAreBakeSupported(group) && boundedBackdrop && !hasGroupMask;
		const backdropMaskExecution = passThrough && hasGroupMask && boundedBackdrop && adjustmentMaskIsSupported(group);
		const backdropOpacityExecution = passThrough && group.opacity !== 255 && boundedBackdrop && !hasGroupMask;
		const knockoutExecution =
			passThrough &&
			group.opacity === 255 &&
			hasKnockoutChild &&
			boundedBackdrop &&
			visiblePixelChildren.every((child) => child.blendMode === "norm") &&
			visiblePixelChildren
				.filter((child) => child.clipping && child.advancedBlending.knockout !== "none")
				.every((child) => {
					const base = [...clipping.entries()].find(([, clipped]) => clipped.includes(child.index));
					return Boolean(base && base[0] > pair.end && base[0] < pair.start && document.layers[base[0]].advancedBlending.blendClippedLayersAsGroup !== false);
				}) &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			freeAdjustments.length === 0 &&
			!nested.some((candidate) => candidate.visible);
		const backdropBlendExecution =
			passThrough &&
			(hasNonNormalChild || (hasNonNormalBackdrop && group.opacity !== 255)) &&
			boundedBackdrop &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments) &&
			!nested.some((candidate) => candidate.visible);
		const backdropBlendMaskExecution =
			passThrough &&
			hasGroupMask &&
			(hasNonNormalChild || hasNonNormalBackdrop) &&
			boundedBackdrop &&
			adjustmentMaskIsSupported(group) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(!applyLayerEffects || !hasGroupEffects) &&
			freeAdjustments.length === 0 &&
			!nested.some((candidate) => candidate.visible);
		const backdropBlendEffectsExecution =
			passThrough &&
			applyLayerEffects &&
			hasGroupEffects &&
			hasNonNormalChild &&
			enabledLayerEffectsAreBakeSupported(group) &&
			enabledLayerEffectsAreBackdropForegroundSafe(group) &&
			boundedBackdrop &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			!hasGroupMask &&
			freeAdjustments.length === 0 &&
			!nested.some((candidate) => candidate.visible);
		const backdropBlendBehindEffectsExecution =
			passThrough &&
			applyLayerEffects &&
			hasGroupEffects &&
			hasNonNormalChild &&
			enabledLayerEffectsAreBakeSupported(group) &&
			!enabledLayerEffectsAreBackdropForegroundSafe(group) &&
			boundedBackdrop &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			!hasGroupMask &&
			freeAdjustments.length === 0 &&
			!nested.some((candidate) => candidate.visible);
		const nestedBackdropChildrenSupported = nested
			.filter((candidate) => candidate.visible)
			.every((candidate) => {
				const candidateGroup = document.layers[candidate.groupStartIndex];
				return candidateGroup.blendMode === "pass" ? candidate.requiresParentBackdrop : candidate.supported && candidateGroup.blendMode === "norm";
			});
		const nestedBackdropBlendDependency = nested.some((candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-blends-v1");
		const nestedBackdropMaskDependency = nested.some((candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-mask-v1");
		const nestedBackdropMaskEffectsDependency = nested.some(
			(candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1"
		);
		const nestedBackdropMaskAdjustmentsDependency = nested.some(
			(candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1"
		);
		const nestedBackdropMaskEffectsAdjustmentsDependency = nested.some(
			(candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1"
		);
		const nestedBackdropEffectDependency = nested.some((candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-effects-v1");
		const nestedBackdropEffectsAdjustmentsDependency = nested.some(
			(candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1"
		);
		const nestedBackdropAdjustmentDependency = nested.some(
			(candidate) => candidate.visible && candidate.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1"
		);
		const parentBackdropExecution =
			Boolean(parentPair) &&
			passThrough &&
			(group.opacity !== 255 || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && child.blendMode === "norm") &&
			!nestedBackdropBlendDependency &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const parentBackdropBlendExecution =
			Boolean(parentPair) &&
			passThrough &&
			(group.opacity !== 255 || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasNonNormalChild || nestedBackdropBlendDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const parentBackdropMaskExecution =
			Boolean(parentPair) &&
			passThrough &&
			(group.opacity !== 255 || hasGroupMask || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask || nestedBackdropMaskDependency) &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			adjustmentMaskIsSupported(group) &&
			nestedBackdropChildrenSupported &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const parentBackdropEffectExecution =
			Boolean(parentPair) &&
			passThrough &&
			applyLayerEffects &&
			(group.opacity !== 255 || hasGroupEffects || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupEffects || nestedBackdropEffectDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			enabledLayerEffectsAreBakeSupported(group) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const parentBackdropMaskEffectsExecution =
			Boolean(parentPair) &&
			passThrough &&
			applyLayerEffects &&
			(group.opacity !== 255 || hasGroupMask || hasGroupEffects || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask || nestedBackdropMaskDependency || nestedBackdropMaskEffectsDependency) &&
			(hasGroupEffects || nestedBackdropEffectDependency || nestedBackdropMaskEffectsDependency) &&
			!nestedBackdropAdjustmentDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			adjustmentMaskIsSupported(group) &&
			enabledLayerEffectsAreBakeSupported(group) &&
			nestedBackdropChildrenSupported &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const parentBackdropMaskAdjustmentsExecution =
			Boolean(parentPair) &&
			passThrough &&
			applyAdjustments &&
			(group.opacity !== 255 || hasGroupMask || freeAdjustments.length > 0 || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask || nestedBackdropMaskDependency || nestedBackdropMaskAdjustmentsDependency) &&
			(freeAdjustments.length > 0 || nestedBackdropAdjustmentDependency || nestedBackdropMaskAdjustmentsDependency) &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			adjustmentMaskIsSupported(group) &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nestedBackdropChildrenSupported &&
			(!applyLayerEffects || !hasGroupEffects);
		const parentBackdropEffectsAdjustmentsExecution =
			Boolean(parentPair) &&
			passThrough &&
			applyLayerEffects &&
			applyAdjustments &&
			(group.opacity !== 255 || hasGroupEffects || freeAdjustments.length > 0 || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupEffects || nestedBackdropEffectDependency || nestedBackdropEffectsAdjustmentsDependency) &&
			(freeAdjustments.length > 0 || nestedBackdropAdjustmentDependency || nestedBackdropEffectsAdjustmentsDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			enabledLayerEffectsAreBakeSupported(group) &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask;
		const parentBackdropMaskEffectsAdjustmentsExecution =
			Boolean(parentPair) &&
			passThrough &&
			applyLayerEffects &&
			applyAdjustments &&
			(group.opacity !== 255 ||
				hasGroupMask ||
				hasGroupEffects ||
				freeAdjustments.length > 0 ||
				nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask ||
				nestedBackdropMaskDependency ||
				nestedBackdropMaskEffectsDependency ||
				nestedBackdropMaskAdjustmentsDependency ||
				nestedBackdropMaskEffectsAdjustmentsDependency) &&
			(hasGroupEffects ||
				nestedBackdropEffectDependency ||
				nestedBackdropMaskEffectsDependency ||
				nestedBackdropEffectsAdjustmentsDependency ||
				nestedBackdropMaskEffectsAdjustmentsDependency) &&
			(freeAdjustments.length > 0 ||
				nestedBackdropAdjustmentDependency ||
				nestedBackdropMaskAdjustmentsDependency ||
				nestedBackdropEffectsAdjustmentsDependency ||
				nestedBackdropMaskEffectsAdjustmentsDependency) &&
			adjustmentMaskIsSupported(group) &&
			enabledLayerEffectsAreBakeSupported(group) &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nestedBackdropChildrenSupported;
		const parentBackdropAdjustmentExecution =
			Boolean(parentPair) &&
			passThrough &&
			applyAdjustments &&
			(group.opacity !== 255 || freeAdjustments.length > 0 || nested.some((candidate) => candidate.visible && candidate.requiresParentBackdrop)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(freeAdjustments.length > 0 || nestedBackdropAdjustmentDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects);
		const nestedBackdropExecution =
			!parentPair &&
			passThrough &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => candidate.blendMode === "norm") &&
			visiblePixelChildren.every((child) => !child.clipping && child.blendMode === "norm") &&
			!nestedBackdropBlendDependency &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const nestedBackdropBlendExecution =
			!parentPair &&
			passThrough &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasNonNormalBackdrop || hasNonNormalChild || nestedBackdropBlendDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const nestedBackdropMaskExecution =
			!parentPair &&
			passThrough &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask || nestedBackdropMaskDependency) &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			adjustmentMaskIsSupported(group) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			(!applyLayerEffects || !hasGroupEffects) &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const nestedBackdropEffectExecution =
			!parentPair &&
			passThrough &&
			applyLayerEffects &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupEffects || nestedBackdropEffectDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			!nestedBackdropAdjustmentDependency &&
			enabledLayerEffectsAreBakeSupported(group) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const nestedBackdropMaskEffectsExecution =
			!parentPair &&
			passThrough &&
			applyLayerEffects &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask || nestedBackdropMaskDependency || nestedBackdropMaskEffectsDependency) &&
			(hasGroupEffects || nestedBackdropEffectDependency || nestedBackdropMaskEffectsDependency) &&
			!nestedBackdropAdjustmentDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			adjustmentMaskIsSupported(group) &&
			enabledLayerEffectsAreBakeSupported(group) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			(freeAdjustments.length === 0 || !applyAdjustments);
		const nestedBackdropMaskAdjustmentsExecution =
			!parentPair &&
			passThrough &&
			applyAdjustments &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask || nestedBackdropMaskDependency || nestedBackdropMaskAdjustmentsDependency) &&
			(freeAdjustments.length > 0 || nestedBackdropAdjustmentDependency || nestedBackdropMaskAdjustmentsDependency) &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			adjustmentMaskIsSupported(group) &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			(!applyLayerEffects || !hasGroupEffects);
		const nestedBackdropEffectsAdjustmentsExecution =
			!parentPair &&
			passThrough &&
			applyLayerEffects &&
			applyAdjustments &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupEffects || nestedBackdropEffectDependency || nestedBackdropEffectsAdjustmentsDependency) &&
			(freeAdjustments.length > 0 || nestedBackdropAdjustmentDependency || nestedBackdropEffectsAdjustmentsDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			enabledLayerEffectsAreBakeSupported(group) &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask;
		const nestedBackdropMaskEffectsAdjustmentsExecution =
			!parentPair &&
			passThrough &&
			applyLayerEffects &&
			applyAdjustments &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(hasGroupMask ||
				nestedBackdropMaskDependency ||
				nestedBackdropMaskEffectsDependency ||
				nestedBackdropMaskAdjustmentsDependency ||
				nestedBackdropMaskEffectsAdjustmentsDependency) &&
			(hasGroupEffects ||
				nestedBackdropEffectDependency ||
				nestedBackdropMaskEffectsDependency ||
				nestedBackdropEffectsAdjustmentsDependency ||
				nestedBackdropMaskEffectsAdjustmentsDependency) &&
			(freeAdjustments.length > 0 ||
				nestedBackdropAdjustmentDependency ||
				nestedBackdropMaskAdjustmentsDependency ||
				nestedBackdropEffectsAdjustmentsDependency ||
				nestedBackdropMaskEffectsAdjustmentsDependency) &&
			adjustmentMaskIsSupported(group) &&
			enabledLayerEffectsAreBakeSupported(group) &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported;
		const nestedBackdropAdjustmentExecution =
			!parentPair &&
			passThrough &&
			applyAdjustments &&
			boundedBackdrop &&
			backdropLayers.every((candidate) => SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) &&
			visiblePixelChildren.every((child) => !child.clipping && SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode)) &&
			(freeAdjustments.length > 0 || nestedBackdropAdjustmentDependency) &&
			!nestedBackdropMaskDependency &&
			!nestedBackdropMaskEffectsDependency &&
			!nestedBackdropMaskAdjustmentsDependency &&
			!nestedBackdropMaskEffectsAdjustmentsDependency &&
			!nestedBackdropEffectDependency &&
			!nestedBackdropEffectsAdjustmentsDependency &&
			freeAdjustments.every((child) => child.blendMode === "norm" && child.adjustment?.bakeSupported === true && adjustmentMaskIsSupported(child)) &&
			nested.some((candidate) => candidate.visible && document.layers[candidate.groupStartIndex].blendMode === "pass" && candidate.requiresParentBackdrop) &&
			nestedBackdropChildrenSupported &&
			!hasGroupMask &&
			(!applyLayerEffects || !hasGroupEffects);
		if (!passThrough && !SUPPORTED_CLIPPING_BLEND_MODES.has(group.blendMode)) {
			warnings.push(`Group blend mode ${group.blendMode} is outside bounded nested isolated-group compositing.`);
		}
		if (group.clipping) {
			warnings.push("Clipped group boundaries are not yet supported by bounded group compositing.");
		}
		if (!adjustmentMaskIsSupported(group)) {
			warnings.push("The group has an unsupported/missing raster mask channel or unbounded vector mask.");
		}
		if (
			passThrough &&
			group.opacity !== 255 &&
			!backdropOpacityExecution &&
			!backdropMaskExecution &&
			!backdropMaskEffectsExecution &&
			!backdropEffectsExecution &&
			!backdropAdjustmentsExecution &&
			!backdropBlendExecution &&
			!backdropBlendMaskExecution &&
			!backdropBlendEffectsExecution &&
			!backdropBlendBehindEffectsExecution &&
			!backdropBlendAdjustmentsExecution &&
			!parentBackdropExecution &&
			!parentBackdropBlendExecution &&
			!parentBackdropMaskExecution &&
			!parentBackdropMaskEffectsExecution &&
			!parentBackdropMaskAdjustmentsExecution &&
			!parentBackdropMaskEffectsAdjustmentsExecution &&
			!parentBackdropEffectsAdjustmentsExecution &&
			!parentBackdropEffectExecution &&
			!parentBackdropAdjustmentExecution &&
			!nestedBackdropExecution &&
			!nestedBackdropBlendExecution &&
			!nestedBackdropMaskExecution &&
			!nestedBackdropMaskEffectsExecution &&
			!nestedBackdropMaskAdjustmentsExecution &&
			!nestedBackdropMaskEffectsAdjustmentsExecution &&
			!nestedBackdropEffectsAdjustmentsExecution &&
			!nestedBackdropEffectExecution &&
			!nestedBackdropAdjustmentExecution
		) {
			warnings.push("Pass-through flattening requires full group opacity because reduced group opacity depends on an external backdrop.");
		}
		if (
			passThrough &&
			hasGroupMask &&
			!backdropMaskExecution &&
			!backdropMaskEffectsExecution &&
			!parentBackdropMaskExecution &&
			!parentBackdropMaskEffectsExecution &&
			!parentBackdropMaskAdjustmentsExecution &&
			!parentBackdropMaskEffectsAdjustmentsExecution &&
			!nestedBackdropMaskExecution &&
			!nestedBackdropMaskEffectsExecution &&
			!nestedBackdropMaskAdjustmentsExecution &&
			!nestedBackdropMaskEffectsAdjustmentsExecution
		) {
			warnings.push("Pass-through group masks are outside the backdrop-independent flattening model.");
		}
		if (
			passThrough &&
			applyLayerEffects &&
			hasGroupEffects &&
			!backdropEffectsExecution &&
			!backdropMaskEffectsExecution &&
			!parentBackdropMaskEffectsExecution &&
			!parentBackdropMaskAdjustmentsExecution &&
			!parentBackdropEffectExecution &&
			!nestedBackdropEffectExecution &&
			!nestedBackdropMaskEffectsExecution &&
			!nestedBackdropMaskAdjustmentsExecution &&
			!parentBackdropEffectsAdjustmentsExecution &&
			!parentBackdropMaskEffectsAdjustmentsExecution &&
			!nestedBackdropEffectsAdjustmentsExecution
		) {
			warnings.push("Pass-through group effects are outside the backdrop-independent flattening model.");
		}
		if (children.some((child) => child.visible && child.kind === "other")) {
			warnings.push("Visible smart-object or other non-raster children prevent bounded group compositing.");
		}
		if (children.some((child) => child.visible && child.kind === "pixel" && !SUPPORTED_CLIPPING_BLEND_MODES.has(child.blendMode))) {
			warnings.push("One or more visible pixel children use an unsupported group-composite blend mode.");
		}
		if (
			passThrough &&
			hasNonNormalChild &&
			!backdropBlendExecution &&
			!backdropBlendMaskExecution &&
			!backdropBlendEffectsExecution &&
			!backdropBlendBehindEffectsExecution &&
			!backdropBlendAdjustmentsExecution &&
			!parentBackdropBlendExecution &&
			!parentBackdropMaskExecution &&
			!parentBackdropMaskEffectsExecution &&
			!parentBackdropMaskAdjustmentsExecution &&
			!parentBackdropMaskEffectsAdjustmentsExecution &&
			!parentBackdropEffectsAdjustmentsExecution &&
			!parentBackdropEffectExecution &&
			!parentBackdropAdjustmentExecution &&
			!nestedBackdropBlendExecution &&
			!nestedBackdropMaskExecution &&
			!nestedBackdropMaskEffectsExecution &&
			!nestedBackdropMaskAdjustmentsExecution &&
			!nestedBackdropMaskEffectsAdjustmentsExecution &&
			!nestedBackdropEffectsAdjustmentsExecution &&
			!nestedBackdropEffectExecution &&
			!nestedBackdropAdjustmentExecution
		) {
			warnings.push("Pass-through flattening requires normal blend mode on every visible un-clipped pixel child so the result is backdrop-independent.");
		}
		if (
			passThrough &&
			applyLayerEffects &&
			hasGroupEffects &&
			hasNonNormalChild &&
			!backdropBlendEffectsExecution &&
			!backdropBlendBehindEffectsExecution &&
			!parentBackdropMaskEffectsExecution &&
			!parentBackdropMaskAdjustmentsExecution &&
			!parentBackdropEffectExecution &&
			!nestedBackdropEffectExecution &&
			!nestedBackdropMaskEffectsExecution &&
			!nestedBackdropMaskAdjustmentsExecution &&
			!parentBackdropEffectsAdjustmentsExecution &&
			!parentBackdropMaskEffectsAdjustmentsExecution &&
			!nestedBackdropEffectsAdjustmentsExecution
		) {
			warnings.push("Combining non-normal pass-through children with group effects currently requires only fully executable foreground/inside styles.");
		}
		if (
			children.some(
				(child) =>
					child.visible && child.kind === "adjustment" && (child.blendMode !== "norm" || child.adjustment?.bakeSupported !== true || !adjustmentMaskIsSupported(child))
			)
		) {
			warnings.push("One or more visible adjustment children exceed the bounded RGB/mask group-composite model.");
		}
		if (
			passThrough &&
			applyAdjustments &&
			freeAdjustments.length > 0 &&
			!backdropAdjustmentsExecution &&
			!parentBackdropAdjustmentExecution &&
			!nestedBackdropAdjustmentExecution &&
			!parentBackdropMaskEffectsExecution &&
			!nestedBackdropMaskEffectsExecution &&
			!parentBackdropMaskAdjustmentsExecution &&
			!parentBackdropMaskEffectsAdjustmentsExecution &&
			!nestedBackdropMaskAdjustmentsExecution &&
			!nestedBackdropMaskEffectsAdjustmentsExecution &&
			!parentBackdropEffectsAdjustmentsExecution &&
			!nestedBackdropEffectsAdjustmentsExecution
		) {
			warnings.push("Un-clipped adjustments inside a pass-through group can affect layers outside the group and cannot be flattened without that backdrop.");
		}
		if (children.some((child) => child.visible && child.kind === "pixel" && child.clipping && !clippedIndices.has(child.index))) {
			warnings.push("An orphan clipped pixel child prevents bounded isolated-group compositing.");
		}
		for (const nestedInfo of nested.filter((candidate) => candidate.visible && !candidate.supported && !candidate.requiresParentBackdrop)) {
			warnings.push(`Nested group ${nestedInfo.name} (${nestedInfo.groupStartIndex}) is not compositable: ${nestedInfo.warnings.join(" ")}`);
		}
		if (
			passThrough &&
			nested.some(
				(candidate) =>
					candidate.visible &&
					candidate.supported &&
					document.layers[candidate.groupStartIndex].blendMode !== "pass" &&
					document.layers[candidate.groupStartIndex].blendMode !== "norm"
			)
		) {
			warnings.push("An isolated child of a pass-through group must use normal blend mode so its flattened contribution is backdrop-independent.");
		}
		const maximumDepth = nested.length ? 1 + Math.max(...nested.map((candidate) => candidate.maximumDepth)) : 1;
		if (maximumDepth > MAXIMUM_GROUP_COMPOSITE_DEPTH) {
			warnings.push(`Nested isolated-group compositing is limited to ${MAXIMUM_GROUP_COMPOSITE_DEPTH} levels; this group reaches ${maximumDepth}.`);
		}
		const hasRasterBase = children.some((child) => child.visible && child.kind === "pixel" && !child.clipping);
		const hasNestedBase = nested.some((candidate) => candidate.visible && (candidate.supported || candidate.requiresParentBackdrop));
		if (!hasRasterBase && !hasNestedBase) {
			warnings.push("The isolated group has no visible raster or supported nested-group base to composite.");
		}
		const nestedGroupIndices = nested.flatMap((candidate) => [candidate.groupStartIndex, ...candidate.nestedGroupIndices]);
		const passThroughGroupIndices = [...(passThrough ? [pair.start] : []), ...nested.flatMap((candidate) => candidate.passThroughGroupIndices)];
		const requiresParentBackdrop =
			(parentBackdropExecution ||
				parentBackdropBlendExecution ||
				parentBackdropMaskExecution ||
				parentBackdropMaskEffectsExecution ||
				parentBackdropMaskAdjustmentsExecution ||
				parentBackdropMaskEffectsAdjustmentsExecution ||
				parentBackdropEffectsAdjustmentsExecution ||
				parentBackdropEffectExecution ||
				parentBackdropAdjustmentExecution) &&
			warnings.length === 0 &&
			(hasRasterBase || hasNestedBase) &&
			maximumDepth <= MAXIMUM_GROUP_COMPOSITE_DEPTH;
		const requiresParentBackdropBlend = parentBackdropBlendExecution && requiresParentBackdrop;
		const requiresParentBackdropMask = parentBackdropMaskExecution && requiresParentBackdrop;
		const requiresParentBackdropMaskEffects = parentBackdropMaskEffectsExecution && requiresParentBackdrop;
		const requiresParentBackdropMaskAdjustments = parentBackdropMaskAdjustmentsExecution && requiresParentBackdrop;
		const requiresParentBackdropMaskEffectsAdjustments = parentBackdropMaskEffectsAdjustmentsExecution && requiresParentBackdrop;
		const requiresParentBackdropEffectsAdjustments = parentBackdropEffectsAdjustmentsExecution && requiresParentBackdrop;
		const requiresParentBackdropEffect = parentBackdropEffectExecution && requiresParentBackdrop;
		const requiresParentBackdropAdjustment = parentBackdropAdjustmentExecution && requiresParentBackdrop;
		const info: IPsdGroupCompositeInfo = {
			groupStartIndex: pair.start,
			groupEndIndex: pair.end,
			name: group.name,
			visible: group.visible,
			blendMode: group.blendMode,
			executionModel:
				nestedBackdropMaskEffectsAdjustmentsExecution || requiresParentBackdropMaskEffectsAdjustments
					? "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1"
					: nestedBackdropMaskEffectsExecution || requiresParentBackdropMaskEffects
						? "bounded-nested-backdrop-pass-through-mask-effects-v1"
						: nestedBackdropMaskAdjustmentsExecution || requiresParentBackdropMaskAdjustments
							? "bounded-nested-backdrop-pass-through-mask-adjustments-v1"
							: nestedBackdropEffectsAdjustmentsExecution || requiresParentBackdropEffectsAdjustments
								? "bounded-nested-backdrop-pass-through-effects-adjustments-v1"
								: nestedBackdropAdjustmentExecution || requiresParentBackdropAdjustment
									? "bounded-nested-backdrop-pass-through-adjustments-v1"
									: nestedBackdropEffectExecution || requiresParentBackdropEffect
										? "bounded-nested-backdrop-pass-through-effects-v1"
										: nestedBackdropMaskExecution || requiresParentBackdropMask
											? "bounded-nested-backdrop-pass-through-mask-v1"
											: nestedBackdropBlendExecution || requiresParentBackdropBlend
												? "bounded-nested-backdrop-pass-through-blends-v1"
												: nestedBackdropExecution || requiresParentBackdrop
													? "bounded-nested-backdrop-pass-through-v1"
													: backdropBlendMaskExecution
														? "bounded-backdrop-pass-through-blends-mask-v1"
														: backdropBlendEffectsExecution
															? "bounded-backdrop-pass-through-blends-effects-v1"
															: backdropBlendBehindEffectsExecution
																? "bounded-backdrop-pass-through-blends-effects-behind-v1"
																: backdropBlendAdjustmentsExecution
																	? "bounded-backdrop-pass-through-blends-adjustments-v1"
																	: backdropMaskEffectsExecution
																		? "bounded-backdrop-pass-through-mask-effects-v1"
																		: backdropMaskExecution
																			? "bounded-backdrop-pass-through-mask-v1"
																			: backdropAdjustmentsExecution
																				? "bounded-backdrop-pass-through-adjustments-v1"
																				: backdropBlendExecution
																					? "bounded-backdrop-pass-through-blends-v1"
																					: backdropEffectsExecution
																						? "bounded-backdrop-pass-through-effects-v1"
																						: backdropOpacityExecution
																							? "bounded-backdrop-pass-through-opacity-v1"
																							: knockoutExecution
																								? "bounded-knockout-group-v1"
																								: passThrough
																									? "bounded-pass-through-flatten-v1"
																									: maximumDepth > 1
																										? "bounded-nested-isolated-group-v1"
																										: "bounded-isolated-group-v1",
			supported: warnings.length === 0 && !requiresParentBackdrop,
			requiresParentBackdrop,
			groupOpacity: group.opacity,
			backdropLayerIndices:
				backdropOpacityExecution ||
				knockoutExecution ||
				backdropMaskExecution ||
				backdropMaskEffectsExecution ||
				backdropEffectsExecution ||
				backdropAdjustmentsExecution ||
				backdropBlendExecution ||
				backdropBlendMaskExecution ||
				backdropBlendEffectsExecution ||
				backdropBlendBehindEffectsExecution ||
				backdropBlendAdjustmentsExecution ||
				nestedBackdropExecution ||
				nestedBackdropBlendExecution ||
				nestedBackdropMaskExecution ||
				nestedBackdropMaskEffectsExecution ||
				nestedBackdropMaskAdjustmentsExecution ||
				nestedBackdropMaskEffectsAdjustmentsExecution ||
				nestedBackdropEffectsAdjustmentsExecution ||
				nestedBackdropEffectExecution ||
				nestedBackdropAdjustmentExecution
					? backdropLayers.map((candidate) => candidate.index)
					: [],
			backdropBlendModes:
				backdropOpacityExecution ||
				knockoutExecution ||
				backdropMaskExecution ||
				backdropMaskEffectsExecution ||
				backdropEffectsExecution ||
				backdropAdjustmentsExecution ||
				backdropBlendExecution ||
				backdropBlendMaskExecution ||
				backdropBlendEffectsExecution ||
				backdropBlendBehindEffectsExecution ||
				backdropBlendAdjustmentsExecution ||
				nestedBackdropExecution ||
				nestedBackdropBlendExecution ||
				nestedBackdropMaskExecution ||
				nestedBackdropMaskEffectsExecution ||
				nestedBackdropMaskAdjustmentsExecution ||
				nestedBackdropMaskEffectsAdjustmentsExecution ||
				nestedBackdropEffectsAdjustmentsExecution ||
				nestedBackdropEffectExecution ||
				nestedBackdropAdjustmentExecution
					? backdropLayers.map((candidate) => candidate.blendMode)
					: [],
			backdropIncluded:
				backdropOpacityExecution ||
				knockoutExecution ||
				backdropMaskExecution ||
				backdropMaskEffectsExecution ||
				backdropEffectsExecution ||
				backdropAdjustmentsExecution ||
				backdropBlendExecution ||
				backdropBlendMaskExecution ||
				backdropBlendEffectsExecution ||
				backdropBlendBehindEffectsExecution ||
				backdropBlendAdjustmentsExecution ||
				nestedBackdropExecution ||
				nestedBackdropBlendExecution ||
				nestedBackdropMaskExecution ||
				nestedBackdropMaskEffectsExecution ||
				nestedBackdropMaskAdjustmentsExecution ||
				nestedBackdropMaskEffectsAdjustmentsExecution ||
				nestedBackdropEffectsAdjustmentsExecution ||
				nestedBackdropEffectExecution ||
				nestedBackdropAdjustmentExecution,
			childLayerIndices: document.layers.slice(pair.end + 1, pair.start).map((child) => child.index),
			directChildLayerIndices: children.map((child) => child.index),
			nestedGroupIndices,
			passThroughGroupIndices,
			maximumDepth,
			warnings,
		};
		cache.set(pair.start, info);
		return info;
	};
	return pairs.sort((left, right) => left.start - right.start).map(inspect);
}

function compositeLayerOver(backdropLayer: IDecodedPsdLayer | null, sourceLayer: IDecodedPsdLayer): IDecodedPsdLayer {
	const left = backdropLayer ? Math.min(backdropLayer.left, sourceLayer.left) : sourceLayer.left;
	const top = backdropLayer ? Math.min(backdropLayer.top, sourceLayer.top) : sourceLayer.top;
	const right = backdropLayer ? Math.max(backdropLayer.right, sourceLayer.right) : sourceLayer.right;
	const bottom = backdropLayer ? Math.max(backdropLayer.bottom, sourceLayer.bottom) : sourceLayer.bottom;
	const width = right - left;
	const height = bottom - top;
	if (width <= 0 || height <= 0 || width * height > MAXIMUM_EFFECT_BAKE_PIXELS) {
		throw new Error(`Bounded isolated-group output is limited to ${MAXIMUM_EFFECT_BAKE_PIXELS.toLocaleString()} pixels.`);
	}
	const output = new Uint8Array(width * height * 4);
	const restrictedChannels = restrictedRgbChannelIndices(sourceLayer);
	if (backdropLayer) {
		for (let y = 0; y < backdropLayer.height; ++y) {
			for (let x = 0; x < backdropLayer.width; ++x) {
				const sourceOffset = (y * backdropLayer.width + x) * 4;
				const destinationOffset = ((backdropLayer.top - top + y) * width + backdropLayer.left - left + x) * 4;
				output.set(backdropLayer.pixels.subarray(sourceOffset, sourceOffset + 4), destinationOffset);
			}
		}
	}
	for (let y = 0; y < sourceLayer.height; ++y) {
		for (let x = 0; x < sourceLayer.width; ++x) {
			const sourceOffset = (y * sourceLayer.width + x) * 4;
			const destinationOffset = ((sourceLayer.top - top + y) * width + sourceLayer.left - left + x) * 4;
			const sourceAlpha = (sourceLayer.pixels[sourceOffset + 3] / 255) * (sourceLayer.opacity / 255);
			if (sourceAlpha <= 0) {
				continue;
			}
			const backdropAlpha = output[destinationOffset + 3] / 255;
			const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
			const backdrop = [output[destinationOffset] / 255, output[destinationOffset + 1] / 255, output[destinationOffset + 2] / 255] satisfies Rgb;
			const source = [sourceLayer.pixels[sourceOffset] / 255, sourceLayer.pixels[sourceOffset + 1] / 255, sourceLayer.pixels[sourceOffset + 2] / 255] satisfies Rgb;
			const blended = blendColor(sourceLayer.blendMode, backdrop, source);
			for (let channel = 0; channel < 3; ++channel) {
				if (!restrictedChannels.has(channel)) {
					const premultiplied =
						(1 - sourceAlpha) * backdrop[channel] * backdropAlpha +
						(1 - backdropAlpha) * source[channel] * sourceAlpha +
						backdropAlpha * sourceAlpha * blended[channel];
					output[destinationOffset + channel] = clampByte(outputAlpha > 0 ? premultiplied / outputAlpha : 0);
				}
			}
			output[destinationOffset + 3] = clampByte(outputAlpha);
		}
	}
	return {
		...(backdropLayer ?? sourceLayer),
		left,
		top,
		right,
		bottom,
		width,
		height,
		opacity: 255,
		blendMode: "norm",
		pixels: output,
	};
}

function interpolatePassThroughGroupOpacity(
	backdrop: IDecodedPsdLayer,
	fullComposite: IDecodedPsdLayer,
	opacity: number,
	maskCoverage?: Uint8Array,
	channelBlendingRestrictions?: IPsdLayerInfo["channelBlendingRestrictions"]
): IDecodedPsdLayer {
	if (maskCoverage && maskCoverage.length !== fullComposite.width * fullComposite.height) {
		throw new Error("PSD pass-through group mask coverage does not match the bounded backdrop composite.");
	}
	const output = new Uint8Array(fullComposite.pixels.length);
	const restrictedChannels = restrictedRgbChannelIndices({ channelBlendingRestrictions });
	for (let y = 0; y < fullComposite.height; ++y) {
		for (let x = 0; x < fullComposite.width; ++x) {
			const outputOffset = (y * fullComposite.width + x) * 4;
			const amount = (opacity / 255) * ((maskCoverage?.[y * fullComposite.width + x] ?? 255) / 255);
			const backdropX = fullComposite.left + x - backdrop.left;
			const backdropY = fullComposite.top + y - backdrop.top;
			const backdropInside = backdropX >= 0 && backdropY >= 0 && backdropX < backdrop.width && backdropY < backdrop.height;
			const backdropOffset = backdropInside ? (backdropY * backdrop.width + backdropX) * 4 : -1;
			const backdropAlpha = backdropOffset >= 0 ? backdrop.pixels[backdropOffset + 3] / 255 : 0;
			const compositeAlpha = fullComposite.pixels[outputOffset + 3] / 255;
			const outputAlpha = backdropAlpha + amount * (compositeAlpha - backdropAlpha);
			for (let channel = 0; channel < 3; ++channel) {
				if (restrictedChannels.has(channel)) {
					output[outputOffset + channel] = backdropOffset >= 0 ? backdrop.pixels[backdropOffset + channel] : 0;
					continue;
				}
				const backdropPremultiplied = backdropOffset >= 0 ? (backdrop.pixels[backdropOffset + channel] / 255) * backdropAlpha : 0;
				const compositePremultiplied = (fullComposite.pixels[outputOffset + channel] / 255) * compositeAlpha;
				const outputPremultiplied = backdropPremultiplied + amount * (compositePremultiplied - backdropPremultiplied);
				output[outputOffset + channel] = clampByte(outputAlpha > 0 ? outputPremultiplied / outputAlpha : 0);
			}
			output[outputOffset + 3] = clampByte(outputAlpha);
		}
	}
	return { ...fullComposite, opacity: 255, blendMode: "norm", pixels: output };
}

function applyPsdKnockout(current: IDecodedPsdLayer, destination: IDecodedPsdLayer | null, shape: IDecodedPsdLayer): IDecodedPsdLayer {
	const output = current.pixels.slice();
	const fillAmount = shape.fillOpacity / 255;
	const layerAmount = shape.opacity / 255;
	for (let y = 0; y < shape.height; ++y) {
		const currentY = shape.top + y - current.top;
		if (currentY < 0 || currentY >= current.height) {
			continue;
		}
		for (let x = 0; x < shape.width; ++x) {
			const currentX = shape.left + x - current.left;
			if (currentX < 0 || currentX >= current.width) {
				continue;
			}
			const shapeOffset = (y * shape.width + x) * 4;
			const amount = (shape.pixels[shapeOffset + 3] / 255) * layerAmount * (1 - fillAmount);
			if (amount <= 0) {
				continue;
			}
			const outputOffset = (currentY * current.width + currentX) * 4;
			const destinationX = shape.left + x - (destination?.left ?? 0);
			const destinationY = shape.top + y - (destination?.top ?? 0);
			const destinationInside = Boolean(destination && destinationX >= 0 && destinationY >= 0 && destinationX < destination.width && destinationY < destination.height);
			const destinationOffset = destinationInside && destination ? (destinationY * destination.width + destinationX) * 4 : -1;
			const currentAlpha = output[outputOffset + 3] / 255;
			const destinationAlpha = destinationOffset >= 0 && destination ? destination.pixels[destinationOffset + 3] / 255 : 0;
			const outputAlpha = currentAlpha + amount * (destinationAlpha - currentAlpha);
			for (let channel = 0; channel < 3; ++channel) {
				const currentPremultiplied = (output[outputOffset + channel] / 255) * currentAlpha;
				const destinationPremultiplied = destinationOffset >= 0 && destination ? (destination.pixels[destinationOffset + channel] / 255) * destinationAlpha : 0;
				const outputPremultiplied = currentPremultiplied + amount * (destinationPremultiplied - currentPremultiplied);
				output[outputOffset + channel] = clampByte(outputAlpha > 0 ? outputPremultiplied / outputAlpha : 0);
			}
			output[outputOffset + 3] = clampByte(outputAlpha);
		}
	}
	return { ...current, pixels: output };
}

function compositeLayerWithInteriorEffectBlending(
	backdrop: IDecodedPsdLayer,
	source: IDecodedPsdLayer,
	document: IPsdLayerDocumentInfo,
	patterns: Map<number, IDecodedPsdPattern>
): {
	layer: IDecodedPsdLayer;
	applied: IPsdAppliedLayerEffect[];
	evidence: IPsdLayerExtractionItem["appliedInteriorEffectBlending"][number] | null;
} {
	const grouped = source.advancedBlending.blendInteriorEffectsAsGroup;
	if (grouped === null) {
		throw new Error(`PSD layer ${source.name} (${source.index}) has no explicit infx advanced-blending flag.`);
	}
	const effectShape = source;
	const content = applyPsdFillOpacity(source);
	const behindBase: IDecodedPsdLayer = {
		...content,
		left: backdrop.left,
		top: backdrop.top,
		right: backdrop.right,
		bottom: backdrop.bottom,
		width: backdrop.width,
		height: backdrop.height,
		opacity: 255,
		blendMode: "norm",
		pixels: backdrop.pixels,
	};
	const behindFull = bakeLayerEffects(behindBase, document, patterns, effectShape, "behind");
	const behind = interpolatePassThroughGroupOpacity(backdrop, behindFull.layer, source.opacity, undefined, source.channelBlendingRestrictions);
	let layer: IDecodedPsdLayer;
	let foreground: ReturnType<typeof bakeLayerEffects>;
	if (grouped) {
		foreground = bakeLayerEffects(content, document, patterns, effectShape, "foreground");
		layer = compositeLayerOver(behind, foreground.layer);
	} else {
		const blendedLayer = compositeLayerOver(behind, content);
		const foregroundBase: IDecodedPsdLayer = {
			...content,
			left: blendedLayer.left,
			top: blendedLayer.top,
			right: blendedLayer.right,
			bottom: blendedLayer.bottom,
			width: blendedLayer.width,
			height: blendedLayer.height,
			opacity: 255,
			blendMode: "norm",
			pixels: blendedLayer.pixels,
		};
		foreground = bakeLayerEffects(foregroundBase, document, patterns, effectShape, "foreground");
		layer = interpolatePassThroughGroupOpacity(blendedLayer, foreground.layer, source.opacity, undefined, source.channelBlendingRestrictions);
	}
	const interiorEffectTypes = [...new Set(foreground.applied.map((effect) => effect.type))];
	return {
		layer,
		applied: [...behindFull.applied, ...foreground.applied],
		evidence: interiorEffectTypes.length
			? {
					layerIndex: source.index,
					layerId: source.id,
					name: source.name,
					sourceKey: "infx",
					blendInteriorEffectsAsGroup: grouped,
					layerBlendMode: source.blendMode,
					application: grouped ? "interior-effects-then-layer-blend" : "layer-blend-then-interior-effects",
					interiorEffectTypes,
					executionModel: "bounded-blend-interior-effects-as-group-v1",
				}
			: null,
	};
}

function renderPassThroughBackdrop(info: IPsdGroupCompositeInfo, decodedByIndex: Map<number, IDecodedPsdLayer>): IDecodedPsdLayer {
	let backdrop: IDecodedPsdLayer | null = null;
	for (const layerIndex of [...info.backdropLayerIndices].sort((left, right) => right - left)) {
		const layer = decodedByIndex.get(layerIndex);
		if (!layer) {
			throw new Error(`PSD pass-through backdrop layer ${layerIndex} passed inspection but did not decode.`);
		}
		backdrop = compositeLayerOver(backdrop, layer);
	}
	if (!backdrop) {
		throw new Error("PSD reduced-opacity pass-through group passed inspection without a bounded external backdrop.");
	}
	return backdrop;
}

function adjustmentMaskIsSupported(candidate: IPsdLayerInfo): boolean {
	const primarySupported = !candidate.mask || candidate.mask.disabled || candidate.channels.some((channel) => channel.id === -2);
	const realUserSupported = !candidate.mask?.realUserMask || candidate.mask.realUserMask.disabled || candidate.channels.some((channel) => channel.id === -3);
	const vectorSupported = !candidate.vectorMask || candidate.vectorMask.disabled || candidate.vectorMask.bakeSupported;
	return primarySupported && realUserSupported && vectorSupported;
}

function hasEnabledLayerEffects(candidate: IPsdLayerInfo): boolean {
	if (!candidate.effects?.visible) {
		return false;
	}
	return [
		...candidate.effects.solidFills,
		...candidate.effects.innerShadows,
		...candidate.effects.innerGlows,
		...candidate.effects.dropShadows,
		...candidate.effects.outerGlows,
		...candidate.effects.bevels,
		...candidate.effects.satins,
		...candidate.effects.strokes,
		...candidate.effects.gradientOverlays,
		...candidate.effects.patternOverlays,
	].some((effect) => effect.enabled);
}

function enabledLayerEffectsAreBakeSupported(candidate: IPsdLayerInfo): boolean {
	if (!candidate.effects?.visible) {
		return true;
	}
	return [
		...candidate.effects.solidFills,
		...candidate.effects.innerShadows,
		...candidate.effects.innerGlows,
		...candidate.effects.dropShadows,
		...candidate.effects.outerGlows,
		...candidate.effects.bevels,
		...candidate.effects.satins,
		...candidate.effects.strokes,
		...candidate.effects.gradientOverlays,
		...candidate.effects.patternOverlays,
	].every((effect) => !effect.enabled || effect.bakeSupported);
}

function enabledLayerEffectsAreBackdropForegroundSafe(candidate: IPsdLayerInfo): boolean {
	if (!candidate.effects?.visible) {
		return true;
	}
	return (
		candidate.effects.dropShadows.every((effect) => !effect.enabled) &&
		candidate.effects.outerGlows.every((effect) => !effect.enabled) &&
		candidate.effects.strokes.every((effect) => !effect.enabled || effect.position === "inside") &&
		candidate.effects.bevels.every((effect) => !effect.enabled || effect.style === 2)
	);
}

function crossedPassThroughGroups(document: IPsdLayerDocumentInfo, adjustmentIndex: number, baseIndex: number, scopes: Map<number, number[]>): number[] | null {
	const adjustmentScope = scopes.get(adjustmentIndex) ?? [];
	const baseScope = scopes.get(baseIndex) ?? [];
	if (adjustmentScope.some((groupIndex, index) => baseScope[index] !== groupIndex)) {
		return null;
	}
	const crossed = baseScope.slice(adjustmentScope.length);
	return crossed.every((groupIndex) => document.layers[groupIndex]?.kind === "groupStart" && document.layers[groupIndex].blendMode === "pass") ? crossed : null;
}

function applicableAdjustments(document: IPsdLayerDocumentInfo, baseIndex: number, groups: Map<number, number[]>, scopes: Map<number, number[]>): IPsdLayerInfo[] {
	const clipped = new Set(groups.get(baseIndex) ?? []);
	return document.layers.filter(
		(candidate) =>
			candidate.index < baseIndex &&
			candidate.kind === "adjustment" &&
			candidate.visible &&
			candidate.adjustment?.bakeSupported === true &&
			candidate.blendMode === "norm" &&
			adjustmentMaskIsSupported(candidate) &&
			crossedPassThroughGroups(document, candidate.index, baseIndex, scopes) !== null &&
			(!candidate.clipping || clipped.has(candidate.index))
	);
}

interface IRenderIsolatedGroupContext {
	source: Buffer;
	document: IPsdLayerDocumentInfo;
	info: IPsdGroupCompositeInfo;
	groupByStart: Map<number, IPsdGroupCompositeInfo>;
	decodedByIndex: Map<number, IDecodedPsdLayer>;
	decodedPatterns: Map<number, IDecodedPsdPattern>;
	clipping: Map<number, number[]>;
	scopes: Map<number, number[]>;
	includeHidden: boolean;
	applyLayerEffects: boolean;
	applyGroupEffects?: boolean;
	applyAdjustments: boolean;
	compositeClippingGroups: boolean;
	applyExternalAdjustments: boolean;
	initialCanvas?: IDecodedPsdLayer;
	shallowKnockoutLayerIndices?: number[];
	deepKnockoutCanvas?: IDecodedPsdLayer | null;
	deepKnockoutLayerIndices?: number[];
	shapeOnly?: boolean;
}

interface IRenderedIsolatedGroup {
	layer: IDecodedPsdLayer;
	appliedAdjustments: IPsdLayerExtractionItem["appliedAdjustments"];
	appliedLayerEffects: IPsdAppliedLayerEffect[];
	appliedInteriorEffectBlending: IPsdLayerExtractionItem["appliedInteriorEffectBlending"];
	appliedClippedLayerBlending: IPsdLayerExtractionItem["appliedClippedLayerBlending"];
	appliedTransparencyShaping: IPsdLayerExtractionItem["appliedTransparencyShaping"];
	appliedKnockouts: IPsdLayerExtractionItem["appliedKnockouts"];
	appliedGroupMasks: IPsdLayerExtractionItem["appliedGroupMasks"];
	childLayerIndices: number[];
	childLayerNames: string[];
	blendModes: string[];
	nestedGroupIndices: number[];
	passThroughGroupIndices: number[];
	backdropLayerIndices: number[];
	backdropBlendModes: string[];
	backdropIncluded: boolean;
	maximumDepth: number;
	warnings: string[];
}

function applyGroupMasksWithEvidence(source: Buffer, target: IDecodedPsdLayer, group: IPsdLayerInfo, applied: IPsdLayerExtractionItem["appliedGroupMasks"]): IDecodedPsdLayer {
	if ((!group.mask || group.mask.disabled) && (!group.vectorMask || group.vectorMask.disabled)) {
		return target;
	}
	const mask = decodePsdLayerMasks(source, [group.index], {
		left: target.left,
		top: target.top,
		width: target.width,
		height: target.height,
	})[0];
	if (!mask) {
		throw new Error(`PSD group ${group.name} (${group.index}) passed mask inspection but produced no bounded mask coverage.`);
	}
	const pixels = new Uint8Array(target.pixels);
	let maskCoverageMinimum = 255;
	let maskCoverageMaximum = 0;
	for (let pixel = 0; pixel < mask.coverage.length; ++pixel) {
		const coverage = mask.coverage[pixel];
		maskCoverageMinimum = Math.min(maskCoverageMinimum, coverage);
		maskCoverageMaximum = Math.max(maskCoverageMaximum, coverage);
		pixels[pixel * 4 + 3] = Math.round((pixels[pixel * 4 + 3] * coverage) / 255);
	}
	applied.push({
		groupIndex: group.index,
		groupId: group.id,
		name: group.name,
		executionModel: "bounded-group-mask-v1",
		application: "isolated-alpha",
		maskCoverageMinimum,
		maskCoverageMaximum,
	});
	return { ...target, pixels };
}

function applyGlobalLayerStyleMask(
	source: Buffer,
	target: IDecodedPsdLayer,
	layer: IPsdLayerInfo
): { layer: IDecodedPsdLayer; evidence: IPsdLayerExtractionItem["appliedLayerStyleMask"] } {
	if (
		layer.advancedBlending.layerMaskAsGlobalMask !== true ||
		!layer.channels.some(
			(channel) => (channel.id === -2 && layer.mask && !layer.mask.disabled) || (channel.id === -3 && layer.mask?.realUserMask && !layer.mask.realUserMask.disabled)
		)
	) {
		return { layer: target, evidence: null };
	}
	const mask = decodePsdLayerMasks(
		source,
		[layer.index],
		{ left: target.left, top: target.top, width: target.width, height: target.height },
		{ includeRaster: true, includeVector: false }
	)[0];
	if (!mask) {
		throw new Error(`PSD layer ${layer.name} (${layer.index}) declares lmgm but produced no bounded raster layer-mask coverage.`);
	}
	const pixels = target.pixels.slice();
	for (let pixel = 0; pixel < mask.coverage.length; ++pixel) {
		pixels[pixel * 4 + 3] = Math.round((pixels[pixel * 4 + 3] * mask.coverage[pixel]) / 255);
	}
	return {
		layer: { ...target, pixels },
		evidence: {
			sourceKey: "lmgm",
			layerMaskAsGlobalMask: true,
			application: "final-layer-and-effects-crossfade",
			maskCoverageMinimum: mask.coverage.reduce((minimum, value) => Math.min(minimum, value), 255),
			maskCoverageMaximum: mask.coverage.reduce((maximum, value) => Math.max(maximum, value), 0),
			executionModel: "bounded-layer-mask-hides-effects-v1",
		},
	};
}

function applyGlobalVectorStyleMask(
	source: Buffer,
	target: IDecodedPsdLayer,
	layer: IPsdLayerInfo
): { layer: IDecodedPsdLayer; evidence: IPsdLayerExtractionItem["appliedVectorStyleMask"] } {
	if (layer.advancedBlending.vectorMaskAsGlobalMask !== true || !layer.vectorMask || !layer.vectorMask.bakeSupported) {
		return { layer: target, evidence: null };
	}
	const mask = decodePsdLayerMasks(
		source,
		[layer.index],
		{ left: target.left, top: target.top, width: target.width, height: target.height },
		{ includeRaster: false, includeVector: true }
	)[0];
	if (!mask) {
		throw new Error(`PSD layer ${layer.name} (${layer.index}) declares vmgm but produced no bounded vector-mask coverage.`);
	}
	const pixels = target.pixels.slice();
	for (let pixel = 0; pixel < mask.coverage.length; ++pixel) {
		pixels[pixel * 4 + 3] = Math.round((pixels[pixel * 4 + 3] * mask.coverage[pixel]) / 255);
	}
	return {
		layer: { ...target, pixels },
		evidence: {
			sourceKey: "vmgm",
			vectorMaskAsGlobalMask: true,
			application: "final-layer-and-effects-crossfade",
			maskCoverageMinimum: mask.coverage.reduce((minimum, value) => Math.min(minimum, value), 255),
			maskCoverageMaximum: mask.coverage.reduce((maximum, value) => Math.max(maximum, value), 0),
			executionModel: "bounded-vector-mask-hides-effects-v1",
		},
	};
}

function applyAdjustmentWithEvidence(
	source: Buffer,
	target: IDecodedPsdLayer,
	adjustmentLayer: IPsdLayerInfo,
	applied: IPsdLayerExtractionItem["appliedAdjustments"],
	crossedGroups: number[] = []
): IDecodedPsdLayer {
	if (!adjustmentLayer.adjustment) {
		return target;
	}
	const mask = decodePsdAdjustmentMasks(source, [adjustmentLayer.index], {
		left: target.left,
		top: target.top,
		width: target.width,
		height: target.height,
	})[0];
	applied.push({
		layerIndex: adjustmentLayer.index,
		layerId: adjustmentLayer.id,
		name: adjustmentLayer.name,
		key: adjustmentLayer.adjustment.key,
		opacity: adjustmentLayer.opacity,
		clipping: adjustmentLayer.clipping,
		settings: adjustmentLayer.adjustment,
		executionModel: adjustmentLayer.adjustment.executionModel,
		maskExecutionModel: mask?.executionModel ?? null,
		maskCoverageMinimum: mask ? mask.coverage.reduce((minimum, value) => Math.min(minimum, value), 255) : null,
		maskCoverageMaximum: mask ? mask.coverage.reduce((maximum, value) => Math.max(maximum, value), 0) : null,
		groupExecutionModel: crossedGroups.length ? "bounded-pass-through-groups-v1" : null,
		crossedGroupIndices: crossedGroups,
	});
	return { ...target, pixels: applyPsdLayerAdjustment(target.pixels, adjustmentLayer.adjustment, adjustmentLayer.opacity, mask?.coverage) };
}

function renderIsolatedGroup(context: IRenderIsolatedGroupContext): IRenderedIsolatedGroup {
	const group = context.document.layers[context.info.groupStartIndex];
	let canvas: IDecodedPsdLayer | null = context.initialCanvas ?? null;
	const appliedAdjustments: IPsdLayerExtractionItem["appliedAdjustments"] = [];
	const appliedLayerEffects: IPsdAppliedLayerEffect[] = [];
	const appliedInteriorEffectBlending: IPsdLayerExtractionItem["appliedInteriorEffectBlending"] = [];
	const appliedClippedLayerBlending: IPsdLayerExtractionItem["appliedClippedLayerBlending"] = [];
	const appliedTransparencyShaping: IPsdLayerExtractionItem["appliedTransparencyShaping"] = [];
	const appliedKnockouts: IPsdLayerExtractionItem["appliedKnockouts"] = [];
	const appliedGroupMasks: IPsdLayerExtractionItem["appliedGroupMasks"] = [];
	const warnings: string[] = [];
	const childLayerIndices: number[] = [];
	const childLayerNames: string[] = [];
	const blendModes: string[] = [];
	const nestedGroupIndices: number[] = [];
	const passThroughGroupIndices: number[] = group.blendMode === "pass" ? [group.index] : [];
	const consumedClipping = new Set(
		[...context.clipping.entries()]
			.filter(([baseIndex]) => baseIndex > context.info.groupEndIndex && baseIndex < context.info.groupStartIndex)
			.flatMap(([, indices]) => indices)
	);
	for (let index = context.info.groupStartIndex - 1; index > context.info.groupEndIndex; --index) {
		const child = context.document.layers[index];
		if (child.kind === "groupStart") {
			const nestedInfo = context.groupByStart.get(child.index);
			if (!nestedInfo || nestedInfo.groupEndIndex <= context.info.groupEndIndex) {
				throw new Error(`PSD nested group ${child.index} passed inspection without a contained group boundary.`);
			}
			index = nestedInfo.groupEndIndex;
			if (!child.visible && !context.includeHidden) {
				continue;
			}
			if (!nestedInfo.supported && !nestedInfo.requiresParentBackdrop) {
				throw new Error(`PSD nested group ${child.name} (${child.index}) passed parent inspection but is not compositable.`);
			}
			const parentBackdrop = nestedInfo.requiresParentBackdrop && !context.shapeOnly ? canvas : null;
			const interiorGroupBackdrop =
				!nestedInfo.requiresParentBackdrop &&
				child.blendMode !== "pass" &&
				!context.shapeOnly &&
				canvas &&
				context.applyLayerEffects &&
				child.advancedBlending.blendInteriorEffectsAsGroup !== null &&
				hasEnabledLayerEffects(child)
					? canvas
					: null;
			if (
				interiorGroupBackdrop &&
				((child.mask && !child.mask.disabled) ||
					(child.vectorMask && !child.vectorMask.disabled) ||
					child.advancedBlending.layerMaskAsGlobalMask ||
					child.advancedBlending.vectorMaskAsGlobalMask)
			) {
				throw new Error(
					`PSD group ${child.name} (${child.index}) combines infx with a group mask; exact group-level advanced-style mask ordering requires the combined boundary model.`
				);
			}
			if (nestedInfo.requiresParentBackdrop && !parentBackdrop && !context.shapeOnly) {
				throw new Error(`PSD nested pass-through group ${child.name} (${child.index}) requires a bounded parent canvas backdrop.`);
			}
			const nested =
				parentBackdrop &&
				(nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
					nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
					nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
					nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1")
					? renderBackdropDependentGroupEffects(
							{
								...context,
								info: nestedInfo,
								applyExternalAdjustments: false,
								applyGroupEffects: false,
								initialCanvas: parentBackdrop,
							},
							parentBackdrop
						)
					: renderIsolatedGroup({
							...context,
							info: nestedInfo,
							applyExternalAdjustments: false,
							applyGroupEffects: interiorGroupBackdrop ? false : context.applyGroupEffects,
							initialCanvas: parentBackdrop ?? undefined,
						});
			if (interiorGroupBackdrop) {
				const composited = compositeLayerWithInteriorEffectBlending(interiorGroupBackdrop, nested.layer, context.document, context.decodedPatterns);
				nested.layer = composited.layer;
				nested.appliedLayerEffects.push(...composited.applied);
				if (composited.evidence) {
					nested.appliedInteriorEffectBlending.push(composited.evidence);
				}
				canvas = nested.layer;
			} else if (parentBackdrop) {
				let maskCoverage: Uint8Array | undefined;
				if (
					(nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
						nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
						nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
						nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1") &&
					((child.mask && !child.mask.disabled) || (child.vectorMask && !child.vectorMask.disabled))
				) {
					const mask = decodePsdLayerMasks(context.source, [child.index], {
						left: nested.layer.left,
						top: nested.layer.top,
						width: nested.layer.width,
						height: nested.layer.height,
					})[0];
					if (!mask) {
						throw new Error(`PSD nested pass-through group ${child.name} (${child.index}) passed mask inspection but produced no bounded backdrop mask coverage.`);
					}
					maskCoverage = mask.coverage;
					nested.appliedGroupMasks.push({
						groupIndex: child.index,
						groupId: child.id,
						name: child.name,
						executionModel: nestedInfo.executionModel,
						application: "backdrop-interpolation",
						maskCoverageMinimum: mask.coverage.reduce((minimum, value) => Math.min(minimum, value), 255),
						maskCoverageMaximum: mask.coverage.reduce((maximum, value) => Math.max(maximum, value), 0),
					});
				}
				nested.layer = interpolatePassThroughGroupOpacity(parentBackdrop, nested.layer, nestedInfo.groupOpacity, maskCoverage, child.channelBlendingRestrictions);
				nested.backdropIncluded = true;
				canvas = nested.layer;
			} else if (context.shapeOnly && nestedInfo.requiresParentBackdrop) {
				const transparentBackdrop: IDecodedPsdLayer = { ...nested.layer, opacity: 255, blendMode: "norm", pixels: new Uint8Array(nested.layer.pixels.length) };
				let shapeMaskCoverage: Uint8Array | undefined;
				if (
					(nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
						nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
						nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
						nestedInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1") &&
					((child.mask && !child.mask.disabled) || (child.vectorMask && !child.vectorMask.disabled))
				) {
					shapeMaskCoverage = decodePsdLayerMasks(context.source, [child.index], {
						left: nested.layer.left,
						top: nested.layer.top,
						width: nested.layer.width,
						height: nested.layer.height,
					})[0]?.coverage;
				}
				nested.layer = interpolatePassThroughGroupOpacity(transparentBackdrop, nested.layer, nestedInfo.groupOpacity, shapeMaskCoverage, child.channelBlendingRestrictions);
				canvas = compositeLayerOver(canvas, nested.layer);
			} else {
				canvas = compositeLayerOver(canvas, nested.layer);
			}
			appliedAdjustments.push(...nested.appliedAdjustments);
			appliedLayerEffects.push(...nested.appliedLayerEffects);
			appliedInteriorEffectBlending.push(...nested.appliedInteriorEffectBlending);
			appliedClippedLayerBlending.push(...nested.appliedClippedLayerBlending);
			appliedTransparencyShaping.push(...nested.appliedTransparencyShaping);
			appliedKnockouts.push(...nested.appliedKnockouts);
			appliedGroupMasks.push(...nested.appliedGroupMasks);
			childLayerIndices.push(child.index);
			childLayerNames.push(child.name);
			blendModes.push(child.blendMode);
			nestedGroupIndices.push(child.index, ...nested.nestedGroupIndices);
			passThroughGroupIndices.push(...nested.passThroughGroupIndices);
			warnings.push(...nested.warnings.map((warning) => `Nested group ${child.name} (${child.index}): ${warning}`));
			continue;
		}
		if (!child.visible && !context.includeHidden) {
			continue;
		}
		if (child.kind === "adjustment" && !child.clipping) {
			if (!context.applyAdjustments) {
				warnings.push(`Adjustment layer ${child.name} (${child.adjustment?.key ?? "unknown"}) was not applied because adjustment compositing is disabled.`);
			} else if (canvas) {
				canvas = applyAdjustmentWithEvidence(context.source, canvas, child, appliedAdjustments);
				childLayerIndices.push(child.index);
				childLayerNames.push(child.name);
			}
			continue;
		}
		if (child.kind !== "pixel" || child.clipping || consumedClipping.has(child.index)) {
			continue;
		}
		let rendered = context.decodedByIndex.get(child.index);
		if (!rendered) {
			throw new Error(`PSD group child ${child.index} passed inspection but did not decode.`);
		}
		assertPsdTransparencyFillBlendSupported(rendered);
		const shape = rendered;
		const clippingIndices = context.compositeClippingGroups ? (context.clipping.get(child.index) ?? []) : [];
		const explicitInteriorEffectBlending = child.advancedBlending.blendInteriorEffectsAsGroup !== null;
		const clippedLayerBlending = child.advancedBlending.blendClippedLayersAsGroup;
		const knockout = child.advancedBlending.knockout;
		if (knockout !== "none") {
			if (!canvas || !context.initialCanvas) {
				throw new Error(`PSD layer ${child.name} (${child.index}) declares ${knockout} knockout without an exact containing-group stopping canvas.`);
			}
			if (explicitInteriorEffectBlending) {
				throw new Error(`PSD layer ${child.name} (${child.index}) combines knockout with infx; exact interior-effect/knockout ordering is outside the bounded model.`);
			}
			if (knockout === "deep" && context.deepKnockoutCanvas === undefined) {
				throw new Error(`PSD layer ${child.name} (${child.index}) declares deep knockout without an exact Background-or-transparency destination.`);
			}
			const knockoutDestination = knockout === "shallow" ? context.initialCanvas : (context.deepKnockoutCanvas ?? null);
			canvas = applyPsdKnockout(canvas, knockoutDestination, shape);
			appliedKnockouts.push({
				layerIndex: child.index,
				layerId: child.id,
				name: child.name,
				sourceKey: "knko",
				knockout,
				fillOpacity: child.fillOpacity,
				stoppingBoundary: knockout === "shallow" ? "containing-group" : context.deepKnockoutCanvas ? "background" : "transparency",
				destinationLayerIndices: knockout === "shallow" ? (context.shallowKnockoutLayerIndices ?? []) : (context.deepKnockoutLayerIndices ?? []),
				executionModel: "bounded-knockout-v1",
			});
		}
		if (explicitInteriorEffectBlending && child.advancedBlending.transparencyShapesLayer !== null) {
			throw new Error(
				`PSD layer ${child.name} (${child.index}) declares both infx and tsly; exact combined interior-effect blending and transparency-shape ordering is outside the bounded models.`
			);
		}
		if (explicitInteriorEffectBlending && clippingIndices.length) {
			throw new Error(
				`PSD layer ${child.name} (${child.index}) declares infx inside a clipping group; exact combined infx/clbl execution requires the clipping advanced-blending model.`
			);
		}
		let compositedWithInteriorEffects = false;
		if (context.applyLayerEffects && canvas && !context.shapeOnly && explicitInteriorEffectBlending) {
			const composited = compositeLayerWithInteriorEffectBlending(canvas, rendered, context.document, context.decodedPatterns);
			canvas = composited.layer;
			appliedLayerEffects.push(...composited.applied);
			if (composited.evidence) {
				appliedInteriorEffectBlending.push(composited.evidence);
			}
			compositedWithInteriorEffects = true;
		} else if (context.applyLayerEffects) {
			const baked = bakeAuthoredLayerEffects(rendered, context.document, context.decodedPatterns);
			rendered = baked.layer;
			appliedLayerEffects.push(...baked.applied);
			if (baked.evidence) {
				appliedTransparencyShaping.push(baked.evidence);
			}
		} else {
			rendered = applyPsdFillOpacity(rendered);
		}
		const clippingSet = new Set(clippingIndices);
		const clippingLayers: IDecodedPsdLayer[] = [];
		const clippingShapes = new Map<number, IDecodedPsdLayer>();
		const clippingBaseDestination = rendered;
		for (let stackIndex = child.index - 1; stackIndex > context.info.groupEndIndex; --stackIndex) {
			if (!clippingSet.has(stackIndex)) {
				continue;
			}
			const clippingInfo = context.document.layers[stackIndex];
			if (!clippingInfo.visible && !context.includeHidden) {
				continue;
			}
			if (clippingInfo.kind === "adjustment") {
				if (clippedLayerBlending !== null) {
					throw new Error(
						`PSD clipping base ${child.name} (${child.index}) declares clbl with a clipped adjustment; exact combined clipped-adjustment ordering is outside the bounded clbl model.`
					);
				}
				if (context.applyAdjustments) {
					rendered = applyAdjustmentWithEvidence(context.source, rendered, clippingInfo, appliedAdjustments);
				}
				continue;
			}
			let clippingLayer = context.decodedByIndex.get(stackIndex);
			if (!clippingLayer) {
				continue;
			}
			clippingShapes.set(stackIndex, clippingLayer);
			assertPsdTransparencyFillBlendSupported(clippingLayer);
			if (context.applyLayerEffects) {
				const baked = bakeAuthoredLayerEffects(clippingLayer, context.document, context.decodedPatterns);
				clippingLayer = baked.layer;
				appliedLayerEffects.push(...baked.applied);
				if (baked.evidence) {
					appliedTransparencyShaping.push(baked.evidence);
				}
			} else {
				clippingLayer = applyPsdFillOpacity(clippingLayer);
			}
			clippingLayers.push(clippingLayer);
			childLayerIndices.push(clippingInfo.index);
			childLayerNames.push(clippingInfo.name);
			blendModes.push(clippingInfo.blendMode);
		}
		const hasClippedKnockout = clippingLayers.some((clippingLayer) => clippingLayer.advancedBlending.knockout !== "none");
		if (clippedLayerBlending === false && hasClippedKnockout) {
			throw new Error(
				`PSD clipping base ${child.name} (${child.index}) disables clbl while a clipped layer declares knockout; Photoshop requires Blend Clipped Layers As Group for exact clipping-base knockout.`
			);
		}
		if (clippedLayerBlending === false && clippingLayers.length) {
			if (!canvas || context.shapeOnly) {
				throw new Error(
					`PSD clipping base ${child.name} (${child.index}) declares clbl=false; exact independent clipped-layer blending requires a bounded backdrop canvas.`
				);
			}
			canvas = compositeLayerOver(canvas, rendered);
			for (const clippingLayer of clippingLayers) {
				canvas = compositeClippingLayers(canvas, [clippingLayer], shape);
			}
			appliedClippedLayerBlending.push({
				baseLayerIndex: child.index,
				baseLayerId: child.id,
				baseLayerName: child.name,
				sourceKey: "clbl",
				blendClippedLayersAsGroup: false,
				baseBlendMode: child.blendMode,
				clippedLayerIndices: clippingLayers.map((layer) => layer.index),
				clippedLayerNames: clippingLayers.map((layer) => layer.name),
				clippedBlendModes: clippingLayers.map((layer) => layer.blendMode),
				application: "base-blend-then-independent-clipped-blends",
				executionModel: "bounded-blend-clipped-layers-as-group-v1",
			});
		} else {
			for (const clippingLayer of clippingLayers) {
				const clippingShape = clippingShapes.get(clippingLayer.index);
				const clippingKnockout = clippingLayer.advancedBlending.knockout;
				if (clippingKnockout !== "none") {
					if (!clippingShape) {
						throw new Error(`PSD clipped knockout layer ${clippingLayer.name} (${clippingLayer.index}) passed inspection without its exact source shape.`);
					}
					if (clippingLayer.advancedBlending.blendInteriorEffectsAsGroup !== null) {
						throw new Error(
							`PSD clipped layer ${clippingLayer.name} (${clippingLayer.index}) combines knockout with infx; exact interior-effect/knockout ordering is outside the bounded model.`
						);
					}
					if (clippingKnockout === "deep" && context.deepKnockoutCanvas === undefined) {
						throw new Error(
							`PSD clipped layer ${clippingLayer.name} (${clippingLayer.index}) declares deep knockout without an exact Background-or-transparency destination.`
						);
					}
					const knockoutDestination = clippingKnockout === "shallow" ? clippingBaseDestination : (context.deepKnockoutCanvas ?? null);
					rendered = applyPsdKnockout(rendered, knockoutDestination, clippingShape);
					appliedKnockouts.push({
						layerIndex: clippingLayer.index,
						layerId: clippingLayer.id,
						name: clippingLayer.name,
						sourceKey: "knko",
						knockout: clippingKnockout,
						fillOpacity: clippingLayer.fillOpacity,
						stoppingBoundary: clippingKnockout === "shallow" ? "clipping-base" : context.deepKnockoutCanvas ? "background" : "transparency",
						destinationLayerIndices: clippingKnockout === "shallow" ? [child.index] : (context.deepKnockoutLayerIndices ?? []),
						executionModel: "bounded-knockout-v1",
					});
				}
				rendered = compositeClippingLayers(rendered, [clippingLayer], shape);
			}
			if (clippedLayerBlending === true && clippingLayers.length) {
				appliedClippedLayerBlending.push({
					baseLayerIndex: child.index,
					baseLayerId: child.id,
					baseLayerName: child.name,
					sourceKey: "clbl",
					blendClippedLayersAsGroup: true,
					baseBlendMode: child.blendMode,
					clippedLayerIndices: clippingLayers.map((layer) => layer.index),
					clippedLayerNames: clippingLayers.map((layer) => layer.name),
					clippedBlendModes: clippingLayers.map((layer) => layer.blendMode),
					application: "clipped-composite-then-base-blend",
					executionModel: "bounded-blend-clipped-layers-as-group-v1",
				});
			}
		}
		if (!compositedWithInteriorEffects && !(clippedLayerBlending === false && clippingLayers.length)) {
			canvas = compositeLayerOver(canvas, rendered);
		}
		childLayerIndices.push(child.index);
		childLayerNames.push(child.name);
		blendModes.push(child.blendMode);
	}
	if (!canvas) {
		throw new Error(`PSD group ${group.name} contains no compositable raster content.`);
	}
	if (context.applyLayerEffects && context.applyGroupEffects !== false && group.advancedBlending.blendInteriorEffectsAsGroup !== null && hasEnabledLayerEffects(group)) {
		throw new Error(
			`PSD group ${group.name} (${group.index}) declares infx with active group effects; exact group-level execution requires a bounded non-pass parent canvas and cannot be flattened independently.`
		);
	}
	let renderedGroup: IDecodedPsdLayer = {
		...canvas,
		...group,
		left: canvas.left,
		top: canvas.top,
		right: canvas.right,
		bottom: canvas.bottom,
		width: canvas.width,
		height: canvas.height,
		opacity: group.blendMode === "pass" ? 255 : group.opacity,
		blendMode: group.blendMode === "pass" ? "norm" : group.blendMode,
		pixels: canvas.pixels,
	};
	if (context.applyLayerEffects && context.applyGroupEffects !== false) {
		const baked = bakeAuthoredLayerEffects(renderedGroup, context.document, context.decodedPatterns);
		renderedGroup = baked.layer;
		appliedLayerEffects.push(...baked.applied);
		if (baked.evidence) {
			appliedTransparencyShaping.push(baked.evidence);
		}
	} else {
		renderedGroup = applyPsdFillOpacity(renderedGroup);
	}
	if (
		context.info.executionModel !== "bounded-backdrop-pass-through-mask-v1" &&
		context.info.executionModel !== "bounded-backdrop-pass-through-mask-effects-v1" &&
		context.info.executionModel !== "bounded-backdrop-pass-through-blends-mask-v1" &&
		context.info.executionModel !== "bounded-nested-backdrop-pass-through-mask-v1" &&
		context.info.executionModel !== "bounded-nested-backdrop-pass-through-mask-effects-v1" &&
		context.info.executionModel !== "bounded-nested-backdrop-pass-through-mask-adjustments-v1" &&
		context.info.executionModel !== "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1"
	) {
		renderedGroup = applyGroupMasksWithEvidence(context.source, renderedGroup, group, appliedGroupMasks);
	}
	if (context.applyExternalAdjustments) {
		const externalAdjustments = applicableAdjustments(context.document, group.index, context.clipping, context.scopes).sort((left, right) => right.index - left.index);
		for (const adjustment of externalAdjustments) {
			renderedGroup = applyAdjustmentWithEvidence(context.source, renderedGroup, adjustment, appliedAdjustments);
		}
	}
	return {
		layer: renderedGroup,
		appliedAdjustments,
		appliedLayerEffects,
		appliedInteriorEffectBlending,
		appliedClippedLayerBlending,
		appliedTransparencyShaping,
		appliedKnockouts,
		appliedGroupMasks,
		childLayerIndices,
		childLayerNames,
		blendModes,
		nestedGroupIndices,
		passThroughGroupIndices,
		backdropLayerIndices: [],
		backdropBlendModes: [],
		backdropIncluded: false,
		maximumDepth: context.info.maximumDepth,
		warnings,
	};
}

function renderBackdropDependentGroupEffects(context: IRenderIsolatedGroupContext, parentBackdrop: IDecodedPsdLayer): IRenderedIsolatedGroup {
	const group = context.document.layers[context.info.groupStartIndex];
	const effectShape = renderIsolatedGroup({
		...context,
		applyGroupEffects: false,
		applyExternalAdjustments: false,
		initialCanvas: undefined,
		shapeOnly: true,
	});
	const behindBase: IDecodedPsdLayer = {
		...parentBackdrop,
		...group,
		left: parentBackdrop.left,
		top: parentBackdrop.top,
		right: parentBackdrop.right,
		bottom: parentBackdrop.bottom,
		width: parentBackdrop.width,
		height: parentBackdrop.height,
		opacity: 255,
		blendMode: "norm",
		pixels: parentBackdrop.pixels,
	};
	const behind = bakeLayerEffects(behindBase, context.document, context.decodedPatterns, effectShape.layer, "behind");
	const rendered = renderIsolatedGroup({
		...context,
		applyGroupEffects: false,
		applyExternalAdjustments: false,
		initialCanvas: behind.layer,
		shapeOnly: false,
	});
	const foreground = bakeLayerEffects(rendered.layer, context.document, context.decodedPatterns, effectShape.layer, "foreground");
	rendered.layer = foreground.layer;
	for (const effect of [...behind.applied, ...foreground.applied]) {
		if (
			!rendered.appliedLayerEffects.some(
				(candidate) => candidate.layerIndex === effect.layerIndex && candidate.effectIndex === effect.effectIndex && candidate.type === effect.type
			)
		) {
			rendered.appliedLayerEffects.push(effect);
		}
	}
	return rendered;
}

/** Builds a complete exact extraction plan and encoded PNG payloads without mutating project files. */
export async function preparePsdLayerExtraction(sourcePath: string, options: IPsdLayerExtractionOptions = {}): Promise<IPreparedPsdLayerExtraction> {
	const absoluteSource = resolve(sourcePath);
	assertContained(absoluteSource, "PSD source path");
	if (!new Set([".psd", ".psb"]).has(extname(absoluteSource).toLowerCase()) || !(await pathExists(absoluteSource)) || (await stat(absoluteSource)).isDirectory()) {
		throw new Error("Layered Photoshop extraction requires an existing .psd or .psb file asset.");
	}
	const details = await stat(absoluteSource);
	if (details.size > MAXIMUM_SOURCE_BYTES) {
		throw new Error("PSD layer extraction is limited to 512 MiB source documents.");
	}
	const source = await readFile(absoluteSource);
	const document = inspectPsdLayers(source);
	const decoded = decodePsdLayers(source, { deferGlobalLayerMasks: true, deferGlobalVectorMasks: true });
	const decodedPatterns = new Map(decodePsdPatterns(source).map((pattern) => [pattern.index, pattern]));
	const decodedSmartObjectResources = decodePsdSmartObjectResources(source);
	const decodedSmartFilterMasks = decodePsdSmartFilterMasks(source);
	const renderEmbeddedSmartObjects = options.renderEmbeddedSmartObjects === true;
	const renderExternalSmartObjects = options.renderExternalSmartObjects === true;
	const requestedSmartObjectRenderLayerIndices = normalizeSmartObjectRenderLayerIndices(
		renderEmbeddedSmartObjects || renderExternalSmartObjects,
		options.smartObjectRenderLayerIndices
	);
	const inspectNestedSmartObjects = options.inspectNestedSmartObjects === true;
	const nestedSmartObjectMaximumDepth = normalizeNestedSmartObjectMaximumDepth(inspectNestedSmartObjects, options.nestedSmartObjectMaximumDepth);
	const nestedSmartObjectDocuments = inspectNestedSmartObjects ? inspectPsdNestedSmartObjectDocuments(source, nestedSmartObjectMaximumDepth) : [];
	const extractSmartObjectPayloads = options.extractSmartObjectPayloads === true;
	const requestedSmartObjectResourceIds = normalizeSmartObjectResourceIds(options.smartObjectResourceIds);
	const preparedSmartObjectExternalBindings = await prepareSmartObjectExternalBindings(document, options.smartObjectExternalBindings);
	const requestedSmartObjectExternalBindings = preparedSmartObjectExternalBindings.map((entry) => entry.request);
	const preparedShapeBlurKernelBindings = await prepareShapeBlurKernelBindings(document, options.shapeBlurKernelBindings);
	const shapeBlurKernelBindings = preparedShapeBlurKernelBindings.map((entry) => entry.evidence);
	const preparedDisplacementMapBindings = await prepareDisplacementMapBindings(document, options.displacementMapBindings);
	const displacementMapBindings = preparedDisplacementMapBindings.map((entry) => entry.evidence);
	if (requestedSmartObjectResourceIds && !extractSmartObjectPayloads) {
		throw new Error("smartObjectResourceIds requires extractSmartObjectPayloads=true.");
	}
	if (requestedSmartObjectExternalBindings.length && !extractSmartObjectPayloads && !renderExternalSmartObjects) {
		throw new Error("smartObjectExternalBindings requires extractSmartObjectPayloads=true or renderExternalSmartObjects=true.");
	}
	if (preparedShapeBlurKernelBindings.length && !renderEmbeddedSmartObjects && !renderExternalSmartObjects) {
		throw new Error("shapeBlurKernelBindings requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true.");
	}
	if (preparedDisplacementMapBindings.length && !renderEmbeddedSmartObjects && !renderExternalSmartObjects) {
		throw new Error("displacementMapBindings requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true.");
	}
	const smartObjectResourcesById = new Map<string, typeof document.smartObjectResources>();
	for (const resource of document.smartObjectResources) {
		const matches = smartObjectResourcesById.get(resource.id) ?? [];
		matches.push(resource);
		smartObjectResourcesById.set(resource.id, matches);
	}
	for (const id of requestedSmartObjectResourceIds ?? []) {
		const matches = smartObjectResourcesById.get(id) ?? [];
		if (matches.length === 0) {
			throw new Error(`smartObjectResourceIds references missing linked-resource ID ${JSON.stringify(id)}.`);
		}
		if (matches.length > 1) {
			throw new Error(`smartObjectResourceIds ID ${JSON.stringify(id)} is ambiguous across records ${matches.map((resource) => resource.index).join(", ")}.`);
		}
		if (matches[0].type !== "embedded") {
			throw new Error(
				`Smart-object resource ${JSON.stringify(id)} is ${matches[0].type}; external and alias records are evidence-only and are never resolved, read, or copied automatically.`
			);
		}
	}
	const selectedSmartObjectResources = extractSmartObjectPayloads
		? decodedSmartObjectResources.filter((resource) => requestedSmartObjectResourceIds === null || requestedSmartObjectResourceIds.includes(resource.id))
		: [];
	const selectedExternalSmartObjectResources: IDecodedPsdSmartObjectResource[] = extractSmartObjectPayloads
		? preparedSmartObjectExternalBindings.map((entry) => ({ ...entry.resource, data: entry.data }))
		: [];
	const decodedByIndex = new Map(decoded.map((layer) => [layer.index, layer]));
	const preparedTextRenders = await preparePsdTextRenders(document, options.textRenders);
	const appliedTextRenderByIndex = new Map<number, IPsdAppliedTextRender>();
	for (const [layerIndex, prepared] of preparedTextRenders) {
		const layer = document.layers[layerIndex];
		const decodedLayer = decodedByIndex.get(layerIndex);
		if (!decodedLayer) {
			throw new Error(`PSD text layer ${layerIndex} passed inspection but did not decode.`);
		}
		const rendered = prepared.styleRuns.length
			? await renderProjectFontTextStyleRuns({
					runs: prepared.styleRuns.map((run) => ({
						text: run.text,
						fontPath: run.absoluteFontPath,
						fontBytes: run.fontData,
						fontSize: run.fontSize,
						tracking: run.tracking,
						autoLeading: run.autoLeading,
						leading: run.leading,
						kerning: run.kerning,
						autoKerning: run.autoKerning,
						ligatures: run.ligatures,
						discretionaryLigatures: run.discretionaryLigatures,
						color: run.color,
						fillEnabled: run.fillEnabled,
						strokeEnabled: run.strokeEnabled,
						strokeColor: run.strokeColor,
						fillFirst: run.fillFirst,
						outlineWidth: run.outlineWidth,
						sourceStyleRunIndex: run.sourceStyleRunIndex,
						fontIndex: run.fontIndex,
						fontName: run.fontName,
						language: run.language,
						fauxBold: run.fauxBold,
						fauxItalic: run.fauxItalic,
						fontCaps: run.fontCaps,
						smallCapScale: run.smallCapScale,
						fontBaseline: run.fontBaseline,
						fontBaselineScale: run.fontBaselineScale,
						fontBaselinePosition: run.fontBaselinePosition,
						baselineDirection: run.baselineDirection,
						proportionalMetrics: run.proportionalMetrics,
						kana: run.kana,
						ruby: run.ruby,
						japaneseAlternateFeature: run.japaneseAlternateFeature,
						fractions: run.fractions,
						ordinals: run.ordinals,
						stylisticAlternates: run.stylisticAlternates,
						oldStyle: run.oldStyle,
						swash: run.swash,
						titling: run.titling,
						ornaments: run.ornaments,
						slashedZero: run.slashedZero,
						connectionForms: run.connectionForms,
						contextualLigatures: run.contextualLigatures,
						hindiNumbers: run.hindiNumbers,
						kashida: run.kashida,
						diacriticPosition: run.diacriticPosition,
						characterDirection: run.characterDirection,
						figureStyle: run.figureStyle,
						engineData2StyleRunIndex: run.engineData2StyleRunIndex,
						wariChuEnabled: run.wariChuEnabled,
						wariChuLineCount: run.wariChuLineCount,
						wariChuLineGap: run.wariChuLineGap,
						wariChuScale: run.wariChuScale,
						wariChuWidow: run.wariChuWidow,
						wariChuOrphan: run.wariChuOrphan,
						wariChuJustification: run.wariChuJustification,
						tsume: run.tsume,
						styleRunAlignment: run.styleRunAlignment,
						horizontalScale: run.horizontalScale,
						verticalScale: run.verticalScale,
						baselineShift: run.baselineShift,
						underline: run.underline,
						strikethrough: run.strikethrough,
						noBreak: run.noBreak,
					})),
					paragraphRuns: prepared.paragraphRuns,
					boxLayout: prepared.boxLayout ?? undefined,
					width: decodedLayer.width,
					height: decodedLayer.height,
					orientation: layer.text!.orientation as "horizontal" | "vertical",
					lineHeight: prepared.request.lineHeight,
					justification: prepared.request.justification,
					offsetX: prepared.request.offsetX,
					offsetY: prepared.request.offsetY,
					shaping: prepared.request.shaping ?? undefined,
				})
			: await renderProjectFontText(
					prepared.absoluteFontPath,
					{
						text: prepared.request.text,
						width: decodedLayer.width,
						height: decodedLayer.height,
						orientation: layer.text!.orientation as "horizontal" | "vertical",
						fontSize: prepared.request.fontSize,
						lineHeight: prepared.request.lineHeight,
						tracking: prepared.request.tracking,
						justification: prepared.request.justification,
						offsetX: prepared.request.offsetX,
						offsetY: prepared.request.offsetY,
						color: prepared.request.color,
						shaping: prepared.request.shaping ?? undefined,
					},
					prepared.fontData
				);
		let renderedPixels = rendered.pixels;
		let renderedLeft = decodedLayer.left;
		let renderedTop = decodedLayer.top;
		let renderedWidth = decodedLayer.width;
		let renderedHeight = decodedLayer.height;
		let authoredWarp: IPsdAppliedTextWarp | null = null;
		if (prepared.request.applyAuthoredWarp) {
			const warp = layer.text!.warp;
			const sourceRaster = { pixels: renderedPixels, width: renderedWidth, height: renderedHeight };
			const corners: [number, number, number, number, number, number, number, number] = [0, 0, renderedWidth, 0, renderedWidth, renderedHeight, 0, renderedHeight];
			const warped =
				warp.meshExecutionModel === "tensor"
					? renderPsdSmartObjectWarpPlacement(sourceRaster, corners, warp.meshPoints, warp.uOrder!, warp.vOrder!)
					: warp.meshExecutionModel === "quilt"
						? renderPsdSmartObjectQuiltWarpPlacement(sourceRaster, corners, {
								meshPoints: warp.meshPoints,
								uOrder: warp.uOrder!,
								vOrder: warp.vOrder!,
								deformNumRows: warp.deformNumRows!,
								deformNumCols: warp.deformNumCols!,
								quiltSliceX: warp.quiltSliceX,
								quiltSliceY: warp.quiltSliceY,
							})
						: renderPsdSmartObjectPresetWarpPlacement(sourceRaster, corners, {
								style: warp.style as PsdSmartObjectPresetWarpStyle,
								value: warp.value,
								perspective: warp.perspective,
								perspectiveOther: warp.perspectiveOther,
								rotate: warp.rotate as "horizontal" | "vertical",
							});
			renderedPixels = warped.pixels;
			renderedLeft += warped.left;
			renderedTop += warped.top;
			renderedWidth = warped.width;
			renderedHeight = warped.height;
			authoredWarp =
				warp.meshExecutionModel === "tensor"
					? {
							type: "tensor",
							style: warp.style,
							left: warped.left,
							top: warped.top,
							width: warped.width,
							height: warped.height,
							tessellation: warped.tessellation,
							uOrder: warp.uOrder!,
							vOrder: warp.vOrder!,
							meshPointCount: warp.meshPoints.length,
							executionModel: "bounded-bezier-text-warp-v1",
						}
					: warp.meshExecutionModel === "quilt"
						? {
								type: "quilt",
								style: warp.style,
								left: warped.left,
								top: warped.top,
								width: warped.width,
								height: warped.height,
								tessellation: warped.tessellation,
								uOrder: warp.uOrder!,
								vOrder: warp.vOrder!,
								deformNumRows: warp.deformNumRows!,
								deformNumCols: warp.deformNumCols!,
								meshPointCount: warp.meshPoints.length,
								quiltSliceX: warp.quiltSliceX,
								quiltSliceY: warp.quiltSliceY,
								executionModel: "bounded-piecewise-bezier-text-quilt-warp-v1",
							}
						: {
								type: "preset",
								style: warp.style,
								value: warp.value,
								perspective: warp.perspective,
								perspectiveOther: warp.perspectiveOther,
								rotate: warp.rotate as "horizontal" | "vertical",
								left: warped.left,
								top: warped.top,
								width: warped.width,
								height: warped.height,
								tessellation: warped.tessellation,
								executionModel: "bounded-analytical-preset-text-warp-v1",
							};
		}
		const mask = decodePsdLayerMasks(
			source,
			[layerIndex],
			{
				left: renderedLeft,
				top: renderedTop,
				width: renderedWidth,
				height: renderedHeight,
			},
			{
				includeRaster: layer.advancedBlending.layerMaskAsGlobalMask !== true,
				includeVector: layer.advancedBlending.vectorMaskAsGlobalMask !== true,
			}
		)[0];
		const coverage = mask?.coverage ?? new Uint8Array(renderedWidth * renderedHeight).fill(255);
		for (let pixel = 0; pixel < coverage.length; ++pixel) {
			renderedPixels[pixel * 4 + 3] = Math.round((renderedPixels[pixel * 4 + 3] * coverage[pixel]) / 255);
		}
		decodedByIndex.set(layerIndex, {
			...decodedLayer,
			pixels: renderedPixels,
			left: renderedLeft,
			top: renderedTop,
			width: renderedWidth,
			height: renderedHeight,
		});
		const { pixels: _pixels, ...renderEvidence } = rendered;
		appliedTextRenderByIndex.set(layerIndex, {
			...renderEvidence,
			layerIndex,
			layerId: layer.id,
			layerName: layer.name,
			text: prepared.request.text,
			fontPath: prepared.request.fontPath,
			fontHash: prepared.fontHash,
			fontBytes: prepared.fontBytes,
			fontSize: prepared.request.fontSize,
			tracking: prepared.request.tracking,
			justification: prepared.request.justification,
			offsetX: prepared.request.offsetX,
			offsetY: prepared.request.offsetY,
			color: prepared.request.color,
			maskExecutionModel: "bounded-layer-mask-v1",
			maskCoverageMinimum: coverage.reduce((minimum, value) => Math.min(minimum, value), 255),
			maskCoverageMaximum: coverage.reduce((maximum, value) => Math.max(maximum, value), 0),
			fontFallback: "none",
			authoredWarp,
			paragraphRuns: "paragraphRuns" in rendered ? rendered.paragraphRuns : [],
			boxLayout: "boxLayout" in rendered ? rendered.boxLayout : null,
			styleSynthesis:
				prepared.styleRuns.some((run) => run.fauxBold || run.fauxItalic) &&
				(rendered.executionModel === "bounded-project-font-text-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-bidi-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-cross-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-vertical-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-bidi-vertical-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1" ||
					rendered.executionModel === "bounded-project-font-harfbuzz-bidi-vertical-cross-style-runs-v1")
					? "authored-faux-bold-italic-v1"
					: "none",
			styleRuns:
				rendered.executionModel === "bounded-project-font-text-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-bidi-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-cross-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-bidi-cross-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-vertical-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-bidi-vertical-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-vertical-cross-style-runs-v1" ||
				rendered.executionModel === "bounded-project-font-harfbuzz-bidi-vertical-cross-style-runs-v1"
					? rendered.styleRuns.map((run) => {
							const source = prepared.styleRuns[run.sourceStyleRunIndex];
							return {
								...run,
								start: source.start,
								fontPath: source.fontPath,
								fontHash: source.fontHash,
								fontBytes: source.fontBytes,
								fauxBold: source.fauxBold,
								fauxItalic: source.fauxItalic,
							};
						})
					: [],
		});
	}
	const requestedLayerIndices = normalizeLayerIndices(options.layerIndices);
	if (requestedLayerIndices?.some((index) => index >= document.layerCount)) {
		throw new Error(`layerIndices references a missing layer; this PSD has indices 0-${Math.max(0, document.layerCount - 1)}.`);
	}
	const includeHidden = options.includeHidden === true;
	const applyOpacity = options.applyOpacity !== false;
	const applyLayerEffects = options.applyLayerEffects !== false;
	const applyAdjustments = options.applyAdjustments !== false;
	const compositeClippingGroups = options.compositeClippingGroups !== false;
	const compositeGroups = options.compositeGroups === true;
	const groups = clippingGroups(document);
	const groupScopes = layerGroupScopes(document);
	const groupComposites = groupCompositeInfos(document, applyLayerEffects, applyAdjustments);
	const groupCompositeByStart = new Map(groupComposites.map((info) => [info.groupStartIndex, info]));
	const consumedClippingLayers = new Set([...groups.values()].flat());
	const selected = document.layers.filter((layer) => {
		const groupComposite = groupCompositeByStart.get(layer.index);
		const extractionSupported = layer.extractionSupported || (compositeGroups && groupComposite?.supported === true);
		if (!extractionSupported || (!includeHidden && !layer.visible)) {
			return false;
		}
		if (layer.kind === "pixel" && compositeClippingGroups && consumedClippingLayers.has(layer.index)) {
			return false;
		}
		const group = groups.get(layer.index) ?? [];
		if (
			requestedLayerIndices === null &&
			compositeGroups &&
			compositeClippingGroups &&
			layer.kind === "pixel" &&
			((layer.advancedBlending.blendClippedLayersAsGroup === false && group.length > 0) || layer.advancedBlending.knockout !== "none") &&
			groupComposites.some((candidate) => candidate.supported && candidate.childLayerIndices.includes(layer.index))
		) {
			return false;
		}
		return (
			requestedLayerIndices === null ||
			requestedLayerIndices.includes(layer.index) ||
			(compositeClippingGroups && group.some((index) => requestedLayerIndices.includes(index)))
		);
	});
	const contributingLayerIndices = new Set(
		selected.flatMap((layer) => [layer.index, ...(groups.get(layer.index) ?? []), ...(groupCompositeByStart.get(layer.index)?.childLayerIndices ?? [])])
	);
	const unusedTextRenderIndices = [...preparedTextRenders.keys()].filter((index) => !contributingLayerIndices.has(index));
	if (unusedTextRenderIndices.length) {
		throw new Error(`textRenders layer(s) ${unusedTextRenderIndices.join(", ")} do not contribute to the selected extraction outputs.`);
	}
	if (requestedLayerIndices) {
		const available = new Set(selected.flatMap((layer) => [layer.index, ...(compositeClippingGroups ? (groups.get(layer.index) ?? []) : [])]));
		const unavailable = requestedLayerIndices.filter((index) => !available.has(index));
		if (unavailable.length) {
			throw new Error(`Requested PSD layer(s) ${unavailable.join(", ")} are hidden or cannot be extracted. Enable includeHidden or inspect their warnings.`);
		}
	}
	const smartObjectRenderLayerIndices =
		renderEmbeddedSmartObjects || renderExternalSmartObjects
			? (requestedSmartObjectRenderLayerIndices ??
				document.layers
					.filter(
						(layer) =>
							contributingLayerIndices.has(layer.index) &&
							layer.smartObject !== null &&
							((renderEmbeddedSmartObjects && layer.smartObject.linkedResource.status === "embedded") ||
								(renderExternalSmartObjects && layer.smartObject.linkedResource.status === "external"))
					)
					.map((layer) => layer.index))
			: [];
	const unusedSmartObjectRenderIndices = smartObjectRenderLayerIndices.filter((index) => !contributingLayerIndices.has(index));
	if (unusedSmartObjectRenderIndices.length) {
		throw new Error(`smartObjectRenderLayerIndices layer(s) ${unusedSmartObjectRenderIndices.join(", ")} do not contribute to the selected extraction outputs.`);
	}
	const appliedSmartObjectRenderByIndex = new Map<number, IPsdAppliedSmartObjectRender>();
	for (const layerIndex of smartObjectRenderLayerIndices) {
		const layer = document.layers[layerIndex];
		const decodedLayer = decodedByIndex.get(layerIndex);
		if (!layer?.smartObject || !decodedLayer) {
			throw new Error(`PSD layer ${layerIndex} is not an extractable smart-object raster layer.`);
		}
		if (appliedTextRenderByIndex.has(layerIndex)) {
			throw new Error(`PSD layer ${layerIndex} cannot use textRenders and smart-object source rendering in the same extraction plan.`);
		}
		const smartObject = layer.smartObject;
		if (smartObject.type !== "raster") {
			throw new Error(
				`PSD smart-object layer ${layer.name} (${layerIndex}) has ${smartObject.type} content; bounded live rendering requires a raster embedded or explicitly bound external source.`
			);
		}
		const presetWarpStyle = (PSD_SMART_OBJECT_PRESET_WARP_STYLES as readonly string[]).includes(smartObject.warp.style);
		if (smartObject.warp.style !== "warpNone" && smartObject.warp.style !== "warpCustom" && !presetWarpStyle) {
			throw new Error(
				`PSD smart-object layer ${layer.name} (${layerIndex}) uses unsupported warp style ${smartObject.warp.style}; bounded live rendering accepts warpNone, a standard analytical preset, or an exact custom envelope.`
			);
		}
		if (presetWarpStyle && smartObject.warp.rotate === "unknown") {
			throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) preset warp requires a horizontal or vertical warpRotate orientation.`);
		}
		if (smartObject.warp.style === "warpCustom" && !smartObject.warp.meshExecutionSupported) {
			throw new Error(
				`PSD smart-object layer ${layer.name} (${layerIndex}) custom envelope cannot execute: ${smartObject.warp.meshWarning ?? "an exact bounded control grid is required."}`
			);
		}
		const sourceKind = smartObject.linkedResource.status;
		if ((sourceKind !== "embedded" && sourceKind !== "external") || smartObject.linkedResource.resourceIndices.length !== 1) {
			throw new Error(
				`PSD smart-object layer ${layer.name} (${layerIndex}) requires exactly one associated embedded or external resource; current status is ${smartObject.linkedResource.status}.`
			);
		}
		const resourceIndex = smartObject.linkedResource.resourceIndices[0];
		const embeddedResource = decodedSmartObjectResources.find((entry) => entry.index === resourceIndex);
		const externalBinding = preparedSmartObjectExternalBindings.find((entry) => entry.resource.index === resourceIndex);
		if (sourceKind === "embedded" && !renderEmbeddedSmartObjects) {
			throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) requires renderEmbeddedSmartObjects=true.`);
		}
		if (sourceKind === "external" && !renderExternalSmartObjects) {
			throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) requires renderExternalSmartObjects=true.`);
		}
		if (sourceKind === "embedded" && (!embeddedResource || embeddedResource.type !== "embedded" || embeddedResource.recordSignature !== "liFD")) {
			throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) references resource ${resourceIndex}, which is not an available embedded liFD payload.`);
		}
		if (sourceKind === "external" && !externalBinding) {
			throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) requires an explicit smartObjectExternalBindings entry for external resource ${resourceIndex}.`);
		}
		const resource = sourceKind === "embedded" ? embeddedResource! : ({ ...externalBinding!.resource, data: externalBinding!.data } as IDecodedPsdSmartObjectResource);
		let decodedSource: { width: number; height: number; pixels: Uint8Array; format: string };
		try {
			if (sourceKind === "embedded") {
				const decoded = decodePsd(resource.data);
				decodedSource = { ...decoded, format: decoded.format };
			} else {
				decodedSource = await decodeExternalSmartObjectRaster(externalBinding!.request.sourcePath, externalBinding!.data);
			}
		} catch (error) {
			throw new Error(
				`PSD smart-object layer ${layer.name} (${layerIndex}) ${sourceKind} resource ${resourceIndex} is not a supported bounded raster source: ${String(error)}`
			);
		}
		const unfilteredSource = decodedSource;
		const executableSmartFilters = smartObject.smartFilters.map((filter): IPsdSmartFilterInfo => {
			if (filter.type === "displace" && filter.displace) {
				const binding = preparedDisplacementMapBindings.find((candidate) => candidate.request.layerIndex === layerIndex && candidate.request.filterIndex === filter.index);
				return binding
					? {
							...filter,
							displace: { ...filter.displace, mapBinding: binding.runtimeEvidence },
							bakeSupported: true,
							warning: null,
							algorithmExecutionModel: "bounded-explicit-map-displace-smart-filter-v1",
						}
					: filter;
			}
			if (filter.type !== "shapeBlur" || filter.shapeBlur?.kernel !== null) {
				return filter;
			}
			const binding = preparedShapeBlurKernelBindings.find((candidate) => candidate.kernel.shapeId === filter.shapeBlur!.customShape.id);
			return binding
				? {
						...filter,
						shapeBlur: { ...filter.shapeBlur, kernel: "customBinding" },
						bakeSupported: true,
						warning: null,
						algorithmExecutionModel: "bounded-custom-raster-shape-blur-smart-filter-v1",
					}
				: filter;
		});
		const smartFilterResult =
			smartObject.filterCount > 0
				? applyPsdSmartFilters(
						decodedSource,
						executableSmartFilters,
						smartObject.smartFilterState?.enabled !== false,
						preparedShapeBlurKernelBindings.map((binding) => binding.kernel),
						preparedDisplacementMapBindings.filter((binding) => binding.request.layerIndex === layerIndex).map((binding) => binding.binding)
					)
				: null;
		if (smartFilterResult) {
			decodedSource = { ...decodedSource, pixels: smartFilterResult.pixels };
		}
		const transformSource = smartObject.nonAffineTransform ? "nonAffineTransform" : "transform";
		const renderSource = (sourceRaster: typeof decodedSource) =>
			smartObject.warp.style === "warpCustom" && smartObject.warp.meshExecutionModel === "quilt"
				? renderPsdSmartObjectQuiltWarpPlacement(
						sourceRaster,
						smartObject.nonAffineTransform ?? smartObject.transform,
						{
							meshPoints: smartObject.warp.meshPoints,
							uOrder: smartObject.warp.uOrder!,
							vOrder: smartObject.warp.vOrder!,
							deformNumRows: smartObject.warp.deformNumRows!,
							deformNumCols: smartObject.warp.deformNumCols!,
							quiltSliceX: smartObject.warp.quiltSliceX,
							quiltSliceY: smartObject.warp.quiltSliceY,
						},
						MAXIMUM_EFFECT_BAKE_PIXELS
					)
				: smartObject.warp.style === "warpCustom"
					? renderPsdSmartObjectWarpPlacement(
							sourceRaster,
							smartObject.nonAffineTransform ?? smartObject.transform,
							smartObject.warp.meshPoints,
							smartObject.warp.uOrder!,
							smartObject.warp.vOrder!,
							MAXIMUM_EFFECT_BAKE_PIXELS
						)
					: presetWarpStyle
						? renderPsdSmartObjectPresetWarpPlacement(
								sourceRaster,
								smartObject.nonAffineTransform ?? smartObject.transform,
								{
									style: smartObject.warp.style as (typeof PSD_SMART_OBJECT_PRESET_WARP_STYLES)[number],
									value: smartObject.warp.value,
									perspective: smartObject.warp.perspective,
									perspectiveOther: smartObject.warp.perspectiveOther,
									rotate: smartObject.warp.rotate as "horizontal" | "vertical",
								},
								MAXIMUM_EFFECT_BAKE_PIXELS
							)
						: renderPsdSmartObjectPlacement(sourceRaster, smartObject.nonAffineTransform ?? smartObject.transform, MAXIMUM_EFFECT_BAKE_PIXELS);
		const rendered = renderSource(decodedSource);
		let decodedSmartFilterMask: IDecodedPsdSmartFilterMask | null = null;
		if (smartObject.smartFilterState?.maskEnabled && (smartFilterResult?.appliedFilterIndices.length ?? 0) > 0) {
			if (smartObject.smartFilterMaskWarning) {
				throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) cannot execute its smart-filter mask: ${smartObject.smartFilterMaskWarning}`);
			}
			decodedSmartFilterMask = decodedSmartFilterMasks.find((candidate) => candidate.id === smartObject.placedId) ?? null;
			if (!decodedSmartFilterMask) {
				throw new Error(
					`PSD smart-object layer ${layer.name} (${layerIndex}) cannot execute its smart-filter mask because no decoded FEid/FXid raster matches ${smartObject.placedId ?? "its missing placed identifier"}.`
				);
			}
			const unfilteredRendered = renderSource(unfilteredSource);
			if (
				unfilteredRendered.left !== rendered.left ||
				unfilteredRendered.top !== rendered.top ||
				unfilteredRendered.width !== rendered.width ||
				unfilteredRendered.height !== rendered.height
			) {
				throw new Error(`PSD smart-object layer ${layer.name} (${layerIndex}) smart-filter mask sources produced inconsistent placement bounds.`);
			}
			const outsideCoverage = smartObject.smartFilterState.maskExtendWithWhite ? 255 : 0;
			for (let y = 0; y < rendered.height; ++y) {
				for (let x = 0; x < rendered.width; ++x) {
					const documentX = rendered.left + x;
					const documentY = rendered.top + y;
					const maskX = documentX - decodedSmartFilterMask.left;
					const maskY = documentY - decodedSmartFilterMask.top;
					const maskCoverage =
						maskX >= 0 && maskY >= 0 && maskX < decodedSmartFilterMask.width && maskY < decodedSmartFilterMask.height
							? decodedSmartFilterMask.coverage[maskY * decodedSmartFilterMask.width + maskX]
							: outsideCoverage;
					const amount = maskCoverage / 255;
					const offset = (y * rendered.width + x) * 4;
					for (let channel = 0; channel < 4; ++channel) {
						rendered.pixels[offset + channel] = Math.round(unfilteredRendered.pixels[offset + channel] * (1 - amount) + rendered.pixels[offset + channel] * amount);
					}
				}
			}
		}
		const mask = decodePsdLayerMasks(
			source,
			[layerIndex],
			{
				left: rendered.left,
				top: rendered.top,
				width: rendered.width,
				height: rendered.height,
			},
			{
				includeRaster: layer.advancedBlending.layerMaskAsGlobalMask !== true,
				includeVector: layer.advancedBlending.vectorMaskAsGlobalMask !== true,
			}
		)[0];
		const coverage = mask?.coverage ?? new Uint8Array(rendered.width * rendered.height).fill(255);
		for (let pixel = 0; pixel < coverage.length; ++pixel) {
			rendered.pixels[pixel * 4 + 3] = Math.round((rendered.pixels[pixel * 4 + 3] * coverage[pixel]) / 255);
		}
		decodedByIndex.set(layerIndex, {
			...decodedLayer,
			left: rendered.left,
			top: rendered.top,
			right: rendered.left + rendered.width,
			bottom: rendered.top + rendered.height,
			width: rendered.width,
			height: rendered.height,
			pixels: rendered.pixels,
		});
		appliedSmartObjectRenderByIndex.set(layerIndex, {
			sourceKind,
			sourcePath: sourceKind === "external" ? externalBinding!.request.sourcePath : null,
			sourceFormat: decodedSource.format,
			layerIndex,
			layerId: layer.id,
			layerName: layer.name,
			resourceIndex,
			resourceId: resource.id,
			resourceName: resource.name,
			resourceFileType: resource.fileType,
			resourceHash: createHash("sha256").update(resource.data).digest("hex"),
			resourceBytes: resource.data.byteLength,
			sourceWidth: decodedSource.width,
			sourceHeight: decodedSource.height,
			transformSource,
			corners: rendered.corners,
			left: rendered.left,
			top: rendered.top,
			width: rendered.width,
			height: rendered.height,
			sampling: rendered.sampling,
			warpStyle: smartObject.warp.style,
			warpValue: smartObject.warp.value,
			warpPerspective: smartObject.warp.perspective,
			warpPerspectiveOther: smartObject.warp.perspectiveOther,
			warpRotate: smartObject.warp.rotate,
			uOrder: smartObject.warp.uOrder,
			vOrder: smartObject.warp.vOrder,
			deformNumRows: smartObject.warp.deformNumRows,
			deformNumCols: smartObject.warp.deformNumCols,
			meshPointCount: smartObject.warp.meshPoints.length,
			quiltSliceX: [...smartObject.warp.quiltSliceX],
			quiltSliceY: [...smartObject.warp.quiltSliceY],
			tessellation: "tessellation" in rendered ? rendered.tessellation : null,
			filterCount: smartObject.filterCount,
			smartFilterStackEnabled: smartObject.smartFilterState?.enabled !== false,
			appliedSmartFilters: smartFilterResult?.appliedFilterIndices.map((index) => executableSmartFilters[index]) ?? [],
			smartFilterExecutionModel: smartFilterResult?.executionModel ?? null,
			smartFilterMaskEnabled: smartObject.smartFilterState?.maskEnabled === true,
			smartFilterMaskLinked: smartObject.smartFilterState?.maskLinked ?? null,
			smartFilterMaskExtendWithWhite: smartObject.smartFilterState?.maskExtendWithWhite ?? null,
			smartFilterMaskId: decodedSmartFilterMask?.id ?? smartObject.smartFilterMask?.id ?? null,
			smartFilterMaskSourceKey: decodedSmartFilterMask?.sourceKey ?? smartObject.smartFilterMask?.sourceKey ?? null,
			smartFilterMaskDepth: decodedSmartFilterMask?.depth ?? smartObject.smartFilterMask?.depth ?? null,
			smartFilterMaskCompression: decodedSmartFilterMask?.compression ?? smartObject.smartFilterMask?.compression ?? null,
			smartFilterMaskLeft: decodedSmartFilterMask?.left ?? smartObject.smartFilterMask?.left ?? null,
			smartFilterMaskTop: decodedSmartFilterMask?.top ?? smartObject.smartFilterMask?.top ?? null,
			smartFilterMaskWidth: decodedSmartFilterMask?.width ?? smartObject.smartFilterMask?.width ?? null,
			smartFilterMaskHeight: decodedSmartFilterMask?.height ?? smartObject.smartFilterMask?.height ?? null,
			smartFilterMaskCoverageMinimum: decodedSmartFilterMask?.coverageMinimum ?? null,
			smartFilterMaskCoverageMaximum: decodedSmartFilterMask?.coverageMaximum ?? null,
			smartFilterMaskExecutionModel: decodedSmartFilterMask ? "bounded-smart-filter-mask-v1" : null,
			maskExecutionModel: "bounded-layer-mask-v1",
			maskCoverageMinimum: coverage.reduce((minimum, value) => Math.min(minimum, value), 255),
			maskCoverageMaximum: coverage.reduce((maximum, value) => Math.max(maximum, value), 0),
			executionModel: rendered.executionModel,
		});
	}
	if (!selected.length && !selectedSmartObjectResources.length && !selectedExternalSmartObjectResources.length) {
		throw new Error("The PSD contains no selected extractable pixel layers, supported isolated groups, or selected embedded smart-object payloads.");
	}
	if (selected.length > MAXIMUM_EXTRACTED_LAYERS) {
		throw new Error(`PSD extraction selected ${selected.length} layers; specify layerIndices to select at most ${MAXIMUM_EXTRACTED_LAYERS}.`);
	}
	const destination = resolveDestinationFolder(absoluteSource, options.destinationFolder);
	const bytesByPath = new Map<string, Buffer>();
	const items: IPsdLayerExtractionItem[] = [];
	const smartObjectPayloads: IPsdSmartObjectPayloadExtractionItem[] = [];
	let totalOutputBytes = 0;
	const backgroundLayerInfo = [...document.layers]
		.reverse()
		.find(
			(candidate) =>
				candidate.visible &&
				candidate.kind === "pixel" &&
				candidate.transparencyProtected &&
				!candidate.hasTransparency &&
				candidate.left === 0 &&
				candidate.top === 0 &&
				candidate.right === document.width &&
				candidate.bottom === document.height &&
				candidate.opacity === 255 &&
				candidate.fillOpacity === 255 &&
				candidate.blendMode === "norm" &&
				!candidate.clipping
		);
	const deepKnockoutCanvas = backgroundLayerInfo ? (decodedByIndex.get(backgroundLayerInfo.index) ?? null) : null;
	const deepKnockoutLayerIndices = backgroundLayerInfo ? [backgroundLayerInfo.index] : [];
	const renderFlatKnockoutBackdrop = (aboveLayerIndex: number): { layer: IDecodedPsdLayer; layerIndices: number[] } => {
		const candidates = document.layers.slice(aboveLayerIndex + 1).filter((candidate) => candidate.visible);
		if (
			candidates.some(
				(candidate) =>
					candidate.kind !== "pixel" ||
					candidate.clipping ||
					candidate.advancedBlending.knockout !== "none" ||
					candidate.advancedBlending.blendInteriorEffectsAsGroup !== null ||
					candidate.advancedBlending.blendClippedLayersAsGroup === false ||
					(hasEnabledLayerEffects(candidate) && !enabledLayerEffectsAreBakeSupported(candidate))
			)
		) {
			throw new Error(
				`PSD standalone knockout layer ${document.layers[aboveLayerIndex].name} (${aboveLayerIndex}) requires a bounded flat pixel backdrop; nested groups, adjustments, clipping stacks, lower knockouts, and unsupported lower effects are not approximated.`
			);
		}
		let backdrop: IDecodedPsdLayer | null = null;
		const layerIndices: number[] = [];
		for (const candidate of [...candidates].sort((left, right) => right.index - left.index)) {
			let decoded = decodedByIndex.get(candidate.index);
			if (!decoded) {
				throw new Error(`PSD standalone knockout backdrop layer ${candidate.name} (${candidate.index}) passed inspection but did not decode.`);
			}
			assertPsdTransparencyFillBlendSupported(decoded);
			decoded = applyLayerEffects ? bakeAuthoredLayerEffects(decoded, document, decodedPatterns).layer : applyPsdFillOpacity(decoded);
			backdrop = compositeLayerOver(backdrop, decoded);
			layerIndices.push(candidate.index);
		}
		backdrop ??= {
			...(decodedByIndex.get(aboveLayerIndex) ?? document.layers[aboveLayerIndex]),
			left: 0,
			top: 0,
			right: document.width,
			bottom: document.height,
			width: document.width,
			height: document.height,
			opacity: 255,
			blendMode: "norm",
			pixels: new Uint8Array(document.width * document.height * 4),
		};
		return { layer: backdrop, layerIndices };
	};
	for (const layer of selected) {
		const groupCompositeInfo = groupCompositeByStart.get(layer.index);
		const backdropDependentGroup =
			groupCompositeInfo?.executionModel === "bounded-knockout-group-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-opacity-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-mask-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-mask-effects-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-effects-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-adjustments-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-mask-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-effects-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-effects-behind-v1" ||
			groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-adjustments-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-blends-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1" ||
			groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1";
		if (
			layer.kind === "groupStart" &&
			backdropDependentGroup &&
			applyLayerEffects &&
			hasEnabledLayerEffects(layer) &&
			layer.advancedBlending.transparencyShapesLayer !== null
		) {
			throw new Error(
				`PSD Pass Through group ${layer.name} (${layer.index}) declares tsly with active effects; exact transparency-shape execution requires an isolated bounded group and cannot reuse a backdrop-dependent effect model.`
			);
		}
		const passThroughBackdrop = backdropDependentGroup && groupCompositeInfo ? renderPassThroughBackdrop(groupCompositeInfo, decodedByIndex) : null;
		let renderedGroup =
			layer.kind === "groupStart" && groupCompositeInfo
				? renderIsolatedGroup({
						source,
						document,
						info: groupCompositeInfo,
						groupByStart: groupCompositeByStart,
						decodedByIndex,
						decodedPatterns,
						clipping: groups,
						scopes: groupScopes,
						includeHidden,
						applyLayerEffects,
						applyGroupEffects:
							groupCompositeInfo.executionModel !== "bounded-backdrop-pass-through-blends-effects-v1" &&
							groupCompositeInfo.executionModel !== "bounded-backdrop-pass-through-blends-effects-behind-v1" &&
							groupCompositeInfo.executionModel !== "bounded-nested-backdrop-pass-through-effects-v1" &&
							groupCompositeInfo.executionModel !== "bounded-nested-backdrop-pass-through-mask-effects-v1" &&
							groupCompositeInfo.executionModel !== "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" &&
							groupCompositeInfo.executionModel !== "bounded-nested-backdrop-pass-through-effects-adjustments-v1",
						applyAdjustments,
						compositeClippingGroups,
						applyExternalAdjustments: !backdropDependentGroup,
						initialCanvas:
							groupCompositeInfo.executionModel === "bounded-knockout-group-v1" ||
							groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-adjustments-v1" ||
							groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-v1" ||
							groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-mask-v1" ||
							groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-effects-v1" ||
							groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-effects-behind-v1" ||
							groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-adjustments-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-blends-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1" ||
							groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1"
								? (passThroughBackdrop ?? undefined)
								: undefined,
						shallowKnockoutLayerIndices: groupCompositeInfo.backdropLayerIndices,
						deepKnockoutCanvas,
						deepKnockoutLayerIndices,
					})
				: null;
		if (
			renderedGroup &&
			(groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
				groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
				groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
				groupCompositeInfo?.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1") &&
			passThroughBackdrop
		) {
			renderedGroup = renderBackdropDependentGroupEffects(
				{
					source,
					document,
					info: groupCompositeInfo,
					groupByStart: groupCompositeByStart,
					decodedByIndex,
					decodedPatterns,
					clipping: groups,
					scopes: groupScopes,
					includeHidden,
					applyLayerEffects,
					applyGroupEffects: false,
					applyAdjustments,
					compositeClippingGroups,
					applyExternalAdjustments: false,
					initialCanvas: passThroughBackdrop,
				},
				passThroughBackdrop
			);
		}
		if (renderedGroup && groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-effects-v1") {
			const effectShape = renderIsolatedGroup({
				source,
				document,
				info: groupCompositeInfo,
				groupByStart: groupCompositeByStart,
				decodedByIndex,
				decodedPatterns,
				clipping: groups,
				scopes: groupScopes,
				includeHidden,
				applyLayerEffects,
				applyGroupEffects: false,
				applyAdjustments,
				compositeClippingGroups,
				applyExternalAdjustments: false,
			});
			const baked = bakeLayerEffects(renderedGroup.layer, document, decodedPatterns, effectShape.layer);
			renderedGroup.layer = baked.layer;
			renderedGroup.appliedLayerEffects.push(...baked.applied);
		}
		if (renderedGroup && groupCompositeInfo?.executionModel === "bounded-backdrop-pass-through-blends-effects-behind-v1" && passThroughBackdrop) {
			const effectShape = renderIsolatedGroup({
				source,
				document,
				info: groupCompositeInfo,
				groupByStart: groupCompositeByStart,
				decodedByIndex,
				decodedPatterns,
				clipping: groups,
				scopes: groupScopes,
				includeHidden,
				applyLayerEffects,
				applyGroupEffects: false,
				applyAdjustments,
				compositeClippingGroups,
				applyExternalAdjustments: false,
			});
			const group = document.layers[groupCompositeInfo.groupStartIndex];
			const behindBase: IDecodedPsdLayer = {
				...passThroughBackdrop,
				...group,
				left: passThroughBackdrop.left,
				top: passThroughBackdrop.top,
				right: passThroughBackdrop.right,
				bottom: passThroughBackdrop.bottom,
				width: passThroughBackdrop.width,
				height: passThroughBackdrop.height,
				opacity: 255,
				blendMode: "norm",
				pixels: passThroughBackdrop.pixels,
			};
			const behind = bakeLayerEffects(behindBase, document, decodedPatterns, effectShape.layer, "behind");
			renderedGroup = renderIsolatedGroup({
				source,
				document,
				info: groupCompositeInfo,
				groupByStart: groupCompositeByStart,
				decodedByIndex,
				decodedPatterns,
				clipping: groups,
				scopes: groupScopes,
				includeHidden,
				applyLayerEffects,
				applyGroupEffects: false,
				applyAdjustments,
				compositeClippingGroups,
				applyExternalAdjustments: false,
				initialCanvas: behind.layer,
			});
			const foreground = bakeLayerEffects(renderedGroup.layer, document, decodedPatterns, effectShape.layer, "foreground");
			renderedGroup.layer = foreground.layer;
			const evidence = [...behind.applied, ...foreground.applied];
			for (const effect of evidence) {
				if (!renderedGroup.appliedLayerEffects.some((candidate) => candidate.effectIndex === effect.effectIndex && candidate.type === effect.type)) {
					renderedGroup.appliedLayerEffects.push(effect);
				}
			}
		}
		if (renderedGroup && backdropDependentGroup && groupCompositeInfo && passThroughBackdrop) {
			const fullComposite =
				groupCompositeInfo.executionModel === "bounded-knockout-group-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-adjustments-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-mask-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-effects-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-effects-behind-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-adjustments-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-blends-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1" ||
				groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1"
					? renderedGroup.layer
					: compositeLayerOver(passThroughBackdrop, renderedGroup.layer);
			let maskCoverage: Uint8Array | undefined;
			const appliedBackdropMasks = [...renderedGroup.appliedGroupMasks];
			if (
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-mask-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-mask-effects-v1" ||
				groupCompositeInfo.executionModel === "bounded-backdrop-pass-through-blends-mask-v1" ||
				(groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" &&
					((layer.mask && !layer.mask.disabled) || (layer.vectorMask && !layer.vectorMask.disabled))) ||
				(groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" &&
					((layer.mask && !layer.mask.disabled) || (layer.vectorMask && !layer.vectorMask.disabled))) ||
				(groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" &&
					((layer.mask && !layer.mask.disabled) || (layer.vectorMask && !layer.vectorMask.disabled))) ||
				(groupCompositeInfo.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" &&
					((layer.mask && !layer.mask.disabled) || (layer.vectorMask && !layer.vectorMask.disabled)))
			) {
				const mask = decodePsdLayerMasks(source, [layer.index], {
					left: fullComposite.left,
					top: fullComposite.top,
					width: fullComposite.width,
					height: fullComposite.height,
				})[0];
				if (!mask) {
					throw new Error(`PSD pass-through group ${layer.name} (${layer.index}) passed mask inspection but produced no bounded backdrop mask coverage.`);
				}
				maskCoverage = mask.coverage;
				appliedBackdropMasks.push({
					groupIndex: layer.index,
					groupId: layer.id,
					name: layer.name,
					executionModel: groupCompositeInfo.executionModel,
					application: "backdrop-interpolation",
					maskCoverageMinimum: mask.coverage.reduce((minimum, value) => Math.min(minimum, value), 255),
					maskCoverageMaximum: mask.coverage.reduce((maximum, value) => Math.max(maximum, value), 0),
				});
			}
			renderedGroup = {
				...renderedGroup,
				layer: interpolatePassThroughGroupOpacity(passThroughBackdrop, fullComposite, groupCompositeInfo.groupOpacity, maskCoverage, layer.channelBlendingRestrictions),
				appliedGroupMasks: appliedBackdropMasks,
				backdropLayerIndices: [...groupCompositeInfo.backdropLayerIndices],
				backdropBlendModes: [...groupCompositeInfo.backdropBlendModes],
				backdropIncluded: true,
			};
			const externalAdjustments = applicableAdjustments(document, layer.index, groups, groupScopes).sort((left, right) => right.index - left.index);
			for (const adjustment of externalAdjustments) {
				renderedGroup.layer = applyAdjustmentWithEvidence(source, renderedGroup.layer, adjustment, renderedGroup.appliedAdjustments);
			}
		}
		let decodedLayer = renderedGroup?.layer ?? decodedByIndex.get(layer.index);
		if (!decodedLayer) {
			throw new Error(`PSD layer ${layer.index} passed inspection but did not decode.`);
		}
		let shapeLayer = decodedLayer;
		const appliedLayerEffects: IPsdAppliedLayerEffect[] = renderedGroup ? [...renderedGroup.appliedLayerEffects] : [];
		const appliedInteriorEffectBlending: IPsdLayerExtractionItem["appliedInteriorEffectBlending"] = renderedGroup ? [...renderedGroup.appliedInteriorEffectBlending] : [];
		const appliedClippedLayerBlending: IPsdLayerExtractionItem["appliedClippedLayerBlending"] = renderedGroup ? [...renderedGroup.appliedClippedLayerBlending] : [];
		const appliedTransparencyShaping: IPsdLayerExtractionItem["appliedTransparencyShaping"] = renderedGroup ? [...renderedGroup.appliedTransparencyShaping] : [];
		const appliedKnockouts: IPsdLayerExtractionItem["appliedKnockouts"] = renderedGroup ? [...renderedGroup.appliedKnockouts] : [];
		let appliedLayerStyleMask: IPsdLayerExtractionItem["appliedLayerStyleMask"] = null;
		let appliedVectorStyleMask: IPsdLayerExtractionItem["appliedVectorStyleMask"] = null;
		const appliedAdjustments: IPsdLayerExtractionItem["appliedAdjustments"] = renderedGroup ? [...renderedGroup.appliedAdjustments] : [];
		const appliedGroupMasks: IPsdLayerExtractionItem["appliedGroupMasks"] = renderedGroup ? [...renderedGroup.appliedGroupMasks] : [];
		let adjustmentWarnings: string[] = [];
		let eligibleClippingLayers: IDecodedPsdLayer[] = [];
		const clippedLayers: IDecodedPsdLayer[] = [];
		if (!renderedGroup) {
			if (applyLayerEffects) {
				const baked = bakeAuthoredLayerEffects(decodedLayer, document, decodedPatterns);
				decodedLayer = baked.layer;
				appliedLayerEffects.push(...baked.applied);
				if (baked.evidence) {
					appliedTransparencyShaping.push(baked.evidence);
				}
			} else {
				decodedLayer = applyPsdFillOpacity(decodedLayer);
			}
			const styledMask = applyGlobalLayerStyleMask(source, decodedLayer, layer);
			decodedLayer = styledMask.layer;
			appliedLayerStyleMask = styledMask.evidence;
			if (styledMask.evidence) {
				shapeLayer = applyGlobalLayerStyleMask(source, shapeLayer, layer).layer;
			}
			const styledVectorMask = applyGlobalVectorStyleMask(source, decodedLayer, layer);
			decodedLayer = styledVectorMask.layer;
			appliedVectorStyleMask = styledVectorMask.evidence;
			if (styledVectorMask.evidence) {
				shapeLayer = applyGlobalVectorStyleMask(source, shapeLayer, layer).layer;
			}
			const clippedGroupIndices = compositeClippingGroups ? (groups.get(layer.index) ?? []) : [];
			const clippedGroupSet = new Set(clippedGroupIndices);
			const clippedKnockoutLayers = clippedGroupIndices
				.map((index) => document.layers[index])
				.filter((candidate) => candidate.visible && candidate.kind === "pixel" && candidate.advancedBlending.knockout !== "none");
			const hasContextualKnockout = layer.advancedBlending.knockout !== "none" || clippedKnockoutLayers.length > 0;
			if (layer.advancedBlending.blendInteriorEffectsAsGroup !== null && clippedGroupIndices.length) {
				throw new Error(
					`PSD layer ${layer.name} (${layer.index}) declares infx inside a clipping group; exact combined infx/clbl execution requires the clipping advanced-blending model.`
				);
			}
			if (layer.advancedBlending.blendClippedLayersAsGroup === false && clippedGroupIndices.length) {
				throw new Error(
					`PSD clipping base ${layer.name} (${layer.index}) declares clbl=false; exact independent clipped-layer blending requires extraction through a bounded parent group backdrop.`
				);
			}
			if (hasContextualKnockout) {
				if (layer.clipping) {
					throw new Error(`PSD standalone clipped layer ${layer.name} (${layer.index}) must be extracted through its clipping base to execute knockout exactly.`);
				}
				if (
					layer.advancedBlending.blendInteriorEffectsAsGroup !== null ||
					layer.advancedBlending.layerMaskAsGlobalMask === true ||
					layer.advancedBlending.vectorMaskAsGlobalMask === true
				) {
					throw new Error(`PSD standalone knockout layer ${layer.name} (${layer.index}) combines knockout with an unsupported advanced-style ordering.`);
				}
				const backdrop = renderFlatKnockoutBackdrop(layer.index);
				if (layer.advancedBlending.knockout !== "none") {
					const destination = deepKnockoutCanvas;
					const punched = applyPsdKnockout(backdrop.layer, destination, shapeLayer);
					decodedLayer = compositeLayerOver(punched, decodedLayer);
					appliedKnockouts.push({
						layerIndex: layer.index,
						layerId: layer.id,
						name: layer.name,
						sourceKey: "knko",
						knockout: layer.advancedBlending.knockout,
						fillOpacity: layer.fillOpacity,
						stoppingBoundary: destination ? "background" : "transparency",
						destinationLayerIndices: deepKnockoutLayerIndices,
						executionModel: "bounded-knockout-v1",
					});
				} else {
					decodedLayer = compositeLayerOver(backdrop.layer, decodedLayer);
				}
			}
			const clippingBaseDestination = decodedLayer;
			eligibleClippingLayers = clippedGroupIndices
				.map((index) => decodedByIndex.get(index))
				.filter((candidate): candidate is IDecodedPsdLayer => candidate !== undefined && (includeHidden || candidate.visible));
			const adjustmentCandidates = document.layers.filter(
				(candidate) =>
					candidate.index < layer.index && candidate.kind === "adjustment" && candidate.visible && (!candidate.clipping || clippedGroupSet.has(candidate.index))
			);
			const adjustmentByIndex = new Map(
				(applyAdjustments ? applicableAdjustments(document, layer.index, groups, groupScopes) : []).map((adjustment) => [adjustment.index, adjustment])
			);
			const adjustmentMasks = new Map(
				decodePsdAdjustmentMasks(source, [...adjustmentByIndex.keys()], {
					left: decodedLayer.left,
					top: decodedLayer.top,
					width: decodedLayer.width,
					height: decodedLayer.height,
				}).map((mask) => [mask.layerIndex, mask])
			);
			adjustmentWarnings = adjustmentCandidates
				.filter((candidate) => !adjustmentByIndex.has(candidate.index))
				.map((candidate) => {
					if (!applyAdjustments) {
						return `Adjustment layer ${candidate.name} (${candidate.adjustment?.key ?? "unknown"}) was not applied because adjustment compositing is disabled.`;
					}
					if (!candidate.adjustment?.bakeSupported) {
						return `Adjustment layer ${candidate.name} (${candidate.adjustment?.key ?? "unknown"}) exceeds the bounded RGB execution model.`;
					}
					if (candidate.mask || candidate.vectorMask) {
						return `Adjustment layer ${candidate.name} (${candidate.adjustment.key}) has an unsupported/missing raster channel or unbounded vector mask.`;
					}
					if (crossedPassThroughGroups(document, candidate.index, layer.index, groupScopes) === null) {
						return `Adjustment layer ${candidate.name} (${candidate.adjustment.key}) crosses a PSD group boundary; bounded isolated-layer extraction preserves it as evidence instead of applying it to the wrong scope.`;
					}
					return `Adjustment layer ${candidate.name} (${candidate.adjustment.key}) uses unsupported blend mode ${candidate.blendMode}.`;
				});
			for (let stackIndex = layer.index - 1; stackIndex >= 0; --stackIndex) {
				const adjustmentLayer = adjustmentByIndex.get(stackIndex);
				if (adjustmentLayer?.adjustment) {
					const mask = adjustmentMasks.get(adjustmentLayer.index);
					const crossedGroups = crossedPassThroughGroups(document, adjustmentLayer.index, layer.index, groupScopes) ?? [];
					decodedLayer = { ...decodedLayer, pixels: applyPsdLayerAdjustment(decodedLayer.pixels, adjustmentLayer.adjustment, adjustmentLayer.opacity, mask?.coverage) };
					appliedAdjustments.push({
						layerIndex: adjustmentLayer.index,
						layerId: adjustmentLayer.id,
						name: adjustmentLayer.name,
						key: adjustmentLayer.adjustment.key,
						opacity: adjustmentLayer.opacity,
						clipping: adjustmentLayer.clipping,
						settings: adjustmentLayer.adjustment,
						executionModel: adjustmentLayer.adjustment.executionModel,
						maskExecutionModel: mask?.executionModel ?? null,
						maskCoverageMinimum: mask ? mask.coverage.reduce((minimum, value) => Math.min(minimum, value), 255) : null,
						maskCoverageMaximum: mask ? mask.coverage.reduce((maximum, value) => Math.max(maximum, value), 0) : null,
						groupExecutionModel: crossedGroups.length ? "bounded-pass-through-groups-v1" : null,
						crossedGroupIndices: crossedGroups,
					});
					continue;
				}
				if (!clippedGroupSet.has(stackIndex)) {
					continue;
				}
				let candidate = decodedByIndex.get(stackIndex);
				if (!candidate || (!includeHidden && !candidate.visible) || !SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode)) {
					continue;
				}
				const candidateShape = candidate;
				if (applyLayerEffects) {
					const baked = bakeAuthoredLayerEffects(candidate, document, decodedPatterns);
					candidate = baked.layer;
					appliedLayerEffects.push(...baked.applied);
					if (baked.evidence) {
						appliedTransparencyShaping.push(baked.evidence);
					}
				} else {
					candidate = applyPsdFillOpacity(candidate);
				}
				if (candidate.advancedBlending.knockout !== "none") {
					if (candidate.advancedBlending.blendInteriorEffectsAsGroup !== null) {
						throw new Error(
							`PSD clipped layer ${candidate.name} (${candidate.index}) combines knockout with infx; exact interior-effect/knockout ordering is outside the bounded model.`
						);
					}
					const destination = candidate.advancedBlending.knockout === "shallow" ? clippingBaseDestination : deepKnockoutCanvas;
					decodedLayer = applyPsdKnockout(decodedLayer, destination, candidateShape);
					appliedKnockouts.push({
						layerIndex: candidate.index,
						layerId: candidate.id,
						name: candidate.name,
						sourceKey: "knko",
						knockout: candidate.advancedBlending.knockout,
						fillOpacity: candidate.fillOpacity,
						stoppingBoundary: candidate.advancedBlending.knockout === "shallow" ? "clipping-base" : destination ? "background" : "transparency",
						destinationLayerIndices: candidate.advancedBlending.knockout === "shallow" ? [layer.index] : deepKnockoutLayerIndices,
						executionModel: "bounded-knockout-v1",
					});
				}
				clippedLayers.push(candidate);
				decodedLayer = compositeClippingLayers(decodedLayer, [candidate], shapeLayer);
			}
		}
		const bytes = await encodeLayer(decodedLayer, applyOpacity);
		totalOutputBytes += bytes.byteLength;
		if (totalOutputBytes > MAXIMUM_EXTRACTED_BYTES) {
			throw new Error("Encoded PSD layer outputs exceed the 256 MiB extraction limit.");
		}
		const absoluteOutput = join(destination, portableLayerName(layer));
		assertContained(absoluteOutput, "PSD layer output");
		const contentHash = createHash("sha256").update(bytes).digest("hex");
		let action: IPsdLayerExtractionItem["action"] = "create";
		if (await pathExists(absoluteOutput)) {
			if ((await stat(absoluteOutput)).isDirectory()) {
				action = "conflict";
			} else {
				action =
					createHash("sha256")
						.update(await readFile(absoluteOutput))
						.digest("hex") === contentHash
						? "reuse"
						: "conflict";
			}
		}
		const path = portablePath(absoluteOutput);
		bytesByPath.set(path, bytes);
		const appliedWarningKeys = new Set(appliedLayerEffects.map((effect) => `${effect.layerIndex}:${effect.key}:${effect.effectIndex}`));
		const appliedMasks: IPsdLayerExtractionItem["appliedMasks"] = [];
		if (layer.mask && !layer.mask.disabled && layer.channels.some((channel) => channel.id === -2)) {
			appliedMasks.push({
				type: "primary",
				channelId: -2,
				left: layer.mask.left,
				top: layer.mask.top,
				width: layer.mask.width,
				height: layer.mask.height,
				defaultColor: layer.mask.defaultColor,
				inverted: layer.mask.inverted,
				positionRelativeToLayer: layer.mask.positionRelativeToLayer,
				density: layer.mask.userDensity,
				feather: layer.mask.userFeather,
				executionModel: "bounded-mask-parameters-v1",
			});
		}
		if (layer.mask?.realUserMask && !layer.mask.realUserMask.disabled && layer.channels.some((channel) => channel.id === -3)) {
			appliedMasks.push({
				type: "realUser",
				channelId: -3,
				left: layer.mask.realUserMask.left,
				top: layer.mask.realUserMask.top,
				width: layer.mask.realUserMask.width,
				height: layer.mask.realUserMask.height,
				defaultColor: layer.mask.realUserMask.defaultColor,
				inverted: layer.mask.realUserMask.inverted,
				positionRelativeToLayer: layer.mask.realUserMask.positionRelativeToLayer,
				density: null,
				feather: null,
				executionModel: "bounded-mask-parameters-v1",
			});
		}
		if (layer.vectorMask && !layer.vectorMask.disabled && layer.vectorMask.bakeSupported) {
			appliedMasks.push({
				type: "vector",
				sourceKey: layer.vectorMask.sourceKey,
				inverted: layer.vectorMask.inverted,
				notLinked: layer.vectorMask.notLinked,
				initialFill: layer.vectorMask.initialFill,
				fillRule: layer.vectorMask.fillRule,
				subpathCount: layer.vectorMask.subpaths.length,
				knotCount: layer.vectorMask.knotCount,
				density: layer.mask?.vectorDensity ?? null,
				feather: layer.mask?.vectorFeather ?? null,
				executionModel: layer.vectorMask.executionModel,
			});
		}
		const textRenderIndices = renderedGroup ? renderedGroup.childLayerIndices : [layer.index, ...clippedLayers.map((candidate) => candidate.index)];
		const appliedTextRenders = textRenderIndices.map((index) => appliedTextRenderByIndex.get(index)).filter((entry): entry is IPsdAppliedTextRender => entry !== undefined);
		const appliedSmartObjectRenders = textRenderIndices
			.map((index) => appliedSmartObjectRenderByIndex.get(index))
			.filter((entry): entry is IPsdAppliedSmartObjectRender => entry !== undefined);
		const embeddedPreviewWarning = "Smart-object placement metadata is preserved, while extraction uses the PSD's embedded preview raster";
		items.push({
			layerIndex: layer.index,
			layerId: layer.id,
			name: layer.name,
			visible: layer.visible,
			opacity: layer.opacity,
			left: decodedLayer.left,
			top: decodedLayer.top,
			width: decodedLayer.width,
			height: decodedLayer.height,
			path,
			byteLength: bytes.byteLength,
			contentHash,
			action,
			solidColorFill: layer.solidColorFill ?? null,
			patternFill: layer.patternFill ?? null,
			gradientFill: layer.gradientFill ?? null,
			vectorFill: layer.vectorFill ?? null,
			vectorStroke: layer.vectorStroke ?? null,
			vectorOrigination: layer.vectorOrigination ?? null,
			vectorRenderingVersion: layer.vectorRenderingVersion ?? null,
			pathList: layer.pathList ?? null,
			textLayer: layer.text ? { ...layer.text, rasterExecutionModel: appliedTextRenderByIndex.get(layer.index)?.executionModel ?? "embedded-text-raster-v1" } : null,
			smartObjectLayer: layer.smartObject
				? {
						...layer.smartObject,
						rasterExecutionModel: appliedSmartObjectRenderByIndex.get(layer.index)?.executionModel ?? "embedded-smart-object-raster-v1",
					}
				: null,
			appliedTextRenders,
			appliedSmartObjectRenders,
			warnings: [
				...(renderedGroup ? [...renderedGroup.warnings, ...extractionWarnings(layer, appliedWarningKeys, true)] : extractionWarnings(layer, appliedWarningKeys)).filter(
					(warning) => !appliedSmartObjectRenderByIndex.has(layer.index) || !warning.startsWith(embeddedPreviewWarning)
				),
				...adjustmentWarnings,
				...eligibleClippingLayers.flatMap((candidate) =>
					extractionWarnings(candidate, appliedWarningKeys).filter(
						(warning) =>
							(!appliedSmartObjectRenderByIndex.has(candidate.index) || !warning.startsWith(embeddedPreviewWarning)) &&
							(!SUPPORTED_CLIPPING_BLEND_MODES.has(candidate.blendMode) || (!warning.startsWith("Clipping-group composition") && !warning.startsWith("Blend mode")))
					)
				),
			],
			appliedMasks,
			appliedLayerStyleMask,
			appliedVectorStyleMask,
			appliedGroupMasks,
			appliedAdjustments,
			appliedLayerEffects,
			appliedInteriorEffectBlending,
			appliedClippedLayerBlending,
			appliedTransparencyShaping,
			appliedKnockouts,
			clippedLayerIndices: renderedGroup ? renderedGroup.childLayerIndices : clippedLayers.map((candidate) => candidate.index),
			clippedLayerNames: renderedGroup ? renderedGroup.childLayerNames : clippedLayers.map((candidate) => candidate.name),
			blendModes: renderedGroup ? renderedGroup.blendModes : clippedLayers.map((candidate) => candidate.blendMode),
			groupComposite:
				renderedGroup && groupCompositeInfo
					? {
							executionModel: groupCompositeInfo.executionModel,
							groupStartIndex: groupCompositeInfo.groupStartIndex,
							groupEndIndex: groupCompositeInfo.groupEndIndex,
							groupOpacity: groupCompositeInfo.groupOpacity,
							backdropLayerIndices: renderedGroup.backdropLayerIndices,
							backdropBlendModes: renderedGroup.backdropBlendModes,
							backdropIncluded: renderedGroup.backdropIncluded,
							childLayerIndices: renderedGroup.childLayerIndices,
							childLayerNames: renderedGroup.childLayerNames,
							blendModes: renderedGroup.blendModes,
							nestedGroupIndices: renderedGroup.nestedGroupIndices,
							passThroughGroupIndices: renderedGroup.passThroughGroupIndices,
							maximumDepth: renderedGroup.maximumDepth,
						}
					: null,
		});
	}
	for (const resource of [...selectedSmartObjectResources, ...selectedExternalSmartObjectResources]) {
		const externalBinding = preparedSmartObjectExternalBindings.find((entry) => entry.resource.index === resource.index) ?? null;
		const bytes = Buffer.from(resource.data);
		totalOutputBytes += bytes.byteLength;
		if (totalOutputBytes > MAXIMUM_EXTRACTED_BYTES) {
			throw new Error("Encoded PSD layer outputs and embedded smart-object payloads exceed the 256 MiB extraction limit.");
		}
		const absoluteOutput = join(destination, "smart-objects", portableSmartObjectPayloadName(resource));
		assertContained(absoluteOutput, "PSD smart-object payload output");
		const contentHash = createHash("sha256").update(bytes).digest("hex");
		let action: IPsdSmartObjectPayloadExtractionItem["action"] = "create";
		if (await pathExists(absoluteOutput)) {
			if ((await stat(absoluteOutput)).isDirectory()) {
				action = "conflict";
			} else {
				action =
					createHash("sha256")
						.update(await readFile(absoluteOutput))
						.digest("hex") === contentHash
						? "reuse"
						: "conflict";
			}
		}
		const path = portablePath(absoluteOutput);
		bytesByPath.set(path, bytes);
		smartObjectPayloads.push({
			resourceIndex: resource.index,
			resourceId: resource.id,
			name: resource.name,
			fileType: resource.fileType,
			sourceKey: resource.sourceKey,
			recordSignature: resource.recordSignature as "liFD" | "liFE",
			sourceType: externalBinding ? "externalBinding" : "embedded",
			sourcePath: externalBinding?.request.sourcePath ?? null,
			declaredFileSize: externalBinding ? (resource.external?.fileSize ?? 0) : null,
			sizeMatches: externalBinding ? (resource.external?.fileSize ?? 0) === bytes.byteLength : null,
			associatedLayerIndices: document.layers.filter((layer) => layer.smartObject?.linkedResource.resourceIndices.includes(resource.index)).map((layer) => layer.index),
			path,
			byteLength: bytes.byteLength,
			contentHash,
			action,
			executionModel: "bounded-smart-object-payload-publication-v1",
		});
	}
	const requestedTextRenders = [...preparedTextRenders.values()].map((entry): IPsdTextRenderRequest => {
		const { shaping, ...request } = entry.request;
		return shaping ? { ...request, shaping } : request;
	});
	const fingerprint = createHash("sha256")
		.update(source)
		.update("\0")
		.update(
			JSON.stringify({
				destinationFolder: portablePath(destination),
				includeHidden,
				applyOpacity,
				applyLayerEffects,
				applyAdjustments,
				compositeClippingGroups,
				compositeGroups,
				requestedLayerIndices,
				requestedTextRenders,
				extractSmartObjectPayloads,
				requestedSmartObjectResourceIds,
				requestedSmartObjectExternalBindings,
				shapeBlurKernelBindings,
				displacementMapBindings,
				inspectNestedSmartObjects,
				nestedSmartObjectMaximumDepth,
				renderEmbeddedSmartObjects,
				renderExternalSmartObjects,
				requestedSmartObjectRenderLayerIndices,
				nestedSmartObjectDocuments,
				items,
				smartObjectPayloads,
			})
		)
		.digest("hex");
	return {
		status: {
			version: 1,
			path: portablePath(absoluteSource),
			destinationFolder: portablePath(destination),
			includeHidden,
			applyOpacity,
			applyLayerEffects,
			applyAdjustments,
			compositeClippingGroups,
			compositeGroups,
			requestedLayerIndices,
			requestedTextRenders,
			extractSmartObjectPayloads,
			requestedSmartObjectResourceIds,
			requestedSmartObjectExternalBindings,
			shapeBlurKernelBindings,
			displacementMapBindings,
			inspectNestedSmartObjects,
			nestedSmartObjectMaximumDepth,
			renderEmbeddedSmartObjects,
			renderExternalSmartObjects,
			requestedSmartObjectRenderLayerIndices,
			nestedSmartObjectDocuments,
			nestedSmartObjectInspectedCount: nestedSmartObjectDocuments.filter((entry) => entry.status === "inspected").length,
			nestedSmartObjectBlockedCount: nestedSmartObjectDocuments.filter((entry) => entry.status !== "inspected").length,
			fingerprint,
			document,
			groupComposites,
			items,
			smartObjectPayloads,
			selectedLayerCount: items.length,
			createdCount: items.filter((item) => item.action === "create").length,
			reusedCount: items.filter((item) => item.action === "reuse").length,
			conflictCount: items.filter((item) => item.action === "conflict").length,
			smartObjectPayloadCreatedCount: smartObjectPayloads.filter((item) => item.action === "create").length,
			smartObjectPayloadReusedCount: smartObjectPayloads.filter((item) => item.action === "reuse").length,
			smartObjectPayloadConflictCount: smartObjectPayloads.filter((item) => item.action === "conflict").length,
			totalOutputBytes,
		},
		bytesByPath,
	};
}

/** Returns exact layer/output evidence without writing any assets. */
export async function getPsdLayerExtractionStatus(sourcePath: string, options: IPsdLayerExtractionOptions = {}): Promise<IPsdLayerExtractionStatus> {
	return (await preparePsdLayerExtraction(sourcePath, options)).status;
}

/** Publishes a complete no-overwrite extraction plan atomically and rolls back every newly created layer or embedded-payload asset on failure. */
export async function applyPsdLayerExtraction(sourcePath: string, options: IPsdLayerExtractionOptions, expectedFingerprint: string): Promise<IPsdLayerExtractionStatus> {
	const prepared = await preparePsdLayerExtraction(sourcePath, options);
	if (prepared.status.fingerprint !== expectedFingerprint) {
		throw new Error(`PSD layer extraction plan changed. Inspect again and use current fingerprint ${prepared.status.fingerprint}.`);
	}
	const totalConflicts = prepared.status.conflictCount + prepared.status.smartObjectPayloadConflictCount;
	if (totalConflicts) {
		throw new Error(
			`${totalConflicts} PSD layer or embedded smart-object output path(s) contain different content. Choose another destinationFolder; existing assets are never overwritten.`
		);
	}
	const root = projectDirectory();
	const created: string[] = [];
	const temporary: string[] = [];
	try {
		await ensureDir(resolve(root, prepared.status.destinationFolder));
		const outputs = [...prepared.status.items, ...prepared.status.smartObjectPayloads].filter((entry) => entry.action === "create");
		for (const item of outputs) {
			const outputPath = resolve(root, item.path);
			if (await pathExists(outputPath)) {
				throw new Error(`PSD output appeared after inspection and was not overwritten: ${item.path}.`);
			}
			await ensureDir(dirname(outputPath));
			const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
			temporary.push(temporaryPath);
			await writeFile(temporaryPath, prepared.bytesByPath.get(item.path)!);
			await move(temporaryPath, outputPath, { overwrite: false });
			created.push(outputPath);
		}
		return prepared.status;
	} catch (error) {
		await Promise.allSettled([...temporary, ...created].map((path) => remove(path)));
		throw error;
	}
}

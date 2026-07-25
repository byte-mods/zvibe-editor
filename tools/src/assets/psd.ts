import { unzlibSync } from "fflate";

export type PsdColorMode = "grayscale" | "rgb";
export type PsdChannelDepth = 8 | 16 | 32;
export type PsdChannelConversionModel = "identity-uint8" | "bounded-uint16-to-rgba8-v1" | "bounded-linear-float32-to-rgba8-v1";
export type PsdCompression = "raw" | "rle" | "zip" | "zipPrediction";
export type PsdLayerCompression = "raw" | "rle" | "zip" | "zipPrediction" | "unsupported";
export type PsdLayerInfoSource = "primary" | "Layr" | "Lr16" | "Lr32";
export type PsdLayerKind = "pixel" | "adjustment" | "groupStart" | "groupEnd" | "other";
export type PsdLayerSheetColor = "none" | "red" | "orange" | "yellow" | "green" | "blue" | "violet" | "gray" | "unknown";
export type PsdLayerBlendingChannel = "red" | "green" | "blue" | "gray";
export type PsdSolidColorFillModel = "rgb" | "floatRgb" | "hsb" | "cmyk" | "gray" | "lab" | "unknown";
const PSD_LAYER_SHEET_COLORS: readonly Exclude<PsdLayerSheetColor, "unknown">[] = ["none", "red", "orange", "yellow", "green", "blue", "violet", "gray"];
export type PsdLayerAdjustmentKey =
	| "blnc"
	| "blwh"
	| "brit"
	| "clrL"
	| "curv"
	| "expA"
	| "grdm"
	| "hue "
	| "hue2"
	| "levl"
	| "mixr"
	| "nvrt"
	| "phfl"
	| "post"
	| "selc"
	| "thrs"
	| "vibA";
export type PsdLegacyBevelStyle = "outer bevel" | "inner bevel" | "emboss" | "pillow emboss" | "stroke emboss" | "unknown";
export type PsdModernLayerEffectDescriptorKey =
	| "IrSh"
	| "innerShadowMulti"
	| "DrSh"
	| "dropShadowMulti"
	| "IrGl"
	| "OrGl"
	| "ebbl"
	| "ChFX"
	| "SoFi"
	| "solidFillMulti"
	| "GrFl"
	| "gradientFillMulti"
	| "FrFX"
	| "frameFXMulti"
	| "patternFill";

export interface IPsdModernLayerEffectDescriptorInfo {
	descriptorKey?: PsdModernLayerEffectDescriptorKey;
	descriptorListIndex?: number | null;
}

export interface IPsdLayerChannelInfo {
	id: number;
	compression: PsdLayerCompression;
	byteLength: number;
	depth: PsdChannelDepth;
	sampleByteLength: 1 | 2 | 4;
	conversionModel: PsdChannelConversionModel;
	width: number;
	height: number;
}

export interface IPsdSolidColorFillInfo {
	sourceKey: "SoCo";
	descriptorVersion: 16;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	colorClassId: string;
	colorEntryKeys: string[];
	colorEntryTypes: string[];
	colorModel: PsdSolidColorFillModel;
	authoredValues: number[];
	rgba: [number, number, number, 255] | null;
	renderBounds: "layer" | "document";
	coverageSource: "transparency-channel" | "opaque-generated";
	conversionModel: "identity-rgb8" | "bounded-srgb-v1" | "unsupported";
	executionModel: "bounded-solid-color-fill-layer-v1";
	bakeSupported: boolean;
}

export interface IPsdPatternFillInfo {
	sourceKey: "PtFl";
	descriptorVersion: 16;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	descriptorPaddingBytes: 0 | 1 | 2 | 3;
	patternClassId: string;
	patternEntryKeys: string[];
	patternEntryTypes: string[];
	pattern: IPsdLayerPatternInfo;
	renderBounds: "layer" | "document";
	coverageSource: "transparency-channel" | "opaque-generated";
	executionModel: "bounded-pattern-fill-layer-v1";
	bakeSupported: boolean;
}

export interface IPsdGradientFillInfo {
	sourceKey: "GdFl";
	descriptorVersion: 16;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	descriptorPaddingBytes: 0 | 1 | 2 | 3;
	gradientClassId: string;
	gradientEntryKeys: string[];
	gradientEntryTypes: string[];
	gradient: IPsdLayerGradientInfo;
	renderBounds: "layer" | "document";
	coverageSource: "transparency-channel" | "opaque-generated";
	executionModel: "bounded-gradient-fill-layer-v1";
	bakeSupported: boolean;
}

export type PsdVectorContentType = "color" | "gradient" | "pattern" | "unknown";
export type PsdVectorStrokeLineCap = "butt" | "round" | "square" | "unknown";
export type PsdVectorStrokeLineJoin = "miter" | "round" | "bevel" | "unknown";
export type PsdVectorStrokeLineAlignment = "inside" | "center" | "outside" | "unknown";

export interface IPsdVectorContentInfo {
	type: PsdVectorContentType;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	color: IPsdLayerEffectColorInfo | null;
	gradient: IPsdLayerGradientInfo | null;
	pattern: IPsdLayerPatternInfo | null;
	executionModel: "bounded-vector-content-v1";
	bakeSupported: boolean;
}

export interface IPsdVectorFillInfo {
	sourceKey: "vscg";
	contentKey: "SoCo" | "GdFl" | "PtFl";
	descriptorVersion: 16;
	descriptorPaddingBytes: 0 | 1 | 2 | 3;
	content: IPsdVectorContentInfo;
	executionModel: "bounded-vector-fill-v1";
	bakeSupported: boolean;
}

export interface IPsdVectorStrokeUnitInfo {
	value: number;
	units: "#Pxl" | "#Pnt" | "#Mlm" | "RrPi" | "RrIn" | "RrCm";
	pixels: number;
}

export interface IPsdVectorStrokeInfo {
	sourceKey: "vstk";
	descriptorVersion: 16;
	descriptorClassId: "strokeStyle";
	descriptorPaddingBytes: 0 | 1 | 2 | 3;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	strokeStyleVersion: 2;
	strokeEnabled: boolean;
	fillEnabled: boolean;
	lineWidth: IPsdVectorStrokeUnitInfo;
	lineDashOffset: IPsdVectorStrokeUnitInfo;
	miterLimit: number;
	lineCap: PsdVectorStrokeLineCap;
	lineJoin: PsdVectorStrokeLineJoin;
	lineAlignment: PsdVectorStrokeLineAlignment;
	scaleLock: boolean;
	strokeAdjust: boolean;
	lineDashSet: IPsdVectorStrokeUnitInfo[];
	blendMode: string;
	opacity: number;
	content: IPsdVectorContentInfo;
	resolution: number;
	executionModel: "bounded-vector-stroke-v1";
	bakeSupported: boolean;
	warnings: string[];
}

export interface IPsdVectorOriginationScalarInfo {
	value: number;
	units: string | null;
	pixels: number | null;
}

export interface IPsdVectorOriginationEntryInfo {
	listIndex: number;
	originIndex: number;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	unknownEntryKeys: string[];
	shapeInvalidated: boolean | null;
	originType: number | null;
	originResolution: number | null;
	shapeBoundingBox: {
		descriptorClassId: string;
		unitValueQuadVersion: 1;
		top: IPsdVectorOriginationScalarInfo;
		left: IPsdVectorOriginationScalarInfo;
		bottom: IPsdVectorOriginationScalarInfo;
		right: IPsdVectorOriginationScalarInfo;
	} | null;
	roundedRectangleRadii: {
		descriptorClassId: string;
		unitValueQuadVersion: 1;
		topRight: IPsdVectorOriginationScalarInfo;
		topLeft: IPsdVectorOriginationScalarInfo;
		bottomLeft: IPsdVectorOriginationScalarInfo;
		bottomRight: IPsdVectorOriginationScalarInfo;
	} | null;
	boxCorners: {
		descriptorClassId: string;
		corners: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
	} | null;
	transform: {
		descriptorClassId: string;
		matrix: [number, number, number, number, number, number];
	} | null;
}

export interface IPsdVectorOriginationInfo {
	sourceKey: "vogk";
	recordVersion: 1;
	descriptorVersion: 16;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	descriptorPaddingBytes: 0 | 1 | 2 | 3;
	entries: IPsdVectorOriginationEntryInfo[];
	association: "vector-mask" | "metadata-only";
	executionModel: "psd-vector-origination-v1";
	warnings: string[];
}

export interface IPsdVectorRenderingVersionInfo {
	sourceKey: "vowv";
	value: number;
	observedPhotoshopValue: boolean;
	executionModel: "psd-vector-rendering-version-v1";
}

export interface IPsdPathListInfo {
	sourceKey: "pths";
	descriptorVersion: 16;
	descriptorClassId: string;
	descriptorEntryKeys: string[];
	descriptorEntryTypes: string[];
	descriptorPaddingBytes: 0 | 1 | 2 | 3;
	unknownEntryKeys: string[];
	paths: Array<{
		listIndex: number;
		descriptorClassId: string;
		descriptorEntryKeys: string[];
		descriptorEntryTypes: string[];
		unknownEntryKeys: string[];
		unicodeName: string;
		symmetry: {
			descriptorClassId: string;
			descriptorEntryKeys: string[];
			descriptorEntryTypes: string[];
			modeType: "enum" | "TEXT";
			enumType: string | null;
			value: string;
			unknownEntryKeys: string[];
		};
	}>;
	executionModel: "psd-path-list-v1";
	warnings: string[];
}

export interface IPsdLayerMaskGeometryInfo {
	top: number;
	left: number;
	bottom: number;
	right: number;
	width: number;
	height: number;
	defaultColor: number;
	disabled: boolean;
	inverted: boolean;
	positionRelativeToLayer: boolean;
}

export interface IPsdLayerRealUserMaskInfo extends IPsdLayerMaskGeometryInfo {
	channelId: -3;
}

export interface IPsdLayerMaskInfo extends IPsdLayerMaskGeometryInfo {
	userDensity: number | null;
	userFeather: number | null;
	vectorDensity: number | null;
	vectorFeather: number | null;
	realUserMask: IPsdLayerRealUserMaskInfo | null;
}

export interface IPsdVectorMaskPointInfo {
	x: number;
	y: number;
}

export interface IPsdVectorMaskKnotInfo {
	linked: boolean;
	precedingControl: IPsdVectorMaskPointInfo;
	anchor: IPsdVectorMaskPointInfo;
	leavingControl: IPsdVectorMaskPointInfo;
}

export interface IPsdVectorMaskSubpathInfo {
	closed: boolean;
	knots: IPsdVectorMaskKnotInfo[];
}

export interface IPsdVectorMaskInfo {
	sourceKey: "vmsk" | "vsms";
	version: 3;
	inverted: boolean;
	notLinked: boolean;
	disabled: boolean;
	initialFill: 0 | 1;
	fillRule: "evenOdd";
	subpaths: IPsdVectorMaskSubpathInfo[];
	knotCount: number;
	executionModel: "bounded-vector-mask-v1";
	bakeSupported: boolean;
	warnings: string[];
}

export interface IPsdLevelsRecordInfo {
	inputFloor: number;
	inputCeiling: number;
	outputFloor: number;
	outputCeiling: number;
	gamma: number;
}

export interface IPsdCurvePointInfo {
	input: number;
	output: number;
}

export interface IPsdCurveChannelInfo {
	channel: number;
	points: IPsdCurvePointInfo[];
}

interface IPsdLayerAdjustmentBaseInfo {
	key: PsdLayerAdjustmentKey;
	executionModel: "bounded-adjustment-v1";
	bakeSupported: boolean;
}

export interface IPsdBrightnessContrastAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "brit";
	brightness: number;
	contrast: number;
	mean: number;
	labOnly: boolean;
}

export interface IPsdLevelsAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "levl";
	version: 2;
	records: IPsdLevelsRecordInfo[];
	master: IPsdLevelsRecordInfo;
	red: IPsdLevelsRecordInfo;
	green: IPsdLevelsRecordInfo;
	blue: IPsdLevelsRecordInfo;
}

export interface IPsdCurvesAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "curv";
	version: 1 | 4;
	curves: IPsdCurveChannelInfo[];
	master: IPsdCurvePointInfo[];
	red: IPsdCurvePointInfo[];
	green: IPsdCurvePointInfo[];
	blue: IPsdCurvePointInfo[];
}

export interface IPsdExposureAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "expA";
	version: 1;
	exposure: number;
	offset: number;
	gamma: number;
	colorModel: "linear-srgb-v1";
}

export interface IPsdVibranceAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "vibA";
	descriptorVersion: 16;
	paddingBytes: 0 | 1 | 2 | 3;
	vibrance: number;
	saturation: number;
	colorModel: "bounded-hsl-vibrance-v1";
}

export interface IPsdHueSaturationChannelInfo {
	name: "reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas";
	range: [number, number, number, number];
	hue: number;
	saturation: number;
	lightness: number;
}

export interface IPsdHueSaturationAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "hue " | "hue2";
	version: 2;
	sourceModel: "photoshop-4" | "photoshop-5+";
	hueUnitScale: 1 | 1.8;
	colorize: boolean;
	paddingByte: number;
	colorization: { hue: number; saturation: number; lightness: number };
	master: { hue: number; saturation: number; lightness: number };
	channels: IPsdHueSaturationChannelInfo[];
	localAdjustmentsPresent: boolean;
	localRangeModel: "normalized-hextant-feather-v1";
	colorModel: "bounded-hsl-hue-v2";
}

export interface IPsdColorBalanceToneInfo {
	cyanRed: number;
	magentaGreen: number;
	yellowBlue: number;
}

export interface IPsdColorBalanceAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "blnc";
	shadows: IPsdColorBalanceToneInfo;
	midtones: IPsdColorBalanceToneInfo;
	highlights: IPsdColorBalanceToneInfo;
	preserveLuminosity: boolean;
	paddingByte: 0;
	tonalModel: "piecewise-luminance-tones-v1";
	colorModel: "bounded-rgb-color-balance-v1";
}

export interface IPsdBlackWhiteAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "blwh";
	descriptorVersion: 16;
	paddingBytes: 0 | 1 | 2 | 3;
	reds: number;
	yellows: number;
	greens: number;
	cyans: number;
	blues: number;
	magentas: number;
	useTint: boolean;
	tintColor: IPsdLayerEffectColorInfo;
	presetKind: number;
	presetFileName: string;
	colorModel: "bounded-hue-mix-black-white-v1";
}

export interface IPsdChannelMixerChannelInfo {
	red: number;
	green: number;
	blue: number;
	constant: number;
	reservedWord: 0;
	total: number;
}

export interface IPsdChannelMixerAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "mixr";
	version: 1;
	monochrome: boolean;
	red: IPsdChannelMixerChannelInfo | null;
	green: IPsdChannelMixerChannelInfo | null;
	blue: IPsdChannelMixerChannelInfo | null;
	gray: IPsdChannelMixerChannelInfo;
	monochromePaddingBytes: 0 | 30;
	colorModel: "bounded-linear-channel-mixer-v1";
}

export interface IPsdSelectiveColorRangeInfo {
	cyan: number;
	magenta: number;
	yellow: number;
	black: number;
}

export interface IPsdSelectiveColorAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "selc";
	version: 1;
	mode: "relative" | "absolute";
	reservedBytes: 8;
	reds: IPsdSelectiveColorRangeInfo;
	yellows: IPsdSelectiveColorRangeInfo;
	greens: IPsdSelectiveColorRangeInfo;
	cyans: IPsdSelectiveColorRangeInfo;
	blues: IPsdSelectiveColorRangeInfo;
	magentas: IPsdSelectiveColorRangeInfo;
	whites: IPsdSelectiveColorRangeInfo;
	neutrals: IPsdSelectiveColorRangeInfo;
	blacks: IPsdSelectiveColorRangeInfo;
	rangeModel: "bounded-extrema-range-weights-v1";
	colorModel: "bounded-cmyk-selective-color-v1";
}

export interface IPsdGradientMapColorStopInfo {
	location: number;
	rawLocation: number;
	midpoint: number;
	color: IPsdLayerEffectColorInfo;
}

export interface IPsdGradientMapOpacityStopInfo {
	location: number;
	rawLocation: number;
	midpoint: number;
	opacity: number;
}

export interface IPsdGradientMapAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "grdm";
	version: 1 | 3;
	name: string;
	gradientType: "solid" | "noise";
	reverse: boolean;
	dither: boolean;
	method: "classic" | "perceptual" | "linear" | "smooth";
	smoothness: number;
	smoothnessRaw: number;
	colorStops: IPsdGradientMapColorStopInfo[];
	opacityStops: IPsdGradientMapOpacityStopInfo[];
	randomSeed: number;
	addTransparency: boolean;
	restrictColors: boolean;
	roughness: number;
	roughnessRaw: number;
	colorModel: "rgb" | "hsb" | "lab";
	minimum: [number, number, number, number];
	maximum: [number, number, number, number];
	gradientModel: "bounded-gradient-map-v1";
	noiseModel: "bounded-seeded-multioctave-v1";
}

export interface IPsdPhotoFilterAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "phfl";
	version: 2 | 3;
	color: IPsdLayerEffectColorInfo;
	labColor: { lightness: number; a: number; b: number } | null;
	density: number;
	densityRaw: number;
	preserveLuminosity: boolean;
	paddingBytes: number;
	colorModel: "bounded-hsl-photo-filter-v1";
}

export interface IPsdColorLookupAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "clrL";
	version: 1;
	descriptorVersion: 16;
	lookupType: "3dlut" | "abstractProfile" | "deviceLinkProfile";
	name: string;
	dither: boolean;
	profileBytes: number;
	lutFormat: "look" | "cube" | "3dl";
	dataOrder: "rgb" | "bgr";
	tableOrder: "rgb" | "bgr";
	lut3DFileBytes: number;
	lut3DFileName: string;
	lutSize: number | null;
	lutEntryCount: number;
	domainMinimum: [number, number, number];
	domainMaximum: [number, number, number];
	paddingBytes: 0 | 1 | 2 | 3;
	colorModel: "bounded-trilinear-color-lookup-v1";
}

export interface IPsdInvertAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "nvrt";
}

export interface IPsdPosterizeAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "post";
	levels: number;
}

export interface IPsdThresholdAdjustmentInfo extends IPsdLayerAdjustmentBaseInfo {
	key: "thrs";
	threshold: number;
}

export type IPsdLayerAdjustmentInfo =
	| IPsdBlackWhiteAdjustmentInfo
	| IPsdChannelMixerAdjustmentInfo
	| IPsdColorBalanceAdjustmentInfo
	| IPsdColorLookupAdjustmentInfo
	| IPsdBrightnessContrastAdjustmentInfo
	| IPsdCurvesAdjustmentInfo
	| IPsdExposureAdjustmentInfo
	| IPsdGradientMapAdjustmentInfo
	| IPsdVibranceAdjustmentInfo
	| IPsdHueSaturationAdjustmentInfo
	| IPsdLevelsAdjustmentInfo
	| IPsdInvertAdjustmentInfo
	| IPsdPosterizeAdjustmentInfo
	| IPsdPhotoFilterAdjustmentInfo
	| IPsdSelectiveColorAdjustmentInfo
	| IPsdThresholdAdjustmentInfo;

export interface IPsdLayerEffectColorInfo {
	space: number;
	components: [number, number, number, number];
	rgba: [number, number, number, 255] | null;
}

export interface IPsdLayerEffectContourInfo {
	name: string;
	points: Array<{ x: number; y: number }>;
	linear: boolean;
	valid: boolean;
}

export interface IPsdLayerSolidFillEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "sofi";
	index: number;
	version: 2;
	source?: "lfx2";
	present?: boolean;
	showInDialog?: boolean;
	enabled: boolean;
	opacity: number;
	blendMode: string;
	color: IPsdLayerEffectColorInfo;
	nativeColor: IPsdLayerEffectColorInfo;
	bakeSupported: boolean;
}

export interface IPsdLayerInnerShadowEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "isdw";
	index: number;
	version: 0 | 2;
	source?: "lfx2";
	present?: boolean;
	showInDialog?: boolean;
	enabled: boolean;
	blur: number;
	intensity: number;
	angle: number;
	distance: number;
	color: IPsdLayerEffectColorInfo;
	nativeColor: IPsdLayerEffectColorInfo | null;
	blendMode: string;
	useGlobalAngle: boolean;
	opacity: number;
	choke?: number;
	antialiased?: boolean;
	noise?: number;
	contour?: IPsdLayerEffectContourInfo | null;
	layerConceals?: boolean;
	executionModel?: "bounded-shadow-v2";
	bakeSupported: boolean;
}

export interface IPsdLayerInnerGlowEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "iglw";
	index: number;
	version: 0 | 2;
	source?: "lfx2";
	present?: boolean;
	showInDialog?: boolean;
	enabled: boolean;
	blur: number;
	intensity: number;
	color: IPsdLayerEffectColorInfo;
	nativeColor: IPsdLayerEffectColorInfo | null;
	blendMode: string;
	opacity: number;
	invert: boolean;
	choke?: number;
	antialiased?: boolean;
	noise?: number;
	range?: number;
	jitter?: number;
	glowSource?: "edge" | "center" | "unknown";
	technique?: "softer" | "precise" | "unknown";
	contour?: IPsdLayerEffectContourInfo | null;
	executionModel?: "bounded-glow-v2";
	bakeSupported: boolean;
}

export interface IPsdLayerDropShadowEffectInfo extends Omit<IPsdLayerInnerShadowEffectInfo, "key"> {
	key: "dsdw";
}

export interface IPsdLayerOuterGlowEffectInfo extends Omit<IPsdLayerInnerGlowEffectInfo, "key" | "invert"> {
	key: "oglw";
}

export interface IPsdLayerBevelEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "bevl";
	index: number;
	version: 0 | 2;
	enabled: boolean;
	angle: number;
	strength: number;
	blur: number;
	highlightBlendMode: string;
	shadowBlendMode: string;
	highlightColor: IPsdLayerEffectColorInfo;
	shadowColor: IPsdLayerEffectColorInfo;
	realHighlightColor: IPsdLayerEffectColorInfo | null;
	realShadowColor: IPsdLayerEffectColorInfo | null;
	style: number;
	styleName: PsdLegacyBevelStyle;
	highlightOpacity: number;
	shadowOpacity: number;
	useGlobalAngle: boolean;
	direction: number;
	source?: "lfx2";
	present?: boolean;
	showInDialog?: boolean;
	size?: number;
	depth?: number;
	soften?: number;
	altitude?: number;
	technique?: "smooth" | "chisel hard" | "chisel soft" | "unknown";
	useShape?: boolean;
	useTexture?: boolean;
	antialiasGloss?: boolean;
	contour?: IPsdLayerEffectContourInfo | null;
	shapeContour?: IPsdLayerEffectContourInfo | null;
	shapeRange?: number;
	shapeRangeUnits?: string;
	texturePattern?: IPsdLayerPatternInfo | null;
	textureDepth?: number;
	textureDepthUnits?: string;
	textureInvert?: boolean;
	executionModel?: "bounded-bevel-v1" | "bounded-bevel-v2";
	bakeSupported: boolean;
}

export interface IPsdLayerSatinEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "ChFX";
	index: number;
	source: "lfx2";
	present: boolean;
	showInDialog: boolean;
	enabled: boolean;
	color: IPsdLayerEffectColorInfo;
	blendMode: string;
	opacity: number;
	angle: number;
	distance: number;
	size: number;
	antialiased: boolean;
	invert: boolean;
	contour: IPsdLayerEffectContourInfo | null;
	executionModel: "bounded-satin-v1";
	bakeSupported: boolean;
}

export interface IPsdLayerStrokeEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "FrFX";
	index: number;
	source: "lfx2";
	enabled: boolean;
	present: boolean;
	showInDialog: boolean;
	position: "outside" | "center" | "inside" | "unknown";
	fillType: "solidColor" | "gradient" | "pattern" | "unknown";
	blendMode: string;
	opacity: number;
	size: number;
	sizeUnits: string;
	color: IPsdLayerEffectColorInfo;
	gradient: IPsdLayerGradientInfo | null;
	pattern: IPsdLayerPatternInfo | null;
	bakeSupported: boolean;
}

export type PsdPatternColorMode = "grayscale" | "indexed" | "rgb" | "unknown";

export interface IPsdEmbeddedPatternInfo {
	index: number;
	sourceTag: "Patt" | "Pat2" | "Pat3";
	name: string;
	id: string;
	x: number;
	y: number;
	left: number;
	top: number;
	width: number;
	height: number;
	colorMode: PsdPatternColorMode;
	channelCount: number;
	compressions: PsdLayerCompression[];
	bakeSupported: boolean;
	warnings: string[];
}

export interface IDecodedPsdPattern extends IPsdEmbeddedPatternInfo {
	pixels: Uint8Array;
}

export interface IPsdLayerPatternInfo {
	name: string;
	id: string;
	scale: number;
	scaleUnits: string;
	angle: number;
	angleUnits: string;
	align: boolean;
	linked: boolean;
	phaseX: number;
	phaseY: number;
	resolutionStatus: "resolved" | "missing" | "ambiguous" | "unsupported";
	resolvedPatternIndices: number[];
	resolvedPatternIndex: number | null;
	resolvedPatternName: string | null;
	resolvedWidth: number | null;
	resolvedHeight: number | null;
	executionModel: "bounded-pattern-v1";
	bakeSupported: boolean;
}

export interface IPsdLayerPatternOverlayEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "patternFill";
	index: number;
	source: "lfx2";
	enabled: boolean;
	present: boolean;
	showInDialog: boolean;
	blendMode: string;
	opacity: number;
	pattern: IPsdLayerPatternInfo;
	bakeSupported: boolean;
}

export interface IPsdLayerGradientOverlayEffectInfo extends IPsdModernLayerEffectDescriptorInfo {
	key: "GrFl";
	index: number;
	source: "lfx2";
	enabled: boolean;
	present: boolean;
	showInDialog: boolean;
	blendMode: string;
	opacity: number;
	gradient: IPsdLayerGradientInfo;
	bakeSupported: boolean;
}

export type PsdLayerGradientStyle = "linear" | "radial" | "angle" | "reflected" | "diamond" | "unknown";

export type PsdLayerGradientInterpolation = "perceptual" | "linear" | "classic" | "smooth" | "unknown";

export type PsdLayerNoiseGradientColorModel = "rgb" | "hsb" | "lab" | "hsl" | "unknown";

export interface IPsdLayerGradientColorStopInfo {
	location: number;
	rawLocation: number;
	midpoint: number;
	color: IPsdLayerEffectColorInfo;
}

export interface IPsdLayerGradientOpacityStopInfo {
	location: number;
	rawLocation: number;
	midpoint: number;
	opacity: number;
}

export interface IPsdLayerGradientInfo {
	type: "solid" | "noise" | "unknown";
	name: string;
	style: PsdLayerGradientStyle;
	interpolation: PsdLayerGradientInterpolation;
	samples: number;
	angle: number;
	angleUnits: string;
	scale: number;
	scaleUnits: string;
	reverse: boolean;
	align: boolean;
	dither: boolean;
	offsetX: number;
	offsetY: number;
	offsetUnits: string;
	colorStops: IPsdLayerGradientColorStopInfo[];
	opacityStops: IPsdLayerGradientOpacityStopInfo[];
	roughness?: number;
	roughnessRaw?: number;
	colorModel?: PsdLayerNoiseGradientColorModel;
	randomSeed?: number;
	restrictColors?: boolean;
	addTransparency?: boolean;
	minimum?: number[];
	maximum?: number[];
	minimumRaw?: number[];
	maximumRaw?: number[];
	executionModel?: "bounded-solid-v2" | "bounded-seeded-v1";
	bakeSupported: boolean;
}

export interface IPsdLayerEffectsInfo {
	version: 0;
	visible: boolean;
	effectCount: number;
	solidFills: IPsdLayerSolidFillEffectInfo[];
	innerShadows: IPsdLayerInnerShadowEffectInfo[];
	innerGlows: IPsdLayerInnerGlowEffectInfo[];
	dropShadows: IPsdLayerDropShadowEffectInfo[];
	outerGlows: IPsdLayerOuterGlowEffectInfo[];
	bevels: IPsdLayerBevelEffectInfo[];
	satins: IPsdLayerSatinEffectInfo[];
	strokes: IPsdLayerStrokeEffectInfo[];
	gradientOverlays: IPsdLayerGradientOverlayEffectInfo[];
	patternOverlays: IPsdLayerPatternOverlayEffectInfo[];
	unsupportedKeys: string[];
	descriptorVersion?: 16;
}

export interface IPsdTextLayerFontInfo {
	index: number;
	name: string;
	script: number;
	fontType: number;
	synthetic: number;
}

export interface IPsdTextLayerStyleRunInfo {
	length: number;
	fontIndex: number | null;
	fontName: string | null;
	language: number | null;
	fontSize: number | null;
	fauxBold: boolean;
	fauxItalic: boolean;
	fontCaps: "normal" | "small-caps" | "all-caps" | "unknown" | null;
	fontBaseline: "normal" | "superscript" | "subscript" | "unknown" | null;
	baselineDirection: "upright" | "mixed" | "tate-chu-yoko" | "unknown" | null;
	proportionalMetrics: boolean | null;
	kana: boolean | null;
	ruby: boolean | null;
	japaneseAlternateFeature: "normal" | "traditional" | "expert" | "jis78" | "unknown" | null;
	wariChuEnabled: boolean | null;
	wariChuLineCount: number | null;
	wariChuLineGap: number | null;
	wariChuScale: number | null;
	wariChuWidow: number | null;
	wariChuOrphan: number | null;
	wariChuJustification: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all" | "auto" | "unknown" | null;
	tsume: number | null;
	styleRunAlignment: "em-box-bottom-left" | "icf-bottom-left" | "em-box-center" | "roman-baseline" | "icf-top-right" | "em-box-top-right" | "unknown" | null;
	autoLeading: boolean | null;
	leading: number | null;
	tracking: number | null;
	kerning: number | null;
	autoKerning: boolean | null;
	ligatures: boolean | null;
	discretionaryLigatures: boolean | null;
	horizontalScale: number | null;
	verticalScale: number | null;
	baselineShift: number | null;
	underline: boolean;
	strikethrough: boolean;
	noBreak: boolean | null;
	fillColor: [number, number, number, number] | null;
	strokeColor: [number, number, number, number] | null;
	fillEnabled: boolean | null;
	strokeEnabled: boolean | null;
	fillFirst: boolean | null;
	outlineWidth: number | null;
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
	kashida: "off" | "on" | "unknown" | null;
	diacriticPosition: "opentype" | "loose" | "medium" | "tight" | "unknown" | null;
	characterDirection: "default" | "left-to-right" | "right-to-left" | "unknown" | null;
	figureStyle: "default" | "tabular-lining" | "proportional-oldstyle" | "proportional-lining" | "tabular-oldstyle" | "unknown" | null;
	engineData2StyleRunIndex: number | null;
	engineData2ExecutionModel: "disabled" | "bounded-global-txt2-engine-data2-v1";
}

export interface IPsdTextLayerParagraphRunInfo {
	length: number;
	justification: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all" | "unknown";
	firstLineIndent: number | null;
	startIndent: number | null;
	endIndent: number | null;
	spaceBefore: number | null;
	spaceAfter: number | null;
	autoHyphenate: boolean | null;
	hyphenatedWordSize: number | null;
	preHyphen: number | null;
	postHyphen: number | null;
	consecutiveHyphens: number | null;
	hyphenationZone: number | null;
	autoLeading: number | null;
	everyLineComposer: boolean | null;
}

export interface IPsdWarpInfo {
	style: string;
	value: number;
	perspective: number;
	perspectiveOther: number;
	rotate: "horizontal" | "vertical" | "unknown";
	bounds: { top: number; left: number; bottom: number; right: number; units: string } | null;
	uOrder: number | null;
	vOrder: number | null;
	deformNumRows: number | null;
	deformNumCols: number | null;
	meshPoints: Array<{ x: number; y: number }>;
	quiltSliceX: number[];
	quiltSliceY: number[];
	meshExecutionModel: "tensor" | "quilt" | null;
	meshExecutionSupported: boolean;
	meshWarning: string | null;
}

export interface IPsdTextLayerInfo {
	version: 1;
	textVersion: 50;
	descriptorVersion: 16;
	text: string;
	textIndex: number;
	transform: [number, number, number, number, number, number];
	orientation: "horizontal" | "vertical" | "unknown";
	antiAlias: "none" | "sharp" | "crisp" | "strong" | "smooth" | "platform" | "platformLCD" | "unknown";
	gridding: "none" | "round" | "unknown";
	shapeType: "point" | "box" | "unknown";
	pointBase: [number, number] | null;
	boxBounds: [number, number, number, number] | null;
	left: number;
	top: number;
	right: number;
	bottom: number;
	bounds: { left: number; top: number; right: number; bottom: number; units: string } | null;
	boundingBox: { left: number; top: number; right: number; bottom: number; units: string } | null;
	warp: IPsdWarpInfo;
	engineDataBytes: number;
	engineTextMatchesDescriptor: boolean | null;
	smallCapSize: number | null;
	superscriptSize: number | null;
	superscriptPosition: number | null;
	subscriptSize: number | null;
	subscriptPosition: number | null;
	fonts: IPsdTextLayerFontInfo[];
	styleRuns: IPsdTextLayerStyleRunInfo[];
	paragraphRuns: IPsdTextLayerParagraphRunInfo[];
	styleRunTerminatorNormalized: boolean;
	paragraphRunTerminatorNormalized: boolean;
	engineDataWarning: string | null;
	engineData2Bytes: number;
	engineData2Warning: string | null;
	engineData2ExecutionModel: "disabled" | "bounded-global-txt2-engine-data2-v1";
	executionModel: "bounded-tysh-text-v1";
}

export interface IPsdSmartObjectLayerInfo {
	sourceKey: "PlLd" | "SoLd" | "SoLE";
	version: 3 | 4 | 5;
	id: string;
	placedId: string | null;
	type: "unknown" | "vector" | "raster" | "imageStack";
	pageNumber: number;
	totalPages: number;
	transform: [number, number, number, number, number, number, number, number];
	nonAffineTransform: [number, number, number, number, number, number, number, number] | null;
	width: number | null;
	height: number | null;
	resolution: { value: number; units: string } | null;
	crop: number | null;
	comp: number | null;
	compInfo: { compId: number; originalCompId: number } | null;
	frameStep: { numerator: number; denominator: number } | null;
	duration: { numerator: number; denominator: number } | null;
	frameCount: number;
	warp: IPsdWarpInfo;
	filterCount: number;
	smartFilterState: {
		enabled: boolean;
		validAtPosition: boolean;
		maskEnabled: boolean;
		maskLinked: boolean;
		maskExtendWithWhite: boolean;
	} | null;
	smartFilters: IPsdSmartFilterInfo[];
	smartFilterMask: IPsdSmartFilterMaskInfo | null;
	smartFilterMaskWarning: string | null;
	linkedResource: {
		status: "embedded" | "external" | "alias" | "missing" | "ambiguous";
		resourceIndices: number[];
	};
	executionModel: "bounded-smart-object-v1";
}

export interface IPsdSmartFilterInfo {
	index: number;
	name: string;
	type:
		| "addNoise"
		| "average"
		| "blur"
		| "blurMore"
		| "boxBlur"
		| "colorHalftone"
		| "clouds"
		| "crystallize"
		| "differenceClouds"
		| "deInterlace"
		| "diffuse"
		| "fibers"
		| "despeckle"
		| "dustAndScratches"
		| "emboss"
		| "extrude"
		| "facet"
		| "findEdges"
		| "fragment"
		| "gaussianBlur"
		| "highPass"
		| "invert"
		| "lensFlare"
		| "maximum"
		| "mezzotint"
		| "median"
		| "minimum"
		| "motionBlur"
		| "mosaic"
		| "ntscColors"
		| "pointillize"
		| "radialBlur"
		| "reduceNoise"
		| "sharpen"
		| "sharpenEdges"
		| "sharpenMore"
		| "solarize"
		| "shapeBlur"
		| "smartSharpen"
		| "unsharpMask"
		| "smartBlur"
		| "surfaceBlur"
		| "tiles"
		| "traceContour"
		| "wind"
		| "unsupported";
	filterClassId: string | null;
	filterId: number | null;
	enabled: boolean;
	opacity: number;
	blendMode: string;
	normalizedBlendMode: PsdSmartFilterBlendMode | null;
	radius: number | null;
	foregroundColor?: [number, number, number, 255] | null;
	backgroundColor?: [number, number, number, 255] | null;
	addNoise?: { amountPercent: number; amountUnits: string; distribution: "uniform" | "gaussian"; monochromatic: boolean; randomSeed: number } | null;
	clouds?: { randomSeed: number } | null;
	differenceClouds?: { randomSeed: number } | null;
	deInterlace?: { eliminate: "oddLines" | "evenLines"; newFieldsBy: "duplication" | "interpolation" } | null;
	diffuse?: { mode: "normal" | "darkenOnly" | "lightenOnly" | "anisotropic"; randomSeed: number } | null;
	fibers?: { variance: number; strength: number; randomSeed: number } | null;
	lensFlare?: {
		brightnessPercent: number;
		position: { x: number; y: number };
		lensType: "50-300mm zoom" | "32mm prime" | "105mm prime" | "movie prime";
	} | null;
	smartSharpen?: {
		amountPercent: number;
		radius: number;
		radiusUnits: string;
		threshold: number;
		angleDegrees: number;
		moreAccurate: boolean;
		blur: "gaussianBlur" | "lensBlur" | "motionBlur";
		preset: string;
		shadow: { fadeAmountPercent: number; tonalWidthPercent: number; radius: number };
		highlight: { fadeAmountPercent: number; tonalWidthPercent: number; radius: number };
	} | null;
	unsharpMask?: { amountPercent: number; amountUnits: string; radius: number; radiusUnits: string; threshold: number } | null;
	colorHalftone?: { radius: number; anglesDegrees: [number, number, number, number] } | null;
	crystallize?: { cellSize: number; randomSeed: number } | null;
	dustAndScratches?: { radius: number; threshold: number } | null;
	emboss?: { angleDegrees: number; heightPixels: number; amountPercent: number } | null;
	extrude?: {
		type: "blocks" | "pyramids";
		sizePixels: number;
		depth: number;
		depthMode: "random" | "levelBased";
		randomSeed: number;
		solidFrontFaces: boolean;
		maskIncompleteBlocks: boolean;
	} | null;
	tiles?: {
		numberOfTiles: number;
		maximumOffsetPercent: number;
		fillEmptyAreaWith: "backgroundColor" | "foregroundColor" | "inverseImage" | "unalteredImage";
		randomSeed: number;
	} | null;
	traceContour?: { level: number; edge: "lower" | "upper" } | null;
	wind?: { method: "wind" | "blast" | "stagger"; direction: "left" | "right" } | null;
	mezzotint?: {
		pattern: "fine dots" | "medium dots" | "grainy dots" | "coarse dots" | "short lines" | "medium lines" | "long lines" | "short strokes" | "medium strokes" | "long strokes";
		randomSeed: number;
	} | null;
	mosaic?: { cellSize: number; cellSizeUnits: string } | null;
	pointillize?: { cellSize: number; randomSeed: number } | null;
	motionBlur?: { angleDegrees: number; distance: number; distanceUnits: string } | null;
	radialBlur?: { amount: number; method: "spin" | "zoom"; quality: "draft" | "good" | "best" } | null;
	reduceNoise?: {
		preset: string;
		removeJpegArtifact: boolean;
		reduceColorNoisePercent: number;
		sharpenDetailsPercent: number;
		channelDenoise: Array<{
			channels: Array<"red" | "green" | "blue" | "composite">;
			amount: number;
			preserveDetailsPercent: number | null;
		}>;
	} | null;
	smartBlur?: { threshold: number; quality: "low" | "medium" | "high"; mode: "normal" | "edgeOnly" | "overlayEdge" } | null;
	surfaceBlur?: { threshold: number; radiusUnits: string } | null;
	shapeBlur?: { radiusUnits: string; customShape: { name: string; id: string }; kernel: "heartCard" | "customBinding" | null } | null;
	bakeSupported: boolean;
	warning: string | null;
	algorithmExecutionModel: PsdSmartFilterAlgorithmExecutionModel | null;
	blendExecutionModel: "bounded-smart-filter-blend-v1" | null;
	executionModel: "bounded-smart-filter-v1";
}

export type PsdSmartFilterAlgorithmExecutionModel =
	| "bounded-seeded-add-noise-smart-filter-v1"
	| "bounded-average-smart-filter-v1"
	| "bounded-blur-smart-filter-v1"
	| "bounded-blur-more-smart-filter-v1"
	| "bounded-box-blur-smart-filter-v1"
	| "bounded-cmyk-screen-color-halftone-smart-filter-v1"
	| "bounded-seeded-fractal-clouds-smart-filter-v1"
	| "bounded-seeded-voronoi-crystallize-smart-filter-v1"
	| "bounded-seeded-difference-clouds-smart-filter-v1"
	| "bounded-field-reconstruction-de-interlace-smart-filter-v1"
	| "bounded-seeded-four-mode-diffuse-smart-filter-v1"
	| "bounded-seeded-anisotropic-fibers-smart-filter-v1"
	| "bounded-parameterized-lens-flare-smart-filter-v1"
	| "bounded-adaptive-smart-sharpen-v1"
	| "bounded-thresholded-gaussian-unsharp-mask-v1"
	| "bounded-despeckle-smart-filter-v1"
	| "bounded-thresholded-median-dust-and-scratches-smart-filter-v1"
	| "bounded-directional-color-emboss-smart-filter-v1"
	| "bounded-seeded-cell-relief-extrude-smart-filter-v1"
	| "bounded-seeded-offset-tiles-smart-filter-v1"
	| "bounded-per-channel-threshold-trace-contour-smart-filter-v1"
	| "bounded-directional-horizontal-wind-smart-filter-v1"
	| "bounded-facet-smart-filter-v1"
	| "bounded-find-edges-smart-filter-v1"
	| "bounded-fragment-smart-filter-v1"
	| "bounded-gaussian-blur-smart-filter-v1"
	| "bounded-high-pass-smart-filter-v1"
	| "bounded-invert-smart-filter-v1"
	| "bounded-maximum-smart-filter-v1"
	| "bounded-seeded-mezzotint-smart-filter-v1"
	| "bounded-median-smart-filter-v1"
	| "bounded-minimum-smart-filter-v1"
	| "bounded-motion-blur-smart-filter-v1"
	| "bounded-premultiplied-mosaic-smart-filter-v1"
	| "bounded-ntsc-colors-smart-filter-v1"
	| "bounded-seeded-authored-canvas-pointillize-smart-filter-v2"
	| "bounded-radial-blur-smart-filter-v1"
	| "bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1"
	| "bounded-sharpen-smart-filter-v1"
	| "bounded-sharpen-edges-smart-filter-v1"
	| "bounded-sharpen-more-smart-filter-v1"
	| "bounded-solarize-smart-filter-v1"
	| "bounded-heart-card-shape-blur-smart-filter-v1"
	| "bounded-custom-raster-shape-blur-smart-filter-v1"
	| "bounded-smart-blur-smart-filter-v1"
	| "bounded-surface-blur-smart-filter-v1";

export type PsdSmartFilterBlendMode =
	| "norm"
	| "mul "
	| "scrn"
	| "over"
	| "dark"
	| "lite"
	| "div "
	| "idiv"
	| "hLit"
	| "sLit"
	| "diff"
	| "smud"
	| "lddg"
	| "lbrn"
	| "fsub"
	| "fdiv"
	| "hue "
	| "sat "
	| "colr"
	| "lum ";

export interface IPsdSmartFilterMaskInfo {
	index: number;
	sourceKey: "FEid" | "FXid";
	version: 1 | 2 | 3;
	id: string;
	top: number;
	left: number;
	bottom: number;
	right: number;
	width: number;
	height: number;
	depth: PsdChannelDepth;
	sampleByteLength: 1 | 2 | 4;
	conversionModel: PsdChannelConversionModel;
	compression: PsdCompression;
	dataBytes: number;
	executionModel: "bounded-smart-filter-mask-v1";
}

export interface IDecodedPsdSmartFilterMask extends IPsdSmartFilterMaskInfo {
	coverage: Uint8Array;
	coverageMinimum: number;
	coverageMaximum: number;
}

export interface IPsdSmartObjectResourceInfo {
	index: number;
	sourceKey: "lnk2" | "lnkD" | "lnk3" | "lnkE";
	recordSignature: "liFD" | "liFE" | "liFA";
	type: "embedded" | "external" | "alias";
	version: number;
	id: string;
	name: string;
	fileType: string;
	creator: string;
	descriptorPresent: boolean;
	dataBytes: number;
	payloadAvailable: boolean;
	external: {
		fileSize: number;
		name: string;
		fullPath: string;
		originalPath: string;
		relativePath: string;
		time: string | null;
	} | null;
	childDocumentId: string | null;
	assetModTime: number | null;
	assetLockedState: number | null;
	executionModel: "bounded-smart-object-link-v1";
	warnings: string[];
}

export interface IPsdLayerInfo {
	index: number;
	id: number | null;
	name: string;
	kind: PsdLayerKind;
	top: number;
	left: number;
	bottom: number;
	right: number;
	width: number;
	height: number;
	visible: boolean;
	transparencyProtected: boolean;
	protectedSettings?: {
		transparency: boolean;
		composite: boolean;
		position: boolean;
		artboardAutonest: boolean;
		rawFlags: number;
		unknownFlags: number;
		executionModel: "psd-protected-settings-v1";
	};
	sheetColor?: {
		color: PsdLayerSheetColor;
		colorCode: number;
		reservedValues: [number, number, number];
		reservedNonZero: boolean;
		executionModel: "psd-sheet-color-v1";
	};
	effectsReferencePoint?: {
		sourceKey: "fxrp";
		x: number;
		y: number;
		axisOrder: "x-y";
		executionModel: "psd-effects-reference-point-v1";
	};
	channelBlendingRestrictions?: {
		sourceKey: "brst";
		channelIds: number[];
		restrictedChannels: PsdLayerBlendingChannel[];
		unsupportedChannelIds: number[];
		duplicateChannelIds: number[];
		executionModel: "bounded-channel-blending-restrictions-v1";
	};
	solidColorFill?: IPsdSolidColorFillInfo;
	patternFill?: IPsdPatternFillInfo;
	gradientFill?: IPsdGradientFillInfo;
	vectorFill?: IPsdVectorFillInfo;
	vectorStroke?: IPsdVectorStrokeInfo;
	vectorOrigination?: IPsdVectorOriginationInfo;
	vectorRenderingVersion?: IPsdVectorRenderingVersionInfo;
	pathList?: IPsdPathListInfo;
	opacity: number;
	fillOpacity: number;
	blendMode: string;
	clipping: boolean;
	hasTransparency: boolean;
	advancedBlending: {
		blendClippedLayersAsGroup: boolean | null;
		blendInteriorEffectsAsGroup: boolean | null;
		transparencyShapesLayer: boolean | null;
		knockout: "none" | "shallow" | "deep";
		layerMaskAsGlobalMask: boolean | null;
		vectorMaskAsGlobalMask: boolean | null;
		executionModel: "psd-advanced-layer-style-flags-v1";
	};
	mask: IPsdLayerMaskInfo | null;
	vectorMask: IPsdVectorMaskInfo | null;
	adjustment: IPsdLayerAdjustmentInfo | null;
	effects: IPsdLayerEffectsInfo | null;
	text: IPsdTextLayerInfo | null;
	smartObject: IPsdSmartObjectLayerInfo | null;
	channels: IPsdLayerChannelInfo[];
	extractionSupported: boolean;
	warnings: string[];
}

export interface IPsdLayerDocumentInfo {
	version: 1 | 2;
	format: "psd-v1" | "psb-v2";
	width: number;
	height: number;
	depth: PsdChannelDepth;
	sampleByteLength: 1 | 2 | 4;
	channelConversionModel: PsdChannelConversionModel;
	layerInfoSource: PsdLayerInfoSource;
	colorMode: PsdColorMode;
	mergedAlpha: boolean;
	layerCount: number;
	layers: IPsdLayerInfo[];
	patterns: IPsdEmbeddedPatternInfo[];
	smartObjectResources: IPsdSmartObjectResourceInfo[];
	totalPixelLayerPixels: number;
}

export interface IDecodedPsdSmartObjectResource extends IPsdSmartObjectResourceInfo {
	data: Uint8Array;
}

export interface IPsdEmbeddedSmartObjectPayloadReplacement {
	resourceIndex: number;
	data: Uint8Array;
}

export interface IPsdEmbeddedSmartObjectPayloadReplacementResult {
	data: Uint8Array;
	items: Array<{
		resourceIndex: number;
		resourceId: string;
		resourceName: string;
		fileType: string;
		sourceKey: IPsdSmartObjectResourceInfo["sourceKey"];
		previousByteLength: number;
		replacementByteLength: number;
		executionModel: "bounded-smart-object-payload-replacement-v1";
	}>;
	executionModel: "bounded-smart-object-payload-replacement-v1";
}

export interface IPsdNestedEmbeddedSmartObjectPayloadReplacement {
	resourcePath: number[];
	data: Uint8Array;
}

export interface IPsdNestedEmbeddedSmartObjectPayloadReplacementResult {
	data: Uint8Array;
	items: Array<{
		resourcePath: number[];
		resourceIdPath: string[];
		depth: number;
		resourceIndex: number;
		resourceId: string;
		resourceName: string;
		fileType: string;
		sourceKey: IPsdSmartObjectResourceInfo["sourceKey"];
		previousByteLength: number;
		replacementByteLength: number;
		executionModel: "bounded-recursive-smart-object-payload-replacement-v1";
	}>;
	ancestorRebuilds: Array<{
		resourcePath: number[];
		resourceIdPath: string[];
		depth: number;
		resourceIndex: number;
		resourceId: string;
		resourceName: string;
		previousByteLength: number;
		replacementByteLength: number;
	}>;
	executionModel: "bounded-recursive-smart-object-payload-replacement-v1";
}

export interface IPsdNestedSmartObjectDocumentInfo {
	resourcePath: number[];
	resourceIdPath: string[];
	depth: number;
	resourceIndex: number;
	resourceId: string;
	resourceName: string;
	fileType: string;
	byteLength: number;
	format: "psd-v1" | "psb-v2" | "other";
	status: "inspected" | "unsupported" | "malformed" | "depthLimit";
	document: {
		version: 1 | 2;
		format: "psd-v1" | "psb-v2";
		width: number;
		height: number;
		depth: PsdChannelDepth;
		sampleByteLength: 1 | 2 | 4;
		channelConversionModel: PsdChannelConversionModel;
		layerInfoSource: PsdLayerInfoSource;
		colorMode: PsdColorMode;
		layerCount: number;
		totalPixelLayerPixels: number;
		pixelLayerCount: number;
		textLayerCount: number;
		smartObjectLayerCount: number;
		groupRecordCount: number;
		smartObjectResourceCount: number;
		embeddedResourceCount: number;
		externalResourceCount: number;
		aliasResourceCount: number;
	} | null;
	message: string | null;
	executionModel: "bounded-nested-smart-object-v1";
}

export interface IDecodedPsdLayer extends IPsdLayerInfo {
	pixels: Uint8Array;
}

export interface IDecodedPsdAdjustmentMask {
	layerIndex: number;
	coverage: Uint8Array;
	executionModel: "bounded-adjustment-mask-v1";
}

export interface IDecodedPsdLayerMask {
	layerIndex: number;
	coverage: Uint8Array;
	executionModel: "bounded-layer-mask-v1";
}

export interface IPsdImageInfo {
	version: 1 | 2;
	format: "psd-v1" | "psb-v2";
	width: number;
	height: number;
	depth: PsdChannelDepth;
	sampleByteLength: 1 | 2 | 4;
	channelConversionModel: PsdChannelConversionModel;
	channels: number;
	hasAlpha: boolean;
	colorMode: PsdColorMode;
	compression: PsdCompression;
	colorModeDataBytes: number;
	imageResourcesBytes: number;
	layerAndMaskBytes: number;
	layerDataPresent: boolean;
	compositeOnly: true;
}

export interface IDecodedPsdImage extends IPsdImageInfo {
	pixels: Uint8Array;
}

export interface IPsdSmartObjectPlacementRenderResult {
	pixels: Uint8Array;
	left: number;
	top: number;
	width: number;
	height: number;
	corners: [number, number, number, number, number, number, number, number];
	sampling: "premultiplied-bilinear";
	executionModel: "bounded-projective-smart-object-v1";
}

export interface IPsdSmartObjectWarpRenderResult extends Omit<IPsdSmartObjectPlacementRenderResult, "executionModel"> {
	uOrder: number;
	vOrder: number;
	meshPointCount: number;
	tessellation: number;
	executionModel: "bounded-bezier-smart-object-warp-v1";
}

export interface IPsdSmartObjectQuiltWarpRenderResult extends Omit<IPsdSmartObjectPlacementRenderResult, "executionModel"> {
	uOrder: number;
	vOrder: number;
	deformNumRows: number;
	deformNumCols: number;
	meshPointCount: number;
	quiltSliceX: number[];
	quiltSliceY: number[];
	tessellation: number;
	executionModel: "bounded-piecewise-bezier-smart-object-quilt-warp-v1";
}

export interface IPsdSmartObjectQuiltWarpOptions {
	meshPoints: Array<{ x: number; y: number }>;
	uOrder: number;
	vOrder: number;
	deformNumRows: number;
	deformNumCols: number;
	quiltSliceX: number[];
	quiltSliceY: number[];
}

export const PSD_SMART_OBJECT_PRESET_WARP_STYLES = [
	"warpArc",
	"warpArcLower",
	"warpArcUpper",
	"warpArch",
	"warpBulge",
	"warpShellLower",
	"warpShellUpper",
	"warpFlag",
	"warpWave",
	"warpFish",
	"warpRise",
	"warpFisheye",
	"warpFishEye",
	"warpInflate",
	"warpSqueeze",
	"warpTwist",
	"warpCylinder",
] as const;

export type PsdSmartObjectPresetWarpStyle = (typeof PSD_SMART_OBJECT_PRESET_WARP_STYLES)[number];

export interface IPsdSmartObjectPresetWarpOptions {
	style: PsdSmartObjectPresetWarpStyle;
	value: number;
	perspective: number;
	perspectiveOther: number;
	rotate: "horizontal" | "vertical";
}

export interface IPsdSmartObjectPresetWarpRenderResult extends Omit<IPsdSmartObjectPlacementRenderResult, "executionModel">, IPsdSmartObjectPresetWarpOptions {
	tessellation: number;
	executionModel: "bounded-analytical-preset-smart-object-warp-v1";
}

export interface IPsdSmartFilterRenderResult {
	pixels: Uint8Array;
	appliedFilterIndices: number[];
	executionModel: "bounded-smart-filter-stack-v1";
}

export interface IPsdShapeBlurKernelBinding {
	shapeId: string;
	width: number;
	height: number;
	coverage: Uint8Array;
}

interface IParsedPsdImage extends IPsdImageInfo {
	imageDataOffset: number;
	layerAndMaskOffset: number;
	rleRowLengthBytes: 2 | 4;
	layerAndMaskLengthBytes: 4 | 8;
}

interface IParsedPsdLayerChannel extends IPsdLayerChannelInfo {
	dataOffset: number;
	rleRowLengthBytes: 2 | 4;
}

interface IParsedPsdLayer extends Omit<IPsdLayerInfo, "channels" | "extractionSupported" | "warnings"> {
	channels: IParsedPsdLayerChannel[];
}

interface IParsedPsdSmartFilterMask extends IPsdSmartFilterMaskInfo {
	dataOffset: number;
	dataLength: number;
}

interface IParsedPsdPatternChannel {
	index: number;
	width: number;
	height: number;
	left: number;
	top: number;
	depth: number;
	pixelDepth: number;
	compression: PsdLayerCompression;
	dataOffset: number;
	dataLength: number;
}

interface IParsedPsdPattern extends IPsdEmbeddedPatternInfo {
	palette: Array<[number, number, number]>;
	channels: IParsedPsdPatternChannel[];
}

interface IPsdGlobalTextStyleRun {
	length: number;
	fractions: boolean | null;
	ordinals: boolean | null;
	stylisticAlternates: boolean | null;
}

interface IPsdGlobalTextEditor {
	text: string | null;
	styleRuns: IPsdGlobalTextStyleRun[];
}

interface IPsdGlobalTextEngineData2 {
	bytes: number;
	editors: IPsdGlobalTextEditor[];
	warning: string | null;
}

interface IParsedPsdSmartObjectResource extends IPsdSmartObjectResourceInfo {
	dataOffset: number | null;
	declaredDataSizeOffset: number;
	recordSizeOffset: number;
	recordOffset: number;
	recordEnd: number;
	paddedRecordEnd: number;
	tagLengthOffset: number;
	tagDataBytes: number;
}

const PSD_HEADER_BYTES = 26;
const MAXIMUM_PSD_DIMENSION = 30_000;
const MAXIMUM_PSD_PIXELS = 67_108_864;
const MAXIMUM_PSD_CHANNELS = 56;
const MAXIMUM_PSD_LAYERS = 4096;
const MAXIMUM_PSD_LAYER_CHANNELS = 64;
const MAXIMUM_PSD_LAYER_PIXELS = 67_108_864;
const MAXIMUM_PSD_LAYER_EFFECTS = 64;
const MAXIMUM_PSD_PATTERNS = 256;
const MAXIMUM_PSD_SMART_OBJECT_RESOURCES = 1024;
const MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES = 256 * 1024 * 1024;
const MAXIMUM_PSD_SMART_OBJECT_STRING_CHARACTERS = 4096;
const MAXIMUM_PSD_SMART_FILTER_SAMPLE_VISITS = 64 * 1024 * 1024;
const MAXIMUM_PSD_PATTERN_DIMENSION = 16_384;
const MAXIMUM_PSD_PATTERN_PIXELS = 16_777_216;
const MAXIMUM_PSD_PATTERN_CHANNELS = 64;
const MAXIMUM_PSD_DESCRIPTOR_DEPTH = 16;
const MAXIMUM_PSD_DESCRIPTOR_ITEMS = 4096;
const MAXIMUM_PSD_DESCRIPTOR_STRING_BYTES = 1024 * 1024;
const MAXIMUM_PSD_VECTOR_MASK_SUBPATHS = 512;
const MAXIMUM_PSD_VECTOR_MASK_KNOTS = 4096;
const MAXIMUM_PSD_MASK_FEATHER = 256;
const PSD_PSB_64_BIT_TAG_KEYS = new Set(["LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD"]);

function psdTaggedBlockLengthBytes(version: 1 | 2, signature: string, key: string): 4 | 8 {
	return signature === "8B64" || (version === 2 && PSD_PSB_64_BIT_TAG_KEYS.has(key)) ? 8 : 4;
}

function assertRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
		throw new Error(`Malformed PSD: ${label} exceeds the source byte range.`);
	}
}

function readUint16(bytes: Uint8Array, offset: number, label: string): number {
	assertRange(bytes, offset, 2, label);
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number, label: string): number {
	assertRange(bytes, offset, 4, label);
	return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readInt16(bytes: Uint8Array, offset: number, label: string): number {
	const value = readUint16(bytes, offset, label);
	return value >= 0x8000 ? value - 0x10000 : value;
}

function readInt32(bytes: Uint8Array, offset: number, label: string): number {
	const value = readUint32(bytes, offset, label);
	return value >= 0x80000000 ? value - 0x100000000 : value;
}

function readUint64(bytes: Uint8Array, offset: number, label: string): number {
	const high = readUint32(bytes, offset, `${label} high`);
	const low = readUint32(bytes, offset + 4, `${label} low`);
	const value = high * 0x100000000 + low;
	if (!Number.isSafeInteger(value)) {
		throw new Error(`Unsupported PSD: ${label} exceeds JavaScript's safe integer range.`);
	}
	return value;
}

function readFloat32(bytes: Uint8Array, offset: number, label: string): number {
	assertRange(bytes, offset, 4, label);
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, false);
}

function readAscii(bytes: Uint8Array, offset: number, length: number, label: string): string {
	assertRange(bytes, offset, length, label);
	let result = "";
	for (let index = 0; index < length; ++index) {
		result += String.fromCharCode(bytes[offset + index]);
	}
	return result;
}

function readSection(bytes: Uint8Array, offset: number, label: string, lengthBytes: 4 | 8 = 4): { length: number; dataOffset: number; nextOffset: number } {
	const length = lengthBytes === 8 ? readUint64(bytes, offset, `${label} length`) : readUint32(bytes, offset, `${label} length`);
	const dataOffset = offset + lengthBytes;
	assertRange(bytes, dataOffset, length, label);
	return { length, dataOffset, nextOffset: dataOffset + length };
}

function parsePsd(bytes: Uint8Array): IParsedPsdImage {
	assertRange(bytes, 0, PSD_HEADER_BYTES, "header");
	if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "8BPS") {
		throw new Error('Malformed PSD: expected the "8BPS" signature.');
	}
	const version = readUint16(bytes, 4, "version");
	if (version !== 1 && version !== 2) {
		throw new Error(`Unsupported Photoshop document version ${version}; bounded PSD version 1 and PSB version 2 are supported.`);
	}
	for (let offset = 6; offset < 12; ++offset) {
		if (bytes[offset] !== 0) {
			throw new Error("Malformed PSD: all six reserved header bytes must be zero.");
		}
	}

	const channels = readUint16(bytes, 12, "channel count");
	const height = readUint32(bytes, 14, "height");
	const width = readUint32(bytes, 18, "width");
	const depth = readUint16(bytes, 22, "channel depth");
	const colorModeValue = readUint16(bytes, 24, "color mode");
	if (channels < 1 || channels > MAXIMUM_PSD_CHANNELS) {
		throw new Error(`Unsupported PSD channel count ${channels}; the PSD header permits 1..${MAXIMUM_PSD_CHANNELS} channels.`);
	}
	if (width < 1 || height < 1 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > MAXIMUM_PSD_PIXELS) {
		throw new Error(
			`Unsupported PSD dimensions ${width}x${height}; each dimension must be at most ${MAXIMUM_PSD_DIMENSION.toLocaleString()} and decoded images are limited to ${MAXIMUM_PSD_PIXELS.toLocaleString()} pixels.`
		);
	}
	if (depth !== 8 && depth !== 16 && depth !== 32) {
		throw new Error(`Unsupported PSD channel depth ${depth}; this importer accepts deterministic 8-bit, 16-bit, and 32-bit floating-point channels.`);
	}
	const channelDepth = depth as PsdChannelDepth;
	const sampleByteLength = channelDepth === 32 ? 4 : channelDepth === 16 ? 2 : 1;
	const channelConversionModel: PsdChannelConversionModel =
		channelDepth === 32 ? "bounded-linear-float32-to-rgba8-v1" : channelDepth === 16 ? "bounded-uint16-to-rgba8-v1" : "identity-uint8";

	let colorMode: PsdColorMode;
	if (colorModeValue === 1) {
		colorMode = "grayscale";
		if (channels < 1) {
			throw new Error("Malformed PSD: grayscale documents require at least one channel.");
		}
	} else if (colorModeValue === 3) {
		colorMode = "rgb";
		if (channels < 3) {
			throw new Error("Malformed PSD: RGB documents require at least red, green, and blue channels.");
		}
	} else {
		throw new Error(
			`Unsupported PSD color mode ${colorModeValue}; this importer currently accepts merged RGB (3) and Grayscale (1) documents only, not Bitmap, Indexed, CMYK, Multichannel, Duotone, or Lab.`
		);
	}

	const colorModeData = readSection(bytes, PSD_HEADER_BYTES, "color-mode data");
	const imageResources = readSection(bytes, colorModeData.nextOffset, "image resources");
	const layerAndMaskLengthBytes = version === 2 ? 8 : 4;
	const layerAndMask = readSection(bytes, imageResources.nextOffset, "layer-and-mask information", layerAndMaskLengthBytes);
	const compressionValue = readUint16(bytes, layerAndMask.nextOffset, "merged-image compression");
	let compression: PsdCompression;
	if (compressionValue === 0) {
		compression = "raw";
	} else if (compressionValue === 1) {
		compression = "rle";
	} else if (compressionValue === 2) {
		compression = "zip";
	} else if (compressionValue === 3) {
		compression = "zipPrediction";
	} else {
		throw new Error(`Unsupported PSD merged-image compression ${compressionValue}; raw (0), PackBits RLE (1), ZIP (2), and ZIP-with-prediction (3) are supported.`);
	}

	return {
		version,
		format: version === 2 ? "psb-v2" : "psd-v1",
		width,
		height,
		depth: channelDepth,
		sampleByteLength,
		channelConversionModel,
		channels,
		hasAlpha: colorMode === "rgb" ? channels >= 4 : channels >= 2,
		colorMode,
		compression,
		colorModeDataBytes: colorModeData.length,
		imageResourcesBytes: imageResources.length,
		layerAndMaskBytes: layerAndMask.length,
		layerDataPresent: layerAndMask.length > 0,
		compositeOnly: true,
		imageDataOffset: layerAndMask.nextOffset + 2,
		layerAndMaskOffset: layerAndMask.dataOffset,
		rleRowLengthBytes: version === 2 ? 4 : 2,
		layerAndMaskLengthBytes,
	};
}

function decodePackBitsRow(bytes: Uint8Array, offset: number, length: number, width: number, row: Uint8Array): void {
	assertRange(bytes, offset, length, "RLE row");
	const end = offset + length;
	let inputOffset = offset;
	let outputOffset = 0;
	while (inputOffset < end) {
		const header = bytes[inputOffset++];
		if (header <= 127) {
			const count = header + 1;
			if (inputOffset + count > end) {
				throw new Error("Malformed PSD: a PackBits literal packet exceeds its declared RLE row byte count.");
			}
			if (outputOffset + count > width) {
				throw new Error("Malformed PSD: a PackBits literal packet exceeds the declared row width.");
			}
			row.set(bytes.subarray(inputOffset, inputOffset + count), outputOffset);
			inputOffset += count;
			outputOffset += count;
		} else if (header >= 129) {
			const count = 257 - header;
			if (inputOffset >= end) {
				throw new Error("Malformed PSD: a PackBits repeat packet has no source byte.");
			}
			if (outputOffset + count > width) {
				throw new Error("Malformed PSD: a PackBits repeat packet exceeds the declared row width.");
			}
			row.fill(bytes[inputOffset++], outputOffset, outputOffset + count);
			outputOffset += count;
		}
		// 128 is the PackBits no-op marker and intentionally emits no bytes.
	}
	if (outputOffset !== width) {
		throw new Error(`Malformed PSD: PackBits row decoded ${outputOffset} bytes but the declared width is ${width}.`);
	}
}

function undoPsdZipPrediction(data: Uint8Array, width: number, height: number, depth: PsdChannelDepth, label: string): void {
	const sampleByteLength = depth === 32 ? 4 : depth === 16 ? 2 : 1;
	const expectedBytes = width * height * sampleByteLength;
	if (data.byteLength !== expectedBytes) {
		throw new Error(`Malformed PSD: ${label} prediction requires ${expectedBytes} bytes, but ${data.byteLength} were decoded.`);
	}
	if (depth === 8) {
		for (let y = 0; y < height; ++y) {
			const rowOffset = y * width;
			for (let x = 1; x < width; ++x) {
				data[rowOffset + x] = (data[rowOffset + x] + data[rowOffset + x - 1]) & 0xff;
			}
		}
		return;
	}
	if (depth === 32) {
		const rowByteLength = width * 4;
		for (let y = 0; y < height; ++y) {
			const rowOffset = y * rowByteLength;
			for (let byte = 1; byte < rowByteLength; ++byte) {
				data[rowOffset + byte] = (data[rowOffset + byte] + data[rowOffset + byte - 1]) & 0xff;
			}
			const planar = data.slice(rowOffset, rowOffset + rowByteLength);
			for (let x = 0; x < width; ++x) {
				for (let byte = 0; byte < 4; ++byte) {
					data[rowOffset + x * 4 + byte] = planar[byte * width + x];
				}
			}
		}
		return;
	}
	const rowByteLength = width * 2;
	for (let y = 0; y < height; ++y) {
		const rowOffset = y * rowByteLength;
		for (let x = 1; x < width; ++x) {
			const previousOffset = rowOffset + (x - 1) * 2;
			const sampleOffset = rowOffset + x * 2;
			const previous = (data[previousOffset] << 8) | data[previousOffset + 1];
			const delta = (data[sampleOffset] << 8) | data[sampleOffset + 1];
			const value = (previous + delta) & 0xffff;
			data[sampleOffset] = value >>> 8;
			data[sampleOffset + 1] = value & 0xff;
		}
	}
}

function convertPsdPlaneToRgba8Samples(data: Uint8Array, width: number, height: number, depth: PsdChannelDepth, label: string, coverage = false): Uint8Array {
	const pixelCount = width * height;
	const expectedBytes = pixelCount * (depth === 32 ? 4 : depth === 16 ? 2 : 1);
	if (data.byteLength !== expectedBytes) {
		throw new Error(`Malformed PSD: ${label} requires ${expectedBytes} sample bytes, but ${data.byteLength} were decoded.`);
	}
	if (depth === 8) {
		return data;
	}
	const output = new Uint8Array(pixelCount);
	if (depth === 32) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let index = 0; index < pixelCount; ++index) {
			const value = view.getFloat32(index * 4, false);
			if (!Number.isFinite(value)) {
				throw new Error(`Malformed PSD: ${label} contains a non-finite 32-bit floating-point sample at index ${index}.`);
			}
			const bounded = Math.max(0, Math.min(1, value));
			output[index] = Math.round((coverage ? bounded : linearToSrgb(bounded)) * 255);
		}
		return output;
	}
	for (let index = 0; index < pixelCount; ++index) {
		const sourceOffset = index * 2;
		const value = (data[sourceOffset] << 8) | data[sourceOffset + 1];
		output[index] = Math.round(value / 257);
	}
	return output;
}

function isPsdZlibHeader(data: Uint8Array, offset: number): boolean {
	if (offset < 0 || offset + 2 > data.byteLength) {
		return false;
	}
	const compressionMethodAndWindow = data[offset];
	const flags = data[offset + 1];
	return (compressionMethodAndWindow & 0x0f) === 8 && compressionMethodAndWindow >>> 4 <= 7 && ((compressionMethodAndWindow << 8) | flags) % 31 === 0 && (flags & 0x20) === 0;
}

function psdAdler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let offset = 0; offset < data.byteLength; offset += 5552) {
		const end = Math.min(offset + 5552, data.byteLength);
		for (let index = offset; index < end; ++index) {
			a += data[index];
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}
	return ((b << 16) | a) >>> 0;
}

function decodePsdZlibStream(data: Uint8Array, start: number, end: number, expectedBytes: number, label: string): Uint8Array {
	if (!isPsdZlibHeader(data, start) || end - start < 6) {
		throw new Error(`Malformed PSD: ${label} has an invalid zlib header or length.`);
	}
	let output: Uint8Array;
	try {
		output = unzlibSync(data.subarray(start, end));
	} catch {
		throw new Error(`Malformed PSD: ${label} has invalid ZIP data.`);
	}
	if (output.byteLength !== expectedBytes) {
		throw new Error(`Malformed PSD: ${label} decoded ${output.byteLength} bytes instead of ${expectedBytes}.`);
	}
	const checksum = readUint32(data, end - 4, `${label} Adler-32 checksum`);
	if (checksum !== psdAdler32(output)) {
		throw new Error(`Malformed PSD: ${label} has an invalid Adler-32 checksum.`);
	}
	return output;
}

function decodePsdMergedZipData(data: Uint8Array, channelCount: number, planeByteLength: number): Uint8Array {
	const expectedBytes = channelCount * planeByteLength;
	try {
		return decodePsdZlibStream(data, 0, data.byteLength, expectedBytes, "merged ZIP image");
	} catch (error) {
		if (channelCount === 1) {
			throw error;
		}
	}
	const output = new Uint8Array(expectedBytes);
	let start = 0;
	for (let channel = 0; channel < channelCount; ++channel) {
		const candidateEnds: number[] = [];
		if (channel === channelCount - 1) {
			candidateEnds.push(data.byteLength);
		} else {
			for (let offset = start + 6; offset + 1 < data.byteLength; ++offset) {
				if (isPsdZlibHeader(data, offset)) {
					candidateEnds.push(offset);
				}
			}
		}
		let decoded: Uint8Array | null = null;
		let end = start;
		for (const candidateEnd of candidateEnds) {
			try {
				decoded = decodePsdZlibStream(data, start, candidateEnd, planeByteLength, `merged ZIP channel ${channel}`);
				end = candidateEnd;
				break;
			} catch {
				// Continue only to another structurally valid zlib boundary; exact size and Adler-32 still have to match.
			}
		}
		if (!decoded) {
			throw new Error(`Malformed PSD: merged ZIP channel ${channel} has no exact bounded zlib stream.`);
		}
		output.set(decoded, channel * planeByteLength);
		start = end;
	}
	if (start !== data.byteLength) {
		throw new Error(`Malformed PSD: merged ZIP channel streams leave ${data.byteLength - start} trailing byte(s).`);
	}
	return output;
}

function writeChannelRow(output: Uint8Array, row: Uint8Array, width: number, y: number, channel: number, colorMode: PsdColorMode): void {
	for (let x = 0; x < width; ++x) {
		const destination = (y * width + x) * 4;
		const value = row[x];
		if (colorMode === "grayscale") {
			if (channel === 0) {
				output[destination] = value;
				output[destination + 1] = value;
				output[destination + 2] = value;
			} else if (channel === 1) {
				output[destination + 3] = value;
			}
		} else if (channel < 4) {
			output[destination + channel] = value;
		}
	}
}

function layerCompression(value: number): PsdLayerCompression {
	switch (value) {
		case 0:
			return "raw";
		case 1:
			return "rle";
		case 2:
			return "zip";
		case 3:
			return "zipPrediction";
		default:
			return "unsupported";
	}
}

function parseLayerMask(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdLayerMaskInfo | null {
	if (length === 0) {
		return null;
	}
	if (length < 18) {
		throw new Error(`Malformed PSD: layer ${layerIndex} mask data is ${length} bytes, but the primary mask record requires at least 18 bytes.`);
	}
	const top = readInt32(bytes, offset, `layer ${layerIndex} mask top`);
	const left = readInt32(bytes, offset + 4, `layer ${layerIndex} mask left`);
	const bottom = readInt32(bytes, offset + 8, `layer ${layerIndex} mask bottom`);
	const right = readInt32(bytes, offset + 12, `layer ${layerIndex} mask right`);
	const width = right - left;
	const height = bottom - top;
	if (width < 0 || height < 0 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > MAXIMUM_PSD_LAYER_PIXELS) {
		throw new Error(`Malformed PSD: layer ${layerIndex} mask has invalid bounds (${left}, ${top})-(${right}, ${bottom}).`);
	}
	const flags = bytes[offset + 17];
	let cursor = offset + 18;
	const end = offset + length;
	let userDensity: number | null = null;
	let userFeather: number | null = null;
	let vectorDensity: number | null = null;
	let vectorFeather: number | null = null;
	const assertMaskRange = (byteLength: number, label: string): void => {
		if (cursor < offset || byteLength < 0 || cursor + byteLength > end) {
			throw new Error(`Malformed PSD: ${label} exceeds the ${length}-byte layer-mask record.`);
		}
		assertRange(bytes, cursor, byteLength, label);
	};
	if ((flags & 0x10) !== 0) {
		assertMaskRange(1, `layer ${layerIndex} mask parameters`);
		const parameterFlags = bytes[cursor++];
		const readDensity = (label: string): number => {
			assertMaskRange(1, label);
			return bytes[cursor++];
		};
		const readFeather = (label: string): number => {
			assertMaskRange(8, label);
			const value = new DataView(bytes.buffer, bytes.byteOffset + cursor, 8).getFloat64(0, false);
			cursor += 8;
			if (!Number.isFinite(value) || value < 0 || value > MAXIMUM_PSD_DIMENSION) {
				throw new Error(`Malformed PSD: ${label} must be a finite value from 0 to ${MAXIMUM_PSD_DIMENSION}.`);
			}
			return value;
		};
		if ((parameterFlags & 0x01) !== 0) {
			userDensity = readDensity(`layer ${layerIndex} user-mask density`);
		}
		if ((parameterFlags & 0x02) !== 0) {
			userFeather = readFeather(`layer ${layerIndex} user-mask feather`);
		}
		if ((parameterFlags & 0x04) !== 0) {
			vectorDensity = readDensity(`layer ${layerIndex} vector-mask density`);
		}
		if ((parameterFlags & 0x08) !== 0) {
			vectorFeather = readFeather(`layer ${layerIndex} vector-mask feather`);
		}
		if ((parameterFlags & 0xf0) !== 0) {
			throw new Error(`Malformed PSD: layer ${layerIndex} mask parameters contain unsupported flag bits 0x${(parameterFlags & 0xf0).toString(16)}.`);
		}
	}
	let realUserMask: IPsdLayerRealUserMaskInfo | null = null;
	const remaining = end - cursor;
	if (remaining === 18) {
		const realFlags = bytes[cursor];
		const realTop = readInt32(bytes, cursor + 2, `layer ${layerIndex} real-user mask top`);
		const realLeft = readInt32(bytes, cursor + 6, `layer ${layerIndex} real-user mask left`);
		const realBottom = readInt32(bytes, cursor + 10, `layer ${layerIndex} real-user mask bottom`);
		const realRight = readInt32(bytes, cursor + 14, `layer ${layerIndex} real-user mask right`);
		const realWidth = realRight - realLeft;
		const realHeight = realBottom - realTop;
		if (realWidth < 0 || realHeight < 0 || realWidth > MAXIMUM_PSD_DIMENSION || realHeight > MAXIMUM_PSD_DIMENSION || realWidth * realHeight > MAXIMUM_PSD_LAYER_PIXELS) {
			throw new Error(`Malformed PSD: layer ${layerIndex} real-user mask has invalid bounds (${realLeft}, ${realTop})-(${realRight}, ${realBottom}).`);
		}
		realUserMask = {
			channelId: -3,
			top: realTop,
			left: realLeft,
			bottom: realBottom,
			right: realRight,
			width: realWidth,
			height: realHeight,
			defaultColor: bytes[cursor + 1],
			disabled: (realFlags & 0x02) !== 0,
			inverted: (realFlags & 0x04) !== 0,
			positionRelativeToLayer: (realFlags & 0x01) !== 0,
		};
	} else if (remaining !== 0 && remaining !== 2) {
		throw new Error(`Malformed PSD: layer ${layerIndex} mask data leaves ${remaining} byte(s) after its primary mask record and optional parameters.`);
	}
	return {
		top,
		left,
		bottom,
		right,
		width,
		height,
		defaultColor: bytes[offset + 16],
		disabled: (flags & 0x02) !== 0,
		inverted: (flags & 0x04) !== 0,
		positionRelativeToLayer: (flags & 0x01) !== 0,
		userDensity,
		userFeather,
		vectorDensity,
		vectorFeather,
		realUserMask,
	};
}

function readPathPoint(bytes: Uint8Array, offset: number, label: string): IPsdVectorMaskPointInfo {
	const y = readInt32(bytes, offset, `${label} vertical component`) / 0x1000000;
	const x = readInt32(bytes, offset + 4, `${label} horizontal component`) / 0x1000000;
	if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 16 || Math.abs(y) > 16) {
		throw new Error(`Malformed PSD: ${label} has an out-of-range normalized coordinate (${x}, ${y}).`);
	}
	return { x, y };
}

function parseVectorMask(bytes: Uint8Array, offset: number, length: number, layerIndex: number, sourceKey: "vmsk" | "vsms"): IPsdVectorMaskInfo {
	const pathBytes = length - 8;
	const trailingPadding = pathBytes >= 0 ? pathBytes % 26 : -1;
	if (length < 8 || trailingPadding < 0 || trailingPadding > 3) {
		throw new Error(
			`Malformed PSD: layer ${layerIndex} ${sourceKey} must contain an 8-byte header followed by complete 26-byte path records and at most three zero padding bytes.`
		);
	}
	for (let padding = 0; padding < trailingPadding; ++padding) {
		if (bytes[offset + length - trailingPadding + padding] !== 0) {
			throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} path-record padding must be zero.`);
		}
	}
	const version = readUint32(bytes, offset, `layer ${layerIndex} ${sourceKey} version`);
	if (version !== 3) {
		throw new Error(`Unsupported PSD layer ${layerIndex} ${sourceKey} version ${version}; vector-mask version 3 is required.`);
	}
	const flags = readUint32(bytes, offset + 4, `layer ${layerIndex} ${sourceKey} flags`);
	if ((flags & ~0x07) !== 0) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} contains unsupported flag bits 0x${(flags & ~0x07).toString(16)}.`);
	}
	const records = (pathBytes - trailingPadding) / 26;
	const subpaths: IPsdVectorMaskSubpathInfo[] = [];
	const warnings: string[] = [];
	let initialFill: 0 | 1 = 0;
	let knotCount = 0;
	for (let recordIndex = 0; recordIndex < records; ++recordIndex) {
		const recordOffset = offset + 8 + recordIndex * 26;
		const selector = readUint16(bytes, recordOffset, `layer ${layerIndex} ${sourceKey} path selector`);
		if (selector === 6) {
			continue;
		}
		if (selector === 8) {
			const value = readUint16(bytes, recordOffset + 2, `layer ${layerIndex} ${sourceKey} initial fill`);
			if (value !== 0 && value !== 1) {
				throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} initial fill must be 0 or 1.`);
			}
			initialFill = value;
			continue;
		}
		if (selector === 7) {
			warnings.push("Clipboard path metadata is retained structurally but does not affect vector-mask rasterization.");
			continue;
		}
		if (selector !== 0 && selector !== 3) {
			throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} path record ${recordIndex} has selector ${selector} without a preceding subpath-length record.`);
		}
		if (subpaths.length >= MAXIMUM_PSD_VECTOR_MASK_SUBPATHS) {
			throw new Error(`Unsupported PSD layer ${layerIndex} vector mask; at most ${MAXIMUM_PSD_VECTOR_MASK_SUBPATHS} subpaths are allowed.`);
		}
		const closed = selector === 0;
		const count = readUint16(bytes, recordOffset + 2, `layer ${layerIndex} ${sourceKey} subpath knot count`);
		if (count < 2 || recordIndex + count >= records) {
			throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} subpath declares ${count} knots outside its path record range.`);
		}
		if (knotCount + count > MAXIMUM_PSD_VECTOR_MASK_KNOTS) {
			throw new Error(`Unsupported PSD layer ${layerIndex} vector mask; at most ${MAXIMUM_PSD_VECTOR_MASK_KNOTS} knots are allowed.`);
		}
		const knots: IPsdVectorMaskKnotInfo[] = [];
		for (let knotIndex = 0; knotIndex < count; ++knotIndex) {
			const knotRecordOffset = offset + 8 + (recordIndex + 1 + knotIndex) * 26;
			const knotSelector = readUint16(bytes, knotRecordOffset, `layer ${layerIndex} ${sourceKey} knot selector`);
			const expectedSelectors = closed ? [1, 2] : [4, 5];
			if (!expectedSelectors.includes(knotSelector)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} ${closed ? "closed" : "open"} subpath has incompatible knot selector ${knotSelector}.`);
			}
			knots.push({
				linked: knotSelector === 1 || knotSelector === 4,
				precedingControl: readPathPoint(bytes, knotRecordOffset + 2, `layer ${layerIndex} ${sourceKey} knot ${knotIndex} preceding control`),
				anchor: readPathPoint(bytes, knotRecordOffset + 10, `layer ${layerIndex} ${sourceKey} knot ${knotIndex} anchor`),
				leavingControl: readPathPoint(bytes, knotRecordOffset + 18, `layer ${layerIndex} ${sourceKey} knot ${knotIndex} leaving control`),
			});
		}
		subpaths.push({ closed, knots });
		knotCount += count;
		recordIndex += count;
	}
	const bakeSupported = subpaths.every((subpath) => subpath.closed);
	if (!bakeSupported) {
		warnings.push("Open vector-mask subpaths are preserved but cannot define a filled extraction mask.");
	}
	return {
		sourceKey,
		version: 3,
		inverted: (flags & 0x01) !== 0,
		notLinked: (flags & 0x02) !== 0,
		disabled: (flags & 0x04) !== 0,
		initialFill,
		fillRule: "evenOdd",
		subpaths,
		knotCount,
		executionModel: "bounded-vector-mask-v1",
		bakeSupported,
		warnings,
	};
}

function parseLevelsRecord(bytes: Uint8Array, offset: number, layerIndex: number, recordIndex: number): IPsdLevelsRecordInfo {
	const record = {
		inputFloor: readUint16(bytes, offset, `layer ${layerIndex} Levels record ${recordIndex} input floor`),
		inputCeiling: readUint16(bytes, offset + 2, `layer ${layerIndex} Levels record ${recordIndex} input ceiling`),
		outputFloor: readUint16(bytes, offset + 4, `layer ${layerIndex} Levels record ${recordIndex} output floor`),
		outputCeiling: readUint16(bytes, offset + 6, `layer ${layerIndex} Levels record ${recordIndex} output ceiling`),
		gamma: readUint16(bytes, offset + 8, `layer ${layerIndex} Levels record ${recordIndex} gamma`),
	};
	const allZero = Object.values(record).every((value) => value === 0);
	if (
		!allZero &&
		(record.inputFloor > 253 ||
			record.inputCeiling < 2 ||
			record.inputCeiling > 255 ||
			record.inputFloor >= record.inputCeiling ||
			record.outputFloor > 255 ||
			record.outputCeiling > 255 ||
			record.gamma < 10 ||
			record.gamma > 999)
	) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Levels record ${recordIndex} contains an invalid input/output/gamma range.`);
	}
	return allZero ? { inputFloor: 0, inputCeiling: 255, outputFloor: 0, outputCeiling: 255, gamma: 100 } : record;
}

function parseCurvePoints(bytes: Uint8Array, offset: number, end: number, layerIndex: number, channel: number): { points: IPsdCurvePointInfo[]; offset: number } {
	const count = readUint16(bytes, offset, `layer ${layerIndex} Curves channel ${channel} point count`);
	if (count < 2 || count > 19 || offset + 2 + count * 4 > end) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Curves channel ${channel} must contain 2-19 complete points.`);
	}
	const points = Array.from({ length: count }, (_, index) => ({
		output: readUint16(bytes, offset + 2 + index * 4, `layer ${layerIndex} Curves channel ${channel} point ${index} output`),
		input: readUint16(bytes, offset + 4 + index * 4, `layer ${layerIndex} Curves channel ${channel} point ${index} input`),
	}));
	if (points.some((point) => point.input > 255 || point.output > 255) || points.some((point, index) => index > 0 && point.input <= points[index - 1].input)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Curves channel ${channel} points must use strictly increasing 0-255 input and 0-255 output values.`);
	}
	return { points, offset: offset + 2 + count * 4 };
}

function identityCurve(): IPsdCurvePointInfo[] {
	return [
		{ input: 0, output: 0 },
		{ input: 255, output: 255 },
	];
}

function parseCurvesAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdCurvesAdjustmentInfo {
	const end = offset + length;
	if (length < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Curves data is truncated.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} Curves version`);
	if (version !== 1 && version !== 4) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Curves version ${version}; versions 1 and 4 are supported.`);
	}
	const curves = new Map<number, IPsdCurvePointInfo[]>();
	let cursor = offset + 4;
	if (version === 1) {
		const bitmap = readUint16(bytes, offset + 2, `layer ${layerIndex} Curves channel bitmap`);
		for (let channel = 0; channel < 16; ++channel) {
			if (!(bitmap & (1 << channel))) {
				continue;
			}
			const parsed = parseCurvePoints(bytes, cursor, end, layerIndex, channel);
			curves.set(channel, parsed.points);
			cursor = parsed.offset;
		}
		if (cursor < end) {
			if (
				end - cursor < 10 ||
				readAscii(bytes, cursor, 4, `layer ${layerIndex} extra Curves marker`) !== "Crv " ||
				readUint16(bytes, cursor + 4, "extra Curves version") !== 4
			) {
				throw new Error(`Malformed PSD: layer ${layerIndex} extra Curves data lacks the Crv version-4 marker.`);
			}
			const count = readUint32(bytes, cursor + 6, `layer ${layerIndex} extra Curves count`);
			if (count > 16) {
				throw new Error(`Malformed PSD: layer ${layerIndex} extra Curves count exceeds 16 channels.`);
			}
			cursor += 10;
			for (let index = 0; index < count; ++index) {
				const channel = readUint16(bytes, cursor, `layer ${layerIndex} extra Curves channel ${index}`);
				if (channel > 15) {
					throw new Error(`Malformed PSD: layer ${layerIndex} Curves channel index ${channel} exceeds 15.`);
				}
				const parsed = parseCurvePoints(bytes, cursor + 2, end, layerIndex, channel);
				curves.set(channel, parsed.points);
				cursor = parsed.offset;
			}
		}
	} else {
		const count = readUint16(bytes, offset + 2, `layer ${layerIndex} Curves count`);
		if (count < 1 || count > 16) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Curves count must be 1-16.`);
		}
		for (let channel = 0; channel < count; ++channel) {
			const parsed = parseCurvePoints(bytes, cursor, end, layerIndex, channel);
			curves.set(channel, parsed.points);
			cursor = parsed.offset;
		}
	}
	if (cursor !== end) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Curves data has ${end - cursor} trailing byte(s).`);
	}
	const entries = [...curves].map(([channel, points]) => ({ channel, points }));
	return {
		key: "curv",
		version,
		curves: entries,
		master: curves.get(0) ?? identityCurve(),
		red: curves.get(1) ?? identityCurve(),
		green: curves.get(2) ?? identityCurve(),
		blue: curves.get(3) ?? identityCurve(),
		executionModel: "bounded-adjustment-v1",
		bakeSupported: true,
	};
}

function parseHueSaturationAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number, key: "hue " | "hue2"): IPsdHueSaturationAdjustmentInfo {
	if (length !== 100) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Hue/Saturation data must be exactly 100 bytes.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} Hue/Saturation version`);
	if (version !== 2) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Hue/Saturation version ${version}; version 2 is required.`);
	}
	const colorizeByte = bytes[offset + 2];
	if (colorizeByte > 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Hue/Saturation colorize flag must be 0 or 1.`);
	}
	const hueMinimum = key === "hue " ? -100 : -180;
	const hueMaximum = key === "hue " ? 100 : 180;
	const readSettings = (settingsOffset: number, label: string, colorization: boolean): { hue: number; saturation: number; lightness: number } => {
		const hue = readInt16(bytes, settingsOffset, `${label} hue`);
		const saturation = readInt16(bytes, settingsOffset + 2, `${label} saturation`);
		const lightness = readInt16(bytes, settingsOffset + 4, `${label} lightness`);
		if (hue < hueMinimum || hue > hueMaximum || saturation < (colorization && key === "hue2" ? 0 : -100) || saturation > 100 || lightness < -100 || lightness > 100) {
			throw new Error(`Malformed PSD: ${label} values exceed the bounded hue/saturation/lightness ranges.`);
		}
		return { hue, saturation, lightness };
	};
	const colorization = readSettings(offset + 4, `layer ${layerIndex} Hue/Saturation colorization`, true);
	const master = readSettings(offset + 10, `layer ${layerIndex} Hue/Saturation master`, false);
	const names: IPsdHueSaturationChannelInfo["name"][] = ["reds", "yellows", "greens", "cyans", "blues", "magentas"];
	const channels = names.map((name, index): IPsdHueSaturationChannelInfo => {
		const channelOffset = offset + 16 + index * 14;
		const range: [number, number, number, number] = [
			readInt16(bytes, channelOffset, `layer ${layerIndex} Hue/Saturation ${name} range 0`),
			readInt16(bytes, channelOffset + 2, `layer ${layerIndex} Hue/Saturation ${name} range 1`),
			readInt16(bytes, channelOffset + 4, `layer ${layerIndex} Hue/Saturation ${name} range 2`),
			readInt16(bytes, channelOffset + 6, `layer ${layerIndex} Hue/Saturation ${name} range 3`),
		];
		if (range.some((value) => value < -100 || value > 100)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Hue/Saturation ${name} range values must be within -100..100.`);
		}
		const settings = readSettings(channelOffset + 8, `layer ${layerIndex} Hue/Saturation ${name}`, false);
		if ((settings.hue !== 0 || settings.saturation !== 0 || settings.lightness !== 0) && range.some((value, rangeIndex) => rangeIndex > 0 && range[rangeIndex - 1] > value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Hue/Saturation ${name} feather range must be ordered.`);
		}
		return { name, range, ...settings };
	});
	const localAdjustmentsPresent = channels.some((channel) => channel.hue !== 0 || channel.saturation !== 0 || channel.lightness !== 0);
	return {
		key,
		version: 2,
		sourceModel: key === "hue " ? "photoshop-4" : "photoshop-5+",
		hueUnitScale: key === "hue " ? 1.8 : 1,
		colorize: colorizeByte === 1,
		paddingByte: bytes[offset + 3],
		colorization,
		master,
		channels,
		localAdjustmentsPresent,
		localRangeModel: "normalized-hextant-feather-v1",
		colorModel: "bounded-hsl-hue-v2",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: true,
	};
}

function parseColorBalanceAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdColorBalanceAdjustmentInfo {
	if (length !== 20) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Balance data must be exactly 20 bytes.`);
	}
	const readTone = (toneOffset: number, name: string): IPsdColorBalanceToneInfo => {
		const tone = {
			cyanRed: readInt16(bytes, toneOffset, `layer ${layerIndex} Color Balance ${name} cyan/red`),
			magentaGreen: readInt16(bytes, toneOffset + 2, `layer ${layerIndex} Color Balance ${name} magenta/green`),
			yellowBlue: readInt16(bytes, toneOffset + 4, `layer ${layerIndex} Color Balance ${name} yellow/blue`),
		};
		if (Object.values(tone).some((value) => value < -100 || value > 100)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Color Balance ${name} values must be within -100..100.`);
		}
		return tone;
	};
	if (bytes[offset + 18] > 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Balance preserve-luminosity flag must be 0 or 1.`);
	}
	if (bytes[offset + 19] !== 0) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Balance padding byte must be zero.`);
	}
	return {
		key: "blnc",
		shadows: readTone(offset, "shadows"),
		midtones: readTone(offset + 6, "midtones"),
		highlights: readTone(offset + 12, "highlights"),
		preserveLuminosity: bytes[offset + 18] === 1,
		paddingByte: 0,
		tonalModel: "piecewise-luminance-tones-v1",
		colorModel: "bounded-rgb-color-balance-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: true,
	};
}

function parseLayerAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number, key: PsdLayerAdjustmentKey): IPsdLayerAdjustmentInfo {
	if (key === "blnc") {
		return parseColorBalanceAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "blwh") {
		return parseBlackWhiteAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "mixr") {
		return parseChannelMixerAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "selc") {
		return parseSelectiveColorAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "grdm") {
		return parseGradientMapAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "phfl") {
		return parsePhotoFilterAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "clrL") {
		return parseColorLookupAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "brit") {
		if (length !== 7 && length !== 8) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Brightness/Contrast data must be 7 bytes with optional padding.`);
		}
		const brightness = readInt16(bytes, offset, `layer ${layerIndex} brightness`);
		const contrast = readInt16(bytes, offset + 2, `layer ${layerIndex} contrast`);
		const mean = readInt16(bytes, offset + 4, `layer ${layerIndex} brightness mean`);
		if (brightness < -100 || brightness > 100 || contrast < -100 || contrast > 100 || mean < 0 || mean > 255 || bytes[offset + 6] > 1) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Brightness/Contrast values exceed the bounded -100..100/0..255 ranges.`);
		}
		return { key, brightness, contrast, mean, labOnly: bytes[offset + 6] === 1, executionModel: "bounded-adjustment-v1", bakeSupported: bytes[offset + 6] === 0 };
	}
	if (key === "curv") {
		return parseCurvesAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "expA") {
		if (length !== 14) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Exposure data must contain version plus three 32-bit values (14 bytes).`);
		}
		const version = readUint16(bytes, offset, `layer ${layerIndex} Exposure version`);
		const exposure = readFloat32(bytes, offset + 2, `layer ${layerIndex} Exposure value`);
		const adjustmentOffset = readFloat32(bytes, offset + 6, `layer ${layerIndex} Exposure offset`);
		const gamma = readFloat32(bytes, offset + 10, `layer ${layerIndex} Exposure gamma`);
		if (version !== 1) {
			throw new Error(`Unsupported PSD layer ${layerIndex} Exposure version ${version}; version 1 is required.`);
		}
		if (!Number.isFinite(exposure) || exposure < -100 || exposure > 100 || !Number.isFinite(adjustmentOffset) || adjustmentOffset < -100 || adjustmentOffset > 100) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Exposure/Offset values must be finite and within the bounded -100..100 range.`);
		}
		if (!Number.isFinite(gamma) || gamma < 0.001 || gamma > 100) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Exposure gamma must be finite and within the bounded 0.001..100 range.`);
		}
		return { key, version: 1, exposure, offset: adjustmentOffset, gamma, colorModel: "linear-srgb-v1", executionModel: "bounded-adjustment-v1", bakeSupported: true };
	}
	if (key === "vibA") {
		return parseVibranceAdjustment(bytes, offset, length, layerIndex);
	}
	if (key === "hue " || key === "hue2") {
		return parseHueSaturationAdjustment(bytes, offset, length, layerIndex, key);
	}
	if (key === "levl") {
		if (length < 292) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Levels data is ${length} bytes; version 2 plus 29 records require 292 bytes.`);
		}
		const version = readUint16(bytes, offset, `layer ${layerIndex} Levels version`);
		if (version !== 2) {
			throw new Error(`Unsupported PSD layer ${layerIndex} Levels version ${version}; version 2 is required.`);
		}
		const records = Array.from({ length: 29 }, (_, index) => parseLevelsRecord(bytes, offset + 2 + index * 10, layerIndex, index));
		if (length > 292) {
			if (length < 300 || readAscii(bytes, offset + 292, 4, `layer ${layerIndex} extra Levels marker`) !== "Lvls") {
				throw new Error(`Malformed PSD: layer ${layerIndex} Levels extra records lack the Lvls marker.`);
			}
			const extraVersion = readUint16(bytes, offset + 296, `layer ${layerIndex} extra Levels version`);
			const count = readUint16(bytes, offset + 298, `layer ${layerIndex} Levels record count`);
			if (extraVersion !== 3 || count < 29 || length !== 300 + (count - 29) * 10) {
				throw new Error(`Malformed PSD: layer ${layerIndex} Levels extra record count/version does not match its block length.`);
			}
			for (let index = 29; index < count; ++index) {
				records.push(parseLevelsRecord(bytes, offset + 300 + (index - 29) * 10, layerIndex, index));
			}
		}
		return {
			key,
			version: 2,
			records,
			master: records[0],
			red: records[1],
			green: records[2],
			blue: records[3],
			executionModel: "bounded-adjustment-v1",
			bakeSupported: true,
		};
	}
	if (key === "nvrt") {
		if (length !== 0) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Invert adjustment must have an empty data block.`);
		}
		return { key, executionModel: "bounded-adjustment-v1", bakeSupported: true };
	}
	if (length !== 2) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${key === "post" ? "Posterize" : "Threshold"} adjustment must contain one 16-bit value.`);
	}
	const value = readUint16(bytes, offset, `layer ${layerIndex} ${key} value`);
	if (key === "post") {
		if (value < 2 || value > 255) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Posterize levels must be from 2 to 255.`);
		}
		return { key, levels: value, executionModel: "bounded-adjustment-v1", bakeSupported: true };
	}
	if (value < 1 || value > 255) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Threshold value must be from 1 to 255.`);
	}
	return { key, threshold: value, executionModel: "bounded-adjustment-v1", bakeSupported: true };
}

function parsePhotoFilterAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdPhotoFilterAdjustmentInfo {
	const end = offset + length;
	if (length < 18) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Photo Filter data is truncated.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} Photo Filter version`);
	if (version !== 2 && version !== 3) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Photo Filter version ${version}; versions 2 and 3 are supported.`);
	}
	let cursor = offset + 2;
	let color: IPsdLayerEffectColorInfo;
	let labColor: IPsdPhotoFilterAdjustmentInfo["labColor"] = null;
	if (version === 2) {
		color = parseEffectColor(bytes, cursor, `layer ${layerIndex} Photo Filter`);
		cursor += 10;
	} else {
		labColor = {
			lightness: readInt32(bytes, cursor, `layer ${layerIndex} Photo Filter Lab lightness`) / 100,
			a: readInt32(bytes, cursor + 4, `layer ${layerIndex} Photo Filter Lab a`) / 100,
			b: readInt32(bytes, cursor + 8, `layer ${layerIndex} Photo Filter Lab b`) / 100,
		};
		if (labColor.lightness < 0 || labColor.lightness > 100 || labColor.a < -128 || labColor.a > 127 || labColor.b < -128 || labColor.b > 127) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Photo Filter Lab color exceeds L 0..100 or a/b -128..127.`);
		}
		const converted = labToRgb(labColor.lightness, labColor.a, labColor.b).map((value) => Math.max(0, Math.min(255, Math.round(value)))) as [number, number, number];
		color = { space: 7, components: [Math.round(labColor.lightness * 100), Math.round(labColor.a * 100), Math.round(labColor.b * 100), 0], rgba: [...converted, 255] };
		cursor += 12;
	}
	const densityRaw = readUint32(bytes, cursor, `layer ${layerIndex} Photo Filter density`);
	const preserveFlag = bytes[cursor + 4];
	cursor += 5;
	if (densityRaw > 10000 || preserveFlag > 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Photo Filter density must be 0..100 and preserve-luminosity must be 0 or 1.`);
	}
	const paddingBytes = end - cursor;
	if (paddingBytes < 1 || paddingBytes > 6 || bytes.subarray(cursor, end).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Photo Filter must end with 1..6 zero padding/alignment bytes.`);
	}
	return {
		key: "phfl",
		version,
		color,
		labColor,
		density: densityRaw / 100,
		densityRaw,
		preserveLuminosity: preserveFlag === 1,
		paddingBytes,
		colorModel: "bounded-hsl-photo-filter-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: color.rgba !== null,
	};
}

const GRADIENT_MAP_METHODS: Record<string, IPsdGradientMapAdjustmentInfo["method"]> = {
	Perc: "perceptual",
	"Lnr ": "linear",
	Gcls: "classic",
	Smoo: "smooth",
};

function parseGradientMapAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdGradientMapAdjustmentInfo {
	const end = offset + length;
	if (length < 52) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map data is truncated.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} Gradient Map version`);
	if (version !== 1 && version !== 3) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Gradient Map version ${version}; versions 1 and 3 are supported.`);
	}
	const reverseFlag = bytes[offset + 2];
	const ditherFlag = bytes[offset + 3];
	if (reverseFlag > 1 || ditherFlag > 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map reverse and dither flags must be 0 or 1.`);
	}
	let cursor = offset + 4;
	let method: IPsdGradientMapAdjustmentInfo["method"] = "classic";
	if (version === 3) {
		const signature = readAscii(bytes, cursor, 4, `layer ${layerIndex} Gradient Map interpolation method`);
		method = GRADIENT_MAP_METHODS[signature];
		if (!method) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map interpolation method "${signature}" is unsupported.`);
		}
		cursor += 4;
	}
	const nameLength = readUint32(bytes, cursor, `layer ${layerIndex} Gradient Map name length`);
	if (nameLength > 1024 || cursor + 4 + nameLength * 2 > end) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map name exceeds 1024 characters or its data block.`);
	}
	cursor += 4;
	let name = "";
	for (let index = 0; index < nameLength; ++index) {
		name += String.fromCharCode(readUint16(bytes, cursor, `layer ${layerIndex} Gradient Map name character`));
		cursor += 2;
	}
	name = name.replace(/\0+$/, "");
	const colorStopCount = readUint16(bytes, cursor, `layer ${layerIndex} Gradient Map color-stop count`);
	cursor += 2;
	if (colorStopCount > 64 || cursor + colorStopCount * 20 > end) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map must contain at most 64 complete color stops.`);
	}
	const colorStops: IPsdGradientMapColorStopInfo[] = [];
	for (let index = 0; index < colorStopCount; ++index) {
		const rawLocation = readUint32(bytes, cursor, `layer ${layerIndex} Gradient Map color stop ${index} location`);
		const midpointRaw = readUint32(bytes, cursor + 4, `layer ${layerIndex} Gradient Map color stop ${index} midpoint`);
		const color = parseEffectColor(bytes, cursor + 8, `layer ${layerIndex} Gradient Map color stop ${index}`);
		if (midpointRaw < 1 || midpointRaw > 99 || readUint16(bytes, cursor + 18, `layer ${layerIndex} Gradient Map color stop ${index} padding`) !== 0) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map color-stop midpoint must be 1..99 and padding must be zero.`);
		}
		colorStops.push({ rawLocation, location: 0, midpoint: midpointRaw / 100, color });
		cursor += 20;
	}
	const opacityStopCount = readUint16(bytes, cursor, `layer ${layerIndex} Gradient Map opacity-stop count`);
	cursor += 2;
	if (opacityStopCount > 64 || cursor + opacityStopCount * 10 > end) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map must contain at most 64 complete opacity stops.`);
	}
	const opacityStops: IPsdGradientMapOpacityStopInfo[] = [];
	for (let index = 0; index < opacityStopCount; ++index) {
		const rawLocation = readUint32(bytes, cursor, `layer ${layerIndex} Gradient Map opacity stop ${index} location`);
		const midpointRaw = readUint32(bytes, cursor + 4, `layer ${layerIndex} Gradient Map opacity stop ${index} midpoint`);
		const opacityRaw = readUint16(bytes, cursor + 8, `layer ${layerIndex} Gradient Map opacity stop ${index} opacity`);
		if (midpointRaw < 1 || midpointRaw > 99 || opacityRaw > 255) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map opacity-stop midpoint must be 1..99 and opacity must be 0..255.`);
		}
		opacityStops.push({ rawLocation, location: 0, midpoint: midpointRaw / 100, opacity: opacityRaw / 255 });
		cursor += 10;
	}
	if (readUint16(bytes, cursor, `layer ${layerIndex} Gradient Map expansion count`) !== 2) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map expansion count must be 2.`);
	}
	const smoothnessRaw = readUint16(bytes, cursor + 2, `layer ${layerIndex} Gradient Map smoothness`);
	if (smoothnessRaw < 1 || smoothnessRaw > 4096) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map smoothness must be 1..4096.`);
	}
	if (readUint16(bytes, cursor + 4, `layer ${layerIndex} Gradient Map expansion length`) !== 32) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map expansion length must be 32.`);
	}
	const gradientTypeWord = readUint16(bytes, cursor + 6, `layer ${layerIndex} Gradient Map type`);
	if (gradientTypeWord > 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map type must be solid (0) or noise (1).`);
	}
	const randomSeed = readUint32(bytes, cursor + 8, `layer ${layerIndex} Gradient Map random seed`);
	const addTransparencyFlag = readUint16(bytes, cursor + 12, `layer ${layerIndex} Gradient Map add-transparency flag`);
	const restrictColorsFlag = readUint16(bytes, cursor + 14, `layer ${layerIndex} Gradient Map restrict-colors flag`);
	const roughnessRaw = readUint32(bytes, cursor + 16, `layer ${layerIndex} Gradient Map roughness`);
	const colorModelWord = readUint16(bytes, cursor + 20, `layer ${layerIndex} Gradient Map color model`);
	const colorModels: Record<number, IPsdGradientMapAdjustmentInfo["colorModel"]> = { 3: "rgb", 4: "hsb", 6: "lab" };
	if (addTransparencyFlag > 1 || restrictColorsFlag > 1 || roughnessRaw > 4096 || !colorModels[colorModelWord]) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map noise settings contain an invalid flag, roughness, or color model.`);
	}
	const minimum = Array.from({ length: 4 }, (_, index) => readUint16(bytes, cursor + 22 + index * 2, `layer ${layerIndex} Gradient Map minimum ${index}`) / 0x8000) as [
		number,
		number,
		number,
		number,
	];
	const maximum = Array.from({ length: 4 }, (_, index) => readUint16(bytes, cursor + 30 + index * 2, `layer ${layerIndex} Gradient Map maximum ${index}`) / 0x8000) as [
		number,
		number,
		number,
		number,
	];
	if (minimum.some((value, index) => value > 1 || maximum[index] > 1 || value > maximum[index])) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map minimum/maximum ranges must be ordered within 0..1.`);
	}
	cursor += 42;
	if (cursor > end || end - cursor > 3 || bytes.subarray(cursor - 4, end).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Gradient Map must end with four zero reserved bytes and at most three zero alignment bytes.`);
	}
	for (const stop of colorStops) {
		stop.location = stop.rawLocation / smoothnessRaw;
	}
	for (const stop of opacityStops) {
		stop.location = stop.rawLocation / smoothnessRaw;
	}
	const ordered = (stops: Array<{ location: number }>) =>
		stops.every((stop, index) => stop.location >= 0 && stop.location <= 1 && (index === 0 || stop.location >= stops[index - 1].location));
	const solidIsExecutable =
		colorStops.length >= 2 && opacityStops.length >= 1 && ordered(colorStops) && ordered(opacityStops) && colorStops.every((stop) => stop.color.rgba !== null);
	return {
		key: "grdm",
		version,
		name,
		gradientType: gradientTypeWord === 1 ? "noise" : "solid",
		reverse: reverseFlag === 1,
		dither: ditherFlag === 1,
		method,
		smoothness: smoothnessRaw / 4096,
		smoothnessRaw,
		colorStops,
		opacityStops,
		randomSeed,
		addTransparency: addTransparencyFlag === 1,
		restrictColors: restrictColorsFlag === 1,
		roughness: roughnessRaw / 4096,
		roughnessRaw,
		colorModel: colorModels[colorModelWord],
		minimum,
		maximum,
		gradientModel: "bounded-gradient-map-v1",
		noiseModel: "bounded-seeded-multioctave-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: gradientTypeWord === 1 || solidIsExecutable,
	};
}

function decodeUnicodeLayerName(bytes: Uint8Array, offset: number, length: number): string | null {
	if (length < 4) {
		return null;
	}
	const characters = readUint32(bytes, offset, "Unicode layer-name character count");
	if (characters > 1024 || 4 + characters * 2 > length) {
		throw new Error("Malformed PSD: Unicode layer name exceeds its additional-info block or the 1024-character limit.");
	}
	let result = "";
	for (let index = 0; index < characters; ++index) {
		result += String.fromCharCode(readUint16(bytes, offset + 4 + index * 2, "Unicode layer-name character"));
	}
	return result.replace(/\0/g, "").trim() || null;
}

function parseEffectColor(bytes: Uint8Array, offset: number, label: string): IPsdLayerEffectColorInfo {
	const space = readUint16(bytes, offset, `${label} color space`);
	const components: [number, number, number, number] = [
		readUint16(bytes, offset + 2, `${label} color component 0`),
		readUint16(bytes, offset + 4, `${label} color component 1`),
		readUint16(bytes, offset + 6, `${label} color component 2`),
		readUint16(bytes, offset + 8, `${label} color component 3`),
	];
	return {
		space,
		components,
		rgba: space === 0 ? [Math.round(components[0] / 257), Math.round(components[1] / 257), Math.round(components[2] / 257), 255] : null,
	};
}

interface IPsdDescriptorUnitValue {
	units: string;
	value: number;
}

interface IPsdDescriptorEnumValue {
	enumType: string;
	value: string;
}

interface IPsdDescriptorObjectValue {
	name: string;
	classId: string;
	entries: Array<{ key: string; type: string; value: PsdDescriptorValue }>;
}

interface IPsdDescriptorObjectArrayValue {
	version: 16;
	name: string;
	classId: string;
	fields: Array<{ type: string; units: string; values: number[] }>;
}

type PsdDescriptorValue =
	| string
	| number
	| boolean
	| Uint8Array
	| IPsdDescriptorUnitValue
	| IPsdDescriptorEnumValue
	| IPsdDescriptorObjectValue
	| IPsdDescriptorObjectArrayValue
	| PsdDescriptorValue[];

interface IPsdDescriptorCursor {
	offset: number;
	end: number;
	items: number;
}

function readDescriptorFloat64(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): number {
	assertRange(bytes, cursor.offset, 8, label);
	const value = new DataView(bytes.buffer, bytes.byteOffset + cursor.offset, 8).getFloat64(0, false);
	cursor.offset += 8;
	return value;
}

function readDescriptorFloat32(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): number {
	assertRange(bytes, cursor.offset, 4, label);
	const value = new DataView(bytes.buffer, bytes.byteOffset + cursor.offset, 4).getFloat32(0, false);
	cursor.offset += 4;
	return value;
}

function readDescriptorUnicode(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): string {
	const length = readUint32(bytes, cursor.offset, `${label} length`);
	cursor.offset += 4;
	const byteLength = length * 2;
	if (!Number.isSafeInteger(byteLength) || byteLength > MAXIMUM_PSD_DESCRIPTOR_STRING_BYTES) {
		throw new Error(`Unsupported PSD: ${label} exceeds the bounded descriptor string limit.`);
	}
	assertRange(bytes, cursor.offset, byteLength, label);
	let value = "";
	for (let index = 0; index < length; ++index) {
		value += String.fromCharCode(readUint16(bytes, cursor.offset + index * 2, label));
	}
	cursor.offset += byteLength;
	return value.replace(/\0/g, "");
}

function readDescriptorClassId(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): string {
	const declaredLength = readInt32(bytes, cursor.offset, `${label} length`);
	cursor.offset += 4;
	const length = declaredLength === 0 ? 4 : declaredLength;
	if (length < 0 || length > 1024) {
		throw new Error(`Unsupported PSD: ${label} length ${length} exceeds the bounded descriptor class-id limit.`);
	}
	const value = readAscii(bytes, cursor.offset, length, label);
	cursor.offset += length;
	return value;
}

function readPsdDescriptorReference(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): PsdDescriptorValue[] {
	const count = readInt32(bytes, cursor.offset, `${label} reference count`);
	cursor.offset += 4;
	if (count < 0 || cursor.items + count > MAXIMUM_PSD_DESCRIPTOR_ITEMS) {
		throw new Error(`Unsupported PSD: ${label} reference exceeds the bounded descriptor item limit.`);
	}
	cursor.items += count;
	const values: PsdDescriptorValue[] = [];
	const readClass = (itemLabel: string): { name: string; classId: string } => ({
		name: readDescriptorUnicode(bytes, cursor, `${itemLabel} class name`),
		classId: readDescriptorClassId(bytes, cursor, `${itemLabel} class id`),
	});
	for (let index = 0; index < count; ++index) {
		const itemLabel = `${label} reference item ${index}`;
		const type = readAscii(bytes, cursor.offset, 4, `${itemLabel} type`);
		cursor.offset += 4;
		if (type === "Enmr") {
			readClass(itemLabel);
			values.push({ enumType: readDescriptorClassId(bytes, cursor, `${itemLabel} enum type`), value: readDescriptorClassId(bytes, cursor, `${itemLabel} enum value`) });
		} else if (type === "prop") {
			readClass(itemLabel);
			values.push(readDescriptorClassId(bytes, cursor, `${itemLabel} property key`));
		} else if (type === "Clss") {
			values.push(readClass(itemLabel).classId);
		} else if (type === "rele") {
			readClass(itemLabel);
			values.push(readUint32(bytes, cursor.offset, `${itemLabel} offset`));
			cursor.offset += 4;
		} else if (type === "Idnt" || type === "indx") {
			values.push(readInt32(bytes, cursor.offset, itemLabel));
			cursor.offset += 4;
		} else if (type === "name") {
			readClass(itemLabel);
			values.push(readDescriptorUnicode(bytes, cursor, `${itemLabel} name`));
		} else {
			throw new Error(`Unsupported PSD descriptor reference type ${type} in ${itemLabel}.`);
		}
	}
	return values;
}

function readPsdDescriptorValue(bytes: Uint8Array, cursor: IPsdDescriptorCursor, type: string, depth: number, label: string): PsdDescriptorValue {
	if (depth > MAXIMUM_PSD_DESCRIPTOR_DEPTH) {
		throw new Error(`Unsupported PSD: ${label} exceeds the bounded descriptor nesting limit.`);
	}
	if (type === "Objc" || type === "GlbO") {
		return readPsdDescriptorObject(bytes, cursor, depth + 1, label);
	}
	if (type === "obj ") {
		return readPsdDescriptorReference(bytes, cursor, label);
	}
	if (type === "VlLs") {
		const count = readInt32(bytes, cursor.offset, `${label} list count`);
		cursor.offset += 4;
		if (count < 0 || cursor.items + count > MAXIMUM_PSD_DESCRIPTOR_ITEMS) {
			throw new Error(`Unsupported PSD: ${label} list exceeds the bounded descriptor item limit.`);
		}
		cursor.items += count;
		const values: PsdDescriptorValue[] = [];
		for (let index = 0; index < count; ++index) {
			const itemType = readAscii(bytes, cursor.offset, 4, `${label} item ${index} type`);
			cursor.offset += 4;
			values.push(readPsdDescriptorValue(bytes, cursor, itemType, depth + 1, `${label} item ${index}`));
		}
		return values;
	}
	if (type === "doub") {
		return readDescriptorFloat64(bytes, cursor, label);
	}
	if (type === "UntF" || type === "UnFl") {
		const units = readAscii(bytes, cursor.offset, 4, `${label} units`);
		cursor.offset += 4;
		return { units, value: type === "UntF" ? readDescriptorFloat64(bytes, cursor, label) : readDescriptorFloat32(bytes, cursor, label) };
	}
	if (type === "TEXT") {
		return readDescriptorUnicode(bytes, cursor, label);
	}
	if (type === "enum") {
		return { enumType: readDescriptorClassId(bytes, cursor, `${label} enum type`), value: readDescriptorClassId(bytes, cursor, `${label} enum value`) };
	}
	if (type === "long") {
		const value = readInt32(bytes, cursor.offset, label);
		cursor.offset += 4;
		return value;
	}
	if (type === "comp") {
		const high = readUint32(bytes, cursor.offset, `${label} high`);
		const low = readUint32(bytes, cursor.offset + 4, `${label} low`);
		cursor.offset += 8;
		return high * 0x100000000 + low;
	}
	if (type === "bool") {
		assertRange(bytes, cursor.offset, 1, label);
		return bytes[cursor.offset++] !== 0;
	}
	if (type === "tdta" || type === "alis") {
		const length = readInt32(bytes, cursor.offset, `${label} byte length`);
		cursor.offset += 4;
		if (length < 0 || length > MAXIMUM_PSD_DESCRIPTOR_STRING_BYTES) {
			throw new Error(`Unsupported PSD: ${label} exceeds the bounded descriptor byte-string limit.`);
		}
		assertRange(bytes, cursor.offset, length, label);
		const value = bytes.slice(cursor.offset, cursor.offset + length);
		cursor.offset += length;
		return value;
	}
	if (type === "ObAr") {
		const version = readInt32(bytes, cursor.offset, `${label} version`);
		cursor.offset += 4;
		if (version !== 16) {
			throw new Error(`Unsupported PSD: ${label} object-array version ${version}; version 16 is required.`);
		}
		const name = readDescriptorUnicode(bytes, cursor, `${label} name`);
		const classId = readDescriptorClassId(bytes, cursor, `${label} class id`);
		const count = readInt32(bytes, cursor.offset, `${label} field count`);
		cursor.offset += 4;
		if (count < 0 || cursor.items + count > MAXIMUM_PSD_DESCRIPTOR_ITEMS) {
			throw new Error(`Unsupported PSD: ${label} object array exceeds the bounded descriptor item limit.`);
		}
		cursor.items += count;
		const fields: IPsdDescriptorObjectArrayValue["fields"] = [];
		for (let index = 0; index < count; ++index) {
			const fieldType = readDescriptorClassId(bytes, cursor, `${label} field ${index} type`);
			const valueType = readAscii(bytes, cursor.offset, 4, `${label} field ${index} value type`);
			cursor.offset += 4;
			if (valueType !== "UnFl") {
				throw new Error(`Unsupported PSD: ${label} field ${index} type ${valueType}; bounded object arrays require UnFl.`);
			}
			const units = readAscii(bytes, cursor.offset, 4, `${label} field ${index} units`);
			cursor.offset += 4;
			const valueCount = readInt32(bytes, cursor.offset, `${label} field ${index} value count`);
			cursor.offset += 4;
			if (valueCount < 0 || cursor.items + valueCount > MAXIMUM_PSD_DESCRIPTOR_ITEMS) {
				throw new Error(`Unsupported PSD: ${label} field ${index} values exceed the bounded descriptor item limit.`);
			}
			cursor.items += valueCount;
			fields.push({
				type: fieldType,
				units,
				values: Array.from({ length: valueCount }, (_, valueIndex) => readDescriptorFloat64(bytes, cursor, `${label} field ${index} value ${valueIndex}`)),
			});
		}
		return { version: 16, name, classId, fields };
	}
	if (type === "type" || type === "GlbC") {
		return { name: readDescriptorUnicode(bytes, cursor, `${label} name`), classId: readDescriptorClassId(bytes, cursor, `${label} class id`), entries: [] };
	}
	throw new Error(`Unsupported PSD descriptor OSType ${type} in ${label}.`);
}

function readPsdDescriptorObject(bytes: Uint8Array, cursor: IPsdDescriptorCursor, depth: number, label: string): IPsdDescriptorObjectValue {
	const name = readDescriptorUnicode(bytes, cursor, `${label} name`);
	const classId = readDescriptorClassId(bytes, cursor, `${label} class id`);
	const count = readUint32(bytes, cursor.offset, `${label} item count`);
	cursor.offset += 4;
	if (cursor.items + count > MAXIMUM_PSD_DESCRIPTOR_ITEMS) {
		throw new Error(`Unsupported PSD: ${label} exceeds the bounded descriptor item limit.`);
	}
	cursor.items += count;
	const entries: Array<{ key: string; type: string; value: PsdDescriptorValue }> = [];
	for (let index = 0; index < count; ++index) {
		const key = readDescriptorClassId(bytes, cursor, `${label} item ${index} key`);
		const type = readAscii(bytes, cursor.offset, 4, `${label} item ${index} type`);
		cursor.offset += 4;
		entries.push({ key, type, value: readPsdDescriptorValue(bytes, cursor, type, depth + 1, `${label}.${key}`) });
	}
	return { name, classId, entries };
}

function descriptorEntry(object: IPsdDescriptorObjectValue, key: string): PsdDescriptorValue | undefined {
	return object.entries.find((entry) => entry.key === key)?.value;
}

function descriptorBoolean(object: IPsdDescriptorObjectValue, key: string, fallback: boolean): boolean {
	const value = descriptorEntry(object, key);
	return typeof value === "boolean" ? value : fallback;
}

function descriptorEnum(object: IPsdDescriptorObjectValue, key: string): IPsdDescriptorEnumValue | null {
	const value = descriptorEntry(object, key);
	return value && typeof value === "object" && !Array.isArray(value) && "enumType" in value ? (value as IPsdDescriptorEnumValue) : null;
}

function descriptorUnit(object: IPsdDescriptorObjectValue, key: string): IPsdDescriptorUnitValue | null {
	const value = descriptorEntry(object, key);
	return value && typeof value === "object" && !Array.isArray(value) && "units" in value ? (value as IPsdDescriptorUnitValue) : null;
}

function descriptorObject(object: IPsdDescriptorObjectValue, key: string): IPsdDescriptorObjectValue | null {
	const value = descriptorEntry(object, key);
	return value && typeof value === "object" && !Array.isArray(value) && "entries" in value ? (value as IPsdDescriptorObjectValue) : null;
}

function descriptorObjectArray(object: IPsdDescriptorObjectValue, key: string): IPsdDescriptorObjectArrayValue | null {
	const value = descriptorEntry(object, key);
	return value && typeof value === "object" && !Array.isArray(value) && "fields" in value ? (value as IPsdDescriptorObjectArrayValue) : null;
}

function descriptorNumber(object: IPsdDescriptorObjectValue, key: string, fallback: number): number {
	const value = descriptorEntry(object, key);
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function exactDescriptorNumber(object: IPsdDescriptorObjectValue, key: string, layerIndex: number): number {
	const matches = object.entries.filter((entry) => entry.key === key);
	if (matches.length !== 1 || typeof matches[0].value !== "number" || !Number.isFinite(matches[0].value)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo color requires exactly one finite numeric ${key} value.`);
	}
	return matches[0].value;
}

function boundedPsdSolidColorByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function parsePsdSolidColorFill(
	data: Uint8Array,
	layerIndex: number,
	renderBounds: IPsdSolidColorFillInfo["renderBounds"],
	coverageSource: IPsdSolidColorFillInfo["coverageSource"]
): IPsdSolidColorFillInfo {
	if (data.byteLength < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo record must contain descriptor version 16 and a descriptor.`);
	}
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} SoCo descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} SoCo descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: data.byteLength, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} SoCo descriptor`);
	if (cursor.offset !== cursor.end) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo descriptor leaves ${cursor.end - cursor.offset} trailing byte(s).`);
	}
	const colorEntries = root.entries.filter((entry) => entry.key === "Clr ");
	if (colorEntries.length !== 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo descriptor requires exactly one Clr  object.`);
	}
	const colorValue = colorEntries[0].value;
	if (!colorValue || typeof colorValue !== "object" || Array.isArray(colorValue) || !("entries" in colorValue)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo Clr  value must be an object descriptor.`);
	}
	const color = colorValue as IPsdDescriptorObjectValue;
	const colorKeys = color.entries.map((entry) => entry.key);
	const duplicateColorKeys = [...new Set(colorKeys.filter((key, index) => colorKeys.indexOf(key) !== index))];
	if (duplicateColorKeys.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo color descriptor contains duplicate key(s) ${duplicateColorKeys.join(", ")}.`);
	}
	const modelMatches = [
		{ model: "rgb" as const, classId: "RGBC", keys: ["Rd  ", "Grn ", "Bl  "] },
		{ model: "floatRgb" as const, classId: "RGBC", keys: ["redFloat", "greenFloat", "blueFloat"] },
		{ model: "hsb" as const, classId: "HSBC", keys: ["H   ", "Strt", "Brgh"] },
		{ model: "cmyk" as const, classId: "CMYC", keys: ["Cyn ", "Mgnt", "Ylw ", "Blck"] },
		{ model: "gray" as const, classId: "GRYC", keys: ["Gry "] },
		{ model: "lab" as const, classId: "LABC", keys: ["Lmnc", "A   ", "B   "] },
	].filter((candidate) => candidate.keys.every((key) => colorKeys.includes(key)));
	if (modelMatches.length > 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} SoCo color descriptor ambiguously defines ${modelMatches.map((match) => match.model).join(" and ")}.`);
	}
	if (modelMatches[0] && color.classId !== modelMatches[0].classId) {
		throw new Error(
			`Malformed PSD: layer ${layerIndex} SoCo ${modelMatches[0].model} values require color class ${modelMatches[0].classId}, not ${color.classId || "(empty)"}.`
		);
	}
	let colorModel: PsdSolidColorFillModel = "unknown";
	let authoredValues: number[] = [];
	let rgba: [number, number, number, 255] | null = null;
	let conversionModel: IPsdSolidColorFillInfo["conversionModel"] = "unsupported";
	if (["Rd  ", "Grn ", "Bl  "].every((key) => colorKeys.includes(key))) {
		colorModel = "rgb";
		authoredValues = [exactDescriptorNumber(color, "Rd  ", layerIndex), exactDescriptorNumber(color, "Grn ", layerIndex), exactDescriptorNumber(color, "Bl  ", layerIndex)];
		if (authoredValues.some((value) => value < 0 || value > 255)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo RGB values must be within 0..255.`);
		}
		rgba = [boundedPsdSolidColorByte(authoredValues[0]), boundedPsdSolidColorByte(authoredValues[1]), boundedPsdSolidColorByte(authoredValues[2]), 255];
		conversionModel = "identity-rgb8";
	} else if (["redFloat", "greenFloat", "blueFloat"].every((key) => colorKeys.includes(key))) {
		colorModel = "floatRgb";
		authoredValues = [
			exactDescriptorNumber(color, "redFloat", layerIndex),
			exactDescriptorNumber(color, "greenFloat", layerIndex),
			exactDescriptorNumber(color, "blueFloat", layerIndex),
		];
		if (authoredValues.some((value) => value < 0 || value > 1)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo float-RGB values must be within 0..1 for bounded RGB8 rendering.`);
		}
		rgba = authoredValues.map((value) => boundedPsdSolidColorByte(value * 255)).concat(255) as [number, number, number, 255];
		conversionModel = "bounded-srgb-v1";
	} else if (["H   ", "Strt", "Brgh"].every((key) => colorKeys.includes(key))) {
		const hueEntries = color.entries.filter((entry) => entry.key === "H   ");
		const hue = hueEntries.length === 1 && hueEntries[0].value && typeof hueEntries[0].value === "object" && "units" in hueEntries[0].value ? hueEntries[0].value : null;
		if (!hue || hue.units !== "#Ang" || !Number.isFinite(hue.value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo HSB hue must be one finite #Ang unit value.`);
		}
		colorModel = "hsb";
		authoredValues = [hue.value, exactDescriptorNumber(color, "Strt", layerIndex), exactDescriptorNumber(color, "Brgh", layerIndex)];
		if (authoredValues[0] < 0 || authoredValues[0] > 360 || authoredValues[1] < 0 || authoredValues[1] > 100 || authoredValues[2] < 0 || authoredValues[2] > 100) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo HSB values must use hue 0..360 and saturation/brightness 0..100.`);
		}
		const converted = hsbToRgb(authoredValues[0] / 360, authoredValues[1] / 100, authoredValues[2] / 100);
		rgba = [boundedPsdSolidColorByte(converted[0]), boundedPsdSolidColorByte(converted[1]), boundedPsdSolidColorByte(converted[2]), 255];
		conversionModel = "bounded-srgb-v1";
	} else if (["Cyn ", "Mgnt", "Ylw ", "Blck"].every((key) => colorKeys.includes(key))) {
		colorModel = "cmyk";
		authoredValues = [
			exactDescriptorNumber(color, "Cyn ", layerIndex),
			exactDescriptorNumber(color, "Mgnt", layerIndex),
			exactDescriptorNumber(color, "Ylw ", layerIndex),
			exactDescriptorNumber(color, "Blck", layerIndex),
		];
		if (authoredValues.some((value) => value < 0 || value > 100)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo CMYK values must be within 0..100.`);
		}
		const [cyan, magenta, yellow, black] = authoredValues.map((value) => value / 100);
		rgba = [
			boundedPsdSolidColorByte(255 * (1 - cyan) * (1 - black)),
			boundedPsdSolidColorByte(255 * (1 - magenta) * (1 - black)),
			boundedPsdSolidColorByte(255 * (1 - yellow) * (1 - black)),
			255,
		];
		conversionModel = "bounded-srgb-v1";
	} else if (colorKeys.includes("Gry ")) {
		colorModel = "gray";
		authoredValues = [exactDescriptorNumber(color, "Gry ", layerIndex)];
		if (authoredValues[0] < 0 || authoredValues[0] > 100) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo Gray value must be within 0..100.`);
		}
		const value = boundedPsdSolidColorByte((authoredValues[0] / 100) * 255);
		rgba = [value, value, value, 255];
		conversionModel = "bounded-srgb-v1";
	} else if (["Lmnc", "A   ", "B   "].every((key) => colorKeys.includes(key))) {
		colorModel = "lab";
		authoredValues = [exactDescriptorNumber(color, "Lmnc", layerIndex), exactDescriptorNumber(color, "A   ", layerIndex), exactDescriptorNumber(color, "B   ", layerIndex)];
		if (authoredValues[0] < 0 || authoredValues[0] > 100 || authoredValues[1] < -128 || authoredValues[1] > 127 || authoredValues[2] < -128 || authoredValues[2] > 127) {
			throw new Error(`Malformed PSD: layer ${layerIndex} SoCo Lab values must use L 0..100 and a/b -128..127.`);
		}
		const converted = labToRgb(authoredValues[0], authoredValues[1], authoredValues[2]);
		rgba = [boundedPsdSolidColorByte(converted[0]), boundedPsdSolidColorByte(converted[1]), boundedPsdSolidColorByte(converted[2]), 255];
		conversionModel = "bounded-srgb-v1";
	}
	return {
		sourceKey: "SoCo",
		descriptorVersion: 16,
		descriptorClassId: root.classId,
		descriptorEntryKeys: root.entries.map((entry) => entry.key),
		descriptorEntryTypes: root.entries.map((entry) => entry.type),
		colorClassId: color.classId,
		colorEntryKeys: colorKeys,
		colorEntryTypes: color.entries.map((entry) => entry.type),
		colorModel,
		authoredValues,
		rgba,
		renderBounds,
		coverageSource,
		conversionModel,
		executionModel: "bounded-solid-color-fill-layer-v1",
		bakeSupported: rgba !== null,
	};
}

function duplicateDescriptorKeys(object: IPsdDescriptorObjectValue): string[] {
	const keys = object.entries.map((entry) => entry.key);
	return [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
}

function parsePsdPatternFill(
	data: Uint8Array,
	layerIndex: number,
	renderBounds: IPsdPatternFillInfo["renderBounds"],
	coverageSource: IPsdPatternFillInfo["coverageSource"]
): IPsdPatternFillInfo {
	if (data.byteLength < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl record must contain descriptor version 16 and a descriptor.`);
	}
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} PtFl descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} PtFl descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: data.byteLength, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} PtFl descriptor`);
	const descriptorPaddingBytes = cursor.end - cursor.offset;
	if (descriptorPaddingBytes < 0 || descriptorPaddingBytes > 3 || data.subarray(cursor.offset).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl descriptor leaves ${descriptorPaddingBytes} invalid trailing byte(s).`);
	}
	if (root.classId !== "null") {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl root descriptor class must be null, not ${root.classId || "(empty)"}.`);
	}
	const duplicateRootKeys = duplicateDescriptorKeys(root);
	if (duplicateRootKeys.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl descriptor contains duplicate key(s) ${duplicateRootKeys.join(", ")}.`);
	}
	const patternEntry = root.entries.find((entry) => entry.key === "Ptrn");
	if (!patternEntry || (patternEntry.type !== "Objc" && patternEntry.type !== "GlbO")) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl descriptor requires exactly one Ptrn object.`);
	}
	const patternValue = patternEntry.value;
	if (!patternValue || typeof patternValue !== "object" || Array.isArray(patternValue) || !("entries" in patternValue)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl Ptrn value must be an object descriptor.`);
	}
	const patternObject = patternValue as IPsdDescriptorObjectValue;
	if (patternObject.classId !== "Ptrn") {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl pattern descriptor class must be Ptrn, not ${patternObject.classId || "(empty)"}.`);
	}
	const duplicatePatternKeys = duplicateDescriptorKeys(patternObject);
	if (duplicatePatternKeys.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl pattern descriptor contains duplicate key(s) ${duplicatePatternKeys.join(", ")}.`);
	}
	for (const key of ["Nm  ", "Idnt"] as const) {
		const entry = patternObject.entries.find((candidate) => candidate.key === key);
		if (!entry || entry.type !== "TEXT" || typeof entry.value !== "string") {
			throw new Error(`Malformed PSD: layer ${layerIndex} PtFl pattern requires exactly one TEXT ${key} value.`);
		}
	}
	const name = descriptorString(patternObject, "Nm  ");
	const id = descriptorString(patternObject, "Idnt");
	if (!id || id.length > 1024 || name.length > 1024) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl pattern name/id exceed bounded requirements.`);
	}
	const optionalUnit = (key: "Scl " | "Angl", units: "#Prc" | "#Ang", fallback: number): number => {
		const entry = root.entries.find((candidate) => candidate.key === key);
		if (!entry) {
			return fallback;
		}
		const value = entry.value;
		if (entry.type !== "UntF" || !value || typeof value !== "object" || Array.isArray(value) || !("units" in value) || value.units !== units || !Number.isFinite(value.value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} PtFl ${key} must be one finite ${units} unit value.`);
		}
		return value.value;
	};
	const optionalBoolean = (key: "Algn" | "Lnkd", fallback: boolean): boolean => {
		const entry = root.entries.find((candidate) => candidate.key === key);
		if (!entry) {
			return fallback;
		}
		if (entry.type !== "bool" || typeof entry.value !== "boolean") {
			throw new Error(`Malformed PSD: layer ${layerIndex} PtFl ${key} must be one Boolean value.`);
		}
		return entry.value;
	};
	let phaseX = 0;
	let phaseY = 0;
	const phaseEntry = root.entries.find((entry) => entry.key === "phase");
	if (phaseEntry) {
		const value = phaseEntry.value;
		if ((phaseEntry.type !== "Objc" && phaseEntry.type !== "GlbO") || !value || typeof value !== "object" || Array.isArray(value) || !("entries" in value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} PtFl phase must be one Pnt  object.`);
		}
		const phase = value as IPsdDescriptorObjectValue;
		if (phase.classId !== "Pnt ") {
			throw new Error(`Malformed PSD: layer ${layerIndex} PtFl phase descriptor class must be Pnt , not ${phase.classId || "(empty)"}.`);
		}
		const duplicatePhaseKeys = duplicateDescriptorKeys(phase);
		if (duplicatePhaseKeys.length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} PtFl phase descriptor contains duplicate key(s) ${duplicatePhaseKeys.join(", ")}.`);
		}
		for (const key of ["Hrzn", "Vrtc"] as const) {
			const entry = phase.entries.find((candidate) => candidate.key === key);
			if (!entry || (entry.type !== "long" && entry.type !== "doub") || typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} PtFl phase requires one finite numeric ${key} value.`);
			}
		}
		phaseX = descriptorNumber(phase, "Hrzn", 0);
		phaseY = descriptorNumber(phase, "Vrtc", 0);
	}
	const pattern: IPsdLayerPatternInfo = {
		name,
		id,
		scale: optionalUnit("Scl ", "#Prc", 100),
		scaleUnits: "#Prc",
		angle: optionalUnit("Angl", "#Ang", 0),
		angleUnits: "#Ang",
		align: optionalBoolean("Algn", true),
		linked: optionalBoolean("Lnkd", true),
		phaseX,
		phaseY,
		resolutionStatus: "missing",
		resolvedPatternIndices: [],
		resolvedPatternIndex: null,
		resolvedPatternName: null,
		resolvedWidth: null,
		resolvedHeight: null,
		executionModel: "bounded-pattern-v1",
		bakeSupported: false,
	};
	if (!patternDescriptorIsBounded(pattern)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} PtFl pattern scale, angle, phase, name, or ID exceeds bounded rendering limits.`);
	}
	return {
		sourceKey: "PtFl",
		descriptorVersion: 16,
		descriptorClassId: root.classId,
		descriptorEntryKeys: root.entries.map((entry) => entry.key),
		descriptorEntryTypes: root.entries.map((entry) => entry.type),
		descriptorPaddingBytes: descriptorPaddingBytes as 0 | 1 | 2 | 3,
		patternClassId: patternObject.classId,
		patternEntryKeys: patternObject.entries.map((entry) => entry.key),
		patternEntryTypes: patternObject.entries.map((entry) => entry.type),
		pattern,
		renderBounds,
		coverageSource,
		executionModel: "bounded-pattern-fill-layer-v1",
		bakeSupported: false,
	};
}

function parsePsdGradientFill(
	data: Uint8Array,
	layerIndex: number,
	renderBounds: IPsdGradientFillInfo["renderBounds"],
	coverageSource: IPsdGradientFillInfo["coverageSource"]
): IPsdGradientFillInfo {
	if (data.byteLength < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl record must contain descriptor version 16 and a descriptor.`);
	}
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} GdFl descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} GdFl descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: data.byteLength, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} GdFl descriptor`);
	const descriptorPaddingBytes = cursor.end - cursor.offset;
	if (descriptorPaddingBytes < 0 || descriptorPaddingBytes > 3 || data.subarray(cursor.offset).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl descriptor leaves ${descriptorPaddingBytes} invalid trailing byte(s).`);
	}
	if (root.classId !== "null") {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl root descriptor class must be null, not ${root.classId || "(empty)"}.`);
	}
	const duplicateRootKeys = duplicateDescriptorKeys(root);
	if (duplicateRootKeys.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl descriptor contains duplicate key(s) ${duplicateRootKeys.join(", ")}.`);
	}
	const entry = (object: IPsdDescriptorObjectValue, key: string): (typeof object.entries)[number] | undefined => object.entries.find((candidate) => candidate.key === key);
	const requireEntryType = (object: IPsdDescriptorObjectValue, key: string, types: readonly string[], label: string): (typeof object.entries)[number] => {
		const value = entry(object, key);
		if (!value || !types.includes(value.type)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} GdFl ${label} requires exactly one ${types.join("/")} ${key} value.`);
		}
		return value;
	};
	const optionalEntryType = (object: IPsdDescriptorObjectValue, key: string, types: readonly string[], label: string): void => {
		const value = entry(object, key);
		if (value && !types.includes(value.type)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} GdFl ${label} ${key} must use ${types.join("/")}, not ${value.type}.`);
		}
	};
	const styleEntry = requireEntryType(root, "Type", ["enum"], "root descriptor");
	const styleValue = styleEntry.value as IPsdDescriptorEnumValue;
	if (!styleValue || styleValue.enumType !== "GrdT") {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl Type must be a GrdT enumeration.`);
	}
	for (const key of ["Dthr", "Rvrs", "Algn"] as const) {
		optionalEntryType(root, key, ["bool"], "root descriptor");
	}
	for (const [key, units] of [
		["Angl", "#Ang"],
		["Scl ", "#Prc"],
	] as const) {
		optionalEntryType(root, key, ["UntF"], "root descriptor");
		const value = descriptorUnit(root, key);
		if (entry(root, key) && (!value || value.units !== units || !Number.isFinite(value.value))) {
			throw new Error(`Malformed PSD: layer ${layerIndex} GdFl ${key} must be one finite ${units} unit value.`);
		}
	}
	for (const key of ["gs99", "gradientsInterpolationMethod"] as const) {
		optionalEntryType(root, key, ["enum"], "root descriptor");
		const value = descriptorEnum(root, key);
		if (entry(root, key) && (!value || value.enumType !== "gradientInterpolationMethodType")) {
			throw new Error(`Malformed PSD: layer ${layerIndex} GdFl ${key} must be a gradientInterpolationMethodType enumeration.`);
		}
	}
	const offsetEntry = entry(root, "Ofst");
	if (offsetEntry) {
		if (
			(offsetEntry.type !== "Objc" && offsetEntry.type !== "GlbO") ||
			!offsetEntry.value ||
			typeof offsetEntry.value !== "object" ||
			Array.isArray(offsetEntry.value) ||
			!("entries" in offsetEntry.value)
		) {
			throw new Error(`Malformed PSD: layer ${layerIndex} GdFl Ofst must be one Pnt  object.`);
		}
		const offset = offsetEntry.value as IPsdDescriptorObjectValue;
		if (offset.classId !== "Pnt " || duplicateDescriptorKeys(offset).length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} GdFl Ofst must be a duplicate-free Pnt  descriptor.`);
		}
		for (const key of ["Hrzn", "Vrtc"] as const) {
			const coordinate = requireEntryType(offset, key, ["UntF"], "offset descriptor");
			const value = coordinate.value as IPsdDescriptorUnitValue;
			if (!value || value.units !== "#Prc" || !Number.isFinite(value.value)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} GdFl Ofst ${key} must be one finite #Prc unit value.`);
			}
		}
	}
	const gradientEntry = requireEntryType(root, "Grad", ["Objc", "GlbO"], "root descriptor");
	if (!gradientEntry.value || typeof gradientEntry.value !== "object" || Array.isArray(gradientEntry.value) || !("entries" in gradientEntry.value)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl Grad must be one Grdn object.`);
	}
	const gradientObject = gradientEntry.value as IPsdDescriptorObjectValue;
	if (gradientObject.classId !== "Grdn") {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl gradient descriptor class must be Grdn, not ${gradientObject.classId || "(empty)"}.`);
	}
	const duplicateGradientKeys = duplicateDescriptorKeys(gradientObject);
	if (duplicateGradientKeys.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl gradient descriptor contains duplicate key(s) ${duplicateGradientKeys.join(", ")}.`);
	}
	const gradientTypeEntry = requireEntryType(gradientObject, "GrdF", ["enum"], "gradient descriptor");
	const gradientType = gradientTypeEntry.value as IPsdDescriptorEnumValue;
	if (!gradientType || gradientType.enumType !== "GrdF") {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl GrdF must be a GrdF enumeration.`);
	}
	requireEntryType(gradientObject, "Nm  ", ["TEXT"], "gradient descriptor");
	if (descriptorString(gradientObject, "Nm  ").length > 1024) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl gradient name exceeds 1024 characters.`);
	}
	if (gradientType.value === "CstS") {
		requireEntryType(gradientObject, "Intr", ["doub", "long"], "solid-gradient descriptor");
		for (const [key, classId] of [
			["Clrs", "Clrt"],
			["Trns", "TrnS"],
		] as const) {
			const listEntry = requireEntryType(gradientObject, key, ["VlLs"], "solid-gradient descriptor");
			if (!Array.isArray(listEntry.value) || listEntry.value.some((value) => !value || typeof value !== "object" || Array.isArray(value) || !("entries" in value))) {
				throw new Error(`Malformed PSD: layer ${layerIndex} GdFl ${key} must contain only descriptor objects.`);
			}
			for (const value of listEntry.value as IPsdDescriptorObjectValue[]) {
				if (value.classId !== classId || duplicateDescriptorKeys(value).length) {
					throw new Error(`Malformed PSD: layer ${layerIndex} GdFl ${key} requires duplicate-free ${classId} descriptors.`);
				}
				requireEntryType(value, "Lctn", ["long"], `${key} stop`);
				requireEntryType(value, "Mdpn", ["long"], `${key} stop`);
				if (key === "Clrs") {
					requireEntryType(value, "Clr ", ["Objc", "GlbO"], "color stop");
					requireEntryType(value, "Type", ["enum"], "color stop");
				} else {
					const opacity = requireEntryType(value, "Opct", ["UntF"], "opacity stop").value as IPsdDescriptorUnitValue;
					if (!opacity || opacity.units !== "#Prc" || !Number.isFinite(opacity.value)) {
						throw new Error(`Malformed PSD: layer ${layerIndex} GdFl opacity stop must use finite #Prc units.`);
					}
				}
			}
		}
	} else if (gradientType.value === "ClNs") {
		for (const key of ["Smth", "RndS"] as const) {
			requireEntryType(gradientObject, key, ["long"], "noise-gradient descriptor");
		}
		requireEntryType(gradientObject, "ClrS", ["enum"], "noise-gradient descriptor");
		for (const key of ["VctC", "ShTr"] as const) {
			optionalEntryType(gradientObject, key, ["bool"], "noise-gradient descriptor");
		}
		for (const key of ["Mnm ", "Mxm "] as const) {
			requireEntryType(gradientObject, key, ["VlLs"], "noise-gradient descriptor");
		}
	}
	const gradient = parseModernGradient(root);
	if (!gradient) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl descriptor does not contain a readable Grad object.`);
	}
	if (
		!Number.isFinite(gradient.scale) ||
		gradient.scale <= 0 ||
		gradient.scale > 1000 ||
		!Number.isFinite(gradient.angle) ||
		Math.abs(gradient.angle) > 1_000_000 ||
		!Number.isFinite(gradient.offsetX) ||
		!Number.isFinite(gradient.offsetY) ||
		Math.abs(gradient.offsetX) > 1_000_000 ||
		Math.abs(gradient.offsetY) > 1_000_000
	) {
		throw new Error(`Malformed PSD: layer ${layerIndex} GdFl scale, angle, or offset exceeds bounded rendering limits.`);
	}
	return {
		sourceKey: "GdFl",
		descriptorVersion: 16,
		descriptorClassId: root.classId,
		descriptorEntryKeys: root.entries.map((candidate) => candidate.key),
		descriptorEntryTypes: root.entries.map((candidate) => candidate.type),
		descriptorPaddingBytes: descriptorPaddingBytes as 0 | 1 | 2 | 3,
		gradientClassId: gradientObject.classId,
		gradientEntryKeys: gradientObject.entries.map((candidate) => candidate.key),
		gradientEntryTypes: gradientObject.entries.map((candidate) => candidate.type),
		gradient,
		renderBounds,
		coverageSource,
		executionModel: "bounded-gradient-fill-layer-v1",
		bakeSupported: gradient.bakeSupported,
	};
}

const MODERN_BLEND_MODES: Record<string, string> = {
	Nrml: "norm",
	Mltp: "mul ",
	Scrn: "scrn",
	Ovrl: "over",
	Drkn: "dark",
	Lghn: "lite",
	CDdg: "div ",
	CBrn: "idiv",
	HrdL: "hLit",
	SftL: "sLit",
	Dfrn: "diff",
	Xclu: "smud",
	linearDodge: "lddg",
	linearBurn: "lbrn",
	blendSubtraction: "fsub",
	blendDivide: "fdiv",
	"H   ": "hue ",
	Strt: "sat ",
	"Clr ": "colr",
	Lmns: "lum ",
};

function vectorContentFromGeneratedFill(fill: IPsdSolidColorFillInfo | IPsdPatternFillInfo | IPsdGradientFillInfo): IPsdVectorContentInfo {
	if ("rgba" in fill) {
		const rgba = fill.rgba;
		return {
			type: "color",
			descriptorClassId: fill.descriptorClassId,
			descriptorEntryKeys: fill.descriptorEntryKeys,
			descriptorEntryTypes: fill.descriptorEntryTypes,
			color: {
				space: fill.colorModel === "rgb" ? 0 : -1,
				components: rgba ? [rgba[0] * 257, rgba[1] * 257, rgba[2] * 257, 0] : [0, 0, 0, 0],
				rgba,
			},
			gradient: null,
			pattern: null,
			executionModel: "bounded-vector-content-v1",
			bakeSupported: fill.bakeSupported,
		};
	}
	if ("gradient" in fill) {
		return {
			type: "gradient",
			descriptorClassId: fill.descriptorClassId,
			descriptorEntryKeys: fill.descriptorEntryKeys,
			descriptorEntryTypes: fill.descriptorEntryTypes,
			color: null,
			gradient: fill.gradient,
			pattern: null,
			executionModel: "bounded-vector-content-v1",
			bakeSupported: fill.bakeSupported,
		};
	}
	return {
		type: "pattern",
		descriptorClassId: fill.descriptorClassId,
		descriptorEntryKeys: fill.descriptorEntryKeys,
		descriptorEntryTypes: fill.descriptorEntryTypes,
		color: null,
		gradient: null,
		pattern: fill.pattern,
		executionModel: "bounded-vector-content-v1",
		bakeSupported: fill.bakeSupported,
	};
}

function parsePsdVectorContentDescriptor(root: IPsdDescriptorObjectValue, layerIndex: number, label: string): IPsdVectorContentInfo {
	const duplicates = duplicateDescriptorKeys(root);
	if (duplicates.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${label} descriptor contains duplicate key(s) ${duplicates.join(", ")}.`);
	}
	const hasColor = descriptorObject(root, "Clr ") !== null;
	const hasGradient = descriptorObject(root, "Grad") !== null;
	const hasPattern = descriptorObject(root, "Ptrn") !== null;
	if (Number(hasColor) + Number(hasGradient) + Number(hasPattern) !== 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${label} must define exactly one Clr /Grad/Ptrn vector content object.`);
	}
	const base = {
		descriptorClassId: root.classId,
		descriptorEntryKeys: root.entries.map((entry) => entry.key),
		descriptorEntryTypes: root.entries.map((entry) => entry.type),
		executionModel: "bounded-vector-content-v1" as const,
	};
	if (hasColor) {
		const colorObject = descriptorObject(root, "Clr ");
		if (!colorObject || colorObject.classId !== "RGBC" || duplicateDescriptorKeys(colorObject).length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} ${label} color content must be one duplicate-free RGBC descriptor.`);
		}
		for (const key of ["Rd  ", "Grn ", "Bl  "] as const) {
			const entry = colorObject.entries.find((candidate) => candidate.key === key);
			if (!entry || (entry.type !== "doub" && entry.type !== "long") || typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} ${label} color content requires one finite numeric ${key} value.`);
			}
		}
		const color = parseModernDescriptorColor(colorObject);
		return { ...base, type: "color", color, gradient: null, pattern: null, bakeSupported: color.rgba !== null };
	}
	if (hasGradient) {
		const gradient = parseModernGradient(root);
		if (!gradient) {
			throw new Error(`Malformed PSD: layer ${layerIndex} ${label} gradient content is unreadable.`);
		}
		return { ...base, type: "gradient", color: null, gradient, pattern: null, bakeSupported: gradient.bakeSupported };
	}
	const pattern = parseModernPattern(root);
	if (!pattern || !patternDescriptorIsBounded(pattern)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${label} pattern content exceeds bounded descriptor limits.`);
	}
	return { ...base, type: "pattern", color: null, gradient: null, pattern, bakeSupported: pattern.bakeSupported };
}

interface IParsedPsdVectorFill {
	vectorFill: IPsdVectorFillInfo;
	solidColorFill?: IPsdSolidColorFillInfo;
	patternFill?: IPsdPatternFillInfo;
	gradientFill?: IPsdGradientFillInfo;
}

function parsePsdVectorFill(
	data: Uint8Array,
	layerIndex: number,
	renderBounds: "layer" | "document",
	coverageSource: "transparency-channel" | "opaque-generated"
): IParsedPsdVectorFill {
	if (data.byteLength < 8) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vscg record must contain a four-byte content key and version-16 descriptor.`);
	}
	const contentKey = readAscii(data, 0, 4, `layer ${layerIndex} vscg content key`);
	if (contentKey !== "SoCo" && contentKey !== "GdFl" && contentKey !== "PtFl") {
		throw new Error(`Unsupported PSD layer ${layerIndex} vscg content key ${contentKey}; SoCo, GdFl, or PtFl is required.`);
	}
	const descriptor = data.subarray(4);
	const parsedFill =
		contentKey === "SoCo"
			? parsePsdSolidColorFill(descriptor, layerIndex, renderBounds, coverageSource)
			: contentKey === "GdFl"
				? parsePsdGradientFill(descriptor, layerIndex, renderBounds, coverageSource)
				: parsePsdPatternFill(descriptor, layerIndex, renderBounds, coverageSource);
	const descriptorPaddingBytes = "descriptorPaddingBytes" in parsedFill ? parsedFill.descriptorPaddingBytes : 0;
	const vectorFill: IPsdVectorFillInfo = {
		sourceKey: "vscg",
		contentKey,
		descriptorVersion: 16,
		descriptorPaddingBytes,
		content: vectorContentFromGeneratedFill(parsedFill),
		executionModel: "bounded-vector-fill-v1",
		bakeSupported: parsedFill.bakeSupported,
	};
	return {
		vectorFill,
		...(contentKey === "SoCo" ? { solidColorFill: parsedFill as IPsdSolidColorFillInfo } : {}),
		...(contentKey === "PtFl" ? { patternFill: parsedFill as IPsdPatternFillInfo } : {}),
		...(contentKey === "GdFl" ? { gradientFill: parsedFill as IPsdGradientFillInfo } : {}),
	};
}

const PSD_VECTOR_CAPS: Record<string, PsdVectorStrokeLineCap> = {
	strokeStyleButtCap: "butt",
	strokeStyleRoundCap: "round",
	strokeStyleSquareCap: "square",
};
const PSD_VECTOR_JOINS: Record<string, PsdVectorStrokeLineJoin> = {
	strokeStyleMiterJoin: "miter",
	strokeStyleRoundJoin: "round",
	strokeStyleBevelJoin: "bevel",
};
const PSD_VECTOR_ALIGNMENTS: Record<string, PsdVectorStrokeLineAlignment> = {
	strokeStyleAlignInside: "inside",
	strokeStyleAlignCenter: "center",
	strokeStyleAlignOutside: "outside",
};

function vectorStrokeUnitPixels(value: IPsdDescriptorUnitValue, resolution: number, layerIndex: number, label: string): IPsdVectorStrokeUnitInfo {
	const units = value.units as IPsdVectorStrokeUnitInfo["units"];
	const unitScale: Partial<Record<IPsdVectorStrokeUnitInfo["units"], number>> = {
		"#Pxl": 1,
		"#Pnt": resolution / 72,
		"#Mlm": resolution / 25.4,
		RrPi: resolution / 6,
		RrIn: resolution,
		RrCm: resolution / 2.54,
	};
	const scale = unitScale[units];
	if (scale === undefined || !Number.isFinite(value.value) || value.value < 0) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${label} requires a non-negative supported physical unit value.`);
	}
	const pixels = value.value * scale;
	if (!Number.isFinite(pixels) || pixels > 8192) {
		throw new Error(`Unsupported PSD layer ${layerIndex} ${label}; converted width exceeds 8192 pixels.`);
	}
	return { value: value.value, units, pixels };
}

function parsePsdVectorStroke(data: Uint8Array, layerIndex: number): IPsdVectorStrokeInfo {
	if (data.byteLength < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk record must contain descriptor version 16 and a descriptor.`);
	}
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} vstk descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} vstk descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: data.byteLength, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} vstk descriptor`);
	const descriptorPaddingBytes = cursor.end - cursor.offset;
	if (descriptorPaddingBytes < 0 || descriptorPaddingBytes > 3 || data.subarray(cursor.offset).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk descriptor leaves ${descriptorPaddingBytes} invalid trailing byte(s).`);
	}
	if (root.classId !== "strokeStyle") {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk root descriptor class must be strokeStyle, not ${root.classId || "(empty)"}.`);
	}
	const duplicateKeys = duplicateDescriptorKeys(root);
	if (duplicateKeys.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk descriptor contains duplicate key(s) ${duplicateKeys.join(", ")}.`);
	}
	const required = (key: string, types: readonly string[]): (typeof root.entries)[number] => {
		const entry = root.entries.find((candidate) => candidate.key === key);
		if (!entry || !types.includes(entry.type)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vstk ${key} requires exactly one ${types.join("/")} value.`);
		}
		return entry;
	};
	const numberValue = (key: string): number => {
		const entry = required(key, ["long", "doub"]);
		if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vstk ${key} must be finite.`);
		}
		return entry.value;
	};
	const booleanValue = (key: string): boolean => {
		const entry = required(key, ["bool"]);
		if (typeof entry.value !== "boolean") {
			throw new Error(`Malformed PSD: layer ${layerIndex} vstk ${key} must be Boolean.`);
		}
		return entry.value;
	};
	const unitValue = (key: string): IPsdDescriptorUnitValue => {
		const entry = required(key, ["UntF"]);
		if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value) || !("units" in entry.value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vstk ${key} must be a unit value.`);
		}
		return entry.value as IPsdDescriptorUnitValue;
	};
	const enumValue = (key: string, enumType: string): string => {
		const entry = required(key, ["enum"]);
		const value = entry.value as IPsdDescriptorEnumValue;
		if (!value || value.enumType !== enumType) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vstk ${key} must use ${enumType} enumeration.`);
		}
		return value.value;
	};
	const strokeStyleVersion = numberValue("strokeStyleVersion");
	if (strokeStyleVersion !== 2) {
		throw new Error(`Unsupported PSD layer ${layerIndex} vstk strokeStyleVersion ${strokeStyleVersion}; version 2 is required.`);
	}
	const resolution = numberValue("strokeStyleResolution");
	if (resolution <= 0 || resolution > 9600) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk resolution must be within 0..9600 DPI.`);
	}
	const lineWidth = vectorStrokeUnitPixels(unitValue("strokeStyleLineWidth"), resolution, layerIndex, "vstk line width");
	const lineDashOffset = vectorStrokeUnitPixels(unitValue("strokeStyleLineDashOffset"), resolution, layerIndex, "vstk dash offset");
	const dashEntry = required("strokeStyleLineDashSet", ["VlLs"]);
	if (!Array.isArray(dashEntry.value) || dashEntry.value.length > 64) {
		throw new Error(`Unsupported PSD layer ${layerIndex} vstk dash set; at most 64 unit values are allowed.`);
	}
	const lineDashSet = dashEntry.value.map((value, index) => {
		if (!value || typeof value !== "object" || Array.isArray(value) || !("units" in value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vstk dash item ${index} must be a unit value.`);
		}
		return vectorStrokeUnitPixels(value as IPsdDescriptorUnitValue, resolution, layerIndex, `vstk dash item ${index}`);
	});
	if (lineDashSet.length && lineDashSet.every((value) => value.pixels === 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk dash set cannot contain only zero lengths.`);
	}
	const opacityValue = unitValue("strokeStyleOpacity");
	if (opacityValue.units !== "#Prc" || opacityValue.value < 0 || opacityValue.value > 100) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk opacity must be a 0..100 percent value.`);
	}
	const contentEntry = required("strokeStyleContent", ["Objc", "GlbO"]);
	if (!contentEntry.value || typeof contentEntry.value !== "object" || Array.isArray(contentEntry.value) || !("entries" in contentEntry.value)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vstk content must be an object descriptor.`);
	}
	const content = parsePsdVectorContentDescriptor(contentEntry.value as IPsdDescriptorObjectValue, layerIndex, "vstk content");
	const strokeEnabled = booleanValue("strokeEnabled");
	const fillEnabled = booleanValue("fillEnabled");
	const lineCap = PSD_VECTOR_CAPS[enumValue("strokeStyleLineCapType", "strokeStyleLineCapType")] ?? "unknown";
	const lineJoin = PSD_VECTOR_JOINS[enumValue("strokeStyleLineJoinType", "strokeStyleLineJoinType")] ?? "unknown";
	const lineAlignment = PSD_VECTOR_ALIGNMENTS[enumValue("strokeStyleLineAlignment", "strokeStyleLineAlignment")] ?? "unknown";
	const blendMode = MODERN_BLEND_MODES[enumValue("strokeStyleBlendMode", "BlnM")] ?? "";
	const miterLimit = numberValue("strokeStyleMiterLimit");
	const warnings: string[] = [];
	if (lineCap === "unknown" || lineJoin === "unknown" || lineAlignment === "unknown") {
		warnings.push("Vector Stroke preserves an unknown cap, join, or alignment enumeration and cannot rasterize it.");
	}
	if (!blendMode) {
		warnings.push("Vector Stroke preserves an unsupported blend mode and cannot rasterize it.");
	}
	const bakeSupported =
		!strokeEnabled ||
		(miterLimit >= 1 && miterLimit <= 1000 && lineCap !== "unknown" && lineJoin !== "unknown" && lineAlignment !== "unknown" && Boolean(blendMode) && content.bakeSupported);
	return {
		sourceKey: "vstk",
		descriptorVersion: 16,
		descriptorClassId: "strokeStyle",
		descriptorPaddingBytes: descriptorPaddingBytes as 0 | 1 | 2 | 3,
		descriptorEntryKeys: root.entries.map((entry) => entry.key),
		descriptorEntryTypes: root.entries.map((entry) => entry.type),
		strokeStyleVersion: 2,
		strokeEnabled,
		fillEnabled,
		lineWidth,
		lineDashOffset,
		miterLimit,
		lineCap,
		lineJoin,
		lineAlignment,
		scaleLock: booleanValue("strokeStyleScaleLock"),
		strokeAdjust: booleanValue("strokeStyleStrokeAdjust"),
		lineDashSet,
		blendMode,
		opacity: opacityValue.value,
		content,
		resolution,
		executionModel: "bounded-vector-stroke-v1",
		bakeSupported,
		warnings,
	};
}

function vectorOriginationScalarPixels(value: number, units: string | null, resolution: number | null): number | null {
	if (units === null || units === "#Pxl") {
		return value;
	}
	if (resolution === null) {
		return null;
	}
	const scale: Record<string, number> = {
		"#Pnt": resolution / 72,
		"#Mlm": resolution / 25.4,
		RrPi: resolution / 6,
		RrIn: resolution,
		RrCm: resolution / 2.54,
	};
	return scale[units] === undefined ? null : value * scale[units];
}

function parsePsdVectorOrigination(data: Uint8Array, layerIndex: number): IPsdVectorOriginationInfo {
	if (data.byteLength < 8) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vogk record must contain record version 1 and descriptor version 16.`);
	}
	const recordVersion = readInt32(data, 0, `layer ${layerIndex} vogk record version`);
	const descriptorVersion = readUint32(data, 4, `layer ${layerIndex} vogk descriptor version`);
	if (recordVersion !== 1 || descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} vogk versions ${recordVersion}/${descriptorVersion}; record version 1 and descriptor version 16 are required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 8, end: data.byteLength, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} vogk descriptor`);
	const descriptorPaddingBytes = cursor.end - cursor.offset;
	if (descriptorPaddingBytes < 0 || descriptorPaddingBytes > 3 || data.subarray(cursor.offset).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vogk descriptor leaves ${descriptorPaddingBytes} invalid trailing byte(s).`);
	}
	if (root.classId !== "null" || duplicateDescriptorKeys(root).length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vogk requires one duplicate-free null root descriptor.`);
	}
	const listEntries = root.entries.filter((entry) => entry.key === "keyDescriptorList");
	if (listEntries.length !== 1 || listEntries[0].type !== "VlLs" || !Array.isArray(listEntries[0].value) || listEntries[0].value.length > 256) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vogk requires one bounded keyDescriptorList.`);
	}
	const warnings: string[] = [];
	const unknownRootKeys = root.entries.filter((entry) => entry.key !== "keyDescriptorList").map((entry) => entry.key);
	if (unknownRootKeys.length) {
		warnings.push(`Vector Origination preserves unknown root descriptor key(s): ${unknownRootKeys.join(", ")}.`);
	}
	const required = (object: IPsdDescriptorObjectValue, key: string, types: readonly string[], label: string): (typeof object.entries)[number] => {
		const matches = object.entries.filter((entry) => entry.key === key);
		if (matches.length !== 1 || !types.includes(matches[0].type)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} requires exactly one ${types.join("/")} ${key} value.`);
		}
		return matches[0];
	};
	const optional = (object: IPsdDescriptorObjectValue, key: string, types: readonly string[], label: string): (typeof object.entries)[number] | null => {
		const matches = object.entries.filter((entry) => entry.key === key);
		if (matches.length > 1 || (matches.length === 1 && !types.includes(matches[0].type))) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} has an invalid or duplicate ${key} value.`);
		}
		return matches[0] ?? null;
	};
	const objectValue = (entry: (typeof root.entries)[number], label: string): IPsdDescriptorObjectValue => {
		if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value) || !("entries" in entry.value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} must be an object descriptor.`);
		}
		return entry.value as IPsdDescriptorObjectValue;
	};
	const finiteNumber = (entry: (typeof root.entries)[number], label: string): number => {
		if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || Math.abs(entry.value) > 1_000_000_000) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} must be a bounded finite number.`);
		}
		return entry.value;
	};
	const scalar = (entry: (typeof root.entries)[number], resolution: number | null, label: string, nonNegative: boolean): IPsdVectorOriginationScalarInfo => {
		let value: number;
		let units: string | null = null;
		if (entry.type === "UntF" || entry.type === "UnFl") {
			if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value) || !("units" in entry.value)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} must be a unit value.`);
			}
			value = (entry.value as IPsdDescriptorUnitValue).value;
			units = (entry.value as IPsdDescriptorUnitValue).units;
		} else {
			value = finiteNumber(entry, label);
		}
		if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000 || (nonNegative && value < 0)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} must be ${nonNegative ? "non-negative and " : ""}bounded.`);
		}
		const pixels = vectorOriginationScalarPixels(value, units, resolution);
		if (pixels !== null && (!Number.isFinite(pixels) || Math.abs(pixels) > 1_000_000_000)) {
			throw new Error(`Unsupported PSD layer ${layerIndex} vogk ${label} converts outside bounded pixel coordinates.`);
		}
		return { value, units, pixels };
	};
	const versionedQuad = (
		object: IPsdDescriptorObjectValue,
		classId: string,
		keys: readonly [string, string, string, string],
		resolution: number | null,
		label: string,
		nonNegative: boolean
	): [IPsdVectorOriginationScalarInfo, IPsdVectorOriginationScalarInfo, IPsdVectorOriginationScalarInfo, IPsdVectorOriginationScalarInfo] => {
		if (object.classId !== classId || duplicateDescriptorKeys(object).length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk ${label} must be one duplicate-free ${classId} descriptor.`);
		}
		const version = required(object, "unitValueQuadVersion", ["long"], label);
		if (finiteNumber(version, `${label} unitValueQuadVersion`) !== 1) {
			throw new Error(`Unsupported PSD layer ${layerIndex} vogk ${label} unitValueQuadVersion; version 1 is required.`);
		}
		return keys.map((key) => scalar(required(object, key, ["UntF", "UnFl", "doub"], label), resolution, `${label}.${key}`, nonNegative)) as [
			IPsdVectorOriginationScalarInfo,
			IPsdVectorOriginationScalarInfo,
			IPsdVectorOriginationScalarInfo,
			IPsdVectorOriginationScalarInfo,
		];
	};
	const entries = listEntries[0].value.map((value, listIndex): IPsdVectorOriginationEntryInfo => {
		if (!value || typeof value !== "object" || Array.isArray(value) || !("entries" in value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk keyDescriptorList item ${listIndex} must be an object descriptor.`);
		}
		const object = value as IPsdDescriptorObjectValue;
		if (object.classId !== "null" || duplicateDescriptorKeys(object).length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} must be one duplicate-free null descriptor.`);
		}
		const originIndex = finiteNumber(required(object, "keyOriginIndex", ["long"], `item ${listIndex}`), `item ${listIndex} keyOriginIndex`);
		if (!Number.isInteger(originIndex) || originIndex < 0 || originIndex > 255) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} keyOriginIndex must be an integer within 0..255.`);
		}
		const invalidatedEntry = optional(object, "keyShapeInvalidated", ["bool"], `item ${listIndex}`);
		if (invalidatedEntry && typeof invalidatedEntry.value !== "boolean") {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} keyShapeInvalidated must be Boolean.`);
		}
		const originTypeEntry = optional(object, "keyOriginType", ["long"], `item ${listIndex}`);
		const originType = originTypeEntry ? finiteNumber(originTypeEntry, `item ${listIndex} keyOriginType`) : null;
		if (originType !== null && !Number.isInteger(originType)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} keyOriginType must be an integer.`);
		}
		const resolutionEntry = optional(object, "keyOriginResolution", ["doub"], `item ${listIndex}`);
		const originResolution = resolutionEntry ? finiteNumber(resolutionEntry, `item ${listIndex} keyOriginResolution`) : null;
		if (originResolution !== null && (originResolution <= 0 || originResolution > 9600)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} resolution must be within 0..9600 DPI.`);
		}
		const boundingEntry = optional(object, "keyOriginShapeBBox", ["Objc", "GlbO"], `item ${listIndex}`);
		const boundingObject = boundingEntry ? objectValue(boundingEntry, `item ${listIndex} keyOriginShapeBBox`) : null;
		const boundingValues = boundingObject
			? versionedQuad(boundingObject, "unitRect", ["Top ", "Left", "Btom", "Rght"], originResolution, `item ${listIndex} bounding box`, false)
			: null;
		const radiiEntry = optional(object, "keyOriginRRectRadii", ["Objc", "GlbO"], `item ${listIndex}`);
		const radiiObject = radiiEntry ? objectValue(radiiEntry, `item ${listIndex} keyOriginRRectRadii`) : null;
		const radiiValues = radiiObject
			? versionedQuad(radiiObject, "radii", ["topRight", "topLeft", "bottomLeft", "bottomRight"], originResolution, `item ${listIndex} radii`, true)
			: null;
		const cornersEntry = optional(object, "keyOriginBoxCorners", ["Objc", "GlbO"], `item ${listIndex}`);
		const cornersObject = cornersEntry ? objectValue(cornersEntry, `item ${listIndex} keyOriginBoxCorners`) : null;
		let corners: IPsdVectorOriginationEntryInfo["boxCorners"] = null;
		if (cornersObject) {
			if (duplicateDescriptorKeys(cornersObject).length) {
				throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} box corners contain duplicate keys.`);
			}
			const values = (["rectangleCornerA", "rectangleCornerB", "rectangleCornerC", "rectangleCornerD"] as const).map((key) => {
				const point = objectValue(required(cornersObject, key, ["Objc", "GlbO"], `item ${listIndex} box corners`), `item ${listIndex} ${key}`);
				if (point.classId !== "Pnt " || duplicateDescriptorKeys(point).length) {
					throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} ${key} must be one duplicate-free Pnt descriptor.`);
				}
				return {
					x: finiteNumber(required(point, "Hrzn", ["doub"], `item ${listIndex} ${key}`), `item ${listIndex} ${key}.Hrzn`),
					y: finiteNumber(required(point, "Vrtc", ["doub"], `item ${listIndex} ${key}`), `item ${listIndex} ${key}.Vrtc`),
				};
			});
			corners = { descriptorClassId: cornersObject.classId, corners: values as NonNullable<IPsdVectorOriginationEntryInfo["boxCorners"]>["corners"] };
		}
		const transformEntry = optional(object, "Trnf", ["Objc", "GlbO"], `item ${listIndex}`);
		const transformObject = transformEntry ? objectValue(transformEntry, `item ${listIndex} Trnf`) : null;
		let transform: IPsdVectorOriginationEntryInfo["transform"] = null;
		if (transformObject) {
			if (transformObject.classId !== "Trnf" || duplicateDescriptorKeys(transformObject).length) {
				throw new Error(`Malformed PSD: layer ${layerIndex} vogk item ${listIndex} transform must be one duplicate-free Trnf descriptor.`);
			}
			transform = {
				descriptorClassId: transformObject.classId,
				matrix: (["xx", "xy", "yx", "yy", "tx", "ty"] as const).map((key) =>
					finiteNumber(required(transformObject, key, ["doub"], `item ${listIndex} transform`), `item ${listIndex} transform.${key}`)
				) as [number, number, number, number, number, number],
			};
		}
		const knownKeys = new Set([
			"keyShapeInvalidated",
			"keyOriginType",
			"keyOriginResolution",
			"keyOriginShapeBBox",
			"keyOriginRRectRadii",
			"keyOriginBoxCorners",
			"Trnf",
			"keyOriginIndex",
		]);
		const unknownEntryKeys = object.entries.filter((entry) => !knownKeys.has(entry.key)).map((entry) => entry.key);
		if (unknownEntryKeys.length) {
			warnings.push(`Vector Origination item ${listIndex} preserves unknown descriptor key(s): ${unknownEntryKeys.join(", ")}.`);
		}
		return {
			listIndex,
			originIndex,
			descriptorClassId: object.classId,
			descriptorEntryKeys: object.entries.map((entry) => entry.key),
			descriptorEntryTypes: object.entries.map((entry) => entry.type),
			unknownEntryKeys,
			shapeInvalidated: invalidatedEntry ? (invalidatedEntry.value as boolean) : null,
			originType,
			originResolution,
			shapeBoundingBox:
				boundingObject && boundingValues
					? {
							descriptorClassId: boundingObject.classId,
							unitValueQuadVersion: 1,
							top: boundingValues[0],
							left: boundingValues[1],
							bottom: boundingValues[2],
							right: boundingValues[3],
						}
					: null,
			roundedRectangleRadii:
				radiiObject && radiiValues
					? {
							descriptorClassId: radiiObject.classId,
							unitValueQuadVersion: 1,
							topRight: radiiValues[0],
							topLeft: radiiValues[1],
							bottomLeft: radiiValues[2],
							bottomRight: radiiValues[3],
						}
					: null,
			boxCorners: corners,
			transform,
		};
	});
	const originIndices = entries.map((entry) => entry.originIndex);
	if (new Set(originIndices).size !== originIndices.length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} vogk keyOriginIndex values must be unique.`);
	}
	return {
		sourceKey: "vogk",
		recordVersion: 1,
		descriptorVersion: 16,
		descriptorClassId: root.classId,
		descriptorEntryKeys: root.entries.map((entry) => entry.key),
		descriptorEntryTypes: root.entries.map((entry) => entry.type),
		descriptorPaddingBytes: descriptorPaddingBytes as 0 | 1 | 2 | 3,
		entries,
		association: "metadata-only",
		executionModel: "psd-vector-origination-v1",
		warnings,
	};
}

function parsePsdPathList(data: Uint8Array, layerIndex: number): IPsdPathListInfo {
	if (data.byteLength < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} pths record must contain descriptor version 16 and a descriptor.`);
	}
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} pths descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} pths descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: data.byteLength, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} pths descriptor`);
	const descriptorPaddingBytes = cursor.end - cursor.offset;
	if (descriptorPaddingBytes < 0 || descriptorPaddingBytes > 3 || data.subarray(cursor.offset).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} pths descriptor leaves ${descriptorPaddingBytes} invalid trailing byte(s).`);
	}
	if (root.classId !== "pathsDataClass" || duplicateDescriptorKeys(root).length) {
		throw new Error(`Malformed PSD: layer ${layerIndex} pths requires one duplicate-free pathsDataClass root descriptor.`);
	}
	const listEntries = root.entries.filter((entry) => entry.key === "pathList");
	if (listEntries.length !== 1 || listEntries[0].type !== "VlLs" || !Array.isArray(listEntries[0].value) || listEntries[0].value.length > 256) {
		throw new Error(`Malformed PSD: layer ${layerIndex} pths requires one bounded pathList descriptor list.`);
	}
	const warnings: string[] = [];
	const unknownEntryKeys = root.entries.filter((entry) => entry.key !== "pathList").map((entry) => entry.key);
	if (unknownEntryKeys.length) {
		warnings.push(`Path List preserves unknown root descriptor key(s): ${unknownEntryKeys.join(", ")}.`);
	}
	const paths = (listEntries[0].value as PsdDescriptorValue[]).map((value, listIndex) => {
		if (!value || typeof value !== "object" || Array.isArray(value) || !("entries" in value)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths pathList item ${listIndex} must be an object descriptor.`);
		}
		const object = value as IPsdDescriptorObjectValue;
		if (object.classId !== "pathInfoClass" || duplicateDescriptorKeys(object).length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} must be one duplicate-free pathInfoClass descriptor.`);
		}
		const nameEntries = object.entries.filter((entry) => entry.key === "pathUnicodeName");
		const symmetryEntries = object.entries.filter((entry) => entry.key === "pathSymmetryClass");
		if (nameEntries.length !== 1 || nameEntries[0].type !== "TEXT" || typeof nameEntries[0].value !== "string") {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} requires one TEXT pathUnicodeName.`);
		}
		if (symmetryEntries.length !== 1 || symmetryEntries[0].type !== "Objc") {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} requires one object pathSymmetryClass.`);
		}
		const symmetry = symmetryEntries[0].value;
		if (!symmetry || typeof symmetry !== "object" || Array.isArray(symmetry) || !("entries" in symmetry)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} pathSymmetryClass must be an object descriptor.`);
		}
		const symmetryObject = symmetry as IPsdDescriptorObjectValue;
		if (symmetryObject.classId !== "pathSymmetryClass" || duplicateDescriptorKeys(symmetryObject).length) {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} requires one duplicate-free pathSymmetryClass descriptor.`);
		}
		const modeEntries = symmetryObject.entries.filter((entry) => entry.key === "pathSymmetryMode");
		if (modeEntries.length !== 1 || (modeEntries[0].type !== "enum" && modeEntries[0].type !== "TEXT")) {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} requires one enum or TEXT pathSymmetryMode.`);
		}
		const modeEntry = modeEntries[0];
		const enumValue =
			modeEntry.type === "enum" && modeEntry.value && typeof modeEntry.value === "object" && !Array.isArray(modeEntry.value) && "enumType" in modeEntry.value
				? (modeEntry.value as IPsdDescriptorEnumValue)
				: null;
		if ((modeEntry.type === "enum" && !enumValue) || (modeEntry.type === "TEXT" && typeof modeEntry.value !== "string")) {
			throw new Error(`Malformed PSD: layer ${layerIndex} pths item ${listIndex} has an invalid pathSymmetryMode value.`);
		}
		const pathUnknownEntryKeys = object.entries.filter((entry) => entry.key !== "pathUnicodeName" && entry.key !== "pathSymmetryClass").map((entry) => entry.key);
		const symmetryUnknownEntryKeys = symmetryObject.entries.filter((entry) => entry.key !== "pathSymmetryMode").map((entry) => entry.key);
		if (pathUnknownEntryKeys.length) {
			warnings.push(`Path List item ${listIndex} preserves unknown descriptor key(s): ${pathUnknownEntryKeys.join(", ")}.`);
		}
		if (symmetryUnknownEntryKeys.length) {
			warnings.push(`Path List item ${listIndex} preserves unknown symmetry key(s): ${symmetryUnknownEntryKeys.join(", ")}.`);
		}
		return {
			listIndex,
			descriptorClassId: object.classId,
			descriptorEntryKeys: object.entries.map((entry) => entry.key),
			descriptorEntryTypes: object.entries.map((entry) => entry.type),
			unknownEntryKeys: pathUnknownEntryKeys,
			unicodeName: nameEntries[0].value as string,
			symmetry: {
				descriptorClassId: symmetryObject.classId,
				descriptorEntryKeys: symmetryObject.entries.map((entry) => entry.key),
				descriptorEntryTypes: symmetryObject.entries.map((entry) => entry.type),
				modeType: modeEntry.type as "enum" | "TEXT",
				enumType: enumValue?.enumType ?? null,
				value: enumValue?.value ?? (modeEntry.value as string),
				unknownEntryKeys: symmetryUnknownEntryKeys,
			},
		};
	});
	return {
		sourceKey: "pths",
		descriptorVersion: 16,
		descriptorClassId: root.classId,
		descriptorEntryKeys: root.entries.map((entry) => entry.key),
		descriptorEntryTypes: root.entries.map((entry) => entry.type),
		descriptorPaddingBytes: descriptorPaddingBytes as 0 | 1 | 2 | 3,
		unknownEntryKeys,
		paths,
		executionModel: "psd-path-list-v1",
		warnings,
	};
}

function descriptorString(object: IPsdDescriptorObjectValue, key: string, fallback = ""): string {
	const value = descriptorEntry(object, key);
	return typeof value === "string" ? value : fallback;
}

function descriptorObjectList(object: IPsdDescriptorObjectValue, key: string): IPsdDescriptorObjectValue[] {
	const value = descriptorEntry(object, key);
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is IPsdDescriptorObjectValue => Boolean(item && typeof item === "object" && !Array.isArray(item) && "entries" in item));
}

function descriptorNumberList(object: IPsdDescriptorObjectValue, key: string): number[] {
	const value = descriptorEntry(object, key);
	return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? (value as number[]) : [];
}

type PsdTextEngineValue = null | boolean | number | string | PsdTextEngineValue[] | { [key: string]: PsdTextEngineValue };

function isPsdTextEngineObject(value: PsdTextEngineValue | undefined): value is { [key: string]: PsdTextEngineValue } {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parsePsdTextEngineData(data: Uint8Array): { [key: string]: PsdTextEngineValue } {
	let offset = 0;
	let tokenCount = 0;
	const stack: Array<PsdTextEngineValue[] | { [key: string]: PsdTextEngineValue } | string> = [];
	let root: PsdTextEngineValue | null = null;
	let end = data.length;
	while (end > 0 && data[end - 1] === 0) {
		end--;
	}
	const whitespace = (value: number): boolean => value === 32 || value === 10 || value === 13 || value === 9;
	const numberByte = (value: number): boolean => (value >= 48 && value <= 57) || value === 46 || value === 45 || value === 43 || value === 69 || value === 101;
	const skipWhitespace = (): void => {
		while (offset < end && whitespace(data[offset])) {
			offset++;
		}
	};
	const pop = (): void => {
		if (!stack.length) {
			throw new Error("container terminator has no matching opener");
		}
		stack.pop();
	};
	const pushValue = (value: PsdTextEngineValue): void => {
		if (!stack.length) {
			if (root !== null) {
				throw new Error("contains more than one root value");
			}
			root = value;
			return;
		}
		const top = stack[stack.length - 1];
		if (typeof top === "string") {
			const parent = stack[stack.length - 2];
			if (!isPsdTextEngineObject(parent as PsdTextEngineValue)) {
				throw new Error("dictionary key is not followed by a value");
			}
			parent[top] = value;
			stack.pop();
		} else if (Array.isArray(top)) {
			top.push(value);
		} else {
			throw new Error("dictionary value has no key");
		}
	};
	const pushContainer = (value: PsdTextEngineValue[] | { [key: string]: PsdTextEngineValue }): void => {
		pushValue(value);
		stack.push(value);
		if (stack.length > 32) {
			throw new Error("exceeds the 32-level EngineData nesting limit");
		}
	};
	const readTextByte = (): number => {
		if (offset >= end) {
			throw new Error("contains a truncated text string");
		}
		let value = data[offset++];
		if (value === 92) {
			if (offset >= end) {
				throw new Error("contains a truncated text escape");
			}
			value = data[offset++];
		}
		return value;
	};
	const readText = (): string => {
		if (data[offset] === 41) {
			offset++;
			return "";
		}
		if (data[offset] !== 0xfe || data[offset + 1] !== 0xff) {
			throw new Error("text string is missing its UTF-16BE BOM");
		}
		offset += 2;
		let value = "";
		for (;;) {
			if (offset >= end || data[offset] === 41) {
				break;
			}
			value += String.fromCharCode((readTextByte() << 8) | readTextByte());
			if (value.length > 524288) {
				throw new Error("text string exceeds the bounded character limit");
			}
		}
		if (offset >= end || data[offset] !== 41) {
			throw new Error("contains an unterminated text string");
		}
		offset++;
		return value;
	};
	skipWhitespace();
	while (offset < end) {
		if (++tokenCount > 32768) {
			throw new Error("exceeds the bounded EngineData token limit");
		}
		const value = data[offset];
		if (value === 60 && data[offset + 1] === 60) {
			offset += 2;
			pushContainer({});
		} else if (value === 62 && data[offset + 1] === 62) {
			offset += 2;
			pop();
		} else if (value === 91) {
			offset++;
			pushContainer([]);
		} else if (value === 93) {
			offset++;
			pop();
		} else if (value === 47) {
			offset++;
			const start = offset;
			while (offset < end && !whitespace(data[offset]) && ![60, 62, 91, 93, 40, 41].includes(data[offset])) {
				offset++;
				if (offset - start > 1024) {
					throw new Error("dictionary key exceeds the bounded byte limit");
				}
			}
			if (offset === start || !stack.length) {
				throw new Error("contains an empty or detached dictionary key");
			}
			const name = String.fromCharCode(...data.slice(start, offset));
			const top = stack[stack.length - 1];
			if (typeof top === "string") {
				pushValue(name === "nil" ? null : `/${name}`);
			} else if (isPsdTextEngineObject(top as PsdTextEngineValue)) {
				stack.push(name);
			} else {
				throw new Error("dictionary key appears inside an array without a value marker");
			}
		} else if (value === 40) {
			offset++;
			pushValue(readText());
		} else if (data.subarray(offset, offset + 4).every((byte, index) => byte === "null".charCodeAt(index))) {
			offset += 4;
			pushValue(null);
		} else if (data.subarray(offset, offset + 4).every((byte, index) => byte === "true".charCodeAt(index))) {
			offset += 4;
			pushValue(true);
		} else if (data.subarray(offset, offset + 5).every((byte, index) => byte === "false".charCodeAt(index))) {
			offset += 5;
			pushValue(false);
		} else if (numberByte(value)) {
			const start = offset;
			while (offset < end && numberByte(data[offset])) {
				offset++;
				if (offset - start > 128) {
					throw new Error("numeric token exceeds the bounded byte limit");
				}
			}
			const number = Number(String.fromCharCode(...data.slice(start, offset)));
			if (!Number.isFinite(number)) {
				throw new Error("contains a non-finite numeric token");
			}
			pushValue(number);
		} else {
			throw new Error(`contains unsupported token byte ${value} at offset ${offset}`);
		}
		skipWhitespace();
	}
	if (stack.length) {
		throw new Error("contains an unterminated container or dictionary key");
	}
	if (!isPsdTextEngineObject(root ?? undefined)) {
		throw new Error("root value is not a dictionary");
	}
	return root as unknown as { [key: string]: PsdTextEngineValue };
}

function psdTextEngineNumber(value: PsdTextEngineValue | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function psdTextEngineBoolean(value: PsdTextEngineValue | undefined): boolean | null {
	if (typeof value === "boolean") {
		return value;
	}
	const numeric = psdTextEngineNumber(value);
	return numeric === null ? null : numeric !== 0;
}

function psdTextEngineNumberTuple<const TLength extends number>(value: PsdTextEngineValue | undefined, length: TLength): number[] | null {
	if (!Array.isArray(value) || value.length !== length || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
		return null;
	}
	return value as number[];
}

function parsePsdTextColor(value: PsdTextEngineValue | undefined): [number, number, number, number] | null {
	if (!isPsdTextEngineObject(value) || !Array.isArray(value.Values) || !value.Values.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
		return null;
	}
	const values = value.Values as number[];
	if (value.Type === 1 && values.length >= 4) {
		return [Math.round(values[1] * 255), Math.round(values[2] * 255), Math.round(values[3] * 255), Math.round((values[0] ?? 1) * 255)].map((entry) =>
			Math.max(0, Math.min(255, entry))
		) as [number, number, number, number];
	}
	if (value.Type === 0 && values.length >= 2) {
		const gray = Math.max(0, Math.min(255, Math.round(values[1] * 255)));
		return [gray, gray, gray, 255];
	}
	return null;
}

function parsePsdTextBounds(object: IPsdDescriptorObjectValue | null): IPsdTextLayerInfo["bounds"] {
	if (!object) {
		return null;
	}
	const values = [descriptorUnit(object, "Left"), descriptorUnit(object, "Top "), descriptorUnit(object, "Rght"), descriptorUnit(object, "Btom")];
	if (values.some((value) => !value) || new Set(values.map((value) => value?.units)).size !== 1) {
		return null;
	}
	return { left: values[0]!.value, top: values[1]!.value, right: values[2]!.value, bottom: values[3]!.value, units: values[0]!.units };
}

function normalizePsdTextEngineRunTerminator<T extends { length: number }>(runs: T[], textLength: number, hasTextTerminator: boolean): boolean {
	const totalLength = runs.reduce((sum, run) => sum + run.length, 0);
	if (!hasTextTerminator || !runs.length || totalLength !== textLength + 1 || runs[runs.length - 1].length < 1) {
		return false;
	}
	runs[runs.length - 1].length--;
	if (runs[runs.length - 1].length === 0) {
		runs.pop();
	}
	return true;
}

function parsePsdTextLayer(data: Uint8Array, layerIndex: number): IPsdTextLayerInfo {
	const cursor: IPsdDescriptorCursor = { offset: 0, end: data.length, items: 0 };
	const version = readInt16(data, cursor.offset, `layer ${layerIndex} TySh version`);
	cursor.offset += 2;
	if (version !== 1) {
		throw new Error(`Unsupported PSD layer ${layerIndex} TySh version ${version}; version 1 is required.`);
	}
	const transform = Array.from({ length: 6 }, (_, index) => readDescriptorFloat64(data, cursor, `layer ${layerIndex} TySh transform ${index}`)) as IPsdTextLayerInfo["transform"];
	if (transform.some((value) => !Number.isFinite(value))) {
		throw new Error(`Malformed PSD: layer ${layerIndex} TySh transform contains a non-finite value.`);
	}
	const textVersion = readInt16(data, cursor.offset, `layer ${layerIndex} TySh text version`);
	cursor.offset += 2;
	const descriptorVersion = readUint32(data, cursor.offset, `layer ${layerIndex} TySh descriptor version`);
	cursor.offset += 4;
	if (textVersion !== 50 || descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} TySh text/descriptor version ${textVersion}/${descriptorVersion}; 50/16 is required.`);
	}
	const textDescriptor = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} TySh text descriptor`);
	if (textDescriptor.classId !== "TxLr") {
		throw new Error(`Malformed PSD: layer ${layerIndex} TySh descriptor class ${textDescriptor.classId} is not TxLr.`);
	}
	const warpVersion = readInt16(data, cursor.offset, `layer ${layerIndex} TySh warp version`);
	cursor.offset += 2;
	const warpDescriptorVersion = readUint32(data, cursor.offset, `layer ${layerIndex} TySh warp descriptor version`);
	cursor.offset += 4;
	if (warpVersion !== 1 || warpDescriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} TySh warp/descriptor version ${warpVersion}/${warpDescriptorVersion}; 1/16 is required.`);
	}
	const warpDescriptor = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} TySh warp descriptor`);
	if (warpDescriptor.classId !== "warp") {
		throw new Error(`Malformed PSD: layer ${layerIndex} TySh warp class ${warpDescriptor.classId} is not warp.`);
	}
	const left = readDescriptorFloat32(data, cursor, `layer ${layerIndex} TySh left`);
	const top = readDescriptorFloat32(data, cursor, `layer ${layerIndex} TySh top`);
	const right = readDescriptorFloat32(data, cursor, `layer ${layerIndex} TySh right`);
	const bottom = readDescriptorFloat32(data, cursor, `layer ${layerIndex} TySh bottom`);
	const padding = data.slice(cursor.offset);
	if (padding.length > 3 || padding.some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} TySh leaves non-padding trailing bytes.`);
	}
	const textValue = descriptorEntry(textDescriptor, "Txt ");
	if (typeof textValue !== "string") {
		throw new Error(`Malformed PSD: layer ${layerIndex} TySh has no text string.`);
	}
	const orientationValue = descriptorEnum(textDescriptor, "Ornt")?.value ?? "";
	const antiAliasValue = descriptorEnum(textDescriptor, "AntA")?.value ?? "";
	const griddingValue = descriptorEnum(textDescriptor, "textGridding")?.value ?? "";
	const orientation = orientationValue === "Hrzn" ? "horizontal" : orientationValue === "Vrtc" ? "vertical" : "unknown";
	const antiAliases: Record<string, IPsdTextLayerInfo["antiAlias"]> = {
		Anno: "none",
		antiAliasSharp: "sharp",
		AnCr: "crisp",
		AnSt: "strong",
		AnSm: "smooth",
		antiAliasPlatformGray: "platform",
		antiAliasPlatformLCD: "platformLCD",
	};
	const antiAlias = antiAliases[antiAliasValue] ?? "unknown";
	const gridding = griddingValue === "None" ? "none" : griddingValue === "Rnd " ? "round" : "unknown";
	const warp = parsePsdWarp(warpDescriptor);
	const engineData = descriptorEntry(textDescriptor, "EngineData");
	const fonts: IPsdTextLayerFontInfo[] = [];
	const styleRuns: IPsdTextLayerStyleRunInfo[] = [];
	const paragraphRuns: IPsdTextLayerParagraphRunInfo[] = [];
	let styleRunTerminatorNormalized = false;
	let paragraphRunTerminatorNormalized = false;
	let engineTextMatchesDescriptor: boolean | null = null;
	let smallCapSize: number | null = null;
	let superscriptSize: number | null = null;
	let superscriptPosition: number | null = null;
	let subscriptSize: number | null = null;
	let subscriptPosition: number | null = null;
	let engineDataWarning: string | null = null;
	let shapeType: IPsdTextLayerInfo["shapeType"] = "unknown";
	let pointBase: IPsdTextLayerInfo["pointBase"] = null;
	let boxBounds: IPsdTextLayerInfo["boxBounds"] = null;
	if (engineData instanceof Uint8Array) {
		try {
			const engine = parsePsdTextEngineData(engineData);
			const engineDict = isPsdTextEngineObject(engine.EngineDict) ? engine.EngineDict : null;
			const resourceDict = isPsdTextEngineObject(engine.ResourceDict) ? engine.ResourceDict : null;
			smallCapSize = resourceDict ? psdTextEngineNumber(resourceDict.SmallCapSize) : null;
			superscriptSize = resourceDict ? psdTextEngineNumber(resourceDict.SuperscriptSize) : null;
			superscriptPosition = resourceDict ? psdTextEngineNumber(resourceDict.SuperscriptPosition) : null;
			subscriptSize = resourceDict ? psdTextEngineNumber(resourceDict.SubscriptSize) : null;
			subscriptPosition = resourceDict ? psdTextEngineNumber(resourceDict.SubscriptPosition) : null;
			const fontSet = resourceDict && Array.isArray(resourceDict.FontSet) ? resourceDict.FontSet : [];
			fontSet.slice(0, 256).forEach((value, index) => {
				if (isPsdTextEngineObject(value) && typeof value.Name === "string") {
					fonts.push({
						index,
						name: value.Name,
						script: psdTextEngineNumber(value.Script) ?? 0,
						fontType: psdTextEngineNumber(value.FontType) ?? 0,
						synthetic: psdTextEngineNumber(value.Synthetic) ?? 0,
					});
				}
			});
			const editor = engineDict && isPsdTextEngineObject(engineDict.Editor) ? engineDict.Editor : null;
			const rendered = engineDict && isPsdTextEngineObject(engineDict.Rendered) ? engineDict.Rendered : null;
			const shapes = rendered && isPsdTextEngineObject(rendered.Shapes) ? rendered.Shapes : null;
			const shapeChildren = shapes && Array.isArray(shapes.Children) ? shapes.Children : [];
			const shapeChild = shapeChildren.length === 1 && isPsdTextEngineObject(shapeChildren[0]) ? shapeChildren[0] : null;
			const shapeCookie = shapeChild && isPsdTextEngineObject(shapeChild.Cookie) ? shapeChild.Cookie : null;
			const photoshopShape = shapeCookie && isPsdTextEngineObject(shapeCookie.Photoshop) ? shapeCookie.Photoshop : null;
			const shapeTypeValue = photoshopShape ? psdTextEngineNumber(photoshopShape.ShapeType) : null;
			shapeType = shapeTypeValue === 0 ? "point" : shapeTypeValue === 1 ? "box" : "unknown";
			const decodedPointBase = photoshopShape ? psdTextEngineNumberTuple(photoshopShape.PointBase, 2) : null;
			const decodedBoxBounds = photoshopShape ? psdTextEngineNumberTuple(photoshopShape.BoxBounds, 4) : null;
			pointBase = decodedPointBase ? [decodedPointBase[0], decodedPointBase[1]] : null;
			boxBounds = decodedBoxBounds ? [decodedBoxBounds[0], decodedBoxBounds[1], decodedBoxBounds[2], decodedBoxBounds[3]] : null;
			const rawEngineText = typeof editor?.Text === "string" ? editor.Text : null;
			const engineTextHasTerminator = rawEngineText !== null && /[\r\n]$/.test(rawEngineText);
			const engineText = rawEngineText === null ? null : rawEngineText.replace(/\r/g, "\n").replace(/\n+$/, "");
			engineTextMatchesDescriptor = engineText === null ? null : engineText === textValue.replace(/\r/g, "\n").replace(/\n+$/, "");
			const styleRun = engineDict && isPsdTextEngineObject(engineDict.StyleRun) ? engineDict.StyleRun : null;
			const styleArray = styleRun && Array.isArray(styleRun.RunArray) ? styleRun.RunArray : [];
			const styleLengths = styleRun && Array.isArray(styleRun.RunLengthArray) ? styleRun.RunLengthArray : [];
			for (let index = 0; index < Math.min(256, styleArray.length, styleLengths.length); ++index) {
				const runValue = styleArray[index];
				const run = isPsdTextEngineObject(runValue) ? runValue : null;
				const styleSheetValue = run?.StyleSheet;
				const sheet = isPsdTextEngineObject(styleSheetValue) ? styleSheetValue : null;
				const style = sheet && isPsdTextEngineObject(sheet.StyleSheetData) ? sheet.StyleSheetData : null;
				const fontIndex = style ? psdTextEngineNumber(style.Font) : null;
				const horizontalScale = style ? psdTextEngineNumber(style.HorizontalScale) : null;
				const verticalScale = style ? psdTextEngineNumber(style.VerticalScale) : null;
				const fontCaps = style ? psdTextEngineNumber(style.FontCaps) : null;
				const fontBaseline = style ? psdTextEngineNumber(style.FontBaseline) : null;
				const baselineDirection = style ? psdTextEngineNumber(style.BaselineDirection) : null;
				const proportionalMetrics = style ? psdTextEngineBoolean(style.ProportionalMetrics) : null;
				const kana = style ? psdTextEngineBoolean(style.Kana) : null;
				const ruby = style ? psdTextEngineBoolean(style.Ruby) : null;
				const japaneseAlternateFeatureValue = style ? psdTextEngineNumber(style.JapaneseAlternateFeature) : null;
				const wariChuSubLineAmount = style && isPsdTextEngineObject(style.WariChuSubLineAmount) ? style.WariChuSubLineAmount : null;
				const wariChuJustificationValue = style ? psdTextEngineNumber(style.WariChuJustification) : null;
				const tsume = style ? psdTextEngineNumber(style.Tsume) : null;
				const styleRunAlignment = style ? psdTextEngineNumber(style.StyleRunAlignment) : null;
				const exactStyleBoolean = (
					key: "OldStyle" | "Swash" | "Titling" | "Ornaments" | "SlashedZero" | "ConnectionForms" | "ContextualLigatures" | "HindiNumbers"
				): boolean | null => {
					if (!style || style[key] === undefined) {
						return null;
					}
					if (typeof style[key] !== "boolean") {
						throw new Error(`style run ${index} ${key} is not Boolean`);
					}
					return style[key];
				};
				const exactStyleInteger = (key: "FigureStyle" | "CharacterDirection" | "Kashida" | "DiacriticPos"): number | null => {
					const value = style?.[key];
					if (value === undefined) {
						return null;
					}
					if (typeof value !== "number" || !Number.isSafeInteger(value)) {
						throw new Error(`style run ${index} ${key} is not an integer`);
					}
					return value;
				};
				const figureStyleValue = exactStyleInteger("FigureStyle");
				const characterDirectionValue = exactStyleInteger("CharacterDirection");
				const kashidaValue = exactStyleInteger("Kashida");
				const diacriticPositionValue = exactStyleInteger("DiacriticPos");
				const styleRunAlignments = ["em-box-bottom-left", "icf-bottom-left", "em-box-center", "roman-baseline", "icf-top-right", "em-box-top-right"] as const;
				const wariChuJustifications = ["left", "right", "center", "justify-left", "justify-right", "justify-center", "justify-all", "auto"] as const;
				styleRuns.push({
					length: Math.max(0, Math.floor(psdTextEngineNumber(styleLengths[index]) ?? 0)),
					fontIndex,
					fontName: fontIndex === null ? null : (fonts.find((font) => font.index === fontIndex)?.name ?? null),
					language: style ? psdTextEngineNumber(style.Language) : null,
					fontSize: style ? psdTextEngineNumber(style.FontSize) : null,
					fauxBold: style?.FauxBold === true,
					fauxItalic: style?.FauxItalic === true,
					fontCaps: fontCaps === null ? null : fontCaps === 0 ? "normal" : fontCaps === 1 ? "small-caps" : fontCaps === 2 ? "all-caps" : "unknown",
					fontBaseline: fontBaseline === null ? null : fontBaseline === 0 ? "normal" : fontBaseline === 1 ? "superscript" : fontBaseline === 2 ? "subscript" : "unknown",
					baselineDirection:
						baselineDirection === null
							? null
							: baselineDirection === 1
								? "upright"
								: baselineDirection === 2
									? "mixed"
									: baselineDirection === 3
										? "tate-chu-yoko"
										: "unknown",
					proportionalMetrics,
					kana,
					ruby,
					japaneseAlternateFeature:
						japaneseAlternateFeatureValue === null
							? null
							: japaneseAlternateFeatureValue === 0
								? "normal"
								: japaneseAlternateFeatureValue === 1
									? "traditional"
									: japaneseAlternateFeatureValue === 2
										? "expert"
										: japaneseAlternateFeatureValue === 3
											? "jis78"
											: "unknown",
					wariChuEnabled: style ? psdTextEngineBoolean(style.EnableWariChu) : null,
					wariChuLineCount: style ? psdTextEngineNumber(style.WariChuLineCount) : null,
					wariChuLineGap: style ? psdTextEngineNumber(style.WariChuLineGap) : null,
					wariChuScale: wariChuSubLineAmount ? psdTextEngineNumber(wariChuSubLineAmount.WariChuSubLineScale) : null,
					wariChuWidow: style ? psdTextEngineNumber(style.WariChuWidowAmount) : null,
					wariChuOrphan: style ? psdTextEngineNumber(style.WariChuOrphanAmount) : null,
					wariChuJustification: wariChuJustificationValue === null ? null : (wariChuJustifications[wariChuJustificationValue] ?? "unknown"),
					tsume,
					styleRunAlignment: styleRunAlignment === null ? null : (styleRunAlignments[styleRunAlignment] ?? "unknown"),
					autoLeading: style ? psdTextEngineBoolean(style.AutoLeading) : null,
					leading: style ? psdTextEngineNumber(style.Leading) : null,
					tracking: style ? psdTextEngineNumber(style.Tracking) : null,
					kerning: style ? psdTextEngineNumber(style.Kerning) : null,
					autoKerning: style ? psdTextEngineBoolean(style.AutoKerning) : null,
					ligatures: style ? psdTextEngineBoolean(style.Ligatures) : null,
					discretionaryLigatures: style ? psdTextEngineBoolean(style.DLigatures) : null,
					horizontalScale: horizontalScale === null ? null : horizontalScale * 100,
					verticalScale: verticalScale === null ? null : verticalScale * 100,
					baselineShift: style ? psdTextEngineNumber(style.BaselineShift) : null,
					underline: style?.Underline === true || (psdTextEngineNumber(style?.Underline) ?? 0) > 0,
					strikethrough: style?.Strikethrough === true || (psdTextEngineNumber(style?.Strikethrough) ?? 0) > 0,
					noBreak: style ? psdTextEngineBoolean(style.NoBreak) : null,
					fillColor: style ? parsePsdTextColor(style.FillColor) : null,
					strokeColor: style ? parsePsdTextColor(style.StrokeColor) : null,
					fillEnabled: style ? psdTextEngineBoolean(style.FillFlag) : null,
					strokeEnabled: style ? psdTextEngineBoolean(style.StrokeFlag) : null,
					fillFirst: style ? psdTextEngineBoolean(style.FillFirst) : null,
					outlineWidth: style ? psdTextEngineNumber(style.OutlineWidth) : null,
					fractions: null,
					ordinals: null,
					stylisticAlternates: null,
					oldStyle: exactStyleBoolean("OldStyle"),
					swash: exactStyleBoolean("Swash"),
					titling: exactStyleBoolean("Titling"),
					ornaments: exactStyleBoolean("Ornaments"),
					slashedZero: exactStyleBoolean("SlashedZero"),
					connectionForms: exactStyleBoolean("ConnectionForms"),
					contextualLigatures: exactStyleBoolean("ContextualLigatures"),
					hindiNumbers: exactStyleBoolean("HindiNumbers"),
					kashida: kashidaValue === null ? null : kashidaValue === 0 ? "off" : kashidaValue === 1 ? "on" : "unknown",
					diacriticPosition:
						diacriticPositionValue === null
							? null
							: diacriticPositionValue === 0
								? "opentype"
								: diacriticPositionValue === 1
									? "loose"
									: diacriticPositionValue === 2
										? "medium"
										: diacriticPositionValue === 3
											? "tight"
											: "unknown",
					characterDirection:
						characterDirectionValue === null
							? null
							: characterDirectionValue === 0
								? "default"
								: characterDirectionValue === 1
									? "left-to-right"
									: characterDirectionValue === 2
										? "right-to-left"
										: "unknown",
					figureStyle:
						figureStyleValue === null
							? null
							: figureStyleValue === 0
								? "default"
								: figureStyleValue === 1
									? "tabular-lining"
									: figureStyleValue === 2
										? "proportional-oldstyle"
										: figureStyleValue === 3
											? "proportional-lining"
											: figureStyleValue === 4
												? "tabular-oldstyle"
												: "unknown",
					engineData2StyleRunIndex: null,
					engineData2ExecutionModel: "disabled",
				});
			}
			const paragraphRun = engineDict && isPsdTextEngineObject(engineDict.ParagraphRun) ? engineDict.ParagraphRun : null;
			const paragraphArray = paragraphRun && Array.isArray(paragraphRun.RunArray) ? paragraphRun.RunArray : [];
			const paragraphLengths = paragraphRun && Array.isArray(paragraphRun.RunLengthArray) ? paragraphRun.RunLengthArray : [];
			const justifications = ["left", "right", "center", "justify-left", "justify-right", "justify-center", "justify-all"] as const;
			for (let index = 0; index < Math.min(256, paragraphArray.length, paragraphLengths.length); ++index) {
				const runValue = paragraphArray[index];
				const run = isPsdTextEngineObject(runValue) ? runValue : null;
				const paragraphSheetValue = run?.ParagraphSheet;
				const sheet = isPsdTextEngineObject(paragraphSheetValue) ? paragraphSheetValue : null;
				const properties = sheet && isPsdTextEngineObject(sheet.Properties) ? sheet.Properties : null;
				const justification = properties ? psdTextEngineNumber(properties.Justification) : null;
				paragraphRuns.push({
					length: Math.max(0, Math.floor(psdTextEngineNumber(paragraphLengths[index]) ?? 0)),
					justification: justification === null ? "unknown" : (justifications[justification] ?? "unknown"),
					firstLineIndent: properties ? psdTextEngineNumber(properties.FirstLineIndent) : null,
					startIndent: properties ? psdTextEngineNumber(properties.StartIndent) : null,
					endIndent: properties ? psdTextEngineNumber(properties.EndIndent) : null,
					spaceBefore: properties ? psdTextEngineNumber(properties.SpaceBefore) : null,
					spaceAfter: properties ? psdTextEngineNumber(properties.SpaceAfter) : null,
					autoHyphenate: properties ? psdTextEngineBoolean(properties.AutoHyphenate) : null,
					hyphenatedWordSize: properties ? psdTextEngineNumber(properties.HyphenatedWordSize) : null,
					preHyphen: properties ? psdTextEngineNumber(properties.PreHyphen) : null,
					postHyphen: properties ? psdTextEngineNumber(properties.PostHyphen) : null,
					consecutiveHyphens: properties ? psdTextEngineNumber(properties.ConsecutiveHyphens) : null,
					hyphenationZone: properties ? psdTextEngineNumber(properties.Zone) : null,
					autoLeading: properties ? psdTextEngineNumber(properties.AutoLeading) : null,
					everyLineComposer: properties ? psdTextEngineBoolean(properties.EveryLineComposer) : null,
				});
			}
			const normalizedTextLength = textValue.replace(/\r/g, "\n").length;
			styleRunTerminatorNormalized = normalizePsdTextEngineRunTerminator(styleRuns, normalizedTextLength, engineTextHasTerminator);
			paragraphRunTerminatorNormalized = normalizePsdTextEngineRunTerminator(paragraphRuns, normalizedTextLength, engineTextHasTerminator);
		} catch (error) {
			engineDataWarning = `EngineData was preserved but not interpreted: ${error instanceof Error ? error.message : String(error)}.`;
		}
	}
	return {
		version: 1,
		textVersion: 50,
		descriptorVersion: 16,
		text: textValue.replace(/\r/g, "\n"),
		textIndex: Math.max(0, Math.floor(descriptorNumber(textDescriptor, "TextIndex", 0))),
		transform,
		orientation,
		antiAlias,
		gridding,
		shapeType,
		pointBase,
		boxBounds,
		left,
		top,
		right,
		bottom,
		bounds: parsePsdTextBounds(descriptorObject(textDescriptor, "bounds")),
		boundingBox: parsePsdTextBounds(descriptorObject(textDescriptor, "boundingBox")),
		warp,
		engineDataBytes: engineData instanceof Uint8Array ? engineData.byteLength : 0,
		engineTextMatchesDescriptor,
		smallCapSize,
		superscriptSize,
		superscriptPosition,
		subscriptSize,
		subscriptPosition,
		fonts,
		styleRuns,
		paragraphRuns,
		styleRunTerminatorNormalized,
		paragraphRunTerminatorNormalized,
		engineDataWarning,
		engineData2Bytes: 0,
		engineData2Warning: null,
		engineData2ExecutionModel: "disabled",
		executionModel: "bounded-tysh-text-v1",
	};
}

function parseSmartObjectTransform(value: number[], layerIndex: number, label: string): IPsdSmartObjectLayerInfo["transform"] {
	if (value.length !== 8 || value.some((entry) => !Number.isFinite(entry) || Math.abs(entry) > 1_000_000_000)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${label} must contain eight finite bounded corner coordinates.`);
	}
	return value as IPsdSmartObjectLayerInfo["transform"];
}

function parseSmartObjectFraction(object: IPsdDescriptorObjectValue | null): { numerator: number; denominator: number } | null {
	if (!object) {
		return null;
	}
	const numerator = descriptorNumber(object, "numerator", Number.NaN);
	const denominator = descriptorNumber(object, "denominator", Number.NaN);
	return Number.isInteger(numerator) && Number.isInteger(denominator) && denominator !== 0 ? { numerator, denominator } : null;
}

function parsePsdWarp(object: IPsdDescriptorObjectValue | null): IPsdWarpInfo {
	const rotate = object ? (descriptorEnum(object, "warpRotate")?.value ?? "") : "";
	const bounds = object ? descriptorObject(object, "bounds") : null;
	const boundTop = bounds ? descriptorUnit(bounds, "Top ") : null;
	const boundLeft = bounds ? descriptorUnit(bounds, "Left") : null;
	const boundBottom = bounds ? descriptorUnit(bounds, "Btom") : null;
	const boundRight = bounds ? descriptorUnit(bounds, "Rght") : null;
	const envelope = object ? descriptorObject(object, "customEnvelopeWarp") : null;
	const mesh = envelope ? descriptorObjectArray(envelope, "meshPoints") : null;
	const horizontal = mesh?.fields.find((field) => field.type === "Hrzn")?.values ?? [];
	const vertical = mesh?.fields.find((field) => field.type === "Vrtc")?.values ?? [];
	const meshPoints = horizontal.length === vertical.length ? horizontal.map((x, index) => ({ x, y: vertical[index] })) : [];
	const uOrderValue = object ? descriptorNumber(object, "uOrder", Number.NaN) : Number.NaN;
	const vOrderValue = object ? descriptorNumber(object, "vOrder", Number.NaN) : Number.NaN;
	const deformRowsValue = object ? descriptorNumber(object, "deformNumRows", Number.NaN) : Number.NaN;
	const deformColsValue = object ? descriptorNumber(object, "deformNumCols", Number.NaN) : Number.NaN;
	const uOrder = Number.isInteger(uOrderValue) && uOrderValue >= 2 && uOrderValue <= 16 ? uOrderValue : null;
	const vOrder = Number.isInteger(vOrderValue) && vOrderValue >= 2 && vOrderValue <= 16 ? vOrderValue : null;
	const deformNumRows = Number.isInteger(deformRowsValue) && deformRowsValue >= 0 && deformRowsValue <= 64 ? deformRowsValue : null;
	const deformNumCols = Number.isInteger(deformColsValue) && deformColsValue >= 0 && deformColsValue <= 64 ? deformColsValue : null;
	const quiltSlice = (key: "quiltSliceX" | "quiltSliceY"): number[] => {
		if (!envelope) {
			return [];
		}
		const objectArray = descriptorObjectArray(envelope, key);
		return objectArray?.fields.find((field) => field.type === key)?.values ?? objectArray?.fields[0]?.values ?? descriptorNumberList(envelope, key);
	};
	const quiltSliceX = quiltSlice("quiltSliceX");
	const quiltSliceY = quiltSlice("quiltSliceY");
	const hasQuiltMetadata = deformNumRows !== null || deformNumCols !== null || quiltSliceX.length > 0 || quiltSliceY.length > 0;
	let meshExecutionModel: IPsdWarpInfo["meshExecutionModel"] = null;
	let meshWarning: string | null = null;
	if (envelope && (!uOrder || !vOrder || meshPoints.length !== uOrder * vOrder)) {
		if (!hasQuiltMetadata) {
			meshWarning = `Custom envelope requires bounded uOrder × vOrder control points; decoded ${uOrder ?? "invalid"} × ${vOrder ?? "invalid"} with ${meshPoints.length} point(s).`;
		}
	}
	if (envelope && hasQuiltMetadata) {
		const expectedColumns = uOrder && deformNumCols ? deformNumCols * (uOrder - 1) + 1 : 0;
		const expectedRows = vOrder && deformNumRows ? deformNumRows * (vOrder - 1) + 1 : 0;
		if (!uOrder || !vOrder || !deformNumRows || !deformNumCols || expectedColumns > 64 || expectedRows > 64 || meshPoints.length !== expectedColumns * expectedRows) {
			meshWarning = `Quilt envelope requires an exact piecewise control lattice; decoded ${deformNumCols ?? "invalid"} × ${deformNumRows ?? "invalid"} patch(es), local order ${uOrder ?? "invalid"} × ${vOrder ?? "invalid"}, and ${meshPoints.length} point(s), expected ${expectedColumns || "invalid"} × ${expectedRows || "invalid"}.`;
		} else if ((quiltSliceX.length && quiltSliceX.length !== deformNumCols + 1) || (quiltSliceY.length && quiltSliceY.length !== deformNumRows + 1)) {
			meshWarning = `Quilt slice arrays must contain patch-boundary counts of ${deformNumCols + 1} horizontal and ${deformNumRows + 1} vertical values when present.`;
		} else {
			meshExecutionModel = "quilt";
		}
	} else if (envelope && uOrder && vOrder && meshPoints.length === uOrder * vOrder && !meshWarning) {
		meshExecutionModel = "tensor";
	}
	return {
		style: object ? (descriptorEnum(object, "warpStyle")?.value ?? "unknown") : "unknown",
		value: object ? descriptorNumber(object, "warpValue", 0) : 0,
		perspective: object ? descriptorNumber(object, "warpPerspective", 0) : 0,
		perspectiveOther: object ? descriptorNumber(object, "warpPerspectiveOther", 0) : 0,
		rotate: rotate === "Hrzn" ? "horizontal" : rotate === "Vrtc" ? "vertical" : "unknown",
		bounds:
			boundTop && boundLeft && boundBottom && boundRight && [boundTop.value, boundLeft.value, boundBottom.value, boundRight.value].every(Number.isFinite)
				? { top: boundTop.value, left: boundLeft.value, bottom: boundBottom.value, right: boundRight.value, units: boundTop.units }
				: null,
		uOrder,
		vOrder,
		deformNumRows,
		deformNumCols,
		meshPoints,
		quiltSliceX,
		quiltSliceY,
		meshExecutionModel,
		meshExecutionSupported: meshExecutionModel !== null,
		meshWarning,
	};
}

function parseSmartFilters(filterFx: IPsdDescriptorObjectValue | null): {
	state: IPsdSmartObjectLayerInfo["smartFilterState"];
	filters: IPsdSmartFilterInfo[];
} {
	if (!filterFx) {
		return { state: null, filters: [] };
	}
	const state = {
		enabled: descriptorBoolean(filterFx, "enab", true),
		validAtPosition: descriptorBoolean(filterFx, "validAtPosition", true),
		maskEnabled: descriptorBoolean(filterFx, "filterMaskEnable", false),
		maskLinked: descriptorBoolean(filterFx, "filterMaskLinked", true),
		maskExtendWithWhite: descriptorBoolean(filterFx, "filterMaskExtendWithWhite", true),
	};
	const ids: Record<number, IPsdSmartFilterInfo["type"]> = {
		1097092723: "addNoise",
		1098281575: "average",
		1114403360: "blur",
		1114403405: "blurMore",
		1131180616: "colorHalftone",
		1131177075: "clouds",
		1131574132: "crystallize",
		1148089458: "deInterlace",
		1147564611: "differenceClouds",
		1147564832: "diffuse",
		1180856947: "fibers",
		1282306886: "lensFlare",
		1148416099: "despeckle",
		1148417107: "dustAndScratches",
		1164796531: "emboss",
		1165522034: "extrude",
		1416393504: "tiles",
		1416782659: "traceContour",
		1466852384: "wind",
		1180922912: "facet",
		1181639749: "findEdges",
		1181902701: "fragment",
		1214736464: "highPass",
		1298427424: "median",
		1299082528: "minimum",
		1299737888: "maximum",
		1299870830: "mezzotint",
		1299476034: "motionBlur",
		1299407648: "mosaic",
		1314149187: "ntscColors",
		1349416044: "pointillize",
		1382313026: "radialBlur",
		633: "reduceNoise",
		698: "smartSharpen",
		1433301837: "unsharpMask",
		1399353968: "sharpen",
		1399353925: "sharpenEdges",
		1399353933: "sharpenMore",
		1399616122: "solarize",
		702: "shapeBlur",
		1399681602: "smartBlur",
		701: "surfaceBlur",
		1231976050: "invert",
	};
	const algorithmExecutionModels: Partial<Record<IPsdSmartFilterInfo["type"], PsdSmartFilterAlgorithmExecutionModel>> = {
		addNoise: "bounded-seeded-add-noise-smart-filter-v1",
		average: "bounded-average-smart-filter-v1",
		blur: "bounded-blur-smart-filter-v1",
		blurMore: "bounded-blur-more-smart-filter-v1",
		boxBlur: "bounded-box-blur-smart-filter-v1",
		colorHalftone: "bounded-cmyk-screen-color-halftone-smart-filter-v1",
		clouds: "bounded-seeded-fractal-clouds-smart-filter-v1",
		crystallize: "bounded-seeded-voronoi-crystallize-smart-filter-v1",
		differenceClouds: "bounded-seeded-difference-clouds-smart-filter-v1",
		deInterlace: "bounded-field-reconstruction-de-interlace-smart-filter-v1",
		diffuse: "bounded-seeded-four-mode-diffuse-smart-filter-v1",
		fibers: "bounded-seeded-anisotropic-fibers-smart-filter-v1",
		lensFlare: "bounded-parameterized-lens-flare-smart-filter-v1",
		smartSharpen: "bounded-adaptive-smart-sharpen-v1",
		unsharpMask: "bounded-thresholded-gaussian-unsharp-mask-v1",
		despeckle: "bounded-despeckle-smart-filter-v1",
		dustAndScratches: "bounded-thresholded-median-dust-and-scratches-smart-filter-v1",
		emboss: "bounded-directional-color-emboss-smart-filter-v1",
		extrude: "bounded-seeded-cell-relief-extrude-smart-filter-v1",
		tiles: "bounded-seeded-offset-tiles-smart-filter-v1",
		traceContour: "bounded-per-channel-threshold-trace-contour-smart-filter-v1",
		wind: "bounded-directional-horizontal-wind-smart-filter-v1",
		facet: "bounded-facet-smart-filter-v1",
		findEdges: "bounded-find-edges-smart-filter-v1",
		fragment: "bounded-fragment-smart-filter-v1",
		gaussianBlur: "bounded-gaussian-blur-smart-filter-v1",
		highPass: "bounded-high-pass-smart-filter-v1",
		invert: "bounded-invert-smart-filter-v1",
		maximum: "bounded-maximum-smart-filter-v1",
		mezzotint: "bounded-seeded-mezzotint-smart-filter-v1",
		median: "bounded-median-smart-filter-v1",
		minimum: "bounded-minimum-smart-filter-v1",
		motionBlur: "bounded-motion-blur-smart-filter-v1",
		mosaic: "bounded-premultiplied-mosaic-smart-filter-v1",
		ntscColors: "bounded-ntsc-colors-smart-filter-v1",
		pointillize: "bounded-seeded-authored-canvas-pointillize-smart-filter-v2",
		radialBlur: "bounded-radial-blur-smart-filter-v1",
		reduceNoise: "bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1",
		sharpen: "bounded-sharpen-smart-filter-v1",
		sharpenEdges: "bounded-sharpen-edges-smart-filter-v1",
		sharpenMore: "bounded-sharpen-more-smart-filter-v1",
		solarize: "bounded-solarize-smart-filter-v1",
		shapeBlur: "bounded-heart-card-shape-blur-smart-filter-v1",
		smartBlur: "bounded-smart-blur-smart-filter-v1",
		surfaceBlur: "bounded-surface-blur-smart-filter-v1",
	};
	const filterClasses: Record<string, IPsdSmartFilterInfo["type"]> = {
		AdNs: "addNoise",
		DstS: "dustAndScratches",
		Embs: "emboss",
		Extr: "extrude",
		"Tls ": "tiles",
		TrcC: "traceContour",
		"Wnd ": "wind",
		boxblur: "boxBlur",
		ClrH: "colorHalftone",
		Clds: "clouds",
		Crst: "crystallize",
		Dntr: "deInterlace",
		DfrC: "differenceClouds",
		"Dfs ": "diffuse",
		Fbrs: "fibers",
		LnsF: "lensFlare",
		smartSharpen: "smartSharpen",
		UnsM: "unsharpMask",
		Mztn: "mezzotint",
		"Mdn ": "median",
		"Mxm ": "maximum",
		"Mnm ": "minimum",
		GsnB: "gaussianBlur",
		HghP: "highPass",
		MtnB: "motionBlur",
		"Msc ": "mosaic",
		Pntl: "pointillize",
		RdlB: "radialBlur",
		denoise: "reduceNoise",
		shapeBlur: "shapeBlur",
		SmrB: "smartBlur",
		surfaceBlur: "surfaceBlur",
	};
	const blendModes: Record<string, PsdSmartFilterBlendMode> = {
		Nrml: "norm",
		Drkn: "dark",
		Mltp: "mul ",
		CBrn: "idiv",
		Lghn: "lite",
		Scrn: "scrn",
		CDdg: "div ",
		Ovrl: "over",
		SftL: "sLit",
		HrdL: "hLit",
		Dfrn: "diff",
		Xclu: "smud",
		linearDodge: "lddg",
		linearBurn: "lbrn",
		blendSubtraction: "fsub",
		blendDivide: "fdiv",
		"H   ": "hue ",
		Strt: "sat ",
		"Clr ": "colr",
		Lmns: "lum ",
	};
	const filters = descriptorObjectList(filterFx, "filterFXList").map((entry, index): IPsdSmartFilterInfo => {
		const blendOptions = descriptorObject(entry, "blendOptions");
		const opacityUnit = blendOptions ? descriptorUnit(blendOptions, "Opct") : null;
		const blendMode = blendOptions ? (descriptorEnum(blendOptions, "Md  ")?.value ?? "unknown") : "Nrml";
		const filter = descriptorObject(entry, "Fltr");
		const filterIdValue = descriptorNumber(entry, "filterID", Number.NaN);
		const filterId = Number.isInteger(filterIdValue) ? filterIdValue : null;
		const filterClassId = filter?.classId ?? null;
		const type: IPsdSmartFilterInfo["type"] = filterClassId
			? (filterClasses[filterClassId] ?? "unsupported")
			: filterId !== null
				? (ids[filterId] ?? "unsupported")
				: "unsupported";
		const radiusUnit = filter ? descriptorUnit(filter, "Rds ") : null;
		const scalarRadius = filter ? descriptorNumber(filter, "Rds ", Number.NaN) : Number.NaN;
		const radius = radiusUnit && Number.isFinite(radiusUnit.value) ? radiusUnit.value : type === "smartBlur" && Number.isFinite(scalarRadius) ? scalarRadius : null;
		const noiseAmountUnit = filter ? descriptorUnit(filter, "Nose") : null;
		const noiseDistributionValue = filter ? descriptorEnum(filter, "Dstr")?.value : null;
		const noiseMonochromaticValue = filter ? descriptorEntry(filter, "Mnch") : undefined;
		const noiseRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const dustAndScratchesRadius = filter ? descriptorNumber(filter, "Rds ", Number.NaN) : Number.NaN;
		const dustAndScratchesThreshold = filter ? descriptorNumber(filter, "Thsh", Number.NaN) : Number.NaN;
		const colorHalftoneRadius = filter ? descriptorNumber(filter, "Rds ", Number.NaN) : Number.NaN;
		const foregroundColor = parseModernDescriptorColor(descriptorObject(entry, "FrgC")).rgba;
		const backgroundColor = parseModernDescriptorColor(descriptorObject(entry, "BckC")).rgba;
		const cloudsRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const differenceCloudsRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const deInterlaceEliminateValue = filter ? descriptorEnum(filter, "IntE")?.value : null;
		const deInterlaceNewFieldsValue = filter ? descriptorEnum(filter, "IntC")?.value : null;
		const diffuseModeValue = filter ? descriptorEnum(filter, "Md  ")?.value : null;
		const diffuseRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const embossAngle = filter ? descriptorNumber(filter, "Angl", Number.NaN) : Number.NaN;
		const embossHeight = filter ? descriptorNumber(filter, "Hght", Number.NaN) : Number.NaN;
		const embossAmount = filter ? descriptorNumber(filter, "Amnt", Number.NaN) : Number.NaN;
		const extrudeSize = filter ? descriptorNumber(filter, "ExtS", Number.NaN) : Number.NaN;
		const extrudeDepth = filter ? descriptorNumber(filter, "ExtD", Number.NaN) : Number.NaN;
		const extrudeSolidFrontFaces = filter ? descriptorEntry(filter, "ExtF") : undefined;
		const extrudeMaskIncompleteBlocks = filter ? descriptorEntry(filter, "ExtM") : undefined;
		const extrudeTypeValue = filter ? descriptorEnum(filter, "ExtT")?.value : null;
		const extrudeDepthModeValue = filter ? descriptorEnum(filter, "ExtR")?.value : null;
		const extrudeRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const tilesNumber = filter ? descriptorNumber(filter, "TlNm", Number.NaN) : Number.NaN;
		const tilesMaximumOffset = filter ? descriptorNumber(filter, "TlOf", Number.NaN) : Number.NaN;
		const tilesFillValue = filter ? descriptorEnum(filter, "FlCl")?.value : null;
		const tilesRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const traceContourLevel = filter ? descriptorNumber(filter, "Lvl ", Number.NaN) : Number.NaN;
		const traceContourEdgeValue = filter ? descriptorEnum(filter, "Edg ")?.value : null;
		const windMethodValue = filter ? descriptorEnum(filter, "WndM")?.value : null;
		const windDirectionValue = filter ? descriptorEnum(filter, "Drct")?.value : null;
		const fibersVariance = filter ? descriptorNumber(filter, "Vrnc", Number.NaN) : Number.NaN;
		const fibersStrength = filter ? descriptorNumber(filter, "Strg", Number.NaN) : Number.NaN;
		const fibersRandomSeed = filter ? descriptorNumber(filter, "RndS", Number.NaN) : Number.NaN;
		const lensFlareBrightness = filter ? descriptorNumber(filter, "Brgh", Number.NaN) : Number.NaN;
		const lensFlarePosition = filter ? descriptorObject(filter, "FlrC") : null;
		const lensFlarePositionX = lensFlarePosition ? descriptorNumber(lensFlarePosition, "Hrzn", Number.NaN) : Number.NaN;
		const lensFlarePositionY = lensFlarePosition ? descriptorNumber(lensFlarePosition, "Vrtc", Number.NaN) : Number.NaN;
		const lensFlareTypeValue = filter ? descriptorEnum(filter, "Lns ")?.value : null;
		const smartSharpenAmountUnit = filter ? descriptorUnit(filter, "Amnt") : null;
		const smartSharpenThreshold = filter ? descriptorNumber(filter, "Thsh", Number.NaN) : Number.NaN;
		const smartSharpenAngle = filter ? descriptorNumber(filter, "Angl", Number.NaN) : Number.NaN;
		const smartSharpenMoreAccurate = filter ? descriptorEntry(filter, "moreAccurate") : undefined;
		const smartSharpenBlurValue = filter ? descriptorEnum(filter, "blur")?.value : null;
		const smartSharpenPreset = filter ? descriptorString(filter, "preset") : "";
		const smartSharpenShadow = filter ? descriptorObject(filter, "sdwM") : null;
		const smartSharpenHighlight = filter ? descriptorObject(filter, "hglM") : null;
		const smartSharpenShadowAmount = smartSharpenShadow ? descriptorUnit(smartSharpenShadow, "Amnt") : null;
		const smartSharpenShadowWidth = smartSharpenShadow ? descriptorUnit(smartSharpenShadow, "Wdth") : null;
		const smartSharpenShadowRadius = smartSharpenShadow ? descriptorNumber(smartSharpenShadow, "Rds ", Number.NaN) : Number.NaN;
		const smartSharpenHighlightAmount = smartSharpenHighlight ? descriptorUnit(smartSharpenHighlight, "Amnt") : null;
		const smartSharpenHighlightWidth = smartSharpenHighlight ? descriptorUnit(smartSharpenHighlight, "Wdth") : null;
		const smartSharpenHighlightRadius = smartSharpenHighlight ? descriptorNumber(smartSharpenHighlight, "Rds ", Number.NaN) : Number.NaN;
		const unsharpMaskAmountUnit = filter ? descriptorUnit(filter, "Amnt") : null;
		const unsharpMaskThreshold = filter ? descriptorNumber(filter, "Thsh", Number.NaN) : Number.NaN;
		const colorHalftoneAngles = filter ? (["Ang1", "Ang2", "Ang3", "Ang4"].map((key) => descriptorNumber(filter, key, Number.NaN)) as [number, number, number, number]) : null;
		const crystallizeCellSize = filter ? descriptorNumber(filter, "ClSz", Number.NaN) : Number.NaN;
		const crystallizeRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const mosaicCellSizeUnit = filter ? descriptorUnit(filter, "ClSz") : null;
		const pointillizeCellSize = filter ? descriptorNumber(filter, "ClSz", Number.NaN) : Number.NaN;
		const pointillizeRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const mezzotintPatternValue = filter ? descriptorEnum(filter, "MztT")?.value : null;
		const mezzotintRandomSeed = filter ? descriptorNumber(filter, "FlRs", Number.NaN) : Number.NaN;
		const noiseDistributions = { Unfr: "uniform", "Gsn ": "gaussian" } as const;
		const mezzotintPatterns = {
			FnDt: "fine dots",
			MdmD: "medium dots",
			GrnD: "grainy dots",
			CrsD: "coarse dots",
			ShrL: "short lines",
			MdmL: "medium lines",
			LngL: "long lines",
			ShSt: "short strokes",
			MdmS: "medium strokes",
			LngS: "long strokes",
		} as const;
		const distanceUnit = filter ? descriptorUnit(filter, "Dstn") : null;
		const angleDegrees = filter ? descriptorNumber(filter, "Angl", Number.NaN) : Number.NaN;
		const radialAmount = filter ? descriptorNumber(filter, "Amnt", Number.NaN) : Number.NaN;
		const radialMethodValue = filter ? descriptorEnum(filter, "BlrM")?.value : null;
		const radialQualityValue = filter ? descriptorEnum(filter, "BlrQ")?.value : null;
		const reduceNoiseColorUnit = filter ? descriptorUnit(filter, "ClNs") : null;
		const reduceNoiseSharpenUnit = filter ? descriptorUnit(filter, "Shrp") : null;
		const reduceNoiseJpegValue = filter ? descriptorEntry(filter, "removeJPEGArtifact") : undefined;
		const reduceNoisePresetValue = filter ? descriptorEntry(filter, "preset") : undefined;
		const reduceNoiseChannelValues = filter ? descriptorObjectList(filter, "channelDenoise") : [];
		const radialMethods = { "Spn ": "spin", "Zm  ": "zoom" } as const;
		const radialQualities = { Drft: "draft", "Gd  ": "good", "Bst ": "best" } as const;
		const reduceNoiseChannels = { "Rd  ": "red", "Grn ": "green", "Bl  ": "blue", Cmps: "composite" } as const;
		const smartBlurThreshold = filter ? descriptorNumber(filter, "Thsh", Number.NaN) : Number.NaN;
		const smartBlurQualityValue = filter ? descriptorEnum(filter, "SmBQ")?.value : null;
		const smartBlurModeValue = filter ? descriptorEnum(filter, "SmBM")?.value : null;
		const smartBlurQualities = { SBQL: "low", SBQM: "medium", SBQH: "high" } as const;
		const smartBlurModes = { SBMN: "normal", SBME: "edgeOnly", SBMO: "overlayEdge" } as const;
		const customShape = filter ? descriptorObject(filter, "customShape") : null;
		const addNoise =
			type === "addNoise" &&
			noiseAmountUnit &&
			noiseDistributionValue &&
			noiseDistributionValue in noiseDistributions &&
			typeof noiseMonochromaticValue === "boolean" &&
			Number.isFinite(noiseRandomSeed)
				? {
						amountPercent: noiseAmountUnit.value,
						amountUnits: noiseAmountUnit.units,
						distribution: noiseDistributions[noiseDistributionValue as keyof typeof noiseDistributions],
						monochromatic: noiseMonochromaticValue,
						randomSeed: noiseRandomSeed,
					}
				: null;
		const dustAndScratches =
			type === "dustAndScratches" && Number.isFinite(dustAndScratchesRadius) && Number.isFinite(dustAndScratchesThreshold)
				? { radius: dustAndScratchesRadius, threshold: dustAndScratchesThreshold }
				: null;
		const colorHalftone =
			type === "colorHalftone" && Number.isFinite(colorHalftoneRadius) && colorHalftoneAngles?.every(Number.isFinite)
				? { radius: colorHalftoneRadius, anglesDegrees: colorHalftoneAngles }
				: null;
		const clouds = type === "clouds" && Number.isFinite(cloudsRandomSeed) ? { randomSeed: cloudsRandomSeed } : null;
		const differenceClouds = type === "differenceClouds" && Number.isFinite(differenceCloudsRandomSeed) ? { randomSeed: differenceCloudsRandomSeed } : null;
		const deInterlaceEliminate = { ElmO: "oddLines", ElmE: "evenLines" } as const;
		const deInterlaceNewFields = { CrtD: "duplication", CrtI: "interpolation" } as const;
		const deInterlace =
			type === "deInterlace" &&
			deInterlaceEliminateValue &&
			deInterlaceEliminateValue in deInterlaceEliminate &&
			deInterlaceNewFieldsValue &&
			deInterlaceNewFieldsValue in deInterlaceNewFields
				? {
						eliminate: deInterlaceEliminate[deInterlaceEliminateValue as keyof typeof deInterlaceEliminate],
						newFieldsBy: deInterlaceNewFields[deInterlaceNewFieldsValue as keyof typeof deInterlaceNewFields],
					}
				: null;
		const diffuseModes = { Nrml: "normal", DrkO: "darkenOnly", LghO: "lightenOnly", anisotropic: "anisotropic" } as const;
		const diffuse =
			type === "diffuse" && diffuseModeValue && diffuseModeValue in diffuseModes && Number.isFinite(diffuseRandomSeed)
				? { mode: diffuseModes[diffuseModeValue as keyof typeof diffuseModes], randomSeed: diffuseRandomSeed }
				: null;
		const emboss =
			type === "emboss" && Number.isFinite(embossAngle) && Number.isFinite(embossHeight) && Number.isFinite(embossAmount)
				? { angleDegrees: embossAngle, heightPixels: embossHeight, amountPercent: embossAmount }
				: null;
		const extrudeTypes = { Blks: "blocks", Pyrm: "pyramids" } as const;
		const extrudeDepthModes = { Rndm: "random", LvlB: "levelBased" } as const;
		const extrude =
			type === "extrude" &&
			Number.isFinite(extrudeSize) &&
			Number.isFinite(extrudeDepth) &&
			typeof extrudeSolidFrontFaces === "boolean" &&
			typeof extrudeMaskIncompleteBlocks === "boolean" &&
			extrudeTypeValue &&
			extrudeTypeValue in extrudeTypes &&
			extrudeDepthModeValue &&
			extrudeDepthModeValue in extrudeDepthModes &&
			Number.isFinite(extrudeRandomSeed)
				? {
						type: extrudeTypes[extrudeTypeValue as keyof typeof extrudeTypes],
						sizePixels: extrudeSize,
						depth: extrudeDepth,
						depthMode: extrudeDepthModes[extrudeDepthModeValue as keyof typeof extrudeDepthModes],
						randomSeed: extrudeRandomSeed,
						solidFrontFaces: extrudeSolidFrontFaces,
						maskIncompleteBlocks: extrudeMaskIncompleteBlocks,
					}
				: null;
		const tilesFillModes = { FlBc: "backgroundColor", FlFr: "foregroundColor", FlIn: "inverseImage", FlSm: "unalteredImage" } as const;
		const tiles =
			type === "tiles" &&
			Number.isFinite(tilesNumber) &&
			Number.isFinite(tilesMaximumOffset) &&
			tilesFillValue &&
			tilesFillValue in tilesFillModes &&
			Number.isFinite(tilesRandomSeed)
				? {
						numberOfTiles: tilesNumber,
						maximumOffsetPercent: tilesMaximumOffset,
						fillEmptyAreaWith: tilesFillModes[tilesFillValue as keyof typeof tilesFillModes],
						randomSeed: tilesRandomSeed,
					}
				: null;
		const traceContourEdges = { "Lwr ": "lower", "Upr ": "upper" } as const;
		const traceContour =
			type === "traceContour" && Number.isFinite(traceContourLevel) && traceContourEdgeValue && traceContourEdgeValue in traceContourEdges
				? { level: traceContourLevel, edge: traceContourEdges[traceContourEdgeValue as keyof typeof traceContourEdges] }
				: null;
		const windMethods = { "Wnd ": "wind", Blst: "blast", Stgr: "stagger" } as const;
		const windDirections = { Left: "left", Rght: "right" } as const;
		const wind =
			type === "wind" && windMethodValue && windMethodValue in windMethods && windDirectionValue && windDirectionValue in windDirections
				? { method: windMethods[windMethodValue as keyof typeof windMethods], direction: windDirections[windDirectionValue as keyof typeof windDirections] }
				: null;
		const fibers =
			type === "fibers" && Number.isFinite(fibersVariance) && Number.isFinite(fibersStrength) && Number.isFinite(fibersRandomSeed)
				? { variance: fibersVariance, strength: fibersStrength, randomSeed: fibersRandomSeed }
				: null;
		const lensFlareTypes = {
			"Zm  ": "50-300mm zoom",
			"Nkn ": "32mm prime",
			Nkn1: "105mm prime",
			PnVs: "movie prime",
		} as const;
		const lensFlare =
			type === "lensFlare" &&
			Number.isFinite(lensFlareBrightness) &&
			Number.isFinite(lensFlarePositionX) &&
			Number.isFinite(lensFlarePositionY) &&
			lensFlareTypeValue &&
			lensFlareTypeValue in lensFlareTypes
				? {
						brightnessPercent: lensFlareBrightness,
						position: { x: lensFlarePositionX, y: lensFlarePositionY },
						lensType: lensFlareTypes[lensFlareTypeValue as keyof typeof lensFlareTypes],
					}
				: null;
		const smartSharpenBlurTypes = { GsnB: "gaussianBlur", lensBlur: "lensBlur", MtnB: "motionBlur" } as const;
		const smartSharpen =
			type === "smartSharpen" &&
			smartSharpenAmountUnit &&
			radiusUnit &&
			Number.isFinite(smartSharpenThreshold) &&
			Number.isFinite(smartSharpenAngle) &&
			typeof smartSharpenMoreAccurate === "boolean" &&
			smartSharpenBlurValue &&
			smartSharpenBlurValue in smartSharpenBlurTypes &&
			smartSharpenShadowAmount &&
			smartSharpenShadowWidth &&
			Number.isFinite(smartSharpenShadowRadius) &&
			smartSharpenHighlightAmount &&
			smartSharpenHighlightWidth &&
			Number.isFinite(smartSharpenHighlightRadius)
				? {
						amountPercent: smartSharpenAmountUnit.value,
						radius: radiusUnit.value,
						radiusUnits: radiusUnit.units,
						threshold: smartSharpenThreshold,
						angleDegrees: smartSharpenAngle,
						moreAccurate: smartSharpenMoreAccurate,
						blur: smartSharpenBlurTypes[smartSharpenBlurValue as keyof typeof smartSharpenBlurTypes],
						preset: smartSharpenPreset,
						shadow: {
							fadeAmountPercent: smartSharpenShadowAmount.value,
							tonalWidthPercent: smartSharpenShadowWidth.value,
							radius: smartSharpenShadowRadius,
						},
						highlight: {
							fadeAmountPercent: smartSharpenHighlightAmount.value,
							tonalWidthPercent: smartSharpenHighlightWidth.value,
							radius: smartSharpenHighlightRadius,
						},
					}
				: null;
		const unsharpMask =
			type === "unsharpMask" && unsharpMaskAmountUnit && radiusUnit && Number.isFinite(unsharpMaskThreshold)
				? {
						amountPercent: unsharpMaskAmountUnit.value,
						amountUnits: unsharpMaskAmountUnit.units,
						radius: radiusUnit.value,
						radiusUnits: radiusUnit.units,
						threshold: unsharpMaskThreshold,
					}
				: null;
		const crystallize =
			type === "crystallize" && Number.isFinite(crystallizeCellSize) && Number.isFinite(crystallizeRandomSeed)
				? { cellSize: crystallizeCellSize, randomSeed: crystallizeRandomSeed }
				: null;
		const mezzotint =
			type === "mezzotint" && mezzotintPatternValue && mezzotintPatternValue in mezzotintPatterns && Number.isFinite(mezzotintRandomSeed)
				? { pattern: mezzotintPatterns[mezzotintPatternValue as keyof typeof mezzotintPatterns], randomSeed: mezzotintRandomSeed }
				: null;
		const mosaic = type === "mosaic" && mosaicCellSizeUnit ? { cellSize: mosaicCellSizeUnit.value, cellSizeUnits: mosaicCellSizeUnit.units } : null;
		const pointillize =
			type === "pointillize" && Number.isFinite(pointillizeCellSize) && Number.isFinite(pointillizeRandomSeed)
				? { cellSize: pointillizeCellSize, randomSeed: pointillizeRandomSeed }
				: null;
		const motionBlur =
			type === "motionBlur" && Number.isFinite(angleDegrees) && distanceUnit && Number.isFinite(distanceUnit.value)
				? { angleDegrees, distance: distanceUnit.value, distanceUnits: distanceUnit.units }
				: null;
		const radialBlur =
			type === "radialBlur" &&
			Number.isFinite(radialAmount) &&
			radialMethodValue &&
			radialQualityValue &&
			radialMethodValue in radialMethods &&
			radialQualityValue in radialQualities
				? {
						amount: radialAmount,
						method: radialMethods[radialMethodValue as keyof typeof radialMethods],
						quality: radialQualities[radialQualityValue as keyof typeof radialQualities],
					}
				: null;
		const parsedReduceNoiseChannels = reduceNoiseChannelValues.map((entry) => {
			const channelValue = descriptorEntry(entry, "Chnl");
			const channels = Array.isArray(channelValue)
				? channelValue.map((candidate) =>
						candidate && typeof candidate === "object" && !Array.isArray(candidate) && "value" in candidate
							? reduceNoiseChannels[(candidate as IPsdDescriptorEnumValue).value as keyof typeof reduceNoiseChannels]
							: undefined
					)
				: [];
			const amount = descriptorNumber(entry, "Amnt", Number.NaN);
			const preserveDetails = descriptorNumber(entry, "EdgF", Number.NaN);
			return entry.classId === "channelDenoiseParams" && channels.length > 0 && channels.every(Boolean) && Number.isFinite(amount)
				? {
						channels: channels as Array<"red" | "green" | "blue" | "composite">,
						amount,
						preserveDetailsPercent: Number.isFinite(preserveDetails) ? preserveDetails : null,
					}
				: null;
		});
		const reduceNoise =
			type === "reduceNoise" &&
			reduceNoiseColorUnit &&
			reduceNoiseSharpenUnit &&
			typeof reduceNoiseJpegValue === "boolean" &&
			typeof reduceNoisePresetValue === "string" &&
			parsedReduceNoiseChannels.length > 0 &&
			parsedReduceNoiseChannels.every(Boolean)
				? {
						preset: reduceNoisePresetValue,
						removeJpegArtifact: reduceNoiseJpegValue,
						reduceColorNoisePercent: reduceNoiseColorUnit.value,
						sharpenDetailsPercent: reduceNoiseSharpenUnit.value,
						channelDenoise: parsedReduceNoiseChannels as NonNullable<IPsdSmartFilterInfo["reduceNoise"]>["channelDenoise"],
					}
				: null;
		const smartBlur =
			type === "smartBlur" &&
			Number.isFinite(smartBlurThreshold) &&
			smartBlurQualityValue &&
			smartBlurModeValue &&
			smartBlurQualityValue in smartBlurQualities &&
			smartBlurModeValue in smartBlurModes
				? {
						threshold: smartBlurThreshold,
						quality: smartBlurQualities[smartBlurQualityValue as keyof typeof smartBlurQualities],
						mode: smartBlurModes[smartBlurModeValue as keyof typeof smartBlurModes],
					}
				: null;
		const surfaceBlur = type === "surfaceBlur" && Number.isFinite(smartBlurThreshold) && radiusUnit ? { threshold: smartBlurThreshold, radiusUnits: radiusUnit.units } : null;
		const shapeBlur =
			type === "shapeBlur" && radiusUnit && customShape
				? {
						radiusUnits: radiusUnit.units,
						customShape: { name: descriptorString(customShape, "Nm  "), id: descriptorString(customShape, "Idnt") },
						kernel: descriptorString(customShape, "Idnt").toLowerCase() === "e06d65dd-d132-11d5-9a4a-a011a4cb2b24" ? ("heartCard" as const) : null,
					}
				: null;
		const opacity = Math.max(0, Math.min(100, opacityUnit?.value ?? 100));
		const normalizedBlendMode = blendModes[blendMode] ?? null;
		let warning: string | null = null;
		if (type === "unsupported") {
			warning = `Smart filter class/id ${filterClassId ?? filterId ?? "unknown"} is preserved but not executable.`;
		} else if (type === "addNoise" && noiseAmountUnit?.units !== "#Prc") {
			warning = `Smart filter addNoise amount unit ${noiseAmountUnit?.units ?? "missing"} is preserved but bounded execution requires percent.`;
		} else if (type === "addNoise" && (!addNoise || addNoise.amountPercent < 0.1 || addNoise.amountPercent > 400)) {
			warning = "Smart filter addNoise requires amount 0.1-400%, uniform/gaussian distribution, monochromatic state, and an exact random seed.";
		} else if (type === "addNoise" && addNoise && (!Number.isInteger(addNoise.randomSeed) || addNoise.randomSeed < -2_147_483_648 || addNoise.randomSeed > 2_147_483_647)) {
			warning = "Smart filter addNoise random seed must be an exact signed 32-bit integer.";
		} else if (
			type === "dustAndScratches" &&
			(!dustAndScratches ||
				!Number.isInteger(dustAndScratches.radius) ||
				dustAndScratches.radius < 1 ||
				dustAndScratches.radius > 100 ||
				!Number.isInteger(dustAndScratches.threshold) ||
				dustAndScratches.threshold < 0 ||
				dustAndScratches.threshold > 255)
		) {
			warning = "Smart filter dustAndScratches requires integer radius 1-100 pixels and integer threshold 0-255 levels.";
		} else if (
			type === "colorHalftone" &&
			(!colorHalftone ||
				!Number.isInteger(colorHalftone.radius) ||
				colorHalftone.radius < 4 ||
				colorHalftone.radius > 127 ||
				colorHalftone.anglesDegrees.some((angle) => !Number.isInteger(angle) || angle < -360 || angle > 360))
		) {
			warning = "Smart filter colorHalftone requires integer maximum radius 4-127 pixels and four integer CMYK screen angles from -360 to 360 degrees.";
		} else if (
			type === "clouds" &&
			(!clouds || !Number.isInteger(clouds.randomSeed) || clouds.randomSeed < -2_147_483_648 || clouds.randomSeed > 2_147_483_647 || !foregroundColor || !backgroundColor)
		) {
			warning = "Smart filter clouds requires exact RGB foreground/background colors and an exact signed 32-bit random seed.";
		} else if (
			type === "differenceClouds" &&
			(!differenceClouds ||
				!Number.isInteger(differenceClouds.randomSeed) ||
				differenceClouds.randomSeed < -2_147_483_648 ||
				differenceClouds.randomSeed > 2_147_483_647 ||
				!foregroundColor ||
				!backgroundColor)
		) {
			warning = "Smart filter differenceClouds requires exact RGB foreground/background colors and an exact signed 32-bit random seed.";
		} else if (type === "diffuse" && (!diffuse || !Number.isInteger(diffuse.randomSeed) || diffuse.randomSeed < -2_147_483_648 || diffuse.randomSeed > 2_147_483_647)) {
			warning = "Smart filter diffuse requires one exact Normal/Darken Only/Lighten Only/Anisotropic mode and an exact signed 32-bit random seed.";
		} else if (
			type === "emboss" &&
			(!emboss ||
				!Number.isInteger(emboss.angleDegrees) ||
				emboss.angleDegrees < -360 ||
				emboss.angleDegrees > 360 ||
				!Number.isInteger(emboss.heightPixels) ||
				emboss.heightPixels < 1 ||
				emboss.heightPixels > 10 ||
				!Number.isInteger(emboss.amountPercent) ||
				emboss.amountPercent < 1 ||
				emboss.amountPercent > 500)
		) {
			warning = "Smart filter emboss requires integer angle -360..360 degrees, height 1-10 pixels, and amount 1-500%.";
		} else if (
			type === "extrude" &&
			(!extrude ||
				!Number.isInteger(extrude.sizePixels) ||
				extrude.sizePixels < 2 ||
				extrude.sizePixels > 255 ||
				!Number.isInteger(extrude.depth) ||
				extrude.depth < 1 ||
				extrude.depth > 255 ||
				!Number.isInteger(extrude.randomSeed) ||
				extrude.randomSeed < -2_147_483_648 ||
				extrude.randomSeed > 2_147_483_647)
		) {
			warning =
				"Smart filter extrude requires Blocks/Pyramids, integer size 2-255 pixels, integer depth 1-255, Random/Level-based depth, exact Boolean face/mask states, and an exact signed 32-bit random seed.";
		} else if (
			type === "tiles" &&
			(!tiles ||
				!Number.isInteger(tiles.numberOfTiles) ||
				tiles.numberOfTiles < 1 ||
				tiles.numberOfTiles > 99 ||
				!Number.isInteger(tiles.maximumOffsetPercent) ||
				tiles.maximumOffsetPercent < 1 ||
				tiles.maximumOffsetPercent > 99 ||
				!Number.isInteger(tiles.randomSeed) ||
				tiles.randomSeed < -2_147_483_648 ||
				tiles.randomSeed > 2_147_483_647 ||
				(tiles.fillEmptyAreaWith === "backgroundColor" && !backgroundColor) ||
				(tiles.fillEmptyAreaWith === "foregroundColor" && !foregroundColor))
		) {
			warning =
				"Smart filter tiles requires integer tile count 1-99, integer maximum offset 1-99%, one exact fill mode, its required RGB foreground/background color, and an exact signed 32-bit random seed.";
		} else if (type === "traceContour" && (!traceContour || !Number.isInteger(traceContour.level) || traceContour.level < 0 || traceContour.level > 255)) {
			warning = "Smart filter trace contour requires an integer level 0-255 and one exact Lower/Upper edge mode.";
		} else if (type === "wind" && !wind) {
			warning = "Smart filter wind requires one exact Wind/Blast/Stagger method and one exact Left/Right direction.";
		} else if (type === "deInterlace" && !deInterlace) {
			warning = "Smart filter de-interlace requires one exact odd/even field elimination and one exact duplication/interpolation reconstruction method.";
		} else if (
			type === "fibers" &&
			(!fibers ||
				!Number.isInteger(fibers.variance) ||
				fibers.variance < 1 ||
				fibers.variance > 64 ||
				!Number.isInteger(fibers.strength) ||
				fibers.strength < 1 ||
				fibers.strength > 64 ||
				!Number.isInteger(fibers.randomSeed) ||
				fibers.randomSeed < -2_147_483_648 ||
				fibers.randomSeed > 2_147_483_647 ||
				!foregroundColor ||
				!backgroundColor)
		) {
			warning = "Smart filter fibers requires integer variance/strength 1-64, exact RGB foreground/background colors, and an exact signed 32-bit random seed.";
		} else if (
			type === "lensFlare" &&
			(!lensFlare ||
				lensFlare.brightnessPercent < 10 ||
				lensFlare.brightnessPercent > 300 ||
				Math.abs(lensFlare.position.x) > 1_000_000 ||
				Math.abs(lensFlare.position.y) > 1_000_000)
		) {
			warning = "Smart filter lensFlare requires brightness 10-300%, finite bounded pixel coordinates, and one exact supported lens type.";
		} else if (
			type === "smartSharpen" &&
			(!smartSharpen ||
				smartSharpenAmountUnit?.units !== "#Prc" ||
				smartSharpen.radiusUnits !== "#Pxl" ||
				smartSharpenShadowAmount?.units !== "#Prc" ||
				smartSharpenShadowWidth?.units !== "#Prc" ||
				smartSharpenHighlightAmount?.units !== "#Prc" ||
				smartSharpenHighlightWidth?.units !== "#Prc" ||
				smartSharpen.amountPercent < 1 ||
				smartSharpen.amountPercent > 500 ||
				smartSharpen.radius < 0.1 ||
				smartSharpen.radius > 1_000 ||
				!Number.isInteger(smartSharpen.threshold) ||
				smartSharpen.threshold < 0 ||
				smartSharpen.threshold > 255 ||
				smartSharpen.angleDegrees < -360 ||
				smartSharpen.angleDegrees > 360 ||
				smartSharpen.preset.length < 1 ||
				smartSharpen.preset.length > 256 ||
				[smartSharpen.shadow, smartSharpen.highlight].some(
					(tone) =>
						tone.fadeAmountPercent < 0 ||
						tone.fadeAmountPercent > 100 ||
						tone.tonalWidthPercent < 0 ||
						tone.tonalWidthPercent > 100 ||
						tone.radius < 1 ||
						tone.radius > 1_000
				))
		) {
			warning =
				"Smart filter smartSharpen requires percent/pixel units, amount 1-500%, radius 0.1-1000px, threshold 0-255, angle -360..360, exact blur/more-accurate/preset state, and bounded shadow/highlight fade/width/radius controls.";
		} else if (
			type === "unsharpMask" &&
			(!unsharpMask ||
				unsharpMask.amountUnits !== "#Prc" ||
				unsharpMask.radiusUnits !== "#Pxl" ||
				unsharpMask.amountPercent < 1 ||
				unsharpMask.amountPercent > 500 ||
				unsharpMask.radius < 0.1 ||
				unsharpMask.radius > 1_000 ||
				!Number.isInteger(unsharpMask.threshold) ||
				unsharpMask.threshold < 0 ||
				unsharpMask.threshold > 255)
		) {
			warning = "Smart filter unsharpMask requires percent/pixel units, amount 1-500%, radius 0.1-1000px, and integer threshold 0-255 levels.";
		} else if (
			type === "crystallize" &&
			(!crystallize ||
				!Number.isInteger(crystallize.cellSize) ||
				crystallize.cellSize < 3 ||
				crystallize.cellSize > 300 ||
				!Number.isInteger(crystallize.randomSeed) ||
				crystallize.randomSeed < -2_147_483_648 ||
				crystallize.randomSeed > 2_147_483_647)
		) {
			warning = "Smart filter crystallize requires integer cell size 3-300 pixels and an exact signed 32-bit random seed.";
		} else if (
			type === "mezzotint" &&
			(!mezzotint || !Number.isInteger(mezzotint.randomSeed) || mezzotint.randomSeed < -2_147_483_648 || mezzotint.randomSeed > 2_147_483_647)
		) {
			warning = "Smart filter mezzotint requires one of ten exact dot/line/stroke pattern modes and an exact signed 32-bit random seed.";
		} else if (type === "mosaic" && mosaic?.cellSizeUnits !== "#Pxl") {
			warning = `Smart filter mosaic cell-size unit ${mosaic?.cellSizeUnits ?? "missing"} is preserved but bounded execution requires pixels.`;
		} else if (type === "mosaic" && (!mosaic || !Number.isInteger(mosaic.cellSize) || mosaic.cellSize < 2 || mosaic.cellSize > 200)) {
			warning = "Smart filter mosaic requires integer cell size 2-200 pixels.";
		} else if (
			type === "pointillize" &&
			(!pointillize ||
				!Number.isInteger(pointillize.cellSize) ||
				pointillize.cellSize < 3 ||
				pointillize.cellSize > 300 ||
				!Number.isInteger(pointillize.randomSeed) ||
				pointillize.randomSeed < -2_147_483_648 ||
				pointillize.randomSeed > 2_147_483_647 ||
				!backgroundColor)
		) {
			warning = "Smart filter pointillize requires an exact RGB background canvas, integer cell size 3-300 pixels, and an exact signed 32-bit random seed.";
		} else if (type === "motionBlur" && (!motionBlur || !Number.isInteger(motionBlur.angleDegrees) || motionBlur.angleDegrees < -360 || motionBlur.angleDegrees > 360)) {
			warning = "Smart filter motionBlur angle must be an integer between -360 and 360 degrees.";
		} else if (type === "motionBlur" && motionBlur?.distanceUnits !== "#Pxl") {
			warning = `Smart filter motionBlur distance unit ${motionBlur?.distanceUnits ?? "missing"} is preserved but bounded execution requires pixels.`;
		} else if (type === "motionBlur" && (motionBlur!.distance < 1 || motionBlur!.distance > 2000)) {
			warning = "Smart filter motionBlur distance must be between 1 and 2,000 pixels.";
		} else if (type === "radialBlur" && (!radialBlur || !Number.isInteger(radialBlur.amount) || radialBlur.amount < 1 || radialBlur.amount > 100)) {
			warning = "Smart filter radialBlur requires integer amount 1-100 plus supported spin/zoom method and draft/good/best quality.";
		} else if (type === "reduceNoise" && (reduceNoiseColorUnit?.units !== "#Prc" || reduceNoiseSharpenUnit?.units !== "#Prc")) {
			warning = "Smart filter reduceNoise color-noise and sharpen settings require exact percent units.";
		} else if (
			type === "reduceNoise" &&
			(!reduceNoise ||
				!reduceNoise.preset ||
				reduceNoise.preset.length > 256 ||
				reduceNoise.reduceColorNoisePercent < 0 ||
				reduceNoise.reduceColorNoisePercent > 100 ||
				reduceNoise.sharpenDetailsPercent < 0 ||
				reduceNoise.sharpenDetailsPercent > 100 ||
				reduceNoise.channelDenoise.length > 8 ||
				reduceNoise.channelDenoise.some(
					(entry) =>
						entry.channels.length > 4 ||
						new Set(entry.channels).size !== entry.channels.length ||
						!Number.isInteger(entry.amount) ||
						entry.amount < 0 ||
						entry.amount > 10 ||
						(entry.preserveDetailsPercent !== null && (entry.preserveDetailsPercent < 0 || entry.preserveDetailsPercent > 100))
				) ||
				new Set(reduceNoise.channelDenoise.flatMap((entry) => entry.channels)).size !== reduceNoise.channelDenoise.flatMap((entry) => entry.channels).length)
		) {
			warning =
				"Smart filter reduceNoise requires a named preset, 0-100% color-noise/sharpen values, exact JPEG state, and unique channel settings with amount 0-10 and preserve details 0-100%.";
		} else if (type === "smartBlur" && (radius === null || radius < 0.1 || radius > 100)) {
			warning = "Smart filter smartBlur radius must be between 0.1 and 100 pixels.";
		} else if (type === "smartBlur" && (!smartBlur || smartBlur.threshold < 0 || smartBlur.threshold > 255)) {
			warning = "Smart filter smartBlur requires threshold 0-255 plus supported low/medium/high quality and normal/edge-only/overlay-edge mode.";
		} else if (type === "surfaceBlur" && surfaceBlur?.radiusUnits !== "#Pxl") {
			warning = `Smart filter surfaceBlur radius unit ${surfaceBlur?.radiusUnits ?? "missing"} is preserved but bounded execution requires pixels.`;
		} else if (type === "surfaceBlur" && (radius === null || radius < 1 || radius > 100)) {
			warning = "Smart filter surfaceBlur radius must be between 1 and 100 pixels.";
		} else if (type === "surfaceBlur" && (!surfaceBlur || !Number.isInteger(surfaceBlur.threshold) || surfaceBlur.threshold < 0 || surfaceBlur.threshold > 255)) {
			warning = "Smart filter surfaceBlur threshold must be an integer between 0 and 255.";
		} else if (type === "shapeBlur" && shapeBlur?.radiusUnits !== "#Pxl") {
			warning = `Smart filter shapeBlur radius unit ${shapeBlur?.radiusUnits ?? "missing"} is preserved but bounded execution requires pixels.`;
		} else if (type === "shapeBlur" && (radius === null || radius < 5 || radius > 1000)) {
			warning = "Smart filter shapeBlur radius must be between 5 and 1,000 pixels.";
		} else if (type === "shapeBlur" && (!shapeBlur || !shapeBlur.customShape.name || !shapeBlur.customShape.id)) {
			warning = "Smart filter shapeBlur requires a named custom-shape preset with an exact identifier.";
		} else if (type === "shapeBlur" && shapeBlur?.kernel !== "heartCard") {
			warning = `Smart filter shapeBlur custom shape ${shapeBlur?.customShape.name ?? "missing"} (${shapeBlur?.customShape.id ?? "missing"}) is preserved and requires an explicit exact project-raster kernel binding for bounded execution.`;
		} else if (radiusUnit && radiusUnit.units !== "#Pxl") {
			warning = `Smart filter ${type} radius unit ${radiusUnit.units} is preserved but bounded execution requires pixels.`;
		} else if ((type === "boxBlur" || type === "gaussianBlur") && (radius === null || radius < 0 || radius > 16)) {
			warning = `Smart filter ${type} radius must be between 0 and 16 pixels.`;
		} else if ((type === "maximum" || type === "minimum" || type === "highPass") && (radius === null || radius < 0.1 || radius > 64)) {
			warning = `Smart filter ${type} radius must be between 0.1 and 64 pixels.`;
		} else if (type === "median" && (radius === null || radius < 1 || radius > 64)) {
			warning = "Smart filter median radius must be between 1 and 64 pixels.";
		} else if (!normalizedBlendMode) {
			warning = `Smart filter blend mode ${blendMode} is preserved but not supported by bounded execution.`;
		}
		return {
			index,
			name: descriptorString(entry, "Nm  ", `Smart Filter ${index + 1}`),
			type,
			filterClassId,
			filterId,
			enabled: descriptorBoolean(entry, "enab", true),
			opacity,
			blendMode,
			normalizedBlendMode,
			radius,
			foregroundColor,
			backgroundColor,
			addNoise,
			clouds,
			differenceClouds,
			deInterlace,
			diffuse,
			emboss,
			extrude,
			tiles,
			traceContour,
			wind,
			fibers,
			lensFlare,
			smartSharpen,
			unsharpMask,
			colorHalftone,
			crystallize,
			dustAndScratches,
			mezzotint,
			mosaic,
			pointillize,
			motionBlur,
			radialBlur,
			reduceNoise,
			smartBlur,
			surfaceBlur,
			shapeBlur,
			bakeSupported: warning === null,
			warning,
			algorithmExecutionModel: type === "shapeBlur" && shapeBlur?.kernel !== "heartCard" ? null : (algorithmExecutionModels[type] ?? null),
			blendExecutionModel: normalizedBlendMode ? "bounded-smart-filter-blend-v1" : null,
			executionModel: "bounded-smart-filter-v1",
		};
	});
	return { state, filters };
}

function parsePsdSmartObjectLayer(data: Uint8Array, layerIndex: number, sourceKey: "PlLd" | "SoLd" | "SoLE"): IPsdSmartObjectLayerInfo {
	const cursor: IPsdDescriptorCursor = { offset: 0, end: data.length, items: 0 };
	if (sourceKey === "PlLd") {
		if (readAscii(data, cursor.offset, 4, `layer ${layerIndex} PlLd signature`) !== "plcL") {
			throw new Error(`Malformed PSD: layer ${layerIndex} PlLd signature must be plcL.`);
		}
		cursor.offset += 4;
		const version = readInt32(data, cursor.offset, `layer ${layerIndex} PlLd version`);
		cursor.offset += 4;
		if (version !== 3) {
			throw new Error(`Unsupported PSD layer ${layerIndex} PlLd version ${version}; version 3 is required.`);
		}
		assertRange(data, cursor.offset, 1, `layer ${layerIndex} PlLd id length`);
		const idLength = data[cursor.offset++];
		if (idLength > 128) {
			throw new Error(`Unsupported PSD layer ${layerIndex} PlLd id exceeds 128 bytes.`);
		}
		const id = readAscii(data, cursor.offset, idLength, `layer ${layerIndex} PlLd id`).replace(/\0/g, "");
		cursor.offset += idLength;
		const pageNumber = readInt32(data, cursor.offset, `layer ${layerIndex} PlLd page number`);
		const totalPages = readInt32(data, cursor.offset + 4, `layer ${layerIndex} PlLd total pages`);
		const antiAliasPolicy = readInt32(data, cursor.offset + 8, `layer ${layerIndex} PlLd antialias policy`);
		const typeIndex = readInt32(data, cursor.offset + 12, `layer ${layerIndex} PlLd type`);
		cursor.offset += 16;
		const types = ["unknown", "vector", "raster", "imageStack"] as const;
		if (!types[typeIndex] || pageNumber < 1 || totalPages < pageNumber || totalPages > 1_000_000 || antiAliasPolicy !== 16) {
			throw new Error(`Malformed PSD: layer ${layerIndex} PlLd page/type/antialias values are invalid.`);
		}
		const transform = parseSmartObjectTransform(
			Array.from({ length: 8 }, (_, index) => readDescriptorFloat64(data, cursor, `layer ${layerIndex} PlLd transform ${index}`)),
			layerIndex,
			"PlLd transform"
		);
		const warpVersion = readInt32(data, cursor.offset, `layer ${layerIndex} PlLd warp version`);
		cursor.offset += 4;
		const descriptorVersion = readUint32(data, cursor.offset, `layer ${layerIndex} PlLd warp descriptor version`);
		cursor.offset += 4;
		if (warpVersion !== 0 || descriptorVersion !== 16) {
			throw new Error(`Unsupported PSD layer ${layerIndex} PlLd warp/descriptor version ${warpVersion}/${descriptorVersion}; 0/16 is required.`);
		}
		const warp = parsePsdWarp(readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} PlLd warp descriptor`));
		const padding = data.slice(cursor.offset);
		if (padding.length > 3 || padding.some((value) => value !== 0)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} PlLd leaves non-padding trailing bytes.`);
		}
		return {
			sourceKey,
			version: 3,
			id,
			placedId: null,
			type: types[typeIndex],
			pageNumber,
			totalPages,
			transform,
			nonAffineTransform: null,
			width: null,
			height: null,
			resolution: null,
			crop: null,
			comp: null,
			compInfo: null,
			frameStep: null,
			duration: null,
			frameCount: 0,
			warp,
			filterCount: 0,
			smartFilterState: null,
			smartFilters: [],
			smartFilterMask: null,
			smartFilterMaskWarning: null,
			linkedResource: { status: "missing", resourceIndices: [] },
			executionModel: "bounded-smart-object-v1",
		};
	}
	if (readAscii(data, cursor.offset, 4, `layer ${layerIndex} ${sourceKey} signature`) !== "soLD") {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} signature must be soLD.`);
	}
	cursor.offset += 4;
	const version = readInt32(data, cursor.offset, `layer ${layerIndex} ${sourceKey} version`);
	cursor.offset += 4;
	if (version !== 4 && version !== 5) {
		throw new Error(`Unsupported PSD layer ${layerIndex} ${sourceKey} version ${version}; versions 4 and 5 are supported.`);
	}
	const descriptorVersion = readUint32(data, cursor.offset, `layer ${layerIndex} ${sourceKey} descriptor version`);
	cursor.offset += 4;
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} ${sourceKey} descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} ${sourceKey} descriptor`);
	const types = ["unknown", "vector", "raster", "imageStack"] as const;
	const typeIndex = descriptorNumber(root, "Type", -1);
	const pageNumber = descriptorNumber(root, "PgNm", 1);
	const totalPages = descriptorNumber(root, "totalPages", 1);
	if (!Number.isInteger(typeIndex) || !types[typeIndex] || !Number.isInteger(pageNumber) || !Number.isInteger(totalPages) || pageNumber < 1 || totalPages < pageNumber) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} page/type values are invalid.`);
	}
	const transform = parseSmartObjectTransform(descriptorNumberList(root, "Trnf"), layerIndex, `${sourceKey} transform`);
	const nonAffineValues = descriptorNumberList(root, "nonAffineTransform");
	const nonAffineTransform = nonAffineValues.length ? parseSmartObjectTransform(nonAffineValues, layerIndex, `${sourceKey} non-affine transform`) : null;
	const size = descriptorObject(root, "Sz  ");
	const width = size ? descriptorNumber(size, "Wdth", Number.NaN) : Number.NaN;
	const height = size ? descriptorNumber(size, "Hght", Number.NaN) : Number.NaN;
	const boundedDimension = (value: number): number | null => (Number.isFinite(value) && value >= 0 && value <= MAXIMUM_PSD_DIMENSION ? value : null);
	const resolution = descriptorUnit(root, "Rslt");
	const compInfo = descriptorObject(root, "compInfo");
	const filterFx = descriptorObject(root, "filterFX");
	const filterList = filterFx ? descriptorEntry(filterFx, "filterFXList") : null;
	const smartFilters = parseSmartFilters(filterFx);
	const warp = descriptorObject(root, "quiltWarp") ?? descriptorObject(root, "warp");
	const padding = data.slice(cursor.offset);
	if (padding.length > 3 || padding.some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceKey} leaves non-padding trailing bytes.`);
	}
	return {
		sourceKey,
		version,
		id: descriptorString(root, "Idnt"),
		placedId: descriptorString(root, "placed") || null,
		type: types[typeIndex],
		pageNumber,
		totalPages,
		transform,
		nonAffineTransform: nonAffineTransform?.some((value, index) => value !== transform[index]) ? nonAffineTransform : null,
		width: boundedDimension(width),
		height: boundedDimension(height),
		resolution: resolution && Number.isFinite(resolution.value) ? resolution : null,
		crop: Number.isFinite(descriptorNumber(root, "Crop", Number.NaN)) ? descriptorNumber(root, "Crop", Number.NaN) : null,
		comp: Number.isFinite(descriptorNumber(root, "comp", Number.NaN)) ? descriptorNumber(root, "comp", Number.NaN) : null,
		compInfo: compInfo ? { compId: descriptorNumber(compInfo, "compID", 0), originalCompId: descriptorNumber(compInfo, "originalCompID", 0) } : null,
		frameStep: parseSmartObjectFraction(descriptorObject(root, "frameStep")),
		duration: parseSmartObjectFraction(descriptorObject(root, "duration")),
		frameCount: Math.max(0, Math.floor(descriptorNumber(root, "frameCount", 0))),
		warp: parsePsdWarp(warp),
		filterCount: Array.isArray(filterList) ? filterList.length : 0,
		smartFilterState: smartFilters.state,
		smartFilters: smartFilters.filters,
		smartFilterMask: null,
		smartFilterMaskWarning: null,
		linkedResource: { status: "missing", resourceIndices: [] },
		executionModel: "bounded-smart-object-v1",
	};
}

interface IPsdParsedColorLookupTable {
	size: number;
	values: Float32Array;
}

const parsedColorLookupTables = new WeakMap<IPsdColorLookupAdjustmentInfo, IPsdParsedColorLookupTable>();

function parseColorLookupTable(
	data: Uint8Array,
	format: IPsdColorLookupAdjustmentInfo["lutFormat"],
	layerIndex: number
): { table: IPsdParsedColorLookupTable; domainMinimum: [number, number, number]; domainMaximum: [number, number, number] } | null {
	if (format === "look" || data.byteLength === 0 || data.byteLength > 8 * 1024 * 1024) {
		return null;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\uFEFF/, "");
	} catch {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup embedded ${format.toUpperCase()} data is not valid UTF-8 text.`);
	}
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*/, "").trim())
		.filter(Boolean);
	let size = 0;
	let domainMinimum: [number, number, number] = [0, 0, 0];
	let domainMaximum: [number, number, number] = [1, 1, 1];
	const rows: number[][] = [];
	if (format === "cube") {
		for (const line of lines) {
			const parts = line.split(/\s+/);
			if (parts[0] === "TITLE" || parts[0] === "LUT_1D_SIZE") {
				continue;
			}
			if (parts[0] === "LUT_3D_SIZE") {
				size = Number(parts[1]);
				continue;
			}
			if (parts[0] === "DOMAIN_MIN" || parts[0] === "DOMAIN_MAX") {
				const values = parts.slice(1).map(Number);
				if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
					throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup ${parts[0]} must contain three finite values.`);
				}
				if (parts[0] === "DOMAIN_MIN") {
					domainMinimum = values as [number, number, number];
				} else {
					domainMaximum = values as [number, number, number];
				}
				continue;
			}
			if (/^[A-Za-z_]/.test(parts[0])) {
				continue;
			}
			rows.push(parts.map(Number));
		}
	} else {
		const numeric = lines.map((line) => line.split(/\s+/).map(Number)).filter((values) => values.every(Number.isFinite));
		if (numeric.length) {
			size = numeric[0].length;
			const maximum = Math.max(...numeric.slice(1).flat());
			for (const row of numeric.slice(1)) {
				rows.push(row.map((value) => value / Math.max(1, maximum)));
			}
		}
	}
	if (
		!Number.isInteger(size) ||
		size < 2 ||
		size > 64 ||
		rows.length !== size ** 3 ||
		rows.some((row) => row.length !== 3 || row.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
	) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup ${format.toUpperCase()} table must contain exactly N³ bounded RGB rows for size 2..64.`);
	}
	if (domainMinimum.some((value, index) => !Number.isFinite(value) || !Number.isFinite(domainMaximum[index]) || value >= domainMaximum[index])) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup domain minimums must be below maximums.`);
	}
	return { table: { size, values: Float32Array.from(rows.flat()) }, domainMinimum, domainMaximum };
}

function parseColorLookupAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdColorLookupAdjustmentInfo {
	const data = bytes.subarray(offset, offset + length);
	if (length < 22 || readUint16(data, 0, `layer ${layerIndex} Color Lookup version`) !== 1) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Color Lookup record; version 1 with a descriptor is required.`);
	}
	const descriptorVersion = readUint32(data, 2, `layer ${layerIndex} Color Lookup descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Color Lookup descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 6, end: length, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} Color Lookup`);
	const paddingBytes = cursor.end - cursor.offset;
	if (paddingBytes < 0 || paddingBytes > 3 || data.subarray(cursor.offset).some((value) => value !== 0) || root.classId !== "null") {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup descriptor/class/trailing padding is invalid.`);
	}
	const keys = ["lookupType", "Nm  ", "Dthr", "profile", "LUTFormat", "dataOrder", "tableOrder", "LUT3DFileData", "LUT3DFileName"];
	for (const key of keys) {
		if (root.entries.filter((entry) => entry.key === key).length > 1) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup descriptor repeats ${key}.`);
		}
	}
	const enumValue = (key: string): string => descriptorEnum(root, key)?.value ?? "";
	const lookupTypes: Record<string, IPsdColorLookupAdjustmentInfo["lookupType"]> = {
		"3DLUT": "3dlut",
		abstractProfile: "abstractProfile",
		deviceLinkProfile: "deviceLinkProfile",
	};
	const formats: Record<string, IPsdColorLookupAdjustmentInfo["lutFormat"]> = { LUTFormatLOOK: "look", LUTFormatCUBE: "cube", LUTFormat3DL: "3dl" };
	const orders: Record<string, IPsdColorLookupAdjustmentInfo["dataOrder"]> = { rgbOrder: "rgb", bgrOrder: "bgr" };
	const lookupType = lookupTypes[enumValue("lookupType")] ?? "3dlut";
	const lutFormat = formats[enumValue("LUTFormat")] ?? "look";
	const dataOrder = orders[enumValue("dataOrder")] ?? "rgb";
	const tableOrder = orders[enumValue("tableOrder")] ?? "rgb";
	const ditherValue = descriptorEntry(root, "Dthr");
	if (ditherValue !== undefined && typeof ditherValue !== "boolean") {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup dither must be boolean.`);
	}
	const profileValue = descriptorEntry(root, "profile");
	const lutDataValue = descriptorEntry(root, "LUT3DFileData");
	const profile = profileValue instanceof Uint8Array ? profileValue : new Uint8Array();
	const lutData = lutDataValue instanceof Uint8Array ? lutDataValue : new Uint8Array();
	if ((profileValue !== undefined && !(profileValue instanceof Uint8Array)) || (lutDataValue !== undefined && !(lutDataValue instanceof Uint8Array))) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Color Lookup profile and LUT data must be byte arrays.`);
	}
	const parsed = lookupType === "3dlut" ? parseColorLookupTable(lutData, lutFormat, layerIndex) : null;
	const adjustment: IPsdColorLookupAdjustmentInfo = {
		key: "clrL",
		version: 1,
		descriptorVersion: 16,
		lookupType,
		name: descriptorString(root, "Nm  "),
		dither: ditherValue === true,
		profileBytes: profile.byteLength,
		lutFormat,
		dataOrder,
		tableOrder,
		lut3DFileBytes: lutData.byteLength,
		lut3DFileName: descriptorString(root, "LUT3DFileName"),
		lutSize: parsed?.table.size ?? null,
		lutEntryCount: parsed ? parsed.table.size ** 3 : 0,
		domainMinimum: parsed?.domainMinimum ?? [0, 0, 0],
		domainMaximum: parsed?.domainMaximum ?? [1, 1, 1],
		paddingBytes: paddingBytes as 0 | 1 | 2 | 3,
		colorModel: "bounded-trilinear-color-lookup-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: parsed !== null,
	};
	if (parsed) {
		parsedColorLookupTables.set(adjustment, parsed.table);
	}
	return adjustment;
}

function parseVibranceAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdVibranceAdjustmentInfo {
	if (length < 20) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Vibrance data must contain descriptor version 16 and a descriptor.`);
	}
	const data = bytes.subarray(offset, offset + length);
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} Vibrance descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Vibrance descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: length, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} Vibrance`);
	const paddingBytes = cursor.end - cursor.offset;
	if (paddingBytes < 0 || paddingBytes > 3 || data.subarray(cursor.offset, cursor.end).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Vibrance leaves ${paddingBytes} non-padding trailing descriptor byte(s).`);
	}
	if (root.classId !== "null") {
		throw new Error(`Malformed PSD: layer ${layerIndex} Vibrance descriptor class must be null.`);
	}
	for (const key of ["vibrance", "Strt"]) {
		if (root.entries.filter((entry) => entry.key === key).length > 1) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Vibrance descriptor repeats ${key}.`);
		}
	}
	const vibranceValue = descriptorEntry(root, "vibrance");
	const saturationValue = descriptorEntry(root, "Strt");
	const vibrance = vibranceValue === undefined ? 0 : vibranceValue;
	const saturation = saturationValue === undefined ? 0 : saturationValue;
	if (typeof vibrance !== "number" || !Number.isInteger(vibrance) || vibrance < -100 || vibrance > 100) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Vibrance value must be an integer from -100 to 100.`);
	}
	if (typeof saturation !== "number" || !Number.isInteger(saturation) || saturation < -100 || saturation > 100) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Vibrance saturation must be an integer from -100 to 100.`);
	}
	return {
		key: "vibA",
		descriptorVersion: 16,
		paddingBytes: paddingBytes as 0 | 1 | 2 | 3,
		vibrance,
		saturation,
		colorModel: "bounded-hsl-vibrance-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: true,
	};
}

function parseBlackWhiteAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdBlackWhiteAdjustmentInfo {
	if (length < 20) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Black & White data must contain descriptor version 16 and a descriptor.`);
	}
	const data = bytes.subarray(offset, offset + length);
	const descriptorVersion = readUint32(data, 0, `layer ${layerIndex} Black & White descriptor version`);
	if (descriptorVersion !== 16) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Black & White descriptor version ${descriptorVersion}; version 16 is required.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 4, end: length, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} Black & White`);
	const paddingBytes = cursor.end - cursor.offset;
	if (paddingBytes < 0 || paddingBytes > 3 || data.subarray(cursor.offset, cursor.end).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Black & White leaves ${paddingBytes} non-padding trailing descriptor byte(s).`);
	}
	if (root.classId !== "null") {
		throw new Error(`Malformed PSD: layer ${layerIndex} Black & White descriptor class must be null.`);
	}
	const keys = ["Rd  ", "Yllw", "Grn ", "Cyn ", "Bl  ", "Mgnt", "useTint", "tintColor", "bwPresetKind", "blackAndWhitePresetFileName"];
	for (const key of keys) {
		if (root.entries.filter((entry) => entry.key === key).length > 1) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Black & White descriptor repeats ${key}.`);
		}
	}
	const readMix = (key: string, fallback: number): number => {
		const value = descriptorEntry(root, key) ?? fallback;
		if (typeof value !== "number" || !Number.isInteger(value) || value < -200 || value > 300) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Black & White ${key.trim()} value must be an integer from -200 to 300.`);
		}
		return value;
	};
	const useTintValue = descriptorEntry(root, "useTint");
	if (useTintValue !== undefined && typeof useTintValue !== "boolean") {
		throw new Error(`Malformed PSD: layer ${layerIndex} Black & White useTint value must be boolean.`);
	}
	const tintObject = descriptorObject(root, "tintColor");
	const tintColor = parseModernDescriptorColor(tintObject);
	const presetKindValue = descriptorEntry(root, "bwPresetKind") ?? 0;
	if (typeof presetKindValue !== "number" || !Number.isInteger(presetKindValue) || presetKindValue < 0 || presetKindValue > 65535) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Black & White preset kind must be an integer from 0 to 65535.`);
	}
	const presetFileNameValue = descriptorEntry(root, "blackAndWhitePresetFileName") ?? "";
	if (typeof presetFileNameValue !== "string") {
		throw new Error(`Malformed PSD: layer ${layerIndex} Black & White preset file name must be text.`);
	}
	const useTint = useTintValue === true;
	return {
		key: "blwh",
		descriptorVersion: 16,
		paddingBytes: paddingBytes as 0 | 1 | 2 | 3,
		reds: readMix("Rd  ", 40),
		yellows: readMix("Yllw", 60),
		greens: readMix("Grn ", 40),
		cyans: readMix("Cyn ", 60),
		blues: readMix("Bl  ", 20),
		magentas: readMix("Mgnt", 80),
		useTint,
		tintColor,
		presetKind: presetKindValue,
		presetFileName: presetFileNameValue,
		colorModel: "bounded-hue-mix-black-white-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: !useTint || tintColor.rgba !== null,
	};
}

function parseChannelMixerAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdChannelMixerAdjustmentInfo {
	if (length !== 44) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Channel Mixer data must be exactly 44 bytes.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} Channel Mixer version`);
	if (version !== 1) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Channel Mixer version ${version}; version 1 is required.`);
	}
	const monochromeFlag = readUint16(bytes, offset + 2, `layer ${layerIndex} Channel Mixer monochrome flag`);
	if (monochromeFlag !== 0 && monochromeFlag !== 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Channel Mixer monochrome flag must be 0 or 1.`);
	}
	const readChannel = (channelOffset: number, name: string): IPsdChannelMixerChannelInfo => {
		const channel = {
			red: readInt16(bytes, channelOffset, `layer ${layerIndex} Channel Mixer ${name} red`),
			green: readInt16(bytes, channelOffset + 2, `layer ${layerIndex} Channel Mixer ${name} green`),
			blue: readInt16(bytes, channelOffset + 4, `layer ${layerIndex} Channel Mixer ${name} blue`),
			constant: readInt16(bytes, channelOffset + 8, `layer ${layerIndex} Channel Mixer ${name} constant`),
		};
		if (Object.values(channel).some((value) => value < -200 || value > 200)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Channel Mixer ${name} values must be within -200..200.`);
		}
		if (readUint16(bytes, channelOffset + 6, `layer ${layerIndex} Channel Mixer ${name} reserved word`) !== 0) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Channel Mixer ${name} reserved word must be zero.`);
		}
		return { ...channel, reservedWord: 0, total: channel.red + channel.green + channel.blue };
	};
	const monochrome = monochromeFlag === 1;
	if (monochrome && bytes.subarray(offset + 14, offset + 44).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} monochrome Channel Mixer color-channel padding must be zero.`);
	}
	return {
		key: "mixr",
		version: 1,
		monochrome,
		red: monochrome ? null : readChannel(offset + 4, "red output"),
		green: monochrome ? null : readChannel(offset + 14, "green output"),
		blue: monochrome ? null : readChannel(offset + 24, "blue output"),
		gray: readChannel(monochrome ? offset + 4 : offset + 34, "gray output"),
		monochromePaddingBytes: monochrome ? 30 : 0,
		colorModel: "bounded-linear-channel-mixer-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: true,
	};
}

function parseSelectiveColorAdjustment(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdSelectiveColorAdjustmentInfo {
	if (length !== 84) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Selective Color data must be exactly 84 bytes.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} Selective Color version`);
	if (version !== 1) {
		throw new Error(`Unsupported PSD layer ${layerIndex} Selective Color version ${version}; version 1 is required.`);
	}
	const modeWord = readUint16(bytes, offset + 2, `layer ${layerIndex} Selective Color mode`);
	if (modeWord !== 0 && modeWord !== 1) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Selective Color mode must be relative (0) or absolute (1).`);
	}
	if (bytes.subarray(offset + 4, offset + 12).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer ${layerIndex} Selective Color reserved bytes must be zero.`);
	}
	const readRange = (rangeOffset: number, name: string): IPsdSelectiveColorRangeInfo => {
		const range = {
			cyan: readInt16(bytes, rangeOffset, `layer ${layerIndex} Selective Color ${name} cyan`),
			magenta: readInt16(bytes, rangeOffset + 2, `layer ${layerIndex} Selective Color ${name} magenta`),
			yellow: readInt16(bytes, rangeOffset + 4, `layer ${layerIndex} Selective Color ${name} yellow`),
			black: readInt16(bytes, rangeOffset + 6, `layer ${layerIndex} Selective Color ${name} black`),
		};
		if (Object.values(range).some((value) => value < -100 || value > 100)) {
			throw new Error(`Malformed PSD: layer ${layerIndex} Selective Color ${name} values must be within -100..100.`);
		}
		return range;
	};
	return {
		key: "selc",
		version: 1,
		mode: modeWord === 1 ? "absolute" : "relative",
		reservedBytes: 8,
		reds: readRange(offset + 12, "reds"),
		yellows: readRange(offset + 20, "yellows"),
		greens: readRange(offset + 28, "greens"),
		cyans: readRange(offset + 36, "cyans"),
		blues: readRange(offset + 44, "blues"),
		magentas: readRange(offset + 52, "magentas"),
		whites: readRange(offset + 60, "whites"),
		neutrals: readRange(offset + 68, "neutrals"),
		blacks: readRange(offset + 76, "blacks"),
		rangeModel: "bounded-extrema-range-weights-v1",
		colorModel: "bounded-cmyk-selective-color-v1",
		executionModel: "bounded-adjustment-v1",
		bakeSupported: true,
	};
}

function parseModernDescriptorColor(object: IPsdDescriptorObjectValue | null): IPsdLayerEffectColorInfo {
	const red = object ? descriptorEntry(object, "Rd  ") : undefined;
	const green = object ? descriptorEntry(object, "Grn ") : undefined;
	const blue = object ? descriptorEntry(object, "Bl  ") : undefined;
	const values = [red, green, blue];
	const rgba: [number, number, number, 255] | null = values.every((value) => typeof value === "number" && Number.isFinite(value))
		? [
				Math.max(0, Math.min(255, Math.round(red as number))),
				Math.max(0, Math.min(255, Math.round(green as number))),
				Math.max(0, Math.min(255, Math.round(blue as number))),
				255,
			]
		: null;
	return { space: 0, components: rgba ? [rgba[0] * 257, rgba[1] * 257, rgba[2] * 257, 0] : [0, 0, 0, 0], rgba };
}

const MODERN_GRADIENT_STYLES: Record<string, PsdLayerGradientStyle> = {
	"Lnr ": "linear",
	"Rdl ": "radial",
	Angl: "angle",
	Rflc: "reflected",
	Dmnd: "diamond",
};

const MODERN_GRADIENT_INTERPOLATIONS: Record<string, PsdLayerGradientInterpolation> = {
	Perc: "perceptual",
	"Lnr ": "linear",
	Gcls: "classic",
	Smoo: "smooth",
};

const MODERN_NOISE_GRADIENT_COLOR_MODELS: Record<string, PsdLayerNoiseGradientColorModel> = {
	RGBC: "rgb",
	HSBl: "hsb",
	LbCl: "lab",
	HSLC: "hsl",
};

function parseModernGradient(object: IPsdDescriptorObjectValue): IPsdLayerGradientInfo | null {
	const gradientObject = descriptorObject(object, "Grad");
	if (!gradientObject) {
		return null;
	}
	const gradientTypeValue = descriptorEnum(gradientObject, "GrdF")?.value ?? "";
	const type = gradientTypeValue === "CstS" ? "solid" : gradientTypeValue === "ClNs" ? "noise" : "unknown";
	const samples = type === "solid" ? descriptorNumber(gradientObject, "Intr", 4096) : 0;
	const style = MODERN_GRADIENT_STYLES[descriptorEnum(object, "Type")?.value ?? ""] ?? "unknown";
	const interpolationValue = descriptorEnum(object, "gs99")?.value ?? descriptorEnum(object, "gradientsInterpolationMethod")?.value ?? "";
	const interpolation = type === "solid" ? (MODERN_GRADIENT_INTERPOLATIONS[interpolationValue] ?? "classic") : "unknown";
	const angleValue = descriptorUnit(object, "Angl");
	const scaleValue = descriptorUnit(object, "Scl ");
	const offsetObject = descriptorObject(object, "Ofst");
	const horizontalOffset = offsetObject ? descriptorUnit(offsetObject, "Hrzn") : null;
	const verticalOffset = offsetObject ? descriptorUnit(offsetObject, "Vrtc") : null;
	const colorStops = descriptorObjectList(gradientObject, "Clrs").map((stop) => {
		const rawLocation = descriptorNumber(stop, "Lctn", -1);
		return {
			location: samples > 0 ? rawLocation / samples : -1,
			rawLocation,
			midpoint: descriptorNumber(stop, "Mdpn", -1) / 100,
			color: parseModernDescriptorColor(descriptorObject(stop, "Clr ")),
		};
	});
	const opacityStops = descriptorObjectList(gradientObject, "Trns").map((stop) => {
		const rawLocation = descriptorNumber(stop, "Lctn", -1);
		const opacity = descriptorUnit(stop, "Opct");
		return {
			location: samples > 0 ? rawLocation / samples : -1,
			rawLocation,
			midpoint: descriptorNumber(stop, "Mdpn", -1) / 100,
			opacity: opacity?.value ?? -1,
		};
	});
	const locationsAreOrdered = (stops: Array<{ location: number }>): boolean =>
		stops.every((stop, index) => stop.location >= 0 && stop.location <= 1 && (index === 0 || stop.location >= stops[index - 1].location));
	const midpointsAreValid = (stops: Array<{ midpoint: number }>): boolean => stops.every((stop) => stop.midpoint > 0 && stop.midpoint < 1);
	const offsetsUsePercent = (!horizontalOffset || horizontalOffset.units === "#Prc") && (!verticalOffset || verticalOffset.units === "#Prc");
	const scale = scaleValue?.value ?? 100;
	const roughnessRaw = descriptorNumber(gradientObject, "Smth", -1);
	const randomSeed = descriptorNumber(gradientObject, "RndS", -1);
	const colorModel = MODERN_NOISE_GRADIENT_COLOR_MODELS[descriptorEnum(gradientObject, "ClrS")?.value ?? ""] ?? "unknown";
	const minimumRaw = descriptorNumberList(gradientObject, "Mnm ");
	const maximumRaw = descriptorNumberList(gradientObject, "Mxm ");
	const noiseRangesAreValid =
		minimumRaw.length === 4 &&
		maximumRaw.length === 4 &&
		minimumRaw.every(
			(value, index) => Number.isInteger(value) && value >= 0 && value <= 100 && Number.isInteger(maximumRaw[index]) && maximumRaw[index] >= value && maximumRaw[index] <= 100
		);
	const commonBakeSupported =
		style !== "unknown" &&
		(!angleValue || (angleValue.units === "#Ang" && Number.isFinite(angleValue.value))) &&
		(!scaleValue || scaleValue.units === "#Prc") &&
		Number.isFinite(scale) &&
		scale > 0 &&
		scale <= 1000 &&
		offsetsUsePercent;
	return {
		type,
		name: descriptorString(gradientObject, "Nm  "),
		style,
		interpolation,
		samples,
		angle: angleValue?.value ?? 0,
		angleUnits: angleValue?.units ?? "#Ang",
		scale,
		scaleUnits: scaleValue?.units ?? "#Prc",
		reverse: descriptorBoolean(object, "Rvrs", false),
		align: descriptorBoolean(object, "Algn", true),
		dither: descriptorBoolean(object, "Dthr", false),
		offsetX: horizontalOffset?.value ?? 0,
		offsetY: verticalOffset?.value ?? 0,
		offsetUnits: horizontalOffset?.units ?? verticalOffset?.units ?? "#Prc",
		colorStops,
		opacityStops,
		...(type === "noise"
			? {
					roughness: roughnessRaw / 4096,
					roughnessRaw,
					colorModel,
					randomSeed,
					restrictColors: descriptorBoolean(gradientObject, "VctC", false),
					addTransparency: descriptorBoolean(gradientObject, "ShTr", false),
					minimum: minimumRaw.map((value) => value / 100),
					maximum: maximumRaw.map((value) => value / 100),
					minimumRaw,
					maximumRaw,
					executionModel: "bounded-seeded-v1" as const,
				}
			: type === "solid"
				? { executionModel: "bounded-solid-v2" as const }
				: {}),
		bakeSupported:
			commonBakeSupported &&
			((type === "solid" &&
				interpolation !== "unknown" &&
				Number.isFinite(samples) &&
				Number.isInteger(samples) &&
				samples >= 1 &&
				samples <= 65536 &&
				colorStops.length >= 2 &&
				colorStops.length <= 64 &&
				opacityStops.length >= 1 &&
				opacityStops.length <= 64 &&
				locationsAreOrdered(colorStops) &&
				locationsAreOrdered(opacityStops) &&
				midpointsAreValid(colorStops) &&
				midpointsAreValid(opacityStops) &&
				colorStops.every((stop) => stop.color.rgba !== null) &&
				opacityStops.every((stop) => Number.isFinite(stop.opacity) && stop.opacity >= 0 && stop.opacity <= 100)) ||
				(type === "noise" &&
					Number.isInteger(roughnessRaw) &&
					roughnessRaw >= 0 &&
					roughnessRaw <= 4096 &&
					Number.isInteger(randomSeed) &&
					randomSeed >= -2147483648 &&
					randomSeed <= 2147483647 &&
					colorModel !== "unknown" &&
					noiseRangesAreValid)),
	};
}

function parseModernPattern(object: IPsdDescriptorObjectValue): IPsdLayerPatternInfo | null {
	const patternObject = descriptorObject(object, "Ptrn");
	if (!patternObject) {
		return null;
	}
	const scaleValue = descriptorUnit(object, "Scl ");
	const angleValue = descriptorUnit(object, "Angl");
	const phaseObject = descriptorObject(object, "phase");
	return {
		name: descriptorString(patternObject, "Nm  ").replace(/\0/g, ""),
		id: descriptorString(patternObject, "Idnt").replace(/\0/g, ""),
		scale: scaleValue?.value ?? 100,
		scaleUnits: scaleValue?.units ?? "#Prc",
		angle: angleValue?.value ?? 0,
		angleUnits: angleValue?.units ?? "#Ang",
		align: descriptorBoolean(object, "Algn", true),
		linked: descriptorBoolean(object, "Lnkd", true),
		phaseX: phaseObject ? descriptorNumber(phaseObject, "Hrzn", 0) : 0,
		phaseY: phaseObject ? descriptorNumber(phaseObject, "Vrtc", 0) : 0,
		resolutionStatus: "missing",
		resolvedPatternIndices: [],
		resolvedPatternIndex: null,
		resolvedPatternName: null,
		resolvedWidth: null,
		resolvedHeight: null,
		executionModel: "bounded-pattern-v1",
		bakeSupported: false,
	};
}

function patternDescriptorIsBounded(pattern: IPsdLayerPatternInfo): boolean {
	return (
		pattern.id.length > 0 &&
		pattern.id.length <= 1024 &&
		pattern.name.length <= 1024 &&
		pattern.scaleUnits === "#Prc" &&
		Number.isFinite(pattern.scale) &&
		pattern.scale > 0 &&
		pattern.scale <= 1000 &&
		pattern.angleUnits === "#Ang" &&
		Number.isFinite(pattern.angle) &&
		Number.isFinite(pattern.phaseX) &&
		Number.isFinite(pattern.phaseY) &&
		Math.abs(pattern.phaseX) <= 1_000_000 &&
		Math.abs(pattern.phaseY) <= 1_000_000
	);
}

function parseModernPatternOverlay(object: IPsdDescriptorObjectValue, index: number): IPsdLayerPatternOverlayEffectInfo | null {
	const pattern = parseModernPattern(object);
	if (!pattern) {
		return null;
	}
	const opacityValue = descriptorUnit(object, "Opct");
	const opacity = opacityValue?.value ?? 100;
	return {
		key: "patternFill",
		index,
		source: "lfx2",
		enabled: descriptorBoolean(object, "enab", false),
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		blendMode: MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "",
		opacity,
		pattern,
		bakeSupported: opacityValue?.units === "#Prc" && Number.isFinite(opacity) && opacity >= 0 && opacity <= 100 && patternDescriptorIsBounded(pattern),
	};
}

function parseModernSolidFill(object: IPsdDescriptorObjectValue, index: number): IPsdLayerSolidFillEffectInfo {
	const opacityValue = descriptorUnit(object, "Opct");
	const opacity = opacityValue?.value ?? 100;
	const color = parseModernDescriptorColor(descriptorObject(object, "Clr "));
	const blendMode = MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "";
	return {
		key: "sofi",
		index,
		version: 2,
		source: "lfx2",
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		enabled: descriptorBoolean(object, "enab", false),
		opacity,
		blendMode,
		color,
		nativeColor: color,
		bakeSupported: color.rgba !== null && blendMode !== "" && opacityValue?.units === "#Prc" && Number.isFinite(opacity) && opacity >= 0 && opacity <= 100,
	};
}

function parseModernShadow(object: IPsdDescriptorObjectValue, index: number, key: "isdw" | "dsdw"): IPsdLayerInnerShadowEffectInfo | IPsdLayerDropShadowEffectInfo {
	const blurValue = descriptorUnit(object, "blur");
	const distanceValue = descriptorUnit(object, "Dstn");
	const angleValue = descriptorUnit(object, "lagl");
	const opacityValue = descriptorUnit(object, "Opct");
	const chokeValue = descriptorUnit(object, "Ckmt");
	const noiseValue = descriptorUnit(object, "Nose");
	const blur = blurValue?.value ?? 0;
	const distance = distanceValue?.value ?? 0;
	const opacity = opacityValue?.value ?? 100;
	const choke = chokeValue?.value ?? 0;
	const noise = noiseValue?.value ?? 0;
	const contour = parseModernEffectContour(object);
	const color = parseModernDescriptorColor(descriptorObject(object, "Clr "));
	const blendMode = MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "";
	const common = {
		index,
		version: 2 as const,
		source: "lfx2" as const,
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		enabled: descriptorBoolean(object, "enab", false),
		blur,
		intensity: 100,
		angle: angleValue?.value ?? 0,
		distance,
		color,
		nativeColor: color,
		blendMode,
		useGlobalAngle: descriptorBoolean(object, "uglg", false),
		opacity,
		choke,
		antialiased: descriptorBoolean(object, "AntA", false),
		noise,
		contour,
		layerConceals: key === "dsdw" ? descriptorBoolean(object, "layerConceals", true) : undefined,
		executionModel: "bounded-shadow-v2" as const,
		bakeSupported:
			color.rgba !== null &&
			blendMode !== "" &&
			blurValue?.units === "#Pxl" &&
			distanceValue?.units === "#Pxl" &&
			angleValue?.units === "#Ang" &&
			opacityValue?.units === "#Prc" &&
			(!chokeValue || chokeValue.units === "#Pxl") &&
			(!noiseValue || noiseValue.units === "#Prc") &&
			Number.isFinite(blur) &&
			blur >= 0 &&
			blur <= 256 &&
			Number.isFinite(distance) &&
			distance >= 0 &&
			distance <= 32768 &&
			Number.isFinite(opacity) &&
			opacity >= 0 &&
			opacity <= 100 &&
			Number.isFinite(choke) &&
			choke >= 0 &&
			choke <= 256 &&
			Number.isFinite(noise) &&
			noise >= 0 &&
			noise <= 100 &&
			(contour === null || contour.valid),
	};
	return key === "isdw" ? { ...common, key } : { ...common, key };
}

function parseModernEffectContour(object: IPsdDescriptorObjectValue, key: "TrnS" | "MpgS" = "TrnS"): IPsdLayerEffectContourInfo | null {
	const contour = descriptorObject(object, key);
	if (!contour) {
		return null;
	}
	const points = descriptorObjectList(contour, "Crv ").map((point) => ({
		x: descriptorNumber(point, "Hrzn", Number.NaN),
		y: descriptorNumber(point, "Vrtc", Number.NaN),
	}));
	const linear =
		points.length === 2 &&
		points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) &&
		Math.abs(points[0].x) <= 1e-6 &&
		Math.abs(points[0].y) <= 1e-6 &&
		Math.abs(points[1].x - 255) <= 1e-6 &&
		Math.abs(points[1].y - 255) <= 1e-6;
	const valid =
		points.length >= 2 &&
		points.length <= 64 &&
		points.every(
			(point, index) =>
				Number.isFinite(point.x) &&
				Number.isFinite(point.y) &&
				point.x >= 0 &&
				point.x <= 255 &&
				point.y >= 0 &&
				point.y <= 255 &&
				(index === 0 || point.x >= points[index - 1].x)
		);
	return { name: descriptorString(contour, "Nm  "), points, linear, valid };
}

function parseModernGlow(object: IPsdDescriptorObjectValue, index: number, key: "iglw" | "oglw"): IPsdLayerInnerGlowEffectInfo | IPsdLayerOuterGlowEffectInfo {
	const blurValue = descriptorUnit(object, "blur");
	const opacityValue = descriptorUnit(object, "Opct");
	const chokeValue = descriptorUnit(object, "Ckmt");
	const noiseValue = descriptorUnit(object, "Nose");
	const rangeValue = descriptorUnit(object, "Inpr");
	const jitterValue = descriptorUnit(object, "ShdN");
	const blur = blurValue?.value ?? 0;
	const opacity = opacityValue?.value ?? 100;
	const choke = chokeValue?.value ?? 0;
	const noise = noiseValue?.value ?? 0;
	const range = rangeValue?.value ?? 50;
	const jitter = jitterValue?.value ?? 0;
	const color = parseModernDescriptorColor(descriptorObject(object, "Clr "));
	const blendMode = MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "";
	const glowSourceValue = descriptorEnum(object, "glwS")?.value;
	const glowSource: NonNullable<IPsdLayerInnerGlowEffectInfo["glowSource"]> =
		glowSourceValue === undefined || glowSourceValue === "SrcE" ? "edge" : glowSourceValue === "SrcC" ? "center" : "unknown";
	const techniqueValue = descriptorEnum(object, "GlwT")?.value;
	const technique: NonNullable<IPsdLayerInnerGlowEffectInfo["technique"]> =
		techniqueValue === undefined || techniqueValue === "SfBL" ? "softer" : techniqueValue === "PrBL" ? "precise" : "unknown";
	const contour = parseModernEffectContour(object);
	const common = {
		index,
		version: 2 as const,
		source: "lfx2" as const,
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		enabled: descriptorBoolean(object, "enab", false),
		blur,
		intensity: 100,
		color,
		nativeColor: color,
		blendMode,
		opacity,
		choke,
		antialiased: descriptorBoolean(object, "AntA", false),
		noise,
		range,
		jitter,
		glowSource,
		technique,
		contour,
		executionModel: "bounded-glow-v2" as const,
		bakeSupported:
			color.rgba !== null &&
			blendMode !== "" &&
			blurValue?.units === "#Pxl" &&
			opacityValue?.units === "#Prc" &&
			(!chokeValue || chokeValue.units === "#Pxl") &&
			(!noiseValue || noiseValue.units === "#Prc") &&
			(!rangeValue || rangeValue.units === "#Prc") &&
			(!jitterValue || jitterValue.units === "#Prc") &&
			Number.isFinite(blur) &&
			blur >= 0 &&
			blur <= 256 &&
			Number.isFinite(opacity) &&
			opacity >= 0 &&
			opacity <= 100 &&
			Number.isFinite(choke) &&
			choke >= 0 &&
			choke <= 256 &&
			Number.isFinite(noise) &&
			noise >= 0 &&
			noise <= 100 &&
			Number.isFinite(range) &&
			range >= 1 &&
			range <= 100 &&
			Number.isFinite(jitter) &&
			jitter >= 0 &&
			jitter <= 100 &&
			glowSource !== "unknown" &&
			(key === "iglw" || glowSource === "edge") &&
			technique !== "unknown" &&
			(contour === null || contour.valid),
	};
	return key === "iglw" ? { ...common, key, invert: false } : { ...common, key };
}

function parseModernBevel(object: IPsdDescriptorObjectValue, index: number): IPsdLayerBevelEffectInfo {
	const angleValue = descriptorUnit(object, "lagl");
	const altitudeValue = descriptorUnit(object, "Lald");
	const depthValue = descriptorUnit(object, "srgR");
	const sizeValue = descriptorUnit(object, "blur");
	const softenValue = descriptorUnit(object, "Sftn");
	const highlightOpacityValue = descriptorUnit(object, "hglO");
	const shadowOpacityValue = descriptorUnit(object, "sdwO");
	const size = sizeValue?.value ?? 0;
	const depth = depthValue?.value ?? 100;
	const soften = softenValue?.value ?? 0;
	const angle = angleValue?.value ?? 120;
	const altitude = altitudeValue?.value ?? 30;
	const highlightOpacity = highlightOpacityValue?.value ?? 75;
	const shadowOpacity = shadowOpacityValue?.value ?? 75;
	const highlightColor = parseModernDescriptorColor(descriptorObject(object, "hglC"));
	const shadowColor = parseModernDescriptorColor(descriptorObject(object, "sdwC"));
	const highlightBlendMode = MODERN_BLEND_MODES[descriptorEnum(object, "hglM")?.value ?? ""] ?? "";
	const shadowBlendMode = MODERN_BLEND_MODES[descriptorEnum(object, "sdwM")?.value ?? ""] ?? "";
	const styleValue = descriptorEnum(object, "bvlS")?.value;
	const style =
		styleValue === "OtrB"
			? 1
			: styleValue === undefined || styleValue === "InrB"
				? 2
				: styleValue === "Embs"
					? 3
					: styleValue === "PlEb"
						? 4
						: styleValue === "strokeEmboss"
							? 5
							: 0;
	const styleName = (["unknown", "outer bevel", "inner bevel", "emboss", "pillow emboss", "stroke emboss"] as const)[style] ?? "unknown";
	const techniqueValue = descriptorEnum(object, "bvlT")?.value;
	const technique: NonNullable<IPsdLayerBevelEffectInfo["technique"]> =
		techniqueValue === undefined || techniqueValue === "SfBL" ? "smooth" : techniqueValue === "PrBL" ? "chisel hard" : techniqueValue === "Slmt" ? "chisel soft" : "unknown";
	const directionValue = descriptorEnum(object, "bvlD")?.value;
	const direction = directionValue === "Out " ? 1 : directionValue === undefined || directionValue === "In  " ? 0 : -1;
	const useShape = descriptorBoolean(object, "useShape", false);
	const useTexture = descriptorBoolean(object, "useTexture", false);
	const contour = parseModernEffectContour(object);
	const shapeContour = parseModernEffectContour(object, "MpgS");
	const shapeRangeValue = descriptorUnit(object, "Inpr");
	const shapeRange = shapeRangeValue?.value ?? 50;
	const texturePattern = parseModernPattern(object);
	const textureDepthValue = descriptorUnit(object, "textureDepth");
	const textureDepth = textureDepthValue?.value ?? 100;
	return {
		key: "bevl",
		index,
		version: 2,
		source: "lfx2",
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		enabled: descriptorBoolean(object, "enab", false),
		angle,
		strength: Math.max(1, Math.round(size * (depth / 100))),
		blur: soften,
		size,
		depth,
		soften,
		altitude,
		highlightBlendMode,
		shadowBlendMode,
		highlightColor,
		shadowColor,
		realHighlightColor: highlightColor,
		realShadowColor: shadowColor,
		style,
		styleName,
		highlightOpacity,
		shadowOpacity,
		useGlobalAngle: descriptorBoolean(object, "uglg", false),
		direction,
		technique,
		useShape,
		useTexture,
		antialiasGloss: descriptorBoolean(object, "antialiasGloss", false),
		contour,
		shapeContour,
		shapeRange,
		shapeRangeUnits: shapeRangeValue?.units ?? "#Prc",
		texturePattern,
		textureDepth,
		textureDepthUnits: textureDepthValue?.units ?? "#Prc",
		textureInvert: descriptorBoolean(object, "Invr", false),
		executionModel: "bounded-bevel-v2",
		bakeSupported:
			highlightColor.rgba !== null &&
			shadowColor.rgba !== null &&
			highlightBlendMode !== "" &&
			shadowBlendMode !== "" &&
			angleValue?.units === "#Ang" &&
			altitudeValue?.units === "#Ang" &&
			depthValue?.units === "#Prc" &&
			sizeValue?.units === "#Pxl" &&
			(!softenValue || softenValue.units === "#Pxl") &&
			highlightOpacityValue?.units === "#Prc" &&
			shadowOpacityValue?.units === "#Prc" &&
			Number.isFinite(size) &&
			size >= 0 &&
			size <= 256 &&
			Number.isFinite(depth) &&
			depth >= 0 &&
			depth <= 1000 &&
			Number.isFinite(soften) &&
			soften >= 0 &&
			soften <= 256 &&
			Number.isFinite(angle) &&
			Number.isFinite(altitude) &&
			altitude >= 0 &&
			altitude <= 90 &&
			Number.isFinite(highlightOpacity) &&
			highlightOpacity >= 0 &&
			highlightOpacity <= 100 &&
			Number.isFinite(shadowOpacity) &&
			shadowOpacity >= 0 &&
			shadowOpacity <= 100 &&
			style >= 1 &&
			style <= 5 &&
			technique !== "unknown" &&
			direction >= 0 &&
			(contour === null || contour.valid) &&
			(!useShape ||
				(shapeContour !== null && shapeContour.valid && shapeRangeValue?.units === "#Prc" && Number.isFinite(shapeRange) && shapeRange >= 1 && shapeRange <= 100)) &&
			(!useTexture ||
				(texturePattern !== null &&
					patternDescriptorIsBounded(texturePattern) &&
					(!textureDepthValue || textureDepthValue.units === "#Prc") &&
					Number.isFinite(textureDepth) &&
					Math.abs(textureDepth) <= 1000)),
	};
}

function parseModernSatin(object: IPsdDescriptorObjectValue, index: number): IPsdLayerSatinEffectInfo {
	const opacityValue = descriptorUnit(object, "Opct");
	const angleValue = descriptorUnit(object, "lagl");
	const distanceValue = descriptorUnit(object, "Dstn");
	const sizeValue = descriptorUnit(object, "blur");
	const opacity = opacityValue?.value ?? 50;
	const angle = angleValue?.value ?? 19;
	const distance = distanceValue?.value ?? 0;
	const size = sizeValue?.value ?? 0;
	const color = parseModernDescriptorColor(descriptorObject(object, "Clr "));
	const blendMode = MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "";
	const contour = parseModernEffectContour(object, "MpgS");
	return {
		key: "ChFX",
		index,
		source: "lfx2",
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		enabled: descriptorBoolean(object, "enab", false),
		color,
		blendMode,
		opacity,
		angle,
		distance,
		size,
		antialiased: descriptorBoolean(object, "AntA", false),
		invert: descriptorBoolean(object, "Invr", false),
		contour,
		executionModel: "bounded-satin-v1",
		bakeSupported:
			color.rgba !== null &&
			blendMode !== "" &&
			opacityValue?.units === "#Prc" &&
			angleValue?.units === "#Ang" &&
			distanceValue?.units === "#Pxl" &&
			sizeValue?.units === "#Pxl" &&
			Number.isFinite(opacity) &&
			opacity >= 0 &&
			opacity <= 100 &&
			Number.isFinite(angle) &&
			Number.isFinite(distance) &&
			Math.abs(distance) <= 32768 &&
			Number.isFinite(size) &&
			size >= 0 &&
			size <= 256 &&
			(contour === null || contour.valid),
	};
}

function parseModernGradientOverlay(object: IPsdDescriptorObjectValue, index: number): IPsdLayerGradientOverlayEffectInfo | null {
	const gradient = parseModernGradient(object);
	if (!gradient) {
		return null;
	}
	const opacityValue = descriptorUnit(object, "Opct");
	const opacity = opacityValue?.value ?? 100;
	const blendMode = MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "";
	return {
		key: "GrFl",
		index,
		source: "lfx2",
		enabled: descriptorBoolean(object, "enab", false),
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		blendMode,
		opacity,
		gradient,
		bakeSupported: gradient.bakeSupported && blendMode !== "" && opacityValue?.units === "#Prc" && Number.isFinite(opacity) && opacity >= 0 && opacity <= 100,
	};
}

function parseModernStroke(object: IPsdDescriptorObjectValue, index: number): IPsdLayerStrokeEffectInfo {
	const positionValue = descriptorEnum(object, "Styl")?.value;
	const position = positionValue === "OutF" ? "outside" : positionValue === "CtrF" ? "center" : positionValue === "InsF" ? "inside" : "unknown";
	const fillValue = descriptorEnum(object, "PntT")?.value;
	const fillType = fillValue === "SClr" ? "solidColor" : fillValue === "GrFl" ? "gradient" : fillValue === "Ptrn" ? "pattern" : "unknown";
	const blendMode = MODERN_BLEND_MODES[descriptorEnum(object, "Md  ")?.value ?? ""] ?? "";
	const opacityValue = descriptorUnit(object, "Opct");
	const sizeValue = descriptorUnit(object, "Sz  ");
	const opacity = opacityValue?.value ?? 100;
	const size = sizeValue?.value ?? 0;
	const color = parseModernDescriptorColor(descriptorObject(object, "Clr "));
	const gradient = fillType === "gradient" ? parseModernGradient(object) : null;
	const pattern = fillType === "pattern" ? parseModernPattern(object) : null;
	return {
		key: "FrFX",
		index,
		source: "lfx2",
		enabled: descriptorBoolean(object, "enab", false),
		present: descriptorBoolean(object, "present", true),
		showInDialog: descriptorBoolean(object, "showInDialog", true),
		position,
		fillType,
		blendMode,
		opacity,
		size,
		sizeUnits: sizeValue?.units ?? "",
		color,
		gradient,
		pattern,
		bakeSupported:
			((fillType === "solidColor" && color.rgba !== null) ||
				(fillType === "gradient" && gradient?.bakeSupported === true) ||
				(fillType === "pattern" && pattern !== null && patternDescriptorIsBounded(pattern))) &&
			position !== "unknown" &&
			blendMode !== "" &&
			opacityValue?.units === "#Prc" &&
			sizeValue?.units === "#Pxl" &&
			Number.isFinite(opacity) &&
			opacity >= 0 &&
			opacity <= 100 &&
			Number.isFinite(size) &&
			size >= 0 &&
			size <= 256,
	};
}

function parseObjectLayerEffects(bytes: Uint8Array, offset: number, length: number, layerIndex: number, sourceTag: "lfx2" | "lmfx"): IPsdLayerEffectsInfo {
	const data = bytes.subarray(offset, offset + length);
	if (length < 8 || readUint32(data, 0, `layer ${layerIndex} lfx2 version`) !== 0 || readUint32(data, 4, `layer ${layerIndex} descriptor version`) !== 16) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceTag} must contain object-effects version 0 and descriptor version 16.`);
	}
	const cursor: IPsdDescriptorCursor = { offset: 8, end: length, items: 0 };
	const root = readPsdDescriptorObject(data, cursor, 0, `layer ${layerIndex} ${sourceTag}`);
	const trailingBytes = cursor.end - cursor.offset;
	const zeroAligned = trailingBytes >= 0 && trailingBytes <= 3 && data.subarray(cursor.offset, cursor.end).every((value) => value === 0);
	if (!zeroAligned) {
		throw new Error(`Malformed PSD: layer ${layerIndex} ${sourceTag} leaves ${cursor.end - cursor.offset} trailing descriptor byte(s).`);
	}
	const strokes: IPsdLayerStrokeEffectInfo[] = [];
	const innerShadows: IPsdLayerInnerShadowEffectInfo[] = [];
	const dropShadows: IPsdLayerDropShadowEffectInfo[] = [];
	const gradientOverlays: IPsdLayerGradientOverlayEffectInfo[] = [];
	const patternOverlays: IPsdLayerPatternOverlayEffectInfo[] = [];
	const solidFills: IPsdLayerSolidFillEffectInfo[] = [];
	const innerGlows: IPsdLayerInnerGlowEffectInfo[] = [];
	const outerGlows: IPsdLayerOuterGlowEffectInfo[] = [];
	const bevels: IPsdLayerBevelEffectInfo[] = [];
	const satins: IPsdLayerSatinEffectInfo[] = [];
	const parseSingleAndMultiple = <T extends IPsdModernLayerEffectDescriptorInfo>(
		singleKey: PsdModernLayerEffectDescriptorKey,
		multiKey: PsdModernLayerEffectDescriptorKey | null,
		target: T[],
		parse: (object: IPsdDescriptorObjectValue, index: number) => T | null
	): void => {
		const single = descriptorObject(root, singleKey);
		if (single) {
			const parsed = parse(single, target.length);
			if (parsed) {
				target.push({ ...parsed, descriptorKey: singleKey, descriptorListIndex: null });
			}
		}
		const multiple = multiKey ? descriptorEntry(root, multiKey) : null;
		if (multiKey && Array.isArray(multiple)) {
			for (const [descriptorListIndex, value] of multiple.entries()) {
				if (value && typeof value === "object" && !Array.isArray(value) && "entries" in value) {
					const parsed = parse(value as IPsdDescriptorObjectValue, target.length);
					if (parsed) {
						target.push({ ...parsed, descriptorKey: multiKey, descriptorListIndex });
					}
				}
			}
		}
	};
	parseSingleAndMultiple("SoFi", "solidFillMulti", solidFills, parseModernSolidFill);
	parseSingleAndMultiple("IrSh", "innerShadowMulti", innerShadows, (object, index) => parseModernShadow(object, index, "isdw") as IPsdLayerInnerShadowEffectInfo);
	parseSingleAndMultiple("DrSh", "dropShadowMulti", dropShadows, (object, index) => parseModernShadow(object, index, "dsdw") as IPsdLayerDropShadowEffectInfo);
	parseSingleAndMultiple("IrGl", null, innerGlows, (object, index) => parseModernGlow(object, index, "iglw") as IPsdLayerInnerGlowEffectInfo);
	parseSingleAndMultiple("OrGl", null, outerGlows, (object, index) => parseModernGlow(object, index, "oglw") as IPsdLayerOuterGlowEffectInfo);
	parseSingleAndMultiple("ebbl", null, bevels, parseModernBevel);
	parseSingleAndMultiple("ChFX", null, satins, parseModernSatin);
	parseSingleAndMultiple("GrFl", "gradientFillMulti", gradientOverlays, parseModernGradientOverlay);
	parseSingleAndMultiple("FrFX", "frameFXMulti", strokes, parseModernStroke);
	parseSingleAndMultiple("patternFill", null, patternOverlays, parseModernPatternOverlay);
	const rootOrder = new Map<string, number>();
	root.entries.forEach((entry, index) => {
		if (!rootOrder.has(entry.key)) {
			rootOrder.set(entry.key, index);
		}
	});
	const orderedEffects = [
		...innerShadows.map((effect) => ({
			effect,
			order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER,
			offset: effect.descriptorListIndex ?? 0,
		})),
		...dropShadows.map((effect) => ({
			effect,
			order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER,
			offset: effect.descriptorListIndex ?? 0,
		})),
		...innerGlows.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...outerGlows.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...bevels.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...satins.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...solidFills.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...gradientOverlays.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...strokes.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
		...patternOverlays.map((effect) => ({ effect, order: rootOrder.get(effect.descriptorKey!) ?? Number.MAX_SAFE_INTEGER, offset: effect.descriptorListIndex ?? 0 })),
	].sort((left, right) => left.order - right.order || left.offset - right.offset);
	orderedEffects.forEach((entry, index) => {
		entry.effect.index = index;
	});
	if (
		innerShadows.length +
			innerGlows.length +
			dropShadows.length +
			outerGlows.length +
			bevels.length +
			satins.length +
			solidFills.length +
			gradientOverlays.length +
			strokes.length +
			patternOverlays.length >
		MAXIMUM_PSD_LAYER_EFFECTS
	) {
		throw new Error(
			`Unsupported PSD layer effect count ${innerShadows.length + innerGlows.length + dropShadows.length + outerGlows.length + bevels.length + satins.length + solidFills.length + gradientOverlays.length + strokes.length + patternOverlays.length}; at most ${MAXIMUM_PSD_LAYER_EFFECTS} effects are inspected per layer.`
		);
	}
	const supportedRootKeys = new Set([
		"Scl ",
		"masterFXSwitch",
		"IrSh",
		"innerShadowMulti",
		"DrSh",
		"dropShadowMulti",
		"IrGl",
		"OrGl",
		"ebbl",
		"ChFX",
		"SoFi",
		"solidFillMulti",
		"GrFl",
		"gradientFillMulti",
		"FrFX",
		"frameFXMulti",
		"patternFill",
		"numModifyingFX",
	]);
	const unsupportedKeys = root.entries.map((entry) => entry.key).filter((key) => !supportedRootKeys.has(key));
	return {
		version: 0,
		visible: descriptorBoolean(root, "masterFXSwitch", true),
		effectCount:
			innerShadows.length +
			innerGlows.length +
			dropShadows.length +
			outerGlows.length +
			bevels.length +
			satins.length +
			solidFills.length +
			gradientOverlays.length +
			strokes.length +
			patternOverlays.length +
			unsupportedKeys.length,
		solidFills,
		innerShadows,
		innerGlows,
		dropShadows,
		outerGlows,
		bevels,
		satins,
		strokes,
		gradientOverlays,
		patternOverlays,
		unsupportedKeys,
		descriptorVersion: 16,
	};
}

function parseLayerEffects(bytes: Uint8Array, offset: number, length: number, layerIndex: number): IPsdLayerEffectsInfo {
	if (length < 4) {
		throw new Error(`Malformed PSD: layer ${layerIndex} lrFX data is shorter than its version and effect count.`);
	}
	const version = readUint16(bytes, offset, `layer ${layerIndex} effects version`);
	if (version !== 0) {
		throw new Error(`Unsupported PSD layer-effects version ${version}; bounded legacy lrFX version 0 is supported.`);
	}
	const effectCount = readUint16(bytes, offset + 2, `layer ${layerIndex} effect count`);
	if (effectCount > MAXIMUM_PSD_LAYER_EFFECTS) {
		throw new Error(`Unsupported PSD layer effect count ${effectCount}; at most ${MAXIMUM_PSD_LAYER_EFFECTS} effects are inspected per layer.`);
	}
	let cursor = offset + 4;
	const end = offset + length;
	let visible = true;
	const solidFills: IPsdLayerSolidFillEffectInfo[] = [];
	const innerShadows: IPsdLayerInnerShadowEffectInfo[] = [];
	const innerGlows: IPsdLayerInnerGlowEffectInfo[] = [];
	const dropShadows: IPsdLayerDropShadowEffectInfo[] = [];
	const outerGlows: IPsdLayerOuterGlowEffectInfo[] = [];
	const bevels: IPsdLayerBevelEffectInfo[] = [];
	const satins: IPsdLayerSatinEffectInfo[] = [];
	const strokes: IPsdLayerStrokeEffectInfo[] = [];
	const gradientOverlays: IPsdLayerGradientOverlayEffectInfo[] = [];
	const patternOverlays: IPsdLayerPatternOverlayEffectInfo[] = [];
	const unsupportedKeys: string[] = [];
	for (let effectIndex = 0; effectIndex < effectCount; ++effectIndex) {
		assertRange(bytes, cursor, 12, `layer ${layerIndex} effect ${effectIndex} header`);
		if (readAscii(bytes, cursor, 4, `layer ${layerIndex} effect ${effectIndex} signature`) !== "8BIM") {
			throw new Error(`Malformed PSD: layer ${layerIndex} effect ${effectIndex} has an invalid signature.`);
		}
		const key = readAscii(bytes, cursor + 4, 4, `layer ${layerIndex} effect ${effectIndex} key`);
		const size = readUint32(bytes, cursor + 8, `layer ${layerIndex} effect ${effectIndex} size`);
		const dataOffset = cursor + 12;
		assertRange(bytes, dataOffset, size, `layer ${layerIndex} effect ${effectIndex} ${key} data`);
		if (dataOffset + size > end) {
			throw new Error(`Malformed PSD: layer ${layerIndex} effect ${effectIndex} ${key} exceeds its lrFX block.`);
		}
		if (key === "cmnS") {
			if (size !== 7 || readUint32(bytes, dataOffset, `layer ${layerIndex} common effect version`) !== 0) {
				throw new Error(`Malformed PSD: layer ${layerIndex} cmnS effect must be the 7-byte version-0 record.`);
			}
			visible = bytes[dataOffset + 4] !== 0;
		} else if (key === "sofi") {
			if (size !== 34 || readUint32(bytes, dataOffset, `layer ${layerIndex} solid-fill effect version`) !== 2) {
				throw new Error(`Malformed PSD: layer ${layerIndex} sofi effect must be the 34-byte version-2 record.`);
			}
			if (readAscii(bytes, dataOffset + 4, 4, `layer ${layerIndex} solid-fill blend signature`) !== "8BIM") {
				throw new Error(`Malformed PSD: layer ${layerIndex} sofi effect has an invalid blend-mode signature.`);
			}
			const color = parseEffectColor(bytes, dataOffset + 12, `layer ${layerIndex} solid-fill`);
			const nativeColor = parseEffectColor(bytes, dataOffset + 24, `layer ${layerIndex} solid-fill native`);
			solidFills.push({
				key: "sofi",
				index: effectIndex,
				version: 2,
				enabled: bytes[dataOffset + 23] !== 0,
				opacity: bytes[dataOffset + 22],
				blendMode: readAscii(bytes, dataOffset + 8, 4, `layer ${layerIndex} solid-fill blend mode`),
				color,
				nativeColor,
				bakeSupported: color.rgba !== null,
			});
		} else if (key === "isdw" || key === "dsdw") {
			const effectLabel = key === "isdw" ? "inner-shadow" : "drop-shadow";
			const effectVersion = readUint32(bytes, dataOffset, `layer ${layerIndex} ${effectLabel} effect version`);
			if ((effectVersion !== 0 && effectVersion !== 2) || size !== (effectVersion === 0 ? 41 : 51)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} ${key} effect must be a 41-byte version-0 or 51-byte version-2 record.`);
			}
			if (readAscii(bytes, dataOffset + 30, 4, `layer ${layerIndex} ${effectLabel} blend signature`) !== "8BIM") {
				throw new Error(`Malformed PSD: layer ${layerIndex} ${key} effect has an invalid blend-mode signature.`);
			}
			const color = parseEffectColor(bytes, dataOffset + 20, `layer ${layerIndex} ${effectLabel}`);
			const blur = readUint32(bytes, dataOffset + 4, `layer ${layerIndex} ${effectLabel} blur`);
			const intensity = readUint32(bytes, dataOffset + 8, `layer ${layerIndex} ${effectLabel} intensity`);
			const distance = readUint32(bytes, dataOffset + 16, `layer ${layerIndex} ${effectLabel} distance`);
			const opacity = bytes[dataOffset + 40];
			const parsedVersion = effectVersion as 0 | 2;
			const shadow = {
				index: effectIndex,
				version: parsedVersion,
				enabled: bytes[dataOffset + 38] !== 0,
				blur,
				intensity,
				angle: readInt32(bytes, dataOffset + 12, `layer ${layerIndex} ${effectLabel} angle`),
				distance,
				color,
				nativeColor: effectVersion === 2 ? parseEffectColor(bytes, dataOffset + 41, `layer ${layerIndex} ${effectLabel} native`) : null,
				blendMode: readAscii(bytes, dataOffset + 34, 4, `layer ${layerIndex} ${effectLabel} blend mode`),
				useGlobalAngle: bytes[dataOffset + 39] !== 0,
				opacity,
				bakeSupported: color.rgba !== null && blur <= 256 && intensity <= 100 && distance <= 32768 && opacity <= 100,
			};
			if (key === "isdw") {
				innerShadows.push({ ...shadow, key: "isdw" });
			} else {
				dropShadows.push({ ...shadow, key: "dsdw" });
			}
		} else if (key === "iglw" || key === "oglw") {
			const effectLabel = key === "iglw" ? "inner-glow" : "outer-glow";
			const effectVersion = readUint32(bytes, dataOffset, `layer ${layerIndex} ${effectLabel} effect version`);
			const expectedSize = key === "iglw" ? (effectVersion === 0 ? 33 : 43) : effectVersion === 0 ? 32 : 42;
			if ((effectVersion !== 0 && effectVersion !== 2) || size !== expectedSize) {
				throw new Error(
					`Malformed PSD: layer ${layerIndex} ${key} effect must be a ${key === "iglw" ? "33" : "32"}-byte version-0 or ${key === "iglw" ? "43" : "42"}-byte version-2 record.`
				);
			}
			const parsedVersion = effectVersion as 0 | 2;
			if (readAscii(bytes, dataOffset + 22, 4, `layer ${layerIndex} ${effectLabel} blend signature`) !== "8BIM") {
				throw new Error(`Malformed PSD: layer ${layerIndex} ${key} effect has an invalid blend-mode signature.`);
			}
			const color = parseEffectColor(bytes, dataOffset + 12, `layer ${layerIndex} ${effectLabel}`);
			const blur = readUint32(bytes, dataOffset + 4, `layer ${layerIndex} ${effectLabel} blur`);
			const intensity = readUint32(bytes, dataOffset + 8, `layer ${layerIndex} ${effectLabel} intensity`);
			const opacity = bytes[dataOffset + 31];
			const glow = {
				key,
				index: effectIndex,
				version: parsedVersion,
				enabled: bytes[dataOffset + 30] !== 0,
				blur,
				intensity,
				color,
				nativeColor: effectVersion === 2 ? parseEffectColor(bytes, dataOffset + (key === "iglw" ? 33 : 32), `layer ${layerIndex} ${effectLabel} native`) : null,
				blendMode: readAscii(bytes, dataOffset + 26, 4, `layer ${layerIndex} ${effectLabel} blend mode`),
				opacity,
				bakeSupported: color.rgba !== null && blur <= 256 && intensity <= 100 && opacity <= 100,
			};
			if (key === "iglw") {
				innerGlows.push({ ...glow, key, invert: effectVersion === 2 && bytes[dataOffset + 32] !== 0 });
			} else {
				outerGlows.push({ ...glow, key });
			}
		} else if (key === "bevl") {
			const effectVersion = readUint32(bytes, dataOffset, `layer ${layerIndex} bevel effect version`);
			if ((effectVersion !== 0 && effectVersion !== 2) || size !== (effectVersion === 0 ? 58 : 78)) {
				throw new Error(`Malformed PSD: layer ${layerIndex} bevl effect must be a 58-byte version-0 or 78-byte version-2 record.`);
			}
			if (
				readAscii(bytes, dataOffset + 16, 4, `layer ${layerIndex} bevel highlight blend signature`) !== "8BIM" ||
				readAscii(bytes, dataOffset + 24, 4, `layer ${layerIndex} bevel shadow blend signature`) !== "8BIM"
			) {
				throw new Error(`Malformed PSD: layer ${layerIndex} bevl effect has an invalid blend-mode signature.`);
			}
			const parsedVersion = effectVersion as 0 | 2;
			const highlightColor = parseEffectColor(bytes, dataOffset + 32, `layer ${layerIndex} bevel highlight`);
			const shadowColor = parseEffectColor(bytes, dataOffset + 42, `layer ${layerIndex} bevel shadow`);
			const strength = readUint32(bytes, dataOffset + 8, `layer ${layerIndex} bevel strength`);
			const blur = readUint32(bytes, dataOffset + 12, `layer ${layerIndex} bevel blur`);
			const style = bytes[dataOffset + 52];
			const styleName = ["unknown", "outer bevel", "inner bevel", "emboss", "pillow emboss", "stroke emboss"][style] as PsdLegacyBevelStyle | undefined;
			const highlightOpacity = bytes[dataOffset + 53];
			const shadowOpacity = bytes[dataOffset + 54];
			const direction = bytes[dataOffset + 57];
			bevels.push({
				key: "bevl",
				index: effectIndex,
				version: parsedVersion,
				enabled: bytes[dataOffset + 55] !== 0,
				angle: readInt32(bytes, dataOffset + 4, `layer ${layerIndex} bevel angle`),
				strength,
				blur,
				highlightBlendMode: readAscii(bytes, dataOffset + 20, 4, `layer ${layerIndex} bevel highlight blend mode`),
				shadowBlendMode: readAscii(bytes, dataOffset + 28, 4, `layer ${layerIndex} bevel shadow blend mode`),
				highlightColor,
				shadowColor,
				realHighlightColor: parsedVersion === 2 ? parseEffectColor(bytes, dataOffset + 58, `layer ${layerIndex} bevel real highlight`) : null,
				realShadowColor: parsedVersion === 2 ? parseEffectColor(bytes, dataOffset + 68, `layer ${layerIndex} bevel real shadow`) : null,
				style,
				styleName: styleName ?? "unknown",
				highlightOpacity,
				shadowOpacity,
				useGlobalAngle: bytes[dataOffset + 56] !== 0,
				direction,
				bakeSupported:
					highlightColor.rgba !== null &&
					shadowColor.rgba !== null &&
					strength <= 32768 &&
					blur <= 256 &&
					style >= 1 &&
					style <= 5 &&
					highlightOpacity <= 100 &&
					shadowOpacity <= 100 &&
					direction <= 1,
			});
		} else {
			unsupportedKeys.push(key);
		}
		cursor = dataOffset + size;
	}
	const trailingBytes = end - cursor;
	const zeroAligned = trailingBytes >= 0 && trailingBytes <= 3 && bytes.subarray(cursor, end).every((value) => value === 0);
	if (!zeroAligned) {
		throw new Error(`Malformed PSD: layer ${layerIndex} lrFX declares ${effectCount} effects but leaves ${end - cursor} trailing byte(s).`);
	}
	return {
		version: 0,
		visible,
		effectCount,
		solidFills,
		innerShadows,
		innerGlows,
		dropShadows,
		outerGlows,
		bevels,
		satins,
		strokes,
		gradientOverlays,
		patternOverlays,
		unsupportedKeys,
	};
}

function parseEmbeddedPattern(
	bytes: Uint8Array,
	offset: number,
	blockEnd: number,
	sourceTag: "Patt" | "Pat2" | "Pat3",
	index: number
): { pattern: IParsedPsdPattern; nextOffset: number } {
	const declaredLength = readUint32(bytes, offset, `${sourceTag} pattern ${index} length`);
	const dataOffset = offset + 4;
	assertRange(bytes, dataOffset, declaredLength, `${sourceTag} pattern ${index}`);
	const end = dataOffset + declaredLength;
	const nextOffset = dataOffset + Math.ceil(declaredLength / 4) * 4;
	if (nextOffset > blockEnd || declaredLength < 20) {
		throw new Error(`Malformed PSD: ${sourceTag} pattern ${index} exceeds its tagged block or is too short.`);
	}
	let cursor = dataOffset;
	const version = readUint32(bytes, cursor, `${sourceTag} pattern ${index} version`);
	cursor += 4;
	if (version !== 1) {
		throw new Error(`Unsupported PSD ${sourceTag} pattern version ${version}; version 1 is required.`);
	}
	const colorModeValue = readUint32(bytes, cursor, `${sourceTag} pattern ${index} color mode`);
	cursor += 4;
	const colorMode: PsdPatternColorMode = colorModeValue === 1 ? "grayscale" : colorModeValue === 2 ? "indexed" : colorModeValue === 3 ? "rgb" : "unknown";
	const x = readInt16(bytes, cursor, `${sourceTag} pattern ${index} x`);
	const y = readInt16(bytes, cursor + 2, `${sourceTag} pattern ${index} y`);
	cursor += 4;
	const nameCharacters = readUint32(bytes, cursor, `${sourceTag} pattern ${index} name length`);
	cursor += 4;
	if (nameCharacters > 1024 || cursor + nameCharacters * 2 > end) {
		throw new Error(`Unsupported PSD: ${sourceTag} pattern ${index} name exceeds 1024 characters or its record.`);
	}
	let name = "";
	for (let character = 0; character < nameCharacters; ++character) {
		name += String.fromCharCode(readUint16(bytes, cursor + character * 2, `${sourceTag} pattern ${index} name`));
	}
	cursor += nameCharacters * 2;
	assertRange(bytes, cursor, 1, `${sourceTag} pattern ${index} identifier length`);
	const idLength = bytes[cursor++];
	if (idLength > 255 || cursor + idLength > end) {
		throw new Error(`Malformed PSD: ${sourceTag} pattern ${index} identifier exceeds its record.`);
	}
	const id = readAscii(bytes, cursor, idLength, `${sourceTag} pattern ${index} identifier`).replace(/\0/g, "");
	cursor += idLength;
	const palette: Array<[number, number, number]> = [];
	if (colorMode === "indexed") {
		assertRange(bytes, cursor, 772, `${sourceTag} pattern ${index} indexed palette`);
		for (let entry = 0; entry < 256; ++entry) {
			palette.push([bytes[cursor + entry * 3], bytes[cursor + entry * 3 + 1], bytes[cursor + entry * 3 + 2]]);
		}
		cursor += 772;
	}
	const arrayVersion = readUint32(bytes, cursor, `${sourceTag} pattern ${index} virtual-memory version`);
	cursor += 4;
	if (arrayVersion !== 3) {
		throw new Error(`Unsupported PSD ${sourceTag} pattern virtual-memory version ${arrayVersion}; version 3 is required.`);
	}
	const arrayLength = readUint32(bytes, cursor, `${sourceTag} pattern ${index} virtual-memory length`);
	cursor += 4;
	const arrayEnd = cursor + arrayLength;
	if (arrayEnd > end || arrayLength < 20) {
		throw new Error(`Malformed PSD: ${sourceTag} pattern ${index} virtual-memory array exceeds its record.`);
	}
	const top = readUint32(bytes, cursor, `${sourceTag} pattern ${index} top`);
	const left = readUint32(bytes, cursor + 4, `${sourceTag} pattern ${index} left`);
	const bottom = readUint32(bytes, cursor + 8, `${sourceTag} pattern ${index} bottom`);
	const right = readUint32(bytes, cursor + 12, `${sourceTag} pattern ${index} right`);
	const declaredChannelCount = readUint32(bytes, cursor + 16, `${sourceTag} pattern ${index} channel count`);
	cursor += 20;
	if (declaredChannelCount > MAXIMUM_PSD_PATTERN_CHANNELS - 2) {
		throw new Error(`Unsupported PSD pattern channel count ${declaredChannelCount}; at most ${MAXIMUM_PSD_PATTERN_CHANNELS - 2} declared channels are allowed.`);
	}
	const width = right - left;
	const height = bottom - top;
	const dimensionsAreValid =
		right >= left &&
		bottom >= top &&
		width > 0 &&
		height > 0 &&
		width <= MAXIMUM_PSD_PATTERN_DIMENSION &&
		height <= MAXIMUM_PSD_PATTERN_DIMENSION &&
		width * height <= MAXIMUM_PSD_PATTERN_PIXELS;
	const channels: IParsedPsdPatternChannel[] = [];
	for (let slot = 0; slot < declaredChannelCount + 2; ++slot) {
		assertRange(bytes, cursor, 4, `${sourceTag} pattern ${index} channel ${slot} presence`);
		const isWritten = readUint32(bytes, cursor, `${sourceTag} pattern ${index} channel ${slot} presence`) !== 0;
		cursor += 4;
		if (!isWritten) {
			continue;
		}
		const length = readUint32(bytes, cursor, `${sourceTag} pattern ${index} channel ${slot} length`);
		cursor += 4;
		if (length === 0) {
			continue;
		}
		if (length < 23 || cursor + length > arrayEnd) {
			throw new Error(`Malformed PSD: ${sourceTag} pattern ${index} channel ${slot} exceeds its virtual-memory array.`);
		}
		const depth = readUint32(bytes, cursor, `${sourceTag} pattern ${index} channel ${slot} depth`);
		const channelTop = readUint32(bytes, cursor + 4, `${sourceTag} pattern ${index} channel ${slot} top`);
		const channelLeft = readUint32(bytes, cursor + 8, `${sourceTag} pattern ${index} channel ${slot} left`);
		const channelBottom = readUint32(bytes, cursor + 12, `${sourceTag} pattern ${index} channel ${slot} bottom`);
		const channelRight = readUint32(bytes, cursor + 16, `${sourceTag} pattern ${index} channel ${slot} right`);
		const pixelDepth = readUint16(bytes, cursor + 20, `${sourceTag} pattern ${index} channel ${slot} pixel depth`);
		const compression = layerCompression(bytes[cursor + 22]);
		const channelWidth = channelRight - channelLeft;
		const channelHeight = channelBottom - channelTop;
		channels.push({
			index: channels.length,
			width: channelWidth,
			height: channelHeight,
			left: channelLeft - left,
			top: channelTop - top,
			depth,
			pixelDepth,
			compression,
			dataOffset: cursor + 23,
			dataLength: length - 23,
		});
		cursor += length;
	}
	if (cursor !== arrayEnd) {
		throw new Error(`Malformed PSD: ${sourceTag} pattern ${index} virtual-memory array leaves ${arrayEnd - cursor} byte(s).`);
	}
	const requiredColorChannels = colorMode === "rgb" ? 3 : colorMode === "grayscale" || colorMode === "indexed" ? 1 : Number.POSITIVE_INFINITY;
	const warnings: string[] = [];
	if (!dimensionsAreValid) {
		warnings.push("Pattern dimensions exceed the bounded 16,384-side or 16,777,216-pixel limits.");
	}
	if (colorMode === "unknown") {
		warnings.push(`Pattern color mode ${colorModeValue} is unsupported; RGB, Grayscale, and Indexed are supported.`);
	}
	if (channels.length < requiredColorChannels) {
		warnings.push(`Pattern has ${channels.length} written channel(s), but ${requiredColorChannels} color channel(s) are required.`);
	}
	if (
		channels.some(
			(channel) =>
				(channel.depth !== 8 && channel.depth !== 16 && channel.depth !== 32) ||
				channel.pixelDepth !== channel.depth ||
				channel.compression === "unsupported" ||
				channel.width < 0 ||
				channel.height < 0 ||
				channel.left < 0 ||
				channel.top < 0 ||
				channel.left + channel.width > width ||
				channel.top + channel.height > height
		)
	) {
		warnings.push("One or more pattern channels use unsupported depth/compression or exceed the pattern bounds.");
	}
	if (colorMode === "indexed" && channels.some((channel) => channel.depth === 32)) {
		warnings.push("Indexed embedded patterns cannot use 32-bit floating-point channel indices.");
	}
	const publicPattern: IPsdEmbeddedPatternInfo = {
		index,
		sourceTag,
		name: name.replace(/\0/g, ""),
		id,
		x,
		y,
		left,
		top,
		width,
		height,
		colorMode,
		channelCount: channels.length,
		compressions: channels.map((channel) => channel.compression),
		bakeSupported: id.length > 0 && id.length <= 1024 && warnings.length === 0,
		warnings,
	};
	return { pattern: { ...publicPattern, palette, channels }, nextOffset };
}

function readBoundedLinkedUnicode(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): string {
	const value = readDescriptorUnicode(bytes, cursor, label);
	if (value.length > MAXIMUM_PSD_SMART_OBJECT_STRING_CHARACTERS) {
		throw new Error(`Unsupported PSD: ${label} exceeds ${MAXIMUM_PSD_SMART_OBJECT_STRING_CHARACTERS.toLocaleString()} characters.`);
	}
	return value;
}

function readLinkedDescriptor(bytes: Uint8Array, cursor: IPsdDescriptorCursor, label: string): IPsdDescriptorObjectValue {
	const version = readUint32(bytes, cursor.offset, `${label} version`);
	cursor.offset += 4;
	if (version !== 16) {
		throw new Error(`Unsupported PSD: ${label} descriptor version ${version}; version 16 is required.`);
	}
	return readPsdDescriptorObject(bytes, cursor, 0, label);
}

function boundedLinkedDescriptorString(object: IPsdDescriptorObjectValue, key: string, label: string): string {
	const value = descriptorString(object, key);
	if (value.length > MAXIMUM_PSD_SMART_OBJECT_STRING_CHARACTERS) {
		throw new Error(`Unsupported PSD: ${label} exceeds ${MAXIMUM_PSD_SMART_OBJECT_STRING_CHARACTERS.toLocaleString()} characters.`);
	}
	return value;
}

function parsePsdSmartObjectResources(
	bytes: Uint8Array,
	options: {
		dataOffset: number;
		dataEnd: number;
		tagLengthOffset: number;
		sourceKey: IPsdSmartObjectResourceInfo["sourceKey"];
		startIndex: number;
		initialPayloadBytes: number;
	}
): { resources: IParsedPsdSmartObjectResource[]; payloadBytes: number } {
	const { dataOffset, dataEnd, tagLengthOffset, sourceKey, startIndex, initialPayloadBytes } = options;
	const resources: IParsedPsdSmartObjectResource[] = [];
	let payloadBytes = initialPayloadBytes;
	let cursorOffset = dataOffset;
	while (cursorOffset + 8 <= dataEnd) {
		if (bytes.subarray(cursorOffset, dataEnd).every((value) => value === 0)) {
			cursorOffset = dataEnd;
			break;
		}
		if (startIndex + resources.length >= MAXIMUM_PSD_SMART_OBJECT_RESOURCES) {
			throw new Error(`Unsupported PSD smart-object linked-resource count; at most ${MAXIMUM_PSD_SMART_OBJECT_RESOURCES.toLocaleString()} records can be inspected.`);
		}
		const recordSize = readUint64(bytes, cursorOffset, `${sourceKey} linked-resource record size`);
		const recordOffset = cursorOffset + 8;
		const recordEnd = recordOffset + recordSize;
		assertRange(bytes, recordOffset, recordSize, `${sourceKey} linked-resource record`);
		if (recordEnd > dataEnd) {
			throw new Error(`Malformed PSD: ${sourceKey} linked-resource record exceeds its tagged block.`);
		}
		const cursor: IPsdDescriptorCursor = { offset: recordOffset, end: recordEnd, items: 0 };
		const recordSignature = readAscii(bytes, cursor.offset, 4, `${sourceKey} linked-resource signature`);
		cursor.offset += 4;
		if (recordSignature !== "liFD" && recordSignature !== "liFE" && recordSignature !== "liFA") {
			throw new Error(`Unsupported PSD: ${sourceKey} linked-resource signature ${JSON.stringify(recordSignature)} is not liFD, liFE, or liFA.`);
		}
		const version = readInt32(bytes, cursor.offset, `${sourceKey} linked-resource version`);
		cursor.offset += 4;
		if (version < 1 || version > 7) {
			throw new Error(`Unsupported PSD: ${sourceKey} linked-resource version ${version}; versions 1-7 are supported.`);
		}
		assertRange(bytes, cursor.offset, 1, `${sourceKey} linked-resource id length`);
		const idLength = bytes[cursor.offset++];
		const id = readAscii(bytes, cursor.offset, idLength, `${sourceKey} linked-resource id`).replace(/\0/g, "");
		cursor.offset += idLength;
		const name = readBoundedLinkedUnicode(bytes, cursor, `${sourceKey} linked-resource name`);
		const fileType = readAscii(bytes, cursor.offset, 4, `${sourceKey} linked-resource file type`).replace(/\0/g, "").trim();
		cursor.offset += 4;
		const creator = readAscii(bytes, cursor.offset, 4, `${sourceKey} linked-resource creator`).replace(/\0/g, "").trim();
		cursor.offset += 4;
		const declaredDataSizeOffset = cursor.offset;
		const declaredDataBytes = readUint64(bytes, cursor.offset, `${sourceKey} linked-resource data size`);
		cursor.offset += 8;
		assertRange(bytes, cursor.offset, 1, `${sourceKey} linked-resource descriptor flag`);
		const descriptorPresent = bytes[cursor.offset++] !== 0;
		if (descriptorPresent) {
			readLinkedDescriptor(bytes, cursor, `${sourceKey} linked-resource file-open descriptor`);
		}
		const externalDescriptor = recordSignature === "liFE" ? readLinkedDescriptor(bytes, cursor, `${sourceKey} external-link descriptor`) : null;
		let time: string | null = null;
		const version3TimestampCompatibility = recordSignature === "liFE" && version === 3 && recordEnd - cursor.offset === 24;
		if (recordSignature === "liFE" && (version > 3 || version3TimestampCompatibility)) {
			const year = readInt32(bytes, cursor.offset, `${sourceKey} external-link year`);
			assertRange(bytes, cursor.offset + 4, 4, `${sourceKey} external-link date`);
			const month = bytes[cursor.offset + 4];
			const day = bytes[cursor.offset + 5];
			const hour = bytes[cursor.offset + 6];
			const minute = bytes[cursor.offset + 7];
			const seconds = readDescriptorFloat64(bytes, { ...cursor, offset: cursor.offset + 8 }, `${sourceKey} external-link seconds`);
			cursor.offset += 16;
			const timestamp = Date.UTC(year, month, day, hour, minute, Math.floor(seconds), Math.round((seconds % 1) * 1000));
			if (
				year >= 0 &&
				year <= 9999 &&
				month <= 11 &&
				day >= 1 &&
				day <= 31 &&
				hour <= 23 &&
				minute <= 59 &&
				Number.isFinite(seconds) &&
				seconds >= 0 &&
				seconds < 61 &&
				Number.isFinite(timestamp)
			) {
				time = new Date(timestamp).toISOString();
			}
		}
		let externalFileSize = 0;
		if (recordSignature === "liFE") {
			externalFileSize = readUint64(bytes, cursor.offset, `${sourceKey} external-link file size`);
			cursor.offset += 8;
		}
		if (recordSignature === "liFA") {
			assertRange(bytes, cursor.offset, 8, `${sourceKey} alias payload`);
			cursor.offset += 8;
		}
		let dataOffsetInSource: number | null = null;
		let dataBytes = 0;
		if (recordSignature === "liFD") {
			dataOffsetInSource = cursor.offset;
			dataBytes = declaredDataBytes;
			assertRange(bytes, cursor.offset, dataBytes, `${sourceKey} embedded linked-resource payload`);
			cursor.offset += dataBytes;
			payloadBytes += dataBytes;
			if (payloadBytes > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
				throw new Error(`Unsupported PSD embedded smart-object payload total; at most ${MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES / 1024 / 1024} MiB can be inspected.`);
			}
		}
		const childDocumentId = version >= 5 ? readBoundedLinkedUnicode(bytes, cursor, `${sourceKey} child document id`) : null;
		let assetModTime: number | null = null;
		if (version >= 6) {
			assetModTime = readDescriptorFloat64(bytes, cursor, `${sourceKey} asset modification time`);
			if (!Number.isFinite(assetModTime)) {
				throw new Error(`Malformed PSD: ${sourceKey} asset modification time is not finite.`);
			}
		}
		let assetLockedState: number | null = null;
		if (version >= 7) {
			assertRange(bytes, cursor.offset, 1, `${sourceKey} asset locked state`);
			assetLockedState = bytes[cursor.offset++];
		}
		if (recordSignature === "liFE" && version === 2 && externalFileSize > 0) {
			assertRange(bytes, cursor.offset, externalFileSize, `${sourceKey} version-2 external cached payload`);
			cursor.offset += externalFileSize;
		}
		if (cursor.offset !== recordEnd) {
			throw new Error(`Malformed PSD: ${sourceKey} linked-resource record leaves ${recordEnd - cursor.offset} unexpected byte(s).`);
		}
		const type = recordSignature === "liFD" ? "embedded" : recordSignature === "liFE" ? "external" : "alias";
		const warnings =
			type === "embedded"
				? []
				: [
						type === "external"
							? "External smart-object paths are preserved as evidence but are never resolved, read, or copied automatically."
							: "Smart-object alias metadata is preserved as evidence but cannot be published as an embedded payload.",
					];
		if (version3TimestampCompatibility) {
			warnings.push("Version-3 external-link timestamp uses the bounded ag-psd compatibility form.");
		}
		const paddedRecordEnd = recordOffset + Math.ceil(recordSize / 4) * 4;
		resources.push({
			index: startIndex + resources.length,
			sourceKey,
			recordSignature,
			type,
			version,
			id,
			name,
			fileType,
			creator,
			descriptorPresent,
			dataBytes,
			payloadAvailable: type === "embedded",
			external: externalDescriptor
				? {
						fileSize: externalFileSize,
						name: boundedLinkedDescriptorString(externalDescriptor, "Nm  ", `${sourceKey} external name`),
						fullPath: boundedLinkedDescriptorString(externalDescriptor, "fullPath", `${sourceKey} full path`),
						originalPath: boundedLinkedDescriptorString(externalDescriptor, "originalPath", `${sourceKey} original path`),
						relativePath: boundedLinkedDescriptorString(externalDescriptor, "relPath", `${sourceKey} relative path`),
						time,
					}
				: null,
			childDocumentId,
			assetModTime,
			assetLockedState,
			executionModel: "bounded-smart-object-link-v1",
			warnings,
			dataOffset: dataOffsetInSource,
			declaredDataSizeOffset,
			recordSizeOffset: cursorOffset,
			recordOffset,
			recordEnd,
			paddedRecordEnd,
			tagLengthOffset,
			tagDataBytes: dataEnd - dataOffset,
		});
		if (paddedRecordEnd > dataEnd || bytes.subarray(recordEnd, paddedRecordEnd).some((value) => value !== 0)) {
			throw new Error(`Malformed PSD: ${sourceKey} linked-resource record padding is invalid.`);
		}
		cursorOffset = paddedRecordEnd;
	}
	if (cursorOffset !== dataEnd && bytes.subarray(cursorOffset, dataEnd).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: ${sourceKey} tagged block leaves ${dataEnd - cursorOffset} unexpected byte(s).`);
	}
	return { resources, payloadBytes };
}

function parsePsdSmartFilterMasks(bytes: Uint8Array, dataOffset: number, dataEnd: number, sourceKey: "FEid" | "FXid"): IParsedPsdSmartFilterMask[] {
	if (dataEnd - dataOffset < 4) {
		throw new Error(`Malformed PSD: ${sourceKey} Filter Effects data is missing its version.`);
	}
	const versionValue = readInt32(bytes, dataOffset, `${sourceKey} Filter Effects version`);
	if (versionValue < 1 || versionValue > 3) {
		throw new Error(`Unsupported PSD ${sourceKey} Filter Effects version ${versionValue}; versions 1, 2, and 3 are supported.`);
	}
	const version = versionValue as 1 | 2 | 3;
	const masks: IParsedPsdSmartFilterMask[] = [];
	let recordCount = 0;
	let cursor = dataOffset + 4;
	while (cursor < dataEnd) {
		if (bytes.subarray(cursor, dataEnd).every((value) => value === 0)) {
			break;
		}
		if (recordCount >= MAXIMUM_PSD_SMART_OBJECT_RESOURCES) {
			throw new Error(`Unsupported PSD ${sourceKey} Filter Effects count; at most ${MAXIMUM_PSD_SMART_OBJECT_RESOURCES} records can be inspected.`);
		}
		++recordCount;
		const recordLength = readUint64(bytes, cursor, `${sourceKey} Filter Effects record length`);
		cursor += 8;
		if (recordLength < 1) {
			throw new Error(`Malformed PSD: ${sourceKey} Filter Effects record has an empty body.`);
		}
		const recordEnd = cursor + recordLength;
		assertRange(bytes, cursor, recordLength, `${sourceKey} Filter Effects record`);
		if (recordEnd > dataEnd) {
			throw new Error(`Malformed PSD: ${sourceKey} Filter Effects record exceeds its tagged block.`);
		}
		assertRange(bytes, cursor, 1, `${sourceKey} Filter Effects identifier length`);
		const idLength = bytes[cursor++];
		const id = readAscii(bytes, cursor, idLength, `${sourceKey} Filter Effects identifier`).replace(/\0/g, "");
		cursor += idLength;
		const effectVersion = readInt32(bytes, cursor, `${sourceKey} Filter Effect version`);
		cursor += 4;
		if (effectVersion !== 1) {
			throw new Error(`Unsupported PSD ${sourceKey} Filter Effect version ${effectVersion}; version 1 is required.`);
		}
		const effectLength = readUint64(bytes, cursor, `${sourceKey} Filter Effect payload length`);
		cursor += 8;
		const effectEnd = cursor + effectLength;
		assertRange(bytes, cursor, effectLength, `${sourceKey} Filter Effect payload`);
		if (effectEnd > recordEnd || effectLength < 24) {
			throw new Error(`Malformed PSD: ${sourceKey} Filter Effect payload is truncated.`);
		}
		readInt32(bytes, cursor, `${sourceKey} Filter Effect top`);
		readInt32(bytes, cursor + 4, `${sourceKey} Filter Effect left`);
		readInt32(bytes, cursor + 8, `${sourceKey} Filter Effect bottom`);
		readInt32(bytes, cursor + 12, `${sourceKey} Filter Effect right`);
		const depthValue = readInt32(bytes, cursor + 16, `${sourceKey} Filter Effect depth`);
		const maximumChannels = readInt32(bytes, cursor + 20, `${sourceKey} Filter Effect maximum channels`);
		cursor += 24;
		if (depthValue !== 8 && depthValue !== 16 && depthValue !== 32) {
			throw new Error(`Unsupported PSD ${sourceKey} Filter Effect depth ${depthValue}; 8, 16, or 32 is required.`);
		}
		if (maximumChannels < 0 || maximumChannels > MAXIMUM_PSD_LAYER_CHANNELS) {
			throw new Error(`Unsupported PSD ${sourceKey} Filter Effect channel count ${maximumChannels}.`);
		}
		for (let channel = 0; channel < maximumChannels + 2; ++channel) {
			const present = readInt32(bytes, cursor, `${sourceKey} Filter Effect channel ${channel} presence`);
			cursor += 4;
			if (present !== 0 && present !== 1) {
				throw new Error(`Malformed PSD: ${sourceKey} Filter Effect channel ${channel} presence must be 0 or 1.`);
			}
			if (present === 1) {
				const channelLength = readUint64(bytes, cursor, `${sourceKey} Filter Effect channel ${channel} length`);
				cursor += 8;
				if (channelLength < 2) {
					throw new Error(`Malformed PSD: ${sourceKey} Filter Effect channel ${channel} is missing compression data.`);
				}
				assertRange(bytes, cursor, channelLength, `${sourceKey} Filter Effect channel ${channel}`);
				cursor += channelLength;
			}
		}
		if (cursor !== effectEnd) {
			throw new Error(`Malformed PSD: ${sourceKey} Filter Effect channels leave ${effectEnd - cursor} unexpected byte(s).`);
		}
		if (cursor < recordEnd) {
			assertRange(bytes, cursor, 1, `${sourceKey} smart-filter mask presence`);
			const maskPresent = bytes[cursor++];
			if (maskPresent !== 0 && maskPresent !== 1) {
				throw new Error(`Malformed PSD: ${sourceKey} smart-filter mask presence must be 0 or 1.`);
			}
			if (maskPresent === 1) {
				const maskTop = readInt32(bytes, cursor, `${sourceKey} smart-filter mask top`);
				const maskLeft = readInt32(bytes, cursor + 4, `${sourceKey} smart-filter mask left`);
				const maskBottom = readInt32(bytes, cursor + 8, `${sourceKey} smart-filter mask bottom`);
				const maskRight = readInt32(bytes, cursor + 12, `${sourceKey} smart-filter mask right`);
				cursor += 16;
				const maskLength = readUint64(bytes, cursor, `${sourceKey} smart-filter mask length`);
				cursor += 8;
				if (maskLength < 2) {
					throw new Error(`Malformed PSD: ${sourceKey} smart-filter mask is missing compression data.`);
				}
				const compressionValue = readUint16(bytes, cursor, `${sourceKey} smart-filter mask compression`);
				const compression = layerCompression(compressionValue);
				cursor += 2;
				if (compression === "unsupported") {
					throw new Error(`Unsupported PSD ${sourceKey} smart-filter mask compression ${compressionValue}.`);
				}
				const dataLength = maskLength - 2;
				const maskDataOffset = cursor;
				assertRange(bytes, maskDataOffset, dataLength, `${sourceKey} smart-filter mask data`);
				cursor += dataLength;
				const width = maskRight - maskLeft;
				const height = maskBottom - maskTop;
				if (width < 1 || height < 1 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > MAXIMUM_PSD_LAYER_PIXELS) {
					throw new Error(`Unsupported PSD ${sourceKey} smart-filter mask bounds ${maskLeft},${maskTop}..${maskRight},${maskBottom}.`);
				}
				const depth = depthValue as PsdChannelDepth;
				masks.push({
					index: masks.length,
					sourceKey,
					version,
					id,
					top: maskTop,
					left: maskLeft,
					bottom: maskBottom,
					right: maskRight,
					width,
					height,
					depth,
					sampleByteLength: depth === 32 ? 4 : depth === 16 ? 2 : 1,
					conversionModel: depth === 32 ? "bounded-linear-float32-to-rgba8-v1" : depth === 16 ? "bounded-uint16-to-rgba8-v1" : "identity-uint8",
					compression,
					dataBytes: dataLength,
					executionModel: "bounded-smart-filter-mask-v1",
					dataOffset: maskDataOffset,
					dataLength,
				});
			}
		}
		if (cursor !== recordEnd) {
			throw new Error(`Malformed PSD: ${sourceKey} Filter Effects record leaves ${recordEnd - cursor} unexpected byte(s).`);
		}
		const paddedRecordEnd = recordEnd + ((4 - (recordLength % 4)) % 4);
		assertRange(bytes, recordEnd, paddedRecordEnd - recordEnd, `${sourceKey} Filter Effects record padding`);
		if (paddedRecordEnd > dataEnd || bytes.subarray(recordEnd, paddedRecordEnd).some((value) => value !== 0)) {
			throw new Error(`Malformed PSD: ${sourceKey} Filter Effects record padding is invalid.`);
		}
		cursor = paddedRecordEnd;
	}
	return masks;
}

function parseGlobalLayerResources(
	bytes: Uint8Array,
	layerInfoEnd: number,
	layerAndMaskEnd: number,
	version: 1 | 2,
	depth: PsdChannelDepth
): {
	patterns: IParsedPsdPattern[];
	smartObjectResources: IParsedPsdSmartObjectResource[];
	smartFilterMasks: IParsedPsdSmartFilterMask[];
	textEngineData2: IPsdGlobalTextEngineData2 | null;
	alternateLayerInfo: { source: Exclude<PsdLayerInfoSource, "primary">; dataOffset: number; length: number } | null;
} {
	if (layerInfoEnd + 4 > layerAndMaskEnd) {
		return { patterns: [], smartObjectResources: [], smartFilterMasks: [], textEngineData2: null, alternateLayerInfo: null };
	}
	const globalMaskLength = readUint32(bytes, layerInfoEnd, "global layer-mask length");
	let cursor = layerInfoEnd + 4;
	assertRange(bytes, cursor, globalMaskLength, "global layer-mask data");
	if (cursor + globalMaskLength > layerAndMaskEnd) {
		throw new Error("Malformed PSD: global layer-mask data exceeds the layer-and-mask section.");
	}
	cursor += globalMaskLength;
	const patterns: IParsedPsdPattern[] = [];
	const smartObjectResources: IParsedPsdSmartObjectResource[] = [];
	const smartFilterMasks: IParsedPsdSmartFilterMask[] = [];
	let textEngineData2: IPsdGlobalTextEngineData2 | null = null;
	let alternateLayerInfo: { source: Exclude<PsdLayerInfoSource, "primary">; dataOffset: number; length: number } | null = null;
	let smartObjectPayloadBytes = 0;
	while (cursor + 12 <= layerAndMaskEnd) {
		const signature = readAscii(bytes, cursor, 4, "global tagged-block signature");
		if (signature !== "8BIM" && signature !== "8B64") {
			break;
		}
		const key = readAscii(bytes, cursor + 4, 4, "global tagged-block key");
		const taggedLengthBytes = psdTaggedBlockLengthBytes(version, signature, key);
		if (cursor + 8 + taggedLengthBytes > layerAndMaskEnd) {
			throw new Error(`Malformed PSD: global ${signature} ${key} header is truncated.`);
		}
		const length = taggedLengthBytes === 8 ? readUint64(bytes, cursor + 8, `global ${key} length`) : readUint32(bytes, cursor + 8, `global ${key} length`);
		const dataOffset = cursor + 8 + taggedLengthBytes;
		assertRange(bytes, dataOffset, length, `global ${key} data`);
		const dataEnd = dataOffset + length;
		if (dataEnd > layerAndMaskEnd) {
			throw new Error(`Malformed PSD: global ${key} data exceeds the layer-and-mask section.`);
		}
		const expectedLayerInfoKey = depth === 32 ? "Lr32" : depth === 16 ? "Lr16" : "Layr";
		if (key === expectedLayerInfoKey) {
			if (alternateLayerInfo) {
				throw new Error(`Malformed PSD: duplicate global ${expectedLayerInfoKey} layer-info tagged blocks.`);
			}
			alternateLayerInfo = { source: expectedLayerInfoKey, dataOffset, length } as {
				source: Exclude<PsdLayerInfoSource, "primary">;
				dataOffset: number;
				length: number;
			};
		} else if (key === "Txt2") {
			if (textEngineData2) {
				textEngineData2 = {
					bytes: textEngineData2.bytes + length,
					editors: [],
					warning: "Global Txt2 EngineData2 was preserved but not interpreted because the PSD contains multiple Txt2 blocks.",
				};
			} else {
				textEngineData2 = parsePsdGlobalTextEngineData2(bytes.slice(dataOffset, dataEnd));
			}
		} else if (key === "Patt" || key === "Pat2" || key === "Pat3") {
			let patternOffset = dataOffset;
			while (patternOffset < dataEnd) {
				if (patterns.length >= MAXIMUM_PSD_PATTERNS) {
					throw new Error(`Unsupported PSD embedded pattern count; at most ${MAXIMUM_PSD_PATTERNS} patterns can be inspected.`);
				}
				const parsed = parseEmbeddedPattern(bytes, patternOffset, dataEnd, key, patterns.length);
				patterns.push(parsed.pattern);
				patternOffset = parsed.nextOffset;
			}
			if (patternOffset !== dataEnd) {
				throw new Error(`Malformed PSD: global ${key} pattern records exceed their tagged block.`);
			}
		} else if (key === "lnk2" || key === "lnkD" || key === "lnk3" || key === "lnkE") {
			const parsed = parsePsdSmartObjectResources(bytes, {
				dataOffset,
				dataEnd,
				tagLengthOffset: cursor + 8,
				sourceKey: key,
				startIndex: smartObjectResources.length,
				initialPayloadBytes: smartObjectPayloadBytes,
			});
			smartObjectResources.push(...parsed.resources);
			smartObjectPayloadBytes = parsed.payloadBytes;
		} else if (key === "FEid" || key === "FXid") {
			const parsedMasks = parsePsdSmartFilterMasks(bytes, dataOffset, dataEnd, key);
			for (const mask of parsedMasks) {
				if (smartFilterMasks.some((candidate) => candidate.id === mask.id)) {
					throw new Error(`Malformed PSD: duplicate smart-filter mask identifier ${mask.id}.`);
				}
				smartFilterMasks.push({ ...mask, index: smartFilterMasks.length });
			}
		}
		cursor = dataOffset + Math.ceil(length / 4) * 4;
		if (cursor > layerAndMaskEnd) {
			throw new Error(`Malformed PSD: global ${key} padding exceeds the layer-and-mask section.`);
		}
	}
	return { patterns, smartObjectResources, smartFilterMasks, textEngineData2, alternateLayerInfo };
}

function parsePsdGlobalTextEngineData2(data: Uint8Array): IPsdGlobalTextEngineData2 {
	try {
		const root = parsePsdTextEngineData(data);
		const engineDict = isPsdTextEngineObject(root["1"]) ? root["1"] : null;
		const editorValues = engineDict && Array.isArray(engineDict["1"]) ? engineDict["1"] : null;
		if (!editorValues) {
			throw new Error("numeric EngineDict/Editors hierarchy /1 /1 is missing");
		}
		if (editorValues.length > MAXIMUM_PSD_LAYERS) {
			throw new Error(`editor count ${editorValues.length} exceeds the bounded ${MAXIMUM_PSD_LAYERS}-editor limit`);
		}
		const editors = editorValues.map((wrapperValue, editorIndex): IPsdGlobalTextEditor => {
			const wrapper = isPsdTextEngineObject(wrapperValue) ? wrapperValue : null;
			const editor = wrapper && isPsdTextEngineObject(wrapper["0"]) ? wrapper["0"] : null;
			if (!editor) {
				throw new Error(`editor ${editorIndex} is missing its numeric /0 Editor dictionary`);
			}
			const text = editor["0"] === undefined ? null : typeof editor["0"] === "string" ? editor["0"] : null;
			if (editor["0"] !== undefined && text === null) {
				throw new Error(`editor ${editorIndex} /0 Text value is not a string`);
			}
			const styleRun = isPsdTextEngineObject(editor["6"]) ? editor["6"] : null;
			const runValues = styleRun && Array.isArray(styleRun["0"]) ? styleRun["0"] : null;
			if (!runValues) {
				throw new Error(`editor ${editorIndex} is missing its numeric /6 /0 StyleRun array`);
			}
			if (runValues.length > 256) {
				throw new Error(`editor ${editorIndex} style-run count ${runValues.length} exceeds the bounded 256-run limit`);
			}
			const styleRuns = runValues.map((runValue, runIndex): IPsdGlobalTextStyleRun => {
				const run = isPsdTextEngineObject(runValue) ? runValue : null;
				const sheet = run && isPsdTextEngineObject(run["0"]) ? run["0"] : null;
				const inheritedSheet = sheet && isPsdTextEngineObject(sheet["0"]) ? sheet["0"] : null;
				const style = inheritedSheet && isPsdTextEngineObject(inheritedSheet["6"]) ? inheritedSheet["6"] : null;
				const rawLength = run ? psdTextEngineNumber(run["1"]) : null;
				if (!style || rawLength === null || !Number.isSafeInteger(rawLength) || rawLength < 1) {
					throw new Error(`editor ${editorIndex} style run ${runIndex} has an invalid /0 /0 /6 style dictionary or /1 RunLength`);
				}
				const exactBoolean = (key: "23" | "24" | "28", label: string): boolean | null => {
					if (style[key] === undefined) {
						return null;
					}
					if (typeof style[key] !== "boolean") {
						throw new Error(`editor ${editorIndex} style run ${runIndex} ${label} /${key} is not Boolean`);
					}
					return style[key];
				};
				return {
					length: rawLength,
					fractions: exactBoolean("23", "Fractions"),
					ordinals: exactBoolean("24", "Ordinals"),
					stylisticAlternates: exactBoolean("28", "StylisticAlternates"),
				};
			});
			return { text, styleRuns };
		});
		return { bytes: data.byteLength, editors, warning: null };
	} catch (error) {
		return {
			bytes: data.byteLength,
			editors: [],
			warning: `Global Txt2 EngineData2 was preserved but not interpreted: ${error instanceof Error ? error.message : String(error)}.`,
		};
	}
}

function psdTextBoundarySplitsSurrogatePair(text: string, boundary: number): boolean {
	return (
		boundary > 0 &&
		boundary < text.length &&
		text.charCodeAt(boundary - 1) >= 0xd800 &&
		text.charCodeAt(boundary - 1) <= 0xdbff &&
		text.charCodeAt(boundary) >= 0xdc00 &&
		text.charCodeAt(boundary) <= 0xdfff
	);
}

function mergePsdGlobalTextEngineData2(layers: IParsedPsdLayer[], global: IPsdGlobalTextEngineData2 | null): void {
	if (!global) {
		return;
	}
	const textLayers = layers.filter((layer): layer is IParsedPsdLayer & { text: IPsdTextLayerInfo } => layer.text !== null);
	const layersByTextIndex = new Map<number, Array<IParsedPsdLayer & { text: IPsdTextLayerInfo }>>();
	for (const layer of textLayers) {
		layer.text.engineData2Bytes = global.bytes;
		const indexedLayers = layersByTextIndex.get(layer.text.textIndex) ?? [];
		indexedLayers.push(layer);
		layersByTextIndex.set(layer.text.textIndex, indexedLayers);
	}
	for (const layer of textLayers) {
		const text = layer.text;
		const fail = (message: string): void => {
			text.engineData2Warning = message;
			text.engineData2ExecutionModel = "disabled";
		};
		if (global.warning) {
			fail(global.warning);
			continue;
		}
		if ((layersByTextIndex.get(text.textIndex)?.length ?? 0) !== 1) {
			fail(`Global Txt2 EngineData2 editor index ${text.textIndex} is ambiguous because multiple TySh layers use the same TextIndex.`);
			continue;
		}
		const editor = global.editors[text.textIndex];
		if (!editor) {
			fail(`Global Txt2 EngineData2 has no editor at TySh TextIndex ${text.textIndex}.`);
			continue;
		}
		const normalizedLayerText = text.text.replace(/\r/g, "\n").replace(/\n+$/, "");
		const rawEditorText = editor.text;
		const normalizedEditorText = rawEditorText?.replace(/\r/g, "\n").replace(/\n+$/, "") ?? null;
		if (normalizedEditorText !== null && normalizedEditorText !== normalizedLayerText) {
			fail(`Global Txt2 EngineData2 editor ${text.textIndex} text does not match its TySh layer.`);
			continue;
		}
		const engineRuns = editor.styleRuns.map((run) => ({ ...run }));
		const editorHasTerminator = rawEditorText !== null && /[\r\n]$/.test(rawEditorText);
		normalizePsdTextEngineRunTerminator(engineRuns, normalizedLayerText.length, editorHasTerminator);
		const engineLength = engineRuns.reduce((sum, run) => sum + run.length, 0);
		const tyshLength = text.styleRuns.reduce((sum, run) => sum + run.length, 0);
		if (!engineRuns.length || engineLength !== normalizedLayerText.length) {
			fail(`Global Txt2 EngineData2 editor ${text.textIndex} style runs cover ${engineLength} UTF-16 code units instead of ${normalizedLayerText.length}.`);
			continue;
		}
		if (!text.styleRuns.length || tyshLength !== normalizedLayerText.length) {
			fail(
				`TySh style runs for TextIndex ${text.textIndex} cover ${tyshLength} UTF-16 code units instead of ${normalizedLayerText.length}; EngineData2 cannot be merged safely.`
			);
			continue;
		}
		const boundaries = new Set<number>([0, normalizedLayerText.length]);
		for (const runs of [text.styleRuns, engineRuns]) {
			let boundary = 0;
			for (const run of runs) {
				boundary += run.length;
				if (psdTextBoundarySplitsSurrogatePair(normalizedLayerText, boundary)) {
					fail(`A style-run boundary at UTF-16 offset ${boundary} splits a surrogate pair; EngineData2 cannot be merged safely.`);
					break;
				}
				boundaries.add(boundary);
			}
			if (text.engineData2Warning) {
				break;
			}
		}
		if (text.engineData2Warning) {
			continue;
		}
		const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
		const mergedRuns: IPsdTextLayerStyleRunInfo[] = [];
		let tyshIndex = 0;
		let tyshEnd = text.styleRuns[0].length;
		let engineIndex = 0;
		let engineEnd = engineRuns[0].length;
		for (let index = 0; index < orderedBoundaries.length - 1; ++index) {
			const start = orderedBoundaries[index];
			const end = orderedBoundaries[index + 1];
			while (start >= tyshEnd && tyshIndex + 1 < text.styleRuns.length) {
				tyshEnd += text.styleRuns[++tyshIndex].length;
			}
			while (start >= engineEnd && engineIndex + 1 < engineRuns.length) {
				engineEnd += engineRuns[++engineIndex].length;
			}
			const engineRun = engineRuns[engineIndex];
			mergedRuns.push({
				...text.styleRuns[tyshIndex],
				length: end - start,
				fractions: engineRun.fractions,
				ordinals: engineRun.ordinals,
				stylisticAlternates: engineRun.stylisticAlternates,
				engineData2StyleRunIndex: engineIndex,
				engineData2ExecutionModel: "bounded-global-txt2-engine-data2-v1",
			});
		}
		text.styleRuns = mergedRuns;
		text.engineData2Warning = null;
		text.engineData2ExecutionModel = "bounded-global-txt2-engine-data2-v1";
	}
}

function resolveSmartObjectResources(layers: IParsedPsdLayer[], resources: IParsedPsdSmartObjectResource[]): void {
	const resourcesById = new Map<string, IParsedPsdSmartObjectResource[]>();
	for (const resource of resources) {
		const entries = resourcesById.get(resource.id) ?? [];
		entries.push(resource);
		resourcesById.set(resource.id, entries);
	}
	for (const layer of layers) {
		if (!layer.smartObject) {
			continue;
		}
		const matches = resourcesById.get(layer.smartObject.id) ?? [];
		layer.smartObject.linkedResource = {
			status: matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : matches[0].type,
			resourceIndices: matches.map((resource) => resource.index),
		};
	}
}

function resolveSmartFilterMasks(layers: IParsedPsdLayer[], masks: IParsedPsdSmartFilterMask[]): void {
	const masksById = new Map<string, IParsedPsdSmartFilterMask[]>();
	for (const mask of masks) {
		const entries = masksById.get(mask.id) ?? [];
		entries.push(mask);
		masksById.set(mask.id, entries);
	}
	for (const layer of layers) {
		const smartObject = layer.smartObject;
		if (!smartObject?.smartFilterState) {
			continue;
		}
		const matches = smartObject.placedId ? (masksById.get(smartObject.placedId) ?? []) : [];
		if (matches.length === 1) {
			const { dataOffset: _dataOffset, dataLength: _dataLength, ...mask } = matches[0];
			smartObject.smartFilterMask = mask;
			smartObject.smartFilterMaskWarning = null;
		} else if (smartObject.smartFilterState.maskEnabled) {
			smartObject.smartFilterMaskWarning = smartObject.placedId
				? matches.length > 1
					? `Smart-filter mask identifier ${smartObject.placedId} is ambiguous.`
					: `Smart-filter mask identifier ${smartObject.placedId} has no matching FEid/FXid raster.`
				: "Smart-filter mask execution requires the placed smart-object identifier.";
		}
	}
}

function resolveEmbeddedPatterns(layers: IParsedPsdLayer[], patterns: IParsedPsdPattern[]): void {
	const patternsById = new Map<string, IParsedPsdPattern[]>();
	for (const pattern of patterns) {
		const entries = patternsById.get(pattern.id) ?? [];
		entries.push(pattern);
		patternsById.set(pattern.id, entries);
	}
	const resolve = (pattern: IPsdLayerPatternInfo): void => {
		const matches = patternsById.get(pattern.id) ?? [];
		const embedded = matches.length === 1 ? matches[0] : undefined;
		pattern.resolvedPatternIndices = matches.map((candidate) => candidate.index);
		pattern.resolutionStatus = matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : embedded?.bakeSupported ? "resolved" : "unsupported";
		pattern.resolvedPatternIndex = embedded?.index ?? null;
		pattern.resolvedPatternName = embedded?.name ?? null;
		pattern.resolvedWidth = embedded?.width ?? null;
		pattern.resolvedHeight = embedded?.height ?? null;
		pattern.bakeSupported = patternDescriptorIsBounded(pattern) && embedded?.bakeSupported === true;
	};
	for (const layer of layers) {
		if (layer.patternFill) {
			resolve(layer.patternFill.pattern);
			layer.patternFill.bakeSupported = layer.patternFill.pattern.bakeSupported;
			if (layer.vectorFill?.content.pattern === layer.patternFill.pattern) {
				layer.vectorFill.content.bakeSupported = layer.patternFill.pattern.bakeSupported;
				layer.vectorFill.bakeSupported = layer.patternFill.pattern.bakeSupported;
			}
		}
		if (layer.vectorStroke?.content.pattern) {
			resolve(layer.vectorStroke.content.pattern);
			layer.vectorStroke.content.bakeSupported = layer.vectorStroke.content.pattern.bakeSupported;
			layer.vectorStroke.bakeSupported =
				!layer.vectorStroke.strokeEnabled ||
				(layer.vectorStroke.miterLimit >= 1 &&
					layer.vectorStroke.miterLimit <= 1000 &&
					layer.vectorStroke.lineCap !== "unknown" &&
					layer.vectorStroke.lineJoin !== "unknown" &&
					layer.vectorStroke.lineAlignment !== "unknown" &&
					(!layer.vectorMask?.subpaths.some((subpath) => !subpath.closed) || layer.vectorStroke.lineAlignment === "center") &&
					Boolean(layer.vectorStroke.blendMode) &&
					layer.vectorStroke.content.pattern.bakeSupported);
		}
		for (const bevel of layer.effects?.bevels ?? []) {
			if (bevel.texturePattern) {
				resolve(bevel.texturePattern);
				if (bevel.useTexture) {
					bevel.bakeSupported &&= bevel.texturePattern.bakeSupported;
				}
			}
		}
		for (const stroke of layer.effects?.strokes ?? []) {
			if (stroke.pattern) {
				resolve(stroke.pattern);
				if (stroke.fillType === "pattern") {
					stroke.bakeSupported &&= stroke.pattern.bakeSupported;
				}
			}
		}
		for (const overlay of layer.effects?.patternOverlays ?? []) {
			resolve(overlay.pattern);
			overlay.bakeSupported &&= overlay.pattern.bakeSupported && overlay.blendMode !== "";
		}
	}
}

function parsePsdLayers(bytes: Uint8Array): {
	document: IPsdLayerDocumentInfo;
	layers: IParsedPsdLayer[];
	patterns: IParsedPsdPattern[];
	smartObjectResources: IParsedPsdSmartObjectResource[];
	smartFilterMasks: IParsedPsdSmartFilterMask[];
} {
	const parsed = parsePsd(bytes);
	if (!parsed.layerAndMaskBytes) {
		return {
			document: {
				version: parsed.version,
				format: parsed.format,
				width: parsed.width,
				height: parsed.height,
				depth: parsed.depth,
				sampleByteLength: parsed.sampleByteLength,
				channelConversionModel: parsed.channelConversionModel,
				layerInfoSource: "primary",
				colorMode: parsed.colorMode,
				mergedAlpha: parsed.hasAlpha,
				layerCount: 0,
				layers: [],
				patterns: [],
				smartObjectResources: [],
				totalPixelLayerPixels: 0,
			},
			layers: [],
			patterns: [],
			smartObjectResources: [],
			smartFilterMasks: [],
		};
	}
	assertRange(bytes, parsed.layerAndMaskOffset, parsed.layerAndMaskBytes, "layer-and-mask information");
	const layerInfoLengthBytes = parsed.version === 2 ? 8 : 4;
	if (parsed.layerAndMaskBytes < layerInfoLengthBytes) {
		throw new Error("Malformed PSD: layer-and-mask information is too short to contain its layer-info length.");
	}
	let layerInfoLength =
		layerInfoLengthBytes === 8 ? readUint64(bytes, parsed.layerAndMaskOffset, "layer-info length") : readUint32(bytes, parsed.layerAndMaskOffset, "layer-info length");
	let layerInfoOffset = parsed.layerAndMaskOffset + layerInfoLengthBytes;
	assertRange(bytes, layerInfoOffset, layerInfoLength, "layer info");
	const primaryLayerInfoEnd = layerInfoOffset + layerInfoLength;
	const layerAndMaskEnd = parsed.layerAndMaskOffset + parsed.layerAndMaskBytes;
	const globalResources = parseGlobalLayerResources(bytes, primaryLayerInfoEnd, layerAndMaskEnd, parsed.version, parsed.depth);
	let layerInfoSource: PsdLayerInfoSource = "primary";
	if (globalResources.alternateLayerInfo) {
		layerInfoSource = globalResources.alternateLayerInfo.source;
		layerInfoOffset = globalResources.alternateLayerInfo.dataOffset;
		layerInfoLength = globalResources.alternateLayerInfo.length;
		assertRange(bytes, layerInfoOffset, layerInfoLength, `${layerInfoSource} layer info`);
	}
	if (layerInfoLength === 0) {
		return {
			document: {
				version: parsed.version,
				format: parsed.format,
				width: parsed.width,
				height: parsed.height,
				depth: parsed.depth,
				sampleByteLength: parsed.sampleByteLength,
				channelConversionModel: parsed.channelConversionModel,
				layerInfoSource,
				colorMode: parsed.colorMode,
				mergedAlpha: parsed.hasAlpha,
				layerCount: 0,
				layers: [],
				patterns: [],
				smartObjectResources: [],
				totalPixelLayerPixels: 0,
			},
			layers: [],
			patterns: [],
			smartObjectResources: [],
			smartFilterMasks: globalResources.smartFilterMasks,
		};
	}
	if (layerInfoLength < 2) {
		throw new Error("Malformed PSD: non-empty layer info has no signed layer count.");
	}
	const layerInfoEnd = layerInfoOffset + layerInfoLength;
	const signedLayerCount = readInt16(bytes, layerInfoOffset, "layer count");
	const layerCount = Math.abs(signedLayerCount);
	if (layerCount > MAXIMUM_PSD_LAYERS) {
		throw new Error(`Unsupported PSD layer count ${layerCount}; at most ${MAXIMUM_PSD_LAYERS} layers can be inspected.`);
	}
	let recordOffset = layerInfoOffset + 2;
	const layers: IParsedPsdLayer[] = [];
	const layerPatterns: IParsedPsdPattern[] = [];
	let totalPixelLayerPixels = 0;
	for (let index = 0; index < layerCount; ++index) {
		assertRange(bytes, recordOffset, 18, `layer ${index} fixed record`);
		const top = readInt32(bytes, recordOffset, `layer ${index} top`);
		const left = readInt32(bytes, recordOffset + 4, `layer ${index} left`);
		const bottom = readInt32(bytes, recordOffset + 8, `layer ${index} bottom`);
		const right = readInt32(bytes, recordOffset + 12, `layer ${index} right`);
		const width = right - left;
		const height = bottom - top;
		if (width < 0 || height < 0 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION) {
			throw new Error(`Malformed PSD: layer ${index} has invalid bounds (${left}, ${top})-(${right}, ${bottom}).`);
		}
		const channelCount = readUint16(bytes, recordOffset + 16, `layer ${index} channel count`);
		if (channelCount > MAXIMUM_PSD_LAYER_CHANNELS) {
			throw new Error(`Unsupported PSD layer channel count ${channelCount}; at most ${MAXIMUM_PSD_LAYER_CHANNELS} channels are allowed per layer.`);
		}
		recordOffset += 18;
		const channelLengths: Array<{ id: number; byteLength: number }> = [];
		const channelLengthBytes = parsed.version === 2 ? 8 : 4;
		for (let channelIndex = 0; channelIndex < channelCount; ++channelIndex) {
			assertRange(bytes, recordOffset, 2 + channelLengthBytes, `layer ${index} channel ${channelIndex} record`);
			const id = readInt16(bytes, recordOffset, `layer ${index} channel ${channelIndex} id`);
			const byteLength =
				channelLengthBytes === 8
					? readUint64(bytes, recordOffset + 2, `layer ${index} channel ${channelIndex} length`)
					: readUint32(bytes, recordOffset + 2, `layer ${index} channel ${channelIndex} length`);
			if (byteLength < 2) {
				throw new Error(`Malformed PSD: layer ${index} channel ${id} is shorter than its compression field.`);
			}
			channelLengths.push({ id, byteLength });
			recordOffset += 2 + channelLengthBytes;
		}
		assertRange(bytes, recordOffset, 16, `layer ${index} blend record`);
		if (readAscii(bytes, recordOffset, 4, `layer ${index} blend signature`) !== "8BIM") {
			throw new Error(`Malformed PSD: layer ${index} has an invalid blend-mode signature.`);
		}
		const blendMode = readAscii(bytes, recordOffset + 4, 4, `layer ${index} blend mode`);
		const opacity = bytes[recordOffset + 8];
		const clipping = bytes[recordOffset + 9] !== 0;
		const flags = bytes[recordOffset + 10];
		const extraLength = readUint32(bytes, recordOffset + 12, `layer ${index} extra-data length`);
		const extraOffset = recordOffset + 16;
		assertRange(bytes, extraOffset, extraLength, `layer ${index} extra data`);
		const extraEnd = extraOffset + extraLength;
		let cursor = extraOffset;
		const maskLength = readUint32(bytes, cursor, `layer ${index} mask-data length`);
		cursor += 4;
		assertRange(bytes, cursor, maskLength, `layer ${index} mask data`);
		const mask = parseLayerMask(bytes, cursor, maskLength, index);
		cursor += maskLength;
		const blendingRangesLength = readUint32(bytes, cursor, `layer ${index} blending-ranges length`);
		cursor += 4;
		assertRange(bytes, cursor, blendingRangesLength, `layer ${index} blending ranges`);
		cursor += blendingRangesLength;
		assertRange(bytes, cursor, 1, `layer ${index} Pascal-name length`);
		const pascalLength = bytes[cursor];
		const pascalBlockLength = Math.ceil((1 + pascalLength) / 4) * 4;
		assertRange(bytes, cursor, pascalBlockLength, `layer ${index} Pascal name`);
		let name =
			readAscii(bytes, cursor + 1, pascalLength, `layer ${index} Pascal name`)
				.replace(/\0/g, "")
				.trim() || `Layer ${index + 1}`;
		cursor += pascalBlockLength;
		let sectionType = 0;
		let sectionBlendMode: string | null = null;
		let layerId: number | null = null;
		let effects: IPsdLayerEffectsInfo | null = null;
		let vectorMask: IPsdVectorMaskInfo | null = null;
		let adjustment: IPsdLayerAdjustmentInfo | null = null;
		let text: IPsdTextLayerInfo | null = null;
		let smartObject: IPsdSmartObjectLayerInfo | null = null;
		let blendClippedLayersAsGroup: boolean | null = null;
		let blendInteriorEffectsAsGroup: boolean | null = null;
		let transparencyShapesLayer: boolean | null = null;
		let knockout: "none" | "shallow" | "deep" = "none";
		let protectedSettings: IPsdLayerInfo["protectedSettings"];
		let sheetColor: IPsdLayerInfo["sheetColor"];
		let effectsReferencePoint: IPsdLayerInfo["effectsReferencePoint"];
		let channelBlendingRestrictions: IPsdLayerInfo["channelBlendingRestrictions"];
		let solidColorFill: IPsdLayerInfo["solidColorFill"];
		let patternFill: IPsdLayerInfo["patternFill"];
		let gradientFill: IPsdLayerInfo["gradientFill"];
		let vectorFill: IPsdLayerInfo["vectorFill"];
		let vectorStroke: IPsdLayerInfo["vectorStroke"];
		let vectorOrigination: IPsdLayerInfo["vectorOrigination"];
		let vectorRenderingVersion: IPsdLayerInfo["vectorRenderingVersion"];
		let pathList: IPsdLayerInfo["pathList"];
		let fillOpacity = 255;
		let layerMaskAsGlobalMask: boolean | null = null;
		let vectorMaskAsGlobalMask: boolean | null = null;
		while (cursor < extraEnd) {
			if (extraEnd - cursor < 12) {
				throw new Error(`Malformed PSD: layer ${index} has a truncated additional-info block header.`);
			}
			const signature = readAscii(bytes, cursor, 4, `layer ${index} additional-info signature`);
			if (signature !== "8BIM" && signature !== "8B64") {
				throw new Error(`Malformed PSD: layer ${index} has unsupported additional-info signature "${signature}".`);
			}
			const key = readAscii(bytes, cursor + 4, 4, `layer ${index} additional-info key`);
			const taggedLengthBytes = psdTaggedBlockLengthBytes(parsed.version, signature, key);
			if (extraEnd - cursor < 8 + taggedLengthBytes) {
				throw new Error(`Malformed PSD: layer ${index} has a truncated ${signature} ${key} header.`);
			}
			const length = taggedLengthBytes === 8 ? readUint64(bytes, cursor + 8, `layer ${index} ${key} length`) : readUint32(bytes, cursor + 8, `layer ${index} ${key} length`);
			const dataOffset = cursor + 8 + taggedLengthBytes;
			assertRange(bytes, dataOffset, length, `layer ${index} ${key} data`);
			if (key === "luni") {
				name = decodeUnicodeLayerName(bytes, dataOffset, length) ?? name;
			} else if ((key === "lsct" || key === "lsdk") && length >= 4) {
				sectionType = readUint32(bytes, dataOffset, `layer ${index} section-divider type`);
				if (length >= 12) {
					const sectionSignature = readAscii(bytes, dataOffset + 4, 4, `layer ${index} section-divider blend signature`);
					if (sectionSignature !== "8BIM" && sectionSignature !== "8B64") {
						throw new Error(`Malformed PSD: layer ${index} has an invalid section-divider blend signature.`);
					}
					sectionBlendMode = readAscii(bytes, dataOffset + 8, 4, `layer ${index} section-divider blend mode`);
				}
			} else if (key === "lyid" && length >= 4) {
				layerId = readUint32(bytes, dataOffset, `layer ${index} id`);
			} else if (key === "clbl") {
				if (
					length !== 4 ||
					(bytes[dataOffset] !== 0 && bytes[dataOffset] !== 1) ||
					bytes[dataOffset + 1] !== 0 ||
					bytes[dataOffset + 2] !== 0 ||
					bytes[dataOffset + 3] !== 0
				) {
					throw new Error(`Malformed PSD: layer ${index} clbl advanced-blending flag must contain one boolean byte followed by three zero padding bytes.`);
				}
				blendClippedLayersAsGroup = bytes[dataOffset] === 1;
			} else if (key === "infx") {
				if (
					length !== 4 ||
					(bytes[dataOffset] !== 0 && bytes[dataOffset] !== 1) ||
					bytes[dataOffset + 1] !== 0 ||
					bytes[dataOffset + 2] !== 0 ||
					bytes[dataOffset + 3] !== 0
				) {
					throw new Error(`Malformed PSD: layer ${index} infx advanced-blending flag must contain one boolean byte followed by three zero padding bytes.`);
				}
				blendInteriorEffectsAsGroup = bytes[dataOffset] === 1;
			} else if (key === "tsly") {
				if (
					length !== 4 ||
					(bytes[dataOffset] !== 0 && bytes[dataOffset] !== 1) ||
					bytes[dataOffset + 1] !== 0 ||
					bytes[dataOffset + 2] !== 0 ||
					bytes[dataOffset + 3] !== 0
				) {
					throw new Error(`Malformed PSD: layer ${index} tsly advanced-blending flag must contain one boolean byte followed by three zero padding bytes.`);
				}
				transparencyShapesLayer = bytes[dataOffset] === 1;
			} else if (key === "iOpa") {
				if (length !== 4 || bytes[dataOffset + 1] !== 0 || bytes[dataOffset + 2] !== 0 || bytes[dataOffset + 3] !== 0) {
					throw new Error(`Malformed PSD: layer ${index} iOpa fill-opacity record must contain one opacity byte followed by three zero padding bytes.`);
				}
				fillOpacity = bytes[dataOffset];
			} else if (key === "knko") {
				if (
					length !== 4 ||
					(bytes[dataOffset] !== 0 && bytes[dataOffset] !== 1) ||
					bytes[dataOffset + 1] !== 0 ||
					bytes[dataOffset + 2] !== 0 ||
					bytes[dataOffset + 3] !== 0
				) {
					throw new Error(`Malformed PSD: layer ${index} knko advanced-blending setting must contain one shallow/deep byte followed by three zero padding bytes.`);
				}
				knockout = bytes[dataOffset] === 1 ? "deep" : "shallow";
			} else if (key === "lspf") {
				if (length !== 4) {
					throw new Error(`Malformed PSD: layer ${index} lspf protected-settings record must contain exactly four flag bytes.`);
				}
				if (protectedSettings) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one lspf protected-settings record.`);
				}
				const rawFlags = readUint32(bytes, dataOffset, `layer ${index} lspf protected-settings flags`);
				protectedSettings = {
					transparency: (rawFlags & 0x01) !== 0,
					composite: (rawFlags & 0x02) !== 0,
					position: (rawFlags & 0x04) !== 0,
					artboardAutonest: (rawFlags & 0x08) !== 0,
					rawFlags,
					unknownFlags: (rawFlags & 0xfffffff0) >>> 0,
					executionModel: "psd-protected-settings-v1",
				};
			} else if (key === "lclr") {
				if (length !== 8) {
					throw new Error(`Malformed PSD: layer ${index} lclr sheet-color record must contain exactly four 16-bit values.`);
				}
				if (sheetColor) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one lclr sheet-color record.`);
				}
				const colorCode = readUint16(bytes, dataOffset, `layer ${index} lclr sheet-color code`);
				const reservedValues: [number, number, number] = [
					readUint16(bytes, dataOffset + 2, `layer ${index} lclr first reserved value`),
					readUint16(bytes, dataOffset + 4, `layer ${index} lclr second reserved value`),
					readUint16(bytes, dataOffset + 6, `layer ${index} lclr third reserved value`),
				];
				sheetColor = {
					color: PSD_LAYER_SHEET_COLORS[colorCode] ?? "unknown",
					colorCode,
					reservedValues,
					reservedNonZero: reservedValues.some((value) => value !== 0),
					executionModel: "psd-sheet-color-v1",
				};
			} else if (key === "fxrp") {
				if (length !== 16) {
					throw new Error(`Malformed PSD: layer ${index} fxrp effects-reference-point record must contain exactly two 64-bit values.`);
				}
				if (effectsReferencePoint) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one fxrp effects-reference-point record.`);
				}
				const x = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, 8).getFloat64(0, false);
				const y = new DataView(bytes.buffer, bytes.byteOffset + dataOffset + 8, 8).getFloat64(0, false);
				if (!Number.isFinite(x) || !Number.isFinite(y)) {
					throw new Error(`Malformed PSD: layer ${index} fxrp effects-reference-point coordinates must be finite.`);
				}
				effectsReferencePoint = {
					sourceKey: "fxrp",
					x,
					y,
					axisOrder: "x-y",
					executionModel: "psd-effects-reference-point-v1",
				};
			} else if (key === "brst") {
				if (length % 4 !== 0) {
					throw new Error(`Malformed PSD: layer ${index} brst channel-blending-restrictions record length must be divisible by four.`);
				}
				if (channelBlendingRestrictions) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one brst channel-blending-restrictions record.`);
				}
				const channelIds = Array.from({ length: length / 4 }, (_, channelIndex) =>
					readInt32(bytes, dataOffset + channelIndex * 4, `layer ${index} brst restricted channel ${channelIndex}`)
				);
				const channelNames = parsed.colorMode === "rgb" ? (["red", "green", "blue"] as const) : (["gray"] as const);
				const restrictedChannels = channelIds.flatMap((channelId) => channelNames[channelId] ?? []);
				const unsupportedChannelIds = [...new Set(channelIds.filter((channelId) => channelNames[channelId] === undefined))];
				const seenChannelIds = new Set<number>();
				const duplicateChannelIds = [...new Set(channelIds.filter((channelId) => (seenChannelIds.has(channelId) ? true : !seenChannelIds.add(channelId))))];
				channelBlendingRestrictions = {
					sourceKey: "brst",
					channelIds,
					restrictedChannels,
					unsupportedChannelIds,
					duplicateChannelIds,
					executionModel: "bounded-channel-blending-restrictions-v1",
				};
			} else if (key === "SoCo") {
				if (solidColorFill) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one SoCo solid-color-fill record.`);
				}
				if (patternFill || gradientFill) {
					throw new Error(`Malformed PSD: layer ${index} contains multiple SoCo/PtFl/GdFl generated-fill records.`);
				}
				solidColorFill = parsePsdSolidColorFill(
					bytes.subarray(dataOffset, dataOffset + length),
					index,
					width > 0 && height > 0 ? "layer" : "document",
					width > 0 && height > 0 && channelLengths.some((channel) => channel.id === -1) ? "transparency-channel" : "opaque-generated"
				);
			} else if (key === "PtFl") {
				if (patternFill) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one PtFl pattern-fill record.`);
				}
				if (solidColorFill || gradientFill) {
					throw new Error(`Malformed PSD: layer ${index} contains multiple SoCo/PtFl/GdFl generated-fill records.`);
				}
				patternFill = parsePsdPatternFill(
					bytes.subarray(dataOffset, dataOffset + length),
					index,
					width > 0 && height > 0 ? "layer" : "document",
					width > 0 && height > 0 && channelLengths.some((channel) => channel.id === -1) ? "transparency-channel" : "opaque-generated"
				);
			} else if (key === "GdFl") {
				if (gradientFill) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one GdFl gradient-fill record.`);
				}
				if (solidColorFill || patternFill) {
					throw new Error(`Malformed PSD: layer ${index} contains multiple SoCo/PtFl/GdFl generated-fill records.`);
				}
				gradientFill = parsePsdGradientFill(
					bytes.subarray(dataOffset, dataOffset + length),
					index,
					width > 0 && height > 0 ? "layer" : "document",
					width > 0 && height > 0 && channelLengths.some((channel) => channel.id === -1) ? "transparency-channel" : "opaque-generated"
				);
			} else if (key === "vscg") {
				if (vectorFill) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one vscg vector-fill record.`);
				}
				if (solidColorFill || patternFill || gradientFill) {
					throw new Error(`Malformed PSD: layer ${index} combines vscg with a standalone SoCo/PtFl/GdFl generated-fill record.`);
				}
				const parsedVectorFill = parsePsdVectorFill(bytes.subarray(dataOffset, dataOffset + length), index, "document", "opaque-generated");
				vectorFill = parsedVectorFill.vectorFill;
				solidColorFill = parsedVectorFill.solidColorFill;
				patternFill = parsedVectorFill.patternFill;
				gradientFill = parsedVectorFill.gradientFill;
			} else if (key === "vstk") {
				if (vectorStroke) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one vstk vector-stroke record.`);
				}
				vectorStroke = parsePsdVectorStroke(bytes.subarray(dataOffset, dataOffset + length), index);
			} else if (key === "vogk") {
				if (vectorOrigination) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one vogk vector-origination record.`);
				}
				vectorOrigination = parsePsdVectorOrigination(bytes.subarray(dataOffset, dataOffset + length), index);
			} else if (key === "vowv") {
				if (length !== 4) {
					throw new Error(`Malformed PSD: layer ${index} vowv vector-rendering-version record must contain exactly one unsigned 32-bit value.`);
				}
				if (vectorRenderingVersion) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one vowv vector-rendering-version record.`);
				}
				const value = readUint32(bytes, dataOffset, `layer ${index} vowv vector-rendering version`);
				vectorRenderingVersion = {
					sourceKey: "vowv",
					value,
					observedPhotoshopValue: value === 2,
					executionModel: "psd-vector-rendering-version-v1",
				};
			} else if (key === "pths") {
				if (pathList) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one pths path-list record.`);
				}
				pathList = parsePsdPathList(bytes.subarray(dataOffset, dataOffset + length), index);
			} else if (key === "Patt" || key === "Pat2" || key === "Pat3") {
				let patternOffset = dataOffset;
				const dataEnd = dataOffset + length;
				while (patternOffset < dataEnd) {
					if (layerPatterns.length >= MAXIMUM_PSD_PATTERNS) {
						throw new Error(`Unsupported PSD embedded pattern count; at most ${MAXIMUM_PSD_PATTERNS} patterns can be inspected.`);
					}
					const embedded = parseEmbeddedPattern(bytes, patternOffset, dataEnd, key, layerPatterns.length);
					layerPatterns.push(embedded.pattern);
					patternOffset = embedded.nextOffset;
				}
				if (patternOffset !== dataEnd) {
					throw new Error(`Malformed PSD: layer ${index} ${key} pattern records exceed their tagged block.`);
				}
			} else if (key === "lmgm") {
				if (
					length !== 4 ||
					(bytes[dataOffset] !== 0 && bytes[dataOffset] !== 1) ||
					bytes[dataOffset + 1] !== 0 ||
					bytes[dataOffset + 2] !== 0 ||
					bytes[dataOffset + 3] !== 0
				) {
					throw new Error(`Malformed PSD: layer ${index} lmgm advanced-blending flag must contain one boolean byte followed by three zero padding bytes.`);
				}
				layerMaskAsGlobalMask = bytes[dataOffset] === 1;
			} else if (key === "vmgm") {
				if (
					length !== 4 ||
					(bytes[dataOffset] !== 0 && bytes[dataOffset] !== 1) ||
					bytes[dataOffset + 1] !== 0 ||
					bytes[dataOffset + 2] !== 0 ||
					bytes[dataOffset + 3] !== 0
				) {
					throw new Error(`Malformed PSD: layer ${index} vmgm advanced-blending flag must contain one boolean byte followed by three zero padding bytes.`);
				}
				vectorMaskAsGlobalMask = bytes[dataOffset] === 1;
			} else if (key === "lrFX") {
				effects = parseLayerEffects(bytes, dataOffset, length, index);
			} else if (key === "lfx2" || key === "lmfx") {
				effects = parseObjectLayerEffects(bytes, dataOffset, length, index, key);
			} else if (key === "vmsk" || key === "vsms") {
				if (vectorMask) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one vector-mask setting block.`);
				}
				vectorMask = parseVectorMask(bytes, dataOffset, length, index, key);
			} else if (key === "TySh") {
				if (text) {
					throw new Error(`Malformed PSD: layer ${index} contains more than one TySh text record.`);
				}
				text = parsePsdTextLayer(bytes.subarray(dataOffset, dataOffset + length), index);
			} else if (key === "PlLd" || key === "SoLd" || key === "SoLE") {
				const parsedSmartObject = parsePsdSmartObjectLayer(bytes.subarray(dataOffset, dataOffset + length), index, key);
				if (key !== "PlLd" && smartObject && smartObject.sourceKey !== "PlLd") {
					throw new Error(`Malformed PSD: layer ${index} contains more than one modern smart-object record.`);
				}
				if (!smartObject || key !== "PlLd") {
					smartObject = parsedSmartObject;
				}
			} else if (
				key === "blnc" ||
				key === "blwh" ||
				key === "brit" ||
				key === "clrL" ||
				key === "curv" ||
				key === "expA" ||
				key === "grdm" ||
				key === "hue " ||
				key === "hue2" ||
				key === "levl" ||
				key === "mixr" ||
				key === "nvrt" ||
				key === "phfl" ||
				key === "post" ||
				key === "selc" ||
				key === "thrs" ||
				key === "vibA"
			) {
				if (adjustment) {
					throw new Error(`Malformed PSD: layer ${index} contains multiple core adjustment tagged blocks.`);
				}
				adjustment = parseLayerAdjustment(bytes, dataOffset, length, index, key);
			}
			cursor = dataOffset + length + (length & 1);
		}
		if (cursor !== extraEnd) {
			throw new Error(`Malformed PSD: layer ${index} additional-info padding exceeds its extra-data block.`);
		}
		if (vectorFill && !vectorStroke) {
			throw new Error(`Malformed PSD: layer ${index} contains vscg vector-fill content without its required vstk vector-stroke settings.`);
		}
		if (vectorStroke && !vectorMask) {
			throw new Error(`Malformed PSD: layer ${index} contains vstk vector-stroke settings without a vmsk/vsms vector path.`);
		}
		if (vectorStroke && vectorMask?.subpaths.some((subpath) => !subpath.closed) && vectorStroke.lineAlignment !== "center") {
			vectorStroke.bakeSupported = false;
			vectorStroke.warnings.push("Open Vector Stroke paths require center alignment for bounded rasterization; inside/outside orientation is preserved as evidence only.");
		}
		if (vectorOrigination && vectorMask) {
			vectorOrigination.association = "vector-mask";
		}
		recordOffset = extraEnd;
		let kind: PsdLayerKind = "other";
		if (sectionType === 1 || sectionType === 2) {
			kind = "groupStart";
		} else if (sectionType === 3) {
			kind = "groupEnd";
		} else if (adjustment) {
			kind = "adjustment";
		} else if (solidColorFill || patternFill || gradientFill || vectorStroke || (width > 0 && height > 0 && channelCount > 0)) {
			kind = "pixel";
		}
		if (kind === "pixel") {
			totalPixelLayerPixels +=
				solidColorFill?.renderBounds === "document" || patternFill?.renderBounds === "document" || gradientFill?.renderBounds === "document" || vectorStroke
					? parsed.width * parsed.height
					: width * height;
			if (totalPixelLayerPixels > MAXIMUM_PSD_LAYER_PIXELS) {
				throw new Error(`Unsupported PSD layered pixel total; decoded pixel layers are limited to ${MAXIMUM_PSD_LAYER_PIXELS.toLocaleString()} pixels.`);
			}
		}
		layers.push({
			index,
			id: layerId,
			name,
			kind,
			top,
			left,
			bottom,
			right,
			width,
			height,
			visible: (flags & 0x02) === 0,
			transparencyProtected: (flags & 0x01) !== 0,
			...(protectedSettings ? { protectedSettings } : {}),
			...(sheetColor ? { sheetColor } : {}),
			...(effectsReferencePoint ? { effectsReferencePoint } : {}),
			...(channelBlendingRestrictions ? { channelBlendingRestrictions } : {}),
			...(solidColorFill ? { solidColorFill } : {}),
			...(patternFill ? { patternFill } : {}),
			...(gradientFill ? { gradientFill } : {}),
			...(vectorFill ? { vectorFill } : {}),
			...(vectorStroke ? { vectorStroke } : {}),
			...(vectorOrigination ? { vectorOrigination } : {}),
			...(vectorRenderingVersion ? { vectorRenderingVersion } : {}),
			...(pathList ? { pathList } : {}),
			opacity,
			fillOpacity,
			blendMode: kind === "groupStart" ? (sectionBlendMode ?? blendMode) : blendMode,
			clipping,
			hasTransparency: channelLengths.some((channel) => channel.id === -1),
			advancedBlending: {
				blendClippedLayersAsGroup,
				blendInteriorEffectsAsGroup,
				transparencyShapesLayer,
				knockout,
				layerMaskAsGlobalMask,
				vectorMaskAsGlobalMask,
				executionModel: "psd-advanced-layer-style-flags-v1",
			},
			mask,
			vectorMask,
			adjustment,
			effects,
			text,
			smartObject,
			channels: channelLengths.map((channel) => ({
				...channel,
				compression: "unsupported",
				depth: parsed.depth,
				sampleByteLength: parsed.sampleByteLength,
				conversionModel: parsed.channelConversionModel,
				dataOffset: 0,
				rleRowLengthBytes: parsed.rleRowLengthBytes,
				width: channel.id === -2 && mask ? mask.width : channel.id === -3 && mask?.realUserMask ? mask.realUserMask.width : width,
				height: channel.id === -2 && mask ? mask.height : channel.id === -3 && mask?.realUserMask ? mask.realUserMask.height : height,
			})),
		});
	}
	let channelOffset = recordOffset;
	for (const layer of layers) {
		for (const channel of layer.channels) {
			assertRange(bytes, channelOffset, channel.byteLength, `layer ${layer.index} channel ${channel.id} image data`);
			channel.dataOffset = channelOffset;
			channel.compression = layerCompression(readUint16(bytes, channelOffset, `layer ${layer.index} channel ${channel.id} compression`));
			channelOffset += channel.byteLength;
		}
	}
	const layerInfoPadding = layerInfoEnd - channelOffset;
	if (layerInfoPadding < 0 || layerInfoPadding > 3 || bytes.subarray(channelOffset, layerInfoEnd).some((value) => value !== 0)) {
		throw new Error(`Malformed PSD: layer channel data ends at ${channelOffset - layerInfoOffset} bytes but layer info declares ${layerInfoLength} bytes.`);
	}
	const patterns = [...layerPatterns, ...globalResources.patterns.map((pattern, index): IParsedPsdPattern => ({ ...pattern, index: layerPatterns.length + index }))];
	const smartObjectResources = globalResources.smartObjectResources;
	mergePsdGlobalTextEngineData2(layers, globalResources.textEngineData2);
	resolveEmbeddedPatterns(layers, patterns);
	resolveSmartObjectResources(layers, smartObjectResources);
	resolveSmartFilterMasks(layers, globalResources.smartFilterMasks);
	const publicLayers = layers.map((layer): IPsdLayerInfo => {
		const warnings: string[] = [];
		const requiredColorIds =
			layer.kind === "pixel" && !layer.solidColorFill && !layer.patternFill && !layer.gradientFill && !layer.vectorStroke
				? parsed.colorMode === "rgb"
					? [0, 1, 2]
					: [0]
				: [];
		const missingColor = requiredColorIds.filter((id) => !layer.channels.some((channel) => channel.id === id));
		const unsupportedCompression = layer.channels
			.filter((channel) => requiredColorIds.includes(channel.id) || channel.id === -1 || channel.id === -2 || channel.id === -3)
			.some((channel) => channel.compression === "unsupported");
		if (missingColor.length) {
			warnings.push(`Missing required color channel(s): ${missingColor.join(", ")}.`);
		}
		if (unsupportedCompression) {
			warnings.push("One or more required channels use an unsupported compression value.");
		}
		if (layer.protectedSettings?.unknownFlags) {
			warnings.push(
				`Protected Settings preserves unknown lspf flags 0x${layer.protectedSettings.unknownFlags.toString(16).padStart(8, "0")}; their meaning is not interpreted.`
			);
		}
		if (layer.sheetColor?.color === "unknown") {
			warnings.push(`Sheet Color preserves unknown lclr color code ${layer.sheetColor.colorCode}; its label color is not interpreted.`);
		}
		if (layer.sheetColor?.reservedNonZero) {
			warnings.push(`Sheet Color preserves non-zero lclr reserved values ${layer.sheetColor.reservedValues.join(", ")}; their meaning is not interpreted.`);
		}
		if (layer.channelBlendingRestrictions?.unsupportedChannelIds.length) {
			warnings.push(
				`Channel Blending Restrictions preserves unsupported brst channel id(s) ${layer.channelBlendingRestrictions.unsupportedChannelIds.join(", ")}; only document color channels execute.`
			);
		}
		if (layer.channelBlendingRestrictions?.duplicateChannelIds.length) {
			warnings.push(
				`Channel Blending Restrictions preserves duplicate brst channel id(s) ${layer.channelBlendingRestrictions.duplicateChannelIds.join(", ")}; restriction execution is idempotent.`
			);
		}
		if (layer.solidColorFill?.colorModel === "unknown") {
			warnings.push(
				`Solid Color Fill preserves unsupported ${layer.solidColorFill.colorClassId || "unknown"} descriptor keys ${layer.solidColorFill.colorEntryKeys.join(", ") || "(none)"}; generated pixels are unavailable.`
			);
		} else if (layer.solidColorFill) {
			warnings.push(
				`Solid Color Fill executes ${layer.solidColorFill.colorModel} descriptor values through ${layer.solidColorFill.conversionModel} over ${layer.solidColorFill.renderBounds} bounds with ${layer.solidColorFill.coverageSource} coverage.`
			);
		}
		if (layer.patternFill) {
			const pattern = layer.patternFill.pattern;
			if (!layer.patternFill.bakeSupported) {
				warnings.push(
					`Pattern Fill preserves PtFl pattern ${pattern.id || "(missing id)"}, but embedded-pattern resolution is ${pattern.resolutionStatus}; generated pixels are unavailable.`
				);
			} else {
				warnings.push(
					`Pattern Fill executes embedded pattern ${pattern.id} at ${pattern.scale}%/${pattern.angle}° through ${layer.patternFill.executionModel} over ${layer.patternFill.renderBounds} bounds with ${layer.patternFill.coverageSource} coverage.`
				);
			}
		}
		if (layer.gradientFill) {
			const gradient = layer.gradientFill.gradient;
			if (!layer.gradientFill.bakeSupported) {
				warnings.push(
					`Gradient Fill preserves GdFl ${gradient.type} gradient ${gradient.name || "(unnamed)"}, but its descriptor exceeds bounded rendering support; generated pixels are unavailable.`
				);
			} else {
				warnings.push(
					`Gradient Fill executes ${gradient.type}/${gradient.style}/${gradient.interpolation} through ${layer.gradientFill.executionModel} over ${layer.gradientFill.renderBounds} bounds with ${layer.gradientFill.coverageSource} coverage.`
				);
			}
		}
		if (layer.vectorFill) {
			warnings.push(
				`Vector Fill preserves vscg/${layer.vectorFill.contentKey} content and ${layer.vectorFill.bakeSupported ? "executes" : "cannot execute"} it through ${layer.vectorFill.executionModel}.`
			);
		}
		if (layer.vectorStroke) {
			warnings.push(...layer.vectorStroke.warnings);
			warnings.push(
				`Vector Stroke preserves ${layer.vectorStroke.lineWidth.value}${layer.vectorStroke.lineWidth.units}/${layer.vectorStroke.lineAlignment}/${layer.vectorStroke.lineCap}/${layer.vectorStroke.lineJoin} style and ${layer.vectorStroke.bakeSupported ? "executes" : "cannot execute"} it through ${layer.vectorStroke.executionModel}.`
			);
		}
		if (layer.vectorOrigination) {
			warnings.push(...layer.vectorOrigination.warnings);
			warnings.push(
				`Vector Origination preserves ${layer.vectorOrigination.entries.length} authored shape descriptor(s) through ${layer.vectorOrigination.executionModel} with ${layer.vectorOrigination.association} association.`
			);
		}
		if (layer.vectorRenderingVersion && !layer.vectorRenderingVersion.observedPhotoshopValue) {
			warnings.push(
				`Vector Rendering Version preserves unrecognized vowv value ${layer.vectorRenderingVersion.value}; the value is retained exactly without assigning guessed semantics.`
			);
		} else if (layer.vectorRenderingVersion) {
			warnings.push(
				`Vector Rendering Version preserves observed Photoshop vowv value ${layer.vectorRenderingVersion.value} through ${layer.vectorRenderingVersion.executionModel}.`
			);
		}
		if (layer.pathList) {
			warnings.push(...layer.pathList.warnings);
			warnings.push(`Path List preserves ${layer.pathList.paths.length} named Photoshop path descriptor(s) through ${layer.pathList.executionModel}.`);
		}
		const maskChannel = layer.channels.find((channel) => channel.id === -2);
		if (layer.mask?.disabled && maskChannel) {
			warnings.push("The primary layer mask is disabled and is not applied to extracted pixels.");
		} else if (layer.mask && !maskChannel) {
			warnings.push("The layer declares primary mask metadata but has no primary mask channel to apply.");
		} else if (!layer.mask && maskChannel) {
			warnings.push("The layer has a primary mask channel without bounded mask metadata, so it cannot be applied.");
		}
		const realUserMaskChannel = layer.channels.find((channel) => channel.id === -3);
		if (layer.mask?.realUserMask?.disabled && realUserMaskChannel) {
			warnings.push("The real-user layer mask is disabled and is not applied to extracted pixels.");
		} else if (layer.mask?.realUserMask && !realUserMaskChannel) {
			warnings.push("The layer declares real-user mask metadata but has no real-user mask channel to apply.");
		} else if (!layer.mask?.realUserMask && realUserMaskChannel) {
			warnings.push("The layer has a real-user mask channel without bounded real-user mask metadata, so it cannot be applied.");
		}
		if (layer.mask?.userFeather !== null && layer.mask?.userFeather !== undefined && layer.mask.userFeather > MAXIMUM_PSD_MASK_FEATHER) {
			warnings.push(`Primary-mask feather ${layer.mask.userFeather}px exceeds the bounded ${MAXIMUM_PSD_MASK_FEATHER}px extraction limit and is not applied.`);
		}
		if (layer.vectorMask) {
			warnings.push(...layer.vectorMask.warnings);
			if (layer.vectorMask.disabled) {
				warnings.push("The vector mask is disabled and is not applied to extracted pixels.");
			} else if (!layer.vectorMask.bakeSupported) {
				warnings.push("The vector mask contains an unsupported open path and is not applied to extracted pixels.");
			}
			if (layer.mask?.vectorFeather !== null && layer.mask?.vectorFeather !== undefined && layer.mask.vectorFeather > MAXIMUM_PSD_MASK_FEATHER) {
				warnings.push(`Vector-mask feather ${layer.mask.vectorFeather}px exceeds the bounded ${MAXIMUM_PSD_MASK_FEATHER}px extraction limit and is not applied.`);
			}
		} else if (layer.mask && (layer.mask.vectorDensity !== null || layer.mask.vectorFeather !== null)) {
			warnings.push("Vector-mask density/feather parameters are present without a vector-mask path block and cannot be applied.");
		}
		if (layer.adjustment) {
			if (!layer.adjustment.bakeSupported) {
				warnings.push(`Adjustment ${layer.adjustment.key} is retained but exceeds the bounded RGB execution model.`);
			} else {
				warnings.push(`Adjustment ${layer.adjustment.key} is retained as metadata and is applied only while composing layers beneath it.`);
			}
			if (layer.mask || layer.vectorMask) {
				warnings.push("Adjustment-layer masks are retained but are not yet sampled by the bounded adjustment compositor.");
			}
			if (layer.blendMode !== "norm") {
				warnings.push(`Adjustment-layer blend mode ${layer.blendMode} is not supported by the bounded adjustment compositor.`);
			}
		}
		if (layer.text?.engineDataWarning) {
			warnings.push(layer.text.engineDataWarning);
		}
		if (layer.text?.engineData2Warning) {
			warnings.push(layer.text.engineData2Warning);
		}
		if (layer.smartObject) {
			warnings.push(
				"Smart-object placement metadata is preserved, while extraction uses the PSD's embedded preview raster by default; opt-in live embedded or explicitly bound external rendering executes the supported ordered smart-filter subset with supported blend modes and FEid/FXid mask coverage plus projective, standard analytical preset, exact tensor, or exact quilt placement."
			);
			if (layer.smartObject.smartFilterMaskWarning) {
				warnings.push(layer.smartObject.smartFilterMaskWarning);
			}
			if (layer.smartObject.linkedResource.status === "external" || layer.smartObject.linkedResource.status === "alias") {
				warnings.push(
					`The associated ${layer.smartObject.linkedResource.status} smart-object resource is evidence-only and is never resolved, read, or copied automatically.`
				);
			} else if (layer.smartObject.linkedResource.status === "missing") {
				warnings.push("No document-level linked-resource record matches this smart-object resource ID.");
			} else if (layer.smartObject.linkedResource.status === "ambiguous") {
				warnings.push("Multiple document-level linked-resource records match this smart-object resource ID; payload selection by ID is blocked as ambiguous.");
			}
		}
		if (layer.blendMode !== "norm") {
			warnings.push(`Blend mode ${layer.blendMode} is not composited into an isolated sprite.`);
		}
		if (layer.clipping) {
			warnings.push("Clipping-group composition is not baked into an isolated sprite.");
		}
		if (layer.effects && !layer.effects.visible) {
			warnings.push("Layer effects are globally hidden by the lrFX common-state record.");
		}
		for (const effect of layer.effects?.solidFills ?? []) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(`Layer effect sofi #${effect.index + 1} uses unsupported color space ${effect.color.space} and cannot be baked into extracted pixels.`);
			} else {
				warnings.push(`Layer effect sofi #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		for (const effect of [
			...(layer.effects?.innerShadows ?? []),
			...(layer.effects?.innerGlows ?? []),
			...(layer.effects?.dropShadows ?? []),
			...(layer.effects?.outerGlows ?? []),
		]) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(
					effect.key === "isdw" || effect.key === "dsdw"
						? `Layer effect ${effect.key} #${effect.index + 1} exceeds the bounded RGB/blend/blur/distance/choke/noise/opacity/contour limits and cannot be baked into extracted pixels.`
						: `Layer effect ${effect.key} #${effect.index + 1} exceeds the bounded RGB/blend/blur/intensity/opacity or modern choke/noise/jitter/range/contour/source/technique limits and cannot be baked into extracted pixels.`
				);
			} else {
				warnings.push(`Layer effect ${effect.key} #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		for (const effect of layer.effects?.bevels ?? []) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(
					`Layer effect bevl #${effect.index + 1} exceeds the bounded RGB/blend/style/direction/size/depth/soften/altitude/opacity/gloss-or-shape-contour/shape-range/embedded-texture limits and cannot be baked into extracted pixels.`
				);
			} else {
				warnings.push(`Layer effect bevl #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		for (const effect of layer.effects?.satins ?? []) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(
					`Layer effect ChFX #${effect.index + 1} exceeds the bounded RGB/blend/opacity/angle/distance/size/contour limits and cannot be baked into extracted pixels.`
				);
			} else {
				warnings.push(`Layer effect ChFX #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		for (const effect of layer.effects?.strokes ?? []) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(
					`Layer effect FrFX #${effect.index + 1} exceeds the bounded solid-color/solid-gradient/noise-gradient/embedded-pattern/position/blend/size/opacity limits and cannot be baked into extracted pixels.`
				);
			} else {
				warnings.push(`Layer effect FrFX #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		for (const effect of layer.effects?.gradientOverlays ?? []) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(
					`Layer effect GrFl #${effect.index + 1} exceeds the bounded solid-gradient/noise-gradient/blend/opacity limits and cannot be baked into extracted pixels.`
				);
			} else {
				warnings.push(`Layer effect GrFl #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		for (const effect of layer.effects?.patternOverlays ?? []) {
			if (!effect.enabled) {
				continue;
			}
			if (!effect.bakeSupported) {
				warnings.push(
					`Layer effect patternFill #${effect.index + 1} has an unresolved/unsupported embedded pattern or exceeds bounded scale/angle/phase/blend/opacity limits.`
				);
			} else {
				warnings.push(`Layer effect patternFill #${effect.index + 1} is retained as metadata but is not baked into raw decoded pixels.`);
			}
		}
		if (layer.effects?.unsupportedKeys.length) {
			warnings.push(
				`Unsupported ${layer.effects.descriptorVersion ? "descriptor-based" : "legacy"} layer effect record(s) ${layer.effects.unsupportedKeys.join(", ")} are retained as bounded metadata but not baked into extracted pixels.`
			);
		}
		return {
			...layer,
			channels: layer.channels.map(({ dataOffset: _dataOffset, rleRowLengthBytes: _rleRowLengthBytes, ...channel }) => channel),
			extractionSupported:
				layer.kind === "pixel" &&
				(layer.solidColorFill?.renderBounds === "document" ||
					layer.patternFill?.renderBounds === "document" ||
					layer.gradientFill?.renderBounds === "document" ||
					Boolean(layer.vectorStroke) ||
					(layer.width > 0 && layer.height > 0)) &&
				(layer.vectorStroke && !layer.vectorStroke.fillEnabled ? true : (layer.solidColorFill?.bakeSupported ?? true)) &&
				(layer.vectorStroke && !layer.vectorStroke.fillEnabled ? true : (layer.patternFill?.bakeSupported ?? true)) &&
				(layer.vectorStroke && !layer.vectorStroke.fillEnabled ? true : (layer.gradientFill?.bakeSupported ?? true)) &&
				(layer.vectorStroke && !layer.vectorStroke.fillEnabled ? true : (layer.vectorFill?.bakeSupported ?? true)) &&
				(layer.vectorStroke?.bakeSupported ?? true) &&
				missingColor.length === 0 &&
				!unsupportedCompression,
			warnings,
		};
	});
	return {
		document: {
			version: parsed.version,
			format: parsed.format,
			width: parsed.width,
			height: parsed.height,
			depth: parsed.depth,
			sampleByteLength: parsed.sampleByteLength,
			channelConversionModel: parsed.channelConversionModel,
			layerInfoSource,
			colorMode: parsed.colorMode,
			mergedAlpha: signedLayerCount < 0,
			layerCount,
			layers: publicLayers,
			patterns: patterns.map(({ palette: _palette, channels: _channels, ...pattern }) => pattern),
			smartObjectResources: smartObjectResources.map(
				({
					dataOffset: _dataOffset,
					declaredDataSizeOffset: _declaredDataSizeOffset,
					recordSizeOffset: _recordSizeOffset,
					recordOffset: _recordOffset,
					recordEnd: _recordEnd,
					paddedRecordEnd: _paddedRecordEnd,
					tagLengthOffset: _tagLengthOffset,
					tagDataBytes: _tagDataBytes,
					...resource
				}) => resource
			),
			totalPixelLayerPixels,
		},
		layers,
		patterns,
		smartObjectResources,
		smartFilterMasks: globalResources.smartFilterMasks,
	};
}

/** Decodes bounded document-space FEid/FXid smart-filter masks into exact RGBA8-style coverage planes. */
export function decodePsdSmartFilterMasks(bytes: Uint8Array): IDecodedPsdSmartFilterMask[] {
	const parsed = parsePsdLayers(bytes);
	return parsed.smartFilterMasks.map((mask): IDecodedPsdSmartFilterMask => {
		const decodedByteLength = mask.width * mask.height * mask.sampleByteLength;
		const rowByteLength = mask.width * mask.sampleByteLength;
		let samples: Uint8Array;
		if (mask.compression === "raw") {
			if (mask.dataLength !== decodedByteLength) {
				throw new Error(`Malformed PSD: raw smart-filter mask ${mask.id} requires ${decodedByteLength} bytes, but ${mask.dataLength} were declared.`);
			}
			samples = bytes.slice(mask.dataOffset, mask.dataOffset + mask.dataLength);
		} else if (mask.compression === "rle") {
			const rowTableBytes = mask.height * 4;
			assertRange(bytes, mask.dataOffset, rowTableBytes, `smart-filter mask ${mask.id} RLE row table`);
			let encodedBytes = 0;
			for (let y = 0; y < mask.height; ++y) {
				encodedBytes += readUint32(bytes, mask.dataOffset + y * 4, `smart-filter mask ${mask.id} RLE row ${y} length`);
			}
			if (rowTableBytes + encodedBytes !== mask.dataLength) {
				throw new Error(`Malformed PSD: smart-filter mask ${mask.id} RLE rows do not consume their payload.`);
			}
			samples = new Uint8Array(decodedByteLength);
			const row = new Uint8Array(rowByteLength);
			let rowOffset = mask.dataOffset + rowTableBytes;
			for (let y = 0; y < mask.height; ++y) {
				const rowBytes = readUint32(bytes, mask.dataOffset + y * 4, `smart-filter mask ${mask.id} RLE row ${y} length`);
				decodePackBitsRow(bytes, rowOffset, rowBytes, rowByteLength, row);
				samples.set(row, y * rowByteLength);
				rowOffset += rowBytes;
			}
		} else {
			const payload = bytes.subarray(mask.dataOffset, mask.dataOffset + mask.dataLength);
			samples = decodePsdZlibStream(payload, 0, payload.byteLength, decodedByteLength, `smart-filter mask ${mask.id} ZIP data`);
			if (mask.compression === "zipPrediction") {
				undoPsdZipPrediction(samples, mask.width, mask.height, mask.depth, `smart-filter mask ${mask.id}`);
			}
		}
		const coverage = convertPsdPlaneToRgba8Samples(samples, mask.width, mask.height, mask.depth, `smart-filter mask ${mask.id}`, true);
		let coverageMinimum = 255;
		let coverageMaximum = 0;
		for (const value of coverage) {
			coverageMinimum = Math.min(coverageMinimum, value);
			coverageMaximum = Math.max(coverageMaximum, value);
		}
		const { dataOffset: _dataOffset, dataLength: _dataLength, ...info } = mask;
		return { ...info, coverage, coverageMinimum, coverageMaximum };
	});
}

function decodePsdPatternChannel(bytes: Uint8Array, pattern: IParsedPsdPattern, channel: IParsedPsdPatternChannel): Uint8Array {
	const pixelCount = channel.width * channel.height;
	if ((channel.depth !== 8 && channel.depth !== 16 && channel.depth !== 32) || channel.pixelDepth !== channel.depth) {
		throw new Error(`Unsupported PSD pattern ${pattern.index} channel ${channel.index} depth ${channel.depth}/${channel.pixelDepth}.`);
	}
	const depth = channel.depth as PsdChannelDepth;
	const sampleByteLength = depth === 32 ? 4 : depth === 16 ? 2 : 1;
	const decodedByteLength = pixelCount * sampleByteLength;
	const rowByteLength = channel.width * sampleByteLength;
	const coverage = pattern.colorMode === "rgb" ? channel.index >= 3 : pattern.colorMode === "grayscale" ? channel.index >= 1 : false;
	assertRange(bytes, channel.dataOffset, channel.dataLength, `pattern ${pattern.index} channel ${channel.index} payload`);
	if (channel.compression === "raw") {
		if (channel.dataLength !== decodedByteLength) {
			throw new Error(`Malformed PSD: raw pattern ${pattern.index} channel ${channel.index} requires ${decodedByteLength} bytes, but ${channel.dataLength} were declared.`);
		}
		return convertPsdPlaneToRgba8Samples(
			bytes.slice(channel.dataOffset, channel.dataOffset + channel.dataLength),
			channel.width,
			channel.height,
			depth,
			`raw pattern ${pattern.index} channel ${channel.index}`,
			coverage
		);
	}
	if (channel.compression === "rle") {
		const rowTableBytes = channel.height * 2;
		assertRange(bytes, channel.dataOffset, rowTableBytes, `pattern ${pattern.index} channel ${channel.index} RLE row table`);
		let encodedBytes = 0;
		for (let y = 0; y < channel.height; ++y) {
			encodedBytes += readUint16(bytes, channel.dataOffset + y * 2, `pattern ${pattern.index} channel ${channel.index} RLE row length`);
		}
		if (rowTableBytes + encodedBytes !== channel.dataLength) {
			throw new Error(`Malformed PSD: pattern ${pattern.index} channel ${channel.index} RLE rows do not consume their payload.`);
		}
		const output = new Uint8Array(decodedByteLength);
		const row = new Uint8Array(rowByteLength);
		let rowOffset = channel.dataOffset + rowTableBytes;
		for (let y = 0; y < channel.height; ++y) {
			const rowBytes = readUint16(bytes, channel.dataOffset + y * 2, `pattern ${pattern.index} channel ${channel.index} RLE row length`);
			decodePackBitsRow(bytes, rowOffset, rowBytes, rowByteLength, row);
			output.set(row, y * rowByteLength);
			rowOffset += rowBytes;
		}
		return convertPsdPlaneToRgba8Samples(output, channel.width, channel.height, depth, `RLE pattern ${pattern.index} channel ${channel.index}`, coverage);
	}
	if (channel.compression === "zip" || channel.compression === "zipPrediction") {
		const payload = bytes.subarray(channel.dataOffset, channel.dataOffset + channel.dataLength);
		const output = decodePsdZlibStream(payload, 0, payload.byteLength, decodedByteLength, `pattern ${pattern.index} channel ${channel.index}`);
		if (channel.compression === "zipPrediction") {
			undoPsdZipPrediction(output, channel.width, channel.height, depth, `pattern ${pattern.index} channel ${channel.index}`);
		}
		return convertPsdPlaneToRgba8Samples(output, channel.width, channel.height, depth, `ZIP pattern ${pattern.index} channel ${channel.index}`, coverage);
	}
	throw new Error(`Unsupported PSD pattern ${pattern.index} channel ${channel.index} compression.`);
}

function decodeParsedPsdPattern(bytes: Uint8Array, pattern: IParsedPsdPattern): IDecodedPsdPattern {
	const output = new Uint8Array(pattern.width * pattern.height * 4);
	for (let offset = 3; offset < output.byteLength; offset += 4) {
		output[offset] = 255;
	}
	for (const channel of pattern.channels) {
		const plane = decodePsdPatternChannel(bytes, pattern, channel);
		for (let y = 0; y < channel.height; ++y) {
			for (let x = 0; x < channel.width; ++x) {
				const destination = ((channel.top + y) * pattern.width + channel.left + x) * 4;
				const value = plane[y * channel.width + x];
				if (pattern.colorMode === "rgb") {
					if (channel.index < 3) {
						output[destination + channel.index] = value;
					} else if (channel.index === 3) {
						output[destination + 3] = value;
					}
				} else if (pattern.colorMode === "grayscale") {
					if (channel.index === 0) {
						output[destination] = output[destination + 1] = output[destination + 2] = value;
					} else if (channel.index === 1) {
						output[destination + 3] = value;
					}
				} else if (pattern.colorMode === "indexed") {
					if (channel.index === 0) {
						const color = pattern.palette[value];
						output[destination] = color[0];
						output[destination + 1] = color[1];
						output[destination + 2] = color[2];
					} else if (channel.index === 1) {
						output[destination + 3] = value;
					}
				}
			}
		}
	}
	const { palette: _palette, channels: _channels, ...publicPattern } = pattern;
	return { ...publicPattern, pixels: output };
}

/** Decodes bounded embedded Patt/Pat2/Pat3 RGB, Grayscale, or Indexed patterns into RGBA8 tiles. */
export function decodePsdPatterns(bytes: Uint8Array): IDecodedPsdPattern[] {
	const parsed = parsePsdLayers(bytes);
	return parsed.patterns.filter((pattern) => pattern.bakeSupported).map((pattern) => decodeParsedPsdPattern(bytes, pattern));
}

export interface IPsdPatternCoordinateSpace {
	documentWidth: number;
	documentHeight: number;
	outputLeft: number;
	outputTop: number;
}

/** Samples one deterministic RGBA8 texel from a resolved bounded PSD pattern. */
export function samplePsdPatternPixel(
	pattern: IPsdLayerPatternInfo,
	decoded: IDecodedPsdPattern,
	x: number,
	y: number,
	coordinateSpace: IPsdPatternCoordinateSpace
): [number, number, number, number] {
	if (!patternDescriptorIsBounded(pattern) || decoded.width <= 0 || decoded.height <= 0) {
		throw new Error("Unsupported PSD pattern sample: the descriptor or decoded tile exceeds bounded rendering requirements.");
	}
	const positiveModulo = (value: number, modulus: number): number => ((value % modulus) + modulus) % modulus;
	const scale = pattern.scale / 100;
	const basisX = pattern.align ? x + 0.5 : coordinateSpace.outputLeft + x + 0.5;
	const basisY = pattern.align ? y + 0.5 : coordinateSpace.outputTop + y + 0.5;
	const radians = (-pattern.angle * Math.PI) / 180;
	const translatedX = basisX - pattern.phaseX - decoded.x;
	const translatedY = basisY - pattern.phaseY - decoded.y;
	const rotatedX = translatedX * Math.cos(radians) - translatedY * Math.sin(radians);
	const rotatedY = translatedX * Math.sin(radians) + translatedY * Math.cos(radians);
	const sourceX = positiveModulo(Math.floor(rotatedX / scale), decoded.width);
	const sourceY = positiveModulo(Math.floor(rotatedY / scale), decoded.height);
	const offset = (sourceY * decoded.width + sourceX) * 4;
	return [decoded.pixels[offset], decoded.pixels[offset + 1], decoded.pixels[offset + 2], decoded.pixels[offset + 3]];
}

function decodePsdLayerChannel(bytes: Uint8Array, layer: IParsedPsdLayer, channel: IParsedPsdLayerChannel): Uint8Array {
	const pixelCount = channel.width * channel.height;
	const sampleByteLength = channel.sampleByteLength;
	const decodedByteLength = pixelCount * sampleByteLength;
	const rowByteLength = channel.width * sampleByteLength;
	const dataOffset = channel.dataOffset + 2;
	const dataLength = channel.byteLength - 2;
	const coverage = channel.id < 0;
	assertRange(bytes, dataOffset, dataLength, `layer ${layer.index} channel ${channel.id} payload`);
	if (channel.compression === "raw") {
		if (dataLength !== decodedByteLength) {
			throw new Error(`Malformed PSD: raw layer ${layer.index} channel ${channel.id} requires ${decodedByteLength} bytes, but ${dataLength} were declared.`);
		}
		return convertPsdPlaneToRgba8Samples(
			bytes.slice(dataOffset, dataOffset + dataLength),
			channel.width,
			channel.height,
			channel.depth,
			`raw layer ${layer.index} channel ${channel.id}`,
			coverage
		);
	}
	if (channel.compression === "rle") {
		const rowLengthBytes = channel.rleRowLengthBytes;
		const rowTableBytes = channel.height * rowLengthBytes;
		assertRange(bytes, dataOffset, rowTableBytes, `layer ${layer.index} channel ${channel.id} RLE row table`);
		let encodedBytes = 0;
		for (let y = 0; y < channel.height; ++y) {
			encodedBytes +=
				rowLengthBytes === 4
					? readUint32(bytes, dataOffset + y * rowLengthBytes, `layer ${layer.index} channel ${channel.id} RLE row length`)
					: readUint16(bytes, dataOffset + y * rowLengthBytes, `layer ${layer.index} channel ${channel.id} RLE row length`);
		}
		if (rowTableBytes + encodedBytes !== dataLength) {
			throw new Error(`Malformed PSD: layer ${layer.index} channel ${channel.id} RLE rows declare ${encodedBytes} bytes but ${dataLength - rowTableBytes} remain.`);
		}
		const output = new Uint8Array(decodedByteLength);
		const row = new Uint8Array(rowByteLength);
		let rowOffset = dataOffset + rowTableBytes;
		for (let y = 0; y < channel.height; ++y) {
			const rowBytes =
				rowLengthBytes === 4
					? readUint32(bytes, dataOffset + y * rowLengthBytes, `layer ${layer.index} channel ${channel.id} RLE row length`)
					: readUint16(bytes, dataOffset + y * rowLengthBytes, `layer ${layer.index} channel ${channel.id} RLE row length`);
			decodePackBitsRow(bytes, rowOffset, rowBytes, rowByteLength, row);
			output.set(row, y * rowByteLength);
			rowOffset += rowBytes;
		}
		return convertPsdPlaneToRgba8Samples(output, channel.width, channel.height, channel.depth, `RLE layer ${layer.index} channel ${channel.id}`, coverage);
	}
	if (channel.compression === "zip" || channel.compression === "zipPrediction") {
		const payload = bytes.subarray(dataOffset, dataOffset + dataLength);
		const output = decodePsdZlibStream(payload, 0, payload.byteLength, decodedByteLength, `layer ${layer.index} channel ${channel.id}`);
		if (channel.compression === "zipPrediction") {
			undoPsdZipPrediction(output, channel.width, channel.height, channel.depth, `layer ${layer.index} channel ${channel.id}`);
		}
		return convertPsdPlaneToRgba8Samples(output, channel.width, channel.height, channel.depth, `ZIP layer ${layer.index} channel ${channel.id}`, coverage);
	}
	throw new Error(`Unsupported PSD layer ${layer.index} channel ${channel.id} compression.`);
}

function featherMaskPlane(values: Uint8Array, width: number, height: number, feather: number | null): Uint8Array {
	if (feather === null || feather <= 0 || feather > MAXIMUM_PSD_MASK_FEATHER || width === 0 || height === 0) {
		return values;
	}
	const radius = Math.max(1, Math.ceil(feather));
	const horizontal = new Float64Array(values.length);
	const output = new Uint8Array(values.length);
	for (let y = 0; y < height; ++y) {
		let sum = 0;
		for (let x = -radius; x <= radius; ++x) {
			sum += values[y * width + Math.min(width - 1, Math.max(0, x))];
		}
		for (let x = 0; x < width; ++x) {
			horizontal[y * width + x] = sum / (radius * 2 + 1);
			sum -= values[y * width + Math.min(width - 1, Math.max(0, x - radius))];
			sum += values[y * width + Math.min(width - 1, Math.max(0, x + radius + 1))];
		}
	}
	for (let x = 0; x < width; ++x) {
		let sum = 0;
		for (let y = -radius; y <= radius; ++y) {
			sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
		}
		for (let y = 0; y < height; ++y) {
			output[y * width + x] = Math.round(sum / (radius * 2 + 1));
			sum -= horizontal[Math.min(height - 1, Math.max(0, y - radius)) * width + x];
			sum += horizontal[Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x];
		}
	}
	return output;
}

function applyMaskPlane(output: Uint8Array, values: Uint8Array, density: number | null): void {
	const normalizedDensity = density === null ? 255 : density;
	for (let pixel = 0; pixel < values.length; ++pixel) {
		const maskValue = 255 - Math.round(((255 - values[pixel]) * normalizedDensity) / 255);
		const alphaOffset = pixel * 4 + 3;
		output[alphaOffset] = Math.round((output[alphaOffset] * maskValue) / 255);
	}
}

function applyPsdLayerMask(
	output: Uint8Array,
	layer: IParsedPsdLayer,
	plane: Uint8Array,
	mask: IPsdLayerMaskGeometryInfo | null,
	settings: { density: number | null; feather: number | null; maskOwner?: IParsedPsdLayer }
): void {
	if (!mask || mask.disabled) {
		return;
	}
	const maskOwner = settings.maskOwner ?? layer;
	const maskTop = mask.positionRelativeToLayer ? maskOwner.top + mask.top : mask.top;
	const maskLeft = mask.positionRelativeToLayer ? maskOwner.left + mask.left : mask.left;
	const values = new Uint8Array(layer.width * layer.height);
	for (let y = 0; y < layer.height; ++y) {
		for (let x = 0; x < layer.width; ++x) {
			const maskX = layer.left + x - maskLeft;
			const maskY = layer.top + y - maskTop;
			const inside = maskX >= 0 && maskY >= 0 && maskX < mask.width && maskY < mask.height;
			let maskValue = inside ? plane[maskY * mask.width + maskX] : mask.defaultColor;
			if (mask.inverted) {
				maskValue = 255 - maskValue;
			}
			values[y * layer.width + x] = maskValue;
		}
	}
	applyMaskPlane(output, featherMaskPlane(values, layer.width, layer.height, settings.feather), settings.density);
}

function cubicPoint(start: number, controlA: number, controlB: number, end: number, t: number): number {
	const inverse = 1 - t;
	return inverse * inverse * inverse * start + 3 * inverse * inverse * t * controlA + 3 * inverse * t * t * controlB + t * t * t * end;
}

function flattenVectorSubpath(subpath: IPsdVectorMaskSubpathInfo, documentWidth: number, documentHeight: number): IPsdVectorMaskPointInfo[] {
	const points: IPsdVectorMaskPointInfo[] = [];
	const segmentCount = subpath.closed ? subpath.knots.length : Math.max(0, subpath.knots.length - 1);
	for (let index = 0; index < segmentCount; ++index) {
		const current = subpath.knots[index];
		const next = subpath.knots[(index + 1) % subpath.knots.length];
		const scaled = (point: IPsdVectorMaskPointInfo): IPsdVectorMaskPointInfo => ({ x: point.x * documentWidth, y: point.y * documentHeight });
		const start = scaled(current.anchor);
		const controlA = scaled(current.leavingControl);
		const controlB = scaled(next.precedingControl);
		const end = scaled(next.anchor);
		const controlLength =
			Math.hypot(controlA.x - start.x, controlA.y - start.y) +
			Math.hypot(controlB.x - controlA.x, controlB.y - controlA.y) +
			Math.hypot(end.x - controlB.x, end.y - controlB.y);
		const steps = Math.min(64, Math.max(1, Math.ceil(controlLength / 2)));
		if (index === 0) {
			points.push(start);
		}
		for (let step = 1; step <= steps; ++step) {
			const t = step / steps;
			points.push({
				x: cubicPoint(start.x, controlA.x, controlB.x, end.x, t),
				y: cubicPoint(start.y, controlA.y, controlB.y, end.y, t),
			});
		}
	}
	return points;
}

function distanceToVectorSegment(
	point: IPsdVectorMaskPointInfo,
	start: IPsdVectorMaskPointInfo,
	end: IPsdVectorMaskPointInfo
): { distance: number; lineDistance: number; amount: number; length: number } {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared <= 1e-12) {
		const distance = Math.hypot(point.x - start.x, point.y - start.y);
		return { distance, lineDistance: distance, amount: 0, length: 0 };
	}
	const amount = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
	const clamped = Math.max(0, Math.min(1, amount));
	return {
		distance: Math.hypot(point.x - (start.x + dx * clamped), point.y - (start.y + dy * clamped)),
		lineDistance: Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / Math.sqrt(lengthSquared),
		amount,
		length: Math.sqrt(lengthSquared),
	};
}

function pointInVectorTriangle(point: IPsdVectorMaskPointInfo, first: IPsdVectorMaskPointInfo, second: IPsdVectorMaskPointInfo, third: IPsdVectorMaskPointInfo): boolean {
	const cross = (left: IPsdVectorMaskPointInfo, right: IPsdVectorMaskPointInfo, value: IPsdVectorMaskPointInfo): number =>
		(right.x - left.x) * (value.y - left.y) - (right.y - left.y) * (value.x - left.x);
	const one = cross(first, second, point);
	const two = cross(second, third, point);
	const three = cross(third, first, point);
	return (one >= -1e-9 && two >= -1e-9 && three >= -1e-9) || (one <= 1e-9 && two <= 1e-9 && three <= 1e-9);
}

function vectorJoinContainsSample(
	point: IPsdVectorMaskPointInfo,
	previous: IPsdVectorMaskPointInfo,
	vertex: IPsdVectorMaskPointInfo,
	next: IPsdVectorMaskPointInfo,
	radius: number,
	stroke: IPsdVectorStrokeInfo
): boolean {
	const firstLength = Math.hypot(vertex.x - previous.x, vertex.y - previous.y);
	const secondLength = Math.hypot(next.x - vertex.x, next.y - vertex.y);
	if (firstLength <= 1e-9 || secondLength <= 1e-9) {
		return false;
	}
	if (stroke.lineJoin === "round") {
		return Math.hypot(point.x - vertex.x, point.y - vertex.y) <= radius;
	}
	const firstDirection = { x: (vertex.x - previous.x) / firstLength, y: (vertex.y - previous.y) / firstLength };
	const secondDirection = { x: (next.x - vertex.x) / secondLength, y: (next.y - vertex.y) / secondLength };
	const turn = firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x;
	if (Math.abs(turn) <= 1e-9) {
		return false;
	}
	const outerSign = turn > 0 ? -1 : 1;
	const firstOuter = { x: vertex.x + -firstDirection.y * outerSign * radius, y: vertex.y + firstDirection.x * outerSign * radius };
	const secondOuter = { x: vertex.x + -secondDirection.y * outerSign * radius, y: vertex.y + secondDirection.x * outerSign * radius };
	if (stroke.lineJoin === "bevel") {
		return pointInVectorTriangle(point, vertex, firstOuter, secondOuter);
	}
	const denominator = firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x;
	const offsetX = secondOuter.x - firstOuter.x;
	const offsetY = secondOuter.y - firstOuter.y;
	const amount = (offsetX * secondDirection.y - offsetY * secondDirection.x) / denominator;
	const miter = { x: firstOuter.x + firstDirection.x * amount, y: firstOuter.y + firstDirection.y * amount };
	if (Math.hypot(miter.x - vertex.x, miter.y - vertex.y) > stroke.miterLimit * radius) {
		return pointInVectorTriangle(point, vertex, firstOuter, secondOuter);
	}
	return pointInVectorTriangle(point, vertex, firstOuter, miter) || pointInVectorTriangle(point, vertex, miter, secondOuter);
}

function vectorDashIsPainted(distance: number, stroke: IPsdVectorStrokeInfo): boolean {
	if (!stroke.lineDashSet.length) {
		return true;
	}
	const pattern = stroke.lineDashSet.map((entry) => entry.pixels);
	if (pattern.length % 2 === 1) {
		pattern.push(...pattern);
	}
	const total = pattern.reduce((sum, value) => sum + value, 0);
	if (total <= 0) {
		return false;
	}
	let position = (((distance + stroke.lineDashOffset.pixels) % total) + total) % total;
	for (let index = 0; index < pattern.length; ++index) {
		if (position <= pattern[index]) {
			return index % 2 === 0;
		}
		position -= pattern[index];
	}
	return true;
}

function vectorStrokeContainsSample(
	point: IPsdVectorMaskPointInfo,
	subpath: IPsdVectorMaskSubpathInfo,
	points: IPsdVectorMaskPointInfo[],
	stroke: IPsdVectorStrokeInfo,
	allClosedSubpaths: IPsdVectorMaskPointInfo[][],
	initialFill: 0 | 1
): boolean {
	if (points.length < 2) {
		return false;
	}
	const halfWidth = stroke.lineWidth.pixels / 2;
	const radius = subpath.closed || stroke.lineAlignment === "center" ? halfWidth : halfWidth;
	let cumulative = 0;
	let nearestDistance = Number.POSITIVE_INFINITY;
	let nearestPathDistance = 0;
	for (let index = 0; index < points.length - 1; ++index) {
		const segment = distanceToVectorSegment(point, points[index], points[index + 1]);
		let accepted = segment.amount >= 0 && segment.amount <= 1;
		let candidateDistance = segment.lineDistance;
		if (!subpath.closed && (index === 0 || index === points.length - 2)) {
			const extension = stroke.lineCap === "square" && segment.length > 0 ? halfWidth / segment.length : 0;
			accepted = segment.amount >= (index === 0 ? -extension : 0) && segment.amount <= (index === points.length - 2 ? 1 + extension : 1);
			if (stroke.lineCap === "round" && (segment.amount < 0 || segment.amount > 1)) {
				accepted = segment.distance <= radius;
				candidateDistance = segment.distance;
			}
		}
		if (accepted && candidateDistance < nearestDistance) {
			nearestDistance = candidateDistance;
			nearestPathDistance = cumulative + Math.max(0, Math.min(1, segment.amount)) * segment.length;
		}
		cumulative += segment.length;
	}
	if (subpath.closed) {
		const closing = distanceToVectorSegment(point, points[points.length - 1], points[0]);
		if (closing.distance < nearestDistance) {
			nearestDistance = closing.distance;
			nearestPathDistance = cumulative + Math.max(0, Math.min(1, closing.amount)) * closing.length;
		}
	}
	const joinRadius = stroke.lineAlignment === "center" || !subpath.closed ? halfWidth : stroke.lineWidth.pixels;
	const joinStart = subpath.closed ? 0 : 1;
	const joinEnd = subpath.closed ? points.length : points.length - 1;
	for (let index = joinStart; index < joinEnd; ++index) {
		const previous = points[(index - 1 + points.length) % points.length];
		const vertex = points[index % points.length];
		const next = points[(index + 1) % points.length];
		if (vectorJoinContainsSample(point, previous, vertex, next, joinRadius, stroke)) {
			nearestDistance = 0;
			break;
		}
	}
	if (!Number.isFinite(nearestDistance) || !vectorDashIsPainted(nearestPathDistance, stroke)) {
		return false;
	}
	if (!subpath.closed || stroke.lineAlignment === "center") {
		return nearestDistance <= halfWidth;
	}
	const inside = pointInsideEvenOddPath(point.x, point.y, allClosedSubpaths, initialFill);
	return stroke.lineAlignment === "inside" ? inside && nearestDistance <= stroke.lineWidth.pixels : !inside && nearestDistance <= stroke.lineWidth.pixels;
}

function vectorStrokeCoverage(
	x: number,
	y: number,
	vectorMask: IPsdVectorMaskInfo,
	stroke: IPsdVectorStrokeInfo,
	flattened: IPsdVectorMaskPointInfo[][],
	closed: IPsdVectorMaskPointInfo[][]
): number {
	const sampleOffsets = [0.25, 0.75];
	let covered = 0;
	for (const sampleY of sampleOffsets) {
		for (const sampleX of sampleOffsets) {
			const point = { x: x + sampleX, y: y + sampleY };
			if (flattened.some((points, index) => vectorStrokeContainsSample(point, vectorMask.subpaths[index], points, stroke, closed, vectorMask.initialFill))) {
				++covered;
			}
		}
	}
	return covered / 4;
}

function applyPsdVectorFillMask(output: Uint8Array, layer: IParsedPsdLayer, documentWidth: number, documentHeight: number): void {
	const vectorMask = layer.vectorMask;
	if (!vectorMask || vectorMask.disabled) {
		output.fill(0);
		return;
	}
	const closedSubpaths = vectorMask.subpaths.filter((subpath) => subpath.closed).map((subpath) => flattenVectorSubpath(subpath, documentWidth, documentHeight));
	const sampleOffsets = [0.25, 0.75];
	for (let y = 0; y < layer.height; ++y) {
		for (let x = 0; x < layer.width; ++x) {
			let covered = 0;
			for (const sampleY of sampleOffsets) {
				for (const sampleX of sampleOffsets) {
					if (pointInsideEvenOddPath(layer.left + x + sampleX, layer.top + y + sampleY, closedSubpaths, vectorMask.initialFill)) {
						++covered;
					}
				}
			}
			let coverage = covered / 4;
			if (vectorMask.inverted) {
				coverage = 1 - coverage;
			}
			output[(y * layer.width + x) * 4 + 3] = Math.round(output[(y * layer.width + x) * 4 + 3] * coverage);
		}
	}
}

function pointInsideEvenOddPath(x: number, y: number, subpaths: IPsdVectorMaskPointInfo[][], initialFill: 0 | 1): boolean {
	let inside = initialFill === 1;
	for (const points of subpaths) {
		for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
			const currentPoint = points[index];
			const previousPoint = points[previous];
			if (
				currentPoint.y > y !== previousPoint.y > y &&
				x < ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x
			) {
				inside = !inside;
			}
		}
	}
	return inside;
}

function applyPsdVectorMask(output: Uint8Array, layer: IParsedPsdLayer, documentWidth: number, documentHeight: number): void {
	const vectorMask = layer.vectorMask;
	if (!vectorMask || vectorMask.disabled || !vectorMask.bakeSupported) {
		return;
	}
	const subpaths = vectorMask.subpaths.map((subpath) => flattenVectorSubpath(subpath, documentWidth, documentHeight));
	const values = new Uint8Array(layer.width * layer.height);
	const sampleOffsets = [0.25, 0.75];
	for (let y = 0; y < layer.height; ++y) {
		for (let x = 0; x < layer.width; ++x) {
			let covered = 0;
			for (const sampleY of sampleOffsets) {
				for (const sampleX of sampleOffsets) {
					if (pointInsideEvenOddPath(layer.left + x + sampleX, layer.top + y + sampleY, subpaths, vectorMask.initialFill)) {
						++covered;
					}
				}
			}
			let value = Math.round((covered * 255) / 4);
			if (vectorMask.inverted) {
				value = 255 - value;
			}
			values[y * layer.width + x] = value;
		}
	}
	const feather = layer.mask?.vectorFeather ?? null;
	const density = layer.mask?.vectorDensity ?? null;
	applyMaskPlane(output, featherMaskPlane(values, layer.width, layer.height, feather), density);
}

function clampAdjustmentByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function applyLevelsValue(value: number, record: IPsdLevelsRecordInfo): number {
	const normalized = Math.max(0, Math.min(1, (value - record.inputFloor) / (record.inputCeiling - record.inputFloor)));
	const corrected = Math.pow(normalized, 1 / (record.gamma / 100));
	return record.outputFloor + corrected * (record.outputCeiling - record.outputFloor);
}

function applyCurveValue(value: number, points: IPsdCurvePointInfo[]): number {
	if (value <= points[0].input) {
		return points[0].output;
	}
	for (let index = 1; index < points.length; ++index) {
		const right = points[index];
		if (value <= right.input) {
			const left = points[index - 1];
			const amount = (value - left.input) / (right.input - left.input);
			return left.output + (right.output - left.output) * amount;
		}
	}
	return points[points.length - 1].output;
}

function srgbToLinear(value: number): number {
	return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
	const clamped = Math.max(0, Math.min(1, value));
	return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function applyExposureValue(value: number, exposure: number, offset: number, gamma: number): number {
	const shifted = srgbToLinear(value / 255) * Math.pow(2, exposure) + offset;
	const corrected = Math.sign(shifted) * Math.pow(Math.abs(shifted), 1 / gamma);
	return linearToSrgb(corrected) * 255;
}

function hueToRgb(p: number, q: number, hue: number): number {
	let wrapped = hue;
	if (wrapped < 0) {
		wrapped += 1;
	}
	if (wrapped > 1) {
		wrapped -= 1;
	}
	if (wrapped < 1 / 6) {
		return p + (q - p) * 6 * wrapped;
	}
	if (wrapped < 1 / 2) {
		return q;
	}
	if (wrapped < 2 / 3) {
		return p + (q - p) * (2 / 3 - wrapped) * 6;
	}
	return p;
}

function rgbToHsl(red: number, green: number, blue: number): { hue: number; saturation: number; lightness: number } {
	const normalized = [red / 255, green / 255, blue / 255];
	const maximum = Math.max(...normalized);
	const minimum = Math.min(...normalized);
	const delta = maximum - minimum;
	const lightness = (maximum + minimum) / 2;
	if (delta === 0) {
		return { hue: 0, saturation: 0, lightness };
	}
	const saturation = delta / (1 - Math.abs(2 * lightness - 1));
	let hue: number;
	if (maximum === normalized[0]) {
		hue = ((normalized[1] - normalized[2]) / delta + (normalized[1] < normalized[2] ? 6 : 0)) / 6;
	} else if (maximum === normalized[1]) {
		hue = ((normalized[2] - normalized[0]) / delta + 2) / 6;
	} else {
		hue = ((normalized[0] - normalized[1]) / delta + 4) / 6;
	}
	return { hue, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
	if (saturation === 0) {
		const gray = lightness * 255;
		return [gray, gray, gray];
	}
	const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
	const p = 2 * lightness - q;
	return [hueToRgb(p, q, hue + 1 / 3) * 255, hueToRgb(p, q, hue) * 255, hueToRgb(p, q, hue - 1 / 3) * 255];
}

function adjustHslComponent(value: number, amount: number): number {
	const normalized = amount / 100;
	return Math.max(0, Math.min(1, normalized >= 0 ? value + (1 - value) * normalized : value * (1 + normalized)));
}

function applyVibranceColor(red: number, green: number, blue: number, vibrance: number, saturationAdjustment: number): [number, number, number] {
	const { hue, saturation, lightness } = rgbToHsl(red, green, blue);
	if (saturation === 0) {
		return [red, green, blue];
	}
	let adjustedSaturation = saturation;
	const vibranceAmount = vibrance / 100;
	if (vibranceAmount >= 0) {
		const hueDegrees = hue * 360;
		const skinDistance = Math.min(Math.abs(hueDegrees - 30), 360 - Math.abs(hueDegrees - 30));
		const skinProtection = skinDistance >= 50 ? 1 : 0.35 + (skinDistance / 50) * 0.65;
		adjustedSaturation += (1 - adjustedSaturation) * vibranceAmount * (1 - adjustedSaturation) * skinProtection;
	} else {
		adjustedSaturation *= 1 + vibranceAmount;
	}
	adjustedSaturation = adjustHslComponent(adjustedSaturation, saturationAdjustment);
	return hslToRgb(hue, adjustedSaturation, lightness);
}

function applyHueSaturationColor(red: number, green: number, blue: number, adjustment: IPsdHueSaturationAdjustmentInfo): [number, number, number] {
	const source = rgbToHsl(red, green, blue);
	if (adjustment.colorize) {
		const hue = ((((adjustment.colorization.hue * adjustment.hueUnitScale) / 360) % 1) + 1) % 1;
		return hslToRgb(hue, Math.max(0, adjustment.colorization.saturation) / 100, adjustHslComponent(source.lightness, adjustment.colorization.lightness));
	}
	const sourceHueDegrees = source.hue * 360;
	let hueShift = adjustment.master.hue * adjustment.hueUnitScale;
	let saturationShift = adjustment.master.saturation;
	let lightnessShift = adjustment.master.lightness;
	for (let index = 0; index < adjustment.channels.length; ++index) {
		const channel = adjustment.channels[index];
		if (channel.hue === 0 && channel.saturation === 0 && channel.lightness === 0) {
			continue;
		}
		const boundaries = channel.range.every((value) => value === 0) ? [-60, -30, 30, 60] : channel.range.map((value) => value * 0.6);
		const center = index * 60;
		const relativeHue = ((sourceHueDegrees - center + 540) % 360) - 180;
		let weight = 0;
		if (relativeHue >= boundaries[1] && relativeHue <= boundaries[2]) {
			weight = 1;
		} else if (relativeHue >= boundaries[0] && relativeHue < boundaries[1]) {
			weight = (relativeHue - boundaries[0]) / Math.max(0.0001, boundaries[1] - boundaries[0]);
		} else if (relativeHue > boundaries[2] && relativeHue <= boundaries[3]) {
			weight = (boundaries[3] - relativeHue) / Math.max(0.0001, boundaries[3] - boundaries[2]);
		}
		weight *= source.saturation;
		hueShift += channel.hue * adjustment.hueUnitScale * weight;
		saturationShift += channel.saturation * weight;
		lightnessShift += channel.lightness * weight;
	}
	const hue = (((source.hue + hueShift / 360) % 1) + 1) % 1;
	const saturation = source.saturation === 0 ? 0 : adjustHslComponent(source.saturation, Math.max(-100, Math.min(100, saturationShift)));
	return hslToRgb(hue, saturation, adjustHslComponent(source.lightness, Math.max(-100, Math.min(100, lightnessShift))));
}

function applyColorBalanceColor(red: number, green: number, blue: number, adjustment: IPsdColorBalanceAdjustmentInfo): [number, number, number] {
	const sourceHsl = rgbToHsl(red, green, blue);
	const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
	const normalizedLuminance = luminance / 255;
	const shadowWeight = Math.max(0, 1 - normalizedLuminance * 2);
	const highlightWeight = Math.max(0, normalizedLuminance * 2 - 1);
	const midtoneWeight = 1 - shadowWeight - highlightWeight;
	const tones = [adjustment.shadows, adjustment.midtones, adjustment.highlights];
	const weights = [shadowWeight, midtoneWeight, highlightWeight];
	const fields: Array<keyof IPsdColorBalanceToneInfo> = ["cyanRed", "magentaGreen", "yellowBlue"];
	const balanced: [number, number, number] = [red, green, blue];
	for (let channel = 0; channel < 3; ++channel) {
		const amount = tones.reduce((sum, tone, index) => sum + tone[fields[channel]] * weights[index], 0);
		balanced[channel] = Math.max(0, Math.min(255, balanced[channel] + amount * 2.55));
	}
	if (!adjustment.preserveLuminosity) {
		return balanced;
	}
	const balancedHsl = rgbToHsl(...balanced);
	return hslToRgb(balancedHsl.hue, balancedHsl.saturation, sourceHsl.lightness);
}

function applyBlackWhiteColor(red: number, green: number, blue: number, adjustment: IPsdBlackWhiteAdjustmentInfo): [number, number, number] {
	const source = rgbToHsl(red, green, blue);
	const luminance = (red * 0.299 + green * 0.587 + blue * 0.114) / 255;
	const mixes = [adjustment.reds, adjustment.yellows, adjustment.greens, adjustment.cyans, adjustment.blues, adjustment.magentas];
	const sector = source.hue * 6;
	const lower = Math.floor(sector) % 6;
	const fraction = sector - Math.floor(sector);
	const mix = mixes[lower] * (1 - fraction) + mixes[(lower + 1) % 6] * fraction;
	const gray = Math.max(0, Math.min(1, luminance * (1 - source.saturation) + (mix / 100) * source.saturation));
	if (!adjustment.useTint || !adjustment.tintColor.rgba) {
		return [gray * 255, gray * 255, gray * 255];
	}
	const tint = rgbToHsl(adjustment.tintColor.rgba[0], adjustment.tintColor.rgba[1], adjustment.tintColor.rgba[2]);
	return hslToRgb(tint.hue, tint.saturation, gray);
}

function applyChannelMixerOutput(red: number, green: number, blue: number, channel: IPsdChannelMixerChannelInfo): number {
	return (red * channel.red + green * channel.green + blue * channel.blue + 255 * channel.constant) / 100;
}

function applyChannelMixerColor(red: number, green: number, blue: number, adjustment: IPsdChannelMixerAdjustmentInfo): [number, number, number] {
	if (adjustment.monochrome) {
		const gray = applyChannelMixerOutput(red, green, blue, adjustment.gray);
		return [gray, gray, gray];
	}
	return [
		applyChannelMixerOutput(red, green, blue, adjustment.red!),
		applyChannelMixerOutput(red, green, blue, adjustment.green!),
		applyChannelMixerOutput(red, green, blue, adjustment.blue!),
	];
}

function applySelectiveColorComponent(scale: number, value: number, component: number, black: number, mode: "relative" | "absolute"): number {
	const minimum = -value;
	const maximum = 1 - value;
	let delta = (-1 - component) * black - component;
	if (mode === "relative") {
		delta *= maximum;
	}
	return Math.max(minimum, Math.min(maximum, delta)) * scale;
}

function applySelectiveColorColor(red: number, green: number, blue: number, adjustment: IPsdSelectiveColorAdjustmentInfo): [number, number, number] {
	const source: [number, number, number] = [red / 255, green / 255, blue / 255];
	const minimum = Math.min(...source);
	const maximum = Math.max(...source);
	const median = source[0] + source[1] + source[2] - minimum - maximum;
	const ranges: Array<[settings: IPsdSelectiveColorRangeInfo, scale: number]> = [
		[adjustment.reds, source[0] === maximum ? maximum - median : 0],
		[adjustment.yellows, source[2] === minimum ? median - minimum : 0],
		[adjustment.greens, source[1] === maximum ? maximum - median : 0],
		[adjustment.cyans, source[0] === minimum ? median - minimum : 0],
		[adjustment.blues, source[2] === maximum ? maximum - median : 0],
		[adjustment.magentas, source[1] === minimum ? median - minimum : 0],
		[adjustment.whites, source.every((value) => value > 0.5) ? minimum * 2 - 1 : 0],
		[adjustment.neutrals, source.some((value) => value > 0) && source.some((value) => value < 1) ? 1 - (Math.abs(maximum - 0.5) + Math.abs(minimum - 0.5)) : 0],
		[adjustment.blacks, source.every((value) => value < 0.5) ? 1 - maximum * 2 : 0],
	];
	const delta: [number, number, number] = [0, 0, 0];
	for (const [settings, scale] of ranges) {
		if (scale <= 0) {
			continue;
		}
		const components = [settings.cyan, settings.magenta, settings.yellow].map((value) => value / 100);
		const black = settings.black / 100;
		for (let channel = 0; channel < 3; ++channel) {
			delta[channel] += applySelectiveColorComponent(scale, source[channel], components[channel], black, adjustment.mode);
		}
	}
	return [(source[0] + delta[0]) * 255, (source[1] + delta[1]) * 255, (source[2] + delta[2]) * 255];
}

function remapGradientMidpoint(value: number, midpoint: number): number {
	return value <= midpoint ? (value / midpoint) * 0.5 : 0.5 + ((value - midpoint) / (1 - midpoint)) * 0.5;
}

function sampleGradientStops<T extends { location: number; midpoint: number }>(stops: T[], position: number): { left: T; right: T; amount: number } {
	if (position <= stops[0].location) {
		return { left: stops[0], right: stops[0], amount: 0 };
	}
	if (position >= stops[stops.length - 1].location) {
		return { left: stops[stops.length - 1], right: stops[stops.length - 1], amount: 0 };
	}
	for (let index = 1; index < stops.length; ++index) {
		if (position <= stops[index].location) {
			const left = stops[index - 1];
			const right = stops[index];
			const range = Math.max(1e-9, right.location - left.location);
			return { left, right, amount: remapGradientMidpoint((position - left.location) / range, left.midpoint) };
		}
	}
	return { left: stops[stops.length - 1], right: stops[stops.length - 1], amount: 0 };
}

function interpolateGradientAmount(amount: number, method: IPsdGradientMapAdjustmentInfo["method"]): number {
	return method === "smooth" || method === "perceptual" ? amount * amount * (3 - 2 * amount) : amount;
}

function seededGradientNoise(seed: number, channel: number, position: number, roughness: number): number {
	let result = 0;
	let weight = 1;
	let total = 0;
	for (let octave = 0; octave < 5; ++octave) {
		const frequency = 1 << octave;
		const scaled = position * frequency;
		const base = Math.floor(scaled);
		const fraction = scaled - base;
		const hash = (lattice: number): number => {
			let value = (seed ^ Math.imul(channel + 1, 0x9e3779b1) ^ Math.imul(lattice + 1, 0x85ebca6b)) | 0;
			value ^= value >>> 16;
			value = Math.imul(value, 0x7feb352d);
			value ^= value >>> 15;
			value = Math.imul(value, 0x846ca68b);
			value ^= value >>> 16;
			return (value >>> 0) / 0xffffffff;
		};
		const eased = fraction * fraction * (3 - 2 * fraction);
		result += (hash(base) * (1 - eased) + hash(base + 1) * eased) * weight;
		total += weight;
		weight *= roughness;
	}
	return total > 0 ? result / total : 0.5;
}

function labToRgb(lightness: number, a: number, b: number): [number, number, number] {
	const fy = (lightness + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - b / 200;
	const pivot = (value: number): number => (value ** 3 > 0.008856 ? value ** 3 : (value - 16 / 116) / 7.787);
	const x = pivot(fx) * 0.95047;
	const y = pivot(fy);
	const z = pivot(fz) * 1.08883;
	const linear = [x * 3.2404542 + y * -1.5371385 + z * -0.4985314, x * -0.969266 + y * 1.8760108 + z * 0.041556, x * 0.0556434 + y * -0.2040259 + z * 1.0572252];
	return linear.map((value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)) as [number, number, number];
}

function hsbToRgb(hue: number, saturation: number, brightness: number): [number, number, number] {
	const sector = (((hue % 1) + 1) % 1) * 6;
	const index = Math.floor(sector);
	const fraction = sector - index;
	const p = brightness * (1 - saturation);
	const q = brightness * (1 - saturation * fraction);
	const t = brightness * (1 - saturation * (1 - fraction));
	const values: Array<[number, number, number]> = [
		[brightness, t, p],
		[q, brightness, p],
		[p, brightness, t],
		[p, q, brightness],
		[t, p, brightness],
		[brightness, p, q],
	];
	return values[index % 6].map((value) => value * 255) as [number, number, number];
}

export interface IPsdGradientCoordinateSpace {
	width: number;
	height: number;
	documentWidth: number;
	documentHeight: number;
	outputLeft: number;
	outputTop: number;
}

type PsdGradientRgb = [number, number, number];

function psdGradientPosition(gradient: IPsdLayerGradientInfo, x: number, y: number, coordinateSpace: IPsdGradientCoordinateSpace): number {
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

function psdGradientInterpolationAmount(gradient: IPsdLayerGradientInfo, amount: number): number {
	const clamped = Math.max(0, Math.min(1, amount));
	if (gradient.interpolation === "classic") {
		return clamped * clamped * (3 - 2 * clamped);
	}
	if (gradient.interpolation === "smooth") {
		return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
	}
	return clamped;
}

function psdSrgbToOklab(color: PsdGradientRgb): PsdGradientRgb {
	const red = srgbToLinear(color[0]);
	const green = srgbToLinear(color[1]);
	const blue = srgbToLinear(color[2]);
	const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
	const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969568 * blue);
	const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
	return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function psdOklabToSrgb(color: PsdGradientRgb): PsdGradientRgb {
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

function interpolatePsdGradientColor(gradient: IPsdLayerGradientInfo, left: PsdGradientRgb, right: PsdGradientRgb, amount: number): PsdGradientRgb {
	const adjusted = psdGradientInterpolationAmount(gradient, amount);
	if (gradient.interpolation === "linear") {
		return left.map((channel, index) => linearToSrgb(srgbToLinear(channel) + (srgbToLinear(right[index]) - srgbToLinear(channel)) * adjusted)) as PsdGradientRgb;
	}
	if (gradient.interpolation === "perceptual") {
		const leftOklab = psdSrgbToOklab(left);
		const rightOklab = psdSrgbToOklab(right);
		return psdOklabToSrgb(leftOklab.map((channel, index) => channel + (rightOklab[index] - channel) * adjusted) as PsdGradientRgb);
	}
	return left.map((channel, index) => channel + (right[index] - channel) * adjusted) as PsdGradientRgb;
}

const PSD_GRADIENT_DITHER_8X8 = [
	0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17,
	45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];

function psdGradientRandom(seed: number): () => number {
	let state = seed >>> 0;
	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function createPsdNoiseGradientSamples(gradient: IPsdLayerGradientInfo): Array<{ color: PsdGradientRgb; opacity: number }> {
	const random = psdGradientRandom(gradient.randomSeed!);
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
	return channels.map((values) => {
		let color: PsdGradientRgb;
		if (gradient.colorModel === "hsb") {
			color = hsbToRgb(values[0], values[1], values[2]).map((value) => value / 255) as PsdGradientRgb;
		} else if (gradient.colorModel === "hsl") {
			color = hslToRgb(values[0], values[1], values[2]).map((value) => value / 255) as PsdGradientRgb;
		} else if (gradient.colorModel === "lab") {
			color = labToRgb(values[0] * 100, values[1] * 255 - 128, values[2] * 255 - 128).map((value) => value / 255) as PsdGradientRgb;
		} else {
			color = [values[0], values[1], values[2]];
		}
		if (gradient.restrictColors) {
			const luminance = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
			color = color.map((channel) => luminance + (channel - luminance) * 0.75) as PsdGradientRgb;
		}
		return { color: color.map((channel) => Math.max(0, Math.min(1, channel))) as PsdGradientRgb, opacity: gradient.addTransparency ? values[3] : 1 };
	});
}

/** Samples one deterministic RGBA8 pixel from a bounded PSD solid or seeded-noise gradient. */
export function samplePsdGradientPixel(
	gradient: IPsdLayerGradientInfo,
	x: number,
	y: number,
	coordinateSpace: IPsdGradientCoordinateSpace,
	noiseSamples: Array<{ color: PsdGradientRgb; opacity: number }> | null = null
): [number, number, number, number] {
	if (!gradient.bakeSupported || coordinateSpace.width <= 0 || coordinateSpace.height <= 0 || coordinateSpace.documentWidth <= 0 || coordinateSpace.documentHeight <= 0) {
		throw new Error("Unsupported PSD gradient sample: the descriptor or coordinate space exceeds bounded rendering requirements.");
	}
	const position = psdGradientPosition(gradient, x, y, coordinateSpace);
	let color: PsdGradientRgb;
	let opacity: number;
	if (gradient.type === "noise") {
		const samples = noiseSamples ?? createPsdNoiseGradientSamples(gradient);
		const exact = position * (samples.length - 1);
		const left = Math.floor(exact);
		const right = Math.min(samples.length - 1, left + 1);
		const amount = exact - left;
		color = samples[left].color.map((channel, index) => channel + (samples[right].color[index] - channel) * amount) as PsdGradientRgb;
		opacity = samples[left].opacity + (samples[right].opacity - samples[left].opacity) * amount;
	} else {
		const colors = sampleGradientStops(gradient.colorStops, position);
		const leftColor = colors.left.color.rgba!;
		const rightColor = colors.right.color.rgba!;
		const opacityStops = sampleGradientStops(gradient.opacityStops, position);
		color = interpolatePsdGradientColor(
			gradient,
			[leftColor[0] / 255, leftColor[1] / 255, leftColor[2] / 255],
			[rightColor[0] / 255, rightColor[1] / 255, rightColor[2] / 255],
			colors.amount
		);
		opacity = (opacityStops.left.opacity + (opacityStops.right.opacity - opacityStops.left.opacity) * psdGradientInterpolationAmount(gradient, opacityStops.amount)) / 100;
	}
	if (gradient.dither) {
		const adjustment = ((PSD_GRADIENT_DITHER_8X8[(((coordinateSpace.outputTop + y) & 7) << 3) | ((coordinateSpace.outputLeft + x) & 7)] + 0.5) / 64 - 0.5) / 255;
		color = color.map((channel) => Math.max(0, Math.min(1, channel + adjustment))) as PsdGradientRgb;
	}
	return [clampAdjustmentByte(color[0] * 255), clampAdjustmentByte(color[1] * 255), clampAdjustmentByte(color[2] * 255), clampAdjustmentByte(opacity * 255)];
}

function applyGradientMapColor(red: number, green: number, blue: number, adjustment: IPsdGradientMapAdjustmentInfo): [number, number, number, number] {
	let position = Math.max(0, Math.min(1, (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255));
	if (adjustment.reverse) {
		position = 1 - position;
	}
	if (adjustment.gradientType === "solid") {
		const colors = sampleGradientStops(adjustment.colorStops, position);
		const amount = interpolateGradientAmount(colors.amount, adjustment.method);
		const left = colors.left.color.rgba!;
		const right = colors.right.color.rgba!;
		const opacity = sampleGradientStops(adjustment.opacityStops, position);
		const opacityAmount = interpolateGradientAmount(opacity.amount, adjustment.method);
		const coverage = opacity.left.opacity * (1 - opacityAmount) + opacity.right.opacity * opacityAmount;
		const dither = adjustment.dither ? seededGradientNoise(adjustment.randomSeed, 7, (red * 65536 + green * 256 + blue) / 0xffffff, 0.5) - 0.5 : 0;
		return [
			left[0] * (1 - amount) + right[0] * amount + dither,
			left[1] * (1 - amount) + right[1] * amount + dither,
			left[2] * (1 - amount) + right[2] * amount + dither,
			coverage,
		];
	}
	const values = adjustment.minimum.map((minimum, channel) => {
		const noise = seededGradientNoise(adjustment.randomSeed, channel, position, adjustment.roughness);
		return minimum + (adjustment.maximum[channel] - minimum) * noise;
	}) as [number, number, number, number];
	let mapped: [number, number, number];
	if (adjustment.colorModel === "hsb") {
		mapped = hsbToRgb(values[0], adjustment.restrictColors ? Math.min(values[1], 0.8) : values[1], values[2]);
	} else if (adjustment.colorModel === "lab") {
		mapped = labToRgb(values[0] * 100, values[1] * 255 - 128, values[2] * 255 - 128);
	} else {
		mapped = [values[0] * 255, values[1] * 255, values[2] * 255];
	}
	return [...mapped, adjustment.addTransparency ? values[3] : 1];
}

function applyPhotoFilterColor(red: number, green: number, blue: number, adjustment: IPsdPhotoFilterAdjustmentInfo): [number, number, number] {
	const filter = adjustment.color.rgba!;
	const amount = adjustment.density / 100;
	const blended: [number, number, number] = [red * (1 - amount) + filter[0] * amount, green * (1 - amount) + filter[1] * amount, blue * (1 - amount) + filter[2] * amount];
	if (!adjustment.preserveLuminosity) {
		return blended;
	}
	const source = rgbToHsl(red, green, blue);
	const result = rgbToHsl(...blended);
	return hslToRgb(result.hue, result.saturation, source.lightness);
}

function applyColorLookupColor(red: number, green: number, blue: number, adjustment: IPsdColorLookupAdjustmentInfo): [number, number, number] {
	const table = parsedColorLookupTables.get(adjustment);
	if (!table) {
		return [red, green, blue];
	}
	const source = adjustment.dataOrder === "rgb" ? [red / 255, green / 255, blue / 255] : [blue / 255, green / 255, red / 255];
	const coordinates = source.map(
		(value, channel) =>
			Math.max(0, Math.min(1, (value - adjustment.domainMinimum[channel]) / (adjustment.domainMaximum[channel] - adjustment.domainMinimum[channel]))) * (table.size - 1)
	);
	const lower = coordinates.map(Math.floor);
	const upper = coordinates.map((value) => Math.min(table.size - 1, Math.ceil(value)));
	const fraction = coordinates.map((value, channel) => value - lower[channel]);
	const sample = (x: number, y: number, z: number, channel: number): number => {
		const index = adjustment.tableOrder === "rgb" ? (z * table.size * table.size + y * table.size + x) * 3 : (x * table.size * table.size + y * table.size + z) * 3;
		return table.values[index + channel];
	};
	const result: [number, number, number] = [0, 0, 0];
	for (let channel = 0; channel < 3; ++channel) {
		for (let corner = 0; corner < 8; ++corner) {
			const xHigh = (corner & 1) !== 0;
			const yHigh = (corner & 2) !== 0;
			const zHigh = (corner & 4) !== 0;
			const weight = (xHigh ? fraction[0] : 1 - fraction[0]) * (yHigh ? fraction[1] : 1 - fraction[1]) * (zHigh ? fraction[2] : 1 - fraction[2]);
			result[channel] += sample(xHigh ? upper[0] : lower[0], yHigh ? upper[1] : lower[1], zHigh ? upper[2] : lower[2], channel) * weight * 255;
		}
	}
	if (adjustment.dataOrder === "bgr") {
		result.reverse();
	}
	if (adjustment.dither) {
		const dither = seededGradientNoise(adjustment.lut3DFileBytes, 11, (red * 65536 + green * 256 + blue) / 0xffffff, 0.5) - 0.5;
		return result.map((value) => value + dither) as [number, number, number];
	}
	return result;
}

/** Applies one parsed bounded RGB adjustment to RGBA8 pixels while preserving alpha. */
export function applyPsdLayerAdjustment(pixels: Uint8Array, adjustment: IPsdLayerAdjustmentInfo, opacity = 255, coverage?: Uint8Array): Uint8Array {
	if (pixels.byteLength % 4 !== 0) {
		throw new Error("PSD adjustment input must contain complete RGBA8 pixels.");
	}
	if (!Number.isInteger(opacity) || opacity < 0 || opacity > 255) {
		throw new Error("PSD adjustment opacity must be an integer from 0 to 255.");
	}
	if (coverage && coverage.byteLength !== pixels.byteLength / 4) {
		throw new Error("PSD adjustment mask coverage must contain one byte per RGBA8 pixel.");
	}
	if (!adjustment.bakeSupported || opacity === 0) {
		return new Uint8Array(pixels);
	}
	const output = new Uint8Array(pixels);
	for (let offset = 0; offset < pixels.byteLength; offset += 4) {
		const mix = (opacity / 255) * (coverage ? coverage[offset / 4] / 255 : 1);
		const adjusted: [number, number, number] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
		if (adjustment.key === "blnc") {
			const transformed = applyColorBalanceColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "blwh") {
			const transformed = applyBlackWhiteColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "mixr") {
			const transformed = applyChannelMixerColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "selc") {
			const transformed = applySelectiveColorColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "grdm") {
			const transformed = applyGradientMapColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = adjusted[0] * (1 - transformed[3]) + transformed[0] * transformed[3];
			adjusted[1] = adjusted[1] * (1 - transformed[3]) + transformed[1] * transformed[3];
			adjusted[2] = adjusted[2] * (1 - transformed[3]) + transformed[2] * transformed[3];
		} else if (adjustment.key === "phfl") {
			const transformed = applyPhotoFilterColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "clrL") {
			const transformed = applyColorLookupColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "brit") {
			const contrast = adjustment.contrast * 2.55;
			const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
			for (let channel = 0; channel < 3; ++channel) {
				adjusted[channel] = factor * (adjusted[channel] - adjustment.mean) + adjustment.mean + adjustment.brightness * 2.55;
			}
		} else if (adjustment.key === "curv") {
			const curves = [adjustment.red, adjustment.green, adjustment.blue];
			for (let channel = 0; channel < 3; ++channel) {
				adjusted[channel] = applyCurveValue(applyCurveValue(adjusted[channel], adjustment.master), curves[channel]);
			}
		} else if (adjustment.key === "expA") {
			for (let channel = 0; channel < 3; ++channel) {
				adjusted[channel] = applyExposureValue(adjusted[channel], adjustment.exposure, adjustment.offset, adjustment.gamma);
			}
		} else if (adjustment.key === "hue " || adjustment.key === "hue2") {
			const transformed = applyHueSaturationColor(adjusted[0], adjusted[1], adjusted[2], adjustment);
			adjusted[0] = transformed[0];
			adjusted[1] = transformed[1];
			adjusted[2] = transformed[2];
		} else if (adjustment.key === "vibA") {
			const vibrant = applyVibranceColor(adjusted[0], adjusted[1], adjusted[2], adjustment.vibrance, adjustment.saturation);
			adjusted[0] = vibrant[0];
			adjusted[1] = vibrant[1];
			adjusted[2] = vibrant[2];
		} else if (adjustment.key === "levl") {
			const records = [adjustment.red, adjustment.green, adjustment.blue];
			for (let channel = 0; channel < 3; ++channel) {
				adjusted[channel] = applyLevelsValue(applyLevelsValue(adjusted[channel], adjustment.master), records[channel]);
			}
		} else if (adjustment.key === "nvrt") {
			for (let channel = 0; channel < 3; ++channel) {
				adjusted[channel] = 255 - adjusted[channel];
			}
		} else if (adjustment.key === "post") {
			const step = 255 / (adjustment.levels - 1);
			for (let channel = 0; channel < 3; ++channel) {
				adjusted[channel] = Math.round(adjusted[channel] / step) * step;
			}
		} else if (adjustment.key === "thrs") {
			const luminance = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
			adjusted.fill(luminance >= adjustment.threshold ? 255 : 0);
		}
		for (let channel = 0; channel < 3; ++channel) {
			output[offset + channel] = clampAdjustmentByte(pixels[offset + channel] * (1 - mix) + adjusted[channel] * mix);
		}
	}
	return output;
}

/** Reads bounded Photoshop PSD-v1 or PSB-v2 layer records and extraction capability without allocating layer pixels. */
export function inspectPsdLayers(bytes: Uint8Array): IPsdLayerDocumentInfo {
	return parsePsdLayers(bytes).document;
}

/** Returns bounded embedded smart-object payload bytes; external and alias records remain metadata-only. */
export function decodePsdSmartObjectResources(bytes: Uint8Array): IDecodedPsdSmartObjectResource[] {
	return parsePsdLayers(bytes)
		.smartObjectResources.filter((resource) => resource.type === "embedded" && resource.dataOffset !== null)
		.map(
			({
				dataOffset,
				declaredDataSizeOffset: _declaredDataSizeOffset,
				recordSizeOffset: _recordSizeOffset,
				recordOffset: _recordOffset,
				recordEnd: _recordEnd,
				paddedRecordEnd: _paddedRecordEnd,
				tagLengthOffset: _tagLengthOffset,
				tagDataBytes: _tagDataBytes,
				...resource
			}) => ({
				...resource,
				data: bytes.slice(dataOffset!, dataOffset! + resource.dataBytes),
			})
		);
}

function encodePsdUint32(value: number, label: string): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
		throw new Error(`${label} exceeds the PSD-v1 32-bit section limit.`);
	}
	const output = new Uint8Array(4);
	new DataView(output.buffer).setUint32(0, value, false);
	return output;
}

function encodePsdUint64(value: number, label: string): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} is not a safe non-negative byte length.`);
	}
	const output = new Uint8Array(8);
	const view = new DataView(output.buffer);
	view.setUint32(0, Math.floor(value / 0x100000000), false);
	view.setUint32(4, value >>> 0, false);
	return output;
}

function concatenatePsdBytes(parts: Uint8Array[]): Uint8Array {
	const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
	const output = new Uint8Array(byteLength);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

/** Rebuilds selected top-level embedded liFD records into a new validated PSD-v1 byte buffer. The input is never mutated. */
export function replacePsdEmbeddedSmartObjectPayloads(
	bytes: Uint8Array,
	replacements: IPsdEmbeddedSmartObjectPayloadReplacement[]
): IPsdEmbeddedSmartObjectPayloadReplacementResult {
	if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 128) {
		throw new Error("PSD smart-object replacement requires 1-128 embedded resource replacements.");
	}
	const image = parsePsd(bytes);
	if (image.version !== 1) {
		throw new Error("Semantic embedded smart-object payload replacement is currently bounded to PSD-v1 documents; PSB-v2 sources are inspection/extraction-only.");
	}
	const parsed = parsePsdLayers(bytes);
	const indices = new Set<number>();
	let aggregateReplacementBytes = 0;
	type Patch = { start: number; end: number; data: Uint8Array };
	const patches: Patch[] = [];
	const tagDeltas = new Map<number, { previousBytes: number; delta: number }>();
	const items: IPsdEmbeddedSmartObjectPayloadReplacementResult["items"] = [];
	let totalDelta = 0;
	for (const replacement of replacements) {
		if (!replacement || !Number.isSafeInteger(replacement.resourceIndex) || replacement.resourceIndex < 0 || replacement.resourceIndex >= parsed.smartObjectResources.length) {
			throw new Error("Each PSD smart-object replacement must reference an existing non-negative integer resourceIndex.");
		}
		if (indices.has(replacement.resourceIndex)) {
			throw new Error(`PSD smart-object replacements contain duplicate resourceIndex ${replacement.resourceIndex}.`);
		}
		indices.add(replacement.resourceIndex);
		if (!(replacement.data instanceof Uint8Array) || replacement.data.byteLength < 1 || replacement.data.byteLength > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
			throw new Error(`PSD smart-object replacement ${replacement.resourceIndex} must contain 1 byte to 256 MiB.`);
		}
		aggregateReplacementBytes += replacement.data.byteLength;
		if (aggregateReplacementBytes > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
			throw new Error("PSD smart-object replacement payloads exceed the 256 MiB aggregate limit.");
		}
		const resource = parsed.smartObjectResources[replacement.resourceIndex];
		if (resource.type !== "embedded" || resource.recordSignature !== "liFD" || resource.dataOffset === null) {
			throw new Error(`PSD smart-object resource ${replacement.resourceIndex} is not an embedded liFD payload.`);
		}
		const body = bytes.slice(resource.recordOffset, resource.recordEnd);
		const dataStart = resource.dataOffset - resource.recordOffset;
		const dataEnd = dataStart + resource.dataBytes;
		const declaredSizeOffset = resource.declaredDataSizeOffset - resource.recordOffset;
		const prefix = Uint8Array.from(body.subarray(0, dataStart));
		prefix.set(encodePsdUint64(replacement.data.byteLength, `PSD smart-object resource ${replacement.resourceIndex} data size`), declaredSizeOffset);
		const updatedBody = concatenatePsdBytes([prefix, replacement.data, body.slice(dataEnd)]);
		const updatedRecord = concatenatePsdBytes([
			encodePsdUint64(updatedBody.byteLength, `PSD smart-object resource ${replacement.resourceIndex} record size`),
			updatedBody,
			new Uint8Array((4 - (updatedBody.byteLength % 4)) % 4),
		]);
		const previousRecordBytes = resource.paddedRecordEnd - resource.recordSizeOffset;
		const delta = updatedRecord.byteLength - previousRecordBytes;
		patches.push({ start: resource.recordSizeOffset, end: resource.paddedRecordEnd, data: updatedRecord });
		const tag = tagDeltas.get(resource.tagLengthOffset) ?? { previousBytes: resource.tagDataBytes, delta: 0 };
		tag.delta += delta;
		tagDeltas.set(resource.tagLengthOffset, tag);
		totalDelta += delta;
		items.push({
			resourceIndex: resource.index,
			resourceId: resource.id,
			resourceName: resource.name,
			fileType: resource.fileType,
			sourceKey: resource.sourceKey,
			previousByteLength: resource.dataBytes,
			replacementByteLength: replacement.data.byteLength,
			executionModel: "bounded-smart-object-payload-replacement-v1",
		});
	}
	for (const [tagLengthOffset, tag] of tagDeltas) {
		patches.push({ start: tagLengthOffset, end: tagLengthOffset + 4, data: encodePsdUint32(tag.previousBytes + tag.delta, "PSD linked-resource tagged-block length") });
	}
	patches.push({
		start: image.layerAndMaskOffset - 4,
		end: image.layerAndMaskOffset,
		data: encodePsdUint32(image.layerAndMaskBytes + totalDelta, "PSD layer-and-mask section length"),
	});
	patches.sort((left, right) => left.start - right.start);
	for (let index = 0; index < patches.length; ++index) {
		const patch = patches[index];
		if (patch.start < 0 || patch.end < patch.start || patch.end > bytes.byteLength || (index > 0 && patch.start < patches[index - 1].end)) {
			throw new Error("PSD smart-object replacement produced overlapping or invalid binary patches.");
		}
	}
	const parts: Uint8Array[] = [];
	let cursor = 0;
	for (const patch of patches) {
		parts.push(bytes.slice(cursor, patch.start), patch.data);
		cursor = patch.end;
	}
	parts.push(bytes.slice(cursor));
	const data = concatenatePsdBytes(parts);
	if (data.byteLength > 512 * 1024 * 1024) {
		throw new Error("Rewritten PSD smart-object document exceeds the 512 MiB output limit.");
	}
	inspectPsdLayers(data);
	return { data, items, executionModel: "bounded-smart-object-payload-replacement-v1" };
}

/** Rebuilds exact non-overlapping embedded liFD resource paths through nested PSD-v1 documents. The input and selected replacement bytes are never mutated. */
export function replacePsdNestedEmbeddedSmartObjectPayloads(
	bytes: Uint8Array,
	replacements: IPsdNestedEmbeddedSmartObjectPayloadReplacement[]
): IPsdNestedEmbeddedSmartObjectPayloadReplacementResult {
	if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 128) {
		throw new Error("Recursive PSD smart-object replacement requires 1-128 embedded resource replacements.");
	}
	let aggregateReplacementBytes = 0;
	const pathKeys = new Set<string>();
	for (const replacement of replacements) {
		if (!replacement || !Array.isArray(replacement.resourcePath) || replacement.resourcePath.length < 1 || replacement.resourcePath.length > 8) {
			throw new Error("Each recursive PSD smart-object replacement resourcePath must contain 1-8 resource indices.");
		}
		if (replacement.resourcePath.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 1023)) {
			throw new Error("Each recursive PSD smart-object resourcePath index must be an integer between 0 and 1,023.");
		}
		const key = replacement.resourcePath.join("/");
		if (pathKeys.has(key)) {
			throw new Error(`Recursive PSD smart-object replacements contain duplicate resourcePath ${key}.`);
		}
		pathKeys.add(key);
		if (!(replacement.data instanceof Uint8Array) || replacement.data.byteLength < 1 || replacement.data.byteLength > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
			throw new Error(`Recursive PSD smart-object replacement ${key} must contain 1 byte to 256 MiB.`);
		}
		aggregateReplacementBytes += replacement.data.byteLength;
		if (aggregateReplacementBytes > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
			throw new Error("Recursive PSD smart-object replacement payloads exceed the 256 MiB aggregate limit.");
		}
	}
	const sortedPaths = [...pathKeys].map((key) => key.split("/").map(Number));
	for (let left = 0; left < sortedPaths.length; ++left) {
		for (let right = left + 1; right < sortedPaths.length; ++right) {
			const shorter = sortedPaths[left].length <= sortedPaths[right].length ? sortedPaths[left] : sortedPaths[right];
			const longer = shorter === sortedPaths[left] ? sortedPaths[right] : sortedPaths[left];
			if (shorter.every((value, index) => longer[index] === value)) {
				throw new Error(`Recursive PSD smart-object replacement paths ${shorter.join("/")} and ${longer.join("/")} overlap.`);
			}
		}
	}
	let aggregateTraversedBytes = 0;
	const items: IPsdNestedEmbeddedSmartObjectPayloadReplacementResult["items"] = [];
	const ancestorRebuilds: IPsdNestedEmbeddedSmartObjectPayloadReplacementResult["ancestorRebuilds"] = [];
	const rewrite = (
		documentBytes: Uint8Array,
		requests: Array<{ path: number[]; data: Uint8Array }>,
		resourcePathPrefix: number[],
		resourceIdPathPrefix: string[]
	): Uint8Array => {
		const document = inspectPsdLayers(documentBytes);
		const decodedResources = new Map(decodePsdSmartObjectResources(documentBytes).map((resource) => [resource.index, resource]));
		const grouped = new Map<number, Array<{ path: number[]; data: Uint8Array }>>();
		for (const request of requests) {
			const group = grouped.get(request.path[0]) ?? [];
			group.push(request);
			grouped.set(request.path[0], group);
		}
		const direct: IPsdEmbeddedSmartObjectPayloadReplacement[] = [];
		for (const [resourceIndex, group] of grouped) {
			const resource = document.smartObjectResources[resourceIndex];
			const decoded = decodedResources.get(resourceIndex);
			if (!resource || resource.index !== resourceIndex || resource.type !== "embedded" || resource.recordSignature !== "liFD" || !decoded) {
				throw new Error(`Recursive PSD smart-object resource path ${[...resourcePathPrefix, resourceIndex].join("/")} is not an embedded liFD payload.`);
			}
			const fullResourcePath = [...resourcePathPrefix, resourceIndex];
			const fullResourceIdPath = [...resourceIdPathPrefix, resource.id];
			const directRequest = group.find((request) => request.path.length === 1);
			let replacementData: Uint8Array;
			if (directRequest) {
				replacementData = directRequest.data;
				items.push({
					resourcePath: fullResourcePath,
					resourceIdPath: fullResourceIdPath,
					depth: fullResourcePath.length,
					resourceIndex,
					resourceId: resource.id,
					resourceName: resource.name,
					fileType: resource.fileType,
					sourceKey: resource.sourceKey,
					previousByteLength: resource.dataBytes,
					replacementByteLength: replacementData.byteLength,
					executionModel: "bounded-recursive-smart-object-payload-replacement-v1",
				});
			} else {
				aggregateTraversedBytes += decoded.data.byteLength;
				if (aggregateTraversedBytes > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
					throw new Error("Recursive PSD smart-object replacement exceeds the 256 MiB aggregate nested traversal limit.");
				}
				if (
					decoded.data.byteLength < 6 ||
					readAscii(decoded.data, 0, 4, "nested smart-object signature") !== "8BPS" ||
					readUint16(decoded.data, 4, "nested smart-object version") !== 1
				) {
					throw new Error(`Recursive PSD smart-object resource path ${fullResourcePath.join("/")} is not a PSD-v1 document.`);
				}
				replacementData = rewrite(
					decoded.data,
					group.map((request) => ({ path: request.path.slice(1), data: request.data })),
					fullResourcePath,
					fullResourceIdPath
				);
				ancestorRebuilds.push({
					resourcePath: fullResourcePath,
					resourceIdPath: fullResourceIdPath,
					depth: fullResourcePath.length,
					resourceIndex,
					resourceId: resource.id,
					resourceName: resource.name,
					previousByteLength: resource.dataBytes,
					replacementByteLength: replacementData.byteLength,
				});
			}
			direct.push({ resourceIndex, data: replacementData });
		}
		return replacePsdEmbeddedSmartObjectPayloads(documentBytes, direct).data;
	};
	const data = rewrite(
		bytes,
		replacements.map((replacement) => ({ path: [...replacement.resourcePath], data: replacement.data })),
		[],
		[]
	);
	return { data, items, ancestorRebuilds, executionModel: "bounded-recursive-smart-object-payload-replacement-v1" };
}

/** Recursively inspects embedded PSD-v1 or PSB-v2 smart-object documents without resolving external resources or mutating payloads. */
export function inspectPsdNestedSmartObjectDocuments(bytes: Uint8Array, maximumDepth = 4): IPsdNestedSmartObjectDocumentInfo[] {
	if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 8) {
		throw new Error("PSD nested smart-object maximumDepth must be an integer between 1 and 8.");
	}
	const result: IPsdNestedSmartObjectDocumentInfo[] = [];
	let aggregatePayloadBytes = 0;
	const summarizeDocument = (document: IPsdLayerDocumentInfo): NonNullable<IPsdNestedSmartObjectDocumentInfo["document"]> => ({
		version: document.version,
		format: document.format,
		width: document.width,
		height: document.height,
		depth: document.depth,
		sampleByteLength: document.sampleByteLength,
		channelConversionModel: document.channelConversionModel,
		layerInfoSource: document.layerInfoSource,
		colorMode: document.colorMode,
		layerCount: document.layerCount,
		totalPixelLayerPixels: document.totalPixelLayerPixels,
		pixelLayerCount: document.layers.filter((layer) => layer.kind === "pixel").length,
		textLayerCount: document.layers.filter((layer) => layer.text !== null).length,
		smartObjectLayerCount: document.layers.filter((layer) => layer.smartObject !== null).length,
		groupRecordCount: document.layers.filter((layer) => layer.kind === "groupStart" || layer.kind === "groupEnd").length,
		smartObjectResourceCount: document.smartObjectResources.length,
		embeddedResourceCount: document.smartObjectResources.filter((resource) => resource.type === "embedded").length,
		externalResourceCount: document.smartObjectResources.filter((resource) => resource.type === "external").length,
		aliasResourceCount: document.smartObjectResources.filter((resource) => resource.type === "alias").length,
	});
	const inspect = (documentBytes: Uint8Array, parsed: ReturnType<typeof parsePsdLayers>, resourcePath: number[], resourceIdPath: string[], depth: number): void => {
		for (const resource of parsed.smartObjectResources) {
			if (resource.type !== "embedded" || resource.dataOffset === null) {
				continue;
			}
			if (result.length >= 128) {
				throw new Error("PSD nested smart-object inspection is limited to 128 embedded resources.");
			}
			aggregatePayloadBytes += resource.dataBytes;
			if (aggregatePayloadBytes > MAXIMUM_PSD_SMART_OBJECT_PAYLOAD_BYTES) {
				throw new Error("PSD nested smart-object inspection is limited to 256 MiB of aggregate embedded payload bytes.");
			}
			const payload = documentBytes.slice(resource.dataOffset, resource.dataOffset + resource.dataBytes);
			const nextResourcePath = [...resourcePath, resource.index];
			const nextResourceIdPath = [...resourceIdPath, resource.id];
			const signature = payload.byteLength >= 4 ? String.fromCharCode(payload[0], payload[1], payload[2], payload[3]) : "";
			const version = payload.byteLength >= 6 ? (payload[4] << 8) | payload[5] : 0;
			const format: IPsdNestedSmartObjectDocumentInfo["format"] = signature === "8BPS" ? (version === 1 ? "psd-v1" : version === 2 ? "psb-v2" : "other") : "other";
			const base = {
				resourcePath: nextResourcePath,
				resourceIdPath: nextResourceIdPath,
				depth,
				resourceIndex: resource.index,
				resourceId: resource.id,
				resourceName: resource.name,
				fileType: resource.fileType,
				byteLength: resource.dataBytes,
				format,
				executionModel: "bounded-nested-smart-object-v1" as const,
			};
			if (format !== "psd-v1" && format !== "psb-v2") {
				result.push({
					...base,
					status: "unsupported",
					document: null,
					message: "Embedded payload is not a PSD-v1 or PSB-v2 document.",
				});
				continue;
			}
			if (depth > maximumDepth) {
				result.push({ ...base, status: "depthLimit", document: null, message: `Nested ${format} payload exceeds the requested maximum depth ${maximumDepth}.` });
				continue;
			}
			let nested: ReturnType<typeof parsePsdLayers>;
			try {
				nested = parsePsdLayers(payload);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.push({ ...base, status: "malformed", document: null, message: message.slice(0, 512) });
				continue;
			}
			result.push({ ...base, status: "inspected", document: summarizeDocument(nested.document), message: null });
			inspect(payload, nested, nextResourcePath, nextResourceIdPath, depth + 1);
		}
	};
	inspect(bytes, parsePsdLayers(bytes), [], [], 1);
	return result;
}

/** Samples bounded raster/real-user/vector masks from arbitrary layer records over one target rectangle. */
export function decodePsdLayerMasks(
	bytes: Uint8Array,
	layerIndices: number[],
	target: { left: number; top: number; width: number; height: number },
	options: { includeRaster?: boolean; includeVector?: boolean } = {}
): IDecodedPsdLayerMask[] {
	if (
		!Number.isInteger(target.left) ||
		!Number.isInteger(target.top) ||
		!Number.isInteger(target.width) ||
		!Number.isInteger(target.height) ||
		target.width <= 0 ||
		target.height <= 0 ||
		target.width > MAXIMUM_PSD_DIMENSION ||
		target.height > MAXIMUM_PSD_DIMENSION ||
		target.width * target.height > MAXIMUM_PSD_LAYER_PIXELS
	) {
		throw new Error("PSD adjustment-mask target bounds exceed the bounded layer limits.");
	}
	const requested = new Set(layerIndices);
	const includeRaster = options.includeRaster !== false;
	const includeVector = options.includeVector !== false;
	const parsed = parsePsdLayers(bytes);
	const result: IDecodedPsdLayerMask[] = [];
	for (const owner of parsed.layers) {
		if (!requested.has(owner.index) || (!owner.mask && !owner.vectorMask)) {
			continue;
		}
		const targetLayer: IParsedPsdLayer = { ...owner, ...target };
		const output = new Uint8Array(target.width * target.height * 4);
		for (let offset = 3; offset < output.byteLength; offset += 4) {
			output[offset] = 255;
		}
		const maskChannel = owner.channels.find((channel) => channel.id === -2);
		if (includeRaster && owner.mask && maskChannel && !owner.mask.disabled) {
			applyPsdLayerMask(output, targetLayer, decodePsdLayerChannel(bytes, owner, maskChannel), owner.mask, {
				density: owner.mask.userDensity,
				feather: owner.mask.userFeather,
				maskOwner: owner,
			});
		}
		const realUserMaskChannel = owner.channels.find((channel) => channel.id === -3);
		if (includeRaster && owner.mask?.realUserMask && realUserMaskChannel && !owner.mask.realUserMask.disabled) {
			applyPsdLayerMask(output, targetLayer, decodePsdLayerChannel(bytes, owner, realUserMaskChannel), owner.mask.realUserMask, {
				density: null,
				feather: null,
				maskOwner: owner,
			});
		}
		if (includeVector) {
			applyPsdVectorMask(output, targetLayer, parsed.document.width, parsed.document.height);
		}
		const coverage = new Uint8Array(target.width * target.height);
		for (let pixel = 0; pixel < coverage.length; ++pixel) {
			coverage[pixel] = output[pixel * 4 + 3];
		}
		result.push({ layerIndex: owner.index, coverage, executionModel: "bounded-layer-mask-v1" });
	}
	return result;
}

/** Samples bounded raster/real-user/vector masks from adjustment layers over one target layer rectangle. */
export function decodePsdAdjustmentMasks(
	bytes: Uint8Array,
	layerIndices: number[],
	target: { left: number; top: number; width: number; height: number }
): IDecodedPsdAdjustmentMask[] {
	const requested = new Set(layerIndices);
	const adjustmentIndices = inspectPsdLayers(bytes)
		.layers.filter((layer) => requested.has(layer.index) && layer.kind === "adjustment")
		.map((layer) => layer.index);
	return decodePsdLayerMasks(bytes, adjustmentIndices, target).map((mask) => ({
		layerIndex: mask.layerIndex,
		coverage: mask.coverage,
		executionModel: "bounded-adjustment-mask-v1",
	}));
}

type PsdRgb = [number, number, number];

function blendPsdVectorChannel(mode: string, backdrop: number, source: number): number {
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

function psdVectorLuminosity(color: PsdRgb): number {
	return color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
}

function psdVectorSaturation(color: PsdRgb): number {
	return Math.max(...color) - Math.min(...color);
}

function clipPsdVectorColor(color: PsdRgb): PsdRgb {
	const lightness = psdVectorLuminosity(color);
	const minimum = Math.min(...color);
	const maximum = Math.max(...color);
	let result: PsdRgb = [...color];
	if (minimum < 0) {
		result = result.map((channel) => lightness + ((channel - lightness) * lightness) / (lightness - minimum)) as PsdRgb;
	}
	if (maximum > 1) {
		result = result.map((channel) => lightness + ((channel - lightness) * (1 - lightness)) / (maximum - lightness)) as PsdRgb;
	}
	return result;
}

function setPsdVectorLuminosity(color: PsdRgb, value: number): PsdRgb {
	const difference = value - psdVectorLuminosity(color);
	return clipPsdVectorColor(color.map((channel) => channel + difference) as PsdRgb);
}

function setPsdVectorSaturation(color: PsdRgb, value: number): PsdRgb {
	const result: PsdRgb = [...color];
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

function blendPsdVectorColor(mode: string, backdrop: PsdRgb, source: PsdRgb): PsdRgb {
	switch (mode) {
		case "hue ":
			return setPsdVectorLuminosity(setPsdVectorSaturation(source, psdVectorSaturation(backdrop)), psdVectorLuminosity(backdrop));
		case "sat ":
			return setPsdVectorLuminosity(setPsdVectorSaturation(backdrop, psdVectorSaturation(source)), psdVectorLuminosity(backdrop));
		case "colr":
			return setPsdVectorLuminosity(source, psdVectorLuminosity(backdrop));
		case "lum ":
			return setPsdVectorLuminosity(backdrop, psdVectorLuminosity(source));
		default:
			return backdrop.map((channel, index) => blendPsdVectorChannel(mode, channel, source[index])) as PsdRgb;
	}
}

function compositePsdVectorStrokePixel(output: Uint8Array, offset: number, rgba: [number, number, number, number], coverage: number, stroke: IPsdVectorStrokeInfo): void {
	const sourceAlpha = (rgba[3] / 255) * coverage * (stroke.opacity / 100);
	if (sourceAlpha <= 0) {
		return;
	}
	const destinationAlpha = output[offset + 3] / 255;
	const backdrop = [output[offset] / 255, output[offset + 1] / 255, output[offset + 2] / 255] satisfies PsdRgb;
	const source = [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255] satisfies PsdRgb;
	const blended = blendPsdVectorColor(stroke.blendMode, backdrop, source);
	const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
	for (let channel = 0; channel < 3; ++channel) {
		const effectiveSource = source[channel] * (1 - destinationAlpha) + blended[channel] * destinationAlpha;
		const premultiplied = effectiveSource * sourceAlpha + backdrop[channel] * destinationAlpha * (1 - sourceAlpha);
		output[offset + channel] = Math.round(Math.max(0, Math.min(1, outputAlpha > 0 ? premultiplied / outputAlpha : 0)) * 255);
	}
	output[offset + 3] = Math.round(outputAlpha * 255);
}

function samplePsdVectorContent(
	content: IPsdVectorContentInfo,
	x: number,
	y: number,
	coordinateSpace: { width: number; height: number; documentWidth: number; documentHeight: number; outputLeft: number; outputTop: number },
	decodedPatterns: ReadonlyMap<number, IDecodedPsdPattern>,
	noiseSamples: Array<{ color: PsdGradientRgb; opacity: number }> | null
): [number, number, number, number] {
	if (content.color?.rgba) {
		return content.color.rgba;
	}
	if (content.gradient) {
		return samplePsdGradientPixel(content.gradient, x, y, coordinateSpace, noiseSamples);
	}
	if (content.pattern) {
		const decodedPattern = content.pattern.resolvedPatternIndex === null ? undefined : decodedPatterns.get(content.pattern.resolvedPatternIndex);
		if (!decodedPattern) {
			throw new Error(`Unsupported PSD vector pattern ${content.pattern.id}; embedded pattern pixels are unavailable.`);
		}
		return samplePsdPatternPixel(content.pattern, decodedPattern, x, y, coordinateSpace);
	}
	return [0, 0, 0, 0];
}

function renderPsdVectorStroke(
	output: Uint8Array,
	layer: IParsedPsdLayer,
	stroke: IPsdVectorStrokeInfo,
	documentWidth: number,
	documentHeight: number,
	decodedPatterns: ReadonlyMap<number, IDecodedPsdPattern>
): void {
	if (!stroke.strokeEnabled || !layer.vectorMask || layer.vectorMask.disabled) {
		return;
	}
	const content = stroke.content;
	const noiseSamples = content.gradient?.type === "noise" ? createPsdNoiseGradientSamples(content.gradient) : null;
	const flattened = layer.vectorMask.subpaths.map((subpath) => flattenVectorSubpath(subpath, documentWidth, documentHeight));
	const closed = flattened.filter((_, index) => layer.vectorMask?.subpaths[index].closed);
	for (let y = 0; y < layer.height; ++y) {
		for (let x = 0; x < layer.width; ++x) {
			const coverage = vectorStrokeCoverage(layer.left + x, layer.top + y, layer.vectorMask, stroke, flattened, closed);
			if (coverage <= 0) {
				continue;
			}
			const rgba = samplePsdVectorContent(
				content,
				x,
				y,
				{
					width: layer.width,
					height: layer.height,
					documentWidth,
					documentHeight,
					outputLeft: layer.left,
					outputTop: layer.top,
				},
				decodedPatterns,
				noiseSamples
			);
			compositePsdVectorStrokePixel(output, (y * layer.width + x) * 4, rgba, coverage, stroke);
		}
	}
}

/** Decodes every supported non-empty PSD-v1 or PSB-v2 pixel layer into an isolated top-left RGBA8 rectangle. */
export function decodePsdLayers(bytes: Uint8Array, options: { deferGlobalLayerMasks?: boolean; deferGlobalVectorMasks?: boolean } = {}): IDecodedPsdLayer[] {
	const parsed = parsePsdLayers(bytes);
	const decodedPatterns = new Map(parsed.patterns.filter((pattern) => pattern.bakeSupported).map((pattern) => [pattern.index, decodeParsedPsdPattern(bytes, pattern)] as const));
	return parsed.layers
		.filter((layer) => parsed.document.layers[layer.index].extractionSupported)
		.map((layer): IDecodedPsdLayer => {
			const publicLayer = parsed.document.layers[layer.index];
			const generatedFillUsesDocumentBounds =
				publicLayer.solidColorFill?.renderBounds === "document" ||
				publicLayer.patternFill?.renderBounds === "document" ||
				publicLayer.gradientFill?.renderBounds === "document" ||
				Boolean(publicLayer.vectorStroke);
			const executionLayer: IParsedPsdLayer = generatedFillUsesDocumentBounds
				? { ...layer, top: 0, left: 0, bottom: parsed.document.height, right: parsed.document.width, width: parsed.document.width, height: parsed.document.height }
				: layer;
			const deferGlobalLayerMask = options.deferGlobalLayerMasks === true && publicLayer.advancedBlending.layerMaskAsGlobalMask === true;
			const deferGlobalVectorMask = options.deferGlobalVectorMasks === true && publicLayer.advancedBlending.vectorMaskAsGlobalMask === true;
			const renderGeneratedFill = !publicLayer.vectorStroke || publicLayer.vectorStroke.fillEnabled;
			const output = new Uint8Array(executionLayer.width * executionLayer.height * 4);
			if (!publicLayer.vectorStroke || (publicLayer.vectorFill && publicLayer.vectorStroke.fillEnabled)) {
				for (let offset = 3; offset < output.byteLength; offset += 4) {
					output[offset] = 255;
				}
			}
			if (publicLayer.vectorStroke && !publicLayer.vectorFill && !publicLayer.hasTransparency && layer.channels.some((channel) => channel.id >= 0 && channel.id <= 2)) {
				const offsetX = layer.left - executionLayer.left;
				const offsetY = layer.top - executionLayer.top;
				for (let y = 0; y < layer.height; ++y) {
					for (let x = 0; x < layer.width; ++x) {
						const destinationX = offsetX + x;
						const destinationY = offsetY + y;
						if (destinationX >= 0 && destinationY >= 0 && destinationX < executionLayer.width && destinationY < executionLayer.height) {
							output[(destinationY * executionLayer.width + destinationX) * 4 + 3] = 255;
						}
					}
				}
			}
			if (renderGeneratedFill && publicLayer.solidColorFill?.rgba) {
				for (let offset = 0; offset < output.byteLength; offset += 4) {
					output[offset] = publicLayer.solidColorFill.rgba[0];
					output[offset + 1] = publicLayer.solidColorFill.rgba[1];
					output[offset + 2] = publicLayer.solidColorFill.rgba[2];
				}
			}
			if (renderGeneratedFill && publicLayer.patternFill) {
				const decodedPattern =
					publicLayer.patternFill.pattern.resolvedPatternIndex === null ? undefined : decodedPatterns.get(publicLayer.patternFill.pattern.resolvedPatternIndex);
				if (!decodedPattern) {
					throw new Error(`Unsupported PSD layer ${publicLayer.index} PtFl pattern cannot be resolved for bounded rendering.`);
				}
				for (let y = 0; y < executionLayer.height; ++y) {
					for (let x = 0; x < executionLayer.width; ++x) {
						const rgba = samplePsdPatternPixel(publicLayer.patternFill.pattern, decodedPattern, x, y, {
							documentWidth: parsed.document.width,
							documentHeight: parsed.document.height,
							outputLeft: executionLayer.left,
							outputTop: executionLayer.top,
						});
						const destination = (y * executionLayer.width + x) * 4;
						output.set(rgba, destination);
					}
				}
			}
			if (renderGeneratedFill && publicLayer.gradientFill) {
				const noiseSamples = publicLayer.gradientFill.gradient.type === "noise" ? createPsdNoiseGradientSamples(publicLayer.gradientFill.gradient) : null;
				for (let y = 0; y < executionLayer.height; ++y) {
					for (let x = 0; x < executionLayer.width; ++x) {
						const rgba = samplePsdGradientPixel(
							publicLayer.gradientFill.gradient,
							x,
							y,
							{
								width: executionLayer.width,
								height: executionLayer.height,
								documentWidth: parsed.document.width,
								documentHeight: parsed.document.height,
								outputLeft: executionLayer.left,
								outputTop: executionLayer.top,
							},
							noiseSamples
						);
						output.set(rgba, (y * executionLayer.width + x) * 4);
					}
				}
			}
			if (publicLayer.vectorStroke && publicLayer.vectorFill) {
				if (publicLayer.vectorStroke.fillEnabled) {
					applyPsdVectorFillMask(output, executionLayer, parsed.document.width, parsed.document.height);
				} else {
					output.fill(0);
				}
				renderPsdVectorStroke(output, executionLayer, publicLayer.vectorStroke, parsed.document.width, parsed.document.height, decodedPatterns);
			}
			for (const channel of layer.channels) {
				const generatedFill = publicLayer.solidColorFill ?? publicLayer.patternFill ?? publicLayer.gradientFill;
				if (generatedFill ? channel.id !== -1 || generatedFill.coverageSource !== "transparency-channel" : ![0, 1, 2, -1].includes(channel.id)) {
					continue;
				}
				const plane = decodePsdLayerChannel(bytes, layer, channel);
				const offsetX = layer.left - executionLayer.left;
				const offsetY = layer.top - executionLayer.top;
				for (let pixel = 0; pixel < plane.length; ++pixel) {
					const sourceX = pixel % layer.width;
					const sourceY = Math.floor(pixel / layer.width);
					const destinationX = offsetX + sourceX;
					const destinationY = offsetY + sourceY;
					if (destinationX < 0 || destinationY < 0 || destinationX >= executionLayer.width || destinationY >= executionLayer.height) {
						continue;
					}
					const destination = (destinationY * executionLayer.width + destinationX) * 4;
					if (parsed.document.colorMode === "grayscale" && channel.id === 0) {
						output[destination] = plane[pixel];
						output[destination + 1] = plane[pixel];
						output[destination + 2] = plane[pixel];
					} else if (channel.id === -1) {
						output[destination + 3] = publicLayer.patternFill || publicLayer.gradientFill ? Math.round((output[destination + 3] * plane[pixel]) / 255) : plane[pixel];
					} else if (channel.id >= 0 && channel.id <= 2) {
						output[destination + channel.id] = plane[pixel];
					}
				}
			}
			if (publicLayer.vectorStroke && !publicLayer.vectorFill) {
				renderPsdVectorStroke(output, executionLayer, publicLayer.vectorStroke, parsed.document.width, parsed.document.height, decodedPatterns);
			}
			const maskChannel = layer.channels.find((channel) => channel.id === -2);
			if (!deferGlobalLayerMask && layer.mask && maskChannel && !layer.mask.disabled) {
				applyPsdLayerMask(output, executionLayer, decodePsdLayerChannel(bytes, layer, maskChannel), layer.mask, {
					density: layer.mask.userDensity,
					feather: layer.mask.userFeather,
					maskOwner: layer,
				});
			}
			const realUserMaskChannel = layer.channels.find((channel) => channel.id === -3);
			if (!deferGlobalLayerMask && layer.mask?.realUserMask && realUserMaskChannel && !layer.mask.realUserMask.disabled) {
				applyPsdLayerMask(output, executionLayer, decodePsdLayerChannel(bytes, layer, realUserMaskChannel), layer.mask.realUserMask, {
					density: null,
					feather: null,
					maskOwner: layer,
				});
			}
			if (!deferGlobalVectorMask && !publicLayer.vectorStroke) {
				applyPsdVectorMask(output, executionLayer, parsed.document.width, parsed.document.height);
			}
			return {
				...publicLayer,
				...(generatedFillUsesDocumentBounds
					? { top: 0, left: 0, bottom: parsed.document.height, right: parsed.document.width, width: parsed.document.width, height: parsed.document.height }
					: {}),
				pixels: output,
			};
		});
}

/** Reads bounded PSD-v1 or PSB-v2 merged-composite metadata without allocating decoded pixels. */
export function inspectPsd(bytes: Uint8Array): IPsdImageInfo {
	const {
		imageDataOffset: _imageDataOffset,
		layerAndMaskOffset: _layerAndMaskOffset,
		rleRowLengthBytes: _rleRowLengthBytes,
		layerAndMaskLengthBytes: _layerAndMaskLengthBytes,
		...info
	} = parsePsd(bytes);
	return info;
}

/** Decodes a bounded 8/16/32-bit RGB/Grayscale PSD-v1 or PSB-v2 merged composite with raw, PackBits-RLE, ZIP, or ZIP-predicted channel data into RGBA8 pixels. */
export function decodePsd(bytes: Uint8Array): IDecodedPsdImage {
	const parsed = parsePsd(bytes);
	const pixelCount = parsed.width * parsed.height;
	const planeByteLength = pixelCount * parsed.sampleByteLength;
	const rowByteLength = parsed.width * parsed.sampleByteLength;
	const output = new Uint8Array(pixelCount * 4);
	for (let offset = 3; offset < output.byteLength; offset += 4) {
		output[offset] = 255;
	}

	if (parsed.compression === "raw") {
		const expectedBytes = parsed.channels * planeByteLength;
		const availableBytes = bytes.byteLength - parsed.imageDataOffset;
		if (availableBytes !== expectedBytes) {
			throw new Error(`Malformed PSD: raw merged image requires exactly ${expectedBytes} channel bytes, but ${availableBytes} remain.`);
		}
		for (let channel = 0; channel < parsed.channels; ++channel) {
			const coverage = parsed.colorMode === "rgb" ? channel >= 3 : channel >= 1;
			const planeOffset = parsed.imageDataOffset + channel * planeByteLength;
			const plane = convertPsdPlaneToRgba8Samples(
				bytes.slice(planeOffset, planeOffset + planeByteLength),
				parsed.width,
				parsed.height,
				parsed.depth,
				`raw merged channel ${channel}`,
				coverage
			);
			for (let y = 0; y < parsed.height; ++y) {
				writeChannelRow(output, plane.subarray(y * parsed.width, (y + 1) * parsed.width), parsed.width, y, channel, parsed.colorMode);
			}
		}
	} else if (parsed.compression === "rle") {
		const rowCount = parsed.channels * parsed.height;
		const rowLengthBytes = parsed.rleRowLengthBytes;
		const rowTableBytes = rowCount * rowLengthBytes;
		assertRange(bytes, parsed.imageDataOffset, rowTableBytes, "RLE row byte-count table");
		let encodedBytes = 0;
		for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
			encodedBytes +=
				rowLengthBytes === 4
					? readUint32(bytes, parsed.imageDataOffset + rowIndex * rowLengthBytes, "RLE row byte count")
					: readUint16(bytes, parsed.imageDataOffset + rowIndex * rowLengthBytes, "RLE row byte count");
		}
		const encodedOffset = parsed.imageDataOffset + rowTableBytes;
		if (encodedOffset + encodedBytes !== bytes.byteLength) {
			throw new Error(`Malformed PSD: RLE row table declares ${encodedBytes} bytes, but ${bytes.byteLength - encodedOffset} bytes remain.`);
		}
		const row = new Uint8Array(rowByteLength);
		let rowOffset = encodedOffset;
		for (let channel = 0; channel < parsed.channels; ++channel) {
			const coverage = parsed.colorMode === "rgb" ? channel >= 3 : channel >= 1;
			for (let y = 0; y < parsed.height; ++y) {
				const rowIndex = channel * parsed.height + y;
				const rowBytes =
					rowLengthBytes === 4
						? readUint32(bytes, parsed.imageDataOffset + rowIndex * rowLengthBytes, "RLE row byte count")
						: readUint16(bytes, parsed.imageDataOffset + rowIndex * rowLengthBytes, "RLE row byte count");
				decodePackBitsRow(bytes, rowOffset, rowBytes, rowByteLength, row);
				const converted = convertPsdPlaneToRgba8Samples(row, parsed.width, 1, parsed.depth, `RLE merged channel ${channel} row ${y}`, coverage);
				writeChannelRow(output, converted, parsed.width, y, channel, parsed.colorMode);
				rowOffset += rowBytes;
			}
		}
	} else {
		const decoded = decodePsdMergedZipData(bytes.subarray(parsed.imageDataOffset), parsed.channels, planeByteLength);
		for (let channel = 0; channel < parsed.channels; ++channel) {
			const coverage = parsed.colorMode === "rgb" ? channel >= 3 : channel >= 1;
			const plane = decoded.subarray(channel * planeByteLength, (channel + 1) * planeByteLength);
			if (parsed.compression === "zipPrediction") {
				undoPsdZipPrediction(plane, parsed.width, parsed.height, parsed.depth, `merged channel ${channel}`);
			}
			const converted = convertPsdPlaneToRgba8Samples(plane, parsed.width, parsed.height, parsed.depth, `ZIP merged channel ${channel}`, coverage);
			for (let y = 0; y < parsed.height; ++y) {
				writeChannelRow(output, converted.subarray(y * parsed.width, (y + 1) * parsed.width), parsed.width, y, channel, parsed.colorMode);
			}
		}
	}

	const {
		imageDataOffset: _imageDataOffset,
		layerAndMaskOffset: _layerAndMaskOffset,
		rleRowLengthBytes: _rleRowLengthBytes,
		layerAndMaskLengthBytes: _layerAndMaskLengthBytes,
		...info
	} = parsed;
	return { ...info, pixels: output };
}

function invertProjectiveMatrix(matrix: readonly number[]): [number, number, number, number, number, number, number, number, number] {
	const [a, b, c, d, e, f, g, h, i] = matrix;
	const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
		throw new Error("PSD smart-object placement transform is degenerate.");
	}
	const inverse = [
		(e * i - f * h) / determinant,
		(c * h - b * i) / determinant,
		(b * f - c * e) / determinant,
		(f * g - d * i) / determinant,
		(a * i - c * g) / determinant,
		(c * d - a * f) / determinant,
		(d * h - e * g) / determinant,
		(b * g - a * h) / determinant,
		(a * e - b * d) / determinant,
	];
	if (inverse.some((value) => !Number.isFinite(value))) {
		throw new Error("PSD smart-object placement transform produces non-finite inverse coordinates.");
	}
	return inverse as [number, number, number, number, number, number, number, number, number];
}

function smartObjectProjectiveMatrix(corners: readonly number[]): [number, number, number, number, number, number, number, number, number] {
	const [x0, y0, x1, y1, x2, y2, x3, y3] = corners;
	const dx1 = x1 - x2;
	const dx2 = x3 - x2;
	const dx3 = x0 - x1 + x2 - x3;
	const dy1 = y1 - y2;
	const dy2 = y3 - y2;
	const dy3 = y0 - y1 + y2 - y3;
	if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
		return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
	}
	const denominator = dx1 * dy2 - dx2 * dy1;
	if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
		throw new Error("PSD smart-object placement quadrilateral is degenerate.");
	}
	const g = (dx3 * dy2 - dx2 * dy3) / denominator;
	const h = (dx1 * dy3 - dx3 * dy1) / denominator;
	return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

/** Executes the supported ordered Photoshop smart-filter subset on one exact RGBA8 source raster. */
export function applyPsdSmartFilters(
	source: Pick<IDecodedPsdImage, "pixels" | "width" | "height">,
	filters: IPsdSmartFilterInfo[],
	stackEnabled = true,
	shapeBlurKernelBindings: readonly IPsdShapeBlurKernelBinding[] = []
): IPsdSmartFilterRenderResult {
	if (
		!Number.isSafeInteger(source.width) ||
		!Number.isSafeInteger(source.height) ||
		source.width <= 0 ||
		source.height <= 0 ||
		source.pixels.byteLength !== source.width * source.height * 4 ||
		source.width * source.height > MAXIMUM_PSD_LAYER_PIXELS
	) {
		throw new Error("PSD smart-filter source must contain a bounded exact positive RGBA8 raster.");
	}
	if (!Array.isArray(filters) || filters.length > 128 || filters.some((filter, index) => filter.index !== index)) {
		throw new Error("PSD smart-filter stack must contain at most 128 ordered filters with contiguous indices.");
	}
	if (
		!Array.isArray(shapeBlurKernelBindings) ||
		shapeBlurKernelBindings.length > 128 ||
		new Set(shapeBlurKernelBindings.map((binding) => binding.shapeId)).size !== shapeBlurKernelBindings.length ||
		shapeBlurKernelBindings.some(
			(binding) =>
				!binding.shapeId ||
				binding.shapeId.length > 1024 ||
				!Number.isSafeInteger(binding.width) ||
				!Number.isSafeInteger(binding.height) ||
				binding.width <= 0 ||
				binding.height <= 0 ||
				binding.width > 1024 ||
				binding.height > 1024 ||
				binding.width * binding.height > 1_048_576 ||
				!(binding.coverage instanceof Uint8Array) ||
				binding.coverage.byteLength !== binding.width * binding.height
		)
	) {
		throw new Error("PSD Shape Blur kernel bindings must contain at most 128 unique bounded exact 1-1024px coverage rasters.");
	}
	let pixels = new Uint8Array(source.pixels);
	const appliedFilterIndices: number[] = [];
	if (!stackEnabled) {
		return { pixels, appliedFilterIndices, executionModel: "bounded-smart-filter-stack-v1" };
	}
	const convolve = (input: Uint8Array, horizontalKernel: number[], verticalKernel = horizontalKernel): Uint8Array => {
		const pixelCount = source.width * source.height;
		const premultiplied = new Float32Array(pixelCount * 4);
		for (let pixel = 0; pixel < pixelCount; ++pixel) {
			const alpha = input[pixel * 4 + 3] / 255;
			premultiplied[pixel * 4] = input[pixel * 4] * alpha;
			premultiplied[pixel * 4 + 1] = input[pixel * 4 + 1] * alpha;
			premultiplied[pixel * 4 + 2] = input[pixel * 4 + 2] * alpha;
			premultiplied[pixel * 4 + 3] = input[pixel * 4 + 3];
		}
		const horizontal = new Float32Array(pixelCount * 4);
		const horizontalRadius = Math.floor(horizontalKernel.length / 2);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				for (let kernelIndex = 0; kernelIndex < horizontalKernel.length; ++kernelIndex) {
					const sampleX = Math.max(0, Math.min(source.width - 1, x + kernelIndex - horizontalRadius));
					const sourceOffset = (y * source.width + sampleX) * 4;
					const destinationOffset = (y * source.width + x) * 4;
					for (let channel = 0; channel < 4; ++channel) {
						horizontal[destinationOffset + channel] += premultiplied[sourceOffset + channel] * horizontalKernel[kernelIndex];
					}
				}
			}
		}
		const output = new Uint8Array(pixelCount * 4);
		const verticalRadius = Math.floor(verticalKernel.length / 2);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const values = [0, 0, 0, 0];
				for (let kernelIndex = 0; kernelIndex < verticalKernel.length; ++kernelIndex) {
					const sampleY = Math.max(0, Math.min(source.height - 1, y + kernelIndex - verticalRadius));
					const sourceOffset = (sampleY * source.width + x) * 4;
					for (let channel = 0; channel < 4; ++channel) {
						values[channel] += horizontal[sourceOffset + channel] * verticalKernel[kernelIndex];
					}
				}
				const destinationOffset = (y * source.width + x) * 4;
				const alpha = Math.max(0, Math.min(255, values[3]));
				output[destinationOffset + 3] = Math.round(alpha);
				for (let channel = 0; channel < 3; ++channel) {
					output[destinationOffset + channel] = alpha <= 1e-8 ? 0 : Math.round(Math.max(0, Math.min(255, (values[channel] * 255) / alpha)));
				}
			}
		}
		return output;
	};
	const normalizedKernel = (values: number[]): number[] => {
		const total = values.reduce((sum, value) => sum + value, 0);
		return values.map((value) => value / total);
	};
	const blurKernel = (radius: number, gaussian: boolean): number[] => {
		if (radius <= 0) {
			return [1];
		}
		if (!gaussian) {
			const integerRadius = Math.max(1, Math.ceil(radius));
			return Array.from({ length: integerRadius * 2 + 1 }, () => 1 / (integerRadius * 2 + 1));
		}
		const kernelRadius = Math.max(1, Math.ceil(radius * 3));
		return normalizedKernel(Array.from({ length: kernelRadius * 2 + 1 }, (_, index) => Math.exp(-((index - kernelRadius) ** 2) / (2 * radius * radius))));
	};
	const luminance = (input: Uint8Array, x: number, y: number): number => {
		const sampleX = Math.max(0, Math.min(source.width - 1, x));
		const sampleY = Math.max(0, Math.min(source.height - 1, y));
		const offset = (sampleY * source.width + sampleX) * 4;
		return input[offset] * 0.299 + input[offset + 1] * 0.587 + input[offset + 2] * 0.114;
	};
	const facet = (input: Uint8Array): Uint8Array => {
		const output = new Uint8Array(input.length);
		for (let blockY = 0; blockY < source.height; blockY += 2) {
			for (let blockX = 0; blockX < source.width; blockX += 2) {
				let alphaTotal = 0;
				const premultiplied = [0, 0, 0];
				let count = 0;
				for (let y = blockY; y < Math.min(source.height, blockY + 2); ++y) {
					for (let x = blockX; x < Math.min(source.width, blockX + 2); ++x) {
						const offset = (y * source.width + x) * 4;
						const alpha = input[offset + 3] / 255;
						alphaTotal += alpha;
						for (let channel = 0; channel < 3; ++channel) {
							premultiplied[channel] += input[offset + channel] * alpha;
						}
						++count;
					}
				}
				const alpha = alphaTotal / count;
				const colors = premultiplied.map((value) => (alphaTotal <= 1e-12 ? 0 : Math.round(value / alphaTotal)));
				for (let y = blockY; y < Math.min(source.height, blockY + 2); ++y) {
					for (let x = blockX; x < Math.min(source.width, blockX + 2); ++x) {
						const offset = (y * source.width + x) * 4;
						output[offset] = colors[0];
						output[offset + 1] = colors[1];
						output[offset + 2] = colors[2];
						output[offset + 3] = Math.round(alpha * 255);
					}
				}
			}
		}
		return output;
	};
	const findEdges = (input: Uint8Array): Uint8Array => {
		const output = new Uint8Array(input.length);
		const kernelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
		const kernelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				let gradientX = 0;
				let gradientY = 0;
				for (let kernelYIndex = 0; kernelYIndex < 3; ++kernelYIndex) {
					for (let kernelXIndex = 0; kernelXIndex < 3; ++kernelXIndex) {
						const kernelIndex = kernelYIndex * 3 + kernelXIndex;
						const sample = luminance(input, x + kernelXIndex - 1, y + kernelYIndex - 1);
						gradientX += sample * kernelX[kernelIndex];
						gradientY += sample * kernelY[kernelIndex];
					}
				}
				const offset = (y * source.width + x) * 4;
				const value = Math.max(0, 255 - Math.round(Math.min(255, Math.hypot(gradientX, gradientY) / 4)));
				output[offset] = input[offset + 3] === 0 ? 0 : value;
				output[offset + 1] = input[offset + 3] === 0 ? 0 : value;
				output[offset + 2] = input[offset + 3] === 0 ? 0 : value;
				output[offset + 3] = input[offset + 3];
			}
		}
		return output;
	};
	const ntscColors = (input: Uint8Array): Uint8Array => {
		const output = new Uint8Array(input);
		const lower = 16 / 255;
		const upper = 235 / 255;
		for (let offset = 0; offset < input.length; offset += 4) {
			if (input[offset + 3] === 0) {
				output[offset] = output[offset + 1] = output[offset + 2] = 0;
				continue;
			}
			const red = input[offset] / 255;
			const green = input[offset + 1] / 255;
			const blue = input[offset + 2] / 255;
			const y = Math.max(lower, Math.min(upper, red * 0.299 + green * 0.587 + blue * 0.114));
			const i = red * 0.596 - green * 0.275 - blue * 0.321;
			const q = red * 0.212 - green * 0.523 + blue * 0.311;
			const reconstruct = (scale: number): [number, number, number] => [
				y + scale * (0.956 * i + 0.621 * q),
				y + scale * (-0.272 * i - 0.647 * q),
				y + scale * (-1.106 * i + 1.703 * q),
			];
			let low = 0;
			let high = 1;
			for (let iteration = 0; iteration < 12; ++iteration) {
				const middle = (low + high) / 2;
				const candidate = reconstruct(middle);
				if (candidate.every((value) => value >= lower && value <= upper)) {
					low = middle;
				} else {
					high = middle;
				}
			}
			const color = reconstruct(low);
			output[offset] = Math.round(Math.max(lower, Math.min(upper, color[0])) * 255);
			output[offset + 1] = Math.round(Math.max(lower, Math.min(upper, color[1])) * 255);
			output[offset + 2] = Math.round(Math.max(lower, Math.min(upper, color[2])) * 255);
		}
		return output;
	};
	const assertSmartFilterWork = (filter: IPsdSmartFilterInfo, sampleVisits: number): void => {
		if (!Number.isSafeInteger(sampleVisits) || sampleVisits > MAXIMUM_PSD_SMART_FILTER_SAMPLE_VISITS) {
			throw new Error(
				`PSD smart filter ${filter.index} (${filter.name}) requires ${Number.isFinite(sampleVisits) ? Math.ceil(sampleVisits).toLocaleString() : "non-finite"} sample visits; bounded execution permits at most ${MAXIMUM_PSD_SMART_FILTER_SAMPLE_VISITS.toLocaleString()}.`
			);
		}
	};
	const samplePremultipliedBilinear = (input: Uint8Array, sampleX: number, sampleY: number): [number, number, number, number] => {
		const clampedX = Math.max(0, Math.min(source.width - 1, sampleX));
		const clampedY = Math.max(0, Math.min(source.height - 1, sampleY));
		const x0 = Math.floor(clampedX);
		const y0 = Math.floor(clampedY);
		const x1 = Math.min(source.width - 1, x0 + 1);
		const y1 = Math.min(source.height - 1, y0 + 1);
		const horizontal = clampedX - x0;
		const vertical = clampedY - y0;
		const weights = [(1 - horizontal) * (1 - vertical), horizontal * (1 - vertical), horizontal * vertical, (1 - horizontal) * vertical];
		const offsets = [(y0 * source.width + x0) * 4, (y0 * source.width + x1) * 4, (y1 * source.width + x1) * 4, (y1 * source.width + x0) * 4];
		const result: [number, number, number, number] = [0, 0, 0, 0];
		for (let corner = 0; corner < 4; ++corner) {
			const alpha = input[offsets[corner] + 3] / 255;
			result[3] += alpha * weights[corner];
			for (let channel = 0; channel < 3; ++channel) {
				result[channel] += input[offsets[corner] + channel] * alpha * weights[corner];
			}
		}
		return result;
	};
	const sampledBlur = (
		input: Uint8Array,
		filter: IPsdSmartFilterInfo,
		sampleCount: number,
		coordinate: (x: number, y: number, sampleIndex: number, sampleCount: number) => [number, number]
	): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * sampleCount);
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const accumulated = [0, 0, 0, 0];
				for (let sampleIndex = 0; sampleIndex < sampleCount; ++sampleIndex) {
					const [sampleX, sampleY] = coordinate(x, y, sampleIndex, sampleCount);
					const sample = samplePremultipliedBilinear(input, sampleX, sampleY);
					for (let channel = 0; channel < 4; ++channel) {
						accumulated[channel] += sample[channel];
					}
				}
				const offset = (y * source.width + x) * 4;
				const alpha = accumulated[3] / sampleCount;
				output[offset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
				for (let channel = 0; channel < 3; ++channel) {
					output[offset + channel] = alpha <= 1e-12 ? 0 : Math.round(Math.max(0, Math.min(255, accumulated[channel] / accumulated[3])));
				}
			}
		}
		return output;
	};
	const edgePreservingBlur = (input: Uint8Array, radius: number, threshold: number, quality: "low" | "medium" | "high", filter: IPsdSmartFilterInfo): Uint8Array => {
		const effectiveRadius = Math.max(1, Math.ceil(radius));
		const offsets: Array<{ x: number; y: number; distanceSquared: number }> = [];
		for (let y = -effectiveRadius; y <= effectiveRadius; ++y) {
			for (let x = -effectiveRadius; x <= effectiveRadius; ++x) {
				const distanceSquared = x * x + y * y;
				if (distanceSquared <= effectiveRadius * effectiveRadius && (quality !== "low" || (x % 2 === 0 && y % 2 === 0) || (x === 0 && y === 0))) {
					offsets.push({ x, y, distanceSquared });
				}
			}
		}
		assertSmartFilterWork(filter, source.width * source.height * offsets.length);
		const output = new Uint8Array(input.length);
		const spatialSigma = Math.max(0.5, radius / 2);
		const toneSigma = Math.max(1, threshold / 2);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const centerLuminance = luminance(input, x, y);
				const accumulated = [0, 0, 0, 0];
				let weightTotal = 0;
				for (const candidate of offsets) {
					const sampleX = Math.max(0, Math.min(source.width - 1, x + candidate.x));
					const sampleY = Math.max(0, Math.min(source.height - 1, y + candidate.y));
					const difference = Math.abs(luminance(input, sampleX, sampleY) - centerLuminance);
					if (difference > threshold) {
						continue;
					}
					const weight =
						quality === "high"
							? Math.exp(-candidate.distanceSquared / (2 * spatialSigma * spatialSigma)) * Math.exp(-(difference * difference) / (2 * toneSigma * toneSigma))
							: 1;
					const sourceOffset = (sampleY * source.width + sampleX) * 4;
					const alpha = input[sourceOffset + 3] / 255;
					for (let channel = 0; channel < 3; ++channel) {
						accumulated[channel] += input[sourceOffset + channel] * alpha * weight;
					}
					accumulated[3] += alpha * weight;
					weightTotal += weight;
				}
				const destinationOffset = (y * source.width + x) * 4;
				const alpha = weightTotal <= 1e-12 ? 0 : accumulated[3] / weightTotal;
				output[destinationOffset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
				for (let channel = 0; channel < 3; ++channel) {
					output[destinationOffset + channel] = accumulated[3] <= 1e-12 ? 0 : Math.round(Math.max(0, Math.min(255, accumulated[channel] / accumulated[3])));
				}
			}
		}
		return output;
	};
	const heartCardShapeBlur = (input: Uint8Array, radius: number, filter: IPsdSmartFilterInfo): Uint8Array => {
		const effectiveRadius = Math.ceil(radius);
		assertSmartFilterWork(filter, source.width * source.height * (effectiveRadius * 2 + 1) ** 2);
		const offsets: Array<[number, number]> = [];
		for (let y = -effectiveRadius; y <= effectiveRadius; ++y) {
			for (let x = -effectiveRadius; x <= effectiveRadius; ++x) {
				const normalizedX = (x / effectiveRadius) * 1.25;
				const normalizedY = (-y / effectiveRadius) * 1.25;
				const base = normalizedX * normalizedX + normalizedY * normalizedY - 1;
				if (base * base * base - normalizedX * normalizedX * normalizedY * normalizedY * normalizedY <= 0) {
					offsets.push([x, y]);
				}
			}
		}
		if (!offsets.length) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) produced an empty Heart Card kernel.`);
		}
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const accumulated = [0, 0, 0, 0];
				for (const [offsetX, offsetY] of offsets) {
					const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
					const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
					const sourceOffset = (sampleY * source.width + sampleX) * 4;
					const alpha = input[sourceOffset + 3] / 255;
					for (let channel = 0; channel < 3; ++channel) {
						accumulated[channel] += input[sourceOffset + channel] * alpha;
					}
					accumulated[3] += alpha;
				}
				const destinationOffset = (y * source.width + x) * 4;
				const alpha = accumulated[3] / offsets.length;
				output[destinationOffset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
				for (let channel = 0; channel < 3; ++channel) {
					output[destinationOffset + channel] = accumulated[3] <= 1e-12 ? 0 : Math.round(Math.max(0, Math.min(255, accumulated[channel] / accumulated[3])));
				}
			}
		}
		return output;
	};
	const customShapeBlur = (input: Uint8Array, radius: number, filter: IPsdSmartFilterInfo, kernel: IPsdShapeBlurKernelBinding): Uint8Array => {
		const effectiveRadius = Math.ceil(radius);
		assertSmartFilterWork(filter, source.width * source.height * (effectiveRadius * 2 + 1) ** 2);
		const offsets: Array<{ x: number; y: number; weight: number }> = [];
		for (let y = -effectiveRadius; y <= effectiveRadius; ++y) {
			for (let x = -effectiveRadius; x <= effectiveRadius; ++x) {
				const kernelX = Math.round(((x + effectiveRadius) / (effectiveRadius * 2)) * (kernel.width - 1));
				const kernelY = Math.round(((y + effectiveRadius) / (effectiveRadius * 2)) * (kernel.height - 1));
				const weight = kernel.coverage[kernelY * kernel.width + kernelX] / 255;
				if (weight > 0) {
					offsets.push({ x, y, weight });
				}
			}
		}
		if (!offsets.length) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) custom Shape Blur binding ${kernel.shapeId} produced an empty kernel.`);
		}
		const output = new Uint8Array(input.length);
		const kernelWeight = offsets.reduce((total, offset) => total + offset.weight, 0);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const accumulated = [0, 0, 0, 0];
				for (const candidate of offsets) {
					const sampleX = Math.max(0, Math.min(source.width - 1, x + candidate.x));
					const sampleY = Math.max(0, Math.min(source.height - 1, y + candidate.y));
					const sourceOffset = (sampleY * source.width + sampleX) * 4;
					const alpha = input[sourceOffset + 3] / 255;
					for (let channel = 0; channel < 3; ++channel) {
						accumulated[channel] += input[sourceOffset + channel] * alpha * candidate.weight;
					}
					accumulated[3] += alpha * candidate.weight;
				}
				const destinationOffset = (y * source.width + x) * 4;
				const alpha = accumulated[3] / kernelWeight;
				output[destinationOffset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
				for (let channel = 0; channel < 3; ++channel) {
					output[destinationOffset + channel] = accumulated[3] <= 1e-12 ? 0 : Math.round(Math.max(0, Math.min(255, accumulated[channel] / accumulated[3])));
				}
			}
		}
		return output;
	};
	const neighborhoodFilter = (input: Uint8Array, radius: number, mode: "maximum" | "median" | "minimum", filter: IPsdSmartFilterInfo): Uint8Array => {
		const effectiveRadius = Math.max(1, Math.ceil(radius));
		const offsets: Array<[number, number]> = [];
		for (let y = -effectiveRadius; y <= effectiveRadius; ++y) {
			for (let x = -effectiveRadius; x <= effectiveRadius; ++x) {
				if (x * x + y * y <= effectiveRadius * effectiveRadius) {
					offsets.push([x, y]);
				}
			}
		}
		assertSmartFilterWork(filter, source.width * source.height * offsets.length);
		const output = new Uint8Array(input.length);
		const values = Array.from({ length: 4 }, () => new Uint8Array(offsets.length));
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				for (let sampleIndex = 0; sampleIndex < offsets.length; ++sampleIndex) {
					const [offsetX, offsetY] = offsets[sampleIndex];
					const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
					const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
					const sourceOffset = (sampleY * source.width + sampleX) * 4;
					for (let channel = 0; channel < 4; ++channel) {
						values[channel][sampleIndex] = input[sourceOffset + channel];
					}
				}
				const destinationOffset = (y * source.width + x) * 4;
				for (let channel = 0; channel < 4; ++channel) {
					if (mode === "maximum") {
						let value = 0;
						for (let sampleIndex = 0; sampleIndex < offsets.length; ++sampleIndex) {
							value = Math.max(value, values[channel][sampleIndex]);
						}
						output[destinationOffset + channel] = value;
					} else if (mode === "minimum") {
						let value = 255;
						for (let sampleIndex = 0; sampleIndex < offsets.length; ++sampleIndex) {
							value = Math.min(value, values[channel][sampleIndex]);
						}
						output[destinationOffset + channel] = value;
					} else {
						values[channel].sort();
						const middle = Math.floor(values[channel].length / 2);
						output[destinationOffset + channel] =
							values[channel].length % 2 === 1 ? values[channel][middle] : Math.round((values[channel][middle - 1] + values[channel][middle]) / 2);
					}
				}
				if (output[destinationOffset + 3] === 0) {
					output[destinationOffset] = output[destinationOffset + 1] = output[destinationOffset + 2] = 0;
				}
			}
		}
		return output;
	};
	const addSeededNoise = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["addNoise"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const samplesPerPixel = settings.monochromatic ? 1 : 3;
		assertSmartFilterWork(filter, source.width * source.height * samplesPerPixel * (settings.distribution === "gaussian" ? 2 : 1));
		let state = settings.randomSeed >>> 0;
		const random = (): number => {
			state = (state + 0x6d2b79f5) >>> 0;
			let value = state;
			value = Math.imul(value ^ (value >>> 15), value | 1);
			value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
			return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
		};
		const sample = (): number => {
			if (settings.distribution === "uniform") {
				return random() * 2 - 1;
			}
			const first = Math.max(random(), 1 / 4_294_967_296);
			const second = random();
			return (Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)) / 3;
		};
		const amplitude = (settings.amountPercent / 100) * 255;
		const output = new Uint8Array(input);
		for (let offset = 0; offset < output.length; offset += 4) {
			if (output[offset + 3] === 0) {
				output[offset] = output[offset + 1] = output[offset + 2] = 0;
				continue;
			}
			const monochromaticDelta = settings.monochromatic ? sample() * amplitude : 0;
			for (let channel = 0; channel < 3; ++channel) {
				const delta = settings.monochromatic ? monochromaticDelta : sample() * amplitude;
				output[offset + channel] = Math.round(Math.max(0, Math.min(255, input[offset + channel] + delta)));
			}
		}
		return output;
	};
	const removeDustAndScratches = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["dustAndScratches"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const offsets: Array<[number, number]> = [];
		for (let y = -settings.radius; y <= settings.radius; ++y) {
			for (let x = -settings.radius; x <= settings.radius; ++x) {
				if (x * x + y * y <= settings.radius * settings.radius) {
					offsets.push([x, y]);
				}
			}
		}
		assertSmartFilterWork(filter, source.width * source.height * offsets.length * 3);
		const output = new Uint8Array(input);
		const values = Array.from({ length: 3 }, () => new Uint8Array(offsets.length));
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				for (let sampleIndex = 0; sampleIndex < offsets.length; ++sampleIndex) {
					const [offsetX, offsetY] = offsets[sampleIndex];
					const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
					const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
					const sampleOffset = (sampleY * source.width + sampleX) * 4;
					for (let channel = 0; channel < 3; ++channel) {
						values[channel][sampleIndex] = input[sampleOffset + channel];
					}
				}
				const destinationOffset = (y * source.width + x) * 4;
				const medians = values.map((channelValues) => {
					channelValues.sort();
					const middle = Math.floor(channelValues.length / 2);
					return channelValues.length % 2 === 1 ? channelValues[middle] : Math.round((channelValues[middle - 1] + channelValues[middle]) / 2);
				});
				const difference = Math.max(...medians.map((median, channel) => Math.abs(input[destinationOffset + channel] - median)));
				if (difference > settings.threshold) {
					for (let channel = 0; channel < 3; ++channel) {
						output[destinationOffset + channel] = medians[channel];
					}
				}
				if (output[destinationOffset + 3] === 0) {
					output[destinationOffset] = output[destinationOffset + 1] = output[destinationOffset + 2] = 0;
				}
			}
		}
		return output;
	};
	const reduceImageNoise = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["reduceNoise"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const clampByte = (value: number): number => Math.round(Math.max(0, Math.min(255, value)));
		const channelNames = ["red", "green", "blue"] as const;
		const channelSettings = channelNames.map(
			(channel) =>
				settings.channelDenoise.find((entry) => entry.channels.includes(channel)) ?? settings.channelDenoise.find((entry) => entry.channels.includes("composite")) ?? null
		);
		const channelOffsets = channelSettings.map((entry) => {
			if (!entry || entry.amount === 0) {
				return [] as Array<[number, number, number]>;
			}
			const radius = entry.amount <= 3 ? 1 : entry.amount <= 7 ? 2 : 3;
			const offsets: Array<[number, number, number]> = [];
			for (let y = -radius; y <= radius; ++y) {
				for (let x = -radius; x <= radius; ++x) {
					const distanceSquared = x * x + y * y;
					if (distanceSquared <= radius * radius) {
						offsets.push([x, y, distanceSquared]);
					}
				}
			}
			return offsets;
		});
		const channelVisits = channelOffsets.reduce((total, offsets) => total + offsets.length, 0);
		const colorVisits = settings.reduceColorNoisePercent > 0 ? 9 : 0;
		const jpegVisits = settings.removeJpegArtifact ? 4 : 0;
		const sharpenVisits = settings.sharpenDetailsPercent > 0 ? 9 : 0;
		assertSmartFilterWork(filter, source.width * source.height * (channelVisits + colorVisits + jpegVisits + sharpenVisits));

		let output = new Uint8Array(input);
		if (channelVisits > 0) {
			const denoised = new Uint8Array(output);
			for (let y = 0; y < source.height; ++y) {
				for (let x = 0; x < source.width; ++x) {
					const destinationOffset = (y * source.width + x) * 4;
					if (output[destinationOffset + 3] === 0) {
						denoised[destinationOffset] = denoised[destinationOffset + 1] = denoised[destinationOffset + 2] = 0;
						continue;
					}
					for (let channel = 0; channel < 3; ++channel) {
						const entry = channelSettings[channel];
						if (!entry || entry.amount === 0) {
							continue;
						}
						const center = output[destinationOffset + channel];
						const preserveDetails = entry.preserveDetailsPercent ?? 50;
						const threshold = 8 + (1 - preserveDetails / 100) * 96;
						const radius = entry.amount <= 3 ? 1 : entry.amount <= 7 ? 2 : 3;
						const spatialSigma = Math.max(0.5, radius / 1.5);
						const toneSigma = Math.max(1, threshold / 2);
						let weightedValue = 0;
						let weightTotal = 0;
						for (const [offsetX, offsetY, distanceSquared] of channelOffsets[channel]) {
							const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
							const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
							const sampleOffset = (sampleY * source.width + sampleX) * 4;
							const difference = Math.abs(output[sampleOffset + channel] - center);
							if (difference > threshold || output[sampleOffset + 3] === 0) {
								continue;
							}
							const alpha = output[sampleOffset + 3] / 255;
							const weight =
								alpha * Math.exp(-distanceSquared / (2 * spatialSigma * spatialSigma)) * Math.exp(-(difference * difference) / (2 * toneSigma * toneSigma));
							weightedValue += output[sampleOffset + channel] * weight;
							weightTotal += weight;
						}
						const average = weightTotal <= 1e-12 ? center : weightedValue / weightTotal;
						denoised[destinationOffset + channel] = clampByte(center + (average - center) * (entry.amount / 10));
					}
				}
			}
			output = denoised;
		}

		if (settings.reduceColorNoisePercent > 0) {
			const chromaReduced = new Uint8Array(output);
			const strength = settings.reduceColorNoisePercent / 100;
			for (let y = 0; y < source.height; ++y) {
				for (let x = 0; x < source.width; ++x) {
					const destinationOffset = (y * source.width + x) * 4;
					if (output[destinationOffset + 3] === 0) {
						chromaReduced[destinationOffset] = chromaReduced[destinationOffset + 1] = chromaReduced[destinationOffset + 2] = 0;
						continue;
					}
					const red = output[destinationOffset];
					const green = output[destinationOffset + 1];
					const blue = output[destinationOffset + 2];
					const yValue = red * 0.299 + green * 0.587 + blue * 0.114;
					const centerCb = 128 - red * 0.168736 - green * 0.331264 + blue * 0.5;
					const centerCr = 128 + red * 0.5 - green * 0.418688 - blue * 0.081312;
					let cbTotal = 0;
					let crTotal = 0;
					let weightTotal = 0;
					for (let offsetY = -1; offsetY <= 1; ++offsetY) {
						for (let offsetX = -1; offsetX <= 1; ++offsetX) {
							const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
							const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
							const sampleOffset = (sampleY * source.width + sampleX) * 4;
							const alpha = output[sampleOffset + 3] / 255;
							cbTotal += (128 - output[sampleOffset] * 0.168736 - output[sampleOffset + 1] * 0.331264 + output[sampleOffset + 2] * 0.5) * alpha;
							crTotal += (128 + output[sampleOffset] * 0.5 - output[sampleOffset + 1] * 0.418688 - output[sampleOffset + 2] * 0.081312) * alpha;
							weightTotal += alpha;
						}
					}
					const cb = centerCb + ((weightTotal <= 1e-12 ? centerCb : cbTotal / weightTotal) - centerCb) * strength;
					const cr = centerCr + ((weightTotal <= 1e-12 ? centerCr : crTotal / weightTotal) - centerCr) * strength;
					chromaReduced[destinationOffset] = clampByte(yValue + 1.402 * (cr - 128));
					chromaReduced[destinationOffset + 1] = clampByte(yValue - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
					chromaReduced[destinationOffset + 2] = clampByte(yValue + 1.772 * (cb - 128));
				}
			}
			output = chromaReduced;
		}

		if (settings.removeJpegArtifact) {
			const deblocked = new Uint8Array(output);
			const smoothBoundary = (firstOffset: number, secondOffset: number): void => {
				if (output[firstOffset + 3] === 0 || output[secondOffset + 3] === 0) {
					return;
				}
				const difference = Math.max(...Array.from({ length: 3 }, (_, channel) => Math.abs(output[firstOffset + channel] - output[secondOffset + channel])));
				if (difference > 64) {
					return;
				}
				for (let channel = 0; channel < 3; ++channel) {
					const average = (output[firstOffset + channel] + output[secondOffset + channel]) / 2;
					deblocked[firstOffset + channel] = clampByte(output[firstOffset + channel] + (average - output[firstOffset + channel]) * 0.5);
					deblocked[secondOffset + channel] = clampByte(output[secondOffset + channel] + (average - output[secondOffset + channel]) * 0.5);
				}
			};
			for (let x = 8; x < source.width; x += 8) {
				for (let y = 0; y < source.height; ++y) {
					smoothBoundary((y * source.width + x - 1) * 4, (y * source.width + x) * 4);
				}
			}
			for (let y = 8; y < source.height; y += 8) {
				for (let x = 0; x < source.width; ++x) {
					smoothBoundary(((y - 1) * source.width + x) * 4, (y * source.width + x) * 4);
				}
			}
			output = deblocked;
		}

		if (settings.sharpenDetailsPercent > 0) {
			const sharpened = new Uint8Array(output);
			const strength = (settings.sharpenDetailsPercent / 100) * 0.5;
			for (let y = 0; y < source.height; ++y) {
				for (let x = 0; x < source.width; ++x) {
					const destinationOffset = (y * source.width + x) * 4;
					if (output[destinationOffset + 3] === 0) {
						sharpened[destinationOffset] = sharpened[destinationOffset + 1] = sharpened[destinationOffset + 2] = 0;
						continue;
					}
					const totals = [0, 0, 0];
					let alphaTotal = 0;
					for (let offsetY = -1; offsetY <= 1; ++offsetY) {
						for (let offsetX = -1; offsetX <= 1; ++offsetX) {
							const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
							const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
							const sampleOffset = (sampleY * source.width + sampleX) * 4;
							const alpha = output[sampleOffset + 3] / 255;
							for (let channel = 0; channel < 3; ++channel) {
								totals[channel] += output[sampleOffset + channel] * alpha;
							}
							alphaTotal += alpha;
						}
					}
					for (let channel = 0; channel < 3; ++channel) {
						const average = alphaTotal <= 1e-12 ? output[destinationOffset + channel] : totals[channel] / alphaTotal;
						sharpened[destinationOffset + channel] = clampByte(output[destinationOffset + channel] + (output[destinationOffset + channel] - average) * strength);
					}
				}
			}
			output = sharpened;
		}
		return output;
	};
	const applyColorHalftone = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["colorHalftone"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const supersampleAxis = 4;
		const supersampleCount = supersampleAxis * supersampleAxis;
		assertSmartFilterWork(filter, source.width * source.height * supersampleCount * 4);
		const cellSize = settings.radius * 2;
		const screens = settings.anglesDegrees.map((angle) => {
			const radians = (angle * Math.PI) / 180;
			return { cosine: Math.cos(radians), sine: Math.sin(radians) };
		});
		const cmykAt = (x: number, y: number): [number, number, number, number] => {
			const sampleX = Math.max(0, Math.min(source.width - 1, Math.round(x)));
			const sampleY = Math.max(0, Math.min(source.height - 1, Math.round(y)));
			const offset = (sampleY * source.width + sampleX) * 4;
			if (input[offset + 3] === 0) {
				return [0, 0, 0, 0];
			}
			const red = input[offset] / 255;
			const green = input[offset + 1] / 255;
			const blue = input[offset + 2] / 255;
			const black = 1 - Math.max(red, green, blue);
			if (black >= 1 - 1e-12) {
				return [0, 0, 0, 1];
			}
			const denominator = 1 - black;
			return [(1 - red - black) / denominator, (1 - green - black) / denominator, (1 - blue - black) / denominator, black];
		};
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const destinationOffset = (y * source.width + x) * 4;
				output[destinationOffset + 3] = input[destinationOffset + 3];
				if (input[destinationOffset + 3] === 0) {
					continue;
				}
				const totals = [0, 0, 0];
				for (let subpixelY = 0; subpixelY < supersampleAxis; ++subpixelY) {
					for (let subpixelX = 0; subpixelX < supersampleAxis; ++subpixelX) {
						const sampleX = x + (subpixelX + 0.5) / supersampleAxis;
						const sampleY = y + (subpixelY + 0.5) / supersampleAxis;
						const inks = screens.map((screen, channel) => {
							const rotatedX = sampleX * screen.cosine + sampleY * screen.sine;
							const rotatedY = -sampleX * screen.sine + sampleY * screen.cosine;
							const centerX = (Math.floor(rotatedX / cellSize) + 0.5) * cellSize;
							const centerY = (Math.floor(rotatedY / cellSize) + 0.5) * cellSize;
							const sourceCenterX = centerX * screen.cosine - centerY * screen.sine;
							const sourceCenterY = centerX * screen.sine + centerY * screen.cosine;
							const coverage = cmykAt(sourceCenterX, sourceCenterY)[channel];
							const distanceSquared = (rotatedX - centerX) ** 2 + (rotatedY - centerY) ** 2;
							return distanceSquared <= coverage * 2 * settings.radius * settings.radius ? 1 : 0;
						});
						const [cyan, magenta, yellow, black] = inks;
						totals[0] += (1 - cyan) * (1 - black) * 255;
						totals[1] += (1 - magenta) * (1 - black) * 255;
						totals[2] += (1 - yellow) * (1 - black) * 255;
					}
				}
				for (let channel = 0; channel < 3; ++channel) {
					output[destinationOffset + channel] = Math.round(totals[channel] / supersampleCount);
				}
			}
		}
		return output;
	};
	const applyCrystallize = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["crystallize"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const searchRadius = 2;
		const candidateCount = (searchRadius * 2 + 1) ** 2;
		assertSmartFilterWork(filter, source.width * source.height * candidateCount);
		const random = (cellX: number, cellY: number, salt: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(cellX | 0, 0x9e3779b1);
			value ^= Math.imul(cellY | 0, 0x85ebca77);
			value ^= Math.imul(salt, 0xc2b2ae3d);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const destinationOffset = (y * source.width + x) * 4;
				output[destinationOffset + 3] = input[destinationOffset + 3];
				if (input[destinationOffset + 3] === 0) {
					continue;
				}
				const baseCellX = Math.floor((x + 0.5) / settings.cellSize);
				const baseCellY = Math.floor((y + 0.5) / settings.cellSize);
				let nearestDistance = Number.POSITIVE_INFINITY;
				let nearestX = x;
				let nearestY = y;
				for (let cellY = baseCellY - searchRadius; cellY <= baseCellY + searchRadius; ++cellY) {
					for (let cellX = baseCellX - searchRadius; cellX <= baseCellX + searchRadius; ++cellX) {
						const pointX = (cellX + random(cellX, cellY, 1)) * settings.cellSize;
						const pointY = (cellY + random(cellX, cellY, 2)) * settings.cellSize;
						const distance = (pointX - (x + 0.5)) ** 2 + (pointY - (y + 0.5)) ** 2;
						if (distance < nearestDistance) {
							nearestDistance = distance;
							nearestX = Math.max(0, Math.min(source.width - 1, Math.floor(pointX)));
							nearestY = Math.max(0, Math.min(source.height - 1, Math.floor(pointY)));
						}
					}
				}
				const sampleOffset = (nearestY * source.width + nearestX) * 4;
				for (let channel = 0; channel < 3; ++channel) {
					output[destinationOffset + channel] = input[sampleOffset + 3] === 0 ? input[destinationOffset + channel] : input[sampleOffset + channel];
				}
			}
		}
		return output;
	};
	const applyMezzotint = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["mezzotint"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 3);
		const profiles = {
			"fine dots": { family: "dots", extent: 1 },
			"medium dots": { family: "dots", extent: 2 },
			"grainy dots": { family: "grain", extent: 1 },
			"coarse dots": { family: "dots", extent: 4 },
			"short lines": { family: "lines", extent: 3 },
			"medium lines": { family: "lines", extent: 6 },
			"long lines": { family: "lines", extent: 12 },
			"short strokes": { family: "strokes", extent: 3 },
			"medium strokes": { family: "strokes", extent: 6 },
			"long strokes": { family: "strokes", extent: 12 },
		} as const;
		const profile = profiles[settings.pattern];
		const random = (x: number, y: number, channel: number, salt: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(x | 0, 0x9e3779b1);
			value ^= Math.imul(y | 0, 0x85ebca77);
			value ^= Math.imul(channel + salt * 4, 0xc2b2ae3d);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				let patternX: number;
				let patternY: number;
				if (profile.family === "lines") {
					patternX = Math.floor(x / profile.extent);
					patternY = y;
				} else if (profile.family === "strokes") {
					const direction = random(Math.floor(x / profile.extent), Math.floor(y / profile.extent), 0, 17) < 0.5 ? -1 : 1;
					patternX = Math.floor((x + direction * y) / profile.extent);
					patternY = Math.floor((y - direction * x) / 2);
				} else {
					patternX = Math.floor(x / profile.extent);
					patternY = Math.floor(y / profile.extent);
				}
				for (let channel = 0; channel < 3; ++channel) {
					const threshold = random(patternX, patternY, channel, profile.family === "grain" ? x + y * source.width + 31 : 23) * 255;
					output[offset + channel] = input[offset + channel] >= threshold ? 255 : 0;
				}
			}
		}
		return output;
	};
	const applyMosaic = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["mosaic"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 2);
		const output = new Uint8Array(input.length);
		for (let cellY = 0; cellY < source.height; cellY += settings.cellSize) {
			for (let cellX = 0; cellX < source.width; cellX += settings.cellSize) {
				const endX = Math.min(source.width, cellX + settings.cellSize);
				const endY = Math.min(source.height, cellY + settings.cellSize);
				const totals = [0, 0, 0];
				let alphaTotal = 0;
				for (let y = cellY; y < endY; ++y) {
					for (let x = cellX; x < endX; ++x) {
						const offset = (y * source.width + x) * 4;
						const alpha = input[offset + 3] / 255;
						alphaTotal += alpha;
						for (let channel = 0; channel < 3; ++channel) {
							totals[channel] += input[offset + channel] * alpha;
						}
					}
				}
				const average = totals.map((total) => (alphaTotal <= 1e-12 ? 0 : Math.round(total / alphaTotal)));
				for (let y = cellY; y < endY; ++y) {
					for (let x = cellX; x < endX; ++x) {
						const offset = (y * source.width + x) * 4;
						output[offset + 3] = input[offset + 3];
						if (input[offset + 3] === 0) {
							continue;
						}
						for (let channel = 0; channel < 3; ++channel) {
							output[offset + channel] = average[channel];
						}
					}
				}
			}
		}
		return output;
	};
	const applyPointillize = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["pointillize"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const neighborRadius = 1;
		const candidateCount = (neighborRadius * 2 + 1) ** 2;
		assertSmartFilterWork(filter, source.width * source.height * (candidateCount + 1));
		const random = (cellX: number, cellY: number, salt: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(cellX | 0, 0x9e3779b1);
			value ^= Math.imul(cellY | 0, 0x85ebca77);
			value ^= Math.imul(salt, 0xc2b2ae3d);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		if (!filter.backgroundColor) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing the authored Pointillize background color.`);
		}
		const canvas = filter.backgroundColor;
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				const baseCellX = Math.floor((x + 0.5) / settings.cellSize);
				const baseCellY = Math.floor((y + 0.5) / settings.cellSize);
				let selectedDistance = Number.POSITIVE_INFINITY;
				let selectedOffset = -1;
				for (let cellY = baseCellY - neighborRadius; cellY <= baseCellY + neighborRadius; ++cellY) {
					for (let cellX = baseCellX - neighborRadius; cellX <= baseCellX + neighborRadius; ++cellX) {
						const pointX = (cellX + 0.15 + random(cellX, cellY, 1) * 0.7) * settings.cellSize;
						const pointY = (cellY + 0.15 + random(cellX, cellY, 2) * 0.7) * settings.cellSize;
						const radius = settings.cellSize * (0.28 + random(cellX, cellY, 3) * 0.16);
						const distance = (pointX - (x + 0.5)) ** 2 + (pointY - (y + 0.5)) ** 2;
						if (distance <= radius * radius && distance < selectedDistance) {
							const sampleX = Math.max(0, Math.min(source.width - 1, Math.floor(pointX)));
							const sampleY = Math.max(0, Math.min(source.height - 1, Math.floor(pointY)));
							const candidateOffset = (sampleY * source.width + sampleX) * 4;
							if (input[candidateOffset + 3] !== 0) {
								selectedDistance = distance;
								selectedOffset = candidateOffset;
							}
						}
					}
				}
				for (let channel = 0; channel < 3; ++channel) {
					output[offset + channel] = selectedOffset < 0 ? canvas[channel] : input[selectedOffset + channel];
				}
			}
		}
		return output;
	};
	const applyCloudField = (input: Uint8Array, settings: { randomSeed: number }, filter: IPsdSmartFilterInfo, composition: "replace" | "difference"): Uint8Array => {
		const octaveCount = 5;
		assertSmartFilterWork(filter, source.width * source.height * octaveCount * 4);
		if (!filter.foregroundColor || !filter.backgroundColor) {
			throw new Error(
				`PSD smart filter ${filter.index} (${filter.name}) is missing authored ${composition === "difference" ? "Difference Clouds" : "Clouds"} foreground/background colors.`
			);
		}
		const random = (x: number, y: number, octave: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(x | 0, 0x9e3779b1);
			value ^= Math.imul(y | 0, 0x85ebca77);
			value ^= Math.imul(octave + 1, 0xc2b2ae3d);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		const smooth = (value: number): number => value * value * (3 - 2 * value);
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				let amplitude = 1;
				let amplitudeTotal = 0;
				let total = 0;
				for (let octave = 0; octave < octaveCount; ++octave) {
					const frequency = 2 ** octave;
					const scale = Math.max(1, Math.min(source.width, source.height) / frequency);
					const coordinateX = (x + 0.5) / scale;
					const coordinateY = (y + 0.5) / scale;
					const latticeX = Math.floor(coordinateX);
					const latticeY = Math.floor(coordinateY);
					const fractionX = smooth(coordinateX - latticeX);
					const fractionY = smooth(coordinateY - latticeY);
					const top = random(latticeX, latticeY, octave) * (1 - fractionX) + random(latticeX + 1, latticeY, octave) * fractionX;
					const bottom = random(latticeX, latticeY + 1, octave) * (1 - fractionX) + random(latticeX + 1, latticeY + 1, octave) * fractionX;
					total += (top * (1 - fractionY) + bottom * fractionY) * amplitude;
					amplitudeTotal += amplitude;
					amplitude *= 0.5;
				}
				const coverage = total / amplitudeTotal;
				for (let channel = 0; channel < 3; ++channel) {
					const cloud = Math.round(filter.backgroundColor[channel] * (1 - coverage) + filter.foregroundColor[channel] * coverage);
					output[offset + channel] = composition === "difference" ? Math.abs(input[offset + channel] - cloud) : cloud;
				}
			}
		}
		return output;
	};
	const applyDiffuse = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["diffuse"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 12);
		const random = (x: number, y: number, salt: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(x + 0x9e3779b9, 0x85ebca6b);
			value ^= Math.imul(y + 0xc2b2ae35, 0x27d4eb2f);
			value ^= Math.imul(salt + 0x165667b1, 0x9e3779b1);
			value ^= value >>> 16;
			value = Math.imul(value, 0x7feb352d);
			value ^= value >>> 15;
			value = Math.imul(value, 0x846ca68b);
			value ^= value >>> 16;
			return (value >>> 0) / 4_294_967_296;
		};
		const pixelOffset = (x: number, y: number): number => (Math.max(0, Math.min(source.height - 1, y)) * source.width + Math.max(0, Math.min(source.width - 1, x))) * 4;
		const luminance = (offset: number): number => input[offset] * 0.299 + input[offset + 1] * 0.587 + input[offset + 2] * 0.114;
		const neighbours = [
			[-1, -1],
			[0, -1],
			[1, -1],
			[-1, 0],
			[1, 0],
			[-1, 1],
			[0, 1],
			[1, 1],
		] as const;
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				if (settings.mode === "anisotropic") {
					const left = pixelOffset(x - 1, y);
					const right = pixelOffset(x + 1, y);
					const up = pixelOffset(x, y - 1);
					const down = pixelOffset(x, y + 1);
					const horizontalContrast = Math.abs(luminance(left) - luminance(right));
					const verticalContrast = Math.abs(luminance(up) - luminance(down));
					const useHorizontal = horizontalContrast === verticalContrast ? random(x, y, 17) < 0.5 : horizontalContrast < verticalContrast;
					const first = useHorizontal ? left : up;
					const second = useHorizontal ? right : down;
					for (let channel = 0; channel < 3; ++channel) {
						output[offset + channel] = Math.round((input[first + channel] + input[offset + channel] * 2 + input[second + channel]) / 4);
					}
					continue;
				}
				const [dx, dy] = neighbours[Math.min(neighbours.length - 1, Math.floor(random(x, y, 23) * neighbours.length))];
				const candidate = pixelOffset(x + dx, y + dy);
				const candidateLuminance = luminance(candidate);
				const sourceLuminance = luminance(offset);
				const useCandidate =
					settings.mode === "normal" ||
					(settings.mode === "darkenOnly" && candidateLuminance < sourceLuminance) ||
					(settings.mode === "lightenOnly" && candidateLuminance > sourceLuminance);
				for (let channel = 0; channel < 3; ++channel) {
					output[offset + channel] = input[(useCandidate ? candidate : offset) + channel];
				}
			}
		}
		return output;
	};
	const applyEmboss = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["emboss"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 10);
		const radians = (settings.angleDegrees * Math.PI) / 180;
		const offsetX = Math.cos(radians) * settings.heightPixels * 0.5;
		const offsetY = -Math.sin(radians) * settings.heightPixels * 0.5;
		const amount = settings.amountPercent / 100;
		const sampleOffset = (x: number, y: number): number =>
			(Math.max(0, Math.min(source.height - 1, Math.round(y))) * source.width + Math.max(0, Math.min(source.width - 1, Math.round(x)))) * 4;
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				const raised = sampleOffset(x + offsetX, y + offsetY);
				const recessed = sampleOffset(x - offsetX, y - offsetY);
				for (let channel = 0; channel < 3; ++channel) {
					output[offset + channel] = Math.round(Math.max(0, Math.min(255, 128 + (input[raised + channel] - input[recessed + channel]) * amount)));
				}
			}
		}
		return output;
	};
	const applyExtrude = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["extrude"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 12);
		interface IExtrudeCell {
			average: [number, number, number];
			depthFraction: number;
			width: number;
			height: number;
			incomplete: boolean;
		}
		const cells = new Map<string, IExtrudeCell>();
		const random = (cellX: number, cellY: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(cellX + 0x9e3779b9, 0x85ebca6b);
			value ^= Math.imul(cellY + 0xc2b2ae35, 0x27d4eb2f);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		const getCell = (cellX: number, cellY: number): IExtrudeCell => {
			const key = `${cellX}:${cellY}`;
			const existing = cells.get(key);
			if (existing) {
				return existing;
			}
			const left = cellX * settings.sizePixels;
			const top = cellY * settings.sizePixels;
			const width = Math.min(settings.sizePixels, source.width - left);
			const height = Math.min(settings.sizePixels, source.height - top);
			let alphaTotal = 0;
			const totals = [0, 0, 0];
			for (let y = top; y < top + height; ++y) {
				for (let x = left; x < left + width; ++x) {
					const offset = (y * source.width + x) * 4;
					const alpha = input[offset + 3] / 255;
					alphaTotal += alpha;
					for (let channel = 0; channel < 3; ++channel) {
						totals[channel] += input[offset + channel] * alpha;
					}
				}
			}
			const average = totals.map((value) => (alphaTotal <= 1e-12 ? 0 : value / alphaTotal)) as [number, number, number];
			const luminance = (average[0] * 0.299 + average[1] * 0.587 + average[2] * 0.114) / 255;
			const cell = {
				average,
				depthFraction: settings.depthMode === "random" ? random(cellX, cellY) : Math.max(0, Math.min(1, luminance)),
				width,
				height,
				incomplete: width !== settings.sizePixels || height !== settings.sizePixels,
			};
			cells.set(key, cell);
			return cell;
		};
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				const cellX = Math.floor(x / settings.sizePixels);
				const cellY = Math.floor(y / settings.sizePixels);
				const cell = getCell(cellX, cellY);
				if (cell.incomplete && settings.maskIncompleteBlocks) {
					output[offset] = input[offset];
					output[offset + 1] = input[offset + 1];
					output[offset + 2] = input[offset + 2];
					continue;
				}
				const localX = x - cellX * settings.sizePixels;
				const localY = y - cellY * settings.sizePixels;
				const relief = cell.depthFraction * (settings.depth / 255);
				let shade = settings.type === "blocks" ? 1 + relief * 0.04 : 1;
				let useAverage = settings.type === "pyramids" || settings.solidFrontFaces;
				if (settings.type === "blocks") {
					const inset = Math.min(Math.floor((Math.min(cell.width, cell.height) - 1) / 2), Math.round(relief * settings.sizePixels * 0.45));
					const distances = [localY, cell.width - 1 - localX, cell.height - 1 - localY, localX];
					const edgeDistance = Math.min(...distances);
					if (edgeDistance < inset) {
						useAverage = true;
						const face = distances.indexOf(edgeDistance);
						const faceShade = [0.38, -0.16, -0.38, 0.16][face];
						shade = 1 + faceShade * relief;
					}
				} else {
					const normalizedX = ((localX + 0.5) / cell.width) * 2 - 1;
					const normalizedY = ((localY + 0.5) / cell.height) * 2 - 1;
					const faceShade = Math.abs(normalizedX) > Math.abs(normalizedY) ? (normalizedX < 0 ? 0.22 : -0.22) : normalizedY < 0 ? 0.42 : -0.42;
					const apex = 1 - Math.max(Math.abs(normalizedX), Math.abs(normalizedY));
					shade = 1 + faceShade * relief * (0.45 + Math.max(0, apex) * 0.55);
				}
				for (let channel = 0; channel < 3; ++channel) {
					const color = useAverage ? cell.average[channel] : input[offset + channel];
					output[offset + channel] = Math.round(Math.max(0, Math.min(255, color * shade)));
				}
			}
		}
		return output;
	};
	const applyTiles = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["tiles"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 12);
		if (settings.fillEmptyAreaWith === "backgroundColor" && !filter.backgroundColor) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing the authored Tiles background color.`);
		}
		if (settings.fillEmptyAreaWith === "foregroundColor" && !filter.foregroundColor) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing the authored Tiles foreground color.`);
		}
		const output = new Uint8Array(input.length);
		for (let offset = 0; offset < input.length; offset += 4) {
			output[offset + 3] = input[offset + 3];
			if (input[offset + 3] === 0) {
				continue;
			}
			for (let channel = 0; channel < 3; ++channel) {
				output[offset + channel] =
					settings.fillEmptyAreaWith === "backgroundColor"
						? filter.backgroundColor![channel]
						: settings.fillEmptyAreaWith === "foregroundColor"
							? filter.foregroundColor![channel]
							: settings.fillEmptyAreaWith === "inverseImage"
								? 255 - input[offset + channel]
								: input[offset + channel];
			}
		}
		const tileWidth = Math.max(1, Math.ceil(source.width / settings.numberOfTiles));
		const tileHeight = Math.max(1, Math.ceil(source.height / settings.numberOfTiles));
		const random = (cellX: number, cellY: number, salt: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(cellX + 0x9e3779b9, 0x85ebca6b);
			value ^= Math.imul(cellY + 0xc2b2ae35, 0x27d4eb2f);
			value ^= Math.imul(salt + 0x165667b1, 0x9e3779b1);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		const maximumOffset = settings.maximumOffsetPercent / 100;
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const cellX = Math.floor(x / tileWidth);
				const cellY = Math.floor(y / tileHeight);
				const destinationX = x + Math.round((random(cellX, cellY, 0) * 2 - 1) * tileWidth * maximumOffset);
				const destinationY = y + Math.round((random(cellX, cellY, 1) * 2 - 1) * tileHeight * maximumOffset);
				if (destinationX < 0 || destinationY < 0 || destinationX >= source.width || destinationY >= source.height) {
					continue;
				}
				const sourceOffset = (y * source.width + x) * 4;
				const destinationOffset = (destinationY * source.width + destinationX) * 4;
				if (input[sourceOffset + 3] === 0 || input[destinationOffset + 3] === 0) {
					continue;
				}
				output[destinationOffset] = input[sourceOffset];
				output[destinationOffset + 1] = input[sourceOffset + 1];
				output[destinationOffset + 2] = input[sourceOffset + 2];
			}
		}
		return output;
	};
	const applyTraceContour = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["traceContour"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 16);
		const output = new Uint8Array(input.length);
		const qualifies = (value: number): boolean => (settings.edge === "lower" ? value < settings.level : value > settings.level);
		const neighbors = [
			[-1, 0],
			[1, 0],
			[0, -1],
			[0, 1],
		] as const;
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				for (let channel = 0; channel < 3; ++channel) {
					let contour = qualifies(input[offset + channel]);
					if (contour) {
						contour = neighbors.some(([dx, dy]) => {
							const neighborX = Math.max(0, Math.min(source.width - 1, x + dx));
							const neighborY = Math.max(0, Math.min(source.height - 1, y + dy));
							const neighborOffset = (neighborY * source.width + neighborX) * 4;
							return !qualifies(input[neighborOffset + channel]);
						});
					}
					output[offset + channel] = contour ? input[offset + channel] : 255;
				}
			}
		}
		return output;
	};
	const applyWind = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["wind"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const maximumDistance = settings.method === "wind" ? 6 : settings.method === "blast" ? 14 : 9;
		assertSmartFilterWork(filter, source.width * source.height * maximumDistance * 8);
		const output = new Uint8Array(input.length);
		const direction = settings.direction === "right" ? 1 : -1;
		for (let y = 0; y < source.height; ++y) {
			const staggerOffset = settings.method === "stagger" ? (Math.floor(y / 2) % 2) * 2 : 0;
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				let bestWeight = 0;
				let bestOffset = offset;
				for (let distance = 1; distance <= maximumDistance; ++distance) {
					const sourceX = x - direction * (distance + staggerOffset);
					const comparisonX = sourceX - direction;
					if (sourceX < 0 || sourceX >= source.width || comparisonX < 0 || comparisonX >= source.width) {
						continue;
					}
					const sourceOffset = (y * source.width + sourceX) * 4;
					const comparisonOffset = (y * source.width + comparisonX) * 4;
					if (input[sourceOffset + 3] === 0 || input[comparisonOffset + 3] === 0) {
						continue;
					}
					const edgeStrength = Math.max(
						Math.abs(input[sourceOffset] - input[comparisonOffset]),
						Math.abs(input[sourceOffset + 1] - input[comparisonOffset + 1]),
						Math.abs(input[sourceOffset + 2] - input[comparisonOffset + 2])
					);
					const falloff = 1 - (distance - 1) / maximumDistance;
					const methodGain = settings.method === "blast" ? 1.35 : settings.method === "stagger" ? 0.9 : 1;
					const weight = Math.max(0, Math.min(1, (edgeStrength / 255) * falloff * methodGain));
					if (weight > bestWeight) {
						bestWeight = weight;
						bestOffset = sourceOffset;
					}
				}
				for (let channel = 0; channel < 3; ++channel) {
					output[offset + channel] = Math.round(input[offset + channel] * (1 - bestWeight) + input[bestOffset + channel] * bestWeight);
				}
			}
		}
		return output;
	};
	const applyDeInterlace = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["deInterlace"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 8);
		const output = new Uint8Array(input.length);
		for (let offset = 0; offset < input.length; offset += 4) {
			output[offset + 3] = input[offset + 3];
			if (input[offset + 3] !== 0) {
				output[offset] = input[offset];
				output[offset + 1] = input[offset + 1];
				output[offset + 2] = input[offset + 2];
			}
		}
		const eliminatedParity = settings.eliminate === "oddLines" ? 0 : 1;
		for (let y = eliminatedParity; y < source.height; y += 2) {
			const previousY = y > 0 ? y - 1 : null;
			const nextY = y + 1 < source.height ? y + 1 : null;
			for (let x = 0; x < source.width; ++x) {
				const destinationOffset = (y * source.width + x) * 4;
				if (input[destinationOffset + 3] === 0) {
					continue;
				}
				const previousOffset = previousY === null ? null : (previousY * source.width + x) * 4;
				const nextOffset = nextY === null ? null : (nextY * source.width + x) * 4;
				for (let channel = 0; channel < 3; ++channel) {
					if (settings.newFieldsBy === "interpolation" && previousOffset !== null && nextOffset !== null) {
						output[destinationOffset + channel] = Math.round((input[previousOffset + channel] + input[nextOffset + channel]) / 2);
					} else {
						const sourceOffset = previousOffset ?? nextOffset;
						if (sourceOffset !== null) {
							output[destinationOffset + channel] = input[sourceOffset + channel];
						}
					}
				}
			}
		}
		return output;
	};
	const applyFibers = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["fibers"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 8);
		if (!filter.foregroundColor || !filter.backgroundColor) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing authored Fibers foreground/background colors.`);
		}
		const random = (x: number, y: number, salt: number): number => {
			let value = settings.randomSeed >>> 0;
			value ^= Math.imul(x | 0, 0x9e3779b1);
			value ^= Math.imul(y | 0, 0x85ebca77);
			value ^= Math.imul(salt, 0xc2b2ae3d);
			value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
			value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
			return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
		};
		const smooth = (value: number): number => value * value * (3 - 2 * value);
		const sampleVertical = (x: number, y: number, period: number, salt: number): number => {
			const coordinate = (y + 0.5) / period;
			const lower = Math.floor(coordinate);
			const fraction = smooth(coordinate - lower);
			return random(x, lower, salt) * (1 - fraction) + random(x, lower + 1, salt) * fraction;
		};
		const primaryPeriod = Math.max(1, 65 - settings.variance);
		const detailPeriod = Math.max(1, Math.round(primaryPeriod / 4));
		const detailWeight = 0.12 + (settings.variance / 64) * 0.38;
		const contrastPower = 2 - ((settings.strength - 1) / 63) * 1.6;
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				const primary = sampleVertical(x, y, primaryPeriod, 1);
				const detail = sampleVertical(x, y, detailPeriod, 2);
				const columnBias = 0.75 + random(x, 0, 3) * 0.5;
				const field = Math.max(0, Math.min(1, (primary * (1 - detailWeight) + detail * detailWeight) * columnBias));
				const centered = field * 2 - 1;
				const coverage = Math.max(0, Math.min(1, 0.5 + Math.sign(centered) * Math.pow(Math.abs(centered), contrastPower) * 0.5));
				for (let channel = 0; channel < 3; ++channel) {
					output[offset + channel] = Math.round(filter.backgroundColor[channel] * (1 - coverage) + filter.foregroundColor[channel] * coverage);
				}
			}
		}
		return output;
	};
	const applyLensFlare = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["lensFlare"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		assertSmartFilterWork(filter, source.width * source.height * 12);
		const profiles = {
			"50-300mm zoom": { core: [255, 244, 210], ghost: [120, 165, 255], rays: 8, rayPower: 18, haloScale: 0.18, movieStreak: 0 },
			"32mm prime": { core: [255, 232, 190], ghost: [255, 145, 85], rays: 6, rayPower: 14, haloScale: 0.24, movieStreak: 0 },
			"105mm prime": { core: [225, 242, 255], ghost: [105, 205, 255], rays: 4, rayPower: 22, haloScale: 0.14, movieStreak: 0 },
			"movie prime": { core: [190, 220, 255], ghost: [70, 135, 255], rays: 2, rayPower: 30, haloScale: 0.2, movieStreak: 1 },
		} as const;
		const profile = profiles[settings.lensType];
		const brightness = settings.brightnessPercent / 100;
		const scale = Math.max(1, Math.min(source.width, source.height));
		const imageCenterX = source.width / 2;
		const imageCenterY = source.height / 2;
		const axisX = imageCenterX - settings.position.x;
		const axisY = imageCenterY - settings.position.y;
		const output = new Uint8Array(input.length);
		for (let y = 0; y < source.height; ++y) {
			for (let x = 0; x < source.width; ++x) {
				const offset = (y * source.width + x) * 4;
				output[offset + 3] = input[offset + 3];
				if (input[offset + 3] === 0) {
					continue;
				}
				const dx = x + 0.5 - settings.position.x;
				const dy = y + 0.5 - settings.position.y;
				const distance = Math.hypot(dx, dy) / scale;
				const angle = Math.atan2(dy, dx);
				const core = Math.exp(-distance * distance * 180);
				const halo = Math.exp(-distance / profile.haloScale) * 0.5;
				const ray = Math.pow(Math.abs(Math.cos(angle * profile.rays)), profile.rayPower) * Math.exp(-distance / 0.42) * 0.55;
				let ghostIntensity = 0;
				for (const ghost of [
					{ factor: -0.55, radius: 0.055, weight: 0.28 },
					{ factor: 0.42, radius: 0.035, weight: 0.22 },
					{ factor: 1.15, radius: 0.08, weight: 0.16 },
				]) {
					const ghostX = settings.position.x + axisX * ghost.factor;
					const ghostY = settings.position.y + axisY * ghost.factor;
					const ghostDistance = Math.hypot(x + 0.5 - ghostX, y + 0.5 - ghostY) / scale;
					const ring = Math.exp(-(((ghostDistance - ghost.radius) / Math.max(0.008, ghost.radius * 0.28)) ** 2));
					ghostIntensity += ring * ghost.weight;
				}
				const movieStreak =
					profile.movieStreak * Math.exp(-Math.abs(dy) / Math.max(1, source.height * 0.012)) * Math.exp(-Math.abs(dx) / Math.max(1, source.width * 0.45)) * 0.7;
				const warmIntensity = Math.max(0, Math.min(1, (core + halo + ray + movieStreak) * brightness));
				const coolIntensity = Math.max(0, Math.min(1, ghostIntensity * brightness));
				for (let channel = 0; channel < 3; ++channel) {
					const flare = Math.min(255, profile.core[channel] * warmIntensity + profile.ghost[channel] * coolIntensity);
					output[offset + channel] = Math.round(255 - (255 - input[offset + channel]) * (1 - flare / 255));
				}
			}
		}
		return output;
	};
	const applySmartSharpen = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["smartSharpen"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const shadowKernel = blurKernel(settings.shadow.radius, true);
		const highlightKernel = blurKernel(settings.highlight.radius, true);
		const motionSampleCount = Math.max(3, Math.min(1_001, Math.ceil(settings.radius * 2) + 1));
		const baseKernel = settings.blur === "motionBlur" ? null : blurKernel(settings.radius, settings.blur === "gaussianBlur");
		const baseVisitCount = baseKernel ? baseKernel.length * 2 : motionSampleCount;
		assertSmartFilterWork(filter, source.width * source.height * (baseVisitCount + shadowKernel.length * 2 + highlightKernel.length * 2 + 8));
		let baseBlurred: Uint8Array;
		if (settings.blur === "motionBlur") {
			const radians = (settings.angleDegrees * Math.PI) / 180;
			const directionX = Math.cos(radians);
			const directionY = Math.sin(radians);
			baseBlurred = sampledBlur(input, filter, motionSampleCount, (x, y, sampleIndex, count) => {
				const distance = ((sampleIndex / (count - 1)) * 2 - 1) * settings.radius;
				return [x + directionX * distance, y + directionY * distance];
			});
		} else {
			baseBlurred = convolve(input, baseKernel!);
		}
		const shadowTone = convolve(input, shadowKernel);
		const highlightTone = convolve(input, highlightKernel);
		const output = new Uint8Array(input.length);
		const amount = settings.amountPercent / 100;
		const shadowWidth = settings.shadow.tonalWidthPercent / 100;
		const highlightWidth = settings.highlight.tonalWidthPercent / 100;
		for (let offset = 0; offset < input.length; offset += 4) {
			output[offset + 3] = input[offset + 3];
			if (input[offset + 3] === 0) {
				continue;
			}
			const maximumDifference = Math.max(
				Math.abs(input[offset] - baseBlurred[offset]),
				Math.abs(input[offset + 1] - baseBlurred[offset + 1]),
				Math.abs(input[offset + 2] - baseBlurred[offset + 2])
			);
			if (maximumDifference < settings.threshold) {
				output[offset] = input[offset];
				output[offset + 1] = input[offset + 1];
				output[offset + 2] = input[offset + 2];
				continue;
			}
			const shadowLuminance = (shadowTone[offset] * 0.299 + shadowTone[offset + 1] * 0.587 + shadowTone[offset + 2] * 0.114) / 255;
			const highlightLuminance = (highlightTone[offset] * 0.299 + highlightTone[offset + 1] * 0.587 + highlightTone[offset + 2] * 0.114) / 255;
			const shadowMask = shadowWidth <= 1e-12 ? 0 : Math.max(0, Math.min(1, (shadowWidth - shadowLuminance) / shadowWidth));
			const highlightMask = highlightWidth <= 1e-12 ? 0 : Math.max(0, Math.min(1, (highlightLuminance - (1 - highlightWidth)) / highlightWidth));
			const toneFade = Math.max(0, Math.min(1, shadowMask * (settings.shadow.fadeAmountPercent / 100) + highlightMask * (settings.highlight.fadeAmountPercent / 100)));
			const precisionGain = settings.moreAccurate ? 1 + Math.min(0.25, maximumDifference / 1_020) : 1;
			for (let channel = 0; channel < 3; ++channel) {
				const detail = input[offset + channel] - baseBlurred[offset + channel];
				output[offset + channel] = Math.round(Math.max(0, Math.min(255, input[offset + channel] + detail * amount * (1 - toneFade) * precisionGain)));
			}
		}
		return output;
	};
	const applyUnsharpMask = (input: Uint8Array, settings: NonNullable<IPsdSmartFilterInfo["unsharpMask"]>, filter: IPsdSmartFilterInfo): Uint8Array => {
		const kernel = blurKernel(settings.radius, true);
		assertSmartFilterWork(filter, source.width * source.height * (kernel.length * 2 + 4));
		const blurred = convolve(input, kernel);
		const output = new Uint8Array(input.length);
		const amount = settings.amountPercent / 100;
		for (let offset = 0; offset < input.length; offset += 4) {
			output[offset + 3] = input[offset + 3];
			if (input[offset + 3] === 0) {
				continue;
			}
			const maximumDifference = Math.max(
				Math.abs(input[offset] - blurred[offset]),
				Math.abs(input[offset + 1] - blurred[offset + 1]),
				Math.abs(input[offset + 2] - blurred[offset + 2])
			);
			for (let channel = 0; channel < 3; ++channel) {
				const detail = maximumDifference < settings.threshold ? 0 : input[offset + channel] - blurred[offset + channel];
				output[offset + channel] = Math.round(Math.max(0, Math.min(255, input[offset + channel] + detail * amount)));
			}
		}
		return output;
	};
	for (const filter of filters) {
		if (!filter.enabled) {
			continue;
		}
		const customShapeBlurBinding =
			filter.type === "shapeBlur" && filter.shapeBlur?.kernel !== "heartCard"
				? shapeBlurKernelBindings.find((candidate) => candidate.shapeId === filter.shapeBlur!.customShape.id)
				: undefined;
		if (!filter.bakeSupported && !customShapeBlurBinding) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) cannot execute: ${filter.warning ?? "unsupported filter semantics"}`);
		}
		let filtered: Uint8Array;
		if (filter.type === "addNoise") {
			if (!filter.addNoise) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Add Noise parameters.`);
			}
			filtered = addSeededNoise(pixels, filter.addNoise, filter);
		} else if (filter.type === "dustAndScratches") {
			if (!filter.dustAndScratches) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Dust & Scratches parameters.`);
			}
			filtered = removeDustAndScratches(pixels, filter.dustAndScratches, filter);
		} else if (filter.type === "colorHalftone") {
			if (!filter.colorHalftone) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Color Halftone parameters.`);
			}
			filtered = applyColorHalftone(pixels, filter.colorHalftone, filter);
		} else if (filter.type === "crystallize") {
			if (!filter.crystallize) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Crystallize parameters.`);
			}
			filtered = applyCrystallize(pixels, filter.crystallize, filter);
		} else if (filter.type === "mezzotint") {
			if (!filter.mezzotint) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Mezzotint parameters.`);
			}
			filtered = applyMezzotint(pixels, filter.mezzotint, filter);
		} else if (filter.type === "mosaic") {
			if (!filter.mosaic) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Mosaic parameters.`);
			}
			filtered = applyMosaic(pixels, filter.mosaic, filter);
		} else if (filter.type === "pointillize") {
			if (!filter.pointillize) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Pointillize parameters.`);
			}
			filtered = applyPointillize(pixels, filter.pointillize, filter);
		} else if (filter.type === "clouds") {
			if (!filter.clouds) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Clouds parameters.`);
			}
			filtered = applyCloudField(pixels, filter.clouds, filter, "replace");
		} else if (filter.type === "differenceClouds") {
			if (!filter.differenceClouds) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Difference Clouds parameters.`);
			}
			filtered = applyCloudField(pixels, filter.differenceClouds, filter, "difference");
		} else if (filter.type === "diffuse") {
			if (!filter.diffuse) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Diffuse parameters.`);
			}
			filtered = applyDiffuse(pixels, filter.diffuse, filter);
		} else if (filter.type === "emboss") {
			if (!filter.emboss) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Emboss parameters.`);
			}
			filtered = applyEmboss(pixels, filter.emboss, filter);
		} else if (filter.type === "extrude") {
			if (!filter.extrude) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Extrude parameters.`);
			}
			filtered = applyExtrude(pixels, filter.extrude, filter);
		} else if (filter.type === "tiles") {
			if (!filter.tiles) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Tiles parameters.`);
			}
			filtered = applyTiles(pixels, filter.tiles, filter);
		} else if (filter.type === "traceContour") {
			if (!filter.traceContour) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Trace Contour parameters.`);
			}
			filtered = applyTraceContour(pixels, filter.traceContour, filter);
		} else if (filter.type === "wind") {
			if (!filter.wind) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Wind parameters.`);
			}
			filtered = applyWind(pixels, filter.wind, filter);
		} else if (filter.type === "deInterlace") {
			if (!filter.deInterlace) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing De-Interlace parameters.`);
			}
			filtered = applyDeInterlace(pixels, filter.deInterlace, filter);
		} else if (filter.type === "fibers") {
			if (!filter.fibers) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Fibers parameters.`);
			}
			filtered = applyFibers(pixels, filter.fibers, filter);
		} else if (filter.type === "lensFlare") {
			if (!filter.lensFlare) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Lens Flare parameters.`);
			}
			filtered = applyLensFlare(pixels, filter.lensFlare, filter);
		} else if (filter.type === "smartSharpen") {
			if (!filter.smartSharpen) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Smart Sharpen parameters.`);
			}
			filtered = applySmartSharpen(pixels, filter.smartSharpen, filter);
		} else if (filter.type === "unsharpMask") {
			if (!filter.unsharpMask) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Unsharp Mask parameters.`);
			}
			filtered = applyUnsharpMask(pixels, filter.unsharpMask, filter);
		} else if (filter.type === "reduceNoise") {
			if (!filter.reduceNoise) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Reduce Noise parameters.`);
			}
			filtered = reduceImageNoise(pixels, filter.reduceNoise, filter);
		} else if (filter.type === "average") {
			let alphaTotal = 0;
			const colors = [0, 0, 0];
			for (let offset = 0; offset < pixels.length; offset += 4) {
				const alpha = pixels[offset + 3] / 255;
				alphaTotal += alpha;
				for (let channel = 0; channel < 3; ++channel) {
					colors[channel] += pixels[offset + channel] * alpha;
				}
			}
			const average = colors.map((value) => (alphaTotal <= 1e-12 ? 0 : Math.round(value / alphaTotal)));
			filtered = new Uint8Array(pixels);
			for (let offset = 0; offset < filtered.length; offset += 4) {
				for (let channel = 0; channel < 3; ++channel) {
					filtered[offset + channel] = average[channel];
				}
			}
		} else if (filter.type === "invert") {
			filtered = new Uint8Array(pixels);
			for (let offset = 0; offset < filtered.length; offset += 4) {
				filtered[offset] = 255 - filtered[offset];
				filtered[offset + 1] = 255 - filtered[offset + 1];
				filtered[offset + 2] = 255 - filtered[offset + 2];
			}
		} else if (filter.type === "solarize") {
			filtered = new Uint8Array(pixels);
			for (let offset = 0; offset < filtered.length; offset += 4) {
				for (let channel = 0; channel < 3; ++channel) {
					const value = filtered[offset + channel];
					filtered[offset + channel] = value <= 127 ? value * 2 : (255 - value) * 2;
				}
			}
		} else if (filter.type === "ntscColors") {
			filtered = ntscColors(pixels);
		} else if (filter.type === "facet") {
			filtered = facet(pixels);
		} else if (filter.type === "fragment") {
			filtered = convolve(pixels, [0.5, 0, 0.5]);
		} else if (filter.type === "despeckle") {
			const blurred = convolve(pixels, normalizedKernel([1, 1, 1]));
			filtered = new Uint8Array(pixels);
			for (let y = 0; y < source.height; ++y) {
				for (let x = 0; x < source.width; ++x) {
					const neighborhood = Array.from({ length: 9 }, (_, index) => luminance(pixels, x + (index % 3) - 1, y + Math.floor(index / 3) - 1)).sort((a, b) => a - b);
					if (Math.abs(luminance(pixels, x, y) - neighborhood[4]) >= 24) {
						const offset = (y * source.width + x) * 4;
						filtered.set(blurred.subarray(offset, offset + 4), offset);
					}
				}
			}
		} else if (filter.type === "findEdges") {
			filtered = findEdges(pixels);
		} else if (filter.type === "median" || filter.type === "maximum" || filter.type === "minimum") {
			filtered = neighborhoodFilter(pixels, filter.radius ?? 0, filter.type, filter);
		} else if (filter.type === "highPass") {
			const radius = filter.radius ?? 0;
			const kernel = blurKernel(radius, true);
			assertSmartFilterWork(filter, source.width * source.height * kernel.length * 2);
			const blurred = convolve(pixels, kernel);
			filtered = new Uint8Array(pixels.length);
			for (let offset = 0; offset < pixels.length; offset += 4) {
				for (let channel = 0; channel < 3; ++channel) {
					filtered[offset + channel] = Math.round(Math.max(0, Math.min(255, 128 + pixels[offset + channel] - blurred[offset + channel])));
				}
				filtered[offset + 3] = pixels[offset + 3];
				if (filtered[offset + 3] === 0) {
					filtered[offset] = filtered[offset + 1] = filtered[offset + 2] = 0;
				}
			}
		} else if (filter.type === "motionBlur") {
			if (!filter.motionBlur) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing motion-blur parameters.`);
			}
			const radians = (filter.motionBlur.angleDegrees * Math.PI) / 180;
			const sampleCount = Math.ceil(filter.motionBlur.distance) + 1;
			filtered = sampledBlur(pixels, filter, sampleCount, (x, y, sampleIndex, count) => {
				const position = count === 1 ? 0 : sampleIndex / (count - 1) - 0.5;
				return [x + Math.cos(radians) * filter.motionBlur!.distance * position, y - Math.sin(radians) * filter.motionBlur!.distance * position];
			});
		} else if (filter.type === "radialBlur") {
			if (!filter.radialBlur) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing radial-blur parameters.`);
			}
			const sampleCount = filter.radialBlur.quality === "draft" ? 8 : filter.radialBlur.quality === "good" ? 16 : 32;
			const centerX = (source.width - 1) / 2;
			const centerY = (source.height - 1) / 2;
			if (filter.radialBlur.method === "spin") {
				const extent = (filter.radialBlur.amount * 3.6 * Math.PI) / 180;
				filtered = sampledBlur(pixels, filter, sampleCount, (x, y, sampleIndex, count) => {
					const angle = (sampleIndex / (count - 1) - 0.5) * extent;
					const offsetX = x - centerX;
					const offsetY = y - centerY;
					return [centerX + offsetX * Math.cos(angle) - offsetY * Math.sin(angle), centerY + offsetX * Math.sin(angle) + offsetY * Math.cos(angle)];
				});
			} else {
				filtered = sampledBlur(pixels, filter, sampleCount, (x, y, sampleIndex, count) => {
					const progress = sampleIndex / (count - 1);
					const scale = 1 - (filter.radialBlur!.amount / 100) * progress;
					return [centerX + (x - centerX) * scale, centerY + (y - centerY) * scale];
				});
			}
		} else if (filter.type === "smartBlur") {
			if (!filter.smartBlur || filter.radius === null) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing smart-blur parameters.`);
			}
			const blurred = edgePreservingBlur(pixels, filter.radius, filter.smartBlur.threshold, filter.smartBlur.quality, filter);
			if (filter.smartBlur.mode === "normal") {
				filtered = blurred;
			} else {
				filtered = new Uint8Array(pixels.length);
				for (let offset = 0; offset < pixels.length; offset += 4) {
					const edge = Math.min(
						255,
						Math.max(
							Math.abs(pixels[offset] - blurred[offset]),
							Math.abs(pixels[offset + 1] - blurred[offset + 1]),
							Math.abs(pixels[offset + 2] - blurred[offset + 2])
						) * 4
					);
					if (filter.smartBlur.mode === "edgeOnly") {
						filtered[offset] = filtered[offset + 1] = filtered[offset + 2] = pixels[offset + 3] === 0 ? 0 : Math.round(edge);
					} else {
						for (let channel = 0; channel < 3; ++channel) {
							filtered[offset + channel] = pixels[offset + 3] === 0 ? 0 : Math.round(pixels[offset + channel] + (255 - pixels[offset + channel]) * (edge / 255));
						}
					}
					filtered[offset + 3] = pixels[offset + 3];
				}
			}
		} else if (filter.type === "surfaceBlur") {
			if (!filter.surfaceBlur || filter.radius === null) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing surface-blur parameters.`);
			}
			filtered = edgePreservingBlur(pixels, filter.radius, filter.surfaceBlur.threshold, "medium", filter);
		} else if (filter.type === "shapeBlur") {
			if (!filter.shapeBlur || filter.radius === null) {
				throw new Error(`PSD smart filter ${filter.index} (${filter.name}) is missing Shape Blur parameters.`);
			}
			if (filter.shapeBlur.kernel === "heartCard") {
				filtered = heartCardShapeBlur(pixels, filter.radius, filter);
			} else {
				const binding = customShapeBlurBinding;
				if (!binding) {
					throw new Error(
						`PSD smart filter ${filter.index} (${filter.name}) requires an exact custom Shape Blur kernel binding for ${filter.shapeBlur.customShape.name} (${filter.shapeBlur.customShape.id}).`
					);
				}
				filtered = customShapeBlur(pixels, filter.radius, filter, binding);
			}
		} else if (filter.type === "boxBlur") {
			filtered = convolve(pixels, blurKernel(filter.radius ?? 0, false));
		} else if (filter.type === "gaussianBlur") {
			filtered = convolve(pixels, blurKernel(filter.radius ?? 0, true));
		} else if (filter.type === "blur" || filter.type === "blurMore") {
			filtered = convolve(pixels, filter.type === "blur" ? normalizedKernel([1, 2, 1]) : normalizedKernel([1, 4, 6, 4, 1]));
		} else if (filter.type === "sharpen" || filter.type === "sharpenMore" || filter.type === "sharpenEdges") {
			const strength = filter.type === "sharpen" ? 1 : 2;
			const blurred = convolve(pixels, normalizedKernel([1, 2, 1]));
			filtered = new Uint8Array(pixels.length);
			for (let y = 0; y < source.height; ++y) {
				for (let x = 0; x < source.width; ++x) {
					const offset = (y * source.width + x) * 4;
					const edge = Math.max(
						Math.abs(luminance(pixels, x, y) - luminance(pixels, x - 1, y)),
						Math.abs(luminance(pixels, x, y) - luminance(pixels, x + 1, y)),
						Math.abs(luminance(pixels, x, y) - luminance(pixels, x, y - 1)),
						Math.abs(luminance(pixels, x, y) - luminance(pixels, x, y + 1))
					);
					for (let channel = 0; channel < 4; ++channel) {
						filtered[offset + channel] =
							channel === 3 || (filter.type === "sharpenEdges" && edge < 16)
								? pixels[offset + channel]
								: Math.round(Math.max(0, Math.min(255, pixels[offset + channel] + strength * (pixels[offset + channel] - blurred[offset + channel]))));
					}
					if (filtered[offset + 3] === 0) {
						filtered[offset] = filtered[offset + 1] = filtered[offset + 2] = 0;
					}
				}
			}
		} else {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) has unsupported type ${filter.type}.`);
		}
		if (!filter.normalizedBlendMode) {
			throw new Error(`PSD smart filter ${filter.index} (${filter.name}) has unsupported blend mode ${filter.blendMode}.`);
		}
		const amount = filter.opacity / 100;
		for (let offset = 0; offset < pixels.length; offset += 4) {
			const backdrop = [pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255] satisfies PsdRgb;
			const sourceColor = [filtered[offset] / 255, filtered[offset + 1] / 255, filtered[offset + 2] / 255] satisfies PsdRgb;
			const blended = filter.normalizedBlendMode === "norm" ? sourceColor : blendPsdVectorColor(filter.normalizedBlendMode, backdrop, sourceColor);
			const alpha = Math.round(pixels[offset + 3] * (1 - amount) + filtered[offset + 3] * amount);
			for (let channel = 0; channel < 3; ++channel) {
				pixels[offset + channel] = alpha === 0 ? 0 : Math.round(Math.max(0, Math.min(1, backdrop[channel] * (1 - amount) + blended[channel] * amount)) * 255);
			}
			pixels[offset + 3] = alpha;
		}
		appliedFilterIndices.push(filter.index);
	}
	return { pixels, appliedFilterIndices, executionModel: "bounded-smart-filter-stack-v1" };
}

/** Renders one decoded embedded PSD composite through its authored smart-object corner transform into a bounded RGBA8 rectangle. */
export function renderPsdSmartObjectPlacement(
	source: Pick<IDecodedPsdImage, "pixels" | "width" | "height">,
	corners: [number, number, number, number, number, number, number, number],
	maximumPixels = MAXIMUM_PSD_LAYER_PIXELS
): IPsdSmartObjectPlacementRenderResult {
	if (
		!Number.isSafeInteger(source.width) ||
		!Number.isSafeInteger(source.height) ||
		source.width <= 0 ||
		source.height <= 0 ||
		source.pixels.byteLength !== source.width * source.height * 4
	) {
		throw new Error("PSD smart-object source must contain an exact positive RGBA8 raster.");
	}
	if (corners.length !== 8 || corners.some((value) => !Number.isFinite(value) || Math.abs(value) > 16_777_216)) {
		throw new Error("PSD smart-object placement requires eight finite bounded corner coordinates.");
	}
	if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1 || maximumPixels > MAXIMUM_PSD_LAYER_PIXELS) {
		throw new Error(`PSD smart-object placement maximumPixels must be an integer between 1 and ${MAXIMUM_PSD_LAYER_PIXELS}.`);
	}
	const xCoordinates = [corners[0], corners[2], corners[4], corners[6]];
	const yCoordinates = [corners[1], corners[3], corners[5], corners[7]];
	const inverse = invertProjectiveMatrix(smartObjectProjectiveMatrix(corners));
	const left = Math.floor(Math.min(...xCoordinates));
	const top = Math.floor(Math.min(...yCoordinates));
	const right = Math.ceil(Math.max(...xCoordinates));
	const bottom = Math.ceil(Math.max(...yCoordinates));
	const width = right - left;
	const height = bottom - top;
	if (width <= 0 || height <= 0 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > maximumPixels) {
		throw new Error(`PSD smart-object placement output ${width}x${height} exceeds the bounded ${maximumPixels}-pixel raster limit.`);
	}
	const pixels = new Uint8Array(width * height * 4);
	const sample = (u: number, v: number, channel: number): number => {
		const sourceX = Math.max(0, Math.min(source.width - 1, u * source.width - 0.5));
		const sourceY = Math.max(0, Math.min(source.height - 1, v * source.height - 0.5));
		const x0 = Math.floor(sourceX);
		const y0 = Math.floor(sourceY);
		const x1 = Math.min(source.width - 1, x0 + 1);
		const y1 = Math.min(source.height - 1, y0 + 1);
		const tx = sourceX - x0;
		const ty = sourceY - y0;
		const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), tx * ty, (1 - tx) * ty];
		const offsets = [(y0 * source.width + x0) * 4, (y0 * source.width + x1) * 4, (y1 * source.width + x1) * 4, (y1 * source.width + x0) * 4];
		if (channel === 3) {
			return offsets.reduce((value, offset, index) => value + source.pixels[offset + 3] * weights[index], 0);
		}
		const alpha = offsets.reduce((value, offset, index) => value + (source.pixels[offset + 3] / 255) * weights[index], 0);
		if (alpha <= 1e-12) {
			return 0;
		}
		return offsets.reduce((value, offset, index) => value + source.pixels[offset + channel] * (source.pixels[offset + 3] / 255) * weights[index], 0) / alpha;
	};
	for (let y = 0; y < height; ++y) {
		for (let x = 0; x < width; ++x) {
			const destinationX = left + x + 0.5;
			const destinationY = top + y + 0.5;
			const denominator = inverse[6] * destinationX + inverse[7] * destinationY + inverse[8];
			if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
				continue;
			}
			const u = (inverse[0] * destinationX + inverse[1] * destinationY + inverse[2]) / denominator;
			const v = (inverse[3] * destinationX + inverse[4] * destinationY + inverse[5]) / denominator;
			if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) {
				continue;
			}
			const offset = (y * width + x) * 4;
			pixels[offset] = Math.round(sample(u, v, 0));
			pixels[offset + 1] = Math.round(sample(u, v, 1));
			pixels[offset + 2] = Math.round(sample(u, v, 2));
			pixels[offset + 3] = Math.round(sample(u, v, 3));
		}
	}
	return { pixels, left, top, width, height, corners: [...corners], sampling: "premultiplied-bilinear", executionModel: "bounded-projective-smart-object-v1" };
}

/** Renders a standard Photoshop smart-object warp preset through a bounded analytical surface and authored corner placement. */
export function renderPsdSmartObjectPresetWarpPlacement(
	source: Pick<IDecodedPsdImage, "pixels" | "width" | "height">,
	corners: [number, number, number, number, number, number, number, number],
	options: IPsdSmartObjectPresetWarpOptions,
	maximumPixels = MAXIMUM_PSD_LAYER_PIXELS
): IPsdSmartObjectPresetWarpRenderResult {
	if (
		!Number.isSafeInteger(source.width) ||
		!Number.isSafeInteger(source.height) ||
		source.width <= 0 ||
		source.height <= 0 ||
		source.pixels.byteLength !== source.width * source.height * 4
	) {
		throw new Error("PSD smart-object preset warp source must contain an exact positive RGBA8 raster.");
	}
	if (!(PSD_SMART_OBJECT_PRESET_WARP_STYLES as readonly string[]).includes(options.style)) {
		throw new Error(`PSD smart-object preset warp style ${String(options.style)} is unsupported.`);
	}
	if (
		![options.value, options.perspective, options.perspectiveOther].every((value) => Number.isFinite(value) && value >= -100 && value <= 100) ||
		(options.rotate !== "horizontal" && options.rotate !== "vertical")
	) {
		throw new Error("PSD smart-object preset warp requires finite value and perspective controls from -100 through 100 plus a horizontal or vertical orientation.");
	}
	if (corners.length !== 8 || corners.some((value) => !Number.isFinite(value) || Math.abs(value) > 16_777_216)) {
		throw new Error("PSD smart-object preset warp requires eight finite bounded placement corners.");
	}
	if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1 || maximumPixels > MAXIMUM_PSD_LAYER_PIXELS) {
		throw new Error(`PSD smart-object preset warp maximumPixels must be an integer between 1 and ${MAXIMUM_PSD_LAYER_PIXELS}.`);
	}
	const matrix = smartObjectProjectiveMatrix(corners);
	invertProjectiveMatrix(matrix);
	const project = (u: number, v: number): { x: number; y: number } => {
		const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
		if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
			throw new Error("PSD smart-object preset warp produces a degenerate projective point.");
		}
		return { x: (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator, y: (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator };
	};
	const deform = (horizontal: number, vertical: number): { x: number; y: number } => {
		let x = options.rotate === "vertical" ? vertical : horizontal;
		let y = options.rotate === "vertical" ? -horizontal : vertical;
		const strength = options.value / 100;
		const parabolaX = 1 - x * x;
		const parabolaY = 1 - y * y;
		const radial = Math.min(1, Math.sqrt(x * x + y * y));
		const originalX = x;
		const originalY = y;
		switch (options.style) {
			case "warpArc":
				y -= strength * 0.75 * parabolaX;
				break;
			case "warpArcLower":
				y -= strength * 0.9 * parabolaX * (y + 1) * 0.5;
				break;
			case "warpArcUpper":
				y -= strength * 0.9 * parabolaX * (1 - y) * 0.5;
				break;
			case "warpArch":
				y -= strength * 0.75 * parabolaX * (1 - 0.2 * y);
				x *= 1 - Math.abs(strength) * 0.12 * parabolaY;
				break;
			case "warpBulge":
				x *= 1 + strength * 0.55 * parabolaY;
				y *= 1 + strength * 0.18 * parabolaX;
				break;
			case "warpShellLower":
				y -= strength * 0.75 * parabolaX * (y + 1) * 0.5;
				x *= 1 - strength * 0.3 * (1 - y) * 0.5;
				break;
			case "warpShellUpper":
				y -= strength * 0.75 * parabolaX * (1 - y) * 0.5;
				x *= 1 - strength * 0.3 * (y + 1) * 0.5;
				break;
			case "warpFlag":
				y -= strength * 0.5 * Math.sin(Math.PI * x);
				break;
			case "warpWave":
				y -= strength * 0.35 * Math.sin(Math.PI * 2 * x + Math.PI * 0.25);
				x += strength * 0.08 * Math.sin(Math.PI * 2 * y);
				break;
			case "warpFish":
				x += strength * 0.45 * parabolaX * (1 - 0.35 * y);
				y *= 1 - strength * 0.28 * x;
				break;
			case "warpRise":
				y -= strength * 0.65 * ((x + 1) * 0.5) ** 1.5;
				x *= 1 - Math.abs(strength) * 0.08 * parabolaY;
				break;
			case "warpFisheye":
			case "warpFishEye": {
				const scale = 1 + strength * 0.65 * (1 - radial * radial);
				x *= scale;
				y *= scale;
				break;
			}
			case "warpInflate": {
				const scale = 1 + strength * 0.5 * (1 - radial) ** 2;
				x *= scale;
				y *= scale;
				break;
			}
			case "warpSqueeze":
				x *= 1 - strength * 0.58 * parabolaY;
				y *= 1 + strength * 0.12 * parabolaX;
				break;
			case "warpTwist": {
				const angle = strength * Math.PI * 0.7 * (1 - radial) ** 2;
				const cosine = Math.cos(angle);
				const sine = Math.sin(angle);
				x = originalX * cosine - originalY * sine;
				y = originalX * sine + originalY * cosine;
				break;
			}
			case "warpCylinder":
				x += strength * 0.4 * x * parabolaX;
				break;
		}
		const beforePerspectiveX = x;
		const beforePerspectiveY = y;
		x *= 1 + (options.perspective / 100) * 0.5 * beforePerspectiveY;
		y *= 1 + (options.perspectiveOther / 100) * 0.5 * beforePerspectiveX;
		if (options.rotate === "vertical") {
			return { x: -y, y: x };
		}
		return { x, y };
	};
	const evaluate = (u: number, v: number): { x: number; y: number; u: number; v: number } => {
		const warped = deform(u * 2 - 1, v * 2 - 1);
		if (!Number.isFinite(warped.x) || !Number.isFinite(warped.y) || Math.abs(warped.x) > 8 || Math.abs(warped.y) > 8) {
			throw new Error("PSD smart-object preset warp produced a non-finite or unbounded analytical point.");
		}
		return { ...project((warped.x + 1) * 0.5, (warped.y + 1) * 0.5), u, v };
	};
	const tessellation = 64;
	const stride = tessellation + 1;
	const vertices = Array.from({ length: stride * stride }, (_, index) => evaluate((index % stride) / tessellation, Math.floor(index / stride) / tessellation));
	const left = Math.floor(Math.min(...vertices.map((vertex) => vertex.x)));
	const top = Math.floor(Math.min(...vertices.map((vertex) => vertex.y)));
	const right = Math.ceil(Math.max(...vertices.map((vertex) => vertex.x)));
	const bottom = Math.ceil(Math.max(...vertices.map((vertex) => vertex.y)));
	const width = right - left;
	const height = bottom - top;
	if (width <= 0 || height <= 0 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > maximumPixels) {
		throw new Error(`PSD smart-object preset warp output ${width}x${height} exceeds the bounded ${maximumPixels}-pixel raster limit.`);
	}
	const pixels = new Uint8Array(width * height * 4);
	const sample = (u: number, v: number, channel: number): number => {
		const sourceX = Math.max(0, Math.min(source.width - 1, u * source.width - 0.5));
		const sourceY = Math.max(0, Math.min(source.height - 1, v * source.height - 0.5));
		const x0 = Math.floor(sourceX);
		const y0 = Math.floor(sourceY);
		const x1 = Math.min(source.width - 1, x0 + 1);
		const y1 = Math.min(source.height - 1, y0 + 1);
		const tx = sourceX - x0;
		const ty = sourceY - y0;
		const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), tx * ty, (1 - tx) * ty];
		const offsets = [(y0 * source.width + x0) * 4, (y0 * source.width + x1) * 4, (y1 * source.width + x1) * 4, (y1 * source.width + x0) * 4];
		if (channel === 3) {
			return offsets.reduce((result, offset, index) => result + source.pixels[offset + 3] * weights[index], 0);
		}
		const alpha = offsets.reduce((result, offset, index) => result + (source.pixels[offset + 3] / 255) * weights[index], 0);
		return alpha <= 1e-12
			? 0
			: offsets.reduce((result, offset, index) => result + source.pixels[offset + channel] * (source.pixels[offset + 3] / 255) * weights[index], 0) / alpha;
	};
	type Vertex = (typeof vertices)[number];
	const rasterize = (first: Vertex, second: Vertex, third: Vertex): void => {
		const area = (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
		if (!Number.isFinite(area) || Math.abs(area) < 1e-10) {
			return;
		}
		const minimumX = Math.max(0, Math.floor(Math.min(first.x, second.x, third.x) - left));
		const maximumX = Math.min(width - 1, Math.ceil(Math.max(first.x, second.x, third.x) - left));
		const minimumY = Math.max(0, Math.floor(Math.min(first.y, second.y, third.y) - top));
		const maximumY = Math.min(height - 1, Math.ceil(Math.max(first.y, second.y, third.y) - top));
		for (let y = minimumY; y <= maximumY; ++y) {
			for (let x = minimumX; x <= maximumX; ++x) {
				const destinationX = left + x + 0.5;
				const destinationY = top + y + 0.5;
				const secondWeight = ((destinationX - first.x) * (third.y - first.y) - (destinationY - first.y) * (third.x - first.x)) / area;
				const thirdWeight = ((second.x - first.x) * (destinationY - first.y) - (second.y - first.y) * (destinationX - first.x)) / area;
				const firstWeight = 1 - secondWeight - thirdWeight;
				if (firstWeight < -1e-7 || secondWeight < -1e-7 || thirdWeight < -1e-7) {
					continue;
				}
				const u = first.u * firstWeight + second.u * secondWeight + third.u * thirdWeight;
				const v = first.v * firstWeight + second.v * secondWeight + third.v * thirdWeight;
				const offset = (y * width + x) * 4;
				pixels[offset] = Math.round(sample(u, v, 0));
				pixels[offset + 1] = Math.round(sample(u, v, 1));
				pixels[offset + 2] = Math.round(sample(u, v, 2));
				pixels[offset + 3] = Math.round(sample(u, v, 3));
			}
		}
	};
	for (let row = 0; row < tessellation; ++row) {
		for (let column = 0; column < tessellation; ++column) {
			const topLeft = vertices[row * stride + column];
			const topRight = vertices[row * stride + column + 1];
			const bottomLeft = vertices[(row + 1) * stride + column];
			const bottomRight = vertices[(row + 1) * stride + column + 1];
			rasterize(topLeft, topRight, bottomRight);
			rasterize(topLeft, bottomRight, bottomLeft);
		}
	}
	return {
		pixels,
		left,
		top,
		width,
		height,
		corners: [...corners],
		sampling: "premultiplied-bilinear",
		...options,
		tessellation,
		executionModel: "bounded-analytical-preset-smart-object-warp-v1",
	};
}

/** Renders one decoded raster through a bounded tensor-product Bezier smart-object envelope and authored corner placement. */
export function renderPsdSmartObjectWarpPlacement(
	source: Pick<IDecodedPsdImage, "pixels" | "width" | "height">,
	corners: [number, number, number, number, number, number, number, number],
	meshPoints: Array<{ x: number; y: number }>,
	uOrder: number,
	vOrder: number,
	maximumPixels = MAXIMUM_PSD_LAYER_PIXELS
): IPsdSmartObjectWarpRenderResult {
	if (
		!Number.isSafeInteger(source.width) ||
		!Number.isSafeInteger(source.height) ||
		source.width <= 0 ||
		source.height <= 0 ||
		source.pixels.byteLength !== source.width * source.height * 4
	) {
		throw new Error("PSD smart-object warp source must contain an exact positive RGBA8 raster.");
	}
	if (
		!Number.isSafeInteger(uOrder) ||
		!Number.isSafeInteger(vOrder) ||
		uOrder < 2 ||
		vOrder < 2 ||
		uOrder > 16 ||
		vOrder > 16 ||
		meshPoints.length !== uOrder * vOrder ||
		meshPoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 16_777_216 || Math.abs(point.y) > 16_777_216)
	) {
		throw new Error("PSD smart-object custom warp requires an exact bounded 2-16 by 2-16 control-point grid.");
	}
	if (corners.length !== 8 || corners.some((value) => !Number.isFinite(value) || Math.abs(value) > 16_777_216)) {
		throw new Error("PSD smart-object custom warp requires eight finite bounded placement corners.");
	}
	if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1 || maximumPixels > MAXIMUM_PSD_LAYER_PIXELS) {
		throw new Error(`PSD smart-object custom warp maximumPixels must be an integer between 1 and ${MAXIMUM_PSD_LAYER_PIXELS}.`);
	}
	const matrix = smartObjectProjectiveMatrix(corners);
	invertProjectiveMatrix(matrix);
	const project = (x: number, y: number): { x: number; y: number } => {
		const u = x / source.width;
		const v = y / source.height;
		const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
		if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
			throw new Error("PSD smart-object custom warp produces a degenerate projective point.");
		}
		return { x: (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator, y: (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator };
	};
	const binomial = (degree: number, index: number): number => {
		let value = 1;
		for (let step = 1; step <= index; ++step) {
			value = (value * (degree - index + step)) / step;
		}
		return value;
	};
	const basis = (order: number, value: number): number[] => {
		const degree = order - 1;
		return Array.from({ length: order }, (_, index) => binomial(degree, index) * value ** index * (1 - value) ** (degree - index));
	};
	const evaluate = (u: number, v: number): { x: number; y: number; u: number; v: number } => {
		const horizontal = basis(uOrder, u);
		const vertical = basis(vOrder, v);
		let x = 0;
		let y = 0;
		for (let row = 0; row < vOrder; ++row) {
			for (let column = 0; column < uOrder; ++column) {
				const weight = horizontal[column] * vertical[row];
				const point = meshPoints[row * uOrder + column];
				x += point.x * weight;
				y += point.y * weight;
			}
		}
		return { ...project(x, y), u, v };
	};
	const tessellation = Math.max(16, Math.min(64, Math.max(uOrder, vOrder) * 8));
	const stride = tessellation + 1;
	const vertices = Array.from({ length: stride * stride }, (_, index) => evaluate((index % stride) / tessellation, Math.floor(index / stride) / tessellation));
	const left = Math.floor(Math.min(...vertices.map((vertex) => vertex.x)));
	const top = Math.floor(Math.min(...vertices.map((vertex) => vertex.y)));
	const right = Math.ceil(Math.max(...vertices.map((vertex) => vertex.x)));
	const bottom = Math.ceil(Math.max(...vertices.map((vertex) => vertex.y)));
	const width = right - left;
	const height = bottom - top;
	if (width <= 0 || height <= 0 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > maximumPixels) {
		throw new Error(`PSD smart-object custom warp output ${width}x${height} exceeds the bounded ${maximumPixels}-pixel raster limit.`);
	}
	const pixels = new Uint8Array(width * height * 4);
	const sample = (u: number, v: number, channel: number): number => {
		const sourceX = Math.max(0, Math.min(source.width - 1, u * source.width - 0.5));
		const sourceY = Math.max(0, Math.min(source.height - 1, v * source.height - 0.5));
		const x0 = Math.floor(sourceX);
		const y0 = Math.floor(sourceY);
		const x1 = Math.min(source.width - 1, x0 + 1);
		const y1 = Math.min(source.height - 1, y0 + 1);
		const tx = sourceX - x0;
		const ty = sourceY - y0;
		const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), tx * ty, (1 - tx) * ty];
		const offsets = [(y0 * source.width + x0) * 4, (y0 * source.width + x1) * 4, (y1 * source.width + x1) * 4, (y1 * source.width + x0) * 4];
		if (channel === 3) {
			return offsets.reduce((result, offset, index) => result + source.pixels[offset + 3] * weights[index], 0);
		}
		const alpha = offsets.reduce((result, offset, index) => result + (source.pixels[offset + 3] / 255) * weights[index], 0);
		return alpha <= 1e-12
			? 0
			: offsets.reduce((result, offset, index) => result + source.pixels[offset + channel] * (source.pixels[offset + 3] / 255) * weights[index], 0) / alpha;
	};
	type Vertex = (typeof vertices)[number];
	const rasterize = (first: Vertex, second: Vertex, third: Vertex): void => {
		const area = (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
		if (!Number.isFinite(area) || Math.abs(area) < 1e-10) {
			return;
		}
		const minimumX = Math.max(0, Math.floor(Math.min(first.x, second.x, third.x) - left));
		const maximumX = Math.min(width - 1, Math.ceil(Math.max(first.x, second.x, third.x) - left));
		const minimumY = Math.max(0, Math.floor(Math.min(first.y, second.y, third.y) - top));
		const maximumY = Math.min(height - 1, Math.ceil(Math.max(first.y, second.y, third.y) - top));
		for (let y = minimumY; y <= maximumY; ++y) {
			for (let x = minimumX; x <= maximumX; ++x) {
				const destinationX = left + x + 0.5;
				const destinationY = top + y + 0.5;
				const secondWeight = ((destinationX - first.x) * (third.y - first.y) - (destinationY - first.y) * (third.x - first.x)) / area;
				const thirdWeight = ((second.x - first.x) * (destinationY - first.y) - (second.y - first.y) * (destinationX - first.x)) / area;
				const firstWeight = 1 - secondWeight - thirdWeight;
				if (firstWeight < -1e-7 || secondWeight < -1e-7 || thirdWeight < -1e-7) {
					continue;
				}
				const u = first.u * firstWeight + second.u * secondWeight + third.u * thirdWeight;
				const v = first.v * firstWeight + second.v * secondWeight + third.v * thirdWeight;
				const offset = (y * width + x) * 4;
				pixels[offset] = Math.round(sample(u, v, 0));
				pixels[offset + 1] = Math.round(sample(u, v, 1));
				pixels[offset + 2] = Math.round(sample(u, v, 2));
				pixels[offset + 3] = Math.round(sample(u, v, 3));
			}
		}
	};
	for (let row = 0; row < tessellation; ++row) {
		for (let column = 0; column < tessellation; ++column) {
			const topLeft = vertices[row * stride + column];
			const topRight = vertices[row * stride + column + 1];
			const bottomLeft = vertices[(row + 1) * stride + column];
			const bottomRight = vertices[(row + 1) * stride + column + 1];
			rasterize(topLeft, topRight, bottomRight);
			rasterize(topLeft, bottomRight, bottomLeft);
		}
	}
	return {
		pixels,
		left,
		top,
		width,
		height,
		corners: [...corners],
		sampling: "premultiplied-bilinear",
		uOrder,
		vOrder,
		meshPointCount: meshPoints.length,
		tessellation,
		executionModel: "bounded-bezier-smart-object-warp-v1",
	};
}

/** Renders one decoded raster through an exact bounded piecewise-Bezier Photoshop quilt envelope and authored corner placement. */
export function renderPsdSmartObjectQuiltWarpPlacement(
	source: Pick<IDecodedPsdImage, "pixels" | "width" | "height">,
	corners: [number, number, number, number, number, number, number, number],
	options: IPsdSmartObjectQuiltWarpOptions,
	maximumPixels = MAXIMUM_PSD_LAYER_PIXELS
): IPsdSmartObjectQuiltWarpRenderResult {
	const { meshPoints, uOrder, vOrder, deformNumRows, deformNumCols, quiltSliceX, quiltSliceY } = options;
	if (
		!Number.isSafeInteger(source.width) ||
		!Number.isSafeInteger(source.height) ||
		source.width <= 0 ||
		source.height <= 0 ||
		source.pixels.byteLength !== source.width * source.height * 4
	) {
		throw new Error("PSD smart-object quilt warp source must contain an exact positive RGBA8 raster.");
	}
	const controlColumns = deformNumCols * (uOrder - 1) + 1;
	const controlRows = deformNumRows * (vOrder - 1) + 1;
	if (
		!Number.isSafeInteger(uOrder) ||
		!Number.isSafeInteger(vOrder) ||
		uOrder < 2 ||
		vOrder < 2 ||
		uOrder > 16 ||
		vOrder > 16 ||
		!Number.isSafeInteger(deformNumRows) ||
		!Number.isSafeInteger(deformNumCols) ||
		deformNumRows < 1 ||
		deformNumCols < 1 ||
		controlColumns > 64 ||
		controlRows > 64 ||
		meshPoints.length !== controlColumns * controlRows ||
		meshPoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 16_777_216 || Math.abs(point.y) > 16_777_216)
	) {
		throw new Error("PSD smart-object quilt warp requires an exact bounded piecewise control lattice with at most 64 by 64 points.");
	}
	if (corners.length !== 8 || corners.some((value) => !Number.isFinite(value) || Math.abs(value) > 16_777_216)) {
		throw new Error("PSD smart-object quilt warp requires eight finite bounded placement corners.");
	}
	if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1 || maximumPixels > MAXIMUM_PSD_LAYER_PIXELS) {
		throw new Error(`PSD smart-object quilt warp maximumPixels must be an integer between 1 and ${MAXIMUM_PSD_LAYER_PIXELS}.`);
	}
	const boundaries = (values: number[], count: number, extent: number, axis: string): number[] => {
		const result = values.length ? [...values] : Array.from({ length: count + 1 }, (_, index) => (index * extent) / count);
		const tolerance = Math.max(1e-6, extent * 1e-6);
		if (
			result.length !== count + 1 ||
			result.some((value) => !Number.isFinite(value)) ||
			Math.abs(result[0]) > tolerance ||
			Math.abs(result[result.length - 1] - extent) > tolerance ||
			result.some((value, index) => index > 0 && value <= result[index - 1])
		) {
			throw new Error(`PSD smart-object quilt warp ${axis} slices must be strictly increasing from 0 to the source ${axis} extent.`);
		}
		return result;
	};
	const slicesX = boundaries(quiltSliceX, deformNumCols, source.width, "horizontal");
	const slicesY = boundaries(quiltSliceY, deformNumRows, source.height, "vertical");
	const matrix = smartObjectProjectiveMatrix(corners);
	invertProjectiveMatrix(matrix);
	const project = (x: number, y: number): { x: number; y: number } => {
		const u = x / source.width;
		const v = y / source.height;
		const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
		if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
			throw new Error("PSD smart-object quilt warp produces a degenerate projective point.");
		}
		return { x: (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator, y: (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator };
	};
	const binomial = (degree: number, index: number): number => {
		let value = 1;
		for (let step = 1; step <= index; ++step) {
			value = (value * (degree - index + step)) / step;
		}
		return value;
	};
	const basis = (order: number, value: number): number[] => {
		const degree = order - 1;
		return Array.from({ length: order }, (_, index) => binomial(degree, index) * value ** index * (1 - value) ** (degree - index));
	};
	const locatePatch = (value: number, slices: number[]): { index: number; local: number } => {
		const position = value * slices[slices.length - 1];
		let index = slices.length - 2;
		for (let candidate = 0; candidate < slices.length - 1; ++candidate) {
			if (position <= slices[candidate + 1] || candidate === slices.length - 2) {
				index = candidate;
				break;
			}
		}
		return { index, local: Math.max(0, Math.min(1, (position - slices[index]) / (slices[index + 1] - slices[index]))) };
	};
	const evaluate = (u: number, v: number): { x: number; y: number; u: number; v: number } => {
		const horizontalPatch = locatePatch(u, slicesX);
		const verticalPatch = locatePatch(v, slicesY);
		const horizontal = basis(uOrder, horizontalPatch.local);
		const vertical = basis(vOrder, verticalPatch.local);
		const startColumn = horizontalPatch.index * (uOrder - 1);
		const startRow = verticalPatch.index * (vOrder - 1);
		let x = 0;
		let y = 0;
		for (let row = 0; row < vOrder; ++row) {
			for (let column = 0; column < uOrder; ++column) {
				const weight = horizontal[column] * vertical[row];
				const point = meshPoints[(startRow + row) * controlColumns + startColumn + column];
				x += point.x * weight;
				y += point.y * weight;
			}
		}
		return { ...project(x, y), u, v };
	};
	const tessellation = Math.max(16, Math.min(128, Math.max(controlColumns, controlRows) * 4));
	const stride = tessellation + 1;
	const vertices = Array.from({ length: stride * stride }, (_, index) => evaluate((index % stride) / tessellation, Math.floor(index / stride) / tessellation));
	const left = Math.floor(Math.min(...vertices.map((vertex) => vertex.x)));
	const top = Math.floor(Math.min(...vertices.map((vertex) => vertex.y)));
	const right = Math.ceil(Math.max(...vertices.map((vertex) => vertex.x)));
	const bottom = Math.ceil(Math.max(...vertices.map((vertex) => vertex.y)));
	const width = right - left;
	const height = bottom - top;
	if (width <= 0 || height <= 0 || width > MAXIMUM_PSD_DIMENSION || height > MAXIMUM_PSD_DIMENSION || width * height > maximumPixels) {
		throw new Error(`PSD smart-object quilt warp output ${width}x${height} exceeds the bounded ${maximumPixels}-pixel raster limit.`);
	}
	const pixels = new Uint8Array(width * height * 4);
	const sample = (u: number, v: number, channel: number): number => {
		const sourceX = Math.max(0, Math.min(source.width - 1, u * source.width - 0.5));
		const sourceY = Math.max(0, Math.min(source.height - 1, v * source.height - 0.5));
		const x0 = Math.floor(sourceX);
		const y0 = Math.floor(sourceY);
		const x1 = Math.min(source.width - 1, x0 + 1);
		const y1 = Math.min(source.height - 1, y0 + 1);
		const tx = sourceX - x0;
		const ty = sourceY - y0;
		const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), tx * ty, (1 - tx) * ty];
		const offsets = [(y0 * source.width + x0) * 4, (y0 * source.width + x1) * 4, (y1 * source.width + x1) * 4, (y1 * source.width + x0) * 4];
		if (channel === 3) {
			return offsets.reduce((result, offset, index) => result + source.pixels[offset + 3] * weights[index], 0);
		}
		const alpha = offsets.reduce((result, offset, index) => result + (source.pixels[offset + 3] / 255) * weights[index], 0);
		return alpha <= 1e-12
			? 0
			: offsets.reduce((result, offset, index) => result + source.pixels[offset + channel] * (source.pixels[offset + 3] / 255) * weights[index], 0) / alpha;
	};
	type Vertex = (typeof vertices)[number];
	const rasterize = (first: Vertex, second: Vertex, third: Vertex): void => {
		const area = (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
		if (!Number.isFinite(area) || Math.abs(area) < 1e-10) {
			return;
		}
		const minimumX = Math.max(0, Math.floor(Math.min(first.x, second.x, third.x) - left));
		const maximumX = Math.min(width - 1, Math.ceil(Math.max(first.x, second.x, third.x) - left));
		const minimumY = Math.max(0, Math.floor(Math.min(first.y, second.y, third.y) - top));
		const maximumY = Math.min(height - 1, Math.ceil(Math.max(first.y, second.y, third.y) - top));
		for (let y = minimumY; y <= maximumY; ++y) {
			for (let x = minimumX; x <= maximumX; ++x) {
				const destinationX = left + x + 0.5;
				const destinationY = top + y + 0.5;
				const secondWeight = ((destinationX - first.x) * (third.y - first.y) - (destinationY - first.y) * (third.x - first.x)) / area;
				const thirdWeight = ((second.x - first.x) * (destinationY - first.y) - (second.y - first.y) * (destinationX - first.x)) / area;
				const firstWeight = 1 - secondWeight - thirdWeight;
				if (firstWeight < -1e-7 || secondWeight < -1e-7 || thirdWeight < -1e-7) {
					continue;
				}
				const u = first.u * firstWeight + second.u * secondWeight + third.u * thirdWeight;
				const v = first.v * firstWeight + second.v * secondWeight + third.v * thirdWeight;
				const offset = (y * width + x) * 4;
				pixels[offset] = Math.round(sample(u, v, 0));
				pixels[offset + 1] = Math.round(sample(u, v, 1));
				pixels[offset + 2] = Math.round(sample(u, v, 2));
				pixels[offset + 3] = Math.round(sample(u, v, 3));
			}
		}
	};
	for (let row = 0; row < tessellation; ++row) {
		for (let column = 0; column < tessellation; ++column) {
			const topLeft = vertices[row * stride + column];
			const topRight = vertices[row * stride + column + 1];
			const bottomLeft = vertices[(row + 1) * stride + column];
			const bottomRight = vertices[(row + 1) * stride + column + 1];
			rasterize(topLeft, topRight, bottomRight);
			rasterize(topLeft, bottomRight, bottomLeft);
		}
	}
	return {
		pixels,
		left,
		top,
		width,
		height,
		corners: [...corners],
		sampling: "premultiplied-bilinear",
		uOrder,
		vOrder,
		deformNumRows,
		deformNumCols,
		meshPointCount: meshPoints.length,
		quiltSliceX: [...slicesX],
		quiltSliceY: [...slicesY],
		tessellation,
		executionModel: "bounded-piecewise-bezier-smart-object-quilt-warp-v1",
	};
}

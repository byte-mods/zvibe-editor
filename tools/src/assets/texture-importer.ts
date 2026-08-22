import { ITextureImporterPlatformOverrides, normalizeTextureImporterPlatformOverrides, TextureImporterPlatform } from "./texture-platform-overrides";

export type TextureImporterTextureType = "default" | "normalMap" | "sprite" | "lightmap" | "cursor";
export type TextureImporterColorSpace = "sRGB" | "linear";
export type TextureImporterAlphaSource = "input" | "none" | "grayscale";
export type TextureImporterResizeAlgorithm = "nearest" | "bilinear" | "bicubic" | "lanczos3";
export type TextureImporterCompression = "none" | "low" | "normal" | "high";
export type TextureImporterOutputFormat = "automatic" | "png" | "jpeg" | "webp";
export type TextureImporterNonPowerOfTwo = "none" | "toNearest" | "toLarger" | "toSmaller";
export type TextureImporterMipmapFilter = "box" | "kaiser";
export type TextureImporterFilterMode = "point" | "bilinear" | "trilinear";
export type TextureImporterWrapMode = "repeat" | "clamp" | "mirror";
export type TextureImporterNormalMapSource = "color" | "height";
export type TextureImporterSpriteMeshType = "fullRect" | "tight";

export interface ITextureImporterSettings {
	textureType: TextureImporterTextureType;
	outputFormat: TextureImporterOutputFormat;
	colorSpace: TextureImporterColorSpace;
	alphaSource: TextureImporterAlphaSource;
	alphaIsTransparency: boolean;
	nonPowerOfTwo: TextureImporterNonPowerOfTwo;
	generateMipmaps: boolean;
	mipmapFilter: TextureImporterMipmapFilter;
	mipmapPreserveCoverage: boolean;
	mipmapAlphaTestReference: number;
	maxSize: number;
	resizeAlgorithm: TextureImporterResizeAlgorithm;
	compression: TextureImporterCompression;
	readable: boolean;
	filterMode: TextureImporterFilterMode;
	wrapModeU: TextureImporterWrapMode;
	wrapModeV: TextureImporterWrapMode;
	anisoLevel: number;
	normalMapSource: TextureImporterNormalMapSource;
	normalMapStrength: number;
	spritePixelsPerUnit: number;
	spriteMeshType: TextureImporterSpriteMeshType;
	spriteExtrude: number;
	platformOverrides: ITextureImporterPlatformOverrides;
}

export interface ITextureImportProbe {
	format: string;
	width: number;
	height: number;
	channels: number;
	hasAlpha: boolean;
	space: string;
	bytes: number;
	pixelFormat?: string;
	minimum?: [number, number, number, number];
	maximum?: [number, number, number, number];
	average?: [number, number, number, number];
	nonFiniteCount?: number;
}

export interface ITextureImportMipmap {
	path: string;
	width: number;
	height: number;
	bytes: number;
	alphaCoverageBefore?: number;
	alphaCoverageAfter?: number;
	alphaCoverageScale?: number;
}

export interface ITextureImportProcessingEvidence {
	outputFormat: string;
	maxSizeApplied: boolean;
	nonPowerOfTwoApplied: boolean;
	fullMipChain: boolean;
	alphaDerivedFromGrayscale: boolean;
	transparentColorsDilated: boolean;
	normalMapGenerated: boolean;
	mipmapCoveragePreserved: boolean;
}

export interface ITextureImportSpriteMetadata {
	pixelsPerUnit: number;
	meshType: TextureImporterSpriteMeshType;
	extrude: number;
	bounds: { x: number; y: number; width: number; height: number };
}

export interface ITextureImportCubeFace {
	face: "px" | "nx" | "py" | "ny" | "pz" | "nz";
	path: string;
	width: number;
	height: number;
}

export interface ITextureImportHighDynamicRange {
	linear: true;
	compression: string;
	pixelFormat: string;
	toneMapper: "aces";
	exposure: number;
	equirectangular: boolean;
	cubeFaceSize: number | null;
	cubeFaces: ITextureImportCubeFace[];
	environmentPath: string | null;
}

export interface ITextureImportResult {
	sourcePath: string;
	outputPath: string;
	settings: ITextureImporterSettings;
	baseSettings: ITextureImporterSettings;
	platform: TextureImporterPlatform;
	platformOverrideApplied: boolean;
	effectiveColorSpace: TextureImporterColorSpace;
	converted: boolean;
	resized: boolean;
	alphaRemoved: boolean;
	processing: ITextureImportProcessingEvidence;
	sprite: ITextureImportSpriteMetadata | null;
	source: ITextureImportProbe;
	output: ITextureImportProbe;
	mipmaps: ITextureImportMipmap[];
	readableBitmapPath: string | null;
	readableDescriptorPath: string | null;
	readablePixelFormat?: "rgba8" | "rgba32f" | null;
	previewPath?: string | null;
	highDynamicRange?: ITextureImportHighDynamicRange | null;
	warnings: string[];
}

export interface ITextureRuntimeManifest {
	version: 2;
	outputPath: string;
	textureType: TextureImporterTextureType;
	colorSpace: TextureImporterColorSpace;
	alphaSource: TextureImporterAlphaSource;
	generateMipmaps: boolean;
	filterMode: TextureImporterFilterMode;
	wrapModeU: TextureImporterWrapMode;
	wrapModeV: TextureImporterWrapMode;
	anisoLevel: number;
	sprite: ITextureImportSpriteMetadata | null;
	processing: ITextureImportProcessingEvidence;
	readableBitmapPath: string | null;
	readableDescriptorPath: string | null;
	previewPath?: string | null;
	cubeFaces?: ITextureImportCubeFace[];
	environmentPath?: string | null;
	mipmaps: Array<{ path: string; width: number; height: number }>;
	result?: ITextureImportResult;
}

export interface ITextureImporterEncodingOptions {
	quality: number;
	compressionLevel: number;
	lossless: boolean;
}

/** Accepts absent legacy fields through one explicit default while rejecting unknown persisted enum values. */
function enumSetting<T extends string>(settings: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
	const value = settings[key] ?? fallback;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`Texture importer ${key} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

/** Keeps every numeric build input finite and bounded before dimensions or buffers are derived from it. */
function numberSetting(settings: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number, integer = false): number {
	const value = settings[key] ?? fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
		throw new Error(`Texture importer ${key} must be ${integer ? "an integer" : "a finite number"} from ${minimum} through ${maximum}.`);
	}
	return value;
}

/** Prevents string/number truthiness from changing build behavior when legacy metadata is malformed. */
function booleanSetting(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = settings[key] ?? fallback;
	if (typeof value !== "boolean") {
		throw new Error(`Texture importer ${key} must be a boolean.`);
	}
	return value;
}

/** Migrates legacy texture metadata while strictly validating every executable setting. */
export function normalizeTextureImporterSettings(settings: Record<string, unknown>): ITextureImporterSettings {
	const maxSize = numberSetting(settings, "maxSize", 4096, 32, 16384, true);
	if ((maxSize & (maxSize - 1)) !== 0) {
		throw new Error("Texture importer maxSize must be a power of two from 32 through 16384.");
	}
	return {
		textureType: enumSetting(settings, "textureType", ["default", "normalMap", "sprite", "lightmap", "cursor"], "default"),
		outputFormat: enumSetting(settings, "outputFormat", ["automatic", "png", "jpeg", "webp"], "automatic"),
		colorSpace: enumSetting(settings, "colorSpace", ["sRGB", "linear"], "sRGB"),
		alphaSource: enumSetting(settings, "alphaSource", ["input", "none", "grayscale"], "input"),
		alphaIsTransparency: booleanSetting(settings, "alphaIsTransparency", false),
		nonPowerOfTwo: enumSetting(settings, "nonPowerOfTwo", ["none", "toNearest", "toLarger", "toSmaller"], "none"),
		generateMipmaps: booleanSetting(settings, "generateMipmaps", true),
		mipmapFilter: enumSetting(settings, "mipmapFilter", ["box", "kaiser"], "kaiser"),
		mipmapPreserveCoverage: booleanSetting(settings, "mipmapPreserveCoverage", false),
		mipmapAlphaTestReference: numberSetting(settings, "mipmapAlphaTestReference", 0.5, 0, 1),
		maxSize,
		resizeAlgorithm: enumSetting(settings, "resizeAlgorithm", ["nearest", "bilinear", "bicubic", "lanczos3"], "lanczos3"),
		compression: enumSetting(settings, "compression", ["none", "low", "normal", "high"], "normal"),
		readable: booleanSetting(settings, "readable", false),
		filterMode: enumSetting(settings, "filterMode", ["point", "bilinear", "trilinear"], "trilinear"),
		wrapModeU: enumSetting(settings, "wrapModeU", ["repeat", "clamp", "mirror"], "repeat"),
		wrapModeV: enumSetting(settings, "wrapModeV", ["repeat", "clamp", "mirror"], "repeat"),
		anisoLevel: numberSetting(settings, "anisoLevel", 1, 0, 16, true),
		normalMapSource: enumSetting(settings, "normalMapSource", ["color", "height"], "color"),
		normalMapStrength: numberSetting(settings, "normalMapStrength", 0.25, 0, 2),
		spritePixelsPerUnit: numberSetting(settings, "spritePixelsPerUnit", 100, 0.001, 1_000_000),
		spriteMeshType: enumSetting(settings, "spriteMeshType", ["fullRect", "tight"], "tight"),
		spriteExtrude: numberSetting(settings, "spriteExtrude", 1, 0, 32, true),
		platformOverrides: normalizeTextureImporterPlatformOverrides(settings.platformOverrides),
	};
}

/** Normal maps and lightmaps always contain linear data even when legacy metadata requested sRGB sampling. */
export function textureImporterEffectiveColorSpace(settings: ITextureImporterSettings, sourcePath?: string): TextureImporterColorSpace {
	const extension = sourcePath?.replace(/\\/g, "/").split("/").pop()?.split(".").pop()?.toLowerCase();
	return settings.textureType === "normalMap" || settings.textureType === "lightmap" || extension === "hdr" || extension === "exr" ? "linear" : settings.colorSpace;
}

/** Returns the portable build/preview extension produced for a supported LDR texture source. */
export function textureImporterOutputExtension(sourcePath: string, settings?: Pick<ITextureImporterSettings, "outputFormat">): string {
	const name = sourcePath.replace(/\\/g, "/").split("/").pop() ?? "";
	const extension = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
	if (extension === ".hdr" || extension === ".exr") {
		return extension;
	}
	if (settings?.outputFormat && settings.outputFormat !== "automatic") {
		return settings.outputFormat === "jpeg" ? ".jpg" : `.${settings.outputFormat}`;
	}
	if (extension === ".jpg" || extension === ".jpeg") {
		return ".jpg";
	}
	if (extension === ".webp") {
		return ".webp";
	}
	return ".png";
}

/** Maps Unity-style per-texture compression quality to deterministic Sharp encoding parameters. */
export function textureImporterEncodingOptions(compression: TextureImporterCompression): ITextureImporterEncodingOptions {
	switch (compression) {
		case "none":
			return { quality: 100, compressionLevel: 0, lossless: true };
		case "low":
			return { quality: 72, compressionLevel: 3, lossless: false };
		case "high":
			return { quality: 96, compressionLevel: 9, lossless: false };
		default:
			return { quality: 86, compressionLevel: 6, lossless: false };
	}
}

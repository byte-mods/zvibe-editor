import { ITextureImporterPlatformOverrides, normalizeTextureImporterPlatformOverrides, TextureImporterPlatform } from "./texture-platform-overrides";

export type TextureImporterTextureType = "default" | "normalMap" | "sprite" | "lightmap" | "cursor";
export type TextureImporterColorSpace = "sRGB" | "linear";
export type TextureImporterAlphaSource = "input" | "none";
export type TextureImporterResizeAlgorithm = "nearest" | "bilinear" | "bicubic" | "lanczos3";
export type TextureImporterCompression = "none" | "low" | "normal" | "high";

export interface ITextureImporterSettings {
	textureType: TextureImporterTextureType;
	colorSpace: TextureImporterColorSpace;
	alphaSource: TextureImporterAlphaSource;
	generateMipmaps: boolean;
	maxSize: number;
	resizeAlgorithm: TextureImporterResizeAlgorithm;
	compression: TextureImporterCompression;
	readable: boolean;
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
	version: 1;
	outputPath: string;
	textureType: TextureImporterTextureType;
	colorSpace: TextureImporterColorSpace;
	alphaSource: TextureImporterAlphaSource;
	generateMipmaps: boolean;
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

export function normalizeTextureImporterSettings(settings: Record<string, unknown>): ITextureImporterSettings {
	return {
		textureType: settings.textureType as TextureImporterTextureType,
		colorSpace: settings.colorSpace as TextureImporterColorSpace,
		alphaSource: settings.alphaSource as TextureImporterAlphaSource,
		generateMipmaps: Boolean(settings.generateMipmaps),
		maxSize: Number(settings.maxSize),
		resizeAlgorithm: settings.resizeAlgorithm as TextureImporterResizeAlgorithm,
		compression: settings.compression as TextureImporterCompression,
		readable: Boolean(settings.readable),
		platformOverrides: normalizeTextureImporterPlatformOverrides(settings.platformOverrides),
	};
}

/** Normal maps and lightmaps always contain linear data even when legacy metadata requested sRGB sampling. */
export function textureImporterEffectiveColorSpace(settings: ITextureImporterSettings, sourcePath?: string): TextureImporterColorSpace {
	const extension = sourcePath?.replace(/\\/g, "/").split("/").pop()?.split(".").pop()?.toLowerCase();
	return settings.textureType === "normalMap" || settings.textureType === "lightmap" || extension === "hdr" || extension === "exr" ? "linear" : settings.colorSpace;
}

/** Returns the portable build/preview extension produced for a supported LDR texture source. */
export function textureImporterOutputExtension(sourcePath: string): string {
	const name = sourcePath.replace(/\\/g, "/").split("/").pop() ?? "";
	const extension = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
	if (extension === ".jpg" || extension === ".jpeg") {
		return ".jpg";
	}
	if (extension === ".webp") {
		return ".webp";
	}
	if (extension === ".hdr" || extension === ".exr") {
		return extension;
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

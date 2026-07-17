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
}

export interface ITextureImportProbe {
	format: string;
	width: number;
	height: number;
	channels: number;
	hasAlpha: boolean;
	space: string;
	bytes: number;
}

export interface ITextureImportMipmap {
	path: string;
	width: number;
	height: number;
	bytes: number;
}

export interface ITextureImportResult {
	sourcePath: string;
	outputPath: string;
	settings: ITextureImporterSettings;
	effectiveColorSpace: TextureImporterColorSpace;
	converted: boolean;
	resized: boolean;
	alphaRemoved: boolean;
	source: ITextureImportProbe;
	output: ITextureImportProbe;
	mipmaps: ITextureImportMipmap[];
	readableBitmapPath: string | null;
	readableDescriptorPath: string | null;
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
	mipmaps: Array<{ path: string; width: number; height: number }>;
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
	};
}

/** Normal maps and lightmaps always contain linear data even when legacy metadata requested sRGB sampling. */
export function textureImporterEffectiveColorSpace(settings: ITextureImporterSettings): TextureImporterColorSpace {
	return settings.textureType === "normalMap" || settings.textureType === "lightmap" ? "linear" : settings.colorSpace;
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

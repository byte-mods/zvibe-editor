import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path/posix";

import fs from "fs-extra";
import sharp, { Sharp, SharpOptions } from "sharp";

import {
	ITextureImporterSettings,
	ITextureImportMipmap,
	ITextureImportProbe,
	ITextureImportResult,
	HighDynamicRangeFormat,
	IHighDynamicRangeImage,
	decodeHighDynamicRange,
	decodePsd,
	decodeTga,
	executeHighDynamicRangeTextureImport,
	resolveTextureImporterPlatformSettings,
	TextureImporterPlatform,
	toneMapHighDynamicRange,
	textureImporterEffectiveColorSpace,
	textureImporterEncodingOptions,
	textureImporterOutputExtension,
} from "babylonjs-editor-tools";

const maximumSourceBytes = 512 * 1024 * 1024;
const maximumReadableBytes = 256 * 1024 * 1024;
const maximumInputPixels = 16_384 * 16_384;
const decodedTextureImporterExtensions = new Set([".tga", ".psd", ".psb"]);
const highDynamicRangeTextureImporterExtensions = new Set([".hdr", ".exr"]);

function importerKernel(settings: ITextureImporterSettings): keyof sharp.KernelEnum {
	switch (settings.resizeAlgorithm) {
		case "nearest":
			return sharp.kernel.nearest;
		case "bilinear":
			return sharp.kernel.cubic;
		case "bicubic":
			return sharp.kernel.mitchell;
		default:
			return sharp.kernel.lanczos3;
	}
}

interface IPreparedTextureSource {
	input: string | Buffer;
	options: SharpOptions;
	probe: ITextureImportProbe | null;
	warnings: string[];
}

interface ITexturePlatformExecution {
	baseSettings: ITextureImporterSettings;
	platform: TextureImporterPlatform;
	platformOverrideApplied: boolean;
}

async function prepareTextureSource(sourcePath: string, sourceBytes: number): Promise<IPreparedTextureSource> {
	const extension = extname(sourcePath).toLowerCase();
	if (!decodedTextureImporterExtensions.has(extension)) {
		return { input: sourcePath, options: { animated: false, limitInputPixels: maximumInputPixels }, probe: null, warnings: [] };
	}
	const decoded = extension === ".psd" || extension === ".psb" ? decodePsd(await fs.readFile(sourcePath)) : decodeTga(await fs.readFile(sourcePath));
	return {
		input: Buffer.from(decoded.pixels),
		options: { raw: { width: decoded.width, height: decoded.height, channels: 4 } },
		probe: {
			format: extension.slice(1),
			width: decoded.width,
			height: decoded.height,
			channels: decoded.channels,
			hasAlpha: decoded.hasAlpha,
			space: ("colorMode" in decoded ? decoded.colorMode : decoded.kind) === "grayscale" ? "b-w" : "srgb",
			bytes: sourceBytes,
		},
		warnings:
			"compression" in decoded
				? [
						`Photoshop ${decoded.format.toUpperCase()} ${decoded.depth}-bit source imported from its merged ${decoded.compression} composite through ${decoded.channelConversionModel}${decoded.depth === 32 ? "; finite color samples clamp to [0,1] before linear-to-sRGB conversion, coverage clamps linearly, and non-finite samples reject" : ""}${decoded.layerDataPresent ? `; ${decoded.layerAndMaskBytes} bytes of layer/mask data remain separate from this merged output` : ""}. Use the editor Photoshop Sprite Layers workflow or inspect_psd_layer_extraction/extract_psd_layers to publish editable PNG assets. Embedded color-profile conversion is not applied.`,
					]
				: [],
	};
}

function buildPipeline(source: IPreparedTextureSource, settings: ITextureImporterSettings, width?: number, height?: number): Sharp {
	let pipeline = sharp(source.input, source.options).rotate();
	if (width || height) {
		pipeline = pipeline.resize({ width, height, fit: "inside", withoutEnlargement: true, kernel: importerKernel(settings) });
	}
	if (settings.alphaSource === "none") {
		pipeline = pipeline.removeAlpha();
	}
	return pipeline;
}

function encodePipeline(pipeline: Sharp, extension: string, settings: ITextureImporterSettings): Sharp {
	const encoding = textureImporterEncodingOptions(settings.compression);
	if (extension === ".jpg") {
		return pipeline.jpeg({ quality: encoding.quality, chromaSubsampling: settings.textureType === "normalMap" ? "4:4:4" : "4:2:0", mozjpeg: true });
	}
	if (extension === ".webp") {
		return pipeline.webp({ quality: encoding.quality, lossless: encoding.lossless, smartSubsample: true });
	}
	return pipeline.png({ compressionLevel: encoding.compressionLevel, adaptiveFiltering: settings.compression !== "none" });
}

async function probeTexture(path: string): Promise<ITextureImportProbe> {
	const [metadata, details] = await Promise.all([sharp(path, { animated: false, limitInputPixels: maximumInputPixels }).metadata(), fs.stat(path)]);
	if (!metadata.width || !metadata.height) {
		throw new Error(`Texture dimensions are unavailable for "${basename(path)}".`);
	}
	return {
		format: metadata.format ?? extname(path).replace(".", "").toLowerCase(),
		width: metadata.width,
		height: metadata.height,
		channels: metadata.channels ?? 0,
		hasAlpha: metadata.hasAlpha ?? metadata.channels === 4,
		space: metadata.space ?? "unknown",
		bytes: details.size,
	};
}

function mipmapDimensions(width: number, height: number): Array<{ width: number; height: number }> {
	return [2 / 3, 1 / 3]
		.map((scale) => ({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }))
		.filter(
			(value, index, values) =>
				value.width !== width && value.height !== height && values.findIndex((candidate) => candidate.width === value.width && candidate.height === value.height) === index
		);
}

async function createReadableOutput(outputPath: string): Promise<{ bitmapPath: string; descriptorPath: string }> {
	const output = await sharp(outputPath, { animated: false, limitInputPixels: maximumInputPixels }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	if (output.data.byteLength > maximumReadableBytes) {
		throw new Error(`CPU-readable texture output is ${(output.data.byteLength / 1024 / 1024).toFixed(1)} MiB; lower Max Size so RGBA8 output is at most 256 MiB.`);
	}
	const bitmapPath = `${outputPath}.rgba`;
	const descriptorPath = `${bitmapPath}.json`;
	await fs.writeFile(bitmapPath, output.data);
	await fs.writeJSON(
		descriptorPath,
		{
			version: 1,
			width: output.info.width,
			height: output.info.height,
			channels: output.info.channels,
			pixelFormat: "rgba8",
			byteLength: output.data.byteLength,
		},
		{ spaces: "\t" }
	);
	return { bitmapPath, descriptorPath };
}

function highDynamicRangeProbe(image: IHighDynamicRangeImage, bytes: number): ITextureImportProbe {
	return {
		format: image.format,
		width: image.width,
		height: image.height,
		channels: image.channels,
		hasAlpha: image.hasAlpha,
		space: "linear",
		bytes,
		pixelFormat: image.pixelType,
		minimum: image.statistics.minimum,
		maximum: image.statistics.maximum,
		average: image.statistics.average,
		nonFiniteCount: image.statistics.nonFiniteCount,
	};
}

async function writeToneMappedPreview(path: string, pixels: Float32Array, width: number, height: number): Promise<void> {
	await sharp(Buffer.from(toneMapHighDynamicRange(pixels)), { raw: { width, height, channels: 4 } })
		.png({ compressionLevel: 9, adaptiveFiltering: true })
		.toFile(path);
}

async function processHighDynamicRangeTexture(
	sourcePath: string,
	requestedOutputPath: string,
	settings: ITextureImporterSettings,
	sourceBytes: number,
	execution: ITexturePlatformExecution
): Promise<ITextureImportResult> {
	const format = extname(sourcePath).slice(1).toLowerCase() as HighDynamicRangeFormat;
	const executed = await executeHighDynamicRangeTextureImport(await fs.readFile(sourcePath), format, settings);
	const source = highDynamicRangeProbe(executed.source, sourceBytes);
	const processed = executed.output;
	const outputExtension = textureImporterOutputExtension(sourcePath);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${outputExtension}`);
	const previewPath = `${outputPath}.preview.png`;
	const environmentPath = executed.equirectangular ? (format === "hdr" ? outputPath : `${outputPath}.environment.hdr`) : null;
	const temporaryRoot = join(dirname(outputPath), `.texture-import-${randomUUID()}`);
	const effectiveColorSpace = textureImporterEffectiveColorSpace(settings, sourcePath);
	const warnings: string[] = [];
	if (settings.colorSpace !== "linear") {
		warnings.push(`${format.toUpperCase()} pixels are linear high-dynamic-range data; the authored ${settings.colorSpace} sampling setting was overridden.`);
	}
	if (executed.source.statistics.nonFiniteCount) {
		warnings.push(`${executed.source.statistics.nonFiniteCount} non-finite source channel value(s) are reported as evidence and encoded as zero in portable output.`);
	}
	if (format === "exr" && settings.compression !== "none") {
		warnings.push("Portable OpenEXR output uses deterministic uncompressed FLOAT scanlines; the generic texture compression preference is not applied to HDR precision data.");
	}
	await fs.ensureDir(temporaryRoot);
	try {
		await fs.writeFile(join(temporaryRoot, basename(outputPath)), executed.outputBytes);
		if (environmentPath && environmentPath !== outputPath && executed.environmentBytes) {
			await fs.writeFile(join(temporaryRoot, basename(environmentPath)), executed.environmentBytes);
		}
		await writeToneMappedPreview(join(temporaryRoot, basename(previewPath)), processed.pixels, processed.width, processed.height);
		const mipmaps: ITextureImportMipmap[] = [];
		for (const mipmap of executed.mipmaps) {
			const name = `${basename(outputPath, outputExtension)}_${mipmap.image.width}_${mipmap.image.height}${outputExtension}`;
			const temporaryPath = join(temporaryRoot, name);
			await fs.writeFile(temporaryPath, mipmap.bytes);
			mipmaps.push({ path: join(dirname(outputPath), name), width: mipmap.image.width, height: mipmap.image.height, bytes: (await fs.stat(temporaryPath)).size });
		}
		const cubeFaces = executed.equirectangular
			? await Promise.all(
					executed.cubeFaces.map(async (face) => {
						const path = `${outputPath}.cube-${face.face}.png`;
						await writeToneMappedPreview(join(temporaryRoot, basename(path)), face.pixels, face.width, face.height);
						return { face: face.face, path, width: face.width, height: face.height };
					})
				)
			: [];
		let readableBitmapPath: string | null = null;
		let readableDescriptorPath: string | null = null;
		if (settings.readable) {
			const byteLength = processed.pixels.byteLength;
			if (byteLength > maximumReadableBytes) {
				throw new Error(`CPU-readable HDR output is ${(byteLength / 1024 / 1024).toFixed(1)} MiB; lower Max Size so RGBA32F output is at most 256 MiB.`);
			}
			readableBitmapPath = `${outputPath}.rgba32f`;
			readableDescriptorPath = `${readableBitmapPath}.json`;
			await fs.writeFile(join(temporaryRoot, basename(readableBitmapPath)), Buffer.from(processed.pixels.buffer, processed.pixels.byteOffset, processed.pixels.byteLength));
			await fs.writeJSON(
				join(temporaryRoot, basename(readableDescriptorPath)),
				{ version: 1, width: processed.width, height: processed.height, channels: 4, pixelFormat: "rgba32f", colorSpace: "linear", byteOrder: "little-endian", byteLength },
				{ spaces: "\t" }
			);
		}
		await fs.ensureDir(dirname(outputPath));
		const generatedPaths = [outputPath, previewPath, ...mipmaps.map((mipmap) => mipmap.path), ...cubeFaces.map((face) => face.path)];
		if (environmentPath && environmentPath !== outputPath) {
			generatedPaths.push(environmentPath);
		}
		if (readableBitmapPath && readableDescriptorPath) {
			generatedPaths.push(readableBitmapPath, readableDescriptorPath);
		}
		for (const generatedPath of generatedPaths) {
			await fs.move(join(temporaryRoot, basename(generatedPath)), generatedPath, { overwrite: true });
		}
		const outputBytes = await fs.readFile(outputPath);
		const decodedOutput = await decodeHighDynamicRange(outputBytes, format);
		return {
			sourcePath,
			outputPath,
			settings,
			baseSettings: execution.baseSettings,
			platform: execution.platform,
			platformOverrideApplied: execution.platformOverrideApplied,
			effectiveColorSpace,
			converted: true,
			resized: executed.resized,
			alphaRemoved: executed.alphaRemoved,
			source,
			output: highDynamicRangeProbe(decodedOutput, outputBytes.byteLength),
			mipmaps,
			readableBitmapPath,
			readableDescriptorPath,
			readablePixelFormat: readableBitmapPath ? "rgba32f" : null,
			previewPath,
			highDynamicRange: {
				linear: true,
				compression: decodedOutput.compression,
				pixelFormat: decodedOutput.pixelType,
				toneMapper: "aces",
				exposure: 0,
				equirectangular: executed.equirectangular,
				cubeFaceSize: executed.cubeFaceSize,
				cubeFaces,
				environmentPath,
			},
			warnings,
		};
	} finally {
		await fs.remove(temporaryRoot).catch(() => undefined);
	}
}

/** Executes every persisted LDR Texture Importer setting during a CLI build. */
export async function processImportedTexture(
	sourcePath: string,
	requestedOutputPath: string,
	baseSettings: ITextureImporterSettings,
	requestedPlatform: unknown = "default"
): Promise<ITextureImportResult> {
	const resolved = resolveTextureImporterPlatformSettings(baseSettings, requestedPlatform);
	const settings = resolved.settings;
	const sourceDetails = await fs.stat(sourcePath);
	if (sourceDetails.size > maximumSourceBytes) {
		throw new Error("Texture source exceeds the 512 MiB importer limit.");
	}
	if (highDynamicRangeTextureImporterExtensions.has(extname(sourcePath).toLowerCase())) {
		return processHighDynamicRangeTexture(sourcePath, requestedOutputPath, settings, sourceDetails.size, {
			baseSettings,
			platform: resolved.platform,
			platformOverrideApplied: resolved.overrideApplied,
		});
	}
	const preparedSource = await prepareTextureSource(sourcePath, sourceDetails.size);
	const source = preparedSource.probe ?? (await probeTexture(sourcePath));
	const outputExtension = textureImporterOutputExtension(sourcePath);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${outputExtension}`);
	const temporaryRoot = join(dirname(outputPath), `.texture-import-${randomUUID()}`);
	const temporaryOutput = join(temporaryRoot, basename(outputPath));
	const resized = source.width > settings.maxSize || source.height > settings.maxSize;
	const warnings: string[] = [...preparedSource.warnings];
	const effectiveColorSpace = textureImporterEffectiveColorSpace(settings, sourcePath);
	if (effectiveColorSpace !== settings.colorSpace) {
		warnings.push(`${settings.textureType} textures are sampled as linear data; the authored ${settings.colorSpace} setting was overridden.`);
	}
	await fs.ensureDir(temporaryRoot);
	try {
		await encodePipeline(
			buildPipeline(preparedSource, settings, resized ? settings.maxSize : undefined, resized ? settings.maxSize : undefined),
			outputExtension,
			settings
		).toFile(temporaryOutput);
		const temporaryProbe = await probeTexture(temporaryOutput);
		const mipmaps: ITextureImportMipmap[] = [];
		if (settings.generateMipmaps) {
			for (const size of mipmapDimensions(temporaryProbe.width, temporaryProbe.height)) {
				const name = `${basename(outputPath, outputExtension)}_${size.width}_${size.height}${outputExtension}`;
				const temporaryPath = join(temporaryRoot, name);
				await encodePipeline(
					buildPipeline(
						{ input: temporaryOutput, options: { animated: false, limitInputPixels: maximumInputPixels }, probe: null, warnings: [] },
						settings,
						size.width,
						size.height
					),
					outputExtension,
					settings
				).toFile(temporaryPath);
				mipmaps.push({ path: join(dirname(outputPath), name), width: size.width, height: size.height, bytes: (await fs.stat(temporaryPath)).size });
			}
		}
		let readableBitmapPath: string | null = null;
		let readableDescriptorPath: string | null = null;
		if (settings.readable) {
			const readable = await createReadableOutput(temporaryOutput);
			readableBitmapPath = `${outputPath}.rgba`;
			readableDescriptorPath = `${readableBitmapPath}.json`;
			if (readable.bitmapPath !== join(temporaryRoot, basename(readableBitmapPath)) || readable.descriptorPath !== join(temporaryRoot, basename(readableDescriptorPath))) {
				throw new Error("Texture readable-output staging paths are inconsistent.");
			}
		}
		await fs.ensureDir(dirname(outputPath));
		await fs.move(temporaryOutput, outputPath, { overwrite: true });
		for (const mipmap of mipmaps) {
			await fs.move(join(temporaryRoot, basename(mipmap.path)), mipmap.path, { overwrite: true });
		}
		if (readableBitmapPath && readableDescriptorPath) {
			await fs.move(join(temporaryRoot, basename(readableBitmapPath)), readableBitmapPath, { overwrite: true });
			await fs.move(join(temporaryRoot, basename(readableDescriptorPath)), readableDescriptorPath, { overwrite: true });
		} else {
			await fs.remove(`${outputPath}.rgba`);
			await fs.remove(`${outputPath}.rgba.json`);
		}
		const output = await probeTexture(outputPath);
		return {
			sourcePath,
			outputPath,
			settings,
			baseSettings,
			platform: resolved.platform,
			platformOverrideApplied: resolved.overrideApplied,
			effectiveColorSpace,
			converted: extname(sourcePath).toLowerCase() !== outputExtension || resized || settings.alphaSource === "none" || settings.compression !== "none",
			resized,
			alphaRemoved: source.hasAlpha && settings.alphaSource === "none",
			source,
			output,
			mipmaps,
			readableBitmapPath,
			readableDescriptorPath,
			readablePixelFormat: readableBitmapPath ? "rgba8" : null,
			warnings,
		};
	} finally {
		await fs.remove(temporaryRoot).catch(() => undefined);
	}
}

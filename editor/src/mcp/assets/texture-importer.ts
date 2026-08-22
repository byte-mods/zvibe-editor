import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";

import { ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";
import sharp, { Sharp, SharpOptions } from "sharp";

import {
	ITextureImporterSettings,
	ITextureImporterPixelTransformResult,
	ITextureImportMipmap,
	ITextureImportProbe,
	ITextureImportResult,
	IHighDynamicRangeImage,
	HighDynamicRangeFormat,
	decodeHighDynamicRange,
	decodePsd,
	decodeTga,
	executeHighDynamicRangeTextureImport,
	normalizeTextureImporterSettings,
	preserveTextureImporterAlphaCoverage,
	resolveTextureImporterPlatformSettings,
	TextureImporterPlatform,
	toneMapHighDynamicRange,
	textureImporterEffectiveColorSpace,
	textureImporterEncodingOptions,
	textureImporterAlphaCoverage,
	textureImporterMipmapDimensions,
	textureImporterOutputDimensions,
	textureImporterOutputExtension,
	textureImporterSpriteMetadata,
	transformTextureImporterPixels,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { readAssetMetadata } from "./registry";

const supportedTextureImporterExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff", ".tga", ".psd", ".psb", ".svg", ".hdr", ".exr"]);
const decodedTextureImporterExtensions = new Set([".tga", ".psd", ".psb"]);
const highDynamicRangeTextureImporterExtensions = new Set([".hdr", ".exr"]);
const maximumSourceBytes = 512 * 1024 * 1024;
const maximumReadableBytes = 256 * 1024 * 1024;
const maximumInputPixels = 16_384 * 16_384;

export interface ITextureImporterArtifactStatus {
	path: string;
	artifactPath: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: ITextureImportResult | null;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function assertSupportedTexture(path: string): void {
	const extension = extname(path).toLowerCase();
	if (!supportedTextureImporterExtensions.has(extension)) {
		throw new Error(
			`Executed Texture Importer artifacts currently support PNG, JPEG, BMP, WebP, GIF, TIFF, TGA, PSD, SVG, Radiance HDR, and OpenEXR sources; ${extension || "extensionless"} textures remain passthrough assets.`
		);
	}
}

/** Returns whether Babylon/browser loading must use the portable imported artifact instead of the authored source bytes. */
export function requiresDecodedTextureImporterArtifact(path: string): boolean {
	const extension = extname(path).toLowerCase();
	return decodedTextureImporterExtensions.has(extension) || highDynamicRangeTextureImporterExtensions.has(extension);
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

async function textureImporterFingerprint(path: string, settings: ITextureImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

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

/** Maps the independent mip filter to stable Sharp kernels shared by editor and CLI execution. */
function mipmapKernel(settings: ITextureImporterSettings): keyof sharp.KernelEnum {
	return settings.mipmapFilter === "box" ? sharp.kernel.cubic : sharp.kernel.lanczos3;
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
	const decoded = extension === ".psd" || extension === ".psb" ? decodePsd(await readFile(sourcePath)) : decodeTga(await readFile(sourcePath));
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
						`Photoshop ${decoded.format.toUpperCase()} ${decoded.depth}-bit source imported from its merged ${decoded.compression} composite through ${decoded.channelConversionModel}${decoded.depth === 32 ? "; finite color samples clamp to [0,1] before linear-to-sRGB conversion, coverage clamps linearly, and non-finite samples reject" : ""}${decoded.layerDataPresent ? `; ${decoded.layerAndMaskBytes} bytes of layer/mask data remain separate from this merged output` : ""}. Use Photoshop Sprite Layers or inspect_psd_layer_extraction/extract_psd_layers to publish editable PNG assets. Embedded color-profile conversion is not applied.`,
					]
				: [],
	};
}

/** Applies orientation and exact dimensions while leaving color/alpha semantics to the shared RGBA8 policy. */
function buildPipeline(source: IPreparedTextureSource, settings: ITextureImporterSettings, width?: number, height?: number, mipmap = false): Sharp {
	let pipeline = sharp(source.input, source.options).rotate();
	if (width && height) {
		pipeline = pipeline.resize({ width, height, fit: "fill", withoutEnlargement: false, kernel: mipmap ? mipmapKernel(settings) : importerKernel(settings) });
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
	const [metadata, details] = await Promise.all([sharp(path, { animated: false, limitInputPixels: maximumInputPixels }).metadata(), stat(path)]);
	if (!metadata.width || !metadata.height) {
		throw new Error(`Texture dimensions are unavailable for "${basename(path)}".`);
	}
	return {
		format: metadata.format ?? extname(path).replace(".", "").toLowerCase(),
		width: metadata.autoOrient?.width ?? metadata.width,
		height: metadata.autoOrient?.height ?? metadata.height,
		channels: metadata.channels ?? 0,
		hasAlpha: metadata.hasAlpha ?? metadata.channels === 4,
		space: metadata.space ?? "unknown",
		bytes: details.size,
	};
}

interface IPreparedLdrTexture {
	pipeline: Sharp;
	pixels: Uint8Array | null;
	transform: Omit<ITextureImporterPixelTransformResult, "pixels">;
}

/** Materializes RGBA8 only when authored semantics or sprite/coverage evidence actually require bounded pixel access. */
async function prepareLdrTexture(source: IPreparedTextureSource, settings: ITextureImporterSettings, width: number, height: number): Promise<IPreparedLdrTexture> {
	const pipeline = buildPipeline(source, settings, width, height);
	const needsPixels =
		settings.alphaSource === "grayscale" ||
		settings.alphaIsTransparency ||
		(settings.textureType === "normalMap" && settings.normalMapSource === "height") ||
		settings.textureType === "sprite" ||
		settings.mipmapPreserveCoverage;
	if (!needsPixels) {
		return {
			pipeline: settings.alphaSource === "none" ? pipeline.removeAlpha() : pipeline,
			pixels: null,
			transform: {
				alphaDerivedFromGrayscale: false,
				alphaRemoved: settings.alphaSource === "none",
				transparentColorsDilated: false,
				normalMapGenerated: false,
			},
		};
	}
	const decoded = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const transformed = transformTextureImporterPixels(decoded.data, decoded.info.width, decoded.info.height, settings);
	let transformedPipeline = sharp(Buffer.from(transformed.pixels), { raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 } });
	if (settings.alphaSource === "none") {
		transformedPipeline = transformedPipeline.removeAlpha();
	}
	const { pixels, ...transform } = transformed;
	return { pipeline: transformedPipeline, pixels, transform };
}

async function createReadableOutput(outputPath: string): Promise<{ bitmapPath: string; descriptorPath: string }> {
	const output = await sharp(outputPath, { animated: false, limitInputPixels: maximumInputPixels }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	if (output.data.byteLength > maximumReadableBytes) {
		throw new Error(`CPU-readable texture output is ${(output.data.byteLength / 1024 / 1024).toFixed(1)} MiB; lower Max Size so RGBA8 output is at most 256 MiB.`);
	}
	const bitmapPath = `${outputPath}.rgba`;
	const descriptorPath = `${bitmapPath}.json`;
	await writeFile(bitmapPath, output.data);
	await writeJSON(
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

async function processHighDynamicRangeTextureImporterOutput(
	sourcePath: string,
	requestedOutputPath: string,
	settings: ITextureImporterSettings,
	sourceBytes: number,
	execution: ITexturePlatformExecution
): Promise<ITextureImportResult> {
	const format = extname(sourcePath).slice(1).toLowerCase() as HighDynamicRangeFormat;
	const executed = await executeHighDynamicRangeTextureImport(await readFile(sourcePath), format, settings);
	const source = highDynamicRangeProbe(executed.source, sourceBytes);
	const processed = executed.output;
	const outputExtension = textureImporterOutputExtension(sourcePath, settings);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${outputExtension}`);
	const previewPath = `${outputPath}.preview.png`;
	const environmentPath = executed.equirectangular ? (format === "hdr" ? outputPath : `${outputPath}.environment.hdr`) : null;
	const temporaryRoot = join(dirname(outputPath), `.texture-import-${randomUUID()}`);
	const temporaryOutput = join(temporaryRoot, basename(outputPath));
	const temporaryPreview = join(temporaryRoot, basename(previewPath));
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
	if (settings.outputFormat !== "automatic") {
		warnings.push(format.toUpperCase() + " precision output remains format-preserving; the LDR " + settings.outputFormat + " output override is not applied.");
	}
	await ensureDir(temporaryRoot);
	try {
		await writeFile(temporaryOutput, executed.outputBytes);
		if (environmentPath && environmentPath !== outputPath && executed.environmentBytes) {
			await writeFile(join(temporaryRoot, basename(environmentPath)), executed.environmentBytes);
		}
		await writeToneMappedPreview(temporaryPreview, processed.pixels, processed.width, processed.height);
		const mipmaps: ITextureImportMipmap[] = [];
		if (settings.generateMipmaps) {
			for (const mipmap of executed.mipmaps) {
				const name = `${basename(outputPath, outputExtension)}_${mipmap.image.width}_${mipmap.image.height}${outputExtension}`;
				const temporaryPath = join(temporaryRoot, name);
				await writeFile(temporaryPath, mipmap.bytes);
				mipmaps.push({
					path: join(dirname(outputPath), name),
					width: mipmap.image.width,
					height: mipmap.image.height,
					bytes: (await stat(temporaryPath)).size,
					...(mipmap.alphaCoverageBefore !== undefined
						? {
								alphaCoverageBefore: mipmap.alphaCoverageBefore,
								alphaCoverageAfter: mipmap.alphaCoverageAfter,
								alphaCoverageScale: mipmap.alphaCoverageScale,
							}
						: {}),
				});
			}
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
			await writeFile(join(temporaryRoot, basename(readableBitmapPath)), Buffer.from(processed.pixels.buffer, processed.pixels.byteOffset, processed.pixels.byteLength));
			await writeJSON(
				join(temporaryRoot, basename(readableDescriptorPath)),
				{ version: 1, width: processed.width, height: processed.height, channels: 4, pixelFormat: "rgba32f", colorSpace: "linear", byteOrder: "little-endian", byteLength },
				{ spaces: "\t" }
			);
		}
		await ensureDir(dirname(outputPath));
		const generatedPaths = [outputPath, previewPath, ...mipmaps.map((mipmap) => mipmap.path), ...cubeFaces.map((face) => face.path)];
		if (environmentPath && environmentPath !== outputPath) {
			generatedPaths.push(environmentPath);
		}
		if (readableBitmapPath && readableDescriptorPath) {
			generatedPaths.push(readableBitmapPath, readableDescriptorPath);
		}
		for (const generatedPath of generatedPaths) {
			await move(join(temporaryRoot, basename(generatedPath)), generatedPath, { overwrite: true });
		}
		const outputBytes = await readFile(outputPath);
		const decodedOutput = await decodeHighDynamicRange(outputBytes, format);
		const maxSizeDimensions = textureImporterOutputDimensions(source.width, source.height, { ...settings, nonPowerOfTwo: "none" });
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
			processing: {
				outputFormat: format,
				maxSizeApplied: maxSizeDimensions.width !== source.width || maxSizeDimensions.height !== source.height,
				nonPowerOfTwoApplied: decodedOutput.width !== maxSizeDimensions.width || decodedOutput.height !== maxSizeDimensions.height,
				fullMipChain: !settings.generateMipmaps || executed.mipmaps.length === textureImporterMipmapDimensions(decodedOutput.width, decodedOutput.height).length,
				alphaDerivedFromGrayscale: settings.alphaSource === "grayscale",
				transparentColorsDilated: executed.transparentColorsDilated,
				normalMapGenerated: executed.normalMapGenerated,
				mipmapCoveragePreserved: settings.mipmapPreserveCoverage && settings.alphaSource !== "none" && executed.mipmaps.length > 0,
			},
			sprite: textureImporterSpriteMetadata(decodedOutput.pixels, decodedOutput.width, decodedOutput.height, settings),
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
		await remove(temporaryRoot).catch(() => undefined);
	}
}

/** Executes every currently persisted LDR Texture Importer setting into a deterministic output and companion artifacts. */
export async function processTextureImporterOutput(
	sourcePath: string,
	requestedOutputPath: string,
	baseSettings: ITextureImporterSettings,
	requestedPlatform: unknown = "default"
): Promise<ITextureImportResult> {
	assertSupportedTexture(sourcePath);
	const resolved = resolveTextureImporterPlatformSettings(baseSettings, requestedPlatform);
	const settings = resolved.settings;
	const sourceDetails = await stat(sourcePath);
	if (sourceDetails.size > maximumSourceBytes) {
		throw new Error("Texture source exceeds the 512 MiB importer limit.");
	}
	if (highDynamicRangeTextureImporterExtensions.has(extname(sourcePath).toLowerCase())) {
		return processHighDynamicRangeTextureImporterOutput(sourcePath, requestedOutputPath, settings, sourceDetails.size, {
			baseSettings,
			platform: resolved.platform,
			platformOverrideApplied: resolved.overrideApplied,
		});
	}
	const preparedSource = await prepareTextureSource(sourcePath, sourceDetails.size);
	const source = preparedSource.probe ?? (await probeTexture(sourcePath));
	const outputExtension = textureImporterOutputExtension(sourcePath, settings);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${outputExtension}`);
	const temporaryRoot = join(dirname(outputPath), `.texture-import-${randomUUID()}`);
	const temporaryOutput = join(temporaryRoot, basename(outputPath));
	const maxSizeDimensions = textureImporterOutputDimensions(source.width, source.height, { ...settings, nonPowerOfTwo: "none" });
	const outputDimensions = textureImporterOutputDimensions(source.width, source.height, settings);
	const resized = outputDimensions.width !== source.width || outputDimensions.height !== source.height;
	const warnings: string[] = [...preparedSource.warnings];
	const effectiveColorSpace = textureImporterEffectiveColorSpace(settings, sourcePath);
	if (effectiveColorSpace !== settings.colorSpace) {
		warnings.push(`${settings.textureType} textures are sampled as linear data; the authored ${settings.colorSpace} setting was overridden.`);
	}
	if (outputExtension === ".jpg" && source.hasAlpha && settings.alphaSource !== "none") {
		warnings.push("JPEG output cannot retain alpha; transparent pixels are flattened by the encoder.");
	}
	await ensureDir(temporaryRoot);
	try {
		const prepared = await prepareLdrTexture(preparedSource, settings, outputDimensions.width, outputDimensions.height);
		await encodePipeline(prepared.pipeline, outputExtension, settings).toFile(temporaryOutput);
		const temporaryProbe = await probeTexture(temporaryOutput);
		const baseCoverage =
			settings.mipmapPreserveCoverage && settings.alphaSource !== "none" && outputExtension !== ".jpg" && prepared.pixels
				? textureImporterAlphaCoverage(prepared.pixels, settings.mipmapAlphaTestReference)
				: 0;
		const mipmaps: ITextureImportMipmap[] = [];
		if (settings.generateMipmaps) {
			for (const size of textureImporterMipmapDimensions(temporaryProbe.width, temporaryProbe.height)) {
				const name = `${basename(outputPath, outputExtension)}_${size.width}_${size.height}${outputExtension}`;
				const temporaryPath = join(temporaryRoot, name);
				let mipPipeline = buildPipeline(
					{ input: temporaryOutput, options: { animated: false, limitInputPixels: maximumInputPixels }, probe: null, warnings: [] },
					settings,
					size.width,
					size.height,
					true
				);
				let coverage: ReturnType<typeof preserveTextureImporterAlphaCoverage> | null = null;
				if (settings.mipmapPreserveCoverage && settings.alphaSource !== "none" && outputExtension !== ".jpg") {
					const decodedMip = await mipPipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
					coverage = preserveTextureImporterAlphaCoverage(decodedMip.data, baseCoverage, settings.mipmapAlphaTestReference);
					mipPipeline = sharp(decodedMip.data, { raw: { width: decodedMip.info.width, height: decodedMip.info.height, channels: 4 } });
				}
				await encodePipeline(mipPipeline, outputExtension, settings).toFile(temporaryPath);
				mipmaps.push({
					path: join(dirname(outputPath), name),
					width: size.width,
					height: size.height,
					bytes: (await stat(temporaryPath)).size,
					...(coverage ? { alphaCoverageBefore: coverage.before, alphaCoverageAfter: coverage.after, alphaCoverageScale: coverage.scale } : {}),
				});
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
		await ensureDir(dirname(outputPath));
		await move(temporaryOutput, outputPath, { overwrite: true });
		for (const mipmap of mipmaps) {
			await move(join(temporaryRoot, basename(mipmap.path)), mipmap.path, { overwrite: true });
		}
		if (readableBitmapPath && readableDescriptorPath) {
			await move(join(temporaryRoot, basename(readableBitmapPath)), readableBitmapPath, { overwrite: true });
			await move(join(temporaryRoot, basename(readableDescriptorPath)), readableDescriptorPath, { overwrite: true });
		} else {
			await remove(`${outputPath}.rgba`);
			await remove(`${outputPath}.rgba.json`);
		}
		const output = await probeTexture(outputPath);
		const sprite = prepared.pixels ? textureImporterSpriteMetadata(prepared.pixels, output.width, output.height, settings) : null;
		return {
			sourcePath,
			outputPath,
			settings,
			baseSettings,
			platform: resolved.platform,
			platformOverrideApplied: resolved.overrideApplied,
			effectiveColorSpace,
			converted:
				extname(sourcePath).toLowerCase() !== outputExtension ||
				resized ||
				settings.alphaSource !== "input" ||
				settings.alphaIsTransparency ||
				prepared.transform.normalMapGenerated ||
				settings.compression !== "none",
			resized,
			alphaRemoved: source.hasAlpha && (settings.alphaSource === "none" || outputExtension === ".jpg"),
			processing: {
				outputFormat: outputExtension.slice(1),
				maxSizeApplied: maxSizeDimensions.width !== source.width || maxSizeDimensions.height !== source.height,
				nonPowerOfTwoApplied: outputDimensions.width !== maxSizeDimensions.width || outputDimensions.height !== maxSizeDimensions.height,
				fullMipChain: !settings.generateMipmaps || mipmaps.length === textureImporterMipmapDimensions(output.width, output.height).length,
				alphaDerivedFromGrayscale: prepared.transform.alphaDerivedFromGrayscale,
				transparentColorsDilated: prepared.transform.transparentColorsDilated,
				normalMapGenerated: prepared.transform.normalMapGenerated,
				mipmapCoveragePreserved: mipmaps.some((mipmap) => mipmap.alphaCoverageBefore !== undefined),
			},
			sprite,
			source,
			output,
			mipmaps,
			readableBitmapPath,
			readableDescriptorPath,
			readablePixelFormat: readableBitmapPath ? "rgba8" : null,
			warnings,
		};
	} finally {
		await remove(temporaryRoot).catch(() => undefined);
	}
}

/** Keeps the project-local artifact filename aligned with an explicitly authored portable output format. */
async function artifactPaths(path: string, settings: ITextureImporterSettings): Promise<{ artifactPath: string; manifestPath: string; directory: string }> {
	const metadata = await readAssetMetadata(path);
	const directory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return {
		artifactPath: join(directory, `${basename(path, extname(path))}${textureImporterOutputExtension(path, settings)}`),
		manifestPath: join(directory, "texture-import.json"),
		directory,
	};
}

/** Inspects whether the deterministic imported texture artifact matches the source and effective settings. */
export async function getTextureImporterArtifactStatus(path: string): Promise<ITextureImporterArtifactStatus> {
	assertSupportedTexture(path);
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "texture") {
		throw new Error("Texture importer artifacts are only available for texture assets.");
	}
	const settings = normalizeTextureImporterSettings(metadata.importer.settings);
	const fingerprint = await textureImporterFingerprint(path, settings);
	const { artifactPath, manifestPath } = await artifactPaths(path, settings);
	let result: ITextureImportResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result as ITextureImportResult;
		}
	} catch {
		// A missing or malformed manifest makes the artifact stale.
	}
	const requiredPaths = [
		artifactPath,
		...(result?.mipmaps.map((mipmap) => mipmap.path) ?? []),
		...(result?.readableBitmapPath ? [result.readableBitmapPath] : []),
		...(result?.readableDescriptorPath ? [result.readableDescriptorPath] : []),
		...(result?.previewPath ? [result.previewPath] : []),
		...(result?.highDynamicRange?.cubeFaces.map((face) => face.path) ?? []),
		...(result?.highDynamicRange?.environmentPath ? [result.highDynamicRange.environmentPath] : []),
	];
	const exists = await pathExists(artifactPath);
	const complete = exists && (await Promise.all(requiredPaths.map((requiredPath) => pathExists(requiredPath)))).every(Boolean);
	return { path, artifactPath, manifestPath, fingerprint, current: complete && result !== null, exists, result: complete ? result : null };
}

/** Applies one exact-fingerprint Texture Importer and atomically replaces its project-local preview artifact directory. */
export async function applyTextureImporterArtifact(path: string, expectedFingerprint: string): Promise<ITextureImporterArtifactStatus> {
	return applyImporterArtifactWithAccelerator({
		kind: "texture",
		sourcePath: path,
		expectedFingerprint,
		inspect: () => getTextureImporterArtifactStatus(path),
		applyLocal: () => applyTextureImporterArtifactLocally(path, expectedFingerprint),
	});
}

async function applyTextureImporterArtifactLocally(path: string, expectedFingerprint: string): Promise<ITextureImporterArtifactStatus> {
	const status = await getTextureImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Texture importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeTextureImporterSettings(metadata.importer.settings);
	const paths = await artifactPaths(path, settings);
	const stagingDirectory = `${paths.directory}.${randomUUID()}.tmp`;
	const stagingArtifact = join(stagingDirectory, basename(paths.artifactPath));
	try {
		await ensureDir(stagingDirectory);
		const result = await processTextureImporterOutput(path, stagingArtifact, settings);
		const rebasedResult: ITextureImportResult = {
			...result,
			outputPath: paths.artifactPath,
			mipmaps: result.mipmaps.map((mipmap) => ({ ...mipmap, path: join(paths.directory, basename(mipmap.path)) })),
			readableBitmapPath: result.readableBitmapPath ? join(paths.directory, basename(result.readableBitmapPath)) : null,
			readableDescriptorPath: result.readableDescriptorPath ? join(paths.directory, basename(result.readableDescriptorPath)) : null,
			previewPath: result.previewPath ? join(paths.directory, basename(result.previewPath)) : null,
			highDynamicRange: result.highDynamicRange
				? {
						...result.highDynamicRange,
						cubeFaces: result.highDynamicRange.cubeFaces.map((face) => ({ ...face, path: join(paths.directory, basename(face.path)) })),
						environmentPath: result.highDynamicRange.environmentPath ? join(paths.directory, basename(result.highDynamicRange.environmentPath)) : null,
					}
				: null,
		};
		await writeJSON(
			join(stagingDirectory, "texture-import.json"),
			{ version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result: rebasedResult },
			{ spaces: "\t" }
		);
		const backupDirectory = `${paths.directory}.${randomUUID()}.backup`;
		if (await pathExists(paths.directory)) {
			await move(paths.directory, backupDirectory, { overwrite: true });
		}
		try {
			await move(stagingDirectory, paths.directory, { overwrite: true });
			await remove(backupDirectory);
		} catch (error) {
			await remove(paths.directory);
			if (await pathExists(backupDirectory)) {
				await move(backupDirectory, paths.directory, { overwrite: true });
			}
			throw error;
		}
		return { ...status, current: true, exists: true, result: rebasedResult };
	} catch (error) {
		await remove(stagingDirectory).catch(() => undefined);
		throw error;
	}
}

/** Returns the current imported preview, publishing it first when an internal editor action needs decoded pixels. */
export async function getOrApplyTextureImporterArtifact(path: string): Promise<ITextureImporterArtifactStatus> {
	const status = await getTextureImporterArtifactStatus(path);
	const applied = status.current ? status : await applyTextureImporterArtifact(path, status.fingerprint);
	if (!applied.result) {
		throw new Error("The Texture Importer did not publish a usable preview artifact.");
	}
	return applied;
}

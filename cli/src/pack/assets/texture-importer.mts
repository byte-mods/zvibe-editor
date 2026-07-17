import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path/posix";

import fs from "fs-extra";
import sharp, { Sharp } from "sharp";

import {
	ITextureImporterSettings,
	ITextureImportMipmap,
	ITextureImportProbe,
	ITextureImportResult,
	textureImporterEffectiveColorSpace,
	textureImporterEncodingOptions,
	textureImporterOutputExtension,
} from "babylonjs-editor-tools";

const maximumSourceBytes = 512 * 1024 * 1024;
const maximumReadableBytes = 256 * 1024 * 1024;
const maximumInputPixels = 16_384 * 16_384;

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

function buildPipeline(sourcePath: string, settings: ITextureImporterSettings, width?: number, height?: number): Sharp {
	let pipeline = sharp(sourcePath, { animated: false, limitInputPixels: maximumInputPixels }).rotate();
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

/** Executes every persisted LDR Texture Importer setting during a CLI build. */
export async function processImportedTexture(sourcePath: string, requestedOutputPath: string, settings: ITextureImporterSettings): Promise<ITextureImportResult> {
	const sourceDetails = await fs.stat(sourcePath);
	if (sourceDetails.size > maximumSourceBytes) {
		throw new Error("Texture source exceeds the 512 MiB importer limit.");
	}
	const source = await probeTexture(sourcePath);
	const outputExtension = textureImporterOutputExtension(sourcePath);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${outputExtension}`);
	const temporaryRoot = join(dirname(outputPath), `.texture-import-${randomUUID()}`);
	const temporaryOutput = join(temporaryRoot, basename(outputPath));
	const resized = source.width > settings.maxSize || source.height > settings.maxSize;
	const warnings: string[] = [];
	const effectiveColorSpace = textureImporterEffectiveColorSpace(settings);
	if (effectiveColorSpace !== settings.colorSpace) {
		warnings.push(`${settings.textureType} textures are sampled as linear data; the authored ${settings.colorSpace} setting was overridden.`);
	}
	await fs.ensureDir(temporaryRoot);
	try {
		await encodePipeline(buildPipeline(sourcePath, settings, resized ? settings.maxSize : undefined, resized ? settings.maxSize : undefined), outputExtension, settings).toFile(
			temporaryOutput
		);
		const temporaryProbe = await probeTexture(temporaryOutput);
		const mipmaps: ITextureImportMipmap[] = [];
		if (settings.generateMipmaps) {
			for (const size of mipmapDimensions(temporaryProbe.width, temporaryProbe.height)) {
				const name = `${basename(outputPath, outputExtension)}_${size.width}_${size.height}${outputExtension}`;
				const temporaryPath = join(temporaryRoot, name);
				await encodePipeline(buildPipeline(temporaryOutput, settings, size.width, size.height), outputExtension, settings).toFile(temporaryPath);
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
			effectiveColorSpace,
			converted: extname(sourcePath).toLowerCase() !== outputExtension || resized || settings.alphaSource === "none" || settings.compression !== "none",
			resized,
			alphaRemoved: source.hasAlpha && settings.alphaSource === "none",
			source,
			output,
			mipmaps,
			readableBitmapPath,
			readableDescriptorPath,
			warnings,
		};
	} finally {
		await fs.remove(temporaryRoot).catch(() => undefined);
	}
}

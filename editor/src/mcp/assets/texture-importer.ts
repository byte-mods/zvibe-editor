import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";

import { ensureDir, move, pathExists, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";
import sharp, { Sharp } from "sharp";

import {
	ITextureImporterSettings,
	ITextureImportMipmap,
	ITextureImportProbe,
	ITextureImportResult,
	normalizeTextureImporterSettings,
	textureImporterEffectiveColorSpace,
	textureImporterEncodingOptions,
	textureImporterOutputExtension,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { readAssetMetadata } from "./registry";

const supportedTextureImporterExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff", ".svg"]);
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
			`Executed Texture Importer artifacts currently support PNG, JPEG, BMP, WebP, GIF, TIFF, and SVG sources; ${extension || "extensionless"} textures remain passthrough assets.`
		);
	}
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
	const [metadata, details] = await Promise.all([sharp(path, { animated: false, limitInputPixels: maximumInputPixels }).metadata(), stat(path)]);
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

/** Executes every currently persisted LDR Texture Importer setting into a deterministic output and companion artifacts. */
export async function processTextureImporterOutput(sourcePath: string, requestedOutputPath: string, settings: ITextureImporterSettings): Promise<ITextureImportResult> {
	assertSupportedTexture(sourcePath);
	const sourceDetails = await stat(sourcePath);
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
	await ensureDir(temporaryRoot);
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
				mipmaps.push({ path: join(dirname(outputPath), name), width: size.width, height: size.height, bytes: (await stat(temporaryPath)).size });
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
		await remove(temporaryRoot).catch(() => undefined);
	}
}

async function artifactPaths(path: string): Promise<{ artifactPath: string; manifestPath: string; directory: string }> {
	const metadata = await readAssetMetadata(path);
	const directory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return {
		artifactPath: join(directory, `${basename(path, extname(path))}${textureImporterOutputExtension(path)}`),
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
	const { artifactPath, manifestPath } = await artifactPaths(path);
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
	];
	const exists = await pathExists(artifactPath);
	const complete = exists && (await Promise.all(requiredPaths.map((requiredPath) => pathExists(requiredPath)))).every(Boolean);
	return { path, artifactPath, manifestPath, fingerprint, current: complete && result !== null, exists, result: complete ? result : null };
}

/** Applies one exact-fingerprint Texture Importer and atomically replaces its project-local preview artifact directory. */
export async function applyTextureImporterArtifact(path: string, expectedFingerprint: string): Promise<ITextureImporterArtifactStatus> {
	const status = await getTextureImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Texture importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeTextureImporterSettings(metadata.importer.settings);
	const paths = await artifactPaths(path);
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

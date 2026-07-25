import { join, basename, dirname, extname, isAbsolute, normalize } from "path/posix";
import { copyFile, pathExists, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";

import sharp from "sharp";
import {
	normalizeAudioImporterSettings,
	normalizeAnimationImporterSettings,
	normalizeFontImporterSettings,
	normalizeMaterialImporterSettings,
	ModelImporterPlatform,
	TextureImporterPlatform,
	normalizeModelImporterSettings,
	normalizeTextureImporterSettings,
	normalizeVideoImporterSettings,
	textureImporterOutputExtension,
	videoImporterOutputExtension,
} from "babylonjs-editor-tools";

import { createDirectoryIfNotExist } from "../../tools/fs";

import { Editor } from "../../editor/main";

import { compressFileToKtx } from "./ktx";
import { processExportedTexture } from "./texture";
import { processExportedMaterial } from "./materials";
import { processExportedNodeParticleSystemSet } from "./particles";
import { readAssetMetadata } from "../../mcp/assets/registry";
import { processAudioImporterOutput } from "../../mcp/assets/audio-importer";
import { processVideoImporterOutput } from "../../mcp/assets/video-importer";
import { processFontImporterOutput } from "../../mcp/assets/font-importer";
import { processMaterialImporterOutput } from "../../mcp/assets/material-importer";
import { getModelImporterSourceFingerprint, processModelImporterOutput } from "../../mcp/assets/model-importer";
import { processAnimationImporterOutput } from "../../mcp/assets/animation-importer";
import { processTextureImporterOutput } from "../../mcp/assets/texture-importer";

const supportedImagesExtensions: string[] = [".jpg", ".jpeg", ".webp", ".png", ".bmp", ".gif", ".tif", ".tiff", ".tga", ".psd", ".psb", ".svg", ".hdr", ".exr"];
const supportedCubeTexturesExtensions: string[] = [".env", ".dds", ".hdr"];
const supportedAudioExtensions: string[] = [".mp3", ".wav", ".wave", ".ogg", ".flac", ".m4a"];
const supportedVideoExtensions: string[] = [".mp4", ".webm", ".ogv", ".mov"];
const supportedModelExtensions: string[] = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"];
const supportedFontExtensions: string[] = [".ttf", ".otf", ".woff", ".woff2"];
const supportedAnimationExtensions: string[] = [".animation", ".animations", ".animator", ".controller"];
const supportedMaterialExtensions: string[] = [".material", ".mtl"];
const supportedJsonExtensions: string[] = [".material", ".gui", ".cinematic", ".npss", ".ragdoll", ".json"];
const supportedMiscExtensions: string[] = [".3dl", ".exr", ".hdr"];

const supportedExtensions: string[] = [
	...supportedImagesExtensions,
	...supportedCubeTexturesExtensions,
	...supportedAudioExtensions,
	...supportedVideoExtensions,
	...supportedModelExtensions,
	...supportedFontExtensions,
	...supportedAnimationExtensions,
	...supportedMaterialExtensions,
	...supportedJsonExtensions,
	...supportedMiscExtensions,
];

function isUnsupportedImageFormatError(error: unknown): boolean {
	return error instanceof Error && /unsupported image format/i.test(error.message);
}

export type ProcessFileOptions = {
	optimize: boolean;
	modelPlatform?: ModelImporterPlatform;
	assetPlatform?: TextureImporterPlatform;
	scenePath: string;
	projectDir: string;
	exportedAssets: string[];
	cache: Record<string, string>;
};

function safeGeneratedAssetPath(root: string, relativePath: unknown): string | null {
	if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath)) {
		return null;
	}
	const normalized = normalize(relativePath);
	if (normalized === ".." || normalized.startsWith("../")) {
		return null;
	}
	return join(root, normalized);
}

async function removeGeneratedFontAssets(runtimePath: string, outputRoot: string): Promise<void> {
	try {
		const runtime = await readJSON(runtimePath);
		const candidates = [
			runtime.dynamicFontPath,
			runtime.manifestPath,
			...(Array.isArray(runtime.result?.pages) ? runtime.result.pages.map((page: { path?: unknown }) => page?.path) : []),
		];
		await Promise.all(
			candidates
				.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate))
				.filter((path): path is string => path !== null)
				.map((path) => remove(path))
		);
	} catch {
		// Missing or malformed generated metadata is safely ignored.
	}
	await remove(runtimePath);
}

async function generatedTextureAssets(runtimePath: string, outputRoot: string): Promise<string[] | null> {
	try {
		const runtime = await readJSON(runtimePath);
		const candidates = [
			runtime.outputPath,
			runtime.readableBitmapPath,
			runtime.readableDescriptorPath,
			runtime.previewPath,
			runtime.environmentPath,
			...(Array.isArray(runtime.mipmaps) ? runtime.mipmaps.map((mipmap: { path?: unknown }) => mipmap.path) : []),
			...(Array.isArray(runtime.cubeFaces) ? runtime.cubeFaces.map((face: { path?: unknown }) => face.path) : []),
		].filter((candidate) => candidate !== null && candidate !== undefined);
		const paths = candidates.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate));
		return paths.length > 0 && paths.every((path: string | null): path is string => path !== null) ? paths : null;
	} catch {
		return null;
	}
}

async function generatedTextureAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	const paths = await generatedTextureAssets(runtimePath, outputRoot);
	return paths !== null && (await Promise.all(paths.map((path) => pathExists(path)))).every(Boolean);
}

async function removeGeneratedTextureAssets(runtimePath: string, outputRoot: string): Promise<void> {
	const paths = await generatedTextureAssets(runtimePath, outputRoot);
	if (paths) {
		await Promise.all(paths.map((path) => remove(path)));
	}
	await remove(runtimePath);
}

async function generatedFontAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	try {
		const runtime = await readJSON(runtimePath);
		const candidates = [
			runtime.dynamicFontPath,
			runtime.manifestPath,
			...(Array.isArray(runtime.result?.pages) ? runtime.result.pages.map((page: { path?: unknown }) => page?.path) : []),
		].filter((candidate) => candidate !== null && candidate !== undefined);
		const paths = candidates.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate));
		return paths.length > 0 && paths.every((path): path is string => path !== null) && (await Promise.all(paths.map((path) => pathExists(path)))).every(Boolean);
	} catch {
		return false;
	}
}

async function generatedMaterialAssets(runtimePath: string, outputRoot: string): Promise<string[] | null> {
	try {
		const runtime = await readJSON(runtimePath);
		if (!Array.isArray(runtime.result?.extractedTextures)) {
			return null;
		}
		const paths = runtime.result.extractedTextures.map((candidate: unknown) => safeGeneratedAssetPath(outputRoot, candidate));
		return paths.every((path: string | null): path is string => path !== null) ? paths : null;
	} catch {
		return null;
	}
}

async function generatedMaterialAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	const paths = await generatedMaterialAssets(runtimePath, outputRoot);
	return paths !== null && (await Promise.all(paths.map((path) => pathExists(path)))).every(Boolean);
}

async function removeGeneratedModelAssets(runtimePath: string, outputRoot: string): Promise<void> {
	try {
		const runtime = await readJSON(runtimePath);
		const outputPath = safeGeneratedAssetPath(outputRoot, runtime.outputPath);
		if (outputPath) {
			await remove(outputPath);
		}
	} catch {
		// Missing or malformed generated metadata is safely ignored.
	}
	await remove(runtimePath);
}

async function generatedModelAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	try {
		const runtime = await readJSON(runtimePath);
		if (runtime.outputPath === null) {
			return runtime.result?.supported === false;
		}
		const outputPath = safeGeneratedAssetPath(outputRoot, runtime.outputPath);
		return outputPath !== null && (await pathExists(outputPath));
	} catch {
		return false;
	}
}

export async function processAssetFile(editor: Editor, file: string, options: ProcessFileOptions): Promise<void> {
	const isNavMesh = file.includes(".navmesh");
	const extension = extname(file).toLocaleLowerCase();

	if (!isNavMesh && !supportedExtensions.includes(extension)) {
		return;
	}

	if (basename(file).startsWith("editor_preview") || file.endsWith(".bjsmeta.json") || /\.bjsmeta\.json\.[0-9a-f-]+\.tmp$/i.test(file)) {
		return;
	}

	const relativePath = file.replace(join(options.projectDir, "/"), "");
	const importer = (await readAssetMetadata(file)).importer;
	const finalPath = join(options.scenePath, relativePath);
	if (importer.settings.includeInBuild === false) {
		delete options.cache[relativePath];
		if (importer.kind === "texture") {
			await removeGeneratedTextureAssets(`${finalPath}.bjstexture.json`, options.scenePath);
		}
		if (importer.kind === "font") {
			await removeGeneratedFontAssets(`${finalPath}.bjsfont.json`, options.scenePath);
		}
		if (importer.kind === "material") {
			await remove(`${finalPath}.bjsmaterial.json`);
		}
		if (importer.kind === "model") {
			await removeGeneratedModelAssets(`${finalPath}.bjsmodel.json`, options.scenePath);
		}
		if (importer.kind === "animation") {
			await remove(`${finalPath}.bjsanimation.json`);
		}
		await remove(finalPath);
		return;
	}
	const split = relativePath.split("/");

	let path = "";
	for (let i = 0; i < split.length - 1; ++i) {
		try {
			await createDirectoryIfNotExist(join(options.scenePath, path, split[i]));
		} catch (e) {
			// Catch silently.
		}

		path = join(path, split[i]);
	}

	let isNewFile = false;

	const fileStat = await stat(file);
	const modelSettings = importer.kind === "model" ? normalizeModelImporterSettings(importer.settings) : null;
	const modelSourceFingerprint = modelSettings ? await getModelImporterSourceFingerprint(file, modelSettings) : null;
	const targetPlatform = options.assetPlatform ?? options.modelPlatform ?? "default";
	const hash = `${fileStat.mtimeMs}:${JSON.stringify(importer)}${modelSourceFingerprint ? `:${modelSourceFingerprint}` : ""}${
		importer.kind === "model" || importer.kind === "texture" ? `:platform:${targetPlatform}` : ""
	}`;

	isNewFile = !options.cache[relativePath] || options.cache[relativePath] !== hash;

	options.cache[relativePath] = hash;

	const textureSettings = importer.kind === "texture" && supportedImagesExtensions.includes(extension) ? normalizeTextureImporterSettings(importer.settings) : null;
	const videoSettings = importer.kind === "video" ? normalizeVideoImporterSettings(importer.settings) : null;
	const expectedTexturePath = textureSettings ? join(dirname(finalPath), `${basename(finalPath, extname(finalPath))}${textureImporterOutputExtension(file)}`) : finalPath;
	const expectedVideoPath = videoSettings
		? join(dirname(finalPath), `${basename(finalPath, extname(finalPath))}${videoImporterOutputExtension(file, videoSettings)}`)
		: finalPath;
	const audioRuntimePath = `${finalPath}.bjsaudio.json`;
	const textureRuntimePath = `${finalPath}.bjstexture.json`;
	const videoRuntimePath = `${finalPath}.bjsvideo.json`;
	const fontRuntimePath = `${finalPath}.bjsfont.json`;
	const materialRuntimePath = `${finalPath}.bjsmaterial.json`;
	const modelRuntimePath = `${finalPath}.bjsmodel.json`;
	const animationRuntimePath = `${finalPath}.bjsanimation.json`;
	const finalPathExists =
		importer.kind === "texture"
			? await generatedTextureAssetsExist(textureRuntimePath, options.scenePath)
			: importer.kind === "font"
				? await generatedFontAssetsExist(fontRuntimePath, options.scenePath)
				: await pathExists(importer.kind === "video" ? expectedVideoPath : finalPath);
	const materialOutputCurrent =
		importer.kind !== "material" ||
		((await pathExists(finalPath)) && (await pathExists(materialRuntimePath)) && (await generatedMaterialAssetsExist(materialRuntimePath, options.scenePath)));
	const modelOutputCurrent =
		importer.kind !== "model" ||
		((await pathExists(finalPath)) && (await pathExists(modelRuntimePath)) && (await generatedModelAssetsExist(modelRuntimePath, options.scenePath)));
	const animationOutputCurrent = importer.kind !== "animation" || ((await pathExists(finalPath)) && (await pathExists(animationRuntimePath)));
	let exportedFilePath = importer.kind === "texture" ? expectedTexturePath : importer.kind === "video" ? expectedVideoPath : finalPath;
	let textureExportedPaths: string[] = [];
	let fontExportedPaths: string[] = [];
	let materialExportedPaths: string[] = [];
	let modelExportedPaths: string[] = [];

	if (
		isNewFile ||
		!finalPathExists ||
		!materialOutputCurrent ||
		!modelOutputCurrent ||
		!animationOutputCurrent ||
		(importer.kind === "texture" && !(await pathExists(textureRuntimePath))) ||
		(importer.kind === "video" && !(await pathExists(videoRuntimePath))) ||
		(importer.kind === "font" && !(await pathExists(fontRuntimePath)))
	) {
		if (textureSettings) {
			await removeGeneratedTextureAssets(textureRuntimePath, options.scenePath);
			let result: Awaited<ReturnType<typeof processTextureImporterOutput>>;
			try {
				result = await processTextureImporterOutput(file, finalPath, textureSettings, targetPlatform);
			} catch (error) {
				if (!isUnsupportedImageFormatError(error)) {
					throw error;
				}

				delete options.cache[relativePath];
				await remove(expectedTexturePath);
				editor.layout.console.warn(`Skipped invalid image asset "${relativePath}": ${(error as Error).message}`);
				return;
			}
			const portablePath = (path: string | null): string | null => (path ? path.replace(`${options.scenePath}/`, "") : null);
			const runtime = {
				version: 1,
				outputPath: portablePath(result.outputPath),
				textureType: result.settings.textureType,
				colorSpace: result.effectiveColorSpace,
				alphaSource: result.settings.alphaSource,
				generateMipmaps: result.settings.generateMipmaps,
				readableBitmapPath: portablePath(result.readableBitmapPath),
				readableDescriptorPath: portablePath(result.readableDescriptorPath),
				previewPath: portablePath(result.previewPath ?? null),
				cubeFaces: result.highDynamicRange?.cubeFaces.map((face) => ({ ...face, path: portablePath(face.path) })) ?? [],
				environmentPath: portablePath(result.highDynamicRange?.environmentPath ?? null),
				mipmaps: result.mipmaps.map((mipmap) => ({ path: portablePath(mipmap.path), width: mipmap.width, height: mipmap.height })),
				result: {
					...result,
					sourcePath: relativePath,
					outputPath: portablePath(result.outputPath),
					readableBitmapPath: portablePath(result.readableBitmapPath),
					readableDescriptorPath: portablePath(result.readableDescriptorPath),
					previewPath: portablePath(result.previewPath ?? null),
					highDynamicRange: result.highDynamicRange
						? {
								...result.highDynamicRange,
								environmentPath: portablePath(result.highDynamicRange.environmentPath),
								cubeFaces: result.highDynamicRange.cubeFaces.map((face) => ({ ...face, path: portablePath(face.path) })),
							}
						: null,
					mipmaps: result.mipmaps.map((mipmap) => ({ ...mipmap, path: portablePath(mipmap.path) })),
				},
			};
			await writeJSON(textureRuntimePath, runtime, { spaces: "\t" });
			exportedFilePath = result.outputPath;
			textureExportedPaths = [
				result.outputPath,
				...result.mipmaps.map((mipmap) => mipmap.path),
				...(result.readableBitmapPath ? [result.readableBitmapPath] : []),
				...(result.readableDescriptorPath ? [result.readableDescriptorPath] : []),
				...(result.previewPath ? [result.previewPath] : []),
				...(result.highDynamicRange?.cubeFaces.map((face) => face.path) ?? []),
				...(result.highDynamicRange?.environmentPath && result.highDynamicRange.environmentPath !== result.outputPath ? [result.highDynamicRange.environmentPath] : []),
				textureRuntimePath,
			];
		} else if (importer.kind === "audio" && supportedAudioExtensions.includes(extension)) {
			const result = await processAudioImporterOutput(file, finalPath, normalizeAudioImporterSettings(importer.settings), editor);
			await writeJSON(
				audioRuntimePath,
				{
					version: 1,
					loadType: result.settings.loadType,
					result: { ...result, sourcePath: relativePath, outputPath: relativePath },
				},
				{ spaces: "\t" }
			);
		} else if (importer.kind === "video" && supportedVideoExtensions.includes(extension) && videoSettings) {
			const result = await processVideoImporterOutput(file, finalPath, videoSettings, editor);
			exportedFilePath = result.outputPath;
			const outputRelativePath = result.outputPath.replace(`${options.scenePath}/`, "");
			await writeJSON(
				videoRuntimePath,
				{
					version: 1,
					outputPath: outputRelativePath,
					result: { ...result, sourcePath: relativePath, outputPath: outputRelativePath },
				},
				{ spaces: "\t" }
			);
		} else if (importer.kind === "font" && supportedFontExtensions.includes(extension)) {
			await removeGeneratedFontAssets(fontRuntimePath, options.scenePath);
			const result = await processFontImporterOutput(file, finalPath, normalizeFontImporterSettings(importer.settings));
			const manifestRelativePath = result.manifestPath.replace(`${options.scenePath}/`, "");
			const dynamicFontRelativePath = result.dynamicFontPath?.replace(`${options.scenePath}/`, "") ?? null;
			await writeJSON(
				fontRuntimePath,
				{
					version: 1,
					renderMode: result.renderMode,
					family: result.family,
					manifestPath: manifestRelativePath,
					dynamicFontPath: dynamicFontRelativePath,
					result: {
						...result,
						sourcePath: relativePath,
						outputDirectory: dirname(manifestRelativePath),
						manifestPath: manifestRelativePath,
						pages: result.pages.map((page) => ({ ...page, path: page.path.replace(`${options.scenePath}/`, "") })),
						dynamicFontPath: dynamicFontRelativePath,
					},
				},
				{ spaces: "\t" }
			);
			fontExportedPaths = [...(result.dynamicFontPath ? [result.dynamicFontPath] : []), result.manifestPath, ...result.pages.map((page) => page.path), fontRuntimePath];
		} else if (importer.kind === "material" && supportedMaterialExtensions.includes(extension)) {
			const result = await processMaterialImporterOutput(file, finalPath, options.scenePath, options.projectDir, normalizeMaterialImporterSettings(importer.settings));
			await writeJSON(
				materialRuntimePath,
				{
					version: 1,
					sourceKind: result.sourceKind,
					valid: result.valid,
					result: { ...result, sourcePath: relativePath, outputPath: relativePath },
				},
				{ spaces: "\t" }
			);
			materialExportedPaths = result.extractedTextures.map((path) => join(options.scenePath, path));
		} else if (importer.kind === "model" && supportedModelExtensions.includes(extension)) {
			await copyFile(file, finalPath);
			await removeGeneratedModelAssets(modelRuntimePath, options.scenePath);
			const processedPath = `${finalPath}.bjsmodel.babylon`;
			const result = await processModelImporterOutput(file, processedPath, modelSettings!, options.modelPlatform);
			const outputRelativePath = result.outputPath?.replace(`${options.scenePath}/`, "") ?? null;
			await writeJSON(
				modelRuntimePath,
				{
					version: 1,
					outputPath: outputRelativePath,
					supported: result.supported,
					valid: result.valid,
					result: { ...result, sourcePath: relativePath, outputPath: outputRelativePath },
				},
				{ spaces: "\t" }
			);
			modelExportedPaths = [finalPath, ...(result.outputPath ? [result.outputPath] : []), modelRuntimePath];
		} else if (importer.kind === "animation" && supportedAnimationExtensions.includes(extension)) {
			const result = await processAnimationImporterOutput(file, finalPath, normalizeAnimationImporterSettings(importer.settings));
			await writeJSON(
				animationRuntimePath,
				{
					version: 1,
					sourceKind: result.sourceKind,
					valid: result.valid,
					result: { ...result, sourcePath: relativePath, outputPath: relativePath },
				},
				{ spaces: "\t" }
			);
		} else {
			await copyFile(file, finalPath);
		}
		if (importer.kind === "texture" && supportedImagesExtensions.includes(extension) && !textureSettings) {
			const metadata = await sharp(finalPath).metadata();
			const maxSize = importer.settings.maxSize as number;
			if ((metadata.width ?? 0) > maxSize || (metadata.height ?? 0) > maxSize) {
				const kernel =
					importer.settings.resizeAlgorithm === "nearest"
						? sharp.kernel.nearest
						: importer.settings.resizeAlgorithm === "bicubic"
							? sharp.kernel.mitchell
							: sharp.kernel.lanczos3;
				await writeFile(finalPath, await sharp(finalPath).resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true, kernel }).toBuffer());
			}
		}
	}

	if (textureSettings) {
		if (!textureExportedPaths.length) {
			textureExportedPaths = [...((await generatedTextureAssets(textureRuntimePath, options.scenePath)) ?? []), textureRuntimePath];
		}
		options.exportedAssets.push(...textureExportedPaths);
	} else if (importer.kind === "font" && supportedFontExtensions.includes(extension)) {
		if (!fontExportedPaths.length) {
			const runtime = await readJSON(fontRuntimePath);
			fontExportedPaths = [
				...(runtime.dynamicFontPath ? [join(options.scenePath, runtime.dynamicFontPath)] : []),
				join(options.scenePath, runtime.manifestPath),
				...(runtime.result?.pages ?? []).map((page: { path: string }) => join(options.scenePath, page.path)),
				fontRuntimePath,
			];
		}
		options.exportedAssets.push(...fontExportedPaths);
	} else if (importer.kind === "material" && supportedMaterialExtensions.includes(extension)) {
		if (!materialExportedPaths.length) {
			materialExportedPaths = (await generatedMaterialAssets(materialRuntimePath, options.scenePath)) ?? [];
		}
		options.exportedAssets.push(...materialExportedPaths, exportedFilePath);
	} else if (importer.kind === "model" && supportedModelExtensions.includes(extension)) {
		if (!modelExportedPaths.length) {
			const runtime = await readJSON(modelRuntimePath);
			const generatedPath = safeGeneratedAssetPath(options.scenePath, runtime.outputPath);
			modelExportedPaths = [finalPath, ...(generatedPath ? [generatedPath] : []), modelRuntimePath];
		}
		options.exportedAssets.push(...modelExportedPaths);
	} else {
		options.exportedAssets.push(exportedFilePath);
	}
	if (importer.kind === "audio" && supportedAudioExtensions.includes(extension)) {
		options.exportedAssets.push(audioRuntimePath);
	} else if (importer.kind === "video" && supportedVideoExtensions.includes(extension)) {
		options.exportedAssets.push(videoRuntimePath);
	} else if (importer.kind === "material" && supportedMaterialExtensions.includes(extension)) {
		options.exportedAssets.push(materialRuntimePath);
	} else if (importer.kind === "model" && supportedModelExtensions.includes(extension)) {
		// Model source, processed output, and runtime sidecar are added together above.
	} else if (importer.kind === "animation" && supportedAnimationExtensions.includes(extension)) {
		options.exportedAssets.push(animationRuntimePath);
	}

	if (options.optimize) {
		const compressionSources = textureSettings ? textureExportedPaths.filter((path) => supportedImagesExtensions.includes(extname(path).toLowerCase())) : [finalPath];
		await Promise.all(
			compressionSources.map((path) =>
				compressFileToKtx(editor, path, {
					force: isNewFile,
					exportedAssets: options.exportedAssets,
				})
			)
		);
	}

	if (options.optimize) {
		if (supportedImagesExtensions.includes(extension) && !textureSettings) {
			await processExportedTexture(editor, finalPath, {
				force: isNewFile,
				exportedAssets: options.exportedAssets,
				generateMipmaps: importer.kind === "texture" ? (importer.settings.generateMipmaps as boolean) : true,
			});
		} else if (extension === ".material" && importer.kind !== "material") {
			await processExportedMaterial(editor, finalPath, {
				force: isNewFile,
				scenePath: options.scenePath,
				exportedAssets: options.exportedAssets,
			});
		} else if (extension === ".npss") {
			await processExportedNodeParticleSystemSet(editor, finalPath, {
				force: isNewFile,
				scenePath: options.scenePath,
				exportedAssets: options.exportedAssets,
			});
		}
	}
}

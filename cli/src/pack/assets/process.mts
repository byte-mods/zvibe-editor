import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path/posix";
import { createHash } from "node:crypto";

import fs from "fs-extra";

import { compressFileToKtx } from "./ktx.mjs";
import { compressFileToKtx2 } from "./ktx2.mjs";
import { ICreateAssetsOptions } from "./assets.mjs";
import { processExportedMaterial, processExportedMaterialImporter } from "./material.mjs";
import { processExportedNodeParticleSystemSet } from "./particle-system.mjs";
import { EditorProjectCompressedTextureSoftware, processExportedTexture } from "./texture.mjs";
import {
	normalizeAssetImporterConfiguration,
	normalizeAudioImporterSettings,
	normalizeAnimationImporterSettings,
	normalizeFontImporterSettings,
	normalizeMaterialImporterSettings,
	normalizeModelImporterSettings,
	filterModelMaterialSearchPaths,
	normalizeTextureImporterSettings,
	normalizeVideoImporterSettings,
	textureImporterOutputExtension,
	videoImporterOutputExtension,
} from "babylonjs-editor-tools";
import { processExportedAudio } from "./audio.mjs";
import { processExportedVideo } from "./video.mjs";
import { processExportedFont } from "./font.mjs";
import { processExportedAnimation } from "./animation.mjs";
import { processExportedModel } from "./model.mjs";
import { processImportedTexture } from "./texture-importer.mjs";
import { normalizedGlob } from "../../tools/fs.mjs";

export const supportedImagesExtensions: string[] = [".jpg", ".jpeg", ".webp", ".png", ".bmp", ".gif", ".tif", ".tiff", ".svg"];
export const supportedCubeTexturesExtensions: string[] = [".env", ".dds", ".hdr"];
export const supportedAudioExtensions: string[] = [".mp3", ".wav", ".wave", ".ogg", ".flac", ".m4a"];
export const supportedVideoExtensions: string[] = [".mp4", ".webm", ".ogv", ".mov"];
export const supportedModelExtensions: string[] = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds"];
export const supportedFontExtensions: string[] = [".ttf", ".otf", ".woff", ".woff2"];
export const supportedAnimationExtensions: string[] = [".animation", ".animations", ".animator", ".controller"];
export const supportedMaterialExtensions: string[] = [".material", ".mtl"];
export const supportedJsonExtensions: string[] = [".material", ".gui", ".cinematic", ".npss", ".ragdoll", ".json"];
export const supportedMiscExtensions: string[] = [".3dl", ".exr", ".hdr"];

export const supportedExtensions: string[] = [
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

export interface IProcessAssetFileOptions extends ICreateAssetsOptions {
	outputAssetsDir: string;
	exportedAssets: string[];
	optimize: boolean;
	cache: Record<string, string>;

	compressedTexturesEnabled: boolean;
	compressedEtc2Enabled?: boolean;
	compressedPvrtcEnabled?: boolean;
	compressedTextureQuality?: string;
	compressedTextureSoftware?: EditorProjectCompressedTextureSoftware;
}

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
		const runtime = await fs.readJSON(runtimePath);
		const candidates = [
			runtime.dynamicFontPath,
			runtime.manifestPath,
			...(Array.isArray(runtime.result?.pages) ? runtime.result.pages.map((page: { path?: unknown }) => page?.path) : []),
		];
		await Promise.all(
			candidates
				.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate))
				.filter((path): path is string => path !== null)
				.map((path) => fs.remove(path))
		);
	} catch {
		// Missing or malformed generated metadata is safely ignored.
	}
	await fs.remove(runtimePath);
}

async function generatedTextureAssets(runtimePath: string, outputRoot: string): Promise<string[] | null> {
	try {
		const runtime = await fs.readJSON(runtimePath);
		const candidates = [
			runtime.outputPath,
			runtime.readableBitmapPath,
			runtime.readableDescriptorPath,
			...(Array.isArray(runtime.mipmaps) ? runtime.mipmaps.map((mipmap: { path?: unknown }) => mipmap.path) : []),
		].filter((candidate) => candidate !== null && candidate !== undefined);
		const paths = candidates.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate));
		return paths.length > 0 && paths.every((path: string | null): path is string => path !== null) ? paths : null;
	} catch {
		return null;
	}
}

async function generatedTextureAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	const paths = await generatedTextureAssets(runtimePath, outputRoot);
	return paths !== null && (await Promise.all(paths.map((path) => fs.pathExists(path)))).every(Boolean);
}

async function removeGeneratedTextureAssets(runtimePath: string, outputRoot: string): Promise<void> {
	const paths = await generatedTextureAssets(runtimePath, outputRoot);
	if (paths) {
		await Promise.all(paths.map((path) => fs.remove(path)));
	}
	await fs.remove(runtimePath);
}

async function generatedFontAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	try {
		const runtime = await fs.readJSON(runtimePath);
		const candidates = [
			runtime.dynamicFontPath,
			runtime.manifestPath,
			...(Array.isArray(runtime.result?.pages) ? runtime.result.pages.map((page: { path?: unknown }) => page?.path) : []),
		].filter((candidate) => candidate !== null && candidate !== undefined);
		const paths = candidates.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate));
		return paths.length > 0 && paths.every((path): path is string => path !== null) && (await Promise.all(paths.map((path) => fs.pathExists(path)))).every(Boolean);
	} catch {
		return false;
	}
}

async function generatedMaterialAssets(runtimePath: string, outputRoot: string): Promise<string[] | null> {
	try {
		const runtime = await fs.readJSON(runtimePath);
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
	return paths !== null && (await Promise.all(paths.map((path) => fs.pathExists(path)))).every(Boolean);
}

async function removeGeneratedModelAssets(runtimePath: string, outputRoot: string): Promise<void> {
	try {
		const runtime = await fs.readJSON(runtimePath);
		const outputPath = safeGeneratedAssetPath(outputRoot, runtime.outputPath);
		if (outputPath) {
			await fs.remove(outputPath);
		}
	} catch {
		// Missing or malformed generated metadata is safely ignored.
	}
	await fs.remove(runtimePath);
}

async function generatedModelAssetsExist(runtimePath: string, outputRoot: string): Promise<boolean> {
	try {
		const runtime = await fs.readJSON(runtimePath);
		if (runtime.outputPath === null) {
			return runtime.result?.supported === false;
		}
		const outputPath = safeGeneratedAssetPath(outputRoot, runtime.outputPath);
		return outputPath !== null && (await fs.pathExists(outputPath));
	} catch {
		return false;
	}
}

async function generatedModelDependencyFingerprint(runtimePath: string, projectRoot: string): Promise<string> {
	try {
		const runtime = await fs.readJSON(runtimePath);
		const dependencies = Array.isArray(runtime.result?.dependencyPaths) ? [...runtime.result.dependencyPaths].sort() : [];
		const hash = createHash("sha256");
		for (const dependency of dependencies) {
			const path = safeGeneratedAssetPath(projectRoot, dependency);
			if (!path || !(await fs.pathExists(path))) {
				hash.update(`\0missing:${String(dependency)}`);
			} else {
				hash.update(`\0${dependency}\0`).update(await fs.readFile(path));
			}
		}
		const search = runtime.result?.settings?.materialSearch;
		if (["local", "recursiveUp", "projectWide"].includes(search) && typeof runtime.result?.sourcePath === "string") {
			const root = await fs.realpath(projectRoot);
			const materialPaths = (
				await normalizedGlob(join(root, "/**/*.material"), {
					nodir: true,
					ignore: ["**/node_modules/**", "**/.bjseditor/**", "**/public/scene/**"],
				})
			).map((candidate) => relative(root, candidate.toString()).replace(/\\/g, "/"));
			for (const materialPath of filterModelMaterialSearchPaths(runtime.result.sourcePath, materialPaths, search)) {
				hash.update(`\0search:${materialPath}\0`).update(await fs.readFile(join(root, materialPath)));
			}
		}
		return hash.digest("hex");
	} catch {
		return "";
	}
}

export async function processAssetFile(file: string, options: IProcessAssetFileOptions) {
	const isNavMesh = file.includes(".navmesh");
	const extension = extname(file).toLocaleLowerCase();

	if (!isNavMesh && !supportedExtensions.includes(extension)) {
		return;
	}

	if (basename(file).startsWith("editor_preview") || file.endsWith(".bjsmeta.json") || /\.bjsmeta\.json\.[0-9a-f-]+\.tmp$/i.test(file)) {
		return;
	}

	const relativePath = file.replace(join(options.projectDir, "/"), "");
	let importer = normalizeAssetImporterConfiguration(file, {});
	try {
		const sidecar = `${file}.bjsmeta.json`;
		if (await fs.pathExists(sidecar)) {
			importer = normalizeAssetImporterConfiguration(file, (await fs.readJSON(sidecar)).importer);
		}
	} catch {
		// Invalid importer metadata safely falls back to the type defaults.
	}
	const finalPath = join(options.publicDir, relativePath);
	if (importer.settings.includeInBuild === false) {
		delete options.cache[relativePath];
		if (importer.kind === "texture") {
			await removeGeneratedTextureAssets(`${finalPath}.bjstexture.json`, options.publicDir);
		}
		if (importer.kind === "font") {
			await removeGeneratedFontAssets(`${finalPath}.bjsfont.json`, options.publicDir);
		}
		if (importer.kind === "material") {
			await fs.remove(`${finalPath}.bjsmaterial.json`);
		}
		if (importer.kind === "model") {
			await removeGeneratedModelAssets(`${finalPath}.bjsmodel.json`, options.publicDir);
		}
		if (importer.kind === "animation") {
			await fs.remove(`${finalPath}.bjsanimation.json`);
		}
		await fs.remove(finalPath);
		return;
	}
	const split = relativePath.split("/");

	let path = "";
	for (let i = 0; i < split.length - 1; ++i) {
		try {
			await fs.ensureDir(join(options.publicDir, path, split[i]));
		} catch (e) {
			// Catch silently.
		}

		path = join(path, split[i]);
	}

	let isNewFile = false;

	const fileStat = await fs.stat(file);
	const baseHash = `${fileStat.mtimeMs}:${JSON.stringify(importer)}${importer.kind === "model" ? `:platform:${options.modelPlatform ?? "default"}` : ""}`;
	const modelDependencyFingerprint = importer.kind === "model" ? await generatedModelDependencyFingerprint(`${finalPath}.bjsmodel.json`, options.projectDir) : "";
	const hash = `${baseHash}${modelDependencyFingerprint ? `:${modelDependencyFingerprint}` : ""}`;

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
			? await generatedTextureAssetsExist(textureRuntimePath, options.publicDir)
			: importer.kind === "font"
				? await generatedFontAssetsExist(fontRuntimePath, options.publicDir)
				: await fs.pathExists(importer.kind === "video" ? expectedVideoPath : finalPath);
	const materialOutputCurrent =
		importer.kind !== "material" ||
		((await fs.pathExists(finalPath)) && (await fs.pathExists(materialRuntimePath)) && (await generatedMaterialAssetsExist(materialRuntimePath, options.publicDir)));
	const modelOutputCurrent =
		importer.kind !== "model" ||
		((await fs.pathExists(finalPath)) && (await fs.pathExists(modelRuntimePath)) && (await generatedModelAssetsExist(modelRuntimePath, options.publicDir)));
	const animationOutputCurrent = importer.kind !== "animation" || ((await fs.pathExists(finalPath)) && (await fs.pathExists(animationRuntimePath)));
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
		(importer.kind === "texture" && !(await fs.pathExists(textureRuntimePath))) ||
		(importer.kind === "video" && !(await fs.pathExists(videoRuntimePath))) ||
		(importer.kind === "font" && !(await fs.pathExists(fontRuntimePath)))
	) {
		if (textureSettings) {
			await removeGeneratedTextureAssets(textureRuntimePath, options.publicDir);
			const result = await processImportedTexture(file, finalPath, textureSettings);
			const portablePath = (path: string | null): string | null => (path ? path.replace(`${options.publicDir}/`, "") : null);
			await fs.writeJSON(
				textureRuntimePath,
				{
					version: 1,
					outputPath: portablePath(result.outputPath),
					textureType: result.settings.textureType,
					colorSpace: result.effectiveColorSpace,
					alphaSource: result.settings.alphaSource,
					generateMipmaps: result.settings.generateMipmaps,
					readableBitmapPath: portablePath(result.readableBitmapPath),
					readableDescriptorPath: portablePath(result.readableDescriptorPath),
					mipmaps: result.mipmaps.map((mipmap) => ({ path: portablePath(mipmap.path), width: mipmap.width, height: mipmap.height })),
					result: {
						...result,
						sourcePath: relativePath,
						outputPath: portablePath(result.outputPath),
						readableBitmapPath: portablePath(result.readableBitmapPath),
						readableDescriptorPath: portablePath(result.readableDescriptorPath),
						mipmaps: result.mipmaps.map((mipmap) => ({ ...mipmap, path: portablePath(mipmap.path) })),
					},
				},
				{ spaces: "\t" }
			);
			exportedFilePath = result.outputPath;
			textureExportedPaths = [
				result.outputPath,
				...result.mipmaps.map((mipmap) => mipmap.path),
				...(result.readableBitmapPath ? [result.readableBitmapPath] : []),
				...(result.readableDescriptorPath ? [result.readableDescriptorPath] : []),
				textureRuntimePath,
			];
		} else if (supportedJsonExtensions.includes(extension) && importer.kind !== "material") {
			await fs.writeJSON(finalPath, await fs.readJSON(file), {
				encoding: "utf-8",
			});
		} else if (importer.kind === "audio" && supportedAudioExtensions.includes(extension)) {
			const result = await processExportedAudio(file, finalPath, normalizeAudioImporterSettings(importer.settings));
			await fs.writeJSON(
				audioRuntimePath,
				{
					version: 1,
					loadType: result.settings.loadType,
					result: { ...result, sourcePath: relativePath, outputPath: relativePath },
				},
				{ spaces: "\t" }
			);
		} else if (importer.kind === "video" && supportedVideoExtensions.includes(extension) && videoSettings) {
			const result = await processExportedVideo(file, finalPath, videoSettings);
			exportedFilePath = result.outputPath;
			const outputRelativePath = result.outputPath.replace(`${options.publicDir}/`, "");
			await fs.writeJSON(
				videoRuntimePath,
				{
					version: 1,
					outputPath: outputRelativePath,
					result: { ...result, sourcePath: relativePath, outputPath: outputRelativePath },
				},
				{ spaces: "\t" }
			);
		} else if (importer.kind === "font" && supportedFontExtensions.includes(extension)) {
			await removeGeneratedFontAssets(fontRuntimePath, options.publicDir);
			const result = await processExportedFont(file, finalPath, normalizeFontImporterSettings(importer.settings));
			const manifestRelativePath = result.manifestPath.replace(`${options.publicDir}/`, "");
			const dynamicFontRelativePath = result.dynamicFontPath?.replace(`${options.publicDir}/`, "") ?? null;
			await fs.writeJSON(
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
						pages: result.pages.map((page) => ({ ...page, path: page.path.replace(`${options.publicDir}/`, "") })),
						dynamicFontPath: dynamicFontRelativePath,
					},
				},
				{ spaces: "\t" }
			);
			fontExportedPaths = [...(result.dynamicFontPath ? [result.dynamicFontPath] : []), result.manifestPath, ...result.pages.map((page) => page.path), fontRuntimePath];
		} else if (importer.kind === "material" && supportedMaterialExtensions.includes(extension)) {
			const result = await processExportedMaterialImporter(file, finalPath, options.publicDir, options.projectDir, normalizeMaterialImporterSettings(importer.settings));
			await fs.writeJSON(
				materialRuntimePath,
				{
					version: 1,
					sourceKind: result.sourceKind,
					valid: result.valid,
					result: { ...result, sourcePath: relativePath, outputPath: relativePath },
				},
				{ spaces: "\t" }
			);
			materialExportedPaths = result.extractedTextures.map((path) => join(options.publicDir, path));
		} else if (importer.kind === "model" && supportedModelExtensions.includes(extension)) {
			await fs.copyFile(file, finalPath);
			await removeGeneratedModelAssets(modelRuntimePath, options.publicDir);
			const processedPath = `${finalPath}.bjsmodel.babylon`;
			const result = await processExportedModel(file, processedPath, normalizeModelImporterSettings(importer.settings), options.projectDir, options.modelPlatform);
			const outputRelativePath = result.outputPath?.replace(`${options.publicDir}/`, "") ?? null;
			await fs.writeJSON(
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
			const result = await processExportedAnimation(file, finalPath, normalizeAnimationImporterSettings(importer.settings));
			await fs.writeJSON(
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
			await fs.copyFile(file, finalPath);
		}
	}
	if (importer.kind === "model") {
		const currentDependencyFingerprint = await generatedModelDependencyFingerprint(modelRuntimePath, options.projectDir);
		options.cache[relativePath] = `${baseHash}${currentDependencyFingerprint ? `:${currentDependencyFingerprint}` : ""}`;
	}

	options.onStepChanged?.("assets", {
		message: `Processed asset: ${relativePath}`,
	});

	if (textureSettings) {
		if (!textureExportedPaths.length) {
			textureExportedPaths = [...((await generatedTextureAssets(textureRuntimePath, options.publicDir)) ?? []), textureRuntimePath];
		}
		options.exportedAssets.push(...textureExportedPaths);
	} else if (importer.kind === "font" && supportedFontExtensions.includes(extension)) {
		if (!fontExportedPaths.length) {
			const runtime = await fs.readJSON(fontRuntimePath);
			fontExportedPaths = [
				...(runtime.dynamicFontPath ? [join(options.publicDir, runtime.dynamicFontPath)] : []),
				join(options.publicDir, runtime.manifestPath),
				...(runtime.result?.pages ?? []).map((page: { path: string }) => join(options.publicDir, page.path)),
				fontRuntimePath,
			];
		}
		options.exportedAssets.push(...fontExportedPaths);
	} else if (importer.kind === "material" && supportedMaterialExtensions.includes(extension)) {
		if (!materialExportedPaths.length) {
			materialExportedPaths = (await generatedMaterialAssets(materialRuntimePath, options.publicDir)) ?? [];
		}
		options.exportedAssets.push(...materialExportedPaths, exportedFilePath);
	} else if (importer.kind === "model" && supportedModelExtensions.includes(extension)) {
		if (!modelExportedPaths.length) {
			const runtime = await fs.readJSON(modelRuntimePath);
			const generatedPath = safeGeneratedAssetPath(options.publicDir, runtime.outputPath);
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
			compressionSources.map(async (path) => {
				if (options.compressedTextureSoftware === "PVRTexTool") {
					await compressFileToKtx(path, { force: isNewFile, ...options });
				} else if (options.compressedTextureSoftware === "Khronos KTX-Software") {
					await compressFileToKtx2(path, { force: isNewFile, ...options });
				}
			})
		);
	}

	if (options.optimize) {
		if (supportedImagesExtensions.includes(extension) && !textureSettings) {
			await processExportedTexture(finalPath, {
				...options,
				force: isNewFile,
				generateMipmaps: importer.kind === "texture" ? (importer.settings.generateMipmaps as boolean) : true,
			});
		} else if (extension === ".material" && importer.kind !== "material") {
			await processExportedMaterial(finalPath, {
				...options,
				force: isNewFile,
			});
		} else if (extension === ".npss") {
			await processExportedNodeParticleSystemSet(finalPath, {
				...options,
				force: isNewFile,
			});
		}
	}
}

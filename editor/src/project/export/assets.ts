import { join, basename, dirname, extname, isAbsolute, normalize, relative } from "path/posix";
import { createHash } from "crypto";
import { copy, copyFile, lstat, pathExists, readFile, readJSON, readdir, realpath, remove, stat, writeFile, writeJSON } from "fs-extra";

import sharp from "sharp";
import {
	asepriteBuildOutputIsCurrent,
	convertAlembicFileToCache,
	exportAsepriteBuildAsset,
	inspectAsepriteBuildSource,
	normalizeAsepriteBuildGuid,
	removeAsepriteBuildOutput,
} from "babylonjs-editor-cli";
import {
	normalizeAlembicImporterSettings,
	normalizeAudioImporterSettings,
	normalizeAnimationImporterSettings,
	normalizeFontImporterSettings,
	getRuntimeAiOnnxExternalDataPaths,
	parseAlembicCache,
	normalizeMaterialImporterSettings,
	ModelImporterPlatform,
	TextureImporterPlatform,
	normalizeModelImporterSettings,
	normalizeTextureImporterSettings,
	normalizeVideoImporterSettings,
	resolveTextureImporterPlatformSettings,
	resolveVideoImporterPlatformSettings,
	SCRIPTABLE_AUDIO_GRAPH_SUFFIX,
	textureImporterOutputExtension,
	videoImporterOutputExtension,
} from "babylonjs-editor-tools";

import { createDirectoryIfNotExist, normalizedGlob } from "../../tools/fs";

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
import { IScriptableAudioAssetSnapshot, readScriptableAudioAsset } from "../../mcp/assets/scriptable-audio-assets";

const maximumRuntimeAiBuildBytes = 256 * 1024 * 1024;

interface IRuntimeAiBuildAsset {
	format: "onnx" | "litert" | "pytorchExport";
	modelBytes: number;
	modelSha256: string;
	externalData: Array<{ path: string; absolutePath: string; bytes: number; sha256: string }>;
	fingerprint: string;
}

interface IRuntimeAiBuildManifest {
	version: 3;
	format: IRuntimeAiBuildAsset["format"];
	modelBytes: number;
	modelSha256: string;
	externalData: Array<{ path: string; bytes: number; sha256: string }>;
	liteRtWasmPath: string | null;
	liteRtWasmRelativePath: string | null;
	runtimeFiles: Array<{ path: string; bytes: number; sha256: string }>;
	fingerprint: string;
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function alembicOutputIsCurrent(outputPath: string, manifestPath: string, relativePath: string): Promise<boolean> {
	try {
		if (!(await pathExists(outputPath)) || !(await pathExists(manifestPath))) {
			return false;
		}
		const content = new Uint8Array(await readFile(outputPath));
		const document = parseAlembicCache(content);
		const manifest = await readJSON(manifestPath);
		return (
			manifest?.version === 1 &&
			manifest?.format === document.manifest.format &&
			manifest?.outputPath === relativePath &&
			manifest?.cacheSha256 === createHash("sha256").update(content).digest("hex") &&
			manifest?.source?.sha256 === document.manifest.source.sha256 &&
			manifest?.settingsSha256 === document.manifest.settingsSha256
		);
	} catch {
		return false;
	}
}

function safeRuntimeAiRelativePath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		!!path &&
		path.length <= 2048 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.includes("://") &&
		!path.split("/").some((part) => !part || part === "." || part === "..")
	);
}

async function removeRuntimeAiOutput(destination: string, outputRoot: string): Promise<void> {
	try {
		const manifest = (await readJSON(`${destination}.bjsai.json`)) as Partial<IRuntimeAiBuildManifest>;
		if (Array.isArray(manifest.externalData)) {
			for (const value of manifest.externalData) {
				if (!safeRuntimeAiRelativePath(value?.path)) {
					continue;
				}
				const path = join(dirname(destination), value.path);
				const contained = relative(outputRoot, path);
				let shared = false;
				for (const otherManifestCandidate of await normalizedGlob(join(outputRoot, "**/*.bjsai.json"), { nodir: true })) {
					const otherManifestPath = otherManifestCandidate.toString();
					if (otherManifestPath === `${destination}.bjsai.json`) {
						continue;
					}
					try {
						const other = (await readJSON(otherManifestPath)) as Partial<IRuntimeAiBuildManifest>;
						const otherDestination = otherManifestPath.slice(0, -".bjsai.json".length);
						shared = Boolean(other.externalData?.some((entry) => safeRuntimeAiRelativePath(entry?.path) && join(dirname(otherDestination), entry.path) === path));
					} catch {
						// Malformed unrelated manifests cannot claim ownership of this exact companion.
					}
					if (shared) {
						break;
					}
				}
				if (!shared && contained && contained !== ".." && !contained.startsWith("../") && !isAbsolute(contained)) {
					await remove(path);
				}
			}
		}
	} catch {
		// A missing or malformed prior manifest must not block removal of the owned primary outputs.
	}
	await Promise.all([remove(destination), remove(`${destination}.bjsai.json`)]);
}

async function inspectRuntimeAiExportAsset(file: string): Promise<IRuntimeAiBuildAsset> {
	const extension = extname(file).toLowerCase();
	const format = extension === ".tflite" ? "litert" : extension === ".pt2" ? "pytorchExport" : "onnx";
	const sourceDetails = await lstat(file).catch(() => null);
	if (!sourceDetails?.isFile() || sourceDetails.isSymbolicLink()) {
		throw new Error("Runtime AI build source must be a regular, non-symbolic-link model file.");
	}
	if (sourceDetails.size < 1 || sourceDetails.size > maximumRuntimeAiBuildBytes) {
		throw new Error("Runtime AI build source must contain from 1 byte through 256 MiB.");
	}
	const bytes = await readFile(file);
	const externalData: IRuntimeAiBuildAsset["externalData"] = [];
	let totalBytes = bytes.byteLength;
	const hash = createHash("sha256").update(bytes);
	const modelSha256 = createHash("sha256").update(bytes).digest("hex");
	if (format === "onnx") {
		const modelDirectory = await realpath(dirname(file));
		for (const path of getRuntimeAiOnnxExternalDataPaths(bytes)) {
			const absolutePath = join(dirname(file), path);
			const details = await lstat(absolutePath).catch(() => null);
			if (!details?.isFile() || details.isSymbolicLink()) {
				throw new Error(`ONNX external-data file is missing or symbolic: ${path}.`);
			}
			const realAbsolutePath = await realpath(absolutePath);
			const contained = relative(modelDirectory, realAbsolutePath);
			if (!contained || contained === ".." || contained.startsWith("../") || isAbsolute(contained)) {
				throw new Error(`ONNX external-data file resolves outside the model directory through a symbolic directory: ${path}.`);
			}
			const data = await readFile(realAbsolutePath);
			totalBytes += data.byteLength;
			if (totalBytes > maximumRuntimeAiBuildBytes) {
				throw new Error("Runtime AI model plus companion weights exceed 256 MiB.");
			}
			hash.update("\0").update(path).update("\0").update(data);
			externalData.push({ path, absolutePath: realAbsolutePath, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
		}
	}
	return { format, modelBytes: bytes.byteLength, modelSha256, externalData, fingerprint: hash.digest("hex") };
}

async function exportRuntimeAiAsset(source: string, destination: string, outputRoot: string, asset: IRuntimeAiBuildAsset): Promise<string[]> {
	await removeRuntimeAiOutput(destination, outputRoot);
	await copyFile(source, destination);
	const paths = [destination];
	for (const companion of asset.externalData) {
		const output = join(dirname(destination), companion.path);
		await createDirectoryIfNotExist(dirname(output));
		await copyFile(companion.absolutePath, output);
		paths.push(output);
	}
	let runtimePaths: string[] = [];
	if (asset.format === "litert") {
		const sourceDirectory = join(dirname(require.resolve("@litertjs/core/package.json")), "wasm");
		const outputDirectory = join(outputRoot, "runtime-ai/litert");
		await copy(sourceDirectory, outputDirectory, { overwrite: true });
		runtimePaths = (await readdir(outputDirectory)).map((name) => join(outputDirectory, name));
		paths.push(...runtimePaths);
	}
	const runtimeFiles = await Promise.all(
		runtimePaths.map(async (path) => ({ path: relative(outputRoot, path), bytes: (await stat(path)).size, sha256: await fileSha256(path) }))
	);
	const manifest = `${destination}.bjsai.json`;
	await writeJSON(
		manifest,
		{
			version: 3,
			format: asset.format,
			modelBytes: asset.modelBytes,
			modelSha256: asset.modelSha256,
			externalData: asset.externalData.map((value) => ({ path: value.path, bytes: value.bytes, sha256: value.sha256 })),
			liteRtWasmPath: asset.format === "litert" ? "runtime-ai/litert/" : null,
			liteRtWasmRelativePath: asset.format === "litert" ? `${relative(dirname(destination), join(outputRoot, "runtime-ai/litert"))}/` : null,
			runtimeFiles,
			fingerprint: asset.fingerprint,
		} satisfies IRuntimeAiBuildManifest,
		{ spaces: "\t" }
	);
	paths.push(manifest);
	return paths;
}

async function runtimeAiOutputIsCurrent(destination: string, outputRoot: string, asset: IRuntimeAiBuildAsset): Promise<boolean> {
	try {
		const manifest = (await readJSON(`${destination}.bjsai.json`)) as IRuntimeAiBuildManifest;
		if (
			manifest.version !== 3 ||
			manifest.format !== asset.format ||
			manifest.modelBytes !== asset.modelBytes ||
			manifest.modelSha256 !== asset.modelSha256 ||
			manifest.fingerprint !== asset.fingerprint
		) {
			return false;
		}
		if (manifest.liteRtWasmPath !== (asset.format === "litert" ? "runtime-ai/litert/" : null)) {
			return false;
		}
		const expectedWasmRelativePath = asset.format === "litert" ? `${relative(dirname(destination), join(outputRoot, "runtime-ai/litert"))}/` : null;
		if (manifest.liteRtWasmRelativePath !== expectedWasmRelativePath) {
			return false;
		}
		if (JSON.stringify(manifest.externalData) !== JSON.stringify(asset.externalData.map((value) => ({ path: value.path, bytes: value.bytes, sha256: value.sha256 })))) {
			return false;
		}
		const hash = createHash("sha256").update(await readFile(destination));
		for (const companion of asset.externalData) {
			const path = join(dirname(destination), companion.path);
			const data = await readFile(path);
			if (data.byteLength !== companion.bytes) {
				return false;
			}
			hash.update("\0").update(companion.path).update("\0").update(data);
		}
		if (hash.digest("hex") !== asset.fingerprint) {
			return false;
		}
		if (!Array.isArray(manifest.runtimeFiles) || (asset.format === "litert" && !manifest.runtimeFiles.length) || (asset.format !== "litert" && manifest.runtimeFiles.length)) {
			return false;
		}
		for (const runtimeFile of manifest.runtimeFiles) {
			if (
				!runtimeFile ||
				typeof runtimeFile.path !== "string" ||
				!runtimeFile.path.startsWith("runtime-ai/litert/") ||
				runtimeFile.path.includes("\\") ||
				runtimeFile.path.split("/").some((part) => !part || part === "." || part === "..") ||
				!Number.isSafeInteger(runtimeFile.bytes) ||
				runtimeFile.bytes < 1 ||
				!/^[a-f0-9]{64}$/.test(runtimeFile.sha256)
			) {
				return false;
			}
			const path = join(outputRoot, runtimeFile.path);
			const details = await lstat(path);
			if (!details.isFile() || details.isSymbolicLink() || details.size !== runtimeFile.bytes || (await fileSha256(path)) !== runtimeFile.sha256) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

const supportedImagesExtensions: string[] = [".jpg", ".jpeg", ".webp", ".png", ".bmp", ".gif", ".tif", ".tiff", ".tga", ".psd", ".psb", ".svg", ".hdr", ".exr"];
const supportedCubeTexturesExtensions: string[] = [".env", ".dds", ".hdr"];
const supportedAudioExtensions: string[] = [".mp3", ".wav", ".wave", ".ogg", ".flac", ".m4a"];
const supportedVideoExtensions: string[] = [".mp4", ".webm", ".ogv", ".mov"];
const supportedModelExtensions: string[] = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"];
const supportedAlembicExtensions: string[] = [".abc"];
const supportedAsepriteExtensions: string[] = [".ase", ".aseprite"];
const supportedFontExtensions: string[] = [".ttf", ".otf", ".woff", ".woff2"];
const supportedAnimationExtensions: string[] = [".animation", ".animations", ".anim", ".animator", ".controller"];
const supportedMaterialExtensions: string[] = [".material", ".mtl"];
const supportedJsonExtensions: string[] = [".material", ".gui", ".cinematic", ".npss", ".ragdoll", ".json"];
const supportedMiscExtensions: string[] = [".3dl", ".exr", ".hdr", ".uxml", ".uss", ".onnx", ".tflite", ".pt2"];

const supportedExtensions: string[] = [
	...supportedImagesExtensions,
	...supportedCubeTexturesExtensions,
	...supportedAudioExtensions,
	...supportedVideoExtensions,
	...supportedModelExtensions,
	...supportedAlembicExtensions,
	...supportedAsepriteExtensions,
	...supportedFontExtensions,
	...supportedAnimationExtensions,
	...supportedMaterialExtensions,
	...supportedJsonExtensions,
	...supportedMiscExtensions,
];

function isUnsupportedImageFormatError(error: unknown): boolean {
	return error instanceof Error && /unsupported image format/i.test(error.message);
}

async function inspectScriptableAudioExportAsset(file: string, projectDir: string): Promise<IScriptableAudioAssetSnapshot | null> {
	if (!file.toLowerCase().endsWith(SCRIPTABLE_AUDIO_GRAPH_SUFFIX)) {
		return null;
	}
	const snapshot = await readScriptableAudioAsset(file);
	if (!snapshot.path.startsWith("assets/")) {
		throw new Error("Audio Generator assets must be stored under the project assets directory to be exported.");
	}
	const unavailable = snapshot.dependencies.find((dependency) => dependency.status !== "current");
	if (!snapshot.runtimeFingerprint || unavailable) {
		throw new Error(`Audio Generator dependency is not build-ready: ${unavailable?.path ?? "unknown"}${unavailable?.message ? ` (${unavailable.message})` : ""}.`);
	}
	for (const dependency of snapshot.dependencies) {
		const normalizedPath = normalize(dependency.path);
		if (!normalizedPath.startsWith("assets/") || (await readAssetMetadata(join(projectDir, normalizedPath))).importer.settings.includeInBuild === false) {
			throw new Error(`Audio Generator dependency is outside the build asset scope or excluded from the build: ${dependency.path}.`);
		}
	}
	return snapshot;
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
			runtime.sourceFontPath,
			runtime.manifestPath,
			...(Array.isArray(runtime.result?.pages) ? runtime.result.pages.map((page: { path?: unknown }) => page?.path) : []),
		];
		const paths = [...new Set(candidates.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate)).filter((path): path is string => path !== null))];
		await Promise.all(paths.map((path) => remove(path)));
	} catch {
		// Missing or malformed generated metadata is safely ignored.
	}
	await remove(runtimePath);
}

async function generatedVideoOutputPath(runtimePath: string, outputRoot: string): Promise<string | null> {
	try {
		const runtime = await readJSON(runtimePath);
		return safeGeneratedAssetPath(outputRoot, runtime.outputPath);
	} catch {
		return null;
	}
}

async function removeGeneratedVideoAssets(runtimePath: string, outputRoot: string): Promise<void> {
	const outputPath = await generatedVideoOutputPath(runtimePath, outputRoot);
	if (outputPath) {
		await remove(outputPath);
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
			runtime.sourceFontPath,
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
	const metadata = await readAssetMetadata(file);
	const importer = metadata.importer;
	const finalPath = join(options.scenePath, relativePath);
	const asepriteGuid = importer.kind === "aseprite" ? normalizeAsepriteBuildGuid(metadata.guid, relativePath) : null;
	if (importer.settings.includeInBuild === false) {
		delete options.cache[relativePath];
		if (importer.kind === "texture") {
			await removeGeneratedTextureAssets(`${finalPath}.bjstexture.json`, options.scenePath);
		}
		if (importer.kind === "font") {
			await removeGeneratedFontAssets(`${finalPath}.bjsfont.json`, options.scenePath);
		}
		if (importer.kind === "video") {
			await removeGeneratedVideoAssets(`${finalPath}.bjsvideo.json`, options.scenePath);
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
		if (importer.kind === "alembic") {
			await remove(`${finalPath}.bjsalembic.json`);
		}
		if (importer.kind === "aseprite") {
			await removeAsepriteBuildOutput(finalPath, options.scenePath, asepriteGuid!);
		}
		if (importer.kind === "aiModel") {
			await removeRuntimeAiOutput(finalPath, options.scenePath);
		}
		if (importer.kind !== "aiModel" && importer.kind !== "aseprite") {
			await remove(finalPath);
		}
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
	const scriptableAudio = await inspectScriptableAudioExportAsset(file, options.projectDir);
	const runtimeAi = importer.kind === "aiModel" ? await inspectRuntimeAiExportAsset(file) : null;
	// The shared inspection lease includes every recursively bound tileset, so dependency-only edits invalidate normal Editor build caches.
	const aseprite = importer.kind === "aseprite" ? await inspectAsepriteBuildSource(file, options.projectDir, importer.settings) : null;
	const modelSettings = importer.kind === "model" ? normalizeModelImporterSettings(importer.settings) : null;
	const modelSourceFingerprint = modelSettings ? await getModelImporterSourceFingerprint(file, modelSettings) : null;
	const targetPlatform = options.assetPlatform ?? options.modelPlatform ?? "default";
	const hash = `${fileStat.mtimeMs}:${JSON.stringify(importer)}${modelSourceFingerprint ? `:${modelSourceFingerprint}` : ""}${scriptableAudio ? `:audio-generator:${scriptableAudio.runtimeFingerprint}` : ""}${runtimeAi ? `:runtime-ai:${runtimeAi.fingerprint}` : ""}${aseprite ? `:aseprite:${aseprite.fingerprint}` : ""}${
		importer.kind === "model" || importer.kind === "texture" || importer.kind === "video" ? `:platform:${targetPlatform}` : ""
	}`;

	isNewFile = !options.cache[relativePath] || options.cache[relativePath] !== hash;

	options.cache[relativePath] = hash;

	const textureSettings = importer.kind === "texture" && supportedImagesExtensions.includes(extension) ? normalizeTextureImporterSettings(importer.settings) : null;
	const effectiveTextureSettings = textureSettings ? resolveTextureImporterPlatformSettings(textureSettings, targetPlatform).settings : null;
	const videoSettings = importer.kind === "video" ? normalizeVideoImporterSettings(importer.settings) : null;
	const effectiveVideoSettings = videoSettings ? resolveVideoImporterPlatformSettings(videoSettings, targetPlatform).settings : null;
	const expectedTexturePath = effectiveTextureSettings
		? join(dirname(finalPath), `${basename(finalPath, extname(finalPath))}${textureImporterOutputExtension(file, effectiveTextureSettings)}`)
		: finalPath;
	const expectedVideoPath = effectiveVideoSettings
		? join(dirname(finalPath), `${basename(finalPath, extname(finalPath))}${videoImporterOutputExtension(file, effectiveVideoSettings)}`)
		: finalPath;
	const audioRuntimePath = `${finalPath}.bjsaudio.json`;
	const textureRuntimePath = `${finalPath}.bjstexture.json`;
	const videoRuntimePath = `${finalPath}.bjsvideo.json`;
	const fontRuntimePath = `${finalPath}.bjsfont.json`;
	const materialRuntimePath = `${finalPath}.bjsmaterial.json`;
	const modelRuntimePath = `${finalPath}.bjsmodel.json`;
	const animationRuntimePath = `${finalPath}.bjsanimation.json`;
	const alembicRuntimePath = `${finalPath}.bjsalembic.json`;
	const runtimeAiManifestPath = `${finalPath}.bjsai.json`;
	const runtimeAiOutputCurrent = runtimeAi ? await runtimeAiOutputIsCurrent(finalPath, options.scenePath, runtimeAi) : false;
	const asepriteOutputCurrent = aseprite
		? await asepriteBuildOutputIsCurrent(aseprite, { projectRoot: options.projectDir, outputRoot: options.scenePath, destination: finalPath, guid: asepriteGuid! })
		: false;
	const finalPathExists =
		importer.kind === "texture"
			? await generatedTextureAssetsExist(textureRuntimePath, options.scenePath)
			: importer.kind === "font"
				? await generatedFontAssetsExist(fontRuntimePath, options.scenePath)
				: importer.kind === "aiModel"
					? runtimeAiOutputCurrent
					: importer.kind === "aseprite"
						? asepriteOutputCurrent
						: await pathExists(importer.kind === "video" ? expectedVideoPath : finalPath);
	const materialOutputCurrent =
		importer.kind !== "material" ||
		((await pathExists(finalPath)) && (await pathExists(materialRuntimePath)) && (await generatedMaterialAssetsExist(materialRuntimePath, options.scenePath)));
	const modelOutputCurrent =
		importer.kind !== "model" ||
		((await pathExists(finalPath)) && (await pathExists(modelRuntimePath)) && (await generatedModelAssetsExist(modelRuntimePath, options.scenePath)));
	const animationOutputCurrent = importer.kind !== "animation" || ((await pathExists(finalPath)) && (await pathExists(animationRuntimePath)));
	const alembicOutputCurrent = importer.kind !== "alembic" || (await alembicOutputIsCurrent(finalPath, alembicRuntimePath, relativePath));
	let exportedFilePath = importer.kind === "texture" ? expectedTexturePath : importer.kind === "video" ? expectedVideoPath : finalPath;
	let textureExportedPaths: string[] = [];
	let fontExportedPaths: string[] = [];
	let materialExportedPaths: string[] = [];
	let modelExportedPaths: string[] = [];
	let alembicExportedPaths: string[] = [];
	let runtimeAiExportedPaths: string[] = [];
	let asepriteExportedPaths: string[] = [];

	if (
		isNewFile ||
		!finalPathExists ||
		!materialOutputCurrent ||
		!modelOutputCurrent ||
		!animationOutputCurrent ||
		!alembicOutputCurrent ||
		(importer.kind === "aseprite" && !asepriteOutputCurrent) ||
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
				version: 2,
				outputPath: portablePath(result.outputPath),
				textureType: result.settings.textureType,
				colorSpace: result.effectiveColorSpace,
				alphaSource: result.settings.alphaSource,
				generateMipmaps: result.settings.generateMipmaps,
				filterMode: result.settings.filterMode,
				wrapModeU: result.settings.wrapModeU,
				wrapModeV: result.settings.wrapModeV,
				anisoLevel: result.settings.anisoLevel,
				sprite: result.sprite,
				processing: result.processing,
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
		} else if (runtimeAi) {
			runtimeAiExportedPaths = await exportRuntimeAiAsset(file, finalPath, options.scenePath, runtimeAi);
		} else if (aseprite) {
			const result = await exportAsepriteBuildAsset(aseprite, {
				projectRoot: options.projectDir,
				outputRoot: options.scenePath,
				destination: finalPath,
				guid: asepriteGuid!,
				expectedFingerprint: aseprite.fingerprint,
			});
			asepriteExportedPaths = result.exportedPaths;
		} else if (scriptableAudio) {
			await writeJSON(finalPath, scriptableAudio.graph, { spaces: "\t", encoding: "utf-8" });
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
			const previousOutputPath = await generatedVideoOutputPath(videoRuntimePath, options.scenePath);
			const result = await processVideoImporterOutput(file, finalPath, videoSettings, editor, targetPlatform);
			if (previousOutputPath && previousOutputPath !== result.outputPath) {
				await remove(previousOutputPath);
			}
			exportedFilePath = result.outputPath;
			const outputRelativePath = result.outputPath.replace(`${options.scenePath}/`, "");
			await writeJSON(
				videoRuntimePath,
				{
					version: 2,
					platform: result.platform,
					compatibility: result.compatibility,
					encoder: result.encoder,
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
			const sourceFontRelativePath = result.sourceFontPath?.replace(`${options.scenePath}/`, "") ?? dynamicFontRelativePath;
			await writeJSON(
				fontRuntimePath,
				{
					version: 1,
					renderMode: result.renderMode,
					family: result.family,
					manifestPath: manifestRelativePath,
					dynamicFontPath: dynamicFontRelativePath,
					sourceFontPath: sourceFontRelativePath,
					result: {
						...result,
						sourcePath: relativePath,
						outputDirectory: dirname(manifestRelativePath),
						manifestPath: manifestRelativePath,
						pages: result.pages.map((page) => ({ ...page, path: page.path.replace(`${options.scenePath}/`, "") })),
						dynamicFontPath: dynamicFontRelativePath,
						sourceFontPath: sourceFontRelativePath,
					},
				},
				{ spaces: "\t" }
			);
			fontExportedPaths = [
				...new Set([
					...(result.dynamicFontPath ? [result.dynamicFontPath] : []),
					...(result.sourceFontPath ? [result.sourceFontPath] : []),
					result.manifestPath,
					...result.pages.map((page) => page.path),
					fontRuntimePath,
				]),
			];
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
		} else if (importer.kind === "alembic" && supportedAlembicExtensions.includes(extension)) {
			const result = await convertAlembicFileToCache(file, { settings: normalizeAlembicImporterSettings(importer.settings) });
			await writeFile(finalPath, result.content);
			const cacheSha256 = createHash("sha256").update(result.content).digest("hex");
			await writeJSON(
				alembicRuntimePath,
				{
					version: 1,
					format: result.manifest.format,
					cacheSha256,
					outputPath: relativePath,
					source: result.manifest.source,
					settingsSha256: result.manifest.settingsSha256,
					manifest: result.manifest,
				},
				{ spaces: "\t" }
			);
			alembicExportedPaths = [finalPath, alembicRuntimePath];
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

	if (runtimeAi) {
		if (!runtimeAiExportedPaths.length) {
			const manifest = await readJSON(runtimeAiManifestPath);
			runtimeAiExportedPaths = [
				finalPath,
				...runtimeAi.externalData.map((value) => join(dirname(finalPath), value.path)),
				...(manifest.liteRtWasmPath
					? (await readdir(join(options.scenePath, manifest.liteRtWasmPath))).map((name) => join(options.scenePath, manifest.liteRtWasmPath, name))
					: []),
				runtimeAiManifestPath,
			];
		}
		options.exportedAssets.push(...runtimeAiExportedPaths);
	} else if (aseprite) {
		if (!asepriteExportedPaths.length) {
			// Re-entering the shared exporter validates all five cached outputs and returns their exact package paths without duplicating generation logic here.
			const result = await exportAsepriteBuildAsset(aseprite, {
				projectRoot: options.projectDir,
				outputRoot: options.scenePath,
				destination: finalPath,
				guid: asepriteGuid!,
				expectedFingerprint: aseprite.fingerprint,
			});
			asepriteExportedPaths = result.exportedPaths;
		}
		options.exportedAssets.push(...asepriteExportedPaths);
	} else if (textureSettings) {
		if (!textureExportedPaths.length) {
			textureExportedPaths = [...((await generatedTextureAssets(textureRuntimePath, options.scenePath)) ?? []), textureRuntimePath];
		}
		options.exportedAssets.push(...textureExportedPaths);
	} else if (importer.kind === "font" && supportedFontExtensions.includes(extension)) {
		if (!fontExportedPaths.length) {
			const runtime = await readJSON(fontRuntimePath);
			fontExportedPaths = [
				...(runtime.dynamicFontPath ? [join(options.scenePath, runtime.dynamicFontPath)] : []),
				...(runtime.sourceFontPath && runtime.sourceFontPath !== runtime.dynamicFontPath ? [join(options.scenePath, runtime.sourceFontPath)] : []),
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
	} else if (importer.kind === "alembic" && supportedAlembicExtensions.includes(extension)) {
		if (!alembicExportedPaths.length) {
			alembicExportedPaths = [finalPath, alembicRuntimePath];
		}
		options.exportedAssets.push(...alembicExportedPaths);
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
	} else if (importer.kind === "alembic" && supportedAlembicExtensions.includes(extension)) {
		// Alembic cache and evidence sidecar are added together above.
	}

	if (options.optimize) {
		const compressionSources =
			importer.kind === "alembic" || importer.kind === "aseprite"
				? []
				: textureSettings
					? textureExportedPaths.filter((path) => supportedImagesExtensions.includes(extname(path).toLowerCase()))
					: [finalPath];
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

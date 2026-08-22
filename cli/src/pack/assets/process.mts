import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path/posix";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import fs from "fs-extra";

import { compressFileToKtx } from "./ktx.mjs";
import { compressFileToKtx2 } from "./ktx2.mjs";
import { ICreateAssetsOptions } from "./assets.mjs";
import { processExportedMaterial, processExportedMaterialImporter } from "./material.mjs";
import { processExportedNodeParticleSystemSet } from "./particle-system.mjs";
import { EditorProjectCompressedTextureSoftware, processExportedTexture } from "./texture.mjs";
import {
	normalizeAssetImporterConfiguration,
	normalizeAlembicImporterSettings,
	normalizeAudioImporterSettings,
	normalizeAnimationImporterSettings,
	normalizeFontImporterSettings,
	normalizeMaterialImporterSettings,
	normalizeModelImporterSettings,
	filterModelMaterialSearchPaths,
	getRuntimeAiOnnxExternalDataPaths,
	parseAlembicCache,
	normalizeTextureImporterSettings,
	normalizeVideoImporterSettings,
	resolveTextureImporterPlatformSettings,
	resolveVideoImporterPlatformSettings,
	SCRIPTABLE_AUDIO_GRAPH_SUFFIX,
	textureImporterOutputExtension,
	videoImporterOutputExtension,
} from "babylonjs-editor-tools";
import { convertAlembicFileToCache } from "../../blender/converter.mjs";
import { processExportedAudio } from "./audio.mjs";
import { processExportedVideo } from "./video.mjs";
import { processExportedFont } from "./font.mjs";
import { processExportedAnimation } from "./animation.mjs";
import { processExportedModel } from "./model.mjs";
import { processImportedTexture } from "./texture-importer.mjs";
import { normalizedGlob } from "../../tools/fs.mjs";
import { inspectScriptableAudioBuildAsset } from "./scriptable-audio.mjs";
import {
	asepriteBuildOutputIsCurrent,
	exportAsepriteBuildAsset,
	inspectAsepriteBuildSource,
	normalizeAsepriteBuildGuid,
	removeAsepriteBuildOutput,
} from "../../aseprite/exporter.mjs";

const require = createRequire(join(process.cwd(), "package.json"));
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
		.update(await fs.readFile(path))
		.digest("hex");
}

async function alembicOutputIsCurrent(outputPath: string, manifestPath: string, relativePath: string): Promise<boolean> {
	try {
		if (!(await fs.pathExists(outputPath)) || !(await fs.pathExists(manifestPath))) {
			return false;
		}
		const content = new Uint8Array(await fs.readFile(outputPath));
		const document = parseAlembicCache(content);
		const manifest = await fs.readJSON(manifestPath);
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
		const manifest = (await fs.readJSON(`${destination}.bjsai.json`)) as Partial<IRuntimeAiBuildManifest>;
		if (Array.isArray(manifest.externalData)) {
			for (const value of manifest.externalData) {
				if (!safeRuntimeAiRelativePath(value?.path)) {
					continue;
				}
				const path = join(dirname(destination), value.path);
				const contained = relative(outputRoot, path);
				let shared = false;
				for (const otherManifestPath of await normalizedGlob(join(outputRoot, "**/*.bjsai.json"), { nodir: true })) {
					if (otherManifestPath === `${destination}.bjsai.json`) {
						continue;
					}
					try {
						const other = (await fs.readJSON(otherManifestPath)) as Partial<IRuntimeAiBuildManifest>;
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
					await fs.remove(path);
				}
			}
		}
	} catch {
		// A missing or malformed prior manifest must not block removal of the owned primary outputs.
	}
	await Promise.all([fs.remove(destination), fs.remove(`${destination}.bjsai.json`)]);
}

async function inspectRuntimeAiBuildAsset(file: string): Promise<IRuntimeAiBuildAsset> {
	const extension = extname(file).toLowerCase();
	const format = extension === ".tflite" ? "litert" : extension === ".pt2" ? "pytorchExport" : "onnx";
	const sourceDetails = await fs.lstat(file).catch(() => null);
	if (!sourceDetails?.isFile() || sourceDetails.isSymbolicLink()) {
		throw new Error("Runtime AI build source must be a regular, non-symbolic-link model file.");
	}
	if (sourceDetails.size < 1 || sourceDetails.size > maximumRuntimeAiBuildBytes) {
		throw new Error("Runtime AI build source must contain from 1 byte through 256 MiB.");
	}
	const bytes = await fs.readFile(file);
	const externalData: IRuntimeAiBuildAsset["externalData"] = [];
	let totalBytes = bytes.byteLength;
	const hash = createHash("sha256").update(bytes);
	const modelSha256 = createHash("sha256").update(bytes).digest("hex");
	if (format === "onnx") {
		const modelDirectory = await fs.realpath(dirname(file));
		for (const path of getRuntimeAiOnnxExternalDataPaths(bytes)) {
			const absolutePath = join(dirname(file), path);
			const details = await fs.lstat(absolutePath).catch(() => null);
			if (!details?.isFile() || details.isSymbolicLink()) {
				throw new Error(`ONNX external-data file is missing or symbolic: ${path}.`);
			}
			const realAbsolutePath = await fs.realpath(absolutePath);
			const contained = relative(modelDirectory, realAbsolutePath);
			if (!contained || contained === ".." || contained.startsWith("../") || isAbsolute(contained)) {
				throw new Error(`ONNX external-data file resolves outside the model directory through a symbolic directory: ${path}.`);
			}
			const data = await fs.readFile(realAbsolutePath);
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
	await fs.copyFile(source, destination);
	const paths = [destination];
	for (const companion of asset.externalData) {
		const output = join(dirname(destination), companion.path);
		await fs.ensureDir(dirname(output));
		await fs.copyFile(companion.absolutePath, output);
		paths.push(output);
	}
	let runtimePaths: string[] = [];
	if (asset.format === "litert") {
		const sourceDirectory = join(dirname(require.resolve("@litertjs/core/package.json")), "wasm");
		const outputDirectory = join(outputRoot, "runtime-ai/litert");
		await fs.copy(sourceDirectory, outputDirectory, { overwrite: true });
		runtimePaths = await normalizedGlob(join(outputDirectory, "*"), { nodir: true });
		paths.push(...runtimePaths);
	}
	const runtimeFiles = await Promise.all(
		runtimePaths.map(async (path) => ({ path: relative(outputRoot, path), bytes: (await fs.stat(path)).size, sha256: await fileSha256(path) }))
	);
	const manifest = `${destination}.bjsai.json`;
	await fs.writeJSON(
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
		const manifest = (await fs.readJSON(`${destination}.bjsai.json`)) as IRuntimeAiBuildManifest;
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
		const hash = createHash("sha256").update(await fs.readFile(destination));
		for (const companion of asset.externalData) {
			const path = join(dirname(destination), companion.path);
			const data = await fs.readFile(path);
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
			const details = await fs.lstat(path);
			if (!details.isFile() || details.isSymbolicLink() || details.size !== runtimeFile.bytes || (await fileSha256(path)) !== runtimeFile.sha256) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export const supportedImagesExtensions: string[] = [".jpg", ".jpeg", ".webp", ".png", ".bmp", ".gif", ".tif", ".tiff", ".tga", ".psd", ".psb", ".svg", ".hdr", ".exr"];
export const supportedCubeTexturesExtensions: string[] = [".env", ".dds", ".hdr"];
export const supportedAudioExtensions: string[] = [".mp3", ".wav", ".wave", ".ogg", ".flac", ".m4a"];
export const supportedVideoExtensions: string[] = [".mp4", ".webm", ".ogv", ".mov"];
export const supportedModelExtensions: string[] = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"];
export const supportedAlembicExtensions: string[] = [".abc"];
export const supportedAsepriteExtensions: string[] = [".ase", ".aseprite"];
export const supportedFontExtensions: string[] = [".ttf", ".otf", ".woff", ".woff2"];
export const supportedAnimationExtensions: string[] = [".animation", ".animations", ".anim", ".animator", ".controller"];
export const supportedMaterialExtensions: string[] = [".material", ".mtl"];
export const supportedJsonExtensions: string[] = [".material", ".gui", ".cinematic", ".npss", ".ragdoll", ".json"];
export const supportedMiscExtensions: string[] = [".3dl", ".exr", ".hdr", ".uxml", ".uss", ".onnx", ".tflite", ".pt2"];

export const supportedExtensions: string[] = [
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
			runtime.sourceFontPath,
			runtime.manifestPath,
			...(Array.isArray(runtime.result?.pages) ? runtime.result.pages.map((page: { path?: unknown }) => page?.path) : []),
		];
		const paths = [...new Set(candidates.map((candidate) => safeGeneratedAssetPath(outputRoot, candidate)).filter((path): path is string => path !== null))];
		await Promise.all(paths.map((path) => fs.remove(path)));
	} catch {
		// Missing or malformed generated metadata is safely ignored.
	}
	await fs.remove(runtimePath);
}

async function generatedVideoOutputPath(runtimePath: string, outputRoot: string): Promise<string | null> {
	try {
		const runtime = await fs.readJSON(runtimePath);
		return safeGeneratedAssetPath(outputRoot, runtime.outputPath);
	} catch {
		return null;
	}
}

async function removeGeneratedVideoAssets(runtimePath: string, outputRoot: string): Promise<void> {
	const outputPath = await generatedVideoOutputPath(runtimePath, outputRoot);
	if (outputPath) {
		await fs.remove(outputPath);
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
			runtime.sourceFontPath,
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
	let assetGuid: unknown = null;
	try {
		const sidecar = `${file}.bjsmeta.json`;
		if (await fs.pathExists(sidecar)) {
			const metadata = await fs.readJSON(sidecar);
			importer = normalizeAssetImporterConfiguration(file, metadata.importer);
			assetGuid = metadata.guid;
		}
	} catch {
		// Invalid importer metadata safely falls back to the type defaults.
	}
	const finalPath = join(options.publicDir, relativePath);
	const asepriteGuid = importer.kind === "aseprite" ? normalizeAsepriteBuildGuid(assetGuid, relativePath) : null;
	if (importer.settings.includeInBuild === false) {
		delete options.cache[relativePath];
		if (importer.kind === "texture") {
			await removeGeneratedTextureAssets(`${finalPath}.bjstexture.json`, options.publicDir);
		}
		if (importer.kind === "font") {
			await removeGeneratedFontAssets(`${finalPath}.bjsfont.json`, options.publicDir);
		}
		if (importer.kind === "video") {
			await removeGeneratedVideoAssets(`${finalPath}.bjsvideo.json`, options.publicDir);
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
		if (importer.kind === "alembic") {
			await fs.remove(`${finalPath}.bjsalembic.json`);
		}
		if (importer.kind === "aseprite") {
			await removeAsepriteBuildOutput(finalPath, options.publicDir, asepriteGuid!);
		}
		if (importer.kind === "aiModel") {
			await removeRuntimeAiOutput(finalPath, options.publicDir);
		}
		if (importer.kind !== "aiModel" && importer.kind !== "aseprite") {
			await fs.remove(finalPath);
		}
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
	const targetPlatform = options.assetPlatform ?? options.modelPlatform ?? "default";
	const scriptableAudio = file.toLowerCase().endsWith(SCRIPTABLE_AUDIO_GRAPH_SUFFIX)
		? await inspectScriptableAudioBuildAsset(file, options.projectDir, options.baseAssetsDir)
		: null;
	const runtimeAi = importer.kind === "aiModel" ? await inspectRuntimeAiBuildAsset(file) : null;
	const aseprite = importer.kind === "aseprite" ? await inspectAsepriteBuildSource(file, options.projectDir, importer.settings) : null;
	const baseHash = `${fileStat.mtimeMs}:${JSON.stringify(importer)}${
		importer.kind === "model" || importer.kind === "texture" || importer.kind === "video" ? `:platform:${targetPlatform}` : ""
	}${scriptableAudio ? `:audio-generator:${scriptableAudio.runtimeFingerprint}` : ""}${runtimeAi ? `:runtime-ai:${runtimeAi.fingerprint}` : ""}${aseprite ? `:aseprite:${aseprite.fingerprint}` : ""}`;
	const modelDependencyFingerprint = importer.kind === "model" ? await generatedModelDependencyFingerprint(`${finalPath}.bjsmodel.json`, options.projectDir) : "";
	const hash = `${baseHash}${modelDependencyFingerprint ? `:${modelDependencyFingerprint}` : ""}`;

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
	const runtimeAiOutputCurrent = runtimeAi ? await runtimeAiOutputIsCurrent(finalPath, options.publicDir, runtimeAi) : false;
	const asepriteOutputCurrent = aseprite
		? await asepriteBuildOutputIsCurrent(aseprite, { projectRoot: options.projectDir, outputRoot: options.publicDir, destination: finalPath, guid: asepriteGuid! })
		: false;
	const finalPathExists =
		importer.kind === "texture"
			? await generatedTextureAssetsExist(textureRuntimePath, options.publicDir)
			: importer.kind === "font"
				? await generatedFontAssetsExist(fontRuntimePath, options.publicDir)
				: importer.kind === "aiModel"
					? runtimeAiOutputCurrent
					: importer.kind === "aseprite"
						? asepriteOutputCurrent
						: await fs.pathExists(importer.kind === "video" ? expectedVideoPath : finalPath);
	const materialOutputCurrent =
		importer.kind !== "material" ||
		((await fs.pathExists(finalPath)) && (await fs.pathExists(materialRuntimePath)) && (await generatedMaterialAssetsExist(materialRuntimePath, options.publicDir)));
	const modelOutputCurrent =
		importer.kind !== "model" ||
		((await fs.pathExists(finalPath)) && (await fs.pathExists(modelRuntimePath)) && (await generatedModelAssetsExist(modelRuntimePath, options.publicDir)));
	const animationOutputCurrent = importer.kind !== "animation" || ((await fs.pathExists(finalPath)) && (await fs.pathExists(animationRuntimePath)));
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
		(importer.kind === "texture" && !(await fs.pathExists(textureRuntimePath))) ||
		(importer.kind === "video" && !(await fs.pathExists(videoRuntimePath))) ||
		(importer.kind === "font" && !(await fs.pathExists(fontRuntimePath)))
	) {
		if (textureSettings) {
			await removeGeneratedTextureAssets(textureRuntimePath, options.publicDir);
			const result = await processImportedTexture(file, finalPath, textureSettings, targetPlatform);
			const portablePath = (path: string | null): string | null => (path ? path.replace(`${options.publicDir}/`, "") : null);
			await fs.writeJSON(
				textureRuntimePath,
				{
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
				},
				{ spaces: "\t" }
			);
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
			runtimeAiExportedPaths = await exportRuntimeAiAsset(file, finalPath, options.publicDir, runtimeAi);
		} else if (aseprite) {
			const result = await exportAsepriteBuildAsset(aseprite, {
				projectRoot: options.projectDir,
				outputRoot: options.publicDir,
				destination: finalPath,
				guid: asepriteGuid!,
				expectedFingerprint: aseprite.fingerprint,
			});
			asepriteExportedPaths = result.exportedPaths;
		} else if (scriptableAudio) {
			await fs.writeJSON(finalPath, scriptableAudio.graph, { spaces: "\t", encoding: "utf-8" });
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
			const previousOutputPath = await generatedVideoOutputPath(videoRuntimePath, options.publicDir);
			const result = await processExportedVideo(file, finalPath, videoSettings, targetPlatform);
			if (previousOutputPath && previousOutputPath !== result.outputPath) {
				await fs.remove(previousOutputPath);
			}
			exportedFilePath = result.outputPath;
			const outputRelativePath = result.outputPath.replace(`${options.publicDir}/`, "");
			await fs.writeJSON(
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
			await removeGeneratedFontAssets(fontRuntimePath, options.publicDir);
			const result = await processExportedFont(file, finalPath, normalizeFontImporterSettings(importer.settings));
			const manifestRelativePath = result.manifestPath.replace(`${options.publicDir}/`, "");
			const dynamicFontRelativePath = result.dynamicFontPath?.replace(`${options.publicDir}/`, "") ?? null;
			const sourceFontRelativePath = result.sourceFontPath?.replace(`${options.publicDir}/`, "") ?? dynamicFontRelativePath;
			await fs.writeJSON(
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
						pages: result.pages.map((page) => ({ ...page, path: page.path.replace(`${options.publicDir}/`, "") })),
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
		} else if (importer.kind === "alembic" && supportedAlembicExtensions.includes(extension)) {
			const result = await convertAlembicFileToCache(file, { settings: normalizeAlembicImporterSettings(importer.settings) });
			await fs.writeFile(finalPath, result.content);
			const cacheSha256 = createHash("sha256").update(result.content).digest("hex");
			await fs.writeJSON(
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

	if (runtimeAi) {
		if (!runtimeAiExportedPaths.length) {
			const manifest = await fs.readJSON(runtimeAiManifestPath);
			runtimeAiExportedPaths = [
				finalPath,
				...runtimeAi.externalData.map((value) => join(dirname(finalPath), value.path)),
				...(manifest.liteRtWasmPath ? await normalizedGlob(join(options.publicDir, manifest.liteRtWasmPath, "*"), { nodir: true }) : []),
				runtimeAiManifestPath,
			];
		}
		options.exportedAssets.push(...runtimeAiExportedPaths);
	} else if (aseprite) {
		if (!asepriteExportedPaths.length) {
			const result = await exportAsepriteBuildAsset(aseprite, {
				projectRoot: options.projectDir,
				outputRoot: options.publicDir,
				destination: finalPath,
				guid: asepriteGuid!,
				expectedFingerprint: aseprite.fingerprint,
			});
			asepriteExportedPaths = result.exportedPaths;
		}
		options.exportedAssets.push(...asepriteExportedPaths);
	} else if (textureSettings) {
		if (!textureExportedPaths.length) {
			textureExportedPaths = [...((await generatedTextureAssets(textureRuntimePath, options.publicDir)) ?? []), textureRuntimePath];
		}
		options.exportedAssets.push(...textureExportedPaths);
	} else if (importer.kind === "font" && supportedFontExtensions.includes(extension)) {
		if (!fontExportedPaths.length) {
			const runtime = await fs.readJSON(fontRuntimePath);
			fontExportedPaths = [
				...(runtime.dynamicFontPath ? [join(options.publicDir, runtime.dynamicFontPath)] : []),
				...(runtime.sourceFontPath && runtime.sourceFontPath !== runtime.dynamicFontPath ? [join(options.publicDir, runtime.sourceFontPath)] : []),
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

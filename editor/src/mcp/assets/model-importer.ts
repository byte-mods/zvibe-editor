import "babylonjs-loaders";

import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path/posix";
import { ensureDir, move, pathExists, readFile, readJSON, realpath, remove, stat, writeJSON } from "fs-extra";

import { LoadAssetContainerAsync, Material, NullEngine, Scene, SceneSerializer } from "babylonjs";
import { convertBlendFileToGlb } from "babylonjs-editor-cli";
import {
	blendRequiresExternalConverter,
	convertAssimpModelFileToGlb,
	configureSerializedModelGeneratedLods,
	emptyExecutedModelImport,
	executeModelImporterEntries,
	filterModelMaterialSearchPaths,
	defaultModelMaterialExtractionFolder,
	IModelMaterialExtractionPlan,
	IModelImporterResult,
	IModelImporterSettings,
	ModelImporterPlatform,
	materialSearchRemaps,
	normalizeModelMaterialExtractionFolder,
	normalizeModelImporterSettings,
	planModelMaterialExtraction,
	planModelMaterialSearch,
	prepareModelImporterSource,
	resolveModelImporterPlatformSettings,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";
import { getIndexedAssetDependencies, readAssetMetadata } from "./registry";

const MAX_MODEL_SOURCE_BYTES = 256 * 1024 * 1024;
const supportedModelExtensions = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"];
const legacyModelExtensions = new Set([".fbx", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"]);
let assimpRuntimePromise: Promise<any> | null = null;

export interface IModelImporterArtifactStatus {
	path: string;
	artifactDirectory: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IModelImporterResult | null;
}

export interface IModelMaterialExtractionStatus extends IModelMaterialExtractionPlan {
	path: string;
	fingerprint: string;
}

export interface IPreparedModelMaterialExtraction {
	status: IModelMaterialExtractionStatus;
	serializedMaterials: Record<string, Record<string, unknown>>;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

async function contentHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolvePromise);
	});
	return hash.digest("hex");
}

/** Hashes the model source and every currently indexed dependency so external buffers/textures invalidate artifacts and builds. */
export async function getModelImporterSourceFingerprint(path: string, settings?: IModelImporterSettings): Promise<string> {
	const hash = createHash("sha256").update(await contentHash(path));
	const hashedDependencies = new Set<string>();
	const hashDependency = async (dependency: string): Promise<void> => {
		if (hashedDependencies.has(dependency)) {
			return;
		}
		hashedDependencies.add(dependency);
		const dependencyPath = join(projectDirectory(), dependency);
		hash.update("\0").update(dependency).update("\0");
		if (await pathExists(dependencyPath)) {
			hash.update(await contentHash(dependencyPath));
		} else {
			hash.update("missing");
		}
	};
	try {
		const dependencies = await getIndexedAssetDependencies(path);
		for (const dependency of [...dependencies.dependencies].sort()) {
			await hashDependency(dependency);
		}
	} catch {
		// A not-yet-indexed model still receives a source-only fingerprint.
	}
	for (const materialPath of [...new Set(settings?.materialRemaps.map((remap) => remap.materialPath) ?? [])].sort()) {
		await hashDependency(materialPath);
		try {
			const dependencies = await getIndexedAssetDependencies(join(projectDirectory(), materialPath));
			for (const dependency of [...dependencies.dependencies].sort()) {
				await hashDependency(dependency);
			}
		} catch {
			// Unindexed replacement materials are still hashed directly above.
		}
	}
	if (settings && settings.materialSearch !== "none") {
		const root = projectDirectory();
		const materialPaths = (await normalizedGlob(join(root, "/**/*.material"), { nodir: true, ignore: ["**/node_modules/**", "**/.bjseditor/**", "**/public/scene/**"] })).map(
			(candidate) => relative(root, candidate.toString()).replace(/\\/g, "/")
		);
		for (const materialPath of filterModelMaterialSearchPaths(relative(root, path).replace(/\\/g, "/"), materialPaths, settings.materialSearch)) {
			await hashDependency(materialPath);
		}
	}
	return hash.digest("hex");
}

async function modelImporterFingerprint(path: string, settings: IModelImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await getModelImporterSourceFingerprint(path, settings))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

function canonicalJsonHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableExtractedMaterialData(value)))
		.digest("hex");
}

function stableExtractedMaterialData(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableExtractedMaterialData);
	}
	if (value && typeof value === "object") {
		const record = { ...(value as Record<string, unknown>) };
		if (
			typeof record.base64String === "string" &&
			record.base64String.startsWith("data:image/") &&
			typeof record.url === "string" &&
			/^data:\d+\/#image\d+$/.test(record.url)
		) {
			record.url = "";
		}
		return Object.fromEntries(
			Object.entries(record)
				.filter(([key]) => key !== "uniqueId")
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stableExtractedMaterialData(child)])
		);
	}
	return value;
}

function validateExtension(path: string): void {
	if (!supportedModelExtensions.includes(extname(path).toLowerCase())) {
		throw new Error(`Model importer supports ${supportedModelExtensions.join(", ")} assets.`);
	}
}

function decodeModelResourceReference(sourcePath: string, reference: string): string | null {
	try {
		const decoded = decodeURIComponent(reference.split(/[?#]/)[0]);
		return extname(sourcePath).toLowerCase() === ".blend" && decoded.startsWith("//") ? decoded.slice(2) : decoded;
	} catch {
		return null;
	}
}

async function resolveContainedResource(sourcePath: string, reference: string, dependencies?: Set<string>): Promise<Uint8Array | null> {
	const decoded = decodeModelResourceReference(sourcePath, reference);
	if (decoded === null) {
		return null;
	}
	const root = await realpath(projectDirectory());
	const candidate = resolve(dirname(sourcePath), decoded);
	if (!(await pathExists(candidate))) {
		return null;
	}
	const canonical = await realpath(candidate);
	const containment = relative(root, canonical);
	if (containment === ".." || containment.startsWith("../")) {
		return null;
	}
	dependencies?.add(containment.replace(/\\/g, "/"));
	return readFile(canonical);
}

function resolveLegacyModelDependency(sourcePath: string, reference: string, dependencies: Set<string>): Uint8Array | null {
	const decoded = decodeModelResourceReference(sourcePath, reference);
	if (decoded === null) {
		return null;
	}
	const candidate = resolve(dirname(sourcePath), decoded);
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		return null;
	}
	const root = realpathSync(projectDirectory());
	const canonical = realpathSync(candidate);
	const containment = relative(root, canonical);
	if (containment === ".." || containment.startsWith("../")) {
		return null;
	}
	dependencies.add(containment.replace(/\\/g, "/"));
	return new Uint8Array(readFileSync(canonical));
}

function boundedModelLoaderError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const sanitized = message.replace(/data:[^\s,]+,[A-Za-z0-9+/=]+/g, "[in-memory model payload]");
	return sanitized.length <= 2048 ? sanitized : `${sanitized.slice(0, 2048)}…`;
}

async function prepareModelSource(
	sourcePath: string,
	source: Uint8Array,
	dependencies: Set<string>
): Promise<{ prepared: Awaited<ReturnType<typeof prepareModelImporterSource>>; legacyConversion: IModelImporterResult["legacyConversion"] }> {
	if (!legacyModelExtensions.has(extname(sourcePath).toLowerCase())) {
		return {
			prepared: await prepareModelImporterSource(sourcePath, source, (reference) => resolveContainedResource(sourcePath, reference, dependencies)),
			legacyConversion: null,
		};
	}
	const extension = extname(sourcePath).toLowerCase();
	const prepareConverted = async (
		content: Uint8Array,
		legacyConversion: NonNullable<IModelImporterResult["legacyConversion"]>
	): Promise<{ prepared: Awaited<ReturnType<typeof prepareModelImporterSource>>; legacyConversion: IModelImporterResult["legacyConversion"] }> => ({
		prepared: await prepareModelImporterSource(`${sourcePath}.glb`, content, (reference) => resolveContainedResource(sourcePath, reference, dependencies), {
			sourceRelativeDoubleSlash: extension === ".blend",
		}),
		legacyConversion,
	});
	const convertWithBlender = async (): Promise<Awaited<ReturnType<typeof prepareConverted>>> => {
		const converted = await convertBlendFileToGlb(sourcePath);
		return prepareConverted(converted.content, {
			engine: "blender",
			inputFileCount: 1,
			inputBytes: source.byteLength,
			outputBytes: converted.outputBytes,
		});
	};
	if (extension === ".blend" && blendRequiresExternalConverter(sourcePath, source)) {
		return convertWithBlender();
	}
	try {
		assimpRuntimePromise ??= require("assimpjs")();
		const converted = convertAssimpModelFileToGlb(await assimpRuntimePromise, { name: basename(sourcePath), content: source }, (reference) =>
			resolveLegacyModelDependency(sourcePath, reference, dependencies)
		);
		return prepareConverted(converted.content, {
			engine: "assimp",
			inputFileCount: converted.inputFileCount,
			inputBytes: converted.inputBytes,
			outputBytes: converted.outputBytes,
		});
	} catch (error) {
		if (extension === ".blend") {
			try {
				return await convertWithBlender();
			} catch (blenderError) {
				throw new Error(
					`Bundled Assimp conversion failed (${error instanceof Error ? error.message : String(error)}); Blender fallback failed (${blenderError instanceof Error ? blenderError.message : String(blenderError)}).`
				);
			}
		}
		throw error;
	}
}

/** Loads raw embedded materials and plans non-overwriting extraction into editable project assets. */
export async function prepareModelMaterialExtraction(path: string, destinationFolder?: string): Promise<IPreparedModelMaterialExtraction> {
	validateExtension(path);
	const details = await stat(path);
	if (details.size > MAX_MODEL_SOURCE_BYTES) {
		throw new Error(`Model importer sources are limited to ${MAX_MODEL_SOURCE_BYTES} bytes.`);
	}
	const root = await realpath(projectDirectory());
	const canonicalSource = await realpath(path);
	const modelPath = relative(root, canonicalSource).replace(/\\/g, "/");
	const folder = destinationFolder ? normalizeModelMaterialExtractionFolder(destinationFolder) : defaultModelMaterialExtractionFolder(modelPath);
	const dependencies = new Set<string>();
	const prepared = await prepareModelSource(canonicalSource, await readFile(canonicalSource), dependencies);
	if (!prepared.prepared.supported || !prepared.prepared.dataUrl) {
		throw new Error(prepared.prepared.errors[0] ?? "The model format cannot be loaded for material extraction.");
	}
	const engine = new NullEngine();
	const scene = new Scene(engine);
	try {
		const container = await LoadAssetContainerAsync(prepared.prepared.dataUrl, scene, { pluginExtension: prepared.prepared.pluginExtension });
		container.addAllToScene();
		const serializedMaterials: Record<string, Record<string, unknown>> = {};
		const hashesByName = new Map<string, string>();
		for (const material of container.materials) {
			const sourceMaterial = material.name.trim();
			if (!sourceMaterial) {
				throw new Error("Every embedded model material must have a non-empty name before it can be extracted and remapped.");
			}
			const serialized = stableExtractedMaterialData(material.serialize()) as Record<string, unknown>;
			const contentHash = canonicalJsonHash(serialized);
			const previousHash = hashesByName.get(sourceMaterial.toLowerCase());
			if (previousHash && previousHash !== contentHash) {
				throw new Error(`Embedded materials named "${sourceMaterial}" contain different data and cannot share one exact-name remap.`);
			}
			if (previousHash) {
				continue;
			}
			hashesByName.set(sourceMaterial.toLowerCase(), contentHash);
			serializedMaterials[sourceMaterial] = serialized;
		}
		if (!Object.keys(serializedMaterials).length) {
			throw new Error("The model contains no extractable embedded materials.");
		}
		const initial = planModelMaterialExtraction(
			Object.entries(serializedMaterials).map(([sourceMaterial, serialized]) => ({ sourceMaterial, contentHash: canonicalJsonHash(serialized) })),
			folder
		);
		const existingAssets = await Promise.all(
			initial.items.map(async (item) => {
				const absolutePath = join(root, item.materialPath);
				if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
					return { path: item.materialPath, contentHash: null };
				}
				try {
					return { path: item.materialPath, contentHash: canonicalJsonHash(await readJSON(absolutePath)) };
				} catch {
					return { path: item.materialPath, contentHash: null };
				}
			})
		);
		const plan = planModelMaterialExtraction(
			Object.entries(serializedMaterials).map(([sourceMaterial, serialized]) => ({ sourceMaterial, contentHash: canonicalJsonHash(serialized) })),
			folder,
			existingAssets.filter((asset) => asset.contentHash !== null || (initial.items.some((item) => item.materialPath === asset.path) && existsSync(join(root, asset.path))))
		);
		const fingerprint = createHash("sha256")
			.update(await getModelImporterSourceFingerprint(canonicalSource))
			.update("\0")
			.update(JSON.stringify(plan))
			.digest("hex");
		return { status: { ...plan, path: modelPath, fingerprint }, serializedMaterials };
	} finally {
		scene.dispose();
		engine.dispose();
	}
}

/** Inspects exact extraction targets, reuse opportunities, and collisions without modifying project files. */
export async function getModelMaterialExtractionStatus(path: string, destinationFolder?: string): Promise<IModelMaterialExtractionStatus> {
	return (await prepareModelMaterialExtraction(path, destinationFolder)).status;
}

async function loadModelMaterialRemaps(scene: Scene, settings: IModelImporterSettings, dependencies: Set<string>): Promise<Record<string, Material>> {
	const result: Record<string, Material> = {};
	const root = await realpath(projectDirectory());
	for (const materialPath of [...new Set(settings.materialRemaps.map((remap) => remap.materialPath))]) {
		dependencies.add(materialPath);
		const candidate = resolve(root, materialPath);
		if (!(await pathExists(candidate))) {
			continue;
		}
		const canonical = await realpath(candidate);
		const containment = relative(root, canonical);
		if (containment === ".." || containment.startsWith("../") || (await stat(canonical)).isDirectory()) {
			continue;
		}
		try {
			const data = await readJSON(canonical);
			const material = Material.Parse(data, scene, "");
			if (!material) {
				continue;
			}
			result[materialPath] = material;
		} catch {
			// Shared execution reports the exact source name and material path that failed to load.
		}
	}
	return result;
}

async function resolveAutomaticMaterialSearch(
	sourcePath: string,
	materials: Material[],
	settings: IModelImporterSettings
): Promise<{
	settings: IModelImporterSettings;
	result: ReturnType<typeof planModelMaterialSearch>;
}> {
	const root = await realpath(projectDirectory());
	const modelPath = relative(root, await realpath(sourcePath)).replace(/\\/g, "/");
	const materialPaths = (await normalizedGlob(join(root, "/**/*.material"), { nodir: true, ignore: ["**/node_modules/**", "**/.bjseditor/**", "**/public/scene/**"] })).map(
		(candidate) => relative(root, candidate.toString()).replace(/\\/g, "/")
	);
	const sources = [...new Set(materials.map((material) => material.name).filter(Boolean))].sort().map((sourceMaterial) => {
		const material = materials.find((candidate) => candidate.name === sourceMaterial)!;
		const texture = material.getActiveTextures()[0];
		const texturePath = String(texture?.name || (texture as any)?.url || "").split(/[?#]/)[0];
		return { sourceMaterial, baseTextureName: texturePath ? basename(texturePath, extname(texturePath)) : null };
	});
	const result = planModelMaterialSearch(modelPath, sources, materialPaths, settings.materialNaming, settings.materialSearch);
	return { settings: { ...settings, materialRemaps: [...settings.materialRemaps, ...materialSearchRemaps(result, settings.materialRemaps)] }, result };
}

/** Loads a self-contained model through Babylon, executes every supported importer setting, and serializes a portable Babylon model. */
export async function processModelImporterOutput(
	sourcePath: string,
	requestedOutputPath: string,
	settings: IModelImporterSettings,
	requestedPlatform: ModelImporterPlatform = "default"
): Promise<IModelImporterResult> {
	validateExtension(sourcePath);
	const resolution = resolveModelImporterPlatformSettings(settings, requestedPlatform);
	const effectiveSettings = resolution.settings;
	const details = await stat(sourcePath);
	if (details.size > MAX_MODEL_SOURCE_BYTES) {
		throw new Error(`Model importer sources are limited to ${MAX_MODEL_SOURCE_BYTES} bytes.`);
	}
	const source = await readFile(sourcePath);
	const dependencies = new Set<string>();
	let prepared: Awaited<ReturnType<typeof prepareModelImporterSource>>;
	let legacyConversion: IModelImporterResult["legacyConversion"] = null;
	try {
		const result = await prepareModelSource(sourcePath, source, dependencies);
		prepared = result.prepared;
		legacyConversion = result.legacyConversion;
	} catch (error) {
		const empty = emptyExecutedModelImport(effectiveSettings, [`Legacy model conversion failed: ${error instanceof Error ? error.message : String(error)}`]);
		return {
			...empty,
			baseSettings: settings,
			platform: resolution.platform,
			platformOverrideApplied: resolution.overrideApplied,
			sourcePath,
			outputPath: null,
			sourceFormat: extname(sourcePath).toLowerCase().slice(1),
			sourceBytes: details.size,
			supported: true,
			embeddedResourceCount: 0,
			dependencyPaths: [],
			legacyConversion: null,
			valid: false,
		};
	}
	if (!prepared.supported || !prepared.dataUrl) {
		const empty = emptyExecutedModelImport(effectiveSettings, prepared.errors, prepared.warnings);
		return {
			...empty,
			baseSettings: settings,
			platform: resolution.platform,
			platformOverrideApplied: resolution.overrideApplied,
			sourcePath,
			outputPath: null,
			sourceFormat: extname(sourcePath).toLowerCase().slice(1),
			sourceBytes: details.size,
			supported: false,
			embeddedResourceCount: prepared.embeddedResourceCount,
			dependencyPaths: [...dependencies].sort(),
			legacyConversion,
			valid: false,
		};
	}
	const engine = new NullEngine();
	const scene = new Scene(engine);
	try {
		const loaded = await LoadAssetContainerAsync(prepared.dataUrl, scene, { pluginExtension: prepared.pluginExtension });
		loaded.addAllToScene();
		const searched = await resolveAutomaticMaterialSearch(sourcePath, loaded.materials, effectiveSettings);
		const materialRemapMaterials = await loadModelMaterialRemaps(scene, searched.settings, dependencies);
		const executed = await executeModelImporterEntries(
			{
				meshes: loaded.meshes,
				transformNodes: loaded.transformNodes,
				materials: loaded.materials,
				multiMaterials: loaded.multiMaterials,
				materialRemapMaterials,
				materialSearch: searched.result,
				textures: loaded.textures,
				animationGroups: loaded.animationGroups,
				skeletonCount: loaded.skeletons.length,
				skeletons: loaded.skeletons,
			},
			searched.settings
		);
		await ensureDir(dirname(requestedOutputPath));
		const serialized = await SceneSerializer.SerializeAsync(scene);
		configureSerializedModelGeneratedLods(serialized, scene, (meshes) => SceneSerializer.SerializeMesh(meshes));
		await writeJSON(requestedOutputPath, serialized, { spaces: "\t" });
		const errors = [...new Set([...prepared.errors, ...executed.errors])];
		return {
			...executed,
			settings: effectiveSettings,
			baseSettings: settings,
			platform: resolution.platform,
			platformOverrideApplied: resolution.overrideApplied,
			errors,
			warnings: [...new Set([...prepared.warnings, ...executed.warnings])],
			sourcePath,
			outputPath: requestedOutputPath,
			sourceFormat: extname(sourcePath).toLowerCase().slice(1),
			sourceBytes: details.size,
			supported: true,
			embeddedResourceCount: prepared.embeddedResourceCount,
			dependencyPaths: [...dependencies].sort(),
			legacyConversion,
			valid: errors.length === 0,
		};
	} catch (error) {
		const message = boundedModelLoaderError(error);
		const empty = emptyExecutedModelImport(effectiveSettings, [`Model loader failed: ${message}`], prepared.warnings);
		return {
			...empty,
			baseSettings: settings,
			platform: resolution.platform,
			platformOverrideApplied: resolution.overrideApplied,
			sourcePath,
			outputPath: null,
			sourceFormat: extname(sourcePath).toLowerCase().slice(1),
			sourceBytes: details.size,
			supported: true,
			embeddedResourceCount: prepared.embeddedResourceCount,
			dependencyPaths: [...dependencies].sort(),
			legacyConversion,
			valid: false,
		};
	} finally {
		scene.dispose();
		engine.dispose();
	}
}

async function artifactPaths(path: string): Promise<{ artifactDirectory: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const artifactDirectory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactDirectory, manifestPath: join(artifactDirectory, "model-import.json") };
}

export async function getModelImporterArtifactStatus(path: string): Promise<IModelImporterArtifactStatus> {
	validateExtension(path);
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model importer artifacts are only available for model assets.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const fingerprint = await modelImporterFingerprint(path, settings);
	const { artifactDirectory, manifestPath } = await artifactPaths(path);
	let result: IModelImporterResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result;
		}
	} catch {
		// Missing or malformed manifests make the artifact stale.
	}
	const exists = result?.outputPath ? await pathExists(result.outputPath) : await pathExists(artifactDirectory);
	return { path, artifactDirectory, manifestPath, fingerprint, current: result !== null && exists, exists, result };
}

export async function applyModelImporterArtifact(path: string, expectedFingerprint: string): Promise<IModelImporterArtifactStatus> {
	const status = await getModelImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Model importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const temporaryDirectory = `${status.artifactDirectory}.tmp-${process.pid}-${Date.now()}`;
	await remove(temporaryDirectory);
	try {
		await ensureDir(temporaryDirectory);
		const outputPath = join(temporaryDirectory, `${basename(path, extname(path))}.babylon`);
		const generated = await processModelImporterOutput(path, outputPath, settings);
		await remove(status.artifactDirectory);
		await ensureDir(dirname(status.artifactDirectory));
		await move(temporaryDirectory, status.artifactDirectory, { overwrite: true });
		const result = {
			...generated,
			outputPath: generated.outputPath?.replace(temporaryDirectory, status.artifactDirectory) ?? null,
		};
		await writeJSON(status.manifestPath, { version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporaryDirectory).catch(() => undefined);
		throw error;
	}
}

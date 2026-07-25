import "babylonjs-loaders";

import { basename, dirname, extname, join, relative, resolve } from "node:path/posix";

import assimpFactory from "assimpjs";
import { LoadAssetContainerAsync, Material, NullEngine, Scene, SceneSerializer } from "babylonjs";
import fs from "fs-extra";
import {
	convertAssimpModelFileToGlb,
	blendRequiresExternalConverter,
	configureSerializedModelGeneratedLods,
	emptyExecutedModelImport,
	executeModelImporterEntries,
	filterModelMaterialSearchPaths,
	IModelImporterResult,
	IModelImporterSettings,
	ModelImporterPlatform,
	materialSearchRemaps,
	planModelMaterialSearch,
	prepareModelImporterSource,
	resolveModelImporterPlatformSettings,
} from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs.mjs";
import { convertBlendFileToGlb } from "../../blender/converter.mjs";

const MAX_MODEL_SOURCE_BYTES = 256 * 1024 * 1024;
const supportedModelExtensions = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"];
const legacyModelExtensions = new Set([".fbx", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"]);
let assimpRuntimePromise: Promise<any> | null = null;

function decodeModelResourceReference(sourcePath: string, reference: string): string | null {
	try {
		const decoded = decodeURIComponent(reference.split(/[?#]/)[0]);
		return extname(sourcePath).toLowerCase() === ".blend" && decoded.startsWith("//") ? decoded.slice(2) : decoded;
	} catch {
		return null;
	}
}

async function resolveContainedResource(projectRoot: string, sourcePath: string, reference: string, dependencies?: Set<string>): Promise<Uint8Array | null> {
	const decoded = decodeModelResourceReference(sourcePath, reference);
	if (decoded === null) {
		return null;
	}
	const root = await fs.realpath(projectRoot);
	const candidate = resolve(dirname(sourcePath), decoded);
	if (!(await fs.pathExists(candidate))) {
		return null;
	}
	const canonical = await fs.realpath(candidate);
	const containment = relative(root, canonical);
	if (containment === ".." || containment.startsWith("../")) {
		return null;
	}
	dependencies?.add(containment.replace(/\\/g, "/"));
	return fs.readFile(canonical);
}

function resolveLegacyModelDependency(projectRoot: string, sourcePath: string, reference: string, dependencies: Set<string>): Uint8Array | null {
	const decoded = decodeModelResourceReference(sourcePath, reference);
	if (decoded === null) {
		return null;
	}
	const candidate = resolve(dirname(sourcePath), decoded);
	if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
		return null;
	}
	const root = fs.realpathSync(projectRoot);
	const canonical = fs.realpathSync(candidate);
	const containment = relative(root, canonical);
	if (containment === ".." || containment.startsWith("../")) {
		return null;
	}
	dependencies.add(containment.replace(/\\/g, "/"));
	return new Uint8Array(fs.readFileSync(canonical));
}

async function prepareModelSource(
	projectRoot: string,
	sourcePath: string,
	source: Uint8Array,
	dependencies: Set<string>
): Promise<{ prepared: Awaited<ReturnType<typeof prepareModelImporterSource>>; legacyConversion: IModelImporterResult["legacyConversion"] }> {
	if (!legacyModelExtensions.has(extname(sourcePath).toLowerCase())) {
		return {
			prepared: await prepareModelImporterSource(sourcePath, source, (reference) => resolveContainedResource(projectRoot, sourcePath, reference, dependencies)),
			legacyConversion: null,
		};
	}
	const extension = extname(sourcePath).toLowerCase();
	const prepareConverted = async (
		content: Uint8Array,
		legacyConversion: NonNullable<IModelImporterResult["legacyConversion"]>
	): Promise<{ prepared: Awaited<ReturnType<typeof prepareModelImporterSource>>; legacyConversion: IModelImporterResult["legacyConversion"] }> => ({
		prepared: await prepareModelImporterSource(`${sourcePath}.glb`, content, (reference) => resolveContainedResource(projectRoot, sourcePath, reference, dependencies), {
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
		assimpRuntimePromise ??= assimpFactory();
		const converted = convertAssimpModelFileToGlb(await assimpRuntimePromise, { name: basename(sourcePath), content: source }, (reference) =>
			resolveLegacyModelDependency(projectRoot, sourcePath, reference, dependencies)
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

async function loadModelMaterialRemaps(scene: Scene, settings: IModelImporterSettings, projectRoot: string, dependencies: Set<string>): Promise<Record<string, Material>> {
	const result: Record<string, Material> = {};
	const root = await fs.realpath(projectRoot);
	for (const materialPath of [...new Set(settings.materialRemaps.map((remap) => remap.materialPath))]) {
		dependencies.add(materialPath);
		const candidate = resolve(root, materialPath);
		if (!(await fs.pathExists(candidate))) {
			continue;
		}
		const canonical = await fs.realpath(candidate);
		const containment = relative(root, canonical);
		if (containment === ".." || containment.startsWith("../") || (await fs.stat(canonical)).isDirectory()) {
			continue;
		}
		try {
			const material = Material.Parse(await fs.readJSON(canonical), scene, "");
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
	settings: IModelImporterSettings,
	projectRoot: string
): Promise<{
	settings: IModelImporterSettings;
	result: ReturnType<typeof planModelMaterialSearch>;
	searchedPaths: string[];
}> {
	const root = await fs.realpath(projectRoot);
	const modelPath = relative(root, await fs.realpath(sourcePath)).replace(/\\/g, "/");
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
	return {
		settings: { ...settings, materialRemaps: [...settings.materialRemaps, ...materialSearchRemaps(result, settings.materialRemaps)] },
		result,
		searchedPaths: filterModelMaterialSearchPaths(modelPath, materialPaths, settings.materialSearch),
	};
}

/** Executes the same headless Babylon model conversion used by the editor artifact/build path. */
export async function processExportedModel(
	sourcePath: string,
	outputPath: string,
	settings: IModelImporterSettings,
	projectRoot: string,
	requestedPlatform: ModelImporterPlatform = "default"
): Promise<IModelImporterResult> {
	const extension = extname(sourcePath).toLowerCase();
	const resolution = resolveModelImporterPlatformSettings(settings, requestedPlatform);
	const effectiveSettings = resolution.settings;
	if (!supportedModelExtensions.includes(extension)) {
		throw new Error(`Model importer supports ${supportedModelExtensions.join(", ")} assets.`);
	}
	const details = await fs.stat(sourcePath);
	if (details.size > MAX_MODEL_SOURCE_BYTES) {
		throw new Error(`Model importer sources are limited to ${MAX_MODEL_SOURCE_BYTES} bytes.`);
	}
	const source = await fs.readFile(sourcePath);
	const dependencies = new Set<string>();
	let prepared: Awaited<ReturnType<typeof prepareModelImporterSource>>;
	let legacyConversion: IModelImporterResult["legacyConversion"] = null;
	try {
		const result = await prepareModelSource(projectRoot, sourcePath, source, dependencies);
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
			sourceFormat: extension.slice(1),
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
			sourceFormat: extension.slice(1),
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
		const searched = await resolveAutomaticMaterialSearch(sourcePath, loaded.materials, effectiveSettings, projectRoot);
		searched.searchedPaths.forEach((path) => dependencies.add(path));
		const materialRemapMaterials = await loadModelMaterialRemaps(scene, searched.settings, projectRoot, dependencies);
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
		await fs.ensureDir(dirname(outputPath));
		const serialized = await SceneSerializer.SerializeAsync(scene);
		configureSerializedModelGeneratedLods(serialized, scene, (meshes) => SceneSerializer.SerializeMesh(meshes));
		await fs.writeJSON(outputPath, serialized, { spaces: "\t" });
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
			outputPath,
			sourceFormat: extension.slice(1),
			sourceBytes: details.size,
			supported: true,
			embeddedResourceCount: prepared.embeddedResourceCount,
			dependencyPaths: [...dependencies].sort(),
			legacyConversion,
			valid: errors.length === 0,
		};
	} catch (error) {
		const empty = emptyExecutedModelImport(effectiveSettings, [`Model loader failed: ${error instanceof Error ? error.message : String(error)}`], prepared.warnings);
		return {
			...empty,
			baseSettings: settings,
			platform: resolution.platform,
			platformOverrideApplied: resolution.overrideApplied,
			sourcePath,
			outputPath: null,
			sourceFormat: extension.slice(1),
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

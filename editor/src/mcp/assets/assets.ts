import { dirname, join, isAbsolute, basename, relative, extname, normalize, resolve } from "path/posix";
import { randomUUID } from "crypto";
import { copy, ensureDir, lstat, mkdir, move, pathExists, readFile, readJSON, readdir, realpath, remove, stat, writeFile, writeJSON } from "fs-extra";

import { Scene } from "babylonjs";
import {
	AssetImporterKind,
	getDefaultAssetImporterConfiguration,
	inferAssetImporterKind,
	IAssetImporterConfiguration,
	listAssetImporterDefinitions,
	normalizeAssetImporterConfiguration,
	normalizeModelAnimationClipDefinitions,
	normalizeModelAuthoredLodGroups,
	normalizeModelLodDefinitions,
	normalizeModelMaterialRemaps,
	normalizeModelImporterSettings,
	normalizeModelImporterPlatformOverrides,
	normalizeTextureImporterPlatformOverrides,
	normalizeVideoImporterPlatformOverrides,
	resolveModelImporterPlatformSettings,
	resolveTextureImporterPlatformSettings,
	resolveVideoImporterPlatformSettings,
	serializeModelAnimationClipDefinitions,
	serializeModelAuthoredLodGroups,
	serializeModelLodDefinitions,
	serializeModelMaterialRemaps,
	serializeModelImporterPlatformOverrides,
	serializeTextureImporterPlatformOverrides,
	serializeVideoImporterPlatformOverrides,
	normalizeTextureImporterSettings,
	normalizeVideoImporterSettings,
	getVideoPlatformCodecMatrix,
	validateAssetImporterConfiguration,
	isImportedAnimatorControllerDocument,
	suggestModelAuthoredLodGroups,
} from "babylonjs-editor-tools";

import { loadImportedSceneFile, tryConvertBlendFileLocally } from "../../editor/layout/preview/import/import";

import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";
import {
	ASSET_META_SUFFIX,
	cancelAssetIndexingJob,
	getAssetDependencyDiagnostics,
	getAssetIndexingStatus,
	getAssetDependencyGraph,
	getAssetRegistryStatus,
	getAssetTypeFromPath,
	getIndexedAssetDependencies,
	getIndexedAssetRecord,
	inspectAssetImportState,
	listAssetDependencyScanners,
	queryAssetRegistry,
	readAssetMetadata,
	rebuildAssetRegistry,
	refreshAssetRegistryPaths,
	startAssetIndexingJob,
	writeAssetMetadata,
} from "./registry";
import { applySemanticAssetMove, inspectSemanticAssetMove } from "./move";
import { AssetDependencyGraphExportFormat, formatAssetDependencyGraph } from "./dependency-graph";
import { openAssetDependencyGraph as openAssetDependencyGraphTab } from "../../editor/layout/assets-browser/dependency-graph";
import { applyAudioImporterArtifact, getAudioImporterArtifactStatus } from "./audio-importer";
import { applyVideoImporterArtifact, getVideoEncoderCapabilities, getVideoImporterArtifactStatus } from "./video-importer";
import { applyFontImporterArtifact, getFontImporterArtifactStatus } from "./font-importer";
import { applyMaterialImporterArtifact, getMaterialImporterArtifactStatus } from "./material-importer";
import { applyAnimationImporterArtifact, getAnimationImporterArtifactStatus } from "./animation-importer";
import { applyTextureImporterArtifact, getTextureImporterArtifactStatus } from "./texture-importer";
import { getFbxExportManifestPath, withFbxAssetDeletion } from "./fbx-export-state";
import { applyPsdLayerExtraction, getPsdLayerExtractionStatus, IPsdLayerExtractionOptions } from "./psd-layers";
import { applyPsdSmartObjectPayloadReplacement, getPsdSmartObjectPayloadReplacementStatus, IPsdSmartObjectPayloadReplacementOptions } from "./psd-smart-object-replacement";
import { applyModelImporterArtifact, getModelImporterArtifactStatus, getModelMaterialExtractionStatus, prepareModelMaterialExtraction } from "./model-importer";
import { getModelTextureExtractionStatus, prepareModelTextureExtraction } from "./model-texture-extraction";
import { FileInspectorObject } from "../../editor/layout/inspector/file";
import { createAnimatorController, setAnimatorController } from "../animator/animator";
import { openProjectImage } from "../../tools/assets/image";
import { cancelAssetThumbnailTasks } from "../../tools/assets/thumbnail";
import { assetRootPlacementError, inspectAssetRootPlacement } from "../../tools/assets/root-placement";
import { getAutoReimportStatus, inspectAutoReimport, removeDeletedPathsFromAutoReimportStatus, runAutoReimport, setAutoReimportSettings } from "./auto-reimport";
import { createImportedUnityAvatarMask, getUnityAnimatorControllerBindingPlan } from "./unity-animator-dependencies";
import {
	getTextureChannelPreviewState,
	clearTextureChannelPreviewStates,
	setTextureChannelPreviewState,
	TEXTURE_CHANNEL_PREVIEW_CHANNELS,
	TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES,
	TEXTURE_CHANNEL_PREVIEW_MAXIMUM_DIMENSION,
} from "./texture-channel-preview";

/**
 * Maps asset types to their associated file extensions (without dot).
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff", ".tga", ".psd", ".psb", ".svg", ".hdr", ".exr"]);
const IMPORTER_PRESETS_PATH = ".bjseditor/importer-presets.json";

function metadataPath(assetPath: string): string {
	return `${assetPath}${ASSET_META_SUFFIX}`;
}

const assetGuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IDeletedAssetArtifacts {
	guids: string[];
	fbxExportEvidencePaths: string[];
	mlTrainingProvenancePaths: string[];
}

/** Captures GUID and FBX-export ownership before recursive deletion makes either identity undiscoverable. */
async function collectDeletedAssetArtifacts(assetPath: string, root: string): Promise<IDeletedAssetArtifacts> {
	const sidecars: string[] = [];
	const fbxAssetPaths: string[] = [];
	const mlTrainingProvenancePaths: string[] = [];
	const details = await lstat(assetPath);
	if (!details.isDirectory() || details.isSymbolicLink()) {
		sidecars.push(metadataPath(assetPath));
		mlTrainingProvenancePaths.push(`${assetPath}.ml-training.json`);
		if (!details.isSymbolicLink() && extname(assetPath).toLowerCase() === ".fbx") {
			fbxAssetPaths.push(assetPath);
		}
	} else {
		const pending = [assetPath];
		while (pending.length) {
			const directory = pending.pop()!;
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory() && !entry.isSymbolicLink()) {
					pending.push(path);
				} else if (entry.isFile()) {
					if (entry.name.endsWith(ASSET_META_SUFFIX)) {
						sidecars.push(path);
					} else if (entry.name.endsWith(".ml-training.json")) {
						mlTrainingProvenancePaths.push(path);
					} else if (extname(entry.name).toLowerCase() === ".fbx") {
						fbxAssetPaths.push(path);
					}
				}
			}
		}
	}

	const guids = new Set<string>();
	// Read sidecars in bounded batches; deleting a folder of hundreds of assets one read at a time took minutes.
	for (let index = 0; index < sidecars.length; index += 32) {
		const batch = await Promise.all(
			sidecars.slice(index, index + 32).map(async (sidecar) => {
				try {
					return await readJSON(sidecar);
				} catch {
					// Missing or malformed sidecars cannot own a safe importer-artifact directory.
					return null;
				}
			})
		);
		for (const metadata of batch) {
			if (typeof metadata?.guid === "string" && assetGuidPattern.test(metadata.guid)) {
				guids.add(metadata.guid.toLowerCase());
			}
		}
	}
	return {
		guids: [...guids].sort(),
		fbxExportEvidencePaths: fbxAssetPaths.map((path) => getFbxExportManifestPath(root, relative(root, path).replace(/\\/g, "/"))).sort(),
		mlTrainingProvenancePaths: mlTrainingProvenancePaths.sort(),
	};
}

export interface IRemovedAssetArtifacts {
	removedImporterArtifacts: string[];
	removedFbxExportEvidence: string[];
	removedMlTrainingProvenance: string[];
}

/** Removes an asset/folder and all private importer/export evidence under one fence shared with long-running FBX conversions. */
export async function removeAssetPathAndImporterArtifacts(assetPath: string): Promise<IRemovedAssetArtifacts> {
	const deletionProjectDirectory = getProjectDirectory();
	return withFbxAssetDeletion(async () => {
		if (getProjectDirectory() !== deletionProjectDirectory) {
			throw new Error("The open project changed while asset deletion was waiting for an FBX export. Inspect the asset again before deleting it.");
		}
		const artifacts = await collectDeletedAssetArtifacts(assetPath, deletionProjectDirectory);
		await remove(assetPath);
		await remove(metadataPath(assetPath));
		const root = deletionProjectDirectory;
		const artifactRoot = join(root, ".bjseditor/imported-assets");
		const removedImporterArtifacts: string[] = [];
		for (const guid of artifacts.guids) {
			const artifactDirectory = join(artifactRoot, guid);
			if (await pathExists(artifactDirectory)) {
				await remove(artifactDirectory);
				removedImporterArtifacts.push(relative(root, artifactDirectory));
			}
		}
		const removedFbxExportEvidence: string[] = [];
		for (const evidencePath of artifacts.fbxExportEvidencePaths) {
			if (await pathExists(evidencePath)) {
				await remove(evidencePath);
				removedFbxExportEvidence.push(relative(root, evidencePath));
			}
		}
		const removedMlTrainingProvenance: string[] = [];
		for (const provenancePath of artifacts.mlTrainingProvenancePaths) {
			if (await pathExists(provenancePath)) {
				await remove(provenancePath);
				removedMlTrainingProvenance.push(relative(root, provenancePath));
			}
		}
		return { removedImporterArtifacts, removedFbxExportEvidence, removedMlTrainingProvenance };
	});
}

function importerPresetsPath(): string {
	return join(getProjectDirectory(), IMPORTER_PRESETS_PATH);
}

function mergeImporterConfiguration(path: string, existing: IAssetImporterConfiguration, input: unknown, replace: boolean): IAssetImporterConfiguration {
	if (input && typeof input === "object" && !Array.isArray(input) && "version" in input) {
		const validated = validateAssetImporterConfiguration(path, input).configuration;
		return replace ? validated : validateAssetImporterConfiguration(path, { ...existing, settings: { ...existing.settings, ...validated.settings } }).configuration;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("Importer settings must be an object.");
	}
	return validateAssetImporterConfiguration(path, {
		...existing,
		settings: replace ? input : { ...existing.settings, ...(input as Record<string, unknown>) },
	}).configuration;
}

async function readImporterPresets(): Promise<any[]> {
	const path = importerPresetsPath();
	if (!(await pathExists(path))) {
		return [];
	}
	try {
		const presets = await readJSON(path);
		return Array.isArray(presets) ? presets : [];
	} catch {
		return [];
	}
}

async function writeImporterPresets(presets: any[]): Promise<void> {
	const path = importerPresetsPath();
	await mkdir(dirname(path), { recursive: true });
	await writeJSON(path, presets, { spaces: "\t" });
}

/**
 * Returns the asset type associated to the given file extension.
 */
function getAssetTypeFromExtension(extension: string): string | null {
	const type = getAssetTypeFromPath(`asset${extension}`);
	return type === "other" ? null : type;
}

/**
 * Returns the absolute path of the project directory.
 */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	return resolve(dirname(projectConfiguration.path));
}

/**
 * Resolves an absolute path from a project-relative or absolute path.
 */
function resolveProjectPath(path: string): string {
	const projectDirectory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(projectDirectory, path));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("Asset paths must stay inside the open project directory.");
	}

	return absolutePath;
}

/**
 * Refreshes the asset browser after an MCP file operation.
 */
function refreshAssetsBrowser(options: IMCPActionOptions): void {
	// FlexLayout mounts panels lazily. File mutations must also work for
	// external MCP clients while the Assets Browser tab is not mounted.
	options.editor.layout.assets?.refresh?.();
}

/** Reports automatic project asset watcher state and the latest detected external change. */
export function getAssetWatchStatus(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return options.editor.layout.assets.getAssetWatchStatus();
}

/** Forces an immediate refresh of the watched project asset folders. */
export function refreshWatchedAssets(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	options.editor.layout.assets.refreshWatchedAssets();
	return options.editor.layout.assets.getAssetWatchStatus();
}

/** Returns Auto Reimport settings, persisted/current job evidence, and an exact bounded execution plan. */
export async function inspectAutoReimportAction(_scene: Scene, data: any): Promise<any> {
	const [status, plan] = await Promise.all([getAutoReimportStatus(), inspectAutoReimport({ paths: data.paths, force: data.force })]);
	return { ...status, plan };
}

/** Replaces the complete project Auto Reimport configuration under its exact settings lease. */
export async function setAutoReimportSettingsAction(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const result = await setAutoReimportSettings(data.expectedSettingsFingerprint, data.settings);
	await options.editor.layout.assets.refreshAutoReimportWatchers();
	return { updated: true, ...result, watcher: options.editor.layout.assets.getAssetWatchStatus() };
}

/** Executes one exact Auto Reimport plan and refreshes editor/browser evidence. */
export async function runAutoReimportAction(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Running Auto Reimport requires confirm=true.");
	}
	const job = await runAutoReimport(data.expectedFingerprint, { paths: data.paths, force: data.force }, options.editor);
	await options.editor.layout.assets.refreshAutoReimportWatchers();
	refreshAssetsBrowser(options);
	return { executed: true, job, status: await getAutoReimportStatus() };
}

/**
 * Returns whether a folder contains an "editor_preview" image file.
 */
async function folderHasPreview(folder: string): Promise<boolean> {
	try {
		const files = await readdir(folder);
		return files.some((f) => f.startsWith("editor_preview") && (f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".bmp")));
	} catch (e) {
		return false;
	}
}

/**
 * Lists the project assets, optionally filtered by type or folder.
 */
export async function listAssets(_scene: Scene, data: any): Promise<any> {
	const directory = getProjectDirectory();
	const result = await queryAssetRegistry({ ...data, folder: data.folder ?? "assets" });
	const previewCache: Record<string, boolean> = {};
	const assets: any[] = [];
	for (const entry of result.entries) {
		const absolutePath = join(directory, entry.path);
		const folder = dirname(absolutePath);
		if (previewCache[folder] === undefined) {
			previewCache[folder] = await folderHasPreview(folder);
		}
		assets.push({
			name: entry.name,
			path: entry.path,
			type: entry.type,
			guid: entry.guid,
			labels: entry.labels,
			tags: entry.tags,
			favorite: entry.favorite,
			importStatus: entry.importState.status,
			hasPreview: previewCache[folder],
		});
	}
	return {
		assets,
		totalCount: result.totalCount,
		offset: result.offset,
		limit: result.limit,
		hasMore: result.hasMore,
		nextOffset: result.nextOffset,
		duplicateGuidCount: result.duplicateGuidCount,
	};
}

/**
 * Gets filesystem metadata and editor-relevant classification for an asset.
 */
export async function getAssetDetails(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Asset not found: ${data.path}`);
	}

	const details = await stat(absolutePath);
	const isDirectory = details.isDirectory();
	const folder = isDirectory ? absolutePath : dirname(absolutePath);
	const metadata = isDirectory ? null : await readAssetMetadata(absolutePath);

	return {
		name: basename(absolutePath),
		path: relative(getProjectDirectory(), absolutePath),
		isDirectory,
		type: isDirectory ? null : getAssetTypeFromExtension(extname(absolutePath)),
		extension: isDirectory ? null : extname(absolutePath).toLowerCase(),
		sizeBytes: details.size,
		createdAt: details.birthtime.toISOString(),
		modifiedAt: details.mtime.toISOString(),
		hasPreview: await folderHasPreview(folder),
		metadata,
	};
}

/** Finds an asset by its persisted editor GUID without relying on a mutable filesystem path. */
export async function getAssetByGuid(_scene: Scene, data: any): Promise<any> {
	const result = await queryAssetRegistry({ guid: data.guid, limit: 2 });
	if (result.totalCount > 1) {
		throw new Error(`Asset GUID "${data.guid}" is ambiguous. Run asset registry diagnostics and repair duplicate GUIDs explicitly.`);
	}
	const entry = result.entries[0];
	if (entry) {
		return { name: entry.name, path: entry.path, type: entry.type, guid: entry.guid, labels: entry.labels, metadata: await readAssetMetadata(resolveProjectPath(entry.path)) };
	}
	throw new Error(`Asset GUID "${data.guid}" was not found in the open project.`);
}

/** Reports persistent asset registry health and duplicate identity conflicts. */
export async function getPersistentAssetRegistryStatus(): Promise<any> {
	return getAssetRegistryStatus();
}

/** Queries the persistent project asset registry. */
export async function queryPersistentAssetRegistry(_scene: Scene, data: any): Promise<any> {
	return queryAssetRegistry(data);
}

/** Rebuilds the asset registry, optionally repairing duplicate GUIDs after explicit confirmation. */
export async function rebuildPersistentAssetRegistry(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.repairDuplicateGuids && data.confirmRepair !== true) {
		throw new Error("Duplicate GUID repair requires confirmRepair: true.");
	}
	const registry = await rebuildAssetRegistry({ repairDuplicateGuids: data.repairDuplicateGuids === true });
	refreshAssetsBrowser(options);
	return { ...(await getAssetRegistryStatus()), repairedDuplicateGuids: data.repairDuplicateGuids === true, generatedAt: registry.generatedAt };
}

/** Incrementally refreshes one or more project-contained registry paths. */
export async function refreshPersistentAssetRegistryPaths(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const paths = Array.isArray(data.paths) ? data.paths : [];
	if (!paths.length) {
		throw new Error("At least one project-relative path is required.");
	}
	await refreshAssetRegistryPaths(paths);
	refreshAssetsBrowser(options);
	return getAssetRegistryStatus();
}

/** Reports worker availability, active progress, and a bounded recent background-indexing history. */
export async function getBackgroundAssetIndexingStatus(): Promise<any> {
	return getAssetIndexingStatus();
}

/** Starts a non-blocking worker-backed full rebuild or bounded path refresh. */
export function startBackgroundAssetIndexing(_scene: Scene, data: any): any {
	return { started: true, job: startAssetIndexingJob(data) };
}

/** Cooperatively cancels one active job before it can publish a replacement registry. */
export function cancelBackgroundAssetIndexing(_scene: Scene, data: any): any {
	return { cancellationRequested: true, job: cancelAssetIndexingJob(data.jobId) };
}

/**
 * Lists the bounded persistent dependency scanners and their supported extensions.
 */
export function listDependencyScannerTypes(): any {
	return { scanners: listAssetDependencyScanners() };
}

/**
 * Reads persistent direct references extracted by bounded text and binary model scanners.
 */
export async function getAssetDependencies(_scene: Scene, data: any): Promise<any> {
	const direction = data.direction ?? "dependencies";
	if (!["dependencies", "referencedBy"].includes(direction)) {
		throw new Error('Asset dependency direction must be "dependencies" or "referencedBy".');
	}
	const indexed = await getIndexedAssetDependencies(data.path);
	const references = direction === "dependencies" ? indexed.dependencies : indexed.referencedBy;
	return {
		path: indexed.path,
		direction,
		references,
		missingReferences: direction === "dependencies" ? indexed.missingDependencies : [],
		dependencyScanKind: indexed.dependencyScanKind,
		dependencyScanStatus: indexed.dependencyScanStatus,
		dependencyScanMessage: indexed.dependencyScanMessage,
		dependencyScanDeferred: indexed.dependencyScanDeferred,
		containerEntries: indexed.containerEntries,
		containerDependencies: indexed.containerDependencies,
		containerEntryCount: indexed.containerEntryCount,
		containerDependencyCount: indexed.containerDependencyCount,
		containerMissingDependencyCount: indexed.containerMissingDependencyCount,
		scannedTextFiles:
			direction === "dependencies"
				? indexed.dependencyScanKind === "text"
					? 1
					: 0
				: references.filter((path: string) => ![".glb", ".fbx", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"].includes(extname(path).toLowerCase())).length,
		scannedBinaryGlbFiles:
			direction === "dependencies" ? (indexed.dependencyScanKind === "glb" ? 1 : 0) : references.filter((path: string) => extname(path).toLowerCase() === ".glb").length,
		scannedBinaryModelFiles:
			direction === "dependencies"
				? ["fbx", "3ds", "ms3d", "b3d", "x", "lwo", "dxf", "blend"].includes(indexed.dependencyScanKind)
					? 1
					: 0
				: references.filter((path: string) => [".fbx", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"].includes(extname(path).toLowerCase())).length,
		scannedArchiveFiles:
			direction === "dependencies"
				? indexed.dependencyScanKind === "archive"
					? 1
					: 0
				: references.filter((path: string) => /\.(?:zip|tar|tgz|tar\.gz|unitypackage)$/i.test(path)).length,
		indexed: true,
	};
}

/** Traverses the persistent asset dependency graph with bounded depth and edge count. */
export async function inspectAssetDependencyGraph(_scene: Scene, data: any): Promise<any> {
	return getAssetDependencyGraph(data);
}

/** Formats a bounded persistent asset dependency graph as JSON, Graphviz DOT, or Mermaid. */
export async function exportAssetDependencyGraph(_scene: Scene, data: any): Promise<any> {
	const format = (data.format ?? "json") as AssetDependencyGraphExportFormat;
	const graph = await getAssetDependencyGraph(data);
	const extensions: Record<AssetDependencyGraphExportFormat, string> = { json: "json", dot: "dot", mermaid: "mmd" };
	return {
		rootPath: graph.rootPath,
		format,
		mimeType: format === "json" ? "application/json" : "text/plain",
		suggestedFilename: `${basename(graph.rootPath)}.dependencies.${extensions[format]}`,
		nodeCount: graph.nodes.length,
		edgeCount: graph.edges.length,
		cycleCount: graph.cycles.length,
		truncated: graph.truncated,
		content: formatAssetDependencyGraph(graph, format),
	};
}

/** Opens the interactive visual asset dependency canvas in the editor. */
export async function openAssetDependencyGraphView(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const graph = await getAssetDependencyGraph(data);
	openAssetDependencyGraphTab(options.editor, graph.rootPath, {
		direction: graph.direction,
		depth: graph.depth,
		includeMissing: data.includeMissing,
	});
	return {
		opened: true,
		rootPath: graph.rootPath,
		direction: graph.direction,
		depth: graph.depth,
		nodeCount: graph.nodes.length,
		edgeCount: graph.edges.length,
		cycleCount: graph.cycles.length,
		missingCount: graph.edges.filter((edge) => edge.missing).length,
		truncated: graph.truncated,
	};
}

/** Reports missing references, dependency cycles, and deferred dependency scans. */
export async function inspectAssetDependencyDiagnostics(_scene: Scene, data: any): Promise<any> {
	return getAssetDependencyDiagnostics(data);
}

/** Rebuilds asset identities, fingerprints, and dependency candidates/edges atomically. */
export async function rebuildAssetDependencyIndex(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	await rebuildAssetRegistry();
	refreshAssetsBrowser(options);
	return { ...(await getAssetRegistryStatus()), rebuiltDependencyIndex: true };
}

/** Writes Unity-style labels and importer settings to an asset sidecar without touching the source bytes. */
export async function setAssetMetadata(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Asset metadata can only be set on an existing file.");
	}
	const existing = await readAssetMetadata(absolutePath);
	const metadata = await writeAssetMetadata(absolutePath, {
		...existing,
		labels: data.labels ?? existing.labels,
		tags: data.tags ?? existing.tags,
		favorite: data.favorite ?? existing.favorite,
		importer: data.importer ? mergeImporterConfiguration(absolutePath, existing.importer, data.importer, false) : existing.importer,
	});
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	return { path: relative(getProjectDirectory(), absolutePath), metadata };
}

/** Lists the shared type-specific importer contracts, supported extensions, fields, and defaults. */
export function listAssetImporterTypes(): any {
	return {
		version: 1,
		importers: listAssetImporterDefinitions().map((definition) => ({ ...definition, defaults: getDefaultAssetImporterConfiguration(definition.kind).settings })),
	};
}

/** Returns one asset's effective type-specific importer configuration. */
export async function getAssetImporter(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Importer configuration is available only for existing file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	return { path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"), inferredKind: inferAssetImporterKind(absolutePath), importer: metadata.importer };
}

/** Opens the normal File Inspector for one indexed project asset. */
export async function openAssetInspector(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const entry = await getIndexedAssetRecord(data.path);
	const absolutePath = resolveProjectPath(entry.path);
	options.editor.layout.inspector.setEditedObject(new FileInspectorObject(absolutePath));
	await options.editor.layout.assets.setBrowsePath(dirname(absolutePath));
	return { opened: true, path: entry.path, guid: entry.guid, type: entry.type };
}

/** Validates a complete or partial importer draft without changing the project. */
export async function validateAssetImporterSettings(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Importer settings can only be validated for an existing file asset.");
	}
	const existing = (await readAssetMetadata(absolutePath)).importer;
	const importer = mergeImporterConfiguration(absolutePath, existing, data.importer ?? data.settings, data.replace === true);
	return { valid: true, path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"), importer };
}

/** Applies one validated type-specific importer settings patch to up to 100 compatible assets. */
export async function setAssetImporterSettings(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const paths = [...new Set<string>(data.paths ?? [])];
	if (!paths.length) {
		throw new Error("Provide at least one project-relative asset path.");
	}
	const prepared: Array<{ absolutePath: string; path: string; metadata: Awaited<ReturnType<typeof readAssetMetadata>>; importer: IAssetImporterConfiguration }> = [];
	for (const path of paths) {
		const absolutePath = resolveProjectPath(path);
		if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
			throw new Error(`Importer settings can only be applied to existing files: ${path}`);
		}
		const metadata = await readAssetMetadata(absolutePath);
		prepared.push({
			absolutePath,
			path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
			metadata,
			importer: mergeImporterConfiguration(absolutePath, metadata.importer, data.settings, data.replace === true),
		});
	}
	for (const entry of prepared) {
		await writeAssetMetadata(entry.absolutePath, { ...entry.metadata, importer: entry.importer });
	}
	await refreshAssetRegistryPaths(prepared.map((entry) => entry.absolutePath));
	refreshAssetsBrowser(options);
	return { updated: prepared.map((entry) => ({ path: entry.path, importer: entry.importer })) };
}

/** Configures Unity-style optimized character hierarchy import and its explicitly exposed script/attachment transforms. */
export async function setModelRigOptimization(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const updated = await setAssetImporterSettings(
		scene,
		{
			paths: [data.path],
			settings: {
				optimizeGameObjects: data.enabled,
				exposedTransforms: [...new Set<string>(data.exposedTransforms ?? [])].join("\n"),
			},
		},
		options
	);
	const absolutePath = resolveProjectPath(data.path);
	const status = await getModelImporterArtifactStatus(absolutePath);
	return {
		...updated,
		fingerprint: status.fingerprint,
		current: status.current,
		next: "Call get_model_importer_result, then apply_model_importer with this exact fingerprint after reviewing the plan.",
	};
}

/** Reads persisted model clip definitions and the latest source/output AnimationGroup evidence under an exact importer fingerprint. */
export async function getModelAnimationClips(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model animation clips are available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model animation clips require a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const status = await getModelImporterArtifactStatus(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		definitions: settings.animationClips,
		sourceAnimationGroups: status.result?.sourceAnimationGroups ?? [],
		generatedClips: status.result?.animationClips ?? [],
		errors: status.result?.errors ?? [],
		warnings: status.result?.warnings ?? [],
		next: status.result
			? "Replace definitions with set_model_animation_clips, then inspect get_model_importer_result and apply_model_importer."
			: "Apply the Model Importer once to discover source AnimationGroup names and ranges, then configure clips.",
	};
}

/** Atomically replaces bounded Unity-style per-model clip definitions after verifying the exact importer lease. */
export async function setModelAnimationClips(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model animation clips can only be configured for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model animation clips require a model asset.");
	}
	const before = await getModelImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Model animation clip plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const definitions = normalizeModelAnimationClipDefinitions(data.clips);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: {
			...metadata.importer.settings,
			animationClips: serializeModelAnimationClipDefinitions(definitions),
		},
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getModelImporterArtifactStatus(absolutePath);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		definitions,
		next: "Call get_model_importer_result, review the clip plan, then apply_model_importer with the returned exact fingerprint.",
	};
}

/** Reads exact imported source-material evidence and the persisted complete project-material remap table. */
export async function getModelMaterialRemaps(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model material remaps are available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model material remaps require a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const status = await getModelImporterArtifactStatus(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		remaps: settings.materialRemaps,
		sourceMaterials: status.result?.sourceMaterials ?? [],
		execution: status.result?.materialRemaps ?? [],
		errors: status.result?.errors ?? [],
		warnings: status.result?.warnings ?? [],
		next: status.result
			? "Replace the complete table with set_model_material_remaps, then inspect and apply the returned model-importer fingerprint."
			: "Apply the Model Importer once to discover exact source material names, then configure remaps.",
	};
}

/** Atomically replaces bounded imported-model material remaps after verifying the exact importer lease. */
export async function setModelMaterialRemaps(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model material remaps can only be configured for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model material remaps require a model asset.");
	}
	const before = await getModelImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Model material remap plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const remaps = normalizeModelMaterialRemaps(data.remaps);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: {
			...metadata.importer.settings,
			materialRemaps: serializeModelMaterialRemaps(remaps),
		},
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getModelImporterArtifactStatus(absolutePath);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		remaps,
		next: "Call get_model_importer_result, review the material plan, then apply_model_importer with the returned exact fingerprint.",
	};
}

/** Reads Unity-style automatic model-material naming/search settings and the latest deterministic match evidence. */
export async function getModelMaterialSearch(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model material search is available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model material search requires a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const status = await getModelImporterArtifactStatus(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		naming: settings.materialNaming,
		search: settings.materialSearch,
		result: status.result?.materialSearch ?? null,
		explicitRemaps: settings.materialRemaps,
		next: "Change this complete configuration with set_model_material_search, then inspect and apply the returned exact importer fingerprint.",
	};
}

/** Atomically replaces automatic model-material naming/search settings under the exact importer lease. */
export async function setModelMaterialSearch(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model material search can only be configured for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model material search requires a model asset.");
	}
	const before = await getModelImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Model material search plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	if (!["sourceMaterial", "baseTextureName", "modelAndMaterial"].includes(data.naming)) {
		throw new Error("Material naming must be sourceMaterial, baseTextureName, or modelAndMaterial.");
	}
	if (!["none", "local", "recursiveUp", "projectWide"].includes(data.search)) {
		throw new Error("Material search must be none, local, recursiveUp, or projectWide.");
	}
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: { ...metadata.importer.settings, materialNaming: data.naming, materialSearch: data.search },
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getModelImporterArtifactStatus(absolutePath);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		naming: data.naming,
		search: data.search,
		next: "Call get_model_importer_result, review automatic matches and ambiguity evidence, then apply_model_importer with the returned fingerprint.",
	};
}

/** Reads the complete Web/Desktop model-import override map and both effective target plans under one exact lease. */
export async function getModelPlatformOverrides(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model platform overrides are available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model platform overrides require a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const status = await getModelImporterArtifactStatus(absolutePath);
	const web = resolveModelImporterPlatformSettings(settings, "web");
	const desktop = resolveModelImporterPlatformSettings(settings, "desktop");
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		overrides: settings.platformOverrides,
		effective: {
			web: { overrideApplied: web.overrideApplied, settings: web.settings },
			desktop: { overrideApplied: desktop.overrideApplied, settings: desktop.settings },
		},
		next: "Replace the complete map with set_model_platform_overrides, then run a Web or Electron build profile to execute and publish that target's effective settings.",
	};
}

/** Atomically replaces the complete closed Web/Desktop model-import override map under the exact importer lease. */
export async function setModelPlatformOverrides(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model platform overrides can only be configured for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model platform overrides require a model asset.");
	}
	const before = await getModelImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Model platform override plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const overrides = normalizeModelImporterPlatformOverrides(data.overrides);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: { ...metadata.importer.settings, platformOverrides: serializeModelImporterPlatformOverrides(overrides) },
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getModelImporterArtifactStatus(absolutePath);
	const settings = normalizeModelImporterSettings(importer.settings);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		overrides,
		effective: {
			web: resolveModelImporterPlatformSettings(settings, "web"),
			desktop: resolveModelImporterPlatformSettings(settings, "desktop"),
		},
		next: "Run the matching Web or Electron build profile; target selection is part of the asset cache key and build evidence.",
	};
}

/** Plans Unity-style extraction of embedded model materials into editable project assets without changing files. */
export async function inspectModelMaterialExtraction(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model material extraction is available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model material extraction requires a model asset.");
	}
	const status = await getModelMaterialExtractionStatus(absolutePath, data.destinationFolder);
	return {
		...status,
		next: status.conflictCount
			? "Choose an empty destinationFolder or move the reported conflicting .material assets, then inspect again. Existing files are never overwritten."
			: "Call extract_model_materials with this exact fingerprint and confirm=true to create/reuse the assets and persist exact model remaps.",
	};
}

/** Atomically creates collision-safe editable material assets and persists exact remaps back to the source model. */
export async function extractModelMaterials(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("extract_model_materials requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model materials can only be extracted from an existing model file asset.");
	}
	const prepared = await prepareModelMaterialExtraction(absolutePath, data.destinationFolder);
	if (prepared.status.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Model material extraction plan changed. Inspect again and use current fingerprint ${prepared.status.fingerprint}.`);
	}
	if (!prepared.status.valid) {
		throw new Error(
			prepared.status.conflictCount
				? `Model material extraction has ${prepared.status.conflictCount} conflicting destination asset(s); existing files will not be overwritten.`
				: "The model has no extractable embedded materials."
		);
	}
	const beforeMetadata = await readAssetMetadata(absolutePath);
	if (beforeMetadata.importer.kind !== "model") {
		throw new Error("Model material extraction requires a model asset.");
	}
	const root = getProjectDirectory();
	const createdPaths: string[] = [];
	let metadataUpdated = false;
	try {
		for (const item of prepared.status.items.filter((candidate) => candidate.action === "create")) {
			const destination = resolveProjectPath(item.materialPath);
			await ensureDir(dirname(destination));
			if (await pathExists(destination)) {
				throw new Error(`Model material extraction destination appeared after inspection: ${item.materialPath}.`);
			}
			const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`);
			try {
				await writeJSON(temporary, prepared.serializedMaterials[item.sourceMaterial], { spaces: "\t", encoding: "utf-8" });
				await move(temporary, destination, { overwrite: false });
			} finally {
				await remove(temporary).catch(() => undefined);
			}
			createdPaths.push(destination);
		}
		const currentSettings = normalizeModelImporterSettings(beforeMetadata.importer.settings);
		const extractedSources = new Set(prepared.status.items.map((item) => item.sourceMaterial));
		const remaps = normalizeModelMaterialRemaps([
			...currentSettings.materialRemaps.filter((remap) => !extractedSources.has(remap.sourceMaterial)),
			...prepared.status.items.map((item) => ({ sourceMaterial: item.sourceMaterial, materialPath: item.materialPath })),
		]);
		const importer = validateAssetImporterConfiguration(absolutePath, {
			...beforeMetadata.importer,
			settings: { ...beforeMetadata.importer.settings, materialRemaps: serializeModelMaterialRemaps(remaps) },
		}).configuration;
		await writeAssetMetadata(absolutePath, { ...beforeMetadata, importer });
		metadataUpdated = true;
		await refreshAssetRegistryPaths([absolutePath, ...createdPaths]);
		refreshAssetsBrowser(options);
		const importerStatus = await getModelImporterArtifactStatus(absolutePath);
		const extractionStatus = await getModelMaterialExtractionStatus(absolutePath, prepared.status.destinationFolder);
		return {
			extracted: true,
			path: relative(root, absolutePath).replace(/\\/g, "/"),
			destinationFolder: prepared.status.destinationFolder,
			created: prepared.status.items.filter((item) => item.action === "create").map((item) => item.materialPath),
			reused: prepared.status.items.filter((item) => item.action === "reuse").map((item) => item.materialPath),
			remaps,
			previousFingerprint: prepared.status.fingerprint,
			fingerprint: extractionStatus.fingerprint,
			modelImporterFingerprint: importerStatus.fingerprint,
			modelImporterCurrent: importerStatus.current,
			next: "Inspect get_model_importer_result and apply_model_importer with modelImporterFingerprint to publish the processed model using these editable materials.",
		};
	} catch (error) {
		if (metadataUpdated) {
			await writeAssetMetadata(absolutePath, beforeMetadata).catch(() => undefined);
		}
		await Promise.all(createdPaths.flatMap((path) => [remove(path).catch(() => undefined), remove(metadataPath(path)).catch(() => undefined)]));
		await refreshAssetRegistryPaths([absolutePath, ...createdPaths]).catch(() => undefined);
		throw error;
	}
}

/** Plans Unity-style extraction of embedded model images and material-reference rewrites without changing files. */
export async function inspectModelTextureExtraction(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model texture extraction is available only for existing model file assets.");
	}
	const status = await getModelTextureExtractionStatus(absolutePath, data.destinationFolder);
	return {
		...status,
		next: status.conflictCount
			? "Choose an empty destinationFolder or move the conflicting texture assets, then inspect again. Existing textures are never overwritten."
			: "Call extract_model_textures with this exact fingerprint and confirm=true to publish the images and rewrite the listed editable materials.",
	};
}

/** Atomically publishes embedded images and rewrites their extracted editable materials to project texture paths. */
export async function extractModelTextures(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("extract_model_textures requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model textures can only be extracted from an existing model file asset.");
	}
	const prepared = await prepareModelTextureExtraction(absolutePath, data.destinationFolder);
	if (prepared.status.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Model texture extraction plan changed. Inspect again and use current fingerprint ${prepared.status.fingerprint}.`);
	}
	if (!prepared.status.valid) {
		throw new Error(`Model texture extraction has ${prepared.status.conflictCount} conflicting destination asset(s); existing textures will not be overwritten.`);
	}
	const createdPaths: string[] = [];
	const replacedMaterials: Array<{ path: string; backup: string }> = [];
	try {
		for (const item of prepared.status.items.filter((candidate) => candidate.action === "create")) {
			const destination = resolveProjectPath(item.texturePath);
			await ensureDir(dirname(destination));
			if (await pathExists(destination)) {
				throw new Error(`Model texture extraction destination appeared after inspection: ${item.texturePath}.`);
			}
			const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`);
			try {
				await writeFile(temporary, prepared.bytesByHash[item.contentHash]);
				await move(temporary, destination, { overwrite: false });
			} finally {
				await remove(temporary).catch(() => undefined);
			}
			createdPaths.push(destination);
		}
		for (const [materialPath, document] of Object.entries(prepared.materialDocuments)) {
			const destination = resolveProjectPath(materialPath);
			const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}-${randomUUID()}`);
			const backup = join(dirname(destination), `.${basename(destination)}.backup-${process.pid}-${randomUUID()}`);
			try {
				await writeJSON(temporary, document, { spaces: "\t", encoding: "utf-8" });
				await move(destination, backup, { overwrite: false });
				try {
					await move(temporary, destination, { overwrite: false });
				} catch (error) {
					await move(backup, destination, { overwrite: false }).catch(() => undefined);
					throw error;
				}
				replacedMaterials.push({ path: destination, backup });
			} finally {
				await remove(temporary).catch(() => undefined);
			}
		}
		await refreshAssetRegistryPaths([absolutePath, ...createdPaths, ...replacedMaterials.map((entry) => entry.path)]);
		refreshAssetsBrowser(options);
		await Promise.all(replacedMaterials.map((entry) => remove(entry.backup).catch(() => undefined)));
		const after = await getModelTextureExtractionStatus(absolutePath, prepared.status.destinationFolder).catch(() => null);
		return {
			extracted: true,
			path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
			destinationFolder: prepared.status.destinationFolder,
			created: prepared.status.items.filter((item) => item.action === "create").map((item) => item.texturePath),
			reused: prepared.status.items.filter((item) => item.action === "reuse").map((item) => item.texturePath),
			rewrittenMaterials: prepared.status.materialPaths,
			previousFingerprint: prepared.status.fingerprint,
			fingerprint: after?.fingerprint ?? null,
			next: "The editable materials now reference project texture assets. Configure their Texture Importers or rebuild the model as needed.",
		};
	} catch (error) {
		for (const entry of [...replacedMaterials].reverse()) {
			await remove(entry.path).catch(() => undefined);
			await move(entry.backup, entry.path, { overwrite: false }).catch(() => undefined);
		}
		await Promise.all(createdPaths.flatMap((path) => [remove(path).catch(() => undefined), remove(metadataPath(path)).catch(() => undefined)]));
		await refreshAssetRegistryPaths([absolutePath, ...createdPaths, ...replacedMaterials.map((entry) => entry.path)]).catch(() => undefined);
		throw error;
	}
}

/** Reads the complete generated-LOD importer table and latest per-source geometry evidence. */
export async function getModelGeneratedLods(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Generated model LODs are available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Generated model LODs require a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const status = await getModelImporterArtifactStatus(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		levels: settings.generatedLods,
		generated: status.result?.generatedLods ?? [],
		lodSourceMeshCount: status.result?.lodSourceMeshCount ?? 0,
		generatedLodMeshCount: status.result?.generatedLodMeshCount ?? 0,
		skippedLodMeshCount: status.result?.skippedLodMeshCount ?? 0,
		errors: status.result?.errors ?? [],
		warnings: status.result?.warnings ?? [],
		next: status.result
			? "Replace the complete table with set_model_generated_lods, then inspect and apply the returned model-importer fingerprint."
			: "Apply the Model Importer once to inspect eligible source meshes, then configure generated levels.",
	};
}

/** Atomically replaces bounded generated model LOD levels after verifying the exact importer lease. */
export async function setModelGeneratedLods(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Generated model LODs can only be configured for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Generated model LODs require a model asset.");
	}
	const before = await getModelImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Generated model LOD plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const levels = normalizeModelLodDefinitions(data.levels);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: {
			...metadata.importer.settings,
			generatedLods: serializeModelLodDefinitions(levels),
		},
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getModelImporterArtifactStatus(absolutePath);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		levels,
		next: "Call get_model_importer_result, review generated geometry evidence, then apply_model_importer with the returned exact fingerprint.",
	};
}

/** Reads exact artist-authored LOD assignments, latest execution evidence, and safe _LOD# suggestions. */
export async function getModelAuthoredLods(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Authored model LODs are available only for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Authored model LODs require a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	const status = await getModelImporterArtifactStatus(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		groups: settings.authoredLods,
		suggestions: suggestModelAuthoredLodGroups(status.result?.meshes.map((mesh) => mesh.name) ?? []),
		suggestionsTruncated: !!status.result && status.result.meshCount > status.result.meshes.length,
		applied: status.result?.authoredLods ?? [],
		authoredLodSourceMeshCount: status.result?.authoredLodSourceMeshCount ?? 0,
		authoredLodMeshCount: status.result?.authoredLodMeshCount ?? 0,
		errors: status.result?.errors ?? [],
		warnings: status.result?.warnings ?? [],
		next: status.result
			? "Replace the complete table with set_model_authored_lods, then inspect and apply the returned model-importer fingerprint."
			: "Apply the Model Importer once to discover exact mesh names and _LOD# suggestions.",
	};
}

/** Atomically replaces exact artist-authored LOD groups after verifying the complete importer lease. */
export async function setModelAuthoredLods(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Authored model LODs can only be configured for existing model file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "model") {
		throw new Error("Authored model LODs require a model asset.");
	}
	const before = await getModelImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Authored model LOD plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const groups = normalizeModelAuthoredLodGroups(data.groups);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: {
			...metadata.importer.settings,
			authoredLods: serializeModelAuthoredLodGroups(groups),
		},
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getModelImporterArtifactStatus(absolutePath);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		groups,
		next: "Call get_model_importer_result, review authored LOD evidence, then apply_model_importer with the returned exact fingerprint.",
	};
}

function portableTextureImporterStatus(status: Awaited<ReturnType<typeof getTextureImporterArtifactStatus>>, absolutePath: string): any {
	const portable = (path: string | null): string | null => (path ? relative(getProjectDirectory(), path).replace(/\\/g, "/") : null);
	const result = status.result
		? {
				...status.result,
				sourcePath: portable(status.result.sourcePath),
				outputPath: portable(status.result.outputPath),
				mipmaps: status.result.mipmaps.map((mipmap) => ({ ...mipmap, path: portable(mipmap.path) })),
				readableBitmapPath: portable(status.result.readableBitmapPath),
				readableDescriptorPath: portable(status.result.readableDescriptorPath),
				previewPath: portable(status.result.previewPath ?? null),
				highDynamicRange: status.result.highDynamicRange
					? {
							...status.result.highDynamicRange,
							environmentPath: portable(status.result.highDynamicRange.environmentPath),
							cubeFaces: status.result.highDynamicRange.cubeFaces.map((face) => ({ ...face, path: portable(face.path) })),
						}
					: null,
			}
		: null;
	return {
		...status,
		path: portable(absolutePath),
		artifactPath: portable(status.artifactPath),
		manifestPath: portable(status.manifestPath),
		result,
	};
}

/** Returns exact-fingerprint Texture Importer artifact status and processed image evidence without changing files. */
export async function getTextureImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Texture importer results are available only for existing file assets.");
	}
	return portableTextureImporterStatus(await getTextureImporterArtifactStatus(absolutePath), absolutePath);
}

async function resolveTextureChannelPreviewAsset(path: string): Promise<string> {
	const absolutePath = resolveProjectPath(path);
	if (!IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
		throw new Error(`Texture channel preview requires a supported image asset (${[...IMAGE_EXTENSIONS].join(", ")}).`);
	}
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Texture channel preview is available only for an existing image file asset.");
	}
	const projectDirectory = getProjectDirectory();
	const [canonicalProject, canonicalAsset] = await Promise.all([realpath(projectDirectory), realpath(absolutePath)]);
	const canonicalRelative = relative(canonicalProject, canonicalAsset);
	if (canonicalRelative === ".." || canonicalRelative.startsWith("../") || isAbsolute(canonicalRelative)) {
		throw new Error("Texture channel preview assets must not escape the open project through a symbolic link.");
	}
	return absolutePath;
}

/** Returns the non-destructive Texture Inspector channel-preview state for one image asset. */
export async function getTextureChannelPreview(_scene: Scene, data: any): Promise<any> {
	const absolutePath = await resolveTextureChannelPreviewAsset(data.path);
	const state = getTextureChannelPreviewState(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		...state,
		effectiveDisplayMode: state.channel === "rgba" ? "original" : state.channel === "alpha" ? "grayscale" : state.displayMode,
		supportedChannels: TEXTURE_CHANNEL_PREVIEW_CHANNELS,
		supportedDisplayModes: TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES,
		defaults: { channel: "rgba", displayMode: "grayscale" },
		maximumPreviewDimension: TEXTURE_CHANNEL_PREVIEW_MAXIMUM_DIMENSION,
		persisted: false,
		mutatesAsset: false,
		semantics: {
			rgba: "Displays the original RGBA preview.",
			grayscale: "Replicates the selected channel value into RGB and displays it opaquely.",
			colorized: "Tints red, green, or blue by its selected-channel value; alpha remains grayscale and opaque for legibility.",
		},
		next: "Open the asset with open_asset_inspector, then use set_texture_channel_preview with this exact revision. Capture a screenshot when visual evidence is required.",
	};
}

/** Updates the transient Texture Inspector channel-preview state under an exact revision. */
export async function setTextureChannelPreview(_scene: Scene, data: any): Promise<any> {
	const absolutePath = await resolveTextureChannelPreviewAsset(data.path);
	const result = setTextureChannelPreviewState(
		absolutePath,
		{
			channel: data.channel,
			displayMode: data.displayMode,
		},
		data.expectedRevision
	);
	return {
		updated: result.updated,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		...result.state,
		effectiveDisplayMode: result.state.channel === "rgba" ? "original" : result.state.channel === "alpha" ? "grayscale" : result.state.displayMode,
		persisted: false,
		mutatesAsset: false,
		next: "The open Texture Inspector updates immediately. Re-read with get_texture_channel_preview before another external mutation.",
	};
}

/** Reads the complete Web/Desktop texture override map and both effective target plans under one exact lease. */
export async function getTexturePlatformOverrides(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Texture platform overrides are available only for existing texture file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "texture") {
		throw new Error("Texture platform overrides require a texture asset.");
	}
	const settings = normalizeTextureImporterSettings(metadata.importer.settings);
	const status = await getTextureImporterArtifactStatus(absolutePath);
	const web = resolveTextureImporterPlatformSettings(settings, "web");
	const desktop = resolveTextureImporterPlatformSettings(settings, "desktop");
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		overrides: settings.platformOverrides,
		effective: {
			web: { overrideApplied: web.overrideApplied, settings: web.settings },
			desktop: { overrideApplied: desktop.overrideApplied, settings: desktop.settings },
		},
		next: "Replace the complete map with set_texture_platform_overrides, then run a Web or Electron build profile to execute that target's effective settings.",
	};
}

/** Atomically replaces the complete closed Web/Desktop texture override map under the exact importer lease. */
export async function setTexturePlatformOverrides(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Texture platform overrides can only be configured for existing texture file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "texture") {
		throw new Error("Texture platform overrides require a texture asset.");
	}
	const before = await getTextureImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Texture platform override plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const overrides = normalizeTextureImporterPlatformOverrides(data.overrides);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: { ...metadata.importer.settings, platformOverrides: serializeTextureImporterPlatformOverrides(overrides) },
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getTextureImporterArtifactStatus(absolutePath);
	const settings = normalizeTextureImporterSettings(importer.settings);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		overrides,
		effective: {
			web: resolveTextureImporterPlatformSettings(settings, "web"),
			desktop: resolveTextureImporterPlatformSettings(settings, "desktop"),
		},
		next: "Run the matching Web or Electron build profile; the target participates in editor/CLI cache identity and build evidence.",
	};
}

/** Applies one leased LDR Texture Importer configuration and publishes its deterministic preview artifacts. */
export async function applyTextureImporter(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying a texture importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Texture importers can only be applied to existing file assets.");
	}
	const status = await applyTextureImporterArtifact(absolutePath, data.expectedFingerprint);
	const projectPath = relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/");
	if (status.result) {
		for (const texture of scene.textures) {
			const url = (texture as any).url as string | undefined;
			if (texture.name === projectPath || url === projectPath || texture.name.endsWith(`/${projectPath}`) || url?.endsWith(`/${projectPath}`)) {
				texture.gammaSpace = status.result.effectiveColorSpace === "sRGB";
			}
		}
	}
	refreshAssetsBrowser(options);
	return { applied: true, ...portableTextureImporterStatus(status, absolutePath) };
}

function psdLayerExtractionOptions(data: any): IPsdLayerExtractionOptions {
	return {
		destinationFolder: data.destinationFolder,
		includeHidden: data.includeHidden,
		applyOpacity: data.applyOpacity,
		applyLayerEffects: data.applyLayerEffects,
		applyAdjustments: data.applyAdjustments,
		compositeClippingGroups: data.compositeClippingGroups,
		compositeGroups: data.compositeGroups,
		layerIndices: data.layerIndices,
		textRenders: data.textRenders,
		extractSmartObjectPayloads: data.extractSmartObjectPayloads,
		smartObjectResourceIds: data.smartObjectResourceIds,
		smartObjectExternalBindings: data.smartObjectExternalBindings,
		shapeBlurKernelBindings: data.shapeBlurKernelBindings,
		displacementMapBindings: data.displacementMapBindings,
		inspectNestedSmartObjects: data.inspectNestedSmartObjects,
		nestedSmartObjectMaximumDepth: data.nestedSmartObjectMaximumDepth,
		renderEmbeddedSmartObjects: data.renderEmbeddedSmartObjects,
		renderExternalSmartObjects: data.renderExternalSmartObjects,
		smartObjectRenderLayerIndices: data.smartObjectRenderLayerIndices,
	};
}

/** Inspects bounded layered-PSD records and a complete exact no-overwrite PNG extraction plan. */
export async function inspectPsdLayerExtraction(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	const status = await getPsdLayerExtractionStatus(absolutePath, psdLayerExtractionOptions(data));
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	const layers = status.document.layers.slice(offset, offset + limit);
	const items = status.items.filter((item) => item.layerIndex >= offset && item.layerIndex < offset + limit);
	return {
		...status,
		document: { ...status.document, layers: undefined },
		layers,
		items,
		offset,
		limit,
		returnedLayerCount: layers.length,
		hasMore: offset + layers.length < status.document.layerCount,
		nextOffset: offset + layers.length < status.document.layerCount ? offset + layers.length : null,
		next:
			status.conflictCount + status.smartObjectPayloadConflictCount > 0
				? "Choose another destinationFolder; extraction never overwrites different existing assets."
				: "Call extract_psd_layers with the same options, this exact fingerprint, and confirm=true.",
	};
}

/** Applies one exact layered-PSD extraction plan and publishes normal project PNG assets without overwriting files. */
export async function extractPsdLayers(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Extracting PSD layers requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	const status = await applyPsdLayerExtraction(absolutePath, psdLayerExtractionOptions(data), data.expectedFingerprint);
	await refreshAssetRegistryPaths([...status.items, ...status.smartObjectPayloads].map((item) => resolveProjectPath(item.path)));
	refreshAssetsBrowser(options);
	return {
		extracted: true,
		...status,
		document: { ...status.document, layers: undefined },
		layers: status.document.layers,
		next: "The extracted PNGs are ordinary texture assets. Embedded smart-object payloads are ordinary contained project assets under the plan's smart-objects folder; external and alias records remain evidence-only.",
	};
}

function psdSmartObjectPayloadReplacementOptions(data: any): IPsdSmartObjectPayloadReplacementOptions {
	return {
		destinationPath: data.destinationPath,
		replacements: data.replacements,
	};
}

/** Inspects one exact top-level embedded liFD payload replacement plan without writing files. */
export async function inspectPsdSmartObjectPayloadReplacement(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	const status = await getPsdSmartObjectPayloadReplacementStatus(absolutePath, psdSmartObjectPayloadReplacementOptions(data));
	return {
		...status,
		next:
			status.action === "conflict"
				? "Choose another destinationPath; replacement never overwrites different existing bytes."
				: "Call replace_psd_smart_object_payloads with the same path, destinationPath, replacements, this exact fingerprint, and confirm=true.",
	};
}

/** Publishes one exact replacement PSD copy; the source PSD is never rewritten in place. */
export async function replacePsdSmartObjectPayloads(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Replacing PSD smart-object payloads requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	const status = await applyPsdSmartObjectPayloadReplacement(absolutePath, psdSmartObjectPayloadReplacementOptions(data), data.expectedFingerprint);
	await refreshAssetRegistryPaths([resolveProjectPath(status.destinationPath)]);
	refreshAssetsBrowser(options);
	return {
		replaced: true,
		...status,
		next: "The destination is a normal project PSD asset containing the exact selected top-level embedded liFD payload bytes. The original source PSD was not modified.",
	};
}

/** Returns exact-fingerprint audio importer artifact status and probe evidence without modifying the project. */
export async function getAudioImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Audio importer results are available only for existing file assets.");
	}
	const status = await getAudioImporterArtifactStatus(absolutePath);
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/"),
			}
		: null;
	return {
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactPath: relative(getProjectDirectory(), status.artifactPath).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Applies one leased audio importer configuration and publishes its deterministic preview artifact. */
export async function applyAudioImporter(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying an audio importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Audio importers can only be applied to existing file assets.");
	}
	const status = await applyAudioImporterArtifact(absolutePath, data.expectedFingerprint, options.editor);
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/"),
			}
		: null;
	return {
		applied: true,
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactPath: relative(getProjectDirectory(), status.artifactPath).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Returns exact-fingerprint video importer artifact status and probe evidence without modifying the project. */
export async function getVideoImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Video importer results are available only for existing file assets.");
	}
	const status = await getVideoImporterArtifactStatus(absolutePath, data.platform);
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/"),
			}
		: null;
	return {
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactPath: relative(getProjectDirectory(), status.artifactPath).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Reports the actual FFmpeg encoder backends and the immutable Web/Desktop codec policy. */
export async function getVideoImporterCapabilities(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	return {
		encoders: await getVideoEncoderCapabilities(options.editor),
		platforms: {
			web: getVideoPlatformCodecMatrix("web"),
			desktop: getVideoPlatformCodecMatrix("desktop"),
		},
	};
}

/** Reads the complete Web/Desktop video override map and both effective target plans under one exact lease. */
export async function getVideoPlatformOverrides(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Video platform overrides are available only for existing video file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "video") {
		throw new Error("Video platform overrides require a video asset.");
	}
	const settings = normalizeVideoImporterSettings(metadata.importer.settings);
	const status = await getVideoImporterArtifactStatus(absolutePath);
	return {
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		fingerprint: status.fingerprint,
		current: status.current,
		overrides: settings.platformOverrides,
		effective: {
			web: resolveVideoImporterPlatformSettings(settings, "web"),
			desktop: resolveVideoImporterPlatformSettings(settings, "desktop"),
		},
		next: "Replace the complete map with set_video_platform_overrides, then inspect/apply the matching Web or Desktop importer profile.",
	};
}

/** Atomically replaces the complete closed Web/Desktop video override map under the exact importer lease. */
export async function setVideoPlatformOverrides(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Video platform overrides can only be configured for existing video file assets.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "video") {
		throw new Error("Video platform overrides require a video asset.");
	}
	const before = await getVideoImporterArtifactStatus(absolutePath);
	if (before.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Video platform override plan changed. Inspect again and use current fingerprint ${before.fingerprint}.`);
	}
	const overrides = normalizeVideoImporterPlatformOverrides(data.overrides);
	const importer = validateAssetImporterConfiguration(absolutePath, {
		...metadata.importer,
		settings: { ...metadata.importer.settings, platformOverrides: serializeVideoImporterPlatformOverrides(overrides) },
	}).configuration;
	await writeAssetMetadata(absolutePath, { ...metadata, importer });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	const after = await getVideoImporterArtifactStatus(absolutePath);
	const settings = normalizeVideoImporterSettings(importer.settings);
	return {
		updated: true,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		previousFingerprint: before.fingerprint,
		fingerprint: after.fingerprint,
		current: after.current,
		overrides,
		effective: {
			web: resolveVideoImporterPlatformSettings(settings, "web"),
			desktop: resolveVideoImporterPlatformSettings(settings, "desktop"),
		},
	};
}

/** Applies one leased video importer configuration and publishes its deterministic preview artifact. */
export async function applyVideoImporter(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying a video importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Video importers can only be applied to existing file assets.");
	}
	const status = await applyVideoImporterArtifact(absolutePath, data.expectedFingerprint, options.editor, data.platform);
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/"),
			}
		: null;
	return {
		applied: true,
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactPath: relative(getProjectDirectory(), status.artifactPath).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

function portableFontImporterStatus(status: Awaited<ReturnType<typeof getFontImporterArtifactStatus>>, absolutePath: string): any {
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputDirectory: relative(getProjectDirectory(), status.result.outputDirectory).replace(/\\/g, "/"),
				manifestPath: relative(getProjectDirectory(), status.result.manifestPath).replace(/\\/g, "/"),
				pages: status.result.pages.map((page) => ({ ...page, path: relative(getProjectDirectory(), page.path).replace(/\\/g, "/") })),
				dynamicFontPath: status.result.dynamicFontPath ? relative(getProjectDirectory(), status.result.dynamicFontPath).replace(/\\/g, "/") : null,
				sourceFontPath: status.result.sourceFontPath ? relative(getProjectDirectory(), status.result.sourceFontPath).replace(/\\/g, "/") : null,
			}
		: null;
	return {
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactDirectory: relative(getProjectDirectory(), status.artifactDirectory).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Returns exact-fingerprint font importer artifact status and atlas evidence without modifying the project. */
export async function getFontImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Font importer results are available only for existing file assets.");
	}
	return portableFontImporterStatus(await getFontImporterArtifactStatus(absolutePath), absolutePath);
}

/** Applies one leased font importer and publishes its dynamic or bitmap/SDF/MSDF artifacts. */
export async function applyFontImporter(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying a font importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Font importers can only be applied to existing file assets.");
	}
	const status = await applyFontImporterArtifact(absolutePath, data.expectedFingerprint);
	refreshAssetsBrowser(options);
	return { applied: true, ...portableFontImporterStatus(status, absolutePath) };
}

function portableMaterialImporterStatus(status: Awaited<ReturnType<typeof getMaterialImporterArtifactStatus>>, absolutePath: string): any {
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/"),
				extractedTextures: status.result.extractedTextures.map((path) => relative(getProjectDirectory(), path).replace(/\\/g, "/")),
			}
		: null;
	return {
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactDirectory: relative(getProjectDirectory(), status.artifactDirectory).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Returns exact-fingerprint material validation, extraction, and Node Material compilation evidence. */
export async function getMaterialImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Material importer results are available only for existing file assets.");
	}
	return portableMaterialImporterStatus(await getMaterialImporterArtifactStatus(absolutePath), absolutePath);
}

/** Applies one leased material importer and publishes its validated preview artifact. */
export async function applyMaterialImporter(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying a material importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Material importers can only be applied to existing file assets.");
	}
	const status = await applyMaterialImporterArtifact(absolutePath, data.expectedFingerprint);
	refreshAssetsBrowser(options);
	return { applied: true, ...portableMaterialImporterStatus(status, absolutePath) };
}

function portableModelImporterStatus(status: Awaited<ReturnType<typeof getModelImporterArtifactStatus>>, absolutePath: string): any {
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: status.result.outputPath ? relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/") : null,
				meshCount: status.result.meshes.length,
				meshesTruncated: status.result.meshes.length > 200,
				meshes: status.result.meshes.slice(0, 200),
			}
		: null;
	return {
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactDirectory: relative(getProjectDirectory(), status.artifactDirectory).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Returns exact-fingerprint executed model conversion, geometry, material, animation, collider, and compression evidence. */
export async function getModelImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model importer results are available only for existing file assets.");
	}
	return portableModelImporterStatus(await getModelImporterArtifactStatus(absolutePath), absolutePath);
}

/** Applies one leased Model Importer and atomically publishes its processed Babylon model artifact. */
export async function applyModelImporter(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying a model importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Model importers can only be applied to existing file assets.");
	}
	const status = await applyModelImporterArtifact(absolutePath, data.expectedFingerprint);
	refreshAssetsBrowser(options);
	return { applied: true, ...portableModelImporterStatus(status, absolutePath) };
}

function portableAnimationImporterStatus(status: Awaited<ReturnType<typeof getAnimationImporterArtifactStatus>>, absolutePath: string): any {
	const result = status.result
		? {
				...status.result,
				sourcePath: relative(getProjectDirectory(), status.result.sourcePath).replace(/\\/g, "/"),
				outputPath: relative(getProjectDirectory(), status.result.outputPath).replace(/\\/g, "/"),
				trackCount: status.result.tracks.length,
				tracksTruncated: status.result.tracks.length > 200,
				tracks: status.result.tracks.slice(0, 200),
			}
		: null;
	return {
		...status,
		path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		artifactDirectory: relative(getProjectDirectory(), status.artifactDirectory).replace(/\\/g, "/"),
		manifestPath: relative(getProjectDirectory(), status.manifestPath).replace(/\\/g, "/"),
		result,
	};
}

/** Returns exact-fingerprint animation resampling, compression, loop, root-motion, and controller-validation evidence. */
export async function getAnimationImporterResult(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Animation importer results are available only for existing file assets.");
	}
	return portableAnimationImporterStatus(await getAnimationImporterArtifactStatus(absolutePath), absolutePath);
}

/** Applies one leased Animation Importer and atomically publishes its processed clip/controller artifact. */
export async function applyAnimationImporter(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Applying an animation importer requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Animation importers can only be applied to existing file assets.");
	}
	const status = await applyAnimationImporterArtifact(absolutePath, data.expectedFingerprint);
	refreshAssetsBrowser(options);
	return { applied: true, ...portableAnimationImporterStatus(status, absolutePath) };
}

/** Inspects a current converted Unity Animator Controller artifact and resolves exact Unity GUID/fileID scene binding suggestions without modifying the scene. */
export async function getAnimatorControllerAssetImport(scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Animator Controller imports are available only for existing .controller or .animator file assets.");
	}
	const status = await getAnimationImporterArtifactStatus(absolutePath);
	const portable = portableAnimationImporterStatus(status, absolutePath);
	if (!status.current || !status.result) {
		return { ...portable, ready: false, reason: "Apply the Animation Importer with the current fingerprint before importing this controller into the scene." };
	}
	if (!status.result.valid) {
		return { ...portable, ready: false, reason: "The converted controller has importer errors. Resolve them and apply the importer again." };
	}
	const document = await readJSON(status.result.outputPath);
	if (!isImportedAnimatorControllerDocument(document) || document.sourceFormat !== "unity-yaml") {
		return { ...portable, ready: false, reason: "This artifact is not a converted Unity YAML Animator Controller." };
	}
	const bindings = await getUnityAnimatorControllerBindingPlan(scene, document, status.fingerprint, {
		targetNodeId: data.targetNodeId,
		targetNodeName: data.targetNodeName,
	});
	return {
		...portable,
		ready: bindings.unresolvedMotionBindings.length === 0 && bindings.unresolvedAvatarMaskBindings.length === 0 && bindings.unresolvedBehaviourBindings.length === 0,
		controller: document.controller,
		unsupportedFeatures: document.unsupportedFeatures,
		...bindings,
		existingControllerNames: ((scene.metadata?.babylonEditorAnimatorControllers ?? []) as Array<{ name: string }>).map((controller) => controller.name).sort(),
	};
}

function replaceAnimatorControllerBindings(
	controller: any,
	motionMappings: Record<string, string>,
	avatarMaskMappings: Record<string, string>,
	behaviourMappings: Record<string, string>,
	behaviourPlans: Awaited<ReturnType<typeof getUnityAnimatorControllerBindingPlan>>["behaviourBindings"],
	ignoreMasks: boolean
): any {
	const result = structuredClone(controller);
	const behaviourPlansByKey = new Map(behaviourPlans.map((binding) => [binding.key, binding]));
	const replaceMotion = (motion: any): void => {
		if (motion.animationGroup?.startsWith("@unity-motion:")) {
			motion.animationGroup = motionMappings[motion.animationGroup];
		}
		for (const child of motion.blendTree?.children ?? []) {
			if (child.animationGroup?.startsWith("@unity-motion:")) {
				child.animationGroup = motionMappings[child.animationGroup];
			} else if (child.blendTree) {
				replaceMotion(child);
			}
		}
	};
	const replaceBehaviours = (behaviours: any[] | undefined): any[] | undefined =>
		behaviours?.map((behaviour) => {
			if (!behaviour.scriptKey?.startsWith("@unity-behaviour:")) {
				return behaviour;
			}
			const binding = behaviourPlansByKey.get(behaviour.scriptKey);
			const scriptKey = behaviourMappings[behaviour.scriptKey];
			if (!binding || !scriptKey) {
				throw new Error(`Unity behaviour binding "${behaviour.scriptKey}" was not resolved by the current import plan.`);
			}
			return {
				...behaviour,
				scriptKey,
				unitySource: {
					bindingKey: binding.key,
					behaviourFileId: binding.behaviourFileId,
					behaviourGuid: binding.behaviourGuid,
					scriptFileId: binding.scriptFileId,
					scriptGuid: binding.scriptGuid,
					scriptPath: binding.dependency?.path ?? null,
					scriptContentHash: binding.dependency?.contentHash ?? null,
					scriptMetaHash: binding.dependency?.metaHash ?? null,
					behaviourName: binding.behaviourName,
					editorClassIdentifier: binding.editorClassIdentifier,
					serializedFieldsJson: binding.serializedFieldsJson,
				},
			};
		});
	const machines = [result, ...(result.layers ?? []), ...(result.subgraphs ?? [])];
	for (const machine of machines) {
		machine.behaviours = replaceBehaviours(machine.behaviours);
		for (const state of machine.states ?? []) {
			replaceMotion(state);
			state.behaviours = replaceBehaviours(state.behaviours);
		}
		for (const motionOverride of Object.values(machine.synchronizedMotionOverrides ?? {}) as any[]) {
			replaceMotion(motionOverride);
		}
		for (const [stateName, behaviours] of Object.entries(machine.synchronizedBehaviourOverrides ?? {}) as Array<[string, any[]]>) {
			machine.synchronizedBehaviourOverrides[stateName] = replaceBehaviours(behaviours) ?? [];
		}
		if (machine.avatarMaskId?.startsWith("@unity-mask:")) {
			const mapped = avatarMaskMappings[machine.avatarMaskId];
			if (mapped) {
				machine.avatarMaskId = mapped;
			} else if (ignoreMasks) {
				delete machine.avatarMaskId;
			}
		}
	}
	return result;
}

/** Imports a converted Unity YAML Animator Controller into scene metadata after exact artifact and external-reference binding validation. */
export async function importAnimatorControllerAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Importing an Animator Controller into the scene requires confirm=true.");
	}
	const absolutePath = resolveProjectPath(data.path);
	const status = await getAnimationImporterArtifactStatus(absolutePath);
	if (!status.current || !status.result?.valid) {
		throw new Error("Apply a valid current Animation Importer artifact before importing this Animator Controller into the scene.");
	}
	const document = await readJSON(status.result.outputPath);
	if (!isImportedAnimatorControllerDocument(document) || document.sourceFormat !== "unity-yaml") {
		throw new Error("The current artifact is not a converted Unity YAML Animator Controller.");
	}
	const plan = await getUnityAnimatorControllerBindingPlan(scene, document, status.fingerprint, {
		targetNodeId: data.targetNodeId,
		targetNodeName: data.targetNodeName,
	});
	if (plan.fingerprint !== data.expectedFingerprint) {
		throw new Error(`Animator Controller import plan changed. Inspect again and use current fingerprint ${plan.fingerprint}.`);
	}
	const requestedMotionMappings = (data.motionBindings ?? {}) as Record<string, string>;
	const requestedMaskMappings = (data.avatarMaskBindings ?? {}) as Record<string, string>;
	const requestedBehaviourMappings = (data.behaviourBindings ?? {}) as Record<string, string>;
	const knownMotionKeys = new Set(plan.motionBindings.map((binding) => binding.key));
	const knownMaskKeys = new Set(plan.avatarMaskBindings.map((binding) => binding.key));
	const knownBehaviourKeys = new Set(plan.behaviourBindings.map((binding) => binding.key));
	const unknownMotionKeys = Object.keys(requestedMotionMappings).filter((key) => !knownMotionKeys.has(key));
	const unknownMaskKeys = Object.keys(requestedMaskMappings).filter((key) => !knownMaskKeys.has(key));
	const unknownBehaviourKeys = Object.keys(requestedBehaviourMappings).filter((key) => !knownBehaviourKeys.has(key));
	if (unknownMotionKeys.length || unknownMaskKeys.length || unknownBehaviourKeys.length) {
		throw new Error(`Animator Controller bindings contain unknown keys: ${[...unknownMotionKeys, ...unknownMaskKeys, ...unknownBehaviourKeys].join(", ")}.`);
	}
	const motionMappings: Record<string, string> = {};
	for (const binding of plan.motionBindings) {
		const groupName = requestedMotionMappings[binding.key] ?? binding.suggestedMatch;
		if (!groupName || !scene.getAnimationGroupByName(groupName)) {
			throw new Error(`Unity Motion binding "${binding.key}" is unresolved. Map it to one of: ${plan.availableAnimationGroups.join(", ") || "no Animation Groups exist"}.`);
		}
		motionMappings[binding.key] = groupName;
	}
	const avatarMaskMappings: Record<string, string> = {};
	const importedAvatarMasks: any[] = [];
	scene.metadata ??= {};
	const sceneMasks = (scene.metadata.babylonEditorHumanoidAvatarMasks ??= []);
	for (const binding of plan.avatarMaskBindings) {
		const maskId = requestedMaskMappings[binding.key] ?? binding.suggestedMatch;
		if (!maskId && data.ignoreUnresolvedAvatarMasks !== true) {
			throw new Error(`Unity AvatarMask binding "${binding.key}" is unresolved. Provide avatarMaskBindings or set ignoreUnresolvedAvatarMasks=true explicitly.`);
		}
		if (maskId && !plan.availableAvatarMasks.some((mask: any) => mask.id === maskId)) {
			if (binding.autoImport?.maskId !== maskId) {
				throw new Error(`Avatar Mask id "${maskId}" was not found in the current scene.`);
			}
			const importedMask = createImportedUnityAvatarMask(binding);
			if (sceneMasks.some((mask: any) => mask.id === importedMask.id)) {
				throw new Error(`Automatic Unity AvatarMask id "${importedMask.id}" conflicts with an existing scene mask.`);
			}
			const staged = importedAvatarMasks.find((mask) => mask.id === importedMask.id);
			if (staged && JSON.stringify(staged) !== JSON.stringify(importedMask)) {
				throw new Error(`Unity AvatarMask bindings produce conflicting content for id "${importedMask.id}".`);
			}
			if (!staged) {
				importedAvatarMasks.push(importedMask);
			}
		}
		if (maskId) {
			avatarMaskMappings[binding.key] = maskId;
		}
	}
	const behaviourMappings: Record<string, string> = {};
	if (plan.behaviourBindings.length && !plan.selectedScriptTarget) {
		throw new Error("Unity behaviour import requires targetNodeId or unique targetNodeName from the inspected plan.");
	}
	const attachedKeys = new Set(plan.selectedScriptTarget?.attachedScriptKeys ?? []);
	for (const binding of plan.behaviourBindings) {
		const scriptKey = requestedBehaviourMappings[binding.key] ?? binding.suggestedMatch;
		if (!scriptKey || !attachedKeys.has(scriptKey)) {
			throw new Error(
				`Unity behaviour binding "${binding.key}" is unresolved. Map it to a script attached to "${plan.selectedScriptTarget?.name ?? "the selected target"}": ${[...attachedKeys].join(", ") || "no scripts are attached"}.`
			);
		}
		behaviourMappings[binding.key] = scriptKey;
	}
	const controller = replaceAnimatorControllerBindings(
		document.controller,
		motionMappings,
		avatarMaskMappings,
		behaviourMappings,
		plan.behaviourBindings,
		data.ignoreUnresolvedAvatarMasks === true
	);
	if (plan.selectedScriptTarget) {
		controller.targetNodeId = plan.selectedScriptTarget.id;
	}
	if (data.controllerName) {
		controller.name = data.controllerName;
	}
	const existing = ((scene.metadata?.babylonEditorAnimatorControllers ?? []) as Array<{ id: string; name: string }>).find((candidate) => candidate.name === controller.name);
	let imported: any;
	let replaced = false;
	try {
		sceneMasks.push(...importedAvatarMasks);
		if (existing) {
			if (data.replaceExisting !== true) {
				throw new Error(`Animator controller "${controller.name}" already exists. Set replaceExisting=true to update it atomically.`);
			}
			imported = setAnimatorController(scene, { controllerId: existing.id, ...controller }, options);
			replaced = true;
		} else {
			imported = createAnimatorController(scene, { ...controller, playOnCreate: data.playOnImport === true }, options);
		}
	} catch (error) {
		for (const mask of importedAvatarMasks) {
			const index = sceneMasks.indexOf(mask);
			if (index !== -1) {
				sceneMasks.splice(index, 1);
			}
		}
		throw error;
	}
	return {
		imported: true,
		replaced,
		controller: imported,
		fingerprint: plan.fingerprint,
		artifactFingerprint: status.fingerprint,
		motionBindings: motionMappings,
		avatarMaskBindings: avatarMaskMappings,
		behaviourBindings: behaviourMappings,
		selectedScriptTarget: plan.selectedScriptTarget,
		importedAvatarMasks,
		ignoredAvatarMaskBindings:
			data.ignoreUnresolvedAvatarMasks === true ? plan.avatarMaskBindings.filter((binding: any) => !avatarMaskMappings[binding.key]).map((binding: any) => binding.key) : [],
		unsupportedFeatures: document.unsupportedFeatures,
	};
}

/** Atomically updates bounded project-local tags and favorite state for one or more assets. */
export async function setAssetOrganization(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const paths = [...new Set<string>(data.paths ?? [])];
	if (!paths.length) {
		throw new Error("Provide at least one project-relative asset path.");
	}
	const updated: Array<{ path: string; tags: string[]; favorite: boolean }> = [];
	for (const path of paths) {
		const absolutePath = resolveProjectPath(path);
		if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
			throw new Error(`Asset organization can only be set on existing files: ${path}`);
		}
		const metadata = await readAssetMetadata(absolutePath);
		const next = await writeAssetMetadata(absolutePath, { ...metadata, tags: data.tags ?? metadata.tags, favorite: data.favorite ?? metadata.favorite });
		updated.push({ path: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"), tags: next.tags, favorite: next.favorite });
	}
	await refreshAssetRegistryPaths(paths);
	refreshAssetsBrowser(options);
	return { updated };
}

/** Returns persisted organization and import health for one indexed asset. */
export async function getAssetImportStatus(_scene: Scene, data: any): Promise<any> {
	const entry = await getIndexedAssetRecord(data.path);
	const metadata = await readAssetMetadata(resolveProjectPath(entry.path));
	return { path: entry.path, guid: entry.guid, tags: entry.tags, favorite: entry.favorite, originPath: metadata.originPath ?? null, importState: entry.importState };
}

/** Rechecks recorded source fingerprints and persists current/stale/missing/error states. */
export async function refreshAssetImportStates(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const requested = data.paths ? [...new Set<string>(data.paths)] : null;
	const entries = requested ? await Promise.all(requested.map((path) => getIndexedAssetRecord(path))) : (await queryAssetRegistry({ limit: 500 })).entries;
	const imported = entries.filter((entry: any) => entry.importState.status !== "native");
	const refreshed: Array<{ path: string; status: string }> = [];
	for (const entry of imported) {
		const absolutePath = resolveProjectPath(entry.path);
		const metadata = await readAssetMetadata(absolutePath);
		metadata.importState = await inspectAssetImportState(metadata);
		await writeAssetMetadata(absolutePath, metadata);
		refreshed.push({ path: entry.path, status: metadata.importState.status });
	}
	if (refreshed.length) {
		await refreshAssetRegistryPaths(refreshed.map((entry) => entry.path));
	}
	refreshAssetsBrowser(options);
	return {
		refreshed,
		counts: Object.fromEntries([...new Set(refreshed.map((entry) => entry.status))].map((status) => [status, refreshed.filter((entry) => entry.status === status).length])),
	};
}

/** Lists bounded persisted import problems without touching external sources. */
export async function listAssetImportDiagnostics(_scene: Scene, data: any): Promise<any> {
	const statuses = data.status ? [data.status] : ["stale", "missing", "error", "unchecked"];
	const result = await queryAssetRegistry({ query: data.query, offset: 0, limit: 500 });
	const diagnostics = result.entries
		.filter((entry: any) => statuses.includes(entry.importState.status))
		.map((entry: any) => ({
			path: entry.path,
			guid: entry.guid,
			status: entry.importState.status,
			checkedAt: entry.importState.checkedAt ?? null,
			error: entry.importState.error ?? null,
		}));
	const offset = Math.max(0, data.offset ?? 0);
	const limit = Math.min(500, Math.max(1, data.limit ?? 100));
	return {
		diagnostics: diagnostics.slice(offset, offset + limit),
		totalCount: diagnostics.length,
		offset,
		limit,
		hasMore: offset + limit < diagnostics.length,
		nextOffset: offset + limit < diagnostics.length ? offset + limit : null,
	};
}

/** Lists named importer presets persisted with the project. */
export async function listAssetImporterPresets(): Promise<any> {
	return { presets: structuredClone(await readImporterPresets()) };
}

/** Creates or replaces a named importer preset with optional labels and extension restrictions. */
export async function setAssetImporterPreset(_scene: Scene, data: any): Promise<any> {
	if (!data.name?.trim()) {
		throw new Error("Importer presets require a name.");
	}
	if (!data.importer || typeof data.importer !== "object" || Array.isArray(data.importer)) {
		throw new Error("Importer presets require an importer settings object.");
	}
	const extensions = [...new Set((data.extensions ?? []).map((extension: string) => extension.replace(/^\./, "").toLowerCase()))];
	if (extensions.some((extension) => !extension)) {
		throw new Error("Importer preset extensions must be non-empty file extensions.");
	}
	const kind = (data.kind as AssetImporterKind | undefined) ?? (extensions[0] ? inferAssetImporterKind(`asset.${extensions[0]}`) : "custom");
	if (extensions.some((extension) => inferAssetImporterKind(`asset.${extension}`) !== kind)) {
		throw new Error("All importer preset extensions must use the same importer kind.");
	}
	const validationPath = extensions[0]
		? `asset.${extensions[0]}`
		: `asset.${kind === "custom" ? "custom" : listAssetImporterDefinitions().find((definition) => definition.kind === kind)?.extensions[0]}`;
	const importer = mergeImporterConfiguration(validationPath, getDefaultAssetImporterConfiguration(kind), data.importer, true);
	const value = { name: data.name.trim(), kind, importer, labels: [...new Set(data.labels ?? [])].sort(), extensions };
	const presets = await readImporterPresets();
	const index = presets.findIndex((preset) => preset.name === value.name);
	if (index === -1) {
		presets.push(value);
	} else {
		presets[index] = value;
	}
	await writeImporterPresets(presets);
	return structuredClone(value);
}

/** Deletes one named importer preset without affecting asset sidecars that already used it. */
export async function deleteAssetImporterPreset(_scene: Scene, data: any): Promise<any> {
	const presets = await readImporterPresets();
	const index = presets.findIndex((preset) => preset.name === data.name);
	if (index === -1) {
		throw new Error(`Importer preset "${data.name}" was not found.`);
	}
	presets.splice(index, 1);
	await writeImporterPresets(presets);
	return { deleted: true, name: data.name };
}

/** Applies one named importer preset to file assets, retaining each sidecar GUID and source information. */
export async function applyAssetImporterPreset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const preset = (await readImporterPresets()).find((candidate) => candidate.name === data.name);
	if (!preset) {
		throw new Error(`Importer preset "${data.name}" was not found.`);
	}
	const paths = [...new Set<string>(data.paths ?? [])];
	if (!paths.length) {
		throw new Error("Provide at least one project-relative asset path.");
	}
	const applied: string[] = [];
	for (const path of paths) {
		const absolutePath = resolveProjectPath(path);
		if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
			throw new Error(`Importer presets can only be applied to existing files: ${path}`);
		}
		const extension = extname(absolutePath).replace(/^\./, "").toLowerCase();
		if (preset.extensions.length && !preset.extensions.includes(extension)) {
			throw new Error(`Importer preset "${preset.name}" does not support .${extension} assets: ${path}`);
		}
		const existing = await readAssetMetadata(absolutePath);
		await writeAssetMetadata(absolutePath, {
			...existing,
			labels: data.mergeLabels === false ? preset.labels : [...existing.labels, ...preset.labels],
			importer: mergeImporterConfiguration(absolutePath, existing.importer, preset.importer, data.replaceImporter === true),
		});
		applied.push(relative(getProjectDirectory(), absolutePath));
	}
	await refreshAssetRegistryPaths(paths);
	refreshAssetsBrowser(options);
	return { preset: preset.name, applied, replaceImporter: data.replaceImporter === true, mergeLabels: data.mergeLabels !== false };
}

/** Reimports an asset from its recorded absolute import source, retaining GUID and metadata. */
export async function reimportAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
		throw new Error("Only an existing file asset can be reimported.");
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (!metadata.originPath) {
		throw new Error("This asset has no recorded import source. Import it with import_asset first, or choose a different asset.");
	}
	try {
		if (!(await pathExists(metadata.originPath))) {
			throw new Error("Recorded import source is unavailable.");
		}
		await copy(metadata.originPath, absolutePath, { overwrite: true });
	} catch (error) {
		const at = new Date().toISOString();
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
		metadata.importState = {
			status: "error",
			checkedAt: at,
			error: { code: "REIMPORT_FAILED", message, at },
		};
		await writeAssetMetadata(absolutePath, metadata);
		await refreshAssetRegistryPaths([absolutePath]);
		refreshAssetsBrowser(options);
		throw new Error(`Reimport failed: ${message}`);
	}
	metadata.reimportedAt = new Date().toISOString();
	metadata.importState = await inspectAssetImportState({ ...metadata, importState: { status: "unchecked" } });
	await writeAssetMetadata(absolutePath, metadata);
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);
	return { reimported: true, path: relative(getProjectDirectory(), absolutePath), metadata };
}

/**
 * Copies a local file or folder into the open project without modifying the source.
 */
export async function importAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!isAbsolute(data.sourcePath)) {
		throw new Error("sourcePath must be an absolute path to a local file or folder.");
	}

	const sourcePath = normalize(data.sourcePath);
	if (!(await pathExists(sourcePath))) {
		throw new Error(`Import source not found: ${data.sourcePath}`);
	}

	const destinationPath = resolveProjectPath(data.destinationPath ?? join("assets", basename(sourcePath)));
	if (await pathExists(destinationPath)) {
		throw new Error(`An asset or folder already exists at: ${relative(getProjectDirectory(), destinationPath)}`);
	}
	const placement = await inspectAssetRootPlacement(sourcePath, destinationPath, join(getProjectDirectory(), "assets"));
	if (!placement.allowed) {
		throw new Error(assetRootPlacementError(placement));
	}

	await mkdir(dirname(destinationPath), { recursive: true });
	await copy(sourcePath, destinationPath, { errorOnExist: true });
	const importedDetails = await stat(destinationPath);
	if (!importedDetails.isDirectory()) {
		await writeAssetMetadata(destinationPath, {
			guid: randomUUID(),
			labels: data.labels ?? [],
			importer: data.importer ? normalizeAssetImporterConfiguration(destinationPath, data.importer, true) : getDefaultAssetImporterConfiguration(destinationPath),
			originPath: sourcePath,
			importedAt: new Date().toISOString(),
			importState: { status: "unchecked" },
		});
		const metadata = await readAssetMetadata(destinationPath);
		metadata.importState = await inspectAssetImportState(metadata);
		await writeAssetMetadata(destinationPath, metadata);
	}
	await refreshAssetRegistryPaths([destinationPath]);
	refreshAssetsBrowser(options);

	return {
		imported: true,
		path: relative(getProjectDirectory(), destinationPath),
		isDirectory: importedDetails.isDirectory(),
		type: importedDetails.isDirectory() ? null : getAssetTypeFromExtension(extname(destinationPath)),
	};
}

/**
 * Returns the folder "editor_preview" image (or the asset itself if it is an image) as base64.
 */
export async function getAssetPreview(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);

	let previewPath: string | null = null;

	const extension = extname(absolutePath).replace(".", "").toLowerCase();
	if (["png", "jpg", "jpeg", "bmp"].includes(extension)) {
		previewPath = absolutePath;
	} else {
		const folder = (await pathExists(absolutePath)) && extname(absolutePath) === "" ? absolutePath : dirname(absolutePath);
		const files = await readdir(folder);
		const preview = files.find((f) => f.startsWith("editor_preview") && (f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".bmp")));
		if (preview) {
			previewPath = join(folder, preview);
		}
	}

	if (!previewPath || !(await pathExists(previewPath))) {
		throw new Error(`No preview found for asset: ${data.path}`);
	}

	const buffer = await readFile(previewPath);
	const previewExtension = extname(previewPath).replace(".", "").toLowerCase();
	const mimeType = previewExtension === "png" ? "image/png" : previewExtension === "bmp" ? "image/bmp" : "image/jpeg";

	return {
		imageBase64: buffer.toString("base64"),
		mimeType,
	};
}

/**
 * Converts a project image into a runtime texture or a portable raw RGBA bitmap.
 * Raw bitmap output has an adjacent JSON descriptor with width, height, channels and pixel format.
 */
export async function convertImageAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const sourcePath = resolveProjectPath(data.sourcePath);
	const outputPath = resolveProjectPath(data.outputPath);
	if (!(await pathExists(sourcePath))) {
		throw new Error(`Image asset not found: ${data.sourcePath}`);
	}
	if (!IMAGE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
		throw new Error("sourcePath must be a supported raster, SVG, Radiance HDR, or OpenEXR image asset.");
	}
	if (await pathExists(outputPath)) {
		throw new Error(`An asset already exists at: ${data.outputPath}`);
	}

	const format = data.format;
	const extension = extname(outputPath).toLowerCase();
	const expectedExtensions: Record<string, string[]> = { png: [".png"], jpeg: [".jpg", ".jpeg"], webp: [".webp"], bitmap: [".rgba"] };
	if (!expectedExtensions[format]?.includes(extension)) {
		throw new Error(`outputPath must end in ${expectedExtensions[format]?.join(" or ")} for format "${format}".`);
	}

	let image = (await openProjectImage(sourcePath, { animated: false })).rotate();
	if (data.width || data.height) {
		image = image.resize({ width: data.width, height: data.height, fit: data.fit ?? "inside", withoutEnlargement: data.withoutEnlargement ?? false });
	}
	await mkdir(dirname(outputPath), { recursive: true });

	let metadata: any;
	let bitmapDescriptorPath: string | null = null;
	if (format === "bitmap") {
		const output = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		await writeFile(outputPath, output.data);
		metadata = { ...output.info, size: output.data.byteLength };
		bitmapDescriptorPath = `${outputPath}.json`;
		await writeJSON(
			bitmapDescriptorPath,
			{
				version: 1,
				sourcePath: relative(getProjectDirectory(), sourcePath),
				width: metadata.width,
				height: metadata.height,
				channels: metadata.channels,
				pixelFormat: "rgba8",
				byteLength: metadata.size,
			},
			{ spaces: "\t" }
		);
	} else {
		const pipeline = format === "png" ? image.png() : format === "jpeg" ? image.jpeg({ quality: data.quality ?? 90 }) : image.webp({ quality: data.quality ?? 90 });
		metadata = await pipeline.toFile(outputPath);
	}
	await refreshAssetRegistryPaths(bitmapDescriptorPath ? [outputPath, bitmapDescriptorPath] : [outputPath]);

	refreshAssetsBrowser(options);
	return {
		converted: true,
		sourcePath: relative(getProjectDirectory(), sourcePath),
		outputPath: relative(getProjectDirectory(), outputPath),
		format,
		width: metadata.width,
		height: metadata.height,
		sizeBytes: metadata.size,
		bitmapDescriptorPath: bitmapDescriptorPath ? relative(getProjectDirectory(), bitmapDescriptorPath) : null,
	};
}

/**
 * Loads a mesh asset into the scene (drag'n'drop equivalent). glTF assets are auto-scaled (x100) by the import path.
 */
export async function instantiateMeshAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);

	let importPath = absolutePath;
	let processedModel = false;
	try {
		const artifact = await getModelImporterArtifactStatus(absolutePath);
		if (artifact.current && artifact.result?.valid && artifact.result.outputPath) {
			importPath = artifact.result.outputPath;
			processedModel = true;
		}
	} catch {
		// Assets without a current model artifact use the normal live importer path.
	}
	if (!processedModel && extname(importPath).toLowerCase() === ".blend") {
		importPath = await tryConvertBlendFileLocally(importPath);
	}
	const result = await loadImportedSceneFile(scene, importPath, { processedModel });
	if (!result) {
		throw new Error(`Failed to load mesh asset: ${data.path}`);
	}

	const root = result.meshes.find((m) => m.parent === null) ?? result.meshes[0];

	let parent: any = null;
	if (data.parentId || data.parentName) {
		parent = resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName });
	}

	if (root) {
		if (parent) {
			root.parent = parent;
		}

		if (data.name) {
			root.name = data.name;
		}

		if (data.position) {
			root.position.copyFrom(toVector3(data.position));
		}
	}

	options.editor.layout.graph.refresh().then(() => {
		if (root) {
			options.editor.layout.graph.setSelectedNode(root);
		}
	});

	if (root) {
		options.editor.layout.inspector.setEditedObject(root);
	}

	const createdNodes = [...result.meshes, ...result.transformNodes, ...result.lights];

	return {
		rootNodeId: root?.id ?? null,
		createdNodes: createdNodes.map((node) => toNodeSummary(node)),
	};
}

/**
 * Creates a directory inside the open project.
 */
export async function createAssetFolder(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (await pathExists(absolutePath)) {
		throw new Error(`An asset or folder already exists at: ${data.path}`);
	}

	await mkdir(absolutePath, { recursive: true });
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);

	return { created: true, path: relative(getProjectDirectory(), absolutePath) };
}

/**
 * Inspects an identity-preserving semantic asset move without changing project files.
 */
export async function inspectAssetMovePlan(_scene: Scene, data: any): Promise<any> {
	return inspectSemanticAssetMove(data);
}

/** Applies an exact inspected semantic asset-move plan. */
export async function applyAssetMovePlan(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!data.expectedPlanFingerprint) {
		throw new Error("Apply requires the exact expectedPlanFingerprint returned by inspect_asset_move.");
	}
	return moveAsset(_scene, data, options);
}

/**
 * Renames or moves an asset through the GUID-leased semantic rewrite transaction.
 */
export async function moveAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const sourcePath = resolveProjectPath(data.sourcePath);
	const destinationPath = resolveProjectPath(data.destinationPath);
	const result = await applySemanticAssetMove({
		sourcePath: data.sourcePath,
		destinationPath: data.destinationPath,
		expectedPlanFingerprint: data.expectedPlanFingerprint,
		allowUnsupportedReferences: data.allowUnsupportedReferences === true,
		updateReferences: data.updateReferences ?? data.updateTextReferences !== false,
	});
	await refreshAssetRegistryPaths([sourcePath, destinationPath, ...result.updatedReferences]);
	await options.editor.layout.assets.handleFileRenamed(sourcePath, destinationPath);
	refreshAssetsBrowser(options);

	return {
		...result,
		updatedTextReferences: result.updatedReferences,
	};
}

/**
 * Deletes an asset or folder after the caller explicitly confirms the destructive operation.
 */
export async function deleteAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting an asset is destructive. Retry with confirm: true after verifying the path.");
	}

	const absolutePath = resolveProjectPath(data.path);
	if (absolutePath === getProjectDirectory()) {
		throw new Error("The project directory cannot be deleted through MCP.");
	}

	if (!(await pathExists(absolutePath))) {
		throw new Error(`Asset not found: ${data.path}`);
	}
	const deletingDirectory = (await stat(absolutePath)).isDirectory();
	const cancelledThumbnailTasks = cancelAssetThumbnailTasks(absolutePath, deletingDirectory);
	const inspector = options.editor.layout.inspector;
	const editedObject = inspector?.state?.editedObject;
	if (inspector && editedObject instanceof FileInspectorObject) {
		const editedRelativePath = relative(absolutePath, editedObject.absolutePath);
		if (editedRelativePath === "" || (deletingDirectory && editedRelativePath !== ".." && !editedRelativePath.startsWith("../") && !isAbsolute(editedRelativePath))) {
			await new Promise<void>((resolveInspector) => inspector.setEditedObject(_scene, resolveInspector));
		}
	}

	const removedArtifacts = await removeAssetPathAndImporterArtifacts(absolutePath);
	clearTextureChannelPreviewStates(absolutePath, deletingDirectory);
	const autoReimportStatusPruned = await removeDeletedPathsFromAutoReimportStatus([absolutePath]);
	await refreshAssetRegistryPaths([absolutePath]);
	refreshAssetsBrowser(options);

	return { deleted: true, path: relative(getProjectDirectory(), absolutePath), ...removedArtifacts, autoReimportStatusPruned, cancelledThumbnailTasks };
}

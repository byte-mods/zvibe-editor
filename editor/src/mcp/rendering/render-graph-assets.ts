import { join, relative } from "path/posix";

import { copy, pathExists, remove } from "fs-extra";
import { Scene, Tools } from "babylonjs";
import { configureCustomRenderPassFrameIsolation, getCustomRenderPassSchedule, ICustomRenderPassDefinition, sortCustomRenderPassGraph } from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";
import { IMCPActionOptions } from "../action";
import {
	readBoundedRenderingAsset,
	renderingAssetHash,
	renderingAssetProjectDirectory,
	renderingAssetRelativePath,
	secureRenderingAssetPath,
	writeAtomicRenderingAsset,
} from "./rendering-asset-file";

const assetType = "babylon-editor-render-graph";
const currentAssetVersion = 2 as const;
const maximumAssetBytes = 4 * 1024 * 1024;
const maximumListedAssets = 512;

export const customRenderGraphAssetAssignmentMetadataKey = "babylonEditorCustomRenderGraphAsset";

interface ICustomRenderGraphAssetV1 {
	version: 1;
	type: typeof assetType;
	name: string;
	passes: ICustomRenderPassDefinition[];
}

interface ICustomRenderGraphAsset {
	version: 2;
	type: typeof assetType;
	id: string;
	name: string;
	revision: number;
	passes: ICustomRenderPassDefinition[];
}

interface ICustomRenderGraphAssetMigration {
	sourceVersion: 1 | 2;
	targetVersion: 2;
	migrationRequired: boolean;
	steps: Array<{ id: "v1-identities-and-version-leases"; message: string }>;
	asset: ICustomRenderGraphAsset;
}

export interface ICustomRenderGraphAssetAssignment {
	version: 1;
	path: string;
	id: string;
	assetRevision: number;
	contentRevision: string;
	savedPassRevision: string;
}

function normalizePasses(value: unknown, path: string): ICustomRenderPassDefinition[] {
	if (!Array.isArray(value)) {
		throw new Error(`Render-graph asset at ${path} must contain a passes array.`);
	}
	const passes = structuredClone(value) as ICustomRenderPassDefinition[];
	try {
		return sortCustomRenderPassGraph(passes);
	} catch (error) {
		throw new Error(`Render-graph asset at ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateSource(value: any, path: string, supportedVersions: Array<1 | 2>): ICustomRenderGraphAssetV1 | ICustomRenderGraphAsset {
	if (!supportedVersions.includes(value?.version) || value?.type !== assetType) {
		throw new Error(`Render-graph asset at ${path} is invalid or uses an unsupported version.`);
	}
	if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 128) {
		throw new Error(`Render-graph asset at ${path} requires a name containing 1–128 characters.`);
	}
	const passes = normalizePasses(value.passes, path);
	if (value.version === 1) {
		return { version: 1, type: assetType, name: value.name.trim(), passes };
	}
	if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 128) {
		throw new Error(`Render-graph asset at ${path} requires a bounded non-empty id.`);
	}
	if (!Number.isInteger(value.revision) || value.revision < 1) {
		throw new Error(`Render-graph asset at ${path} requires a positive integer revision.`);
	}
	return { version: 2, type: assetType, id: value.id, name: value.name.trim(), revision: value.revision, passes };
}

function migrateAsset(value: any, path: string): ICustomRenderGraphAssetMigration {
	const source = validateSource(value, path, [1, 2]);
	if (source.version === currentAssetVersion) {
		return { sourceVersion: 2, targetVersion: 2, migrationRequired: false, steps: [], asset: source };
	}
	const sourceRevision = renderingAssetHash(source);
	const asset = validateSource(
		{
			version: currentAssetVersion,
			type: assetType,
			id: `rendergraph-${sourceRevision.slice(0, 24)}`,
			name: source.name,
			revision: 1,
			passes: source.passes,
		},
		path,
		[2]
	) as ICustomRenderGraphAsset;
	return {
		sourceVersion: 1,
		targetVersion: 2,
		migrationRequired: true,
		steps: [
			{
				id: "v1-identities-and-version-leases",
				message: "Added a deterministic asset identity, revision lease, and normalized current pass defaults without changing graph semantics.",
			},
		],
		asset,
	};
}

async function readAsset(path: unknown): Promise<{
	asset: ICustomRenderGraphAsset;
	absolutePath: string;
	relativePath: string;
	contentRevision: string;
	sourceRevision: string;
	migration: ICustomRenderGraphAssetMigration;
}> {
	const { absolutePath, relativePath, source } = await readBoundedRenderingAsset(path, ".rendergraph.json", "Render-graph asset", maximumAssetBytes);
	const migration = migrateAsset(source, String(path));
	return {
		asset: migration.asset,
		absolutePath,
		relativePath,
		contentRevision: renderingAssetHash(migration.asset),
		sourceRevision: renderingAssetHash(source),
		migration,
	};
}

function passRevision(passes: ICustomRenderPassDefinition[]): string {
	return renderingAssetHash(normalizePasses(passes, "the current scene"));
}

function summary(asset: ICustomRenderGraphAsset, path: string, migration?: ICustomRenderGraphAssetMigration): any {
	const schedule = getCustomRenderPassSchedule(structuredClone(asset.passes));
	return {
		path,
		id: asset.id,
		name: asset.name,
		version: asset.version,
		sourceVersion: migration?.sourceVersion ?? asset.version,
		migrationRequired: migration?.migrationRequired ?? false,
		assetRevision: asset.revision,
		contentRevision: renderingAssetHash(asset),
		passRevision: passRevision(asset.passes),
		passCount: asset.passes.length,
		enabledPassCount: asset.passes.filter((pass) => pass.enabled).length,
		passTypes: Object.fromEntries(["shader", "copy", "raster", "compute"].map((type) => [type, asset.passes.filter((pass) => pass.passType === type).length])),
		resourceCount: schedule.outputs.length,
		allocationCount: schedule.allocationCount,
	};
}

async function writeAsset(absolutePath: string, asset: ICustomRenderGraphAsset): Promise<void> {
	await writeAtomicRenderingAsset(absolutePath, asset, maximumAssetBytes, (source) => {
		validateSource(source, renderingAssetRelativePath(absolutePath), [2]);
	});
}

function scenePasses(scene: Scene): ICustomRenderPassDefinition[] {
	return normalizePasses(scene.metadata?.babylonEditorCustomRenderPasses ?? [], "the current scene");
}

function sceneBasePasses(scene: Scene): ICustomRenderPassDefinition[] {
	return scenePasses(scene).filter((pass) => !pass.rendererFeature);
}

function assignment(scene: Scene): ICustomRenderGraphAssetAssignment | null {
	const value = scene.metadata?.[customRenderGraphAssetAssignmentMetadataKey];
	if (!value || value.version !== 1 || typeof value.path !== "string" || typeof value.id !== "string" || !Number.isInteger(value.assetRevision)) {
		return null;
	}
	return structuredClone(value) as ICustomRenderGraphAssetAssignment;
}

export function getCustomRenderGraphAssetAssignment(scene: Scene): any {
	const value = assignment(scene);
	const currentPassRevision = passRevision(sceneBasePasses(scene));
	return {
		assignment: value,
		currentPassRevision,
		dirty: value ? value.savedPassRevision !== currentPassRevision : false,
	};
}

/** Saves the current scene graph as one reusable versioned project asset. */
export async function saveCustomRenderGraphAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = await secureRenderingAssetPath(data.path, ".rendergraph.json", "Render-graph asset");
	const existing = (await pathExists(absolutePath)) ? await readAsset(data.path) : null;
	if (existing) {
		if (existing.migration.migrationRequired) {
			throw new Error("Migrate the legacy render-graph asset before replacing it.");
		}
		if (data.overwrite !== true) {
			throw new Error(`Render-graph asset exists at ${data.path}. Set overwrite: true and provide expectedRevision to replace it.`);
		}
		if (data.expectedRevision !== existing.contentRevision) {
			throw new Error(`Render-graph asset revision is stale. Expected ${existing.contentRevision}.`);
		}
	}
	const name = (data.assetName ?? existing?.asset.name ?? "Render Graph").trim();
	const asset = validateSource(
		{
			version: currentAssetVersion,
			type: assetType,
			id: existing?.asset.id ?? Tools.RandomId(),
			name,
			revision: existing ? existing.asset.revision + 1 : 1,
			passes: sceneBasePasses(scene),
		},
		String(data.path),
		[2]
	) as ICustomRenderGraphAsset;
	await writeAsset(absolutePath, asset);
	const path = renderingAssetRelativePath(absolutePath);
	const value = summary(asset, path);
	const currentAssignment = assignment(scene);
	if (currentAssignment?.path === path) {
		scene.metadata[customRenderGraphAssetAssignmentMetadataKey] = {
			version: 1,
			path,
			id: asset.id,
			assetRevision: asset.revision,
			contentRevision: value.contentRevision,
			savedPassRevision: value.passRevision,
		} satisfies ICustomRenderGraphAssetAssignment;
	}
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return value;
}

/** Lists valid project render-graph assets with bounded paging and malformed-file evidence. */
export async function listCustomRenderGraphAssets(scene: Scene, data: any): Promise<any> {
	const root = renderingAssetProjectDirectory();
	const paths = (await normalizedGlob(join(root, "**/*.rendergraph.json"), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] })) as string[];
	const assets: any[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const search = data.search?.toLowerCase();
	for (const path of paths.sort().slice(0, maximumListedAssets)) {
		try {
			const value = await readAsset(relative(root, path));
			const item = summary(value.asset, value.relativePath, value.migration);
			if (!search || item.path.toLowerCase().includes(search) || item.name.toLowerCase().includes(search)) {
				assets.push(item);
			}
		} catch (error) {
			if (errors.length < 32) {
				errors.push({ path: relative(root, path).replace(/\\/g, "/"), error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 64;
	return {
		assets: assets.slice(offset, offset + limit),
		page: { total: assets.length, offset, count: Math.max(0, Math.min(limit, assets.length - offset)), hasMore: offset + limit < assets.length },
		errors,
		truncated: paths.length > maximumListedAssets,
		...getCustomRenderGraphAssetAssignment(scene),
	};
}

/** Reads one reusable render-graph asset without changing the scene. */
export async function getCustomRenderGraphAsset(_scene: Scene, data: any): Promise<any> {
	const value = await readAsset(data.path);
	return { ...summary(value.asset, value.relativePath, value.migration), migration: value.migration.steps, asset: structuredClone(value.asset) };
}

/** Dry-runs a deterministic render-graph asset schema migration. */
export async function getCustomRenderGraphAssetMigration(_scene: Scene, data: any): Promise<any> {
	const value = await readAsset(data.path);
	return {
		path: value.relativePath,
		id: value.asset.id,
		name: value.asset.name,
		sourceVersion: value.migration.sourceVersion,
		targetVersion: value.migration.targetVersion,
		migrationRequired: value.migration.migrationRequired,
		sourceRevision: value.sourceRevision,
		targetRevision: value.contentRevision,
		steps: structuredClone(value.migration.steps),
		backupPath: value.migration.migrationRequired ? `${value.relativePath}.v${value.migration.sourceVersion}.${value.sourceRevision.slice(0, 12)}.bak` : null,
	};
}

/** Atomically upgrades one exact legacy asset revision and optionally keeps a content-addressed backup. */
export async function migrateCustomRenderGraphAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	if (data.expectedSourceRevision !== value.sourceRevision) {
		throw new Error(`Render-graph migration revision is stale. Expected ${value.sourceRevision}.`);
	}
	if (!value.migration.migrationRequired) {
		return { migrated: false, path: value.relativePath, version: currentAssetVersion, contentRevision: value.contentRevision, backupPath: null, steps: [] };
	}
	const backupPath = `${value.absolutePath}.v${value.migration.sourceVersion}.${value.sourceRevision.slice(0, 12)}.bak`;
	if (data.backup !== false && !(await pathExists(backupPath))) {
		await copy(value.absolutePath, backupPath, { overwrite: false, errorOnExist: true });
	}
	await writeAsset(value.absolutePath, value.asset);
	options.editor.layout.assets.refresh();
	return {
		migrated: true,
		path: value.relativePath,
		version: currentAssetVersion,
		contentRevision: value.contentRevision,
		backupPath: data.backup === false ? null : renderingAssetRelativePath(backupPath),
		steps: structuredClone(value.migration.steps),
	};
}

/** Assigns an exact reusable asset revision to the scene and rebuilds its active camera from an embedded portable snapshot. */
export async function applyCustomRenderGraphAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!scene.activeCamera) {
		throw new Error("No active camera. Set an active camera before assigning a render-graph asset.");
	}
	const value = await readAsset(data.path);
	if (value.migration.migrationRequired) {
		throw new Error("Migrate the legacy render-graph asset before assigning it.");
	}
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Render-graph asset revision is stale. Expected ${value.contentRevision}.`);
	}
	scene.metadata ??= {};
	const previousPasses = structuredClone(scene.metadata.babylonEditorCustomRenderPasses ?? []);
	const previousAssignment = structuredClone(scene.metadata[customRenderGraphAssetAssignmentMetadataKey] ?? null);
	const basePasses = structuredClone(value.asset.passes);
	const featurePasses = scenePasses(scene).filter((pass) => Boolean(pass.rendererFeature));
	const passes = sortCustomRenderPassGraph([...basePasses, ...featurePasses]);
	const nextAssignment: ICustomRenderGraphAssetAssignment = {
		version: 1,
		path: value.relativePath,
		id: value.asset.id,
		assetRevision: value.asset.revision,
		contentRevision: value.contentRevision,
		savedPassRevision: passRevision(basePasses),
	};
	try {
		scene.metadata.babylonEditorCustomRenderPasses = passes;
		scene.metadata[customRenderGraphAssetAssignmentMetadataKey] = nextAssignment;
		const ordered = configureCustomRenderPassFrameIsolation(scene as any, scene.activeCamera as any, passes, null, getProjectAssetsRootUrl() ?? "");
		options.editor.layout.inspector.forceUpdate();
		return { applied: true, ...summary(value.asset, value.relativePath), assignment: nextAssignment, executionOrder: ordered.executionOrder };
	} catch (error) {
		scene.metadata.babylonEditorCustomRenderPasses = previousPasses;
		scene.metadata[customRenderGraphAssetAssignmentMetadataKey] = previousAssignment;
		try {
			configureCustomRenderPassFrameIsolation(scene as any, scene.activeCamera as any, previousPasses, null, getProjectAssetsRootUrl() ?? "");
		} catch {
			// Preserve the original assignment error; prior graph restoration remains best-effort.
		}
		throw error;
	}
}

/** Writes the current graph back to its exact assigned asset revision. */
export async function updateAssignedCustomRenderGraphAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = assignment(scene);
	if (!value) {
		throw new Error("The current scene has no assigned render-graph asset.");
	}
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Assigned render-graph revision is stale. Expected ${value.contentRevision}.`);
	}
	return saveCustomRenderGraphAsset(scene, { path: value.path, assetName: data.assetName, overwrite: true, expectedRevision: data.expectedRevision }, options);
}

/** Detaches one exact asset assignment while retaining its current embedded graph snapshot. */
export function detachCustomRenderGraphAsset(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = assignment(scene);
	if (!value) {
		throw new Error("The current scene has no assigned render-graph asset.");
	}
	if (data.id !== value.id || data.expectedRevision !== value.contentRevision) {
		throw new Error(`Render-graph assignment lease is stale. Expected id ${value.id} revision ${value.contentRevision}.`);
	}
	delete scene.metadata[customRenderGraphAssetAssignmentMetadataKey];
	options.editor.layout.inspector.forceUpdate();
	return { detached: true, path: value.path, id: value.id, retainedPassCount: scenePasses(scene).length };
}

/** Deletes one unassigned exact project asset revision after literal confirmation. */
export async function deleteCustomRenderGraphAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a render-graph asset requires confirm: true.");
	}
	const value = await readAsset(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Render-graph asset revision is stale. Expected ${value.contentRevision}.`);
	}
	const currentAssignment = assignment(scene);
	if (currentAssignment?.path === value.relativePath) {
		throw new Error("Detach the render-graph asset from the current scene before deleting it.");
	}
	await remove(value.absolutePath);
	options.editor.layout.assets.refresh();
	return { deleted: true, path: value.relativePath, id: value.asset.id, contentRevision: value.contentRevision };
}

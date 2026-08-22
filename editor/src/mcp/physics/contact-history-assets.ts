import { join, relative } from "path/posix";

import { pathExists, remove } from "fs-extra";
import { Scene, Tools } from "babylonjs";

import { normalizedGlob } from "../../tools/fs";
import { IMCPActionOptions } from "../action";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths } from "../assets/registry";
import {
	readBoundedRenderingAsset,
	renderingAssetHash,
	renderingAssetProjectDirectory,
	renderingAssetRelativePath,
	secureRenderingAssetPath,
	writeAtomicRenderingAsset,
} from "../rendering/rendering-asset-file";
import { filterPhysicsContactHistoryEvents, summarizePhysicsContactHistoryEvents, validatePhysicsContactHistoryFilter } from "./contact-history-filters";
import { validatePhysicsContactHistoryAsset } from "./contact-history-model";
import {
	IPhysicsContactHistoryAsset,
	maximumListedPhysicsContactHistories,
	maximumPhysicsContactHistoryBytes,
	physicsContactHistoryAssetType,
	physicsContactHistoryExtension,
	physicsContactHistoryVersion,
} from "./contact-history-types";
import { getPhysicsContactCapture } from "./contacts";

const mutations = new Map<string, Promise<unknown>>();

/** Serializes mutations per canonical path so one exact revision can publish under concurrent callers. */
async function mutate<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = mutations.get(path) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	mutations.set(path, current);
	try {
		return await current;
	} finally {
		if (mutations.get(path) === current) {
			mutations.delete(path);
		}
	}
}

/** Reads and normalizes one bounded project asset before deriving its exact content lease. */
export async function readPhysicsContactHistoryAsset(path: unknown): Promise<{
	asset: IPhysicsContactHistoryAsset;
	absolutePath: string;
	relativePath: string;
	contentRevision: string;
}> {
	const value = await readBoundedRenderingAsset(path, physicsContactHistoryExtension, "Physics contact history", maximumPhysicsContactHistoryBytes);
	const asset = validatePhysicsContactHistoryAsset(value.source, value.relativePath);
	return { asset, absolutePath: value.absolutePath, relativePath: value.relativePath, contentRevision: renderingAssetHash(asset) };
}

/** Returns bounded list/read evidence without duplicating the event payload. */
export function summarizePhysicsContactHistoryAsset(asset: IPhysicsContactHistoryAsset, path: string): any {
	return {
		path,
		id: asset.id,
		name: asset.name,
		version: asset.version,
		assetRevision: asset.revision,
		contentRevision: renderingAssetHash(asset),
		createdAt: asset.createdAt,
		durationMs: asset.durationMs,
		source: structuredClone(asset.source),
		summary: summarizePhysicsContactHistoryEvents(asset.events),
	};
}

/** Writes only a validator-normalized asset through a same-directory atomic replacement. */
async function writeAsset(absolutePath: string, asset: IPhysicsContactHistoryAsset): Promise<void> {
	await writeAtomicRenderingAsset(
		absolutePath,
		asset,
		maximumPhysicsContactHistoryBytes,
		(source) => validatePhysicsContactHistoryAsset(source, renderingAssetRelativePath(absolutePath)),
		"Physics contact history asset"
	);
}

/** Snapshots the active bounded capture as a new asset or exact-leased replacement without stopping capture. */
export async function savePhysicsContactHistory(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = await secureRenderingAssetPath(data.path, physicsContactHistoryExtension, "Physics contact history");
	return mutate(absolutePath, async () => {
		const capture = getPhysicsContactCapture(scene, {}, options);
		if (!capture.active) {
			throw new Error("No physics contact capture is active. Start capture before saving a history.");
		}
		const existing = (await pathExists(absolutePath)) ? await readPhysicsContactHistoryAsset(renderingAssetRelativePath(absolutePath)) : null;
		if (existing && data.expectedRevision !== existing.contentRevision) {
			throw new Error(`Physics contact history revision is stale. Expected ${existing.contentRevision}.`);
		}
		if (!existing && data.expectedRevision !== undefined && data.expectedRevision !== null) {
			throw new Error("A new physics contact history must not provide expectedRevision.");
		}
		const name = data.name ?? existing?.asset.name;
		const asset = validatePhysicsContactHistoryAsset(
			{
				version: physicsContactHistoryVersion,
				type: physicsContactHistoryAssetType,
				id: existing?.asset.id ?? Tools.RandomId(),
				name,
				revision: (existing?.asset.revision ?? 0) + 1,
				createdAt: new Date().toISOString(),
				durationMs: capture.elapsedMs,
				source: {
					target: capture.target,
					scenePath: options.editor.sceneWorkspace?.getSettings().activeScene ?? null,
					includeContinued: capture.includeContinued,
					droppedEvents: capture.droppedEvents,
					capturedBodyCount: capture.capturedBodyCount,
					maxEvents: capture.maxEvents,
				},
				events: capture.events,
			},
			renderingAssetRelativePath(absolutePath)
		);
		await writeAsset(absolutePath, asset);
		await refreshAssetRegistryPaths([absolutePath]);
		options.editor.layout.assets.refresh();
		return { saved: true, created: !existing, ...summarizePhysicsContactHistoryAsset(asset, renderingAssetRelativePath(absolutePath)) };
	});
}

/** Lists at most 512 validated assets and reports malformed files separately without aborting discovery. */
export async function listPhysicsContactHistories(_scene: Scene, data: any = {}): Promise<any> {
	if (data.search !== undefined && typeof data.search !== "string") {
		throw new Error("Physics contact history search must be a string.");
	}
	const search = data.search === undefined ? null : data.search.trim().toLowerCase();
	if (search !== null && (!search || search.length > 128)) {
		throw new Error("Physics contact history search must contain 1–128 characters.");
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 64;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Physics contact history pagination requires offset >= 0 and limit from 1 through 100.");
	}
	const root = renderingAssetProjectDirectory();
	const paths = (await normalizedGlob(join(root, `**/*${physicsContactHistoryExtension}`), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] })) as string[];
	const assets: any[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	let malformedCount = 0;
	for (const path of paths.sort().slice(0, maximumListedPhysicsContactHistories)) {
		try {
			const value = await readPhysicsContactHistoryAsset(relative(root, path));
			const item = summarizePhysicsContactHistoryAsset(value.asset, value.relativePath);
			if (!search || item.path.toLowerCase().includes(search) || item.name.toLowerCase().includes(search)) {
				assets.push(item);
			}
		} catch (error) {
			malformedCount++;
			if (errors.length < 32) {
				errors.push({ path: relative(root, path).replace(/\\/g, "/"), error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return {
		assets: assets.slice(offset, offset + limit),
		page: { total: assets.length, offset, count: Math.max(0, Math.min(limit, assets.length - offset)), hasMore: offset + limit < assets.length },
		errors,
		malformedCount,
		errorsTruncated: malformedCount > errors.length,
		truncated: paths.length > maximumListedPhysicsContactHistories,
	};
}

/** Reads one immutable revision through deterministic filters and bounded event pagination. */
export async function getPhysicsContactHistory(_scene: Scene, data: any): Promise<any> {
	const value = await readPhysicsContactHistoryAsset(data.path);
	const filter = validatePhysicsContactHistoryFilter(data.filter ?? {}, value.asset.durationMs);
	const events = filterPhysicsContactHistoryEvents(value.asset.events, filter);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 100;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("Physics contact history event pagination requires offset >= 0 and limit from 1 through 1000.");
	}
	return {
		...summarizePhysicsContactHistoryAsset(value.asset, value.relativePath),
		filter,
		matchedSummary: summarizePhysicsContactHistoryEvents(events),
		events: events.slice(offset, offset + limit),
		page: { total: events.length, offset, count: Math.max(0, Math.min(limit, events.length - offset)), hasMore: offset + limit < events.length },
	};
}

/** Deletes one exact revision plus its registry sidecar and never guesses through a stale lease. */
export async function deletePhysicsContactHistory(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = await secureRenderingAssetPath(data.path, physicsContactHistoryExtension, "Physics contact history");
	return mutate(absolutePath, async () => {
		const value = await readPhysicsContactHistoryAsset(renderingAssetRelativePath(absolutePath));
		if (data.expectedRevision !== value.contentRevision) {
			throw new Error(`Physics contact history revision is stale. Expected ${value.contentRevision}.`);
		}
		if (data.confirm !== true) {
			throw new Error("Deleting a physics contact history requires confirm: true.");
		}
		const result = summarizePhysicsContactHistoryAsset(value.asset, value.relativePath);
		const { stopPhysicsContactHistoryReplayForAsset } = await import("./contact-history-replay");
		const replayStopped = stopPhysicsContactHistoryReplayForAsset(scene, value.relativePath, options);
		await remove(value.absolutePath);
		const metadataPath = `${value.absolutePath}${ASSET_META_SUFFIX}`;
		await remove(metadataPath);
		await refreshAssetRegistryPaths([value.absolutePath]);
		await remove(metadataPath);
		options.editor.layout.assets.refresh();
		return { deleted: true, ...result, replayStopped, metadataDeleted: !(await pathExists(metadataPath)) };
	});
}

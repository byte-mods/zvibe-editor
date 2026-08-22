import { Scene, Tools } from "babylonjs";
import { configureTerrainStreaming, ITerrainStreamingGroup } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

function groups(scene: Scene): ITerrainStreamingGroup[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorTerrainStreamingGroups ??= [];
	return scene.metadata.babylonEditorTerrainStreamingGroups;
}

function find(scene: Scene, data: any): ITerrainStreamingGroup {
	const result = groups(scene).find((value) => value.id === data.groupId || value.name === data.name);
	if (!result) {
		throw new Error("Terrain streaming group not found.");
	}
	return result;
}

function validateFiniteRange(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isFinite(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be from ${minimum} through ${maximum}.`);
	}
	return Number(value);
}

function validateIntegerRange(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(value);
}

function validateRemoteBaseUrl(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string" || value.length > 2_048) {
		throw new Error("remoteBaseUrl must be at most 2,048 characters.");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("remoteBaseUrl must be an absolute HTTP or HTTPS URL.");
	}
	const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
	if (parsed.protocol !== "https:" && !localHttp) {
		throw new Error("remoteBaseUrl must use HTTPS, except loopback HTTP is allowed for local development.");
	}
	parsed.hash = "";
	parsed.search = "";
	return `${parsed.toString().replace(/\/$/, "")}/`;
}

function validateTerrainIds(scene: Scene, terrainIds: unknown, current?: ITerrainStreamingGroup): string[] {
	if (!Array.isArray(terrainIds) || !terrainIds.length || terrainIds.length > 4_096) {
		throw new Error("A terrain streaming group requires 1 through 4,096 terrain ids.");
	}
	if (terrainIds.some((id) => typeof id !== "string" || !id.length)) {
		throw new Error("terrainIds must contain non-empty strings.");
	}
	const unique = [...new Set(terrainIds as string[])];
	if (unique.length !== terrainIds.length) {
		throw new Error("terrainIds must be unique.");
	}
	for (const terrainId of unique) {
		const terrain = resolveNode({ scene, nodeId: terrainId }) as any;
		if (terrain.metadata?.type !== "Ground") {
			throw new Error(`Node "${terrain.name}" is not an editor Ground terrain.`);
		}
		const owner = groups(scene).find((group) => group !== current && group.terrainIds.includes(terrainId));
		if (owner) {
			throw new Error(`Terrain "${terrain.name}" already belongs to streaming group "${owner.name ?? owner.id}".`);
		}
	}
	return unique;
}

function runtimeEvidence(scene: Scene, group: ITerrainStreamingGroup): any {
	const runtime = (scene as any).terrainStreaming?.getState();
	return {
		configured: !!(scene as any).terrainStreaming,
		tiles: runtime?.tiles.filter((tile) => tile.groupId === (group.id ?? null)) ?? [],
	};
}

function restoreBeforeMutation(scene: Scene, group: ITerrainStreamingGroup): void {
	if (!(scene as any).terrainStreaming) {
		return;
	}
	const enabled = group.enabled;
	group.enabled = false;
	void (scene as any).terrainStreaming.updateAsync();
	group.enabled = enabled;
}

function configure(scene: Scene): void {
	configureTerrainStreaming(scene as any, "");
}

/** Lists persisted distance-based terrain streaming groups plus current preview/runtime tile state. */
export function listTerrainStreamingGroups(scene: Scene): any {
	configure(scene);
	return {
		model: "unity-async-terrain-tile-streaming-v1",
		groups: groups(scene).map((group) => ({ ...structuredClone(group), runtime: runtimeEvidence(scene, group) })),
		limits: { maxGroups: 256, maxTilesPerGroup: 4_096, maxConcurrentLoads: 16, maxRetries: 8, maxRequestTimeoutMs: 120_000 },
	};
}

/** Creates or exact-revision updates a Ground group with embedded or exported asynchronous geometry streaming. */
export function setTerrainStreamingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (groups(scene).length >= 256 && !data.groupId) {
		throw new Error("Terrain streaming is limited to 256 groups.");
	}
	const existing = data.groupId ? find(scene, data) : undefined;
	if (existing && data.expectedRevision !== existing.revision) {
		throw new Error(`Terrain streaming group is stale: expected revision ${data.expectedRevision}, current revision is ${existing.revision}. List groups again.`);
	}
	if (!existing && (typeof data.name !== "string" || !data.name.trim())) {
		throw new Error("A new terrain streaming group requires a name.");
	}
	if (!existing && groups(scene).some((value) => value.name === data.name.trim())) {
		throw new Error(`Terrain streaming group "${data.name.trim()}" already exists.`);
	}
	const name = data.name === undefined ? existing!.name! : String(data.name).trim();
	if (!name || name.length > 128) {
		throw new Error("Terrain streaming group name must contain 1 through 128 characters.");
	}
	if (groups(scene).some((value) => value !== existing && value.name === name)) {
		throw new Error(`Terrain streaming group "${name}" already exists.`);
	}
	const terrainIds = data.terrainIds === undefined ? [...(existing?.terrainIds ?? [])] : validateTerrainIds(scene, data.terrainIds, existing);
	if (!terrainIds.length) {
		throw new Error("A terrain streaming group requires at least one terrain id.");
	}
	const distance = data.distance === undefined ? existing?.distance : validateFiniteRange(data.distance, "distance", 0.001, 1_000_000_000);
	if (distance === undefined) {
		throw new Error("A new terrain streaming group requires distance.");
	}
	const preloadDistance =
		data.preloadDistance === undefined ? (existing?.preloadDistance ?? distance) : validateFiniteRange(data.preloadDistance, "preloadDistance", distance, 1_000_000_000);
	if (preloadDistance < distance) {
		throw new Error("preloadDistance must be greater than or equal to distance.");
	}
	const unloadDistance =
		data.unloadDistance === undefined
			? (existing?.unloadDistance ?? preloadDistance)
			: validateFiniteRange(data.unloadDistance, "unloadDistance", preloadDistance, 1_000_000_000);
	if (unloadDistance < preloadDistance) {
		throw new Error("unloadDistance must be greater than or equal to preloadDistance.");
	}
	if (data.targetNodeId) {
		resolveNode({ scene, nodeId: data.targetNodeId });
	}
	const streamGeometry = data.streamGeometry ?? existing?.streamGeometry ?? false;
	if (streamGeometry && data.releaseGeometry === true) {
		throw new Error("releaseGeometry and streamGeometry are mutually exclusive; streamed tiles unload their fetched geometry directly.");
	}
	const unloadDelayMs = data.unloadDelayMs === undefined ? (existing?.unloadDelayMs ?? 1_000) : validateIntegerRange(data.unloadDelayMs, "unloadDelayMs", 0, 600_000);
	const maxConcurrentLoads =
		data.maxConcurrentLoads === undefined ? (existing?.maxConcurrentLoads ?? 2) : validateIntegerRange(data.maxConcurrentLoads, "maxConcurrentLoads", 1, 16);
	const retryCount = data.retryCount === undefined ? (existing?.retryCount ?? 2) : validateIntegerRange(data.retryCount, "retryCount", 0, 8);
	const requestTimeoutMs =
		data.requestTimeoutMs === undefined ? (existing?.requestTimeoutMs ?? 15_000) : validateIntegerRange(data.requestTimeoutMs, "requestTimeoutMs", 1_000, 120_000);
	const remoteBaseUrl = data.remoteBaseUrl === null ? undefined : data.remoteBaseUrl === undefined ? existing?.remoteBaseUrl : validateRemoteBaseUrl(data.remoteBaseUrl);
	const next: ITerrainStreamingGroup = {
		...existing,
		version: 2,
		revision: (existing?.revision ?? 0) + 1,
		id: existing?.id ?? Tools.RandomId(),
		name,
		terrainIds,
		distance,
		preloadDistance,
		unloadDistance,
		unloadDelayMs,
		maxConcurrentLoads,
		retryCount,
		requestTimeoutMs,
		targetNodeId: data.targetNodeId === null ? undefined : (data.targetNodeId ?? existing?.targetNodeId),
		enabled: data.enabled ?? existing?.enabled ?? true,
		streamGeometry,
		releaseGeometry: streamGeometry ? false : (data.releaseGeometry ?? existing?.releaseGeometry ?? false),
		remoteBaseUrl,
	};
	delete next.tiles;
	let value = next;
	if (existing) {
		restoreBeforeMutation(scene, existing);
		Object.keys(existing).forEach((key) => delete (existing as any)[key]);
		Object.assign(existing, next);
		value = existing;
	} else {
		groups(scene).push(next);
	}
	configure(scene);
	void (scene as any).terrainStreaming?.updateAsync();
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(value), runtime: runtimeEvidence(scene, value) };
}

/** Deletes an exact-revision terrain streaming group and restores all resident authoring tiles. */
export function deleteTerrainStreamingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.expectedRevision !== value.revision) {
		throw new Error(`Terrain streaming group is stale: expected revision ${data.expectedRevision}, current revision is ${value.revision}. List groups again.`);
	}
	restoreBeforeMutation(scene, value);
	groups(scene).splice(groups(scene).indexOf(value), 1);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id, revision: value.revision, restoredTerrainIds: [...value.terrainIds] };
}

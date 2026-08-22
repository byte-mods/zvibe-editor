import { Scene } from "@babylonjs/core/scene";

import { IPortableProfiler2DAtlas, IPortableProfiler2DMetrics, IPortableProfiler2DRegion, IPortableProfiler2DSnapshot } from "./types";

export const PORTABLE_2D_PROFILER_MAXIMUM_ATLASES = 128;
export const PORTABLE_2D_PROFILER_MAXIMUM_SOURCE_REGIONS = 65_536;
export const PORTABLE_2D_PROFILER_MAXIMUM_VISUAL_REGIONS = 4_096;
export const PORTABLE_2D_PROFILER_MAXIMUM_USAGE_RECORDS = 65_536;

interface IAtlasOwner {
	id: string;
	name: string;
	kind: IPortableProfiler2DAtlas["kind"];
	manager: any | null;
	spriteMap: any | null;
	atlas: any;
	texture: any;
	tiles: any[];
}

interface IAtlasUsage {
	usage: Map<string, number>;
	visits: number;
	visibleSpriteCount: number;
	truncated: boolean;
}

function boundedText(value: unknown, fallback: string, maximum = 240): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function boundedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value))) : 0;
}

function safeAdd(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function textureDetails(texture: any): { name: string | null; width: number; height: number; bytes: number; identity: unknown } {
	let size: any = null;
	try {
		size = texture?.getSize?.();
	} catch {
		// A disposed or provider-backed texture can reject a size query; the owner remains visible with zero dimensions.
	}
	const width = boundedInteger(size?.width, 1_048_576);
	const height = boundedInteger(size?.height, 1_048_576);
	const pixels = Math.min(Number.MAX_SAFE_INTEGER, width * height);
	let identity = texture ?? null;
	try {
		identity = texture?.getInternalTexture?.() ?? texture ?? null;
	} catch {
		// Keep object identity when a disposed/provider-backed texture rejects its internal-texture query.
	}
	return {
		name: texture ? boundedText(texture.name ?? texture.url, "Unnamed texture", 1_024) : null,
		width,
		height,
		bytes: Math.min(Number.MAX_SAFE_INTEGER, pixels * 4),
		identity,
	};
}

function atlasFrames(atlas: any): Record<string, any> | null {
	const frames = atlas?.frames;
	return frames && typeof frames === "object" && !Array.isArray(frames) ? frames : null;
}

function frameRectangle(frame: any): { x: number; y: number; width: number; height: number; rotated: boolean } | null {
	const value = frame?.frame ?? frame;
	const width = boundedInteger(value?.w ?? value?.width, 1_048_576);
	const height = boundedInteger(value?.h ?? value?.height, 1_048_576);
	if (!width || !height) {
		return null;
	}
	return {
		x: boundedInteger(value?.x, 1_048_576),
		y: boundedInteger(value?.y, 1_048_576),
		width,
		height,
		rotated: Boolean(frame?.rotated ?? value?.rotated),
	};
}

function collectOwners(scene: Scene): { owners: IAtlasOwner[]; truncated: boolean } {
	const owners: IAtlasOwner[] = [];
	const managerNodes = new Map<any, any>();
	for (const node of scene.transformNodes) {
		if ((node as any).getClassName?.() === "SpriteManagerNode" && (node as any).spriteManager) {
			managerNodes.set((node as any).spriteManager, node);
		}
	}
	const managers = new Set<any>([...((scene as any).spriteManagers ?? []), ...managerNodes.keys()]);
	for (const manager of managers) {
		const node = managerNodes.get(manager);
		owners.push({
			id: boundedText(node?.id ?? manager?.uniqueId, `sprite-manager-${owners.length}`),
			name: boundedText(node?.name ?? manager?.name, `Sprite Manager ${owners.length + 1}`),
			kind: "sprite-manager",
			manager,
			spriteMap: null,
			atlas: node?.atlasJson ?? manager?._spriteMap ?? manager?._cellData ?? null,
			texture: manager?.texture ?? null,
			tiles: [],
		});
	}
	for (const node of scene.transformNodes) {
		if ((node as any).getClassName?.() !== "SpriteMapNode" || !(node as any).spriteMap) {
			continue;
		}
		const spriteMap = (node as any).spriteMap;
		owners.push({
			id: boundedText((node as any).id, `sprite-map-${owners.length}`),
			name: boundedText((node as any).name ?? spriteMap.name, `Sprite Map ${owners.length + 1}`),
			kind: "sprite-map",
			manager: null,
			spriteMap,
			atlas: (node as any).atlasJson ?? spriteMap.atlasJSON ?? null,
			texture: (node as any).spritesheet ?? spriteMap.spriteSheet ?? null,
			tiles: Array.isArray((node as any).tiles) ? (node as any).tiles : [],
		});
	}
	return { owners: owners.slice(0, PORTABLE_2D_PROFILER_MAXIMUM_ATLASES), truncated: owners.length > PORTABLE_2D_PROFILER_MAXIMUM_ATLASES };
}

function boundedFrameEntries(frames: Record<string, any>, limit: number): { entries: Array<[string, any]>; truncated: boolean } {
	const entries: Array<[string, any]> = [];
	for (const name in frames) {
		if (!Object.prototype.hasOwnProperty.call(frames, name)) {
			continue;
		}
		if (entries.length >= limit) {
			return { entries, truncated: true };
		}
		entries.push([name, frames[name]]);
	}
	return { entries, truncated: false };
}

function usageForOwner(owner: IAtlasOwner, frameNames: string[], usageLimit: number): IAtlasUsage {
	const usage = new Map<string, number>();
	if (owner.kind === "sprite-map") {
		const visits = Math.min(owner.tiles.length, usageLimit);
		for (let index = 0; index < visits; index++) {
			const tile = owner.tiles[index];
			const name = boundedText(tile?.tile, "", 240);
			if (name) {
				usage.set(name, (usage.get(name) ?? 0) + 1);
			}
		}
		return { usage, visits, visibleSpriteCount: 0, truncated: owner.tiles.length > visits };
	}
	const sprites = Array.isArray(owner.manager?.sprites) ? owner.manager.sprites : [];
	const visits = Math.min(sprites.length, usageLimit);
	let visibleSpriteCount = 0;
	for (let index = 0; index < visits; index++) {
		const sprite = sprites[index];
		visibleSpriteCount += sprite?.isVisible === false ? 0 : 1;
		const named = typeof sprite?.cellRef === "string" ? sprite.cellRef : null;
		const indexed = Number.isSafeInteger(sprite?.cellIndex) ? (frameNames[sprite.cellIndex] ?? String(sprite.cellIndex)) : null;
		const key = named ?? indexed;
		if (key !== null) {
			usage.set(key, (usage.get(key) ?? 0) + 1);
		}
	}
	return { usage, visits, visibleSpriteCount, truncated: sprites.length > visits };
}

function detailedAtlas(
	owner: IAtlasOwner,
	sourceLimit: number,
	visualLimit: number,
	usageLimit: number
): { atlas: IPortableProfiler2DAtlas; sourceTruncated: boolean; sourceVisits: number; usageTruncated: boolean; usageVisits: number } {
	const texture = textureDetails(owner.texture);
	const frames = atlasFrames(owner.atlas);
	const boundedFrames = frames ? boundedFrameEntries(frames, sourceLimit) : { entries: [], truncated: false };
	const usageResult = usageForOwner(
		owner,
		boundedFrames.entries.map(([name]) => name),
		usageLimit
	);
	const usage = usageResult.usage;
	const regions: IPortableProfiler2DRegion[] = [];
	const warnings: string[] = [];
	let regionCount = 0;
	let usedRegionCount = 0;
	let definedRegionPixels = 0;
	let usedRegionPixels = 0;
	let sourceTruncated = false;
	let sourceVisits = 0;
	const record = (region: IPortableProfiler2DRegion): void => {
		regionCount++;
		const pixels = Math.min(Number.MAX_SAFE_INTEGER, region.width * region.height);
		definedRegionPixels = safeAdd(definedRegionPixels, pixels);
		if (region.used) {
			usedRegionCount++;
			usedRegionPixels = safeAdd(usedRegionPixels, pixels);
		}
		if (regions.length < visualLimit) {
			regions.push(region);
		}
	};
	if (frames) {
		for (const [name, frame] of boundedFrames.entries) {
			sourceVisits++;
			const rectangle = frameRectangle(frame);
			if (!rectangle) {
				warnings.push(`Atlas region "${boundedText(name, "Unnamed region", 120)}" has no valid rectangle.`);
				continue;
			}
			const usageCount = usage.get(name) ?? 0;
			record({ id: name, name: boundedText(name, "Unnamed region"), ...rectangle, used: usageCount > 0, usageCount });
		}
		sourceTruncated = boundedFrames.truncated;
	} else if (owner.kind === "sprite-manager" && texture.width && texture.height) {
		const cellWidth = boundedInteger(owner.manager?.cellWidth ?? owner.manager?._cellWidth, texture.width);
		const cellHeight = boundedInteger(owner.manager?.cellHeight ?? owner.manager?._cellHeight, texture.height);
		if (cellWidth && cellHeight) {
			const columns = Math.max(1, Math.floor(texture.width / cellWidth));
			const rows = Math.max(1, Math.floor(texture.height / cellHeight));
			const total = Math.min(Number.MAX_SAFE_INTEGER, columns * rows);
			const retained = Math.min(total, sourceLimit);
			for (let index = 0; index < retained; index++) {
				sourceVisits++;
				const usageCount = usage.get(String(index)) ?? 0;
				record({
					id: String(index),
					name: `Cell ${index}`,
					x: (index % columns) * cellWidth,
					y: Math.floor(index / columns) * cellHeight,
					width: cellWidth,
					height: cellHeight,
					rotated: false,
					used: usageCount > 0,
					usageCount,
				});
			}
			sourceTruncated = total > retained;
		}
	} else {
		warnings.push("No valid atlas frame data is currently available for this owner.");
	}
	if (!texture.width || !texture.height) {
		warnings.push("Texture dimensions are unavailable while the image is loading or after disposal.");
	}
	if (usageResult.truncated) {
		warnings.push(`Usage evidence is bounded to ${PORTABLE_2D_PROFILER_MAXIMUM_USAGE_RECORDS.toLocaleString()} sprite/tile records across all atlases.`);
	}
	if (sourceTruncated || regions.length < regionCount) {
		warnings.push(
			`The snapshot is bounded to ${PORTABLE_2D_PROFILER_MAXIMUM_SOURCE_REGIONS.toLocaleString()} source and ${PORTABLE_2D_PROFILER_MAXIMUM_VISUAL_REGIONS.toLocaleString()} visual regions across all atlases.`
		);
	}
	const sprites = owner.kind === "sprite-manager" && Array.isArray(owner.manager?.sprites) ? owner.manager.sprites : [];
	const spriteCount = Math.min(Number.MAX_SAFE_INTEGER, sprites.length);
	const visibleSpriteCount = usageResult.visibleSpriteCount;
	const tileCount = owner.kind === "sprite-map" ? Math.min(Number.MAX_SAFE_INTEGER, owner.tiles.length) : 0;
	return {
		atlas: {
			id: owner.id,
			name: owner.name,
			kind: owner.kind,
			textureName: texture.name,
			textureWidth: texture.width,
			textureHeight: texture.height,
			estimatedTextureBytes: texture.bytes,
			regionCount,
			usedRegionCount,
			definedRegionPixels,
			usedRegionPixels,
			occupancyPercent: definedRegionPixels ? Math.min(100, (usedRegionPixels / definedRegionPixels) * 100) : 0,
			spriteCount,
			visibleSpriteCount,
			tileCount,
			estimatedDrawCalls: visibleSpriteCount > 0 || usageResult.truncated || tileCount > 0 ? 1 : 0,
			regions,
			warnings: [...new Set(warnings)].slice(0, 32),
		},
		sourceTruncated,
		sourceVisits,
		usageTruncated: usageResult.truncated,
		usageVisits: usageResult.visits,
	};
}

/** Measures current sprite-atlas allocation and usage without retaining texture pixels or unbounded atlas JSON. */
export function measurePortableProfiler2D(scene: Scene): IPortableProfiler2DSnapshot {
	const collected = collectOwners(scene);
	const detailed: Array<ReturnType<typeof detailedAtlas>> = [];
	let sourceBudget = PORTABLE_2D_PROFILER_MAXIMUM_SOURCE_REGIONS;
	let visualBudget = PORTABLE_2D_PROFILER_MAXIMUM_VISUAL_REGIONS;
	let usageBudget = PORTABLE_2D_PROFILER_MAXIMUM_USAGE_RECORDS;
	for (const owner of collected.owners) {
		const entry = detailedAtlas(owner, sourceBudget, visualBudget, usageBudget);
		detailed.push(entry);
		sourceBudget = Math.max(0, sourceBudget - entry.sourceVisits);
		visualBudget = Math.max(0, visualBudget - entry.atlas.regions.length);
		usageBudget = Math.max(0, usageBudget - entry.usageVisits);
	}
	const textures = new Set<unknown>();
	let texturePixels = 0;
	let estimatedTextureBytes = 0;
	for (const owner of collected.owners) {
		const texture = textureDetails(owner.texture);
		if (texture.identity && !textures.has(texture.identity)) {
			textures.add(texture.identity);
			texturePixels = safeAdd(texturePixels, Math.min(Number.MAX_SAFE_INTEGER, texture.width * texture.height));
			estimatedTextureBytes = safeAdd(estimatedTextureBytes, texture.bytes);
		}
	}
	const atlases = detailed.map((entry) => entry.atlas);
	const metrics: IPortableProfiler2DMetrics = {
		atlasOwners: atlases.length,
		spriteManagers: atlases.filter((atlas) => atlas.kind === "sprite-manager").length,
		spriteMaps: atlases.filter((atlas) => atlas.kind === "sprite-map").length,
		uniqueTextures: textures.size,
		texturePixels,
		estimatedTextureBytes,
		definedRegions: atlases.reduce((total, atlas) => safeAdd(total, atlas.regionCount), 0),
		usedRegions: atlases.reduce((total, atlas) => safeAdd(total, atlas.usedRegionCount), 0),
		definedRegionPixels: atlases.reduce((total, atlas) => safeAdd(total, atlas.definedRegionPixels), 0),
		usedRegionPixels: atlases.reduce((total, atlas) => safeAdd(total, atlas.usedRegionPixels), 0),
		spriteCount: atlases.reduce((total, atlas) => safeAdd(total, atlas.spriteCount), 0),
		visibleSpriteCount: atlases.reduce((total, atlas) => safeAdd(total, atlas.visibleSpriteCount), 0),
		tileCount: atlases.reduce((total, atlas) => safeAdd(total, atlas.tileCount), 0),
		estimatedDrawCalls: atlases.reduce((total, atlas) => safeAdd(total, atlas.estimatedDrawCalls), 0),
	};
	const truncated = collected.truncated || detailed.some((entry) => entry.sourceTruncated || entry.usageTruncated || entry.atlas.regions.length < entry.atlas.regionCount);
	return {
		capturedAt: new Date().toISOString(),
		metrics,
		atlases,
		truncated,
		limitations: [
			"Texture residency is estimated as uncompressed RGBA8 and excludes mipmaps, compression, driver overhead, and non-sprite textures.",
			"Draw calls are a sprite-owner estimate; backend batching, layers, blend states, and visibility can change actual rendering work.",
			...(truncated
				? ["Atlas detail reached a bounded owner, source-region, visual-region, or usage-record ceiling; aggregate evidence covers only the retained evidence set."]
				: []),
		],
	};
}

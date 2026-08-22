import type { NavMesh, NavMeshCreateParams, OffMeshConnectionParams, TileCache, TileCacheMeshProcess, UnsignedCharArray, UnsignedShortArray } from "@recast-navigation/core";
import type { TileCacheGeneratorConfig } from "@recast-navigation/generators";

export type NavMeshRecastRuntime = typeof import("@recast-navigation/core") & typeof import("@recast-navigation/generators");

/** Maps a temporary non-zero Recast raster area to the authored Detour area id stored in the finished NavMesh. */
export interface INavMeshSurfaceAreaEncoding {
	encodedArea: number;
	area: number;
}

export interface INavMeshSurfaceGeometry {
	positions: ArrayLike<number>;
	indices: ArrayLike<number>;
	triangleAreaIds: ArrayLike<number>;
}

export interface INavMeshAreaGeometry {
	area: number;
	positions: number[];
	indices: number[];
	polygonCount: number;
}

export interface INavMeshSurfaceBuildResult {
	success: boolean;
	navMesh?: NavMesh;
	tileCache?: TileCache;
	areaEncoding: INavMeshSurfaceAreaEncoding[];
	error?: string;
}

function validateAreaId(area: number): void {
	if (!Number.isInteger(area) || area < 0 || area > 63) {
		throw new Error(`NavMesh surface area ids must be integers from 0 through 63. Received ${area}.`);
	}
}

/**
 * Recast reserves raster area 0 for non-walkable spans. This creates a compact, deterministic
 * 1..63 encoding so authored Detour area 0 can still participate in raster-time boundaries.
 */
export function createNavMeshSurfaceAreaEncoding(areaIds: ArrayLike<number>): INavMeshSurfaceAreaEncoding[] {
	const authoredAreas = new Set<number>();
	for (let i = 0; i < areaIds.length; i++) {
		const area = areaIds[i];
		validateAreaId(area);
		authoredAreas.add(area);
	}

	const sortedAreas = Array.from(authoredAreas).sort((left, right) => left - right);
	if (sortedAreas.length > 63) {
		throw new Error("A NavMesh can use at most 63 distinct surface areas because Recast reserves raster area 0 as non-walkable.");
	}

	return sortedAreas.map((area, index) => ({ area, encodedArea: index + 1 }));
}

/** Creates the tile-cache callback used both during build and whenever dynamic obstacles rebuild a tile. */
export function createNavMeshSurfaceMeshProcess(
	recast: NavMeshRecastRuntime,
	areaEncoding: readonly INavMeshSurfaceAreaEncoding[] = [],
	offMeshConnections: readonly OffMeshConnectionParams[] = []
): TileCacheMeshProcess {
	const decodedAreas = new Map(areaEncoding.map((entry) => [entry.encodedArea, entry.area]));
	return new recast.TileCacheMeshProcess((parameters: NavMeshCreateParams, polygonAreas: UnsignedCharArray, polygonFlags: UnsignedShortArray) => {
		for (let polygonIndex = 0; polygonIndex < parameters.polyCount(); polygonIndex++) {
			polygonAreas.set(polygonIndex, decodedAreas.get(polygonAreas.get(polygonIndex)) ?? 0);
			polygonFlags.set(polygonIndex, 1);
		}
		if (offMeshConnections.length) {
			parameters.setOffMeshConnections(Array.from(offMeshConnections));
		}
	});
}

function triangleKey(first: number, second: number, third: number): string {
	const minimum = Math.min(first, second, third);
	const maximum = Math.max(first, second, third);
	const middle = first + second + third - minimum - maximum;
	return `${minimum}:${middle}:${maximum}`;
}

/**
 * Generates an obstacle-capable tile cache while assigning authored area ids before rasterization.
 * The upstream generator marks every input triangle as one generic walkable area; this variant keeps
 * source-surface boundaries all the way through the compact heightfield and tile-cache layers.
 */
export function generateTileCacheWithSurfaceAreas(
	recast: NavMeshRecastRuntime,
	geometry: INavMeshSurfaceGeometry,
	navMeshGeneratorConfig: Partial<TileCacheGeneratorConfig> = {}
): INavMeshSurfaceBuildResult {
	const positions = geometry.positions;
	const indices = geometry.indices;
	const triangleAreaIds = geometry.triangleAreaIds;
	if (!positions.length || positions.length % 3 !== 0) {
		throw new Error("NavMesh surface positions must contain one or more xyz triples.");
	}
	if (!indices.length || indices.length % 3 !== 0) {
		throw new Error("NavMesh surface indices must contain one or more triangles.");
	}
	if (triangleAreaIds.length !== indices.length / 3) {
		throw new Error(`NavMesh surface area count ${triangleAreaIds.length} does not match triangle count ${indices.length / 3}.`);
	}

	const areaEncoding = createNavMeshSurfaceAreaEncoding(triangleAreaIds);
	const encodedByArea = new Map(areaEncoding.map((entry) => [entry.area, entry.encodedArea]));
	const encodedByTriangle = new Map<string, number>();
	for (let triangleIndex = 0; triangleIndex < triangleAreaIds.length; triangleIndex++) {
		const offset = triangleIndex * 3;
		encodedByTriangle.set(triangleKey(indices[offset], indices[offset + 1], indices[offset + 2]), encodedByArea.get(triangleAreaIds[triangleIndex])!);
	}

	const buildContext = new recast.RecastBuildContext();
	const verticesArray = new recast.VerticesArray();
	const trianglesArray = new recast.TrianglesArray();
	verticesArray.copy(Array.from(positions));
	trianglesArray.copy(Array.from(indices));
	const numVertices = positions.length / 3;
	const numTriangles = indices.length / 3;
	const tileCache = new recast.TileCache();
	const navMesh = new recast.NavMesh();
	const intermediates: Array<{
		heightfield?: InstanceType<NavMeshRecastRuntime["RecastHeightfield"]>;
		compactHeightfield?: InstanceType<NavMeshRecastRuntime["RecastCompactHeightfield"]>;
		heightfieldLayerSet?: InstanceType<NavMeshRecastRuntime["RecastHeightfieldLayerSet"]>;
	}> = [];

	const cleanup = (): void => {
		verticesArray.destroy();
		trianglesArray.destroy();
		for (const intermediate of intermediates) {
			if (intermediate.heightfield) {
				recast.freeHeightfield(intermediate.heightfield);
			}
			if (intermediate.compactHeightfield) {
				recast.freeCompactHeightfield(intermediate.compactHeightfield);
			}
			if (intermediate.heightfieldLayerSet) {
				recast.freeHeightfieldLayerSet(intermediate.heightfieldLayerSet);
			}
		}
	};
	const fail = (error: string): INavMeshSurfaceBuildResult => {
		cleanup();
		tileCache.destroy();
		navMesh.destroy();
		return { success: false, areaEncoding, error };
	};

	const bounds = navMeshGeneratorConfig.bounds ?? [recast.getBoundingBox(positions, indices).bbMin, recast.getBoundingBox(positions, indices).bbMax];
	const effectiveConfig = { ...recast.tileCacheGeneratorConfigDefaults, ...navMeshGeneratorConfig };
	const config = recast.createRcConfig(effectiveConfig);
	const gridSize = recast.calcGridSize(bounds[0], bounds[1], config.cs);
	config.width = gridSize.width;
	config.height = gridSize.height;
	config.minRegionArea *= config.minRegionArea;
	config.mergeRegionArea *= config.mergeRegionArea;
	config.detailSampleDist = config.detailSampleDist < 0.9 ? 0 : config.cs * config.detailSampleDist;
	config.detailSampleMaxError *= config.ch;
	config.borderSize = config.walkableRadius + 3;
	config.tileSize = Math.floor(config.tileSize);
	config.width = config.tileSize + config.borderSize * 2;
	config.height = config.tileSize + config.borderSize * 2;

	const tileWidth = Math.floor((gridSize.width + config.tileSize - 1) / config.tileSize);
	const tileHeight = Math.floor((gridSize.height + config.tileSize - 1) / config.tileSize);
	const expectedLayersPerTile = effectiveConfig.expectedLayersPerTile;
	const maxObstacles = effectiveConfig.maxObstacles;
	const tileCacheParameters = recast.DetourTileCacheParams.create({
		orig: bounds[0],
		cs: config.cs,
		ch: config.ch,
		width: config.tileSize,
		height: config.tileSize,
		walkableHeight: config.walkableHeight * config.ch,
		walkableRadius: config.walkableRadius * config.cs,
		walkableClimb: config.walkableClimb * config.ch,
		maxSimplificationError: config.maxSimplificationError,
		maxTiles: tileWidth * tileHeight * expectedLayersPerTile,
		maxObstacles,
	});
	const allocator = new recast.Raw.RecastLinearAllocator(32000);
	const compressor = new recast.Raw.RecastFastLZCompressor();
	const meshProcess = navMeshGeneratorConfig.tileCacheMeshProcess ?? createNavMeshSurfaceMeshProcess(recast, areaEncoding);
	if (!tileCache.init(tileCacheParameters, allocator, compressor, meshProcess)) {
		return fail("Failed to initialize the NavMesh tile cache.");
	}

	let tileBits = Math.min(Math.floor(recast.dtIlog2(recast.dtNextPow2(tileWidth * tileHeight * expectedLayersPerTile))), 14);
	if (tileBits > 14) {
		tileBits = 14;
	}
	const navMeshParameters = recast.NavMeshParams.create({
		orig: { x: bounds[0][0], y: bounds[0][1], z: bounds[0][2] },
		tileWidth: config.tileSize * config.cs,
		tileHeight: config.tileSize * config.cs,
		maxTiles: 1 << tileBits,
		maxPolys: 1 << (22 - tileBits),
	});
	if (!navMesh.initTiled(navMeshParameters)) {
		return fail("Failed to initialize the tiled NavMesh.");
	}

	const chunkyTriMesh = new recast.RecastChunkyTriMesh();
	if (!chunkyTriMesh.init(verticesArray, trianglesArray, numTriangles, 256)) {
		return fail("Failed to build the NavMesh chunky triangle index.");
	}

	const rasterizeTileLayers = (tileX: number, tileY: number): InstanceType<NavMeshRecastRuntime["TileCacheData"]>[] | null => {
		const intermediate: (typeof intermediates)[number] = {};
		intermediates.push(intermediate);
		const tileWorldSize = config.tileSize * config.cs;
		const tileConfig = recast.cloneRcConfig(config);
		const tileBoundsMin: [number, number, number] = [bounds[0][0] + tileX * tileWorldSize, bounds[0][1], bounds[0][2] + tileY * tileWorldSize];
		const tileBoundsMax: [number, number, number] = [bounds[0][0] + (tileX + 1) * tileWorldSize, bounds[1][1], bounds[0][2] + (tileY + 1) * tileWorldSize];
		tileBoundsMin[0] -= tileConfig.borderSize * tileConfig.cs;
		tileBoundsMin[2] -= tileConfig.borderSize * tileConfig.cs;
		tileBoundsMax[0] += tileConfig.borderSize * tileConfig.cs;
		tileBoundsMax[2] += tileConfig.borderSize * tileConfig.cs;
		for (let axis = 0; axis < 3; axis++) {
			tileConfig.set_bmin(axis, tileBoundsMin[axis]);
			tileConfig.set_bmax(axis, tileBoundsMax[axis]);
		}

		const heightfield = recast.allocHeightfield();
		intermediate.heightfield = heightfield;
		if (!recast.createHeightfield(buildContext, heightfield, tileConfig.width, tileConfig.height, tileBoundsMin, tileBoundsMax, tileConfig.cs, tileConfig.ch)) {
			return null;
		}

		const chunkIds = new recast.ChunkIdsArray();
		chunkIds.resize(512);
		const overlappingChunkCount = chunkyTriMesh.getChunksOverlappingRect([tileBoundsMin[0], tileBoundsMin[2]], [tileBoundsMax[0], tileBoundsMax[2]], chunkIds, 512);
		if (!overlappingChunkCount) {
			chunkIds.destroy();
			return [];
		}

		for (let chunkIndex = 0; chunkIndex < overlappingChunkCount; chunkIndex++) {
			const nodeId = chunkIds.get(chunkIndex);
			const triangleCount = chunkyTriMesh.nodes(nodeId).n;
			const nodeTriangles = chunkyTriMesh.getNodeTris(nodeId);
			const triangleAreas = new recast.TriangleAreasArray();
			triangleAreas.resize(triangleCount);
			recast.markWalkableTriangles(buildContext, tileConfig.walkableSlopeAngle, verticesArray, numVertices, nodeTriangles, triangleCount, triangleAreas);
			for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
				if (triangleAreas.get(triangleIndex) === 0) {
					continue;
				}
				const offset = triangleIndex * 3;
				const encodedArea = encodedByTriangle.get(triangleKey(nodeTriangles.get(offset), nodeTriangles.get(offset + 1), nodeTriangles.get(offset + 2)));
				if (encodedArea === undefined) {
					triangleAreas.destroy();
					chunkIds.destroy();
					return null;
				}
				triangleAreas.set(triangleIndex, encodedArea);
			}
			const rasterized = recast.rasterizeTriangles(
				buildContext,
				verticesArray,
				numVertices,
				nodeTriangles,
				triangleAreas,
				triangleCount,
				heightfield,
				tileConfig.walkableClimb
			);
			triangleAreas.destroy();
			if (!rasterized) {
				chunkIds.destroy();
				return null;
			}
		}
		chunkIds.destroy();

		recast.filterLowHangingWalkableObstacles(buildContext, config.walkableClimb, heightfield);
		recast.filterLedgeSpans(buildContext, config.walkableHeight, config.walkableClimb, heightfield);
		recast.filterWalkableLowHeightSpans(buildContext, config.walkableHeight, heightfield);
		const compactHeightfield = recast.allocCompactHeightfield();
		intermediate.compactHeightfield = compactHeightfield;
		if (!recast.buildCompactHeightfield(buildContext, config.walkableHeight, config.walkableClimb, heightfield, compactHeightfield)) {
			return null;
		}
		recast.freeHeightfield(heightfield);
		intermediate.heightfield = undefined;
		if (!recast.erodeWalkableArea(buildContext, config.walkableRadius, compactHeightfield)) {
			return null;
		}

		const layerSet = recast.allocHeightfieldLayerSet();
		intermediate.heightfieldLayerSet = layerSet;
		if (!recast.buildHeightfieldLayers(buildContext, compactHeightfield, config.borderSize, config.walkableHeight, layerSet)) {
			return null;
		}
		recast.freeCompactHeightfield(compactHeightfield);
		intermediate.compactHeightfield = undefined;

		const tiles: InstanceType<NavMeshRecastRuntime["TileCacheData"]>[] = [];
		for (let layerIndex = 0; layerIndex < layerSet.nlayers(); layerIndex++) {
			const tile = new recast.TileCacheData();
			const layer = layerSet.layers(layerIndex);
			const header = new recast.Raw.dtTileCacheLayerHeader();
			header.magic = recast.Detour.DT_TILECACHE_MAGIC;
			header.version = recast.Detour.DT_TILECACHE_VERSION;
			header.tx = tileX;
			header.ty = tileY;
			header.tlayer = layerIndex;
			const layerMinimum = layer.bmin();
			const layerMaximum = layer.bmax();
			header.set_bmin(0, layerMinimum.x);
			header.set_bmin(1, layerMinimum.y);
			header.set_bmin(2, layerMinimum.z);
			header.set_bmax(0, layerMaximum.x);
			header.set_bmax(1, layerMaximum.y);
			header.set_bmax(2, layerMaximum.z);
			header.width = layer.width();
			header.height = layer.height();
			header.minx = layer.minx();
			header.maxx = layer.maxx();
			header.miny = layer.miny();
			header.maxy = layer.maxy();
			header.hmin = layer.hmin();
			header.hmax = layer.hmax();
			const status = recast.buildTileCacheLayer(
				compressor,
				header,
				recast.getHeightfieldLayerHeights(layer),
				recast.getHeightfieldLayerAreas(layer),
				recast.getHeightfieldLayerCons(layer),
				tile
			);
			if (recast.statusFailed(status)) {
				return null;
			}
			tiles.push(tile);
		}
		recast.freeHeightfieldLayerSet(layerSet);
		intermediate.heightfieldLayerSet = undefined;
		return tiles;
	};

	for (let tileY = 0; tileY < tileHeight; tileY++) {
		for (let tileX = 0; tileX < tileWidth; tileX++) {
			const tiles = rasterizeTileLayers(tileX, tileY);
			if (tiles === null) {
				return fail(`Failed to rasterize NavMesh tile ${tileX},${tileY}.`);
			}
			for (const tile of tiles) {
				const addResult = tileCache.addTile(tile);
				if (recast.statusFailed(addResult.status)) {
					buildContext.log(recast.Recast.RC_LOG_WARNING, `Failed to add tile-cache layer at ${tileX},${tileY}.`);
				}
			}
		}
	}
	for (let tileY = 0; tileY < tileHeight; tileY++) {
		for (let tileX = 0; tileX < tileWidth; tileX++) {
			if (recast.statusFailed(tileCache.buildNavMeshTilesAt(tileX, tileY, navMesh))) {
				return fail(`Failed to build NavMesh tile ${tileX},${tileY}.`);
			}
		}
	}

	cleanup();
	return { success: true, navMesh, tileCache, areaEncoding };
}

/** Extracts detail triangles grouped by their final Detour area id for editor visualization and diagnostics. */
export function getNavMeshAreaGeometry(navMesh: NavMesh): INavMeshAreaGeometry[] {
	const geometries = new Map<number, INavMeshAreaGeometry>();
	for (let tileIndex = 0; tileIndex < navMesh.getMaxTiles(); tileIndex++) {
		const tile = navMesh.getTile(tileIndex);
		const header = tile.header();
		if (!header) {
			continue;
		}
		const polygonReferenceBase = navMesh.getPolyRefBase(tile);
		for (let polygonIndex = 0; polygonIndex < header.polyCount(); polygonIndex++) {
			const polygon = tile.polys(polygonIndex);
			if (polygon.getType() === 1) {
				continue;
			}
			const area = navMesh.getPolyArea(polygonReferenceBase + polygonIndex).area;
			let geometry = geometries.get(area);
			if (!geometry) {
				geometry = { area, positions: [], indices: [], polygonCount: 0 };
				geometries.set(area, geometry);
			}
			geometry.polygonCount++;
			const detail = tile.detailMeshes(polygonIndex);
			for (let detailTriangleIndex = 0; detailTriangleIndex < detail.triCount(); detailTriangleIndex++) {
				const detailTriangleOffset = (detail.triBase() + detailTriangleIndex) * 4;
				for (let pointIndex = 0; pointIndex < 3; pointIndex++) {
					const detailPoint = tile.detailTris(detailTriangleOffset + pointIndex);
					const vertexOffset = detailPoint < polygon.vertCount() ? polygon.verts(detailPoint) * 3 : (detail.vertBase() + detailPoint - polygon.vertCount()) * 3;
					const source = detailPoint < polygon.vertCount() ? tile.verts.bind(tile) : tile.detailVerts.bind(tile);
					geometry.positions.push(source(vertexOffset), source(vertexOffset + 1), source(vertexOffset + 2));
					geometry.indices.push(geometry.indices.length);
				}
			}
		}
	}
	return Array.from(geometries.values()).sort((left, right) => left.area - right.area);
}

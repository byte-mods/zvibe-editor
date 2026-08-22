import { CreateTileCacheNavMeshConfig, RecastNavigationJSPluginV2 } from "babylonjs-addons";
import { OffMeshConnectionParams } from "@recast-navigation/core";
import {
	createNavMeshSurfaceAreaEncoding,
	createNavMeshSurfaceMeshProcess,
	generateTileCacheWithSurfaceAreas,
	INavMeshSurfaceGeometry,
	NavMeshRecastRuntime,
} from "babylonjs-editor-tools";

import { INavMeshConfiguration } from "./types";

export interface INavMeshBuildData {
	navMeshData: Uint8Array;
	tileCacheData: Uint8Array;
}

export function getConfiguredOffMeshConnections(configuration: INavMeshConfiguration): OffMeshConnectionParams[] {
	return (configuration.offMeshLinks ?? []).map((link) => ({
		startPosition: { x: link.start[0], y: link.start[1], z: link.start[2] },
		endPosition: { x: link.end[0], y: link.end[1], z: link.end[2] },
		radius: link.radius,
		bidirectional: link.bidirectional,
		area: link.area,
		flags: link.flags,
		userId: link.userId,
	}));
}

export function createConfiguredNavMeshSurfaceProcess(recast: NavMeshRecastRuntime, configuration: INavMeshConfiguration) {
	return createNavMeshSurfaceMeshProcess(recast, configuration.surfaceAreaEncoding ?? [], getConfiguredOffMeshConnections(configuration));
}

/** Builds exact raster-time surface areas, loads the resulting tile cache into the editor plugin, and returns persistable binaries. */
export function buildConfiguredNavMesh(
	plugin: RecastNavigationJSPluginV2,
	recast: NavMeshRecastRuntime,
	configuration: INavMeshConfiguration,
	geometry: INavMeshSurfaceGeometry
): INavMeshBuildData {
	const areaEncoding = createNavMeshSurfaceAreaEncoding(geometry.triangleAreaIds);
	configuration.surfaceAreaEncoding = areaEncoding;
	const tileCacheMeshProcess = createConfiguredNavMeshSurfaceProcess(recast, configuration);
	const generatorConfiguration = {
		...CreateTileCacheNavMeshConfig(configuration.navMeshParameters),
		tileCacheMeshProcess,
	};
	const result = generateTileCacheWithSurfaceAreas(recast, geometry, generatorConfiguration);
	if (!result.success || !result.navMesh || !result.tileCache) {
		throw new Error(result.error ?? "Recast did not produce a NavMesh result.");
	}

	const navMeshData = recast.exportNavMesh(result.navMesh);
	const tileCacheData = recast.exportTileCache(result.navMesh, result.tileCache);
	result.tileCache.destroy();
	result.navMesh.destroy();
	plugin.buildFromTileCacheData(tileCacheData, tileCacheMeshProcess);
	return { navMeshData, tileCacheData };
}

/** Restores the area decoder whenever a serialized tile cache is opened so future tile rebuilds retain authored areas. */
export function loadConfiguredNavMeshTileCache(
	plugin: RecastNavigationJSPluginV2,
	recast: NavMeshRecastRuntime,
	configuration: INavMeshConfiguration,
	tileCacheData: Uint8Array
): void {
	plugin.buildFromTileCacheData(tileCacheData, createConfiguredNavMeshSurfaceProcess(recast, configuration));
}

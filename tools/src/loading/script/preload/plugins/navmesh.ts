import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory/factory.single-thread";

import { RecastNavigationHelper } from "../../../../tools/navmesh";
import { createNavMeshSurfaceMeshProcess, NavMeshRecastRuntime } from "../../../../tools/navmesh-surfaces";
import { loadFile, loadJsonFile } from "../../../../tools/request";
import { DynamicNavMeshObstacleManager } from "../../../nav-obstacles";

import { IScriptAssetParserParameters, registerScriptAssetParser } from "../../preload";

export async function preloadNavMeshScriptAsset(parameters: IScriptAssetParserParameters) {
	const [config, tilesData] = await Promise.all([
		loadJsonFile<any>(`${parameters.rootUrl}${parameters.key}/config.json`),
		loadFile(`${parameters.rootUrl}${parameters.key}/tilecache.bin`, "arraybuffer"),
	]);

	const [recastCore, recastGenerators] = await Promise.all([import("@recast-navigation/core"), import("@recast-navigation/generators")]);

	const recastRuntime = { ...recastCore, ...recastGenerators } as NavMeshRecastRuntime;
	await recastRuntime.init();
	const recast = (await CreateNavigationPluginAsync({
		instance: recastRuntime,
	})) as RecastNavigationHelper;
	const offMeshConnections = (config.offMeshLinks ?? []).map((link: any) => ({
		startPosition: { x: link.start[0], y: link.start[1], z: link.start[2] },
		endPosition: { x: link.end[0], y: link.end[1], z: link.end[2] },
		radius: link.radius,
		bidirectional: link.bidirectional,
		area: link.area,
		flags: link.flags,
		userId: link.userId,
	}));
	recast.buildFromTileCacheData(new Uint8Array(tilesData), createNavMeshSurfaceMeshProcess(recastRuntime, config.surfaceAreaEncoding ?? [], offMeshConnections));

	const obstacleManager = new DynamicNavMeshObstacleManager(recast, parameters.scene, config.obstacleMeshes ?? []);
	(recast as any).obstacleManager = obstacleManager;
	(recast as any).defaultAreaCosts = Object.fromEntries((config.areas ?? [{ id: 0, cost: 1 }]).map((area: any) => [String(area.id), area.cost]));
	recast.refreshObstacles = () => {
		obstacleManager.refresh(true);
	};

	return recast;
}

registerScriptAssetParser("navmesh", preloadNavMeshScriptAsset);

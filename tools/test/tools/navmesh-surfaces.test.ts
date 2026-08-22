import { beforeAll, describe, expect, test } from "vitest";

import * as RecastCore from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";

import {
	createNavMeshSurfaceAreaEncoding,
	createNavMeshSurfaceMeshProcess,
	generateTileCacheWithSurfaceAreas,
	getNavMeshAreaGeometry,
	type NavMeshRecastRuntime,
} from "../../src/tools/navmesh-surfaces";

const recast = { ...RecastCore, ...RecastGenerators } as NavMeshRecastRuntime;

describe("tools/navmesh surface areas", () => {
	beforeAll(async () => {
		await RecastCore.init();
	});

	test("encodes authored area zero as a non-zero raster area", () => {
		expect(createNavMeshSurfaceAreaEncoding([4, 0, 4])).toEqual([
			{ area: 0, encodedArea: 1 },
			{ area: 4, encodedArea: 2 },
		]);
	});

	test("preserves exact adjacent surface boundaries through build, serialization, and tile-cache rebuild", () => {
		const result = generateTileCacheWithSurfaceAreas(
			recast,
			{
				positions: [-100, 0, -50, -100, 0, 50, 0, 0, 50, 0, 0, -50, 0, 0, -50, 0, 0, 50, 100, 0, 50, 100, 0, -50],
				indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
				triangleAreaIds: [0, 0, 4, 4],
			},
			{
				cs: 5,
				ch: 1,
				walkableHeight: 2,
				walkableClimb: 1,
				walkableRadius: 0,
				tileSize: 32,
				maxObstacles: 8,
				expectedLayersPerTile: 1,
			}
		);
		expect(result.success, result.error).toBe(true);
		expect(result.areaEncoding).toEqual([
			{ area: 0, encodedArea: 1 },
			{ area: 4, encodedArea: 2 },
		]);

		const navMesh = result.navMesh!;
		const query = new RecastCore.NavMeshQuery(navMesh);
		const leftReference = query.findNearestPoly({ x: -50, y: 0, z: 0 }, { halfExtents: { x: 20, y: 20, z: 20 } }).nearestRef;
		const rightReference = query.findNearestPoly({ x: 50, y: 0, z: 0 }, { halfExtents: { x: 20, y: 20, z: 20 } }).nearestRef;
		expect(navMesh.getPolyArea(leftReference).area).toBe(0);
		expect(navMesh.getPolyArea(rightReference).area).toBe(4);
		expect(getNavMeshAreaGeometry(navMesh).map((entry) => entry.area)).toEqual([0, 4]);

		const tileCacheData = RecastCore.exportTileCache(navMesh, result.tileCache!);
		const imported = RecastCore.importTileCache(tileCacheData, createNavMeshSurfaceMeshProcess(recast, result.areaEncoding));
		const importedQuery = new RecastCore.NavMeshQuery(imported.navMesh);
		const importedRightReference = importedQuery.findNearestPoly({ x: 50, y: 0, z: 0 }, { halfExtents: { x: 20, y: 20, z: 20 } }).nearestRef;
		expect(imported.navMesh.getPolyArea(importedRightReference).area).toBe(4);

		const obstacle = imported.tileCache.addBoxObstacle({ x: -50, y: 0, z: 0 }, { x: 5, y: 10, z: 5 }, 0);
		expect(obstacle.success).toBe(true);
		for (let updateIndex = 0; updateIndex < 32; updateIndex++) {
			if (imported.tileCache.update(imported.navMesh).upToDate) {
				break;
			}
		}
		const rebuiltRightReference = importedQuery.findNearestPoly({ x: 50, y: 0, z: 0 }, { halfExtents: { x: 20, y: 20, z: 20 } }).nearestRef;
		expect(imported.navMesh.getPolyArea(rebuiltRightReference).area).toBe(4);

		importedQuery.destroy();
		imported.tileCache.destroy();
		imported.navMesh.destroy();
		query.destroy();
		result.tileCache!.destroy();
		navMesh.destroy();
	});
});

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory/factory.single-thread";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import * as RecastCore from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";

import { configureNavAgents, INavigationPlugin } from "../../src/loading/nav-agents";
import { createNavMeshSurfaceMeshProcess, generateTileCacheWithSurfaceAreas, NavMeshRecastRuntime } from "../../src/tools/navmesh-surfaces";

const recast = { ...RecastCore, ...RecastGenerators } as NavMeshRecastRuntime;

describe("loading/nav agents", () => {
	let engine: NullEngine;
	let scene: Scene;
	let tileCacheData: Uint8Array;

	beforeAll(async () => {
		await RecastCore.init();
		const result = generateTileCacheWithSurfaceAreas(
			recast,
			{
				positions: [-500, 0, -250, -500, 0, 250, 500, 0, 250, 500, 0, -250],
				indices: [0, 1, 2, 0, 2, 3],
				triangleAreaIds: [0, 0],
			},
			{
				cs: 10,
				ch: 2,
				walkableHeight: 90,
				walkableClimb: 20,
				walkableRadius: 20,
				tileSize: 32,
				maxObstacles: 8,
				expectedLayersPerTile: 1,
			}
		);
		if (!result.success || !result.navMesh || !result.tileCache) {
			throw new Error(result.error ?? "Failed to build the Detour Crowd test NavMesh.");
		}
		tileCacheData = RecastCore.exportTileCache(result.navMesh, result.tileCache);
		result.tileCache.destroy();
		result.navMesh.destroy();
	});

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("runs persisted agents through a native Detour Crowd and reports live evidence", async () => {
		const first = new TransformNode("First", scene);
		const second = new TransformNode("Second", scene);
		first.position.set(-300, 0, -35);
		second.position.set(-300, 0, 35);
		scene.metadata = {
			babylonEditorNavAgents: [
				{
					id: "first",
					nodeId: first.id,
					navMeshPath: "world.navmesh",
					radius: 20,
					height: 180,
					maxSpeed: 2,
					maxAcceleration: 8,
					collisionQueryRange: 100,
					pathOptimizationRange: 600,
					separationWeight: 2,
					destination: [300, 0, -35],
					isMoving: true,
				},
				{
					id: "second",
					nodeId: second.id,
					navMeshPath: "world.navmesh",
					radius: 20,
					height: 180,
					maxSpeed: 2,
					maxAcceleration: 8,
					collisionQueryRange: 100,
					pathOptimizationRange: 600,
					separationWeight: 2,
					destination: [300, 0, 35],
					isMoving: true,
				},
			],
			babylonEditorNavCrowds: [
				{
					navMeshPath: "world.navmesh",
					maxAgents: 8,
					maxAgentRadius: 20,
					timeStep: 1 / 60,
					maxSubStepCount: 4,
					queryExtent: [100, 200, 100],
					filters: [{ index: 0, areaCosts: { "0": 1 } }],
				},
			],
		};

		const resolver = async (): Promise<INavigationPlugin> => {
			const plugin = await CreateNavigationPluginAsync({ instance: recast });
			plugin.buildFromTileCacheData(tileCacheData, createNavMeshSurfaceMeshProcess(recast, [{ area: 0, encodedArea: 1 }]));
			return plugin as unknown as INavigationPlugin;
		};
		const controller = await configureNavAgents(scene, "", resolver);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		for (let frame = 0; frame < 30; frame++) {
			scene.onBeforeAnimationsObservable.notifyObservers(scene);
		}

		const firstRuntime = controller.getAgentRuntime("first");
		const secondRuntime = controller.getAgentRuntime("second");
		expect(firstRuntime.state).toBe("walking");
		expect(firstRuntime.position[0]).toBeGreaterThan(-300);
		expect(firstRuntime.velocity[0]).toBeGreaterThan(0);
		expect(firstRuntime.crowdAgentIndex).not.toBe(secondRuntime.crowdAgentIndex);
		expect(firstRuntime.remainingDistance).toBeGreaterThan(0);
		expect(first.position.asArray()).toEqual(firstRuntime.position);
	});
});

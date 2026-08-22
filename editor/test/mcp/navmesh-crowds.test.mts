import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { MeshBuilder, NullEngine, Scene, TransformNode } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	createNavAgent,
	createNavMesh,
	createNavMeshObstacle,
	deleteNavMeshObstacle,
	getNavAgentRuntime,
	getNavMeshObstacleRuntime,
	listNavAgents,
	listNavCrowds,
	listNavMeshObstacles,
	rebuildNavMesh,
	setNavAgentDestination,
	setNavCrowd,
	stopNavAgent,
	teleportNavAgent,
} from "../../src/mcp/navmesh/navmesh";

describe("mcp/navmesh Detour crowds", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() }, inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-navmesh-crowd-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("configures, moves, inspects, stops, and warps a real Detour Crowd agent", async () => {
		const ground = MeshBuilder.CreateGround("Ground", { width: 1000, height: 500 }, scene);
		await createNavMesh(
			scene,
			{
				path: "assets/world.navmesh",
				configuration: {
					navMeshParameters: {
						cs: 10,
						ch: 2,
						walkableHeight: 90,
						walkableClimb: 20,
						walkableRadius: 20,
						tileSize: 32,
						maxObstacles: 8,
						expectedLayersPerTile: 1,
					},
					staticMeshes: [{ id: ground.id, enabled: true, area: 0 }],
					obstacleMeshes: [],
					areas: [{ id: 0, name: "Walkable", cost: 1 }],
				},
			},
			options
		);
		await rebuildNavMesh(scene, { path: "assets/world.navmesh" }, options);
		const obstacleNode = MeshBuilder.CreateBox("Moving Crate", { width: 80, height: 100, depth: 80 }, scene);
		obstacleNode.position.set(0, 50, 0);
		await createNavMeshObstacle(
			scene,
			{
				path: "assets/world.navmesh",
				nodeId: obstacleNode.id,
				type: "box",
				moveThreshold: 1,
				timeToStationary: 0.05,
				updateInterval: 0.01,
			},
			options
		);
		await setNavCrowd(
			scene,
			{
				navMeshPath: "assets/world.navmesh",
				maxAgents: 16,
				maxAgentRadius: 25,
				timeStep: 1 / 60,
				maxSubStepCount: 4,
				queryExtent: [100, 200, 100],
				filters: [{ index: 0, areaCosts: { "0": 1 } }],
			},
			options
		);

		const node = new TransformNode("Agent", scene);
		node.position.set(-300, 0, 0);
		const agent = await createNavAgent(
			scene,
			{ id: "agent", nodeId: node.id, navMeshPath: "assets/world.navmesh", radius: 20, height: 180, collisionQueryRange: 100, separationWeight: 2 },
			options
		);
		expect(agent).toMatchObject({ id: "agent", collisionQueryRange: 100, separationWeight: 2 });
		expect(listNavCrowds(scene)).toMatchObject({ crowds: [{ navMeshPath: "assets/world.navmesh", maxAgents: 16 }] });

		await setNavAgentDestination(scene, { id: "agent", destination: [300, 0, 0], startMoving: true }, options);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		for (let frame = 0; frame < 30; frame++) {
			scene.onBeforeAnimationsObservable.notifyObservers(scene);
		}
		const runtime = getNavAgentRuntime(scene, { id: "agent" });
		expect(runtime).toMatchObject({ id: "agent", state: "walking", isMoving: true, overOffMeshConnection: false });
		expect(runtime.position[0]).toBeGreaterThan(-300);
		expect(runtime.velocity[0]).toBeGreaterThan(0);
		expect(listNavAgents(scene).agents[0].runtime.crowdAgentIndex).toBe(runtime.crowdAgentIndex);
		await expect(listNavMeshObstacles(scene, { path: "assets/world.navmesh" })).resolves.toMatchObject({
			obstacles: [{ id: obstacleNode.id, carving: true, dynamic: true, runtime: { carved: true, updateCount: 1 } }],
		});

		obstacleNode.position.x = 120;
		for (let frame = 0; frame < 12; frame++) {
			scene.onBeforeAnimationsObservable.notifyObservers(scene);
		}
		const obstacleRuntime = getNavMeshObstacleRuntime(scene, { path: "assets/world.navmesh", nodeId: obstacleNode.id });
		expect(obstacleRuntime).toMatchObject({ id: obstacleNode.id, carved: true, moving: false });
		expect(obstacleRuntime.lastCarvedPosition[0]).toBeCloseTo(120, 0);
		expect(obstacleRuntime.updateCount).toBeGreaterThanOrEqual(2);
		expect(getNavAgentRuntime(scene, { id: "agent" }).replanCount).toBeGreaterThanOrEqual(2);

		await stopNavAgent(scene, { id: "agent" }, options);
		expect(getNavAgentRuntime(scene, { id: "agent" }).isMoving).toBe(false);
		const warped = await teleportNavAgent(scene, { id: "agent", position: [0, 0, 0] }, options);
		expect(warped.position[0]).toBeCloseTo(0, 0);
		expect(await deleteNavMeshObstacle(scene, { path: "assets/world.navmesh", nodeId: obstacleNode.id }, options)).toMatchObject({ deleted: true, nodeId: obstacleNode.id });
	});
});

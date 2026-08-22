import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { MeshBuilder, NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { createNavMesh, getNavMesh, rebuildNavMesh, sampleNavMeshArea } from "../../src/mcp/navmesh/navmesh";

describe("mcp/navmesh surface-area rebuild", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-navmesh-surface-build-"));
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

	test("rebuilds adjacent sources as distinct raster-time areas and samples the persisted polygons", async () => {
		const left = MeshBuilder.CreateGround("Left", { width: 100, height: 100 }, scene);
		left.position.x = -50;
		const right = MeshBuilder.CreateGround("Right", { width: 100, height: 100 }, scene);
		right.position.x = 50;

		await createNavMesh(
			scene,
			{
				path: "assets/world.navmesh",
				configuration: {
					navMeshParameters: {
						cs: 5,
						ch: 1,
						walkableHeight: 2,
						walkableClimb: 1,
						walkableRadius: 0,
						tileSize: 32,
						maxObstacles: 8,
						expectedLayersPerTile: 1,
					},
					staticMeshes: [
						{ id: left.id, enabled: true, area: 0 },
						{ id: right.id, enabled: true, area: 4 },
					],
					obstacleMeshes: [],
					areas: [
						{ id: 0, name: "Walkable", cost: 1 },
						{ id: 4, name: "Mud", cost: 3 },
					],
				},
			},
			options
		);

		const rebuilt = await rebuildNavMesh(scene, { path: "assets/world.navmesh" }, options);
		expect(rebuilt).toMatchObject({
			rebuilt: true,
			surfaceAreaEncoding: [
				{ area: 0, encodedArea: 1 },
				{ area: 4, encodedArea: 2 },
			],
		});
		expect(await sampleNavMeshArea(scene, { path: "assets/world.navmesh", position: [-50, 0, 0], halfExtents: [20, 20, 20] })).toMatchObject({
			area: { id: 0, name: "Walkable", cost: 1 },
		});
		expect(await sampleNavMeshArea(scene, { path: "assets/world.navmesh", position: [50, 0, 0], halfExtents: [20, 20, 20] })).toMatchObject({
			area: { id: 4, name: "Mud", cost: 3 },
		});
		expect((await getNavMesh(scene, { path: "assets/world.navmesh" })).configuration.surfaceAreaEncoding).toEqual([
			{ area: 0, encodedArea: 1 },
			{ area: 4, encodedArea: 2 },
		]);
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { MeshBuilder, NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { createNavMesh, listNavMeshAreas, listNavMeshSurfaces, setNavMeshAreas, setNavMeshConfiguration, setNavMeshSurfaceArea } from "../../src/mcp/navmesh/navmesh";

describe("mcp/navmesh-areas", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-navmesh-areas-"));
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

	test("persists named traversal areas with bounded unique ids and costs", async () => {
		await createNavMesh(scene, { path: "assets/world.navmesh" }, options);
		const result = await setNavMeshAreas(
			scene,
			{
				path: "assets/world.navmesh",
				areas: [
					{ id: 0, name: "Walkable", cost: 1 },
					{ id: 4, name: "Jump", cost: 3.5 },
				],
			},
			options
		);
		expect(result).toMatchObject({
			rebuildRequired: true,
			areas: [
				{ id: 0, name: "Walkable", cost: 1 },
				{ id: 4, name: "Jump", cost: 3.5 },
			],
		});
		expect(await listNavMeshAreas(scene, { path: "assets/world.navmesh" })).toMatchObject({
			areas: [
				{ id: 0, name: "Walkable", cost: 1 },
				{ id: 4, name: "Jump", cost: 3.5 },
			],
		});
		await expect(setNavMeshAreas(scene, { path: "assets/world.navmesh", areas: [{ id: 4, name: "Jump", cost: 1 }] }, options)).rejects.toThrow("area 0");
	});

	test("paints configured source surfaces and protects referenced areas", async () => {
		const surface = MeshBuilder.CreateGround("Ramp", { width: 100, height: 100 }, scene);
		await createNavMesh(scene, { path: "assets/world.navmesh" }, options);
		await setNavMeshAreas(
			scene,
			{
				path: "assets/world.navmesh",
				areas: [
					{ id: 0, name: "Walkable", cost: 1 },
					{ id: 4, name: "Mud", cost: 3 },
				],
			},
			options
		);
		await setNavMeshConfiguration(scene, { path: "assets/world.navmesh", configuration: { staticMeshes: [{ id: surface.id, enabled: true }] } }, options);

		const painted = await setNavMeshSurfaceArea(scene, { path: "assets/world.navmesh", nodeId: surface.id, area: 4 }, options);
		expect(painted).toMatchObject({ surface: { id: surface.id, enabled: true, area: 4 }, area: { id: 4, name: "Mud" }, rebuildRequired: true });
		expect(await listNavMeshSurfaces(scene, { path: "assets/world.navmesh" })).toMatchObject({
			surfaces: [{ id: surface.id, enabled: true, area: 4, nodeName: "Ramp", missing: false }],
		});

		await expect(setNavMeshAreas(scene, { path: "assets/world.navmesh", areas: [{ id: 0, name: "Walkable", cost: 1 }] }, options)).rejects.toThrow(
			`Area 4 is still assigned to NavMesh surface "${surface.id}"`
		);
		await expect(setNavMeshSurfaceArea(scene, { path: "assets/world.navmesh", nodeId: surface.id, area: 12 }, options)).rejects.toThrow("is not defined");
	});
});

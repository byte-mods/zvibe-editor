import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, Vector3 } from "babylonjs";

import { deleteTerrainStreamingGroup, listTerrainStreamingGroups, setTerrainStreamingGroup } from "../../src/mcp/terrain/streaming";

describe("mcp/terrain-streaming", () => {
	let engine: NullEngine;
	let scene: Scene;
	let first: Mesh;
	let second: Mesh;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = scene.cameras[0];
		first = MeshBuilder.CreateGround("Near", { width: 10, height: 10 }, scene);
		first.metadata = { type: "Ground" };
		second = MeshBuilder.CreateGround("Far", { width: 10, height: 10 }, scene);
		second.position.x = 100;
		second.metadata = { type: "Ground" };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists tile membership and disables out-of-range Ground tiles", () => {
		const group = setTerrainStreamingGroup(scene, { name: "World", terrainIds: [first.id, second.id], distance: 50 }, options);
		expect(group.terrainIds).toEqual([first.id, second.id]);
		expect(group).toMatchObject({ version: 2, revision: 1, preloadDistance: 50, unloadDistance: 50, streamGeometry: false });
		expect(first.isEnabled()).toBe(true);
		expect(second.isEnabled()).toBe(false);
		expect(listTerrainStreamingGroups(scene).groups).toHaveLength(1);

		expect(deleteTerrainStreamingGroup(scene, { groupId: group.id, expectedRevision: group.revision }, options)).toMatchObject({ deleted: true });
		expect(second.isEnabled()).toBe(true);
	});

	test("optionally releases off-range terrain geometry and rebuilds it before enabling", () => {
		setTerrainStreamingGroup(scene, { name: "Released", terrainIds: [first.id, second.id], distance: 50, releaseGeometry: true }, options);
		expect(second.getTotalVertices()).toBe(0);
		scene.activeCamera!.position.x = 100;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(second.isEnabled()).toBe(true);
		expect(second.getTotalVertices()).toBeGreaterThan(0);
	});

	test("restores released terrain geometry when its streaming group is removed", () => {
		const group = setTerrainStreamingGroup(scene, { name: "Released", terrainIds: [first.id, second.id], distance: 50, releaseGeometry: true }, options);
		expect(second.getTotalVertices()).toBe(0);
		deleteTerrainStreamingGroup(scene, { groupId: group.id, expectedRevision: group.revision }, options);
		expect(second.isEnabled()).toBe(true);
		expect(second.getTotalVertices()).toBeGreaterThan(0);
	});

	test("authors bounded asynchronous remote geometry settings under an exact revision", () => {
		const created = setTerrainStreamingGroup(
			scene,
			{
				name: "Remote World",
				terrainIds: [first.id, second.id],
				distance: 50,
				preloadDistance: 75,
				unloadDistance: 100,
				unloadDelayMs: 250,
				streamGeometry: true,
				maxConcurrentLoads: 4,
				retryCount: 3,
				requestTimeoutMs: 20_000,
				remoteBaseUrl: "https://cdn.example.com/terrain?ignored=1#hash",
			},
			options
		);
		expect(created).toMatchObject({
			version: 2,
			revision: 1,
			streamGeometry: true,
			releaseGeometry: false,
			preloadDistance: 75,
			unloadDistance: 100,
			maxConcurrentLoads: 4,
			remoteBaseUrl: "https://cdn.example.com/terrain/",
		});
		expect(() => setTerrainStreamingGroup(scene, { groupId: created.id, expectedRevision: 0, terrainIds: [first.id, second.id], distance: 60 }, options)).toThrow(/stale/i);
		expect(() => setTerrainStreamingGroup(scene, { groupId: created.id, expectedRevision: created.revision, remoteBaseUrl: "http://example.com/terrain" }, options)).toThrow(
			/HTTPS/i
		);
		expect(() => setTerrainStreamingGroup(scene, { groupId: created.id, expectedRevision: created.revision, maxConcurrentLoads: 17 }, options)).toThrow(/1 through 16/i);
		expect(listTerrainStreamingGroups(scene).groups[0]).toMatchObject({ revision: created.revision, remoteBaseUrl: created.remoteBaseUrl, maxConcurrentLoads: 4 });
		const updated = setTerrainStreamingGroup(scene, { groupId: created.id, expectedRevision: created.revision, distance: 60 }, options);
		expect(updated).toMatchObject({ revision: 2, distance: 60, preloadDistance: 75, unloadDistance: 100 });
	});

	test("rejects duplicate tile membership and unsafe remote origins", () => {
		setTerrainStreamingGroup(scene, { name: "First", terrainIds: [first.id], distance: 50 }, options);
		expect(() => setTerrainStreamingGroup(scene, { name: "Second", terrainIds: [first.id], distance: 50 }, options)).toThrow(/already belongs/i);
		expect(() =>
			setTerrainStreamingGroup(scene, { name: "Unsafe", terrainIds: [second.id], distance: 50, streamGeometry: true, remoteBaseUrl: "http://example.com/terrain" }, options)
		).toThrow(/HTTPS/i);
	});
});

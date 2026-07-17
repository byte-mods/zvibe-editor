import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, Vector3 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

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
		expect(first.isEnabled()).toBe(true);
		expect(second.isEnabled()).toBe(false);
		expect(listTerrainStreamingGroups(scene).groups).toHaveLength(1);

		expect(deleteTerrainStreamingGroup(scene, { groupId: group.id }, options)).toMatchObject({ deleted: true });
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
		deleteTerrainStreamingGroup(scene, { groupId: group.id }, options);
		expect(second.isEnabled()).toBe(true);
		expect(second.getTotalVertices()).toBeGreaterThan(0);
	});
});

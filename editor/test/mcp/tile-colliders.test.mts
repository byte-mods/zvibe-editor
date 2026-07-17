import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, Vector2 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import { clearTileColliderGenerator, generateTileColliders, getTileColliderGenerator, refreshTileColliders } from "../../src/mcp/sprites/sprites";
import { listPhysics2D } from "../../src/mcp/physics2d/physics2d";

describe("mcp/tile-colliders", () => {
	let engine: NullEngine;
	let scene: Scene;
	let map: SpriteMapNode;
	const options = {
		editor: { layout: { graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() }, inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		map = new SpriteMapNode("Map", scene);
		(map as any)._spriteMap = { options: { stageSize: new Vector2(4, 2), outputSize: new Vector2(400, 200) }, dispose: vi.fn() };
		map.tiles = [
			{ id: "solid", name: "Solid", layer: 0, position: { x: 1, y: 0 }, repeatCount: { x: 1, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 3 } as any,
			{ id: "decoration", name: "Decoration", layer: 0, position: { x: 0, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 7 } as any,
		];
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("generates static 2D bodies for filtered repeated tile cells and clears them", () => {
		const result = generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [3], merge: false, friction: 0.5 }, options);
		expect(result.colliderCount).toBe(2);
		expect(getTileColliderGenerator(scene, { mapNodeId: map.id }).generator).toMatchObject({ tileIndexes: [3], merge: false, nodeIds: result.generator.nodeIds });
		expect(listPhysics2D(scene).bodies).toHaveLength(2);
		expect(listPhysics2D(scene).bodies.every((body: any) => body.bodyType === "static" && body.collider.shape === "box")).toBe(true);
		expect(clearTileColliderGenerator(scene, { mapNodeId: map.id }, options)).toMatchObject({ cleared: true, removedCount: 2 });
		expect(listPhysics2D(scene).bodies).toHaveLength(0);
	});

	test("validates tile index and layer filters", () => {
		expect(() => generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [-1] }, options)).toThrow("non-negative");
		expect(() => generateTileColliders(scene, { mapNodeId: map.id, layer: -1 }, options)).toThrow("non-negative");
	});

	test("refreshes generated colliders from persisted settings after tile edits", () => {
		generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [3], merge: false, isTrigger: true, friction: 0.5 }, options);
		map.tiles[0].repeatCount.x = 0;
		const refreshed = refreshTileColliders(scene, { mapNodeId: map.id }, options);
		expect(refreshed).toMatchObject({ refreshed: true, colliderCount: 1, generator: { tileIndexes: [3], merge: false, isTrigger: true, friction: 0.5 } });
		expect(listPhysics2D(scene).bodies).toHaveLength(1);
	});
});

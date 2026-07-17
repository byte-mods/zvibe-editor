import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, Vector2 } from "babylonjs";

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import { setSpriteMapRuleTiles } from "../../src/mcp/sprites/sprites";

describe("mcp/rule-tiles", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() }, inspector: { setEditedObject: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("replaces a source frame when its four-neighbor rule matches", () => {
		const map = new SpriteMapNode("Map", scene);
		map.tiles = [
			{ id: "center", layer: 0, tile: "grass", position: new Vector2(1, 1), repeatCount: Vector2.Zero(), repeatOffset: Vector2.Zero() },
			{ id: "north", layer: 0, tile: "grass", position: new Vector2(1, 0), repeatCount: Vector2.Zero(), repeatOffset: Vector2.Zero() },
			{ id: "north-east", layer: 0, tile: "grass", position: new Vector2(2, 0), repeatCount: Vector2.Zero(), repeatOffset: Vector2.Zero() },
		] as any;
		const result = setSpriteMapRuleTiles(
			scene,
			{ mapNodeId: map.id, rules: [{ sourceTile: "grass", outputTile: "grass-edge", neighbors: { north: "same", northEast: "same", south: "different" } }] },
			options
		);
		expect(result.changedTiles).toBeGreaterThan(0);
		expect(map.tiles.find((tile: any) => tile.id === "center")!.tile).toBe("grass-edge");
	});

	test("selects a stable weighted output variant from the tile position and seed", () => {
		const map = new SpriteMapNode("Map", scene);
		map.tiles = [{ id: "center", layer: 0, tile: "grass", position: new Vector2(0, 0), repeatCount: Vector2.Zero(), repeatOffset: Vector2.Zero() }] as any;
		const rule = {
			sourceTile: "grass",
			variants: [
				{ tile: "grass-a", weight: 1 },
				{ tile: "grass-b", weight: 1 },
			],
			seed: 42,
		};
		setSpriteMapRuleTiles(scene, { mapNodeId: map.id, rules: [rule] }, options);
		const first = map.tiles[0].tile;
		setSpriteMapRuleTiles(scene, { mapNodeId: map.id, rules: [rule] }, options);
		expect(map.tiles[0].tile).toBe(first);
	});

	test("accepts atlas frame zero for sources, outputs, and variants", () => {
		const map = new SpriteMapNode("Map", scene);
		map.tiles = [{ id: "center", layer: 0, tile: 0, position: new Vector2(0, 0), repeatCount: Vector2.Zero(), repeatOffset: Vector2.Zero() }] as any;
		const result = setSpriteMapRuleTiles(scene, { mapNodeId: map.id, rules: [{ sourceTile: 0, outputTile: 0, variants: [{ tile: 0, weight: 1 }] }] }, options);
		expect(result.ruleTiles).toMatchObject([{ sourceTile: 0, outputTile: 0, variants: [{ tile: 0, weight: 1 }] }]);
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import { createTilePalette, deleteTilePalette, listTilePalettes, paintTilePalette, setTilePalette } from "../../src/mcp/sprites/sprites";

describe("mcp/tile-palettes", () => {
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
		(map as any)._spriteMap = { options: {}, dispose: vi.fn() };
		vi.spyOn(map, "updateFromOptions").mockImplementation(() => undefined);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists palettes and paints rectangular tile brush strokes", () => {
		const palette = createTilePalette(scene, { mapNodeId: map.id, name: "Ground", tileIndexes: [2, 3], activeTileIndex: 2 }, options);
		expect(setTilePalette(scene, { paletteId: palette.id, activeTileIndex: 3 }, options)).toMatchObject({ activeTileIndex: 3 });
		const paint = paintTilePalette(scene, { paletteId: palette.id, position: [4, 6], width: 2, height: 2, layer: 1 }, options);
		expect(paint.changedTiles).toBe(4);
		expect(map.tiles).toHaveLength(4);
		expect(map.tiles.every((tile) => tile.tile === 3 && tile.layer === 1)).toBe(true);
		expect(paintTilePalette(scene, { paletteId: palette.id, position: [4, 6], width: 2, height: 2, layer: 1, mode: "erase" }, options).changedTiles).toBe(4);
		expect(map.tiles).toHaveLength(0);
		expect(listTilePalettes(scene).palettes).toHaveLength(1);
		expect(deleteTilePalette(scene, { paletteId: palette.id }, options)).toMatchObject({ deleted: true });
	});

	test("rejects palettes and brush strokes that do not match their Sprite Map", () => {
		expect(() => createTilePalette(scene, { mapNodeId: map.id, name: "Invalid", tileIndexes: [] }, options)).toThrow("one or more");
		const palette = createTilePalette(scene, { mapNodeId: map.id, name: "Ground", tileIndexes: [1] }, options);
		expect(() => paintTilePalette(scene, { paletteId: palette.id, position: [0.5, 1] }, options)).toThrow("integer grid");
	});
});

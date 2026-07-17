import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import { advanceSpriteMapAnimation, createAnimatedTile, deleteAnimatedTile, listAnimatedTiles, setAnimatedTile } from "../../src/mcp/sprites/sprites";

describe("mcp/animated-tiles", () => {
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
		map.tiles = [{ id: "cell", name: "Cell", layer: 0, position: { x: 0, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any];
		vi.spyOn(map, "updateFromOptions").mockImplementation(() => undefined);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists sequences and advances selected Sprite Map cells deterministically", () => {
		const animation = createAnimatedTile(scene, { mapNodeId: map.id, name: "Water", tileIds: ["cell"], frames: [1, 2, 3], frameDuration: 100 }, options);
		expect(advanceSpriteMapAnimation(map, animation, 100, { elapsed: 0, frame: 0 })).toBe(true);
		expect(map.tiles[0].tile).toBe(2);
		expect(setAnimatedTile(scene, { mapNodeId: map.id, id: animation.id, loop: false, enabled: false }, options)).toMatchObject({ loop: false, enabled: false });
		expect(listAnimatedTiles(scene, { mapNodeId: map.id }).animations).toHaveLength(1);
		expect(deleteAnimatedTile(scene, { mapNodeId: map.id, id: animation.id }, options)).toMatchObject({ deleted: true });
	});

	test("validates cell references, frames, and frame duration", () => {
		expect(() => createAnimatedTile(scene, { mapNodeId: map.id, name: "Bad", tileIds: ["missing"], frames: [1, 2], frameDuration: 100 }, options)).toThrow(
			"existing Sprite Map tile ids"
		);
		expect(() => createAnimatedTile(scene, { mapNodeId: map.id, name: "Bad", tileIds: ["cell"], frames: [1], frameDuration: 100 }, options)).toThrow("at least two");
	});
});

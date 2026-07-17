import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, Vector2 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import { generateTileColliders } from "../../src/mcp/sprites/sprites";
import { listPhysics2D } from "../../src/mcp/physics2d/physics2d";

describe("mcp/tile-composite-colliders", () => {
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
			{ id: "a", name: "A", layer: 0, position: { x: 0, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
			{ id: "b", name: "B", layer: 0, position: { x: 1, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
			{ id: "c", name: "C", layer: 0, position: { x: 3, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
		];
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("merges contiguous horizontal cells into deterministic composite box bodies", () => {
		const result = generateTileColliders(scene, { mapNodeId: map.id }, options);
		expect(result.colliderCount).toBe(2);
		expect(result.generator.merge).toBe(true);
		const sizes = listPhysics2D(scene)
			.bodies.map((body: any) => body.collider.size)
			.sort((first: number[], second: number[]) => first[0] - second[0]);
		expect(sizes).toEqual([
			[100, 100],
			[200, 100],
		]);
	});

	test("merges a solid two-dimensional tile region into one rectangular body", () => {
		map.tiles = [
			{ id: "a", name: "A", layer: 0, position: { x: 0, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
			{ id: "b", name: "B", layer: 0, position: { x: 1, y: 0 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
			{ id: "c", name: "C", layer: 0, position: { x: 0, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
			{ id: "d", name: "D", layer: 0, position: { x: 1, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 1 } as any,
		];
		const result = generateTileColliders(scene, { mapNodeId: map.id, merge: true }, options);
		expect(result.colliderCount).toBe(1);
		expect(listPhysics2D(scene).bodies[0].collider.size).toEqual([200, 200]);
	});
});

import { afterEach, describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { SpriteMap } from "@babylonjs/core/Sprites/spriteMap";

import {
	executeGridBrush,
	getTileGridCellPolygon,
	listGridBrushTypes,
	normalizeTileGridConfiguration,
	registerGridBrush,
	tileGridLocalPointToCell,
	transformGridBrushCells,
} from "../../src/loading/grid-brush";
import { configureAdvancedSpriteMap } from "../../src/tools/sprite";

describe("loading/grid-brush", () => {
	const disposals: Array<() => void> = [];

	afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

	test("normalizes legacy layouts and resolves rectangular, isometric, and hexagonal cell polygons", () => {
		expect(normalizeTileGridConfiguration(null)).toMatchObject({ model: "unity-tile-grid-v1", layout: "rectangular", revision: 0 });
		for (const layout of ["rectangular", "isometric", "hexagonal-point-top", "hexagonal-flat-top"] as const) {
			const polygon = getTileGridCellPolygon([2, 1], 6, 5, layout);
			const center = polygon.reduce<[number, number]>((result, point) => [result[0] + point[0] / polygon.length, result[1] + point[1] / polygon.length], [0, 0]);
			expect(tileGridLocalPointToCell(center[0], center[1], 6, 5, layout)).toEqual([2, 1]);
		}
		expect(tileGridLocalPointToCell(-0.49, 0.49, 8, 4, "rectangular")).toEqual([0, 0]);
		expect(tileGridLocalPointToCell(0.7, 0, 8, 4, "rectangular")).toBeNull();
	});

	test("rotates and reflects multi-cell stamps while composing per-cell transforms", () => {
		expect(transformGridBrushCells([{ offset: [2, 1], tileIndex: 7, transform: { quarterTurns: 1, flipX: true } }], { quarterTurns: 1, flipY: true })).toEqual([
			{ offset: [1, 2], tileIndex: 7, transform: { quarterTurns: 2, flipX: true, flipY: true } },
		]);
	});

	test("patches a real SpriteMap shader without a self-referencing base UV", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spriteSheet = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
		const name = "AdvancedGridBrushShaderTest";
		const spriteMap = new SpriteMap(
			name,
			{
				frames: [
					{
						filename: "tile.png",
						frame: { x: 0, y: 0, w: 1, h: 1 },
						rotated: false,
						trimmed: false,
						spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 },
						sourceSize: { w: 1, h: 1 },
					},
				],
			},
			spriteSheet,
			{ stageSize: new Vector2(2, 2), outputSize: new Vector2(2, 2) },
			scene
		);
		disposals.push(() => {
			spriteMap.dispose();
			scene.dispose();
			engine.dispose();
			delete Effect.ShadersStore[`spriteMap${name}PixelShader`];
		});

		configureAdvancedSpriteMap(spriteMap, "hexagonal-point-top");
		const shader = Effect.ShadersStore[`spriteMap${name}PixelShader`];
		expect(shader).toContain("babylonEditorAdvancedTileMap");
		expect(shader).toMatch(/tileData=texture(?:2D)?\(/);
		expect(shader).toContain("quarterTurns");
		expect(shader).toContain("vec2 transformedTileUV=tileUV");
		expect(shader).toContain("tileUV.xy=transformedTileUV.xy");
		expect(shader).not.toContain("baseTileUV=baseTileUV");
	});

	test("registers project GridBrush callbacks and rejects duplicate or unbounded output", () => {
		disposals.push(
			registerGridBrush({
				id: "tests.checker",
				displayName: "Checker",
				dataVersion: 1,
				setDefaultValues: () => ({ alternate: 9 }),
				paint: (context) => [
					{ offset: [0, 0], tileIndex: context.activeTileIndex },
					{ offset: [1, 0], tileIndex: Number(context.data.alternate) },
				],
			})
		);
		expect(listGridBrushTypes()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "builtin.rectangle" }), expect.objectContaining({ id: "tests.checker", defaultData: { alternate: 9 } })])
		);
		expect(
			executeGridBrush("tests.checker", {
				operation: "paint",
				layout: "isometric",
				anchor: [2, 3],
				brushSize: [2, 1],
				layer: 0,
				activeTileIndex: 4,
				data: { alternate: 9 },
			})
		).toEqual([
			{ offset: [0, 0], tileIndex: 4, transform: { quarterTurns: 0, flipX: false, flipY: false } },
			{ offset: [1, 0], tileIndex: 9, transform: { quarterTurns: 0, flipX: false, flipY: false } },
		]);

		disposals.push(
			registerGridBrush({
				id: "tests.duplicate",
				dataVersion: 1,
				paint: () => [
					{ offset: [0, 0], tileIndex: 1 },
					{ offset: [0, 0], tileIndex: 2 },
				],
			})
		);
		expect(() =>
			executeGridBrush("tests.duplicate", {
				operation: "paint",
				layout: "rectangular",
				anchor: [0, 0],
				brushSize: [1, 1],
				layer: 0,
				activeTileIndex: 1,
				data: {},
			})
		).toThrow("duplicate offset");
	});
});

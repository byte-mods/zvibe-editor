import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, Vector2, Vector3 } from "babylonjs";
import { getTileGridCellPolygon, registerGridBrush } from "babylonjs-editor-tools";

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import { getSpriteSheetPreviewPath } from "../../src/tools/sprite/preview";
import {
	applyTilePaintViewportStroke,
	applyTilePaletteOperation,
	createTilePalette,
	deleteTilePalette,
	getTilePaintViewport,
	getTilePaintViewportSnapshot,
	getTileGridConfiguration,
	getTilePalette,
	listGridBrushTypes,
	listTilePalettes,
	paintTilePalette,
	restoreTilePaintViewportSnapshot,
	setTilePaintViewport,
	setTilePalette,
	spriteMapLocalPointToGrid,
} from "../../src/mcp/sprites/sprites";

describe("mcp/tile-palettes", () => {
	let engine: NullEngine;
	let scene: Scene;
	let map: SpriteMapNode;
	const options = {
		editor: {
			layout: {
				graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				preview: { forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		map = new SpriteMapNode("Map", scene);
		(map as any)._spriteMap = {
			options: { layerCount: 2, stageSize: new Vector2(8, 8), outputSize: new Vector2(800, 800), colorMultiply: new Vector3(1, 1, 1) },
			dispose: vi.fn(),
		};
		vi.spyOn(map, "updateFromOptions").mockImplementation(() => undefined);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists palettes and paints rectangular tile brush strokes", () => {
		const palette = createTilePalette(scene, { mapNodeId: map.id, name: "Ground", tileIndexes: [2, 3], activeTileIndex: 2 }, options);
		expect(setTilePalette(scene, { paletteId: palette.id, expectedRevision: 0, activeTileIndex: 3 }, options)).toMatchObject({ activeTileIndex: 3, revision: 1 });
		const paint = paintTilePalette(scene, { paletteId: palette.id, position: [4, 6], width: 2, height: 2, layer: 1 }, options);
		expect(paint.changedTiles).toBe(4);
		expect(map.tiles).toHaveLength(4);
		expect(map.tiles.every((tile) => tile.tile === 3 && tile.layer === 1)).toBe(true);
		expect(paintTilePalette(scene, { paletteId: palette.id, position: [4, 6], width: 2, height: 2, layer: 1, mode: "erase" }, options).changedTiles).toBe(4);
		expect(map.tiles).toHaveLength(0);
		expect(listTilePalettes(scene).palettes).toHaveLength(1);
		expect(deleteTilePalette(scene, { paletteId: palette.id, expectedRevision: 1 }, options)).toMatchObject({ deleted: true });
	});

	test("rejects palettes and brush strokes that do not match their Sprite Map", () => {
		expect(() => createTilePalette(scene, { mapNodeId: map.id, name: "Invalid", tileIndexes: [] }, options)).toThrow("one or more");
		const palette = createTilePalette(scene, { mapNodeId: map.id, name: "Ground", tileIndexes: [1] }, options);
		expect(() => paintTilePalette(scene, { paletteId: palette.id, position: [0.5, 1] }, options)).toThrow("integer grid coordinate");
		expect(() => paintTilePalette(scene, { paletteId: palette.id, position: [7, 7], width: 2 }, options)).toThrow("must stay inside");
		expect(() => paintTilePalette(scene, { paletteId: palette.id, position: [0, 0], layer: 2 }, options)).toThrow("outside this Sprite Map");
	});

	test("configures exact-revision viewport state and applies one bounded drag stroke atomically", () => {
		const palette = createTilePalette(scene, { mapNodeId: map.id, name: "Ground", tileIndexes: [2, 3], activeTileIndex: 3 }, options);
		expect(getTilePaintViewport(scene)).toMatchObject({ model: "unity-tile-paint-viewport-v2", revision: 0, enabled: false, mapRevision: null, target: "map" });
		const configured = setTilePaintViewport(
			scene,
			{ expectedRevision: 0, enabled: true, mapNodeId: map.id, paletteId: palette.id, mode: "paint", layer: 1, brushSize: [2, 2] },
			options
		);
		expect(configured).toMatchObject({ revision: 1, enabled: true, mapRevision: 0, grid: { width: 8, height: 8, layerCount: 2 } });

		const stroke = applyTilePaintViewportStroke(
			scene,
			{
				expectedRevision: 1,
				expectedMapRevision: 0,
				anchors: [
					[1, 1],
					[2, 1],
				],
			},
			options
		);
		expect(stroke).toMatchObject({ revision: 2, mapRevision: 1, stroke: { mode: "paint", layer: 1, tileIndex: 3, changedTiles: 6 } });
		expect(stroke.stroke.affectedCells).toHaveLength(6);
		expect(map.tiles).toHaveLength(6);
		expect(map.tiles.every((tile) => tile.layer === 1 && tile.tile === 3)).toBe(true);
		expect(() => applyTilePaintViewportStroke(scene, { expectedRevision: 1, expectedMapRevision: 0, position: [0, 0] }, options)).toThrow("revision is 2");

		const beforeInvalid = structuredClone(map.tiles);
		expect(() => applyTilePaintViewportStroke(scene, { expectedRevision: 2, expectedMapRevision: 1, position: [7, 7] }, options)).toThrow("must stay inside");
		expect(map.tiles).toEqual(beforeInvalid);
		expect(getTilePaintViewport(scene)).toMatchObject({ revision: 2, mapRevision: 1 });
	});

	test("restores a complete viewport stroke snapshot for Undo/Redo while invalidating leases", () => {
		const palette = createTilePalette(scene, { mapNodeId: map.id, name: "Ground", tileIndexes: [4] }, options);
		setTilePaintViewport(scene, { expectedRevision: 0, enabled: true, mapNodeId: map.id, paletteId: palette.id }, options);
		const empty = getTilePaintViewportSnapshot(scene, { mapNodeId: map.id });
		applyTilePaintViewportStroke(scene, { expectedRevision: 1, expectedMapRevision: 0, position: [3, 2] }, options);
		expect(map.tiles).toHaveLength(1);
		const painted = getTilePaintViewportSnapshot(scene, { mapNodeId: map.id });

		expect(restoreTilePaintViewportSnapshot(scene, empty, options)).toMatchObject({ revision: 3, mapRevision: 2 });
		expect(map.tiles).toHaveLength(0);
		expect(restoreTilePaintViewportSnapshot(scene, painted, options)).toMatchObject({ revision: 4, mapRevision: 3 });
		expect(map.tiles).toMatchObject([{ layer: 0, position: { x: 3, y: 2 }, tile: 4 }]);
	});

	test("maps output-plane local coordinates to top-left-origin Sprite Map cells", () => {
		expect(spriteMapLocalPointToGrid(-0.5, 0.5, 8, 4)).toEqual([0, 0]);
		expect(spriteMapLocalPointToGrid(0.499, -0.499, 8, 4)).toEqual([7, 3]);
		expect(spriteMapLocalPointToGrid(0, 0, 8, 4)).toEqual([4, 2]);
		expect(spriteMapLocalPointToGrid(0.6, 0, 8, 4)).toBeNull();
	});

	test("resolves isometric and both hexagonal layouts through bounded cell polygons", () => {
		for (const layout of ["isometric", "hexagonal-point-top", "hexagonal-flat-top"] as const) {
			map.metadata ??= {};
			map.metadata.babylonEditorTileGrid = { model: "unity-tile-grid-v1", version: 1, revision: 0, layout };
			const polygon = getTileGridCellPolygon([3, 2], 8, 8, layout);
			const center = polygon.reduce<[number, number]>((sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length], [0, 0]);
			expect(spriteMapLocalPointToGrid(center[0], center[1], 8, 8, layout)).toEqual([3, 2]);
			expect(getTileGridConfiguration(scene, { mapNodeId: map.id }).grid.layout).toBe(layout);
		}
	});

	test("applies exact-leased selection, transform, picker, fill, palette editing, and project GridBrush operations", () => {
		const dispose = registerGridBrush({
			id: "tests.line",
			dataVersion: 1,
			paint: (context) => [
				{ offset: [0, 0], tileIndex: context.activeTileIndex },
				{ offset: [1, 0], tileIndex: context.activeTileIndex },
			],
		});
		try {
			expect(listGridBrushTypes().brushes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tests.line" })]));
			const palette = createTilePalette(
				scene,
				{ mapNodeId: map.id, name: "Operations", layout: "isometric", tileIndexes: [5], brush: { type: "tests.line", dataVersion: 1, data: {} } },
				options
			);
			let viewport = setTilePaintViewport(scene, { expectedRevision: 0, enabled: true, mapNodeId: map.id, paletteId: palette.id, target: "map" }, options);
			let result = applyTilePaletteOperation(
				scene,
				{
					expectedRevision: viewport.revision,
					expectedMapRevision: viewport.mapRevision,
					expectedPaletteRevision: viewport.palette.revision,
					operation: "custom",
					position: [1, 1],
				},
				options
			);
			expect(result).toMatchObject({ mapChanged: true, paletteChanged: false, mapRevision: 1 });
			expect(map.tiles).toHaveLength(2);

			result = applyTilePaletteOperation(
				scene,
				{
					expectedRevision: result.revision,
					expectedMapRevision: result.mapRevision,
					expectedPaletteRevision: result.palette.revision,
					operation: "select",
					position: [1, 1],
					endPosition: [2, 1],
				},
				options
			);
			expect(result.selection.cells).toHaveLength(2);
			result = applyTilePaletteOperation(
				scene,
				{ expectedRevision: result.revision, expectedMapRevision: result.mapRevision, expectedPaletteRevision: result.palette.revision, operation: "rotate" },
				options
			);
			expect(map.tiles.every((tile) => tile.transform?.quarterTurns === 1)).toBe(true);
			result = applyTilePaletteOperation(
				scene,
				{
					expectedRevision: result.revision,
					expectedMapRevision: result.mapRevision,
					expectedPaletteRevision: result.palette.revision,
					operation: "pick",
					position: [1, 1],
				},
				options
			);
			expect(result.picked).toMatchObject({ tileIndex: 5 });

			viewport = setTilePaintViewport(scene, { expectedRevision: result.revision, target: "palette", mode: "paint" }, options);
			result = applyTilePaletteOperation(
				scene,
				{
					expectedRevision: viewport.revision,
					expectedMapRevision: viewport.mapRevision,
					expectedPaletteRevision: viewport.palette.revision,
					operation: "paint",
					target: "palette",
					position: [4, 3],
					brushSize: [1, 1],
				},
				options
			);
			expect(result).toMatchObject({ paletteChanged: true, mapChanged: false });
			expect(getTilePalette(scene, { paletteId: palette.id })).toMatchObject({ model: "unity-tile-palette-v2", revision: 1, layout: "isometric" });
			expect(() => setTilePalette(scene, { paletteId: palette.id, expectedRevision: 0, activeTileIndex: 5 }, options)).toThrow("revision is 1");
		} finally {
			dispose();
		}
	});

	test("preserves absolute SpriteMap texture paths for DOM frame previews", () => {
		expect(getSpriteSheetPreviewPath("/private/tmp/project/assets/atlas.png")).toBe("/private/tmp/project/assets/atlas.png");
		expect(getSpriteSheetPreviewPath("file:///private/tmp/project/assets/atlas.png")).toBe("file:///private/tmp/project/assets/atlas.png");
	});
});

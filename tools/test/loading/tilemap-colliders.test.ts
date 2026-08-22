import { describe, expect, test } from "vitest";

import { generateTilemapColliderGeometry, normalizeTilemapColliderSettings } from "../../src/loading/tilemap-colliders";

const cells = [
	{ x: 0, y: 0, layer: 0, tileIndex: 1, tileId: "a" },
	{ x: 1, y: 0, layer: 0, tileIndex: 1, tileId: "b" },
	{ x: 3, y: 0, layer: 0, tileIndex: 1, tileId: "c" },
];

describe("loading/tilemap-colliders", () => {
	test("merges grid cells into deterministic composite rectangle bodies", () => {
		const result = generateTilemapColliderGeometry({ compositeOperation: "merge", extrusionFactor: 2 }, cells, [4, 2], [100, 100]);
		expect(result.evidence).toMatchObject({ inputCellCount: 3, filteredCellCount: 3, outputColliderCount: 2, boxCount: 2, compositeOperation: "merge" });
		expect(result.colliders.map((collider) => collider.shape)).toEqual([
			{ shape: "box", size: [204, 104] },
			{ shape: "box", size: [104, 104] },
		]);
	});

	test("supports intersect, difference, and flip occupancy operations across layers", () => {
		const layered = [
			{ x: 0, y: 0, layer: 0, tileIndex: 1, tileId: "base-a" },
			{ x: 1, y: 0, layer: 0, tileIndex: 1, tileId: "base-b" },
			{ x: 1, y: 0, layer: 1, tileIndex: 1, tileId: "mask-b" },
			{ x: 2, y: 0, layer: 1, tileIndex: 1, tileId: "mask-c" },
		];
		expect(generateTilemapColliderGeometry({ compositeOperation: "intersect" }, layered, [3, 1], [10, 10]).evidence.gridCellCount).toBe(1);
		expect(generateTilemapColliderGeometry({ compositeOperation: "difference" }, layered, [3, 1], [10, 10]).evidence.gridCellCount).toBe(1);
		expect(generateTilemapColliderGeometry({ compositeOperation: "flip" }, layered, [3, 1], [10, 10]).evidence.gridCellCount).toBe(2);
	});

	test("removes internal grid edges in composite outline mode", () => {
		const result = generateTilemapColliderGeometry({ compositeOperation: "merge", geometryType: "outlines", edgeRadius: 3 }, cells.slice(0, 2), [2, 1], [100, 100]);
		expect(result.evidence).toMatchObject({ outputColliderCount: 6, edgeCount: 6, convexPartCount: 6 });
		expect(result.colliders.every((collider) => collider.shape.shape === "edge" && collider.shape.edgeRadius === 3)).toBe(true);
		expect(
			result.colliders.every(
				(collider) =>
					collider.shape.shape === "edge" &&
					Math.hypot(collider.shape.parts[0][0][0] - collider.shape.parts[0][3][0], collider.shape.parts[0][0][1] - collider.shape.parts[0][3][1]) === 6
			)
		).toBe(true);
	});

	test("uses normalized Sprite physics shapes, holes, and optional bounded triangulation", () => {
		const result = generateTilemapColliderGeometry(
			{
				compositeOperation: "none",
				useDelaunayMesh: true,
				tileColliderTypes: { 7: "sprite", 8: "none" },
				spriteShapes: {
					7: [
						{
							id: "outer",
							points: [
								[-0.5, -0.5],
								[0.5, -0.5],
								[0.5, 0.5],
								[-0.5, 0.5],
							],
							holes: [
								{
									id: "hole",
									points: [
										[-0.1, -0.1],
										[-0.1, 0.1],
										[0.1, 0.1],
										[0.1, -0.1],
									],
								},
							],
						},
					],
				},
			},
			[
				{ x: 0, y: 0, layer: 0, tileIndex: 7, tileId: "sprite" },
				{ x: 1, y: 0, layer: 0, tileIndex: 8, tileId: "empty" },
			],
			[2, 1],
			[100, 100]
		);
		expect(result.evidence).toMatchObject({ filteredCellCount: 1, spriteCellCount: 1, polygonCount: 1, triangulation: "bounded-delaunay-edge-flips-v1" });
		expect(result.colliders[0].shape).toMatchObject({ shape: "polygon", outerCount: 1, holeCount: 1, vertexCount: 8 });
		expect(result.colliders[0].shape.shape === "polygon" && result.colliders[0].shape.parts.every((part) => part.length === 3)).toBe(true);
	});

	test("validates bounded settings and unsigned layer masks", () => {
		expect(normalizeTilemapColliderSettings({ generationType: "manual", maxTileChangeCount: 64, layerOverrides: { priority: 2, excludeLayers: 8 } as any })).toMatchObject({
			generationType: "manual",
			maxTileChangeCount: 64,
			layerOverrides: { priority: 2, excludeLayers: 8, callbackLayers: 0xffffffff },
		});
		expect(() => normalizeTilemapColliderSettings({ layerOverrides: { includeLayers: -1 } as any })).toThrow("unsigned 32-bit");
		expect(() => normalizeTilemapColliderSettings({ spriteShapes: { 2: [] } })).toThrow();
	});
});

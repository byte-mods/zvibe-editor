import { describe, expect, test } from "vitest";

import { decomposePhysics2DPolygonContours } from "../../src/loading/physics2d-polygons";

describe("loading/physics2d-polygons", () => {
	test("decomposes one outer contour with a hole without filling the hole", () => {
		const result = decomposePhysics2DPolygonContours([
			{
				id: "outer",
				points: [
					[-50, -50],
					[50, -50],
					[50, 50],
					[-50, 50],
				],
				holes: [
					{
						id: "hole",
						points: [
							[-10, -10],
							[-10, 10],
							[10, 10],
							[10, -10],
						],
					},
				],
			},
		]);

		expect(result).toMatchObject({ model: "unity-polygon-collider-holes-islands-v1", outerCount: 1, holeCount: 1, vertexCount: 8, filledArea: 9600, decomposedArea: 9600 });
		expect(result.parts).toHaveLength(4);
		expect(result.parts.some((part) => part.every(([x, y]) => Math.abs(x) <= 10 && Math.abs(y) <= 10))).toBe(false);
	});

	test("decomposes disconnected islands as independent filled regions", () => {
		const result = decomposePhysics2DPolygonContours([
			{
				id: "left",
				points: [
					[-50, -10],
					[-30, -10],
					[-30, 10],
					[-50, 10],
				],
				holes: [],
			},
			{
				id: "right",
				points: [
					[30, -10],
					[50, -10],
					[50, 10],
					[30, 10],
				],
				holes: [],
			},
		]);

		expect(result).toMatchObject({ outerCount: 2, holeCount: 0, filledArea: 800, decomposedArea: 800 });
		expect(result.parts).toHaveLength(2);
	});

	test("canonicalizes winding and removes duplicate/collinear points", () => {
		const result = decomposePhysics2DPolygonContours([
			{
				id: "outer",
				points: [
					[0, 0],
					[0, 10],
					[5, 10],
					[10, 10],
					[10, 0],
					[0, 0],
				],
				holes: [],
			},
		]);

		expect(result.contours[0].points).toEqual([
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		]);
		expect(result.filledArea).toBe(100);
	});

	test("rejects touching holes, overlapping islands, duplicate ids, and excessive vertices", () => {
		expect(() =>
			decomposePhysics2DPolygonContours([
				{
					id: "outer",
					points: [
						[0, 0],
						[10, 0],
						[10, 10],
						[0, 10],
					],
					holes: [
						{
							id: "hole",
							points: [
								[0, 2],
								[2, 2],
								[2, 4],
								[0, 4],
							],
						},
					],
				},
			])
		).toThrow("strictly inside");
		expect(() =>
			decomposePhysics2DPolygonContours([
				{
					id: "a",
					points: [
						[0, 0],
						[10, 0],
						[10, 10],
						[0, 10],
					],
					holes: [],
				},
				{
					id: "b",
					points: [
						[5, 5],
						[15, 5],
						[15, 15],
						[5, 15],
					],
					holes: [],
				},
			])
		).toThrow("must not intersect");
		expect(() =>
			decomposePhysics2DPolygonContours([
				{
					id: "same",
					points: [
						[0, 0],
						[10, 0],
						[10, 10],
						[0, 10],
					],
					holes: [
						{
							id: "same",
							points: [
								[2, 2],
								[4, 2],
								[4, 4],
								[2, 4],
							],
						},
					],
				},
			])
		).toThrow("unique");
	});
});

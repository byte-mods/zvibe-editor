import { describe, expect, test } from "vitest";

import {
	createDefaultSpriteShapeDefinition,
	createDefaultSpriteShapeProfile,
	generateSpriteShapeGeometry,
	normalizeSpriteShapeDefinition,
	normalizeSpriteShapeProfile,
} from "../../src/loading/sprite-shapes";

describe("loading/sprite-shapes", () => {
	test("generates closed fill, edge strips, tangents, and a polygon collider", () => {
		const profile = createDefaultSpriteShapeProfile("profile");
		const definition = createDefaultSpriteShapeDefinition(profile.id);
		const geometry = generateSpriteShapeGeometry(profile, definition);

		expect(geometry.model).toBe("unity-sprite-shape-generated-geometry-v1");
		expect(geometry.sampleCount).toBe(4);
		expect(geometry.edgeQuadCount).toBe(4);
		expect(geometry.fillTriangleCount).toBe(2);
		expect(geometry.positions.length / 3).toBe(20);
		expect(geometry.normals).toHaveLength(geometry.positions.length);
		expect(geometry.uvs).toHaveLength((geometry.positions.length / 3) * 2);
		expect(geometry.colors).toHaveLength((geometry.positions.length / 3) * 4);
		expect(geometry.tangents).toHaveLength((geometry.positions.length / 3) * 4);
		expect(geometry.subMeshes).toEqual([expect.objectContaining({ materialIndex: 0, indexCount: 6 }), expect.objectContaining({ materialIndex: 1, indexCount: 24 })]);
		expect(geometry.collider).toMatchObject({ type: "polygon", contours: [{ id: "sprite-shape-outer", holes: [] }] });
		expect(geometry.collider?.parts).toHaveLength(2);
		expect(geometry.uvs[1]).toBeCloseTo(0.005);

		const unoptimized = generateSpriteShapeGeometry(
			{ ...profile, useSpriteBorders: false },
			{ ...definition, geometryOptimization: false, collider: { ...definition.collider, optimize: false } }
		);
		expect(unoptimized.sampleCount).toBe(32);
		expect(unoptimized.edgeQuadCount).toBe(32);
		expect(unoptimized.collider?.points).toHaveLength(8);
		expect(unoptimized.uvs[1]).toBe(0);
	});

	test("generates open cubic strips, adaptive UVs, and thick edge collision parts", () => {
		const profile = createDefaultSpriteShapeProfile("profile");
		const definition = normalizeSpriteShapeDefinition({
			...createDefaultSpriteShapeDefinition(profile.id),
			closed: false,
			detail: 4,
			points: [
				{ id: "a", position: [0, 0], leftTangent: [0, 0], rightTangent: [50, 100], tangentMode: "broken", height: 20, corner: false },
				{ id: "b", position: [100, 0], leftTangent: [-50, 100], rightTangent: [0, 0], tangentMode: "broken", height: 40, corner: false },
			],
			collider: { enabled: true, type: "edge", detail: 4, offset: 3, edgeRadius: 5, optimize: true, isTrigger: true, friction: 0.2, restitution: 0.3 },
		});
		const geometry = generateSpriteShapeGeometry(profile, definition);

		expect(geometry.sampleCount).toBe(5);
		expect(geometry.edgeQuadCount).toBe(4);
		expect(geometry.fillTriangleCount).toBe(0);
		expect(geometry.length).toBeGreaterThan(100);
		expect(geometry.uvs.at(-2)).toBeGreaterThan(0);
		expect(geometry.collider).toMatchObject({ type: "edge", contours: [] });
		expect(geometry.collider?.parts).toHaveLength(4);
		expect(geometry.collider?.parts.every((part) => part.length === 4)).toBe(true);
	});

	test("routes overlapping angle ranges by order into deterministic material slots", () => {
		const profile = normalizeSpriteShapeProfile({
			...createDefaultSpriteShapeProfile("profile"),
			angleRanges: [
				{ id: "horizontal", name: "Horizontal", minimumDegrees: -10, maximumDegrees: 10, order: 1, texturePath: "assets/grass.png", color: [1, 0, 0, 1] },
				{ id: "priority", name: "Priority", minimumDegrees: -20, maximumDegrees: 20, order: 2, texturePath: "assets/snow.png", color: [0, 0, 1, 1] },
			],
		});
		const definition = normalizeSpriteShapeDefinition({
			...createDefaultSpriteShapeDefinition(profile.id),
			closed: false,
			detail: 1,
			points: [
				{ id: "a", position: [0, 0], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 10, corner: true },
				{ id: "b", position: [100, 0], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 10, corner: true },
			],
			collider: { enabled: false, type: "edge", detail: 1, offset: 0, edgeRadius: 1, optimize: true, isTrigger: false, friction: 0, restitution: 0 },
		});
		const geometry = generateSpriteShapeGeometry(profile, definition);

		expect(geometry.subMeshes).toEqual([{ materialIndex: 3, indexStart: 0, indexCount: 6 }]);
		expect(geometry.materialSlots[3]).toMatchObject({ angleRangeId: "priority", texturePath: "assets/snow.png", color: [0, 0, 1, 1] });
	});

	test("rejects invalid continuous tangents, self-intersecting fill, and excessive collider sampling", () => {
		const profile = createDefaultSpriteShapeProfile("profile");
		const base = createDefaultSpriteShapeDefinition(profile.id);
		expect(() =>
			normalizeSpriteShapeDefinition({
				...base,
				points: [{ ...base.points[0], tangentMode: "continuous", leftTangent: [-10, 0], rightTangent: [0, 10] }, ...base.points.slice(1)],
			})
		).toThrow(/continuous tangents/i);
		const crossed = normalizeSpriteShapeDefinition({
			...base,
			detail: 1,
			points: [
				{ ...base.points[0], position: [-100, -100] },
				{ ...base.points[1], position: [100, 100] },
				{ ...base.points[2], position: [-100, 100] },
				{ ...base.points[3], position: [100, -100] },
			],
		});
		expect(() => generateSpriteShapeGeometry(profile, crossed)).toThrow(/non-self-intersecting/i);
		expect(() =>
			normalizeSpriteShapeDefinition({
				...base,
				points: Array.from({ length: 65 }, (_, index) => ({
					id: `point-${index}`,
					position: [Math.cos((index / 64) * Math.PI * 2) * 100, Math.sin((index / 64) * Math.PI * 2) * 100],
					leftTangent: [0, 0],
					rightTangent: [0, 0],
					tangentMode: "linear",
					height: 10,
					corner: true,
				})),
				collider: { ...base.collider, detail: 8 },
			})
		).toThrow(/2 through 64 control points/i);
	});
});

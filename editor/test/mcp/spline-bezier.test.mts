import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "babylonjs";

import { createSpline, evaluateSpline, getSpline, projectSplineToTerrain, setSpline } from "../../src/mcp/splines/splines";

describe("mcp/spline-bezier", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					preview: { scene, gizmo: { setAttachedObject: vi.fn() } },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
					graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() },
				},
			},
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, persists, and evaluates cubic Bezier knots", () => {
		const spline = createSpline(
			scene,
			{
				name: "Curve",
				knots: [
					{ position: [0, 0, 0], outTangent: [0, 10, 0] },
					{ position: [10, 0, 0], inTangent: [0, 10, 0] },
				],
			},
			options
		);
		expect(getSpline(scene, { nodeId: spline.node.id }).knots).toHaveLength(2);
		const sample = evaluateSpline(scene, { nodeId: spline.node.id, t: 0.5 });
		expect(sample.position[1]).toBeGreaterThan(0);
		expect(sample.length).toBeGreaterThan(10);
		setSpline(scene, { nodeId: spline.node.id, knots: [{ position: [0, 0, 0] }, { position: [0, 0, 10] }] }, options);
		expect(evaluateSpline(scene, { nodeId: spline.node.id, t: 1 }).position).toEqual([0, 0, 10]);
		setSpline(
			scene,
			{
				nodeId: spline.node.id,
				points: [
					[0, 0, 0],
					[10, 0, 0],
				],
				knots: null,
			},
			options
		);
		expect(getSpline(scene, { nodeId: spline.node.id }).knots).toBeNull();
		expect(evaluateSpline(scene, { nodeId: spline.node.id, t: 1 }).position).toEqual([10, 0, 0]);
	});

	test("projects linear points and Bezier tangent handles to a Ground terrain", () => {
		const terrain = MeshBuilder.CreateGround("Terrain", { width: 100, height: 100 }, scene);
		terrain.position.y = 25;
		terrain.metadata = { type: "Ground" };
		const linear = createSpline(
			scene,
			{
				name: "Linear",
				points: [
					[-20, 80, 0],
					[20, 60, 0],
				],
			},
			options
		);
		projectSplineToTerrain(scene, { nodeId: linear.node.id, terrainId: terrain.id, offset: 5 }, options);
		expect(getSpline(scene, { nodeId: linear.node.id }).points).toEqual([
			[-20, 30, 0],
			[20, 30, 0],
		]);

		const bezier = createSpline(
			scene,
			{
				name: "Bezier",
				knots: [
					{ position: [-10, 60, 0], outTangent: [0, 20, 0] },
					{ position: [10, 50, 0], inTangent: [0, 20, 0] },
				],
			},
			options
		);
		projectSplineToTerrain(scene, { nodeId: bezier.node.id, terrainId: terrain.id }, options);
		const knots = getSpline(scene, { nodeId: bezier.node.id }).knots;
		expect(knots.map((knot: any) => knot.position[1])).toEqual([25, 25]);
		expect(knots.map((knot: any) => [knot.inTangent[1], knot.outTangent[1]])).toEqual([
			[0, 0],
			[0, 0],
		]);
	});
});

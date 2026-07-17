import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";

import { createPerformanceBudget, createSceneTest, runPerformanceBudgets, runSceneTests, setPerformanceBudget, setSceneTest } from "../../src/mcp/testing/tests";

describe("mcp/scene-tests", () => {
	let engine: NullEngine;
	let scene: Scene;
	let node: TransformNode;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		node = new TransformNode("Subject", scene);
		node.position.copyFrom(new Vector3(1, 2, 3));
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("updates persisted assertions and reports per-assertion play-mode results", () => {
		const created = createSceneTest(scene, { name: "Subject checks", assertions: [] }, options);
		const updated = setSceneTest(
			scene,
			{
				id: created.id,
				assertions: [
					{ type: "node-enabled", nodeId: node.id, equals: true },
					{ type: "node-position", nodeId: node.id, equals: [1, 2, 3], epsilon: 0.001 },
				],
			},
			options
		);
		expect(updated.assertions).toHaveLength(2);
		expect(runSceneTests(scene, { id: created.id }, options)).toMatchObject({ passed: true, results: [{ assertions: [{ passed: true }, { passed: true }] }] });

		expect(() => setSceneTest(scene, { id: created.id, assertions: [{ type: "node-position", nodeId: node.id, equals: [1, 2] }] }, options)).toThrow("three finite");
	});

	test("persists and evaluates scene diagnostics performance budgets", () => {
		const budget = createPerformanceBudget(scene, { name: "Mesh limit", limits: { meshes: 0, totalVertices: 100 } }, options);
		MeshBuilder.CreateBox("Budget Mesh", {}, scene);
		const failed = runPerformanceBudgets(scene, { id: budget.id }, options);
		expect(failed).toMatchObject({ passed: false, results: [{ name: "Mesh limit", passed: false }] });
		expect(failed.results[0].limits.find((limit: any) => limit.metric === "meshes")).toMatchObject({ limit: 0, actual: 1, passed: false });
		setPerformanceBudget(scene, { id: budget.id, limits: { meshes: 1, totalVertices: 100 } }, options);
		expect(runPerformanceBudgets(scene, { id: budget.id }, options)).toMatchObject({ passed: true, results: [{ passed: true }] });
		expect(() => createPerformanceBudget(scene, { name: "Invalid", limits: { madeUpMetric: 1 } }, options)).toThrow("Unsupported performance metric");
	});
});

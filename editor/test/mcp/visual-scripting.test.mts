import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "babylonjs";

import {
	createVisualScriptGraph,
	deleteVisualScriptGraph,
	listVisualScriptGraphs,
	runVisualScriptGraph,
	setVisualScriptGraph,
	setVisualScriptNodePosition,
} from "../../src/mcp/visual-scripting/graphs";

describe("mcp/visual-scripting", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, edits, executes, lists, and deletes a variable-driven graph", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const graph = createVisualScriptGraph(
			scene,
			{
				name: "Move Target",
				variables: { destination: [2, 3, 4] },
				nodes: [
					{ id: "start", type: "event-start" },
					{ id: "move", type: "set-position", nodeId: target.id, value: { variable: "destination" } },
				],
				edges: [{ from: "start", to: "move" }],
			},
			options
		);

		setVisualScriptGraph(scene, { id: graph.id, variables: { destination: [5, 6, 7] }, autoRun: true }, options);
		expect(runVisualScriptGraph(scene, { id: graph.id }, options).executedNodeIds).toEqual(["move"]);
		expect(target.position.asArray()).toEqual([5, 6, 7]);
		expect(listVisualScriptGraphs(scene).graphs[0]).toMatchObject({ id: graph.id, autoRun: true, lastExecution: { nodes: ["move"], variables: { destination: [5, 6, 7] } } });
		expect(deleteVisualScriptGraph(scene, { id: graph.id }, options)).toEqual({ deleted: true, id: graph.id });
		expect(listVisualScriptGraphs(scene).graphs).toHaveLength(0);
	});

	test("rejects an action that references an undeclared variable", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		expect(() =>
			createVisualScriptGraph(
				scene,
				{
					name: "Invalid",
					nodes: [
						{ id: "start", type: "event-start" },
						{ id: "move", type: "set-position", nodeId: target.id, value: { variable: "missing" } },
					],
					edges: [{ from: "start", to: "move" }],
				},
				options
			)
		).toThrow("undeclared variable");
	});

	test("persists finite freeform canvas positions without replacing graph actions", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const graph = createVisualScriptGraph(
			scene,
			{
				name: "Positioned",
				nodes: [
					{ id: "start", type: "event-start" },
					{ id: "move", type: "translate", nodeId: target.id, value: [1, 0, 0] },
				],
				edges: [{ from: "start", to: "move" }],
			},
			options
		);
		expect(setVisualScriptNodePosition(scene, { id: graph.id, nodeId: "move", position: [120, 80] }, options)).toMatchObject({ position: [120, 80] });
		expect(listVisualScriptGraphs(scene).graphs[0].nodes.find((candidate: any) => candidate.id === "move")).toMatchObject({ position: [120, 80], value: [1, 0, 0] });
		expect(() => setVisualScriptNodePosition(scene, { id: graph.id, nodeId: "move", position: [NaN, 0] }, options)).toThrow("finite");
	});
});

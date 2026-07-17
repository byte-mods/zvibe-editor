import { describe, expect, test } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "@babylonjs/core";

import { configureVisualScriptGraphs } from "../../src/loading/visual-scripting";

describe("loading/visual-scripting", () => {
	test("runs persisted auto-run graph actions in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		scene.metadata = {
			babylonEditorVisualScriptGraphs: [
				{
					id: "graph",
					autoRun: true,
					nodes: [
						{ id: "start", type: "event-start" },
						{ id: "move", type: "set-position", nodeId: node.id, value: [1, 2, 3] },
					],
					edges: [{ from: "start", to: "move" }],
				},
			],
		};
		configureVisualScriptGraphs(scene);
		expect(node.position.asArray()).toEqual([1, 2, 3]);
		expect(scene.metadata.babylonEditorVisualScriptGraphs[0].lastExecution.nodes).toEqual(["move"]);
		scene.dispose();
		engine.dispose();
	});

	test("runs persisted graph variables and variable-driven actions in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		scene.metadata = {
			babylonEditorVisualScriptGraphs: [
				{
					id: "graph",
					autoRun: true,
					variables: { destination: [3, 4, 5], enabled: false },
					nodes: [
						{ id: "start", type: "event-start" },
						{ id: "set-destination", type: "set-variable", variable: "destination", value: [6, 7, 8] },
						{ id: "move", type: "set-position", nodeId: node.id, value: { variable: "destination" } },
						{ id: "disable", type: "set-enabled", nodeId: node.id, value: { variable: "enabled" } },
					],
					edges: [
						{ from: "start", to: "set-destination" },
						{ from: "set-destination", to: "move" },
						{ from: "move", to: "disable" },
					],
				},
			],
		};
		configureVisualScriptGraphs(scene);
		expect(node.position.asArray()).toEqual([6, 7, 8]);
		expect(node.isEnabled()).toBe(false);
		expect(scene.metadata.babylonEditorVisualScriptGraphs[0].lastExecution.variables).toEqual({ destination: [6, 7, 8], enabled: false });
		scene.dispose();
		engine.dispose();
	});
});

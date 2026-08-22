import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { EditorVisualScriptingPanel } from "../../src/editor/layout/animation/visual-scripting";
import { createVisualScriptGraph } from "../../src/mcp/visual-scripting/graphs";

describe("EditorVisualScriptingPanel", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { layout: { preview: { scene }, inspector: { forceUpdate: vi.fn() } } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("renders normal Flow graph authoring, custom units, ports, groups, and debugger controls", () => {
		createVisualScriptGraph(
			scene,
			{
				name: "Gameplay Flow",
				typeStyles: [{ typeId: "score-list", label: "Score List", color: "#22c55e", icon: "list" }],
				variables: [{ id: "score", name: "Score", scope: "scene", type: "number", collection: "list", dataType: "score-list", defaultValue: [0, 1] }],
				nodes: [
					{ id: "start", type: "event-start", position: [20, 20] },
					{ id: "values", type: "constant", collection: "array", dataType: "score-list", value: [1, 2], position: [20, 120] },
					{
						id: "expression",
						type: "expression",
						expression: "amount * 2\n+ bonus",
						expressionInputs: ["amount", "bonus"],
						settings: { inputValues: { amount: 1, bonus: 0 } },
						presentation: { title: "Score Formula", category: "Math", subtitle: "Multiline", icon: "sigma", color: "#22c55e", portLayout: "vertical" },
						portPresentation: [{ port: "amount", type: "untyped", multiline: true, tooltip: "Score amount" }],
						position: [100, 120],
					},
					{
						id: "custom",
						type: "custom",
						unitId: "game.award-score",
						ports: { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: ["amount"], valueOutputs: ["score"] },
						settings: { multiplier: 2, notes: "Awards score over multiple lines" },
						presentation: { optionEditors: { notes: "textarea" } },
						position: [200, 20],
					},
				],
				edges: [{ id: "edge", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "custom", port: "in" } }],
				groups: [{ id: "group", name: "Scoring", color: "#336699", nodeIds: ["custom"] }],
			},
			{ editor }
		);

		const markup = renderToStaticMarkup(createElement(EditorVisualScriptingPanel, { editor }));

		expect(markup).toContain("Runtime Debugger");
		expect(markup).toContain("Blackboard Variables");
		expect(markup).toContain("Unit Library");
		expect(markup).toContain("Port Connections");
		expect(markup).toContain("Graph Groups");
		expect(markup).toContain("game.award-score");
		expect(markup).toContain("Breakpoint");
		expect(markup).toContain("Graph Toolkit Type Styles");
		expect(markup).toContain("Score Formula");
		expect(markup).toContain("Presentation, multiline ports, and node options");
		expect(markup).toContain("List Constant");
		expect(markup).toContain("amount * 2");
		expect(markup).toContain("notes option");
		expect(markup).toContain("amount multiline port fallback");
	});

	test("renders State graph handlers and complete transition authoring", () => {
		createVisualScriptGraph(
			scene,
			{
				name: "Gameplay State",
				kind: "state",
				variables: [{ id: "ready", name: "Ready", scope: "graph", type: "boolean", defaultValue: false }],
				states: [
					{ id: "idle", name: "Idle", position: [20, 20], initial: true },
					{ id: "active", name: "Active", position: [200, 20], initial: false },
				],
				transitions: [{ id: "go", fromStateId: "idle", toStateId: "active", eventName: "Activate", conditionVariableId: "ready", invertCondition: false, priority: 1 }],
			},
			{ editor }
		);

		const markup = renderToStaticMarkup(createElement(EditorVisualScriptingPanel, { editor }));

		expect(markup).toContain("States");
		expect(markup).toContain("Transitions");
		expect(markup).toContain("No condition");
		expect(markup).toContain("Invert");
		expect(markup).toContain("Activate");
	});
});

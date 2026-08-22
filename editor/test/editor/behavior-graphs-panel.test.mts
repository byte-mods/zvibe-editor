import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import { EditorBehaviorTreesPanel } from "../../src/editor/layout/animation/behavior-trees";
import { createBehaviorTree } from "../../src/mcp/ai/behavior-trees";

describe("EditorBehaviorTreesPanel", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		new TransformNode("Agent", scene);
		editor = { layout: { preview: { scene }, inspector: { forceUpdate: vi.fn() } } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("renders graph canvas, Blackboard, utility/navigation nodes, events, and debugger controls", () => {
		createBehaviorTree(
			scene,
			{
				name: "Guard AI",
				blackboard: [{ id: "threat", name: "Threat", type: "number", scope: "graph", defaultValue: 0.5 }],
				root: {
					id: "utility",
					type: "utility-selector",
					children: [
						{ id: "wait", name: "Wait For Alert", type: "wait-event", eventName: "Alert", utility: { variableId: "threat", weight: 1 } },
						{ id: "log", type: "action-log", value: "patrol", utility: { constant: 0.1, weight: 1 } },
					],
				},
			},
			{ editor }
		);
		const markup = renderToStaticMarkup(createElement(EditorBehaviorTreesPanel, { editor }));
		expect(markup).toContain("Behavior Graphs");
		expect(markup).toContain("Blackboard");
		expect(markup).toContain("Behavior Graph canvas");
		expect(markup).toContain("Utility Selector");
		expect(markup).toContain("Send Event");
		expect(markup).toContain("Step Node");
		expect(markup).toContain("Toggle Breakpoint");
	});
});

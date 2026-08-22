import { describe, expect, test } from "vitest";

import { normalizeBehaviorGraphs, validateBehaviorGraphs } from "../../src/loading/behavior-graph-model";

describe("loading/behavior-graph-model", () => {
	test("migrates legacy trees deterministically into version-2 graphs", () => {
		const legacy = [{ id: "patrol", name: "Patrol", autoRun: true, root: { id: "root", type: "sequence", children: [{ id: "log", type: "action-log", value: "ready" }] } }];
		const first = normalizeBehaviorGraphs(legacy);
		const second = normalizeBehaviorGraphs(legacy);
		expect(first).toEqual(second);
		expect(first[0]).toMatchObject({ version: 2, revision: 1, autoStart: true, blackboard: [], root: { id: "root", enabled: true } });
		validateBehaviorGraphs(first);
	});

	test("validates typed Blackboard references and complete node semantics", () => {
		const graphs = normalizeBehaviorGraphs([
			{
				id: "guard",
				name: "Guard",
				blackboard: [{ id: "alert", name: "Alert", type: "boolean", scope: "graph", defaultValue: false }],
				root: { id: "condition", type: "condition-variable", variableId: "alert", operator: "equal", value: true },
			},
		]);
		validateBehaviorGraphs(graphs);
		graphs[0].root.variableId = "missing";
		expect(() => validateBehaviorGraphs(graphs)).toThrow(/requires a Blackboard variable|unknown Blackboard/);
	});

	test("rejects cyclic reusable subgraphs", () => {
		const graphs = normalizeBehaviorGraphs([
			{ id: "a", name: "A", root: { id: "a-call", type: "subgraph", subgraphId: "b" } },
			{ id: "b", name: "B", root: { id: "b-call", type: "subgraph", subgraphId: "a" } },
		]);
		expect(() => validateBehaviorGraphs(graphs)).toThrow(/cycle/);
	});
});

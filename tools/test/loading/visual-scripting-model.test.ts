import { describe, expect, test } from "vitest";

import {
	getGraphToolkitDataTypeStyle,
	getGraphToolkitNodePresentation,
	getGraphToolkitPortPresentation,
	getVisualScriptVariableNodes,
	isVisualScriptNodeConnected,
	normalizeVisualScriptGraphs,
	removeVisualScriptVariable,
	trySetVisualScriptConstantValue,
	trySetVisualScriptPortValue,
	trySetVisualScriptVariableValue,
	validateVisualScriptGraphs,
} from "../../src/loading/visual-scripting-model";

describe("loading/visual-scripting-model", () => {
	test("migrates legacy graphs deterministically into version-2 ports and typed variables", () => {
		const legacy = [
			{
				name: "Legacy",
				autoRun: true,
				variables: { amount: 2 },
				nodes: [
					{ id: "start", type: "event-start" },
					{ id: "set", type: "set-variable", variable: "amount", value: { variable: "amount" } },
				],
				edges: [{ from: "start", to: "set" }],
			},
		];

		const first = normalizeVisualScriptGraphs(legacy);
		const second = normalizeVisualScriptGraphs(legacy);

		expect(first).toEqual(second);
		expect(first[0]).toMatchObject({ version: 2, revision: 1, autoStart: true, kind: "flow" });
		expect(first[0].variables[0]).toMatchObject({ name: "amount", scope: "graph", type: "number", defaultValue: 2 });
		expect(first[0].edges[0]).toMatchObject({ kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "set", port: "in" } });
		validateVisualScriptGraphs(first);
	});

	test("rejects typed defaults, incompatible ports, dangling references, and recursive subgraphs", () => {
		const typed = normalizeVisualScriptGraphs([{ id: "typed", name: "Typed", variables: [{ id: "flag", name: "flag", type: "boolean", defaultValue: 1 }] }]);
		expect(() => validateVisualScriptGraphs(typed)).toThrow("declared type");

		const ports = normalizeVisualScriptGraphs([
			{
				id: "ports",
				name: "Ports",
				nodes: [
					{ id: "start", type: "event-start" },
					{ id: "constant", type: "constant", value: 1 },
				],
				edges: [{ id: "bad", kind: "control", from: { nodeId: "constant", port: "value" }, to: { nodeId: "start", port: "out" } }],
			},
		]);
		expect(() => validateVisualScriptGraphs(ports)).toThrow("incompatible ports");

		const dangling = normalizeVisualScriptGraphs([{ id: "dangling", name: "Dangling", nodes: [{ id: "get", type: "get-variable", variableId: "missing" }] }]);
		expect(() => validateVisualScriptGraphs(dangling)).toThrow("declared variableId");

		const recursive = normalizeVisualScriptGraphs([
			{ id: "a", name: "A", nodes: [{ id: "a-sub", type: "subgraph", subgraphId: "b" }] },
			{ id: "b", name: "B", nodes: [{ id: "b-sub", type: "subgraph", subgraphId: "a" }] },
		]);
		expect(() => validateVisualScriptGraphs(recursive)).toThrow("acyclic");
	});

	test("validates State graph ownership, transition types, and custom-unit ports", () => {
		const invalidState = normalizeVisualScriptGraphs([
			{
				id: "state",
				name: "State",
				kind: "state",
				variables: [{ id: "count", name: "count", scope: "graph", type: "number", defaultValue: 0 }],
				states: [
					{ id: "a", name: "A", initial: true },
					{ id: "b", name: "B" },
				],
				transitions: [{ id: "t", fromStateId: "a", toStateId: "b", eventName: "Go", conditionVariableId: "count" }],
			},
		]);
		expect(() => validateVisualScriptGraphs(invalidState)).toThrow("boolean condition");

		const invalidCustom = normalizeVisualScriptGraphs([
			{
				id: "custom",
				name: "Custom",
				nodes: [
					{
						id: "unit",
						type: "custom",
						unitId: "tests.unit",
						ports: { controlInputs: ["bad space"], controlOutputs: [], valueInputs: [], valueOutputs: [] },
					},
				],
			},
		]);
		expect(() => validateVisualScriptGraphs(invalidCustom)).toThrow("invalid name");
	});

	test("normalizes Graph Toolkit presentation, untyped values, and bounded editable collections", () => {
		const graph = normalizeVisualScriptGraphs([
			{
				id: "toolkit",
				name: "Toolkit",
				typeStyles: [{ typeId: "damage", label: "Damage", color: "#dc2626", icon: "swords" }],
				variables: [
					{ id: "items", name: "Items", type: "untyped", collection: "list", dataType: "damage", defaultValue: [1, "critical"] },
					{ id: "unused", name: "Unused", type: "number", defaultValue: 0 },
				],
				nodes: [
					{ id: "constant", type: "constant", collection: "array", value: [1, 2], presentation: { title: "Damage Values", color: "#dc2626", portLayout: "vertical" } },
					{
						id: "set",
						type: "set-variable",
						variableId: "items",
						portPresentation: [{ port: "value", type: "untyped", collection: "list", dataType: "damage", tooltip: "Incoming damage" }],
					},
				],
				edges: [{ id: "value", kind: "value", from: { nodeId: "constant", port: "value" }, to: { nodeId: "set", port: "value" } }],
			},
		]);

		validateVisualScriptGraphs(graph);
		expect(getGraphToolkitDataTypeStyle(graph[0], "damage")).toMatchObject({ label: "Damage", icon: "swords" });
		expect(getGraphToolkitNodePresentation(graph[0].nodes[0])).toMatchObject({ title: "Damage Values", portLayout: "vertical" });
		expect(getGraphToolkitPortPresentation(graph[0].nodes[1], "value")).toMatchObject({ collection: "list", tooltip: "Incoming damage" });
		expect(isVisualScriptNodeConnected(graph[0], "constant")).toBe(true);
		expect(getVisualScriptVariableNodes(graph[0], "items").map((node) => node.id)).toEqual(["set"]);
		expect(trySetVisualScriptVariableValue(graph[0], "items", [2, "blocked"])).toBe(true);
		expect(trySetVisualScriptConstantValue(graph[0], "constant", [3, 4, 5])).toBe(true);
		expect(trySetVisualScriptPortValue(graph[0], "set", "value", [])).toBe(false);
		expect(removeVisualScriptVariable(graph[0], "items")).toBe(false);
		expect(removeVisualScriptVariable(graph[0], "unused")).toBe(true);
	});

	test("rejects malformed presentation and collections beyond 50 editable elements", () => {
		const oversized = normalizeVisualScriptGraphs([
			{ id: "oversized", name: "Oversized", variables: [{ id: "values", name: "Values", type: "number", collection: "array", defaultValue: Array(51).fill(0) }] },
		]);
		expect(() => validateVisualScriptGraphs(oversized)).toThrow("capped at 50");

		const missingPort = normalizeVisualScriptGraphs([
			{ id: "port", name: "Port", nodes: [{ id: "constant", type: "constant", value: 1, portPresentation: [{ port: "missing", type: "number" }] }] },
		]);
		expect(() => validateVisualScriptGraphs(missingPort)).toThrow("missing or invalid port");

		const reservedExpressionInput = normalizeVisualScriptGraphs([
			{ id: "expression", name: "Expression", nodes: [{ id: "value", type: "expression", expression: "1", expressionInputs: ["true"] }] },
		]);
		expect(() => validateVisualScriptGraphs(reservedExpressionInput)).toThrow("reachable non-reserved identifier");

		const malformedPortPresentation = normalizeVisualScriptGraphs([
			{
				id: "multiline",
				name: "Multiline",
				nodes: [{ id: "constant", type: "constant", value: 1, portPresentation: [{ port: "value", type: "number", multiline: "yes" }] }],
			},
		]);
		expect(() => validateVisualScriptGraphs(malformedPortPresentation)).toThrow("invalid multiline port setting");

		const unknownPresentation = normalizeVisualScriptGraphs([
			{ id: "presentation", name: "Presentation", nodes: [{ id: "constant", type: "constant", value: 1, presentation: { unknown: "field" } }] },
		]);
		expect(() => validateVisualScriptGraphs(unknownPresentation)).toThrow('presentation field "unknown" is not supported');
	});
});

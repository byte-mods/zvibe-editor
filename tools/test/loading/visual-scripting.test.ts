import { afterEach, describe, expect, test } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "@babylonjs/core";

import { configureVisualScriptGraphs, IVisualScriptGraphDefinition, registerVisualScriptUnit, VisualScriptRuntime } from "../../src/loading/visual-scripting";

function flowGraph(overrides: Partial<IVisualScriptGraphDefinition> = {}): IVisualScriptGraphDefinition {
	return {
		version: 2,
		revision: 1,
		id: "flow",
		name: "Flow",
		kind: "flow",
		enabled: true,
		autoStart: false,
		variables: [],
		nodes: [],
		edges: [],
		groups: [],
		states: [],
		transitions: [],
		...overrides,
	};
}

describe("loading/visual-scripting", () => {
	const disposals: Array<() => void> = [];

	afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

	test("migrates and runs legacy auto-run graphs without mutating authored metadata", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		scene.metadata = {
			babylonEditorVisualScriptGraphs: [
				{
					id: "legacy",
					autoRun: true,
					variables: { destination: [3, 4, 5], enabled: false },
					nodes: [
						{ id: "start", type: "event-start" },
						{ id: "set-destination", type: "set-variable", variable: "destination", value: [6, 7, 8] },
						{ id: "move", type: "set-position", nodeId: target.id, value: { variable: "destination" } },
						{ id: "disable", type: "set-enabled", nodeId: target.id, value: { variable: "enabled" } },
					],
					edges: [
						{ from: "start", to: "set-destination" },
						{ from: "set-destination", to: "move" },
						{ from: "move", to: "disable" },
					],
				},
			],
		};
		const authored = structuredClone(scene.metadata.babylonEditorVisualScriptGraphs);

		const runtime = configureVisualScriptGraphs(scene)!;

		expect(target.position.asArray()).toEqual([6, 7, 8]);
		expect(target.isEnabled()).toBe(false);
		expect(runtime.getGraphState("legacy")).toMatchObject({
			status: "running",
			executedNodeIds: ["start", "set-destination", "move", "disable"],
			variables: { destination: [6, 7, 8], enabled: false },
		});
		expect(scene.metadata.babylonEditorVisualScriptGraphs).toEqual(authored);

		scene.dispose();
		engine.dispose();
	});

	test("executes typed value ports, branches, scene actions, and custom events", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const graph = flowGraph({
			variables: [{ id: "enabled", name: "enabled", scope: "graph", type: "boolean", defaultValue: false }],
			nodes: [
				{ id: "event", type: "event-custom", eventName: "Move", position: [0, 0], enabled: true },
				{ id: "one", type: "constant", value: 1, position: [0, 80], enabled: true },
				{ id: "two", type: "constant", value: 2, position: [0, 160], enabled: true },
				{ id: "add", type: "add", position: [160, 80], enabled: true },
				{ id: "vector", type: "vector3", value: { y: 0, z: 0 }, position: [240, 80], enabled: true },
				{ id: "truth", type: "constant", value: true, position: [160, 160], enabled: true },
				{ id: "branch", type: "branch", position: [320, 0], enabled: true },
				{ id: "translate", type: "translate", nodeId: target.id, value: [0, 0, 0], position: [480, 0], enabled: true },
				{ id: "set", type: "set-variable", variableId: "enabled", position: [640, 0], enabled: true },
			],
			edges: [
				{ id: "control-a", kind: "control", from: { nodeId: "event", port: "out" }, to: { nodeId: "branch", port: "in" }, order: 0 },
				{ id: "control-b", kind: "control", from: { nodeId: "branch", port: "true" }, to: { nodeId: "translate", port: "in" }, order: 1 },
				{ id: "control-c", kind: "control", from: { nodeId: "translate", port: "out" }, to: { nodeId: "set", port: "in" }, order: 2 },
				{ id: "value-a", kind: "value", from: { nodeId: "truth", port: "value" }, to: { nodeId: "branch", port: "condition" }, order: 0 },
				{ id: "value-b", kind: "value", from: { nodeId: "one", port: "value" }, to: { nodeId: "add", port: "a" }, order: 1 },
				{ id: "value-c", kind: "value", from: { nodeId: "two", port: "value" }, to: { nodeId: "add", port: "b" }, order: 2 },
				{ id: "value-vector-x", kind: "value", from: { nodeId: "add", port: "value" }, to: { nodeId: "vector", port: "x" }, order: 3 },
				{ id: "value-vector", kind: "value", from: { nodeId: "vector", port: "value" }, to: { nodeId: "translate", port: "value" }, order: 4 },
				{ id: "value-e", kind: "value", from: { nodeId: "truth", port: "value" }, to: { nodeId: "set", port: "value" }, order: 4 },
			],
		});
		const runtime = new VisualScriptRuntime(scene, [graph]);
		expect(() => runtime.setBreakpoints("flow", ["one"])).toThrow("control-node ids");

		const state = runtime.dispatchEvent("flow", "Move", { source: "test" });

		expect(target.position.asArray()).toEqual([3, 0, 0]);
		expect(state.variables.enabled).toBe(true);
		expect(state.executedNodeIds).toEqual(["event", "branch", "translate", "set"]);
		expect(runtime.getTrace().events.some((entry) => entry.phase === "dispatch" && entry.event === "Move")).toBe(true);

		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("executes safe Expression units with untyped ports and collection variables", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const graph = flowGraph({
			variables: [
				{ id: "result", name: "Result", scope: "graph", type: "number", defaultValue: 0 },
				{ id: "items", name: "Items", scope: "graph", type: "untyped", collection: "list", defaultValue: [1, "two"] },
			],
			nodes: [
				{ id: "start", type: "event-start", position: [0, 0], enabled: true },
				{ id: "speed", type: "constant", value: 4, position: [0, 80], enabled: true },
				{
					id: "expression",
					type: "expression",
					expression: "speed * delta\n+ bonus",
					expressionInputs: ["speed", "delta", "bonus"],
					position: [160, 80],
					enabled: true,
					settings: { inputValues: { delta: 2, bonus: 1 } },
				},
				{ id: "set", type: "set-variable", variableId: "result", position: [320, 0], enabled: true },
			],
			edges: [
				{ id: "control", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "set", port: "in" }, order: 0 },
				{ id: "speed", kind: "value", from: { nodeId: "speed", port: "value" }, to: { nodeId: "expression", port: "speed" }, order: 0 },
				{ id: "result", kind: "value", from: { nodeId: "expression", port: "value" }, to: { nodeId: "set", port: "value" }, order: 1 },
			],
		});
		const runtime = new VisualScriptRuntime(scene, [graph]);

		expect(runtime.runGraph("flow").variables).toMatchObject({ Result: 9, Items: [1, "two"] });
		expect(() => runtime.setVariable("flow", "items", Array(51).fill(0))).toThrow("capped at 50");

		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("returns subgraph values and executes registered custom units", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		disposals.push(
			registerVisualScriptUnit({
				id: "tests.double",
				ports: { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: ["input"], valueOutputs: ["value"] },
				execute: (context) => ({ controlOutputs: ["out"], values: { value: Number(context.input("input")) * 2 } }),
			})
		);
		const child = flowGraph({
			id: "child",
			name: "Child",
			nodes: [
				{ id: "start", type: "event-start", position: [0, 0], enabled: true },
				{ id: "input", type: "graph-input", portName: "value", position: [0, 80], enabled: true },
				{ id: "output", type: "graph-output", portName: "value", position: [160, 0], enabled: true },
			],
			edges: [
				{ id: "control", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "output", port: "in" }, order: 0 },
				{ id: "value", kind: "value", from: { nodeId: "input", port: "value" }, to: { nodeId: "output", port: "value" }, order: 0 },
			],
		});
		const parent = flowGraph({
			id: "parent",
			name: "Parent",
			variables: [{ id: "result", name: "result", scope: "graph", type: "number", defaultValue: 0 }],
			nodes: [
				{ id: "start", type: "event-start", position: [0, 0], enabled: true },
				{ id: "constant", type: "constant", value: 6, position: [0, 80], enabled: true },
				{ id: "subgraph", type: "subgraph", subgraphId: "child", value: 4, position: [160, 0], enabled: true },
				{
					id: "double",
					type: "custom",
					unitId: "tests.double",
					ports: { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: ["input"], valueOutputs: ["value"] },
					settings: {},
					position: [320, 0],
					enabled: true,
				},
				{ id: "set", type: "set-variable", variableId: "result", position: [480, 0], enabled: true },
			],
			edges: [
				{ id: "c1", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "subgraph", port: "in" }, order: 0 },
				{ id: "c2", kind: "control", from: { nodeId: "subgraph", port: "out" }, to: { nodeId: "double", port: "in" }, order: 1 },
				{ id: "c3", kind: "control", from: { nodeId: "double", port: "out" }, to: { nodeId: "set", port: "in" }, order: 2 },
				{ id: "v1", kind: "value", from: { nodeId: "constant", port: "value" }, to: { nodeId: "subgraph", port: "input" }, order: 0 },
				{ id: "v2", kind: "value", from: { nodeId: "subgraph", port: "value" }, to: { nodeId: "double", port: "input" }, order: 1 },
				{ id: "v3", kind: "value", from: { nodeId: "double", port: "value" }, to: { nodeId: "set", port: "value" }, order: 2 },
			],
		});
		const runtime = new VisualScriptRuntime(scene, [child, parent]);

		const state = runtime.runGraph("parent");

		expect(state.variables.result).toBe(12);
		expect(state.executedNodeIds).toEqual(["start", "subgraph", "double", "set"]);

		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("pauses at breakpoints, steps, continues, and bounds recursive custom events", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const debugGraph = flowGraph({
			nodes: [
				{ id: "start", type: "event-start", position: [0, 0], enabled: true },
				{ id: "move-a", type: "translate", nodeId: target.id, value: [1, 0, 0], position: [160, 0], enabled: true },
				{ id: "move-b", type: "translate", nodeId: target.id, value: [1, 0, 0], position: [320, 0], enabled: true },
			],
			edges: [
				{ id: "a", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "move-a", port: "in" }, order: 0 },
				{ id: "b", kind: "control", from: { nodeId: "move-a", port: "out" }, to: { nodeId: "move-b", port: "in" }, order: 1 },
			],
		});
		const runtime = new VisualScriptRuntime(scene, [debugGraph]);
		runtime.setBreakpoints("flow", ["move-a"]);

		expect(runtime.startGraph("flow")).toMatchObject({ status: "paused", currentNodeId: "move-a" });
		expect(target.position.x).toBe(0);
		expect(runtime.stepGraph("flow")).toMatchObject({ status: "paused", currentNodeId: "move-b" });
		expect(target.position.x).toBe(1);
		expect(runtime.continueGraph("flow")).toMatchObject({ status: "running", currentNodeId: null });
		expect(target.position.x).toBe(2);

		const recursive = flowGraph({
			id: "recursive",
			name: "Recursive",
			nodes: [
				{ id: "event", type: "event-custom", eventName: "Again", position: [0, 0], enabled: true },
				{ id: "trigger", type: "trigger-custom-event", eventName: "Again", position: [160, 0], enabled: true },
			],
			edges: [{ id: "loop", kind: "control", from: { nodeId: "event", port: "out" }, to: { nodeId: "trigger", port: "in" }, order: 0 }],
		});
		const bounded = new VisualScriptRuntime(scene, [recursive]);
		expect(() => bounded.dispatchEvent("recursive", "Again")).toThrow("call depth exceeded");

		bounded.dispose();
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("runs State graphs with typed transition conditions and handler Flow graphs", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const enter = flowGraph({
			id: "enter",
			name: "Enter Active",
			nodes: [
				{ id: "start", type: "event-start", position: [0, 0], enabled: true },
				{ id: "move", type: "set-position", nodeId: target.id, value: [9, 0, 0], position: [160, 0], enabled: true },
			],
			edges: [{ id: "edge", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "move", port: "in" }, order: 0 }],
		});
		const state: IVisualScriptGraphDefinition = {
			...flowGraph(),
			id: "state",
			name: "State",
			kind: "state",
			variables: [{ id: "ready", name: "ready", scope: "graph", type: "boolean", defaultValue: false }],
			nodes: [],
			edges: [],
			states: [
				{ id: "idle", name: "Idle", position: [0, 0], initial: true },
				{ id: "active", name: "Active", position: [160, 0], initial: false, onEnterGraphId: "enter" },
			],
			transitions: [{ id: "activate", fromStateId: "idle", toStateId: "active", eventName: "Activate", conditionVariableId: "ready", invertCondition: false, priority: 0 }],
		};
		const runtime = new VisualScriptRuntime(scene, [enter, state]);

		expect(runtime.startGraph("state").activeStateId).toBe("idle");
		expect(runtime.dispatchEvent("state", "Activate").activeStateId).toBe("idle");
		runtime.setVariable("state", "ready", true);
		expect(runtime.dispatchEvent("state", "Activate").activeStateId).toBe("active");
		expect(target.position.x).toBe(9);

		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("disposes the previous runtime when visual-script metadata is removed", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = { babylonEditorVisualScriptGraphs: [flowGraph()] };
		const previous = configureVisualScriptGraphs(scene)!;
		const dispose = previous.dispose.bind(previous);
		let disposed = false;
		previous.dispose = () => {
			disposed = true;
			dispose();
		};

		delete scene.metadata.babylonEditorVisualScriptGraphs;
		expect(configureVisualScriptGraphs(scene)).toBeUndefined();
		expect(scene.visualScripts).toBeUndefined();
		expect(disposed).toBe(true);

		scene.dispose();
		engine.dispose();
	});
});

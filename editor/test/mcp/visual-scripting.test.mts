import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	clearVisualScriptTrace,
	continueVisualScriptGraph,
	createVisualScriptEdge,
	createVisualScriptGraph,
	createVisualScriptGroup,
	createVisualScriptNode,
	createVisualScriptState,
	createVisualScriptTransition,
	createVisualScriptVariable,
	deleteVisualScriptEdge,
	deleteVisualScriptGraph,
	deleteVisualScriptGroup,
	deleteVisualScriptNode,
	deleteVisualScriptState,
	deleteVisualScriptTransition,
	deleteVisualScriptVariable,
	dispatchVisualScriptEvent,
	getGraphToolkitCapabilities,
	getVisualScriptAuthoringSnapshot,
	getVisualScriptGraph,
	getVisualScriptRuntime,
	listVisualScriptGraphs,
	inspectGraphToolkitNode,
	listVisualScriptVariableNodes,
	removeVisualScriptVariableFromGraph,
	reloadVisualScriptRuntime,
	restoreVisualScriptAuthoringSnapshot,
	restoreVisualScriptGraphs,
	runVisualScriptGraph,
	setVisualScriptBreakpoints,
	setGraphToolkitTypeStyles,
	setVisualScriptConstantValue,
	setVisualScriptEdge,
	setVisualScriptGraph,
	setVisualScriptGroup,
	setVisualScriptNode,
	setVisualScriptNodePosition,
	setVisualScriptPortValue,
	setVisualScriptRuntimeVariable,
	setVisualScriptState,
	setVisualScriptTransition,
	setVisualScriptVariable,
	startVisualScriptRuntimeGraph,
	stepVisualScriptGraph,
	stopVisualScriptRuntimeGraph,
	validateVisualScriptGraph,
} from "../../src/mcp/visual-scripting/graphs";

describe("mcp/visual-scripting", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options.editor.layout.inspector.forceUpdate.mockClear();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, exact-revision edits, executes, lists, validates, and deletes a graph", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const graph = createVisualScriptGraph(
			scene,
			{
				name: "Move Target",
				variables: [{ id: "destination", name: "destination", scope: "graph", type: "vector3", defaultValue: [2, 3, 4] }],
				nodes: [
					{ id: "start", type: "event-start" },
					{ id: "destination", type: "get-variable", variableId: "destination" },
					{ id: "move", type: "set-position", nodeId: target.id, value: [0, 0, 0] },
				],
				edges: [
					{ id: "control", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "move", port: "in" } },
					{ id: "value", kind: "value", from: { nodeId: "destination", port: "value" }, to: { nodeId: "move", port: "value" } },
				],
			},
			options
		);

		const edited = setVisualScriptGraph(scene, { id: graph.id, expectedRevision: 1, changes: { autoStart: true } }, options);
		expect(edited).toMatchObject({ revision: 2, autoStart: true, version: 2 });
		expect(runVisualScriptGraph(scene, { id: graph.id }, options)).toMatchObject({ status: "stopped", executedNodeIds: ["start", "move"] });
		expect(target.position.asArray()).toEqual([2, 3, 4]);
		expect(validateVisualScriptGraph(scene, { id: graph.id })).toMatchObject({ valid: true, revision: 2, counts: { variables: 1, nodes: 3, edges: 2 } });
		expect(getVisualScriptGraph(scene, { name: "Move Target" }).graph.id).toBe(graph.id);
		expect(listVisualScriptGraphs(scene).graphs[0]).not.toHaveProperty("lastExecution");
		expect(() => setVisualScriptGraph(scene, { id: graph.id, expectedRevision: 1, changes: { enabled: false } }, options)).toThrow("revision is stale");
		expect(deleteVisualScriptGraph(scene, { id: graph.id, expectedRevision: 2 }, options)).toEqual({ deleted: true, id: graph.id, revision: 2 });
		expect(listVisualScriptGraphs(scene).graphs).toHaveLength(0);
	});

	test("supports granular variable, node, edge, group CRUD with atomic rollback", () => {
		const graph = createVisualScriptGraph(scene, { name: "Granular" }, options);
		const variable = createVisualScriptVariable(
			scene,
			{ id: graph.id, expectedRevision: 1, variable: { name: "Amount", scope: "graph", type: "number", defaultValue: 1 } },
			options
		);
		const editedVariable = setVisualScriptVariable(scene, { id: graph.id, expectedRevision: 2, variableId: variable.variable.id, changes: { defaultValue: 2 } }, options);
		const node = createVisualScriptNode(
			scene,
			{ id: graph.id, expectedRevision: 3, node: { type: "set-variable", variableId: variable.variable.id, value: 2, position: [160, 20] } },
			options
		);
		const editedNode = setVisualScriptNode(scene, { id: graph.id, expectedRevision: 4, nodeId: node.node.id, changes: { name: "Write Amount" } }, options);
		const edge = createVisualScriptEdge(
			scene,
			{
				id: graph.id,
				expectedRevision: 5,
				edge: { kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: node.node.id, port: "in" } },
			},
			options
		);
		const editedEdge = setVisualScriptEdge(scene, { id: graph.id, expectedRevision: 6, edgeId: edge.edge.id, changes: { order: 1 } }, options);
		const group = createVisualScriptGroup(scene, { id: graph.id, expectedRevision: 7, group: { name: "Writes", color: "#123456", nodeIds: [node.node.id] } }, options);
		const editedGroup = setVisualScriptGroup(scene, { id: graph.id, expectedRevision: 8, groupId: group.group.id, changes: { color: "#654321" } }, options);

		expect(editedVariable.variable.defaultValue).toBe(2);
		expect(editedNode.node.name).toBe("Write Amount");
		expect(editedEdge.edge.order).toBe(1);
		expect(editedGroup).toMatchObject({ graphRevision: 9, group: { color: "#654321" } });
		expect(setVisualScriptNodePosition(scene, { id: graph.id, expectedRevision: 9, nodeId: node.node.id, position: [240, 80] }, options)).toMatchObject({
			graphRevision: 10,
			position: [240, 80],
		});
		const before = structuredClone(scene.metadata.babylonEditorVisualScriptGraphs);
		expect(() => setVisualScriptNode(scene, { id: graph.id, expectedRevision: 10, nodeId: node.node.id, changes: { variableId: "missing" } }, options)).toThrow(
			"declared variableId"
		);
		expect(scene.metadata.babylonEditorVisualScriptGraphs).toEqual(before);
		expect(() => setVisualScriptNodePosition(scene, { id: graph.id, expectedRevision: 10, nodeId: node.node.id, position: [NaN, 0] }, options)).toThrow("finite");

		expect(deleteVisualScriptEdge(scene, { id: graph.id, expectedRevision: 10, edgeId: edge.edge.id }, options).graphRevision).toBe(11);
		expect(deleteVisualScriptGroup(scene, { id: graph.id, expectedRevision: 11, groupId: group.group.id }, options).graphRevision).toBe(12);
		expect(deleteVisualScriptNode(scene, { id: graph.id, expectedRevision: 12, nodeId: node.node.id }, options).graphRevision).toBe(13);
		expect(deleteVisualScriptVariable(scene, { id: graph.id, expectedRevision: 13, variableId: variable.variable.id }, options).graphRevision).toBe(14);
	});

	test("restores exact raw authoring snapshots for editor Undo/Redo", () => {
		scene.metadata = { unrelated: { keep: true }, babylonEditorVisualScriptGraphs: [{ id: "legacy", autoRun: true }] };
		const snapshot = getVisualScriptAuthoringSnapshot(scene);
		createVisualScriptGraph(scene, { name: "Second" }, options);

		restoreVisualScriptAuthoringSnapshot(scene, snapshot, options);

		expect(scene.metadata).toEqual({ unrelated: { keep: true }, babylonEditorVisualScriptGraphs: [{ id: "legacy", autoRun: true }] });

		scene.metadata = {
			unrelated: { keep: true },
			babylonEditorVisualScriptGraphs: [
				{
					id: "legacy-custom",
					name: "Legacy Custom",
					autoRun: false,
					nodes: [
						{ id: "start", type: "event-start" },
						{
							id: "custom",
							type: "custom",
							unitId: "tests.unregistered",
							ports: { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: [], valueOutputs: [] },
							settings: {},
						},
					],
					edges: [{ from: "start", to: "custom" }],
				},
			],
		};
		restoreVisualScriptGraphs(scene);
		const rawBeforeFailedReconfigure = structuredClone(scene.metadata);
		expect(() => setVisualScriptGraph(scene, { id: "legacy-custom", expectedRevision: 1, changes: { autoStart: true } }, options)).toThrow("not registered");
		expect(scene.metadata).toEqual(rawBeforeFailedReconfigure);
	});

	test("authors State graphs and executes exact runtime transition controls", () => {
		const handler = createVisualScriptGraph(scene, { name: "Handler" }, options);
		let state = createVisualScriptGraph(scene, { name: "Movement State", kind: "state" }, options);
		const variable = createVisualScriptVariable(
			scene,
			{ id: state.id, expectedRevision: state.revision, variable: { name: "Ready", scope: "graph", type: "boolean", defaultValue: false } },
			options
		);
		state = getVisualScriptGraph(scene, { id: state.id }).graph;
		const active = createVisualScriptState(
			scene,
			{ id: state.id, expectedRevision: state.revision, state: { name: "Active", position: [200, 20], onEnterGraphId: handler.id } },
			options
		);
		state = getVisualScriptGraph(scene, { id: state.id }).graph;
		const transition = createVisualScriptTransition(
			scene,
			{
				id: state.id,
				expectedRevision: state.revision,
				transition: {
					fromStateId: "initial",
					toStateId: active.state.id,
					eventName: "Activate",
					conditionVariableId: variable.variable.id,
				},
			},
			options
		);
		const updated = setVisualScriptTransition(
			scene,
			{ id: state.id, expectedRevision: transition.graphRevision, transitionId: transition.transition.id, changes: { priority: 4 } },
			options
		);
		expect(updated.transition.priority).toBe(4);
		expect(
			setVisualScriptState(scene, { id: state.id, expectedRevision: updated.graphRevision, stateId: active.state.id, changes: { position: [220, 40] } }, options).state
				.position
		).toEqual([220, 40]);

		expect(reloadVisualScriptRuntime(scene, {}, options).graphs).toHaveLength(2);
		expect(startVisualScriptRuntimeGraph(scene, { id: state.id }, options).activeStateId).toBe("initial");
		expect(dispatchVisualScriptEvent(scene, { id: state.id, event: "Activate" }, options).activeStateId).toBe("initial");
		setVisualScriptRuntimeVariable(scene, { id: state.id, variableName: "Ready", value: true }, options);
		expect(dispatchVisualScriptEvent(scene, { id: state.id, event: "Activate" }, options).activeStateId).toBe(active.state.id);
		expect(stopVisualScriptRuntimeGraph(scene, { id: state.id }, options).status).toBe("stopped");

		const latest = getVisualScriptGraph(scene, { id: state.id }).graph;
		expect(deleteVisualScriptTransition(scene, { id: state.id, expectedRevision: latest.revision, transitionId: transition.transition.id }, options).deleted).toBe(true);
		const afterTransition = getVisualScriptGraph(scene, { id: state.id }).graph;
		expect(deleteVisualScriptState(scene, { id: state.id, expectedRevision: afterTransition.revision, stateId: active.state.id }, options).deleted).toBe(true);
	});

	test("controls live breakpoints, stepping, trace paging, and runtime variable typing", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const graph = createVisualScriptGraph(
			scene,
			{
				name: "Debug",
				variables: [{ id: "speed", name: "Speed", scope: "graph", type: "number", defaultValue: 1 }],
				nodes: [
					{ id: "start", type: "event-start" },
					{ id: "a", type: "translate", nodeId: target.id, value: [1, 0, 0] },
					{ id: "b", type: "translate", nodeId: target.id, value: [1, 0, 0] },
				],
				edges: [
					{ id: "a", kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: "a", port: "in" } },
					{ id: "b", kind: "control", from: { nodeId: "a", port: "out" }, to: { nodeId: "b", port: "in" } },
				],
			},
			options
		);
		restoreVisualScriptGraphs(scene);
		setVisualScriptBreakpoints(scene, { id: graph.id, nodeIds: ["a"] }, options);

		expect(startVisualScriptRuntimeGraph(scene, { id: graph.id }, options)).toMatchObject({ status: "paused", currentNodeId: "a" });
		expect(stepVisualScriptGraph(scene, { id: graph.id }, options)).toMatchObject({ status: "paused", currentNodeId: "b" });
		expect(continueVisualScriptGraph(scene, { id: graph.id }, options)).toMatchObject({ status: "running", currentNodeId: null });
		expect(target.position.x).toBe(2);
		expect(getVisualScriptRuntime(scene, { offset: 0, limit: 2 }).trace).toMatchObject({ offset: 0, events: expect.any(Array) });
		expect(clearVisualScriptTrace(scene, {}, options).cleared).toBeGreaterThan(0);
		expect(() => setVisualScriptRuntimeVariable(scene, { id: graph.id, variableName: "Speed", value: "fast" }, options)).toThrow("declared type");
		expect(() => setVisualScriptRuntimeVariable(scene, { id: graph.id, variableId: "speed", variableName: "Speed", value: 2 }, options)).toThrow("exactly one");
	});

	test("authors and inspects every Graph Toolkit 6.5 feature under exact revision control", () => {
		const graph = createVisualScriptGraph(
			scene,
			{
				name: "Graph Toolkit",
				typeStyles: [{ typeId: "initial", label: "Initial", color: "#64748b", icon: "circle" }],
				variables: [{ id: "unused", name: "Unused", type: "untyped", collection: "list", defaultValue: [1, "two"] }],
				nodes: [
					{
						id: "constant",
						type: "constant",
						collection: "array",
						dataType: "damage",
						value: [1, 2],
						presentation: { title: "Damage", icon: "swords", color: "#dc2626" },
					},
					{
						id: "expression",
						type: "expression",
						expression: "x * 2",
						expressionInputs: ["x"],
						portPresentation: [{ port: "x", type: "number", dataType: "damage", multiline: true, tooltip: "Damage input" }],
						presentation: {
							title: "Formula",
							category: "Math",
							subtitle: "Damage",
							icon: "sigma",
							color: "#16a34a",
							portLayout: "vertical",
							optionEditors: { expression: "textarea" },
						},
					},
				],
			},
			options
		);

		expect(graph.typeStyles).toEqual([{ typeId: "initial", label: "Initial", color: "#64748b", icon: "circle" }]);
		expect(getGraphToolkitCapabilities(scene)).toMatchObject({ collections: { maximumEditableElements: 50 }, presentation: { multilinePorts: true } });
		expect(inspectGraphToolkitNode(scene, { id: graph.id, nodeId: "expression" })).toMatchObject({
			connected: false,
			presentation: { title: "Formula", portLayout: "vertical" },
		});
		const styles = setGraphToolkitTypeStyles(
			scene,
			{ id: graph.id, expectedRevision: 1, typeStyles: [{ typeId: "damage", label: "Damage", color: "#dc2626", icon: "swords" }] },
			options
		);
		expect(styles.graphRevision).toBe(2);
		const createdVariable = createVisualScriptVariable(
			scene,
			{ id: graph.id, expectedRevision: 2, variable: { name: "Created List", type: "untyped", collection: "array", dataType: "damage", defaultValue: [1, "two"] } },
			options
		);
		expect(createdVariable).toMatchObject({ graphRevision: 3, variable: { collection: "array", dataType: "damage" } });
		expect(setVisualScriptConstantValue(scene, { id: graph.id, expectedRevision: 3, nodeId: "constant", value: [3, 4, 5] }, options)).toMatchObject({ graphRevision: 4 });
		expect(setVisualScriptPortValue(scene, { id: graph.id, expectedRevision: 4, nodeId: "expression", port: "x", value: 6 }, options)).toMatchObject({
			graphRevision: 5,
			value: 6,
		});
		expect(listVisualScriptVariableNodes(scene, { id: graph.id, variableId: "unused", limit: 1 })).toMatchObject({ total: 0, nodes: [] });
		expect(removeVisualScriptVariableFromGraph(scene, { id: graph.id, expectedRevision: 5, variableId: createdVariable.variable.id }, options)).toMatchObject({
			removed: true,
			graphRevision: 6,
		});
		expect(removeVisualScriptVariableFromGraph(scene, { id: graph.id, expectedRevision: 6, variableName: "Unused" }, options)).toMatchObject({
			removed: true,
			graphRevision: 7,
		});
		expect(() => setVisualScriptConstantValue(scene, { id: graph.id, expectedRevision: 6, nodeId: "constant", value: [] }, options)).toThrow("revision is stale");
	});

	test("maps the complete authoring/runtime/debugger endpoint family and advertises exact capabilities", () => {
		for (const endpoint of [
			"list_visual_script_graphs",
			"get_visual_script_graph",
			"get_graph_toolkit_capabilities",
			"inspect_graph_toolkit_node",
			"list_visual_script_variable_nodes",
			"set_graph_toolkit_type_styles",
			"set_visual_script_constant_value",
			"set_visual_script_port_value",
			"remove_visual_script_variable_from_graph",
			"create_visual_script_graph",
			"set_visual_script_graph",
			"delete_visual_script_graph",
			"create_visual_script_variable",
			"set_visual_script_variable",
			"delete_visual_script_variable",
			"create_visual_script_node",
			"set_visual_script_node",
			"delete_visual_script_node",
			"set_visual_script_node_position",
			"create_visual_script_edge",
			"set_visual_script_edge",
			"delete_visual_script_edge",
			"create_visual_script_group",
			"set_visual_script_group",
			"delete_visual_script_group",
			"create_visual_script_state",
			"set_visual_script_state",
			"delete_visual_script_state",
			"create_visual_script_transition",
			"set_visual_script_transition",
			"delete_visual_script_transition",
			"validate_visual_script_graph",
			"run_visual_script_graph",
			"get_visual_script_runtime",
			"reload_visual_script_runtime",
			"start_visual_script_runtime_graph",
			"stop_visual_script_runtime_graph",
			"dispatch_visual_script_event",
			"set_visual_script_breakpoints",
			"continue_visual_script_graph",
			"step_visual_script_graph",
			"set_visual_script_runtime_variable",
			"clear_visual_script_trace",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(scene, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			visualScripting: true,
			visualScriptingFlowGraphs: true,
			visualScriptingStateGraphs: true,
			visualScriptingCustomUnits: true,
			visualScriptingDebugger: true,
			visualScriptingExportRuntime: true,
			graphToolkitExpressions: true,
			graphToolkitUntypedPorts: true,
			graphToolkitMultilinePortsAndOptions: true,
			graphToolkitCustomTypeStyles: true,
			graphToolkitEditableCollections: true,
		});
	});
});

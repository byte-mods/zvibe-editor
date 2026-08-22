import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	clearBehaviorTreeTrace,
	continueBehaviorTree,
	createBehaviorBlackboardVariable,
	createBehaviorTree,
	createBehaviorTreeNode,
	deleteBehaviorBlackboardVariable,
	deleteBehaviorTree,
	deleteBehaviorTreeNode,
	dispatchBehaviorTreeEvent,
	getBehaviorGraphAuthoringSnapshot,
	getBehaviorTree,
	getBehaviorTreeRuntime,
	listBehaviorTrees,
	moveBehaviorTreeNode,
	reloadBehaviorTreeRuntime,
	restoreBehaviorGraphAuthoringSnapshot,
	runBehaviorTree,
	setBehaviorBlackboardVariable,
	setBehaviorTree,
	setBehaviorTreeBreakpoints,
	setBehaviorTreeNode,
	setBehaviorTreeRuntimeBlackboard,
	startBehaviorTree,
	stepBehaviorTree,
	stopBehaviorTree,
	tickBehaviorTree,
	validateBehaviorTreeCollection,
} from "../../src/mcp/ai/behavior-trees";

describe("mcp/behavior-trees", () => {
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

	test("creates, exact-revision edits, executes, reads, validates, and deletes a graph", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 1 }, scene);
		const created = createBehaviorTree(
			scene,
			{
				name: "Patrol",
				root: {
					id: "root",
					type: "sequence",
					children: [
						{ id: "condition", type: "condition-node-enabled", nodeId: target.id, value: true },
						{ id: "action", type: "action-set-position", nodeId: target.id, value: [1, 2, 3] },
					],
				},
			},
			options
		);
		const edited = setBehaviorTree(scene, { id: created.id, expectedRevision: 1, changes: { autoStart: true } }, options);
		expect(edited).toMatchObject({ version: 2, revision: 2, autoStart: true });
		expect(runBehaviorTree(scene, { id: created.id }, options)).toMatchObject({ status: "succeeded", success: true });
		expect(target.position.asArray()).toEqual([1, 2, 3]);
		expect(getBehaviorTree(scene, { name: "Patrol" }).tree.id).toBe(created.id);
		expect(validateBehaviorTreeCollection(scene)).toEqual({ valid: true, graphCount: 1 });
		expect(() => setBehaviorTree(scene, { id: created.id, expectedRevision: 1, changes: { enabled: false } }, options)).toThrow("revision is stale");
		expect(deleteBehaviorTree(scene, { id: created.id, expectedRevision: 2 }, options)).toEqual({ deleted: true, id: created.id, revision: 2 });
		expect(listBehaviorTrees(scene).trees).toHaveLength(0);
	});

	test("supports granular Blackboard and hierarchy CRUD with atomic validation", () => {
		const created = createBehaviorTree(scene, { name: "Granular" }, options);
		const variable = createBehaviorBlackboardVariable(
			scene,
			{ id: created.id, expectedRevision: 1, variable: { name: "Alert", type: "boolean", defaultValue: false } },
			options
		);
		const updatedVariable = setBehaviorBlackboardVariable(
			scene,
			{ id: created.id, expectedRevision: 2, variableId: variable.variable.id, changes: { defaultValue: true } },
			options
		);
		expect(updatedVariable).toMatchObject({ graphRevision: 3, variable: { defaultValue: true } });

		const root = getBehaviorTree(scene, { id: created.id }).tree.root;
		const node = createBehaviorTreeNode(
			scene,
			{ id: created.id, expectedRevision: 3, parentId: root.id, node: { type: "condition-variable", variableId: variable.variable.id, operator: "equal", value: true } },
			options
		);
		expect(setBehaviorTreeNode(scene, { id: created.id, expectedRevision: 4, nodeId: node.node.id, changes: { name: "Is Alert" } }, options)).toMatchObject({
			graphRevision: 5,
		});
		expect(moveBehaviorTreeNode(scene, { id: created.id, expectedRevision: 5, nodeId: node.node.id, parentId: root.id, index: 0 }, options)).toMatchObject({
			graphRevision: 6,
			moved: true,
		});

		const raw = structuredClone(scene.metadata.babylonEditorBehaviorTrees);
		expect(() => setBehaviorTreeNode(scene, { id: created.id, expectedRevision: 6, nodeId: node.node.id, changes: { variableId: "missing" } }, options)).toThrow(/Blackboard/);
		expect(scene.metadata.babylonEditorBehaviorTrees).toEqual(raw);
		expect(() => deleteBehaviorBlackboardVariable(scene, { id: created.id, expectedRevision: 6, variableId: variable.variable.id }, options)).toThrow("still referenced");

		expect(deleteBehaviorTreeNode(scene, { id: created.id, expectedRevision: 6, nodeId: node.node.id }, options)).toMatchObject({ graphRevision: 7, deleted: true });
		expect(deleteBehaviorBlackboardVariable(scene, { id: created.id, expectedRevision: 7, variableId: variable.variable.id }, options)).toMatchObject({
			graphRevision: 8,
			deleted: true,
		});
	});

	test("restores exact raw snapshots and exposes event/runtime/debug controls", () => {
		scene.metadata = { unrelated: { keep: true }, babylonEditorBehaviorTrees: [{ id: "legacy", name: "Legacy", root: { id: "log", type: "action-log", value: "legacy" } }] };
		const snapshot = getBehaviorGraphAuthoringSnapshot(scene);
		createBehaviorTree(scene, { name: "Second" }, options);
		restoreBehaviorGraphAuthoringSnapshot(scene, snapshot, options);
		expect(scene.metadata).toEqual({
			unrelated: { keep: true },
			babylonEditorBehaviorTrees: [{ id: "legacy", name: "Legacy", root: { id: "log", type: "action-log", value: "legacy" } }],
		});

		const graph = createBehaviorTree(
			scene,
			{
				name: "Debug",
				blackboard: [{ id: "ready", name: "Ready", type: "boolean", defaultValue: false }],
				root: {
					id: "root",
					type: "sequence",
					children: [
						{ id: "wait", type: "wait-event", eventName: "Go" },
						{ id: "condition", type: "condition-variable", variableId: "ready", operator: "equal", value: true },
					],
				},
			},
			options
		);
		expect(reloadBehaviorTreeRuntime(scene, {}, options).states).toHaveLength(2);
		setBehaviorTreeBreakpoints(scene, { id: graph.id, nodeIds: ["wait"] }, options);
		expect(startBehaviorTree(scene, { id: graph.id }, options).status).toBe("paused");
		expect(stepBehaviorTree(scene, { id: graph.id }, options).status).toBe("paused");
		expect(continueBehaviorTree(scene, { id: graph.id }, options).status).toBe("running");
		setBehaviorTreeRuntimeBlackboard(scene, { id: graph.id, variableName: "Ready", value: true }, options);
		expect(dispatchBehaviorTreeEvent(scene, { id: graph.id, eventName: "Go" }, options).states[0].status).toBe("succeeded");
		expect(tickBehaviorTree(scene, { id: graph.id, deltaSeconds: 0 }, options).status).toBe("succeeded");
		expect(getBehaviorTreeRuntime(scene, { id: graph.id }).trace.length).toBeGreaterThan(0);
		expect(clearBehaviorTreeTrace(scene, {}, options)).toEqual({ cleared: true });
		expect(stopBehaviorTree(scene, { id: graph.id }, options).status).toBe("stopped");
	});

	test("maps every Behavior Graph endpoint and advertises the complete capability surface", () => {
		const endpoints = [
			"list_behavior_trees",
			"get_behavior_tree",
			"create_behavior_tree",
			"set_behavior_tree",
			"delete_behavior_tree",
			"validate_behavior_trees",
			"create_behavior_blackboard_variable",
			"set_behavior_blackboard_variable",
			"delete_behavior_blackboard_variable",
			"create_behavior_tree_node",
			"set_behavior_tree_node",
			"delete_behavior_tree_node",
			"move_behavior_tree_node",
			"run_behavior_tree",
			"reload_behavior_tree_runtime",
			"get_behavior_tree_runtime",
			"start_behavior_tree",
			"stop_behavior_tree",
			"tick_behavior_tree",
			"dispatch_behavior_tree_event",
			"set_behavior_tree_runtime_blackboard",
			"set_behavior_tree_breakpoints",
			"continue_behavior_tree",
			"step_behavior_tree",
			"clear_behavior_tree_trace",
		];
		for (const endpoint of endpoints) expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		expect(getEditorCapabilities(scene, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any).features).toMatchObject({
			behaviorTrees: true,
			behaviorGraphBlackboard: true,
			behaviorGraphSubgraphs: true,
			behaviorGraphEvents: true,
			behaviorGraphUtilityAI: true,
			behaviorGraphNavigation: true,
			behaviorGraphCustomNodes: true,
			behaviorGraphDebugger: true,
			behaviorGraphExportRuntime: true,
		});
	});
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { BehaviorGraphRuntime, configureBehaviorTrees, registerBehaviorNode } from "../../src/loading/behavior-trees";
import { configureNavAgents } from "../../src/loading/nav-agents";

describe("loading/behavior-trees", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("runs typed Blackboard conditions, timed actions, and events across ticks", () => {
		const runtime = new BehaviorGraphRuntime(scene, [
			{
				id: "event-graph",
				name: "Event Graph",
				blackboard: [
					{ id: "ready", name: "Ready", type: "boolean", scope: "graph", defaultValue: true },
					{ id: "message", name: "Message", type: "string", scope: "graph", defaultValue: "" },
				],
				root: {
					id: "root",
					type: "sequence",
					children: [
						{ id: "condition", type: "condition-variable", variableId: "ready", operator: "equal", value: true },
						{ id: "wait", type: "action-wait", duration: 0.25 },
						{ id: "event", type: "wait-event", eventName: "Go", variableId: "message" },
					],
				},
			},
		]);
		expect(runtime.startGraph("event-graph").status).toBe("running");
		expect(runtime.tickGraph("event-graph", 0.25).status).toBe("running");
		expect(runtime.getGraphState("event-graph").nodeStatuses["event-graph:event"]).toBe("waiting");
		expect(runtime.dispatchEvent("Go", "received", "event-graph")[0]).toMatchObject({ status: "succeeded", blackboard: { Message: "received" } });
		expect(runtime.getTrace().some((entry) => entry.phase === "event" && entry.detail === "Go")).toBe(true);
	});

	test("chooses the highest utility branch and executes scene actions", () => {
		const target = new TransformNode("Target", scene);
		const runtime = new BehaviorGraphRuntime(scene, [
			{
				id: "utility",
				name: "Utility",
				blackboard: [
					{ id: "attack", name: "Attack", type: "number", scope: "graph", defaultValue: 0.9 },
					{ id: "flee", name: "Flee", type: "number", scope: "graph", defaultValue: 0.2 },
				],
				root: {
					id: "choose",
					type: "utility-selector",
					children: [
						{ id: "attack-action", type: "action-set-position", nodeId: target.id, value: [10, 0, 0], utility: { variableId: "attack", weight: 1 } },
						{ id: "flee-action", type: "action-set-position", nodeId: target.id, value: [-10, 0, 0], utility: { variableId: "flee", weight: 1 } },
					],
				},
			},
		]);
		expect(runtime.startGraph("utility").status).toBe("succeeded");
		expect(target.position.asArray()).toEqual([10, 0, 0]);
	});

	test("runs reusable subgraphs and code-registered custom nodes", () => {
		const unregister = registerBehaviorNode({
			id: "increment",
			tick: ({ getBlackboard, setBlackboard }) => {
				setBlackboard("count", Number(getBlackboard("count")) + 1);
				return "succeeded";
			},
		});
		try {
			const runtime = new BehaviorGraphRuntime(scene, [
				{
					id: "child",
					name: "Child",
					blackboard: [{ id: "count", name: "Count", type: "number", scope: "scene", defaultValue: 0 }],
					root: { id: "increment-node", type: "custom", unitId: "increment", settings: {} },
				},
				{
					id: "parent",
					name: "Parent",
					blackboard: [{ id: "parent-count", name: "Count", type: "number", scope: "scene", defaultValue: 0 }],
					root: { id: "subgraph", type: "subgraph", subgraphId: "child" },
				},
			]);
			expect(runtime.startGraph("parent").status).toBe("succeeded");
			expect(runtime.getGraphState("parent").blackboard.Count).toBe(1);
		} finally {
			unregister();
		}
	});

	test("pauses at exact node breakpoints and advances with deterministic node stepping", () => {
		const runtime = new BehaviorGraphRuntime(scene, [
			{
				id: "debug",
				name: "Debug",
				root: {
					id: "root",
					type: "sequence",
					children: [
						{ id: "first", type: "action-log", value: "first" },
						{ id: "second", type: "action-log", value: "second" },
					],
				},
			},
		]);
		runtime.setBreakpoints("debug", ["first"]);
		expect(runtime.startGraph("debug").status).toBe("paused");
		expect(runtime.getGraphState("debug").currentNodeId).toBe("first");
		expect(runtime.stepGraph("debug").status).toBe("paused");
		expect(runtime.continueGraph("debug").status).toBe("succeeded");
	});

	test("reuses the live Detour Crowd controller for navigation actions", async () => {
		const actor = new TransformNode("Actor", scene);
		let position = Vector3.Zero();
		let destination = Vector3.Zero();
		scene.metadata = {
			babylonEditorNavAgents: [
				{
					id: "agent",
					nodeId: actor.id,
					navMeshPath: "navigation.navmesh",
					radius: 1,
					height: 2,
					maxSpeed: 2,
					maxAcceleration: 4,
					reachRadius: 0.1,
					destination: null,
					isMoving: false,
				},
			],
		};
		await configureNavAgents(
			scene,
			"",
			async () =>
				({
					createCrowd: () => ({
						addAgent: () => 0,
						agentGoto: (_index: number, next: Vector3) => {
							destination = next.clone();
						},
						agentTeleport: (_index: number, next: Vector3) => {
							position = next.clone();
						},
						updateAgentParameters: () => undefined,
						removeAgent: () => undefined,
						getAgentPosition: () => position.clone(),
						getAgentVelocity: () => Vector3.Zero(),
						getAgentNextTargetPath: () => destination.clone(),
						getAgentState: () => 1,
						overOffmeshConnection: () => false,
						getCorners: () => [],
						setDefaultQueryExtent: () => undefined,
						dispose: () => undefined,
					}),
					dispose: () => undefined,
				}) as any
		);
		const runtime = new BehaviorGraphRuntime(scene, [
			{ id: "navigation", name: "Navigation", root: { id: "move", type: "action-nav-move-to", navAgentId: "agent", value: [5, 0, 0] } },
		]);
		expect(runtime.startGraph("navigation").status).toBe("running");
		expect(destination.asArray()).toEqual([5, 0, 0]);
		position = destination.clone();
		scene.metadata.babylonEditorNavAgents[0].isMoving = false;
		expect(runtime.tickGraph("navigation", 1 / 60).status).toBe("succeeded");
	});

	test("configures auto-start graphs and disposes the previous scene runtime", () => {
		scene.metadata = { babylonEditorBehaviorTrees: [{ id: "auto", name: "Auto", autoStart: true, root: { id: "log", type: "action-log", value: "ready" } }] };
		const first = configureBehaviorTrees(scene);
		expect(first.getGraphState("auto").status).toBe("succeeded");
		const second = configureBehaviorTrees(scene);
		expect(second).not.toBe(first);
		expect((scene as any).behaviorGraphs).toBe(second);
	});
});

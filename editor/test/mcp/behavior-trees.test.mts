import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import { createBehaviorTree, runBehaviorTree, setBehaviorTree } from "../../src/mcp/ai/behavior-trees";

describe("mcp/behavior-trees", () => {
	let engine: NullEngine;
	let scene: Scene;
	let target: TransformNode;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		target = new TransformNode("Target", scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists and runs nested sequence and selector authoring", () => {
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
		expect(runBehaviorTree(scene, { id: created.id }, options)).toMatchObject({ success: true, executedNodeIds: ["root", "condition", "action"] });
		expect(target.position.asArray()).toEqual([1, 2, 3]);

		setBehaviorTree(
			scene,
			{ id: created.id, root: { id: "selector", type: "selector", children: [{ id: "disable", type: "action-set-enabled", nodeId: target.id, value: false }] } },
			options
		);
		expect(runBehaviorTree(scene, { id: created.id }, options).success).toBe(true);
		expect(target.isEnabled()).toBe(false);
	});
});

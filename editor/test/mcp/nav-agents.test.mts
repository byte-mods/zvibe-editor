import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { createNavAgent, listNavAgents, setNavAgent } from "../../src/mcp/navmesh/navmesh";

describe("mcp/nav agents", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists local crowd avoidance settings and edits them without clearing agent state", async () => {
		const node = new TransformNode("Agent", scene);
		const agent = await createNavAgent(scene, { id: "agent", nodeId: node.id, navMeshPath: "assets/world.navmesh", radius: 20, avoidanceRadius: 50, avoidanceWeight: 2 }, options);
		const updated = setNavAgent(scene, { id: agent.id, avoidanceEnabled: false, avoidanceWeight: 0.5 }, options);

		expect(updated).toMatchObject({ id: "agent", avoidanceEnabled: false, avoidanceRadius: 50, avoidanceWeight: 0.5 });
		expect(listNavAgents(scene).agents).toEqual([expect.objectContaining({ id: "agent", avoidanceEnabled: false, avoidanceRadius: 50, avoidanceWeight: 0.5 })]);
	});
});

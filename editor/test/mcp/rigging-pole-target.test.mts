import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { listIKControllers, setIKController } from "../../src/mcp/rigging/ik";

describe("mcp/rigging pole target", () => {
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

	test("persists a pole target update for a serialized IK controller", () => {
		const pole = new TransformNode("Elbow Pole", scene);
		scene.metadata = {
			babylonEditorIKControllers: [{ id: "arm", skeletonId: "skeleton", meshId: "mesh", boneName: "Forearm", targetNodeId: "target", enabled: true }],
		};

		const result = setIKController(scene, { id: "arm", poleTargetNodeId: pole.id, poleAngle: 0.4, hintWeight: 0.35 }, options);
		expect(result).toMatchObject({ id: "arm", poleTargetNodeId: pole.id, poleAngle: 0.4, hintWeight: 0.35, active: false });
		expect(listIKControllers(scene).controllers).toEqual([expect.objectContaining({ id: "arm", poleTargetNodeId: pole.id, hintWeight: 0.35 })]);
		expect(() => setIKController(scene, { id: "arm", hintWeight: 1.1 }, options)).toThrow("hintWeight must be a finite value from 0 through 1");

		const cleared = setIKController(scene, { id: "arm", poleTargetNodeId: null }, options);
		expect(cleared).not.toHaveProperty("poleTargetNodeId");
		expect(listIKControllers(scene).controllers[0]).not.toHaveProperty("poleTargetNodeId");
	});
});

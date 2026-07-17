import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { bakeSpriteIKAnimation, createSpriteIKController, createSpriteIKRig, listSpriteIKControllers, setSpriteIKController } from "../../src/mcp/rigging/ik";

describe("mcp/sprite IK", () => {
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

	test("persists and solves a planar root-joint-tip Sprite IK chain", () => {
		const root = new TransformNode("Root", scene);
		const joint = new TransformNode("Joint", scene);
		joint.parent = root;
		joint.position.x = 1;
		const tip = new TransformNode("Tip", scene);
		tip.parent = joint;
		tip.position.x = 1;
		const target = new TransformNode("Target", scene);
		target.position.copyFromFloats(1, 1, 0);

		const result = createSpriteIKController(scene, { id: "arm", rootNodeId: root.id, jointNodeId: joint.id, tipNodeId: tip.id, targetNodeId: target.id }, options);
		expect(result).toMatchObject({ id: "arm", active: true, bendDirection: "counterClockwise" });
		tip.computeWorldMatrix(true);
		expect(Vector3.Distance(tip.getAbsolutePosition(), target.getAbsolutePosition())).toBeLessThan(0.01);
		expect(listSpriteIKControllers(scene).controllers).toEqual([expect.objectContaining({ id: "arm", targetNodeId: target.id })]);

		const updated = setSpriteIKController(scene, { id: "arm", bendDirection: "clockwise", enabled: false }, options);
		expect(updated).toMatchObject({ bendDirection: "clockwise", enabled: false, active: true });
	});

	test("rejects a chain without the required parent hierarchy", () => {
		const root = new TransformNode("Root", scene);
		const joint = new TransformNode("Joint", scene);
		joint.position.x = 1;
		const tip = new TransformNode("Tip", scene);
		tip.parent = joint;
		tip.position.x = 1;
		const target = new TransformNode("Target", scene);
		expect(() => createSpriteIKController(scene, { rootNodeId: root.id, jointNodeId: joint.id, tipNodeId: tip.id, targetNodeId: target.id }, options)).toThrow(
			"Sprite IK chain"
		);
	});

	test("authors an editable transform hierarchy together with a Sprite IK controller", () => {
		const result = createSpriteIKRig(
			scene,
			{ id: "authored-arm", name: "Hero Arm", firstLength: 30, secondLength: 40, position: [10, 20, 0], targetPosition: [50, 40, 0] },
			options
		);
		const root = scene.getTransformNodeById(result.rootNodeId)!;
		const joint = scene.getTransformNodeById(result.jointNodeId)!;
		const tip = scene.getTransformNodeById(result.tipNodeId)!;
		const target = scene.getTransformNodeById(result.targetNodeId)!;
		expect(root.name).toBe("Hero Arm Root");
		expect(joint.parent).toBe(root);
		expect(tip.parent).toBe(joint);
		expect(joint.position.x).toBe(30);
		expect(tip.position.x).toBe(40);
		expect(target.position.asArray()).toEqual([50, 40, 0]);
		expect(result.controller).toMatchObject({ id: "authored-arm", active: true });
	});

	test("bakes target poses into editable root and joint rotation tracks", () => {
		createSpriteIKRig(scene, { id: "animated-arm", name: "Animated Arm", firstLength: 1, secondLength: 1 }, options);
		const result = bakeSpriteIKAnimation(
			scene,
			{
				id: "animated-arm",
				name: "Wave",
				framesPerSecond: 30,
				poses: [
					{ frame: 0, targetPosition: [1, 1, 0] },
					{ frame: 15, targetPosition: [1.5, 0.5, 0] },
				],
			},
			options
		);
		const group = scene.getAnimationGroupByName("Wave")!;
		expect(result).toEqual({ name: "Wave", framesPerSecond: 30, tracks: 2, frames: [0, 15] });
		expect(group.targetedAnimations).toHaveLength(2);
		expect(group.targetedAnimations.every((track) => track.animation.targetProperty === "rotation.z" && track.animation.getKeys().length === 2)).toBe(true);
	});
});

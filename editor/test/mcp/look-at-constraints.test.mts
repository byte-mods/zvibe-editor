import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Bone, Matrix, MeshBuilder, NullEngine, Scene, Skeleton, TransformNode, Vector3 } from "babylonjs";

import { createLookAtConstraint, deleteLookAtConstraint, listLookAtConstraints, setLookAtConstraint } from "../../src/mcp/rigging/ik";

describe("mcp/look-at constraints", () => {
	let engine: NullEngine;
	let scene: Scene;
	let skeleton: Skeleton;
	let mesh: ReturnType<typeof MeshBuilder.CreateBox>;
	let target: TransformNode;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		skeleton = new Skeleton("Character", "character-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity());
		new Bone("Head", skeleton, root, Matrix.Translation(0, 1, 0));
		mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		target = new TransformNode("Look Target", scene);
		target.position.copyFrom(new Vector3(2, 1, 3));
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, updates, lists, and deletes a persistent bone look-at constraint", () => {
		const constraint = createLookAtConstraint(
			scene,
			{ skeletonId: skeleton.id, boneName: "Head", meshId: mesh.id, targetNodeId: target.id, minYaw: -0.5, maxYaw: 0.5, slerpAmount: 0.5 },
			options
		);
		expect(listLookAtConstraints(scene).constraints).toMatchObject([{ id: constraint.id, boneName: "Head", targetNodeId: target.id, active: true }]);
		const replacementTarget = new TransformNode("Replacement Target", scene);
		expect(setLookAtConstraint(scene, { id: constraint.id, enabled: false, adjustYaw: 0.2, targetNodeId: replacementTarget.id }, options)).toMatchObject({
			enabled: false,
			adjustYaw: 0.2,
			targetNodeId: replacementTarget.id,
			active: true,
		});
		expect(deleteLookAtConstraint(scene, { id: constraint.id }, options)).toEqual({ deleted: true, id: constraint.id });
		expect(listLookAtConstraints(scene).constraints).toEqual([]);
	});
});

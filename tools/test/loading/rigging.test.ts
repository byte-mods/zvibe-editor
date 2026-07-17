import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Bone, Matrix, MeshBuilder, NullEngine, Quaternion, Scene, Skeleton, Space, TransformNode, Vector3 } from "@babylonjs/core";

import { configureLookAtConstraints, configureSpriteIKControllers } from "../../src/loading/rigging";
import { applyRigLayers, configureRigLayers } from "../../src/loading/rig-layers";

describe("loading/rigging", () => {
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

	test("restores a persisted bone look-at constraint in exported runtime", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity());
		new Bone("Head", skeleton, root, Matrix.Translation(0, 1, 0));
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Look Target", scene);
		target.position.copyFrom(new Vector3(2, 1, 3));
		scene.metadata = {
			babylonEditorLookAtConstraints: [
				{ id: "head-look", skeletonId: skeleton.id, boneName: "Head", meshId: mesh.id, targetNodeId: target.id, minYaw: -0.5, maxYaw: 0.5, slerpAmount: 0.5 },
			],
		};

		expect(() => configureLookAtConstraints(scene)).not.toThrow();
		expect(scene.onBeforeRenderObservable.hasObservers()).toBe(true);
	});

	test("restores a persisted planar Sprite IK chain in exported runtime", () => {
		const root = new TransformNode("Root", scene);
		const joint = new TransformNode("Joint", scene);
		joint.parent = root;
		joint.position.x = 1;
		const tip = new TransformNode("Tip", scene);
		tip.parent = joint;
		tip.position.x = 1;
		const target = new TransformNode("Target", scene);
		target.position.copyFromFloats(1, 1, 0);
		scene.metadata = { babylonEditorSpriteIKControllers: [{ id: "arm", rootNodeId: root.id, jointNodeId: joint.id, tipNodeId: tip.id, targetNodeId: target.id }] };

		configureSpriteIKControllers(scene);
		tip.computeWorldMatrix(true);
		expect(Vector3.Distance(tip.getAbsolutePosition(), target.getAbsolutePosition())).toBeLessThan(0.01);
		expect(scene.onBeforeRenderObservable.hasObservers()).toBe(true);
	});

	test("evaluates weighted multi-parent constraints from persisted rig layers", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const bone = new Bone("Driven", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const source = new TransformNode("Source", scene);
		source.position.copyFromFloats(5, 2, -1);
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "body-rig",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "parent",
							type: "multiParent",
							boneName: bone.name,
							weight: 1,
							enabled: true,
							sources: [{ nodeId: source.id, weight: 1, positionOffset: [0, 0, 0], rotationOffset: [0, 0, 0, 1] }],
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene)).toMatchObject({ layerCount: 1, constraintCount: 1, appliedConstraintCount: 1, failedConstraintIds: [] });
		expect(bone.getPosition().asArray()).toEqual([5, 2, -1]);
		configureRigLayers(scene);
		expect(scene.onBeforeRenderObservable.hasObservers()).toBe(true);
	});

	test("extracts and distributes signed local twist from a source bone", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const source = new Bone("Forearm", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const twist = new Bone("ForearmTwist", skeleton, source, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		source.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2);
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "arm-rig",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "twist",
							type: "twist",
							sourceBoneName: source.name,
							sourceRestRotation: [0, 0, 0, 1],
							axis: [1, 0, 0],
							weight: 1,
							enabled: true,
							twistBones: [{ boneName: twist.name, weight: 0.5, restRotation: [0, 0, 0, 1] }],
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene).appliedConstraintCount).toBe(1);
		expect(twist.rotationQuaternion.toEulerAngles().x).toBeCloseTo(Math.PI / 4);
	});

	test("solves reachable and extended Chain IK targets with bounded FABRIK rotation", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		new Bone("Middle", skeleton, root, Matrix.Translation(1, 0, 0), Matrix.Translation(1, 0, 0));
		const tip = new Bone("Tip", skeleton, skeleton.bones[1], Matrix.Translation(1, 0, 0), Matrix.Translation(1, 0, 0));
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("IK Target", scene);
		target.position.copyFromFloats(1, 1, 0);
		target.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 3);
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "chain-rig",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "chain",
							type: "chainIk",
							rootBoneName: root.name,
							tipBoneName: tip.name,
							targetNodeId: target.id,
							maxIterations: 32,
							tolerance: 0.0001,
							chainRotationWeight: 1,
							tipRotationWeight: 1,
							weight: 1,
							enabled: true,
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene).appliedConstraintCount).toBe(1);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(tip.getPosition(Space.WORLD, mesh), target.getAbsolutePosition())).toBeLessThan(0.01);
		expect(Math.abs(Quaternion.Dot(tip.getRotationQuaternion(Space.WORLD, mesh), target.absoluteRotationQuaternion!))).toBeCloseTo(1);

		target.position.copyFromFloats(4, 0, 0);
		target.computeWorldMatrix(true);
		expect(applyRigLayers(scene).appliedConstraintCount).toBe(1);
		skeleton.computeAbsoluteMatrices(true);
		expect(tip.getPosition(Space.WORLD, mesh).x).toBeCloseTo(2);
	});

	test("blends Multi-Position sources while respecting XYZ channel masks", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const bone = new Bone("Driven", skeleton, null, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const sourceA = new TransformNode("Source A", scene);
		sourceA.position.copyFromFloats(0, 10, 0);
		const sourceB = new TransformNode("Source B", scene);
		sourceB.position.copyFromFloats(4, 10, 6);
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "position-rig",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "position",
							type: "multiPosition",
							boneName: bone.name,
							sources: [
								{ nodeId: sourceA.id, weight: 0.25, positionOffset: [0, 0, 0] },
								{ nodeId: sourceB.id, weight: 0.75, positionOffset: [0, 0, 0] },
							],
							maintainOffset: false,
							positionAxes: [true, false, true],
							weight: 1,
							enabled: true,
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene).appliedConstraintCount).toBe(1);
		expect(bone.getPosition(Space.WORLD, mesh).asArray()).toEqual([3, 2, 4.5]);
	});

	test("aims a local axis toward weighted sources with world-up stabilization", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const bone = new Bone("Head", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const source = new TransformNode("Aim Source", scene);
		source.position.copyFromFloats(0, 3, 0);
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "aim-rig",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "aim",
							type: "multiAim",
							boneName: bone.name,
							sources: [{ nodeId: source.id, weight: 1 }],
							aimAxis: [1, 0, 0],
							upAxis: [0, 0, 1],
							worldUpAxis: [0, 0, 1],
							rotationOffset: [0, 0, 0, 1],
							weight: 1,
							enabled: true,
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene).appliedConstraintCount).toBe(1);
		const worldAim = Vector3.Right().applyRotationQuaternion(bone.getRotationQuaternion(Space.WORLD, mesh)).normalize();
		expect(Vector3.Dot(worldAim, Vector3.Up())).toBeCloseTo(1);
	});

	test("solves multiple Full-Body IK effectors through shared and branch joints", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const leftJoint = new Bone("Left Joint", skeleton, root, Matrix.Translation(1, 0, 0), Matrix.Translation(1, 0, 0));
		const leftTip = new Bone("Left Tip", skeleton, leftJoint, Matrix.Translation(1, 0, 0), Matrix.Translation(1, 0, 0));
		const rightJoint = new Bone("Right Joint", skeleton, root, Matrix.Translation(-1, 0, 0), Matrix.Translation(-1, 0, 0));
		const rightTip = new Bone("Right Tip", skeleton, rightJoint, Matrix.Translation(-1, 0, 0), Matrix.Translation(-1, 0, 0));
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const leftTarget = new TransformNode("Left Target", scene);
		leftTarget.position.copyFromFloats(1, 1, 0);
		leftTarget.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 4);
		const rightTarget = new TransformNode("Right Target", scene);
		rightTarget.position.copyFromFloats(-1, 1, 0);
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "full-body-rig",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "full-body",
							type: "fullBodyIk",
							rootBoneName: root.name,
							maxIterations: 48,
							tolerance: 0.01,
							effectors: [
								{ boneName: leftTip.name, targetNodeId: leftTarget.id, positionWeight: 1, rotationWeight: 1 },
								{ boneName: rightTip.name, targetNodeId: rightTarget.id, positionWeight: 1, rotationWeight: 0 },
							],
							weight: 1,
							enabled: true,
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene).appliedConstraintCount).toBe(1);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(leftTip.getPosition(Space.WORLD, mesh), leftTarget.getAbsolutePosition())).toBeLessThan(0.05);
		expect(Vector3.Distance(rightTip.getPosition(Space.WORLD, mesh), rightTarget.getAbsolutePosition())).toBeLessThan(0.05);
		expect(Math.abs(Quaternion.Dot(leftTip.getRotationQuaternion(Space.WORLD, mesh), leftTarget.absoluteRotationQuaternion!))).toBeCloseTo(1);
	});

	test("evaluates Override, temporal Damped, and two-source Blend transform constraints", () => {
		const overrideSkeleton = new Skeleton("Override", "override-skeleton", scene);
		const overrideBone = new Bone("Override Bone", overrideSkeleton, null, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const overrideMesh = MeshBuilder.CreateBox("Override Mesh", { size: 1 }, scene);
		overrideMesh.skeleton = overrideSkeleton;
		const overrideSource = new TransformNode("Override Source", scene);
		overrideSource.position.copyFromFloats(5, 10, 0);
		overrideSource.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2);

		const blendSkeleton = new Skeleton("Blend", "blend-skeleton", scene);
		const blendBone = new Bone("Blend Bone", blendSkeleton, null, Matrix.Identity(), Matrix.Identity());
		const blendMesh = MeshBuilder.CreateBox("Blend Mesh", { size: 1 }, scene);
		blendMesh.skeleton = blendSkeleton;
		const blendA = new TransformNode("Blend A", scene);
		const blendB = new TransformNode("Blend B", scene);
		blendB.position.x = 8;

		const dampedSkeleton = new Skeleton("Damped", "damped-skeleton", scene);
		const dampedBone = new Bone("Damped Bone", dampedSkeleton, null, Matrix.Identity(), Matrix.Identity());
		const dampedMesh = MeshBuilder.CreateBox("Damped Mesh", { size: 1 }, scene);
		dampedMesh.skeleton = dampedSkeleton;
		const dampedSource = new TransformNode("Damped Source", scene);
		dampedSource.position.x = 10;

		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "override-layer",
					skeletonId: overrideSkeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "override",
							type: "overrideTransform",
							boneName: overrideBone.name,
							sourceNodeId: overrideSource.id,
							positionOffset: [0, 0, 0],
							rotationOffset: [0, 0, 0, 1],
							positionWeight: 1,
							rotationWeight: 1,
							positionAxes: [true, false, false],
							rotationAxes: [false, false, true],
							weight: 1,
							enabled: true,
						},
					],
				},
				{
					id: "blend-layer",
					skeletonId: blendSkeleton.id,
					order: 1,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "blend",
							type: "blendTransform",
							boneName: blendBone.name,
							sourceNodeIdA: blendA.id,
							sourceNodeIdB: blendB.id,
							positionOffsetA: [0, 0, 0],
							positionOffsetB: [0, 0, 0],
							rotationOffsetA: [0, 0, 0, 1],
							rotationOffsetB: [0, 0, 0, 1],
							blend: 0.25,
							positionWeight: 1,
							rotationWeight: 1,
							positionAxes: [true, true, true],
							rotationAxes: [true, true, true],
							weight: 1,
							enabled: true,
						},
					],
				},
				{
					id: "damped-layer",
					skeletonId: dampedSkeleton.id,
					order: 2,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "damped",
							type: "dampedTransform",
							boneName: dampedBone.name,
							sourceNodeId: dampedSource.id,
							positionOffset: [0, 0, 0],
							rotationOffset: [0, 0, 0, 1],
							positionWeight: 1,
							rotationWeight: 1,
							positionAxes: [true, true, true],
							rotationAxes: [true, true, true],
							positionDamping: 0.5,
							rotationDamping: 0.5,
							weight: 1,
							enabled: true,
						},
					],
				},
			],
		};

		expect(applyRigLayers(scene).appliedConstraintCount).toBe(3);
		expect(overrideBone.getPosition(Space.WORLD, overrideMesh).asArray()).toEqual([5, 2, 0]);
		expect(overrideBone.getRotationQuaternion(Space.WORLD, overrideMesh).toEulerAngles().z).toBeCloseTo(Math.PI / 2);
		expect(blendBone.getPosition(Space.WORLD, blendMesh).x).toBeCloseTo(2);
		const firstDampedPosition = dampedBone.getPosition(Space.WORLD, dampedMesh).x;
		expect(firstDampedPosition).toBeGreaterThan(0);
		expect(firstDampedPosition).toBeLessThan(10);
		for (let index = 0; index < 60; index++) {
			applyRigLayers(scene);
		}
		expect(dampedBone.getPosition(Space.WORLD, dampedMesh).x).toBeGreaterThan(9.9);
	});
});

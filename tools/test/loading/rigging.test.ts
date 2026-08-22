import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Bone, Matrix, MeshBuilder, NullEngine, Quaternion, Scene, Skeleton, Space, TransformNode, Vector3 } from "@babylonjs/core";

import { configureIKControllers, configureLookAtConstraints, configureSpriteIKControllers, getTwoBoneIKEndpoint } from "../../src/loading/rigging";
import {
	applyRigLayers,
	clearAnimationRigProfile,
	configureAnimationRigProfiler,
	configureRigLayers,
	getAnimationRigProfile,
	getAnimationRigJobRuntimeDiagnostics,
	listAnimationRigJobTypes,
	registerAnimationRigJob,
	resetRigLayerTemporalState,
} from "../../src/loading/rig-layers";

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

	test("applies native Two-Bone target position and Tip rotation weights in exported runtime", () => {
		const skeleton = new Skeleton("Arm", "arm-skeleton", scene);
		const root = new Bone("Upper", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Lower", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const tip = new Bone("Hand", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Arm Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Target", scene);
		target.position.copyFromFloats(2, 3, 0);
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.4, -0.2, 0.6);
		scene.metadata = {
			babylonEditorIKControllers: [
				{
					id: "arm-ik",
					skeletonId: skeleton.id,
					boneName: mid.name,
					meshId: mesh.id,
					targetNodeId: target.id,
					targetPositionWeight: 1,
					targetRotationWeight: 1,
					slerpAmount: 1,
					enabled: true,
				},
			],
		};

		configureIKControllers(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(getTwoBoneIKEndpoint(mesh, mid), target.getAbsolutePosition())).toBeLessThan(0.001);
		expect(Math.abs(Quaternion.Dot(tip.getRotationQuaternion(Space.WORLD, mesh), target.rotationQuaternion))).toBeCloseTo(1, 5);
	});

	test("preserves authored Two-Bone target position and rotation offsets in exported runtime", () => {
		const skeleton = new Skeleton("Offset Arm", "offset-arm", scene);
		const root = new Bone("Upper", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Lower", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const tip = new Bone("Hand", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Offset Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Offset Target", scene);
		target.position.copyFromFloats(2, 3, 0);
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.2, 0.1, -0.3);
		target.computeWorldMatrix(true);
		skeleton.computeAbsoluteMatrices(true);
		const initialEndpoint = getTwoBoneIKEndpoint(mesh, mid);
		const positionOffset = Vector3.TransformCoordinates(initialEndpoint, target.getWorldMatrix().clone().invert());
		const rotationOffset = target.rotationQuaternion.conjugate().multiply(tip.getRotationQuaternion(Space.WORLD, mesh)).normalize();
		scene.metadata = {
			babylonEditorIKControllers: [
				{
					id: "offset-ik",
					skeletonId: skeleton.id,
					boneName: mid.name,
					meshId: mesh.id,
					targetNodeId: target.id,
					targetPositionWeight: 1,
					targetRotationWeight: 1,
					maintainTargetPositionOffset: true,
					maintainTargetRotationOffset: true,
					targetPositionOffset: positionOffset.asArray(),
					targetRotationOffset: rotationOffset.asArray(),
					slerpAmount: 1,
					enabled: true,
				},
			],
		};
		configureIKControllers(scene);
		target.position.copyFromFloats(4, 2, 1);
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(-0.4, 0.3, 0.5);
		target.computeWorldMatrix(true);
		const expectedPosition = Vector3.TransformCoordinates(positionOffset, target.getWorldMatrix());
		const expectedRotation = target.rotationQuaternion.multiply(rotationOffset).normalize();
		scene.onBeforeRenderObservable.notifyObservers(scene);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(getTwoBoneIKEndpoint(mesh, mid), expectedPosition)).toBeLessThan(0.001);
		expect(Math.abs(Quaternion.Dot(tip.getRotationQuaternion(Space.WORLD, mesh), expectedRotation))).toBeCloseTo(1, 5);
	});

	test("blends Unity-style Hint Weight from the original animated bend plane toward the pole target", () => {
		const skeleton = new Skeleton("Hint Arm", "hint-arm", scene);
		const root = new Bone("Upper", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Lower", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		new Bone("Hand", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Hint Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Hint Target", scene);
		target.position.copyFromFloats(2.5, 2.5, 0);
		const pole = new TransformNode("Hint", scene);
		const config = {
			id: "hint-ik",
			skeletonId: skeleton.id,
			boneName: mid.name,
			meshId: mesh.id,
			targetNodeId: target.id,
			poleTargetNodeId: pole.id,
			targetPositionWeight: 1,
			hintWeight: 1,
			slerpAmount: 1,
			enabled: true,
		};
		scene.metadata = { babylonEditorIKControllers: [config] };
		configureIKControllers(scene);
		const evaluate = (hintWeight: number, polePosition: Vector3): { rootRotation: Quaternion; jointPosition: Vector3 } => {
			root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
			mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
			skeleton.computeAbsoluteMatrices(true);
			config.hintWeight = hintWeight;
			pole.position.copyFrom(polePosition);
			pole.computeWorldMatrix(true);
			scene.onBeforeRenderObservable.notifyObservers(scene);
			skeleton.computeAbsoluteMatrices(true);
			expect(Vector3.Distance(getTwoBoneIKEndpoint(mesh, mid), target.getAbsolutePosition())).toBeLessThan(0.001);
			return { rootRotation: root.getRotationQuaternion(Space.WORLD, mesh).clone(), jointPosition: mid.getPosition(Space.WORLD, mesh).clone() };
		};
		const noHintA = evaluate(0, new Vector3(0, 1, 3));
		const noHintB = evaluate(0, new Vector3(0, 1, -3));
		expect(Math.abs(Quaternion.Dot(noHintA.rootRotation, noHintB.rootRotation))).toBeCloseTo(1, 6);
		const fullHintA = evaluate(1, new Vector3(0, 1, 3));
		const fullHintB = evaluate(1, new Vector3(0, 1, -3));
		expect(Math.abs(Quaternion.Dot(fullHintA.rootRotation, fullHintB.rootRotation))).toBeLessThan(0.95);
		const halfHintA = evaluate(0.5, new Vector3(0, 1, 3));
		const rootPosition = root.getPosition(Space.WORLD, mesh);
		const axis = target.getAbsolutePosition().subtract(rootPosition).normalize();
		const projectedDirection = (joint: Vector3): Vector3 => {
			const direction = joint.subtract(rootPosition);
			return direction.subtract(axis.scale(Vector3.Dot(direction, axis))).normalize();
		};
		const signedAngle = (from: Vector3, to: Vector3): number => Math.atan2(Vector3.Dot(Vector3.Cross(from, to), axis), Vector3.Dot(from, to));
		const fullAngle = signedAngle(projectedDirection(noHintA.jointPosition), projectedDirection(fullHintA.jointPosition));
		const halfAngle = signedAngle(projectedDirection(noHintA.jointPosition), projectedDirection(halfHintA.jointPosition));
		expect(Math.abs(fullAngle)).toBeGreaterThan(0.2);
		expect(halfAngle / fullAngle).toBeCloseTo(0.5, 2);

		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		skeleton.computeAbsoluteMatrices(true);
		config.hintWeight = 0.5;
		pole.position.copyFromFloats(0, 1, 3);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const firstHintRotation = root.getRotationQuaternion(Space.WORLD, mesh).clone();
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const secondHintRotation = root.getRotationQuaternion(Space.WORLD, mesh).clone();
		expect(Math.abs(Quaternion.Dot(firstHintRotation, secondHintRotation))).toBeCloseTo(1, 6);

		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		skeleton.computeAbsoluteMatrices(true);
		config.targetPositionWeight = 0.5;
		config.hintWeight = 1;
		pole.position.copyFromFloats(0, 1, 3);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const firstWeightedRotation = root.getRotationQuaternion(Space.WORLD, mesh).clone();
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const secondWeightedRotation = root.getRotationQuaternion(Space.WORLD, mesh).clone();
		expect(Math.abs(Quaternion.Dot(firstWeightedRotation, secondWeightedRotation))).toBeCloseTo(1, 6);
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

	test("supports filtered fixed-step rig evaluation and deterministic temporal-state reset for baking", () => {
		const skeleton = new Skeleton("Bake Character", "bake-character", scene);
		const bone = new Bone("Driven", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const ignoredBone = new Bone("Ignored", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Bake Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const source = new TransformNode("Source", scene);
		source.position.x = 10;
		const ignoredSource = new TransformNode("Ignored Source", scene);
		ignoredSource.position.x = 25;
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "bake-layer",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "ignored",
							type: "multiPosition",
							boneName: ignoredBone.name,
							maintainOffset: false,
							positionAxes: [true, true, true],
							sources: [{ nodeId: ignoredSource.id, weight: 1, positionOffset: [0, 0, 0] }],
							weight: 1,
							enabled: true,
						},
						{
							id: "damped",
							type: "dampedTransform",
							boneName: bone.name,
							sourceNodeId: source.id,
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

		const selection = { constraintRefs: [{ layerId: "bake-layer", constraintId: "damped" }] };
		const first = applyRigLayers(scene, { skeletonId: skeleton.id, layerIds: ["bake-layer"], ...selection, deltaTimeSeconds: 1 / 120, resetTemporalState: true });
		expect(first).toMatchObject({ layerCount: 1, constraintCount: 1, appliedConstraintCount: 1 });
		expect(ignoredBone.getPosition().x).toBe(0);
		const firstPosition = bone.getPosition().x;
		bone.setPosition(Vector3.Zero());
		applyRigLayers(scene, { skeletonId: skeleton.id, layerIds: ["bake-layer"], ...selection, deltaTimeSeconds: 1 / 120, resetTemporalState: true });
		expect(bone.getPosition().x).toBeCloseTo(firstPosition);
		bone.setPosition(Vector3.Zero());
		applyRigLayers(scene, { skeletonId: skeleton.id, layerIds: ["bake-layer"], ...selection, deltaTimeSeconds: 1 / 120 });
		expect(bone.getPosition().x).toBeGreaterThan(firstPosition);
		expect(applyRigLayers(scene, { skeletonId: "different" })).toMatchObject({ layerCount: 0, constraintCount: 0 });
	});

	test("profiles the shared rig evaluator with bounded hierarchical samples, counters, filtering, and overflow evidence", () => {
		const skeleton = new Skeleton("Profile Character", "profile-character", scene);
		const bone = new Bone("Driven", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Profile Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const source = new TransformNode("Profile Source", scene);
		source.position.x = 4;
		scene.metadata = {
			babylonEditorRigLayers: [
				{
					id: "profile-layer",
					name: "Profile Layer",
					skeletonId: skeleton.id,
					order: 0,
					weight: 1,
					enabled: true,
					constraints: [
						{
							id: "applied",
							name: "Applied Position",
							type: "multiPosition",
							boneName: bone.name,
							maintainOffset: false,
							positionAxes: [true, true, true],
							sources: [{ nodeId: source.id, weight: 1, positionOffset: [0, 0, 0] }],
							weight: 1,
							enabled: true,
						},
						{
							id: "disabled",
							name: "Disabled Position",
							type: "multiPosition",
							boneName: bone.name,
							maintainOffset: false,
							positionAxes: [true, true, true],
							sources: [{ nodeId: source.id, weight: 1, positionOffset: [0, 0, 0] }],
							weight: 1,
							enabled: false,
						},
						{
							id: "failed",
							name: "Missing Source",
							type: "multiPosition",
							boneName: bone.name,
							maintainOffset: false,
							positionAxes: [true, true, true],
							sources: [{ nodeId: "missing", weight: 1, positionOffset: [0, 0, 0] }],
							weight: 1,
							enabled: true,
						},
					],
				},
			],
		};
		expect(configureAnimationRigProfiler(scene, { enabled: true, sampleCapacity: 2, sampleEveryNEvaluations: 2 })).toMatchObject({
			settings: { enabled: true, sampleCapacity: 2, sampleEveryNEvaluations: 2 },
		});
		for (let index = 0; index < 5; index++) {
			expect(applyRigLayers(scene)).toMatchObject({ constraintCount: 3, appliedConstraintCount: 1, failedConstraintIds: ["failed"] });
		}
		const profile = getAnimationRigProfile(scene, { skeletonId: skeleton.id, includeSamples: true, sampleLimit: 10 });
		expect(profile).toMatchObject({
			evaluationCount: 5,
			capturedSampleCount: 3,
			retainedSampleCount: 2,
			droppedSampleCount: 1,
			pagination: { total: 2, count: 2, offset: 0, hasMore: false, nextOffset: null },
		});
		expect(profile.samples.map((sample: any) => sample.evaluationIndex)).toEqual([5, 3]);
		expect(profile.samples[0]).toMatchObject({ constraintCount: 3, appliedConstraintCount: 1, failedConstraintCount: 1, disabledConstraintCount: 1 });
		expect(profile.samples[0].layers[0]).toMatchObject({ layerId: "profile-layer", appliedConstraintCount: 1, failedConstraintCount: 1, disabledConstraintCount: 1 });
		expect(profile.samples[0].layers[0].constraints.map((constraint: any) => [constraint.constraintId, constraint.status])).toEqual([
			["applied", "applied"],
			["disabled", "disabled"],
			["failed", "failed"],
		]);
		expect(profile.constraintSummaries.find((summary: any) => summary.id === "applied")).toMatchObject({ sampleCount: 3, appliedCount: 3, failedCount: 0, skippedCount: 0 });
		expect(profile.constraintSummaries.find((summary: any) => summary.id === "disabled")).toMatchObject({ sampleCount: 3, appliedCount: 0, failedCount: 0, skippedCount: 3 });
		expect(profile.constraintSummaries.find((summary: any) => summary.id === "failed")).toMatchObject({ sampleCount: 3, appliedCount: 0, failedCount: 3, skippedCount: 0 });
		expect(profile.sceneSummary.minimumDurationMilliseconds).toBeGreaterThanOrEqual(0);
		expect(getAnimationRigProfile(scene, { layerId: "profile-layer", constraintId: "failed" }).constraintSummaries).toHaveLength(1);
		configureAnimationRigProfiler(scene, { enabled: false, sampleCapacity: 1 });
		applyRigLayers(scene);
		expect(getAnimationRigProfile(scene)).toMatchObject({ evaluationCount: 5, retainedSampleCount: 1, droppedSampleCount: 2, settings: { enabled: false } });
		expect(clearAnimationRigProfile(scene)).toMatchObject({
			evaluationCount: 0,
			capturedSampleCount: 0,
			retainedSampleCount: 0,
			droppedSampleCount: 0,
			settings: { enabled: false, sampleCapacity: 1, sampleEveryNEvaluations: 2 },
		});
	});

	test("runs registered Unity-style custom Animation Rig job lifecycle with serialized bindings, weights, diagnostics, and reset", () => {
		const skeleton = new Skeleton("Custom Job Character", "custom-job-character", scene);
		const bone = new Bone("Driven", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Custom Job Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Custom Job Target", scene);
		target.position.copyFromFloats(8, 2, 0);
		const calls = { create: 0, update: 0, root: 0, animation: 0, destroy: 0 };
		const unregister = registerAnimationRigJob<{ offset: [number, number, number] }, { samples: number }>({
			id: "test.copy-position",
			displayName: "Test Copy Position",
			description: "Test job",
			dataVersion: 3,
			setDefaultValues: () => ({ offset: [0, 0, 0] }),
			validate: (context) => (context.bones.length === 1 && context.nodes.length === 1 ? true : "Expected one bone and node."),
			create: () => {
				calls.create++;
				return { samples: 0 };
			},
			update: (_context, state) => {
				calls.update++;
				state.samples++;
			},
			processRootMotion: () => {
				calls.root++;
			},
			processAnimation: (context) => {
				calls.animation++;
				const current = context.bones[0].getPosition(Space.WORLD, context.mesh);
				const desired = context.nodes[0].getAbsolutePosition().add(Vector3.FromArray(context.data.offset));
				context.bones[0].setPosition(Vector3.Lerp(current, desired, context.weight), Space.WORLD, context.mesh);
				return true;
			},
			destroy: () => {
				calls.destroy++;
			},
		});
		try {
			expect(listAnimationRigJobTypes()).toContainEqual({
				id: "test.copy-position",
				displayName: "Test Copy Position",
				description: "Test job",
				dataVersion: 3,
				hasRootMotion: true,
				defaultData: { offset: [0, 0, 0] },
			});
			const layer = {
				id: "custom-layer",
				skeletonId: skeleton.id,
				order: 0,
				weight: 0.5,
				enabled: true,
				constraints: [
					{
						id: "custom",
						type: "customJob",
						jobType: "test.copy-position",
						jobVersion: 3,
						boneNames: [bone.name],
						nodeIds: [target.id],
						jobData: { offset: [2, 0, 0] },
						weight: 0.5,
						enabled: true,
					},
				],
			};
			scene.metadata = { babylonEditorRigLayers: [layer] };
			expect(applyRigLayers(scene, { deltaTimeSeconds: 1 / 30 })).toMatchObject({ appliedConstraintCount: 1, failedConstraintIds: [] });
			expect(bone.getPosition(Space.WORLD, mesh).asArray()).toEqual([2.5, 0.5, 0]);
			expect(applyRigLayers(scene, { deltaTimeSeconds: 1 / 30 }).appliedConstraintCount).toBe(1);
			expect(calls).toMatchObject({ create: 1, update: 2, root: 2, animation: 2, destroy: 0 });
			expect(getAnimationRigJobRuntimeDiagnostics(scene, layer, layer.constraints[0])).toMatchObject({
				registered: true,
				valid: true,
				registeredDataVersion: 3,
				hasRootMotion: true,
				createCount: 1,
				updateCount: 2,
				processRootMotionCount: 2,
				processAnimationCount: 2,
				errorCount: 0,
				lastWeight: 0.25,
				lastSucceeded: true,
			});
			resetRigLayerTemporalState(scene);
			expect(calls.destroy).toBe(1);
			expect(applyRigLayers(scene, { resetTemporalState: true }).appliedConstraintCount).toBe(1);
			expect(calls).toMatchObject({ create: 2, destroy: 1 });
			layer.constraints[0].jobVersion = 2;
			expect(applyRigLayers(scene)).toMatchObject({ appliedConstraintCount: 0, failedConstraintIds: ["custom"] });
			expect(getAnimationRigJobRuntimeDiagnostics(scene, layer, layer.constraints[0])).toMatchObject({
				valid: false,
				validationMessage: "Registered data version 3 does not match serialized version 2.",
			});
		} finally {
			resetRigLayerTemporalState(scene);
			unregister();
		}
	});
});

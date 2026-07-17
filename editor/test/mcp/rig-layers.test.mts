import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Bone, Matrix, MeshBuilder, NullEngine, Quaternion, Scene, Skeleton, Space, TransformNode, Vector3 } from "babylonjs";
import { applyRigLayers } from "babylonjs-editor-tools";

import { createRigConstraint, createRigLayer, deleteRigConstraint, deleteRigLayer, listRigLayers, setRigConstraint, setRigLayer } from "../../src/mcp/rigging/rig-layers";
import { getRigConstraintGraph, setRigConstraintGraphLayout } from "../../src/mcp/rigging/rig-constraint-graph";

describe("mcp/animation rig layers", () => {
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

	test("authors ordered weighted multi-parent and twist constraints with captured offsets/rest rotations", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const driven = new Bone("Driven", skeleton, root, Matrix.Identity(), Matrix.Identity());
		const forearm = new Bone("Forearm", skeleton, root, Matrix.Identity(), Matrix.Identity());
		const forearmTwist = new Bone("ForearmTwist", skeleton, forearm, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const parentSource = new TransformNode("Parent Source", scene);
		parentSource.position.x = 3;

		const layer = createRigLayer(scene, { id: "body-rig", name: "Body Rig", skeletonId: skeleton.id, order: 10, weight: 1 }, options);
		const parent = createRigConstraint(
			scene,
			{ layerId: layer.id, id: "parent", type: "multiParent", boneName: driven.name, sources: [{ nodeId: parentSource.id, weight: 1 }] },
			options
		);
		expect(parent).toMatchObject({ id: "parent", type: "multiParent", valid: true });
		expect(parent.sources[0].positionOffset[0]).toBeCloseTo(-3);

		parentSource.position.x = 5;
		parentSource.computeWorldMatrix(true);
		expect(applyRigLayers(scene as any).appliedConstraintCount).toBe(1);
		expect(driven.getPosition().x).toBeCloseTo(2);

		const twist = createRigConstraint(
			scene,
			{
				layerId: layer.id,
				id: "twist",
				type: "twist",
				sourceBoneName: forearm.name,
				axis: [1, 0, 0],
				twistBones: [{ boneName: forearmTwist.name, weight: 0.5 }],
			},
			options
		);
		expect(twist).toMatchObject({ id: "twist", type: "twist", valid: true });
		forearm.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2);
		expect(applyRigLayers(scene as any).appliedConstraintCount).toBe(2);
		expect(forearmTwist.rotationQuaternion.toEulerAngles().x).toBeCloseTo(Math.PI / 4);

		expect(setRigLayer(scene, { layerId: layer.id, order: -2, weight: 0.75, enabled: true }, options)).toMatchObject({ order: -2, weight: 0.75 });
		expect(setRigConstraint(scene, { layerId: layer.id, constraintId: "parent", weight: 0.5, enabled: false }, options)).toMatchObject({
			weight: 0.5,
			enabled: false,
		});
		expect(listRigLayers(scene, { skeletonId: skeleton.id }).layers[0]).toMatchObject({
			id: layer.id,
			order: -2,
			constraints: [
				{ id: "parent", valid: true },
				{ id: "twist", valid: true },
			],
		});

		expect(deleteRigConstraint(scene, { layerId: layer.id, constraintId: "parent" }, options)).toEqual({ deleted: true, layerId: layer.id, constraintId: "parent" });
		expect(deleteRigLayer(scene, { layerId: layer.id }, options)).toEqual({ deleted: true, layerId: layer.id, deletedConstraintCount: 1 });
		expect(listRigLayers(scene).layers).toEqual([]);
	});

	test("rejects invalid layer references, zero source weights, and source-as-twist-bone cycles", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const bone = new Bone("Bone", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const source = new TransformNode("Source", scene);
		const layer = createRigLayer(scene, { id: "rig", skeletonId: skeleton.id }, options);

		expect(() => createRigConstraint(scene, { layerId: layer.id, type: "multiParent", boneName: bone.name, sources: [{ nodeId: source.id, weight: 0 }] }, options)).toThrow(
			"greater than zero"
		);
		expect(() =>
			createRigConstraint(scene, { layerId: layer.id, type: "twist", sourceBoneName: bone.name, axis: [1, 0, 0], twistBones: [{ boneName: bone.name, weight: 1 }] }, options)
		).toThrow("cannot also be");
		expect(() => createRigLayer(scene, { skeletonId: "missing" }, options)).toThrow("was not found");
	});

	test("authors, diagnoses, solves, and updates a bounded Chain IK constraint", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const middle = new Bone("Middle", skeleton, root, Matrix.Translation(1, 0, 0), Matrix.Translation(1, 0, 0));
		const tip = new Bone("Tip", skeleton, middle, Matrix.Translation(1, 0, 0), Matrix.Translation(1, 0, 0));
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("IK Target", scene);
		target.position.copyFromFloats(1, 1, 0);
		const layer = createRigLayer(scene, { id: "chain-rig", skeletonId: skeleton.id }, options);

		const constraint = createRigConstraint(
			scene,
			{
				layerId: layer.id,
				id: "arm-chain",
				type: "chainIk",
				rootBoneName: root.name,
				tipBoneName: tip.name,
				targetNodeId: target.id,
				maxIterations: 32,
				tolerance: 0.001,
				chainRotationWeight: 1,
				tipRotationWeight: 0,
			},
			options
		);
		expect(constraint).toMatchObject({ id: "arm-chain", type: "chainIk", valid: true, chainBoneCount: 3, targetReachable: true });
		expect(constraint.chainLength).toBeCloseTo(2);
		expect(applyRigLayers(scene as any).appliedConstraintCount).toBe(1);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(tip.getPosition(Space.WORLD, mesh), target.getAbsolutePosition())).toBeLessThan(0.01);

		target.position.copyFromFloats(4, 0, 0);
		target.computeWorldMatrix(true);
		expect(setRigConstraint(scene, { layerId: layer.id, constraintId: constraint.id, maxIterations: 8, tolerance: 0.02, tipRotationWeight: 0.5 }, options)).toMatchObject({
			maxIterations: 8,
			tolerance: 0.02,
			tipRotationWeight: 0.5,
			targetReachable: false,
		});
		expect(listRigLayers(scene, { skeletonId: skeleton.id }).layers[0].constraints[0]).toMatchObject({
			valid: true,
			chainBoneCount: 3,
			targetReachable: false,
		});

		expect(() => setRigConstraint(scene, { layerId: layer.id, constraintId: constraint.id, rootBoneName: tip.name, tipBoneName: root.name }, options)).toThrow(
			"must be an ancestor"
		);
		expect(() => createRigConstraint(scene, { layerId: layer.id, type: "chainIk", rootBoneName: root.name, tipBoneName: root.name, targetNodeId: target.id }, options)).toThrow(
			"at least two bones"
		);
	});

	test("authors weighted Multi-Position and stabilized Multi-Aim constraints with recaptured offsets", () => {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		const positionBone = new Bone("Position Bone", skeleton, null, Matrix.Translation(1, 2, 3), Matrix.Translation(1, 2, 3));
		const mesh = MeshBuilder.CreateBox("Character Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const aimSkeleton = new Skeleton("Aim Character", "aim-character-skeleton", scene);
		const aimBone = new Bone("Aim Bone", aimSkeleton, null, Matrix.Identity(), Matrix.Identity());
		const aimMesh = MeshBuilder.CreateBox("Aim Character Mesh", { size: 1 }, scene);
		aimMesh.skeleton = aimSkeleton;
		const positionSource = new TransformNode("Position Source", scene);
		positionSource.position.copyFromFloats(5, 8, 9);
		const aimSource = new TransformNode("Aim Source", scene);
		aimSource.position.copyFromFloats(0, 3, 0);
		const layer = createRigLayer(scene, { id: "weighted-rig", skeletonId: skeleton.id }, options);

		const position = createRigConstraint(
			scene,
			{
				layerId: layer.id,
				id: "position",
				type: "multiPosition",
				boneName: positionBone.name,
				sources: [{ nodeId: positionSource.id, weight: 1 }],
				maintainOffset: true,
				positionAxes: [true, false, false],
			},
			options
		);
		expect(position).toMatchObject({ valid: true, type: "multiPosition", sourceCount: 1, activeSourceCount: 1, positionAxes: [true, false, false] });
		expect(position.sources[0].positionOffset).toEqual([-4, -6, -6]);
		positionSource.position.x = 7;
		positionSource.computeWorldMatrix(true);
		expect(applyRigLayers(scene as any).appliedConstraintCount).toBe(1);
		expect(positionBone.getPosition(Space.WORLD, mesh).asArray()).toEqual([3, 2, 3]);
		expect(setRigConstraint(scene, { layerId: layer.id, constraintId: position.id, maintainOffset: false }, options)).toMatchObject({ maintainOffset: false });
		expect(positionBone.getPosition(Space.WORLD, mesh).x).toBeCloseTo(7);

		const aimLayer = createRigLayer(scene, { id: "aim-rig", skeletonId: aimSkeleton.id }, options);
		const aim = createRigConstraint(
			scene,
			{
				layerId: aimLayer.id,
				id: "aim",
				type: "multiAim",
				boneName: aimBone.name,
				sources: [{ nodeId: aimSource.id, weight: 1 }],
				maintainOffset: true,
				aimAxis: [1, 0, 0],
				upAxis: [0, 0, 1],
				worldUpAxis: [0, 0, 1],
			},
			options
		);
		expect(aim).toMatchObject({ valid: true, type: "multiAim", sourceCount: 1, activeSourceCount: 1, maintainOffset: true });
		expect(aim.rotationOffset).not.toEqual([0, 0, 0, 1]);
		expect(aim.aimErrorDegrees).toBeCloseTo(90);
		expect(setRigConstraint(scene, { layerId: aimLayer.id, constraintId: aim.id, maintainOffset: false }, options)).toMatchObject({
			maintainOffset: false,
			rotationOffset: [0, 0, 0, 1],
			aimErrorDegrees: 0,
		});
		const worldAim = Vector3.Right().applyRotationQuaternion(aimBone.getRotationQuaternion(Space.WORLD, aimMesh)).normalize();
		expect(Vector3.Dot(worldAim, Vector3.Up())).toBeCloseTo(1);
		expect(setRigConstraint(scene, { layerId: aimLayer.id, constraintId: aim.id, worldUpAxis: [0, 0, -1] }, options)).toMatchObject({ worldUpAxis: [0, 0, -1] });

		expect(() => setRigConstraint(scene, { layerId: layer.id, constraintId: position.id, positionAxes: [false, false, false] }, options)).toThrow("at least one");
		expect(() => setRigConstraint(scene, { layerId: aimLayer.id, constraintId: aim.id, aimAxis: [0, 1, 0], upAxis: [0, 1, 0] }, options)).toThrow("cannot be parallel");
	});

	test("authors, solves, diagnoses, and validates multi-effector Full-Body IK", () => {
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
		const rightTarget = new TransformNode("Right Target", scene);
		rightTarget.position.copyFromFloats(-1, 1, 0);
		const layer = createRigLayer(scene, { id: "full-body-rig", skeletonId: skeleton.id }, options);
		const effectors = [
			{ boneName: leftTip.name, targetNodeId: leftTarget.id, positionWeight: 1, rotationWeight: 0 },
			{ boneName: rightTip.name, targetNodeId: rightTarget.id, positionWeight: 1, rotationWeight: 0 },
		];

		const constraint = createRigConstraint(
			scene,
			{ layerId: layer.id, id: "full-body", type: "fullBodyIk", rootBoneName: root.name, maxIterations: 48, tolerance: 0.01, effectors },
			options
		);
		expect(constraint).toMatchObject({
			id: "full-body",
			type: "fullBodyIk",
			valid: true,
			effectorCount: 2,
			activeEffectorCount: 2,
			reachedEffectorCount: 2,
		});
		expect(constraint.maximumError).toBeLessThan(0.05);
		expect(constraint.effectors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ boneName: leftTip.name, valid: true, reached: true, pathBoneCount: 3 }),
				expect.objectContaining({ boneName: rightTip.name, valid: true, reached: true, pathBoneCount: 3 }),
			])
		);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(leftTip.getPosition(Space.WORLD, mesh), leftTarget.getAbsolutePosition())).toBeLessThan(0.05);
		expect(Vector3.Distance(rightTip.getPosition(Space.WORLD, mesh), rightTarget.getAbsolutePosition())).toBeLessThan(0.05);

		expect(setRigConstraint(scene, { layerId: layer.id, constraintId: constraint.id, maxIterations: 24, tolerance: 0.02, effectors: [effectors[0]] }, options)).toMatchObject({
			maxIterations: 24,
			tolerance: 0.02,
			effectorCount: 1,
			activeEffectorCount: 1,
		});
		expect(() => setRigConstraint(scene, { layerId: layer.id, constraintId: constraint.id, effectors: [effectors[0], effectors[0]] }, options)).toThrow("duplicated");
		expect(() =>
			createRigConstraint(
				scene,
				{ layerId: layer.id, type: "fullBodyIk", rootBoneName: leftJoint.name, effectors: [{ boneName: rightTip.name, targetNodeId: rightTarget.id }] },
				options
			)
		).toThrow("must be an ancestor");
		expect(() =>
			createRigConstraint(
				scene,
				{
					layerId: layer.id,
					type: "fullBodyIk",
					rootBoneName: root.name,
					effectors: [{ boneName: leftTip.name, targetNodeId: leftTarget.id, positionWeight: 0, rotationWeight: 0 }],
				},
				options
			)
		).toThrow("greater than zero");
	});

	test("authors Override, temporal Damped, and two-source Blend transform constraints", () => {
		const overrideSkeleton = new Skeleton("Override", "override-skeleton", scene);
		const overrideBone = new Bone("Override Bone", overrideSkeleton, null, Matrix.Translation(1, 2, 3), Matrix.Translation(1, 2, 3));
		const overrideMesh = MeshBuilder.CreateBox("Override Mesh", { size: 1 }, scene);
		overrideMesh.skeleton = overrideSkeleton;
		const overrideSource = new TransformNode("Override Source", scene);
		overrideSource.position.copyFromFloats(5, 8, 9);
		const overrideLayer = createRigLayer(scene, { id: "override-layer", skeletonId: overrideSkeleton.id }, options);
		const override = createRigConstraint(
			scene,
			{
				layerId: overrideLayer.id,
				id: "override",
				type: "overrideTransform",
				boneName: overrideBone.name,
				sourceNodeId: overrideSource.id,
				maintainOffset: true,
				positionWeight: 1,
				rotationWeight: 0,
				positionAxes: [true, false, false],
				rotationAxes: [true, true, true],
			},
			options
		);
		expect(override).toMatchObject({ valid: true, type: "overrideTransform", positionOffset: [-4, -6, -6], positionError: 0 });
		overrideSource.position.x = 7;
		overrideSource.computeWorldMatrix(true);
		applyRigLayers(scene as any);
		expect(overrideBone.getPosition(Space.WORLD, overrideMesh).asArray()).toEqual([3, 2, 3]);
		expect(setRigConstraint(scene, { layerId: overrideLayer.id, constraintId: override.id, maintainOffset: false }, options)).toMatchObject({ maintainOffset: false });
		expect(overrideBone.getPosition(Space.WORLD, overrideMesh).x).toBeCloseTo(7);

		const blendSkeleton = new Skeleton("Blend", "blend-skeleton", scene);
		const blendBone = new Bone("Blend Bone", blendSkeleton, null, Matrix.Identity(), Matrix.Identity());
		const blendMesh = MeshBuilder.CreateBox("Blend Mesh", { size: 1 }, scene);
		blendMesh.skeleton = blendSkeleton;
		const blendA = new TransformNode("Blend A", scene);
		const blendB = new TransformNode("Blend B", scene);
		blendB.position.x = 8;
		const blendLayer = createRigLayer(scene, { id: "blend-layer", skeletonId: blendSkeleton.id }, options);
		const blend = createRigConstraint(
			scene,
			{
				layerId: blendLayer.id,
				id: "blend",
				type: "blendTransform",
				boneName: blendBone.name,
				sourceNodeIdA: blendA.id,
				sourceNodeIdB: blendB.id,
				maintainOffset: false,
				blend: 0.25,
				positionWeight: 1,
				rotationWeight: 0,
				positionAxes: [true, true, true],
				rotationAxes: [true, true, true],
			},
			options
		);
		expect(blend).toMatchObject({ valid: true, type: "blendTransform", sourceCount: 2, blend: 0.25 });
		expect(blendBone.getPosition(Space.WORLD, blendMesh).x).toBeCloseTo(2);
		expect(setRigConstraint(scene, { layerId: blendLayer.id, constraintId: blend.id, blend: 0.75 }, options)).toMatchObject({ blend: 0.75 });
		expect(blendBone.getPosition(Space.WORLD, blendMesh).x).toBeCloseTo(6);

		const dampedSkeleton = new Skeleton("Damped", "damped-skeleton", scene);
		const dampedBone = new Bone("Damped Bone", dampedSkeleton, null, Matrix.Identity(), Matrix.Identity());
		const dampedMesh = MeshBuilder.CreateBox("Damped Mesh", { size: 1 }, scene);
		dampedMesh.skeleton = dampedSkeleton;
		const dampedSource = new TransformNode("Damped Source", scene);
		dampedSource.position.x = 10;
		const dampedLayer = createRigLayer(scene, { id: "damped-layer", skeletonId: dampedSkeleton.id }, options);
		const damped = createRigConstraint(
			scene,
			{
				layerId: dampedLayer.id,
				id: "damped",
				type: "dampedTransform",
				boneName: dampedBone.name,
				sourceNodeId: dampedSource.id,
				maintainOffset: false,
				positionWeight: 1,
				rotationWeight: 0,
				positionAxes: [true, true, true],
				rotationAxes: [true, true, true],
				positionDamping: 0.5,
				rotationDamping: 0.5,
			},
			options
		);
		expect(damped).toMatchObject({ valid: true, type: "dampedTransform", positionDamping: 0.5, rotationDamping: 0.5 });
		expect(dampedBone.getPosition(Space.WORLD, dampedMesh).x).toBeGreaterThan(0);
		expect(dampedBone.getPosition(Space.WORLD, dampedMesh).x).toBeLessThan(10);
		for (let index = 0; index < 60; index++) {
			applyRigLayers(scene as any);
		}
		expect(dampedBone.getPosition(Space.WORLD, dampedMesh).x).toBeGreaterThan(9.9);

		expect(() =>
			createRigConstraint(
				scene,
				{
					layerId: blendLayer.id,
					type: "blendTransform",
					boneName: blendBone.name,
					sourceNodeIdA: blendA.id,
					sourceNodeIdB: blendA.id,
					positionWeight: 1,
					rotationWeight: 0,
				},
				options
			)
		).toThrow("different source");
		expect(() =>
			setRigConstraint(
				scene,
				{
					layerId: overrideLayer.id,
					constraintId: override.id,
					positionWeight: 0,
					rotationWeight: 1,
					rotationAxes: [false, false, false],
				},
				options
			)
		).toThrow("enabled rotation axis");
	});

	test("builds, leases, persists, and auto-layouts the freeform rig constraint graph", () => {
		const skeleton = new Skeleton("Graph Character", "graph-character", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const driven = new Bone("Driven", skeleton, root, Matrix.Identity(), Matrix.Identity());
		const twist = new Bone("Twist", skeleton, root, Matrix.Identity(), Matrix.Identity());
		const mesh = MeshBuilder.CreateBox("Graph Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const source = new TransformNode("Graph Source", scene);
		const layer = createRigLayer(scene, { id: "graph-layer", name: "Graph Layer", skeletonId: skeleton.id }, options);
		createRigConstraint(scene, { layerId: layer.id, id: "parent", type: "multiParent", boneName: driven.name, sources: [{ nodeId: source.id, weight: 1 }] }, options);
		createRigConstraint(scene, { layerId: layer.id, id: "twist", type: "twist", sourceBoneName: root.name, twistBones: [{ boneName: twist.name, weight: 1 }] }, options);

		const initial = getRigConstraintGraph(scene, { layerId: layer.id });
		expect(initial).toMatchObject({ layerId: layer.id, layerName: "Graph Layer", nodeCount: 6, edgeCount: 4 });
		expect(initial.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(initial.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: `transform:${source.id}`, kind: "transform", valid: true }),
				expect.objectContaining({ id: "constraint:parent", kind: "constraint", constraintId: "parent" }),
				expect.objectContaining({ id: `bone:${driven.name}`, kind: "bone", lane: "output" }),
			])
		);
		expect(initial.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: `transform:${source.id}`, to: "constraint:parent", label: "Source 1" }),
				expect.objectContaining({ from: "constraint:parent", to: `bone:${driven.name}`, label: "Drives" }),
			])
		);

		const moved = setRigConstraintGraphLayout(
			scene,
			{ layerId: layer.id, expectedFingerprint: initial.fingerprint, positions: [{ nodeId: "constraint:parent", position: [777, 333] }] },
			options
		);
		expect(moved.nodes.find((node: any) => node.id === "constraint:parent").position).toEqual([777, 333]);
		expect(moved.fingerprint).not.toBe(initial.fingerprint);
		expect(listRigLayers(scene, { skeletonId: skeleton.id }).layers[0].graphPositions["constraint:parent"]).toEqual([777, 333]);
		expect(() =>
			setRigConstraintGraphLayout(
				scene,
				{ layerId: layer.id, expectedFingerprint: initial.fingerprint, positions: [{ nodeId: "constraint:parent", position: [10, 20] }] },
				options
			)
		).toThrow("changed after inspection");

		const beforeInvalid = getRigConstraintGraph(scene, { layerId: layer.id });
		expect(() =>
			setRigConstraintGraphLayout(
				scene,
				{ layerId: layer.id, expectedFingerprint: beforeInvalid.fingerprint, positions: [{ nodeId: "constraint:missing", position: [10, 20] }] },
				options
			)
		).toThrow("not part of");
		expect(getRigConstraintGraph(scene, { layerId: layer.id }).fingerprint).toBe(beforeInvalid.fingerprint);

		const automatic = setRigConstraintGraphLayout(scene, { layerId: layer.id, expectedFingerprint: beforeInvalid.fingerprint, autoLayout: true }, options);
		expect(automatic.nodes.find((node: any) => node.id === "constraint:parent").position[0]).toBe(320);
		expect(automatic.nodes.find((node: any) => node.id === `transform:${source.id}`).position[0]).toBe(32);
		expect(automatic.nodes.find((node: any) => node.id === `bone:${driven.name}`).position[0]).toBe(608);
		deleteRigConstraint(scene, { layerId: layer.id, constraintId: "parent" }, options);
		expect(listRigLayers(scene, { skeletonId: skeleton.id }).layers[0].graphPositions["constraint:parent"]).toBeUndefined();
	});
});

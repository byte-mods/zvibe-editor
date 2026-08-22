import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, Bone, Matrix, MeshBuilder, NullEngine, Quaternion, Scene, Skeleton, Space, TransformNode, Vector3 } from "babylonjs";
import { getTwoBoneIKEndpoint } from "babylonjs-editor-tools";

import { bakeTwoBoneIKConstraintAnimation, inspectTwoBoneIKConstraintBake } from "../../src/mcp/rigging/rig-baking";
import { createIKController, evaluateIKController, setIKController } from "../../src/mcp/rigging/ik";

function rotationAngle(left: Quaternion, right: Quaternion): number {
	return 2 * Math.acos(Math.min(1, Math.abs(Quaternion.Dot(left.normalize(), right.normalize()))));
}

describe("mcp/native Two-Bone IK Bake To Constraint", () => {
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

	test("transfers representable root/mid rotations to native target and pole curves with independent replay", () => {
		const skeleton = new Skeleton("Arm", "arm-skeleton", scene);
		const root = new Bone("Upper Arm", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Forearm", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		new Bone("Hand", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		// Imported rigs may carry explicit effective lengths that differ from child-origin spacing.
		root.length = 2.25;
		mid.length = 1.75;
		const mesh = MeshBuilder.CreateBox("Arm Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const controlParent = new TransformNode("Arm Controls", scene);
		controlParent.position.copyFromFloats(10, -2, 3);
		controlParent.rotation.y = 0.4;
		const target = new TransformNode("Hand Target", scene);
		const pole = new TransformNode("Elbow Hint", scene);
		target.parent = controlParent;
		pole.parent = controlParent;
		createIKController(
			scene,
			{
				id: "arm-ik",
				skeletonId: skeleton.id,
				boneName: mid.name,
				meshId: mesh.id,
				targetNodeId: target.id,
				poleTargetNodeId: pole.id,
				poleAngle: 0.35,
				maxAngle: Math.PI,
				slerpAmount: 1,
			},
			options
		);

		const samplePose = (targetPosition: Vector3, polePosition: Vector3): { root: Quaternion; mid: Quaternion } => {
			target.setAbsolutePosition(targetPosition);
			pole.setAbsolutePosition(polePosition);
			target.computeWorldMatrix(true);
			pole.computeWorldMatrix(true);
			expect(evaluateIKController(scene, "arm-ik")).toBe(true);
			skeleton.computeAbsoluteMatrices(true);
			return { root: root.getRotationQuaternion(Space.LOCAL), mid: mid.getRotationQuaternion(Space.LOCAL) };
		};
		const first = samplePose(new Vector3(2, 3, 0), new Vector3(0, 1, 4));
		const last = samplePose(new Vector3(-2, 2.5, 1), new Vector3(1, 1, -4));
		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		skeleton.computeAbsoluteMatrices(true);
		target.position.copyFromFloats(7, 8, 9);
		pole.position.copyFromFloats(-7, 6, 5);
		const targetBefore = target.position.clone();
		const poleBefore = pole.position.clone();

		const rootAnimation = new Animation("Upper Arm FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
		rootAnimation.setKeys([
			{ frame: 0, value: first.root },
			{ frame: 30, value: last.root },
		]);
		const midAnimation = new Animation("Forearm FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
		midAnimation.setKeys([
			{ frame: 0, value: first.mid },
			{ frame: 30, value: last.mid },
		]);
		const source = new AnimationGroup("Arm FK Source", scene);
		source.addTargetedAnimation(rootAnimation, root);
		source.addTargetedAnimation(midAnimation, mid);
		const request = {
			skeletonId: skeleton.id,
			sourceAnimationGroupName: source.name,
			ikControllerIds: ["arm-ik"],
			sampleRate: 30,
		};
		const inspection = inspectTwoBoneIKConstraintBake(scene, request);
		expect(inspection).toMatchObject({
			algorithm: "bounded-two-bone-ik-to-controls-bake-v1",
			canBake: true,
			controllerCount: 1,
			controlNodeCount: 2,
			transferredTrackCount: 2,
			preservedTrackCount: 0,
			controlTrackCount: 2,
			trackCount: 2,
			sampleCount: 31,
			keyCount: 62,
			poleSolverEvaluationCount: 1147,
		});
		const result = bakeTwoBoneIKConstraintAnimation(scene, { ...request, outputName: "Arm IK Controls", expectedFingerprint: inspection.fingerprint }, options);
		expect(result).toMatchObject({ created: true, trackCount: 2, poseRestored: true, controlStateRestored: true, failedControllerIds: [] });
		expect(result.maximumPositionError).toBeLessThanOrEqual(0.05);
		expect(result.maximumRotationErrorDegrees).toBeLessThanOrEqual(0.25);
		expect(target.position.asArray()).toEqual(targetBefore.asArray());
		expect(pole.position.asArray()).toEqual(poleBefore.asArray());
		expect(rotationAngle(root.getRotationQuaternion(Space.LOCAL), Quaternion.Identity())).toBeLessThan(0.00001);
		expect(rotationAngle(mid.getRotationQuaternion(Space.LOCAL), Quaternion.Identity())).toBeLessThan(0.00001);

		const output = scene.getAnimationGroupByName("Arm IK Controls")!;
		expect(output.targetedAnimations).toHaveLength(2);
		expect(output.targetedAnimations.map((targeted) => targeted.target).sort((left, right) => left.name.localeCompare(right.name))).toEqual([pole, target]);
		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		for (const targeted of output.targetedAnimations) {
			targeted.target.position.copyFrom(targeted.animation.evaluate(30));
			targeted.target.computeWorldMatrix(true);
		}
		expect(evaluateIKController(scene, "arm-ik")).toBe(true);
		expect(rotationAngle(root.getRotationQuaternion(Space.LOCAL), last.root)).toBeLessThan(0.005);
		expect(rotationAngle(mid.getRotationQuaternion(Space.LOCAL), last.mid)).toBeLessThan(0.005);

		target.position.x += 1;
		expect(() => bakeTwoBoneIKConstraintAnimation(scene, { ...request, outputName: "Stale IK", expectedFingerprint: inspection.fingerprint }, options)).toThrow(
			"changed after inspection"
		);
		expect(scene.getAnimationGroupByName("Stale IK")).toBeNull();
	});

	test("reports deterministic full-weight and additive-source blockers before mutation", () => {
		const skeleton = new Skeleton("Leg", "leg-skeleton", scene);
		const root = new Bone("Thigh", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Calf", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		new Bone("Foot", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Leg Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Foot Target", scene);
		const pole = new TransformNode("Knee Hint", scene);
		createIKController(
			scene,
			{
				id: "leg-ik",
				skeletonId: skeleton.id,
				boneName: mid.name,
				meshId: mesh.id,
				targetNodeId: target.id,
				poleTargetNodeId: pole.id,
				slerpAmount: 0.5,
				targetPositionWeight: 0.5,
				targetRotationWeight: 0.5,
				hintWeight: 0.5,
			},
			options
		);
		const rotation = new Animation("Leg FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
		rotation.setKeys([
			{ frame: 0, value: Quaternion.Identity() },
			{ frame: 30, value: Quaternion.RotationAxis(Vector3.Right(), 0.2) },
		]);
		const source = new AnimationGroup("Leg FK Source", scene);
		source.addTargetedAnimation(rotation, root);
		source.isAdditive = true;
		const inspection = inspectTwoBoneIKConstraintBake(scene, {
			skeletonId: skeleton.id,
			sourceAnimationGroupName: source.name,
			ikControllerIds: ["leg-ik"],
		});
		expect(inspection.canBake).toBe(false);
		expect(inspection.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("slerpAmount 1"),
				expect.stringContaining("targetPositionWeight 1"),
				expect.stringContaining("targetRotationWeight 0 or 1"),
				expect.stringContaining("hintWeight 1"),
				expect.stringContaining("Additive source AnimationGroups"),
			])
		);
	});

	test("bakes Tip rotation to a target quaternion curve while exactly inverting maintained target offsets", () => {
		const skeleton = new Skeleton("Offset Bake Arm", "offset-bake-arm-skeleton", scene);
		const root = new Bone("Upper", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Lower", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const tip = new Bone("Hand", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Offset Bake Arm Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const controlParent = new TransformNode("Offset Bake Controls", scene);
		controlParent.position.copyFromFloats(3, -1, 2);
		controlParent.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.25, 0.1, -0.15);
		const target = new TransformNode("Offset Bake Target", scene);
		const pole = new TransformNode("Offset Bake Hint", scene);
		target.parent = controlParent;
		pole.parent = controlParent;
		target.setAbsolutePosition(new Vector3(0.2, 3.7, 0.1));
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.15, -0.2, 0.1);
		pole.setAbsolutePosition(new Vector3(0, 1, 3));
		target.computeWorldMatrix(true);
		pole.computeWorldMatrix(true);
		const created = createIKController(
			scene,
			{
				id: "offset-bake-ik",
				skeletonId: skeleton.id,
				boneName: mid.name,
				meshId: mesh.id,
				targetNodeId: target.id,
				poleTargetNodeId: pole.id,
				maxAngle: Math.PI,
				slerpAmount: 1,
				targetPositionWeight: 1,
				targetRotationWeight: 1,
				maintainTargetPositionOffset: true,
				maintainTargetRotationOffset: true,
			},
			options
		);
		expect(created.targetPositionOffset).toHaveLength(3);
		expect(created.targetRotationOffset).toHaveLength(4);

		const samplePose = (targetPosition: Vector3, targetRotation: Quaternion, polePosition: Vector3): { root: Quaternion; mid: Quaternion; tip: Quaternion } => {
			target.setAbsolutePosition(targetPosition);
			target.rotationQuaternion = targetRotation;
			pole.setAbsolutePosition(polePosition);
			target.computeWorldMatrix(true);
			pole.computeWorldMatrix(true);
			expect(evaluateIKController(scene, "offset-bake-ik")).toBe(true);
			skeleton.computeAbsoluteMatrices(true);
			return {
				root: root.getRotationQuaternion(Space.LOCAL),
				mid: mid.getRotationQuaternion(Space.LOCAL),
				tip: tip.getRotationQuaternion(Space.LOCAL),
			};
		};
		const first = samplePose(new Vector3(0.4, 3.45, 0.25), Quaternion.RotationYawPitchRoll(0.25, -0.1, 0.35), new Vector3(0.2, 1.2, 3));
		const last = samplePose(new Vector3(-0.35, 3.2, 0.55), Quaternion.RotationYawPitchRoll(-0.3, 0.4, -0.2), new Vector3(-0.5, 0.8, -3));
		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		tip.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		skeleton.computeAbsoluteMatrices(true);
		target.position.copyFromFloats(2, 3, 4);
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.6, -0.4, 0.2);
		pole.position.copyFromFloats(-2, 1, 5);
		const targetPositionBefore = target.position.clone();
		const targetRotationBefore = target.rotationQuaternion.clone();
		const polePositionBefore = pole.position.clone();

		const source = new AnimationGroup("Offset Bake FK Source", scene);
		for (const [bone, start, end] of [
			[root, first.root, last.root],
			[mid, first.mid, last.mid],
			[tip, first.tip, last.tip],
		] as const) {
			const animation = new Animation(`${bone.name} FK`, "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
			animation.setKeys([
				{ frame: 0, value: start },
				{ frame: 30, value: end },
			]);
			source.addTargetedAnimation(animation, bone);
		}
		const request = { skeletonId: skeleton.id, sourceAnimationGroupName: source.name, ikControllerIds: ["offset-bake-ik"], sampleRate: 30 };
		const inspection = inspectTwoBoneIKConstraintBake(scene, request);
		expect(inspection).toMatchObject({
			canBake: true,
			controllerCount: 1,
			controlNodeCount: 2,
			rotationControlNodeCount: 1,
			rotationControlNodeIds: [target.id],
			transferredTrackCount: 3,
			preservedTrackCount: 0,
			controlTrackCount: 3,
			trackCount: 3,
			sampleCount: 31,
			keyCount: 93,
		});
		const result = bakeTwoBoneIKConstraintAnimation(scene, { ...request, outputName: "Offset Bake IK Controls", expectedFingerprint: inspection.fingerprint }, options);
		expect(result).toMatchObject({ created: true, trackCount: 3, poseRestored: true, controlStateRestored: true, failedControllerIds: [] });
		expect(result.maximumPositionError).toBeLessThanOrEqual(0.05);
		expect(result.maximumRotationErrorDegrees).toBeLessThanOrEqual(0.25);
		expect(result.maximumTargetRotationErrorDegrees).toBeLessThanOrEqual(0.25);
		expect(target.position.asArray()).toEqual(targetPositionBefore.asArray());
		expect(rotationAngle(target.rotationQuaternion!, targetRotationBefore)).toBeLessThan(0.00001);
		expect(pole.position.asArray()).toEqual(polePositionBefore.asArray());

		const output = scene.getAnimationGroupByName("Offset Bake IK Controls")!;
		expect(output.targetedAnimations).toHaveLength(3);
		expect(
			output.targetedAnimations
				.filter((targeted) => targeted.target === target)
				.map((targeted) => targeted.animation.targetProperty)
				.sort()
		).toEqual(["position", "rotationQuaternion"]);
		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		tip.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		for (const targeted of output.targetedAnimations) {
			if (targeted.animation.targetProperty === "position") {
				targeted.target.position.copyFrom(targeted.animation.evaluate(30));
			} else {
				targeted.target.rotationQuaternion = targeted.animation.evaluate(30).clone();
			}
			targeted.target.computeWorldMatrix(true);
		}
		expect(evaluateIKController(scene, "offset-bake-ik")).toBe(true);
		expect(rotationAngle(root.getRotationQuaternion(Space.LOCAL), last.root)).toBeLessThan(0.005);
		expect(rotationAngle(mid.getRotationQuaternion(Space.LOCAL), last.mid)).toBeLessThan(0.005);
		expect(rotationAngle(tip.getRotationQuaternion(Space.LOCAL), last.tip)).toBeLessThan(0.005);
	});

	test("supports a target-only native controller when its configured fallback plane represents the source motion", () => {
		const skeleton = new Skeleton("Target Only", "target-only-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Mid", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		new Bone("Tip", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Target Only Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Target Only Control", scene);
		createIKController(
			scene,
			{ id: "target-only-ik", skeletonId: skeleton.id, boneName: mid.name, meshId: mesh.id, targetNodeId: target.id, maxAngle: Math.PI, slerpAmount: 1 },
			options
		);
		target.position.copyFromFloats(2, 3, 0);
		target.computeWorldMatrix(true);
		expect(evaluateIKController(scene, "target-only-ik")).toBe(true);
		const rootRotation = root.getRotationQuaternion(Space.LOCAL);
		const midRotation = mid.getRotationQuaternion(Space.LOCAL);
		root.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		mid.setRotationQuaternion(Quaternion.Identity(), Space.LOCAL);
		const rootAnimation = new Animation("Root FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
		rootAnimation.setKeys([
			{ frame: 0, value: rootRotation },
			{ frame: 30, value: rootRotation },
		]);
		const midAnimation = new Animation("Mid FK", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
		midAnimation.setKeys([
			{ frame: 0, value: midRotation },
			{ frame: 30, value: midRotation },
		]);
		const source = new AnimationGroup("Target Only FK", scene);
		source.addTargetedAnimation(rootAnimation, root);
		source.addTargetedAnimation(midAnimation, mid);
		const request = { skeletonId: skeleton.id, sourceAnimationGroupName: source.name, ikControllerIds: ["target-only-ik"], sampleRate: 30 };
		const inspection = inspectTwoBoneIKConstraintBake(scene, request);
		expect(inspection).toMatchObject({ canBake: true, controlNodeCount: 1, controlTrackCount: 1, keyCount: 31 });
		expect(inspection.warnings).toEqual([expect.stringContaining("without a pole target")]);
		const result = bakeTwoBoneIKConstraintAnimation(scene, { ...request, outputName: "Target Only Controls", expectedFingerprint: inspection.fingerprint }, options);
		expect(result).toMatchObject({ created: true, trackCount: 1, maximumPositionError: expect.any(Number), maximumRotationErrorDegrees: expect.any(Number) });
		expect(result.maximumPositionError).toBeLessThanOrEqual(0.05);
		expect(result.maximumRotationErrorDegrees).toBeLessThanOrEqual(0.25);
	});

	test("captures and applies Unity-style target rotation and maintained target offsets", () => {
		const skeleton = new Skeleton("Offset Arm", "offset-arm-skeleton", scene);
		const root = new Bone("Upper", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const mid = new Bone("Lower", skeleton, root, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const tip = new Bone("Hand", skeleton, mid, Matrix.Translation(0, 2, 0), Matrix.Translation(0, 2, 0));
		const mesh = MeshBuilder.CreateBox("Offset Arm Mesh", { size: 1 }, scene);
		mesh.skeleton = skeleton;
		const target = new TransformNode("Offset Target", scene);
		target.position.copyFromFloats(2, 3, 0);
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.2, -0.1, 0.3);
		target.computeWorldMatrix(true);
		const created = createIKController(
			scene,
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
			},
			options
		);
		expect(created.targetPositionOffset).toHaveLength(3);
		expect(created.targetRotationOffset).toHaveLength(4);
		const positionOffset = Vector3.FromArray(created.targetPositionOffset);
		const rotationOffset = Quaternion.FromArray(created.targetRotationOffset);
		target.position.copyFromFloats(4, 2, 1);
		target.rotationQuaternion = Quaternion.RotationYawPitchRoll(-0.4, 0.3, 0.5);
		target.computeWorldMatrix(true);
		const expectedPosition = Vector3.TransformCoordinates(positionOffset, target.getWorldMatrix());
		const expectedRotation = target.rotationQuaternion.multiply(rotationOffset).normalize();
		expect(evaluateIKController(scene, "offset-ik")).toBe(true);
		skeleton.computeAbsoluteMatrices(true);
		expect(Vector3.Distance(getTwoBoneIKEndpoint(mesh, mid), expectedPosition)).toBeLessThan(0.001);
		expect(rotationAngle(tip.getRotationQuaternion(Space.WORLD, mesh), expectedRotation)).toBeLessThan(0.001);

		setIKController(scene, { id: "offset-ik", targetPositionWeight: 0, targetRotationWeight: 0 }, options);
		const rootBefore = root.getRotationQuaternion(Space.WORLD, mesh);
		const midBefore = mid.getRotationQuaternion(Space.WORLD, mesh);
		target.position.addInPlace(new Vector3(5, 2, -1));
		expect(evaluateIKController(scene, "offset-ik")).toBe(true);
		expect(rotationAngle(root.getRotationQuaternion(Space.WORLD, mesh), rootBefore)).toBeLessThan(0.00001);
		expect(rotationAngle(mid.getRotationQuaternion(Space.WORLD, mesh), midBefore)).toBeLessThan(0.00001);
	});
});

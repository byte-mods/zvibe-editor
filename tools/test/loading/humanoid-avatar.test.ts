import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Scene } from "@babylonjs/core/scene";

import {
	applyHumanoidMuscleLimits,
	configureHumanoidAvatars,
	getHumanoidAvatar,
	getHumanoidMusclePose,
	setHumanoidMusclePosePreview,
	stopAllHumanoidMusclePosePreviews,
	stopHumanoidMusclePosePreview,
} from "../../src/loading/humanoid-avatar";

describe("loading/humanoid avatars", () => {
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

	test("exposes exported Avatar definitions and publishes runtime validation", () => {
		const skeleton = new Skeleton("Hero", "hero-skeleton", scene);
		new Bone("Hips", skeleton, null, Matrix.Identity());
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: skeleton.id,
					animationType: "generic",
					source: "model",
					mapping: { hips: "Hips" },
					restPose: {},
					humanScale: 1,
				},
			],
		};

		configureHumanoidAvatars(scene);

		expect(getHumanoidAvatar(scene, "hero-avatar")?.skeletonId).toBe(skeleton.id);
		expect(getHumanoidAvatar(scene, skeleton.id)?.id).toBe("hero-avatar");
		expect(scene.humanoidAvatarValidation).toEqual([{ avatarId: "hero-avatar", valid: true, errors: [], warnings: [] }]);
	});

	test("clamps mapped bone rotation deltas to persisted muscle limits", () => {
		const skeleton = new Skeleton("Hero", "hero-skeleton", scene);
		const bone = new Bone("LeftArm", skeleton, null, Matrix.Identity(), Matrix.Identity());
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: skeleton.id,
					animationType: "humanoid",
					source: "model",
					mapping: { leftUpperArm: bone.name },
					restPose: { [bone.name]: { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] } },
					humanScale: 1,
					muscleLimitsEnabled: true,
					muscleLimits: { leftUpperArm: { min: [-10, -10, -10], max: [10, 10, 10] } },
				},
			],
		};
		bone.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2);

		expect(applyHumanoidMuscleLimits(scene)).toBe(1);
		expect((bone.rotationQuaternion.toEulerAngles().x * 180) / Math.PI).toBeCloseTo(10);
	});

	test("previews normalized muscle values without persisting them and restores the exact starting pose", () => {
		const skeleton = new Skeleton("Hero", "hero-skeleton", scene);
		const bone = new Bone("LeftArm", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const original = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 6);
		bone.rotationQuaternion = original.clone();
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: skeleton.id,
					animationType: "humanoid",
					source: "model",
					mapping: { leftUpperArm: bone.name },
					restPose: { [bone.name]: { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] } },
					humanScale: 1,
					muscleLimits: { leftUpperArm: { min: [-10, -20, -30], max: [20, 40, 60] } },
				},
			],
		};
		const persistedBefore = JSON.stringify(scene.metadata);

		const preview = setHumanoidMusclePosePreview(scene, "hero-avatar", { pose: { leftUpperArm: [0.5, -0.5, 1] }, replace: true });
		const arm = preview.muscles.find((muscle) => muscle.role === "leftUpperArm")!;
		expect(preview).toMatchObject({ active: true, preset: "muscles", activeMuscleCount: 1 });
		expect(arm.normalized[0]).toBeCloseTo(0.5);
		expect(arm.normalized[1]).toBeCloseTo(-0.5);
		expect(arm.normalized[2]).toBeCloseTo(1);
		expect(arm.degrees[0]).toBeCloseTo(10);
		expect(arm.degrees[1]).toBeCloseTo(-10);
		expect(arm.degrees[2]).toBeCloseTo(60);
		expect(JSON.stringify(scene.metadata)).toBe(persistedBefore);

		bone.rotationQuaternion = Quaternion.Identity();
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const reapplied = getHumanoidMusclePose(scene, "hero-avatar").muscles.find((muscle) => muscle.role === "leftUpperArm")!.normalized;
		expect(reapplied[0]).toBeCloseTo(0.5);
		expect(reapplied[1]).toBeCloseTo(-0.5);
		expect(reapplied[2]).toBeCloseTo(1);

		expect(stopHumanoidMusclePosePreview(scene, "hero-avatar")).toMatchObject({ stopped: true, restoredBoneCount: 1 });
		expect(Math.abs(Quaternion.Dot(bone.rotationQuaternion, original))).toBeCloseTo(1);
		setHumanoidMusclePosePreview(scene, "hero-avatar", { preset: "rest" });
		expect(stopAllHumanoidMusclePosePreviews(scene)).toEqual({ stoppedPreviewCount: 1, restoredBoneCount: 1 });
		expect(JSON.stringify(scene.metadata)).toBe(persistedBefore);
	});

	test("enforces and restores a temporary horizontal arm-chain T-pose", () => {
		const skeleton = new Skeleton("Hero", "hero-skeleton", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		const leftUpper = new Bone("LeftUpper", skeleton, root, Matrix.Translation(0.5, 0, 0), Matrix.Translation(0.5, 0, 0));
		const leftLower = new Bone("LeftLower", skeleton, leftUpper, Matrix.Translation(0, -1, 0), Matrix.Translation(0, -1, 0));
		const leftHand = new Bone("LeftHand", skeleton, leftLower, Matrix.Translation(0, -1, 0), Matrix.Translation(0, -1, 0));
		const rightUpper = new Bone("RightUpper", skeleton, root, Matrix.Translation(-0.5, 0, 0), Matrix.Translation(-0.5, 0, 0));
		const rightLower = new Bone("RightLower", skeleton, rightUpper, Matrix.Translation(0, -1, 0), Matrix.Translation(0, -1, 0));
		const rightHand = new Bone("RightHand", skeleton, rightLower, Matrix.Translation(0, -1, 0), Matrix.Translation(0, -1, 0));
		const mapped = [leftUpper, leftLower, leftHand, rightUpper, rightLower, rightHand];
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: skeleton.id,
					animationType: "humanoid",
					source: "model",
					mapping: {
						leftUpperArm: leftUpper.name,
						leftLowerArm: leftLower.name,
						leftHand: leftHand.name,
						rightUpperArm: rightUpper.name,
						rightLowerArm: rightLower.name,
						rightHand: rightHand.name,
					},
					restPose: Object.fromEntries(mapped.map((bone) => [bone.name, { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] }])),
					humanScale: 1,
				},
			],
		};

		const preview = setHumanoidMusclePosePreview(scene, "hero-avatar", { preset: "tPose" });
		const leftDirection = leftHand.getPosition(Space.WORLD).subtract(leftUpper.getPosition(Space.WORLD)).normalize();
		const rightDirection = rightHand.getPosition(Space.WORLD).subtract(rightUpper.getPosition(Space.WORLD)).normalize();
		expect(preview).toMatchObject({ active: true, preset: "tPose", warnings: [] });
		expect(Vector3.Dot(leftDirection, Vector3.Right())).toBeGreaterThan(0.99);
		expect(Vector3.Dot(rightDirection, Vector3.Left())).toBeGreaterThan(0.99);

		expect(stopHumanoidMusclePosePreview(scene, "hero-avatar").restoredBoneCount).toBe(6);
		skeleton.computeAbsoluteTransforms();
		expect(leftHand.getPosition(Space.WORLD).y).toBeLessThan(leftUpper.getPosition(Space.WORLD).y);
		expect(rightHand.getPosition(Space.WORLD).y).toBeLessThan(rightUpper.getPosition(Space.WORLD).y);
	});
});

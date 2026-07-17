import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, Bone, Matrix, Mesh, NullEngine, Quaternion, Scene, Skeleton, Vector3 } from "babylonjs";

import {
	createHumanoidAvatar,
	getHumanoidAvatar,
	getHumanoidMusclePose,
	inspectHumanoidRetarget,
	listHumanoidAvatars,
	retargetHumanoidAnimation,
	setHumanoidAvatar,
	setHumanoidMuscleLimits,
	setHumanoidPosePreview,
	setHumanoidRetargetDebugVisualization,
	stopHumanoidPosePreview,
	validateSceneHumanoidAvatar,
} from "../../src/mcp/rigging/humanoid-avatar";

function matrix(x: number, y: number, z: number, rotation = Quaternion.Identity()): Matrix {
	return Matrix.Compose(Vector3.One(), rotation, new Vector3(x, y, z));
}

function createHumanoidSkeleton(scene: Scene, id: string, scale: number, armRestRotation = Quaternion.Identity()): Skeleton {
	const skeleton = new Skeleton(id, id, scene);
	const hips = new Bone(`${id}Hips`, skeleton, null, matrix(0, 0, 0), matrix(0, 0, 0));
	const spine = new Bone(`${id}Spine`, skeleton, hips, matrix(0, scale, 0), matrix(0, scale, 0));
	new Bone(`${id}Head`, skeleton, spine, matrix(0, scale, 0), matrix(0, scale, 0));
	const leftUpperArm = new Bone(`${id}LeftUpperArm`, skeleton, spine, matrix(scale, 0, 0, armRestRotation), matrix(scale, 0, 0, armRestRotation));
	const leftLowerArm = new Bone(`${id}LeftLowerArm`, skeleton, leftUpperArm, matrix(scale, 0, 0), matrix(scale, 0, 0));
	new Bone(`${id}LeftHand`, skeleton, leftLowerArm, matrix(scale, 0, 0), matrix(scale, 0, 0));
	const rightUpperArm = new Bone(`${id}RightUpperArm`, skeleton, spine, matrix(-scale, 0, 0), matrix(-scale, 0, 0));
	const rightLowerArm = new Bone(`${id}RightLowerArm`, skeleton, rightUpperArm, matrix(-scale, 0, 0), matrix(-scale, 0, 0));
	new Bone(`${id}RightHand`, skeleton, rightLowerArm, matrix(-scale, 0, 0), matrix(-scale, 0, 0));
	const leftUpperLeg = new Bone(`${id}LeftUpperLeg`, skeleton, hips, matrix(scale * 0.25, -scale, 0), matrix(scale * 0.25, -scale, 0));
	const leftLowerLeg = new Bone(`${id}LeftLowerLeg`, skeleton, leftUpperLeg, matrix(0, -scale, 0), matrix(0, -scale, 0));
	new Bone(`${id}LeftFoot`, skeleton, leftLowerLeg, matrix(0, -scale, scale * 0.25), matrix(0, -scale, scale * 0.25));
	const rightUpperLeg = new Bone(`${id}RightUpperLeg`, skeleton, hips, matrix(-scale * 0.25, -scale, 0), matrix(-scale * 0.25, -scale, 0));
	const rightLowerLeg = new Bone(`${id}RightLowerLeg`, skeleton, rightUpperLeg, matrix(0, -scale, 0), matrix(0, -scale, 0));
	new Bone(`${id}RightFoot`, skeleton, rightLowerLeg, matrix(0, -scale, scale * 0.25), matrix(0, -scale, scale * 0.25));
	return skeleton;
}

describe("mcp/humanoid avatar", () => {
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

	test("creates, persists, validates, and manually patches a humanoid Avatar", () => {
		const skeleton = createHumanoidSkeleton(scene, "Hero", 1);
		const created = createHumanoidAvatar(scene, { id: "hero-avatar", skeletonId: skeleton.id, autoMap: true }, options);

		expect(created.validation.valid).toBe(true);
		expect(created.validation.requiredMappedBoneCount).toBe(15);
		expect(created.restPose.HeroHips).toBeDefined();
		expect(listHumanoidAvatars(scene).avatars).toHaveLength(1);
		expect(scene.metadata.babylonEditorHumanoidAvatars[0].id).toBe("hero-avatar");

		setHumanoidAvatar(scene, { avatarId: "hero-avatar", mapping: { head: null } }, options);
		expect(validateSceneHumanoidAvatar(scene, { avatarId: "hero-avatar" }).missingRequired).toContain("head");
		expect(getHumanoidAvatar(scene, { avatarId: "hero-avatar" }).validation.valid).toBe(false);

		setHumanoidAvatar(scene, { avatarId: "hero-avatar", autoMap: true, refreshRestPose: true }, options);
		expect(validateSceneHumanoidAvatar(scene, { avatarId: "hero-avatar" }).valid).toBe(true);

		const limited = setHumanoidMuscleLimits(scene, { avatarId: "hero-avatar", enabled: true, limits: { leftUpperArm: { min: [-45, -30, -20], max: [45, 30, 20] } } }, options);
		expect(limited).toMatchObject({
			muscleLimitsEnabled: true,
			muscleLimits: { leftUpperArm: { min: [-45, -30, -20], max: [45, 30, 20] } },
		});
		expect(() => setHumanoidMuscleLimits(scene, { avatarId: "hero-avatar", limits: { leftUpperArm: { min: [45, 0, 0], max: [-45, 0, 0] } } }, options)).toThrow(
			"minimum axis 0"
		);
	});

	test("bakes quaternion-rest-pose and scaled-root retargeting into an editable AnimationGroup", () => {
		const sourceSkeleton = createHumanoidSkeleton(scene, "Source", 1);
		const targetRest = Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2);
		const targetSkeleton = createHumanoidSkeleton(scene, "Target", 2, targetRest);
		createHumanoidAvatar(scene, { id: "source-avatar", skeletonId: sourceSkeleton.id, autoMap: true }, options);
		createHumanoidAvatar(scene, { id: "target-avatar", skeletonId: targetSkeleton.id, autoMap: true }, options);

		const group = new AnimationGroup("Walk", scene);
		const rotation = new Animation("Arm Rotation", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE);
		rotation.setKeys([
			{ frame: 0, value: Quaternion.Identity() },
			{ frame: 30, value: Quaternion.RotationAxis(Vector3.Up(), Math.PI / 4) },
		]);
		group.addTargetedAnimation(rotation, sourceSkeleton.bones.find((bone) => bone.name === "SourceLeftUpperArm")!);
		const rootPosition = new Animation("Root Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
		rootPosition.setKeys([
			{ frame: 0, value: Vector3.Zero() },
			{ frame: 30, value: new Vector3(1, 0, 0) },
		]);
		group.addTargetedAnimation(rootPosition, sourceSkeleton.bones.find((bone) => bone.name === "SourceHips")!);

		const analysis = inspectHumanoidRetarget(scene, {
			sourceAvatarId: "source-avatar",
			targetAvatarId: "target-avatar",
			animationGroupName: "Walk",
			includeRootTranslation: true,
		});
		const armAnalysis = analysis.roles.find((role: any) => role.role === "leftUpperArm");
		expect(analysis).toMatchObject({
			canBake: true,
			totalTrackCount: 2,
			recognizedTrackCount: 2,
			compatibleTrackCount: 2,
			skippedTrackCount: 0,
			rolesWithCompatibleTracks: 2,
			humanScaleRatio: 2,
		});
		expect(armAnalysis).toMatchObject({ sourceTrackCount: 1, compatibleTrackCount: 1, status: "ready" });
		expect(armAnalysis.correctionAngleDegrees).toBeCloseTo(90);
		const rotationOnly = inspectHumanoidRetarget(scene, {
			sourceAvatarId: "source-avatar",
			targetAvatarId: "target-avatar",
			animationGroupName: "Walk",
			includeRootTranslation: false,
		});
		expect(rotationOnly).toMatchObject({ canBake: true, compatibleTrackCount: 1, skippedTrackCount: 1 });
		expect(rotationOnly.roles.find((role: any) => role.role === "hips").skipReasons).toContain("Root translation is disabled.");

		const result = retargetHumanoidAnimation(
			scene,
			{ sourceAvatarId: "source-avatar", targetAvatarId: "target-avatar", animationGroupName: "Walk", outputName: "Walk Retargeted" },
			options
		);
		const output = scene.animationGroups.find((candidate) => candidate.name === "Walk Retargeted")!;
		const rotationTrack = output.targetedAnimations.find((targeted) => targeted.animation.targetProperty === "rotationQuaternion")!;
		const positionTrack = output.targetedAnimations.find((targeted) => targeted.animation.targetProperty === "position")!;

		expect(result).toMatchObject({ name: "Walk Retargeted", trackCount: 2, skippedTrackCount: 0 });
		expect(output.targetedAnimations[0].target).toBe(targetSkeleton.bones.find((bone) => bone.name === "TargetLeftUpperArm"));
		expect(Quaternion.Dot(rotationTrack.animation.getKeys()[0].value, targetRest)).toBeCloseTo(1);
		expect(positionTrack.animation.getKeys()[1].value.x).toBeCloseTo(2);
		expect(output.metadata.babylonEditorHumanoidRetarget).toMatchObject({ sourceAvatarId: "source-avatar", targetAvatarId: "target-avatar" });
	});

	test("inspects, previews, validates, and restores normalized Humanoid muscle poses through MCP actions", () => {
		const skeleton = createHumanoidSkeleton(scene, "Hero", 1);
		createHumanoidAvatar(scene, { id: "hero-avatar", skeletonId: skeleton.id, autoMap: true }, options);
		setHumanoidMuscleLimits(scene, { avatarId: "hero-avatar", limits: { leftUpperArm: { min: [-30, -40, -50], max: [60, 80, 100] } } }, options);
		const arm = skeleton.bones.find((bone) => bone.name === "HeroLeftUpperArm")!;
		const original = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 8);
		arm.rotationQuaternion = original.clone();

		const preview = setHumanoidPosePreview(scene, { avatarId: "hero-avatar", preset: "muscles", pose: { leftUpperArm: [0.5, -0.5, 0.25] }, replace: true }, options);
		expect(preview).toMatchObject({ avatarId: "hero-avatar", active: true, preset: "muscles", activeMuscleCount: 1 });
		const muscle = getHumanoidMusclePose(scene, { avatarId: "hero-avatar" }).muscles.find((candidate: any) => candidate.role === "leftUpperArm");
		expect(muscle).toMatchObject({ authoredLimits: true, withinLimits: true });
		expect(muscle.normalized[0]).toBeCloseTo(0.5);
		expect(muscle.normalized[1]).toBeCloseTo(-0.5);
		expect(muscle.normalized[2]).toBeCloseTo(0.25);
		expect(() => setHumanoidPosePreview(scene, { avatarId: "hero-avatar", pose: { notAHumanRole: [0, 0, 0] } }, options)).toThrow("Unknown Humanoid muscle role");

		expect(stopHumanoidPosePreview(scene, { avatarId: "hero-avatar" }, options)).toMatchObject({ stopped: true, restoredBoneCount: 15 });
		expect(Math.abs(Quaternion.Dot(arm.rotationQuaternion, original))).toBeCloseTo(1);
		expect(stopHumanoidPosePreview(scene, { avatarId: "hero-avatar" }, options)).toMatchObject({ stopped: false, restoredBoneCount: 0 });
	});

	test("shows, updates, and disposes non-persisted source/target skeleton debug overlays", () => {
		const sourceSkeleton = createHumanoidSkeleton(scene, "Source", 1);
		const targetSkeleton = createHumanoidSkeleton(scene, "Target", 1);
		const sourceMesh = new Mesh("Source Mesh", scene);
		const targetMesh = new Mesh("Target Mesh", scene);
		sourceMesh.skeleton = sourceSkeleton;
		targetMesh.skeleton = targetSkeleton;
		createHumanoidAvatar(scene, { id: "source-avatar", skeletonId: sourceSkeleton.id, autoMap: true }, options);
		createHumanoidAvatar(scene, { id: "target-avatar", skeletonId: targetSkeleton.id, autoMap: true }, options);

		expect(
			setHumanoidRetargetDebugVisualization(scene, { enabled: true, sourceAvatarId: "source-avatar", targetAvatarId: "target-avatar", showAxes: true }, options)
		).toMatchObject({ active: true, sourceAvatarId: "source-avatar", targetAvatarId: "target-avatar", showAxes: true });
		expect(
			setHumanoidRetargetDebugVisualization(scene, { enabled: true, sourceAvatarId: "source-avatar", targetAvatarId: "target-avatar", showAxes: false }, options)
		).toMatchObject({ active: true, showAxes: false });
		expect(setHumanoidRetargetDebugVisualization(scene, { enabled: false }, options)).toMatchObject({
			stopped: true,
			active: false,
			sourceAvatarId: "source-avatar",
			targetAvatarId: "target-avatar",
		});
		expect(setHumanoidRetargetDebugVisualization(scene, { enabled: false }, options)).toEqual({ stopped: false, active: false });
	});
});

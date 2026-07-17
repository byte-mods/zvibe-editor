import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import {
	HUMAN_BONE_DEFINITIONS,
	HumanBone,
	HumanoidMuscleValue,
	humanoidMuscleDegreesToValue,
	humanoidMuscleValueToDegrees,
	IHumanoidAvatar,
	IHumanoidMuscleLimit,
	IHumanoidMusclePose,
	normalizeHumanoidMuscleLimits,
	normalizeHumanoidMusclePose,
	validateHumanoidAvatar,
} from "../assets/humanoid-avatar";

export interface IRuntimeHumanoidAvatarValidation {
	avatarId: string;
	valid: boolean;
	errors: string[];
	warnings: string[];
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		humanoidAvatarValidation: IRuntimeHumanoidAvatarValidation[];
	}
}

/** Returns a generated project's persisted Avatar definition for one skeleton or Avatar id. */
export function getHumanoidAvatar(scene: Scene, id: string): IHumanoidAvatar | null {
	const avatars = scene.metadata?.babylonEditorHumanoidAvatars;
	if (!Array.isArray(avatars)) {
		return null;
	}
	return (avatars.find((avatar) => avatar?.id === id || avatar?.skeletonId === id) as IHumanoidAvatar | undefined) ?? null;
}

/** Validates all persisted Avatars after their exported skeletons have loaded. */
export function validateHumanoidAvatars(scene: Scene): IRuntimeHumanoidAvatarValidation[] {
	const avatars = scene.metadata?.babylonEditorHumanoidAvatars;
	if (!Array.isArray(avatars)) {
		return [];
	}
	return avatars.map((avatar: IHumanoidAvatar) => {
		const skeleton = scene.skeletons.find((candidate) => candidate.id === avatar.skeletonId);
		if (!skeleton) {
			return { avatarId: avatar.id, valid: false, errors: [`Skeleton "${avatar.skeletonId}" was not found.`], warnings: [] };
		}
		const validation = validateHumanoidAvatar(
			avatar.animationType,
			avatar.mapping,
			skeleton.bones.map((bone) => ({ name: bone.name, parentName: bone.getParent()?.name ?? null }))
		);
		return { avatarId: avatar.id, valid: validation.valid, errors: validation.errors, warnings: validation.warnings };
	});
}

/** Publishes runtime Avatar validation evidence after generated skeletons have loaded. */
export function configureHumanoidAvatars(scene: Scene): void {
	scene.humanoidAvatarValidation = validateHumanoidAvatars(scene);
	configureHumanoidMuscleLimits(scene);
}

const configuredMuscleLimits = new WeakSet<Scene>();
const posePreviews = new WeakMap<Scene, Map<string, IHumanoidPosePreviewSession>>();

interface IHumanoidPosePreviewSession {
	avatarId: string;
	skeletonId: string;
	preset: "muscles" | "rest" | "tPose";
	pose: Partial<Record<HumanBone, HumanoidMuscleValue>>;
	originalRotations: Map<string, Quaternion>;
	observer: Observer<Scene>;
	warnings: string[];
}

type HumanoidRotationTarget = Bone | TransformNode;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/** Clamps mapped local bone rotation deltas to an Avatar's authored XYZ muscle limits in degrees. */
export function applyHumanoidMuscleLimits(scene: Scene): number {
	let applied = 0;
	const avatars = scene.metadata?.babylonEditorHumanoidAvatars;
	if (!Array.isArray(avatars)) {
		return applied;
	}
	for (const avatar of avatars as IHumanoidAvatar[]) {
		if (avatar.animationType !== "humanoid" || avatar.muscleLimitsEnabled !== true) {
			continue;
		}
		const skeleton = scene.skeletons.find((candidate) => candidate.id === avatar.skeletonId);
		if (!skeleton) {
			continue;
		}
		const limits = normalizeHumanoidMuscleLimits(avatar.muscleLimits);
		for (const [role, limit] of Object.entries(limits)) {
			const boneName = avatar.mapping[role as keyof typeof avatar.mapping];
			const bone = boneName ? skeleton.bones.find((candidate) => candidate.name === boneName) : null;
			const rest = boneName ? avatar.restPose[boneName] : null;
			if (!bone || !rest || !limit) {
				continue;
			}
			const target = bone.getTransformNode() ?? bone;
			const current = target.rotationQuaternion ?? Quaternion.FromEulerAngles(target.rotation.x, target.rotation.y, target.rotation.z);
			const restRotation = Quaternion.FromArray(rest.rotationQuaternion);
			const delta = restRotation.conjugate().multiply(current).normalize().toEulerAngles();
			const degrees = [delta.x, delta.y, delta.z].map((value) => (value * 180) / Math.PI);
			const clamped = degrees.map((value, index) => clamp(value, limit.min[index], limit.max[index]));
			if (clamped.some((value, index) => Math.abs(value - degrees[index]) > 1e-6)) {
				const rotation = restRotation
					.multiply(Quaternion.RotationYawPitchRoll((clamped[1] * Math.PI) / 180, (clamped[0] * Math.PI) / 180, (clamped[2] * Math.PI) / 180))
					.normalize();
				if (target.rotationQuaternion) {
					target.rotationQuaternion.copyFrom(rotation);
				} else {
					target.rotation.copyFrom(rotation.toEulerAngles());
				}
				applied++;
			}
		}
	}
	return applied;
}

/** Applies humanoid muscle limits after animation evaluation in preview/generated runtime. */
export function configureHumanoidMuscleLimits(scene: Scene): void {
	if (configuredMuscleLimits.has(scene)) {
		return;
	}
	configuredMuscleLimits.add(scene);
	scene.onBeforeRenderObservable.add(() => applyHumanoidMuscleLimits(scene));
}

function previewMap(scene: Scene): Map<string, IHumanoidPosePreviewSession> {
	let previews = posePreviews.get(scene);
	if (!previews) {
		previews = new Map<string, IHumanoidPosePreviewSession>();
		posePreviews.set(scene, previews);
	}
	return previews;
}

function resolvePreviewAvatar(scene: Scene, avatarId: string): { avatar: IHumanoidAvatar; skeleton: Skeleton } {
	const avatar = getHumanoidAvatar(scene, avatarId);
	if (!avatar) {
		throw new Error(`Humanoid Avatar "${avatarId}" was not found.`);
	}
	if (avatar.animationType !== "humanoid") {
		throw new Error(`Avatar "${avatarId}" must use the Humanoid animation type before previewing muscle poses.`);
	}
	const skeleton = scene.skeletons.find((candidate) => candidate.id === avatar.skeletonId);
	if (!skeleton) {
		throw new Error(`Skeleton "${avatar.skeletonId}" for Humanoid Avatar "${avatarId}" was not found.`);
	}
	return { avatar, skeleton };
}

function boneForRole(skeleton: Skeleton, avatar: IHumanoidAvatar, role: HumanBone): Bone | null {
	const boneName = avatar.mapping[role];
	return boneName ? (skeleton.bones.find((candidate) => candidate.name === boneName) ?? null) : null;
}

function rotationTarget(bone: Bone): HumanoidRotationTarget {
	return bone.getTransformNode() ?? bone;
}

function readRotation(target: HumanoidRotationTarget): Quaternion {
	return target.rotationQuaternion?.clone() ?? Quaternion.FromEulerAngles(target.rotation.x, target.rotation.y, target.rotation.z);
}

function writeRotation(target: HumanoidRotationTarget, value: Quaternion): void {
	if (target.rotationQuaternion) {
		target.rotationQuaternion.copyFrom(value);
	} else {
		target.rotation.copyFrom(value.toEulerAngles());
	}
}

function muscleLimit(avatar: IHumanoidAvatar, role: HumanBone): { limit: IHumanoidMuscleLimit; authored: boolean } {
	const limit = normalizeHumanoidMuscleLimits(avatar.muscleLimits)[role];
	return {
		limit: limit ?? { min: [-180, -180, -180], max: [180, 180, 180] },
		authored: !!limit,
	};
}

function restRotation(avatar: IHumanoidAvatar, role: HumanBone): Quaternion | null {
	const boneName = avatar.mapping[role];
	const rest = boneName ? avatar.restPose[boneName] : null;
	return rest ? Quaternion.FromArray(rest.rotationQuaternion).normalize() : null;
}

function applyRestPose(avatar: IHumanoidAvatar, skeleton: Skeleton, warnings: Set<string>): void {
	for (const definition of HUMAN_BONE_DEFINITIONS) {
		const bone = boneForRole(skeleton, avatar, definition.role);
		const rest = restRotation(avatar, definition.role);
		if (!bone) {
			continue;
		}
		if (!rest) {
			warnings.add(`${definition.label} has no captured rest rotation.`);
			continue;
		}
		writeRotation(rotationTarget(bone), rest);
	}
	skeleton.computeAbsoluteTransforms();
}

function applyMusclePose(avatar: IHumanoidAvatar, skeleton: Skeleton, pose: Partial<Record<HumanBone, HumanoidMuscleValue>>, warnings: Set<string>): void {
	applyRestPose(avatar, skeleton, warnings);
	for (const [roleValue, muscle] of Object.entries(pose)) {
		const role = roleValue as HumanBone;
		const bone = boneForRole(skeleton, avatar, role);
		const rest = restRotation(avatar, role);
		if (!bone || !rest || !muscle) {
			warnings.add(`${role} cannot be previewed because its mapped bone or captured rest rotation is unavailable.`);
			continue;
		}
		const { limit } = muscleLimit(avatar, role);
		const degrees = muscle.map((value, axis) => humanoidMuscleValueToDegrees(value, limit.min[axis], limit.max[axis])) as HumanoidMuscleValue;
		const rotation = rest.multiply(Quaternion.RotationYawPitchRoll((degrees[1] * Math.PI) / 180, (degrees[0] * Math.PI) / 180, (degrees[2] * Math.PI) / 180)).normalize();
		writeRotation(rotationTarget(bone), rotation);
	}
	skeleton.computeAbsoluteTransforms();
}

function worldPosition(bone: Bone, mesh: TransformNode | undefined): Vector3 {
	const node = bone.getTransformNode();
	return node ? node.getAbsolutePosition() : bone.getPosition(Space.WORLD, mesh);
}

function rotateBoneToward(bone: Bone, child: Bone, desiredDirection: Vector3, mesh: TransformNode | undefined): boolean {
	const currentDirection = worldPosition(child, mesh).subtract(worldPosition(bone, mesh));
	if (currentDirection.lengthSquared() <= 1e-10 || desiredDirection.lengthSquared() <= 1e-10) {
		return false;
	}
	currentDirection.normalize();
	desiredDirection.normalize();
	const dot = Math.min(1, Math.max(-1, Vector3.Dot(currentDirection, desiredDirection)));
	const angle = Math.acos(dot);
	if (angle <= 1e-5) {
		return true;
	}
	let axis = Vector3.Cross(currentDirection, desiredDirection);
	if (axis.lengthSquared() <= 1e-10) {
		axis = Vector3.Cross(currentDirection, Math.abs(currentDirection.y) < 0.9 ? Vector3.Up() : Vector3.Right());
	}
	if (axis.lengthSquared() <= 1e-10) {
		return false;
	}
	axis.normalize();
	const target = bone.getTransformNode();
	if (target) {
		target.rotate(axis, angle, Space.WORLD);
		target.computeWorldMatrix(true);
	} else {
		bone.rotate(axis, angle, Space.WORLD, mesh);
	}
	return true;
}

function enforceArmTPose(scene: Scene, avatar: IHumanoidAvatar, skeleton: Skeleton, side: "left" | "right", warnings: Set<string>): boolean {
	const upper = boneForRole(skeleton, avatar, `${side}UpperArm` as HumanBone);
	const lower = boneForRole(skeleton, avatar, `${side}LowerArm` as HumanBone);
	const hand = boneForRole(skeleton, avatar, `${side}Hand` as HumanBone);
	if (!upper || !lower || !hand) {
		warnings.add(`${side === "left" ? "Left" : "Right"} arm requires mapped upper-arm, lower-arm, and hand bones for T-pose enforcement.`);
		return false;
	}
	const mesh = scene.meshes.find((candidate) => candidate.skeleton === skeleton) as TransformNode | undefined;
	const lateral = side === "left" ? Vector3.Right() : Vector3.Left();
	const desiredDirection = mesh ? Vector3.TransformNormal(lateral, mesh.getWorldMatrix()).normalize() : lateral;
	const upperAligned = rotateBoneToward(upper, lower, desiredDirection.clone(), mesh);
	skeleton.computeAbsoluteTransforms();
	const lowerAligned = rotateBoneToward(lower, hand, desiredDirection.clone(), mesh);
	skeleton.computeAbsoluteTransforms();
	if (!upperAligned || !lowerAligned) {
		warnings.add(`${side === "left" ? "Left" : "Right"} arm could not be fully aligned because one arm segment has zero length.`);
	}
	return upperAligned && lowerAligned;
}

function applyPosePreview(scene: Scene, session: IHumanoidPosePreviewSession): void {
	const { avatar, skeleton } = resolvePreviewAvatar(scene, session.avatarId);
	const warnings = new Set<string>();
	if (session.preset === "muscles") {
		applyMusclePose(avatar, skeleton, session.pose, warnings);
	} else {
		applyRestPose(avatar, skeleton, warnings);
		if (session.preset === "tPose") {
			enforceArmTPose(scene, avatar, skeleton, "left", warnings);
			enforceArmTPose(scene, avatar, skeleton, "right", warnings);
		}
	}
	session.warnings = [...warnings];
}

function captureOriginalRotations(avatar: IHumanoidAvatar, skeleton: Skeleton): Map<string, Quaternion> {
	const rotations = new Map<string, Quaternion>();
	for (const definition of HUMAN_BONE_DEFINITIONS) {
		const bone = boneForRole(skeleton, avatar, definition.role);
		if (bone && !rotations.has(bone.name)) {
			rotations.set(bone.name, readRotation(rotationTarget(bone)));
		}
	}
	return rotations;
}

function currentMuscleDegrees(avatar: IHumanoidAvatar, role: HumanBone, bone: Bone): HumanoidMuscleValue | null {
	const rest = restRotation(avatar, role);
	if (!rest) {
		return null;
	}
	const delta = rest
		.conjugate()
		.multiply(readRotation(rotationTarget(bone)))
		.normalize()
		.toEulerAngles();
	return [(delta.x * 180) / Math.PI, (delta.y * 180) / Math.PI, (delta.z * 180) / Math.PI];
}

/** Reads the current mapped pose in normalized Unity-style muscle space, including active temporary-preview state. */
export function getHumanoidMusclePose(scene: Scene, avatarId: string): IHumanoidMusclePose {
	const { avatar, skeleton } = resolvePreviewAvatar(scene, avatarId);
	const session = previewMap(scene).get(avatar.id);
	const muscles = HUMAN_BONE_DEFINITIONS.flatMap((definition) => {
		const bone = boneForRole(skeleton, avatar, definition.role);
		const degrees = bone ? currentMuscleDegrees(avatar, definition.role, bone) : null;
		if (!bone || !degrees) {
			return [];
		}
		const { limit, authored } = muscleLimit(avatar, definition.role);
		const normalized = degrees.map((value, axis) => humanoidMuscleDegreesToValue(value, limit.min[axis], limit.max[axis])) as HumanoidMuscleValue;
		const withinLimits = degrees.every((value, axis) => value >= limit.min[axis] - 1e-5 && value <= limit.max[axis] + 1e-5);
		return [
			{
				role: definition.role,
				label: definition.label,
				boneName: bone.name,
				normalized,
				degrees,
				min: [...limit.min] as HumanoidMuscleValue,
				max: [...limit.max] as HumanoidMuscleValue,
				authoredLimits: authored,
				withinLimits,
			},
		];
	});
	return {
		avatarId: avatar.id,
		skeletonId: skeleton.id,
		active: !!session,
		preset: session?.preset ?? "none",
		muscles,
		activeMuscleCount: muscles.filter((muscle) => muscle.normalized.some((value) => Math.abs(value) > 1e-4)).length,
		mappedMuscleCount: muscles.length,
		warnings: session?.warnings ?? [],
	};
}

/**
 * Starts or updates a temporary, non-persisted Humanoid pose preview.
 * Every active preview is restored automatically before editor scene serialization.
 */
export function setHumanoidMusclePosePreview(
	scene: Scene,
	avatarId: string,
	options: {
		preset?: "muscles" | "rest" | "tPose";
		pose?: unknown;
		replace?: boolean;
	} = {}
): IHumanoidMusclePose {
	const { avatar, skeleton } = resolvePreviewAvatar(scene, avatarId);
	const previews = previewMap(scene);
	let session = previews.get(avatar.id);
	if (!session) {
		session = {
			avatarId: avatar.id,
			skeletonId: skeleton.id,
			preset: "muscles",
			pose: {},
			originalRotations: captureOriginalRotations(avatar, skeleton),
			observer: scene.onBeforeRenderObservable.add(() => {
				const active = previewMap(scene).get(avatar.id);
				if (active) {
					applyPosePreview(scene, active);
				}
			}),
			warnings: [],
		};
		previews.set(avatar.id, session);
	}
	session.preset = options.preset ?? session.preset;
	if (session.preset === "muscles") {
		const patch = normalizeHumanoidMusclePose(options.pose);
		session.pose = options.replace === true ? patch : { ...session.pose, ...patch };
	} else {
		session.pose = {};
	}
	applyPosePreview(scene, session);
	return getHumanoidMusclePose(scene, avatar.id);
}

/** Stops one temporary Humanoid pose preview and restores the exact rotations captured when previewing started. */
export function stopHumanoidMusclePosePreview(scene: Scene, avatarId: string): { avatarId: string; stopped: boolean; restoredBoneCount: number } {
	const previews = previewMap(scene);
	const session = previews.get(avatarId);
	if (!session) {
		return { avatarId, stopped: false, restoredBoneCount: 0 };
	}
	scene.onBeforeRenderObservable.remove(session.observer);
	const skeleton = scene.skeletons.find((candidate) => candidate.id === session.skeletonId);
	let restoredBoneCount = 0;
	if (skeleton) {
		for (const [boneName, rotation] of session.originalRotations) {
			const bone = skeleton.bones.find((candidate) => candidate.name === boneName);
			if (bone) {
				writeRotation(rotationTarget(bone), rotation);
				restoredBoneCount++;
			}
		}
		skeleton.computeAbsoluteTransforms();
	}
	previews.delete(avatarId);
	return { avatarId, stopped: true, restoredBoneCount };
}

/** Stops every temporary Humanoid pose preview in a scene. Used before save/export so preview state is never authored accidentally. */
export function stopAllHumanoidMusclePosePreviews(scene: Scene): { stoppedPreviewCount: number; restoredBoneCount: number } {
	let stoppedPreviewCount = 0;
	let restoredBoneCount = 0;
	for (const avatarId of [...previewMap(scene).keys()]) {
		const result = stopHumanoidMusclePosePreview(scene, avatarId);
		if (result.stopped) {
			stoppedPreviewCount++;
			restoredBoneCount += result.restoredBoneCount;
		}
	}
	return { stoppedPreviewCount, restoredBoneCount };
}

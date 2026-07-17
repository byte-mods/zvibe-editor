import { Animation, AnimationGroup, Bone, Color3, Matrix, Quaternion, Scene, Skeleton, SkeletonViewer, Tools, Vector3 } from "babylonjs";
import {
	autoMapHumanoidBones,
	HUMAN_BONE_DEFINITIONS,
	HUMAN_BONES,
	HUMANOID_AVATAR_VERSION,
	HumanBone,
	IHumanoidAvatar,
	IHumanoidAvatarValidation,
	IHumanoidBoneRecord,
	IHumanoidRestTransform,
	normalizeHumanoidMuscleLimit,
	normalizeHumanoidMuscleLimits,
	normalizeHumanoidMapping,
	validateHumanoidAvatar,
	configureHumanoidMuscleLimits,
	getHumanoidMusclePose as getRuntimeHumanoidMusclePose,
	setHumanoidMusclePosePreview as setRuntimeHumanoidMusclePosePreview,
	stopHumanoidMusclePosePreview as stopRuntimeHumanoidMusclePosePreview,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { setNodeSerializable, setNodeVisibleInGraph } from "../../tools/node/metadata";

interface IRetargetHumanoidAnimationData {
	sourceAvatarId: string;
	targetAvatarId: string;
	animationGroupName: string;
	outputName: string;
	includeRootTranslation?: boolean;
	includeScale?: boolean;
}

interface IHumanoidRetargetDebugVisualization {
	sourceAvatarId: string;
	targetAvatarId: string;
	showAxes: boolean;
	sourceViewer: SkeletonViewer;
	targetViewer: SkeletonViewer;
}

const humanoidRetargetDebugVisualizations = new WeakMap<Scene, IHumanoidRetargetDebugVisualization>();

function avatars(scene: Scene): IHumanoidAvatar[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorHumanoidAvatars ??= []);
}

function resolveSkeleton(scene: Scene, skeletonId: string): Skeleton {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === skeletonId);
	if (!skeleton) {
		throw new Error(`Skeleton "${skeletonId}" was not found.`);
	}
	return skeleton;
}

function resolveAvatar(scene: Scene, avatarId: string): IHumanoidAvatar {
	const avatar = avatars(scene).find((candidate) => candidate.id === avatarId);
	if (!avatar) {
		throw new Error(`Humanoid Avatar "${avatarId}" was not found.`);
	}
	return avatar;
}

function absoluteRestMatrix(bone: Bone, cache: Map<Bone, Matrix>): Matrix {
	const cached = cache.get(bone);
	if (cached) {
		return cached;
	}
	const parent = bone.getParent();
	const result = parent ? bone.getRestMatrix().multiply(absoluteRestMatrix(parent, cache)) : bone.getRestMatrix().clone();
	cache.set(bone, result);
	return result;
}

function restTransform(matrix: Matrix): IHumanoidRestTransform {
	const scaling = Vector3.One();
	const rotation = Quaternion.Identity();
	const position = Vector3.Zero();
	matrix.decompose(scaling, rotation, position);
	return {
		position: position.asArray() as [number, number, number],
		rotationQuaternion: rotation.asArray() as [number, number, number, number],
		scaling: scaling.asArray() as [number, number, number],
	};
}

function skeletonDescription(skeleton: Skeleton): { bones: IHumanoidBoneRecord[]; restPose: Record<string, IHumanoidRestTransform> } {
	const absoluteCache = new Map<Bone, Matrix>();
	const bones: IHumanoidBoneRecord[] = [];
	const restPose: Record<string, IHumanoidRestTransform> = {};
	for (const bone of skeleton.bones) {
		const absolute = restTransform(absoluteRestMatrix(bone, absoluteCache));
		bones.push({ name: bone.name, parentName: bone.getParent()?.name ?? null, restPosition: absolute.position });
		restPose[bone.name] = restTransform(bone.getRestMatrix());
	}
	return { bones, restPose };
}

function humanScale(mapping: Partial<Record<HumanBone, string>>, bones: IHumanoidBoneRecord[]): number {
	const byName = new Map(bones.map((bone) => [bone.name, bone]));
	const hips = byName.get(mapping.hips ?? "")?.restPosition;
	const head = byName.get(mapping.head ?? "")?.restPosition;
	if (hips && head) {
		const value = Math.hypot(head[0] - hips[0], head[1] - hips[1], head[2] - hips[2]);
		if (Number.isFinite(value) && value > 1e-6) {
			return value;
		}
	}
	return 1;
}

function avatarResult(scene: Scene, avatar: IHumanoidAvatar): IHumanoidAvatar & { validation: IHumanoidAvatarValidation; skeletonName: string } {
	const skeleton = resolveSkeleton(scene, avatar.skeletonId);
	const validation = validateHumanoidAvatar(avatar.animationType, avatar.mapping, skeletonDescription(skeleton).bones);
	return { ...structuredClone(avatar), skeletonName: skeleton.name, validation };
}

/** Lists persisted Unity-style Generic/Humanoid Avatar definitions and their current validation evidence. */
export function listHumanoidAvatars(scene: Scene): any {
	return { avatars: avatars(scene).map((avatar) => avatarResult(scene, avatar)) };
}

/** Returns the current mapping, rest-pose evidence, hierarchy, and validation for one Avatar. */
export function getHumanoidAvatar(scene: Scene, data: any): any {
	return avatarResult(scene, resolveAvatar(scene, data.avatarId));
}

/** Creates one persisted Avatar for a skeleton, optionally copying role coverage from another Avatar. */
export function createHumanoidAvatar(scene: Scene, data: any, options: IMCPActionOptions): any {
	const skeleton = resolveSkeleton(scene, data.skeletonId);
	if (avatars(scene).some((candidate) => candidate.skeletonId === skeleton.id)) {
		throw new Error(`Skeleton "${skeleton.name}" already has a Humanoid Avatar. Update it instead.`);
	}
	const id = String(data.id ?? Tools.RandomId()).trim();
	if (!id || id.length > 256) {
		throw new Error("Avatar id must contain 1 through 256 characters.");
	}
	if (avatars(scene).some((candidate) => candidate.id === id)) {
		throw new Error(`Humanoid Avatar "${id}" already exists.`);
	}
	const animationType = data.animationType === "none" || data.animationType === "generic" ? data.animationType : "humanoid";
	const description = skeletonDescription(skeleton);
	let mapping = data.autoMap === false ? {} : autoMapHumanoidBones(description.bones);
	let source: IHumanoidAvatar["source"] = "model";
	let sourceAvatarId: string | undefined;
	if (data.copyFromAvatarId) {
		const sourceAvatar = resolveAvatar(scene, data.copyFromAvatarId);
		const copiedRoles = new Set(Object.keys(sourceAvatar.mapping));
		mapping = Object.fromEntries(Object.entries(mapping).filter(([role]) => copiedRoles.has(role))) as Partial<Record<HumanBone, string>>;
		source = "copy";
		sourceAvatarId = sourceAvatar.id;
	}
	mapping = { ...mapping, ...normalizeHumanoidMapping(data.mapping) };
	const avatar: IHumanoidAvatar = {
		version: HUMANOID_AVATAR_VERSION,
		id,
		name:
			String(data.name ?? `${skeleton.name} Avatar`)
				.trim()
				.slice(0, 256) || `${skeleton.name} Avatar`,
		skeletonId: skeleton.id,
		animationType,
		source,
		...(sourceAvatarId ? { sourceAvatarId } : {}),
		mapping,
		restPose: description.restPose,
		humanScale: humanScale(mapping, description.bones),
		muscleLimitsEnabled: false,
		muscleLimits: {},
	};
	avatars(scene).push(avatar);
	configureHumanoidMuscleLimits(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return avatarResult(scene, avatar);
}

/** Updates Avatar type/name, replaces or patches mapping roles, refreshes the rest pose, or re-runs automatic mapping. */
export function setHumanoidAvatar(scene: Scene, data: any, options: IMCPActionOptions): any {
	const avatar = resolveAvatar(scene, data.avatarId);
	if (data.animationType !== undefined || data.autoMap === true || data.replaceMapping !== undefined || data.mapping !== undefined || data.refreshRestPose === true) {
		stopRuntimeHumanoidMusclePosePreview(scene as any, avatar.id);
		stopHumanoidRetargetDebugVisualization(scene);
	}
	const skeleton = resolveSkeleton(scene, avatar.skeletonId);
	const description = skeletonDescription(skeleton);
	let nextMuscleLimits = avatar.muscleLimits;
	if (data.replaceMuscleLimits !== undefined) {
		nextMuscleLimits = normalizeHumanoidMuscleLimits(data.replaceMuscleLimits);
	}
	if (data.muscleLimits !== undefined) {
		const next = { ...(nextMuscleLimits ?? {}) };
		const patch = data.muscleLimits as Record<string, unknown>;
		for (const definition of HUMAN_BONE_DEFINITIONS) {
			if (!(definition.role in patch)) {
				continue;
			}
			const limit = patch[definition.role];
			if (limit === null) {
				delete next[definition.role];
			} else {
				next[definition.role] = normalizeHumanoidMuscleLimit(limit);
			}
		}
		nextMuscleLimits = next;
	}
	if (data.name !== undefined) {
		const name = String(data.name).trim();
		if (!name || name.length > 256) {
			throw new Error("Avatar name must contain 1 through 256 characters.");
		}
		avatar.name = name;
	}
	if (data.animationType !== undefined) {
		if (!["none", "generic", "humanoid"].includes(data.animationType)) {
			throw new Error("animationType must be none, generic, or humanoid.");
		}
		avatar.animationType = data.animationType;
	}
	if (data.autoMap === true) {
		avatar.mapping = autoMapHumanoidBones(description.bones);
		avatar.source = "model";
		delete avatar.sourceAvatarId;
	}
	if (data.replaceMapping !== undefined) {
		avatar.mapping = normalizeHumanoidMapping(data.replaceMapping);
	}
	if (data.mapping !== undefined) {
		const patch = data.mapping as Record<string, unknown>;
		for (const definition of HUMAN_BONE_DEFINITIONS) {
			if (!(definition.role in patch)) {
				continue;
			}
			const value = patch[definition.role];
			if (value === null || value === "") {
				delete avatar.mapping[definition.role];
			} else if (typeof value === "string") {
				avatar.mapping[definition.role] = value.trim().slice(0, 512);
			} else {
				throw new Error(`${definition.role} must be a bone name string or null to clear it.`);
			}
		}
	}
	if (data.refreshRestPose === true) {
		avatar.restPose = description.restPose;
	}
	if (data.muscleLimitsEnabled !== undefined) {
		avatar.muscleLimitsEnabled = data.muscleLimitsEnabled === true;
	}
	if (data.replaceMuscleLimits !== undefined || data.muscleLimits !== undefined) {
		avatar.muscleLimits = nextMuscleLimits;
	}
	avatar.humanScale = humanScale(avatar.mapping, description.bones);
	configureHumanoidMuscleLimits(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return avatarResult(scene, avatar);
}

/** Sets/clears per-role local XYZ rotation limits and enables or disables live muscle clamping. */
export function setHumanoidMuscleLimits(scene: Scene, data: any, options: IMCPActionOptions): any {
	return setHumanoidAvatar(
		scene,
		{
			avatarId: data.avatarId,
			...(data.enabled !== undefined ? { muscleLimitsEnabled: data.enabled } : {}),
			...(data.limits !== undefined ? { muscleLimits: data.limits } : {}),
			...(data.replaceLimits !== undefined ? { replaceMuscleLimits: data.replaceLimits } : {}),
		},
		options
	);
}

/** Reads current mapped local rotations as normalized -1..1 Humanoid muscle values and reports temporary-preview state. */
export function getHumanoidMusclePose(scene: Scene, data: any): any {
	return getRuntimeHumanoidMusclePose(scene as any, data.avatarId);
}

/** Starts or updates a temporary Rest, T-pose, or normalized muscle preview without changing persisted Avatar or animation data. */
export function setHumanoidPosePreview(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.preset !== undefined && !["muscles", "rest", "tPose"].includes(data.preset)) {
		throw new Error("preset must be muscles, rest, or tPose.");
	}
	if (data.pose !== undefined) {
		if (!data.pose || typeof data.pose !== "object" || Array.isArray(data.pose)) {
			throw new Error("pose must be a canonical human-role to normalized XYZ array map.");
		}
		const unknownRoles = Object.keys(data.pose).filter((role) => !HUMAN_BONES.includes(role as HumanBone));
		if (unknownRoles.length) {
			throw new Error(`Unknown Humanoid muscle role(s): ${unknownRoles.join(", ")}.`);
		}
	}
	const result = setRuntimeHumanoidMusclePosePreview(scene as any, data.avatarId, {
		...(data.preset !== undefined ? { preset: data.preset } : {}),
		...(data.pose !== undefined ? { pose: data.pose } : {}),
		replace: data.replace === true,
	});
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Stops a temporary Humanoid pose preview and restores the exact rotations captured when the preview began. */
export function stopHumanoidPosePreview(scene: Scene, data: any, options: IMCPActionOptions): any {
	resolveAvatar(scene, data.avatarId);
	const result = stopRuntimeHumanoidMusclePosePreview(scene as any, data.avatarId);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Validates one persisted Avatar without changing it. */
export function validateSceneHumanoidAvatar(scene: Scene, data: any): IHumanoidAvatarValidation {
	return getHumanoidAvatar(scene, data).validation;
}

/** Removes a persisted Avatar definition. Baked retargeted AnimationGroups remain ordinary editable scene content. */
export function deleteHumanoidAvatar(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = avatars(scene).findIndex((candidate) => candidate.id === data.avatarId);
	if (index === -1) {
		throw new Error(`Humanoid Avatar "${data.avatarId}" was not found.`);
	}
	stopRuntimeHumanoidMusclePosePreview(scene as any, data.avatarId);
	stopHumanoidRetargetDebugVisualization(scene);
	avatars(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, avatarId: data.avatarId };
}

function quaternionValue(value: any): Quaternion | null {
	if (value instanceof Quaternion) {
		return value;
	}
	if (value && [value.x, value.y, value.z, value.w].every((component) => typeof component === "number" && Number.isFinite(component))) {
		return new Quaternion(value.x, value.y, value.z, value.w);
	}
	return null;
}

function vectorValue(value: any): Vector3 | null {
	if (value instanceof Vector3) {
		return value;
	}
	if (value && [value.x, value.y, value.z].every((component) => typeof component === "number" && Number.isFinite(component))) {
		return new Vector3(value.x, value.y, value.z);
	}
	return null;
}

function cloneRetargetedAnimation(
	source: Animation,
	role: HumanBone,
	sourceRest: IHumanoidRestTransform,
	targetRest: IHumanoidRestTransform,
	options: { scaleRatio: number; includeRootTranslation: boolean; includeScale: boolean }
): Animation | null {
	const property = source.targetProperty;
	const output = source.clone(true);
	if (property.endsWith("rotationQuaternion")) {
		const sourceRestRotation = Quaternion.FromArray(sourceRest.rotationQuaternion);
		const targetRestRotation = Quaternion.FromArray(targetRest.rotationQuaternion);
		const inverseSourceRest = sourceRestRotation.conjugate();
		output.setKeys(
			source.getKeys().map((key) => {
				const value = quaternionValue(key.value);
				return {
					...key,
					value: value ? targetRestRotation.multiply(inverseSourceRest.multiply(value)).normalize() : (key.value?.clone?.() ?? key.value),
				};
			})
		);
		return output;
	}
	if (property.endsWith("position")) {
		if (role !== "hips" || !options.includeRootTranslation) {
			return null;
		}
		const sourceRestPosition = Vector3.FromArray(sourceRest.position);
		const targetRestPosition = Vector3.FromArray(targetRest.position);
		output.setKeys(
			source.getKeys().map((key) => {
				const value = vectorValue(key.value);
				return {
					...key,
					value: value ? targetRestPosition.add(value.subtract(sourceRestPosition).scale(options.scaleRatio)) : (key.value?.clone?.() ?? key.value),
				};
			})
		);
		return output;
	}
	if (property.endsWith("scaling")) {
		return options.includeScale ? output : null;
	}
	if (property.endsWith("rotation")) {
		const sourceRestRotation = Quaternion.FromArray(sourceRest.rotationQuaternion);
		const targetRestRotation = Quaternion.FromArray(targetRest.rotationQuaternion);
		const inverseSourceRest = sourceRestRotation.conjugate();
		output.setKeys(
			source.getKeys().map((key) => {
				const value = vectorValue(key.value);
				const quaternion = value ? Quaternion.RotationYawPitchRoll(value.y, value.x, value.z) : null;
				return {
					...key,
					value: quaternion ? targetRestRotation.multiply(inverseSourceRest.multiply(quaternion)).normalize().toEulerAngles() : (key.value?.clone?.() ?? key.value),
				};
			})
		);
		return output;
	}
	return null;
}

function sourceRoleForTarget(sourceSkeleton: Skeleton, sourceAvatar: IHumanoidAvatar, target: any): HumanBone | null {
	const bone = sourceSkeleton.bones.find((candidate) => candidate === target || candidate.getTransformNode() === target || candidate.name === target?.name);
	if (!bone) {
		return null;
	}
	return (Object.entries(sourceAvatar.mapping).find(([, boneName]) => boneName === bone.name)?.[0] as HumanBone | undefined) ?? null;
}

function retargetTrackCompatibility(
	role: HumanBone,
	property: string,
	options: { includeRootTranslation: boolean; includeScale: boolean }
): { compatible: boolean; kind: "rotation" | "rootTranslation" | "scale" | "unsupported"; reason: string | null } {
	if (property.endsWith("rotationQuaternion") || property.endsWith("rotation")) {
		return { compatible: true, kind: "rotation", reason: null };
	}
	if (property.endsWith("position")) {
		return role === "hips" && options.includeRootTranslation
			? { compatible: true, kind: "rootTranslation", reason: null }
			: { compatible: false, kind: "rootTranslation", reason: role === "hips" ? "Root translation is disabled." : "Only Hips position tracks can be retargeted." };
	}
	if (property.endsWith("scaling")) {
		return options.includeScale ? { compatible: true, kind: "scale", reason: null } : { compatible: false, kind: "scale", reason: "Scale-track retargeting is disabled." };
	}
	return { compatible: false, kind: "unsupported", reason: `Property "${property}" is not a supported Humanoid retarget track.` };
}

function retargetVisualizationState(scene: Scene): any {
	const state = humanoidRetargetDebugVisualizations.get(scene);
	return state
		? {
				active: true,
				sourceAvatarId: state.sourceAvatarId,
				targetAvatarId: state.targetAvatarId,
				showAxes: state.showAxes,
				sourceColor: [0.1, 0.85, 1],
				targetColor: [1, 0.2, 0.75],
			}
		: { active: false };
}

/** Produces a bounded, non-mutating source/target Avatar and AnimationGroup compatibility report before retarget baking. */
export function inspectHumanoidRetarget(scene: Scene, data: any): any {
	const sourceAvatar = resolveAvatar(scene, data.sourceAvatarId);
	const targetAvatar = resolveAvatar(scene, data.targetAvatarId);
	const sourceSkeleton = resolveSkeleton(scene, sourceAvatar.skeletonId);
	const targetSkeleton = resolveSkeleton(scene, targetAvatar.skeletonId);
	const sourceValidation = avatarResult(scene, sourceAvatar).validation;
	const targetValidation = avatarResult(scene, targetAvatar).validation;
	const sourceGroup = scene.animationGroups.find((group) => group.name === data.animationGroupName);
	if (!sourceGroup) {
		throw new Error(`AnimationGroup "${data.animationGroupName}" was not found.`);
	}
	const options = {
		includeRootTranslation: data.includeRootTranslation !== false,
		includeScale: data.includeScale === true,
	};
	const roleTracks = new Map<HumanBone, Array<{ property: string; compatible: boolean; kind: string; reason: string | null }>>();
	let unrecognizedTrackCount = 0;
	for (const targeted of sourceGroup.targetedAnimations) {
		const role = sourceRoleForTarget(sourceSkeleton, sourceAvatar, targeted.target);
		if (!role) {
			unrecognizedTrackCount++;
			continue;
		}
		const compatibility = retargetTrackCompatibility(role, targeted.animation.targetProperty, options);
		roleTracks.set(role, [
			...(roleTracks.get(role) ?? []),
			{ property: targeted.animation.targetProperty, compatible: compatibility.compatible, kind: compatibility.kind, reason: compatibility.reason },
		]);
	}
	const roles = HUMAN_BONE_DEFINITIONS.map((definition) => {
		const sourceBoneName = sourceAvatar.mapping[definition.role] ?? null;
		const targetBoneName = targetAvatar.mapping[definition.role] ?? null;
		const sourceRest = sourceBoneName ? sourceAvatar.restPose[sourceBoneName] : null;
		const targetRest = targetBoneName ? targetAvatar.restPose[targetBoneName] : null;
		const tracks = roleTracks.get(definition.role) ?? [];
		const compatibleTrackCount = tracks.filter((track) => track.compatible && !!sourceRest && !!targetRest && !!targetBoneName).length;
		const correction =
			sourceRest && targetRest
				? Quaternion.FromArray(targetRest.rotationQuaternion).multiply(Quaternion.FromArray(sourceRest.rotationQuaternion).conjugate()).normalize()
				: null;
		const correctionEuler = correction?.toEulerAngles();
		let status: "ready" | "noTracks" | "missingSourceMapping" | "missingTargetMapping" | "missingRestPose" = "ready";
		if (!sourceBoneName) {
			status = "missingSourceMapping";
		} else if (!targetBoneName) {
			status = "missingTargetMapping";
		} else if (!sourceRest || !targetRest) {
			status = "missingRestPose";
		} else if (!tracks.length) {
			status = "noTracks";
		}
		return {
			role: definition.role,
			label: definition.label,
			required: definition.required,
			status,
			sourceBoneName,
			targetBoneName,
			sourceTrackCount: tracks.length,
			compatibleTrackCount,
			skippedTrackCount: tracks.length - compatibleTrackCount,
			trackProperties: [...new Set(tracks.map((track) => track.property))],
			skipReasons: [...new Set(tracks.flatMap((track) => (track.reason ? [track.reason] : [])))],
			correctionEulerDegrees: correctionEuler ? [Tools.ToDegrees(correctionEuler.x), Tools.ToDegrees(correctionEuler.y), Tools.ToDegrees(correctionEuler.z)] : null,
			correctionAngleDegrees: correction ? Tools.ToDegrees(2 * Math.acos(Math.min(1, Math.abs(correction.w)))) : null,
		};
	});
	const compatibleTrackCount = roles.reduce((total, role) => total + role.compatibleTrackCount, 0);
	const recognizedTrackCount = roles.reduce((total, role) => total + role.sourceTrackCount, 0);
	const errors: string[] = [];
	if (sourceAvatar.animationType !== "humanoid" || !sourceValidation.valid) {
		errors.push(`Source Avatar "${sourceAvatar.name}" is not a valid Humanoid Avatar.`);
	}
	if (targetAvatar.animationType !== "humanoid" || !targetValidation.valid) {
		errors.push(`Target Avatar "${targetAvatar.name}" is not a valid Humanoid Avatar.`);
	}
	if (!compatibleTrackCount) {
		errors.push("No compatible mapped rotation, Hips translation, or enabled scale tracks are available to bake.");
	}
	const warnings: string[] = [];
	if (unrecognizedTrackCount) {
		warnings.push(`${unrecognizedTrackCount} source track(s) target objects outside the source Avatar mapping.`);
	}
	const skippedRecognizedTrackCount = recognizedTrackCount - compatibleTrackCount;
	if (skippedRecognizedTrackCount) {
		warnings.push(`${skippedRecognizedTrackCount} mapped source track(s) are disabled, unsupported, or missing target/rest-pose data.`);
	}
	return {
		sourceAvatarId: sourceAvatar.id,
		sourceAvatarName: sourceAvatar.name,
		sourceSkeletonId: sourceSkeleton.id,
		sourceSkeletonName: sourceSkeleton.name,
		targetAvatarId: targetAvatar.id,
		targetAvatarName: targetAvatar.name,
		targetSkeletonId: targetSkeleton.id,
		targetSkeletonName: targetSkeleton.name,
		animationGroupName: sourceGroup.name,
		from: sourceGroup.from,
		to: sourceGroup.to,
		includeRootTranslation: options.includeRootTranslation,
		includeScale: options.includeScale,
		humanScaleRatio: targetAvatar.humanScale / Math.max(sourceAvatar.humanScale, 1e-6),
		totalTrackCount: sourceGroup.targetedAnimations.length,
		recognizedTrackCount,
		unrecognizedTrackCount,
		compatibleTrackCount,
		skippedTrackCount: sourceGroup.targetedAnimations.length - compatibleTrackCount,
		readyRoleCount: roles.filter((role) => role.status === "ready").length,
		rolesWithCompatibleTracks: roles.filter((role) => role.compatibleTrackCount > 0).length,
		sourceValidation,
		targetValidation,
		roles,
		canBake: errors.length === 0,
		errors,
		warnings,
		visualization: retargetVisualizationState(scene),
	};
}

/** Disposes the current temporary source/target skeleton overlay, if one exists. */
export function stopHumanoidRetargetDebugVisualization(scene: Scene): any {
	const state = humanoidRetargetDebugVisualizations.get(scene);
	if (!state) {
		return { stopped: false, active: false };
	}
	state.sourceViewer.dispose();
	state.targetViewer.dispose();
	humanoidRetargetDebugVisualizations.delete(scene);
	return { stopped: true, active: false, sourceAvatarId: state.sourceAvatarId, targetAvatarId: state.targetAvatarId };
}

/** Shows or hides temporary color-coded source/target skeletons and optional local axes in the editor viewport. */
export function setHumanoidRetargetDebugVisualization(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.enabled === false) {
		const result = stopHumanoidRetargetDebugVisualization(scene);
		options.editor.layout.inspector.forceUpdate();
		return result;
	}
	if (typeof data.sourceAvatarId !== "string" || !data.sourceAvatarId.trim() || typeof data.targetAvatarId !== "string" || !data.targetAvatarId.trim()) {
		throw new Error("sourceAvatarId and targetAvatarId are required when enabling Humanoid retarget debug visualization.");
	}
	const sourceAvatar = resolveAvatar(scene, data.sourceAvatarId);
	const targetAvatar = resolveAvatar(scene, data.targetAvatarId);
	if (sourceAvatar.animationType !== "humanoid" || targetAvatar.animationType !== "humanoid") {
		throw new Error("Both source and target must use the Humanoid animation type before showing retarget debug skeletons.");
	}
	const sourceSkeleton = resolveSkeleton(scene, sourceAvatar.skeletonId);
	const targetSkeleton = resolveSkeleton(scene, targetAvatar.skeletonId);
	const showAxes = data.showAxes === true;
	const existing = humanoidRetargetDebugVisualizations.get(scene);
	if (existing && existing.sourceAvatarId === sourceAvatar.id && existing.targetAvatarId === targetAvatar.id) {
		existing.showAxes = showAxes;
		existing.sourceViewer.changeDisplayOptions("showLocalAxes", showAxes);
		existing.targetViewer.changeDisplayOptions("showLocalAxes", showAxes);
		options.editor.layout.inspector.forceUpdate();
		return retargetVisualizationState(scene);
	}
	stopHumanoidRetargetDebugVisualization(scene);
	const viewerOptions = {
		pauseAnimations: false,
		returnToRest: false,
		displayMode: SkeletonViewer.DISPLAY_LINES,
		displayOptions: { showLocalAxes: showAxes, localAxesSize: 0.08 },
		computeBonesUsingShaders: false,
		useAllBones: true,
	};
	const sourceViewer = new SkeletonViewer(sourceSkeleton, scene.meshes.find((mesh) => mesh.skeleton === sourceSkeleton) ?? null, scene, true, 3, viewerOptions);
	const targetViewer = new SkeletonViewer(targetSkeleton, scene.meshes.find((mesh) => mesh.skeleton === targetSkeleton) ?? null, scene, true, 3, viewerOptions);
	sourceViewer.color = new Color3(0.1, 0.85, 1);
	targetViewer.color = new Color3(1, 0.2, 0.75);
	sourceViewer.isEnabled = true;
	targetViewer.isEnabled = true;
	for (const viewer of [sourceViewer, targetViewer]) {
		viewer.update();
		if (viewer.debugMesh) {
			setNodeSerializable(viewer.debugMesh, false);
			setNodeVisibleInGraph(viewer.debugMesh, false);
		}
		if (viewer.debugLocalAxesMesh) {
			setNodeSerializable(viewer.debugLocalAxesMesh, false);
			setNodeVisibleInGraph(viewer.debugLocalAxesMesh, false);
		}
	}
	humanoidRetargetDebugVisualizations.set(scene, { sourceAvatarId: sourceAvatar.id, targetAvatarId: targetAvatar.id, showAxes, sourceViewer, targetViewer });
	options.editor.layout.inspector.forceUpdate();
	return retargetVisualizationState(scene);
}

/** Bakes a retargeted AnimationGroup using canonical Avatar roles and source/target local rest-pose rotation deltas. */
export function retargetHumanoidAnimation(scene: Scene, data: IRetargetHumanoidAnimationData, options: IMCPActionOptions): any {
	const sourceAvatar = resolveAvatar(scene, data.sourceAvatarId);
	const targetAvatar = resolveAvatar(scene, data.targetAvatarId);
	const sourceValidation = avatarResult(scene, sourceAvatar).validation;
	const targetValidation = avatarResult(scene, targetAvatar).validation;
	if (!sourceValidation.valid || !targetValidation.valid || sourceAvatar.animationType !== "humanoid" || targetAvatar.animationType !== "humanoid") {
		throw new Error("Both source and target must be valid Humanoid Avatars before retargeting.");
	}
	const sourceSkeleton = resolveSkeleton(scene, sourceAvatar.skeletonId);
	const targetSkeleton = resolveSkeleton(scene, targetAvatar.skeletonId);
	const sourceGroup = scene.animationGroups.find((group) => group.name === data.animationGroupName);
	if (!sourceGroup) {
		throw new Error(`AnimationGroup "${data.animationGroupName}" was not found.`);
	}
	const outputName = String(data.outputName).trim();
	if (!outputName || outputName.length > 256) {
		throw new Error("outputName must contain 1 through 256 characters.");
	}
	if (scene.animationGroups.some((group) => group.name === outputName)) {
		throw new Error(`AnimationGroup "${outputName}" already exists.`);
	}
	const output = new AnimationGroup(outputName, scene);
	let skippedTrackCount = 0;
	for (const targeted of sourceGroup.targetedAnimations) {
		const role = sourceRoleForTarget(sourceSkeleton, sourceAvatar, targeted.target);
		const sourceBoneName = role ? sourceAvatar.mapping[role] : undefined;
		const targetBoneName = role ? targetAvatar.mapping[role] : undefined;
		const targetBone = targetBoneName ? targetSkeleton.bones.find((bone) => bone.name === targetBoneName) : undefined;
		const sourceRest = sourceBoneName ? sourceAvatar.restPose[sourceBoneName] : undefined;
		const targetRest = targetBoneName ? targetAvatar.restPose[targetBoneName] : undefined;
		if (!role || !targetBone || !sourceRest || !targetRest) {
			skippedTrackCount++;
			continue;
		}
		const animation = cloneRetargetedAnimation(targeted.animation, role, sourceRest, targetRest, {
			scaleRatio: targetAvatar.humanScale / Math.max(sourceAvatar.humanScale, 1e-6),
			includeRootTranslation: data.includeRootTranslation !== false,
			includeScale: data.includeScale === true,
		});
		if (!animation) {
			skippedTrackCount++;
			continue;
		}
		output.addTargetedAnimation(animation, targetBone.getTransformNode() ?? targetBone);
	}
	if (!output.targetedAnimations.length) {
		output.dispose();
		throw new Error("No compatible humanoid rotation, root-position, or requested scale tracks were found in the source AnimationGroup.");
	}
	output.metadata = {
		babylonEditorHumanoidRetarget: {
			sourceAvatarId: sourceAvatar.id,
			targetAvatarId: targetAvatar.id,
			sourceAnimationGroupName: sourceGroup.name,
			includeRootTranslation: data.includeRootTranslation !== false,
			includeScale: data.includeScale === true,
		},
	};
	options.editor.layout.inspector.forceUpdate();
	return {
		name: output.name,
		sourceAvatarId: sourceAvatar.id,
		targetAvatarId: targetAvatar.id,
		trackCount: output.targetedAnimations.length,
		skippedTrackCount,
		from: output.from,
		to: output.to,
	};
}

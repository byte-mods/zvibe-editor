export const HUMANOID_AVATAR_VERSION = 1;

export type HumanoidAnimationType = "none" | "generic" | "humanoid";
export type HumanoidAvatarSource = "model" | "copy";
export type HumanoidBodyPart = "root" | "body" | "head" | "leftArm" | "rightArm" | "leftHand" | "rightHand" | "leftLeg" | "rightLeg";

export type HumanBone =
	| "hips"
	| "spine"
	| "chest"
	| "upperChest"
	| "neck"
	| "head"
	| "leftShoulder"
	| "leftUpperArm"
	| "leftLowerArm"
	| "leftHand"
	| "rightShoulder"
	| "rightUpperArm"
	| "rightLowerArm"
	| "rightHand"
	| "leftUpperLeg"
	| "leftLowerLeg"
	| "leftFoot"
	| "leftToes"
	| "rightUpperLeg"
	| "rightLowerLeg"
	| "rightFoot"
	| "rightToes"
	| "leftEye"
	| "rightEye"
	| "jaw"
	| "leftThumbProximal"
	| "leftThumbIntermediate"
	| "leftThumbDistal"
	| "leftIndexProximal"
	| "leftIndexIntermediate"
	| "leftIndexDistal"
	| "leftMiddleProximal"
	| "leftMiddleIntermediate"
	| "leftMiddleDistal"
	| "leftRingProximal"
	| "leftRingIntermediate"
	| "leftRingDistal"
	| "leftLittleProximal"
	| "leftLittleIntermediate"
	| "leftLittleDistal"
	| "rightThumbProximal"
	| "rightThumbIntermediate"
	| "rightThumbDistal"
	| "rightIndexProximal"
	| "rightIndexIntermediate"
	| "rightIndexDistal"
	| "rightMiddleProximal"
	| "rightMiddleIntermediate"
	| "rightMiddleDistal"
	| "rightRingProximal"
	| "rightRingIntermediate"
	| "rightRingDistal"
	| "rightLittleProximal"
	| "rightLittleIntermediate"
	| "rightLittleDistal";

export interface IHumanBoneDefinition {
	role: HumanBone;
	label: string;
	required: boolean;
	parentRole: HumanBone | null;
	aliases: string[];
}

export interface IHumanoidBoneRecord {
	name: string;
	parentName: string | null;
	restPosition?: [number, number, number];
}

export interface IHumanoidRestTransform {
	position: [number, number, number];
	rotationQuaternion: [number, number, number, number];
	scaling: [number, number, number];
}

export interface IHumanoidMuscleLimit {
	min: [number, number, number];
	max: [number, number, number];
}

export type HumanoidMuscleValue = [number, number, number];

export interface IHumanoidMusclePoseEntry {
	role: HumanBone;
	label: string;
	boneName: string;
	normalized: HumanoidMuscleValue;
	degrees: HumanoidMuscleValue;
	min: HumanoidMuscleValue;
	max: HumanoidMuscleValue;
	authoredLimits: boolean;
	withinLimits: boolean;
}

export interface IHumanoidMusclePose {
	avatarId: string;
	skeletonId: string;
	active: boolean;
	preset: "none" | "muscles" | "rest" | "tPose";
	muscles: IHumanoidMusclePoseEntry[];
	activeMuscleCount: number;
	mappedMuscleCount: number;
	warnings: string[];
}

export interface IHumanoidAvatar {
	version: 1;
	id: string;
	name: string;
	skeletonId: string;
	animationType: HumanoidAnimationType;
	source: HumanoidAvatarSource;
	sourceAvatarId?: string;
	mapping: Partial<Record<HumanBone, string>>;
	restPose: Record<string, IHumanoidRestTransform>;
	humanScale: number;
	muscleLimitsEnabled?: boolean;
	muscleLimits?: Partial<Record<HumanBone, IHumanoidMuscleLimit>>;
}

export interface IHumanoidAvatarMask {
	version: 1;
	id: string;
	name: string;
	avatarId: string;
	bodyParts: Record<HumanoidBodyPart, boolean>;
	transformNames: string[];
}

export interface IHumanoidAvatarValidation {
	valid: boolean;
	animationType: HumanoidAnimationType;
	mappedBoneCount: number;
	requiredBoneCount: number;
	requiredMappedBoneCount: number;
	missingRequired: HumanBone[];
	missingOptional: HumanBone[];
	unknownBones: Array<{ role: HumanBone; boneName: string }>;
	duplicateBones: Array<{ boneName: string; roles: HumanBone[] }>;
	hierarchyErrors: Array<{ role: HumanBone; expectedAncestorRole: HumanBone; boneName: string; expectedAncestorBoneName: string }>;
	tPose: {
		status: "valid" | "warning" | "unavailable";
		messages: string[];
	};
	errors: string[];
	warnings: string[];
}

const torso: IHumanBoneDefinition[] = [
	{ role: "hips", label: "Hips", required: true, parentRole: null, aliases: ["hips", "pelvis", "rootpelvis", "mixamorighips"] },
	{ role: "spine", label: "Spine", required: true, parentRole: "hips", aliases: ["spine", "spine1", "spine01", "lowerback"] },
	{ role: "chest", label: "Chest", required: false, parentRole: "spine", aliases: ["chest", "spine2", "spine02", "midspine"] },
	{ role: "upperChest", label: "Upper Chest", required: false, parentRole: "chest", aliases: ["upperchest", "spine3", "spine03", "thorax"] },
	{ role: "neck", label: "Neck", required: false, parentRole: "upperChest", aliases: ["neck", "neck1", "neck01"] },
	{ role: "head", label: "Head", required: true, parentRole: "neck", aliases: ["head", "head1", "head01"] },
	{ role: "leftEye", label: "Left Eye", required: false, parentRole: "head", aliases: ["lefteye", "eyeleft", "eyel", "l_eye"] },
	{ role: "rightEye", label: "Right Eye", required: false, parentRole: "head", aliases: ["righteye", "eyeright", "eyer", "r_eye"] },
	{ role: "jaw", label: "Jaw", required: false, parentRole: "head", aliases: ["jaw", "lowerjaw", "mandible"] },
];

function limb(side: "left" | "right"): IHumanBoneDefinition[] {
	const prefix = side === "left" ? "l" : "r";
	const opposite = side === "left" ? "right" : "left";
	const title = side === "left" ? "Left" : "Right";
	const definitions: IHumanBoneDefinition[] = [
		{
			role: `${side}Shoulder` as HumanBone,
			label: `${title} Shoulder`,
			required: false,
			parentRole: "upperChest",
			aliases: [`${side}shoulder`, `${side}clavicle`, `shoulder${prefix}`, `clavicle${prefix}`, `${prefix}shoulder`, `${prefix}clavicle`],
		},
		{
			role: `${side}UpperArm` as HumanBone,
			label: `${title} Upper Arm`,
			required: true,
			parentRole: `${side}Shoulder` as HumanBone,
			aliases: [`${side}upperarm`, `${side}arm`, `upperarm${prefix}`, `arm${prefix}`, `${prefix}upperarm`, `${prefix}arm`],
		},
		{
			role: `${side}LowerArm` as HumanBone,
			label: `${title} Lower Arm`,
			required: true,
			parentRole: `${side}UpperArm` as HumanBone,
			aliases: [`${side}lowerarm`, `${side}forearm`, `lowerarm${prefix}`, `forearm${prefix}`, `${prefix}lowerarm`, `${prefix}forearm`],
		},
		{
			role: `${side}Hand` as HumanBone,
			label: `${title} Hand`,
			required: true,
			parentRole: `${side}LowerArm` as HumanBone,
			aliases: [`${side}hand`, `hand${prefix}`, `${prefix}hand`, `${side}wrist`, `wrist${prefix}`],
		},
		{
			role: `${side}UpperLeg` as HumanBone,
			label: `${title} Upper Leg`,
			required: true,
			parentRole: "hips",
			aliases: [`${side}upperleg`, `${side}upleg`, `${side}thigh`, `upperleg${prefix}`, `thigh${prefix}`, `${prefix}thigh`],
		},
		{
			role: `${side}LowerLeg` as HumanBone,
			label: `${title} Lower Leg`,
			required: true,
			parentRole: `${side}UpperLeg` as HumanBone,
			aliases: [`${side}lowerleg`, `${side}leg`, `${side}calf`, `${side}shin`, `lowerleg${prefix}`, `calf${prefix}`, `${prefix}calf`],
		},
		{
			role: `${side}Foot` as HumanBone,
			label: `${title} Foot`,
			required: true,
			parentRole: `${side}LowerLeg` as HumanBone,
			aliases: [`${side}foot`, `foot${prefix}`, `${prefix}foot`, `${side}ankle`, `ankle${prefix}`],
		},
		{
			role: `${side}Toes` as HumanBone,
			label: `${title} Toes`,
			required: false,
			parentRole: `${side}Foot` as HumanBone,
			aliases: [`${side}toes`, `${side}toe`, `toes${prefix}`, `toe${prefix}`, `${prefix}toe`],
		},
	];
	return definitions.map((definition) => ({
		...definition,
		aliases: definition.aliases.filter((alias) => !alias.includes(opposite)),
	}));
}

function fingers(side: "left" | "right"): IHumanBoneDefinition[] {
	const title = side === "left" ? "Left" : "Right";
	const shortSide = side === "left" ? "l" : "r";
	const definitions: IHumanBoneDefinition[] = [];
	for (const finger of ["Thumb", "Index", "Middle", "Ring", "Little"] as const) {
		for (const [segment, number] of [
			["Proximal", "1"],
			["Intermediate", "2"],
			["Distal", "3"],
		] as const) {
			const role = `${side}${finger}${segment}` as HumanBone;
			const parentRole = segment === "Proximal" ? (`${side}Hand` as HumanBone) : (`${side}${finger}${segment === "Intermediate" ? "Proximal" : "Intermediate"}` as HumanBone);
			const fingerName = finger === "Little" ? "pinky" : finger.toLowerCase();
			definitions.push({
				role,
				label: `${title} ${finger} ${segment}`,
				required: false,
				parentRole,
				aliases: [
					`${side}${finger.toLowerCase()}${segment.toLowerCase()}`,
					`${side}${fingerName}${number}`,
					`${shortSide}${fingerName}${number}`,
					`${fingerName}${number}${shortSide}`,
					`${finger.toLowerCase()}${number}${shortSide}`,
				],
			});
		}
	}
	return definitions;
}

export const HUMAN_BONE_DEFINITIONS: readonly IHumanBoneDefinition[] = [...torso, ...limb("left"), ...limb("right"), ...fingers("left"), ...fingers("right")];
export const HUMAN_BONES: readonly HumanBone[] = HUMAN_BONE_DEFINITIONS.map((definition) => definition.role);
export const REQUIRED_HUMAN_BONES: readonly HumanBone[] = HUMAN_BONE_DEFINITIONS.filter((definition) => definition.required).map((definition) => definition.role);
export const HUMANOID_BODY_PARTS: readonly HumanoidBodyPart[] = ["root", "body", "head", "leftArm", "rightArm", "leftHand", "rightHand", "leftLeg", "rightLeg"];

export const HUMANOID_BODY_PART_ROLES: Readonly<Record<HumanoidBodyPart, readonly HumanBone[]>> = {
	root: ["hips"],
	body: ["hips", "spine", "chest", "upperChest"],
	head: ["neck", "head", "leftEye", "rightEye", "jaw"],
	leftArm: ["leftShoulder", "leftUpperArm", "leftLowerArm"],
	rightArm: ["rightShoulder", "rightUpperArm", "rightLowerArm"],
	leftHand: HUMAN_BONES.filter(
		(role) =>
			role === "leftHand" ||
			role.startsWith("leftThumb") ||
			role.startsWith("leftIndex") ||
			role.startsWith("leftMiddle") ||
			role.startsWith("leftRing") ||
			role.startsWith("leftLittle")
	),
	rightHand: HUMAN_BONES.filter(
		(role) =>
			role === "rightHand" ||
			role.startsWith("rightThumb") ||
			role.startsWith("rightIndex") ||
			role.startsWith("rightMiddle") ||
			role.startsWith("rightRing") ||
			role.startsWith("rightLittle")
	),
	leftLeg: ["leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes"],
	rightLeg: ["rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes"],
};

export function defaultHumanoidBodyParts(enabled = true): Record<HumanoidBodyPart, boolean> {
	return Object.fromEntries(HUMANOID_BODY_PARTS.map((part) => [part, enabled])) as Record<HumanoidBodyPart, boolean>;
}

export function normalizeHumanoidBodyParts(value: unknown, fallback = false): Record<HumanoidBodyPart, boolean> {
	const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	return Object.fromEntries(HUMANOID_BODY_PARTS.map((part) => [part, typeof source[part] === "boolean" ? source[part] : fallback])) as Record<HumanoidBodyPart, boolean>;
}

/** Resolves a reusable body-part Avatar Mask to concrete skeleton/animation target names. */
export function resolveHumanoidAvatarMaskTargetNames(avatar: Pick<IHumanoidAvatar, "mapping">, bodyPartsValue: unknown, transformNamesValue: unknown = []): string[] {
	const bodyParts = normalizeHumanoidBodyParts(bodyPartsValue);
	const names = new Set<string>();
	for (const part of HUMANOID_BODY_PARTS) {
		if (!bodyParts[part]) {
			continue;
		}
		for (const role of HUMANOID_BODY_PART_ROLES[part]) {
			const boneName = avatar.mapping[role];
			if (boneName) {
				names.add(boneName);
			}
		}
	}
	if (Array.isArray(transformNamesValue)) {
		for (const name of transformNamesValue) {
			if (typeof name === "string" && name.trim()) {
				names.add(name.trim().slice(0, 512));
			}
		}
	}
	return [...names].sort();
}

function finiteAngle(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(180, Math.max(-180, value)) : fallback;
}

export function normalizeHumanoidMuscleLimit(value: unknown): IHumanoidMuscleLimit {
	const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const minimum = Array.isArray(source.min) ? source.min : [];
	const maximum = Array.isArray(source.max) ? source.max : [];
	const min: [number, number, number] = [finiteAngle(minimum[0], -180), finiteAngle(minimum[1], -180), finiteAngle(minimum[2], -180)];
	const max: [number, number, number] = [finiteAngle(maximum[0], 180), finiteAngle(maximum[1], 180), finiteAngle(maximum[2], 180)];
	for (let index = 0; index < 3; index++) {
		if (min[index] > max[index]) {
			throw new Error(`Humanoid muscle minimum axis ${index} must be less than or equal to its maximum.`);
		}
	}
	return { min, max };
}

export function normalizeHumanoidMuscleLimits(value: unknown): Partial<Record<HumanBone, IHumanoidMuscleLimit>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const limits: Partial<Record<HumanBone, IHumanoidMuscleLimit>> = {};
	for (const role of HUMAN_BONES) {
		const limit = (value as Record<string, unknown>)[role];
		if (limit !== undefined && limit !== null) {
			limits[role] = normalizeHumanoidMuscleLimit(limit);
		}
	}
	return limits;
}

function finiteNormalizedMuscle(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
}

/** Normalizes one role's Unity-style muscle-space XYZ values to the inclusive -1..1 range. */
export function normalizeHumanoidMuscleValue(value: unknown): HumanoidMuscleValue {
	const source = Array.isArray(value) ? value : [];
	return [finiteNormalizedMuscle(source[0]), finiteNormalizedMuscle(source[1]), finiteNormalizedMuscle(source[2])];
}

/** Removes unknown roles and normalizes a bounded role-to-muscle-value map. */
export function normalizeHumanoidMusclePose(value: unknown): Partial<Record<HumanBone, HumanoidMuscleValue>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const pose: Partial<Record<HumanBone, HumanoidMuscleValue>> = {};
	for (const role of HUMAN_BONES) {
		const muscle = (value as Record<string, unknown>)[role];
		if (muscle !== undefined && muscle !== null) {
			pose[role] = normalizeHumanoidMuscleValue(muscle);
		}
	}
	return pose;
}

/** Converts a normalized -1..1 muscle axis to a local rotation delta in degrees relative to the Avatar rest pose. */
export function humanoidMuscleValueToDegrees(value: number, minimum: number, maximum: number): number {
	const normalized = finiteNormalizedMuscle(value);
	if (normalized < 0) {
		return normalized * Math.max(0, -minimum);
	}
	return normalized * Math.max(0, maximum);
}

/** Converts a local rotation delta in degrees to normalized Unity-style -1..1 muscle space. */
export function humanoidMuscleDegreesToValue(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value) || Math.abs(value) <= 1e-9) {
		return 0;
	}
	const range = value < 0 ? Math.max(0, -minimum) : Math.max(0, maximum);
	return range <= 1e-9 ? 0 : finiteNormalizedMuscle(value / range);
}

function normalizedName(value: string): string {
	return value
		.toLowerCase()
		.replace(/mixamorig|armature|skeleton|bip0*\d*|bone/g, "")
		.replace(/[^a-z0-9]/g, "");
}

function aliasScore(boneName: string, alias: string): number {
	const name = normalizedName(boneName);
	const normalizedAlias = normalizedName(alias);
	if (!name || !normalizedAlias) {
		return 0;
	}
	if (name === normalizedAlias) {
		return 1000 + normalizedAlias.length;
	}
	if (name.endsWith(normalizedAlias)) {
		return 800 + normalizedAlias.length;
	}
	if (name.startsWith(normalizedAlias)) {
		return 700 + normalizedAlias.length;
	}
	if (normalizedAlias.length >= 5 && name.includes(normalizedAlias)) {
		return 500 + normalizedAlias.length;
	}
	return 0;
}

/** Produces a deterministic one-bone-per-role humanoid mapping from common DCC, Mixamo, Unreal, and glTF bone names. */
export function autoMapHumanoidBones(bones: readonly IHumanoidBoneRecord[]): Partial<Record<HumanBone, string>> {
	const mapping: Partial<Record<HumanBone, string>> = {};
	const used = new Set<string>();
	for (const definition of HUMAN_BONE_DEFINITIONS) {
		let best: { name: string; score: number } | null = null;
		for (const bone of bones) {
			if (used.has(bone.name)) {
				continue;
			}
			const score = Math.max(...definition.aliases.map((alias) => aliasScore(bone.name, alias)));
			if (score > 0 && (!best || score > best.score || (score === best.score && bone.name.localeCompare(best.name) < 0))) {
				best = { name: bone.name, score };
			}
		}
		if (best) {
			mapping[definition.role] = best.name;
			used.add(best.name);
		}
	}
	return mapping;
}

/** Removes unknown roles, blank names, and excessive names from a persisted humanoid mapping. */
export function normalizeHumanoidMapping(value: unknown): Partial<Record<HumanBone, string>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const mapping: Partial<Record<HumanBone, string>> = {};
	for (const role of HUMAN_BONES) {
		const boneName = (value as Record<string, unknown>)[role];
		if (typeof boneName === "string" && boneName.trim()) {
			mapping[role] = boneName.trim().slice(0, 512);
		}
	}
	return mapping;
}

function isAncestor(ancestorName: string, childName: string, parents: Map<string, string | null>): boolean {
	let current = parents.get(childName) ?? null;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		if (current === ancestorName) {
			return true;
		}
		visited.add(current);
		current = parents.get(current) ?? null;
	}
	return false;
}

function nearestMappedCanonicalParent(role: HumanBone, mapping: Partial<Record<HumanBone, string>>): HumanBone | null {
	let definition = HUMAN_BONE_DEFINITIONS.find((candidate) => candidate.role === role);
	while (definition?.parentRole) {
		if (mapping[definition.parentRole]) {
			return definition.parentRole;
		}
		definition = HUMAN_BONE_DEFINITIONS.find((candidate) => candidate.role === definition!.parentRole);
	}
	return null;
}

function subtract(left: [number, number, number], right: [number, number, number]): [number, number, number] {
	return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left: [number, number, number], right: [number, number, number]): number {
	return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function length(value: [number, number, number]): number {
	return Math.hypot(value[0], value[1], value[2]);
}

function tPoseValidation(mapping: Partial<Record<HumanBone, string>>, bonesByName: Map<string, IHumanoidBoneRecord>): IHumanoidAvatarValidation["tPose"] {
	const requiredRoles: HumanBone[] = ["leftUpperArm", "leftHand", "rightUpperArm", "rightHand"];
	const records = requiredRoles.map((role) => bonesByName.get(mapping[role] ?? ""));
	if (records.some((record) => !record?.restPosition)) {
		return { status: "unavailable", messages: ["Rest-position data is unavailable for T-pose arm validation."] };
	}
	const [leftUpperArm, leftHand, rightUpperArm, rightHand] = records.map((record) => record!.restPosition!);
	const lateral = subtract(leftUpperArm, rightUpperArm);
	const lateralLength = length(lateral);
	if (lateralLength <= 1e-6) {
		return { status: "warning", messages: ["Left and right upper-arm rest positions overlap; a T-pose cannot be established."] };
	}
	const leftExtension = dot(subtract(leftHand, leftUpperArm), lateral) / lateralLength;
	const rightExtension = dot(subtract(rightHand, rightUpperArm), lateral) / lateralLength;
	const messages: string[] = [];
	if (leftExtension <= lateralLength * 0.2) {
		messages.push("The left arm does not extend outward far enough from the torso in the rest pose.");
	}
	if (rightExtension >= -lateralLength * 0.2) {
		messages.push("The right arm does not extend outward far enough from the torso in the rest pose.");
	}
	return { status: messages.length ? "warning" : "valid", messages };
}

/** Validates required roles, uniqueness, real bone names, canonical ancestry, and available T-pose evidence. */
export function validateHumanoidAvatar(animationType: HumanoidAnimationType, mappingValue: unknown, bones: readonly IHumanoidBoneRecord[]): IHumanoidAvatarValidation {
	const mapping = normalizeHumanoidMapping(mappingValue);
	const bonesByName = new Map(bones.map((bone) => [bone.name, bone]));
	const parents = new Map(bones.map((bone) => [bone.name, bone.parentName]));
	const mappedRoles = HUMAN_BONES.filter((role) => !!mapping[role]);
	const missingRequired = REQUIRED_HUMAN_BONES.filter((role) => !mapping[role]);
	const missingOptional = HUMAN_BONE_DEFINITIONS.filter((definition) => !definition.required && !mapping[definition.role]).map((definition) => definition.role);
	const unknownBones = mappedRoles.filter((role) => !bonesByName.has(mapping[role]!)).map((role) => ({ role, boneName: mapping[role]! }));
	const rolesByBone = new Map<string, HumanBone[]>();
	for (const role of mappedRoles) {
		const boneName = mapping[role]!;
		rolesByBone.set(boneName, [...(rolesByBone.get(boneName) ?? []), role]);
	}
	const duplicateBones = [...rolesByBone.entries()].filter(([, roles]) => roles.length > 1).map(([boneName, roles]) => ({ boneName, roles }));
	const hierarchyErrors: IHumanoidAvatarValidation["hierarchyErrors"] = [];
	for (const role of mappedRoles) {
		const boneName = mapping[role]!;
		if (!bonesByName.has(boneName)) {
			continue;
		}
		const expectedAncestorRole = nearestMappedCanonicalParent(role, mapping);
		if (!expectedAncestorRole) {
			continue;
		}
		const expectedAncestorBoneName = mapping[expectedAncestorRole]!;
		if (bonesByName.has(expectedAncestorBoneName) && !isAncestor(expectedAncestorBoneName, boneName, parents)) {
			hierarchyErrors.push({ role, expectedAncestorRole, boneName, expectedAncestorBoneName });
		}
	}
	const tPose = animationType === "humanoid" ? tPoseValidation(mapping, bonesByName) : { status: "unavailable" as const, messages: [] };
	const errors: string[] = [];
	if (animationType === "humanoid" && missingRequired.length) {
		errors.push(`Missing required humanoid roles: ${missingRequired.join(", ")}.`);
	}
	for (const item of unknownBones) {
		errors.push(`${item.role} references unknown bone "${item.boneName}".`);
	}
	for (const item of duplicateBones) {
		errors.push(`Bone "${item.boneName}" is assigned to multiple roles: ${item.roles.join(", ")}.`);
	}
	for (const item of hierarchyErrors) {
		errors.push(`${item.role} bone "${item.boneName}" must descend from ${item.expectedAncestorRole} bone "${item.expectedAncestorBoneName}".`);
	}
	const warnings = animationType === "humanoid" ? [...tPose.messages] : [];
	return {
		valid: animationType !== "humanoid" || errors.length === 0,
		animationType,
		mappedBoneCount: mappedRoles.length,
		requiredBoneCount: REQUIRED_HUMAN_BONES.length,
		requiredMappedBoneCount: REQUIRED_HUMAN_BONES.length - missingRequired.length,
		missingRequired,
		missingOptional,
		unknownBones,
		duplicateBones,
		hierarchyErrors,
		tPose,
		errors,
		warnings,
	};
}

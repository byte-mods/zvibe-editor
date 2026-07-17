import { describe, expect, test } from "vitest";

import {
	autoMapHumanoidBones,
	defaultHumanoidBodyParts,
	normalizeHumanoidMuscleLimit,
	REQUIRED_HUMAN_BONES,
	resolveHumanoidAvatarMaskTargetNames,
	validateHumanoidAvatar,
} from "../../src/assets/humanoid-avatar";

function mixamoBones() {
	return [
		{ name: "mixamorig:Hips", parentName: null, restPosition: [0, 0, 0] as [number, number, number] },
		{ name: "mixamorig:Spine", parentName: "mixamorig:Hips", restPosition: [0, 1, 0] as [number, number, number] },
		{ name: "mixamorig:Head", parentName: "mixamorig:Spine", restPosition: [0, 3, 0] as [number, number, number] },
		{ name: "mixamorig:LeftArm", parentName: "mixamorig:Spine", restPosition: [1, 2, 0] as [number, number, number] },
		{ name: "mixamorig:LeftForeArm", parentName: "mixamorig:LeftArm", restPosition: [2, 2, 0] as [number, number, number] },
		{ name: "mixamorig:LeftHand", parentName: "mixamorig:LeftForeArm", restPosition: [3, 2, 0] as [number, number, number] },
		{ name: "mixamorig:RightArm", parentName: "mixamorig:Spine", restPosition: [-1, 2, 0] as [number, number, number] },
		{ name: "mixamorig:RightForeArm", parentName: "mixamorig:RightArm", restPosition: [-2, 2, 0] as [number, number, number] },
		{ name: "mixamorig:RightHand", parentName: "mixamorig:RightForeArm", restPosition: [-3, 2, 0] as [number, number, number] },
		{ name: "mixamorig:LeftUpLeg", parentName: "mixamorig:Hips", restPosition: [0.5, -1, 0] as [number, number, number] },
		{ name: "mixamorig:LeftLeg", parentName: "mixamorig:LeftUpLeg", restPosition: [0.5, -2, 0] as [number, number, number] },
		{ name: "mixamorig:LeftFoot", parentName: "mixamorig:LeftLeg", restPosition: [0.5, -3, 0] as [number, number, number] },
		{ name: "mixamorig:RightUpLeg", parentName: "mixamorig:Hips", restPosition: [-0.5, -1, 0] as [number, number, number] },
		{ name: "mixamorig:RightLeg", parentName: "mixamorig:RightUpLeg", restPosition: [-0.5, -2, 0] as [number, number, number] },
		{ name: "mixamorig:RightFoot", parentName: "mixamorig:RightLeg", restPosition: [-0.5, -3, 0] as [number, number, number] },
	];
}

describe("humanoid avatar", () => {
	test("auto maps and validates a common Mixamo hierarchy", () => {
		const bones = mixamoBones();
		const mapping = autoMapHumanoidBones(bones);
		const validation = validateHumanoidAvatar("humanoid", mapping, bones);

		expect(REQUIRED_HUMAN_BONES).toHaveLength(15);
		expect(mapping).toMatchObject({
			hips: "mixamorig:Hips",
			leftUpperArm: "mixamorig:LeftArm",
			leftLowerArm: "mixamorig:LeftForeArm",
			rightUpperLeg: "mixamorig:RightUpLeg",
			rightFoot: "mixamorig:RightFoot",
		});
		expect(validation.valid).toBe(true);
		expect(validation.requiredMappedBoneCount).toBe(validation.requiredBoneCount);
		expect(validation.tPose).toEqual({ status: "valid", messages: [] });
	});

	test("reports duplicate, unknown, missing, and invalid-hierarchy mappings", () => {
		const bones = mixamoBones();
		const mapping = {
			...autoMapHumanoidBones(bones),
			leftHand: "mixamorig:RightHand",
			rightHand: "mixamorig:RightHand",
			head: "MissingHead",
			leftFoot: "mixamorig:LeftArm",
		};
		const validation = validateHumanoidAvatar("humanoid", mapping, bones);

		expect(validation.valid).toBe(false);
		expect(validation.unknownBones).toEqual([{ role: "head", boneName: "MissingHead" }]);
		expect(validation.duplicateBones).toEqual(expect.arrayContaining([expect.objectContaining({ boneName: "mixamorig:RightHand" })]));
		expect(validation.hierarchyErrors).toEqual(expect.arrayContaining([expect.objectContaining({ role: "leftFoot" })]));
	});

	test("allows incomplete mappings for Generic rigs while still reporting structural evidence", () => {
		const validation = validateHumanoidAvatar("generic", { hips: "Root" }, [{ name: "Root", parentName: null }]);
		expect(validation.valid).toBe(true);
		expect(validation.missingRequired.length).toBeGreaterThan(0);
		expect(validation.errors).toEqual([]);
	});

	test("resolves reusable body-part masks and validates bounded muscle limits", () => {
		const mapping = autoMapHumanoidBones(mixamoBones());
		const parts = defaultHumanoidBodyParts(false);
		parts.leftArm = true;
		parts.leftHand = true;
		const targets = resolveHumanoidAvatarMaskTargetNames({ mapping }, parts, ["Weapon"]);
		expect(targets).toEqual(expect.arrayContaining(["Weapon", "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand"]));
		expect(targets).not.toContain("mixamorig:RightArm");
		expect(normalizeHumanoidMuscleLimit({ min: [-30, -20, -10], max: [30, 20, 10] })).toEqual({
			min: [-30, -20, -10],
			max: [30, 20, 10],
		});
		expect(() => normalizeHumanoidMuscleLimit({ min: [20, 0, 0], max: [-20, 0, 0] })).toThrow("minimum axis 0");
	});
});

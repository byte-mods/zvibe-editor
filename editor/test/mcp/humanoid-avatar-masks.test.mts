import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, NullEngine, Scene, TransformNode } from "babylonjs";

import { createAnimatorController, setAnimatorLayer, setAnimatorLayerState, setAnimatorState, setAnimatorStateAvatarMask } from "../../src/mcp/animator/animator";
import { createHumanoidAvatarMask, deleteHumanoidAvatarMask, listHumanoidAvatarMasks, setHumanoidAvatarMask } from "../../src/mcp/rigging/avatar-masks";

describe("mcp/humanoid Avatar Masks", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: "hero-skeleton",
					animationType: "humanoid",
					source: "model",
					mapping: {
						spine: "HeroSpine",
						leftUpperArm: "HeroLeftUpperArm",
						leftLowerArm: "HeroLeftLowerArm",
						leftHand: "HeroLeftHand",
						leftUpperLeg: "HeroLeftUpperLeg",
					},
					restPose: {},
					humanScale: 1,
				},
			],
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	function createGroup(name: string): AnimationGroup {
		const group = new AnimationGroup(name, scene);
		for (const targetName of ["HeroLeftUpperArm", "HeroLeftLowerArm", "HeroLeftUpperLeg"]) {
			const target = new TransformNode(targetName, scene);
			const animation = new Animation(`${targetName} Rotation`, "rotation.y", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: 0 },
				{ frame: 30, value: 1 },
			]);
			group.addTargetedAnimation(animation, target);
		}
		return group;
	}

	test("creates, edits, resolves, and protects reusable body-part masks", () => {
		const mask = createHumanoidAvatarMask(
			scene,
			{ id: "upper-body", name: "Upper Body", avatarId: "hero-avatar", bodyParts: { leftArm: true }, transformNames: ["Weapon"] },
			options
		);
		expect(mask).toMatchObject({ id: "upper-body", enabledBodyParts: ["leftArm"], targetCount: 3 });
		expect(mask.targetNames).toEqual(expect.arrayContaining(["HeroLeftUpperArm", "HeroLeftLowerArm", "Weapon"]));

		const changed = setHumanoidAvatarMask(scene, { maskId: mask.id, bodyParts: { leftHand: true }, transformNames: [] }, options);
		expect(changed.enabledBodyParts).toEqual(["leftArm", "leftHand"]);
		expect(listHumanoidAvatarMasks(scene).masks).toHaveLength(1);

		scene.metadata.babylonEditorAnimatorControllers = [{ name: "Combat", states: [{ name: "Attack", avatarMaskId: mask.id }], layers: [] }];
		expect(() => deleteHumanoidAvatarMask(scene, { maskId: mask.id }, options)).toThrow("referenced");
		expect(deleteHumanoidAvatarMask(scene, { maskId: mask.id, force: true }, options)).toMatchObject({
			deleted: true,
			clearedReferences: ["Combat/state:Attack"],
		});
	});

	test("applies reusable Avatar Masks to base states and layer fallback in preview", () => {
		createGroup("Attack");
		createGroup("Aim");
		createHumanoidAvatarMask(scene, { id: "left-arm", name: "Left Arm", avatarId: "hero-avatar", bodyParts: { leftArm: true } }, options);
		const controller = createAnimatorController(
			scene,
			{
				name: "Masked Combat",
				states: [{ name: "Attack", animationGroup: "Attack", avatarMaskId: "left-arm" }],
				transitions: [],
				layers: [{ name: "Aim Layer", avatarMaskId: "left-arm", states: [{ name: "Aim", animationGroup: "Aim" }], transitions: [], activeState: "Aim" }],
			},
			options
		);

		setAnimatorState(scene, { controllerId: controller.id, state: "Attack" }, options);
		expect(scene.getAnimationGroupByName("Attack")?.mask?.retainsTarget("HeroLeftUpperArm")).toBe(true);
		expect(scene.getAnimationGroupByName("Attack")?.mask?.retainsTarget("HeroLeftUpperLeg")).toBe(false);
		setAnimatorStateAvatarMask(scene, { controllerId: controller.id, state: "Attack", avatarMaskId: null }, options);
		expect(scene.getAnimationGroupByName("Attack")?.mask).toBeNull();

		setAnimatorLayer(scene, { controllerId: controller.id, layer: "Aim Layer", avatarMaskId: "left-arm" }, options);
		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Aim Layer", state: "Aim" }, options);
		expect(scene.getAnimationGroupByName("Aim")?.mask?.retainsTarget("HeroLeftLowerArm")).toBe(true);
		expect(scene.getAnimationGroupByName("Aim")?.mask?.retainsTarget("HeroLeftUpperLeg")).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Animation, AnimationGroup, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";

import { AnimatorLayerAnimationGroups } from "../../src/loading/animator-layer-groups";
import { resolveAnimatorStatePlayback } from "../../src/loading/animator-graph";
import { ANIMATOR_ANY_STATE, ANIMATOR_EXIT_STATE, configureAnimators } from "../../src/loading/animator";
import { _registerScriptInstance } from "../../src/loading/script/apply";

describe("loading/animator", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		new AnimationGroup("Idle", scene);
		new AnimationGroup("Run", scene);
		new AnimationGroup("Sprint", scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("restores one-dimensional blend tree weights in exported runtime", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "locomotion",
					name: "Locomotion",
					parameters: { speed: 0 },
					states: [
						{
							name: "Blend",
							blendTree: {
								parameter: "speed",
								children: [
									{ animationGroup: "Idle", threshold: 0 },
									{ animationGroup: "Run", threshold: 1 },
								],
							},
						},
					],
					transitions: [],
					activeState: "Blend",
				},
			],
		};

		configureAnimators(scene);
		expect(scene.animators?.get("locomotion")?.setParameter("speed", 0.6)).toBe(false);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.4);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.6);
	});

	test("executes dynamic state speed, mirror, cycle-offset, and normalized-time parameters", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "dynamic-state-playback",
					name: "Dynamic State Playback",
					parameters: { rate: 0.5, mirrored: false, phase: 0.2, scrub: 0.75 },
					parameterTypes: { rate: "float", mirrored: "bool", phase: "float", scrub: "float" },
					states: [
						{
							name: "Idle",
							animationGroup: "Idle",
							speed: -2,
							speedParameter: "rate",
							mirrorParameter: "mirrored",
							cycleOffsetParameter: "phase",
							timeParameter: "scrub",
						},
					],
					transitions: [],
					activeState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("dynamic-state-playback")!;
		expect(animator.getDebugSnapshot().base).toMatchObject({
			effectiveSpeed: -1,
			cycleOffset: 0.2,
			mirror: false,
			timeDriven: true,
			time: 0.75,
			playbackBindings: { speed: "rate", mirror: "mirrored", cycleOffset: "phase", time: "scrub" },
		});
		expect(animator.setParameter("rate", 0)).toBe(false);
		expect(animator.setParameter("mirrored", true)).toBe(false);
		expect(animator.setParameter("phase", -0.25)).toBe(false);
		expect(animator.setParameter("scrub", 1.25)).toBe(false);
		expect(animator.getDebugSnapshot().base).toMatchObject({ effectiveSpeed: 0, cycleOffset: -0.25, mirror: true, time: 1.25, loopProgress: 0.25 });
	});

	test("executes Write Defaults property restoration in exported runtime", () => {
		const target = new TransformNode("WriteDefaultsTarget", scene);
		const moveAnimation = new Animation("Move X", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		moveAnimation.setKeys([
			{ frame: 0, value: 2 },
			{ frame: 30, value: 4 },
		]);
		const scaleAnimation = new Animation("Scale X", "scaling.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		scaleAnimation.setKeys([
			{ frame: 0, value: 5 },
			{ frame: 30, value: 6 },
		]);
		scene.getAnimationGroupByName("Idle")!.addTargetedAnimation(moveAnimation, target);
		scene.getAnimationGroupByName("Run")!.addTargetedAnimation(scaleAnimation, target);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "write-defaults",
					name: "Write Defaults",
					parameters: {},
					states: [
						{ name: "Scale", animationGroup: "Run" },
						{ name: "Move", animationGroup: "Idle", writeDefaultValues: true },
					],
					transitions: [],
					activeState: "Scale",
				},
			],
		};

		configureAnimators(scene);
		expect(target.scaling.x).toBe(5);
		const animator = scene.animators!.get("write-defaults")!;
		animator.play("Move");
		expect(target.scaling.x).toBe(1);
		expect(target.position.x).toBe(2);
		expect(animator.getDebugSnapshot().writeDefaults).toMatchObject({
			enabled: true,
			invocations: 1,
			resetCount: 1,
			lastResetProperties: ["WriteDefaultsTarget.scaling.x"],
		});
		target.scaling.x = 9;
		animator.update(1 / 60);
		expect(target.scaling.x).toBe(1);
		expect(animator.getDebugSnapshot().writeDefaults).toMatchObject({ invocations: 2, resetCount: 2 });
	});

	test("migrates imported playback bindings while allowing an explicit null override", () => {
		const imported = {
			name: "Imported",
			animationGroup: "Idle",
			speed: 2,
			unitySource: {
				fileId: "1102",
				serializedVersion: 6,
				footIKField: "m_IKOnFeet" as const,
				speedParameter: "rate",
				mirrorParameter: "mirror",
				cycleOffsetParameter: "phase",
				timeParameter: "time",
			},
		};
		expect(resolveAnimatorStatePlayback(imported, { rate: 0.5, mirror: true, phase: 0.2, time: 0.75 })).toMatchObject({
			effectiveSpeed: 1,
			mirror: true,
			cycleOffset: 0.2,
			time: 0.75,
		});
		expect(
			resolveAnimatorStatePlayback(
				{ ...imported, speedParameter: null, mirrorParameter: null, cycleOffsetParameter: null, timeParameter: null },
				{ rate: 0.5, mirror: true, phase: 0.2, time: 0.75 }
			)
		).toMatchObject({ effectiveSpeed: 2, mirror: false, cycleOffset: 0, time: null, timeDriven: false });
		expect(resolveAnimatorStatePlayback({ name: "Scrubbed", animationGroup: "Idle", cycleOffset: 0.4, timeParameter: "time" }, { time: 0.2 })).toMatchObject({
			cycleOffset: 0,
			time: 0.2,
			timeDriven: true,
		});
	});

	test("restores two-parameter 2D blend tree weights in exported runtime", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "locomotion-2d",
					name: "Locomotion 2D",
					parameters: { horizontal: 0, vertical: 0 },
					states: [
						{
							name: "Blend",
							blendTree: {
								parameterX: "horizontal",
								parameterY: "vertical",
								blendMode: "directional",
								children: [
									{ animationGroup: "Idle", position: [0, 0] },
									{ animationGroup: "Run", position: [1, 0] },
									{ animationGroup: "Sprint", position: [0, 1] },
								],
							},
						},
					],
					transitions: [],
					activeState: "Blend",
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("locomotion-2d")!;
		animator.setParameter("horizontal", 1);
		animator.setParameter("vertical", 1);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBe(0);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.5);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.5);
		animator.setParameter("horizontal", 0);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBe(0);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBe(0);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBe(1);
	});

	test("multiplies recursive 1D and 2D Blend Tree weights in exported runtime", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "nested-blend-tree",
					name: "Nested Blend Tree",
					parameters: { speed: 0.5, directionX: 0, directionY: 0 },
					states: [
						{
							name: "Locomotion",
							blendTree: {
								parameter: "speed",
								children: [
									{ animationGroup: "Idle", threshold: 0 },
									{
										threshold: 1,
										blendTree: {
											parameterX: "directionX",
											parameterY: "directionY",
											blendMode: "cartesian",
											children: [
												{ animationGroup: "Run", position: [-1, 0] },
												{ animationGroup: "Sprint", position: [1, 0] },
											],
										},
									},
								],
							},
						},
					],
					transitions: [],
					activeState: "Locomotion",
				},
			],
		};

		configureAnimators(scene);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.5);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.25);
		expect(
			scene.animators
				?.get("nested-blend-tree")
				?.getDebugSnapshot()
				.base.clips.map((clip: any) => clip.name)
		).toEqual(["Idle", "Run", "Sprint"]);
	});

	test("maps Direct Blend Tree parameters to child weights with optional normalization", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "direct-face",
					name: "Direct Face",
					parameters: { idleWeight: 1, runWeight: 3, sprintWeight: -1 },
					states: [
						{
							name: "Expression",
							blendTree: {
								blendMode: "direct",
								normalizeWeights: true,
								children: [
									{ animationGroup: "Idle", directParameter: "idleWeight" },
									{ animationGroup: "Run", directParameter: "runWeight" },
									{ animationGroup: "Sprint", directParameter: "sprintWeight" },
								],
							},
						},
					],
					transitions: [],
					activeState: "Expression",
				},
			],
		};

		configureAnimators(scene);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.75);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBe(0);
		const animator = scene.animators?.get("direct-face")!;
		animator.setParameter("idleWeight", 0.2);
		animator.setParameter("runWeight", 0.3);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.4);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.6);
		(scene.metadata.babylonEditorAnimatorControllers[0].states[0].blendTree as any).normalizeWeights = false;
		animator.setParameter("idleWeight", 0.25);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.3);
	});

	test("executes independent duplicate Blend Tree motions with time scale and cycle offset", () => {
		const target = new TransformNode("Motion Target", scene);
		const animation = new Animation("Run X", "position.x", 100, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 100, value: 100 },
		]);
		scene.getAnimationGroupByName("Run")!.addTargetedAnimation(animation, target);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "modified-motion",
					name: "Modified Motion",
					parameters: { blend: 0.25 },
					states: [
						{
							name: "Move",
							blendTree: {
								parameter: "blend",
								children: [
									{ animationGroup: "Run", threshold: 0 },
									{ animationGroup: "Run", threshold: 1, timeScale: -2, cycleOffset: 0.25 },
								],
							},
						},
					],
					transitions: [],
					activeState: "Move",
				},
			],
		};

		configureAnimators(scene);
		const clips = scene.animators?.get("modified-motion")?.getDebugSnapshot().base.clips;
		expect(clips).toHaveLength(2);
		expect(clips).toMatchObject([
			{ name: "Run", motionKey: "0", weight: 0.75, timeScale: 1, cycleOffset: 0, mirrored: false, internalLayerClone: true },
			{ name: "Run", motionKey: "1", weight: 0.25, timeScale: -2, cycleOffset: 0.25, mirrored: false, internalLayerClone: true, speedRatio: -2 },
		]);
		expect(clips[0].currentFrame).toBeCloseTo(0);
		expect(clips[1].currentFrame).toBeCloseTo(25);
		expect(scene.animationGroups.map((group) => group.name)).toEqual(["Idle", "Run", "Sprint"]);
	});

	test("mirrors humanoid Blend Tree motions onto the opposite mapped target without mutating the source", () => {
		const leftHand = new TransformNode("HeroLeftHand", scene);
		const rightHand = new TransformNode("HeroRightHand", scene);
		const source = scene.getAnimationGroupByName("Run")!;
		const animation = new Animation("Hand Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: new Vector3(1, 2, 3) },
			{ frame: 30, value: new Vector3(4, 5, 6) },
		]);
		source.addTargetedAnimation(animation, leftHand);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					id: "hero",
					animationType: "humanoid",
					mapping: { leftHand: leftHand.name, rightHand: rightHand.name },
				},
			],
		};
		const groups = new AnimatorLayerAnimationGroups(scene);

		const mirrored = groups.resolve(
			"controller:$base:Move",
			"Run",
			"override",
			{ normalizedTime: 0 },
			{
				key: "0",
				animationGroup: "Run",
				timeScale: 1,
				cycleOffset: 0,
				mirror: true,
			}
		)!;

		expect(mirrored).not.toBe(source);
		expect(mirrored.targetedAnimations[0].target).toBe(rightHand);
		expect(mirrored.targetedAnimations[0].animation.getKeys().map((key) => key.value)).toEqual([new Vector3(-1, 2, 3), new Vector3(-4, 5, 6)]);
		expect(source.targetedAnimations[0].target).toBe(leftHand);
		expect(source.targetedAnimations[0].animation.getKeys()[0].value).toEqual(new Vector3(1, 2, 3));
		expect(mirrored.metadata).toMatchObject({ babylonEditorInternalAnimatorMotion: true, motionKey: "0", mirrored: true });
		expect(scene.animationGroups).not.toContain(mirrored);
		groups.dispose();
	});

	test("executes static Unity-style state speed, cycle offset, mirror, loop, and tag settings", () => {
		const leftHand = new TransformNode("StaticLeftHand", scene);
		const rightHand = new TransformNode("StaticRightHand", scene);
		const source = scene.getAnimationGroupByName("Run")!;
		const animation = new Animation("Static Hand Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: new Vector3(1, 0, 0) },
			{ frame: 30, value: new Vector3(3, 0, 0) },
		]);
		source.addTargetedAnimation(animation, leftHand);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{ id: "static-avatar", name: "Static Avatar", animationType: "humanoid", mapping: { leftHand: leftHand.name, rightHand: rightHand.name } },
			],
			babylonEditorAnimatorControllers: [
				{
					id: "static-state-playback",
					name: "Static State Playback",
					parameters: {},
					states: [
						{
							name: "Reverse Mirrored",
							animationGroup: "Run",
							speed: -1.5,
							cycleOffset: 0.25,
							mirror: true,
							loop: false,
							tag: "Locomotion",
							footIK: true,
							writeDefaultValues: false,
						},
					],
					transitions: [],
					entryState: "Reverse Mirrored",
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("static-state-playback")!;
		const snapshot = animator.getDebugSnapshot().base;
		expect(snapshot).toMatchObject({
			activeState: "Reverse Mirrored",
			speed: -1.5,
			cycleOffset: 0.25,
			mirror: true,
			loop: false,
			tag: "Locomotion",
			footIK: true,
			writeDefaultValues: false,
			clips: [{ name: "Run", speedRatio: -1.5, cycleOffset: 0.25, mirrored: true, internalLayerClone: true, playbackFromFrame: 30, currentFrame: 7.5 }],
		});
		expect(snapshot.clips[0].targetedAnimationCount).toBeUndefined();
		animator.update(0.1);
		expect(animator.getDebugSnapshot().base.clips[0].currentFrame).toBeCloseTo(3);
		expect(animator.getDebugSnapshot().footIK.layers[0]).toMatchObject({ enabled: true, invocations: 1, failedFeet: 2, avatarId: null });
		expect(animator.getDebugSnapshot().footIK.layers[0].warnings[0]).toContain("Humanoid Avatar");
		expect(source.targetedAnimations[0].target).toBe(leftHand);
		expect(scene.animationGroups.map((group) => group.name)).toEqual(["Idle", "Run", "Sprint"]);
	});

	test("composes state-level cycle offset and mirror with Blend Tree child modifiers", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "composed-state-playback",
					name: "Composed State Playback",
					parameters: { blend: 0.25 },
					states: [
						{
							name: "Blend",
							cycleOffset: 0.25,
							mirror: true,
							blendTree: {
								parameter: "blend",
								children: [
									{ animationGroup: "Run", threshold: 0, cycleOffset: 0.1 },
									{ animationGroup: "Sprint", threshold: 1, cycleOffset: 0.2, mirror: true },
								],
							},
						},
					],
					transitions: [],
					entryState: "Blend",
				},
			],
		};

		configureAnimators(scene);
		const clips = scene.animators?.get("composed-state-playback")?.getDebugSnapshot().base.clips;
		expect(clips).toMatchObject([
			{ name: "Run", weight: 0.75, mirrored: true, internalLayerClone: true },
			{ name: "Sprint", weight: 0.25, mirrored: false, internalLayerClone: true },
		]);
		expect(clips[0].cycleOffset).toBeCloseTo(0.35);
		expect(clips[1].cycleOffset).toBeCloseTo(0.45);
	});

	test("restores Freeform Directional 2D blend weights using child direction and speed", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "freeform-locomotion",
					name: "Freeform Locomotion",
					parameters: { horizontal: 0, vertical: 0 },
					states: [
						{
							name: "Blend",
							blendTree: {
								parameterX: "horizontal",
								parameterY: "vertical",
								blendMode: "freeformDirectional",
								children: [
									{ animationGroup: "Idle", position: [0, 0] },
									{ animationGroup: "Run", position: [1, 0] },
									{ animationGroup: "Sprint", position: [0, 2] },
								],
							},
						},
					],
					transitions: [],
					activeState: "Blend",
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("freeform-locomotion")!;
		animator.setParameter("horizontal", 1);
		animator.setParameter("vertical", 2);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBe(0);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.216542, 5);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.783458, 5);
	});

	test("restores persisted animator target masks in exported runtime", () => {
		const arm = new TransformNode("Arm", scene);
		const animation = new Animation("Arm Rotation", "rotation.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 1, value: 1 },
		]);
		scene.getAnimationGroupByName("Idle")?.addTargetedAnimation(animation, arm);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "masked",
					name: "Masked",
					parameters: {},
					states: [{ name: "Idle", animationGroup: "Idle", maskTargetNames: ["Arm"] }],
					transitions: [],
					activeState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		expect(scene.getAnimationGroupByName("Idle")?.mask?.retainsTarget("Arm")).toBe(true);
	});

	test("resolves persisted humanoid body-part Avatar Masks in exported runtime", () => {
		const arm = new TransformNode("HeroLeftUpperArm", scene);
		const leg = new TransformNode("HeroLeftUpperLeg", scene);
		for (const target of [arm, leg]) {
			const animation = new Animation(`${target.name} Rotation`, "rotation.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: 0 },
				{ frame: 1, value: 1 },
			]);
			scene.getAnimationGroupByName("Idle")?.addTargetedAnimation(animation, target);
		}
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					id: "hero",
					animationType: "humanoid",
					mapping: { leftUpperArm: arm.name, leftUpperLeg: leg.name },
				},
			],
			babylonEditorHumanoidAvatarMasks: [
				{
					id: "left-arm",
					avatarId: "hero",
					bodyParts: { root: false, body: false, head: false, leftArm: true, rightArm: false, leftHand: false, rightHand: false, leftLeg: false, rightLeg: false },
					transformNames: [],
				},
			],
			babylonEditorAnimatorControllers: [
				{
					id: "humanoid-masked",
					name: "Humanoid Masked",
					parameters: {},
					states: [{ name: "Idle", animationGroup: "Idle", avatarMaskId: "left-arm" }],
					transitions: [],
					activeState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		expect(scene.getAnimationGroupByName("Idle")?.mask?.retainsTarget(arm.name)).toBe(true);
		expect(scene.getAnimationGroupByName("Idle")?.mask?.retainsTarget(leg.name)).toBe(false);
	});

	test("extracts root-motion source deltas onto a separate runtime target", () => {
		const source = new TransformNode("Animated Root", scene);
		const target = new TransformNode("Character", scene);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "root-motion",
					name: "Root Motion",
					parameters: {},
					states: [{ name: "Idle", animationGroup: "Idle" }],
					transitions: [],
					activeState: "Idle",
					rootMotion: { enabled: true, sourceNodeId: source.id, targetNodeId: target.id, applyPosition: true, applyRotationY: true },
				},
			],
		};

		configureAnimators(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		source.position.x = 25;
		source.rotation.y = 0.5;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(target.position.x).toBeCloseTo(25);
		expect(target.rotation.y).toBeCloseTo(0.5);
	});

	test("restores and transitions independent animator layers", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "layered",
					name: "Layered",
					parameters: { aiming: false },
					states: [{ name: "Idle", animationGroup: "Idle" }],
					transitions: [],
					activeState: "Idle",
					layers: [
						{
							name: "Upper",
							weight: 0.5,
							states: [
								{ name: "Relax", animationGroup: "Run" },
								{ name: "Aim", animationGroup: "Sprint" },
							],
							transitions: [{ from: "Relax", to: "Aim", conditions: [{ parameter: "aiming", equals: true }] }],
							activeState: "Relax",
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("layered");
		expect(animator?.setParameter("aiming", true)).toBe(true);
		expect((scene.metadata?.babylonEditorAnimatorControllers as any[])[0].layers[0].activeState).toBe("Aim");
	});

	test("executes Unity NotEqual conditions and normalized transition durations", () => {
		const target = new TransformNode("Animated", scene);
		const animation = new Animation("Idle Time", "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 120, value: 1 },
		]);
		scene.getAnimationGroupByName("Idle")?.addTargetedAnimation(animation, target);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "unity-transition-semantics",
					name: "Unity Transition Semantics",
					parameters: { mode: 2 },
					parameterTypes: { mode: "int" },
					states: [
						{ name: "Idle", animationGroup: "Idle" },
						{ name: "Run", animationGroup: "Run" },
					],
					transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "mode", notEquals: 2 }], duration: 0.25, durationMode: "normalized" }],
					entryState: "Idle",
					activeState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("unity-transition-semantics")!;
		expect(animator.setParameter("mode", 2)).toBe(false);
		expect(animator.setParameter("mode", 1)).toBe(true);
		expect(animator.getDebugSnapshot().base.transition).toMatchObject({ durationSeconds: 0.5, to: "Run" });
	});

	test("starts from Entry and evaluates Any State and Exit nodes in exported runtime", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "special-nodes",
					name: "Special Nodes",
					parameters: { panic: false, done: false, layerPanic: false, layerDone: false },
					states: [
						{ name: "Idle", animationGroup: "Idle" },
						{ name: "Run", animationGroup: "Run" },
						{ name: "Sprint", animationGroup: "Sprint" },
					],
					entryState: "Run",
					activeState: "Idle",
					transitions: [
						{ from: ANIMATOR_ANY_STATE, to: "Sprint", conditions: [{ parameter: "panic", equals: true }] },
						{ from: "Sprint", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "done", equals: true }], duration: 0.5 },
					],
					layers: [
						{
							name: "Upper",
							states: [
								{ name: "Relax", animationGroup: "Run" },
								{ name: "Aim", animationGroup: "Idle" },
							],
							entryState: "Aim",
							activeState: "Relax",
							transitions: [
								{ from: ANIMATOR_ANY_STATE, to: "Relax", conditions: [{ parameter: "layerPanic", equals: true }] },
								{ from: "Relax", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "layerDone", equals: true }] },
							],
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const controller = (scene.metadata.babylonEditorAnimatorControllers as any[])[0];
		const animator = scene.animators?.get("special-nodes")!;
		expect(controller.activeState).toBe("Run");
		expect(controller.layers[0].activeState).toBe("Aim");
		expect(animator.getDebugSnapshot(true)).toMatchObject({
			controllerId: "special-nodes",
			base: { entryState: "Run", activeState: "Run", exited: false },
			layers: [{ name: "Upper", entryState: "Aim", activeState: "Aim", exited: false }],
		});

		expect(animator.setParameter("panic", true)).toBe(true);
		expect(controller.activeState).toBe("Sprint");
		animator.setParameter("panic", false);
		expect(animator.setParameter("done", true)).toBe(true);
		expect(controller.activeState).toBeUndefined();
		animator.update(0.25);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.5);
		expect(animator.getDebugSnapshot().base.transition).toMatchObject({
			from: "Sprint",
			to: ANIMATOR_EXIT_STATE,
			progress: 0.5,
			fromWeight: 0.5,
			toWeight: 0,
		});
		animator.update(0.25);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0);
		expect(animator.getDebugSnapshot().base).toMatchObject({ activeState: null, exited: true, transition: null });

		expect(animator.setParameter("layerPanic", true)).toBe(true);
		expect(controller.layers[0].activeState).toBe("Relax");
		animator.setParameter("layerPanic", false);
		expect(animator.setParameter("layerDone", true)).toBe(true);
		expect(controller.layers[0].activeState).toBeUndefined();

		animator.playEntry();
		animator.playEntry("Upper");
		expect(controller.activeState).toBe("Run");
		expect(controller.layers[0].activeState).toBe("Aim");
	});

	test("evaluates ordered conditional Entry routes and child-state-machine source transitions", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "conditional-entry-runtime",
					name: "Conditional Entry Runtime",
					parameters: { enterGround: true, fast: true, done: false },
					parameterTypes: { enterGround: "bool", fast: "bool", done: "trigger" },
					states: [{ name: "Idle", animationGroup: "Idle" }],
					subgraphs: [
						{
							id: "locomotion",
							name: "Locomotion",
							states: [
								{ name: "Walk", animationGroup: "Run" },
								{ name: "Run", animationGroup: "Sprint" },
							],
							entryState: "Walk",
							entryTransitions: [{ to: "Run", conditions: [{ parameter: "fast", equals: true }] }],
							transitions: [{ from: "Run", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "done", equals: true }] }],
						},
					],
					subStateMachines: [{ name: "Ground", subgraphId: "locomotion" }],
					entryState: "Idle",
					entryTransitions: [{ to: "Ground", conditions: [{ parameter: "enterGround", equals: true }] }],
					transitions: [{ from: "Ground", to: "Idle" }],
				},
			],
		};

		configureAnimators(scene);
		const controller = (scene.metadata.babylonEditorAnimatorControllers as any[])[0];
		const animator = scene.animators?.get("conditional-entry-runtime")!;
		expect(controller.activeState).toBe("Ground/Run");
		expect(animator.getDebugSnapshot().base).toMatchObject({ activeState: "Ground/Run", activeMachinePath: ["Ground"] });

		expect(animator.setTrigger("done")).toBe(true);
		expect(controller.activeState).toBe("Idle");
		expect(controller.parameters.done).toBe(false);

		animator.setParameter("fast", false);
		animator.playEntry();
		expect(controller.activeState).toBe("Ground/Walk");

		animator.setParameter("enterGround", false);
		animator.playEntry();
		expect(controller.activeState).toBe("Idle");
	});

	test("validates typed parameters and consumes runtime triggers only when transitions use them", () => {
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "typed-runtime",
					name: "Typed Runtime",
					parameters: { jump: false, unused: false, count: 0 },
					parameterTypes: { jump: "trigger", unused: "trigger", count: "int" },
					states: [
						{ name: "Idle", animationGroup: "Idle" },
						{ name: "Run", animationGroup: "Run" },
					],
					transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "jump", equals: true }] }],
					entryState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		const controller = (scene.metadata.babylonEditorAnimatorControllers as any[])[0];
		const animator = scene.animators?.get("typed-runtime")!;
		expect(animator.setTrigger("jump")).toBe(true);
		expect(controller).toMatchObject({ activeState: "Run", parameters: { jump: false } });
		expect(animator.setTrigger("unused")).toBe(false);
		expect(controller.parameters.unused).toBe(true);
		animator.resetTrigger("unused");
		expect(controller.parameters.unused).toBe(false);
		expect(() => animator.setParameter("count", 1.5)).toThrow("safe integer");
		expect(animator.getDebugSnapshot().parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "count", type: "int", runtimeType: "number", value: 0 }),
				expect.objectContaining({ name: "jump", type: "trigger", runtimeType: "boolean", value: false }),
			])
		);
	});

	test("transitions automatically when a normalized exit time is reached", () => {
		const node = new TransformNode("Animated", scene);
		const animation = new Animation("Idle Rotation", "rotation.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 60, value: 1 },
		]);
		scene.getAnimationGroupByName("Idle")?.addTargetedAnimation(animation, node);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "exit-time",
					name: "Exit Time",
					parameters: {},
					states: [
						{ name: "Idle", animationGroup: "Idle", loop: false },
						{ name: "Run", animationGroup: "Run" },
					],
					transitions: [{ from: "Idle", to: "Run", exitTime: 0.5 }],
					activeState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("exit-time")!;
		expect(animator.update(0.49)).toBe(false);
		expect(animator.update(0.02)).toBe(true);
		expect((scene.metadata?.babylonEditorAnimatorControllers as any[])[0].activeState).toBe("Run");
	});

	test("cross-fades base and independent layer transitions over their configured durations", () => {
		new AnimationGroup("Aim", scene);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "cross-fade",
					name: "Cross Fade",
					parameters: { moving: false, aiming: false },
					states: [
						{ name: "Idle", animationGroup: "Idle" },
						{ name: "Run", animationGroup: "Run" },
					],
					transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "moving", equals: true }], duration: 0.5 }],
					activeState: "Idle",
					layers: [
						{
							name: "Upper",
							weight: 0.5,
							states: [
								{ name: "Relax", animationGroup: "Sprint" },
								{ name: "Aim", animationGroup: "Aim" },
							],
							transitions: [{ from: "Relax", to: "Aim", conditions: [{ parameter: "aiming", equals: true }], duration: 0.5 }],
							activeState: "Relax",
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("cross-fade")!;
		animator.setParameter("moving", true);
		animator.setParameter("aiming", true);
		animator.update(0.25);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.5);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Aim")?.weight).toBeCloseTo(0.25);
		animator.update(0.25);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(1);
		expect(scene.getAnimationGroupByName("Aim")?.weight).toBeCloseTo(0.5);
	});

	test("applies destination offsets, ordered interruption priority, and self-transition controls", () => {
		const animated = new TransformNode("Animated", scene);
		for (const groupName of ["Run", "Sprint"]) {
			const animation = new Animation(`${groupName} Position`, "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: 0 },
				{ frame: 60, value: 1 },
			]);
			scene.getAnimationGroupByName(groupName)?.addTargetedAnimation(animation, animated);
		}
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "interruptible",
					name: "Interruptible",
					parameters: { moving: false, cancel: false, sprint: false, restart: false },
					states: [
						{ name: "Idle", animationGroup: "Idle" },
						{ name: "Run", animationGroup: "Run" },
						{ name: "Sprint", animationGroup: "Sprint" },
					],
					transitions: [
						{ from: "Run", to: "Idle", conditions: [{ parameter: "cancel", equals: true }] },
						{
							from: "Idle",
							to: "Run",
							conditions: [{ parameter: "moving", equals: true }],
							duration: 1,
							offset: 0.25,
							interruptionSource: "destination",
							orderedInterruption: true,
						},
						{ from: "Run", to: "Sprint", conditions: [{ parameter: "sprint", equals: true }], duration: 1 },
						{ from: ANIMATOR_ANY_STATE, to: "Sprint", conditions: [{ parameter: "restart", equals: true }], offset: 0.5 },
					],
					entryState: "Idle",
				},
			],
		};

		configureAnimators(scene);
		const controller = (scene.metadata.babylonEditorAnimatorControllers as any[])[0];
		const animator = scene.animators?.get("interruptible")!;
		expect(animator.setParameter("moving", true)).toBe(true);
		expect(animator.getDebugSnapshot().base).toMatchObject({
			activeState: "Run",
			normalizedTime: 0.25,
			transition: { from: "Idle", to: "Run", offset: 0.25, interruptionSource: "destination", orderedInterruption: true },
		});
		expect(animator.setParameter("sprint", true)).toBe(false);
		expect(controller.activeState).toBe("Run");

		controller.transitions[1].orderedInterruption = false;
		animator.setParameter("sprint", false);
		expect(animator.setParameter("sprint", true)).toBe(true);
		expect(animator.getDebugSnapshot().base.transition).toMatchObject({
			from: "Run",
			to: "Sprint",
			interrupted: true,
			interruptionSource: "none",
		});
		animator.update(0.5);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.5);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.5);

		animator.play("Sprint");
		expect(animator.setParameter("restart", true)).toBe(false);
		controller.transitions[3].canTransitionToSelf = true;
		animator.setParameter("restart", false);
		expect(animator.setParameter("restart", true)).toBe(true);
		expect(animator.getDebugSnapshot().base).toMatchObject({ activeState: "Sprint", normalizedTime: 0.5, transition: null });
	});

	test("interrupts layer cross-fades from their destination while preserving blended weights", () => {
		new AnimationGroup("Aim", scene);
		const animated = new TransformNode("Layer Animated", scene);
		for (const groupName of ["Sprint", "Aim"]) {
			const animation = new Animation(`${groupName} Layer Position`, "position.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: 0 },
				{ frame: 60, value: 1 },
			]);
			scene.getAnimationGroupByName(groupName)?.addTargetedAnimation(animation, animated);
		}
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "layer-interruption",
					name: "Layer Interruption",
					parameters: { layerMoving: false, layerCancel: false, layerInterrupt: false },
					states: [{ name: "Base", animationGroup: "Idle" }],
					transitions: [],
					layers: [
						{
							name: "Upper",
							weight: 0.5,
							states: [
								{ name: "Relax", animationGroup: "Run" },
								{ name: "Aim", animationGroup: "Sprint" },
								{ name: "Fire", animationGroup: "Aim" },
							],
							transitions: [
								{ from: "Aim", to: "Relax", conditions: [{ parameter: "layerCancel", equals: true }] },
								{
									from: "Relax",
									to: "Aim",
									conditions: [{ parameter: "layerMoving", equals: true }],
									duration: 1,
									offset: 0.2,
									interruptionSource: "destination",
								},
								{ from: "Aim", to: "Fire", conditions: [{ parameter: "layerInterrupt", equals: true }], duration: 1 },
							],
							entryState: "Relax",
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("layer-interruption")!;
		expect(animator.setParameter("layerMoving", true)).toBe(true);
		expect(animator.getDebugSnapshot().layers[0]).toMatchObject({
			activeState: "Aim",
			normalizedTime: 0.2,
			transition: { from: "Relax", to: "Aim", offset: 0.2, interruptionSource: "destination" },
		});
		expect(animator.setParameter("layerInterrupt", true)).toBe(true);
		expect(animator.getDebugSnapshot().layers[0].transition).toMatchObject({ from: "Aim", to: "Fire", interrupted: true });
		animator.update(0.5);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Aim")?.weight).toBeCloseTo(0.25);
	});

	test("executes reusable nested sub-state machines, Entry routing, Exit routing, and repeated instances", () => {
		new AnimationGroup("Aim", scene);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "nested-runtime",
					name: "Nested Runtime",
					parameters: { moving: false, done: false, allowExit: false, useOther: false, aiming: false, layerDone: false },
					states: [{ name: "Idle", animationGroup: "Idle" }],
					subgraphs: [
						{
							id: "locomotion",
							name: "Locomotion",
							states: [
								{ name: "Walk", animationGroup: "Run" },
								{ name: "Run", animationGroup: "Sprint" },
							],
							entryState: "Walk",
							transitions: [
								{ from: "Walk", to: "Run", conditions: [{ parameter: "moving", equals: true }] },
								{ from: "Run", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "done", equals: true }] },
							],
						},
						{
							id: "combat",
							name: "Combat",
							states: [
								{ name: "Relax", animationGroup: "Run" },
								{ name: "Aim", animationGroup: "Aim" },
							],
							entryState: "Relax",
							transitions: [
								{ from: "Relax", to: "Aim", conditions: [{ parameter: "aiming", equals: true }] },
								{ from: "Aim", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "layerDone", equals: true }] },
							],
						},
					],
					subStateMachines: [
						{ name: "Ground", subgraphId: "locomotion" },
						{ name: "Other", subgraphId: "locomotion" },
					],
					entryState: "Ground",
					transitions: [
						{ from: "Ground", to: "Idle", conditions: [{ parameter: "allowExit", equals: true }] },
						{ from: "Idle", to: "Other", conditions: [{ parameter: "useOther", equals: true }] },
					],
					layers: [
						{
							name: "Upper",
							weight: 0.5,
							states: [{ name: "Empty", animationGroup: "Idle" }],
							subStateMachines: [{ name: "Combat", subgraphId: "combat" }],
							entryState: "Combat",
							transitions: [{ from: "Combat", to: "Empty" }],
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const controller = (scene.metadata.babylonEditorAnimatorControllers as any[])[0];
		const animator = scene.animators?.get("nested-runtime")!;
		expect(controller).toMatchObject({ activeState: "Ground/Walk", layers: [{ activeState: "Combat/Relax" }] });
		expect(animator.getDebugSnapshot()).toMatchObject({
			base: { entryState: "Ground/Walk", activeState: "Ground/Walk", activeMachinePath: ["Ground"], activeSubgraphId: "locomotion" },
			layers: [{ entryState: "Combat/Relax", activeState: "Combat/Relax", activeMachinePath: ["Combat"], activeSubgraphId: "combat" }],
		});

		expect(animator.setParameter("moving", true)).toBe(true);
		expect(controller.activeState).toBe("Ground/Run");
		expect(animator.setParameter("allowExit", true)).toBe(false);
		expect(controller.activeState).toBe("Ground/Run");
		expect(animator.setParameter("done", true)).toBe(true);
		expect(controller.activeState).toBe("Idle");

		expect(animator.setParameter("useOther", true)).toBe(true);
		expect(controller.activeState).toBe("Other/Walk");
		expect(animator.setParameter("aiming", true)).toBe(true);
		expect(controller.layers[0].activeState).toBe("Combat/Aim");
		expect(animator.setParameter("layerDone", true)).toBe(true);
		expect(controller.layers[0].activeState).toBe("Empty");
	});

	test("creates non-serialized additive layer clips relative to the configured reference pose", () => {
		const target = new TransformNode("Additive Target", scene);
		const source = scene.getAnimationGroupByName("Run")!;
		const animation = new Animation("Additive X", "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 10 },
			{ frame: 30, value: 12 },
			{ frame: 60, value: 14 },
		]);
		source.addTargetedAnimation(animation, target);
		const groups = new AnimatorLayerAnimationGroups(scene);

		const additive = groups.resolve("controller:Upper", "Run", "additive", { normalizedTime: 0.5 })!;
		const values = additive.targetedAnimations[0].animation.getKeys().map((key) => key.value);

		expect(additive).not.toBe(source);
		expect(additive.isAdditive).toBe(true);
		expect(source.isAdditive).toBe(false);
		expect(values).toEqual([-2, 0, 2]);
		expect(additive.metadata).toMatchObject({
			babylonEditorInternalAnimatorLayer: true,
			sourceAnimationGroup: "Run",
			referenceNormalizedTime: 0.5,
		});
		expect(scene.animationGroups).not.toContain(additive);
		expect(groups.resolve("controller:Upper", "Run", "additive", { normalizedTime: 0.5 })).toBe(additive);

		groups.dispose();
	});

	test("synchronizes layer states and normalized time while preserving additive source clips", () => {
		const target = new TransformNode("Synchronized Target", scene);
		new AnimationGroup("Aim", scene);
		for (const [index, groupName] of ["Idle", "Run", "Sprint", "Aim"].entries()) {
			const animation = new Animation(`${groupName} X`, "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			const endFrame = groupName === "Sprint" ? 120 : 60;
			animation.setKeys([
				{ frame: 0, value: index },
				{ frame: endFrame, value: index + 1 },
			]);
			scene.getAnimationGroupByName(groupName)!.addTargetedAnimation(animation, target);
		}
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "synchronized-runtime",
					name: "Synchronized Runtime",
					parameters: { moving: false },
					states: [
						{ name: "Idle", animationGroup: "Idle" },
						{ name: "Run", animationGroup: "Run" },
					],
					transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "moving", equals: true }] }],
					entryState: "Idle",
					layers: [
						{
							name: "Upper",
							weight: 0.75,
							blendingMode: "additive",
							referencePose: { normalizedTime: 0.5 },
							synchronizedLayer: "$base",
							synchronizedTiming: true,
							synchronizedStateMap: { Idle: "Relax", Run: "Aim" },
							states: [
								{ name: "Relax", animationGroup: "Sprint" },
								{ name: "Aim", animationGroup: "Aim" },
							],
							transitions: [],
							entryState: "Relax",
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const controller = (scene.metadata.babylonEditorAnimatorControllers as any[])[0];
		const animator = scene.animators?.get("synchronized-runtime")!;
		animator.update(0.25);
		let snapshot = animator.getDebugSnapshot();
		expect(snapshot.base).toMatchObject({ durationSeconds: 1.75, normalizedTime: 1 / 7 });
		expect(snapshot.layers[0]).toMatchObject({
			activeState: "Relax",
			blendingMode: "additive",
			referencePose: { normalizedTime: 0.5 },
			synchronizedLayer: "$base",
			synchronizedTiming: true,
			normalizedTime: snapshot.base.normalizedTime,
			clips: [{ name: "Sprint", additive: true, internalLayerClone: true }],
		});
		expect(scene.getAnimationGroupByName("Sprint")?.isAdditive).toBe(false);
		expect(scene.animationGroups.some((group) => group.name.startsWith("__babylonEditorAnimatorAdditive:"))).toBe(false);

		controller.layers[0].synchronizedTiming = false;
		animator.update(0.25);
		snapshot = animator.getDebugSnapshot();
		expect(snapshot.base).toMatchObject({ durationSeconds: 1, normalizedTime: 0.5 });
		expect(snapshot.layers[0]).toMatchObject({ durationSeconds: 2, normalizedTime: 0.5, synchronizedTiming: false });

		expect(animator.setParameter("moving", true)).toBe(true);
		snapshot = animator.getDebugSnapshot();
		expect(snapshot).toMatchObject({ base: { activeState: "Run" }, layers: [{ activeState: "Aim" }] });
		expect(() => animator.playLayer("Upper", "Relax")).toThrow("cannot be played independently");
	});

	test("invokes bounded StateMachineBehaviour-style callbacks in exported runtime", () => {
		const target = new TransformNode("Character", scene);
		const events: string[] = [];
		_registerScriptInstance(
			target,
			{
				onAnimatorStateEnter: (_object, info) => events.push(`${info.phase}:${info.stateName}:${info.layerName ?? "base"}`),
				onAnimatorStateUpdate: (_object, info) => events.push(`${info.phase}:${info.stateName}:${info.layerName ?? "base"}`),
				onAnimatorStateExit: (_object, info) => events.push(`${info.phase}:${info.stateName}:${info.layerName ?? "base"}`),
				onAnimatorStateMachineEnter: (_object, info) => events.push(`${info.phase}:${info.machinePath.join("/") || "$root"}:${info.layerName ?? "base"}`),
				onAnimatorStateMachineExit: (_object, info) => events.push(`${info.phase}:${info.machinePath.join("/") || "$root"}:${info.layerName ?? "base"}`),
			},
			"src/character-state.ts",
			{}
		);
		_registerScriptInstance(
			target,
			{
				onAnimatorStateEnter: (_object, info) => events.push(`override-${info.phase}:${info.stateName}:${info.layerName ?? "base"}`),
				onAnimatorStateUpdate: (_object, info) => events.push(`override-${info.phase}:${info.stateName}:${info.layerName ?? "base"}`),
				onAnimatorStateExit: (_object, info) => events.push(`override-${info.phase}:${info.stateName}:${info.layerName ?? "base"}`),
			},
			"src/override-state.ts",
			{}
		);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "state-behaviour-runtime",
					name: "State Behaviour Runtime",
					targetNodeId: target.id,
					behaviours: [{ id: "root-machine-behaviour", scriptKey: "src/character-state.ts" }],
					parameters: { moving: false, done: false },
					states: [
						{
							name: "Idle",
							animationGroup: "Idle",
							behaviours: [
								{ id: "idle-behaviour", scriptKey: "src/character-state.ts" },
								{ id: "disabled-idle-behaviour", scriptKey: "src/character-state.ts", enabled: false },
							],
						},
						{ name: "Run", animationGroup: "Run", behaviours: [{ id: "run-behaviour", scriptKey: "src/character-state.ts" }] },
					],
					transitions: [
						{ from: "Idle", to: "Run", conditions: [{ parameter: "moving", equals: true }] },
						{ from: "Run", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "done", equals: true }] },
					],
					entryState: "Idle",
					layers: [
						{
							name: "Upper",
							synchronizedLayer: "$base",
							synchronizedStateMap: { Idle: "UpperIdle", Run: "UpperRun" },
							synchronizedMotionOverrides: { Run: { animationGroup: "Idle" } },
							synchronizedBehaviourOverrides: {
								Idle: [],
								Run: [{ id: "override-run-behaviour", scriptKey: "src/override-state.ts" }],
							},
							states: [
								{ name: "UpperIdle", animationGroup: "Sprint", behaviours: [{ id: "upper-idle-behaviour", scriptKey: "src/character-state.ts" }] },
								{ name: "UpperRun", animationGroup: "Sprint", behaviours: [{ id: "upper-run-behaviour", scriptKey: "src/character-state.ts" }] },
							],
							transitions: [],
							entryState: "UpperIdle",
						},
					],
				},
			],
		};

		configureAnimators(scene);
		const animator = scene.animators?.get("state-behaviour-runtime")!;
		animator.update(0.1);
		expect(animator.setParameter("moving", true)).toBe(true);
		animator.update(0.1);
		expect(animator.getDebugSnapshot().layers[0]).toMatchObject({
			synchronizedMotionOverrides: { Run: { animationGroup: "Idle" } },
			synchronizedBehaviourOverrides: { Idle: [], Run: [{ scriptKey: "src/override-state.ts" }] },
			clips: [{ name: "Idle" }],
		});
		expect(animator.setParameter("done", true)).toBe(true);
		animator.update(0);

		expect(events).toEqual([
			"machineEnter:$root:base",
			"enter:Idle:base",
			"update:Idle:base",
			"exit:Idle:base",
			"enter:Run:base",
			"override-enter:UpperRun:Upper",
			"update:Run:base",
			"override-update:UpperRun:Upper",
			"exit:Run:base",
			"machineExit:$root:base",
			"override-exit:UpperRun:Upper",
		]);
		expect(animator.getDebugSnapshot().stateBehaviours).toMatchObject({
			enterCalls: 3,
			updateCalls: 3,
			exitCalls: 3,
			machineEnterCalls: 1,
			machineExitCalls: 1,
			errorCount: 0,
			missingScripts: 0,
		});
	});

	test("executes Base Layer and additional-layer IK Pass callbacks before existing rig observers", () => {
		const target = new TransformNode("IK Character", scene);
		const events: string[] = [];
		let rigObservedX = 0;
		scene.onBeforeRenderObservable.add(() => {
			rigObservedX = target.position.x;
		});
		_registerScriptInstance(
			target,
			{
				onAnimatorIK: (_object, info) => {
					events.push(`${info.layerName}:${info.stateName}:${info.layerWeight}`);
					target.position.x = info.layerName === "$base" ? 1 : 2;
				},
			},
			"src/character-ik.ts",
			{}
		);
		_registerScriptInstance(
			target,
			{
				onAnimatorIK: () => {
					throw new Error("IK callback failure");
				},
			},
			"src/failing-ik.ts",
			{}
		);
		scene.metadata = {
			babylonEditorAnimatorControllers: [
				{
					id: "ik-pass-runtime",
					name: "IK Pass Runtime",
					targetNodeId: target.id,
					baseIKPass: true,
					parameters: {},
					states: [{ name: "Idle", animationGroup: "Idle" }],
					transitions: [],
					entryState: "Idle",
					layers: [
						{ name: "Upper", weight: 0.75, ikPass: true, states: [{ name: "Aim", animationGroup: "Run" }], transitions: [], entryState: "Aim" },
						{ name: "Disabled", ikPass: false, states: [{ name: "Pose", animationGroup: "Sprint" }], transitions: [], entryState: "Pose" },
					],
				},
			],
		};

		configureAnimators(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(events).toEqual(["$base:Idle:1", "Upper:Aim:0.75"]);
		expect(rigObservedX).toBe(2);
		expect(scene.animators?.get("ik-pass-runtime")?.getDebugSnapshot()).toMatchObject({
			layers: [
				{ name: "Upper", ikPass: true },
				{ name: "Disabled", ikPass: false },
			],
			ikPasses: {
				layers: [
					{ layerName: "$base", enabled: true, invocations: 1, callbackCalls: 1, errorCount: 1 },
					{ layerName: "Disabled", enabled: false, invocations: 0 },
					{ layerName: "Upper", enabled: true, invocations: 1, callbackCalls: 1, errorCount: 1 },
				],
			},
		});
	});
});

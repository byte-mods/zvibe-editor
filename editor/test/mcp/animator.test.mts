import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, Bone, Matrix, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3 } from "babylonjs";
import { _registerScriptInstance } from "babylonjs-editor-tools";

import {
	ANIMATOR_ANY_STATE,
	ANIMATOR_EXIT_STATE,
	createAnimatorController,
	deleteAnimatorController,
	deleteAnimatorSubgraph,
	getAnimatorCompiledGraph,
	getAnimatorHumanoidMuscleTraceForController,
	getAnimatorRuntimeDebug,
	listAnimatorControllers,
	openAnimatorRuntimeDebugger,
	resetAnimatorTrigger,
	setAnimatorController,
	setAnimatorEntryTransitions,
	setAnimatorEntryState,
	setAnimatorLayer,
	setAnimatorLayerBlending,
	setAnimatorLayerIKPass,
	setAnimatorLayerState,
	setAnimatorSynchronizedLayerOverrides,
	setAnimatorBlendTree,
	setAnimatorParameter,
	setAnimatorParameterDefinition,
	setAnimatorRootMotion,
	setAnimatorHumanoidMuscleTrace,
	setAnimatorRuntimeDebug,
	setAnimatorStateMask,
	setAnimatorStateBehaviours,
	setAnimatorStateGraphPosition,
	setAnimatorState,
	setAnimatorSubgraph,
	setAnimatorSubStateMachine,
	setAnimatorTransition,
	setAnimatorTrigger,
	stepAnimatorRuntimeDebug,
} from "../../src/mcp/animator/animator";

describe("mcp/animator", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				selectTab: vi.fn(),
				animations: { openAnimatorDebugger: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		new AnimationGroup("Idle", scene);
		new AnimationGroup("Run", scene);
		new AnimationGroup("Sprint", scene);
	});

	test("updates blend-tree children and preserves duplicate clips as independent motions", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Three Speeds",
				parameters: { speed: 0 },
				states: [
					{
						name: "Move",
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
			},
			options
		);

		setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Move",
				children: [
					{ animationGroup: "Idle", threshold: 0 },
					{ animationGroup: "Run", threshold: 1 },
					{ animationGroup: "Sprint", threshold: 2 },
				],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Move" }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "speed", value: 1.5 }, options);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.5);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.5);
		const duplicated = setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Move",
				children: [
					{ animationGroup: "Idle", threshold: 0 },
					{ animationGroup: "Idle", threshold: 1, timeScale: 2, cycleOffset: 0.25, mirror: true },
				],
			},
			options
		);
		expect(duplicated.states[0].blendTree.children).toMatchObject([
			{ animationGroup: "Idle", threshold: 0 },
			{ animationGroup: "Idle", threshold: 1, timeScale: 2, cycleOffset: 0.25, mirror: true },
		]);
		expect(() =>
			setAnimatorBlendTree(
				scene,
				{
					controllerId: controller.id,
					state: "Move",
					children: [
						{ animationGroup: "Idle", threshold: 0 },
						{ animationGroup: "Run", threshold: 1, timeScale: 0 },
					],
				},
				options
			)
		).toThrow("timeScale");
		expect(() =>
			setAnimatorBlendTree(
				scene,
				{
					controllerId: controller.id,
					state: "Move",
					children: [
						{ animationGroup: "Idle", threshold: 0 },
						{ animationGroup: "Run", threshold: 1, cycleOffset: 1.1 },
					],
				},
				options
			)
		).toThrow("cycleOffset");
	});

	test("previews per-child Blend Tree speed and phase on independent runtime clips", () => {
		const target = new TransformNode("Motion Target", scene);
		const animation = new Animation("Idle X", "position.x", 100, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 100, value: 100 },
		]);
		scene.getAnimationGroupByName("Idle")!.addTargetedAnimation(animation, target);
		const controller = createAnimatorController(
			scene,
			{
				name: "Modified Motions",
				parameters: { blend: 0.25 },
				states: [
					{
						name: "Move",
						blendTree: {
							parameter: "blend",
							children: [
								{ animationGroup: "Idle", threshold: 0 },
								{ animationGroup: "Idle", threshold: 1, timeScale: -2, cycleOffset: 0.25 },
							],
						},
					},
				],
				transitions: [],
			},
			options
		);

		setAnimatorState(scene, { controllerId: controller.id, state: "Move" }, options);
		const clips = getAnimatorRuntimeDebug(scene, { controllerId: controller.id, includeAllClips: true }).base.clips;
		expect(clips).toMatchObject([
			{ sourceAnimationGroup: "Idle", motionKey: "0", weight: 0.75, timeScale: 1, cycleOffset: 0, internalLayerClone: true },
			{ sourceAnimationGroup: "Idle", motionKey: "1", weight: 0.25, timeScale: -2, cycleOffset: 0.25, internalLayerClone: true, speedRatio: -2 },
		]);
		expect(clips[1].currentFrame).toBeCloseTo(25);
		expect(scene.animationGroups.map((group) => group.name)).toEqual(["Idle", "Run", "Sprint"]);
	});

	test("authors and previews static Unity-style state playback settings through the shared Animator actions", () => {
		const leftHand = new TransformNode("EditorLeftHand", scene);
		const rightHand = new TransformNode("EditorRightHand", scene);
		const animation = new Animation("Run Hand", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: new Vector3(1, 0, 0) },
			{ frame: 30, value: new Vector3(2, 0, 0) },
		]);
		scene.getAnimationGroupByName("Run")!.addTargetedAnimation(animation, leftHand);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{ id: "editor-static-avatar", name: "Editor Static Avatar", animationType: "humanoid", mapping: { leftHand: leftHand.name, rightHand: rightHand.name } },
			],
		};
		const controller = createAnimatorController(
			scene,
			{
				name: "Static Playback",
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
				playOnCreate: true,
			},
			options
		);

		const initialDebug = getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).base;
		expect(initialDebug).toMatchObject({
			activeState: "Reverse Mirrored",
			speed: -1.5,
			cycleOffset: 0.25,
			mirror: true,
			loop: false,
			tag: "Locomotion",
			footIK: true,
			writeDefaultValues: false,
			clips: [{ sourceAnimationGroup: "Run", speedRatio: -1.5, cycleOffset: 0.25, mirrored: true, internalLayerClone: true, playbackFromFrame: 30, currentFrame: 7.5 }],
		});
		const initial = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
		const paused = setAnimatorRuntimeDebug(scene, { controllerId: controller.id, expectedFingerprint: initial.debugger.fingerprint, paused: true }, options);
		const stepped = stepAnimatorRuntimeDebug(scene, { controllerId: controller.id, expectedFingerprint: paused.debugger.fingerprint, deltaSeconds: 0.1, steps: 1 }, options);
		expect(stepped.base.clips[0].currentFrame).toBeCloseTo(3);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).footIK.layers[0]).toMatchObject({ enabled: true, invocations: 1, failedFeet: 2, avatarId: null });
		expect(() => setAnimatorController(scene, { controllerId: controller.id, states: [{ name: "Bad", animationGroup: "Run", speed: 0 }] }, options)).toThrow(
			"speed must be a finite non-zero"
		);
		expect(() => setAnimatorController(scene, { controllerId: controller.id, states: [{ name: "Bad", animationGroup: "Run", cycleOffset: 1.1 }] }, options)).toThrow(
			"cycleOffset must be normalized"
		);
	});

	test("executes Write Defaults property restoration through the editor preview and debugger", () => {
		const target = new TransformNode("EditorWriteDefaultsTarget", scene);
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
		const controller = createAnimatorController(
			scene,
			{
				name: "Editor Write Defaults",
				parameters: {},
				states: [
					{ name: "Scale", animationGroup: "Run" },
					{ name: "Move", animationGroup: "Idle", writeDefaultValues: true },
				],
				transitions: [],
				activeState: "Scale",
				playOnCreate: true,
			},
			options
		);

		expect(target.scaling.x).toBe(5);
		setAnimatorState(scene, { controllerId: controller.id, state: "Move" }, options);
		expect(target.scaling.x).toBe(1);
		expect(target.position.x).toBe(2);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).writeDefaults).toMatchObject({
			enabled: true,
			invocations: 1,
			resetCount: 1,
			lastResetProperties: ["EditorWriteDefaultsTarget.scaling.x"],
			algorithm: "bounded-controller-default-snapshot-v1",
		});
	});

	test("executes dynamic Unity state playback parameters and validates their declared types", () => {
		const target = new TransformNode("DynamicTarget", scene);
		const rootMotionTarget = new TransformNode("DynamicRootMotionTarget", scene);
		const animation = new Animation("Dynamic Run", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 30 },
		]);
		scene.getAnimationGroupByName("Run")!.addTargetedAnimation(animation, target);
		const controller = createAnimatorController(
			scene,
			{
				name: "Dynamic Playback",
				parameters: { rate: 0.5, mirrorState: false, phase: 0.1, scrub: 0.25 },
				parameterTypes: { rate: "float", mirrorState: "bool", phase: "float", scrub: "float" },
				states: [
					{
						name: "Dynamic",
						animationGroup: "Run",
						speed: 2,
						speedParameter: "rate",
						mirrorParameter: "mirrorState",
						cycleOffsetParameter: "phase",
						timeParameter: "scrub",
					},
				],
				transitions: [],
				rootMotion: { enabled: true, sourceNodeId: target.id, targetNodeId: rootMotionTarget.id },
				playOnCreate: true,
			},
			options
		);

		const initialDynamicDebug = getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).base;
		expect(initialDynamicDebug).toMatchObject({
			effectiveSpeed: 1,
			cycleOffset: 0.1,
			mirror: false,
			timeDriven: true,
			time: 0.25,
			playbackBindings: { speed: "rate", mirror: "mirrorState", cycleOffset: "phase", time: "scrub" },
		});
		expect(initialDynamicDebug.clips[0].currentFrame).toBeCloseTo(10.5);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).rootMotion).toMatchObject({ enabled: true, suppressedByTimeParameter: true, sampled: false });
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "rate", value: -1 }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "phase", value: 0.4 }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "scrub", value: 0.75 }, options);
		const updatedDebug = getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).base;
		expect(updatedDebug).toMatchObject({
			effectiveSpeed: -2,
			cycleOffset: 0.4,
			time: 0.75,
			loopProgress: 0.75,
		});
		expect(updatedDebug.clips[0].currentFrame).toBeCloseTo(4.5);
		expect(() =>
			createAnimatorController(
				scene,
				{
					name: "Wrong Dynamic Type",
					parameters: { flag: true },
					parameterTypes: { flag: "bool" },
					states: [{ name: "Bad", animationGroup: "Idle", speedParameter: "flag" }],
					transitions: [],
				},
				options
			)
		).toThrow("speedParameter requires a float parameter");
	});

	test("authors and evaluates bounded recursive Blend Trees through the focused action", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Recursive Locomotion",
				parameters: { speed: 0.5 },
				states: [
					{
						name: "Move",
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
			},
			options
		);
		const authored = setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Move",
				children: [
					{ animationGroup: "Idle", threshold: 0 },
					{
						threshold: 1,
						blendTree: {
							parameter: "direction",
							children: [
								{ animationGroup: "Run", threshold: -1 },
								{ animationGroup: "Sprint", threshold: 1 },
							],
						},
					},
				],
			},
			options
		);
		expect(authored).toMatchObject({
			parameters: { speed: 0.5, direction: 0 },
			states: [{ blendTree: { children: [{ animationGroup: "Idle" }, { blendTree: { parameter: "direction" } }] } }],
		});
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "speed", value: 0.5 }, options);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.5);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Sprint")?.weight).toBeCloseTo(0.25);
		expect(() =>
			setAnimatorBlendTree(
				scene,
				{
					controllerId: controller.id,
					state: "Move",
					children: [
						{ animationGroup: "Idle", threshold: 0 },
						{ threshold: 1, blendTree: { parameter: "direction", children: [{ animationGroup: "Run", threshold: 0 }] } },
					],
				},
				options
			)
		).toThrow("between 2 and 64 children");
	});

	test("authors Direct Blend Trees and validates every child parameter", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Direct Expressions",
				parameters: { first: 1, second: 3 },
				states: [
					{
						name: "Face",
						blendTree: {
							blendMode: "direct",
							normalizeWeights: true,
							children: [
								{ animationGroup: "Idle", directParameter: "first" },
								{ animationGroup: "Run", directParameter: "second" },
							],
						},
					},
				],
				transitions: [],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Face" }, options);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.25);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.75);
		const authored = setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Face",
				normalizeWeights: false,
				children: [
					{ animationGroup: "Idle", directParameter: "first" },
					{ animationGroup: "Run", directParameter: "third" },
				],
			},
			options
		);
		expect(authored).toMatchObject({ parameters: { first: 1, second: 3, third: 0 }, states: [{ blendTree: { blendMode: "direct", normalizeWeights: false } }] });
		expect(() =>
			setAnimatorBlendTree(
				scene,
				{
					controllerId: controller.id,
					state: "Face",
					children: [{ animationGroup: "Idle", directParameter: "first" }, { animationGroup: "Run" }],
				},
				options
			)
		).toThrow("directParameter");
		const oneDimensional = setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Face",
				parameter: "mix",
				children: [
					{ animationGroup: "Idle", threshold: 0 },
					{ animationGroup: "Run", threshold: 1 },
				],
			},
			options
		);
		expect(oneDimensional.states[0].blendTree).toEqual({
			parameter: "mix",
			children: [
				{ animationGroup: "Idle", threshold: 0 },
				{ animationGroup: "Run", threshold: 1 },
			],
		});
		const directAgain = setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Face",
				blendMode: "direct",
				normalizeWeights: true,
				children: [
					{ animationGroup: "Idle", directParameter: "first" },
					{ animationGroup: "Run", directParameter: "second" },
				],
			},
			options
		);
		expect(directAgain.states[0].blendTree).toMatchObject({ blendMode: "direct", normalizeWeights: true });
		expect(directAgain.states[0].blendTree).not.toHaveProperty("parameter");
	});

	test("persists a validated two-parameter 2D blend tree through the focused action", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "2D Locomotion",
				parameters: { horizontal: 0, vertical: 0 },
				states: [
					{
						name: "Move",
						blendTree: {
							parameterX: "horizontal",
							parameterY: "vertical",
							children: [
								{ animationGroup: "Idle", position: [0, 0] },
								{ animationGroup: "Run", position: [1, 0] },
								{ animationGroup: "Sprint", position: [0, 1] },
							],
						},
					},
				],
				transitions: [],
			},
			options
		);
		const result = setAnimatorBlendTree(
			scene,
			{
				controllerId: controller.id,
				state: "Move",
				children: [
					{ animationGroup: "Idle", position: [-1, 0] },
					{ animationGroup: "Run", position: [1, 0] },
					{ animationGroup: "Sprint", position: [0, 1] },
				],
			},
			options
		);
		expect(result.states[0].blendTree).toMatchObject({ parameterX: "horizontal", parameterY: "vertical" });
		expect(result.states[0].blendTree.children[0]).toMatchObject({ position: [-1, 0] });
		const freeform = setAnimatorBlendTree(scene, { controllerId: controller.id, state: "Move", blendMode: "freeformDirectional" }, options);
		expect(freeform.states[0].blendTree).toMatchObject({ blendMode: "freeformDirectional" });
		expect(() =>
			setAnimatorBlendTree(
				scene,
				{
					controllerId: controller.id,
					state: "Move",
					children: [
						{ animationGroup: "Idle", position: [0, 0] },
						{ animationGroup: "Run", position: [0, 0] },
					],
				},
				options
			)
		).toThrow("unique");
	});

	test("applies and clears a state animation-target mask", () => {
		const arm = new TransformNode("Arm", scene);
		const animation = new Animation("Arm Rotation", "rotation.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 1, value: 1 },
		]);
		scene.getAnimationGroupByName("Idle")?.addTargetedAnimation(animation, arm);
		const controller = createAnimatorController(scene, { name: "Masked", states: [{ name: "Idle", animationGroup: "Idle" }], transitions: [] }, options);

		setAnimatorStateMask(scene, { controllerId: controller.id, state: "Idle", targetNames: ["Arm"] }, options);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		expect(scene.getAnimationGroupByName("Idle")?.mask?.retainsTarget("Arm")).toBe(true);
		setAnimatorStateMask(scene, { controllerId: controller.id, state: "Idle", targetNames: [] }, options);
		expect(scene.getAnimationGroupByName("Idle")?.mask).toBeNull();
		expect(() => setAnimatorStateMask(scene, { controllerId: controller.id, state: "Idle", targetNames: ["Leg"] }, options)).toThrow("not animated");
	});

	test("persists an Animator graph state position without changing its clip", () => {
		const controller = createAnimatorController(scene, { name: "Graph Layout", states: [{ name: "Idle", animationGroup: "Idle" }], transitions: [] }, options);
		const result = setAnimatorStateGraphPosition(scene, { controllerId: controller.id, state: "Idle", position: [240, 96] }, options);
		expect(result.states[0]).toMatchObject({ name: "Idle", animationGroup: "Idle", graphPosition: [240, 96] });
		expect(() => setAnimatorStateGraphPosition(scene, { controllerId: controller.id, state: "Idle", position: [Number.NaN, 0] }, options)).toThrow("finite");
	});

	test("persists a validated root-motion source and separate target", () => {
		const source = new TransformNode("Animated Root", scene);
		const target = new TransformNode("Character", scene);
		const controller = createAnimatorController(scene, { name: "Root Motion", states: [{ name: "Idle", animationGroup: "Idle" }], transitions: [] }, options);
		const result = setAnimatorRootMotion(
			scene,
			{ controllerId: controller.id, enabled: true, sourceNodeId: source.id, targetNodeId: target.id, applyRotationY: true },
			options
		);
		expect(result.rootMotion).toMatchObject({ enabled: true, sourceNodeId: source.id, targetNodeId: target.id, applyPosition: true, applyRotationY: true });
		expect(setAnimatorRootMotion(scene, { controllerId: controller.id, enabled: false }, options).rootMotion).toBeUndefined();
		expect(() => setAnimatorRootMotion(scene, { controllerId: controller.id, enabled: true, sourceNodeId: source.id, targetNodeId: source.id }, options)).toThrow(
			"must differ"
		);
	});

	test("applies and clears a layer animation-target mask", () => {
		const arm = new TransformNode("Arm", scene);
		const animation = new Animation("Arm Rotation", "rotation.y", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 1, value: 1 },
		]);
		scene.getAnimationGroupByName("Run")?.addTargetedAnimation(animation, arm);
		const controller = createAnimatorController(
			scene,
			{
				name: "Layer Masked",
				states: [{ name: "Base", animationGroup: "Idle" }],
				transitions: [],
				layers: [{ name: "Upper", states: [{ name: "Relax", animationGroup: "Run" }], transitions: [], activeState: "Relax" }],
			},
			options
		);

		setAnimatorLayer(scene, { controllerId: controller.id, layer: "Upper", maskTargetNames: ["Arm"] }, options);
		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options);
		expect(scene.getAnimationGroupByName("Run")?.mask?.retainsTarget("Arm")).toBe(true);
		setAnimatorLayer(scene, { controllerId: controller.id, layer: "Upper", maskTargetNames: [] }, options);
		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options);
		expect(scene.getAnimationGroupByName("Run")?.mask).toBeNull();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, edits, transitions, plays, and deletes a persisted controller", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Character",
				parameters: { moving: false },
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run", loop: true },
				],
				transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "moving", equals: true }] }],
			},
			options
		);

		expect(listAnimatorControllers(scene).controllers).toHaveLength(1);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		const transitioned = setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options);
		expect(transitioned.activeState).toBe("Run");

		const edited = setAnimatorController(
			scene,
			{ controllerId: controller.id, name: "Character Controller", states: controller.states, transitions: controller.transitions },
			options
		);
		expect(edited.name).toBe("Character Controller");

		expect(deleteAnimatorController(scene, { controllerId: controller.id }, options)).toEqual({ deleted: true, id: controller.id });
		expect(listAnimatorControllers(scene).controllers).toHaveLength(0);
	});

	test("authors real Entry, Any State, and Exit behavior for base and layer state machines", () => {
		const controller = createAnimatorController(
			scene,
			{
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
					{ from: "Sprint", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "done", equals: true }] },
				],
				layers: [
					{
						name: "Upper",
						states: [
							{ name: "Relax", animationGroup: "Run" },
							{ name: "Aim", animationGroup: "Sprint" },
						],
						entryState: "Aim",
						activeState: "Relax",
						transitions: [
							{ from: ANIMATOR_ANY_STATE, to: "Aim", conditions: [{ parameter: "layerPanic", equals: true }] },
							{ from: "Aim", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "layerDone", equals: true }] },
						],
					},
				],
			},
			options
		);

		expect(controller).toMatchObject({ entryState: "Run", activeState: "Idle", layers: [{ entryState: "Aim", activeState: "Relax" }] });
		expect(setAnimatorEntryState(scene, { controllerId: controller.id, state: "Run", play: true }, options).activeState).toBe("Run");
		expect(setAnimatorEntryState(scene, { controllerId: controller.id, layer: "Upper", state: "Aim", play: true }, options).layers[0].activeState).toBe("Aim");

		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		const anyState = setAnimatorParameter(scene, { controllerId: controller.id, parameter: "panic", value: true }, options);
		expect(anyState).toMatchObject({ activeState: "Sprint", transitioned: { from: "Idle", source: ANIMATOR_ANY_STATE, to: "Sprint" } });
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "panic", value: false }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "done", value: true }, options).activeState).toBeUndefined();

		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "layerPanic", value: true }, options).layers[0].activeState).toBe("Aim");
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "layerPanic", value: false }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "layerDone", value: true }, options).layers[0].activeState).toBeUndefined();

		expect(() => setAnimatorEntryState(scene, { controllerId: controller.id, state: "Missing" }, options)).toThrow("entryState");
		expect(() => setAnimatorController(scene, { controllerId: controller.id, transitions: [{ from: ANIMATOR_ANY_STATE, to: ANIMATOR_EXIT_STATE }] }, options)).toThrow(
			"cannot exit"
		);
	});

	test("authors conditional Entry routes and child-state-machine source transitions through shared actions", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Conditional Entry Authoring",
				parameters: { enterGround: true, fast: true, upperRun: true, done: false },
				parameterTypes: { enterGround: "bool", fast: "bool", upperRun: "bool", done: "trigger" },
				states: [{ name: "Idle", animationGroup: "Idle" }],
				subgraphs: [
					{
						id: "locomotion",
						name: "Locomotion",
						states: [
							{ name: "Walk", animationGroup: "Run" },
							{ name: "Run", animationGroup: "Sprint" },
						],
						transitions: [{ from: "Run", to: ANIMATOR_EXIT_STATE, conditions: [{ parameter: "done", equals: true }] }],
						entryState: "Walk",
					},
				],
				subStateMachines: [{ name: "Ground", subgraphId: "locomotion" }],
				transitions: [{ from: "Ground", to: "Idle" }],
				entryState: "Idle",
				layers: [
					{
						name: "Upper",
						states: [
							{ name: "Relax", animationGroup: "Idle" },
							{ name: "Aim", animationGroup: "Run" },
						],
						transitions: [],
						entryState: "Relax",
					},
				],
			},
			options
		);

		expect(
			setAnimatorEntryTransitions(
				scene,
				{ controllerId: controller.id, subgraphId: "locomotion", entryTransitions: [{ to: "Run", conditions: [{ parameter: "fast", equals: true }] }] },
				options
			).subgraph.entryTransitions
		).toEqual([{ to: "Run", conditions: [{ parameter: "fast", equals: true }] }]);
		expect(
			setAnimatorEntryTransitions(
				scene,
				{ controllerId: controller.id, entryTransitions: [{ to: "Ground", conditions: [{ parameter: "enterGround", equals: true }] }] },
				options
			).entryTransitions
		).toEqual([{ to: "Ground", conditions: [{ parameter: "enterGround", equals: true }] }]);
		expect(
			setAnimatorEntryTransitions(
				scene,
				{ controllerId: controller.id, layer: "Upper", entryTransitions: [{ to: "Aim", conditions: [{ parameter: "upperRun", equals: true }] }] },
				options
			).layers[0].entryTransitions
		).toEqual([{ to: "Aim", conditions: [{ parameter: "upperRun", equals: true }] }]);

		expect(setAnimatorEntryState(scene, { controllerId: controller.id, state: "Idle", play: true }, options).activeState).toBe("Ground/Run");
		expect(setAnimatorEntryState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax", play: true }, options).layers[0].activeState).toBe("Aim");
		expect(getAnimatorCompiledGraph(scene, { controllerId: controller.id })).toMatchObject({
			entryState: "Idle",
			resolvedEntryState: "Ground/Run",
			entryTransitions: [
				{
					to: "Ground/Run",
					conditions: [
						{ parameter: "enterGround", equals: true },
						{ parameter: "fast", equals: true },
					],
					fallback: false,
				},
				{ to: "Ground/Walk", conditions: [{ parameter: "enterGround", equals: true }], fallback: false },
				{ to: "Idle", fallback: true },
			],
		});

		expect(setAnimatorTrigger(scene, { controllerId: controller.id, parameter: "done" }, options).activeState).toBe("Idle");
		expect(() =>
			setAnimatorEntryTransitions(scene, { controllerId: controller.id, entryTransitions: [{ to: "Missing", conditions: [{ parameter: "fast", equals: true }] }] }, options)
		).toThrow("Entry transition destination");
		expect(() =>
			setAnimatorEntryTransitions(scene, { controllerId: controller.id, entryTransitions: [{ to: "Idle", conditions: [{ parameter: "missing", equals: true }] }] }, options)
		).toThrow("missing parameter");
		expect(() =>
			setAnimatorEntryTransitions(
				scene,
				{ controllerId: controller.id, entryTransitions: [{ to: "Idle", conditions: [{ parameter: "fast", equals: true, notEquals: false }] }] },
				options
			)
		).toThrow("exactly one");
	});

	test("captures and opens a live Animator runtime debugger without mutating controller metadata", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Debuggable",
				parameters: { moving: false, speed: 0.25 },
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				entryState: "Idle",
				transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "moving", equals: true }], duration: 0.5 }],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options);
		const before = structuredClone(scene.metadata.babylonEditorAnimatorControllers);
		const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id, includeAllClips: true });

		expect(snapshot).toMatchObject({
			controllerId: controller.id,
			controllerName: "Debuggable",
			parameters: [
				{ name: "moving", type: "bool", runtimeType: "boolean", value: true },
				{ name: "speed", type: "float", runtimeType: "number", value: 0.25 },
			],
			base: {
				entryState: "Idle",
				activeState: "Run",
				exited: false,
				transition: { from: "Idle", to: "Run", durationSeconds: 0.5, progress: 0, fromWeight: 1, toWeight: 0 },
			},
		});
		expect(snapshot.base.clips).toEqual(
			expect.arrayContaining([expect.objectContaining({ state: "Idle", name: "Idle", found: true }), expect.objectContaining({ state: "Run", name: "Run", found: true })])
		);
		expect(scene.metadata.babylonEditorAnimatorControllers).toEqual(before);

		expect(openAnimatorRuntimeDebugger(scene, { controllerId: controller.id }, options)).toEqual({
			opened: true,
			controllerId: controller.id,
			controllerName: "Debuggable",
			mode: "animator-debugger",
		});
		expect(options.editor.layout.selectTab).toHaveBeenCalledWith("animations");
		expect(options.editor.layout.animations.openAnimatorDebugger).toHaveBeenCalledWith(controller.id);
	});

	test("pauses, fixed-steps, records transition history, and stops on exact runtime breakpoints", () => {
		const animated = new TransformNode("Debug Target", scene);
		for (const groupName of ["Idle", "Run"]) {
			const animation = new Animation(`${groupName} Debug`, "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: 0 },
				{ frame: 60, value: 1 },
			]);
			scene.getAnimationGroupByName(groupName)!.addTargetedAnimation(animation, animated);
		}
		const controller = createAnimatorController(
			scene,
			{
				name: "Steppable",
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				entryState: "Idle",
				transitions: [{ from: "Idle", to: "Run", exitTime: 0.5, duration: 0.2 }],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);

		const initial = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
		const configured = setAnimatorRuntimeDebug(
			scene,
			{
				controllerId: controller.id,
				expectedFingerprint: initial.debugger.fingerprint,
				paused: true,
				breakpoints: [{ id: "idle-to-run", layer: "$base", from: "Idle", to: "Run" }],
			},
			options
		);
		expect(configured.debugger).toMatchObject({ paused: true, historyCount: 0, breakpoints: [{ id: "idle-to-run", enabled: true }] });
		expect(scene.getAnimationGroupByName("Idle")?.isPlaying).toBe(false);
		expect(() => setAnimatorRuntimeDebug(scene, { controllerId: controller.id, expectedFingerprint: initial.debugger.fingerprint, paused: false }, options)).toThrow(
			"changed after inspection"
		);

		const beforeBreakpoint = stepAnimatorRuntimeDebug(
			scene,
			{ controllerId: controller.id, expectedFingerprint: configured.debugger.fingerprint, deltaSeconds: 0.1, steps: 4 },
			options
		);
		expect(beforeBreakpoint).toMatchObject({ stepped: { completedSteps: 4, elapsedSeconds: 0.4, haltedByBreakpoint: false }, base: { activeState: "Idle" } });
		expect(beforeBreakpoint.debugger).toMatchObject({ paused: true, runtimeSeconds: 0.4, historyCount: 0 });

		const hit = stepAnimatorRuntimeDebug(
			scene,
			{ controllerId: controller.id, expectedFingerprint: beforeBreakpoint.debugger.fingerprint, deltaSeconds: 0.1, steps: 4 },
			options
		);
		expect(hit).toMatchObject({
			stepped: { requestedSteps: 4, completedSteps: 1, elapsedSeconds: 0.1, haltedByBreakpoint: true },
			base: { activeState: "Run", transition: { from: "Idle", to: "Run", durationSeconds: 0.2 } },
			debugger: {
				paused: true,
				runtimeSeconds: 0.5,
				historyCount: 1,
				history: [{ sequence: 1, layer: "$base", from: "Idle", authoredFrom: "Idle", to: "Run", hitBreakpointIds: ["idle-to-run"] }],
			},
		});
		expect(scene.getAnimationGroupByName("Run")?.isPlaying).toBe(false);

		const afterHitFingerprint = hit.debugger.fingerprint;
		expect(() =>
			setAnimatorRuntimeDebug(
				scene,
				{
					controllerId: controller.id,
					expectedFingerprint: afterHitFingerprint,
					breakpoints: [{ id: "invalid", from: "Missing", to: "Run" }],
				},
				options
			)
		).toThrow("was not found");
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).debugger.fingerprint).toBe(afterHitFingerprint);

		const cleared = setAnimatorRuntimeDebug(
			scene,
			{ controllerId: controller.id, expectedFingerprint: afterHitFingerprint, paused: false, clearHistory: true, breakpoints: [] },
			options
		);
		expect(cleared.debugger).toMatchObject({ paused: false, historyCount: 0, droppedHistoryCount: 0, breakpoints: [] });
		expect(scene.getAnimationGroupByName("Run")?.isPlaying).toBe(true);
		deleteAnimatorController(scene, { controllerId: controller.id }, options);
		expect(scene.getAnimationGroupByName("Run")?.isStarted).toBe(false);
		expect(() => getAnimatorRuntimeDebug(scene, { controllerId: controller.id })).toThrow("not found");
	});

	test("matches layer-scoped runtime breakpoints and records bounded transition history", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Layer Debugger",
				parameters: { aiming: false },
				states: [{ name: "Base", animationGroup: "Idle" }],
				transitions: [],
				layers: [
					{
						name: "Upper",
						states: [
							{ name: "Relax", animationGroup: "Idle" },
							{ name: "Aim", animationGroup: "Run" },
						],
						transitions: [{ from: "Relax", to: "Aim", conditions: [{ parameter: "aiming", equals: true }] }],
						activeState: "Relax",
					},
				],
			},
			options
		);
		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options);
		const initial = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
		setAnimatorRuntimeDebug(
			scene,
			{
				controllerId: controller.id,
				expectedFingerprint: initial.debugger.fingerprint,
				breakpoints: [{ id: "upper-aim", layer: "Upper", from: "Relax", to: "Aim" }],
			},
			options
		);

		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "aiming", value: true }, options);
		const hit = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
		expect(hit.debugger).toMatchObject({
			paused: true,
			historyCount: 1,
			history: [
				{
					layer: "Upper",
					from: "Relax",
					to: "Aim",
					hitBreakpointIds: ["upper-aim"],
					conditions: [{ parameter: "aiming", operator: "equals", authoredValue: true, runtimeValue: true }],
				},
			],
		});
	});

	test("caps transition history at 256 entries with explicit dropped evidence", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Bounded History",
				parameters: { moving: false },
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				transitions: [
					{ from: "Idle", to: "Run", conditions: [{ parameter: "moving", equals: true }] },
					{ from: "Run", to: "Idle", conditions: [{ parameter: "moving", equals: false }] },
				],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		for (let index = 0; index < 300; index++) {
			setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: index % 2 === 0 }, options);
		}
		const snapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id, historyLimit: 3 });
		expect(snapshot.debugger).toMatchObject({
			historyCount: 256,
			droppedHistoryCount: 44,
			historyTruncated: true,
			lastSequence: 300,
		});
		expect(snapshot.debugger.history.map((entry: any) => entry.sequence)).toEqual([298, 299, 300]);
	});

	test("authors typed parameters and consumes trigger values exactly once", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Typed Parameters",
				parameters: { speed: 0.5, count: 0, grounded: true, jump: false, unused: false },
				parameterTypes: { speed: "float", count: "int", grounded: "bool", jump: "trigger", unused: "trigger" },
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "jump", equals: true }] }],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);

		const fired = setAnimatorTrigger(scene, { controllerId: controller.id, parameter: "jump" }, options);
		expect(fired).toMatchObject({ activeState: "Run", parameters: { jump: false }, trigger: { parameter: "jump", consumed: true, armed: false } });

		const armed = setAnimatorTrigger(scene, { controllerId: controller.id, parameter: "unused" }, options);
		expect(armed).toMatchObject({ parameters: { unused: true }, trigger: { parameter: "unused", consumed: false, armed: true } });
		expect(resetAnimatorTrigger(scene, { controllerId: controller.id, parameter: "unused" }, options)).toMatchObject({
			parameters: { unused: false },
			trigger: { reset: true, armed: false },
		});

		expect(() => setAnimatorParameter(scene, { controllerId: controller.id, parameter: "count", value: 1.5 }, options)).toThrow("safe integer");
		expect(() => setAnimatorParameter(scene, { controllerId: controller.id, parameter: "missing", value: true }, options)).toThrow("not found");
		const changed = setAnimatorParameterDefinition(scene, { controllerId: controller.id, parameter: "speed", type: "int" }, options);
		expect(changed).toMatchObject({ parameters: { speed: 0 }, parameterTypes: { speed: "int", jump: "trigger" } });
		expect(() =>
			setAnimatorController(
				scene,
				{
					controllerId: controller.id,
					transitions: [{ from: "Run", to: "Idle", conditions: [{ parameter: "jump", equals: false }] }],
				},
				options
			)
		).toThrow("must use equals: true");
	});

	test("authors and evaluates transition offsets, ordered interruptions, and self transitions", () => {
		const animated = new TransformNode("Animated", scene);
		for (const groupName of ["Run", "Sprint"]) {
			const animation = new Animation(`${groupName} Position`, "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: 0 },
				{ frame: 60, value: 1 },
			]);
			scene.getAnimationGroupByName(groupName)?.addTargetedAnimation(animation, animated);
		}
		const controller = createAnimatorController(
			scene,
			{
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
				layers: [
					{
						name: "Upper",
						states: [
							{ name: "Relax", animationGroup: "Run" },
							{ name: "Aim", animationGroup: "Sprint" },
						],
						transitions: [{ from: "Relax", to: "Aim", duration: 0.25 }],
					},
				],
			},
			options
		);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);

		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).base).toMatchObject({
			activeState: "Run",
			normalizedTime: 0.25,
			transition: { from: "Idle", to: "Run", offset: 0.25, interruptionSource: "destination", orderedInterruption: true },
		});
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "sprint", value: true }, options).transitioned).toBeNull();

		const unordered = setAnimatorTransition(scene, { controllerId: controller.id, index: 1, orderedInterruption: false }, options);
		expect(unordered.transitions[1]).toMatchObject({ interruptionSource: "destination", orderedInterruption: false, offset: 0.25 });
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: false }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "sprint", value: false }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options);
		const interrupted = setAnimatorParameter(scene, { controllerId: controller.id, parameter: "sprint", value: true }, options);
		expect(interrupted).toMatchObject({ activeState: "Sprint", transitioned: { source: "Run", to: "Sprint", interrupted: true } });
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).base.transition).toMatchObject({
			from: "Run",
			to: "Sprint",
			interrupted: true,
		});

		setAnimatorState(scene, { controllerId: controller.id, state: "Sprint" }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "restart", value: true }, options).transitioned).toBeNull();
		setAnimatorTransition(scene, { controllerId: controller.id, index: 3, canTransitionToSelf: true }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "restart", value: false }, options);
		const restarted = setAnimatorParameter(scene, { controllerId: controller.id, parameter: "restart", value: true }, options);
		expect(restarted.transitioned).toMatchObject({ source: ANIMATOR_ANY_STATE, to: "Sprint", interrupted: false });
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).base).toMatchObject({ activeState: "Sprint", normalizedTime: 0.5, transition: null });

		const layerUpdated = setAnimatorTransition(
			scene,
			{ controllerId: controller.id, layer: "Upper", index: 0, offset: 0.2, interruptionSource: "sourceThenDestination", orderedInterruption: true },
			options
		);
		expect(layerUpdated.layers[0].transitions[0]).toMatchObject({ offset: 0.2, interruptionSource: "sourceThenDestination", orderedInterruption: true });
		expect(() => setAnimatorTransition(scene, { controllerId: controller.id, index: 99, duration: 0.5 }, options)).toThrow("index");
		expect(() => setAnimatorTransition(scene, { controllerId: controller.id, index: 0, to: ANIMATOR_EXIT_STATE, offset: 0.2 }, options)).toThrow(
			"cannot use a destination offset"
		);
	});

	test("authors reusable nested sub-state machines with compiled Entry/Exit routing and cycle-safe MCP mutations", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Nested Authoring",
				parameters: { moving: false, done: false, allowExit: false, useOther: false, aiming: false },
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
				],
				subStateMachines: [
					{ name: "Ground", subgraphId: "locomotion", graphPosition: [300, 120] },
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
						states: [{ name: "Empty", animationGroup: "Idle" }],
						transitions: [],
						entryState: "Empty",
					},
				],
				playOnCreate: true,
			},
			options
		);

		expect(controller.activeState).toBe("Ground/Walk");
		expect(getAnimatorCompiledGraph(scene, { controllerId: controller.id })).toMatchObject({
			entryState: "Ground/Walk",
			states: [
				{ name: "Idle", machinePath: [], subgraphId: null },
				{ name: "Ground/Walk", machinePath: ["Ground"], subgraphId: "locomotion" },
				{ name: "Ground/Run", machinePath: ["Ground"], subgraphId: "locomotion" },
				{ name: "Other/Walk", machinePath: ["Other"], subgraphId: "locomotion" },
				{ name: "Other/Run", machinePath: ["Other"], subgraphId: "locomotion" },
			],
			machineEntries: { "": "Ground/Walk", Ground: "Ground/Walk", Other: "Other/Walk" },
		});
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options).activeState).toBe("Ground/Run");
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "allowExit", value: true }, options).transitioned).toBeNull();
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "done", value: true }, options).activeState).toBe("Idle");
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "useOther", value: true }, options).activeState).toBe("Other/Walk");

		const updated = setAnimatorSubgraph(
			scene,
			{
				controllerId: controller.id,
				subgraphId: "locomotion",
				name: "Reusable Locomotion",
				states: [
					{ name: "Walk", animationGroup: "Run" },
					{ name: "Run", animationGroup: "Sprint" },
				],
				entryState: "Walk",
			},
			options
		);
		expect(updated).toMatchObject({ created: false, subgraph: { id: "locomotion", name: "Reusable Locomotion" } });

		setAnimatorSubStateMachine(scene, { controllerId: controller.id, layer: "Upper", name: "Upper Motion", subgraphId: "locomotion" }, options);
		expect(getAnimatorCompiledGraph(scene, { controllerId: controller.id, layer: "Upper" }).states).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Upper Motion/Walk", subgraphId: "locomotion" })])
		);
		expect(() =>
			setAnimatorSubgraph(
				scene,
				{
					controllerId: controller.id,
					subgraphId: "locomotion",
					subStateMachines: [{ name: "Loop", subgraphId: "locomotion" }],
				},
				options
			)
		).toThrow("cycle");
		expect(() => deleteAnimatorSubgraph(scene, { controllerId: controller.id, subgraphId: "locomotion" }, options)).toThrow("still instantiated");
		const deleted = deleteAnimatorSubgraph(scene, { controllerId: controller.id, subgraphId: "locomotion", cascade: true }, options);
		expect(deleted).toMatchObject({ activeState: "Idle", deletedSubgraph: { id: "locomotion" } });
		expect(deleted.subgraphs).toEqual([]);
		expect(deleted.subStateMachines).toEqual([]);
		expect(deleted.layers[0].subStateMachines).toEqual([]);
	});

	test("evaluates numeric greater-than and less-than transition conditions", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Movement",
				parameters: { speed: 0 },
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				transitions: [
					{ from: "Idle", to: "Run", conditions: [{ parameter: "speed", greaterThan: 0.5 }] },
					{ from: "Run", to: "Idle", conditions: [{ parameter: "speed", lessThan: 0.5 }] },
				],
			},
			options
		);

		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "speed", value: 1 }, options).activeState).toBe("Run");
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "speed", value: 0 }, options).activeState).toBe("Idle");
	});

	test("plays a persisted one-dimensional blend tree and updates clip weights from its parameter", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Locomotion",
				parameters: { speed: 0 },
				states: [
					{
						name: "Locomotion Blend",
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
			},
			options
		);

		setAnimatorState(scene, { controllerId: controller.id, state: "Locomotion Blend" }, options);
		setAnimatorParameter(scene, { controllerId: controller.id, parameter: "speed", value: 0.25 }, options);
		expect(scene.getAnimationGroupByName("Idle")?.weight).toBeCloseTo(0.75);
		expect(scene.getAnimationGroupByName("Run")?.weight).toBeCloseTo(0.25);
	});

	test("runs an independent weighted layer transition without replacing the base state", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Layered Character",
				parameters: { aiming: false },
				states: [{ name: "Locomotion", animationGroup: "Idle" }],
				transitions: [],
				layers: [
					{
						name: "Upper Body",
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
			options
		);

		setAnimatorState(scene, { controllerId: controller.id, state: "Locomotion" }, options);
		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper Body", state: "Relax" }, options);
		const result = setAnimatorParameter(scene, { controllerId: controller.id, parameter: "aiming", value: true }, options);

		expect(result.activeState).toBe("Locomotion");
		expect(result.layers[0].activeState).toBe("Aim");
		expect(result.layerTransitions).toEqual([{ layer: "Upper Body", from: "Relax", source: "Relax", to: "Aim", interrupted: false }]);
	});

	test("updates an individual layer state machine without replacing base states", () => {
		const controller = createAnimatorController(
			scene,
			{
				name: "Editable Layer",
				parameters: { aiming: false },
				states: [{ name: "Base", animationGroup: "Idle" }],
				transitions: [],
				layers: [{ name: "Upper", states: [{ name: "Relax", animationGroup: "Run" }], transitions: [], activeState: "Relax" }],
			},
			options
		);

		const result = setAnimatorLayer(
			scene,
			{
				controllerId: controller.id,
				layer: "Upper",
				states: [
					{ name: "Relax", animationGroup: "Run" },
					{ name: "Aim", animationGroup: "Sprint" },
				],
				transitions: [{ from: "Relax", to: "Aim", conditions: [{ parameter: "aiming", equals: true }] }],
			},
			options
		);

		expect(result.states).toEqual([{ name: "Base", animationGroup: "Idle" }]);
		expect(result.layers[0]).toMatchObject({
			name: "Upper",
			states: [{ name: "Relax" }, { name: "Aim" }],
			transitions: [{ from: "Relax", to: "Aim", conditions: [{ parameter: "aiming", equals: true }] }],
		});
		setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "aiming", value: true }, options).layers[0].activeState).toBe("Aim");
	});

	test("authors additive reference poses and synchronized Animator layers through focused editor and MCP actions", () => {
		const target = new TransformNode("Layer Target", scene);
		for (const [index, groupName] of ["Idle", "Run", "Sprint"].entries()) {
			const animation = new Animation(`${groupName} X`, "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			const endFrame = groupName === "Sprint" ? 120 : 60;
			animation.setKeys([
				{ frame: 0, value: index },
				{ frame: 30, value: index + 0.5 },
				{ frame: endFrame, value: index + 1 },
			]);
			scene.getAnimationGroupByName(groupName)!.addTargetedAnimation(animation, target);
		}
		const controller = createAnimatorController(
			scene,
			{
				name: "Unity Layer Parity",
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
						weight: 0.5,
						states: [
							{ name: "Relax", animationGroup: "Run" },
							{ name: "Aim", animationGroup: "Sprint" },
						],
						transitions: [{ from: "Relax", to: "Aim", conditions: [{ parameter: "moving", equals: true }] }],
						entryState: "Relax",
					},
				],
			},
			options
		);

		const configured = setAnimatorLayerBlending(
			scene,
			{
				controllerId: controller.id,
				layer: "Upper",
				blendingMode: "additive",
				referencePoseNormalizedTime: 0.5,
				synchronizedLayer: "$base",
				synchronizedTiming: true,
				synchronizedStateMap: { Idle: "Relax", Run: "Aim" },
			},
			options
		);
		expect(configured.layers[0]).toMatchObject({
			blendingMode: "additive",
			referencePose: { normalizedTime: 0.5 },
			synchronizedLayer: "$base",
			synchronizedTiming: true,
			synchronizedStateMap: { Idle: "Relax", Run: "Aim" },
			transitions: [],
		});
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		setAnimatorLayerBlending(scene, { controllerId: controller.id, layer: "Upper", synchronizedTiming: true }, options);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).layers[0]).toMatchObject({
			activeState: "Relax",
			blendingMode: "additive",
			synchronizedLayer: "$base",
			clips: [{ name: expect.stringContaining("__babylonEditorAnimatorAdditive:"), additive: true, internalLayerClone: true }],
		});
		expect(scene.getAnimationGroupByName("Run")?.isAdditive).toBe(false);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options).layers[0].activeState).toBe("Aim");
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(300);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const timedSnapshot = getAnimatorRuntimeDebug(scene, { controllerId: controller.id });
		expect(timedSnapshot.base).toMatchObject({ activeState: "Run", durationSeconds: 1.5 });
		expect(timedSnapshot.base.normalizedTime).toBeCloseTo(0.2);
		expect(timedSnapshot.layers[0]).toMatchObject({ activeState: "Aim", durationSeconds: 2, synchronizedTiming: true });
		expect(timedSnapshot.layers[0].normalizedTime).toBeCloseTo(0.2);
		expect(() => setAnimatorLayerState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options)).toThrow("cannot be played independently");
		expect(() => setAnimatorEntryState(scene, { controllerId: controller.id, layer: "Upper", state: "Relax" }, options)).toThrow("inherits its Entry state");
		expect(() => setAnimatorLayer(scene, { controllerId: controller.id, layer: "Upper", transitions: [{ from: "Relax", to: "Aim" }] }, options)).toThrow(
			"cannot define independent transitions"
		);
		expect(() =>
			setAnimatorEntryTransitions(
				scene,
				{ controllerId: controller.id, layer: "Upper", entryTransitions: [{ to: "Aim", conditions: [{ parameter: "moving", equals: true }] }] },
				options
			)
		).toThrow("inherits transitions and Entry routing");
	});

	test("authors and executes StateMachineBehaviour callbacks in editor preview", () => {
		const target = new TransformNode("Character", scene);
		target.metadata = { scripts: [{ key: "src/character-state.ts", enabled: true, values: {} }] };
		const events: string[] = [];
		_registerScriptInstance(
			target,
			{
				onAnimatorStateEnter: (_object, info) => events.push(`${info.phase}:${info.stateName}`),
				onAnimatorStateUpdate: (_object, info) => events.push(`${info.phase}:${info.stateName}`),
				onAnimatorStateExit: (_object, info) => events.push(`${info.phase}:${info.stateName}`),
				onAnimatorStateMachineEnter: (_object, info) => events.push(`${info.phase}:${info.machinePath.join("/") || "$root"}`),
				onAnimatorStateMachineExit: (_object, info) => events.push(`${info.phase}:${info.machinePath.join("/") || "$root"}`),
			},
			"src/character-state.ts",
			{}
		);
		const controller = createAnimatorController(
			scene,
			{
				name: "Behaviour Preview",
				targetNodeId: target.id,
				behaviours: [{ id: "root-machine-behaviour", scriptKey: "src/character-state.ts" }],
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				transitions: [],
				subgraphs: [{ id: "combat-subgraph", name: "Combat", states: [{ name: "Attack", animationGroup: "Sprint" }], transitions: [] }],
				layers: [{ name: "Upper", states: [{ name: "Aim", animationGroup: "Sprint" }], transitions: [] }],
			},
			options
		);

		const authored = setAnimatorStateBehaviours(
			scene,
			{
				controllerId: controller.id,
				state: "Idle",
				behaviours: [{ id: "idle-behaviour", scriptKey: "src/character-state.ts", enabled: true }],
			},
			options
		);
		expect(authored.states[0].behaviours).toEqual([{ id: "idle-behaviour", scriptKey: "src/character-state.ts", enabled: true }]);
		expect(
			setAnimatorStateBehaviours(
				scene,
				{ controllerId: controller.id, layer: "Upper", state: "Aim", behaviours: [{ id: "aim-behaviour", scriptKey: "src/character-state.ts" }] },
				options
			).layers[0].states[0].behaviours
		).toEqual([{ id: "aim-behaviour", scriptKey: "src/character-state.ts" }]);
		expect(
			setAnimatorStateBehaviours(
				scene,
				{ controllerId: controller.id, subgraphId: "combat-subgraph", state: "Attack", behaviours: [{ id: "attack-behaviour", scriptKey: "src/character-state.ts" }] },
				options
			).subgraph.states[0].behaviours
		).toEqual([{ id: "attack-behaviour", scriptKey: "src/character-state.ts" }]);
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		setAnimatorState(scene, { controllerId: controller.id, state: "Run" }, options);

		expect(events).toEqual(["machineEnter:$root", "enter:Idle", "update:Idle", "exit:Idle"]);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).stateBehaviours).toMatchObject({
			enterCalls: 1,
			updateCalls: 1,
			exitCalls: 1,
			machineEnterCalls: 1,
			machineExitCalls: 0,
			errorCount: 0,
		});
		expect(() =>
			setAnimatorStateBehaviours(scene, { controllerId: controller.id, state: "Run", behaviours: [{ id: "missing", scriptKey: "src/missing.ts" }] }, options)
		).toThrow("is not attached");
		expect(() =>
			setAnimatorStateBehaviours(
				scene,
				{
					controllerId: controller.id,
					state: "Run",
					behaviours: [
						{ id: "duplicate", scriptKey: "src/character-state.ts" },
						{ id: "duplicate", scriptKey: "src/character-state.ts" },
					],
				},
				options
			)
		).toThrow("ids must be unique");
	});

	test("authors synchronized-layer motion and behaviour overrides through one strict shared action", () => {
		const target = new TransformNode("Synchronized Character", scene);
		for (const [index, groupName] of ["Idle", "Run", "Sprint"].entries()) {
			const animation = new Animation(`${groupName} X`, "position.x", 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys([
				{ frame: 0, value: index },
				{ frame: 60, value: index + 1 },
			]);
			scene.getAnimationGroupByName(groupName)!.addTargetedAnimation(animation, target);
		}
		target.metadata = { scripts: [{ key: "src/override-state.ts", enabled: true, values: {} }] };
		const events: string[] = [];
		_registerScriptInstance(
			target,
			{
				onAnimatorStateEnter: (_object, info) => events.push(`${info.phase}:${info.stateName}`),
				onAnimatorStateUpdate: (_object, info) => events.push(`${info.phase}:${info.stateName}`),
				onAnimatorStateExit: (_object, info) => events.push(`${info.phase}:${info.stateName}`),
			},
			"src/override-state.ts",
			{}
		);
		const controller = createAnimatorController(
			scene,
			{
				name: "Synchronized Overrides",
				targetNodeId: target.id,
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
						synchronizedLayer: "$base",
						synchronizedStateMap: { Idle: "UpperIdle", Run: "UpperRun" },
						states: [
							{ name: "UpperIdle", animationGroup: "Sprint" },
							{ name: "UpperRun", animationGroup: "Sprint" },
						],
						transitions: [],
					},
				],
			},
			options
		);
		const authored = setAnimatorSynchronizedLayerOverrides(
			scene,
			{
				controllerId: controller.id,
				layer: "Upper",
				motionOverrides: { Run: { animationGroup: "Idle" } },
				behaviourOverrides: { Idle: [], Run: [{ id: "override-run", scriptKey: "src/override-state.ts" }] },
			},
			options
		);
		expect(authored.layers[0]).toMatchObject({
			synchronizedMotionOverrides: { Run: { animationGroup: "Idle" } },
			synchronizedBehaviourOverrides: { Idle: [], Run: [{ id: "override-run", scriptKey: "src/override-state.ts" }] },
		});
		setAnimatorState(scene, { controllerId: controller.id, state: "Idle" }, options);
		expect(setAnimatorParameter(scene, { controllerId: controller.id, parameter: "moving", value: true }, options).layers[0].activeState).toBe("UpperRun");
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(events).toEqual(["enter:UpperRun", "update:UpperRun"]);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).layers[0]).toMatchObject({
			activeSynchronizedSourceState: "Run",
			synchronizedMotionOverrides: { Run: { animationGroup: "Idle" } },
			clips: [{ name: "Idle" }],
		});
		expect(() =>
			setAnimatorSynchronizedLayerOverrides(
				scene,
				{ controllerId: controller.id, layer: "Upper", motionOverrides: { Missing: { animationGroup: "Idle" } }, behaviourOverrides: {} },
				options
			)
		).toThrow('source "Missing" was not found');
	});

	test("authors and executes Base Layer and additional-layer IK Pass callbacks in editor preview", () => {
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
					events.push(`${info.layerName}:${info.stateName}`);
					target.position.x = info.layerName === "$base" ? 1 : 2;
				},
			},
			"src/character-ik.ts",
			{}
		);
		const controller = createAnimatorController(
			scene,
			{
				name: "IK Preview",
				targetNodeId: target.id,
				states: [{ name: "Idle", animationGroup: "Idle" }],
				transitions: [],
				layers: [{ name: "Upper", weight: 0.5, states: [{ name: "Aim", animationGroup: "Run" }], transitions: [] }],
			},
			options
		);

		expect(setAnimatorLayerIKPass(scene, { controllerId: controller.id, layer: "$base", enabled: true }, options).baseIKPass).toBe(true);
		expect(setAnimatorLayerIKPass(scene, { controllerId: controller.id, layer: "Upper", enabled: true }, options).layers[0].ikPass).toBe(true);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(events).toEqual(["$base:Idle", "Upper:Aim"]);
		expect(rigObservedX).toBe(2);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id })).toMatchObject({
			ikPasses: {
				layers: [
					{ layerName: "$base", enabled: true, invocations: 1, callbackCalls: 1, errorCount: 0 },
					{ layerName: "Upper", enabled: true, invocations: 1, callbackCalls: 1, errorCount: 0 },
				],
			},
		});
	});

	test("binds one exact Humanoid Avatar and exposes bounded controller muscle tracing through the shared editor/MCP backend", () => {
		const skeleton = new Skeleton("Hero", "hero-skeleton", scene);
		const arm = new Bone("LeftArm", skeleton, null, Matrix.Identity(), Matrix.Identity());
		arm.rotationQuaternion = Quaternion.Identity();
		const target = new TransformNode("Humanoid Character", scene);
		target.metadata = { scripts: [{ key: "src/humanoid-ik.ts", enabled: true, values: {} }] };
		_registerScriptInstance(
			target,
			{
				onAnimatorIK: () => {
					arm.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), (20 * Math.PI) / 180);
				},
			},
			"src/humanoid-ik.ts",
			{}
		);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: skeleton.id,
					animationType: "humanoid",
					source: "model",
					mapping: { leftUpperArm: arm.name },
					restPose: { [arm.name]: { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] } },
					humanScale: 1,
					muscleLimitsEnabled: true,
					muscleLimits: { leftUpperArm: { min: [-10, -10, -10], max: [10, 10, 10] } },
				},
			],
		};
		const controller = createAnimatorController(
			scene,
			{
				name: "Humanoid Runtime",
				targetNodeId: target.id,
				humanoidAvatarId: "hero-avatar",
				baseIKPass: true,
				states: [{ name: "Idle", animationGroup: "Idle" }],
				transitions: [],
			},
			options
		);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(100);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		const read = getAnimatorHumanoidMuscleTraceForController(scene, { controllerId: controller.id, roles: ["leftUpperArm"], limit: 1 });
		expect(read).toMatchObject({
			controllerId: controller.id,
			avatarId: "hero-avatar",
			avatarName: "Hero Avatar",
			skeletonId: "hero-skeleton",
			enabled: true,
			samplingPhase: "postAnimatorPreMuscleLimit",
			history: { total: 1, count: 1 },
			latest: { sequence: 1, runtimeSeconds: 0.1, baseState: "Idle", limitViolationCount: 1 },
			availableAvatars: [{ id: "hero-avatar", skeletonFound: true, mappedBoneCount: 1, muscleLimitsEnabled: true }],
		});
		expect(read.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(read.current.muscles).toHaveLength(1);
		expect(getAnimatorRuntimeDebug(scene, { controllerId: controller.id }).humanoidMuscleTrace.history.total).toBe(1);
		expect(() => setAnimatorHumanoidMuscleTrace(scene, { controllerId: controller.id, expectedFingerprint: "0".repeat(64), clearHistory: true }, options)).toThrow(
			"changed since it was read"
		);

		const cleared = setAnimatorHumanoidMuscleTrace(scene, { controllerId: controller.id, expectedFingerprint: read.fingerprint, clearHistory: true }, options);
		expect(cleared.history.total).toBe(0);
		const unassigned = setAnimatorHumanoidMuscleTrace(scene, { controllerId: controller.id, expectedFingerprint: cleared.fingerprint, humanoidAvatarId: null }, options);
		expect(unassigned).toMatchObject({ enabled: false, avatarId: null, current: null, history: { total: 0 } });
		expect(() =>
			setAnimatorHumanoidMuscleTrace(scene, { controllerId: controller.id, expectedFingerprint: unassigned.fingerprint, humanoidAvatarId: "missing-avatar" }, options)
		).toThrow('Humanoid Avatar "missing-avatar" was not found');
	});
});

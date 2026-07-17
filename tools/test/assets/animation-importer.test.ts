import { Animation } from "@babylonjs/core/Animations/animation";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { describe, expect, test } from "vitest";

import { executeAnimationImporterDocument, executeAnimationImporterSource, normalizeAnimationImporterSettings } from "../../src/assets/animation-importer";

function unityAnimatorController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Hero Controller
  m_AnimatorParameters:
  - m_Name: Speed
    m_Type: 1
    m_DefaultFloat: 0
  - m_Name: Mode
    m_Type: 3
    m_DefaultInt: 0
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 0}
    m_BlendingMode: 0
    m_DefaultWeight: 1
    m_IKPass: 1
    m_SyncedLayerIndex: -1
  - m_Name: Upper Body
    m_StateMachine: {fileID: 110700001}
    m_Mask: {fileID: 31900000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
    m_BlendingMode: 1
    m_DefaultWeight: 0.75
    m_IKPass: 1
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
    m_Position: {x: 100, y: 120, z: 0}
  - m_State: {fileID: 110200001}
    m_Position: {x: 360, y: 120, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions:
  - {fileID: 110100001}
  m_EntryTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1107 &110700001
AnimatorStateMachine:
  m_Name: Upper Body
  m_ChildStates:
  - m_State: {fileID: 110200002}
    m_Position: {x: 180, y: 100, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200002}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Idle
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: 11111111111111111111111111111111, type: 2}
  m_Transitions:
  - {fileID: 110100000}
--- !u!1102 &110200001
AnimatorState:
  m_Name: Move
  m_Speed: 1
  m_Motion: {fileID: 20600000}
  m_Transitions: []
--- !u!1102 &110200002
AnimatorState:
  m_Name: Aim
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: 44444444444444444444444444444444, type: 2}
  m_Transitions: []
--- !u!206 &20600000
BlendTree:
  m_Name: Locomotion
  m_BlendParameter: Speed
  m_BlendParameterY: Speed
  m_BlendType: 0
  m_Childs:
  - m_Motion: {fileID: 7400000, guid: 22222222222222222222222222222222, type: 2}
    m_Threshold: 0
    m_Position: {x: 0, y: 0}
    m_TimeScale: 1
  - m_Motion: {fileID: 7400000, guid: 33333333333333333333333333333333, type: 2}
    m_Threshold: 1
    m_Position: {x: 1, y: 0}
    m_TimeScale: 1
--- !u!1101 &110100000
AnimatorStateTransition:
  m_DstState: {fileID: 110200001}
  m_DstStateMachine: {fileID: 0}
  m_Conditions:
  - m_ConditionMode: 3
    m_ConditionEvent: Speed
    m_EventTreshold: 0.1
  m_TransitionDuration: 0.25
  m_TransitionOffset: 0
  m_ExitTime: 0.75
  m_HasExitTime: 1
  m_HasFixedDuration: 0
  m_InterruptionSource: 1
  m_OrderedInterruption: 1
  m_CanTransitionToSelf: 0
  m_IsExit: 0
--- !u!1101 &110100001
AnimatorStateTransition:
  m_DstState: {fileID: 110200000}
  m_DstStateMachine: {fileID: 0}
  m_Conditions:
  - m_ConditionMode: 7
    m_ConditionEvent: Mode
    m_EventTreshold: 2
  m_TransitionDuration: 0
  m_HasExitTime: 0
  m_InterruptionSource: 0
  m_OrderedInterruption: 0
  m_CanTransitionToSelf: 1
  m_IsExit: 0
`;
}

function unitySynchronizedOverrideController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Synced Controller
  m_AnimatorParameters: []
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: -1
  - m_Name: Damaged
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: 0
    m_SyncedLayerAffectsTiming: 1
    m_Motions:
    - m_State: {fileID: 110200000}
      m_Motion: {fileID: 7400000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}
    m_Behaviours:
    - m_State: {fileID: 110200000}
      m_Behaviours: [{fileID: 11400000, guid: cccccccccccccccccccccccccccccccc, type: 3}]
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Idle
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
  m_Transitions: []
`;
}

function unityConditionalEntryController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Conditional Entry Controller
  m_AnimatorParameters:
  - m_Name: Go
    m_Type: 4
    m_DefaultBool: 0
  - m_Name: Done
    m_Type: 9
    m_DefaultBool: 0
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
  m_ChildStateMachines:
  - m_StateMachine: {fileID: 110700001}
  m_AnyStateTransitions: []
  m_EntryTransitions:
  - {fileID: 110900000}
  m_StateMachineTransitions:
  - first: {fileID: 110700001}
    second: {fileID: 110900001}
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1107 &110700001
AnimatorStateMachine:
  m_Name: Ground
  m_ChildStates:
  - m_State: {fileID: 110200001}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200001}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Idle
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
  m_Transitions: []
--- !u!1102 &110200001
AnimatorState:
  m_Name: Run
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}
  m_Transitions:
  - {fileID: 110100000}
--- !u!1109 &110900000
AnimatorTransition:
  m_DstState: {fileID: 0}
  m_DstStateMachine: {fileID: 110700001}
  m_Conditions:
  - m_ConditionMode: 1
    m_ConditionEvent: Go
    m_EventTreshold: 0
  m_IsExit: 0
--- !u!1109 &110900001
AnimatorTransition:
  m_DstState: {fileID: 110200000}
  m_DstStateMachine: {fileID: 0}
  m_Conditions: []
  m_IsExit: 0
--- !u!1101 &110100000
AnimatorStateTransition:
  m_DstState: {fileID: 0}
  m_DstStateMachine: {fileID: 0}
  m_Conditions:
  - m_ConditionMode: 1
    m_ConditionEvent: Done
    m_EventTreshold: 0
  m_HasExitTime: 0
  m_IsExit: 1
`;
}

function unityNestedBlendTreeController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Nested Locomotion
  m_AnimatorParameters:
  - m_Name: Speed
    m_Type: 1
    m_DefaultFloat: 0
  - m_Name: Direction
    m_Type: 1
    m_DefaultFloat: 0
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Locomotion
  m_Speed: 1
  m_Motion: {fileID: 20600000}
  m_Transitions: []
--- !u!206 &20600000
BlendTree:
  m_Name: Speed Tree
  m_BlendParameter: Speed
  m_BlendParameterY: Speed
  m_BlendType: 0
  m_Childs:
  - m_Motion: {fileID: 7400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
    m_Threshold: 0
  - m_Motion: {fileID: 20600001}
    m_Threshold: 1
--- !u!206 &20600001
BlendTree:
  m_Name: Direction Tree
  m_BlendParameter: Direction
  m_BlendParameterY: Direction
  m_BlendType: 0
  m_Childs:
  - m_Motion: {fileID: 7400000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}
    m_Threshold: -1
  - m_Motion: {fileID: 7400000, guid: cccccccccccccccccccccccccccccccc, type: 2}
    m_Threshold: 1
`;
}

function unityDirectBlendTreeController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Direct Face
  m_AnimatorParameters:
  - m_Name: Smile
    m_Type: 1
    m_DefaultFloat: 0.25
  - m_Name: Blink
    m_Type: 1
    m_DefaultFloat: 0.75
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Face
  m_Speed: 1
  m_Motion: {fileID: 20600000}
  m_Transitions: []
--- !u!206 &20600000
BlendTree:
  m_Name: Expressions
  m_BlendType: 4
  m_NormalizedBlendValues: 1
  m_Childs:
  - m_Motion: {fileID: 7400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
    m_DirectBlendParameter: Smile
    m_TimeScale: 2
    m_CycleOffset: 0.25
    m_Mirror: 1
  - m_Motion: {fileID: 7400000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}
    m_DirectBlendParameter: Blink
    m_TimeScale: 1
`;
}

function positionAnimation(): Record<string, unknown> {
	const animation = new Animation("Root Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
	animation.setKeys([
		{ frame: 0, value: new Vector3(0, 0, 0) },
		{ frame: 15, value: new Vector3(0.5, 0, 0) },
		{ frame: 30, value: new Vector3(1, 0, 0) },
	]);
	return animation.serialize();
}

describe("executed animation importer semantics", () => {
	test("resamples, reduces linear keys, applies loop defaults, and resolves root motion", () => {
		const result = executeAnimationImporterDocument(
			{
				name: "Walk",
				from: 0,
				to: 30,
				loopAnimation: false,
				targetedAnimations: [{ targetId: "Root", animation: positionAnimation() }],
			},
			"assets/walk.animation",
			normalizeAnimationImporterSettings({
				importClips: true,
				resampleRate: 60,
				compression: "keyframeReduction",
				loopByDefault: true,
				rootMotionNode: "Root",
			})
		);
		expect(result).toMatchObject({
			sourceKind: "animation-group",
			sourceKeyCount: 3,
			sampledKeyCount: 61,
			outputKeyCount: 2,
			rootMotion: { requestedNode: "Root", resolved: true, trackCount: 1, properties: ["position"] },
			clips: [{ name: "Walk", from: 0, to: 60, durationSeconds: 1, trackCount: 1, sourceKeyCount: 3, sampledKeyCount: 61, outputKeyCount: 2, loop: true }],
			tracks: [{ sourceFramesPerSecond: 30, outputFramesPerSecond: 60, sourceKeyCount: 3, sampledKeyCount: 61, outputKeyCount: 2 }],
			errors: [],
		});
		expect(result.document).toMatchObject({
			from: 0,
			to: 60,
			loopAnimation: true,
			targetedAnimations: [{ animation: { framePerSecond: 60, loopBehavior: Animation.ANIMATIONLOOPMODE_CYCLE } }],
		});
	});

	test("handles legacy track sets, disabled clips, and controller validation", () => {
		const disabled = executeAnimationImporterDocument(
			[positionAnimation()],
			"assets/motion.animations",
			normalizeAnimationImporterSettings({ importClips: false, resampleRate: 24, compression: "none", loopByDefault: false, rootMotionNode: "" })
		);
		expect(disabled).toMatchObject({
			sourceKind: "animation-track-set",
			document: [],
			clips: [],
			sourceKeyCount: 3,
			sampledKeyCount: 0,
			outputKeyCount: 0,
			errors: [],
		});

		const controller = executeAnimationImporterDocument(
			{
				states: [{ name: "Idle", animationGroup: "Idle" }],
				transitions: [{ from: "Idle", to: "Missing" }],
			},
			"assets/player.controller",
			normalizeAnimationImporterSettings({})
		);
		expect(controller).toMatchObject({
			sourceKind: "animator-controller",
			controllerStateCount: 1,
			controllerTransitionCount: 1,
			errors: ["Every Animator Controller transition must reference existing from/to state names."],
		});
	});

	test("preserves target metadata when a middle animation track is rejected", () => {
		const result = executeAnimationImporterDocument(
			{
				name: "Mixed",
				targetedAnimations: [
					{ targetId: "First", animation: positionAnimation() },
					{ targetId: "Broken", animation: { ...positionAnimation(), framePerSecond: 0 } },
					{ targetId: "Last", animation: positionAnimation() },
				],
			},
			"assets/mixed.animation",
			normalizeAnimationImporterSettings({ importClips: true, resampleRate: 30, compression: "none" })
		);
		expect(result.errors).toEqual(['Animation "Root Position" has an invalid frame rate.']);
		expect(result.document).toMatchObject({
			targetedAnimations: [{ targetId: "First" }, { targetId: "Last" }],
		});
		expect(result.tracks.map((track) => track.target)).toEqual(["First", "Last"]);
	});

	test("converts Unity YAML controllers into layered editor graphs with explicit bindings", () => {
		const result = executeAnimationImporterSource(unityAnimatorController(), "assets/hero.controller", normalizeAnimationImporterSettings({}));
		expect(result).toMatchObject({
			sourceKind: "animator-controller",
			controllerFormat: "unity-yaml",
			controllerLayerCount: 2,
			controllerParameterCount: 2,
			controllerStateCount: 3,
			controllerTransitionCount: 2,
			controllerBlendTreeCount: 1,
			errors: [],
		});
		expect(result.controllerMotionBindings).toHaveLength(4);
		expect(result.controllerAvatarMaskBindings).toHaveLength(1);
		expect(result.document).toMatchObject({
			format: "babylonjs-editor-animator-controller",
			sourceFormat: "unity-yaml",
			controller: {
				name: "Hero Controller",
				baseIKPass: true,
				parameters: { Speed: 0, Mode: 0 },
				parameterTypes: { Speed: "float", Mode: "int" },
				entryState: "Idle",
				states: [
					{ name: "Idle", animationGroup: "@unity-motion:11111111111111111111111111111111:7400000", graphPosition: [100, 120] },
					{
						name: "Move",
						blendTree: {
							parameter: "Speed",
							children: [
								{ animationGroup: "@unity-motion:22222222222222222222222222222222:7400000", threshold: 0 },
								{ animationGroup: "@unity-motion:33333333333333333333333333333333:7400000", threshold: 1 },
							],
						},
					},
				],
				transitions: [
					{ from: "Idle", to: "Move", conditions: [{ parameter: "Speed", greaterThan: 0.1 }], exitTime: 0.75, duration: 0.25, durationMode: "normalized" },
					{ from: "$any", to: "Idle", conditions: [{ parameter: "Mode", notEquals: 2 }] },
				],
				layers: [{ name: "Upper Body", weight: 0.75, blendingMode: "additive", avatarMaskId: "@unity-mask:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:31900000", ikPass: true }],
			},
		});
	});

	test("imports Unity synchronized-layer Motion overrides with qualified source-state bindings", () => {
		const result = executeAnimationImporterSource(unitySynchronizedOverrideController(), "assets/synced.controller", normalizeAnimationImporterSettings({}));
		expect(result.errors).toEqual([]);
		expect(result.controllerMotionBindings).toHaveLength(2);
		expect(result.document).toMatchObject({
			controller: {
				layers: [
					{
						name: "Damaged",
						synchronizedLayer: "$base",
						synchronizedTiming: true,
						synchronizedMotionOverrides: { Idle: { animationGroup: "@unity-motion:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:7400000" } },
					},
				],
			},
			unsupportedFeatures: [
				"Unity MonoBehaviour references used by synchronized-layer behaviour overrides require explicit Babylon script bindings and are not imported automatically.",
			],
		});
	});

	test("imports Unity conditional Entry and child-state-machine source transitions", () => {
		const result = executeAnimationImporterSource(unityConditionalEntryController(), "assets/conditional-entry.controller", normalizeAnimationImporterSettings({}));
		expect(result).toMatchObject({
			controllerStateCount: 2,
			controllerTransitionCount: 3,
			controllerParameterCount: 2,
			errors: [],
			document: {
				controller: {
					parameters: { Go: false, Done: false },
					parameterTypes: { Go: "bool", Done: "trigger" },
					entryState: "Idle",
					entryTransitions: [{ to: "Ground", conditions: [{ parameter: "Go", equals: true }] }],
					subStateMachines: [{ name: "Ground", subgraphId: "unity-state-machine:110700001" }],
					transitions: [{ from: "Ground", to: "Idle" }],
					subgraphs: [
						{
							id: "unity-state-machine:110700001",
							name: "Ground",
							entryState: "Run",
							transitions: [{ from: "Run", to: "$exit", conditions: [{ parameter: "Done", equals: true }] }],
						},
					],
				},
			},
		});
		expect(result.controllerMotionBindings).toHaveLength(2);
		expect((result.document as any).unsupportedFeatures).not.toContain(expect.stringContaining("conditional Entry"));
		expect((result.document as any).unsupportedFeatures).not.toContain(expect.stringContaining("child state-machine"));
	});

	test("preserves recursive Unity Blend Trees instead of rejecting nested Motion children", () => {
		const result = executeAnimationImporterSource(unityNestedBlendTreeController(), "assets/nested.controller", normalizeAnimationImporterSettings({}));
		expect(result).toMatchObject({
			controllerBlendTreeCount: 2,
			errors: [],
			document: {
				controller: {
					states: [
						{
							name: "Locomotion",
							blendTree: {
								parameter: "Speed",
								children: [
									{ animationGroup: "@unity-motion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:7400000", threshold: 0 },
									{
										threshold: 1,
										blendTree: {
											parameter: "Direction",
											children: [
												{ animationGroup: "@unity-motion:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:7400000", threshold: -1 },
												{ animationGroup: "@unity-motion:cccccccccccccccccccccccccccccccc:7400000", threshold: 1 },
											],
										},
									},
								],
							},
						},
					],
				},
			},
		});
		expect(result.controllerMotionBindings).toHaveLength(3);
		expect((result.document as any).unsupportedFeatures).not.toContain(expect.stringContaining("Nested Blend Trees"));
	});

	test("imports Unity Direct Blend Trees with per-child parameters and normalization", () => {
		const result = executeAnimationImporterSource(unityDirectBlendTreeController(), "assets/direct.controller", normalizeAnimationImporterSettings({}));
		expect(result).toMatchObject({
			controllerBlendTreeCount: 1,
			controllerParameterCount: 2,
			errors: [],
			document: {
				controller: {
					parameters: { Smile: 0.25, Blink: 0.75 },
					states: [
						{
							name: "Face",
							blendTree: {
								blendMode: "direct",
								normalizeWeights: true,
								children: [
									{
										animationGroup: "@unity-motion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:7400000",
										directParameter: "Smile",
										timeScale: 2,
										cycleOffset: 0.25,
										mirror: true,
									},
									{ animationGroup: "@unity-motion:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:7400000", directParameter: "Blink" },
								],
							},
						},
					],
				},
			},
		});
		expect(result.controllerMotionBindings).toHaveLength(2);
		expect((result.document as any).unsupportedFeatures).not.toContain(expect.stringContaining("Direct Blend Tree"));
		expect((result.document as any).unsupportedFeatures).not.toContain(expect.stringContaining("Per-child Blend Tree"));
	});
});

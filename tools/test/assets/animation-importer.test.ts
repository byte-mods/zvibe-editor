import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationKeyInterpolation } from "@babylonjs/core/Animations/animationKey";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
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
      m_Behaviours: [{fileID: 11400000}]
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineTransitions: []
  m_StateMachineBehaviours: [{fileID: 11400001}]
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Idle
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
  m_Transitions: []
  m_StateMachineBehaviours: [{fileID: 11400000}]
--- !u!114 &11400000
MonoBehaviour:
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: cccccccccccccccccccccccccccccccc, type: 3}
  m_Name: Damage State
  m_EditorClassIdentifier: Game.Runtime::DamageStateBehaviour
  damageMultiplier: 2.5
  emitParticles: 1
--- !u!114 &11400001
MonoBehaviour:
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: dddddddddddddddddddddddddddddddd, type: 3}
  m_Name: Machine Audit
  m_EditorClassIdentifier: Game.Runtime::MachineAuditBehaviour
  auditLabel: damaged
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

function unityVersionedStateController(options: { serializedVersion: number; footIKField: "m_IKOnFeet" | "m_FootIK"; parameterBindings?: boolean }): string {
	const bindings = options.parameterBindings
		? `  m_SpeedParameterActive: 1
  m_SpeedParameter: Rate
  m_MirrorParameterActive: 1
  m_MirrorParameter: Mirror State
  m_CycleOffsetParameterActive: 1
  m_CycleOffsetParameter: Phase
  m_TimeParameterActive: 1
  m_TimeParameter: Scrub Time
`
		: "";
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  serializedVersion: 5
  m_Name: Versioned Playback
  m_AnimatorParameters:
  - m_Name: Rate
    m_Type: 1
    m_DefaultFloat: 1
  - m_Name: Mirror State
    m_Type: 4
    m_DefaultBool: 0
  - m_Name: Phase
    m_Type: 1
    m_DefaultFloat: 0
  - m_Name: Scrub Time
    m_Type: 1
    m_DefaultFloat: 0
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  serializedVersion: 6
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
  serializedVersion: ${options.serializedVersion}
  m_Name: Reverse Locomotion
  m_Speed: -1.5
  m_CycleOffset: 0.25
  m_Mirror: 1
  m_Tag: Locomotion
  ${options.footIKField}: 1
  m_WriteDefaultValues: 0
${bindings}  m_Motion: {fileID: 7400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
  m_Transitions: []
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

function unityAnimationClip(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: Unity Walk
  m_RotationCurves:
  - curve:
      m_Curve:
      - time: 0
        value: {x: 0, y: 0, z: 0, w: 1}
        inSlope: {x: 0, y: 0, z: 0, w: 0}
        outSlope: {x: 0, y: 1, z: 0, w: 0}
        weightedMode: 2
        outWeight: 0.5
      - time: 1
        value: {x: 0, y: 0.70710678, z: 0, w: 0.70710678}
        inSlope: {x: 0, y: 1, z: 0, w: 0}
        outSlope: {x: 0, y: 0, z: 0, w: 0}
        weightedMode: 1
        inWeight: 0.25
    path: Root/Hips
  m_PositionCurves:
  - curve:
      m_Curve:
      - time: 0
        value: {x: 0, y: 0, z: 0}
        inSlope: {x: 0, y: 0, z: 0}
        outSlope: {x: 1, y: 0, z: 0}
      - time: 1
        value: {x: 1, y: 0, z: 0}
        inSlope: {x: 1, y: 0, z: 0}
        outSlope: {x: 0, y: 0, z: 0}
    path: Root/Hips
  m_EulerCurves: []
  m_ScaleCurves: []
  m_FloatCurves:
  - curve:
      m_Curve:
      - time: 0
        value: 0
        inSlope: 0
        outSlope: 1
      - time: 1
        value: 1
        inSlope: 1
        outSlope: 0
    attribute: blendShape.Smile
    path: Face
  m_PPtrCurves:
  - curve: []
    attribute: m_Sprite
    path: Sprite
  m_SampleRate: 30
  m_AnimationClipSettings:
    m_LoopTime: 1
    m_LoopBlend: 1
    m_CycleOffset: 0.25
  m_Events:
  - time: 0.5
    functionName: Footstep
    stringParameter: left
    floatParameter: 0.75
    intParameter: 2
    objectReferenceParameter: {fileID: 0}
`;
}

function packedUnsigned(values: number[], bitSize: number): string {
	const bytes = new Uint8Array(Math.ceil((values.length * bitSize) / 8));
	let bitOffset = 0;
	for (const value of values) {
		for (let bit = 0; bit < bitSize; bit++, bitOffset++) {
			if (Math.floor(value / 2 ** bit) % 2) {
				bytes[Math.floor(bitOffset / 8)] |= 1 << (bitOffset % 8);
			}
		}
	}
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function packedIdentityQuaternion(): number {
	return 3 + 256 * 2 ** 3 + 512 * 2 ** 12 + 512 * 2 ** 22;
}

function unityRuntimeCurveClip(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: Unity Runtime Curves
  m_RotationCurves: []
  m_CompressedRotationCurves:
  - m_Path: Root
    m_Times: {m_NumItems: 2, m_Data: "${packedUnsigned([0, 100], 7)}", m_BitSize: 7}
    m_Values: {m_NumItems: 2, m_Data: "${packedUnsigned([packedIdentityQuaternion(), packedIdentityQuaternion()], 32)}"}
    m_Slopes: {m_NumItems: 0, m_Data: "", m_BitSize: 0, m_Range: 0, m_Start: 0}
  m_PositionCurves: []
  m_EulerCurves: []
  m_ScaleCurves: []
  m_FloatCurves:
  - curve:
      m_Curve:
      - {time: 0, value: 1}
      - {time: 1, value: 0}
    attribute: m_IsActive
    path: Root
  m_PPtrCurves:
  - curve:
    - time: 0
      value: {fileID: 21300000, guid: abcdefabcdefabcdefabcdefabcdefab, type: 3}
    - time: 1
      value: {fileID: 0}
    attribute: m_Sprite
    path: Sprite
  m_SampleRate: 30
  m_AnimationClipSettings: {m_LoopTime: 1}
  m_Events: []
`;
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

	test("converts bounded Unity .anim YAML curves, weighted tangents, events, loop settings, and diagnostics", () => {
		const result = executeAnimationImporterSource(
			unityAnimationClip(),
			"assets/unity-walk.anim",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none", rootMotionNode: "Root/Hips" })
		);
		expect(result).toMatchObject({
			sourceKind: "unity-animation-clip",
			sourceFormat: "unity-animation-clip-yaml",
			outputFormat: "babylon-animation-group-json",
			sourceKeyCount: 6,
			sampledKeyCount: 6,
			outputKeyCount: 6,
			rootMotion: { requestedNode: "Root/Hips", resolved: true, trackCount: 2, properties: ["position", "rotationQuaternion"] },
			clips: [{ name: "Unity Walk", from: 0, to: 30, durationSeconds: 1, trackCount: 3, loop: true, eventCount: 1 }],
			roundTripSafe: false,
			errors: [],
		});
		expect(result.approximatedFeatures).toContain("Unity weighted temporal handles execute through Babylon fixed-time Hermite tangents using slope × 3 × weight.");
		const compressionAttempt = executeAnimationImporterSource(
			unityAnimationClip(),
			"assets/unity-walk.anim",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "keyframeReductionAndCompression" })
		);
		expect(compressionAttempt.tracks.every((track) => track.compression.requested === "keyframeReductionAndCompression" && track.compression.effective === "none")).toBe(true);
		expect(result.preservedFeatures).toContain("Unity blend-shape percentages are converted to Babylon MorphTarget influence values with explicit target identities.");
		expect(result.unsupportedFeatures).not.toContain(expect.stringContaining("Object-reference curves"));
		expect(result.warnings).toContain("Unity object-reference curve 0 (m_Sprite) is empty and was ignored.");
		expect(result.document).toMatchObject({
			name: "Unity Walk",
			from: 0,
			to: 30,
			loopAnimation: true,
			metadata: {
				babylonEditorUnityAnimationClip: { sampleRate: 30, loopTime: true, loopPose: true, cycleOffset: 0.25, events: [{ frame: 15, functionName: "Footstep" }] },
				babylonEditorAnimationTangentModes: expect.arrayContaining([
					expect.objectContaining({ targetId: "Root/Hips", property: "rotationQuaternion", frame: 0, component: 1, mode: "weighted", outWeight: 0.5 }),
				]),
			},
			targetedAnimations: [
				{ targetId: "Root/Hips", animation: { property: "position", framePerSecond: 30, loopBehavior: Animation.ANIMATIONLOOPMODE_CYCLE } },
				{ targetId: "Root/Hips", animation: { property: "rotationQuaternion", framePerSecond: 30, loopBehavior: Animation.ANIMATIONLOOPMODE_CYCLE } },
				{ targetId: "Face#blendShape:Smile", animation: { property: "influence", framePerSecond: 30, loopBehavior: Animation.ANIMATIONLOOPMODE_CYCLE } },
			],
		});
		expect((result.document as any).targetedAnimations[2].animation.keys[1].values[0]).toBeCloseTo(0.01);
	});

	test("decodes legacy compressed rotations and preserves executable active-state and exact object-reference curves", () => {
		const result = executeAnimationImporterSource(
			unityRuntimeCurveClip(),
			"assets/runtime-curves.anim",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none" })
		);
		expect(result).toMatchObject({
			sourceKind: "unity-animation-clip",
			sourceKeyCount: 6,
			outputKeyCount: 6,
			activeStateCurveCount: 1,
			compressedRotationCurveCount: 1,
			errors: [],
			unsupportedFeatures: [],
		});
		expect(result.preservedFeatures).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Legacy Unity compressed rotation curves"),
				expect.stringContaining("m_IsActive curves execute"),
				expect.stringContaining("exact GUID/fileID/type identities"),
			])
		);
		expect(result.objectReferenceCurves).toEqual([
			expect.objectContaining({
				target: "Sprite",
				attribute: "m_Sprite",
				references: [
					{ key: "abcdefabcdefabcdefabcdefabcdefab:21300000:3", fileId: "21300000", guid: "abcdefabcdefabcdefabcdefabcdefab", type: 3 },
					{ key: "local:0:0", fileId: "0", guid: null, type: 0 },
				],
				keys: [
					{ frame: 0, referenceKey: "abcdefabcdefabcdefabcdefabcdefab:21300000:3" },
					{ frame: 30, referenceKey: "local:0:0" },
				],
			}),
		]);
		const tracks = (result.document as any).targetedAnimations;
		const compressed = tracks.find((track: any) => track.animation.property === "rotationQuaternion");
		const active = tracks.find((track: any) => track.animation.property === "__babylonEditorUnityActiveState");
		const objectReference = tracks.find((track: any) => track.animation.property.startsWith("__babylonEditorUnityObjectReference_"));
		expect(compressed.animation.keys.map((key: any) => key.frame)).toEqual([0, 30]);
		expect(compressed.animation.keys[0].values[3]).toBeCloseTo(1, 4);
		expect(active.animation.keys.map((key: any) => [key.frame, key.values[0], key.values[3]])).toEqual([
			[0, 1, AnimationKeyInterpolation.STEP],
			[30, 0, AnimationKeyInterpolation.STEP],
		]);
		expect(objectReference.animation.keys.map((key: any) => [key.frame, key.values[0], key.values[3]])).toEqual([
			[0, 0, AnimationKeyInterpolation.STEP],
			[30, 1, AnimationKeyInterpolation.STEP],
		]);

		const resampled = executeAnimationImporterSource(
			unityRuntimeCurveClip(),
			"assets/runtime-curves.anim",
			normalizeAnimationImporterSettings({ resampleCurves: true, resampleRate: 60, compression: "optimal" })
		);
		const discreteTracks = resampled.tracks.filter(
			(track) => track.property === "__babylonEditorUnityActiveState" || track.property.startsWith("__babylonEditorUnityObjectReference_")
		);
		expect(discreteTracks).toHaveLength(2);
		expect(discreteTracks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourceKeyCount: 2, sampledKeyCount: 2, outputKeyCount: 2, outputFramesPerSecond: 60, from: 0, to: 60 }),
				expect.objectContaining({ sourceKeyCount: 2, sampledKeyCount: 2, outputKeyCount: 2, outputFramesPerSecond: 60, from: 0, to: 60 }),
			])
		);
		expect(resampled).toMatchObject({ sourceKeyCount: 6, sampledKeyCount: 65, outputKeyCount: 6 });
	});

	test("enforces profile-specific error bounds, escalates quantization precision, and preserves authored tangent keys", () => {
		const nonlinear = new Animation("Nonlinear Float", "customValue", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
		nonlinear.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 5, value: 0.37 },
			{ frame: 10, value: 1 },
		]);
		const compressed = executeAnimationImporterDocument(
			[nonlinear.serialize()],
			"assets/nonlinear.animations",
			normalizeAnimationImporterSettings({
				resampleCurves: false,
				compression: "keyframeReductionAndCompression",
				floatError: 0.001,
				quantizationBits: 8,
			})
		);
		expect(compressed.tracks[0].compression).toMatchObject({
			requested: "keyframeReductionAndCompression",
			effective: "keyframeReductionAndCompression",
			errorMetric: "absolute",
			allowedError: 0.001,
			quantizationBits: 9,
			protectedKeyCount: 2,
			removedKeyCount: 0,
		});
		expect(compressed.tracks[0].compression.maximumObservedError).toBeLessThanOrEqual(0.001);

		const authored = new Animation("Authored Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
		authored.setKeys([
			{ frame: 0, value: new Vector3(0, 0, 0), outTangent: new Vector3(1, 0, 0) },
			{ frame: 15, value: new Vector3(0.5, 0, 0), inTangent: new Vector3(1, 0, 0), outTangent: new Vector3(1, 0, 0) },
			{ frame: 30, value: new Vector3(1, 0, 0), inTangent: new Vector3(1, 0, 0) },
		]);
		const preserved = executeAnimationImporterDocument(
			[authored.serialize()],
			"assets/authored.animations",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "keyframeReduction", positionErrorPercent: 100 })
		);
		expect(preserved).toMatchObject({ sampledKeyCount: 3, outputKeyCount: 3, roundTripSafe: false });
		expect(preserved.tracks[0].compression).toMatchObject({ effective: "none", quantizationBits: null, protectedKeyCount: 3, removedKeyCount: 0 });
		expect((preserved.document as any)[0].keys[1].values[3]).toEqual([1, 0, 0]);
	});

	test("does not quantize stepped values and bounds quaternion reduction in degrees", () => {
		const stepped = new Animation("Stepped", "customValue", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
		stepped.setKeys([
			{ frame: 0, value: 0, interpolation: AnimationKeyInterpolation.STEP },
			{ frame: 15, value: 0.37 },
			{ frame: 30, value: 1 },
		]);
		const steppedResult = executeAnimationImporterDocument(
			[stepped.serialize()],
			"assets/stepped.animations",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "keyframeReductionAndCompression", floatError: 1, quantizationBits: 8 })
		);
		expect(steppedResult.tracks[0].compression).toMatchObject({ effective: "keyframeReduction", quantizationBits: null });
		expect((steppedResult.document as any)[0].keys[1].values[0]).toBe(0.37);

		const rotation = new Animation("Rotation", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CONSTANT);
		rotation.setKeys([
			{ frame: 0, value: Quaternion.RotationYawPitchRoll(0, 0, 0) },
			{ frame: 15, value: Quaternion.RotationYawPitchRoll(Math.PI / 4, 0, 0) },
			{ frame: 30, value: Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0) },
		]);
		const rotationResult = executeAnimationImporterDocument(
			[rotation.serialize()],
			"assets/rotation.animations",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "keyframeReduction", rotationErrorDegrees: 0.01 })
		);
		expect(rotationResult).toMatchObject({ sampledKeyCount: 3, outputKeyCount: 2 });
		expect(rotationResult.tracks[0].compression).toMatchObject({ errorMetric: "rotation-degrees", allowedError: 0.01 });
		expect(rotationResult.tracks[0].compression.maximumObservedError).toBeLessThanOrEqual(0.01);
	});

	test("reports malformed Unity weights and Animation Event times without publishing silent defaults", () => {
		const invalid = executeAnimationImporterSource(
			unityAnimationClip().replace("weightedMode: 2", "weightedMode: 4").replace("time: 0.5\n    functionName", "time: invalid\n    functionName"),
			"assets/invalid.anim",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none" })
		);
		expect(invalid.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("weightedMode must be an integer from 0 through 3"), "Unity Animation Event 0 requires a finite non-negative time."])
		);
	});

	test("rejects duplicate frames and resampling requests that exceed the bounded key budget", () => {
		const duplicate = positionAnimation() as any;
		duplicate.keys[1].frame = duplicate.keys[0].frame;
		const duplicateResult = executeAnimationImporterDocument(
			[duplicate],
			"assets/duplicate.animations",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none" })
		);
		expect(duplicateResult.errors).toEqual([expect.stringContaining("key frames must be unique and ascending")]);

		const excessive = new Animation("Excessive", "position.x", 1, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
		excessive.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 10_000, value: 1 },
		]);
		const excessiveResult = executeAnimationImporterDocument(
			[excessive.serialize()],
			"assets/excessive.animations",
			normalizeAnimationImporterSettings({ resampleCurves: true, resampleRate: 240, compression: "none" })
		);
		expect(excessiveResult.errors).toEqual([expect.stringContaining("would exceed 2,000,000 keys")]);
	});

	test("removes only exact default-scale tracks when explicitly requested", () => {
		const scale = new Animation("Default Scale", "scaling", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
		scale.setKeys([
			{ frame: 0, value: Vector3.One() },
			{ frame: 30, value: Vector3.One() },
		]);
		const result = executeAnimationImporterDocument(
			[scale.serialize(), positionAnimation()],
			"assets/scale.animations",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none", removeConstantScaleCurves: true })
		);
		expect(result).toMatchObject({ removedConstantScaleTrackCount: 1, sourceKeyCount: 5, sampledKeyCount: 3, outputKeyCount: 3 });
		expect(result.tracks).toHaveLength(1);
		const groupResult = executeAnimationImporterDocument(
			{
				name: "Scale",
				targetedAnimations: [{ targetId: "Root", animation: scale.serialize() }],
				metadata: {
					babylonEditorAnimationTangentModes: [{ targetId: "Root", property: "scaling", frame: 0, component: 0, effectiveInTangent: 0, effectiveOutTangent: 0 }],
				},
			},
			"assets/scale.animation",
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none", removeConstantScaleCurves: true })
		);
		expect((groupResult.document as any).metadata.babylonEditorAnimationTangentModes).toEqual([]);
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
		expect(result.controllerBehaviourBindingCount).toBe(2);
		expect(result.controllerBehaviourBindings).toEqual([
			expect.objectContaining({
				key: "@unity-behaviour:local:11400000",
				scriptGuid: "cccccccccccccccccccccccccccccccc",
				scriptClassHint: "DamageStateBehaviour",
				serializedFieldsJson: '{"damageMultiplier":"2.5","emitParticles":"1"}',
				diagnostics: [],
			}),
			expect.objectContaining({
				key: "@unity-behaviour:local:11400001",
				scriptGuid: "dddddddddddddddddddddddddddddddd",
				scriptClassHint: "MachineAuditBehaviour",
				serializedFieldsJson: '{"auditLabel":"damaged"}',
				diagnostics: [],
			}),
		]);
		expect(result.document).toMatchObject({
			controller: {
				behaviours: [{ scriptKey: "@unity-behaviour:local:11400001" }],
				states: [{ name: "Idle", behaviours: [{ scriptKey: "@unity-behaviour:local:11400000" }] }],
				layers: [
					{
						name: "Damaged",
						behaviours: [{ scriptKey: "@unity-behaviour:local:11400001" }],
						synchronizedLayer: "$base",
						synchronizedTiming: true,
						synchronizedMotionOverrides: { Idle: { animationGroup: "@unity-motion:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:7400000" } },
						synchronizedBehaviourOverrides: { Idle: [{ scriptKey: "@unity-behaviour:local:11400000" }] },
					},
				],
			},
			unsupportedFeatures: [],
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

	test("retains legacy and modern Unity AnimatorState serialization variants with executable static playback", () => {
		const legacy = executeAnimationImporterSource(
			unityVersionedStateController({ serializedVersion: 5, footIKField: "m_FootIK" }),
			"assets/legacy.controller",
			normalizeAnimationImporterSettings({})
		);
		const modern = executeAnimationImporterSource(
			unityVersionedStateController({ serializedVersion: 6, footIKField: "m_IKOnFeet", parameterBindings: true }),
			"assets/modern.controller",
			normalizeAnimationImporterSettings({})
		);

		expect(legacy.errors).toEqual([]);
		expect(legacy.controllerCompatibility).toMatchObject({
			yamlVersion: "1.1",
			stateSerializationProfile: "legacy-v5-or-earlier",
			fieldVariants: ["AnimatorState.m_FootIK", "AnimatorState.m_WriteDefaultValues"],
		});
		expect((legacy.document as any).controller.states[0]).toMatchObject({
			name: "Reverse Locomotion",
			speed: -1.5,
			cycleOffset: 0.25,
			mirror: true,
			tag: "Locomotion",
			footIK: true,
			writeDefaultValues: false,
			unitySource: { fileId: "110200000", serializedVersion: 5, footIKField: "m_FootIK" },
		});
		expect(modern.errors).toEqual([]);
		expect(modern.controllerCompatibility).toMatchObject({
			stateSerializationProfile: "modern-v6-or-later",
			fieldVariants: ["AnimatorState.m_IKOnFeet", "AnimatorState.m_TimeParameterActive", "AnimatorState.m_WriteDefaultValues"],
		});
		expect((modern.document as any).controller.states[0]).toMatchObject({
			speed: -1.5,
			cycleOffset: 0.25,
			mirror: true,
			speedParameter: "Rate",
			mirrorParameter: "Mirror State",
			cycleOffsetParameter: "Phase",
			timeParameter: "Scrub Time",
			unitySource: {
				serializedVersion: 6,
				footIKField: "m_IKOnFeet",
				speedParameter: "Rate",
				mirrorParameter: "Mirror State",
				cycleOffsetParameter: "Phase",
				timeParameter: "Scrub Time",
			},
		});
		expect(modern.controllerUnsupportedFeatures).not.toContain(expect.stringContaining("parameter bindings"));
		expect(modern.controllerUnsupportedFeatures).not.toContain(expect.stringContaining("Foot IK"));
		expect(modern.controllerUnsupportedFeatures).not.toContain(expect.stringContaining("Write Defaults"));
		const missingBinding = executeAnimationImporterSource(
			unityVersionedStateController({ serializedVersion: 6, footIKField: "m_IKOnFeet", parameterBindings: true }).replace(
				"m_SpeedParameter: Rate",
				"m_SpeedParameter: Missing Rate"
			),
			"assets/missing-state-binding.controller",
			normalizeAnimationImporterSettings({})
		);
		expect(missingBinding.errors).toContain('Animator state "Base Layer/Reverse Locomotion" speed parameter binding "Missing Rate" does not reference a controller parameter.');
	});
});

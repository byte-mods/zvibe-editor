import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join, relative } from "path";

import { Animation, AnimationGroup, Mesh, MorphTarget, MorphTargetManager, NullEngine, Scene, Sprite, SpriteManager, TransformNode, Vector3 } from "babylonjs";
import { normalizeAnimationImporterSettings } from "babylonjs-editor-tools";

import { applyAnimationImporterArtifact, getAnimationImporterArtifactStatus, processAnimationImporterOutput } from "../../src/mcp/assets/animation-importer";
import { applyAnimationImporter, getAnimationImporterResult, getAnimatorControllerAssetImport, importAnimatorControllerAsset } from "../../src/mcp/assets/assets";
import { importAnimationGroup } from "../../src/mcp/animations/animations";
import { UNITY_ANIMATION_SOURCE_METADATA_KEY } from "../../src/mcp/assets/unity-animator-dependencies";
import { getAssetTypeFromPath, readAssetMetadata, refreshAssetRegistryPaths, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

function animationGroupDocument(): Record<string, unknown> {
	const animation = new Animation("Root Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
	animation.setKeys([
		{ frame: 0, value: new Vector3(0, 0, 0) },
		{ frame: 15, value: new Vector3(0.5, 0, 0) },
		{ frame: 30, value: new Vector3(1, 0, 0) },
	]);
	return {
		name: "Walk",
		from: 0,
		to: 30,
		loopAnimation: false,
		targetedAnimations: [{ targetId: "Root", animation: animation.serialize() }],
	};
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
      - time: 1
        value: {x: 1, y: 0, z: 0}
    path: Root/Hips
  m_EulerCurves: []
  m_ScaleCurves: []
  m_FloatCurves:
  - curve:
      m_Curve:
      - time: 0
        value: 0
      - time: 1
        value: 100
    attribute: blendShape.Smile
    path: Face
  m_PPtrCurves: []
  m_SampleRate: 30
  m_AnimationClipSettings:
    m_LoopTime: 1
  m_Events: []
`;
}

function unityExecutableReferenceClip(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: Unity Executable References
  m_RotationCurves: []
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

function unityMeta(guid: string): string {
	return `fileFormatVersion: 2\nguid: ${guid}\nNativeFormatImporter:\n  externalObjects: {}\n`;
}

function unityMaskBits(enabled: number[]): string {
	const bytes = Buffer.alloc(13 * 4);
	for (const index of enabled) {
		bytes.writeUInt32LE(1, index * 4);
	}
	return bytes.toString("hex");
}

function unityAvatarMask(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!319 &31900000
AvatarMask:
  m_Name: Upper Body
  m_Mask: ${unityMaskBits([0, 1, 2, 5, 6, 7, 8])}
  m_Elements:
  - m_Path:
    m_Weight: 1
  - m_Path: Root/Spine
    m_Weight: 1
  - m_Path: Root/Leg
    m_Weight: 0
`;
}

function unityDependencyController(motionGuid: string, maskGuid: string): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Dependency Hero
  m_AnimatorParameters: []
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 0}
    m_DefaultWeight: 1
    m_SyncedLayerIndex: -1
  - m_Name: Upper Body
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 31900000, guid: ${maskGuid}, type: 2}
    m_DefaultWeight: 1
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
    m_Position: {x: 100, y: 100, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Walk State
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: ${motionGuid}, type: 2}
  m_Transitions: []
`;
}

function unityBehaviourController(scriptGuid: string): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Behaviour Hero
  m_AnimatorParameters: []
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: -1
  - m_Name: Override Layer
    m_StateMachine: {fileID: 110700000}
    m_SyncedLayerIndex: 0
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
  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}
  m_Name: Damage State
  m_EditorClassIdentifier: Game.Runtime::DamageStateBehaviour
  multiplier: 2.5
--- !u!114 &11400001
MonoBehaviour:
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}
  m_Name: Machine Audit
  m_EditorClassIdentifier: Game.Runtime::MachineAuditBehaviour
  label: root
`;
}

function unityAnimatorController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Hero
  m_AnimatorParameters:
  - m_Name: Speed
    m_Type: 1
    m_DefaultFloat: 0
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 0}
    m_BlendingMode: 0
    m_DefaultWeight: 1
    m_IKPass: 1
    m_SyncedLayerIndex: -1
  - m_Name: Damaged
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 0}
    m_BlendingMode: 0
    m_DefaultWeight: 1
    m_IKPass: 0
    m_SyncedLayerIndex: 0
    m_SyncedLayerAffectsTiming: 1
    m_Motions:
    - m_State: {fileID: 110200001}
      m_Motion: {fileID: 7400000, guid: 33333333333333333333333333333333, type: 2}
    m_Behaviours: []
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
    m_Position: {x: 100, y: 100, z: 0}
  - m_State: {fileID: 110200001}
    m_Position: {x: 300, y: 100, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Idle
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: 11111111111111111111111111111111, type: 2}
  m_Transitions:
  - {fileID: 110100000}
--- !u!1102 &110200001
AnimatorState:
  m_Name: Run
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: 22222222222222222222222222222222, type: 2}
  m_Transitions: []
--- !u!1101 &110100000
AnimatorStateTransition:
  m_DstState: {fileID: 110200001}
  m_DstStateMachine: {fileID: 0}
  m_Conditions:
  - m_ConditionMode: 3
    m_ConditionEvent: Speed
    m_EventTreshold: 0.1
  m_TransitionDuration: 0.2
  m_TransitionOffset: 0
  m_HasExitTime: 0
  m_HasFixedDuration: 1
  m_InterruptionSource: 0
  m_OrderedInterruption: 0
  m_CanTransitionToSelf: 0
  m_IsExit: 0
`;
}

function unityNestedBlendTreeController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Nested
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
  m_Name: Direct
  m_AnimatorParameters:
  - m_Name: First
    m_Type: 1
    m_DefaultFloat: 0.25
  - m_Name: Second
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
    m_DirectBlendParameter: First
    m_TimeScale: 2
    m_CycleOffset: 0.25
    m_Mirror: 1
  - m_Motion: {fileID: 7400000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}
    m_DirectBlendParameter: Second
`;
}

function unityConditionalEntryController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: Conditional Entry
  m_AnimatorParameters:
  - m_Name: Go
    m_Type: 4
    m_DefaultBool: 1
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
    second:
    - {fileID: 110900001}
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

describe("executed animation importer", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-animation-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("classifies Unity .anim clips as animation assets", () => {
		expect(getAssetTypeFromPath("assets/walk.anim")).toBe("animation");
	});

	test("resamples and reduces an AnimationGroup with loop and root-motion evidence", async () => {
		const source = join(directory, "assets", "walk.animation");
		const output = join(directory, "build", "assets", "walk.animation");
		await writeJSON(source, animationGroupDocument());
		const result = await processAnimationImporterOutput(
			source,
			output,
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
			valid: true,
			sourceKeyCount: 3,
			sampledKeyCount: 61,
			outputKeyCount: 2,
			reducedKeyCount: 59,
			rootMotion: { requestedNode: "Root", resolved: true, properties: ["position"] },
			clips: [{ name: "Walk", from: 0, to: 60, durationSeconds: 1, loop: true }],
		});
		expect(await pathExists(output)).toBe(true);
		expect(await readJSON(output)).toMatchObject({ from: 0, to: 60, loopAnimation: true, targetedAnimations: [{ animation: { framePerSecond: 60 } }] });
	});

	test("validates legacy track sets and Animator Controllers without silently accepting invalid data", async () => {
		const legacy = join(directory, "assets", "legacy.animations");
		await writeJSON(legacy, [(animationGroupDocument().targetedAnimations as Array<{ animation: unknown }>)[0].animation]);
		const disabled = await processAnimationImporterOutput(
			legacy,
			join(directory, "build", "assets", "legacy.animations"),
			normalizeAnimationImporterSettings({ importClips: false, resampleRate: 24, compression: "none", loopByDefault: false, rootMotionNode: "" })
		);
		expect(disabled).toMatchObject({ sourceKind: "animation-track-set", valid: true, clips: [], sourceKeyCount: 3, sampledKeyCount: 0, outputKeyCount: 0 });
		expect(await readJSON(disabled.outputPath)).toEqual([]);

		const controller = join(directory, "assets", "player.controller");
		await writeJSON(controller, { states: [{ name: "Idle" }], transitions: [{ from: "Idle", to: "Missing" }] });
		const invalid = await processAnimationImporterOutput(controller, join(directory, "build", "assets", "player.controller"), normalizeAnimationImporterSettings({}));
		expect(invalid).toMatchObject({
			sourceKind: "animator-controller",
			valid: false,
			controllerStateCount: 1,
			controllerTransitionCount: 1,
			errors: ["Every Animator Controller transition must reference existing from/to state names."],
		});
	});

	test("leases and applies animation evidence through the shared MCP path", async () => {
		const source = join(directory, "assets", "leased.animation");
		await writeJSON(source, animationGroupDocument());
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = {
			...metadata.importer.settings,
			importClips: true,
			resampleRate: 60,
			compression: "keyframeReduction",
			loopByDefault: true,
			rootMotionNode: "Root",
		};
		await writeAssetMetadata(source, metadata);
		const planned = await getAnimationImporterArtifactStatus(source);
		expect(planned).toMatchObject({ current: false, exists: false });
		const applied = await applyAnimationImporterArtifact(source, planned.fingerprint);
		expect(applied).toMatchObject({ current: true, result: { valid: true, outputKeyCount: 2 } });

		const changed = await readJSON(source);
		changed.name = "Changed";
		await writeJSON(source, changed);
		expect(await getAnimationImporterArtifactStatus(source)).toMatchObject({ current: false, exists: true });
		await expect(applyAnimationImporterArtifact(source, planned.fingerprint)).rejects.toThrow("plan changed");

		const scene = {} as Scene;
		const mcpPlan = await getAnimationImporterResult(scene, { path: "assets/leased.animation" });
		await expect(applyAnimationImporter(scene, { path: "assets/leased.animation", expectedFingerprint: mcpPlan.fingerprint, confirm: false }, {} as never)).rejects.toThrow(
			"confirm=true"
		);
		const refresh = vi.fn();
		const mcpResult = await applyAnimationImporter(scene, { path: "assets/leased.animation", expectedFingerprint: mcpPlan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh } } },
		} as never);
		expect(mcpResult).toMatchObject({
			applied: true,
			current: true,
			result: { sourcePath: "assets/leased.animation", valid: true, sourceKind: "animation-group", outputKeyCount: 2, trackCount: 1, tracksTruncated: false },
		});
		expect(JSON.stringify(mcpResult)).not.toContain(directory);
		expect(refresh).toHaveBeenCalledOnce();
	});

	test("imports a processed Unity clip through exact node and MorphTarget bindings without destroying an existing group on validation failure", async () => {
		const source = join(directory, "assets", "unity-walk.anim");
		const unityGuid = "66666666666666666666666666666666";
		await writeFile(source, unityAnimationClip());
		await writeFile(`${source}.meta`, unityMeta(unityGuid));
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = { ...metadata.importer.settings, resampleCurves: false, compression: "none" };
		await writeAssetMetadata(source, metadata);
		await refreshAssetRegistryPaths(["assets"]);
		const plan = await getAnimationImporterArtifactStatus(source);
		const artifact = await applyAnimationImporterArtifact(source, plan.fingerprint);
		expect(artifact.result).toMatchObject({ sourceKind: "unity-animation-clip", valid: true, outputKeyCount: 6 });

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const hips = new TransformNode("Hips", scene);
		const face = new Mesh("Face Mesh", scene);
		const manager = new MorphTargetManager(scene);
		const smile = new MorphTarget("Smile", 0, scene);
		manager.addTarget(smile);
		face.morphTargetManager = manager;
		const original = new AnimationGroup("Unity Walk", scene);
		const inspector = { setEditedObject: vi.fn(), forceUpdate: vi.fn() };
		const path = relative(directory, artifact.result!.outputPath).replace(/\\/g, "/");
		const targetBindings = [
			{ kind: "node", sourceTarget: "Root/Hips", nodeId: hips.id },
			{ kind: "morphTarget", sourceTarget: "Face#blendShape:Smile", meshId: face.id, morphTargetName: "Smile" },
		];

		await expect(
			importAnimationGroup(
				scene,
				{
					path,
					targetBindings: [{ kind: "node", sourceTarget: "Unused", nodeId: hips.id }],
				},
				{ editor: { layout: { inspector } } } as never
			)
		).rejects.toThrow("cannot be resolved");
		expect(scene.getAnimationGroupByName("Unity Walk")).toBe(original);
		await expect(importAnimationGroup(scene, { path, targetBindings }, { editor: { layout: { inspector } } } as never)).rejects.toThrow("replaceExisting=true");
		expect(scene.getAnimationGroupByName("Unity Walk")).toBe(original);

		const imported = await importAnimationGroup(
			scene,
			{
				path,
				replaceExisting: true,
				targetBindings,
				unitySourceAssetPath: "assets/unity-walk.anim",
				unityFileId: "7400000",
			},
			{ editor: { layout: { inspector } } } as never
		);
		expect(imported).toMatchObject({ imported: true, replaced: true, name: "Unity Walk", bindingCount: 2 });
		const group = scene.getAnimationGroupByName("Unity Walk")!;
		expect(group).not.toBe(original);
		expect(group.targetedAnimations.map((targeted) => targeted.target)).toEqual([hips, hips, smile]);
		expect(group.targetedAnimations[2].animation.targetProperty).toBe("influence");
		expect(group.targetedAnimations[2].animation.getKeys()[1].value).toBe(1);
		const rotation = group.targetedAnimations.find((targeted) => targeted.animation.targetProperty === "rotationQuaternion")!.animation;
		expect(rotation.getKeys()[0].outTangent.asArray()).toEqual([0, 1.5 / 30, 0, 0]);
		expect(rotation.getKeys()[1].inTangent.asArray()).toEqual([0, 0.75 / 30, 0, 0]);
		expect(group.metadata.babylonEditorAnimationTangentModes.every((mode: any) => mode.targetId === (mode.property === "influence" ? smile.id : hips.id))).toBe(true);
		expect(group.metadata.babylonEditorAnimationImportBindings).toHaveLength(2);
		expect(group.metadata[UNITY_ANIMATION_SOURCE_METADATA_KEY]).toMatchObject({ guid: unityGuid, fileId: "7400000", path: "assets/unity-walk.anim", name: "Unity Walk" });
		expect(inspector.forceUpdate).toHaveBeenCalledOnce();
		const preservedInspector = { setEditedObject: vi.fn(), forceUpdate: vi.fn() };
		await importAnimationGroup(
			scene,
			{ path, name: "Unity Walk Inspector", targetBindings, preserveInspectorSelection: true, unitySourceAssetPath: "assets/unity-walk.anim" },
			{
				editor: { layout: { inspector: preservedInspector } },
			} as never
		);
		expect(preservedInspector.setEditedObject).not.toHaveBeenCalled();
		expect(preservedInspector.forceUpdate).not.toHaveBeenCalled();
		scene.dispose();
		engine.dispose();
	});

	test("imports and executes Unity active-state and exact object-reference curves through MCP bindings", async () => {
		const source = join(directory, "assets", "unity-runtime.anim");
		await writeFile(source, unityExecutableReferenceClip());
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = { ...metadata.importer.settings, resampleCurves: false, compression: "none" };
		await writeAssetMetadata(source, metadata);
		const planned = await getAnimationImporterArtifactStatus(source);
		const artifact = await applyAnimationImporterArtifact(source, planned.fingerprint);
		expect(artifact.result).toMatchObject({
			sourceKind: "unity-animation-clip",
			valid: true,
			activeStateCurveCount: 1,
			compressedRotationCurveCount: 0,
			objectReferenceCurves: [
				{
					target: "Sprite",
					attribute: "m_Sprite",
					references: [{ key: "abcdefabcdefabcdefabcdefabcdefab:21300000:3" }, { key: "local:0:0" }],
				},
			],
		});

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const root = new TransformNode("Root", scene);
		const manager = new SpriteManager(
			"Sprites",
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z1+uAAAAAElFTkSuQmCC",
			4,
			1,
			scene
		);
		const sprite = new Sprite("Hero Sprite", manager);
		const curve = artifact.result!.objectReferenceCurves![0];
		const path = relative(directory, artifact.result!.outputPath).replace(/\\/g, "/");
		const objectReferenceBindings = [
			{
				curveId: curve.id,
				propertyPath: "cellIndex",
				references: [
					{ referenceKey: "abcdefabcdefabcdefabcdefabcdefab:21300000:3", value: { kind: "number", value: 3 } },
					{ referenceKey: "local:0:0", value: { kind: "number", value: -1 } },
				],
			},
		];
		await expect(
			importAnimationGroup(
				scene,
				{
					path,
					targetBindings: [
						{ kind: "node", sourceTarget: "Root", nodeId: root.id },
						{ kind: "sprite", sourceTarget: "Sprite", spriteName: sprite.name, managerName: manager.name },
					],
					objectReferenceBindings: [{ ...objectReferenceBindings[0], references: [{ referenceKey: "wrong", value: { kind: "null" } }] }],
				},
				{ editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as never
			)
		).rejects.toThrow("requires exactly 2 reference value binding");
		expect(scene.getAnimationGroupByName("Unity Executable References")).toBeNull();

		const imported = await importAnimationGroup(
			scene,
			{
				path,
				targetBindings: [
					{ kind: "node", sourceTarget: "Root", nodeId: root.id },
					{ kind: "sprite", sourceTarget: "Sprite", spriteName: sprite.name, managerName: manager.name },
				],
				objectReferenceBindings,
			},
			{ editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as never
		);
		expect(imported).toMatchObject({
			imported: true,
			bindingCount: 2,
			objectReferenceBindingCount: 1,
			unityRuntimeEvidence: {
				activeStateTrackCount: 1,
				objectReferenceTrackCount: 1,
				boundObjectReferenceCurveCount: 1,
				unresolvedObjectReferenceCurveIds: [],
			},
		});
		const group = scene.getAnimationGroupByName("Unity Executable References")!;
		(root as any).__babylonEditorUnityActiveState = 0;
		expect(root.isEnabled()).toBe(false);
		(sprite as any)[curve.trackProperty] = 0;
		expect(sprite.cellIndex).toBe(3);
		(sprite as any)[curve.trackProperty] = 1;
		expect(sprite.cellIndex).toBe(-1);
		expect(group.metadata.babylonEditorUnityAnimationRuntimeEvidence).toMatchObject({
			lastAppliedActiveState: { targetName: "Root", enabled: false },
			lastAppliedObjectReference: { curveId: curve.id, targetName: sprite.name, propertyPath: "cellIndex", referenceKey: "local:0:0", valueKind: "number" },
		});
		scene.dispose();
		engine.dispose();
	});

	test("converts and imports a Unity YAML Animator Controller through exact MCP bindings", async () => {
		const source = join(directory, "assets", "hero.controller");
		await writeFile(source, unityAnimatorController());
		const planned = await getAnimationImporterArtifactStatus(source);
		const artifact = await applyAnimationImporterArtifact(source, planned.fingerprint);
		expect(artifact).toMatchObject({
			current: true,
			result: { valid: true, controllerFormat: "unity-yaml", controllerStateCount: 4, controllerTransitionCount: 2, controllerLayerCount: 2 },
		});

		const engine = new NullEngine();
		const scene = new Scene(engine);
		new AnimationGroup("Idle", scene);
		new AnimationGroup("Run", scene);
		new AnimationGroup("Sprint", scene);
		const inspection = await getAnimatorControllerAssetImport(scene, { path: "assets/hero.controller" });
		expect(inspection).toMatchObject({
			ready: false,
			controller: { name: "Hero", baseIKPass: true, entryState: "Idle", parameters: { Speed: 0 }, parameterTypes: { Speed: "float" } },
			unresolvedMotionBindings: ["@unity-motion:33333333333333333333333333333333:7400000"],
		});
		const inspector = { setEditedObject: vi.fn(), forceUpdate: vi.fn() };
		const imported = await importAnimatorControllerAsset(
			scene,
			{
				path: "assets/hero.controller",
				expectedFingerprint: inspection.fingerprint,
				confirm: true,
				motionBindings: { "@unity-motion:33333333333333333333333333333333:7400000": "Sprint" },
			},
			{
				editor: { layout: { inspector } },
			} as never
		);
		expect(imported).toMatchObject({
			imported: true,
			replaced: false,
			controller: {
				name: "Hero",
				baseIKPass: true,
				entryState: "Idle",
				activeState: "Idle",
				states: [
					{ name: "Idle", animationGroup: "Idle" },
					{ name: "Run", animationGroup: "Run" },
				],
				transitions: [{ from: "Idle", to: "Run", conditions: [{ parameter: "Speed", greaterThan: 0.1 }], duration: 0.2, durationMode: "seconds" }],
				layers: [
					{
						name: "Damaged",
						synchronizedLayer: "$base",
						synchronizedTiming: true,
						synchronizedMotionOverrides: { Run: { animationGroup: "Sprint" } },
					},
				],
			},
		});
		expect(scene.metadata.babylonEditorAnimatorControllers).toHaveLength(1);
		expect(inspector.forceUpdate).toHaveBeenCalledOnce();
		scene.dispose();
		engine.dispose();
	});

	test("automatically binds exact Unity GUID/fileID Motion and imports an exact AvatarMask under a stale-safe plan lease", async () => {
		const motionGuid = "44444444444444444444444444444444";
		const maskGuid = "55555555555555555555555555555555";
		const motionPath = join(directory, "assets", "walk.anim");
		const maskPath = join(directory, "assets", "upper.mask");
		const controllerPath = join(directory, "assets", "dependency.controller");
		await writeFile(motionPath, unityAnimationClip());
		await writeFile(`${motionPath}.meta`, unityMeta(motionGuid));
		await writeFile(maskPath, unityAvatarMask());
		await writeFile(`${maskPath}.meta`, unityMeta(maskGuid));
		await writeFile(controllerPath, unityDependencyController(motionGuid, maskGuid));
		await refreshAssetRegistryPaths(["assets"]);
		const artifactPlan = await getAnimationImporterArtifactStatus(controllerPath);
		await applyAnimationImporterArtifact(controllerPath, artifactPlan.fingerprint);

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const group = new AnimationGroup("Unity Walk", scene);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: "hero-skeleton",
					animationType: "humanoid",
					source: "model",
					mapping: { spine: "Spine", leftUpperArm: "LeftArm", rightUpperArm: "RightArm" },
					restPose: {},
					humanScale: 1,
				},
			],
		};
		const namePlan = await getAnimatorControllerAssetImport(scene, { path: "assets/dependency.controller" });
		expect(namePlan).toMatchObject({
			ready: true,
			artifactFingerprint: artifactPlan.fingerprint,
			motionBindings: [{ resolution: "unity-guid-fileid-name", suggestedMatch: "Unity Walk", dependency: { path: "assets/walk.anim", fileId: "7400000" } }],
			avatarMaskBindings: [
				{
					resolution: "unity-guid-auto-import",
					dependency: { path: "assets/upper.mask", fileId: "31900000", name: "Upper Body" },
					autoImport: { avatarId: "hero-avatar", avatarName: "Hero Avatar", transformNames: ["Root/Spine"], disabledTransformNames: ["Root/Leg"] },
				},
			],
			unresolvedMotionBindings: [],
			unresolvedAvatarMaskBindings: [],
		});
		expect(namePlan.fingerprint).not.toBe(namePlan.artifactFingerprint);
		group.metadata = { [UNITY_ANIMATION_SOURCE_METADATA_KEY]: namePlan.motionBindings[0].dependency };
		const inspection = await getAnimatorControllerAssetImport(scene, { path: "assets/dependency.controller" });
		expect(inspection.motionBindings[0]).toMatchObject({ resolution: "unity-guid-provenance", suggestedMatch: "Unity Walk" });

		await writeFile(motionPath, `${unityAnimationClip()}\n`);
		await expect(
			importAnimatorControllerAsset(scene, { path: "assets/dependency.controller", expectedFingerprint: inspection.fingerprint, confirm: true }, {
				editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
			} as never)
		).rejects.toThrow(/plan changed/i);
		expect(scene.metadata.babylonEditorHumanoidAvatarMasks).toBeUndefined();
		await writeFile(motionPath, unityAnimationClip());
		const current = await getAnimatorControllerAssetImport(scene, { path: "assets/dependency.controller" });
		scene.metadata.babylonEditorAnimatorControllers = [{ id: "existing-controller", name: "Dependency Hero", states: [], transitions: [], parameters: {} }];
		await expect(
			importAnimatorControllerAsset(scene, { path: "assets/dependency.controller", expectedFingerprint: current.fingerprint, confirm: true }, {
				editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
			} as never)
		).rejects.toThrow(/replaceExisting=true/i);
		expect(scene.metadata.babylonEditorHumanoidAvatarMasks).toEqual([]);
		scene.metadata.babylonEditorAnimatorControllers = [];
		const imported = await importAnimatorControllerAsset(scene, { path: "assets/dependency.controller", expectedFingerprint: current.fingerprint, confirm: true }, {
			editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
		} as never);
		expect(imported).toMatchObject({
			imported: true,
			motionBindings: { [`@unity-motion:${motionGuid}:7400000`]: "Unity Walk" },
			controller: {
				name: "Dependency Hero",
				states: [{ name: "Walk State", animationGroup: "Unity Walk" }],
				layers: [{ name: "Upper Body", avatarMaskId: expect.stringContaining(`unity-mask:${maskGuid}:31900000:hero-avatar`) }],
			},
			importedAvatarMasks: [
				{
					name: "Upper Body",
					avatarId: "hero-avatar",
					bodyParts: { root: true, body: true, head: true, leftArm: true, rightArm: true, leftHand: true, rightHand: true, leftLeg: false, rightLeg: false },
					transformNames: ["Root/Spine"],
					unitySource: { guid: maskGuid, fileId: "31900000", path: "assets/upper.mask" },
				},
			],
		});
		expect(scene.metadata.babylonEditorHumanoidAvatarMasks).toHaveLength(1);
		scene.dispose();
		engine.dispose();
	});

	test("binds Unity MonoBehaviours to exact scripts attached to a selected target under the controller lease", async () => {
		const scriptGuid = "77777777777777777777777777777777";
		const controllerPath = join(directory, "assets", "behaviour.controller");
		const scriptPath = join(directory, "src", "behaviour.ts");
		await mkdir(join(directory, "src"));
		await writeFile(scriptPath, "export default class Behaviour {}\n");
		await writeFile(`${scriptPath}.meta`, unityMeta(scriptGuid));
		await writeFile(controllerPath, unityBehaviourController(scriptGuid));
		await refreshAssetRegistryPaths(["assets", "src"]);
		const artifactPlan = await getAnimationImporterArtifactStatus(controllerPath);
		await applyAnimationImporterArtifact(controllerPath, artifactPlan.fingerprint);

		const engine = new NullEngine();
		const scene = new Scene(engine);
		new AnimationGroup("Idle", scene);
		const target = new TransformNode("Behaviour Target", scene);
		target.metadata = { scripts: [{ _id: "behaviour-attachment", key: "behaviour.ts", enabled: true, executionOrder: 0 }] };

		const withoutTarget = await getAnimatorControllerAssetImport(scene, { path: "assets/behaviour.controller" });
		expect(withoutTarget).toMatchObject({
			ready: false,
			unresolvedBehaviourBindings: ["@unity-behaviour:local:11400000", "@unity-behaviour:local:11400001"],
			availableScriptTargets: [{ id: target.id, attachedScriptKeys: ["behaviour.ts"] }],
		});
		const inspection = await getAnimatorControllerAssetImport(scene, { path: "assets/behaviour.controller", targetNodeId: target.id });
		expect(inspection).toMatchObject({
			ready: true,
			selectedScriptTarget: { id: target.id, name: "Behaviour Target", attachedScriptKeys: ["behaviour.ts"] },
			unresolvedBehaviourBindings: [],
			behaviourBindings: [
				{
					key: "@unity-behaviour:local:11400000",
					resolution: "unity-guid-attached-script",
					suggestedMatch: "behaviour.ts",
					dependency: { path: "src/behaviour.ts", metaPath: "src/behaviour.ts.meta", fileId: "11500000" },
					serializedFieldsJson: '{"multiplier":"2.5"}',
				},
				{
					key: "@unity-behaviour:local:11400001",
					resolution: "unity-guid-attached-script",
					suggestedMatch: "behaviour.ts",
					serializedFieldsJson: '{"label":"root"}',
				},
			],
		});

		target.metadata.scripts = [];
		await expect(
			importAnimatorControllerAsset(scene, { path: "assets/behaviour.controller", targetNodeId: target.id, expectedFingerprint: inspection.fingerprint, confirm: true }, {
				editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
			} as never)
		).rejects.toThrow(/plan changed/i);
		target.metadata.scripts = [{ _id: "behaviour-attachment", key: "behaviour.ts", enabled: true, executionOrder: 0 }];
		const current = await getAnimatorControllerAssetImport(scene, { path: "assets/behaviour.controller", targetNodeName: "Behaviour Target" });
		await expect(
			importAnimatorControllerAsset(
				scene,
				{
					path: "assets/behaviour.controller",
					targetNodeName: "Behaviour Target",
					expectedFingerprint: current.fingerprint,
					behaviourBindings: { "@unity-behaviour:missing:1": "behaviour.ts" },
					confirm: true,
				},
				{ editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as never
			)
		).rejects.toThrow(/unknown keys/i);
		const imported = await importAnimatorControllerAsset(
			scene,
			{ path: "assets/behaviour.controller", targetNodeName: "Behaviour Target", expectedFingerprint: current.fingerprint, confirm: true },
			{ editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as never
		);
		expect(imported).toMatchObject({
			imported: true,
			selectedScriptTarget: { id: target.id, name: "Behaviour Target" },
			behaviourBindings: {
				"@unity-behaviour:local:11400000": "behaviour.ts",
				"@unity-behaviour:local:11400001": "behaviour.ts",
			},
			controller: {
				targetNodeId: target.id,
				behaviours: [{ scriptKey: "behaviour.ts", unitySource: { scriptGuid, scriptPath: "src/behaviour.ts", serializedFieldsJson: '{"label":"root"}' } }],
				states: [{ name: "Idle", behaviours: [{ scriptKey: "behaviour.ts", unitySource: { serializedFieldsJson: '{"multiplier":"2.5"}' } }] }],
				layers: [
					{
						name: "Override Layer",
						behaviours: [{ scriptKey: "behaviour.ts" }],
						synchronizedBehaviourOverrides: { Idle: [{ scriptKey: "behaviour.ts" }] },
					},
				],
			},
		});
		scene.dispose();
		engine.dispose();
	});

	test("recursively replaces every imported nested Blend Tree Motion binding", async () => {
		const source = join(directory, "assets", "nested.controller");
		await writeFile(source, unityNestedBlendTreeController());
		const planned = await getAnimationImporterArtifactStatus(source);
		await applyAnimationImporterArtifact(source, planned.fingerprint);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		for (const name of ["Locomotion 1", "Locomotion 2 1", "Locomotion 2 2"]) {
			new AnimationGroup(name, scene);
		}
		const inspection = await getAnimatorControllerAssetImport(scene, { path: "assets/nested.controller" });
		expect(inspection).toMatchObject({ ready: true, result: { controllerBlendTreeCount: 2 }, unresolvedMotionBindings: [] });
		const imported = await importAnimatorControllerAsset(scene, { path: "assets/nested.controller", expectedFingerprint: inspection.fingerprint, confirm: true }, {
			editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
		} as never);
		expect(imported.controller.states[0].blendTree).toEqual({
			parameter: "Speed",
			children: [
				{ animationGroup: "Locomotion 1", threshold: 0 },
				{
					threshold: 1,
					blendTree: {
						parameter: "Direction",
						children: [
							{ animationGroup: "Locomotion 2 1", threshold: -1 },
							{ animationGroup: "Locomotion 2 2", threshold: 1 },
						],
					},
				},
			],
		});
		scene.dispose();
		engine.dispose();
	});

	test("imports Direct Blend Tree bindings without losing per-child parameters", async () => {
		const source = join(directory, "assets", "direct.controller");
		await writeFile(source, unityDirectBlendTreeController());
		const planned = await getAnimationImporterArtifactStatus(source);
		await applyAnimationImporterArtifact(source, planned.fingerprint);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		new AnimationGroup("Face 1", scene);
		new AnimationGroup("Face 2", scene);
		const inspection = await getAnimatorControllerAssetImport(scene, { path: "assets/direct.controller" });
		expect(inspection).toMatchObject({ ready: true, result: { controllerBlendTreeCount: 1 }, unresolvedMotionBindings: [] });
		const imported = await importAnimatorControllerAsset(scene, { path: "assets/direct.controller", expectedFingerprint: inspection.fingerprint, confirm: true }, {
			editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
		} as never);
		expect(imported.controller.states[0].blendTree).toEqual({
			blendMode: "direct",
			normalizeWeights: true,
			children: [
				{ animationGroup: "Face 1", directParameter: "First", timeScale: 2, cycleOffset: 0.25, mirror: true },
				{ animationGroup: "Face 2", directParameter: "Second" },
			],
		});
		scene.dispose();
		engine.dispose();
	});

	test("imports conditional Entry and child-machine source routing into the live scene controller", async () => {
		const source = join(directory, "assets", "conditional-entry.controller");
		await writeFile(source, unityConditionalEntryController());
		const planned = await getAnimationImporterArtifactStatus(source);
		const artifact = await applyAnimationImporterArtifact(source, planned.fingerprint);
		expect(artifact).toMatchObject({ result: { valid: true, controllerStateCount: 2, controllerTransitionCount: 3 } });

		const engine = new NullEngine();
		const scene = new Scene(engine);
		new AnimationGroup("Idle", scene);
		new AnimationGroup("Run", scene);
		const inspection = await getAnimatorControllerAssetImport(scene, { path: "assets/conditional-entry.controller" });
		expect(inspection).toMatchObject({ ready: true, unresolvedMotionBindings: [] });
		const imported = await importAnimatorControllerAsset(
			scene,
			{ path: "assets/conditional-entry.controller", expectedFingerprint: inspection.fingerprint, confirm: true, playOnImport: true },
			{ editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as never
		);
		expect(imported.controller).toMatchObject({
			name: "Conditional Entry",
			parameters: { Go: true, Done: false },
			entryState: "Idle",
			activeState: "Ground/Run",
			entryTransitions: [{ to: "Ground", conditions: [{ parameter: "Go", equals: true }] }],
			transitions: [{ from: "Ground", to: "Idle" }],
			subStateMachines: [{ name: "Ground", subgraphId: "unity-state-machine:110700001" }],
			subgraphs: [
				{
					id: "unity-state-machine:110700001",
					entryState: "Run",
					transitions: [{ from: "Run", to: "$exit", conditions: [{ parameter: "Done", equals: true }] }],
				},
			],
		});
		expect(imported.unsupportedFeatures).not.toContain(expect.stringContaining("conditional Entry"));
		expect(imported.unsupportedFeatures).not.toContain(expect.stringContaining("child state-machine"));
		scene.dispose();
		engine.dispose();
	});
});

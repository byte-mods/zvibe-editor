import { ensureDir, mkdtemp, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import { Animation, Vector3 } from "babylonjs";
import { normalizeAnimationImporterSettings } from "babylonjs-editor-tools";
import { afterEach, describe, expect, test } from "vitest";

import { processExportedAnimation } from "../src/pack/assets/animation.mjs";

function animationGroupDocument(): Record<string, unknown> {
	const animation = new Animation("Root Position", "position", 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CONSTANT);
	animation.setKeys([
		{ frame: 0, value: new Vector3(0, 0, 0) },
		{ frame: 15, value: new Vector3(0.5, 0, 0) },
		{ frame: 30, value: new Vector3(1, 0, 0) },
	]);
	return { name: "Walk", from: 0, to: 30, targetedAnimations: [{ targetId: "Root", animation: animation.serialize() }] };
}

function unityAnimatorController(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  serializedVersion: 5
  m_Name: CLI Hero
  m_AnimatorParameters: []
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
    m_Position: {x: 50, y: 80, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  serializedVersion: 6
  m_Name: Idle
  m_Speed: -1.5
  m_CycleOffset: 0.25
  m_Mirror: 1
  m_IKOnFeet: 0
  m_WriteDefaultValues: 1
  m_Tag: Locomotion
  m_Motion: {fileID: 7400000, guid: abcdefabcdefabcdefabcdefabcdefab, type: 2}
  m_Transitions: []
`;
}

function unityAnimationClip(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: CLI Walk
  m_RotationCurves: []
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
  m_FloatCurves: []
  m_PPtrCurves: []
  m_SampleRate: 30
  m_AnimationClipSettings:
    m_LoopTime: 1
  m_Events: []
`;
}

function unityRuntimeCurveClip(): string {
	return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: CLI Runtime Curves
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

describe("CLI executed animation importer", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("executes the same resampling, reduction, looping, and root-motion contract", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-animation-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "walk.animation");
		const output = join(project, "public", "scene", "assets", "walk.animation");
		await writeJSON(source, animationGroupDocument());
		const result = await processExportedAnimation(
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
			rootMotion: { requestedNode: "Root", resolved: true },
		});
		expect(await readJSON(output)).toMatchObject({ from: 0, to: 60, loopAnimation: true });
	});

	test("rejects invalid Animator Controller transitions with portable evidence", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-controller-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "player.controller");
		const output = join(project, "public", "scene", "assets", "player.controller");
		await writeJSON(source, { states: [{ name: "Idle" }], transitions: [{ from: "Idle", to: "Missing" }] });
		const result = await processExportedAnimation(source, output, normalizeAnimationImporterSettings({}));
		expect(result).toMatchObject({
			sourceKind: "animator-controller",
			valid: false,
			controllerStateCount: 1,
			controllerTransitionCount: 1,
			errors: ["Every Animator Controller transition must reference existing from/to state names."],
		});
	});

	test("publishes converted Unity YAML controllers through the CLI build path", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-unity-controller-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "hero.controller");
		const output = join(project, "public", "scene", "assets", "hero.controller");
		await writeFile(source, unityAnimatorController());
		const result = await processExportedAnimation(source, output, normalizeAnimationImporterSettings({}));
		expect(result).toMatchObject({
			sourceKind: "animator-controller",
			controllerFormat: "unity-yaml",
			controllerLayerCount: 1,
			controllerStateCount: 1,
			controllerTransitionCount: 0,
			controllerCompatibility: {
				yamlVersion: "1.1",
				stateSerializationProfile: "modern-v6-or-later",
				fieldVariants: ["AnimatorState.m_IKOnFeet", "AnimatorState.m_WriteDefaultValues"],
			},
			valid: true,
		});
		expect(await readJSON(output)).toMatchObject({
			format: "babylonjs-editor-animator-controller",
			sourceFormat: "unity-yaml",
			controller: {
				name: "CLI Hero",
				entryState: "Idle",
				states: [
					{
						name: "Idle",
						animationGroup: "@unity-motion:abcdefabcdefabcdefabcdefabcdefab:7400000",
						speed: -1.5,
						cycleOffset: 0.25,
						mirror: true,
						footIK: false,
						writeDefaultValues: true,
						tag: "Locomotion",
						unitySource: { serializedVersion: 6, footIKField: "m_IKOnFeet" },
					},
				],
			},
		});
	});

	test("publishes converted Unity YAML AnimationClips through the same CLI compression backend", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-unity-animation-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "walk.anim");
		const output = join(project, "public", "scene", "assets", "walk.anim");
		await writeFile(source, unityAnimationClip());
		const result = await processExportedAnimation(
			source,
			output,
			normalizeAnimationImporterSettings({ resampleCurves: false, compression: "keyframeReduction", positionErrorPercent: 0.1 })
		);
		expect(result).toMatchObject({
			sourceKind: "unity-animation-clip",
			sourceFormat: "unity-animation-clip-yaml",
			outputFormat: "babylon-animation-group-json",
			valid: true,
			sourceKeyCount: 2,
			outputKeyCount: 2,
			clips: [{ name: "CLI Walk", loop: true }],
		});
		expect(await readJSON(output)).toMatchObject({
			name: "CLI Walk",
			loopAnimation: true,
			targetedAnimations: [{ targetId: "Root/Hips", animation: { property: "position", loopBehavior: Animation.ANIMATIONLOOPMODE_CYCLE } }],
		});
	});

	test("preserves Unity active-state and exact object-reference runtime metadata in CLI output", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-unity-runtime-animation-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "runtime.anim");
		const output = join(project, "public", "scene", "assets", "runtime.anim");
		await writeFile(source, unityRuntimeCurveClip());
		const result = await processExportedAnimation(source, output, normalizeAnimationImporterSettings({ resampleCurves: false, compression: "none" }));
		expect(result).toMatchObject({
			sourceKind: "unity-animation-clip",
			valid: true,
			activeStateCurveCount: 1,
			objectReferenceCurves: [
				{
					target: "Sprite",
					attribute: "m_Sprite",
					references: [{ key: "abcdefabcdefabcdefabcdefabcdefab:21300000:3" }, { key: "local:0:0" }],
				},
			],
		});
		const published = await readJSON(output);
		expect(published).toMatchObject({
			metadata: {
				babylonEditorUnityAnimationClip: {
					version: 2,
					activeStateCurveCount: 1,
					objectReferenceCurves: [{ target: "Sprite", attribute: "m_Sprite" }],
					objectReferenceBindings: [],
				},
			},
			targetedAnimations: [
				{ targetId: "Sprite", animation: { property: expect.stringMatching(/^__babylonEditorUnityObjectReference_/) } },
				{ targetId: "Root", animation: { property: "__babylonEditorUnityActiveState" } },
			],
		});
	});
});

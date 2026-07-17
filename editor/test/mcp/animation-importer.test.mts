import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { Animation, AnimationGroup, NullEngine, Scene, Vector3 } from "babylonjs";
import { normalizeAnimationImporterSettings } from "babylonjs-editor-tools";

import { applyAnimationImporterArtifact, getAnimationImporterArtifactStatus, processAnimationImporterOutput } from "../../src/mcp/assets/animation-importer";
import { applyAnimationImporter, getAnimationImporterResult, getAnimatorControllerAssetImport, importAnimatorControllerAsset } from "../../src/mcp/assets/assets";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
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

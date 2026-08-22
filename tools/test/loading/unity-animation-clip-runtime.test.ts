import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { describe, expect, test } from "vitest";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";

import {
	configureUnityAnimationClipRuntime,
	getUnityAnimationClipRuntimeEvidence,
	UNITY_ANIMATION_ACTIVE_STATE_PROPERTY,
	UNITY_ANIMATION_CLIP_METADATA_KEY,
	UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX,
	validateUnityAnimationDestinationPropertyPath,
} from "../../src/loading/unity-animation-clip-runtime";

describe("Unity AnimationClip runtime", () => {
	test("executes stepped active-state and exact object-reference bindings with live evidence", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const root = new TransformNode("Root", scene);
		const sprite = new TransformNode("Sprite", scene) as TransformNode & { cellIndex: number };
		sprite.cellIndex = -1;
		const group = new AnimationGroup("Unity Runtime", scene);
		const objectProperty = `${UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX}fixture`;
		const active = new Animation("Active", UNITY_ANIMATION_ACTIVE_STATE_PROPERTY, 30, Animation.ANIMATIONTYPE_FLOAT);
		active.setKeys([
			{ frame: 0, value: 1 },
			{ frame: 30, value: 0 },
		]);
		const reference = new Animation("Sprite", objectProperty, 30, Animation.ANIMATIONTYPE_FLOAT);
		reference.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 1 },
		]);
		group.addTargetedAnimation(active, root);
		group.addTargetedAnimation(reference, sprite);
		group.metadata = {
			[UNITY_ANIMATION_CLIP_METADATA_KEY]: {
				version: 2,
				activeStateCurveCount: 1,
				objectReferenceCurves: [
					{
						id: "curve-1",
						target: "Sprite",
						attribute: "m_Sprite",
						trackProperty: objectProperty,
						references: [
							{ key: "guid:10:3", fileId: "10", guid: "guid", type: 3 },
							{ key: "local:0:0", fileId: "0", guid: null, type: 0 },
						],
						keys: [
							{ frame: 0, referenceKey: "guid:10:3" },
							{ frame: 30, referenceKey: "local:0:0" },
						],
					},
				],
				objectReferenceBindings: [
					{
						curveId: "curve-1",
						propertyPath: "cellIndex",
						references: [
							{ referenceKey: "guid:10:3", value: { kind: "number", value: 7 } },
							{ referenceKey: "local:0:0", value: { kind: "number", value: -1 } },
						],
					},
				],
			},
		};

		const [configured] = configureUnityAnimationClipRuntime(scene);
		expect(configured).toMatchObject({
			configured: true,
			activeStateTrackCount: 1,
			objectReferenceTrackCount: 1,
			boundObjectReferenceCurveCount: 1,
			unresolvedObjectReferenceCurveIds: [],
		});
		(root as any)[UNITY_ANIMATION_ACTIVE_STATE_PROPERTY] = 0;
		expect(root.isEnabled()).toBe(false);
		(root as any)[UNITY_ANIMATION_ACTIVE_STATE_PROPERTY] = 1;
		expect(root.isEnabled()).toBe(true);
		(sprite as any)[objectProperty] = 0;
		expect(sprite.cellIndex).toBe(7);
		(sprite as any)[objectProperty] = 1;
		expect(sprite.cellIndex).toBe(-1);
		expect(getUnityAnimationClipRuntimeEvidence(group)).toMatchObject({
			lastAppliedActiveState: { targetName: "Root", enabled: true },
			lastAppliedObjectReference: { curveId: "curve-1", targetName: "Sprite", propertyPath: "cellIndex", referenceKey: "local:0:0", valueKind: "number" },
		});
		configureUnityAnimationClipRuntime(scene);
		(sprite as any)[objectProperty] = 0;
		expect(sprite.cellIndex).toBe(7);
		scene.dispose();
		engine.dispose();
	});

	test("rejects unsafe destination paths", () => {
		expect(validateUnityAnimationDestinationPropertyPath("metadata.reference.value")).toBe("metadata.reference.value");
		expect(() => validateUnityAnimationDestinationPropertyPath("metadata.__proto__.polluted")).toThrow("prototype-related");
		expect(() => validateUnityAnimationDestinationPropertyPath("setEnabled()")).toThrow("safe dotted paths");
	});

	test("reconstructs Sprite object-reference tracks dropped by Babylon scene parsing", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const manager = new SpriteManager(
			"Sprites",
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z1+uAAAAAElFTkSuQmCC",
			4,
			1,
			scene
		);
		const sprite = new Sprite("Hero", manager);
		const group = new AnimationGroup("Parsed Unity Sprite", scene);
		const property = `${UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX}parsed`;
		group.metadata = {
			babylonEditorAnimationImportBindings: [{ sourceTarget: "Sprite", kind: "sprite", managerName: manager.name, targetName: sprite.name }],
			[UNITY_ANIMATION_CLIP_METADATA_KEY]: {
				version: 2,
				sampleRate: 30,
				loopTime: true,
				objectReferenceCurves: [
					{
						id: "parsed-curve",
						target: "Sprite",
						attribute: "m_Sprite",
						trackProperty: property,
						references: [{ key: "guid:1:3", fileId: "1", guid: "guid", type: 3 }],
						keys: [{ frame: 0, referenceKey: "guid:1:3" }],
					},
				],
				objectReferenceBindings: [{ curveId: "parsed-curve", propertyPath: "cellIndex", references: [{ referenceKey: "guid:1:3", value: { kind: "number", value: 2 } }] }],
			},
		};
		expect(group.targetedAnimations).toHaveLength(0);
		const [evidence] = configureUnityAnimationClipRuntime(scene);
		expect(group.targetedAnimations).toHaveLength(1);
		expect(group.targetedAnimations[0].target).toBe(sprite);
		expect(evidence).toMatchObject({ objectReferenceTrackCount: 1, boundObjectReferenceCurveCount: 1 });
		(sprite as any)[property] = 0;
		expect(sprite.cellIndex).toBe(2);
		scene.dispose();
		engine.dispose();
	});
});

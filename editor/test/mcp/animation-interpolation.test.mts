import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationKeyInterpolation, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import {
	autoSmoothAnimationCurveTangents,
	createAnimation,
	editAnimationWindowKeys,
	getAnimationGroup,
	getAnimationWindow,
	openAnimationWindow,
	sampleAnimationCurve,
	setAnimationCurveComponentKeys,
	setAnimationCurveTangents,
	setAnimationCurveKeys,
	setAnimationKeys,
} from "../../src/mcp/animations/animations";

describe("mcp/animation interpolation", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("authors and updates stepped keyframes through the AnimationGroup path", () => {
		const node = new TransformNode("Sprite Bone", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Pose",
				targetProperty: "rotation.z",
				keys: [
					{ frame: 0, value: 0, interpolation: "step", outTangent: 0.25 },
					{ frame: 10, value: 1, inTangent: 0.5 },
				],
			},
			options
		);
		let group = scene.getAnimationGroupByName("Pose")!;
		expect(group.targetedAnimations[0].animation.getKeys()[0].interpolation).toBe(AnimationKeyInterpolation.STEP);
		expect(group.targetedAnimations[0].animation.getKeys()[0].outTangent).toBe(0.25);
		expect(group.targetedAnimations[0].animation.getKeys()[1].inTangent).toBe(0.5);

		setAnimationKeys(
			scene,
			{
				name: "Pose",
				trackIndex: 0,
				keys: [
					{ frame: 0, value: 0, outTangent: 0.75 },
					{ frame: 10, value: 1, interpolation: "step", inTangent: 1.25 },
				],
			},
			options
		);
		group = scene.getAnimationGroupByName("Pose")!;
		expect(group.targetedAnimations[0].animation.getKeys()[0].interpolation).toBe(AnimationKeyInterpolation.NONE);
		expect(group.targetedAnimations[0].animation.getKeys()[1].interpolation).toBe(AnimationKeyInterpolation.STEP);
		expect(group.targetedAnimations[0].animation.getKeys()[0].outTangent).toBe(0.75);
		expect(group.targetedAnimations[0].animation.getKeys()[1].inTangent).toBe(1.25);
		expect(getAnimationGroup(scene, { name: "Pose" }).tracks[0].keys[1].interpolation).toBe(AnimationKeyInterpolation.STEP);
	});

	test("samples linear and stepped curve segments for external curve analysis", () => {
		const node = new TransformNode("Curve", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Curve",
				targetProperty: "position.x",
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 10, value: 10 },
				],
			},
			options
		);
		expect(sampleAnimationCurve(scene, { name: "Curve", trackIndex: 0, from: 0, to: 10, samples: 3 }).samples).toEqual([
			{ frame: 0, value: 0 },
			{ frame: 5, value: 5 },
			{ frame: 10, value: 10 },
		]);
		setAnimationKeys(
			scene,
			{
				name: "Curve",
				trackIndex: 0,
				keys: [
					{ frame: 0, value: 0, interpolation: "step" },
					{ frame: 10, value: 10 },
				],
			},
			options
		);
		expect(sampleAnimationCurve(scene, { name: "Curve", trackIndex: 0, from: 0, to: 10, samples: 3 }).samples[1]).toEqual({ frame: 5, value: 0 });
	});

	test("replaces validated scalar curve keys while rejecting incompatible curve data", () => {
		const node = new TransformNode("Curve", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Curve",
				targetProperty: "position.x",
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 10, value: 10 },
				],
			},
			options
		);
		setAnimationCurveKeys(
			scene,
			{
				name: "Curve",
				trackIndex: 0,
				keys: [
					{ frame: 0, value: -2, outTangent: 0.5 },
					{ frame: 10, value: 4, interpolation: "step" },
				],
			},
			options
		);
		expect(getAnimationGroup(scene, { name: "Curve" }).tracks[0].keys).toMatchObject([
			{ frame: 0, value: -2, outTangent: 0.5 },
			{ frame: 10, value: 4, interpolation: AnimationKeyInterpolation.STEP },
		]);
		expect(() =>
			setAnimationCurveKeys(
				scene,
				{
					name: "Curve",
					trackIndex: 0,
					keys: [
						{ frame: 0, value: 1 },
						{ frame: 0, value: 2 },
					],
				},
				options
			)
		).toThrow("cannot share frame");
	});

	test("edits one vector curve channel without changing the other channels", () => {
		const node = new TransformNode("Vector Curve", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Vector Curve",
				targetProperty: "position",
				keys: [
					{ frame: 0, value: [1, 2, 3] },
					{ frame: 10, value: [4, 5, 6] },
				],
			},
			options
		);
		setAnimationCurveComponentKeys(
			scene,
			{
				name: "Vector Curve",
				trackIndex: 0,
				component: 1,
				keys: [
					{ frame: 0, value: -2, outTangent: 0.5 },
					{ frame: 10, value: 8, interpolation: "step" },
				],
			},
			options
		);
		const keys = scene.getAnimationGroupByName("Vector Curve")!.targetedAnimations[0].animation.getKeys();
		expect(keys[0].value).toEqual(new Vector3(1, -2, 3));
		expect(keys[1].value).toEqual(new Vector3(4, 8, 6));
		expect(keys[0].outTangent).toEqual(new Vector3(0, 0.5, 0));
		expect(keys[1].interpolation).toBe(AnimationKeyInterpolation.STEP);
		expect(sampleAnimationCurve(scene, { name: "Vector Curve", trackIndex: 0, component: 1, from: 0, to: 10, samples: 3 }).samples[1]).toEqual({ frame: 5, value: 3 });
	});

	test("auto-smooths scalar and vector curve tangents without changing stepped keys", () => {
		const node = new TransformNode("Smooth Curve", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Smooth",
				targetProperty: "position.x",
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 10, value: 10 },
					{ frame: 30, value: 20 },
				],
			},
			options
		);
		autoSmoothAnimationCurveTangents(scene, { name: "Smooth", trackIndex: 0 }, options);
		const scalarKeys = scene.getAnimationGroupByName("Smooth")!.targetedAnimations[0].animation.getKeys();
		expect(scalarKeys[0].outTangent).toBe(1);
		expect(scalarKeys[1].inTangent).toBeCloseTo(2 / 3);

		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Stepped",
				targetProperty: "position",
				keys: [
					{ frame: 0, value: [0, 0, 0], interpolation: "step" },
					{ frame: 10, value: [10, 20, 30] },
				],
			},
			options
		);
		autoSmoothAnimationCurveTangents(scene, { name: "Stepped", trackIndex: 0 }, options);
		const vectorKeys = scene.getAnimationGroupByName("Stepped")!.targetedAnimations[0].animation.getKeys();
		expect(vectorKeys[0].outTangent).toBeUndefined();
		expect(vectorKeys[1].inTangent).toEqual(new Vector3(1, 2, 3));
	});

	test("edits selected scalar and vector key tangents without replacing values", () => {
		const node = new TransformNode("Tangents", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Scalar",
				targetProperty: "position.x",
				keys: [
					{ frame: 0, value: 2 },
					{ frame: 10, value: 8 },
				],
			},
			options
		);
		setAnimationCurveTangents(
			scene,
			{
				name: "Scalar",
				trackIndex: 0,
				keys: [
					{ frame: 0, outTangent: 0.25 },
					{ frame: 10, inTangent: -0.5 },
				],
			},
			options
		);
		const scalarKeys = scene.getAnimationGroupByName("Scalar")!.targetedAnimations[0].animation.getKeys();
		expect(scalarKeys).toMatchObject([
			{ value: 2, outTangent: 0.25 },
			{ value: 8, inTangent: -0.5 },
		]);

		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Vector",
				targetProperty: "position",
				keys: [
					{ frame: 0, value: [1, 2, 3] },
					{ frame: 10, value: [4, 5, 6] },
				],
			},
			options
		);
		setAnimationCurveTangents(scene, { name: "Vector", trackIndex: 0, component: 2, keys: [{ frame: 0, outTangent: 0.75 }] }, options);
		const vectorKey = scene.getAnimationGroupByName("Vector")!.targetedAnimations[0].animation.getKeys()[0];
		expect(vectorKey.value).toEqual(new Vector3(1, 2, 3));
		expect(vectorKey.outTangent).toEqual(new Vector3(0, 0, 0.75));
	});

	test("leases and atomically edits multi-track Dope Sheet and Curve selections", () => {
		const node = new TransformNode("Window Target", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Animation Window",
				targetProperty: "position.x",
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 10, value: 10 },
					{ frame: 20, value: 20 },
				],
			},
			options
		);
		const group = scene.getAnimationGroupByName("Animation Window")!;
		const vector = new Animation("Position", "position", 60, Animation.ANIMATIONTYPE_VECTOR3);
		vector.setKeys([
			{ frame: 0, value: new Vector3(1, 2, 3) },
			{ frame: 10, value: new Vector3(4, 5, 6) },
			{ frame: 20, value: new Vector3(7, 8, 9) },
		]);
		group.addTargetedAnimation(vector, node);

		const inspected = getAnimationWindow(scene, { name: group.name });
		expect(inspected).toMatchObject({
			name: group.name,
			trackCount: 2,
			keyCount: 6,
			uniqueFrameCount: 3,
			durationFrames: 20,
		});
		expect(inspected.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(inspected.tracks[1]).toMatchObject({ componentLabels: ["X", "Y", "Z"] });
		expect(inspected.tracks[1].keys).toEqual(expect.arrayContaining([expect.objectContaining({ values: [1, 2, 3] })]));

		const moved = editAnimationWindowKeys(
			scene,
			{
				name: group.name,
				expectedFingerprint: inspected.fingerprint,
				selection: [
					{ trackIndex: 0, frame: 10, component: 0 },
					{ trackIndex: 1, frame: 10, component: 1 },
				],
				operation: "move",
				frameDelta: 2,
				valueDelta: 3,
			},
			options
		);
		expect(moved.changedKeyCount).toBe(2);
		expect(group.targetedAnimations[0].animation.getKeys()[1]).toMatchObject({ frame: 12, value: 13 });
		expect(group.targetedAnimations[1].animation.getKeys()[1].frame).toBe(12);
		expect(group.targetedAnimations[1].animation.getKeys()[1].value).toEqual(new Vector3(4, 8, 6));
		expect(() =>
			editAnimationWindowKeys(
				scene,
				{
					name: group.name,
					expectedFingerprint: inspected.fingerprint,
					selection: [{ trackIndex: 0, frame: 12 }],
					operation: "delete",
				},
				options
			)
		).toThrow("changed after inspection");

		const beforeCollision = getAnimationWindow(scene, { name: group.name });
		expect(() =>
			editAnimationWindowKeys(
				scene,
				{
					name: group.name,
					expectedFingerprint: beforeCollision.fingerprint,
					selection: [{ trackIndex: 0, frame: 12 }],
					operation: "move",
					valueDelta: 1,
				},
				options
			)
		).toThrow("explicit component");
		expect(() =>
			editAnimationWindowKeys(
				scene,
				{
					name: group.name,
					expectedFingerprint: beforeCollision.fingerprint,
					selection: [{ trackIndex: 0, frame: 12 }],
					operation: "duplicate",
					frameDelta: 8,
				},
				options
			)
		).toThrow("duplicate frame 20");
		expect(getAnimationWindow(scene, { name: group.name }).fingerprint).toBe(beforeCollision.fingerprint);

		const interpolated = editAnimationWindowKeys(
			scene,
			{
				name: group.name,
				expectedFingerprint: beforeCollision.fingerprint,
				selection: [
					{ trackIndex: 0, frame: 12 },
					{ trackIndex: 1, frame: 12 },
				],
				operation: "setInterpolation",
				interpolation: "step",
			},
			options
		);
		expect(interpolated.window.tracks[0].keys.find((key: any) => key.frame === 12).interpolation).toBe("step");
		expect(interpolated.window.tracks[1].keys.find((key: any) => key.frame === 12).interpolation).toBe("step");

		const openOptions = {
			editor: {
				layout: {
					selectTab: vi.fn(),
					animations: { openAnimationWindow: vi.fn() },
				},
			},
		} as any;
		expect(openAnimationWindow(scene, { name: group.name }, openOptions)).toEqual({ opened: true, name: group.name, mode: "animation-window" });
		expect(openOptions.editor.layout.selectTab).toHaveBeenCalledWith("animations");
		expect(openOptions.editor.layout.animations.openAnimationWindow).toHaveBeenCalledWith(group.name);
	});

	test("rejects edits that would remove every key without mutating the clip", () => {
		const node = new TransformNode("One Key", scene);
		createAnimation(scene, { nodeId: node.id, name: "One Key", targetProperty: "position.x", keys: [{ frame: 0, value: 1 }] }, options);
		const inspected = getAnimationWindow(scene, { name: "One Key" });
		expect(() =>
			editAnimationWindowKeys(
				scene,
				{
					name: "One Key",
					expectedFingerprint: inspected.fingerprint,
					selection: [{ trackIndex: 0, frame: 0 }],
					operation: "delete",
				},
				options
			)
		).toThrow("without keys");
		expect(getAnimationWindow(scene, { name: "One Key" }).fingerprint).toBe(inspected.fingerprint);
	});
});

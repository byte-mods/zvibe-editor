import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationKeyInterpolation, Color4, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";

import {
	autoSmoothAnimationCurveTangents,
	createAnimation,
	editAnimationWindowKeys,
	getAnimationGroup,
	getAnimationWindow,
	openAnimationWindow,
	recordAnimationWindowProperties,
	sampleAnimationCurve,
	setAnimationCurveComponentKeys,
	setAnimationCurveTangents,
	setAnimationCurveKeys,
	setAnimationKeys,
	setAnimationWindowTangentModes,
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

	test("atomically records current Inspector values into existing and newly created tracks", () => {
		const node = new TransformNode("Recorded Target", scene);
		createAnimation(scene, { nodeId: node.id, name: "Recorded Clip", targetProperty: "position.x", keys: [{ frame: 0, value: 1 }] }, options);

		node.position.x = 4;
		let inspected = getAnimationWindow(scene, { name: "Recorded Clip" });
		let result = recordAnimationWindowProperties(
			scene,
			{
				name: "Recorded Clip",
				expectedFingerprint: inspected.fingerprint,
				frame: 12,
				entries: [{ targetTrackIndex: 0, property: "position.x", interpolation: "step" }],
			},
			options
		);
		expect(result).toMatchObject({
			recordedCount: 1,
			recorded: [{ targetId: node.id, property: "position.x", trackIndex: 0, createdTrack: false, replacedKey: false, frame: 12, values: [4], interpolation: "step" }],
		});
		expect(result.window.tracks[0].keys.find((key: any) => key.frame === 12)).toMatchObject({ values: [4], interpolation: "step" });

		node.position.x = 7;
		result = recordAnimationWindowProperties(
			scene,
			{
				name: "Recorded Clip",
				expectedFingerprint: result.window.fingerprint,
				frame: 12,
				entries: [{ targetTrackIndex: 0, property: "position.x" }],
			},
			options
		);
		expect(result.recorded[0]).toMatchObject({ createdTrack: false, replacedKey: true, values: [7], interpolation: "step" });
		expect(result.window.tracks[0].keys.filter((key: any) => key.frame === 12)).toEqual([expect.objectContaining({ values: [7], interpolation: "step" })]);

		(node as any).overlayColor = new Color4(0.1, 0.2, 0.3, 0.4);
		result = recordAnimationWindowProperties(
			scene,
			{
				name: "Recorded Clip",
				expectedFingerprint: result.window.fingerprint,
				frame: 20,
				entries: [
					{ targetTrackIndex: 0, property: "position" },
					{ nodeId: node.id, property: "overlayColor", framesPerSecond: 30, loopMode: "constant" },
				],
			},
			options
		);
		expect(result.recorded).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ property: "position", createdTrack: true, values: [7, 0, 0] }),
				expect.objectContaining({ property: "overlayColor", createdTrack: true, values: [0.1, 0.2, 0.3, 0.4], dataType: Animation.ANIMATIONTYPE_COLOR4 }),
			])
		);
		expect(result.window.trackCount).toBe(3);
	});

	test("rejects stale, unsafe, duplicate, unsupported, and partially invalid recordings without mutation", () => {
		const node = new TransformNode("Atomic Record", scene);
		createAnimation(scene, { nodeId: node.id, name: "Atomic Record", targetProperty: "position.x", keys: [{ frame: 0, value: 1 }] }, options);
		(node as any).recordableFlag = true;
		const inspected = getAnimationWindow(scene, { name: "Atomic Record" });
		const base = { name: "Atomic Record", expectedFingerprint: inspected.fingerprint, frame: 8 };

		expect(() =>
			recordAnimationWindowProperties(scene, { ...base, expectedFingerprint: "0".repeat(64), entries: [{ targetTrackIndex: 0, property: "position.x" }] }, options)
		).toThrow("changed after inspection");
		expect(() => recordAnimationWindowProperties(scene, { ...base, entries: [{ targetTrackIndex: 0, property: "__proto__.polluted" }] }, options)).toThrow("invalid or unsafe");
		expect(() => recordAnimationWindowProperties(scene, { ...base, entries: [{ targetTrackIndex: 0, property: "position.x", interpolation: "bezier" }] }, options)).toThrow(
			"interpolation must be linear or step"
		);
		expect(() => recordAnimationWindowProperties(scene, { ...base, entries: [{ targetTrackIndex: 0, property: "position.y", loopMode: "pingPong" }] }, options)).toThrow(
			"loopMode must be cycle, constant, or relative"
		);
		expect(() =>
			recordAnimationWindowProperties(
				scene,
				{
					...base,
					entries: [
						{ targetTrackIndex: 0, property: "position.y" },
						{ targetTrackIndex: 0, property: "recordableFlag" },
					],
				},
				options
			)
		).toThrow("supports only finite number");
		expect(() =>
			recordAnimationWindowProperties(
				scene,
				{
					...base,
					entries: [
						{ targetTrackIndex: 0, property: "position.x" },
						{ nodeId: node.id, property: "position.x" },
					],
				},
				options
			)
		).toThrow("duplicates target property");
		expect(getAnimationWindow(scene, { name: "Atomic Record" })).toMatchObject({ fingerprint: inspected.fingerprint, trackCount: 1, keyCount: 1 });
	});

	test("applies persistent auto, clamped, linear, smooth, broken, and weighted Animation Window tangent modes", () => {
		const node = new TransformNode("Tangent Modes", scene);
		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Tangent Modes",
				targetProperty: "position.x",
				keys: [
					{ frame: 0, value: 0 },
					{ frame: 10, value: 10 },
					{ frame: 20, value: 5 },
				],
			},
			options
		);
		let window = getAnimationWindow(scene, { name: "Tangent Modes" });
		let result = setAnimationWindowTangentModes(
			scene,
			{ name: "Tangent Modes", expectedFingerprint: window.fingerprint, selection: [{ trackIndex: 0, frame: 10 }], mode: "clampedAuto" },
			options
		);
		expect(result).toMatchObject({
			mode: "clampedAuto",
			changedComponentCount: 1,
			changed: [{ trackIndex: 0, frame: 10, component: 0, mode: "clampedAuto", effectiveInTangent: 0, effectiveOutTangent: 0, locked: true }],
		});
		expect(result.window.tracks[0].keys[1].tangentModes[0]).toMatchObject({ mode: "clampedAuto", effectiveInTangent: 0, effectiveOutTangent: 0 });
		expect(scene.getAnimationGroupByName("Tangent Modes")!.serialize().metadata.babylonEditorAnimationTangentModes).toHaveLength(1);

		result = setAnimationWindowTangentModes(
			scene,
			{ name: "Tangent Modes", expectedFingerprint: result.window.fingerprint, selection: [{ trackIndex: 0, frame: 0 }], mode: "auto" },
			options
		);
		expect(result.changed[0]).toMatchObject({ mode: "auto", effectiveInTangent: 1, effectiveOutTangent: 1, locked: true });

		result = setAnimationWindowTangentModes(
			scene,
			{ name: "Tangent Modes", expectedFingerprint: result.window.fingerprint, selection: [{ trackIndex: 0, frame: 10 }], mode: "linear" },
			options
		);
		expect(result.changed[0]).toMatchObject({ mode: "linear", effectiveInTangent: 1, effectiveOutTangent: -0.5, locked: true });

		result = setAnimationWindowTangentModes(
			scene,
			{ name: "Tangent Modes", expectedFingerprint: result.window.fingerprint, selection: [{ trackIndex: 0, frame: 10 }], mode: "freeSmooth", tangent: 0.75 },
			options
		);
		expect(result.changed[0]).toMatchObject({ mode: "freeSmooth", effectiveInTangent: 0.75, effectiveOutTangent: 0.75, locked: true });

		result = setAnimationWindowTangentModes(
			scene,
			{
				name: "Tangent Modes",
				expectedFingerprint: result.window.fingerprint,
				selection: [{ trackIndex: 0, frame: 10 }],
				mode: "broken",
				inTangent: 0.5,
				outTangent: -1,
			},
			options
		);
		expect(result.changed[0]).toMatchObject({ mode: "broken", effectiveInTangent: 0.5, effectiveOutTangent: -1, locked: false });

		result = setAnimationWindowTangentModes(
			scene,
			{
				name: "Tangent Modes",
				expectedFingerprint: result.window.fingerprint,
				selection: [{ trackIndex: 0, frame: 10, component: 0 }],
				mode: "weighted",
				inTangent: 2,
				outTangent: -4,
				inWeight: 0.25,
				outWeight: 0.5,
			},
			options
		);
		expect(result.changed[0]).toMatchObject({
			mode: "weighted",
			authoredInTangent: 2,
			authoredOutTangent: -4,
			inWeight: 0.25,
			outWeight: 0.5,
			effectiveInTangent: 1.5,
			effectiveOutTangent: -6,
			locked: false,
		});
		const weightedKey = scene.getAnimationGroupByName("Tangent Modes")!.targetedAnimations[0].animation.getKeys()[1];
		expect(weightedKey).toMatchObject({ inTangent: 1.5, outTangent: -6, lockedTangent: false });
		const evaluated = scene.getAnimationGroupByName("Tangent Modes")!.targetedAnimations[0].animation.evaluate(15);
		expect(sampleAnimationCurve(scene, { name: "Tangent Modes", trackIndex: 0, from: 10, to: 20, samples: 3 }).samples[1].value).toBeCloseTo(evaluated, 8);

		window = result.window;
		const moved = editAnimationWindowKeys(
			scene,
			{ name: "Tangent Modes", expectedFingerprint: window.fingerprint, selection: [{ trackIndex: 0, frame: 10 }], operation: "move", frameDelta: 2 },
			options
		);
		expect(moved.window.tracks[0].keys.find((key: any) => key.frame === 12).tangentModes[0]).toMatchObject({ mode: "weighted", frame: 12 });

		expect(() =>
			setAnimationWindowTangentModes(
				scene,
				{ name: "Tangent Modes", expectedFingerprint: window.fingerprint, selection: [{ trackIndex: 0, frame: 12 }], mode: "auto" },
				options
			)
		).toThrow("changed after inspection");
		expect(() =>
			setAnimationWindowTangentModes(
				scene,
				{
					name: "Tangent Modes",
					expectedFingerprint: moved.window.fingerprint,
					selection: [
						{ trackIndex: 0, frame: 12 },
						{ trackIndex: 0, frame: 12, component: 0 },
					],
					mode: "linear",
				},
				options
			)
		).toThrow("overlaps");
		expect(() =>
			setAnimationWindowTangentModes(
				scene,
				{
					name: "Tangent Modes",
					expectedFingerprint: moved.window.fingerprint,
					selection: [{ trackIndex: 0, frame: 12 }],
					mode: "weighted",
					inTangent: 1,
					outTangent: 1,
					inWeight: 0,
					outWeight: 0.5,
				},
				options
			)
		).toThrow("inWeight must be finite and between 0.01 and 1");

		createAnimation(
			scene,
			{
				nodeId: node.id,
				name: "Vector Tangent Modes",
				targetProperty: "position",
				keys: [
					{ frame: 0, value: [0, 1, 2] },
					{ frame: 10, value: [10, 11, 12] },
				],
			},
			options
		);
		const vectorWindow = getAnimationWindow(scene, { name: "Vector Tangent Modes" });
		const vectorResult = setAnimationWindowTangentModes(
			scene,
			{
				name: "Vector Tangent Modes",
				expectedFingerprint: vectorWindow.fingerprint,
				selection: [{ trackIndex: 0, frame: 10 }],
				mode: "freeSmooth",
				tangent: 2,
			},
			options
		);
		expect(vectorResult.changedComponentCount).toBe(3);
		expect(vectorResult.changed.map((change: any) => change.component)).toEqual([0, 1, 2]);
		expect(scene.getAnimationGroupByName("Vector Tangent Modes")!.targetedAnimations[0].animation.getKeys()[1]).toMatchObject({
			inTangent: new Vector3(2, 2, 2),
			outTangent: new Vector3(2, 2, 2),
			lockedTangent: true,
		});
	});
});

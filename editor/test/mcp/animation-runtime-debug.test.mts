import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, NullEngine, Scene, TransformNode } from "babylonjs";

import { deleteAnimationGroup, getAnimationRuntimeDebug, setAnimationEvents, setAnimationRuntimeDebug, stepAnimationRuntimeDebug } from "../../src/mcp/animations/animations";

describe("mcp/AnimationGroup runtime debugger", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() } } } } as any;

	function createGroup(name = "Runtime Clip"): { group: AnimationGroup; node: TransformNode } {
		const node = new TransformNode(`${name} Target`, scene);
		const animation = new Animation(`${name} X`, "position.x", 10, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 10, value: 10 },
		]);
		const group = new AnimationGroup(name, scene);
		group.addTargetedAnimation(animation, node);
		return { group, node };
	}

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		vi.clearAllMocks();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reports stopped and paused runtime state with sampled target evidence and exact leases", () => {
		const { group, node } = createGroup();
		let snapshot = getAnimationRuntimeDebug(scene, { name: group.name, trackLimit: 1, historyLimit: 8, eventLimit: 4 });
		expect(snapshot).toMatchObject({ status: "stopped", currentFrame: null, trackPage: { count: 1, total: 1, hasMore: false } });
		expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(snapshot.tracks[0]).toMatchObject({ property: "position.x", currentValue: [0], evaluatedValue: null });

		group.start(true, 1, 0, 10);
		group.goToFrame(2, true);
		group.pause();
		node.position.x = 2.25;
		scene.metadata = { babylonEditorAnimationEventLog: [{ groupName: group.name, frame: 2, action: "log", parameter: "observed" }] };
		snapshot = getAnimationRuntimeDebug(scene, { name: group.name, historyLimit: 8, eventLimit: 4 });
		expect(snapshot).toMatchObject({ status: "paused", isStarted: true, isPlaying: false, currentFrame: 2, recentEvents: [{ parameter: "observed" }] });
		expect(snapshot.tracks[0]).toMatchObject({ currentValue: [2.25], evaluatedValue: [2], maximumComponentDivergence: 0.25 });
		expect(snapshot.history.map((entry: any) => entry.kind)).toEqual(["play", "pause"]);
	});

	test("configures exact frame breakpoints and halts deterministic forward stepping", () => {
		const { group, node } = createGroup();
		getAnimationRuntimeDebug(scene, { name: group.name });
		group.start(true, 1, 0, 10);
		group.goToFrame(2, true);
		group.pause();
		let snapshot = getAnimationRuntimeDebug(scene, { name: group.name });
		const staleFingerprint = snapshot.fingerprint;
		snapshot = setAnimationRuntimeDebug(
			scene,
			{
				name: group.name,
				expectedFingerprint: snapshot.fingerprint,
				breakpoints: [
					{ id: "middle-a", frame: 5, enabled: true },
					{ id: "middle-b", frame: 5, enabled: true },
					{ id: "later", frame: 8, enabled: true },
				],
			},
			options
		);
		expect(() => setAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: staleFingerprint, clearHistory: true }, options)).toThrow("changed after inspection");

		const stepped = stepAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: snapshot.fingerprint, frameDelta: 2, steps: 4, historyLimit: 16 }, options);
		expect(stepped).toMatchObject({
			status: "paused",
			currentFrame: 5,
			stepped: { requestedSteps: 4, completedSteps: 2, haltedByBreakpoint: true, breakpointIds: ["middle-a", "middle-b"] },
		});
		expect(node.position.x).toBeCloseTo(5);
		expect(stepped.history.at(-1)).toMatchObject({ kind: "frameBreakpoint", frame: 5, breakpointIds: ["middle-a", "middle-b"] });
	});

	test("steps backward, wraps looping groups, clamps non-looping groups, and preserves pause", () => {
		const { group } = createGroup();
		getAnimationRuntimeDebug(scene, { name: group.name });
		group.start(true, 1, 0, 10);
		group.goToFrame(1, true);
		group.pause();
		let snapshot = getAnimationRuntimeDebug(scene, { name: group.name });
		let stepped = stepAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: snapshot.fingerprint, frameDelta: -3, steps: 1 }, options);
		expect(stepped).toMatchObject({ currentFrame: 8, loopCount: 1, status: "paused", stepped: { wraps: 1 } });

		snapshot = setAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: stepped.fingerprint, loopAnimation: false, speedRatio: -2, weight: 0.5 }, options);
		group.goToFrame(1, true);
		stepped = stepAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: snapshot.fingerprint, frameDelta: -3, steps: 2 }, options);
		expect(stepped).toMatchObject({ currentFrame: 0, speedRatio: -2, weight: 0.5, loopAnimation: false, status: "paused", stepped: { completedSteps: 2, wraps: 0 } });
	});

	test("halts real live playback at the first crossed breakpoint", () => {
		const { group } = createGroup();
		getAnimationRuntimeDebug(scene, { name: group.name });
		group.start(true, 1, 0, 10);
		group.goToFrame(0, true);
		group.pause();
		let snapshot = getAnimationRuntimeDebug(scene, { name: group.name });
		snapshot = setAnimationRuntimeDebug(
			scene,
			{ name: group.name, expectedFingerprint: snapshot.fingerprint, breakpoints: [{ id: "live", frame: 3, enabled: true }] },
			options
		);
		snapshot = setAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: snapshot.fingerprint, paused: false }, options);
		group.goToFrame(7, true);
		scene.onAfterAnimationsObservable.notifyObservers(scene);
		const hit = getAnimationRuntimeDebug(scene, { name: group.name, historyLimit: 16 });
		expect(hit).toMatchObject({ status: "paused", currentFrame: 3 });
		expect(hit.history.at(-2)).toMatchObject({ kind: "frameBreakpoint", frame: 3, breakpointIds: ["live"], details: { source: "livePlayback" } });
		expect(hit.history.at(-1)).toMatchObject({ kind: "pause", frame: 3 });
	});

	test("deterministic frame sampling does not replay Animation Event callbacks", () => {
		const { group } = createGroup();
		setAnimationEvents(scene, { name: group.name, expectedRevision: 0, events: [{ frame: 5, action: "log", parameter: "must-not-replay" }] }, options);
		getAnimationRuntimeDebug(scene, { name: group.name });
		group.start(true, 1, 0, 10);
		group.goToFrame(0, true);
		group.pause();
		scene.metadata.babylonEditorAnimationEventLog = [];
		const snapshot = getAnimationRuntimeDebug(scene, { name: group.name });
		const stepped = stepAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: snapshot.fingerprint, frameDelta: 6, steps: 1 }, options);
		expect(stepped.currentFrame).toBe(6);
		expect(stepped.recentEvents).toEqual([]);
		expect(scene.metadata.babylonEditorAnimationEventLog).toEqual([]);
	});

	test("validates configuration and requires a started paused group for stepping", () => {
		const { group } = createGroup();
		const stopped = getAnimationRuntimeDebug(scene, { name: group.name });
		expect(() => setAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: stopped.fingerprint, paused: true }, options)).toThrow("must be started");
		expect(() => stepAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: stopped.fingerprint }, options)).toThrow("started and paused");
		expect(() =>
			setAnimationRuntimeDebug(
				scene,
				{
					name: group.name,
					expectedFingerprint: stopped.fingerprint,
					breakpoints: [
						{ id: "duplicate", frame: 2, enabled: true },
						{ id: "duplicate", frame: 3, enabled: true },
					],
				},
				options
			)
		).toThrow("duplicated");
		expect(() =>
			setAnimationRuntimeDebug(scene, { name: group.name, expectedFingerprint: stopped.fingerprint, breakpoints: [{ id: "outside", frame: 11, enabled: true }] }, options)
		).toThrow("between 0 and 10");
	});

	test("bounds trace history and discards debugger state with a deleted group", () => {
		let { group } = createGroup();
		getAnimationRuntimeDebug(scene, { name: group.name });
		group.start(true, 1, 0, 10);
		for (let index = 0; index < 140; index++) {
			group.pause();
			group.restart();
		}
		group.pause();
		const bounded = getAnimationRuntimeDebug(scene, { name: group.name, historyLimit: 256 });
		expect(bounded.history).toHaveLength(256);
		expect(bounded.historyEvidence.droppedCount).toBeGreaterThan(0);

		deleteAnimationGroup(scene, { name: group.name }, options);
		group = createGroup().group;
		const fresh = getAnimationRuntimeDebug(scene, { name: group.name });
		expect(fresh.history).toEqual([]);
		expect(fresh.historyEvidence.droppedCount).toBe(0);
	});
});

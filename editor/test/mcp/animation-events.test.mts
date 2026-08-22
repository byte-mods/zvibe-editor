import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, NullEngine, Scene, TransformNode } from "babylonjs";
import { scriptsDictionary } from "babylonjs-editor-tools";

import { listAnimationEvents, restoreAnimationEvents, setAnimationEvents } from "../../src/mcp/animations/animations";

describe("mcp/animation-events", () => {
	let engine: NullEngine;
	let scene: Scene;
	let group: AnimationGroup;
	let target: TransformNode;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		target = new TransformNode("Event Target", scene);
		const animation = new Animation("Visibility", "position.x", 60, Animation.ANIMATIONTYPE_FLOAT);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 10, value: 10 },
		]);
		group = new AnimationGroup("Trigger", scene);
		group.addTargetedAnimation(animation, target);
	});

	afterEach(() => {
		scriptsDictionary.delete(target);
		scene.dispose();
		engine.dispose();
	});

	test("persists, restores, and executes setEnabled frame events", () => {
		const result = setAnimationEvents(
			scene,
			{ name: "Trigger", expectedRevision: 0, events: [{ frame: 5, action: "setEnabled", nodeId: target.id, enabled: false }] },
			options
		);
		expect(result.groups[0]).toMatchObject({ groupName: "Trigger", revision: 1, events: [{ frame: 5, action: "setEnabled", nodeId: target.id, enabled: false }] });
		expect(result.targetRevision).toBe(1);
		const animation = group.targetedAnimations[0].animation;
		expect(animation.getEvents()).toHaveLength(1);
		animation.getEvents()[0].action(5);
		expect(target.isEnabled()).toBe(false);
		expect(listAnimationEvents(scene, { name: "Trigger" }).recentEvents).toMatchObject([{ groupName: "Trigger", frame: 5, action: "setEnabled" }]);

		animation.removeEvents(5);
		restoreAnimationEvents(scene);
		expect(animation.getEvents()).toHaveLength(1);
	});

	test("validates event action payloads", () => {
		expect(() => setAnimationEvents(scene, { name: "Trigger", expectedRevision: 0, events: [{ frame: 1, action: "setEnabled" }] }, options)).toThrow("requires nodeId");
		expect(() => setAnimationEvents(scene, { name: "Trigger", expectedRevision: 0, events: [{ frame: 1, action: "playAnimationGroup" }] }, options)).toThrow(
			"requires animationGroupName"
		);
	});

	test("invokes script methods through the shared runtime and persists missing-method reporting", () => {
		const receive = vi.fn();
		scriptsDictionary.set(target, [{ key: "src/receiver.ts", instance: { receive } } as any]);
		setAnimationEvents(
			scene,
			{
				name: "Trigger",
				expectedRevision: 0,
				events: [{ frame: 4, action: "scriptMethod", methodName: "receive", arguments: [{ amount: 3 }], missingMethodPolicy: "warning" }],
			},
			options
		);
		group.targetedAnimations[0].animation.getEvents()[0].action(4);

		expect(receive).toHaveBeenCalledWith({ amount: 3 });
		expect(listAnimationEvents(scene, { name: "Trigger" }).recentEvents.at(-1)).toMatchObject({ action: "scriptMethod", status: "executed", invokedMethods: 1 });
	});

	test("rejects stale replacement revisions without changing callbacks", () => {
		setAnimationEvents(scene, { name: "Trigger", expectedRevision: 0, events: [{ frame: 2, action: "log" }] }, options);
		expect(() => setAnimationEvents(scene, { name: "Trigger", expectedRevision: 0, events: [{ frame: 8, action: "log" }] }, options)).toThrow("expectedRevision 1");

		const snapshot = listAnimationEvents(scene, { name: "Trigger" });
		expect(snapshot.targetRevision).toBe(1);
		expect(snapshot.groups[0].events).toEqual([{ frame: 2, action: "log" }]);
	});
});

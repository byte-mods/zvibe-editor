import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation, AnimationGroup, NullEngine, Scene, TransformNode } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

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
		scene.dispose();
		engine.dispose();
	});

	test("persists, restores, and executes setEnabled frame events", () => {
		const result = setAnimationEvents(scene, { name: "Trigger", events: [{ frame: 5, action: "setEnabled", nodeId: target.id, enabled: false }] }, options);
		expect(result.groups[0]).toMatchObject({ groupName: "Trigger", events: [{ frame: 5, action: "setEnabled", nodeId: target.id, enabled: false }] });
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
		expect(() => setAnimationEvents(scene, { name: "Trigger", events: [{ frame: 1, action: "setEnabled" }] }, options)).toThrow("require nodeId");
		expect(() => setAnimationEvents(scene, { name: "Trigger", events: [{ frame: 1, action: "playAnimationGroup" }] }, options)).toThrow("require animationGroupName");
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { configureAnimationEvents, executeAnimationEvent, normalizeAnimationEventConfigurations } from "../../src/loading/animation-events";
import { scriptsDictionary } from "../../src/loading/script/apply";

describe("loading/animation-events", () => {
	let engine: NullEngine;
	let scene: Scene;
	let target: TransformNode;
	let group: AnimationGroup;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		target = new TransformNode("Animated Target", scene);
		const animation = new Animation("Move", "position.x", 60, Animation.ANIMATIONTYPE_FLOAT);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 10, value: 10 },
		]);
		group = new AnimationGroup("Action", scene);
		group.addTargetedAnimation(animation, target);
	});

	afterEach(() => {
		scriptsDictionary.delete(target);
		scriptsDictionary.delete(scene);
		scene.dispose();
		engine.dispose();
		vi.restoreAllMocks();
	});

	test("invokes every matching attached script method with cloned bounded arguments", () => {
		const seen: number[] = [];
		const first = { receive: vi.fn((value: { amount: number }) => void (seen.push(value.amount), (value.amount = 99))) };
		const second = { receive: vi.fn((value: { amount: number }) => void seen.push(value.amount)) };
		scriptsDictionary.set(target, [{ key: "src/first.ts", instance: first } as any, { key: "src/second.ts", instance: second } as any]);
		const argument = { amount: 4 };
		executeAnimationEvent(scene, group.name, { frame: 5, action: "scriptMethod", methodName: "receive", arguments: [argument] });

		expect(first.receive).toHaveBeenCalledOnce();
		expect(second.receive).toHaveBeenCalledOnce();
		expect(seen).toEqual([4, 4]);
		expect(argument).toEqual({ amount: 4 });
		expect(scene.metadata.babylonEditorAnimationEventLog.at(-1)).toMatchObject({ status: "executed", invokedMethods: 2, message: null });
	});

	test("reports missing receivers according to the authored policy without throwing", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		executeAnimationEvent(scene, group.name, { frame: 1, action: "scriptMethod", methodName: "missing", missingMethodPolicy: "error" });
		executeAnimationEvent(scene, group.name, { frame: 2, action: "scriptMethod", methodName: "missing", missingMethodPolicy: "warning" });
		executeAnimationEvent(scene, group.name, { frame: 3, action: "scriptMethod", methodName: "missing", missingMethodPolicy: "ignore" });

		expect(error).toHaveBeenCalledOnce();
		expect(warning).toHaveBeenCalledOnce();
		expect(scene.metadata.babylonEditorAnimationEventLog.map((entry: any) => entry.status)).toEqual(["error", "warning", "ignored"]);
	});

	test("contains script exceptions and records bounded failure evidence", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const later = vi.fn();
		scriptsDictionary.set(target, [
			{
				key: "src/failing.ts",
				instance: {
					fail: () => {
						throw new Error("boom");
					},
				},
			} as any,
			{ key: "src/later.ts", instance: { fail: later } } as any,
		]);

		expect(() => executeAnimationEvent(scene, group.name, { frame: 4, action: "scriptMethod", methodName: "fail" })).not.toThrow();
		expect(later).toHaveBeenCalledOnce();
		expect(scene.metadata.babylonEditorAnimationEventLog.at(-1)).toMatchObject({ status: "error", invokedMethods: 0, message: expect.stringContaining("boom") });
	});

	test("contains throwing getters and asynchronous receiver failures", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const getter = Object.defineProperty({}, "receive", {
			get: () => {
				throw new Error("getter failed");
			},
		});
		scriptsDictionary.set(target, [
			{ key: "src/getter.ts", instance: getter } as any,
			{ key: "src/async.ts", instance: { receive: async () => Promise.reject(new Error("async failed")) } } as any,
		]);

		executeAnimationEvent(scene, group.name, { frame: 4, action: "scriptMethod", methodName: "receive" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(error).toHaveBeenCalledTimes(2);
		expect(scene.metadata.babylonEditorAnimationEventLog.map((entry: any) => entry.message)).toEqual(
			expect.arrayContaining([expect.stringContaining("getter failed"), expect.stringContaining("async failed")])
		);
	});

	test("contains missing built-in targets without claiming successful dispatch", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		executeAnimationEvent(scene, group.name, { frame: 2, action: "setEnabled", nodeId: "missing", enabled: false });
		executeAnimationEvent(scene, group.name, { frame: 3, action: "playAnimationGroup", animationGroupName: "missing" });

		expect(error).toHaveBeenCalledTimes(2);
		expect(scene.metadata.babylonEditorAnimationEventLog.map((entry: any) => entry.status)).toEqual(["error", "error"]);
	});

	test("normalizes legacy actions and rejects unknown or excessive method payloads", () => {
		expect(normalizeAnimationEventConfigurations([{ groupName: "Action", events: [{ frame: 1, action: "log" }] }])).toEqual([
			{ groupName: "Action", revision: 1, events: [{ frame: 1, action: "log" }] },
		]);
		expect(normalizeAnimationEventConfigurations([{ groupName: "Action", revision: 7, events: [] }])).toEqual([{ groupName: "Action", revision: 7, events: [] }]);
		expect(() => normalizeAnimationEventConfigurations([{ groupName: "Action", revision: 0, events: [] }])).toThrow("positive safe integer");
		expect(() => normalizeAnimationEventConfigurations([{ groupName: "Action", events: [{ frame: 1, action: "log", surprise: true }] }])).toThrow("unknown fields");
		expect(() =>
			normalizeAnimationEventConfigurations([
				{ groupName: "Action", events: [{ frame: 1, action: "scriptMethod", methodName: "receive", arguments: Array.from({ length: 17 }, () => 1) }] },
			])
		).toThrow("at most 16");
		expect(() =>
			normalizeAnimationEventConfigurations([{ groupName: "Action", events: [{ frame: 1, action: "scriptMethod", methodName: "receive", arguments: [new Date()] }] }])
		).toThrow("plain JSON-like");
	});

	test("installs normalized callbacks while retaining built-in actions", () => {
		scene.metadata = {
			babylonEditorAnimationEvents: [{ groupName: "Action", events: [{ frame: 5, action: "setEnabled", nodeId: target.id, enabled: false }] }],
		};
		const result = configureAnimationEvents(scene);
		group.targetedAnimations[0].animation.getEvents()[0].action(5);

		expect(result).toEqual({ configuredGroups: 1, configuredEvents: 1, warnings: [] });
		expect(target.isEnabled()).toBe(false);
		expect(scene.metadata.babylonEditorAnimationEventLog.at(-1)).toMatchObject({ action: "setEnabled", status: "executed" });
	});
});

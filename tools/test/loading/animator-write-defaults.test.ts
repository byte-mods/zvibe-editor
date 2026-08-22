import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Animation, AnimationGroup, NullEngine, Scene, TransformNode } from "@babylonjs/core";

import { applyAnimatorWriteDefaults, getAnimatorWriteDefaultsDiagnostics } from "../../src/loading/animator-write-defaults";

describe("loading/animator-write-defaults", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("restores captured defaults only for properties not animated by the entering state", () => {
		const target = new TransformNode("Target", scene);
		target.position.x = 2;
		target.scaling.x = 3;
		const position = new Animation("Position", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		position.setKeys([
			{ frame: 0, value: 2 },
			{ frame: 30, value: 4 },
		]);
		const scaling = new Animation("Scaling", "scaling.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		scaling.setKeys([
			{ frame: 0, value: 3 },
			{ frame: 30, value: 6 },
		]);
		const move = new AnimationGroup("Move", scene);
		const resize = new AnimationGroup("Resize", scene);
		move.addTargetedAnimation(position, target);
		resize.addTargetedAnimation(scaling, target);
		const controller = {
			id: "controller",
			states: [
				{ name: "Move", animationGroup: "Move" },
				{ name: "Resize", animationGroup: "Resize" },
			],
		};

		applyAnimatorWriteDefaults(scene, controller, "$base", { name: "Resize", animationGroup: "Resize" }, [resize]);
		target.position.x = 9;
		target.scaling.x = 8;
		const result = applyAnimatorWriteDefaults(scene, controller, "$base", { name: "Move", animationGroup: "Move", writeDefaultValues: true }, [move]);

		expect(target.position.x).toBe(9);
		expect(target.scaling.x).toBe(3);
		expect(result).toMatchObject({
			enabled: true,
			invocations: 1,
			resetCount: 1,
			knownPropertyCount: 2,
			activePropertyCount: 1,
			lastStateName: "Move",
			lastLayerName: "$base",
			lastResetProperties: ["Target.scaling.x"],
			algorithm: "bounded-controller-default-snapshot-v1",
		});
		expect(getAnimatorWriteDefaultsDiagnostics(scene, controller.id).resetCount).toBe(1);
		target.scaling.x = 8;
		const reevaluated = applyAnimatorWriteDefaults(scene, controller, "$base", { name: "Move", animationGroup: "Move", writeDefaultValues: true }, [move]);
		expect(target.scaling.x).toBe(3);
		expect(reevaluated).toMatchObject({ invocations: 2, resetCount: 2 });
	});

	test("preserves prior animated values when Write Defaults is disabled", () => {
		const target = new TransformNode("Target", scene);
		target.position.x = 2;
		const position = new Animation("Position", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		position.setKeys([{ frame: 0, value: 2 }]);
		const move = new AnimationGroup("Move", scene);
		move.addTargetedAnimation(position, target);
		const controller = { id: "controller", states: [{ name: "Move", animationGroup: "Move" }] };
		applyAnimatorWriteDefaults(scene, controller, "$base", { name: "Move", animationGroup: "Move" }, [move]);
		target.position.x = 7;
		const result = applyAnimatorWriteDefaults(scene, controller, "$base", { name: "Empty", animationGroup: "Missing", writeDefaultValues: false }, []);
		expect(target.position.x).toBe(7);
		expect(result).toMatchObject({ enabled: false, invocations: 0, resetCount: 0 });
	});
});

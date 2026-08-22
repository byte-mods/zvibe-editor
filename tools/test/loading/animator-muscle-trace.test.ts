import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import {
	ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY,
	captureAnimatorHumanoidMuscleTrace,
	clearAnimatorHumanoidMuscleTrace,
	getAnimatorHumanoidMuscleTrace,
} from "../../src/loading/animator-muscle-trace";
import { configureAnimators } from "../../src/loading/animator";

describe("Animator Humanoid muscle tracing", () => {
	let engine: NullEngine;
	let scene: Scene;
	let bone: Bone;
	let controller: { id: string; name: string; humanoidAvatarId?: string; activeState?: string; layers?: Array<{ name: string; activeState?: string; weight?: number }> };

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		const skeleton = new Skeleton("Hero", "hero-skeleton", scene);
		bone = new Bone("LeftArm", skeleton, null, Matrix.Identity(), Matrix.Identity());
		bone.rotationQuaternion = Quaternion.Identity();
		controller = { id: "locomotion", name: "Locomotion", humanoidAvatarId: "hero-avatar", activeState: "Idle", layers: [{ name: "Upper", activeState: "Aim", weight: 0.75 }] };
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "hero-avatar",
					name: "Hero Avatar",
					skeletonId: skeleton.id,
					animationType: "humanoid",
					source: "model",
					mapping: { leftUpperArm: bone.name },
					restPose: { [bone.name]: { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] } },
					humanScale: 1,
					muscleLimitsEnabled: true,
					muscleLimits: { leftUpperArm: { min: [-10, -10, -10], max: [10, 10, 10] } },
				},
			],
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("captures post-Animator values, normalized deltas, violations, filters, and newest-first pagination without mutating reads", () => {
		bone.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), (20 * Math.PI) / 180);
		const first = captureAnimatorHumanoidMuscleTrace(scene, controller, { runtimeSeconds: 0.1, deltaSeconds: 0.1 })!;
		expect(first).toMatchObject({ sequence: 1, baseState: "Idle", limitViolationCount: 1, samplingPhase: "postAnimatorPreMuscleLimit" });
		expect(first.layers).toEqual([{ name: "Upper", activeState: "Aim", weight: 0.75 }]);
		expect(first.muscles[0].normalized[0]).toBeCloseTo(1);
		expect(first.muscles[0].deltaNormalized).toEqual([0, 0, 0]);

		bone.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), (-5 * Math.PI) / 180);
		const second = captureAnimatorHumanoidMuscleTrace(scene, controller, { runtimeSeconds: 0.2, deltaSeconds: 0.1 })!;
		expect(second.sequence).toBe(2);
		expect(second.limitViolationCount).toBe(0);
		expect(second.muscles[0].normalized[0]).toBeCloseTo(-0.5);
		expect(second.muscles[0].deltaNormalized[0]).toBeCloseTo(-1.5);

		const before = getAnimatorHumanoidMuscleTrace(scene, controller, { roles: ["leftUpperArm"], offset: 0, limit: 1 });
		const after = getAnimatorHumanoidMuscleTrace(scene, controller, { roles: ["leftUpperArm"], offset: 1, limit: 1 });
		expect(before.history).toMatchObject({ offset: 0, limit: 1, count: 1, total: 2, hasMore: true, nextOffset: 1 });
		expect(before.history.items[0].sequence).toBe(2);
		expect(after.history.items[0].sequence).toBe(1);
		expect(after.revision).toBe(before.revision);
		expect(before.current?.muscles).toHaveLength(1);
	});

	test("bounds history, accounts for dropped samples, and resets sequence state on clear or Avatar reassignment", () => {
		for (let index = 0; index < ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY + 4; index++) {
			captureAnimatorHumanoidMuscleTrace(scene, controller, { runtimeSeconds: index / 60, deltaSeconds: 1 / 60 });
		}
		const bounded = getAnimatorHumanoidMuscleTrace(scene, controller, { limit: 1 });
		expect(bounded.history.total).toBe(ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY);
		expect(bounded.droppedSampleCount).toBe(4);
		expect(bounded.latest?.sequence).toBe(ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY + 4);

		const cleared = clearAnimatorHumanoidMuscleTrace(scene, controller);
		expect(cleared.history.total).toBe(0);
		expect(cleared.droppedSampleCount).toBe(0);
		expect(captureAnimatorHumanoidMuscleTrace(scene, controller, { runtimeSeconds: 5, deltaSeconds: 0.1 })?.sequence).toBe(1);

		controller.humanoidAvatarId = undefined;
		const disabled = getAnimatorHumanoidMuscleTrace(scene, controller);
		expect(disabled).toMatchObject({ enabled: false, avatarId: null, current: null, latest: null });
		expect(disabled.history.total).toBe(0);
	});

	test("captures the same trace through exported AnimatorControllerRuntime updates and exposes it in debugger snapshots", () => {
		new AnimationGroup("Idle", scene);
		controller = { id: "runtime-controller", name: "Runtime", humanoidAvatarId: "hero-avatar", activeState: "Idle" };
		scene.metadata.babylonEditorAnimatorControllers = [
			{
				...controller,
				parameters: {},
				states: [{ name: "Idle", animationGroup: "Idle" }],
				transitions: [],
				entryState: "Idle",
			},
		];
		configureAnimators(scene);
		const runtime = scene.animators?.get(controller.id)!;
		bone.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), (5 * Math.PI) / 180);
		expect(runtime.update(0.125)).toBe(false);
		const debug = runtime.getDebugSnapshot();
		expect(debug.humanoidAvatarId).toBe("hero-avatar");
		expect(debug.humanoidMuscleTrace).toMatchObject({ enabled: true, history: { total: 1 }, latest: { sequence: 1, runtimeSeconds: 0.125 } });
		runtime.dispose();
		expect(getAnimatorHumanoidMuscleTrace(scene, controller).history.total).toBe(0);
	});
});

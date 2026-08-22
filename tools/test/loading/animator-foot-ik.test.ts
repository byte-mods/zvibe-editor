import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Bone, Matrix, MeshBuilder, NullEngine, Scene, Skeleton, Space } from "@babylonjs/core";

import { applyAnimatorFootIK, getAnimatorFootIKDiagnostics } from "../../src/loading/animator-foot-ik";

describe("loading/animator-foot-ik", () => {
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

	test("stabilizes both mapped Humanoid feet against pickable ground with bounded CCD", () => {
		const skeleton = new Skeleton("Humanoid", "humanoid-skeleton", scene);
		const hips = new Bone("Hips", skeleton, null, Matrix.Translation(0, 1, 0), Matrix.Translation(0, 1, 0));
		const leftUpper = new Bone("LeftUpperLeg", skeleton, hips, Matrix.Translation(-0.3, 0, 0), Matrix.Translation(-0.3, 0, 0));
		const leftLower = new Bone("LeftLowerLeg", skeleton, leftUpper, Matrix.Translation(0.5, -0.4, 0), Matrix.Translation(0.5, -0.4, 0));
		const leftFoot = new Bone("LeftFoot", skeleton, leftLower, Matrix.Translation(-0.5, -0.4, 0), Matrix.Translation(-0.5, -0.4, 0));
		const rightUpper = new Bone("RightUpperLeg", skeleton, hips, Matrix.Translation(0.3, 0, 0), Matrix.Translation(0.3, 0, 0));
		const rightLower = new Bone("RightLowerLeg", skeleton, rightUpper, Matrix.Translation(-0.5, -0.4, 0), Matrix.Translation(-0.5, -0.4, 0));
		const rightFoot = new Bone("RightFoot", skeleton, rightLower, Matrix.Translation(0.5, -0.4, 0), Matrix.Translation(0.5, -0.4, 0));
		const character = MeshBuilder.CreateBox("Character", { size: 0.1 }, scene);
		character.skeleton = skeleton;
		MeshBuilder.CreateGround("Ground", { width: 10, height: 10 }, scene);
		scene.metadata = {
			babylonEditorHumanoidAvatars: [
				{
					version: 1,
					id: "avatar",
					name: "Avatar",
					skeletonId: skeleton.id,
					animationType: "humanoid",
					source: "model",
					mapping: {
						leftUpperLeg: leftUpper.name,
						leftLowerLeg: leftLower.name,
						leftFoot: leftFoot.name,
						rightUpperLeg: rightUpper.name,
						rightLowerLeg: rightLower.name,
						rightFoot: rightFoot.name,
					},
					restPose: {},
					humanScale: 1,
				},
			],
		};

		const result = applyAnimatorFootIK(
			scene,
			{ id: "controller", name: "Controller", humanoidAvatarId: "avatar" },
			{ name: "$base", weight: 1 },
			{ name: "Walk", footIK: true }
		);
		expect(result).toMatchObject({
			enabled: true,
			invocations: 1,
			solvedFeet: 2,
			failedFeet: 0,
			algorithm: "bounded-ground-ray-ccd-v1",
			lastFeet: [
				{ role: "leftFoot", status: "solved", groundMeshName: "Ground" },
				{ role: "rightFoot", status: "solved", groundMeshName: "Ground" },
			],
		});
		skeleton.computeAbsoluteMatrices(true);
		expect(leftFoot.getPosition(Space.WORLD, character).y).toBeCloseTo(0.01, 2);
		expect(rightFoot.getPosition(Space.WORLD, character).y).toBeCloseTo(0.01, 2);
		expect(getAnimatorFootIKDiagnostics(scene, { id: "controller", name: "Controller", humanoidAvatarId: "avatar" }).layers[0].solvedFeet).toBe(2);
	});

	test("reports missing Humanoid configuration without mutating the scene", () => {
		const result = applyAnimatorFootIK(scene, { id: "missing", name: "Missing" }, { name: "$base", weight: 1 }, { name: "Walk", footIK: true });
		expect(result).toMatchObject({ enabled: true, failedFeet: 2, avatarId: null, skeletonId: null });
		expect(result.warnings[0]).toContain("Humanoid Avatar");
	});
});

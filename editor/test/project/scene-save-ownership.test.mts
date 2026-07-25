import { describe, expect, test, vi } from "vitest";

import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";
import { createSceneSaveOwnershipPredicate, getScenePathsToSave } from "../../src/project/save/ownership";

describe("project/save scene ownership", () => {
	test("selects exact owners and assigns unclaimed objects only to the active scene", () => {
		const workspace = new EditorSceneWorkspace();
		workspace.configure({
			version: 1,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/B.scene",
			lightingScene: "assets/A.scene",
		});
		const ownedA = {};
		const ownedB = {};
		const unowned = {};
		workspace.claimObjects("assets/A.scene", [ownedA]);
		workspace.claimObjects("assets/B.scene", [ownedB]);
		const foundUnowned = vi.fn();

		const belongsToA = createSceneSaveOwnershipPredicate(workspace, "assets/A.scene", foundUnowned);
		const belongsToB = createSceneSaveOwnershipPredicate(workspace, "assets/B.scene", foundUnowned);

		expect([ownedA, ownedB, unowned].filter(belongsToA)).toEqual([ownedA]);
		expect([ownedA, ownedB, unowned].filter(belongsToB)).toEqual([ownedB, unowned]);
		expect(foundUnowned).toHaveBeenCalledWith(unowned);
	});

	test("saves the active scene plus independently dirty inactive scenes", () => {
		expect(
			getScenePathsToSave([
				{ path: "assets/A.scene", isActive: false, isLighting: true, isDirty: false },
				{ path: "assets/B.scene", isActive: true, isLighting: false, isDirty: false },
				{ path: "assets/C.scene", isActive: false, isLighting: false, isDirty: true },
			])
		).toEqual(["assets/A.scene", "assets/B.scene", "assets/C.scene"]);
	});
});

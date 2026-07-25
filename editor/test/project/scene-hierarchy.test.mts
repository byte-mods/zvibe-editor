import { NullEngine, Scene, TransformNode } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";
import { getAuthoringSceneRootNodes, getSceneScopedHierarchyId } from "../../src/project/scene-hierarchy";

const scenes: Scene[] = [];

afterEach(() => scenes.splice(0).forEach((scene) => scene.dispose()));

describe("project additive scene hierarchy", () => {
	test("partitions roots by owner while treating cross-scene parents as scene roots", () => {
		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const workspace = new EditorSceneWorkspace();
		workspace.configure({
			version: 1,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/B.scene",
			lightingScene: "assets/A.scene",
		});
		const rootA = new TransformNode("A", scene);
		const childA = new TransformNode("A child", scene);
		childA.parent = rootA;
		const rootB = new TransformNode("B", scene);
		const crossSceneChild = new TransformNode("B cross child", scene);
		crossSceneChild.parent = rootA;
		const unownedNewNode = new TransformNode("New", scene);
		workspace.claimObjects("assets/A.scene", [rootA, childA]);
		workspace.claimObjects("assets/B.scene", [rootB, crossSceneChild]);

		expect(getAuthoringSceneRootNodes(scene, workspace, "assets/A.scene")).toEqual([rootA]);
		expect(getAuthoringSceneRootNodes(scene, workspace, "assets/B.scene")).toEqual([rootB, crossSceneChild, unownedNewNode]);
	});

	test("scopes duplicate local IDs by authored scene", () => {
		const workspace = new EditorSceneWorkspace();
		workspace.configure({
			version: 1,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/A.scene",
			lightingScene: "assets/A.scene",
		});
		const nodeA = {};
		const nodeB = {};
		workspace.claimObjects("assets/A.scene", [nodeA]);
		workspace.claimObjects("assets/B.scene", [nodeB]);

		expect(getSceneScopedHierarchyId(workspace, nodeA, "duplicate")).toBe("assets/A.scene::duplicate");
		expect(getSceneScopedHierarchyId(workspace, nodeB, "duplicate")).toBe("assets/B.scene::duplicate");
	});
});

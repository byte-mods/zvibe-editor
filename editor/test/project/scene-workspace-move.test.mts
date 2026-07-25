import { Animation, AnimationGroup, MeshBuilder, NullEngine, ParticleSystem, Scene, StandardMaterial, TransformNode } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";
import { planSceneObjectMove } from "../../src/project/scene-workspace-move";
import { moveGraphSelectedNodesToScene } from "../../src/editor/layout/graph/move";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

const scenes: Scene[] = [];

afterEach(() => {
	clearUndoRedo();
	scenes.splice(0).forEach((scene) => scene.dispose());
});

function createWorkspace(): EditorSceneWorkspace {
	const workspace = new EditorSceneWorkspace();
	workspace.configure({
		version: 1,
		loadedScenes: ["assets/A.scene", "assets/B.scene"],
		activeScene: "assets/A.scene",
		lightingScene: "assets/A.scene",
	});
	return workspace;
}

describe("project cross-scene object moves", () => {
	test("plans a complete root subtree and its exclusive save dependencies", () => {
		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const workspace = createWorkspace();
		const root = new TransformNode("A root", scene);
		const mesh = MeshBuilder.CreateBox("A mesh", {}, scene);
		mesh.parent = root;
		const material = new StandardMaterial("A material", scene);
		mesh.material = material;
		const particleSystem = new ParticleSystem("A particles", 8, scene);
		particleSystem.emitter = mesh;
		workspace.claimObjects("assets/A.scene", [root, mesh, material, mesh.geometry!, particleSystem]);

		const plan = planSceneObjectMove(scene, workspace, [root], "assets/B.scene");

		expect(plan.rootNodes).toEqual([root]);
		expect(plan.objects).toEqual(expect.arrayContaining([root, mesh, material, mesh.geometry!, particleSystem]));
		expect(plan.previousOwners.get(mesh)).toBe("assets/A.scene");
		expect(plan.sourceScenes).toEqual(["assets/A.scene"]);
	});

	test("keeps shared resources with their existing scene while moving consumers", () => {
		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const workspace = createWorkspace();
		const rootA = MeshBuilder.CreateBox("A", {}, scene);
		const rootB = MeshBuilder.CreateBox("B", {}, scene);
		const sharedMaterial = new StandardMaterial("Shared", scene);
		rootA.material = sharedMaterial;
		rootB.material = sharedMaterial;
		workspace.claimObjects("assets/A.scene", [rootA, sharedMaterial, rootA.geometry!]);
		workspace.claimObjects("assets/B.scene", [rootB, rootB.geometry!]);

		const plan = planSceneObjectMove(scene, workspace, [rootA], "assets/B.scene");

		expect(plan.objects).toContain(rootA);
		expect(plan.objects).not.toContain(sharedMaterial);
	});

	test("rejects non-root transfers and animation groups split across scenes", () => {
		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const workspace = createWorkspace();
		const root = new TransformNode("Root", scene);
		const child = new TransformNode("Child", scene);
		child.parent = root;
		const sibling = new TransformNode("Sibling", scene);
		workspace.claimObjects("assets/A.scene", [root, child, sibling]);

		expect(() => planSceneObjectMove(scene, workspace, [child], "assets/B.scene")).toThrow("Only scene-root objects");

		const group = new AnimationGroup("Split", scene);
		const animation = new Animation("position", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 1 },
		]);
		group.addTargetedAnimation(animation, root);
		group.addTargetedAnimation(animation.clone(), sibling);
		workspace.claimObjects("assets/A.scene", [group]);
		expect(() => planSceneObjectMove(scene, workspace, [root], "assets/B.scene")).toThrow("targets objects on both sides");
	});

	test("executes cross-scene ownership and cross-parent removal as one undoable command", () => {
		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const workspace = createWorkspace();
		const parentB = new TransformNode("B parent", scene);
		parentB.position.x = 10;
		const rootA = new TransformNode("A root", scene);
		rootA.position.x = 2;
		rootA.parent = parentB;
		workspace.claimObjects("assets/A.scene", [rootA]);
		workspace.claimObjects("assets/B.scene", [parentB]);
		const refresh = () => Promise.resolve();
		const editor = {
			sceneWorkspace: workspace,
			layout: {
				preview: { scene },
				graph: { getSelectedNodes: () => [{ id: "A", nodeData: rootA }], refresh },
			},
		} as any;
		const worldX = rootA.getAbsolutePosition().x;

		moveGraphSelectedNodesToScene(editor, "assets/B.scene");
		expect(workspace.getOwner(rootA)).toBe("assets/B.scene");
		expect(rootA.parent).toBeNull();
		expect(rootA.getAbsolutePosition().x).toBeCloseTo(worldX);

		undo();
		expect(workspace.getOwner(rootA)).toBe("assets/A.scene");
		expect(rootA.parent).toBe(parentB);
		expect(rootA.position.x).toBe(2);

		redo();
		expect(workspace.getOwner(rootA)).toBe("assets/B.scene");
		expect(rootA.parent).toBeNull();
	});
});

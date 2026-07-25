import { describe, expect, test, vi } from "vitest";

import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";

function createWorkspace(): EditorSceneWorkspace {
	const workspace = new EditorSceneWorkspace();
	workspace.configure({
		version: 1,
		loadedScenes: ["assets/A.scene", "assets/B.scene"],
		activeScene: "assets/A.scene",
		lightingScene: "assets/B.scene",
	});
	return workspace;
}

describe("project/scene-workspace-runtime", () => {
	test("rejects invalid runtime settings even when normalization is bypassed", () => {
		const workspace = new EditorSceneWorkspace();
		expect(() => workspace.configure({ version: 1, loadedScenes: ["assets/A.scene"], activeScene: "assets/Missing.scene", lightingScene: "assets/A.scene" })).toThrow(
			"Invalid additive scene workspace settings"
		);
	});

	test("claims each object for exactly one loaded scene", () => {
		const workspace = createWorkspace();
		const object = {};

		expect(workspace.claimObjects("assets/A.scene", [object])).toBe(1);
		expect(workspace.claimObjects("assets/A.scene", [object])).toBe(0);
		expect(() => workspace.claimObjects("assets/B.scene", [object])).toThrow("already owned");
		expect(workspace.getOwner(object)).toBe("assets/A.scene");
	});

	test("transfers ownership atomically and dirties both scenes", () => {
		const workspace = createWorkspace();
		const first = {};
		const second = {};
		workspace.claimObjects("assets/A.scene", [first, second]);

		expect(workspace.claimObjects("assets/B.scene", [first, second], true)).toBe(2);
		expect(workspace.getLoadedSceneStates()).toEqual([
			{ path: "assets/A.scene", isActive: true, isLighting: false, isDirty: true, ownedObjectCount: 0 },
			{ path: "assets/B.scene", isActive: false, isLighting: true, isDirty: true, ownedObjectCount: 2 },
		]);
	});

	test("unloading selects deterministic active and lighting fallbacks", () => {
		const workspace = createWorkspace();
		const object = {};
		workspace.claimObjects("assets/A.scene", [object]);

		expect(workspace.removeLoadedScene("assets/A.scene")).toEqual([object]);
		expect(workspace.getSettings()).toEqual({
			version: 1,
			loadedScenes: ["assets/B.scene"],
			activeScene: "assets/B.scene",
			lightingScene: "assets/B.scene",
		});
		expect(workspace.getOwner(object)).toBeNull();
		expect(() => workspace.removeLoadedScene("assets/Missing.scene")).toThrow("not loaded");
	});

	test("notifies subscribers only for effective state changes", () => {
		const workspace = createWorkspace();
		const listener = vi.fn();
		const unsubscribe = workspace.subscribe(listener);

		workspace.setDirty("assets/A.scene");
		workspace.setDirty("assets/A.scene");
		workspace.setDirty("assets/A.scene", false);
		unsubscribe();
		workspace.setActiveScene("assets/B.scene");

		expect(listener).toHaveBeenCalledTimes(2);
	});

	test("applies persisted selection changes without losing ownership or dirtiness", () => {
		const workspace = createWorkspace();
		const object = {};
		workspace.claimObjects("assets/A.scene", [object]);
		workspace.setDirty("assets/A.scene");

		workspace.applySettings({
			version: 1,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/B.scene",
			lightingScene: "assets/B.scene",
		});

		expect(workspace.getOwner(object)).toBe("assets/A.scene");
		expect(workspace.getLoadedSceneStates()[0]).toMatchObject({ isDirty: true, ownedObjectCount: 1 });
	});

	test("disposes exact load handles when scenes leave the workspace", () => {
		const workspace = createWorkspace();
		const disposeA = vi.fn();
		const disposeB = vi.fn();
		workspace.setLoadedSceneHandle("assets/A.scene", { configuration: { name: "A" }, dispose: disposeA });
		workspace.setLoadedSceneHandle("assets/B.scene", { configuration: { name: "B" }, dispose: disposeB });
		expect(workspace.getLoadedSceneConfiguration("assets/A.scene")).toEqual({ name: "A" });
		workspace.setLoadedSceneConfiguration("assets/A.scene", { name: "A2" });
		expect(workspace.getLoadedSceneConfiguration("assets/A.scene")).toEqual({ name: "A2" });

		workspace.removeLoadedScene("assets/A.scene");
		expect(disposeA).toHaveBeenCalledOnce();
		expect(disposeB).not.toHaveBeenCalled();

		workspace.configure({ version: 1, loadedScenes: ["assets/B.scene"], activeScene: "assets/B.scene", lightingScene: "assets/B.scene" });
		expect(disposeB).toHaveBeenCalledOnce();
	});

	test("reapplies a completed handle's retained lighting configuration", async () => {
		const workspace = createWorkspace();
		const applyLighting = vi.fn(async () => undefined);
		workspace.setLoadedSceneHandle("assets/B.scene", { configuration: { name: "B" }, applyLighting, dispose: vi.fn() });

		await workspace.applyLoadedSceneLighting("assets/B.scene");

		expect(applyLighting).toHaveBeenCalledOnce();
		await expect(workspace.applyLoadedSceneLighting("assets/A.scene")).rejects.toThrow("no completed load handle");
	});

	test("marks an owned edit dirty and assigns a new edit to the active scene", () => {
		const workspace = createWorkspace();
		const owned = {};
		const newlyAuthored = {};
		workspace.claimObjects("assets/B.scene", [owned]);

		expect(workspace.markObjectDirty(owned)).toBe("assets/B.scene");
		expect(workspace.markObjectDirty(newlyAuthored)).toBe("assets/A.scene");
		expect(workspace.getOwner(newlyAuthored)).toBe("assets/A.scene");
		expect(workspace.getLoadedSceneStates().map((state) => state.isDirty)).toEqual([true, true]);
	});

	test("claims exact newly imported batches for the active scene", () => {
		const workspace = createWorkspace();
		const alreadyOwned = {};
		const node = {};
		const material = {};
		workspace.claimObjects("assets/B.scene", [alreadyOwned]);

		expect(workspace.claimNewObjectsForActiveScene([node, material, node, alreadyOwned])).toBe(2);
		expect(workspace.getOwner(node)).toBe("assets/A.scene");
		expect(workspace.getOwner(material)).toBe("assets/A.scene");
		expect(workspace.getOwner(alreadyOwned)).toBe("assets/B.scene");
		expect(workspace.getLoadedSceneStates()[0].isDirty).toBe(true);
	});
});

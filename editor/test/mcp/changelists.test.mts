import { symlink } from "fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { createProjectChangelist, deleteProjectChangelist, listProjectChangelists, setProjectChangelist, setProjectChangelistFiles } from "../../src/mcp/project/changelists";

describe("mcp/project/changelists", () => {
	let directory: string;
	let outsideDirectory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-changelists-"));
		outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-changelists-outside-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await ensureDir(join(directory, "assets"));
		await writeJSON(options.editor.state.projectPath, {});
		await writeFile(join(directory, "assets", "hero.glb"), "hero", "utf-8");
		await writeFile(join(directory, "assets", "level.prefab"), "{}", "utf-8");
		await writeFile(join(outsideDirectory, "secret.glb"), "secret", "utf-8");
		await symlink(join(outsideDirectory, "secret.glb"), join(directory, "assets", "linked-secret.glb"));
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await remove(directory);
		await remove(outsideDirectory);
	});

	test("creates, edits, assigns, lists, and safely deletes persistent changelists", async () => {
		const created = await createProjectChangelist(scene, { name: "Character Work", description: "Hero rig and model", owner: "Alice", paths: ["assets/hero.glb"] }, options);
		expect(created).toMatchObject({ created: true, changelist: { name: "Character Work", owner: "Alice", paths: ["assets/hero.glb"] } });
		await expect(setProjectChangelist(scene, { id: created.changelist.id, newName: "Hero Work", owner: "Rig Team" }, options)).resolves.toMatchObject({
			updated: true,
			changelist: { name: "Hero Work", owner: "Rig Team" },
		});
		await expect(
			setProjectChangelistFiles(scene, { id: created.changelist.id, mode: "add", paths: ["assets/level.prefab", "assets/deleted-texture.png"] }, options)
		).resolves.toMatchObject({ updated: true, changelist: { paths: ["assets/deleted-texture.png", "assets/hero.glb", "assets/level.prefab"] } });
		await expect(listProjectChangelists(scene, { owner: "Rig Team" }, options)).resolves.toMatchObject({ count: 1, assignedFileCount: 3 });
		await expect(deleteProjectChangelist(scene, { id: created.changelist.id }, options)).rejects.toThrow("still contains 3 files");
		await expect(deleteProjectChangelist(scene, { id: created.changelist.id, force: true }, options)).resolves.toMatchObject({ deleted: true, forced: true });
		await expect(listProjectChangelists(scene, {}, options)).resolves.toMatchObject({ count: 0, assignedFileCount: 0 });
	});

	test("serializes concurrent file assignment and supports explicit reassignment", async () => {
		const results = await Promise.allSettled([
			createProjectChangelist(scene, { name: "A", owner: "Alice", paths: ["assets/hero.glb"] }, options),
			createProjectChangelist(scene, { name: "B", owner: "Bob", paths: ["assets/hero.glb"] }, options),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const first = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>).value.changelist;
		const second = await createProjectChangelist(scene, { name: "Unassigned", owner: "Bob" }, options);
		await expect(setProjectChangelistFiles(scene, { id: second.changelist.id, mode: "add", paths: ["assets/hero.glb"] }, options)).rejects.toThrow("already assigned");
		const reassigned = await setProjectChangelistFiles(scene, { id: second.changelist.id, mode: "add", paths: ["assets/hero.glb"], reassign: true }, options);
		expect(reassigned).toMatchObject({ reassigned: true, movedFrom: [{ id: first.id, paths: ["assets/hero.glb"] }], changelist: { paths: ["assets/hero.glb"] } });
		const listed = await listProjectChangelists(scene, {}, options);
		expect(listed.changelists.find((changelist: any) => changelist.id === first.id).paths).toEqual([]);
	});

	test("rejects traversal, collaboration metadata, directories, symlink escapes, duplicate names, and malformed stores", async () => {
		await expect(createProjectChangelist(scene, { name: "Unsafe", owner: "Alice", paths: ["../outside"] }, options)).rejects.toThrow("stay inside");
		await expect(createProjectChangelist(scene, { name: "Metadata", owner: "Alice", paths: [".babylon-editor/changelists.json"] }, options)).rejects.toThrow(
			"collaboration metadata"
		);
		await expect(createProjectChangelist(scene, { name: "Folder", owner: "Alice", paths: ["assets"] }, options)).rejects.toThrow("not directories");
		await expect(createProjectChangelist(scene, { name: "Link", owner: "Alice", paths: ["assets/linked-secret.glb"] }, options)).rejects.toThrow("resolve inside");
		await createProjectChangelist(scene, { name: "Unique", owner: "Alice" }, options);
		await expect(createProjectChangelist(scene, { name: "unique", owner: "Bob" }, options)).rejects.toThrow("already exists");

		await writeFile(join(directory, ".babylon-editor", "changelists.json"), "{ broken", "utf-8");
		await expect(listProjectChangelists(scene, {}, options)).rejects.toThrow("invalid JSON");
	});
});

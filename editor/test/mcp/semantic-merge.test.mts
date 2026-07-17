import { readFile, symlink } from "fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { mergeProjectSceneAssets } from "../../src/mcp/project/semantic-merge";

describe("mcp/project/semantic-merge", () => {
	let directory: string;
	let outsideDirectory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-semantic-merge-"));
		outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-semantic-merge-outside-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(options.editor.state.projectPath, {});
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await remove(directory);
		await remove(outsideDirectory);
	});

	test("automatically merges independent prefab edits and stable-identity array additions", async () => {
		await writeJSON(join(directory, "base.prefab"), { meshes: [{ id: "hero", position: [0, 0, 0], health: 100 }] });
		await writeJSON(join(directory, "ours.prefab"), { meshes: [{ id: "hero", position: [2, 0, 0], health: 100 }] });
		await writeJSON(join(directory, "theirs.prefab"), {
			meshes: [
				{ id: "rock", position: [4, 0, 3] },
				{ id: "hero", position: [0, 0, 0], health: 80 },
			],
		});

		const preview = await mergeProjectSceneAssets(scene, { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", maximumConflicts: 20 }, options);
		expect(preview).toMatchObject({ written: false, summary: { totalConflicts: 0, returnedConflicts: 0, fileCount: 1 } });
		expect(preview.output.hash).toMatch(/^[a-f0-9]{64}$/);

		const applied = await mergeProjectSceneAssets(
			scene,
			{
				basePath: "base.prefab",
				oursPath: "ours.prefab",
				theirsPath: "theirs.prefab",
				outputPath: "merged.prefab",
				write: true,
				expectedBaseHash: preview.base.hash,
				expectedOursHash: preview.ours.hash,
				expectedTheirsHash: preview.theirs.hash,
			},
			options
		);
		expect(applied).toMatchObject({ written: true, output: { path: "merged.prefab" }, summary: { totalConflicts: 0 } });
		const merged = await readJSON(join(directory, "merged.prefab"));
		expect(merged.meshes).toEqual([
			{ id: "hero", position: [2, 0, 0], health: 80 },
			{ id: "rock", position: [4, 0, 3] },
		]);
	});

	test("reports conflicting edits, blocks unresolved writes, and applies an explicit resolution", async () => {
		await writeJSON(join(directory, "base.prefab"), { value: 0 });
		await writeJSON(join(directory, "ours.prefab"), { value: 1 });
		await writeJSON(join(directory, "theirs.prefab"), { value: 2 });

		const preview = await mergeProjectSceneAssets(scene, { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab" }, options);
		expect(preview).toMatchObject({ written: false, summary: { totalConflicts: 1, returnedConflicts: 1 } });
		expect(preview.conflicts[0]).toMatchObject({ file: "prefab.json", path: "/value", resolution: "manual" });
		await expect(
			mergeProjectSceneAssets(scene, { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "blocked.prefab", write: true }, options)
		).rejects.toThrow("unresolved conflicts");

		await mergeProjectSceneAssets(
			scene,
			{ basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "resolved.prefab", write: true, resolution: "theirs" },
			options
		);
		expect(await readJSON(join(directory, "resolved.prefab"))).toEqual({ value: 2 });
	});

	test("writes merged scene manifests while preserving ours binary files", async () => {
		for (const name of ["Base.scene", "Ours.scene", "Theirs.scene"]) {
			await ensureDir(join(directory, name));
		}
		await writeJSON(join(directory, "Base.scene", "config.json"), { exposure: 1, gravity: -9.81 });
		await writeJSON(join(directory, "Ours.scene", "config.json"), { exposure: 2, gravity: -9.81 });
		await writeJSON(join(directory, "Theirs.scene", "config.json"), { exposure: 1, gravity: -4.9 });
		await writeJSON(join(directory, "Base.scene", "removed.json"), { id: "old" });
		await writeJSON(join(directory, "Theirs.scene", "removed.json"), { id: "old" });
		await writeJSON(join(directory, "Theirs.scene", "added.json"), { id: "new" });
		await writeFile(join(directory, "Ours.scene", "geometries.bin"), "ours-binary", "utf-8");

		const result = await mergeProjectSceneAssets(
			scene,
			{ basePath: "Base.scene", oursPath: "Ours.scene", theirsPath: "Theirs.scene", outputPath: "Merged.scene", write: true },
			options
		);
		expect(result).toMatchObject({ kind: "scene", written: true, summary: { totalConflicts: 0, fileCount: 2 } });
		expect(await readJSON(join(directory, "Merged.scene", "config.json"))).toEqual({ exposure: 2, gravity: -4.9 });
		expect(await readJSON(join(directory, "Merged.scene", "added.json"))).toEqual({ id: "new" });
		await expect(readFile(join(directory, "Merged.scene", "removed.json"), "utf-8")).rejects.toThrow();
		expect(await readFile(join(directory, "Merged.scene", "geometries.bin"), "utf-8")).toBe("ours-binary");
	});

	test("rejects stale hashes, unsafe or existing outputs, mixed kinds, and symlink escapes", async () => {
		for (const name of ["base.prefab", "ours.prefab", "theirs.prefab", "existing.prefab"]) {
			await writeJSON(join(directory, name), { value: name });
		}
		await ensureDir(join(directory, "Valid.scene"));
		await writeJSON(join(directory, "Valid.scene", "config.json"), {});
		await writeJSON(join(outsideDirectory, "outside.prefab"), {});
		await symlink(join(outsideDirectory, "outside.prefab"), join(directory, "linked.prefab"));

		await expect(
			mergeProjectSceneAssets(
				scene,
				{ basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "merged.prefab", write: true, expectedOursHash: "0".repeat(64) },
				options
			)
		).rejects.toThrow("Ours asset changed");
		await expect(
			mergeProjectSceneAssets(
				scene,
				{ basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "../merged.prefab", write: true, resolution: "ours" },
				options
			)
		).rejects.toThrow("stay inside");
		await expect(
			mergeProjectSceneAssets(
				scene,
				{ basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "existing.prefab", write: true, resolution: "ours" },
				options
			)
		).rejects.toThrow("already exists");
		await expect(mergeProjectSceneAssets(scene, { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "Valid.scene" }, options)).rejects.toThrow("same kind");
		await expect(mergeProjectSceneAssets(scene, { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "linked.prefab" }, options)).rejects.toThrow("resolve inside");
	});

	test("serializes concurrent writes so an existing output is never replaced", async () => {
		await writeJSON(join(directory, "base.prefab"), { value: 0 });
		await writeJSON(join(directory, "ours.prefab"), { value: 1 });
		await writeJSON(join(directory, "theirs.prefab"), { value: 0 });
		const input = { basePath: "base.prefab", oursPath: "ours.prefab", theirsPath: "theirs.prefab", outputPath: "merged.prefab", write: true };

		const results = await Promise.allSettled([mergeProjectSceneAssets(scene, input, options), mergeProjectSceneAssets(scene, input, options)]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("already exists");
		expect(await readJSON(join(directory, "merged.prefab"))).toEqual({ value: 1 });
	});
});

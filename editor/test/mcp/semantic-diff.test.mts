import { symlink } from "fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { compareProjectSceneAssets } from "../../src/mcp/project/semantic-diff";

describe("mcp/project/semantic-diff", () => {
	let directory: string;
	let outsideDirectory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-semantic-diff-"));
		outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-semantic-diff-outside-"));
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

	test("matches identified prefab arrays independent of order and reports bounded semantic property changes", async () => {
		await writeJSON(join(directory, "base.prefab"), {
			meshes: [
				{ id: "hero", position: [0, 1, 2], visibility: 1, metadata: { role: "player" } },
				{ id: "tree", position: [10, 0, 0] },
			],
		});
		await writeJSON(join(directory, "working.prefab"), {
			meshes: [
				{ id: "tree", position: [10, 0, 0] },
				{ id: "hero", position: [0.005, 1, 2], metadata: { role: "enemy" } },
				{ id: "rock", position: [4, 0, 3] },
			],
		});

		const result = await compareProjectSceneAssets(scene, { sourcePath: "base.prefab", targetPath: "working.prefab", numericTolerance: 0.01, maximumChanges: 20 }, options);
		expect(result).toMatchObject({
			kind: "prefab",
			equal: false,
			summary: { totalChanges: 3, returnedChanges: 3, truncated: false, filesChanged: 1, counts: { added: 1, removed: 1, changed: 1, typeChanged: 0 } },
		});
		expect(result.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "/meshes/@id=hero/metadata/role", kind: "changed", identity: "id=hero" }),
				expect.objectContaining({ path: "/meshes/@id=hero/visibility", kind: "removed", identity: "id=hero" }),
				expect.objectContaining({ path: "/meshes/@id=rock", kind: "added", identity: "id=rock" }),
			])
		);
		expect(result.source.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.target.hash).toMatch(/^[a-f0-9]{64}$/);

		const ignored = await compareProjectSceneAssets(
			scene,
			{ sourcePath: "base.prefab", targetPath: "working.prefab", numericTolerance: 0.01, ignorePaths: ["/meshes/@id=hero/metadata"] },
			options
		);
		expect(ignored.summary.totalChanges).toBe(2);
	});

	test("compares complete scene directory manifests including added, removed, and changed JSON files", async () => {
		const source = join(directory, "Source.scene");
		const target = join(directory, "Target.scene");
		await Promise.all([ensureDir(join(source, "meshes")), ensureDir(join(source, "lights")), ensureDir(join(target, "meshes")), ensureDir(join(target, "cameras"))]);
		await writeJSON(join(source, "config.json"), { clearColor: [0, 0, 0, 1], gravity: -9.81 });
		await writeJSON(join(target, "config.json"), { clearColor: [0, 0, 0, 1], gravity: -4.9 });
		await writeJSON(join(source, "meshes", "hero.json"), { meshes: [{ id: "hero", position: [0, 0, 0] }] });
		await writeJSON(join(target, "meshes", "hero.json"), { meshes: [{ id: "hero", position: [2, 0, 0] }] });
		await writeJSON(join(source, "lights", "sun.json"), { id: "sun" });
		await writeJSON(join(target, "cameras", "main.json"), { id: "main" });
		await writeFile(join(source, "geometries.bin"), "ignored binary", "utf-8");

		const result = await compareProjectSceneAssets(scene, { sourcePath: "Source.scene", targetPath: "Target.scene", maximumChanges: 3 }, options);
		expect(result).toMatchObject({
			kind: "scene",
			source: { fileCount: 3 },
			target: { fileCount: 3 },
			summary: { totalChanges: 4, returnedChanges: 3, truncated: true, filesChanged: 4, counts: { added: 1, removed: 1, changed: 2, typeChanged: 0 } },
		});
		expect(result.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: "cameras/main.json", path: "/", kind: "added" }),
				expect.objectContaining({ file: "config.json", path: "/gravity", kind: "changed" }),
			])
		);
	});

	test("rejects mixed kinds, malformed JSON, traversal, missing assets, and symlink escapes", async () => {
		await ensureDir(join(directory, "Broken.scene"));
		await writeFile(join(directory, "Broken.scene", "config.json"), "{ broken", "utf-8");
		await writeJSON(join(directory, "valid.prefab"), { meshes: [] });
		await ensureDir(join(directory, "Valid.scene"));
		await writeJSON(join(directory, "Valid.scene", "config.json"), {});
		await writeJSON(join(outsideDirectory, "outside.prefab"), {});
		await symlink(join(outsideDirectory, "outside.prefab"), join(directory, "linked.prefab"));

		await expect(compareProjectSceneAssets(scene, { sourcePath: "Broken.scene", targetPath: "Valid.scene" }, options)).rejects.toThrow("Invalid JSON");
		await expect(compareProjectSceneAssets(scene, { sourcePath: "valid.prefab", targetPath: "Valid.scene" }, options)).rejects.toThrow("same kind");
		await expect(compareProjectSceneAssets(scene, { sourcePath: "../outside.prefab", targetPath: "valid.prefab" }, options)).rejects.toThrow("stay inside");
		await expect(compareProjectSceneAssets(scene, { sourcePath: "missing.prefab", targetPath: "valid.prefab" }, options)).rejects.toThrow("not found");
		await expect(compareProjectSceneAssets(scene, { sourcePath: "linked.prefab", targetPath: "valid.prefab" }, options)).rejects.toThrow("resolve inside");
		await expect(compareProjectSceneAssets(scene, { sourcePath: "valid.prefab", targetPath: "valid.prefab", maximumChanges: 0 }, options)).rejects.toThrow("maximumChanges");
	});
});

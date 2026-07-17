import { createHash, randomUUID } from "crypto";
import { symlink } from "fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { acquireProjectAssetLock, listProjectAssetLocks, refreshProjectAssetLock, releaseProjectAssetLock } from "../../src/mcp/project/asset-locks";

describe("mcp/project/asset-locks", () => {
	let directory: string;
	let outsideDirectory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-asset-locks-"));
		outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-asset-locks-outside-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await ensureDir(join(directory, "assets"));
		await writeFile(options.editor.state.projectPath, "{}", "utf-8");
		await writeFile(join(directory, "assets", "hero.glb"), "mesh", "utf-8");
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

	test("atomically grants one owner, reports conflicts, renews, and releases by lease identity", async () => {
		const attempts = await Promise.all([
			acquireProjectAssetLock(scene, { path: "assets/hero.glb", owner: "Alice", ttlSeconds: 60 }, options),
			acquireProjectAssetLock(scene, { path: "assets/hero.glb", owner: "Bob", ttlSeconds: 60 }, options),
		]);
		expect(attempts.filter((result) => result.acquired)).toHaveLength(1);
		expect(attempts.filter((result) => !result.acquired)).toHaveLength(1);
		const winner = attempts.find((result) => result.acquired)!;
		const loser = attempts.find((result) => !result.acquired)!;
		expect(loser.conflict.owner).toBe(winner.lock.owner);

		await expect(acquireProjectAssetLock(scene, { path: "./assets/hero.glb", owner: winner.lock.owner, note: "Editing rig", ttlSeconds: 120 }, options)).resolves.toMatchObject(
			{
				acquired: true,
				reused: true,
				lock: { lockId: winner.lock.lockId, note: "Editing rig" },
			}
		);
		const listed = await listProjectAssetLocks(scene, {}, options);
		expect(listed).toMatchObject({ activeCount: 1, invalidEntryCount: 0, locks: [{ path: "assets/hero.glb", owner: winner.lock.owner, expired: false }] });

		await expect(refreshProjectAssetLock(scene, { path: "assets/hero.glb", lockId: randomUUID(), ttlSeconds: 120 }, options)).rejects.toThrow("ownership changed");
		const refreshed = await refreshProjectAssetLock(scene, { path: "assets/hero.glb", lockId: winner.lock.lockId, ttlSeconds: 120 }, options);
		expect(refreshed).toMatchObject({ refreshed: true, lock: { lockId: winner.lock.lockId } });
		await expect(releaseProjectAssetLock(scene, { path: "assets/hero.glb", lockId: winner.lock.lockId }, options)).resolves.toMatchObject({ released: true, forced: false });
		await expect(releaseProjectAssetLock(scene, { path: "assets/hero.glb", lockId: winner.lock.lockId }, options)).resolves.toMatchObject({
			released: false,
			reason: "notLocked",
		});
	});

	test("replaces expired locks, supports explicit administrative release, and ignores malformed entries", async () => {
		const acquired = await acquireProjectAssetLock(scene, { path: "assets/hero.glb", owner: "Expired Owner", ttlSeconds: 60 }, options);
		const storage = join(directory, ".babylon-editor", "asset-locks");
		const file = join(storage, `${createHash("sha256").update("assets/hero.glb").digest("hex")}.lock.json`);
		await writeJSON(file, { ...acquired.lock, expiresAt: new Date(0).toISOString() });
		await writeFile(join(storage, "invalid.lock.json"), "not-json", "utf-8");

		const replacement = await acquireProjectAssetLock(scene, { path: "assets/hero.glb", owner: "New Owner", ttlSeconds: 60 }, options);
		expect(replacement).toMatchObject({ acquired: true, reused: false, replacedExpired: true, lock: { owner: "New Owner" } });
		expect((await listProjectAssetLocks(scene, {}, options)).invalidEntryCount).toBe(1);
		await expect(releaseProjectAssetLock(scene, { path: "assets/hero.glb", force: true }, options)).resolves.toMatchObject({ released: true, forced: true });
	});

	test("rejects missing files, directories, traversal, lock-store targets, and invalid lease settings", async () => {
		await expect(acquireProjectAssetLock(scene, { path: "../outside.glb", owner: "Alice" }, options)).rejects.toThrow("stay inside");
		await expect(acquireProjectAssetLock(scene, { path: "assets", owner: "Alice" }, options)).rejects.toThrow("not a directory");
		await expect(acquireProjectAssetLock(scene, { path: "assets/missing.glb", owner: "Alice" }, options)).rejects.toThrow("missing project file");
		await expect(acquireProjectAssetLock(scene, { path: "assets/linked-secret.glb", owner: "Alice" }, options)).rejects.toThrow("resolve inside");
		await expect(acquireProjectAssetLock(scene, { path: ".babylon-editor/asset-locks/fake", owner: "Alice" }, options)).rejects.toThrow("cannot target");
		await expect(acquireProjectAssetLock(scene, { path: "assets/hero.glb", owner: "", ttlSeconds: 1 }, options)).rejects.toThrow("owner");
		await expect(acquireProjectAssetLock(scene, { path: "assets/hero.glb", owner: "Alice", ttlSeconds: 1 }, options)).rejects.toThrow("ttlSeconds");
	});
});

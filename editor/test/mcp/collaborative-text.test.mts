import { mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";
import { afterEach, describe, expect, it } from "vitest";

import { applyCollaborativeTextOperations, getCollaborativeTextDocument, rebaseCollaborativeTextDocument } from "../../src/mcp/project/collaborative-text";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; scene: Scene; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-collaborative-text-"));
	roots.push(root);
	await writeFile(join(root, "script.ts"), "AB", "utf-8");
	const scene = new Scene(new NullEngine());
	return { root, scene, options: { editor: { state: { projectPath: join(root, "project.bjseditor") } } } };
}

describe("collaborative text documents", () => {
	it("deterministically merges concurrent inserts at one stable anchor", async () => {
		const { scene, options } = await fixture();
		const initial = await getCollaborativeTextDocument(scene, { path: "script.ts", limit: 100 }, options);
		const anchor = initial.items[0].id;
		const results = await Promise.all([
			applyCollaborativeTextOperations(
				scene,
				{ path: "script.ts", actorId: "actor-a", operationId: "insert-a", operations: [{ type: "insert", afterId: anchor, text: "X" }] },
				options
			),
			applyCollaborativeTextOperations(
				scene,
				{ path: "script.ts", actorId: "actor-b", operationId: "insert-b", operations: [{ type: "insert", afterId: anchor, text: "Y" }] },
				options
			),
		]);
		expect(results.every((result) => result.status === "applied")).toBe(true);
		const merged = await getCollaborativeTextDocument(scene, { path: "script.ts", limit: 100 }, options);
		expect(merged.text).toBe("AXYB");
		expect(merged).toMatchObject({ revision: 2, diverged: false, totalCharacters: 4, tombstoneCount: 0 });
	});

	it("tombstones deletes and safely replays operation ids", async () => {
		const { scene, options } = await fixture();
		const initial = await getCollaborativeTextDocument(scene, { path: "script.ts" }, options);
		const request = { path: "script.ts", actorId: "editor", operationId: "delete-b", operations: [{ type: "delete", ids: [initial.items[1].id] }] };
		const first = await applyCollaborativeTextOperations(scene, request, options);
		const replay = await applyCollaborativeTextOperations(scene, request, options);
		expect(first).toMatchObject({ status: "applied", revision: 1, deleted: 1, replayed: false });
		expect(replay).toMatchObject({ status: "applied", revision: 1, deleted: 1, replayed: true });
		expect(await getCollaborativeTextDocument(scene, { path: "script.ts" }, options)).toMatchObject({ text: "A", tombstoneCount: 1 });
		await expect(applyCollaborativeTextOperations(scene, { ...request, operations: [{ type: "insert", afterId: initial.items[0].id, text: "C" }] }, options)).rejects.toThrow(
			"different text operations"
		);
	});

	it("detects external edits and requires a hash-guarded rebase", async () => {
		const { root, scene, options } = await fixture();
		const initial = await getCollaborativeTextDocument(scene, { path: "script.ts" }, options);
		await writeFile(join(root, "script.ts"), "external", "utf-8");
		const conflict = await applyCollaborativeTextOperations(
			scene,
			{ path: "script.ts", actorId: "editor", operationId: "stale-insert", operations: [{ type: "insert", afterId: initial.items[0].id, text: "!" }] },
			options
		);
		expect(conflict).toMatchObject({ status: "externalConflict", revision: 0 });
		await expect(rebaseCollaborativeTextDocument(scene, { path: "script.ts", expectedSourceHash: initial.sourceHash }, options)).rejects.toThrow("does not match");
		const current = await getCollaborativeTextDocument(scene, { path: "script.ts" }, options);
		const rebased = await rebaseCollaborativeTextDocument(scene, { path: "script.ts", expectedSourceHash: current.actualSourceHash }, options);
		expect(rebased).toMatchObject({ rebased: true, revision: 1, totalCharacters: 8 });
		expect(await getCollaborativeTextDocument(scene, { path: "script.ts" }, options)).toMatchObject({ text: "external", diverged: false });
	});

	it("paginates stable visible item ids", async () => {
		const { scene, options } = await fixture();
		const first = await getCollaborativeTextDocument(scene, { path: "script.ts", offset: 0, limit: 1 }, options);
		const second = await getCollaborativeTextDocument(scene, { path: "script.ts", offset: 1, limit: 1 }, options);
		expect(first).toMatchObject({ text: "A", count: 1, hasMore: true, totalCharacters: 2 });
		expect(second).toMatchObject({ text: "B", count: 1, hasMore: false, totalCharacters: 2 });
		expect(first.items[0].id).not.toBe(second.items[0].id);
	});

	it("rejects traversal, metadata, unsupported extensions, and symlink escapes", async () => {
		const { root, scene, options } = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "babylon-collaborative-text-outside-"));
		roots.push(outside);
		await writeFile(join(outside, "secret.ts"), "secret", "utf-8");
		await symlink(join(outside, "secret.ts"), join(root, "linked.ts"));
		await writeFile(join(root, "binary.exe"), "text", "utf-8");
		await expect(getCollaborativeTextDocument(scene, { path: "../secret.ts" }, options)).rejects.toThrow("stay inside");
		await expect(getCollaborativeTextDocument(scene, { path: ".babylon-editor/data.txt" }, options)).rejects.toThrow("metadata");
		await expect(getCollaborativeTextDocument(scene, { path: "binary.exe" }, options)).rejects.toThrow("Unsupported");
		await expect(getCollaborativeTextDocument(scene, { path: "linked.ts" }, options)).rejects.toThrow("inside the project");
	});
});

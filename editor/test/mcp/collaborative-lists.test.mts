import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";
import { afterEach, describe, expect, it } from "vitest";

import { applyCollaborativeOrderedCollectionOperations, getCollaborativeOrderedCollection, rebaseCollaborativeOrderedCollection } from "../../src/mcp/project/collaborative-lists";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ scene: Scene; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-collaborative-lists-"));
	roots.push(root);
	const scene = new Scene(new NullEngine());
	scene.metadata = { babylonEditorCollaborativeCollections: { Sequence: ["A", "B"] } };
	return { scene, options: { editor: { state: { projectPath: join(root, "project.bjseditor") } } } };
}

describe("collaborative ordered scene collections", () => {
	it("deterministically merges simultaneous inserts at one anchor", async () => {
		const { scene, options } = await fixture();
		const initial = await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		const anchor = initial.items[0].id;
		await Promise.all([
			applyCollaborativeOrderedCollectionOperations(
				scene,
				{ name: "Sequence", actorId: "actor-a", operationId: "insert-a", operations: [{ type: "insert", afterId: anchor, value: "X" }] },
				options
			),
			applyCollaborativeOrderedCollectionOperations(
				scene,
				{ name: "Sequence", actorId: "actor-b", operationId: "insert-b", operations: [{ type: "insert", afterId: anchor, value: "Y" }] },
				options
			),
		]);
		const merged = await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		expect(merged.items.map((item: any) => item.value)).toEqual(["A", "X", "Y", "B"]);
		expect(merged).toMatchObject({ revision: 2, diverged: false, total: 4, tombstones: 0 });
	});

	it("updates, moves, tombstones, and safely replays operation ids", async () => {
		const { scene, options } = await fixture();
		const initial = await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		const [a, b] = initial.items;
		const insert = await applyCollaborativeOrderedCollectionOperations(
			scene,
			{ name: "Sequence", actorId: "editor", operationId: "insert-x", operations: [{ type: "insert", afterId: a.id, value: { label: "X" } }] },
			options
		);
		expect(insert.inserted).toBe(1);
		const withX = await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		const x = withX.items.find((item: any) => item.value?.label === "X");
		const request = {
			name: "Sequence",
			actorId: "editor",
			operationId: "edit-list",
			operations: [
				{ type: "update", id: x.id, value: { label: "X2" } },
				{ type: "move", id: b.id, afterId: x.id },
				{ type: "delete", id: a.id },
			],
		};
		const applied = await applyCollaborativeOrderedCollectionOperations(scene, request, options);
		const replay = await applyCollaborativeOrderedCollectionOperations(scene, request, options);
		expect(applied).toMatchObject({ status: "applied", updated: 1, moved: 1, deleted: 1, replayed: false });
		expect(replay).toMatchObject({ revision: applied.revision, replayed: true });
		const result = await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		expect(result.items.map((item: any) => item.value)).toEqual([{ label: "X2" }, "B"]);
		expect(result.tombstones).toBe(1);
	});

	it("blocks external materialized edits until hash-guarded rebase", async () => {
		const { scene, options } = await fixture();
		await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		scene.metadata.babylonEditorCollaborativeCollections.Sequence = ["external"];
		const conflict = await applyCollaborativeOrderedCollectionOperations(
			scene,
			{ name: "Sequence", actorId: "editor", operationId: "stale", operations: [{ type: "insert", afterId: null, value: "ignored" }] },
			options
		);
		expect(conflict.status).toBe("externalConflict");
		await expect(rebaseCollaborativeOrderedCollection(scene, { name: "Sequence", expectedSourceHash: conflict.expectedSourceHash }, options)).rejects.toThrow("does not match");
		const rebased = await rebaseCollaborativeOrderedCollection(scene, { name: "Sequence", expectedSourceHash: conflict.actualSourceHash }, options);
		expect(rebased).toMatchObject({ rebased: true, total: 1 });
		expect((await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options)).items[0].value).toBe("external");
	});

	it("paginates visible stable IDs", async () => {
		const { scene, options } = await fixture();
		const first = await getCollaborativeOrderedCollection(scene, { name: "Sequence", offset: 0, limit: 1 }, options);
		const second = await getCollaborativeOrderedCollection(scene, { name: "Sequence", offset: 1, limit: 1 }, options);
		expect(first).toMatchObject({ count: 1, hasMore: true, total: 2 });
		expect(second).toMatchObject({ count: 1, hasMore: false, total: 2 });
		expect(first.items[0].id).not.toBe(second.items[0].id);
	});

	it("rejects unsafe names, missing anchors, cycles, and non-JSON values", async () => {
		const { scene, options } = await fixture();
		const initial = await getCollaborativeOrderedCollection(scene, { name: "Sequence" }, options);
		await expect(getCollaborativeOrderedCollection(scene, { name: "../bad" }, options)).rejects.toThrow("safe identifier");
		await expect(getCollaborativeOrderedCollection(scene, { name: "constructor" }, options)).rejects.toThrow("prototype identifier");
		await expect(
			applyCollaborativeOrderedCollectionOperations(
				scene,
				{ name: "Sequence", actorId: "editor", operationId: "missing", operations: [{ type: "insert", afterId: "missing", value: 1 }] },
				options
			)
		).rejects.toThrow("anchor not found");
		await expect(
			applyCollaborativeOrderedCollectionOperations(
				scene,
				{ name: "Sequence", actorId: "editor", operationId: "cycle", operations: [{ type: "move", id: initial.items[0].id, afterId: initial.items[1].id }] },
				options
			)
		).rejects.toThrow("cycle");
		await expect(
			applyCollaborativeOrderedCollectionOperations(
				scene,
				{ name: "Sequence", actorId: "editor", operationId: "function", operations: [{ type: "insert", afterId: null, value: () => 1 }] },
				options
			)
		).rejects.toThrow("safe JSON");
	});
});

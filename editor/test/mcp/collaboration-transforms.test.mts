import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCollaborativeNodeTransform, getCollaborationNodeRevision } from "../../src/mcp/project/collaboration-transforms";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ scene: Scene; node: TransformNode; options: any; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-collaboration-transform-"));
	roots.push(root);
	const scene = new Scene(new NullEngine());
	const node = new TransformNode("Shared Node", scene);
	node.id = "shared-node";
	const options = {
		editor: {
			state: { projectPath: join(root, "project.bjseditor") },
			layout: {
				graph: { setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	};
	return { scene, node, options, root };
}

describe("collaboration transform revisions", () => {
	it("allows exactly one simultaneous writer for a revision", async () => {
		const { scene, node, options } = await fixture();
		const initial = await getCollaborationNodeRevision(scene, { nodeId: node.id }, options);

		const results = await Promise.all([
			applyCollaborativeNodeTransform(scene, { nodeId: node.id, expectedRevision: initial.revision, operationId: "writer-a", position: [10, 0, 0] }, options),
			applyCollaborativeNodeTransform(scene, { nodeId: node.id, expectedRevision: initial.revision, operationId: "writer-b", position: [20, 0, 0] }, options),
		]);

		expect(results.map((result) => result.status).sort()).toEqual(["applied", "conflict"]);
		expect(node.position.x).toBe(results.find((result) => result.status === "applied").current.transform.position[0]);
		expect(results.find((result) => result.status === "conflict").current.revision).toBe(1);
	});

	it("replays an operation id without applying it again and rejects changed arguments", async () => {
		const { scene, node, options } = await fixture();
		const request = { nodeId: node.id, expectedRevision: 0, operationId: "safe-retry", position: [5, 6, 7] };
		const first = await applyCollaborativeNodeTransform(scene, request, options);
		const replay = await applyCollaborativeNodeTransform(scene, request, options);

		expect(first).toMatchObject({ status: "applied", replayed: false, previousRevision: 0 });
		expect(replay).toMatchObject({ status: "applied", replayed: true, previousRevision: 0 });
		expect((await getCollaborationNodeRevision(scene, { nodeId: node.id }, options)).revision).toBe(1);
		await expect(applyCollaborativeNodeTransform(scene, { ...request, position: [8, 9, 10] }, options)).rejects.toThrow("different arguments");
	});

	it("detects a transform changed outside the guarded endpoint", async () => {
		const { scene, node, options, root } = await fixture();
		await applyCollaborativeNodeTransform(scene, { nodeId: node.id, expectedRevision: 0, operationId: "first", scaling: [2, 2, 2] }, options);
		node.position.x = 99;

		const current = await getCollaborationNodeRevision(scene, { nodeId: node.id }, options);
		expect(current.revision).toBe(2);
		const conflict = await applyCollaborativeNodeTransform(scene, { nodeId: node.id, expectedRevision: 1, operationId: "stale", position: [1, 1, 1] }, options);
		expect(conflict).toMatchObject({ status: "conflict", current: { revision: 2, transform: { position: [99, 0, 0] } } });
		expect(node.position.x).toBe(99);

		const persisted = JSON.parse(await readFile(join(root, ".babylon-editor", "collaboration-revisions.json"), "utf-8"));
		expect(persisted.nodes[node.id].revision).toBe(2);
	});
});

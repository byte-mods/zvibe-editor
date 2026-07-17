import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { MeshBuilder, NullEngine, Scene, StandardMaterial } from "babylonjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCollaborativeNodeEdit, getCollaborationNodeEditRevision } from "../../src/mcp/project/collaboration-node-edits";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ scene: Scene; mesh: any; material: StandardMaterial; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-collaboration-node-edit-"));
	roots.push(root);
	const scene = new Scene(new NullEngine());
	const mesh = MeshBuilder.CreateBox("Shared Mesh", {}, scene);
	mesh.id = "shared-mesh";
	const material = new StandardMaterial("Guarded Material", scene);
	material.id = "guarded-material";
	const options = {
		editor: {
			state: { projectPath: join(root, "project.bjseditor") },
			layout: {
				graph: { setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	};
	return { scene, mesh, material, options };
}

describe("collaboration non-transform node edits", () => {
	it("allows exactly one simultaneous writer for a node-state revision", async () => {
		const { scene, mesh, options } = await fixture();
		const initial = await getCollaborationNodeEditRevision(scene, { nodeId: mesh.id }, options);
		const results = await Promise.all([
			applyCollaborativeNodeEdit(scene, { nodeId: mesh.id, expectedRevision: initial.revision, operationId: "state-writer-a", visible: false }, options),
			applyCollaborativeNodeEdit(scene, { nodeId: mesh.id, expectedRevision: initial.revision, operationId: "state-writer-b", checkCollisions: true }, options),
		]);

		expect(results.map((result) => result.status).sort()).toEqual(["applied", "conflict"]);
		expect(results.find((result) => result.status === "conflict").current.revision).toBe(1);
		const current = await getCollaborationNodeEditRevision(scene, { nodeId: mesh.id }, options);
		expect(current.revision).toBe(1);
		expect(current.state).toEqual(results.find((result) => result.status === "applied").current.state);
	});

	it("applies a multi-field edit atomically and safely replays its operation id", async () => {
		const { scene, mesh, material, options } = await fixture();
		const request = {
			nodeId: mesh.id,
			expectedRevision: 0,
			operationId: "node-edit-retry",
			materialId: material.id,
			layer: "Gameplay",
			tags: ["Enemy", "Target"],
			isPickable: false,
			receiveShadows: true,
		};
		const first = await applyCollaborativeNodeEdit(scene, request, options);
		const replay = await applyCollaborativeNodeEdit(scene, request, options);

		expect(first).toMatchObject({ status: "applied", replayed: false, current: { revision: 1 } });
		expect(replay).toMatchObject({ status: "applied", replayed: true, current: { revision: 1 } });
		expect(mesh.material).toBe(material);
		expect(mesh.metadata).toMatchObject({ babylonEditorLayer: "Gameplay", babylonEditorTags: ["Enemy", "Target"] });
		expect(mesh.isPickable).toBe(false);
		await expect(applyCollaborativeNodeEdit(scene, { ...request, enabled: false }, options)).rejects.toThrow("different arguments");
	});

	it("detects covered out-of-band changes but ignores unrelated transforms", async () => {
		const { scene, mesh, options } = await fixture();
		await applyCollaborativeNodeEdit(scene, { nodeId: mesh.id, expectedRevision: 0, operationId: "initial-edit", checkCollisions: true }, options);
		mesh.position.x = 100;
		expect((await getCollaborationNodeEditRevision(scene, { nodeId: mesh.id }, options)).revision).toBe(1);
		mesh.isVisible = false;
		const external = await getCollaborationNodeEditRevision(scene, { nodeId: mesh.id }, options);
		expect(external.revision).toBe(2);

		const conflict = await applyCollaborativeNodeEdit(scene, { nodeId: mesh.id, expectedRevision: 1, operationId: "stale-edit", enabled: false }, options);
		expect(conflict).toMatchObject({ status: "conflict", current: { revision: 2, state: { visible: false, enabled: true } } });
		expect(mesh.isEnabled(false)).toBe(true);
	});

	it("validates every field before changing any live state", async () => {
		const { scene, mesh, options } = await fixture();
		await expect(
			applyCollaborativeNodeEdit(scene, { nodeId: mesh.id, expectedRevision: 0, operationId: "invalid-material", visible: false, materialId: "missing-material" }, options)
		).rejects.toThrow("Material not found");
		expect(mesh.isVisible).toBe(true);
		expect((await getCollaborationNodeEditRevision(scene, { nodeId: mesh.id }, options)).revision).toBe(0);
	});
});

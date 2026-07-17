import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { MeshBuilder, NullEngine, PointLight, Scene, TransformNode, Vector3 } from "babylonjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	applyCollaborativeHierarchyEdit,
	applyCollaborativeNodeProperties,
	getCollaborationHierarchyRevision,
	getCollaborationNodePropertyRevision,
} from "../../src/mcp/project/collaboration-structure";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ scene: Scene; node: TransformNode; parentA: TransformNode; parentB: TransformNode; light: PointLight; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "babylon-collaboration-structure-"));
	roots.push(root);
	const scene = new Scene(new NullEngine());
	const parentA = new TransformNode("Parent A", scene);
	parentA.id = "parent-a";
	const parentB = new TransformNode("Parent B", scene);
	parentB.id = "parent-b";
	const node = new TransformNode("Shared Child", scene);
	node.id = "shared-child";
	const light = new PointLight("Shared Light", Vector3.Zero(), scene);
	light.id = "shared-light";
	const options = {
		editor: {
			state: { projectPath: join(root, "project.bjseditor") },
			layout: {
				graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	};
	return { scene, node, parentA, parentB, light, options };
}

describe("collaboration hierarchy and property revisions", () => {
	it("allows exactly one simultaneous hierarchy writer and returns the winning parent", async () => {
		const { scene, node, parentA, parentB, options } = await fixture();
		const initial = await getCollaborationHierarchyRevision(scene, { nodeId: node.id }, options);
		const results = await Promise.all([
			applyCollaborativeHierarchyEdit(scene, { nodeId: node.id, parentId: parentA.id, expectedRevision: initial.revision, operationId: "hierarchy-a" }, options),
			applyCollaborativeHierarchyEdit(scene, { nodeId: node.id, parentId: parentB.id, expectedRevision: initial.revision, operationId: "hierarchy-b" }, options),
		]);

		expect(results.map((result) => result.status).sort()).toEqual(["applied", "conflict"]);
		expect(node.parent?.id).toBe(results.find((result) => result.status === "applied").current.hierarchy.parentId);
		expect(results.find((result) => result.status === "conflict").current.revision).toBe(1);
	});

	it("detects external hierarchy changes and rejects cycles before mutation", async () => {
		const { scene, node, parentA, parentB, options } = await fixture();
		await applyCollaborativeHierarchyEdit(scene, { nodeId: node.id, parentId: parentA.id, expectedRevision: 0, operationId: "hierarchy-first" }, options);
		node.parent = parentB;
		expect((await getCollaborationHierarchyRevision(scene, { nodeId: node.id }, options)).revision).toBe(2);
		parentA.parent = node;
		await expect(
			applyCollaborativeHierarchyEdit(scene, { nodeId: node.id, parentId: parentA.id, expectedRevision: 2, operationId: "hierarchy-cycle" }, options)
		).rejects.toThrow("descendants");
		expect(node.parent).toBe(parentB);
	});

	it("applies and safely replays a multi-property edit with typed color coercion", async () => {
		const { scene, light, options } = await fixture();
		const initial = await getCollaborationNodePropertyRevision(scene, { nodeId: light.id, paths: ["range", "intensity", "diffuse"] }, options);
		const request = {
			nodeId: light.id,
			expectedRevision: initial.revision,
			operationId: "property-retry",
			properties: { intensity: 3, range: 500, diffuse: [0.2, 0.4, 0.6] },
		};
		const first = await applyCollaborativeNodeProperties(scene, request, options);
		const replay = await applyCollaborativeNodeProperties(scene, request, options);
		expect(first).toMatchObject({ status: "applied", current: { revision: 1, values: { intensity: 3, range: 500, diffuse: [0.2, 0.4, 0.6] } } });
		expect(replay).toMatchObject({ status: "applied", replayed: true, current: { revision: 1 } });
		expect(light.diffuse.asArray()).toEqual([0.2, 0.4, 0.6]);
		await expect(applyCollaborativeNodeProperties(scene, { ...request, properties: { intensity: 4, range: 500, diffuse: [0.2, 0.4, 0.6] } }, options)).rejects.toThrow(
			"different arguments"
		);
	});

	it("isolates exact property path sets and detects covered external changes", async () => {
		const { scene, light, options } = await fixture();
		const intensity = await getCollaborationNodePropertyRevision(scene, { nodeId: light.id, paths: ["intensity"] }, options);
		const range = await getCollaborationNodePropertyRevision(scene, { nodeId: light.id, paths: ["range"] }, options);
		await applyCollaborativeNodeProperties(
			scene,
			{ nodeId: light.id, expectedRevision: intensity.revision, operationId: "intensity-only", properties: { intensity: 2 } },
			options
		);
		expect((await getCollaborationNodePropertyRevision(scene, { nodeId: light.id, paths: ["range"] }, options)).revision).toBe(range.revision);
		light.range = 123;
		expect((await getCollaborationNodePropertyRevision(scene, { nodeId: light.id, paths: ["range"] }, options)).revision).toBe(0);
		await applyCollaborativeNodeProperties(scene, { nodeId: light.id, expectedRevision: 0, operationId: "range-base", properties: { range: 124 } }, options);
		light.range = 125;
		expect((await getCollaborationNodePropertyRevision(scene, { nodeId: light.id, paths: ["range"] }, options)).revision).toBe(2);
	});

	it("rejects unsafe paths and rolls back earlier fields when a later setter fails", async () => {
		const { scene, options } = await fixture();
		const mesh: any = MeshBuilder.CreateBox("Setter Mesh", {}, scene);
		mesh.id = "setter-mesh";
		let safeA = 1;
		let safeB = 2;
		Object.defineProperty(mesh, "safeA", { configurable: true, get: () => safeA, set: (value) => (safeA = value) });
		Object.defineProperty(mesh, "safeB", {
			configurable: true,
			get: () => safeB,
			set: (value) => {
				if (value === 99) throw new Error("setter rejected value");
				safeB = value;
			},
		});
		await expect(getCollaborationNodePropertyRevision(scene, { nodeId: mesh.id, paths: ["__proto__.polluted"] }, options)).rejects.toThrow("Unsafe property path");
		await expect(getCollaborationNodePropertyRevision(scene, { nodeId: mesh.id, paths: ["position.x"] }, options)).rejects.toThrow("dedicated");
		await expect(
			applyCollaborativeNodeProperties(scene, { nodeId: mesh.id, expectedRevision: 0, operationId: "setter-failure", properties: { safeA: 10, safeB: 99 } }, options)
		).rejects.toThrow("setter rejected value");
		expect({ safeA, safeB }).toEqual({ safeA: 1, safeB: 2 });
	});
});

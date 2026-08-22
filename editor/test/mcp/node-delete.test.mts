import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, RawTexture, Scene, StandardMaterial, TransformNode } from "babylonjs";

import { deleteNode } from "../../src/mcp/nodes/nodes";

describe("MCP node deletion resource ownership", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				graph: { refresh: vi.fn(), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn() },
				preview: { gizmo: { setAttachedObject: vi.fn() } },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	function createOwnedHierarchy(name: string): { root: TransformNode; material: StandardMaterial; texture: RawTexture } {
		const root = new TransformNode(`${name} Root`, scene);
		const mesh = MeshBuilder.CreateBox(`${name} Mesh`, {}, scene);
		mesh.parent = root;
		const material = new StandardMaterial(`${name} Material`, scene);
		const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 64, 32, 255]), 1, 1, scene);
		material.diffuseTexture = texture;
		mesh.material = material;
		return { root, material, texture };
	}

	test("preserves shared materials and textures by default", () => {
		const { root, material, texture } = createOwnedHierarchy("Shared");

		expect(deleteNode(scene, { nodeId: root.id }, options)).toEqual({ deleted: true, disposedMaterialAndTextures: false });
		expect(scene.materials).toContain(material);
		expect(scene.textures).toContain(texture);
	});

	test("disposes explicitly owned materials and textures with a recursive hierarchy", () => {
		const { root, material, texture } = createOwnedHierarchy("Owned");

		expect(deleteNode(scene, { nodeId: root.id, disposeMaterialAndTextures: true }, options)).toEqual({ deleted: true, disposedMaterialAndTextures: true });
		expect(scene.materials).not.toContain(material);
		expect(scene.textures).not.toContain(texture);
	});
});

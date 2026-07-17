import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, SceneSerializer, TransformNode } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { createVfxTrail, deleteVfxTrail, getVfxTrail, listVfxTrails, setVfxTrail } from "../../src/mcp/vfx/trails";

describe("mcp/vfx-trails", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: { layout: { graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() }, inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, serializes, lists, rebuilds, and deletes a persistent configured trail", async () => {
		const generator = new TransformNode("Trail Emitter", scene);
		const created = createVfxTrail(
			scene,
			{ name: "Sword Trail", generatorNodeId: generator.id, diameter: 4, length: 20, segments: 10, sections: 3, doNotTaper: true },
			options
		);
		expect(created).toMatchObject({ diameter: 4, length: 20, segments: 10, sections: 3, doNotTaper: true, generatorId: generator.id });
		const serialized = await SceneSerializer.SerializeMesh(scene.getMeshById(created.node.id)!, false, false);
		expect(serialized.meshes?.[0]).toMatchObject({ type: "TrailMesh", metadata: { babylonEditorTrail: { generatorId: generator.id, length: 20, segments: 10 } } });
		expect(listVfxTrails(scene).trails).toHaveLength(1);

		const updated = setVfxTrail(scene, { nodeId: created.node.id, diameter: 6, length: 30, playing: false }, options);
		expect(updated).toMatchObject({ node: { id: created.node.id }, diameter: 6, length: 30, generatorId: generator.id });
		expect(getVfxTrail(scene, { nodeId: created.node.id })).toMatchObject({ diameter: 6, length: 30 });
		expect(deleteVfxTrail(scene, { nodeId: created.node.id }, options)).toMatchObject({ deleted: true, id: created.node.id });
		expect(listVfxTrails(scene).trails).toHaveLength(0);
	});

	test("rejects invalid trail geometry configuration", () => {
		const generator = new TransformNode("Trail Emitter", scene);
		expect(() => createVfxTrail(scene, { generatorNodeId: generator.id, diameter: 0 }, options)).toThrow("diameter");
		expect(() => createVfxTrail(scene, { generatorNodeId: generator.id, sections: 1 }, options)).toThrow("sections");
	});
});

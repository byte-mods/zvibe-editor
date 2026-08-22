import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, HemisphericLight, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3 } from "babylonjs";

import {
	createRendererList,
	createRenderingLayer,
	deleteRendererList,
	deleteRenderingLayer,
	listRendererLists,
	listRenderingLayers,
	resetRenderingGroup,
	resolveRendererList,
	setLightRenderingLayers,
	setNodeRenderingLayers,
	setRendererList,
	setRenderingGroup,
	setRenderingLayer,
} from "../../src/mcp/rendering/renderer-lists";

describe("mcp/renderer-lists", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	let opaque: any;
	let transparent: any;
	let light: HemisphericLight;
	const options = {
		editor: {
			layout: {
				graph: { refresh: vi.fn() },
				inspector: { forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		opaque = MeshBuilder.CreateBox("Opaque", {}, scene);
		transparent = MeshBuilder.CreateBox("Transparent", {}, scene);
		const material = new StandardMaterial("Transparent Material", scene);
		material.alpha = 0.5;
		transparent.material = material;
		light = new HemisphericLight("Light", Vector3.Up(), scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("authors named layers, native node/light masks, group policy, and a leased renderer-list lifecycle", () => {
		const world = createRenderingLayer(scene, { name: "World", bit: 1 }, options).layer;
		const effects = createRenderingLayer(scene, { name: "Effects", bit: 2 }, options).layer;
		expect(setNodeRenderingLayers(scene, { nodeId: opaque.id, layerIds: [world.id], renderingGroupId: 0, alphaIndex: 2 }, options)).toMatchObject({
			mask: 2,
			renderingGroupId: 0,
			alphaIndex: 2,
		});
		expect(setNodeRenderingLayers(scene, { nodeId: transparent.id, layerIds: [effects.id], renderingGroupId: 1, alphaIndex: 9 }, options)).toMatchObject({
			mask: 4,
			renderingGroupId: 1,
			alphaIndex: 9,
		});
		expect(setNodeRenderingLayers(scene, { nodeId: camera.id, mask: 6 }, options)).toMatchObject({ nodeType: "camera", mask: 6 });
		expect(setLightRenderingLayers(scene, { nodeId: light.id, includeLayerIds: [effects.id], excludeLayerIds: [world.id] }, options)).toMatchObject({
			includeMask: 4,
			excludeMask: 2,
		});

		const group = setRenderingGroup(scene, { groupId: 1, revision: 1, name: "Transparent FX", autoClearDepthStencil: false, transparentSort: "backToFront" }, options).group;
		expect(group).toMatchObject({ groupId: 1, revision: 2, name: "Transparent FX", autoClearDepthStencil: false, transparentSort: "backToFront", authored: true });
		expect(listRenderingLayers(scene).groups.find((value: any) => value.groupId === 1)).toMatchObject({ revision: 2, authored: true });
		const created = createRendererList(
			scene,
			{
				name: "Transparent Effects",
				cameraId: camera.id,
				includeLayerMask: 4,
				renderingGroupIds: [1],
				queue: "transparent",
				sortMode: "backToFront",
			},
			options
		).rendererList;
		expect(resolveRendererList(scene, { rendererListId: created.id })).toMatchObject({
			revision: 1,
			totalMeshes: 1,
			meshes: [{ id: transparent.id, layerMask: 4, renderingGroupId: 1, alphaIndex: 9, queues: ["transparent"] }],
		});
		const updated = setRendererList(scene, { rendererListId: created.id, revision: 1, includeLayerMask: 6, renderingGroupIds: [], queue: "all" }, options).rendererList;
		expect(updated.revision).toBe(2);
		expect(resolveRendererList(scene, { rendererListId: created.id }).totalMeshes).toBe(2);
		expect(listRendererLists(scene, {})).toMatchObject({ total: 1, lists: [{ id: created.id, revision: 2, valid: true, resolvedMeshCount: 2 }] });
		expect(deleteRendererList(scene, { rendererListId: created.id, revision: 2, confirm: true }, options)).toMatchObject({ deleted: true, id: created.id });
		expect(resetRenderingGroup(scene, { groupId: 1, revision: 2, confirm: true }, options)).toMatchObject({
			reset: true,
			group: { groupId: 1, revision: 1, authored: false },
		});
		expect(listRenderingLayers(scene).groups.find((value: any) => value.groupId === 1)).toMatchObject({ revision: 1, authored: false });
		expect(scene.getAutoClearDepthStencilSetup(1)).toEqual({ autoClear: true, depth: true, stencil: true });
	});

	test("migrates and clears layer assignments atomically under exact revisions", () => {
		const layer = createRenderingLayer(scene, { name: "Characters", bit: 4 }, options).layer;
		const renamed = setRenderingLayer(scene, { layerId: layer.id, revision: 1, name: "Characters Updated" }, options).layer;
		expect(renamed).toMatchObject({ revision: 2, bit: 4, name: "Characters Updated" });
		setNodeRenderingLayers(scene, { nodeId: opaque.id, layerIds: [layer.id] }, options);
		setLightRenderingLayers(scene, { nodeId: light.id, includeLayerIds: [layer.id], excludeLayerIds: [] }, options);
		expect(() => setRenderingLayer(scene, { layerId: layer.id, revision: 2, bit: 5 }, options)).toThrow("migrateAssignments");
		const migrated = setRenderingLayer(scene, { layerId: layer.id, revision: 2, bit: 5, migrateAssignments: true }, options).layer;
		expect(migrated).toMatchObject({ revision: 3, bit: 5 });
		expect(opaque.layerMask >>> 0).toBe(32);
		expect(light.includeOnlyWithLayerMask >>> 0).toBe(32);
		expect(() => deleteRenderingLayer(scene, { layerId: layer.id, revision: 3, confirm: true }, options)).toThrow("in use");
		expect(deleteRenderingLayer(scene, { layerId: layer.id, revision: 3, clearAssignments: true, confirm: true }, options)).toMatchObject({
			deleted: true,
			clearedConsumers: 4,
		});
		expect(opaque.layerMask >>> 0).toBe(0);
		expect(light.includeOnlyWithLayerMask >>> 0).toBe(0);
	});

	test("rejects stale revisions, overlapping light masks, and referenced renderer-list deletion", () => {
		const layer = createRenderingLayer(scene, { name: "UI", bit: 6 }, options).layer;
		expect(() => setRenderingLayer(scene, { layerId: layer.id, revision: 2, name: "Stale" }, options)).toThrow("Stale revision");
		expect(() => setLightRenderingLayers(scene, { nodeId: light.id, includeMask: 64, excludeMask: 64 }, options)).toThrow("must not overlap");
		const list = createRendererList(scene, { name: "UI List", includeLayerMask: 64 }, options).rendererList;
		scene.metadata.babylonEditorCustomRenderPasses = [{ name: "UI Pass", rasterSettings: { rendererListId: list.id } }];
		expect(() => deleteRendererList(scene, { rendererListId: list.id, revision: 1, confirm: true }, options)).toThrow("referenced by raster passes");
		expect(listRenderingLayers(scene).layers).toEqual([expect.objectContaining({ id: layer.id, bit: 6 })]);
	});

	test("rolls metadata back when an assigned raster-pass runtime rebuild rejects", () => {
		const list = createRendererList(scene, { name: "Transactional List", includeLayerMask: 2 }, options).rendererList;
		const before = structuredClone(scene.metadata.babylonEditorRendererLists);
		scene.metadata.babylonEditorCustomRenderPasses = [{ name: "Invalid Assigned Pass", passType: "raster", rasterSettings: { rendererListId: list.id } }];
		expect(() => setRendererList(scene, { rendererListId: list.id, revision: 1, name: "Should Roll Back" }, options)).toThrow("rollback runtime rebuild also failed");
		expect(scene.metadata.babylonEditorRendererLists).toEqual(before);
	});
});

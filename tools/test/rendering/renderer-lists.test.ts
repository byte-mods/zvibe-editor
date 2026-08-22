import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

import {
	configureRendererLists,
	rendererListsMetadataKey,
	renderingGroupsMetadataKey,
	renderingLayersMetadataKey,
	resolveRendererList,
	setNativeRenderingLayerMask,
	validateRendererLists,
	validateRenderingLayers,
} from "../../src/rendering/renderer-lists";

describe("rendering/renderer-lists", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", new Vector3(0, 0, -10), scene);
		camera.layerMask = 0b0110;
		scene.activeCamera = camera;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("resolves camera, layer, group, queue, visibility, and descendant filters exactly", () => {
		const root = MeshBuilder.CreateBox("Root", {}, scene);
		root.layerMask = 0b0010;
		root.renderingGroupId = 0;
		const transparent = MeshBuilder.CreateBox("Transparent", {}, scene);
		transparent.parent = root;
		transparent.layerMask = 0b0100;
		transparent.renderingGroupId = 1;
		transparent.alphaIndex = 7;
		const transparentMaterial = new StandardMaterial("Transparent Material", scene);
		transparentMaterial.alpha = 0.5;
		transparent.material = transparentMaterial;
		const excluded = MeshBuilder.CreateBox("Excluded", {}, scene);
		excluded.layerMask = 0b1000;

		const definition = validateRendererLists([
			{
				version: 1,
				id: "transparent-list",
				name: "Transparent List",
				revision: 2,
				enabled: true,
				cameraId: camera.id,
				meshIds: [root.id],
				includeDescendants: true,
				includeLayerMask: 0b0110,
				excludeLayerMask: 0,
				respectCameraLayerMask: true,
				renderingGroupIds: [1],
				queue: "transparent",
				sortMode: "backToFront",
				includeDisabled: false,
				includeInvisible: false,
			},
		])[0];
		const resolved = resolveRendererList(scene, definition);
		expect(resolved.meshes).toEqual([transparent]);
		expect(resolved.runtime).toMatchObject({
			cameraId: camera.id,
			queueCounts: { opaque: 0, alphaTest: 0, transparent: 1 },
			meshes: [{ id: transparent.id, layerMask: 4, renderingGroupId: 1, alphaIndex: 7, queues: ["transparent"] }],
		});
		expect(excluded).not.toBe(root);
	});

	test("validates persisted layers/lists and applies native rendering-group policies", () => {
		scene.metadata = {
			[renderingLayersMetadataKey]: [
				{ version: 1, id: "world", name: "World", revision: 1, bit: 1 },
				{ version: 1, id: "effects", name: "Effects", revision: 1, bit: 2 },
			],
			[renderingGroupsMetadataKey]: [
				{
					version: 1,
					groupId: 1,
					name: "Effects",
					revision: 3,
					autoClearDepthStencil: false,
					clearDepth: false,
					clearStencil: true,
					opaqueSort: "frontToBack",
					alphaTestSort: "material",
					transparentSort: "backToFront",
				},
			],
			[rendererListsMetadataKey]: [],
		};
		const configured = configureRendererLists(scene);
		expect(configured).toMatchObject({ layers: [{ id: "world" }, { id: "effects" }], groups: [{ groupId: 1, revision: 3 }], lists: [] });
		expect(scene.getAutoClearDepthStencilSetup(1)).toEqual({ autoClear: false, depth: false, stencil: true });
		const mesh = MeshBuilder.CreateBox("Layered", {}, scene);
		expect(setNativeRenderingLayerMask(mesh, 0x80000000)).toBe(0x80000000);
		expect(mesh.layerMask >>> 0).toBe(0x80000000);
	});

	test("rejects unknown fields, duplicate identities/bits, stale references, and invalid masks", () => {
		expect(() => validateRenderingLayers([{ version: 1, id: "a", name: "A", revision: 1, bit: 0, surprise: true }])).toThrow("unsupported field");
		expect(() =>
			validateRenderingLayers([
				{ version: 1, id: "a", name: "A", revision: 1, bit: 2 },
				{ version: 1, id: "b", name: "B", revision: 1, bit: 2 },
			])
		).toThrow("bit values must be unique");
		const definition = validateRendererLists([
			{
				version: 1,
				id: "missing",
				name: "Missing",
				revision: 1,
				enabled: true,
				cameraId: "missing-camera",
				meshIds: [],
				includeDescendants: false,
				includeLayerMask: null,
				excludeLayerMask: 0,
				respectCameraLayerMask: true,
				renderingGroupIds: [],
				queue: "all",
				sortMode: "none",
				includeDisabled: false,
				includeInvisible: false,
			},
		])[0];
		expect(() => resolveRendererList(scene, definition)).toThrow("missing camera");
		expect(() => setNativeRenderingLayerMask(camera, 4_294_967_296)).toThrow("0 to 4294967295");
	});
});

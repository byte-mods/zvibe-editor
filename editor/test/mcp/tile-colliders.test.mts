import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, Vector2 } from "babylonjs";

vi.mock("babylonjs-editor-tools", async (importOriginal) => await importOriginal());

import { SpriteMapNode } from "../../src/editor/nodes/sprite-map";
import {
	clearTileColliderGenerator,
	generateTileColliders,
	getTileColliderGenerator,
	getTileColliderGeneratorSnapshot,
	notifySpriteMapTileDataChanged,
	refreshTileColliders,
	restoreTileColliderGeneratorSnapshot,
	setTileColliderGenerator,
} from "../../src/mcp/sprites/sprites";
import { listPhysics2D } from "../../src/mcp/physics2d/physics2d";

describe("mcp/tile-colliders", () => {
	let engine: NullEngine;
	let scene: Scene;
	let map: SpriteMapNode;
	const options = {
		editor: { layout: { graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() }, inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		map = new SpriteMapNode("Map", scene);
		(map as any)._spriteMap = { options: { stageSize: new Vector2(4, 2), outputSize: new Vector2(400, 200) }, dispose: vi.fn() };
		map.tiles = [
			{ id: "solid", name: "Solid", layer: 0, position: { x: 1, y: 0 }, repeatCount: { x: 1, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 3 } as any,
			{ id: "decoration", name: "Decoration", layer: 0, position: { x: 0, y: 1 }, repeatCount: { x: 0, y: 0 }, repeatOffset: { x: 0, y: 0 }, tile: 7 } as any,
		];
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("generates static 2D bodies for filtered repeated tile cells and clears them", () => {
		const result = generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [3], merge: false, friction: 0.5 }, options);
		expect(result.colliderCount).toBe(2);
		expect(getTileColliderGenerator(scene, { mapNodeId: map.id }).generator).toMatchObject({ tileIndexes: [3], merge: false, nodeIds: result.generator.nodeIds });
		expect(listPhysics2D(scene).bodies).toHaveLength(2);
		expect(listPhysics2D(scene).bodies.every((body: any) => body.bodyType === "static" && body.collider.shape === "box")).toBe(true);
		expect(clearTileColliderGenerator(scene, { mapNodeId: map.id, expectedRevision: result.generator.revision }, options)).toMatchObject({ cleared: true, removedCount: 2 });
		expect(listPhysics2D(scene).bodies).toHaveLength(0);
	});

	test("validates tile index and layer filters", () => {
		expect(() => generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [-1] }, options)).toThrow("non-negative");
		expect(() => generateTileColliders(scene, { mapNodeId: map.id, layer: -1 }, options)).toThrow("non-negative");
	});

	test("refreshes generated colliders from persisted settings after tile edits", () => {
		const generated = generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [3], merge: false, isTrigger: true, friction: 0.5 }, options);
		map.tiles[0].repeatCount.x = 0;
		const refreshed = refreshTileColliders(scene, { mapNodeId: map.id, expectedRevision: generated.generator.revision }, options);
		expect(refreshed).toMatchObject({ refreshed: true, colliderCount: 1, generator: { tileIndexes: [3], merge: false, isTrigger: true, friction: 0.5 } });
		expect(listPhysics2D(scene).bodies).toHaveLength(1);
	});

	test("supports exact-revision manual generation, pending changes, and snapshot restoration", () => {
		const generated = generateTileColliders(scene, { mapNodeId: map.id, compositeOperation: "merge" }, options);
		const before = getTileColliderGeneratorSnapshot(scene, { mapNodeId: map.id });
		const configured = setTileColliderGenerator(
			scene,
			{ mapNodeId: map.id, expectedRevision: generated.generator.revision, update: { generationType: "manual", maxTileChangeCount: 1, isTrigger: true } },
			options
		);
		expect(configured.generator).toMatchObject({ revision: 2, generationType: "manual", maxTileChangeCount: 1, isTrigger: true });
		expect(() => setTileColliderGenerator(scene, { mapNodeId: map.id, expectedRevision: 1, update: { friction: 0.2 } }, options)).toThrow("revision is 2");

		map.tiles[0].repeatCount.x = 0;
		notifySpriteMapTileDataChanged(scene, { mapNodeId: map.id }, options);
		expect(getTileColliderGenerator(scene, { mapNodeId: map.id }).generator).toMatchObject({ revision: 2, pendingChangeCount: 1, hasTilemapChanges: true });

		const refreshed = refreshTileColliders(scene, { mapNodeId: map.id, expectedRevision: 2 }, options);
		expect(refreshed).toMatchObject({ mode: "incremental", changedCellCount: 1, colliderCount: 2, generator: { hasTilemapChanges: false } });
		restoreTileColliderGeneratorSnapshot(scene, before, options);
		expect(getTileColliderGenerator(scene, { mapNodeId: map.id }).generator).toMatchObject({ revision: 1, generationType: "synchronous", isTrigger: false });
	});

	test("reuses stable bodies incrementally and performs a full rebuild above the change threshold", () => {
		const generated = generateTileColliders(scene, { mapNodeId: map.id, compositeOperation: "none", maxTileChangeCount: 1 }, options);
		const originalIds = [...generated.generator.nodeIds];
		map.tiles.pop();
		notifySpriteMapTileDataChanged(scene, { mapNodeId: map.id }, options);
		const incremental = getTileColliderGenerator(scene, { mapNodeId: map.id }).generator;
		expect(incremental.lastBuild).toMatchObject({ mode: "incremental", changedCellCount: 1, reusedColliderCount: 2, createdColliderCount: 0, removedColliderCount: 1 });
		expect(incremental.nodeIds.filter((id: string) => originalIds.includes(id))).toHaveLength(2);

		map.tiles[0].tile = 9;
		notifySpriteMapTileDataChanged(scene, { mapNodeId: map.id }, options);
		const full = getTileColliderGenerator(scene, { mapNodeId: map.id }).generator;
		expect(full.lastBuild).toMatchObject({ mode: "full", changedCellCount: 2, reusedColliderCount: 0, createdColliderCount: 2, removedColliderCount: 2 });
	});

	test("keeps the previous generated state when an advanced settings rebuild fails", () => {
		const generated = generateTileColliders(scene, { mapNodeId: map.id, tileIndexes: [3], compositeOperation: "none" }, options);
		const bodyIds = listPhysics2D(scene).bodies.map((body: any) => body.nodeId);
		expect(() =>
			setTileColliderGenerator(
				scene,
				{ mapNodeId: map.id, expectedRevision: generated.generator.revision, update: { tileColliderTypes: { 3: "sprite" }, spriteShapes: {} } },
				options
			)
		).toThrow("has no normalized spriteShapes entry");
		expect(getTileColliderGenerator(scene, { mapNodeId: map.id }).generator.revision).toBe(generated.generator.revision);
		expect(listPhysics2D(scene).bodies.map((body: any) => body.nodeId)).toEqual(bodyIds);
	});

	test("persists custom Sprite shapes and applies complete 2D physics settings to generated bodies", () => {
		scene.metadata = { babylonEditorPhysics2DMaterials: [{ id: "ice", name: "Ice", friction: 0.1, restitution: 0.8 }] };
		const contours = [
			{
				id: "outer",
				points: [
					[-0.5, -0.5],
					[0.5, -0.5],
					[0.5, 0.5],
					[-0.5, 0.5],
				],
				holes: [
					{
						id: "hole",
						points: [
							[-0.1, -0.1],
							[-0.1, 0.1],
							[0.1, 0.1],
							[0.1, -0.1],
						],
					},
				],
			},
		];
		const result = generateTileColliders(
			scene,
			{
				mapNodeId: map.id,
				tileIndexes: [7],
				compositeOperation: "none",
				useDelaunayMesh: true,
				tileColliderTypes: { 7: "sprite" },
				spriteShapes: { 7: contours },
				materialId: "ice",
				isTrigger: true,
				usedByEffector: true,
				friction: 0.25,
				restitution: 0.75,
				collisionLayer: 3,
				layerOverrides: { priority: 2, includeLayers: 4, excludeLayers: 8, forceSendLayers: 16, forceReceiveLayers: 32, contactCaptureLayers: 64, callbackLayers: 128 },
			},
			options
		);
		expect(result).toMatchObject({
			colliderCount: 1,
			generator: { materialId: "ice", isTrigger: true, usedByEffector: true, collisionLayer: 3 },
			evidence: { polygonCount: 1, triangulation: "bounded-delaunay-edge-flips-v1" },
		});
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({
			bodyType: "static",
			materialId: "ice",
			isTrigger: true,
			usedByEffector: true,
			friction: 0.25,
			restitution: 0.75,
			collisionLayer: 3,
			layerOverrides: { priority: 2, includeLayers: 4, callbackLayers: 128 },
			collider: { shape: "polygon", outerCount: 1, holeCount: 1, delaunayFlipCount: expect.any(Number) },
		});
		const serialized = map.serialize();
		expect(serialized.metadata.babylonEditorTileColliderGenerator).toMatchObject({ model: "unity-tilemap-collider-2d-v1", revision: 1, spriteShapes: { 7: contours } });
	});
});

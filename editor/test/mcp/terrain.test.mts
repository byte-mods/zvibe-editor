import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, MeshBuilder, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { carveTerrainHole, getTerrain, paintTerrainDetails, scatterTerrainInstances, sculptTerrain } from "../../src/mcp/meshes/meshes";

describe("mcp/terrain", () => {
	let engine: NullEngine;
	let scene: Scene;
	let terrain: Mesh;
	let source: Mesh;
	const options = {
		editor: {
			layout: {
				preview: { scene: null },
				graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		terrain = MeshBuilder.CreateGround("Terrain", { width: 100, height: 100, subdivisions: 4 }, scene);
		terrain.metadata = { type: "Ground", width: 100, height: 100, subdivisions: 4 };
		source = MeshBuilder.CreateBox("Tree", { size: 2 }, scene);
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("scatters deterministic instances and replaces an existing scatter group", () => {
		const first = scatterTerrainInstances(scene, { nodeId: terrain.id, sourceNodeId: source.id, count: 5, seed: 42, scatterId: "trees", minScale: 1, maxScale: 2 }, options);
		expect(first.instances).toHaveLength(5);
		expect(terrain.metadata.terrainScatter).toEqual([{ scatterId: "trees", sourceId: source.id, count: 5, seed: 42, minScale: 1, maxScale: 2, margin: 0 }]);
		expect(getTerrain(scene, { nodeId: terrain.id }).terrain.scatter).toHaveLength(1);

		const second = scatterTerrainInstances(scene, { nodeId: terrain.id, sourceNodeId: source.id, count: 3, seed: 42, scatterId: "trees" }, options);
		expect(second.instances).toHaveLength(3);
		expect(scene.meshes.filter((mesh) => mesh.metadata?.babylonEditorTerrainScatter?.scatterId === "trees")).toHaveLength(3);
	});

	test("sculpts persisted terrain geometry and carves a circular hole", () => {
		const sculpted = sculptTerrain(scene, { nodeId: terrain.id, center: [0, 0], radius: 50, strength: 20, mode: "raise" }, options);
		expect(sculpted.changedVertices).toBeGreaterThan(0);
		expect(getTerrain(scene, { nodeId: terrain.id }).terrain.maxHeight).toBeGreaterThan(0);

		const hole = carveTerrainHole(scene, { nodeId: terrain.id, center: [0, 0], radius: 20 }, options);
		expect(hole.removedTriangles).toBeGreaterThan(0);
		expect(hole.terrain.holes).toEqual([{ center: [0, 0], radius: 20 }]);
	});

	test("paints and replaces a persisted terrain detail layer inside its brush", () => {
		const first = paintTerrainDetails(scene, { nodeId: terrain.id, sourceNodeId: source.id, center: [0, 0], radius: 10, density: 100, seed: 7, layerId: "grass", minScale: 0.5, maxScale: 1 }, options);
		expect(first.paintedInstances).toHaveLength(3);
		expect(getTerrain(scene, { nodeId: terrain.id }).terrain.detailLayers).toEqual([{ layerId: "grass", sourceId: source.id, density: 100, minScale: 0.5, maxScale: 1, seed: 7 }]);

		const second = paintTerrainDetails(scene, { nodeId: terrain.id, sourceNodeId: source.id, center: [0, 0], radius: 10, density: 100, seed: 9, layerId: "grass" }, options);
		expect(second.paintedInstances).toHaveLength(3);
		expect(scene.meshes.filter((mesh) => mesh.metadata?.babylonEditorTerrainDetail?.layerId === "grass")).toHaveLength(3);
	});
});

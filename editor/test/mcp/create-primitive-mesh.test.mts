import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, NullEngine, Scene } from "babylonjs";

import { createPrimitiveMesh } from "../../src/mcp/meshes/meshes";

describe("mcp/create_primitive_mesh", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					preview: { scene, gizmo: { setAttachedObject: vi.fn() } },
					graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				},
			},
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	function extents(mesh: Mesh): number[] {
		mesh.refreshBoundingInfo();
		const size = mesh.getBoundingInfo().boundingBox.extendSizeWorld.scale(2);
		return [size.x, size.y, size.z].map((value) => Math.round(value));
	}

	test("applies documented MeshBuilder options instead of silently creating default-sized primitives", () => {
		const wall = createPrimitiveMesh(scene, { type: "box", name: "Wall", position: [0, 150, 0], options: { width: 4000, height: 300, depth: 80 } }, options);
		const wallMesh = scene.getMeshById(wall.id) as Mesh;
		expect(extents(wallMesh)).toEqual([4000, 300, 80]);
		expect(wallMesh.metadata).toMatchObject({ type: "Box", width: 4000, height: 300, depth: 80 });
		expect(wall.position).toEqual([0, 150, 0]);

		const crate = scene.getMeshById(createPrimitiveMesh(scene, { type: "box", options: { size: 60 } }, options).id) as Mesh;
		expect(extents(crate)).toEqual([60, 60, 60]);

		const pillar = scene.getMeshById(createPrimitiveMesh(scene, { type: "cylinder", options: { diameter: 200, height: 240, tessellation: 24 } }, options).id) as Mesh;
		expect(extents(pillar)).toEqual([200, 240, 200]);
		expect(pillar.metadata).toMatchObject({ diameterTop: 200, diameterBottom: 200, height: 240 });

		const floor = scene.getMeshById(createPrimitiveMesh(scene, { type: "ground", options: { width: 4400, height: 3000, subdivisions: 2 } }, options).id) as Mesh;
		expect(extents(floor)).toEqual([4400, 0, 3000]);

		const orb = scene.getMeshById(createPrimitiveMesh(scene, { type: "sphere", options: { diameter: 30 } }, options).id) as Mesh;
		expect(extents(orb)).toEqual([30, 30, 30]);
	});

	test("keeps default sizes without options and rejects invalid options without leaving a mesh behind", () => {
		const box = scene.getMeshById(createPrimitiveMesh(scene, { type: "box" }, options).id) as Mesh;
		expect(extents(box)).toEqual([100, 100, 100]);

		const meshCount = scene.meshes.length;
		expect(() => createPrimitiveMesh(scene, { type: "box", options: { width: "wide" } }, options)).toThrow('Primitive option "width" must be a finite number');
		expect(() => createPrimitiveMesh(scene, { type: "ground", options: { heightMapTexturePath: "x.png" } }, options)).toThrow("set_ground_heightmap");
		expect(() => createPrimitiveMesh(scene, { type: "empty", options: { size: 10 } }, options)).toThrow('Primitive type "empty" does not accept geometry options.');
		expect(scene.meshes.length).toBe(meshCount);
	});
});

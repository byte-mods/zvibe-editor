import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { createCloth, listCloths, setCloth } from "../../src/mcp/cloth/cloth";

describe("mcp/cloth collision", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists and clears a local-space plane collision constraint", () => {
		const cloth = createCloth(
			scene,
			{
				name: "Banner",
				subdivisions: 2,
				collisionPlane: { normal: [0, 1, 0], offset: -50, restitution: 0.25 },
				collisionSpheres: [{ center: [0, 0, 0], radius: 25, restitution: 0.5 }],
				collisionBoxes: [{ center: [0, 0, 0], size: [20, 30, 40], restitution: 0.25 }],
			},
			options
		);
		expect(cloth.collisionPlane).toEqual({ normal: [0, 1, 0], offset: -50, restitution: 0.25 });
		expect(cloth.collisionSpheres).toEqual([{ center: [0, 0, 0], radius: 25, restitution: 0.5 }]);
		expect(cloth.collisionBoxes).toEqual([{ center: [0, 0, 0], size: [20, 30, 40], restitution: 0.25 }]);
		setCloth(scene, { id: cloth.id, collisionPlane: null, collisionSpheres: null, collisionBoxes: null }, options);
		expect(listCloths(scene).cloths[0].collisionPlane).toBeNull();
		expect(listCloths(scene).cloths[0].collisionSpheres).toBeNull();
		expect(listCloths(scene).cloths[0].collisionBoxes).toBeNull();
		setCloth(scene, { id: cloth.id, collisionPlane: { normal: [0, 2, 0], offset: 10, restitution: 0.5 } }, options);
		expect(listCloths(scene).cloths[0].collisionPlane).toEqual({ normal: [0, 1, 0], offset: 10, restitution: 0.5 });
		expect(() => setCloth(scene, { id: cloth.id, collisionPlane: { normal: [0, 0, 0] } }, options)).toThrow("non-zero");
		expect(() => setCloth(scene, { id: cloth.id, collisionSpheres: [{ center: [0, 0, 0], radius: 0 }] }, options)).toThrow("radius");
		expect(() => setCloth(scene, { id: cloth.id, collisionBoxes: [{ center: [0, 0, 0], size: [20, 0, 40] }] }, options)).toThrow("size");
	});

	test("projects unpinned cloth vertices outside a local-space sphere collider", () => {
		const cloth = createCloth(scene, { name: "Sphere Banner", subdivisions: 2, collisionSpheres: [{ center: [0, 0, 0], radius: 80 }] }, options);
		const mesh = scene.getMeshById(cloth.mesh.id)!;
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const positions = Array.from(mesh.getVerticesData("position")!);
		const centerVertex = positions.slice(12, 15);
		expect(Math.hypot(centerVertex[0], centerVertex[1], centerVertex[2])).toBeGreaterThanOrEqual(79.999);
	});

	test("updates the live pinned-vertex constraint set", () => {
		const cloth = createCloth(scene, { name: "Pinned Banner", subdivisions: 2, pinnedVertices: [0] }, options);
		setCloth(scene, { id: cloth.id, pinnedVertices: [4, 8] }, options);
		expect(listCloths(scene).cloths[0].pinnedVertices).toEqual([4, 8]);
		expect(() => setCloth(scene, { id: cloth.id, pinnedVertices: [9] }, options)).toThrow("indices");
	});

	test("persists validated dynamic mesh-bounds collider ids", () => {
		const collider = MeshBuilder.CreateBox("Collider", { size: 40 }, scene);
		const cloth = createCloth(scene, { name: "Mesh Banner", subdivisions: 2, collisionMeshIds: [collider.id] }, options);
		expect(listCloths(scene).cloths[0].collisionMeshIds).toEqual([collider.id]);
		expect(() => setCloth(scene, { id: cloth.id, collisionMeshIds: [cloth.mesh.id] }, options)).toThrow("own mesh");
	});

	test("persists bounded optional self-collision configuration", () => {
		const cloth = createCloth(scene, { name: "Self Collision", subdivisions: 2, selfCollision: true, selfCollisionRadius: 12 }, options);
		expect(listCloths(scene).cloths[0]).toMatchObject({ selfCollision: true, selfCollisionRadius: 12 });
		setCloth(scene, { id: cloth.id, selfCollision: false, selfCollisionRadius: 8 }, options);
		expect(listCloths(scene).cloths[0]).toMatchObject({ selfCollision: false, selfCollisionRadius: 8 });
		expect(() => setCloth(scene, { id: cloth.id, selfCollisionRadius: 0 }, options)).toThrow("selfCollisionRadius");
	});
});

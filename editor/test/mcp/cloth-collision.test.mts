import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, MeshBuilder, NullEngine, Scene, SceneSerializer, VertexBuffer } from "babylonjs";

vi.mock("babylonjs-editor-tools", async (importOriginal) => await importOriginal());

import {
	createCloth,
	deleteCloth,
	getClothCollisionDiagnostics,
	getClothConstraintSnapshot,
	getClothConstraints,
	getClothConstraintPaintViewport,
	paintClothConstraints,
	restoreClothConstraintSnapshot,
	listCloths,
	setCloth,
	setClothConstraintPaintViewport,
} from "../../src/mcp/cloth/cloth";

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

	test("paints paginated exact-revision vertex constraints and restores snapshot content", () => {
		const cloth = createCloth(scene, { name: "Painted Banner", subdivisions: 2 }, options);
		const before = getClothConstraintSnapshot(scene, cloth.id);
		const painted = paintClothConstraints(
			scene,
			{
				id: cloth.id,
				expectedConstraintRevision: before.constraintRevision,
				center: [0, 0, 0],
				radius: 1,
				channel: "maxDistance",
				mode: "paint",
				value: 4,
				strength: 1,
				falloff: "smooth",
				maxAffectedVertices: 8,
			},
			options
		);
		expect(painted).toMatchObject({ affectedCount: 1, constraintRevision: 2, constraintCount: 1 });
		expect(getClothConstraints(scene, { id: cloth.id, offset: 0, limit: 1 })).toMatchObject({
			constraintRevision: 2,
			vertexConstraints: [{ vertexIndex: 4, maxDistance: 4 }],
			page: { total: 1, returned: 1, nextOffset: null },
		});
		expect(listCloths(scene).cloths[0]).toMatchObject({ constraintRevision: 2, vertexConstraintCount: 1 });
		expect(listCloths(scene).cloths[0].vertexConstraints).toBeUndefined();
		expect(() => paintClothConstraints(scene, { ...painted, id: cloth.id, expectedConstraintRevision: 1 }, options)).toThrow("stale");
		const erased = paintClothConstraints(
			scene,
			{
				id: cloth.id,
				expectedConstraintRevision: 2,
				center: [0, 0, 0],
				radius: 1,
				channel: "maxDistance",
				mode: "erase",
				strength: 1,
				falloff: "constant",
				maxAffectedVertices: 8,
			},
			options
		);
		expect(erased).toMatchObject({ mutated: true, constraintRevision: 3, constraintCount: 0 });
		restoreClothConstraintSnapshot(scene, before, options);
		expect(getClothConstraints(scene, { id: cloth.id }).page.total).toBe(0);
	});

	test("requires an exact lease for atomic direct constraint replacement", () => {
		const cloth = createCloth(scene, { name: "Leased Constraints", subdivisions: 2 }, options);
		expect(() => setCloth(scene, { id: cloth.id, vertexConstraints: [{ vertexIndex: 4, maxDistance: 5 }] }, options)).toThrow("expectedConstraintRevision");
		expect(() => setCloth(scene, { id: cloth.id, expectedConstraintRevision: 1 }, options)).toThrow("vertexConstraints");
		expect(setCloth(scene, { id: cloth.id, expectedConstraintRevision: 1, vertexConstraints: [{ vertexIndex: 4, maxDistance: 5 }] }, options)).toMatchObject({
			constraintRevision: 2,
			vertexConstraintCount: 1,
		});
		expect(() => setCloth(scene, { id: cloth.id, expectedConstraintRevision: 1, vertexConstraints: [] }, options)).toThrow("stale");
	});

	test("rejects over-cap brushes before changing constraint content or revision", () => {
		const cloth = createCloth(scene, { name: "Bounded Brush", subdivisions: 4 }, options);
		expect(() =>
			paintClothConstraints(
				scene,
				{
					id: cloth.id,
					expectedConstraintRevision: 1,
					center: [0, 0, 0],
					radius: 1000,
					channel: "maxDistance",
					mode: "paint",
					value: 5,
					strength: 1,
					falloff: "constant",
					maxAffectedVertices: 1,
				},
				options
			)
		).toThrow("above maxAffectedVertices");
		expect(getClothConstraints(scene, { id: cloth.id })).toMatchObject({ constraintRevision: 1, page: { total: 0 } });
	});

	test("bounds large successful brush responses and rejects stale snapshot restoration", () => {
		const cloth = createCloth(scene, { name: "Bounded Response", subdivisions: 20 }, options);
		const before = getClothConstraintSnapshot(scene, cloth.id);
		const painted = paintClothConstraints(
			scene,
			{
				id: cloth.id,
				expectedConstraintRevision: before.constraintRevision,
				center: [0, 0, 0],
				radius: 1000,
				channel: "maxDistance",
				mode: "paint",
				value: 5,
				strength: 1,
				falloff: "constant",
				maxAffectedVertices: 4096,
			},
			options
		);
		expect(painted).toMatchObject({ affectedCount: 441, returnedAffectedVertices: 256, affectedVerticesTruncated: true, constraintRevision: 2 });
		expect(painted.affectedVertices).toHaveLength(256);
		expect(() => restoreClothConstraintSnapshot(scene, before, options, 1)).toThrow("stale");
		expect(restoreClothConstraintSnapshot(scene, before, options, 2)).toMatchObject({ constraintRevision: 3, page: { total: 0 } });
	});

	test("persists validated transformed triangle colliders and exposes diagnostics", () => {
		const collider = MeshBuilder.CreatePlane("Triangle Collider", { size: 100 }, scene);
		const cloth = createCloth(
			scene,
			{ name: "Triangle Banner", subdivisions: 2, triangleColliders: [{ meshId: collider.id, thickness: 3, restitution: 0.25, friction: 0.5 }] },
			options
		);
		expect(listCloths(scene).cloths[0].triangleColliders).toEqual([{ meshId: collider.id, thickness: 3, restitution: 0.25, friction: 0.5 }]);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getClothCollisionDiagnostics(scene, { id: cloth.id })).toMatchObject({ count: 1, diagnostics: [{ clothId: cloth.id, configuredColliders: 1, activeColliders: 1 }] });
		expect(() => setCloth(scene, { id: cloth.id, triangleColliders: [{ meshId: cloth.mesh.id }] }, options)).toThrow("own mesh");
		expect(() => setCloth(scene, { id: cloth.id, triangleColliders: [{ meshId: "missing" }] }, options)).toThrow("no valid triangle geometry");
		expect(() => setCloth(scene, { id: cloth.id, triangleColliders: [{ meshId: collider.id }, { meshId: collider.id }] }, options)).toThrow("duplicate");
		expect(() => setCloth(scene, { id: cloth.id, triangleColliders: [{ meshId: collider.id, friction: 2 }] }, options)).toThrow("friction");
		const oversized = new Mesh("Oversized Collider", scene);
		oversized.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
		oversized.setIndices(Array.from({ length: 4097 * 3 }, (_, index) => index % 3));
		expect(() => setCloth(scene, { id: cloth.id, triangleColliders: [{ meshId: oversized.id }] }, options)).toThrow("4097 triangles");
		const invalid = new Mesh("Invalid Collider", scene);
		invalid.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
		invalid.setIndices([0, 1, 3]);
		expect(() => setCloth(scene, { id: cloth.id, triangleColliders: [{ meshId: invalid.id }] }, options)).toThrow("out-of-range vertex index");
	});

	test("serializes authored constraints and triangle colliders without transient viewport state", () => {
		const collider = MeshBuilder.CreatePlane("Serialized Collider", { size: 50 }, scene);
		const cloth = createCloth(
			scene,
			{
				name: "Serialized Cloth",
				subdivisions: 2,
				vertexConstraints: [{ vertexIndex: 4, maxDistance: 5, surfacePenetration: 1 }],
				triangleColliders: [{ meshId: collider.id, thickness: 2, restitution: 0.25, friction: 0.5 }],
			},
			options
		);
		setClothConstraintPaintViewport(scene, { expectedRevision: 1, clothId: cloth.id, enabled: true }, options);
		const serialized = SceneSerializer.Serialize(scene) as any;
		expect(serialized.metadata.babylonEditorCloths[0]).toMatchObject({
			constraintRevision: 1,
			vertexConstraints: [{ vertexIndex: 4, maxDistance: 5, surfacePenetration: 1 }],
			triangleColliders: [{ meshId: collider.id, thickness: 2, restitution: 0.25, friction: 0.5 }],
		});
		expect(serialized.metadata.clothConstraintPaintState).toBeUndefined();
	});

	test("uses an exact scene-local viewport paint lease and disables a deleted target", () => {
		const cloth = createCloth(scene, { name: "Viewport Paint", subdivisions: 2 }, options);
		expect(getClothConstraintPaintViewport(scene)).toMatchObject({ revision: 1, enabled: false, clothId: null });
		const enabled = setClothConstraintPaintViewport(
			scene,
			{ expectedRevision: 1, clothId: cloth.id, enabled: true, channel: "surfacePenetration", value: 2, radius: 25, strength: 0.75, falloff: "linear" },
			options
		);
		expect(enabled).toMatchObject({ revision: 2, enabled: true, clothId: cloth.id, channel: "surfacePenetration", value: 2, radius: 25, strength: 0.75, falloff: "linear" });
		expect(() => setClothConstraintPaintViewport(scene, { expectedRevision: 1, enabled: false }, options)).toThrow("stale");
		deleteCloth(scene, { id: cloth.id }, options);
		expect(getClothConstraintPaintViewport(scene)).toMatchObject({ revision: 3, enabled: false, clothId: null });
	});
});

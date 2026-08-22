import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, SceneSerializer } from "babylonjs";

import { listPhysics2D } from "../../src/mcp/physics2d/physics2d";
import {
	createSpriteShape,
	createSpriteShapeProfile,
	deleteSpriteShape,
	deleteSpriteShapeProfile,
	getSpriteShape,
	getSpriteShapeProfile,
	getSpriteShapeSnapshot,
	listSpriteShapeProfiles,
	listSpriteShapes,
	restoreSpriteShapeSnapshot,
	setSpriteShape,
	setSpriteShapeProfile,
} from "../../src/mcp/sprites/sprite-shapes";

describe("mcp/sprite-shapes", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					preview: { scene, forceUpdate: vi.fn(), gizmo: { setAttachedObject: vi.fn() } },
					inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() },
					graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
				},
			},
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates a shared profile and a closed generated shape with runtime polygon collision", () => {
		const profile = createSpriteShapeProfile(scene, { name: "Grass Platform", edgeColor: [0.1, 0.8, 0.2, 1], fillColor: [0.05, 0.25, 0.1, 1] }, options);
		const created = createSpriteShape(scene, { name: "Hill", profileId: profile.id }, options) as any;

		expect(created.definition).toMatchObject({ model: "unity-sprite-shape-controller-v1", revision: 1, profileId: profile.id, closed: true });
		expect(created.generated).toMatchObject({ profileRevision: 1, sampleCount: 4, fillTriangleCount: 2, colliderType: "polygon" });
		expect(created.generated.vertexCount).toBe(20);
		expect(scene.getMeshById(created.node.id)?.subMeshes.length).toBe(2);
		expect(listPhysics2D(scene).bodies).toEqual([
			expect.objectContaining({
				nodeId: created.node.id,
				bodyType: "static",
				collider: expect.objectContaining({ shape: "polygon", model: "unity-polygon-collider-holes-islands-v1" }),
			}),
		]);
		expect((listSpriteShapeProfiles(scene) as any).profiles.items[0]).toMatchObject({ id: profile.id, shapeCount: 1 });
		expect((listSpriteShapes(scene) as any).shapes.items[0]).toMatchObject({ node: { id: created.node.id }, revision: 1, controlPointCount: 4 });

		const serialized = SceneSerializer.Serialize(scene) as any;
		expect(serialized.metadata.babylonEditorSpriteShapeProfiles[0]).toMatchObject({ id: profile.id, model: "unity-sprite-shape-profile-v1", revision: 1 });
		expect(serialized.meshes.find((mesh: any) => mesh.id === created.node.id)?.metadata).toMatchObject({
			babylonEditorSpriteShape: { model: "unity-sprite-shape-controller-v1", profileId: profile.id, revision: 1 },
			babylonEditorSpriteShapeGenerated: { model: "unity-sprite-shape-generated-geometry-v1", vertexCount: 20 },
			babylonEditorSpriteShapeColliderOwned: true,
		});
	});

	test("exact-revision updates an open cubic shape and publishes thick edge collision", () => {
		const profile = createSpriteShapeProfile(scene, { name: "Road" }, options);
		const created = createSpriteShape(scene, { name: "Road Shape", profileId: profile.id }, options) as any;
		const updated = setSpriteShape(
			scene,
			{
				nodeId: created.node.id,
				expectedRevision: 1,
				update: {
					closed: false,
					detail: 4,
					points: [
						{ id: "start", position: [-100, 0], leftTangent: [0, 0], rightTangent: [50, 80], tangentMode: "broken", height: 20, corner: false },
						{ id: "end", position: [100, 0], leftTangent: [-50, 80], rightTangent: [0, 0], tangentMode: "broken", height: 30, corner: false },
					],
					collider: { type: "edge", detail: 4, edgeRadius: 4, offset: 2, isTrigger: true },
				},
			},
			options
		) as any;

		expect(updated.definition).toMatchObject({ revision: 2, closed: false, detail: 4, collider: { type: "edge", edgeRadius: 4, isTrigger: true } });
		expect(updated.generated).toMatchObject({ sampleCount: 5, edgeQuadCount: 4, fillTriangleCount: 0, colliderType: "edge", colliderPartCount: 4 });
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({
			nodeId: created.node.id,
			isTrigger: true,
			collider: { shape: "edge", model: "unity-sprite-shape-edge-collider-v1", edgeRadius: 4, parts: expect.arrayContaining([expect.any(Array)]) },
		});
		expect(() => setSpriteShape(scene, { nodeId: created.node.id, expectedRevision: 1, update: { detail: 8 } }, options)).toThrow(/revision is 2/i);
		expect((getSpriteShape(scene, { nodeId: created.node.id }) as any).definition.detail).toBe(4);
	});

	test("rebuilds every dependent shape from an exact profile revision and rejects invalid updates atomically", () => {
		const profile = createSpriteShapeProfile(scene, { name: "Shared" }, options);
		const first = createSpriteShape(scene, { name: "First", profileId: profile.id }, options) as any;
		const second = createSpriteShape(scene, { name: "Second", profileId: profile.id }, options) as any;
		const updatedProfile = setSpriteShapeProfile(
			scene,
			{
				profileId: profile.id,
				expectedRevision: 1,
				update: {
					fillColor: [0.2, 0.3, 0.9, 1],
					angleRanges: [{ id: "uphill", name: "Uphill", minimumDegrees: 0, maximumDegrees: 90, order: 2, texturePath: null, color: [1, 0.5, 0.1, 1] }],
				},
			},
			options
		);

		expect(updatedProfile.revision).toBe(2);
		expect((getSpriteShape(scene, { nodeId: first.node.id }) as any).generated.profileRevision).toBe(2);
		expect((getSpriteShape(scene, { nodeId: second.node.id }) as any).generated.materialSlotCount).toBe(3);
		expect(() => setSpriteShapeProfile(scene, { profileId: profile.id, expectedRevision: 1, update: { name: "Stale" } }, options)).toThrow(/revision is 2/i);
		expect(() => setSpriteShape(scene, { nodeId: first.node.id, expectedRevision: 1, update: { fillOffset: Number.NaN } }, options)).toThrow(
			/fillOffset must be a finite number/i
		);
		expect((getSpriteShapeProfile(scene, { profileId: profile.id }) as any).name).toBe("Shared");
		expect((getSpriteShape(scene, { nodeId: first.node.id }) as any).definition.revision).toBe(1);
	});

	test("restores complete snapshots as new revisions and enforces profile ownership on deletion", () => {
		const profile = createSpriteShapeProfile(scene, { name: "Undo Profile" }, options);
		const created = createSpriteShape(scene, { name: "Undo Shape", profileId: profile.id }, options) as any;
		const mesh = scene.getMeshById(created.node.id)!;
		const snapshot = getSpriteShapeSnapshot(mesh as any);
		setSpriteShape(scene, { nodeId: mesh.id, expectedRevision: 1, update: { detail: 3 } }, options);
		const restored = restoreSpriteShapeSnapshot(scene, snapshot, options) as any;

		expect(restored.definition).toMatchObject({ revision: 3, detail: 8 });
		expect(() => deleteSpriteShapeProfile(scene, { profileId: profile.id, expectedRevision: 1 }, options)).toThrow(/used by 1 shape/i);
		expect(deleteSpriteShape(scene, { nodeId: mesh.id, expectedRevision: 3 }, options)).toMatchObject({ deleted: true, nodeId: mesh.id, revision: 3 });
		expect(listPhysics2D(scene).bodies).toEqual([]);
		expect(scene.materials.filter((material) => material.name !== "default material")).toHaveLength(0);
		expect(deleteSpriteShapeProfile(scene, { profileId: profile.id, expectedRevision: 1 }, options)).toEqual({ deleted: true, id: profile.id, revision: 1 });
	});
});

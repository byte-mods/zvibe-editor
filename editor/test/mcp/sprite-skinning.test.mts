import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, VertexBuffer } from "babylonjs";

import { getMeshSkinWeights, paintMeshSkinWeights } from "../../src/mcp/rigging/skin-weights";
import {
	buildPsdSpriteSkinRigPlan,
	createSpriteSkin,
	createSpriteSkinAnimationClip,
	getSpriteSkin,
	listSpriteSkins,
	replaceSpriteSkinBones,
} from "../../src/mcp/sprites/sprite-skinning";

describe("mcp/2D sprite skinning", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				preview: { gizmo: { setAttachedObject: vi.fn() } },
				animations: { openAnimationWindow: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		vi.clearAllMocks();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates a persistent grid mesh, skeleton, normalized weights, and inspectable exact lease", () => {
		const created = createSpriteSkin(
			scene,
			{
				name: "Hero 2D",
				documentWidthPixels: 256,
				documentHeightPixels: 128,
				pixelsPerUnit: 100,
				columns: 4,
				rows: 2,
				bones: [
					{ id: "root", name: "Root", parentId: null, position: [-100, 0], rotationDegrees: 0, length: 100 },
					{ id: "arm", name: "Arm", parentId: "root", position: [100, 0], rotationDegrees: 0, length: 100 },
				],
			},
			options
		);

		expect(created).toMatchObject({ vertexCount: 15, triangleCount: 16, definition: { model: "unity-sprite-skin-v1", revision: 1 } });
		expect(created.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		const mesh = scene.getMeshById(created.node.id)!;
		expect(mesh.skeleton?.bones.map((bone) => bone.name)).toEqual(["Root", "Arm"]);
		expect(mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)).toHaveLength(60);
		const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!;
		for (let vertex = 0; vertex < mesh.getTotalVertices(); vertex++) {
			expect(weights.slice(vertex * 4, vertex * 4 + 4).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
		}
		expect(listSpriteSkins(scene).spriteSkins).toHaveLength(1);
		expect(getSpriteSkin(scene, { nodeId: mesh.id }).fingerprint).toBe(created.fingerprint);
	});

	test("replaces the complete hierarchy under an exact lease and reuses the production bone-weight painter", () => {
		const created = createSpriteSkin(scene, { name: "Painted", documentWidthPixels: 100, documentHeightPixels: 100, columns: 2, rows: 2 }, options);
		const replaced = replaceSpriteSkinBones(
			scene,
			{
				nodeId: created.node.id,
				expectedRevision: created.definition.revision,
				expectedFingerprint: created.fingerprint,
				bones: [
					{ id: "root", name: "Root", parentId: null, position: [-50, 0], rotationDegrees: 0, length: 50 },
					{ id: "hand", name: "Hand", parentId: "root", position: [50, 0], rotationDegrees: 0, length: 50 },
				],
			},
			options
		);
		expect(replaced.definition.revision).toBe(2);
		expect(() =>
			replaceSpriteSkinBones(scene, { nodeId: created.node.id, expectedRevision: 1, expectedFingerprint: created.fingerprint, bones: replaced.definition.bones }, options)
		).toThrow("revision is 2");

		const weights = getMeshSkinWeights(scene, { nodeId: created.node.id, limit: 20 });
		const painted = paintMeshSkinWeights(
			scene,
			{ nodeId: created.node.id, expectedFingerprint: weights.fingerprint, boneName: "Hand", vertexIndices: [0, 1], mode: "replace", weight: 1 },
			options
		);
		expect(painted.changedVertexCount).toBe(2);
		expect(painted.vertices.every((vertex: any) => vertex.influences[0].boneName === "Hand" && vertex.influences[0].weight === 1)).toBe(true);
	});

	test("authors a 2D-specific editable clip with planar position and rotation bone tracks", () => {
		const created = createSpriteSkin(
			scene,
			{
				name: "Animated",
				documentWidthPixels: 64,
				documentHeightPixels: 64,
				bones: [{ id: "root", name: "Root", parentId: null, position: [0, 0], rotationDegrees: 0, length: 50 }],
			},
			options
		);
		const clip = createSpriteSkinAnimationClip(
			scene,
			{
				nodeId: created.node.id,
				expectedRevision: created.definition.revision,
				expectedFingerprint: created.fingerprint,
				name: "Idle 2D",
				framesPerSecond: 30,
				tracks: [
					{
						boneName: "Root",
						property: "rotation",
						keys: [
							{ frame: 0, value: -5 },
							{ frame: 15, value: 5 },
						],
					},
					{
						boneName: "Root",
						property: "position",
						keys: [
							{ frame: 0, value: [0, 0] },
							{ frame: 15, value: [0, 3] },
						],
					},
				],
			},
			options
		);
		expect(clip).toMatchObject({ name: "Idle 2D", framesPerSecond: 30, trackCount: 2 });
		expect(scene.getAnimationGroupByName("Idle 2D")?.targetedAnimations.map((targeted) => targeted.animation.targetProperty)).toEqual(["rotationQuaternion", "position"]);
		expect(options.editor.layout.animations.openAnimationWindow).toHaveBeenCalledWith("Idle 2D");

		const inspected = getSpriteSkin(scene, { nodeId: created.node.id });
		const rebound = replaceSpriteSkinBones(
			scene,
			{
				nodeId: created.node.id,
				expectedRevision: inspected.definition.revision,
				expectedFingerprint: inspected.fingerprint,
				bones: [{ id: "root-2", name: "Root", parentId: null, position: [1, 2], rotationDegrees: 0, length: 60 }],
			},
			options
		);
		expect(scene.getAnimationGroupByName("Idle 2D")?.targetedAnimations.every((targeted) => rebound.skeleton.id === (targeted.target as any).getSkeleton().id)).toBe(true);
		expect(() =>
			replaceSpriteSkinBones(
				scene,
				{
					nodeId: created.node.id,
					expectedRevision: rebound.definition.revision,
					expectedFingerprint: rebound.fingerprint,
					bones: [{ id: "other", name: "Other", parentId: null, position: [0, 0], rotationDegrees: 0, length: 60 }],
				},
				options
			)
		).toThrow('Cannot remove animated sprite bone "Root"');
		expect(() =>
			createSpriteSkinAnimationClip(
				scene,
				{
					nodeId: created.node.id,
					expectedRevision: rebound.definition.revision,
					expectedFingerprint: rebound.fingerprint,
					name: "Broken 2D",
					tracks: [
						{
							boneName: "Root",
							property: "rotation",
							keys: [
								{ frame: 2, value: 0 },
								{ frame: 1, value: 10 },
							],
						},
					],
				},
				options
			)
		).toThrow("strictly increasing");
		expect(scene.getAnimationGroupByName("Broken 2D")).toBeNull();
	});

	test("turns PSD pixel/group bounds into a deterministic hierarchical rig plan", () => {
		const layer = (value: Partial<any>): any => ({
			index: 0,
			id: null,
			name: "Layer",
			kind: "pixel",
			top: 0,
			left: 0,
			bottom: 100,
			right: 100,
			width: 100,
			height: 100,
			visible: true,
			...value,
		});
		const document = {
			width: 200,
			height: 100,
			layers: [
				layer({ index: 0, name: "Arm Group", kind: "groupStart", left: 0, right: 100 }),
				layer({ index: 1, name: "Arm", left: 25, right: 75, top: 20, bottom: 80, width: 50, height: 60 }),
				layer({ index: 2, name: "Arm Group End", kind: "groupEnd", width: 0, height: 0 }),
				layer({ index: 3, name: "Hidden", visible: false }),
			],
		} as any;
		const plan = buildPsdSpriteSkinRigPlan(document, { sourcePath: "assets/hero.psd", sourceFingerprint: "a".repeat(64), pixelsPerUnit: 100, columns: 8, rows: 4 });
		expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.bones.map((bone) => ({ id: bone.id, parentId: bone.parentId, sourceLayerIndex: bone.sourceLayerIndex }))).toEqual([
			{ id: "root", parentId: null, sourceLayerIndex: null },
			{ id: "group-0", parentId: "root", sourceLayerIndex: 0 },
			{ id: "layer-1", parentId: "group-0", sourceLayerIndex: 1 },
		]);
		expect(plan.layers.find((candidate) => candidate.index === 3)?.included).toBe(false);
		expect(
			buildPsdSpriteSkinRigPlan(document, { sourcePath: "assets/hero.psd", sourceFingerprint: "b".repeat(64), pixelsPerUnit: 100, columns: 8, rows: 4 }).fingerprint
		).not.toBe(plan.fingerprint);

		const nested = buildPsdSpriteSkinRigPlan(
			{
				...document,
				layers: [
					layer({ index: 10, name: "Outer", kind: "groupStart" }),
					layer({ index: 11, name: "Hidden Group", kind: "groupStart", visible: false }),
					layer({ index: 12, name: "Hidden Child", visible: false }),
					layer({ index: 13, name: "Hidden End", kind: "groupEnd", width: 0, height: 0 }),
					layer({ index: 14, name: "Visible Child" }),
					layer({ index: 15, name: "Outer End", kind: "groupEnd", width: 0, height: 0 }),
				],
			} as any,
			{ sourcePath: "assets/nested.psd", sourceFingerprint: "c".repeat(64) }
		);
		expect(nested.bones.find((bone) => bone.id === "layer-14")?.parentId).toBe("group-10");
		expect(nested.warnings).toEqual([]);
	});
});

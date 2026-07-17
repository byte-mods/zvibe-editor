import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Bone, Matrix, Mesh, NullEngine, Scene, Skeleton, VertexBuffer, VertexData } from "babylonjs";

import { getMeshSkinWeights, mirrorMeshSkinWeights, optimizeMeshSkinWeights, paintMeshSkinWeights, setMeshSkinWeights } from "../../src/mcp/rigging/skin-weights";
import { setMeshVertexData } from "../../src/mcp/meshes/meshes";
import { writeBinaryGeometry } from "../../src/project/tools/geometry";

describe("mcp/skin weights", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				inspector: {
					setEditedObject: vi.fn(),
					forceUpdate: vi.fn(),
				},
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	function createSkinnedMesh(): { mesh: Mesh; skeleton: Skeleton } {
		const skeleton = new Skeleton("Character", "character-skeleton", scene);
		new Bone("Root", skeleton, null, Matrix.Identity(), Matrix.Identity());
		new Bone("LeftArm", skeleton, skeleton.bones[0], Matrix.Identity(), Matrix.Identity());
		new Bone("RightArm", skeleton, skeleton.bones[0], Matrix.Identity(), Matrix.Identity());
		new Bone("Spine", skeleton, skeleton.bones[0], Matrix.Identity(), Matrix.Identity());
		new Bone("Head", skeleton, skeleton.bones[3], Matrix.Identity(), Matrix.Identity());
		new Bone("Accessory", skeleton, skeleton.bones[3], Matrix.Identity(), Matrix.Identity());

		const mesh = new Mesh("Character Mesh", scene);
		const vertexData = new VertexData();
		vertexData.positions = [-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0];
		vertexData.indices = [0, 1, 2, 1, 3, 2];
		vertexData.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
		vertexData.matricesIndices = new Array(16).fill(0);
		vertexData.matricesWeights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
		vertexData.applyToMesh(mesh, true);
		mesh.skeleton = skeleton;
		mesh.numBoneInfluencers = 4;
		return { mesh, skeleton };
	}

	test("inspects, replaces, paints, optimizes, and mirrors up to eight named-bone influences", () => {
		const { mesh } = createSkinnedMesh();
		const initial = getMeshSkinWeights(scene, { nodeId: mesh.id, limit: 10 });
		expect(initial.report).toMatchObject({
			valid: true,
			vertexCount: 4,
			boneCount: 6,
			maximumObservedInfluences: 1,
		});
		expect(initial.vertices[0].influences).toEqual([{ boneIndex: 0, boneName: "Root", weight: 1 }]);

		const replaced = setMeshSkinWeights(
			scene,
			{
				nodeId: mesh.id,
				expectedFingerprint: initial.fingerprint,
				vertices: [
					{
						vertexIndex: 0,
						influences: [
							{ boneName: "LeftArm", weight: 0.4 },
							{ boneName: "Spine", weight: 0.2 },
							{ boneName: "Head", weight: 0.15 },
							{ boneName: "Accessory", weight: 0.1 },
							{ boneName: "Root", weight: 0.15 },
						],
					},
				],
				maxInfluences: 8,
			},
			options
		);
		expect(replaced.changedVertexCount).toBe(1);
		expect(mesh.numBoneInfluencers).toBe(5);
		expect(mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind)).not.toBeNull();
		expect(replaced.vertices[0].influences).toHaveLength(5);
		expect(replaced.vertices[0].weightSum).toBeCloseTo(1);
		expect(() =>
			setMeshSkinWeights(
				scene,
				{ nodeId: mesh.id, expectedFingerprint: initial.fingerprint, vertices: [{ vertexIndex: 1, influences: [{ boneName: "Root", weight: 1 }] }] },
				options
			)
		).toThrow("changed after inspection");

		const painted = paintMeshSkinWeights(
			scene,
			{
				nodeId: mesh.id,
				expectedFingerprint: replaced.fingerprint,
				boneName: "LeftArm",
				vertexIndices: [0, 2],
				mode: "replace",
				weight: 0.75,
				opacity: 1,
			},
			options
		);
		expect(painted.changedVertexCount).toBe(2);
		expect(getMeshSkinWeights(scene, { nodeId: mesh.id, vertexIndices: [0, 2], limit: 2 }).vertices).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ vertexIndex: 0, influences: expect.arrayContaining([expect.objectContaining({ boneName: "LeftArm", weight: 0.75 })]) }),
				expect.objectContaining({ vertexIndex: 2, influences: expect.arrayContaining([expect.objectContaining({ boneName: "LeftArm", weight: 0.75 })]) }),
			])
		);

		const optimized = optimizeMeshSkinWeights(
			scene,
			{
				nodeId: mesh.id,
				expectedFingerprint: painted.fingerprint,
				maxInfluences: 4,
				minimumWeight: 0.01,
			},
			options
		);
		expect(optimized.report).toMatchObject({ valid: true, maximumObservedInfluences: 4 });
		expect(mesh.numBoneInfluencers).toBe(4);
		expect(mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind)).toBeNull();

		const mirrored = mirrorMeshSkinWeights(
			scene,
			{
				nodeId: mesh.id,
				expectedFingerprint: optimized.fingerprint,
				axis: "x",
				direction: "negativeToPositive",
				tolerance: 0.001,
			},
			options
		);
		expect(mirrored.changedVertexCount).toBe(2);
		const left = getMeshSkinWeights(scene, { nodeId: mesh.id, vertexIndices: [0, 2], limit: 2 });
		const right = getMeshSkinWeights(scene, { nodeId: mesh.id, vertexIndices: [1, 3], limit: 2 });
		expect(right.vertices[0].influences.find((influence: any) => influence.boneName === "RightArm")?.weight).toBeCloseTo(
			left.vertices[0].influences.find((influence: any) => influence.boneName === "LeftArm")?.weight
		);
		expect(right.vertices[1].influences.find((influence: any) => influence.boneName === "RightArm")?.weight).toBeCloseTo(
			left.vertices[1].influences.find((influence: any) => influence.boneName === "LeftArm")?.weight
		);
	});

	test("supports spherical and topology-smooth painting and rejects invalid references", () => {
		const { mesh } = createSkinnedMesh();
		const initial = getMeshSkinWeights(scene, { nodeId: mesh.id });
		const spherical = paintMeshSkinWeights(
			scene,
			{
				nodeId: mesh.id,
				expectedFingerprint: initial.fingerprint,
				boneName: "LeftArm",
				center: [-1, 0, 0],
				radius: 1.1,
				mode: "add",
				weight: 1,
				opacity: 1,
				falloff: "linear",
			},
			options
		);
		expect(spherical.changedVertexCount).toBe(2);
		const afterSphere = getMeshSkinWeights(scene, { nodeId: mesh.id, vertexIndices: [0, 2], limit: 2 });
		expect(afterSphere.vertices[0].influences[0]).toMatchObject({ boneName: "LeftArm", weight: 1 });
		expect(afterSphere.vertices[1].influences).toEqual(expect.arrayContaining([expect.objectContaining({ boneName: "LeftArm" })]));

		const smoothed = paintMeshSkinWeights(
			scene,
			{
				nodeId: mesh.id,
				expectedFingerprint: spherical.fingerprint,
				boneName: "LeftArm",
				vertexIndices: [1],
				mode: "smooth",
				opacity: 1,
			},
			options
		);
		expect(smoothed.changedVertexCount).toBe(1);
		expect(getMeshSkinWeights(scene, { nodeId: mesh.id, vertexIndices: [1], limit: 1 }).vertices[0].influences).toEqual(
			expect.arrayContaining([expect.objectContaining({ boneName: "LeftArm", weight: expect.any(Number) })])
		);

		expect(() =>
			paintMeshSkinWeights(
				scene,
				{ nodeId: mesh.id, expectedFingerprint: smoothed.fingerprint, boneName: "Missing", vertexIndices: [0], mode: "replace", weight: 1 },
				options
			)
		).toThrow("was not found");
		expect(() =>
			setMeshSkinWeights(
				scene,
				{
					nodeId: mesh.id,
					expectedFingerprint: smoothed.fingerprint,
					vertices: [
						{ vertexIndex: 0, influences: [{ boneName: "Root", weight: 1 }] },
						{ vertexIndex: 0, influences: [{ boneName: "Root", weight: 1 }] },
					],
				},
				options
			)
		).toThrow("duplicated");
	});

	test("publishes main and extra skin buffers through binary geometry export metadata", async () => {
		const geometry = {
			matricesIndices: [0, 1, 2, 3, 4, 5, 0, 0],
			matricesWeights: [0.4, 0.3, 0.2, 0.1, 0.5, 0.5, 0, 0],
		};
		const mesh: any = { _binaryInfo: {} };
		const sourceMesh = {
			getVerticesData: (kind: string) =>
				kind === VertexBuffer.MatricesIndicesExtraKind
					? [4, 5, 0, 0, 1, 2, 3, 4]
					: kind === VertexBuffer.MatricesWeightsExtraKind
						? [0.05, 0.05, 0, 0, 0.4, 0.3, 0.2, 0.1]
						: null,
		};
		await writeBinaryGeometry({ path: "", geometry, mesh, sourceMesh, write: false });
		expect(mesh).toMatchObject({
			hasMatricesIndices: true,
			hasMatricesWeights: true,
			hasMatricesIndicesExtra: true,
			hasMatricesWeightsExtra: true,
			matricesIndices: null,
			matricesWeights: null,
			matricesIndicesExtra: null,
			matricesWeightsExtra: null,
			_binaryInfo: {
				matricesIndicesAttrDesc: { count: 2, stride: 1, offset: 0, dataType: 0 },
				matricesWeightsAttrDesc: { count: 8, stride: 2, offset: 8, dataType: 1 },
				matricesIndicesExtraAttrDesc: { count: 2, stride: 1, offset: 40, dataType: 0 },
				matricesWeightsExtraAttrDesc: { count: 8, stride: 2, offset: 48, dataType: 1 },
			},
		});
	});

	test("preserves skin buffers across same-count geometry edits and blocks stale topology changes", () => {
		const { mesh } = createSkinnedMesh();
		const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
		positions[1] = 0.25;
		setMeshVertexData(scene, { nodeId: mesh.id, positions, indices: Array.from(mesh.getIndices()!) }, options);
		expect(getMeshSkinWeights(scene, { nodeId: mesh.id, limit: 4 }).report).toMatchObject({ valid: true, vertexCount: 4 });
		expect(() =>
			setMeshVertexData(
				scene,
				{
					nodeId: mesh.id,
					positions: [...positions, 0, 0, 0],
					indices: [0, 1, 2],
				},
				options
			)
		).toThrow("must provide matching matricesIndices");
	});
});

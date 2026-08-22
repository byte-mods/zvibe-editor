import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, MeshBuilder, MorphTarget, MorphTargetManager, NullEngine, Scene, SubMesh, VertexBuffer } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import {
	bridgeMeshEdges,
	bevelMeshEdge,
	bevelMeshEdges,
	extrudeMeshFaces,
	getMeshSelection,
	getMeshTopology,
	getMeshVertexData,
	insetMeshFaces,
	setMeshSelection,
	setMeshVertexData,
	setMeshUVProjection,
	subdivideMesh,
} from "../../src/mcp/meshes/meshes";
import { getMeshUvLayout, setMeshUvSeams, unwrapMeshUVs } from "../../src/mcp/meshes/uv";
import { captureLoopCutMeshSnapshot, loopCutMesh, restoreLoopCutMeshSnapshot } from "../../src/mcp/meshes/loop-cut";
import { detachMeshFaces } from "../../src/mcp/meshes/detach";
import { autoSmoothMeshFaces, getMeshSmoothingGroups, setMeshSmoothingGroup } from "../../src/mcp/meshes/smoothing";
import { getMeshVertexColors, paintMeshVertexColors } from "../../src/mcp/meshes/vertex-colors";
import { captureMeshIntegritySnapshot, inspectMeshIntegrity, repairMeshIntegrity, restoreMeshIntegritySnapshot } from "../../src/mcp/meshes/integrity";

describe("mcp/mesh-subdivision", () => {
	let engine: NullEngine;
	let scene: Scene;
	let mesh: Mesh;
	const options = {
		editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() }, graph: { refresh: vi.fn().mockResolvedValue(undefined), setSelectedNode: vi.fn() } } },
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		mesh = MeshBuilder.CreatePlane("Quad", { size: 10 }, scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("splits shared edges once, preserves UVs, and quadruples each triangle per level", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		expect(original.indices).toHaveLength(6);

		const first = subdivideMesh(scene, { nodeId: mesh.id }, options);
		expect(first).toMatchObject({ levels: 1, triangleCount: 8 });
		expect(first.indices).toHaveLength(24);
		expect(first.positions).toHaveLength(27);
		expect(first.uvs).toHaveLength(18);

		const second = subdivideMesh(scene, { nodeId: mesh.id, levels: 2 }, options);
		expect(second.triangleCount).toBe(128);
		expect(second.indices).toHaveLength(384);
	});

	test("persists validated vertex, edge, and face component selection", () => {
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		expect(topology).toMatchObject({ vertexCount: 4, faceCount: 2 });
		expect(topology.edges).toHaveLength(5);
		expect(setMeshSelection(scene, { nodeId: mesh.id, mode: "vertex", indices: [3, 1, 3] }, options)).toMatchObject({ mode: "vertex", indices: [1, 3] });
		expect(setMeshSelection(scene, { nodeId: mesh.id, mode: "edge", indices: [0, 4] }, options)).toMatchObject({ mode: "edge", indices: [0, 4] });
		expect(setMeshSelection(scene, { nodeId: mesh.id, mode: "face", indices: [1] }, options)).toMatchObject({ mode: "face", indices: [1] });
		expect(getMeshSelection(scene, { nodeId: mesh.id })).toMatchObject({ mode: "face", indices: [1] });
		expect(() => setMeshSelection(scene, { nodeId: mesh.id, mode: "edge", indices: [5] }, options)).toThrow("edge selection indices");
	});

	test("extrudes and insets selected triangle faces", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const extruded = extrudeMeshFaces(scene, { nodeId: mesh.id, faceIndices: [0], distance: 1 }, options);
		expect(extruded).toMatchObject({ extrudedFaces: 1, addedVertices: 3 });
		expect(extruded.indices.length).toBeGreaterThan(original.indices.length);

		mesh.dispose();
		mesh = MeshBuilder.CreatePlane("Inset Quad", { size: 10 }, scene);
		const inset = insetMeshFaces(scene, { nodeId: mesh.id, faceIndices: [0], amount: 0.25 }, options);
		expect(inset).toMatchObject({ insetFaces: 1, addedVertices: 3 });
		expect(inset.indices).toHaveLength(24);
	});

	test("bridges two disjoint mesh edges", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const result = bridgeMeshEdges(scene, { nodeId: mesh.id, firstEdge: [0, 1], secondEdge: [2, 3] }, options);
		expect(result).toMatchObject({
			bridgedEdges: [
				[0, 1],
				[2, 3],
			],
			addedTriangles: 2,
		});
		expect(result.indices).toHaveLength(original.indices.length + 6);
		expect(() => bridgeMeshEdges(scene, { nodeId: mesh.id, firstEdge: [0, 1], secondEdge: [1, 2] }, options)).toThrow("must not share endpoints");
	});

	test("bevels one manifold edge into a chamfer quad", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const edgeIndex = getMeshTopology(scene, { nodeId: mesh.id }).edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 2);
		const result = bevelMeshEdge(scene, { nodeId: mesh.id, edgeIndex, amount: 0.2 }, options);
		expect(result).toMatchObject({ bevelAmount: 0.2, bevelSegments: 1, bevelModel: "segmented-adjacent-miter-v1", addedVertices: 4, addedTriangles: 4 });
		expect(result.indices).toHaveLength(original.indices.length + 12);
		expect(result.positions).toHaveLength(original.positions.length + 12);
		expect(() => bevelMeshEdge(scene, { nodeId: mesh.id, edgeIndex: 999, amount: 0.2 }, options)).toThrow("edge indices");
	});

	test("bevels multiple disjoint manifold edges from one topology snapshot", () => {
		mesh.dispose();
		mesh = MeshBuilder.CreateBox("Cube", { size: 10 }, scene);
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const manifold = topology.edges
			.map((edge: number[], index: number) => ({
				edge,
				index,
				faces: original.indices
					.filter((_, offset) => offset % 3 === 0)
					.filter((_, face) => original.indices.slice(face * 3, face * 3 + 3).includes(edge[0]) && original.indices.slice(face * 3, face * 3 + 3).includes(edge[1])),
			}))
			.filter((value: any) => value.faces.length === 2);
		const firstIndex = manifold[0].index;
		const first = topology.edges[firstIndex];
		const secondIndex = manifold.find((value: any) => value.index !== firstIndex && !value.edge.includes(first[0]) && !value.edge.includes(first[1]))!.index;
		const result = bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: [firstIndex, secondIndex], amount: 0.2 }, options);
		expect(result).toMatchObject({ bevelAmount: 0.2, bevelSegments: 1, connectedComponentCount: 2, adjacentEdgePairs: 0, addedVertices: 8, addedTriangles: 8 });
		expect(result.indices).toHaveLength(original.indices.length + 24);
	});

	test("atomically bevels adjacent manifold edges with a segmented rounded profile", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
				uvs: [1, 1, 0, 0, 0, 1, 1, 0],
				indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
			},
			options
		);
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const firstIndex = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 1);
		const secondIndex = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 2);
		const result = bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: [firstIndex, secondIndex], amount: 0.2, segments: 3 }, options);
		expect(result).toMatchObject({
			bevelAmount: 0.2,
			bevelSegments: 3,
			bevelModel: "segmented-adjacent-miter-v1",
			adjacentEdgePairs: 1,
			connectedComponentCount: 1,
		});
		expect(result.positions.length).toBeGreaterThan(original.positions.length);
		expect(result.indices.length).toBeGreaterThan(original.indices.length);
		const incidence = new Map<string, number>();
		for (let index = 0; index < result.indices.length; index += 3) {
			const triangle = result.indices.slice(index, index + 3);
			const first = result.positions.slice(triangle[0] * 3, triangle[0] * 3 + 3);
			const second = result.positions.slice(triangle[1] * 3, triangle[1] * 3 + 3);
			const third = result.positions.slice(triangle[2] * 3, triangle[2] * 3 + 3);
			const cross = [
				(second[1] - first[1]) * (third[2] - first[2]) - (second[2] - first[2]) * (third[1] - first[1]),
				(second[2] - first[2]) * (third[0] - first[0]) - (second[0] - first[0]) * (third[2] - first[2]),
				(second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]),
			];
			expect(cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).toBeGreaterThan(0.00000001);
			for (let corner = 0; corner < 3; corner++) {
				const edge = [triangle[corner], triangle[(corner + 1) % 3]].sort((a, b) => a - b);
				const key = `${edge[0]}:${edge[1]}`;
				incidence.set(key, (incidence.get(key) ?? 0) + 1);
			}
		}
		expect([...incidence.values()].every((count) => count === 2)).toBe(true);

		const beforeRejected = getMeshVertexData(scene, { nodeId: mesh.id });
		expect(() => bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: [0, 1], amount: 0.6, segments: 2 }, options)).toThrow("too large");
		expect(getMeshVertexData(scene, { nodeId: mesh.id })).toMatchObject({ positions: beforeRejected.positions, indices: beforeRejected.indices });
	});

	test("cuts an open logical quad strip with multiple evenly spaced loops", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0],
				uvs: [0, 0, 0.5, 0, 1, 0, 0, 1, 0.5, 1, 1, 1],
				indices: [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4],
			},
			options
		);
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const seed = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 3);
		const result = loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: seed, cuts: 2 }, options);
		expect(result).toMatchObject({
			loopCutModel: "logical-quad-strip-loop-cut-v1",
			cuts: 2,
			offset: 0,
			cutAmounts: [1 / 3, 2 / 3],
			stripClosed: false,
			stripQuadCount: 2,
			splitLogicalEdgeCount: 3,
			pairedQuadCount: 2,
			unpairedFaceCount: 0,
			addedVertices: 6,
			addedTriangles: 8,
			triangleCount: 12,
		});
		expect(result.loops).toHaveLength(2);
		expect(result.loops.every((loop: any) => loop.edgeIndices.length === 2)).toBe(true);
		expect(getMeshSelection(scene, { nodeId: mesh.id })).toMatchObject({ mode: "edge", indices: result.createdEdgeIndices });
		expect(result.topologyFingerprintAfter).not.toBe(topology.topologyFingerprint);
	});

	test("follows a closed quad ring across Babylon hard face seams", () => {
		mesh.dispose();
		mesh = MeshBuilder.CreateBox("Loop Cube", { size: 2 }, scene);
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const result = loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: 0, cuts: 1, offset: 0.25 }, options);
		expect(result).toMatchObject({
			loopCutModel: "logical-quad-strip-loop-cut-v1",
			cuts: 1,
			offset: 0.25,
			cutAmounts: [0.625],
			stripClosed: true,
			stripQuadCount: 4,
			splitLogicalEdgeCount: 4,
			pairedQuadCount: 6,
			unpairedFaceCount: 0,
			addedTriangles: 8,
		});
		expect(result.addedVertices).toBe(8);
		expect(result.loops[0].edgeIndices).toHaveLength(4);
	});

	test("preserves hard UV seams, arbitrary streams, normalized skinning, and material ranges", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0],
				uvs: [0, 0, 0.5, 0, 0.5, 1, 0, 1, 0.8, 0, 1, 0, 1, 1, 0.8, 1],
				indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
			},
			options
		);
		const vertexCount = 8;
		mesh.setVerticesData(VertexBuffer.ColorKind, Array.from({ length: vertexCount }, (_, index) => [index / 8, index / 16, index / 32, 1]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.TangentKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 1]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.UV2Kind, Array.from({ length: vertexCount }, (_, index) => [index / 8, 1 - index / 8]).flat(), true, 2);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, (_, index) => [index < 4 ? 0 : 1, 0, 0, 0]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 0]).flat(), true, 4);
		mesh.releaseSubMeshes(true);
		new SubMesh(3, 0, vertexCount, 0, 6, mesh, mesh, false, true);
		new SubMesh(7, 0, vertexCount, 6, 6, mesh, mesh, false, true);
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const seed = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 3);
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const result = loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: seed, cuts: 1 }, options);
		expect(result).toMatchObject({ stripQuadCount: 2, addedVertices: 4, addedTriangles: 4 });
		expect(result.preservedVertexStreams).toEqual(
			expect.arrayContaining([
				{ kind: VertexBuffer.ColorKind, stride: 4 },
				{ kind: VertexBuffer.TangentKind, stride: 4 },
				{ kind: VertexBuffer.UV2Kind, stride: 2 },
				{ kind: VertexBuffer.MatricesIndicesKind, stride: 4 },
				{ kind: VertexBuffer.MatricesWeightsKind, stride: 4 },
			])
		);
		expect(mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexStart: subMesh.indexStart, indexCount: subMesh.indexCount }))).toEqual([
			{ materialIndex: 3, indexStart: 0, indexCount: 12 },
			{ materialIndex: 7, indexStart: 12, indexCount: 12 },
		]);
		const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
		const uvs = Array.from(mesh.getVerticesData(VertexBuffer.UVKind, false) ?? []);
		const weights = Array.from(mesh.getVerticesData(VertexBuffer.MatricesWeightsKind, false) ?? []);
		const shared = Array.from({ length: positions.length / 3 }, (_, index) => index).filter(
			(index) => Math.abs(positions[index * 3] - 1) < 0.000001 && Math.abs(positions[index * 3 + 1] - 0.5) < 0.000001
		);
		expect(shared).toHaveLength(2);
		expect(new Set(shared.map((index) => uvs[index * 2].toFixed(3)))).toEqual(new Set(["0.500", "0.800"]));
		for (let vertex = 8; vertex < positions.length / 3; vertex++) {
			expect(weights.slice(vertex * 4, vertex * 4 + 4).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
		}
		const after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(after);
	});

	test("rejects stale, diagonal, and morph-target loop cuts atomically", () => {
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const original = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: "stale", edgeIndex: 0 }, options)).toThrow("stale");
		const diagonal = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 2);
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: diagonal }, options)).toThrow(
			"not a reconstructed quad boundary"
		);
		const manager = new MorphTargetManager(scene);
		const target = new MorphTarget("Loop Morph", 0, scene);
		target.setPositions(original.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values);
		manager.addTarget(target);
		mesh.morphTargetManager = manager;
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: 0 }, options)).toThrow("morph targets");
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(original);
	});

	test("rejects branched logical quad strips before changing geometry", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, -1, 0, 0, -1, 1, 0, 0, 1, 0],
				uvs: Array.from({ length: 12 }, (_, index) => [index % 4 === 1 || index % 4 === 2 ? 1 : 0, index % 4 >= 2 ? 1 : 0]).flat(),
				indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11],
			},
			options
		);
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const seed = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 3);
		const original = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: seed }, options)).toThrow(
			"branches into more than two quads"
		);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(original);
	});

	test("rejects incomplete skin streams and out-of-range cut controls atomically", () => {
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const boundary = topology.edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 1);
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: boundary, cuts: 9 }, options)).toThrow(
			"integer from 1 to 8"
		);
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: boundary, offset: 0.5 }, options)).toThrow(
			"between -0.49 and 0.49"
		);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: 4 }, () => [0, 0, 0, 0]).flat(), true, 4);
		const incomplete = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(() => loopCutMesh(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, edgeIndex: boundary }, options)).toThrow(
			"matching four-component skin"
		);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(incomplete);
	});

	test("detaches selected faces into an independent in-object submesh with full streams", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const vertexCount = original.positions.length / 3;
		mesh.setVerticesData(VertexBuffer.ColorKind, Array.from({ length: vertexCount }, (_, index) => [index / 4, index / 8, index / 16, 1]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.TangentKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 1]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.UV2Kind, Array.from({ length: vertexCount }, (_, index) => [index / 4, 1 - index / 4]).flat(), true, 2);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, (_, index) => [index, 0, 0, 0]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 0]).flat(), true, 4);
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const result = detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, faceIndices: [0], mode: "submesh" }, options);
		expect(result).toMatchObject({
			detachModel: "stream-preserving-face-detach-v1",
			mode: "submesh",
			detachedMesh: null,
			detachedFaceCount: 1,
			remainingFaceCount: 1,
			sourceVertexCount: 6,
			detachedVertexCount: 3,
			detachedSubMeshCount: 1,
		});
		expect(result.preservedVertexStreams).toEqual(
			expect.arrayContaining([
				{ kind: VertexBuffer.ColorKind, stride: 4 },
				{ kind: VertexBuffer.TangentKind, stride: 4 },
				{ kind: VertexBuffer.UV2Kind, stride: 2 },
				{ kind: VertexBuffer.MatricesIndicesKind, stride: 4 },
				{ kind: VertexBuffer.MatricesWeightsKind, stride: 4 },
			])
		);
		expect(mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexStart: subMesh.indexStart, indexCount: subMesh.indexCount }))).toEqual([
			{ materialIndex: 0, indexStart: 0, indexCount: 3 },
			{ materialIndex: 0, indexStart: 3, indexCount: 3 },
		]);
		expect(getMeshSelection(scene, { nodeId: mesh.id })).toMatchObject({ mode: "face", indices: [1] });
		const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
		const detachedPositions = positions.slice(9);
		for (const position of Array.from({ length: 3 }, (_, index) => detachedPositions.slice(index * 3, index * 3 + 3))) {
			expect(original.positions).toEqual(expect.arrayContaining(position));
		}
	});

	test("detaches faces to a transform-preserving Game Object and restores its stable id on redo", () => {
		mesh.dispose();
		mesh = MeshBuilder.CreateBox("Detach Cube", { size: 2 }, scene);
		mesh.position.set(3, 4, 5);
		mesh.rotation.set(0.1, 0.2, 0.3);
		mesh.scaling.set(2, 3, 4);
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const first = detachMeshFaces(
			scene,
			{ nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, faceIndices: [0, 1], mode: "gameObject", name: "Detached Side" },
			options
		);
		expect(first).toMatchObject({
			detachModel: "stream-preserving-face-detach-v1",
			mode: "gameObject",
			detachedFaceCount: 2,
			remainingFaceCount: 10,
			sourceVertexCount: 20,
			detachedVertexCount: 4,
		});
		const detachedId = first.detachedMesh.id;
		let detached = scene.getMeshById(detachedId)!;
		expect(detached.name).toBe("Detached Side");
		expect(detached.position.asArray()).toEqual(mesh.position.asArray());
		expect(detached.rotation.asArray()).toEqual(mesh.rotation.asArray());
		expect(detached.scaling.asArray()).toEqual(mesh.scaling.asArray());
		expect(getMeshVertexData(scene, { nodeId: detached.id })).toMatchObject({ indices: expect.any(Array) });
		expect(getMeshVertexData(scene, { nodeId: detached.id }).indices).toHaveLength(6);

		detached.dispose(false, false);
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options);
		const restoredTopology = getMeshTopology(scene, { nodeId: mesh.id });
		const second = detachMeshFaces(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: restoredTopology.topologyFingerprint,
				faceIndices: [0, 1],
				mode: "gameObject",
				name: "Detached Side",
				detachedId,
			},
			options
		);
		expect(second.detachedMesh.id).toBe(detachedId);
		detached = scene.getMeshById(detachedId)!;
		expect(detached.metadata).toMatchObject({ detachedFromNodeId: mesh.id, detachModel: "stream-preserving-face-detach-v1" });
	});

	test("preserves multiple source material ranges in both detached object halves", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0],
				uvs: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1],
				indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
			},
			options
		);
		mesh.releaseSubMeshes(true);
		new SubMesh(2, 0, 8, 0, 6, mesh, mesh, false, true);
		new SubMesh(5, 0, 8, 6, 6, mesh, mesh, false, true);
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const result = detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, faceIndices: [0, 2], mode: "gameObject" }, options);
		const detached = scene.getMeshById(result.detachedMesh.id)!;
		expect(mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexCount: subMesh.indexCount }))).toEqual([
			{ materialIndex: 2, indexCount: 3 },
			{ materialIndex: 5, indexCount: 3 },
		]);
		expect(detached.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexCount: subMesh.indexCount }))).toEqual([
			{ materialIndex: 2, indexCount: 3 },
			{ materialIndex: 5, indexCount: 3 },
		]);
	});

	test("preserves authored smoothing groups in both detached object halves", () => {
		mesh.dispose();
		mesh = MeshBuilder.CreateBox("Smoothed Detach Cube", { size: 2 }, scene);
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id });
		const authored = setMeshSmoothingGroup(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedRevision: 0,
				faceIndices: Array.from({ length: 12 }, (_, index) => index),
				group: 4,
			},
			options
		);
		const result = detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: authored.topologyFingerprint, faceIndices: [0, 1], mode: "gameObject" }, options);
		const sourceGroups = getMeshSmoothingGroups(scene, { nodeId: mesh.id, offset: 0, limit: 20 });
		const detachedGroups = getMeshSmoothingGroups(scene, { nodeId: result.detachedMesh.id, offset: 0, limit: 20 });
		expect(sourceGroups).toMatchObject({ revision: 1, faceCount: 10, hardFaceCount: 0, smoothFaceCount: 10, derivedFromCurrentNormals: false });
		expect(detachedGroups).toMatchObject({ revision: 1, faceCount: 2, hardFaceCount: 0, smoothFaceCount: 2, derivedFromCurrentNormals: false });
		expect(sourceGroups.faces.every((face: any) => face.group === 4)).toBe(true);
		expect(detachedGroups.faces.every((face: any) => face.group === 4)).toBe(true);
	});

	test("rejects stale, complete-selection, named-submesh, and morph-target detach atomically", () => {
		const topology = getMeshTopology(scene, { nodeId: mesh.id });
		const original = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(() => detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: "stale", faceIndices: [0], mode: "submesh" }, options)).toThrow("stale");
		expect(() => detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, faceIndices: [0, 1], mode: "submesh" }, options)).toThrow(
			"at least one unselected"
		);
		expect(() =>
			detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, faceIndices: [0], mode: "submesh", name: "Invalid" }, options)
		).toThrow("cannot be assigned");
		const manager = new MorphTargetManager(scene);
		const target = new MorphTarget("Detach Morph", 0, scene);
		target.setPositions(original.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values);
		manager.addTarget(target);
		mesh.morphTargetManager = manager;
		expect(() => detachMeshFaces(scene, { nodeId: mesh.id, expectedTopologyFingerprint: topology.topologyFingerprint, faceIndices: [0], mode: "gameObject" }, options)).toThrow(
			"morph targets"
		);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(original);
	});

	test("derives current smooth shading and round-trips one hard face through exact revisions", () => {
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id, offset: 0, limit: 10 });
		expect(initial).toMatchObject({
			model: "coincident-face-smoothing-groups-v1",
			revision: 0,
			derivedFromCurrentNormals: true,
			faceCount: 2,
			hardFaceCount: 0,
			smoothFaceCount: 2,
		});
		expect(initial.faces.map((face: any) => face.group)).toEqual([1, 1]);

		const hardened = setMeshSmoothingGroup(
			scene,
			{ nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0], group: 0 },
			options
		);
		expect(hardened).toMatchObject({ revision: 1, assignedGroup: 0, hardFaceCount: 1, smoothFaceCount: 1, changedFaceIndices: [0] });
		expect(getMeshTopology(scene, { nodeId: mesh.id }).vertexCount).toBe(6);

		const resmoothed = setMeshSmoothingGroup(
			scene,
			{ nodeId: mesh.id, expectedTopologyFingerprint: hardened.topologyFingerprint, expectedRevision: 1, faceIndices: [0], group: 1 },
			options
		);
		expect(resmoothed).toMatchObject({ revision: 2, assignedGroup: 1, hardFaceCount: 0, smoothFaceCount: 2 });
		expect(getMeshTopology(scene, { nodeId: mesh.id }).vertexCount).toBe(4);
	});

	test("averages normals across coincident hard seams without merging UV records", () => {
		mesh.dispose();
		mesh = MeshBuilder.CreateBox("Smooth Cube", { size: 2 }, scene);
		const originalPositions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
		const originalUvs = Array.from(mesh.getVerticesData(VertexBuffer.UVKind, false) ?? []);
		const originalCornerUvCount = new Set(
			Array.from({ length: originalPositions.length / 3 }, (_, vertex) => vertex)
				.filter((vertex) => originalPositions[vertex * 3] === 1 && originalPositions[vertex * 3 + 1] === 1 && originalPositions[vertex * 3 + 2] === 1)
				.map((vertex) => `${originalUvs[vertex * 2]},${originalUvs[vertex * 2 + 1]}`)
		).size;
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id, offset: 0, limit: 24 });
		const result = setMeshSmoothingGroup(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedRevision: initial.revision,
				faceIndices: Array.from({ length: 12 }, (_, index) => index),
				group: 1,
			},
			options
		);
		expect(result).toMatchObject({ revision: 1, hardFaceCount: 0, smoothFaceCount: 12, assignedGroup: 1 });
		expect(getMeshTopology(scene, { nodeId: mesh.id }).vertexCount).toBeLessThanOrEqual(24);
		const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
		const normals = Array.from(mesh.getVerticesData(VertexBuffer.NormalKind, false) ?? []);
		const cornerVertices = Array.from({ length: positions.length / 3 }, (_, vertex) => vertex).filter(
			(vertex) => positions[vertex * 3] === 1 && positions[vertex * 3 + 1] === 1 && positions[vertex * 3 + 2] === 1
		);
		expect(cornerVertices).toHaveLength(originalCornerUvCount);
		const cornerNormals = cornerVertices.map((vertex) => normals.slice(vertex * 3, vertex * 3 + 3));
		for (const normal of cornerNormals) {
			expect(Math.abs(normal[0])).toBeCloseTo(1 / Math.sqrt(3), 6);
			expect(Math.abs(normal[1])).toBeCloseTo(1 / Math.sqrt(3), 6);
			expect(Math.abs(normal[2])).toBeCloseTo(1 / Math.sqrt(3), 6);
		}
	});

	test("auto-smooths selected faces into deterministic angle-connected groups", () => {
		mesh.dispose();
		mesh = MeshBuilder.CreateBox("Auto Smooth Cube", { size: 2 }, scene);
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id });
		const faces = Array.from({ length: 12 }, (_, index) => index);
		const sharp = autoSmoothMeshFaces(
			scene,
			{ nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: faces, angleThreshold: 1 },
			options
		);
		expect(sharp).toMatchObject({ revision: 1, angleThreshold: 1, componentCount: 6, hardFaceCount: 0, smoothFaceCount: 12 });
		expect(sharp.assignments).toHaveLength(6);
		expect(sharp.assignments.every((assignment: any) => assignment.faceIndices.length === 2)).toBe(true);

		const round = autoSmoothMeshFaces(
			scene,
			{ nodeId: mesh.id, expectedTopologyFingerprint: sharp.topologyFingerprint, expectedRevision: 1, faceIndices: faces, angleThreshold: 180 },
			options
		);
		expect(round).toMatchObject({ revision: 2, angleThreshold: 180, componentCount: 1, hardFaceCount: 0, smoothFaceCount: 12 });
		expect(round.assignments).toEqual([{ group: 1, faceIndices: faces }]);
	});

	test("restores smoothing topology, metadata, streams, and selection exactly for Undo and Redo", () => {
		setMeshSelection(scene, { nodeId: mesh.id, mode: "face", indices: [0] }, options);
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id });
		setMeshSmoothingGroup(scene, { nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0], group: 0 }, options);
		const after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(after).not.toEqual(before);
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(after);
		expect(getMeshSmoothingGroups(scene, { nodeId: mesh.id, group: 0, offset: 0, limit: 10 })).toMatchObject({ revision: 1, total: 1, returned: 1 });
	});

	test("preserves arbitrary streams, UV layout, material ranges, and orthonormal tangents", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
				normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
				uvs: [0, 0, 1, 0, 1, 1, 0, 1],
				indices: [0, 1, 2, 0, 2, 3],
			},
			options
		);
		mesh.setVerticesData(VertexBuffer.ColorKind, [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1], true, 4);
		mesh.setVerticesData(VertexBuffer.UV2Kind, [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5], true, 2);
		mesh.setVerticesData(VertexBuffer.TangentKind, [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1], true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, [0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0], true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], true, 4);
		mesh.metadata ??= {};
		mesh.metadata.babylonEditorUvLayout = { version: 1, revision: 7, logicalTopologyFingerprint: "logical", seamKeys: [], lastUnwrap: null };
		mesh.releaseSubMeshes(true);
		new SubMesh(3, 0, 4, 0, 3, mesh, mesh, false, true);
		new SubMesh(7, 0, 4, 3, 3, mesh, mesh, false, true);
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id });
		setMeshSmoothingGroup(scene, { nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0, 1], group: 1 }, options);
		const after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		for (const kind of [
			VertexBuffer.PositionKind,
			VertexBuffer.UVKind,
			VertexBuffer.UV2Kind,
			VertexBuffer.ColorKind,
			VertexBuffer.MatricesIndicesKind,
			VertexBuffer.MatricesWeightsKind,
		]) {
			expect(after.streams.find((stream) => stream.kind === kind)?.values).toEqual(before.streams.find((stream) => stream.kind === kind)?.values);
		}
		expect(after.uvLayout).toEqual(before.uvLayout);
		expect(after.subMeshes).toEqual(before.subMeshes);
		const normals = after.streams.find((stream) => stream.kind === VertexBuffer.NormalKind)!.values;
		const tangents = after.streams.find((stream) => stream.kind === VertexBuffer.TangentKind)!.values;
		for (let vertex = 0; vertex < normals.length / 3; vertex++) {
			const dot = normals[vertex * 3] * tangents[vertex * 4] + normals[vertex * 3 + 1] * tangents[vertex * 4 + 1] + normals[vertex * 3 + 2] * tangents[vertex * 4 + 2];
			expect(dot).toBeCloseTo(0, 7);
		}
	});

	test("rejects stale, duplicate, invalid, and morph-target smoothing atomically", () => {
		const initial = getMeshSmoothingGroups(scene, { nodeId: mesh.id });
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(() => setMeshSmoothingGroup(scene, { nodeId: mesh.id, expectedTopologyFingerprint: "stale", expectedRevision: 0, faceIndices: [0], group: 1 }, options)).toThrow(
			"topology is stale"
		);
		expect(() =>
			setMeshSmoothingGroup(scene, { nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0, 0], group: 1 }, options)
		).toThrow("unique");
		expect(() =>
			setMeshSmoothingGroup(scene, { nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 1, faceIndices: [0], group: 1 }, options)
		).toThrow("revision");
		expect(() =>
			autoSmoothMeshFaces(
				scene,
				{ nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0], angleThreshold: 181 },
				options
			)
		).toThrow("between 0 and 180");
		const manager = new MorphTargetManager(scene);
		const target = new MorphTarget("Smooth Morph", 0, scene);
		target.setPositions(before.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values);
		manager.addTarget(target);
		mesh.morphTargetManager = manager;
		expect(() =>
			setMeshSmoothingGroup(scene, { nodeId: mesh.id, expectedTopologyFingerprint: initial.topologyFingerprint, expectedRevision: 0, faceIndices: [0], group: 1 }, options)
		).toThrow("morph targets");
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
	});

	test("projects planar UVs from local mesh positions", () => {
		const result = setMeshUVProjection(scene, { nodeId: mesh.id, plane: "xz", scale: 10 }, options);
		expect(result.projection).toEqual({ plane: "xz", scale: 10, offset: [0, 0] });
		expect(result.uvs).toHaveLength(8);
		expect(new Set(result.uvs)).toEqual(new Set([-0.5, 0, 0.5]));
		expect(() => setMeshUVProjection(scene, { nodeId: mesh.id, scale: 0 }, options)).toThrow("scale must be greater");
	});

	test("authors persistent UV seams and harmonically relaxes packed charts", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const initial = getMeshUvLayout(scene, { nodeId: mesh.id });
		expect(initial).toMatchObject({ revision: 0, chartCount: 1, seamCount: 0, derivedFromCurrentUvs: true });
		const sharedEdgeIndex = getMeshTopology(scene, { nodeId: mesh.id }).edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 2);
		const seamed = setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 0, mode: "replace", edgeIndices: [sharedEdgeIndex] }, options);
		expect(seamed).toMatchObject({ revision: 1, chartCount: 2, seamCount: 1, derivedFromCurrentUvs: false });
		expect(() => setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 0, mode: "remove", edgeIndices: [sharedEdgeIndex] }, options)).toThrow("stale");

		const result = unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 1, padding: 0.05, relaxIterations: 12, relaxStrength: 0.6, allowRotation: true }, options);
		expect(result.unwrap).toMatchObject({
			model: "logical-seam-harmonic-relax-pack-v1",
			chartCount: 2,
			padding: 0.05,
			relaxIterations: 12,
			relaxStrength: 0.6,
			allowRotation: true,
			normalizeTexelDensity: true,
		});
		expect(result.positions).toHaveLength(18);
		expect(result.indices).toEqual([0, 1, 2, 3, 4, 5]);
		expect(result.uvs).toHaveLength(12);
		expect(result.duplicatedVertices).toBe(2);
		expect(Math.min(...result.uvs)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...result.uvs)).toBeLessThanOrEqual(1.000001);
		const layout = getMeshUvLayout(scene, { nodeId: mesh.id, offset: 0, limit: 10 });
		expect(layout).toMatchObject({ revision: 2, chartCount: 2, seamCount: 1, model: "logical-seam-harmonic-relax-pack-v1" });
		expect(layout.lastUnwrap.atlasUtilization).toBeGreaterThan(0);
		for (const chart of layout.lastUnwrap.charts) {
			expect(chart.uvBounds.min[0]).toBeGreaterThanOrEqual(0.049999);
			expect(chart.uvBounds.min[1]).toBeGreaterThanOrEqual(0.049999);
			expect(chart.uvBounds.max[0]).toBeLessThanOrEqual(0.950001);
			expect(chart.uvBounds.max[1]).toBeLessThanOrEqual(0.950001);
		}
		const [firstChart, secondChart] = layout.lastUnwrap.charts;
		const horizontalGap = Math.max(secondChart.uvBounds.min[0] - firstChart.uvBounds.max[0], firstChart.uvBounds.min[0] - secondChart.uvBounds.max[0]);
		const verticalGap = Math.max(secondChart.uvBounds.min[1] - firstChart.uvBounds.max[1], firstChart.uvBounds.min[1] - secondChart.uvBounds.max[1]);
		expect(Math.max(horizontalGap, verticalGap)).toBeGreaterThanOrEqual(0.099999);
		expect(() => unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 1 }, options)).toThrow("stale");
		expect(() => unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 2, padding: 0.5 }, options)).toThrow("padding");
		expect(original.positions).toHaveLength(12);
	});

	test("supports exact seam lifecycle, bounded chart paging, and serializable persistence", () => {
		const edgeIndex = getMeshTopology(scene, { nodeId: mesh.id }).edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 2);
		const added = setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 0, mode: "add", edgeIndices: [edgeIndex] }, options);
		expect(added).toMatchObject({ revision: 1, seamCount: 1, chartCount: 2 });
		const firstPage = getMeshUvLayout(scene, { nodeId: mesh.id, offset: 0, limit: 1 });
		expect(firstPage).toMatchObject({ charts: [expect.objectContaining({ seamEdgeCount: 1 })], page: { offset: 0, limit: 1, total: 2, hasMore: true } });
		const secondPage = getMeshUvLayout(scene, { nodeId: mesh.id, offset: 1, limit: 1 });
		expect(secondPage).toMatchObject({ charts: [expect.objectContaining({ id: 1, seamEdgeCount: 1 })], page: { offset: 1, limit: 1, total: 2, hasMore: false } });
		const removed = setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 1, mode: "remove", edgeIndices: [edgeIndex] }, options);
		expect(removed).toMatchObject({ revision: 2, seamCount: 0, chartCount: 1 });
		const replaced = setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 2, mode: "replace", edgeIndices: [edgeIndex] }, options);
		expect(replaced).toMatchObject({ revision: 3, seamCount: 1, chartCount: 2 });
		expect(() => setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 3, mode: "invalid", edgeIndices: [] }, options)).toThrow("mode");
		expect(getMeshUvLayout(scene, { nodeId: mesh.id }).revision).toBe(3);
		expect(JSON.parse(JSON.stringify(mesh.metadata.babylonEditorUvLayout))).toMatchObject({ version: 1, revision: 3, seamKeys: expect.any(Array) });
	});

	test("derives logical seams from existing UV discontinuities", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0],
				uvs: [0, 0, 1, 0, 1, 1, 0.2, 0, 0.8, 1, 0, 1],
				indices: [0, 1, 2, 3, 4, 5],
			},
			options
		);
		const layout = getMeshUvLayout(scene, { nodeId: mesh.id });
		expect(layout).toMatchObject({ revision: 0, derivedFromCurrentUvs: true, seamCount: 1, chartCount: 2 });
		expect(layout.seamEdgeIndices).toHaveLength(2);
	});

	test("preserves skinning, tangents, colors, UV2, and submesh ranges while splitting UV vertices", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const vertexCount = original.positions.length / 3;
		const colors = Array.from({ length: vertexCount }, (_, index) => [index / 10, index / 20, index / 30, 1]).flat();
		const tangents = Array.from({ length: vertexCount }, (_, index) => [index, index + 0.1, index + 0.2, 1]).flat();
		const uv2 = Array.from({ length: vertexCount }, (_, index) => [index / 4, 1 - index / 4]).flat();
		const matrixIndices = Array.from({ length: vertexCount }, (_, index) => [index, 0, 0, 0]).flat();
		const matrixWeights = Array.from({ length: vertexCount }, () => [1, 0, 0, 0]).flat();
		mesh.setVerticesData(VertexBuffer.ColorKind, colors, true, 4);
		mesh.setVerticesData(VertexBuffer.TangentKind, tangents, true, 4);
		mesh.setVerticesData(VertexBuffer.UV2Kind, uv2, true, 2);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, matrixIndices, true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, matrixWeights, true, 4);
		const originalSubMeshes = mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexStart: subMesh.indexStart, indexCount: subMesh.indexCount }));
		const edgeIndex = getMeshTopology(scene, { nodeId: mesh.id }).edges.findIndex((edge: number[]) => edge[0] === 0 && edge[1] === 2);
		setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 0, mode: "replace", edgeIndices: [edgeIndex] }, options);
		const result = unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 1, padding: 0.02 }, options);
		expect(result.preservedVertexStreams).toEqual(
			expect.arrayContaining([
				{ kind: VertexBuffer.ColorKind, stride: 4 },
				{ kind: VertexBuffer.TangentKind, stride: 4 },
				{ kind: VertexBuffer.UV2Kind, stride: 2 },
			])
		);
		const sourceByPosition = new Map(Array.from({ length: vertexCount }, (_, index) => [original.positions.slice(index * 3, index * 3 + 3).join(","), index]));
		for (const [kind, sourceValues, stride] of [
			[VertexBuffer.ColorKind, colors, 4],
			[VertexBuffer.TangentKind, tangents, 4],
			[VertexBuffer.UV2Kind, uv2, 2],
			[VertexBuffer.MatricesIndicesKind, matrixIndices, 4],
			[VertexBuffer.MatricesWeightsKind, matrixWeights, 4],
		] as Array<[string, number[], number]>) {
			const outputValues = Array.from(mesh.getVerticesData(kind, false) ?? []);
			for (let output = 0; output < result.positions.length / 3; output++) {
				const source = sourceByPosition.get(result.positions.slice(output * 3, output * 3 + 3).join(","))!;
				for (let component = 0; component < stride; component++) {
					expect(outputValues[output * stride + component]).toBeCloseTo(sourceValues[source * stride + component], 6);
				}
			}
		}
		expect(mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexStart: subMesh.indexStart, indexCount: subMesh.indexCount }))).toEqual(
			originalSubMeshes
		);
	});

	test("rejects morph-target topology changes atomically", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const manager = new MorphTargetManager(scene);
		const target = new MorphTarget("Smile", 0, scene);
		target.setPositions(original.positions);
		manager.addTarget(target);
		mesh.morphTargetManager = manager;
		expect(() => unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 0 }, options)).toThrow("morph targets");
		expect(getMeshVertexData(scene, { nodeId: mesh.id })).toMatchObject({ positions: original.positions, indices: original.indices, uvs: original.uvs });
		expect(mesh.metadata?.babylonEditorUvLayout).toBeUndefined();
	});

	test("opens a closed mesh with deterministic auto seams before chart relaxation", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
				uvs: [1, 1, 0, 0, 0, 1, 1, 0],
				indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
			},
			options
		);
		const result = unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 0, padding: 0.02, relaxIterations: 20, autoSeams: true }, options);
		expect(result.unwrap).toMatchObject({ model: "logical-seam-harmonic-relax-pack-v1", chartCount: 1, autoSeams: true, autoSeamCount: 3 });
		expect(result.uvLayout.seamCount).toBe(3);
		expect(result.positions.length).toBeGreaterThan(12);
		expect(Math.min(...result.uvs)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...result.uvs)).toBeLessThanOrEqual(1.000001);
	});

	test("completes a partial authored seam into a valid closed-chart opening", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
				uvs: [1, 1, 0, 0, 0, 1, 1, 0],
				indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
			},
			options
		);
		setMeshUvSeams(scene, { nodeId: mesh.id, expectedRevision: 0, mode: "replace", edgeIndices: [0] }, options);
		const result = unwrapMeshUVs(scene, { nodeId: mesh.id, expectedRevision: 1, padding: 0.02, autoSeams: true }, options);
		expect(result.unwrap).toMatchObject({ chartCount: 1, autoSeamCount: 2 });
		expect(result.uvLayout).toMatchObject({ revision: 2, seamCount: 3 });
		expect(Math.min(...result.uvs)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...result.uvs)).toBeLessThanOrEqual(1.000001);
	});

	test("inspects derived white vertex colors with exact leases, paging, and component-selection filtering", () => {
		setMeshSelection(scene, { nodeId: mesh.id, mode: "vertex", indices: [3, 1] }, options);
		const initial = getMeshVertexColors(scene, { nodeId: mesh.id, offset: 0, limit: 2 });
		expect(initial).toMatchObject({
			model: "selection-vertex-color-rgba-v1",
			revision: 0,
			metadataCurrent: false,
			metadataStale: false,
			derivedDefaultWhite: true,
			hasColorStream: false,
			colorStride: 4,
			vertexCount: 4,
			faceCount: 2,
			paintedVertexCount: 0,
			uniqueColorCount: 1,
			selectedVertexCount: 2,
			offset: 0,
			limit: 2,
			total: 4,
			returned: 2,
			hasMore: true,
		});
		expect(initial.vertices.map((entry: any) => entry.color)).toEqual([
			[1, 1, 1, 1],
			[1, 1, 1, 1],
		]);
		const selected = getMeshVertexColors(scene, { nodeId: mesh.id, selectedOnly: true, offset: 0, limit: 10 });
		expect(selected).toMatchObject({ total: 2, returned: 2 });
		expect(selected.vertices.map((entry: any) => entry.vertexIndex)).toEqual([1, 3]);
		expect(selected.vertices.every((entry: any) => entry.selected)).toBe(true);
		expect(initial.topologyFingerprint).toMatch(/^mesh-topology-fnv32x2-v1:/);
		expect(initial.colorFingerprint).toMatch(/^vertex-colors-fnv32x2-v1:/);
	});

	test("paints exact raw vertices with RGBA, alpha flags, revisions, and neutral unselected values", () => {
		const initial = getMeshVertexColors(scene, { nodeId: mesh.id });
		const result = paintMeshVertexColors(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "vertex",
				vertexIndices: [0, 2],
				color: [1, 0.25, 0, 0.5],
				blendMode: "replace",
				opacity: 1,
			},
			options
		);
		expect(result).toMatchObject({
			revision: 1,
			metadataCurrent: true,
			derivedDefaultWhite: false,
			hasColorStream: true,
			colorStride: 4,
			useVertexColors: true,
			hasVertexAlpha: true,
			paintedVertexCount: 2,
			vertexCountBefore: 4,
			vertexCountAfter: 4,
			targetIndices: [0, 2],
			paintedVertexIndices: [0, 2],
			operation: { targetMode: "vertex", targetCount: 2, affectedVertexCount: 2, splitVertexCount: 0, blendMode: "replace", opacity: 1 },
		});
		const colors = Array.from(mesh.getVerticesData(VertexBuffer.ColorKind, false) ?? []);
		expect(colors).toEqual([1, 0.25, 0, 0.5, 1, 1, 1, 1, 1, 0.25, 0, 0.5, 1, 1, 1, 1]);
		expect(mesh.useVertexColors).toBe(true);
		expect(mesh.hasVertexAlpha).toBe(true);
		expect(getMeshSelection(scene, { nodeId: mesh.id })).toMatchObject({ mode: "vertex", indices: [0, 2] });
	});

	test("applies bounded add and multiply blends through opacity without changing topology", () => {
		let state = getMeshVertexColors(scene, { nodeId: mesh.id });
		paintMeshVertexColors(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: state.topologyFingerprint,
				expectedColorFingerprint: state.colorFingerprint,
				expectedRevision: state.revision,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [0.2, 0.4, 0.6, 0.8],
			},
			options
		);
		state = getMeshVertexColors(scene, { nodeId: mesh.id });
		const added = paintMeshVertexColors(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: state.topologyFingerprint,
				expectedColorFingerprint: state.colorFingerprint,
				expectedRevision: state.revision,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [0.3, 0.5, 1, 0],
				blendMode: "add",
				opacity: 0.5,
			},
			options
		);
		[0.35, 0.65, 0.8, 0.8].forEach((value, channel) => expect(added.vertices[0].color[channel]).toBeCloseTo(value, 6));
		state = getMeshVertexColors(scene, { nodeId: mesh.id });
		const multiplied = paintMeshVertexColors(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: state.topologyFingerprint,
				expectedColorFingerprint: state.colorFingerprint,
				expectedRevision: state.revision,
				targetMode: "vertex",
				vertexIndices: [0],
				color: [0.5, 0.5, 0.5, 1],
				blendMode: "multiply",
				opacity: 1,
			},
			options
		);
		[0.175, 0.325, 0.4, 0.8].forEach((value, channel) => expect(multiplied.vertices[0].color[channel]).toBeCloseTo(value, 6));
		expect(multiplied.topologyFingerprintAfter).toBe(state.topologyFingerprint);
		expect(multiplied.revision).toBe(3);
	});

	test("isolates painted face corners while preserving every arbitrary stream and unselected white vertices", () => {
		const original = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const vertexCount = original.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values.length / 3;
		mesh.setVerticesData(VertexBuffer.UV2Kind, Array.from({ length: vertexCount }, (_, vertex) => [vertex / 10, 1 - vertex / 10]).flat(), true, 2);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, (_, vertex) => [vertex, 0, 0, 0]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 0]).flat(), true, 4);
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const initial = getMeshVertexColors(scene, { nodeId: mesh.id });
		const result = paintMeshVertexColors(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "face",
				faceIndices: [0],
				color: [0, 0.5, 1, 1],
				splitFaceBoundaries: true,
			},
			options
		);
		expect(result).toMatchObject({
			vertexCountBefore: 4,
			vertexCountAfter: 6,
			operation: { targetMode: "face", targetCount: 1, affectedVertexCount: 3, splitVertexCount: 2 },
		});
		expect(result.topologyFingerprintAfter).not.toBe(result.topologyFingerprintBefore);
		const after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(after.indices.slice(0, 3).every((vertex) => result.paintedVertexIndices.includes(vertex))).toBe(true);
		const unselectedVertices = new Set(after.indices.slice(3, 6));
		const colors = after.streams.find((stream) => stream.kind === VertexBuffer.ColorKind)!;
		for (const vertex of unselectedVertices) {
			expect(colors.values.slice(vertex * 4, vertex * 4 + 4)).toEqual([1, 1, 1, 1]);
		}
		for (const kind of [
			VertexBuffer.PositionKind,
			VertexBuffer.UVKind,
			VertexBuffer.NormalKind,
			VertexBuffer.UV2Kind,
			VertexBuffer.MatricesIndicesKind,
			VertexBuffer.MatricesWeightsKind,
		]) {
			const source = before.streams.find((stream) => stream.kind === kind)!;
			const output = after.streams.find((stream) => stream.kind === kind)!;
			expect(output.values.length).toBe(source.values.length + source.stride * 2);
			for (let duplicate = 4; duplicate < 6; duplicate++) {
				const position = after.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values.slice(duplicate * 3, duplicate * 3 + 3);
				const originalVertex = Array.from({ length: 4 }, (_, vertex) => vertex).find(
					(vertex) =>
						JSON.stringify(before.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values.slice(vertex * 3, vertex * 3 + 3)) ===
						JSON.stringify(position)
				)!;
				expect(output.values.slice(duplicate * output.stride, duplicate * output.stride + output.stride)).toEqual(
					source.values.slice(originalVertex * source.stride, originalVertex * source.stride + source.stride)
				);
			}
		}
		expect(after.subMeshes).toEqual(before.subMeshes);
		expect(after.uvLayout).toEqual(before.uvLayout);
		expect(getMeshSelection(scene, { nodeId: mesh.id })).toMatchObject({ mode: "face", indices: [0] });
	});

	test("upgrades RGB colors to RGBA and restores exact color flags and metadata through snapshots", () => {
		mesh.setVerticesData(VertexBuffer.ColorKind, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0.5, 0.5], true, 3);
		mesh.useVertexColors = false;
		mesh.hasVertexAlpha = false;
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		const initial = getMeshVertexColors(scene, { nodeId: mesh.id });
		expect(initial).toMatchObject({ colorStride: 3, hasColorStream: true, revision: 0 });
		paintMeshVertexColors(
			scene,
			{
				nodeId: mesh.id,
				expectedTopologyFingerprint: initial.topologyFingerprint,
				expectedColorFingerprint: initial.colorFingerprint,
				expectedRevision: 0,
				targetMode: "vertex",
				vertexIndices: [1],
				color: [0.2, 0.3, 0.4, 0.25],
			},
			options
		);
		const after = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(after.streams.find((stream) => stream.kind === VertexBuffer.ColorKind)).toMatchObject({ stride: 4 });
		expect(after.vertexColors).toMatchObject({ model: "selection-vertex-color-rgba-v1", revision: 1 });
		expect(after.useVertexColors).toBe(true);
		expect(after.hasVertexAlpha).toBe(true);
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		restoreLoopCutMeshSnapshot(scene, { nodeId: mesh.id }, after, options);
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(after);
	});

	test("rejects stale, duplicate, invalid-target, and morph-splitting paint requests atomically", () => {
		const initial = getMeshVertexColors(scene, { nodeId: mesh.id });
		const request = {
			nodeId: mesh.id,
			expectedTopologyFingerprint: initial.topologyFingerprint,
			expectedColorFingerprint: initial.colorFingerprint,
			expectedRevision: 0,
			targetMode: "vertex",
			vertexIndices: [0],
			color: [1, 0, 0, 1],
		};
		const before = captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id });
		expect(() => paintMeshVertexColors(scene, { ...request, expectedTopologyFingerprint: "stale" }, options)).toThrow("topology is stale");
		expect(() => paintMeshVertexColors(scene, { ...request, expectedColorFingerprint: "stale" }, options)).toThrow("values are stale");
		expect(() => paintMeshVertexColors(scene, { ...request, expectedRevision: 1 }, options)).toThrow("revision is stale");
		expect(() => paintMeshVertexColors(scene, { ...request, vertexIndices: [0, 0] }, options)).toThrow("unique");
		expect(() => paintMeshVertexColors(scene, { ...request, faceIndices: [0] }, options)).toThrow("require only vertexIndices");
		expect(() => paintMeshVertexColors(scene, { ...request, opacity: 2 }, options)).toThrow("opacity");
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(before);

		const manager = new MorphTargetManager(scene);
		const target = new MorphTarget("Paint Morph", 0, scene);
		target.setPositions(before.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values);
		manager.addTarget(target);
		mesh.morphTargetManager = manager;
		expect(() =>
			paintMeshVertexColors(
				scene,
				{
					...request,
					targetMode: "face",
					vertexIndices: undefined,
					faceIndices: [0],
					splitFaceBoundaries: true,
				},
				options
			)
		).toThrow("morph targets");
		expect(captureLoopCutMeshSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		const rawPaint = paintMeshVertexColors(scene, request, options);
		expect(rawPaint).toMatchObject({ revision: 1, vertexCountBefore: 4, vertexCountAfter: 4 });
	});

	test("inspects bounded mesh integrity with exact fingerprints, issue summaries, and filtered paging", () => {
		const report = inspectMeshIntegrity(scene, { nodeId: mesh.id, offset: 0, limit: 2 });
		expect(report).toMatchObject({
			model: "bounded-triangle-mesh-integrity-v1",
			structurallyRepairable: true,
			valid: true,
			counts: {
				vertices: 4,
				faces: 2,
				completeFaces: 2,
				validFaces: 2,
				connectedComponents: 1,
				boundaryEdges: 4,
				nonManifoldEdges: 0,
				inconsistentWindingEdges: 0,
				unusedVertices: 0,
				weldableVertexGroups: 0,
			},
			issueCounts: { errors: 0, warnings: 0, info: 4, total: 4, truncated: 0 },
			offset: 0,
			limit: 2,
			total: 4,
			returned: 2,
			hasMore: true,
		});
		expect(report.integrityFingerprint).toMatch(/^mesh-integrity-fnv32x2-v1:/);
		const boundaries = inspectMeshIntegrity(scene, { nodeId: mesh.id, categories: ["boundaryEdges"], severity: "info", offset: 2, limit: 2 });
		expect(boundaries).toMatchObject({ total: 4, returned: 2, hasMore: false });
		expect(boundaries.issues.every((issue: any) => issue.category === "boundaryEdges" && issue.severity === "info")).toBe(true);
		expect(() => inspectMeshIntegrity(scene, { nodeId: mesh.id, categories: ["boundaryEdges", "boundaryEdges"] })).toThrow("unique");
	});

	test("atomically removes degenerate and duplicate faces, compacts streams, welds compatible vertices, and fixes winding", () => {
		setMeshVertexData(
			scene,
			{
				nodeId: mesh.id,
				positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 9, 9, 9],
				uvs: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0.5, 0.5],
				indices: [0, 1, 2, 0, 3, 2, 0, 0, 1, 4, 1, 2],
			},
			options
		);
		const vertexCount = 6;
		mesh.setVerticesData(VertexBuffer.NormalKind, Array.from({ length: vertexCount }, () => [0, 0, 1]).flat(), true, 3);
		mesh.setVerticesData(VertexBuffer.ColorKind, Array.from({ length: vertexCount }, (_, vertex) => (vertex === 5 ? [0, 1, 0, 1] : [1, 0, 0, 1])).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.UV2Kind, [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0.5, 0.5], true, 2);
		const before = captureMeshIntegritySnapshot(scene, { nodeId: mesh.id });
		const initial = inspectMeshIntegrity(scene, { nodeId: mesh.id, offset: 0, limit: 256 });
		expect(initial).toMatchObject({
			valid: false,
			counts: { vertices: 6, faces: 4, validFaces: 2, unusedVertices: 1, weldableVertexGroups: 1, inconsistentWindingEdges: 2 },
		});
		expect(initial.categories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ category: "degenerateFaces", errors: 1 }),
				expect.objectContaining({ category: "duplicateFaces", errors: 1 }),
				expect.objectContaining({ category: "unusedVertices", warnings: 1 }),
				expect.objectContaining({ category: "winding", warnings: 2 }),
			])
		);
		const repaired = repairMeshIntegrity(
			scene,
			{
				nodeId: mesh.id,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: [
					"removeInvalidFaces",
					"removeDegenerateFaces",
					"removeDuplicateFaces",
					"removeUnusedVertices",
					"weldIdenticalVertices",
					"fixWinding",
					"rebuildNormals",
					"rebuildSubMeshes",
				],
				confirm: true,
			},
			options
		);
		expect(repaired).toMatchObject({
			valid: true,
			countsBefore: { vertices: 6, faces: 4 },
			countsAfter: { vertices: 4, faces: 2 },
			removedInvalidFaces: 0,
			removedDegenerateFaces: 1,
			removedDuplicateFaces: 1,
			weldedVertexCount: 1,
			flippedFaceCount: 1,
			counts: { vertices: 4, completeFaces: 2, nonManifoldEdges: 0, inconsistentWindingEdges: 0, unusedVertices: 0 },
		});
		expect(repaired.integrityFingerprintAfter).not.toBe(initial.integrityFingerprint);
		const after = captureMeshIntegritySnapshot(scene, { nodeId: mesh.id });
		for (const kind of [VertexBuffer.PositionKind, VertexBuffer.UVKind, VertexBuffer.UV2Kind, VertexBuffer.ColorKind, VertexBuffer.NormalKind]) {
			const stream = after.streams.find((candidate) => candidate.kind === kind)!;
			expect(stream.values).toHaveLength(4 * stream.stride);
		}
		expect(after.subMeshes).toEqual([{ materialIndex: 0, indexStart: 0, indexCount: 6 }]);
		restoreMeshIntegritySnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureMeshIntegritySnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		restoreMeshIntegritySnapshot(scene, { nodeId: mesh.id }, after, options);
		expect(captureMeshIntegritySnapshot(scene, { nodeId: mesh.id })).toEqual(after);
	});

	test("repairs trailing and invalid face indices only when explicitly requested", () => {
		mesh.setIndices([0, 1, 2, 0, 1, 99, 3]);
		mesh.releaseSubMeshes(true);
		new SubMesh(0, 0, 4, 0, 6, mesh, mesh, false, true);
		const before = captureMeshIntegritySnapshot(scene, { nodeId: mesh.id });
		const initial = inspectMeshIntegrity(scene, { nodeId: mesh.id });
		expect(initial).toMatchObject({ structurallyRepairable: true, valid: false, counts: { completeFaces: 2, validFaces: 1 } });
		expect(initial.categories).toEqual(expect.arrayContaining([expect.objectContaining({ category: "indices", errors: 2 })]));
		expect(() =>
			repairMeshIntegrity(scene, { nodeId: mesh.id, expectedIntegrityFingerprint: initial.integrityFingerprint, operations: ["rebuildNormals"], confirm: true }, options)
		).toThrow("Trailing incomplete indices require removeInvalidFaces");
		const repaired = repairMeshIntegrity(
			scene,
			{
				nodeId: mesh.id,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: ["removeInvalidFaces", "removeUnusedVertices", "rebuildSubMeshes", "rebuildNormals"],
				confirm: true,
			},
			options
		);
		expect(repaired).toMatchObject({ valid: true, removedInvalidFaces: 1, countsAfter: { vertices: 3, faces: 1 } });
		expect(Array.from(mesh.getIndices(false) ?? [])).toEqual([0, 1, 2]);
		restoreMeshIntegritySnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureMeshIntegritySnapshot(scene, { nodeId: mesh.id })).toEqual(before);
	});

	test("normalizes eight-influence skin weights while preserving indices and arbitrary streams", () => {
		const vertexCount = mesh.getTotalVertices();
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, () => [0, 1, 2, 3]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [2, -1, 1, 0]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, Array.from({ length: vertexCount }, () => [4, 5, 6, 7]).flat(), true, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsExtraKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 0]).flat(), true, 4);
		const beforeIndices = Array.from(mesh.getIndices(false) ?? []);
		const initial = inspectMeshIntegrity(scene, { nodeId: mesh.id });
		expect(initial.categories).toEqual(expect.arrayContaining([expect.objectContaining({ category: "skinning", warnings: vertexCount })]));
		const repaired = repairMeshIntegrity(
			scene,
			{
				nodeId: mesh.id,
				expectedIntegrityFingerprint: initial.integrityFingerprint,
				operations: ["normalizeSkinWeights"],
				confirm: true,
			},
			options
		);
		expect(repaired.topologyFingerprintAfter).toBe(repaired.topologyFingerprintBefore);
		expect(Array.from(mesh.getIndices(false) ?? [])).toEqual(beforeIndices);
		const base = Array.from(mesh.getVerticesData(VertexBuffer.MatricesWeightsKind, false) ?? []);
		const extra = Array.from(mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind, false) ?? []);
		for (let vertex = 0; vertex < vertexCount; vertex++) {
			const weights = [...base.slice(vertex * 4, vertex * 4 + 4), ...extra.slice(vertex * 4, vertex * 4 + 4)];
			expect(weights.every((weight) => weight >= 0)).toBe(true);
			expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
		}
		expect(inspectMeshIntegrity(scene, { nodeId: mesh.id }).categories.some((category: any) => category.category === "skinning")).toBe(false);
	});

	test("rejects stale, unconfirmed, duplicate-operation, all-face-removal, and morph-target repairs atomically", () => {
		setMeshVertexData(scene, { nodeId: mesh.id, positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], uvs: [0, 0, 0.5, 0, 1, 0], indices: [0, 1, 2] }, options);
		const initial = inspectMeshIntegrity(scene, { nodeId: mesh.id });
		const before = captureMeshIntegritySnapshot(scene, { nodeId: mesh.id });
		expect(() =>
			repairMeshIntegrity(scene, { nodeId: mesh.id, expectedIntegrityFingerprint: initial.integrityFingerprint, operations: ["removeDegenerateFaces"] }, options)
		).toThrow("confirm=true");
		expect(() => repairMeshIntegrity(scene, { nodeId: mesh.id, expectedIntegrityFingerprint: "stale", operations: ["removeDegenerateFaces"], confirm: true }, options)).toThrow(
			"snapshot is stale"
		);
		expect(() =>
			repairMeshIntegrity(
				scene,
				{ nodeId: mesh.id, expectedIntegrityFingerprint: initial.integrityFingerprint, operations: ["removeDegenerateFaces", "removeDegenerateFaces"], confirm: true },
				options
			)
		).toThrow("unique");
		expect(() =>
			repairMeshIntegrity(
				scene,
				{ nodeId: mesh.id, expectedIntegrityFingerprint: initial.integrityFingerprint, operations: ["removeDegenerateFaces"], confirm: true },
				options
			)
		).toThrow("remove every triangle");
		expect(captureMeshIntegritySnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		const manager = new MorphTargetManager(scene);
		const target = new MorphTarget("Repair Morph", 0, scene);
		target.setPositions(before.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values);
		manager.addTarget(target);
		mesh.morphTargetManager = manager;
		expect(() =>
			repairMeshIntegrity(scene, { nodeId: mesh.id, expectedIntegrityFingerprint: initial.integrityFingerprint, operations: ["rebuildNormals"], confirm: true }, options)
		).toThrow("morph targets");
		expect(captureMeshIntegritySnapshot(scene, { nodeId: mesh.id })).toEqual(before);
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, MeshBuilder, NullEngine, Scene } from "babylonjs";

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
	setMeshUVProjection,
	subdivideMesh,
	unwrapMeshUVs,
} from "../../src/mcp/meshes/meshes";

describe("mcp/mesh-subdivision", () => {
	let engine: NullEngine;
	let scene: Scene;
	let mesh: Mesh;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

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
		expect(result).toMatchObject({ bevelAmount: 0.2, addedVertices: 4, addedTriangles: 2 });
		expect(result.indices).toHaveLength(original.indices.length + 6);
		expect(result.positions).toHaveLength(original.positions.length + 12);
		expect(() => bevelMeshEdge(scene, { nodeId: mesh.id, edgeIndex: 999, amount: 0.2 }, options)).toThrow("edgeIndex");
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
				faces: original.indices.filter((_, offset) => offset % 3 === 0).filter((_, face) => original.indices.slice(face * 3, face * 3 + 3).includes(edge[0]) && original.indices.slice(face * 3, face * 3 + 3).includes(edge[1])),
			}))
			.filter((value: any) => value.faces.length === 2);
		const firstIndex = manifold[0].index;
		const first = topology.edges[firstIndex];
		const secondIndex = manifold.find((value: any) => value.index !== firstIndex && !value.edge.includes(first[0]) && !value.edge.includes(first[1]))!.index;
		const result = bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: [firstIndex, secondIndex], amount: 0.2 }, options);
		expect(result).toMatchObject({ bevelAmount: 0.2, addedVertices: 8, addedTriangles: 4 });
		expect(result.indices).toHaveLength(original.indices.length + 12);
		expect(() => bevelMeshEdges(scene, { nodeId: mesh.id, edgeIndices: [0, 1], amount: 0.2 }, options)).toThrow("disjoint");
	});

	test("projects planar UVs from local mesh positions", () => {
		const result = setMeshUVProjection(scene, { nodeId: mesh.id, plane: "xz", scale: 10 }, options);
		expect(result.projection).toEqual({ plane: "xz", scale: 10, offset: [0, 0] });
		expect(result.uvs).toHaveLength(8);
		expect(new Set(result.uvs)).toEqual(new Set([-0.5, 0, 0.5]));
		expect(() => setMeshUVProjection(scene, { nodeId: mesh.id, scale: 0 }, options)).toThrow("scale must be greater");
	});

	test("unwraps each triangle into a non-overlapping padded atlas chart", () => {
		const original = getMeshVertexData(scene, { nodeId: mesh.id });
		const result = unwrapMeshUVs(scene, { nodeId: mesh.id, padding: 0.05 }, options);
		expect(result.unwrap).toEqual({ chartCount: 2, columns: 2, rows: 1, padding: 0.05 });
		expect(result.positions).toHaveLength(18);
		expect(result.indices).toEqual([0, 1, 2, 3, 4, 5]);
		expect(result.uvs).toHaveLength(12);
		expect(result.duplicatedVertices).toBe(2);
		expect(() => unwrapMeshUVs(scene, { nodeId: mesh.id, padding: 0.5 }, options)).toThrow("padding");
		expect(original.positions).toHaveLength(12);
	});
});

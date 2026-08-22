import { dirname, join, relative } from "path/posix";
import sharp from "sharp";
import { getDeferredLightingRuntimes } from "babylonjs-editor-tools";
import {
	Color3,
	CSG,
	CreateBoxVertexData,
	CreateCapsuleVertexData,
	CreateCylinderVertexData,
	CreateGroundFromHeightMapVertexData,
	CreateGroundVertexData,
	CreatePlaneVertexData,
	CreateSphereVertexData,
	CreateTorusKnotVertexData,
	CreateTorusVertexData,
	Mesh,
	InstancedMesh,
	MeshBuilder,
	MorphTarget,
	Node,
	AbstractMesh,
	PhysicsAggregate,
	PhysicsMotionType,
	PhysicsShape,
	PhysicsShapeType,
	Scene,
	Skeleton,
	Vector3,
	VertexBuffer,
	VertexData,
} from "babylonjs";

import { isMesh, isAbstractMesh, isInstancedMesh } from "../../tools/guards/nodes";

import { createMeshInstance } from "../../tools/mesh/instance";
import { getPhysicsShapeForMesh } from "../../tools/physics/shape";
import { getCollisionMeshFor } from "../../tools/mesh/collision";
import { smoothGroundGeometry } from "../../tools/mesh/ground";
import { CollisionMesh, CollisionMeshType } from "../../editor/nodes/collision";

import { projectConfiguration } from "../../project/configuration";

import {
	addBoxMesh,
	addPlaneMesh,
	addGroundMesh,
	addSphereMesh,
	addCapsuleMesh,
	addTorusMesh,
	addTorusKnotMesh,
	addCylinderMesh,
	addSkyboxMesh,
	addEmptyMesh,
} from "../../project/add/mesh";

import { IMCPActionOptions } from "../action";
import { findPhysicsCollisionLayer } from "../scene/scene";
import { resolveNode, resolveMaterial, toNodeSummary, toVector3 } from "../tools/resolve";

/**
 * Resolves an optional parent node from the given data.
 */
function resolveOptionalParent(scene: Scene, data: any): Node | undefined {
	if (data.parentId || data.parentName) {
		return resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName });
	}

	return undefined;
}

function getProjectRelativeAssetPath(path: string): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	const projectDirectory = dirname(projectConfiguration.path);
	const absolutePath = join(projectDirectory, path);
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("Heightmap paths must stay inside the open project directory.");
	}

	return absolutePath;
}

function rebuildMeshGeometry(mesh: Mesh): void {
	const metadata = mesh.metadata;
	if (!metadata?.type) {
		throw new Error(`Mesh "${mesh.name}" is not an editor primitive with editable geometry.`);
	}

	let vertexData;
	switch (metadata.type) {
		case "Box":
			vertexData = CreateBoxVertexData(metadata);
			break;
		case "Plane":
			vertexData = CreatePlaneVertexData(metadata);
			break;
		case "Sphere":
			vertexData = CreateSphereVertexData(metadata);
			break;
		case "Ground":
			vertexData = CreateGroundVertexData(metadata);
			break;
		case "Capsule":
			vertexData = CreateCapsuleVertexData(metadata);
			break;
		case "Cylinder":
			vertexData = CreateCylinderVertexData(metadata);
			break;
		case "Torus":
			vertexData = CreateTorusVertexData(metadata);
			break;
		case "TorusKnot":
			vertexData = CreateTorusKnotVertexData(metadata);
			break;
		default:
			throw new Error(`Mesh type "${metadata.type}" does not have editable primitive geometry.`);
	}

	mesh.geometry?.setAllVerticesData(vertexData, false);
	delete mesh.metadata.babylonEditorSmoothingGroups;
	delete mesh.metadata.babylonEditorVertexColors;
	mesh.refreshBoundingInfo({ updatePositionsArray: true });
}

/**
 * Creates a primitive mesh in the scene reusing the editor's "add" functions.
 */
export function createPrimitiveMesh(scene: Scene, data: any, options: IMCPActionOptions): any {
	const parent = resolveOptionalParent(scene, data);
	const editor = options.editor;

	let mesh: Node;
	switch (data.type) {
		case "box":
			mesh = addBoxMesh(editor, parent);
			break;
		case "sphere":
			mesh = addSphereMesh(editor, parent);
			break;
		case "ground":
			mesh = addGroundMesh(editor, parent);
			break;
		case "plane":
			mesh = addPlaneMesh(editor, parent);
			break;
		case "cylinder":
			mesh = addCylinderMesh(editor, parent);
			break;
		case "capsule":
			mesh = addCapsuleMesh(editor, parent);
			break;
		case "torus":
			mesh = addTorusMesh(editor, parent);
			break;
		case "torusknot":
			mesh = addTorusKnotMesh(editor, parent);
			break;
		case "skybox":
			mesh = addSkyboxMesh(editor, parent);
			break;
		case "empty":
			mesh = addEmptyMesh(editor, parent);
			break;
		default:
			throw new Error(`Unknown primitive mesh type: ${data.type}`);
	}

	if (data.name) {
		mesh.name = data.name;
	}

	if (data.position && isAbstractMesh(mesh)) {
		mesh.position.copyFrom(toVector3(data.position));
	}

	return toNodeSummary(mesh);
}

/**
 * Gets the editable primitive geometry metadata stored by the editor.
 */
export function getMeshGeometry(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}

	return {
		node: toNodeSummary(node),
		geometry: node.metadata?.type ? { ...node.metadata } : null,
	};
}

/** Returns editable vertex/index buffers for ProBuilder-style mesh authoring. */
export function getMeshVertexData(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const mesh = node as Mesh;
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind, false);
	const indices = mesh.getIndices(false);
	if (!positions || !indices) {
		throw new Error(`Mesh "${mesh.name}" has no editable vertex data.`);
	}
	return {
		node: toNodeSummary(mesh),
		positions: Array.from(positions),
		normals: Array.from(mesh.getVerticesData(VertexBuffer.NormalKind, false) ?? []),
		uvs: Array.from(mesh.getVerticesData(VertexBuffer.UVKind, false) ?? []),
		matricesIndices: Array.from(mesh.getVerticesData(VertexBuffer.MatricesIndicesKind, false) ?? []),
		matricesWeights: Array.from(mesh.getVerticesData(VertexBuffer.MatricesWeightsKind, false) ?? []),
		matricesIndicesExtra: Array.from(mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind, false) ?? []),
		matricesWeightsExtra: Array.from(mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind, false) ?? []),
		indices: Array.from(indices),
	};
}

type MeshSelectionMode = "vertex" | "edge" | "face";

export function getMeshEdges(indices: number[]): [number, number][] {
	const edges = new Map<string, [number, number]>();
	for (let index = 0; index < indices.length; index += 3) {
		const triangle = [indices[index], indices[index + 1], indices[index + 2]];
		for (let offset = 0; offset < 3; offset++) {
			const first = triangle[offset];
			const second = triangle[(offset + 1) % 3];
			const edge: [number, number] = first < second ? [first, second] : [second, first];
			edges.set(`${edge[0]}:${edge[1]}`, edge);
		}
	}
	return [...edges.values()];
}

/** Returns a deterministic, non-cryptographic identity for one exact editable topology snapshot. */
export function getMeshTopologyFingerprint(positions: ArrayLike<number>, indices: ArrayLike<number>): string {
	let first = 2166136261;
	let second = 2246822519;
	const update = (value: number): void => {
		const integer = Number.isInteger(value) ? value : Math.round(value * 1_000_000);
		for (let shift = 0; shift < 32; shift += 8) {
			const byte = (integer >>> shift) & 255;
			first = Math.imul(first ^ byte, 16777619) >>> 0;
			second = Math.imul(second ^ byte, 3266489917) >>> 0;
		}
	};
	update(positions.length);
	for (let index = 0; index < positions.length; index++) {
		update(positions[index]);
	}
	update(indices.length);
	for (let index = 0; index < indices.length; index++) {
		update(indices[index]);
	}
	return `mesh-topology-fnv32x2-v1:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

/** Returns stable vertex, unique-edge, and triangle-face identifiers for component selection. */
export function getMeshTopology(scene: Scene, data: any): any {
	const mesh = getMeshVertexData(scene, data);
	return {
		node: mesh.node,
		topologyModel: "raw-triangle-edges-v2",
		topologyFingerprint: getMeshTopologyFingerprint(mesh.positions, mesh.indices),
		vertexCount: mesh.positions.length / 3,
		faceCount: mesh.indices.length / 3,
		edges: getMeshEdges(mesh.indices),
	};
}

/** Reads the persisted ProBuilder-style component selection for one mesh. */
export function getMeshSelection(scene: Scene, data: any): any {
	const mesh = getMeshVertexData(scene, data);
	const node = resolveNode({ scene, nodeId: mesh.node.id });
	const selection = node.metadata?.babylonEditorMeshSelection ?? { mode: "face", indices: [] };
	return { node: mesh.node, mode: selection.mode, indices: selection.indices, topology: getMeshTopology(scene, data) };
}

/** Persists a validated vertex, unique-edge, or triangle-face selection for editor and MCP mesh operations. */
export function setMeshSelection(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const mode = data.mode as MeshSelectionMode;
	if (!(["vertex", "edge", "face"] as const).includes(mode)) {
		throw new Error('Mesh selection mode must be "vertex", "edge", or "face".');
	}
	const mesh = getMeshVertexData(scene, { nodeId: node.id });
	const maximum = mode === "vertex" ? mesh.positions.length / 3 : mode === "face" ? mesh.indices.length / 3 : getMeshEdges(mesh.indices).length;
	const indices = [...new Set<number>(data.indices ?? [])].sort((first, second) => first - second);
	if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= maximum)) {
		throw new Error(`${mode} selection indices must be integers from 0 to ${maximum - 1}.`);
	}
	node.metadata ??= {};
	node.metadata.babylonEditorMeshSelection = { mode, indices };
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getMeshSelection(scene, { nodeId: node.id });
}

/** Replaces editable vertex/index buffers and recomputes normals when omitted. */
export function setMeshVertexData(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const mesh = node as Mesh;
	const currentPositions = mesh.getVerticesData(VertexBuffer.PositionKind, false);
	const positions = data.positions ?? mesh.getVerticesData(VertexBuffer.PositionKind, false);
	const indices = data.indices ?? mesh.getIndices(false);
	if (!positions || !indices || positions.length % 3 !== 0 || indices.length % 3 !== 0) {
		throw new Error("Positions and indices must contain complete XYZ vertices and triangle triplets.");
	}
	if (indices.some((index: number) => !Number.isInteger(index) || index < 0 || index >= positions.length / 3)) {
		throw new Error("Mesh indices must reference existing vertices.");
	}
	const currentHasSkinWeights = !!mesh.getVerticesData(VertexBuffer.MatricesIndicesKind, false) || !!mesh.getVerticesData(VertexBuffer.MatricesWeightsKind, false);
	if (currentHasSkinWeights && currentPositions && currentPositions.length !== positions.length && (!data.matricesIndices || !data.matricesWeights)) {
		throw new Error(
			"Topology edits that change a skinned mesh's vertex count must provide matching matricesIndices and matricesWeights instead of leaving stale skin weights."
		);
	}
	const validateSkinBuffer = (value: number[] | undefined, label: string): number[] | undefined => {
		if (value !== undefined && value.length !== (positions.length / 3) * 4) {
			throw new Error(`${label} must contain exactly four values per vertex.`);
		}
		return value;
	};
	const vertexData = new VertexData();
	vertexData.positions = positions;
	vertexData.indices = indices;
	vertexData.uvs = data.uvs ?? mesh.getVerticesData(VertexBuffer.UVKind, false) ?? undefined;
	vertexData.matricesIndices = validateSkinBuffer(data.matricesIndices, "matricesIndices") ?? mesh.getVerticesData(VertexBuffer.MatricesIndicesKind, false);
	vertexData.matricesWeights = validateSkinBuffer(data.matricesWeights, "matricesWeights") ?? mesh.getVerticesData(VertexBuffer.MatricesWeightsKind, false);
	vertexData.matricesIndicesExtra = validateSkinBuffer(data.matricesIndicesExtra, "matricesIndicesExtra") ?? mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind, false);
	vertexData.matricesWeightsExtra = validateSkinBuffer(data.matricesWeightsExtra, "matricesWeightsExtra") ?? mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind, false);
	const normals: number[] = data.normals ?? [];
	if (!normals.length) {
		VertexData.ComputeNormals(positions, indices, normals);
	}
	vertexData.normals = normals;
	vertexData.applyToMesh(mesh, true);
	if (mesh.metadata) {
		delete mesh.metadata.babylonEditorSmoothingGroups;
		delete mesh.metadata.babylonEditorVertexColors;
	}
	mesh.refreshBoundingInfo({ updatePositionsArray: true });
	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.inspector.forceUpdate();
	return getMeshVertexData(scene, { nodeId: mesh.id });
}

/** Welds coincident vertices using a configurable local-space tolerance. */
export function weldMeshVertices(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = getMeshVertexData(scene, data);
	const tolerance = data.tolerance ?? 0.0001;
	if (!(tolerance > 0)) {
		throw new Error("Weld tolerance must be greater than zero.");
	}
	const remap = new Map<string, number>();
	const mapping: number[] = [];
	const positions: number[] = [];
	const uvs: number[] = [];
	for (let index = 0; index < current.positions.length / 3; index++) {
		const offset = index * 3;
		const key = [current.positions[offset], current.positions[offset + 1], current.positions[offset + 2]].map((value) => Math.round(value / tolerance)).join(":");
		let target = remap.get(key);
		if (target === undefined) {
			target = positions.length / 3;
			remap.set(key, target);
			positions.push(current.positions[offset], current.positions[offset + 1], current.positions[offset + 2]);
			if (current.uvs.length) {
				uvs.push(current.uvs[index * 2], current.uvs[index * 2 + 1]);
			}
		}
		mapping[index] = target;
	}
	const indices = current.indices.map((index: number) => mapping[index]);
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions, uvs, indices }, options);
	return { ...result, weldedVertices: current.positions.length / 3 - positions.length / 3 };
}

/** Flips triangle winding and normals for selected mesh geometry. */
export function flipMeshNormals(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const smoothingGroups = node.metadata?.babylonEditorSmoothingGroups ? JSON.parse(JSON.stringify(node.metadata.babylonEditorSmoothingGroups)) : undefined;
	const current = getMeshVertexData(scene, data);
	const indices = [...current.indices];
	for (let index = 0; index < indices.length; index += 3) {
		[indices[index + 1], indices[index + 2]] = [indices[index + 2], indices[index + 1]];
	}
	const normals = current.normals.map((value: number) => -value);
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions: current.positions, normals, uvs: current.uvs, indices }, options);
	if (smoothingGroups?.model === "coincident-face-smoothing-groups-v1" && smoothingGroups.faceGroups?.length === indices.length / 3) {
		smoothingGroups.topologyFingerprint = getMeshTopologyFingerprint(current.positions, indices);
		node.metadata ??= {};
		node.metadata.babylonEditorSmoothingGroups = smoothingGroups;
	}
	return result;
}

/** Extrudes selected triangle faces along their averaged normal or an explicit local direction. */
export function extrudeMeshFaces(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = getMeshVertexData(scene, data);
	const faceCount = current.indices.length / 3;
	const faces: number[] = [...new Set<number>((data.faceIndices ?? []) as number[])].sort((a, b) => a - b);
	if (!faces.length) {
		throw new Error("Provide at least one triangle face index to extrude.");
	}
	if (faces.some((face) => !Number.isInteger(face) || face < 0 || face >= faceCount)) {
		throw new Error(`faceIndices must be triangle indices from 0 to ${faceCount - 1}.`);
	}
	if (!(data.distance > 0)) {
		throw new Error("Extrusion distance must be greater than zero.");
	}
	const direction = data.direction ? Vector3.FromArray(data.direction) : Vector3.Zero();
	if (!data.direction) {
		for (const face of faces) {
			const offset = face * 3;
			const a = current.indices[offset] * 3,
				b = current.indices[offset + 1] * 3,
				c = current.indices[offset + 2] * 3;
			const ab = new Vector3(
				current.positions[b] - current.positions[a],
				current.positions[b + 1] - current.positions[a + 1],
				current.positions[b + 2] - current.positions[a + 2]
			);
			const ac = new Vector3(
				current.positions[c] - current.positions[a],
				current.positions[c + 1] - current.positions[a + 1],
				current.positions[c + 2] - current.positions[a + 2]
			);
			direction.addInPlace(Vector3.Cross(ab, ac));
		}
	}
	if (direction.lengthSquared() < 0.0000001) {
		throw new Error("Selected faces have no usable normal; provide an explicit direction.");
	}
	direction.normalize().scaleInPlace(data.distance);
	const positions = [...current.positions];
	const uvs = [...current.uvs];
	const indices = [...current.indices];
	const duplicate = new Map<number, number>();
	const topVertex = (vertex: number): number => {
		let result = duplicate.get(vertex);
		if (result !== undefined) {
			return result;
		}
		const offset = vertex * 3;
		result = positions.length / 3;
		positions.push(current.positions[offset] + direction.x, current.positions[offset + 1] + direction.y, current.positions[offset + 2] + direction.z);
		if (current.uvs.length) {
			uvs.push(current.uvs[vertex * 2], current.uvs[vertex * 2 + 1]);
		}
		duplicate.set(vertex, result);
		return result;
	};
	const boundary = new Map<string, [number, number, number]>();
	for (const face of faces) {
		const offset = face * 3;
		const vertices = [current.indices[offset], current.indices[offset + 1], current.indices[offset + 2]];
		indices.push(topVertex(vertices[0]), topVertex(vertices[1]), topVertex(vertices[2]));
		for (let index = 0; index < 3; index++) {
			const a = vertices[index],
				b = vertices[(index + 1) % 3],
				key = a < b ? `${a}:${b}` : `${b}:${a}`;
			const existing = boundary.get(key);
			if (existing) {
				boundary.set(key, [existing[0], existing[1], existing[2] + 1]);
			} else {
				boundary.set(key, [a, b, 1]);
			}
		}
	}
	for (const [, [a, b, count]] of boundary) {
		if (count !== 1) {
			continue;
		}
		const topA = topVertex(a),
			topB = topVertex(b);
		indices.push(a, b, topB, a, topB, topA);
	}
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions, uvs, indices }, options);
	return { ...result, extrudedFaces: faces.length, addedVertices: duplicate.size, addedTriangles: (indices.length - current.indices.length) / 3 };
}

/** Insets selected triangle faces by replacing them with a boundary ring and an optional recessed cap. */
export function insetMeshFaces(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = getMeshVertexData(scene, data);
	const faceCount = current.indices.length / 3;
	const faces: number[] = [...new Set<number>((data.faceIndices ?? []) as number[])].sort((a, b) => a - b);
	if (!faces.length) {
		throw new Error("Provide at least one triangle face index to inset.");
	}
	if (faces.some((face) => !Number.isInteger(face) || face < 0 || face >= faceCount)) {
		throw new Error(`faceIndices must be triangle indices from 0 to ${faceCount - 1}.`);
	}
	if (!(data.amount > 0 && data.amount < 1)) {
		throw new Error("Inset amount must be greater than 0 and less than 1.");
	}
	const selected = new Set(faces);
	const vertices = new Set<number>();
	const boundary = new Map<string, [number, number, number]>();
	const center = Vector3.Zero();
	const normal = Vector3.Zero();
	for (const face of faces) {
		const offset = face * 3;
		const triangle = [current.indices[offset], current.indices[offset + 1], current.indices[offset + 2]];
		for (const vertex of triangle) {
			vertices.add(vertex);
		}
		const a = triangle[0] * 3,
			b = triangle[1] * 3,
			c = triangle[2] * 3;
		normal.addInPlace(
			Vector3.Cross(
				new Vector3(current.positions[b] - current.positions[a], current.positions[b + 1] - current.positions[a + 1], current.positions[b + 2] - current.positions[a + 2]),
				new Vector3(current.positions[c] - current.positions[a], current.positions[c + 1] - current.positions[a + 1], current.positions[c + 2] - current.positions[a + 2])
			)
		);
		for (let index = 0; index < 3; index++) {
			const first = triangle[index],
				second = triangle[(index + 1) % 3],
				key = first < second ? `${first}:${second}` : `${second}:${first}`;
			const edge = boundary.get(key);
			if (edge) {
				boundary.set(key, [edge[0], edge[1], edge[2] + 1]);
			} else {
				boundary.set(key, [first, second, 1]);
			}
		}
	}
	for (const vertex of vertices) {
		const offset = vertex * 3;
		center.addInPlaceFromFloats(current.positions[offset], current.positions[offset + 1], current.positions[offset + 2]);
	}
	center.scaleInPlace(1 / vertices.size);
	if (normal.lengthSquared() < 0.0000001) {
		throw new Error("Selected faces have no usable normal.");
	}
	normal.normalize().scaleInPlace(data.depth ?? 0);
	const positions = [...current.positions],
		uvs = [...current.uvs];
	const inset = new Map<number, number>();
	for (const vertex of vertices) {
		const offset = vertex * 3;
		const index = positions.length / 3;
		positions.push(
			current.positions[offset] + (center.x - current.positions[offset]) * data.amount - normal.x,
			current.positions[offset + 1] + (center.y - current.positions[offset + 1]) * data.amount - normal.y,
			current.positions[offset + 2] + (center.z - current.positions[offset + 2]) * data.amount - normal.z
		);
		if (current.uvs.length) {
			uvs.push(current.uvs[vertex * 2], current.uvs[vertex * 2 + 1]);
		}
		inset.set(vertex, index);
	}
	const indices: number[] = [];
	for (let face = 0; face < faceCount; face++) {
		if (!selected.has(face)) {
			indices.push(current.indices[face * 3], current.indices[face * 3 + 1], current.indices[face * 3 + 2]);
		}
	}
	for (const face of faces) {
		const offset = face * 3;
		indices.push(inset.get(current.indices[offset])!, inset.get(current.indices[offset + 1])!, inset.get(current.indices[offset + 2])!);
	}
	for (const [, [first, second, count]] of boundary) {
		if (count === 1) {
			const insetFirst = inset.get(first)!,
				insetSecond = inset.get(second)!;
			indices.push(first, second, insetSecond, first, insetSecond, insetFirst);
		}
	}
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions, uvs, indices }, options);
	return { ...result, insetFaces: faces.length, addedVertices: inset.size, addedTriangles: (indices.length - current.indices.length) / 3 };
}

/** Performs a native Babylon CSG union, subtraction, or intersection and returns a standalone result mesh. */
export function booleanMesh(scene: Scene, data: any, options: IMCPActionOptions): any {
	const primary = resolveNode({ scene, nodeId: data.primaryNodeId, nodeName: data.primaryNodeName });
	const secondary = resolveNode({ scene, nodeId: data.secondaryNodeId, nodeName: data.secondaryNodeName });
	if (!isMesh(primary) || !isMesh(secondary)) {
		throw new Error("CSG operations require two Mesh nodes.");
	}
	if (primary === secondary) {
		throw new Error("CSG primary and secondary meshes must be different nodes.");
	}
	const first = CSG.FromMesh(primary);
	const second = CSG.FromMesh(secondary);
	const result = data.operation === "union" ? first.union(second) : data.operation === "subtract" ? first.subtract(second) : first.intersect(second);
	const mesh = result.toMesh(data.name ?? `${primary.name} ${data.operation} ${secondary.name}`, primary.material, scene, true);
	mesh.metadata = { ...(primary.metadata ?? {}), csg: { operation: data.operation, primaryNodeId: primary.id, secondaryNodeId: secondary.id } };
	if (data.disposeSources === true) {
		primary.dispose(false, false);
		secondary.dispose(false, false);
	}
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(mesh));
	options.editor.layout.inspector.setEditedObject(mesh);
	return {
		mesh: toNodeSummary(mesh),
		operation: data.operation,
		sourceNodeIds: [primary.id, secondary.id],
		sourcesDisposed: data.disposeSources === true,
		triangleCount: (mesh.getIndices()?.length ?? 0) / 3,
	};
}

/** Creates a quad bridge between two explicit local mesh edges. */
export function bridgeMeshEdges(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = getMeshVertexData(scene, data);
	const vertexCount = current.positions.length / 3;
	const first = data.firstEdge as number[];
	const second = data.secondEdge as number[];
	if (!Array.isArray(first) || first.length !== 2 || !Array.isArray(second) || second.length !== 2) {
		throw new Error("firstEdge and secondEdge must each contain exactly two vertex indices.");
	}
	const values = [...first, ...second];
	if (values.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
		throw new Error(`Bridge edge indices must reference vertices from 0 to ${vertexCount - 1}.`);
	}
	if (new Set(values).size !== 4) {
		throw new Error("Bridge edges must not share endpoints.");
	}
	const indices = [...current.indices, first[0], first[1], second[1], first[0], second[1], second[0]];
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions: current.positions, uvs: current.uvs, indices }, options);
	return { ...result, bridgedEdges: [first, second], addedTriangles: 2 };
}

type BevelWeights = [number, number, number];

interface IBevelPolygonVertex {
	weights: BevelWeights;
	index?: number;
}

interface IBevelFaceData {
	triangle: [number, number, number];
	normal: Vector3;
	polygon: IBevelPolygonVertex[];
	boundaries: Map<string, [number, number]>;
	constraints: Array<{ coordinate: number; edge: IBevelEdgeData }>;
}

interface IBevelEdgeData {
	edge: [number, number];
	key: string;
	incidentFaces: number[];
}

function getBevelEdgeKey(edge: [number, number]): string {
	return `${edge[0]}:${edge[1]}`;
}

function getBevelFaceNormal(positions: number[], triangle: [number, number, number]): Vector3 {
	const first = Vector3.FromArray(positions, triangle[0] * 3);
	const second = Vector3.FromArray(positions, triangle[1] * 3);
	const third = Vector3.FromArray(positions, triangle[2] * 3);
	return Vector3.Cross(second.subtract(first), third.subtract(first)).normalize();
}

function clipBevelPolygon(polygon: IBevelPolygonVertex[], coordinate: number, amount: number): IBevelPolygonVertex[] {
	const result: IBevelPolygonVertex[] = [];
	const epsilon = 0.0000001;
	for (let index = 0; index < polygon.length; index++) {
		const current = polygon[index];
		const next = polygon[(index + 1) % polygon.length];
		const currentInside = current.weights[coordinate] >= amount - epsilon;
		const nextInside = next.weights[coordinate] >= amount - epsilon;
		if (currentInside) {
			result.push(current);
		}
		if (currentInside !== nextInside) {
			const denominator = next.weights[coordinate] - current.weights[coordinate];
			const interpolation = (amount - current.weights[coordinate]) / denominator;
			result.push({
				weights: [
					current.weights[0] + (next.weights[0] - current.weights[0]) * interpolation,
					current.weights[1] + (next.weights[1] - current.weights[1]) * interpolation,
					current.weights[2] + (next.weights[2] - current.weights[2]) * interpolation,
				],
			});
		}
	}
	return result.filter((vertex, index) => {
		const previous = result[(index + result.length - 1) % result.length];
		return vertex.weights.some((value, coordinateIndex) => Math.abs(value - previous.weights[coordinateIndex]) > epsilon);
	});
}

function bevelSelectedMeshEdges(scene: Scene, data: any, edgeIndices: number[], options: IMCPActionOptions): any {
	if (!edgeIndices.length) {
		throw new Error("At least one edge index is required for beveling.");
	}
	if (edgeIndices.length > 256) {
		throw new Error("A single bevel operation supports at most 256 selected edges.");
	}
	if (new Set(edgeIndices).size !== edgeIndices.length) {
		throw new Error("Bevel edge indices must be unique.");
	}
	const amount = data.amount;
	if (!(amount > 0 && amount < 1)) {
		throw new Error("Bevel amount must be greater than 0 and less than 1.");
	}
	const segments = data.segments ?? 1;
	if (!Number.isInteger(segments) || segments < 1 || segments > 8) {
		throw new Error("Bevel segments must be an integer from 1 to 8.");
	}

	const original = getMeshVertexData(scene, data);
	const topologyEdges = getMeshEdges(original.indices);
	if (edgeIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= topologyEdges.length)) {
		throw new Error(`Bevel edge indices must reference unique edges from 0 to ${topologyEdges.length - 1}.`);
	}
	const selectedEdges: IBevelEdgeData[] = edgeIndices.map((index) => {
		const edge = topologyEdges[index];
		const incidentFaces: number[] = [];
		for (let face = 0; face < original.indices.length / 3; face++) {
			const triangle = original.indices.slice(face * 3, face * 3 + 3);
			if (triangle.includes(edge[0]) && triangle.includes(edge[1])) {
				incidentFaces.push(face);
			}
		}
		if (incidentFaces.length !== 2) {
			throw new Error(`Bevel edge ${index} is not manifold; every selected edge must be shared by exactly two triangles.`);
		}
		return { edge, key: getBevelEdgeKey(edge), incidentFaces };
	});
	const selectedByKey = new Map(selectedEdges.map((value) => [value.key, value]));

	const positions = [...original.positions];
	const uvs = [...original.uvs];
	const outputIndices: number[] = [];
	const appendVertex = (position: [number, number, number], uv?: [number, number]): number => {
		const index = positions.length / 3;
		positions.push(...position);
		if (original.uvs.length) {
			uvs.push(...(uv ?? [0, 0]));
		}
		return index;
	};
	const getPosition = (index: number): Vector3 => Vector3.FromArray(positions, index * 3);
	const getUv = (index: number): [number, number] => [uvs[index * 2] ?? 0, uvs[index * 2 + 1] ?? 0];
	const pushTriangle = (first: number, second: number, third: number, expectedNormal?: Vector3): boolean => {
		if (first === second || second === third || first === third) {
			return false;
		}
		const normal = Vector3.Cross(getPosition(second).subtract(getPosition(first)), getPosition(third).subtract(getPosition(first)));
		if (normal.lengthSquared() < 0.0000000001) {
			return false;
		}
		if (expectedNormal && Vector3.Dot(normal, expectedNormal) < 0) {
			outputIndices.push(first, third, second);
		} else {
			outputIndices.push(first, second, third);
		}
		return true;
	};
	const faceData: IBevelFaceData[] = [];
	for (let face = 0; face < original.indices.length / 3; face++) {
		const triangle = original.indices.slice(face * 3, face * 3 + 3) as [number, number, number];
		const constraints: Array<{ coordinate: number; edge: IBevelEdgeData }> = [];
		for (let coordinate = 0; coordinate < 3; coordinate++) {
			const first = triangle[(coordinate + 1) % 3];
			const second = triangle[(coordinate + 2) % 3];
			const edge: [number, number] = first < second ? [first, second] : [second, first];
			const selected = selectedByKey.get(getBevelEdgeKey(edge));
			if (selected) {
				constraints.push({ coordinate, edge: selected });
			}
		}
		if (constraints.length * amount >= 1 - 0.0000001) {
			throw new Error(`Bevel amount ${amount} is too large for face ${face}, where ${constraints.length} selected edges meet; reduce it below ${1 / constraints.length}.`);
		}
		let polygon: IBevelPolygonVertex[] = [{ weights: [1, 0, 0] }, { weights: [0, 1, 0] }, { weights: [0, 0, 1] }];
		for (const constraint of constraints) {
			polygon = clipBevelPolygon(polygon, constraint.coordinate, amount);
		}
		if (polygon.length < 3) {
			throw new Error(`Bevel selection collapses face ${face}; reduce the amount.`);
		}
		faceData.push({ triangle, normal: getBevelFaceNormal(original.positions, triangle), polygon, boundaries: new Map(), constraints });
	}

	const edgeSplits = new Map<string, number[]>();
	const describeOriginalEdgePoint = (face: IBevelFaceData, weights: BevelWeights): { key: string; edge: [number, number]; t: number } | null => {
		const zero = weights.findIndex((value) => Math.abs(value) < 0.0000001);
		if (zero < 0 || weights.filter((value) => Math.abs(value) < 0.0000001).length !== 1) {
			return null;
		}
		const corners = [0, 1, 2].filter((coordinate) => coordinate !== zero);
		const firstVertex = face.triangle[corners[0]];
		const secondVertex = face.triangle[corners[1]];
		const edge: [number, number] = firstVertex < secondVertex ? [firstVertex, secondVertex] : [secondVertex, firstVertex];
		const firstCorner = face.triangle.findIndex((vertex) => vertex === edge[0]);
		const secondCorner = face.triangle.findIndex((vertex) => vertex === edge[1]);
		const total = weights[firstCorner] + weights[secondCorner];
		return { key: getBevelEdgeKey(edge), edge, t: weights[secondCorner] / total };
	};
	for (const face of faceData) {
		for (const vertex of face.polygon) {
			const point = describeOriginalEdgePoint(face, vertex.weights);
			if (!point || point.t < 0.0000001 || point.t > 0.9999999) {
				continue;
			}
			const splits = edgeSplits.get(point.key) ?? [];
			if (!splits.some((value) => Math.abs(value - point.t) < 0.0000001)) {
				splits.push(point.t);
			}
			edgeSplits.set(point.key, splits);
		}
	}
	for (const face of faceData) {
		const polygon: IBevelPolygonVertex[] = [];
		for (let vertexIndex = 0; vertexIndex < face.polygon.length; vertexIndex++) {
			const current = face.polygon[vertexIndex];
			const next = face.polygon[(vertexIndex + 1) % face.polygon.length];
			polygon.push(current);
			const zero = [0, 1, 2].find((coordinate) => Math.abs(current.weights[coordinate]) < 0.0000001 && Math.abs(next.weights[coordinate]) < 0.0000001);
			if (zero === undefined) {
				continue;
			}
			const corners = [0, 1, 2].filter((coordinate) => coordinate !== zero);
			const firstVertex = face.triangle[corners[0]];
			const secondVertex = face.triangle[corners[1]];
			const edge: [number, number] = firstVertex < secondVertex ? [firstVertex, secondVertex] : [secondVertex, firstVertex];
			const firstCorner = face.triangle.findIndex((value) => value === edge[0]);
			const secondCorner = face.triangle.findIndex((value) => value === edge[1]);
			const currentT = current.weights[secondCorner] / (current.weights[firstCorner] + current.weights[secondCorner]);
			const nextT = next.weights[secondCorner] / (next.weights[firstCorner] + next.weights[secondCorner]);
			const key = getBevelEdgeKey(edge);
			const splits = [...(edgeSplits.get(key) ?? [])]
				.filter((value) => value > Math.min(currentT, nextT) + 0.0000001 && value < Math.max(currentT, nextT) - 0.0000001)
				.sort((first, second) => (currentT < nextT ? first - second : second - first));
			for (const split of splits) {
				const weights: BevelWeights = [0, 0, 0];
				weights[firstCorner] = 1 - split;
				weights[secondCorner] = split;
				polygon.push({ weights });
			}
		}
		face.polygon = polygon;
	}

	const sharedEdgeVertices = new Map<string, number>();
	for (const face of faceData) {
		for (const vertex of face.polygon) {
			const originalCorner = vertex.weights.findIndex((value) => value > 1 - 0.0000001);
			if (originalCorner >= 0) {
				vertex.index = face.triangle[originalCorner];
				continue;
			}
			const edgePoint = describeOriginalEdgePoint(face, vertex.weights);
			const sharedKey = edgePoint ? `${edgePoint.key}:${edgePoint.t.toFixed(8)}` : null;
			const sharedIndex = sharedKey ? sharedEdgeVertices.get(sharedKey) : undefined;
			if (sharedIndex !== undefined) {
				vertex.index = sharedIndex;
				continue;
			}
			const position: [number, number, number] = [0, 0, 0];
			const uv: [number, number] = [0, 0];
			for (let corner = 0; corner < 3; corner++) {
				const source = face.triangle[corner];
				const weight = vertex.weights[corner];
				position[0] += original.positions[source * 3] * weight;
				position[1] += original.positions[source * 3 + 1] * weight;
				position[2] += original.positions[source * 3 + 2] * weight;
				uv[0] += (original.uvs[source * 2] ?? 0) * weight;
				uv[1] += (original.uvs[source * 2 + 1] ?? 0) * weight;
			}
			vertex.index = appendVertex(position, uv);
			if (sharedKey) {
				sharedEdgeVertices.set(sharedKey, vertex.index);
			}
		}
		if (face.polygon.length === 3) {
			pushTriangle(face.polygon[0].index!, face.polygon[1].index!, face.polygon[2].index!);
		} else {
			const centerPosition: [number, number, number] = [0, 0, 0];
			const centerUv: [number, number] = [0, 0];
			for (const vertex of face.polygon) {
				const position = getPosition(vertex.index!);
				const uv = getUv(vertex.index!);
				centerPosition[0] += position.x / face.polygon.length;
				centerPosition[1] += position.y / face.polygon.length;
				centerPosition[2] += position.z / face.polygon.length;
				centerUv[0] += uv[0] / face.polygon.length;
				centerUv[1] += uv[1] / face.polygon.length;
			}
			const center = appendVertex(centerPosition, centerUv);
			for (let vertex = 0; vertex < face.polygon.length; vertex++) {
				pushTriangle(face.polygon[vertex].index!, face.polygon[(vertex + 1) % face.polygon.length].index!, center);
			}
		}
		for (const constraint of face.constraints) {
			const boundary = face.polygon.filter((vertex) => Math.abs(vertex.weights[constraint.coordinate] - amount) < 0.000001);
			if (boundary.length < 2) {
				throw new Error(`Unable to resolve the clipped boundary for selected edge ${constraint.edge.key}.`);
			}
			const firstCorner = face.triangle.findIndex((vertex) => vertex === constraint.edge.edge[0]);
			const secondCorner = face.triangle.findIndex((vertex) => vertex === constraint.edge.edge[1]);
			boundary.sort((first, second) => {
				const firstTotal = first.weights[firstCorner] + first.weights[secondCorner];
				const secondTotal = second.weights[firstCorner] + second.weights[secondCorner];
				return first.weights[secondCorner] / firstTotal - second.weights[secondCorner] / secondTotal;
			});
			face.boundaries.set(constraint.edge.key, [boundary[0].index!, boundary[boundary.length - 1].index!]);
		}
	}

	let adjacentEdgePairs = 0;
	for (let first = 0; first < selectedEdges.length; first++) {
		for (let second = first + 1; second < selectedEdges.length; second++) {
			if (selectedEdges[first].edge.some((vertex) => selectedEdges[second].edge.includes(vertex))) {
				adjacentEdgePairs++;
			}
		}
	}
	const remaining = new Set(selectedEdges.map((_, index) => index));
	let connectedComponentCount = 0;
	while (remaining.size) {
		connectedComponentCount++;
		const queue = [remaining.values().next().value as number];
		remaining.delete(queue[0]);
		while (queue.length) {
			const current = selectedEdges[queue.shift()!].edge;
			for (const candidate of [...remaining]) {
				if (selectedEdges[candidate].edge.some((vertex) => current.includes(vertex))) {
					remaining.delete(candidate);
					queue.push(candidate);
				}
			}
		}
	}

	for (const selected of selectedEdges) {
		const firstFace = faceData[selected.incidentFaces[0]];
		const secondFace = faceData[selected.incidentFaces[1]];
		const firstBoundary = firstFace.boundaries.get(selected.key);
		const secondBoundary = secondFace.boundaries.get(selected.key);
		if (!firstBoundary || !secondBoundary) {
			throw new Error(`Unable to resolve both face boundaries for selected edge ${selected.key}.`);
		}
		const rails: Array<[number, number]> = [firstBoundary];
		for (let segment = 1; segment < segments; segment++) {
			const interpolation = segment / segments;
			const inverse = 1 - interpolation;
			const rail: [number, number] = [0, 0];
			for (let endpoint = 0; endpoint < 2; endpoint++) {
				const start = getPosition(firstBoundary[endpoint]);
				const end = getPosition(secondBoundary[endpoint]);
				const control = Vector3.FromArray(original.positions, selected.edge[endpoint] * 3);
				const point = start
					.scale(inverse * inverse)
					.add(control.scale(2 * inverse * interpolation))
					.add(end.scale(interpolation * interpolation));
				const startUv = getUv(firstBoundary[endpoint]);
				const endUv = getUv(secondBoundary[endpoint]);
				const controlUv = getUv(selected.edge[endpoint]);
				rail[endpoint] = appendVertex(
					[point.x, point.y, point.z],
					[
						startUv[0] * inverse * inverse + controlUv[0] * 2 * inverse * interpolation + endUv[0] * interpolation * interpolation,
						startUv[1] * inverse * inverse + controlUv[1] * 2 * inverse * interpolation + endUv[1] * interpolation * interpolation,
					]
				);
			}
			rails.push(rail);
		}
		rails.push(secondBoundary);
		const expectedNormal = firstFace.normal.add(secondFace.normal).normalize();
		for (let segment = 0; segment < segments; segment++) {
			const current = rails[segment];
			const next = rails[segment + 1];
			pushTriangle(current[0], current[1], next[1], expectedNormal);
			pushTriangle(current[0], next[1], next[0], expectedNormal);
		}
		for (let endpoint = 0; endpoint < 2; endpoint++) {
			const originalVertex = selected.edge[endpoint];
			for (let segment = 0; segment < segments; segment++) {
				const first = rails[segment][endpoint];
				const second = rails[segment + 1][endpoint];
				if (first === second || first === originalVertex || second === originalVertex) {
					continue;
				}
				pushTriangle(originalVertex, first, second, expectedNormal);
			}
		}
	}

	const result = setMeshVertexData(scene, { nodeId: original.node.id, positions, uvs, indices: outputIndices }, options);
	const editedNode = resolveNode({ scene, nodeId: original.node.id });
	editedNode.metadata ??= {};
	editedNode.metadata.babylonEditorMeshSelection = { mode: "edge", indices: [] };
	return {
		...result,
		beveledEdges: selectedEdges.map((value) => value.edge),
		bevelAmount: amount,
		bevelSegments: segments,
		bevelModel: "segmented-adjacent-miter-v1",
		adjacentEdgePairs,
		connectedComponentCount,
		addedVertices: positions.length / 3 - original.positions.length / 3,
		addedTriangles: outputIndices.length / 3 - original.indices.length / 3,
	};
}

/** Bevels one manifold edge with an optional segmented round profile and mitered endpoint caps. */
export function bevelMeshEdge(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = bevelSelectedMeshEdges(scene, data, [data.edgeIndex], options);
	return { ...result, beveledEdge: result.beveledEdges[0] };
}

/** Atomically bevels disjoint or connected manifold edge selections from one stable topology snapshot. */
export function bevelMeshEdges(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!Array.isArray(data.edgeIndices) || !data.edgeIndices.length) {
		throw new Error("edgeIndices must contain at least one unique edge index.");
	}
	return bevelSelectedMeshEdges(scene, data, data.edgeIndices, options);
}

/** Generates planar UVs from local mesh positions for quick ProBuilder-style texture projection. */
export function setMeshUVProjection(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const smoothingGroups = node.metadata?.babylonEditorSmoothingGroups ? JSON.parse(JSON.stringify(node.metadata.babylonEditorSmoothingGroups)) : undefined;
	const current = getMeshVertexData(scene, data);
	const plane = data.plane ?? "xz";
	const scale = data.scale ?? 100;
	if (!(scale > 0)) {
		throw new Error("UV projection scale must be greater than zero.");
	}
	const uvs: number[] = [];
	for (let vertex = 0; vertex < current.positions.length / 3; vertex++) {
		const offset = vertex * 3;
		const x = current.positions[offset],
			y = current.positions[offset + 1],
			z = current.positions[offset + 2];
		const [u, v] = plane === "xy" ? [x, y] : plane === "yz" ? [y, z] : [x, z];
		uvs.push(u / scale + (data.offset?.[0] ?? 0), v / scale + (data.offset?.[1] ?? 0));
	}
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions: current.positions, normals: current.normals, uvs, indices: current.indices }, options);
	if (smoothingGroups?.model === "coincident-face-smoothing-groups-v1" && smoothingGroups.faceGroups?.length === current.indices.length / 3) {
		node.metadata ??= {};
		node.metadata.babylonEditorSmoothingGroups = smoothingGroups;
	}
	return { ...result, projection: { plane, scale, offset: data.offset ?? [0, 0] } };
}

/** Splits every triangle into four triangles using shared edge midpoints. */
export function subdivideMesh(scene: Scene, data: any, options: IMCPActionOptions): any {
	const levels = data.levels ?? 1;
	if (!Number.isInteger(levels) || levels < 1 || levels > 3) {
		throw new Error("Subdivision levels must be an integer from 1 to 3.");
	}
	let current = getMeshVertexData(scene, data);
	for (let level = 0; level < levels; level++) {
		const positions = [...current.positions];
		const uvs = [...current.uvs];
		const indices: number[] = [];
		const midpoints = new Map<string, number>();
		const midpoint = (first: number, second: number): number => {
			const key = first < second ? `${first}:${second}` : `${second}:${first}`;
			const existing = midpoints.get(key);
			if (existing !== undefined) {
				return existing;
			}
			const index = positions.length / 3;
			const firstOffset = first * 3;
			const secondOffset = second * 3;
			positions.push(
				(current.positions[firstOffset] + current.positions[secondOffset]) / 2,
				(current.positions[firstOffset + 1] + current.positions[secondOffset + 1]) / 2,
				(current.positions[firstOffset + 2] + current.positions[secondOffset + 2]) / 2
			);
			if (current.uvs.length) {
				const firstUV = first * 2;
				const secondUV = second * 2;
				uvs.push((current.uvs[firstUV] + current.uvs[secondUV]) / 2, (current.uvs[firstUV + 1] + current.uvs[secondUV + 1]) / 2);
			}
			midpoints.set(key, index);
			return index;
		};
		for (let index = 0; index < current.indices.length; index += 3) {
			const first = current.indices[index];
			const second = current.indices[index + 1];
			const third = current.indices[index + 2];
			const firstSecond = midpoint(first, second);
			const secondThird = midpoint(second, third);
			const thirdFirst = midpoint(third, first);
			indices.push(first, firstSecond, thirdFirst, firstSecond, second, secondThird, thirdFirst, secondThird, third, firstSecond, secondThird, thirdFirst);
		}
		current = { ...current, positions, uvs, indices };
	}
	if (current.positions.length / 3 > 1_000_000) {
		throw new Error("Subdivision would exceed the one million vertex editor safety limit.");
	}
	const result = setMeshVertexData(scene, { nodeId: current.node.id, positions: current.positions, uvs: current.uvs, indices: current.indices }, options);
	return { ...result, levels, triangleCount: current.indices.length / 3 };
}

/**
 * Applies editor primitive geometry parameters and rebuilds its vertex data.
 */
export function setMeshGeometry(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}

	if (!node.metadata?.type) {
		throw new Error(`Mesh "${node.name}" is not an editor primitive with editable geometry.`);
	}

	Object.assign(node.metadata, data.parameters);
	if (node.metadata.type === "Ground" && node.metadata.heightMapTexturePath) {
		throw new Error("Use set_ground_heightmap to change a heightmapped ground.");
	}

	rebuildMeshGeometry(node);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return getMeshGeometry(scene, { nodeId: node.id });
}

/**
 * Creates or clears a terrain heightmap using the same heightmap vertex-data path as the editor inspector.
 */
export async function setGroundHeightmap(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || node.metadata?.type !== "Ground") {
		throw new Error(`Node "${node.name}" is not an editor Ground mesh.`);
	}

	if (data.heightmapPath === null) {
		node.metadata.heightMapTexturePath = null;
		rebuildMeshGeometry(node);
	} else {
		const absolutePath = getProjectRelativeAssetPath(data.heightmapPath);
		const projectDirectory = dirname(projectConfiguration.path!);
		const image = sharp(absolutePath);
		const [imageMetadata, buffer] = await Promise.all([image.metadata(), image.raw().ensureAlpha(1).toBuffer()]);
		if (!imageMetadata.width || !imageMetadata.height) {
			throw new Error(`Unable to read dimensions for heightmap: ${data.heightmapPath}`);
		}

		Object.assign(node.metadata, {
			heightMapTexturePath: relative(projectDirectory, absolutePath),
			minHeight: data.minHeight ?? node.metadata.minHeight ?? 0,
			maxHeight: data.maxHeight ?? node.metadata.maxHeight ?? 150,
			alphaFilter: data.alphaFilter ?? node.metadata.alphaFilter ?? 0,
			colorFilter: data.colorFilter ?? node.metadata.colorFilter ?? [1, 1, 1],
			smoothFactor: data.smoothFactor ?? node.metadata.smoothFactor ?? 0,
		});
		if (data.width !== undefined) {
			node.metadata.width = data.width;
		}
		if (data.height !== undefined) {
			node.metadata.height = data.height;
		}
		if (data.subdivisions !== undefined) {
			node.metadata.subdivisions = data.subdivisions;
		}
		if (node.metadata.subdivisions <= 1) {
			node.metadata.subdivisions = 32;
		}

		const vertexData = CreateGroundFromHeightMapVertexData({
			width: node.metadata.width,
			height: node.metadata.height,
			subdivisions: node.metadata.subdivisions,
			alphaFilter: node.metadata.alphaFilter,
			minHeight: node.metadata.minHeight,
			maxHeight: node.metadata.maxHeight,
			colorFilter: Color3.FromArray(node.metadata.colorFilter),
			bufferWidth: imageMetadata.width,
			bufferHeight: imageMetadata.height,
			buffer,
		});
		smoothGroundGeometry({
			ground: node,
			indices: vertexData.indices,
			normals: vertexData.normals,
			positions: vertexData.positions,
			subdivisions: node.metadata.subdivisions,
			smoothFactor: node.metadata.smoothFactor,
		});
		node.geometry?.setAllVerticesData(vertexData, false);
		node.refreshBoundingInfo({ updatePositionsArray: true });
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getMeshGeometry(scene, { nodeId: node.id });
}

/** Returns the persisted grid and height range of an editor Ground used as terrain. */
export function getTerrain(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || node.metadata?.type !== "Ground") {
		throw new Error(`Node "${node.name}" is not an editor Ground terrain.`);
	}

	const positions = node.getVerticesData(VertexBuffer.PositionKind, false);
	if (!positions) {
		throw new Error(`Terrain "${node.name}" has no editable position data.`);
	}
	let minHeight = Number.POSITIVE_INFINITY;
	let maxHeight = Number.NEGATIVE_INFINITY;
	for (let index = 1; index < positions.length; index += 3) {
		minHeight = Math.min(minHeight, positions[index]);
		maxHeight = Math.max(maxHeight, positions[index]);
	}

	return {
		node: toNodeSummary(node),
		terrain: {
			width: node.metadata.width,
			height: node.metadata.height,
			subdivisions: node.metadata.subdivisions,
			heightMapTexturePath: node.metadata.heightMapTexturePath ?? null,
			holes: node.metadata.terrainHoles ?? [],
			scatter: node.metadata.terrainScatter ?? [],
			detailLayers: node.metadata.terrainDetailLayers ?? [],
			minHeight,
			maxHeight,
			vertexCount: positions.length / 3,
		},
	};
}

/**
 * Paints a Unity-style terrain detail layer as efficient instances. Repainting the same layer
 * replaces only instances under the brush, so neighbouring strokes remain editable and persisted.
 */
export function paintTerrainDetails(scene: Scene, data: any, options: IMCPActionOptions): any {
	const terrain = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const source = resolveNode({ scene, nodeId: data.sourceNodeId, nodeName: data.sourceNodeName });
	if (!isMesh(terrain) || terrain.metadata?.type !== "Ground") {
		throw new Error(`Node "${terrain.name}" is not an editor Ground terrain.`);
	}
	if (!isMesh(source)) {
		throw new Error(`Node "${source.name}" is not a Mesh and cannot be painted as terrain detail.`);
	}
	const center = data.center;
	if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
		throw new Error("Terrain detail center must be a finite local [x, z] coordinate.");
	}
	if (!Number.isFinite(data.radius) || data.radius <= 0) {
		throw new Error("Terrain detail radius must be greater than zero.");
	}
	if (!Number.isFinite(data.density) || data.density < 0) {
		throw new Error("Terrain detail density must be zero or greater (instances per square meter).");
	}
	const minScale = data.minScale ?? 1;
	const maxScale = data.maxScale ?? minScale;
	if (!(minScale > 0) || !(maxScale >= minScale)) {
		throw new Error("Terrain detail scale must be positive and maxScale must be at least minScale.");
	}
	const width = terrain.metadata.width;
	const depth = terrain.metadata.height;
	const subdivisions = terrain.metadata.subdivisions;
	const positions = terrain.getVerticesData(VertexBuffer.PositionKind, false);
	if (!(width > 0) || !(depth > 0) || !Number.isInteger(subdivisions) || subdivisions < 1 || !positions) {
		throw new Error(`Terrain "${terrain.name}" has invalid editable grid data.`);
	}
	const layerId = data.layerId ?? `${source.id}-details`;
	const radiusSquared = data.radius * data.radius;
	const inverseWorld = terrain.getWorldMatrix().clone().invert();
	scene.meshes
		.filter((mesh) => mesh.metadata?.babylonEditorTerrainDetail?.terrainId === terrain.id && mesh.metadata?.babylonEditorTerrainDetail?.layerId === layerId)
		.filter((mesh) => {
			const local = Vector3.TransformCoordinates(mesh.position, inverseWorld);
			const dx = local.x - center[0],
				dz = local.z - center[1];
			return dx * dx + dz * dz <= radiusSquared;
		})
		.forEach((mesh) => mesh.dispose(false, false));
	const count = Math.min(10000, Math.round((data.density * (Math.PI * radiusSquared)) / 10000));
	const seed = Number.isInteger(data.seed) ? data.seed : 12345;
	let randomState = seed >>> 0;
	const random = (): number => {
		randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
		return randomState / 0x100000000;
	};
	const gridSize = subdivisions + 1;
	terrain.computeWorldMatrix(true);
	const instances: InstancedMesh[] = [];
	for (let index = 0; index < count; index++) {
		const angle = random() * Math.PI * 2;
		const distance = Math.sqrt(random()) * data.radius;
		const localX = Math.max(-width / 2, Math.min(width / 2, center[0] + Math.cos(angle) * distance));
		const localZ = Math.max(-depth / 2, Math.min(depth / 2, center[1] + Math.sin(angle) * distance));
		const gridX = Math.max(0, Math.min(subdivisions, Math.round(((localX + width / 2) / width) * subdivisions)));
		const gridZ = Math.max(0, Math.min(subdivisions, Math.round(((localZ + depth / 2) / depth) * subdivisions)));
		const localY = positions[(gridZ * gridSize + gridX) * 3 + 1];
		const instance = createMeshInstance(options.editor, source);
		instance.name = `${data.name ?? `${source.name} Detail`} ${index + 1}`;
		instance.position.copyFrom(Vector3.TransformCoordinates(new Vector3(localX, localY, localZ), terrain.getWorldMatrix()));
		instance.rotation.y = random() * Math.PI * 2;
		instance.scaling.scaleInPlace(minScale + random() * (maxScale - minScale));
		instance.metadata ??= {};
		instance.metadata.babylonEditorTerrainDetail = { terrainId: terrain.id, sourceId: source.id, layerId, seed, localPosition: [localX, localZ] };
		instances.push(instance);
	}
	terrain.metadata.terrainDetailLayers ??= [];
	const layers = terrain.metadata.terrainDetailLayers as any[];
	const layer = { layerId, sourceId: source.id, density: data.density, minScale, maxScale, seed };
	const existing = layers.findIndex((value) => value.layerId === layerId);
	if (existing < 0) {
		layers.push(layer);
	} else {
		layers[existing] = layer;
	}
	options.editor.layout.graph.refresh().then(() => instances.length && options.editor.layout.graph.setSelectedNode(instances[instances.length - 1]));
	options.editor.layout.inspector.setEditedObject(terrain);
	options.editor.layout.inspector.forceUpdate();
	return { ...getTerrain(scene, { nodeId: terrain.id }), layerId, paintedInstances: instances.map((instance) => toNodeSummary(instance)) };
}

/** Removes terrain triangles whose local-space centroid falls inside a circular hole brush. */
export function carveTerrainHole(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || node.metadata?.type !== "Ground") {
		throw new Error(`Node "${node.name}" is not an editor Ground terrain.`);
	}
	const positions = node.getVerticesData(VertexBuffer.PositionKind, false);
	const indices = node.getIndices(false);
	if (!positions || !indices) {
		throw new Error(`Terrain "${node.name}" has no editable geometry.`);
	}
	const center = data.center;
	const radius = data.radius;
	if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
		throw new Error("Terrain hole center must be a finite local [x, z] coordinate.");
	}
	if (!Number.isFinite(radius) || radius <= 0) {
		throw new Error("Terrain hole radius must be greater than zero.");
	}
	const result: number[] = [];
	let removedTriangles = 0;
	for (let index = 0; index < indices.length; index += 3) {
		const vertices = [indices[index], indices[index + 1], indices[index + 2]];
		const x = vertices.reduce((total, vertex) => total + positions[vertex * 3], 0) / 3;
		const z = vertices.reduce((total, vertex) => total + positions[vertex * 3 + 2], 0) / 3;
		if (Math.hypot(x - center[0], z - center[1]) < radius) {
			removedTriangles++;
		} else {
			result.push(...vertices);
		}
	}
	if (!removedTriangles) {
		return { ...getTerrain(scene, { nodeId: node.id }), removedTriangles: 0 };
	}
	const normals = node.getVerticesData(VertexBuffer.NormalKind, false) ?? new Float32Array(positions.length);
	VertexData.ComputeNormals(positions, result, normals);
	node.setIndices(result, null, true);
	node.setVerticesData(VertexBuffer.NormalKind, normals, true);
	node.refreshBoundingInfo({ updatePositionsArray: true });
	node.metadata.terrainHoles ??= [];
	node.metadata.terrainHoles.push({ center: [...center], radius });
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { ...getTerrain(scene, { nodeId: node.id }), removedTriangles };
}

/** Applies a deterministic circular sculpt brush to an editor Ground terrain in local coordinates. */
export function sculptTerrain(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || node.metadata?.type !== "Ground") {
		throw new Error(`Node "${node.name}" is not an editor Ground terrain.`);
	}

	const positions = node.getVerticesData(VertexBuffer.PositionKind, false);
	const indices = node.getIndices(false);
	if (!positions || !indices) {
		throw new Error(`Terrain "${node.name}" has no editable geometry.`);
	}
	const center = data.center;
	const radius = data.radius;
	const strength = data.strength;
	if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
		throw new Error("Terrain brush center must be a finite local [x, z] coordinate.");
	}
	if (!Number.isFinite(radius) || radius <= 0) {
		throw new Error("Terrain brush radius must be greater than zero.");
	}
	if (!Number.isFinite(strength) || strength < 0) {
		throw new Error("Terrain brush strength must be zero or greater.");
	}

	const mode = data.mode ?? "raise";
	if (!["raise", "lower", "flatten", "smooth"].includes(mode)) {
		throw new Error(`Unsupported terrain brush mode "${mode}".`);
	}
	if (mode === "flatten" && !Number.isFinite(data.targetHeight)) {
		throw new Error("Flatten terrain brushes require a finite targetHeight.");
	}
	const original = Array.from(positions);
	const subdivisions = node.metadata.subdivisions;
	const gridSize = subdivisions + 1;
	let changedVertices = 0;

	for (let vertex = 0; vertex < positions.length / 3; vertex++) {
		const offset = vertex * 3;
		const distance = Math.hypot(original[offset] - center[0], original[offset + 2] - center[1]);
		if (distance > radius) {
			continue;
		}
		const falloff = 1 - distance / radius;
		let height = original[offset + 1];
		if (mode === "raise") {
			height += strength * falloff;
		}
		if (mode === "lower") {
			height -= strength * falloff;
		}
		if (mode === "flatten") {
			height += (data.targetHeight - height) * Math.min(1, strength) * falloff;
		}
		if (mode === "smooth") {
			const x = vertex % gridSize;
			const z = Math.floor(vertex / gridSize);
			const neighbours: number[] = [];
			if (x > 0) {
				neighbours.push(original[(vertex - 1) * 3 + 1]);
			}
			if (x < subdivisions) {
				neighbours.push(original[(vertex + 1) * 3 + 1]);
			}
			if (z > 0) {
				neighbours.push(original[(vertex - gridSize) * 3 + 1]);
			}
			if (z < subdivisions) {
				neighbours.push(original[(vertex + gridSize) * 3 + 1]);
			}
			const average = neighbours.reduce((sum, value) => sum + value, 0) / neighbours.length;
			height += (average - height) * Math.min(1, strength) * falloff;
		}
		if (height !== positions[offset + 1]) {
			positions[offset + 1] = height;
			changedVertices++;
		}
	}

	const normals = node.getVerticesData(VertexBuffer.NormalKind, false) ?? new Float32Array(positions.length);
	VertexData.ComputeNormals(positions, indices, normals);
	node.setVerticesData(VertexBuffer.PositionKind, positions, true);
	node.setVerticesData(VertexBuffer.NormalKind, normals, true);
	node.refreshBoundingInfo({ updatePositionsArray: true });
	node.metadata.terrain = { version: 1, sculpted: true };
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { ...getTerrain(scene, { nodeId: node.id }), changedVertices };
}

/**
 * Scatters GPU-efficient instances across a Ground terrain. Positions are generated
 * deterministically from the supplied seed and sampled from the terrain's grid.
 */
export function scatterTerrainInstances(scene: Scene, data: any, options: IMCPActionOptions): any {
	const terrain = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const source = resolveNode({ scene, nodeId: data.sourceNodeId, nodeName: data.sourceNodeName });
	if (!isMesh(terrain) || terrain.metadata?.type !== "Ground") {
		throw new Error(`Node "${terrain.name}" is not an editor Ground terrain.`);
	}
	if (!isMesh(source)) {
		throw new Error(`Node "${source.name}" is not a Mesh and cannot be scattered.`);
	}
	const count = data.count ?? 100;
	if (!Number.isInteger(count) || count < 1 || count > 10000) {
		throw new Error("Terrain scatter count must be an integer between 1 and 10000.");
	}
	const minScale = data.minScale ?? 1;
	const maxScale = data.maxScale ?? minScale;
	if (!(minScale > 0) || !(maxScale >= minScale)) {
		throw new Error("Terrain scatter scale must be positive and maxScale must be at least minScale.");
	}
	const positions = terrain.getVerticesData(VertexBuffer.PositionKind, false);
	if (!positions) {
		throw new Error(`Terrain "${terrain.name}" has no editable position data.`);
	}
	const subdivisions = terrain.metadata.subdivisions;
	const width = terrain.metadata.width;
	const depth = terrain.metadata.height;
	if (!Number.isInteger(subdivisions) || subdivisions < 1 || !(width > 0) || !(depth > 0)) {
		throw new Error(`Terrain "${terrain.name}" has invalid grid metadata.`);
	}
	const scatterId = data.scatterId ?? `${source.id}-scatter`;
	const seed = Number.isInteger(data.seed) ? data.seed : 12345;
	const replaceExisting = data.replaceExisting ?? true;
	if (replaceExisting) {
		scene.meshes
			.filter((mesh) => mesh.metadata?.babylonEditorTerrainScatter?.terrainId === terrain.id && mesh.metadata?.babylonEditorTerrainScatter?.scatterId === scatterId)
			.forEach((mesh) => mesh.dispose(false, false));
	}

	let randomState = seed >>> 0;
	const random = (): number => {
		randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
		return randomState / 0x100000000;
	};
	const margin = Math.max(0, data.margin ?? 0);
	if (margin * 2 >= width || margin * 2 >= depth) {
		throw new Error("Terrain scatter margin must leave a positive placement area.");
	}
	const gridSize = subdivisions + 1;
	const instances: InstancedMesh[] = [];
	terrain.computeWorldMatrix(true);
	for (let index = 0; index < count; index++) {
		const localX = -width / 2 + margin + random() * (width - margin * 2);
		const localZ = -depth / 2 + margin + random() * (depth - margin * 2);
		const gridX = Math.max(0, Math.min(subdivisions, Math.round(((localX + width / 2) / width) * subdivisions)));
		const gridZ = Math.max(0, Math.min(subdivisions, Math.round(((localZ + depth / 2) / depth) * subdivisions)));
		const localY = positions[(gridZ * gridSize + gridX) * 3 + 1];
		const world = Vector3.TransformCoordinates(new Vector3(localX, localY, localZ), terrain.getWorldMatrix());
		const instance = createMeshInstance(options.editor, source);
		instance.name = `${data.name ?? `${source.name} Scatter`} ${index + 1}`;
		instance.position.copyFrom(world);
		instance.rotation.y = random() * Math.PI * 2;
		const scale = minScale + random() * (maxScale - minScale);
		instance.scaling.scaleInPlace(scale);
		instance.metadata ??= {};
		instance.metadata.babylonEditorTerrainScatter = { terrainId: terrain.id, sourceId: source.id, scatterId, seed, index };
		instances.push(instance);
	}
	terrain.metadata.terrainScatter ??= [];
	if (replaceExisting) {
		terrain.metadata.terrainScatter = terrain.metadata.terrainScatter.filter((entry: any) => entry.scatterId !== scatterId);
	}
	terrain.metadata.terrainScatter.push({ scatterId, sourceId: source.id, count, seed, minScale, maxScale, margin });
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(instances[instances.length - 1]));
	options.editor.layout.inspector.setEditedObject(terrain);
	options.editor.layout.inspector.forceUpdate();
	return { ...getTerrain(scene, { nodeId: terrain.id }), scatter: terrain.metadata.terrainScatter, instances: instances.map((instance) => toNodeSummary(instance)) };
}

/**
 * Creates one or more InstancedMesh from a source mesh.
 * Uses the editor's `createMeshInstance` helper so each instance gets a proper id/uniqueId, copied
 * transform/visibility/enabled state, and is correctly wired into collision meshes and shadow maps
 * (this is what the editor inspector relies on to display the instance's properties).
 * By default each instance shares the source mesh's parent so the scene hierarchy stays easy to read.
 */
export function createInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = resolveNode({ scene, nodeId: data.sourceNodeId, nodeName: data.sourceNodeName });

	if (!isMesh(source)) {
		throw new Error(`Source node "${source.name}" is not a Mesh and cannot be instanced.`);
	}

	const sourceMesh = source as Mesh;
	const editor = options.editor;

	// An explicit parent overrides the default (the source mesh's own parent). `undefined` means "not provided".
	const explicitParent = data.parentId || data.parentName ? resolveOptionalParent(scene, data) : undefined;

	const transforms: any[] = data.transforms ?? [];
	const total = Math.max(data.count ?? transforms.length ?? 1, transforms.length, 1);

	const instances: any[] = [];

	for (let i = 0; i < total; ++i) {
		const instance = createMeshInstance(editor, sourceMesh);

		if (data.name) {
			instance.name = total > 1 ? `${data.name} ${i}` : data.name;
		}

		// Default to the source mesh's parent (set by createMeshInstance); honor an explicit parent if provided.
		if (explicitParent !== undefined) {
			instance.parent = explicitParent ?? null;
		}

		const transform = transforms[i];
		if (transform) {
			if (transform.position) {
				instance.position.copyFrom(toVector3(transform.position));
			}
			if (transform.rotation) {
				instance.rotation.copyFrom(toVector3(transform.rotation));
			}
			if (transform.scaling) {
				instance.scaling.copyFrom(toVector3(transform.scaling));
			}
		}

		instances.push(instance);
	}

	options.editor.layout.graph.refresh().then(() => {
		options.editor.layout.graph.setSelectedNode(instances[instances.length - 1]);
	});
	options.editor.layout.inspector.setEditedObject(instances[instances.length - 1]);

	return { instances: instances.map((instance) => toNodeSummary(instance)) };
}

/**
 * Clones a mesh. When `cloneGeometry` is false (default), the geometry is shared with the source.
 */
export function cloneMesh(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = resolveNode({ scene, nodeId: data.sourceNodeId, nodeName: data.sourceNodeName });

	if (!isMesh(source)) {
		throw new Error(`Source node "${source.name}" is not a Mesh and cannot be cloned.`);
	}

	const sourceMesh = source as Mesh;
	const cloneGeometry = data.cloneGeometry ?? false;

	// Mesh.clone shares the source geometry by reference (no duplication).
	const clone = sourceMesh.clone(data.name ?? `${sourceMesh.name} (Clone)`, sourceMesh.parent, true);

	// Only duplicate the geometry when explicitly requested.
	if (cloneGeometry) {
		clone.makeGeometryUnique();
	}

	options.editor.layout.graph.refresh().then(() => {
		options.editor.layout.graph.setSelectedNode(clone);
	});
	options.editor.layout.inspector.setEditedObject(clone);

	return toNodeSummary(clone);
}

/**
 * Lists the LOD meshes assigned to a source mesh.
 */
export function getMeshLODs(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh and cannot have LOD levels.`);
	}

	return {
		source: toNodeSummary(node),
		lods: node.getLODLevels().map((lod) => ({
			distance: lod.distanceOrScreenCoverage ?? 0,
			mesh: lod.mesh ? toNodeSummary(lod.mesh) : null,
			includedInExport: lod.mesh?.metadata?.doNotSerialize !== true,
		})),
	};
}

/**
 * Replaces a mesh's complete LOD configuration with named/id-addressable meshes.
 */
export function setMeshLODs(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(source)) {
		throw new Error(`Node "${source.name}" is not a Mesh and cannot have LOD levels.`);
	}

	const lods = data.lods ?? [];
	const resolved = lods.map((lod: any) => {
		const mesh = resolveNode({ scene, nodeId: lod.meshNodeId, nodeName: lod.meshNodeName });
		if (!isMesh(mesh) || mesh === source) {
			throw new Error("Each LOD must reference a different Mesh node.");
		}

		return { mesh, distance: lod.distance, includedInExport: lod.includedInExport ?? true };
	});

	if (new Set(resolved.map((lod) => lod.mesh.id)).size !== resolved.length) {
		throw new Error("A mesh can only be assigned once in an LOD configuration.");
	}

	if (resolved.some((lod) => !Number.isFinite(lod.distance) || lod.distance < 0)) {
		throw new Error("Each LOD distance must be a non-negative finite number.");
	}

	source.getLODLevels().forEach((lod) => {
		if (lod.mesh) {
			source.removeLODLevel(lod.mesh);
		}
	});

	resolved
		.sort((a, b) => a.distance - b.distance)
		.forEach((lod) => {
			lod.mesh.parent = null;
			lod.mesh.position.set(0, 0, 0);
			lod.mesh.rotation.set(0, 0, 0);
			lod.mesh.scaling.set(1, 1, 1);
			if (lod.mesh.rotationQuaternion) {
				lod.mesh.rotationQuaternion.set(0, 0, 0, 1);
			}
			lod.mesh.metadata ??= {};
			lod.mesh.metadata.doNotSerialize = !lod.includedInExport;
			source.addLODLevel(lod.distance, lod.mesh);
		});

	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(source));
	options.editor.layout.inspector.setEditedObject(source);

	return getMeshLODs(scene, { nodeId: source.id });
}

/**
 * Reads the editor collision-mesh setup attached to a mesh.
 */
export function getMeshCollision(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh and cannot have an editor collision mesh.`);
	}

	const collisionMesh = getCollisionMeshFor(node);
	return {
		checkCollisions: node.checkCollisions,
		collisionMesh: collisionMesh
			? {
					...toNodeSummary(collisionMesh),
					type: collisionMesh.type,
				}
			: null,
	};
}

/**
 * Enables collision checks and creates, replaces, or removes the editor collision mesh.
 */
export async function setMeshCollision(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh and cannot have an editor collision mesh.`);
	}

	const current = getCollisionMeshFor(node);
	const type = data.type as CollisionMeshType;
	if (type === "none") {
		current?.dispose();
		node.checkCollisions = false;
	} else {
		current?.dispose(false, false);
		const collisionMesh = new CollisionMesh(`${node.name} Collider`, scene, node);
		await collisionMesh.setType(type, node);
		node.checkCollisions = true;
	}

	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(node));
	options.editor.layout.inspector.setEditedObject(node);

	return getMeshCollision(scene, { nodeId: node.id });
}

/**
 * Creates a persisted decal mesh projected onto a source Mesh.
 */
const defaultProjectorChannels = { albedo: true, normal: false, metallic: false, ambientOcclusion: false, emissive: false } as const;

function projectorChannels(value: unknown, fallback: Record<string, boolean> = defaultProjectorChannels): Record<string, boolean> {
	const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const channels = {
		albedo: typeof source.albedo === "boolean" ? source.albedo : Boolean(fallback.albedo),
		normal: typeof source.normal === "boolean" ? source.normal : Boolean(fallback.normal),
		metallic: typeof source.metallic === "boolean" ? source.metallic : Boolean(fallback.metallic),
		ambientOcclusion: typeof source.ambientOcclusion === "boolean" ? source.ambientOcclusion : Boolean(fallback.ambientOcclusion),
		emissive: typeof source.emissive === "boolean" ? source.emissive : Boolean(fallback.emissive),
	};
	if (!Object.values(channels).some(Boolean)) {
		throw new Error("A screen-space volume projector must enable at least one albedo, normal, metallic, ambientOcclusion, or emissive channel.");
	}
	return channels;
}

export function createDecal(scene: Scene, data: any, options: IMCPActionOptions): any {
	const projectionMode = data.projectionMode === "screen-space-volume" ? "screen-space-volume" : "geometry";
	const screenSpaceFields = [
		"rotation",
		"edgeFade",
		"uvScale",
		"uvOffset",
		"channels",
		"normalStrength",
		"metallic",
		"smoothness",
		"ambientOcclusion",
		"emissiveIntensity",
		"decalLayerMask",
	];
	if (projectionMode === "geometry" && screenSpaceFields.some((field) => data[field] !== undefined)) {
		throw new Error("Geometry decals do not accept screen-space projector rotation, edge/UV, material-channel, or Decal Layer settings.");
	}
	const material = resolveMaterial({ scene, materialId: data.materialId });
	const position = toVector3(data.position);
	const size = toVector3(data.size ?? [100, 100, 100]);
	if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
		throw new Error("Decal width, height, and depth must all be greater than zero.");
	}
	if (projectionMode === "screen-space-volume") {
		const rotation = data.rotation ? toVector3(data.rotation) : Vector3.Zero();
		const channels = projectorChannels(data.channels);
		const projector = MeshBuilder.CreateBox(data.name ?? `${material.name} Projector`, { size: 1 }, scene);
		projector.position.copyFrom(position);
		projector.rotation.copyFrom(rotation);
		projector.scaling.copyFrom(size);
		projector.material = material;
		projector.isVisible = false;
		projector.isPickable = true;
		projector.receiveShadows = false;
		projector.alphaIndex = data.alphaIndex ?? 0;
		projector.renderingGroupId = 0;
		projector.metadata = {
			decal: {
				version: 3,
				revision: 1,
				projectionMode,
				sizeX: size.x,
				sizeY: size.y,
				sizeZ: size.z,
				position: position.asArray(),
				rotation: rotation.asArray(),
				edgeFade: data.edgeFade ?? 0,
				uvScale: data.uvScale ?? [1, 1],
				uvOffset: data.uvOffset ?? [0, 0],
				channels,
				normalStrength: data.normalStrength ?? 1,
				metallic: data.metallic ?? 0,
				smoothness: data.smoothness ?? 0.5,
				ambientOcclusion: data.ambientOcclusion ?? 1,
				emissiveIntensity: data.emissiveIntensity ?? 1,
				decalLayerMask: data.decalLayerMask === undefined ? 0xffffffff : data.decalLayerMask >>> 0,
			},
		};
		projector.computeWorldMatrix(true);
		options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(projector));
		options.editor.layout.inspector.setEditedObject(projector);
		return getDecal(scene, { nodeId: projector.id });
	}

	const source = resolveNode({ scene, nodeId: data.sourceNodeId, nodeName: data.sourceNodeName });
	if (!isMesh(source)) {
		throw new Error(`Node "${source.name}" is not a Mesh and cannot receive a decal.`);
	}
	if (source.metadata?.decal) {
		throw new Error("A decal cannot use another decal as its projection source.");
	}
	const normal = data.normal ? toVector3(data.normal) : undefined;
	const decal = MeshBuilder.CreateDecal(data.name ?? `${material.name} Decal`, source, {
		localMode: true,
		angle: data.angle ?? 0,
		position,
		normal,
		size,
	});
	if (!decal.geometry || decal.getTotalVertices() === 0 || decal.getTotalIndices() === 0) {
		decal.dispose(false, false);
		throw new Error(`The decal projection did not intersect source mesh "${source.name}". Move the projection position onto the surface or increase its depth.`);
	}
	decal.material = material;
	decal.isPickable = false;
	decal.receiveShadows = true;
	decal.alphaIndex = data.alphaIndex ?? 0;
	decal.renderingGroupId = data.renderingGroupId ?? 0;
	decal.metadata = {
		decal: {
			version: 1,
			revision: 1,
			projectionMode: "geometry",
			angle: data.angle ?? 0,
			sizeX: size.x,
			sizeY: size.y,
			sizeZ: size.z,
			meshId: source.id,
			position: position.asArray(),
			normal: normal?.asArray(),
		},
	};

	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(decal));
	options.editor.layout.inspector.setEditedObject(decal);
	return getDecal(scene, { nodeId: decal.id });
}

function decalResult(scene: Scene, node: Mesh): any {
	const configuration = node.metadata.decal;
	const projectionMode = configuration.projectionMode === "screen-space-volume" ? "screen-space-volume" : "geometry";
	const source = typeof configuration.meshId === "string" ? scene.getMeshById(configuration.meshId) : null;
	return {
		node: toNodeSummary(node),
		projectionMode,
		version: Number.isInteger(configuration.version) && configuration.version > 0 ? configuration.version : 1,
		revision: Number.isInteger(configuration.revision) && configuration.revision > 0 ? configuration.revision : 1,
		angle: Number.isFinite(configuration.angle) ? configuration.angle : 0,
		sizeX: Number.isFinite(configuration.sizeX) ? configuration.sizeX : null,
		sizeY: Number.isFinite(configuration.sizeY) ? configuration.sizeY : null,
		sizeZ: Number.isFinite(configuration.sizeZ) ? configuration.sizeZ : null,
		meshId: configuration.meshId ?? null,
		sourceMesh: source ? toNodeSummary(source) : null,
		position: projectionMode === "screen-space-volume" ? node.getAbsolutePosition().asArray() : Array.isArray(configuration.position) ? [...configuration.position] : null,
		normal: projectionMode === "geometry" && Array.isArray(configuration.normal) ? [...configuration.normal] : null,
		rotation: projectionMode === "screen-space-volume" ? node.rotation.asArray() : null,
		edgeFade: projectionMode === "screen-space-volume" && Number.isFinite(configuration.edgeFade) ? configuration.edgeFade : 0,
		uvScale: projectionMode === "screen-space-volume" && Array.isArray(configuration.uvScale) ? [...configuration.uvScale] : [1, 1],
		uvOffset: projectionMode === "screen-space-volume" && Array.isArray(configuration.uvOffset) ? [...configuration.uvOffset] : [0, 0],
		channels: projectionMode === "screen-space-volume" ? projectorChannels(configuration.channels) : null,
		normalStrength: projectionMode === "screen-space-volume" && Number.isFinite(configuration.normalStrength) ? configuration.normalStrength : null,
		metallic: projectionMode === "screen-space-volume" && Number.isFinite(configuration.metallic) ? configuration.metallic : null,
		smoothness: projectionMode === "screen-space-volume" && Number.isFinite(configuration.smoothness) ? configuration.smoothness : null,
		ambientOcclusion: projectionMode === "screen-space-volume" && Number.isFinite(configuration.ambientOcclusion) ? configuration.ambientOcclusion : null,
		emissiveIntensity: projectionMode === "screen-space-volume" && Number.isFinite(configuration.emissiveIntensity) ? configuration.emissiveIntensity : null,
		decalLayerMask: projectionMode === "screen-space-volume" ? (Number.isInteger(configuration.decalLayerMask) ? configuration.decalLayerMask >>> 0 : 0xffffffff) : null,
		materialId: node.material?.id ?? null,
		materialName: node.material?.name ?? null,
		vertexCount: projectionMode === "geometry" ? node.getTotalVertices() : 0,
		indexCount: projectionMode === "geometry" ? node.getTotalIndices() : 0,
		alphaIndex: node.alphaIndex,
		renderingGroupId: node.renderingGroupId,
		deferredCameras: getDeferredLightingRuntimes(scene as any),
	};
}

/** Lists persisted decal meshes with bounded pagination and current deferred execution evidence. */
export function listDecals(scene: Scene, data: any): any {
	const search = typeof data.search === "string" ? data.search.trim().toLowerCase() : "";
	const offset = Number.isInteger(data.offset) ? Math.max(0, data.offset) : 0;
	const limit = Number.isInteger(data.limit) ? Math.max(1, Math.min(100, data.limit)) : 50;
	const all = scene.meshes
		.filter((mesh): mesh is Mesh => isMesh(mesh) && Boolean(mesh.metadata?.decal))
		.filter((mesh) => !search || mesh.name.toLowerCase().includes(search) || mesh.id.toLowerCase().includes(search))
		.sort((left, right) => left.name.localeCompare(right.name) || left.uniqueId - right.uniqueId);
	const decals = all.slice(offset, offset + limit).map((mesh) => {
		const result = decalResult(scene, mesh);
		delete result.deferredCameras;
		return result;
	});
	return {
		totalCount: all.length,
		count: decals.length,
		offset,
		limit,
		hasMore: offset + decals.length < all.length,
		nextOffset: offset + decals.length < all.length ? offset + decals.length : null,
		decals,
		deferredCameras: getDeferredLightingRuntimes(scene as any),
	};
}

/**
 * Gets persisted decal parameters for a decal mesh.
 */
export function getDecal(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || !node.metadata?.decal) {
		throw new Error(`Node "${node.name}" is not an editor decal mesh.`);
	}

	return decalResult(scene, node);
}

/**
 * Updates persisted decal parameters and regenerates the decal geometry.
 */
export function setDecal(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || !node.metadata?.decal) {
		throw new Error(`Node "${node.name}" is not an editor decal mesh.`);
	}

	const configuration = node.metadata.decal;
	const revision = Number.isInteger(configuration.revision) && configuration.revision > 0 ? configuration.revision : 1;
	if (data.expectedRevision !== undefined && data.expectedRevision !== revision) {
		throw new Error(`Decal revision is stale: expected ${data.expectedRevision}, current ${revision}. Call get_decal and retry with the current revision.`);
	}
	const projectionMode = configuration.projectionMode === "screen-space-volume" ? "screen-space-volume" : "geometry";
	if (data.projectionMode !== undefined && data.projectionMode !== projectionMode) {
		throw new Error("A decal projectionMode is immutable. Create a replacement decal to switch between projected geometry and a screen-space volume.");
	}
	if (projectionMode === "screen-space-volume") {
		if (data.sourceNodeId || data.sourceNodeName || data.normal !== undefined || data.angle !== undefined) {
			throw new Error(
				"Screen-space volume projectors do not use sourceNodeId, sourceNodeName, normal, or angle; edit position, rotation, size, edgeFade, and UV controls instead."
			);
		}
		const material = data.materialId ? resolveMaterial({ scene, materialId: data.materialId }) : node.material;
		if (!material) {
			throw new Error("The decal projector has no material. Provide materialId.");
		}
		const size = data.size ? toVector3(data.size) : new Vector3(configuration.sizeX, configuration.sizeY, configuration.sizeZ);
		if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
			throw new Error("Decal width, height, and depth must all be greater than zero.");
		}
		const position = data.position ? toVector3(data.position) : node.position.clone();
		const rotation = data.rotation ? toVector3(data.rotation) : node.rotation.clone();
		const channels = projectorChannels(data.channels, projectorChannels(configuration.channels));
		node.position.copyFrom(position);
		node.rotation.copyFrom(rotation);
		node.scaling.copyFrom(size);
		node.material = material;
		if (data.name !== undefined) {
			node.name = data.name;
		}
		if (data.alphaIndex !== undefined) {
			node.alphaIndex = data.alphaIndex;
		}
		node.renderingGroupId = 0;
		node.metadata.decal = {
			...configuration,
			version: 3,
			revision: revision + 1,
			projectionMode,
			sizeX: size.x,
			sizeY: size.y,
			sizeZ: size.z,
			position: position.asArray(),
			rotation: rotation.asArray(),
			edgeFade: data.edgeFade ?? configuration.edgeFade ?? 0,
			uvScale: data.uvScale ?? configuration.uvScale ?? [1, 1],
			uvOffset: data.uvOffset ?? configuration.uvOffset ?? [0, 0],
			channels,
			normalStrength: data.normalStrength ?? configuration.normalStrength ?? 1,
			metallic: data.metallic ?? configuration.metallic ?? 0,
			smoothness: data.smoothness ?? configuration.smoothness ?? 0.5,
			ambientOcclusion: data.ambientOcclusion ?? configuration.ambientOcclusion ?? 1,
			emissiveIntensity: data.emissiveIntensity ?? configuration.emissiveIntensity ?? 1,
			decalLayerMask:
				data.decalLayerMask === undefined ? (Number.isInteger(configuration.decalLayerMask) ? configuration.decalLayerMask >>> 0 : 0xffffffff) : data.decalLayerMask >>> 0,
		};
		node.computeWorldMatrix(true);
		options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(node));
		options.editor.layout.inspector.setEditedObject(node);
		return getDecal(scene, { nodeId: node.id });
	}
	const screenSpaceFields = [
		"rotation",
		"edgeFade",
		"uvScale",
		"uvOffset",
		"channels",
		"normalStrength",
		"metallic",
		"smoothness",
		"ambientOcclusion",
		"emissiveIntensity",
		"decalLayerMask",
	];
	if (screenSpaceFields.some((field) => data[field] !== undefined)) {
		throw new Error("Geometry decals do not accept screen-space projector rotation, edge/UV, material-channel, or Decal Layer settings.");
	}
	const source =
		data.sourceNodeId || data.sourceNodeName ? resolveNode({ scene, nodeId: data.sourceNodeId, nodeName: data.sourceNodeName }) : scene.getMeshById(configuration.meshId);
	if (!source) {
		throw new Error(`The decal source mesh "${configuration.meshId}" no longer exists.`);
	}
	if (!isMesh(source)) {
		throw new Error(`Node "${source.name}" is not a Mesh and cannot receive a decal.`);
	}
	if (source.metadata?.decal) {
		throw new Error("A decal cannot use another decal as its projection source.");
	}
	const material = data.materialId ? resolveMaterial({ scene, materialId: data.materialId }) : node.material;
	if (!material) {
		throw new Error("The decal has no material. Provide materialId.");
	}
	const size = data.size ? toVector3(data.size) : new Vector3(configuration.sizeX, configuration.sizeY, configuration.sizeZ);
	if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
		throw new Error("Decal width, height, and depth must all be greater than zero.");
	}
	const position = data.position ? toVector3(data.position) : Vector3.FromArray(configuration.position);
	const normal = data.normal === null ? undefined : data.normal ? toVector3(data.normal) : configuration.normal ? Vector3.FromArray(configuration.normal) : undefined;
	const angle = data.angle ?? configuration.angle;

	const generated = MeshBuilder.CreateDecal("decal", source, {
		localMode: true,
		angle,
		size,
		position,
		normal,
	});
	if (!generated.geometry || generated.getTotalVertices() === 0 || generated.getTotalIndices() === 0) {
		generated.dispose(false, false);
		throw new Error(`The decal projection did not intersect source mesh "${source.name}". Move the projection position onto the surface or increase its depth.`);
	}
	node.geometry?.releaseForMesh(node);
	generated.geometry?.applyToMesh(node);
	generated.dispose(false, false);
	node.parent = source;
	node.material = material;
	if (data.name !== undefined) {
		node.name = data.name;
	}
	if (data.alphaIndex !== undefined) {
		node.alphaIndex = data.alphaIndex;
	}
	if (data.renderingGroupId !== undefined) {
		node.renderingGroupId = data.renderingGroupId;
	}
	node.metadata.decal = {
		...configuration,
		version: 1,
		revision: revision + 1,
		angle,
		sizeX: size.x,
		sizeY: size.y,
		sizeZ: size.z,
		meshId: source.id,
		position: position.asArray(),
		...(normal ? { normal: normal.asArray() } : { normal: undefined }),
	};

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getDecal(scene, { nodeId: node.id });
}

function resolveSkeleton(scene: Scene, data: any): Skeleton {
	const skeleton = data.skeletonId
		? scene.skeletons.find((candidate) => candidate.id === data.skeletonId)
		: scene.skeletons.find((candidate) => candidate.name === data.skeletonName);
	if (!skeleton) {
		throw new Error("Skeleton not found. Provide skeletonId (preferred) or skeletonName.");
	}
	return skeleton;
}

/**
 * Lists skeletons imported into the scene and their animation ranges.
 */
export function listSkeletons(scene: Scene): any {
	return {
		skeletons: scene.skeletons.map((skeleton) => ({
			id: skeleton.id,
			name: skeleton.name,
			needInitialSkinMatrix: skeleton.needInitialSkinMatrix,
			boneCount: skeleton.bones.length,
			animationRanges: skeleton.getAnimationRanges().filter(Boolean),
			meshIds: scene.meshes.filter((mesh) => mesh.skeleton === skeleton).map((mesh) => mesh.id),
		})),
	};
}

/**
 * Updates skeleton inspector properties and animation ranges.
 */
export function setSkeleton(scene: Scene, data: any, options: IMCPActionOptions): any {
	const skeleton = resolveSkeleton(scene, data);
	if (data.name !== undefined) {
		skeleton.name = data.name;
	}
	if (data.needInitialSkinMatrix !== undefined) {
		skeleton.needInitialSkinMatrix = data.needInitialSkinMatrix;
	}

	for (const range of data.createRanges ?? []) {
		skeleton.createAnimationRange(range.name, range.from, range.to);
	}
	for (const rangeName of data.deleteRangeNames ?? []) {
		skeleton.deleteAnimationRange(rangeName, false);
	}

	options.editor.layout.inspector.setEditedObject(skeleton);
	options.editor.layout.inspector.forceUpdate();
	return listSkeletons(scene).skeletons.find((candidate: any) => candidate.id === skeleton.id);
}

/**
 * Lists morph targets and influences on a mesh.
 */
export function getMeshMorphTargets(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}

	const manager = node.morphTargetManager;
	const targets: MorphTarget[] = [];
	if (manager) {
		for (let index = 0; index < manager.numTargets; index++) {
			targets.push(manager.getTarget(index));
		}
	}

	return { node: toNodeSummary(node), targets: targets.map((target, index) => ({ index, name: target.name, influence: target.influence })) };
}

/**
 * Sets one or more named/indexed morph-target influences on a mesh.
 */
export function setMeshMorphTargets(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || !node.morphTargetManager) {
		throw new Error(`Node "${node.name}" does not have morph targets.`);
	}

	for (const update of data.targets) {
		const target =
			update.index !== undefined
				? node.morphTargetManager.getTarget(update.index)
				: Array.from({ length: node.morphTargetManager.numTargets }, (_, index) => node.morphTargetManager!.getTarget(index)).find(
						(candidate) => candidate.name === update.name
					);
		if (!target) {
			throw new Error(`Morph target not found: ${update.name ?? update.index}`);
		}
		target.influence = update.influence;
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getMeshMorphTargets(scene, { nodeId: node.id });
}

/**
 * Assigns an existing material to a mesh.
 */
export function setMeshMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isAbstractMesh(node)) {
		throw new Error(`Node "${node.name}" is not a mesh.`);
	}

	const material = resolveMaterial({ scene, materialId: data.materialId });
	node.material = material;

	options.editor.layout.graph.setSelectedNode(node);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

/**
 * Toggles the visibility/enabled state of a mesh.
 */
export function setMeshVisibility(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isAbstractMesh(node)) {
		throw new Error(`Node "${node.name}" is not a mesh.`);
	}

	if (data.isVisible !== undefined) {
		node.isVisible = data.isVisible;
	}

	if (data.isEnabled !== undefined) {
		node.setEnabled(data.isEnabled);
	}

	if (data.visibility !== undefined) {
		node.visibility = data.visibility;
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

const physicsShapeTypes: Record<string, PhysicsShapeType> = {
	box: PhysicsShapeType.BOX,
	sphere: PhysicsShapeType.SPHERE,
	capsule: PhysicsShapeType.CAPSULE,
	cylinder: PhysicsShapeType.CYLINDER,
	mesh: PhysicsShapeType.MESH,
};

const physicsMotionTypes: Record<string, PhysicsMotionType> = {
	static: PhysicsMotionType.STATIC,
	dynamic: PhysicsMotionType.DYNAMIC,
	animated: PhysicsMotionType.ANIMATED,
};

/**
 * Returns a plain description of the physics setup currently attached to the given mesh.
 */
function describePhysics(mesh: AbstractMesh): any {
	const aggregate = mesh.physicsAggregate;
	if (!aggregate) {
		return null;
	}

	const massProperties = aggregate.body.getMassProperties();
	const shapeTypeName = Object.keys(physicsShapeTypes).find((key) => physicsShapeTypes[key] === aggregate.shape.type) ?? aggregate.shape.type;
	const motionTypeName = Object.keys(physicsMotionTypes).find((key) => physicsMotionTypes[key] === aggregate.body.getMotionType()) ?? aggregate.body.getMotionType();

	return {
		shapeType: shapeTypeName,
		motionType: motionTypeName,
		mass: massProperties.mass ?? 0,
		friction: aggregate.shape.material?.friction ?? null,
		restitution: aggregate.shape.material?.restitution ?? null,
	};
}

/**
 * Enables, disables and configures the Havok physics body of a mesh (mass, motion type, shape, friction, restitution).
 * This is the way to give a mesh real gameplay physics (gravity, collisions, impulses at runtime).
 */
export function setMeshPhysics(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isAbstractMesh(node)) {
		throw new Error(`Node "${node.name}" is not a mesh and cannot have a physics body.`);
	}

	const mesh = node as AbstractMesh;
	const enabled = data.enabled ?? true;

	if (!enabled) {
		if (mesh.physicsAggregate) {
			mesh.physicsAggregate.dispose();
		}
		mesh.physicsBody = null;
		mesh.physicsAggregate = null;
		if (mesh.metadata?.physicsAggregate) {
			delete mesh.metadata.physicsAggregate;
		}

		options.editor.layout.inspector.setEditedObject(mesh);
		options.editor.layout.inspector.forceUpdate();

		return { ...toNodeSummary(mesh), physics: null };
	}

	// Create the aggregate if missing, mirroring the editor inspector behavior.
	if (!mesh.physicsAggregate) {
		const shapeType = data.shapeType ? physicsShapeTypes[data.shapeType] : getPhysicsShapeForMesh(mesh);
		const aggregate = new PhysicsAggregate(mesh, shapeType ?? getPhysicsShapeForMesh(mesh), {
			mass: data.mass ?? 1,
		});
		aggregate.body.disableSync = true;
		mesh.physicsAggregate = aggregate;
	}

	const aggregate = mesh.physicsAggregate!;

	if (data.shapeType !== undefined) {
		const type = physicsShapeTypes[data.shapeType];
		if (type === undefined) {
			throw new Error(`Unknown physics shape type "${data.shapeType}". Supported: ${Object.keys(physicsShapeTypes).join(", ")}.`);
		}

		const shapeMesh = isInstancedMesh(mesh) ? mesh.sourceMesh : isMesh(mesh) ? (mesh as Mesh) : undefined;
		aggregate.shape = new PhysicsShape(
			{
				type,
				parameters: { mesh: type === PhysicsShapeType.MESH ? shapeMesh : undefined },
			},
			scene
		);
		aggregate.body.disableSync = true;
	}

	if (data.motionType !== undefined) {
		const motion = physicsMotionTypes[data.motionType];
		if (motion === undefined) {
			throw new Error(`Unknown physics motion type "${data.motionType}". Supported: ${Object.keys(physicsMotionTypes).join(", ")}.`);
		}
		aggregate.body.setMotionType(motion);
		aggregate.body.disableSync = true;
	}

	if (data.mass !== undefined) {
		aggregate.body.setMassProperties({ ...aggregate.body.getMassProperties(), mass: data.mass });
	}

	if (data.friction !== undefined || data.restitution !== undefined) {
		const material = { ...aggregate.shape.material };
		if (data.friction !== undefined) {
			material.friction = data.friction;
		}
		if (data.restitution !== undefined) {
			material.restitution = data.restitution;
		}
		aggregate.shape.material = material;
	}

	if (data.collisionGroup !== undefined || data.collisionMask !== undefined || data.collisionLayer !== undefined) {
		if (data.collisionLayer !== undefined && (data.collisionGroup !== undefined || data.collisionMask !== undefined)) {
			throw new Error("collisionLayer cannot be combined with collisionGroup or collisionMask. Use either a named layer or custom masks.");
		}
		const namedLayer = data.collisionLayer === undefined ? undefined : findPhysicsCollisionLayer(scene, data.collisionLayer);
		if (data.collisionLayer !== undefined && !namedLayer) {
			throw new Error(`Physics collision layer "${data.collisionLayer}" was not found in this scene.`);
		}
		if (data.collisionGroup !== undefined && (!Number.isInteger(data.collisionGroup) || data.collisionGroup < 0)) {
			throw new Error("collisionGroup must be a non-negative integer bitmask.");
		}
		if (data.collisionMask !== undefined && (!Number.isInteger(data.collisionMask) || data.collisionMask < 0)) {
			throw new Error("collisionMask must be a non-negative integer bitmask.");
		}
		if (namedLayer) {
			aggregate.shape.filterMembershipMask = namedLayer.bit;
			aggregate.shape.filterCollideMask = namedLayer.collidesWith;
		}
		if (data.collisionGroup !== undefined) {
			aggregate.shape.filterMembershipMask = data.collisionGroup;
		}
		if (data.collisionMask !== undefined) {
			aggregate.shape.filterCollideMask = data.collisionMask;
		}
		mesh.metadata ??= {};
		mesh.metadata.babylonEditorPhysicsCollisionFilter = { group: aggregate.shape.filterMembershipMask, mask: aggregate.shape.filterCollideMask };
		if (namedLayer) {
			mesh.metadata.babylonEditorPhysicsCollisionLayer = namedLayer.name;
		} else {
			delete mesh.metadata.babylonEditorPhysicsCollisionLayer;
		}
	}

	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.inspector.forceUpdate();

	return { ...toNodeSummary(mesh), physics: describePhysics(mesh) };
}

/**
 * Converts a Vector3 to a plain `[x,y,z]` array.
 */
function vec3(v: Vector3): [number, number, number] {
	return [v.x, v.y, v.z];
}

/**
 * Returns the bounding information of a mesh, in local and world space, plus the world-space bounds of
 * its whole hierarchy (children included). Useful to scatter objects without overlap (e.g. forests) and
 * to place meshes on the ground precisely.
 */
export function getMeshBoundingInfo(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isAbstractMesh(node)) {
		throw new Error(`Node "${node.name}" is not a mesh and has no bounding info.`);
	}

	const mesh = node as AbstractMesh;
	mesh.computeWorldMatrix(true);

	const boundingBox = mesh.getBoundingInfo().boundingBox;
	const hierarchy = mesh.getHierarchyBoundingVectors(true);

	const localSize = boundingBox.extendSize.scale(2);
	const worldSize = boundingBox.extendSizeWorld.scale(2);
	const hierarchySize = hierarchy.max.subtract(hierarchy.min);

	return {
		local: {
			min: vec3(boundingBox.minimum),
			max: vec3(boundingBox.maximum),
			center: vec3(boundingBox.center),
			size: vec3(localSize),
		},
		world: {
			min: vec3(boundingBox.minimumWorld),
			max: vec3(boundingBox.maximumWorld),
			center: vec3(boundingBox.centerWorld),
			size: vec3(worldSize),
		},
		hierarchyWorld: {
			min: vec3(hierarchy.min),
			max: vec3(hierarchy.max),
			size: vec3(hierarchySize),
		},
	};
}

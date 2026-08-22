import { Mesh, Scene, SubMesh, Vector3, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { getMeshEdges, getMeshTopologyFingerprint } from "./meshes";
import { isEditableMeshVertexStream } from "./editable-source";

const LOOP_CUT_MODEL = "logical-quad-strip-loop-cut-v1";
const POSITION_EPSILON = 0.0000001;
const VALUE_EPSILON = 0.000001;

interface IVertexStreamSnapshot {
	kind: string;
	stride: number;
	updatable: boolean;
	values: number[];
}

interface ISubMeshSnapshot {
	materialIndex: number;
	indexStart: number;
	indexCount: number;
}

export interface ILoopCutMeshSnapshot {
	streams: IVertexStreamSnapshot[];
	indices: number[];
	subMeshes: ISubMeshSnapshot[];
	selection: any;
	uvLayout: any;
	smoothingGroups?: any;
	vertexColors?: any;
	useVertexColors?: boolean;
	hasVertexAlpha?: boolean;
}

interface IFace {
	id: number;
	raw: [number, number, number];
	logical: [number, number, number];
	normal: Vector3;
	subMesh: number;
}

interface IEdgeOccurrence {
	face: number;
	from: number;
	to: number;
}

interface IQuad {
	id: number;
	faces: [number, number];
	cycleLogical: [number, number, number, number];
	cycleRaw: [number, number, number, number];
	edgeKeys: [string, string, string, string];
	normal: Vector3;
	score: number;
}

interface IQuadStripEntry {
	quad: IQuad;
	enteringEdge: number;
}

interface ILogicalTopology {
	rawToLogical: number[];
	logicalPositions: Vector3[];
	faces: IFace[];
	edges: Map<string, IEdgeOccurrence[]>;
}

function copySerializable(value: any): any {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function edgeKey(first: number, second: number): string {
	return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function captureVertexStreams(mesh: Mesh): IVertexStreamSnapshot[] {
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind, false);
	if (!positions || positions.length % 3 !== 0) {
		throw new Error(`Mesh "${mesh.name}" has no complete editable position stream.`);
	}
	const vertexCount = positions.length / 3;
	const streams = mesh
		.getVerticesDataKinds()
		.filter((kind) => isEditableMeshVertexStream(mesh, kind))
		.map((kind) => {
			const buffer = mesh.getVertexBuffer(kind);
			const values = Array.from(mesh.getVerticesData(kind, false) ?? []);
			const stride = buffer?.getStrideSize() ?? 0;
			if (!buffer || !Number.isInteger(stride) || stride < 1 || values.length !== vertexCount * stride) {
				throw new Error(
					`Loop cut cannot safely preserve vertex stream "${kind}"; expected ${vertexCount} complete vertices but found ${values.length} values at stride ${stride}.`
				);
			}
			return { kind, stride, updatable: buffer.isUpdatable(), values };
		})
		.sort((first, second) => first.kind.localeCompare(second.kind));
	if (!streams.some((stream) => stream.kind === VertexBuffer.PositionKind && stream.stride === 3)) {
		throw new Error("Loop cut requires a three-component position stream.");
	}
	return streams;
}

function captureSubMeshes(mesh: Mesh, indexCount: number): ISubMeshSnapshot[] {
	const source = mesh.subMeshes.length
		? mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexStart: subMesh.indexStart, indexCount: subMesh.indexCount }))
		: [{ materialIndex: 0, indexStart: 0, indexCount }];
	const ordered = [...source].sort((first, second) => first.indexStart - second.indexStart);
	let cursor = 0;
	for (const subMesh of ordered) {
		if (subMesh.indexStart !== cursor || subMesh.indexStart % 3 !== 0 || subMesh.indexCount <= 0 || subMesh.indexCount % 3 !== 0) {
			throw new Error("Loop cut requires non-overlapping triangle submeshes that cover the index buffer contiguously.");
		}
		cursor += subMesh.indexCount;
	}
	if (cursor !== indexCount) {
		throw new Error("Loop cut requires submeshes to cover the complete index buffer.");
	}
	return ordered;
}

/** Captures every topology-dependent mesh stream and material range for exact editor Undo/Redo. */
export function captureLoopCutMeshSnapshot(scene: Scene, data: any): ILoopCutMeshSnapshot {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const indices = Array.from(node.getIndices(false) ?? []);
	if (!indices.length || indices.length % 3 !== 0) {
		throw new Error(`Mesh "${node.name}" has no complete editable triangle index buffer.`);
	}
	return {
		streams: captureVertexStreams(node),
		indices,
		subMeshes: captureSubMeshes(node, indices.length),
		selection: copySerializable(node.metadata?.babylonEditorMeshSelection),
		uvLayout: copySerializable(node.metadata?.babylonEditorUvLayout),
		smoothingGroups: copySerializable(node.metadata?.babylonEditorSmoothingGroups),
		vertexColors: copySerializable(node.metadata?.babylonEditorVertexColors),
		useVertexColors: node.useVertexColors,
		hasVertexAlpha: node.hasVertexAlpha,
	};
}

/** Applies a complete topology snapshot to an existing Mesh. Shared by topology authoring operations. */
export function applyLoopCutMeshSnapshot(mesh: Mesh, snapshot: ILoopCutMeshSnapshot): void {
	const kinds = new Set(snapshot.streams.map((stream) => stream.kind));
	for (const kind of mesh.getVerticesDataKinds()) {
		if (isEditableMeshVertexStream(mesh, kind) && !kinds.has(kind)) {
			mesh.removeVerticesData(kind);
		}
	}
	const position = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!;
	const vertexCount = position.values.length / position.stride;
	for (const stream of snapshot.streams) {
		mesh.setVerticesData(stream.kind, stream.values, stream.updatable, stream.stride);
	}
	mesh.setIndices(snapshot.indices, null, true);
	mesh.releaseSubMeshes(true);
	let indexStart = 0;
	for (const subMesh of snapshot.subMeshes) {
		new SubMesh(subMesh.materialIndex, 0, vertexCount, indexStart, subMesh.indexCount, mesh, mesh, false, true);
		indexStart += subMesh.indexCount;
	}
	mesh.metadata ??= {};
	if (snapshot.selection === undefined) {
		delete mesh.metadata.babylonEditorMeshSelection;
	} else {
		mesh.metadata.babylonEditorMeshSelection = copySerializable(snapshot.selection);
	}
	if (snapshot.uvLayout === undefined) {
		delete mesh.metadata.babylonEditorUvLayout;
	} else {
		mesh.metadata.babylonEditorUvLayout = copySerializable(snapshot.uvLayout);
	}
	if (snapshot.smoothingGroups === undefined) {
		delete mesh.metadata.babylonEditorSmoothingGroups;
	} else {
		mesh.metadata.babylonEditorSmoothingGroups = copySerializable(snapshot.smoothingGroups);
	}
	if (snapshot.vertexColors === undefined) {
		delete mesh.metadata.babylonEditorVertexColors;
	} else {
		mesh.metadata.babylonEditorVertexColors = copySerializable(snapshot.vertexColors);
	}
	if (snapshot.useVertexColors !== undefined) {
		mesh.useVertexColors = snapshot.useVertexColors;
	}
	if (snapshot.hasVertexAlpha !== undefined) {
		mesh.hasVertexAlpha = snapshot.hasVertexAlpha;
	}
	mesh.refreshBoundingInfo({ updatePositionsArray: true });
}

/** Restores a complete loop-cut snapshot, including arbitrary streams, material ranges, selection, and UV metadata. */
export function restoreLoopCutMeshSnapshot(scene: Scene, data: any, snapshot: ILoopCutMeshSnapshot, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	applyLoopCutMeshSnapshot(node, snapshot);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return {
		node: toNodeSummary(node),
		topologyFingerprint: getMeshTopologyFingerprint(snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values, snapshot.indices),
	};
}

function buildLogicalTopology(snapshot: ILoopCutMeshSnapshot): ILogicalTopology {
	const positionStream = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!;
	const positions = positionStream.values;
	const vertexCount = positions.length / 3;
	const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
	for (let index = 0; index < vertexCount; index++) {
		const point = Vector3.FromArray(positions, index * 3);
		minimum.minimizeInPlace(point);
		maximum.maximizeInPlace(point);
	}
	const tolerance = Math.max(Vector3.Distance(minimum, maximum) * POSITION_EPSILON, POSITION_EPSILON);
	const logicalByPosition = new Map<string, number>();
	const rawToLogical: number[] = [];
	const logicalPositions: Vector3[] = [];
	for (let index = 0; index < vertexCount; index++) {
		const point = Vector3.FromArray(positions, index * 3);
		const key = `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}:${Math.round(point.z / tolerance)}`;
		let logical = logicalByPosition.get(key);
		if (logical === undefined) {
			logical = logicalPositions.length;
			logicalByPosition.set(key, logical);
			logicalPositions.push(point);
		}
		rawToLogical.push(logical);
	}
	const faceSubMesh: number[] = [];
	snapshot.subMeshes.forEach((subMesh, subMeshIndex) => {
		for (let offset = subMesh.indexStart; offset < subMesh.indexStart + subMesh.indexCount; offset += 3) {
			faceSubMesh[offset / 3] = subMeshIndex;
		}
	});
	const faces: IFace[] = [];
	const edges = new Map<string, IEdgeOccurrence[]>();
	for (let faceIndex = 0; faceIndex < snapshot.indices.length / 3; faceIndex++) {
		const raw = snapshot.indices.slice(faceIndex * 3, faceIndex * 3 + 3) as [number, number, number];
		const logical = raw.map((index) => rawToLogical[index]) as [number, number, number];
		if (new Set(logical).size !== 3) {
			throw new Error(`Loop cut found degenerate logical triangle ${faceIndex}; repair or remove zero-area faces first.`);
		}
		const first = logicalPositions[logical[0]];
		const second = logicalPositions[logical[1]];
		const third = logicalPositions[logical[2]];
		const cross = Vector3.Cross(second.subtract(first), third.subtract(first));
		if (cross.lengthSquared() < POSITION_EPSILON * POSITION_EPSILON) {
			throw new Error(`Loop cut found zero-area triangle ${faceIndex}; repair the mesh first.`);
		}
		const normal = cross.normalize();
		faces.push({ id: faceIndex, raw, logical, normal, subMesh: faceSubMesh[faceIndex] });
		for (let edge = 0; edge < 3; edge++) {
			const from = logical[edge];
			const to = logical[(edge + 1) % 3];
			const key = edgeKey(from, to);
			const occurrences = edges.get(key) ?? [];
			occurrences.push({ face: faceIndex, from, to });
			edges.set(key, occurrences);
		}
	}
	return { rawToLogical, logicalPositions, faces, edges };
}

function getFaceRawForLogical(face: IFace, logical: number): number {
	const corner = face.logical.indexOf(logical);
	if (corner < 0) {
		throw new Error("Loop cut internal topology mismatch while resolving a quad corner.");
	}
	return face.raw[corner];
}

function streamsMatchAtVertex(streams: IVertexStreamSnapshot[], first: number, second: number): boolean {
	return streams.every((stream) => {
		for (let component = 0; component < stream.stride; component++) {
			if (Math.abs(stream.values[first * stream.stride + component] - stream.values[second * stream.stride + component]) > VALUE_EPSILON) {
				return false;
			}
		}
		return true;
	});
}

function buildQuadCandidate(topology: ILogicalTopology, streams: IVertexStreamSnapshot[], key: string, occurrences: IEdgeOccurrence[]): Omit<IQuad, "id"> | null {
	if (occurrences.length !== 2 || occurrences[0].face === occurrences[1].face) {
		return null;
	}
	const firstFace = topology.faces[occurrences[0].face];
	const secondFace = topology.faces[occurrences[1].face];
	if (firstFace.subMesh !== secondFace.subMesh || occurrences[0].from !== occurrences[1].to || occurrences[0].to !== occurrences[1].from) {
		return null;
	}
	const logicalVertices = [...new Set([...firstFace.logical, ...secondFace.logical])];
	if (logicalVertices.length !== 4) {
		return null;
	}
	const [diagonalFirst, diagonalSecond] = key.split(":").map(Number);
	for (const logical of [diagonalFirst, diagonalSecond]) {
		if (!streamsMatchAtVertex(streams, getFaceRawForLogical(firstFace, logical), getFaceRawForLogical(secondFace, logical))) {
			return null;
		}
	}
	const boundary: Array<[number, number]> = [];
	for (const face of [firstFace, secondFace]) {
		for (let edge = 0; edge < 3; edge++) {
			const from = face.logical[edge];
			const to = face.logical[(edge + 1) % 3];
			if (edgeKey(from, to) !== key) {
				boundary.push([from, to]);
			}
		}
	}
	const outgoing = new Map<number, number>();
	for (const [from, to] of boundary) {
		if (outgoing.has(from)) {
			return null;
		}
		outgoing.set(from, to);
	}
	const start = Math.min(...logicalVertices);
	const cycle = [start];
	for (let index = 0; index < 3; index++) {
		const next = outgoing.get(cycle[cycle.length - 1]);
		if (next === undefined || cycle.includes(next)) {
			return null;
		}
		cycle.push(next);
	}
	if (outgoing.get(cycle[3]) !== start || new Set(cycle).size !== 4) {
		return null;
	}
	const cycleLogical = cycle as [number, number, number, number];
	const averageNormal = firstFace.normal.add(secondFace.normal);
	if (averageNormal.lengthSquared() < POSITION_EPSILON * POSITION_EPSILON) {
		return null;
	}
	averageNormal.normalize();
	const signs: number[] = [];
	for (let index = 0; index < 4; index++) {
		const previous = topology.logicalPositions[cycleLogical[(index + 3) % 4]];
		const current = topology.logicalPositions[cycleLogical[index]];
		const next = topology.logicalPositions[cycleLogical[(index + 1) % 4]];
		signs.push(Vector3.Dot(Vector3.Cross(current.subtract(previous), next.subtract(current)), averageNormal));
	}
	if (signs.some((value) => Math.abs(value) < POSITION_EPSILON) || !(signs.every((value) => value > 0) || signs.every((value) => value < 0))) {
		return null;
	}
	const cycleRaw = cycleLogical.map((logical) => {
		const face = firstFace.logical.includes(logical) ? firstFace : secondFace;
		return getFaceRawForLogical(face, logical);
	}) as [number, number, number, number];
	const sharedLength = Vector3.Distance(topology.logicalPositions[diagonalFirst], topology.logicalPositions[diagonalSecond]);
	const unique = logicalVertices.filter((logical) => logical !== diagonalFirst && logical !== diagonalSecond);
	const otherDiagonalLength = Vector3.Distance(topology.logicalPositions[unique[0]], topology.logicalPositions[unique[1]]);
	const normalScore = (1 - Math.max(-1, Math.min(1, Vector3.Dot(firstFace.normal, secondFace.normal)))) * 1000;
	const diagonalScore = Math.abs(Math.log(Math.max(sharedLength, POSITION_EPSILON) / Math.max(otherDiagonalLength, POSITION_EPSILON))) * 10;
	const edgeLengths = cycleLogical.map((logical, index) => Vector3.Distance(topology.logicalPositions[logical], topology.logicalPositions[cycleLogical[(index + 1) % 4]]));
	const oppositeScore =
		Math.abs(edgeLengths[0] - edgeLengths[2]) / Math.max(edgeLengths[0], edgeLengths[2], POSITION_EPSILON) +
		Math.abs(edgeLengths[1] - edgeLengths[3]) / Math.max(edgeLengths[1], edgeLengths[3], POSITION_EPSILON);
	return {
		faces: [firstFace.id, secondFace.id],
		cycleLogical,
		cycleRaw,
		edgeKeys: cycleLogical.map((logical, index) => edgeKey(logical, cycleLogical[(index + 1) % 4])) as [string, string, string, string],
		normal: averageNormal,
		score: normalScore + diagonalScore + oppositeScore,
	};
}

function pairTrianglesIntoQuads(topology: ILogicalTopology, streams: IVertexStreamSnapshot[]): { quads: IQuad[]; candidateCount: number } {
	const candidates = [...topology.edges.entries()]
		.map(([key, occurrences]) => buildQuadCandidate(topology, streams, key, occurrences))
		.filter((candidate): candidate is Omit<IQuad, "id"> => !!candidate)
		.sort((first, second) => first.score - second.score || Math.min(...first.faces) - Math.min(...second.faces) || Math.max(...first.faces) - Math.max(...second.faces));
	const pairedFaces = new Set<number>();
	const quads: IQuad[] = [];
	for (const candidate of candidates) {
		if (candidate.faces.some((face) => pairedFaces.has(face))) {
			continue;
		}
		candidate.faces.forEach((face) => pairedFaces.add(face));
		quads.push({ ...candidate, id: quads.length });
	}
	return { quads, candidateCount: candidates.length };
}

function findQuadStrip(quads: IQuad[], seedKey: string): { entries: IQuadStripEntry[]; splitEdgeKeys: Set<string>; closed: boolean } {
	const byBoundaryEdge = new Map<string, Array<{ quad: IQuad; edge: number }>>();
	for (const quad of quads) {
		quad.edgeKeys.forEach((key, edge) => {
			const entries = byBoundaryEdge.get(key) ?? [];
			entries.push({ quad, edge });
			byBoundaryEdge.set(key, entries);
		});
	}
	const seeds = byBoundaryEdge.get(seedKey) ?? [];
	if (!seeds.length) {
		throw new Error("Selected edge is not a reconstructed quad boundary; choose a boundary edge instead of a triangle diagonal or unpaired triangle edge.");
	}
	if (seeds.length > 2) {
		throw new Error("Selected logical edge branches into more than two quads; loop cut requires a manifold quad strip.");
	}
	const visited = new Map<number, IQuadStripEntry>();
	const splitEdgeKeys = new Set<string>([seedKey]);
	const queue = seeds.map((seed) => ({ quad: seed.quad, enteringEdge: seed.edge }));
	while (queue.length) {
		const entry = queue.shift()!;
		if (visited.has(entry.quad.id)) {
			continue;
		}
		if (visited.size >= 4096) {
			throw new Error("Loop cut quad strip exceeds the 4,096-quad safety limit.");
		}
		visited.set(entry.quad.id, entry);
		const opposite = (entry.enteringEdge + 2) % 4;
		const exitKey = entry.quad.edgeKeys[opposite];
		splitEdgeKeys.add(exitKey);
		const next = (byBoundaryEdge.get(exitKey) ?? []).filter((candidate) => candidate.quad.id !== entry.quad.id);
		if (next.length > 1) {
			throw new Error(`Quad strip branches at logical edge ${exitKey}; repair non-manifold or overlapping faces before loop cutting.`);
		}
		if (next.length === 1 && !visited.has(next[0].quad.id)) {
			queue.push({ quad: next[0].quad, enteringEdge: next[0].edge });
		}
	}
	const boundaryCount = [...splitEdgeKeys].filter((key) => (byBoundaryEdge.get(key)?.length ?? 0) === 1).length;
	return { entries: [...visited.values()].sort((first, second) => Math.min(...first.quad.faces) - Math.min(...second.quad.faces)), splitEdgeKeys, closed: boundaryCount === 0 };
}

function normalizeDirection(values: number[], kind: string): number[] {
	if ((kind !== VertexBuffer.NormalKind && kind !== VertexBuffer.TangentKind) || values.length < 3) {
		return values;
	}
	const length = Math.hypot(values[0], values[1], values[2]);
	if (length > POSITION_EPSILON) {
		values[0] /= length;
		values[1] /= length;
		values[2] /= length;
	}
	if (kind === VertexBuffer.TangentKind && values.length > 3) {
		values[3] = values[3] < 0 ? -1 : 1;
	}
	return values;
}

function getSkinInfluences(streams: Map<string, IVertexStreamSnapshot>, vertex: number): Array<[number, number]> {
	const result = new Map<number, number>();
	for (const [indicesKind, weightsKind] of [
		[VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind],
		[VertexBuffer.MatricesIndicesExtraKind, VertexBuffer.MatricesWeightsExtraKind],
	] as const) {
		const indices = streams.get(indicesKind);
		const weights = streams.get(weightsKind);
		if (!indices && !weights) {
			continue;
		}
		if (!indices || !weights || indices.stride !== 4 || weights.stride !== 4) {
			throw new Error("Loop cut requires matching four-component skin index and weight streams.");
		}
		for (let component = 0; component < 4; component++) {
			const bone = Math.round(indices.values[vertex * 4 + component]);
			const weight = weights.values[vertex * 4 + component];
			if (weight > 0) {
				result.set(bone, (result.get(bone) ?? 0) + weight);
			}
		}
	}
	return [...result.entries()];
}

function interpolateSkin(streams: Map<string, IVertexStreamSnapshot>, first: number, second: number, amount: number): Map<string, number[]> {
	const firstInfluences = getSkinInfluences(streams, first);
	const secondInfluences = getSkinInfluences(streams, second);
	if (!firstInfluences.length && !secondInfluences.length) {
		return new Map();
	}
	const weights = new Map<number, number>();
	for (const [bone, weight] of firstInfluences) {
		weights.set(bone, (weights.get(bone) ?? 0) + weight * (1 - amount));
	}
	for (const [bone, weight] of secondInfluences) {
		weights.set(bone, (weights.get(bone) ?? 0) + weight * amount);
	}
	const maximumInfluences = streams.has(VertexBuffer.MatricesIndicesExtraKind) ? 8 : 4;
	const ordered = [...weights.entries()].sort((firstEntry, secondEntry) => secondEntry[1] - firstEntry[1] || firstEntry[0] - secondEntry[0]).slice(0, maximumInfluences);
	const total = ordered.reduce((sum, entry) => sum + entry[1], 0);
	const normalized = ordered.map(([bone, weight]) => [bone, total > POSITION_EPSILON ? weight / total : 0] as [number, number]);
	while (normalized.length < maximumInfluences) {
		normalized.push([0, 0]);
	}
	const result = new Map<string, number[]>();
	result.set(
		VertexBuffer.MatricesIndicesKind,
		normalized.slice(0, 4).map((entry) => entry[0])
	);
	result.set(
		VertexBuffer.MatricesWeightsKind,
		normalized.slice(0, 4).map((entry) => entry[1])
	);
	if (maximumInfluences === 8) {
		result.set(
			VertexBuffer.MatricesIndicesExtraKind,
			normalized.slice(4, 8).map((entry) => entry[0])
		);
		result.set(
			VertexBuffer.MatricesWeightsExtraKind,
			normalized.slice(4, 8).map((entry) => entry[1])
		);
	}
	return result;
}

function formatSignatureValue(value: number): string {
	return Math.round(value / VALUE_EPSILON).toString(36);
}

/** Inserts one to eight evenly spaced edge loops through a deterministic logical quad strip. */
export function loopCutMesh(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (node.morphTargetManager?.numTargets) {
		throw new Error("Loop cut cannot change vertex topology while morph targets are attached; bake or detach morph targets first.");
	}
	const cuts = data.cuts ?? 1;
	const offset = data.offset ?? 0;
	if (!Number.isInteger(cuts) || cuts < 1 || cuts > 8) {
		throw new Error("Loop cut count must be an integer from 1 to 8.");
	}
	if (!Number.isFinite(offset) || offset < -0.49 || offset > 0.49) {
		throw new Error("Loop cut offset must be between -0.49 and 0.49 intervals.");
	}
	const snapshot = captureLoopCutMeshSnapshot(scene, { nodeId: node.id });
	const positionStream = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!;
	const fingerprint = getMeshTopologyFingerprint(positionStream.values, snapshot.indices);
	if (data.expectedTopologyFingerprint !== fingerprint) {
		throw new Error(`Mesh topology is stale: expected "${data.expectedTopologyFingerprint}", current fingerprint is "${fingerprint}". Call get_mesh_topology again.`);
	}
	const rawEdges = getMeshEdges(snapshot.indices);
	if (!Number.isInteger(data.edgeIndex) || data.edgeIndex < 0 || data.edgeIndex >= rawEdges.length) {
		throw new Error(`Loop cut edgeIndex must reference a current unique edge from 0 to ${rawEdges.length - 1}.`);
	}
	if (snapshot.indices.length / 3 > 100_000) {
		throw new Error("Loop cut supports at most 100,000 source triangles per operation.");
	}
	const topology = buildLogicalTopology(snapshot);
	const seedRaw = rawEdges[data.edgeIndex];
	const seedKey = edgeKey(topology.rawToLogical[seedRaw[0]], topology.rawToLogical[seedRaw[1]]);
	const pairing = pairTrianglesIntoQuads(topology, snapshot.streams);
	const strip = findQuadStrip(pairing.quads, seedKey);
	const streamByKind = new Map(snapshot.streams.map((stream) => [stream.kind, stream]));
	const outputStreams = new Map(snapshot.streams.map((stream) => [stream.kind, [...stream.values]]));
	const generatedVertices = new Map<string, number>();
	const generatedLoopEdges: number[][] = Array.from({ length: cuts }, () => []);
	const cutAmounts = Array.from({ length: cuts }, (_, index) => (index + 1 + offset) / (cuts + 1));
	const interpolateVertex = (firstRaw: number, secondRaw: number, firstLogical: number, secondLogical: number, amount: number): number => {
		let canonicalAmount = amount;
		let canonicalFirst = firstRaw;
		let canonicalSecond = secondRaw;
		if (firstLogical > secondLogical) {
			canonicalAmount = 1 - amount;
			canonicalFirst = secondRaw;
			canonicalSecond = firstRaw;
		}
		const valuesByKind = new Map<string, number[]>();
		const skin = interpolateSkin(streamByKind, canonicalFirst, canonicalSecond, canonicalAmount);
		for (const stream of snapshot.streams) {
			const skinValues = skin.get(stream.kind);
			if (skinValues) {
				valuesByKind.set(stream.kind, skinValues);
				continue;
			}
			if (
				stream.kind === VertexBuffer.MatricesIndicesKind ||
				stream.kind === VertexBuffer.MatricesWeightsKind ||
				stream.kind === VertexBuffer.MatricesIndicesExtraKind ||
				stream.kind === VertexBuffer.MatricesWeightsExtraKind
			) {
				throw new Error("Loop cut found incomplete skin streams; provide matching index and weight buffers.");
			}
			const values = Array.from({ length: stream.stride }, (_, component) => {
				const firstValue = stream.values[canonicalFirst * stream.stride + component];
				const secondValue = stream.values[canonicalSecond * stream.stride + component];
				return firstValue + (secondValue - firstValue) * canonicalAmount;
			});
			valuesByKind.set(stream.kind, normalizeDirection(values, stream.kind));
		}
		const signature = snapshot.streams.map((stream) => `${stream.kind}:${valuesByKind.get(stream.kind)!.map(formatSignatureValue).join(",")}`).join("|");
		const key = `${edgeKey(firstLogical, secondLogical)}:${canonicalAmount.toFixed(8)}:${signature}`;
		const existing = generatedVertices.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const index = outputStreams.get(VertexBuffer.PositionKind)!.length / 3;
		for (const stream of snapshot.streams) {
			outputStreams.get(stream.kind)!.push(...valuesByKind.get(stream.kind)!);
		}
		generatedVertices.set(key, index);
		return index;
	};
	const stripByFace = new Map<number, IQuadStripEntry>();
	for (const entry of strip.entries) {
		entry.quad.faces.forEach((face) => stripByFace.set(face, entry));
	}
	const outputIndices: number[] = [];
	const outputCounts = snapshot.subMeshes.map(() => 0);
	const emittedQuads = new Set<number>();
	const pushTriangle = (first: number, second: number, third: number, expectedNormal: Vector3): void => {
		const positions = outputStreams.get(VertexBuffer.PositionKind)!;
		const firstPosition = Vector3.FromArray(positions, first * 3);
		const secondPosition = Vector3.FromArray(positions, second * 3);
		const thirdPosition = Vector3.FromArray(positions, third * 3);
		const normal = Vector3.Cross(secondPosition.subtract(firstPosition), thirdPosition.subtract(firstPosition));
		if (normal.lengthSquared() < POSITION_EPSILON * POSITION_EPSILON) {
			throw new Error("Loop cut would create a degenerate triangle; reduce the offset or repair collapsed quad edges.");
		}
		if (Vector3.Dot(normal, expectedNormal) < 0) {
			outputIndices.push(first, third, second);
		} else {
			outputIndices.push(first, second, third);
		}
	};
	for (const face of topology.faces) {
		const stripEntry = stripByFace.get(face.id);
		if (!stripEntry) {
			outputIndices.push(...face.raw);
			outputCounts[face.subMesh] += 3;
			continue;
		}
		if (emittedQuads.has(stripEntry.quad.id)) {
			continue;
		}
		emittedQuads.add(stripEntry.quad.id);
		const quad = stripEntry.quad;
		const edge = stripEntry.enteringEdge;
		const firstLogical = quad.cycleLogical[edge];
		const secondLogical = quad.cycleLogical[(edge + 1) % 4];
		const oppositeFirstLogical = quad.cycleLogical[(edge + 3) % 4];
		const oppositeSecondLogical = quad.cycleLogical[(edge + 2) % 4];
		const firstRaw = quad.cycleRaw[edge];
		const secondRaw = quad.cycleRaw[(edge + 1) % 4];
		const oppositeFirstRaw = quad.cycleRaw[(edge + 3) % 4];
		const oppositeSecondRaw = quad.cycleRaw[(edge + 2) % 4];
		const firstRail = [firstRaw, ...cutAmounts.map((amount) => interpolateVertex(firstRaw, secondRaw, firstLogical, secondLogical, amount)), secondRaw];
		const secondRail = [
			oppositeFirstRaw,
			...cutAmounts.map((amount) => interpolateVertex(oppositeFirstRaw, oppositeSecondRaw, oppositeFirstLogical, oppositeSecondLogical, amount)),
			oppositeSecondRaw,
		];
		for (let cut = 0; cut < cuts; cut++) {
			generatedLoopEdges[cut].push(firstRail[cut + 1], secondRail[cut + 1]);
		}
		for (let band = 0; band <= cuts; band++) {
			pushTriangle(firstRail[band], firstRail[band + 1], secondRail[band + 1], quad.normal);
			pushTriangle(firstRail[band], secondRail[band + 1], secondRail[band], quad.normal);
			outputCounts[face.subMesh] += 6;
		}
	}
	const outputSnapshot: ILoopCutMeshSnapshot = {
		streams: snapshot.streams.map((stream) => ({ ...stream, values: outputStreams.get(stream.kind)! })),
		indices: outputIndices,
		subMeshes: snapshot.subMeshes.map((subMesh, index) => ({ ...subMesh, indexCount: outputCounts[index] })),
		selection: undefined,
		uvLayout: undefined,
		smoothingGroups: undefined,
		vertexColors: undefined,
	};
	applyLoopCutMeshSnapshot(node, outputSnapshot);
	const outputEdges = getMeshEdges(outputIndices);
	const outputEdgeIndex = new Map(outputEdges.map((edge, index) => [`${edge[0]}:${edge[1]}`, index]));
	const loops = generatedLoopEdges.map((pairs, cut) => ({
		cut,
		amount: cutAmounts[cut],
		edgeIndices: Array.from({ length: pairs.length / 2 }, (_, index) => {
			const first = pairs[index * 2];
			const second = pairs[index * 2 + 1];
			return outputEdgeIndex.get(first < second ? `${first}:${second}` : `${second}:${first}`)!;
		}).sort((first, second) => first - second),
	}));
	const createdEdgeIndices = [...new Set(loops.flatMap((loop) => loop.edgeIndices))].sort((first, second) => first - second);
	node.metadata ??= {};
	node.metadata.babylonEditorMeshSelection = { mode: "edge", indices: createdEdgeIndices };
	delete node.metadata.babylonEditorUvLayout;
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return {
		node: toNodeSummary(node),
		loopCutModel: LOOP_CUT_MODEL,
		topologyFingerprintBefore: fingerprint,
		topologyFingerprintAfter: getMeshTopologyFingerprint(outputStreams.get(VertexBuffer.PositionKind)!, outputIndices),
		seedEdgeIndex: data.edgeIndex,
		seedEdge: seedRaw,
		cuts,
		offset,
		cutAmounts,
		stripClosed: strip.closed,
		stripQuadCount: strip.entries.length,
		splitLogicalEdgeCount: strip.splitEdgeKeys.size,
		quadCandidateCount: pairing.candidateCount,
		pairedQuadCount: pairing.quads.length,
		unpairedFaceCount: topology.faces.length - pairing.quads.length * 2,
		addedVertices: outputStreams.get(VertexBuffer.PositionKind)!.length / 3 - positionStream.values.length / 3,
		addedTriangles: outputIndices.length / 3 - snapshot.indices.length / 3,
		vertexCount: outputStreams.get(VertexBuffer.PositionKind)!.length / 3,
		triangleCount: outputIndices.length / 3,
		loops,
		createdEdgeIndices,
		preservedVertexStreams: snapshot.streams.map((stream) => ({ kind: stream.kind, stride: stream.stride })),
		subMeshes: outputSnapshot.subMeshes,
	};
}

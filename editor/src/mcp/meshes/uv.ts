import { Scene, Vector3, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";
import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

import { getMeshTopologyFingerprint, getMeshVertexData, setMeshVertexData } from "./meshes";

const UV_LAYOUT_METADATA_KEY = "babylonEditorUvLayout";
const UV_LAYOUT_MODEL = "logical-seam-harmonic-relax-pack-v1";
const UV_POSITION_PRECISION = 1_000_000;

interface IRawEdge {
	first: number;
	second: number;
	key: string;
}

interface ILogicalEdgeOccurrence {
	face: number;
	firstCorner: number;
	secondCorner: number;
	firstVertex: number;
	secondVertex: number;
	firstKey: string;
	secondKey: string;
}

interface ILogicalTopology {
	fingerprint: string;
	faceCount: number;
	vertexKeys: string[];
	edges: Map<string, ILogicalEdgeOccurrence[]>;
	rawEdges: IRawEdge[];
	rawEdgeLogicalKeys: string[];
}

interface IStoredUvLayout {
	version: 1;
	revision: number;
	logicalTopologyFingerprint: string;
	seamKeys: string[];
	lastUnwrap: null | {
		model: typeof UV_LAYOUT_MODEL;
		padding: number;
		relaxIterations: number;
		relaxStrength: number;
		allowRotation: boolean;
		autoSeams: boolean;
		autoSeamCount: number;
		normalizeTexelDensity: boolean;
		chartCount: number;
		atlasUtilization: number;
		charts: Array<{
			id: number;
			faceCount: number;
			vertexCount: number;
			rotated: boolean;
			uvBounds: { min: [number, number]; max: [number, number] };
			surfaceArea: number;
		}>;
	};
}

interface IUvState {
	stored: IStoredUvLayout | null;
	revision: number;
	seams: Set<string>;
	stale: boolean;
	derived: boolean;
}

interface IUvChartTopology {
	chartByFace: number[];
	chartFaces: number[][];
	cornerRoots: number[];
	rootCorners: Map<number, number[]>;
	rootNeighbors: Map<number, Set<number>>;
	boundaryEdgesByChart: Array<Array<[number, number]>>;
}

interface IFlattenedChart {
	id: number;
	faces: number[];
	coordinates: Map<number, [number, number]>;
	surfaceArea: number;
	width: number;
	height: number;
	min: [number, number];
	max: [number, number];
}

interface IPackedChart {
	chart: IFlattenedChart;
	x: number;
	y: number;
	rotated: boolean;
	scale: number;
}

interface IPreservedVertexStream {
	kind: string;
	stride: number;
	updatable: boolean;
	values: number[];
}

class DisjointSet {
	private readonly _parents: number[];
	private readonly _ranks: number[];

	public constructor(size: number) {
		this._parents = Array.from({ length: size }, (_, index) => index);
		this._ranks = new Array(size).fill(0);
	}

	public find(value: number): number {
		let root = value;
		while (this._parents[root] !== root) {
			root = this._parents[root];
		}
		while (this._parents[value] !== value) {
			const next = this._parents[value];
			this._parents[value] = root;
			value = next;
		}
		return root;
	}

	public union(first: number, second: number): boolean {
		let firstRoot = this.find(first);
		let secondRoot = this.find(second);
		if (firstRoot === secondRoot) {
			return false;
		}
		if (this._ranks[firstRoot] < this._ranks[secondRoot]) {
			[firstRoot, secondRoot] = [secondRoot, firstRoot];
		}
		this._parents[secondRoot] = firstRoot;
		if (this._ranks[firstRoot] === this._ranks[secondRoot]) {
			this._ranks[firstRoot]++;
		}
		return true;
	}
}

function getLogicalVertexKey(positions: number[], vertex: number): string {
	const offset = vertex * 3;
	return `${Math.round(positions[offset] * UV_POSITION_PRECISION)},${Math.round(positions[offset + 1] * UV_POSITION_PRECISION)},${Math.round(positions[offset + 2] * UV_POSITION_PRECISION)}`;
}

function getLogicalEdgeKey(first: string, second: string): string {
	return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function hashText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function buildLogicalTopology(mesh: any): ILogicalTopology {
	const vertexKeys = Array.from({ length: mesh.positions.length / 3 }, (_, vertex) => getLogicalVertexKey(mesh.positions, vertex));
	const edges = new Map<string, ILogicalEdgeOccurrence[]>();
	const rawEdgeMap = new Map<string, IRawEdge>();
	for (let face = 0; face < mesh.indices.length / 3; face++) {
		for (let corner = 0; corner < 3; corner++) {
			const firstCorner = corner;
			const secondCorner = (corner + 1) % 3;
			const firstVertex = mesh.indices[face * 3 + firstCorner];
			const secondVertex = mesh.indices[face * 3 + secondCorner];
			const firstKey = vertexKeys[firstVertex];
			const secondKey = vertexKeys[secondVertex];
			const logicalKey = getLogicalEdgeKey(firstKey, secondKey);
			const occurrences = edges.get(logicalKey) ?? [];
			occurrences.push({ face, firstCorner, secondCorner, firstVertex, secondVertex, firstKey, secondKey });
			edges.set(logicalKey, occurrences);
			const rawFirst = Math.min(firstVertex, secondVertex);
			const rawSecond = Math.max(firstVertex, secondVertex);
			rawEdgeMap.set(`${rawFirst}:${rawSecond}`, { first: rawFirst, second: rawSecond, key: `${rawFirst}:${rawSecond}` });
		}
	}
	const rawEdges = [...rawEdgeMap.values()];
	const rawEdgeLogicalKeys = rawEdges.map((edge) => getLogicalEdgeKey(vertexKeys[edge.first], vertexKeys[edge.second]));
	const fingerprintSource = Array.from({ length: mesh.indices.length / 3 }, (_, face) =>
		[vertexKeys[mesh.indices[face * 3]], vertexKeys[mesh.indices[face * 3 + 1]], vertexKeys[mesh.indices[face * 3 + 2]]].join(";")
	).join("/");
	return { fingerprint: hashText(fingerprintSource), faceCount: mesh.indices.length / 3, vertexKeys, edges, rawEdges, rawEdgeLogicalKeys };
}

function getOccurrenceVertexForKey(occurrence: ILogicalEdgeOccurrence, key: string): number {
	return occurrence.firstKey === key ? occurrence.firstVertex : occurrence.secondVertex;
}

function getOccurrenceCornerForKey(occurrence: ILogicalEdgeOccurrence, key: string): number {
	return occurrence.face * 3 + (occurrence.firstKey === key ? occurrence.firstCorner : occurrence.secondCorner);
}

function getUvForVertex(mesh: any, vertex: number): [number, number] {
	return [mesh.uvs[vertex * 2] ?? 0, mesh.uvs[vertex * 2 + 1] ?? 0];
}

function deriveUvSeams(mesh: any, topology: ILogicalTopology): Set<string> {
	const seams = new Set<string>();
	for (const [key, occurrences] of topology.edges) {
		if (occurrences.length > 2) {
			seams.add(key);
			continue;
		}
		if (occurrences.length !== 2 || !mesh.uvs.length) {
			continue;
		}
		const [firstKey, secondKey] = key.split("|");
		const firstA = getUvForVertex(mesh, getOccurrenceVertexForKey(occurrences[0], firstKey));
		const firstB = getUvForVertex(mesh, getOccurrenceVertexForKey(occurrences[1], firstKey));
		const secondA = getUvForVertex(mesh, getOccurrenceVertexForKey(occurrences[0], secondKey));
		const secondB = getUvForVertex(mesh, getOccurrenceVertexForKey(occurrences[1], secondKey));
		if (
			Math.abs(firstA[0] - firstB[0]) > 0.000001 ||
			Math.abs(firstA[1] - firstB[1]) > 0.000001 ||
			Math.abs(secondA[0] - secondB[0]) > 0.000001 ||
			Math.abs(secondA[1] - secondB[1]) > 0.000001
		) {
			seams.add(key);
		}
	}
	return seams;
}

function getUvState(node: any, mesh: any, topology: ILogicalTopology): IUvState {
	const candidate = node.metadata?.[UV_LAYOUT_METADATA_KEY] as IStoredUvLayout | undefined;
	const valid = candidate?.version === 1 && candidate.logicalTopologyFingerprint === topology.fingerprint;
	if (valid) {
		return { stored: candidate, revision: candidate.revision, seams: new Set(candidate.seamKeys), stale: false, derived: false };
	}
	return {
		stored: null,
		revision: 0,
		seams: deriveUvSeams(mesh, topology),
		stale: candidate !== undefined,
		derived: true,
	};
}

function publishUvState(node: any, topology: ILogicalTopology, revision: number, seams: Set<string>, lastUnwrap: IStoredUvLayout["lastUnwrap"]): IStoredUvLayout {
	const metadata: IStoredUvLayout = {
		version: 1,
		revision,
		logicalTopologyFingerprint: topology.fingerprint,
		seamKeys: [...seams].sort(),
		lastUnwrap,
	};
	node.metadata ??= {};
	node.metadata[UV_LAYOUT_METADATA_KEY] = metadata;
	return metadata;
}

function buildChartTopology(topology: ILogicalTopology, seams: Set<string>): IUvChartTopology {
	const faceSets = new DisjointSet(topology.faceCount);
	const cornerSets = new DisjointSet(topology.faceCount * 3);
	for (const [key, occurrences] of topology.edges) {
		if (seams.has(key) || occurrences.length !== 2) {
			continue;
		}
		faceSets.union(occurrences[0].face, occurrences[1].face);
		const [firstKey, secondKey] = key.split("|");
		cornerSets.union(getOccurrenceCornerForKey(occurrences[0], firstKey), getOccurrenceCornerForKey(occurrences[1], firstKey));
		cornerSets.union(getOccurrenceCornerForKey(occurrences[0], secondKey), getOccurrenceCornerForKey(occurrences[1], secondKey));
	}
	const faceRootToChart = new Map<number, number>();
	const chartByFace: number[] = [];
	const chartFaces: number[][] = [];
	for (let face = 0; face < topology.faceCount; face++) {
		const root = faceSets.find(face);
		let chart = faceRootToChart.get(root);
		if (chart === undefined) {
			chart = chartFaces.length;
			faceRootToChart.set(root, chart);
			chartFaces.push([]);
		}
		chartByFace[face] = chart;
		chartFaces[chart].push(face);
	}
	const cornerRoots = Array.from({ length: topology.faceCount * 3 }, (_, corner) => cornerSets.find(corner));
	const rootCorners = new Map<number, number[]>();
	const rootNeighbors = new Map<number, Set<number>>();
	const boundaryEdgesByChart = Array.from({ length: chartFaces.length }, () => [] as Array<[number, number]>);
	for (let corner = 0; corner < cornerRoots.length; corner++) {
		const root = cornerRoots[corner];
		const corners = rootCorners.get(root) ?? [];
		corners.push(corner);
		rootCorners.set(root, corners);
		rootNeighbors.set(root, rootNeighbors.get(root) ?? new Set());
	}
	for (const [key, occurrences] of topology.edges) {
		for (const occurrence of occurrences) {
			const firstRoot = cornerRoots[occurrence.face * 3 + occurrence.firstCorner];
			const secondRoot = cornerRoots[occurrence.face * 3 + occurrence.secondCorner];
			rootNeighbors.get(firstRoot)!.add(secondRoot);
			rootNeighbors.get(secondRoot)!.add(firstRoot);
			if (seams.has(key) || occurrences.length !== 2) {
				boundaryEdgesByChart[chartByFace[occurrence.face]].push([firstRoot, secondRoot]);
			}
		}
	}
	return { chartByFace, chartFaces, cornerRoots, rootCorners, rootNeighbors, boundaryEdgesByChart };
}

function getFaceSurfaceArea(mesh: any, face: number): number {
	const first = Vector3.FromArray(mesh.positions, mesh.indices[face * 3] * 3);
	const second = Vector3.FromArray(mesh.positions, mesh.indices[face * 3 + 1] * 3);
	const third = Vector3.FromArray(mesh.positions, mesh.indices[face * 3 + 2] * 3);
	return Vector3.Cross(second.subtract(first), third.subtract(first)).length() * 0.5;
}

function getUvLayoutSummary(node: any, mesh: any, topology: ILogicalTopology, state: IUvState, data: any): any {
	const charts = buildChartTopology(topology, state.seams);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 100;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("UV layout paging requires a non-negative offset and a limit from 1 to 256.");
	}
	const chartSummaries = charts.chartFaces.map((faces, id) => {
		const faceSet = new Set(faces);
		const roots = new Set(faces.flatMap((face) => [charts.cornerRoots[face * 3], charts.cornerRoots[face * 3 + 1], charts.cornerRoots[face * 3 + 2]]));
		const uvValues = faces.flatMap((face) => [
			getUvForVertex(mesh, mesh.indices[face * 3]),
			getUvForVertex(mesh, mesh.indices[face * 3 + 1]),
			getUvForVertex(mesh, mesh.indices[face * 3 + 2]),
		]);
		const min: [number, number] = uvValues.length ? [Math.min(...uvValues.map((value) => value[0])), Math.min(...uvValues.map((value) => value[1]))] : [0, 0];
		const max: [number, number] = uvValues.length ? [Math.max(...uvValues.map((value) => value[0])), Math.max(...uvValues.map((value) => value[1]))] : [0, 0];
		return {
			id,
			faceCount: faces.length,
			vertexCount: roots.size,
			boundaryEdgeCount: charts.boundaryEdgesByChart[id].length,
			seamEdgeCount: [...state.seams].filter((key) => topology.edges.get(key)?.some((occurrence) => faceSet.has(occurrence.face))).length,
			uvBounds: { min, max },
			surfaceArea: faces.reduce((sum, face) => sum + getFaceSurfaceArea(mesh, face), 0),
		};
	});
	const seamEdgeIndices = topology.rawEdgeLogicalKeys.flatMap((key, index) => (state.seams.has(key) ? [index] : []));
	return {
		node: { id: node.id, name: node.name },
		version: 1,
		revision: state.revision,
		logicalTopologyFingerprint: topology.fingerprint,
		stale: state.stale,
		derivedFromCurrentUvs: state.derived,
		model: state.stored?.lastUnwrap?.model ?? null,
		seamCount: state.seams.size,
		seamEdgeIndices: seamEdgeIndices.slice(0, 4096),
		seamEdgeIndicesTruncated: seamEdgeIndices.length > 4096,
		chartCount: chartSummaries.length,
		charts: chartSummaries.slice(offset, offset + limit),
		page: { offset, limit, total: chartSummaries.length, hasMore: offset + limit < chartSummaries.length },
		lastUnwrap: state.stored?.lastUnwrap ?? null,
	};
}

/** Returns persistent seam state plus bounded current chart and packing evidence. */
export function getMeshUvLayout(scene: Scene, data: any): any {
	const mesh = getMeshVertexData(scene, data);
	const node = resolveNode({ scene, nodeId: mesh.node.id });
	const topology = buildLogicalTopology(mesh);
	return getUvLayoutSummary(node, mesh, topology, getUvState(node, mesh, topology), data);
}

/** Atomically replaces, adds, or removes persistent logical UV seams under an exact revision. */
export function setMeshUvSeams(scene: Scene, data: any, options: IMCPActionOptions): any {
	const mesh = getMeshVertexData(scene, data);
	const node = resolveNode({ scene, nodeId: mesh.node.id });
	const topology = buildLogicalTopology(mesh);
	const state = getUvState(node, mesh, topology);
	if (data.expectedRevision !== state.revision) {
		throw new Error(`UV seam revision is stale: expected ${data.expectedRevision}, current revision is ${state.revision}.`);
	}
	if (!Array.isArray(data.edgeIndices) || data.edgeIndices.length > 4096 || new Set(data.edgeIndices).size !== data.edgeIndices.length) {
		throw new Error("edgeIndices must contain at most 4096 unique current topology edge IDs.");
	}
	if (data.edgeIndices.some((index: number) => !Number.isInteger(index) || index < 0 || index >= topology.rawEdges.length)) {
		throw new Error(`UV seam edge indices must be integers from 0 to ${topology.rawEdges.length - 1}.`);
	}
	const selected = new Set<string>();
	for (const index of data.edgeIndices as number[]) {
		const key = topology.rawEdgeLogicalKeys[index];
		if ((topology.edges.get(key)?.length ?? 0) < 2) {
			throw new Error(`Edge ${index} is already a mesh boundary and cannot create an additional UV seam.`);
		}
		selected.add(key);
	}
	const mode = data.mode ?? "replace";
	if (!(mode === "replace" || mode === "add" || mode === "remove")) {
		throw new Error('UV seam mode must be "replace", "add", or "remove".');
	}
	const seams = mode === "replace" ? new Set<string>() : new Set(state.seams);
	for (const key of selected) {
		if (mode === "remove") {
			seams.delete(key);
		} else {
			seams.add(key);
		}
	}
	publishUvState(node, topology, state.revision + 1, seams, null);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return getUvLayoutSummary(node, mesh, topology, getUvState(node, mesh, topology), { offset: 0, limit: 256 });
}

function capturePreservedVertexStreams(node: any, vertexCount: number): IPreservedVertexStream[] {
	const replacedKinds = new Set([
		VertexBuffer.PositionKind,
		VertexBuffer.NormalKind,
		VertexBuffer.UVKind,
		VertexBuffer.MatricesIndicesKind,
		VertexBuffer.MatricesWeightsKind,
		VertexBuffer.MatricesIndicesExtraKind,
		VertexBuffer.MatricesWeightsExtraKind,
	]);
	return node
		.getVerticesDataKinds()
		.filter((kind: string) => !replacedKinds.has(kind) && node.getVertexBuffer(kind)?.getIsInstanced() !== true)
		.map((kind: string) => {
			const buffer = node.getVertexBuffer(kind);
			const values = Array.from(node.getVerticesData(kind, false) ?? []) as number[];
			const stride = buffer?.getStrideSize() ?? 0;
			if (!buffer || !Number.isInteger(stride) || stride < 1 || values.length !== vertexCount * stride) {
				throw new Error(
					`UV unwrap cannot safely preserve vertex stream "${kind}"; expected ${vertexCount} complete vertices but found ${values.length} values at stride ${stride}.`
				);
			}
			return { kind, stride, updatable: buffer.isUpdatable(), values };
		});
}

function hasClosedBoundaryLoops(edges: Array<[number, number]>): boolean {
	const adjacency = new Map<number, Set<number>>();
	for (const [first, second] of edges) {
		const firstNeighbors = adjacency.get(first) ?? new Set<number>();
		const secondNeighbors = adjacency.get(second) ?? new Set<number>();
		firstNeighbors.add(second);
		secondNeighbors.add(first);
		adjacency.set(first, firstNeighbors);
		adjacency.set(second, secondNeighbors);
	}
	return adjacency.size > 0 && [...adjacency.values()].every((neighbors) => neighbors.size === 2);
}

function addAutomaticOpeningSeams(topology: ILogicalTopology, seams: Set<string>): number {
	const initial = buildChartTopology(topology, seams);
	let added = 0;
	for (let chart = 0; chart < initial.chartFaces.length; chart++) {
		if (hasClosedBoundaryLoops(initial.boundaryEdgesByChart[chart])) {
			continue;
		}
		const faces = new Set(initial.chartFaces[chart]);
		const forest = new DisjointSet(topology.faceCount);
		for (const [key, occurrences] of [...topology.edges.entries()].sort(([first], [second]) => first.localeCompare(second))) {
			if (seams.has(key) || occurrences.length !== 2 || !faces.has(occurrences[0].face) || !faces.has(occurrences[1].face)) {
				continue;
			}
			if (!forest.union(occurrences[0].face, occurrences[1].face)) {
				seams.add(key);
				added++;
			}
		}
	}
	return added;
}

function getRootPosition(mesh: any, chartTopology: IUvChartTopology, root: number): Vector3 {
	const corner = chartTopology.rootCorners.get(root)![0];
	return Vector3.FromArray(mesh.positions, mesh.indices[corner] * 3);
}

function getBoundaryLoop(edges: Array<[number, number]>, chartTopology: IUvChartTopology, mesh: any): number[] | null {
	const adjacency = new Map<number, Set<number>>();
	for (const [first, second] of edges) {
		const firstNeighbors = adjacency.get(first) ?? new Set<number>();
		const secondNeighbors = adjacency.get(second) ?? new Set<number>();
		firstNeighbors.add(second);
		secondNeighbors.add(first);
		adjacency.set(first, firstNeighbors);
		adjacency.set(second, secondNeighbors);
	}
	if (!adjacency.size || [...adjacency.values()].some((neighbors) => neighbors.size !== 2)) {
		return null;
	}
	const loops: number[][] = [];
	const visited = new Set<string>();
	for (const start of [...adjacency.keys()].sort((first, second) => first - second)) {
		for (const firstNeighbor of adjacency.get(start)!) {
			const firstKey = start < firstNeighbor ? `${start}:${firstNeighbor}` : `${firstNeighbor}:${start}`;
			if (visited.has(firstKey)) {
				continue;
			}
			const loop = [start];
			let previous = start;
			let current = firstNeighbor;
			for (let guard = 0; guard <= adjacency.size + 1; guard++) {
				loop.push(current);
				visited.add(previous < current ? `${previous}:${current}` : `${current}:${previous}`);
				const next = [...adjacency.get(current)!].find((candidate) => candidate !== previous);
				if (next === undefined || next === start) {
					break;
				}
				previous = current;
				current = next;
			}
			if (loop.length >= 3) {
				loops.push(loop);
			}
		}
	}
	if (!loops.length) {
		return null;
	}
	return loops.sort((first, second) => {
		const length = (loop: number[]): number =>
			loop.reduce(
				(sum, root, index) => sum + Vector3.Distance(getRootPosition(mesh, chartTopology, root), getRootPosition(mesh, chartTopology, loop[(index + 1) % loop.length])),
				0
			);
		return length(second) - length(first);
	})[0];
}

function flattenChart(mesh: any, chartTopology: IUvChartTopology, id: number, relaxIterations: number, relaxStrength: number, normalizeTexelDensity: boolean): IFlattenedChart {
	const faces = chartTopology.chartFaces[id];
	const roots = new Set(faces.flatMap((face) => [chartTopology.cornerRoots[face * 3], chartTopology.cornerRoots[face * 3 + 1], chartTopology.cornerRoots[face * 3 + 2]]));
	const origin = [...roots].reduce((sum, root) => sum.add(getRootPosition(mesh, chartTopology, root)), Vector3.Zero()).scale(1 / roots.size);
	let normal = Vector3.Zero();
	let dominantNormal = Vector3.Zero();
	for (const face of faces) {
		const first = Vector3.FromArray(mesh.positions, mesh.indices[face * 3] * 3);
		const second = Vector3.FromArray(mesh.positions, mesh.indices[face * 3 + 1] * 3);
		const third = Vector3.FromArray(mesh.positions, mesh.indices[face * 3 + 2] * 3);
		const faceNormal = Vector3.Cross(second.subtract(first), third.subtract(first));
		normal.addInPlace(faceNormal);
		if (faceNormal.lengthSquared() > dominantNormal.lengthSquared()) {
			dominantNormal = faceNormal;
		}
	}
	if (normal.lengthSquared() < 0.0000001) {
		normal = dominantNormal;
	}
	if (normal.lengthSquared() < 0.0000001) {
		throw new Error(`UV chart ${id} contains only degenerate faces and has no usable surface normal.`);
	}
	normal.normalize();
	const reference = Math.abs(normal.y) < 0.9 ? Vector3.Up() : Vector3.Right();
	const tangent = Vector3.Cross(reference, normal).normalize();
	const bitangent = Vector3.Cross(normal, tangent).normalize();
	const coordinates = new Map<number, [number, number]>();
	for (const root of roots) {
		const relative = getRootPosition(mesh, chartTopology, root).subtract(origin);
		coordinates.set(root, [Vector3.Dot(relative, tangent), Vector3.Dot(relative, bitangent)]);
	}
	const boundaryLoop = getBoundaryLoop(chartTopology.boundaryEdgesByChart[id], chartTopology, mesh);
	const pinned = new Set<number>();
	if (boundaryLoop) {
		const lengths = boundaryLoop.map((root, index) =>
			Vector3.Distance(getRootPosition(mesh, chartTopology, root), getRootPosition(mesh, chartTopology, boundaryLoop[(index + 1) % boundaryLoop.length]))
		);
		const perimeter = lengths.reduce((sum, value) => sum + value, 0);
		let distance = 0;
		for (let index = 0; index < boundaryLoop.length; index++) {
			const angle = (distance / Math.max(perimeter, 0.000001)) * Math.PI * 2;
			coordinates.set(boundaryLoop[index], [Math.cos(angle), Math.sin(angle)]);
			pinned.add(boundaryLoop[index]);
			distance += lengths[index];
		}
	} else {
		for (const [first, second] of chartTopology.boundaryEdgesByChart[id]) {
			pinned.add(first);
			pinned.add(second);
		}
	}
	if (!pinned.size) {
		throw new Error(`UV chart ${id} is closed and could not be opened; enable autoSeams or author an explicit seam.`);
	}
	for (let iteration = 0; iteration < relaxIterations; iteration++) {
		const next = new Map(coordinates);
		for (const root of roots) {
			if (pinned.has(root)) {
				continue;
			}
			const neighbors = [...(chartTopology.rootNeighbors.get(root) ?? [])].filter((neighbor) => roots.has(neighbor));
			if (!neighbors.length) {
				continue;
			}
			const average: [number, number] = [
				neighbors.reduce((sum, neighbor) => sum + coordinates.get(neighbor)![0], 0) / neighbors.length,
				neighbors.reduce((sum, neighbor) => sum + coordinates.get(neighbor)![1], 0) / neighbors.length,
			];
			const current = coordinates.get(root)!;
			next.set(root, [current[0] + (average[0] - current[0]) * relaxStrength, current[1] + (average[1] - current[1]) * relaxStrength]);
		}
		for (const [root, value] of next) {
			coordinates.set(root, value);
		}
	}
	const uvArea = faces.reduce((sum, face) => {
		const first = coordinates.get(chartTopology.cornerRoots[face * 3])!;
		const second = coordinates.get(chartTopology.cornerRoots[face * 3 + 1])!;
		const third = coordinates.get(chartTopology.cornerRoots[face * 3 + 2])!;
		return sum + Math.abs((second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])) * 0.5;
	}, 0);
	const surfaceArea = faces.reduce((sum, face) => sum + getFaceSurfaceArea(mesh, face), 0);
	const densityScale = normalizeTexelDensity ? Math.sqrt(surfaceArea / Math.max(uvArea, 0.000000001)) : 1;
	for (const [root, value] of coordinates) {
		coordinates.set(root, [value[0] * densityScale, value[1] * densityScale]);
	}
	const values = [...coordinates.values()];
	const min: [number, number] = [Math.min(...values.map((value) => value[0])), Math.min(...values.map((value) => value[1]))];
	const max: [number, number] = [Math.max(...values.map((value) => value[0])), Math.max(...values.map((value) => value[1]))];
	return { id, faces, coordinates, surfaceArea, width: Math.max(max[0] - min[0], 0.000001), height: Math.max(max[1] - min[1], 0.000001), min, max };
}

function tryPackCharts(charts: IFlattenedChart[], scale: number, padding: number, allowRotation: boolean): IPackedChart[] | null {
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	const packed: IPackedChart[] = [];
	for (const chart of charts) {
		const orientations = allowRotation ? [false, true] : [false];
		const candidates = orientations.map((rotated) => {
			const width = (rotated ? chart.height : chart.width) * scale + padding * 2;
			const height = (rotated ? chart.width : chart.height) * scale + padding * 2;
			const nextRow = x > 0 && x + width > 1 + 0.0000001;
			const candidateX = nextRow ? 0 : x;
			const candidateY = nextRow ? y + rowHeight : y;
			return { rotated, width, height, x: candidateX, y: candidateY, rowHeight: nextRow ? 0 : rowHeight };
		});
		const candidate = candidates
			.filter((value) => value.width <= 1 + 0.0000001 && value.y + value.height <= 1 + 0.0000001)
			.sort((first, second) => first.y + first.height - (second.y + second.height) || first.width - second.width || Number(first.rotated) - Number(second.rotated))[0];
		if (!candidate) {
			return null;
		}
		packed.push({ chart, x: candidate.x + padding, y: candidate.y + padding, rotated: candidate.rotated, scale });
		x = candidate.x + candidate.width;
		y = candidate.y;
		rowHeight = Math.max(candidate.rowHeight, candidate.height);
	}
	return packed;
}

function packCharts(charts: IFlattenedChart[], padding: number, allowRotation: boolean): IPackedChart[] {
	const ordered = [...charts].sort(
		(first, second) => Math.max(second.width, second.height) - Math.max(first.width, first.height) || second.surfaceArea - first.surfaceArea || first.id - second.id
	);
	if (!tryPackCharts(ordered, 0, padding, allowRotation)) {
		throw new Error(`UV padding ${padding} leaves no room for ${charts.length} charts; reduce padding or author fewer seams.`);
	}
	let low = 0;
	let high = 1 / Math.max(...ordered.map((chart) => Math.max(chart.width, chart.height)), 0.000001);
	for (let iteration = 0; iteration < 40; iteration++) {
		const middle = (low + high) * 0.5;
		if (tryPackCharts(ordered, middle, padding, allowRotation)) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return tryPackCharts(ordered, low, padding, allowRotation)!;
}

/** Performs chart-aware seam splitting, harmonic relaxation, texel-density normalization, and deterministic atlas packing. */
export function unwrapMeshUVs(scene: Scene, data: any, options: IMCPActionOptions): any {
	const mesh = getMeshVertexData(scene, data);
	const node = resolveNode({ scene, nodeId: mesh.node.id });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (node.morphTargetManager?.numTargets) {
		throw new Error("Chart-aware UV unwrap cannot change vertex topology while morph targets are attached; bake or detach morph targets first.");
	}
	const padding = data.padding ?? 0.01;
	const relaxIterations = data.relaxIterations ?? 20;
	const relaxStrength = data.relaxStrength ?? 0.5;
	const allowRotation = data.allowRotation ?? true;
	const autoSeams = data.autoSeams ?? true;
	const normalizeTexelDensity = data.normalizeTexelDensity ?? true;
	if (!Number.isFinite(padding) || padding < 0 || padding > 0.1) {
		throw new Error("UV chart padding must be between 0 and 0.1 atlas units.");
	}
	if (!Number.isInteger(relaxIterations) || relaxIterations < 0 || relaxIterations > 100) {
		throw new Error("UV relax iterations must be an integer from 0 to 100.");
	}
	if (!Number.isFinite(relaxStrength) || relaxStrength <= 0 || relaxStrength > 1) {
		throw new Error("UV relax strength must be greater than 0 and at most 1.");
	}
	if (!mesh.indices.length || mesh.indices.length / 3 > 100_000) {
		throw new Error("Chart-aware UV unwrap requires 1 to 100,000 triangle faces.");
	}
	const topology = buildLogicalTopology(mesh);
	const state = getUvState(node, mesh, topology);
	if (data.expectedRevision !== state.revision) {
		throw new Error(`UV layout revision is stale: expected ${data.expectedRevision}, current revision is ${state.revision}.`);
	}
	const effectiveSeams = new Set(state.seams);
	const smoothingGroups = node.metadata?.babylonEditorSmoothingGroups ? JSON.parse(JSON.stringify(node.metadata.babylonEditorSmoothingGroups)) : undefined;
	const preservedStreams = capturePreservedVertexStreams(node, mesh.positions.length / 3);
	const autoSeamCount = autoSeams ? addAutomaticOpeningSeams(topology, effectiveSeams) : 0;
	const chartTopology = buildChartTopology(topology, effectiveSeams);
	const flattened = chartTopology.chartFaces.map((_, id) => flattenChart(mesh, chartTopology, id, relaxIterations, relaxStrength, normalizeTexelDensity));
	const packed = packCharts(flattened, padding, allowRotation);
	const placementByChart = new Map(packed.map((value) => [value.chart.id, value]));
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const matricesIndices: number[] = [];
	const matricesWeights: number[] = [];
	const matricesIndicesExtra: number[] = [];
	const matricesWeightsExtra: number[] = [];
	const indices: number[] = [];
	const sourceByOutput: number[] = [];
	const outputVertexByCornerKey = new Map<string, number>();
	for (let face = 0; face < topology.faceCount; face++) {
		const chart = chartTopology.chartByFace[face];
		const placement = placementByChart.get(chart)!;
		for (let corner = 0; corner < 3; corner++) {
			const source = mesh.indices[face * 3 + corner];
			const root = chartTopology.cornerRoots[face * 3 + corner];
			const key = `${root}:${source}`;
			let output = outputVertexByCornerKey.get(key);
			if (output === undefined) {
				output = positions.length / 3;
				outputVertexByCornerKey.set(key, output);
				sourceByOutput.push(source);
				positions.push(mesh.positions[source * 3], mesh.positions[source * 3 + 1], mesh.positions[source * 3 + 2]);
				if (mesh.normals.length) {
					normals.push(mesh.normals[source * 3], mesh.normals[source * 3 + 1], mesh.normals[source * 3 + 2]);
				}
				for (const [sourceValues, targetValues] of [
					[mesh.matricesIndices, matricesIndices],
					[mesh.matricesWeights, matricesWeights],
					[mesh.matricesIndicesExtra, matricesIndicesExtra],
					[mesh.matricesWeightsExtra, matricesWeightsExtra],
				] as Array<[number[], number[]]>) {
					if (sourceValues.length) {
						targetValues.push(sourceValues[source * 4], sourceValues[source * 4 + 1], sourceValues[source * 4 + 2], sourceValues[source * 4 + 3]);
					}
				}
				const coordinate = placement.chart.coordinates.get(root)!;
				const localU = (coordinate[0] - placement.chart.min[0]) * placement.scale;
				const localV = (coordinate[1] - placement.chart.min[1]) * placement.scale;
				uvs.push(placement.x + (placement.rotated ? localV : localU), placement.y + (placement.rotated ? placement.chart.width * placement.scale - localU : localV));
			}
			indices.push(output);
		}
	}
	const result = setMeshVertexData(
		scene,
		{
			nodeId: mesh.node.id,
			positions,
			normals,
			uvs,
			indices,
			matricesIndices: matricesIndices.length ? matricesIndices : undefined,
			matricesWeights: matricesWeights.length ? matricesWeights : undefined,
			matricesIndicesExtra: matricesIndicesExtra.length ? matricesIndicesExtra : undefined,
			matricesWeightsExtra: matricesWeightsExtra.length ? matricesWeightsExtra : undefined,
		},
		options
	);
	for (const stream of preservedStreams) {
		const values = sourceByOutput.flatMap((source) => stream.values.slice(source * stream.stride, source * stream.stride + stream.stride));
		node.setVerticesData(stream.kind, values, stream.updatable, stream.stride);
	}
	if (smoothingGroups?.model === "coincident-face-smoothing-groups-v1" && smoothingGroups.faceGroups?.length === indices.length / 3) {
		smoothingGroups.topologyFingerprint = getMeshTopologyFingerprint(positions, indices);
		node.metadata ??= {};
		node.metadata.babylonEditorSmoothingGroups = smoothingGroups;
	}
	if (node.metadata) {
		delete node.metadata.babylonEditorVertexColors;
	}
	const outputTopology = buildLogicalTopology(result);
	const chartEvidence = packed
		.sort((first, second) => first.chart.id - second.chart.id)
		.map((placement) => {
			const values = [...placement.chart.coordinates.values()].map((coordinate) => {
				const localU = (coordinate[0] - placement.chart.min[0]) * placement.scale;
				const localV = (coordinate[1] - placement.chart.min[1]) * placement.scale;
				return [placement.x + (placement.rotated ? localV : localU), placement.y + (placement.rotated ? placement.chart.width * placement.scale - localU : localV)] as [
					number,
					number,
				];
			});
			return {
				id: placement.chart.id,
				faceCount: placement.chart.faces.length,
				vertexCount: placement.chart.coordinates.size,
				rotated: placement.rotated,
				uvBounds: {
					min: [Math.min(...values.map((value) => value[0])), Math.min(...values.map((value) => value[1]))] as [number, number],
					max: [Math.max(...values.map((value) => value[0])), Math.max(...values.map((value) => value[1]))] as [number, number],
				},
				surfaceArea: placement.chart.surfaceArea,
			};
		});
	const atlasUtilization = chartEvidence.reduce((sum, chart) => sum + (chart.uvBounds.max[0] - chart.uvBounds.min[0]) * (chart.uvBounds.max[1] - chart.uvBounds.min[1]), 0);
	const lastUnwrap: IStoredUvLayout["lastUnwrap"] = {
		model: UV_LAYOUT_MODEL,
		padding,
		relaxIterations,
		relaxStrength,
		allowRotation,
		autoSeams,
		autoSeamCount,
		normalizeTexelDensity,
		chartCount: chartEvidence.length,
		atlasUtilization,
		charts: chartEvidence,
	};
	publishUvState(node, outputTopology, state.revision + 1, effectiveSeams, lastUnwrap);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return {
		...result,
		unwrap: lastUnwrap,
		uvLayout: getUvLayoutSummary(node, result, outputTopology, getUvState(node, result, outputTopology), { offset: 0, limit: 256 }),
		duplicatedVertices: positions.length / 3 - mesh.positions.length / 3,
		preservedVertexStreams: preservedStreams.map((stream) => ({ kind: stream.kind, stride: stream.stride })),
	};
}

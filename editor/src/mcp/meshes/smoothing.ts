import { Mesh, Scene, Vector3, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { applyLoopCutMeshSnapshot, captureLoopCutMeshSnapshot, ILoopCutMeshSnapshot } from "./loop-cut";
import { getMeshTopologyFingerprint } from "./meshes";

const SMOOTHING_MODEL = "coincident-face-smoothing-groups-v1";
const SMOOTHING_METADATA_KEY = "babylonEditorSmoothingGroups";
const MAXIMUM_SMOOTHING_GROUP = 24;
const MAXIMUM_FACE_COUNT = 100_000;
const MAXIMUM_SELECTED_FACES = 4_096;
const MAXIMUM_STREAM_VALUES = 20_000_000;
const POSITION_PRECISION = 1_000_000;
const NORMAL_EPSILON = 0.0000000001;

interface IStoredSmoothingGroups {
	version: 1;
	model: typeof SMOOTHING_MODEL;
	revision: number;
	topologyFingerprint: string;
	faceGroups: number[];
	lastOperation: null | {
		type: "set" | "auto";
		faceCount: number;
		group?: number;
		angleThreshold?: number;
		componentCount?: number;
	};
}

interface ISmoothingState {
	stored: IStoredSmoothingGroups | null;
	revision: number;
	faceGroups: number[];
	topologyFingerprint: string;
	stale: boolean;
	derivedFromNormals: boolean;
}

interface IFaceGeometry {
	vertices: [number, number, number];
	positionKeys: [string, string, string];
	normal: Vector3;
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

	public union(first: number, second: number): void {
		let firstRoot = this.find(first);
		let secondRoot = this.find(second);
		if (firstRoot === secondRoot) {
			return;
		}
		if (this._ranks[firstRoot] < this._ranks[secondRoot]) {
			[firstRoot, secondRoot] = [secondRoot, firstRoot];
		}
		this._parents[secondRoot] = firstRoot;
		if (this._ranks[firstRoot] === this._ranks[secondRoot]) {
			this._ranks[firstRoot]++;
		}
	}
}

function copySerializable(value: any): any {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getPositionStream(snapshot: ILoopCutMeshSnapshot): ILoopCutMeshSnapshot["streams"][number] {
	const stream = snapshot.streams.find((candidate) => candidate.kind === VertexBuffer.PositionKind);
	if (!stream || stream.stride !== 3) {
		throw new Error("Smoothing groups require a complete three-component position stream.");
	}
	return stream;
}

function getPositionKey(positions: number[], vertex: number): string {
	const offset = vertex * 3;
	return `${Math.round(positions[offset] * POSITION_PRECISION)},${Math.round(positions[offset + 1] * POSITION_PRECISION)},${Math.round(
		positions[offset + 2] * POSITION_PRECISION
	)}`;
}

function getFaceGeometry(snapshot: ILoopCutMeshSnapshot): IFaceGeometry[] {
	const positions = getPositionStream(snapshot).values;
	return Array.from({ length: snapshot.indices.length / 3 }, (_, face) => {
		const vertices = snapshot.indices.slice(face * 3, face * 3 + 3) as [number, number, number];
		const first = Vector3.FromArray(positions, vertices[0] * 3);
		const second = Vector3.FromArray(positions, vertices[1] * 3);
		const third = Vector3.FromArray(positions, vertices[2] * 3);
		const normal = Vector3.Cross(second.subtract(first), third.subtract(first));
		if (normal.lengthSquared() <= NORMAL_EPSILON) {
			throw new Error(`Smoothing groups require non-degenerate triangles; face ${face} has zero area.`);
		}
		normal.normalize();
		return {
			vertices,
			positionKeys: vertices.map((vertex) => getPositionKey(positions, vertex)) as [string, string, string],
			normal,
		};
	});
}

function isStoredSmoothingGroups(value: any, faceCount: number): value is IStoredSmoothingGroups {
	return (
		value?.version === 1 &&
		value?.model === SMOOTHING_MODEL &&
		Number.isInteger(value.revision) &&
		value.revision >= 0 &&
		Array.isArray(value.faceGroups) &&
		value.faceGroups.length === faceCount &&
		value.faceGroups.every((group: unknown) => Number.isInteger(group) && (group as number) >= 0 && (group as number) <= MAXIMUM_SMOOTHING_GROUP)
	);
}

function deriveFaceGroupsFromNormals(snapshot: ILoopCutMeshSnapshot): number[] {
	const normalStream = snapshot.streams.find((stream) => stream.kind === VertexBuffer.NormalKind);
	const faceCount = snapshot.indices.length / 3;
	if (!normalStream || normalStream.stride !== 3) {
		return new Array(faceCount).fill(0);
	}
	const faces = getFaceGeometry(snapshot);
	const disjoint = new DisjointSet(faceCount);
	const edgeOccurrences = new Map<string, Array<{ face: number; firstCorner: number; secondCorner: number }>>();
	for (let face = 0; face < faceCount; face++) {
		for (let corner = 0; corner < 3; corner++) {
			const secondCorner = (corner + 1) % 3;
			const key = getLogicalEdgeKey(faces[face].positionKeys[corner], faces[face].positionKeys[secondCorner]);
			const occurrences = edgeOccurrences.get(key) ?? [];
			occurrences.push({ face, firstCorner: corner, secondCorner });
			edgeOccurrences.set(key, occurrences);
		}
	}
	const getCornerNormal = (face: number, corner: number): Vector3 => {
		const vertex = faces[face].vertices[corner];
		const normal = Vector3.FromArray(normalStream.values, vertex * 3);
		return normal.lengthSquared() > NORMAL_EPSILON ? normal.normalize() : faces[face].normal;
	};
	const smoothEdges: Array<[number, number]> = [];
	for (const occurrences of edgeOccurrences.values()) {
		if (occurrences.length !== 2) {
			continue;
		}
		const [first, second] = occurrences;
		const firstKeys = [faces[first.face].positionKeys[first.firstCorner], faces[first.face].positionKeys[first.secondCorner]];
		const secondKeys = [faces[second.face].positionKeys[second.firstCorner], faces[second.face].positionKeys[second.secondCorner]];
		const smooth = firstKeys.every((key, endpoint) => {
			const secondEndpoint = secondKeys.indexOf(key);
			return (
				secondEndpoint >= 0 &&
				Vector3.Dot(
					getCornerNormal(first.face, endpoint === 0 ? first.firstCorner : first.secondCorner),
					getCornerNormal(second.face, secondEndpoint === 0 ? second.firstCorner : second.secondCorner)
				) >= 0.9999
			);
		});
		if (smooth) {
			disjoint.union(first.face, second.face);
			smoothEdges.push([first.face, second.face]);
		}
	}
	const components = new Map<number, number[]>();
	for (let face = 0; face < faceCount; face++) {
		const root = disjoint.find(face);
		const entries = components.get(root) ?? [];
		entries.push(face);
		components.set(root, entries);
	}
	const smoothRoots = new Set(smoothEdges.flatMap(([first, second]) => [disjoint.find(first), disjoint.find(second)]));
	const adjacency = new Map<number, Set<number>>();
	for (const occurrences of edgeOccurrences.values()) {
		if (occurrences.length !== 2) {
			continue;
		}
		const firstRoot = disjoint.find(occurrences[0].face);
		const secondRoot = disjoint.find(occurrences[1].face);
		if (firstRoot === secondRoot) {
			continue;
		}
		const firstNeighbors = adjacency.get(firstRoot) ?? new Set<number>();
		firstNeighbors.add(secondRoot);
		adjacency.set(firstRoot, firstNeighbors);
		const secondNeighbors = adjacency.get(secondRoot) ?? new Set<number>();
		secondNeighbors.add(firstRoot);
		adjacency.set(secondRoot, secondNeighbors);
	}
	const groupByRoot = new Map<number, number>();
	for (const [root] of [...components.entries()].sort((first, second) => first[1][0] - second[1][0])) {
		if (!smoothRoots.has(root)) {
			groupByRoot.set(root, 0);
			continue;
		}
		const unavailable = new Set([...(adjacency.get(root) ?? [])].map((neighbor) => groupByRoot.get(neighbor)).filter((group) => group !== undefined && group! > 0));
		const group = Array.from({ length: MAXIMUM_SMOOTHING_GROUP }, (_, index) => index + 1).find((candidate) => !unavailable.has(candidate));
		if (!group) {
			throw new Error(`Current mesh normals require more than ${MAXIMUM_SMOOTHING_GROUP} mutually adjacent smoothing groups.`);
		}
		groupByRoot.set(root, group);
	}
	return Array.from({ length: faceCount }, (_, face) => groupByRoot.get(disjoint.find(face)) ?? 0);
}

function getSmoothingState(mesh: Mesh, snapshot: ILoopCutMeshSnapshot): ISmoothingState {
	const position = getPositionStream(snapshot);
	const topologyFingerprint = getMeshTopologyFingerprint(position.values, snapshot.indices);
	const faceCount = snapshot.indices.length / 3;
	const stored = mesh.metadata?.[SMOOTHING_METADATA_KEY];
	if (isStoredSmoothingGroups(stored, faceCount) && stored.topologyFingerprint === topologyFingerprint) {
		return { stored: copySerializable(stored), revision: stored.revision, faceGroups: [...stored.faceGroups], topologyFingerprint, stale: false, derivedFromNormals: false };
	}
	const faceGroups = deriveFaceGroupsFromNormals(snapshot);
	return {
		stored: null,
		revision: 0,
		faceGroups,
		topologyFingerprint,
		stale: stored !== undefined,
		derivedFromNormals: true,
	};
}

function validateFaceIndices(faceIndices: any, faceCount: number, allowEmpty = false): number[] {
	if (!Array.isArray(faceIndices) || (!allowEmpty && !faceIndices.length) || faceIndices.length > MAXIMUM_SELECTED_FACES || new Set(faceIndices).size !== faceIndices.length) {
		throw new Error(`faceIndices must contain ${allowEmpty ? "0" : "1"} to ${MAXIMUM_SELECTED_FACES.toLocaleString()} unique current triangle-face IDs.`);
	}
	if (faceIndices.some((face) => !Number.isInteger(face) || face < 0 || face >= faceCount)) {
		throw new Error(`Smoothing face IDs must be integers from 0 to ${faceCount - 1}.`);
	}
	return [...faceIndices].sort((first, second) => first - second);
}

function validateMeshBounds(snapshot: ILoopCutMeshSnapshot): void {
	const faceCount = snapshot.indices.length / 3;
	if (faceCount > MAXIMUM_FACE_COUNT) {
		throw new Error(`Smoothing groups support at most ${MAXIMUM_FACE_COUNT.toLocaleString()} triangles per mesh.`);
	}
	const totalValues = snapshot.streams.reduce((total, stream) => total + stream.values.length, 0);
	if (snapshot.streams.length > 32 || totalValues > MAXIMUM_STREAM_VALUES) {
		throw new Error("Smoothing groups cannot safely rebuild this mesh because its vertex-stream workload exceeds the bounded editor limit.");
	}
	const normal = snapshot.streams.find((stream) => stream.kind === VertexBuffer.NormalKind);
	if (normal && normal.stride !== 3) {
		throw new Error("Smoothing groups require the normal stream to use three components.");
	}
	const tangent = snapshot.streams.find((stream) => stream.kind === VertexBuffer.TangentKind);
	if (tangent && tangent.stride !== 3 && tangent.stride !== 4) {
		throw new Error("Smoothing groups require tangent streams to use three or four components.");
	}
}

function getVertexSignature(snapshot: ILoopCutMeshSnapshot, vertex: number): string {
	return snapshot.streams
		.filter((stream) => stream.kind !== VertexBuffer.NormalKind && stream.kind !== VertexBuffer.TangentKind)
		.map((stream) => `${stream.kind}:${stream.values.slice(vertex * stream.stride, vertex * stream.stride + stream.stride).join(",")}`)
		.join("|");
}

function getFallbackTangent(normal: Vector3): Vector3 {
	const axis = Math.abs(normal.y) < 0.9 ? Vector3.Up() : Vector3.Right();
	return Vector3.Cross(axis, normal).normalize();
}

function rebuildSmoothingGeometry(snapshot: ILoopCutMeshSnapshot, faceGroups: number[], metadata: IStoredSmoothingGroups): ILoopCutMeshSnapshot {
	validateMeshBounds(snapshot);
	const faces = getFaceGeometry(snapshot);
	if (faceGroups.length !== faces.length) {
		throw new Error("Smoothing group metadata must contain exactly one group for every triangle face.");
	}
	const outputStreams = new Map(snapshot.streams.map((stream) => [stream.kind, [] as number[]]));
	if (!outputStreams.has(VertexBuffer.NormalKind)) {
		outputStreams.set(VertexBuffer.NormalKind, []);
	}
	const outputIndices: number[] = [];
	const vertexBySignature = new Map<string, number>();
	const sourceByOutput: number[] = [];
	const normalKeyByOutput: string[] = [];
	const smoothNormalSums = new Map<string, Vector3>();

	for (let face = 0; face < faces.length; face++) {
		const geometry = faces[face];
		const group = faceGroups[face];
		for (let corner = 0; corner < 3; corner++) {
			const source = geometry.vertices[corner];
			const normalKey = group === 0 ? `hard:${face}` : `smooth:${group}:${geometry.positionKeys[corner]}`;
			if (group > 0) {
				const sum = smoothNormalSums.get(normalKey) ?? Vector3.Zero();
				sum.addInPlace(geometry.normal);
				smoothNormalSums.set(normalKey, sum);
			}
			const signature = `${getVertexSignature(snapshot, source)}|${group === 0 ? `hard:${face}` : `smooth:${group}`}`;
			let output = vertexBySignature.get(signature);
			if (output === undefined) {
				output = sourceByOutput.length;
				vertexBySignature.set(signature, output);
				sourceByOutput.push(source);
				normalKeyByOutput.push(normalKey);
				for (const stream of snapshot.streams) {
					outputStreams.get(stream.kind)!.push(...stream.values.slice(source * stream.stride, source * stream.stride + stream.stride));
				}
			}
			outputIndices.push(output);
		}
	}

	const normalValues = outputStreams.get(VertexBuffer.NormalKind)!;
	const sourceNormal = snapshot.streams.find((stream) => stream.kind === VertexBuffer.NormalKind);
	if (!sourceNormal) {
		normalValues.length = sourceByOutput.length * 3;
		normalValues.fill(0);
	}
	for (let output = 0; output < sourceByOutput.length; output++) {
		const key = normalKeyByOutput[output];
		const normal = key.startsWith("hard:") ? faces[Number(key.slice("hard:".length))].normal.clone() : (smoothNormalSums.get(key)?.clone() ?? Vector3.Up());
		normal.normalize();
		normalValues[output * 3] = normal.x;
		normalValues[output * 3 + 1] = normal.y;
		normalValues[output * 3 + 2] = normal.z;
	}

	const tangent = snapshot.streams.find((stream) => stream.kind === VertexBuffer.TangentKind);
	if (tangent) {
		const tangentValues = outputStreams.get(VertexBuffer.TangentKind)!;
		for (let output = 0; output < sourceByOutput.length; output++) {
			const offset = output * tangent.stride;
			const normal = Vector3.FromArray(normalValues, output * 3);
			const authored = Vector3.FromArray(tangentValues, offset);
			let projected = authored.subtract(normal.scale(Vector3.Dot(authored, normal)));
			if (projected.lengthSquared() <= NORMAL_EPSILON) {
				projected = getFallbackTangent(normal);
			} else {
				projected.normalize();
			}
			tangentValues[offset] = projected.x;
			tangentValues[offset + 1] = projected.y;
			tangentValues[offset + 2] = projected.z;
		}
	}

	const streams = snapshot.streams.map((stream) => ({ ...stream, values: outputStreams.get(stream.kind)! }));
	if (!sourceNormal) {
		streams.push({ kind: VertexBuffer.NormalKind, stride: 3, updatable: false, values: normalValues });
		streams.sort((first, second) => first.kind.localeCompare(second.kind));
	}
	const positions = streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values;
	metadata.topologyFingerprint = getMeshTopologyFingerprint(positions, outputIndices);
	return {
		streams,
		indices: outputIndices,
		subMeshes: snapshot.subMeshes.map((subMesh) => ({ ...subMesh })),
		selection: copySerializable(snapshot.selection),
		uvLayout: copySerializable(snapshot.uvLayout),
		smoothingGroups: metadata,
		vertexColors: undefined,
	};
}

function summarizeGroups(faceGroups: number[]): Array<{ group: number; faceCount: number }> {
	const counts = new Map<number, number>();
	for (const group of faceGroups) {
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	return [...counts.entries()].map(([group, faceCount]) => ({ group, faceCount })).sort((first, second) => first.group - second.group);
}

function inspectSmoothingGroups(mesh: Mesh, snapshot: ILoopCutMeshSnapshot, state: ISmoothingState, data: any): any {
	const faceCount = state.faceGroups.length;
	let candidates = Array.from({ length: faceCount }, (_, face) => face);
	if (data.group !== undefined) {
		if (!Number.isInteger(data.group) || data.group < 0 || data.group > MAXIMUM_SMOOTHING_GROUP) {
			throw new Error(`Smoothing group must be an integer from 0 to ${MAXIMUM_SMOOTHING_GROUP}.`);
		}
		candidates = candidates.filter((face) => state.faceGroups[face] === data.group);
	}
	if (data.faceIndices !== undefined) {
		if (data.group !== undefined || data.offset !== undefined || data.limit !== undefined) {
			throw new Error("faceIndices inspection cannot be combined with group, offset, or limit filters.");
		}
		candidates = validateFaceIndices(data.faceIndices, faceCount, true);
	}
	const offset = data.faceIndices !== undefined ? 0 : (data.offset ?? 0);
	const limit = data.faceIndices !== undefined ? Math.max(1, candidates.length) : (data.limit ?? 128);
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error("Smoothing group offset must be a non-negative integer.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("Smoothing group limit must be an integer from 1 to 256.");
	}
	if (data.faceIndices !== undefined && candidates.length > 256) {
		throw new Error("Direct smoothing face inspection supports at most 256 face IDs; use paginated inspection for larger sets.");
	}
	const page = candidates.slice(offset, offset + limit);
	const position = getPositionStream(snapshot);
	return {
		node: toNodeSummary(mesh),
		model: SMOOTHING_MODEL,
		topologyFingerprint: getMeshTopologyFingerprint(position.values, snapshot.indices),
		revision: state.revision,
		metadataCurrent: !state.stale,
		staleMetadataDiscarded: state.stale,
		derivedFromCurrentNormals: state.derivedFromNormals,
		maximumGroup: MAXIMUM_SMOOTHING_GROUP,
		faceCount,
		hardFaceCount: state.faceGroups.filter((group) => group === 0).length,
		smoothFaceCount: state.faceGroups.filter((group) => group > 0).length,
		groups: summarizeGroups(state.faceGroups),
		lastOperation: state.stored?.lastOperation ?? null,
		filterGroup: data.group ?? null,
		total: candidates.length,
		offset,
		limit,
		returned: page.length,
		hasMore: offset + page.length < candidates.length,
		faces: page.map((face) => ({ faceIndex: face, group: state.faceGroups[face], smooth: state.faceGroups[face] > 0 })),
	};
}

/** Inspects exact-leased per-face smoothing groups with bounded paging or selected-face lookup. */
export function getMeshSmoothingGroups(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const snapshot = captureLoopCutMeshSnapshot(scene, { nodeId: node.id });
	validateMeshBounds(snapshot);
	const state = getSmoothingState(node, snapshot);
	return inspectSmoothingGroups(node, snapshot, state, data);
}

function validateMutation(node: Mesh, data: any): { snapshot: ILoopCutMeshSnapshot; state: ISmoothingState; faceIndices: number[] } {
	if (node.morphTargetManager?.numTargets) {
		throw new Error("Smoothing groups cannot split or merge vertex normals while morph targets are attached; bake or detach morph targets first.");
	}
	const snapshot = captureLoopCutMeshSnapshot(node.getScene(), { nodeId: node.id });
	validateMeshBounds(snapshot);
	const state = getSmoothingState(node, snapshot);
	if (data.expectedTopologyFingerprint !== state.topologyFingerprint) {
		throw new Error(
			`Mesh topology is stale: expected "${data.expectedTopologyFingerprint}", current fingerprint is "${state.topologyFingerprint}". Call get_mesh_smoothing_groups again.`
		);
	}
	if (data.expectedRevision !== state.revision) {
		throw new Error(`Smoothing groups are stale: expected revision ${data.expectedRevision}, current revision is ${state.revision}.`);
	}
	return { snapshot, state, faceIndices: validateFaceIndices(data.faceIndices, state.faceGroups.length) };
}

function applySmoothingMutation(
	node: Mesh,
	snapshot: ILoopCutMeshSnapshot,
	state: ISmoothingState,
	faceGroups: number[],
	lastOperation: IStoredSmoothingGroups["lastOperation"],
	mutation: { options: IMCPActionOptions; inspectionFaceIndices: number[] }
): any {
	const metadata: IStoredSmoothingGroups = {
		version: 1,
		model: SMOOTHING_MODEL,
		revision: state.revision + 1,
		topologyFingerprint: state.topologyFingerprint,
		faceGroups,
		lastOperation,
	};
	const output = rebuildSmoothingGeometry(snapshot, faceGroups, metadata);
	applyLoopCutMeshSnapshot(node, output);
	mutation.options.editor.layout.inspector.setEditedObject(node);
	mutation.options.editor.layout.inspector.forceUpdate();
	return inspectSmoothingGroups(
		node,
		output,
		{ stored: metadata, revision: metadata.revision, faceGroups, topologyFingerprint: metadata.topologyFingerprint, stale: false, derivedFromNormals: false },
		{ faceIndices: mutation.inspectionFaceIndices }
	);
}

/** Assigns selected current triangle faces to group 0 (hard) or a Unity-style smooth group 1..24. */
export function setMeshSmoothingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (!Number.isInteger(data.group) || data.group < 0 || data.group > MAXIMUM_SMOOTHING_GROUP) {
		throw new Error(`Smoothing group must be an integer from 0 to ${MAXIMUM_SMOOTHING_GROUP}; group 0 keeps faces hard.`);
	}
	const { snapshot, state, faceIndices } = validateMutation(node, data);
	const faceGroups = [...state.faceGroups];
	faceIndices.forEach((face) => (faceGroups[face] = data.group));
	return {
		...applySmoothingMutation(
			node,
			snapshot,
			state,
			faceGroups,
			{ type: "set", faceCount: faceIndices.length, group: data.group },
			{
				options,
				inspectionFaceIndices: faceIndices.slice(0, 256),
			}
		),
		changedFaceIndices: faceIndices,
		assignedGroup: data.group,
	};
}

function getLogicalEdgeKey(first: string, second: string): string {
	return first < second ? `${first}|${second}` : `${second}|${first}`;
}

/** Automatically assigns unused smoothing groups to selected angle-connected face components. */
export function autoSmoothMeshFaces(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (!Number.isFinite(data.angleThreshold) || data.angleThreshold < 0 || data.angleThreshold > 180) {
		throw new Error("Automatic smoothing angleThreshold must be between 0 and 180 degrees.");
	}
	const { snapshot, state, faceIndices } = validateMutation(node, data);
	const faces = getFaceGeometry(snapshot);
	const selectedIndex = new Map(faceIndices.map((face, index) => [face, index]));
	const disjoint = new DisjointSet(faceIndices.length);
	const edgeFaces = new Map<string, number[]>();
	for (const face of faceIndices) {
		for (let corner = 0; corner < 3; corner++) {
			const key = getLogicalEdgeKey(faces[face].positionKeys[corner], faces[face].positionKeys[(corner + 1) % 3]);
			const occurrences = edgeFaces.get(key) ?? [];
			occurrences.push(face);
			edgeFaces.set(key, occurrences);
		}
	}
	const cosineThreshold = Math.cos((data.angleThreshold * Math.PI) / 180);
	for (const occurrences of edgeFaces.values()) {
		if (occurrences.length > 2) {
			throw new Error("Automatic smoothing requires manifold logical edges; repair non-manifold selected topology first.");
		}
		if (occurrences.length === 2 && Vector3.Dot(faces[occurrences[0]].normal, faces[occurrences[1]].normal) + 0.0000001 >= cosineThreshold) {
			disjoint.union(selectedIndex.get(occurrences[0])!, selectedIndex.get(occurrences[1])!);
		}
	}
	const componentFaces = new Map<number, number[]>();
	faceIndices.forEach((face, index) => {
		const root = disjoint.find(index);
		const component = componentFaces.get(root) ?? [];
		component.push(face);
		componentFaces.set(root, component);
	});
	const components = [...componentFaces.values()].sort((first, second) => first[0] - second[0]);
	const selected = new Set(faceIndices);
	const usedByUnselected = new Set(state.faceGroups.filter((group, face) => !selected.has(face) && group > 0));
	const availableGroups = Array.from({ length: MAXIMUM_SMOOTHING_GROUP }, (_, index) => index + 1).filter((group) => !usedByUnselected.has(group));
	if (components.length > availableGroups.length) {
		throw new Error(
			`Automatic smoothing found ${components.length} angle components but only ${availableGroups.length} isolated smoothing groups are available; clear or consolidate existing groups first.`
		);
	}
	const faceGroups = [...state.faceGroups];
	const assignments = components.map((facesInComponent, index) => {
		const group = availableGroups[index];
		facesInComponent.forEach((face) => (faceGroups[face] = group));
		return { group, faceIndices: facesInComponent };
	});
	return {
		...applySmoothingMutation(
			node,
			snapshot,
			state,
			faceGroups,
			{ type: "auto", faceCount: faceIndices.length, angleThreshold: data.angleThreshold, componentCount: components.length },
			{ options, inspectionFaceIndices: faceIndices.slice(0, 256) }
		),
		angleThreshold: data.angleThreshold,
		componentCount: components.length,
		assignments,
	};
}

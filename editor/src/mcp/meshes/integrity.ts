import { Mesh, Scene, SubMesh, VertexBuffer, VertexData } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { applyLoopCutMeshSnapshot, ILoopCutMeshSnapshot } from "./loop-cut";
import { getMeshTopologyFingerprint } from "./meshes";
import { isEditableMeshVertexStream } from "./editable-source";

const INTEGRITY_MODEL = "bounded-triangle-mesh-integrity-v1";
const MAXIMUM_VERTEX_COUNT = 500_000;
const MAXIMUM_FACE_COUNT = 100_000;
const MAXIMUM_STREAM_VALUES = 20_000_000;
const MAXIMUM_ISSUES = 100_000;
const DEFAULT_POSITION_TOLERANCE = 0.000001;
const NORMAL_EPSILON = 0.0000000001;

type IntegritySeverity = "error" | "warning" | "info";
type IntegrityCategory =
	| "positions"
	| "indices"
	| "streams"
	| "degenerateFaces"
	| "duplicateFaces"
	| "unusedVertices"
	| "weldableVertices"
	| "nonManifoldEdges"
	| "boundaryEdges"
	| "winding"
	| "components"
	| "normals"
	| "skinning"
	| "subMeshes";
type RepairOperation =
	| "removeInvalidFaces"
	| "removeDegenerateFaces"
	| "removeDuplicateFaces"
	| "removeUnusedVertices"
	| "weldIdenticalVertices"
	| "fixWinding"
	| "rebuildNormals"
	| "normalizeSkinWeights"
	| "rebuildSubMeshes";

interface IRawVertexStream {
	kind: string;
	stride: number;
	updatable: boolean;
	values: number[];
}

interface IRawSubMesh {
	materialIndex: number;
	indexStart: number;
	indexCount: number;
}

export interface IMeshIntegritySnapshot {
	streams: IRawVertexStream[];
	indices: number[];
	subMeshes: IRawSubMesh[];
	selection: any;
	uvLayout: any;
	smoothingGroups: any;
	vertexColors: any;
	useVertexColors: boolean;
	hasVertexAlpha: boolean;
}

interface IIntegrityIssue {
	id: string;
	category: IntegrityCategory;
	severity: IntegritySeverity;
	message: string;
	vertices?: number[];
	faces?: number[];
	edge?: [number, number];
	subMesh?: number;
}

interface IAnalyzedFace {
	id: number;
	indices: [number, number, number];
	positionKeys: [string, string, string];
	duplicateKey: string;
	degenerate: boolean;
	invalid: boolean;
	duplicateOf: number | null;
	materialIndex: number;
}

interface IIntegrityAnalysis {
	fingerprint: string;
	issues: IIntegrityIssue[];
	truncatedIssueCount: number;
	vertexCount: number;
	faceCount: number;
	completeFaceCount: number;
	validFaceCount: number;
	faces: IAnalyzedFace[];
	positionTolerance: number;
	structurallyRepairable: boolean;
	subMeshesValid: boolean;
	connectedComponentCount: number;
	boundaryEdgeCount: number;
	nonManifoldEdgeCount: number;
	inconsistentWindingEdgeCount: number;
	unusedVertexIndices: number[];
	weldableGroups: number[][];
}

function copySerializable(value: any): any {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function captureRawMesh(mesh: Mesh): IMeshIntegritySnapshot {
	const streams = mesh
		.getVerticesDataKinds()
		.filter((kind) => isEditableMeshVertexStream(mesh, kind))
		.map((kind) => {
			const buffer = mesh.getVertexBuffer(kind);
			return {
				kind,
				stride: buffer?.getStrideSize() ?? 0,
				updatable: buffer?.isUpdatable() ?? false,
				values: Array.from(mesh.getVerticesData(kind, false) ?? []),
			};
		})
		.sort((first, second) => first.kind.localeCompare(second.kind));
	return {
		streams,
		indices: Array.from(mesh.getIndices(false) ?? []),
		subMeshes: mesh.subMeshes.map((subMesh) => ({ materialIndex: subMesh.materialIndex, indexStart: subMesh.indexStart, indexCount: subMesh.indexCount })),
		selection: copySerializable(mesh.metadata?.babylonEditorMeshSelection),
		uvLayout: copySerializable(mesh.metadata?.babylonEditorUvLayout),
		smoothingGroups: copySerializable(mesh.metadata?.babylonEditorSmoothingGroups),
		vertexColors: copySerializable(mesh.metadata?.babylonEditorVertexColors),
		useVertexColors: mesh.useVertexColors,
		hasVertexAlpha: mesh.hasVertexAlpha,
	};
}

function getIntegrityFingerprint(snapshot: IMeshIntegritySnapshot): string {
	let first = 2166136261;
	let second = 2246822519;
	const updateByte = (value: number): void => {
		first = Math.imul(first ^ value, 16777619) >>> 0;
		second = Math.imul(second ^ value, 3266489917) >>> 0;
	};
	const updateText = (value: string): void => {
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			updateByte(code & 255);
			updateByte(code >>> 8);
		}
		updateByte(0);
	};
	const bytes = new Uint8Array(8);
	const view = new DataView(bytes.buffer);
	const updateNumber = (value: number): void => {
		view.setFloat64(0, value, true);
		bytes.forEach(updateByte);
	};
	for (const stream of snapshot.streams) {
		updateText(stream.kind);
		updateNumber(stream.stride);
		updateNumber(stream.values.length);
		stream.values.forEach(updateNumber);
	}
	updateNumber(snapshot.indices.length);
	snapshot.indices.forEach(updateNumber);
	for (const subMesh of snapshot.subMeshes) {
		updateNumber(subMesh.materialIndex);
		updateNumber(subMesh.indexStart);
		updateNumber(subMesh.indexCount);
	}
	return `mesh-integrity-fnv32x2-v1:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function validatePositionTolerance(value: any): number {
	const tolerance = value ?? DEFAULT_POSITION_TOLERANCE;
	if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) {
		throw new Error("positionTolerance must be greater than 0 and no more than 1 local unit.");
	}
	return tolerance;
}

function getPositionKey(positions: number[], vertex: number, tolerance: number): string {
	const offset = vertex * 3;
	return `${Math.round(positions[offset] / tolerance)}:${Math.round(positions[offset + 1] / tolerance)}:${Math.round(positions[offset + 2] / tolerance)}`;
}

function getEdgeKey(first: string, second: string): string {
	return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function getSubMeshFaceMaterials(snapshot: IMeshIntegritySnapshot, completeFaceCount: number): { materials: number[]; valid: boolean } {
	if (!snapshot.subMeshes.length) {
		return { materials: new Array(completeFaceCount).fill(0), valid: true };
	}
	const ordered = [...snapshot.subMeshes].sort((first, second) => first.indexStart - second.indexStart);
	const materials = new Array<number>(completeFaceCount).fill(0);
	let cursor = 0;
	let valid = true;
	for (const subMesh of ordered) {
		if (
			!Number.isInteger(subMesh.materialIndex) ||
			subMesh.materialIndex < 0 ||
			!Number.isInteger(subMesh.indexStart) ||
			!Number.isInteger(subMesh.indexCount) ||
			subMesh.indexStart !== cursor ||
			subMesh.indexStart % 3 !== 0 ||
			subMesh.indexCount <= 0 ||
			subMesh.indexCount % 3 !== 0 ||
			subMesh.indexStart + subMesh.indexCount > completeFaceCount * 3
		) {
			valid = false;
			break;
		}
		for (let offset = subMesh.indexStart; offset < subMesh.indexStart + subMesh.indexCount; offset += 3) {
			materials[offset / 3] = subMesh.materialIndex;
		}
		cursor += subMesh.indexCount;
	}
	if (cursor !== completeFaceCount * 3) {
		valid = false;
	}
	return { materials, valid };
}

class DisjointSet {
	private readonly _parents: number[];

	public constructor(size: number) {
		this._parents = Array.from({ length: size }, (_, index) => index);
	}

	public find(value: number): number {
		if (this._parents[value] !== value) {
			this._parents[value] = this.find(this._parents[value]);
		}
		return this._parents[value];
	}

	public union(first: number, second: number): void {
		const firstRoot = this.find(first);
		const secondRoot = this.find(second);
		if (firstRoot !== secondRoot) {
			this._parents[secondRoot] = firstRoot;
		}
	}
}

function analyzeMesh(snapshot: IMeshIntegritySnapshot, positionTolerance: number): IIntegrityAnalysis {
	const issues: IIntegrityIssue[] = [];
	let truncatedIssueCount = 0;
	const addIssue = (issue: IIntegrityIssue): void => {
		if (issues.length < MAXIMUM_ISSUES) {
			issues.push(issue);
		} else {
			truncatedIssueCount++;
		}
	};
	const position = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind);
	const positionComplete = !!position && position.stride === 3 && position.values.length > 0 && position.values.length % 3 === 0;
	const vertexCount = positionComplete ? position!.values.length / 3 : Math.floor((position?.values.length ?? 0) / 3);
	if (!position) {
		addIssue({ id: "positions:missing", category: "positions", severity: "error", message: "The mesh has no position stream." });
	} else if (!positionComplete) {
		addIssue({ id: "positions:incomplete", category: "positions", severity: "error", message: "The position stream must contain complete XYZ vertices at stride 3." });
	} else if (position.values.some((value) => !Number.isFinite(value))) {
		addIssue({ id: "positions:non-finite", category: "positions", severity: "error", message: "The position stream contains non-finite values." });
	}
	if (vertexCount > MAXIMUM_VERTEX_COUNT) {
		addIssue({
			id: "positions:excessive",
			category: "positions",
			severity: "error",
			message: `The mesh exceeds the ${MAXIMUM_VERTEX_COUNT.toLocaleString()}-vertex integrity limit.`,
		});
	}
	const completeFaceCount = Math.floor(snapshot.indices.length / 3);
	if (snapshot.indices.length % 3 !== 0) {
		addIssue({ id: "indices:trailing", category: "indices", severity: "error", message: `${snapshot.indices.length % 3} trailing indices do not form a complete triangle.` });
	}
	if (completeFaceCount > MAXIMUM_FACE_COUNT) {
		addIssue({ id: "indices:excessive", category: "indices", severity: "error", message: `The mesh exceeds the ${MAXIMUM_FACE_COUNT.toLocaleString()}-face integrity limit.` });
	}
	const streamValueCount = snapshot.streams.reduce((total, stream) => total + stream.values.length, 0);
	if (snapshot.streams.length > 32 || streamValueCount > MAXIMUM_STREAM_VALUES) {
		addIssue({ id: "streams:excessive", category: "streams", severity: "error", message: "The mesh exceeds the bounded 32-stream or 20,000,000-value integrity limit." });
	}
	for (const stream of snapshot.streams) {
		if (!Number.isInteger(stream.stride) || stream.stride < 1) {
			addIssue({ id: `streams:${stream.kind}:stride`, category: "streams", severity: "error", message: `Stream "${stream.kind}" has invalid stride ${stream.stride}.` });
		} else if (positionComplete && stream.values.length !== vertexCount * stream.stride) {
			addIssue({
				id: `streams:${stream.kind}:length`,
				category: "streams",
				severity: "error",
				message: `Stream "${stream.kind}" has ${stream.values.length} values; ${vertexCount * stream.stride} are required.`,
			});
		}
		if (stream.values.some((value) => !Number.isFinite(value))) {
			addIssue({ id: `streams:${stream.kind}:non-finite`, category: "streams", severity: "error", message: `Stream "${stream.kind}" contains non-finite values.` });
		}
	}
	const subMeshes = getSubMeshFaceMaterials(snapshot, completeFaceCount);
	if (!subMeshes.valid) {
		addIssue({
			id: "subMeshes:coverage",
			category: "subMeshes",
			severity: "error",
			message: "Submeshes must be contiguous triangle ranges covering the complete index buffer exactly.",
		});
	}
	const referencedVertices = new Set<number>();
	const faces: IAnalyzedFace[] = [];
	const firstByDuplicateKey = new Map<string, number>();
	const edgeOccurrences = new Map<string, Array<{ face: number; from: string; to: string; raw: [number, number] }>>();
	const positions = position?.values ?? [];
	const structuralPositionValid = positionComplete && positions.every(Number.isFinite) && vertexCount <= MAXIMUM_VERTEX_COUNT;
	const areaToleranceSquared = positionTolerance * positionTolerance * positionTolerance * positionTolerance;
	for (let face = 0; face < completeFaceCount; face++) {
		const indices = snapshot.indices.slice(face * 3, face * 3 + 3) as [number, number, number];
		const invalid = !structuralPositionValid || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount);
		if (invalid) {
			addIssue({
				id: `indices:face:${face}`,
				category: "indices",
				severity: "error",
				message: `Face ${face} references an invalid vertex.`,
				faces: [face],
				vertices: [...indices],
			});
			faces.push({
				id: face,
				indices,
				positionKeys: ["", "", ""],
				duplicateKey: "",
				degenerate: false,
				invalid: true,
				duplicateOf: null,
				materialIndex: subMeshes.materials[face] ?? 0,
			});
			continue;
		}
		indices.forEach((index) => referencedVertices.add(index));
		const positionKeys = indices.map((index) => getPositionKey(positions, index, positionTolerance)) as [string, string, string];
		const first = indices[0] * 3;
		const second = indices[1] * 3;
		const third = indices[2] * 3;
		const ab = [positions[second] - positions[first], positions[second + 1] - positions[first + 1], positions[second + 2] - positions[first + 2]];
		const ac = [positions[third] - positions[first], positions[third + 1] - positions[first + 1], positions[third + 2] - positions[first + 2]];
		const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
		const degenerate = new Set(indices).size < 3 || new Set(positionKeys).size < 3 || cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2] <= areaToleranceSquared;
		if (degenerate) {
			addIssue({
				id: `degenerateFaces:${face}`,
				category: "degenerateFaces",
				severity: "error",
				message: `Face ${face} has zero or tolerance-collapsed area.`,
				faces: [face],
				vertices: [...indices],
			});
		}
		const duplicateKey = [...positionKeys].sort().join("|");
		const duplicateOf = firstByDuplicateKey.get(duplicateKey) ?? null;
		if (duplicateOf !== null) {
			addIssue({
				id: `duplicateFaces:${face}`,
				category: "duplicateFaces",
				severity: "error",
				message: `Face ${face} duplicates face ${duplicateOf} in position space.`,
				faces: [duplicateOf, face],
			});
		} else {
			firstByDuplicateKey.set(duplicateKey, face);
		}
		faces.push({ id: face, indices, positionKeys, duplicateKey, degenerate, invalid: false, duplicateOf, materialIndex: subMeshes.materials[face] ?? 0 });
		if (!degenerate) {
			for (let edge = 0; edge < 3; edge++) {
				const from = positionKeys[edge];
				const to = positionKeys[(edge + 1) % 3];
				const key = getEdgeKey(from, to);
				const occurrences = edgeOccurrences.get(key) ?? [];
				occurrences.push({ face, from, to, raw: [indices[edge], indices[(edge + 1) % 3]] });
				edgeOccurrences.set(key, occurrences);
			}
		}
	}
	const unusedVertexIndices = Array.from({ length: vertexCount }, (_, vertex) => vertex).filter((vertex) => !referencedVertices.has(vertex));
	unusedVertexIndices.forEach((vertex) =>
		addIssue({
			id: `unusedVertices:${vertex}`,
			category: "unusedVertices",
			severity: "warning",
			message: `Vertex ${vertex} is not referenced by a complete valid triangle.`,
			vertices: [vertex],
		})
	);
	let boundaryEdgeCount = 0;
	let nonManifoldEdgeCount = 0;
	let inconsistentWindingEdgeCount = 0;
	const faceSet = new DisjointSet(Math.max(1, completeFaceCount));
	for (const [key, occurrences] of edgeOccurrences) {
		if (occurrences.length === 1) {
			boundaryEdgeCount++;
			addIssue({
				id: `boundaryEdges:${key}`,
				category: "boundaryEdges",
				severity: "info",
				message: `Logical edge ${key} is an open boundary.`,
				faces: [occurrences[0].face],
				edge: occurrences[0].raw,
			});
		} else if (occurrences.length > 2) {
			nonManifoldEdgeCount++;
			addIssue({
				id: `nonManifoldEdges:${key}`,
				category: "nonManifoldEdges",
				severity: "error",
				message: `Logical edge ${key} is shared by ${occurrences.length} faces.`,
				faces: occurrences.map((entry) => entry.face),
				edge: occurrences[0].raw,
			});
		} else {
			faceSet.union(occurrences[0].face, occurrences[1].face);
			if (occurrences[0].from === occurrences[1].from && occurrences[0].to === occurrences[1].to) {
				inconsistentWindingEdgeCount++;
				addIssue({
					id: `winding:${key}`,
					category: "winding",
					severity: "warning",
					message: `Faces ${occurrences[0].face} and ${occurrences[1].face} traverse their shared edge in the same direction.`,
					faces: occurrences.map((entry) => entry.face),
					edge: occurrences[0].raw,
				});
			}
		}
	}
	const componentRoots = new Set(faces.filter((face) => !face.invalid && !face.degenerate && face.duplicateOf === null).map((face) => faceSet.find(face.id)));
	const connectedComponentCount = componentRoots.size;
	if (connectedComponentCount > 1) {
		addIssue({
			id: "components:multiple",
			category: "components",
			severity: "info",
			message: `The mesh contains ${connectedComponentCount} disconnected valid face components.`,
		});
	}
	const completeStreams = snapshot.streams.filter((stream) => Number.isInteger(stream.stride) && stream.stride > 0 && stream.values.length === vertexCount * stream.stride);
	const positionGroups = new Map<string, number[]>();
	for (let vertex = 0; vertex < vertexCount; vertex++) {
		const key = structuralPositionValid ? getPositionKey(positions, vertex, positionTolerance) : `${vertex}`;
		const entries = positionGroups.get(key) ?? [];
		entries.push(vertex);
		positionGroups.set(key, entries);
	}
	const weldableGroups: number[][] = [];
	for (const group of positionGroups.values()) {
		if (group.length < 2) {
			continue;
		}
		const bySignature = new Map<string, number[]>();
		for (const vertex of group) {
			const signature = completeStreams
				.filter((stream) => stream.kind !== VertexBuffer.PositionKind)
				.map((stream) => `${stream.kind}:${stream.values.slice(vertex * stream.stride, vertex * stream.stride + stream.stride).join(",")}`)
				.join("|");
			const entries = bySignature.get(signature) ?? [];
			entries.push(vertex);
			bySignature.set(signature, entries);
		}
		for (const entries of bySignature.values()) {
			if (entries.length > 1) {
				weldableGroups.push(entries);
				addIssue({
					id: `weldableVertices:${entries.join(":")}`,
					category: "weldableVertices",
					severity: "info",
					message: `${entries.length} coincident vertices have identical non-position streams and can be welded safely.`,
					vertices: entries,
				});
			}
		}
	}
	const normal = snapshot.streams.find((stream) => stream.kind === VertexBuffer.NormalKind);
	if (!normal) {
		addIssue({ id: "normals:missing", category: "normals", severity: "warning", message: "The mesh has no normal stream." });
	} else if (normal.stride === 3 && normal.values.length === vertexCount * 3) {
		for (let vertex = 0; vertex < vertexCount; vertex++) {
			const length = Math.hypot(normal.values[vertex * 3], normal.values[vertex * 3 + 1], normal.values[vertex * 3 + 2]);
			if (length <= NORMAL_EPSILON || Math.abs(length - 1) > 0.001) {
				addIssue({
					id: `normals:${vertex}`,
					category: "normals",
					severity: "warning",
					message: `Vertex ${vertex} has a zero or non-unit normal of length ${length}.`,
					vertices: [vertex],
				});
			}
		}
	}
	const weightKinds = [VertexBuffer.MatricesWeightsKind, VertexBuffer.MatricesWeightsExtraKind];
	const weightStreams = weightKinds.map((kind) => snapshot.streams.find((stream) => stream.kind === kind)).filter((stream): stream is IRawVertexStream => !!stream);
	if (weightStreams.length) {
		for (let vertex = 0; vertex < vertexCount; vertex++) {
			const weights = weightStreams.flatMap((stream) => stream.values.slice(vertex * stream.stride, vertex * stream.stride + stream.stride));
			const sum = weights.reduce((total, value) => total + value, 0);
			if (weights.some((value) => value < 0) || Math.abs(sum - 1) > 0.001) {
				addIssue({
					id: `skinning:${vertex}`,
					category: "skinning",
					severity: "warning",
					message: `Vertex ${vertex} has negative or non-normalized skin weights with sum ${sum}.`,
					vertices: [vertex],
				});
			}
		}
	}
	const structurallyRepairable =
		positionComplete &&
		positions.every(Number.isFinite) &&
		vertexCount <= MAXIMUM_VERTEX_COUNT &&
		completeFaceCount <= MAXIMUM_FACE_COUNT &&
		snapshot.streams.length <= 32 &&
		streamValueCount <= MAXIMUM_STREAM_VALUES &&
		snapshot.streams.every(
			(stream) => Number.isInteger(stream.stride) && stream.stride > 0 && stream.values.length === vertexCount * stream.stride && stream.values.every(Number.isFinite)
		);
	return {
		fingerprint: getIntegrityFingerprint(snapshot),
		issues,
		truncatedIssueCount,
		vertexCount,
		faceCount: snapshot.indices.length / 3,
		completeFaceCount,
		validFaceCount: faces.filter((face) => !face.invalid && !face.degenerate && face.duplicateOf === null).length,
		faces,
		positionTolerance,
		structurallyRepairable,
		subMeshesValid: subMeshes.valid,
		connectedComponentCount,
		boundaryEdgeCount,
		nonManifoldEdgeCount,
		inconsistentWindingEdgeCount,
		unusedVertexIndices,
		weldableGroups,
	};
}

function summarizeIssues(issues: IIntegrityIssue[]): Array<{ category: IntegrityCategory; errors: number; warnings: number; info: number; total: number }> {
	const summaries = new Map<IntegrityCategory, { errors: number; warnings: number; info: number; total: number }>();
	for (const issue of issues) {
		const summary = summaries.get(issue.category) ?? { errors: 0, warnings: 0, info: 0, total: 0 };
		summary.total++;
		if (issue.severity === "error") {
			summary.errors++;
		} else if (issue.severity === "warning") {
			summary.warnings++;
		} else {
			summary.info++;
		}
		summaries.set(issue.category, summary);
	}
	return [...summaries.entries()].map(([category, summary]) => ({ category, ...summary })).sort((first, second) => first.category.localeCompare(second.category));
}

function inspectAnalysis(mesh: Mesh, analysis: IIntegrityAnalysis, data: any): any {
	let issues = analysis.issues;
	if (data.categories !== undefined) {
		if (!Array.isArray(data.categories) || !data.categories.length || new Set(data.categories).size !== data.categories.length) {
			throw new Error("categories must contain unique integrity categories.");
		}
		const categories = new Set<IntegrityCategory>(data.categories);
		issues = issues.filter((issue) => categories.has(issue.category));
	}
	if (data.severity !== undefined) {
		if (!(["error", "warning", "info"] as IntegritySeverity[]).includes(data.severity)) {
			throw new Error('severity must be "error", "warning", or "info".');
		}
		issues = issues.filter((issue) => issue.severity === data.severity);
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 128;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("offset must be non-negative and limit must be an integer from 1 to 256.");
	}
	const page = issues.slice(offset, offset + limit);
	const errors = analysis.issues.filter((issue) => issue.severity === "error").length;
	const warnings = analysis.issues.filter((issue) => issue.severity === "warning").length;
	const info = analysis.issues.filter((issue) => issue.severity === "info").length;
	return {
		node: toNodeSummary(mesh),
		model: INTEGRITY_MODEL,
		integrityFingerprint: analysis.fingerprint,
		positionTolerance: analysis.positionTolerance,
		structurallyRepairable: analysis.structurallyRepairable,
		valid: errors === 0,
		counts: {
			vertices: analysis.vertexCount,
			faces: analysis.faceCount,
			completeFaces: analysis.completeFaceCount,
			validFaces: analysis.validFaceCount,
			connectedComponents: analysis.connectedComponentCount,
			boundaryEdges: analysis.boundaryEdgeCount,
			nonManifoldEdges: analysis.nonManifoldEdgeCount,
			inconsistentWindingEdges: analysis.inconsistentWindingEdgeCount,
			unusedVertices: analysis.unusedVertexIndices.length,
			weldableVertexGroups: analysis.weldableGroups.length,
		},
		issueCounts: { errors, warnings, info, total: analysis.issues.length, truncated: analysis.truncatedIssueCount },
		categories: summarizeIssues(analysis.issues),
		offset,
		limit,
		total: issues.length,
		returned: page.length,
		hasMore: offset + page.length < issues.length,
		issues: page,
		limitations: [
			"Open boundary edges and disconnected components are diagnostics, not automatically errors.",
			"Ambiguous holes and non-manifold edge ownership are reported but never guessed by automatic repair.",
		],
	};
}

/** Captures even diagnostically invalid editable buffers for exact Inspector repair Undo/Redo. */
export function captureMeshIntegritySnapshot(scene: Scene, data: any): IMeshIntegritySnapshot {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	return captureRawMesh(node);
}

/** Restores a raw integrity snapshot, including damaged index/submesh state, without normalizing it. */
export function restoreMeshIntegritySnapshot(scene: Scene, data: any, snapshot: IMeshIntegritySnapshot, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const kinds = new Set(snapshot.streams.map((stream) => stream.kind));
	for (const kind of node.getVerticesDataKinds()) {
		if (isEditableMeshVertexStream(node, kind) && !kinds.has(kind)) {
			node.removeVerticesData(kind);
		}
	}
	for (const stream of snapshot.streams) {
		node.setVerticesData(stream.kind, stream.values, stream.updatable, stream.stride);
	}
	node.setIndices(snapshot.indices, null, true);
	node.releaseSubMeshes(true);
	const position = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind);
	const vertexCount = position && position.stride > 0 ? Math.floor(position.values.length / position.stride) : 0;
	for (const subMesh of snapshot.subMeshes) {
		new SubMesh(subMesh.materialIndex, 0, vertexCount, subMesh.indexStart, subMesh.indexCount, node, node, false, true);
	}
	node.metadata ??= {};
	for (const [key, value] of [
		["babylonEditorMeshSelection", snapshot.selection],
		["babylonEditorUvLayout", snapshot.uvLayout],
		["babylonEditorSmoothingGroups", snapshot.smoothingGroups],
		["babylonEditorVertexColors", snapshot.vertexColors],
	] as Array<[string, any]>) {
		if (value === undefined) {
			delete node.metadata[key];
		} else {
			node.metadata[key] = copySerializable(value);
		}
	}
	node.useVertexColors = snapshot.useVertexColors;
	node.hasVertexAlpha = snapshot.hasVertexAlpha;
	node.refreshBoundingInfo({ updatePositionsArray: true });
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { node: toNodeSummary(node), integrityFingerprint: getIntegrityFingerprint(snapshot) };
}

/** Inspects bounded triangle topology, streams, submeshes, normals, and skin weights without mutation. */
export function inspectMeshIntegrity(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const tolerance = validatePositionTolerance(data.positionTolerance);
	return inspectAnalysis(node, analyzeMesh(captureRawMesh(node), tolerance), data);
}

function buildSubMeshes(faces: Array<{ materialIndex: number }>, mesh: Mesh): ILoopCutMeshSnapshot["subMeshes"] {
	const result: ILoopCutMeshSnapshot["subMeshes"] = [];
	let startFace = 0;
	while (startFace < faces.length) {
		const materialIndex = faces[startFace].materialIndex;
		let endFace = startFace + 1;
		while (endFace < faces.length && faces[endFace].materialIndex === materialIndex) {
			endFace++;
		}
		result.push({ materialIndex, indexStart: startFace * 3, indexCount: (endFace - startFace) * 3 });
		startFace = endFace;
	}
	if (!result.length) {
		throw new Error(`Repair would leave mesh "${mesh.name}" without any triangle faces.`);
	}
	return result;
}

function fixFaceWinding(faces: Array<{ indices: [number, number, number] }>, positions: number[], tolerance: number): number {
	const occurrences = new Map<string, Array<{ face: number; direction: number }>>();
	faces.forEach((face, faceIndex) => {
		const keys = face.indices.map((vertex) => getPositionKey(positions, vertex, tolerance));
		for (let edge = 0; edge < 3; edge++) {
			const from = keys[edge];
			const to = keys[(edge + 1) % 3];
			const key = getEdgeKey(from, to);
			const entries = occurrences.get(key) ?? [];
			entries.push({ face: faceIndex, direction: from < to ? 1 : -1 });
			occurrences.set(key, entries);
		}
	});
	const adjacency = new Map<number, Array<{ face: number; sameDirection: boolean }>>();
	for (const entries of occurrences.values()) {
		if (entries.length !== 2) {
			continue;
		}
		const first = adjacency.get(entries[0].face) ?? [];
		first.push({ face: entries[1].face, sameDirection: entries[0].direction === entries[1].direction });
		adjacency.set(entries[0].face, first);
		const second = adjacency.get(entries[1].face) ?? [];
		second.push({ face: entries[0].face, sameDirection: entries[0].direction === entries[1].direction });
		adjacency.set(entries[1].face, second);
	}
	const flips = new Map<number, boolean>();
	for (let seed = 0; seed < faces.length; seed++) {
		if (flips.has(seed)) {
			continue;
		}
		flips.set(seed, false);
		const queue = [seed];
		while (queue.length) {
			const face = queue.shift()!;
			for (const neighbor of adjacency.get(face) ?? []) {
				const required = flips.get(face)! !== neighbor.sameDirection;
				const existing = flips.get(neighbor.face);
				if (existing !== undefined && existing !== required) {
					throw new Error("Mesh winding constraints are contradictory; automatic repair cannot orient a non-orientable or overlapping component safely.");
				}
				if (existing === undefined) {
					flips.set(neighbor.face, required);
					queue.push(neighbor.face);
				}
			}
		}
	}
	let changed = 0;
	flips.forEach((flip, face) => {
		if (flip) {
			[faces[face].indices[1], faces[face].indices[2]] = [faces[face].indices[2], faces[face].indices[1]];
			changed++;
		}
	});
	return changed;
}

/** Applies an explicit bounded repair set atomically under the exact inspected integrity fingerprint. */
export function repairMeshIntegrity(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (data.confirm !== true) {
		throw new Error("Mesh repair requires confirm=true.");
	}
	const allowedOperations: RepairOperation[] = [
		"removeInvalidFaces",
		"removeDegenerateFaces",
		"removeDuplicateFaces",
		"removeUnusedVertices",
		"weldIdenticalVertices",
		"fixWinding",
		"rebuildNormals",
		"normalizeSkinWeights",
		"rebuildSubMeshes",
	];
	if (
		!Array.isArray(data.operations) ||
		!data.operations.length ||
		data.operations.length > allowedOperations.length ||
		new Set(data.operations).size !== data.operations.length
	) {
		throw new Error("operations must contain one or more unique mesh repair operations.");
	}
	if (data.operations.some((operation: unknown) => !allowedOperations.includes(operation as RepairOperation))) {
		throw new Error(`Unknown mesh repair operation; supported operations are ${allowedOperations.join(", ")}.`);
	}
	const operations = new Set<RepairOperation>(data.operations);
	const tolerance = validatePositionTolerance(data.positionTolerance);
	const raw = captureRawMesh(node);
	const analysis = analyzeMesh(raw, tolerance);
	if (data.expectedIntegrityFingerprint !== analysis.fingerprint) {
		throw new Error("Mesh integrity snapshot is stale; call inspect_mesh_integrity again and use its exact integrityFingerprint.");
	}
	if (!analysis.structurallyRepairable) {
		throw new Error("Mesh streams or positions are structurally incomplete/non-finite; repair cannot preserve every vertex stream atomically.");
	}
	if (node.morphTargetManager?.numTargets) {
		throw new Error("Mesh integrity repair is unavailable while morph targets are attached; bake or detach morph targets first.");
	}
	if (raw.indices.length % 3 !== 0 && !operations.has("removeInvalidFaces")) {
		throw new Error("Trailing incomplete indices require removeInvalidFaces.");
	}
	if (analysis.faces.some((face) => face.invalid) && !operations.has("removeInvalidFaces")) {
		throw new Error("Invalid triangle references require removeInvalidFaces.");
	}
	if (!analysis.subMeshesValid && !operations.has("rebuildSubMeshes")) {
		throw new Error("Invalid submesh ranges require rebuildSubMeshes.");
	}
	let retainedFaces = [...analysis.faces];
	const removedInvalidFaces = operations.has("removeInvalidFaces") ? retainedFaces.filter((face) => face.invalid).length : 0;
	if (operations.has("removeInvalidFaces")) {
		retainedFaces = retainedFaces.filter((face) => !face.invalid);
	}
	let removedDegenerateFaces = operations.has("removeDegenerateFaces") ? retainedFaces.filter((face) => face.degenerate).length : 0;
	if (operations.has("removeDegenerateFaces")) {
		retainedFaces = retainedFaces.filter((face) => !face.degenerate);
	}
	const removedDuplicateFaces = operations.has("removeDuplicateFaces") ? retainedFaces.filter((face) => face.duplicateOf !== null).length : 0;
	if (operations.has("removeDuplicateFaces")) {
		retainedFaces = retainedFaces.filter((face) => face.duplicateOf === null);
	}
	let faces = retainedFaces.map((face) => ({
		id: face.id,
		indices: [...face.indices] as [number, number, number],
		materialIndex: analysis.subMeshesValid ? face.materialIndex : 0,
	}));
	if (faces.some((face) => face.indices.some((index) => index < 0 || index >= analysis.vertexCount))) {
		throw new Error("Repair operations leave invalid face references; include removeInvalidFaces.");
	}
	if (faces.some((face) => new Set(face.indices).size < 3) && !operations.has("removeDegenerateFaces")) {
		throw new Error("Repair operations leave degenerate faces; include removeDegenerateFaces.");
	}
	if (!faces.length) {
		throw new Error("Repair would remove every triangle face; no mutation was committed.");
	}
	const positionStream = raw.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!;
	let flippedFaceCount = 0;
	if (operations.has("fixWinding")) {
		flippedFaceCount = fixFaceWinding(faces, positionStream.values, tolerance);
	}
	const representative = Array.from({ length: analysis.vertexCount }, (_, vertex) => vertex);
	let weldedVertexCount = 0;
	if (operations.has("weldIdenticalVertices")) {
		for (const group of analysis.weldableGroups) {
			const target = group[0];
			for (const vertex of group.slice(1)) {
				representative[vertex] = target;
				weldedVertexCount++;
			}
		}
		faces.forEach((face) => (face.indices = face.indices.map((vertex) => representative[vertex]) as [number, number, number]));
		if (faces.some((face) => new Set(face.indices).size < 3)) {
			if (!operations.has("removeDegenerateFaces")) {
				throw new Error("Welding creates degenerate faces; include removeDegenerateFaces for atomic cleanup.");
			}
			const faceCountBeforeWeldCleanup = faces.length;
			faces = faces.filter((face) => new Set(face.indices).size === 3);
			removedDegenerateFaces += faceCountBeforeWeldCleanup - faces.length;
		}
	}
	const referenced = new Set(faces.flatMap((face) => face.indices));
	const compact = operations.has("removeUnusedVertices") || operations.has("weldIdenticalVertices");
	const retainedVertices = compact ? [...referenced].sort((first, second) => first - second) : Array.from({ length: analysis.vertexCount }, (_, vertex) => vertex);
	const compactIndex = new Map(retainedVertices.map((vertex, index) => [vertex, index]));
	if (compact) {
		faces.forEach((face) => (face.indices = face.indices.map((vertex) => compactIndex.get(vertex)!) as [number, number, number]));
	}
	const streams = raw.streams.map((stream) => ({
		...stream,
		values: compact ? retainedVertices.flatMap((vertex) => stream.values.slice(vertex * stream.stride, vertex * stream.stride + stream.stride)) : [...stream.values],
	}));
	const outputVertexCount = retainedVertices.length;
	if (operations.has("normalizeSkinWeights")) {
		const weightStreams = [VertexBuffer.MatricesWeightsKind, VertexBuffer.MatricesWeightsExtraKind]
			.map((kind) => streams.find((stream) => stream.kind === kind))
			.filter((stream): stream is IRawVertexStream => !!stream);
		for (let vertex = 0; vertex < outputVertexCount; vertex++) {
			const entries = weightStreams.flatMap((stream) => Array.from({ length: stream.stride }, (_, component) => ({ stream, offset: vertex * stream.stride + component })));
			if (!entries.length) {
				continue;
			}
			const sum = entries.reduce((total, entry) => total + Math.max(0, entry.stream.values[entry.offset]), 0);
			entries.forEach(
				(entry, index) => (entry.stream.values[entry.offset] = sum > NORMAL_EPSILON ? Math.max(0, entry.stream.values[entry.offset]) / sum : index === 0 ? 1 : 0)
			);
		}
	}
	const indices = faces.flatMap((face) => face.indices);
	if (operations.has("rebuildNormals")) {
		const positions = streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values;
		const normals: number[] = [];
		VertexData.ComputeNormals(positions, indices, normals);
		const existing = streams.find((stream) => stream.kind === VertexBuffer.NormalKind);
		if (existing) {
			existing.stride = 3;
			existing.values = normals;
		} else {
			streams.push({ kind: VertexBuffer.NormalKind, stride: 3, updatable: true, values: normals });
			streams.sort((first, second) => first.kind.localeCompare(second.kind));
		}
	}
	const positions = streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values;
	const topologyFingerprintBefore = getMeshTopologyFingerprint(positionStream.values, raw.indices);
	const topologyFingerprintAfter = getMeshTopologyFingerprint(positions, indices);
	const topologyChanged = topologyFingerprintBefore !== topologyFingerprintAfter;
	const smoothingGroups =
		raw.smoothingGroups?.model === "coincident-face-smoothing-groups-v1" &&
		Array.isArray(raw.smoothingGroups.faceGroups) &&
		raw.smoothingGroups.faceGroups.length === analysis.completeFaceCount
			? {
					...copySerializable(raw.smoothingGroups),
					faceGroups: faces.map((face) => raw.smoothingGroups.faceGroups[face.id]),
					topologyFingerprint: topologyFingerprintAfter,
				}
			: undefined;
	const output: ILoopCutMeshSnapshot = {
		streams,
		indices,
		subMeshes: topologyChanged || operations.has("rebuildSubMeshes") ? buildSubMeshes(faces, node) : raw.subMeshes.map((subMesh) => ({ ...subMesh })),
		selection: topologyChanged ? undefined : copySerializable(raw.selection),
		uvLayout: topologyChanged ? undefined : copySerializable(raw.uvLayout),
		smoothingGroups,
		vertexColors: topologyChanged ? undefined : copySerializable(raw.vertexColors),
		useVertexColors: raw.useVertexColors,
		hasVertexAlpha: raw.hasVertexAlpha,
	};
	applyLoopCutMeshSnapshot(node, output);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	const after = inspectMeshIntegrity(scene, { nodeId: node.id, positionTolerance: tolerance, offset: 0, limit: 256 });
	return {
		...after,
		operations: [...operations],
		integrityFingerprintBefore: analysis.fingerprint,
		integrityFingerprintAfter: after.integrityFingerprint,
		topologyFingerprintBefore,
		topologyFingerprintAfter,
		countsBefore: { vertices: analysis.vertexCount, faces: analysis.completeFaceCount },
		countsAfter: { vertices: outputVertexCount, faces: faces.length },
		removedInvalidFaces,
		removedDegenerateFaces,
		removedDuplicateFaces,
		removedUnusedVertices: analysis.vertexCount - outputVertexCount - weldedVertexCount,
		weldedVertexCount,
		flippedFaceCount,
	};
}

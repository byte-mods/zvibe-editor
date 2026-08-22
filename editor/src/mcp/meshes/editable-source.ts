import { Mesh, Scene, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

export const EDITABLE_MESH_SOURCE_METADATA_KEY = "babylonEditorEditableMeshSource";
export const EDITABLE_MESH_SOURCE_MODEL = "unity-editable-source-generated-export-v1";

const MAX_VERTEX_COUNT = 500_000;
const MAX_INDEX_COUNT = 1_500_000;
const MAX_STREAM_COUNT = 32;

// Babylon exposes thin-instance transform buffers through getVerticesDataKinds(),
// but they are per-instance attributes rather than per-vertex geometry streams.
// Capturing them as editable geometry fails because getVerticesData() correctly
// has no vertex-record payload for world0..world3.
const INSTANCE_TRANSFORM_STREAM_KINDS = new Set(["world0", "world1", "world2", "world3"]);

/** True only for vertex-owned geometry streams; GPU instance attributes must remain outside editable topology. */
export function isEditableMeshVertexStream(mesh: Mesh, kind: string): boolean {
	return !INSTANCE_TRANSFORM_STREAM_KINDS.has(kind) && mesh.getVertexBuffer(kind)?.getIsInstanced() !== true;
}

const EDITOR_ONLY_MESH_METADATA_KEYS = [
	EDITABLE_MESH_SOURCE_METADATA_KEY,
	"babylonEditorMeshSelection",
	"babylonEditorUvLayout",
	"babylonEditorSmoothingGroups",
	"babylonEditorVertexColors",
];

const SERIALIZED_STREAM_FIELDS = new Map<string, string>([
	[VertexBuffer.PositionKind, "positions"],
	[VertexBuffer.NormalKind, "normals"],
	[VertexBuffer.UVKind, "uvs"],
	[VertexBuffer.UV2Kind, "uv2s"],
	[VertexBuffer.TangentKind, "tangents"],
	[VertexBuffer.ColorKind, "colors"],
	[VertexBuffer.MatricesIndicesKind, "matricesIndices"],
	[VertexBuffer.MatricesWeightsKind, "matricesWeights"],
	[VertexBuffer.MatricesIndicesExtraKind, "matricesIndicesExtra"],
	[VertexBuffer.MatricesWeightsExtraKind, "matricesWeightsExtra"],
]);

export interface IEditableMeshVertexStream {
	kind: string;
	stride: number;
	updatable: boolean;
	values: number[];
}

export interface IEditableMeshSubMesh {
	materialIndex: number;
	verticesStart: number;
	verticesCount: number;
	indexStart: number;
	indexCount: number;
}

export interface IEditableMeshSnapshot {
	streams: IEditableMeshVertexStream[];
	indices: number[];
	subMeshes: IEditableMeshSubMesh[];
}

export interface IEditableMeshExportSettings {
	optimize: boolean;
}

export interface IEditableMeshSourceManifest {
	version: 1;
	model: typeof EDITABLE_MESH_SOURCE_MODEL;
	revision: number;
	sourceFingerprint: string;
	exportSettingsRevision: number;
	exportSettings: IEditableMeshExportSettings;
	lastGenerated?: any;
}

export interface IGeneratedEditableMeshGeometry {
	snapshot: IEditableMeshSnapshot;
	geometry: Record<string, number[]>;
	evidence: any;
}

export interface IEditableMeshSourceSnapshot {
	metadata?: any;
}

function copySerializable<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function validatePositiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || Number(value) < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return Number(value);
}

function captureSubMeshes(mesh: Mesh, vertexCount: number, indexCount: number): IEditableMeshSubMesh[] {
	const source = mesh.subMeshes.length
		? mesh.subMeshes.map((subMesh) => ({
				materialIndex: subMesh.materialIndex,
				verticesStart: subMesh.verticesStart,
				verticesCount: subMesh.verticesCount,
				indexStart: subMesh.indexStart,
				indexCount: subMesh.indexCount,
			}))
		: [{ materialIndex: 0, verticesStart: 0, verticesCount: vertexCount, indexStart: 0, indexCount }];
	const ordered = [...source].sort((first, second) => first.indexStart - second.indexStart);
	let cursor = 0;
	for (const [index, subMesh] of ordered.entries()) {
		validatePositiveInteger(subMesh.materialIndex, `Submesh ${index} materialIndex`);
		validatePositiveInteger(subMesh.verticesStart, `Submesh ${index} verticesStart`);
		validatePositiveInteger(subMesh.verticesCount, `Submesh ${index} verticesCount`);
		validatePositiveInteger(subMesh.indexStart, `Submesh ${index} indexStart`);
		validatePositiveInteger(subMesh.indexCount, `Submesh ${index} indexCount`);
		if (subMesh.indexStart !== cursor || subMesh.indexCount <= 0 || subMesh.indexStart % 3 !== 0 || subMesh.indexCount % 3 !== 0) {
			throw new Error("Editable source requires non-overlapping triangle submeshes that cover the index buffer contiguously.");
		}
		if (subMesh.verticesStart + subMesh.verticesCount > vertexCount) {
			throw new Error(`Submesh ${index} vertex range exceeds the editable source vertex count.`);
		}
		cursor += subMesh.indexCount;
	}
	if (cursor !== indexCount) {
		throw new Error("Editable source submeshes must cover the complete index buffer.");
	}
	return ordered;
}

/** Captures the complete bounded raw Mesh state that remains canonical for editor authoring. */
export function captureEditableMeshSnapshot(mesh: Mesh): IEditableMeshSnapshot {
	const positionValues = mesh.getVerticesData(VertexBuffer.PositionKind, false);
	if (!positionValues || !positionValues.length || positionValues.length % 3 !== 0) {
		throw new Error(`Mesh "${mesh.name}" has no complete editable three-component position stream.`);
	}
	const vertexCount = positionValues.length / 3;
	if (vertexCount > MAX_VERTEX_COUNT) {
		throw new Error(`Editable source has ${vertexCount} vertices; the bounded limit is ${MAX_VERTEX_COUNT}. Split the mesh before generating export geometry.`);
	}
	const kinds = mesh.getVerticesDataKinds().filter((kind) => isEditableMeshVertexStream(mesh, kind));
	if (kinds.length > MAX_STREAM_COUNT) {
		throw new Error(`Editable source has ${kinds.length} vertex streams; the bounded limit is ${MAX_STREAM_COUNT}.`);
	}
	const streams = kinds
		.map((kind) => {
			const buffer = mesh.getVertexBuffer(kind);
			const values = Array.from(mesh.getVerticesData(kind, false) ?? []);
			const stride = buffer?.getStrideSize() ?? 0;
			if (!buffer || !Number.isInteger(stride) || stride < 1 || values.length !== vertexCount * stride) {
				throw new Error(`Editable source stream "${kind}" is incomplete: expected ${vertexCount} records at stride ${stride}, found ${values.length} values.`);
			}
			if (values.some((value) => !Number.isFinite(value))) {
				throw new Error(`Editable source stream "${kind}" contains a non-finite value. Repair the mesh before export generation.`);
			}
			return { kind, stride, updatable: buffer.isUpdatable(), values };
		})
		.sort((first, second) => first.kind.localeCompare(second.kind));
	const position = streams.find((stream) => stream.kind === VertexBuffer.PositionKind);
	if (!position || position.stride !== 3) {
		throw new Error("Editable source requires a three-component position stream.");
	}
	const indices = Array.from(mesh.getIndices(false) ?? []);
	if (!indices.length || indices.length % 3 !== 0 || indices.length > MAX_INDEX_COUNT) {
		throw new Error(`Editable source requires 3-${MAX_INDEX_COUNT} complete triangle indices.`);
	}
	for (const [offset, index] of indices.entries()) {
		if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
			throw new Error(`Editable source index ${offset} references invalid vertex ${index}; repair the mesh before generating export geometry.`);
		}
	}
	return { streams, indices, subMeshes: captureSubMeshes(mesh, vertexCount, indices.length) };
}

function updateFingerprintText(state: { first: number; second: number }, value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		state.first = Math.imul(state.first ^ (code & 255), 16777619) >>> 0;
		state.second = Math.imul(state.second ^ (code & 255), 3266489917) >>> 0;
		state.first = Math.imul(state.first ^ (code >>> 8), 16777619) >>> 0;
		state.second = Math.imul(state.second ^ (code >>> 8), 3266489917) >>> 0;
	}
	state.first = Math.imul(state.first, 16777619) >>> 0;
	state.second = Math.imul(state.second, 3266489917) >>> 0;
}

function updateFingerprintNumber(state: { first: number; second: number }, value: number): void {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value, true);
	for (const byte of bytes) {
		state.first = Math.imul(state.first ^ byte, 16777619) >>> 0;
		state.second = Math.imul(state.second ^ byte, 3266489917) >>> 0;
	}
}

/** Returns an exact all-stream/index/submesh identity for a canonical or generated snapshot. */
export function getEditableMeshSnapshotFingerprint(snapshot: IEditableMeshSnapshot): string {
	const state = { first: 2166136261, second: 2246822519 };
	for (const stream of snapshot.streams) {
		updateFingerprintText(state, stream.kind);
		updateFingerprintNumber(state, stream.stride);
		updateFingerprintNumber(state, stream.values.length);
		stream.values.forEach((value) => updateFingerprintNumber(state, value));
	}
	updateFingerprintNumber(state, snapshot.indices.length);
	snapshot.indices.forEach((value) => updateFingerprintNumber(state, value));
	for (const subMesh of snapshot.subMeshes) {
		updateFingerprintNumber(state, subMesh.materialIndex);
		updateFingerprintNumber(state, subMesh.verticesStart);
		updateFingerprintNumber(state, subMesh.verticesCount);
		updateFingerprintNumber(state, subMesh.indexStart);
		updateFingerprintNumber(state, subMesh.indexCount);
	}
	return `mesh-editable-source-fnv32x2-v1:${state.first.toString(16).padStart(8, "0")}${state.second.toString(16).padStart(8, "0")}`;
}

function getStoredManifest(mesh: Mesh): IEditableMeshSourceManifest | undefined {
	const candidate = mesh.metadata?.[EDITABLE_MESH_SOURCE_METADATA_KEY];
	if (
		candidate?.version !== 1 ||
		candidate.model !== EDITABLE_MESH_SOURCE_MODEL ||
		!Number.isInteger(candidate.revision) ||
		candidate.revision < 1 ||
		typeof candidate.sourceFingerprint !== "string" ||
		!Number.isInteger(candidate.exportSettingsRevision) ||
		candidate.exportSettingsRevision < 1 ||
		typeof candidate.exportSettings?.optimize !== "boolean"
	) {
		return undefined;
	}
	return candidate;
}

function computeManifest(mesh: Mesh, sourceFingerprint: string): IEditableMeshSourceManifest {
	const stored = getStoredManifest(mesh);
	const sourceChanged = stored?.sourceFingerprint !== sourceFingerprint;
	const revision = stored ? stored.revision + (sourceChanged ? 1 : 0) : 1;
	const exportSettings = stored?.exportSettings ?? { optimize: true };
	const exportSettingsRevision = stored?.exportSettingsRevision ?? 1;
	const lastGenerated =
		!sourceChanged &&
		stored?.lastGenerated?.sourceFingerprint === sourceFingerprint &&
		stored.lastGenerated?.exportSettingsRevision === exportSettingsRevision &&
		stored.lastGenerated?.settings?.optimize === exportSettings.optimize
			? copySerializable(stored.lastGenerated)
			: undefined;
	return { version: 1, model: EDITABLE_MESH_SOURCE_MODEL, revision, sourceFingerprint, exportSettingsRevision, exportSettings: { ...exportSettings }, lastGenerated };
}

/** Computes the current manifest and revisions without persisting metadata. */
export function getEditableMeshSourceManifest(mesh: Mesh): IEditableMeshSourceManifest {
	const source = captureEditableMeshSnapshot(mesh);
	return computeManifest(mesh, getEditableMeshSnapshotFingerprint(source));
}

/** Synchronizes the lightweight source manifest before project serialization without duplicating vertex data in JSON. */
export function synchronizeEditableMeshSourceManifest(mesh: Mesh): IEditableMeshSourceManifest {
	const source = captureEditableMeshSnapshot(mesh);
	const manifest = computeManifest(mesh, getEditableMeshSnapshotFingerprint(source));
	mesh.metadata ??= {};
	mesh.metadata[EDITABLE_MESH_SOURCE_METADATA_KEY] = manifest;
	return manifest;
}

function sameVertex(first: number, second: number, streams: IEditableMeshVertexStream[]): boolean {
	for (const stream of streams) {
		for (let component = 0; component < stream.stride; component++) {
			if (!Object.is(stream.values[first * stream.stride + component], stream.values[second * stream.stride + component])) {
				return false;
			}
		}
	}
	return true;
}

function hashVertex(vertex: number, streams: IEditableMeshVertexStream[]): string {
	const state = { first: 2166136261, second: 2246822519 };
	for (const stream of streams) {
		updateFingerprintText(state, stream.kind);
		for (let component = 0; component < stream.stride; component++) {
			updateFingerprintNumber(state, stream.values[vertex * stream.stride + component]);
		}
	}
	return `${state.first.toString(16).padStart(8, "0")}${state.second.toString(16).padStart(8, "0")}`;
}

function optimizeSnapshot(source: IEditableMeshSnapshot): IEditableMeshSnapshot {
	const buckets = new Map<string, number[]>();
	const rawRepresentatives: number[] = [];
	const remap = new Map<number, number>();
	const indices = source.indices.map((rawVertex) => {
		const existing = remap.get(rawVertex);
		if (existing !== undefined) {
			return existing;
		}
		const key = hashVertex(rawVertex, source.streams);
		const candidates = buckets.get(key) ?? [];
		const matching = candidates.find((generatedVertex) => sameVertex(rawVertex, rawRepresentatives[generatedVertex], source.streams));
		if (matching !== undefined) {
			remap.set(rawVertex, matching);
			return matching;
		}
		const generatedVertex = rawRepresentatives.length;
		rawRepresentatives.push(rawVertex);
		candidates.push(generatedVertex);
		buckets.set(key, candidates);
		remap.set(rawVertex, generatedVertex);
		return generatedVertex;
	});
	const streams = source.streams.map((stream) => ({
		...stream,
		values: rawRepresentatives.flatMap((rawVertex) => stream.values.slice(rawVertex * stream.stride, rawVertex * stream.stride + stream.stride)),
	}));
	const subMeshes = source.subMeshes.map((subMesh) => {
		const subMeshIndices = indices.slice(subMesh.indexStart, subMesh.indexStart + subMesh.indexCount);
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		for (const index of subMeshIndices) {
			minimum = Math.min(minimum, index);
			maximum = Math.max(maximum, index);
		}
		return { ...subMesh, verticesStart: minimum, verticesCount: maximum - minimum + 1 };
	});
	return { streams, indices, subMeshes };
}

function cloneSnapshot(source: IEditableMeshSnapshot): IEditableMeshSnapshot {
	return {
		streams: source.streams.map((stream) => ({ ...stream, values: [...stream.values] })),
		indices: [...source.indices],
		subMeshes: source.subMeshes.map((subMesh) => ({ ...subMesh })),
	};
}

function snapshotToSerializedGeometry(snapshot: IEditableMeshSnapshot): Record<string, number[]> {
	const geometry: Record<string, number[]> = {};
	for (const stream of snapshot.streams) {
		const field = SERIALIZED_STREAM_FIELDS.get(stream.kind);
		if (field) {
			geometry[field] = [...stream.values];
		}
	}
	geometry.indices = [...snapshot.indices];
	return geometry;
}

function describeSnapshot(snapshot: IEditableMeshSnapshot): any {
	const position = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!;
	return {
		vertexCount: position.values.length / position.stride,
		indexCount: snapshot.indices.length,
		faceCount: snapshot.indices.length / 3,
		subMeshCount: snapshot.subMeshes.length,
		streams: snapshot.streams.map((stream) => ({ kind: stream.kind, stride: stream.stride, valueCount: stream.values.length })),
	};
}

/** Builds a detached generated snapshot and proves the canonical live source was not mutated. */
export function buildGeneratedEditableMeshGeometry(mesh: Mesh, settings?: IEditableMeshExportSettings): IGeneratedEditableMeshGeometry {
	const source = captureEditableMeshSnapshot(mesh);
	const sourceFingerprint = getEditableMeshSnapshotFingerprint(source);
	const effectiveSettings = settings ?? computeManifest(mesh, sourceFingerprint).exportSettings;
	const morphTargetCount = mesh.morphTargetManager?.numTargets ?? 0;
	const optimizationBlockers = effectiveSettings.optimize && morphTargetCount > 0 ? [`${morphTargetCount} morph targets require source vertex identity`] : [];
	const optimizationApplied = effectiveSettings.optimize && optimizationBlockers.length === 0;
	const generated = optimizationApplied ? optimizeSnapshot(source) : cloneSnapshot(source);
	const generatedFingerprint = getEditableMeshSnapshotFingerprint(generated);
	const afterFingerprint = getEditableMeshSnapshotFingerprint(captureEditableMeshSnapshot(mesh));
	if (afterFingerprint !== sourceFingerprint) {
		throw new Error("Generated geometry compilation changed the canonical editable source; the operation was rejected.");
	}
	const unsupportedStreams = generated.streams.filter((stream) => !SERIALIZED_STREAM_FIELDS.has(stream.kind)).map((stream) => stream.kind);
	const sourceCounts = describeSnapshot(source);
	const generatedCounts = describeSnapshot(generated);
	return {
		snapshot: generated,
		geometry: snapshotToSerializedGeometry(generated),
		evidence: {
			model: EDITABLE_MESH_SOURCE_MODEL,
			compilationModel: optimizationApplied
				? "exact-complete-record-weld-v1"
				: effectiveSettings.optimize
					? "preserve-source-records-morph-target-safe-v1"
					: "preserve-source-records-v1",
			settings: { ...effectiveSettings },
			optimizationApplied,
			optimizationBlockers,
			sourceFingerprint,
			generatedFingerprint,
			source: sourceCounts,
			generated: generatedCounts,
			removedUnusedOrDuplicateVertices: sourceCounts.vertexCount - generatedCounts.vertexCount,
			unsupportedSerializedStreams: unsupportedStreams,
			portableBinaryOutput: unsupportedStreams.length === 0,
			sourcePreserved: true,
		},
	};
}

/** Records one separately written generated artifact in the canonical source manifest. */
export function recordGeneratedEditableMeshArtifact(mesh: Mesh, data: { file: string; binaryInfo: any; evidence: any }): IEditableMeshSourceManifest {
	const manifest = synchronizeEditableMeshSourceManifest(mesh);
	manifest.lastGenerated = {
		file: data.file,
		binaryInfo: copySerializable(data.binaryInfo),
		sourceFingerprint: data.evidence.sourceFingerprint,
		generatedFingerprint: data.evidence.generatedFingerprint,
		exportSettingsRevision: manifest.exportSettingsRevision,
		settings: { ...manifest.exportSettings },
		source: copySerializable(data.evidence.source),
		generated: copySerializable(data.evidence.generated),
		removedUnusedOrDuplicateVertices: data.evidence.removedUnusedOrDuplicateVertices,
		compilationModel: data.evidence.compilationModel,
		optimizationApplied: data.evidence.optimizationApplied,
		optimizationBlockers: copySerializable(data.evidence.optimizationBlockers),
	};
	mesh.metadata[EDITABLE_MESH_SOURCE_METADATA_KEY] = manifest;
	return manifest;
}

/** Replaces editor-only authoring metadata with bounded generated-runtime evidence on serialized output only. */
export function stripEditableSourceMetadataForRuntime(serializedMesh: any, evidence: any, sourceRevision: number, exportSettingsRevision: number): void {
	serializedMesh.metadata ??= {};
	EDITOR_ONLY_MESH_METADATA_KEYS.forEach((key) => delete serializedMesh.metadata[key]);
	serializedMesh.metadata.babylonEditorGeneratedGeometry = {
		version: 1,
		model: EDITABLE_MESH_SOURCE_MODEL,
		compilationModel: evidence.compilationModel,
		sourceRevision,
		exportSettingsRevision,
		sourceFingerprint: evidence.sourceFingerprint,
		generatedFingerprint: evidence.generatedFingerprint,
		settings: copySerializable(evidence.settings),
		source: copySerializable(evidence.source),
		generated: copySerializable(evidence.generated),
		removedUnusedOrDuplicateVertices: evidence.removedUnusedOrDuplicateVertices,
		optimizationApplied: evidence.optimizationApplied,
		optimizationBlockers: copySerializable(evidence.optimizationBlockers),
	};
}

/** Applies generated arrays/submesh ranges to Babylon serializer data without touching the live Mesh. */
export function applyGeneratedEditableMeshToSerializedData(serializedMesh: any, serializedGeometry: any, generated: IGeneratedEditableMeshGeometry): void {
	for (const field of SERIALIZED_STREAM_FIELDS.values()) {
		delete serializedGeometry[field];
	}
	delete serializedGeometry.indices;
	Object.assign(serializedGeometry, copySerializable(generated.geometry));
	serializedMesh.subMeshes = generated.snapshot.subMeshes.map((subMesh) => ({ ...subMesh }));
}

function getEditableMeshSourceState(mesh: Mesh): any {
	const source = captureEditableMeshSnapshot(mesh);
	const sourceFingerprint = getEditableMeshSnapshotFingerprint(source);
	const manifest = computeManifest(mesh, sourceFingerprint);
	const generated = buildGeneratedEditableMeshGeometry(mesh, manifest.exportSettings);
	return {
		model: EDITABLE_MESH_SOURCE_MODEL,
		node: toNodeSummary(mesh),
		ownership: {
			canonical: "live-and-project-source-geometry",
			generated: "detached-derived-runtime-artifact",
			projectSourceDirectory: "geometries",
			projectGeneratedDirectory: "generatedGeometries",
			runtimeContainsEditorTopologyMetadata: false,
		},
		source: { revision: manifest.revision, fingerprint: sourceFingerprint, ...generated.evidence.source },
		exportSettings: { revision: manifest.exportSettingsRevision, ...manifest.exportSettings },
		generated: {
			fingerprint: generated.evidence.generatedFingerprint,
			compilationModel: generated.evidence.compilationModel,
			...generated.evidence.generated,
			removedUnusedOrDuplicateVertices: generated.evidence.removedUnusedOrDuplicateVertices,
			optimizationApplied: generated.evidence.optimizationApplied,
			optimizationBlockers: generated.evidence.optimizationBlockers,
			portableBinaryOutput: generated.evidence.portableBinaryOutput,
			unsupportedSerializedStreams: generated.evidence.unsupportedSerializedStreams,
			sourcePreserved: generated.evidence.sourcePreserved,
		},
		lastPersistedGeneratedArtifact: manifest.lastGenerated ?? null,
		limits: { maxVertices: MAX_VERTEX_COUNT, maxIndices: MAX_INDEX_COUNT, maxStreams: MAX_STREAM_COUNT },
	};
}

/** Inspects the canonical source, exact leases, current generated preview, and persisted artifact evidence. */
export function getMeshEditableSource(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	return getEditableMeshSourceState(node);
}

/** Captures only the versioned source/export manifest for exact Inspector Undo/Redo. */
export function captureMeshEditableSourceSnapshot(scene: Scene, data: any): IEditableMeshSourceSnapshot {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	return { metadata: copySerializable(node.metadata?.[EDITABLE_MESH_SOURCE_METADATA_KEY]) };
}

/** Restores source/export settings without replacing or regenerating canonical vertex data. */
export function restoreMeshEditableSourceSnapshot(scene: Scene, data: any, snapshot: IEditableMeshSourceSnapshot, options?: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	node.metadata ??= {};
	if (snapshot.metadata === undefined) {
		delete node.metadata[EDITABLE_MESH_SOURCE_METADATA_KEY];
	} else {
		node.metadata[EDITABLE_MESH_SOURCE_METADATA_KEY] = copySerializable(snapshot.metadata);
	}
	options?.editor.layout.inspector.setEditedObject(node);
	options?.editor.layout.inspector.forceUpdate();
	return getEditableMeshSourceState(node);
}

/** Updates generated-geometry policy under exact source and settings leases; canonical geometry is unchanged. */
export function setMeshExportGeometry(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const source = captureEditableMeshSnapshot(node);
	const sourceFingerprint = getEditableMeshSnapshotFingerprint(source);
	const manifest = computeManifest(node, sourceFingerprint);
	if (data.expectedSourceFingerprint !== sourceFingerprint || data.expectedSourceRevision !== manifest.revision) {
		throw new Error(
			`Editable source is stale: expected revision ${data.expectedSourceRevision} and fingerprint "${data.expectedSourceFingerprint}", current revision is ${manifest.revision} and fingerprint is "${sourceFingerprint}". Call get_mesh_editable_source again.`
		);
	}
	if (data.expectedExportSettingsRevision !== manifest.exportSettingsRevision) {
		throw new Error(
			`Export settings are stale: expected revision ${data.expectedExportSettingsRevision}, current revision is ${manifest.exportSettingsRevision}. Call get_mesh_editable_source again.`
		);
	}
	if (typeof data.optimize !== "boolean") {
		throw new Error("optimize must be a boolean.");
	}
	const beforeFingerprint = sourceFingerprint;
	const changed = manifest.exportSettings.optimize !== data.optimize;
	manifest.exportSettings = { optimize: data.optimize };
	manifest.exportSettingsRevision += changed ? 1 : 0;
	delete manifest.lastGenerated;
	node.metadata ??= {};
	node.metadata[EDITABLE_MESH_SOURCE_METADATA_KEY] = manifest;
	const result = getEditableMeshSourceState(node);
	if (getEditableMeshSnapshotFingerprint(captureEditableMeshSnapshot(node)) !== beforeFingerprint) {
		throw new Error("Changing export settings modified canonical editable geometry; the operation was rejected.");
	}
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { ...result, changed };
}

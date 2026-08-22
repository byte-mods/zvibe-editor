import { Mesh, Scene, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { applyLoopCutMeshSnapshot, captureLoopCutMeshSnapshot, ILoopCutMeshSnapshot } from "./loop-cut";
import { getMeshEdges, getMeshTopologyFingerprint } from "./meshes";

const VERTEX_COLOR_MODEL = "selection-vertex-color-rgba-v1";
const VERTEX_COLOR_METADATA_KEY = "babylonEditorVertexColors";
const MAXIMUM_VERTEX_COUNT = 500_000;
const MAXIMUM_FACE_COUNT = 100_000;
const MAXIMUM_SELECTED_COMPONENTS = 4_096;
const MAXIMUM_STREAM_VALUES = 20_000_000;
const COLOR_PRECISION = 1_000_000;
const COLOR_EPSILON = 0.000001;

type VertexColorTargetMode = "vertex" | "face";
type VertexColorBlendMode = "replace" | "add" | "multiply";

interface IStoredVertexColors {
	version: 1;
	model: typeof VERTEX_COLOR_MODEL;
	revision: number;
	topologyFingerprint: string;
	colorFingerprint: string;
	lastOperation: {
		targetMode: VertexColorTargetMode;
		targetCount: number;
		affectedVertexCount: number;
		splitVertexCount: number;
		blendMode: VertexColorBlendMode;
		opacity: number;
		color: [number, number, number, number];
	};
}

interface IVertexColorState {
	colors: number[];
	colorStride: 3 | 4;
	hasColorStream: boolean;
	revision: number;
	topologyFingerprint: string;
	colorFingerprint: string;
	metadataCurrent: boolean;
	metadataStale: boolean;
	lastOperation: IStoredVertexColors["lastOperation"] | null;
}

function copySerializable(value: any): any {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function getPositionStream(snapshot: ILoopCutMeshSnapshot): ILoopCutMeshSnapshot["streams"][number] {
	const stream = snapshot.streams.find((candidate) => candidate.kind === VertexBuffer.PositionKind);
	if (!stream || stream.stride !== 3) {
		throw new Error("Vertex painting requires a complete three-component position stream.");
	}
	return stream;
}

function validateSnapshot(snapshot: ILoopCutMeshSnapshot): { vertexCount: number; faceCount: number } {
	const position = getPositionStream(snapshot);
	const vertexCount = position.values.length / 3;
	const faceCount = snapshot.indices.length / 3;
	if (!Number.isInteger(vertexCount) || vertexCount < 1 || vertexCount > MAXIMUM_VERTEX_COUNT) {
		throw new Error(`Vertex painting supports 1-${MAXIMUM_VERTEX_COUNT.toLocaleString()} complete vertices.`);
	}
	if (!Number.isInteger(faceCount) || faceCount < 1 || faceCount > MAXIMUM_FACE_COUNT) {
		throw new Error(`Vertex painting supports 1-${MAXIMUM_FACE_COUNT.toLocaleString()} complete triangle faces.`);
	}
	const streamValueCount = snapshot.streams.reduce((total, stream) => total + stream.values.length, 0);
	if (snapshot.streams.length > 32 || streamValueCount > MAXIMUM_STREAM_VALUES) {
		throw new Error("Vertex painting exceeds the bounded 32-stream or 20,000,000-value safety limit.");
	}
	if (snapshot.indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
		throw new Error("Vertex painting requires every triangle index to reference a current vertex.");
	}
	return { vertexCount, faceCount };
}

function getColorFingerprint(colors: number[]): string {
	let first = 2166136261;
	let second = 2246822519;
	const update = (value: number): void => {
		const integer = Number.isInteger(value) ? value : Math.round(value * COLOR_PRECISION);
		for (let shift = 0; shift < 32; shift += 8) {
			const byte = (integer >>> shift) & 255;
			first = Math.imul(first ^ byte, 16777619) >>> 0;
			second = Math.imul(second ^ byte, 3266489917) >>> 0;
		}
	};
	update(colors.length);
	colors.forEach(update);
	return `vertex-colors-fnv32x2-v1:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function getRgbaColors(snapshot: ILoopCutMeshSnapshot): { colors: number[]; stride: 3 | 4; hasColorStream: boolean } {
	const vertexCount = getPositionStream(snapshot).values.length / 3;
	const stream = snapshot.streams.find((candidate) => candidate.kind === VertexBuffer.ColorKind);
	if (!stream) {
		return { colors: Array.from({ length: vertexCount }, () => [1, 1, 1, 1]).flat(), stride: 4, hasColorStream: false };
	}
	if ((stream.stride !== 3 && stream.stride !== 4) || stream.values.length !== vertexCount * stream.stride) {
		throw new Error(`Vertex painting requires the color stream to contain complete RGB or RGBA values for ${vertexCount} vertices.`);
	}
	if (stream.values.some((value) => !Number.isFinite(value))) {
		throw new Error("Vertex painting requires every existing color component to be finite.");
	}
	if (stream.stride === 4) {
		return { colors: [...stream.values], stride: 4, hasColorStream: true };
	}
	return {
		colors: Array.from({ length: vertexCount }, (_, vertex) => [...stream.values.slice(vertex * 3, vertex * 3 + 3), 1]).flat(),
		stride: 3,
		hasColorStream: true,
	};
}

function isStoredVertexColors(value: any): value is IStoredVertexColors {
	return (
		value?.version === 1 &&
		value?.model === VERTEX_COLOR_MODEL &&
		Number.isInteger(value.revision) &&
		value.revision >= 0 &&
		typeof value.topologyFingerprint === "string" &&
		typeof value.colorFingerprint === "string" &&
		value.lastOperation &&
		(value.lastOperation.targetMode === "vertex" || value.lastOperation.targetMode === "face")
	);
}

function getVertexColorState(mesh: Mesh, snapshot: ILoopCutMeshSnapshot): IVertexColorState {
	const { colors, stride, hasColorStream } = getRgbaColors(snapshot);
	const topologyFingerprint = getMeshTopologyFingerprint(getPositionStream(snapshot).values, snapshot.indices);
	const colorFingerprint = getColorFingerprint(colors);
	const stored = mesh.metadata?.[VERTEX_COLOR_METADATA_KEY];
	const metadataCurrent = isStoredVertexColors(stored) && stored.topologyFingerprint === topologyFingerprint && stored.colorFingerprint === colorFingerprint;
	return {
		colors,
		colorStride: stride,
		hasColorStream,
		revision: metadataCurrent ? stored.revision : 0,
		topologyFingerprint,
		colorFingerprint,
		metadataCurrent,
		metadataStale: stored !== undefined && !metadataCurrent,
		lastOperation: metadataCurrent ? copySerializable(stored.lastOperation) : null,
	};
}

function getSelectionVertices(snapshot: ILoopCutMeshSnapshot): Set<number> {
	const selection = snapshot.selection;
	const selected = new Set<number>();
	if (!selection || !Array.isArray(selection.indices)) {
		return selected;
	}
	if (selection.mode === "vertex") {
		selection.indices.forEach((vertex: number) => {
			if (Number.isInteger(vertex) && vertex >= 0 && vertex < getPositionStream(snapshot).values.length / 3) {
				selected.add(vertex);
			}
		});
	} else if (selection.mode === "face") {
		selection.indices.forEach((face: number) => {
			if (Number.isInteger(face) && face >= 0 && face < snapshot.indices.length / 3) {
				snapshot.indices.slice(face * 3, face * 3 + 3).forEach((vertex) => selected.add(vertex));
			}
		});
	} else if (selection.mode === "edge") {
		const edges = getMeshEdges(snapshot.indices);
		selection.indices.forEach((edge: number) => edges[edge]?.forEach((vertex) => selected.add(vertex)));
	}
	return selected;
}

function getColorKey(colors: number[], vertex: number): string {
	return colors
		.slice(vertex * 4, vertex * 4 + 4)
		.map((value) => Math.round(value * COLOR_PRECISION))
		.join(":");
}

function isWhite(colors: number[], vertex: number): boolean {
	return colors.slice(vertex * 4, vertex * 4 + 4).every((value) => Math.abs(value - 1) <= COLOR_EPSILON);
}

function validateExactIndices(value: any, label: string, maximum: number): number[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_SELECTED_COMPONENTS) {
		throw new Error(`${label} must contain 1-${MAXIMUM_SELECTED_COMPONENTS.toLocaleString()} current component IDs.`);
	}
	if (new Set(value).size !== value.length) {
		throw new Error(`${label} must contain unique component IDs.`);
	}
	if (value.some((index) => !Number.isInteger(index) || index < 0 || index >= maximum)) {
		throw new Error(`${label} must contain integers from 0 to ${maximum - 1}.`);
	}
	return [...value].sort((first, second) => first - second);
}

function validateColor(value: any): [number, number, number, number] {
	if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component) || component < 0 || component > 1)) {
		throw new Error("color must contain exactly four finite RGBA components from 0 to 1.");
	}
	return [...value] as [number, number, number, number];
}

function duplicateVertex(snapshot: ILoopCutMeshSnapshot, vertex: number): number {
	const newVertex = getPositionStream(snapshot).values.length / 3;
	for (const stream of snapshot.streams) {
		stream.values.push(...stream.values.slice(vertex * stream.stride, vertex * stream.stride + stream.stride));
	}
	return newVertex;
}

function isolateSelectedFaces(snapshot: ILoopCutMeshSnapshot, faceIndices: number[]): { paintedVertices: number[]; splitVertexCount: number } {
	const selectedFaces = new Set(faceIndices);
	const selectedUse = new Set<number>();
	const unselectedUse = new Set<number>();
	for (let face = 0; face < snapshot.indices.length / 3; face++) {
		const target = selectedFaces.has(face) ? selectedUse : unselectedUse;
		snapshot.indices.slice(face * 3, face * 3 + 3).forEach((vertex) => target.add(vertex));
	}
	const remap = new Map<number, number>();
	for (const vertex of selectedUse) {
		if (unselectedUse.has(vertex)) {
			remap.set(vertex, duplicateVertex(snapshot, vertex));
		}
	}
	for (const face of faceIndices) {
		for (let corner = 0; corner < 3; corner++) {
			const offset = face * 3 + corner;
			snapshot.indices[offset] = remap.get(snapshot.indices[offset]) ?? snapshot.indices[offset];
		}
	}
	const paintedVertices = new Set<number>();
	faceIndices.forEach((face) => snapshot.indices.slice(face * 3, face * 3 + 3).forEach((vertex) => paintedVertices.add(vertex)));
	return { paintedVertices: [...paintedVertices].sort((first, second) => first - second), splitVertexCount: remap.size };
}

function applyBlend(current: number, color: number, blendMode: VertexColorBlendMode, opacity: number): number {
	const blended = blendMode === "replace" ? color : blendMode === "add" ? clamp(current + color) : current * color;
	return clamp(current + (blended - current) * opacity);
}

/** Inspects exact RGBA vertex colors with bounded paging, selection filtering, and concurrency leases. */
export function getMeshVertexColors(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const snapshot = captureLoopCutMeshSnapshot(scene, { nodeId: node.id });
	const { vertexCount, faceCount } = validateSnapshot(snapshot);
	const state = getVertexColorState(node, snapshot);
	const selected = getSelectionVertices(snapshot);
	if (data.vertexIndices !== undefined && (data.selectedOnly !== undefined || data.nonWhiteOnly !== undefined || data.offset !== undefined || data.limit !== undefined)) {
		throw new Error("vertexIndices cannot be combined with selectedOnly, nonWhiteOnly, offset, or limit.");
	}
	let indices =
		data.vertexIndices !== undefined ? validateExactIndices(data.vertexIndices, "vertexIndices", vertexCount) : Array.from({ length: vertexCount }, (_, index) => index);
	if (data.selectedOnly) {
		indices = indices.filter((vertex) => selected.has(vertex));
	}
	if (data.nonWhiteOnly) {
		indices = indices.filter((vertex) => !isWhite(state.colors, vertex));
	}
	const total = indices.length;
	const offset = data.vertexIndices !== undefined ? 0 : (data.offset ?? 0);
	const limit = data.vertexIndices !== undefined ? Math.max(1, indices.length) : (data.limit ?? 128);
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("offset must be non-negative and limit must be an integer from 1 to 256.");
	}
	const page = indices.slice(offset, offset + limit);
	const channelBounds = Array.from({ length: 4 }, (_, channel) => {
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		for (let vertex = 0; vertex < vertexCount; vertex++) {
			const value = state.colors[vertex * 4 + channel];
			minimum = Math.min(minimum, value);
			maximum = Math.max(maximum, value);
		}
		return { minimum, maximum };
	});
	return {
		node: toNodeSummary(node),
		model: VERTEX_COLOR_MODEL,
		topologyFingerprint: state.topologyFingerprint,
		colorFingerprint: state.colorFingerprint,
		revision: state.revision,
		metadataCurrent: state.metadataCurrent,
		metadataStale: state.metadataStale,
		derivedDefaultWhite: !state.hasColorStream,
		hasColorStream: state.hasColorStream,
		colorStride: state.colorStride,
		useVertexColors: node.useVertexColors,
		hasVertexAlpha: node.hasVertexAlpha,
		vertexCount,
		faceCount,
		paintedVertexCount: Array.from({ length: vertexCount }, (_, vertex) => vertex).filter((vertex) => !isWhite(state.colors, vertex)).length,
		uniqueColorCount: new Set(Array.from({ length: vertexCount }, (_, vertex) => getColorKey(state.colors, vertex))).size,
		selectedVertexCount: selected.size,
		channelBounds: { red: channelBounds[0], green: channelBounds[1], blue: channelBounds[2], alpha: channelBounds[3] },
		lastOperation: state.lastOperation,
		offset,
		limit,
		total,
		returned: page.length,
		hasMore: offset + page.length < total,
		vertices: page.map((vertexIndex) => ({
			vertexIndex,
			color: state.colors.slice(vertexIndex * 4, vertexIndex * 4 + 4),
			selected: selected.has(vertexIndex),
		})),
	};
}

/** Paints selected raw vertices or isolated face corners under exact topology/color/revision leases. */
export function paintMeshVertexColors(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	const before = captureLoopCutMeshSnapshot(scene, { nodeId: node.id });
	const { vertexCount, faceCount } = validateSnapshot(before);
	const state = getVertexColorState(node, before);
	if (data.expectedTopologyFingerprint !== state.topologyFingerprint) {
		throw new Error("Vertex-color topology is stale; call get_mesh_vertex_colors again and use its exact topologyFingerprint.");
	}
	if (data.expectedColorFingerprint !== state.colorFingerprint) {
		throw new Error("Vertex-color values are stale; call get_mesh_vertex_colors again and use its exact colorFingerprint.");
	}
	if (data.expectedRevision !== state.revision) {
		throw new Error(`Vertex-color revision is stale; expected ${state.revision}.`);
	}
	const targetMode = data.targetMode as VertexColorTargetMode;
	if (targetMode !== "vertex" && targetMode !== "face") {
		throw new Error('targetMode must be "vertex" or "face".');
	}
	if ((targetMode === "vertex") !== (data.vertexIndices !== undefined) || (targetMode === "face") !== (data.faceIndices !== undefined)) {
		throw new Error("Vertex targets require only vertexIndices; face targets require only faceIndices.");
	}
	const color = validateColor(data.color);
	const opacity = data.opacity ?? 1;
	if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
		throw new Error("opacity must be from 0 to 1.");
	}
	const blendMode = (data.blendMode ?? "replace") as VertexColorBlendMode;
	if (!(["replace", "add", "multiply"] as VertexColorBlendMode[]).includes(blendMode)) {
		throw new Error('blendMode must be "replace", "add", or "multiply".');
	}
	if (data.splitFaceBoundaries !== undefined && targetMode !== "face") {
		throw new Error("splitFaceBoundaries is valid only for face targets.");
	}
	if (state.colors.some((value) => value < 0 || value > 1)) {
		throw new Error("Existing vertex colors must be within 0-1 before painting.");
	}
	const after = copySerializable(before) as ILoopCutMeshSnapshot;
	let targetIndices: number[];
	let paintedVertices: number[];
	let splitVertexCount = 0;
	if (targetMode === "vertex") {
		targetIndices = validateExactIndices(data.vertexIndices, "vertexIndices", vertexCount);
		paintedVertices = [...targetIndices];
	} else {
		targetIndices = validateExactIndices(data.faceIndices, "faceIndices", faceCount);
		if (data.splitFaceBoundaries ?? true) {
			const isolated = isolateSelectedFaces(after, targetIndices);
			paintedVertices = isolated.paintedVertices;
			splitVertexCount = isolated.splitVertexCount;
		} else {
			const vertices = new Set<number>();
			targetIndices.forEach((face) => after.indices.slice(face * 3, face * 3 + 3).forEach((vertex) => vertices.add(vertex)));
			paintedVertices = [...vertices].sort((first, second) => first - second);
		}
	}
	if (splitVertexCount > 0 && node.morphTargetManager?.numTargets) {
		throw new Error("Face-isolated vertex painting cannot split a mesh with morph targets; paint raw vertices or disable boundary splitting.");
	}
	let colorStream = after.streams.find((stream) => stream.kind === VertexBuffer.ColorKind);
	const vertexCountAfter = getPositionStream(after).values.length / 3;
	if (!colorStream) {
		colorStream = { kind: VertexBuffer.ColorKind, stride: 4, updatable: true, values: Array.from({ length: vertexCountAfter }, () => [1, 1, 1, 1]).flat() };
		after.streams.push(colorStream);
	} else if (colorStream.stride === 3) {
		colorStream.values = Array.from({ length: vertexCountAfter }, (_, vertex) => [...colorStream!.values.slice(vertex * 3, vertex * 3 + 3), 1]).flat();
		colorStream.stride = 4;
	}
	for (const vertex of paintedVertices) {
		for (let channel = 0; channel < 4; channel++) {
			const offset = vertex * 4 + channel;
			colorStream.values[offset] = applyBlend(colorStream.values[offset], color[channel], blendMode, opacity);
		}
	}
	after.selection = { mode: targetMode, indices: targetIndices };
	const topologyFingerprint = getMeshTopologyFingerprint(getPositionStream(after).values, after.indices);
	const colorFingerprint = getColorFingerprint(colorStream.values);
	if (
		after.smoothingGroups?.model === "coincident-face-smoothing-groups-v1" &&
		Array.isArray(after.smoothingGroups.faceGroups) &&
		after.smoothingGroups.faceGroups.length === after.indices.length / 3
	) {
		after.smoothingGroups.topologyFingerprint = topologyFingerprint;
	}
	const operation: IStoredVertexColors["lastOperation"] = {
		targetMode,
		targetCount: targetIndices.length,
		affectedVertexCount: paintedVertices.length,
		splitVertexCount,
		blendMode,
		opacity,
		color,
	};
	after.vertexColors = {
		version: 1,
		model: VERTEX_COLOR_MODEL,
		revision: state.revision + 1,
		topologyFingerprint,
		colorFingerprint,
		lastOperation: operation,
	} satisfies IStoredVertexColors;
	after.useVertexColors = true;
	after.hasVertexAlpha = Array.from({ length: colorStream.values.length / 4 }, (_, vertex) => colorStream!.values[vertex * 4 + 3]).some((alpha) => alpha < 1 - COLOR_EPSILON);
	applyLoopCutMeshSnapshot(node, after);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return {
		...getMeshVertexColors(scene, { nodeId: node.id, vertexIndices: paintedVertices.slice(0, 256) }),
		operation,
		targetIndices,
		paintedVertexIndices: paintedVertices,
		topologyFingerprintBefore: state.topologyFingerprint,
		topologyFingerprintAfter: topologyFingerprint,
		colorFingerprintBefore: state.colorFingerprint,
		colorFingerprintAfter: colorFingerprint,
		vertexCountBefore: vertexCount,
		vertexCountAfter: getPositionStream(after).values.length / 3,
	};
}

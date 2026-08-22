import { createHash } from "node:crypto";

import { unzlibSync, zlibSync } from "fflate";

import {
	ALEMBIC_CACHE_FORMAT,
	ALEMBIC_CACHE_HEADER_BYTES,
	ALEMBIC_CACHE_MAGIC,
	ALEMBIC_CACHE_VERSION,
	getDefaultAlembicImporterSettings,
	IAlembicCacheManifest,
	IAlembicCacheObject,
} from "../../src/assets/alembic";

interface IAlembicTestGeometryState {
	kind: "mesh" | "points" | "curves";
	visible: boolean;
	positions: number[];
	normals?: number[];
	uvs?: number[];
	colors?: number[];
	widths?: number[];
	indices?: number[];
	materialIndices?: number[];
	segmentLengths?: number[];
}

interface IAlembicTestCameraState {
	kind: "camera";
	visible: boolean;
	position: [number, number, number];
	target: [number, number, number];
	up: [number, number, number];
	fovRadians: number;
	near: number;
	far: number;
	orthographic: boolean;
	orthographicSize: number;
}

export type AlembicTestState = IAlembicTestGeometryState | IAlembicTestCameraState;

class BinaryWriter {
	private readonly _bytes: number[] = [];

	public u8(value: number): void {
		this._bytes.push(value & 0xff);
	}

	public u16(value: number): void {
		this._bytes.push(value & 0xff, (value >>> 8) & 0xff);
	}

	public u32(value: number): void {
		this._bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
	}

	public f32(value: number): void {
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setFloat32(0, value, true);
		this._bytes.push(...bytes);
	}

	public f32Array(values: readonly number[]): void {
		values.forEach((value) => this.f32(value));
	}

	public u16Array(values: readonly number[]): void {
		values.forEach((value) => this.u16(value));
	}

	public u32Array(values: readonly number[]): void {
		values.forEach((value) => this.u32(value));
	}

	public result(): Uint8Array {
		return Uint8Array.from(this._bytes);
	}
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const value of bytes) {
		crc ^= value;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	parts.forEach((part) => {
		result.set(part, offset);
		offset += part.byteLength;
	});
	return result;
}

function encodeFrame(states: readonly AlembicTestState[]): Uint8Array {
	const writer = new BinaryWriter();
	writer.u32(0x5246565a);
	writer.u16(1);
	writer.u16(states.length);
	states.forEach((state, objectIndex) => {
		const camera =
			state.kind === "camera"
				? [...state.position, ...state.target, ...state.up, state.fovRadians, state.near, state.far, state.orthographicSize, 0, 0, 0]
				: Array(16).fill(0);
		const vertexCount = state.kind === "camera" ? 0 : state.positions.length / 3;
		const indices = state.kind === "mesh" ? (state.indices ?? []) : [];
		const segments = state.kind === "curves" ? (state.segmentLengths ?? []) : [];
		let flags = 0;
		if (state.kind !== "camera") {
			if (state.normals) flags |= 1 << 0;
			if (state.uvs) flags |= 1 << 1;
			if (state.colors) flags |= 1 << 2;
			if (state.widths) flags |= 1 << 3;
			if (state.materialIndices) flags |= 1 << 4;
		} else if (state.orthographic) {
			flags |= 1 << 5;
		}
		writer.u32(objectIndex);
		writer.u8({ mesh: 1, points: 2, curves: 3, camera: 4 }[state.kind]);
		writer.u8(state.visible ? 1 : 0);
		writer.u16(flags);
		writer.u32(vertexCount);
		writer.u32(indices.length);
		writer.u32(segments.length);
		writer.u32(0);
		writer.f32Array(camera);
		if (state.kind !== "camera") {
			writer.f32Array(state.positions);
			if (state.normals) writer.f32Array(state.normals);
			if (state.uvs) writer.f32Array(state.uvs);
			if (state.colors) writer.f32Array(state.colors);
			if (state.widths) writer.f32Array(state.widths);
			writer.u32Array(indices);
			if (state.materialIndices) writer.u16Array(state.materialIndices);
			writer.u32Array(segments);
		}
	});
	return writer.result();
}

function makeStates(meshOffset: number, pointOffset: number, curveOffset: number, cameraOffset: number, pointVisible = true): AlembicTestState[] {
	return [
		{
			kind: "mesh",
			visible: true,
			positions: [meshOffset, 0, 0, meshOffset + 2, 0, 0, meshOffset, 2, 0],
			normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
			uvs: [0, 0, 1, 0, 0, 1],
			colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1],
			indices: [0, 1, 2],
			materialIndices: [0],
		},
		{
			kind: "points",
			visible: pointVisible,
			positions: [pointOffset, 0, 0, pointOffset + 1, 1, 1],
			colors: [1, 1, 0, 1, 0, 1, 1, 1],
			widths: [2, 4],
		},
		{
			kind: "curves",
			visible: true,
			positions: [0, curveOffset, 0, 1, curveOffset, 0, 2, curveOffset, 0],
			colors: [1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1],
			widths: [1, 1, 1],
			segmentLengths: [3],
		},
		{
			kind: "camera",
			visible: true,
			position: [cameraOffset, 5, -10],
			target: [cameraOffset, 0, 0],
			up: [0, 1, 0],
			fovRadians: Math.PI / 3,
			near: 0.1,
			far: 1000,
			orthographic: false,
			orthographicSize: 10,
		},
	];
}

export const alembicTestObjects: IAlembicCacheObject[] = [
	{
		id: "mesh",
		name: "Animated Mesh",
		path: "/Animated Mesh",
		kind: "mesh",
		topology: "stable",
		materialSlots: ["Body"],
		maximumVertexCount: 3,
		maximumIndexCount: 3,
		bounds: { min: [0, 0, 0], max: [22, 2, 0] },
	},
	{
		id: "points",
		name: "Changing Points",
		path: "/Changing Points",
		kind: "points",
		topology: "variable",
		materialSlots: [],
		maximumVertexCount: 2,
		maximumIndexCount: 0,
		bounds: { min: [0, 0, 0], max: [201, 1, 1] },
	},
	{
		id: "curve",
		name: "Animated Curve",
		path: "/Animated Curve",
		kind: "curves",
		topology: "stable",
		materialSlots: [],
		maximumVertexCount: 3,
		maximumIndexCount: 0,
		bounds: { min: [0, 0, 0], max: [2, 20, 0] },
	},
	{ id: "camera", name: "Shot Camera", path: "/Shot Camera", kind: "camera", topology: "stable", materialSlots: [], maximumVertexCount: 0, maximumIndexCount: 0, bounds: null },
];

export interface IAlembicTestCache {
	bytes: Uint8Array;
	manifest: IAlembicCacheManifest;
}

/** Builds a deterministic multi-object, three-sample cache for decoder and runtime tests. */
export function createAlembicTestCache(): IAlembicTestCache {
	const samples = [
		{ timeSeconds: 0, states: makeStates(0, 0, 0, 0) },
		{ timeSeconds: 0.5, states: makeStates(10, 100, 10, 5) },
		{ timeSeconds: 1, states: makeStates(20, 200, 20, 10, false) },
	];
	const rawFrames = samples.map((sample) => encodeFrame(sample.states));
	const compressedFrames = rawFrames.map((raw) => zlibSync(raw, { level: 6 }));
	let offset = 0;
	const frames = compressedFrames.map((compressed, index) => {
		const result = {
			timeSeconds: samples[index].timeSeconds,
			offset,
			compressedBytes: compressed.byteLength,
			rawBytes: rawFrames[index].byteLength,
			sha256: createHash("sha256").update(compressed).digest("hex"),
		};
		offset += compressed.byteLength;
		return result;
	});
	const settings = getDefaultAlembicImporterSettings();
	const manifest: IAlembicCacheManifest = {
		format: ALEMBIC_CACHE_FORMAT,
		version: ALEMBIC_CACHE_VERSION,
		generator: { name: "Zvibe Editor Blender Alembic Adapter", version: 1, blenderVersion: "Test 1.0" },
		source: { name: "complex.abc", bytes: 4096, sha256: "a".repeat(64) },
		settings,
		settingsSha256: "b".repeat(64),
		coordinateSystem: settings.handedness,
		fps: 2,
		startTimeSeconds: 0,
		endTimeSeconds: 1,
		durationSeconds: 1,
		sampleCount: frames.length,
		objects: structuredClone(alembicTestObjects),
		frames,
		bounds: { min: [0, 0, -10], max: [201, 20, 1] },
		statistics: {
			meshCount: 1,
			pointCount: 1,
			curveCount: 1,
			cameraCount: 1,
			stableTopologyCount: 3,
			variableTopologyCount: 1,
			maximumFrameVertices: 8,
			maximumFrameIndices: 3,
			compressedFrameBytes: compressedFrames.reduce((total, frame) => total + frame.byteLength, 0),
			rawFrameBytes: rawFrames.reduce((total, frame) => total + frame.byteLength, 0),
		},
	};
	return { bytes: encodeCache(manifest, concatenate(...compressedFrames)), manifest };
}

function encodeCache(manifest: IAlembicCacheManifest, payload: Uint8Array): Uint8Array {
	const encodedManifest = new TextEncoder().encode(JSON.stringify(manifest));
	const header = new Uint8Array(ALEMBIC_CACHE_HEADER_BYTES);
	header.set(new TextEncoder().encode(ALEMBIC_CACHE_MAGIC), 0);
	const view = new DataView(header.buffer);
	view.setUint32(8, encodedManifest.byteLength, true);
	view.setUint32(12, crc32(encodedManifest), true);
	return concatenate(header, encodedManifest, payload);
}

/** Rewrites only the JSON manifest while preserving payload bytes for malformed-contract probes. */
export function rewriteAlembicManifest(bytes: Uint8Array, mutate: (manifest: Record<string, any>) => void): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const manifestBytes = view.getUint32(8, true);
	const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(ALEMBIC_CACHE_HEADER_BYTES, ALEMBIC_CACHE_HEADER_BYTES + manifestBytes)));
	mutate(manifest);
	return encodeCache(manifest, bytes.subarray(ALEMBIC_CACHE_HEADER_BYTES + manifestBytes));
}

/** Recompresses one mutated raw sample and repairs all frame-table hashes/offsets for binary decoder probes. */
export function rewriteAlembicFrame(bytes: Uint8Array, frameIndex: number, mutate: (raw: Uint8Array) => void): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const manifestBytes = view.getUint32(8, true);
	const payloadOffset = ALEMBIC_CACHE_HEADER_BYTES + manifestBytes;
	const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(ALEMBIC_CACHE_HEADER_BYTES, payloadOffset))) as IAlembicCacheManifest;
	const compressedFrames = manifest.frames.map((frame, index) => {
		const compressed = bytes.subarray(payloadOffset + frame.offset, payloadOffset + frame.offset + frame.compressedBytes);
		if (index !== frameIndex) return compressed.slice();
		const raw = unzlibSync(compressed);
		mutate(raw);
		return zlibSync(raw, { level: 6 });
	});
	let offset = 0;
	manifest.frames.forEach((frame, index) => {
		frame.offset = offset;
		frame.compressedBytes = compressedFrames[index].byteLength;
		frame.sha256 = createHash("sha256").update(compressedFrames[index]).digest("hex");
		offset += frame.compressedBytes;
	});
	manifest.statistics.compressedFrameBytes = offset;
	return encodeCache(manifest, concatenate(...compressedFrames));
}

import { Unzlib } from "fflate";

export const ALEMBIC_CACHE_VERSION = 1;
export const ALEMBIC_CACHE_FORMAT = "zvibe-alembic-cache";
export const ALEMBIC_CACHE_HEADER_BYTES = 16;
export const ALEMBIC_CACHE_MAGIC = "ZVABC1\r\n";

export const ALEMBIC_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const ALEMBIC_MAX_CACHE_BYTES = 1024 * 1024 * 1024;
export const ALEMBIC_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const ALEMBIC_MAX_FRAME_BYTES = 512 * 1024 * 1024;
export const ALEMBIC_MAX_OBJECTS = 4096;
export const ALEMBIC_MAX_SAMPLES = 10_000;
export const ALEMBIC_MAX_VERTICES_PER_FRAME = 10_000_000;
export const ALEMBIC_MAX_INDICES_PER_FRAME = 30_000_000;

export type AlembicInterpolation = "hold" | "linear";
export type AlembicHandedness = "babylonLeftHanded" | "sourceRightHanded";
export type AlembicNormals = "import" | "calculate" | "none";
export type AlembicObjectKind = "mesh" | "points" | "curves" | "camera";
export type AlembicTopology = "stable" | "variable";

export interface IAlembicImporterSettings {
	scaleFactor: number;
	convertUnits: boolean;
	handedness: AlembicHandedness;
	flipFaces: boolean;
	importMeshes: boolean;
	importPoints: boolean;
	importCurves: boolean;
	importCameras: boolean;
	normals: AlembicNormals;
	sampleRate: number;
	startTimeSeconds: number;
	endTimeSeconds: number;
	maximumSamples: number;
	interpolation: AlembicInterpolation;
	playOnAwake: boolean;
	loopByDefault: boolean;
	speed: number;
	pointSize: number;
	curveWidth: number;
}

export interface IAlembicCacheBounds {
	min: [number, number, number];
	max: [number, number, number];
}

export interface IAlembicCacheObject {
	id: string;
	name: string;
	path: string;
	kind: AlembicObjectKind;
	topology: AlembicTopology;
	materialSlots: string[];
	maximumVertexCount: number;
	maximumIndexCount: number;
	bounds: IAlembicCacheBounds | null;
}

export interface IAlembicCacheFrameChunk {
	timeSeconds: number;
	offset: number;
	compressedBytes: number;
	rawBytes: number;
	sha256: string;
}

export interface IAlembicCacheManifest {
	format: typeof ALEMBIC_CACHE_FORMAT;
	version: typeof ALEMBIC_CACHE_VERSION;
	generator: {
		name: "Zvibe Editor Blender Alembic Adapter";
		version: number;
		blenderVersion: string;
	};
	source: {
		name: string;
		bytes: number;
		sha256: string;
	};
	settings: IAlembicImporterSettings;
	settingsSha256: string;
	coordinateSystem: AlembicHandedness;
	fps: number;
	startTimeSeconds: number;
	endTimeSeconds: number;
	durationSeconds: number;
	sampleCount: number;
	objects: IAlembicCacheObject[];
	frames: IAlembicCacheFrameChunk[];
	bounds: IAlembicCacheBounds | null;
	statistics: {
		meshCount: number;
		pointCount: number;
		curveCount: number;
		cameraCount: number;
		stableTopologyCount: number;
		variableTopologyCount: number;
		maximumFrameVertices: number;
		maximumFrameIndices: number;
		compressedFrameBytes: number;
		rawFrameBytes: number;
	};
}

export interface IAlembicCacheDocument {
	manifest: IAlembicCacheManifest;
	payloadOffset: number;
	bytes: Uint8Array;
}

export interface IAlembicMeshFrameState {
	objectIndex: number;
	kind: "mesh";
	visible: boolean;
	positions: Float32Array;
	normals: Float32Array | null;
	uvs: Float32Array | null;
	colors: Float32Array | null;
	indices: Uint32Array;
	materialIndices: Uint16Array | null;
}

export interface IAlembicPointsFrameState {
	objectIndex: number;
	kind: "points";
	visible: boolean;
	positions: Float32Array;
	colors: Float32Array | null;
	widths: Float32Array | null;
}

export interface IAlembicCurvesFrameState {
	objectIndex: number;
	kind: "curves";
	visible: boolean;
	positions: Float32Array;
	colors: Float32Array | null;
	widths: Float32Array | null;
	segmentLengths: Uint32Array;
}

export interface IAlembicCameraFrameState {
	objectIndex: number;
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

export type AlembicFrameState = IAlembicMeshFrameState | IAlembicPointsFrameState | IAlembicCurvesFrameState | IAlembicCameraFrameState;

export interface IAlembicDecodedFrame {
	index: number;
	timeSeconds: number;
	states: AlembicFrameState[];
	vertexCount: number;
	indexCount: number;
}

const objectKindCodes: Record<AlembicObjectKind, number> = { mesh: 1, points: 2, curves: 3, camera: 4 };
const objectKindsByCode = new Map<number, AlembicObjectKind>(Object.entries(objectKindCodes).map(([kind, code]) => [code, kind as AlembicObjectKind]));
const frameMagic = 0x5246565a;
const frameVersion = 1;
const frameStateHeaderBytes = 88;
const flagNormals = 1 << 0;
const flagUvs = 1 << 1;
const flagColors = 1 << 2;
const flagWidths = 1 << 3;
const flagMaterialIndices = 1 << 4;
const flagOrthographic = 1 << 5;
const knownFlags = flagNormals | flagUvs | flagColors | flagWidths | flagMaterialIndices | flagOrthographic;

const defaultSettings: IAlembicImporterSettings = {
	scaleFactor: 1,
	convertUnits: true,
	handedness: "babylonLeftHanded",
	flipFaces: false,
	importMeshes: true,
	importPoints: true,
	importCurves: true,
	importCameras: true,
	normals: "import",
	sampleRate: 30,
	startTimeSeconds: -1,
	endTimeSeconds: -1,
	maximumSamples: 300,
	interpolation: "linear",
	playOnAwake: true,
	loopByDefault: true,
	speed: 1,
	pointSize: 2,
	curveWidth: 1,
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	const result = finite(value, label, minimum, maximum);
	if (!Number.isSafeInteger(result)) {
		throw new Error(`${label} must be an integer.`);
	}
	return result;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function string(value: unknown, label: string, maximumLength = 1024): string {
	if (typeof value !== "string" || !value || value.length > maximumLength || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty string of at most ${maximumLength} characters.`);
	}
	return value;
}

function enumeration<T extends string>(value: unknown, label: string, values: readonly T[]): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

/** Converts generic importer settings into the single strict Alembic authoring contract. */
export function normalizeAlembicImporterSettings(value: unknown): IAlembicImporterSettings {
	const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const result: IAlembicImporterSettings = {
		scaleFactor: finite(source.scaleFactor ?? defaultSettings.scaleFactor, "Alembic scaleFactor", 0.0001, 100_000),
		convertUnits: boolean(source.convertUnits ?? defaultSettings.convertUnits, "Alembic convertUnits"),
		handedness: enumeration(source.handedness ?? defaultSettings.handedness, "Alembic handedness", ["babylonLeftHanded", "sourceRightHanded"] as const),
		flipFaces: boolean(source.flipFaces ?? defaultSettings.flipFaces, "Alembic flipFaces"),
		importMeshes: boolean(source.importMeshes ?? defaultSettings.importMeshes, "Alembic importMeshes"),
		importPoints: boolean(source.importPoints ?? defaultSettings.importPoints, "Alembic importPoints"),
		importCurves: boolean(source.importCurves ?? defaultSettings.importCurves, "Alembic importCurves"),
		importCameras: boolean(source.importCameras ?? defaultSettings.importCameras, "Alembic importCameras"),
		normals: enumeration(source.normals ?? defaultSettings.normals, "Alembic normals", ["import", "calculate", "none"] as const),
		sampleRate: finite(source.sampleRate ?? defaultSettings.sampleRate, "Alembic sampleRate", 0.1, 240),
		startTimeSeconds: finite(source.startTimeSeconds ?? defaultSettings.startTimeSeconds, "Alembic startTimeSeconds", -1, 1_000_000),
		endTimeSeconds: finite(source.endTimeSeconds ?? defaultSettings.endTimeSeconds, "Alembic endTimeSeconds", -1, 1_000_000),
		maximumSamples: integer(source.maximumSamples ?? defaultSettings.maximumSamples, "Alembic maximumSamples", 1, ALEMBIC_MAX_SAMPLES),
		interpolation: enumeration(source.interpolation ?? defaultSettings.interpolation, "Alembic interpolation", ["hold", "linear"] as const),
		playOnAwake: boolean(source.playOnAwake ?? defaultSettings.playOnAwake, "Alembic playOnAwake"),
		loopByDefault: boolean(source.loopByDefault ?? defaultSettings.loopByDefault, "Alembic loopByDefault"),
		speed: finite(source.speed ?? defaultSettings.speed, "Alembic speed", -100, 100),
		pointSize: finite(source.pointSize ?? defaultSettings.pointSize, "Alembic pointSize", 0.01, 1_000),
		curveWidth: finite(source.curveWidth ?? defaultSettings.curveWidth, "Alembic curveWidth", 0.01, 1_000),
	};
	if (!result.importMeshes && !result.importPoints && !result.importCurves && !result.importCameras) {
		throw new Error("Alembic import must enable at least one object family.");
	}
	if (result.speed === 0) {
		throw new Error("Alembic speed must be non-zero.");
	}
	if (result.startTimeSeconds >= 0 && result.endTimeSeconds >= 0 && result.endTimeSeconds < result.startTimeSeconds) {
		throw new Error("Alembic endTimeSeconds must be automatic (-1) or greater than or equal to startTimeSeconds.");
	}
	return result;
}

export function getDefaultAlembicImporterSettings(): IAlembicImporterSettings {
	return { ...defaultSettings };
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

function bounds(value: unknown, label: string): IAlembicCacheBounds | null {
	if (value === null) {
		return null;
	}
	const source = record(value, label);
	const validateVector = (candidate: unknown, child: string): [number, number, number] => {
		if (!Array.isArray(candidate) || candidate.length !== 3) {
			throw new Error(`${child} must contain exactly three finite numbers.`);
		}
		return candidate.map((entry, index) => finite(entry, `${child}[${index}]`, -1e12, 1e12)) as [number, number, number];
	};
	const min = validateVector(source.min, `${label}.min`);
	const max = validateVector(source.max, `${label}.max`);
	if (min.some((entry, index) => entry > max[index])) {
		throw new Error(`${label} minimum coordinates must not exceed maximum coordinates.`);
	}
	return { min, max };
}

function validateManifest(value: unknown, payloadBytes: number): IAlembicCacheManifest {
	const source = record(value, "Alembic cache manifest");
	if (source.format !== ALEMBIC_CACHE_FORMAT || source.version !== ALEMBIC_CACHE_VERSION) {
		throw new Error(`Alembic cache requires ${ALEMBIC_CACHE_FORMAT} version ${ALEMBIC_CACHE_VERSION}.`);
	}
	const generator = record(source.generator, "Alembic cache generator");
	if (generator.name !== "Zvibe Editor Blender Alembic Adapter") {
		throw new Error('Alembic cache generator name must be "Zvibe Editor Blender Alembic Adapter".');
	}
	const sourceEvidence = record(source.source, "Alembic cache source evidence");
	const statisticsSource = record(source.statistics, "Alembic cache statistics");
	const settings = normalizeAlembicImporterSettings(source.settings);
	const fps = finite(source.fps, "Alembic cache fps", 0.1, 1000);
	const startTimeSeconds = finite(source.startTimeSeconds, "Alembic cache startTimeSeconds", -1_000_000, 1_000_000);
	const endTimeSeconds = finite(source.endTimeSeconds, "Alembic cache endTimeSeconds", startTimeSeconds, 1_000_000);
	const durationSeconds = finite(source.durationSeconds, "Alembic cache durationSeconds", 0, 1_000_000);
	if (Math.abs(durationSeconds - (endTimeSeconds - startTimeSeconds)) > 0.001) {
		throw new Error("Alembic cache duration does not match its time range.");
	}
	if (!Array.isArray(source.objects) || source.objects.length > ALEMBIC_MAX_OBJECTS) {
		throw new Error(`Alembic cache supports at most ${ALEMBIC_MAX_OBJECTS} objects.`);
	}
	const ids = new Set<string>();
	const objects = source.objects.map((entry, index): IAlembicCacheObject => {
		const candidate = record(entry, `Alembic object ${index}`);
		const id = string(candidate.id, `Alembic object ${index} id`, 256);
		if (ids.has(id)) {
			throw new Error(`Alembic object id "${id}" is duplicated.`);
		}
		ids.add(id);
		const materialSlots = Array.isArray(candidate.materialSlots)
			? candidate.materialSlots.map((slot, slotIndex) => string(slot, `Alembic object ${index} material slot ${slotIndex}`, 256))
			: (() => {
					throw new Error(`Alembic object ${index} materialSlots must be an array.`);
				})();
		if (materialSlots.length > 256) {
			throw new Error(`Alembic object ${index} has more than 256 material slots.`);
		}
		return {
			id,
			name: string(candidate.name, `Alembic object ${index} name`, 512),
			path: string(candidate.path, `Alembic object ${index} path`, 2048),
			kind: enumeration(candidate.kind, `Alembic object ${index} kind`, ["mesh", "points", "curves", "camera"] as const),
			topology: enumeration(candidate.topology, `Alembic object ${index} topology`, ["stable", "variable"] as const),
			materialSlots,
			maximumVertexCount: integer(candidate.maximumVertexCount, `Alembic object ${index} maximumVertexCount`, 0, ALEMBIC_MAX_VERTICES_PER_FRAME),
			maximumIndexCount: integer(candidate.maximumIndexCount, `Alembic object ${index} maximumIndexCount`, 0, ALEMBIC_MAX_INDICES_PER_FRAME),
			bounds: bounds(candidate.bounds, `Alembic object ${index} bounds`),
		};
	});
	if (!Array.isArray(source.frames) || source.frames.length < 1 || source.frames.length > ALEMBIC_MAX_SAMPLES) {
		throw new Error(`Alembic cache requires 1 through ${ALEMBIC_MAX_SAMPLES} frame chunks.`);
	}
	let previousEnd = 0;
	let previousTime = -Infinity;
	const frames = source.frames.map((entry, index): IAlembicCacheFrameChunk => {
		const candidate = record(entry, `Alembic frame ${index}`);
		const frame = {
			timeSeconds: finite(candidate.timeSeconds, `Alembic frame ${index} timeSeconds`, startTimeSeconds, endTimeSeconds),
			offset: integer(candidate.offset, `Alembic frame ${index} offset`, 0, payloadBytes),
			compressedBytes: integer(candidate.compressedBytes, `Alembic frame ${index} compressedBytes`, 1, ALEMBIC_MAX_FRAME_BYTES),
			rawBytes: integer(candidate.rawBytes, `Alembic frame ${index} rawBytes`, 1, ALEMBIC_MAX_FRAME_BYTES),
			sha256: string(candidate.sha256, `Alembic frame ${index} sha256`, 64).toLowerCase(),
		};
		if (!/^[a-f0-9]{64}$/.test(frame.sha256)) {
			throw new Error(`Alembic frame ${index} sha256 must contain 64 lowercase hexadecimal characters.`);
		}
		if (frame.offset !== previousEnd || frame.offset + frame.compressedBytes > payloadBytes) {
			throw new Error(`Alembic frame ${index} does not exactly continue the ordered payload span.`);
		}
		if (frame.timeSeconds < previousTime) {
			throw new Error("Alembic frame times must be ordered.");
		}
		previousEnd = frame.offset + frame.compressedBytes;
		previousTime = frame.timeSeconds;
		return frame;
	});
	if (previousEnd !== payloadBytes) {
		throw new Error("Alembic frame table does not exactly cover the cache payload.");
	}
	const sampleCount = integer(source.sampleCount, "Alembic cache sampleCount", 1, ALEMBIC_MAX_SAMPLES);
	if (sampleCount !== frames.length) {
		throw new Error("Alembic cache sampleCount does not match its frame table.");
	}
	const statistics: IAlembicCacheManifest["statistics"] = {
		meshCount: integer(statisticsSource.meshCount, "Alembic meshCount", 0, ALEMBIC_MAX_OBJECTS),
		pointCount: integer(statisticsSource.pointCount, "Alembic pointCount", 0, ALEMBIC_MAX_OBJECTS),
		curveCount: integer(statisticsSource.curveCount, "Alembic curveCount", 0, ALEMBIC_MAX_OBJECTS),
		cameraCount: integer(statisticsSource.cameraCount, "Alembic cameraCount", 0, ALEMBIC_MAX_OBJECTS),
		stableTopologyCount: integer(statisticsSource.stableTopologyCount, "Alembic stableTopologyCount", 0, ALEMBIC_MAX_OBJECTS),
		variableTopologyCount: integer(statisticsSource.variableTopologyCount, "Alembic variableTopologyCount", 0, ALEMBIC_MAX_OBJECTS),
		maximumFrameVertices: integer(statisticsSource.maximumFrameVertices, "Alembic maximumFrameVertices", 0, ALEMBIC_MAX_VERTICES_PER_FRAME),
		maximumFrameIndices: integer(statisticsSource.maximumFrameIndices, "Alembic maximumFrameIndices", 0, ALEMBIC_MAX_INDICES_PER_FRAME),
		compressedFrameBytes: integer(statisticsSource.compressedFrameBytes, "Alembic compressedFrameBytes", 1, ALEMBIC_MAX_CACHE_BYTES),
		rawFrameBytes: integer(statisticsSource.rawFrameBytes, "Alembic rawFrameBytes", 1, Number.MAX_SAFE_INTEGER),
	};
	if (statistics.meshCount + statistics.pointCount + statistics.curveCount + statistics.cameraCount !== objects.length) {
		throw new Error("Alembic object statistics do not match the manifest object table.");
	}
	if (statistics.stableTopologyCount + statistics.variableTopologyCount !== objects.length) {
		throw new Error("Alembic topology statistics do not match the manifest object table.");
	}
	if (statistics.compressedFrameBytes !== frames.reduce((total, frame) => total + frame.compressedBytes, 0)) {
		throw new Error("Alembic compressed-frame statistics do not match the frame table.");
	}
	if (statistics.rawFrameBytes !== frames.reduce((total, frame) => total + frame.rawBytes, 0)) {
		throw new Error("Alembic raw-frame statistics do not match the frame table.");
	}
	const sourceSha256 = string(sourceEvidence.sha256, "Alembic source sha256", 64).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
		throw new Error("Alembic source sha256 must contain 64 lowercase hexadecimal characters.");
	}
	const settingsSha256 = string(source.settingsSha256, "Alembic settings sha256", 64).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(settingsSha256)) {
		throw new Error("Alembic settings sha256 must contain 64 lowercase hexadecimal characters.");
	}
	const coordinateSystem = enumeration(source.coordinateSystem, "Alembic coordinateSystem", ["babylonLeftHanded", "sourceRightHanded"] as const);
	if (coordinateSystem !== settings.handedness) {
		throw new Error("Alembic cache coordinateSystem must match its importer handedness setting.");
	}
	return {
		format: ALEMBIC_CACHE_FORMAT,
		version: ALEMBIC_CACHE_VERSION,
		generator: {
			name: "Zvibe Editor Blender Alembic Adapter",
			version: integer(generator.version, "Alembic generator version", 1, 1_000_000),
			blenderVersion: string(generator.blenderVersion, "Alembic Blender version", 128),
		},
		source: {
			name: string(sourceEvidence.name, "Alembic source name", 1024),
			bytes: integer(sourceEvidence.bytes, "Alembic source bytes", 1, ALEMBIC_MAX_SOURCE_BYTES),
			sha256: sourceSha256,
		},
		settings,
		settingsSha256,
		coordinateSystem,
		fps,
		startTimeSeconds,
		endTimeSeconds,
		durationSeconds,
		sampleCount,
		objects,
		frames,
		bounds: bounds(source.bounds, "Alembic cache bounds"),
		statistics,
	};
}

/** Parses and validates a complete portable Alembic cache without decoding its compressed frames. */
export function parseAlembicCache(bytes: Uint8Array): IAlembicCacheDocument {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < ALEMBIC_CACHE_HEADER_BYTES || bytes.byteLength > ALEMBIC_MAX_CACHE_BYTES) {
		throw new Error(`Alembic cache must contain ${ALEMBIC_CACHE_HEADER_BYTES} through ${ALEMBIC_MAX_CACHE_BYTES} bytes.`);
	}
	const magic = new TextDecoder().decode(bytes.subarray(0, 8));
	if (magic !== ALEMBIC_CACHE_MAGIC) {
		throw new Error("Alembic cache has an invalid ZVABC magic header.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const manifestBytes = view.getUint32(8, true);
	const expectedCrc = view.getUint32(12, true);
	if (manifestBytes < 2 || manifestBytes > ALEMBIC_MAX_MANIFEST_BYTES || ALEMBIC_CACHE_HEADER_BYTES + manifestBytes > bytes.byteLength) {
		throw new Error("Alembic cache manifest length is invalid or out of range.");
	}
	const encodedManifest = bytes.subarray(ALEMBIC_CACHE_HEADER_BYTES, ALEMBIC_CACHE_HEADER_BYTES + manifestBytes);
	if (crc32(encodedManifest) !== expectedCrc) {
		throw new Error("Alembic cache manifest checksum does not match its bytes.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encodedManifest));
	} catch (error) {
		throw new Error(`Alembic cache manifest is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const payloadOffset = ALEMBIC_CACHE_HEADER_BYTES + manifestBytes;
	return { manifest: validateManifest(parsed, bytes.byteLength - payloadOffset), payloadOffset, bytes };
}

async function sha256(bytes: Uint8Array): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Alembic cache validation requires Web Crypto SHA-256 support.");
	}
	const input = bytes.slice().buffer;
	const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Inflates in bounded compressed chunks so a false raw-size declaration cannot allocate an unbounded output before rejection. */
function unzlibBounded(compressed: Uint8Array, expectedBytes: number, frameIndex: number): Uint8Array {
	const output = new Uint8Array(expectedBytes);
	let offset = 0;
	let completed = false;
	const decoder = new Unzlib((chunk, final) => {
		if (offset + chunk.byteLength > expectedBytes) {
			throw new Error(`Alembic frame ${frameIndex} expands beyond its declared ${expectedBytes} bytes.`);
		}
		output.set(chunk, offset);
		offset += chunk.byteLength;
		completed = final;
	});
	// DEFLATE's maximum expansion per 16 KiB compressed slice is bounded, while larger archives still stream without per-byte overhead.
	for (let start = 0; start < compressed.byteLength; start += 16 * 1024) {
		const end = Math.min(compressed.byteLength, start + 16 * 1024);
		decoder.push(compressed.subarray(start, end), end === compressed.byteLength);
	}
	if (!completed || offset !== expectedBytes) {
		throw new Error(`Alembic frame ${frameIndex} decoded ${offset} bytes; ${expectedBytes} were declared.`);
	}
	return output;
}

class FrameReader {
	private _offset = 0;
	private readonly _view: DataView;

	public constructor(
		private readonly _bytes: Uint8Array,
		private readonly _frameIndex: number
	) {
		this._view = new DataView(_bytes.buffer, _bytes.byteOffset, _bytes.byteLength);
	}

	public get remaining(): number {
		return this._bytes.byteLength - this._offset;
	}

	public u8(label: string): number {
		this._require(1, label);
		return this._view.getUint8(this._offset++);
	}

	public u16(label: string): number {
		this._require(2, label);
		const value = this._view.getUint16(this._offset, true);
		this._offset += 2;
		return value;
	}

	public u32(label: string): number {
		this._require(4, label);
		const value = this._view.getUint32(this._offset, true);
		this._offset += 4;
		return value;
	}

	public f32(label: string): number {
		this._require(4, label);
		const value = this._view.getFloat32(this._offset, true);
		this._offset += 4;
		if (!Number.isFinite(value)) {
			throw new Error(`Alembic frame ${this._frameIndex} ${label} is not finite.`);
		}
		return value;
	}

	public f32Array(length: number, label: string): Float32Array {
		const bytes = this._take(length * 4, label);
		const result = new Float32Array(length);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let index = 0; index < length; index++) {
			const value = view.getFloat32(index * 4, true);
			if (!Number.isFinite(value)) {
				throw new Error(`Alembic frame ${this._frameIndex} ${label}[${index}] is not finite.`);
			}
			result[index] = value;
		}
		return result;
	}

	public u32Array(length: number, label: string): Uint32Array {
		const bytes = this._take(length * 4, label);
		const result = new Uint32Array(length);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let index = 0; index < length; index++) {
			result[index] = view.getUint32(index * 4, true);
		}
		return result;
	}

	public u16Array(length: number, label: string): Uint16Array {
		const bytes = this._take(length * 2, label);
		const result = new Uint16Array(length);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let index = 0; index < length; index++) {
			result[index] = view.getUint16(index * 2, true);
		}
		return result;
	}

	private _take(length: number, label: string): Uint8Array {
		this._require(length, label);
		const result = this._bytes.subarray(this._offset, this._offset + length);
		this._offset += length;
		return result;
	}

	private _require(length: number, label: string): void {
		if (!Number.isSafeInteger(length) || length < 0 || this._offset + length > this._bytes.byteLength) {
			throw new Error(`Alembic frame ${this._frameIndex} ${label} exceeds its decoded payload.`);
		}
	}
}

/** Decodes and independently hashes one compressed frame from a validated cache document. */
export async function decodeAlembicFrame(document: IAlembicCacheDocument, frameIndex: number): Promise<IAlembicDecodedFrame> {
	if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= document.manifest.frames.length) {
		throw new Error(`Alembic frame index must be between 0 and ${document.manifest.frames.length - 1}.`);
	}
	const chunk = document.manifest.frames[frameIndex];
	const start = document.payloadOffset + chunk.offset;
	const compressed = document.bytes.subarray(start, start + chunk.compressedBytes);
	if ((await sha256(compressed)) !== chunk.sha256) {
		throw new Error(`Alembic frame ${frameIndex} SHA-256 does not match its manifest.`);
	}
	let raw: Uint8Array;
	try {
		raw = unzlibBounded(compressed, chunk.rawBytes, frameIndex);
	} catch (error) {
		throw new Error(`Alembic frame ${frameIndex} could not be decompressed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const reader = new FrameReader(raw, frameIndex);
	if (reader.u32("magic") !== frameMagic || reader.u16("version") !== frameVersion) {
		throw new Error(`Alembic frame ${frameIndex} has an unsupported frame header.`);
	}
	const stateCount = reader.u16("stateCount");
	if (stateCount !== document.manifest.objects.length || raw.byteLength < 8 + stateCount * frameStateHeaderBytes) {
		throw new Error(`Alembic frame ${frameIndex} state count does not match its object table.`);
	}
	const states: AlembicFrameState[] = [];
	let vertexCount = 0;
	let indexCount = 0;
	for (let stateIndex = 0; stateIndex < stateCount; stateIndex++) {
		const objectIndex = reader.u32(`state ${stateIndex} objectIndex`);
		const kindCode = reader.u8(`state ${stateIndex} kind`);
		const visible = reader.u8(`state ${stateIndex} visibility`) !== 0;
		const flags = reader.u16(`state ${stateIndex} flags`);
		const vertices = reader.u32(`state ${stateIndex} vertexCount`);
		const indices = reader.u32(`state ${stateIndex} indexCount`);
		const segments = reader.u32(`state ${stateIndex} segmentCount`);
		const reserved = reader.u32(`state ${stateIndex} reserved`);
		const camera = Array.from({ length: 16 }, (_, index) => reader.f32(`state ${stateIndex} camera[${index}]`));
		if ((flags & ~knownFlags) !== 0 || reserved !== 0) {
			throw new Error(`Alembic frame ${frameIndex} state ${stateIndex} contains unsupported flags or reserved data.`);
		}
		if (objectIndex !== stateIndex || objectIndex >= document.manifest.objects.length) {
			throw new Error(`Alembic frame ${frameIndex} state ${stateIndex} has a non-canonical object index.`);
		}
		const object = document.manifest.objects[objectIndex];
		const kind = objectKindsByCode.get(kindCode);
		if (!kind || kind !== object.kind) {
			throw new Error(`Alembic frame ${frameIndex} state ${stateIndex} kind does not match object "${object.name}".`);
		}
		if (vertices > object.maximumVertexCount || indices > object.maximumIndexCount) {
			throw new Error(`Alembic frame ${frameIndex} state ${stateIndex} exceeds its declared topology bounds.`);
		}
		vertexCount += vertices;
		indexCount += indices;
		if (vertexCount > ALEMBIC_MAX_VERTICES_PER_FRAME || indexCount > ALEMBIC_MAX_INDICES_PER_FRAME) {
			throw new Error(`Alembic frame ${frameIndex} exceeds aggregate geometry limits.`);
		}
		if (kind === "camera") {
			if (vertices || indices || segments || flags & (flagNormals | flagUvs | flagColors | flagWidths | flagMaterialIndices)) {
				throw new Error(`Alembic frame ${frameIndex} camera state ${stateIndex} contains mesh payload fields.`);
			}
			const directionLength = Math.hypot(camera[3] - camera[0], camera[4] - camera[1], camera[5] - camera[2]);
			const upLength = Math.hypot(camera[6], camera[7], camera[8]);
			if (
				directionLength < 1e-8 ||
				upLength < 1e-8 ||
				camera[9] <= 0 ||
				camera[9] >= Math.PI ||
				camera[10] <= 0 ||
				camera[11] <= camera[10] ||
				camera[12] <= 0 ||
				camera.slice(13).some((value) => value !== 0)
			) {
				throw new Error(`Alembic frame ${frameIndex} camera state ${stateIndex} has invalid optics, orientation, or reserved values.`);
			}
			states.push({
				objectIndex,
				kind,
				visible,
				position: [camera[0], camera[1], camera[2]],
				target: [camera[3], camera[4], camera[5]],
				up: [camera[6], camera[7], camera[8]],
				fovRadians: camera[9],
				near: camera[10],
				far: camera[11],
				orthographic: (flags & flagOrthographic) !== 0,
				orthographicSize: camera[12],
			});
			continue;
		}
		const positions = reader.f32Array(vertices * 3, `state ${stateIndex} positions`);
		const normals = flags & flagNormals ? reader.f32Array(vertices * 3, `state ${stateIndex} normals`) : null;
		const uvs = flags & flagUvs ? reader.f32Array(vertices * 2, `state ${stateIndex} uvs`) : null;
		const colors = flags & flagColors ? reader.f32Array(vertices * 4, `state ${stateIndex} colors`) : null;
		const widths = flags & flagWidths ? reader.f32Array(vertices, `state ${stateIndex} widths`) : null;
		const indexValues = reader.u32Array(indices, `state ${stateIndex} indices`);
		if (indexValues.some((index) => index >= vertices)) {
			throw new Error(`Alembic frame ${frameIndex} state ${stateIndex} references a vertex outside its array.`);
		}
		const materialIndices = flags & flagMaterialIndices ? reader.u16Array(Math.floor(indices / 3), `state ${stateIndex} materialIndices`) : null;
		if (materialIndices?.some((index) => index >= Math.max(1, object.materialSlots.length))) {
			throw new Error(`Alembic frame ${frameIndex} state ${stateIndex} references an unavailable material slot.`);
		}
		if (kind === "mesh") {
			if (segments || indices % 3 !== 0 || widths) {
				throw new Error(`Alembic frame ${frameIndex} mesh state ${stateIndex} has an invalid topology layout.`);
			}
			states.push({ objectIndex, kind, visible, positions, normals, uvs, colors, indices: indexValues, materialIndices });
		} else if (kind === "points") {
			if (indices || segments || normals || uvs || materialIndices) {
				throw new Error(`Alembic frame ${frameIndex} point state ${stateIndex} has an invalid point layout.`);
			}
			states.push({ objectIndex, kind, visible, positions, colors, widths });
		} else {
			if (indices || normals || uvs || materialIndices || segments > vertices) {
				throw new Error(`Alembic frame ${frameIndex} curve state ${stateIndex} has an invalid curve layout.`);
			}
			const segmentLengths = reader.u32Array(segments, `state ${stateIndex} segmentLengths`);
			if (segmentLengths.reduce((total, length) => total + length, 0) !== vertices || segmentLengths.some((length) => length < 2)) {
				throw new Error(`Alembic frame ${frameIndex} curve state ${stateIndex} segment lengths do not cover its positions.`);
			}
			states.push({ objectIndex, kind, visible, positions, colors, widths, segmentLengths });
		}
	}
	if (reader.remaining !== 0) {
		throw new Error(`Alembic frame ${frameIndex} contains ${reader.remaining} unexpected trailing bytes.`);
	}
	return { index: frameIndex, timeSeconds: chunk.timeSeconds, states, vertexCount, indexCount };
}

/** Returns the two ordered samples and blend factor for one playback time. */
export function getAlembicFrameBlend(manifest: IAlembicCacheManifest, timeSeconds: number): { current: number; next: number; amount: number } {
	if (!Number.isFinite(timeSeconds)) {
		throw new Error("Alembic playback time must be finite.");
	}
	const clamped = Math.min(manifest.endTimeSeconds, Math.max(manifest.startTimeSeconds, timeSeconds));
	let low = 0;
	let high = manifest.frames.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (manifest.frames[middle].timeSeconds <= clamped) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	const current = low;
	const next = Math.min(current + 1, manifest.frames.length - 1);
	const span = manifest.frames[next].timeSeconds - manifest.frames[current].timeSeconds;
	return { current, next, amount: span > 0 ? Math.min(1, Math.max(0, (clamped - manifest.frames[current].timeSeconds) / span)) : 0 };
}

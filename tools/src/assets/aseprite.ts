import { Unzlib } from "fflate";

export const ASEPRITE_FILE_MAGIC = 0xa5e0;
export const ASEPRITE_FRAME_MAGIC = 0xf1fa;
export const ASEPRITE_ATLAS_MODEL = "zvibe-aseprite-atlas-v1";
export const ASEPRITE_IMPORTER_MODEL = "bounded-native-aseprite-importer-v1";
export const ASEPRITE_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const ASEPRITE_MAX_DECODED_CEL_BYTES = 512 * 1024 * 1024;
export const ASEPRITE_MAX_FRAMES = 10_000;
export const ASEPRITE_MAX_LAYERS = 4096;
export const ASEPRITE_MAX_CELS = 200_000;
export const ASEPRITE_MAX_TILESET_TILES = 65_536;
export const ASEPRITE_MAX_DIMENSION = 32_768;
export const ASEPRITE_MAX_FRAME_PIXELS = 64 * 1024 * 1024;
export const ASEPRITE_MAX_RENDERED_PIXELS = 256 * 1024 * 1024;
export const ASEPRITE_MAX_PALETTE_ENTRIES = 4 * 1024 * 1024;
export const ASEPRITE_MAX_LAYER_DEPTH = 128;
export const ASEPRITE_MAX_ATLAS_SIZE = 8192;

export type AsepriteColorDepth = 8 | 16 | 32;
export type AsepriteLayerType = "image" | "group" | "tilemap";
export type AsepriteCelType = "raw" | "linked" | "compressed" | "tilemap";
export type AsepriteTagDirection = "forward" | "reverse" | "pingpong" | "pingpong_reverse";
export type AsepriteLayerMode = "composite" | "compositeAndLayers";
export type AsepritePivotMode = "sliceOrCenter" | "center" | "topLeft";

export interface IAsepriteImporterSettings {
	includeHiddenLayers: boolean;
	layerMode: AsepriteLayerMode;
	trimSprites: boolean;
	ignoreEmptyFrames: boolean;
	mergeDuplicates: boolean;
	padding: number;
	extrude: number;
	powerOfTwo: boolean;
	maximumAtlasSize: number;
	importTags: boolean;
	importSlices: boolean;
	pivotMode: AsepritePivotMode;
	pixelsPerUnit: number;
}

export interface IAsepriteUserData {
	text?: string;
	color?: [number, number, number, number];
}

export interface IAsepriteLayer {
	index: number;
	name: string;
	type: AsepriteLayerType;
	childLevel: number;
	parentIndex: number | null;
	visible: boolean;
	editable: boolean;
	locked: boolean;
	background: boolean;
	reference: boolean;
	collapsed: boolean;
	blendMode: string;
	blendModeCode: number;
	effectiveBlendModeCode: number;
	opacity: number;
	tilesetIndex: number | null;
	uuid: string | null;
	userData?: IAsepriteUserData;
}

export interface IAsepriteCel {
	frameIndex: number;
	layerIndex: number;
	x: number;
	y: number;
	opacity: number;
	zIndex: number;
	type: AsepriteCelType;
	linkedFrame: number | null;
	width: number;
	height: number;
	pixels: Uint8Array | null;
	tiles: Uint8Array | null;
	tileBitDepth: 8 | 16 | 32 | null;
	tileIdMask: number;
	tileXFlipMask: number;
	tileYFlipMask: number;
	tileDiagonalFlipMask: number;
	preciseBounds: { x: number; y: number; width: number; height: number } | null;
	userData?: IAsepriteUserData;
}

export interface IAsepriteExternalFile {
	id: number;
	type: "palette" | "tileset" | "extension" | "tileManagement" | "unknown";
	name: string;
}

export interface IAsepriteTileset {
	index: number;
	id: number;
	flags: number;
	tileCount: number;
	tileWidth: number;
	tileHeight: number;
	baseIndex: number;
	name: string;
	externalFileId: number | null;
	externalTilesetId: number | null;
	pixels: Uint8Array | null;
	pixelColorDepth: AsepriteColorDepth;
	transparentPaletteIndex: number;
	palette: Array<[number, number, number, number]> | null;
	boundExternal: boolean;
	userData?: IAsepriteUserData;
	tileUserData: Array<IAsepriteUserData | null>;
}

export interface IAsepriteFrame {
	index: number;
	durationMs: number;
	cels: IAsepriteCel[];
	palette: Array<[number, number, number, number]>;
}

export interface IAsepriteTag {
	name: string;
	from: number;
	to: number;
	direction: AsepriteTagDirection;
	repeat: number;
	color: [number, number, number, number];
	userData?: IAsepriteUserData;
}

export interface IAsepriteSliceKey {
	frame: number;
	bounds: { x: number; y: number; width: number; height: number };
	center: { x: number; y: number; width: number; height: number } | null;
	pivot: { x: number; y: number } | null;
}

export interface IAsepriteSlice {
	name: string;
	ninePatch: boolean;
	hasPivot: boolean;
	keys: IAsepriteSliceKey[];
	userData?: IAsepriteUserData;
}

export interface IAsepriteDocument {
	width: number;
	height: number;
	colorDepth: AsepriteColorDepth;
	transparentPaletteIndex: number;
	pixelRatio: { width: number; height: number };
	grid: { x: number; y: number; width: number; height: number };
	headerFlags: number;
	userData?: IAsepriteUserData;
	layers: IAsepriteLayer[];
	externalFiles: IAsepriteExternalFile[];
	tilesets: IAsepriteTileset[];
	frames: IAsepriteFrame[];
	tags: IAsepriteTag[];
	slices: IAsepriteSlice[];
	colorProfile: { type: "none" | "srgb" | "icc"; gamma: number | null; iccBytes: number };
	warnings: string[];
	statistics: {
		chunkCount: number;
		celCount: number;
		rawCelCount: number;
		compressedCelCount: number;
		linkedCelCount: number;
		tilemapCelCount: number;
		embeddedTilesetCount: number;
		externalTilesetCount: number;
		boundExternalTilesetCount: number;
		decodedCelBytes: number;
		decodedTilesetBytes: number;
		unknownChunkCount: number;
	};
}

export interface IAsepriteAtlasFrame {
	name: string;
	frameIndex: number;
	layerIndex: number | null;
	durationMs: number;
	frame: { x: number; y: number; w: number; h: number };
	rotated: false;
	trimmed: boolean;
	empty: boolean;
	spriteSourceSize: { x: number; y: number; w: number; h: number };
	sourceSize: { w: number; h: number };
	pivot: { x: number; y: number };
}

export interface IAsepriteAtlas {
	model: typeof ASEPRITE_ATLAS_MODEL;
	width: number;
	height: number;
	pixels: Uint8Array;
	frames: IAsepriteAtlasFrame[];
	frameTags: IAsepriteTag[];
	slices: IAsepriteSlice[];
	layers: IAsepriteLayer[];
	settings: IAsepriteImporterSettings;
	statistics: {
		entryCount: number;
		compositeEntryCount: number;
		layerEntryCount: number;
		emptyEntryCount: number;
		mergedDuplicateCount: number;
		atlasBytes: number;
		occupancy: number;
	};
}

export interface IAsepriteDocumentSummary {
	width: number;
	height: number;
	colorDepth: number;
	frameCount: number;
	frameDurationsMs: number[];
	celUserData: Array<{ frameIndex: number; layerIndex: number; text?: string; color?: [number, number, number, number] }>;
	layers: IAsepriteDocument["layers"];
	externalFiles: IAsepriteDocument["externalFiles"];
	tilesets: Array<Omit<IAsepriteDocument["tilesets"][number], "pixels" | "palette"> & { pixelBytes: number; paletteEntries: number }>;
	tags: IAsepriteDocument["tags"];
	slices: IAsepriteDocument["slices"];
	colorProfile: IAsepriteDocument["colorProfile"];
	pixelRatio: IAsepriteDocument["pixelRatio"];
	grid: IAsepriteDocument["grid"];
	warnings: string[];
	statistics: IAsepriteDocument["statistics"];
}

export interface IAsepriteAtlasDependencyEvidence {
	ownerPath: string;
	externalFileId: number;
	declaredName: string;
	path: string;
	sourceBytes: number;
	sourceSha256: string;
	tilesetIds: number[];
}

export interface IAsepriteExternalTilesetBinding {
	externalFileId: number;
	document: IAsepriteDocument;
}

const defaultSettings: IAsepriteImporterSettings = {
	includeHiddenLayers: false,
	layerMode: "composite",
	trimSprites: true,
	ignoreEmptyFrames: false,
	mergeDuplicates: true,
	padding: 2,
	extrude: 1,
	powerOfTwo: true,
	maximumAtlasSize: 4096,
	importTags: true,
	importSlices: true,
	pivotMode: "sliceOrCenter",
	pixelsPerUnit: 100,
};

const layerTypes = new Map<number, AsepriteLayerType>([
	[0, "image"],
	[1, "group"],
	[2, "tilemap"],
]);
const celTypes = new Map<number, AsepriteCelType>([
	[0, "raw"],
	[1, "linked"],
	[2, "compressed"],
	[3, "tilemap"],
]);
const tagDirections = new Map<number, AsepriteTagDirection>([
	[0, "forward"],
	[1, "reverse"],
	[2, "pingpong"],
	[3, "pingpong_reverse"],
]);
const externalFileTypes = new Map<number, IAsepriteExternalFile["type"]>([
	[0, "palette"],
	[1, "tileset"],
	[2, "extension"],
	[3, "tileManagement"],
]);
const blendModeNames = [
	"normal",
	"multiply",
	"screen",
	"overlay",
	"darken",
	"lighten",
	"colorDodge",
	"colorBurn",
	"hardLight",
	"softLight",
	"difference",
	"exclusion",
	"hue",
	"saturation",
	"color",
	"luminosity",
	"addition",
	"subtract",
	"divide",
];

class Reader {
	public offset: number;
	public readonly end: number;
	private readonly _bytes: Uint8Array;
	private readonly _view: DataView;

	public constructor(bytes: Uint8Array, offset = 0, end = bytes.byteLength) {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end > bytes.byteLength) {
			throw new Error("Aseprite reader bounds are invalid.");
		}
		this._bytes = bytes;
		this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.offset = offset;
		this.end = end;
	}

	public remaining(): number {
		return this.end - this.offset;
	}

	public skip(count: number): void {
		this._require(count);
		this.offset += count;
	}

	public u8(): number {
		this._require(1);
		return this._view.getUint8(this.offset++);
	}

	public u16(): number {
		this._require(2);
		const value = this._view.getUint16(this.offset, true);
		this.offset += 2;
		return value;
	}

	public i16(): number {
		this._require(2);
		const value = this._view.getInt16(this.offset, true);
		this.offset += 2;
		return value;
	}

	public u32(): number {
		this._require(4);
		const value = this._view.getUint32(this.offset, true);
		this.offset += 4;
		return value;
	}

	public i32(): number {
		this._require(4);
		const value = this._view.getInt32(this.offset, true);
		this.offset += 4;
		return value;
	}

	public fixed(): number {
		return this.i32() / 65_536;
	}

	public bytes(count: number): Uint8Array {
		this._require(count);
		const value = this._bytes.subarray(this.offset, this.offset + count);
		this.offset += count;
		return value;
	}

	public string(): string {
		const length = this.u16();
		if (length > 4096) {
			throw new Error(`Aseprite string length ${length} exceeds the bounded 4,096-byte limit.`);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(length));
	}

	public subreader(end: number): Reader {
		if (end < this.offset || end > this.end) {
			throw new Error("Aseprite chunk exceeds its containing frame.");
		}
		return new Reader(this._bytes, this.offset, end);
	}

	private _require(count: number): void {
		if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.end) {
			throw new Error(`Aseprite data is truncated at byte ${this.offset}; ${count} byte(s) were required.`);
		}
	}
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

function bool(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function enumeration<T extends string>(value: unknown, label: string, values: readonly T[]): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

/** Normalizes the complete bounded Aseprite authoring/build contract. */
export function normalizeAsepriteImporterSettings(value: unknown): IAsepriteImporterSettings {
	const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const result: IAsepriteImporterSettings = {
		includeHiddenLayers: bool(source.includeHiddenLayers ?? defaultSettings.includeHiddenLayers, "Aseprite includeHiddenLayers"),
		layerMode: enumeration(source.layerMode ?? defaultSettings.layerMode, "Aseprite layerMode", ["composite", "compositeAndLayers"] as const),
		trimSprites: bool(source.trimSprites ?? defaultSettings.trimSprites, "Aseprite trimSprites"),
		ignoreEmptyFrames: bool(source.ignoreEmptyFrames ?? defaultSettings.ignoreEmptyFrames, "Aseprite ignoreEmptyFrames"),
		mergeDuplicates: bool(source.mergeDuplicates ?? defaultSettings.mergeDuplicates, "Aseprite mergeDuplicates"),
		padding: integer(source.padding ?? defaultSettings.padding, "Aseprite padding", 0, 32),
		extrude: integer(source.extrude ?? defaultSettings.extrude, "Aseprite extrude", 0, 16),
		powerOfTwo: bool(source.powerOfTwo ?? defaultSettings.powerOfTwo, "Aseprite powerOfTwo"),
		maximumAtlasSize: integer(source.maximumAtlasSize ?? defaultSettings.maximumAtlasSize, "Aseprite maximumAtlasSize", 64, ASEPRITE_MAX_ATLAS_SIZE),
		importTags: bool(source.importTags ?? defaultSettings.importTags, "Aseprite importTags"),
		importSlices: bool(source.importSlices ?? defaultSettings.importSlices, "Aseprite importSlices"),
		pivotMode: enumeration(source.pivotMode ?? defaultSettings.pivotMode, "Aseprite pivotMode", ["sliceOrCenter", "center", "topLeft"] as const),
		pixelsPerUnit: finite(source.pixelsPerUnit ?? defaultSettings.pixelsPerUnit, "Aseprite pixelsPerUnit", 0.01, 100_000),
	};
	if (result.extrude > result.padding && result.padding > 0) {
		throw new Error("Aseprite extrude cannot exceed padding; increase padding or reduce extrusion.");
	}
	if (result.powerOfTwo && (result.maximumAtlasSize & (result.maximumAtlasSize - 1)) !== 0) {
		throw new Error("Aseprite Maximum Atlas Size must be a power of two when Power Of Two packing is enabled.");
	}
	return result;
}

function rgbaPalette(size = 256): Array<[number, number, number, number]> {
	return Array.from({ length: size }, () => [0, 0, 0, 255] as [number, number, number, number]);
}

function uuid(bytes: Uint8Array): string {
	const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeUserData(reader: Reader): IAsepriteUserData {
	const flags = reader.u32();
	const result: IAsepriteUserData = {};
	if (flags & 1) {
		result.text = reader.string();
	}
	if (flags & 2) {
		result.color = [reader.u8(), reader.u8(), reader.u8(), reader.u8()];
	}
	// Extended property maps are intentionally retained as an opaque, bounded skipped tail.
	return result;
}

/** Streams zlib output into an exact-size buffer so malformed input cannot grow past its declared budget. */
function inflateExact(reader: Reader, expected: number, label: string): Uint8Array {
	if (!Number.isSafeInteger(expected) || expected < 0 || expected > ASEPRITE_MAX_DECODED_CEL_BYTES) {
		throw new Error(`${label} requires an invalid or over-limit ${expected}-byte output.`);
	}
	const compressedBytes = new Uint8Array(reader.bytes(reader.remaining()));
	let output: Uint8Array;
	try {
		output = new Uint8Array(expected);
		let offset = 0;
		let completed = false;
		const decoder = new Unzlib((chunk, final) => {
			if (offset + chunk.byteLength > expected) {
				throw new Error(`decoded pixels exceed the declared ${expected} bytes`);
			}
			output.set(chunk, offset);
			offset += chunk.byteLength;
			completed = final;
		});
		for (let start = 0; start < compressedBytes.byteLength; start += 16 * 1024) {
			const end = Math.min(compressedBytes.byteLength, start + 16 * 1024);
			decoder.push(compressedBytes.subarray(start, end), end === compressedBytes.byteLength);
		}
		if (!completed || offset !== expected) {
			throw new Error(`decoded ${offset} bytes; ${expected} were required`);
		}
	} catch (error) {
		throw new Error(`${label} could not be inflated: ${error instanceof Error ? error.message : String(error)}`);
	}
	return output;
}

function decodeCelPixels(reader: Reader, width: number, height: number, colorDepth: AsepriteColorDepth, compressed: boolean): Uint8Array {
	if (!width || !height || width > ASEPRITE_MAX_DIMENSION || height > ASEPRITE_MAX_DIMENSION || width * height > ASEPRITE_MAX_FRAME_PIXELS) {
		throw new Error(`Aseprite cel dimensions ${width}×${height} exceed the bounded frame limits.`);
	}
	const bytesPerPixel = colorDepth / 8;
	const expected = width * height * bytesPerPixel;
	if (!compressed) {
		if (reader.remaining() !== expected) {
			throw new Error(`Aseprite raw cel requires exactly ${expected} pixel bytes, found ${reader.remaining()}.`);
		}
		return new Uint8Array(reader.bytes(expected));
	}
	return inflateExact(reader, expected, "Aseprite compressed cel");
}

function parseOldPalette(reader: Reader, palette: Array<[number, number, number, number]>, sixBit: boolean): void {
	const packets = reader.u16();
	let index = 0;
	for (let packet = 0; packet < packets; packet++) {
		index += reader.u8();
		const countByte = reader.u8();
		const count = countByte || 256;
		if (index + count > 4096) {
			throw new Error("Aseprite legacy palette exceeds 4,096 entries.");
		}
		while (palette.length < index + count) {
			palette.push([0, 0, 0, 255]);
		}
		for (let color = 0; color < count; color++) {
			const scale = sixBit ? 255 / 63 : 1;
			palette[index++] = [Math.round(reader.u8() * scale), Math.round(reader.u8() * scale), Math.round(reader.u8() * scale), 255];
		}
	}
}

function parsePalette(reader: Reader, palette: Array<[number, number, number, number]>): void {
	const size = reader.u32();
	const first = reader.u32();
	const last = reader.u32();
	reader.skip(8);
	if (size > 4096 || first > last || last >= size || last - first + 1 > 4096) {
		throw new Error("Aseprite palette range is invalid or exceeds 4,096 entries.");
	}
	while (palette.length < size) {
		palette.push([0, 0, 0, 255]);
	}
	palette.length = size;
	for (let index = first; index <= last; index++) {
		const flags = reader.u16();
		palette[index] = [reader.u8(), reader.u8(), reader.u8(), reader.u8()];
		if (flags & 1) {
			reader.string();
		}
	}
}

function parseTags(reader: Reader): IAsepriteTag[] {
	const count = reader.u16();
	if (count > 4096) {
		throw new Error("Aseprite tag count exceeds 4,096.");
	}
	reader.skip(8);
	const result: IAsepriteTag[] = [];
	for (let index = 0; index < count; index++) {
		const from = reader.u16();
		const to = reader.u16();
		const directionCode = reader.u8();
		const direction = tagDirections.get(directionCode);
		if (!direction || to < from) {
			throw new Error(`Aseprite tag ${index} has an invalid frame range or direction.`);
		}
		const repeat = reader.u16();
		reader.skip(6);
		const color: [number, number, number, number] = [reader.u8(), reader.u8(), reader.u8(), 255];
		reader.skip(1);
		result.push({ name: reader.string(), from, to, direction, repeat, color });
	}
	return result;
}

function parseSlice(reader: Reader): IAsepriteSlice {
	const count = reader.u32();
	const flags = reader.u32();
	reader.skip(4);
	if (count > 10_000) {
		throw new Error("Aseprite slice key count exceeds 10,000.");
	}
	const name = reader.string();
	const keys: IAsepriteSliceKey[] = [];
	for (let index = 0; index < count; index++) {
		const frame = reader.u32();
		const bounds = { x: reader.i32(), y: reader.i32(), width: reader.u32(), height: reader.u32() };
		const center = flags & 1 ? { x: reader.i32(), y: reader.i32(), width: reader.u32(), height: reader.u32() } : null;
		const pivot = flags & 2 ? { x: reader.i32(), y: reader.i32() } : null;
		keys.push({ frame, bounds, center, pivot });
	}
	return { name, ninePatch: Boolean(flags & 1), hasPivot: Boolean(flags & 2), keys };
}

/** Reads the bounded external dependency table used by linked palettes, tilesets, and extensions. */
function parseExternalFiles(reader: Reader): IAsepriteExternalFile[] {
	const count = reader.u32();
	if (count > 4096) {
		throw new Error("Aseprite external-file count exceeds 4,096.");
	}
	reader.skip(8);
	const result: IAsepriteExternalFile[] = [];
	for (let index = 0; index < count; index++) {
		const id = reader.u32();
		const typeCode = reader.u8();
		reader.skip(7);
		result.push({ id, type: externalFileTypes.get(typeCode) ?? "unknown", name: reader.string() });
	}
	return result;
}

interface IAsepriteTilesetPixelSource {
	colorDepth: AsepriteColorDepth;
	transparentPaletteIndex: number;
	palette: Array<[number, number, number, number]>;
}

/** Decodes one embedded or externally linked tileset while enforcing document-wide tile and byte budgets before allocation. */
function parseTileset(reader: Reader, index: number, pixelSource: IAsepriteTilesetPixelSource, remainingTiles: number, remainingDecodedBytes: number): IAsepriteTileset {
	const id = reader.u32();
	const flags = reader.u32();
	const tileCount = reader.u32();
	const tileWidth = reader.u16();
	const tileHeight = reader.u16();
	const baseIndex = reader.i16();
	reader.skip(14);
	const name = reader.string();
	if (!tileCount || tileCount > remainingTiles || !tileWidth || !tileHeight || tileWidth > ASEPRITE_MAX_DIMENSION || tileHeight > ASEPRITE_MAX_DIMENSION) {
		throw new Error(`Aseprite tileset "${name}" has invalid or over-limit dimensions/count.`);
	}
	const externalFileId = flags & 1 ? reader.u32() : null;
	const externalTilesetId = flags & 1 ? reader.u32() : null;
	if (!(flags & 3)) {
		throw new Error(`Aseprite tileset "${name}" has neither embedded pixels nor an external link.`);
	}
	let pixels: Uint8Array | null = null;
	if (flags & 2) {
		const compressedBytes = reader.u32();
		const compressed = reader.bytes(compressedBytes);
		const expected = tileWidth * tileHeight * tileCount * (pixelSource.colorDepth / 8);
		if (expected > remainingDecodedBytes) {
			throw new Error(`Aseprite tileset "${name}" exceeds the remaining bounded decoded-byte budget.`);
		}
		pixels = inflateExact(new Reader(compressed), expected, `Aseprite tileset "${name}"`);
	}
	return {
		index,
		id,
		flags,
		tileCount,
		tileWidth,
		tileHeight,
		baseIndex,
		name,
		externalFileId,
		externalTilesetId,
		pixels,
		pixelColorDepth: pixelSource.colorDepth,
		transparentPaletteIndex: pixelSource.transparentPaletteIndex,
		palette: pixelSource.colorDepth === 8 && pixels ? pixelSource.palette.map((entry) => [...entry] as [number, number, number, number]) : null,
		boundExternal: false,
		tileUserData: Array.from({ length: tileCount }, () => null),
	};
}

/** Keeps little-endian tile words in their compact encoded width; rendering reads them without a second full-size allocation. */
function decodeTileValues(reader: Reader, width: number, height: number, bitDepth: number): Uint8Array {
	if (![8, 16, 32].includes(bitDepth) || !width || !height || width > ASEPRITE_MAX_DIMENSION || height > ASEPRITE_MAX_DIMENSION || width * height > ASEPRITE_MAX_FRAME_PIXELS) {
		throw new Error(`Aseprite tilemap dimensions ${width}×${height} or ${bitDepth}-bit tile values are invalid.`);
	}
	return inflateExact(reader, width * height * (bitDepth / 8), "Aseprite compressed tilemap cel");
}

/** Parses one `.ase`/`.aseprite` file without external executables or unbounded allocation. */
export function parseAseprite(bytes: Uint8Array): IAsepriteDocument {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < 128 || bytes.byteLength > ASEPRITE_MAX_SOURCE_BYTES) {
		throw new Error(`Aseprite source must contain 128 bytes through ${ASEPRITE_MAX_SOURCE_BYTES} bytes.`);
	}
	const reader = new Reader(bytes);
	const declaredBytes = reader.u32();
	if (declaredBytes !== bytes.byteLength) {
		throw new Error(`Aseprite header declares ${declaredBytes} bytes, but the source contains ${bytes.byteLength}.`);
	}
	if (reader.u16() !== ASEPRITE_FILE_MAGIC) {
		throw new Error("Aseprite file magic is invalid; expected 0xA5E0.");
	}
	const frameCount = reader.u16();
	const width = reader.u16();
	const height = reader.u16();
	const colorDepth = reader.u16() as AsepriteColorDepth;
	if (!frameCount || frameCount > ASEPRITE_MAX_FRAMES) {
		throw new Error(`Aseprite frame count must be 1-${ASEPRITE_MAX_FRAMES}.`);
	}
	if (!width || !height || width > ASEPRITE_MAX_DIMENSION || height > ASEPRITE_MAX_DIMENSION || width * height > ASEPRITE_MAX_FRAME_PIXELS) {
		throw new Error(`Aseprite canvas dimensions ${width}×${height} exceed the bounded frame limits.`);
	}
	if (![8, 16, 32].includes(colorDepth)) {
		throw new Error(`Unsupported Aseprite color depth ${colorDepth}; expected indexed 8-bit, grayscale 16-bit, or RGBA 32-bit.`);
	}
	const headerFlags = reader.u32();
	const fallbackDuration = reader.u16();
	reader.skip(8);
	const transparentPaletteIndex = reader.u8();
	reader.skip(3);
	const paletteSize = reader.u16() || 256;
	const pixelWidth = reader.u8() || 1;
	const pixelHeight = reader.u8() || 1;
	const grid = { x: reader.i16(), y: reader.i16(), width: reader.u16(), height: reader.u16() };
	reader.skip(84);

	let palette = rgbaPalette(Math.min(4096, paletteSize));
	const layers: IAsepriteLayer[] = [];
	const externalFiles: IAsepriteExternalFile[] = [];
	const tilesets: IAsepriteTileset[] = [];
	const frames: IAsepriteFrame[] = [];
	const tags: IAsepriteTag[] = [];
	const slices: IAsepriteSlice[] = [];
	const warnings = new Set<string>();
	let colorProfile: IAsepriteDocument["colorProfile"] = { type: "none", gamma: null, iccBytes: 0 };
	let chunkCount = 0;
	let celCount = 0;
	let decodedCelBytes = 0;
	let decodedTilesetBytes = 0;
	let tilesetTileCount = 0;
	let rawCelCount = 0;
	let compressedCelCount = 0;
	let linkedCelCount = 0;
	let tilemapCelCount = 0;
	let unknownChunkCount = 0;
	let paletteEntryCount = 0;
	let spriteUserData: IAsepriteUserData | undefined;
	let lastTarget: { userData?: IAsepriteUserData } | null = null;
	let pendingUserDataTargets: Array<{ apply: (value: IAsepriteUserData) => void }> = [];
	let pendingTilesetUserData: { tileset: IAsepriteTileset; tileIndex: number } | null = null;

	for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
		const frameStart = reader.offset;
		const frameBytes = reader.u32();
		const frameEnd = frameStart + frameBytes;
		if (frameBytes < 16 || frameEnd > bytes.byteLength || reader.u16() !== ASEPRITE_FRAME_MAGIC) {
			throw new Error(`Aseprite frame ${frameIndex} header is invalid.`);
		}
		const oldChunkCount = reader.u16();
		const durationMs = reader.u16() || fallbackDuration || 100;
		reader.skip(2);
		const newChunkCount = reader.u32();
		const expectedChunks = newChunkCount || oldChunkCount;
		if (expectedChunks > 100_000) {
			throw new Error(`Aseprite frame ${frameIndex} exceeds the bounded 100,000-chunk limit.`);
		}
		const cels: IAsepriteCel[] = [];
		let latestCel: IAsepriteCel | null = null;
		for (let chunkIndex = 0; chunkIndex < expectedChunks; chunkIndex++) {
			chunkCount++;
			if (chunkCount > 1_000_000) {
				throw new Error("Aseprite document exceeds the bounded 1,000,000-chunk limit.");
			}
			const chunkStart = reader.offset;
			const chunkBytes = reader.u32();
			const chunkEnd = chunkStart + chunkBytes;
			const type = reader.u16();
			if (chunkBytes < 6 || chunkEnd > frameEnd) {
				throw new Error(`Aseprite frame ${frameIndex} chunk ${chunkIndex} has invalid bounds.`);
			}
			const chunk = reader.subreader(chunkEnd);
			if (type !== 0x2020 && pendingUserDataTargets.length) {
				pendingUserDataTargets = [];
			}
			if (type !== 0x2020) {
				pendingTilesetUserData = null;
			}
			switch (type) {
				case 0x0004:
					parseOldPalette(chunk, palette, false);
					lastTarget = null;
					break;
				case 0x0011:
					parseOldPalette(chunk, palette, true);
					lastTarget = null;
					break;
				case 0x2004: {
					if (layers.length >= ASEPRITE_MAX_LAYERS) {
						throw new Error(`Aseprite layer count exceeds ${ASEPRITE_MAX_LAYERS}.`);
					}
					const flags = chunk.u16();
					const layerTypeCode = chunk.u16();
					const layerType = layerTypes.get(layerTypeCode);
					if (!layerType) {
						throw new Error(`Unsupported Aseprite layer type ${layerTypeCode}.`);
					}
					const childLevel = chunk.u16();
					if (childLevel > ASEPRITE_MAX_LAYER_DEPTH) {
						throw new Error(`Aseprite layer ${layers.length} exceeds the bounded nesting depth ${ASEPRITE_MAX_LAYER_DEPTH}.`);
					}
					chunk.skip(4);
					const blendModeCode = chunk.u16();
					const opacity = chunk.u8();
					chunk.skip(3);
					const name = chunk.string();
					const tilesetIndex = layerType === "tilemap" ? chunk.u32() : null;
					const layerUuid = headerFlags & 4 ? uuid(chunk.bytes(16)) : null;
					let parentIndex: number | null = null;
					if (childLevel > 0) {
						for (let index = layers.length - 1; index >= 0; index--) {
							if (layers[index].childLevel === childLevel - 1) {
								parentIndex = index;
								break;
							}
						}
						if (parentIndex === null || layers[parentIndex].type !== "group") {
							throw new Error(`Aseprite layer "${name}" has an invalid child level ${childLevel}.`);
						}
					}
					const layer: IAsepriteLayer = {
						index: layers.length,
						name,
						type: layerType,
						childLevel,
						parentIndex,
						visible: Boolean(flags & 1),
						editable: Boolean(flags & 2),
						locked: Boolean(flags & 4),
						background: Boolean(flags & 8),
						collapsed: Boolean(flags & 32),
						reference: Boolean(flags & 64),
						blendMode: blendModeNames[blendModeCode] ?? `unsupported-${blendModeCode}`,
						blendModeCode,
						effectiveBlendModeCode: flags & 8 || (layerType === "group" && !(headerFlags & 2)) ? 0 : blendModeCode,
						opacity: !(flags & 8) && headerFlags & 1 && (layerType !== "group" || headerFlags & 2) ? opacity : 255,
						tilesetIndex,
						uuid: layerUuid,
					};
					if (blendModeCode >= blendModeNames.length) {
						warnings.add(`Layer "${name}" uses unsupported blend mode ${blendModeCode}; normal compositing is used.`);
					}
					layers.push(layer);
					lastTarget = layer;
					break;
				}
				case 0x2005: {
					celCount++;
					if (celCount > ASEPRITE_MAX_CELS) {
						throw new Error(`Aseprite cel count exceeds ${ASEPRITE_MAX_CELS}.`);
					}
					const layerIndex = chunk.u16();
					if (!layers[layerIndex]) {
						throw new Error(`Aseprite cel references missing layer ${layerIndex}.`);
					}
					const x = chunk.i16();
					const y = chunk.i16();
					const opacity = chunk.u8();
					const celTypeCode = chunk.u16();
					const celType = celTypes.get(celTypeCode);
					if (!celType) {
						throw new Error(`Unsupported Aseprite cel type ${celTypeCode}.`);
					}
					const zIndex = chunk.i16();
					chunk.skip(5);
					let linkedFrame: number | null = null;
					let celWidth = 0;
					let celHeight = 0;
					let pixels: Uint8Array | null = null;
					let tiles: Uint8Array | null = null;
					let tileBitDepth: 8 | 16 | 32 | null = null;
					let tileIdMask = 0;
					let tileXFlipMask = 0;
					let tileYFlipMask = 0;
					let tileDiagonalFlipMask = 0;
					if (celType === "linked") {
						linkedFrame = chunk.u16();
						if (linkedFrame >= frameIndex) {
							throw new Error(`Aseprite linked cel in frame ${frameIndex} must reference an earlier frame.`);
						}
						linkedCelCount++;
					} else if (celType === "raw" || celType === "compressed") {
						celWidth = chunk.u16();
						celHeight = chunk.u16();
						const expected = celWidth * celHeight * (colorDepth / 8);
						if (decodedCelBytes + decodedTilesetBytes + expected > ASEPRITE_MAX_DECODED_CEL_BYTES) {
							throw new Error(`Aseprite decoded image data exceeds ${ASEPRITE_MAX_DECODED_CEL_BYTES} bytes.`);
						}
						pixels = decodeCelPixels(chunk, celWidth, celHeight, colorDepth, celType === "compressed");
						decodedCelBytes += pixels.byteLength;
						if (decodedCelBytes > ASEPRITE_MAX_DECODED_CEL_BYTES) {
							throw new Error(`Aseprite decoded cel bytes exceed ${ASEPRITE_MAX_DECODED_CEL_BYTES}.`);
						}
						celType === "raw" ? rawCelCount++ : compressedCelCount++;
					} else {
						if (layers[layerIndex].type !== "tilemap") {
							throw new Error(`Aseprite tilemap cel references non-tilemap layer ${layerIndex}.`);
						}
						celWidth = chunk.u16();
						celHeight = chunk.u16();
						tileBitDepth = chunk.u16() as 8 | 16 | 32;
						tileIdMask = chunk.u32();
						tileXFlipMask = chunk.u32();
						tileYFlipMask = chunk.u32();
						tileDiagonalFlipMask = chunk.u32();
						chunk.skip(10);
						const expected = celWidth * celHeight * (tileBitDepth / 8);
						if (decodedCelBytes + decodedTilesetBytes + expected > ASEPRITE_MAX_DECODED_CEL_BYTES) {
							throw new Error(`Aseprite decoded tilemap data exceeds ${ASEPRITE_MAX_DECODED_CEL_BYTES} bytes.`);
						}
						const allowedMask = tileBitDepth === 32 ? 0xffffffff : 2 ** tileBitDepth - 1;
						const masks = [tileIdMask, tileXFlipMask, tileYFlipMask, tileDiagonalFlipMask].map((value) => value >>> 0);
						if (
							![8, 16, 32].includes(tileBitDepth) ||
							!tileIdMask ||
							masks.some((mask) => (mask & (~allowedMask >>> 0)) !== 0) ||
							(masks[0] & (masks[1] | masks[2] | masks[3])) !== 0 ||
							(masks[1] & masks[2]) !== 0 ||
							(masks[1] & masks[3]) !== 0 ||
							(masks[2] & masks[3]) !== 0
						) {
							throw new Error(`Aseprite tilemap cel in frame ${frameIndex} has invalid or overlapping tile masks.`);
						}
						tiles = decodeTileValues(chunk, celWidth, celHeight, tileBitDepth);
						decodedCelBytes += tiles.byteLength;
						tilemapCelCount++;
					}
					if (decodedCelBytes > ASEPRITE_MAX_DECODED_CEL_BYTES) {
						throw new Error(`Aseprite decoded cel bytes exceed ${ASEPRITE_MAX_DECODED_CEL_BYTES}.`);
					}
					const cel: IAsepriteCel = {
						frameIndex,
						layerIndex,
						x,
						y,
						opacity,
						zIndex,
						type: celType,
						linkedFrame,
						width: celWidth,
						height: celHeight,
						pixels,
						tiles,
						tileBitDepth,
						tileIdMask,
						tileXFlipMask,
						tileYFlipMask,
						tileDiagonalFlipMask,
						preciseBounds: null,
					};
					cels.push(cel);
					latestCel = cel;
					lastTarget = cel;
					break;
				}
				case 0x2006:
					if (!latestCel) {
						throw new Error("Aseprite cel-extra chunk has no preceding cel.");
					}
					const celExtraFlags = chunk.u32();
					const preciseBounds = { x: chunk.fixed(), y: chunk.fixed(), width: chunk.fixed(), height: chunk.fixed() };
					chunk.skip(16);
					if (celExtraFlags & 1 && (preciseBounds.width <= 0 || preciseBounds.height <= 0)) {
						throw new Error("Aseprite precise cel bounds require positive width and height.");
					}
					latestCel.preciseBounds = celExtraFlags & 1 ? preciseBounds : null;
					lastTarget = latestCel;
					break;
				case 0x2007: {
					const profileType = chunk.u16();
					const profileFlags = chunk.u16();
					const gamma = chunk.fixed();
					chunk.skip(8);
					let iccBytes = 0;
					if (profileType === 2) {
						iccBytes = chunk.u32();
						chunk.skip(iccBytes);
					}
					colorProfile = { type: profileType === 1 ? "srgb" : profileType === 2 ? "icc" : "none", gamma: profileFlags & 1 ? gamma : null, iccBytes };
					lastTarget = null;
					break;
				}
				case 0x2008: {
					const parsed = parseExternalFiles(chunk);
					for (const entry of parsed) {
						if (externalFiles.length >= 4096) {
							throw new Error("Aseprite external-file count exceeds 4,096.");
						}
						if (externalFiles.some((candidate) => candidate.id === entry.id)) {
							throw new Error(`Aseprite external-file ID ${entry.id} is duplicated.`);
						}
						externalFiles.push(entry);
					}
					lastTarget = null;
					break;
				}
				case 0x2018: {
					const parsed = parseTags(chunk);
					if (tags.length + parsed.length > 4096) {
						throw new Error("Aseprite tag count exceeds 4,096.");
					}
					for (const tag of parsed) {
						if (tag.to >= frameCount) {
							throw new Error(`Aseprite tag "${tag.name}" references frame ${tag.to}, beyond ${frameCount - 1}.`);
						}
						tags.push(tag);
					}
					pendingUserDataTargets = parsed.map((tag) => ({ apply: (value) => (tag.userData = value) }));
					lastTarget = null;
					break;
				}
				case 0x2019:
					parsePalette(chunk, palette);
					if (frameIndex === 0) {
						pendingUserDataTargets = [{ apply: (value) => (spriteUserData = value) }];
					}
					lastTarget = null;
					break;
				case 0x2020: {
					const userData = decodeUserData(chunk);
					const pending = pendingUserDataTargets.shift();
					if (pending) {
						pending.apply(userData);
					} else if (pendingTilesetUserData) {
						if (pendingTilesetUserData.tileIndex < 0) {
							pendingTilesetUserData.tileset.userData = userData;
						} else if (pendingTilesetUserData.tileIndex < pendingTilesetUserData.tileset.tileCount) {
							pendingTilesetUserData.tileset.tileUserData[pendingTilesetUserData.tileIndex] = userData;
						}
						pendingTilesetUserData.tileIndex++;
						if (pendingTilesetUserData.tileIndex >= pendingTilesetUserData.tileset.tileCount) {
							pendingTilesetUserData = null;
						}
					} else if (lastTarget) {
						lastTarget.userData = userData;
						lastTarget = null;
					}
					break;
				}
				case 0x2022: {
					const slice = parseSlice(chunk);
					if (slices.length >= 4096) {
						throw new Error("Aseprite slice count exceeds 4,096.");
					}
					if (slice.keys.some((key) => key.frame >= frameCount)) {
						throw new Error(`Aseprite slice "${slice.name}" references a frame beyond ${frameCount - 1}.`);
					}
					slices.push(slice);
					lastTarget = slice;
					break;
				}
				case 0x2023: {
					if (tilesets.length >= 4096) {
						throw new Error("Aseprite tileset count exceeds 4,096.");
					}
					const tileset = parseTileset(
						chunk,
						tilesets.length,
						{ colorDepth, transparentPaletteIndex, palette },
						ASEPRITE_MAX_TILESET_TILES - tilesetTileCount,
						ASEPRITE_MAX_DECODED_CEL_BYTES - decodedCelBytes - decodedTilesetBytes
					);
					if (tilesets.some((candidate) => candidate.id === tileset.id)) {
						throw new Error(`Aseprite tileset ID ${tileset.id} is duplicated.`);
					}
					tilesets.push(tileset);
					tilesetTileCount += tileset.tileCount;
					decodedTilesetBytes += tileset.pixels?.byteLength ?? 0;
					if (!tileset.pixels) {
						warnings.add(`Tileset "${tileset.name}" references external content and cannot render until that dependency is embedded or bound.`);
					}
					pendingTilesetUserData = { tileset, tileIndex: -1 };
					lastTarget = null;
					break;
				}
				case 0x2016:
				case 0x2017:
					warnings.add(`Aseprite chunk 0x${type.toString(16)} is retained as skipped metadata and does not affect generated image frames.`);
					lastTarget = null;
					break;
				default:
					unknownChunkCount++;
					warnings.add(`Unknown Aseprite chunk 0x${type.toString(16)} was skipped safely.`);
					lastTarget = null;
					break;
			}
			reader.offset = chunkEnd;
		}
		reader.offset = frameEnd;
		paletteEntryCount += palette.length;
		if (paletteEntryCount > ASEPRITE_MAX_PALETTE_ENTRIES) {
			throw new Error(`Aseprite frame palette snapshots exceed ${ASEPRITE_MAX_PALETTE_ENTRIES} entries.`);
		}
		frames.push({ index: frameIndex, durationMs, cels, palette: palette.map((color) => [...color] as [number, number, number, number]) });
	}
	if (reader.offset !== bytes.byteLength) {
		throw new Error(`Aseprite parser ended at byte ${reader.offset}, expected ${bytes.byteLength}.`);
	}
	if (!layers.length) {
		throw new Error("Aseprite document contains no layers.");
	}
	for (const layer of layers) {
		if (layer.type === "tilemap" && (layer.tilesetIndex === null || !tilesets.some((entry) => entry.id === layer.tilesetIndex))) {
			throw new Error(`Aseprite tilemap layer "${layer.name}" references missing tileset ID ${layer.tilesetIndex ?? "none"}.`);
		}
	}
	for (const tileset of tilesets) {
		if (tileset.externalFileId !== null && !externalFiles.some((entry) => entry.id === tileset.externalFileId && entry.type === "tileset")) {
			throw new Error(`Aseprite tileset "${tileset.name}" references missing external tileset file ID ${tileset.externalFileId}.`);
		}
	}
	const maximumChildLevel = layers.reduce((maximum, layer) => Math.max(maximum, layer.childLevel), 0);
	const workingBuffers = headerFlags & 2 ? maximumChildLevel + 1 : 1;
	if (width * height * 4 * workingBuffers > ASEPRITE_MAX_DECODED_CEL_BYTES) {
		throw new Error("Aseprite nested group rendering would exceed the bounded working-memory budget.");
	}
	return {
		width,
		height,
		colorDepth,
		transparentPaletteIndex,
		pixelRatio: { width: pixelWidth, height: pixelHeight },
		grid,
		headerFlags,
		...(spriteUserData ? { userData: spriteUserData } : {}),
		layers,
		externalFiles,
		tilesets,
		frames,
		tags,
		slices,
		colorProfile,
		warnings: [...warnings],
		statistics: {
			chunkCount,
			celCount,
			rawCelCount,
			compressedCelCount,
			linkedCelCount,
			tilemapCelCount,
			embeddedTilesetCount: tilesets.filter((entry) => entry.pixels).length,
			externalTilesetCount: tilesets.filter((entry) => !entry.pixels).length,
			boundExternalTilesetCount: 0,
			decodedCelBytes,
			decodedTilesetBytes,
			unknownChunkCount,
		},
	};
}

/** Binds already parsed external tileset documents without allowing dimensions, IDs, or aggregate decoded bytes to drift from the source contract. */
export function bindAsepriteExternalTilesets(document: IAsepriteDocument, bindings: IAsepriteExternalTilesetBinding[]): number {
	const documents = new Map<number, IAsepriteDocument>();
	for (const binding of bindings) {
		if (!Number.isSafeInteger(binding.externalFileId) || binding.externalFileId < 0 || documents.has(binding.externalFileId)) {
			throw new Error(`Aseprite external tileset binding ID ${binding.externalFileId} is invalid or duplicated.`);
		}
		documents.set(binding.externalFileId, binding.document);
	}
	let bound = 0;
	let decodedBytes = document.statistics.decodedTilesetBytes;
	for (const tileset of document.tilesets) {
		if (tileset.pixels || tileset.externalFileId === null || tileset.externalTilesetId === null) {
			continue;
		}
		const dependency = documents.get(tileset.externalFileId);
		if (!dependency) {
			throw new Error(`Aseprite tileset "${tileset.name}" requires unresolved external file ID ${tileset.externalFileId}.`);
		}
		const source = dependency.tilesets.find((candidate) => candidate.id === tileset.externalTilesetId);
		if (!source?.pixels) {
			throw new Error(`Aseprite external file ID ${tileset.externalFileId} does not provide embedded tileset ID ${tileset.externalTilesetId}.`);
		}
		if (source.tileCount !== tileset.tileCount || source.tileWidth !== tileset.tileWidth || source.tileHeight !== tileset.tileHeight) {
			throw new Error(
				`Aseprite external tileset ID ${tileset.externalTilesetId} is ${source.tileCount}×${source.tileWidth}×${source.tileHeight}, expected ${tileset.tileCount}×${tileset.tileWidth}×${tileset.tileHeight}.`
			);
		}
		decodedBytes += source.pixels.byteLength;
		if (decodedBytes > ASEPRITE_MAX_DECODED_CEL_BYTES) {
			throw new Error(`Aseprite bound external tilesets exceed the ${ASEPRITE_MAX_DECODED_CEL_BYTES}-byte decoded budget.`);
		}
		tileset.pixels = source.pixels.slice();
		tileset.pixelColorDepth = source.pixelColorDepth;
		tileset.transparentPaletteIndex = source.transparentPaletteIndex;
		tileset.palette = source.palette?.map((entry) => [...entry] as [number, number, number, number]) ?? null;
		tileset.boundExternal = true;
		bound++;
	}
	document.statistics.boundExternalTilesetCount += bound;
	document.statistics.decodedTilesetBytes = decodedBytes;
	if (bound) {
		document.warnings = document.warnings.filter((warning) => !warning.includes("references external content and cannot render"));
	}
	return bound;
}

/** Resolves arbitrarily long backward link chains iteratively while retaining the referencing cel's transform and opacity. */
function resolvedCel(document: IAsepriteDocument, frameIndex: number, layerIndex: number): IAsepriteCel | null {
	const cel = document.frames[frameIndex]?.cels.find((candidate) => candidate.layerIndex === layerIndex) ?? null;
	if (!cel || cel.type !== "linked") {
		return cel;
	}
	let source: IAsepriteCel = cel;
	let sourceFrame = frameIndex;
	const visited = new Set<number>();
	while (source.type === "linked") {
		if (source.linkedFrame === null || visited.has(sourceFrame)) {
			throw new Error(`Aseprite linked cel cycle detected at ${sourceFrame}:${layerIndex}.`);
		}
		visited.add(sourceFrame);
		sourceFrame = source.linkedFrame;
		const next = document.frames[sourceFrame]?.cels.find((candidate) => candidate.layerIndex === layerIndex);
		if (!next) {
			throw new Error(`Aseprite linked cel ${frameIndex}:${layerIndex} references a frame without source data.`);
		}
		source = next;
	}
	if (!source.pixels && !source.tiles) {
		throw new Error(`Aseprite linked cel ${frameIndex}:${layerIndex} has no source image or tile data.`);
	}
	return {
		...cel,
		width: source.width,
		height: source.height,
		pixels: source.pixels,
		tiles: source.tiles,
		tileBitDepth: source.tileBitDepth,
		tileIdMask: source.tileIdMask,
		tileXFlipMask: source.tileXFlipMask,
		tileYFlipMask: source.tileYFlipMask,
		tileDiagonalFlipMask: source.tileDiagonalFlipMask,
	};
}

/** Converts one RGBA, grayscale, or frame-palette source sample into the common straight-alpha RGBA representation. */
function decodePixel(
	colorDepth: AsepriteColorDepth,
	transparentPaletteIndex: number,
	palette: Array<[number, number, number, number]>,
	background: boolean,
	pixels: Uint8Array,
	pixelIndex: number
): [number, number, number, number] {
	if (colorDepth === 32) {
		const offset = pixelIndex * 4;
		return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
	}
	if (colorDepth === 16) {
		const offset = pixelIndex * 2;
		return [pixels[offset], pixels[offset], pixels[offset], pixels[offset + 1]];
	}
	const paletteIndex = pixels[pixelIndex];
	const color = palette[paletteIndex] ?? [0, 0, 0, 255];
	return paletteIndex === transparentPaletteIndex && !background ? [color[0], color[1], color[2], 0] : color;
}

/** Converts one RGBA, grayscale, or frame-palette source sample into the common straight-alpha RGBA representation. */
function sourcePixel(document: IAsepriteDocument, frame: IAsepriteFrame, layer: IAsepriteLayer, pixels: Uint8Array, pixelIndex: number): [number, number, number, number] {
	return decodePixel(document.colorDepth, document.transparentPaletteIndex, frame.palette, layer.background, pixels, pixelIndex);
}

function lum(color: number[]): number {
	return 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
}

function sat(color: number[]): number {
	return Math.max(...color) - Math.min(...color);
}

function clipColor(color: number[]): number[] {
	const l = lum(color);
	const minimum = Math.min(...color);
	const maximum = Math.max(...color);
	if (minimum < 0) {
		color = color.map((value) => l + ((value - l) * l) / (l - minimum));
	}
	if (maximum > 1) {
		color = color.map((value) => l + ((value - l) * (1 - l)) / (maximum - l));
	}
	return color;
}

function setLum(color: number[], value: number): number[] {
	const delta = value - lum(color);
	return clipColor(color.map((channel) => channel + delta));
}

function setSat(color: number[], value: number): number[] {
	const entries = color.map((channel, index) => ({ channel, index })).sort((a, b) => a.channel - b.channel);
	const result = [...color];
	const min = entries[0];
	const mid = entries[1];
	const max = entries[2];
	if (max.channel > min.channel) {
		result[mid.index] = ((mid.channel - min.channel) * value) / (max.channel - min.channel);
		result[max.index] = value;
	} else {
		result[mid.index] = result[max.index] = 0;
	}
	result[min.index] = 0;
	return result;
}

function quantizeHsl(color: number[]): number[] {
	// Aseprite's non-separable blend functions truncate the intermediate RGB result to 8-bit before alpha compositing.
	return color.map((channel) => Math.trunc(Math.max(0, Math.min(1, channel)) * 255) / 255);
}

function blendChannel(back: number, source: number, mode: number): number {
	switch (mode) {
		case 1:
			return back * source;
		case 2:
			return back + source - back * source;
		case 3:
			return back <= 0.5 ? 2 * back * source : 1 - 2 * (1 - back) * (1 - source);
		case 4:
			return Math.min(back, source);
		case 5:
			return Math.max(back, source);
		case 6:
			return back <= 0 ? 0 : source >= 1 ? 1 : Math.min(1, back / (1 - source));
		case 7:
			return back >= 1 ? 1 : source <= 0 ? 0 : 1 - Math.min(1, (1 - back) / source);
		case 8:
			return source <= 0.5 ? 2 * back * source : 1 - 2 * (1 - back) * (1 - source);
		case 9:
			return source <= 0.5
				? back - (1 - 2 * source) * back * (1 - back)
				: back + (2 * source - 1) * ((back <= 0.25 ? ((16 * back - 12) * back + 4) * back : Math.sqrt(back)) - back);
		case 10:
			return Math.abs(back - source);
		case 11:
			return back + source - 2 * back * source;
		case 16:
			return Math.min(1, back + source);
		case 17:
			return Math.max(0, back - source);
		case 18:
			return back <= 0 ? 0 : back >= source ? 1 : Math.min(1, back / source);
		default:
			return source;
	}
}

function blendRgb(back: number[], source: number[], mode: number): number[] {
	if (mode === 12) {
		return quantizeHsl(setLum(setSat(source, sat(back)), lum(back)));
	}
	if (mode === 13) {
		return quantizeHsl(setLum(setSat(back, sat(source)), lum(back)));
	}
	if (mode === 14) {
		return quantizeHsl(setLum(source, lum(back)));
	}
	if (mode === 15) {
		return quantizeHsl(setLum(back, lum(source)));
	}
	if (mode < 0 || mode > 18) {
		mode = 0;
	}
	return [blendChannel(back[0], source[0], mode), blendChannel(back[1], source[1], mode), blendChannel(back[2], source[2], mode)];
}

function compositePixel(target: Uint8Array, offset: number, rgba: [number, number, number, number], opacity: number, blendMode: number): void {
	const sourceAlpha = (rgba[3] / 255) * opacity;
	if (sourceAlpha <= 0) {
		return;
	}
	const backAlpha = target[offset + 3] / 255;
	const source = [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
	const back = backAlpha > 0 ? [target[offset] / 255, target[offset + 1] / 255, target[offset + 2] / 255] : [0, 0, 0];
	const blended = blendRgb(back, source, blendMode);
	const outputAlpha = sourceAlpha + backAlpha - sourceAlpha * backAlpha;
	for (let channel = 0; channel < 3; channel++) {
		const premultiplied = (1 - sourceAlpha) * back[channel] * backAlpha + (1 - backAlpha) * source[channel] * sourceAlpha + backAlpha * sourceAlpha * blended[channel];
		target[offset + channel] = Math.round(Math.max(0, Math.min(1, outputAlpha ? premultiplied / outputAlpha : 0)) * 255);
	}
	target[offset + 3] = Math.round(outputAlpha * 255);
}

function layerVisible(document: IAsepriteDocument, layer: IAsepriteLayer, includeHidden: boolean): boolean {
	let current: IAsepriteLayer | undefined = layer;
	while (current) {
		if (!includeHidden && !current.visible) {
			return false;
		}
		current = current.parentIndex === null ? undefined : document.layers[current.parentIndex];
	}
	return true;
}

/** Renders integer cels and scaled reference-layer precise bounds with deterministic nearest-neighbor sampling. */
function renderImageLayer(document: IAsepriteDocument, frame: IAsepriteFrame, layer: IAsepriteLayer, target: Uint8Array, inheritedOpacity = 1): void {
	const cel = resolvedCel(document, frame.index, layer.index);
	if (!cel?.pixels || cel.type === "tilemap") {
		return;
	}
	const opacity = inheritedOpacity * (layer.opacity / 255) * (cel.opacity / 255);
	const bounds = cel.preciseBounds ?? { x: cel.x, y: cel.y, width: cel.width, height: cel.height };
	for (let destinationY = Math.floor(bounds.y); destinationY < Math.ceil(bounds.y + bounds.height); destinationY++) {
		if (destinationY < 0 || destinationY >= document.height) {
			continue;
		}
		const sourceY = Math.max(0, Math.min(cel.height - 1, Math.floor(((destinationY + 0.5 - bounds.y) / bounds.height) * cel.height)));
		for (let destinationX = Math.floor(bounds.x); destinationX < Math.ceil(bounds.x + bounds.width); destinationX++) {
			if (destinationX < 0 || destinationX >= document.width) {
				continue;
			}
			const sourceX = Math.max(0, Math.min(cel.width - 1, Math.floor(((destinationX + 0.5 - bounds.x) / bounds.width) * cel.width)));
			compositePixel(
				target,
				(destinationY * document.width + destinationX) * 4,
				sourcePixel(document, frame, layer, cel.pixels, sourceY * cel.width + sourceX),
				opacity,
				layer.effectiveBlendModeCode
			);
		}
	}
}

/** Reads one compact little-endian tile word without expanding the complete tilemap in memory. */
function tileValueAt(view: DataView, bitDepth: 8 | 16 | 32, index: number): number {
	return bitDepth === 8 ? view.getUint8(index) : bitDepth === 16 ? view.getUint16(index * 2, true) : view.getUint32(index * 4, true);
}

/** Matches Aseprite's mask-shift rule so non-zero-based tile ID masks remain valid. */
function maskShift(mask: number): number {
	let shift = 0;
	let value = mask >>> 0;
	while (value && !(value & 1)) {
		value >>>= 1;
		shift++;
	}
	return shift;
}

/** Expands embedded tiles into canvas pixels using Aseprite's X, then Y, then diagonal source-coordinate transform. */
function renderTilemapLayer(document: IAsepriteDocument, frame: IAsepriteFrame, layer: IAsepriteLayer, target: Uint8Array, inheritedOpacity = 1): void {
	const cel = resolvedCel(document, frame.index, layer.index);
	if (!cel?.tiles || !cel.tileBitDepth) {
		return;
	}
	const tileset = document.tilesets.find((entry) => entry.id === layer.tilesetIndex);
	if (!tileset?.pixels) {
		throw new Error(`Aseprite tilemap layer "${layer.name}" requires embedded pixels for tileset ID ${layer.tilesetIndex ?? "none"}.`);
	}
	const opacity = inheritedOpacity * (layer.opacity / 255) * (cel.opacity / 255);
	const idShift = maskShift(cel.tileIdMask);
	const tileValues = new DataView(cel.tiles.buffer, cel.tiles.byteOffset, cel.tiles.byteLength);
	for (let tileY = 0; tileY < cel.height; tileY++) {
		for (let tileX = 0; tileX < cel.width; tileX++) {
			const raw = tileValueAt(tileValues, cel.tileBitDepth, tileY * cel.width + tileX) >>> 0;
			if (tileset.flags & 4 ? (raw & cel.tileIdMask) >>> idShift === 0 : raw === 0xffffffff) {
				continue;
			}
			const tileIndex = (raw & cel.tileIdMask) >>> idShift;
			if (tileIndex >= tileset.tileCount) {
				throw new Error(`Aseprite tilemap layer "${layer.name}" references tile ${tileIndex}, beyond ${tileset.tileCount - 1}.`);
			}
			const xFlip = cel.tileXFlipMask !== 0 && (raw & cel.tileXFlipMask) >>> 0 === cel.tileXFlipMask >>> 0;
			const yFlip = cel.tileYFlipMask !== 0 && (raw & cel.tileYFlipMask) >>> 0 === cel.tileYFlipMask >>> 0;
			const diagonalFlip = cel.tileDiagonalFlipMask !== 0 && (raw & cel.tileDiagonalFlipMask) >>> 0 === cel.tileDiagonalFlipMask >>> 0;
			for (let y = 0; y < tileset.tileHeight; y++) {
				const destinationY = cel.y + tileY * tileset.tileHeight + y;
				if (destinationY < 0 || destinationY >= document.height) {
					continue;
				}
				for (let x = 0; x < tileset.tileWidth; x++) {
					const destinationX = cel.x + tileX * tileset.tileWidth + x;
					if (destinationX < 0 || destinationX >= document.width) {
						continue;
					}
					let sourceX = xFlip ? tileset.tileWidth - x - 1 : x;
					let sourceY = yFlip ? tileset.tileHeight - y - 1 : y;
					if (diagonalFlip) {
						[sourceX, sourceY] = [sourceY, sourceX];
						const minimum = Math.min(tileset.tileWidth, tileset.tileHeight);
						if (sourceX >= minimum || sourceY >= minimum) {
							continue;
						}
					}
					const pixelIndex = (tileIndex * tileset.tileHeight + sourceY) * tileset.tileWidth + sourceX;
					compositePixel(
						target,
						(destinationY * document.width + destinationX) * 4,
						decodePixel(tileset.pixelColorDepth, tileset.transparentPaletteIndex, tileset.palette ?? frame.palette, false, tileset.pixels, pixelIndex),
						opacity,
						layer.effectiveBlendModeCode
					);
				}
			}
		}
	}
}

/** Indexes the hierarchy once per render instead of rescanning every layer for each nested group. */
function childrenByParent(document: IAsepriteDocument): Map<number | null, IAsepriteLayer[]> {
	const result = new Map<number | null, IAsepriteLayer[]>();
	for (const layer of document.layers) {
		const children = result.get(layer.parentIndex) ?? [];
		children.push(layer);
		result.set(layer.parentIndex, children);
	}
	return result;
}

interface IAsepriteRenderTreeContext {
	document: IAsepriteDocument;
	frame: IAsepriteFrame;
	settings: IAsepriteImporterSettings;
	children: Map<number | null, IAsepriteLayer[]>;
	frameCels: Map<number, IAsepriteCel>;
}

/** Renders z-ordered hierarchy nodes, using isolated group buffers only when the file declares composite-group semantics. */
function renderLayerTree(context: IAsepriteRenderTreeContext, parentIndex: number | null, target: Uint8Array): void {
	const ordered = (context.children.get(parentIndex) ?? [])
		.filter((layer) => layerVisible(context.document, layer, context.settings.includeHiddenLayers))
		.sort((a, b) => {
			const firstZ = context.frameCels.get(a.index)?.zIndex ?? 0;
			const secondZ = context.frameCels.get(b.index)?.zIndex ?? 0;
			return a.index + firstZ - (b.index + secondZ) || firstZ - secondZ || a.index - b.index;
		});
	for (const layer of ordered) {
		if (layer.type === "group") {
			if (context.document.headerFlags & 2) {
				const group = new Uint8Array(target.byteLength);
				renderLayerTree(context, layer.index, group);
				const opacity = layer.opacity / 255;
				for (let offset = 0; offset < group.length; offset += 4) {
					compositePixel(target, offset, [group[offset], group[offset + 1], group[offset + 2], group[offset + 3]], opacity, layer.effectiveBlendModeCode);
				}
			} else {
				renderLayerTree(context, layer.index, target);
			}
		} else if (layer.type === "image") {
			renderImageLayer(context.document, context.frame, layer, target);
		} else if (layer.type === "tilemap") {
			renderTilemapLayer(context.document, context.frame, layer, target);
		}
	}
}

/** Renders one composited document frame or one exact image layer to full-canvas RGBA. */
export function renderAsepriteFrame(document: IAsepriteDocument, frameIndex: number, settingsValue?: unknown, layerIndex: number | null = null): Uint8Array {
	const settings = normalizeAsepriteImporterSettings(settingsValue);
	const frame = document.frames[frameIndex];
	if (!frame) {
		throw new Error(`Aseprite frame ${frameIndex} does not exist.`);
	}
	const output = new Uint8Array(document.width * document.height * 4);
	if (layerIndex === null) {
		renderLayerTree(
			{
				document,
				frame,
				settings,
				children: childrenByParent(document),
				frameCels: new Map(frame.cels.map((cel) => [cel.layerIndex, cel] as const)),
			},
			null,
			output
		);
	} else {
		const layer = document.layers[layerIndex];
		if (!layer || (layer.type !== "image" && layer.type !== "tilemap")) {
			throw new Error(`Aseprite layer ${layerIndex} is not an image or tilemap layer.`);
		}
		if (layerVisible(document, layer, settings.includeHiddenLayers)) {
			let opacity = 1;
			let parent = layer.parentIndex === null ? undefined : document.layers[layer.parentIndex];
			while (parent) {
				opacity *= parent.opacity / 255;
				parent = parent.parentIndex === null ? undefined : document.layers[parent.parentIndex];
			}
			layer.type === "tilemap" ? renderTilemapLayer(document, frame, layer, output, opacity) : renderImageLayer(document, frame, layer, output, opacity);
		}
	}
	return output;
}

function trimFrame(pixels: Uint8Array, width: number, height: number, trim: boolean): { pixels: Uint8Array; x: number; y: number; width: number; height: number; empty: boolean } {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (pixels[(y * width + x) * 4 + 3]) {
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}
	if (maxX < minX || maxY < minY) {
		return { pixels: new Uint8Array(4), x: 0, y: 0, width: 1, height: 1, empty: true };
	}
	if (!trim) {
		return { pixels, x: 0, y: 0, width, height, empty: false };
	}
	const trimmedWidth = maxX - minX + 1;
	const trimmedHeight = maxY - minY + 1;
	const result = new Uint8Array(trimmedWidth * trimmedHeight * 4);
	for (let y = 0; y < trimmedHeight; y++) {
		const sourceOffset = ((minY + y) * width + minX) * 4;
		result.set(pixels.subarray(sourceOffset, sourceOffset + trimmedWidth * 4), y * trimmedWidth * 4);
	}
	return { pixels: result, x: minX, y: minY, width: trimmedWidth, height: trimmedHeight, empty: false };
}

function nextPowerOfTwo(value: number): number {
	let result = 1;
	while (result < value) {
		result *= 2;
	}
	return result;
}

function pixelHash(pixels: Uint8Array): string {
	let first = 2166136261;
	let second = 2246822519;
	for (const value of pixels) {
		first = Math.imul(first ^ value, 16777619) >>> 0;
		second = Math.imul(second ^ value, 3266489917) >>> 0;
	}
	return `${pixels.byteLength}:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

/** Confirms a fast-hash candidate byte-for-byte so collisions never alias two sprites. */
function pixelsEqual(first: Uint8Array, second: Uint8Array): boolean {
	if (first.byteLength !== second.byteLength) {
		return false;
	}
	for (let index = 0; index < first.byteLength; index++) {
		if (first[index] !== second[index]) {
			return false;
		}
	}
	return true;
}

function pivotFor(
	document: IAsepriteDocument,
	frameIndex: number,
	trim: { x: number; y: number; width: number; height: number },
	settings: IAsepriteImporterSettings
): { x: number; y: number } {
	let sourceX = settings.pivotMode === "topLeft" ? 0 : document.width / 2;
	let sourceY = settings.pivotMode === "topLeft" ? 0 : document.height / 2;
	if (settings.pivotMode === "sliceOrCenter") {
		const key = document.slices
			.flatMap((slice) => slice.keys.filter((candidate) => candidate.frame <= frameIndex).map((candidate) => ({ slice, key: candidate })))
			.sort((a, b) => b.key.frame - a.key.frame)[0]?.key;
		if (key?.pivot) {
			sourceX = key.bounds.x + key.pivot.x;
			sourceY = key.bounds.y + key.pivot.y;
		}
	}
	return {
		x: Math.max(0, Math.min(1, (sourceX - trim.x) / Math.max(1, trim.width))),
		y: Math.max(0, Math.min(1, (sourceY - trim.y) / Math.max(1, trim.height))),
	};
}

interface IPreparedFrame {
	name: string;
	frameIndex: number;
	layerIndex: number | null;
	durationMs: number;
	pixels: Uint8Array;
	trimX: number;
	trimY: number;
	width: number;
	height: number;
	empty: boolean;
	hash: string;
	duplicateOf: number | null;
}

/** Produces bounded composite/layer streams with stable names and exact duplicate ownership before packing. */
function prepareFrames(document: IAsepriteDocument, settings: IAsepriteImporterSettings): IPreparedFrame[] {
	const result: IPreparedFrame[] = [];
	// Hash buckets keep ordinary duplicate lookup linear while exact comparison preserves correctness under a collision.
	const duplicateCandidates = new Map<string, number[]>();
	const layerIndices =
		settings.layerMode === "compositeAndLayers"
			? document.layers
					.filter((layer) => (layer.type === "image" || layer.type === "tilemap") && layerVisible(document, layer, settings.includeHiddenLayers))
					.map((layer) => layer.index)
			: [];
	const renderedPixels = document.width * document.height * document.frames.length * (layerIndices.length + 1);
	if (renderedPixels > ASEPRITE_MAX_RENDERED_PIXELS) {
		throw new Error(`Aseprite atlas preparation requires ${renderedPixels} rendered pixels, exceeding the ${ASEPRITE_MAX_RENDERED_PIXELS}-pixel limit.`);
	}
	const add = (frameIndex: number, layerIndex: number | null): void => {
		const rendered = renderAsepriteFrame(document, frameIndex, settings, layerIndex);
		const trimmed = trimFrame(rendered, document.width, document.height, settings.trimSprites);
		if (trimmed.empty && settings.ignoreEmptyFrames) {
			return;
		}
		const layerName = layerIndex === null ? "composite" : `layer-${layerIndex.toString().padStart(4, "0")}-${document.layers[layerIndex].name.replaceAll("/", "_")}`;
		const name = `${layerName}/frame-${frameIndex.toString().padStart(4, "0")}`;
		const hash = `${trimmed.width}x${trimmed.height}:${pixelHash(trimmed.pixels)}`;
		const candidates = settings.mergeDuplicates ? (duplicateCandidates.get(hash) ?? []) : [];
		const duplicateOf = candidates.find((index) => pixelsEqual(result[index].pixels, trimmed.pixels)) ?? null;
		const resultIndex = result.length;
		result.push({
			name,
			frameIndex,
			layerIndex,
			durationMs: document.frames[frameIndex].durationMs,
			pixels: trimmed.pixels,
			trimX: trimmed.x,
			trimY: trimmed.y,
			width: trimmed.width,
			height: trimmed.height,
			empty: trimmed.empty,
			hash,
			duplicateOf,
		});
		if (duplicateOf === null) {
			duplicateCandidates.set(hash, [...candidates, resultIndex]);
		}
	};
	for (const frame of document.frames) {
		add(frame.index, null);
	}
	for (const layerIndex of layerIndices) {
		for (const frame of document.frames) {
			add(frame.index, layerIndex);
		}
	}
	if (!result.length) {
		throw new Error("Aseprite settings excluded every atlas frame.");
	}
	if (result.length > 65_536) {
		throw new Error("Aseprite atlas supports at most 65,536 frame entries.");
	}
	return result;
}

function packFrames(frames: IPreparedFrame[], settings: IAsepriteImporterSettings): { width: number; height: number; placements: Array<{ x: number; y: number }> } {
	const unique = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame.duplicateOf === null);
	const border = settings.extrude;
	const gap = settings.padding;
	const maximumCellWidth = unique.reduce((maximum, { frame }) => Math.max(maximum, frame.width + border * 2), 0);
	const totalArea = unique.reduce((sum, { frame }) => sum + (frame.width + border * 2 + gap) * (frame.height + border * 2 + gap), 0);
	let width = Math.max(maximumCellWidth, Math.ceil(Math.sqrt(totalArea)));
	width = settings.powerOfTwo ? nextPowerOfTwo(width) : width;
	width = Math.min(settings.maximumAtlasSize, width);
	while (true) {
		let x = 0;
		let y = 0;
		let rowHeight = 0;
		const uniquePlacements = new Map<number, { x: number; y: number }>();
		let failed = false;
		for (const { frame, index } of unique) {
			const cellWidth = frame.width + border * 2;
			const cellHeight = frame.height + border * 2;
			if (cellWidth > width || cellHeight > settings.maximumAtlasSize) {
				failed = true;
				break;
			}
			if (x && x + cellWidth > width) {
				x = 0;
				y += rowHeight + gap;
				rowHeight = 0;
			}
			if (y + cellHeight > settings.maximumAtlasSize) {
				failed = true;
				break;
			}
			uniquePlacements.set(index, { x: x + border, y: y + border });
			x += cellWidth + gap;
			rowHeight = Math.max(rowHeight, cellHeight);
		}
		if (!failed) {
			let height = y + rowHeight;
			height = settings.powerOfTwo ? nextPowerOfTwo(Math.max(1, height)) : Math.max(1, height);
			if (height <= settings.maximumAtlasSize) {
				const placements = frames.map((frame, index) => {
					const owner = frame.duplicateOf ?? index;
					const placement = uniquePlacements.get(owner);
					if (!placement) {
						throw new Error(`Aseprite atlas placement for frame ${index} could not be resolved.`);
					}
					return placement;
				});
				return { width, height, placements };
			}
		}
		if (width >= settings.maximumAtlasSize) {
			throw new Error(`Aseprite atlas does not fit inside ${settings.maximumAtlasSize}×${settings.maximumAtlasSize}; reduce layers/frames or increase Maximum Atlas Size.`);
		}
		width = settings.powerOfTwo ? Math.min(settings.maximumAtlasSize, width * 2) : Math.min(settings.maximumAtlasSize, Math.ceil(width * 1.5));
	}
}

function copyFrameIntoAtlas(atlas: Uint8Array, atlasWidth: number, frame: IPreparedFrame, placement: { x: number; y: number }, extrude: number): void {
	for (let y = -extrude; y < frame.height + extrude; y++) {
		const sourceY = Math.max(0, Math.min(frame.height - 1, y));
		for (let x = -extrude; x < frame.width + extrude; x++) {
			const sourceX = Math.max(0, Math.min(frame.width - 1, x));
			const sourceOffset = (sourceY * frame.width + sourceX) * 4;
			const destinationOffset = ((placement.y + y) * atlasWidth + placement.x + x) * 4;
			atlas.set(frame.pixels.subarray(sourceOffset, sourceOffset + 4), destinationOffset);
		}
	}
}

/** Builds deterministic Babylon-compatible atlas pixels and rich tag/layer/slice metadata. */
export function buildAsepriteAtlas(document: IAsepriteDocument, settingsValue?: unknown): IAsepriteAtlas {
	const settings = normalizeAsepriteImporterSettings(settingsValue);
	const prepared = prepareFrames(document, settings);
	const packed = packFrames(prepared, settings);
	const atlasBytes = packed.width * packed.height * 4;
	if (atlasBytes > ASEPRITE_MAX_DECODED_CEL_BYTES) {
		throw new Error(`Aseprite atlas requires ${atlasBytes} bytes, exceeding the ${ASEPRITE_MAX_DECODED_CEL_BYTES}-byte limit.`);
	}
	const pixels = new Uint8Array(atlasBytes);
	for (const [index, frame] of prepared.entries()) {
		if (frame.duplicateOf === null) {
			copyFrameIntoAtlas(pixels, packed.width, frame, packed.placements[index], settings.extrude);
		}
	}
	const frames: IAsepriteAtlasFrame[] = prepared.map((entry, index) => ({
		name: entry.name,
		frameIndex: entry.frameIndex,
		layerIndex: entry.layerIndex,
		durationMs: entry.durationMs,
		frame: { x: packed.placements[index].x, y: packed.placements[index].y, w: entry.width, h: entry.height },
		rotated: false,
		trimmed: settings.trimSprites,
		empty: entry.empty,
		spriteSourceSize: { x: entry.trimX, y: entry.trimY, w: entry.empty ? 0 : entry.width, h: entry.empty ? 0 : entry.height },
		sourceSize: { w: document.width, h: document.height },
		pivot: pivotFor(document, entry.frameIndex, { x: entry.trimX, y: entry.trimY, width: entry.width, height: entry.height }, settings),
	}));
	const occupiedPixels = prepared.filter((frame) => frame.duplicateOf === null).reduce((sum, frame) => sum + frame.width * frame.height, 0);
	return {
		model: ASEPRITE_ATLAS_MODEL,
		width: packed.width,
		height: packed.height,
		pixels,
		frames,
		frameTags: settings.importTags ? document.tags.map((tag) => structuredClone(tag)) : [],
		slices: settings.importSlices ? document.slices.map((slice) => structuredClone(slice)) : [],
		layers: document.layers.map((layer) => structuredClone(layer)),
		settings,
		statistics: {
			entryCount: frames.length,
			compositeEntryCount: frames.filter((frame) => frame.layerIndex === null).length,
			layerEntryCount: frames.filter((frame) => frame.layerIndex !== null).length,
			emptyEntryCount: frames.filter((frame) => frame.empty).length,
			mergedDuplicateCount: prepared.filter((frame) => frame.duplicateOf !== null).length,
			atlasBytes,
			occupancy: occupiedPixels / Math.max(1, packed.width * packed.height),
		},
	};
}

/** Removes decoded pixel payloads while retaining every authored or diagnostic field needed by import/build evidence. */
export function summarizeAsepriteDocument(document: IAsepriteDocument): IAsepriteDocumentSummary {
	return {
		width: document.width,
		height: document.height,
		colorDepth: document.colorDepth,
		frameCount: document.frames.length,
		frameDurationsMs: document.frames.map((frame) => frame.durationMs),
		celUserData: document.frames.flatMap((frame) =>
			frame.cels.flatMap((cel) => {
				if (!cel.userData?.text && !cel.userData?.color) {
					return [];
				}
				return [
					{
						frameIndex: frame.index,
						layerIndex: cel.layerIndex,
						...(cel.userData.text ? { text: cel.userData.text } : {}),
						...(cel.userData.color ? { color: [...cel.userData.color] as [number, number, number, number] } : {}),
					},
				];
			})
		),
		layers: document.layers.map((layer) => structuredClone(layer)),
		externalFiles: document.externalFiles.map((entry) => structuredClone(entry)),
		tilesets: document.tilesets.map(({ pixels, palette, ...tileset }) => ({
			...structuredClone(tileset),
			pixelBytes: pixels?.byteLength ?? 0,
			paletteEntries: palette?.length ?? 0,
		})),
		tags: document.tags.map((tag) => structuredClone(tag)),
		slices: document.slices.map((slice) => structuredClone(slice)),
		colorProfile: structuredClone(document.colorProfile),
		pixelRatio: structuredClone(document.pixelRatio),
		grid: structuredClone(document.grid),
		warnings: [...document.warnings],
		statistics: structuredClone(document.statistics),
	};
}

/** Creates the single portable TexturePacker-compatible atlas contract consumed by editor preview and exported games. */
export function createAsepriteAtlasJson(
	document: IAsepriteDocument,
	atlas: IAsepriteAtlas,
	source: { name: string; bytes: number; sha256: string },
	settingsSha256: string,
	dependencies: IAsepriteAtlasDependencyEvidence[]
): Record<string, unknown> {
	return {
		frames: Object.fromEntries(
			atlas.frames.map((entry) => [
				entry.name,
				{
					frame: entry.frame,
					rotated: entry.rotated,
					trimmed: entry.trimmed,
					spriteSourceSize: entry.spriteSourceSize,
					sourceSize: entry.sourceSize,
					duration: entry.durationMs,
					pivot: entry.pivot,
					zvibe: { frameIndex: entry.frameIndex, layerIndex: entry.layerIndex, empty: entry.empty },
				},
			])
		),
		meta: {
			app: "Zvibe Editor",
			version: "1.0.0",
			image: "atlas.png",
			format: "RGBA8888",
			size: { w: atlas.width, h: atlas.height },
			scale: "1",
			frameTags: atlas.frameTags,
			layers: atlas.layers.map((layer) => ({
				name: layer.name,
				group: layer.parentIndex,
				opacity: layer.opacity,
				blendMode: layer.blendMode,
				visible: layer.visible,
				type: layer.type,
			})),
			slices: atlas.slices,
			zvibe: {
				model: ASEPRITE_ATLAS_MODEL,
				importer: ASEPRITE_IMPORTER_MODEL,
				source,
				settings: atlas.settings,
				settingsSha256,
				dependencies,
				document: summarizeAsepriteDocument(document),
				statistics: atlas.statistics,
			},
		},
	};
}

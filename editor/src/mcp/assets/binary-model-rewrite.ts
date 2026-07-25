import { gunzipSync, gzipSync, zstdCompressSync } from "node:zlib";

import { Decompress as ZstdDecompress } from "fzstd";

const FBX_BINARY_MAGIC = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
const MAX_BINARY_MODEL_STRING_BYTES = 1024 * 1024;
const MAX_BINARY_MODEL_STRINGS = 10_000;
const MAX_FBX_NODES = 100_000;
const MAX_FBX_PROPERTIES = 1_000_000;
const MAX_FBX_PROPERTY_BYTES = 16 * 1024 * 1024;
const MAX_FBX_DEPTH = 64;
const MAX_3DS_CHUNKS = 100_000;
const MAX_3DS_DEPTH = 32;
const MS3D_MAGIC = Buffer.from("MS3D000000", "ascii");
const MS3D_VERTEX_BYTES = 15;
const MS3D_TRIANGLE_BYTES = 70;
const MS3D_MATERIAL_BYTES = 361;
const MS3D_MATERIAL_NAME_BYTES = 32;
const MS3D_MATERIAL_TEXTURE_BYTES = 128;
const B3D_MAGIC = "BB3D";
const B3D_TEXTURE_RECORD_BYTES = 28;
const MAX_B3D_CHUNKS = 100_000;
const MAX_B3D_TEXTURES = 10_000;
const X_HEADER_BYTES = 16;
const MAX_X_TOKENS = 1_000_000;
const MAX_LWO_CHUNKS = 100_000;
const MAX_LWO_REFERENCES = 10_000;
const MAX_LWO_SEQUENCE_FRAMES = 4_096;
const MAX_LWO_SEQUENCE_DIGITS = 16;
const DXF_BINARY_SENTINEL = Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "binary");
const MAX_DXF_PAIRS = 1_000_000;
const MAX_DXF_LINE_BYTES = 16 * 1024;
const MAX_DXF_PATH_BYTES = 2_049;
const MAX_DXF_REFERENCES = 10_000;
const BLEND_MAGIC = Buffer.from("BLENDER", "ascii");
const BLEND_GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const BLEND_ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_BLEND_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_BLEND_BLOCKS = 1_000_000;
const MAX_BLEND_DNA_NAMES = 100_000;
const MAX_BLEND_DNA_TYPES = 100_000;
const MAX_BLEND_DNA_STRUCTURES = 100_000;
const MAX_BLEND_DNA_FIELDS = 1_000_000;
const MAX_BLEND_ARRAY_ELEMENTS = 1024 * 1024;
const MAX_BLEND_REFERENCES = 10_000;

const X_TOKEN_NAME = 1;
const X_TOKEN_STRING = 2;
const X_TOKEN_INTEGER = 3;
const X_TOKEN_GUID = 5;
const X_TOKEN_INTEGER_LIST = 6;
const X_TOKEN_FLOAT_LIST = 7;
const X_TOKEN_OBRACE = 10;
const X_TOKEN_CBRACE = 11;
const X_TOKEN_SEMICOLON = 20;
const X_TOKEN_TEMPLATE = 31;
const X_STANDALONE_TOKENS = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 31, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52]);

const THREE_DS_CONTAINER_CHUNKS = new Set([0x4d4d, 0x3d3d, 0xafff, 0xa200, 0xa204, 0xa210, 0xa220, 0xa230, 0xa33a, 0xa33c, 0xa33d, 0xa33e, 0xa340]);

export interface IBinaryModelReferenceRewriteResult {
	buffer: Buffer;
	replacementCount: number;
	semanticMatchCount: number;
	error?: string;
	errorKind?: "malformed" | "semanticMismatch";
}

interface IFbxProperty {
	raw: Buffer;
	type: string;
	stringValue?: string;
	trailingNullBytes: number;
}

interface IFbxNode {
	name: Buffer;
	properties: IFbxProperty[];
	children: IFbxNode[];
	hasTerminator: boolean;
}

interface IFbxParseState {
	wide: boolean;
	headerBytes: number;
	nodeCount: number;
	stringCount: number;
}

interface IFbxSequence {
	nodes: IFbxNode[];
	hasTerminator: boolean;
	cursor: number;
}

interface I3dsChunk {
	id: number;
	payload: Buffer;
	children?: I3dsChunk[];
	textureName?: string;
	textureSuffix?: Buffer;
}

interface IMs3dReferenceField {
	offset: number;
	value: string;
}

interface IB3dTextureRecord {
	value: string;
	suffix: Buffer;
}

interface IB3dChunk {
	tag: string;
	payload: Buffer;
	textures?: IB3dTextureRecord[];
}

interface IB3dDocument {
	version: Buffer;
	chunks: IB3dChunk[];
}

interface IXBinaryToken {
	type: number;
	raw: Buffer;
	name?: string;
	stringValue?: string;
	trailingNullBytes?: number;
	terminator?: number;
}

interface IXTextReference {
	start: number;
	end: number;
	value: string;
}

type LwoFormType = "LWOB" | "LWO2" | "LWO3" | "LXOB";
type LwoStringEncoding = "utf8" | "latin1";

interface ILwoChunk {
	tag: string;
	payload: Buffer;
	padByte?: number;
	formType?: string;
	formPayload?: Buffer;
}

interface ILwoDocument {
	formType: LwoFormType;
	chunks: ILwoChunk[];
}

interface ILwoString {
	value: string;
	encoding: LwoStringEncoding;
	end: number;
}

interface ILwoReferenceProcessResult {
	payload: Buffer;
	values: string[];
	replacementCount: number;
	semanticMatchCount: number;
}

type DxfStringEncoding = "utf8" | "latin1";

interface IDxfLine {
	start: number;
	end: number;
	value: string;
	encoding: DxfStringEncoding;
}

interface IDxfPair {
	code: number;
	valueLine: IDxfLine;
}

interface IDxfReplacement {
	start: number;
	end: number;
	data: Buffer;
}

class LwoSemanticRewriteError extends Error {}

function readFbxInteger(buffer: Buffer, offset: number, wide: boolean): number | null {
	if (wide) {
		if (offset + 8 > buffer.length) {
			return null;
		}
		const value = buffer.readBigUInt64LE(offset);
		return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
	}
	return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null;
}

function writeFbxInteger(buffer: Buffer, offset: number, value: number, wide: boolean): void {
	if (!Number.isSafeInteger(value) || value < 0 || (!wide && value > 0xffffffff)) {
		throw new Error("Rewritten FBX offsets exceed the supported binary header range.");
	}
	if (wide) {
		buffer.writeBigUInt64LE(BigInt(value), offset);
	} else {
		buffer.writeUInt32LE(value, offset);
	}
}

function isNullFbxHeader(buffer: Buffer, offset: number, state: IFbxParseState): boolean {
	return offset + state.headerBytes <= buffer.length && buffer.subarray(offset, offset + state.headerBytes).every((value) => value === 0);
}

function parseFbxProperties(buffer: Buffer, start: number, end: number, count: number, state: IFbxParseState): IFbxProperty[] {
	const properties: IFbxProperty[] = [];
	let cursor = start;
	for (let index = 0; index < count; index++) {
		if (cursor >= end) {
			throw new Error("The FBX property list is truncated.");
		}
		const propertyStart = cursor;
		const type = String.fromCharCode(buffer[cursor++]);
		const scalarBytes: Record<string, number> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
		let stringValue: string | undefined;
		let trailingNullBytes = 0;
		if (scalarBytes[type] !== undefined) {
			cursor += scalarBytes[type];
		} else if ("fdlib".includes(type)) {
			if (cursor + 12 > end) {
				throw new Error("The FBX array property header is truncated.");
			}
			const encodedBytes = buffer.readUInt32LE(cursor + 8);
			cursor += 12 + encodedBytes;
		} else if (type === "S" || type === "R") {
			if (cursor + 4 > end) {
				throw new Error("The FBX string/blob property header is truncated.");
			}
			const length = buffer.readUInt32LE(cursor);
			cursor += 4;
			if (length > MAX_BINARY_MODEL_STRING_BYTES || cursor + length > end) {
				throw new Error("The FBX string/blob property exceeds its bounded bytes or property list.");
			}
			if (type === "S") {
				state.stringCount++;
				if (state.stringCount > MAX_BINARY_MODEL_STRINGS) {
					throw new Error(`The FBX contains more than ${MAX_BINARY_MODEL_STRINGS.toLocaleString()} string properties.`);
				}
				const bytes = buffer.subarray(cursor, cursor + length);
				while (trailingNullBytes < bytes.length && bytes[bytes.length - 1 - trailingNullBytes] === 0) {
					trailingNullBytes++;
				}
				const valueBytes = bytes.subarray(0, bytes.length - trailingNullBytes);
				if (valueBytes.includes(0)) {
					throw new Error("The FBX contains an embedded-null string property that cannot be rewritten safely.");
				}
				stringValue = valueBytes.toString("utf-8");
			}
			cursor += length;
		} else {
			throw new Error(`The FBX contains unsupported property type ${JSON.stringify(type)}.`);
		}
		if (cursor > end) {
			throw new Error("The FBX property exceeds the declared property-list boundary.");
		}
		properties.push({ raw: Buffer.from(buffer.subarray(propertyStart, cursor)), type, stringValue, trailingNullBytes });
	}
	if (cursor !== end) {
		throw new Error("The FBX property-list byte count does not match its parsed properties.");
	}
	return properties;
}

function parseFbxSequence(buffer: Buffer, start: number, limit: number, depth: number, state: IFbxParseState): IFbxSequence {
	if (depth > MAX_FBX_DEPTH) {
		throw new Error(`The FBX node hierarchy exceeds ${MAX_FBX_DEPTH} levels.`);
	}
	const nodes: IFbxNode[] = [];
	let cursor = start;
	while (cursor + state.headerBytes <= limit) {
		if (isNullFbxHeader(buffer, cursor, state)) {
			return { nodes, hasTerminator: true, cursor: cursor + state.headerBytes };
		}
		const endOffset = readFbxInteger(buffer, cursor, state.wide);
		const propertyCount = readFbxInteger(buffer, cursor + (state.wide ? 8 : 4), state.wide);
		const propertyBytes = readFbxInteger(buffer, cursor + (state.wide ? 16 : 8), state.wide);
		const nameLength = buffer[cursor + (state.wide ? 24 : 12)];
		state.nodeCount++;
		if (
			endOffset === null ||
			propertyCount === null ||
			propertyBytes === null ||
			state.nodeCount > MAX_FBX_NODES ||
			propertyCount > MAX_FBX_PROPERTIES ||
			propertyBytes > MAX_FBX_PROPERTY_BYTES ||
			endOffset <= cursor + state.headerBytes + nameLength ||
			endOffset > limit
		) {
			throw new Error("The FBX binary node header is malformed or exceeds bounded limits.");
		}
		const nameStart = cursor + state.headerBytes;
		const propertyStart = nameStart + nameLength;
		const propertyEnd = propertyStart + propertyBytes;
		if (propertyEnd > endOffset) {
			throw new Error("The FBX property list extends beyond its node.");
		}
		const properties = parseFbxProperties(buffer, propertyStart, propertyEnd, propertyCount, state);
		let children: IFbxNode[] = [];
		let hasTerminator = false;
		if (propertyEnd < endOffset) {
			const sequence = parseFbxSequence(buffer, propertyEnd, endOffset, depth + 1, state);
			if (sequence.cursor !== endOffset) {
				throw new Error("The FBX child node list contains unsupported trailing bytes.");
			}
			children = sequence.nodes;
			hasTerminator = sequence.hasTerminator;
		}
		nodes.push({ name: Buffer.from(buffer.subarray(nameStart, propertyStart)), properties, children, hasTerminator });
		cursor = endOffset;
	}
	if (cursor !== limit) {
		throw new Error("The FBX node table ends with a truncated header.");
	}
	return { nodes, hasTerminator: false, cursor };
}

function encodeFbxProperty(property: IFbxProperty): Buffer {
	if (property.type !== "S" || property.stringValue === undefined) {
		return property.raw;
	}
	const value = Buffer.from(property.stringValue, "utf-8");
	const payload = Buffer.concat([value, Buffer.alloc(property.trailingNullBytes)]);
	if (payload.length > MAX_BINARY_MODEL_STRING_BYTES) {
		throw new Error("A rewritten FBX string exceeds the 1 MiB property limit.");
	}
	const header = Buffer.alloc(5);
	header[0] = "S".charCodeAt(0);
	header.writeUInt32LE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

function encodeFbxSequence(nodes: IFbxNode[], startOffset: number, wide: boolean, hasTerminator: boolean): Buffer {
	const headerBytes = wide ? 25 : 13;
	const parts: Buffer[] = [];
	let offset = startOffset;
	for (const node of nodes) {
		const properties = node.properties.map(encodeFbxProperty);
		const propertyBytes = Buffer.concat(properties);
		if (node.properties.length > MAX_FBX_PROPERTIES || propertyBytes.length > MAX_FBX_PROPERTY_BYTES || node.name.length > 0xff) {
			throw new Error("A rewritten FBX node exceeds its bounded property count, property bytes, or name length.");
		}
		const childStart = offset + headerBytes + node.name.length + propertyBytes.length;
		const children = encodeFbxSequence(node.children, childStart, wide, node.hasTerminator);
		const endOffset = childStart + children.length;
		const header = Buffer.alloc(headerBytes);
		writeFbxInteger(header, 0, endOffset, wide);
		writeFbxInteger(header, wide ? 8 : 4, node.properties.length, wide);
		writeFbxInteger(header, wide ? 16 : 8, propertyBytes.length, wide);
		header[wide ? 24 : 12] = node.name.length;
		parts.push(header, node.name, propertyBytes, children);
		offset = endOffset;
	}
	if (hasTerminator) {
		parts.push(Buffer.alloc(headerBytes));
	}
	return Buffer.concat(parts);
}

export function isBinaryFbx(buffer: Buffer): boolean {
	return buffer.length >= FBX_BINARY_MAGIC.length && buffer.subarray(0, FBX_BINARY_MAGIC.length).equals(FBX_BINARY_MAGIC);
}

export function rewriteBinaryFbxReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		if (buffer.length < 27 || !isBinaryFbx(buffer)) {
			throw new Error("The FBX binary header is missing.");
		}
		const wide = buffer.readUInt32LE(23) >= 7500;
		const state: IFbxParseState = { wide, headerBytes: wide ? 25 : 13, nodeCount: 0, stringCount: 0 };
		const sequence = parseFbxSequence(buffer, 27, buffer.length, 0, state);
		let replacementCount = 0;
		let semanticMatchCount = 0;
		const visit = (nodes: IFbxNode[]): void => {
			for (const node of nodes) {
				for (const property of node.properties) {
					if (property.stringValue === undefined) {
						continue;
					}
					const rewritten = rewrite(property.stringValue);
					if (rewritten === null) {
						continue;
					}
					semanticMatchCount++;
					if (rewritten !== property.stringValue) {
						property.stringValue = rewritten;
						replacementCount++;
					}
				}
				visit(node.children);
			}
		};
		visit(sequence.nodes);
		if (!replacementCount) {
			return { buffer, replacementCount, semanticMatchCount };
		}
		const prefix = Buffer.from(buffer.subarray(0, 27));
		const table = encodeFbxSequence(sequence.nodes, 27, wide, sequence.hasTerminator);
		const suffix = Buffer.from(buffer.subarray(sequence.cursor));
		return { buffer: Buffer.concat([prefix, table, suffix]), replacementCount, semanticMatchCount };
	} catch (error) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function parse3dsChunks(buffer: Buffer, start: number, limit: number, depth: number, count: { value: number }): I3dsChunk[] {
	if (depth > MAX_3DS_DEPTH) {
		throw new Error(`The 3DS chunk hierarchy exceeds ${MAX_3DS_DEPTH} levels.`);
	}
	const chunks: I3dsChunk[] = [];
	let cursor = start;
	while (cursor < limit) {
		count.value++;
		if (cursor + 6 > limit || count.value > MAX_3DS_CHUNKS) {
			throw new Error("The 3DS chunk table is truncated or exceeds bounded chunk count.");
		}
		const id = buffer.readUInt16LE(cursor);
		const length = buffer.readUInt32LE(cursor + 2);
		const end = cursor + length;
		if (length < 6 || end > limit) {
			throw new Error("The 3DS chunk table contains an invalid length.");
		}
		const payload = Buffer.from(buffer.subarray(cursor + 6, end));
		if (id === 0xa300) {
			const zero = payload.indexOf(0);
			if (zero < 0 || zero > MAX_BINARY_MODEL_STRING_BYTES) {
				throw new Error("The 3DS texture-name chunk is missing its bounded null terminator.");
			}
			chunks.push({ id, payload, textureName: payload.subarray(0, zero).toString("utf-8"), textureSuffix: Buffer.from(payload.subarray(zero + 1)) });
		} else if (THREE_DS_CONTAINER_CHUNKS.has(id)) {
			chunks.push({ id, payload, children: parse3dsChunks(buffer, cursor + 6, end, depth + 1, count) });
		} else {
			chunks.push({ id, payload });
		}
		cursor = end;
	}
	if (cursor !== limit) {
		throw new Error("The 3DS chunk table does not end at its declared boundary.");
	}
	return chunks;
}

function encode3dsChunks(chunks: I3dsChunk[]): Buffer {
	return Buffer.concat(
		chunks.map((chunk) => {
			let payload = chunk.children
				? encode3dsChunks(chunk.children)
				: chunk.textureName !== undefined
					? Buffer.concat([Buffer.from(chunk.textureName, "utf-8"), Buffer.from([0]), chunk.textureSuffix ?? Buffer.alloc(0)])
					: chunk.payload;
			if (payload.length + 6 > 0xffffffff) {
				throw new Error("A rewritten 3DS chunk exceeds the 32-bit length limit.");
			}
			const header = Buffer.alloc(6);
			header.writeUInt16LE(chunk.id, 0);
			header.writeUInt32LE(payload.length + 6, 2);
			return Buffer.concat([header, payload]);
		})
	);
}

export function rewrite3dsReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0x4d4d) {
			throw new Error("The 3DS main chunk is missing.");
		}
		const chunks = parse3dsChunks(buffer, 0, buffer.length, 0, { value: 0 });
		let replacementCount = 0;
		let semanticMatchCount = 0;
		const visit = (entries: I3dsChunk[]): void => {
			for (const chunk of entries) {
				if (chunk.textureName !== undefined) {
					const rewritten = rewrite(chunk.textureName);
					if (rewritten !== null) {
						semanticMatchCount++;
						if (rewritten !== chunk.textureName) {
							chunk.textureName = rewritten;
							replacementCount++;
						}
					}
				}
				if (chunk.children) {
					visit(chunk.children);
				}
			}
		};
		visit(chunks);
		return replacementCount ? { buffer: encode3dsChunks(chunks), replacementCount, semanticMatchCount } : { buffer, replacementCount, semanticMatchCount };
	} catch (error) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function checkedMs3dAdvance(buffer: Buffer, cursor: number, bytes: number, section: string): number {
	if (!Number.isSafeInteger(bytes) || bytes < 0 || cursor + bytes > buffer.length) {
		throw new Error(`The MS3D ${section} table is truncated or exceeds bounded counts.`);
	}
	return cursor + bytes;
}

function readMs3dCount(buffer: Buffer, cursor: number, section: string): { count: number; cursor: number } {
	const next = checkedMs3dAdvance(buffer, cursor, 2, `${section} count`);
	return { count: buffer.readUInt16LE(cursor), cursor: next };
}

function readMs3dString(buffer: Buffer, offset: number, bytes: number): string {
	const field = buffer.subarray(offset, offset + bytes);
	const zero = field.indexOf(0);
	return field.subarray(0, zero < 0 ? field.length : zero).toString("utf-8");
}

function parseMs3dReferenceFields(buffer: Buffer): IMs3dReferenceField[] {
	if (buffer.length < 14 || !buffer.subarray(0, MS3D_MAGIC.length).equals(MS3D_MAGIC)) {
		throw new Error("The MS3D header is missing.");
	}
	const version = buffer.readInt32LE(10);
	if (version !== 3 && version !== 4) {
		throw new Error(`MS3D version ${version} is not supported; expected version 3 or 4.`);
	}
	let cursor = 14;
	let table = readMs3dCount(buffer, cursor, "vertex");
	cursor = checkedMs3dAdvance(buffer, table.cursor, table.count * MS3D_VERTEX_BYTES, "vertex");
	table = readMs3dCount(buffer, cursor, "triangle");
	cursor = checkedMs3dAdvance(buffer, table.cursor, table.count * MS3D_TRIANGLE_BYTES, "triangle");
	table = readMs3dCount(buffer, cursor, "group");
	cursor = table.cursor;
	for (let index = 0; index < table.count; index++) {
		cursor = checkedMs3dAdvance(buffer, cursor, 1 + 32, `group ${index + 1} header`);
		const triangles = readMs3dCount(buffer, cursor, `group ${index + 1} triangle`);
		cursor = checkedMs3dAdvance(buffer, triangles.cursor, triangles.count * 2 + 1, `group ${index + 1}`);
	}
	table = readMs3dCount(buffer, cursor, "material");
	cursor = table.cursor;
	const references: IMs3dReferenceField[] = [];
	for (let index = 0; index < table.count; index++) {
		const end = checkedMs3dAdvance(buffer, cursor, MS3D_MATERIAL_BYTES, `material ${index + 1}`);
		const textureOffset = cursor + MS3D_MATERIAL_NAME_BYTES + 4 * 4 * 4 + 4 + 4 + 1;
		for (const offset of [textureOffset, textureOffset + MS3D_MATERIAL_TEXTURE_BYTES]) {
			const value = readMs3dString(buffer, offset, MS3D_MATERIAL_TEXTURE_BYTES);
			if (value) {
				references.push({ offset, value });
			}
		}
		cursor = end;
	}
	return references;
}

/** Extracts texture and alpha-map filenames from bounded MilkShape 3D material records. */
export function extractMs3dReferences(buffer: Buffer): { values: string[]; error?: string } {
	try {
		return { values: parseMs3dReferenceFields(buffer).map((field) => field.value) };
	} catch (error) {
		return { values: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rewrites fixed-width MilkShape 3D material texture fields without shifting any geometry or animation bytes. */
export function rewriteMs3dReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		const references = parseMs3dReferenceFields(buffer);
		let replacementCount = 0;
		let semanticMatchCount = 0;
		let result = buffer;
		for (const reference of references) {
			const rewritten = rewrite(reference.value);
			if (rewritten === null) {
				continue;
			}
			semanticMatchCount++;
			if (rewritten === reference.value) {
				continue;
			}
			const bytes = Buffer.from(rewritten, "utf-8");
			if (bytes.length >= MS3D_MATERIAL_TEXTURE_BYTES || bytes.includes(0)) {
				throw new Error(`A rewritten MS3D material path must fit in ${MS3D_MATERIAL_TEXTURE_BYTES - 1} UTF-8 bytes without nulls.`);
			}
			if (result === buffer) {
				result = Buffer.from(buffer);
			}
			result.fill(0, reference.offset, reference.offset + MS3D_MATERIAL_TEXTURE_BYTES);
			bytes.copy(result, reference.offset);
			replacementCount++;
		}
		return { buffer: result, replacementCount, semanticMatchCount };
	} catch (error) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function parseB3dTextureRecords(payload: Buffer): IB3dTextureRecord[] {
	const records: IB3dTextureRecord[] = [];
	let cursor = 0;
	while (cursor < payload.length) {
		if (records.length >= MAX_B3D_TEXTURES) {
			throw new Error(`The B3D TEXS chunk contains more than ${MAX_B3D_TEXTURES.toLocaleString()} texture records.`);
		}
		const zero = payload.indexOf(0, cursor);
		if (zero < 0 || zero - cursor > MAX_BINARY_MODEL_STRING_BYTES) {
			throw new Error("A B3D TEXS filename is missing its bounded null terminator.");
		}
		const suffixEnd = zero + 1 + B3D_TEXTURE_RECORD_BYTES;
		if (suffixEnd > payload.length) {
			throw new Error("A B3D TEXS texture transform record is truncated.");
		}
		records.push({ value: payload.subarray(cursor, zero).toString("utf-8"), suffix: Buffer.from(payload.subarray(zero + 1, suffixEnd)) });
		cursor = suffixEnd;
	}
	return records;
}

function parseB3dDocument(buffer: Buffer): IB3dDocument {
	if (buffer.length < 12 || buffer.subarray(0, 4).toString("ascii") !== B3D_MAGIC) {
		throw new Error("The B3D BB3D root chunk is missing.");
	}
	const declaredBytes = buffer.readUInt32LE(4);
	if (declaredBytes !== buffer.length - 8) {
		throw new Error("The B3D root chunk length does not match the file length.");
	}
	const version = Buffer.from(buffer.subarray(8, 12));
	const chunks: IB3dChunk[] = [];
	let cursor = 12;
	while (cursor < buffer.length) {
		if (chunks.length >= MAX_B3D_CHUNKS || cursor + 8 > buffer.length) {
			throw new Error("The B3D root chunk table is truncated or exceeds bounded chunk count.");
		}
		const tag = buffer.subarray(cursor, cursor + 4).toString("ascii");
		const bytes = buffer.readUInt32LE(cursor + 4);
		const end = cursor + 8 + bytes;
		if (end > buffer.length) {
			throw new Error(`The B3D ${JSON.stringify(tag)} chunk exceeds the BB3D root boundary.`);
		}
		const payload = Buffer.from(buffer.subarray(cursor + 8, end));
		chunks.push({ tag, payload, ...(tag === "TEXS" ? { textures: parseB3dTextureRecords(payload) } : {}) });
		cursor = end;
	}
	return { version, chunks };
}

function encodeB3dDocument(document: IB3dDocument): Buffer {
	const chunks = document.chunks.map((chunk) => {
		const payload = chunk.textures ? Buffer.concat(chunk.textures.flatMap((record) => [Buffer.from(record.value, "utf-8"), Buffer.from([0]), record.suffix])) : chunk.payload;
		if (payload.length > 0xffffffff) {
			throw new Error(`A rewritten B3D ${JSON.stringify(chunk.tag)} chunk exceeds the 32-bit length limit.`);
		}
		const header = Buffer.alloc(8);
		header.write(chunk.tag, 0, 4, "ascii");
		header.writeUInt32LE(payload.length, 4);
		return Buffer.concat([header, payload]);
	});
	const body = Buffer.concat([document.version, ...chunks]);
	if (body.length > 0xffffffff) {
		throw new Error("The rewritten B3D root chunk exceeds the 32-bit length limit.");
	}
	const header = Buffer.alloc(8);
	header.write(B3D_MAGIC, 0, 4, "ascii");
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

/** Extracts external texture filenames from exact top-level B3D TEXS records. */
export function extractB3dReferences(buffer: Buffer): { values: string[]; error?: string } {
	try {
		return { values: parseB3dDocument(buffer).chunks.flatMap((chunk) => chunk.textures?.map((record) => record.value) ?? []) };
	} catch (error) {
		return { values: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rebuilds TEXS and BB3D chunk lengths while preserving every non-reference chunk and per-texture transform byte. */
export function rewriteB3dReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		const document = parseB3dDocument(buffer);
		let replacementCount = 0;
		let semanticMatchCount = 0;
		for (const chunk of document.chunks) {
			for (const record of chunk.textures ?? []) {
				const rewritten = rewrite(record.value);
				if (rewritten === null) {
					continue;
				}
				semanticMatchCount++;
				if (rewritten === record.value) {
					continue;
				}
				const bytes = Buffer.from(rewritten, "utf-8");
				if (bytes.length > MAX_BINARY_MODEL_STRING_BYTES || bytes.includes(0)) {
					throw new Error("A rewritten B3D texture path exceeds 1 MiB or contains a null byte.");
				}
				record.value = rewritten;
				replacementCount++;
			}
		}
		return replacementCount ? { buffer: encodeB3dDocument(document), replacementCount, semanticMatchCount } : { buffer, replacementCount, semanticMatchCount };
	} catch (error) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function parseXHeader(buffer: Buffer): { format: "text" | "binary"; floatBytes: 4 | 8 } {
	if (buffer.length < X_HEADER_BYTES || buffer.subarray(0, 4).toString("ascii") !== "xof ") {
		throw new Error("The DirectX .x header is missing.");
	}
	const version = buffer.subarray(4, 8).toString("ascii");
	if (version !== "0302" && version !== "0303") {
		throw new Error(`DirectX .x version ${JSON.stringify(version)} is not supported; expected 0302 or 0303.`);
	}
	const encoding = buffer.subarray(8, 12).toString("ascii");
	if (encoding !== "txt " && encoding !== "bin ") {
		throw new Error(`DirectX .x encoding ${JSON.stringify(encoding)} is compressed or unsupported; use an uncompressed txt or bin file.`);
	}
	const floatSize = buffer.subarray(12, 16).toString("ascii");
	if (floatSize !== "0032" && floatSize !== "0064") {
		throw new Error(`DirectX .x float size ${JSON.stringify(floatSize)} is invalid; expected 0032 or 0064.`);
	}
	return { format: encoding === "txt " ? "text" : "binary", floatBytes: floatSize === "0032" ? 4 : 8 };
}

function decodeXTextString(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		if (value[index] === "\\" && (value[index + 1] === "\\" || value[index + 1] === '"')) {
			result += value[++index];
		} else {
			result += value[index];
		}
	}
	return result;
}

function encodeXTextString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractXTextReferences(content: string): IXTextReference[] {
	const references: IXTextReference[] = [];
	const expression = /\bTextureFilename\b(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\{\s*"((?:\\[\s\S]|[^"\\])*)"/g;
	for (let match = expression.exec(content); match; match = expression.exec(content)) {
		const start = match.index + match[0].length - match[1].length - 1;
		references.push({ start, end: start + match[1].length, value: decodeXTextString(match[1]) });
		if (references.length > MAX_BINARY_MODEL_STRINGS) {
			throw new Error(`The DirectX .x text stream contains more than ${MAX_BINARY_MODEL_STRINGS.toLocaleString()} texture filename objects.`);
		}
	}
	return references;
}

function parseXBinaryTokens(buffer: Buffer, floatBytes: 4 | 8): IXBinaryToken[] {
	const tokens: IXBinaryToken[] = [];
	let cursor = X_HEADER_BYTES;
	while (cursor < buffer.length) {
		if (tokens.length >= MAX_X_TOKENS || cursor + 2 > buffer.length) {
			throw new Error("The DirectX .x binary token stream is truncated or exceeds bounded token count.");
		}
		const start = cursor;
		const type = buffer.readUInt16LE(cursor);
		cursor += 2;
		let name: string | undefined;
		let stringValue: string | undefined;
		let trailingNullBytes: number | undefined;
		let terminator: number | undefined;
		if (type === X_TOKEN_NAME || type === X_TOKEN_STRING) {
			if (cursor + 4 > buffer.length) {
				throw new Error("A DirectX .x name/string token is missing its byte count.");
			}
			const bytes = buffer.readUInt32LE(cursor);
			cursor += 4;
			if (bytes > MAX_BINARY_MODEL_STRING_BYTES || cursor + bytes > buffer.length) {
				throw new Error("A DirectX .x name/string token exceeds its bounded bytes or stream boundary.");
			}
			const valueBytes = buffer.subarray(cursor, cursor + bytes);
			cursor += bytes;
			if (type === X_TOKEN_NAME) {
				name = valueBytes.toString("ascii");
			} else {
				trailingNullBytes = 0;
				while (trailingNullBytes < valueBytes.length && valueBytes[valueBytes.length - 1 - trailingNullBytes] === 0) {
					trailingNullBytes++;
				}
				const meaningful = valueBytes.subarray(0, valueBytes.length - trailingNullBytes);
				if (meaningful.includes(0)) {
					throw new Error("A DirectX .x string token contains an embedded null byte.");
				}
				stringValue = meaningful.toString("utf-8");
				if (cursor + 4 > buffer.length) {
					throw new Error("A DirectX .x string token is missing its DWORD terminator.");
				}
				terminator = buffer.readUInt32LE(cursor);
				if (terminator !== 19 && terminator !== 20) {
					throw new Error("A DirectX .x string token has an invalid comma/semicolon terminator.");
				}
				cursor += 4;
			}
		} else if (type === X_TOKEN_INTEGER) {
			cursor += 4;
		} else if (type === X_TOKEN_GUID) {
			cursor += 16;
		} else if (type === X_TOKEN_INTEGER_LIST || type === X_TOKEN_FLOAT_LIST) {
			if (cursor + 4 > buffer.length) {
				throw new Error("A DirectX .x list token is missing its element count.");
			}
			const count = buffer.readUInt32LE(cursor);
			cursor += 4;
			const elementBytes = type === X_TOKEN_FLOAT_LIST ? floatBytes : 4;
			if (count > Math.floor((buffer.length - cursor) / elementBytes)) {
				throw new Error("A DirectX .x list token exceeds the remaining stream boundary.");
			}
			cursor += count * elementBytes;
		} else if (!X_STANDALONE_TOKENS.has(type)) {
			throw new Error(`The DirectX .x binary stream contains unsupported token ${type}.`);
		}
		if (cursor > buffer.length) {
			throw new Error("A DirectX .x binary token exceeds the stream boundary.");
		}
		tokens.push({ type, raw: Buffer.from(buffer.subarray(start, cursor)), name, stringValue, trailingNullBytes, terminator });
	}
	return tokens;
}

function findXBinaryTextureTokens(tokens: IXBinaryToken[]): IXBinaryToken[] {
	const results: IXBinaryToken[] = [];
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type !== X_TOKEN_NAME || tokens[index].name !== "TextureFilename" || tokens[index - 1]?.type === X_TOKEN_TEMPLATE) {
			continue;
		}
		let cursor = index + 1;
		if (tokens[cursor]?.type === X_TOKEN_NAME) {
			cursor++;
		}
		if (tokens[cursor]?.type !== X_TOKEN_OBRACE) {
			continue;
		}
		let depth = 1;
		for (cursor++; cursor < tokens.length && depth > 0; cursor++) {
			if (tokens[cursor].type === X_TOKEN_OBRACE) {
				depth++;
			} else if (tokens[cursor].type === X_TOKEN_CBRACE) {
				depth--;
			} else if (depth === 1 && tokens[cursor].type === X_TOKEN_STRING && tokens[cursor].stringValue !== undefined) {
				results.push(tokens[cursor]);
				break;
			}
		}
	}
	return results;
}

function encodeXBinaryToken(token: IXBinaryToken): Buffer {
	if (token.type !== X_TOKEN_STRING || token.stringValue === undefined) {
		return token.raw;
	}
	const value = Buffer.from(token.stringValue, "utf-8");
	const payload = Buffer.concat([value, Buffer.alloc(token.trailingNullBytes ?? 0)]);
	if (payload.length > MAX_BINARY_MODEL_STRING_BYTES) {
		throw new Error("A rewritten DirectX .x texture path exceeds the 1 MiB token limit.");
	}
	const header = Buffer.alloc(6);
	header.writeUInt16LE(X_TOKEN_STRING, 0);
	header.writeUInt32LE(payload.length, 2);
	const terminator = Buffer.alloc(4);
	terminator.writeUInt32LE(token.terminator ?? X_TOKEN_SEMICOLON);
	return Buffer.concat([header, payload, terminator]);
}

/** Extracts semantic TextureFilename values from uncompressed DirectX text or binary streams. */
export function extractXReferences(buffer: Buffer): { values: string[]; error?: string } {
	try {
		const header = parseXHeader(buffer);
		return header.format === "text"
			? { values: extractXTextReferences(buffer.toString("utf-8", X_HEADER_BYTES)).map((reference) => reference.value) }
			: { values: findXBinaryTextureTokens(parseXBinaryTokens(buffer, header.floatBytes)).map((token) => token.stringValue!) };
	} catch (error) {
		return { values: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rewrites only semantic DirectX TextureFilename values while preserving unrelated text or token records. */
export function rewriteXReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		const header = parseXHeader(buffer);
		let replacementCount = 0;
		let semanticMatchCount = 0;
		if (header.format === "text") {
			const content = buffer.toString("utf-8", X_HEADER_BYTES);
			const references = extractXTextReferences(content);
			let rewrittenContent = content;
			for (const reference of [...references].reverse()) {
				const rewritten = rewrite(reference.value);
				if (rewritten === null) {
					continue;
				}
				semanticMatchCount++;
				if (rewritten !== reference.value) {
					rewrittenContent = `${rewrittenContent.slice(0, reference.start)}${encodeXTextString(rewritten)}${rewrittenContent.slice(reference.end)}`;
					replacementCount++;
				}
			}
			return replacementCount
				? { buffer: Buffer.concat([Buffer.from(buffer.subarray(0, X_HEADER_BYTES)), Buffer.from(rewrittenContent, "utf-8")]), replacementCount, semanticMatchCount }
				: { buffer, replacementCount, semanticMatchCount };
		}
		const tokens = parseXBinaryTokens(buffer, header.floatBytes);
		for (const token of findXBinaryTextureTokens(tokens)) {
			const rewritten = rewrite(token.stringValue!);
			if (rewritten === null) {
				continue;
			}
			semanticMatchCount++;
			if (rewritten !== token.stringValue) {
				token.stringValue = rewritten;
				replacementCount++;
			}
		}
		return replacementCount
			? { buffer: Buffer.concat([Buffer.from(buffer.subarray(0, X_HEADER_BYTES)), ...tokens.map(encodeXBinaryToken)]), replacementCount, semanticMatchCount }
			: { buffer, replacementCount, semanticMatchCount };
	} catch (error) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function readLwoTag(buffer: Buffer, offset: number, label: string): string {
	if (offset + 4 > buffer.length) {
		throw new Error(`The LWO ${label} FourCC is truncated.`);
	}
	const bytes = buffer.subarray(offset, offset + 4);
	if ([...bytes].some((value) => value < 0x20 || value > 0x7e)) {
		throw new Error(`The LWO ${label} FourCC contains non-printable bytes.`);
	}
	return bytes.toString("ascii");
}

function parseLwoChunks(buffer: Buffer, start: number, limit: number, lengthBytes: 2 | 4, count: { value: number }): ILwoChunk[] {
	const chunks: ILwoChunk[] = [];
	let cursor = start;
	const headerBytes = 4 + lengthBytes;
	while (cursor < limit) {
		if (cursor + headerBytes > limit || ++count.value > MAX_LWO_CHUNKS) {
			throw new Error(`The LWO ${lengthBytes === 2 ? "subchunk" : "chunk"} table is truncated or exceeds ${MAX_LWO_CHUNKS.toLocaleString()} entries.`);
		}
		const tag = readLwoTag(buffer, cursor, lengthBytes === 2 ? "subchunk" : "chunk");
		const length = lengthBytes === 2 ? buffer.readUInt16BE(cursor + 4) : buffer.readUInt32BE(cursor + 4);
		const payloadStart = cursor + headerBytes;
		const payloadEnd = payloadStart + length;
		const paddedEnd = payloadEnd + (length & 1);
		if (payloadEnd < payloadStart || paddedEnd > limit) {
			throw new Error(`The LWO ${tag} ${lengthBytes === 2 ? "subchunk" : "chunk"} length exceeds its containing boundary.`);
		}
		const chunk: ILwoChunk = {
			tag,
			payload: Buffer.from(buffer.subarray(payloadStart, payloadEnd)),
			...(length & 1 ? { padByte: buffer[payloadEnd] } : {}),
		};
		if (lengthBytes === 4 && tag === "FORM") {
			if (chunk.payload.length < 4) {
				throw new Error("A nested LWO FORM chunk is missing its form type.");
			}
			chunk.formType = readLwoTag(chunk.payload, 0, "nested form type");
			chunk.formPayload = Buffer.from(chunk.payload.subarray(4));
		}
		chunks.push(chunk);
		cursor = paddedEnd;
	}
	if (cursor !== limit) {
		throw new Error("The LWO chunk table does not end at its declared boundary.");
	}
	return chunks;
}

function encodeLwoChunks(chunks: ILwoChunk[], lengthBytes: 2 | 4): Buffer {
	return Buffer.concat(
		chunks.map((chunk) => {
			const payload = chunk.formType !== undefined ? Buffer.concat([Buffer.from(chunk.formType, "ascii"), chunk.formPayload ?? Buffer.alloc(0)]) : chunk.payload;
			const maximum = lengthBytes === 2 ? 0xffff : 0xffffffff;
			if (payload.length > maximum) {
				throw new Error(`A rewritten LWO ${chunk.tag} ${lengthBytes === 2 ? "subchunk" : "chunk"} exceeds its ${lengthBytes * 8}-bit length limit.`);
			}
			const header = Buffer.alloc(4 + lengthBytes);
			header.write(chunk.tag, 0, 4, "ascii");
			if (lengthBytes === 2) {
				header.writeUInt16BE(payload.length, 4);
			} else {
				header.writeUInt32BE(payload.length, 4);
			}
			return payload.length & 1 ? Buffer.concat([header, payload, Buffer.from([chunk.padByte ?? 0])]) : Buffer.concat([header, payload]);
		})
	);
}

function parseLwoDocument(buffer: Buffer): ILwoDocument {
	if (buffer.length < 12 || buffer.subarray(0, 4).toString("ascii") !== "FORM") {
		throw new Error("The LWO IFF FORM header is missing.");
	}
	const declaredLength = buffer.readUInt32BE(4);
	if (declaredLength !== buffer.length - 8) {
		throw new Error(`The LWO FORM declares ${declaredLength} bytes but the file contains ${buffer.length - 8}.`);
	}
	const formType = readLwoTag(buffer, 8, "root form type");
	if (formType !== "LWOB" && formType !== "LWO2" && formType !== "LWO3" && formType !== "LXOB") {
		throw new Error(`LWO form type ${JSON.stringify(formType)} is unsupported; expected LWOB, LWO2, LWO3, or LXOB.`);
	}
	return { formType, chunks: parseLwoChunks(buffer, 12, buffer.length, 4, { value: 0 }) };
}

function encodeLwoDocument(document: ILwoDocument): Buffer {
	const body = Buffer.concat([Buffer.from(document.formType, "ascii"), encodeLwoChunks(document.chunks, 4)]);
	if (body.length > 0xffffffff) {
		throw new Error("A rewritten LWO FORM exceeds its 32-bit length limit.");
	}
	const header = Buffer.alloc(8);
	header.write("FORM", 0, 4, "ascii");
	header.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, body]);
}

function readLwoString(buffer: Buffer, offset: number, limit = buffer.length): ILwoString {
	if (offset < 0 || offset >= limit || limit > buffer.length) {
		throw new Error("An LWO string starts outside its containing chunk.");
	}
	const zero = buffer.indexOf(0, offset);
	if (zero < 0 || zero >= limit || zero - offset > MAX_BINARY_MODEL_STRING_BYTES) {
		throw new Error("An LWO string is missing its bounded null terminator.");
	}
	const bytes = buffer.subarray(offset, zero);
	const utf8 = bytes.toString("utf-8");
	const encoding: LwoStringEncoding = Buffer.from(utf8, "utf-8").equals(bytes) ? "utf8" : "latin1";
	const value = encoding === "utf8" ? utf8 : bytes.toString("latin1");
	let end = zero + 1;
	if ((end - offset) & 1) {
		if (end >= limit || buffer[end] !== 0) {
			throw new Error("An odd-length LWO string is missing its null padding byte.");
		}
		end++;
	}
	return { value, encoding, end };
}

function encodeLwoString(value: string, encoding: LwoStringEncoding): Buffer {
	if (value.includes("\0")) {
		throw new Error("A rewritten LWO path cannot contain a null character.");
	}
	const bytes = Buffer.from(value, encoding);
	if (bytes.length > MAX_BINARY_MODEL_STRING_BYTES || (encoding === "latin1" && bytes.toString("latin1") !== value)) {
		throw new Error("A rewritten LWO path exceeds 1 MiB or cannot be represented in its source string encoding.");
	}
	const terminated = Buffer.concat([bytes, Buffer.from([0])]);
	return terminated.length & 1 ? Buffer.concat([terminated, Buffer.from([0])]) : terminated;
}

function rewriteLwoPath(value: string, rewrite: ((value: string) => string | null) | undefined): { value: string; semanticMatchCount: number; replacementCount: number } {
	if (!rewrite) {
		return { value, semanticMatchCount: 0, replacementCount: 0 };
	}
	const rewritten = rewrite(value);
	if (rewritten === null) {
		return { value, semanticMatchCount: 0, replacementCount: 0 };
	}
	return { value: rewritten, semanticMatchCount: 1, replacementCount: rewritten === value ? 0 : 1 };
}

function formatLwoSequenceNumber(value: number, digits: number): string {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("An LWO ISEQ frame number is negative or outside the safe integer range.");
	}
	const result = value.toString(10);
	if (result.length > digits) {
		throw new Error("An LWO ISEQ frame number exceeds its fixed digit count.");
	}
	return result.padStart(digits, "0");
}

function resolveLwoSequencePattern(values: string[], numbers: string[]): { prefix: string; suffix: string } {
	const candidates: Array<{ prefix: string; suffix: string }> = [];
	let offset = 0;
	while (offset <= values[0].length - numbers[0].length) {
		const index = values[0].indexOf(numbers[0], offset);
		if (index < 0) {
			break;
		}
		const prefix = values[0].slice(0, index);
		const suffix = values[0].slice(index + numbers[0].length);
		if (values.every((value, valueIndex) => value === `${prefix}${numbers[valueIndex]}${suffix}`)) {
			candidates.push({ prefix, suffix });
		}
		offset = index + 1;
	}
	if (candidates.length !== 1) {
		throw new LwoSemanticRewriteError(
			"An LWO ISEQ move must preserve one unambiguous shared prefix and suffix for every frame. Move the complete sequence directory or rename the full numbered set together."
		);
	}
	return candidates[0];
}

function processLwoSourceChunk(tag: string, payload: Buffer, rewrite?: (value: string) => string | null): ILwoReferenceProcessResult {
	if (tag === "XREF") {
		if (payload.length < 5) {
			throw new Error("The LWO XREF source is truncated.");
		}
		const name = readLwoString(payload, 4);
		if (name.end !== payload.length) {
			throw new Error("The LWO XREF source contains trailing bytes after its instance name.");
		}
		return { payload, values: [], replacementCount: 0, semanticMatchCount: 0 };
	}
	if (tag === "ISEQ") {
		if (payload.length < 14) {
			throw new Error("The LWO ISEQ source is truncated.");
		}
		const digits = payload.readUInt8(0);
		const frameOffset = payload.readInt16BE(2);
		const start = payload.readInt16BE(6);
		const end = payload.readInt16BE(8);
		if (digits < 1 || digits > MAX_LWO_SEQUENCE_DIGITS) {
			throw new Error(`The LWO ISEQ digit count must be between 1 and ${MAX_LWO_SEQUENCE_DIGITS}.`);
		}
		const frameCount = end - start + 1;
		if (frameCount < 1 || frameCount > MAX_LWO_SEQUENCE_FRAMES) {
			throw new Error(`The LWO ISEQ range must contain between 1 and ${MAX_LWO_SEQUENCE_FRAMES.toLocaleString()} frames.`);
		}
		const prefix = readLwoString(payload, 10);
		const suffix = readLwoString(payload, prefix.end);
		if (suffix.end !== payload.length) {
			throw new Error("The LWO ISEQ source contains trailing bytes after its suffix.");
		}
		const numbers = Array.from({ length: frameCount }, (_, index) => formatLwoSequenceNumber(start + index + frameOffset, digits));
		const values = numbers.map((number) => `${prefix.value}${number}${suffix.value}`);
		if (!rewrite) {
			return { payload, values, replacementCount: 0, semanticMatchCount: 0 };
		}
		let semanticMatchCount = 0;
		let replacementCount = 0;
		const rewrittenValues = values.map((value) => {
			const result = rewriteLwoPath(value, rewrite);
			semanticMatchCount += result.semanticMatchCount;
			replacementCount += result.replacementCount;
			return result.value;
		});
		if (!replacementCount) {
			return { payload, values, replacementCount, semanticMatchCount };
		}
		const pattern = resolveLwoSequencePattern(rewrittenValues, numbers);
		return {
			payload: Buffer.concat([payload.subarray(0, 10), encodeLwoString(pattern.prefix, prefix.encoding), encodeLwoString(pattern.suffix, suffix.encoding)]),
			values,
			replacementCount,
			semanticMatchCount,
		};
	}
	let stringOffset: number;
	if (tag === "STIL" || tag === "ANIM") {
		stringOffset = 0;
	} else if (tag === "STCC") {
		if (payload.length < 5) {
			throw new Error("The LWO STCC source is truncated.");
		}
		stringOffset = 4;
	} else {
		throw new Error(`The first LWO CLIP source ${JSON.stringify(tag)} is unsupported; expected STIL, ISEQ, ANIM, XREF, or STCC.`);
	}
	const path = readLwoString(payload, stringOffset);
	if (tag === "ANIM") {
		const server = readLwoString(payload, path.end);
		if (server.end + 2 > payload.length) {
			throw new Error("The LWO ANIM source is missing its flags field.");
		}
	} else if (path.end !== payload.length) {
		throw new Error(`The LWO ${tag} source contains trailing bytes after its filename.`);
	}
	const result = rewriteLwoPath(path.value, rewrite);
	return {
		payload:
			result.replacementCount > 0 ? Buffer.concat([payload.subarray(0, stringOffset), encodeLwoString(result.value, path.encoding), payload.subarray(path.end)]) : payload,
		values: [path.value],
		replacementCount: result.replacementCount,
		semanticMatchCount: result.semanticMatchCount,
	};
}

function processLwoClip(payload: Buffer, lengthBytes: 2 | 4, rewrite?: (value: string) => string | null): ILwoReferenceProcessResult {
	if (payload.length < 4 + 4 + lengthBytes) {
		throw new Error("The LWO CLIP chunk is truncated before its source chunk.");
	}
	const chunks = parseLwoChunks(payload, 4, payload.length, lengthBytes, { value: 0 });
	if (!chunks.length) {
		throw new Error("The LWO CLIP chunk has no source chunk.");
	}
	const result = processLwoSourceChunk(chunks[0].tag, chunks[0].payload, rewrite);
	if (result.replacementCount) {
		chunks[0].payload = result.payload;
	}
	return {
		...result,
		payload: result.replacementCount ? Buffer.concat([payload.subarray(0, 4), encodeLwoChunks(chunks, lengthBytes)]) : payload,
	};
}

function processLwobSurface(payload: Buffer, rewrite?: (value: string) => string | null): ILwoReferenceProcessResult {
	const surfaceName = readLwoString(payload, 0);
	const chunks = parseLwoChunks(payload, surfaceName.end, payload.length, 2, { value: 0 });
	const values: string[] = [];
	let replacementCount = 0;
	let semanticMatchCount = 0;
	for (const chunk of chunks) {
		if (chunk.tag !== "TIMG") {
			continue;
		}
		const path = readLwoString(chunk.payload, 0);
		if (path.end !== chunk.payload.length) {
			throw new Error("An LWOB TIMG subchunk contains trailing bytes after its filename.");
		}
		if (values.length >= MAX_LWO_REFERENCES) {
			throw new Error(`The LWOB surface contains more than ${MAX_LWO_REFERENCES.toLocaleString()} texture references.`);
		}
		values.push(path.value);
		const result = rewriteLwoPath(path.value, rewrite);
		semanticMatchCount += result.semanticMatchCount;
		replacementCount += result.replacementCount;
		if (result.replacementCount) {
			chunk.payload = encodeLwoString(result.value, path.encoding);
		}
	}
	return {
		payload: replacementCount ? Buffer.concat([payload.subarray(0, surfaceName.end), encodeLwoChunks(chunks, 2)]) : payload,
		values,
		replacementCount,
		semanticMatchCount,
	};
}

function processLwoDocument(document: ILwoDocument, rewrite?: (value: string) => string | null): { values: string[]; replacementCount: number; semanticMatchCount: number } {
	const values: string[] = [];
	let replacementCount = 0;
	let semanticMatchCount = 0;
	for (const chunk of document.chunks) {
		let result: ILwoReferenceProcessResult | null = null;
		if (document.formType === "LWOB" && chunk.tag === "SURF") {
			result = processLwobSurface(chunk.payload, rewrite);
			if (result.replacementCount) {
				chunk.payload = result.payload;
			}
		} else if ((document.formType === "LWO2" || document.formType === "LXOB") && chunk.tag === "CLIP") {
			result = processLwoClip(chunk.payload, 2, rewrite);
			if (result.replacementCount) {
				chunk.payload = result.payload;
			}
		} else if (document.formType === "LWO3" && chunk.tag === "CLIP") {
			result = processLwoClip(chunk.payload, 4, rewrite);
			if (result.replacementCount) {
				chunk.payload = result.payload;
			}
		} else if (document.formType === "LWO3" && chunk.tag === "FORM" && chunk.formType === "CLIP") {
			result = processLwoClip(chunk.formPayload ?? Buffer.alloc(0), 4, rewrite);
			if (result.replacementCount) {
				chunk.formPayload = result.payload;
			}
		}
		if (!result) {
			continue;
		}
		if (values.length + result.values.length > MAX_LWO_REFERENCES) {
			throw new Error(`The LWO file contains more than ${MAX_LWO_REFERENCES.toLocaleString()} external references.`);
		}
		values.push(...result.values);
		replacementCount += result.replacementCount;
		semanticMatchCount += result.semanticMatchCount;
	}
	return { values, replacementCount, semanticMatchCount };
}

/** Extracts exact LWOB TIMG and LWO2/LWO3/LXOB CLIP source filenames, including bounded ISEQ members. */
export function extractLwoReferences(buffer: Buffer): { values: string[]; error?: string } {
	try {
		const document = parseLwoDocument(buffer);
		return { values: processLwoDocument(document).values };
	} catch (error) {
		return { values: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rebuilds big-endian LWO chunks and padding while changing only semantic external image source filenames. */
export function rewriteLwoReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		const document = parseLwoDocument(buffer);
		const result = processLwoDocument(document, rewrite);
		return {
			buffer: result.replacementCount ? encodeLwoDocument(document) : buffer,
			replacementCount: result.replacementCount,
			semanticMatchCount: result.semanticMatchCount,
		};
	} catch (error) {
		return {
			buffer,
			replacementCount: 0,
			semanticMatchCount: 0,
			error: error instanceof Error ? error.message : String(error),
			errorKind: error instanceof LwoSemanticRewriteError ? "semanticMismatch" : "malformed",
		};
	}
}

function decodeDxfLine(bytes: Buffer): { value: string; encoding: DxfStringEncoding } {
	const utf8 = bytes.toString("utf-8");
	const encoding: DxfStringEncoding = Buffer.from(utf8, "utf-8").equals(bytes) ? "utf8" : "latin1";
	return { value: encoding === "utf8" ? utf8 : bytes.toString("latin1"), encoding };
}

function readDxfLines(buffer: Buffer): IDxfLine[] {
	const lines: IDxfLine[] = [];
	let cursor = 0;
	while (cursor < buffer.length) {
		const start = cursor;
		while (cursor < buffer.length && buffer[cursor] !== 0x0a && buffer[cursor] !== 0x0d) {
			cursor++;
		}
		const end = cursor;
		if (end - start > MAX_DXF_LINE_BYTES) {
			throw new Error(`A DXF line exceeds the ${MAX_DXF_LINE_BYTES.toLocaleString()}-byte safety limit.`);
		}
		const decoded = decodeDxfLine(buffer.subarray(start, end));
		lines.push({ start, end, ...decoded });
		if (cursor < buffer.length && buffer[cursor] === 0x0d) {
			cursor++;
			if (cursor < buffer.length && buffer[cursor] === 0x0a) {
				cursor++;
			}
		} else if (cursor < buffer.length) {
			cursor++;
		}
	}
	return lines;
}

function parseDxfPairs(buffer: Buffer): IDxfPair[] {
	if (buffer.subarray(0, DXF_BINARY_SENTINEL.length).equals(DXF_BINARY_SENTINEL)) {
		throw new Error("Binary DXF is unsupported because the editor's Assimp importer accepts only ASCII DXF.");
	}
	if (buffer.includes(0)) {
		throw new Error("An ASCII DXF file contains an unexpected null byte.");
	}
	const lines = readDxfLines(buffer);
	const pairs: IDxfPair[] = [];
	let index = 0;
	let foundEof = false;
	while (index < lines.length) {
		if (foundEof) {
			if (lines[index].value.trim()) {
				throw new Error("A DXF file contains data after its EOF record.");
			}
			index++;
			continue;
		}
		if (index + 1 >= lines.length) {
			throw new Error("A DXF group code is missing its paired value line.");
		}
		const codeText = lines[index].value.trim();
		if (!/^-?\d+$/.test(codeText)) {
			throw new Error(`DXF group code ${JSON.stringify(codeText)} is not an integer.`);
		}
		const code = Number(codeText);
		if (!Number.isSafeInteger(code) || code < -5 || code > 1071) {
			throw new Error(`DXF group code ${codeText} is outside the documented -5 through 1071 range.`);
		}
		if (pairs.length >= MAX_DXF_PAIRS) {
			throw new Error(`A DXF file exceeds the ${MAX_DXF_PAIRS.toLocaleString()}-pair safety limit.`);
		}
		const valueLine = lines[index + 1];
		pairs.push({ code, valueLine });
		foundEof = code === 0 && valueLine.value.trim().toUpperCase() === "EOF";
		index += 2;
	}
	if (!foundEof) {
		throw new Error("A DXF file is missing its final 0/EOF record.");
	}
	return pairs;
}

function dxfSemanticReferencePairIndices(pairs: IDxfPair[]): number[] {
	const directPathRecords = new Set(["IMAGEDEF", "UNDERLAYDEFINITION", "PDFDEFINITION", "DWFDEFINITION", "DGNDEFINITION", "ACDBNAVISWORKSMODELDEF", "NAVISWORKSMODELDEF"]);
	const result: number[] = [];
	let recordStart = -1;
	const processRecord = (start: number, end: number): void => {
		if (start < 0) {
			return;
		}
		const recordType = pairs[start].valueLine.value.trim().toUpperCase();
		const values = pairs.slice(start + 1, end);
		let isReferenceRecord = directPathRecords.has(recordType);
		if (recordType === "BLOCK") {
			const flagsPair = values.find((pair) => pair.code === 70);
			const flagsText = flagsPair?.valueLine.value.trim() ?? "";
			if (flagsText && !/^-?\d+$/.test(flagsText)) {
				throw new Error(`A DXF BLOCK has invalid group-70 flags ${JSON.stringify(flagsText)}.`);
			}
			const flags = flagsText ? Number(flagsText) : 0;
			isReferenceRecord = Number.isSafeInteger(flags) && (flags & 0x0c) !== 0;
		}
		if (!isReferenceRecord) {
			return;
		}
		const pathOffsets = values.map((pair, offset) => ({ pair, index: start + 1 + offset })).filter(({ pair }) => pair.code === 1);
		const semanticPaths = pathOffsets.filter(({ pair }) => pair.valueLine.value.trim());
		if (!semanticPaths.length) {
			throw new Error(`DXF ${recordType} is an external-reference record but has no non-empty group-1 path.`);
		}
		if (semanticPaths.length > 1) {
			throw new Error(`DXF ${recordType} contains multiple group-1 paths and cannot be interpreted unambiguously.`);
		}
		result.push(semanticPaths[0].index);
	};
	for (let index = 0; index < pairs.length; index++) {
		if (pairs[index].code !== 0) {
			continue;
		}
		processRecord(recordStart, index);
		recordStart = index;
	}
	processRecord(recordStart, pairs.length);
	if (result.length > MAX_DXF_REFERENCES) {
		throw new Error(`A DXF file contains more than ${MAX_DXF_REFERENCES.toLocaleString()} external references.`);
	}
	return result;
}

function encodeDxfValue(value: string, encoding: DxfStringEncoding): Buffer {
	if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
		throw new Error("A rewritten DXF path cannot contain null or newline characters.");
	}
	const bytes = Buffer.from(value, encoding === "utf8" ? "utf-8" : "latin1");
	if (bytes.length > MAX_DXF_PATH_BYTES || (encoding === "latin1" && bytes.toString("latin1") !== value)) {
		throw new Error(`A rewritten DXF path exceeds ${MAX_DXF_PATH_BYTES.toLocaleString()} bytes or cannot be represented in its source encoding.`);
	}
	return bytes;
}

function processDxfReferences(
	buffer: Buffer,
	rewrite?: (value: string) => string | null
): { buffer: Buffer; values: string[]; replacementCount: number; semanticMatchCount: number } {
	const pairs = parseDxfPairs(buffer);
	const indices = dxfSemanticReferencePairIndices(pairs);
	const values: string[] = [];
	const replacements: IDxfReplacement[] = [];
	let replacementCount = 0;
	let semanticMatchCount = 0;
	for (const index of indices) {
		const line = pairs[index].valueLine;
		const leading = line.value.match(/^[ \t]*/)?.[0] ?? "";
		const trailing = line.value.match(/[ \t]*$/)?.[0] ?? "";
		const value = line.value.slice(leading.length, line.value.length - trailing.length);
		if (Buffer.byteLength(value, line.encoding === "utf8" ? "utf-8" : "latin1") > MAX_DXF_PATH_BYTES) {
			throw new Error(`A DXF external-reference path exceeds ${MAX_DXF_PATH_BYTES.toLocaleString()} bytes.`);
		}
		values.push(value);
		if (!rewrite) {
			continue;
		}
		const rewritten = rewrite(value);
		if (rewritten === null) {
			continue;
		}
		semanticMatchCount++;
		if (rewritten === value) {
			continue;
		}
		replacementCount++;
		replacements.push({ start: line.start, end: line.end, data: encodeDxfValue(`${leading}${rewritten}${trailing}`, line.encoding) });
	}
	if (!replacements.length) {
		return { buffer, values, replacementCount, semanticMatchCount };
	}
	const chunks: Buffer[] = [];
	let cursor = 0;
	for (const replacement of replacements) {
		chunks.push(buffer.subarray(cursor, replacement.start), replacement.data);
		cursor = replacement.end;
	}
	chunks.push(buffer.subarray(cursor));
	return { buffer: Buffer.concat(chunks), values, replacementCount, semanticMatchCount };
}

/** Extracts exact ASCII DXF BLOCK xrefs, raster images, underlays, and Navisworks coordination-model paths. */
export function extractDxfReferences(buffer: Buffer): { values: string[]; error?: string } {
	try {
		return { values: processDxfReferences(buffer).values };
	} catch (error) {
		return { values: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rewrites only documented external-reference group-1 values in a bounded ASCII DXF pair stream. */
export function rewriteDxfReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		const result = processDxfReferences(buffer, rewrite);
		return { buffer: result.buffer, replacementCount: result.replacementCount, semanticMatchCount: result.semanticMatchCount };
	} catch (error) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: error instanceof Error ? error.message : String(error), errorKind: "malformed" };
	}
}

type BlendCompression = "none" | "gzip" | "zstd";

export interface IBlendFileInspection {
	compression: BlendCompression;
	version: number;
	pointerSize: 4 | 8;
	littleEndian: boolean;
}

interface IBlendBlock {
	code: string;
	payloadOffset: number;
	payloadLength: number;
	sdnaIndex: number;
	count: number;
}

interface IBlendDnaField {
	name: string;
	baseName: string;
	typeName: string;
	offset: number;
	size: number;
	arrayElements: number;
	pointer: boolean;
}

interface IBlendDnaStructure {
	name: string;
	size: number;
	fields: IBlendDnaField[];
}

interface IBlendDocument {
	original: Buffer;
	raw: Buffer;
	inspection: IBlendFileInspection;
	blocks: IBlendBlock[];
	structures: IBlendDnaStructure[];
}

interface IBlendReference {
	offset: number;
	capacity: number;
	value: string;
}

interface IBlendSemanticField {
	field: string;
	packedFields?: string[];
}

const BLEND_SEMANTIC_FIELDS: Readonly<Record<string, readonly IBlendSemanticField[]>> = {
	Image: [{ field: "name", packedFields: ["packedfile", "packedfiles"] }],
	VFont: [{ field: "name", packedFields: ["packedfile"] }],
	bSound: [{ field: "name", packedFields: ["packedfile", "newpackedfile"] }],
	Library: [{ field: "name", packedFields: ["packedfile"] }],
	MovieClip: [{ field: "name" }],
	CacheFile: [{ field: "filepath" }],
	Volume: [{ field: "filepath", packedFields: ["packedfile"] }],
	LibraryWeakReference: [{ field: "library_filepath" }],
	ImageView: [{ field: "filepath" }],
	VoxelData: [{ field: "source_path" }],
	MeshCacheModifierData: [{ field: "filepath" }],
	FluidsimSettings: [{ field: "surfdataPath" }],
	NodeShaderScript: [{ field: "filepath" }],
	NodeShaderTexIES: [{ field: "filepath" }],
	Brush: [{ field: "icon_filepath" }],
	CustomDataExternal: [{ field: "filename" }],
};

class BlendRewriteError extends Error {
	public constructor(
		message: string,
		public readonly kind: "malformed" | "semanticMismatch" = "malformed"
	) {
		super(message);
	}
}

function blendCompression(buffer: Buffer): BlendCompression {
	if (buffer.subarray(0, BLEND_MAGIC.length).equals(BLEND_MAGIC)) {
		return "none";
	}
	if (buffer.subarray(0, BLEND_GZIP_MAGIC.length).equals(BLEND_GZIP_MAGIC)) {
		return "gzip";
	}
	if (buffer.subarray(0, BLEND_ZSTD_MAGIC.length).equals(BLEND_ZSTD_MAGIC)) {
		return "zstd";
	}
	throw new BlendRewriteError("The Blender file has no BLENDER, GZip, or Zstandard header.");
}

function decompressBlend(buffer: Buffer, compression: BlendCompression): Buffer {
	try {
		const decompressZstd = (): Buffer => {
			const chunks: Buffer[] = [];
			let total = 0;
			const stream = new ZstdDecompress((chunk) => {
				total += chunk.byteLength;
				if (total > MAX_BLEND_EXPANDED_BYTES) {
					throw new BlendRewriteError(`The expanded Blender file exceeds ${MAX_BLEND_EXPANDED_BYTES.toLocaleString()} bytes.`);
				}
				chunks.push(Buffer.from(chunk));
			});
			stream.push(buffer, true);
			return Buffer.concat(chunks, total);
		};
		const raw = compression === "none" ? buffer : compression === "gzip" ? gunzipSync(buffer, { maxOutputLength: MAX_BLEND_EXPANDED_BYTES }) : decompressZstd();
		if (raw.length > MAX_BLEND_EXPANDED_BYTES) {
			throw new BlendRewriteError(`The expanded Blender file exceeds ${MAX_BLEND_EXPANDED_BYTES.toLocaleString()} bytes.`);
		}
		return raw;
	} catch (error) {
		if (error instanceof BlendRewriteError) {
			throw error;
		}
		throw new BlendRewriteError(`The ${compression === "gzip" ? "GZip" : "Zstandard"} Blender stream could not be decompressed within the bounded limit.`);
	}
}

function readBlendUInt16(buffer: Buffer, offset: number, littleEndian: boolean): number {
	if (offset < 0 || offset + 2 > buffer.length) {
		throw new BlendRewriteError("The Blender DNA table is truncated while reading a 16-bit value.");
	}
	return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readBlendUInt32(buffer: Buffer, offset: number, littleEndian: boolean): number {
	if (offset < 0 || offset + 4 > buffer.length) {
		throw new BlendRewriteError("The Blender block or DNA table is truncated while reading a 32-bit value.");
	}
	return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function blendArrayElements(name: string): number {
	let result = 1;
	for (const match of name.matchAll(/\[(\d+)\]/g)) {
		const dimension = Number(match[1]);
		if (!Number.isSafeInteger(dimension) || dimension <= 0 || result > Math.floor(MAX_BLEND_ARRAY_ELEMENTS / dimension)) {
			throw new BlendRewriteError(`Blender DNA field ${JSON.stringify(name)} has an invalid or oversized array declaration.`);
		}
		result *= dimension;
	}
	return result;
}

function blendBaseFieldName(name: string): string {
	return name
		.replace(/\[[^\]]*\]/g, "")
		.replace(/[()*]/g, "")
		.trim();
}

function parseBlendDna(payload: Buffer, pointerSize: 4 | 8, littleEndian: boolean): IBlendDnaStructure[] {
	let cursor = 0;
	const readTag = (expected: string): void => {
		if (cursor + 4 > payload.length || payload.toString("ascii", cursor, cursor + 4) !== expected) {
			throw new BlendRewriteError(`The Blender DNA table is missing its ${expected} section.`);
		}
		cursor += 4;
	};
	const readCount = (maximum: number, label: string): number => {
		const count = readBlendUInt32(payload, cursor, littleEndian);
		cursor += 4;
		if (count > maximum) {
			throw new BlendRewriteError(`The Blender DNA table declares more than ${maximum.toLocaleString()} ${label}.`);
		}
		return count;
	};
	const readStrings = (count: number, label: string): string[] => {
		const values: string[] = [];
		for (let index = 0; index < count; index++) {
			const zero = payload.indexOf(0, cursor);
			if (zero < cursor || zero - cursor > MAX_DXF_LINE_BYTES) {
				throw new BlendRewriteError(`A Blender DNA ${label} is missing its bounded null terminator.`);
			}
			const bytes = payload.subarray(cursor, zero);
			const value = bytes.toString("utf-8");
			if (!Buffer.from(value, "utf-8").equals(bytes)) {
				throw new BlendRewriteError(`A Blender DNA ${label} is not valid UTF-8.`);
			}
			values.push(value);
			cursor = zero + 1;
		}
		cursor = (cursor + 3) & ~3;
		if (cursor > payload.length) {
			throw new BlendRewriteError("The Blender DNA string table alignment exceeds its payload.");
		}
		return values;
	};

	readTag("SDNA");
	readTag("NAME");
	const names = readStrings(readCount(MAX_BLEND_DNA_NAMES, "field names"), "field name");
	readTag("TYPE");
	const types = readStrings(readCount(MAX_BLEND_DNA_TYPES, "type names"), "type name");
	readTag("TLEN");
	const typeLengths: number[] = [];
	for (let index = 0; index < types.length; index++) {
		typeLengths.push(readBlendUInt16(payload, cursor, littleEndian));
		cursor += 2;
	}
	cursor = (cursor + 3) & ~3;
	readTag("STRC");
	const structureCount = readCount(MAX_BLEND_DNA_STRUCTURES, "structures");
	const structures: IBlendDnaStructure[] = [];
	let totalFields = 0;
	for (let structureIndex = 0; structureIndex < structureCount; structureIndex++) {
		const typeIndex = readBlendUInt16(payload, cursor, littleEndian);
		const fieldCount = readBlendUInt16(payload, cursor + 2, littleEndian);
		cursor += 4;
		if (typeIndex >= types.length) {
			throw new BlendRewriteError("A Blender DNA structure references a missing type.");
		}
		totalFields += fieldCount;
		if (totalFields > MAX_BLEND_DNA_FIELDS) {
			throw new BlendRewriteError(`The Blender DNA table declares more than ${MAX_BLEND_DNA_FIELDS.toLocaleString()} fields.`);
		}
		const fields: IBlendDnaField[] = [];
		let fieldOffset = 0;
		for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
			const fieldTypeIndex = readBlendUInt16(payload, cursor, littleEndian);
			const fieldNameIndex = readBlendUInt16(payload, cursor + 2, littleEndian);
			cursor += 4;
			if (fieldTypeIndex >= types.length || fieldNameIndex >= names.length) {
				throw new BlendRewriteError("A Blender DNA field references a missing type or name.");
			}
			const name = names[fieldNameIndex];
			const pointer = name.includes("*");
			const arrayElements = blendArrayElements(name);
			const elementSize = pointer ? pointerSize : typeLengths[fieldTypeIndex];
			if (!elementSize || elementSize > MAX_BLEND_EXPANDED_BYTES || arrayElements > Math.floor(MAX_BLEND_EXPANDED_BYTES / elementSize)) {
				throw new BlendRewriteError(`Blender DNA field ${JSON.stringify(name)} has an invalid size.`);
			}
			const size = elementSize * arrayElements;
			fields.push({ name, baseName: blendBaseFieldName(name), typeName: types[fieldTypeIndex], offset: fieldOffset, size, arrayElements, pointer });
			fieldOffset += size;
		}
		const structureSize = typeLengths[typeIndex];
		if (fieldOffset !== structureSize) {
			throw new BlendRewriteError(`Blender DNA structure ${JSON.stringify(types[typeIndex])} fields occupy ${fieldOffset} bytes but TLEN declares ${structureSize}.`);
		}
		structures.push({ name: types[typeIndex], size: structureSize, fields });
	}
	if (cursor > payload.length) {
		throw new BlendRewriteError("The Blender DNA structure table exceeds its payload.");
	}
	return structures;
}

function parseBlendDocument(buffer: Buffer): IBlendDocument {
	const compression = blendCompression(buffer);
	const raw = decompressBlend(buffer, compression);
	if (raw.length < 12 || !raw.subarray(0, BLEND_MAGIC.length).equals(BLEND_MAGIC)) {
		throw new BlendRewriteError("The expanded Blender stream has no BLENDER header.");
	}
	const pointerMarker = String.fromCharCode(raw[7]);
	const pointerSize: 4 | 8 =
		pointerMarker === "_"
			? 4
			: pointerMarker === "-"
				? 8
				: (() => {
						throw new BlendRewriteError("The Blender header has an invalid pointer-size marker.");
					})();
	const endianMarker = String.fromCharCode(raw[8]);
	const littleEndian =
		endianMarker === "v"
			? true
			: endianMarker === "V"
				? false
				: (() => {
						throw new BlendRewriteError("The Blender header has an invalid byte-order marker.");
					})();
	const versionText = raw.toString("ascii", 9, 12);
	if (!/^\d{3}$/.test(versionText)) {
		throw new BlendRewriteError("The Blender header has an invalid three-digit version.");
	}
	const inspection: IBlendFileInspection = { compression, version: Number(versionText), pointerSize, littleEndian };
	const blocks: IBlendBlock[] = [];
	let cursor = 12;
	let foundEnd = false;
	const blockHeaderBytes = 16 + pointerSize;
	while (cursor < raw.length) {
		if (blocks.length >= MAX_BLEND_BLOCKS) {
			throw new BlendRewriteError(`The Blender file contains more than ${MAX_BLEND_BLOCKS.toLocaleString()} blocks.`);
		}
		if (cursor + blockHeaderBytes > raw.length) {
			throw new BlendRewriteError("The Blender block header table is truncated.");
		}
		const code = raw.toString("ascii", cursor, cursor + 4).replace(/\0+$/, "");
		const payloadLength = readBlendUInt32(raw, cursor + 4, littleEndian);
		const sdnaIndex = readBlendUInt32(raw, cursor + 8 + pointerSize, littleEndian);
		const count = readBlendUInt32(raw, cursor + 12 + pointerSize, littleEndian);
		const payloadOffset = cursor + blockHeaderBytes;
		if (payloadLength > MAX_BLEND_EXPANDED_BYTES || payloadOffset + payloadLength > raw.length) {
			throw new BlendRewriteError(`Blender block ${JSON.stringify(code)} has an oversized or truncated payload.`);
		}
		blocks.push({ code, payloadOffset, payloadLength, sdnaIndex, count });
		cursor = payloadOffset + payloadLength;
		if (code === "ENDB") {
			foundEnd = true;
			break;
		}
	}
	if (!foundEnd) {
		throw new BlendRewriteError("The Blender file has no terminal ENDB block.");
	}
	if (cursor !== raw.length && raw.subarray(cursor).some((value) => value !== 0)) {
		throw new BlendRewriteError("The Blender file contains non-zero bytes after its terminal ENDB block.");
	}
	const dnaBlocks = blocks.filter((block) => block.code === "DNA1");
	if (dnaBlocks.length !== 1) {
		throw new BlendRewriteError(`The Blender file must contain exactly one DNA1 block; found ${dnaBlocks.length}.`);
	}
	const dna = dnaBlocks[0];
	const structures = parseBlendDna(raw.subarray(dna.payloadOffset, dna.payloadOffset + dna.payloadLength), pointerSize, littleEndian);
	return { original: buffer, raw, inspection, blocks, structures };
}

function blendFieldHasData(raw: Buffer, baseOffset: number, field: IBlendDnaField | undefined): boolean {
	return !!field && raw.subarray(baseOffset + field.offset, baseOffset + field.offset + field.size).some((value) => value !== 0);
}

function collectBlendReferences(document: IBlendDocument): IBlendReference[] {
	const references: IBlendReference[] = [];
	for (const block of document.blocks) {
		if (block.code === "DNA1" || block.code === "ENDB") {
			continue;
		}
		const structure = document.structures[block.sdnaIndex];
		const semanticFields = structure && BLEND_SEMANTIC_FIELDS[structure.name];
		if (!semanticFields?.length || !block.count) {
			continue;
		}
		if (!structure.size || block.count > Math.floor(block.payloadLength / structure.size)) {
			throw new BlendRewriteError(`Blender block ${JSON.stringify(block.code)} cannot contain its declared ${block.count} ${structure.name} values.`);
		}
		for (let itemIndex = 0; itemIndex < block.count; itemIndex++) {
			const baseOffset = block.payloadOffset + itemIndex * structure.size;
			for (const semantic of semanticFields) {
				if (
					semantic.packedFields?.some((name) =>
						blendFieldHasData(
							document.raw,
							baseOffset,
							structure.fields.find((field) => field.baseName === name)
						)
					)
				) {
					continue;
				}
				const field = structure.fields.find((candidate) => candidate.baseName === semantic.field);
				if (!field || field.typeName !== "char" || field.pointer || field.arrayElements <= 1 || field.size > MAX_BINARY_MODEL_STRING_BYTES) {
					continue;
				}
				const bytes = document.raw.subarray(baseOffset + field.offset, baseOffset + field.offset + field.size);
				const zero = bytes.indexOf(0);
				if (zero < 0) {
					throw new BlendRewriteError(`Blender ${structure.name}.${semantic.field} has no null terminator within its fixed ${field.size}-byte field.`);
				}
				if (!zero) {
					continue;
				}
				const valueBytes = bytes.subarray(0, zero);
				const value = valueBytes.toString("utf-8");
				if (!Buffer.from(value, "utf-8").equals(valueBytes)) {
					throw new BlendRewriteError(`Blender ${structure.name}.${semantic.field} is not valid UTF-8.`);
				}
				references.push({ offset: baseOffset + field.offset, capacity: field.size, value });
				if (references.length > MAX_BLEND_REFERENCES) {
					throw new BlendRewriteError(`The Blender file contains more than ${MAX_BLEND_REFERENCES.toLocaleString()} external references.`);
				}
			}
		}
	}
	return references;
}

function recompressBlend(raw: Buffer, compression: BlendCompression): Buffer {
	if (compression === "none") {
		return raw;
	}
	try {
		return compression === "gzip" ? gzipSync(raw) : zstdCompressSync(raw);
	} catch {
		throw new BlendRewriteError(`The rewritten Blender stream could not be recompressed as ${compression === "gzip" ? "GZip" : "Zstandard"}.`);
	}
}

/** Reads the validated Blender header, including GZip and Zstandard-compressed files. */
export function inspectBlendFile(buffer: Buffer): IBlendFileInspection & { error?: string } {
	try {
		return parseBlendDocument(buffer).inspection;
	} catch (error) {
		return { compression: "none", version: 0, pointerSize: 8, littleEndian: true, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Extracts exact external path fields from bounded Blender blocks using the file's own SDNA schema. */
export function extractBlendReferences(buffer: Buffer): { values: string[]; error?: string } {
	try {
		return { values: collectBlendReferences(parseBlendDocument(buffer)).map((reference) => reference.value) };
	} catch (error) {
		return { values: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Rewrites only fixed-width semantic Blender path fields and preserves packed resources and unrelated bytes. */
export function rewriteBlendReferences(buffer: Buffer, rewrite: (value: string) => string | null): IBinaryModelReferenceRewriteResult {
	try {
		const document = parseBlendDocument(buffer);
		const references = collectBlendReferences(document);
		let replacementCount = 0;
		let semanticMatchCount = 0;
		let raw = document.raw;
		for (const reference of references) {
			const rewritten = rewrite(reference.value);
			if (rewritten === null) {
				continue;
			}
			semanticMatchCount++;
			if (rewritten === reference.value) {
				continue;
			}
			if (rewritten.includes("\0")) {
				throw new BlendRewriteError("A rewritten Blender path cannot contain null characters.", "semanticMismatch");
			}
			const bytes = Buffer.from(rewritten, "utf-8");
			if (bytes.length >= reference.capacity) {
				throw new BlendRewriteError(
					`A rewritten Blender path requires ${bytes.length + 1} bytes including its terminator but its SDNA field holds ${reference.capacity}.`,
					"semanticMismatch"
				);
			}
			if (raw === document.raw) {
				raw = Buffer.from(document.raw);
			}
			raw.fill(0, reference.offset, reference.offset + reference.capacity);
			bytes.copy(raw, reference.offset);
			replacementCount++;
		}
		return {
			buffer: replacementCount ? recompressBlend(raw, document.inspection.compression) : document.original,
			replacementCount,
			semanticMatchCount,
		};
	} catch (error) {
		return {
			buffer,
			replacementCount: 0,
			semanticMatchCount: 0,
			error: error instanceof Error ? error.message : String(error),
			errorKind: error instanceof BlendRewriteError ? error.kind : "malformed",
		};
	}
}

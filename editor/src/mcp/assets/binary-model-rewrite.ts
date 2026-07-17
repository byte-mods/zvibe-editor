const FBX_BINARY_MAGIC = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
const MAX_BINARY_MODEL_STRING_BYTES = 1024 * 1024;
const MAX_BINARY_MODEL_STRINGS = 10_000;
const MAX_FBX_NODES = 100_000;
const MAX_FBX_PROPERTIES = 1_000_000;
const MAX_FBX_PROPERTY_BYTES = 16 * 1024 * 1024;
const MAX_FBX_DEPTH = 64;
const MAX_3DS_CHUNKS = 100_000;
const MAX_3DS_DEPTH = 32;

const THREE_DS_CONTAINER_CHUNKS = new Set([0x4d4d, 0x3d3d, 0xafff, 0xa200, 0xa204, 0xa210, 0xa220, 0xa230, 0xa33a, 0xa33c, 0xa33d, 0xa33e, 0xa340]);

export interface IBinaryModelReferenceRewriteResult {
	buffer: Buffer;
	replacementCount: number;
	semanticMatchCount: number;
	error?: string;
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

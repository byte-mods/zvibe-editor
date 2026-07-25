import { extname } from "path/posix";

export interface IPreparedModelImporterSource {
	supported: boolean;
	pluginExtension: string;
	dataUrl: string | null;
	embeddedResourceCount: number;
	warnings: string[];
	errors: string[];
}

export type ModelImporterResourceResolver = (reference: string) => Promise<Uint8Array | null>;

export interface IPrepareModelImporterSourceOptions {
	sourceRelativeDoubleSlash?: boolean;
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const MAX_MODEL_JSON_BYTES = 32 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
	}
	return btoa(binary);
}

function mimeType(path: string): string {
	const extension = extname(path.split(/[?#]/)[0]).toLowerCase();
	const types: Record<string, string> = {
		".bin": "application/octet-stream",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".gif": "image/gif",
		".ktx2": "image/ktx2",
	};
	return types[extension] ?? "application/octet-stream";
}

function isExternalReference(value: unknown, options: IPrepareModelImporterSourceOptions): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("data:") &&
		!/^[a-z][a-z0-9+.-]*:/i.test(value) &&
		(options.sourceRelativeDoubleSlash === true || !value.startsWith("//"))
	);
}

async function embedDocumentResources(
	document: Record<string, unknown>,
	resolveResource: ModelImporterResourceResolver,
	options: IPrepareModelImporterSourceOptions
): Promise<{ document: Record<string, unknown>; embeddedResourceCount: number; warnings: string[] }> {
	const copy = structuredClone(document);
	let embeddedResourceCount = 0;
	const warnings: string[] = [];
	for (const collectionName of ["buffers", "images"] as const) {
		const collection = Array.isArray(copy[collectionName]) ? (copy[collectionName] as Array<Record<string, unknown>>) : [];
		for (const entry of collection) {
			if (!isExternalReference(entry.uri, options)) {
				continue;
			}
			const resource = await resolveResource(entry.uri);
			if (!resource) {
				warnings.push(`Referenced ${collectionName === "buffers" ? "buffer" : "image"} "${entry.uri}" could not be embedded for headless processing.`);
				continue;
			}
			entry.uri = `data:${mimeType(entry.uri)};base64,${bytesToBase64(resource)}`;
			embeddedResourceCount++;
		}
	}
	return { document: copy, embeddedResourceCount, warnings };
}

function parseDocument(bytes: Uint8Array): Record<string, unknown> {
	if (bytes.byteLength > MAX_MODEL_JSON_BYTES) {
		throw new Error(`Model JSON is limited to ${MAX_MODEL_JSON_BYTES} bytes.`);
	}
	const parsed = JSON.parse(new TextDecoder().decode(bytes));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Model JSON root must be an object.");
	}
	return parsed;
}

function rebuildGlb(original: Uint8Array, document: Record<string, unknown>): Uint8Array {
	const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
	if (original.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== original.byteLength) {
		throw new Error("GLB header is malformed or truncated.");
	}
	const chunks: Array<{ type: number; data: Uint8Array }> = [];
	let offset = 12;
	let replacedJson = false;
	while (offset + 8 <= original.byteLength) {
		const length = view.getUint32(offset, true);
		const type = view.getUint32(offset + 4, true);
		offset += 8;
		if (offset + length > original.byteLength) {
			throw new Error("GLB chunk table is truncated.");
		}
		if (type === GLB_JSON_CHUNK && !replacedJson) {
			const encoded = new TextEncoder().encode(JSON.stringify(document));
			const paddedLength = Math.ceil(encoded.byteLength / 4) * 4;
			const padded = new Uint8Array(paddedLength);
			padded.fill(0x20);
			padded.set(encoded);
			chunks.push({ type, data: padded });
			replacedJson = true;
		} else {
			chunks.push({ type, data: original.slice(offset, offset + length) });
		}
		offset += length;
	}
	if (!replacedJson || offset !== original.byteLength) {
		throw new Error("GLB JSON chunk is missing or the chunk table is malformed.");
	}
	const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.byteLength, 0);
	const output = new Uint8Array(totalLength);
	const outputView = new DataView(output.buffer);
	outputView.setUint32(0, GLB_MAGIC, true);
	outputView.setUint32(4, 2, true);
	outputView.setUint32(8, totalLength, true);
	offset = 12;
	for (const chunk of chunks) {
		outputView.setUint32(offset, chunk.data.byteLength, true);
		outputView.setUint32(offset + 4, chunk.type, true);
		output.set(chunk.data, offset + 8);
		offset += 8 + chunk.data.byteLength;
	}
	return output;
}

function glbDocument(bytes: Uint8Array): Record<string, unknown> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
		throw new Error("GLB header is malformed or truncated.");
	}
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const length = view.getUint32(offset, true);
		const type = view.getUint32(offset + 4, true);
		offset += 8;
		if (offset + length > bytes.byteLength) {
			throw new Error("GLB chunk table is truncated.");
		}
		if (type === GLB_JSON_CHUNK) {
			return parseDocument(bytes.slice(offset, offset + length));
		}
		offset += length;
	}
	throw new Error("GLB JSON chunk is missing.");
}

/** Creates a self-contained data URL so the same Babylon loader path can run in Electron and the headless CLI. */
export async function prepareModelImporterSource(
	sourcePath: string,
	bytes: Uint8Array,
	resolveResource: ModelImporterResourceResolver,
	options: IPrepareModelImporterSourceOptions = {}
): Promise<IPreparedModelImporterSource> {
	const extension = extname(sourcePath).toLowerCase();
	const warnings: string[] = [];
	try {
		if (extension === ".gltf") {
			const embedded = await embedDocumentResources(parseDocument(bytes), resolveResource, options);
			return {
				supported: true,
				pluginExtension: extension,
				dataUrl: `data:model/gltf+json;base64,${bytesToBase64(new TextEncoder().encode(JSON.stringify(embedded.document)))}`,
				embeddedResourceCount: embedded.embeddedResourceCount,
				warnings: embedded.warnings,
				errors: [],
			};
		}
		if (extension === ".glb") {
			const embedded = await embedDocumentResources(glbDocument(bytes), resolveResource, options);
			const output = rebuildGlb(bytes, embedded.document);
			return {
				supported: true,
				pluginExtension: extension,
				dataUrl: `data:model/gltf-binary;base64,${bytesToBase64(output)}`,
				embeddedResourceCount: embedded.embeddedResourceCount,
				warnings: embedded.warnings,
				errors: [],
			};
		}
		if (extension === ".babylon") {
			const document = parseDocument(bytes);
			return {
				supported: true,
				pluginExtension: extension,
				dataUrl: `data:${JSON.stringify(document)}`,
				embeddedResourceCount: 0,
				warnings,
				errors: [],
			};
		}
		if (extension === ".obj" || extension === ".stl") {
			if (extension === ".obj") {
				warnings.push("OBJ preview processing loads geometry from the source text; external MTL/texture files remain build dependencies.");
			}
			return {
				supported: true,
				pluginExtension: extension,
				dataUrl: `data:application/octet-stream;base64,${bytesToBase64(bytes)}`,
				embeddedResourceCount: 0,
				warnings,
				errors: [],
			};
		}
		return {
			supported: false,
			pluginExtension: extension,
			dataUrl: null,
			embeddedResourceCount: 0,
			warnings,
			errors: [
				`Executed headless model processing currently supports .glb, .gltf, .babylon, .obj, and .stl; "${extension || "unknown"}" remains available through the editor's legacy import/conversion path.`,
			],
		};
	} catch (error) {
		return {
			supported: false,
			pluginExtension: extension,
			dataUrl: null,
			embeddedResourceCount: 0,
			warnings,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

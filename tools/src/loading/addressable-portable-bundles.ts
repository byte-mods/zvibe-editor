import {
	ADDRESSABLE_TYPE_TREE_VERSION,
	AddressableTypeTreeEncodedValue,
	decodeAddressableTypeTreeValue,
	encodeAddressableTypeTreeValue,
	IAddressableTypeTreeSchema,
} from "./addressable-type-trees";

export const ADDRESSABLE_PORTABLE_BUNDLE_VERSION = 1 as const;

export interface IAddressablePortableBundleSource {
	address: string;
	value: unknown;
	schema: IAddressableTypeTreeSchema;
}

export interface IAddressablePortableBundleEntry {
	address: string;
	schemaId: string;
	sizeBytes: number;
	hash: string;
	payload: AddressableTypeTreeEncodedValue;
}

export interface IAddressablePortableBundle {
	version: typeof ADDRESSABLE_PORTABLE_BUNDLE_VERSION;
	id: string;
	entries: IAddressablePortableBundleEntry[];
}

export interface IValidatedAddressablePortableBundleEntry {
	entry: IAddressablePortableBundleEntry;
	bytes: ArrayBuffer;
	value: unknown;
}

const maximumBundleBytes = 64 * 1024 * 1024;
const maximumBundleEntries = 4_096;
const maximumAddressLength = 512;
const hashPattern = /^[a-f0-9]{64}$/;
const bundleIdPattern = /^zvpb-[a-f0-9]{64}$/;

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Portable Addressable bundle hashing requires Web Crypto SHA-256 support.");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes instanceof Uint8Array ? exactArrayBuffer(bytes) : bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bundlePayload(bundle: Omit<IAddressablePortableBundle, "id"> | IAddressablePortableBundle): string {
	return JSON.stringify({ version: bundle.version, entries: bundle.entries });
}

function semanticBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

/** Encodes structured assets without object keys and binds both entries and bundle to SHA-256 identities. */
export async function createAddressablePortableBundle(sources: IAddressablePortableBundleSource[]): Promise<IAddressablePortableBundle> {
	if (!sources.length || sources.length > maximumBundleEntries) {
		throw new Error(`Portable Addressable bundles require 1-${maximumBundleEntries.toLocaleString()} entries.`);
	}
	const addresses = new Set<string>();
	const entries = await Promise.all(
		[...sources]
			.sort((left, right) => left.address.localeCompare(right.address))
			.map(async (source): Promise<IAddressablePortableBundleEntry> => {
				if (!source.address.trim() || source.address.length > maximumAddressLength || addresses.has(source.address)) {
					throw new Error(`Portable Addressable bundle address is empty, duplicated, or exceeds ${maximumAddressLength} characters: ${source.address}`);
				}
				addresses.add(source.address);
				const payload = encodeAddressableTypeTreeValue(source.value, source.schema);
				const value = decodeAddressableTypeTreeValue(payload, source.schema);
				const bytes = semanticBytes(value);
				return { address: source.address, schemaId: source.schema.id, sizeBytes: bytes.byteLength, hash: await sha256(bytes), payload };
			})
	);
	const payload = bundlePayload({ version: ADDRESSABLE_PORTABLE_BUNDLE_VERSION, entries });
	return { version: ADDRESSABLE_PORTABLE_BUNDLE_VERSION, id: `zvpb-${await sha256(new TextEncoder().encode(payload))}`, entries };
}

/** Produces the exact compact bytes used by editor export, content builds, and runtime verification. */
export function serializeAddressablePortableBundle(bundle: IAddressablePortableBundle): Uint8Array {
	const bytes = new TextEncoder().encode(JSON.stringify(bundle));
	if (bytes.byteLength > maximumBundleBytes) {
		throw new Error(`Portable Addressable bundle exceeds ${maximumBundleBytes / (1024 * 1024)} MiB.`);
	}
	return bytes;
}

/** Validates a decoded bundle and reconstructs every entry before callers trust any content. */
export async function validateAddressablePortableBundle(
	bundle: IAddressablePortableBundle,
	schemas: ReadonlyMap<string, IAddressableTypeTreeSchema>
): Promise<Map<string, IValidatedAddressablePortableBundleEntry>> {
	if (
		bundle?.version !== ADDRESSABLE_PORTABLE_BUNDLE_VERSION ||
		!bundleIdPattern.test(bundle.id) ||
		!Array.isArray(bundle.entries) ||
		!bundle.entries.length ||
		bundle.entries.length > maximumBundleEntries
	) {
		throw new Error("Portable Addressable bundle header is invalid.");
	}
	const expectedId = `zvpb-${await sha256(new TextEncoder().encode(bundlePayload(bundle)))}`;
	if (expectedId !== bundle.id) {
		throw new Error("Portable Addressable bundle id does not match its entries.");
	}
	const result = new Map<string, IValidatedAddressablePortableBundleEntry>();
	let previousAddress = "";
	for (const entry of bundle.entries) {
		if (
			!entry ||
			typeof entry.address !== "string" ||
			!entry.address.length ||
			entry.address.length > maximumAddressLength ||
			entry.address <= previousAddress ||
			!hashPattern.test(entry.hash) ||
			!Number.isSafeInteger(entry.sizeBytes) ||
			entry.sizeBytes < 0
		) {
			throw new Error("Portable Addressable bundle entries must be uniquely sorted with valid hashes and sizes.");
		}
		previousAddress = entry.address;
		const schema = schemas.get(entry.schemaId);
		if (!schema || schema.version !== ADDRESSABLE_TYPE_TREE_VERSION) {
			throw new Error(`Portable Addressable bundle schema is unavailable: ${entry.schemaId}`);
		}
		const value = decodeAddressableTypeTreeValue(entry.payload, schema);
		const bytes = semanticBytes(value);
		if (bytes.byteLength !== entry.sizeBytes || (await sha256(bytes)) !== entry.hash) {
			throw new Error(`Portable Addressable bundle entry failed content verification: ${entry.address}`);
		}
		result.set(entry.address, { entry, bytes: exactArrayBuffer(bytes), value });
	}
	return result;
}

/** Parses bounded UTF-8 JSON and validates the complete bundle before returning reconstructed entries. */
export async function parseAddressablePortableBundle(
	bytes: ArrayBuffer,
	schemas: ReadonlyMap<string, IAddressableTypeTreeSchema>
): Promise<{ bundle: IAddressablePortableBundle; entries: Map<string, IValidatedAddressablePortableBundleEntry> }> {
	if (!bytes.byteLength || bytes.byteLength > maximumBundleBytes) {
		throw new Error(`Portable Addressable bundle bytes must be 1-${maximumBundleBytes} bytes.`);
	}
	let bundle: IAddressablePortableBundle;
	try {
		bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as IAddressablePortableBundle;
	} catch {
		throw new Error("Portable Addressable bundle is not valid UTF-8 JSON.");
	}
	return { bundle, entries: await validateAddressablePortableBundle(bundle, schemas) };
}

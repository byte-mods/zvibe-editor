/** Portable schema format used to remove repeated object field names from Addressable bundles. */
export const ADDRESSABLE_TYPE_TREE_VERSION = 1 as const;

export type AddressableTypeTreeScalarKind = "null" | "boolean" | "number" | "string";

export type IAddressableTypeTreeScalarNode = { kind: "null" } | { kind: "boolean" } | { kind: "number" } | { kind: "string" };

export interface IAddressableTypeTreeObjectField {
	name: string;
	node: AddressableTypeTreeNode;
}

export interface IAddressableTypeTreeObjectNode {
	kind: "object";
	fields: IAddressableTypeTreeObjectField[];
}

export interface IAddressableTypeTreeArrayNode {
	kind: "array";
	variants: AddressableTypeTreeNode[];
}

export type AddressableTypeTreeNode = IAddressableTypeTreeScalarNode | IAddressableTypeTreeObjectNode | IAddressableTypeTreeArrayNode;

export interface IAddressableTypeTreeSchema {
	version: typeof ADDRESSABLE_TYPE_TREE_VERSION;
	id: string;
	root: AddressableTypeTreeNode;
	nodeCount: number;
	maxDepth: number;
}

export interface IAddressableTypeTreeRegistry {
	version: typeof ADDRESSABLE_TYPE_TREE_VERSION;
	id: string;
	schemas: IAddressableTypeTreeSchema[];
}

export type AddressableTypeTreeEncodedValue = null | boolean | number | string | AddressableTypeTreeEncodedValue[];

const maximumDepth = 64;
const maximumFields = 4_096;
const maximumFieldNameLength = 512;
const maximumArrayItems = 100_000;
const maximumArrayVariants = 32;
const maximumValues = 1_000_000;
const maximumSchemaNodes = 65_536;
const schemaIdPattern = /^zvtts-[a-f0-9]{64}$/;
const registryIdPattern = /^zvttr-[a-f0-9]{64}$/;

interface ITraversalState {
	ancestors: WeakSet<object>;
	valueCount: number;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Addressable TypeTree hashing requires Web Crypto SHA-256 support.");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function countValue(state: ITraversalState): void {
	state.valueCount++;
	if (state.valueCount > maximumValues) {
		throw new Error(`Addressable TypeTree values exceed the ${maximumValues.toLocaleString()} value limit.`);
	}
}

/** Extracts one deterministic structural node while rejecting values that JSON cannot preserve. */
function extractNode(value: unknown, depth: number, state: ITraversalState): AddressableTypeTreeNode {
	countValue(state);
	if (depth > maximumDepth) {
		throw new Error(`Addressable TypeTree nesting exceeds ${maximumDepth} levels.`);
	}
	if (value === null) {
		return { kind: "null" };
	}
	if (typeof value === "boolean") {
		return { kind: "boolean" };
	}
	if (typeof value === "string") {
		return { kind: "string" };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Addressable TypeTree numbers must be finite.");
		}
		return { kind: "number" };
	}
	if (!value || typeof value !== "object") {
		throw new Error(`Addressable TypeTree values must be JSON-compatible; received ${typeof value}.`);
	}
	if (state.ancestors.has(value)) {
		throw new Error("Addressable TypeTree values cannot contain circular references.");
	}
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > maximumArrayItems) {
				throw new Error(`Addressable TypeTree arrays support at most ${maximumArrayItems.toLocaleString()} items.`);
			}
			const byShape = new Map<string, AddressableTypeTreeNode>();
			for (const item of value) {
				const node = extractNode(item, depth + 1, state);
				byShape.set(stableStringify(node), node);
				if (byShape.size > maximumArrayVariants) {
					throw new Error(`Addressable TypeTree arrays support at most ${maximumArrayVariants} structural variants.`);
				}
			}
			return { kind: "array", variants: [...byShape.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, node]) => node) };
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("Addressable TypeTree objects must be plain JSON objects.");
		}
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
		if (entries.length > maximumFields) {
			throw new Error(`Addressable TypeTree objects support at most ${maximumFields.toLocaleString()} fields.`);
		}
		return {
			kind: "object",
			fields: entries.map(([name, child]) => {
				if (!name.length || name.length > maximumFieldNameLength || child === undefined) {
					throw new Error(`Addressable TypeTree field names must be 1-${maximumFieldNameLength} characters and values cannot be undefined.`);
				}
				return { name, node: extractNode(child, depth + 1, state) };
			}),
		};
	} finally {
		state.ancestors.delete(value);
	}
}

function measureNode(root: AddressableTypeTreeNode): { nodeCount: number; maxDepth: number } {
	const stack: Array<{ node: AddressableTypeTreeNode; depth: number }> = [{ node: root, depth: 1 }];
	let nodeCount = 0;
	let maxDepth = 0;
	while (stack.length) {
		const current = stack.pop();
		if (!current || !current.node || typeof current.node !== "object") {
			throw new Error("Addressable TypeTree schema contains an invalid node.");
		}
		nodeCount++;
		maxDepth = Math.max(maxDepth, current.depth);
		if (nodeCount > maximumSchemaNodes || current.depth > maximumDepth) {
			throw new Error("Addressable TypeTree schema exceeds its node or depth limit.");
		}
		if (current.node.kind === "null" || current.node.kind === "boolean" || current.node.kind === "number" || current.node.kind === "string") {
			continue;
		}
		if (current.node.kind === "object") {
			if (!Array.isArray(current.node.fields) || current.node.fields.length > maximumFields) {
				throw new Error("Addressable TypeTree object fields are invalid.");
			}
			let previous = "";
			for (const field of current.node.fields) {
				if (!field || typeof field.name !== "string" || !field.name.length || field.name.length > maximumFieldNameLength || field.name <= previous) {
					throw new Error("Addressable TypeTree object fields must be uniquely sorted and bounded.");
				}
				previous = field.name;
				stack.push({ node: field.node, depth: current.depth + 1 });
			}
			continue;
		}
		if (current.node.kind !== "array" || !Array.isArray(current.node.variants) || current.node.variants.length > maximumArrayVariants) {
			throw new Error("Addressable TypeTree array variants are invalid.");
		}
		let previous = "";
		for (const variant of current.node.variants) {
			const shape = stableStringify(variant);
			if (shape <= previous) {
				throw new Error("Addressable TypeTree array variants must be uniquely sorted.");
			}
			previous = shape;
			stack.push({ node: variant, depth: current.depth + 1 });
		}
	}
	return { nodeCount, maxDepth };
}

function schemaPayload(root: AddressableTypeTreeNode): string {
	return stableStringify({ version: ADDRESSABLE_TYPE_TREE_VERSION, root });
}

/** Produces a content-addressed schema; equivalent shapes receive the same id across builds. */
export async function extractAddressableTypeTreeSchema(value: unknown): Promise<IAddressableTypeTreeSchema> {
	const root = extractNode(value, 1, { ancestors: new WeakSet<object>(), valueCount: 0 });
	const measured = measureNode(root);
	return { version: ADDRESSABLE_TYPE_TREE_VERSION, id: `zvtts-${await sha256(schemaPayload(root))}`, root, ...measured };
}

function matchingVariant(value: unknown, variants: AddressableTypeTreeNode[]): { index: number; node: AddressableTypeTreeNode } {
	const candidate = extractNode(value, 1, { ancestors: new WeakSet<object>(), valueCount: 0 });
	const shape = stableStringify(candidate);
	const index = variants.findIndex((variant) => stableStringify(variant) === shape);
	if (index === -1) {
		throw new Error("Addressable value does not match any TypeTree array variant.");
	}
	return { index, node: variants[index] };
}

function encodeNode(value: unknown, node: AddressableTypeTreeNode): AddressableTypeTreeEncodedValue {
	if (node.kind === "null") {
		if (value !== null) {
			throw new Error("Addressable value does not match null TypeTree node.");
		}
		return null;
	}
	if (node.kind === "boolean" || node.kind === "string" || node.kind === "number") {
		if (typeof value !== node.kind || (node.kind === "number" && !Number.isFinite(value))) {
			throw new Error(`Addressable value does not match ${node.kind} TypeTree node.`);
		}
		return value as boolean | string | number;
	}
	if (node.kind === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Addressable value does not match object TypeTree node.");
		}
		const source = value as Record<string, unknown>;
		const keys = Object.keys(source).sort();
		if (keys.length !== node.fields.length || keys.some((key, index) => key !== node.fields[index].name)) {
			throw new Error("Addressable object fields do not match its TypeTree schema.");
		}
		return node.fields.map((field) => encodeNode(source[field.name], field.node));
	}
	if (!Array.isArray(value)) {
		throw new Error("Addressable value does not match array TypeTree node.");
	}
	if (!node.variants.length) {
		if (value.length) {
			throw new Error("Addressable non-empty array does not match an empty TypeTree array.");
		}
		return [];
	}
	return value.map((item) => {
		const match = matchingVariant(item, node.variants);
		const encoded = encodeNode(item, match.node);
		return node.variants.length === 1 ? encoded : [match.index, encoded];
	});
}

/** Removes object keys according to a previously extracted schema. */
export function encodeAddressableTypeTreeValue(value: unknown, schema: IAddressableTypeTreeSchema): AddressableTypeTreeEncodedValue {
	return encodeNode(value, schema.root);
}

function decodeNode(value: AddressableTypeTreeEncodedValue, node: AddressableTypeTreeNode): unknown {
	if (node.kind === "null" || node.kind === "boolean" || node.kind === "string" || node.kind === "number") {
		if (node.kind === "null" ? value !== null : typeof value !== node.kind || (node.kind === "number" && !Number.isFinite(value))) {
			throw new Error(`Portable Addressable payload does not match ${node.kind} TypeTree node.`);
		}
		return value;
	}
	if (!Array.isArray(value)) {
		throw new Error(`Portable Addressable payload does not match ${node.kind} TypeTree node.`);
	}
	if (node.kind === "object") {
		if (value.length !== node.fields.length) {
			throw new Error("Portable Addressable object payload has the wrong field count.");
		}
		return Object.fromEntries(node.fields.map((field, index) => [field.name, decodeNode(value[index], field.node)]));
	}
	if (!node.variants.length) {
		if (value.length) {
			throw new Error("Portable Addressable array payload must be empty for an empty schema.");
		}
		return [];
	}
	return value.map((item) => {
		if (node.variants.length === 1) {
			return decodeNode(item, node.variants[0]);
		}
		if (!Array.isArray(item) || item.length !== 2 || !Number.isInteger(item[0]) || (item[0] as number) < 0 || (item[0] as number) >= node.variants.length) {
			throw new Error("Portable Addressable union payload has an invalid variant index.");
		}
		return decodeNode(item[1], node.variants[item[0] as number]);
	});
}

/** Reconstructs the semantic JSON value and rejects malformed compact payloads. */
export function decodeAddressableTypeTreeValue(value: AddressableTypeTreeEncodedValue, schema: IAddressableTypeTreeSchema): unknown {
	return decodeNode(value, schema.root);
}

/** Validates hashes and bounds before a registry is trusted by runtime bundle decoding. */
export async function validateAddressableTypeTreeSchema(schema: IAddressableTypeTreeSchema): Promise<void> {
	if (schema.version !== ADDRESSABLE_TYPE_TREE_VERSION || !schemaIdPattern.test(schema.id)) {
		throw new Error("Addressable TypeTree schema header is invalid.");
	}
	const measured = measureNode(schema.root);
	if (measured.nodeCount !== schema.nodeCount || measured.maxDepth !== schema.maxDepth) {
		throw new Error("Addressable TypeTree schema measurements are invalid.");
	}
	if (`zvtts-${await sha256(schemaPayload(schema.root))}` !== schema.id) {
		throw new Error("Addressable TypeTree schema id does not match its structure.");
	}
}

/** Deduplicates and content-addresses all schemas used by one portable content build. */
export async function createAddressableTypeTreeRegistry(schemas: IAddressableTypeTreeSchema[]): Promise<IAddressableTypeTreeRegistry> {
	const unique = [...new Map(schemas.map((schema) => [schema.id, schema])).values()].sort((left, right) => left.id.localeCompare(right.id));
	if (unique.length > 8_192) {
		throw new Error("Addressable TypeTree registry exceeds 8,192 schemas.");
	}
	await Promise.all(unique.map(validateAddressableTypeTreeSchema));
	const payload = stableStringify({ version: ADDRESSABLE_TYPE_TREE_VERSION, schemas: unique });
	return { version: ADDRESSABLE_TYPE_TREE_VERSION, id: `zvttr-${await sha256(payload)}`, schemas: unique };
}

/** Rejects duplicate/tampered schemas and returns an O(1) runtime lookup table. */
export async function validateAddressableTypeTreeRegistry(registry: IAddressableTypeTreeRegistry): Promise<Map<string, IAddressableTypeTreeSchema>> {
	if (registry.version !== ADDRESSABLE_TYPE_TREE_VERSION || !registryIdPattern.test(registry.id) || !Array.isArray(registry.schemas) || registry.schemas.length > 8_192) {
		throw new Error("Addressable TypeTree registry header is invalid.");
	}
	const schemas = new Map<string, IAddressableTypeTreeSchema>();
	for (const schema of registry.schemas) {
		await validateAddressableTypeTreeSchema(schema);
		if (schemas.has(schema.id)) {
			throw new Error(`Addressable TypeTree registry contains duplicate schema ${schema.id}.`);
		}
		schemas.set(schema.id, schema);
	}
	const payload = stableStringify({ version: ADDRESSABLE_TYPE_TREE_VERSION, schemas: [...schemas.values()] });
	if (`zvttr-${await sha256(payload)}` !== registry.id) {
		throw new Error("Addressable TypeTree registry id does not match its schemas.");
	}
	return schemas;
}

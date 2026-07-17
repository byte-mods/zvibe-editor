import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveProjectCollaborationActor } from "./collaboration";

const version = 1;
const maximumCollections = 100;
const maximumItems = 10000;
const maximumOperations = 2000;
const operationGuardStaleMilliseconds = 10000;

interface IListItem {
	id: string;
	afterId: string | null;
	value: unknown;
	deleted: boolean;
	placementVersion: string;
	valueVersion: string;
}

interface IListDocument {
	name: string;
	revision: number;
	sourceHash: string;
	items: IListItem[];
	operations: Array<{ id: string; requestHash: string; result: any; createdAt: string }>;
	updatedAt: string;
}

interface IListStore {
	version: 1;
	collections: Record<string, IListDocument>;
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function storeDirectory(root: string): string {
	return join(root, ".babylon-editor");
}

function storePath(root: string): string {
	return join(storeDirectory(root), "collaborative-lists.json");
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateName(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error("name must be 1-128 safe identifier characters.");
	}
	if (["__proto__", "prototype", "constructor"].includes(value)) {
		throw new Error("name must not be a prototype identifier.");
	}
	return value;
}

function validateIdentifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${field} must be 1-128 safe identifier characters.`);
	}
	return value;
}

function validateValue(value: unknown): unknown {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error("Collection item values must be JSON-serializable.");
	}
	if (serialized === undefined || Buffer.byteLength(serialized) > 65536 || serialized.includes("__proto__")) {
		throw new Error("Collection item values must be at most 64 KiB of safe JSON.");
	}
	return JSON.parse(serialized);
}

function metadataCollections(scene: Scene): Record<string, unknown[]> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorCollaborativeCollections ??= {});
}

function seedItems(values: unknown[]): IListItem[] {
	let afterId: string | null = null;
	return values.map((value, index) => {
		const id = `~seed:${index.toString().padStart(8, "0")}`;
		const item = { id, afterId, value: validateValue(value), deleted: false, placementVersion: "", valueVersion: "" };
		afterId = id;
		return item;
	});
}

function materialize(document: IListDocument): { ordered: IListItem[]; values: unknown[] } {
	const children = new Map<string | null, IListItem[]>();
	for (const item of document.items) {
		const entries = children.get(item.afterId) ?? [];
		entries.push(item);
		children.set(item.afterId, entries);
	}
	for (const entries of children.values()) {
		entries.sort((a, b) => {
			const aSeed = a.id.startsWith("~seed:"),
				bSeed = b.id.startsWith("~seed:");
			if (aSeed !== bSeed) {
				return aSeed ? 1 : -1;
			}
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
	}
	const ordered: IListItem[] = [],
		visited = new Set<string>();
	const visit = (anchor: string | null): void => {
		for (const item of children.get(anchor) ?? []) {
			if (visited.has(item.id)) {
				throw new Error("Collaborative collection contains a placement cycle.");
			}
			visited.add(item.id);
			ordered.push(item);
			visit(item.id);
		}
	};
	visit(null);
	if (visited.size !== document.items.length) {
		throw new Error("Collaborative collection contains a placement cycle or orphaned items.");
	}
	return { ordered, values: ordered.filter((item) => !item.deleted).map((item) => structuredClone(item.value)) };
}

function isStore(value: any): value is IListStore {
	return (
		value?.version === version &&
		value.collections &&
		typeof value.collections === "object" &&
		!Array.isArray(value.collections) &&
		Object.keys(value.collections).length <= maximumCollections
	);
}

async function readStore(root: string): Promise<IListStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (!isStore(value)) {
			throw new Error("Collaborative list store has an unsupported or malformed schema.");
		}
		for (const document of Object.values(value.collections)) {
			if (
				!Array.isArray(document.items) ||
				document.items.length > maximumItems * 4 ||
				!Array.isArray(document.operations) ||
				document.operations.length > maximumOperations
			) {
				throw new Error("Collaborative list store exceeds schema bounds.");
			}
			materialize(document);
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return { version, collections: {} };
		}
		if (error instanceof SyntaxError) {
			throw new Error("Collaborative list store contains invalid JSON.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: IListStore): Promise<void> {
	await mkdir(storeDirectory(root), { recursive: true });
	const path = storePath(root),
		temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(store, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function withGuard<T>(root: string, action: (store: IListStore) => Promise<T>): Promise<T> {
	await mkdir(storeDirectory(root), { recursive: true });
	const guard = join(storeDirectory(root), ".collaborative-lists.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			handle = await open(guard, "wx");
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				throw error;
			}
			const details = await stat(guard).catch(() => null);
			if (details && Date.now() - details.mtimeMs > operationGuardStaleMilliseconds) {
				await unlink(guard).catch(() => undefined);
			} else {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
	}
	if (!handle) {
		throw new Error("Collaborative list store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guard).catch(() => undefined);
	}
}

async function actorId(data: any, options: IMCPActionOptions): Promise<string> {
	if (data.collaborationToken) {
		return (await resolveProjectCollaborationActor(data.collaborationToken, options)).sessionId;
	}
	return validateIdentifier(data.actorId, "actorId");
}

function getOrCreate(scene: Scene, store: IListStore, name: string): IListDocument {
	const existing = store.collections[name];
	if (existing) {
		return existing;
	}
	if (Object.keys(store.collections).length >= maximumCollections) {
		throw new Error(`At most ${maximumCollections} collaborative collections are supported.`);
	}
	const source = metadataCollections(scene)[name] ?? [];
	if (!Array.isArray(source)) {
		throw new Error(`Scene metadata collection ${name} must be an array.`);
	}
	const document: IListDocument = { name, revision: 0, sourceHash: hash(source), items: seedItems(source), operations: [], updatedAt: new Date().toISOString() };
	store.collections[name] = document;
	return document;
}

export async function getCollaborativeOrderedCollection(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options),
		name = validateName(data.name),
		offset = data.offset ?? 0,
		limit = data.limit ?? 100;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("offset must be non-negative and limit must be 1 through 1000.");
	}
	return withGuard(root, async (store) => {
		const document = getOrCreate(scene, store, name);
		await writeStore(root, store);
		const current = metadataCollections(scene)[name] ?? [],
			materialized = materialize(document),
			visible = materialized.ordered.filter((item) => !item.deleted);
		return {
			name,
			revision: document.revision,
			sourceHash: document.sourceHash,
			actualSourceHash: hash(current),
			diverged: hash(current) !== document.sourceHash,
			total: visible.length,
			tombstones: materialized.ordered.length - visible.length,
			offset,
			count: visible.slice(offset, offset + limit).length,
			hasMore: offset + limit < visible.length,
			items: visible.slice(offset, offset + limit).map(({ id, value }) => ({ id, value: structuredClone(value) })),
		};
	});
}

export async function applyCollaborativeOrderedCollectionOperations(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options),
		name = validateName(data.name),
		actor = await actorId(data, options),
		operationId = validateIdentifier(data.operationId, "operationId");
	if (!Array.isArray(data.operations) || data.operations.length < 1 || data.operations.length > 128) {
		throw new Error("operations must contain 1 through 128 operations.");
	}
	const requestHash = hash({ actor, operations: data.operations });
	return withGuard(root, async (store) => {
		const document = getOrCreate(scene, store, name),
			previous = document.operations.find((entry) => entry.id === operationId);
		if (previous) {
			if (previous.requestHash !== requestHash) {
				throw new Error("operationId was already used with different collection operations.");
			}
			return { ...previous.result, replayed: true };
		}
		const live = metadataCollections(scene)[name] ?? [];
		if (hash(live) !== document.sourceHash) {
			return { status: "externalConflict", name, revision: document.revision, expectedSourceHash: document.sourceHash, actualSourceHash: hash(live), replayed: false };
		}
		const ids = new Set(document.items.map((item) => item.id));
		let inserted = 0,
			updated = 0,
			moved = 0,
			deleted = 0;
		for (const [index, operation] of data.operations.entries()) {
			const clock = `${(document.revision + 1).toString().padStart(16, "0")}:${actor}:${operationId}:${index.toString().padStart(4, "0")}`;
			if (operation?.type === "insert") {
				if (operation.afterId !== null && !ids.has(operation.afterId)) {
					throw new Error(`Insert anchor not found: ${operation.afterId}`);
				}
				const id = `${actor}:${operationId}:${index}`;
				if (ids.has(id)) {
					throw new Error(`Generated item id already exists: ${id}`);
				}
				document.items.push({ id, afterId: operation.afterId, value: validateValue(operation.value), deleted: false, placementVersion: clock, valueVersion: clock });
				ids.add(id);
				inserted++;
			} else {
				const item = document.items.find((candidate) => candidate.id === operation?.id);
				if (!item) {
					throw new Error(`Collection item not found: ${operation?.id}`);
				}
				if (operation.type === "delete") {
					if (!item.deleted) {
						item.deleted = true;
						deleted++;
					}
				} else if (operation.type === "update") {
					if (clock > item.valueVersion) {
						item.value = validateValue(operation.value);
						item.valueVersion = clock;
						updated++;
					}
				} else if (operation.type === "move") {
					if (operation.afterId === item.id || (operation.afterId !== null && !ids.has(operation.afterId))) {
						throw new Error("Move anchor is missing or self-referential.");
					}
					if (clock > item.placementVersion) {
						item.afterId = operation.afterId;
						item.placementVersion = clock;
						materialize(document);
						moved++;
					}
				} else {
					throw new Error("Collection operation type must be insert, update, move, or delete.");
				}
			}
		}
		if (document.items.length > maximumItems * 4) {
			throw new Error("Collaborative collection exceeds item limits.");
		}
		const values = materialize(document).values;
		if (values.length > maximumItems || Buffer.byteLength(JSON.stringify(values)) > 2 * 1024 * 1024) {
			throw new Error("Materialized collaborative collection exceeds limits.");
		}
		const previousLive = structuredClone(live);
		metadataCollections(scene)[name] = values;
		document.revision++;
		document.sourceHash = hash(values);
		document.updatedAt = new Date().toISOString();
		const result = {
			status: "applied",
			name,
			revision: document.revision,
			sourceHash: document.sourceHash,
			inserted,
			updated,
			moved,
			deleted,
			total: values.length,
			replayed: false,
		};
		document.operations.push({ id: operationId, requestHash, result, createdAt: document.updatedAt });
		document.operations = document.operations.slice(-maximumOperations);
		try {
			await writeStore(root, store);
		} catch (error) {
			metadataCollections(scene)[name] = previousLive;
			throw error;
		}
		return result;
	});
}

export async function rebaseCollaborativeOrderedCollection(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options),
		name = validateName(data.name);
	return withGuard(root, async (store) => {
		const live = metadataCollections(scene)[name] ?? [];
		if (!Array.isArray(live)) {
			throw new Error(`Scene metadata collection ${name} must be an array.`);
		}
		if (data.expectedSourceHash !== hash(live)) {
			throw new Error("expectedSourceHash does not match the current scene collection.");
		}
		const previous = store.collections[name];
		const document: IListDocument = {
			name,
			revision: (previous?.revision ?? 0) + 1,
			sourceHash: hash(live),
			items: seedItems(live),
			operations: [],
			updatedAt: new Date().toISOString(),
		};
		store.collections[name] = document;
		await writeStore(root, store);
		return { rebased: true, name, revision: document.revision, sourceHash: document.sourceHash, total: live.length };
	});
}

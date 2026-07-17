import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { extname, join, normalize, relative, resolve } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveProjectCollaborationActor } from "./collaboration";

const version = 1;
const maximumCharacters = 100000;
const maximumOperations = 2000;
const maximumFileBytes = 1024 * 1024;
const operationGuardStaleMilliseconds = 10000;
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".css", ".scss", ".html", ".glsl", ".wgsl", ".fx"]);

interface ITextItem {
	id: string;
	afterId: string | null;
	value: string;
	deleted: boolean;
}

interface ITextOperationRecord {
	id: string;
	requestHash: string;
	result: any;
	createdAt: string;
}

interface ITextDocument {
	version: 1;
	path: string;
	sourceHash: string;
	revision: number;
	items: ITextItem[];
	operations: ITextOperationRecord[];
	updatedAt: string;
}

function projectDirectory(options: IMCPActionOptions): string {
	const path = options.editor.state.projectPath;
	if (!path) {
		throw new Error("No project is currently open.");
	}
	return resolve(path, "..");
}

function metadataDirectory(root: string): string {
	return join(root, ".babylon-editor", "collaborative-text");
}

function documentPath(root: string, path: string): string {
	return join(metadataDirectory(root), `${createHash("sha256").update(path).digest("hex")}.json`);
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function validateTextPath(root: string, value: unknown): Promise<{ path: string; absolute: string }> {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error("path must be a non-empty project-relative text-file path.");
	}
	const path = normalize(value.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path === ".babylon-editor" || path.startsWith(".babylon-editor/")) {
		throw new Error("Collaborative text paths must stay inside the project and outside editor metadata.");
	}
	if (!allowedExtensions.has(extname(path).toLowerCase())) {
		throw new Error(`Unsupported collaborative text extension: ${extname(path) || "none"}.`);
	}
	const absolute = resolve(root, path);
	const [realRoot, realFile, details] = await Promise.all([realpath(root), realpath(absolute), stat(absolute)]).catch(() => {
		throw new Error(`Collaborative text file does not exist: ${path}`);
	});
	if ((realFile !== realRoot && !realFile.startsWith(`${realRoot}/`)) || !details.isFile()) {
		throw new Error("Collaborative text path must resolve to a file inside the project.");
	}
	if (details.size > maximumFileBytes) {
		throw new Error(`Collaborative text files are limited to ${maximumFileBytes} bytes.`);
	}
	return { path: relative(root, absolute).replace(/\\/g, "/"), absolute };
}

async function readText(absolute: string): Promise<string> {
	const buffer = await readFile(absolute);
	if (buffer.length > maximumFileBytes) {
		throw new Error(`Collaborative text files are limited to ${maximumFileBytes} bytes.`);
	}
	const text = buffer.toString("utf-8");
	if (text.includes("\0") || Buffer.from(text, "utf-8").compare(buffer) !== 0) {
		throw new Error("Collaborative text files must contain valid UTF-8 text without null bytes.");
	}
	if ([...text].length > maximumCharacters) {
		throw new Error(`Collaborative text documents are limited to ${maximumCharacters} Unicode characters.`);
	}
	return text;
}

function seedItems(text: string): ITextItem[] {
	let afterId: string | null = null;
	return [...text].map((value, index) => {
		const id = `~seed:${index.toString().padStart(8, "0")}`;
		const item = { id, afterId, value, deleted: false };
		afterId = id;
		return item;
	});
}

function isDocument(value: any, path: string): value is ITextDocument {
	return (
		value?.version === version &&
		value.path === path &&
		/^[a-f0-9]{64}$/.test(value.sourceHash) &&
		Number.isSafeInteger(value.revision) &&
		value.revision >= 0 &&
		Array.isArray(value.items) &&
		value.items.length <= maximumCharacters * 4 &&
		value.items.every(
			(item: any) =>
				typeof item?.id === "string" &&
				(item.afterId === null || typeof item.afterId === "string") &&
				typeof item.value === "string" &&
				[...item.value].length === 1 &&
				typeof item.deleted === "boolean"
		) &&
		new Set(value.items.map((item: ITextItem) => item.id)).size === value.items.length &&
		Array.isArray(value.operations) &&
		value.operations.length <= maximumOperations &&
		value.operations.every(
			(operation: any) =>
				typeof operation?.id === "string" && /^[a-f0-9]{64}$/.test(operation.requestHash) && operation.result && Number.isFinite(Date.parse(operation.createdAt))
		) &&
		Number.isFinite(Date.parse(value.updatedAt))
	);
}

async function readDocument(root: string, path: string): Promise<ITextDocument | null> {
	try {
		const value = JSON.parse(await readFile(documentPath(root, path), "utf-8"));
		if (!isDocument(value, path)) {
			throw new Error("The collaborative text document has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return null;
		}
		if (error instanceof SyntaxError) {
			throw new Error("The collaborative text document contains invalid JSON. Repair its .babylon-editor/collaborative-text entry.");
		}
		throw error;
	}
}

async function writeDocument(root: string, document: ITextDocument): Promise<void> {
	await mkdir(metadataDirectory(root), { recursive: true });
	const path = documentPath(root, document.path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(document, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function materialize(document: ITextDocument): { text: string; ordered: ITextItem[] } {
	const byParent = new Map<string | null, ITextItem[]>();
	for (const item of document.items) {
		const children = byParent.get(item.afterId) ?? [];
		children.push(item);
		byParent.set(item.afterId, children);
	}
	for (const children of byParent.values()) {
		children.sort((a, b) => {
			const aSeed = a.id.startsWith("~seed:");
			const bSeed = b.id.startsWith("~seed:");
			if (aSeed !== bSeed) {
				return aSeed ? 1 : -1;
			}
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
	}
	const ordered: ITextItem[] = [];
	const visited = new Set<string>();
	const visit = (afterId: string | null): void => {
		for (const item of byParent.get(afterId) ?? []) {
			if (visited.has(item.id)) {
				throw new Error("The collaborative text document contains an item cycle.");
			}
			visited.add(item.id);
			ordered.push(item);
			visit(item.id);
		}
	};
	visit(null);
	if (visited.size !== document.items.length) {
		throw new Error("The collaborative text document contains orphaned items.");
	}
	return {
		text: ordered
			.filter((item) => !item.deleted)
			.map((item) => item.value)
			.join(""),
		ordered,
	};
}

async function withGuard<T>(root: string, action: () => Promise<T>): Promise<T> {
	await mkdir(metadataDirectory(root), { recursive: true });
	const guard = join(metadataDirectory(root), ".operation");
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
		throw new Error("The collaborative text store is busy. Retry the operation.");
	}
	try {
		return await action();
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guard).catch(() => undefined);
	}
}

async function actorId(data: any, options: IMCPActionOptions): Promise<string> {
	if (data.collaborationToken) {
		return (await resolveProjectCollaborationActor(data.collaborationToken, options)).sessionId;
	}
	if (typeof data.actorId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(data.actorId)) {
		throw new Error("actorId is required outside an authenticated collaboration session.");
	}
	return data.actorId;
}

async function loadOrCreate(root: string, path: string, absolute: string): Promise<ITextDocument> {
	const existing = await readDocument(root, path);
	if (existing) {
		return existing;
	}
	const text = await readText(absolute);
	const document: ITextDocument = { version, path, sourceHash: hash(text), revision: 0, items: seedItems(text), operations: [], updatedAt: new Date().toISOString() };
	await writeDocument(root, document);
	return document;
}

export async function getCollaborativeTextDocument(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const target = await validateTextPath(root, data.path);
	const offset = data.offset ?? 0,
		limit = data.limit ?? 1000;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5000) {
		throw new Error("offset must be non-negative and limit must be 1 through 5000.");
	}
	return withGuard(root, async () => {
		const document = await loadOrCreate(root, target.path, target.absolute);
		const actualText = await readText(target.absolute);
		const { text, ordered } = materialize(document);
		const visible = ordered.filter((item) => !item.deleted);
		return {
			path: target.path,
			revision: document.revision,
			sourceHash: document.sourceHash,
			actualSourceHash: hash(actualText),
			diverged: hash(actualText) !== document.sourceHash || text !== actualText,
			totalCharacters: visible.length,
			tombstoneCount: ordered.length - visible.length,
			offset,
			count: visible.slice(offset, offset + limit).length,
			hasMore: offset + limit < visible.length,
			items: visible.slice(offset, offset + limit).map(({ id, value }) => ({ id, value })),
			text: visible
				.slice(offset, offset + limit)
				.map((item) => item.value)
				.join(""),
		};
	});
}

export async function applyCollaborativeTextOperations(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options),
		target = await validateTextPath(root, data.path),
		actor = await actorId(data, options);
	if (typeof data.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(data.operationId)) {
		throw new Error("operationId must be 1-128 safe identifier characters.");
	}
	if (!Array.isArray(data.operations) || data.operations.length < 1 || data.operations.length > 128) {
		throw new Error("operations must contain 1 through 128 insert/delete operations.");
	}
	const requestHash = hash(JSON.stringify({ actor, operations: data.operations }));
	return withGuard(root, async () => {
		const document = await loadOrCreate(root, target.path, target.absolute);
		const previous = document.operations.find((entry) => entry.id === data.operationId);
		if (previous) {
			if (previous.requestHash !== requestHash) {
				throw new Error("operationId was already used with different text operations.");
			}
			return { ...previous.result, replayed: true };
		}
		const actual = await readText(target.absolute);
		if (hash(actual) !== document.sourceHash || materialize(document).text !== actual) {
			return {
				status: "externalConflict",
				path: target.path,
				revision: document.revision,
				expectedSourceHash: document.sourceHash,
				actualSourceHash: hash(actual),
				replayed: false,
			};
		}
		const ids = new Set(document.items.map((item) => item.id));
		let inserted = 0,
			deleted = 0;
		for (let operationIndex = 0; operationIndex < data.operations.length; operationIndex++) {
			const operation = data.operations[operationIndex];
			if (operation?.type === "insert") {
				if (operation.afterId !== null && (typeof operation.afterId !== "string" || !ids.has(operation.afterId))) {
					throw new Error(`Insert anchor was not found: ${operation.afterId}`);
				}
				if (typeof operation.text !== "string" || !operation.text || operation.text.includes("\0") || Buffer.byteLength(operation.text) > 65536) {
					throw new Error("Insert text must be non-empty UTF-8 text of at most 64 KiB without null bytes.");
				}
				let afterId = operation.afterId;
				for (const [characterIndex, value] of [...operation.text].entries()) {
					const id = `${actor}:${data.operationId}:${operationIndex}:${characterIndex}`;
					if (ids.has(id)) {
						throw new Error(`Generated collaborative item id already exists: ${id}`);
					}
					document.items.push({ id, afterId, value, deleted: false });
					ids.add(id);
					afterId = id;
					inserted++;
				}
			} else if (operation?.type === "delete") {
				if (!Array.isArray(operation.ids) || operation.ids.length < 1 || operation.ids.length > 10000) {
					throw new Error("Delete ids must contain 1 through 10000 item ids.");
				}
				for (const id of new Set(operation.ids)) {
					const item = document.items.find((entry) => entry.id === id);
					if (!item) {
						throw new Error(`Delete item was not found: ${id}`);
					}
					if (!item.deleted) {
						item.deleted = true;
						deleted++;
					}
				}
			} else {
				throw new Error("Each collaborative text operation must have type insert or delete.");
			}
		}
		if (document.items.length > maximumCharacters * 4 || materialize(document).text.length > maximumFileBytes) {
			throw new Error("Collaborative text operation exceeds document limits.");
		}
		const before = actual,
			text = materialize(document).text,
			now = new Date().toISOString();
		document.revision++;
		document.sourceHash = hash(text);
		document.updatedAt = now;
		const result = {
			status: "applied",
			path: target.path,
			revision: document.revision,
			sourceHash: document.sourceHash,
			inserted,
			deleted,
			totalCharacters: [...text].length,
			replayed: false,
		};
		document.operations.push({ id: data.operationId, requestHash, result, createdAt: now });
		document.operations = document.operations.slice(-maximumOperations);
		const temporary = `${target.absolute}.${randomUUID()}.tmp`;
		await writeFile(temporary, text, "utf-8");
		await rename(temporary, target.absolute);
		try {
			await writeDocument(root, document);
		} catch (error) {
			await writeFile(target.absolute, before, "utf-8");
			throw error;
		}
		return result;
	});
}

export async function rebaseCollaborativeTextDocument(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options),
		target = await validateTextPath(root, data.path);
	return withGuard(root, async () => {
		const text = await readText(target.absolute),
			actualSourceHash = hash(text);
		if (data.expectedSourceHash !== actualSourceHash) {
			throw new Error("expectedSourceHash does not match the current file. Read the collaborative document again before rebasing.");
		}
		const previous = await readDocument(root, target.path);
		const document: ITextDocument = {
			version,
			path: target.path,
			sourceHash: actualSourceHash,
			revision: (previous?.revision ?? 0) + 1,
			items: seedItems(text),
			operations: [],
			updatedAt: new Date().toISOString(),
		};
		await writeDocument(root, document);
		return { rebased: true, path: target.path, revision: document.revision, sourceHash: actualSourceHash, totalCharacters: [...text].length };
	});
}

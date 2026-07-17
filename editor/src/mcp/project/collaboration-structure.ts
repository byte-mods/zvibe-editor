import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Node, Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { coerceValueForExistingProperty, resolveNode } from "../tools/resolve";

const storeVersion = 1;
const maximumChannels = 5000;
const maximumOperations = 2000;
const operationGuardStaleMilliseconds = 10000;
const forbiddenSegments = new Set(["__proto__", "prototype", "constructor"]);
const forbiddenRootProperties = new Set([
	"id",
	"name",
	"uniqueId",
	"parent",
	"_parentNode",
	"position",
	"rotation",
	"rotationQuaternion",
	"scaling",
	"direction",
	"target",
	"isVisible",
	"material",
	"metadata",
	"isPickable",
	"checkCollisions",
	"receiveShadows",
	"applyGravity",
]);

interface IRevisionRecord {
	revision: number;
	fingerprint: string;
	updatedAt: string;
}

interface IOperationRecord {
	id: string;
	requestFingerprint: string;
	result: any;
	createdAt: string;
}

interface IStructureStore {
	version: 1;
	channels: Record<string, IRevisionRecord>;
	operations: IOperationRecord[];
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
	return join(storeDirectory(root), "collaboration-structure.json");
}

function emptyStore(): IStructureStore {
	return { version: storeVersion, channels: {}, operations: [] };
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hierarchyChannel(node: Node): string {
	return `hierarchy:${node.id}`;
}

function propertyChannel(node: Node, paths: string[]): string {
	return `properties:${node.id}:${fingerprint(paths)}`;
}

function validateOperationId(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error("operationId must be 1-128 characters using letters, numbers, dot, underscore, colon, or hyphen.");
	}
	return value;
}

function validateExpectedRevision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error("expectedRevision must be a non-negative safe integer.");
	}
	return value as number;
}

function validatePaths(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
		throw new Error("paths must contain 1 through 32 dotted property paths.");
	}
	const paths = [...new Set(value.map((path) => validatePath(path)))].sort();
	if (paths.length !== value.length) {
		throw new Error("paths must not contain duplicates.");
	}
	return paths;
}

function validatePath(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) {
		throw new Error("Each property path must contain 1 through 256 characters.");
	}
	const parts = value.split(".");
	if (parts.length > 8 || parts.some((part) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) || forbiddenSegments.has(part))) {
		throw new Error(`Unsafe property path: ${value}. Use at most 8 identifier-only segments and no prototype-related names.`);
	}
	if (forbiddenRootProperties.has(parts[0])) {
		throw new Error(`Property path ${value} belongs to a dedicated identity, hierarchy, transform, material, metadata, or node-state tool.`);
	}
	return value;
}

function validateJsonValue(value: unknown, path: string, depth = 0): void {
	if (depth > 6) {
		throw new Error(`Value for ${path} exceeds the maximum nesting depth of 6.`);
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		if (typeof value === "string" && value.length > 4096) {
			throw new Error(`String value for ${path} exceeds 4096 characters.`);
		}
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Numeric value for ${path} must be finite.`);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) {
			throw new Error(`Array value for ${path} exceeds 64 entries.`);
		}
		value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, depth + 1));
		return;
	}
	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > 64) {
			throw new Error(`Object value for ${path} exceeds 64 fields.`);
		}
		for (const [key, entry] of entries) {
			if (forbiddenSegments.has(key)) {
				throw new Error(`Value for ${path} contains an unsafe object key: ${key}.`);
			}
			validateJsonValue(entry, `${path}.${key}`, depth + 1);
		}
		return;
	}
	throw new Error(`Value for ${path} must be bounded JSON data.`);
}

function propertyTarget(root: any, path: string): { parent: any; key: string; value: any } {
	const parts = path.split(".");
	let parent = root;
	for (let index = 0; index < parts.length - 1; index++) {
		parent = parent?.[parts[index]];
		if (parent === null || parent === undefined || (typeof parent !== "object" && typeof parent !== "function")) {
			throw new Error(`Cannot resolve existing property path ${path}.`);
		}
	}
	const key = parts.at(-1)!;
	if (!(key in parent) || parent[key] === undefined || typeof parent[key] === "function") {
		throw new Error(`Property path ${path} must resolve to an existing non-function value.`);
	}
	return { parent, key, value: parent[key] };
}

function serializeValue(value: any, path: string, depth = 0): any {
	if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
		validateJsonValue(value, path, depth);
		return value;
	}
	if (typeof value?.asArray === "function") {
		const result = value.asArray();
		validateJsonValue(result, path, depth);
		return result;
	}
	if (Array.isArray(value)) {
		const result = value.map((entry, index) => serializeValue(entry, `${path}[${index}]`, depth + 1));
		validateJsonValue(result, path, depth);
		return result;
	}
	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = serializeValue(entry, `${path}.${key}`, depth + 1);
		}
		validateJsonValue(result, path, depth);
		return result;
	}
	throw new Error(`Property path ${path} resolves to a non-serializable engine object. Select a scalar, vector, color, array, or plain-object subproperty.`);
}

function snapshotProperties(node: Node, paths: string[]): Record<string, unknown> {
	return Object.fromEntries(paths.map((path) => [path, serializeValue(propertyTarget(node, path).value, path)]));
}

function validateProperties(value: unknown): { paths: string[]; properties: Record<string, unknown> } {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error("properties must be a plain object keyed by dotted property path.");
	}
	const properties = value as Record<string, unknown>;
	const paths = validatePaths(Object.keys(properties));
	for (const path of paths) {
		validateJsonValue(properties[path], path);
	}
	if (Buffer.byteLength(JSON.stringify(properties)) > 64 * 1024) {
		throw new Error("properties JSON is limited to 64 KiB.");
	}
	return { paths, properties };
}

function validateStore(value: any): value is IStructureStore {
	return (
		value?.version === storeVersion &&
		value.channels &&
		typeof value.channels === "object" &&
		!Array.isArray(value.channels) &&
		Object.keys(value.channels).length <= maximumChannels &&
		Object.values(value.channels).every(
			(entry: any) => Number.isSafeInteger(entry?.revision) && entry.revision >= 0 && /^[a-f0-9]{64}$/.test(entry.fingerprint) && Number.isFinite(Date.parse(entry.updatedAt))
		) &&
		Array.isArray(value.operations) &&
		value.operations.length <= maximumOperations &&
		value.operations.every(
			(entry: any) => typeof entry?.id === "string" && /^[a-f0-9]{64}$/.test(entry.requestFingerprint) && entry.result && Number.isFinite(Date.parse(entry.createdAt))
		)
	);
}

async function readStore(root: string): Promise<IStructureStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (!validateStore(value)) {
			throw new Error("The collaboration structure revision store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return emptyStore();
		}
		if (error instanceof SyntaxError) {
			throw new Error("The collaboration structure revision store contains invalid JSON. Repair .babylon-editor/collaboration-structure.json.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: IStructureStore): Promise<void> {
	const path = storePath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(store, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function withStoreGuard<T>(root: string, action: (store: IStructureStore) => Promise<T>): Promise<T> {
	const directory = storeDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".collaboration-structure.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			handle = await open(guardPath, "wx");
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				throw error;
			}
			const guardStat = await stat(guardPath).catch(() => null);
			if (guardStat && Date.now() - guardStat.mtimeMs > operationGuardStaleMilliseconds) {
				await unlink(guardPath).catch(() => undefined);
			} else {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
	}
	if (!handle) {
		throw new Error("The collaboration structure revision store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

function effectiveRevision(store: IStructureStore, channel: string, snapshot: unknown): number {
	const record = store.channels[channel];
	if (!record) {
		return 0;
	}
	return record.fingerprint === fingerprint(snapshot) ? record.revision : record.revision + 1;
}

// eslint-disable-next-line max-params
async function compareAndSet(
	root: string,
	channel: string,
	operationId: string,
	expectedRevision: number,
	requestFingerprint: string,
	readCurrent: () => any,
	apply: () => void,
	rollback: (snapshot: any) => void,
	publicCurrent: (revision: number, snapshot: any) => any
): Promise<any> {
	return withStoreGuard(root, async (store) => {
		const previous = store.operations.find((entry) => entry.id === operationId);
		if (previous) {
			if (previous.requestFingerprint !== requestFingerprint) {
				throw new Error(`operationId "${operationId}" was already used with different arguments. Use a new operation id.`);
			}
			return { ...previous.result, replayed: true };
		}
		if (!store.channels[channel] && Object.keys(store.channels).length >= maximumChannels) {
			throw new Error(`The collaboration structure store supports at most ${maximumChannels} revision channels.`);
		}
		const before = readCurrent();
		const revision = effectiveRevision(store, channel, before);
		const now = new Date().toISOString();
		if (store.channels[channel]?.fingerprint !== fingerprint(before)) {
			store.channels[channel] = { revision, fingerprint: fingerprint(before), updatedAt: now };
		}
		let result: any;
		if (revision !== expectedRevision) {
			result = { status: "conflict", operationId, expectedRevision, current: publicCurrent(revision, before), replayed: false };
		} else {
			try {
				apply();
			} catch (error) {
				rollback(before);
				throw error;
			}
			const after = readCurrent();
			store.channels[channel] = { revision: revision + 1, fingerprint: fingerprint(after), updatedAt: now };
			result = { status: "applied", operationId, previousRevision: revision, current: publicCurrent(revision + 1, after), replayed: false };
		}
		store.operations.push({ id: operationId, requestFingerprint, result, createdAt: now });
		store.operations = store.operations.slice(-maximumOperations);
		try {
			await writeStore(root, store);
		} catch (error) {
			if (result.status === "applied") {
				rollback(before);
			}
			throw error;
		}
		return result;
	});
}

export async function getCollaborationHierarchyRevision(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const snapshot = { parentId: node.parent?.id ?? null };
	const store = await readStore(projectDirectory(options));
	const revision = effectiveRevision(store, hierarchyChannel(node), snapshot);
	return { nodeId: node.id, nodeName: node.name, revision, hierarchy: snapshot, fingerprint: fingerprint(snapshot) };
}

export async function applyCollaborativeHierarchyEdit(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const parent = data.parentId === null ? null : resolveNode({ scene, nodeId: data.parentId });
	if (parent === node || parent?.isDescendantOf(node)) {
		throw new Error("A node cannot be parented to itself or one of its descendants.");
	}
	const operationId = validateOperationId(data.operationId);
	const expectedRevision = validateExpectedRevision(data.expectedRevision);
	const root = projectDirectory(options);
	return compareAndSet(
		root,
		hierarchyChannel(node),
		operationId,
		expectedRevision,
		fingerprint({ nodeId: node.id, expectedRevision, parentId: parent?.id ?? null }),
		() => ({ parentId: node.parent?.id ?? null }),
		() => {
			node.parent = parent;
			void options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(node));
			options.editor.layout.inspector.setEditedObject(node);
		},
		(snapshot) => {
			node.parent = snapshot.parentId ? resolveNode({ scene, nodeId: snapshot.parentId }) : null;
		},
		(revision, snapshot) => ({ nodeId: node.id, nodeName: node.name, revision, hierarchy: snapshot, fingerprint: fingerprint(snapshot) })
	);
}

export async function getCollaborationNodePropertyRevision(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const paths = validatePaths(data.paths);
	const values = snapshotProperties(node, paths);
	const store = await readStore(projectDirectory(options));
	const revision = effectiveRevision(store, propertyChannel(node, paths), values);
	return { nodeId: node.id, nodeName: node.name, paths, revision, values, fingerprint: fingerprint(values) };
}

export async function applyCollaborativeNodeProperties(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const { paths, properties } = validateProperties(data.properties);
	const targets = Object.fromEntries(paths.map((path) => [path, propertyTarget(node, path)]));
	for (const path of paths) {
		coerceValueForExistingProperty(targets[path].value, properties[path]);
	}
	const operationId = validateOperationId(data.operationId);
	const expectedRevision = validateExpectedRevision(data.expectedRevision);
	return compareAndSet(
		projectDirectory(options),
		propertyChannel(node, paths),
		operationId,
		expectedRevision,
		fingerprint({ nodeId: node.id, expectedRevision, properties }),
		() => snapshotProperties(node, paths),
		() => {
			for (const path of paths) {
				targets[path].parent[targets[path].key] = coerceValueForExistingProperty(targets[path].value, properties[path]);
			}
			options.editor.layout.inspector.setEditedObject(node);
			options.editor.layout.inspector.forceUpdate();
		},
		(snapshot) => {
			for (const path of paths) {
				targets[path].parent[targets[path].key] = coerceValueForExistingProperty(targets[path].parent[targets[path].key], snapshot[path]);
			}
		},
		(revision, values) => ({ nodeId: node.id, nodeName: node.name, paths, revision, values, fingerprint: fingerprint(values) })
	);
}

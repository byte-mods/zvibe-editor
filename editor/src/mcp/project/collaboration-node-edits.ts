import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { AbstractMesh, Node, Scene } from "babylonjs";

import { isAbstractMesh } from "../../tools/guards/nodes";
import { IMCPActionOptions } from "../action";
import { resolveMaterial, resolveNode } from "../tools/resolve";

const storeVersion = 1;
const maximumOperations = 2000;
const operationGuardStaleMilliseconds = 10000;

interface INodeEditSnapshot {
	enabled: boolean;
	visible?: boolean;
	materialId?: string | null;
	layer: string;
	tags: string[];
	isPickable?: boolean;
	checkCollisions?: boolean;
	receiveShadows?: boolean;
	applyGravity?: boolean;
}

interface INodeEditRevision {
	revision: number;
	fingerprint: string;
	updatedAt: string;
}

interface INodeEditOperation {
	id: string;
	requestFingerprint: string;
	result: any;
	createdAt: string;
}

interface INodeEditStore {
	version: 1;
	nodes: Record<string, INodeEditRevision>;
	operations: INodeEditOperation[];
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
	return join(storeDirectory(root), "collaboration-node-edits.json");
}

function emptyStore(): INodeEditStore {
	return { version: storeVersion, nodes: {}, operations: [] };
}

function snapshotNode(node: Node): INodeEditSnapshot {
	const value = node as any;
	const snapshot: INodeEditSnapshot = {
		enabled: node.isEnabled(false),
		layer: node.metadata?.babylonEditorLayer ?? "Default",
		tags: [...(node.metadata?.babylonEditorTags ?? [])].sort(),
	};
	for (const property of ["isPickable", "checkCollisions", "receiveShadows", "applyGravity"] as const) {
		if (typeof value[property] === "boolean") {
			snapshot[property] = value[property];
		}
	}
	if (isAbstractMesh(node)) {
		snapshot.visible = node.isVisible;
		snapshot.materialId = node.material?.id ?? null;
	}
	return snapshot;
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicRevision(node: Node, revision: number, snapshot = snapshotNode(node)): any {
	return { nodeId: node.id, nodeName: node.name, revision, state: snapshot, fingerprint: fingerprint(snapshot) };
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

function validateBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean.`);
	}
	return value;
}

function validatePatch(data: any): Partial<INodeEditSnapshot> {
	const patch: Partial<INodeEditSnapshot> = {};
	for (const field of ["enabled", "visible", "isPickable", "checkCollisions", "receiveShadows", "applyGravity"] as const) {
		const value = validateBoolean(data[field], field);
		if (value !== undefined) {
			patch[field] = value;
		}
	}
	if (data.materialId !== undefined) {
		if (data.materialId !== null && (typeof data.materialId !== "string" || !data.materialId || data.materialId.length > 128)) {
			throw new Error("materialId must be null or a non-empty string of at most 128 characters.");
		}
		patch.materialId = data.materialId;
	}
	if (data.layer !== undefined) {
		if (typeof data.layer !== "string" || !data.layer.trim() || data.layer.length > 128 || /[\r\n\0]/.test(data.layer)) {
			throw new Error("layer must contain 1-128 characters without line breaks or null bytes.");
		}
		patch.layer = data.layer.trim();
	}
	if (data.tags !== undefined) {
		if (!Array.isArray(data.tags) || data.tags.length > 64 || data.tags.some((tag: unknown) => typeof tag !== "string" || !tag || tag.length > 64 || /[\r\n\0]/.test(tag))) {
			throw new Error("tags must contain at most 64 non-empty strings of at most 64 characters without line breaks or null bytes.");
		}
		patch.tags = [...new Set(data.tags as string[])].sort();
	}
	if (!Object.keys(patch).length) {
		throw new Error("Provide at least one editable state field.");
	}
	return patch;
}

function validateStore(value: any): value is INodeEditStore {
	return (
		value?.version === storeVersion &&
		value.nodes &&
		typeof value.nodes === "object" &&
		!Array.isArray(value.nodes) &&
		Object.values(value.nodes).every(
			(entry: any) => Number.isSafeInteger(entry?.revision) && entry.revision >= 0 && /^[a-f0-9]{64}$/.test(entry.fingerprint) && Number.isFinite(Date.parse(entry.updatedAt))
		) &&
		Array.isArray(value.operations) &&
		value.operations.length <= maximumOperations &&
		value.operations.every(
			(entry: any) => typeof entry?.id === "string" && /^[a-f0-9]{64}$/.test(entry.requestFingerprint) && entry.result && Number.isFinite(Date.parse(entry.createdAt))
		)
	);
}

async function readStore(root: string): Promise<INodeEditStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (!validateStore(value)) {
			throw new Error("The collaboration node-edit revision store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return emptyStore();
		}
		if (error instanceof SyntaxError) {
			throw new Error("The collaboration node-edit revision store contains invalid JSON. Repair .babylon-editor/collaboration-node-edits.json.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: INodeEditStore): Promise<void> {
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

async function withStoreGuard<T>(root: string, action: (store: INodeEditStore) => Promise<T>): Promise<T> {
	const directory = storeDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".collaboration-node-edits.operation");
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
		throw new Error("The collaboration node-edit revision store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

function effectiveRevision(store: INodeEditStore, node: Node, snapshot: INodeEditSnapshot): number {
	const record = store.nodes[node.id];
	if (!record) {
		return 0;
	}
	return record.fingerprint === fingerprint(snapshot) ? record.revision : record.revision + 1;
}

function applyPatch(scene: Scene, node: Node, patch: Partial<INodeEditSnapshot>, options: IMCPActionOptions): void {
	const value = node as any;
	if ((patch.visible !== undefined || patch.materialId !== undefined) && !isAbstractMesh(node)) {
		throw new Error(`Node "${node.name}" is not a mesh and does not support visibility or material assignment.`);
	}
	for (const property of ["isPickable", "checkCollisions", "receiveShadows", "applyGravity"] as const) {
		if (patch[property] !== undefined && typeof value[property] !== "boolean") {
			throw new Error(`Node "${node.name}" does not support ${property}.`);
		}
	}
	const material = patch.materialId ? resolveMaterial({ scene, materialId: patch.materialId }) : null;
	if (patch.enabled !== undefined) {
		node.setEnabled(patch.enabled);
	}
	if (patch.visible !== undefined) {
		(node as AbstractMesh).isVisible = patch.visible;
	}
	if (patch.materialId !== undefined) {
		(node as AbstractMesh).material = material;
	}
	if (patch.layer !== undefined || patch.tags !== undefined) {
		node.metadata ??= {};
		if (patch.layer !== undefined) {
			node.metadata.babylonEditorLayer = patch.layer;
		}
		if (patch.tags !== undefined) {
			node.metadata.babylonEditorTags = [...patch.tags];
		}
	}
	for (const property of ["isPickable", "checkCollisions", "receiveShadows", "applyGravity"] as const) {
		if (patch[property] !== undefined) {
			value[property] = patch[property];
		}
	}
	options.editor.layout.graph.setSelectedNode(node);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
}

/** Reads the controlled non-transform node state and its optimistic-concurrency revision. */
export async function getCollaborationNodeEditRevision(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const snapshot = snapshotNode(node);
	const store = await readStore(projectDirectory(options));
	return publicRevision(node, effectiveRevision(store, node, snapshot), snapshot);
}

/** Atomically applies controlled non-transform node state only when its live revision matches. */
export async function applyCollaborativeNodeEdit(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const operationId = validateOperationId(data.operationId);
	const expectedRevision = validateExpectedRevision(data.expectedRevision);
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const patch = validatePatch(data);
	const requestFingerprint = fingerprint({ nodeId: node.id, expectedRevision, patch });
	const root = projectDirectory(options);

	return withStoreGuard(root, async (store) => {
		const previousOperation = store.operations.find((entry) => entry.id === operationId);
		if (previousOperation) {
			if (previousOperation.requestFingerprint !== requestFingerprint) {
				throw new Error(`operationId "${operationId}" was already used with different arguments. Use a new operation id.`);
			}
			return { ...previousOperation.result, replayed: true };
		}

		const before = snapshotNode(node);
		const currentRevision = effectiveRevision(store, node, before);
		const now = new Date().toISOString();
		if (store.nodes[node.id]?.fingerprint !== fingerprint(before)) {
			store.nodes[node.id] = { revision: currentRevision, fingerprint: fingerprint(before), updatedAt: now };
		}

		let result: any;
		if (expectedRevision !== currentRevision) {
			result = { status: "conflict", operationId, expectedRevision, current: publicRevision(node, currentRevision, before), replayed: false };
		} else {
			applyPatch(scene, node, patch, options);
			const after = snapshotNode(node);
			const revision = currentRevision + 1;
			store.nodes[node.id] = { revision, fingerprint: fingerprint(after), updatedAt: now };
			result = { status: "applied", operationId, previousRevision: currentRevision, current: publicRevision(node, revision, after), replayed: false };
		}

		store.operations.push({ id: operationId, requestFingerprint, result, createdAt: now });
		store.operations = store.operations.slice(-maximumOperations);
		try {
			await writeStore(root, store);
		} catch (error) {
			if (result.status === "applied") {
				applyPatch(scene, node, before, options);
			}
			throw error;
		}
		return result;
	});
}

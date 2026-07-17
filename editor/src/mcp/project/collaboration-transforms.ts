import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Node, Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { setNodeTransform } from "../nodes/nodes";
import { resolveNode } from "../tools/resolve";

const storeVersion = 1;
const maximumOperations = 2000;
const operationGuardStaleMilliseconds = 10000;

interface ITransformSnapshot {
	position?: [number, number, number];
	rotation?: [number, number, number];
	scaling?: [number, number, number];
	direction?: [number, number, number];
	target?: [number, number, number];
}

interface INodeRevision {
	revision: number;
	fingerprint: string;
	updatedAt: string;
}

interface ITransformOperation {
	id: string;
	requestFingerprint: string;
	result: any;
	createdAt: string;
}

interface ICollaborationTransformStore {
	version: 1;
	nodes: Record<string, INodeRevision>;
	operations: ITransformOperation[];
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
	return join(storeDirectory(root), "collaboration-revisions.json");
}

function emptyStore(): ICollaborationTransformStore {
	return { version: storeVersion, nodes: {}, operations: [] };
}

function vector(value: any): [number, number, number] | undefined {
	return value?.x !== undefined ? [value.x, value.y, value.z] : undefined;
}

function snapshotNode(node: Node): ITransformSnapshot {
	const value = node as any;
	const target = typeof value.getTarget === "function" ? vector(value.getTarget()) : undefined;
	return {
		...(vector(value.position) ? { position: vector(value.position) } : {}),
		...(vector(value.rotation) ? { rotation: vector(value.rotation) } : {}),
		...(vector(value.scaling) ? { scaling: vector(value.scaling) } : {}),
		...(vector(value.direction) ? { direction: vector(value.direction) } : {}),
		...(target ? { target } : {}),
	};
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicRevision(node: Node, revision: number, snapshot = snapshotNode(node)): any {
	return { nodeId: node.id, nodeName: node.name, revision, transform: snapshot, fingerprint: fingerprint(snapshot) };
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

function validateStore(value: any): value is ICollaborationTransformStore {
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

async function readStore(root: string): Promise<ICollaborationTransformStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (!validateStore(value)) {
			throw new Error("The collaboration transform revision store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return emptyStore();
		}
		if (error instanceof SyntaxError) {
			throw new Error("The collaboration transform revision store contains invalid JSON. Repair .babylon-editor/collaboration-revisions.json.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: ICollaborationTransformStore): Promise<void> {
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

async function withStoreGuard<T>(root: string, action: (store: ICollaborationTransformStore) => Promise<T>): Promise<T> {
	const directory = storeDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".collaboration-revisions.operation");
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
		throw new Error("The collaboration transform revision store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

function effectiveRevision(store: ICollaborationTransformStore, node: Node, snapshot: ITransformSnapshot): number {
	const record = store.nodes[node.id];
	if (!record) {
		return 0;
	}
	return record.fingerprint === fingerprint(snapshot) ? record.revision : record.revision + 1;
}

/** Reads a node's live transform and optimistic-concurrency revision without modifying the scene. */
export async function getCollaborationNodeRevision(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const snapshot = snapshotNode(node);
	const store = await readStore(projectDirectory(options));
	return publicRevision(node, effectiveRevision(store, node, snapshot), snapshot);
}

/** Atomically applies a transform only when the caller's expected revision still matches the live node. */
export async function applyCollaborativeNodeTransform(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const operationId = validateOperationId(data.operationId);
	const expectedRevision = validateExpectedRevision(data.expectedRevision);
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const transform = {
		...(data.position !== undefined ? { position: data.position } : {}),
		...(data.rotation !== undefined ? { rotation: data.rotation } : {}),
		...(data.scaling !== undefined ? { scaling: data.scaling } : {}),
		...(data.direction !== undefined ? { direction: data.direction } : {}),
		...(data.target !== undefined ? { target: data.target } : {}),
	};
	if (!Object.keys(transform).length) {
		throw new Error("Provide at least one transform field: position, rotation, scaling, direction, or target.");
	}
	const requestFingerprint = fingerprint({ nodeId: node.id, expectedRevision, transform });
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
			setNodeTransform(scene, { nodeId: node.id, ...transform }, options);
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
				setNodeTransform(scene, { nodeId: node.id, ...before }, options);
			}
			throw error;
		}
		return result;
	});
}

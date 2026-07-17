import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join, normalize, relative, resolve } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveProjectCollaborationActor } from "./collaboration";

const assetLockVersion = 2;
const defaultTtlSeconds = 1800;
const minimumTtlSeconds = 30;
const maximumTtlSeconds = 604800;
const operationGuardStaleMilliseconds = 10000;

export interface IProjectAssetLock {
	version: 1 | 2;
	path: string;
	owner: string;
	memberId?: string;
	clientName?: string;
	lockId: string;
	note: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function storageDirectory(root: string): string {
	return join(root, ".babylon-editor", "asset-locks");
}

function lockFileName(path: string): string {
	return `${createHash("sha256").update(path).digest("hex")}.lock.json`;
}

function lockFilePath(root: string, path: string): string {
	return join(storageDirectory(root), lockFileName(path));
}

function validateOwner(owner: unknown): string {
	if (typeof owner !== "string" || !owner.trim() || owner.trim().length > 128 || /[\r\n\0]/.test(owner)) {
		throw new Error("owner must contain 1 through 128 characters without line breaks.");
	}
	return owner.trim();
}

function validateNote(note: unknown): string {
	if (note === undefined || note === null) {
		return "";
	}
	if (typeof note !== "string" || note.length > 512 || /\0/.test(note)) {
		throw new Error("note must be a string of at most 512 characters without null bytes.");
	}
	return note;
}

function validateTtlSeconds(value: unknown): number {
	const ttlSeconds = value ?? defaultTtlSeconds;
	if (!Number.isInteger(ttlSeconds) || (ttlSeconds as number) < minimumTtlSeconds || (ttlSeconds as number) > maximumTtlSeconds) {
		throw new Error(`ttlSeconds must be an integer from ${minimumTtlSeconds} through ${maximumTtlSeconds}.`);
	}
	return ttlSeconds as number;
}

async function validateAssetPath(root: string, value: unknown): Promise<string> {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error("path must be a non-empty project-relative asset or editor-file path.");
	}
	const slashPath = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const path = normalize(slashPath);
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path.startsWith(".babylon-editor/asset-locks")) {
		throw new Error("path must stay inside the active project and cannot target the asset-lock store.");
	}
	const absolute = resolve(root, path);
	const [realRoot, realTarget, targetStat] = await Promise.all([realpath(root), realpath(absolute), stat(absolute)]).catch(() => {
		throw new Error(`Cannot lock missing project file: ${path}`);
	});
	if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
		throw new Error("path must resolve inside the active project.");
	}
	if (!targetStat.isFile()) {
		throw new Error(`Asset locks require a file path, not a directory: ${path}`);
	}
	return relative(root, absolute).replace(/\\/g, "/");
}

function isAssetLock(value: any): value is IProjectAssetLock {
	return (
		(value?.version === 1 || value?.version === assetLockVersion) &&
		typeof value.path === "string" &&
		typeof value.owner === "string" &&
		typeof value.lockId === "string" &&
		typeof value.note === "string" &&
		(value.memberId === undefined || typeof value.memberId === "string") &&
		(value.clientName === undefined || typeof value.clientName === "string") &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		Number.isFinite(Date.parse(value.updatedAt)) &&
		Number.isFinite(Date.parse(value.expiresAt))
	);
}

async function optionalActor(data: any, options: IMCPActionOptions): Promise<any | null> {
	return data.collaborationToken ? resolveProjectCollaborationActor(data.collaborationToken, options) : null;
}

function actorOwnsLock(actor: any | null, lock: IProjectAssetLock): boolean {
	return actor ? lock.memberId === actor.memberId : !lock.memberId;
}

function publicLock(lock: IProjectAssetLock, actor: any | null): any {
	const canManage = actor ? actor.role === "admin" || actorOwnsLock(actor, lock) : true;
	const { lockId, ...safe } = lock;
	return { ...safe, ...(canManage ? { lockId } : {}), canManage };
}

async function readLock(path: string): Promise<IProjectAssetLock | null> {
	try {
		const value = JSON.parse(await readFile(path, "utf-8"));
		return isAssetLock(value) ? value : null;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return null;
		}
		return null;
	}
}

async function writeLock(path: string, value: IProjectAssetLock): Promise<void> {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function isExpired(lock: IProjectAssetLock, now = Date.now()): boolean {
	return Date.parse(lock.expiresAt) <= now;
}

async function withStoreGuard<T>(root: string, action: (directory: string) => Promise<T>): Promise<T> {
	const directory = storageDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const candidate = await open(guardPath, "wx");
			try {
				await candidate.writeFile(`${Date.now()}\n`, "utf-8");
				handle = candidate;
			} catch (error) {
				await candidate.close().catch(() => undefined);
				await unlink(guardPath).catch(() => undefined);
				throw error;
			}
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
		throw new Error("The project asset-lock store is busy. Retry the operation.");
	}
	try {
		return await action(directory);
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

/** Lists valid project-local asset locks without changing the lock store. */
export async function listProjectAssetLocks(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const actor = await optionalActor(data, options);
	const directory = storageDirectory(root);
	const includeExpired = data.includeExpired === true;
	const files = await readdir(directory).catch((error: any) => {
		if (error?.code === "ENOENT") {
			return [];
		}
		throw error;
	});
	const now = Date.now();
	const locks: Array<IProjectAssetLock & { expired: boolean; remainingSeconds: number }> = [];
	let invalidEntryCount = 0;
	for (const file of files.filter((candidate) => candidate.endsWith(".lock.json")).sort()) {
		const lock = await readLock(join(directory, file));
		if (!lock || lockFileName(lock.path) !== file) {
			invalidEntryCount++;
			continue;
		}
		const expired = isExpired(lock, now);
		if (!expired || includeExpired) {
			locks.push({ ...lock, expired, remainingSeconds: Math.max(0, Math.ceil((Date.parse(lock.expiresAt) - now) / 1000)) });
		}
	}
	locks.sort((first, second) => first.path.localeCompare(second.path) || first.owner.localeCompare(second.owner));
	return {
		storage: relative(root, directory),
		activeCount: locks.filter((lock) => !lock.expired).length,
		invalidEntryCount,
		federated: Boolean(actor),
		locks: locks.map((lock) => ({ ...publicLock(lock, actor), expired: lock.expired, remainingSeconds: lock.remainingSeconds })),
	};
}

/** Atomically acquires or renews one project-local asset lock. */
export async function acquireProjectAssetLock(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const path = await validateAssetPath(root, data.path);
	const actor = await optionalActor(data, options);
	const owner = actor ? actor.memberName : validateOwner(data.owner);
	const note = validateNote(data.note);
	const ttlSeconds = validateTtlSeconds(data.ttlSeconds);
	return withStoreGuard(root, async () => {
		const filePath = lockFilePath(root, path);
		const existing = await readLock(filePath);
		const now = new Date();
		const sameOwner = existing ? (actor ? existing.memberId === actor.memberId : !existing.memberId && existing.owner === owner) : false;
		if (existing && !isExpired(existing, now.getTime()) && !sameOwner) {
			return { acquired: false, reused: false, conflict: publicLock(existing, actor) };
		}
		const reused = Boolean(existing && !isExpired(existing, now.getTime()) && sameOwner);
		const lock: IProjectAssetLock = {
			version: assetLockVersion,
			path,
			owner,
			...(actor ? { memberId: actor.memberId, clientName: actor.clientName } : {}),
			lockId: reused ? existing!.lockId : randomUUID(),
			note,
			createdAt: reused ? existing!.createdAt : now.toISOString(),
			updatedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
		};
		await writeLock(filePath, lock);
		return { acquired: true, reused, replacedExpired: Boolean(existing && isExpired(existing, now.getTime())), federated: Boolean(actor), lock: publicLock(lock, actor) };
	});
}

/** Refreshes one owned asset-lock lease while preserving its identity. */
export async function refreshProjectAssetLock(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const path = await validateAssetPath(root, data.path);
	const actor = await optionalActor(data, options);
	if (typeof data.lockId !== "string" || !data.lockId) {
		throw new Error("lockId is required to refresh an asset lock.");
	}
	const ttlSeconds = validateTtlSeconds(data.ttlSeconds);
	return withStoreGuard(root, async () => {
		const filePath = lockFilePath(root, path);
		const existing = await readLock(filePath);
		if (!existing) {
			throw new Error(`No valid asset lock exists for: ${path}`);
		}
		if (existing.lockId !== data.lockId) {
			throw new Error(`Asset lock ownership changed for ${path}; refresh the lock list before retrying.`);
		}
		if (existing.memberId && !actorOwnsLock(actor, existing) && actor?.role !== "admin") {
			throw new Error(`Asset lock ${path} belongs to another collaboration member.`);
		}
		if (isExpired(existing)) {
			throw new Error(`The asset lock for ${path} expired and must be acquired again.`);
		}
		const now = new Date();
		const lock = { ...existing, updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
		await writeLock(filePath, lock);
		return { refreshed: true, federated: Boolean(actor), lock: publicLock(lock, actor) };
	});
}

/** Releases one owned lock, or force-releases it when explicitly requested. */
export async function releaseProjectAssetLock(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const path = await validateAssetPath(root, data.path);
	const actor = await optionalActor(data, options);
	if (data.force === true && actor && actor.role !== "admin") {
		throw new Error("Forced asset-lock release requires the collaboration admin role.");
	}
	if (data.force !== true && (typeof data.lockId !== "string" || !data.lockId)) {
		throw new Error("lockId is required unless force is explicitly true.");
	}
	return withStoreGuard(root, async () => {
		const filePath = lockFilePath(root, path);
		const existing = await readLock(filePath);
		if (!existing) {
			return { released: false, reason: "notLocked", path };
		}
		if (data.force !== true && existing.lockId !== data.lockId) {
			throw new Error(`Asset lock ownership changed for ${path}; refresh the lock list before retrying.`);
		}
		if (data.force !== true && existing.memberId && !actorOwnsLock(actor, existing)) {
			throw new Error(`Asset lock ${path} belongs to another collaboration member.`);
		}
		await unlink(filePath).catch((error: any) => {
			if (error?.code !== "ENOENT") {
				throw error;
			}
		});
		return { released: true, forced: data.force === true, federated: Boolean(actor), lock: publicLock(existing, actor) };
	});
}

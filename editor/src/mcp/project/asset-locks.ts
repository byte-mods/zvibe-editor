import { createHash, randomUUID } from "crypto";
import { open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { normalize } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { IProjectAssetLockRule, projectAssetLockRuleMatches, readProjectAssetLockRules } from "./asset-lock-rules";
import { getProjectCollaborationStatus, resolveProjectCollaborationActor } from "./collaboration";
import { ensureProjectStoreDirectory, inspectProjectStoreDirectory, projectPathContains } from "./project-store";
import { inspectProjectSourceControlLockFreshness } from "./source-control";

const assetLockVersion = 3;
const defaultTtlSeconds = 1800;
const minimumTtlSeconds = 30;
const maximumTtlSeconds = 604800;
const operationGuardStaleMilliseconds = 10000;

export interface IProjectAssetLock {
	version: 1 | 2 | 3;
	path: string;
	owner: string;
	memberId?: string;
	clientName?: string;
	lockId: string;
	note: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
	smartLock?: {
		ruleId: string;
		ruleName: string;
		retention: "manual" | "untilMerged";
		acquisitionBranch: string;
		acquisitionHeadHash: string;
		destinationBranch: string;
		destinationRemote: string | null;
		destinationHash: string;
		acquisitionAssetHash: string | null;
		destinationAssetHash: string | null;
	};
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

function validateAssetLockPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error("path must be a non-empty project-relative asset or editor-file path.");
	}
	const slashPath = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const path = normalize(slashPath);
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path.startsWith(".babylon-editor/asset-locks")) {
		throw new Error("path must stay inside the active project and cannot target the asset-lock store.");
	}
	return path;
}

async function validateAssetPath(root: string, value: unknown): Promise<string> {
	const path = validateAssetLockPath(value);
	const absolute = resolve(root, path);
	const [realRoot, realTarget, targetStat] = await Promise.all([realpath(root), realpath(absolute), stat(absolute)]).catch(() => {
		throw new Error(`Cannot lock missing project file: ${path}`);
	});
	if (!projectPathContains(realRoot, realTarget)) {
		throw new Error("path must resolve inside the active project.");
	}
	if (!targetStat.isFile()) {
		throw new Error(`Asset locks require a file path, not a directory: ${path}`);
	}
	return relative(root, absolute).replace(/\\/g, "/");
}

function isAssetLock(value: any): value is IProjectAssetLock {
	return (
		(value?.version === 1 || value?.version === 2 || value?.version === 3) &&
		typeof value.path === "string" &&
		typeof value.owner === "string" &&
		typeof value.lockId === "string" &&
		typeof value.note === "string" &&
		(value.memberId === undefined || typeof value.memberId === "string") &&
		(value.clientName === undefined || typeof value.clientName === "string") &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		Number.isFinite(Date.parse(value.updatedAt)) &&
		Number.isFinite(Date.parse(value.expiresAt)) &&
		(value.smartLock === undefined ||
			(typeof value.smartLock?.ruleId === "string" &&
				typeof value.smartLock.ruleName === "string" &&
				(value.smartLock.retention === "manual" || value.smartLock.retention === "untilMerged") &&
				typeof value.smartLock.acquisitionBranch === "string" &&
				/^[a-f0-9]{40,64}$/i.test(value.smartLock.acquisitionHeadHash) &&
				typeof value.smartLock.destinationBranch === "string" &&
				(value.smartLock.destinationRemote === null || typeof value.smartLock.destinationRemote === "string") &&
				/^[a-f0-9]{40,64}$/i.test(value.smartLock.destinationHash) &&
				(value.smartLock.acquisitionAssetHash === null || /^[a-f0-9]{40,64}$/i.test(value.smartLock.acquisitionAssetHash)) &&
				(value.smartLock.destinationAssetHash === null || /^[a-f0-9]{40,64}$/i.test(value.smartLock.destinationAssetHash))))
	);
}

function matchingSmartLockRules(rules: IProjectAssetLockRule[], path: string): IProjectAssetLockRule[] {
	return rules.filter((rule) => projectAssetLockRuleMatches(rule, path));
}

async function smartLockFreshness(rule: IProjectAssetLockRule, path: string, options: IMCPActionOptions, acquisitionHeadHash?: string): Promise<any> {
	return inspectProjectSourceControlLockFreshness(
		{} as Scene,
		{
			path,
			destinationBranch: rule.destinationBranch,
			destinationRemote: rule.destinationRemote,
			acquisitionHeadHash,
		},
		options
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

async function smartLockRetention(lock: IProjectAssetLock, options: IMCPActionOptions): Promise<any | null> {
	if (lock.smartLock?.retention !== "untilMerged") {
		return null;
	}
	try {
		const evidence = await inspectProjectSourceControlLockFreshness(
			{} as Scene,
			{
				path: lock.path,
				destinationBranch: lock.smartLock.destinationBranch,
				destinationRemote: lock.smartLock.destinationRemote,
				acquisitionHeadHash: lock.smartLock.acquisitionHeadHash,
				acquisitionBranch: lock.smartLock.acquisitionBranch,
			},
			options
		);
		return {
			mode: lock.smartLock.retention,
			retained: evidence.acquisitionMergedToDestination !== true || !evidence.pathClean,
			releaseReady: evidence.acquisitionMergedToDestination === true && evidence.pathClean,
			destinationAdvanced: evidence.destinationHash !== lock.smartLock.destinationHash,
			acquisitionMergedToDestination: evidence.acquisitionMergedToDestination,
			retainedRevisionHash: evidence.retainedRevisionHash,
			pathClean: evidence.pathClean,
			currentDestinationHash: evidence.destinationHash,
			destinationRef: evidence.destinationRef,
		};
	} catch (error: any) {
		return { mode: lock.smartLock.retention, retained: true, releaseReady: false, error: error.message };
	}
}

async function withStoreGuard<T>(root: string, action: (directory: string) => Promise<T>): Promise<T> {
	const directory = await ensureProjectStoreDirectory(root, ".babylon-editor", "asset-locks");
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
	const directory = await inspectProjectStoreDirectory(root, ".babylon-editor", "asset-locks");
	const includeExpired = data.includeExpired === true;
	const files = directory
		? await readdir(directory).catch((error: any) => {
				if (error?.code === "ENOENT") {
					return [];
				}
				throw error;
			})
		: [];
	const now = Date.now();
	const locks: Array<IProjectAssetLock & { expired: boolean; retainedByPolicy: boolean; remainingSeconds: number }> = [];
	let invalidEntryCount = 0;
	for (const file of files.filter((candidate) => candidate.endsWith(".lock.json")).sort()) {
		const lock = await readLock(join(directory!, file));
		if (!lock || lockFileName(lock.path) !== file) {
			invalidEntryCount++;
			continue;
		}
		const expired = isExpired(lock, now);
		const retainedByPolicy = lock.smartLock?.retention === "untilMerged";
		if (!expired || includeExpired || retainedByPolicy) {
			locks.push({ ...lock, expired, retainedByPolicy, remainingSeconds: Math.max(0, Math.ceil((Date.parse(lock.expiresAt) - now) / 1000)) });
		}
	}
	locks.sort((first, second) => first.path.localeCompare(second.path) || first.owner.localeCompare(second.owner));
	return {
		storage: relative(root, storageDirectory(root)),
		activeCount: locks.filter((lock) => !lock.expired).length,
		retainedPolicyCount: locks.filter((lock) => lock.retainedByPolicy).length,
		invalidEntryCount,
		federated: Boolean(actor),
		locks: locks.map((lock) => ({ ...publicLock(lock, actor), expired: lock.expired, retainedByPolicy: lock.retainedByPolicy, remainingSeconds: lock.remainingSeconds })),
	};
}

/** Evaluates the first matching Smart Lock rule, exact destination freshness, and retained-lock release evidence for one asset. */
export async function inspectProjectAssetLockPolicy(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const path = await validateAssetPath(root, data.path);
	const actor = await optionalActor(data, options);
	const rules = matchingSmartLockRules(await readProjectAssetLockRules(options), path);
	const rule = rules[0] ?? null;
	const lockDirectory = await inspectProjectStoreDirectory(root, ".babylon-editor", "asset-locks");
	const lock = lockDirectory ? await readLock(join(lockDirectory, lockFileName(path))) : null;
	const freshness = rule ? await smartLockFreshness(rule, path, options) : null;
	const retention = lock ? await smartLockRetention(lock, options) : null;
	return {
		path,
		smartLockRequired: Boolean(rule),
		matchedRuleCount: rules.length,
		rule,
		freshness,
		lock: lock ? { ...publicLock(lock, actor), expired: isExpired(lock) } : null,
		retention,
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
	const matchingRules = matchingSmartLockRules(await readProjectAssetLockRules(options), path);
	const rule = matchingRules[0] ?? null;
	return withStoreGuard(root, async () => {
		const filePath = lockFilePath(root, path);
		const existing = await readLock(filePath);
		const now = new Date();
		const existingRetention = existing ? await smartLockRetention(existing, options) : null;
		const retained = existingRetention?.retained === true;
		const sameOwner = existing ? (actor ? existing.memberId === actor.memberId : !existing.memberId && existing.owner === owner) : false;
		if (existing && (!isExpired(existing, now.getTime()) || retained) && !sameOwner) {
			return { acquired: false, reused: false, retained, retention: existingRetention, conflict: publicLock(existing, actor) };
		}
		const reused = Boolean(existing && (!isExpired(existing, now.getTime()) || retained) && sameOwner);
		const freshness = rule ? await smartLockFreshness(rule, path, options) : null;
		if (freshness) {
			if (typeof data.expectedHeadHash !== "string" || !/^[a-f0-9]{40,64}$/i.test(data.expectedHeadHash)) {
				throw new Error("expectedHeadHash is required from Smart Lock policy inspection when a rule matches.");
			}
			if (typeof data.expectedDestinationHash !== "string" || !/^[a-f0-9]{40,64}$/i.test(data.expectedDestinationHash)) {
				throw new Error("expectedDestinationHash is required from Smart Lock policy inspection when a rule matches.");
			}
			if (freshness.headHash !== data.expectedHeadHash || freshness.destinationHash !== data.expectedDestinationHash) {
				throw new Error("Smart Lock Git revisions changed since policy inspection. Inspect the asset policy again before acquiring its lock.");
			}
			if (!freshness.containsDestination) {
				throw new Error(
					`The current branch does not contain destination ${freshness.destinationRef}. Fetch and merge or rebase the destination before acquiring this Smart Lock.`
				);
			}
			if (!freshness.pathClean) {
				throw new Error(`Smart Lock acquisition requires ${path} to be clean in the Git worktree and index.`);
			}
		}
		const smartLock = rule
			? reused && existing?.smartLock?.ruleId === rule.id
				? existing.smartLock
				: {
						ruleId: rule.id,
						ruleName: rule.name,
						retention: rule.retention,
						acquisitionBranch: freshness.currentBranch,
						acquisitionHeadHash: freshness.headHash,
						destinationBranch: rule.destinationBranch,
						destinationRemote: rule.destinationRemote,
						destinationHash: freshness.destinationHash,
						acquisitionAssetHash: freshness.headAssetHash,
						destinationAssetHash: freshness.destinationAssetHash,
					}
			: undefined;
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
			...(smartLock ? { smartLock } : {}),
		};
		await writeLock(filePath, lock);
		return {
			acquired: true,
			reused,
			replacedExpired: Boolean(existing && isExpired(existing, now.getTime()) && !retained),
			federated: Boolean(actor),
			smartLockRequired: Boolean(rule),
			matchedRuleCount: matchingRules.length,
			rule,
			freshness,
			lock: publicLock(lock, actor),
		};
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
export async function releaseProjectAssetLock(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	const path = validateAssetLockPath(data.path);
	const actor = await optionalActor(data, options);
	if (data.force === true) {
		const collaboration = await getProjectCollaborationStatus(scene, { collaborationToken: data.collaborationToken }, options);
		if ((collaboration.enforcementEnabled || actor) && actor?.role !== "admin") {
			throw new Error("Forced asset-lock release requires the collaboration admin role.");
		}
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
		const retention = data.force === true ? null : await smartLockRetention(existing, options);
		if (retention?.retained) {
			throw new Error(
				`Smart Lock ${path} is retained until ${existing.smartLock!.acquisitionBranch} is clean and revision ${(retention.retainedRevisionHash ?? existing.smartLock!.acquisitionHeadHash).slice(0, 12)} is merged into ${retention.destinationRef ?? existing.smartLock!.destinationBranch}. Use an administrator force release only when recovery requires it.`
			);
		}
		await unlink(filePath).catch((error: any) => {
			if (error?.code !== "ENOENT") {
				throw error;
			}
		});
		return { released: true, forced: data.force === true, federated: Boolean(actor), retention, lock: publicLock(existing, actor) };
	});
}

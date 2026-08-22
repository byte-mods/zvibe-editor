import { randomUUID } from "crypto";
import { lstat, readFile, realpath, rename, unlink, writeFile } from "fs/promises";
import { isIP } from "net";
import { dirname, isAbsolute, join, resolve } from "path";
import { normalize as normalizePortablePath } from "path/posix";

import { satisfies, valid, validRange } from "semver";
import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../../action";
import { resumeProjectEditorExtensions, suspendProjectEditorExtensions } from "../../../extensions/project";
import { projectPathContains } from "../project-store";
import { getProjectPackageContext, packageProjectRelativePath, packageSha256, requireWorkspaceMutationPermission } from "./context";
import { projectPackageCommand, projectPackageSourceCommand, runProjectPackageProcess, validateProjectPackageName, validateProjectPackageVersion } from "./process";
import { IProjectPackageCommand, IProjectPackageContext, IProjectPackageProcessResult, ProjectPackageDependencyType, ProjectPackageOperation } from "./types";

const packagePlanLifetimeMs = 15 * 60 * 1_000;
const maximumSnapshotFileBytes = 32 * 1024 * 1024;
const maximumSnapshotBytes = 64 * 1024 * 1024;
const dependencyTypes: ProjectPackageDependencyType[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const allLockfileNames = ["npm-shrinkwrap.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
const applyingPlans = new WeakSet<Scene>();

interface IProjectPackageSource {
	type: "registry" | "git" | "local" | "tarball";
	specification: string;
	display: string;
}

interface IProjectPackagePlanChange {
	operation: ProjectPackageOperation;
	name: string;
	version: string | null;
	dependencyType: ProjectPackageDependencyType;
	source: IProjectPackageSource;
	command: IProjectPackageCommand;
}

interface IProjectPackagePlan {
	id: string;
	createdAt: string;
	expiresAt: string;
	sourceFingerprint: string;
	packageManager: IProjectPackageContext["packageManager"];
	projectRoot: string;
	workspaceRoot: string | null;
	allowWorkspaceRoot: boolean;
	allowScripts: boolean;
	timeoutMs: number;
	maximumOutputBytes: number;
	changes: IProjectPackagePlanChange[];
}

interface IProjectPackageSnapshot {
	path: string;
	bytes: Buffer | null;
	sha256: string | null;
	mode: number;
}

const packagePlans = new WeakMap<Scene, Map<string, IProjectPackagePlan>>();

function planMap(scene: Scene): Map<string, IProjectPackagePlan> {
	let plans = packagePlans.get(scene);
	if (!plans) {
		plans = new Map();
		packagePlans.set(scene, plans);
	}
	const now = Date.now();
	for (const [id, plan] of plans) {
		if (Date.parse(plan.expiresAt) <= now) {
			plans.delete(id);
		}
	}
	while (plans.size >= 20) {
		plans.delete(plans.keys().next().value!);
	}
	return plans;
}

function directDependencyType(context: IProjectPackageContext, name: string): ProjectPackageDependencyType | null {
	return dependencyTypes.find((dependencyType) => Object.prototype.hasOwnProperty.call(context.manifest[dependencyType] ?? {}, name)) ?? null;
}

function validateDependencyType(value: unknown, fallback: ProjectPackageDependencyType): ProjectPackageDependencyType {
	const dependencyType = value ?? fallback;
	if (!dependencyTypes.includes(dependencyType as ProjectPackageDependencyType)) {
		throw new Error(`dependencyType must be one of ${dependencyTypes.join(", ")}.`);
	}
	return dependencyType as ProjectPackageDependencyType;
}

function portableProjectPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 1_024 || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
		throw new Error("Local package path must be a non-empty project-relative path of at most 1024 characters without control characters.");
	}
	const replaced = value.trim().replace(/\\/g, "/");
	const normalized = normalizePortablePath(replaced.replace(/^\.\//, ""));
	if (normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new Error("Local package path must stay inside the active project.");
	}
	return normalized;
}

async function localSource(context: IProjectPackageContext, value: unknown, tarball: boolean): Promise<IProjectPackageSource> {
	const path = portableProjectPath(value);
	const absolute = resolve(context.projectRoot, path);
	let resolved: string;
	try {
		resolved = await realpath(absolute);
	} catch {
		throw new Error(`Local package source does not exist: ${path}`);
	}
	if (!projectPathContains(context.projectRoot, resolved)) {
		throw new Error("Local package source must resolve inside the active project.");
	}
	const sourceStat = await lstat(resolved);
	if (sourceStat.isSymbolicLink()) {
		throw new Error("Local package source cannot be a symbolic link.");
	}
	if (tarball) {
		if (!sourceStat.isFile() || !/\.(?:tgz|tar\.gz)$/i.test(path)) {
			throw new Error("Local tarball source must be a regular project-contained .tgz or .tar.gz file.");
		}
	} else {
		if (!sourceStat.isDirectory()) {
			throw new Error("Local package source must be a project-contained directory.");
		}
		const manifestPath = join(resolved, "package.json");
		const manifestStat = await lstat(manifestPath).catch(() => null);
		if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > 1024 * 1024) {
			throw new Error("Local package directory must contain a regular package.json of at most 1 MiB.");
		}
	}
	return { type: tarball ? "tarball" : "local", specification: `file:${path}`, display: path };
}

function loopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) {
		return true;
	}
	if (isIP(normalized) === 4) {
		return normalized.startsWith("127.");
	}
	return normalized === "::1";
}

function externalSourceUrl(value: unknown, kind: "git" | "tarball", commit?: unknown): IProjectPackageSource {
	if (typeof value !== "string" || !value || value.length > 2_048) {
		throw new Error(`${kind} package URL must be 1–2048 characters.`);
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${kind} package URL must be absolute.`);
	}
	const normalizedProtocol = parsed.protocol.replace(/^git\+/, "");
	const allowedProtocol =
		kind === "git"
			? normalizedProtocol === "https:" || normalizedProtocol === "ssh:" || (normalizedProtocol === "http:" && loopbackHostname(parsed.hostname))
			: normalizedProtocol === "https:" || (normalizedProtocol === "http:" && loopbackHostname(parsed.hostname));
	if (!allowedProtocol || parsed.password || parsed.hash || (parsed.username && !(normalizedProtocol === "ssh:" && parsed.username === "git"))) {
		throw new Error(`${kind} package URL must be credential-free HTTPS${kind === "git" ? "/SSH" : ""}, or credential-free loopback HTTP.`);
	}
	let specification = value;
	if (commit !== undefined) {
		if (kind !== "git" || typeof commit !== "string" || !/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(commit)) {
			throw new Error("Git commit/tag must be 1–128 safe characters and cannot start with a dash.");
		}
		specification = `${value}#${commit}`;
	}
	return { type: kind, specification, display: specification.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted]@") };
}

async function normalizeSource(context: IProjectPackageContext, data: any, name: string, version: string | undefined): Promise<IProjectPackageSource> {
	const type = data?.source?.type ?? "registry";
	if (type === "registry") {
		if (!version || !valid(version)) {
			throw new Error(`Registry package "${name}" requires an exact semantic version for a deterministic plan.`);
		}
		return { type: "registry", specification: `${name}@${version}`, display: `${name}@${version}` };
	}
	if (type === "local") {
		return localSource(context, data.source.path, false);
	}
	if (type === "tarball") {
		return data.source.path !== undefined ? localSource(context, data.source.path, true) : externalSourceUrl(data.source.url, "tarball");
	}
	if (type === "git") {
		return externalSourceUrl(data.source.url, "git", data.source.commit);
	}
	throw new Error('Package source type must be "registry", "git", "local", or "tarball".');
}

async function normalizeChange(context: IProjectPackageContext, data: any, allowScripts: boolean): Promise<IProjectPackagePlanChange> {
	if (!data || !["install", "remove", "update"].includes(data.operation)) {
		throw new Error('Each package change operation must be "install", "remove", or "update".');
	}
	const operation = data.operation as ProjectPackageOperation;
	const name = validateProjectPackageName(data.name);
	const currentType = directDependencyType(context, name);
	if (operation === "install" && currentType) {
		throw new Error(`Package "${name}" is already a direct ${currentType}; use update instead.`);
	}
	if ((operation === "update" || operation === "remove") && !currentType) {
		throw new Error(`Package "${name}" is not a direct dependency and cannot be ${operation === "remove" ? "removed" : "updated"}.`);
	}
	const dependencyType = validateDependencyType(data.dependencyType, currentType ?? "dependencies");
	if (operation === "remove") {
		const command = projectPackageCommand(context.packageManager, operation, name, { allowScripts });
		return { operation, name, version: null, dependencyType, source: { type: "registry", specification: name, display: name }, command };
	}
	const version = validateProjectPackageVersion(data.version);
	const source = await normalizeSource(context, data, name, version);
	if (operation === "update" && source.type !== "registry") {
		throw new Error("Git, local, and tarball sources are installed as replacements; use remove then install rather than update.");
	}
	const command =
		source.type === "registry"
			? projectPackageCommand(context.packageManager, operation, name, { version, dependencyType, allowScripts })
			: projectPackageSourceCommand(context.packageManager, source.specification, dependencyType, allowScripts);
	return { operation, name, version: version ?? null, dependencyType, source, command };
}

function publicPlan(plan: IProjectPackagePlan): any {
	return {
		id: plan.id,
		createdAt: plan.createdAt,
		expiresAt: plan.expiresAt,
		sourceFingerprint: plan.sourceFingerprint,
		packageManager: plan.packageManager,
		workspace: plan.workspaceRoot ? { root: plan.workspaceRoot, allowWorkspaceRoot: plan.allowWorkspaceRoot } : null,
		allowScripts: plan.allowScripts,
		timeoutMs: plan.timeoutMs,
		maximumOutputBytes: plan.maximumOutputBytes,
		changes: plan.changes.map((change) => ({
			operation: change.operation,
			name: change.name,
			version: change.version,
			dependencyType: change.dependencyType,
			source: { type: change.source.type, display: change.source.display },
			command: change.command.display,
		})),
		writes: ["package.json", "selected-manager lockfile", "node_modules"],
		rollback: { packageJsonAndLockfiles: "exact", nodeModules: "best-effort manager state; run a clean install if a package lifecycle script changed external state" },
	};
}

/** Creates an exact expiring plan for 1–100 package installs, updates, and removals. */
export async function planProjectPackageChanges(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!Array.isArray(data?.changes) || data.changes.length < 1 || data.changes.length > 100) {
		throw new Error("changes must contain 1–100 package operations.");
	}
	const context = await getProjectPackageContext(options);
	if (data.expectedFingerprint !== context.fingerprint) {
		throw new Error(`expectedFingerprint must exactly match current package state ${context.fingerprint}.`);
	}
	requireWorkspaceMutationPermission(context, data.allowWorkspaceRoot);
	const allowScripts = data.allowScripts === true;
	const timeoutMs = data.timeoutMs ?? 600_000;
	const maximumOutputBytes = data.maximumOutputBytes ?? 1024 * 1024;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
		throw new Error("timeoutMs must be an integer from 1000 through 1800000.");
	}
	if (!Number.isInteger(maximumOutputBytes) || maximumOutputBytes < 16_384 || maximumOutputBytes > 4 * 1024 * 1024) {
		throw new Error("maximumOutputBytes must be an integer from 16384 through 4194304.");
	}
	const changes: IProjectPackagePlanChange[] = [];
	for (const change of data.changes) {
		changes.push(await normalizeChange(context, change, allowScripts));
	}
	const duplicate = changes.find((change, index) => changes.findIndex((candidate) => candidate.name === change.name) !== index);
	if (duplicate) {
		throw new Error(`Package "${duplicate.name}" appears more than once in the same plan.`);
	}
	const now = Date.now();
	const plan: IProjectPackagePlan = {
		id: randomUUID(),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + packagePlanLifetimeMs).toISOString(),
		sourceFingerprint: context.fingerprint,
		packageManager: context.packageManager,
		projectRoot: context.projectRoot,
		workspaceRoot: context.workspaceRoot,
		allowWorkspaceRoot: data.allowWorkspaceRoot === true,
		allowScripts,
		timeoutMs,
		maximumOutputBytes,
		changes,
	};
	planMap(scene).set(plan.id, plan);
	return publicPlan(plan);
}

function snapshotPaths(context: IProjectPackageContext): string[] {
	const roots = [...new Set([context.projectRoot, context.workspaceRoot].filter((value): value is string => Boolean(value)))];
	return [...new Set([context.manifestPath, ...roots.flatMap((root) => allLockfileNames.map((name) => join(root, name)))])];
}

async function captureSnapshots(context: IProjectPackageContext): Promise<IProjectPackageSnapshot[]> {
	const snapshots: IProjectPackageSnapshot[] = [];
	let totalBytes = 0;
	for (const path of snapshotPaths(context)) {
		let fileStat;
		try {
			fileStat = await lstat(path);
		} catch (error: any) {
			if (error?.code === "ENOENT") {
				snapshots.push({ path, bytes: null, sha256: null, mode: 0o600 });
				continue;
			}
			throw error;
		}
		if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
			throw new Error(`Package transaction file must be regular and cannot be a symbolic link: ${path}`);
		}
		if (fileStat.size > maximumSnapshotFileBytes) {
			throw new Error(`Package transaction file exceeds the ${maximumSnapshotFileBytes}-byte snapshot limit: ${path}`);
		}
		totalBytes += fileStat.size;
		if (totalBytes > maximumSnapshotBytes) {
			throw new Error(`Package transaction snapshots exceed the ${maximumSnapshotBytes}-byte total limit.`);
		}
		const bytes = await readFile(path);
		snapshots.push({ path, bytes, sha256: packageSha256(bytes), mode: fileStat.mode & 0o777 });
	}
	return snapshots;
}

async function replaceFile(path: string, bytes: Buffer, mode: number): Promise<void> {
	const id = randomUUID();
	const temporary = join(dirname(path), `.${id}.zvibe-package.tmp`);
	const backup = join(dirname(path), `.${id}.zvibe-package.bak`);
	await writeFile(temporary, bytes, { flag: "wx", mode });
	let backedUp = false;
	try {
		try {
			const current = await lstat(path);
			if (current.isSymbolicLink() || !current.isFile()) {
				throw new Error(`Rollback target must remain a regular file: ${path}`);
			}
			await rename(path, backup);
			backedUp = true;
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				throw error;
			}
		}
		await rename(temporary, path);
		if (backedUp) {
			await unlink(backup);
		}
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		if (backedUp) {
			await rename(backup, path).catch(() => undefined);
		}
		throw error;
	}
}

async function restoreSnapshots(snapshots: IProjectPackageSnapshot[]): Promise<{ restored: boolean; files: { path: string; sha256: string | null }[] }> {
	for (const snapshot of snapshots) {
		if (snapshot.bytes === null) {
			try {
				const current = await lstat(snapshot.path);
				if (current.isSymbolicLink() || !current.isFile()) {
					throw new Error(`Rollback target must remain a regular file: ${snapshot.path}`);
				}
				await unlink(snapshot.path);
			} catch (error: any) {
				if (error?.code !== "ENOENT") {
					throw error;
				}
			}
		} else {
			await replaceFile(snapshot.path, snapshot.bytes, snapshot.mode);
		}
	}
	for (const snapshot of snapshots) {
		if (snapshot.bytes === null) {
			try {
				await lstat(snapshot.path);
				throw new Error(`Rollback postcondition failed; new file remains: ${snapshot.path}`);
			} catch (error: any) {
				if (error?.code !== "ENOENT") {
					throw error;
				}
			}
		} else if (packageSha256(await readFile(snapshot.path)) !== snapshot.sha256) {
			throw new Error(`Rollback postcondition failed for ${snapshot.path}.`);
		}
	}
	return { restored: true, files: snapshots.map((snapshot) => ({ path: snapshot.path, sha256: snapshot.sha256 })) };
}

function directSpecification(context: IProjectPackageContext, name: string): { type: ProjectPackageDependencyType; specification: string } | null {
	for (const dependencyType of dependencyTypes) {
		const specification = context.manifest[dependencyType]?.[name];
		if (typeof specification === "string") {
			return { type: dependencyType, specification };
		}
	}
	return null;
}

function validatePostconditions(plan: IProjectPackagePlan, context: IProjectPackageContext): void {
	for (const change of plan.changes) {
		const current = directSpecification(context, change.name);
		if (change.operation === "remove") {
			if (current) {
				throw new Error(`Package postcondition failed: "${change.name}" remains in ${current.type}.`);
			}
			continue;
		}
		if (!current) {
			throw new Error(`Package postcondition failed: "${change.name}" is absent from package.json.`);
		}
		if (change.operation === "install" && current.type !== change.dependencyType) {
			throw new Error(`Package postcondition failed: "${change.name}" was written to ${current.type}, not ${change.dependencyType}.`);
		}
		if (change.source.type === "registry" && change.version && valid(change.version)) {
			const range = validRange(current.specification);
			if (!range || !satisfies(change.version, range)) {
				throw new Error(`Package postcondition failed: package.json specification "${current.specification}" does not include planned version ${change.version}.`);
			}
		}
	}
	if (!context.lockfiles.some((lockfile) => lockfile.authoritative)) {
		throw new Error(`Package postcondition failed: ${context.packageManager} did not produce an authoritative lockfile.`);
	}
}

async function changedFileEvidence(snapshots: IProjectPackageSnapshot[]): Promise<{ path: string; beforeSha256: string | null; afterSha256: string | null; changed: boolean }[]> {
	const result: { path: string; beforeSha256: string | null; afterSha256: string | null; changed: boolean }[] = [];
	for (const snapshot of snapshots) {
		let afterSha256: string | null = null;
		try {
			const fileStat = await lstat(snapshot.path);
			if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > maximumSnapshotFileBytes) {
				throw new Error(`Package transaction output is unsafe: ${snapshot.path}`);
			}
			afterSha256 = packageSha256(await readFile(snapshot.path));
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				throw error;
			}
		}
		result.push({ path: snapshot.path, beforeSha256: snapshot.sha256, afterSha256, changed: snapshot.sha256 !== afterSha256 });
	}
	return result;
}

/** Applies one exact package plan through the selected manager with bounded execution, exact file rollback, and postcondition checks. */
export async function applyProjectPackagePlan(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data?.confirm !== true) {
		throw new Error("confirm must be true to apply a project package plan.");
	}
	if (typeof data?.planId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.planId)) {
		throw new Error("planId must be a package plan UUID returned by plan_project_package_changes.");
	}
	const plans = planMap(scene);
	const plan = plans.get(data.planId);
	if (!plan) {
		throw new Error(`Package plan "${data.planId}" is missing or expired; create a fresh plan.`);
	}
	if (data.expectedFingerprint !== plan.sourceFingerprint) {
		throw new Error(`expectedFingerprint must exactly match package plan source fingerprint ${plan.sourceFingerprint}.`);
	}
	if (applyingPlans.has(scene)) {
		throw new Error("Another package plan is already applying to this scene.");
	}
	applyingPlans.add(scene);
	let snapshots: IProjectPackageSnapshot[] = [];
	const processes: IProjectPackageProcessResult[] = [];
	const extensionPackageNames = plan.changes.map((change) => change.name);
	let extensionsSuspended = false;
	try {
		const context = await getProjectPackageContext(options);
		if (context.fingerprint !== plan.sourceFingerprint || context.packageManager !== plan.packageManager || context.projectRoot !== plan.projectRoot) {
			throw new Error(`Package state changed after planning; expected ${plan.sourceFingerprint} but found ${context.fingerprint}.`);
		}
		requireWorkspaceMutationPermission(context, plan.allowWorkspaceRoot);
		// Prevent trusted code from executing while its package files are being replaced.
		extensionsSuspended = true;
		await suspendProjectEditorExtensions(options.editor, extensionPackageNames);
		snapshots = await captureSnapshots(context);
		for (const change of plan.changes) {
			const processResult = await runProjectPackageProcess(scene, context.projectRoot, change.command, {
				kind: `${change.operation}:${change.name}`,
				timeoutMs: plan.timeoutMs,
				maximumOutputBytes: plan.maximumOutputBytes,
			});
			processes.push(processResult);
			if (processResult.status !== "succeeded") {
				const detail = (processResult.stderr || processResult.stdout).trim().slice(0, 2_048);
				throw new Error(`Package-manager command ${processResult.status}: ${change.command.display}${detail ? `\n${detail}` : ""}`);
			}
		}
		const after = await getProjectPackageContext(options);
		validatePostconditions(plan, after);
		const files = await changedFileEvidence(snapshots);
		plans.delete(plan.id);
		options.editor.layout?.inspector?.forceUpdate?.();
		let extensionSync: { runtime: unknown[]; issues: unknown[] } | { error: string };
		try {
			extensionsSuspended = false;
			const snapshot = await resumeProjectEditorExtensions(options.editor, extensionPackageNames, { context: after });
			extensionSync = { runtime: snapshot.runtime, issues: snapshot.issues };
		} catch (error) {
			extensionSync = { error: error instanceof Error ? error.message : String(error) };
		}
		return {
			applied: true,
			plan: publicPlan(plan),
			beforeFingerprint: plan.sourceFingerprint,
			afterFingerprint: after.fingerprint,
			processes,
			files: files.filter((file) => file.changed).map((file) => ({ ...file, path: packageProjectRelativePath(after, file.path) })),
			extensionSync,
			rollback: null,
		};
	} catch (error) {
		let rollback: { restored: boolean; files: { path: string; sha256: string | null }[] } | null = null;
		let rollbackError: unknown = null;
		let extensionResumeError: unknown = null;
		if (snapshots.length) {
			try {
				rollback = await restoreSnapshots(snapshots);
			} catch (restoreError) {
				rollbackError = restoreError;
			}
		}
		if (extensionsSuspended) {
			extensionsSuspended = false;
			try {
				await resumeProjectEditorExtensions(options.editor, extensionPackageNames);
			} catch (resumeError) {
				extensionResumeError = resumeError;
			}
		}
		const original = error instanceof Error ? error.message : String(error);
		const rollbackMessage = rollbackError
			? ` Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
			: rollback
				? " package.json and lockfiles were restored exactly; node_modules may require a clean manager install."
				: " No package files were changed before failure.";
		const extensionMessage = extensionResumeError
			? ` Extension reconciliation failed: ${extensionResumeError instanceof Error ? extensionResumeError.message : String(extensionResumeError)}`
			: "";
		throw new Error(`${original}${rollbackMessage}${extensionMessage}`);
	} finally {
		applyingPlans.delete(scene);
	}
}

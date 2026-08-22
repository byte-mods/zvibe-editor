import { randomUUID } from "crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { normalize } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { getProjectCollaborationStatus, resolveProjectCollaborationActor } from "./collaboration";
import { ensureProjectStoreDirectory, inspectProjectStoreDirectory } from "./project-store";

const storeVersion = 1;
const maximumRules = 100;
const operationGuardStaleMilliseconds = 10000;

export type ProjectAssetLockRetention = "manual" | "untilMerged";

export interface IProjectAssetLockRule {
	id: string;
	name: string;
	enabled: boolean;
	pathPattern: string;
	destinationBranch: string;
	destinationRemote: string | null;
	retention: ProjectAssetLockRetention;
	createdAt: string;
	updatedAt: string;
}

interface IProjectAssetLockRuleStore {
	version: 1;
	rules: IProjectAssetLockRule[];
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
	return join(storeDirectory(root), "asset-lock-rules.json");
}

function validateName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\r\n\0]/.test(value)) {
		throw new Error("name must contain 1 through 128 characters without line breaks or null bytes.");
	}
	return value.trim();
}

function validatePathPattern(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value)) {
		throw new Error("pathPattern must contain 1 through 256 characters without line breaks or null bytes.");
	}
	const pattern = normalize(value.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
	if (pattern === "." || pattern.startsWith("/") || pattern.startsWith("-") || pattern.startsWith(":") || pattern.split("/").includes("..")) {
		throw new Error("pathPattern must be a safe project-relative wildcard without traversal, absolute, option, or pathspec-magic prefixes.");
	}
	return pattern.replace(/\*+/g, (stars) => (stars.length > 1 ? "**" : "*"));
}

function validateMatchPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) {
		throw new Error("path must contain 1 through 512 characters without line breaks or null bytes.");
	}
	const path = normalize(value.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
	if (path === "." || path.startsWith("/") || path.startsWith("-") || path.startsWith(":") || path.split("/").includes("..")) {
		throw new Error("path must be a safe project-relative path without traversal, absolute, option, or pathspec-magic prefixes.");
	}
	return path;
}

function validateDestinationBranch(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\r\n\0]/.test(value) || value.startsWith("-") || value.startsWith(":")) {
		throw new Error("destinationBranch must name a Git branch using at most 255 safe characters.");
	}
	return value.trim();
}

function validateDestinationRemote(value: unknown): string | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new Error("destinationRemote must be a configured Git remote name of at most 128 safe characters, or null for a local destination.");
	}
	return value;
}

function validateRetention(value: unknown): ProjectAssetLockRetention {
	const retention = value ?? "untilMerged";
	if (retention !== "manual" && retention !== "untilMerged") {
		throw new Error("retention must be manual or untilMerged.");
	}
	return retention;
}

function isRule(value: any): value is IProjectAssetLockRule {
	try {
		return (
			typeof value?.id === "string" &&
			/^[0-9a-f-]{36}$/i.test(value.id) &&
			typeof value.enabled === "boolean" &&
			validateName(value.name) === value.name &&
			validatePathPattern(value.pathPattern) === value.pathPattern &&
			validateDestinationBranch(value.destinationBranch) === value.destinationBranch &&
			validateDestinationRemote(value.destinationRemote) === value.destinationRemote &&
			validateRetention(value.retention) === value.retention &&
			Number.isFinite(Date.parse(value.createdAt)) &&
			Number.isFinite(Date.parse(value.updatedAt))
		);
	} catch {
		return false;
	}
}

async function readStore(root: string): Promise<IProjectAssetLockRuleStore> {
	const directory = await inspectProjectStoreDirectory(root, ".babylon-editor");
	if (!directory) {
		return { version: storeVersion, rules: [] };
	}
	try {
		const value = JSON.parse(await readFile(join(directory, "asset-lock-rules.json"), "utf-8"));
		if (value?.version !== storeVersion || !Array.isArray(value.rules) || value.rules.length > maximumRules || !value.rules.every(isRule)) {
			throw new Error("The Smart Lock rule store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return { version: storeVersion, rules: [] };
		}
		if (error instanceof SyntaxError) {
			throw new Error("The Smart Lock rule store contains invalid JSON. Repair .babylon-editor/asset-lock-rules.json before continuing.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: IProjectAssetLockRuleStore): Promise<void> {
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

async function withStoreGuard<T>(root: string, action: (store: IProjectAssetLockRuleStore) => Promise<T>): Promise<T> {
	const directory = await ensureProjectStoreDirectory(root, ".babylon-editor");
	const guardPath = join(directory, ".asset-lock-rules.operation");
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
		throw new Error("The Smart Lock rule store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

async function requireRuleAdministrator(scene: Scene, data: any, options: IMCPActionOptions): Promise<void> {
	const status = await getProjectCollaborationStatus(scene, { collaborationToken: data.collaborationToken }, options);
	if (!status.enforcementEnabled) {
		return;
	}
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Smart Lock policy administration requires the collaboration admin role.");
	}
}

function wildcardExpression(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === "*" && pattern[index + 1] === "*") {
			if (pattern[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else {
				source += ".*";
				index++;
			}
		} else if (character === "*") {
			source += "[^/]*";
		} else if (character === "?") {
			source += "[^/]";
		} else {
			source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`, "i");
}

export function projectAssetLockRuleMatches(rule: IProjectAssetLockRule, path: string): boolean {
	return rule.enabled && wildcardExpression(rule.pathPattern).test(path.replace(/\\/g, "/"));
}

export async function readProjectAssetLockRules(options: IMCPActionOptions): Promise<IProjectAssetLockRule[]> {
	return (await readStore(projectDirectory(options))).rules;
}

export async function listProjectAssetLockRules(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const rules = await readProjectAssetLockRules(options);
	const path = data.path === undefined ? null : validateMatchPath(data.path);
	return { total: rules.length, rules: path ? rules.filter((rule) => projectAssetLockRuleMatches(rule, path)) : rules, path };
}

export async function createProjectAssetLockRule(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireRuleAdministrator(scene, data, options);
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		if (store.rules.length >= maximumRules) {
			throw new Error(`A project can contain at most ${maximumRules} Smart Lock rules.`);
		}
		const name = validateName(data.name);
		if (store.rules.some((rule) => rule.name.toLowerCase() === name.toLowerCase())) {
			throw new Error(`A Smart Lock rule named "${name}" already exists.`);
		}
		const timestamp = new Date().toISOString();
		const rule: IProjectAssetLockRule = {
			id: randomUUID(),
			name,
			enabled: data.enabled ?? true,
			pathPattern: validatePathPattern(data.pathPattern),
			destinationBranch: validateDestinationBranch(data.destinationBranch),
			destinationRemote: validateDestinationRemote(data.destinationRemote),
			retention: validateRetention(data.retention),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.rules.push(rule);
		await writeStore(root, store);
		return { created: true, rule };
	});
}

export async function setProjectAssetLockRule(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireRuleAdministrator(scene, data, options);
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const rule = store.rules.find((candidate) => candidate.id === data.id);
		if (!rule) {
			throw new Error(`Smart Lock rule was not found: ${data.id}`);
		}
		const name = data.name === undefined ? rule.name : validateName(data.name);
		if (store.rules.some((candidate) => candidate.id !== rule.id && candidate.name.toLowerCase() === name.toLowerCase())) {
			throw new Error(`A Smart Lock rule named "${name}" already exists.`);
		}
		Object.assign(rule, {
			name,
			enabled: data.enabled ?? rule.enabled,
			pathPattern: data.pathPattern === undefined ? rule.pathPattern : validatePathPattern(data.pathPattern),
			destinationBranch: data.destinationBranch === undefined ? rule.destinationBranch : validateDestinationBranch(data.destinationBranch),
			destinationRemote: data.destinationRemote === undefined ? rule.destinationRemote : validateDestinationRemote(data.destinationRemote),
			retention: data.retention === undefined ? rule.retention : validateRetention(data.retention),
			updatedAt: new Date().toISOString(),
		});
		await writeStore(root, store);
		return { updated: true, rule };
	});
}

export async function deleteProjectAssetLockRule(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await requireRuleAdministrator(scene, data, options);
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const index = store.rules.findIndex((rule) => rule.id === data.id);
		if (index === -1) {
			throw new Error(`Smart Lock rule was not found: ${data.id}`);
		}
		const [rule] = store.rules.splice(index, 1);
		await writeStore(root, store);
		return { deleted: true, rule };
	});
}

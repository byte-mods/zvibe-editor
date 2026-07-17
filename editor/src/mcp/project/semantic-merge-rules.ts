import { randomUUID } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

const storeVersion = 1;
const maximumRules = 100;
const maximumCustomValueBytes = 64 * 1024;
const operationGuardStaleMilliseconds = 10000;

export type SemanticMergeRuleChoice = "ours" | "theirs" | "base" | "delete" | "custom";
export type SemanticMergeRuleAssetKind = "any" | "scene" | "prefab";

export interface ISemanticMergeRule {
	id: string;
	name: string;
	enabled: boolean;
	assetKind: SemanticMergeRuleAssetKind;
	filePattern: string;
	pathPrefix: string;
	choice: SemanticMergeRuleChoice;
	customValue?: unknown;
	createdAt: string;
	updatedAt: string;
}

interface ISemanticMergeRuleStore {
	version: 1;
	rules: ISemanticMergeRule[];
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
	return join(storeDirectory(root), "merge-rules.json");
}

function validateName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128 || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new Error("name must be a non-empty string of at most 128 characters without line breaks or null bytes.");
	}
	return value.trim();
}

function validateAssetKind(value: unknown): SemanticMergeRuleAssetKind {
	const assetKind = value ?? "any";
	if (!(["any", "scene", "prefab"] as unknown[]).includes(assetKind)) {
		throw new Error("assetKind must be any, scene, or prefab.");
	}
	return assetKind as SemanticMergeRuleAssetKind;
}

function validateFilePattern(value: unknown): string {
	const pattern = value ?? "*";
	if (typeof pattern !== "string" || !pattern || pattern.length > 256 || pattern.includes("\0") || pattern.startsWith("/") || pattern.split("/").includes("..")) {
		throw new Error("filePattern must be a non-empty project-manifest pattern of at most 256 characters without traversal, an absolute prefix, or null bytes.");
	}
	return pattern.replace(/\\/g, "/").replace(/\*+/g, "*");
}

function validatePathPrefix(value: unknown): string {
	const prefix = value ?? "/";
	if (typeof prefix !== "string" || !prefix.startsWith("/") || prefix.length > 512 || prefix.includes("\0")) {
		throw new Error("pathPrefix must begin with / and contain at most 512 characters without null bytes.");
	}
	return prefix.length > 1 ? prefix.replace(/\/$/, "") : prefix;
}

function validateChoice(value: unknown): SemanticMergeRuleChoice {
	if (!(["ours", "theirs", "base", "delete", "custom"] as unknown[]).includes(value)) {
		throw new Error("choice must be ours, theirs, base, delete, or custom.");
	}
	return value as SemanticMergeRuleChoice;
}

export function validateSemanticMergeCustomValue(choice: SemanticMergeRuleChoice, value: unknown): unknown {
	if (choice !== "custom") {
		return undefined;
	}
	if (value === undefined) {
		throw new Error("customValue is required when choice is custom.");
	}
	let source: string;
	try {
		source = JSON.stringify(value);
	} catch {
		throw new Error("customValue must be JSON-serializable.");
	}
	if (source === undefined || Buffer.byteLength(source) > maximumCustomValueBytes) {
		throw new Error(`customValue must serialize to at most ${maximumCustomValueBytes} bytes of JSON.`);
	}
	return JSON.parse(source);
}

function isRule(value: any): value is ISemanticMergeRule {
	try {
		if (
			typeof value?.id !== "string" ||
			!/^[0-9a-f-]{36}$/i.test(value.id) ||
			typeof value.enabled !== "boolean" ||
			!Number.isFinite(Date.parse(value.createdAt)) ||
			!Number.isFinite(Date.parse(value.updatedAt))
		) {
			return false;
		}
		validateName(value.name);
		validateAssetKind(value.assetKind);
		validateFilePattern(value.filePattern);
		validatePathPrefix(value.pathPrefix);
		const choice = validateChoice(value.choice);
		validateSemanticMergeCustomValue(choice, value.customValue);
		return true;
	} catch {
		return false;
	}
}

async function readStore(root: string): Promise<ISemanticMergeRuleStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (value?.version !== storeVersion || !Array.isArray(value.rules) || value.rules.length > maximumRules || !value.rules.every(isRule)) {
			throw new Error("The semantic merge-rule store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return { version: storeVersion, rules: [] };
		}
		if (error instanceof SyntaxError) {
			throw new Error("The semantic merge-rule store contains invalid JSON. Repair .babylon-editor/merge-rules.json before continuing.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: ISemanticMergeRuleStore): Promise<void> {
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

async function withStoreGuard<T>(root: string, action: (store: ISemanticMergeRuleStore) => Promise<T>): Promise<T> {
	const directory = storeDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".merge-rules.operation");
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
		throw new Error("The semantic merge-rule store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

export async function readProjectSemanticMergeRules(options: IMCPActionOptions, ids?: string[]): Promise<ISemanticMergeRule[]> {
	const rules = (await readStore(projectDirectory(options))).rules;
	if (!ids) {
		return rules;
	}
	const byId = new Map(rules.map((rule) => [rule.id, rule]));
	return ids.map((id) => {
		const rule = byId.get(id);
		if (!rule) {
			throw new Error(`Semantic merge rule was not found: ${id}`);
		}
		return rule;
	});
}

export function semanticMergeRuleMatches(rule: ISemanticMergeRule, kind: "scene" | "prefab", file: string, path: string): boolean {
	if (!rule.enabled || (rule.assetKind !== "any" && rule.assetKind !== kind)) {
		return false;
	}
	const escaped = rule.filePattern
		.replace(/\*+/g, "*")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	const fileMatches = new RegExp(`^${escaped}$`).test(file);
	return fileMatches && (rule.pathPrefix === "/" || path === rule.pathPrefix || path.startsWith(`${rule.pathPrefix}/`));
}

export async function listProjectSemanticMergeRules(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const rules = await readProjectSemanticMergeRules(options);
	const assetKind = data.assetKind === undefined ? null : validateAssetKind(data.assetKind);
	return { rules: assetKind ? rules.filter((rule) => rule.assetKind === "any" || rule.assetKind === assetKind) : rules, total: rules.length };
}

export async function createProjectSemanticMergeRule(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		if (store.rules.length >= maximumRules) {
			throw new Error(`A project can contain at most ${maximumRules} semantic merge rules.`);
		}
		const name = validateName(data.name);
		if (store.rules.some((rule) => rule.name.toLowerCase() === name.toLowerCase())) {
			throw new Error(`A semantic merge rule named "${name}" already exists.`);
		}
		const choice = validateChoice(data.choice);
		const timestamp = new Date().toISOString();
		const rule: ISemanticMergeRule = {
			id: randomUUID(),
			name,
			enabled: data.enabled ?? true,
			assetKind: validateAssetKind(data.assetKind),
			filePattern: validateFilePattern(data.filePattern),
			pathPrefix: validatePathPrefix(data.pathPrefix),
			choice,
			...(choice === "custom" ? { customValue: validateSemanticMergeCustomValue(choice, data.customValue) } : {}),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.rules.push(rule);
		await writeStore(root, store);
		return { rule };
	});
}

export async function setProjectSemanticMergeRule(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const rule = store.rules.find((candidate) => candidate.id === data.id);
		if (!rule) {
			throw new Error(`Semantic merge rule was not found: ${data.id}`);
		}
		const name = data.name === undefined ? rule.name : validateName(data.name);
		if (store.rules.some((candidate) => candidate.id !== rule.id && candidate.name.toLowerCase() === name.toLowerCase())) {
			throw new Error(`A semantic merge rule named "${name}" already exists.`);
		}
		const choice = data.choice === undefined ? rule.choice : validateChoice(data.choice);
		const customValue = choice === "custom" ? validateSemanticMergeCustomValue(choice, data.customValue === undefined ? rule.customValue : data.customValue) : undefined;
		Object.assign(rule, {
			name,
			enabled: data.enabled ?? rule.enabled,
			assetKind: data.assetKind === undefined ? rule.assetKind : validateAssetKind(data.assetKind),
			filePattern: data.filePattern === undefined ? rule.filePattern : validateFilePattern(data.filePattern),
			pathPrefix: data.pathPrefix === undefined ? rule.pathPrefix : validatePathPrefix(data.pathPrefix),
			choice,
			updatedAt: new Date().toISOString(),
		});
		if (choice === "custom") {
			rule.customValue = customValue;
		} else {
			delete rule.customValue;
		}
		await writeStore(root, store);
		return { rule };
	});
}

export async function deleteProjectSemanticMergeRule(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const index = store.rules.findIndex((rule) => rule.id === data.id);
		if (index === -1) {
			throw new Error(`Semantic merge rule was not found: ${data.id}`);
		}
		const [rule] = store.rules.splice(index, 1);
		await writeStore(root, store);
		return { deleted: true, rule };
	});
}

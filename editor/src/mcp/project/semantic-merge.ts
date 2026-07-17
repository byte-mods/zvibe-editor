import { createHash, randomUUID } from "crypto";
import { access, cp, mkdir, open, realpath, rename, rm, stat, unlink, writeFile } from "fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import {
	getSemanticProjectDirectory,
	isSemanticPathIgnored,
	ISemanticAsset,
	loadSemanticAsset,
	semanticPathSegment,
	semanticValueSummary,
	stableSemanticArrayIdentity,
	validateIgnorePaths,
	validateNumericTolerance,
} from "./semantic-diff";
import { ISemanticMergeRule, readProjectSemanticMergeRules, semanticMergeRuleMatches, SemanticMergeRuleChoice, validateSemanticMergeCustomValue } from "./semantic-merge-rules";

const missing = Symbol("missing-semantic-value");
const maximumVisitedValues = 2_000_000;
const defaultMaximumConflicts = 500;
const maximumConflictsLimit = 5000;
const operationGuardStaleMilliseconds = 30 * 60 * 1000;

type MergeValue = unknown | typeof missing;
type ConflictResolution = "manual" | "ours" | "theirs";

interface ISemanticMergeOverride {
	file: string;
	path: string;
	choice: SemanticMergeRuleChoice;
	customValue?: unknown;
}

interface ISemanticMergeConflict {
	file: string;
	path: string;
	identity: string | null;
	base: ReturnType<typeof semanticValueSummary> | null;
	ours: ReturnType<typeof semanticValueSummary> | null;
	theirs: ReturnType<typeof semanticValueSummary> | null;
	resolution: ConflictResolution | SemanticMergeRuleChoice;
	resolutionSource: "unresolved" | "global" | "override" | "rule";
	resolved: boolean;
	ruleId: string | null;
}

interface IMergeContext {
	file: string;
	resolution: ConflictResolution;
	kind: "scene" | "prefab";
	overrides: Map<string, ISemanticMergeOverride>;
	rules: ISemanticMergeRule[];
	numericTolerance: number;
	ignorePaths: string[];
	maximumConflicts: number;
	conflicts: ISemanticMergeConflict[];
	totalConflicts: number;
	resolvedConflicts: number;
	unresolvedConflicts: number;
	appliedRuleIds: Set<string>;
	automaticMerges: number;
	visitedValues: number;
}

function validateMaximumConflicts(value: unknown): number {
	const maximumConflicts = value ?? defaultMaximumConflicts;
	if (!Number.isInteger(maximumConflicts) || (maximumConflicts as number) < 1 || (maximumConflicts as number) > maximumConflictsLimit) {
		throw new Error(`maximumConflicts must be an integer from 1 through ${maximumConflictsLimit}.`);
	}
	return maximumConflicts as number;
}

function validateResolution(value: unknown): ConflictResolution {
	const resolution = value ?? "manual";
	if (!(["manual", "ours", "theirs"] as unknown[]).includes(resolution)) {
		throw new Error("resolution must be manual, ours, or theirs.");
	}
	return resolution as ConflictResolution;
}

function validateConflictChoice(value: unknown): SemanticMergeRuleChoice {
	if (!(["ours", "theirs", "base", "delete", "custom"] as unknown[]).includes(value)) {
		throw new Error("Conflict override choice must be ours, theirs, base, delete, or custom.");
	}
	return value as SemanticMergeRuleChoice;
}

function conflictKey(file: string, path: string): string {
	return `${file}\0${path}`;
}

function validateConflictOverrides(value: unknown): Map<string, ISemanticMergeOverride> {
	if (value === undefined) {
		return new Map();
	}
	if (!Array.isArray(value) || value.length > 500) {
		throw new Error("conflictResolutions must contain at most 500 exact conflict overrides.");
	}
	const result = new Map<string, ISemanticMergeOverride>();
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error("Each conflict resolution must be an object.");
		}
		const file = (candidate as any).file;
		const path = (candidate as any).path;
		if (typeof file !== "string" || !file || file.length > 512 || file.includes("\0") || file.startsWith("/") || file.split("/").includes("..")) {
			throw new Error("Conflict resolution file must be a relative manifest path of at most 512 characters without traversal or null bytes.");
		}
		if (typeof path !== "string" || !path.startsWith("/") || path.length > 512 || path.includes("\0")) {
			throw new Error("Conflict resolution path must begin with / and contain at most 512 characters without null bytes.");
		}
		const choice = validateConflictChoice((candidate as any).choice);
		const override: ISemanticMergeOverride = {
			file: file.replace(/\\/g, "/"),
			path,
			choice,
			...(choice === "custom" ? { customValue: validateSemanticMergeCustomValue(choice, (candidate as any).customValue) } : {}),
		};
		const key = conflictKey(override.file, path);
		if (result.has(key)) {
			throw new Error(`Duplicate conflict resolution for ${override.file}${path}.`);
		}
		result.set(key, override);
	}
	return result;
}

function validateRuleIds(value: unknown): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
		throw new Error("ruleIds must contain at most 100 semantic merge-rule UUIDs.");
	}
	return [...new Set(value)];
}

function isRecord(value: MergeValue): value is Record<string, unknown> {
	return value !== missing && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArray(value: MergeValue): value is unknown[] {
	return value !== missing && Array.isArray(value);
}

function summary(value: MergeValue): ReturnType<typeof semanticValueSummary> | null {
	return value === missing ? null : semanticValueSummary(value);
}

function semanticEqual(first: MergeValue, second: MergeValue, tolerance: number, visited: { count: number }): boolean {
	visited.count++;
	if (visited.count > maximumVisitedValues) {
		throw new Error(`Semantic merge exceeded the ${maximumVisitedValues}-value safety limit.`);
	}
	if (first === missing || second === missing) {
		return first === second;
	}
	if (typeof first === "number" && typeof second === "number") {
		return Math.abs(first - second) <= tolerance;
	}
	if (Object.is(first, second)) {
		return true;
	}
	if (isArray(first) && isArray(second)) {
		const identityKey = stableSemanticArrayIdentity(first, second);
		if (identityKey) {
			if (first.length !== second.length) {
				return false;
			}
			const secondMap = new Map(second.map((value) => [String((value as Record<string, unknown>)[identityKey]), value]));
			return first.every((value) => {
				const identity = String((value as Record<string, unknown>)[identityKey]);
				return secondMap.has(identity) && semanticEqual(value, secondMap.get(identity), tolerance, visited);
			});
		}
		return first.length === second.length && first.every((value, index) => semanticEqual(value, second[index], tolerance, visited));
	}
	if (isRecord(first) && isRecord(second)) {
		const firstKeys = Object.keys(first).sort();
		const secondKeys = Object.keys(second).sort();
		return firstKeys.length === secondKeys.length && firstKeys.every((key, index) => key === secondKeys[index] && semanticEqual(first[key], second[key], tolerance, visited));
	}
	return false;
}

function valuesEqual(first: MergeValue, second: MergeValue, context: IMergeContext): boolean {
	return semanticEqual(first, second, context.numericTolerance, { count: 0 });
}

function selectConflictValue(choice: SemanticMergeRuleChoice, customValue: unknown, base: MergeValue, ours: MergeValue, theirs: MergeValue): MergeValue {
	switch (choice) {
		case "ours":
			return ours;
		case "theirs":
			return theirs;
		case "base":
			return base;
		case "delete":
			return missing;
		case "custom":
			return customValue;
	}
}

function addConflict(path: string, base: MergeValue, ours: MergeValue, theirs: MergeValue, identity: string | null, context: IMergeContext): MergeValue {
	context.totalConflicts++;
	const normalizedPath = path || "/";
	const override = context.overrides.get(conflictKey(context.file, normalizedPath));
	const rule = override ? null : context.rules.find((candidate) => semanticMergeRuleMatches(candidate, context.kind, context.file, normalizedPath));
	const choice = override?.choice ?? rule?.choice ?? (context.resolution === "manual" ? null : context.resolution);
	const resolutionSource = override ? "override" : rule ? "rule" : choice ? "global" : "unresolved";
	const resolved = choice !== null;
	if (resolved) {
		context.resolvedConflicts++;
	} else {
		context.unresolvedConflicts++;
	}
	if (rule) {
		context.appliedRuleIds.add(rule.id);
	}
	if (context.conflicts.length < context.maximumConflicts) {
		context.conflicts.push({
			file: context.file,
			path: normalizedPath,
			identity,
			base: summary(base),
			ours: summary(ours),
			theirs: summary(theirs),
			resolution: choice ?? "manual",
			resolutionSource,
			resolved,
			ruleId: rule?.id ?? null,
		});
	}
	return choice ? selectConflictValue(choice, override?.customValue ?? rule?.customValue, base, ours, theirs) : ours;
}

function mergeValue(path: string, base: MergeValue, ours: MergeValue, theirs: MergeValue, context: IMergeContext, identity: string | null = null): MergeValue {
	context.visitedValues++;
	if (context.visitedValues > maximumVisitedValues) {
		throw new Error(`Semantic merge exceeded the ${maximumVisitedValues}-value safety limit.`);
	}
	if (isSemanticPathIgnored(path, context.ignorePaths)) {
		return ours;
	}
	if (valuesEqual(ours, theirs, context)) {
		return ours;
	}
	if (valuesEqual(base, ours, context)) {
		context.automaticMerges++;
		return theirs;
	}
	if (valuesEqual(base, theirs, context)) {
		context.automaticMerges++;
		return ours;
	}
	if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
		const result: Record<string, unknown> = {};
		for (const key of [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort()) {
			const merged = mergeValue(
				`${path}/${semanticPathSegment(key)}`,
				key in base ? base[key] : missing,
				key in ours ? ours[key] : missing,
				key in theirs ? theirs[key] : missing,
				context,
				identity
			);
			if (merged !== missing) {
				result[key] = merged;
			}
		}
		return result;
	}
	if (isArray(base) && isArray(ours) && isArray(theirs)) {
		const identityKey = stableSemanticArrayIdentity(base, ours, theirs);
		if (identityKey) {
			const maps = [base, ours, theirs].map((array) => new Map(array.map((value) => [String((value as Record<string, unknown>)[identityKey]), value])));
			const order = [...new Set([...ours, ...theirs, ...base].map((value) => String((value as Record<string, unknown>)[identityKey])))];
			const result: unknown[] = [];
			for (const itemIdentity of order) {
				const merged = mergeValue(
					`${path}/@${identityKey}=${semanticPathSegment(itemIdentity)}`,
					maps[0].get(itemIdentity) ?? missing,
					maps[1].get(itemIdentity) ?? missing,
					maps[2].get(itemIdentity) ?? missing,
					context,
					`${identityKey}=${itemIdentity}`
				);
				if (merged !== missing) {
					result.push(merged);
				}
			}
			return result;
		}
	}
	return addConflict(path, base, ours, theirs, identity, context);
}

function mergedAssetHash(files: Map<string, unknown>): string {
	const hash = createHash("sha256");
	for (const [path, value] of [...files.entries()].sort(([first], [second]) => first.localeCompare(second))) {
		hash.update(path);
		hash.update("\0");
		hash.update(`${JSON.stringify(value, null, "\t")}\n`);
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function resolveSemanticOutput(root: string, value: unknown, kind: ISemanticAsset["kind"], sourcePaths: string[]): Promise<{ absolute: string; path: string }> {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error("outputPath must be a non-empty project-relative path when write is true.");
	}
	const slashPath = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const path = normalize(slashPath);
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path === ".babylon-editor" || path.startsWith(".babylon-editor/")) {
		throw new Error("outputPath must stay inside the active project and outside editor metadata.");
	}
	if (extname(path).toLowerCase() !== (kind === "scene" ? ".scene" : ".prefab")) {
		throw new Error(`outputPath must end in ${kind === "scene" ? ".scene" : ".prefab"}.`);
	}
	if (sourcePaths.includes(path)) {
		throw new Error("Semantic merge output must be a new asset and cannot overwrite base, ours, or theirs.");
	}
	const absolute = resolve(root, path);
	const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(absolute)).catch(() => null)]);
	if (!realParent) {
		throw new Error("The output parent directory must already exist.");
	}
	if (realParent !== realRoot && !realParent.startsWith(`${realRoot}/`)) {
		throw new Error("outputPath must resolve inside the active project.");
	}
	try {
		await access(absolute);
		throw new Error(`Semantic merge output already exists: ${path}`);
	} catch (error: any) {
		if (error.message?.startsWith("Semantic merge output already exists")) {
			throw error;
		}
	}
	return { absolute, path: relative(root, absolute).replace(/\\/g, "/") };
}

async function writeMergedAsset(ours: ISemanticAsset, output: { absolute: string; path: string }, files: Map<string, unknown>): Promise<void> {
	const temporary = join(dirname(output.absolute), `.${basename(output.absolute)}.${randomUUID()}.merge`);
	try {
		if (ours.kind === "prefab") {
			await writeFile(temporary, `${JSON.stringify(files.get("prefab.json"), null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
		} else {
			await cp(ours.absolute, temporary, { recursive: true, errorOnExist: true, force: false });
			for (const path of ours.files.keys()) {
				if (!files.has(path)) {
					await rm(join(temporary, path), { force: true });
				}
			}
			for (const [path, value] of files) {
				const destination = join(temporary, path);
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
			}
		}
		await rename(temporary, output.absolute);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

async function withSemanticMergeGuard<T>(root: string, action: () => Promise<T>): Promise<T> {
	const directory = join(root, ".babylon-editor");
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".semantic-merge.operation");
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
		throw new Error("Another semantic merge write is active. Retry the operation.");
	}
	try {
		return await action();
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

/** Performs a bounded three-way semantic merge and optionally writes a new scene/prefab asset. */
export async function mergeProjectSceneAssets(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = getSemanticProjectDirectory(options);
	const numericTolerance = validateNumericTolerance(data.numericTolerance);
	const ignorePaths = validateIgnorePaths(data.ignorePaths);
	const maximumConflicts = validateMaximumConflicts(data.maximumConflicts);
	const resolution = validateResolution(data.resolution);
	const overrides = validateConflictOverrides(data.conflictResolutions);
	const ruleIds = validateRuleIds(data.ruleIds);
	const write = data.write === true;
	const [base, ours, theirs] = await Promise.all([loadSemanticAsset(root, data.basePath), loadSemanticAsset(root, data.oursPath), loadSemanticAsset(root, data.theirsPath)]);
	if (base.kind !== ours.kind || base.kind !== theirs.kind) {
		throw new Error("Semantic merge requires three scene directories or three prefab files of the same kind.");
	}
	if (data.expectedBaseHash && data.expectedBaseHash !== base.hash) {
		throw new Error("Base asset changed after it was inspected; refresh the merge preview.");
	}
	if (data.expectedOursHash && data.expectedOursHash !== ours.hash) {
		throw new Error("Ours asset changed after it was inspected; refresh the merge preview.");
	}
	if (data.expectedTheirsHash && data.expectedTheirsHash !== theirs.hash) {
		throw new Error("Theirs asset changed after it was inspected; refresh the merge preview.");
	}
	const rules = await readProjectSemanticMergeRules(options, ruleIds);

	const conflicts: ISemanticMergeConflict[] = [];
	const mergedFiles = new Map<string, unknown>();
	const context: IMergeContext = {
		file: "",
		resolution,
		kind: base.kind,
		overrides,
		rules,
		numericTolerance,
		ignorePaths,
		maximumConflicts,
		conflicts,
		totalConflicts: 0,
		resolvedConflicts: 0,
		unresolvedConflicts: 0,
		appliedRuleIds: new Set(),
		automaticMerges: 0,
		visitedValues: 0,
	};
	const filePaths = [...new Set([...base.files.keys(), ...ours.files.keys(), ...theirs.files.keys()])].sort();
	for (const file of filePaths) {
		context.file = file;
		const merged = mergeValue(
			"",
			base.files.has(file) ? base.files.get(file)!.value : missing,
			ours.files.has(file) ? ours.files.get(file)!.value : missing,
			theirs.files.has(file) ? theirs.files.get(file)!.value : missing,
			context
		);
		if (merged !== missing) {
			mergedFiles.set(file, merged);
		}
	}

	if (write && context.unresolvedConflicts > 0) {
		throw new Error(
			`Merge has ${context.unresolvedConflicts} unresolved conflicts. Preview them, then provide exact conflictResolutions, selected ruleIds, or a global resolution before writing.`
		);
	}
	const output = write
		? await withSemanticMergeGuard(root, async () => {
				const resolved = await resolveSemanticOutput(root, data.outputPath, ours.kind, [base.path, ours.path, theirs.path]);
				await writeMergedAsset(ours, resolved, mergedFiles);
				return resolved;
			})
		: null;
	return {
		kind: base.kind,
		written: Boolean(output),
		base: { path: base.path, hash: base.hash },
		ours: { path: ours.path, hash: ours.hash },
		theirs: { path: theirs.path, hash: theirs.hash },
		output: output ? { path: output.path, hash: mergedAssetHash(mergedFiles) } : { path: null, hash: mergedAssetHash(mergedFiles) },
		summary: {
			automaticMerges: context.automaticMerges,
			totalConflicts: context.totalConflicts,
			resolvedConflicts: context.resolvedConflicts,
			unresolvedConflicts: context.unresolvedConflicts,
			returnedConflicts: conflicts.length,
			truncated: context.totalConflicts > conflicts.length,
			fileCount: mergedFiles.size,
		},
		options: { resolution, numericTolerance, ignorePaths, maximumConflicts, conflictResolutionCount: overrides.size, ruleIds, appliedRuleIds: [...context.appliedRuleIds] },
		conflicts,
	};
}

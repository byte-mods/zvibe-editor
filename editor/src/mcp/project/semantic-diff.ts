import { createHash } from "crypto";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

const maximumAssetFiles = 4096;
const maximumFileBytes = 16 * 1024 * 1024;
const maximumAssetBytes = 64 * 1024 * 1024;
const maximumVisitedValues = 2_000_000;
const defaultMaximumChanges = 500;
const maximumChangesLimit = 5000;
const stableArrayKeys = ["uniqueId", "id", "key", "name", "frame"] as const;

export type SemanticAssetKind = "scene" | "prefab";
type SemanticChangeKind = "added" | "removed" | "changed" | "typeChanged";

export interface ISemanticAssetFile {
	path: string;
	bytes: number;
	source: string;
	value: unknown;
}

export interface ISemanticAsset {
	kind: SemanticAssetKind;
	path: string;
	absolute: string;
	files: Map<string, ISemanticAssetFile>;
	bytes: number;
	hash: string;
}

export interface ISemanticAssetChange {
	file: string;
	path: string;
	kind: SemanticChangeKind;
	identity: string | null;
	before: { type: string; preview: string } | null;
	after: { type: string; preview: string } | null;
}

export function getSemanticProjectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

export function validateMaximumChanges(value: unknown): number {
	const maximumChanges = value ?? defaultMaximumChanges;
	if (!Number.isInteger(maximumChanges) || (maximumChanges as number) < 1 || (maximumChanges as number) > maximumChangesLimit) {
		throw new Error(`maximumChanges must be an integer from 1 through ${maximumChangesLimit}.`);
	}
	return maximumChanges as number;
}

export function validateNumericTolerance(value: unknown): number {
	const tolerance = value ?? 0;
	if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
		throw new Error("numericTolerance must be a finite number from 0 through 1.");
	}
	return tolerance;
}

export function validateIgnorePaths(value: unknown): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 64 || value.some((path) => typeof path !== "string" || !path.startsWith("/") || path.length > 512)) {
		throw new Error("ignorePaths must contain at most 64 semantic path prefixes beginning with / and containing at most 512 characters each.");
	}
	return [...new Set(value)];
}

export async function resolveSemanticAsset(root: string, value: unknown): Promise<{ absolute: string; path: string; kind: SemanticAssetKind }> {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error("Scene/prefab paths must be non-empty project-relative paths.");
	}
	const slashPath = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	const path = normalize(slashPath);
	if (path === "." || path.startsWith("/") || path.split("/").includes("..")) {
		throw new Error("Scene/prefab paths must stay inside the active project.");
	}
	const absolute = resolve(root, path);
	let realRoot: string;
	let realAsset: string;
	let assetStat: Awaited<ReturnType<typeof stat>>;
	try {
		[realRoot, realAsset, assetStat] = await Promise.all([realpath(root), realpath(absolute), stat(absolute)]);
	} catch {
		throw new Error(`Scene/prefab asset was not found: ${path}`);
	}
	if (realAsset !== realRoot && !realAsset.startsWith(`${realRoot}/`)) {
		throw new Error("Scene/prefab paths must resolve inside the active project.");
	}
	const extension = extname(path).toLowerCase();
	if (extension === ".scene" && assetStat.isDirectory()) {
		return { absolute, path: relative(root, absolute).replace(/\\/g, "/"), kind: "scene" };
	}
	if (extension === ".prefab" && assetStat.isFile()) {
		return { absolute, path: relative(root, absolute).replace(/\\/g, "/"), kind: "prefab" };
	}
	throw new Error("Semantic comparison requires a .scene directory or .prefab JSON file.");
}

async function collectSceneJsonFiles(directory: string, current = directory, result: string[] = []): Promise<string[]> {
	const entries = await readdir(current, { withFileTypes: true });
	for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
		if (entry.name.startsWith(".")) {
			continue;
		}
		const path = join(current, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`Scene directories cannot contain symbolic links: ${relative(directory, path)}`);
		}
		if (entry.isDirectory()) {
			await collectSceneJsonFiles(directory, path, result);
		} else if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") {
			result.push(path);
			if (result.length > maximumAssetFiles) {
				throw new Error(`Scene comparison supports at most ${maximumAssetFiles} JSON files per asset.`);
			}
		}
	}
	return result;
}

async function readSemanticJsonFile(absolute: string, path: string): Promise<ISemanticAssetFile> {
	const details = await stat(absolute);
	if (details.size > maximumFileBytes) {
		throw new Error(`Semantic comparison JSON file exceeds ${maximumFileBytes} bytes: ${path}`);
	}
	const source = await readFile(absolute, "utf-8");
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error: any) {
		throw new Error(`Invalid JSON in ${path}: ${error.message}`);
	}
	return { path, bytes: Buffer.byteLength(source), source, value };
}

export async function loadSemanticAsset(root: string, value: unknown): Promise<ISemanticAsset> {
	const resolved = await resolveSemanticAsset(root, value);
	const absoluteFiles = resolved.kind === "prefab" ? [resolved.absolute] : await collectSceneJsonFiles(resolved.absolute);
	const files = new Map<string, ISemanticAssetFile>();
	let bytes = 0;
	for (const absoluteFile of absoluteFiles) {
		const filePath = resolved.kind === "prefab" ? "prefab.json" : relative(resolved.absolute, absoluteFile).replace(/\\/g, "/");
		const file = await readSemanticJsonFile(absoluteFile, filePath);
		files.set(filePath, file);
		bytes += file.bytes;
		if (bytes > maximumAssetBytes) {
			throw new Error(`Semantic comparison supports at most ${maximumAssetBytes} JSON bytes per asset.`);
		}
	}
	const hash = createHash("sha256");
	for (const file of [...files.values()].sort((first, second) => first.path.localeCompare(second.path))) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.source);
		hash.update("\0");
	}
	return { kind: resolved.kind, path: resolved.path, absolute: resolved.absolute, files, bytes, hash: hash.digest("hex") };
}

export function semanticValueType(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

function valuePreview(value: unknown): string {
	if (typeof value === "string") {
		return value.length > 256 ? `${value.slice(0, 253)}...` : value;
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.length} items]`;
	}
	const keys = Object.keys(value as Record<string, unknown>);
	return `{${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}}`;
}

export function semanticValueSummary(value: unknown): { type: string; preview: string } {
	return { type: semanticValueType(value), preview: valuePreview(value) };
}

export function semanticPathSegment(value: string | number): string {
	return encodeURIComponent(String(value)).replace(/%2F/gi, "%252F");
}

export function stableSemanticArrayIdentity(...arrays: unknown[][]): (typeof stableArrayKeys)[number] | null {
	const values = arrays.flat();
	if (!values.length || values.some((value) => !value || typeof value !== "object" || Array.isArray(value))) {
		return null;
	}
	for (const key of stableArrayKeys) {
		const identitiesByArray = arrays.map((array) => array.map((value) => (value as Record<string, unknown>)[key]));
		if (
			identitiesByArray.flat().every((identity) => ["string", "number"].includes(typeof identity)) &&
			identitiesByArray.every((identities) => new Set(identities.map(String)).size === identities.length)
		) {
			return key;
		}
	}
	return null;
}

export function isSemanticPathIgnored(path: string, ignorePaths: string[]): boolean {
	return ignorePaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Compares two persisted scene directories or two prefab JSON assets without changing project files. */
export async function compareProjectSceneAssets(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = getSemanticProjectDirectory(options);
	const maximumChanges = validateMaximumChanges(data.maximumChanges);
	const numericTolerance = validateNumericTolerance(data.numericTolerance);
	const ignorePaths = validateIgnorePaths(data.ignorePaths);
	const [source, target] = await Promise.all([loadSemanticAsset(root, data.sourcePath), loadSemanticAsset(root, data.targetPath)]);
	if (source.kind !== target.kind) {
		throw new Error("Semantic comparison requires two scene directories or two prefab files of the same kind.");
	}

	const changes: ISemanticAssetChange[] = [];
	const counts: Record<SemanticChangeKind, number> = { added: 0, removed: 0, changed: 0, typeChanged: 0 };
	const filesChanged = new Set<string>();
	let totalChanges = 0;
	let visitedValues = 0;
	const addChange = (file: string, path: string, kind: SemanticChangeKind, before: unknown, after: unknown, identity: string | null = null): void => {
		if (isSemanticPathIgnored(path, ignorePaths)) {
			return;
		}
		totalChanges++;
		counts[kind]++;
		filesChanged.add(file);
		if (changes.length < maximumChanges) {
			changes.push({
				file,
				path,
				kind,
				identity,
				before: kind === "added" ? null : semanticValueSummary(before),
				after: kind === "removed" ? null : semanticValueSummary(after),
			});
		}
	};
	const compareValue = (file: string, path: string, before: unknown, after: unknown, identity: string | null = null): void => {
		visitedValues++;
		if (visitedValues > maximumVisitedValues) {
			throw new Error(`Semantic comparison exceeded the ${maximumVisitedValues}-value safety limit.`);
		}
		if (isSemanticPathIgnored(path, ignorePaths)) {
			return;
		}
		const beforeType = semanticValueType(before);
		const afterType = semanticValueType(after);
		if (beforeType !== afterType) {
			addChange(file, path, "typeChanged", before, after, identity);
			return;
		}
		if (typeof before === "number" && typeof after === "number") {
			if (Math.abs(before - after) > numericTolerance) {
				addChange(file, path, "changed", before, after, identity);
			}
			return;
		}
		if (before === null || after === null || typeof before !== "object" || typeof after !== "object") {
			if (!Object.is(before, after)) {
				addChange(file, path, "changed", before, after, identity);
			}
			return;
		}
		if (Array.isArray(before) && Array.isArray(after)) {
			const identityKey = stableSemanticArrayIdentity(before, after);
			if (identityKey) {
				const beforeMap = new Map(before.map((value) => [String((value as Record<string, unknown>)[identityKey]), value]));
				const afterMap = new Map(after.map((value) => [String((value as Record<string, unknown>)[identityKey]), value]));
				const identities = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
				for (const itemIdentity of identities) {
					const itemPath = `${path}/@${identityKey}=${semanticPathSegment(itemIdentity)}`;
					const beforeItem = beforeMap.get(itemIdentity);
					const afterItem = afterMap.get(itemIdentity);
					if (beforeItem === undefined) {
						addChange(file, itemPath, "added", undefined, afterItem, `${identityKey}=${itemIdentity}`);
					} else if (afterItem === undefined) {
						addChange(file, itemPath, "removed", beforeItem, undefined, `${identityKey}=${itemIdentity}`);
					} else {
						compareValue(file, itemPath, beforeItem, afterItem, `${identityKey}=${itemIdentity}`);
					}
				}
			} else {
				const length = Math.max(before.length, after.length);
				for (let index = 0; index < length; index++) {
					const itemPath = `${path}/${index}`;
					if (index >= before.length) {
						addChange(file, itemPath, "added", undefined, after[index]);
					} else if (index >= after.length) {
						addChange(file, itemPath, "removed", before[index], undefined);
					} else {
						compareValue(file, itemPath, before[index], after[index]);
					}
				}
			}
			return;
		}
		const beforeRecord = before as Record<string, unknown>;
		const afterRecord = after as Record<string, unknown>;
		for (const key of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()) {
			const propertyPath = `${path}/${semanticPathSegment(key)}`;
			if (!(key in beforeRecord)) {
				addChange(file, propertyPath, "added", undefined, afterRecord[key], identity);
			} else if (!(key in afterRecord)) {
				addChange(file, propertyPath, "removed", beforeRecord[key], undefined, identity);
			} else {
				compareValue(file, propertyPath, beforeRecord[key], afterRecord[key], identity);
			}
		}
	};

	const filePaths = [...new Set([...source.files.keys(), ...target.files.keys()])].sort();
	for (const file of filePaths) {
		const sourceFile = source.files.get(file);
		const targetFile = target.files.get(file);
		if (!sourceFile) {
			addChange(file, "/", "added", undefined, targetFile!.value);
		} else if (!targetFile) {
			addChange(file, "/", "removed", sourceFile.value, undefined);
		} else {
			compareValue(file, "", sourceFile.value, targetFile.value);
		}
	}

	return {
		kind: source.kind,
		equal: totalChanges === 0,
		source: { path: source.path, hash: source.hash, fileCount: source.files.size, bytes: source.bytes },
		target: { path: target.path, hash: target.hash, fileCount: target.files.size, bytes: target.bytes },
		summary: { totalChanges, returnedChanges: changes.length, truncated: totalChanges > changes.length, filesChanged: filesChanged.size, counts },
		options: { maximumChanges, numericTolerance, ignorePaths },
		changes,
	};
}

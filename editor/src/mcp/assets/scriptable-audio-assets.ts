import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "path/posix";

import { lstat, move, pathExists, readFile, realpath, remove, stat, writeFile } from "fs-extra";
import {
	getScriptableAudioDependencyPaths,
	IScriptableAudioGeneratorGraph,
	normalizeScriptableAudioGeneratorGraph,
	SCRIPTABLE_AUDIO_GRAPH_SUFFIX,
	serializeScriptableAudioRuntimeFingerprintInput,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths } from "./registry";

const maximumGraphBytes = 8 * 1024 * 1024;
const maximumDependencyHashBytes = 64 * 1024 * 1024;
const mutations = new Map<string, Promise<unknown>>();

export interface IScriptableAudioAssetDependency {
	path: string;
	status: "current" | "missing" | "deferred" | "error";
	sizeBytes: number | null;
	contentHash: string | null;
	message?: string;
}

export interface IScriptableAudioAssetSnapshot {
	path: string;
	absolutePath: string;
	graph: IScriptableAudioGeneratorGraph;
	revision: number;
	fingerprint: string;
	runtimeFingerprint: string | null;
	dependencies: IScriptableAudioAssetDependency[];
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function containedPath(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

/** Resolves one generator path without permitting metadata, build output, or traversal targets. */
export function resolveScriptableAudioAssetPath(path: unknown): { absolutePath: string; relativePath: string } {
	if (typeof path !== "string" || !path.trim() || path.length > 1024) {
		throw new Error("Audio Generator asset path must contain 1 through 1024 characters.");
	}
	if (path.includes("\\")) {
		throw new Error("Audio Generator asset paths must use forward slashes.");
	}
	if (path.includes("\0")) {
		throw new Error("Audio Generator asset paths cannot contain null bytes.");
	}
	const normalizedInput = path.trim();
	const root = projectDirectory();
	const absolutePath = normalize(isAbsolute(normalizedInput) ? normalizedInput : join(root, normalizedInput));
	if (!containedPath(root, absolutePath)) {
		throw new Error("Audio Generator assets must stay inside the open project directory.");
	}
	const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
	if (!relativePath.toLowerCase().endsWith(SCRIPTABLE_AUDIO_GRAPH_SUFFIX)) {
		throw new Error(`Audio Generator assets must end with "${SCRIPTABLE_AUDIO_GRAPH_SUFFIX}".`);
	}
	const segments = relativePath.split("/").map((segment) => segment.toLowerCase());
	if (
		segments.some((segment) => ["node_modules", ".git", ".bjseditor", "build", "declaration", "dist", "out", ".next"].includes(segment)) ||
		relativePath.startsWith("public/scene/") ||
		relativePath.endsWith(ASSET_META_SUFFIX)
	) {
		throw new Error("Audio Generator assets cannot be stored in metadata, dependency, cache, or generated-output directories.");
	}
	return { absolutePath, relativePath };
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path: string): Promise<string> {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

async function inspectDependencies(graph: IScriptableAudioGeneratorGraph): Promise<IScriptableAudioAssetDependency[]> {
	const root = projectDirectory();
	const rootRealPath = await realpath(root);
	const results: IScriptableAudioAssetDependency[] = [];
	for (const path of getScriptableAudioDependencyPaths(graph)) {
		const absolutePath = normalize(join(root, path));
		if (!containedPath(root, absolutePath) || !(await pathExists(absolutePath))) {
			results.push({ path, status: "missing", sizeBytes: null, contentHash: null, message: "Referenced AudioClip does not exist." });
			continue;
		}
		try {
			const dependencyRealPath = await realpath(absolutePath);
			const details = await stat(absolutePath);
			if (!containedPath(rootRealPath, dependencyRealPath) || !details.isFile()) {
				results.push({ path, status: "error", sizeBytes: details.size, contentHash: null, message: "Referenced AudioClip is not a contained regular file." });
			} else if (details.size > maximumDependencyHashBytes) {
				results.push({
					path,
					status: "deferred",
					sizeBytes: details.size,
					contentHash: null,
					message: "Referenced AudioClip exceeds the 64 MiB exact-fingerprint limit.",
				});
			} else {
				results.push({ path, status: "current", sizeBytes: details.size, contentHash: await hashFile(absolutePath) });
			}
		} catch (error) {
			results.push({ path, status: "error", sizeBytes: null, contentHash: null, message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
		}
	}
	return results;
}

function runtimeFingerprint(contentHash: string, dependencies: IScriptableAudioAssetDependency[]): string | null {
	if (dependencies.some((dependency) => dependency.status !== "current" || dependency.contentHash === null || dependency.sizeBytes === null)) {
		return null;
	}
	return createHash("sha256")
		.update(
			serializeScriptableAudioRuntimeFingerprintInput(
				contentHash,
				dependencies.map((dependency) => ({ path: dependency.path, contentHash: dependency.contentHash!, sizeBytes: dependency.sizeBytes! }))
			)
		)
		.digest("hex");
}

/** Reads, validates, fingerprints, and resolves all direct runtime dependencies from current disk bytes. */
export async function readScriptableAudioAsset(path: unknown): Promise<IScriptableAudioAssetSnapshot> {
	const resolved = resolveScriptableAudioAssetPath(path);
	if (!(await pathExists(resolved.absolutePath))) {
		throw new Error(`Audio Generator asset does not exist: ${resolved.relativePath}.`);
	}
	const rootRealPath = await realpath(projectDirectory());
	const assetRealPath = await realpath(resolved.absolutePath);
	const details = await stat(resolved.absolutePath);
	if (!containedPath(rootRealPath, assetRealPath) || !details.isFile()) {
		throw new Error("Audio Generator asset must be a contained regular file.");
	}
	if (details.size > maximumGraphBytes) {
		throw new Error("Audio Generator assets are limited to 8 MiB.");
	}
	const bytes = await readFile(resolved.absolutePath);
	let source: unknown;
	try {
		source = JSON.parse(bytes.toString("utf-8"));
	} catch (error) {
		throw new Error(`Audio Generator asset contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const graph = normalizeScriptableAudioGeneratorGraph(source);
	const fingerprint = hashBytes(bytes);
	const dependencies = await inspectDependencies(graph);
	return {
		path: resolved.relativePath,
		absolutePath: resolved.absolutePath,
		graph,
		revision: graph.revision,
		fingerprint,
		runtimeFingerprint: runtimeFingerprint(fingerprint, dependencies),
		dependencies,
	};
}

async function mutate<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = mutations.get(path) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	mutations.set(path, current);
	try {
		return await current;
	} finally {
		if (mutations.get(path) === current) {
			mutations.delete(path);
		}
	}
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
	if (!(await pathExists(dirname(path)))) {
		throw new Error("Audio Generator asset parent directory must already exist.");
	}
	const rootRealPath = await realpath(projectDirectory());
	const parentRealPath = await realpath(dirname(path));
	if (!containedPath(rootRealPath, parentRealPath)) {
		throw new Error("Audio Generator asset parent directory resolves outside the project.");
	}
	if (await pathExists(path)) {
		const details = await lstat(path);
		if (details.isSymbolicLink() || !details.isFile()) {
			throw new Error("Audio Generator asset destination must be a regular non-symlink file.");
		}
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, bytes);
	try {
		await move(temporary, path, { overwrite: true });
	} catch (error) {
		await remove(temporary);
		throw error;
	}
}

/** Atomically creates or exact-leased replaces a graph, advancing its persisted revision once. */
export async function writeScriptableAudioAsset(path: unknown, value: unknown, expectedFingerprint?: string): Promise<IScriptableAudioAssetSnapshot> {
	const resolved = resolveScriptableAudioAssetPath(path);
	return mutate(resolved.absolutePath, async () => {
		const exists = await pathExists(resolved.absolutePath);
		const current = exists ? await readScriptableAudioAsset(resolved.relativePath) : null;
		if (current) {
			if (typeof expectedFingerprint !== "string" || expectedFingerprint !== current.fingerprint) {
				throw new Error(`Audio Generator asset changed; inspect it again and use expectedFingerprint ${current.fingerprint}.`);
			}
		} else if (expectedFingerprint !== undefined) {
			throw new Error("A new Audio Generator asset must omit expectedFingerprint.");
		}
		const graph = normalizeScriptableAudioGeneratorGraph(value);
		const next = normalizeScriptableAudioGeneratorGraph({ ...graph, revision: current ? current.revision + 1 : 1 });
		const bytes = Buffer.from(`${JSON.stringify(next, null, "\t")}\n`, "utf-8");
		if (bytes.byteLength > maximumGraphBytes) {
			throw new Error("Audio Generator assets are limited to 8 MiB after serialization.");
		}
		const previousBytes = current ? await readFile(resolved.absolutePath) : null;
		await atomicWrite(resolved.absolutePath, bytes);
		try {
			await refreshAssetRegistryPaths([resolved.absolutePath]);
		} catch (error) {
			if (previousBytes) {
				await atomicWrite(resolved.absolutePath, previousBytes);
			} else {
				await remove(resolved.absolutePath);
				await remove(`${resolved.absolutePath}${ASSET_META_SUFFIX}`);
			}
			await refreshAssetRegistryPaths([resolved.absolutePath]).catch(() => undefined);
			throw error;
		}
		return readScriptableAudioAsset(resolved.relativePath);
	});
}

/** Exact-leased deletion with rollback when registry publication fails. */
export async function deleteScriptableAudioAsset(path: unknown, expectedFingerprint: unknown): Promise<{ path: string; revision: number; fingerprint: string; deleted: true }> {
	const resolved = resolveScriptableAudioAssetPath(path);
	return mutate(resolved.absolutePath, async () => {
		const current = await readScriptableAudioAsset(resolved.relativePath);
		if (typeof expectedFingerprint !== "string" || expectedFingerprint !== current.fingerprint) {
			throw new Error(`Audio Generator asset changed; inspect it again and use expectedFingerprint ${current.fingerprint}.`);
		}
		const metadataPath = `${resolved.absolutePath}${ASSET_META_SUFFIX}`;
		const temporaryPath = `${resolved.absolutePath}.${randomUUID()}.delete`;
		const temporaryMetadataPath = `${metadataPath}.${randomUUID()}.delete`;
		const hadMetadata = await pathExists(metadataPath);
		await move(resolved.absolutePath, temporaryPath);
		try {
			if (hadMetadata) {
				await move(metadataPath, temporaryMetadataPath);
			}
			await refreshAssetRegistryPaths([resolved.absolutePath]);
			await remove(temporaryPath);
			await remove(temporaryMetadataPath);
		} catch (error) {
			if (await pathExists(temporaryPath)) {
				await move(temporaryPath, resolved.absolutePath, { overwrite: true });
			}
			if (hadMetadata && (await pathExists(temporaryMetadataPath))) {
				await move(temporaryMetadataPath, metadataPath, { overwrite: true });
			}
			await refreshAssetRegistryPaths([resolved.absolutePath]).catch(() => undefined);
			throw error;
		}
		return { path: resolved.relativePath, revision: current.revision, fingerprint: current.fingerprint, deleted: true };
	});
}

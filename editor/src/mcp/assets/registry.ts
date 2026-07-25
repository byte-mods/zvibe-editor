import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "path/posix";
import { gunzipSync } from "zlib";
import { mkdir, move, pathExists, readFile, readJSON, rename, stat, writeJSON } from "fs-extra";
import StreamZip from "node-stream-zip";

import { normalizedGlob } from "../../tools/fs";
import { projectConfiguration } from "../../project/configuration";
import { getDefaultAssetImporterConfiguration, IAssetImporterConfiguration, normalizeAssetImporterConfiguration } from "babylonjs-editor-tools";
import {
	analyzeAssetFilesWithWorkers,
	assetIndexingWorkerRuntime,
	AssetIndexingCancelledError,
	defaultAssetIndexingWorkerCount,
	IAssetFileWorkerAnalysis,
	IAssetWorkerPoolOptions,
} from "./registry-worker-client";
import { AssetDependencyGraphDirection, IAssetDependencyGraph, IAssetDependencyGraphEdge, IAssetDependencyGraphNode } from "./dependency-graph";
import { extractB3dReferences, extractBlendReferences, extractDxfReferences, extractLwoReferences, extractMs3dReferences, extractXReferences } from "./binary-model-rewrite";

export const ASSET_META_SUFFIX = ".bjsmeta.json";
export const ASSET_REGISTRY_VERSION = 12;

const ASSET_REGISTRY_PATH = ".bjseditor/asset-registry.json";
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_DEPENDENCY_BYTES = 8 * 1024 * 1024;
const MAX_GLB_DEPENDENCY_BYTES = 64 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const MAX_GLB_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_DEPENDENCY_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_MODEL_STRING_BYTES = 1024 * 1024;
const MAX_BINARY_MODEL_STRINGS = 10_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 4096;
const MAX_ARCHIVE_DECLARED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_SCANNED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1024;
const FBX_BINARY_MAGIC = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
const INDEX_ROOTS = ["."];

export function isAssetMetadataPath(path: string): boolean {
	return path.endsWith(ASSET_META_SUFFIX) || new RegExp(`${ASSET_META_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f-]+\\.tmp$`, "i").test(path);
}

function isIgnoredProjectPath(path: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "");
	const segments = normalizedPath.split("/");
	return (
		segments.some(
			(segment) => ["node_modules", ".git", ".bjseditor", "build", "declaration", "dist", "out", ".next"].includes(segment) || segment.startsWith("editor-generated_")
		) ||
		normalizedPath.startsWith("public/scene/") ||
		isAssetMetadataPath(normalizedPath)
	);
}

const TEXT_DEPENDENCY_EXTENSIONS = new Set([
	".bjseditor",
	".scene",
	".prefab",
	".json",
	".material",
	".gui",
	".npss",
	".animation",
	".animations",
	".animator",
	".controller",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".html",
	".css",
	".scss",
	".glsl",
	".wgsl",
	".shader",
	".compute",
	".babylon",
	".gltf",
	".obj",
	".mtl",
	".dae",
	".xml",
	".yaml",
	".yml",
	".unity",
	".mat",
	".asset",
	".meta",
	".overridecontroller",
	".rendertexture",
	".physicmaterial",
	".lighting",
	".playable",
]);

const ASSET_TYPE_EXTENSIONS: Record<string, string[]> = {
	texture: ["png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff", "tga", "psd", "psb", "svg", "rgba"],
	"cube-texture": ["env", "hdr", "exr"],
	mesh: ["babylon", "glb", "gltf", "fbx", "obj", "dae", "3ds", "stl", "ms3d", "b3d", "x", "lwo", "dxf", "blend"],
	sound: ["mp3", "ogg", "wav", "flac", "m4a"],
	video: ["mp4", "webm", "ogv", "mov"],
	material: ["material", "mtl"],
	particle: ["npss"],
	gui: ["gui"],
	navmesh: ["navmesh"],
	scene: ["scene", "bjseditor"],
	prefab: ["prefab"],
	animation: ["animation", "animations", "animator", "controller"],
	shader: ["glsl", "wgsl", "shader", "fx", "compute"],
	script: ["ts", "tsx", "js", "jsx", "mts", "cts"],
	style: ["css", "scss", "sass", "less"],
	markup: ["html", "htm", "xml"],
	font: ["ttf", "otf", "woff", "woff2"],
	data: ["json", "yaml", "yml", "csv", "txt", "md", "bin", "pdf", "dwg", "dwf", "dwfx", "dgn", "nwd", "nwc", "ies", "zip", "tar", "tgz", "gz", "unitypackage"],
};

export interface IAssetContainerEntry {
	path: string;
	sizeBytes: number;
	type: string;
	scannable: boolean;
}

export interface IAssetContainerDependency {
	sourcePath: string;
	targetPath: string;
	missing: boolean;
	external: boolean;
}

export interface IAssetRegistryMetadata {
	guid: string;
	labels: string[];
	tags: string[];
	favorite: boolean;
	importer: IAssetImporterConfiguration;
	originPath?: string;
	importedAt?: string;
	reimportedAt?: string;
	importState: IAssetImportState;
}

export type AssetImportStatus = "native" | "unchecked" | "current" | "stale" | "missing" | "error";

export interface IAssetImportState {
	status: AssetImportStatus;
	checkedAt?: string;
	sourceSizeBytes?: number;
	sourceModifiedAt?: string;
	sourceHash?: string | null;
	hashDeferred?: boolean;
	error?: { code: string; message: string; at: string };
}

export interface IAssetRegistryEntry {
	guid: string;
	path: string;
	name: string;
	type: string;
	extension: string;
	sizeBytes: number;
	modifiedAt: string;
	contentHash: string | null;
	hashDeferred: boolean;
	labels: string[];
	tags: string[];
	favorite: boolean;
	importer: IAssetImporterConfiguration;
	importState: IAssetImportState;
	dependencyCandidates: string[];
	dependencies: string[];
	missingDependencies: string[];
	referencedBy: string[];
	dependencyScanKind: AssetDependencyScanKind;
	dependencyScanStatus: AssetDependencyScanStatus;
	dependencyScanMessage?: string;
	dependencyScanDeferred: boolean;
	containerEntries: IAssetContainerEntry[];
	containerDependencies: IAssetContainerDependency[];
}

export type AssetDependencyScanKind = "text" | "glb" | "fbx" | "3ds" | "ms3d" | "b3d" | "x" | "lwo" | "dxf" | "blend" | "archive" | "none";
export type AssetDependencyScanStatus = "complete" | "deferred" | "malformed" | "notApplicable";

export interface IAssetDependencyScannerDefinition {
	kind: Exclude<AssetDependencyScanKind, "none">;
	extensions: string[];
	maximumBytes: number;
	description: string;
}

export interface IAssetRegistry {
	version: number;
	generatedAt: string;
	entries: IAssetRegistryEntry[];
	duplicateGuids: Array<{ guid: string; paths: string[] }>;
	dependencyEdgeCount: number;
	missingDependencyCount: number;
}

let registryOperation: Promise<unknown> = Promise.resolve();

export type AssetIndexingJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type AssetIndexingJobPhase = "queued" | "discovering" | "analyzing" | "metadata" | "publishing" | "complete";

export interface IAssetIndexingJob {
	id: string;
	mode: "rebuild" | "refresh";
	status: AssetIndexingJobStatus;
	phase: AssetIndexingJobPhase;
	paths: string[];
	workerCount: number;
	processedFiles: number;
	totalFiles: number;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	result?: { entryCount: number; dependencyEdgeCount: number; missingDependencyCount: number };
	error?: string;
	cancelRequested: boolean;
}

const assetIndexingJobs: IAssetIndexingJob[] = [];
let activeAssetIndexingJob: IAssetIndexingJob | null = null;

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function registryPath(): string {
	return join(projectDirectory(), ASSET_REGISTRY_PATH);
}

function resolveProjectPath(path: string): string {
	const root = projectDirectory();
	const absolute = normalize(isAbsolute(path) ? path : join(root, path));
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error("Asset paths must stay inside the open project directory.");
	}
	return absolute;
}

export function getAssetTypeFromPath(path: string): string {
	const extension = extname(path).replace(".", "").toLowerCase();
	for (const [type, extensions] of Object.entries(ASSET_TYPE_EXTENSIONS)) {
		if (extensions.includes(extension)) {
			return type;
		}
	}
	return "other";
}

export async function readAssetMetadata(assetPath: string): Promise<IAssetRegistryMetadata> {
	const sidecar = `${assetPath}${ASSET_META_SUFFIX}`;
	if (await pathExists(sidecar)) {
		try {
			const value = await readJSON(sidecar);
			if (typeof value.guid === "string" && value.guid.trim()) {
				let importer: IAssetImporterConfiguration;
				let migrateImporter = value.importer?.version !== 1 || !value.importer?.settings;
				try {
					importer = normalizeAssetImporterConfiguration(assetPath, value.importer);
				} catch {
					importer = getDefaultAssetImporterConfiguration(assetPath);
					migrateImporter = true;
				}
				const metadata: IAssetRegistryMetadata = {
					guid: value.guid,
					labels: Array.isArray(value.labels) ? [...new Set<string>(value.labels.filter((label: unknown): label is string => typeof label === "string"))].sort() : [],
					tags: Array.isArray(value.tags)
						? [
								...new Set<string>(
									value.tags
										.filter((tag: unknown): tag is string => typeof tag === "string")
										.map((tag: string) => tag.trim())
										.filter((tag: string) => tag.length > 0 && tag.length <= 64)
								),
							].sort()
						: [],
					favorite: value.favorite === true,
					importer,
					originPath: value.originPath,
					importedAt: value.importedAt,
					reimportedAt: value.reimportedAt,
					importState: normalizeImportState(value.importState, typeof value.originPath === "string"),
				};
				if (migrateImporter) {
					await writeAssetMetadata(assetPath, metadata);
				}
				return metadata;
			}
		} catch {
			// Invalid sidecars are replaced below with a valid stable identity.
		}
	}
	const metadata: IAssetRegistryMetadata = {
		guid: randomUUID(),
		labels: [],
		tags: [],
		favorite: false,
		importer: getDefaultAssetImporterConfiguration(assetPath),
		importState: { status: "native" },
	};
	await writeAssetMetadata(assetPath, metadata);
	return metadata;
}

export async function writeAssetMetadata(assetPath: string, metadata: Partial<IAssetRegistryMetadata>): Promise<IAssetRegistryMetadata> {
	const value: IAssetRegistryMetadata = {
		guid: metadata.guid ?? randomUUID(),
		labels: [...new Set(metadata.labels ?? [])].sort(),
		tags: sanitizeAssetTags(metadata.tags),
		favorite: metadata.favorite === true,
		importer: normalizeAssetImporterConfiguration(assetPath, metadata.importer),
		originPath: metadata.originPath,
		importedAt: metadata.importedAt,
		reimportedAt: metadata.reimportedAt,
		importState: normalizeImportState(metadata.importState, Boolean(metadata.originPath)),
	};
	const destination = `${assetPath}${ASSET_META_SUFFIX}`;
	const temporary = `${destination}.${randomUUID()}.tmp`;
	await writeJSON(temporary, value, { spaces: "\t" });
	try {
		await rename(temporary, destination);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST" && code !== "EPERM") {
			throw error;
		}
		await move(temporary, destination, { overwrite: true });
	}
	return value;
}

export function sanitizeAssetTags(value: unknown): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error("Asset tags must be an array of strings.");
	}
	if (value.length > 64) {
		throw new Error("Assets support at most 64 tags.");
	}
	const tags = value.map((tag) => {
		if (typeof tag !== "string") {
			throw new Error("Asset tags must be strings.");
		}
		const normalized = tag.trim();
		if (!normalized || normalized.length > 64) {
			throw new Error("Asset tags must contain 1 to 64 characters.");
		}
		return normalized;
	});
	return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

function normalizeImportState(value: unknown, imported: boolean): IAssetImportState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { status: imported ? "unchecked" : "native" };
	}
	const state = value as Partial<IAssetImportState>;
	const statuses: AssetImportStatus[] = ["native", "unchecked", "current", "stale", "missing", "error"];
	return {
		status: statuses.includes(state.status as AssetImportStatus) ? (state.status as AssetImportStatus) : imported ? "unchecked" : "native",
		checkedAt: typeof state.checkedAt === "string" ? state.checkedAt : undefined,
		sourceSizeBytes: typeof state.sourceSizeBytes === "number" ? state.sourceSizeBytes : undefined,
		sourceModifiedAt: typeof state.sourceModifiedAt === "string" ? state.sourceModifiedAt : undefined,
		sourceHash: typeof state.sourceHash === "string" || state.sourceHash === null ? state.sourceHash : undefined,
		hashDeferred: state.hashDeferred === true,
		error:
			state.error && typeof state.error.code === "string" && typeof state.error.message === "string" && typeof state.error.at === "string"
				? { code: state.error.code.slice(0, 64), message: state.error.message.slice(0, 1024), at: state.error.at }
				: undefined,
	};
}

export async function inspectAssetImportState(metadata: IAssetRegistryMetadata): Promise<IAssetImportState> {
	const checkedAt = new Date().toISOString();
	if (!metadata.originPath) {
		return { status: "native", checkedAt };
	}
	if (!(await pathExists(metadata.originPath))) {
		return { status: "missing", checkedAt, error: { code: "SOURCE_MISSING", message: "Recorded import source is unavailable.", at: checkedAt } };
	}
	try {
		const details = await stat(metadata.originPath);
		if (!details.isFile()) {
			return { status: "error", checkedAt, error: { code: "SOURCE_NOT_FILE", message: "Recorded import source is not a file.", at: checkedAt } };
		}
		const fingerprint = await hashFile(metadata.originPath, details.size);
		const sourceModifiedAt = details.mtime.toISOString();
		const previous = metadata.importState;
		const changed =
			previous.sourceSizeBytes !== undefined &&
			(previous.sourceSizeBytes !== details.size ||
				previous.sourceModifiedAt !== sourceModifiedAt ||
				(!fingerprint.hashDeferred && previous.sourceHash !== fingerprint.contentHash));
		return {
			status: changed ? "stale" : "current",
			checkedAt,
			sourceSizeBytes: details.size,
			sourceModifiedAt,
			sourceHash: fingerprint.contentHash,
			hashDeferred: fingerprint.hashDeferred,
		};
	} catch (error) {
		return {
			status: "error",
			checkedAt,
			error: { code: "SOURCE_READ_FAILED", message: (error instanceof Error ? error.message : String(error)).slice(0, 1024), at: checkedAt },
		};
	}
}

async function hashFile(path: string, size: number): Promise<{ contentHash: string | null; hashDeferred: boolean }> {
	if (size > MAX_HASH_BYTES) {
		return { contentHash: null, hashDeferred: true };
	}
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve({ contentHash: hash.digest("hex"), hashDeferred: false }));
	});
}

function visitStringValues(value: unknown, values: string[]): void {
	if (typeof value === "string") {
		values.push(value);
	} else if (Array.isArray(value)) {
		value.forEach((item) => visitStringValues(item, values));
	} else if (value && typeof value === "object") {
		Object.values(value).forEach((item) => visitStringValues(item, values));
	}
}

function extractTextDependencyValues(content: string): string[] {
	const values: string[] = [];
	try {
		visitStringValues(JSON.parse(content), values);
	} catch {
		for (const match of content.matchAll(/["'`]([^"'`\r\n]{1,1024}?\.[a-z0-9]{1,16}(?:[?#][^"'`]*)?)["'`]/gi)) {
			values.push(match[1]);
		}
		for (const match of content.matchAll(/(?:assets|src|scripts)\/[a-z0-9_@%+.,()\-/]+?\.[a-z0-9]{1,16}/gi)) {
			values.push(match[0]);
		}
	}
	return values;
}

function extractModelTextDependencyValues(content: string, extension: string): string[] {
	const values = extractTextDependencyValues(content);
	if (extension === ".obj" || extension === ".mtl") {
		for (const line of content.split(/\r?\n/)) {
			const match = line.match(/^\s*(mtllib|map_[a-z0-9_]+|bump|disp|decal|refl)\s+(.+?)\s*$/i);
			if (!match) {
				continue;
			}
			const tokens = match[2].match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
			const candidate = tokens.reverse().find((token) => /\.[a-z0-9]{1,16}(?:[?#].*)?$/i.test(token));
			if (candidate) {
				values.push(candidate.replace(/^"|"$/g, ""));
			}
		}
	} else if (extension === ".dae") {
		for (const match of content.matchAll(/<init_from(?:\s[^>]*)?>([^<]{1,1024})<\/init_from>/gi)) {
			values.push(match[1]);
		}
	}
	return values;
}

function visitUriValues(value: unknown, values: string[]): void {
	if (Array.isArray(value)) {
		value.forEach((item) => visitUriValues(item, values));
	} else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.uri === "string") {
			values.push(record.uri);
		}
		Object.values(record).forEach((item) => visitUriValues(item, values));
	}
}

function normalizeDependencyCandidate(sourcePath: string, candidate: string, root = projectDirectory()): string | null {
	const cleaned = candidate
		.trim()
		.replace(/\\/g, "/")
		.replace(/[?#].*$/, "");
	if (!cleaned || cleaned.startsWith("@") || cleaned.startsWith("data:") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned) || cleaned.startsWith("//")) {
		return null;
	}
	if (!/\.[a-z][a-z0-9]{0,15}$/i.test(cleaned)) {
		return null;
	}
	if (getAssetTypeFromPath(cleaned) === "other") {
		return null;
	}
	const projectRelativeCandidate = cleaned.startsWith("scripts/") ? join("src", cleaned) : cleaned;
	const absolute = normalize(
		projectRelativeCandidate.startsWith("assets/") || projectRelativeCandidate.startsWith("src/")
			? join(root, projectRelativeCandidate)
			: join(dirname(sourcePath), projectRelativeCandidate)
	);
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		return null;
	}
	const result = relative(root, absolute).replace(/\\/g, "/");
	return result && result !== relative(root, sourcePath).replace(/\\/g, "/") ? result : null;
}

export function resolveAssetDependencyCandidate(sourcePath: string, candidate: string): string | null {
	return normalizeDependencyCandidate(resolveProjectPath(sourcePath), candidate, projectDirectory());
}

function normalizeBlendDependencyCandidate(sourcePath: string, candidate: string, root: string): string | null {
	const trimmed = candidate.trim();
	if (/^(?:\/[^/]|[a-z]:[\\/])/i.test(trimmed)) {
		return null;
	}
	return normalizeDependencyCandidate(sourcePath, trimmed.startsWith("//") ? `./${trimmed.slice(2)}` : trimmed, root);
}

/** Resolves Blender's `//` project-file-relative paths without treating protocol-relative URLs as local assets in other formats. */
export function resolveBlendDependencyCandidate(sourcePath: string, candidate: string): string | null {
	return normalizeBlendDependencyCandidate(resolveProjectPath(sourcePath), candidate, projectDirectory());
}

function extractGlbUris(buffer: Buffer): { values: string[]; error?: string } {
	if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2) {
		return { values: [], error: "The GLB header is missing or is not glTF binary version 2." };
	}
	const declaredLength = buffer.readUInt32LE(8);
	if (declaredLength > buffer.length || declaredLength < 20) {
		return { values: [], error: "The GLB declared length is outside the available file bytes." };
	}
	let offset = 12;
	while (offset + 8 <= declaredLength) {
		const length = buffer.readUInt32LE(offset);
		const type = buffer.readUInt32LE(offset + 4);
		offset += 8;
		if (length > MAX_GLB_JSON_BYTES || offset + length > declaredLength) {
			return { values: [], error: "The GLB JSON chunk is oversized or truncated." };
		}
		if (type !== GLB_JSON_CHUNK) {
			offset += length;
			continue;
		}
		try {
			const json = JSON.parse(
				buffer
					.subarray(offset, offset + length)
					.toString("utf-8")
					.replace(/\0+$/, "")
			);
			const values: string[] = [];
			visitUriValues(json, values);
			return { values };
		} catch {
			return { values: [], error: "The GLB JSON chunk is malformed." };
		}
	}
	return { values: [], error: "The GLB does not contain a JSON chunk." };
}

function readFbxInteger(buffer: Buffer, offset: number, wide: boolean): number | null {
	if (wide) {
		if (offset + 8 > buffer.length) {
			return null;
		}
		const value = buffer.readBigUInt64LE(offset);
		return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
	}
	return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null;
}

function parseFbxProperties(buffer: Buffer, offset: number, end: number, count: number, values: string[]): boolean {
	let cursor = offset;
	for (let index = 0; index < count; index++) {
		if (cursor >= end) {
			return false;
		}
		const type = String.fromCharCode(buffer[cursor++]);
		const scalarBytes: Record<string, number> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
		if (scalarBytes[type] !== undefined) {
			cursor += scalarBytes[type];
		} else if ("fdlib".includes(type)) {
			if (cursor + 12 > end) {
				return false;
			}
			const encodedBytes = buffer.readUInt32LE(cursor + 8);
			cursor += 12 + encodedBytes;
		} else if (type === "S" || type === "R") {
			if (cursor + 4 > end) {
				return false;
			}
			const length = buffer.readUInt32LE(cursor);
			cursor += 4;
			if (length > MAX_BINARY_MODEL_STRING_BYTES || cursor + length > end) {
				return false;
			}
			if (type === "S" && values.length < MAX_BINARY_MODEL_STRINGS) {
				values.push(
					buffer
						.subarray(cursor, cursor + length)
						.toString("utf-8")
						.replace(/\0/g, "")
				);
			}
			cursor += length;
		} else {
			return false;
		}
		if (cursor > end) {
			return false;
		}
	}
	return cursor === end;
}

function extractBinaryFbxStrings(buffer: Buffer): { values: string[]; error?: string } {
	if (buffer.length < 27 || !buffer.subarray(0, FBX_BINARY_MAGIC.length).equals(FBX_BINARY_MAGIC)) {
		return { values: [], error: "The FBX binary header is missing." };
	}
	const wide = buffer.readUInt32LE(23) >= 7500;
	const headerBytes = wide ? 25 : 13;
	const values: string[] = [];
	let nodeCount = 0;
	const visitNodes = (start: number, limit: number, depth: number): boolean => {
		if (depth > 64) {
			return false;
		}
		let cursor = start;
		while (cursor + headerBytes <= limit) {
			const endOffset = readFbxInteger(buffer, cursor, wide);
			const propertyCount = readFbxInteger(buffer, cursor + (wide ? 8 : 4), wide);
			const propertyBytes = readFbxInteger(buffer, cursor + (wide ? 16 : 8), wide);
			const nameLength = buffer[cursor + (wide ? 24 : 12)];
			if (endOffset === 0 && propertyCount === 0 && propertyBytes === 0 && nameLength === 0) {
				return true;
			}
			if (
				endOffset === null ||
				propertyCount === null ||
				propertyBytes === null ||
				++nodeCount > 100_000 ||
				propertyCount > 1_000_000 ||
				propertyBytes > 16 * 1024 * 1024 ||
				endOffset <= cursor + headerBytes + nameLength ||
				endOffset > limit
			) {
				return false;
			}
			const propertyStart = cursor + headerBytes + nameLength;
			const propertyEnd = propertyStart + propertyBytes;
			if (propertyEnd > endOffset || !parseFbxProperties(buffer, propertyStart, propertyEnd, propertyCount, values)) {
				return false;
			}
			if (propertyEnd + headerBytes <= endOffset && !visitNodes(propertyEnd, endOffset, depth + 1)) {
				return false;
			}
			cursor = endOffset;
		}
		return cursor === limit;
	};
	return visitNodes(27, buffer.length, 0) ? { values } : { values: [], error: "The FBX binary node or property table is malformed." };
}

const THREE_DS_CONTAINER_CHUNKS = new Set([0x4d4d, 0x3d3d, 0xafff, 0xa200, 0xa204, 0xa210, 0xa220, 0xa230, 0xa33a, 0xa33c, 0xa33d, 0xa33e, 0xa340]);

function extract3dsTextureNames(buffer: Buffer): { values: string[]; error?: string } {
	const values: string[] = [];
	let chunkCount = 0;
	const visitChunks = (start: number, limit: number, depth: number): boolean => {
		if (depth > 32) {
			return false;
		}
		let cursor = start;
		while (cursor < limit) {
			if (cursor + 6 > limit || ++chunkCount > 100_000) {
				return false;
			}
			const id = buffer.readUInt16LE(cursor);
			const length = buffer.readUInt32LE(cursor + 2);
			const end = cursor + length;
			if (length < 6 || end > limit) {
				return false;
			}
			if (id === 0xa300) {
				const zero = buffer.indexOf(0, cursor + 6);
				if (zero < 0 || zero >= end || zero - (cursor + 6) > MAX_BINARY_MODEL_STRING_BYTES) {
					return false;
				}
				values.push(buffer.subarray(cursor + 6, zero).toString("utf-8"));
			} else if (THREE_DS_CONTAINER_CHUNKS.has(id) && end > cursor + 6 && !visitChunks(cursor + 6, end, depth + 1)) {
				return false;
			}
			cursor = end;
		}
		return cursor === limit;
	};
	if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0x4d4d || !visitChunks(0, buffer.length, 0)) {
		return { values: [], error: "The 3DS chunk table is malformed or has no main chunk." };
	}
	return { values };
}

interface IArchiveMember {
	path: string;
	sizeBytes: number;
	read: () => Promise<Buffer>;
}

function isArchivePath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".unitypackage");
}

function normalizeArchiveMemberPath(path: string): string | null {
	const cleaned = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (!cleaned || cleaned.length > MAX_ARCHIVE_PATH_BYTES || cleaned.startsWith("/") || /^[a-z]:\//i.test(cleaned)) {
		return null;
	}
	const result = normalize(cleaned).replace(/^\.\/+/, "");
	return !result || result === "." || result === ".." || result.startsWith("../") ? null : result;
}

function archiveMemberScanLimit(path: string): number | null {
	const extension = extname(path).toLowerCase();
	if (extension === ".glb") {
		return MAX_GLB_DEPENDENCY_BYTES;
	}
	if (
		extension === ".fbx" ||
		extension === ".3ds" ||
		extension === ".ms3d" ||
		extension === ".b3d" ||
		extension === ".x" ||
		extension === ".lwo" ||
		extension === ".dxf" ||
		extension === ".blend"
	) {
		return MAX_MODEL_DEPENDENCY_BYTES;
	}
	return TEXT_DEPENDENCY_EXTENSIONS.has(extension) ? MAX_TEXT_DEPENDENCY_BYTES : null;
}

function extractArchiveMemberCandidates(path: string, buffer: Buffer): { values: string[]; error?: string } {
	const extension = extname(path).toLowerCase();
	if (extension === ".glb") {
		return extractGlbUris(buffer);
	}
	if (extension === ".fbx") {
		return buffer.subarray(0, FBX_BINARY_MAGIC.length).equals(FBX_BINARY_MAGIC)
			? extractBinaryFbxStrings(buffer)
			: { values: extractTextDependencyValues(buffer.toString("utf-8")) };
	}
	if (extension === ".3ds") {
		return extract3dsTextureNames(buffer);
	}
	if (extension === ".ms3d") {
		return extractMs3dReferences(buffer);
	}
	if (extension === ".b3d") {
		return extractB3dReferences(buffer);
	}
	if (extension === ".x") {
		return extractXReferences(buffer);
	}
	if (extension === ".lwo") {
		return extractLwoReferences(buffer);
	}
	if (extension === ".dxf") {
		return extractDxfReferences(buffer);
	}
	if (extension === ".blend") {
		return extractBlendReferences(buffer);
	}
	return { values: extractModelTextDependencyValues(buffer.toString("utf-8"), extension) };
}

function normalizeArchiveDependencyCandidate(sourcePath: string, candidate: string): string | null {
	const cleaned = candidate
		.trim()
		.replace(/\\/g, "/")
		.replace(/[?#].*$/, "");
	if (
		!cleaned ||
		cleaned.startsWith("@") ||
		cleaned.startsWith("data:") ||
		/^[a-z][a-z0-9+.-]*:/i.test(cleaned) ||
		cleaned.startsWith("//") ||
		getAssetTypeFromPath(cleaned) === "other"
	) {
		return null;
	}
	return normalizeArchiveMemberPath(cleaned.startsWith("/") ? cleaned.slice(1) : join(dirname(sourcePath), cleaned));
}

function normalizeArchiveBlendDependencyCandidate(sourcePath: string, candidate: string): string | null {
	const trimmed = candidate.trim();
	if (/^(?:\/[^/]|[a-z]:[\\/])/i.test(trimmed)) {
		return null;
	}
	return normalizeArchiveDependencyCandidate(sourcePath, trimmed.startsWith("//") ? trimmed.slice(2) : trimmed);
}

async function scanArchiveMembers(
	archivePath: string,
	members: IArchiveMember[],
	root: string,
	guidTargets = new Map<string, string>()
): Promise<{
	dependencyCandidates: string[];
	dependencyScanStatus: AssetDependencyScanStatus;
	dependencyScanMessage?: string;
	dependencyScanDeferred: boolean;
	containerEntries: IAssetContainerEntry[];
	containerDependencies: IAssetContainerDependency[];
}> {
	if (members.length > MAX_ARCHIVE_ENTRY_COUNT) {
		return {
			dependencyCandidates: [],
			dependencyScanStatus: "deferred",
			dependencyScanMessage: `Archive contains more than ${MAX_ARCHIVE_ENTRY_COUNT.toLocaleString()} file entries.`,
			dependencyScanDeferred: true,
			containerEntries: [],
			containerDependencies: [],
		};
	}
	const declaredBytes = members.reduce((count, member) => count + member.sizeBytes, 0);
	if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_ARCHIVE_DECLARED_BYTES) {
		return {
			dependencyCandidates: [],
			dependencyScanStatus: "deferred",
			dependencyScanMessage: "Archive declares more than 1 GiB of expanded file data.",
			dependencyScanDeferred: true,
			containerEntries: [],
			containerDependencies: [],
		};
	}
	const paths = new Set<string>();
	for (const member of members) {
		if (!member.path || paths.has(member.path)) {
			return {
				dependencyCandidates: [],
				dependencyScanStatus: "malformed",
				dependencyScanMessage: "Archive contains an unsafe or duplicate normalized member path.",
				dependencyScanDeferred: false,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		paths.add(member.path);
	}
	const containerEntries = members
		.map(
			(member): IAssetContainerEntry => ({
				path: member.path,
				sizeBytes: member.sizeBytes,
				type: getAssetTypeFromPath(member.path),
				scannable: archiveMemberScanLimit(member.path) !== null,
			})
		)
		.sort((a, b) => a.path.localeCompare(b.path));
	const projectDependencies = new Set<string>();
	const containerDependencies: IAssetContainerDependency[] = [];
	let scannedBytes = 0;
	let deferredEntries = 0;
	for (const member of members) {
		const memberLimit = archiveMemberScanLimit(member.path);
		if (memberLimit === null) {
			continue;
		}
		if (member.sizeBytes > memberLimit || scannedBytes + member.sizeBytes > MAX_ARCHIVE_SCANNED_BYTES) {
			deferredEntries++;
			continue;
		}
		const memberBytes = await member.read();
		const result = extractArchiveMemberCandidates(member.path, memberBytes);
		if (result.error) {
			return {
				dependencyCandidates: [],
				dependencyScanStatus: "malformed",
				dependencyScanMessage: `Archive member ${member.path} is malformed: ${result.error}`,
				dependencyScanDeferred: false,
				containerEntries,
				containerDependencies: [],
			};
		}
		scannedBytes += member.sizeBytes;
		for (const rawCandidate of result.values) {
			const projectCandidate = /^(?:assets|src|scripts)\//i.test(rawCandidate.trim()) && normalizeDependencyCandidate(archivePath, rawCandidate, root);
			if (projectCandidate) {
				projectDependencies.add(projectCandidate);
				containerDependencies.push({ sourcePath: member.path, targetPath: projectCandidate, missing: false, external: true });
				continue;
			}
			const targetPath =
				extname(member.path).toLowerCase() === ".blend"
					? normalizeArchiveBlendDependencyCandidate(member.path, rawCandidate)
					: normalizeArchiveDependencyCandidate(member.path, rawCandidate);
			if (targetPath && targetPath !== member.path) {
				containerDependencies.push({ sourcePath: member.path, targetPath, missing: !paths.has(targetPath), external: false });
			}
		}
		if (guidTargets.size) {
			for (const match of memberBytes.toString("utf-8").matchAll(/\bguid:\s*([0-9a-f]{32})\b/gi)) {
				const guid = match[1].toLowerCase();
				if (/^0+$/.test(guid)) {
					continue;
				}
				const targetPath = guidTargets.get(guid) ?? `GUID/${guid}`;
				if (targetPath !== member.path) {
					containerDependencies.push({ sourcePath: member.path, targetPath, missing: !paths.has(targetPath), external: false });
				}
			}
		}
	}
	const uniqueDependencies = [
		...new Map(containerDependencies.map((dependency) => [`${dependency.sourcePath}\0${dependency.targetPath}\0${dependency.external}`, dependency])).values(),
	].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.targetPath.localeCompare(b.targetPath));
	return {
		dependencyCandidates: [...projectDependencies].sort(),
		dependencyScanStatus: deferredEntries ? "deferred" : "complete",
		dependencyScanMessage: deferredEntries
			? `${deferredEntries.toLocaleString()} scannable archive member${deferredEntries === 1 ? " was" : "s were"} deferred by per-entry or 32 MiB aggregate limits.`
			: `Indexed ${containerEntries.length.toLocaleString()} archive member${containerEntries.length === 1 ? "" : "s"}.`,
		dependencyScanDeferred: deferredEntries > 0,
		containerEntries,
		containerDependencies: uniqueDependencies,
	};
}

async function normalizeUnityPackageMembers(members: IArchiveMember[]): Promise<{ members: IArchiveMember[]; guidTargets: Map<string, string> }> {
	const pathnameMembers = new Map<string, IArchiveMember>();
	for (const member of members) {
		const match = member.path.match(/^([0-9a-f]{32})\/pathname$/i);
		if (match && member.sizeBytes <= MAX_ARCHIVE_PATH_BYTES) {
			pathnameMembers.set(match[1].toLowerCase(), member);
		}
	}
	const guidTargets = new Map<string, string>();
	for (const [guid, member] of pathnameMembers) {
		const path = normalizeArchiveMemberPath(
			(await member.read())
				.toString("utf-8")
				.trim()
				.replace(/^Assets\//, "assets/")
		);
		if (path) {
			guidTargets.set(guid, path);
		}
	}
	const normalizedMembers: IArchiveMember[] = [];
	for (const member of members) {
		const match = member.path.match(/^([0-9a-f]{32})\/(asset|asset\.meta|preview\.png)$/i);
		if (!match) {
			if (!/^[0-9a-f]{32}\/pathname$/i.test(member.path)) {
				normalizedMembers.push(member);
			}
			continue;
		}
		const target = guidTargets.get(match[1].toLowerCase());
		if (!target) {
			normalizedMembers.push(member);
			continue;
		}
		const suffix = match[2].toLowerCase() === "asset" ? "" : match[2].toLowerCase() === "asset.meta" ? ".meta" : ".preview.png";
		normalizedMembers.push({ ...member, path: `${target}${suffix}` });
	}
	return { members: normalizedMembers, guidTargets };
}

function readTarMembers(buffer: Buffer): IArchiveMember[] {
	const members: IArchiveMember[] = [];
	let offset = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((value) => value === 0)) {
			break;
		}
		const readString = (start: number, length: number): string =>
			header
				.subarray(start, start + length)
				.toString("utf-8")
				.replace(/\0.*$/, "")
				.trim();
		const name = readString(0, 100);
		const prefix = readString(345, 155);
		const sizeText = readString(124, 12);
		const sizeBytes = sizeText ? Number.parseInt(sizeText.replace(/\0/g, "").trim(), 8) : 0;
		const type = header[156];
		const path = normalizeArchiveMemberPath(prefix ? `${prefix}/${name}` : name);
		const dataStart = offset + 512;
		const dataEnd = dataStart + sizeBytes;
		if (!path || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || dataEnd > buffer.length) {
			throw new Error("The TAR header table is malformed or contains an unsafe member path.");
		}
		if (type === 0 || type === 48) {
			members.push({ path, sizeBytes, read: async () => Buffer.from(buffer.subarray(dataStart, dataEnd)) });
		}
		offset = dataStart + Math.ceil(sizeBytes / 512) * 512;
	}
	return members;
}

async function extractArchiveDependencies(
	absolutePath: string,
	size: number,
	root: string
): Promise<{
	dependencyCandidates: string[];
	dependencyScanStatus: AssetDependencyScanStatus;
	dependencyScanMessage?: string;
	dependencyScanDeferred: boolean;
	containerEntries: IAssetContainerEntry[];
	containerDependencies: IAssetContainerDependency[];
}> {
	if (size > MAX_ARCHIVE_BYTES) {
		return {
			dependencyCandidates: [],
			dependencyScanStatus: "deferred",
			dependencyScanMessage: "Archive exceeds the 64 MiB compressed scan limit.",
			dependencyScanDeferred: true,
			containerEntries: [],
			containerDependencies: [],
		};
	}
	const lower = absolutePath.toLowerCase();
	if (lower.endsWith(".zip")) {
		const zip = new StreamZip.async({ file: absolutePath, storeEntries: true });
		try {
			const entries = Object.values(await zip.entries()).filter((entry) => entry.isFile);
			const members: IArchiveMember[] = entries.map((entry) => {
				const path = normalizeArchiveMemberPath(entry.name);
				return { path: path ?? "", sizeBytes: entry.size, read: async () => zip.entryData(entry) };
			});
			return await scanArchiveMembers(absolutePath, members, root);
		} finally {
			await zip.close().catch(() => undefined);
		}
	}
	const bytes = await readFile(absolutePath);
	let tarBytes = bytes;
	if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".unitypackage")) {
		tarBytes = gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
	}
	const tarMembers = readTarMembers(tarBytes);
	if (lower.endsWith(".unitypackage")) {
		const normalized = await normalizeUnityPackageMembers(tarMembers);
		return scanArchiveMembers(absolutePath, normalized.members, root, normalized.guidTargets);
	}
	return scanArchiveMembers(absolutePath, tarMembers, root);
}

export function listAssetDependencyScanners(): IAssetDependencyScannerDefinition[] {
	const definitions: IAssetDependencyScannerDefinition[] = [
		{
			kind: "text",
			extensions: [...TEXT_DEPENDENCY_EXTENSIONS].sort(),
			maximumBytes: MAX_TEXT_DEPENDENCY_BYTES,
			description: "Structured JSON/editor files and bounded source/model text.",
		},
		{ kind: "glb", extensions: [".glb"], maximumBytes: MAX_GLB_DEPENDENCY_BYTES, description: "glTF 2 binary JSON-chunk URI references." },
		{
			kind: "fbx",
			extensions: [".fbx"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description: "ASCII FBX paths or binary FBX string properties; compressed array payloads are skipped.",
		},
		{ kind: "3ds", extensions: [".3ds"], maximumBytes: MAX_MODEL_DEPENDENCY_BYTES, description: "3DS material texture-map filename chunks." },
		{
			kind: "ms3d",
			extensions: [".ms3d"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description: "MilkShape 3D material texture and alpha-map fixed-width filename fields.",
		},
		{
			kind: "b3d",
			extensions: [".b3d"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description: "Blitz3D BB3D root and TEXS texture filename records with validated chunk lengths.",
		},
		{
			kind: "x",
			extensions: [".x"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description: "Uncompressed DirectX 0302/0303 text or tokenized-binary TextureFilename data objects.",
		},
		{
			kind: "lwo",
			extensions: [".lwo"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description: "Big-endian LWOB TIMG and LWO2/LWO3/LXOB CLIP image sources, including bounded numbered ISEQ members.",
		},
		{
			kind: "dxf",
			extensions: [".dxf"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description: "Bounded ASCII DXF BLOCK xrefs, IMAGEDEF images, underlays, and Navisworks coordination-model paths; binary DXF is explicitly unsupported.",
		},
		{
			kind: "blend",
			extensions: [".blend"],
			maximumBytes: MAX_MODEL_DEPENDENCY_BYTES,
			description:
				"Bounded raw, GZip, or Zstandard Blender block/DNA inspection with exact external Image, Library, MovieClip, CacheFile, Volume, font, sound, shader, and modifier path fields; packed resources are ignored.",
		},
		{
			kind: "archive",
			extensions: [".zip", ".tar", ".tgz", ".tar.gz", ".unitypackage"],
			maximumBytes: MAX_ARCHIVE_BYTES,
			description: "Bounded ZIP, TAR, TAR/GZip, and Unity-package member inventory with internal, missing, and project-external dependency evidence.",
		},
	];
	return definitions.map((definition) => ({ ...definition, extensions: [...definition.extensions] }));
}

async function extractDependencyCandidates(
	absolutePath: string,
	size: number,
	root = projectDirectory()
): Promise<{
	dependencyCandidates: string[];
	dependencyScanKind: AssetDependencyScanKind;
	dependencyScanStatus: AssetDependencyScanStatus;
	dependencyScanMessage?: string;
	dependencyScanDeferred: boolean;
	containerEntries: IAssetContainerEntry[];
	containerDependencies: IAssetContainerDependency[];
}> {
	const extension = extname(absolutePath).toLowerCase();
	let rawCandidates: string[] = [];
	let dependencyScanKind: AssetDependencyScanKind = "none";
	let dependencyScanStatus: AssetDependencyScanStatus = "notApplicable";
	let dependencyScanMessage: string | undefined;
	let dependencyScanDeferred = false;
	let containerEntries: IAssetContainerEntry[] = [];
	let containerDependencies: IAssetContainerDependency[] = [];
	if (isArchivePath(absolutePath)) {
		dependencyScanKind = "archive";
		try {
			const result = await extractArchiveDependencies(absolutePath, size, root);
			rawCandidates = result.dependencyCandidates;
			dependencyScanStatus = result.dependencyScanStatus;
			dependencyScanMessage = result.dependencyScanMessage;
			dependencyScanDeferred = result.dependencyScanDeferred;
			containerEntries = result.containerEntries;
			containerDependencies = result.containerDependencies;
		} catch (error) {
			dependencyScanStatus = "malformed";
			dependencyScanMessage = `Archive could not be safely indexed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2048);
		}
	} else if (extension === ".glb") {
		dependencyScanKind = "glb";
		if (size > MAX_GLB_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB GLB scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractGlbUris(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".fbx") {
		dependencyScanKind = "fbx";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB FBX scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const buffer = await readFile(absolutePath);
		if (buffer.subarray(0, FBX_BINARY_MAGIC.length).equals(FBX_BINARY_MAGIC)) {
			const result = extractBinaryFbxStrings(buffer);
			rawCandidates = result.values;
			dependencyScanStatus = result.error ? "malformed" : "complete";
			dependencyScanMessage = result.error;
		} else {
			rawCandidates = extractTextDependencyValues(buffer.toString("utf-8"));
			dependencyScanStatus = "complete";
		}
	} else if (extension === ".3ds") {
		dependencyScanKind = "3ds";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB 3DS scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extract3dsTextureNames(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".ms3d") {
		dependencyScanKind = "ms3d";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB MS3D scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractMs3dReferences(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".b3d") {
		dependencyScanKind = "b3d";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB B3D scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractB3dReferences(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".x") {
		dependencyScanKind = "x";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB DirectX .x scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractXReferences(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".lwo") {
		dependencyScanKind = "lwo";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB LightWave LWO scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractLwoReferences(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".dxf") {
		dependencyScanKind = "dxf";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB ASCII DXF scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractDxfReferences(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (extension === ".blend") {
		dependencyScanKind = "blend";
		if (size > MAX_MODEL_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 64 MiB compressed Blender scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		const result = extractBlendReferences(await readFile(absolutePath));
		rawCandidates = result.values;
		dependencyScanStatus = result.error ? "malformed" : "complete";
		dependencyScanMessage = result.error;
	} else if (TEXT_DEPENDENCY_EXTENSIONS.has(extension)) {
		dependencyScanKind = "text";
		if (size > MAX_TEXT_DEPENDENCY_BYTES) {
			return {
				dependencyCandidates: [],
				dependencyScanKind,
				dependencyScanStatus: "deferred",
				dependencyScanMessage: "File exceeds the 8 MiB text scan limit.",
				dependencyScanDeferred: true,
				containerEntries: [],
				containerDependencies: [],
			};
		}
		rawCandidates = extractModelTextDependencyValues(await readFile(absolutePath, "utf-8"), extension);
		dependencyScanStatus = "complete";
	}
	const dependencyCandidates = [
		...new Set(
			rawCandidates
				.map((candidate) =>
					extension === ".blend" ? normalizeBlendDependencyCandidate(absolutePath, candidate, root) : normalizeDependencyCandidate(absolutePath, candidate, root)
				)
				.filter((candidate): candidate is string => candidate !== null)
		),
	].sort();
	return { dependencyCandidates, dependencyScanKind, dependencyScanStatus, dependencyScanMessage, dependencyScanDeferred, containerEntries, containerDependencies };
}

export async function analyzeAssetFile(absolutePath: string, root: string): Promise<IAssetFileWorkerAnalysis> {
	const details = await stat(absolutePath);
	const hash = await hashFile(absolutePath, details.size);
	const dependencyData = await extractDependencyCandidates(absolutePath, details.size, root);
	return {
		absolutePath,
		sizeBytes: details.size,
		modifiedAt: details.mtime.toISOString(),
		...hash,
		...dependencyData,
	};
}

async function makeEntry(analysis: IAssetFileWorkerAnalysis): Promise<IAssetRegistryEntry> {
	const absolutePath = analysis.absolutePath;
	const metadata = await readAssetMetadata(absolutePath);
	return {
		guid: metadata.guid,
		path: relative(projectDirectory(), absolutePath).replace(/\\/g, "/"),
		name: basename(absolutePath),
		type: getAssetTypeFromPath(absolutePath),
		extension: extname(absolutePath).toLowerCase(),
		sizeBytes: analysis.sizeBytes,
		modifiedAt: analysis.modifiedAt,
		contentHash: analysis.contentHash,
		hashDeferred: analysis.hashDeferred,
		labels: metadata.labels,
		tags: metadata.tags,
		favorite: metadata.favorite,
		importer: metadata.importer,
		importState: metadata.importState,
		dependencyCandidates: analysis.dependencyCandidates,
		dependencyScanKind: analysis.dependencyScanKind,
		dependencyScanStatus: analysis.dependencyScanStatus,
		dependencyScanMessage: analysis.dependencyScanMessage,
		dependencyScanDeferred: analysis.dependencyScanDeferred,
		containerEntries: analysis.containerEntries,
		containerDependencies: analysis.containerDependencies,
		dependencies: [],
		missingDependencies: [],
		referencedBy: [],
	};
}

async function makeEntries(files: string[], hooks: IAssetWorkerPoolOptions & { onPhase?: (phase: AssetIndexingJobPhase) => void } = {}): Promise<IAssetRegistryEntry[]> {
	hooks.onPhase?.("analyzing");
	const analyses = await analyzeAssetFilesWithWorkers(files, projectDirectory(), analyzeAssetFile, hooks);
	if (hooks.isCancelled?.()) {
		throw new AssetIndexingCancelledError();
	}
	hooks.onPhase?.("metadata");
	const entries: IAssetRegistryEntry[] = [];
	for (const analysis of analyses) {
		if (hooks.isCancelled?.()) {
			throw new AssetIndexingCancelledError();
		}
		entries.push(await makeEntry(analysis));
	}
	return entries;
}

function duplicates(entries: IAssetRegistryEntry[]): Array<{ guid: string; paths: string[] }> {
	const grouped = new Map<string, string[]>();
	entries.forEach((entry) => grouped.set(entry.guid, [...(grouped.get(entry.guid) ?? []), entry.path]));
	return [...grouped.entries()]
		.filter(([, paths]) => paths.length > 1)
		.map(([guid, paths]) => ({ guid, paths: paths.sort() }))
		.sort((a, b) => a.guid.localeCompare(b.guid));
}

async function saveRegistry(entries: IAssetRegistryEntry[]): Promise<IAssetRegistry> {
	entries.sort((a, b) => a.path.localeCompare(b.path));
	const paths = new Set(entries.map((entry) => entry.path));
	const reverse = new Map<string, string[]>();
	for (const entry of entries) {
		entry.dependencyCandidates ??= [];
		entry.dependencies = entry.dependencyCandidates.filter((candidate) => paths.has(candidate));
		entry.missingDependencies = entry.dependencyCandidates.filter((candidate) => !paths.has(candidate));
		entry.referencedBy = [];
		for (const dependency of entry.dependencies) {
			reverse.set(dependency, [...(reverse.get(dependency) ?? []), entry.path]);
		}
	}
	for (const entry of entries) {
		entry.referencedBy = [...new Set(reverse.get(entry.path) ?? [])].sort();
	}
	const registry: IAssetRegistry = {
		version: ASSET_REGISTRY_VERSION,
		generatedAt: new Date().toISOString(),
		entries,
		duplicateGuids: duplicates(entries),
		dependencyEdgeCount: entries.reduce((count, entry) => count + entry.dependencies.length, 0),
		missingDependencyCount: entries.reduce((count, entry) => count + entry.missingDependencies.length, 0),
	};
	const destination = registryPath();
	const temporary = `${destination}.${randomUUID()}.tmp`;
	await mkdir(dirname(destination), { recursive: true });
	await writeJSON(temporary, registry, { spaces: "\t" });
	await move(temporary, destination, { overwrite: true });
	return registry;
}

async function scanFiles(path: string): Promise<string[]> {
	if (!(await pathExists(path))) {
		return [];
	}
	const details = await stat(path);
	if (details.isFile()) {
		return path.endsWith(ASSET_META_SUFFIX) || path === projectConfiguration.path || isIgnoredProjectPath(relative(projectDirectory(), path)) ? [] : [path];
	}
	return (
		await normalizedGlob("**/*", {
			cwd: path,
			absolute: true,
			nodir: true,
			ignore: [
				"**/node_modules/**",
				"**/.git/**",
				"**/.bjseditor/**",
				"**/build/**",
				"**/declaration/**",
				"**/dist/**",
				"**/out/**",
				"**/.next/**",
				"**/public/scene/**",
				"**/editor-generated_*/**",
				`**/*${ASSET_META_SUFFIX}`,
				`**/*${ASSET_META_SUFFIX}.*.tmp`,
			],
		})
	)
		.map((entry) => entry.toString())
		.filter((entry) => entry !== projectConfiguration.path && !isIgnoredProjectPath(relative(projectDirectory(), entry)));
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
	const result = registryOperation.then(operation, operation);
	registryOperation = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}

interface IAssetRegistryExecutionHooks extends IAssetWorkerPoolOptions {
	onPhase?: (phase: AssetIndexingJobPhase) => void;
	onDiscovered?: (totalFiles: number) => void;
}

async function rebuildAssetRegistryWithHooks(options: { repairDuplicateGuids?: boolean }, hooks: IAssetRegistryExecutionHooks): Promise<IAssetRegistry> {
	return serialized(async () => {
		hooks.onPhase?.("discovering");
		const files = (await Promise.all(INDEX_ROOTS.map((root) => scanFiles(join(projectDirectory(), root))))).flat();
		hooks.onDiscovered?.(files.length);
		const entries = await makeEntries(files.sort(), hooks);
		if (options.repairDuplicateGuids) {
			for (const conflict of duplicates(entries)) {
				for (const path of conflict.paths.slice(1)) {
					const entry = entries.find((candidate) => candidate.path === path)!;
					const absolutePath = resolveProjectPath(path);
					const metadata = await readAssetMetadata(absolutePath);
					metadata.guid = randomUUID();
					await writeAssetMetadata(absolutePath, metadata);
					entry.guid = metadata.guid;
				}
			}
		}
		if (hooks.isCancelled?.()) {
			throw new AssetIndexingCancelledError();
		}
		hooks.onPhase?.("publishing");
		return saveRegistry(entries);
	});
}

export async function rebuildAssetRegistry(options: { repairDuplicateGuids?: boolean } = {}): Promise<IAssetRegistry> {
	return rebuildAssetRegistryWithHooks(options, {});
}

async function readRegistry(): Promise<IAssetRegistry | null> {
	if (!(await pathExists(registryPath()))) {
		return null;
	}
	try {
		const value = await readJSON(registryPath());
		if (!Array.isArray(value.entries)) {
			return null;
		}
		if (value.version >= 3 && value.version < ASSET_REGISTRY_VERSION) {
			const entries: IAssetRegistryEntry[] = (value.entries as IAssetRegistryEntry[])
				.filter((entry) => typeof entry.path === "string" && !isIgnoredProjectPath(entry.path))
				.map(
					(entry): IAssetRegistryEntry => ({
						...entry,
						dependencyScanStatus:
							entry.dependencyScanStatus ?? (entry.dependencyScanDeferred ? "deferred" : entry.dependencyScanKind === "none" ? "notApplicable" : "complete"),
						dependencyScanMessage:
							entry.dependencyScanMessage ?? (entry.dependencyScanDeferred ? "Scan was deferred by the previous registry's size limit." : undefined),
						containerEntries: entry.containerEntries ?? [],
						containerDependencies: entry.containerDependencies ?? [],
					})
				);
			return saveRegistry(entries);
		}
		if (value.version !== ASSET_REGISTRY_VERSION) {
			return null;
		}
		return value as IAssetRegistry;
	} catch {
		return null;
	}
}

export async function ensureAssetRegistry(): Promise<IAssetRegistry> {
	return (await readRegistry()) ?? rebuildAssetRegistry();
}

export async function refreshAssetRegistryPaths(paths: string[]): Promise<IAssetRegistry> {
	return refreshAssetRegistryPathsWithHooks(paths, {});
}

async function refreshAssetRegistryPathsWithHooks(paths: string[], hooks: IAssetRegistryExecutionHooks): Promise<IAssetRegistry> {
	return serialized(async () => {
		const current = await readRegistry();
		if (!current) {
			hooks.onPhase?.("discovering");
			const files = (await Promise.all(INDEX_ROOTS.map((root) => scanFiles(join(projectDirectory(), root))))).flat();
			hooks.onDiscovered?.(files.length);
			const entries = await makeEntries(files.sort(), hooks);
			hooks.onPhase?.("publishing");
			return saveRegistry(entries);
		}
		hooks.onPhase?.("discovering");
		const normalizedPaths = paths.map(resolveProjectPath);
		const relativePrefixes = normalizedPaths.map((path) => relative(projectDirectory(), path).replace(/\\/g, "/"));
		const retained = current.entries.filter((entry) => !relativePrefixes.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)));
		const files: string[] = [];
		for (const path of normalizedPaths) {
			files.push(...(await scanFiles(path)));
		}
		const uniqueFiles = [...new Set(files)].sort();
		hooks.onDiscovered?.(uniqueFiles.length);
		retained.push(...(await makeEntries(uniqueFiles, hooks)));
		if (hooks.isCancelled?.()) {
			throw new AssetIndexingCancelledError();
		}
		hooks.onPhase?.("publishing");
		return saveRegistry(retained);
	});
}

function publicAssetIndexingJob(job: IAssetIndexingJob): IAssetIndexingJob {
	return structuredClone(job);
}

async function runAssetIndexingJob(job: IAssetIndexingJob): Promise<void> {
	activeAssetIndexingJob = job;
	job.status = "running";
	job.startedAt = new Date().toISOString();
	const hooks: IAssetRegistryExecutionHooks = {
		workerCount: job.workerCount,
		isCancelled: () => job.cancelRequested,
		onPhase: (phase) => {
			job.phase = phase;
		},
		onDiscovered: (total) => {
			job.totalFiles = total;
		},
		onProgress: (completed, total) => {
			job.processedFiles = completed;
			job.totalFiles = total;
		},
	};
	try {
		const registry = job.mode === "rebuild" ? await rebuildAssetRegistryWithHooks({}, hooks) : await refreshAssetRegistryPathsWithHooks(job.paths, hooks);
		job.status = "completed";
		job.phase = "complete";
		job.result = {
			entryCount: registry.entries.length,
			dependencyEdgeCount: registry.dependencyEdgeCount,
			missingDependencyCount: registry.missingDependencyCount,
		};
	} catch (error) {
		if (error instanceof AssetIndexingCancelledError || job.cancelRequested) {
			job.status = "cancelled";
			job.error = "Cancelled before registry publication; the previous registry remains authoritative.";
		} else {
			job.status = "failed";
			job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
		}
	} finally {
		job.finishedAt = new Date().toISOString();
		if (activeAssetIndexingJob?.id === job.id) {
			activeAssetIndexingJob = null;
		}
	}
}

/** Starts one non-blocking, worker-backed registry rebuild or bounded path refresh. */
export function startAssetIndexingJob(data: { mode?: "rebuild" | "refresh"; paths?: string[]; workerCount?: number } = {}): IAssetIndexingJob {
	if (activeAssetIndexingJob && ["queued", "running"].includes(activeAssetIndexingJob.status)) {
		throw new Error(`Asset indexing job ${activeAssetIndexingJob.id} is already ${activeAssetIndexingJob.status}; wait for it or cancel it first.`);
	}
	const mode = data.mode ?? "rebuild";
	const paths = mode === "refresh" ? [...new Set((data.paths ?? []).map((path) => relative(projectDirectory(), resolveProjectPath(path)).replace(/\\/g, "/")))] : [];
	if (mode === "refresh" && (paths.length < 1 || paths.length > 100)) {
		throw new Error("A background refresh requires 1 to 100 contained project paths.");
	}
	const workerCount = data.workerCount ?? defaultAssetIndexingWorkerCount();
	if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
		throw new Error("workerCount must be an integer from 1 to 8.");
	}
	const job: IAssetIndexingJob = {
		id: randomUUID(),
		mode,
		status: "queued",
		phase: "queued",
		paths,
		workerCount,
		processedFiles: 0,
		totalFiles: 0,
		createdAt: new Date().toISOString(),
		cancelRequested: false,
	};
	assetIndexingJobs.unshift(job);
	assetIndexingJobs.splice(20);
	activeAssetIndexingJob = job;
	void runAssetIndexingJob(job);
	return publicAssetIndexingJob(job);
}

/** Requests cooperative cancellation; the active worker pool is terminated before any registry publication. */
export function cancelAssetIndexingJob(id: string): IAssetIndexingJob {
	const job = assetIndexingJobs.find((candidate) => candidate.id === id);
	if (!job) {
		throw new Error(`Asset indexing job not found: ${id}.`);
	}
	if (!["queued", "running"].includes(job.status)) {
		throw new Error(`Asset indexing job ${id} is already ${job.status} and cannot be cancelled.`);
	}
	job.cancelRequested = true;
	return publicAssetIndexingJob(job);
}

/** Returns bounded in-memory background-worker health and recent job evidence without starting a registry scan. */
export async function getAssetIndexingStatus(): Promise<{
	workerRuntime: "electron-web-worker" | "worker_threads";
	workerAvailable: boolean;
	defaultWorkerCount: number;
	activeJob: IAssetIndexingJob | null;
	recentJobs: IAssetIndexingJob[];
}> {
	return {
		workerRuntime: assetIndexingWorkerRuntime(),
		workerAvailable: process.env.VITEST === "true" || (await pathExists(join(__dirname, "registry-worker.js"))),
		defaultWorkerCount: defaultAssetIndexingWorkerCount(),
		activeJob: activeAssetIndexingJob ? publicAssetIndexingJob(activeAssetIndexingJob) : null,
		recentJobs: assetIndexingJobs.map(publicAssetIndexingJob),
	};
}

export async function queryAssetRegistry(data: any = {}): Promise<any> {
	const registry = await ensureAssetRegistry();
	const query = data.query?.trim().toLowerCase();
	const normalizedFolder = data.folder?.replace(/^\.\//, "").replace(/\/$/, "");
	const folder = normalizedFolder === "." ? "" : normalizedFolder;
	let entries = registry.entries.filter((entry) => {
		if (data.guid && entry.guid !== data.guid) {
			return false;
		}
		if (data.type && entry.type !== data.type) {
			return false;
		}
		if (data.label && !entry.labels.includes(data.label)) {
			return false;
		}
		if (data.tag && !entry.tags.includes(data.tag)) {
			return false;
		}
		if (data.favorite !== undefined && entry.favorite !== data.favorite) {
			return false;
		}
		if (data.importStatus && entry.importState.status !== data.importStatus) {
			return false;
		}
		if (folder && entry.path !== folder && !entry.path.startsWith(`${folder}/`)) {
			return false;
		}
		if (folder && data.recursive === false && dirname(entry.path) !== folder) {
			return false;
		}
		return !query || `${entry.path} ${entry.labels.join(" ")} ${entry.tags.join(" ")} ${entry.type} ${entry.importState.status}`.toLowerCase().includes(query);
	});
	entries = entries.sort((a, b) => a.path.localeCompare(b.path));
	const offset = Math.max(0, data.offset ?? 0);
	const limit = Math.min(500, Math.max(1, data.limit ?? 100));
	return {
		entries: entries.slice(offset, offset + limit),
		totalCount: entries.length,
		offset,
		limit,
		hasMore: offset + limit < entries.length,
		nextOffset: offset + limit < entries.length ? offset + limit : null,
		duplicateGuidCount: registry.duplicateGuids.length,
	};
}

export async function getAssetRegistryStatus(): Promise<any> {
	const registry = await ensureAssetRegistry();
	return {
		version: registry.version,
		path: ASSET_REGISTRY_PATH,
		generatedAt: registry.generatedAt,
		entryCount: registry.entries.length,
		deferredHashCount: registry.entries.filter((entry) => entry.hashDeferred).length,
		duplicateGuidCount: registry.duplicateGuids.length,
		duplicateGuids: registry.duplicateGuids,
		dependencyEdgeCount: registry.dependencyEdgeCount,
		missingDependencyCount: registry.missingDependencyCount,
		deferredDependencyScanCount: registry.entries.filter((entry) => entry.dependencyScanDeferred).length,
		malformedDependencyScanCount: registry.entries.filter((entry) => entry.dependencyScanStatus === "malformed").length,
		favoriteCount: registry.entries.filter((entry) => entry.favorite).length,
		importProblemCount: registry.entries.filter((entry) => ["stale", "missing", "error"].includes(entry.importState.status)).length,
	};
}

export async function getIndexedAssetRecord(path: string): Promise<IAssetRegistryEntry> {
	const registry = await ensureAssetRegistry();
	const projectPath = relative(projectDirectory(), resolveProjectPath(path)).replace(/\\/g, "/");
	const entry = registry.entries.find((candidate) => candidate.path === projectPath);
	if (!entry) {
		throw new Error(`Asset is not indexed: ${projectPath}. Refresh or rebuild the asset registry first.`);
	}
	return structuredClone(entry);
}

export async function getIndexedAssetDependencies(path: string): Promise<any> {
	const registry = await ensureAssetRegistry();
	const projectPath = relative(projectDirectory(), resolveProjectPath(path)).replace(/\\/g, "/");
	const entry = registry.entries.find((candidate) => candidate.path === projectPath);
	if (!entry) {
		throw new Error(`Asset is not indexed: ${projectPath}. Refresh or rebuild the asset registry first.`);
	}
	const indexedPaths = new Set(registry.entries.map((candidate) => candidate.path));
	return {
		path: entry.path,
		guid: entry.guid,
		type: entry.type,
		dependencies: entry.dependencies,
		missingDependencies: entry.missingDependencies,
		referencedBy: entry.referencedBy,
		dependencyScanKind: entry.dependencyScanKind,
		dependencyScanStatus: entry.dependencyScanStatus,
		dependencyScanMessage: entry.dependencyScanMessage,
		dependencyScanDeferred: entry.dependencyScanDeferred,
		containerEntries: entry.containerEntries,
		containerDependencies: entry.containerDependencies.map((dependency) => ({
			...dependency,
			missing: dependency.external ? !indexedPaths.has(dependency.targetPath) : dependency.missing,
		})),
		containerEntryCount: entry.containerEntries.length,
		containerDependencyCount: entry.containerDependencies.length,
		containerMissingDependencyCount: entry.containerDependencies.filter((dependency) => (dependency.external ? !indexedPaths.has(dependency.targetPath) : dependency.missing))
			.length,
	};
}

export async function getIndexedAssetMoveReferencers(path: string, directory: boolean): Promise<IAssetRegistryEntry[]> {
	const registry = await ensureAssetRegistry();
	const projectPath = relative(projectDirectory(), resolveProjectPath(path)).replace(/\\/g, "/");
	return registry.entries
		.filter((entry) => entry.dependencyCandidates.some((candidate) => candidate === projectPath || (directory && candidate.startsWith(`${projectPath}/`))))
		.map((entry) => structuredClone(entry));
}

function dependencyCycles(entries: IAssetRegistryEntry[]): string[][] {
	const edges = new Map(entries.map((entry) => [entry.path, entry.dependencies]));
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const cycles = new Map<string, string[]>();
	const visit = (path: string): void => {
		if (state.get(path) === 2) {
			return;
		}
		if (state.get(path) === 1) {
			const start = stack.indexOf(path);
			const cycle = [...stack.slice(start), path];
			const body = cycle.slice(0, -1);
			const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
			rotations.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
			const canonical = [...rotations[0], rotations[0][0]];
			cycles.set(canonical.join("\0"), canonical);
			return;
		}
		state.set(path, 1);
		stack.push(path);
		for (const dependency of edges.get(path) ?? []) {
			visit(dependency);
		}
		stack.pop();
		state.set(path, 2);
	};
	entries.forEach((entry) => visit(entry.path));
	return [...cycles.values()].sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

export async function getAssetDependencyDiagnostics(data: { query?: string; offset?: number; limit?: number } = {}): Promise<any> {
	const registry = await ensureAssetRegistry();
	const query = data.query?.trim().toLowerCase();
	const allMissing = registry.entries
		.flatMap((entry) => entry.missingDependencies.map((dependency) => ({ sourcePath: entry.path, missingPath: dependency })))
		.filter((item) => !query || `${item.sourcePath} ${item.missingPath}`.toLowerCase().includes(query))
		.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.missingPath.localeCompare(b.missingPath));
	const allCycles = dependencyCycles(registry.entries).filter((cycle) => !query || cycle.some((path) => path.toLowerCase().includes(query)));
	const archiveMissingReferences = registry.entries
		.flatMap((entry) =>
			entry.containerDependencies
				.filter((dependency) => dependency.missing && !dependency.external)
				.map((dependency) => ({ archivePath: entry.path, sourceEntry: dependency.sourcePath, missingEntry: dependency.targetPath }))
		)
		.filter((item) => !query || `${item.archivePath} ${item.sourceEntry} ${item.missingEntry}`.toLowerCase().includes(query))
		.sort((a, b) => a.archivePath.localeCompare(b.archivePath) || a.sourceEntry.localeCompare(b.sourceEntry) || a.missingEntry.localeCompare(b.missingEntry));
	const offset = Math.max(0, data.offset ?? 0);
	const limit = Math.min(500, Math.max(1, data.limit ?? 100));
	return {
		missingReferences: allMissing.slice(offset, offset + limit),
		missingReferenceCount: allMissing.length,
		archiveMissingReferences: archiveMissingReferences.slice(offset, offset + limit),
		archiveMissingReferenceCount: archiveMissingReferences.length,
		cycles: allCycles.slice(0, limit),
		cycleCount: allCycles.length,
		deferredScans: registry.entries
			.filter((entry) => entry.dependencyScanDeferred)
			.map((entry) => entry.path)
			.slice(0, limit),
		deferredScanCount: registry.entries.filter((entry) => entry.dependencyScanDeferred).length,
		malformedScans: registry.entries
			.filter((entry) => entry.dependencyScanStatus === "malformed")
			.map((entry) => ({ path: entry.path, kind: entry.dependencyScanKind, message: entry.dependencyScanMessage ?? "Malformed dependency source." }))
			.slice(0, limit),
		malformedScanCount: registry.entries.filter((entry) => entry.dependencyScanStatus === "malformed").length,
		offset,
		limit,
		hasMore: offset + limit < allMissing.length,
		nextOffset: offset + limit < allMissing.length ? offset + limit : null,
	};
}

export async function getAssetDependencyGraph(data: {
	path: string;
	direction?: AssetDependencyGraphDirection;
	depth?: number;
	includeMissing?: boolean;
	limit?: number;
}): Promise<IAssetDependencyGraph> {
	const registry = await ensureAssetRegistry();
	const rootPath = relative(projectDirectory(), resolveProjectPath(data.path)).replace(/\\/g, "/");
	const entries = new Map(registry.entries.map((entry) => [entry.path, entry]));
	if (!entries.has(rootPath)) {
		throw new Error(`Asset is not indexed: ${rootPath}. Refresh or rebuild the asset registry first.`);
	}
	const direction = data.direction ?? "dependencies";
	const depth = Math.min(16, Math.max(1, data.depth ?? 1));
	const limit = Math.min(1000, Math.max(1, data.limit ?? 200));
	const includeMissing = data.includeMissing !== false;
	const nodes = new Map<string, IAssetDependencyGraphNode>();
	const edges: IAssetDependencyGraphEdge[] = [];
	const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
	const expanded = new Set<string>();
	let truncated = false;
	while (queue.length) {
		const current = queue.shift()!;
		const entry = entries.get(current.path);
		if (!entry || expanded.has(current.path)) {
			continue;
		}
		expanded.add(current.path);
		const previousNode = nodes.get(entry.path);
		nodes.set(entry.path, { path: entry.path, guid: entry.guid, type: entry.type, missing: false, depth: Math.min(previousNode?.depth ?? current.depth, current.depth) });
		if (current.depth >= depth) {
			continue;
		}
		const targets = direction === "dependencies" ? entry.dependencies : entry.referencedBy;
		for (const target of targets) {
			if (edges.length >= limit) {
				truncated = true;
				break;
			}
			const targetEntry = entries.get(target)!;
			const sourcePath = direction === "dependencies" ? entry.path : target;
			const targetPath = direction === "dependencies" ? target : entry.path;
			edges.push({ sourcePath, targetPath, missing: false, cyclic: false });
			const targetDepth = current.depth + 1;
			const previousTarget = nodes.get(targetEntry.path);
			nodes.set(targetEntry.path, {
				path: targetEntry.path,
				guid: targetEntry.guid,
				type: targetEntry.type,
				missing: false,
				depth: Math.min(previousTarget?.depth ?? targetDepth, targetDepth),
			});
			queue.push({ path: target, depth: current.depth + 1 });
		}
		if (direction === "dependencies" && includeMissing) {
			for (const target of entry.missingDependencies) {
				if (edges.length >= limit) {
					truncated = true;
					break;
				}
				edges.push({ sourcePath: entry.path, targetPath: target, missing: true, cyclic: false });
				const missingDepth = current.depth + 1;
				const previousMissing = nodes.get(target);
				nodes.set(target, { path: target, guid: null, type: null, missing: true, depth: Math.min(previousMissing?.depth ?? missingDepth, missingDepth) });
			}
		}
		if (truncated) {
			break;
		}
	}
	const rootEntry = entries.get(rootPath)!;
	const archiveCycles: string[][] = [];
	if (direction === "dependencies" && rootEntry.containerEntries.length && depth >= 1 && !truncated) {
		const virtualPath = (memberPath: string): string => `${rootPath}!/${memberPath}`;
		const memberPaths = new Set(rootEntry.containerEntries.map((entry) => entry.path));
		for (const member of rootEntry.containerEntries) {
			if (edges.length >= limit) {
				truncated = true;
				break;
			}
			const path = virtualPath(member.path);
			nodes.set(path, { path, guid: null, type: member.type, missing: false, depth: 1, virtual: true, containerPath: rootPath });
			edges.push({ sourcePath: rootPath, targetPath: path, missing: false, cyclic: false, relationship: "contains" });
		}
		if (depth >= 2 && !truncated) {
			for (const dependency of rootEntry.containerDependencies.filter((candidate) => !candidate.external)) {
				if (edges.length >= limit) {
					truncated = true;
					break;
				}
				const sourcePath = virtualPath(dependency.sourcePath);
				const targetPath = virtualPath(dependency.targetPath);
				if (!nodes.has(sourcePath)) {
					continue;
				}
				if (dependency.missing && includeMissing) {
					nodes.set(targetPath, { path: targetPath, guid: null, type: null, missing: true, depth: 2, virtual: true, containerPath: rootPath });
				} else if (!dependency.missing && memberPaths.has(dependency.targetPath)) {
					const target = rootEntry.containerEntries.find((entry) => entry.path === dependency.targetPath)!;
					const current = nodes.get(targetPath);
					nodes.set(targetPath, {
						path: targetPath,
						guid: null,
						type: target.type,
						missing: false,
						depth: Math.min(current?.depth ?? 2, 2),
						virtual: true,
						containerPath: rootPath,
					});
				} else {
					continue;
				}
				edges.push({ sourcePath, targetPath, missing: dependency.missing, cyclic: false, relationship: "dependency" });
			}
			const internalEdges = rootEntry.containerDependencies.filter((dependency) => !dependency.external && !dependency.missing);
			const adjacency = new Map<string, string[]>();
			for (const dependency of internalEdges) {
				adjacency.set(dependency.sourcePath, [...(adjacency.get(dependency.sourcePath) ?? []), dependency.targetPath]);
			}
			const state = new Map<string, 0 | 1 | 2>();
			const stack: string[] = [];
			const found = new Map<string, string[]>();
			const visit = (path: string): void => {
				if (state.get(path) === 2) {
					return;
				}
				if (state.get(path) === 1) {
					const start = stack.indexOf(path);
					const body = stack.slice(start);
					const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
					rotations.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
					const canonical = [...rotations[0], rotations[0][0]].map(virtualPath);
					found.set(canonical.join("\0"), canonical);
					return;
				}
				state.set(path, 1);
				stack.push(path);
				for (const target of adjacency.get(path) ?? []) {
					visit(target);
				}
				stack.pop();
				state.set(path, 2);
			};
			memberPaths.forEach(visit);
			archiveCycles.push(...[...found.values()].sort((a, b) => a.join("\0").localeCompare(b.join("\0"))));
		}
	}
	const visiblePaths = new Set(nodes.keys());
	const cycles = [
		...dependencyCycles(registry.entries).filter((cycle) => cycle.slice(0, -1).every((path) => visiblePaths.has(path))),
		...archiveCycles.filter((cycle) => cycle.slice(0, -1).every((path) => visiblePaths.has(path))),
	];
	const cyclicEdges = new Set<string>();
	for (const cycle of cycles) {
		for (let index = 0; index < cycle.length - 1; index++) {
			cyclicEdges.add(`${cycle[index]}\0${cycle[index + 1]}`);
		}
	}
	for (const edge of edges) {
		edge.cyclic = cyclicEdges.has(`${edge.sourcePath}\0${edge.targetPath}`);
	}
	return {
		rootPath,
		direction,
		depth,
		nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
		edges,
		cycles,
		truncated,
		limit,
	};
}

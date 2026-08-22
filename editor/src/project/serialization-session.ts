import { readJSON, writeJSON } from "fs-extra";
import { basename, extname } from "path/posix";

import packageJson from "../../package.json";

export const currentEditorSerializationVersion = packageJson.version;

export type SerializedVersionSource = "serialization-marker" | "project-editor-version" | "numeric-document-version" | "legacy-unversioned";

export interface ISerializationSessionEntry {
	path: string;
	kind: string;
	version: string;
	versionSource: SerializedVersionSource;
	currentVersion: string;
	isCurrent: boolean;
	loadCount: number;
	firstLoadedAt: string;
	lastLoadedAt: string;
}

export interface ISerializationSessionSnapshot {
	version: 1;
	revision: number;
	startedAt: string;
	loadedFileCount: number;
	totalLoadCount: number;
	oldest: ISerializationSessionEntry | null;
	entries: ISerializationSessionEntry[];
	pagination: { offset: number; limit: number; total: number; hasMore: boolean; nextOffset: number | null };
	truncated: boolean;
}

interface IVersionEvidence {
	version: string;
	source: SerializedVersionSource;
	rank: number[];
}

const maximumFiles = 4_096;
const maximumPageSize = 500;
const startedAt = new Date().toISOString();
const entries = new Map<string, ISerializationSessionEntry & { rank: number[] }>();
let revision = 0;
let totalLoadCount = 0;
let truncated = false;
let publisher: ((snapshot: ISerializationSessionSnapshot) => void) | null = null;

function increment(value: number): number {
	return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function versionRank(value: string, legacy = false): number[] {
	if (legacy) {
		return [-1];
	}
	const components = value
		.split(/[.+-]/)
		.slice(0, 8)
		.map((part) => (/^\d+$/.test(part) ? Math.min(Number(part), Number.MAX_SAFE_INTEGER) : 0));
	return [0, ...components, ...Array(Math.max(0, 8 - components.length)).fill(0)];
}

function compareRank(left: number[], right: number[]): number {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference) {
			return difference;
		}
	}
	return 0;
}

function evidenceFor(path: string, value: unknown): IVersionEvidence {
	const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	if (
		(typeof record.serializationVersion === "string" && record.serializationVersion.trim()) ||
		(typeof record.serializationVersion === "number" && Number.isFinite(record.serializationVersion))
	) {
		const version = String(record.serializationVersion);
		return { version, source: "serialization-marker", rank: versionRank(version) };
	}
	if (extname(path).toLowerCase() === ".bjseditor" && typeof record.version === "string" && record.version.trim()) {
		return { version: record.version, source: "project-editor-version", rank: versionRank(record.version) };
	}
	if (typeof record.version === "number" && Number.isFinite(record.version) && record.version >= 0) {
		const version = String(record.version);
		return { version, source: "numeric-document-version", rank: versionRank(version) };
	}
	return { version: "legacy-unversioned", source: "legacy-unversioned", rank: versionRank("0", true) };
}

function sortedEntries(): Array<ISerializationSessionEntry & { rank: number[] }> {
	return [...entries.values()].sort((left, right) => compareRank(left.rank, right.rank) || left.path.localeCompare(right.path));
}

function publish(): void {
	publisher?.(getSerializationSessionDiagnostics());
}

/** Registers one JSON document that was actually read by the editor during this process session. */
export function recordSerializedFileLoaded(path: string, value: unknown, kind = "json"): ISerializationSessionSnapshot {
	if (typeof path !== "string" || !path.trim() || path.length > 4_096) {
		throw new Error("Serialized file paths must be non-empty strings of at most 4096 characters.");
	}
	const normalizedPath = path.replace(/\\/g, "/");
	const now = new Date().toISOString();
	const evidence = evidenceFor(normalizedPath, value);
	const existing = entries.get(normalizedPath);
	totalLoadCount = increment(totalLoadCount);
	if (existing) {
		existing.loadCount = increment(existing.loadCount);
		existing.lastLoadedAt = now;
		existing.kind = kind.slice(0, 128);
		existing.version = evidence.version;
		existing.versionSource = evidence.source;
		existing.rank = evidence.rank;
		existing.isCurrent = evidence.version === currentEditorSerializationVersion;
	} else if (entries.size < maximumFiles) {
		entries.set(normalizedPath, {
			path: normalizedPath,
			kind: kind.slice(0, 128),
			version: evidence.version,
			versionSource: evidence.source,
			currentVersion: currentEditorSerializationVersion,
			isCurrent: evidence.version === currentEditorSerializationVersion,
			loadCount: 1,
			firstLoadedAt: now,
			lastLoadedAt: now,
			rank: evidence.rank,
		});
	} else {
		truncated = true;
	}
	revision = increment(revision);
	const snapshot = getSerializationSessionDiagnostics();
	publish();
	return snapshot;
}

/** Reads and records one editor-owned JSON document. */
export async function readSerializedJSON<T = any>(path: string, options?: unknown): Promise<T> {
	const value = (await readJSON(path, options as any)) as T;
	recordSerializedFileLoaded(path, value, basename(path));
	return value;
}

/** Writes one editor-owned JSON document with the current explicit serialization marker. */
export async function writeSerializedJSON(path: string, value: unknown, options?: unknown): Promise<void> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Serialized JSON publication requires an object root: ${path}`);
	}
	await writeJSON(path, { ...(value as Record<string, unknown>), serializationVersion: currentEditorSerializationVersion }, options as any);
}

/** Reads one stable bounded page and always reports the true oldest loaded file separately. */
export function getSerializationSessionDiagnostics(options: { offset?: number; limit?: number } = {}): ISerializationSessionSnapshot {
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 100;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) {
		throw new Error(`Serialization diagnostics require offset >= 0 and limit from 1 through ${maximumPageSize}.`);
	}
	const sorted = sortedEntries();
	const copy = (entry: ISerializationSessionEntry & { rank: number[] }): ISerializationSessionEntry => {
		const { rank: _rank, ...result } = entry;
		return { ...result };
	};
	return {
		version: 1,
		revision,
		startedAt,
		loadedFileCount: sorted.length,
		totalLoadCount,
		oldest: sorted[0] ? copy(sorted[0]) : null,
		entries: sorted.slice(offset, offset + limit).map(copy),
		pagination: { offset, limit, total: sorted.length, hasMore: offset + limit < sorted.length, nextOffset: offset + limit < sorted.length ? offset + limit : null },
		truncated,
	};
}

/** Publishes session snapshots to Electron main without coupling pure tracking/tests to Electron. */
export function setSerializationSessionPublisher(nextPublisher: ((snapshot: ISerializationSessionSnapshot) => void) | null): void {
	publisher = nextPublisher;
	publish();
}

export function formatSerializationSessionShutdownLog(snapshot = getSerializationSessionDiagnostics()): string {
	return snapshot.oldest
		? `[Serialization] Editor session loaded ${snapshot.loadedFileCount} serialized files (${snapshot.totalLoadCount} reads). Oldest loaded version: ${snapshot.oldest.version} (${snapshot.oldest.path}).`
		: "[Serialization] Editor session loaded no serialized files.";
}

/** Test-only reset for the process singleton. */
export function resetSerializationSessionDiagnosticsForTests(): void {
	entries.clear();
	revision = 0;
	totalLoadCount = 0;
	truncated = false;
}

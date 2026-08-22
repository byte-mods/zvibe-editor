import { createHash, randomUUID } from "crypto";
import { dirname, join, normalize, relative } from "path/posix";

import type { Dirent } from "fs";
import { ensureDir, move, pathExists, readFile, readJSON, readdir, remove, writeFile, writeJSON } from "fs-extra";

import { projectConfiguration } from "../../project/configuration";
import { createDefaultProjectSettings, validateProjectSettings } from "../../project/settings";
import { IEditorImportAcceleratorSettings } from "../../project/typings";

export type ImportAcceleratorArtifactKind = "texture" | "model" | "alembic" | "aseprite" | "audio" | "video" | "font" | "material" | "animation";
export type ImportAcceleratorOutcome = "bypass" | "hit" | "miss" | "error";

export interface IImportAcceleratorArtifactStatus {
	path: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
}

export interface IImportAcceleratorActivity {
	id: string;
	kind: ImportAcceleratorArtifactKind;
	cacheKey: string;
	fingerprint: string;
	outcome: ImportAcceleratorOutcome;
	startedAt: string;
	completedAt: string;
	downloadedBytes: number;
	uploadedBytes: number;
	message?: string;
}

export interface IImportAcceleratorDiagnostics {
	version: 1;
	revision: number;
	counters: { hits: number; misses: number; bypasses: number; errors: number; downloadedBytes: number; uploadedBytes: number };
	activities: IImportAcceleratorActivity[];
}

interface IImportAcceleratorFile {
	path: string;
	bytes: number;
	sha256: string;
	portableJson: boolean;
}

interface IImportAcceleratorManifest {
	version: 1;
	kind: ImportAcceleratorArtifactKind;
	importerVersion: 1;
	platform: string;
	fingerprint: string;
	cacheKey: string;
	createdAt: string;
	files: IImportAcceleratorFile[];
}

export interface IApplyImporterArtifactWithAcceleratorOptions<T extends IImportAcceleratorArtifactStatus> {
	kind: ImportAcceleratorArtifactKind;
	sourcePath: string;
	expectedFingerprint: string;
	platform?: string;
	inspect: () => Promise<T>;
	applyLocal: () => Promise<T>;
}

interface IImportAcceleratorTransferContext {
	configuration: IEditorImportAcceleratorSettings;
	kind: ImportAcceleratorArtifactKind;
	platform: string;
	fingerprint: string;
	key: string;
	artifactDirectory: string;
	sourcePath: string;
}

const importerVersion = 1 as const;
const manifestVersion = 1 as const;
const maximumFiles = 4096;
const maximumActivities = 256;
const contentHashHeader = "x-zvibe-content-sha256";
const inFlight = new Map<string, Promise<IImportAcceleratorArtifactStatus>>();
let diagnosticsQueue: Promise<void> = Promise.resolve();

function settings(): IEditorImportAcceleratorSettings {
	return structuredClone(projectConfiguration.importAccelerator ?? createDefaultProjectSettings().assetPipeline.accelerator);
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function diagnosticsPath(): string {
	return join(projectDirectory(), ".bjseditor/import-accelerator-status.json");
}

function emptyDiagnostics(): IImportAcceleratorDiagnostics {
	return { version: 1, revision: 0, counters: { hits: 0, misses: 0, bypasses: 0, errors: 0, downloadedBytes: 0, uploadedBytes: 0 }, activities: [] };
}

function hash(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fetchBody(bytes: Buffer): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function cacheKey(kind: ImportAcceleratorArtifactKind, fingerprint: string, platform: string): string {
	return hash(JSON.stringify({ contract: "zvibe-import-accelerator-v1", kind, importerVersion, platform, fingerprint }));
}

function stalePlanError(kind: ImportAcceleratorArtifactKind, currentFingerprint: string): Error {
	return new Error(`${kind[0].toUpperCase()}${kind.slice(1)} importer plan changed. Inspect again and use current fingerprint ${currentFingerprint}.`);
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replace(/%2F/gi, "%252F");
}

function endpointPath(configuration: IEditorImportAcceleratorSettings, path: string): string {
	return `${configuration.endpoint.replace(/\/+$/, "")}${path}`;
}

function requestHeaders(configuration: IEditorImportAcceleratorSettings, contentType?: string): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json, application/octet-stream" };
	if (contentType) {
		headers["content-type"] = contentType;
	}
	if (configuration.authenticationEnvironmentVariable) {
		const token = process.env[configuration.authenticationEnvironmentVariable];
		if (!token) {
			throw new Error(`Import Accelerator authentication environment variable "${configuration.authenticationEnvironmentVariable}" is not set.`);
		}
		headers.authorization = `Bearer ${token}`;
	}
	return headers;
}

async function request(configuration: IEditorImportAcceleratorSettings, path: string, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), configuration.requestTimeoutMilliseconds);
	try {
		return await fetch(endpointPath(configuration, path), { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function verifyAttestation(configuration: IEditorImportAcceleratorSettings, response: Response, expectedHash: string, direction: "download" | "upload"): void {
	if (configuration.contentValidation === "disabled" || (configuration.contentValidation === "uploadOnly" && direction === "download")) {
		return;
	}
	const actual = response.headers.get(contentHashHeader);
	const required = configuration.contentValidation === "required" || (configuration.contentValidation === "uploadOnly" && direction === "upload");
	if (!actual && required) {
		throw new Error(`Import Accelerator ${direction} response is missing required ${contentHashHeader} attestation.`);
	}
	if (actual && actual.toLowerCase() !== expectedHash) {
		throw new Error(`Import Accelerator ${direction} content attestation does not match the verified payload.`);
	}
}

function assertSuccessful(response: Response, operation: string): void {
	if (!response.ok) {
		throw new Error(`Import Accelerator ${operation} failed with HTTP ${response.status}.`);
	}
}

function safeRelativePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
		throw new Error("Import Accelerator manifest contains an invalid artifact path.");
	}
	const result = normalize(value);
	if (
		result === "." ||
		result.startsWith("/") ||
		result === ".." ||
		result.startsWith("../") ||
		result.split("/").some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("Import Accelerator manifest path escapes the artifact directory.");
	}
	return result;
}

function assertInside(directory: string, path: string): void {
	const result = relative(directory, path);
	if (!result || result.startsWith("../") || result === ".." || result.startsWith("/")) {
		throw new Error("Import Accelerator artifact path escapes its destination.");
	}
}

function portableValue(value: unknown, artifactDirectory: string, sourcePath: string): unknown {
	if (typeof value === "string") {
		return value.split(artifactDirectory).join("$ARTIFACT_ROOT").split(sourcePath).join("$SOURCE_PATH");
	}
	if (Array.isArray(value)) {
		return value.map((entry) => portableValue(entry, artifactDirectory, sourcePath));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, portableValue(entry, artifactDirectory, sourcePath)]));
	}
	return value;
}

function restoredValue(value: unknown, artifactDirectory: string, sourcePath: string): unknown {
	if (typeof value === "string") {
		return value.split("$ARTIFACT_ROOT").join(artifactDirectory).split("$SOURCE_PATH").join(sourcePath);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => restoredValue(entry, artifactDirectory, sourcePath));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoredValue(entry, artifactDirectory, sourcePath)]));
	}
	return value;
}

async function portableBytes(path: string, artifactDirectory: string, sourcePath: string): Promise<{ bytes: Buffer; portableJson: boolean }> {
	const bytes = await readFile(path);
	if (!path.toLowerCase().endsWith(".json")) {
		return { bytes, portableJson: false };
	}
	try {
		const parsed = JSON.parse(bytes.toString("utf-8"));
		return { bytes: Buffer.from(`${JSON.stringify(portableValue(parsed, artifactDirectory, sourcePath), null, "\t")}\n`), portableJson: true };
	} catch {
		return { bytes, portableJson: false };
	}
}

async function artifactFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	const visit = async (current: string): Promise<void> => {
		const entries = (await readdir(current, { withFileTypes: true })) as Dirent[];
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error("Import Accelerator artifacts may not contain symbolic links.");
			}
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile()) {
				result.push(path);
			} else {
				throw new Error("Import Accelerator artifacts may contain only regular files and directories.");
			}
			if (result.length > maximumFiles) {
				throw new Error(`Import Accelerator artifacts may contain at most ${maximumFiles} files.`);
			}
		}
	};
	await visit(directory);
	return result.sort();
}

async function buildManifest(context: IImportAcceleratorTransferContext): Promise<{ manifest: IImportAcceleratorManifest; blobs: Map<string, Buffer>; bytes: number }> {
	const { configuration, kind, platform, fingerprint, key, artifactDirectory, sourcePath } = context;
	const files: IImportAcceleratorFile[] = [];
	const blobs = new Map<string, Buffer>();
	let total = 0;
	for (const path of await artifactFiles(artifactDirectory)) {
		const portable = await portableBytes(path, artifactDirectory, sourcePath);
		total += portable.bytes.byteLength;
		if (total > configuration.maximumResultSizeBytes) {
			throw new Error(`Import Accelerator artifact exceeds the ${configuration.maximumResultSizeBytes}-byte project limit.`);
		}
		const sha256 = hash(portable.bytes);
		blobs.set(sha256, portable.bytes);
		files.push({ path: safeRelativePath(relative(artifactDirectory, path)), bytes: portable.bytes.byteLength, sha256, portableJson: portable.portableJson });
	}
	return {
		manifest: { version: manifestVersion, kind, importerVersion, platform, fingerprint, cacheKey: key, createdAt: new Date().toISOString(), files },
		blobs,
		bytes: total,
	};
}

function validateManifest(
	value: unknown,
	configuration: IEditorImportAcceleratorSettings,
	kind: ImportAcceleratorArtifactKind,
	platform: string,
	fingerprint: string,
	key: string
): IImportAcceleratorManifest {
	const manifest = value as Partial<IImportAcceleratorManifest>;
	if (
		!manifest ||
		typeof manifest !== "object" ||
		manifest.version !== manifestVersion ||
		manifest.importerVersion !== importerVersion ||
		manifest.kind !== kind ||
		manifest.platform !== platform ||
		manifest.fingerprint !== fingerprint ||
		manifest.cacheKey !== key ||
		!Array.isArray(manifest.files) ||
		manifest.files.length > maximumFiles
	) {
		throw new Error("Import Accelerator returned an incompatible manifest.");
	}
	let total = 0;
	const paths = new Set<string>();
	const files = manifest.files.map((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.bytes !== "number" ||
			!Number.isSafeInteger(entry.bytes) ||
			entry.bytes < 0 ||
			entry.bytes > configuration.maximumResultSizeBytes ||
			typeof entry.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			typeof entry.portableJson !== "boolean"
		) {
			throw new Error("Import Accelerator manifest contains an invalid file record.");
		}
		const path = safeRelativePath(entry.path);
		const pathKey = path.toLocaleLowerCase("en-US");
		if (paths.has(pathKey)) {
			throw new Error("Import Accelerator manifest contains duplicate artifact paths.");
		}
		paths.add(pathKey);
		total += entry.bytes;
		if (total > configuration.maximumResultSizeBytes) {
			throw new Error(`Import Accelerator result exceeds the ${configuration.maximumResultSizeBytes}-byte project limit.`);
		}
		return { path, bytes: entry.bytes, sha256: entry.sha256, portableJson: entry.portableJson };
	});
	return { ...(manifest as IImportAcceleratorManifest), files };
}

function manifestRequestPath(configuration: IEditorImportAcceleratorSettings, kind: ImportAcceleratorArtifactKind, key: string): string {
	return `/v1/import-results/${encodePathSegment(configuration.namespacePrefix)}/${kind}/${key}/manifest`;
}

function blobRequestPath(sha256: string): string {
	return `/v1/blobs/${sha256}`;
}

async function downloadManifest(
	configuration: IEditorImportAcceleratorSettings,
	kind: ImportAcceleratorArtifactKind,
	platform: string,
	fingerprint: string,
	key: string
): Promise<IImportAcceleratorManifest | null> {
	const response = await request(configuration, manifestRequestPath(configuration, kind, key), { headers: requestHeaders(configuration) });
	if (response.status === 404) {
		return null;
	}
	assertSuccessful(response, "manifest download");
	const bytes = Buffer.from(await response.arrayBuffer());
	verifyAttestation(configuration, response, hash(bytes), "download");
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf-8"));
	} catch {
		throw new Error("Import Accelerator returned malformed manifest JSON.");
	}
	return validateManifest(value, configuration, kind, platform, fingerprint, key);
}

async function mapInBatches<T>(items: T[], batchSize: number, handler: (item: T) => Promise<void>): Promise<void> {
	for (let offset = 0; offset < items.length; offset += batchSize) {
		await Promise.all(items.slice(offset, offset + batchSize).map(handler));
	}
}

async function restoreArtifact<T extends IImportAcceleratorArtifactStatus>(
	configuration: IEditorImportAcceleratorSettings,
	manifest: IImportAcceleratorManifest,
	artifactDirectory: string,
	sourcePath: string,
	inspect: () => Promise<T>
): Promise<{ status: T; downloadedBytes: number }> {
	const staging = `${artifactDirectory}.accelerator-download-${process.pid}-${randomUUID()}`;
	const backup = `${artifactDirectory}.accelerator-backup-${process.pid}-${randomUUID()}`;
	let downloadedBytes = 0;
	await remove(staging);
	await ensureDir(staging);
	try {
		await mapInBatches(manifest.files, configuration.downloadBatchSize, async (entry) => {
			const response = await request(configuration, blobRequestPath(entry.sha256), { headers: requestHeaders(configuration) });
			assertSuccessful(response, `blob ${entry.sha256} download`);
			const portable = Buffer.from(await response.arrayBuffer());
			if (portable.byteLength !== entry.bytes || hash(portable) !== entry.sha256) {
				throw new Error(`Import Accelerator blob ${entry.sha256} failed local length or SHA-256 validation.`);
			}
			verifyAttestation(configuration, response, entry.sha256, "download");
			let bytes = portable;
			if (entry.portableJson) {
				const parsed = JSON.parse(portable.toString("utf-8"));
				bytes = Buffer.from(`${JSON.stringify(restoredValue(parsed, artifactDirectory, sourcePath), null, "\t")}\n`);
			}
			const destination = join(staging, entry.path);
			assertInside(staging, destination);
			await ensureDir(dirname(destination));
			await writeFile(destination, bytes);
			downloadedBytes += portable.byteLength;
		});
		const existed = await pathExists(artifactDirectory);
		if (existed) {
			await move(artifactDirectory, backup, { overwrite: true });
		}
		try {
			await ensureDir(dirname(artifactDirectory));
			await move(staging, artifactDirectory, { overwrite: true });
			const status = await inspect();
			if (!status.current || status.fingerprint !== manifest.fingerprint) {
				throw new Error("Import Accelerator restored artifact failed the importer fingerprint lease check.");
			}
			await remove(backup);
			return { status, downloadedBytes };
		} catch (error) {
			await remove(artifactDirectory);
			if (await pathExists(backup)) {
				await move(backup, artifactDirectory, { overwrite: true });
			}
			throw error;
		}
	} finally {
		await remove(staging);
	}
}

async function uploadArtifact(context: IImportAcceleratorTransferContext): Promise<number> {
	const { configuration, kind, key } = context;
	const packaged = await buildManifest(context);
	for (const [sha256, bytes] of packaged.blobs) {
		const response = await request(configuration, blobRequestPath(sha256), {
			method: "PUT",
			headers: { ...requestHeaders(configuration, "application/octet-stream"), [contentHashHeader]: sha256, "content-length": String(bytes.byteLength) },
			body: fetchBody(bytes),
		});
		assertSuccessful(response, `blob ${sha256} upload`);
		verifyAttestation(configuration, response, sha256, "upload");
	}
	const manifestBytes = Buffer.from(JSON.stringify(packaged.manifest));
	const manifestHash = hash(manifestBytes);
	const response = await request(configuration, manifestRequestPath(configuration, kind, key), {
		method: "PUT",
		headers: { ...requestHeaders(configuration, "application/json"), [contentHashHeader]: manifestHash, "content-length": String(manifestBytes.byteLength) },
		body: fetchBody(manifestBytes),
	});
	assertSuccessful(response, "manifest upload");
	verifyAttestation(configuration, response, manifestHash, "upload");
	return packaged.bytes + manifestBytes.byteLength;
}

function sanitizedMessage(error: unknown, configuration: IEditorImportAcceleratorSettings): string {
	let message = error instanceof Error ? error.message : String(error);
	const token = configuration.authenticationEnvironmentVariable ? process.env[configuration.authenticationEnvironmentVariable] : undefined;
	if (token) {
		message = message.split(token).join("[redacted]");
	}
	return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 2048);
}

async function readDiagnostics(): Promise<IImportAcceleratorDiagnostics> {
	try {
		const value = (await readJSON(diagnosticsPath())) as IImportAcceleratorDiagnostics;
		if (value?.version === 1 && Number.isSafeInteger(value.revision) && value.counters && Array.isArray(value.activities)) {
			return value;
		}
	} catch {
		// Missing and malformed diagnostic snapshots both recover to a bounded empty store.
	}
	return emptyDiagnostics();
}

async function recordActivity(activity: IImportAcceleratorActivity): Promise<void> {
	const operation = diagnosticsQueue.then(async () => {
		const diagnostics = await readDiagnostics();
		diagnostics.revision++;
		diagnostics.activities = [activity, ...diagnostics.activities].slice(0, maximumActivities);
		diagnostics.counters.downloadedBytes += activity.downloadedBytes;
		diagnostics.counters.uploadedBytes += activity.uploadedBytes;
		if (activity.outcome === "hit") {
			diagnostics.counters.hits++;
		}
		if (activity.outcome === "miss") {
			diagnostics.counters.misses++;
		}
		if (activity.outcome === "bypass") {
			diagnostics.counters.bypasses++;
		}
		if (activity.outcome === "error") {
			diagnostics.counters.errors++;
		}
		const path = diagnosticsPath();
		const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
		await ensureDir(dirname(path));
		await writeJSON(temporary, diagnostics, { spaces: "\t" });
		await move(temporary, path, { overwrite: true });
	});
	diagnosticsQueue = operation.catch(() => undefined);
	await diagnosticsQueue;
}

function activity(value: Omit<IImportAcceleratorActivity, "id" | "completedAt">): IImportAcceleratorActivity {
	return {
		id: randomUUID(),
		...value,
		completedAt: new Date().toISOString(),
	};
}

async function execute<T extends IImportAcceleratorArtifactStatus>(
	options: IApplyImporterArtifactWithAcceleratorOptions<T>,
	configuration: IEditorImportAcceleratorSettings
): Promise<T> {
	const platform = options.platform ?? "default";
	const key = cacheKey(options.kind, options.expectedFingerprint, platform);
	const startedAt = new Date().toISOString();
	const initial = await options.inspect();
	if (initial.fingerprint !== options.expectedFingerprint) {
		throw stalePlanError(options.kind, initial.fingerprint);
	}
	const artifactDirectory = dirname(initial.manifestPath);
	if (!configuration.enabled) {
		const result = await options.applyLocal();
		await recordActivity(
			activity({ kind: options.kind, cacheKey: key, fingerprint: options.expectedFingerprint, startedAt, outcome: "bypass", downloadedBytes: 0, uploadedBytes: 0 })
		);
		return result;
	}

	let downloadedBytes = 0;
	let uploadedBytes = 0;
	let cacheError: unknown = null;
	if (configuration.downloadEnabled) {
		try {
			const manifest = await downloadManifest(configuration, options.kind, platform, options.expectedFingerprint, key);
			if (manifest) {
				const restored = await restoreArtifact(configuration, manifest, artifactDirectory, options.sourcePath, options.inspect);
				downloadedBytes = restored.downloadedBytes;
				await recordActivity(
					activity({ kind: options.kind, cacheKey: key, fingerprint: options.expectedFingerprint, startedAt, outcome: "hit", downloadedBytes, uploadedBytes: 0 })
				);
				return restored.status;
			}
		} catch (error) {
			cacheError = error;
		}
	}

	const result = await options.applyLocal();
	if (result.fingerprint !== options.expectedFingerprint || !result.current) {
		throw new Error(`Local ${options.kind} importer did not satisfy the expected fingerprint lease.`);
	}
	if (configuration.uploadEnabled) {
		try {
			uploadedBytes = await uploadArtifact({
				configuration,
				kind: options.kind,
				platform,
				fingerprint: options.expectedFingerprint,
				key,
				artifactDirectory: dirname(result.manifestPath),
				sourcePath: options.sourcePath,
			});
		} catch (error) {
			cacheError ??= error;
		}
	}
	await recordActivity(
		activity({
			kind: options.kind,
			cacheKey: key,
			fingerprint: options.expectedFingerprint,
			startedAt,
			outcome: cacheError ? "error" : "miss",
			downloadedBytes,
			uploadedBytes,
			...(cacheError ? { message: sanitizedMessage(cacheError, configuration) } : {}),
		})
	);
	return result;
}

/** Applies one exact-fingerprint artifact through the shared cache, failing open to the local importer without weakening validation. */
export async function applyImporterArtifactWithAccelerator<T extends IImportAcceleratorArtifactStatus>(options: IApplyImporterArtifactWithAcceleratorOptions<T>): Promise<T> {
	const configuration = settings();
	const initial = await options.inspect();
	if (initial.fingerprint !== options.expectedFingerprint) {
		throw stalePlanError(options.kind, initial.fingerprint);
	}
	const key = `${cacheKey(options.kind, options.expectedFingerprint, options.platform ?? "default")}:${dirname(initial.manifestPath)}`;
	const existing = inFlight.get(key);
	if (existing) {
		return (await existing) as T;
	}
	const operation = execute(options, configuration);
	inFlight.set(key, operation);
	try {
		return await operation;
	} finally {
		inFlight.delete(key);
	}
}

export function getImportAcceleratorCapabilities(): any {
	return {
		version: 1,
		protocol: "zvibe-import-accelerator-v1",
		artifactKinds: ["texture", "model", "audio", "video", "font", "material", "animation"],
		features: {
			disabledByDefault: true,
			contentAddressedBlobs: true,
			portableJsonRebasing: true,
			exactFingerprintLeases: true,
			atomicRollback: true,
			boundedDiagnostics: true,
		},
	};
}

export function getImportAcceleratorConfiguration(): any {
	const configuration = settings();
	return {
		configuration,
		authenticationConfigured: Boolean(configuration.authenticationEnvironmentVariable),
		authenticationAvailable: Boolean(configuration.authenticationEnvironmentVariable && process.env[configuration.authenticationEnvironmentVariable]),
	};
}

export async function checkImportAcceleratorConnection(configurationOverride?: IEditorImportAcceleratorSettings): Promise<any> {
	const configuration = structuredClone(configurationOverride ?? settings());
	const startedAt = Date.now();
	try {
		const validationSettings = createDefaultProjectSettings();
		validationSettings.assetPipeline.accelerator = configuration;
		validateProjectSettings(validationSettings);
		const response = await request(configuration, "/v1/health", { headers: requestHeaders(configuration) });
		assertSuccessful(response, "connection check");
		return { connected: true, status: response.status, latencyMilliseconds: Date.now() - startedAt };
	} catch (error) {
		return { connected: false, latencyMilliseconds: Date.now() - startedAt, error: sanitizedMessage(error, configuration) };
	}
}

export async function getImportAcceleratorDiagnostics(
	data: { offset?: number; limit?: number; kind?: ImportAcceleratorArtifactKind; outcome?: ImportAcceleratorOutcome } = {}
): Promise<any> {
	const diagnostics = await readDiagnostics();
	const offset = Math.max(0, Math.trunc(data.offset ?? 0));
	const limit = Math.max(1, Math.min(100, Math.trunc(data.limit ?? 50)));
	const matching = diagnostics.activities.filter((entry) => (!data.kind || entry.kind === data.kind) && (!data.outcome || entry.outcome === data.outcome));
	return {
		version: diagnostics.version,
		revision: diagnostics.revision,
		counters: diagnostics.counters,
		offset,
		limit,
		total: matching.length,
		activities: matching.slice(offset, offset + limit),
	};
}

export async function clearImportAcceleratorDiagnostics(expectedRevision: number, confirm: boolean): Promise<any> {
	if (!confirm) {
		throw new Error("clear_import_accelerator_diagnostics requires confirm=true.");
	}
	const operation = diagnosticsQueue.then(async () => {
		const current = await readDiagnostics();
		if (current.revision !== expectedRevision) {
			throw new Error(`Stale Import Accelerator diagnostics revision ${expectedRevision}; current revision is ${current.revision}.`);
		}
		const cleared = emptyDiagnostics();
		cleared.revision = current.revision + 1;
		const path = diagnosticsPath();
		const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
		await ensureDir(dirname(path));
		await writeJSON(temporary, cleared, { spaces: "\t" });
		await move(temporary, path, { overwrite: true });
	});
	diagnosticsQueue = operation.catch(() => undefined);
	await operation;
	return getImportAcceleratorDiagnostics();
}

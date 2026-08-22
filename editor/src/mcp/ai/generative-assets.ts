import { ChildProcess, spawn } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { mkdir, realpath } from "fs/promises";
import { dirname, extname, join } from "path";

import { ensureDir, lstat, move, readFile, readdir, remove, writeFile } from "fs-extra";
import { Observable, Scene } from "babylonjs";
import stripAnsi from "strip-ansi";
import {
	GENERATIVE_ASSET_CONTRACT,
	GENERATIVE_ASSET_CONTRACT_VERSION,
	IGenerativeAssetProviderRequestEnvelope,
	IGenerativeAssetRequest,
	IGenerativeAssetResolvedReference,
	maximumGenerativeReferenceBytes,
	maximumGenerativeOutputBytes,
	normalizeGenerativeAssetProviderResult,
	normalizeGenerativeAssetRequest,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { ensureProjectStoreDirectory, inspectProjectStoreDirectory, projectPathContains } from "../project/project-store";
import {
	deleteGenerativeAssetProvider,
	getGenerativeAssetProvidersChangedObservable,
	IGenerativeAssetProviderDescriptor,
	readGenerativeAssetProviderInventory,
	setGenerativeAssetProvider,
} from "./generative-providers";
import {
	IValidatedGenerativeArtifact,
	IValidatedGenerativeCandidate,
	materializeGenerativeProviderResult,
	readGenerativeProviderResultManifest,
	validateGenerativeProviderOutput,
} from "./generative-validation";
import {
	IGenerativeAssetPublicationJobLease,
	IGenerativeAssetPublicationRecord,
	inspectGenerativeAssetPublication,
	maximumGenerativeAssetPublicationRecords,
	normalizeGenerativeAssetPublicationRecord,
	publishGenerativeAssetCandidate,
} from "./generative-publication";

const maximumRetainedJobs = 64;
const maximumQueuedJobs = 8;
const maximumConcurrentJobs = 2;
const maximumReferenceFileBytes = 32 * 1024 * 1024;
const maximumDiagnosticBytes = 64 * 1024;
const maximumHttpOutputBytes = 64 * 1024 * 1024;
const maximumPreviewBytes = 8 * 1024 * 1024;
const maximumPersistedJobBytes = 1024 * 1024;
const jobIdPattern = /^generative-job-[a-f0-9]{24}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;

export type GenerativeAssetJobStatus = "queued" | "running" | "canceling" | "succeeded" | "failed" | "canceled" | "timed-out";

export interface IGenerativeAssetJobSnapshot {
	id: string;
	revision: number;
	status: GenerativeAssetJobStatus;
	provider: {
		id: string;
		name: string;
		vendor: string;
		classification: IGenerativeAssetProviderDescriptor["classification"];
		fingerprint: string;
		transport: "executable" | "http";
	};
	request: IGenerativeAssetRequest;
	requestFingerprint: string;
	references: Array<Omit<IGenerativeAssetResolvedReference, "localPath" | "dataBase64">>;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	attempt: number;
	sourceJobId: string | null;
	progress: { phase: string; message: string };
	cancelRequested: boolean;
	resultFingerprint: string | null;
	outputBytes: number;
	candidates: IValidatedGenerativeCandidate[];
	publications: IGenerativeAssetPublicationRecord[];
	execution: {
		durationMilliseconds: number | null;
		exitCode: number | null;
		httpStatus: number | null;
		diagnostics: string;
		diagnosticsTruncated: boolean;
	};
	error: string | null;
}

interface IInternalReference {
	evidence: Omit<IGenerativeAssetResolvedReference, "localPath" | "dataBase64">;
	absolutePath: string;
}

interface IInternalGenerativeJob {
	snapshot: IGenerativeAssetJobSnapshot;
	root: string;
	directory: string;
	outputDirectory: string;
	provider: IGenerativeAssetProviderDescriptor | null;
	controller: AbortController | null;
	child: ChildProcess | null;
	secretValues: string[];
	timedOut: boolean;
	rawDiagnostics: string;
	rawDiagnosticsTruncated: boolean;
	publicationActive: boolean;
	persistTail: Promise<void>;
}

interface IGenerativeAssetEditorState {
	projectRoot: string | null;
	loadedRoot: string | null;
	loadPromise: Promise<void> | null;
	jobs: Map<string, IInternalGenerativeJob>;
	loadErrors: Array<{ path: string; error: string }>;
	activeCount: number;
	activePromises: Set<Promise<void>>;
	activePublications: Set<Promise<unknown>>;
	changed: Observable<void>;
	disposed: boolean;
}

const states = new WeakMap<object, IGenerativeAssetEditorState>();
const activeStates = new Set<IGenerativeAssetEditorState>();

// Provider manifests are process-scoped, so one observer fans changes out to every live editor owner without accumulating one-shot subscriptions per render.
getGenerativeAssetProvidersChangedObservable().add(() => {
	for (const editorState of activeStates) {
		editorState.changed.notifyObservers();
	}
});

function stateOwner(editor: Editor): object {
	return editor.sceneWorkspace ?? editor;
}

function state(editor: Editor): IGenerativeAssetEditorState {
	const owner = stateOwner(editor);
	let value = states.get(owner);
	if (!value || value.disposed) {
		value = {
			projectRoot: null,
			loadedRoot: null,
			loadPromise: null,
			jobs: new Map(),
			loadErrors: [],
			activeCount: 0,
			activePromises: new Set(),
			activePublications: new Set(),
			changed: new Observable<void>(),
			disposed: false,
		};
		states.set(owner, value);
		activeStates.add(value);
	}
	return value;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)])
		);
	}
	return value;
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Removes Editor HTTP bridge metadata before closed feature-contract validation. */
function bridgePayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const payload = { ...(value as Record<string, unknown>) };
	delete payload.endpoint;
	delete payload.collaborationToken;
	return payload;
}

function publicJob(job: IInternalGenerativeJob): IGenerativeAssetJobSnapshot {
	return clone(job.snapshot);
}

function cleanText(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
			result += value[index];
		}
	}
	return stripAnsi(result);
}

function redact(value: string, secrets: string[]): string {
	let result = cleanText(value)
		.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted]@")
		.replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
	for (const secret of secrets.filter(Boolean)) {
		result = result.replaceAll(secret, "[redacted]");
	}
	return result;
}

/** Retains only a bounded raw transcript in memory until cross-chunk credential redaction can run safely. */
function appendDiagnostics(job: IInternalGenerativeJob, value: string): void {
	const cleaned = cleanText(value);
	const current = Buffer.byteLength(job.rawDiagnostics, "utf8");
	if (current >= maximumDiagnosticBytes) {
		job.rawDiagnosticsTruncated = true;
		return;
	}
	const bytes = Buffer.from(cleaned, "utf8");
	const bounded = bytes.subarray(0, maximumDiagnosticBytes - current);
	job.rawDiagnostics += bounded.toString("utf8");
	if (bounded.byteLength < bytes.byteLength) {
		job.rawDiagnosticsTruncated = true;
	}
}

/** Redacts the complete bounded process transcript once, so a credential split across stream chunks cannot leak. */
function flushDiagnostics(job: IInternalGenerativeJob): void {
	if (job.secretValues.some((secret) => Buffer.byteLength(secret, "utf8") > maximumDiagnosticBytes)) {
		job.snapshot.execution.diagnostics = "[provider diagnostics suppressed because a credential exceeds the bounded redaction window]";
		job.snapshot.execution.diagnosticsTruncated = true;
	} else {
		job.snapshot.execution.diagnostics = redact(job.rawDiagnostics, job.secretValues);
		job.snapshot.execution.diagnosticsTruncated = job.rawDiagnosticsTruncated;
	}
	job.rawDiagnostics = "";
	job.rawDiagnosticsTruncated = false;
}

function notify(editorState: IGenerativeAssetEditorState): void {
	editorState.changed.notifyObservers();
}

async function jobsRoot(root: string, create: boolean): Promise<string | null> {
	return create ? ensureProjectStoreDirectory(root, ".bjseditor", "generative-assets", "jobs") : inspectProjectStoreDirectory(root, ".bjseditor", "generative-assets", "jobs");
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
	try {
		await move(temporary, path, { overwrite: true });
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}

/** Treats project-private retained state as untrusted and accepts only evidence that is internally fingerprint-consistent. */
function persistedSnapshot(value: unknown): IGenerativeAssetJobSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Persisted generative job must be an object.");
	}
	const source = value as Record<string, any>;
	const unknownTopLevel = Object.keys(source).filter(
		(key) =>
			![
				"id",
				"revision",
				"status",
				"provider",
				"request",
				"requestFingerprint",
				"references",
				"createdAt",
				"startedAt",
				"completedAt",
				"attempt",
				"sourceJobId",
				"progress",
				"cancelRequested",
				"resultFingerprint",
				"outputBytes",
				"candidates",
				"publications",
				"execution",
				"error",
			].includes(key)
	);
	if (unknownTopLevel.length) {
		throw new Error(`Persisted generative job contains unsupported fields: ${unknownTopLevel.join(", ")}.`);
	}
	if (!jobIdPattern.test(source.id) || !Number.isSafeInteger(source.revision) || source.revision < 1) {
		throw new Error("Persisted generative job identity/revision is invalid.");
	}
	if (!["queued", "running", "canceling", "succeeded", "failed", "canceled", "timed-out"].includes(source.status)) {
		throw new Error("Persisted generative job status is invalid.");
	}
	const request = normalizeGenerativeAssetRequest(source.request);
	if (
		!source.provider ||
		typeof source.provider !== "object" ||
		Array.isArray(source.provider) ||
		Object.keys(source.provider).some((key) => !["id", "name", "vendor", "classification", "fingerprint", "transport"].includes(key)) ||
		typeof source.provider.id !== "string" ||
		!fingerprintPattern.test(source.provider.fingerprint)
	) {
		throw new Error("Persisted generative job provider identity is invalid.");
	}
	if (!fingerprintPattern.test(source.requestFingerprint) || (source.resultFingerprint !== null && !fingerprintPattern.test(source.resultFingerprint))) {
		throw new Error("Persisted generative job fingerprint is invalid.");
	}
	if (
		typeof source.provider.name !== "string" ||
		!source.provider.name.length ||
		typeof source.provider.vendor !== "string" ||
		!source.provider.vendor.length ||
		!["generative-ai", "procedural", "test-fixture"].includes(source.provider.classification) ||
		!["executable", "http"].includes(source.provider.transport)
	) {
		throw new Error("Persisted generative provider summary is invalid.");
	}
	if (!Array.isArray(source.references) || source.references.length !== request.references.length) {
		throw new Error("Persisted generative reference evidence is invalid.");
	}
	for (let index = 0; index < source.references.length; index++) {
		const reference = source.references[index];
		if (
			!reference ||
			typeof reference !== "object" ||
			Array.isArray(reference) ||
			Object.keys(reference).some((key) => !["path", "role", "sha256", "sizeBytes", "mediaType"].includes(key)) ||
			reference.path !== request.references[index].path ||
			reference.role !== request.references[index].role ||
			!fingerprintPattern.test(reference.sha256) ||
			!Number.isSafeInteger(reference.sizeBytes) ||
			reference.sizeBytes < 1 ||
			reference.sizeBytes > maximumGenerativeReferenceBytes ||
			typeof reference.mediaType !== "string"
		) {
			throw new Error(`Persisted generative reference ${index + 1} evidence is invalid.`);
		}
	}
	const retainedRequestFingerprint = requestFingerprint(
		request,
		source.references.map((reference: Omit<IGenerativeAssetResolvedReference, "localPath" | "dataBase64">) => ({ evidence: reference, absolutePath: "" }))
	);
	if (retainedRequestFingerprint !== source.requestFingerprint) {
		throw new Error("Persisted generative request/reference fingerprint is inconsistent.");
	}
	if (!Array.isArray(source.candidates) || source.candidates.length > 4) {
		throw new Error("Persisted generative candidates are invalid.");
	}
	let artifactBytes = 0;
	let artifactCount = 0;
	const resultCandidates = source.candidates.map((candidate: any, candidateIndex: number) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !Array.isArray(candidate.artifacts)) {
			throw new Error(`Persisted generative candidate ${candidateIndex + 1} is invalid.`);
		}
		const unknownCandidate = Object.keys(candidate).filter(
			(key) => !["id", "reportedModel", "reportedSeed", "providerRequestId", "warnings", "artifacts", "preview"].includes(key)
		);
		if (unknownCandidate.length) {
			throw new Error(`Persisted generative candidate ${candidateIndex + 1} contains unsupported fields.`);
		}
		const artifacts = candidate.artifacts.map((artifact: any, artifactIndex: number) => {
			if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
				throw new Error(`Persisted generative candidate ${candidateIndex + 1} artifact ${artifactIndex + 1} is invalid.`);
			}
			const unknownArtifact = Object.keys(artifact).filter((key) => !["path", "role", "mediaType", "displayName", "sha256", "sizeBytes", "inspection"].includes(key));
			if (
				unknownArtifact.length ||
				!fingerprintPattern.test(artifact.sha256) ||
				!Number.isSafeInteger(artifact.sizeBytes) ||
				artifact.sizeBytes < 1 ||
				artifact.sizeBytes > maximumGenerativeOutputBytes ||
				!artifact.inspection ||
				typeof artifact.inspection !== "object" ||
				Array.isArray(artifact.inspection)
			) {
				throw new Error(`Persisted generative candidate ${candidateIndex + 1} artifact ${artifactIndex + 1} evidence is invalid.`);
			}
			artifactCount++;
			artifactBytes += artifact.sizeBytes;
			return { path: artifact.path, role: artifact.role, mediaType: artifact.mediaType, displayName: artifact.displayName };
		});
		if (artifactCount > 64 || artifactBytes > maximumGenerativeOutputBytes) {
			throw new Error("Persisted generative artifact evidence exceeds bounded count or bytes.");
		}
		if (candidate.preview !== null) {
			const preview = candidate.preview;
			if (
				!preview ||
				typeof preview !== "object" ||
				Array.isArray(preview) ||
				Object.keys(preview).some((key) => !["path", "mediaType", "sha256", "sizeBytes"].includes(key)) ||
				typeof preview.path !== "string" ||
				!/^(?:output|previews)\/[A-Za-z0-9._/-]+$/.test(preview.path) ||
				preview.path.split("/").some((segment: string) => !segment || segment === "." || segment === "..") ||
				typeof preview.mediaType !== "string" ||
				!fingerprintPattern.test(preview.sha256) ||
				!Number.isSafeInteger(preview.sizeBytes) ||
				preview.sizeBytes < 1 ||
				preview.sizeBytes > maximumPreviewBytes
			) {
				throw new Error(`Persisted generative candidate ${candidateIndex + 1} preview evidence is invalid.`);
			}
		}
		return {
			id: candidate.id,
			reportedModel: candidate.reportedModel,
			reportedSeed: candidate.reportedSeed,
			providerRequestId: candidate.providerRequestId,
			warnings: candidate.warnings,
			artifacts,
		};
	});
	if (source.candidates.length) {
		normalizeGenerativeAssetProviderResult({ version: GENERATIVE_ASSET_CONTRACT_VERSION, candidates: resultCandidates }, request);
	}
	if (!Number.isSafeInteger(source.outputBytes) || source.outputBytes !== artifactBytes) {
		throw new Error("Persisted generative output byte evidence is invalid.");
	}
	if ((source.status === "succeeded") !== (source.resultFingerprint !== null && source.candidates.length > 0)) {
		throw new Error("Persisted generative success/result evidence is inconsistent.");
	}
	if (source.status === "succeeded") {
		const retainedResultFingerprint = sha256(
			JSON.stringify(
				source.candidates.map((candidate: IValidatedGenerativeCandidate) => ({
					id: candidate.id,
					model: candidate.reportedModel,
					seed: candidate.reportedSeed,
					artifacts: candidate.artifacts.map((artifact) => ({
						path: artifact.path,
						role: artifact.role,
						mediaType: artifact.mediaType,
						sha256: artifact.sha256,
						sizeBytes: artifact.sizeBytes,
					})),
				}))
			)
		);
		if (retainedResultFingerprint !== source.resultFingerprint) {
			throw new Error("Persisted generative result fingerprint is inconsistent.");
		}
	}
	const retainedPublications = source.publications ?? [];
	if (!Array.isArray(retainedPublications) || retainedPublications.length > maximumGenerativeAssetPublicationRecords) {
		throw new Error("Persisted generative publication evidence is invalid.");
	}
	const publications = retainedPublications.map(normalizeGenerativeAssetPublicationRecord);
	for (let index = 0; index < publications.length; index++) {
		const publication = publications[index];
		const candidate = source.candidates.find((entry: IValidatedGenerativeCandidate) => entry.id === publication.candidateId);
		if (
			publication.revision !== index + 1 ||
			publication.resultFingerprint !== source.resultFingerprint ||
			!candidate ||
			publication.files.some(
				(file) => file.sourceArtifactPath !== null && !candidate.artifacts.some((artifact: IValidatedGenerativeArtifact) => artifact.path === file.sourceArtifactPath)
			)
		) {
			throw new Error(`Persisted generative publication ${index + 1} is inconsistent with its retained job result.`);
		}
	}
	if (
		!source.progress ||
		Array.isArray(source.progress) ||
		Object.keys(source.progress).some((key) => !["phase", "message"].includes(key)) ||
		typeof source.progress.phase !== "string" ||
		!source.progress.phase.length ||
		source.progress.phase.length > 128 ||
		typeof source.progress.message !== "string" ||
		source.progress.message.length > 4_096 ||
		!source.execution ||
		Array.isArray(source.execution) ||
		Object.keys(source.execution).some((key) => !["durationMilliseconds", "exitCode", "httpStatus", "diagnostics", "diagnosticsTruncated"].includes(key)) ||
		typeof source.execution.diagnostics !== "string" ||
		Buffer.byteLength(source.execution.diagnostics, "utf8") > maximumDiagnosticBytes ||
		typeof source.execution.diagnosticsTruncated !== "boolean" ||
		(source.error !== null && typeof source.error !== "string")
	) {
		throw new Error("Persisted generative progress/execution evidence is invalid.");
	}
	const validTimestamp = (entry: unknown, nullable: boolean): boolean =>
		(nullable && entry === null) || (typeof entry === "string" && entry.length <= 64 && Number.isFinite(Date.parse(entry)) && new Date(entry).toISOString() === entry);
	if (
		!validTimestamp(source.createdAt, false) ||
		!validTimestamp(source.startedAt, true) ||
		!validTimestamp(source.completedAt, true) ||
		!Number.isSafeInteger(source.attempt) ||
		source.attempt < 1 ||
		(source.sourceJobId !== null && (typeof source.sourceJobId !== "string" || !jobIdPattern.test(source.sourceJobId))) ||
		typeof source.cancelRequested !== "boolean" ||
		(source.execution.durationMilliseconds !== null && (!Number.isSafeInteger(source.execution.durationMilliseconds) || source.execution.durationMilliseconds < 0)) ||
		(source.execution.exitCode !== null && !Number.isSafeInteger(source.execution.exitCode)) ||
		(source.execution.httpStatus !== null && (!Number.isSafeInteger(source.execution.httpStatus) || source.execution.httpStatus < 100 || source.execution.httpStatus > 599)) ||
		(source.error !== null && source.error.length > 4_096)
	) {
		throw new Error("Persisted generative timing/attempt/execution values are invalid.");
	}
	const serialized = JSON.stringify(source);
	if (serialized.length > 1024 * 1024) {
		throw new Error("Persisted generative job exceeds 1 MiB.");
	}
	return clone({ ...source, request, publications }) as IGenerativeAssetJobSnapshot;
}

async function persistJob(job: IInternalGenerativeJob): Promise<void> {
	const operation = job.persistTail
		.catch(() => undefined)
		.then(async () => {
			await ensureDir(job.directory);
			const bytes = Buffer.from(`${JSON.stringify(job.snapshot, null, "\t")}\n`, "utf8");
			if (bytes.byteLength > maximumPersistedJobBytes) {
				throw new Error("Generative retained job exceeds the 1 MiB persistence bound.");
			}
			await atomicWrite(join(job.directory, "job.json"), bytes);
		});
	job.persistTail = operation;
	await operation;
}

async function loadJobs(editorState: IGenerativeAssetEditorState, root: string): Promise<void> {
	const directory = await jobsRoot(root, false);
	if (!directory) {
		editorState.loadedRoot = root;
		return;
	}
	const rootReal = await realpath(root);
	const entries = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && jobIdPattern.test(entry.name))
		.sort((left, right) => right.name.localeCompare(left.name))
		.slice(0, maximumRetainedJobs);
	for (const entry of entries) {
		const jobDirectory = join(directory, entry.name);
		const path = join(jobDirectory, "job.json");
		try {
			const [jobReal, details] = await Promise.all([realpath(jobDirectory), lstat(path)]);
			if (!projectPathContains(rootReal, jobReal) || details.isSymbolicLink() || !details.isFile() || details.size <= 0 || details.size > 1024 * 1024) {
				throw new Error("Job record must be a bounded regular contained file.");
			}
			const snapshot = persistedSnapshot(JSON.parse(await readFile(path, "utf8")));
			const job: IInternalGenerativeJob = {
				snapshot,
				root,
				directory: jobDirectory,
				outputDirectory: join(jobDirectory, "output"),
				provider: null,
				controller: null,
				child: null,
				secretValues: [],
				timedOut: false,
				rawDiagnostics: "",
				rawDiagnosticsTruncated: false,
				publicationActive: false,
				persistTail: Promise.resolve(),
			};
			if (["queued", "running", "canceling"].includes(snapshot.status)) {
				snapshot.status = "failed";
				snapshot.revision++;
				snapshot.completedAt = new Date().toISOString();
				snapshot.error = "The Editor stopped before this generation job completed; retry from the retained exact request.";
				snapshot.progress = { phase: "recovered", message: snapshot.error };
				await persistJob(job);
			}
			editorState.jobs.set(snapshot.id, job);
		} catch (error) {
			editorState.loadErrors.push({ path: `.bjseditor/generative-assets/jobs/${entry.name}/job.json`, error: error instanceof Error ? error.message : String(error) });
		}
	}
	editorState.loadedRoot = root;
}

function terminate(job: IInternalGenerativeJob): void {
	const child = job.child;
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		}, 5_000).unref?.();
	} else {
		child.kill("SIGTERM");
	}
}

/** Stops pre-spawn and post-await races from executing or accepting work after cancellation. */
function rejectCanceledJob(job: IInternalGenerativeJob): void {
	if (job.snapshot.cancelRequested || job.controller?.signal.aborted) {
		throw new Error("Generative provider was canceled before staged output could be accepted.");
	}
}

/** Persists queued cancellation and aborts active providers before one owner begins loading another project. */
async function abortForProjectSwitch(editorState: IGenerativeAssetEditorState): Promise<void> {
	const persistence: Promise<void>[] = [];
	for (const job of editorState.jobs.values()) {
		if (job.snapshot.status === "queued") {
			job.snapshot.cancelRequested = true;
			job.snapshot.status = "canceled";
			job.snapshot.completedAt = new Date().toISOString();
			job.snapshot.progress = { phase: "canceled", message: "The open project changed before provider execution." };
			job.snapshot.revision++;
			persistence.push(persistJob(job));
		} else if (["running", "canceling"].includes(job.snapshot.status)) {
			job.snapshot.cancelRequested = true;
			job.controller?.abort();
			terminate(job);
		}
	}
	await Promise.allSettled(persistence);
	await Promise.allSettled([...editorState.activePublications]);
	editorState.jobs = new Map();
	editorState.loadErrors = [];
	editorState.loadedRoot = null;
	editorState.loadPromise = null;
}

async function ensureState(editor: Editor): Promise<IGenerativeAssetEditorState> {
	const editorState = state(editor);
	const root = projectDirectory();
	if (editorState.projectRoot !== root) {
		await abortForProjectSwitch(editorState);
		editorState.projectRoot = root;
	}
	if (editorState.loadedRoot !== root) {
		editorState.loadPromise ??= loadJobs(editorState, root).finally(() => {
			editorState.loadPromise = null;
		});
		await editorState.loadPromise;
		if (projectDirectory() !== root) {
			return ensureState(editor);
		}
	}
	return editorState;
}

function referenceMediaType(path: string): string {
	const extension = extname(path).toLowerCase();
	const types: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".glb": "model/gltf-binary",
		".gltf": "model/gltf+json",
		".babylon": "application/json",
		".fbx": "application/octet-stream",
		".animation": "application/json",
		".animations": "application/json",
		".anim": "application/yaml",
		".wav": "audio/wav",
		".wave": "audio/wav",
		".mp3": "audio/mpeg",
		".ogg": "audio/ogg",
		".flac": "audio/flac",
		".m4a": "audio/mp4",
		".mp4": "video/mp4",
		".webm": "video/webm",
	};
	const result = types[extension];
	if (!result) {
		throw new Error(`Generative reference extension is unsupported: ${extension || "extensionless"}.`);
	}
	return result;
}

function validateReferenceRole(path: string, role: IGenerativeAssetResolvedReference["role"], mediaType: string): void {
	const image = mediaType.startsWith("image/");
	const audio = mediaType.startsWith("audio/");
	const video = mediaType.startsWith("video/");
	const extension = extname(path).toLowerCase();
	if ((role === "style" || role === "mask") && !image) {
		throw new Error(`Generative ${role} references must be PNG, JPEG, or WebP images.`);
	}
	if (role === "character" && ![".glb", ".gltf", ".babylon", ".fbx", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
		throw new Error("Generative character references must be a supported model or image asset.");
	}
	if (role === "motion" && ![".animation", ".animations", ".anim", ".glb", ".gltf", ".mp4", ".webm"].includes(extension)) {
		throw new Error("Generative motion references must be an animation, model, or video asset.");
	}
	if (role === "audio-guide" && !audio) {
		throw new Error("Generative audio-guide references must be audio assets.");
	}
	if (role !== "content" && role !== "character" && role !== "motion" && !image && !audio && !video) {
		throw new Error(`Generative ${role} reference type is unsupported.`);
	}
}

async function resolveReferences(root: string, request: IGenerativeAssetRequest): Promise<IInternalReference[]> {
	const rootReal = await realpath(root);
	const result: IInternalReference[] = [];
	let totalBytes = 0;
	for (const reference of request.references) {
		const absolutePath = join(root, reference.path);
		if (!projectPathContains(root, absolutePath)) {
			throw new Error(`Generative reference escaped the project: ${reference.path}.`);
		}
		const [details, resolved] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
		if (details.isSymbolicLink() || !details.isFile() || !projectPathContains(rootReal, resolved) || details.size <= 0 || details.size > maximumReferenceFileBytes) {
			throw new Error(`Generative reference must be a 1-byte through ${maximumReferenceFileBytes}-byte regular contained non-symlink file: ${reference.path}.`);
		}
		totalBytes += details.size;
		if (totalBytes > maximumGenerativeReferenceBytes) {
			throw new Error(`Generative references exceed the ${maximumGenerativeReferenceBytes}-byte aggregate limit.`);
		}
		const mediaType = referenceMediaType(reference.path);
		validateReferenceRole(reference.path, reference.role, mediaType);
		const bytes = await readFile(resolved);
		result.push({
			absolutePath: resolved,
			evidence: { path: reference.path, role: reference.role, sha256: sha256(bytes), sizeBytes: bytes.byteLength, mediaType },
		});
	}
	return result;
}

function requestFingerprint(request: IGenerativeAssetRequest, references: IInternalReference[]): string {
	return sha256(
		JSON.stringify(
			canonical({ contract: GENERATIVE_ASSET_CONTRACT, version: GENERATIVE_ASSET_CONTRACT_VERSION, request, references: references.map((entry) => entry.evidence) })
		)
	);
}

async function revalidateReferences(job: IInternalGenerativeJob): Promise<IInternalReference[]> {
	const references = await resolveReferences(job.root, job.snapshot.request);
	const fingerprint = requestFingerprint(job.snapshot.request, references);
	if (fingerprint !== job.snapshot.requestFingerprint) {
		throw new Error(`Generative request references changed while queued; inspect them and start a fresh job with request fingerprint ${fingerprint}.`);
	}
	return references;
}

async function createJobDirectory(root: string, id: string): Promise<string> {
	const directory = await jobsRoot(root, true);
	const path = join(directory!, id);
	await mkdir(path, { mode: 0o700 });
	const [rootReal, pathReal, details] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
	if (details.isSymbolicLink() || !details.isDirectory() || !projectPathContains(rootReal, pathReal)) {
		throw new Error("Generative job directory must be a regular contained directory.");
	}
	return path;
}

function minimalEnvironment(job: IInternalGenerativeJob): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec", "LANG", "LC_ALL"]) {
		if (process.env[name] !== undefined) {
			environment[name] = process.env[name];
		}
	}
	if (job.provider?.transport.kind === "executable") {
		for (const name of job.provider.transport.credentialEnvironments) {
			environment[name] = process.env[name];
		}
	}
	environment.ZVIBE_GENERATIVE_CONTRACT = GENERATIVE_ASSET_CONTRACT;
	environment.ZVIBE_GENERATIVE_JOB_ID = job.snapshot.id;
	return environment;
}

function replaceArgs(job: IInternalGenerativeJob, requestPath: string): string[] {
	if (job.provider?.transport.kind !== "executable") {
		return [];
	}
	const values: Record<string, string> = { REQUEST: requestPath, OUTPUT: job.outputDirectory, JOB_ID: job.snapshot.id, PROJECT: job.root };
	return job.provider.transport.args.map((argument) => argument.replace(/\$\{(REQUEST|OUTPUT|JOB_ID|PROJECT)\}/g, (_match, name: string) => values[name]));
}

async function runExecutable(job: IInternalGenerativeJob, requestPath: string): Promise<{ result: unknown; exitCode: number | null; httpStatus: null }> {
	if (job.provider?.transport.kind !== "executable") {
		throw new Error("Generative job does not use an executable provider.");
	}
	rejectCanceledJob(job);
	const child = spawn(job.provider.transport.executable, replaceArgs(job, requestPath), {
		cwd: job.root,
		env: minimalEnvironment(job),
		shell: false,
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	job.child = child;
	child.stdout?.on("data", (value: Buffer) => appendDiagnostics(job, value.toString("utf8")));
	child.stderr?.on("data", (value: Buffer) => appendDiagnostics(job, value.toString("utf8")));
	const abort = (): void => terminate(job);
	job.controller!.signal.addEventListener("abort", abort, { once: true });
	if (job.controller!.signal.aborted) {
		terminate(job);
	}
	const outcome = await new Promise<{ exitCode: number | null; error: Error | null }>((resolve) => {
		let spawnError: Error | null = null;
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (exitCode) => resolve({ exitCode, error: spawnError }));
	});
	job.controller!.signal.removeEventListener("abort", abort);
	job.child = null;
	flushDiagnostics(job);
	if (job.snapshot.cancelRequested || job.timedOut) {
		throw new Error(job.timedOut ? "Generative provider timed out." : "Generative provider was canceled.");
	}
	if (outcome.error || outcome.exitCode !== 0) {
		throw new Error(`Generative provider exited with code ${outcome.exitCode}: ${outcome.error?.message ?? (job.snapshot.execution.diagnostics.trim() || "no diagnostic")}.`);
	}
	return { result: await readGenerativeProviderResultManifest(join(job.outputDirectory, "result.json")), exitCode: outcome.exitCode, httpStatus: null };
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Buffer> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
		throw new Error(`Generative HTTP response declares ${contentLength} bytes, above the ${maximumBytes}-byte limit.`);
	}
	if (!response.body) {
		return Buffer.alloc(0);
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		bytes += chunk.value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`Generative HTTP response exceeded the ${maximumBytes}-byte limit.`);
		}
		chunks.push(Buffer.from(chunk.value));
	}
	return Buffer.concat(chunks);
}

async function runHttp(
	job: IInternalGenerativeJob,
	envelope: IGenerativeAssetProviderRequestEnvelope,
	references: IInternalReference[]
): Promise<{ result: unknown; exitCode: null; httpStatus: number }> {
	if (job.provider?.transport.kind !== "http") {
		throw new Error("Generative job does not use an HTTP provider.");
	}
	const authorization = job.provider.transport.authorizationEnvironment ? process.env[job.provider.transport.authorizationEnvironment] : undefined;
	const remoteEnvelope: IGenerativeAssetProviderRequestEnvelope = {
		...envelope,
		references: await Promise.all(references.map(async (reference) => ({ ...reference.evidence, dataBase64: (await readFile(reference.absolutePath)).toString("base64") }))),
	};
	const response = await fetch(job.provider.transport.endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			...job.provider.transport.headers,
			...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
		},
		body: JSON.stringify(remoteEnvelope),
		signal: job.controller!.signal,
		redirect: "error",
	});
	const outputLimit = Math.min(job.provider.maximumOutputBytes, maximumHttpOutputBytes);
	const maximumResponseBytes = Math.ceil((outputLimit * 4) / 3) + 2 * 1024 * 1024;
	const bytes = await readResponseBytes(response, response.ok ? maximumResponseBytes : maximumDiagnosticBytes);
	if (!response.ok) {
		throw new Error(
			`Generative HTTP provider returned ${response.status} ${response.statusText}: ${redact(bytes.toString("utf8").slice(0, maximumDiagnosticBytes), job.secretValues)}.`
		);
	}
	if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
		throw new Error("Generative HTTP provider must return application/json.");
	}
	try {
		return { result: JSON.parse(bytes.toString("utf8")), exitCode: null, httpStatus: response.status };
	} catch {
		throw new Error("Generative HTTP provider returned malformed JSON.");
	}
}

async function writeProviderRequest(job: IInternalGenerativeJob, references: IInternalReference[]): Promise<{ path: string; envelope: IGenerativeAssetProviderRequestEnvelope }> {
	const envelope: IGenerativeAssetProviderRequestEnvelope = {
		contract: GENERATIVE_ASSET_CONTRACT,
		version: GENERATIVE_ASSET_CONTRACT_VERSION,
		jobId: job.snapshot.id,
		requestFingerprint: job.snapshot.requestFingerprint,
		request: job.snapshot.request,
		references: references.map((reference) => ({ ...reference.evidence, ...(job.provider?.transport.kind === "executable" ? { localPath: reference.absolutePath } : {}) })),
	};
	const path = join(job.directory, "provider-request.json");
	await atomicWrite(path, Buffer.from(`${JSON.stringify(envelope, null, "\t")}\n`, "utf8"));
	return { path, envelope };
}

async function sanitizeProviderRequest(job: IInternalGenerativeJob): Promise<void> {
	const path = join(job.directory, "provider-request.json");
	const envelope: IGenerativeAssetProviderRequestEnvelope = {
		contract: GENERATIVE_ASSET_CONTRACT,
		version: GENERATIVE_ASSET_CONTRACT_VERSION,
		jobId: job.snapshot.id,
		requestFingerprint: job.snapshot.requestFingerprint,
		request: job.snapshot.request,
		references: job.snapshot.references,
	};
	await atomicWrite(path, Buffer.from(`${JSON.stringify(envelope, null, "\t")}\n`, "utf8")).catch(() => undefined);
}

async function failJob(editorState: IGenerativeAssetEditorState, job: IInternalGenerativeJob, error: unknown): Promise<void> {
	job.snapshot.status = job.timedOut ? "timed-out" : job.snapshot.cancelRequested ? "canceled" : "failed";
	job.snapshot.completedAt = new Date().toISOString();
	job.snapshot.error = redact(error instanceof Error ? error.message : String(error), job.secretValues).slice(0, 4_096);
	job.snapshot.progress = { phase: job.snapshot.status, message: job.snapshot.error };
	job.snapshot.revision++;
	await persistJob(job).catch(() => undefined);
	notify(editorState);
}

/** Executes one exact provider/reference lease and accepts output only after all mutable inputs are revalidated. */
async function runJob(editorState: IGenerativeAssetEditorState, job: IInternalGenerativeJob, editor: Editor): Promise<void> {
	const startedAt = Date.now();
	let timeout: NodeJS.Timeout | null = null;
	try {
		job.snapshot.status = "running";
		job.snapshot.startedAt = new Date().toISOString();
		job.snapshot.progress = { phase: "validating", message: "Revalidating provider, request, references, and staging lease." };
		job.snapshot.revision++;
		job.controller = new AbortController();
		await persistJob(job);
		notify(editorState);
		if (projectDirectory() !== job.root) {
			throw new Error("The open project changed before the generative job started.");
		}
		const inventory = await readGenerativeAssetProviderInventory();
		const provider = inventory.providers.find((entry) => entry.id === job.snapshot.provider.id);
		if (!provider || provider.fingerprint !== job.snapshot.provider.fingerprint || !provider.available) {
			throw new Error("The selected generative provider changed or became unavailable while the job was queued.");
		}
		job.provider = provider;
		job.secretValues =
			provider.transport.kind === "executable"
				? provider.transport.credentialEnvironments.map((name) => process.env[name] ?? "").filter(Boolean)
				: provider.transport.authorizationEnvironment
					? [process.env[provider.transport.authorizationEnvironment] ?? ""].filter(Boolean)
					: [];
		const references = await revalidateReferences(job);
		rejectCanceledJob(job);
		await remove(job.outputDirectory);
		await ensureDir(job.outputDirectory);
		const request = await writeProviderRequest(job, references);
		rejectCanceledJob(job);
		job.snapshot.progress = { phase: "generating", message: `Executing ${provider.transport.kind} provider ${provider.name}.` };
		notify(editorState);
		timeout = setTimeout(() => {
			job.timedOut = !job.snapshot.cancelRequested;
			job.controller?.abort();
			terminate(job);
		}, provider.maximumDurationSeconds * 1000);
		timeout.unref?.();
		const execution = provider.transport.kind === "executable" ? await runExecutable(job, request.path) : await runHttp(job, request.envelope, references);
		job.snapshot.execution.exitCode = execution.exitCode;
		job.snapshot.execution.httpStatus = execution.httpStatus;
		if (timeout) {
			clearTimeout(timeout);
			timeout = null;
		}
		job.snapshot.progress = { phase: "inspecting", message: "Decoding and fingerprinting every declared provider artifact." };
		notify(editorState);
		const normalized = normalizeGenerativeAssetProviderResult(execution.result, job.snapshot.request);
		const clean = await materializeGenerativeProviderResult(
			job.outputDirectory,
			normalized,
			provider.transport.kind === "http" ? Math.min(provider.maximumOutputBytes, maximumHttpOutputBytes) : provider.maximumOutputBytes
		);
		const outputLimit = provider.transport.kind === "http" ? Math.min(provider.maximumOutputBytes, maximumHttpOutputBytes) : provider.maximumOutputBytes;
		const validated = await validateGenerativeProviderOutput(job.directory, job.outputDirectory, clean, job.snapshot.request, outputLimit, editor);
		if (job.snapshot.cancelRequested) {
			throw new Error("Generative provider was canceled before staged output could be accepted.");
		}
		if (projectDirectory() !== job.root) {
			throw new Error("The open project changed during generation; staged output was not accepted.");
		}
		const finalReferences = await revalidateReferences(job);
		if (requestFingerprint(job.snapshot.request, finalReferences) !== job.snapshot.requestFingerprint) {
			throw new Error("Generative references changed during output validation.");
		}
		const latestProvider = (await readGenerativeAssetProviderInventory()).providers.find((entry) => entry.id === provider.id);
		if (!latestProvider || latestProvider.fingerprint !== provider.fingerprint) {
			throw new Error("Generative provider manifest changed during execution; staged output was not accepted.");
		}
		job.snapshot.status = "succeeded";
		job.snapshot.completedAt = new Date().toISOString();
		job.snapshot.progress = { phase: "complete", message: "Provider output passed exact media, integrity, and staging validation." };
		job.snapshot.resultFingerprint = validated.resultFingerprint;
		job.snapshot.outputBytes = validated.outputBytes;
		job.snapshot.candidates = validated.candidates;
		job.snapshot.error = null;
		job.snapshot.execution.durationMilliseconds = Date.now() - startedAt;
		job.snapshot.revision++;
		await sanitizeProviderRequest(job);
		await persistJob(job);
		notify(editorState);
	} catch (error) {
		job.snapshot.execution.durationMilliseconds = Date.now() - startedAt;
		await sanitizeProviderRequest(job);
		await failJob(editorState, job, error);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
		job.controller = null;
		job.child = null;
		job.secretValues = [];
	}
}

function schedule(editorState: IGenerativeAssetEditorState, editor: Editor): void {
	if (editorState.disposed) {
		return;
	}
	while (editorState.activeCount < maximumConcurrentJobs) {
		const next = [...editorState.jobs.values()].find((job) => job.snapshot.status === "queued" && job.root === editorState.projectRoot);
		if (!next) {
			break;
		}
		editorState.activeCount++;
		const operation = runJob(editorState, next, editor).finally(() => {
			editorState.activeCount--;
			editorState.activePromises.delete(operation);
			schedule(editorState, editor);
		});
		editorState.activePromises.add(operation);
	}
}

function exactJob(editorState: IGenerativeAssetEditorState, id: unknown): IInternalGenerativeJob {
	if (typeof id !== "string" || !jobIdPattern.test(id)) {
		throw new Error("Generative job id must use the generative-job- plus 24 lowercase hexadecimal characters format.");
	}
	const job = editorState.jobs.get(id);
	if (!job) {
		throw new Error(`Generative job "${id}" was not found in the open project.`);
	}
	return job;
}

function expectedRevision(job: IInternalGenerativeJob, value: unknown): void {
	if (!Number.isSafeInteger(value) || value !== job.snapshot.revision) {
		throw new Error(`Generative job ${job.snapshot.id} changed; use expectedRevision ${job.snapshot.revision}.`);
	}
}

async function startJob(data: Record<string, unknown>, options: IMCPActionOptions, attempt = 1, sourceJobId: string | null = null): Promise<IGenerativeAssetJobSnapshot> {
	if (data.confirm !== true) {
		throw new Error("Starting a generative provider requires confirm=true because project-authored code or a remote endpoint will execute.");
	}
	const editorState = await ensureState(options.editor);
	if (editorState.jobs.size >= maximumRetainedJobs) {
		throw new Error(`Generative job history already contains ${maximumRetainedJobs} jobs; delete completed jobs before starting another.`);
	}
	const queued = [...editorState.jobs.values()].filter((job) => job.snapshot.status === "queued").length;
	if (queued >= maximumQueuedJobs) {
		throw new Error(`Generative job queue already contains ${maximumQueuedJobs} jobs.`);
	}
	const inventory = await readGenerativeAssetProviderInventory();
	const provider = inventory.providers.find((entry) => entry.id === data.providerId);
	if (!provider) {
		throw new Error(`Generative provider "${String(data.providerId)}" was not found.`);
	}
	if (data.expectedProviderFingerprint !== provider.fingerprint) {
		throw new Error(`Generative provider changed; use expectedProviderFingerprint ${provider.fingerprint}.`);
	}
	if (!provider.available) {
		throw new Error(`Generative provider ${provider.id} is unavailable: ${provider.warnings.join(" ") || "read provider readiness"}.`);
	}
	const request = normalizeGenerativeAssetRequest(data.request);
	if (!provider.modalities.includes(request.modality)) {
		throw new Error(`Generative provider ${provider.id} does not declare ${request.modality} capability.`);
	}
	const root = projectDirectory();
	const references = await resolveReferences(root, request);
	const fingerprint = requestFingerprint(request, references);
	const id = `generative-job-${randomBytes(12).toString("hex")}`;
	const directory = await createJobDirectory(root, id);
	const now = new Date().toISOString();
	const snapshot: IGenerativeAssetJobSnapshot = {
		id,
		revision: 1,
		status: "queued",
		provider: {
			id: provider.id,
			name: provider.name,
			vendor: provider.vendor,
			classification: provider.classification,
			fingerprint: provider.fingerprint,
			transport: provider.transport.kind,
		},
		request,
		requestFingerprint: fingerprint,
		references: references.map((entry) => entry.evidence),
		createdAt: now,
		startedAt: null,
		completedAt: null,
		attempt,
		sourceJobId,
		progress: { phase: "queued", message: "Waiting for a bounded provider execution slot." },
		cancelRequested: false,
		resultFingerprint: null,
		outputBytes: 0,
		candidates: [],
		publications: [],
		execution: { durationMilliseconds: null, exitCode: null, httpStatus: null, diagnostics: "", diagnosticsTruncated: false },
		error: null,
	};
	const job: IInternalGenerativeJob = {
		snapshot,
		root,
		directory,
		outputDirectory: join(directory, "output"),
		provider,
		controller: null,
		child: null,
		secretValues: [],
		timedOut: false,
		rawDiagnostics: "",
		rawDiagnosticsTruncated: false,
		publicationActive: false,
		persistTail: Promise.resolve(),
	};
	editorState.jobs.set(id, job);
	try {
		await persistJob(job);
	} catch (error) {
		editorState.jobs.delete(id);
		await remove(directory).catch(() => undefined);
		throw error;
	}
	notify(editorState);
	schedule(editorState, options.editor);
	return publicJob(job);
}

/** Reports the complete provider/job/promotion boundary without claiming configured fixtures are AI. */
export async function getGenerativeAssetCapabilities(_scene: Scene, _data: unknown, options: IMCPActionOptions): Promise<object> {
	const inventory = await readGenerativeAssetProviderInventory();
	return {
		contract: GENERATIVE_ASSET_CONTRACT,
		version: GENERATIVE_ASSET_CONTRACT_VERSION,
		modalities: ["image", "sprite", "material", "animation", "audio"],
		providers: {
			manifestDirectory: inventory.directory,
			configured: inventory.providers.length,
			available: inventory.providers.filter((provider) => provider.available).length,
			transports: ["executable", "http"],
			credentials: "environment variable names only; values are never persisted or returned",
			classificationBoundary: "Only providers explicitly classified generative-ai are presented as AI; procedural and test-fixture results remain labeled.",
		},
		jobs: {
			concurrent: maximumConcurrentJobs,
			queued: maximumQueuedJobs,
			retained: maximumRetainedJobs,
			cancellation: true,
			retry: true,
			persistentPrivateStaging: true,
			projectSwitchRejection: true,
		},
		limits: {
			referenceFileBytes: maximumReferenceFileBytes,
			referenceAggregateBytes: maximumGenerativeReferenceBytes,
			httpOutputBytes: maximumHttpOutputBytes,
			previewBytes: maximumPreviewBytes,
		},
		publication: { transactional: true, normalAssetRegistry: true, provenance: true, maximumRecordsPerJob: maximumGenerativeAssetPublicationRecords, implemented: true },
		workspace: Boolean(options.editor.layout),
	};
}

export async function listGenerativeAssetProvidersAction(_scene: Scene, _data: unknown, _options: IMCPActionOptions): Promise<object> {
	return readGenerativeAssetProviderInventory();
}

export async function setGenerativeAssetProviderAction(_scene: Scene, data: unknown, _options: IMCPActionOptions): Promise<object> {
	return setGenerativeAssetProvider(bridgePayload(data));
}

export async function deleteGenerativeAssetProviderAction(_scene: Scene, data: unknown, _options: IMCPActionOptions): Promise<object> {
	return deleteGenerativeAssetProvider(bridgePayload(data));
}

/** Queues one exact provider/request/reference lease and starts it when a bounded slot is available. */
export async function startGenerativeAssetJob(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<IGenerativeAssetJobSnapshot> {
	data = bridgePayload(data);
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("start_generative_asset_job input must be an object.");
	}
	const source = data as Record<string, unknown>;
	const unknown = Object.keys(source).filter((key) => !["providerId", "expectedProviderFingerprint", "request", "confirm"].includes(key));
	if (unknown.length) {
		throw new Error(`start_generative_asset_job contains unsupported fields: ${unknown.join(", ")}.`);
	}
	return startJob(source, options);
}

/** Pages retained generation jobs without reading artifact bytes. */
export async function listGenerativeAssetJobs(_scene: Scene, data: any, options: IMCPActionOptions): Promise<object> {
	data = bridgePayload(data);
	const editorState = await ensureState(options.editor);
	const offset = data?.offset ?? 0;
	const limit = data?.limit ?? 20;
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Generative job offset/limit must be integers from 0 through 1000000 and 1 through 100.");
	}
	let jobs = [...editorState.jobs.values()];
	if (data?.status !== undefined) {
		jobs = jobs.filter((job) => job.snapshot.status === data.status);
	}
	if (data?.providerId !== undefined) {
		jobs = jobs.filter((job) => job.snapshot.provider.id === data.providerId);
	}
	if (data?.modality !== undefined) {
		jobs = jobs.filter((job) => job.snapshot.request.modality === data.modality);
	}
	jobs.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt) || right.snapshot.id.localeCompare(left.snapshot.id));
	return {
		total: jobs.length,
		offset,
		limit,
		nextOffset: offset + limit < jobs.length ? offset + limit : null,
		jobs: jobs.slice(offset, offset + limit).map(publicJob),
		loadErrors: clone(editorState.loadErrors),
	};
}

/** Reads one exact retained generation job. */
export async function getGenerativeAssetJob(_scene: Scene, data: any, options: IMCPActionOptions): Promise<IGenerativeAssetJobSnapshot> {
	data = bridgePayload(data);
	return publicJob(exactJob(await ensureState(options.editor), data?.jobId));
}

/** Cancels a queued job immediately or cooperatively terminates its active HTTP/process provider. */
export async function cancelGenerativeAssetJob(_scene: Scene, data: any, options: IMCPActionOptions): Promise<IGenerativeAssetJobSnapshot> {
	data = bridgePayload(data);
	if (data?.confirm !== true) {
		throw new Error("Canceling a generative job requires confirm=true.");
	}
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data.jobId);
	expectedRevision(job, data.expectedRevision);
	if (!["queued", "running", "canceling"].includes(job.snapshot.status)) {
		return publicJob(job);
	}
	job.snapshot.cancelRequested = true;
	job.snapshot.revision++;
	if (job.snapshot.status === "queued") {
		job.snapshot.status = "canceled";
		job.snapshot.completedAt = new Date().toISOString();
		job.snapshot.progress = { phase: "canceled", message: "Queued job canceled before provider execution." };
	} else {
		job.snapshot.status = "canceling";
		job.snapshot.progress = { phase: "canceling", message: "Provider cancellation requested; staged output will not be accepted." };
		job.controller?.abort();
		terminate(job);
	}
	await persistJob(job);
	notify(editorState);
	schedule(editorState, options.editor);
	return publicJob(job);
}

/** Creates a new attempt from one retained exact request using the provider's current exact fingerprint. */
export async function retryGenerativeAssetJob(_scene: Scene, data: any, options: IMCPActionOptions): Promise<IGenerativeAssetJobSnapshot> {
	data = bridgePayload(data);
	const editorState = await ensureState(options.editor);
	const source = exactJob(editorState, data?.jobId);
	expectedRevision(source, data?.expectedRevision);
	if (["queued", "running", "canceling"].includes(source.snapshot.status)) {
		throw new Error("A generative job can be retried only after it reaches a terminal state.");
	}
	return startJob(
		{
			providerId: source.snapshot.provider.id,
			expectedProviderFingerprint: data?.expectedProviderFingerprint,
			request: source.snapshot.request,
			confirm: data?.confirm,
		},
		options,
		source.snapshot.attempt + 1,
		source.snapshot.id
	);
}

function publicationInput(data: unknown, apply: boolean): Record<string, unknown> {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${apply ? "publish_generative_asset_candidate" : "inspect_generative_asset_publication"} input must be an object.`);
	}
	const source = data as Record<string, unknown>;
	const allowed = [
		"jobId",
		"expectedRevision",
		"expectedResultFingerprint",
		"candidateId",
		"destinationDirectory",
		"baseName",
		"overwrite",
		...(apply ? ["expectedPlanFingerprint", "confirm"] : []),
	];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${apply ? "publish_generative_asset_candidate" : "inspect_generative_asset_publication"} contains unsupported fields: ${unknown.join(", ")}.`);
	}
	return source;
}

function publicationLease(job: IInternalGenerativeJob): IGenerativeAssetPublicationJobLease {
	return {
		root: job.root,
		jobDirectory: job.directory,
		outputDirectory: job.outputDirectory,
		id: job.snapshot.id,
		revision: job.snapshot.revision,
		status: job.snapshot.status,
		provider: clone(job.snapshot.provider),
		request: clone(job.snapshot.request),
		requestFingerprint: job.snapshot.requestFingerprint,
		references: clone(job.snapshot.references),
		startedAt: job.snapshot.startedAt,
		completedAt: job.snapshot.completedAt,
		resultFingerprint: job.snapshot.resultFingerprint,
		candidates: clone(job.snapshot.candidates),
		execution: {
			durationMilliseconds: job.snapshot.execution.durationMilliseconds,
			exitCode: job.snapshot.execution.exitCode,
			httpStatus: job.snapshot.execution.httpStatus,
		},
		publicationCount: job.snapshot.publications.length,
	};
}

function exactPublicationJob(editorState: IGenerativeAssetEditorState, source: Record<string, unknown>): IInternalGenerativeJob {
	const job = exactJob(editorState, source.jobId);
	expectedRevision(job, source.expectedRevision);
	if (job.snapshot.status !== "succeeded" || !job.snapshot.resultFingerprint) {
		throw new Error("Generative publication requires a succeeded job with retained result evidence.");
	}
	if (source.expectedResultFingerprint !== job.snapshot.resultFingerprint) {
		throw new Error(`Generative result changed; use expectedResultFingerprint ${job.snapshot.resultFingerprint}.`);
	}
	if (typeof source.candidateId !== "string" || !job.snapshot.candidates.some((candidate) => candidate.id === source.candidateId)) {
		throw new Error(`Generative candidate "${String(source.candidateId)}" was not found in job ${job.snapshot.id}.`);
	}
	return job;
}

/** Produces a fresh immutable publication lease without changing the project asset registry. */
export async function inspectGenerativeAssetPublicationAction(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	const source = publicationInput(bridgePayload(data), false);
	const editorState = await ensureState(options.editor);
	const job = exactPublicationJob(editorState, source);
	return inspectGenerativeAssetPublication(publicationLease(job), source, options.editor);
}

/** Applies one exact publication plan and records its importer/provenance evidence in the retained job. */
export async function publishGenerativeAssetCandidateAction(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<object> {
	const source = publicationInput(bridgePayload(data), true);
	const editorState = await ensureState(options.editor);
	const job = exactPublicationJob(editorState, source);
	if (job.publicationActive) {
		throw new Error(`Generative job ${job.snapshot.id} already has an active publication; wait for it to finish and inspect the new revision.`);
	}
	job.publicationActive = true;
	const lease = publicationLease(job);
	const operation = publishGenerativeAssetCandidate(lease, source, options.editor, async (publication) => {
		if (
			editorState.disposed ||
			editorState.projectRoot !== job.root ||
			editorState.jobs.get(job.snapshot.id) !== job ||
			projectDirectory() !== job.root ||
			job.snapshot.revision !== lease.revision ||
			job.snapshot.resultFingerprint !== lease.resultFingerprint
		) {
			throw new Error(`Generative job ${job.snapshot.id} changed during publication; inspect again with expectedRevision ${job.snapshot.revision}.`);
		}
		const previous = clone(job.snapshot);
		job.snapshot.publications.push(publication);
		job.snapshot.revision++;
		job.snapshot.progress = {
			phase: "published",
			message: `${publication.files.length} generated asset file(s) were published through the normal registry and importer pipeline.`,
		};
		try {
			await persistJob(job);
		} catch (error) {
			job.snapshot = previous;
			throw error;
		}
	});
	editorState.activePublications.add(operation);
	try {
		const record = await operation;
		await options.editor.layout.assets?.refresh?.();
		void options.editor.layout.graph?.refresh?.();
		options.editor.layout.inspector?.forceUpdate?.();
		notify(editorState);
		return { publication: record, job: publicJob(job) };
	} finally {
		job.publicationActive = false;
		editorState.activePublications.delete(operation);
	}
}

/** Returns one bounded verified preview payload without exposing private staging paths. */
export async function getGenerativeAssetPreview(_scene: Scene, data: any, options: IMCPActionOptions): Promise<object> {
	data = bridgePayload(data);
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data?.jobId);
	if (job.snapshot.status !== "succeeded" || !job.snapshot.resultFingerprint) {
		throw new Error("Generative previews are available only after a job succeeds.");
	}
	if (data?.expectedResultFingerprint !== job.snapshot.resultFingerprint) {
		throw new Error(`Generative result changed; use expectedResultFingerprint ${job.snapshot.resultFingerprint}.`);
	}
	const candidate = job.snapshot.candidates.find((entry) => entry.id === data?.candidateId);
	if (!candidate) {
		throw new Error(`Generative candidate "${String(data?.candidateId)}" was not found.`);
	}
	if (!candidate.preview) {
		return { available: false, jobId: job.snapshot.id, candidateId: candidate.id, reason: "The provider returned no bounded visual/audio preview for this candidate." };
	}
	const maximumBytes = data?.maximumBytes ?? maximumPreviewBytes;
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > maximumPreviewBytes) {
		throw new Error(`maximumBytes must be an integer from 1 through ${maximumPreviewBytes}.`);
	}
	if (candidate.preview.sizeBytes > maximumBytes) {
		return {
			available: false,
			jobId: job.snapshot.id,
			candidateId: candidate.id,
			mediaType: candidate.preview.mediaType,
			sizeBytes: candidate.preview.sizeBytes,
			reason: "Preview exceeds maximumBytes.",
		};
	}
	const path = join(job.directory, candidate.preview.path);
	const [details, resolved, jobReal] = await Promise.all([lstat(path), realpath(path), realpath(job.directory)]);
	if (details.isSymbolicLink() || !details.isFile() || !projectPathContains(jobReal, resolved) || details.size !== candidate.preview.sizeBytes) {
		throw new Error("Generative preview staging evidence changed; retry the generation job.");
	}
	const bytes = await readFile(resolved);
	if (sha256(bytes) !== candidate.preview.sha256) {
		throw new Error("Generative preview SHA-256 changed; retry the generation job.");
	}
	return {
		available: true,
		jobId: job.snapshot.id,
		candidateId: candidate.id,
		mediaType: candidate.preview.mediaType,
		sha256: candidate.preview.sha256,
		sizeBytes: bytes.byteLength,
		dataBase64: bytes.toString("base64"),
	};
}

/** Deletes one terminal private staging job under its exact revision; published project assets are unaffected. */
export async function deleteGenerativeAssetJob(_scene: Scene, data: any, options: IMCPActionOptions): Promise<object> {
	data = bridgePayload(data);
	if (data?.confirm !== true) {
		throw new Error("Deleting generative job staging requires confirm=true.");
	}
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data.jobId);
	expectedRevision(job, data.expectedRevision);
	if (job.publicationActive) {
		throw new Error("Wait for the active generative publication to finish before deleting its retained staging job.");
	}
	if (["queued", "running", "canceling"].includes(job.snapshot.status)) {
		throw new Error("Cancel and wait for the generative job to reach a terminal state before deleting its staging data.");
	}
	const temporary = `${job.directory}.${randomUUID()}.delete`;
	await move(job.directory, temporary);
	try {
		editorState.jobs.delete(job.snapshot.id);
		await remove(temporary);
		notify(editorState);
		return { deleted: true, jobId: job.snapshot.id, publishedAssetsAffected: false };
	} catch (error) {
		editorState.jobs.set(job.snapshot.id, job);
		await move(temporary, job.directory, { overwrite: false }).catch(() => undefined);
		throw error;
	}
}

/** Lets the permanent workspace observe the exact provider/job owner used by MCP. */
export function getGenerativeAssetsChangedObservable(editor: Editor): Observable<void> {
	return state(editor).changed;
}

/** Terminates retained providers and clears one editor-lifetime owner during transport/editor shutdown. */
export async function shutdownGenerativeAssets(editor: Editor): Promise<void> {
	const owner = stateOwner(editor);
	const editorState = states.get(owner);
	if (!editorState) {
		return;
	}
	editorState.disposed = true;
	const persistence: Promise<void>[] = [];
	for (const job of editorState.jobs.values()) {
		if (job.snapshot.status === "queued") {
			job.snapshot.cancelRequested = true;
			job.snapshot.status = "canceled";
			job.snapshot.completedAt = new Date().toISOString();
			job.snapshot.progress = { phase: "canceled", message: "The Editor shut down before provider execution." };
			job.snapshot.revision++;
			persistence.push(persistJob(job));
		} else if (["running", "canceling"].includes(job.snapshot.status)) {
			job.snapshot.cancelRequested = true;
			job.controller?.abort();
			terminate(job);
		}
	}
	await Promise.allSettled(persistence);
	await Promise.allSettled([...editorState.activePromises]);
	await Promise.allSettled([...editorState.activePublications]);
	editorState.changed.clear();
	activeStates.delete(editorState);
	states.delete(owner);
}

/** Process-wide emergency shutdown used by Electron teardown. */
export async function shutdownAllGenerativeAssets(): Promise<void> {
	const persistence: Promise<void>[] = [];
	for (const editorState of activeStates) {
		editorState.disposed = true;
		for (const job of editorState.jobs.values()) {
			if (job.snapshot.status === "queued") {
				job.snapshot.cancelRequested = true;
				job.snapshot.status = "canceled";
				job.snapshot.completedAt = new Date().toISOString();
				job.snapshot.progress = { phase: "canceled", message: "The Editor process shut down before provider execution." };
				job.snapshot.revision++;
				persistence.push(persistJob(job));
			} else if (["running", "canceling"].includes(job.snapshot.status)) {
				job.snapshot.cancelRequested = true;
				job.controller?.abort();
				terminate(job);
			}
		}
	}
	await Promise.allSettled(persistence);
	await Promise.allSettled([...activeStates].flatMap((editorState) => [...editorState.activePromises]));
	await Promise.allSettled([...activeStates].flatMap((editorState) => [...editorState.activePublications]));
	activeStates.clear();
}

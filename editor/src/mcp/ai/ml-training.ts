import { ChildProcess, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { constants as fsConstants } from "fs";
import { access, lstat, mkdir, realpath } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

import { ensureDir, move, pathExists, readFile, readJSON, remove, rename, writeFile, writeJSON } from "fs-extra";
import { Observable, Scene } from "babylonjs";
import {
	configureMlTrainingRuntime,
	getMlTrainingRuntime,
	IMlTrainingBehavior,
	IMlTrainingConfiguration,
	IMlTrainingEpisode,
	IMlTrainingMetric,
	IMlTrainingSettings,
	inspectRuntimeAiModelGraph,
	ML_TRAINING_CONTRACT,
	ML_TRAINING_CONTRACT_VERSION,
	mlActionOutputSize,
	mlObservationSize,
	mlTrainingAlgorithms,
	normalizeMlTrainingConfiguration,
	normalizeMlTrainingEpisode,
	normalizeMlTrainingSettings,
	trainPortableBehaviorCloning,
	validateMlPolicyOnnx,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths, writeAssetMetadata } from "../assets/registry";
import { ensureProjectStoreDirectory, projectPathContains } from "../project/project-store";
import { inspectRuntimeAiModel } from "./runtime-inference";

const maximumEpisodes = 10_000;
const maximumDatasetSteps = 100_000;
const maximumDatasetBytes = 32 * 1024 * 1024;
const maximumJobs = 32;
const maximumQueuedJobs = 4;
const maximumConcurrentJobs = 1;
const maximumModelBytes = 256 * 1024 * 1024;
const maximumDiagnosticsBytes = 64 * 1024;
const maximumMetrics = 10_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const terminalStatuses = new Set<MlTrainingJobStatus>(["succeeded", "failed", "canceled", "timed-out"]);

export interface IMlTrainingProviderManifest {
	version: 1;
	id: string;
	name: string;
	algorithms: Array<"ppo" | "sac" | "imitation" | "external">;
	executable: string;
	args: string[];
	credentialEnvironments: string[];
	maximumDurationSeconds: number;
}

export interface IMlTrainingProviderDescriptor {
	id: string;
	name: string;
	builtIn: boolean;
	algorithms: string[];
	fingerprint: string;
	available: boolean;
	warnings: string[];
	manifest: IMlTrainingProviderManifest | null;
}

export type MlTrainingJobStatus = "queued" | "running" | "canceling" | "succeeded" | "failed" | "canceled" | "timed-out";

export interface IMlTrainingJobResult {
	modelFormat: "onnx";
	modelSha256: string;
	modelBytes: number;
	inputName: string;
	outputName: string;
	inputSize: number;
	outputSize: number;
	metrics: IMlTrainingMetric[];
	metricsTruncated: boolean;
}

export interface IMlTrainingPublicationRecord {
	revision: number;
	path: string;
	modelSha256: string;
	metadataSha256: string;
	providerId: string;
	algorithm: string;
	publishedAt: string;
}

export interface IMlTrainingJobSnapshot {
	id: string;
	revision: number;
	status: MlTrainingJobStatus;
	provider: Omit<IMlTrainingProviderDescriptor, "manifest" | "available" | "warnings">;
	behavior: IMlTrainingBehavior;
	configurationRevision: number;
	datasetFingerprint: string;
	datasetEpisodes: number;
	datasetSteps: number;
	settings: IMlTrainingSettings;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	attempt: number;
	sourceJobId: string | null;
	cancelRequested: boolean;
	progress: { phase: string; message: string };
	execution: { durationMilliseconds: number | null; exitCode: number | null; diagnostics: string; diagnosticsTruncated: boolean };
	resultFingerprint: string | null;
	result: IMlTrainingJobResult | null;
	publications: IMlTrainingPublicationRecord[];
	error: string | null;
}

interface IInternalMlTrainingJob {
	snapshot: IMlTrainingJobSnapshot;
	root: string;
	directory: string;
	modelPath: string;
	datasetPath: string;
	provider: IMlTrainingProviderDescriptor;
	child: ChildProcess | null;
	timeout: ReturnType<typeof setTimeout> | null;
	rawDiagnostics: string;
	rawDiagnosticsTruncated: boolean;
	secrets: string[];
	publicationActive: boolean;
}

interface IMlTrainingEditorState {
	projectRoot: string | null;
	loaded: boolean;
	loadPromise: Promise<void> | null;
	episodes: IMlTrainingEpisode[];
	providers: IMlTrainingProviderDescriptor[];
	jobs: Map<string, IInternalMlTrainingJob>;
	active: number;
	disposed: boolean;
	changed: Observable<void>;
}

const states = new WeakMap<object, IMlTrainingEditorState>();
const activeStates = new Set<IMlTrainingEditorState>();

function owner(editor: Editor): object {
	return editor.sceneWorkspace ?? editor;
}

function state(editor: Editor): IMlTrainingEditorState {
	const key = owner(editor);
	let value = states.get(key);
	if (!value || value.disposed) {
		value = {
			projectRoot: null,
			loaded: false,
			loadPromise: null,
			episodes: [],
			providers: [],
			jobs: new Map(),
			active: 0,
			disposed: false,
			changed: new Observable<void>(),
		};
		states.set(key, value);
		activeStates.add(value);
	}
	return value;
}

function bridgePayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const { endpoint: _endpoint, collaborationToken: _collaborationToken, ...domain } = value as Record<string, unknown>;
	return domain;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function exact(source: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !identifierPattern.test(value)) {
		throw new Error(`${label} is invalid.`);
	}
	return value;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function root(): string {
	if (!projectConfiguration.path) {
		throw new Error("Open an editor project before using ML Training.");
	}
	return dirname(projectConfiguration.path);
}

function configuration(scene: Scene): IMlTrainingConfiguration {
	return normalizeMlTrainingConfiguration(scene.metadata?.babylonEditorMlTraining);
}

function behavior(scene: Scene, id: unknown): IMlTrainingBehavior {
	const value = configuration(scene).behaviors.find((entry) => entry.id === id);
	if (!value) {
		throw new Error(`ML behavior ${String(id)} was not found.`);
	}
	return value;
}

function datasetFingerprint(behaviorValue: IMlTrainingBehavior, episodes: IMlTrainingEpisode[]): string {
	return sha256(JSON.stringify({ contract: ML_TRAINING_CONTRACT, version: 1, behavior: behaviorValue, episodes }));
}

function providerFingerprint(value: IMlTrainingProviderManifest): string {
	return sha256(JSON.stringify(value));
}

function builtInProvider(): IMlTrainingProviderDescriptor {
	return {
		id: "zvibe-portable-behavior-cloning",
		name: "Zvibe Portable Behavior Cloning",
		builtIn: true,
		algorithms: ["behavior-cloning"],
		fingerprint: sha256("zvibe-portable-behavior-cloning-v1"),
		available: true,
		warnings: ["The built-in baseline learns a deterministic linear policy from recorded demonstrations; PPO/SAC require an external executable provider."],
		manifest: null,
	};
}

function normalizeProvider(value: unknown): IMlTrainingProviderManifest {
	const source = object(value, "ML training provider");
	exact(source, ["version", "id", "name", "algorithms", "executable", "args", "credentialEnvironments", "maximumDurationSeconds"], "ML training provider");
	if (source.version !== 1) {
		throw new Error("ML training provider version must be 1.");
	}
	const id = identifier(source.id, "ML training provider id");
	if (id === "zvibe-portable-behavior-cloning") {
		throw new Error("The built-in ML provider id is reserved.");
	}
	if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128) {
		throw new Error("ML training provider name is invalid.");
	}
	if (!Array.isArray(source.algorithms) || !source.algorithms.length || source.algorithms.length > 4) {
		throw new Error("ML training provider algorithms must contain from 1 through 4 entries.");
	}
	const algorithms = [...new Set(source.algorithms)] as IMlTrainingProviderManifest["algorithms"];
	if (algorithms.some((entry) => !["ppo", "sac", "imitation", "external"].includes(entry))) {
		throw new Error("ML training provider algorithm is unsupported.");
	}
	if (typeof source.executable !== "string" || !source.executable.trim() || source.executable.length > 1024 || /[\r\n\0]/.test(source.executable)) {
		throw new Error("ML training provider executable is invalid.");
	}
	if (!Array.isArray(source.args) || source.args.length > 32 || source.args.some((entry) => typeof entry !== "string" || entry.length > 1024 || /[\r\n\0]/.test(entry))) {
		throw new Error("ML training provider args must contain at most 32 bounded strings.");
	}
	if (
		!Array.isArray(source.credentialEnvironments) ||
		source.credentialEnvironments.length > 32 ||
		source.credentialEnvironments.some((entry) => typeof entry !== "string" || !environmentPattern.test(entry))
	) {
		throw new Error("ML training provider credentials must contain environment-variable names only.");
	}
	if (
		typeof source.maximumDurationSeconds !== "number" ||
		!Number.isSafeInteger(source.maximumDurationSeconds) ||
		source.maximumDurationSeconds < 1 ||
		source.maximumDurationSeconds > 86400
	) {
		throw new Error("ML training provider maximumDurationSeconds must be an integer from 1 through 86400.");
	}
	const maximumDurationSeconds = source.maximumDurationSeconds;
	return {
		version: 1,
		id,
		name: source.name.trim(),
		algorithms,
		executable: source.executable,
		args: [...source.args] as string[],
		credentialEnvironments: [...new Set(source.credentialEnvironments)] as string[],
		maximumDurationSeconds,
	};
}

async function providerDescriptor(manifest: IMlTrainingProviderManifest): Promise<IMlTrainingProviderDescriptor> {
	const warnings: string[] = [];
	let available = manifest.credentialEnvironments.every((name) => Boolean(process.env[name]));
	manifest.credentialEnvironments.filter((name) => !process.env[name]).forEach((name) => warnings.push(`Credential environment variable ${name} is unavailable.`));
	if (isAbsolute(manifest.executable)) {
		const details = await lstat(manifest.executable).catch(() => null);
		if (!details?.isFile() || details.isSymbolicLink()) {
			available = false;
			warnings.push("The configured absolute executable is unavailable or symbolic.");
		} else {
			await access(manifest.executable, fsConstants.X_OK).catch(() => {
				available = false;
				warnings.push("The configured executable is not executable.");
			});
		}
	}
	return {
		id: manifest.id,
		name: manifest.name,
		builtIn: false,
		algorithms: [...manifest.algorithms],
		fingerprint: providerFingerprint(manifest),
		available,
		warnings,
		manifest,
	};
}

async function storeDirectory(projectRoot: string): Promise<string> {
	return ensureProjectStoreDirectory(projectRoot, ".bjseditor", "ml-training");
}

async function ensureSafeParent(projectRoot: string, target: string): Promise<void> {
	const rootReal = await realpath(projectRoot);
	const parent = dirname(target);
	const child = relative(projectRoot, parent);
	if (!child || child === "." || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error("ML checkpoint parent must be a child directory inside the project.");
	}
	let current = projectRoot;
	for (const segment of child.split(/[\\/]+/)) {
		if (!segment || segment === "." || segment === "..") {
			throw new Error("ML checkpoint parent contains unsafe path segments.");
		}
		current = join(current, segment);
		let details = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") {
				throw error;
			}
			return null;
		});
		if (!details) {
			await mkdir(current);
			details = await lstat(current);
		}
		if (details.isSymbolicLink() || !details.isDirectory()) {
			throw new Error("ML checkpoint parent directories must be real directories, not symbolic links.");
		}
		if (!projectPathContains(rootReal, await realpath(current))) {
			throw new Error("ML checkpoint parent resolves outside the project.");
		}
	}
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeJSON(temporary, value, { spaces: "\t" });
	await rename(temporary, path);
}

async function load(editorState: IMlTrainingEditorState): Promise<void> {
	const currentRoot = root();
	if (editorState.loaded && editorState.projectRoot === currentRoot) {
		return;
	}
	if (editorState.loadPromise) {
		return editorState.loadPromise;
	}
	editorState.loadPromise = (async () => {
		for (const job of editorState.jobs.values()) {
			terminate(job);
		}
		editorState.jobs.clear();
		editorState.active = 0;
		editorState.projectRoot = currentRoot;
		editorState.episodes = [];
		editorState.providers = [];
		const directory = await storeDirectory(currentRoot);
		const episodePath = join(directory, "episodes.json");
		const providerPath = join(directory, "providers.json");
		if (await pathExists(episodePath)) {
			const details = await lstat(episodePath);
			if (details.isSymbolicLink() || !details.isFile() || details.size > maximumDatasetBytes) {
				throw new Error("ML training episode store is unsafe or exceeds 32 MiB.");
			}
			const raw = await readJSON(episodePath);
			if (!Array.isArray(raw) || raw.length > maximumEpisodes) {
				throw new Error("ML training episode store is invalid.");
			}
			editorState.episodes = raw as IMlTrainingEpisode[];
		}
		if (await pathExists(providerPath)) {
			const details = await lstat(providerPath);
			if (details.isSymbolicLink() || !details.isFile() || details.size > 1024 * 1024) {
				throw new Error("ML training provider store is unsafe or exceeds 1 MiB.");
			}
			const raw = await readJSON(providerPath);
			if (!Array.isArray(raw) || raw.length > 32) {
				throw new Error("ML training provider store is invalid.");
			}
			editorState.providers = await Promise.all(raw.map((entry) => providerDescriptor(normalizeProvider(entry))));
		}
		editorState.loaded = true;
	})();
	try {
		await editorState.loadPromise;
	} finally {
		editorState.loadPromise = null;
	}
}

async function ensureState(editor: Editor): Promise<IMlTrainingEditorState> {
	const value = state(editor);
	await load(value);
	return value;
}

async function persistEpisodes(editorState: IMlTrainingEditorState): Promise<void> {
	const bytes = Buffer.byteLength(JSON.stringify(editorState.episodes), "utf8");
	if (bytes > maximumDatasetBytes) {
		throw new Error("ML training dataset would exceed 32 MiB.");
	}
	await atomicJson(join(await storeDirectory(editorState.projectRoot!), "episodes.json"), editorState.episodes);
}

async function persistProviders(editorState: IMlTrainingEditorState): Promise<void> {
	await atomicJson(
		join(await storeDirectory(editorState.projectRoot!), "providers.json"),
		editorState.providers.map((entry) => entry.manifest)
	);
}

function notify(editorState: IMlTrainingEditorState): void {
	editorState.changed.notifyObservers();
}

function publicJob(job: IInternalMlTrainingJob): IMlTrainingJobSnapshot {
	return clone(job.snapshot);
}

function exactJob(editorState: IMlTrainingEditorState, id: unknown): IInternalMlTrainingJob {
	identifier(id, "ML training job id");
	const job = editorState.jobs.get(id as string);
	if (!job) {
		throw new Error(`ML training job ${String(id)} was not found.`);
	}
	return job;
}

function expectedRevision(job: IInternalMlTrainingJob, value: unknown): void {
	if (value !== job.snapshot.revision) {
		throw new Error(`ML training job ${job.snapshot.id} changed; use expectedRevision ${job.snapshot.revision}.`);
	}
}

function redact(value: string, secrets: string[]): string {
	let result = value.replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
	for (const secret of secrets.filter(Boolean)) {
		result = result.replaceAll(secret, "[redacted]");
	}
	return result;
}

function captureDiagnostics(job: IInternalMlTrainingJob, chunk: Buffer | string): void {
	if (job.rawDiagnostics.length >= maximumDiagnosticsBytes) {
		job.rawDiagnosticsTruncated = true;
		return;
	}
	const value = chunk.toString();
	const remaining = maximumDiagnosticsBytes - job.rawDiagnostics.length;
	job.rawDiagnostics += value.slice(0, remaining);
	if (value.length > remaining) {
		job.rawDiagnosticsTruncated = true;
	}
}

function terminate(job: IInternalMlTrainingJob): void {
	if (job.timeout) {
		clearTimeout(job.timeout);
	}
	job.timeout = null;
	if (job.child && !job.child.killed) {
		job.child.kill("SIGTERM");
		setTimeout(() => job.child && !job.child.killed && job.child.kill("SIGKILL"), 1000).unref?.();
	}
}

function metrics(value: unknown): { metrics: IMlTrainingMetric[]; truncated: boolean } {
	if (!Array.isArray(value)) {
		throw new Error("ML trainer result metrics must be an array.");
	}
	const truncated = value.length > maximumMetrics;
	const normalized = value.slice(0, maximumMetrics).map((entry, index): IMlTrainingMetric => {
		const source = object(entry, `metrics[${index}]`);
		exact(source, ["step", "epoch", "loss", "meanReward"], `metrics[${index}]`);
		for (const key of ["step", "epoch", "loss", "meanReward"] as const) {
			if (typeof source[key] !== "number" || !Number.isFinite(source[key])) {
				throw new Error(`metrics[${index}].${key} must be finite.`);
			}
		}
		return { step: source.step as number, epoch: source.epoch as number, loss: source.loss as number, meanReward: source.meanReward as number };
	});
	return { metrics: normalized, truncated };
}

async function validateModel(job: IInternalMlTrainingJob, resultMetrics: unknown, inputName: unknown, outputName: unknown): Promise<IMlTrainingJobResult> {
	const details = await lstat(job.modelPath);
	if (details.isSymbolicLink() || !details.isFile() || details.size < 1 || details.size > maximumModelBytes) {
		throw new Error("ML trainer ONNX output is unsafe or outside the 1-byte through 256-MiB bound.");
	}
	const resolved = await realpath(job.modelPath);
	const realDirectory = await realpath(job.directory);
	if (!projectPathContains(realDirectory, resolved)) {
		throw new Error("ML trainer ONNX output resolves outside its job directory.");
	}
	const bytes = await readFile(resolved);
	const graph = inspectRuntimeAiModelGraph("onnx", bytes);
	const parsedMetrics = metrics(resultMetrics);
	const actualInput = typeof inputName === "string" && graph.inputs.includes(inputName) ? inputName : graph.inputs[0];
	const actualOutput = typeof outputName === "string" && graph.outputs.includes(outputName) ? outputName : graph.outputs[0];
	if (!actualInput || !actualOutput) {
		throw new Error("ML trainer ONNX model requires at least one input and output.");
	}
	const inputSize = mlObservationSize(job.snapshot.behavior);
	const outputSize = mlActionOutputSize(job.snapshot.behavior.actions);
	validateMlPolicyOnnx(bytes, inputSize, outputSize, actualInput, actualOutput);
	return {
		modelFormat: "onnx",
		modelSha256: sha256(bytes),
		modelBytes: bytes.byteLength,
		inputName: actualInput,
		outputName: actualOutput,
		inputSize,
		outputSize,
		metrics: parsedMetrics.metrics,
		metricsTruncated: parsedMetrics.truncated,
	};
}

async function runBuiltIn(job: IInternalMlTrainingJob): Promise<IMlTrainingJobResult> {
	const dataset = await readJSON(job.datasetPath);
	const work = job.snapshot.datasetSteps * job.snapshot.settings.epochs * mlObservationSize(job.snapshot.behavior) * mlActionOutputSize(job.snapshot.behavior.actions);
	if (work > 100_000_000) {
		throw new Error("Built-in ML training work exceeds the 100-million-operation ceiling; reduce episodes/epochs or use an external provider.");
	}
	const result = trainPortableBehaviorCloning(dataset, job.snapshot.settings);
	await writeFile(job.modelPath, result.model);
	return validateModel(job, result.metrics, result.inputName, result.outputName);
}

async function runExternal(job: IInternalMlTrainingJob): Promise<IMlTrainingJobResult> {
	const manifest = job.provider.manifest!;
	const request = {
		contract: ML_TRAINING_CONTRACT,
		version: ML_TRAINING_CONTRACT_VERSION,
		jobId: job.snapshot.id,
		behavior: job.snapshot.behavior,
		settings: job.snapshot.settings,
		datasetPath: job.datasetPath,
		outputDirectory: job.directory,
		resultContract: { modelPath: "policy.onnx", metrics: "bounded array", inputName: "optional", outputName: "optional" },
	};
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", ...manifest.credentialEnvironments]) {
		if (process.env[name] !== undefined) {
			environment[name] = process.env[name];
		}
	}
	job.secrets = manifest.credentialEnvironments.map((name) => process.env[name] ?? "").filter(Boolean);
	return new Promise<IMlTrainingJobResult>((resolvePromise, rejectPromise) => {
		const child = spawn(manifest.executable, manifest.args, { cwd: job.directory, env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		job.child = child;
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			if (stdout.length < maximumDiagnosticsBytes) {
				stdout += chunk.toString().slice(0, maximumDiagnosticsBytes - stdout.length);
			}
		});
		child.stderr?.on("data", (chunk) => captureDiagnostics(job, chunk));
		child.on("error", rejectPromise);
		job.timeout = setTimeout(() => {
			job.snapshot.status = "timed-out";
			terminate(job);
			rejectPromise(new Error(`ML training provider timed out after ${manifest.maximumDurationSeconds} seconds.`));
		}, manifest.maximumDurationSeconds * 1000);
		child.on("close", async (code) => {
			if (job.timeout) {
				clearTimeout(job.timeout);
			}
			job.timeout = null;
			job.snapshot.execution.exitCode = code;
			if (job.snapshot.cancelRequested) {
				return rejectPromise(new Error("ML training provider was canceled."));
			}
			if (code !== 0) {
				return rejectPromise(new Error(`ML training provider exited with code ${code}.`));
			}
			try {
				const result = object(JSON.parse(stdout), "ML training provider result");
				exact(result, ["modelPath", "metrics", "inputName", "outputName"], "ML training provider result");
				if (result.modelPath !== "policy.onnx") {
					throw new Error("ML training provider modelPath must be policy.onnx.");
				}
				resolvePromise(await validateModel(job, result.metrics, result.inputName, result.outputName));
			} catch (error) {
				rejectPromise(error);
			}
		});
		child.stdin?.end(`${JSON.stringify(request)}\n`);
	});
}

async function execute(job: IInternalMlTrainingJob, editorState: IMlTrainingEditorState, editor: Editor): Promise<void> {
	const started = Date.now();
	job.snapshot.status = "running";
	job.snapshot.startedAt = new Date().toISOString();
	job.snapshot.revision++;
	job.snapshot.progress = { phase: "training", message: `${job.snapshot.provider.name} is training ${job.snapshot.behavior.name}.` };
	notify(editorState);
	try {
		const result = job.provider.builtIn ? await runBuiltIn(job) : await runExternal(job);
		if (job.snapshot.cancelRequested || editorState.disposed || editorState.projectRoot !== root()) {
			throw new Error("ML training result arrived after cancellation or project switch.");
		}
		job.snapshot.result = result;
		job.snapshot.resultFingerprint = sha256(
			JSON.stringify({ result, datasetFingerprint: job.snapshot.datasetFingerprint, settings: job.snapshot.settings, provider: job.snapshot.provider })
		);
		job.snapshot.status = "succeeded";
		job.snapshot.progress = { phase: "complete", message: `Training completed with ${result.metrics.length} retained metric sample(s).` };
	} catch (error) {
		if (job.snapshot.cancelRequested) {
			job.snapshot.status = "canceled";
			job.snapshot.progress = { phase: "canceled", message: "Training canceled; no checkpoint was accepted." };
		} else if ((job.snapshot.status as MlTrainingJobStatus) !== "timed-out") {
			job.snapshot.status = "failed";
			job.snapshot.progress = { phase: "failed", message: "Training failed; inspect the contained error and diagnostics." };
		}
		job.snapshot.error = redact(error instanceof Error ? error.message : String(error), job.secrets).slice(0, 4096);
	} finally {
		terminate(job);
		job.child = null;
		job.snapshot.completedAt = new Date().toISOString();
		job.snapshot.execution.durationMilliseconds = Date.now() - started;
		job.snapshot.execution.diagnostics = redact(job.rawDiagnostics, job.secrets);
		job.snapshot.execution.diagnosticsTruncated = job.rawDiagnosticsTruncated;
		job.secrets = [];
		job.snapshot.revision++;
		editorState.active = Math.max(0, editorState.active - 1);
		notify(editorState);
		schedule(editorState, editor);
	}
}

function schedule(editorState: IMlTrainingEditorState, editor: Editor): void {
	if (editorState.disposed) {
		return;
	}
	while (editorState.active < maximumConcurrentJobs) {
		const job = [...editorState.jobs.values()].find((entry) => entry.snapshot.status === "queued");
		if (!job) {
			break;
		}
		editorState.active++;
		void execute(job, editorState, editor);
	}
}

function provider(editorState: IMlTrainingEditorState, id: unknown): IMlTrainingProviderDescriptor {
	identifier(id, "ML training provider id");
	const value = [builtInProvider(), ...editorState.providers].find((entry) => entry.id === id);
	if (!value) {
		throw new Error(`ML training provider ${String(id)} was not found.`);
	}
	return value;
}

function episodesFor(editorState: IMlTrainingEditorState, behaviorId: string): IMlTrainingEpisode[] {
	return editorState.episodes.filter((entry) => entry.behaviorId === behaviorId);
}

export function getMlTrainingCapabilities(_scene: Scene, _data: unknown, options: IMCPActionOptions): object {
	return {
		contract: ML_TRAINING_CONTRACT,
		version: ML_TRAINING_CONTRACT_VERSION,
		algorithms: [...mlTrainingAlgorithms],
		features: {
			agentBridge: true,
			observationAndActionSpaces: true,
			rewardsAndEpisodeBoundaries: true,
			curriculum: true,
			recordedDemonstrations: true,
			builtInBehaviorCloning: true,
			externalPpoSacImitationProviders: true,
			cancellationAndRetry: true,
			metricsAndOnnxCheckpoints: true,
			runtimeAiPublication: true,
			exportedGameRuntime: true,
		},
		limits: {
			behaviors: 128,
			episodes: maximumEpisodes,
			datasetSteps: maximumDatasetSteps,
			datasetBytes: maximumDatasetBytes,
			jobs: maximumJobs,
			queuedJobs: maximumQueuedJobs,
		},
		workspace: Boolean(options.editor.layout),
		nonClaims: [
			"Unity ML-Agents Python package/API/serialization identity",
			"PPO/SAC without an executed external trainer",
			"learned quality without retained metrics and exact checkpoint evidence",
		],
	};
}

export function getMlTrainingConfiguration(scene: Scene): object {
	return { configuration: configuration(scene), runtime: getMlTrainingRuntime(scene as any)?.getState() ?? null };
}

export function setMlTrainingConfiguration(scene: Scene, dataValue: unknown, options: IMCPActionOptions): object {
	const data = object(bridgePayload(dataValue), "set_ml_training_configuration input");
	exact(data, ["expectedRevision", "configuration"], "set_ml_training_configuration input");
	const previous = configuration(scene);
	if (data.expectedRevision !== previous.revision) {
		throw new Error(`ML training configuration changed; use expectedRevision ${previous.revision}.`);
	}
	const input = object(data.configuration, "ML training configuration replacement");
	const next = normalizeMlTrainingConfiguration({ ...input, version: 1, revision: previous.revision + 1 });
	const graphIds = new Set((scene.metadata?.babylonEditorBehaviorTrees ?? []).map((entry: any) => entry?.id));
	for (const entry of next.behaviors) {
		if (entry.behaviorGraphId && !graphIds.has(entry.behaviorGraphId)) {
			throw new Error(`ML behavior ${entry.id} references missing Behavior Graph ${entry.behaviorGraphId}.`);
		}
		for (const nodeId of entry.agentNodeIds) {
			if (!scene.getNodeById(nodeId)) {
				throw new Error(`ML behavior ${entry.id} references missing agent node ${nodeId}.`);
			}
		}
	}
	const oldMetadata = clone(scene.metadata?.babylonEditorMlTraining);
	scene.metadata ??= {};
	scene.metadata.babylonEditorMlTraining = clone(next);
	try {
		if (getMlTrainingRuntime(scene as any)) {
			configureMlTrainingRuntime(scene as any);
		}
	} catch (error) {
		scene.metadata.babylonEditorMlTraining = oldMetadata;
		configureMlTrainingRuntime(scene as any);
		throw error;
	}
	options.editor.layout.inspector?.forceUpdate?.();
	state(options.editor).changed.notifyObservers();
	return { configuration: clone(next) };
}

export async function listMlTrainingProviders(_scene: Scene, _data: unknown, options: IMCPActionOptions): Promise<object> {
	const editorState = await ensureState(options.editor);
	return {
		providers: [builtInProvider(), ...editorState.providers].map((entry) => ({
			...clone(entry),
			manifest: entry.manifest ? { ...entry.manifest, credentialEnvironments: [...entry.manifest.credentialEnvironments] } : null,
		})),
	};
}

export async function setMlTrainingProvider(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "set_ml_training_provider input");
	exact(data, ["provider", "expectedFingerprint"], "set_ml_training_provider input");
	const manifest = normalizeProvider(data.provider);
	const editorState = await ensureState(options.editor);
	const index = editorState.providers.findIndex((entry) => entry.id === manifest.id);
	if (index >= 0 && data.expectedFingerprint !== editorState.providers[index].fingerprint) {
		throw new Error(`ML training provider ${manifest.id} changed; use expectedFingerprint ${editorState.providers[index].fingerprint}.`);
	}
	if (index < 0 && data.expectedFingerprint !== undefined && data.expectedFingerprint !== null) {
		throw new Error("New ML training providers cannot provide expectedFingerprint.");
	}
	const descriptor = await providerDescriptor(manifest);
	if (index >= 0) {
		editorState.providers[index] = descriptor;
	} else {
		editorState.providers.push(descriptor);
	}
	await persistProviders(editorState);
	notify(editorState);
	return { created: index < 0, provider: clone(descriptor) };
}

export async function deleteMlTrainingProvider(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "delete_ml_training_provider input");
	exact(data, ["id", "expectedFingerprint", "confirm"], "delete_ml_training_provider input");
	if (data.confirm !== true) {
		throw new Error("Deleting an ML training provider requires confirm=true.");
	}
	const editorState = await ensureState(options.editor);
	const value = provider(editorState, data.id);
	if (value.builtIn) {
		throw new Error("The built-in ML training provider cannot be deleted.");
	}
	if (data.expectedFingerprint !== value.fingerprint) {
		throw new Error(`ML training provider ${value.id} changed; use expectedFingerprint ${value.fingerprint}.`);
	}
	if ([...editorState.jobs.values()].some((job) => job.provider.id === value.id && !terminalStatuses.has(job.snapshot.status))) {
		throw new Error("An active ML training job still uses this provider.");
	}
	editorState.providers = editorState.providers.filter((entry) => entry.id !== value.id);
	await persistProviders(editorState);
	notify(editorState);
	return { deleted: true, id: value.id };
}

export async function recordMlTrainingEpisode(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "record_ml_training_episode input");
	exact(data, ["expectedConfigurationRevision", "episode"], "record_ml_training_episode input");
	const current = configuration(scene);
	if (data.expectedConfigurationRevision !== current.revision) {
		throw new Error(`ML training configuration changed; use expectedConfigurationRevision ${current.revision}.`);
	}
	const source = object(data.episode, "ML training episode");
	const behaviorValue = behavior(scene, source.behaviorId);
	const episode = normalizeMlTrainingEpisode(source, behaviorValue);
	const editorState = await ensureState(options.editor);
	if (editorState.episodes.length >= maximumEpisodes) {
		throw new Error(`ML training retains at most ${maximumEpisodes} episodes.`);
	}
	if (editorState.episodes.some((entry) => entry.id === episode.id)) {
		throw new Error(`ML training episode ${episode.id} already exists.`);
	}
	const stepCount = editorState.episodes.reduce((total, entry) => total + entry.steps.length, 0) + episode.steps.length;
	if (stepCount > maximumDatasetSteps) {
		throw new Error(`ML training dataset exceeds ${maximumDatasetSteps} steps.`);
	}
	editorState.episodes.push(episode);
	try {
		await persistEpisodes(editorState);
	} catch (error) {
		editorState.episodes.pop();
		throw error;
	}
	notify(editorState);
	return { episode: clone(episode), datasetFingerprint: datasetFingerprint(behaviorValue, episodesFor(editorState, behaviorValue.id)) };
}

export async function listMlTrainingEpisodes(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue) ?? {}, "list_ml_training_episodes input");
	exact(data, ["behaviorId", "offset", "limit"], "list_ml_training_episodes input");
	const behaviorValue = behavior(scene, data.behaviorId);
	const editorState = await ensureState(options.editor);
	const episodes = episodesFor(editorState, behaviorValue.id);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 20;
	if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
		throw new Error("ML episode offset/limit is invalid.");
	}
	return {
		behavior: clone(behaviorValue),
		datasetFingerprint: datasetFingerprint(behaviorValue, episodes),
		total: episodes.length,
		totalSteps: episodes.reduce((total, entry) => total + entry.steps.length, 0),
		offset,
		limit,
		nextOffset: (offset as number) + (limit as number) < episodes.length ? (offset as number) + (limit as number) : null,
		episodes: episodes.slice(offset as number, (offset as number) + (limit as number)).map((entry) => ({
			id: entry.id,
			agentId: entry.agentId,
			lessonId: entry.lessonId,
			steps: entry.steps.length,
			reward: entry.steps.reduce((total, step) => total + step.reward, 0),
			interrupted: entry.steps.at(-1)?.interrupted ?? false,
		})),
	};
}

export async function getMlTrainingEpisode(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "get_ml_training_episode input");
	exact(data, ["behaviorId", "episodeId", "expectedDatasetFingerprint", "stepOffset", "stepLimit"], "get_ml_training_episode input");
	const behaviorValue = behavior(scene, data.behaviorId);
	const editorState = await ensureState(options.editor);
	const episodes = episodesFor(editorState, behaviorValue.id);
	const fingerprint = datasetFingerprint(behaviorValue, episodes);
	if (data.expectedDatasetFingerprint !== fingerprint) {
		throw new Error(`ML training dataset changed; use expectedDatasetFingerprint ${fingerprint}.`);
	}
	const episode = episodes.find((entry) => entry.id === data.episodeId);
	if (!episode) {
		throw new Error(`ML training episode ${String(data.episodeId)} was not found.`);
	}
	const offset = data.stepOffset ?? 0;
	const limit = data.stepLimit ?? 100;
	if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) {
		throw new Error("ML episode step paging is invalid.");
	}
	return {
		episode: { ...clone(episode), steps: episode.steps.slice(offset as number, (offset as number) + (limit as number)) },
		stepPage: {
			total: episode.steps.length,
			offset,
			limit,
			nextOffset: (offset as number) + (limit as number) < episode.steps.length ? (offset as number) + (limit as number) : null,
		},
		datasetFingerprint: fingerprint,
	};
}

export async function clearMlTrainingDataset(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "clear_ml_training_dataset input");
	exact(data, ["behaviorId", "expectedDatasetFingerprint", "confirm"], "clear_ml_training_dataset input");
	if (data.confirm !== true) {
		throw new Error("Clearing an ML training dataset requires confirm=true.");
	}
	const behaviorValue = behavior(scene, data.behaviorId);
	const editorState = await ensureState(options.editor);
	const episodes = episodesFor(editorState, behaviorValue.id);
	const fingerprint = datasetFingerprint(behaviorValue, episodes);
	if (data.expectedDatasetFingerprint !== fingerprint) {
		throw new Error(`ML training dataset changed; use expectedDatasetFingerprint ${fingerprint}.`);
	}
	editorState.episodes = editorState.episodes.filter((entry) => entry.behaviorId !== behaviorValue.id);
	await persistEpisodes(editorState);
	notify(editorState);
	return { cleared: true, behaviorId: behaviorValue.id, removedEpisodes: episodes.length, datasetFingerprint: datasetFingerprint(behaviorValue, []) };
}

async function startJob(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions, attempt = 1, sourceJobId: string | null = null): Promise<IMlTrainingJobSnapshot> {
	if (data.confirm !== true) {
		throw new Error("Starting ML training requires confirm=true because it executes a trainer and writes private checkpoint staging.");
	}
	const current = configuration(scene);
	if (data.expectedConfigurationRevision !== current.revision) {
		throw new Error(`ML training configuration changed; use expectedConfigurationRevision ${current.revision}.`);
	}
	const behaviorValue = behavior(scene, data.behaviorId);
	const editorState = await ensureState(options.editor);
	if (editorState.jobs.size >= maximumJobs) {
		throw new Error(`ML training retains at most ${maximumJobs} jobs; delete a terminal job first.`);
	}
	if ([...editorState.jobs.values()].filter((entry) => entry.snapshot.status === "queued").length >= maximumQueuedJobs) {
		throw new Error(`ML training queue already contains ${maximumQueuedJobs} jobs.`);
	}
	const providerValue = provider(editorState, data.providerId);
	if (!providerValue.available) {
		throw new Error(`ML training provider ${providerValue.id} is unavailable: ${providerValue.warnings.join(" ")}`);
	}
	if (data.expectedProviderFingerprint !== providerValue.fingerprint) {
		throw new Error(`ML training provider changed; use expectedProviderFingerprint ${providerValue.fingerprint}.`);
	}
	const settings = normalizeMlTrainingSettings(data.settings);
	if (!providerValue.algorithms.includes(settings.algorithm)) {
		throw new Error(`ML training provider ${providerValue.id} does not support ${settings.algorithm}.`);
	}
	const episodes = clone(episodesFor(editorState, behaviorValue.id));
	if (!episodes.length) {
		throw new Error(`Record at least one episode for ML behavior ${behaviorValue.id} before training.`);
	}
	const fingerprint = datasetFingerprint(behaviorValue, episodes);
	if (data.expectedDatasetFingerprint !== fingerprint) {
		throw new Error(`ML training dataset changed; use expectedDatasetFingerprint ${fingerprint}.`);
	}
	const id = `ml-training-job-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const jobsDirectory = await ensureProjectStoreDirectory(editorState.projectRoot!, ".bjseditor", "ml-training", "jobs");
	const directory = join(jobsDirectory, id);
	await mkdir(directory);
	const datasetPath = join(directory, "dataset.json");
	await writeJSON(datasetPath, { contract: ML_TRAINING_CONTRACT, version: 1, behavior: behaviorValue, episodes }, { spaces: "\t" });
	const snapshot: IMlTrainingJobSnapshot = {
		id,
		revision: 1,
		status: "queued",
		provider: {
			id: providerValue.id,
			name: providerValue.name,
			builtIn: providerValue.builtIn,
			algorithms: [...providerValue.algorithms],
			fingerprint: providerValue.fingerprint,
		},
		behavior: clone(behaviorValue),
		configurationRevision: current.revision,
		datasetFingerprint: fingerprint,
		datasetEpisodes: episodes.length,
		datasetSteps: episodes.reduce((total, episode) => total + episode.steps.length, 0),
		settings,
		createdAt: new Date().toISOString(),
		startedAt: null,
		completedAt: null,
		attempt,
		sourceJobId,
		cancelRequested: false,
		progress: { phase: "queued", message: "Training is waiting for the bounded execution slot." },
		execution: { durationMilliseconds: null, exitCode: null, diagnostics: "", diagnosticsTruncated: false },
		resultFingerprint: null,
		result: null,
		publications: [],
		error: null,
	};
	const job: IInternalMlTrainingJob = {
		snapshot,
		root: editorState.projectRoot!,
		directory,
		modelPath: join(directory, "policy.onnx"),
		datasetPath,
		provider: clone(providerValue),
		child: null,
		timeout: null,
		rawDiagnostics: "",
		rawDiagnosticsTruncated: false,
		secrets: [],
		publicationActive: false,
	};
	editorState.jobs.set(id, job);
	notify(editorState);
	schedule(editorState, options.editor);
	return publicJob(job);
}

export async function startMlTrainingJob(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<IMlTrainingJobSnapshot> {
	const data = object(bridgePayload(dataValue), "start_ml_training_job input");
	exact(
		data,
		["behaviorId", "expectedConfigurationRevision", "providerId", "expectedProviderFingerprint", "expectedDatasetFingerprint", "settings", "confirm"],
		"start_ml_training_job input"
	);
	return startJob(scene, data, options);
}

export async function listMlTrainingJobs(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue) ?? {}, "list_ml_training_jobs input");
	exact(data, ["status", "behaviorId", "offset", "limit"], "list_ml_training_jobs input");
	const editorState = await ensureState(options.editor);
	let jobs = [...editorState.jobs.values()];
	if (data.status !== undefined) {
		jobs = jobs.filter((entry) => entry.snapshot.status === data.status);
	}
	if (data.behaviorId !== undefined) {
		jobs = jobs.filter((entry) => entry.snapshot.behavior.id === data.behaviorId);
	}
	jobs.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt));
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 20;
	if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
		throw new Error("ML training job paging is invalid.");
	}
	return {
		total: jobs.length,
		offset,
		limit,
		nextOffset: (offset as number) + (limit as number) < jobs.length ? (offset as number) + (limit as number) : null,
		jobs: jobs.slice(offset as number, (offset as number) + (limit as number)).map(publicJob),
	};
}

export async function getMlTrainingJob(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<IMlTrainingJobSnapshot> {
	const data = object(bridgePayload(dataValue), "get_ml_training_job input");
	exact(data, ["jobId"], "get_ml_training_job input");
	return publicJob(exactJob(await ensureState(options.editor), data.jobId));
}

export async function cancelMlTrainingJob(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<IMlTrainingJobSnapshot> {
	const data = object(bridgePayload(dataValue), "cancel_ml_training_job input");
	exact(data, ["jobId", "expectedRevision", "confirm"], "cancel_ml_training_job input");
	if (data.confirm !== true) {
		throw new Error("Canceling ML training requires confirm=true.");
	}
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data.jobId);
	expectedRevision(job, data.expectedRevision);
	if (terminalStatuses.has(job.snapshot.status)) {
		return publicJob(job);
	}
	job.snapshot.cancelRequested = true;
	job.snapshot.revision++;
	if (job.snapshot.status === "queued") {
		job.snapshot.status = "canceled";
		job.snapshot.completedAt = new Date().toISOString();
		job.snapshot.progress = { phase: "canceled", message: "Queued training was canceled before execution." };
	} else {
		job.snapshot.status = "canceling";
		job.snapshot.progress = { phase: "canceling", message: "Trainer termination requested; staged output will not be accepted." };
		terminate(job);
	}
	notify(editorState);
	schedule(editorState, options.editor);
	return publicJob(job);
}

export async function retryMlTrainingJob(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<IMlTrainingJobSnapshot> {
	const data = object(bridgePayload(dataValue), "retry_ml_training_job input");
	exact(
		data,
		["jobId", "expectedRevision", "expectedConfigurationRevision", "expectedProviderFingerprint", "expectedDatasetFingerprint", "confirm"],
		"retry_ml_training_job input"
	);
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data.jobId);
	expectedRevision(job, data.expectedRevision);
	if (!terminalStatuses.has(job.snapshot.status)) {
		throw new Error("Only terminal ML training jobs can be retried.");
	}
	return startJob(
		scene,
		{
			behaviorId: job.snapshot.behavior.id,
			expectedConfigurationRevision: data.expectedConfigurationRevision,
			providerId: job.snapshot.provider.id,
			expectedProviderFingerprint: data.expectedProviderFingerprint,
			expectedDatasetFingerprint: data.expectedDatasetFingerprint,
			settings: job.snapshot.settings,
			confirm: data.confirm,
		},
		options,
		job.snapshot.attempt + 1,
		job.snapshot.id
	);
}

async function publicationPlan(job: IInternalMlTrainingJob, data: Record<string, unknown>): Promise<object> {
	if (job.snapshot.status !== "succeeded" || !job.snapshot.result || !job.snapshot.resultFingerprint) {
		throw new Error("ML checkpoint publication requires a succeeded job.");
	}
	expectedRevision(job, data.expectedRevision);
	if (data.expectedResultFingerprint !== job.snapshot.resultFingerprint) {
		throw new Error(`ML training result changed; use expectedResultFingerprint ${job.snapshot.resultFingerprint}.`);
	}
	if (
		typeof data.path !== "string" ||
		!/^assets\/(?!.*\\)[^\0]{1,1000}\.onnx$/i.test(data.path) ||
		data.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("ML checkpoint path must be a contained .onnx path under assets/.");
	}
	const projectRoot = job.root;
	const target = resolve(projectRoot, data.path);
	if (!projectPathContains(projectRoot, target)) {
		throw new Error("ML checkpoint path resolves outside the project.");
	}
	let existing: Buffer | null = null;
	if (await pathExists(target)) {
		const details = await lstat(target);
		if (details.isSymbolicLink() || !details.isFile() || details.size > maximumModelBytes) {
			throw new Error("Existing ML checkpoint destination is unsafe or oversized.");
		}
		existing = await readFile(target);
	}
	const existingSha256 = existing ? sha256(existing) : null;
	if (existing && data.overwrite !== true) {
		throw new Error("ML checkpoint already exists; choose another path or set overwrite=true.");
	}
	const planFingerprint = sha256(
		JSON.stringify({
			jobId: job.snapshot.id,
			revision: job.snapshot.revision,
			resultFingerprint: job.snapshot.resultFingerprint,
			path: data.path,
			overwrite: data.overwrite === true,
			existingSha256,
		})
	);
	return {
		planFingerprint,
		jobId: job.snapshot.id,
		jobRevision: job.snapshot.revision,
		resultFingerprint: job.snapshot.resultFingerprint,
		path: data.path,
		overwrite: data.overwrite === true,
		existingSha256,
		modelSha256: job.snapshot.result.modelSha256,
		modelBytes: job.snapshot.result.modelBytes,
	};
}

export async function inspectMlTrainingCheckpointPublication(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "inspect_ml_training_checkpoint_publication input");
	exact(data, ["jobId", "expectedRevision", "expectedResultFingerprint", "path", "overwrite"], "inspect_ml_training_checkpoint_publication input");
	return publicationPlan(exactJob(await ensureState(options.editor), data.jobId), data);
}

export async function publishMlTrainingCheckpoint(scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "publish_ml_training_checkpoint input");
	exact(data, ["jobId", "expectedRevision", "expectedResultFingerprint", "path", "overwrite", "expectedPlanFingerprint", "confirm"], "publish_ml_training_checkpoint input");
	if (data.confirm !== true) {
		throw new Error("Publishing an ML checkpoint requires confirm=true.");
	}
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data.jobId);
	if (job.publicationActive) {
		throw new Error("This ML training job already has an active publication.");
	}
	const plan = (await publicationPlan(job, data)) as Record<string, unknown>;
	if (data.expectedPlanFingerprint !== plan.planFingerprint) {
		throw new Error(`ML checkpoint publication plan changed; use expectedPlanFingerprint ${plan.planFingerprint}.`);
	}
	const sourceBytes = await readFile(job.modelPath);
	if (sha256(sourceBytes) !== job.snapshot.result!.modelSha256) {
		throw new Error("ML checkpoint staging changed; retry training.");
	}
	const target = resolve(job.root, data.path as string);
	const sidecar = `${target}${ASSET_META_SUFFIX}`;
	const provenancePath = `${target}.ml-training.json`;
	const backupRoot = join(job.directory, `publication-${randomUUID()}`);
	const backups: Array<{ path: string; backup: string }> = [];
	job.publicationActive = true;
	try {
		await ensureSafeParent(job.root, target);
		for (const path of [target, sidecar, provenancePath]) {
			if (await pathExists(path)) {
				const details = await lstat(path);
				if (details.isSymbolicLink() || !details.isFile()) {
					throw new Error("ML checkpoint publication refuses symbolic or non-file destination artifacts.");
				}
				const backup = join(backupRoot, basename(path));
				await ensureDir(backupRoot);
				await move(path, backup);
				backups.push({ path, backup });
			}
		}
		await writeFile(target, sourceBytes);
		const metadata = await writeAssetMetadata(target, { labels: ["ml-training", job.snapshot.behavior.id], tags: [job.snapshot.settings.algorithm], importer: undefined });
		const provenance = {
			contract: ML_TRAINING_CONTRACT,
			version: 1,
			jobId: job.snapshot.id,
			provider: job.snapshot.provider,
			behaviorId: job.snapshot.behavior.id,
			configurationRevision: job.snapshot.configurationRevision,
			datasetFingerprint: job.snapshot.datasetFingerprint,
			settings: job.snapshot.settings,
			resultFingerprint: job.snapshot.resultFingerprint,
			modelSha256: job.snapshot.result!.modelSha256,
			publishedAt: new Date().toISOString(),
		};
		await writeJSON(provenancePath, provenance, { spaces: "\t" });
		const inspection = await inspectRuntimeAiModel(scene, { modelPath: data.path }, options);
		const metadataSha256 = sha256(await readFile(sidecar));
		const record: IMlTrainingPublicationRecord = {
			revision: job.snapshot.publications.length + 1,
			path: data.path as string,
			modelSha256: job.snapshot.result!.modelSha256,
			metadataSha256,
			providerId: job.snapshot.provider.id,
			algorithm: job.snapshot.settings.algorithm,
			publishedAt: provenance.publishedAt,
		};
		job.snapshot.publications.push(record);
		job.snapshot.revision++;
		job.snapshot.progress = { phase: "published", message: `Checkpoint published to ${record.path} and verified by Runtime AI.` };
		await refreshAssetRegistryPaths([target]);
		await options.editor.layout.assets?.refresh?.();
		options.editor.layout.inspector?.forceUpdate?.();
		notify(editorState);
		await remove(backupRoot).catch(() => undefined);
		return { publication: record, importer: metadata.importer, runtimeAi: inspection, job: publicJob(job) };
	} catch (error) {
		for (const path of [target, sidecar, provenancePath]) {
			await remove(path).catch(() => undefined);
		}
		for (const entry of backups.reverse()) {
			await move(entry.backup, entry.path, { overwrite: true }).catch(() => undefined);
		}
		throw error;
	} finally {
		job.publicationActive = false;
		await remove(backupRoot).catch(() => undefined);
	}
}

export async function deleteMlTrainingJob(_scene: Scene, dataValue: unknown, options: IMCPActionOptions): Promise<object> {
	const data = object(bridgePayload(dataValue), "delete_ml_training_job input");
	exact(data, ["jobId", "expectedRevision", "confirm"], "delete_ml_training_job input");
	if (data.confirm !== true) {
		throw new Error("Deleting ML training job staging requires confirm=true.");
	}
	const editorState = await ensureState(options.editor);
	const job = exactJob(editorState, data.jobId);
	expectedRevision(job, data.expectedRevision);
	if (!terminalStatuses.has(job.snapshot.status) || job.publicationActive) {
		throw new Error("Only an idle terminal ML training job can be deleted.");
	}
	const temporary = `${job.directory}.${randomUUID()}.delete`;
	await move(job.directory, temporary);
	editorState.jobs.delete(job.snapshot.id);
	try {
		await remove(temporary);
		notify(editorState);
		return { deleted: true, jobId: job.snapshot.id, publishedAssetsAffected: false };
	} catch (error) {
		editorState.jobs.set(job.snapshot.id, job);
		await move(temporary, job.directory).catch(() => undefined);
		throw error;
	}
}

export function getMlTrainingChangedObservable(editor: Editor): Observable<void> {
	return state(editor).changed;
}

export async function shutdownMlTraining(editor: Editor): Promise<void> {
	const key = owner(editor);
	const editorState = states.get(key);
	if (!editorState) {
		return;
	}
	editorState.disposed = true;
	for (const job of editorState.jobs.values()) {
		if (!terminalStatuses.has(job.snapshot.status)) {
			job.snapshot.cancelRequested = true;
			terminate(job);
		}
	}
	editorState.changed.clear();
	activeStates.delete(editorState);
	states.delete(key);
}

export function shutdownAllMlTraining(): void {
	for (const editorState of activeStates) {
		editorState.disposed = true;
		for (const job of editorState.jobs.values()) {
			terminate(job);
		}
	}
	activeStates.clear();
}

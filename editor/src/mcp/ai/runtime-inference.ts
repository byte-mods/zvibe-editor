import { createHash } from "crypto";
import { lstat, readFile, realpath, stat } from "fs-extra";
import { dirname, extname, isAbsolute, relative, resolve } from "path/posix";
import { pathToFileURL } from "url";

import { Observable, Scene } from "babylonjs";
import {
	IRuntimeAiRunResult,
	IRuntimeAiSessionDescription,
	IRuntimeAiSessionOptions,
	IRuntimeAiTensorInput,
	getRuntimeAiOnnxExternalDataPaths,
	normalizeRuntimeAiSessionOptions,
	RuntimeAiSession,
} from "babylonjs-editor-tools";
// Opt in to the ONNX Runtime / LiteRT inference runtimes (games opt in with the same import).
import "babylonjs-editor-tools/runtime-ai-backends";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { readAssetMetadata } from "../assets/registry";

const maximumModelBytes = 256 * 1024 * 1024;
const maximumRetainedModelBytes = 512 * 1024 * 1024;
const maximumRetainedSessions = 4;
const maximumListedSessions = 100;
const maximumOutputPreviewValues = 100_000;

export interface IRuntimeAiSessionSnapshot {
	id: string;
	revision: number;
	modelPath: string;
	modelSha256: string;
	modelBytes: number;
	createdAt: string;
	lastRunAt: string | null;
	runCount: number;
	lastDurationMilliseconds: number | null;
	lastError: string | null;
	busy: boolean;
	description: IRuntimeAiSessionDescription;
}

export interface IRuntimeAiModelInspection {
	modelPath: string;
	modelSha256: string;
	modelBytes: number;
	importer: {
		kind: "aiModel";
		settings: Required<IRuntimeAiSessionOptions>;
		includeInBuild: boolean;
	};
	description: IRuntimeAiSessionDescription;
}

export interface IRuntimeAiOutputPreview {
	type: string;
	dims: number[];
	totalValues: number;
	truncated: boolean;
	data: Array<number | boolean | string>;
}

export interface IRuntimeAiInferenceResult {
	session: IRuntimeAiSessionSnapshot;
	elapsedMilliseconds: number;
	outputs: Record<string, IRuntimeAiOutputPreview>;
}

interface IRuntimeAiResolvedModel {
	absolutePath: string;
	modelPath: string;
	modelSha256: string;
	modelBytes: number;
	bytes: Buffer;
	externalData: Array<{ path: string; data: Buffer }>;
	options: Required<IRuntimeAiSessionOptions>;
	includeInBuild: boolean;
}

interface IRuntimeAiOwnedSession {
	runtime: RuntimeAiSession;
	snapshot: IRuntimeAiSessionSnapshot;
}

interface IRuntimeAiEditorState {
	nextId: number;
	sessions: Map<string, IRuntimeAiOwnedSession>;
	creating: number;
	reservedBytes: number;
	changed: Observable<void>;
}

const states = new WeakMap<object, IRuntimeAiEditorState>();

function stateOwner(editor: Editor): object {
	// MCP requests receive a fresh safety Proxy around Editor. sceneWorkspace is a
	// stable, editor-lifetime object exposed unchanged by both the real Editor and
	// every proxy, so UI and MCP calls retain exactly one shared runtime owner.
	return editor.sceneWorkspace ?? editor;
}

function state(editor: Editor): IRuntimeAiEditorState {
	const owner = stateOwner(editor);
	let value = states.get(owner);
	if (!value) {
		value = { nextId: 1, sessions: new Map(), creating: 0, reservedBytes: 0, changed: new Observable<void>() };
		states.set(owner, value);
	}
	return value;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function portablePath(root: string, absolutePath: string): string {
	return relative(root, absolutePath).replace(/\\/g, "/");
}

async function resolveModel(modelPath: unknown): Promise<IRuntimeAiResolvedModel> {
	if (typeof modelPath !== "string" || !modelPath.trim() || modelPath.length > 2048) {
		throw new Error("Runtime AI modelPath must be a non-empty project path of at most 2048 characters.");
	}
	const root = await realpath(projectDirectory());
	const requested = modelPath.trim().replace(/\\/g, "/");
	const candidate = resolve(root, requested);
	const candidateRelative = portablePath(root, candidate);
	if (!candidateRelative || candidateRelative === ".." || candidateRelative.startsWith("../") || isAbsolute(candidateRelative)) {
		throw new Error("Runtime AI models must remain inside the open project directory.");
	}
	const modelExtension = extname(candidate).toLowerCase();
	if (![".onnx", ".tflite", ".pt2"].includes(modelExtension)) {
		throw new Error("Runtime AI supports project .onnx, .tflite, and .pt2 model assets.");
	}
	const linkDetails = await lstat(candidate).catch(() => null);
	if (!linkDetails?.isFile() || linkDetails.isSymbolicLink()) {
		throw new Error(`Runtime AI model does not exist as a regular, non-symbolic-link file: ${candidateRelative}.`);
	}
	const absolutePath = await realpath(candidate);
	const containedRelative = portablePath(root, absolutePath);
	if (!containedRelative || containedRelative === ".." || containedRelative.startsWith("../") || isAbsolute(containedRelative)) {
		throw new Error("Runtime AI model resolves outside the open project directory.");
	}
	const details = await stat(absolutePath);
	if (details.size <= 0 || details.size > maximumModelBytes) {
		throw new Error(`Runtime AI model size must be from 1 byte through ${maximumModelBytes / (1024 * 1024)} MiB.`);
	}
	const metadata = await readAssetMetadata(absolutePath);
	if (metadata.importer.kind !== "aiModel") {
		throw new Error(`Runtime AI model importer is ${metadata.importer.kind}; expected aiModel.`);
	}
	const settings = metadata.importer.settings;
	const modelFormat = modelExtension === ".tflite" ? "litert" : modelExtension === ".pt2" ? "pytorchExport" : "onnx";
	const liteRtPackage = dirname(require.resolve("@litertjs/core/package.json"));
	const options = normalizeRuntimeAiSessionOptions({
		backend: settings.backend as IRuntimeAiSessionOptions["backend"],
		modelFormat,
		graphOptimizationLevel: settings.graphOptimizationLevel as IRuntimeAiSessionOptions["graphOptimizationLevel"],
		executionMode: settings.executionMode as IRuntimeAiSessionOptions["executionMode"],
		enableCpuMemArena: settings.enableCpuMemArena as boolean,
		enableMemPattern: settings.enableMemPattern as boolean,
		wasmNumThreads: settings.wasmNumThreads as number,
		webgpuPreferredLayout: settings.webgpuPreferredLayout as IRuntimeAiSessionOptions["webgpuPreferredLayout"],
		webgpuValidationMode: settings.webgpuValidationMode as IRuntimeAiSessionOptions["webgpuValidationMode"],
		maximumTensorElements: settings.maximumTensorElements as number,
		liteRtWasmPath: pathToFileURL(resolve(liteRtPackage, "wasm")).href + "/",
	});
	const bytes = await readFile(absolutePath);
	const externalData: Array<{ path: string; data: Buffer }> = [];
	let totalBytes = details.size;
	if (modelFormat === "onnx") {
		for (const path of getRuntimeAiOnnxExternalDataPaths(bytes)) {
			const companion = resolve(dirname(absolutePath), path);
			const companionRelative = portablePath(root, companion);
			if (!companionRelative || companionRelative === ".." || companionRelative.startsWith("../") || isAbsolute(companionRelative)) {
				throw new Error(`ONNX external-data file resolves outside the project: ${path}.`);
			}
			const companionDetails = await lstat(companion).catch(() => null);
			if (!companionDetails?.isFile() || companionDetails.isSymbolicLink()) {
				throw new Error(`ONNX external-data file is missing or symbolic: ${path}.`);
			}
			const realCompanion = await realpath(companion);
			const realCompanionRelative = portablePath(root, realCompanion);
			if (!realCompanionRelative || realCompanionRelative === ".." || realCompanionRelative.startsWith("../") || isAbsolute(realCompanionRelative)) {
				throw new Error(`ONNX external-data file resolves outside the project through a symbolic directory: ${path}.`);
			}
			const data = await readFile(realCompanion);
			totalBytes += data.byteLength;
			if (totalBytes > maximumModelBytes) {
				throw new Error(`Runtime AI model plus companion weights exceed ${maximumModelBytes / (1024 * 1024)} MiB.`);
			}
			externalData.push({ path, data });
		}
	}
	const hash = createHash("sha256").update(bytes);
	externalData.forEach((value) => hash.update("\0").update(value.path).update("\0").update(value.data));
	return {
		absolutePath,
		modelPath: containedRelative,
		modelSha256: hash.digest("hex"),
		modelBytes: totalBytes,
		bytes,
		externalData,
		options,
		includeInBuild: settings.includeInBuild !== false,
	};
}

function ownedSession(editor: Editor, id: unknown): IRuntimeAiOwnedSession {
	if (typeof id !== "string" || !/^runtime-ai-[1-9][0-9]*$/.test(id)) {
		throw new Error("Runtime AI session id must use the runtime-ai-N format.");
	}
	const result = state(editor).sessions.get(id);
	if (!result) {
		throw new Error(`Runtime AI session "${id}" was not found.`);
	}
	return result;
}

function expectedRevision(session: IRuntimeAiOwnedSession, value: unknown): void {
	if (!Number.isInteger(value)) {
		throw new Error(`Runtime AI session "${session.snapshot.id}" requires expectedRevision.`);
	}
	if (session.snapshot.revision !== value) {
		throw new Error(`Runtime AI session "${session.snapshot.id}" revision is stale: expected ${value}, current ${session.snapshot.revision}.`);
	}
}

function copySnapshot(value: IRuntimeAiSessionSnapshot): IRuntimeAiSessionSnapshot {
	return structuredClone(value);
}

function notify(editor: Editor): void {
	state(editor).changed.notifyObservers();
}

/** Lets permanent editor UI panels observe the exact session state used by MCP actions. */
export function getRuntimeAiChangedObservable(editor: Editor): Observable<void> {
	return state(editor).changed;
}

export function getRuntimeAiCapabilities(_scene: Scene, _data: any, _options: IMCPActionOptions): any {
	return {
		version: 2,
		modelFormats: ["onnx", "litert", "pytorchExport"],
		backends: ["automatic", "wasm", "webgpu"],
		maximumModelBytes,
		maximumRetainedModelBytes,
		maximumRetainedSessions,
		maximumTensorRank: 8,
		maximumTensorElements: 16_777_216,
		maximumJsonFeedValuesPerTensor: 1_000_000,
		formats: {
			onnx: { runtime: "onnxruntime-web", externalData: true, dynamicShapes: true, timeout: "cooperative termination" },
			litert: { runtime: "@litertjs/core", externalData: false, dynamicShapes: false, timeout: "checked after non-interruptible execution completes" },
			pytorchExport: {
				runtime: "bounded Core ATen to ONNX opset 18 lowering",
				schema: "8.0 through 8.15",
				externalData: false,
				dynamicShapes: false,
				unsupportedOperators: "rejected before session publication",
				timeout: "cooperative termination after lowering",
			},
		},
		features: {
			modelAssetImporter: true,
			modelInspection: true,
			persistentSessions: true,
			boundedJsonTensorFeeds: true,
			selectedOutputs: true,
			timeouts: true,
			wasm: true,
			webgpu: typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu,
			liteRt: true,
			exportedPyTorch: true,
			onnxExternalData: true,
			modelGraphVisualization: true,
		},
	};
}

export async function inspectRuntimeAiModel(_scene: Scene, data: any, _options: IMCPActionOptions): Promise<IRuntimeAiModelInspection> {
	const model = await resolveModel(data.modelPath);
	const runtime = await RuntimeAiSession.Create({ model: model.bytes, externalData: model.externalData }, model.options);
	try {
		return {
			modelPath: model.modelPath,
			modelSha256: model.modelSha256,
			modelBytes: model.modelBytes,
			importer: {
				kind: "aiModel",
				settings: { ...model.options, liteRtWasmPath: model.options.liteRtWasmPath ? "configured" : "" },
				includeInBuild: model.includeInBuild,
			},
			description: structuredClone(runtime.description),
		};
	} finally {
		await runtime.dispose();
	}
}

export async function createRuntimeAiSession(_scene: Scene, data: any, options: IMCPActionOptions): Promise<IRuntimeAiSessionSnapshot> {
	const editorState = state(options.editor);
	const model = await resolveModel(data.modelPath);
	if (data.expectedModelSha256 !== undefined && data.expectedModelSha256 !== model.modelSha256) {
		throw new Error(`Runtime AI model fingerprint is stale: expected ${data.expectedModelSha256}, current ${model.modelSha256}.`);
	}
	if (editorState.sessions.size + editorState.creating >= maximumRetainedSessions) {
		throw new Error(`Runtime AI retains at most ${maximumRetainedSessions} sessions. Dispose one before creating another.`);
	}
	const retainedBytes = [...editorState.sessions.values()].reduce((sum, value) => sum + value.snapshot.modelBytes, 0) + editorState.reservedBytes;
	if (retainedBytes + model.modelBytes > maximumRetainedModelBytes) {
		throw new Error(`Runtime AI retained models would exceed ${maximumRetainedModelBytes / (1024 * 1024)} MiB. Dispose a session first.`);
	}
	editorState.creating++;
	editorState.reservedBytes += model.modelBytes;
	let runtime: RuntimeAiSession;
	try {
		runtime = await RuntimeAiSession.Create({ model: model.bytes, externalData: model.externalData }, model.options);
	} finally {
		editorState.creating--;
		editorState.reservedBytes -= model.modelBytes;
	}
	const now = new Date().toISOString();
	const id = `runtime-ai-${editorState.nextId++}`;
	const snapshot: IRuntimeAiSessionSnapshot = {
		id,
		revision: 1,
		modelPath: model.modelPath,
		modelSha256: model.modelSha256,
		modelBytes: model.modelBytes,
		createdAt: now,
		lastRunAt: null,
		runCount: 0,
		lastDurationMilliseconds: null,
		lastError: null,
		busy: false,
		description: structuredClone(runtime.description),
	};
	editorState.sessions.set(id, { runtime, snapshot });
	notify(options.editor);
	return copySnapshot(snapshot);
}

export function listRuntimeAiSessions(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const offset = Number.isInteger(data.offset) && data.offset >= 0 ? data.offset : 0;
	const limit = Number.isInteger(data.limit) && data.limit >= 1 ? Math.min(data.limit, maximumListedSessions) : 25;
	const all = [...state(options.editor).sessions.values()].map((value) => copySnapshot(value.snapshot));
	return { sessions: all.slice(offset, offset + limit), offset, limit, total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
}

export function getRuntimeAiSession(_scene: Scene, data: any, options: IMCPActionOptions): IRuntimeAiSessionSnapshot {
	return copySnapshot(ownedSession(options.editor, data.id).snapshot);
}

export async function runRuntimeAiInference(_scene: Scene, data: any, options: IMCPActionOptions): Promise<IRuntimeAiInferenceResult> {
	const owned = ownedSession(options.editor, data.id);
	expectedRevision(owned, data.expectedRevision);
	if (owned.snapshot.busy) {
		throw new Error(`Runtime AI session "${owned.snapshot.id}" is already running.`);
	}
	const maximumOutputValues = Number.isInteger(data.maximumOutputValues) ? Math.min(Math.max(data.maximumOutputValues, 1), maximumOutputPreviewValues) : 4096;
	owned.snapshot.busy = true;
	owned.snapshot.lastError = null;
	notify(options.editor);
	let result: IRuntimeAiRunResult;
	try {
		result = await owned.runtime.run(data.inputs as Record<string, IRuntimeAiTensorInput>, data.outputNames, data.timeoutMilliseconds);
		owned.snapshot.lastDurationMilliseconds = result.elapsedMilliseconds;
		owned.snapshot.runCount++;
	} catch (error) {
		owned.snapshot.lastError = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		owned.snapshot.busy = false;
		owned.snapshot.lastRunAt = new Date().toISOString();
		owned.snapshot.revision++;
		notify(options.editor);
	}
	return {
		session: copySnapshot(owned.snapshot),
		elapsedMilliseconds: result.elapsedMilliseconds,
		outputs: Object.fromEntries(
			Object.entries(result.outputs).map(([name, value]) => [
				name,
				{
					type: value.type,
					dims: value.dims,
					totalValues: value.data.length,
					truncated: value.data.length > maximumOutputValues,
					data: value.data.slice(0, maximumOutputValues),
				},
			])
		),
	};
}

export async function disposeRuntimeAiSession(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Disposing a Runtime AI session requires confirm: true.");
	}
	const editorState = state(options.editor);
	const owned = ownedSession(options.editor, data.id);
	expectedRevision(owned, data.expectedRevision);
	if (owned.snapshot.busy) {
		throw new Error(`Runtime AI session "${owned.snapshot.id}" is running and cannot be disposed.`);
	}
	await owned.runtime.dispose();
	editorState.sessions.delete(owned.snapshot.id);
	notify(options.editor);
	return { disposed: true, id: owned.snapshot.id, revision: owned.snapshot.revision };
}

export async function resetRuntimeAiRuntime(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Resetting Runtime AI requires confirm: true.");
	}
	const editorState = state(options.editor);
	if ([...editorState.sessions.values()].some((value) => value.snapshot.busy)) {
		throw new Error("Runtime AI cannot reset while an inference session is running.");
	}
	if (editorState.creating) {
		throw new Error("Runtime AI cannot reset while a model session is being created.");
	}
	const sessions = [...editorState.sessions.values()];
	const results = await Promise.allSettled(sessions.map((value) => value.runtime.dispose()));
	results.forEach((result, index) => {
		if (result.status === "fulfilled") {
			editorState.sessions.delete(sessions[index].snapshot.id);
		}
	});
	notify(options.editor);
	const failures = results.flatMap((result, index) => (result.status === "rejected" ? [sessions[index].snapshot.id] : []));
	if (failures.length) {
		throw new Error(`Runtime AI reset could not dispose ${failures.length} session(s): ${failures.join(", ")}.`);
	}
	return { reset: true, disposedSessions: sessions.length };
}

/** Releases transient model sessions when the editor window or MCP transport closes. */
export async function shutdownRuntimeAi(editor: Editor): Promise<void> {
	const owner = stateOwner(editor);
	const editorState = states.get(owner);
	if (!editorState) {
		return;
	}
	await Promise.all([...editorState.sessions.values()].map((value) => value.runtime.dispose().catch(() => undefined)));
	editorState.sessions.clear();
	editorState.changed.clear();
	states.delete(owner);
}

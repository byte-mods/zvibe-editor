import { createHash } from "crypto";
import { lstat, open, realpath } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";

import { Scene } from "babylonjs";
import { AssetStreamingPriority, AssetStreamingRuntime, assetStreamingRuntimeBackend } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { getBuildProfileAssetStreamingPlan } from "./export";

interface IAssetStreamingJob {
	requestId: string;
	path: string;
	offset: number;
	length: number;
	priority: AssetStreamingPriority;
	status: "queued" | "running" | "completed" | "cancelled" | "timed-out" | "failed";
	sha256: string | null;
	bytesRead: number;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
}

interface IAssetStreamingController {
	profileId: string;
	configurationRevision: number;
	projectDirectory: string;
	runtime: AssetStreamingRuntime;
	jobs: Map<string, IAssetStreamingJob>;
}

const controllers = new WeakMap<Scene, IAssetStreamingController>();
const maximumProbeBytes = 64 * 1024 * 1024;

/** Requires explicit preparation so every transient request remains bound to one exact persisted profile. */
function controllerFor(scene: Scene): IAssetStreamingController {
	const controller = controllers.get(scene);
	if (!controller) {
		throw new Error("Asset streaming runtime is not prepared. Call prepare_asset_streaming_runtime first.");
	}
	return controller;
}

/** Rejects stale clients before a request can change queue ownership or diagnostics. */
function requireRuntimeRevision(controller: IAssetStreamingController, expectedRevision: unknown): void {
	const current = controller.runtime.snapshot().revision;
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current) {
		throw new Error(`Asset streaming runtime changed. Inspect it again and use expectedRuntimeRevision ${current}.`);
	}
}

/** Restricts diagnostics to asset roots and resolves real paths so symlinked parents cannot escape the project. */
async function resolveProbePath(projectDirectory: string, value: unknown): Promise<{ absolutePath: string; relativePath: string }> {
	if (typeof value !== "string" || !value.trim() || value.length > 2_048 || isAbsolute(value) || value.includes("\0")) {
		throw new Error("Asset streaming path must be a non-empty project-relative path within 2,048 characters.");
	}
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized.startsWith("assets/") && !normalized.startsWith("public/")) {
		throw new Error("Asset streaming probes are restricted to project assets/ or public/ files.");
	}
	let candidate = projectDirectory;
	for (const segment of normalized.split("/")) {
		if (!segment || segment === "." || segment === "..") {
			throw new Error("Asset streaming path must be normalized without traversal segments.");
		}
		candidate = resolve(candidate, segment);
		if ((await lstat(candidate)).isSymbolicLink()) {
			throw new Error("Asset streaming probes do not follow symbolic links.");
		}
	}
	const root = await realpath(projectDirectory);
	const absolutePath = await realpath(resolve(projectDirectory, normalized));
	const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
	if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
		throw new Error("Asset streaming path resolves outside the current project.");
	}
	return { absolutePath, relativePath };
}

/** Adapts one async file handle to a bounded Web stream without buffering the complete asset. */
async function openFileStream(
	absolutePath: string,
	offset: number,
	length: number,
	chunkSizeBytes: number,
	chunkDelayMs: number,
	signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
	const handle = await open(absolutePath, "r");
	let position = offset;
	let remaining = length;
	let closed = false;
	const close = async (): Promise<void> => {
		if (!closed) {
			closed = true;
			await handle.close();
		}
	};
	return new ReadableStream<Uint8Array>({
		pull: async (controller) => {
			if (signal.aborted) {
				await close();
				controller.error(signal.reason instanceof Error ? signal.reason : new Error("Asset streaming file probe was cancelled."));
				return;
			}
			if (!remaining) {
				await close();
				controller.close();
				return;
			}
			if (chunkDelayMs) {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, chunkDelayMs));
			}
			const buffer = new Uint8Array(Math.min(chunkSizeBytes, remaining));
			const result = await handle.read(buffer, 0, buffer.byteLength, position);
			if (!result.bytesRead) {
				await close();
				controller.error(new Error("Asset streaming file ended before the requested range was complete."));
				return;
			}
			position += result.bytesRead;
			remaining -= result.bytesRead;
			controller.enqueue(buffer.subarray(0, result.bytesRead));
		},
		cancel: close,
	});
}

/** Consumes one background probe solely into bounded hash/byte evidence; asset bytes never enter the MCP response. */
async function consumeProbe(
	controller: IAssetStreamingController,
	job: IAssetStreamingJob,
	responsePromise: ReturnType<AssetStreamingRuntime["enqueue"]>["response"]
): Promise<void> {
	try {
		const response = await responsePromise;
		job.status = "running";
		const hash = createHash("sha256");
		for await (const chunk of response.stream) {
			hash.update(chunk);
			job.bytesRead += chunk.byteLength;
		}
		job.status = "completed";
		job.sha256 = hash.digest("hex");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		job.status = /timed out/i.test(message) ? "timed-out" : /cancel|disposed/i.test(message) ? "cancelled" : "failed";
		job.error = message;
	} finally {
		job.completedAt = new Date().toISOString();
		if (controller.jobs.size > 256) {
			const terminal = [...controller.jobs.values()].find(
				(candidate) => candidate.status === "completed" || candidate.status === "cancelled" || candidate.status === "timed-out" || candidate.status === "failed"
			);
			if (terminal) {
				controller.jobs.delete(terminal.requestId);
			}
		}
	}
}

/** Publishes the persisted setting, runtime bounds, and explicit native-adapter boundary. */
export function getAssetStreamingCapabilities(): any {
	return {
		model: assetStreamingRuntimeBackend,
		buildProfiles: { target: "electron", platform: "win32", setting: "Enable Direct Storage", default: false },
		priorities: ["critical", "high", "normal", "low", "background"],
		probeRoots: ["assets/", "public/"],
		limits: { maximumProbeBytes, maximumRetainedJobs: 256 },
		limitations: [
			"The built-in backend is bounded asynchronous Electron file streaming, not Microsoft DirectStorage or GPU decompression.",
			"A native DirectStorage adapter and live Windows binary evidence remain external requirements.",
		],
	};
}

/** Prepares one transient scheduler from an exact Electron Build Profile and current project root. */
export function prepareAssetStreamingRuntime(scene: Scene, data: any, options: IMCPActionOptions): any {
	const descriptor = getBuildProfileAssetStreamingPlan(scene, data);
	if (!Number.isSafeInteger(data.expectedBuildRevision) || data.expectedBuildRevision !== descriptor.configurationRevision) {
		throw new Error(`Build Profiles changed. Inspect them again and use expectedBuildRevision ${descriptor.configurationRevision}.`);
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	controllers.get(scene)?.runtime.dispose();
	const runtime = new AssetStreamingRuntime(descriptor.plan.settings, descriptor.plan.platform);
	const controller = {
		profileId: descriptor.profileId,
		configurationRevision: descriptor.configurationRevision,
		projectDirectory: dirname(projectPath),
		runtime,
		jobs: new Map(),
	};
	controllers.set(scene, controller);
	return { prepared: true, profileId: controller.profileId, configurationRevision: controller.configurationRevision, runtime: runtime.snapshot(), jobs: [] };
}

/** Reads a bounded page of transient jobs alongside the scheduler's exact revision and event evidence. */
export function getAssetStreamingRuntime(scene: Scene, data: any = {}): any {
	const controller = controllers.get(scene);
	if (!controller) {
		return {
			prepared: false,
			profileId: null,
			configurationRevision: null,
			runtime: null,
			jobs: [],
			pagination: { offset: 0, limit: 50, total: 0, hasMore: false, nextOffset: null },
		};
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Asset streaming job pagination requires offset >= 0 and limit from 1 through 100.");
	}
	const jobs = [...controller.jobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
	return {
		prepared: true,
		profileId: controller.profileId,
		configurationRevision: controller.configurationRevision,
		runtime: controller.runtime.snapshot(),
		jobs: structuredClone(jobs.slice(offset, offset + limit)),
		pagination: { offset, limit, total: jobs.length, hasMore: offset + limit < jobs.length, nextOffset: offset + limit < jobs.length ? offset + limit : null },
	};
}

/** Starts a project-contained background range probe so another MCP call can observe or cancel it. */
export async function startAssetStreamingFileProbe(scene: Scene, data: any): Promise<any> {
	const controller = controllerFor(scene);
	requireRuntimeRevision(controller, data.expectedRuntimeRevision);
	if (controller.jobs.size >= 256) {
		const terminal = [...controller.jobs.values()].find(
			(candidate) => candidate.status === "completed" || candidate.status === "cancelled" || candidate.status === "timed-out" || candidate.status === "failed"
		);
		if (!terminal) {
			throw new Error("Asset streaming diagnostics already retain 256 active jobs; wait for or cancel existing work before starting another.");
		}
		controller.jobs.delete(terminal.requestId);
	}
	const resolved = await resolveProbePath(controller.projectDirectory, data.path);
	const details = await lstat(resolved.absolutePath);
	if (!details.isFile()) {
		throw new Error("Asset streaming probe path must resolve to a regular file.");
	}
	const offset = data.offset ?? 0;
	const available = Math.max(0, details.size - offset);
	const length = data.length ?? Math.min(available, maximumProbeBytes);
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > details.size ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > maximumProbeBytes ||
		offset + length > details.size
	) {
		throw new Error(`Asset streaming range must stay inside the file and contain 1 through ${maximumProbeBytes.toLocaleString()} bytes.`);
	}
	const chunkDelayMs = data.chunkDelayMs ?? 0;
	if (!Number.isSafeInteger(chunkDelayMs) || chunkDelayMs < 0 || chunkDelayMs > 100) {
		throw new Error("Asset streaming chunkDelayMs must be an integer from 0 through 100 for editor diagnostics.");
	}
	const priority = (data.priority ?? "normal") as AssetStreamingPriority;
	const queued = controller.runtime.enqueue(
		{ key: `${resolved.relativePath}:${offset}:${length}`, url: resolved.relativePath, priority, expectedSizeBytes: length },
		async (_request, signal) => ({
			stream: await openFileStream(resolved.absolutePath, offset, length, controller.runtime.snapshot().settings.windows.chunkSizeBytes, chunkDelayMs, signal),
			sizeBytes: length,
		})
	);
	const job: IAssetStreamingJob = {
		requestId: queued.requestId,
		path: resolved.relativePath,
		offset,
		length,
		priority,
		status: "queued",
		sha256: null,
		bytesRead: 0,
		error: null,
		startedAt: new Date().toISOString(),
		completedAt: null,
	};
	controller.jobs.set(job.requestId, job);
	void consumeProbe(controller, job, queued.response);
	return { started: true, job: structuredClone(job), runtime: controller.runtime.snapshot() };
}

/** Cancels exactly one queued/active probe under the latest transient revision. */
export function cancelAssetStreamingRequest(scene: Scene, data: any): any {
	const controller = controllerFor(scene);
	requireRuntimeRevision(controller, data.expectedRuntimeRevision);
	const runtime = controller.runtime.cancel(data.requestId);
	return { cancelled: true, requestId: data.requestId, runtime };
}

/** Clears terminal jobs and runtime evidence only when no queued/active work remains. */
export function resetAssetStreamingRuntime(scene: Scene, data: any): any {
	if (data.confirm !== true) {
		throw new Error("Resetting asset streaming evidence requires confirm=true.");
	}
	const controller = controllerFor(scene);
	requireRuntimeRevision(controller, data.expectedRuntimeRevision);
	const runtime = controller.runtime.reset();
	controller.jobs.clear();
	return { reset: true, runtime, jobs: [] };
}

/** Releases file streams and queue ownership when the editor/MCP lifecycle closes. */
export function shutdownAssetStreamingRuntime(scene: Scene): void {
	controllers.get(scene)?.runtime.dispose();
	controllers.delete(scene);
}

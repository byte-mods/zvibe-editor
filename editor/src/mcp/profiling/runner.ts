import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { mkdir, pathExists, realpath } from "fs-extra";
import { Scene } from "babylonjs";
import {
	capturePortableProfilerMemorySnapshot,
	comparePortableProfilerMemorySnapshots,
	IPortableProfilerCapture,
	IPortableProfilerCaptureOptions,
	IPortableProfilerSession,
	measurePortableProfiler2D,
	parsePortableProfilerCapture,
	parsePortableProfilerMemorySnapshot,
	PortableProfilerModule,
	PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES,
	PORTABLE_PROFILER_MAXIMUM_EVIDENCE_BYTES,
	PORTABLE_PROFILER_MAXIMUM_ASSET_EVENTS,
	PORTABLE_PROFILER_MAXIMUM_MARKERS,
	PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS,
	PORTABLE_PROFILER_MAXIMUM_RETAINED_STATE_BYTES,
	PORTABLE_PROFILER_VERSION,
	PORTABLE_2D_PROFILER_MAXIMUM_ATLASES,
	PORTABLE_2D_PROFILER_MAXIMUM_SOURCE_REGIONS,
	PORTABLE_2D_PROFILER_MAXIMUM_USAGE_RECORDS,
	PORTABLE_2D_PROFILER_MAXIMUM_VISUAL_REGIONS,
	queryPortableProfilerCapture,
	retainPortableProfilerCapture,
	retainPortableProfilerMemorySnapshot,
	serializePortableProfilerCapture,
	startPortableProfilerCapture,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import {
	captureRemoteDeviceProfilerSnapshot,
	getRemoteDeviceProfilerData,
	getRemoteDeviceProfilerStatus,
	releaseRemoteDeviceProfiler,
	reserveRemoteDeviceProfiler,
	startRemoteDeviceProfiler,
	stopRemoteDeviceProfiler,
} from "../device/device-lab";

import { bumpProfilingRevision, persistProfilingState, profilingState, requireProfilingRevision } from "./state";

interface IActiveProfilerRun {
	id: string;
	target: "editor-edit" | "editor-play" | "connected-player";
	status: "preparing" | "recording" | "retrieving" | "completed" | "canceled" | "failed";
	startedAt: string;
	startedPlay: boolean;
	session: IPortableProfilerSession | null;
	targetScene: Scene | null;
	connectionId: string | null;
	runToken: string | null;
	releaseConnection: (() => void) | null;
	remoteOptions: IPortableProfilerCaptureOptions | null;
	remoteStopped: boolean;
	remotePersisted: boolean;
	completionError: Error | null;
	sceneDisposeObserver: any;
}

const activeRuns = new WeakMap<Scene, IActiveProfilerRun>();
const pendingMutations = new WeakMap<Scene, Promise<unknown>>();

async function runProfilerMutation<T>(scene: Scene, callback: () => Promise<T>): Promise<T> {
	if (pendingMutations.has(scene)) {
		throw new Error("Another asynchronous profiler mutation is already in progress for this scene.");
	}
	const pending = callback();
	pendingMutations.set(scene, pending);
	try {
		return await pending;
	} finally {
		if (pendingMutations.get(scene) === pending) {
			pendingMutations.delete(scene);
		}
	}
}

function requireNoPendingProfilerMutation(scene: Scene): void {
	if (pendingMutations.has(scene)) {
		throw new Error("Wait for the active asynchronous profiler mutation to finish before changing retained evidence.");
	}
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "profile";
}

function exactKeys(value: unknown, keys: string[]): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function assertProjectProfilerPath(directory: string, candidate: string): void {
	const contained = relative(directory, candidate);
	if (contained === ".." || contained.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(contained)) {
		throw new Error("Profiler report paths must stay inside the open project.");
	}
}

async function projectProfilerPath(value: string, mode: "read" | "write"): Promise<string> {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const directory = await realpath(resolve(dirname(projectConfiguration.path)));
	const lexical = resolve(directory, value);
	assertProjectProfilerPath(directory, lexical);
	if (mode === "read" || (await pathExists(lexical))) {
		const existing = await realpath(lexical);
		assertProjectProfilerPath(directory, existing);
		return existing;
	}
	const requestedParent = dirname(lexical);
	let existingAncestor = requestedParent;
	while (!(await pathExists(existingAncestor))) {
		const next = dirname(existingAncestor);
		if (next === existingAncestor) {
			throw new Error("Profiler report path has no accessible project-contained parent.");
		}
		existingAncestor = next;
	}
	const canonicalAncestor = await realpath(existingAncestor);
	assertProjectProfilerPath(directory, canonicalAncestor);
	const parent = join(canonicalAncestor, relative(existingAncestor, requestedParent));
	assertProjectProfilerPath(directory, parent);
	await mkdir(parent, { recursive: true });
	const canonicalParent = await realpath(parent);
	assertProjectProfilerPath(directory, canonicalParent);
	return join(canonicalParent, basename(lexical));
}

async function readProfilerFile(path: string): Promise<string> {
	const pathInfo = await lstat(path);
	if (!pathInfo.isFile()) {
		throw new Error("Profiler import paths must reference a regular file.");
	}
	const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(path, flags);
	try {
		const info = await handle.stat();
		if (!info.isFile()) {
			throw new Error("Profiler import paths must reference a regular file.");
		}
		if (info.size > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
			throw new Error("Portable profiler capture exceeds the 50 MiB import limit.");
		}
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) {
				break;
			}
			offset += read.bytesRead;
		}
		const extra = Buffer.alloc(1);
		if ((await handle.read(extra, 0, 1, offset)).bytesRead) {
			throw new Error("Portable profiler capture grew beyond its validated file size during import.");
		}
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		await handle.close();
	}
}

async function writeProfilerFile(path: string, source: string): Promise<void> {
	if (await pathExists(path)) {
		const pathInfo = await lstat(path);
		if (!pathInfo.isFile()) {
			throw new Error("Profiler export paths must reference a regular file.");
		}
	}
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
	try {
		const handle = await open(temporary, flags, 0o600);
		try {
			if (!(await handle.stat()).isFile()) {
				throw new Error("Profiler export temporary paths must reference a regular file.");
			}
			await handle.writeFile(source, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function notify(options: IMCPActionOptions): void {
	options.editor.layout.profiler?.forceUpdate?.();
	options.editor.layout.inspector?.forceUpdate?.();
}

async function waitForPlayScene(options: IMCPActionOptions, timeoutMs: number): Promise<Scene> {
	const play = options.editor.layout.preview.play;
	const started = Date.now();
	while (!play.canPlayScene) {
		if (!play.state.playing && !play.state.preparingPlay && !play.state.loading) {
			throw new Error("Editor Play mode stopped before the profiler scene became ready.");
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Editor Play mode did not become ready within ${timeoutMs} ms.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!play.scene) {
		throw new Error("Editor Play mode reported ready without a scene.");
	}
	return play.scene;
}

function description(capture: IPortableProfilerCapture, active = false): any {
	return {
		id: capture.id,
		name: capture.name,
		target: capture.target,
		status: active ? "recording" : capture.status,
		startedAt: capture.startedAt,
		finishedAt: capture.finishedAt,
		modules: capture.modules,
		frameCount: capture.frames.length,
		markerCount: capture.markers.length,
		assetEventCount: capture.assetEvents.length,
		memorySnapshotCount: capture.memorySnapshots.length,
		// Hierarchy rows are available through get_profiler_capture pages; duplicating them in every list/state response can turn twenty retained captures into hundreds of MiB.
		summary: { ...capture.summary, markers: [] },
		availability: capture.availability,
		limitations: capture.limitations.slice(0, 8),
		limitationCount: capture.limitations.length,
	};
}

function snapshotDescription(snapshot: any): any {
	const { limitations, ...description } = snapshot;
	return { ...description, limitationCount: limitations.length };
}

function persistCompletedCapture(scene: Scene, capture: IPortableProfilerCapture): number {
	const current = profilingState(scene);
	if (current.captures.some((candidate) => candidate.id === capture.id)) {
		throw new Error(`Profiler capture id "${capture.id}" became occupied before completion; retained evidence was not overwritten.`);
	}
	const state = retainPortableProfilerCapture(current, capture);
	const persisted = persistProfilingState(scene, state);
	if (!persisted.captures.some((candidate) => candidate.id === capture.id)) {
		throw new Error(`Profiler capture id "${capture.id}" could not be retained within the configured evidence budget.`);
	}
	return persisted.revision;
}

function finishLocalRun(scene: Scene, active: IActiveProfilerRun, capture: IPortableProfilerCapture, options: IMCPActionOptions): void {
	try {
		persistCompletedCapture(scene, capture);
	} catch (error) {
		active.completionError = error instanceof Error ? error : new Error(String(error));
		throw active.completionError;
	} finally {
		activeRuns.delete(scene);
		if (active.startedPlay) {
			options.editor.layout.preview.play.stop();
		}
		notify(options);
	}
}

function captureOptions(data: any, target: IPortableProfilerCaptureOptions["target"], id: string): IPortableProfilerCaptureOptions {
	const modules: PortableProfilerModule[] = data.modules ?? ["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio", "2d"];
	return {
		id,
		name: String(data.name).trim(),
		target,
		modules: [...new Set(modules)],
		sampleEveryFrames: data.sampleEveryFrames ?? 1,
		maximumFrames: data.maximumFrames ?? data.maxSamples ?? 600,
		maximumDurationMs: data.maximumDurationMs ?? 60_000,
	};
}

/** Starts an exact-revision profiler session against Edit, real Play, or a paired player. */
async function startProfilerCaptureInternal(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (activeRuns.has(scene)) {
		throw new Error("A profiler capture is already preparing or recording for this scene.");
	}
	const state = requireProfilingRevision(scene, data.expectedRevision);
	const target = data.target ?? "editor-edit";
	if (!["editor-edit", "editor-play", "connected-player"].includes(target)) {
		throw new Error("Profiler target must be editor-edit, editor-play, or connected-player.");
	}
	const id = data.id ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	if (state.captures.some((capture) => capture.id === id)) {
		throw new Error(`Profiler capture id "${id}" already exists; delete it or choose a different id.`);
	}
	const active: IActiveProfilerRun = {
		id,
		target,
		status: "preparing",
		startedAt: new Date().toISOString(),
		startedPlay: false,
		session: null,
		targetScene: null,
		connectionId: null,
		runToken: null,
		releaseConnection: null,
		remoteOptions: null,
		remoteStopped: false,
		remotePersisted: false,
		completionError: null,
		sceneDisposeObserver: null,
	};
	activeRuns.set(scene, active);
	const next = bumpProfilingRevision(scene, state);
	notify(options);
	try {
		if (target === "connected-player") {
			if (data.confirm !== true || typeof data.connectionId !== "string") {
				throw new Error("Connected-player profiling requires connectionId and confirm=true.");
			}
			active.connectionId = data.connectionId;
			if ((data.maximumFrames ?? data.maxSamples ?? 600) > 3_600 || (data.maximumDurationMs ?? 60_000) > 600_000) {
				throw new Error("Connected-player profiling is capped at 3,600 frames and 600,000 ms per capture.");
			}
			const runToken = `profile-${randomUUID()}`;
			active.runToken = runToken;
			active.remoteOptions = captureOptions(data, "connected-player", runToken);
			active.releaseConnection = reserveRemoteDeviceProfiler(data.connectionId, runToken, () => void shutdownProfiling(scene, options));
			active.sceneDisposeObserver = scene.onDisposeObservable.addOnce(() => void shutdownProfiling(scene, options));
			const remoteStart = await startRemoteDeviceProfiler(scene, {
				connectionId: data.connectionId,
				runToken,
				options: active.remoteOptions,
				timeoutMs: data.timeoutMs,
				confirm: true,
			});
			if (!remoteStart || typeof remoteStart !== "object" || remoteStart.runToken !== runToken || remoteStart.status !== "recording") {
				throw new Error("Connected-player profiler did not acknowledge the reserved run token as recording.");
			}
			active.status = "recording";
			notify(options);
			return {
				revision: next.revision,
				active: { id: active.id, target: active.target, status: active.status, startedAt: active.startedAt, connectionId: active.connectionId },
			};
		}
		let targetScene = scene;
		if (target === "editor-play") {
			const play = options.editor.layout.preview.play;
			if (!play.state.playing) {
				active.startedPlay = true;
				await play.play();
			}
			targetScene = await waitForPlayScene(options, data.timeoutMs ?? 30_000);
		}
		active.targetScene = targetScene;
		active.session = startPortableProfilerCapture(targetScene as any, captureOptions(data, target, id), {
			onStopped: (capture) => finishLocalRun(scene, active, capture, options),
		});
		active.status = "recording";
		notify(options);
		return { revision: next.revision, active: description(active.session.capture, true) };
	} catch (error) {
		if (active.connectionId && active.runToken && active.releaseConnection) {
			await stopRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, cancel: true, confirm: true, timeoutMs: 2_000 }).catch(
				() => undefined
			);
			await releaseRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, confirm: true, timeoutMs: 2_000 }).catch(() => undefined);
		}
		active.releaseConnection?.();
		if (active.sceneDisposeObserver) {
			scene.onDisposeObservable.remove(active.sceneDisposeObserver);
		}
		activeRuns.delete(scene);
		if (active.startedPlay) {
			options.editor.layout.preview.play.stop();
		}
		notify(options);
		throw error;
	}
}

export async function startProfilerCapture(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return runProfilerMutation(scene, () => startProfilerCaptureInternal(scene, data, options));
}

async function remoteCapture(scene: Scene, active: IActiveProfilerRun): Promise<IPortableProfilerCapture> {
	const common = { connectionId: active.connectionId, runToken: active.runToken };
	const root = await getRemoteDeviceProfilerData(scene, { ...common, kind: "description", offset: 0, limit: 1 });
	const requested = active.remoteOptions;
	const description = root?.description;
	if (
		!requested ||
		!exactKeys(root, ["description", "totals"]) ||
		!description ||
		!exactKeys(description, [
			"version",
			"id",
			"name",
			"target",
			"status",
			"startedAt",
			"finishedAt",
			"failure",
			"modules",
			"sampleEveryFrames",
			"maximumFrames",
			"maximumDurationMs",
			"availability",
			"memorySnapshots",
			"summary",
			"limitations",
		]) ||
		description.id !== active.runToken ||
		description.name !== requested.name ||
		description.target !== "connected-player" ||
		!["completed", "canceled", "failed"].includes(description.status) ||
		description.sampleEveryFrames !== requested.sampleEveryFrames ||
		description.maximumFrames !== requested.maximumFrames ||
		description.maximumDurationMs !== requested.maximumDurationMs ||
		!Array.isArray(description.modules) ||
		description.modules.length !== requested.modules?.length ||
		description.modules.some((module: string, index: number) => module !== requested.modules?.[index]) ||
		!exactKeys(root.totals, ["frames", "markers", "assetEvents", "memorySnapshots"]) ||
		!Number.isSafeInteger(root.totals.frames) ||
		root.totals.frames < 0 ||
		root.totals.frames > 3_600 ||
		!Number.isSafeInteger(root.totals.markers) ||
		root.totals.markers < 0 ||
		root.totals.markers > PORTABLE_PROFILER_MAXIMUM_MARKERS ||
		!Number.isSafeInteger(root.totals.assetEvents) ||
		root.totals.assetEvents < 0 ||
		root.totals.assetEvents > PORTABLE_PROFILER_MAXIMUM_ASSET_EVENTS ||
		!Number.isSafeInteger(root.totals.memorySnapshots) ||
		root.totals.memorySnapshots < 0 ||
		root.totals.memorySnapshots > PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS ||
		!Array.isArray(description.memorySnapshots) ||
		description.memorySnapshots.length !== 0 ||
		!description.summary ||
		!Array.isArray(description.summary.markers) ||
		description.summary.markers.length !== 0
	) {
		throw new Error("Connected-player profiler returned invalid or out-of-bounds capture metadata.");
	}
	let aggregateBytes = Buffer.byteLength(JSON.stringify(root), "utf8");
	if (aggregateBytes > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
		throw new Error("Connected-player profiler metadata exceeds the portable 50 MiB capture limit.");
	}
	const capture = { ...description, frames: [], markers: [], assetEvents: [] } as IPortableProfilerCapture;
	const collect = async (kind: "frames" | "markers" | "asset-events" | "memory-snapshots", total: number): Promise<any[]> => {
		const entries: any[] = [];
		// Match the player ceilings so even maximum-length Unicode fields remain within the Device Lab 5 MiB response contract.
		const maximumPageSize = kind === "memory-snapshots" ? 4 : kind === "markers" || kind === "asset-events" ? 200 : 500;
		while (entries.length < total) {
			const pageLimit = Math.min(maximumPageSize, total - entries.length);
			const page = await getRemoteDeviceProfilerData(scene, { ...common, kind, offset: entries.length, limit: pageLimit });
			if (
				!exactKeys(page, ["total", "offset", "limit", "entries"]) ||
				page.total !== total ||
				page.offset !== entries.length ||
				page.limit !== pageLimit ||
				!Array.isArray(page.entries) ||
				page.entries.length !== pageLimit ||
				entries.length + page.entries.length > total
			) {
				throw new Error(`Connected-player profiler returned an incomplete ${kind} page.`);
			}
			aggregateBytes += Buffer.byteLength(JSON.stringify(page), "utf8");
			if (aggregateBytes > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
				throw new Error("Connected-player profiler evidence exceeds the portable 50 MiB capture limit.");
			}
			entries.push(...page.entries);
		}
		return entries;
	};
	// Collect sequentially so a failed kind cannot leave other paging chains running in the background or sharing this attempt's byte budget with a retry.
	capture.frames = await collect("frames", root.totals.frames);
	capture.markers = await collect("markers", root.totals.markers);
	capture.assetEvents = await collect("asset-events", root.totals.assetEvents);
	capture.memorySnapshots = await collect("memory-snapshots", root.totals.memorySnapshots);
	const validated = parsePortableProfilerCapture(JSON.stringify(capture));
	validated.id = active.id;
	validated.memorySnapshots = validated.memorySnapshots.map((snapshot) => ({ ...snapshot, captureId: active.id }));
	return parsePortableProfilerCapture(serializePortableProfilerCapture(validated));
}

function closeRemoteRun(scene: Scene, active: IActiveProfilerRun, options: IMCPActionOptions): void {
	active.releaseConnection?.();
	active.releaseConnection = null;
	if (active.sceneDisposeObserver) {
		scene.onDisposeObservable.remove(active.sceneDisposeObserver);
		active.sceneDisposeObserver = null;
	}
	activeRuns.delete(scene);
	notify(options);
}

async function releaseRemoteRun(scene: Scene, active: IActiveProfilerRun): Promise<void> {
	let released = await releaseRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, confirm: true });
	if (!released || released.runToken !== active.runToken || typeof released.released !== "boolean") {
		throw new Error("Connected-player profiler did not acknowledge release of the completed evidence.");
	}
	if (!released.released) {
		try {
			const stopped = await stopRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, cancel: true, confirm: true });
			if (!stopped || stopped.runToken !== active.runToken || !["completed", "canceled", "failed"].includes(stopped.status)) {
				throw new Error("Connected-player profiler did not confirm absence or a terminal state after release.");
			}
			released = await releaseRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, confirm: true });
		} catch (error) {
			if ((error instanceof Error ? error.message : String(error)).toLowerCase().includes("not found")) {
				return;
			}
			throw error;
		}
		if (!released || released.runToken !== active.runToken || released.released !== true) {
			throw new Error("Connected-player profiler did not confirm an idempotent evidence release.");
		}
	}
}

/** Collects terminal remote evidence transactionally; transient page/release failures remain retryable under the same reservation. */
async function finalizeRemote(scene: Scene, active: IActiveProfilerRun, cancel: boolean, options: IMCPActionOptions): Promise<IPortableProfilerCapture | null> {
	if (active.remoteStopped && cancel) {
		await releaseRemoteRun(scene, active);
		closeRemoteRun(scene, active, options);
		return null;
	}
	try {
		if (!active.remoteStopped) {
			const stopped = await stopRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, cancel, confirm: true });
			if (!stopped || stopped.runToken !== active.runToken || !["completed", "canceled", "failed"].includes(stopped.status)) {
				throw new Error("Connected-player profiler did not acknowledge a terminal stop state.");
			}
			active.remoteStopped = true;
		}
		if (cancel) {
			await releaseRemoteRun(scene, active);
			closeRemoteRun(scene, active, options);
			return null;
		}
		active.status = "retrieving";
		notify(options);
		if (!active.remotePersisted) {
			const capture = await remoteCapture(scene, active);
			persistCompletedCapture(scene, capture);
			active.remotePersisted = true;
		}
		await releaseRemoteRun(scene, active);
		const capture = profilingState(scene).captures.find((candidate) => candidate.id === active.id) ?? null;
		if (!capture) {
			throw new Error("Connected-player profiler evidence was persisted but could not be found for completion.");
		}
		closeRemoteRun(scene, active, options);
		return capture;
	} catch (error) {
		if (active.remoteStopped) {
			active.status = "retrieving";
		}
		notify(options);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message} The remote evidence remains reserved; retry Collect/Stop, or Cancel to release it.`);
	}
}

/** Stops or cancels the active session and persists the bounded completed capture. */
async function stopProfilerCaptureInternal(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	requireProfilingRevision(scene, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Stopping or canceling a profiler session requires confirm=true.");
	}
	const active = activeRuns.get(scene);
	if (!active) {
		throw new Error("No profiler capture is active for this scene.");
	}
	if (data.id && data.id !== active.id) {
		throw new Error(`Active profiler capture is "${active.id}", not "${data.id}".`);
	}
	const capture =
		active.target === "connected-player"
			? await finalizeRemote(scene, active, data.cancel === true, options)
			: active.session!.stop(data.cancel === true ? "canceled" : "completed", data.cancel === true ? "Canceled by user." : undefined);
	if (active.completionError) {
		throw active.completionError;
	}
	return { revision: profilingState(scene).revision, active: null, capture: capture ? description(capture) : null, released: capture === null };
}

export async function stopProfilerCapture(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return runProfilerMutation(scene, () => stopProfilerCaptureInternal(scene, data, options));
}

/** Reports transient local/remote capture progress without returning capture payload arrays. */
export async function getProfilerRunStatus(scene: Scene): Promise<any> {
	const state = profilingState(scene);
	const active = activeRuns.get(scene);
	if (!active) {
		return { revision: state.revision, active: null, latest: state.captures[0] ? description(state.captures[0]) : null };
	}
	if (active.target === "connected-player") {
		if (active.remoteStopped) {
			return {
				revision: state.revision,
				active: { id: active.id, target: active.target, status: "retrieving", collectable: true, remote: null },
				latest: state.captures[0] ? description(state.captures[0]) : null,
			};
		}
		const remote = await getRemoteDeviceProfilerStatus(scene, { connectionId: active.connectionId, runToken: active.runToken });
		if (["completed", "canceled", "failed"].includes(remote.status)) {
			active.status = remote.status;
		} else if (!active.remoteStopped) {
			active.status = "recording";
		}
		return {
			revision: state.revision,
			active: { id: active.id, target: active.target, status: active.status, collectable: ["completed", "canceled", "failed", "retrieving"].includes(active.status), remote },
			latest: state.captures[0] ? description(state.captures[0]) : null,
		};
	}
	return {
		revision: state.revision,
		active: active.session ? description(active.session.capture, true) : { id: active.id, target: active.target, status: active.status },
		latest: state.captures[0] ? description(state.captures[0]) : null,
	};
}

export function getProfilerState(scene: Scene): any {
	const state = profilingState(scene);
	const active = activeRuns.get(scene);
	return {
		version: state.version,
		revision: state.revision,
		settings: { maximumRetainedCaptures: state.maximumRetainedCaptures, maximumRetainedSnapshots: state.maximumRetainedSnapshots },
		active: active ? { id: active.id, target: active.target, status: active.status, startedAt: active.startedAt } : null,
		captures: state.captures.map((capture) => description(capture)),
		memorySnapshots: state.memorySnapshots.map(snapshotDescription),
	};
}

export function listProfilerCaptures(scene: Scene, data: any = {}): any {
	const state = profilingState(scene);
	const offset = Number.isSafeInteger(data.offset) ? Math.max(0, data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) ? Math.min(100, Math.max(1, data.limit)) : 20;
	const search = typeof data.search === "string" ? data.search.toLowerCase() : null;
	const entries = state.captures.filter(
		(capture) => (!data.target || capture.target === data.target) && (!search || `${capture.name} ${capture.id}`.toLowerCase().includes(search))
	);
	return { revision: state.revision, total: entries.length, offset, limit, captures: entries.slice(offset, offset + limit).map((capture) => description(capture)) };
}

export function getProfilerCapture(scene: Scene, data: any): any {
	const capture = profilingState(scene).captures.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!capture) {
		throw new Error("Profiler capture not found. Provide id (preferred) or name.");
	}
	return queryPortableProfilerCapture(capture, data);
}

/** Returns detailed live 2D atlas occupancy or the lightweight counters retained for one captured frame. */
export function getProfiler2DState(scene: Scene, data: any = {}): any {
	if (data.frameIndex !== undefined && (!Number.isSafeInteger(data.frameIndex) || data.frameIndex < 0)) {
		throw new Error("2D profiler frameIndex must be a non-negative integer.");
	}
	if (data.captureId || data.captureName) {
		const capture = profilingState(scene).captures.find((candidate) => candidate.id === data.captureId || candidate.name === data.captureName);
		if (!capture) {
			throw new Error("Profiler capture not found. Provide captureId (preferred) or captureName.");
		}
		const frameIndex = data.frameIndex ?? Math.max(0, capture.frames.length - 1);
		const frame = capture.frames[frameIndex];
		if (!frame) {
			throw new Error(`Profiler frame ${frameIndex} is outside capture "${capture.id}" (${capture.frames.length} frames).`);
		}
		return {
			source: "retained-capture",
			capture: { id: capture.id, name: capture.name, target: capture.target, status: capture.status },
			frame: { index: frame.index, capturedAt: frame.capturedAt, elapsedMs: frame.elapsedMs, metrics: frame.twoD },
			detailed: false,
			limitations: frame.twoD
				? ["Retained captures store aggregate 2D counters; request live state for per-region atlas occupancy."]
				: ["This capture did not record the 2D module."],
		};
	}
	const active = activeRuns.get(scene);
	if (active?.target === "connected-player") {
		return {
			source: "connected-player",
			available: false,
			connectionId: active.connectionId,
			limitations: ["Detailed atlas regions are not transported from connected players; capture the 2d module for retained aggregate counters."],
		};
	}
	const targetScene = active?.targetScene ?? scene;
	return {
		source: active?.target === "editor-play" ? "editor-play" : "editor-edit",
		available: true,
		snapshot: measurePortableProfiler2D(targetScene as any),
	};
}

export function deleteProfilerCapture(scene: Scene, data: any, options: IMCPActionOptions): any {
	requireNoPendingProfilerMutation(scene);
	const state = requireProfilingRevision(scene, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Deleting a profiler capture requires confirm=true.");
	}
	if (activeRuns.get(scene)?.id === data.id) {
		throw new Error("Stop or cancel the active profiler capture before deleting it.");
	}
	const index = state.captures.findIndex((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (index === -1) {
		throw new Error("Profiler capture not found. Provide id (preferred) or name.");
	}
	const removed = state.captures[index];
	const next = { ...state, revision: state.revision + 1, captures: state.captures.filter((_, candidateIndex) => candidateIndex !== index) };
	persistProfilingState(scene, next);
	notify(options);
	return { deleted: true, id: removed.id, revision: next.revision };
}

export function listProfilerSnapshots(scene: Scene, data: any = {}): any {
	const state = profilingState(scene);
	const offset = Number.isSafeInteger(data.offset) ? Math.max(0, data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) ? Math.min(100, Math.max(1, data.limit)) : 40;
	return {
		revision: state.revision,
		total: state.memorySnapshots.length,
		offset,
		limit,
		snapshots: state.memorySnapshots.slice(offset, offset + limit).map(snapshotDescription),
	};
}

async function captureProfilerSnapshotInternal(scene: Scene, data: any, options?: IMCPActionOptions): Promise<any> {
	const state = requireProfilingRevision(scene, data.expectedRevision);
	const active = activeRuns.get(scene);
	const name = String(data.name).trim();
	if (!name || name.length > 120) {
		throw new Error("Profiler memory snapshot name must contain 1-120 characters.");
	}
	if (active?.target === "connected-player") {
		if (data.confirm !== true) {
			throw new Error("Capturing a connected-player memory snapshot requires confirm=true.");
		}
		const remoteSnapshot = parsePortableProfilerMemorySnapshot(
			await captureRemoteDeviceProfilerSnapshot(scene, {
				connectionId: active.connectionId,
				runToken: active.runToken,
				name,
				confirm: true,
			})
		);
		if (remoteSnapshot.captureId !== active.runToken || remoteSnapshot.name !== name) {
			throw new Error("Connected-player profiler returned a memory snapshot with mismatched ownership or name.");
		}
		const snapshot = { ...remoteSnapshot, captureId: active.id };
		if (state.memorySnapshots.some((candidate) => candidate.id === snapshot.id)) {
			throw new Error(`Profiler memory snapshot id "${snapshot.id}" already exists.`);
		}
		const next = persistProfilingState(scene, retainPortableProfilerMemorySnapshot(state, snapshot));
		const persistedSnapshot = next.memorySnapshots.find((candidate) => candidate.id === snapshot.id);
		if (!persistedSnapshot) {
			throw new Error("Profiler memory snapshot could not be retained within the configured evidence budget.");
		}
		if (options) {
			notify(options);
		}
		return { revision: next.revision, snapshot: structuredClone(persistedSnapshot) };
	}
	const targetScene = active?.targetScene ?? scene;
	if (active?.session && active.session.capture.memorySnapshots.length >= PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS) {
		throw new Error(`Profiler captures retain at most ${PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS} memory snapshots.`);
	}
	const snapshot = capturePortableProfilerMemorySnapshot(targetScene as any, name, active?.id ?? null, active?.session?.capture.frames.length ?? null);
	active?.session?.capture.memorySnapshots.push(structuredClone(snapshot));
	const next = persistProfilingState(scene, retainPortableProfilerMemorySnapshot(state, snapshot));
	const persistedSnapshot = next.memorySnapshots.find((candidate) => candidate.id === snapshot.id);
	if (!persistedSnapshot) {
		active?.session?.capture.memorySnapshots.pop();
		throw new Error("Profiler memory snapshot could not be retained within the configured evidence budget.");
	}
	if (options) {
		notify(options);
	}
	return { revision: next.revision, snapshot: structuredClone(persistedSnapshot) };
}

export async function captureProfilerSnapshot(scene: Scene, data: any, options?: IMCPActionOptions): Promise<any> {
	return runProfilerMutation(scene, () => captureProfilerSnapshotInternal(scene, data, options));
}

export function compareProfilerSnapshots(scene: Scene, data: any): any {
	const state = profilingState(scene);
	const find = (key: string) => state.memorySnapshots.find((snapshot) => snapshot.id === key || snapshot.name === key);
	const baseline = find(data.baseline);
	const current = find(data.current);
	if (!baseline || !current) {
		throw new Error("Both profiler memory snapshots must exist.");
	}
	return { revision: state.revision, comparison: comparePortableProfilerMemorySnapshots(baseline, current) };
}

export function deleteProfilerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	requireNoPendingProfilerMutation(scene);
	const state = requireProfilingRevision(scene, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Deleting a profiler memory snapshot requires confirm=true.");
	}
	const index = state.memorySnapshots.findIndex((snapshot) => snapshot.id === data.id || snapshot.name === data.name);
	if (index === -1) {
		throw new Error("Profiler memory snapshot not found.");
	}
	const removed = state.memorySnapshots[index];
	const next = { ...state, revision: state.revision + 1, memorySnapshots: state.memorySnapshots.filter((_, candidateIndex) => candidateIndex !== index) };
	persistProfilingState(scene, next);
	notify(options);
	return { deleted: true, id: removed.id, revision: next.revision };
}

export async function exportProfilerCapture(scene: Scene, data: any): Promise<any> {
	const capture = profilingState(scene).captures.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!capture) {
		throw new Error("Profiler capture not found.");
	}
	const path = data.path ?? `.bjseditor/profiler/${safeSegment(capture.name)}-${safeSegment(capture.id)}.json`;
	if (!path.toLowerCase().endsWith(".json")) {
		throw new Error("Profiler capture exports must end in .json.");
	}
	if (data.path !== undefined && data.confirm !== true) {
		throw new Error("Exporting to an explicit profiler path requires confirm=true because it can replace a project file.");
	}
	const absolute = await projectProfilerPath(path, "write");
	if ((await pathExists(absolute)) && data.confirm !== true) {
		throw new Error("Exporting to an existing profiler path requires confirm=true because it can replace a project file.");
	}
	await writeProfilerFile(absolute, serializePortableProfilerCapture(capture));
	return { exported: true, id: capture.id, path: relative(dirname(projectConfiguration.path!), absolute) };
}

async function importProfilerCaptureInternal(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	requireProfilingRevision(scene, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Importing a profiler capture requires confirm=true.");
	}
	const absolute = await projectProfilerPath(data.path, "read");
	const capture = parsePortableProfilerCapture(await readProfilerFile(absolute));
	const state = requireProfilingRevision(scene, data.expectedRevision);
	if (activeRuns.get(scene)?.id === capture.id) {
		throw new Error(`Profiler capture id "${capture.id}" belongs to the active run and cannot be imported.`);
	}
	if (state.captures.some((candidate) => candidate.id === capture.id)) {
		throw new Error(`Profiler capture id "${capture.id}" already exists; delete it before importing a replacement.`);
	}
	const next = retainPortableProfilerCapture(state, capture);
	const snapshotIds = new Set(next.memorySnapshots.map((snapshot) => snapshot.id));
	const importedSnapshots = capture.memorySnapshots.slice(0, next.maximumRetainedSnapshots).map((snapshot, index) => {
		let id = snapshot.id;
		let collision = 0;
		while (snapshotIds.has(id)) {
			const suffix = `-import-${index + 1}-${++collision}`;
			id = `${snapshot.id.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`;
		}
		snapshotIds.add(id);
		return { ...structuredClone(snapshot), id };
	});
	next.memorySnapshots = [...importedSnapshots, ...next.memorySnapshots].slice(0, next.maximumRetainedSnapshots);
	const persisted = persistProfilingState(scene, next);
	const retainedImportedSnapshots = importedSnapshots.filter((snapshot) => persisted.memorySnapshots.some((candidate) => candidate.id === snapshot.id));
	notify(options);
	return {
		imported: true,
		id: capture.id,
		name: capture.name,
		revision: persisted.revision,
		importedMemorySnapshots: retainedImportedSnapshots.length,
		droppedMemorySnapshots: capture.memorySnapshots.length - retainedImportedSnapshots.length,
	};
}

export async function importProfilerCapture(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return runProfilerMutation(scene, () => importProfilerCaptureInternal(scene, data, options));
}

export function clearProfilerData(scene: Scene, data: any, options: IMCPActionOptions): any {
	requireNoPendingProfilerMutation(scene);
	const state = requireProfilingRevision(scene, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Clearing profiler evidence requires confirm=true.");
	}
	if (activeRuns.has(scene)) {
		throw new Error("Stop or cancel the active profiler capture before clearing evidence.");
	}
	const removed = { captures: state.captures.length, memorySnapshots: state.memorySnapshots.length };
	const next = { ...state, revision: state.revision + 1, captures: [], memorySnapshots: [] };
	persistProfilingState(scene, next);
	notify(options);
	return { cleared: true, removed, revision: next.revision };
}

export async function shutdownProfiling(scene: Scene, options?: IMCPActionOptions): Promise<void> {
	await pendingMutations.get(scene)?.catch(() => undefined);
	const active = activeRuns.get(scene);
	if (!active) {
		return;
	}
	if (active.sceneDisposeObserver) {
		scene.onDisposeObservable.remove(active.sceneDisposeObserver);
		active.sceneDisposeObserver = null;
	}
	if (active.target === "connected-player") {
		await stopRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, cancel: true, confirm: true, timeoutMs: 2_000 }).catch(
			() => undefined
		);
		await releaseRemoteDeviceProfiler(scene, { connectionId: active.connectionId, runToken: active.runToken, confirm: true, timeoutMs: 2_000 }).catch(() => undefined);
		active.releaseConnection?.();
	} else {
		active.session?.stop("canceled", "Editor profiler service shut down.");
	}
	activeRuns.delete(scene);
	if (active.startedPlay) {
		options?.editor.layout.preview.play.stop();
	}
}

export function getProfilerCapabilities(): any {
	return {
		version: PORTABLE_PROFILER_VERSION,
		targets: ["editor-edit", "editor-play", "connected-player"],
		modules: ["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio", "2d"],
		views: ["timeline", "hierarchy", "inverted-hierarchy", "raw-hierarchy", "memory", "assets", "2d-atlas"],
		bounds: {
			maximumCaptureBytes: PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES,
			maximumLiveEvidenceBytes: PORTABLE_PROFILER_MAXIMUM_EVIDENCE_BYTES,
			maximumRetainedStateBytes: PORTABLE_PROFILER_MAXIMUM_RETAINED_STATE_BYTES,
			maximumFrames: 36_000,
			remoteMaximumFrames: 3_600,
			maximumDurationMs: 3_600_000,
			maximumMarkers: PORTABLE_PROFILER_MAXIMUM_MARKERS,
			maximumAssetEvents: PORTABLE_PROFILER_MAXIMUM_ASSET_EVENTS,
			maximumMemorySnapshotsPerCapture: PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS,
			retainedCaptures: 20,
			retainedMemorySnapshots: 40,
			maximum2DAtlasOwners: PORTABLE_2D_PROFILER_MAXIMUM_ATLASES,
			maximum2DSourceRegions: PORTABLE_2D_PROFILER_MAXIMUM_SOURCE_REGIONS,
			maximum2DUsageRecords: PORTABLE_2D_PROFILER_MAXIMUM_USAGE_RECORDS,
			maximum2DVisualRegions: PORTABLE_2D_PROFILER_MAXIMUM_VISUAL_REGIONS,
		},
		limitations: [
			"Native OS threads, native allocations, driver internals, and arbitrary JavaScript call stacks are unavailable in browser-based players.",
			"GPU timestamps, JavaScript heap counters, transfer byte counts, and physics timing report per-target availability instead of fabricated zeroes.",
		],
	};
}

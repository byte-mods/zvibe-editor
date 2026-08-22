#!/usr/bin/env node
/** Real stdio/editor/player lifecycle for bounded exact-revision portable profiling. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function waitFor(read, predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for profiler evidence.");
}

const requiredTools = [
	"get_profiler_capabilities",
	"get_profiler_state",
	"get_2d_profiler_state",
	"get_profiler_run_status",
	"list_profiler_captures",
	"get_profiler_capture",
	"start_profiler_capture",
	"stop_profiler_capture",
	"delete_profiler_capture",
	"list_profiler_snapshots",
	"capture_profiler_snapshot",
	"compare_profiler_snapshots",
	"delete_profiler_snapshot",
	"export_profiler_capture",
	"import_profiler_capture",
	"clear_profiler_data",
];
const suffix = `${process.pid}-${Date.now()}`;
const editId = `live-profile-${suffix}`;
const remoteId = `远程-${"界".repeat(100)}-${process.pid}`;
const forgedRemoteId = `live-forged-remote-profile-${suffix}`;
const reportPath = `.bjseditor/profiler/${editId}.json`;
const createdCaptureIds = new Set();
const createdSnapshotIds = new Set();
let projectDirectory = null;
let labStarted = false;
let player;
let forgedRunToken = null;

function remoteDescription(runToken, snapshot) {
	const at = new Date().toISOString();
	return {
		version: 1,
		id: runToken === forgedRunToken ? "forged-remote-owner" : runToken,
		name: "Live remote profile",
		target: "connected-player",
		status: "completed",
		startedAt: at,
		finishedAt: at,
		failure: null,
		modules: ["cpu", "rendering", "memory", "assets", "scripts"],
		sampleEveryFrames: 1,
		maximumFrames: 2,
		maximumDurationMs: 10_000,
		availability: Object.fromEntries(
			["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio"].map((name) => [
				name,
				{ available: name !== "gpu", precision: name === "gpu" ? "unavailable" : "engine-counter", reason: name === "gpu" ? "Live mock has no GPU timestamps." : null },
			])
		),
		memorySnapshots: [],
		summary: {
			frames: 1,
			durationMs: 16,
			metrics: { "cpu.frameTimeMs": { minimum: 16, maximum: 16, average: 16, median: 16, p95: 16, latest: 16, samples: 1 } },
			markers: [],
			assetRequests: 1,
			assetTransferBytes: 256,
		},
		limitations: ["Live mock transport; exported-player collection is covered by shared-runtime integration tests."],
	};
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "profiling-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Profiling tools: ${missing.join(", ")}`);
	const editorStatus = await call("get_editor_status");
	if (!editorStatus.ready || !editorStatus.projectPath) throw new Error("A ready project editor is required for the Profiling live scenario.");
	projectDirectory = dirname(editorStatus.projectPath);
	const capabilities = await call("get_profiler_capabilities");
	if (
		capabilities.version !== 2 ||
		!capabilities.targets.includes("connected-player") ||
		!capabilities.views.includes("inverted-hierarchy") ||
		!capabilities.views.includes("2d-atlas")
	)
		throw new Error("Profiler capability boundaries were incomplete.");
	const baseline = await call("get_profiler_state");
	if (baseline.active) throw new Error("A profiler session is already active; refusing to disturb it.");
	const live2D = await call("get_2d_profiler_state");
	if (!live2D.available || !live2D.snapshot?.metrics || !Array.isArray(live2D.snapshot.atlases)) throw new Error("Live 2D atlas profiler evidence was incomplete.");
	await call("get_2d_profiler_state", { frameIndex: 0 }, true);

	const started = await call("start_profiler_capture", {
		expectedRevision: baseline.revision,
		id: editId,
		name: "Live Edit profile",
		target: "editor-edit",
		modules: ["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio", "2d"],
		maximumFrames: 120,
		maximumDurationMs: 10_000,
	});
	await call("start_profiler_capture", { expectedRevision: baseline.revision, name: "Stale" }, true);
	await waitFor(
		() => call("get_profiler_run_status"),
		(value) => value.active?.frameCount >= 2
	);
	const stopped = await call("stop_profiler_capture", { expectedRevision: started.revision, id: editId, confirm: true });
	createdCaptureIds.add(editId);
	if (stopped.capture.frameCount < 2 || stopped.capture.target !== "editor-edit") throw new Error("Live Edit capture evidence was incomplete.");
	const retained2D = await call("get_2d_profiler_state", { captureId: editId, frameIndex: 0 });
	if (retained2D.source !== "retained-capture" || !retained2D.frame?.metrics) throw new Error("Retained 2D frame counters were incomplete.");
	const timeline = await call("get_profiler_capture", { id: editId, frameLimit: 10, markerLimit: 10, assetLimit: 10, view: "timeline" });
	const hierarchy = await call("get_profiler_capture", { id: editId, frameLimit: 1, markerLimit: 20, assetLimit: 1, view: "inverted-hierarchy" });
	if (timeline.frames.total < 2 || !timeline.capture.summary.metrics["cpu.frameTimeMs"] || !Array.isArray(hierarchy.markers.entries))
		throw new Error("Profiler timeline/hierarchy evidence was incomplete.");

	let state = await call("get_profiler_state");
	const before = await call("capture_profiler_snapshot", { expectedRevision: state.revision, name: `Live Before ${suffix}` });
	createdSnapshotIds.add(before.snapshot.id);
	const after = await call("capture_profiler_snapshot", { expectedRevision: before.revision, name: `Live After ${suffix}` });
	createdSnapshotIds.add(after.snapshot.id);
	const snapshots = await call("list_profiler_snapshots", { offset: 0, limit: 100 });
	if (
		snapshots.revision !== after.revision ||
		!snapshots.snapshots.some((snapshot) => snapshot.id === before.snapshot.id) ||
		!snapshots.snapshots.some((snapshot) => snapshot.id === after.snapshot.id)
	) {
		throw new Error("Profiler snapshot listing omitted the newly captured valid-state fixtures.");
	}
	const comparison = await call("compare_profiler_snapshots", { baseline: before.snapshot.id, current: after.snapshot.id });
	if (!comparison.comparison.metricDelta || !Array.isArray(comparison.comparison.potentialGrowth)) throw new Error("Memory snapshot comparison evidence was incomplete.");
	await call("export_profiler_capture", { id: editId, path: reportPath, confirm: true });
	const deletedEdit = await call("delete_profiler_capture", { expectedRevision: after.revision, id: editId, confirm: true });
	createdCaptureIds.delete(editId);
	const imported = await call("import_profiler_capture", { expectedRevision: deletedEdit.revision, path: reportPath, confirm: true });
	createdCaptureIds.add(imported.id);

	state = await call("get_profiler_state");
	const labStatus = await call("get_device_lab_status");
	if (labStatus.listening) throw new Error("Device Lab was already active; refusing to replace it.");
	const lab = await call("start_device_lab", { port: 0, pairingMinutes: 1 });
	labStarted = true;
	player = new WebSocket(`${lab.pairing.wsUrl}?token=${lab.pairing.pairingToken}`);
	await new Promise((resolve, reject) => {
		player.once("open", resolve);
		player.once("error", reject);
	});
	let remoteSnapshot = null;
	let failRemoteFramesOnce = false;
	let forgeRemoteFramePageOnce = false;
	let failRemoteReleaseOnce = false;
	player.on("message", (bytes) => {
		const message = JSON.parse(bytes.toString());
		if (message.type !== "command") return;
		let result;
		if (message.command === "start-profiler") {
			forgedRunToken ??= message.runToken;
			result = { runToken: message.runToken, status: "recording", startedAt: new Date().toISOString(), maximumFrames: 2 };
		} else if (message.command === "capture-profiler-snapshot") {
			remoteSnapshot = {
				id: `remote-memory-${suffix}`,
				name: message.name,
				capturedAt: new Date().toISOString(),
				captureId: message.runToken,
				frameIndex: 0,
				metrics: {
					usedHeapBytes: null,
					totalHeapBytes: null,
					heapLimitBytes: null,
					estimatedGeometryBytes: 128,
					estimatedTextureBytes: 256,
					estimatedSceneBytes: 384,
					sceneObjectCount: 1,
					gcEvents: null,
					gcDurationMs: null,
				},
				counts: { meshes: 1 },
				limitations: ["Live mock memory snapshot."],
			};
			if (message.name === "Invalid remote memory") remoteSnapshot.unknown = true;
			result = remoteSnapshot;
		} else if (message.command === "profiler-status") {
			const description = remoteDescription(message.runToken, remoteSnapshot);
			result = {
				runToken: message.runToken,
				status: "completed",
				startedAt: description.startedAt,
				finishedAt: description.finishedAt,
				failure: null,
				frameCount: 1,
				markerCount: 1,
				assetEventCount: 1,
				summary: description.summary,
			};
		} else if (message.command === "stop-profiler" || message.command === "cancel-profiler")
			result = { runToken: message.runToken, status: message.command === "cancel-profiler" ? "canceled" : "completed", frameCount: 1, markerCount: 1, assetEventCount: 1 };
		else if (message.command === "get-profiler-data" && message.kind === "description")
			result = {
				description: remoteDescription(message.runToken, remoteSnapshot),
				totals: { frames: 1, markers: 1, assetEvents: 1, memorySnapshots: remoteSnapshot ? 1 : 0 },
			};
		else if (message.command === "get-profiler-data" && message.kind === "frames") {
			if (forgeRemoteFramePageOnce && message.runToken !== forgedRunToken) {
				forgeRemoteFramePageOnce = false;
				result = {
					total: 1,
					offset: 0,
					limit: 1,
					entries: [],
					unexpected: "x".repeat(1_000),
				};
			} else if (failRemoteFramesOnce && message.runToken !== forgedRunToken) {
				failRemoteFramesOnce = false;
				player.send(
					JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: false, error: "Transient frame page failure." })
				);
				return;
			} else
				result = {
					total: 1,
					offset: 0,
					limit: 1,
					entries: [
						{
							index: 0,
							capturedAt: new Date().toISOString(),
							elapsedMs: 16,
							cpu: {
								frameTimeMs: 16,
								interFrameTimeMs: null,
								renderTimeMs: 8,
								activeMeshesEvaluationTimeMs: 1,
								renderTargetsTimeMs: 0,
								animationsTimeMs: 1,
								physicsTimeMs: 1,
								particlesTimeMs: 0,
								spritesTimeMs: 0,
								cameraRenderTimeMs: 2,
								scriptTimeMs: 1,
								scriptCalls: 1,
								scriptErrors: 0,
							},
							gpuFrameTimeMs: null,
							rendering: {
								drawCalls: 2,
								batches: 2,
								setPassCalls: null,
								activeMeshes: 1,
								vertices: 24,
								indices: 36,
								triangles: 12,
								materials: 1,
								textures: 1,
								lights: 1,
								cameras: 1,
								particleSystems: 0,
								shaderCompilationTimeMs: null,
							},
							memory: {
								usedHeapBytes: null,
								totalHeapBytes: null,
								heapLimitBytes: null,
								estimatedGeometryBytes: 128,
								estimatedTextureBytes: 256,
								estimatedSceneBytes: 384,
								sceneObjectCount: 1,
								gcEvents: null,
								gcDurationMs: null,
							},
							assets: { completedRequests: 1, durationMs: 5, transferBytes: 256, decodedBodyBytes: 512 },
							audio: null,
						},
					],
				};
		} else if (message.command === "get-profiler-data" && message.kind === "markers")
			result = {
				total: 1,
				offset: 0,
				limit: 1,
				entries: [
					{
						id: `marker-${suffix}`,
						frameIndex: 0,
						name: "Remote.Update",
						category: "Scripts",
						startMs: 1,
						durationMs: 1,
						depth: 0,
						parentId: null,
						thread: "main",
						objectId: null,
						objectName: null,
						scriptKey: "remote.ts",
						lifecycle: "onUpdate",
						error: null,
					},
				],
			};
		else if (message.command === "get-profiler-data" && message.kind === "asset-events")
			result = {
				total: 1,
				offset: 0,
				limit: 1,
				entries: [
					{
						id: `asset-${suffix}`,
						frameIndex: 0,
						name: "assets/remote.glb",
						initiatorType: "fetch",
						startMs: 0,
						durationMs: 5,
						transferBytes: 256,
						encodedBodyBytes: 256,
						decodedBodyBytes: 512,
						protocol: "h2",
						availability: { available: true, precision: "browser-counter", reason: null },
					},
				],
			};
		else if (message.command === "get-profiler-data" && message.kind === "memory-snapshots")
			result = { total: remoteSnapshot ? 1 : 0, offset: 0, limit: remoteSnapshot ? 1 : 0, entries: remoteSnapshot ? [remoteSnapshot] : [] };
		else if (message.command === "release-profiler") {
			result = { released: !failRemoteReleaseOnce, runToken: message.runToken };
			failRemoteReleaseOnce = false;
		} else return;
		player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: true, result }));
	});
	player.send(
		JSON.stringify({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "hello",
			identity: { deviceId: `profiler-${suffix}`, name: "Profiler CLI Player", platform: process.platform },
			capabilities: ["portable-profiler"],
		})
	);
	const devices = await waitFor(
		() => call("list_remote_devices"),
		(value) => value.devices.length === 1
	);
	const connectionId = devices.devices[0].connectionId;
	const remoteModules = ["cpu", "rendering", "memory", "assets", "scripts"];
	const duplicateModules = await call(
		"start_profiler_capture",
		{
			expectedRevision: state.revision,
			id: `duplicate-modules-${suffix}`,
			name: "Duplicate modules",
			target: "connected-player",
			connectionId,
			modules: ["cpu", "cpu"],
			maximumFrames: 1,
			maximumDurationMs: 1_000,
			confirm: true,
		},
		true
	);
	if (!duplicateModules.toLowerCase().includes("unique")) throw new Error("Duplicate connected-player profiler modules were not rejected by the MCP schema.");
	const forgedStart = await call("start_profiler_capture", {
		expectedRevision: state.revision,
		id: forgedRemoteId,
		name: "Live remote profile",
		target: "connected-player",
		connectionId,
		modules: remoteModules,
		maximumFrames: 2,
		maximumDurationMs: 10_000,
		confirm: true,
	});
	const forgedError = await call("stop_profiler_capture", { expectedRevision: forgedStart.revision, id: forgedRemoteId, confirm: true }, true);
	if (!forgedError.includes("invalid or out-of-bounds capture metadata")) throw new Error("Forged connected-player capture ownership was not rejected.");
	state = await call("get_profiler_state");
	if (state.active?.id !== forgedRemoteId || state.active.status !== "retrieving" || state.captures.some((capture) => capture.id === forgedRemoteId))
		throw new Error("Rejected forged connected-player evidence was not kept in an explicit recoverable state.");
	await call("stop_profiler_capture", { expectedRevision: state.revision, id: forgedRemoteId, cancel: true, confirm: true });
	state = await call("get_profiler_state");
	if (state.active) throw new Error("Canceled forged connected-player evidence remained active.");
	const remoteStart = await call("start_profiler_capture", {
		expectedRevision: state.revision,
		id: remoteId,
		name: " Live remote profile ",
		target: "connected-player",
		connectionId,
		modules: remoteModules,
		maximumFrames: 2,
		maximumDurationMs: 10_000,
		confirm: true,
	});
	const invalidRemoteSnapshot = await call("capture_profiler_snapshot", { expectedRevision: remoteStart.revision, name: "Invalid remote memory", confirm: true }, true);
	if (!invalidRemoteSnapshot.includes("memory snapshot is invalid")) throw new Error("Malformed connected-player memory evidence was not rejected.");
	const remoteMemory = await call("capture_profiler_snapshot", { expectedRevision: remoteStart.revision, name: " Remote memory ", confirm: true });
	if (remoteMemory.snapshot.captureId !== remoteId) throw new Error("Connected-player snapshot ownership was not normalized to the editor capture id.");
	createdSnapshotIds.add(remoteMemory.snapshot.id);
	const autoStopped = await call("get_profiler_run_status");
	if (autoStopped.active?.status !== "completed" || autoStopped.active.collectable !== true) throw new Error("Remote auto-stop was not surfaced as collectable.");
	const autoStoppedState = await call("get_profiler_state");
	if (autoStoppedState.active?.status !== "completed") throw new Error("Profiler state did not retain the polled remote terminal status.");
	forgeRemoteFramePageOnce = true;
	const forgedPageCollect = await call("stop_profiler_capture", { expectedRevision: remoteMemory.revision, id: remoteId, confirm: true }, true);
	if (!forgedPageCollect.includes("incomplete frames page")) throw new Error("Unknown connected-player page fields were not rejected on the first page.");
	let retryable = await call("get_profiler_state");
	if (retryable.active?.id !== remoteId || retryable.active.status !== "retrieving" || retryable.captures.some((capture) => capture.id === remoteId))
		throw new Error("Forged remote page discarded or retained incomplete evidence.");
	failRemoteFramesOnce = true;
	const transientCollect = await call("stop_profiler_capture", { expectedRevision: retryable.revision, id: remoteId, confirm: true }, true);
	if (!transientCollect.includes("remains reserved")) throw new Error("Transient remote page failure was not reported as recoverable.");
	retryable = await call("get_profiler_state");
	if (retryable.active?.id !== remoteId || retryable.active.status !== "retrieving" || retryable.captures.some((capture) => capture.id === remoteId))
		throw new Error("Transient remote page failure discarded or retained incomplete evidence.");
	failRemoteReleaseOnce = true;
	const remoteStop = await call("stop_profiler_capture", { expectedRevision: retryable.revision, id: remoteId, confirm: true });
	createdCaptureIds.add(remoteId);
	if (remoteStop.capture.target !== "connected-player" || remoteStop.capture.frameCount !== 1 || remoteStop.capture.markerCount !== 1)
		throw new Error("Connected-player capture evidence was incomplete.");
	const remoteCapture = await call("get_profiler_capture", { id: remoteId, frameLimit: 5, markerLimit: 5, assetLimit: 5, view: "raw-hierarchy" });
	if (remoteCapture.assetEvents.total !== 1 || remoteCapture.markers.total !== 1) throw new Error("Connected-player paged evidence was not retained.");
	if (remoteCapture.memorySnapshots.entries[0]?.captureId !== remoteId) throw new Error("Connected-player snapshot ownership was not normalized to the retained capture id.");

	const playerClosed = new Promise((resolve) => player.once("close", resolve));
	await call("disconnect_remote_device", { connectionId, confirm: true });
	await playerClosed;
	player = undefined;
	await call("stop_device_lab", { confirm: true });
	labStarted = false;

	state = await call("get_profiler_state");
	for (const id of [...createdSnapshotIds]) {
		const removed = await call("delete_profiler_snapshot", { expectedRevision: state.revision, id, confirm: true });
		createdSnapshotIds.delete(id);
		state = await call("get_profiler_state");
		if (removed.id !== id) throw new Error("Profiler memory snapshot cleanup was inexact.");
	}
	for (const id of [...createdCaptureIds]) {
		const removed = await call("delete_profiler_capture", { expectedRevision: state.revision, id, confirm: true });
		createdCaptureIds.delete(id);
		state = await call("get_profiler_state");
		if (removed.id !== id) throw new Error("Profiler capture cleanup was inexact.");
	}
	await call("clear_profiler_data", { expectedRevision: state.revision }, true);
	if (baseline.captures.length === 0 && baseline.memorySnapshots.length === 0) {
		const cleared = await call("clear_profiler_data", { expectedRevision: state.revision, confirm: true });
		if (cleared.removed.captures !== 0 || cleared.removed.memorySnapshots !== 0) throw new Error("Empty profiler cleanup evidence was inexact.");
	}
	console.log(
		`[profiling-live] PASS — ${requiredTools.length}/16 tools present; live and retained 2D atlas evidence, exact Edit capture/stale rejection, timeline and inverted hierarchy, memory snapshot comparison, project export/import, forged remote ownership and malformed snapshot rejection, authenticated paged connected-player capture/snapshot, strict confirmation, and exact cleanup verified.`
	);
} catch (error) {
	console.error(`[profiling-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		let state = await call("get_profiler_state");
		if (state.active?.id === editId || state.active?.id === remoteId || state.active?.id === forgedRemoteId) {
			await call("stop_profiler_capture", { expectedRevision: state.revision, id: state.active.id, cancel: true, confirm: true });
			state = await call("get_profiler_state");
		}
		player?.close();
		if (labStarted) await call("stop_device_lab", { confirm: true });
		for (const id of createdSnapshotIds) {
			if (state.memorySnapshots.some((entry) => entry.id === id)) {
				await call("delete_profiler_snapshot", { expectedRevision: state.revision, id, confirm: true });
				state = await call("get_profiler_state");
			}
		}
		for (const id of createdCaptureIds) {
			if (state.captures.some((entry) => entry.id === id)) {
				await call("delete_profiler_capture", { expectedRevision: state.revision, id, confirm: true });
				state = await call("get_profiler_state");
			}
		}
		if (projectDirectory) await unlink(join(projectDirectory, reportPath)).catch(() => undefined);
	} catch (cleanupError) {
		console.error(`[profiling-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

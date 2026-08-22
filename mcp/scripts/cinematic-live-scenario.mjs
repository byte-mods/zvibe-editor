#!/usr/bin/env node
/** Real stdio/editor lifecycle for all 32 Cinematic tools, exact leases, preview, offline-audio preflight, capture boundaries, and cleanup. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function rpc(method, params, timeoutMs = 90_000) {
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

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

const requiredTools = [
	"list_cinematics",
	"get_cinematic_capabilities",
	"inspect_cinematic_audio_capture_plan",
	"get_cinematic",
	"create_cinematic",
	"fork_cinematic",
	"delete_cinematic",
	"replace_cinematic",
	"set_cinematic_settings",
	"create_cinematic_track",
	"set_cinematic_track",
	"move_cinematic_track",
	"delete_cinematic_track",
	"create_cinematic_clip",
	"set_cinematic_clip",
	"delete_cinematic_clip",
	"create_cinematic_key",
	"set_cinematic_key",
	"delete_cinematic_key",
	"create_cinematic_marker",
	"set_cinematic_marker",
	"delete_cinematic_marker",
	"create_cinematic_recorder_profile",
	"set_cinematic_recorder_profile",
	"delete_cinematic_recorder_profile",
	"validate_cinematic",
	"get_cinematic_preview",
	"control_cinematic_preview",
	"play_cinematic",
	"start_cinematic_capture",
	"get_cinematic_capture",
	"cancel_cinematic_capture",
];
const suffix = `${Date.now()}-${process.pid}`;
const path = `.mcp-cinematic-live-${suffix}.cinematic`;
const forkPath = `.mcp-cinematic-live-${suffix}-fork.cinematic`;
const groupId = `group-${suffix}`;
const propertyTrackId = `property-${suffix}`;
const signalTrackId = `signal-${suffix}`;
const recorderTrackId = `recorder-${suffix}`;
const keyId = `key-${suffix}`;
const markerId = `marker-${suffix}`;
const profileId = `profile-${suffix}`;
const clipId = `clip-${suffix}`;
const captureDestination = `assets/.mcp-cinematic-live-${suffix}.png`;
let current;
let fork;
let previewActive = false;
let captureId;

function lease(value, targetPath = path) {
	return { path: targetPath, expectedRevision: value.document.revision, expectedFingerprint: value.fingerprint };
}

function baseTrack(id, name, type, order, parentId = null) {
	return { id, name, type, order, parentId, muted: false, solo: false, locked: false, color: "#4477AA" };
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cinematic-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the Cinematic live scenario.");
	if (await call("get_cinematic_preview")) throw new Error("Stop the current Cinematic preview before running live verification.");
	const captureBefore = await call("get_cinematic_capture");
	if (captureBefore?.status === "running" || captureBefore?.status === "cancelling") throw new Error("Stop the current Cinematic capture before running live verification.");

	const capabilities = await call("get_cinematic_capabilities");
	if (
		capabilities.documentVersion !== 2 ||
		capabilities.builtInAudioCapture !== true ||
		capabilities.offlineMasterBusAudioCapture !== true ||
		capabilities.deterministicVisualCapture !== true
	) {
		throw new Error("Cinematic capability and offline-audio evidence is incomplete.");
	}
	await call("list_cinematics");
	current = await call("create_cinematic", { path, name: "MCP Cinematic Live", durationMode: "fixed", durationFrames: 60, framesPerSecond: 30 });
	const opened = await call("get_cinematic", { path });
	if (opened.document.id !== current.document.id || opened.fingerprint !== current.fingerprint) throw new Error("Created Cinematic did not round-trip exactly.");

	const staleLease = lease(current);
	current = await call("set_cinematic_settings", { ...lease(current), changes: { name: "MCP Cinematic Live Updated", outputFramesPerSecond: 24 } });
	const stale = await call("set_cinematic_settings", { ...staleLease, changes: { name: "stale" } }, true);
	if (!/stale|changed/i.test(String(stale))) throw new Error("Stale Cinematic mutation did not reject.");

	fork = await call("fork_cinematic", { ...lease(current), destinationPath: forkPath });
	const forkOpened = await call("get_cinematic", { path: forkPath });
	if (forkOpened.document.id === current.document.id) throw new Error("Forked Cinematic reused the source identity.");
	await call("delete_cinematic", { ...lease(forkOpened, forkPath), confirm: true });
	fork = undefined;

	current = await call("replace_cinematic", { ...lease(current), document: current.document, confirm: true });
	current = await call("create_cinematic_track", { ...lease(current), track: { ...baseTrack(groupId, "Live Group", "group", 0), collapsed: false } });
	current = await call("set_cinematic_track", { ...lease(current), trackId: groupId, changes: { name: "Live Group Updated", collapsed: true } });
	current = await call("create_cinematic_track", {
		...lease(current),
		track: {
			...baseTrack(propertyTrackId, "Pipeline Property", "property", 1, groupId),
			targetType: "renderingPipeline",
			targetId: null,
			propertyPath: "taa.enabled",
			keys: [],
		},
	});
	current = await call("create_cinematic_key", {
		...lease(current),
		trackId: propertyTrackId,
		lane: "property",
		key: { id: keyId, type: "key", frame: 2, value: false, interpolation: "step" },
	});
	current = await call("set_cinematic_key", {
		...lease(current),
		trackId: propertyTrackId,
		lane: "property",
		keyId,
		key: { id: keyId, type: "key", frame: 3, value: true, interpolation: "step" },
	});
	current = await call("delete_cinematic_key", { ...lease(current), trackId: propertyTrackId, lane: "property", keyId, confirm: true });
	current = await call("delete_cinematic_track", { ...lease(current), trackId: propertyTrackId, confirm: true });

	current = await call("create_cinematic_track", {
		...lease(current),
		track: { ...baseTrack(signalTrackId, "Signals", "signal", 1, groupId), markers: [] },
	});
	current = await call("move_cinematic_track", { ...lease(current), trackId: signalTrackId, index: 1, parentId: null });
	current = await call("move_cinematic_track", { ...lease(current), trackId: signalTrackId, index: 0, parentId: groupId });
	current = await call("create_cinematic_marker", {
		...lease(current),
		trackId: signalTrackId,
		marker: { id: markerId, name: "Live Signal", type: "signal", frame: 10, emitOnce: true, retroactive: false, payload: { verified: true } },
	});
	current = await call("set_cinematic_marker", {
		...lease(current),
		trackId: signalTrackId,
		markerId,
		marker: { id: markerId, name: "Live Signal Updated", type: "event", frame: 12, emitOnce: false, retroactive: true, payload: ["live", 12] },
	});
	current = await call("delete_cinematic_marker", { ...lease(current), trackId: signalTrackId, markerId, confirm: true });
	current = await call("delete_cinematic_track", { ...lease(current), trackId: signalTrackId, confirm: true });

	current = await call("create_cinematic_recorder_profile", {
		...lease(current),
		profile: { id: profileId, name: "Live Profile", format: "png", width: 64, height: 64, framesPerSecond: 24, quality: 0.8, includeAudio: true },
	});
	const audioPlan = await call("inspect_cinematic_audio_capture_plan", { ...lease(current), profileId, startFrame: 0, endFrame: 1 });
	if (audioPlan.audio.ready !== false || !audioPlan.audio.issues.some((issue) => issue.code === "AUDIO_CONTAINER_UNSUPPORTED")) {
		throw new Error("Offline audio preflight did not report the image-container boundary.");
	}
	const audioRejected = await call(
		"start_cinematic_capture",
		{ ...lease(current), profileId, destination: `.mcp-cinematic-live-${suffix}.png`, startFrame: 0, endFrame: 1 },
		true
	);
	if (!String(audioRejected).includes("muxed only into WebM or MP4")) throw new Error("Built-in audio container boundary did not reject before starting work.");
	current = await call("set_cinematic_recorder_profile", { ...lease(current), profileId, changes: { includeAudio: false, quality: 0.9 } });
	current = await call("set_cinematic_settings", { ...lease(current), changes: { durationFrames: 3000 } });
	const startCapturePromise = call("start_cinematic_capture", {
		...lease(current),
		profileId,
		destination: captureDestination,
		startFrame: 0,
		endFrame: 3000,
		overwrite: true,
	});
	let observedCapture;
	for (let attempt = 0; attempt < 100; attempt++) {
		const capture = await call("get_cinematic_capture");
		if (capture?.status === "running" && capture.destination === captureDestination) {
			observedCapture = capture;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!observedCapture || observedCapture.totalFrames < 2) throw new Error(`Cinematic capture did not expose a running background lease: ${JSON.stringify(observedCapture)}`);
	captureId = observedCapture.id;
	const cancelledCapture = await call("cancel_cinematic_capture", { captureId });
	if (cancelledCapture.status !== "cancelling") throw new Error(`Cinematic capture cancellation evidence is incomplete: ${JSON.stringify(cancelledCapture)}`);
	const startedCapture = await startCapturePromise;
	if (startedCapture.id !== captureId || startedCapture.status !== "running")
		throw new Error(`Cinematic capture start response is incomplete: ${JSON.stringify(startedCapture)}`);
	for (let attempt = 0; attempt < 100; attempt++) {
		const capture = await call("get_cinematic_capture");
		if (capture.status === "cancelled") break;
		if (capture.status === "failed" || capture.status === "completed") throw new Error(`Cinematic capture reached an unexpected terminal state: ${JSON.stringify(capture)}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const captureAfterCancel = await call("get_cinematic_capture");
	if (captureAfterCancel.status !== "cancelled") throw new Error(`Cinematic capture did not finish cancellation: ${JSON.stringify(captureAfterCancel)}`);
	captureId = undefined;
	current = await call("create_cinematic_track", {
		...lease(current),
		track: { ...baseTrack(recorderTrackId, "Recorder", "recorder", 1, groupId), clips: [] },
	});
	const clipBase = {
		id: clipId,
		name: "Recorder Range",
		type: "recorder",
		startFrame: 0,
		durationFrames: 10,
		clipInFrame: 0,
		timeScale: 1,
		enabled: true,
		blendInFrames: 0,
		blendOutFrames: 0,
		easeIn: "linear",
		easeOut: "linear",
		preExtrapolation: "none",
		postExtrapolation: "none",
		profileId,
	};
	current = await call("create_cinematic_clip", { ...lease(current), trackId: recorderTrackId, clip: clipBase });
	current = await call("set_cinematic_clip", { ...lease(current), trackId: recorderTrackId, clipId, changes: { name: "Recorder Range Updated", durationFrames: 12 } });
	current = await call("delete_cinematic_clip", { ...lease(current), trackId: recorderTrackId, clipId, confirm: true });
	current = await call("delete_cinematic_track", { ...lease(current), trackId: recorderTrackId, confirm: true });
	current = await call("delete_cinematic_recorder_profile", { ...lease(current), profileId, confirm: true });

	const validation = await call("validate_cinematic", { path });
	if (!validation.valid || validation.revision !== current.document.revision || validation.errors.length) throw new Error("Cinematic live validation evidence is incomplete.");
	await call("control_cinematic_preview", { action: "play", path, loop: false, speed: 1, ignoreSounds: true });
	previewActive = true;
	let preview = await call("control_cinematic_preview", { action: "seek", frame: 20, emitRetroactive: false });
	if (preview.frame !== 20) throw new Error("Cinematic preview seek did not reach the exact frame.");
	preview = await call("control_cinematic_preview", { action: "step", frameCount: 2 });
	if (preview.frame !== 22) throw new Error("Cinematic preview step did not advance exactly.");
	await call("control_cinematic_preview", { action: "pause" });
	await call("control_cinematic_preview", { action: "stop" });
	previewActive = false;
	if (await call("get_cinematic_preview")) throw new Error("Cinematic preview lease remained after stop.");
	await call("play_cinematic", { path, loop: false, speedRatio: 1, ignoreSounds: true });
	previewActive = true;
	await call("control_cinematic_preview", { action: "stop" });
	previewActive = false;

	await call("get_cinematic_capture");
	const cancelMissing = await call("cancel_cinematic_capture", { captureId: "00000000-0000-4000-8000-000000000000" }, true);
	if (!String(cancelMissing).includes("not found")) throw new Error("Missing capture cancellation did not reject.");
	const unknown = await call("get_cinematic_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Cinematic capability tool did not reject an unknown field.");

	await call("delete_cinematic_track", { ...lease(current), trackId: groupId, deleteChildren: true, confirm: true }).then((value) => (current = value));
	await call("delete_cinematic", { ...lease(current), confirm: true });
	current = undefined;

	console.log(
		"[cinematic-live] PASS — 32/32 strict tools, exact leases/stale rejection, fork/replace, settings/track/clip/key/marker/profile CRUD, validation, preview/playback restoration, offline-audio preflight, capture boundaries, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[cinematic-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (previewActive) await call("control_cinematic_preview", { action: "stop" });
		if (captureId) await call("cancel_cinematic_capture", { captureId }).catch(() => undefined);
		if (fork) {
			const opened = await call("get_cinematic", { path: forkPath });
			await call("delete_cinematic", { ...lease(opened, forkPath), confirm: true });
		}
		if (current) {
			const opened = await call("get_cinematic", { path });
			await call("delete_cinematic", { ...lease(opened), confirm: true });
		}
		await call("delete_asset", { path: captureDestination, confirm: true }).catch(() => undefined);
	} catch (cleanupError) {
		console.error(`[cinematic-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

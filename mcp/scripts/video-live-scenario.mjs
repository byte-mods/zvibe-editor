#!/usr/bin/env node
/** Real stdio/editor lifecycle for Video import profiles, persistent players, Timeline clips, and exact cleanup. */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";

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
	"get_video_importer_capabilities",
	"get_video_platform_overrides",
	"set_video_platform_overrides",
	"get_video_importer_result",
	"apply_video_importer",
	"list_video_players",
	"create_video_player",
	"set_video_player",
	"control_video_player",
	"delete_video_player",
	"create_cinematic",
	"create_cinematic_track",
	"create_cinematic_clip",
	"set_cinematic_clip",
	"validate_cinematic",
	"control_cinematic_preview",
	"delete_cinematic",
	"refresh_asset_registry_paths",
	"delete_asset",
];
const suffix = `${Date.now()}-${process.pid}`;
const assetPath = `assets/.mcp-video-live-${suffix}.mp4`;
const cinematicPath = `assets/.mcp-video-live-${suffix}.cinematic`;
const playerName = `MCP Video ${suffix}`;
const trackId = `video-track-${suffix}`;
const clipId = `video-clip-${suffix}`;
let projectDirectory;
let player;
let cinematic;
let previewActive = false;
let assetRegistered = false;

function lease(value) {
	return { path: cinematicPath, expectedRevision: value.document.revision, expectedFingerprint: value.fingerprint };
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "video-live-scenario", version: "1.0.0" } });
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
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the Video live scenario.");
	projectDirectory = dirname(status.projectPath);
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	const generated = spawnSync(
		process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
		[
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=size=160x90:rate=30",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-t",
			"1",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			join(projectDirectory, assetPath),
		],
		{ encoding: "utf-8", shell: false }
	);
	if (generated.status !== 0) throw new Error(`FFmpeg fixture generation failed: ${generated.stderr}`);
	await call("refresh_asset_registry_paths", { paths: [assetPath] });
	assetRegistered = true;

	const capabilities = await call("get_video_importer_capabilities");
	if (!capabilities.encoders?.availableBackends?.includes("software") || capabilities.platforms?.web?.recommendedContainer !== "mp4") {
		throw new Error("Video encoder or platform capability evidence is incomplete.");
	}
	const overrides = await call("get_video_platform_overrides", { path: assetPath });
	const overrideResult = await call("set_video_platform_overrides", {
		path: assetPath,
		expectedFingerprint: overrides.fingerprint,
		overrides: {
			web: { enabled: true, transcode: "webm", videoCodec: "vp8", encoder: "software", quality: 0.7, maxWidth: 128, maxHeight: 72, includeAudio: false },
			desktop: { enabled: false },
		},
	});
	if (!overrideResult.effective?.web?.overrideApplied) throw new Error("Web video override did not become effective.");
	const importPlan = await call("get_video_importer_result", { path: assetPath, platform: "web" });
	const imported = await call("apply_video_importer", { path: assetPath, platform: "web", expectedFingerprint: importPlan.fingerprint, confirm: true });
	if (!imported.current || imported.result?.output?.videoCodec !== "vp8" || imported.result?.output?.width !== 128 || imported.result?.output?.audioCodec !== null) {
		throw new Error("Applied Web video importer evidence is incomplete.");
	}

	player = await call("create_video_player", {
		name: playerName,
		path: assetPath,
		targetMode: "apiOnly",
		playOnAwake: false,
		waitForFirstFrame: false,
		loop: false,
		skipOnDrop: true,
		playbackSpeed: 1.25,
		updateMode: "gameTime",
		muted: true,
		volume: 0.75,
		audioOutputMode: "none",
		startTime: 0,
		aspectRatio: "fitInside",
		alpha: 0.9,
		stereoLayout: "none",
		stereoEye: "left",
		colorSpace: "srgb",
	});
	if (!player.previewAttached || player.targetMode !== "apiOnly" || player.runtime?.targetAttached !== true) throw new Error("Persistent Video Player preview did not attach.");
	player = await call("set_video_player", { id: player.id, name: `${playerName} Updated`, playbackSpeed: 1.5, updateMode: "unscaledGameTime", volume: 0.5 });
	await call("control_video_player", { id: player.id, action: "play" });
	const sought = await call("control_video_player", { id: player.id, action: "seek", time: 0.25 });
	if (Math.abs(sought.runtime?.currentTime - 0.25) > 0.001) throw new Error("Video Player seek did not reach the exact time.");
	const paused = await call("control_video_player", { id: player.id, action: "pause" });
	if (paused.runtime?.isPlaying !== false) throw new Error("Video Player pause did not stop its deterministic clock.");
	const listed = await call("list_video_players");
	if (!listed.players.some((candidate) => candidate.id === player.id && candidate.runtime?.targetAttached === true)) throw new Error("Video Player diagnostics did not round-trip.");

	cinematic = await call("create_cinematic", { path: cinematicPath, name: "MCP Video Timeline", durationMode: "fixed", durationFrames: 30, framesPerSecond: 30 });
	cinematic = await call("create_cinematic_track", {
		...lease(cinematic),
		track: { id: trackId, name: "Video", type: "video", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#336699", clips: [] },
	});
	const clip = {
		id: clipId,
		name: "Intro",
		type: "video",
		startFrame: 0,
		durationFrames: 30,
		clipInFrame: 0,
		timeScale: 1,
		enabled: true,
		blendInFrames: 2,
		blendOutFrames: 2,
		easeIn: "linear",
		easeOut: "linear",
		preExtrapolation: "none",
		postExtrapolation: "none",
		videoPlayerId: player.id,
		volume: 0.8,
		loop: false,
		muteAudio: true,
	};
	cinematic = await call("create_cinematic_clip", { ...lease(cinematic), trackId, clip });
	cinematic = await call("set_cinematic_clip", { ...lease(cinematic), trackId, clipId, changes: { volume: 0.6, muteAudio: false } });
	const validation = await call("validate_cinematic", { path: cinematicPath });
	if (!validation.valid || validation.errors.length) throw new Error(`Video Timeline validation failed: ${JSON.stringify(validation)}`);
	await call("control_cinematic_preview", { action: "play", path: cinematicPath, loop: false, speed: 1, ignoreSounds: false });
	previewActive = true;
	const preview = await call("control_cinematic_preview", { action: "seek", frame: 15, emitRetroactive: false });
	if (preview.frame !== 15) throw new Error("Video Timeline preview did not seek to the exact frame.");
	await call("control_cinematic_preview", { action: "stop" });
	previewActive = false;

	await call("delete_cinematic", { ...lease(cinematic), confirm: true });
	cinematic = undefined;
	await call("delete_video_player", { id: player.id });
	player = undefined;
	await call("delete_asset", { path: assetPath, confirm: true });
	assetRegistered = false;

	console.log(
		"[video-live] PASS — 10/10 Video tools, actual encoder capabilities, Web/Desktop override lease, FFmpeg import evidence, complete persistent player CRUD/control, Timeline Video authoring/preview, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[video-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (previewActive) await call("control_cinematic_preview", { action: "stop" });
		if (cinematic) {
			const opened = await call("get_cinematic", { path: cinematicPath });
			await call("delete_cinematic", { path: cinematicPath, expectedRevision: opened.document.revision, expectedFingerprint: opened.fingerprint, confirm: true });
		}
		if (player) await call("delete_video_player", { id: player.id });
		if (assetRegistered) await call("delete_asset", { path: assetPath, confirm: true });
		else if (projectDirectory) await rm(join(projectDirectory, assetPath), { force: true });
	} catch (cleanupError) {
		console.error(`[video-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

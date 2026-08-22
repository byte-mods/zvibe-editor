#!/usr/bin/env node
/** Real MCP stdio + Electron lifecycle for Linux LTO/IME and macOS frame-pacing policy/evidence. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let cdp;
let baseline;
const createdProfileIds = new Set();

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

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status} on port ${port}.`);
	for (const target of (await response.json()).filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		let requestId = 1;
		const requests = new Map();
		const runtimeErrors = [];
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.id !== undefined && requests.has(message.id)) {
				requests.get(message.id)(message);
				requests.delete(message.id);
			} else if (message.method === "Runtime.exceptionThrown") {
				runtimeErrors.push(message.params?.exceptionDetails?.text ?? "Runtime.exceptionThrown");
			} else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
				runtimeErrors.push(message.params.entry.text);
			}
		});
		const send = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = requestId++;
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP ${method}.`)), 15_000);
				requests.set(id, (message) => {
					clearTimeout(timer);
					if (message.error) reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
					else resolve(message.result);
				});
				socket.send(JSON.stringify({ id, method, params }));
			});
		const evaluate = async (expression) => {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(`CDP evaluation failed: ${result.exceptionDetails.text}`);
			return result.result.value;
		};
		if (await evaluate("Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html'))")) {
			await send("Runtime.enable");
			await send("Log.enable");
			return { socket, evaluate, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron editor page was found on CDP port ${port}.`);
}

async function waitFor(read, predicate, label, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

const requiredTools = [
	"get_platform_player_capabilities",
	"get_build_profile_platform_player_plan",
	"prepare_platform_player_runtime",
	"get_platform_player_runtime",
	"simulate_platform_player_ime",
	"sample_platform_player_frame_pacing",
	"reset_platform_player_runtime",
];
const suffix = `${Date.now()}-${process.pid}`;
const linuxId = `mcp-platform-linux-${suffix}`;
const macId = `mcp-platform-mac-${suffix}`;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "platform-player-live-scenario", version: "1.0.0" } });
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
	if (!status.ready || !status.projectPath || !status.activeScenePath) throw new Error("A ready disposable project editor with an active scene is required.");
	const capabilities = await call("get_platform_player_capabilities");
	if (
		!capabilities.buildProfiles?.lto?.includes("full") ||
		!capabilities.linuxIme?.desktop?.includes("fcitx5") ||
		capabilities.macosFramePacing?.useDisplayLinkDefault !== false
	) {
		throw new Error("Platform-player capability inventory is incomplete.");
	}
	const unknown = await call("get_platform_player_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Unknown-field schema guard did not reject.");

	baseline = await call("list_build_profiles");
	let created = await call("create_build_profile", {
		expectedRevision: baseline.revision,
		id: linuxId,
		name: `MCP Platform Linux ${suffix}`,
		target: "electron",
		settings: { electronPlatform: "linux", platformPlayer: { version: 1, linux: { variant: "desktop", lto: "full", ime: "fcitx5" } } },
	});
	createdProfileIds.add(linuxId);
	let revision = created.configuration.revision;
	const linuxPlan = await call("get_build_profile_platform_player_plan", { id: linuxId });
	const linuxEnvironment = await call("get_build_profile_environment", { id: linuxId });
	if (
		linuxPlan.plan.lto?.mode !== "full" ||
		linuxPlan.plan.lto?.compilerFlags?.[0] !== "-flto=full" ||
		linuxPlan.plan.ime?.environment?.GTK_IM_MODULE !== "fcitx" ||
		JSON.parse(linuxEnvironment.environment.BJS_EDITOR_PLATFORM_PLAYER_PLAN).lto?.scope !== "project-native-dependencies"
	) {
		throw new Error("Linux Full-LTO/FCITX5 plan or package environment is incomplete.");
	}
	const invalidEmbedded = await call(
		"set_build_profile",
		{
			expectedRevision: revision,
			id: linuxId,
			settings: { electronPlatform: "linux", platformPlayer: { version: 1, linux: { variant: "embedded", lto: "thin", ime: "fcitx5" } } },
		},
		true
	);
	if (!String(invalidEmbedded).includes("desktop-only")) throw new Error("Embedded Linux incorrectly accepted FCITX5.");
	if ((await call("list_build_profiles")).revision !== revision) throw new Error("Rejected Embedded Linux authoring changed the Build Profiles revision.");

	created = await call("create_build_profile", {
		expectedRevision: revision,
		id: macId,
		name: `MCP Platform Mac ${suffix}`,
		target: "electron",
		settings: { electronPlatform: "darwin", platformPlayer: { version: 1, macos: { useDisplayLink: true, maximumQueuedFrames: 1 } } },
	});
	createdProfileIds.add(macId);
	revision = created.configuration.revision;
	const macPlan = await call("get_build_profile_platform_player_plan", { id: macId });
	if (!macPlan.plan.framePacing?.requestedDisplayLink || macPlan.plan.framePacing?.queueDepthEnforcement !== "native-adapter-required") {
		throw new Error("macOS display-link/queue-depth plan is incomplete.");
	}

	const stalePrepare = await call("prepare_platform_player_runtime", { id: macId, expectedBuildRevision: revision - 1 }, true);
	if (!String(stalePrepare).includes(`expectedBuildRevision ${revision}`)) throw new Error("Stale runtime preparation did not reject.");
	const prepared = await call("prepare_platform_player_runtime", { id: macId, expectedBuildRevision: revision });
	const simulated = await call("simulate_platform_player_ime", {
		expectedRuntimeRevision: prepared.runtime.revision,
		events: [
			{ type: "start", text: "に" },
			{ type: "update", text: "日本" },
			{ type: "end", text: "日本語" },
		],
	});
	if (simulated.runtime.compositionEvents?.length !== 3 || !simulated.runtime.compositionEvents.every((entry) => entry.source === "editor-simulation")) {
		throw new Error("Labeled IME composition evidence is incomplete.");
	}
	const staleSample = await call("sample_platform_player_frame_pacing", { expectedRuntimeRevision: prepared.runtime.revision, sampleCount: 4 }, true);
	if (!String(staleSample).includes(`expectedRuntimeRevision ${simulated.runtime.revision}`)) throw new Error("Stale frame sample did not reject.");
	const sampled = await call("sample_platform_player_frame_pacing", { expectedRuntimeRevision: simulated.runtime.revision, sampleCount: 6 });
	if (
		sampled.runtime.framePacing?.sampleCount !== 6 ||
		!Number.isFinite(sampled.runtime.framePacing?.averageDeltaMs) ||
		!["chromium-request-animation-frame", "native-metal-display-link"].includes(sampled.runtime.framePacing?.backend) ||
		typeof sampled.runtime.framePacing?.queueDepthApplied !== "boolean"
	) {
		throw new Error("Real requestAnimationFrame evidence or effective-backend labeling is incomplete.");
	}
	const reset = await call("reset_platform_player_runtime", { expectedRuntimeRevision: sampled.runtime.revision, confirm: true });
	if (reset.runtime.compositionEvents?.length !== 0 || reset.runtime.framePacing !== null) throw new Error("Transient evidence reset is incomplete.");
	if ((await call("get_platform_player_runtime")).runtime?.revision !== reset.runtime.revision) throw new Error("Transient runtime read did not round-trip.");

	await call("select_editor_tab", { tab: "inspector" });
	cdp = await connectCdp();
	await cdp.evaluate(`(async () => {
		const sceneLabel = [...document.querySelectorAll('span.truncate')].find((element) => element.parentElement?.title?.includes('Drop scene-root objects here'));
		const sceneRow = sceneLabel?.closest('.bp5-tree-node-content');
		if (!sceneRow) throw new Error('Active Scene hierarchy row was not found.');
		sceneRow.click();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const findHeader = () => [...document.querySelectorAll('div')]
			.find((element) => element.classList.contains('mt-0.5') && element.textContent?.trim() === 'Build Profiles')
			?.closest('div.cursor-pointer');
		const header = findHeader();
		if (!header) throw new Error('Build Profiles Scene Inspector header was not found.');
		header.click();
		await new Promise((resolve) => setTimeout(resolve, 100));
		findHeader()?.click();
		return true;
	})()`);
	const ui = await waitFor(
		() =>
			cdp.evaluate(`({
				platform: document.querySelectorAll('[data-testid=platform-player-settings]').length,
				linux: document.querySelectorAll('[data-testid=linux-player-settings]').length,
				macos: document.querySelectorAll('[data-testid=macos-frame-pacing-settings]').length
			})`),
		(value) => value.platform >= 2 && value.linux >= 1 && value.macos >= 1,
		"normal Platform Player Build Profile controls"
	);
	if (ui.platform < 2) throw new Error("Platform Player controls were not rendered in the normal Scene Inspector.");
	if (cdp.runtimeErrors.length) throw new Error(`Electron reported runtime errors: ${cdp.runtimeErrors.join(" | ")}`);

	let cleanupConfiguration = await call("list_build_profiles");
	for (const id of [macId, linuxId]) {
		if (cleanupConfiguration.profiles.some((profile) => profile.id === id)) {
			cleanupConfiguration = (await call("delete_build_profile", { expectedRevision: cleanupConfiguration.revision, id })).configuration;
		}
		createdProfileIds.delete(id);
	}
	const restored = await call("list_build_profiles");
	const semanticConfiguration = (value) => ({ activeProfileId: value.activeProfileId ?? null, profiles: value.profiles });
	if (JSON.stringify(semanticConfiguration(restored)) !== JSON.stringify(semanticConfiguration(baseline))) {
		throw new Error("Exact-revision deletion did not restore the semantic Build Profiles baseline.");
	}

	console.log(
		"[platform-player-live] PASS — 7/7 strict tools, exact Build Profile revisions, Linux Full LTO/FCITX5 environment, invalid Embedded guard, macOS adapter boundary, labeled IME lifecycle, real frame timing, reset, normal Inspector UI, zero runtime errors, and exact-revision semantic cleanup verified."
	);
} catch (error) {
	console.error(`[platform-player-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	try {
		let configuration = await call("list_build_profiles");
		for (const id of [...createdProfileIds].reverse()) {
			if (configuration.profiles.some((profile) => profile.id === id)) {
				configuration = (await call("delete_build_profile", { expectedRevision: configuration.revision, id })).configuration;
			}
			createdProfileIds.delete(id);
		}
	} catch (cleanupError) {
		console.error(`[platform-player-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.stdin.end();
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}

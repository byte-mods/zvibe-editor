#!/usr/bin/env node
/** Real MCP stdio + Electron lifecycle for Windows-profile asset streaming, external probes, UI evidence, and cleanup. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { getExpectedMcpToolCount } from "./live-scenario-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let cdp;
let profileId;
let fixturePath;
let fixtureRelative;

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
			} else if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.text ?? "Runtime.exceptionThrown");
			else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") runtimeErrors.push(message.params.entry.text);
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

const requiredTools = [
	"get_asset_streaming_capabilities",
	"get_build_profile_asset_streaming_plan",
	"prepare_asset_streaming_runtime",
	"get_asset_streaming_runtime",
	"start_asset_streaming_file_probe",
	"cancel_asset_streaming_request",
	"reset_asset_streaming_runtime",
];

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "asset-streaming-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
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
	const capabilities = await call("get_asset_streaming_capabilities");
	if (capabilities.buildProfiles?.default !== false || capabilities.priorities?.[0] !== "critical" || !capabilities.limitations?.join(" ").includes("not Microsoft")) {
		throw new Error("Asset-streaming capability inventory is incomplete or overclaims native identity.");
	}
	const unknown = await call("get_asset_streaming_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Unknown-field schema guard did not reject.");

	const suffix = `${Date.now()}-${process.pid}`;
	profileId = `mcp-asset-stream-${suffix}`;
	const projectDirectory = dirname(status.projectPath);
	fixtureRelative = `assets/${profileId}.bin`;
	fixturePath = join(projectDirectory, fixtureRelative);
	await mkdir(dirname(fixturePath), { recursive: true });
	const fixture = Buffer.alloc(8 * 1024 * 1024);
	for (let index = 0; index < fixture.length; index++) fixture[index] = index % 251;
	await writeFile(fixturePath, fixture);
	const fixtureHash = createHash("sha256").update(fixture).digest("hex");

	let configuration = await call("list_build_profiles");
	let created = await call("create_build_profile", {
		expectedRevision: configuration.revision,
		id: profileId,
		name: `MCP Asset Streaming ${suffix}`,
		target: "electron",
		settings: {
			electronPlatform: "win32",
			assetStreaming: {
				version: 1,
				windows: {
					enableDirectStorage: true,
					maximumConcurrentReads: 2,
					maximumQueuedRequests: 16,
					requestTimeoutMs: 30000,
					chunkSizeBytes: 65536,
					maximumAssetBytes: 16777216,
				},
			},
		},
	});
	let revision = created.configuration.revision;
	const plan = await call("get_build_profile_asset_streaming_plan", { id: profileId });
	const environment = await call("get_build_profile_environment", { id: profileId });
	if (
		plan.configurationRevision !== revision ||
		plan.plan.backend !== "electron-asynchronous-file-streams" ||
		plan.plan.directStorage?.nativeBackendUsed !== false ||
		JSON.parse(environment.environment.BJS_EDITOR_ASSET_STREAMING_PLAN).enabled !== true
	) {
		throw new Error("Windows profile plan/environment did not preserve the portable/native boundary.");
	}
	const stale = await call("prepare_asset_streaming_runtime", { id: profileId, expectedBuildRevision: revision - 1 }, true);
	if (!String(stale).includes(`expectedBuildRevision ${revision}`)) throw new Error("Stale Build Profile lease did not reject.");
	const prepared = await call("prepare_asset_streaming_runtime", { id: profileId, expectedBuildRevision: revision });
	if (!prepared.runtime?.plan?.enabled || prepared.runtime?.settings?.windows?.maximumConcurrentReads !== 2) throw new Error("Prepared scheduler settings are incomplete.");

	const slow = await call("start_asset_streaming_file_probe", {
		expectedRuntimeRevision: prepared.runtime.revision,
		path: fixtureRelative,
		length: fixture.length,
		priority: "low",
		chunkDelayMs: 20,
	});
	const cancellable = await waitFor(
		() => call("get_asset_streaming_runtime"),
		(value) => value.jobs?.some((job) => job.requestId === slow.job.requestId && ["queued", "running"].includes(job.status)),
		"active streaming probe"
	);
	const cancelled = await call("cancel_asset_streaming_request", {
		expectedRuntimeRevision: cancellable.runtime.revision,
		requestId: slow.job.requestId,
	});
	if (cancelled.runtime.totals?.cancelled !== 1) throw new Error("Active cancellation evidence is missing.");
	await waitFor(
		() => call("get_asset_streaming_runtime"),
		(value) => value.jobs?.some((job) => job.requestId === slow.job.requestId && job.status === "cancelled"),
		"cancelled job evidence"
	);

	const beforeComplete = await call("get_asset_streaming_runtime");
	const completedStart = await call("start_asset_streaming_file_probe", {
		expectedRuntimeRevision: beforeComplete.runtime.revision,
		path: fixtureRelative,
		length: fixture.length,
		priority: "critical",
	});
	const completed = await waitFor(
		() => call("get_asset_streaming_runtime"),
		(value) => value.jobs?.some((job) => job.requestId === completedStart.job.requestId && job.status === "completed"),
		"completed streaming probe",
		30_000
	);
	const completedJob = completed.jobs.find((job) => job.requestId === completedStart.job.requestId);
	if (completedJob.sha256 !== fixtureHash || completedJob.bytesRead !== fixture.length || "bytes" in completedJob) throw new Error("Hash-only completed evidence is incorrect.");
	const staleReset = await call("reset_asset_streaming_runtime", { expectedRuntimeRevision: prepared.runtime.revision, confirm: true }, true);
	if (!String(staleReset).includes(`expectedRuntimeRevision ${completed.runtime.revision}`)) throw new Error("Stale runtime lease did not reject.");
	const reset = await call("reset_asset_streaming_runtime", { expectedRuntimeRevision: completed.runtime.revision, confirm: true });
	if (reset.runtime.events?.length !== 0 || reset.jobs?.length !== 0) throw new Error("Transient runtime reset is incomplete.");

	await call("select_editor_tab", { tab: "inspector" });
	cdp = await connectCdp();
	const ui = await cdp.evaluate(`(async () => {
		const sceneLabel = [...document.querySelectorAll('span.truncate')].find((element) => element.parentElement?.title?.includes('Drop scene-root objects here'));
		const sceneRow = sceneLabel?.closest('.bp5-tree-node-content');
		if (!sceneRow) throw new Error('Active Scene hierarchy row was not found.');
		sceneRow.click();
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (!document.querySelector('[data-testid="windows-asset-streaming-settings"]')) {
			const header = [...document.querySelectorAll('div')]
				.find((element) => element.classList.contains('mt-0.5') && element.textContent?.trim() === 'Build Profiles')
				?.closest('div.cursor-pointer');
			if (!header) throw new Error('Build Profiles Scene Inspector header was not found.');
			header.click();
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		const settings = document.querySelector('[data-testid="windows-asset-streaming-settings"]');
		const evidence = document.querySelector('[data-testid="windows-asset-streaming-evidence"]');
		return { settings: Boolean(settings), text: evidence?.textContent ?? '' };
	})()`);
	if (!ui.settings || !ui.text.includes("Portable async asset streams enabled") || !ui.text.includes("native Microsoft DirectStorage")) {
		throw new Error(`Permanent Windows Inspector evidence is incomplete: ${JSON.stringify(ui)}`);
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
	if (cdp.runtimeErrors.length) throw new Error(`Renderer errors were observed: ${cdp.runtimeErrors.join(" | ")}`);

	configuration = await call("list_build_profiles");
	await call("delete_build_profile", { expectedRevision: configuration.revision, id: profileId });
	profileId = undefined;
	await call("delete_asset", { path: fixtureRelative, confirm: true });
	await call("refresh_asset_registry_paths", { paths: [fixtureRelative] });
	await rm(`${fixturePath}.bjsmeta.json`, { force: true });
	fixturePath = undefined;
	fixtureRelative = undefined;
	console.log(JSON.stringify({ verdict: "PASS", tools: tools.length, backend: plan.plan.backend, bytes: fixture.length, sha256: fixtureHash, ui }));
} finally {
	cdp?.socket?.close();
	if (profileId) {
		try {
			const configuration = await call("list_build_profiles");
			if (configuration.profiles?.some((profile) => profile.id === profileId))
				await call("delete_build_profile", { expectedRevision: configuration.revision, id: profileId });
		} catch {
			// Best-effort semantic cleanup is followed by fixture cleanup and process shutdown.
		}
	}
	if (fixturePath) {
		await rm(fixturePath, { force: true }).catch(() => undefined);
		await rm(`${fixturePath}.bjsmeta.json`, { force: true }).catch(() => undefined);
	}
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (!stderr.includes("Server started")) console.error(stderr);
}

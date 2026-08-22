#!/usr/bin/env node
/** Real stdio/Electron lifecycle for Unity 6.5 portable On-Tile rendering parity. */
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
let cameraId;
let passId;
let extensionId;

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
	"get_on_tile_rendering",
	"set_on_tile_rendering",
	"list_on_tile_renderer_providers",
	"create_on_tile_renderer_extension",
	"set_on_tile_renderer_extension",
	"delete_on_tile_renderer_extension",
	"validate_on_tile_rendering",
	"apply_on_tile_rendering",
	"get_on_tile_rendering_runtime",
];
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-16);

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "on-tile-rendering-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required.");
	await call("select_editor_tab", { tab: "inspector" });
	cdp = await connectCdp();
	await cdp.evaluate(`(() => {
		const label = [...document.querySelectorAll('[title]')].find((element) => String(element.getAttribute('title')).split('\\n')[0].endsWith('.scene'));
		const row = label?.closest('.bp5-tree-node-content');
		if (!row) return false;
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return true;
	})()`);
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="on-tile-rendering-inspector"]'))`), Boolean, "normal On-Tile Scene Inspector");
	const normalSceneUi = await cdp.evaluate(`({
		root: Boolean(document.querySelector('[data-testid="on-tile-rendering-inspector"]')),
		validation: Boolean(document.querySelector('[data-testid="on-tile-validation"]')),
		post: Boolean(document.querySelector('[data-testid="on-tile-post-processing"]')),
		extensions: Boolean(document.querySelector('[data-testid="on-tile-extensions"]')),
		runtime: document.querySelector('[data-testid="on-tile-runtime-evidence"]')?.innerText ?? ''
	})`);
	if (
		!normalSceneUi.root ||
		!normalSceneUi.validation ||
		!normalSceneUi.post ||
		!normalSceneUi.extensions ||
		!normalSceneUi.runtime.includes("Native tile-memory/bandwidth evidence: unavailable")
	)
		throw new Error("Normal On-Tile Scene Inspector evidence is incomplete.");

	const initial = await call("get_on_tile_rendering");
	if (!/^[0-9a-f]{16}$/.test(initial.fingerprint) || initial.validation.nativeTileMemory !== false) throw new Error("Initial On-Tile state or native boundary is invalid.");
	const providers = await call("list_on_tile_renderer_providers");
	if (!providers.providers.some((provider) => provider.id === "builtin-color-scale") || providers.maximumExtensions !== 32)
		throw new Error("On-Tile provider inventory is incomplete.");
	const closed = await call("get_on_tile_rendering", { unknown: true }, true);
	if (!String(closed).includes("-32602")) throw new Error("Closed On-Tile schema did not reject an unknown field.");

	const camera = await call("create_camera", { type: "free", name: `On-Tile Live ${suffix}`, position: [0, 0, -500], target: [0, 0, 0] });
	cameraId = camera.id;
	await call("set_active_camera", { nodeId: cameraId });
	await call("set_camera_post_process", { nodeId: cameraId, type: "customColor", enabled: true, properties: { saturation: 0.8 } });
	const pass = await call("create_custom_render_pass", { name: `On-Tile Incompatible ${suffix}`, enabled: true });
	passId = pass.id;

	const current = await call("get_on_tile_rendering");
	const configured = await call("set_on_tile_rendering", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		enabled: true,
		tileOnlyMode: true,
		validationMode: "enforce",
		postProcessing: { enabled: true, exposure: 0.25, contrast: 1.1, saturation: 0.9, vignette: 0.2, vignetteSmoothness: 0.5 },
	});
	if (!configured.runtime.active || !configured.runtime.suppressedCustomPassIds.includes(passId)) throw new Error("Enforce-mode graph suppression failed.");
	const stale = await call("set_on_tile_rendering", { expectedRevision: current.configuration.revision, expectedFingerprint: current.fingerprint, enabled: false }, true);
	if (!String(stale).includes("state changed")) throw new Error("Stale On-Tile policy mutation did not reject.");

	let leased = await call("get_on_tile_rendering");
	const created = await call("create_on_tile_renderer_extension", {
		expectedRevision: leased.configuration.revision,
		expectedFingerprint: leased.fingerprint,
		name: `Live Color Scale ${suffix}`,
		providerId: "builtin-color-scale",
		settings: { amount: 1.15 },
	});
	extensionId = created.extension.id;
	leased = await call("get_on_tile_rendering");
	const updated = await call("set_on_tile_renderer_extension", {
		expectedRevision: leased.configuration.revision,
		expectedFingerprint: leased.fingerprint,
		id: extensionId,
		order: 5,
		settings: { amount: 1.25 },
	});
	if (updated.configuration.extensions[0].settings.amount !== 1.25) throw new Error("On-Tile extension exact update failed.");
	const validation = await call("validate_on_tile_rendering");
	if (!validation.valid || !validation.suppressibleFeatureIds.includes(passId) || validation.nativeTileMemory !== false) throw new Error("On-Tile eligibility evidence failed.");
	leased = await call("get_on_tile_rendering");
	const applied = await call("apply_on_tile_rendering", { expectedRevision: leased.configuration.revision, expectedFingerprint: leased.fingerprint });
	if (!applied.runtime.portableCompositeAttached || applied.runtime.portableCompositePassCount !== 1) throw new Error("Portable single-composite apply failed.");
	await call("get_screenshot", { width: 320, height: 180 });
	const runtime = await call("get_on_tile_rendering_runtime");
	if (
		!runtime.active ||
		!runtime.portableCompositeReady ||
		runtime.frameCount < 1 ||
		runtime.nativeTileMemory !== false ||
		runtime.nativeBandwidthMeasurement !== null ||
		runtime.portableCompositePassCount !== 1
	)
		throw new Error("On-Tile runtime evidence or native boundary failed.");

	if (cdp.runtimeErrors.length) throw new Error(`Electron recorded runtime errors: ${cdp.runtimeErrors.join(" | ")}`);

	leased = await call("get_on_tile_rendering");
	await call("delete_on_tile_renderer_extension", { expectedRevision: leased.configuration.revision, expectedFingerprint: leased.fingerprint, id: extensionId, confirm: true });
	extensionId = undefined;
	leased = await call("get_on_tile_rendering");
	await call("set_on_tile_rendering", { expectedRevision: leased.configuration.revision, expectedFingerprint: leased.fingerprint, enabled: false, tileOnlyMode: false });
	await call("set_camera_post_process", { nodeId: cameraId, type: "customColor", enabled: false });
	await call("delete_custom_render_pass", { id: passId });
	passId = undefined;
	await call("delete_node", { nodeId: cameraId });
	cameraId = undefined;
	console.log(
		"[on-tile-rendering-live] PASS — 9/9 strict tools, exact stale/closed guards, validation, reversible suppression, fused provider extension, one real composite, normal Scene Inspector, honest native boundary, zero runtime errors, and semantic cleanup verified."
	);
} catch (error) {
	console.error(`[on-tile-rendering-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (extensionId) {
			const state = await call("get_on_tile_rendering");
			await call("delete_on_tile_renderer_extension", {
				expectedRevision: state.configuration.revision,
				expectedFingerprint: state.fingerprint,
				id: extensionId,
				confirm: true,
			});
		}
		const state = await call("get_on_tile_rendering");
		if (state.configuration.enabled || state.configuration.tileOnlyMode)
			await call("set_on_tile_rendering", { expectedRevision: state.configuration.revision, expectedFingerprint: state.fingerprint, enabled: false, tileOnlyMode: false });
		if (cameraId) {
			try {
				await call("set_camera_post_process", { nodeId: cameraId, type: "customColor", enabled: false });
			} catch {}
		}
		if (passId) await call("delete_custom_render_pass", { id: passId });
		if (cameraId) await call("delete_node", { nodeId: cameraId });
	} catch (cleanupError) {
		console.error(`[on-tile-rendering-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}

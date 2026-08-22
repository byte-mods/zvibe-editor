#!/usr/bin/env node
/** Real stdio/editor/UI-pixel lifecycle for Texture Inspector grayscale and colorized channel previews. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

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
	if (!response.ok) throw new Error(`Electron CDP target discovery failed with HTTP ${response.status} on port ${port}.`);
	const targets = (await response.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
	for (const target of targets) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		let requestId = 1;
		const requests = new Map();
		const exceptions = [];
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.id !== undefined && requests.has(message.id)) {
				requests.get(message.id)(message);
				requests.delete(message.id);
			}
			if (message.method === "Runtime.exceptionThrown") {
				exceptions.push(message.params?.exceptionDetails);
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
		if (await evaluate("Boolean(document.querySelector('.flexlayout__tab_button'))")) {
			await send("Runtime.enable");
			return { socket, evaluate, exceptions };
		}
		socket.close();
	}
	throw new Error(`No project editor page was found on Electron CDP port ${port}.`);
}

async function waitFor(read, predicate, label, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

const requiredTools = ["get_texture_channel_preview", "set_texture_channel_preview", "open_asset_inspector", "refresh_asset_registry_paths", "delete_asset"];
const suffix = `${Date.now()}-${process.pid}`;
const assetPath = `assets/.mcp-texture-channel-preview-${suffix}.svg`;
let projectDirectory;
let assetRegistered = false;
let previewRevision = 0;
let cdp;

const canvasEvidenceExpression = `(() => {
	const canvas = document.querySelector('canvas[aria-label="Texture channel preview"]');
	if (!canvas || !canvas.width || !canvas.height) return null;
	const context = canvas.getContext('2d');
	const points = [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]];
	return {
		channel: canvas.dataset.previewChannel,
		displayMode: canvas.dataset.previewDisplayMode,
		effectiveDisplayMode: canvas.dataset.previewEffectiveDisplayMode,
		revision: Number(canvas.dataset.previewRevision),
		width: canvas.width,
		height: canvas.height,
		pixels: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)),
	};
})()`;

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "texture-channel-preview-live-scenario", version: "1.0.0" },
	});
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
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the texture channel-preview live scenario.");
	projectDirectory = dirname(status.projectPath);
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	await writeFile(
		join(projectDirectory, assetPath),
		'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="#f00" d="M0 0h1v1H0z"/><path fill="#0f0" d="M1 0h1v1H1z"/><path fill="#00f" d="M0 1h1v1H0z"/><path fill="#fff" fill-opacity=".25" d="M1 1h1v1H1z"/></svg>',
		"utf8"
	);
	await call("refresh_asset_registry_paths", { paths: [assetPath] });
	assetRegistered = true;
	cdp = await connectCdp();
	await call("open_asset_inspector", { path: assetPath });
	await waitFor(
		() =>
			cdp.evaluate(`({
			controls: Boolean(document.querySelector('[data-testid="texture-channel-preview-controls"]')),
			renderError: [...document.querySelectorAll('.flexlayout__tab')].find((element) => element.textContent?.includes('Error rendering component'))?.textContent ?? null,
		})`),
		(value) => value?.controls === true,
		"Texture Inspector channel-preview controls"
	).catch((error) => {
		throw new Error(`${error instanceof Error ? error.message : String(error)}; renderer exceptions: ${JSON.stringify(cdp.exceptions)}`);
	});

	const initial = await call("get_texture_channel_preview", { path: assetPath });
	if (
		initial.channel !== "rgba" ||
		initial.displayMode !== "grayscale" ||
		initial.effectiveDisplayMode !== "original" ||
		initial.revision !== 0 ||
		initial.maximumPreviewDimension !== 1024 ||
		initial.persisted !== false ||
		initial.mutatesAsset !== false
	) {
		throw new Error(`Default preview evidence is incomplete: ${JSON.stringify(initial)}`);
	}

	const rgba = await waitFor(
		() => cdp.evaluate(canvasEvidenceExpression),
		(value) => value?.channel === "rgba" && value.width === 2 && value.height === 2,
		"RGBA canvas"
	);
	if (rgba.pixels[0][0] < 250 || rgba.pixels[1][1] < 250 || rgba.pixels[2][2] < 250 || rgba.pixels[3][3] < 60 || rgba.pixels[3][3] > 66) {
		throw new Error(`Original RGBA canvas did not preserve the asymmetric fixture: ${JSON.stringify(rgba)}`);
	}

	let changed = await call("set_texture_channel_preview", {
		path: assetPath,
		expectedRevision: previewRevision,
		channel: "red",
		displayMode: "colorized",
	});
	previewRevision = changed.revision;
	const red = await waitFor(
		() => cdp.evaluate(canvasEvidenceExpression),
		(value) => value?.channel === "red" && value.displayMode === "colorized" && value.revision === previewRevision,
		"colorized red canvas"
	);
	if (red.pixels[0][0] < 250 || red.pixels[0][1] !== 0 || red.pixels[1][0] !== 0 || red.pixels.some((pixel) => pixel[3] !== 255)) {
		throw new Error(`Colorized red canvas pixels are incorrect: ${JSON.stringify(red)}`);
	}

	changed = await call("set_texture_channel_preview", { path: assetPath, expectedRevision: previewRevision, channel: "blue", displayMode: "grayscale" });
	previewRevision = changed.revision;
	const blue = await waitFor(
		() => cdp.evaluate(canvasEvidenceExpression),
		(value) => value?.channel === "blue" && value.displayMode === "grayscale" && value.revision === previewRevision,
		"grayscale blue canvas"
	);
	if (blue.pixels[2][0] < 250 || blue.pixels[2][1] < 250 || blue.pixels[2][2] < 250 || blue.pixels[0][0] !== 0 || blue.pixels.some((pixel) => pixel[3] !== 255)) {
		throw new Error(`Grayscale blue canvas pixels are incorrect: ${JSON.stringify(blue)}`);
	}

	changed = await call("set_texture_channel_preview", { path: assetPath, expectedRevision: previewRevision, channel: "alpha", displayMode: "colorized" });
	previewRevision = changed.revision;
	const alpha = await waitFor(
		() => cdp.evaluate(canvasEvidenceExpression),
		(value) => value?.channel === "alpha" && value.effectiveDisplayMode === "grayscale" && value.revision === previewRevision,
		"alpha canvas"
	);
	if (
		alpha.pixels[3][0] < 60 ||
		alpha.pixels[3][0] > 66 ||
		alpha.pixels[3][0] !== alpha.pixels[3][1] ||
		alpha.pixels[3][1] !== alpha.pixels[3][2] ||
		alpha.pixels[3][3] !== 255
	) {
		throw new Error(`Alpha grayscale canvas pixels are incorrect: ${JSON.stringify(alpha)}`);
	}

	const staleError = await call("set_texture_channel_preview", { path: assetPath, expectedRevision: previewRevision - 1, channel: "green" }, true);
	if (!staleError.includes(`current revision ${previewRevision}`)) throw new Error(`Stale revision error is not actionable: ${staleError}`);
	const idempotent = await call("set_texture_channel_preview", {
		path: assetPath,
		expectedRevision: previewRevision,
		channel: "alpha",
		displayMode: "colorized",
	});
	if (idempotent.updated !== false || idempotent.revision !== previewRevision) throw new Error("Identical preview mutation was not idempotent.");

	changed = await call("set_texture_channel_preview", {
		path: assetPath,
		expectedRevision: previewRevision,
		channel: "rgba",
		displayMode: "grayscale",
	});
	previewRevision = changed.revision;
	await waitFor(
		() => cdp.evaluate(canvasEvidenceExpression),
		(value) => value?.channel === "rgba" && value.revision === previewRevision,
		"restored RGBA canvas"
	);
	await call("delete_asset", { path: assetPath, confirm: true });
	assetRegistered = false;
	await writeFile(
		join(projectDirectory, assetPath),
		'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="#f00" d="M0 0h1v1H0z"/><path fill="#0f0" d="M1 0h1v1H1z"/><path fill="#00f" d="M0 1h1v1H0z"/><path fill="#fff" fill-opacity=".25" d="M1 1h1v1H1z"/></svg>',
		"utf8"
	);
	await call("refresh_asset_registry_paths", { paths: [assetPath] });
	assetRegistered = true;
	const recreated = await call("get_texture_channel_preview", { path: assetPath });
	if (recreated.revision !== 0 || recreated.channel !== "rgba" || recreated.displayMode !== "grayscale") {
		throw new Error(`Deleted-path transient state leaked into a recreated asset: ${JSON.stringify(recreated)}`);
	}
	await call("delete_asset", { path: assetPath, confirm: true });
	assetRegistered = false;

	console.log(
		"[texture-channel-preview-live] PASS — 5/5 required tools, real stdio discovery/calls, default grayscale policy, colorized R, grayscale B, legible alpha, exact revisions, idempotence, real Inspector canvas pixels, restoration, deleted-path reset, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[texture-channel-preview-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (assetRegistered) await call("delete_asset", { path: assetPath, confirm: true });
		else if (projectDirectory) await rm(join(projectDirectory, assetPath), { force: true });
	} catch (cleanupError) {
		console.error(`[texture-channel-preview-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}

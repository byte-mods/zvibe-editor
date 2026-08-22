#!/usr/bin/env node
/** Real stdio/Electron lifecycle for portable Unity 6.5 VFX templates and batch release. */
import { spawn } from "node:child_process";
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
				const details = message.params?.exceptionDetails;
				runtimeErrors.push({
					text: details?.text ?? "Runtime.exceptionThrown",
					description: details?.exception?.description ?? details?.exception?.value ?? null,
					url: details?.url ?? null,
					lineNumber: details?.lineNumber ?? null,
					columnNumber: details?.columnNumber ?? null,
				});
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
	throw new Error(`No Zvibe Editor page was found on CDP port ${port}.`);
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

const requiredTools = ["list_vfx_graph_templates", "create_vfx_graph_from_template", "get_node_particle_batch_release", "set_node_particle_batch_release"];
const supportTools = ["get_editor_status", "instantiate_particle_system", "set_mesh_visibility", "select_node", "delete_node", "delete_asset"];
const suffix = `${Date.now()}-${process.pid}`;
const assetName = `Codex VFX 752 ${suffix}`;
let assetPath = null;
let node = null;
let emitterId = null;
let cdp = null;

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "vfx-graph-65-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
	for (const name of [...requiredTools, ...supportTools]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable editor project is required.");
	const filtered = await call("list_vfx_graph_templates", { query: "weather", category: "Environment", offset: 0, limit: 10 });
	if (filtered.total !== 1 || filtered.templates[0]?.id !== "rain-field") throw new Error(`VFX template filter failed: ${JSON.stringify(filtered)}`);
	const created = await call("create_vfx_graph_from_template", {
		templateId: "sparks-burst",
		expectedCatalogRevision: filtered.catalogRevision,
		name: assetName,
		folder: "assets",
	});
	assetPath = created.path;
	if (!assetPath?.endsWith(".npss") || created.systemCount !== 1) throw new Error(`VFX template creation failed: ${JSON.stringify(created)}`);
	await call("create_vfx_graph_from_template", { templateId: "starter-sprite", expectedCatalogRevision: "0".repeat(64), name: `${assetName} Stale`, folder: "assets" }, true);

	node = await call("instantiate_particle_system", { path: assetPath, name: `${assetName} Instance`, position: [0, 250, 0] });
	emitterId = node.parentId;
	let lifecycle = await call("get_node_particle_batch_release", { nodeId: node.id });
	if (lifecycle.state !== "active" || lifecycle.batchPresent !== true || lifecycle.systemCount !== 1) {
		throw new Error(`Initial VFX batch evidence is incomplete: ${JSON.stringify(lifecycle)}`);
	}
	await call("set_node_particle_batch_release", { nodeId: node.id, expectedRevision: "0".repeat(64), releaseOnDisable: true }, true);
	lifecycle = await call("set_node_particle_batch_release", {
		nodeId: node.id,
		expectedRevision: lifecycle.revision,
		releaseOnDisable: true,
	});
	if (lifecycle.policyEnabled !== true || lifecycle.state !== "active") throw new Error(`VFX release policy did not publish: ${JSON.stringify(lifecycle)}`);

	await call("set_mesh_visibility", { nodeId: node.id, isEnabled: false });
	lifecycle = await waitFor(
		() => call("get_node_particle_batch_release", { nodeId: node.id }),
		(value) => value.state === "released" && value.batchPresent === false && value.releaseCount === 1,
		"VFX batch release"
	);
	await call("set_mesh_visibility", { nodeId: node.id, isEnabled: true });
	lifecycle = await waitFor(
		() => call("get_node_particle_batch_release", { nodeId: node.id }),
		(value) => value.state === "active" && value.batchPresent === true && value.rebuildCount === 1,
		"VFX batch rebuild"
	);
	await call("select_node", { nodeId: node.id });

	cdp = await connectCdp();
	const ui = await waitFor(
		() =>
			cdp.evaluate(`(() => {
				const status = document.querySelector('[data-testid=vfx-batch-release-status]');
				const shaderFilter = document.querySelector('[aria-label="Filter Shader Graph template category"]');
				return status ? { status: status.textContent, title: document.title, shaderFilterOptions: shaderFilter ? Array.from(shaderFilter.options).map((option) => option.textContent) : [] } : null;
			})()`),
		(value) => value?.status?.includes("State: active") && value?.status?.includes("Rebuilds: 1"),
		"visible VFX batch Inspector evidence"
	);
	if (!ui.title?.trim()) throw new Error(`Visible editor title is missing: ${JSON.stringify(ui)}`);
	await new Promise((resolve) => setTimeout(resolve, 250));
	if (cdp.runtimeErrors.length) throw new Error(`Electron renderer errors: ${JSON.stringify(cdp.runtimeErrors)}`);

	console.log(
		JSON.stringify(
			{
				status: "PASS",
				toolCount: tools.length,
				filteredTemplate: filtered.templates[0].id,
				assetPath,
				lifecycle,
				ui,
			},
			null,
			2
		)
	);
} finally {
	const cleanupErrors = [];
	for (const id of [node?.id, emitterId]) {
		if (!id) continue;
		try {
			await call("delete_node", { nodeId: id });
		} catch (error) {
			if (!String(error).includes("not found")) cleanupErrors.push(`delete_node(${id}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (assetPath) {
		try {
			await call("delete_asset", { path: assetPath, confirm: true });
		} catch (error) {
			cleanupErrors.push(`delete_asset(${assetPath}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim() && !stderr.includes("Server started")) process.stderr.write(stderr);
	if (cleanupErrors.length) throw new Error(`Live scenario cleanup failed:\n${cleanupErrors.join("\n")}`);
}

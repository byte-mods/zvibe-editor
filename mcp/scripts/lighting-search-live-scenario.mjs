#!/usr/bin/env node
/** Real stdio/Electron lifecycle for Unity 6.5 Lighting Search parity. */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
let queryId;
let queryRevision;
let meshId;
let materialId;
let materialPath;
let lightId;
let fixtureDirectory;

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
				const entry = message.params.entry;
				const location = entry.url ? ` — ${entry.url}${entry.lineNumber ? `:${entry.lineNumber}` : ""}` : "";
				runtimeErrors.push(`${entry.text}${location}`);
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
		if (await evaluate("Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html') && document.querySelector('input[placeholder=\"Search...\"]'))")) {
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
	"inspect_lighting_search",
	"save_lighting_search_query",
	"delete_lighting_search_query",
	"query_lighting_search",
	"get_lighting_search_lightmap_preview",
	"set_lighting_search_properties",
];
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-18);
const fixtureName = `Lighting Search Fixture ${suffix}`;
const queryName = `Lighting Search Live ${suffix}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQsC/QAAAABJRU5ErkJggg==", "base64");

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lighting-search-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required.");
	const projectRoot = dirname(status.projectPath);
	fixtureDirectory = join(projectRoot, "assets", "Lighting", `SearchLive-${suffix}`);
	const lightmapPath = join("assets", "Lighting", `SearchLive-${suffix}`, "fixture.png");
	await mkdir(fixtureDirectory, { recursive: true });
	await writeFile(join(projectRoot, lightmapPath), png);

	const initial = await call("inspect_lighting_search");
	if (!initial.queryTree.some((entry) => entry.id === "lightmaps-all") || !initial.pipelines.includes("portable-deferred"))
		throw new Error("Lighting Search capabilities/query tree are incomplete.");
	const createdQuery = await call("save_lighting_search_query", {
		expectedRevision: initial.state.revision,
		expectedFingerprint: initial.fingerprint,
		query: {
			name: queryName,
			parentId: "lights",
			provider: "lights",
			pipeline: "portable-deferred",
			filters: [{ field: "intensity", operator: "gte", value: 1 }],
			columns: ["name", "type", "intensity", "shadowed"],
		},
	});
	queryId = createdQuery.query.id;
	queryRevision = createdQuery.query.revision;
	const stale = await call(
		"save_lighting_search_query",
		{
			expectedRevision: initial.state.revision,
			expectedFingerprint: initial.fingerprint,
			query: { name: "Stale", provider: "lights" },
		},
		true
	);
	if (!String(stale).includes("query tree changed")) throw new Error("Stale Lighting Search tree mutation did not reject.");
	const closed = await call("query_lighting_search", { provider: "lights", unknown: true }, true);
	if (!String(closed).includes("-32602")) throw new Error("Closed Lighting Search query schema did not reject an unknown field.");

	const fixture = await call("create_primitive_mesh", { type: "box", name: fixtureName, position: [0, 0, 0], options: { size: 20 } });
	meshId = fixture.id;
	const material = await call("create_material", { type: "pbr", name: `${fixtureName} Material`, folder: `assets/Lighting/SearchLive-${suffix}` });
	materialId = material.id;
	materialPath = material.path;
	await call("set_mesh_material", { nodeId: meshId, materialId });
	await call("set_material_lightmap", { materialId, texturePath: lightmapPath, coordinatesIndex: 1, level: 0.75, useLightmapAsShadowmap: false });

	const light = await call("create_light", { type: "point", name: `${fixtureName} Light`, position: [0, 100, 0], intensity: 2, range: 500 });
	lightId = light.id;
	const lightQuery = await call("query_lighting_search", { provider: "lights", pipeline: "portable-deferred", search: fixtureName, limit: 10 });
	if (lightQuery.total !== 1 || lightQuery.items[0].id !== light.id || !lightQuery.items[0].pipelines.includes("portable-deferred"))
		throw new Error("Lighting Search light provider/pipeline query failed.");
	const edited = await call("set_lighting_search_properties", {
		operations: [{ provider: "lights", id: light.id, expectedFingerprint: lightQuery.items[0].fingerprint, properties: { intensity: 3, diffuse: [1, 0.5, 0.25] } }],
	});
	if (edited.updated !== 1 || edited.items[0].properties.intensity !== 3) throw new Error("Lighting Search exact table edit failed.");
	const editStale = await call(
		"set_lighting_search_properties",
		{ operations: [{ provider: "lights", id: light.id, expectedFingerprint: lightQuery.items[0].fingerprint, properties: { intensity: 4 } }] },
		true
	);
	if (!String(editStale).includes("changed")) throw new Error("Stale Lighting Search item edit did not reject.");

	const savedQueryResult = await call("query_lighting_search", { queryId, search: fixtureName, limit: 10 });
	if (savedQueryResult.total !== 1 || savedQueryResult.items[0].id !== light.id) throw new Error("Saved Lighting Search query execution failed.");
	const lightmaps = await waitFor(
		() => call("query_lighting_search", { queryId: "lightmaps-all", search: fixtureName, limit: 10 }),
		(value) => value.total === 1 && value.items[0].properties.path === lightmapPath,
		"assigned lightmap provider row"
	);
	const preview = await call("get_lighting_search_lightmap_preview", { id: lightmaps.items[0].id, expectedFingerprint: lightmaps.items[0].fingerprint, exposureEV: 2 });
	if (preview.bytes !== png.length || preview.exposureMultiplier !== 4 || !/^[0-9a-f]{64}$/.test(preview.sha256) || !preview.previewUrl.startsWith("file:"))
		throw new Error("Lightmap preview metadata/exposure/hash evidence failed.");

	await call("select_editor_tab", { tab: "lighting-search" });
	cdp = await connectCdp();
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="lighting-search-workspace"]'))`), Boolean, "permanent Lighting Search workspace");
	const ui = await cdp.evaluate(`({
		queryTree: Boolean(document.querySelector('[data-testid="lighting-search-query-tree"]')),
		table: Boolean(document.querySelector('[data-testid="lighting-search-table"]')),
		pipeline: Boolean(document.querySelector('[data-testid="lighting-search-pipeline-selector"]')),
		batch: Boolean(document.querySelector('[data-testid="lighting-search-batch-edit"]')),
		preview: Boolean(document.querySelector('[data-testid="lighting-search-lightmap-preview"]')),
		text: document.body.innerText
	})`);
	if (!ui.queryTree || !ui.table || !ui.pipeline || !ui.batch || !ui.preview || !ui.text.includes("Lighting Queries"))
		throw new Error("Permanent Lighting Search UI controls are incomplete.");
	if (cdp.runtimeErrors.length) throw new Error(`Electron recorded runtime errors: ${cdp.runtimeErrors.join(" | ")}`);

	const current = await call("inspect_lighting_search");
	await call("delete_lighting_search_query", {
		expectedRevision: current.state.revision,
		expectedFingerprint: current.fingerprint,
		id: queryId,
		expectedQueryRevision: queryRevision,
		confirm: true,
	});
	queryId = undefined;
	await call("delete_node", { nodeId: light.id });
	lightId = undefined;
	await call("delete_node", { nodeId: meshId });
	meshId = undefined;
	await call("delete_material", { materialId });
	materialId = undefined;
	await rm(fixtureDirectory, { recursive: true, force: true });
	fixtureDirectory = undefined;
	const final = await call("inspect_lighting_search");
	if (final.state.customQueries.some((query) => query.name === queryName)) throw new Error("Lighting Search custom query cleanup failed.");
	console.log(
		"[lighting-search-live] PASS — 6/6 strict tools, built-in/custom query tree, pipeline filtering, exact stale guards, atomic property editing, project-contained lightmap preview/exposure/hash, permanent UI, zero runtime errors, and semantic cleanup verified."
	);
} catch (error) {
	console.error(`[lighting-search-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (queryId) {
			const current = await call("inspect_lighting_search");
			const query = current.state.customQueries.find((entry) => entry.id === queryId);
			if (query)
				await call("delete_lighting_search_query", {
					expectedRevision: current.state.revision,
					expectedFingerprint: current.fingerprint,
					id: queryId,
					expectedQueryRevision: query.revision,
					confirm: true,
				});
		}
		if (meshId) await call("delete_node", { nodeId: meshId });
		if (lightId) await call("delete_node", { nodeId: lightId });
		if (materialId) await call("delete_material", { materialId });
		if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
		void materialPath;
	} catch (cleanupError) {
		console.error(`[lighting-search-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}

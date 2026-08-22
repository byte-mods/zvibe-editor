#!/usr/bin/env node
/** Real MCP stdio -> rebuilt Electron lifecycle for portable Unity 6.5 UI Toolkit additions. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

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
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status}.`);
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
	throw new Error("No Zvibe Editor CDP page was found.");
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
	"get_gui_toolkit_capabilities",
	"inspect_gui_toolkit_workspace",
	"inspect_gui_uxml_upgrades",
	"apply_gui_uxml_upgrades",
	"set_gui_panel_renderer",
	"set_gui_stylesheet_stage",
	"set_gui_visual_element_reference",
	"set_gui_attribute_override",
	"delete_gui_attribute_override",
	"set_gui_animation",
	"delete_gui_animation",
	"simulate_gui_world_space_click",
	"release_gui_panel_renderer_resources",
];
const suffix = `${Date.now()}-${process.pid}`;
const guiPath = `assets/.codex-ui-toolkit-${suffix}.gui`;
const uxmlPath = `assets/.codex-ui-toolkit-${suffix}.uxml`;
const basePath = `assets/.codex-ui-toolkit-base-${suffix}.uss`;
const themePath = `assets/.codex-ui-toolkit-theme-${suffix}.uss`;
let projectRoot;
let guiId;
let guiRevision;
let nodeId;
let cdp;
let createdGUIAsset = false;
let createdSources = false;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ui-toolkit-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} tools, received ${tools.length}.`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is absent or has an open schema.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} lacks ${hint}.`);
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable editor project is required.");
	projectRoot = dirname(status.projectPath);
	const capabilities = await call("get_gui_toolkit_capabilities");
	if (!capabilities.panelRenderer?.nativeBabylonMeshTexture || !capabilities.testFramework?.worldSpaceSyntheticClick) throw new Error("UI Toolkit capabilities are incomplete.");

	const plane = await call("create_primitive_mesh", { type: "plane", name: `UI Toolkit Panel ${suffix}`, position: [0, 150, 0] });
	nodeId = plane.id;
	await call("create_gui_asset", { path: guiPath, name: `UI Toolkit HUD ${suffix}` });
	createdGUIAsset = true;
	const instantiated = await call("instantiate_gui_asset", { path: guiPath });
	guiId = instantiated.id;
	let result = await call("write_gui_retained_document", {
		guiId,
		expectedRevision: 0,
		expectedSourceFingerprint: null,
		uxml: {
			path: uxmlPath,
			source: `<UXML><Style src="${basePath.split("/").at(-1)}"/><Style src="${themePath.split("/").at(-1)}"/><Button name="play" class="action" text="Play"/></UXML>`,
		},
		stylesheets: [
			{ path: basePath, source: `.action { opacity: 0.5; color: #111111; }` },
			{ path: themePath, source: `.action { color: #222222; } .unused { opacity: 0.2; }` },
		],
		templates: [],
		hotReload: true,
		overwrite: false,
	});
	createdSources = true;
	guiRevision = result.revision;
	result = await call("set_gui_stylesheet_stage", {
		guiId,
		expectedRevision: guiRevision,
		expectedSourceFingerprint: result.retainedDocument.compiled.sourceFingerprint,
		contextId: "prefab-stage",
		activeStylesheetPath: basePath,
		stylesheetOrder: [themePath, basePath],
	});
	guiRevision = result.revision;
	result = await call("set_gui_visual_element_reference", { guiId, expectedRevision: guiRevision, reference: { id: "play-ref", controlId: "play", expectedTypeName: "Button" } });
	guiRevision = result.revision;
	result = await call("set_gui_attribute_override", { guiId, expectedRevision: guiRevision, override: { controlId: "play", property: "alpha", value: 0.8 } });
	guiRevision = result.revision;
	result = await call("set_gui_animation", {
		guiId,
		expectedRevision: guiRevision,
		animation: { id: "play-pulse", controlId: "play", property: "alpha", from: 0.2, to: 1, durationMs: 500, delayMs: 0, easing: "easeInOut", loop: true, autoplay: true },
	});
	guiRevision = result.revision;
	let workspace = await call("inspect_gui_toolkit_workspace", { guiId, offset: 0, limit: 100 });
	if (workspace.hierarchy.total !== 1 || workspace.uss.unmatchedSelectorCount !== 1 || workspace.references[0]?.resolved !== true)
		throw new Error(`Workspace evidence is incomplete: ${JSON.stringify(workspace)}`);
	result = await call("set_gui_panel_renderer", {
		guiId,
		expectedRevision: guiRevision,
		settings: {
			renderMode: "worldSpace",
			targetMeshId: nodeId,
			textureWidth: 512,
			textureHeight: 256,
			supportPointerMove: true,
			onlyAlphaTesting: false,
			invertY: true,
			foreground: true,
			releaseRootOnDispose: true,
		},
	});
	guiRevision = result.revision;
	if (!result.replaced || !result.panelRenderer.nativeMeshAttached) throw new Error(`World-space PanelRenderer was not native: ${JSON.stringify(result)}`);
	const clicked = await call("simulate_gui_world_space_click", { guiId, expectedRevision: guiRevision, controlId: "play", pointerId: 7, eventData: { scenario: "749" } });
	if (!clicked.clicked || !clicked.eventData.worldSpace) throw new Error(`World-space Click failed: ${JSON.stringify(clicked)}`);

	await writeFile(
		join(projectRoot, uxmlPath),
		`<UXML><Style src="${basePath.split("/").at(-1)}"/><Style src="${themePath.split("/").at(-1)}"/><Button name="play" className="action" picking-mode="Position" focus-index="1" visible="true" text="Play"/></UXML>`,
		"utf8"
	);
	const upgrade = await call("inspect_gui_uxml_upgrades", { guiId });
	await call(
		"apply_gui_uxml_upgrades",
		{ guiId, expectedRevision: guiRevision, expectedSourceFingerprint: workspace.sourceFingerprint, expectedSourceRevision: "0".repeat(64) },
		true
	);
	result = await call("apply_gui_uxml_upgrades", {
		guiId,
		expectedRevision: guiRevision,
		expectedSourceFingerprint: workspace.sourceFingerprint,
		expectedSourceRevision: upgrade.plan.sourceRevision,
	});
	guiRevision = result.revision;
	if (result.appliedEditCount !== 4) throw new Error(`UXML upgrades were incomplete: ${JSON.stringify(result)}`);
	workspace = await call("inspect_gui_toolkit_workspace", { guiId, offset: 0, limit: 100 });

	cdp = await connectCdp();
	const ui = await waitFor(
		() =>
			cdp.evaluate(
				`(() => { const root = document.querySelector('[data-testid=gui-toolkit-65-status]'); return root ? { text: root.textContent, title: document.title, draggable: root.querySelectorAll('[draggable=true]').length } : null; })()`
			),
		(value) => value?.text?.includes("visual elements") && value?.text?.includes("USS selectors") && value?.draggable === 2,
		"UI Toolkit 6.5 Inspector evidence"
	);
	if (!ui.title.trim()) throw new Error(`Missing live title: ${JSON.stringify(ui)}`);
	if (cdp.runtimeErrors.length) throw new Error(`Electron renderer errors: ${JSON.stringify(cdp.runtimeErrors)}`);

	console.log(
		JSON.stringify(
			{
				status: "PASS",
				toolCount: tools.length,
				panelRenderer: workspace.panelRenderer.runtime,
				hierarchyCount: workspace.hierarchy.total,
				selectorCount: workspace.uss.selectorStatistics.total,
				upgradeEdits: upgrade.plan.edits.length,
				ui,
			},
			null,
			2
		)
	);
} finally {
	const cleanupErrors = [];
	if (guiId && guiRevision !== undefined) {
		try {
			await call("release_gui_panel_renderer_resources", { guiId, expectedRevision: guiRevision, confirm: true });
			guiId = undefined;
		} catch (error) {
			cleanupErrors.push(`release GUI: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (nodeId) {
		try {
			await call("delete_node", { nodeId });
			nodeId = undefined;
		} catch (error) {
			cleanupErrors.push(`delete panel mesh: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const path of [createdGUIAsset ? guiPath : undefined, ...(createdSources ? [uxmlPath, basePath, themePath] : [])]) {
		if (!path) continue;
		try {
			await call("delete_asset", { path, confirm: true });
		} catch (error) {
			cleanupErrors.push(`delete_asset(${path}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim() && !stderr.includes("Server started")) process.stderr.write(stderr);
	if (cleanupErrors.length) throw new Error(`Live scenario cleanup failed:\n${cleanupErrors.join("\n")}`);
}

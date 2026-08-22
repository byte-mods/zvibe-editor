#!/usr/bin/env node
/** Positive live lifecycle for script rename, semantic diagnostics, and execution-order authoring. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "server", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params = {}, timeoutMs = 120_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
	if (response.error || response.result?.isError) throw new Error(`${name}: ${text || JSON.stringify(response.error ?? response.result)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const suffix = `${Date.now()}-${process.pid}`;
const sourcePath = `src/mcp-script-authoring-${suffix}.ts`;
const renamedPath = `src/mcp-script-authoring-renamed-${suffix}.ts`;
let nodeId = null;
let scriptPath = null;

async function cleanup() {
	if (scriptPath) {
		await call("set_scene_script_execution_order", { path: scriptPath, executionOrder: null }).catch(() => undefined);
		await call("set_project_script_execution_order", { path: scriptPath, executionOrder: null }).catch(() => undefined);
		if (nodeId) await call("detach_script", { nodeId, path: scriptPath }).catch(() => undefined);
		await call("delete_script", { path: scriptPath, confirm: true }).catch(() => undefined);
		scriptPath = null;
	}
	if (nodeId) {
		await call("delete_node", { nodeId }).catch(() => undefined);
		nodeId = null;
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "script-authoring-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.activeScenePath) throw new Error("A ready editor with an active scene is required.");
	const fixture = await call("create_primitive_mesh", { type: "empty", name: `MCP Script Authoring ${suffix}` });
	nodeId = fixture.id;
	await call("create_script", { path: sourcePath, template: "empty", className: "McpScriptAuthoringProbe" });
	scriptPath = sourcePath;
	const renamed = await call("rename_script", { sourcePath, destinationPath: renamedPath });
	if (!renamed.renamed || renamed.destinationPath !== renamedPath) throw new Error(`Script rename evidence is incomplete: ${JSON.stringify(renamed)}`);
	scriptPath = renamedPath;
	await call("write_script", {
		path: renamedPath,
		content: "export default class McpScriptAuthoringProbe { public onStart(): void {} public onUpdate(): void {} }\n",
	});
	const semantic = await call("get_script_semantic_diagnostics", { path: renamedPath });
	if (!semantic.valid || semantic.diagnostics.length) throw new Error(`The valid script produced semantic diagnostics: ${JSON.stringify(semantic)}`);
	await call("attach_script", { nodeId, path: renamedPath });
	const attachedOrder = await call("set_attached_script_execution_order", { nodeId, path: renamedPath, executionOrder: -125 });
	if (attachedOrder.executionOrder !== -125) throw new Error(`Attached execution order was not applied: ${JSON.stringify(attachedOrder)}`);
	let sceneOrders = await call("set_scene_script_execution_order", { path: renamedPath, executionOrder: -250 });
	if (sceneOrders.orders?.[renamedPath.replace(/^src\//, "")] !== -250) throw new Error(`Scene execution order was not applied: ${JSON.stringify(sceneOrders)}`);
	let projectOrders = await call("set_project_script_execution_order", { path: renamedPath, executionOrder: -500 });
	if (projectOrders.orders?.[renamedPath.replace(/^src\//, "")] !== -500) throw new Error(`Project execution order was not applied: ${JSON.stringify(projectOrders)}`);
	sceneOrders = await call("set_scene_script_execution_order", { path: renamedPath, executionOrder: null });
	projectOrders = await call("set_project_script_execution_order", { path: renamedPath, executionOrder: null });
	if (sceneOrders.orders?.[renamedPath.replace(/^src\//, "")] !== undefined || projectOrders.orders?.[renamedPath.replace(/^src\//, "")] !== undefined) {
		throw new Error("Execution-order cleanup did not clear both authored overrides.");
	}
	await cleanup();
	console.log("[script-authoring-live] PASS — rename, semantic diagnostics, attached/scene/project execution orders, clear operations, and MCP-only cleanup verified.");
} catch (error) {
	console.error(`[script-authoring-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

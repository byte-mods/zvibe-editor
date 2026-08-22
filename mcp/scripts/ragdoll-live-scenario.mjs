#!/usr/bin/env node
/** Positive live lifecycle for native editable Ragdoll assets. */
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

function rpc(method, params = {}, timeoutMs = 60_000) {
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

const path = `assets/mcp-ragdoll-${Date.now()}-${process.pid}.ragdoll`;
let created = false;

async function cleanup() {
	if (!created) return;
	try {
		await call("delete_asset", { path, confirm: true });
	} catch {
		// The fixture may already be gone after a completed lifecycle.
	}
	created = false;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ragdoll-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready) throw new Error("A ready editor is required.");

	const before = await call("list_ragdolls");
	const configuration = {
		assetRelativePath: "",
		rootNodeId: "",
		skeletonName: "",
		scalingFactor: 100,
		runtimeConfiguration: [],
	};
	const saved = await call("save_ragdoll", { path, configuration });
	created = true;
	if (!saved.saved || saved.path !== path || JSON.stringify(saved.configuration) !== JSON.stringify(configuration)) {
		throw new Error(`save_ragdoll returned incomplete evidence: ${JSON.stringify(saved)}`);
	}
	const listed = await call("list_ragdolls");
	if (listed.ragdolls.length !== before.ragdolls.length + 1 || !listed.ragdolls.some((entry) => entry.path === path)) {
		throw new Error("The saved Ragdoll asset was not listed.");
	}
	const read = await call("get_ragdoll", { path });
	if (JSON.stringify(read) !== JSON.stringify(configuration)) throw new Error(`get_ragdoll did not round-trip the native document: ${JSON.stringify(read)}`);
	await cleanup();
	const after = await call("list_ragdolls");
	if (after.ragdolls.length !== before.ragdolls.length || after.ragdolls.some((entry) => entry.path === path)) throw new Error("Ragdoll cleanup left an asset behind.");
	console.log("[ragdoll-live] PASS — save, list, get, native-document round-trip, and MCP-only asset cleanup completed.");
} catch (error) {
	console.error(`[ragdoll-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

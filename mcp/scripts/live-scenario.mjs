#!/usr/bin/env node
/**
 * Runs a real live MCP scenario against a RUNNING Zvibe Editor project window.
 *
 * The parity matrix only lets a row reach **Complete** once "a live MCP
 * scenario has been verified". That check used to be manual, which is why rows
 * drifted from reality. This makes it a repeatable command.
 *
 * Prerequisite — the editor must be running with a PROJECT open, not just the
 * dashboard (the MCP HTTP bridge only starts for a project window):
 *
 *   yarn start /absolute/path/to/project.bjseditor
 *
 * Usage:
 *   node scripts/live-scenario.mjs                 # connectivity + status
 *   node scripts/live-scenario.mjs --tools a,b,c   # assert tools are callable
 *   node scripts/live-scenario.mjs --components    # component round-trip
 *
 * Every mutation is undone before exit, so a scenario never leaves residue in
 * the user's project. Exits non-zero with a precise reason on any failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "index.mjs");

const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? (argv[index + 1] ?? "") : null;
};
const has = (name) => argv.includes(name);

if (!existsSync(SERVER)) {
	console.error("[live-scenario] bundled server missing — run: yarn workspace babylonjs-editor-mcp-server bundle");
	process.exit(2);
}

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});

let nextId = 1;
function rpc(method, params, timeoutMs = 60000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.[0]?.text ?? "";
	if (typeof text === "string" && text.startsWith("MCP error")) {
		throw new Error(`${name}: ${text.split("\n")[0]}`);
	}
	return text;
}

const failures = [];
let restore = null;

try {
	await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live-scenario", version: "1.0.0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	// 1. Connectivity — a dashboard-only editor fails here with "fetch failed".
	let status;
	try {
		status = JSON.parse(await call("get_editor_status"));
	} catch (error) {
		throw new Error(`no live editor reachable (${error.message}). Start one with: yarn start <project>.bjseditor`);
	}
	if (!status.ready) {
		throw new Error("editor responded but is not ready");
	}
	console.log(`[live-scenario] editor ready — project ${status.projectPath}`);
	console.log(`[live-scenario] active scene ${status.activeScenePath ?? "(none)"}`);

	// 2. Optional: assert specific tools are callable end to end.
	const toolList = flag("--tools");
	if (toolList) {
		for (const name of toolList
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)) {
			try {
				await call(name);
				console.log(`[live-scenario] ${name}: callable`);
			} catch (error) {
				failures.push(error.message);
			}
		}
	}

	// 3. Optional: full component round-trip on a real scene node, then undo.
	if (has("--components")) {
		const hierarchy = JSON.parse(await call("get_scene_hierarchy"));
		const node = (Array.isArray(hierarchy) ? hierarchy : []).find((entry) => entry.id);
		if (!node) {
			throw new Error("the open scene has no nodes to author on");
		}

		const registry = JSON.parse(await call("list_game_object_component_types", { nodeId: node.id }));
		const types = registry.types.map((entry) => entry.type);
		console.log(`[live-scenario] node "${node.name}" publishes: ${types.join(", ")}`);

		for (const type of ["entity", "network"]) {
			if (!types.includes(type)) {
				failures.push(`component type "${type}" is not published by the live editor`);
				continue;
			}
			const before = JSON.parse(await call("inspect_game_object_components", { nodeId: node.id }));
			const added = JSON.parse(await call("add_game_object_component", { nodeId: node.id, expectedFingerprint: before.fingerprint, type }));
			const component = added.components.find((entry) => entry.type === type);
			if (!component) {
				failures.push(`add_game_object_component did not return a "${type}" row`);
				continue;
			}
			console.log(`[live-scenario] added ${component.label}: ${JSON.stringify(component.data)}`);

			// Always undo the mutation, even if a later assertion fails.
			restore = async () => {
				const current = JSON.parse(await call("inspect_game_object_components", { nodeId: node.id }));
				const live = current.components.find((entry) => entry.id === component.id);
				if (live) {
					await call("remove_game_object_component", { nodeId: node.id, expectedFingerprint: current.fingerprint, componentId: component.id });
				}
			};
			await restore();
			restore = null;
			console.log(`[live-scenario] removed ${component.label} — project left unchanged`);
		}
	}
} catch (error) {
	failures.push(error.message);
} finally {
	if (restore) {
		try {
			await restore();
		} catch {
			failures.push("could not undo a scenario mutation — inspect the project manually");
		}
	}
	child.kill();
}

if (failures.length) {
	console.error("[live-scenario] FAIL");
	failures.forEach((failure) => console.error(`  - ${failure}`));
	process.exit(1);
}
console.log("[live-scenario] PASS");

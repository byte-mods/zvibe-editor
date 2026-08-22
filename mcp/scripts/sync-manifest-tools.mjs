#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "server", "index.mjs");
const manifestPath = join(here, "..", "manifest.json");

/** Discovers the exact client-visible tool catalog instead of duplicating source parsing rules. */
export async function discoverMcpTools(executable = serverPath) {
	const child = spawn(process.execPath, [executable], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map();
	let buffer = "";
	let nextId = 1;
	let stderr = "";
	let stopping = false;

	// Fail every outstanding request immediately when the discovery process itself fails.
	const failPending = (error) => {
		for (const { reject, timer } of pending.values()) {
			clearTimeout(timer);
			reject(error);
		}
		pending.clear();
	};

	child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
	child.on("error", (error) => failPending(new Error(`Unable to launch MCP server ${executable}: ${error.message}`)));
	child.on("exit", (code, signal) => {
		if (!stopping && pending.size) {
			failPending(new Error(`MCP server exited before discovery completed (code=${code ?? "none"}, signal=${signal ?? "none"}). ${stderr.trim()}`));
		}
	});
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		for (let newline; (newline = buffer.indexOf("\n")) >= 0; ) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try {
				const message = JSON.parse(line);
				pending.get(message.id)?.resolve(message);
				pending.delete(message.id);
			} catch (error) {
				failPending(new Error(`MCP server emitted invalid JSON: ${error.message}. Line: ${line.slice(0, 200)}`));
				child.kill();
				return;
			}
		}
	});

	const rpc = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Timed out waiting for MCP ${method}. ${stderr.trim()}`));
			}, 60_000);
			pending.set(id, {
				timer,
				reject,
				resolve: (message) => {
					clearTimeout(timer);
					if (message.error) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
					else resolve(message.result);
				},
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
				if (error && pending.delete(id)) {
					clearTimeout(timer);
					reject(new Error(`Unable to send MCP ${method}: ${error.message}`));
				}
			});
		});

	try {
		await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "manifest-sync", version: "1.0.0" } });
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const tools = [];
		let cursor;
		do {
			const page = await rpc("tools/list", cursor ? { cursor } : {});
			tools.push(...(page.tools ?? []));
			cursor = page.nextCursor;
		} while (cursor);
		return normalizeTools(tools);
	} finally {
		stopping = true;
		child.stdin.end();
		child.kill();
	}
}

/** Keeps MCPB metadata intentionally small while validating identity and discoverability. */
export function normalizeTools(tools) {
	const result = tools.map(({ name, description }) => ({ name, description }));
	const duplicates = result.filter((tool, index) => result.findIndex((candidate) => candidate.name === tool.name) !== index);
	if (duplicates.length) throw new Error(`Duplicate MCP tools: ${[...new Set(duplicates.map((tool) => tool.name))].join(", ")}`);
	const invalid = result.filter((tool) => typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" || !tool.description.trim());
	if (invalid.length) throw new Error(`MCP tools require non-empty names and descriptions: ${invalid.map((tool) => tool.name || "<unnamed>").join(", ")}`);
	return result;
}

export function getManifestDrift(manifest, tools) {
	const advertisedTools = manifest.tools ?? [];
	const advertised = new Map(advertisedTools.map((tool) => [tool.name, tool.description ?? ""]));
	const discovered = new Map(tools.map((tool) => [tool.name, tool.description]));
	return {
		generated: manifest.tools_generated === true,
		duplicates: advertisedTools.filter((tool, index) => advertisedTools.findIndex((candidate) => candidate.name === tool.name) !== index).map((tool) => tool.name),
		missing: tools.filter((tool) => !advertised.has(tool.name)).map((tool) => tool.name),
		extra: [...advertised.keys()].filter((name) => !discovered.has(name)),
		changed: tools.filter((tool) => advertised.has(tool.name) && advertised.get(tool.name) !== tool.description).map((tool) => tool.name),
	};
}

export function replaceManifestTools(source, tools) {
	const start = source.indexOf('\n\t"tools": [');
	const end = source.indexOf('\n\t"compatibility":', start);
	if (start < 0 || end < 0) throw new Error("manifest.json must contain tools immediately before compatibility.");
	const entries = tools.map((tool) => `\t\t${JSON.stringify(tool)}`).join(",\n");
	return `${source.slice(0, start).replace(/"tools_generated": (?:true|false),$/, '"tools_generated": true,')}\n\t"tools": [\n${entries}\n\t],${source.slice(end)}`;
}

async function main() {
	const mode = process.argv[2] ?? "--check";
	if (!new Set(["--check", "--write"]).has(mode)) throw new Error("Usage: sync-manifest-tools.mjs [--check|--write]");
	const [source, tools] = await Promise.all([readFile(manifestPath, "utf8"), discoverMcpTools()]);
	const manifest = JSON.parse(source);
	const drift = getManifestDrift(manifest, tools);
	if (mode === "--write") {
		const updated = replaceManifestTools(source, tools);
		await writeFile(manifestPath, await format(updated, { parser: "json", printWidth: 180, tabWidth: 4, trailingComma: "es5", useTabs: true }), "utf8");
	} else if (!drift.generated || drift.duplicates.length || drift.missing.length || drift.extra.length || drift.changed.length) {
		throw new Error(
			`MCPB manifest drift: generated=${drift.generated}, duplicates=${drift.duplicates.length}, missing=${drift.missing.length}, extra=${drift.extra.length}, changed=${drift.changed.length}. Run yarn sync-manifest-tools.`
		);
	}
	console.log(`[sync-manifest-tools] ${mode === "--write" ? "wrote" : "verified"} ${tools.length} tools.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => (console.error(`[sync-manifest-tools] ${error.message}`), process.exit(1)));

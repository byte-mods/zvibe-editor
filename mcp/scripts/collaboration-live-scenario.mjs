#!/usr/bin/env node
/** Real stdio/editor verification for read-only collaboration capability and readiness auditing. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

async function digest(path) {
	try {
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function metadataSnapshot(projectPath) {
	const root = dirname(projectPath);
	const names = ["collaboration.json", "merge-rules.json", "remote-collaboration.json", "remote-collaboration-discovery.json", "remote-collaboration-relay.json"];
	return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await digest(join(root, ".babylon-editor", name))])));
}

async function eventJournal(projectPath) {
	try {
		return JSON.parse(await readFile(join(dirname(projectPath), ".babylon-editor", "remote-collaboration-events.json"), "utf-8"));
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function verifyAuditJournal(before, after) {
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	if (!after || !Array.isArray(after.events) || !Number.isSafeInteger(after.nextSequence)) throw new Error("Collaboration event journal became malformed.");
	const firstNewSequence = before?.nextSequence ?? after.events[0]?.sequence ?? after.nextSequence;
	const appended = after.events.filter((entry) => entry.sequence >= firstNewSequence);
	if (before && after.nextSequence !== before.nextSequence + 2) throw new Error("Read-only collaboration inspection recorded an unexpected number of audit events.");
	if (
		JSON.stringify(appended.map((entry) => [entry.endpoint, entry.success])) !==
		JSON.stringify([
			["get_project_collaboration_capabilities", true],
			["validate_project_collaboration_readiness", true],
		])
	) {
		throw new Error("Read-only collaboration inspection recorded unexpected audit-journal entries.");
	}
	if (before) {
		const afterBySequence = new Map(after.events.map((entry) => [entry.sequence, entry]));
		for (const entry of before.events ?? []) {
			if (afterBySequence.has(entry.sequence) && JSON.stringify(afterBySequence.get(entry.sequence)) !== JSON.stringify(entry)) {
				throw new Error("Read-only collaboration inspection rewrote an existing audit-journal event.");
			}
		}
	}
}

const requiredTools = ["get_project_collaboration_capabilities", "validate_project_collaboration_readiness"];
const capabilityIds = [
	"identity-and-roles",
	"presence",
	"scene-coauthoring",
	"text-and-ordered-data",
	"semantic-conflict-resolution",
	"asset-coordination",
	"remote-collaboration",
	"change-and-review-workflows",
];

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "collaboration-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing.`);
		if (tool.inputSchema?.additionalProperties !== false || Object.keys(tool.inputSchema?.properties ?? {}).length !== 0)
			throw new Error(`${name} schema is not closed and empty.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
		if (!tool.annotations.readOnlyHint || tool.annotations.destructiveHint || !tool.annotations.idempotentHint || tool.annotations.openWorldHint) {
			throw new Error(`${name} safety annotations do not describe a closed read-only operation.`);
		}
	}

	const editorStatus = await call("get_editor_status");
	if (!editorStatus.ready || !editorStatus.projectPath) throw new Error("A ready project editor is required for the collaboration live scenario.");
	const before = await metadataSnapshot(editorStatus.projectPath);
	const beforeJournal = await eventJournal(editorStatus.projectPath);
	const capabilities = await call("get_project_collaboration_capabilities");
	if (capabilities.contractVersion !== 1 || JSON.stringify(capabilities.capabilities.map((entry) => entry.id)) !== JSON.stringify(capabilityIds)) {
		throw new Error("Collaboration capability identity/version evidence is incomplete.");
	}
	if (capabilities.capabilities.some((entry) => entry.state !== "complete") || !capabilities.conflictPolicy?.ambiguous?.includes("explicit conflicts")) {
		throw new Error("Collaboration capability or explicit-conflict evidence is incomplete.");
	}
	const readiness = await call("validate_project_collaboration_readiness");
	if (readiness.contractVersion !== 1 || !["ready", "setup-required", "attention-required"].includes(readiness.overall)) throw new Error("Readiness summary is malformed.");
	if (!Array.isArray(readiness.findings) || readiness.summary?.findingCount !== readiness.findings.length || typeof readiness.readiness?.conflictResolution !== "boolean") {
		throw new Error("Readiness findings/check evidence is incomplete.");
	}
	const findingCodes = readiness.findings.map((entry) => entry.code);
	if (capabilities.project.enforcementEnabled ? !findingCodes.includes("session_required") : !findingCodes.includes("authentication_disabled")) {
		throw new Error("Pre-session readiness did not report the expected authentication state.");
	}
	if (/accessKey|tokenHash|privateKey/i.test(JSON.stringify({ capabilities, readiness }))) throw new Error("Collaboration inspection returned credential material.");
	const after = await metadataSnapshot(editorStatus.projectPath);
	if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Read-only collaboration inspection changed project metadata.");
	verifyAuditJournal(beforeJournal, await eventJournal(editorStatus.projectPath));

	for (const name of requiredTools) {
		const rejected = await call(name, { unknown: true }, true);
		if (!String(rejected).includes("-32602")) throw new Error(`${name} did not reject an unknown field at the MCP boundary.`);
	}

	console.log(
		`[collaboration-live] PASS — ${requiredTools.length}/2 strict tools, eight capability groups, explicit-conflict boundaries, project readiness, secret redaction, byte-stable functional metadata, and exact append-only audit events verified against the running editor.`
	);
} catch (error) {
	console.error(`[collaboration-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

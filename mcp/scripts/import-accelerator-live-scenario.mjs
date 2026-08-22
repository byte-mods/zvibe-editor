#!/usr/bin/env node
/** Real stdio/editor lifecycle for project-owned Import Accelerator configuration, health, and diagnostics. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const healthServer = createServer((request, response) => {
	if (request.url === "/v1/health") {
		response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
		return;
	}
	response.writeHead(404).end();
});
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
		if (!line) {
			continue;
		}
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 60_000) {
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
	if (failed !== expectError) {
		throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	}
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) {
		return content ?? JSON.stringify(response.error);
	}
	return content ? JSON.parse(content) : result;
}

const requiredTools = [
	"get_import_accelerator_capabilities",
	"get_import_accelerator_configuration",
	"set_import_accelerator_configuration",
	"check_import_accelerator_connection",
	"get_import_accelerator_diagnostics",
	"clear_import_accelerator_diagnostics",
];
let baseline;

try {
	await new Promise((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "import-accelerator-live-scenario", version: "1.0.0" } });
	if (initialized.error) {
		throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	}
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) {
		throw new Error(`Missing Import Accelerator tools: ${missing.join(", ")}`);
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) {
		throw new Error("A ready project editor is required for the Import Accelerator live scenario.");
	}
	const capabilities = await call("get_import_accelerator_capabilities");
	if (capabilities.protocol !== "zvibe-import-accelerator-v1" || capabilities.artifactKinds.length !== 7 || !capabilities.features.atomicRollback) {
		throw new Error("Import Accelerator capability evidence is incomplete.");
	}
	baseline = await call("get_import_accelerator_configuration");
	const diagnostics = await call("get_import_accelerator_diagnostics", { offset: 0, limit: 5 });
	if (!Number.isSafeInteger(diagnostics.revision) || diagnostics.activities.length > 5) {
		throw new Error("Import Accelerator diagnostics pagination/revision evidence is invalid.");
	}
	await call("clear_import_accelerator_diagnostics", { expectedRevision: diagnostics.revision, confirm: false }, true);
	const clearedDiagnostics = await call("clear_import_accelerator_diagnostics", { expectedRevision: diagnostics.revision, confirm: true });
	if (clearedDiagnostics.revision !== diagnostics.revision + 1 || clearedDiagnostics.total !== 0 || clearedDiagnostics.activities.length !== 0) {
		throw new Error(`Import Accelerator diagnostics cleanup evidence is invalid: ${JSON.stringify(clearedDiagnostics)}`);
	}
	const address = healthServer.address();
	const endpoint = `http://127.0.0.1:${address.port}`;
	const changed = await call("set_import_accelerator_configuration", {
		expectedRevision: baseline.projectRevision,
		configuration: { enabled: false, endpoint, namespacePrefix: "live-scenario", downloadEnabled: true, uploadEnabled: true, contentValidation: "enabled" },
	});
	if (changed.projectRevision !== baseline.projectRevision + 1 || changed.configuration.endpoint !== endpoint || changed.authenticationAvailable) {
		throw new Error("Import Accelerator exact-revision configuration evidence is invalid.");
	}
	await call("set_import_accelerator_configuration", { expectedRevision: baseline.projectRevision, configuration: { enabled: true } }, true);
	await call("set_import_accelerator_configuration", { expectedRevision: changed.projectRevision, configuration: { endpoint: "http://cache.example" } }, true);
	const connection = await call("check_import_accelerator_connection");
	if (!connection.connected || connection.status !== 200 || !Number.isFinite(connection.latencyMilliseconds)) {
		throw new Error(`Import Accelerator health evidence is invalid: ${JSON.stringify(connection)}`);
	}

	console.log(
		`[import-accelerator-live] PASS — ${requiredTools.length}/6 tools present, closed schemas, seven artifact kinds, exact stale/unsafe endpoint rejection, guarded diagnostics, environment-only authentication evidence, and real editor-to-cache health.`
	);
} catch (error) {
	console.error(`[import-accelerator-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) {
		console.error(stderr.trim());
	}
	process.exitCode = 1;
} finally {
	try {
		if (baseline) {
			const current = await call("get_import_accelerator_configuration");
			await call("set_import_accelerator_configuration", { expectedRevision: current.projectRevision, configuration: baseline.configuration });
		}
	} catch (cleanupError) {
		console.error(`[import-accelerator-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	await new Promise((resolve) => healthServer.close(resolve));
	child.kill("SIGTERM");
}

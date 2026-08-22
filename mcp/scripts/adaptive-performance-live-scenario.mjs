#!/usr/bin/env node
/** Real stdio/editor lifecycle for Adaptive Performance authoring, thermal simulation, scaler evidence, strict guards, and exact cleanup. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let undoCount = 0;

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

function rpc(method, params, timeoutMs = 180_000) {
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

const requiredTools = [
	"get_adaptive_performance_capabilities",
	"get_adaptive_performance_configuration",
	"set_adaptive_performance_configuration",
	"get_adaptive_performance_runtime",
	"simulate_adaptive_performance_state",
	"reset_adaptive_performance_runtime",
];

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adaptive-performance-live-scenario", version: "1.0.0" } });
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
	if (!status.ready || !status.projectPath || !status.activeScenePath) {
		throw new Error("A ready disposable project editor with an active scene is required for Adaptive Performance live verification.");
	}
	const capabilities = await call("get_adaptive_performance_capabilities");
	if (capabilities.version !== 1 || capabilities.mcpTools?.length !== 6 || capabilities.scalers?.length !== 6) {
		throw new Error("Adaptive Performance capability or MCP inventory is incomplete.");
	}
	if (capabilities.editorSimulation?.hardwareEvidence !== false || !capabilities.boundaries?.some((entry) => entry.includes("hardware evidence"))) {
		throw new Error("Adaptive Performance simulation/native hardware boundary is incomplete.");
	}

	const baseline = await call("get_adaptive_performance_configuration");
	const configured = await call("set_adaptive_performance_configuration", {
		expectedRevision: baseline.configuration.revision,
		changes: {
			enabled: true,
			provider: "apple",
			platform: "ios",
			sampleFrames: 2,
			thermalActionDelaySeconds: 0,
			performanceActionDelaySeconds: 600,
		},
	});
	undoCount++;
	if (configured.configuration.revision !== baseline.configuration.revision + 1 || configured.runtime.providerSource !== "basic-fallback") {
		throw new Error("Exact authoring revision or Apple-to-Basic fallback evidence is incomplete.");
	}

	const stale = await call("set_adaptive_performance_configuration", { expectedRevision: baseline.configuration.revision, changes: { enabled: false } }, true);
	if (!String(stale).includes("revision is stale")) throw new Error("Adaptive Performance stale revision did not reject.");
	const unknown = await call("get_adaptive_performance_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Adaptive Performance unknown-field guard did not reject before editor I/O.");

	const simulated = await call("simulate_adaptive_performance_state", {
		expectedRevision: configured.configuration.revision,
		thermalState: "critical",
		temperatureLevel: 0.95,
		lowPowerMode: true,
		frameTimeMs: 16,
		cpuFrameTimeMs: 7,
		gpuFrameTimeMs: 9,
		repeat: 2,
	});
	if (
		!simulated.runtime.thermalWarning ||
		simulated.runtime.providerEvents?.at(-1)?.source !== "editor-simulation" ||
		!simulated.runtime.actions?.some((action) => action.reason === "thermal" && action.direction === "decrease-quality") ||
		simulated.runtime.qualityIndex >= 1
	) {
		throw new Error("Thermal simulation did not produce labeled provider and scaler-action evidence.");
	}
	const runtime = await call("get_adaptive_performance_runtime");
	if (runtime.configurationRevision !== configured.configuration.revision || runtime.runtime.acceptedSamples < 2 || runtime.runtime.scalers?.length !== 6) {
		throw new Error("Adaptive Performance live runtime evidence is incomplete.");
	}
	const reset = await call("reset_adaptive_performance_runtime", { expectedRevision: configured.configuration.revision });
	if (reset.runtime.lastDecision !== "reset" || reset.runtime.thermalState !== "unknown" || reset.runtime.actions?.length !== 0 || reset.runtime.qualityIndex !== 1) {
		throw new Error("Adaptive Performance reset did not restore exact transient baselines/evidence.");
	}

	await call("undo_editor");
	undoCount--;
	const final = await call("get_adaptive_performance_configuration");
	if (JSON.stringify(final.configuration) !== JSON.stringify(baseline.configuration)) {
		throw new Error("Adaptive Performance live scenario did not restore the exact authored baseline.");
	}

	console.log(
		"[adaptive-performance-live] PASS — 6/6 strict tools, exact authoring/stale rejection, Apple fallback boundary, labeled thermal simulation, measured timing/scaler evidence, reset, Undo, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[adaptive-performance-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	try {
		for (; undoCount > 0; undoCount--) await call("undo_editor");
	} catch (cleanupError) {
		console.error(`[adaptive-performance-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.stdin.end();
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}

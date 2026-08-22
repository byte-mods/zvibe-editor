#!/usr/bin/env node
/** Real stdio/editor lifecycle for Android/iOS system policy and portable gRPC-Web transport. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let undoCount = 0;

function envelope(payload, flag = 0) {
	const result = Buffer.alloc(payload.length + 5);
	result[0] = flag;
	result.writeUInt32BE(payload.length, 1);
	payload.copy(result, 5);
	return result;
}

const grpcServer = createServer((request, response) => {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader("access-control-allow-methods", "POST, OPTIONS");
	response.setHeader("access-control-allow-headers", "content-type,x-grpc-web,grpc-timeout");
	response.setHeader("access-control-expose-headers", "grpc-status,grpc-message");
	if (request.method === "OPTIONS") {
		response.writeHead(204).end();
		return;
	}
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks);
		if (body.length < 6 || body.readUInt32BE(1) !== body.length - 5) {
			response.writeHead(400).end();
			return;
		}
		const stream = request.url?.endsWith("/Watch") === true;
		const messages = stream ? [Buffer.from([8, 1]), Buffer.from([8, 2])] : [Buffer.from([10, 4, 112, 111, 110, 103])];
		const trailers = envelope(Buffer.from("grpc-status: 0\r\ngrpc-message: ok\r\n"), 0x80);
		response.writeHead(200, { "content-type": "application/grpc-web+proto" });
		response.end(Buffer.concat([...messages.map((message) => envelope(message)), trailers]));
	});
});
await new Promise((resolve, reject) => {
	grpcServer.once("error", reject);
	grpcServer.listen(0, "127.0.0.1", resolve);
});
const grpcPort = grpcServer.address().port;

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

const requiredTools = [
	"get_mobile_system_capabilities",
	"get_mobile_system_configuration",
	"set_mobile_system_configuration",
	"get_mobile_system_runtime",
	"simulate_mobile_system_state",
	"reset_mobile_system_runtime",
	"get_grpc_transport_capabilities",
	"get_grpc_transport_configuration",
	"set_grpc_transport_configuration",
	"invoke_grpc_unary",
	"invoke_grpc_server_stream",
	"get_grpc_transport_runtime",
];

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mobile-system-live-scenario", version: "1.0.0" } });
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
	if (!status.ready || !status.projectPath || !status.activeScenePath) throw new Error("A ready disposable project editor with an active scene is required.");
	const mobileCapabilities = await call("get_mobile_system_capabilities");
	const grpcCapabilities = await call("get_grpc_transport_capabilities");
	if (mobileCapabilities.iosThermalFrameRate?.seriousDefaultFps !== 30 || mobileCapabilities.iosThermalFrameRate?.criticalDefaultFps !== 15) {
		throw new Error("Mobile System 30/15 thermal defaults are incomplete.");
	}
	if (!grpcCapabilities.protocols?.includes("grpc-web-binary") || !grpcCapabilities.boundaries?.some((entry) => entry.includes("bidirectional"))) {
		throw new Error("Portable gRPC capability or boundary inventory is incomplete.");
	}

	const mobileBaseline = await call("get_mobile_system_configuration");
	const mobileConfigured = await call("set_mobile_system_configuration", {
		expectedRevision: mobileBaseline.configuration.revision,
		changes: {
			platform: "ios",
			android: { requestedVisibleWindowInsets: ["statusBars", "navigationBars", "ime"], systemBarsBehavior: "show-transient-bars-by-swipe" },
			iosThermalFrameRate: { enabled: true, seriousThermalStateFps: 30, criticalThermalStateFps: 15 },
		},
	});
	undoCount++;
	const mobileRevision = mobileConfigured.configuration.revision;
	const stale = await call("set_mobile_system_configuration", { expectedRevision: mobileBaseline.configuration.revision, changes: { platform: "android" } }, true);
	if (!String(stale).includes("revision is stale")) throw new Error("Mobile System stale revision did not reject.");
	const unknown = await call("get_mobile_system_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Mobile System unknown-field schema guard did not reject.");
	const simulation = await call("simulate_mobile_system_state", {
		expectedRevision: mobileRevision,
		windowInsets: { left: 0, top: 48, right: 0, bottom: 72 },
		visibleWindowInsets: ["statusBars", "navigationBars"],
		thermalState: "critical",
	});
	if (simulation.hardwareEvidence !== false || simulation.runtime.windowInsetsSource !== "editor-simulation" || simulation.runtime.appliedTargetFrameRate !== 15) {
		throw new Error("Mobile System simulation evidence, label, or Critical FPS gate is incomplete.");
	}
	const mobileRuntime = await call("get_mobile_system_runtime");
	if (mobileRuntime.configurationRevision !== mobileRevision || mobileRuntime.runtime.thermalState !== "critical")
		throw new Error("Mobile System runtime evidence is incomplete.");
	const mobileReset = await call("reset_mobile_system_runtime", { expectedRevision: mobileRevision });
	if (mobileReset.runtime.thermalState !== "unknown" || mobileReset.runtime.windowInsetsSource !== "none") throw new Error("Mobile System reset is incomplete.");

	const grpcBaseline = await call("get_grpc_transport_configuration");
	const grpcConfigured = await call("set_grpc_transport_configuration", {
		expectedRevision: grpcBaseline.configuration.revision,
		changes: {
			enabled: true,
			endpoint: `http://127.0.0.1:${grpcPort}`,
			protocol: "grpc-web-binary",
			defaultTimeoutMs: 5000,
			maximumSendMessageBytes: 1024,
			maximumReceiveMessageBytes: 1024,
		},
	});
	undoCount++;
	const grpcRevision = grpcConfigured.configuration.revision;
	const secret = await call("set_grpc_transport_configuration", { expectedRevision: grpcRevision, changes: { defaultMetadata: { authorization: "must-not-persist" } } }, true);
	if (!String(secret).includes("transiently per call")) throw new Error("Persisted secret-bearing gRPC metadata did not reject.");
	const unary = await call("invoke_grpc_unary", { expectedRevision: grpcRevision, service: "zvibe.Game", method: "Ping", payloadBase64: "CAA=" });
	if (unary.response.grpcStatus !== 0 || unary.response.messagesBase64?.[0] !== "CgRwb25n" || unary.response.trailers?.["grpc-message"] !== "ok") {
		throw new Error("Live gRPC-Web unary response or trailer evidence is incomplete.");
	}
	const stream = await call("invoke_grpc_server_stream", { expectedRevision: grpcRevision, service: "zvibe.Game", method: "Watch", payloadBase64: "CAA=" });
	if (stream.response.grpcStatus !== 0 || JSON.stringify(stream.response.messagesBase64) !== JSON.stringify(["CAE=", "CAI="])) {
		throw new Error("Live gRPC-Web server-stream evidence is incomplete.");
	}
	const grpcRuntime = await call("get_grpc_transport_runtime");
	if (grpcRuntime.runtime.calls?.length !== 2 || !grpcRuntime.runtime.calls.every((entry) => entry.succeeded)) throw new Error("Bounded gRPC call evidence is incomplete.");

	await call("undo_editor");
	undoCount--;
	await call("undo_editor");
	undoCount--;
	const finalMobile = await call("get_mobile_system_configuration");
	const finalGrpc = await call("get_grpc_transport_configuration");
	if (
		JSON.stringify(finalMobile.configuration) !== JSON.stringify(mobileBaseline.configuration) ||
		JSON.stringify(finalGrpc.configuration) !== JSON.stringify(grpcBaseline.configuration)
	) {
		throw new Error("Live scenario did not restore exact authored baselines.");
	}

	console.log(
		"[mobile-system-live] PASS — 12/12 strict tools, exact authoring/stale/schema/secret guards, labeled inset and 30/15 thermal evidence, reset, real gRPC-Web unary/server stream with trailers, bounded call evidence, Undo, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[mobile-system-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	try {
		for (; undoCount > 0; undoCount--) await call("undo_editor");
	} catch (cleanupError) {
		console.error(`[mobile-system-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.stdin.end();
	await new Promise((resolve) => grpcServer.close(resolve));
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve();
		}, 2000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}

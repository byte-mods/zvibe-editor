#!/usr/bin/env node
/** Real MCP stdio -> rebuilt Electron lifecycle for the portable Unity 6.5 hybrid physics workflow. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	if (failed !== expectError) {
		throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	}
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) {
		return content ?? JSON.stringify(response.error);
	}
	return content ? JSON.parse(content) : result;
}

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) {
			throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		}
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) {
		throw new Error(`Electron CDP discovery failed with HTTP ${response.status}.`);
	}
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
				runtimeErrors.push(message.params.entry.text);
			}
		});
		const send = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = requestId++;
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP ${method}.`)), 15_000);
				requests.set(id, (message) => {
					clearTimeout(timer);
					if (message.error) {
						reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
					} else {
						resolve(message.result);
					}
				});
				socket.send(JSON.stringify({ id, method, params }));
			});
		const evaluate = async (expression) => {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) {
				throw new Error(`CDP evaluation failed: ${result.exceptionDetails.text}`);
			}
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
		if (predicate(value)) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

const requiredTools = [
	"get_hybrid_physics_capabilities",
	"get_hybrid_physics_solver",
	"set_hybrid_physics_solver",
	"reset_hybrid_physics_solver",
	"get_hybrid_physics_runtime",
	"solve_hybrid_physics_now",
	"create_hybrid_physics_gear_coupling",
	"set_hybrid_physics_gear_coupling",
	"delete_hybrid_physics_gear_coupling",
	"set_physics_constraint_solver",
	"create_chain_gears_physics_sample",
	"delete_chain_gears_physics_sample",
];
const suffix = `${Date.now()}-${process.pid}`;
const sampleId = `codex-hybrid-${suffix}`;
const extraCouplingId = `codex-extra-gear-${suffix}`;
let sample = null;
let extraCouplingExists = false;
let cdp;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hybrid-physics-live-scenario", version: "1.0.0" } });
	if (initialized.error) {
		throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	}
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) {
		throw new Error(`Expected ${expectedToolCount} tools, received ${tools.length}.`);
	}
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) {
			throw new Error(`${name} is absent or has an open schema.`);
		}
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") {
				throw new Error(`${name} lacks ${hint}.`);
			}
		}
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) {
		throw new Error("A ready disposable editor project is required.");
	}
	const capabilities = await call("get_hybrid_physics_capabilities");
	if (capabilities.maximumDirectRows !== 256 || capabilities.processingPolicy?.includes("only when") !== true) {
		throw new Error(`Hybrid physics capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}
	let solver = await call("get_hybrid_physics_solver");
	if (solver.persisted || solver.samples.length || solver.configuration.gearCouplings.length) {
		throw new Error("The disposable scene already contains hybrid physics state; exact live verification refuses to overwrite it.");
	}
	await call("set_hybrid_physics_solver", { expectedRevision: solver.configuration.revision, maximumRows: 96, positionErrorBias: 0.25 });
	await call("set_hybrid_physics_solver", { expectedRevision: solver.configuration.revision, maximumRows: 32 }, true);
	solver = await call("get_hybrid_physics_solver");
	const created = await call("create_chain_gears_physics_sample", {
		expectedRevision: solver.configuration.revision,
		id: sampleId,
		name: "Codex Hybrid Chain & Gears",
		position: [0, 260, 0],
		linkCount: 16,
		gearRatio: 1.25,
		driveVelocity: 1.2,
	});
	sample = created.sample;
	if (created.mechanism.linkCount !== 16 || created.mechanism.directJointCount !== 18 || !created.mechanism.iterativeContacts) {
		throw new Error(`Sample mechanism evidence is incomplete: ${JSON.stringify(created)}`);
	}
	const gearA = sample.nodeIds[1];
	const gearB = sample.nodeIds[3];
	solver = await call("get_hybrid_physics_solver");
	await call("create_hybrid_physics_gear_coupling", {
		expectedRevision: solver.configuration.revision,
		id: extraCouplingId,
		name: "Live extra gear row",
		bodyANodeId: gearA,
		bodyBNodeId: gearB,
		axisA: [0, 1, 0],
		axisB: [0, 1, 0],
		ratio: -0.75,
	});
	extraCouplingExists = true;
	solver = await call("get_hybrid_physics_solver");
	await call("set_hybrid_physics_gear_coupling", { expectedRevision: solver.configuration.revision, id: extraCouplingId, ratio: -0.8, maximumImpulse: 25000 });
	solver = await call("get_hybrid_physics_solver");
	await call("delete_hybrid_physics_gear_coupling", { expectedRevision: solver.configuration.revision, id: extraCouplingId, confirm: true });
	extraCouplingExists = false;
	await call("set_physics_constraint_solver", { id: sample.constraintIds[0], expectedRevision: 1, solverMode: "iterative" });
	await call("set_physics_constraint_solver", { id: sample.constraintIds[0], expectedRevision: 2, solverMode: "direct" });
	solver = await call("get_hybrid_physics_solver");
	const solved = await call("solve_hybrid_physics_now", { expectedRevision: solver.configuration.revision, deltaSeconds: 1 / 60 });
	const runtime = await call("get_hybrid_physics_runtime");
	if (solved.havokAdvanced || solved.runtime.rowCount < 16 || runtime.runtime.processedFrames < 1) {
		throw new Error(`Direct solver runtime evidence is incomplete: ${JSON.stringify({ solved, runtime })}`);
	}

	cdp = await connectCdp();
	const ui = await waitFor(
		() =>
			cdp.evaluate(
				`(() => { const root = document.querySelector('[data-testid=hybrid-physics-solver-status]'); return root ? { text: root.textContent, title: document.title } : null; })()`
			),
		(value) => value?.text?.includes("Hybrid Direct + Iterative Solver") && value?.text?.includes("Codex Hybrid Chain & Gears") && value?.text?.includes("direct joints"),
		"hybrid physics Inspector evidence"
	);
	if (!ui.title.trim() || cdp.runtimeErrors.length) {
		throw new Error(`Electron UI verification failed: ${JSON.stringify({ ui, runtimeErrors: cdp.runtimeErrors })}`);
	}

	console.log(
		JSON.stringify(
			{
				status: "PASS",
				toolCount: tools.length,
				mechanism: created.mechanism,
				runtime: {
					rows: solved.runtime.rowCount,
					processedFrames: runtime.runtime.processedFrames,
					residualBefore: solved.runtime.maximumResidualBefore,
					residualAfter: solved.runtime.maximumResidualAfter,
					skippedFrames: runtime.runtime.skippedFrames,
				},
				ui,
			},
			null,
			2
		)
	);
} finally {
	const cleanupErrors = [];
	try {
		let solver = await call("get_hybrid_physics_solver");
		if (extraCouplingExists && solver.configuration.gearCouplings.some((coupling) => coupling.id === extraCouplingId)) {
			await call("delete_hybrid_physics_gear_coupling", { expectedRevision: solver.configuration.revision, id: extraCouplingId, confirm: true });
			extraCouplingExists = false;
		}
		solver = await call("get_hybrid_physics_solver");
		const retainedSample = solver.samples.find((candidate) => candidate.id === sampleId);
		if (retainedSample) {
			await call("delete_chain_gears_physics_sample", {
				id: sampleId,
				expectedRevision: retainedSample.revision,
				expectedConfigurationRevision: solver.configuration.revision,
				confirm: true,
			});
			sample = null;
		}
		solver = await call("get_hybrid_physics_solver");
		if (solver.persisted && !solver.samples.length && !solver.configuration.gearCouplings.length) {
			await call("reset_hybrid_physics_solver", { expectedRevision: solver.configuration.revision, confirm: true });
		}
		const final = await call("get_hybrid_physics_solver");
		if (final.persisted || final.samples.length || final.configuration.gearCouplings.length) {
			throw new Error(`Hybrid state remained after cleanup: ${JSON.stringify(final)}`);
		}
	} catch (error) {
		cleanupErrors.push(error instanceof Error ? error.message : String(error));
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim() && !stderr.includes("Server started")) {
		process.stderr.write(stderr);
	}
	if (cleanupErrors.length) {
		throw new Error(`Live scenario cleanup failed:\n${cleanupErrors.join("\n")}`);
	}
}

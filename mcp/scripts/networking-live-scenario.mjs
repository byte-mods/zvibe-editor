#!/usr/bin/env node
/** Real stdio/editor lifecycle for Networking configuration, host/lobby, isolated Multiplayer Play, strict guards, and cleanup. */
import { spawn } from "node:child_process";
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

async function waitFor(read, predicate, label, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

const requiredTools = [
	"get_networking_capabilities",
	"get_networking_configuration",
	"set_networking_configuration",
	"validate_networking_target",
	"start_gameplay_session_host",
	"stop_gameplay_session_host",
	"get_gameplay_session_host_status",
	"create_gameplay_session",
	"list_gameplay_sessions",
	"get_gameplay_session",
	"set_gameplay_session",
	"delete_gameplay_session",
	"connect_networking_runtime",
	"disconnect_networking_runtime",
	"get_networking_runtime",
	"set_networking_ownership",
	"submit_networking_input",
	"send_networking_rpc",
	"clear_networking_evidence",
	"start_multiplayer_play_mode",
	"get_multiplayer_play_mode",
	"control_multiplayer_play_mode",
	"stop_multiplayer_play_mode",
];

const suffix = `${Date.now()}-${process.pid}`;
const fixtures = [];
let baseline;
let configurationChanged = false;
let hostStarted = false;
let multiplayerStarted = false;
let previewStarted = false;
let standaloneSession = null;

function configurationChanges(configuration) {
	return {
		enabled: configuration.enabled,
		topology: configuration.topology,
		transport: configuration.transport,
		replication: configuration.replication,
		prediction: configuration.prediction,
		simulation: configuration.simulation,
		session: configuration.session,
		maximumTraceEvents: configuration.maximumTraceEvents,
	};
}

function semanticConfiguration(configuration) {
	const result = structuredClone(configuration);
	delete result.revision;
	return result;
}

async function createReplicatedFixture(index) {
	const node = await call("create_primitive_mesh", {
		type: "box",
		name: `Networking Live Player ${index + 1} ${suffix}`,
		position: [index * 120, 100, 0],
		options: { width: 50, height: 50, depth: 50 },
	});
	fixtures.push(node.id);
	const stack = await call("inspect_game_object_components", { nodeId: node.id });
	const networkId = `network-live-${index + 1}-${suffix}`;
	await call("add_game_object_component", {
		nodeId: node.id,
		expectedFingerprint: stack.fingerprint,
		type: "network",
		data: { networkId, authority: "owner", syncTransform: true, syncAnimation: false, sendRateHz: 30, interpolate: true },
	});
	return networkId;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "networking-live-scenario", version: "1.0.0" } });
	if (initialized.error) {
		throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	}
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			throw new Error(`${name} is missing.`);
		}
		if (tool.inputSchema?.additionalProperties !== false) {
			throw new Error(`${name} input schema is not closed.`);
		}
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") {
				throw new Error(`${name} is missing ${hint}.`);
			}
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath || !status.activeScenePath) {
		throw new Error("A ready disposable project editor with an active scene is required for Networking live verification.");
	}
	const capabilities = await call("get_networking_capabilities");
	if (capabilities.configurationVersion !== 1 || capabilities.topology?.[0] !== "client-server" || capabilities.playMode?.supportedPlayers?.length !== 4) {
		throw new Error("Networking capability/topology/Multiplayer Play evidence is incomplete.");
	}
	if (!capabilities.providerBoundaries?.includes("Unity Transport protocol identity")) {
		throw new Error("Networking provider boundaries are incomplete.");
	}
	baseline = await call("get_networking_configuration");
	const beforeHost = await call("get_gameplay_session_host_status");
	if (beforeHost.listening || beforeHost.sessionCount || (await call("get_multiplayer_play_mode")).active) {
		throw new Error("Stop existing gameplay sessions and Multiplayer Play Mode before running the disposable Networking scenario.");
	}

	const networkIds = [await createReplicatedFixture(0), await createReplicatedFixture(1)];
	let configuration = await call("set_networking_configuration", {
		expectedRevision: baseline.revision,
		changes: {
			enabled: true,
			transport: { autoConnect: false, reconnect: true, connectionTimeoutMs: 10_000 },
			replication: { tickRateHz: 60, snapshotRateHz: 20 },
			prediction: { enabled: true, rollbackReplay: true },
			simulation: { enabled: false, seed: 726 },
			session: { maximumPlayers: 4, reconnectGraceMs: 10_000, allowHostMigration: true, publicLobby: false },
		},
	});
	configurationChanged = true;
	const stale = await call("set_networking_configuration", { expectedRevision: baseline.revision, changes: { enabled: false } }, true);
	if (!String(stale).includes("revision is stale")) {
		throw new Error("Networking stale configuration mutation did not reject.");
	}
	const validation = await call("validate_networking_target", { target: "web", requireEnabled: true });
	if (!validation.ready || validation.networkComponentCount < 2 || validation.configurationRevision !== configuration.revision) {
		throw new Error("Networking target/component validation evidence is incomplete.");
	}
	await call("save_scene");

	const host = await call("start_gameplay_session_host", { port: 0 });
	hostStarted = true;
	if (!host.listening || host.security?.loopbackOnly !== true || host.security?.secretsPersisted !== false) {
		throw new Error("Gameplay host loopback/security evidence is incomplete.");
	}
	const created = await call("create_gameplay_session", { expectedRevision: configuration.revision, name: `Networking Live ${suffix}`, maximumPlayers: 2, publicLobby: true });
	standaloneSession = created.session;
	if (!created.connection?.hostToken || !created.connection?.joinCode || JSON.stringify(created.session).includes(created.connection.hostToken)) {
		throw new Error("Gameplay session one-time credential boundary is incomplete.");
	}
	const listed = await call("list_gameplay_sessions", { publicOnly: true, limit: 10 });
	if (!listed.sessions.some((session) => session.id === created.session.id && session.joinCode === created.connection.joinCode)) {
		throw new Error("Public lobby browsing did not return the created join code.");
	}
	standaloneSession = await call("set_gameplay_session", {
		sessionId: created.session.id,
		expectedRevision: created.session.revision,
		changes: { name: `Networking Live Updated ${suffix}`, publicLobby: false },
	});
	const inspectedSession = await call("get_gameplay_session", { sessionId: standaloneSession.id });
	if (inspectedSession.revision !== standaloneSession.revision || /hostToken|reconnectToken/.test(JSON.stringify(inspectedSession))) {
		throw new Error("Gameplay session exact revision or credential-free inspection failed.");
	}
	await call("set_preview_play_mode", { action: "play" });
	previewStarted = true;
	await call("connect_networking_runtime", {
		expectedRevision: configuration.revision,
		connection: { endpoint: created.connection.endpoint, hostToken: created.connection.hostToken, clientId: `host-${process.pid}`, displayName: "Live Runtime Host" },
	});
	let runtime = await waitFor(
		() => call("get_networking_runtime", { offset: 0, limit: 200 }),
		(value) => value.runtime?.state === "connected",
		"connected Play networking runtime"
	);
	await call("set_networking_ownership", { networkId: networkIds[0], claim: true });
	runtime = await waitFor(
		() => call("get_networking_runtime", { offset: 0, limit: 200 }),
		(value) => value.runtime?.ownedNetworkIds?.includes(networkIds[0]),
		"network object ownership"
	);
	const input = await call("submit_networking_input", { networkId: networkIds[0], translation: [1, 0, 0], rotationDegrees: [0, 5, 0] });
	const rpcEvidence = await call("send_networking_rpc", { name: "live-runtime-rpc", target: "server", channel: "reliable", payload: { verified: true } });
	if (input.networkId !== networkIds[0] || rpcEvidence.name !== "live-runtime-rpc" || runtime.trace.total < 1) {
		throw new Error(`Connected networking runtime evidence is incomplete: ${JSON.stringify({ runtime, input, rpcEvidence })}`);
	}
	const clearedRuntime = await call("clear_networking_evidence", { confirm: true });
	const traceAfterClear = await call("get_networking_runtime", { offset: 0, limit: 10 });
	if (
		clearedRuntime.state !== "connected" ||
		Object.entries(clearedRuntime.metrics).some(([name, value]) => (name === "roundTripTimeMs" ? value !== null : value !== 0)) ||
		traceAfterClear.trace.events.some((event) => event.type !== "snapshot") ||
		(traceAfterClear.trace.events.length > 0 && traceAfterClear.trace.events[0].sequence !== 1)
	)
		throw new Error(`Networking evidence clearing did not preserve the connection or empty the trace: ${JSON.stringify({ clearedRuntime, traceAfterClear })}`);
	await call("disconnect_networking_runtime", { confirm: true });
	runtime = await call("get_networking_runtime", { offset: 0, limit: 10 });
	if (runtime.runtime?.state !== "disconnected") throw new Error(`Networking runtime did not disconnect: ${JSON.stringify(runtime)}`);
	await call("set_preview_play_mode", { action: "stop" });
	previewStarted = false;
	standaloneSession = await call("get_gameplay_session", { sessionId: standaloneSession.id });
	await call("delete_gameplay_session", { sessionId: standaloneSession.id, expectedRevision: standaloneSession.revision, confirm: true });
	standaloneSession = null;

	let multiplayer = await call("start_multiplayer_play_mode", {
		expectedRevision: configuration.revision,
		playerCount: 2,
		playerNames: ["Live Host", "Live Client"],
		assignments: networkIds,
		simulations: [null, { enabled: true, latencyMs: 2, jitterMs: 1, packetLossPercent: 0, packetReorderPercent: 0, seed: 726 }],
	});
	multiplayerStarted = true;
	if (!multiplayer.active || multiplayer.run?.state !== "running" || multiplayer.run?.players?.length !== 2) {
		throw new Error("Multiplayer Play Mode did not start two players.");
	}
	if (multiplayer.run.players[0].role !== "host" || multiplayer.run.players[1].role !== "client" || multiplayer.run.players[1].primary !== false) {
		throw new Error("Multiplayer Play isolated role evidence is incomplete.");
	}
	if (/hostToken|joinCode|reconnectToken/.test(JSON.stringify(multiplayer))) {
		throw new Error("Multiplayer Play status exposed a credential field.");
	}
	const staleRunRevision = multiplayer.run.revision;
	multiplayer = await call("control_multiplayer_play_mode", { expectedRunRevision: multiplayer.run.revision, command: "pause", playerIndex: 1 });
	const staleControl = await call("control_multiplayer_play_mode", { expectedRunRevision: staleRunRevision, command: "resume", playerIndex: 1 }, true);
	if (!String(staleControl).includes("revision is stale")) {
		throw new Error("Multiplayer Play stale run control did not reject.");
	}
	multiplayer = await call("control_multiplayer_play_mode", { expectedRunRevision: multiplayer.run.revision, command: "render-frames", playerIndex: 1, frames: 2 });
	multiplayer = await call("control_multiplayer_play_mode", {
		expectedRunRevision: multiplayer.run.revision,
		command: "set-simulation",
		playerIndex: 1,
		simulation: { enabled: true, latencyMs: 5, seed: 727 },
	});
	multiplayer = await call("control_multiplayer_play_mode", { expectedRunRevision: multiplayer.run.revision, command: "disconnect-player", playerIndex: 1 });
	multiplayer = await call("control_multiplayer_play_mode", { expectedRunRevision: multiplayer.run.revision, command: "reconnect-player", playerIndex: 1 });
	if (multiplayer.run.players[1].runtime.state !== "connected" || multiplayer.run.players[1].runtime.simulation.latencyMs !== 5) {
		throw new Error("Multiplayer Play simulation/reconnect evidence is incomplete.");
	}
	await call("stop_multiplayer_play_mode", { confirm: true });
	multiplayerStarted = false;
	if ((await call("get_multiplayer_play_mode")).active) {
		throw new Error("Multiplayer Play lease remained after stop.");
	}
	await call("stop_gameplay_session_host", { confirm: true });
	hostStarted = false;
	const finalHost = await call("get_gameplay_session_host_status");
	if (finalHost.listening || finalHost.sessionCount || finalHost.connectionCount) {
		throw new Error("Gameplay host retained listener/session/connection state after stop.");
	}

	await call("undo_editor");
	configurationChanged = false;
	for (const nodeId of fixtures.splice(0)) {
		await call("delete_node", { nodeId });
	}
	await call("save_scene");
	const finalConfiguration = await call("get_networking_configuration");
	if (JSON.stringify(semanticConfiguration(finalConfiguration)) !== JSON.stringify(semanticConfiguration(baseline)) || finalConfiguration.revision !== baseline.revision) {
		throw new Error("Networking live cleanup did not restore the exact authored configuration baseline.");
	}
	const unknown = await call("get_networking_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) {
		throw new Error("Networking capabilities did not reject an unknown field before editor contact.");
	}

	console.log(
		"[networking-live] PASS — 23/23 strict tools, exact configuration/Undo, target validation, loopback host, lobby CRUD, credential boundary, isolated two-player Play, simulation, disconnect/reconnect, stale guards, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[networking-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) {
		console.error(stderr.trim());
	}
	process.exitCode = 1;
} finally {
	try {
		if (previewStarted) {
			await call("disconnect_networking_runtime", { confirm: true }).catch(() => undefined);
			await call("set_preview_play_mode", { action: "stop" }).catch(() => undefined);
		}
		if (multiplayerStarted) {
			await call("stop_multiplayer_play_mode", { confirm: true });
		}
		if (standaloneSession) {
			const current = await call("get_gameplay_session", { sessionId: standaloneSession.id });
			await call("delete_gameplay_session", { sessionId: current.id, expectedRevision: current.revision, confirm: true });
		}
		if (hostStarted || (await call("get_gameplay_session_host_status")).listening) {
			await call("stop_gameplay_session_host", { confirm: true });
		}
		if (configurationChanged && baseline) {
			const current = await call("get_networking_configuration");
			if (current.revision === baseline.revision + 1) {
				await call("undo_editor");
			} else if (JSON.stringify(semanticConfiguration(current)) !== JSON.stringify(semanticConfiguration(baseline))) {
				await call("set_networking_configuration", { expectedRevision: current.revision, changes: configurationChanges(baseline) });
			}
		}
		for (const nodeId of fixtures.splice(0)) {
			await call("delete_node", { nodeId });
		}
		if (baseline) {
			await call("save_scene");
		}
	} catch (cleanupError) {
		console.error(`[networking-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

#!/usr/bin/env node
/** Real stdio/editor lifecycle for exact XR authoring, interactables, validation, desktop simulation, strict guards, and semantic cleanup. */
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

const requiredTools = [
	"get_xr_capabilities",
	"get_xr_configuration",
	"set_xr_configuration",
	"create_xr_interactable",
	"set_xr_interactable",
	"delete_xr_interactable",
	"validate_xr_target",
	"get_xr_runtime",
	"initialize_xr_runtime",
	"reconfigure_xr_runtime",
	"enter_xr_session",
	"exit_xr_session",
	"get_xr_simulation",
	"start_xr_simulation",
	"simulate_xr_input",
	"stop_xr_simulation",
];
const suffix = `${Date.now()}-${process.pid}`;
const fixtureName = `XR Live Fixture ${suffix}`;
const interactableId = `xr-live-${suffix}`;
let baseline;
let fixtureId;
let interactableCreated = false;
let simulationStarted = false;

function configurationChanges(configuration) {
	return {
		enabled: configuration.enabled,
		session: configuration.session,
		origin: configuration.origin,
		interaction: configuration.interaction,
		locomotion: configuration.locomotion,
		simulation: configuration.simulation,
		maxTraceEvents: configuration.maxTraceEvents,
	};
}

function semanticConfiguration(configuration) {
	const result = structuredClone(configuration);
	delete result.revision;
	return result;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "xr-live-scenario", version: "1.0.0" } });
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
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the XR live scenario.");
	const runtimeBefore = await call("get_xr_runtime");
	const simulationBefore = await call("get_xr_simulation");
	if (runtimeBefore.runtime || simulationBefore.simulation)
		throw new Error("Stop the current XR runtime/simulation and use a disposable scene before running XR live verification.");

	const capabilities = await call("get_xr_capabilities");
	if (
		capabilities.configurationVersion !== 2 ||
		JSON.stringify(capabilities.sessionModes) !== JSON.stringify(["immersive-vr", "immersive-ar"]) ||
		JSON.stringify(capabilities.interactionModes) !== JSON.stringify(["select", "grab", "teleport"]) ||
		JSON.stringify(capabilities.nativeProviderBoundary) !== JSON.stringify(["native-openxr", "visionos", "arcore", "arkit"])
	) {
		throw new Error("XR capability/provider-boundary evidence is incomplete.");
	}
	baseline = await call("get_xr_configuration");
	const fixture = await call("create_primitive_mesh", { type: "box", name: fixtureName, position: [0, 0, 300], options: { width: 50, height: 50, depth: 50 } });
	fixtureId = fixture.id;

	let configuration = await call("set_xr_configuration", {
		expectedRevision: baseline.revision,
		changes: {
			enabled: true,
			session: { initializeOnStartup: false },
			interaction: { handTracking: false },
			locomotion: { teleportation: false },
			simulation: { enabled: true, rightController: { enabled: true, position: [0, 0, 0], rotation: [0, 0, 0] } },
		},
	});
	const stale = await call("set_xr_configuration", { expectedRevision: baseline.revision, changes: { enabled: false } }, true);
	if (!String(stale).includes("revision is stale")) throw new Error("XR stale configuration mutation did not reject.");

	const created = await call("create_xr_interactable", {
		expectedRevision: configuration.revision,
		interactable: { id: interactableId, name: "XR Live Grab", meshId: fixtureId, modes: ["select", "grab"], interactionLayers: ["default"] },
	});
	interactableCreated = true;
	configuration = created.configuration;
	const updated = await call("set_xr_interactable", {
		expectedRevision: configuration.revision,
		id: interactableId,
		changes: { hapticAmplitude: 0.25, hapticDurationMs: 20, dragSmoothing: 0.3 },
	});
	configuration = updated.configuration;
	if (updated.interactable.hapticAmplitude !== 0.25 || updated.interactable.dragSmoothing !== 0.3) throw new Error("XR interactable update did not round-trip.");

	const validation = await call("validate_xr_target", { target: "web" });
	if (!validation.valid || validation.configurationRevision !== configuration.revision || validation.capabilities.portableRuntime !== "webxr") {
		throw new Error("XR target validation evidence is incomplete.");
	}
	const initializedRuntime = await call("initialize_xr_runtime", { expectedRevision: configuration.revision });
	if (!initializedRuntime) throw new Error("XR runtime initialization returned no inspectable snapshot.");
	const reconfiguredRuntime = await call("reconfigure_xr_runtime", { expectedRevision: configuration.revision });
	if (!reconfiguredRuntime) throw new Error("XR runtime reconfiguration returned no inspectable snapshot.");
	const enteredRuntime = await call("enter_xr_session", { expectedRevision: configuration.revision });
	if (!enteredRuntime) throw new Error("XR session entry returned no inspectable snapshot.");
	const exitedRuntime = await call("exit_xr_session", { expectedRevision: configuration.revision });
	if (!exitedRuntime) throw new Error("XR session exit returned no inspectable snapshot.");
	const started = await call("start_xr_simulation", { expectedRevision: configuration.revision });
	simulationStarted = true;
	if (started.phase !== "active") throw new Error("XR desktop simulation did not start.");
	const pressed = await call("simulate_xr_input", {
		expectedRevision: configuration.revision,
		input: { type: "press-select", device: "right", interactionMode: "grab", interactionLayers: ["default"] },
	});
	if (!pressed.rays.some((ray) => ray.hit && ray.meshId === fixtureId) || !pressed.heldInteractables.some((entry) => entry.interactableId === interactableId)) {
		throw new Error("XR simulated ray/grab evidence is incomplete.");
	}
	const moved = await call("simulate_xr_input", { expectedRevision: configuration.revision, input: { type: "move-pose", device: "right", deltaPosition: [1, 0, 0] } });
	if (!moved.trace.some((entry) => entry.type === "pose")) throw new Error("XR simulated controller movement trace is incomplete.");
	await call("simulate_xr_input", { expectedRevision: configuration.revision, input: { type: "release-select", device: "right" } });
	const stopped = await call("stop_xr_simulation", { expectedRevision: configuration.revision });
	simulationStarted = false;
	if (stopped.phase !== "stopped" || !stopped.trace.some((entry) => entry.type === "stop")) throw new Error("XR simulation cleanup evidence is incomplete.");
	if ((await call("get_xr_simulation")).simulation !== null) throw new Error("XR simulator lease remained after stop.");

	const deleted = await call("delete_xr_interactable", { expectedRevision: configuration.revision, id: interactableId, confirm: true });
	interactableCreated = false;
	configuration = deleted.configuration;
	configuration = await call("set_xr_configuration", { expectedRevision: configuration.revision, changes: configurationChanges(baseline) });
	await call("delete_node", { nodeId: fixtureId });
	fixtureId = undefined;
	const final = await call("get_xr_configuration");
	if (JSON.stringify(semanticConfiguration(final)) !== JSON.stringify(semanticConfiguration(baseline)))
		throw new Error("XR live cleanup did not restore the semantic authoring baseline.");
	const unknown = await call("get_xr_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("XR capability tool did not reject an unknown field.");

	console.log(
		`[xr-live] PASS — 16/16 strict tools, capability/provider boundary, exact revisions, interactable CRUD, target validation, runtime initialize/reconfigure/entry/exit evidence, deterministic ray/grab/move/release, transform-restoring stop, and semantic cleanup verified.`
	);
} catch (error) {
	console.error(`[xr-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (simulationStarted) {
			const current = await call("get_xr_configuration");
			await call("stop_xr_simulation", { expectedRevision: current.revision });
		}
		if (interactableCreated) {
			const current = await call("get_xr_configuration");
			await call("delete_xr_interactable", { expectedRevision: current.revision, id: interactableId, confirm: true });
		}
		if (baseline) {
			const current = await call("get_xr_configuration");
			if (JSON.stringify(semanticConfiguration(current)) !== JSON.stringify(semanticConfiguration(baseline))) {
				await call("set_xr_configuration", { expectedRevision: current.revision, changes: configurationChanges(baseline) });
			}
		}
		if (fixtureId) await call("delete_node", { nodeId: fixtureId });
	} catch (cleanupError) {
		console.error(`[xr-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

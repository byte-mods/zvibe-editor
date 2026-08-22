#!/usr/bin/env node
/** Real stdio/editor/player lifecycle for exact Device Simulator profiles and authenticated Device Lab transport. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

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

async function callResult(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	return result;
}

async function call(name, args = {}, expectError = false) {
	const result = await callResult(name, args, expectError);
	const text = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return text ?? "";
	return text ? JSON.parse(text) : result;
}

async function waitFor(read, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for live Device Lab evidence.");
}

const requiredTools = [
	"get_device_simulation",
	"set_device_simulation",
	"get_device_tooling_capabilities",
	"list_device_simulator_profiles",
	"set_device_simulator_profile",
	"delete_device_simulator_profile",
	"activate_device_simulator_profile",
	"start_device_lab",
	"stop_device_lab",
	"get_device_lab_status",
	"list_remote_devices",
	"get_remote_device_logs",
	"get_remote_device_metrics",
	"capture_remote_device_screenshot",
	"send_remote_device_input",
	"disconnect_remote_device",
	"clear_remote_device_data",
];
const customId = `live-device-${process.pid}`;
let baselineSimulation;
let customCreated = false;
let labStarted = false;
let player;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "device-tooling-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Device Tooling tools: ${missing.join(", ")}`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the Device Tooling live scenario.");

	const capabilities = await call("get_device_tooling_capabilities");
	if (capabilities.simulator.performanceSimulated !== undefined || capabilities.remotePlayer.transport !== "authenticated-outbound-websocket-v1") {
		throw new Error("Device Tooling capability boundaries were incomplete.");
	}
	baselineSimulation = await call("get_device_simulation");
	const catalog = await call("list_device_simulator_profiles");
	if (catalog.profiles.some((profile) => profile.id === customId)) throw new Error(`Disposable profile ${customId} already exists.`);
	const created = await call("set_device_simulator_profile", {
		expectedRevision: catalog.revision,
		id: customId,
		name: "Live QA Device",
		platform: "android",
		width: 1000,
		height: 2000,
		dpi: 400,
		devicePixelRatio: 2,
		safeArea: [10, 20, 30, 40],
		operatingSystem: "Live QA OS",
		deviceModel: "Live QA Phone",
		cpuCores: 8,
		memoryMB: 4096,
		graphicsApi: "WebGL2",
		touchPoints: 5,
	});
	customCreated = true;
	if (created.configuration.revision !== catalog.revision + 1) throw new Error("Custom profile exact revision did not advance.");
	await call("delete_device_simulator_profile", { id: customId, expectedRevision: catalog.revision, confirm: true }, true);
	const active = await call("activate_device_simulator_profile", { id: customId, expectedRevision: baselineSimulation.revision, enabled: true, orientation: "landscape" });
	if (active.resolved.width !== 2000 || active.resolved.height !== 1000 || JSON.stringify(active.resolved.safeArea) !== JSON.stringify([40, 10, 20, 30])) {
		throw new Error("Landscape dimensions or safe-area rotation did not match the authored profile.");
	}

	const started = await call("start_device_lab", { port: 0, pairingMinutes: 1 });
	labStarted = true;
	if (!started.listening || started.security.loopbackOnly !== true || started.security.tokenPersisted !== false)
		throw new Error("Device Lab did not start with secure loopback defaults.");
	player = new WebSocket(`${started.pairing.wsUrl}?token=${started.pairing.pairingToken}`);
	await new Promise((resolve, reject) => {
		player.once("open", resolve);
		player.once("error", reject);
	});
	player.on("message", (bytes) => {
		const message = JSON.parse(bytes.toString());
		if (message.type !== "command") return;
		const result =
			message.command === "screenshot" ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 1, height: 1 } : { action: message.action, x: message.x, y: message.y };
		player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "response", requestId: message.requestId, ok: true, result }));
	});
	player.send(
		JSON.stringify({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "hello",
			identity: { deviceId: `live-${process.pid}`, name: "Live CLI Player", platform: process.platform },
			capabilities: ["logs", "metrics", "screenshot", "pointer-input"],
		})
	);
	const inventory = await waitFor(
		() => call("list_remote_devices"),
		(value) => value.devices.length === 1
	);
	const connectionId = inventory.devices[0].connectionId;
	player.send(
		JSON.stringify({
			protocol: "zvibe-device-lab",
			version: 1,
			type: "logs",
			entries: [{ capturedAt: new Date().toISOString(), level: "warn", arguments: ["live remote warning", { code: 709 }] }],
		})
	);
	player.send(JSON.stringify({ protocol: "zvibe-device-lab", version: 1, type: "metrics", sample: { frameRate: 59, frameTimeMs: 16.9, drawCalls: 71 } }));
	await waitFor(
		() => call("list_remote_devices"),
		(value) => value.devices[0]?.logCount === 1 && value.devices[0]?.metricCount === 1
	);
	if ((await call("get_remote_device_logs", { connectionId, levels: ["warn"], query: "warning" })).total !== 1) throw new Error("Remote log filter evidence was missing.");
	if ((await call("get_remote_device_metrics", { connectionId })).summary.frameRate.average !== 59) throw new Error("Remote metric summary evidence was missing.");
	const screenshot = await callResult("capture_remote_device_screenshot", { connectionId, timeoutMs: 2_000 });
	if (screenshot.content?.[0]?.type !== "image" || screenshot.content[0].mimeType !== "image/png") throw new Error("Remote screenshot did not return MCP image content.");
	const input = await call("send_remote_device_input", { connectionId, action: "down", x: 0.25, y: 0.75, timeoutMs: 2_000, confirm: true });
	if (!input.acknowledged) throw new Error("Remote pointer input was not acknowledged.");
	const cleared = await call("clear_remote_device_data", { connectionId, confirm: true });
	if (cleared.removed.logs !== 1 || cleared.removed.metrics !== 1 || cleared.removed.screenshot !== true) throw new Error("Remote evidence did not clear exactly.");
	const playerClosed = new Promise((resolve) => player.once("close", resolve));
	await call("disconnect_remote_device", { connectionId, confirm: true });
	await playerClosed;
	player = undefined;
	await call("stop_device_lab", { confirm: true });
	labStarted = false;

	const currentCatalog = await call("list_device_simulator_profiles");
	await call("delete_device_simulator_profile", { id: customId, expectedRevision: currentCatalog.revision, confirm: true });
	customCreated = false;
	const currentSimulation = await call("get_device_simulation");
	await call("set_device_simulation", {
		expectedRevision: currentSimulation.revision,
		enabled: baselineSimulation.enabled,
		profileId: baselineSimulation.profileId,
		width: baselineSimulation.width,
		height: baselineSimulation.height,
		dpi: baselineSimulation.dpi,
		devicePixelRatio: baselineSimulation.devicePixelRatio,
		orientation: baselineSimulation.orientation,
		safeArea: baselineSimulation.safeArea,
		platform: baselineSimulation.platform,
		operatingSystem: baselineSimulation.operatingSystem,
		deviceModel: baselineSimulation.deviceModel,
		cpuCores: baselineSimulation.cpuCores,
		memoryMB: baselineSimulation.memoryMB,
		graphicsApi: baselineSimulation.graphicsApi,
		touchPoints: baselineSimulation.touchPoints,
	});
	console.log(
		`[device-tooling-live] PASS — ${requiredTools.length}/17 tools present; exact profile CRUD/rotation, authenticated player pairing, structured logs, metric summary, MCP PNG, acknowledged input, strict/stale rejection, and cleanup verified.`
	);
} catch (error) {
	console.error(`[device-tooling-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		player?.close();
		if (labStarted) await call("stop_device_lab", { confirm: true });
		if (customCreated) {
			const catalog = await call("list_device_simulator_profiles");
			if (catalog.profiles.some((profile) => profile.id === customId))
				await call("delete_device_simulator_profile", { id: customId, expectedRevision: catalog.revision, confirm: true });
		}
	} catch (cleanupError) {
		console.error(`[device-tooling-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

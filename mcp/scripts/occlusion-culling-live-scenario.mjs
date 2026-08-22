#!/usr/bin/env node
/** Real stdio/Electron lifecycle for portable Unity-style Occlusion Culling. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

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
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 120_000) {
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
	let response;
	try {
		response = await rpc("tools/call", { name, arguments: args });
	} catch (error) {
		throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function safeCall(name, args = {}) {
	try {
		return await call(name, args);
	} catch {
		return null;
	}
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

function flatten(nodes) {
	return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status} on port ${port}.`);
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
			} else if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.text ?? "Runtime.exceptionThrown");
			else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") runtimeErrors.push(message.params.entry.text);
		});
		const send = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = requestId++;
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP ${method}.`)), 15_000);
				requests.set(id, (message) => {
					clearTimeout(timer);
					if (message.error) reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
					else resolve(message.result);
				});
				socket.send(JSON.stringify({ id, method, params }));
			});
		const evaluate = async (expression) => {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) {
				throw new Error(
					`CDP evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`
				);
			}
			return result.result.value;
		};
		if (await evaluate("Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html'))")) {
			await send("Runtime.enable");
			await send("Log.enable");
			const click = async (selector) => {
				const rect = await evaluate(
					`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 }; })()`
				);
				if (!rect?.visible) throw new Error(`UI selector is missing or hidden: ${selector}`);
				await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
				await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			};
			return { socket, evaluate, click, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron editor page was found on CDP port ${port}.`);
}

const requiredTools = [
	"get_occlusion_culling_capabilities",
	"get_occlusion_culling",
	"set_occlusion_culling_settings",
	"set_occlusion_culling_mesh",
	"set_camera_occlusion_culling",
	"create_occlusion_culling_area",
	"update_occlusion_culling_area",
	"delete_occlusion_culling_area",
	"inspect_occlusion_culling_bake",
	"bake_occlusion_culling",
	"cancel_occlusion_culling_bake",
	"clear_occlusion_culling_bake",
	"get_occlusion_culling_runtime",
	"set_occlusion_culling_visualization",
	"reset_occlusion_culling",
];
const supportTools = [
	"get_editor_status",
	"get_scene_hierarchy",
	"get_scene_settings",
	"get_camera",
	"create_primitive_mesh",
	"set_mesh_geometry",
	"set_node_transform",
	"create_camera",
	"set_active_camera",
	"get_screenshot",
	"select_editor_tab",
	"delete_node",
];
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const createdIds = [];
let originalActiveCameraId = null;
let cdp = null;
let startedAuthoring = false;
let completed = false;
const getOcclusionCulling = () => call("get_occlusion_culling", { offset: 0, limit: 500, cameraOffset: 0, cameraLimit: 500 });

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "occlusion-culling-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
	for (const name of [...requiredTools, ...supportTools]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable editor project is required for the Occlusion Culling live scenario.");
	const baseline = await getOcclusionCulling();
	if (baseline.authored) throw new Error("The live scenario requires a disposable scene without pre-existing Occlusion Culling authoring so cleanup can be exact.");
	const hierarchy = flatten(await call("get_scene_hierarchy"));
	for (const node of hierarchy.filter((candidate) => candidate.type.includes("Camera"))) {
		const camera = await safeCall("get_camera", { nodeId: node.id });
		if (camera?.isActive) {
			originalActiveCameraId = node.id;
			break;
		}
	}

	const capabilities = await call("get_occlusion_culling_capabilities");
	if (
		capabilities.model !== "bounded-static-pvs-ray-bake-v1" ||
		!capabilities.features?.bakedPotentiallyVisibleSets ||
		!capabilities.features?.fullAndAdditiveRuntime ||
		capabilities.limits?.maximumCells !== 4096 ||
		!capabilities.boundaries?.some((value) => value.includes("Unity/Umbra"))
	)
		throw new Error(`Occlusion Culling capability evidence is incomplete: ${JSON.stringify(capabilities)}`);
	const unknown = await call("get_occlusion_culling_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Closed Occlusion Culling schema did not reject an unknown field.");

	const wall = await call("create_primitive_mesh", { type: "box", name: `Occlusion Wall ${suffix}`, position: [0, 0, 0] });
	createdIds.push(wall.id);
	await call("set_mesh_geometry", { nodeId: wall.id, parameters: { width: 50, height: 2000, depth: 2000 } });
	const target = await call("create_primitive_mesh", { type: "box", name: `Occluded Target ${suffix}`, position: [500, 0, 0] });
	createdIds.push(target.id);
	const camera = await call("create_camera", { type: "free", name: `Occlusion Camera ${suffix}`, position: [-500, 0, 0], target: [0, 0, 0] });
	createdIds.push(camera.id);
	await call("set_active_camera", { nodeId: camera.id });

	let state = await getOcclusionCulling();
	startedAuthoring = true;
	await call("set_occlusion_culling_settings", {
		expectedRevision: state.configuration.revision,
		settings: {
			smallestOccluder: 20,
			smallestHole: 25,
			cellSize: 200,
			viewSamples: 1,
			targetSamples: 1,
			maximumCells: 1024,
			maximumRayTests: 100_000,
			maximumRelationships: 20_000,
		},
	});
	state = await getOcclusionCulling();
	const wallState = state.meshes.items.find((item) => item.id === wall.id);
	await call("set_occlusion_culling_mesh", {
		meshId: wall.id,
		expectedRevision: state.configuration.revision,
		expectedObjectRevision: wallState.settings.revision,
		settings: { staticOccluder: true },
	});
	state = await getOcclusionCulling();
	const targetState = state.meshes.items.find((item) => item.id === target.id);
	await call("set_occlusion_culling_mesh", {
		meshId: target.id,
		expectedRevision: state.configuration.revision,
		expectedObjectRevision: targetState.settings.revision,
		settings: { staticOccludee: true, dynamicOcclusion: true, queryMode: "strict", queryRetryCount: 7, forceRenderingWhenOccluded: true },
	});
	state = await getOcclusionCulling();
	const cameraState = state.cameras.items.find((item) => item.id === camera.id);
	await call("set_camera_occlusion_culling", {
		cameraId: camera.id,
		expectedRevision: state.configuration.revision,
		expectedObjectRevision: cameraState.settings.revision,
		enabled: true,
	});
	state = await getOcclusionCulling();
	await call("create_occlusion_culling_area", {
		expectedRevision: state.configuration.revision,
		id: `live-room-${process.pid}`,
		name: `Live Room ${suffix}`,
		center: [-500, 0, 0],
		size: [100, 100, 100],
		isViewVolume: true,
		enabled: true,
	});

	state = await getOcclusionCulling();
	const staleMutation = await call("set_occlusion_culling_settings", { expectedRevision: state.configuration.revision - 1, enabled: false }, true);
	if (!String(staleMutation).includes("revision is stale")) throw new Error(`Stale revision did not reject: ${staleMutation}`);
	const plan = await call("inspect_occlusion_culling_bake", { expectedRevision: state.configuration.revision });
	if (plan.cells.length !== 1 || plan.occluderMeshIds[0] !== wall.id || plan.occludeeMeshIds[0] !== target.id || !/^[a-f0-9]{64}$/.test(plan.sourceFingerprint)) {
		throw new Error(`Bake plan is incomplete: ${JSON.stringify(plan)}`);
	}
	const staleBake = await call("bake_occlusion_culling", { expectedRevision: state.configuration.revision, expectedSourceFingerprint: "0".repeat(64) }, true);
	if (!String(staleBake).includes("source fingerprint is stale")) throw new Error(`Stale source lease did not reject: ${staleBake}`);
	const baked = await call("bake_occlusion_culling", { expectedRevision: state.configuration.revision, expectedSourceFingerprint: plan.sourceFingerprint });
	if (baked.job?.status !== "completed" || baked.bake?.cells?.[0]?.occludedMeshIds?.[0] !== target.id || baked.bake?.statistics?.occludedRelationships !== 1) {
		throw new Error(`Atomic bake did not occlude the target: ${JSON.stringify(baked)}`);
	}
	await call("set_occlusion_culling_visualization", { enabled: true, showCells: true, showVisible: true, showOccluded: true, selectedCellId: baked.bake.cells[0].id });
	await call("get_screenshot", { width: 320, height: 180 });
	let runtime = await call("get_occlusion_culling_runtime");
	let cameraRuntime = runtime.cameras.find((entry) => entry.cameraId === camera.id);
	if (cameraRuntime?.activeCellId !== baked.bake.cells[0].id || !cameraRuntime.bakedCulledMeshIds.includes(target.id) || cameraRuntime.staleReason) {
		throw new Error(`Per-camera baked PVS evidence failed: ${JSON.stringify(cameraRuntime)}`);
	}

	await call("select_editor_tab", { tab: "occlusion-culling" });
	cdp = await connectCdp();
	await waitFor(() => cdp.evaluate("Boolean(document.querySelector('[data-occlusion-culling-workspace]'))"), Boolean, "Occlusion Culling workspace");
	await cdp.click('[data-occlusion-tab="visualization"]');
	await waitFor(() => cdp.evaluate("Boolean(document.querySelector('[data-occlusion-visualization]'))"), Boolean, "Visualization tab");
	const visualizationUi = await cdp.evaluate(`({
		cells: document.querySelectorAll('[data-occlusion-cell]').length,
		runtime: [...document.querySelectorAll('[data-occlusion-runtime-camera]')].find((element) => element.getAttribute('data-occlusion-runtime-camera') === ${JSON.stringify(camera.id)})?.innerText ?? '',
		enabled: document.querySelector('[data-occlusion-visualization-enabled]')?.checked ?? null
	})`);
	if (visualizationUi.cells !== 1 || !visualizationUi.runtime.includes("culled") || visualizationUi.enabled !== true) {
		throw new Error(`Visualization UI evidence is incomplete: ${JSON.stringify(visualizationUi)}`);
	}
	await cdp.click("[data-occlusion-visualization-enabled]");
	await waitFor(
		() => cdp.evaluate("document.querySelector('[data-occlusion-visualization-enabled]')?.checked"),
		(value) => value === false,
		"UI visualization disable"
	);
	await cdp.click("[data-occlusion-visualization-enabled]");
	await waitFor(
		() => cdp.evaluate("document.querySelector('[data-occlusion-visualization-enabled]')?.checked"),
		(value) => value === true,
		"UI visualization re-enable"
	);
	await cdp.click('[data-occlusion-tab="object"]');
	await waitFor(
		() => cdp.evaluate("document.querySelector('[data-occlusion-object-type]')?.getAttribute('data-occlusion-object-type')"),
		(value) => value === "camera",
		"camera Object tab"
	);

	await call("set_node_transform", { nodeId: wall.id, position: [0, 25, 0] });
	await call("get_screenshot", { width: 320, height: 180 });
	runtime = await call("get_occlusion_culling_runtime");
	cameraRuntime = runtime.cameras.find((entry) => entry.cameraId === camera.id);
	if (!cameraRuntime?.staleReason?.includes("changed after baking") || cameraRuntime.bakedCulledMeshIds.length !== 0) {
		throw new Error(`Changed source did not fail open: ${JSON.stringify(cameraRuntime)}`);
	}

	state = await getOcclusionCulling();
	const wrongClear = await call("clear_occlusion_culling_bake", { expectedRevision: state.configuration.revision, expectedBakeFingerprint: "f".repeat(64), confirm: true }, true);
	if (!String(wrongClear).includes("fingerprint is stale")) throw new Error(`Stale clear lease did not reject: ${wrongClear}`);
	await call("clear_occlusion_culling_bake", {
		expectedRevision: state.configuration.revision,
		expectedBakeFingerprint: state.configuration.bake.bakeFingerprint,
		confirm: true,
	});

	state = await getOcclusionCulling();
	await call("set_occlusion_culling_settings", {
		expectedRevision: state.configuration.revision,
		settings: { cellSize: 100, maximumCells: 1024, maximumRayTests: 100_000, maximumRelationships: 20_000 },
	});
	state = await getOcclusionCulling();
	const area = state.configuration.areas[0];
	await call("update_occlusion_culling_area", {
		areaId: area.id,
		expectedRevision: state.configuration.revision,
		expectedObjectRevision: area.revision,
		patch: { size: [1000, 1000, 1000] },
	});
	state = await getOcclusionCulling();
	const cancellationPlan = await call("inspect_occlusion_culling_bake", { expectedRevision: state.configuration.revision });
	if (cancellationPlan.cells.length !== 1000) throw new Error(`Expected a 1000-cell cancellation stress plan: ${JSON.stringify(cancellationPlan)}`);
	const bakePromise = call("bake_occlusion_culling", { expectedRevision: state.configuration.revision, expectedSourceFingerprint: cancellationPlan.sourceFingerprint }, true);
	const running = await waitFor(
		() => getOcclusionCulling(),
		(value) => value.job?.status === "running" && value.job.progress.completedCells < value.job.progress.totalCells,
		"running cancellable bake"
	);
	await call("cancel_occlusion_culling_bake", { id: running.job.id, expectedJobRevision: running.job.revision });
	const cancellationError = await bakePromise;
	if (!String(cancellationError).includes("cancelled before publication")) throw new Error(`Bake cancellation did not reject atomically: ${cancellationError}`);
	state = await waitFor(
		() => getOcclusionCulling(),
		(value) => value.job?.status === "cancelled",
		"cancelled terminal job"
	);
	if (state.configuration.bake) throw new Error("Cancelled bake published partial data.");
	const areaAfterCancellation = state.configuration.areas.find((candidate) => candidate.id === area.id);
	const deletedArea = await call("delete_occlusion_culling_area", {
		areaId: areaAfterCancellation.id,
		expectedRevision: state.configuration.revision,
		expectedObjectRevision: areaAfterCancellation.revision,
		confirm: true,
	});
	if (!deletedArea.deleted || deletedArea.id !== area.id) throw new Error(`Occlusion Area deletion evidence is incomplete: ${JSON.stringify(deletedArea)}`);
	state = await getOcclusionCulling();
	if (state.configuration.areas.some((candidate) => candidate.id === area.id)) throw new Error("Deleted Occlusion Area remained in authored state.");

	await call("reset_occlusion_culling", { expectedRevision: state.configuration.revision, confirm: true });
	startedAuthoring = false;
	if (originalActiveCameraId) await call("set_active_camera", { nodeId: originalActiveCameraId });
	for (const id of [...createdIds].reverse()) await call("delete_node", { nodeId: id });
	createdIds.length = 0;
	const clean = await getOcclusionCulling();
	if (clean.authored || clean.configuration.revision !== 0 || clean.configuration.bake || clean.visualization.enabled) {
		throw new Error(`Occlusion Culling cleanup is incomplete: ${JSON.stringify(clean)}`);
	}
	const remaining = flatten(await call("get_scene_hierarchy"));
	if (remaining.some((node) => node.name.includes(suffix))) throw new Error("Temporary Occlusion Culling nodes remain after cleanup.");
	if (cdp.runtimeErrors.length) throw new Error(`Electron renderer reported errors: ${cdp.runtimeErrors.join(" | ")}`);
	completed = true;
	console.log(
		JSON.stringify(
			{
				status: "ok",
				tools: tools.length,
				bake: { cells: baked.bake.statistics.cellCount, rays: baked.bake.statistics.rayTests, occludedRelationships: baked.bake.statistics.occludedRelationships },
				staleFailOpen: true,
				cancelledCells: state.job.progress.completedCells,
				ui: { tabs: ["Object", "Bake", "Visualization"], realPointerToggle: true, rendererErrors: 0 },
				cleanup: "exact",
			},
			null,
			2
		)
	);
} finally {
	if (!completed) {
		if (startedAuthoring) {
			const current = await safeCall("get_occlusion_culling");
			if (current?.job?.status === "running") {
				await safeCall("cancel_occlusion_culling_bake", { id: current.job.id, expectedJobRevision: current.job.revision });
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const latest = await safeCall("get_occlusion_culling");
			if (latest?.authored && latest.job?.status !== "running") await safeCall("reset_occlusion_culling", { expectedRevision: latest.configuration.revision, confirm: true });
		}
		if (originalActiveCameraId) await safeCall("set_active_camera", { nodeId: originalActiveCameraId });
		for (const id of [...createdIds].reverse()) await safeCall("delete_node", { nodeId: id });
	}
	cdp?.socket.close();
	child.kill();
	if (!completed && stderr.trim()) console.error(stderr.trim().split("\n").slice(-5).join("\n"));
}

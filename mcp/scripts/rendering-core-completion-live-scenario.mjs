#!/usr/bin/env node
/** Positive real-editor lifecycle for uncovered core Rendering MCP tools. */
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

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"create_rendering_profile",
	"set_rendering_profile",
	"apply_rendering_profile",
	"clear_active_rendering_profile",
	"delete_rendering_profile",
	"get_dynamic_resolution",
	"set_dynamic_resolution",
	"reset_dynamic_resolution_runtime",
	"get_render_reconstruction",
	"set_render_reconstruction",
	"reset_render_reconstruction_history",
	"set_shader_variant_collection",
	"clear_shader_variant_collection",
	"trace_shader_variant_frame",
	"prewarm_shader_variant_collection",
	"update_renderer_data_asset",
	"create_rendering_volume",
	"set_rendering_volume",
	"evaluate_rendering_volumes",
	"delete_rendering_volume",
	"create_camera_stack",
	"set_camera_stack",
	"add_camera_stack_overlay",
	"set_camera_stack_overlay",
	"remove_camera_stack_overlay",
	"apply_camera_stack",
	"clear_active_camera_stack",
	"delete_camera_stack",
	"create_rendering_layer",
	"set_rendering_layer",
	"delete_rendering_layer",
	"set_light_rendering_layers",
	"set_rendering_group",
	"reset_rendering_group",
	"create_renderer_list",
	"set_renderer_list",
	"resolve_renderer_list",
	"delete_renderer_list",
	"get_camera_post_processes",
];

const suffix = `${Date.now()}-${process.pid}`;
const rendererDataPath = `assets/mcp-rendering-${suffix}/core.rendererdata.json`;
const nodeIds = new Set();
let profile;
let volume;
let cameraStack;
let renderingLayer;
let rendererList;
let rendererData;
let shaderUndoBaseline;
let shaderUndoRestored = false;
const undoReadScript = `mcp-rendering-undo-read-${suffix}.js`;
const undoRestoreScript = `mcp-rendering-undo-restore-${suffix}.js`;

async function cleanup() {
	if (!shaderUndoRestored && Number.isInteger(shaderUndoBaseline)) {
		const source = `import { getUndoRedoState, undo } from "babylonjs-editor"; export async function main() { while (getUndoRedoState().undoCount > ${shaderUndoBaseline}) undo(); return JSON.stringify(getUndoRedoState()); }`;
		await call("run_agent_script", { name: undoRestoreScript, content: source }).catch(() => undefined);
	}
	if (cameraStack?.id) {
		const stacks = await call("list_camera_stacks", {}).catch(() => undefined);
		const current = stacks?.stacks?.find((entry) => entry.id === cameraStack.id);
		if (stacks?.active?.id === cameraStack.id) await call("clear_active_camera_stack", { stackId: cameraStack.id, revision: current?.revision ?? stacks.active.revision, confirm: true }).catch(() => undefined);
		if (current) await call("delete_camera_stack", { stackId: current.id, revision: current.revision, confirm: true }).catch(() => undefined);
	}
	if (rendererList?.id) {
		const lists = await call("list_renderer_lists", {}).catch(() => undefined);
		const current = lists?.lists?.find((entry) => entry.id === rendererList.id);
		if (current) await call("delete_renderer_list", { rendererListId: current.id, revision: current.revision, confirm: true }).catch(() => undefined);
	}
	if (renderingLayer?.id) {
		const layers = await call("list_rendering_layers", {}).catch(() => undefined);
		const current = layers?.layers?.find((entry) => entry.id === renderingLayer.id);
		if (current) await call("delete_rendering_layer", { layerId: current.id, revision: current.revision, clearAssignments: true, confirm: true }).catch(() => undefined);
	}
	if (volume?.id) await call("delete_rendering_volume", { id: volume.id }).catch(() => undefined);
	if (profile?.id) {
		const listed = await call("list_rendering_profiles", {}).catch(() => undefined);
		const current = listed?.profiles?.find((entry) => entry.id === profile.id);
		if (current && listed.activeProfileId === current.id)
			await call("clear_active_rendering_profile", { id: current.id, revision: current.revision, confirm: true }).catch(() => undefined);
		if (current) await call("delete_rendering_profile", { id: current.id, revision: current.revision, confirm: true }).catch(() => undefined);
	}
	if (rendererData?.contentRevision) await call("delete_renderer_data_asset", { path: rendererDataPath, expectedRevision: rendererData.contentRevision, confirm: true }).catch(() => undefined);
	for (const id of [...nodeIds].reverse()) await call("delete_node", { nodeId: id }).catch(() => undefined);
	for (const path of [
		`agentdata/${undoReadScript}`,
		`agentdata/${undoRestoreScript}`,
		`.bjseditor/agent-scripts/${undoReadScript.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${undoReadScript.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${undoRestoreScript.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${undoRestoreScript.replace(/\.js$/, ".cjs.map")}`,
		`assets/mcp-rendering-${suffix}`,
	])
		await call("delete_asset", { path, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rendering-core-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listedTools = await rpc("tools/list", {});
	for (const name of required) if (!listedTools.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for core Rendering testing.");

	const baseCamera = await call("create_camera", { type: "free", name: `MCP Render Base ${suffix}`, position: [0, 250, -600], target: [0, 50, 0] });
	const overlayCamera = await call("create_camera", { type: "free", name: `MCP Render Overlay ${suffix}`, position: [0, 400, -800], target: [0, 0, 0] });
	const mesh = await call("create_primitive_mesh", { type: "box", name: `MCP Render Mesh ${suffix}`, position: [0, 50, 0], options: { size: 100 } });
	const light = await call("create_light", { type: "directional", name: `MCP Render Light ${suffix}`, direction: [-0.5, -1, 0.25], intensity: 1 });
	for (const value of [baseCamera, overlayCamera, mesh, light]) nodeIds.add(value.id);

	const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
	profile = await call("create_rendering_profile", { name: `MCP Desktop ${suffix}`, target: "desktop", configurations });
	profile = await call("set_rendering_profile", { id: profile.id, revision: profile.revision, name: `MCP Desktop Updated ${suffix}` });
	let dynamic = await call("set_dynamic_resolution", {
		id: profile.id,
		revision: profile.revision,
		configuration: { mode: "fixed", minimumScale: 0.5, maximumScale: 1, initialScale: 0.75, fixedScale: 0.75 },
	});
	profile = dynamic.profile;
	let reconstruction = await call("set_render_reconstruction", {
		id: profile.id,
		revision: profile.revision,
		configuration: { mode: "temporal", sharpness: 0.5, historyWeight: 0.8, jitterSamples: 8, reprojectHistory: false },
	});
	profile = reconstruction.profile;
	await call("apply_rendering_profile", { id: profile.id, revision: profile.revision, nodeId: baseCamera.id, activateProject: true });
	await call("get_dynamic_resolution", { id: profile.id });
	await call("reset_dynamic_resolution_runtime", { id: profile.id, revision: profile.revision });
	await call("get_render_reconstruction", { id: profile.id });
	await call("reset_render_reconstruction_history", { id: profile.id, revision: profile.revision });

	volume = await call("create_rendering_volume", {
		name: `MCP Render Volume ${suffix}`,
		profileId: profile.id,
		center: [0, 0, 0],
		size: [1000, 1000, 1000],
		priority: 10,
		blendDistance: 100,
		weight: 0.8,
	});
	await call("set_rendering_volume", { id: volume.id, weight: 0.9, enabled: true });
	await call("evaluate_rendering_volumes", {});
	await call("delete_rendering_volume", { id: volume.id });
	volume = undefined;

	cameraStack = (await call("create_camera_stack", { name: `MCP Stack ${suffix}`, baseCameraId: baseCamera.id })).stack;
	cameraStack = (await call("set_camera_stack", { stackId: cameraStack.id, revision: cameraStack.revision, newName: `MCP Stack Updated ${suffix}`, baseClearColor: true })).stack;
	let overlay = await call("add_camera_stack_overlay", {
		stackId: cameraStack.id,
		revision: cameraStack.revision,
		cameraId: overlayCamera.id,
		order: 10,
		clearColor: false,
		clearDepth: false,
		postProcessing: false,
		viewportMode: "inherit-base",
	});
	cameraStack = overlay.stack;
	overlay = await call("set_camera_stack_overlay", { stackId: cameraStack.id, revision: cameraStack.revision, overlayId: overlay.overlay.id, order: 5, clearDepth: true });
	cameraStack = overlay.stack;
	await call("apply_camera_stack", { stackId: cameraStack.id, revision: cameraStack.revision });
	await call("get_camera_post_processes", { nodeId: baseCamera.id });
	await call("clear_active_camera_stack", { stackId: cameraStack.id, revision: cameraStack.revision, confirm: true });
	const removed = await call("remove_camera_stack_overlay", { stackId: cameraStack.id, revision: cameraStack.revision, overlayId: overlay.overlay.id });
	cameraStack = removed.stack;
	await call("delete_camera_stack", { stackId: cameraStack.id, revision: cameraStack.revision, confirm: true });
	cameraStack = undefined;

	const layerState = await call("list_rendering_layers", {});
	const usedBits = new Set(layerState.layers.map((entry) => entry.bit));
	const freeBit = Array.from({ length: 32 }, (_, bit) => bit).find((bit) => !usedBits.has(bit));
	if (freeBit === undefined) throw new Error("No free native rendering-layer bit is available.");
	renderingLayer = (await call("create_rendering_layer", { name: `MCP Layer ${suffix}`, bit: freeBit })).layer;
	renderingLayer = (
		await call("set_rendering_layer", { layerId: renderingLayer.id, revision: renderingLayer.revision, name: `MCP Layer Updated ${suffix}` })
	).layer;
	await call("set_light_rendering_layers", { nodeId: light.id, includeLayerIds: [renderingLayer.id], excludeLayerIds: [] });
	const groupBefore = layerState.groups.find((entry) => !entry.authored) ?? layerState.groups[0];
	const group = (
		await call("set_rendering_group", { groupId: groupBefore.groupId, revision: groupBefore.revision, name: `MCP Group ${suffix}`, transparentSort: "backToFront" })
	).group;
	rendererList = (
		await call("create_renderer_list", { name: `MCP Renderer List ${suffix}`, cameraId: baseCamera.id, meshIds: [mesh.id], renderingGroupIds: [], queue: "all" })
	).rendererList;
	rendererList = (
		await call("set_renderer_list", { rendererListId: rendererList.id, revision: rendererList.revision, includeDescendants: true, sortMode: "frontToBack" })
	).rendererList;
	const resolved = await call("resolve_renderer_list", { rendererListId: rendererList.id, limit: 32 });
	if (!resolved.meshes?.some((entry) => entry.id === mesh.id)) throw new Error("Renderer list did not resolve the explicit test mesh.");
	await call("delete_renderer_list", { rendererListId: rendererList.id, revision: rendererList.revision, confirm: true });
	rendererList = undefined;
	await call("reset_rendering_group", { groupId: group.groupId, revision: group.revision, confirm: true });
	await call("delete_rendering_layer", { layerId: renderingLayer.id, revision: renderingLayer.revision, clearAssignments: true, confirm: true });
	renderingLayer = undefined;

	rendererData = await call("create_renderer_data_asset", { path: rendererDataPath, name: `MCP Core Renderer ${suffix}`, renderingPath: "forward" });
	rendererData = await call("update_renderer_data_asset", {
		path: rendererDataPath,
		expectedRevision: rendererData.contentRevision,
		name: `MCP Core Renderer Updated ${suffix}`,
	});
	await call("delete_renderer_data_asset", { path: rendererDataPath, expectedRevision: rendererData.contentRevision, confirm: true });
	rendererData = undefined;

	const undoStatus = await call("run_agent_script", {
		name: undoReadScript,
		content: 'import { getUndoRedoState } from "babylonjs-editor"; export async function main() { return JSON.stringify(getUndoRedoState()); }',
	});
	const parsedUndoStatus = typeof undoStatus.result === "string" ? JSON.parse(undoStatus.result) : undoStatus.result ?? undoStatus;
	shaderUndoBaseline = parsedUndoStatus.undoCount;
	if (!Number.isInteger(shaderUndoBaseline)) throw new Error(`Could not read Undo/Redo baseline: ${JSON.stringify(undoStatus)}`);
	let variants = await call("get_shader_variant_collection", {});
	variants = await call("set_shader_variant_collection", {
		expectedRevision: variants.configuration.revision,
		expectedFingerprint: variants.fingerprint,
		enabled: true,
		automaticTracing: false,
		automaticPrewarming: false,
	});
	await call("get_screenshot", { width: 320, height: 180 });
	variants = await call("get_shader_variant_collection", {});
	await call("trace_shader_variant_frame", { expectedRevision: variants.configuration.revision, expectedFingerprint: variants.fingerprint });
	variants = await call("get_shader_variant_collection", {});
	await call("prewarm_shader_variant_collection", { expectedRevision: variants.configuration.revision, expectedFingerprint: variants.fingerprint });
	variants = await call("get_shader_variant_collection", {});
	await call("clear_shader_variant_collection", { expectedRevision: variants.configuration.revision, expectedFingerprint: variants.fingerprint, confirm: true });
	const undoRestore = await call("run_agent_script", {
		name: undoRestoreScript,
		content: `import { getUndoRedoState, undo } from "babylonjs-editor"; export async function main() { while (getUndoRedoState().undoCount > ${shaderUndoBaseline}) undo(); return JSON.stringify(getUndoRedoState()); }`,
	});
	const parsedUndoRestore = typeof undoRestore.result === "string" ? JSON.parse(undoRestore.result) : undoRestore.result ?? undoRestore;
	const restoredUndoCount = parsedUndoRestore.undoCount;
	if (restoredUndoCount !== shaderUndoBaseline) throw new Error(`Shader collection Undo/Redo baseline was not restored: ${JSON.stringify(undoRestore)}`);
	shaderUndoRestored = true;

	await call("clear_active_rendering_profile", { id: profile.id, revision: profile.revision, confirm: true });
	await call("delete_rendering_profile", { id: profile.id, revision: profile.revision, confirm: true });
	profile = undefined;

	console.log(`PASS core Rendering completion live scenario (${required.length}/${required.length} tools): ${required.join(", ")}`);
} finally {
	await cleanup().catch((error) => console.error(`Cleanup warning: ${error.message}`));
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim()) console.error(stderr.trim());
}

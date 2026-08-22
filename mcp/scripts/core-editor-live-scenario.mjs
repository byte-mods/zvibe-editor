#!/usr/bin/env node
/** Valid-state live lifecycle for core editor, node, camera, batch, console, and project-run tools. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "server", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params = {}, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
	if (response.error || response.result?.isError) throw new Error(`${name}: ${text || JSON.stringify(response.error ?? response.result)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const suffix = `${Date.now()}-${process.pid}`;
const parentName = `MCP Core Parent ${suffix}`;
const childName = `MCP Core Child ${suffix}`;
const renamedChild = `MCP Core Child Renamed ${suffix}`;
const baselinePath = `assets/mcp-core-baseline-${suffix}.png`;
let parentId = null;
let childId = null;
let sortingLayerId = null;
let baselineCreated = false;
let originalGizmo = null;
let agentScriptPath = null;

async function cleanup() {
	try {
		await call("stop_project");
	} catch {
		// The external runner may never have started.
	}
	if (sortingLayerId) {
		try {
			await call("delete_sorting_layer", { layerId: sortingLayerId, confirm: true });
		} catch {
			// The valid-state lifecycle may already have deleted it.
		}
		sortingLayerId = null;
	}
	if (childId) {
		try {
			await call("delete_node", { nodeId: childId });
		} catch {
			// Deleting the parent can already delete this child.
		}
		childId = null;
	}
	if (parentId) {
		try {
			await call("delete_node", { nodeId: parentId });
		} catch {
			// Best-effort fixture cleanup.
		}
		parentId = null;
	}
	if (baselineCreated) {
		try {
			await call("delete_asset", { path: baselinePath, confirm: true });
		} catch {
			// The baseline may already be absent after a failed capture.
		}
		baselineCreated = false;
	}
	if (agentScriptPath) {
		try {
			await call("delete_asset", { path: agentScriptPath, confirm: true });
		} catch {
			// The agent script may already have been removed after a completed lifecycle.
		}
		agentScriptPath = null;
	}
	if (originalGizmo) {
		try {
			await call("set_gizmo_settings", originalGizmo);
		} catch {
			// Preserve the original editor preference when possible.
		}
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "core-editor-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready) throw new Error("A ready editor is required.");

	originalGizmo = await call("get_gizmo_settings");
	await call("set_gizmo_settings", { activeGizmo: "position", coordinateMode: "world", snap: { ...originalGizmo.snap, translationEnabled: true } });
	await call("run_editor_terminal_command", { command: "pwd", confirm: true });
	await call("write_editor_console", { message: `MCP core lifecycle ${suffix}`, level: "log" });
	await call("clear_editor_console");

	const editorApi = await call("get_editor_api");
	if (typeof editorApi?.reference !== "string" || !editorApi.reference.includes("export function main(editor)"))
		throw new Error("Editor automation API reference is incomplete.");
	const agentName = `mcp-core-${suffix}.js`;
	const writtenAgent = await call("write_agent_script", {
		name: agentName,
		content: 'export function main(editor) { return editor?.layout?.preview?.scene ? "mcp-agent-live" : "missing-scene"; }',
	});
	agentScriptPath = writtenAgent.path;
	if (agentScriptPath !== `agentdata/${agentName}`) throw new Error(`write_agent_script returned an unexpected path: ${JSON.stringify(writtenAgent)}`);
	const listedAgents = await call("list_agent_scripts");
	if (!listedAgents.scripts?.some((entry) => entry.path === agentScriptPath)) throw new Error("The written agent script was not listed.");
	const ranAgent = await call("run_agent_script", { name: agentName });
	if (!ranAgent.ran || ranAgent.result !== "mcp-agent-live") throw new Error(`The written agent script did not execute against the live scene: ${JSON.stringify(ranAgent)}`);
	await call("delete_asset", { path: agentScriptPath, confirm: true });
	agentScriptPath = null;

	const parent = await call("create_primitive_mesh", { type: "empty", name: parentName, position: [0, 100, 0] });
	parentId = parent.id;
	const fixture = await call("create_primitive_mesh", { type: "box", name: childName, position: [10, 120, 30], options: { size: 25 } });
	childId = fixture.id;
	const initialLayers = await call("list_sorting_layers");
	const sortingLayer = await call("create_sorting_layer", { name: `MCP Sorting ${suffix}`, order: 2 });
	sortingLayerId = sortingLayer.id;
	const assignedSorting = await call("set_node_sorting_layer", { nodeId: childId, layerId: sortingLayerId, orderInLayer: 17 });
	if (assignedSorting.layer.id !== sortingLayerId || assignedSorting.orderInLayer !== 17) throw new Error("Sorting-layer assignment evidence is incomplete.");
	const layersAfterCreate = await call("list_sorting_layers");
	if (layersAfterCreate.layers.length !== initialLayers.layers.length + 1 || !layersAfterCreate.layers.some((layer) => layer.id === sortingLayerId)) {
		throw new Error("Created sorting layer was not listed.");
	}
	const deletedSorting = await call("delete_sorting_layer", { layerId: sortingLayerId, confirm: true });
	if (!deletedSorting.deleted || deletedSorting.clearedNodeCount !== 1) throw new Error(`Sorting-layer deletion evidence is incomplete: ${JSON.stringify(deletedSorting)}`);
	sortingLayerId = null;

	const transformLease = await call("get_collaboration_node_revision", { nodeId: childId });
	await call("apply_collaborative_node_transform", {
		nodeId: childId,
		expectedRevision: transformLease.revision,
		operationId: `transform-${suffix}`,
		position: [20, 130, 40],
	});
	const editLease = await call("get_collaboration_node_edit_revision", { nodeId: childId });
	await call("apply_collaborative_node_edit", {
		nodeId: childId,
		expectedRevision: editLease.revision,
		operationId: `edit-${suffix}`,
		visible: false,
		isPickable: true,
		checkCollisions: false,
	});
	const hierarchyLease = await call("get_collaboration_hierarchy_revision", { nodeId: childId });
	await call("apply_collaborative_hierarchy_edit", {
		nodeId: childId,
		parentId,
		expectedRevision: hierarchyLease.revision,
		operationId: `hierarchy-${suffix}`,
	});
	const propertyLease = await call("get_collaboration_node_property_revision", { nodeId: childId, paths: ["alphaIndex"] });
	await call("apply_collaborative_node_properties", {
		nodeId: childId,
		expectedRevision: propertyLease.revision,
		operationId: `property-${suffix}`,
		properties: { alphaIndex: 2 },
	});

	await call("get_node_classification", { nodeId: childId });
	await call("set_node_classification", { nodeId: childId, layer: "MCP Verification", tags: ["mcp", "temporary"] });
	await call("set_node_properties", { nodeId: childId, properties: { alphaIndex: 3, isVisible: true } });
	await call("set_node_parent", { nodeId: childId, preserveWorldTransform: true });
	await call("set_node_parent", { nodeId: childId, parentId, preserveWorldTransform: true });
	await call("rename_node", { nodeId: childId, newName: renamedChild });
	await call("undo_editor");
	await call("redo_editor");
	const renamed = await call("get_node", { nodeId: childId });
	if (renamed.name !== renamedChild) throw new Error(`Redo did not restore the node rename: ${renamed.name}`);
	await call("select_node", { nodeId: childId });
	const selected = await call("get_selected_nodes");
	if (!selected.nodes?.some((node) => node.id === childId)) throw new Error("Selected-node readback failed.");

	const batch = await call("execute_batch", {
		actions: [
			{ tool: "set_node_transform", arguments: { nodeId: childId, scaling: [1.1, 1.1, 1.1] } },
			{ tool: "set_node_properties", arguments: { nodeId: childId, properties: { alphaIndex: 4 } } },
		],
	});
	if (!batch.results?.every((result) => result.ok)) throw new Error(`Batch execution failed: ${JSON.stringify(batch)}`);

	const camera = await call("get_camera", { nodeName: "camera" });
	await call("set_camera_properties", {
		nodeId: camera.id,
		position: camera.position,
		target: camera.target,
		properties: { fov: camera.properties.fov, minZ: camera.properties.minZ, maxZ: camera.properties.maxZ },
	});
	await call("capture_visual_regression_baseline", { path: baselinePath, width: 320, height: 180 });
	baselineCreated = true;

	const beforeRun = await call("get_project_run_status");
	const inspectorSearch = await call("set_inspector_search", { query: "gravity" });
	if (inspectorSearch.query !== "gravity") throw new Error(`Inspector search did not retain its exact query: ${JSON.stringify(inspectorSearch)}`);
	await call("set_inspector_search", { query: "" });
	if (beforeRun.running) await call("stop_project");
	await call("run_project");
	const running = await call("get_project_run_status");
	if (!running.running && !running.busy) throw new Error(`run_project did not create a development process: ${JSON.stringify(running)}`);
	await call("stop_project");
	const stopped = await call("get_project_run_status");
	if (stopped.running || stopped.busy) throw new Error(`stop_project did not release the development process: ${JSON.stringify(stopped)}`);

	await cleanup();
	console.log(
		"[core-editor] PASS — core editor controls, 14 node tools, camera round-trip, batch execution, visual baseline, terminal, undo/redo, and external project start/status/stop completed with cleanup."
	);
} catch (error) {
	console.error(`[core-editor] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

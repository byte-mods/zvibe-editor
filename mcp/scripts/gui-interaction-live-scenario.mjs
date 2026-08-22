#!/usr/bin/env node
/** Real stdio/editor lifecycle for CanvasGroup, RaycastReceiver, local UGUI usage, and styled Inspector collections. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "index.mjs");
const child = spawn("node", [server], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = !!response.error || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

const suffix = `${Date.now()}-${process.pid}`;
const guiPath = `assets/__gui-interaction-${suffix}.gui`;
const scriptPath = `src/__inspector-collections-${suffix}.ts`;
let projectPath;
let guiId;
let guiRevision;
let nodeId;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gui-interaction-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	const expectedTools = [
		"get_gui_interaction_capabilities",
		"get_gui_canvas_group",
		"set_gui_canvas_group",
		"list_gui_raycast_receivers",
		"set_gui_raycast_receiver",
		"get_gui_usage_tracking",
		"set_gui_usage_tracking",
		"reset_gui_usage_tracking",
		"get_inspector_collection_capabilities",
	];
	const names = new Set(listed.result.tools.map((tool) => tool.name));
	if (expectedTools.some((name) => !names.has(name))) throw new Error("One or more #737 tools are absent from real stdio discovery.");

	const status = await call("get_editor_status");
	projectPath = status.projectPath;
	const editorCapabilities = await call("get_editor_capabilities");
	if (!editorCapabilities.features.guiCanvasGroups || !editorCapabilities.features.guiRaycastReceivers || !editorCapabilities.features.guiLocalUsageTracking)
		throw new Error("Editor capability flags for #737 are incomplete.");
	const interactionCapabilities = await call("get_gui_interaction_capabilities");
	if (
		!interactionCapabilities.canvasGroup.hierarchyEffective ||
		!interactionCapabilities.raycastReceiver.invisible ||
		interactionCapabilities.usageTracking.externallyTransmitted
	)
		throw new Error("GUI interaction capabilities are incomplete or violate local-only usage policy.");
	const collectionCapabilities = await call("get_inspector_collection_capabilities");
	if (
		collectionCapabilities.maximumEditorItems !== 256 ||
		collectionCapabilities.decorators.length !== 2 ||
		collectionCapabilities.valueMutationTool !== "set_script_exported_value"
	)
		throw new Error("Inspector collection capability evidence is incomplete.");

	await call("create_gui_asset", { path: guiPath, name: `Interaction HUD ${suffix}` });
	const instantiated = await call("instantiate_gui_asset", { path: guiPath });
	guiId = instantiated.id;
	let result = await call("create_gui_control", {
		guiId,
		expectedRevision: 0,
		controlId: "live-fade",
		parentControlId: null,
		type: "canvasGroup",
		properties: { name: "Live Fade", width: "100%", height: "100%", alpha: 0.45, interactable: true, blocksRaycasts: true, ignoreParentGroups: false },
	});
	guiRevision = result.revision;
	result = await call("create_gui_control", {
		guiId,
		expectedRevision: guiRevision,
		controlId: "live-receiver",
		parentControlId: "live-fade",
		type: "raycastReceiver",
		properties: { name: "Live Receiver", width: "320px", height: "180px" },
	});
	guiRevision = result.revision;
	result = await call("set_gui_canvas_group", {
		guiId,
		expectedRevision: guiRevision,
		controlId: "live-fade",
		assignment: { alpha: 0.6, interactable: true, blocksRaycasts: true, ignoreParentGroups: true },
	});
	guiRevision = result.revision;
	result = await call("set_gui_usage_tracking", { guiId, expectedRevision: guiRevision, settings: { enabled: true, maxRecentEvents: 16 } });
	guiRevision = result.revision;
	await new Promise((resolve) => setTimeout(resolve, 500));
	const group = await call("get_gui_canvas_group", { guiId, controlId: "live-fade" });
	const receivers = await call("list_gui_raycast_receivers", { guiId, offset: 0, limit: 10 });
	const usage = await call("get_gui_usage_tracking", { guiId, offset: 0, limit: 10 });
	if (group.assignment.alpha !== 0.6 || !group.assignment.ignoreParentGroups || receivers.receivers.total !== 1 || usage.evidence.controlCount < 2)
		throw new Error("Live GUI authoring/usage evidence did not match the exact authored state.");
	await call(
		"set_gui_canvas_group",
		{
			guiId,
			expectedRevision: guiRevision - 1,
			controlId: "live-fade",
			assignment: { alpha: 1, interactable: true, blocksRaycasts: true, ignoreParentGroups: false },
		},
		true
	);
	await call("reset_gui_usage_tracking", { guiId, expectedRevision: guiRevision });
	result = await call("set_gui_raycast_receiver", { guiId, expectedRevision: guiRevision, controlId: "live-receiver", enabled: false });
	guiRevision = result.revision;
	await call("save_gui_asset", { guiId, path: guiPath, overwrite: true });
	await call("delete_gui_instance", { guiId, expectedRevision: guiRevision, confirm: true });
	guiId = undefined;
	const reloaded = await call("instantiate_gui_asset", { path: guiPath });
	guiId = reloaded.id;
	const persisted = await call("get_gui_authoring", { guiId, offset: 0, limit: 20 });
	guiRevision = persisted.authoring.revision;
	if (persisted.authoring.canvasGroups[0]?.alpha !== 0.6 || persisted.authoring.raycastReceivers[0]?.enabled !== false || !persisted.authoring.usageTracking.enabled)
		throw new Error("Saved/reloaded GUI interaction state was not preserved.");

	const node = await call("create_primitive_mesh", { type: "empty", name: `Inspector Collections ${suffix}` });
	nodeId = node.id;
	await call("create_script", { path: scriptPath, className: "InspectorCollections", template: "empty" });
	await call("write_script", {
		path: scriptPath,
		content: `import { TransformNode } from "babylonjs";\nimport { visibleAsArray, visibleAsList } from "babylonjs-editor-tools";\n\nexport default class InspectorCollections {\n\t@visibleAsArray("number", "Damage", { maxItems: 8, defaultItem: 1, styleType: "number", style: { icon: "DMG", accentColor: "#ef4444", variant: "cards" } })\n\tpublic damage: number[] = [1, 2];\n\n\t@visibleAsList("string", "Tags", { maxItems: 16, style: { striped: true, density: "compact" } })\n\tpublic tags: string[] = ["live"];\n\n\tpublic constructor(public node: TransformNode) {}\n}\n`,
	});
	const fields = await call("get_script_exported_fields", { path: scriptPath });
	if (fields.fields.length !== 2 || !fields.fields.some((field) => field.decorator.startsWith("visibleAsArray"))) throw new Error("Collection decorators were not discoverable.");
	await call("attach_script", { nodeId, path: scriptPath });
	await call("set_script_exported_value", { nodeId, path: scriptPath, key: "damage", value: [3, 5, 8] });
	await call("set_script_exported_value", { nodeId, path: scriptPath, key: "tags", value: ["live", "styled"] });
	const attached = await call("list_attached_scripts", { nodeId });
	if (attached.scripts[0]?.exportedValues.damage?.value?.[2] !== 8 || attached.scripts[0]?.exportedValues.tags?.value?.[1] !== "styled")
		throw new Error("External bounded collection mutation was not persisted on the attached script.");
	await call("select_node", { nodeId });
	await new Promise((resolve) => setTimeout(resolve, 1_000));

	await call("detach_script", { nodeId, path: scriptPath });
	await call("delete_node", { nodeId: node.id });
	nodeId = undefined;
	await new Promise((resolve) => setTimeout(resolve, 250));
	await call("delete_script", { path: scriptPath, confirm: true });
	await call("delete_gui_instance", { guiId, expectedRevision: guiRevision, confirm: true });
	guiId = undefined;
	await call("delete_asset", { path: guiPath, confirm: true });

	console.log(
		`[gui-interaction-live] PASS — ${listed.result.tools.length} tools, CanvasGroup alpha/ignore-parent, invisible RaycastReceiver, local-only bounded usage, stale rejection, save/reload, typed styled list/array discovery and external mutation, exact cleanup.`
	);
} catch (error) {
	console.error(`[gui-interaction-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (nodeId) {
			await call("detach_script", { nodeId, path: scriptPath }).catch(() => undefined);
			await call("delete_node", { nodeId }).catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		await call("delete_script", { path: scriptPath, confirm: true }).catch(() => undefined);
		if (guiId && guiRevision !== undefined) await call("delete_gui_instance", { guiId, expectedRevision: guiRevision, confirm: true }).catch(() => undefined);
		if (projectPath) {
			const projectRoot = dirname(projectPath);
			await call("delete_asset", { path: guiPath, confirm: true }).catch(() => undefined);
			await rm(join(projectRoot, guiPath), { force: true });
			await rm(join(projectRoot, `${guiPath}.bjsmeta.json`), { force: true });
			await rm(join(projectRoot, scriptPath), { force: true });
			await rm(join(projectRoot, `${scriptPath}.bjsmeta.json`), { force: true });
			await rm(join(projectRoot, ".bjseditor", "scripts", `${scriptPath.slice("src/".length).replace(/\//g, "_")}.cjs`), { force: true });
		}
	} catch (cleanupError) {
		console.error(`[gui-interaction-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

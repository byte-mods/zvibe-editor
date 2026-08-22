#!/usr/bin/env node
/** Valid-state real-editor lifecycle for advanced scene/workspace MCP tools. */
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
const sceneA = `assets/mcp-scene-lifecycle-a-${suffix}.scene`;
const sceneB = `assets/mcp-scene-lifecycle-b-${suffix}.scene`;
const sceneC = `assets/mcp-scene-lifecycle-template-${suffix}.scene`;
const template = `assets/mcp-scene-lifecycle-${suffix}.scenetemplate`;
let originalScene;
let linkId = null;
let fixtureId = null;

async function workspace() {
	return call("get_scene_workspace");
}

async function cleanup() {
	if (!originalScene) return;
	if (fixtureId) {
		try {
			await call("delete_node", { nodeId: fixtureId });
			fixtureId = null;
		} catch (error) {
			console.error(`[scene-lifecycle] moved fixture cleanup warning: ${error.message}`);
		}
	}
	if (linkId) {
		try {
			await call("delete_node", { nodeId: linkId });
			linkId = null;
		} catch (error) {
			console.error(`[scene-lifecycle] SceneLink cleanup warning: ${error.message}`);
		}
	}
	try {
		let current = await workspace();
		if (current.scenes.some((scene) => scene.path === originalScene)) {
			if (current.activeScene !== originalScene) {
				await call("set_active_workspace_scene", { path: originalScene, expectedFingerprint: current.fingerprint });
				current = await workspace();
			}
			if (current.lightingScene !== originalScene) {
				await call("set_lighting_workspace_scene", { path: originalScene, expectedFingerprint: current.fingerprint });
			}
		}
		for (const path of [sceneA, sceneB, sceneC]) {
			current = await workspace();
			if (current.scenes.some((scene) => scene.path === path)) {
				await call("unload_scene_additive", { path, expectedFingerprint: current.fingerprint, confirm: true });
			}
		}
	} catch (error) {
		console.error(`[scene-lifecycle] workspace cleanup warning: ${error.message}`);
	}
	try {
		const templates = await call("list_scene_templates", { offset: 0, limit: 100 });
		if (templates.templates?.some((entry) => entry.path === template)) await call("delete_scene_template", { path: template, confirm: true });
	} catch (error) {
		console.error(`[scene-lifecycle] template cleanup warning: ${error.message}`);
	}
	for (const path of [sceneC, sceneB, sceneA]) {
		try {
			const scenes = await call("list_scenes", { offset: 0, limit: 100 });
			if (scenes.scenes.some((scene) => scene.path === path && !scene.isActive)) await call("delete_scene", { path, confirm: true });
		} catch (error) {
			console.error(`[scene-lifecycle] scene cleanup warning for ${path}: ${error.message}`);
		}
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "scene-lifecycle-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.activeScenePath) throw new Error("A ready editor with an active scene is required.");
	originalScene = status.activeScenePath.replace(`${status.projectPath.slice(0, status.projectPath.lastIndexOf("/") + 1)}`, "");

	const listed = await call("list_scenes", { offset: 0, limit: 100 });
	if (!listed.scenes.some((scene) => scene.path === originalScene)) throw new Error(`Active scene is absent from list_scenes: ${originalScene}`);
	const buildSettings = await call("get_scene_build_settings");
	await call("set_scene_build_settings", { expectedFingerprint: buildSettings.fingerprint, scenes: buildSettings.scenes });

	await call("get_scene_settings");
	await call("get_2d_scene_mode");
	await call("get_physics_collision_layers");
	await call("duplicate_scene", { sourcePath: originalScene, destinationPath: sceneA });
	await call("duplicate_scene", { sourcePath: originalScene, destinationPath: sceneB });

	let current = await workspace();
	await call("load_scene_additive", { path: sceneA, expectedFingerprint: current.fingerprint });
	current = await workspace();
	await call("load_scene_additive", { path: sceneB, expectedFingerprint: current.fingerprint });
	current = await workspace();
	await call("set_active_workspace_scene", { path: sceneA, expectedFingerprint: current.fingerprint });
	current = await workspace();
	await call("set_lighting_workspace_scene", { path: sceneA, expectedFingerprint: current.fingerprint });

	const fixture = await call("create_primitive_mesh", { type: "box", name: `MCP Scene Move ${suffix}`, position: [0, 100, 0], options: { size: 25 } });
	fixtureId = fixture.id;
	const plan = await call("inspect_scene_object_move", { nodeIds: [fixture.id], targetScene: sceneB });
	await call("move_scene_objects", { nodeIds: [fixture.id], targetScene: sceneB, expectedPlanFingerprint: plan.planFingerprint });
	current = await workspace();
	await call("save_workspace_scene", { path: sceneB, expectedFingerprint: current.fingerprint });
	await call("delete_node", { nodeId: fixture.id });
	fixtureId = null;
	current = await workspace();
	await call("save_workspace_scene", { path: sceneB, expectedFingerprint: current.fingerprint });

	const link = await call("create_scene_link", { path: originalScene, name: `MCP Scene Link ${suffix}` });
	linkId = link.id;
	const links = await call("list_scene_links");
	if (!links.sceneLinks?.some((entry) => entry.id === link.id)) throw new Error("SceneLink readback failed.");
	await call("reload_scene_link", { nodeId: link.id });
	await call("delete_node", { nodeId: link.id });
	linkId = null;

	const settings = await call("get_scene_settings");
	const alteredClear = settings.clearColor.map((value, index) => (index < 3 ? Math.min(1, Number(value) + 0.01) : value));
	await call("set_scene_settings", { properties: { clearColor: alteredClear } });
	const mode = await call("get_2d_scene_mode");
	await call("set_2d_scene_mode", { enabled: true, orthographicSize: mode.orthographicSize || 500, aspectRatio: 1.7777777778 });
	await call("set_2d_scene_mode", { enabled: false });
	const collisionLayers = await call("get_physics_collision_layers");
	await call("set_physics_collision_layers", { layers: collisionLayers.layers });
	current = await workspace();
	await call("save_workspace_scene", { path: sceneA, expectedFingerprint: current.fingerprint });
	await call("set_scene_settings", { properties: { fogDensity: Number(settings.fogDensity ?? 0) + 0.000001 } });
	current = await workspace();
	await call("revert_workspace_scene", { path: sceneA, expectedFingerprint: current.fingerprint, confirm: true });

	await call("create_scene_template", { sourcePath: sceneA, templatePath: template, name: `MCP Scene Lifecycle ${suffix}` });
	const templates = await call("list_scene_templates", { offset: 0, limit: 100 });
	if (!templates.templates?.some((entry) => entry.path === template)) throw new Error("Scene template readback failed.");
	await call("instantiate_scene_template", { templatePath: template, destinationPath: sceneC });

	current = await workspace();
	await call("set_lighting_workspace_scene", { path: originalScene, expectedFingerprint: current.fingerprint });
	current = await workspace();
	await call("set_active_workspace_scene", { path: originalScene, expectedFingerprint: current.fingerprint });
	await cleanup();
	const finalScenes = await call("list_scenes", { offset: 0, limit: 100 });
	if ([sceneA, sceneB, sceneC].some((path) => finalScenes.scenes.some((scene) => scene.path === path))) throw new Error("Temporary scene cleanup failed.");
	console.log("[scene-lifecycle] PASS — 25/25 previously uncovered scene/workspace tools completed valid live lifecycles with MCP-only fixtures and cleanup.");
} catch (error) {
	console.error(`[scene-lifecycle] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

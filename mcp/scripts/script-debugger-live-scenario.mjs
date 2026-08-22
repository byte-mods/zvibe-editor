#!/usr/bin/env node
/** Real stdio/editor lifecycle for Debug Play breakpoints, coverage, reports, templates, and cleanup. */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

function rpc(method, params, timeoutMs = 120_000, operation = method) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${operation} (${method}).`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}, expectError = false, timeoutMs = 120_000) {
	const response = await rpc("tools/call", { name, arguments: args }, timeoutMs, name);
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

const required = [
	"list_custom_script_templates",
	"get_custom_script_template",
	"set_custom_script_template",
	"delete_custom_script_template",
	"get_script_debugger_capabilities",
	"prepare_script_debugger",
	"get_script_debugger",
	"set_script_breakpoints",
	"control_script_debugger",
	"get_script_source_coverage",
	"set_script_source_coverage",
	"export_script_source_coverage",
];
const suffix = `${Date.now()}-${process.pid}`;
const templateId = `debug_${process.pid}`;
const fixtureName = `MCP Script Debugger ${suffix}`;
const scriptPath = `src/mcp-script-debugger-${suffix}.ts`;
const scenePath = `scenes/mcp-script-debugger-${suffix}.scene`;
const reportPaths = [`.bjseditor/script-coverage/mcp-${suffix}.json`, `.bjseditor/script-coverage/mcp-${suffix}.lcov`];
let nodeId;
let projectPath;
let originalScriptsContent;
let originalScenePath;
let sceneCreated = false;

async function cleanup(strict = false) {
	try {
		const capabilities = await call("get_script_debugger_capabilities");
		if (capabilities.play.playing) await call("set_preview_play_mode", { action: "stop" });
	} catch (error) {
		if (strict) throw error;
	}
	if (nodeId) {
		try {
			await call("detach_script", { nodeId, path: scriptPath });
		} catch (error) {
			if (strict) throw error;
		}
		try {
			const deleted = await call("delete_node", { nodeId });
			if (strict && deleted.deleted !== true) throw new Error(`Script Debugger fixture node was not deleted: ${JSON.stringify(deleted)}`);
		} catch (error) {
			if (strict) throw error;
		}
		nodeId = undefined;
	}
	if (originalScriptsContent !== undefined) {
		try {
			await call("write_script", { path: "src/scripts.ts", content: originalScriptsContent });
			originalScriptsContent = undefined;
		} catch (error) {
			if (strict) throw error;
		}
	}
	try {
		await call("delete_script", { path: scriptPath, confirm: true });
	} catch (error) {
		if (strict && !String(error).includes("Script not found")) throw error;
	}
	try {
		const template = await call("get_custom_script_template", { id: templateId });
		await call("delete_custom_script_template", { id: templateId, expectedFingerprint: template.fingerprint, confirm: true });
	} catch (error) {
		if (strict && !String(error).includes("not found")) throw error;
	}
	if (projectPath) {
		const projectDirectory = dirname(projectPath);
		for (const path of reportPaths) await rm(join(projectDirectory, path), { force: true });
		await rm(join(projectDirectory, `${scriptPath}.bjsmeta.json`), { force: true });
		await rm(join(projectDirectory, ".bjseditor", "scripts", `${basename(scriptPath).replaceAll("/", "_")}.cjs`), { force: true });
		const exportedSceneName = basename(scenePath, ".scene");
		await rm(join(projectDirectory, "public", "scene", `${exportedSceneName}.babylon`), { force: true });
		await rm(join(projectDirectory, "public", "scene", exportedSceneName), { recursive: true, force: true });
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "script-debugger-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of required) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
	}
	await call("get_script_debugger_capabilities", { unknown: true }, true);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the script debugger live scenario.");
	projectPath = status.projectPath;
	await cleanup();
	originalScriptsContent = (await call("read_script", { path: "src/scripts.ts" })).content;
	const active = await call("get_active_scene");
	originalScenePath = active.path;
	if (!originalScenePath || originalScenePath === scenePath) throw new Error("The script debugger live scenario requires an existing scene that can be restored.");
	if (process.env.SCRIPT_DEBUGGER_LIVE_ALLOW_SCENE_SWITCH !== "1") {
		throw new Error(
			"Set SCRIPT_DEBUGGER_LIVE_ALLOW_SCENE_SWITCH=1 only for a disposable editor project; the test restores the active scene after its isolated Debug Play fixture."
		);
	}
	sceneCreated = true;
	await call("create_scene", { path: scenePath });

	const createdTemplate = await call("set_custom_script_template", {
		id: templateId,
		description: "Live debugger template",
		content: "export default class MyScriptComponent { public onUpdate(): void {} }\n",
	});
	let template = await call("get_custom_script_template", { id: templateId });
	if (template.fingerprint !== createdTemplate.fingerprint || !template.content.includes("onUpdate")) throw new Error("Exact custom-template inspection failed.");
	await call("set_custom_script_template", { id: templateId, description: "stale", content: template.content, expectedFingerprint: "0".repeat(64) }, true);
	await call("set_custom_script_template", {
		id: templateId,
		description: "Live debugger template updated",
		content: template.content.replace("onUpdate", "onStart"),
		expectedFingerprint: template.fingerprint,
	});
	template = await call("get_custom_script_template", { id: templateId });
	const templates = await call("list_custom_script_templates");
	if (!templates.templates.some((entry) => entry.id === templateId && entry.fingerprint === template.fingerprint && entry.content === undefined))
		throw new Error("Custom-template metadata listing is incomplete or leaked content.");

	const fixture = await call("create_primitive_mesh", { type: "box", name: fixtureName, position: [0, 200, 0], options: { size: 25 } });
	nodeId = fixture.id;
	const source = `import { Mesh } from "@babylonjs/core/Meshes/mesh";

export default class DebugProbe {
	public ticks = 0;
	public constructor(public mesh: Mesh) {}

	public onUpdate(): void {
		this.ticks++;
		if (this.ticks % 2 === 0) this.mesh.rotation.y += 0.01;
	}
}
`;
	await call("create_script", { path: scriptPath, template: "empty", className: "DebugProbe" });
	await call("write_script", { path: scriptPath, content: source });
	await call("attach_script", { nodeId, path: scriptPath });

	const capabilities = await call("get_script_debugger_capabilities");
	if (capabilities.backend !== "instrumented-debug-play-safe-boundary-v1" || capabilities.variables.expressionEvaluation !== false)
		throw new Error("Debugger capability boundary is incomplete.");
	let state = await call("prepare_script_debugger", { enabled: true }, false, 600_000);
	state = await call("set_script_breakpoints", {
		expectedManifestFingerprint: state.debugger.manifestFingerprint,
		expectedConfigurationRevision: state.debugger.configurationRevision,
		breakpoints: [{ id: "live-tick", path: scriptPath, line: 8, hitCondition: 1 }],
	});
	if (state.debugger.breakpoints[0]?.resolvedLine !== 8) throw new Error("Breakpoint did not resolve to the exact executable line.");
	state = await call("set_script_source_coverage", {
		expectedManifestFingerprint: state.debugger.manifestFingerprint,
		expectedConfigurationRevision: state.debugger.configurationRevision,
		enabled: true,
		clear: true,
	});
	for (let attempt = 0; attempt < 40 && !state.debugger.currentHit; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		state = await call("get_script_debugger");
	}
	if (!state.debugger.currentHit || state.simulation.paused !== true || typeof state.debugger.currentHit.fields.ticks !== "number")
		throw new Error("Live breakpoint, pause, or safe field snapshot evidence is incomplete.");
	const stepped = await call("control_script_debugger", {
		expectedManifestFingerprint: state.debugger.manifestFingerprint,
		expectedConfigurationRevision: state.debugger.configurationRevision,
		expectedPaused: true,
		action: "step",
		deltaSeconds: 1 / 60,
	});
	if (!stepped.step?.breakpointHit || stepped.simulation.paused !== true) throw new Error("Paused fixed-step breakpoint evidence is incomplete.");
	const coverage = await call("get_script_source_coverage", { path: scriptPath, limit: 100 });
	if (!coverage.summary.statements.covered || !coverage.summary.functions.covered || !coverage.summary.branches.covered)
		throw new Error("Live source coverage did not record statements, functions, and branches.");
	for (const [format, path] of [
		["json", reportPaths[0]],
		["lcov", reportPaths[1]],
	]) {
		const report = await call("export_script_source_coverage", {
			expectedManifestFingerprint: stepped.debugger.manifestFingerprint,
			expectedConfigurationRevision: stepped.debugger.configurationRevision,
			expectedCoverageRevision: coverage.coverageRevision,
			format,
			path,
		});
		if (report.format !== format || report.bytes <= 0 || !/^[a-f0-9]{64}$/.test(report.sha256)) throw new Error(`${format} coverage export evidence is incomplete.`);
	}
	state = await call("control_script_debugger", {
		expectedManifestFingerprint: stepped.debugger.manifestFingerprint,
		expectedConfigurationRevision: stepped.debugger.configurationRevision,
		expectedPaused: true,
		action: "clear-trace",
	});
	if (state.debugger.traceCount !== 0 || state.debugger.currentHit !== null) throw new Error("Debugger trace clear did not apply exactly.");
	await call("prepare_script_debugger", { enabled: false }, false, 600_000);
	await cleanup(true);
	await call("open_scene", { path: originalScenePath });
	await call("delete_scene", { path: scenePath, confirm: true });
	sceneCreated = false;
	console.log(
		"[script-debugger-live] PASS — 12/12 workflow tools, real instrumented Play breakpoint/pause/step, safe fields, source coverage, JSON/LCOV, stale leases, templates, and cleanup verified."
	);
} catch (error) {
	console.error(`[script-debugger-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		await cleanup();
	} catch (error) {
		console.error(`[script-debugger-live] cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	if (sceneCreated && originalScenePath) {
		try {
			await call("open_scene", { path: originalScenePath });
			try {
				await call("delete_scene", { path: scenePath, confirm: true });
			} catch (error) {
				if (!String(error).includes("Scene not found")) throw error;
			}
			sceneCreated = false;
		} catch (error) {
			console.error(`[script-debugger-live] scene cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
	child.kill("SIGTERM");
}

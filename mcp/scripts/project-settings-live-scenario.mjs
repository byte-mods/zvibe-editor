#!/usr/bin/env node
/** Real stdio/editor lifecycle for exact-revision Project Settings and user-scoped Editor Preferences. */
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

const requiredTools = [
	"get_project_settings",
	"set_project_settings",
	"reset_project_settings",
	"get_editor_preferences",
	"set_editor_preferences",
	"reset_editor_preferences",
];
let baselineProject;
let baselinePreferences;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "project-settings-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing settings tools: ${missing.join(", ")}`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the settings live scenario.");

	baselineProject = (await call("get_project_settings")).settings;
	baselinePreferences = (await call("get_editor_preferences")).preferences;
	await call("set_project_settings", { expectedRevision: baselineProject.revision, settings: { display: { defaultWidth: 1 }, unexpected: true } }, true);
	const changedProject = await call("set_project_settings", {
		expectedRevision: baselineProject.revision,
		settings: {
			identity: { productName: "Zvibe Settings Live", version: "1.2.3", applicationId: "com.zvibe.settingslive" },
			rendering: { colorSpace: "linear", renderingBackend: "webgpu", maximumDevicePixelRatio: 1.5 },
			playMode: { muteAudio: true },
			platformOverrides: { web: { display: { defaultWidth: 1440, defaultHeight: 900 }, rendering: { targetFrameRate: 75 } } },
		},
	});
	if (
		changedProject.settings.revision !== baselineProject.revision + 1 ||
		changedProject.resolvedPlatforms.web.display.defaultWidth !== 1440 ||
		changedProject.resolvedPlatforms.web.rendering.targetFrameRate !== 75 ||
		!changedProject.restartRequired.includes("rendering.renderingBackend")
	) {
		throw new Error("Project Settings mutation/resolution evidence was incomplete.");
	}
	await call("set_project_settings", { expectedRevision: baselineProject.revision, settings: { display: { defaultWidth: 800 } } }, true);
	const defaults = await call("reset_project_settings", { expectedRevision: changedProject.settings.revision, confirm: true });
	if (defaults.settings.display.defaultWidth !== 1920) throw new Error("Project Settings reset did not restore defaults.");

	await call("set_editor_preferences", { expectedRevision: baselinePreferences.revision, preferences: { appearance: { theme: "dark", uiScale: 1 }, unknown: true } }, true);
	const changedPreferences = await call("set_editor_preferences", {
		expectedRevision: baselinePreferences.revision,
		preferences: { workflow: { autoSave: false, autoSaveIntervalMinutes: 7, confirmDestructiveActions: true }, diagnostics: { logLevel: "verbose" } },
	});
	if (changedPreferences.preferences.revision !== baselinePreferences.revision + 1 || changedPreferences.preferences.diagnostics.logLevel !== "verbose") {
		throw new Error("Editor Preferences mutation evidence was incomplete.");
	}
	await call("set_editor_preferences", { expectedRevision: baselinePreferences.revision, preferences: { diagnostics: { logLevel: "error" } } }, true);
	const editorDefaults = await call("reset_editor_preferences", { expectedRevision: changedPreferences.preferences.revision, confirm: true });
	if (editorDefaults.preferences.appearance.theme !== "dark") throw new Error("Editor Preferences reset did not restore defaults.");

	console.log(
		`[project-settings-live] PASS — ${requiredTools.length}/6 tools present, closed schemas, exact stale rejection, common and web-resolved Player Settings, live/restart evidence, project reset, user-scoped preferences, and preference reset.`
	);
} catch (error) {
	console.error(`[project-settings-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (baselineProject) {
			const current = (await call("get_project_settings")).settings;
			const { version: _version, revision: _revision, ...settings } = baselineProject;
			await call("set_project_settings", { expectedRevision: current.revision, settings });
		}
		if (baselinePreferences) {
			const current = (await call("get_editor_preferences")).preferences;
			const { version: _version, revision: _revision, ...preferences } = baselinePreferences;
			await call("set_editor_preferences", { expectedRevision: current.revision, preferences });
		}
	} catch (cleanupError) {
		console.error(`[project-settings-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

#!/usr/bin/env node
/** Real stdio/editor verification for external editor-extension automation without mutating the active project. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
	"get_editor_extension_sdk",
	"list_editor_extensions",
	"plan_editor_extension_change",
	"apply_editor_extension_plan",
	"reload_editor_extension",
	"open_editor_extension_window",
	"invoke_editor_extension_menu",
	"list_build_profile_footer_actions",
	"invoke_build_profile_footer_action",
	"run_editor_extension_tests",
];

const suffix = `${Date.now()}-${process.pid}`;
const packageName = `zvibe-mcp-live-extension-${process.pid}`;
const extensionId = "zvibe.mcp.livefixture";
const windowId = `${extensionId}.window`;
const menuId = `${extensionId}.menu`;
const testId = `${extensionId}.test`;
const footerActionId = `${extensionId}.build`;
const fixtureAgentName = `extension-fixture-${suffix}.js`;
const cleanupAgentName = `extension-cleanup-${suffix}.js`;
let projectRoot = null;
let packageBytes = null;
let fixtureInstalled = false;

async function applyLifecycleOperation(operation, capabilities) {
	const snapshot = await call("list_editor_extensions", { limit: 100 });
	const plan = await call("plan_editor_extension_change", {
		operation,
		packageName,
		expectedStateFingerprint: snapshot.fingerprint,
		...(capabilities ? { capabilities } : {}),
	});
	return call("apply_editor_extension_plan", { planId: plan.id, expectedStateFingerprint: snapshot.fingerprint, confirm: true });
}

async function cleanupExtensionState() {
	if (!fixtureInstalled) return;
	try {
		let snapshot = await call("list_editor_extensions", { limit: 100 });
		let view = snapshot.extensions.find((entry) => entry.packageName === packageName);
		let configured = snapshot.configured.some((entry) => entry.packageName === packageName);
		if (view?.enabled) {
			await applyLifecycleOperation("disable");
			snapshot = await call("list_editor_extensions", { limit: 100 });
			view = snapshot.extensions.find((entry) => entry.packageName === packageName);
			configured = snapshot.configured.some((entry) => entry.packageName === packageName);
		}
		if (view?.trusted) {
			await applyLifecycleOperation("revoke-trust");
			snapshot = await call("list_editor_extensions", { limit: 100 });
			configured = snapshot.configured.some((entry) => entry.packageName === packageName);
		}
		if (configured) await applyLifecycleOperation("remove-configuration");
	} catch {
		// The main lifecycle reports exact failures; final cleanup still restores project files.
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "editor-extensions-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const available = new Set(tools.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing editor extension tools: ${missing.join(", ")}`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} does not expose a closed input schema.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const editorStatus = await call("get_editor_status");
	if (!editorStatus.ready || !editorStatus.projectPath) throw new Error("A ready project editor is required for the editor-extension live scenario.");
	projectRoot = dirname(editorStatus.projectPath);
	packageBytes = await readFile(join(projectRoot, "package.json"));
	await call("run_agent_script", {
		name: fixtureAgentName,
		content: `
import { join } from "path";
import { ensureDir, readJSON, remove, writeFile, writeJSON } from "fs-extra";
export async function main(editor) {
	void editor;
	const root = ${JSON.stringify(projectRoot)};
	const packageName = ${JSON.stringify(packageName)};
	const packageRoot = join(root, "node_modules", packageName);
	const packageJson = await readJSON(join(root, "package.json"));
	packageJson.devDependencies = { ...(packageJson.devDependencies ?? {}), [packageName]: "1.0.0" };
	await remove(packageRoot);
	await ensureDir(packageRoot);
	await writeJSON(join(root, "package.json"), packageJson, { spaces: "\t" });
	await writeJSON(join(packageRoot, "package.json"), ${JSON.stringify({
		name: packageName,
		version: "1.0.0",
		main: "index.cjs",
		zvibeEditor: {
			apiVersion: 1,
			id: extensionId,
			displayName: "MCP Live Extension Fixture",
			description: "Disposable exact-state extension used by the MCP live verification suite.",
			capabilities: ["windows", "menus", "tests", "buildProfiles"],
			contributes: {
				windows: [{ id: windowId, title: "MCP Live Window", neighborId: "assets-browser" }],
				menus: [{ id: menuId, path: "Tools/MCP Live Extension" }],
				tests: [{ id: testId, title: "MCP Live Test" }],
				buildProfileFooterActions: [{ id: footerActionId, title: "MCP Live Build Action", order: 0, targets: [], activeProfileOnly: false }],
			},
		},
	})}, { spaces: "\t" });
	await writeFile(join(packageRoot, "index.cjs"), ${JSON.stringify(
		`exports.activate = function activate(context) {
	context.windows.register({ id: ${JSON.stringify(windowId)}, component: function McpLiveWindow() { return null; } });
	context.menus.register({ id: ${JSON.stringify(menuId)}, execute: function execute() { globalThis.__zvibeMcpExtensionMenuInvoked = true; } });
	context.tests.register({ id: ${JSON.stringify(testId)}, run: function run(signal) { if (signal.aborted) throw new Error("unexpected abort"); } });
	context.buildProfiles.registerFooterAction({ id: ${JSON.stringify(footerActionId)}, execute: function executeBuild(profile) { if (!profile || !profile.profile) throw new Error("missing profile context"); } });
};
`
	)});
	return JSON.stringify({ installed: true, packageName });
}`,
	});
	fixtureInstalled = true;
	const sdk = await call("get_editor_extension_sdk");
	if (sdk.apiVersion !== 1 || sdk.packageManifestField !== "zvibeEditor" || !sdk.security?.trustBoundToExactFingerprint || sdk.capabilities?.length !== 6) {
		throw new Error("Editor extension SDK evidence is incomplete.");
	}
	let extensions = await call("list_editor_extensions", { limit: 100 });
	if (!/^[a-f0-9]{64}$/.test(extensions.fingerprint) || !/^[a-f0-9]{64}$/.test(extensions.packageManagerFingerprint) || !Array.isArray(extensions.extensions)) {
		throw new Error("Editor extension inventory/fingerprint evidence is incomplete.");
	}
	let extension = extensions.extensions.find((entry) => entry.packageName === packageName);
	if (!extension || extension.enabled || extension.trusted || extension.runtime) throw new Error(`Disposable extension discovery state is invalid: ${JSON.stringify(extension)}`);
	let applied = await applyLifecycleOperation("trust", extension.manifest.capabilities);
	extension = applied.state.extensions.find((entry) => entry.packageName === packageName);
	if (!extension?.trusted || extension.enabled) throw new Error("Extension trust plan did not grant exact-content trust.");
	applied = await applyLifecycleOperation("enable");
	extension = applied.state.extensions.find((entry) => entry.packageName === packageName);
	if (!extension?.enabled || !extension.trusted || extension.runtime?.state !== "active") throw new Error(`Extension enable/activation failed: ${JSON.stringify(extension)}`);
	const extensionFingerprint = extension.fingerprint;
	const reloaded = await call("reload_editor_extension", { packageName, expectedExtensionFingerprint: extensionFingerprint });
	if (!reloaded.reloaded || reloaded.runtime?.state !== "active") throw new Error(`Extension reload failed: ${JSON.stringify(reloaded)}`);
	const opened = await call("open_editor_extension_window", { packageName, expectedExtensionFingerprint: extensionFingerprint, windowId });
	if (!opened.opened || opened.windowId !== windowId) throw new Error(`Extension window did not open: ${JSON.stringify(opened)}`);
	const invokedMenu = await call("invoke_editor_extension_menu", { packageName, expectedExtensionFingerprint: extensionFingerprint, menuId });
	if (!invokedMenu.invoked || invokedMenu.menuId !== menuId) throw new Error(`Extension menu did not execute: ${JSON.stringify(invokedMenu)}`);
	const profiles = await call("list_build_profiles");
	if (!profiles.activeProfileId) throw new Error("An active Build Profile is required for extension footer-action verification.");
	const footer = await call("list_build_profile_footer_actions", { profileId: profiles.activeProfileId, limit: 100 });
	if (footer.configurationRevision !== profiles.revision || footer.profile?.id !== profiles.activeProfileId || !footer.actions.some((entry) => entry.id === footerActionId)) {
		throw new Error("Build Profile footer action inventory did not preserve exact profile evidence.");
	}
	const invokedFooter = await call("invoke_build_profile_footer_action", {
		packageName,
		expectedExtensionFingerprint: extensionFingerprint,
		actionId: footerActionId,
		profileId: profiles.activeProfileId,
		expectedConfigurationRevision: profiles.revision,
		confirm: true,
	});
	if (!invokedFooter.invoked || invokedFooter.actionId !== footerActionId) throw new Error(`Extension Build Profile footer action failed: ${JSON.stringify(invokedFooter)}`);
	const testRun = await call("run_editor_extension_tests", { packageName, expectedExtensionFingerprint: extensionFingerprint, ids: [testId], timeoutMs: 5_000 });
	if (testRun.passed !== 1 || testRun.failed !== 0 || testRun.timedOut !== 0 || testRun.results?.[0]?.state !== "passed") {
		throw new Error(`Extension test runner failed: ${JSON.stringify(testRun)}`);
	}
	await applyLifecycleOperation("disable");
	await applyLifecycleOperation("revoke-trust");
	await applyLifecycleOperation("remove-configuration");
	const cleanState = await call("list_editor_extensions", { limit: 100 });
	const cleanView = cleanState.extensions.find((entry) => entry.packageName === packageName);
	if (
		!cleanView ||
		cleanView.enabled ||
		cleanView.trusted ||
		(cleanView.runtime && cleanView.runtime.state !== "inactive") ||
		cleanState.configured.some((entry) => entry.packageName === packageName)
	) {
		throw new Error(`Extension state cleanup is incomplete: ${JSON.stringify(cleanView)}`);
	}

	const absentPackage = "zvibe-live-scenario-absent-extension";
	const absentFingerprint = "0".repeat(64);
	const failures = [
		[
			"plan_editor_extension_change",
			{ operation: "enable", packageName: absentPackage, expectedStateFingerprint: extensions.fingerprint },
			"not an installed direct dependency",
		],
		["apply_editor_extension_plan", { planId: "00000000-0000-4000-8000-000000000000", expectedStateFingerprint: extensions.fingerprint, confirm: true }, "missing or expired"],
		["reload_editor_extension", { packageName: absentPackage, expectedExtensionFingerprint: absentFingerprint }, "not active"],
		["open_editor_extension_window", { packageName: absentPackage, expectedExtensionFingerprint: absentFingerprint, windowId: "com.example.absent.window" }, "not active"],
		["invoke_editor_extension_menu", { packageName: absentPackage, expectedExtensionFingerprint: absentFingerprint, menuId: "com.example.absent.menu" }, "not active"],
		[
			"invoke_build_profile_footer_action",
			{
				packageName: absentPackage,
				expectedExtensionFingerprint: absentFingerprint,
				actionId: "com.example.absent.build",
				profileId: profiles.activeProfileId,
				expectedConfigurationRevision: profiles.revision,
				confirm: true,
			},
			"not active",
		],
		["run_editor_extension_tests", { packageName: absentPackage, expectedExtensionFingerprint: absentFingerprint, ids: ["com.example.absent.test"] }, "not active"],
	];
	for (const [name, args, expectedText] of failures) {
		const failure = await call(name, args, true);
		if (!String(failure).includes(expectedText)) throw new Error(`${name} did not reach its expected editor-side guard: ${failure}`);
	}
	const unknown = await call("list_editor_extensions", { unexpected: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Editor extension tool did not reject an unknown field at the MCP boundary.");
	const missingConfirm = await call("apply_editor_extension_plan", { planId: "00000000-0000-4000-8000-000000000000", expectedStateFingerprint: extensions.fingerprint }, true);
	if (!String(missingConfirm).includes("-32602")) throw new Error("Extension apply did not require confirm:true at the MCP boundary.");

	console.log(
		`[editor-extensions-live] PASS — ${requiredTools.length}/10 tools, disposable package discovery, exact trust/enable plans, activation/reload, window/menu/footer invocation, test runner, guards, revoke/disable/config removal, and cleanup verified.`
	);
} catch (error) {
	console.error(`[editor-extensions-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanupExtensionState();
	if (fixtureInstalled && projectRoot && packageBytes) {
		await call("run_agent_script", {
			name: cleanupAgentName,
			content: `
import { join } from "path";
import { remove, writeFile } from "fs-extra";
export async function main(editor) {
	void editor;
	const root = ${JSON.stringify(projectRoot)};
	await writeFile(join(root, "package.json"), Buffer.from(${JSON.stringify(packageBytes?.toString("base64") ?? "")}, "base64"));
	await remove(join(root, "node_modules", ${JSON.stringify(packageName)}));
	return JSON.stringify({ restored: true });
}`,
		}).catch(() => undefined);
	}
	for (const path of [`agentdata/${fixtureAgentName}`, `agentdata/${cleanupAgentName}`]) await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	child.kill("SIGTERM");
}

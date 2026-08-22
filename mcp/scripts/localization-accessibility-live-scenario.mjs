#!/usr/bin/env node
/** Real stdio/editor lifecycle for localization, localized GUI binding, accessibility semantics, strict guards, and cleanup. */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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

async function optionalRead(path) {
	try {
		return await readFile(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function inspect() {
	return call("list_localization_tables");
}

async function author(name, args) {
	const current = await inspect();
	return call(name, { expectedRevision: current.revision, expectedFingerprint: current.fingerprint, ...args });
}

const required = [
	"list_localization_tables",
	"upsert_localization_locale",
	"create_localization_table",
	"set_localization_entry",
	"resolve_localization_entry",
	"pseudo_localize_entry",
	"create_localized_asset_table",
	"set_localized_asset_entry",
	"resolve_localized_asset",
	"preload_localized_assets",
	"validate_localization",
	"set_gui_localization_binding",
	"set_gui_accessibility_settings",
	"set_gui_accessibility_node",
	"inspect_gui_accessibility_hierarchy",
	"invoke_gui_accessibility_action",
	"announce_gui_accessibility",
	"validate_gui_accessibility",
];
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-8);
const localeId = `qaa-${suffix}`;
const stringTable = `MCP Live Strings ${suffix}`;
const assetTable = `MCP Live Assets ${suffix}`;
const guiPath = `mcp-localization-${suffix}.gui`;
let localizationPath;
let baseline;
let guiAbsolutePath;
let guiId;
let guiRevision;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "localization-accessibility-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) {
		const tool = listed.result?.tools?.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the localization/accessibility live scenario.");
	const projectDirectory = dirname(status.projectPath);
	localizationPath = join(projectDirectory, "localization.json");
	guiAbsolutePath = join(projectDirectory, guiPath);
	baseline = await optionalRead(localizationPath);

	const initial = await inspect();
	const defaultLocale = initial.defaultLocale;
	await author("upsert_localization_locale", {
		locale: { id: localeId, name: `MCP Live ${suffix}`, direction: "rtl", fallbackLocales: [defaultLocale], pseudo: null },
	});
	await author("create_localization_table", { name: stringTable, fallbackLocale: defaultLocale, fallbackLocales: [], preload: false });
	const beforeString = await inspect();
	await call("set_localization_entry", {
		expectedRevision: beforeString.revision,
		expectedFingerprint: beforeString.fingerprint,
		name: stringTable,
		key: "items",
		locale: defaultLocale,
		value: "{count:plural:one item|# items}",
		smart: true,
	});
	await call(
		"set_localization_entry",
		{ expectedRevision: beforeString.revision, expectedFingerprint: beforeString.fingerprint, name: stringTable, key: "stale", locale: defaultLocale, value: "stale" },
		true
	);
	const resolved = await call("resolve_localization_entry", { name: stringTable, key: "items", locale: localeId, arguments: { count: 2 } });
	if (resolved.value !== "2 items" || resolved.resolvedLocale !== defaultLocale || resolved.direction !== "rtl")
		throw new Error("Smart String fallback/direction evidence was incorrect.");
	const pseudo = await call("pseudo_localize_entry", {
		name: stringTable,
		key: "items",
		locale: defaultLocale,
		arguments: { count: 2 },
		expansionPercent: 50,
		accent: true,
		wrap: true,
		mirror: true,
	});
	if (!pseudo.pseudoLocalized || !pseudo.value.includes("2 ïtëms")) throw new Error("Pseudo-localization evidence was incomplete.");

	await author("create_localized_asset_table", { name: assetTable, fallbackLocale: defaultLocale, fallbackLocales: [], preload: true });
	await author("set_localized_asset_entry", {
		name: assetTable,
		key: "project",
		locale: defaultLocale,
		asset: { path: basename(status.projectPath), type: "binary" },
	});
	const asset = await call("resolve_localized_asset", { name: assetTable, key: "project", locale: localeId });
	if (!asset.exists || asset.resolvedLocale !== defaultLocale) throw new Error("Localized asset fallback/existence evidence was incorrect.");
	const preload = await call("preload_localized_assets", { locale: localeId });
	if (preload.assetCount < 1 || preload.byteCount < 1) throw new Error("Localized asset preload did not produce byte evidence.");
	const validation = await call("validate_localization", { sampleArguments: { count: 2 } });
	if (validation.errorCount !== 0) throw new Error(`Localization validation reported errors: ${JSON.stringify(validation.issues)}`);

	await call("create_gui_asset", { path: guiPath, name: `MCP Localized GUI ${suffix}` });
	const instantiated = await call("instantiate_gui_asset", { path: guiPath });
	guiId = instantiated.id;
	let gui = await call("get_gui_authoring", { guiId, offset: 0, limit: 50 });
	let result = await call("create_gui_control", {
		guiId,
		expectedRevision: gui.authoring.revision,
		controlId: "localized-title",
		parentControlId: null,
		type: "text",
		properties: { name: "Localized Title", text: "Original", width: "480px", height: "64px", fontSize: 24, color: "#ffffff", background: "#000000" },
	});
	guiRevision = result.revision;
	result = await call("create_gui_control", {
		guiId,
		expectedRevision: guiRevision,
		controlId: "accessible-play",
		parentControlId: null,
		type: "button",
		properties: { name: "Play", text: "Play", width: "160px", height: "64px" },
	});
	guiRevision = result.revision;
	result = await call("set_gui_localization_binding", {
		guiId,
		expectedRevision: guiRevision,
		binding: {
			controlId: "localized-title",
			property: "text",
			table: stringTable,
			key: "items",
			localeOverride: defaultLocale,
			arguments: { count: 2 },
			isolateBidirectionalText: true,
			mirrorHorizontalAlignment: true,
		},
	});
	guiRevision = result.revision;
	result = await call("set_gui_accessibility_settings", {
		guiId,
		expectedRevision: guiRevision,
		settings: { enabled: true, autoExposeText: true, textScale: 1.1, boldText: false, captionsEnabled: true, usePlatformPreferences: false },
	});
	guiRevision = result.revision;
	result = await call("set_gui_accessibility_node", {
		guiId,
		expectedRevision: guiRevision,
		node: {
			controlId: "accessible-play",
			role: "button",
			label: "Play",
			hint: "Start the game",
			value: "",
			focusOrder: 0,
			allowsDirectInteraction: false,
			actions: ["activate"],
			live: "off",
		},
	});
	guiRevision = result.revision;
	const hierarchy = await call("inspect_gui_accessibility_hierarchy", { guiId, offset: 0, limit: 50 });
	if (!hierarchy.runtime?.enabled || hierarchy.runtime.nodeCount < 2 || !hierarchy.hierarchy.items.some((item) => item.semantic?.controlId === "accessible-play"))
		throw new Error("Live semantic hierarchy evidence was incomplete.");
	await call("invoke_gui_accessibility_action", { guiId, expectedRevision: guiRevision, controlId: "accessible-play", action: "activate" });
	await call("announce_gui_accessibility", { guiId, expectedRevision: guiRevision, message: "Localization ready", priority: "polite" });
	const audit = await call("validate_gui_accessibility", { guiId });
	if (audit.errorCount !== 0) throw new Error(`GUI accessibility audit reported errors: ${JSON.stringify(audit.issues)}`);

	await call("delete_gui_instance", { guiId, expectedRevision: guiRevision, confirm: true });
	guiId = undefined;
	await rm(guiAbsolutePath, { force: true });
	guiAbsolutePath = undefined;
	if (baseline === null) await rm(localizationPath, { force: true });
	else await writeFile(localizationPath, baseline);
	await inspect();
	console.log(
		"[localization-accessibility-live] PASS — strict leases, locale fallback/direction, Smart Strings, pseudo-localization, localized assets/preload, GUI bindings, semantic actions, visual audit, and cleanup verified."
	);
} catch (error) {
	console.error(`[localization-accessibility-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (guiId && guiRevision !== undefined) await call("delete_gui_instance", { guiId, expectedRevision: guiRevision, confirm: true });
		if (guiAbsolutePath) await rm(guiAbsolutePath, { force: true });
		if (localizationPath && baseline !== undefined) {
			if (baseline === null) await rm(localizationPath, { force: true });
			else await writeFile(localizationPath, baseline);
			await inspect().catch(() => undefined);
		}
	} catch (cleanupError) {
		console.error(`[localization-accessibility-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

#!/usr/bin/env node
/** Positive live lifecycle for remaining raw-content and delete/focus GUI operations. */
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

function rpc(method, params = {}, timeoutMs = 120_000) {
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
const path = `assets/mcp-gui-remaining-${suffix}.gui`;
const localizationTable = `mcp-gui-${suffix}`;
let guiId = null;
let revision = null;
let localizationCreated = false;

async function cleanup() {
	if (guiId !== null && revision !== null) {
		await call("delete_gui_instance", { guiId, expectedRevision: revision, confirm: true }).catch(async () => {
			const current = await call("get_gui_authoring", { guiId, offset: 0, limit: 1 }).catch(() => null);
			if (current) await call("delete_gui_instance", { guiId, expectedRevision: current.authoring.revision, confirm: true }).catch(() => undefined);
		});
		guiId = null;
		revision = null;
	}
	await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	if (localizationCreated) {
		const current = await call("list_localization_tables").catch(() => null);
		if (current?.tables?.some((table) => table.name === localizationTable)) {
			await call("delete_localization_table", {
				expectedRevision: current.revision,
				expectedFingerprint: current.fingerprint,
				name: localizationTable,
				confirm: true,
			}).catch(() => undefined);
		}
		localizationCreated = false;
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gui-remaining-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.activeScenePath) throw new Error("A ready editor with an active scene is required.");
	let localization = await call("list_localization_tables");
	const localizationDefaultLocale = localization.defaultLocale;
	localization = await call("create_localization_table", {
		expectedRevision: localization.revision,
		expectedFingerprint: localization.fingerprint,
		name: localizationTable,
		fallbackLocale: localizationDefaultLocale,
		fallbackLocales: [],
		preload: false,
	});
	localizationCreated = true;
	localization = await call("set_localization_entry", {
		expectedRevision: localization.revision,
		expectedFingerprint: localization.fingerprint,
		name: localizationTable,
		key: "title",
		locale: localizationDefaultLocale,
		value: "MCP Live Title",
		smart: false,
	});
	await call("create_gui_asset", { path, name: `MCP GUI Remaining ${suffix}` });
	const instantiated = await call("instantiate_gui_asset", { path });
	guiId = instantiated.id;
	const raw = await call("get_gui_content", { guiId });
	if (!raw.content || raw.id !== guiId) throw new Error(`Raw GUI content evidence is incomplete: ${JSON.stringify(raw)}`);
	let result = await call("set_gui_content", { guiId, name: `MCP GUI Raw Round Trip ${suffix}`, content: raw.content });
	revision = result.revision;
	if (result.name !== `MCP GUI Raw Round Trip ${suffix}` || result.controlCount !== 0) throw new Error(`Raw GUI content round-trip failed: ${JSON.stringify(result)}`);
	result = await call("create_gui_control", {
		guiId,
		expectedRevision: revision,
		controlId: "live-title",
		parentControlId: null,
		type: "text",
		properties: { name: "Live Title", text: "Original", width: "480px", height: "64px", fontSize: 24 },
	});
	revision = result.revision;
	result = await call("create_gui_control", {
		guiId,
		expectedRevision: revision,
		controlId: "live-button",
		parentControlId: null,
		type: "button",
		properties: { name: "Live Button", text: "Play", width: "180px", height: "64px" },
	});
	revision = result.revision;
	result = await call("set_gui_localization_binding", {
		guiId,
		expectedRevision: revision,
		binding: {
			controlId: "live-title",
			property: "text",
			table: localizationTable,
			key: "title",
			localeOverride: null,
			arguments: {},
			isolateBidirectionalText: true,
			mirrorHorizontalAlignment: true,
		},
	});
	revision = result.revision;
	result = await call("delete_gui_localization_binding", { guiId, expectedRevision: revision, controlId: "live-title", property: "text", confirm: true });
	revision = result.revision;
	if (result.deletedControlId !== "live-title") throw new Error("GUI localization binding deletion evidence is incomplete.");
	localization = await call("list_localization_tables");
	localization = await call("delete_localization_entry", {
		expectedRevision: localization.revision,
		expectedFingerprint: localization.fingerprint,
		name: localizationTable,
		key: "title",
		locale: localizationDefaultLocale,
		confirm: true,
	});
	result = await call("set_gui_accessibility_settings", { guiId, expectedRevision: revision, settings: { enabled: true, autoExposeText: true } });
	revision = result.revision;
	result = await call("set_gui_accessibility_node", {
		guiId,
		expectedRevision: revision,
		node: {
			controlId: "live-button",
			role: "button",
			label: "Play",
			hint: "Start",
			value: "",
			focusOrder: 0,
			allowsDirectInteraction: false,
			actions: ["activate"],
			live: "off",
		},
	});
	revision = result.revision;
	const focused = await call("focus_gui_accessibility_node", { guiId, expectedRevision: revision, controlId: "live-button" });
	if (focused.focusedControlId !== "live-button") throw new Error(`GUI accessibility focus failed: ${JSON.stringify(focused)}`);
	result = await call("delete_gui_accessibility_node", { guiId, expectedRevision: revision, controlId: "live-button", confirm: true });
	revision = result.revision;
	if (result.deletedControlId !== "live-button") throw new Error("GUI accessibility-node deletion evidence is incomplete.");
	result = await call("set_gui_attribute_override", { guiId, expectedRevision: revision, override: { controlId: "live-button", property: "alpha", value: 0.75 } });
	revision = result.revision;
	result = await call("delete_gui_attribute_override", { guiId, expectedRevision: revision, controlId: "live-button", property: "alpha", confirm: true });
	revision = result.revision;
	if (result.deleted?.value !== 0.75) throw new Error(`GUI attribute-override deletion evidence is incomplete: ${JSON.stringify(result)}`);
	result = await call("set_gui_animation", {
		guiId,
		expectedRevision: revision,
		animation: {
			id: "live-pulse",
			controlId: "live-button",
			property: "alpha",
			from: 0.25,
			to: 1,
			durationMs: 400,
			delayMs: 0,
			easing: "easeInOut",
			loop: true,
			autoplay: false,
		},
	});
	revision = result.revision;
	result = await call("delete_gui_animation", { guiId, expectedRevision: revision, animationId: "live-pulse", confirm: true });
	revision = result.revision;
	if (result.deleted?.id !== "live-pulse") throw new Error(`GUI animation deletion evidence is incomplete: ${JSON.stringify(result)}`);
	localization = await call("delete_localization_table", {
		expectedRevision: localization.revision,
		expectedFingerprint: localization.fingerprint,
		name: localizationTable,
		confirm: true,
	});
	localizationCreated = false;
	await cleanup();
	console.log(
		"[gui-remaining-live] PASS — raw content get/set, localization delete, accessibility focus/delete, attribute-override delete, animation delete, and MCP-only cleanup verified."
	);
} catch (error) {
	console.error(`[gui-remaining-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

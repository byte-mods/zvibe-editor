#!/usr/bin/env node
/** Positive live lifecycle for remaining locale/table/settings/localized-asset operations. */
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
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
const stringTable = `mcp-loc-strings-${suffix}`;
const assetTable = `mcp-loc-assets-${suffix}`;
let localeId = null;
let baselineDefaultLocale = null;

async function inspect() {
	return call("list_localization_tables");
}

async function cleanup() {
	let current = await inspect().catch(() => null);
	if (!current) return;
	if (baselineDefaultLocale && current.defaultLocale !== baselineDefaultLocale && current.locales.some((locale) => locale.id === baselineDefaultLocale)) {
		current = await call("set_localization_settings", {
			expectedRevision: current.revision,
			expectedFingerprint: current.fingerprint,
			defaultLocale: baselineDefaultLocale,
		}).catch(() => current);
	}
	if (current.tables?.some((table) => table.name === stringTable)) {
		await call("delete_localization_table", { expectedRevision: current.revision, expectedFingerprint: current.fingerprint, name: stringTable, confirm: true }).catch(
			() => undefined
		);
		current = await inspect().catch(() => current);
	}
	if (current.assetTables?.some((table) => table.name === assetTable)) {
		await call("delete_localized_asset_table", { expectedRevision: current.revision, expectedFingerprint: current.fingerprint, name: assetTable, confirm: true }).catch(
			() => undefined
		);
		current = await inspect().catch(() => current);
	}
	if (localeId && current.locales?.some((locale) => locale.id === localeId) && current.defaultLocale !== localeId) {
		await call("delete_localization_locale", { expectedRevision: current.revision, expectedFingerprint: current.fingerprint, locale: localeId, confirm: true }).catch(
			() => undefined
		);
	}
}

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "localization-remaining-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required.");
	let current = await inspect();
	baselineDefaultLocale = current.defaultLocale;
	localeId = ["eo", "ga", "cy", "is"].find((candidate) => !current.locales.some((locale) => locale.id === candidate));
	if (!localeId) throw new Error("No disposable locale candidate is available.");
	current = await call("upsert_localization_locale", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		locale: { id: localeId, name: `MCP ${localeId.toUpperCase()}`, direction: "ltr", fallbackLocales: [baselineDefaultLocale], pseudo: null },
	});
	if (current.locale?.id !== localeId) throw new Error(`Locale upsert failed: ${JSON.stringify(current)}`);
	current = await call("set_localization_settings", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		defaultLocale: localeId,
	});
	if (current.defaultLocale !== localeId) throw new Error(`Default locale switch failed: ${JSON.stringify(current)}`);
	current = await call("set_localization_settings", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		defaultLocale: baselineDefaultLocale,
	});
	current = await call("create_localization_table", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: stringTable,
		fallbackLocale: baselineDefaultLocale,
		fallbackLocales: [localeId],
		preload: false,
	});
	current = await call("set_localization_table_settings", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: stringTable,
		fallbackLocale: baselineDefaultLocale,
		fallbackLocales: [localeId],
		preload: true,
	});
	if (!current.table?.preload) throw new Error(`String-table settings were not applied: ${JSON.stringify(current)}`);
	current = await call("create_localized_asset_table", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: assetTable,
		fallbackLocale: baselineDefaultLocale,
		fallbackLocales: [localeId],
		preload: false,
	});
	current = await call("set_localized_asset_table_settings", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: assetTable,
		fallbackLocale: baselineDefaultLocale,
		fallbackLocales: [localeId],
		preload: true,
	});
	if (!current.table?.preload) throw new Error(`Localized-asset table settings were not applied: ${JSON.stringify(current)}`);
	current = await call("set_localized_asset_entry", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: assetTable,
		key: "project",
		locale: baselineDefaultLocale,
		asset: { path: basename(status.projectPath), type: "binary" },
	});
	if (current.asset?.path !== basename(status.projectPath)) throw new Error(`Localized-asset entry was not applied: ${JSON.stringify(current)}`);
	current = await call("delete_localized_asset_entry", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: assetTable,
		key: "project",
		locale: baselineDefaultLocale,
		confirm: true,
	});
	if (!current.deleted) throw new Error("Localized-asset entry deletion did not return evidence.");
	current = await call("delete_localized_asset_table", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: assetTable,
		confirm: true,
	});
	if (!current.deleted) throw new Error("Localized-asset table deletion did not return evidence.");
	current = await inspect();
	current = await call("delete_localization_table", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		name: stringTable,
		confirm: true,
	});
	current = await inspect();
	current = await call("delete_localization_locale", {
		expectedRevision: current.revision,
		expectedFingerprint: current.fingerprint,
		locale: localeId,
		confirm: true,
	});
	if (!current.deleted) throw new Error("Localization locale deletion did not return evidence.");
	const final = await inspect();
	if (final.defaultLocale !== baselineDefaultLocale || final.locales.some((locale) => locale.id === localeId))
		throw new Error("Localization cleanup did not restore the baseline default/locale set.");
	console.log(
		"[localization-remaining-live] PASS — locale upsert/default/restore/delete, string-table settings, localized-asset table/settings/entry/delete, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[localization-remaining-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

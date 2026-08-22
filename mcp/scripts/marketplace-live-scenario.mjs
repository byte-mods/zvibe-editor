#!/usr/bin/env node
/** Positive live lifecycle for the visible Marketplace open/search/download tools. */
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

function rpc(method, params = {}, timeoutMs = 600_000) {
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
const textureSnapshotAgent = `marketplace-textures-${suffix}.js`;
const textureCleanupAgent = `marketplace-cleanup-${suffix}.js`;
let downloadedPath = null;
let baselineMaterialIds = [];
let baselineTextureUniqueIds = [];

async function cleanup() {
	try {
		const currentMaterials = await call("list_materials");
		for (const material of currentMaterials.materials ?? currentMaterials) {
			if (!baselineMaterialIds.includes(material.id)) await call("delete_material", { materialId: material.id }).catch(() => undefined);
		}
	} catch {
		// A download may fail before material conversion.
	}
	if (baselineTextureUniqueIds.length) {
		await call("run_agent_script", {
			name: textureCleanupAgent,
			content: `
export function main(editor) {
	const keep = new Set(${JSON.stringify(baselineTextureUniqueIds)});
	let disposed = 0;
	for (const texture of [...editor.layout.preview.scene.textures]) {
		if (!keep.has(texture.uniqueId)) { texture.dispose(); disposed++; }
	}
	return JSON.stringify({ disposed });
}`,
		}).catch(() => undefined);
	}
	if (downloadedPath) {
		await call("delete_asset", { path: downloadedPath, confirm: true }).catch(() => undefined);
		downloadedPath = null;
	}
	for (const path of [`agentdata/${textureSnapshotAgent}`, `agentdata/${textureCleanupAgent}`]) await call("delete_asset", { path, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "marketplace-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.activeScenePath) throw new Error("A ready editor with an active scene is required.");
	const baselineDiagnostics = await call("get_scene_diagnostics");
	const baselineMaterials = await call("list_materials");
	baselineMaterialIds = (baselineMaterials.materials ?? baselineMaterials).map((material) => material.id);
	const textureSnapshot = await call("run_agent_script", {
		name: textureSnapshotAgent,
		content: "export function main(editor) { return JSON.stringify(editor.layout.preview.scene.textures.map((texture) => texture.uniqueId)); }",
	});
	baselineTextureUniqueIds = JSON.parse(textureSnapshot.result);

	const opened = await call("open_marketplace", { source: "polyhaven" });
	if (!opened.opened) throw new Error(`Marketplace tab did not open: ${JSON.stringify(opened)}`);
	let search = null;
	for (const query of ["stool", "barrel", "wood"]) {
		search = await call("search_marketplace", { source: "polyhaven", query, type: "mesh" });
		if (search.results?.length) break;
	}
	const asset = search?.results?.[0];
	if (!asset?.id || !asset?.name) throw new Error(`Poly Haven returned no downloadable model search evidence: ${JSON.stringify(search)}`);
	const downloaded = await call("download_marketplace_asset", { source: "polyhaven", assetId: asset.id, resolution: "1k" });
	downloadedPath = downloaded.downloadedPath;
	if (downloadedPath !== `assets/polyhaven/${asset.id}`) throw new Error(`Marketplace download returned an unexpected path: ${JSON.stringify(downloaded)}`);

	await cleanup();
	const finalDiagnostics = await call("get_scene_diagnostics");
	const finalMaterials = await call("list_materials");
	const finalMaterialIds = (finalMaterials.materials ?? finalMaterials).map((material) => material.id);
	if (
		finalDiagnostics.meshes !== baselineDiagnostics.meshes ||
		finalDiagnostics.materials !== baselineDiagnostics.materials ||
		JSON.stringify(finalMaterialIds) !== JSON.stringify(baselineMaterialIds)
	) {
		throw new Error(
			`Marketplace cleanup did not restore the live scene baseline: ${JSON.stringify({ baselineDiagnostics, finalDiagnostics, baselineMaterialIds, finalMaterialIds })}`
		);
	}
	console.log(
		`[marketplace-live] PASS — visible Poly Haven open/search/download completed for ${asset.id} (${asset.name}) at 1k, then MCP-only asset/material/texture cleanup restored the scene.`
	);
} catch (error) {
	console.error(`[marketplace-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-12).join("\n"));
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

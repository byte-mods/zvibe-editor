#!/usr/bin/env node
/** Real stdio/editor lifecycle for weighted 2D sprite rigging, bone painting, clip authoring, and cleanup. */
import { execFileSync, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
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

/** ImageMagick 7 (`magick`) or 6 (`convert`) from PATH; set MAGICK to an explicit binary to override. */
function imageMagickCommand() {
	for (const candidate of [process.env.MAGICK, "magick", "convert"].filter(Boolean)) {
		try {
			execFileSync(candidate, ["-version"], { stdio: "pipe" });
			return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error("ImageMagick is required to author the PSD fixture: install it (magick or convert on PATH) or set MAGICK.");
}
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

const required = [
	"list_sprite_skins",
	"get_sprite_skin",
	"open_sprite_skinning_workspace",
	"create_sprite_skin",
	"replace_sprite_skin_bones",
	"inspect_psd_sprite_skin_rig",
	"apply_psd_sprite_skin_rig",
	"create_sprite_skin_animation_clip",
];
const suffix = `${Date.now()}-${process.pid}`;
const name = `MCP Sprite Skin ${suffix}`;
const clipName = `MCP Sprite Clip ${suffix}`;
const psdSourcePath = `/tmp/mcp-sprite-rig-${suffix}.psd`;
const psdAssetPath = `assets/mcp-sprite-rig-${suffix}.psd`;
let nodeId;
let psdNodeId;
let clipCreated = false;
let initialMaterialIds = new Set();

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sprite-skinning-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of required) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the Sprite Skin live scenario.");
	initialMaterialIds = new Set((await call("list_materials")).materials.map((material) => material.id));
	execFileSync(imageMagickCommand(), ["-size", "64x64", "xc:#ef4444", psdSourcePath], { stdio: "pipe" });
	await call("import_asset", { sourcePath: psdSourcePath, destinationPath: psdAssetPath });
	const psdPlan = await call("inspect_psd_sprite_skin_rig", { sourcePath: psdAssetPath, pixelsPerUnit: 100, columns: 2, rows: 2 });
	if (!/^[a-f0-9]{64}$/.test(psdPlan.fingerprint) || !psdPlan.bones?.length) throw new Error(`PSD sprite-rig inspection evidence is incomplete: ${JSON.stringify(psdPlan)}`);
	const appliedPsd = await call("apply_psd_sprite_skin_rig", {
		sourcePath: psdAssetPath,
		pixelsPerUnit: 100,
		columns: 2,
		rows: 2,
		name: `MCP PSD Sprite Rig ${suffix}`,
		expectedFingerprint: psdPlan.fingerprint,
	});
	psdNodeId = appliedPsd.node.id;
	if (!psdNodeId || appliedPsd.skeleton?.boneCount < 1) throw new Error("PSD sprite rig did not create a weighted mesh and skeleton.");
	const created = await call("create_sprite_skin", {
		name,
		documentWidthPixels: 128,
		documentHeightPixels: 64,
		pixelsPerUnit: 100,
		columns: 4,
		rows: 2,
		bones: [
			{ id: "root", name: "Root", parentId: null, position: [-50, 0], rotationDegrees: 0, length: 50, sourceLayerIndex: null },
			{ id: "arm", name: "Arm", parentId: "root", position: [50, 0], rotationDegrees: 0, length: 50, sourceLayerIndex: null },
		],
	});
	nodeId = created.node.id;
	if (created.vertexCount !== 15 || created.triangleCount !== 16 || created.skeleton?.boneCount !== 2)
		throw new Error("Weighted sprite topology or skeleton evidence is incorrect.");
	const listed = await call("list_sprite_skins");
	if (!listed.spriteSkins.some((skin) => skin.node.id === nodeId)) throw new Error("Created weighted sprite was not listed.");
	await call("open_sprite_skinning_workspace", { nodeId });

	const weights = await call("get_mesh_skin_weights", { nodeId, limit: 15 });
	if (!weights.report?.valid || weights.report?.vertexCount !== 15) throw new Error("Initial sprite skin weights are not normalized and valid.");
	const painted = await call("paint_mesh_skin_weights", {
		nodeId,
		expectedFingerprint: weights.fingerprint,
		boneName: "Arm",
		vertexIndices: [0, 1],
		mode: "replace",
		weight: 1,
	});
	if (painted.changedVertexCount !== 2) throw new Error("Fine sprite bone painting did not update both vertices.");

	let rig = await call("get_sprite_skin", { nodeId });
	rig = await call("replace_sprite_skin_bones", {
		nodeId,
		expectedRevision: rig.definition.revision,
		expectedFingerprint: rig.fingerprint,
		bones: [
			{ id: "root-v2", name: "Root", parentId: null, position: [-48, 0], rotationDegrees: 0, length: 48, sourceLayerIndex: null },
			{ id: "arm-v2", name: "Arm", parentId: "root-v2", position: [48, 0], rotationDegrees: 0, length: 52, sourceLayerIndex: null },
		],
	});
	if (rig.definition.revision !== 2 || rig.skeleton?.boneCount !== 2) throw new Error("Exact-leased sprite hierarchy replacement did not publish revision 2.");

	const clip = await call("create_sprite_skin_animation_clip", {
		nodeId,
		expectedRevision: rig.definition.revision,
		expectedFingerprint: rig.fingerprint,
		name: clipName,
		framesPerSecond: 30,
		tracks: [
			{
				boneName: "Root",
				property: "rotation",
				keys: [
					{ frame: 0, value: -5 },
					{ frame: 15, value: 5 },
				],
			},
			{
				boneName: "Arm",
				property: "position",
				keys: [
					{ frame: 0, value: [48, 0] },
					{ frame: 15, value: [48, 3] },
				],
			},
		],
	});
	clipCreated = true;
	if (clip.trackCount !== 2 || clip.framesPerSecond !== 30) throw new Error("2D bone clip evidence is incomplete.");

	await call("delete_animation_group", { name: clipName });
	clipCreated = false;
	await call("delete_node", { nodeId });
	nodeId = undefined;
	await call("delete_node", { nodeId: psdNodeId });
	psdNodeId = undefined;
	await call("delete_asset", { path: psdAssetPath, confirm: true });
	await rm(psdSourcePath, { force: true });
	const currentMaterials = (await call("list_materials")).materials;
	for (const material of currentMaterials.filter((candidate) => !initialMaterialIds.has(candidate.id))) await call("delete_material", { materialId: material.id });

	console.log(
		"[sprite-skinning-live] PASS — 8/8 dedicated tools, real weighted mesh/skeleton creation, exact inspection, bone painting, leased hierarchy replacement, planar clip authoring, visible workspace opening, and cleanup verified."
	);
} catch (error) {
	console.error(`[sprite-skinning-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (clipCreated) await call("delete_animation_group", { name: clipName });
		if (nodeId) await call("delete_node", { nodeId });
		if (psdNodeId) await call("delete_node", { nodeId: psdNodeId });
		await call("delete_asset", { path: psdAssetPath, confirm: true }).catch(() => undefined);
		await rm(psdSourcePath, { force: true });
		const currentMaterials = (await call("list_materials")).materials;
		for (const material of currentMaterials.filter((candidate) => !initialMaterialIds.has(candidate.id))) await call("delete_material", { materialId: material.id });
	} catch (cleanupError) {
		console.error(`[sprite-skinning-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

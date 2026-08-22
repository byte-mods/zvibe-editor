#!/usr/bin/env node
/** Positive real-editor lifecycle for every previously uncovered Assets MCP tool. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

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

function rpc(method, params, timeoutMs = 300_000) {
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

async function callRaw(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	return result;
}

async function call(name, args = {}) {
	const result = await callRaw(name, args);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"validate_asset_importer_settings",
	"get_texture_importer_result",
	"apply_texture_importer",
	"inspect_psd_layer_extraction",
	"extract_psd_layers",
	"inspect_psd_smart_object_payload_replacement",
	"replace_psd_smart_object_payloads",
	"get_texture_platform_overrides",
	"set_texture_platform_overrides",
	"get_audio_importer_result",
	"apply_audio_importer",
	"get_material_importer_result",
	"apply_material_importer",
	"get_model_importer_result",
	"set_model_rig_optimization",
	"get_model_animation_clips",
	"set_model_animation_clips",
	"get_model_material_remaps",
	"set_model_material_remaps",
	"get_model_material_search",
	"set_model_material_search",
	"get_model_platform_overrides",
	"set_model_platform_overrides",
	"inspect_model_material_extraction",
	"extract_model_materials",
	"inspect_model_texture_extraction",
	"extract_model_textures",
	"get_model_authored_lods",
	"set_model_authored_lods",
	"get_model_generated_lods",
	"set_model_generated_lods",
	"apply_model_importer",
	"start_asset_indexing",
	"cancel_asset_indexing",
	"rebuild_asset_registry",
	"refresh_watched_assets",
	"set_auto_reimport_settings",
	"run_auto_reimport",
	"get_asset_dependencies",
	"get_asset_dependency_graph",
	"export_asset_dependency_graph",
	"open_asset_dependency_graph",
	"rebuild_asset_dependency_index",
	"get_asset_by_guid",
	"get_asset_details",
	"get_asset_preview",
	"convert_image_asset",
	"set_asset_organization",
	"get_asset_import_status",
	"refresh_asset_import_states",
	"set_asset_importer_preset",
	"apply_asset_importer_preset",
	"delete_asset_importer_preset",
	"reimport_asset",
	"instantiate_mesh_asset",
	"create_asset_folder",
	"inspect_asset_move",
	"apply_asset_move",
	"move_asset",
];

function u16(value) {
	const result = Buffer.alloc(2);
	result.writeUInt16BE(value & 0xffff);
	return result;
}
function i16(value) {
	const result = Buffer.alloc(2);
	result.writeInt16BE(value);
	return result;
}
function u32(value) {
	const result = Buffer.alloc(4);
	result.writeUInt32BE(value >>> 0);
	return result;
}
function u64(value) {
	const result = Buffer.alloc(8);
	result.writeBigUInt64BE(BigInt(value));
	return result;
}
function i32(value) {
	const result = Buffer.alloc(4);
	result.writeInt32BE(value);
	return result;
}
function linkedUnicode(value) {
	const text = `${value}\0`;
	const result = Buffer.alloc(4 + text.length * 2);
	result.writeUInt32BE(text.length);
	for (let index = 0; index < text.length; ++index) result.writeUInt16BE(text.charCodeAt(index), 4 + index * 2);
	return result;
}
function linkedResourceRecord(id, name, data) {
	const body = Buffer.concat([
		Buffer.from("liFD"),
		i32(2),
		Buffer.from([id.length]),
		Buffer.from(id, "ascii"),
		linkedUnicode(name),
		Buffer.from("8BPS"),
		Buffer.alloc(4),
		u64(data.length),
		Buffer.from([0]),
		data,
	]);
	return Buffer.concat([u64(body.length), body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
}
function globalAdditional(key, data) {
	return Buffer.concat([Buffer.from("8BIM"), Buffer.from(key), u32(data.length), data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
}
function pascal(value) {
	const data = Buffer.from(value, "ascii");
	return Buffer.concat([Buffer.from([data.length]), data, Buffer.alloc((4 - ((data.length + 1) % 4)) % 4)]);
}
function unicodeName(value) {
	const data = Buffer.alloc(4 + value.length * 2);
	data.writeUInt32BE(value.length);
	for (let index = 0; index < value.length; ++index) data.writeUInt16BE(value.charCodeAt(index), 4 + index * 2);
	return data;
}
function additional(key, data) {
	return Buffer.concat([Buffer.from("8BIM"), Buffer.from(key), u32(data.length), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function pixelLayer(name, id, rgba) {
	const channelEntries = [0, 1, 2, -1].map((channelId, channel) => ({ channelId, plane: Buffer.from([rgba[channel]]) }));
	const data = channelEntries.map((channel) => Buffer.concat([u16(0), channel.plane]));
	const extra = Buffer.concat([u32(0), u32(0), pascal(name), additional("luni", unicodeName(name)), additional("lyid", u32(id))]);
	return {
		record: Buffer.concat([
			i32(0),
			i32(0),
			i32(1),
			i32(1),
			u16(channelEntries.length),
			...channelEntries.map((channel, index) => Buffer.concat([i16(channel.channelId), u32(data[index].length)])),
			Buffer.from("8BIMnorm"),
			Buffer.from([255, 0, 0, 0]),
			u32(extra.length),
			extra,
		]),
		data: Buffer.concat(data),
	};
}
function createPsd(width, height, layers = [], globalBlocks = Buffer.alloc(0)) {
	let layerInfo = Buffer.concat([i16(layers.length), ...layers.map((entry) => entry.record), ...layers.map((entry) => entry.data)]);
	if (layerInfo.length & 1) layerInfo = Buffer.concat([layerInfo, Buffer.alloc(1)]);
	const layerAndMask = Buffer.concat([u32(layerInfo.length), layerInfo, u32(0), globalBlocks]);
	const header = Buffer.alloc(26);
	header.write("8BPS", 0, "ascii");
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(3, 12);
	header.writeUInt32BE(height, 14);
	header.writeUInt32BE(width, 18);
	header.writeUInt16BE(8, 22);
	header.writeUInt16BE(3, 24);
	return Buffer.concat([header, u32(0), u32(0), u32(layerAndMask.length), layerAndMask, u16(0), Buffer.alloc(width * height * 3)]);
}
function makeWav(sampleRate = 22050, seconds = 0.08) {
	const frames = Math.round(sampleRate * seconds);
	const data = Buffer.alloc(frames * 2);
	for (let frame = 0; frame < frames; ++frame) data.writeInt16LE(Math.round(Math.sin((frame / sampleRate) * Math.PI * 2 * 440) * 8000), frame * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}
function triangleGltf(imageBase64) {
	const binary = Buffer.alloc(66);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4));
	[0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
	[0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 60 + index * 2));
	return {
		asset: { version: "2.0" },
		buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
			{ buffer: 0, byteOffset: 36, byteLength: 24, target: 34962 },
			{ buffer: 0, byteOffset: 60, byteLength: 6, target: 34963 },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
			{ bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
			{ bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
		],
		images: [{ uri: `data:image/png;base64,${imageBase64}` }],
		textures: [{ source: 0 }],
		materials: [{ name: "MCP Embedded", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
		meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
		nodes: [{ name: "TriangleRoot", mesh: 0 }],
		scenes: [{ nodes: [0] }],
		scene: 0,
	};
}

const suffix = `${Date.now()}-${process.pid}`;
const folder = `assets/mcp-assets-${suffix}`;
const paths = {
	texture: `${folder}/pixel.png`,
	audio: `${folder}/tone.wav`,
	model: `${folder}/triangle.gltf`,
	psd: `${folder}/layers.psd`,
	smartPsd: `${folder}/smart.psd`,
	smartOutput: `${folder}/smart-replaced.psd`,
	bitmap: `${folder}/pixel.rgba`,
	moveA: `${folder}/move-a.png`,
	moveAResult: `${folder}/moved/move-a.png`,
	moveB: `${folder}/move-b.png`,
	moveBResult: `${folder}/moved/move-b.png`,
	createdFolder: `${folder}/created`,
};
const temp = await mkdtemp(join(tmpdir(), "babylon-assets-live-"));
const sources = {
	texture: join(temp, "pixel.png"),
	audio: join(temp, "tone.wav"),
	model: join(temp, "triangle.gltf"),
	psd: join(temp, "layers.psd"),
	smartPsd: join(temp, "smart.psd"),
	replacement: join(temp, "replacement.bin"),
	moveA: join(temp, "move-a.png"),
	moveB: join(temp, "move-b.png"),
};
const onePixelPng = await sharp(Buffer.from([255, 64, 32, 255, 32, 128, 255, 255, 32, 255, 128, 255, 255, 255, 32, 255]), {
	raw: { width: 2, height: 2, channels: 4 },
})
	.png()
	.toBuffer();
await Promise.all([
	writeFile(sources.texture, onePixelPng),
	writeFile(sources.audio, makeWav()),
	writeFile(sources.model, JSON.stringify(triangleGltf(onePixelPng.toString("base64")))),
	writeFile(sources.psd, createPsd(2, 2, [pixelLayer("MCP Pixel", 1001, [255, 64, 32, 255])])),
	writeFile(sources.smartPsd, createPsd(2, 2, [], globalAdditional("lnk2", linkedResourceRecord("mcp-smart", "payload.bin", Buffer.from("ORIGINAL"))))),
	writeFile(sources.replacement, Buffer.from("REPLACEMENT")),
	writeFile(sources.moveA, onePixelPng),
	writeFile(sources.moveB, onePixelPng),
]);

let material;
let instanceRootId;
let presetCreated = false;
let originalAutoReimport;

async function cleanup() {
	if (originalAutoReimport) {
		const current = await call("inspect_auto_reimport", {}).catch(() => undefined);
		if (current?.settingsFingerprint)
			await call("set_auto_reimport_settings", { expectedSettingsFingerprint: current.settingsFingerprint, settings: originalAutoReimport.settings }).catch(() => undefined);
	}
	if (presetCreated) await call("delete_asset_importer_preset", { name: `MCP Assets ${suffix}` }).catch(() => undefined);
	if (instanceRootId) await call("delete_node", { nodeId: instanceRootId, disposeMaterialAndTextures: true }).catch(() => undefined);
	if (material?.id) await call("delete_material", { materialId: material.id }).catch(() => undefined);
	for (const path of [folder]) await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	await rm(temp, { recursive: true, force: true });
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "assets-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Assets completion testing.");

	for (const [key, sourcePath] of Object.entries(sources)) {
		if (key === "replacement") continue;
		await call("import_asset", { sourcePath, destinationPath: paths[key] });
	}
	material = await call("create_material", { type: "standard", name: `MCP Asset Material ${suffix}`, folder });

	await call("validate_asset_importer_settings", { path: paths.texture, settings: { maxSize: 64, generateMipmaps: true } });
	let textureOverrides = await call("get_texture_platform_overrides", { path: paths.texture });
	await call("set_texture_platform_overrides", { path: paths.texture, expectedFingerprint: textureOverrides.fingerprint, overrides: {} });
	let texture = await call("get_texture_importer_result", { path: paths.texture });
	await call("apply_texture_importer", { path: paths.texture, expectedFingerprint: texture.fingerprint, confirm: true });

	const layerPlan = await call("inspect_psd_layer_extraction", { path: paths.psd, destinationFolder: `${folder}/psd-layers` });
	await call("extract_psd_layers", { path: paths.psd, destinationFolder: `${folder}/psd-layers`, expectedFingerprint: layerPlan.fingerprint, confirm: true });
	const replacementArgs = { path: paths.smartPsd, destinationPath: paths.smartOutput, replacements: [{ resourceIndex: 0, sourcePath: sources.replacement }] };
	const replacementPlan = await call("inspect_psd_smart_object_payload_replacement", replacementArgs);
	await call("replace_psd_smart_object_payloads", { ...replacementArgs, expectedFingerprint: replacementPlan.fingerprint, confirm: true });

	let audio = await call("get_audio_importer_result", { path: paths.audio });
	await call("apply_audio_importer", { path: paths.audio, expectedFingerprint: audio.fingerprint, confirm: true });
	let materialImport = await call("get_material_importer_result", { path: material.path });
	await call("apply_material_importer", { path: material.path, expectedFingerprint: materialImport.fingerprint, confirm: true });

	await call("set_model_rig_optimization", { path: paths.model, enabled: false, exposedTransforms: [] });
	let clips = await call("get_model_animation_clips", { path: paths.model });
	await call("set_model_animation_clips", { path: paths.model, expectedFingerprint: clips.fingerprint, clips: [] });
	let remaps = await call("get_model_material_remaps", { path: paths.model });
	await call("set_model_material_remaps", { path: paths.model, expectedFingerprint: remaps.fingerprint, remaps: [] });
	let search = await call("get_model_material_search", { path: paths.model });
	await call("set_model_material_search", { path: paths.model, expectedFingerprint: search.fingerprint, naming: "sourceMaterial", search: "none" });
	let modelOverrides = await call("get_model_platform_overrides", { path: paths.model });
	await call("set_model_platform_overrides", { path: paths.model, expectedFingerprint: modelOverrides.fingerprint, overrides: {} });
	let authored = await call("get_model_authored_lods", { path: paths.model });
	await call("set_model_authored_lods", { path: paths.model, expectedFingerprint: authored.fingerprint, groups: [] });
	let generated = await call("get_model_generated_lods", { path: paths.model });
	await call("set_model_generated_lods", { path: paths.model, expectedFingerprint: generated.fingerprint, levels: [] });
	let model = await call("get_model_importer_result", { path: paths.model });
	await call("apply_model_importer", { path: paths.model, expectedFingerprint: model.fingerprint, confirm: true });
	const materialExtraction = await call("inspect_model_material_extraction", { path: paths.model, destinationFolder: `${folder}/Materials` });
	await call("extract_model_materials", { path: paths.model, destinationFolder: `${folder}/Materials`, expectedFingerprint: materialExtraction.fingerprint, confirm: true });
	const textureExtraction = await call("inspect_model_texture_extraction", { path: paths.model, destinationFolder: `${folder}/Textures` });
	await call("extract_model_textures", { path: paths.model, destinationFolder: `${folder}/Textures`, expectedFingerprint: textureExtraction.fingerprint, confirm: true });

	const indexing = await call("start_asset_indexing", { mode: "rebuild", workerCount: 1 });
	if (!indexing.job?.id) throw new Error(`Asset indexing returned no job id: ${JSON.stringify(indexing)}`);
	await call("cancel_asset_indexing", { jobId: indexing.job.id });
	await call("rebuild_asset_registry", {});
	await call("refresh_watched_assets", {});
	originalAutoReimport = await call("inspect_auto_reimport", {});
	await call("set_auto_reimport_settings", { expectedSettingsFingerprint: originalAutoReimport.settingsFingerprint, settings: originalAutoReimport.settings });
	const autoPlan = await call("inspect_auto_reimport", { paths: [paths.texture], force: true });
	await call("run_auto_reimport", { paths: [paths.texture], force: true, expectedFingerprint: autoPlan.plan.fingerprint, confirm: true });

	await call("rebuild_asset_dependency_index", {});
	await call("get_asset_dependencies", { path: paths.model });
	await call("get_asset_dependency_graph", { path: paths.model, depth: 2 });
	const exported = await call("export_asset_dependency_graph", { path: paths.model, depth: 2, format: "mermaid" });
	if (!exported.content) throw new Error("Dependency graph export returned no content.");
	await call("open_asset_dependency_graph", { path: paths.model, depth: 2 });
	const registry = await call("query_asset_registry", { query: basename(paths.texture), limit: 20 });
	const registryEntry = registry.entries?.find((entry) => entry.path === paths.texture);
	if (!registryEntry?.guid) throw new Error("Texture registry entry has no stable GUID.");
	await call("get_asset_by_guid", { guid: registryEntry.guid });
	await call("get_asset_details", { path: paths.texture });
	const preview = await call("get_asset_preview", { path: paths.texture });
	if (!preview.content?.some((entry) => entry.type === "image")) throw new Error("Texture preview returned no image content.");
	await call("convert_image_asset", { sourcePath: paths.texture, outputPath: paths.bitmap, format: "bitmap" });
	await call("set_asset_organization", { paths: [paths.texture], tags: ["mcp-live"], favorite: true });
	await call("get_asset_import_status", { path: paths.texture });
	await call("refresh_asset_import_states", { paths: [paths.texture] });

	const presetName = `MCP Assets ${suffix}`;
	await call("set_asset_importer_preset", { name: presetName, kind: "texture", importer: { maxSize: 64 }, labels: ["mcp-live"], extensions: [".png"] });
	presetCreated = true;
	await call("apply_asset_importer_preset", { name: presetName, paths: [paths.texture] });
	await call("delete_asset_importer_preset", { name: presetName });
	presetCreated = false;
	await call("reimport_asset", { path: paths.texture });
	const instance = await call("instantiate_mesh_asset", { path: paths.model, name: `MCP Asset Triangle ${suffix}`, position: [0, 100, 0] });
	instanceRootId = instance.rootNodeId;
	if (!instanceRootId || !instance.createdNodes?.length) throw new Error("Mesh instantiation evidence is incomplete.");
	await call("create_asset_folder", { path: paths.createdFolder });

	await call("rebuild_asset_dependency_index", {});
	const movePlan = await call("inspect_asset_move", { sourcePath: paths.moveA, destinationPath: paths.moveAResult });
	await call("apply_asset_move", {
		sourcePath: paths.moveA,
		destinationPath: paths.moveAResult,
		expectedPlanFingerprint: movePlan.planFingerprint,
		updateReferences: true,
	});
	await call("move_asset", { sourcePath: paths.moveB, destinationPath: paths.moveBResult, updateReferences: true });

	console.log(`PASS Assets completion live scenario (${required.length}/${required.length} tools): ${required.join(", ")}`);
} finally {
	await cleanup().catch((error) => console.error(`Cleanup warning: ${error.message}`));
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim()) console.error(stderr.trim());
}

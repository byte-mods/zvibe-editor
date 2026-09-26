#!/usr/bin/env node
/** Real external-writer -> editor -> stdio MCP -> serialized scene lifecycle for portable Aseprite. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { connectEditorUi, waitForUi } from "./electron-ui-harness.mjs";

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

function rpc(method, params, timeoutMs = 180_000) {
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

async function callImage(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	if (response.error || response.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? response.result)}`);
	const image = response.result?.content?.find((entry) => entry.type === "image");
	if (!image?.data || !image.mimeType?.startsWith("image/")) throw new Error(`${name} did not return an image block.`);
	return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType };
}

async function safeCall(name, args = {}) {
	try {
		return await call(name, args);
	} catch {
		return null;
	}
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

async function waitFor(read, predicate, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

class Writer {
	#bytes = [];
	u8(value) {
		this.#bytes.push(value & 255);
		return this;
	}
	u16(value) {
		return this.u8(value).u8(value >>> 8);
	}
	i16(value) {
		return this.u16(value & 0xffff);
	}
	u32(value) {
		return this.u8(value)
			.u8(value >>> 8)
			.u8(value >>> 16)
			.u8(value >>> 24);
	}
	i32(value) {
		return this.u32(value >>> 0);
	}
	fixed(value) {
		return this.i32(Math.round(value * 65_536));
	}
	string(value) {
		const bytes = new TextEncoder().encode(value);
		return this.u16(bytes.byteLength).bytes(bytes);
	}
	bytes(value) {
		this.#bytes.push(...value);
		return this;
	}
	zeroes(count) {
		return this.bytes(new Uint8Array(count));
	}
	value() {
		return Uint8Array.from(this.#bytes);
	}
}

function chunk(type, content) {
	return new Writer()
		.u32(content.byteLength + 6)
		.u16(type)
		.bytes(content)
		.value();
}

function layer(name, options = {}) {
	const flags = (options.visible === false ? 0 : 1) | 2;
	return chunk(
		0x2004,
		new Writer()
			.u16(flags)
			.u16(options.type ?? 0)
			.u16(options.childLevel ?? 0)
			.u16(0)
			.u16(0)
			.u16(options.blendMode ?? 0)
			.u8(options.opacity ?? 255)
			.zeroes(3)
			.string(name)
			.value()
	);
}

function imageCel(layerIndex, x, y, width, height, pixels, compressed = false) {
	const encoded = compressed ? deflateSync(pixels) : pixels;
	return chunk(
		0x2005,
		new Writer()
			.u16(layerIndex)
			.i16(x)
			.i16(y)
			.u8(255)
			.u16(compressed ? 2 : 0)
			.i16(0)
			.zeroes(5)
			.u16(width)
			.u16(height)
			.bytes(encoded)
			.value()
	);
}

function linkedCel(layerIndex, frameIndex, x, y) {
	return chunk(0x2005, new Writer().u16(layerIndex).i16(x).i16(y).u8(255).u16(1).i16(0).zeroes(5).u16(frameIndex).value());
}

function userData(text) {
	return chunk(0x2020, new Writer().u32(1).string(text).value());
}

function tags() {
	return chunk(0x2018, new Writer().u16(1).zeroes(8).u16(0).u16(2).u8(2).u16(2).zeroes(6).bytes([20, 40, 60]).u8(0).string("Run").value());
}

function slice() {
	return chunk(0x2022, new Writer().u32(1).u32(3).u32(0).string("Body").u32(0).i32(0).i32(0).u32(4).u32(4).i32(1).i32(1).u32(2).u32(2).i32(1).i32(2).value());
}

function frame(chunks, durationMs) {
	const payloadBytes = chunks.reduce((sum, value) => sum + value.byteLength, 0);
	const payload = new Uint8Array(payloadBytes);
	let offset = 0;
	for (const value of chunks) {
		payload.set(value, offset);
		offset += value.byteLength;
	}
	return new Writer()
		.u32(payload.byteLength + 16)
		.u16(0xf1fa)
		.u16(chunks.length)
		.u16(durationMs)
		.zeroes(2)
		.u32(chunks.length)
		.bytes(payload)
		.value();
}

function solid(width, height, color) {
	const result = new Uint8Array(width * height * 4);
	for (let offset = 0; offset < result.length; offset += 4) result.set(color, offset);
	return result;
}

function complexAsepriteFixture() {
	const frames = [
		frame(
			[
				layer("Actor", { type: 1, opacity: 192 }),
				layer("Hero", { childLevel: 1 }),
				layer("Hidden FX", { visible: false, blendMode: 16 }),
				imageCel(1, 1, 1, 2, 2, solid(2, 2, [255, 20, 10, 255]), true),
				userData("spawn"),
				imageCel(2, 0, 0, 1, 1, solid(1, 1, [20, 255, 80, 200])),
				tags(),
				slice(),
			],
			80
		),
		frame([linkedCel(1, 0, 1, 1), userData("footstep"), imageCel(2, 3, 0, 1, 1, solid(1, 1, [20, 60, 255, 220]))], 120),
		frame([imageCel(1, 1, 1, 2, 2, solid(2, 2, [255, 220, 10, 255]), true), userData("impact")], 200),
	];
	const header = new Writer()
		.u32(0)
		.u16(0xa5e0)
		.u16(frames.length)
		.u16(4)
		.u16(4)
		.u16(32)
		.u32(3)
		.u16(100)
		.u32(0)
		.u32(0)
		.u8(0)
		.zeroes(3)
		.u16(256)
		.u8(1)
		.u8(1)
		.i16(0)
		.i16(0)
		.u16(16)
		.u16(16)
		.zeroes(84)
		.value();
	const size = header.byteLength + frames.reduce((sum, value) => sum + value.byteLength, 0);
	new DataView(header.buffer).setUint32(0, size, true);
	const result = new Uint8Array(size);
	result.set(header);
	let offset = header.byteLength;
	for (const value of frames) {
		result.set(value, offset);
		offset += value.byteLength;
	}
	return result;
}

const requiredTools = [
	"get_aseprite_capabilities",
	"inspect_aseprite_import",
	"apply_aseprite_import",
	"instantiate_aseprite_asset",
	"list_aseprite_instances",
	"get_aseprite_instance",
	"control_aseprite_animation",
	"delete_aseprite_instance",
	"open_asset_inspector",
];
const manifest = JSON.parse(await readFile(join(here, "..", "manifest.json"), "utf8"));
const packagedTools = manifest.server?.tools ?? manifest.tools;
if (!Array.isArray(packagedTools)) throw new Error("MCPB manifest does not contain a packaged tool catalog.");
const expectedToolCount = packagedTools.length;
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const retainFixtures = process.env.ASEPRITE_LIVE_RETAIN_FIXTURES === "1";
const assetPath = `assets/.mcp-aseprite-${suffix}.aseprite`;
const scenePath = `scenes/mcp-aseprite-${suffix}.scene`;
const instanceId = `mcp-aseprite-${suffix}`;
const instanceName = `Aseprite Complex ${suffix}`;
let projectDirectory = null;
let originalScenePath = null;
let sourceAbsolutePath = null;
let sceneCreated = false;
let assetRegistered = false;
let instanceCreated = false;
let completed = false;
let assetUi = null;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "aseprite-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}
	const unknown = await call("get_aseprite_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Closed Aseprite schema did not reject an unknown field.");

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required for the Aseprite live scenario.");
	projectDirectory = dirname(status.projectPath);
	const active = await call("get_active_scene");
	originalScenePath = active.path;
	if (!originalScenePath || originalScenePath === scenePath) throw new Error("The live scenario requires an existing active scene that can be restored.");
	if (process.env.ASEPRITE_LIVE_ALLOW_SCENE_SWITCH !== "1") {
		throw new Error("Set ASEPRITE_LIVE_ALLOW_SCENE_SWITCH=1 only for a disposable editor project; the test creates and removes one temporary scene.");
	}

	await call("create_scene", { path: scenePath });
	sceneCreated = true;
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	sourceAbsolutePath = join(projectDirectory, assetPath);
	const sourceBytes = complexAsepriteFixture();
	await writeFile(sourceAbsolutePath, sourceBytes, { mode: 0o600 });
	await call("refresh_asset_registry_paths", { paths: [assetPath] });
	assetRegistered = true;

	let importer = await call("get_asset_importer", { path: assetPath });
	if (importer.importer?.kind !== "aseprite") throw new Error(`Aseprite importer inference failed: ${JSON.stringify(importer)}`);
	await call("set_asset_importer_settings", {
		paths: [assetPath],
		settings: {
			includeHiddenLayers: true,
			layerMode: "compositeAndLayers",
			trimSprites: true,
			ignoreEmptyFrames: false,
			mergeDuplicates: false,
			padding: 3,
			extrude: 2,
			powerOfTwo: true,
			maximumAtlasSize: 64,
			importTags: true,
			importSlices: true,
			pivotMode: "sliceOrCenter",
			pixelsPerUnit: 80,
		},
	});
	importer = await call("get_asset_importer", { path: assetPath });
	if (importer.importer?.settings?.layerMode !== "compositeAndLayers" || importer.importer?.settings?.padding !== 3) {
		throw new Error(`Aseprite importer settings did not persist: ${JSON.stringify(importer)}`);
	}

	const capabilities = await call("get_aseprite_capabilities");
	if (capabilities.sourceExtensions?.length !== 2 || capabilities.layerKinds?.length !== 3 || capabilities.features?.length < 8) {
		throw new Error(`Aseprite capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}
	let inspection = await call("inspect_aseprite_import", { path: assetPath, layerLimit: 1, tagLimit: 1, sliceLimit: 1, frameLimit: 2 });
	if (inspection.current || inspection.artifact !== null || !/^[a-f0-9]{64}$/.test(inspection.fingerprint)) {
		throw new Error(`Initial Aseprite inspection is invalid: ${JSON.stringify(inspection)}`);
	}
	await call("apply_aseprite_import", { path: assetPath, expectedFingerprint: "0".repeat(64), confirm: true }, true);
	await call("apply_aseprite_import", { path: assetPath, expectedFingerprint: inspection.fingerprint, confirm: true });
	inspection = await call("inspect_aseprite_import", { path: assetPath, layerLimit: 1, tagLimit: 1, sliceLimit: 1, frameLimit: 2 });
	if (
		!inspection.current ||
		inspection.artifact?.document?.frameCount !== 3 ||
		inspection.artifact?.document?.frameDurationsMs?.join(",") !== "80,120,200" ||
		inspection.artifact?.layers?.total !== 3 ||
		inspection.artifact?.layers?.count !== 1 ||
		inspection.artifact?.tags?.items?.[0]?.name !== "Run" ||
		inspection.artifact?.tags?.items?.[0]?.direction !== "pingpong" ||
		inspection.artifact?.slices?.items?.[0]?.name !== "Body" ||
		inspection.artifact?.frames?.total !== 9 ||
		inspection.artifact?.frames?.count !== 2
	) {
		throw new Error(`Published Aseprite evidence is incomplete: ${JSON.stringify(inspection)}`);
	}

	await call("open_asset_inspector", { path: assetPath });
	assetUi = await connectEditorUi("[data-aseprite-inspector]");
	// The inspector receives the imported artifact asynchronously, so wait for it instead of reading the first render.
	await waitForUi(
		() => assetUi.evaluate("document.querySelector('[data-aseprite-inspector]')?.textContent?.includes('pingpong') ?? false"),
		Boolean,
		"Aseprite File Inspector tag-direction evidence",
		20_000
	).catch(() => {
		throw new Error("The Aseprite File Inspector did not render tag-direction evidence.");
	});
	await assetUi.setValue("[data-aseprite-speed]", 2.5);
	await assetUi.click("[data-aseprite-play-on-awake]");
	await assetUi.click("[data-aseprite-instantiate-composite]");
	let uiInstances = await waitFor(
		() => call("list_aseprite_instances", { offset: 0, limit: 10 }),
		(result) => result.total === 1,
		"Aseprite UI-created composite instance"
	);
	let uiInstance = await call("get_aseprite_instance", { id: uiInstances.instances[0].id, managerOffset: 0, managerLimit: 10 });
	if (uiInstance.metadata?.mode !== "composite" || uiInstance.managerCount !== 1 || uiInstance.managerPage?.items?.[0]?.playback?.speed !== 2.5) {
		throw new Error(`Aseprite composite UI options were not applied: ${JSON.stringify(uiInstance)}`);
	}
	await call("delete_aseprite_instance", { id: uiInstance.id, confirm: true });
	await call("open_asset_inspector", { path: assetPath });
	// The reopened inspector loads the importer artifact asynchronously; the layer button stays disabled until it is current.
	await waitForUi(
		() => assetUi.evaluate("document.querySelector('[data-aseprite-instantiate-layers]')?.disabled === false"),
		Boolean,
		"reopened Aseprite File Inspector with an enabled layer-hierarchy action"
	);
	await assetUi.click("[data-aseprite-instantiate-layers]");
	uiInstances = await waitFor(
		() => call("list_aseprite_instances", { offset: 0, limit: 10 }),
		(result) => result.total === 1,
		"Aseprite UI-created layer hierarchy"
	);
	uiInstance = await call("get_aseprite_instance", { id: uiInstances.instances[0].id, managerOffset: 0, managerLimit: 10 });
	if (uiInstance.metadata?.mode !== "layers" || uiInstance.managerCount < 2) {
		throw new Error(`Aseprite layer-hierarchy UI instantiation is incomplete: ${JSON.stringify(uiInstance)}`);
	}
	await call("delete_aseprite_instance", { id: uiInstance.id, confirm: true });
	if (assetUi.runtimeErrors.length) throw new Error(`Aseprite Inspector renderer errors: ${assetUi.runtimeErrors.join(" | ")}`);
	assetUi.socket.close();
	assetUi = null;

	let instance = await call("instantiate_aseprite_asset", {
		path: assetPath,
		id: instanceId,
		name: instanceName,
		position: [125, 40, -75],
		mode: "layers",
		animationName: "Run",
		playOnAwake: false,
		speed: 1.75,
	});
	instanceCreated = true;
	if (instance.mode !== "layers" || instance.managerCount !== 2 || instance.managers?.some((manager) => manager.frameCount !== 4 || manager.playing)) {
		throw new Error(`Layered Aseprite instantiation is incomplete: ${JSON.stringify(instance)}`);
	}
	const listed = await call("list_aseprite_instances", { offset: 0, limit: 1 });
	if (listed.total !== 1 || listed.count !== 1 || listed.instances?.[0]?.managerCount !== 2) throw new Error(`Aseprite list paging failed: ${JSON.stringify(listed)}`);
	instance = await call("get_aseprite_instance", { id: instanceId, managerOffset: 1, managerLimit: 1 });
	if (instance.metadata?.revision !== 1 || instance.managerPage?.offset !== 1 || instance.managerPage?.count !== 1) {
		throw new Error(`Aseprite instance paging/revision failed: ${JSON.stringify(instance)}`);
	}

	instance = await call("control_aseprite_animation", {
		id: instanceId,
		expectedRevision: 1,
		action: "seek",
		animationName: "Run",
		frameCursor: 1,
		elapsedMs: 30,
		playing: false,
	});
	if (instance.metadata?.revision !== 2 || instance.managerPage?.items?.some((manager) => manager.playback?.frameCursor !== 1 || manager.playback?.elapsedMs !== 30)) {
		throw new Error(`Aseprite atomic seek failed: ${JSON.stringify(instance)}`);
	}
	await call("control_aseprite_animation", { id: instanceId, expectedRevision: 1, action: "play", animationName: "Run" }, true);
	instance = await call("control_aseprite_animation", { id: instanceId, expectedRevision: 2, action: "play", animationName: "Run", speed: 2.25, restart: true });
	if (instance.metadata?.revision !== 3 || instance.managerPage?.items?.some((manager) => !manager.playback?.playing || manager.playback?.speed !== 2.25)) {
		throw new Error(`Aseprite exact-revision play failed: ${JSON.stringify(instance)}`);
	}
	await new Promise((resolve) => setTimeout(resolve, 150));
	instance = await call("control_aseprite_animation", { id: instanceId, expectedRevision: 3, action: "pause" });
	if (instance.metadata?.revision !== 4 || instance.managerPage?.items?.some((manager) => manager.playback?.playing)) {
		throw new Error(`Aseprite synchronized pause failed: ${JSON.stringify(instance)}`);
	}
	instance = await call("control_aseprite_animation", { id: instanceId, expectedRevision: 4, action: "stop", animationName: "Run", speed: 1 });
	if (instance.metadata?.revision !== 5 || instance.managerPage?.items?.some((manager) => manager.playback?.frameCursor !== 0 || manager.playback?.elapsedMs !== 0)) {
		throw new Error(`Aseprite synchronized rewind failed: ${JSON.stringify(instance)}`);
	}

	await call("focus_node", { nodeId: instanceId });
	const screenshot = await callImage("get_screenshot", { width: 960, height: 540 });
	if (screenshot.bytes.length < 5_000) throw new Error(`Aseprite screenshot is unexpectedly small (${screenshot.bytes.length} bytes).`);
	const screenshotSha256 = createHash("sha256").update(screenshot.bytes).digest("hex");

	await call("save_scene");
	await call("open_scene", { path: scenePath });
	instance = await waitFor(
		() => safeCall("get_aseprite_instance", { id: instanceId, managerOffset: 0, managerLimit: 2 }),
		(value) => value?.metadata?.revision === 5 && value?.managerCount === 2,
		"serialized Aseprite hierarchy rebind"
	);
	if (instance.position?.join(",") !== "125,40,-75" || instance.managerPage?.items?.some((manager) => manager.animations?.[0]?.name !== "Run")) {
		throw new Error(`Serialized Aseprite hierarchy did not rebind exactly: ${JSON.stringify(instance)}`);
	}
	await call("open_asset_inspector", { path: assetPath });

	await call("delete_aseprite_instance", { id: instanceId, confirm: true });
	instanceCreated = false;
	const empty = await call("list_aseprite_instances", { offset: 0, limit: 1 });
	if (empty.total !== 0) throw new Error(`Aseprite instance cleanup failed: ${JSON.stringify(empty)}`);
	const deleted = await call("delete_asset", { path: assetPath, confirm: true });
	assetRegistered = false;
	if (deleted.removedImporterArtifacts?.length !== 1) throw new Error(`Aseprite importer artifact cleanup failed: ${JSON.stringify(deleted)}`);
	await call("open_scene", { path: originalScenePath });
	await call("delete_scene", { path: scenePath, confirm: true });
	sceneCreated = false;
	completed = true;
	console.log(
		`[aseprite-live] PASS — ${sourceBytes.byteLength}-byte independent source, 3 layers/3 variable-time frames/9 atlas entries, compressed+linked cels, cel events, ping-pong tag, pivot/nine-patch, layered instantiation, exact revision rejection, synchronized seek/play/pause/rewind, ${screenshot.bytes.length}-byte ${screenshot.mimeType} screenshot ${screenshotSha256}, save/reopen rebind, and exact cleanup verified across ${tools.length} real stdio tools.`
	);
} catch (error) {
	console.error(`[aseprite-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	assetUi?.socket?.close();
	if (instanceCreated) await safeCall("delete_aseprite_instance", { id: instanceId, confirm: true });
	if (assetRegistered && !retainFixtures) await safeCall("delete_asset", { path: assetPath, confirm: true });
	if (sceneCreated && originalScenePath) {
		await safeCall("open_scene", { path: originalScenePath });
		if (!retainFixtures) await safeCall("delete_scene", { path: scenePath, confirm: true });
	}
	if (!completed && sourceAbsolutePath && !retainFixtures) {
		await rm(sourceAbsolutePath, { force: true });
		await rm(`${sourceAbsolutePath}.bjsmeta.json`, { force: true });
	}
	if (!completed && retainFixtures && sourceAbsolutePath) console.error(`[aseprite-live] retained diagnostic source: ${sourceAbsolutePath}`);
	if (!completed && retainFixtures && sceneCreated) console.error(`[aseprite-live] retained diagnostic scene: ${scenePath}`);
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 1000).unref();
}

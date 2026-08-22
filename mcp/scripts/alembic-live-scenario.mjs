#!/usr/bin/env node
/** Real Blender -> editor -> stdio MCP -> serialized scene lifecycle for portable Alembic. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectEditorUi } from "./electron-ui-harness.mjs";

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

async function callImage(name, args = {}) {
	let response;
	try {
		response = await rpc("tools/call", { name, arguments: args });
	} catch (error) {
		throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
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

function run(executable, args, timeoutMs = 120_000) {
	return new Promise((resolve, reject) => {
		const process = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let errorOutput = "";
		const timer = setTimeout(() => process.kill("SIGKILL"), timeoutMs);
		process.stdout.on("data", (chunk) => (output += chunk.toString()));
		process.stderr.on("data", (chunk) => (errorOutput += chunk.toString()));
		process.once("error", reject);
		process.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve({ output, errorOutput });
			else reject(new Error(`${executable} exited with ${signal ?? code}: ${errorOutput.slice(-4000)}`));
		});
	});
}

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

const blenderFixtureScript = String.raw`import bpy
import math
import os
import sys

output_path = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.materials):
    pass

scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 9
scene.render.fps = 8
scene.render.fps_base = 1.0

red = bpy.data.materials.new("Body Red")
red.diffuse_color = (0.8, 0.05, 0.03, 1.0)
blue = bpy.data.materials.new("Body Blue")
blue.diffuse_color = (0.03, 0.12, 0.9, 1.0)

bpy.ops.mesh.primitive_cube_add(location=(-2.0, 0.0, 0.0))
stable = bpy.context.object
stable.name = "Stable Animated Mesh"
stable.data.materials.append(red)
stable.data.materials.append(blue)
for polygon in stable.data.polygons:
    polygon.material_index = polygon.index % 2
color = stable.data.color_attributes.new(name="Animated Color", type="BYTE_COLOR", domain="CORNER")
for index, value in enumerate(color.data):
    value.color = (1.0, (index % 3) / 2.0, 0.15, 1.0)
basis = stable.shape_key_add(name="Basis")
deform = stable.shape_key_add(name="Deform")
deform.data[0].co.x -= 1.5
deform.data[6].co.z += 2.0
deform.value = 0.0
deform.keyframe_insert(data_path="value", frame=1)
deform.value = 1.0
deform.keyframe_insert(data_path="value", frame=9)
stable.rotation_euler = (0.0, 0.0, 0.0)
stable.keyframe_insert(data_path="rotation_euler", frame=1)
stable.rotation_euler = (0.0, 0.0, math.pi)
stable.keyframe_insert(data_path="rotation_euler", frame=9)

bpy.ops.mesh.primitive_grid_add(x_subdivisions=7, y_subdivisions=7, size=4.0, location=(3.0, 0.0, 0.0))
variable = bpy.context.object
variable.name = "Variable Topology Build"
variable.data.materials.append(blue)
build = variable.modifiers.new(name="Animated Topology", type="BUILD")
build.frame_start = 1.0
build.frame_duration = 8.0
build.use_random_order = True
build.seed = 11

point_mesh = bpy.data.meshes.new("Point Cloud Geometry")
point_mesh.from_pydata([(-1.0, -1.0, 0.0), (0.0, 1.5, 0.4), (1.0, -0.5, 1.0), (2.0, 1.0, -0.5)], [], [])
point_mesh.update()
points = bpy.data.objects.new("Animated Points", point_mesh)
scene.collection.objects.link(points)
points.location = (0.0, -4.0, 0.0)
points.keyframe_insert(data_path="location", frame=1)
points.location = (2.0, -4.0, 2.0)
points.keyframe_insert(data_path="location", frame=9)
points.hide_render = False
points.keyframe_insert(data_path="hide_render", frame=1)
points.hide_render = True
points.keyframe_insert(data_path="hide_render", frame=5)
points.hide_render = False
points.keyframe_insert(data_path="hide_render", frame=9)

curve_data = bpy.data.curves.new("Animated Curve Geometry", type="CURVE")
curve_data.dimensions = "3D"
curve_data.resolution_u = 2
spline = curve_data.splines.new(type="POLY")
spline.points.add(4)
for point, coordinate in zip(spline.points, [(-3.0, 3.0, 0.0, 1.0), (-1.5, 4.0, 1.0, 1.0), (0.0, 3.0, 0.0, 1.0), (1.5, 4.0, -1.0, 1.0), (3.0, 3.0, 0.0, 1.0)]):
    point.co = coordinate
curve = bpy.data.objects.new("Animated Curve", curve_data)
scene.collection.objects.link(curve)
curve.location = (0.0, 0.0, 0.0)
curve.keyframe_insert(data_path="location", frame=1)
curve.location = (0.0, 0.0, 2.5)
curve.keyframe_insert(data_path="location", frame=9)

camera_data = bpy.data.cameras.new("Alembic Camera Data")
camera = bpy.data.objects.new("Animated Camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (0.0, -14.0, 8.0)
camera.rotation_euler = (math.radians(67.0), 0.0, 0.0)
camera.keyframe_insert(data_path="location", frame=1)
camera.location = (7.0, -11.0, 6.0)
camera.keyframe_insert(data_path="location", frame=9)
camera_data.lens = 32.0
camera_data.keyframe_insert(data_path="lens", frame=1)
camera_data.lens = 58.0
camera_data.keyframe_insert(data_path="lens", frame=9)
scene.camera = camera

result = bpy.ops.wm.alembic_export(
    filepath=output_path,
    start=scene.frame_start,
    end=scene.frame_end,
    xsamples=1,
    gsamples=1,
    flatten=False,
    uvs=True,
    normals=True,
    vcolors=True,
    face_sets=True,
    curves_as_mesh=False,
    triangulate=False,
    export_hair=True,
    export_particles=True,
    as_background_job=False,
    evaluation_mode="RENDER",
)
if "FINISHED" not in result or not os.path.isfile(output_path) or os.path.getsize(output_path) < 1:
    raise RuntimeError("Alembic export did not produce a non-empty archive: %r" % (result,))
print("ZVIBE_ALEMBIC_FIXTURE", os.path.getsize(output_path))
`;

const requiredTools = [
	"get_alembic_capabilities",
	"inspect_alembic_import",
	"apply_alembic_import",
	"instantiate_alembic_asset",
	"list_alembic_players",
	"get_alembic_player",
	"set_alembic_player",
	"control_alembic_player",
	"delete_alembic_player",
	"open_asset_inspector",
];
const packagedManifest = JSON.parse(await readFile(join(here, "..", "manifest.json"), "utf8"));
const packagedTools = packagedManifest.server?.tools ?? packagedManifest.tools;
if (!Array.isArray(packagedTools)) throw new Error("MCPB manifest does not contain a packaged tool catalog.");
const expectedToolCount = packagedTools.length;
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const retainFixtures = process.env.ALEMBIC_LIVE_RETAIN_FIXTURES === "1";
const assetPath = `assets/.mcp-alembic-${suffix}.abc`;
const scenePath = `scenes/mcp-alembic-${suffix}.scene`;
const playerId = `mcp-alembic-${suffix}`;
const initialName = `Alembic Complex ${suffix}`;
const renamedName = `Alembic Verified ${suffix}`;
const temporary = await mkdtemp(join(tmpdir(), "zvibe-alembic-live-"));
const generatorPath = join(temporary, "create_complex_alembic.py");
let projectDirectory = null;
let originalScenePath = null;
let sourceAbsolutePath = null;
let sceneCreated = false;
let assetRegistered = false;
let playerCreated = false;
let completed = false;
let assetUi = null;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "alembic-live-scenario", version: "1.0.0" } });
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
	const unknown = await call("get_alembic_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Closed Alembic schema did not reject an unknown field.");

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required for the Alembic live scenario.");
	projectDirectory = dirname(status.projectPath);
	const active = await call("get_active_scene");
	originalScenePath = active.path;
	if (!originalScenePath || originalScenePath === scenePath)
		throw new Error("The live scenario requires an existing active scene that can be restored after the disposable test scene.");
	if (process.env.ALEMBIC_LIVE_ALLOW_SCENE_SWITCH !== "1") {
		throw new Error("Set ALEMBIC_LIVE_ALLOW_SCENE_SWITCH=1 only for a disposable editor project; the test opens a temporary scene and restores the current one.");
	}

	await call("create_scene", { path: scenePath });
	sceneCreated = true;
	let workspace = await call("get_scene_workspace");
	if (workspace.activeScene !== scenePath || workspace.lightingScene !== scenePath || workspace.scenes?.length !== 1) {
		throw new Error(`Disposable scene workspace was not activated exactly: ${JSON.stringify(workspace)}`);
	}
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	sourceAbsolutePath = join(projectDirectory, assetPath);
	await writeFile(generatorPath, blenderFixtureScript, { mode: 0o600 });
	const blender = process.env.BJS_EDITOR_BLENDER_EXECUTABLE || process.env.BLENDER_EXECUTABLE || "/Applications/Blender.app/Contents/MacOS/Blender";
	const generated = await run(blender, ["--background", "--factory-startup", "--python", generatorPath, "--", sourceAbsolutePath]);
	if (!generated.output.includes("ZVIBE_ALEMBIC_FIXTURE")) throw new Error(`Blender fixture evidence is missing: ${generated.output}`);
	await call("refresh_asset_registry_paths", { paths: [assetPath] });
	assetRegistered = true;

	const importer = await call("get_asset_importer", { path: assetPath });
	if (importer.importer?.kind !== "alembic" || importer.importer?.settings?.includeInBuild !== true) {
		throw new Error(`Alembic importer inference failed: ${JSON.stringify(importer)}`);
	}
	const capabilities = await call("get_alembic_capabilities");
	if (capabilities.format !== "zvibe-alembic-cache" || capabilities.limits?.residentFrames !== 2 || capabilities.objectKinds?.length !== 4) {
		throw new Error(`Alembic capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}

	let inspection = await call("inspect_alembic_import", { path: assetPath, objectOffset: 0, objectLimit: 1, frameOffset: 0, frameLimit: 2 });
	if (inspection.current || inspection.result !== null || !/^[a-f0-9]{64}$/.test(inspection.fingerprint)) {
		throw new Error(`Initial Alembic inspection is invalid: ${JSON.stringify(inspection)}`);
	}
	await call("apply_alembic_import", { path: assetPath, expectedFingerprint: "0".repeat(64), confirm: true }, true);
	await call("apply_alembic_import", { path: assetPath, expectedFingerprint: inspection.fingerprint, confirm: true });
	inspection = await call("inspect_alembic_import", { path: assetPath, objectOffset: 0, objectLimit: 1, frameOffset: 0, frameLimit: 2 });
	const manifest = inspection.result?.manifest;
	if (
		!inspection.current ||
		manifest?.objectPage?.total < 4 ||
		manifest?.objectPage?.count !== 1 ||
		manifest?.framePage?.total < 2 ||
		manifest?.framePage?.count !== 2 ||
		manifest?.statistics?.meshCount < 2 ||
		manifest?.statistics?.pointCount < 1 ||
		manifest?.statistics?.curveCount < 1 ||
		manifest?.statistics?.cameraCount < 1 ||
		manifest?.statistics?.variableTopologyCount < 1
	) {
		throw new Error(`Real Blender cache evidence is incomplete: ${JSON.stringify(inspection)}`);
	}

	await call("open_asset_inspector", { path: assetPath });
	assetUi = await connectEditorUi("[data-alembic-inspector]");
	await waitFor(
		() => assetUi.evaluate("document.querySelector('[data-alembic-inspector]')?.textContent ?? null"),
		(text) => text?.includes("Topology:") && text.includes("variable") && text.includes("Current"),
		"current Alembic File Inspector topology evidence",
		45_000
	);
	await assetUi.click("[data-alembic-instantiate]");
	const uiPlayers = await waitFor(
		() => call("list_alembic_players", { offset: 0, limit: 10 }),
		(result) => result.total === 1,
		"Alembic UI-created player"
	);
	if (assetUi.runtimeErrors.length) throw new Error(`Alembic Inspector renderer errors: ${assetUi.runtimeErrors.join(" | ")}`);
	await call("delete_alembic_player", { id: uiPlayers.players[0].configuration.id, confirm: true });
	assetUi.socket.close();
	assetUi = null;

	const parent = await call("create_primitive_mesh", { type: "empty", name: `Alembic Parent ${suffix}`, position: [20, 0, 10] });
	if (!parent?.id) throw new Error(`Creating the Alembic parent failed: ${JSON.stringify(parent)}`);
	let player = await call("instantiate_alembic_asset", {
		path: assetPath,
		id: playerId,
		name: initialName,
		parentId: parent.id,
		position: [125, 40, -75],
		playOnAwake: false,
		loop: true,
		speed: 1.5,
		interpolation: "linear",
		pointSize: 7,
		curveWidth: 4.5,
	});
	playerCreated = true;
	if (player.configuration?.revision !== 1 || player.configuration?.curveWidth !== 4.5 || player.state?.objectCount < 4) {
		throw new Error(`Alembic instantiation evidence is incomplete: ${JSON.stringify(player)}`);
	}
	const listed = await call("list_alembic_players", { offset: 0, limit: 1 });
	if (listed.total !== 1 || listed.count !== 1 || listed.players?.[0]?.cache?.objects?.length !== 0) {
		throw new Error(`Alembic player pagination failed: ${JSON.stringify(listed)}`);
	}
	const opened = await call("get_alembic_player", { id: playerId, objectOffset: 1, objectLimit: 2 });
	if (opened.cache?.objectPage?.offset !== 1 || opened.cache?.objectPage?.count !== 2) throw new Error(`Alembic object paging failed: ${JSON.stringify(opened)}`);

	player = await call("set_alembic_player", {
		id: playerId,
		expectedRevision: 1,
		name: renamedName,
		speed: -2,
		interpolation: "hold",
		pointSize: 9,
		curveWidth: 6.25,
		startTimeSeconds: 0.25,
		endTimeSeconds: 0.875,
	});
	if (player.configuration?.revision !== 2 || player.configuration?.name !== renamedName || player.configuration?.curveWidth !== 6.25) {
		throw new Error(`Alembic exact-revision update failed: ${JSON.stringify(player)}`);
	}
	await call("set_alembic_player", { currentName: renamedName, expectedRevision: 1, loop: false }, true);
	player = await call("set_alembic_player", { currentName: renamedName, expectedRevision: 2, interpolation: "linear", loop: false });
	if (player.configuration?.revision !== 3 || player.configuration?.loop !== false) throw new Error(`Name-based Alembic update failed: ${JSON.stringify(player)}`);

	player = await call("control_alembic_player", { id: playerId, action: "seek", timeSeconds: 0.5625 });
	if (player.state?.currentTimeSeconds !== 0.5625 || player.state?.loadedFrameIndices?.length > 2 || player.state?.lastError !== null) {
		throw new Error(`Alembic seek/residency failed: ${JSON.stringify(player)}`);
	}
	await call("control_alembic_player", { name: renamedName, action: "play" });
	await new Promise((resolve) => setTimeout(resolve, 250));
	player = await call("control_alembic_player", { name: renamedName, action: "pause" });
	if (player.state?.playing || player.state?.currentTimeSeconds === 0.5625) throw new Error(`Alembic play/pause clock did not advance: ${JSON.stringify(player)}`);

	await call("focus_node", { nodeId: playerId });
	const screenshot = await callImage("get_screenshot", { width: 960, height: 540 });
	if (screenshot.bytes.length < 5_000) throw new Error(`Alembic screenshot is unexpectedly small (${screenshot.bytes.length} bytes).`);
	const screenshotSha256 = createHash("sha256").update(screenshot.bytes).digest("hex");

	workspace = await call("get_scene_workspace");
	const authoredScene = workspace.scenes?.find((candidate) => candidate.path === scenePath);
	if (workspace.activeScene !== scenePath || !authoredScene?.isDirty || authoredScene.ownedObjectCount < 9 || !authoredScene.rootNodes?.some((node) => node.id === parent.id)) {
		throw new Error(`Alembic scene ownership is incomplete before save: ${JSON.stringify(workspace)}`);
	}
	await call("save_scene");
	await call("open_scene", { path: scenePath });
	player = await waitFor(
		() => safeCall("get_alembic_player", { id: playerId, objectOffset: 0, objectLimit: 4 }),
		(value) => value?.configuration?.revision === 3 && value?.state?.objectCount >= 4,
		"serialized Alembic player rebind",
		45_000
	);
	if (player.configuration?.curveWidth !== 6.25 || player.configuration?.name !== renamedName || player.state?.lastError !== null) {
		throw new Error(`Serialized Alembic player did not rebind exactly: ${JSON.stringify(player)}`);
	}

	await call("delete_alembic_player", { id: playerId, confirm: true });
	playerCreated = false;
	const empty = await call("list_alembic_players", { offset: 0, limit: 1 });
	if (empty.total !== 0) throw new Error(`Alembic player cleanup failed: ${JSON.stringify(empty)}`);
	await call("delete_asset", { path: assetPath, confirm: true });
	assetRegistered = false;
	await call("open_scene", { path: originalScenePath });
	await call("delete_scene", { path: scenePath, confirm: true });
	sceneCreated = false;
	completed = true;
	console.log(
		`[alembic-live] PASS — real Blender ${manifest.generator.blenderVersion}, ${manifest.objectPage.total} objects/${manifest.framePage.total} samples, all mesh/points/curves/camera kinds, variable topology, exact lease/revision rejection, bounded pages, playback/two-frame residency, ${screenshot.bytes.length}-byte ${screenshot.mimeType} screenshot ${screenshotSha256}, save/reload rebind, and exact cleanup verified.`
	);
} catch (error) {
	console.error(`[alembic-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	assetUi?.socket?.close();
	if (playerCreated) await safeCall("delete_alembic_player", { id: playerId, confirm: true });
	if (assetRegistered && !retainFixtures) await safeCall("delete_asset", { path: assetPath, confirm: true });
	if (sceneCreated && originalScenePath) {
		await safeCall("open_scene", { path: originalScenePath });
		if (!retainFixtures) await safeCall("delete_scene", { path: scenePath, confirm: true });
	}
	if (!completed && sourceAbsolutePath && !retainFixtures) {
		await rm(sourceAbsolutePath, { force: true });
		await rm(`${sourceAbsolutePath}.bjsmeta.json`, { force: true });
	}
	if (!completed && retainFixtures && sourceAbsolutePath) console.error(`[alembic-live] retained diagnostic source: ${sourceAbsolutePath}`);
	if (!completed && retainFixtures && sceneCreated) console.error(`[alembic-live] retained diagnostic scene: ${scenePath}`);
	await rm(temporary, { recursive: true, force: true });
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 1000).unref();
}

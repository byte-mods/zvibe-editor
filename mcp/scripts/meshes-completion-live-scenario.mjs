#!/usr/bin/env node
/** Positive live lifecycle for remaining Mesh, ProBuilder, terrain, LOD, collision, skeleton, and morph tools. */
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

const required = [
	"get_mesh_geometry",
	"weld_mesh_vertices",
	"flip_mesh_normals",
	"extrude_mesh_faces",
	"inset_mesh_faces",
	"boolean_mesh",
	"bridge_mesh_edges",
	"bevel_mesh_edge",
	"set_mesh_uv_projection",
	"subdivide_mesh",
	"set_ground_heightmap",
	"get_terrain",
	"sculpt_terrain",
	"carve_terrain_hole",
	"paint_terrain_details",
	"scatter_terrain_instances",
	"create_instance",
	"clone_mesh",
	"set_skeleton",
	"get_mesh_morph_targets",
	"set_mesh_morph_targets",
	"get_mesh_lods",
	"set_mesh_lods",
	"get_mesh_collision",
	"set_mesh_collision",
	"get_mesh_bounding_info",
];
const suffix = `${Date.now()}-${process.pid}`;
const assetFolder = `assets/mcp-meshes-${suffix}`;
const heightmapPath = `${assetFolder}/heightmap.png`;
const setupScriptName = `meshes-completion-setup-${suffix}.js`;
const cleanupScriptName = `meshes-completion-cleanup-${suffix}.js`;
const nodeIds = new Set();
let skeletonId;
let morphNodeId;
let baselineDiagnostics;
const textureCheckpoints = {};

async function checkpoint(name) {
	textureCheckpoints[name] = (await call("get_scene_diagnostics")).textures;
}

async function create(type, name, position, options) {
	const node = await call("create_primitive_mesh", { type, name: `${name} ${suffix}`, position, options });
	nodeIds.add(node.id);
	return node;
}

async function cleanup() {
	if (skeletonId || morphNodeId) {
		const cleanupSource = `
export function main(editor) {
	const scene = editor.layout.preview.scene;
	const mesh = scene.getMeshById(${JSON.stringify(morphNodeId)});
	mesh?.morphTargetManager?.dispose();
	if (mesh) mesh.morphTargetManager = null;
	const skeleton = scene.skeletons.find((candidate) => candidate.id === ${JSON.stringify(skeletonId)});
	skeleton?.dispose();
	return "mesh skeleton and morph resources disposed";
}`;
		await call("run_agent_script", { name: cleanupScriptName, content: cleanupSource }).catch(() => undefined);
		skeletonId = undefined;
	}
	for (const nodeId of [...nodeIds].reverse()) {
		await call("delete_node", { nodeId }).catch(() => undefined);
		nodeIds.delete(nodeId);
	}
	morphNodeId = undefined;
	for (const path of [
		`${heightmapPath}.bjsmeta.json`,
		heightmapPath,
		assetFolder,
		`agentdata/${setupScriptName}`,
		`agentdata/${cleanupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs.map")}`,
	]) {
		await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "meshes-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Mesh completion testing.");
	const warmup = await call("create_primitive_mesh", { type: "box", name: `MCP Mesh Viewport Warmup ${suffix}`, position: [0, -1000, 0], options: { size: 1 } });
	await call("get_scene_diagnostics");
	await call("delete_node", { nodeId: warmup.id });
	baselineDiagnostics = await call("get_scene_diagnostics");
	textureCheckpoints.baseline = baselineDiagnostics.textures;

	const base = await create("box", "MCP Mesh Base", [-600, 120, 0], { size: 100 });
	morphNodeId = base.id;
	const geometry = await call("get_mesh_geometry", { nodeId: base.id });
	if (geometry.geometry?.type !== "Box") throw new Error("Editable primitive geometry evidence is incomplete.");
	const bounds = await call("get_mesh_bounding_info", { nodeId: base.id });
	if (!bounds.world?.size?.every((value) => value > 0)) throw new Error("Mesh bounding evidence is incomplete.");
	await checkpoint("bounds");
	const welded = await call("weld_mesh_vertices", { nodeId: base.id, tolerance: 0.0001 });
	if (welded.weldedVertices < 1) throw new Error("Box vertex welding did not merge duplicated vertices.");
	await call("flip_mesh_normals", { nodeId: base.id });
	const projected = await call("set_mesh_uv_projection", { nodeId: base.id, plane: "xz", scale: 100, offset: [0.1, 0.2] });
	if (projected.projection.plane !== "xz") throw new Error("Mesh UV projection evidence is incomplete.");
	const subdivided = await call("subdivide_mesh", { nodeId: base.id, levels: 1 });
	if (subdivided.indices.length <= welded.indices.length) throw new Error("Mesh subdivision did not increase topology.");
	await checkpoint("base-topology");

	const instances = await call("create_instance", {
		sourceNodeId: base.id,
		name: `MCP Mesh Instance ${suffix}`,
		transforms: [{ position: [-450, 120, 0] }, { position: [-300, 120, 0], scaling: [0.5, 0.5, 0.5] }],
	});
	for (const instance of instances.instances) nodeIds.add(instance.id);
	if (instances.instances.length !== 2) throw new Error("Mesh instancing evidence is incomplete.");
	await checkpoint("instances");
	const clone = await call("clone_mesh", { sourceNodeId: base.id, name: `MCP Mesh Clone ${suffix}`, cloneGeometry: true });
	nodeIds.add(clone.id);
	await checkpoint("clone");
	await checkpoint("base-modeling");

	const extrude = await create("box", "MCP Extrude", [-150, 120, 0], { size: 100 });
	const extruded = await call("extrude_mesh_faces", { nodeId: extrude.id, faceIndices: [0, 1], distance: 25 });
	if (extruded.extrudedFaces !== 2 || extruded.addedTriangles < 1) throw new Error("Face extrusion evidence is incomplete.");
	const inset = await create("box", "MCP Inset", [0, 120, 0], { size: 100 });
	const insetResult = await call("inset_mesh_faces", { nodeId: inset.id, faceIndices: [0, 1], amount: 0.25, depth: 5 });
	if (insetResult.insetFaces !== 2 || insetResult.addedVertices < 1) throw new Error("Face inset evidence is incomplete.");

	const bridge = await create("ground", "MCP Bridge", [150, 120, 0], { width: 100, height: 100, subdivisions: 1 });
	const bridged = await call("bridge_mesh_edges", { nodeId: bridge.id, firstEdge: [0, 1], secondEdge: [2, 3] });
	if (bridged.addedTriangles !== 2) throw new Error("Edge bridge evidence is incomplete.");
	const bevel = await create("ground", "MCP Bevel", [300, 120, 0], { width: 100, height: 100, subdivisions: 1 });
	const bevelData = await call("get_mesh_vertex_data", { nodeId: bevel.id });
	const bevelTopology = await call("get_mesh_topology", { nodeId: bevel.id });
	const incidence = new Map();
	for (let index = 0; index < bevelData.indices.length; index += 3) {
		const triangle = bevelData.indices.slice(index, index + 3);
		for (let edge = 0; edge < 3; edge++) {
			const pair = [triangle[edge], triangle[(edge + 1) % 3]].sort((a, b) => a - b);
			const key = `${pair[0]}:${pair[1]}`;
			incidence.set(key, (incidence.get(key) ?? 0) + 1);
		}
	}
	const manifoldEdgeIndex = bevelTopology.edges.findIndex((edge) => incidence.get(`${edge[0]}:${edge[1]}`) === 2);
	if (manifoldEdgeIndex < 0) throw new Error("No manifold edge was available for bevel testing.");
	const beveled = await call("bevel_mesh_edge", { nodeId: bevel.id, edgeIndex: manifoldEdgeIndex, amount: 0.1, segments: 1 });
	if (beveled.addedVertices < 1) throw new Error("Edge bevel evidence is incomplete.");
	await checkpoint("topology");

	const booleanA = await create("box", "MCP Boolean A", [450, 120, 0], { size: 100 });
	const booleanB = await create("box", "MCP Boolean B", [475, 120, 0], { size: 100 });
	const booleanResult = await call("boolean_mesh", { primaryNodeId: booleanA.id, secondaryNodeId: booleanB.id, operation: "union", name: `MCP Boolean Result ${suffix}` });
	nodeIds.add(booleanResult.mesh.id);
	if (booleanResult.triangleCount < 1) throw new Error("Mesh Boolean evidence is incomplete.");
	await checkpoint("boolean");

	const terrain = await create("ground", "MCP Terrain", [0, 0, 500], { width: 600, height: 600, subdivisions: 8 });
	const detailSource = await create("box", "MCP Terrain Detail", [0, -500, 0], { size: 10 });
	const setupSource = `
import { dirname, join } from "path";
import { ensureDir } from "fs-extra";
import sharp from "sharp";
import { Bone, Matrix, MorphTarget, MorphTargetManager, Skeleton } from "babylonjs";
export async function main(editor) {
	const scene = editor.layout.preview.scene;
	const directory = join(dirname(editor.state.projectPath), ${JSON.stringify(assetFolder)});
	await ensureDir(directory);
	const pixels = Buffer.alloc(16 * 16 * 4);
	for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
		const offset = (y * 16 + x) * 4;
		pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = Math.round(((x + y) / 30) * 255);
		pixels[offset + 3] = 255;
	}
	await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toFile(join(directory, "heightmap.png"));
	const mesh = scene.getMeshById(${JSON.stringify(base.id)});
	const skeleton = new Skeleton(${JSON.stringify(`MCP Skeleton ${suffix}`)}, ${JSON.stringify(`mcp-skeleton-${suffix}`)}, scene);
	new Bone("Root", skeleton, null, Matrix.Identity());
	mesh.skeleton = skeleton;
	const manager = new MorphTargetManager(scene);
	manager.addTarget(MorphTarget.FromMesh(mesh, "Bulge", 0));
	mesh.morphTargetManager = manager;
	return JSON.stringify({ skeletonId: skeleton.id });
}`;
	const setup = await call("run_agent_script", { name: setupScriptName, content: setupSource });
	skeletonId = JSON.parse(setup.result).skeletonId;
	const skeleton = await call("set_skeleton", {
		skeletonId,
		name: `MCP Skeleton Updated ${suffix}`,
		needInitialSkinMatrix: true,
		createRanges: [{ name: "Idle", from: 0, to: 30 }],
	});
	if (skeleton.name !== `MCP Skeleton Updated ${suffix}` || !skeleton.animationRanges.some((range) => range.name === "Idle"))
		throw new Error("Skeleton update evidence is incomplete.");
	let morphs = await call("get_mesh_morph_targets", { nodeId: base.id });
	if (morphs.targets.length !== 1) throw new Error("Morph-target inspection evidence is incomplete.");
	morphs = await call("set_mesh_morph_targets", { nodeId: base.id, targets: [{ index: 0, influence: 0.5 }] });
	if (morphs.targets[0].influence !== 0.5) throw new Error("Morph-target update evidence is incomplete.");
	await checkpoint("rigging");

	await call("set_ground_heightmap", { nodeId: terrain.id, heightmapPath, minHeight: -20, maxHeight: 80, width: 600, height: 600, subdivisions: 8, smoothFactor: 1 });
	let terrainState = await call("get_terrain", { nodeId: terrain.id });
	if (terrainState.terrain.heightMapTexturePath !== heightmapPath || terrainState.terrain.vertexCount !== 81) throw new Error("Terrain heightmap evidence is incomplete.");
	terrainState = await call("sculpt_terrain", { nodeId: terrain.id, mode: "raise", center: [0, 0], radius: 150, strength: 10 });
	if (terrainState.changedVertices < 1) throw new Error("Terrain sculpt evidence is incomplete.");
	terrainState = await call("carve_terrain_hole", { nodeId: terrain.id, center: [0, 0], radius: 60 });
	if (terrainState.removedTriangles < 1) throw new Error("Terrain hole evidence is incomplete.");
	const details = await call("paint_terrain_details", {
		nodeId: terrain.id,
		sourceNodeId: detailSource.id,
		center: [0, 0],
		radius: 100,
		density: 1,
		layerId: `mcp-details-${suffix}`,
		seed: 7,
	});
	for (const instance of details.paintedInstances) nodeIds.add(instance.id);
	if (details.paintedInstances.length < 1) throw new Error("Terrain detail-paint evidence is incomplete.");
	const scatter = await call("scatter_terrain_instances", {
		nodeId: terrain.id,
		sourceNodeId: detailSource.id,
		count: 3,
		seed: 11,
		scatterId: `mcp-scatter-${suffix}`,
		margin: 10,
	});
	for (const instance of scatter.instances) nodeIds.add(instance.id);
	if (scatter.instances.length !== 3) throw new Error("Terrain scatter evidence is incomplete.");
	await checkpoint("terrain");

	const lodSource = await create("box", "MCP LOD Source", [600, 120, 0], { size: 100 });
	const lodMesh = await create("box", "MCP LOD Mesh", [700, 120, 0], { size: 50 });
	let lods = await call("set_mesh_lods", { nodeId: lodSource.id, lods: [{ meshNodeId: lodMesh.id, distance: 500, includedInExport: true }] });
	if (lods.lods.length !== 1 || lods.lods[0].distance !== 500) throw new Error("Mesh LOD update evidence is incomplete.");
	lods = await call("get_mesh_lods", { nodeId: lodSource.id });
	if (lods.lods.length !== 1) throw new Error("Mesh LOD inspection evidence is incomplete.");
	let collision = await call("set_mesh_collision", { nodeId: lodSource.id, type: "cube" });
	if (!collision.checkCollisions || collision.collisionMesh?.type !== "cube") throw new Error("Mesh collision update evidence is incomplete.");
	collision = await call("get_mesh_collision", { nodeId: lodSource.id });
	if (!collision.collisionMesh) throw new Error("Mesh collision inspection evidence is incomplete.");
	await call("set_mesh_collision", { nodeId: lodSource.id, type: "none" });
	await call("set_mesh_lods", { nodeId: lodSource.id, lods: [] });
	await checkpoint("collision-lod");

	await cleanup();
	const finalDiagnostics = await call("get_scene_diagnostics");
	for (const key of ["meshes", "materials", "textures", "particleSystems"]) {
		if (finalDiagnostics[key] !== baselineDiagnostics[key])
			throw new Error(`Mesh cleanup changed ${key}: ${baselineDiagnostics[key]} -> ${finalDiagnostics[key]}; checkpoints=${JSON.stringify(textureCheckpoints)}.`);
	}
	console.log(
		"[meshes-completion-live] PASS — 26/26 previously uncovered tools, isolated ProBuilder topology, terrain/details/scatter, instances/clones, skeleton/morph, LOD/collision/bounds, and MCP-only cleanup verified."
	);
} catch (error) {
	console.error(`[meshes-completion-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		await cleanup();
	} catch (cleanupError) {
		console.error(`[meshes-completion-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}

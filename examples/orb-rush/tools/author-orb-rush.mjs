#!/usr/bin/env node
/**
 * Authors the whole "Orb Rush" game through the Zvibe Editor MCP server only:
 * level geometry, materials, lights/shadows, Havok physics, sounds, scripts, camera and post-processing.
 *
 * Usage: BABYLONJS_EDITOR_MCP_PORT=3713 node author-orb-rush.mjs <repo>/mcp/server/index.mjs <game-src-dir>
 */
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const [serverPath, sourceDirectory] = process.argv.slice(2);
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const pending = new Map();
let buffer = "";
let nextId = 1;
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	}
});
child.stderr.on("data", () => {});

function rpc(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 300_000);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

let callCount = 0;
async function call(name, args = {}) {
	callCount++;
	const response = await rpc("tools/call", { name, arguments: args });
	const content = response.result?.content ?? [];
	const text = content.find((entry) => entry.type === "text")?.text ?? "";
	if (response.error || response.result?.isError) {
		throw new Error(`${name}(${JSON.stringify(args).slice(0, 300)}) failed: ${text || JSON.stringify(response.error)}`);
	}
	const image = content.find((entry) => entry.type === "image");
	if (image) return { image };
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const idOf = (result) => result?.id ?? result?.node?.id ?? result?.material?.id ?? result?.materialId;

async function material(name, type, properties) {
	const created = await call("create_material", { type, name, folder: "materials" });
	const materialId = idOf(created);
	if (!materialId) throw new Error(`No material id in ${JSON.stringify(created).slice(0, 300)}`);
	if (properties) await call("set_material_properties", { materialId, properties });
	return materialId;
}

async function mesh(type, name, position, options, { rotation, materialId } = {}) {
	const created = await call("create_primitive_mesh", { type, name, position, options });
	const nodeId = idOf(created);
	if (rotation) await call("set_node_transform", { nodeId, rotation });
	if (materialId) await call("set_mesh_material", { nodeId, materialId });
	return nodeId;
}

async function instances(sourceNodeId, name, transforms) {
	const created = await call("create_instance", { sourceNodeId, name, transforms });
	const list = created.instances ?? created.created ?? created.nodes ?? (Array.isArray(created) ? created : []);
	return list.map((entry) => entry.id);
}

async function listFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else files.push(path);
	}
	return files;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "orb-rush-author", version: "1.0.0" } });
	if (initialized.error) throw new Error(JSON.stringify(initialized.error));
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath?.includes("orb-rush")) throw new Error(`Unexpected editor project: ${status.projectPath}`);
	console.log(`[orb-rush] authoring ${status.projectPath}`);

	if (!process.env.FINISH_ONLY) await buildLevel();
	await finish();
	console.log(`[orb-rush] DONE — ${callCount} MCP tool calls.`);
} catch (error) {
	console.error(`[orb-rush] FAIL — ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

async function buildLevel() {
	// 1. Clear the template demo content (keep the sun, sky and camera).
	for (const nodeName of ["box", "ground"]) {
		await call("delete_node", { nodeName, disposeMaterialAndTextures: true }).catch((error) => console.warn(`[orb-rush] ${error.message}`));
	}

	// 2. Materials.
	const floorMaterial = await material("Arena Grid", "grid", {
		mainColor: [0.05, 0.07, 0.16],
		lineColor: [0.25, 0.65, 1],
		gridRatio: 100,
		majorUnitFrequency: 5,
		minorUnitVisibility: 0.35,
		opacity: 1,
	});
	const wallMaterial = await material("Arena Wall", "pbr", { albedoColor: [0.12, 0.16, 0.4], metallic: 0.2, roughness: 0.45, emissiveColor: [0.02, 0.05, 0.16] });
	const plateauMaterial = await material("Plateau", "pbr", { albedoColor: [0.38, 0.2, 0.62], metallic: 0.1, roughness: 0.55 });
	const crateMaterial = await material("Crate", "pbr", { albedoColor: [0.92, 0.48, 0.14], metallic: 0, roughness: 0.65, emissiveColor: [0.08, 0.03, 0] });
	const gemMaterial = await material("Gem", "pbr", { albedoColor: [1, 0.8, 0.2], metallic: 1, roughness: 0.18, emissiveColor: [1, 0.62, 0.08] });
	const playerMaterial = await material("Player Orb", "pbr", { albedoColor: [0.75, 0.95, 1], metallic: 0.85, roughness: 0.12, emissiveColor: [0, 0.32, 0.45] });
	const hazardMaterial = await material("Hazard", "pbr", { albedoColor: [0.95, 0.12, 0.2], metallic: 0.3, roughness: 0.35, emissiveColor: [0.55, 0.03, 0.08] });
	const pillarMaterial = await material("Pillar", "pbr", { albedoColor: [0.2, 0.75, 0.62], metallic: 0.15, roughness: 0.4, emissiveColor: [0, 0.08, 0.06] });

	// 3. Level geometry (centimeters).
	const floor = await mesh("ground", "Arena Floor", [0, 0, 0], { width: 4400, height: 4400, subdivisions: 1 }, { materialId: floorMaterial });
	const wall = await mesh("box", "Wall", [0, 150, 2240], { width: 4560, height: 300, depth: 80 }, { materialId: wallMaterial });
	const walls = await instances(wall, "Wall", [
		{ position: [0, 150, -2240] },
		{ position: [2240, 150, 0], rotation: [0, Math.PI / 2, 0] },
		{ position: [-2240, 150, 0], rotation: [0, Math.PI / 2, 0] },
	]);

	const plateau = await mesh("box", "Plateau", [0, 60, 0], { width: 900, height: 120, depth: 900 }, { materialId: plateauMaterial });
	const rampAngle = Math.asin(120 / 620);
	const rampSouth = await mesh(
		"box",
		"Ramp South",
		[0, 60 - 20 * Math.cos(rampAngle), -754 + 20 * Math.sin(rampAngle)],
		{ width: 400, height: 40, depth: 640 },
		{ rotation: [-rampAngle, 0, 0], materialId: plateauMaterial }
	);
	const rampNorth = await mesh(
		"box",
		"Ramp North",
		[0, 60 - 20 * Math.cos(rampAngle), 754 - 20 * Math.sin(rampAngle)],
		{ width: 400, height: 40, depth: 640 },
		{ rotation: [rampAngle, 0, 0], materialId: plateauMaterial }
	);

	const pillars = [];
	for (const [index, [x, z, height]] of [
		[1100, 1100, 100],
		[1400, 1400, 170],
		[1700, 1700, 240],
	].entries()) {
		pillars.push(await mesh("cylinder", `Pillar ${index + 1}`, [x, height / 2, z], { diameter: 200, height, tessellation: 32 }, { materialId: pillarMaterial }));
	}

	// Spinning hazard with a static hub.
	const sweeper = await mesh("box", "Sweeper Arm", [-1300, 45, 1300], { width: 1600, height: 60, depth: 60 }, { materialId: hazardMaterial });
	const hub = await mesh("cylinder", "Sweeper Hub", [-1300, 60, 1300], { diameter: 150, height: 120, tessellation: 32 }, { materialId: hazardMaterial });

	// Crate pyramids (4-3-2-1) built from instances of one crate.
	const crate = await mesh("box", "Crate", [0, 0, 0], { size: 100 }, { materialId: crateMaterial });
	const crateTransforms = [];
	for (const [centerX, centerZ] of [
		[1300, -1000],
		[-1300, -1000],
	]) {
		for (let row = 0; row < 4; row++) {
			const count = 4 - row;
			for (let i = 0; i < count; i++) crateTransforms.push({ position: [centerX + (i - (count - 1) / 2) * 102, 50.5 + row * 101, centerZ] });
		}
	}
	const [firstCrate, ...otherCrates] = crateTransforms;
	await call("set_node_transform", { nodeId: crate, position: firstCrate.position });
	const crates = [crate, ...(await instances(crate, "Crate", otherCrates))];

	// Gems: one torus source plus instances.
	const gemPositions = [
		[0, 190, 0],
		[300, 190, 300],
		[-300, 190, -300],
		[0, 140, -754],
		[0, 140, 754],
		[1300, 60, -820],
		[-1300, 60, -820],
		[-850, 60, 1300],
		[-1300, 60, 750],
		[-1750, 60, 1300],
		[1700, 320, 1700],
		[1900, 60, -1900],
	];
	const gem = await mesh("torus", "Gem", gemPositions[0], { diameter: 70, thickness: 20, tessellation: 32 }, { rotation: [Math.PI / 2, 0, 0], materialId: gemMaterial });
	await instances(
		gem,
		"Gem",
		gemPositions.slice(1).map((position) => ({ position, rotation: [Math.PI / 2, 0, 0] }))
	);

	const player = await mesh("sphere", "Player", [0, 55, -1350], { diameter: 100, segments: 32 }, { materialId: playerMaterial });

	// 4. Physics (Havok): static world, dynamic crates and player, animated sweeper.
	for (const nodeId of [floor, plateau, rampSouth, rampNorth, hub, ...pillars]) {
		await call("set_mesh_physics", {
			nodeId,
			enabled: true,
			motionType: "static",
			shapeType: nodeId === hub || pillars.includes(nodeId) ? "cylinder" : "box",
			mass: 0,
			friction: 0.8,
			restitution: 0.1,
		});
	}
	for (const nodeId of [wall, ...walls]) {
		await call("set_mesh_physics", { nodeId, enabled: true, motionType: "static", shapeType: "box", mass: 0, friction: 0.4, restitution: 0.5 });
	}
	for (const nodeId of crates) {
		await call("set_mesh_physics", { nodeId, enabled: true, motionType: "dynamic", shapeType: "box", mass: 0.6, friction: 0.6, restitution: 0.15 });
	}
	await call("set_mesh_physics", { nodeId: player, enabled: true, motionType: "dynamic", shapeType: "sphere", mass: 1, friction: 0.9, restitution: 0.25 });
	await call("set_mesh_physics", { nodeId: sweeper, enabled: true, motionType: "animated", shapeType: "box", mass: 0, friction: 0.2, restitution: 0.6 });
	console.log(`[orb-rush] physics validation: ${JSON.stringify(await call("validate_physics_scene")).slice(0, 400)}`);

	// 5. Lighting: sun with soft PCF shadows (shadow list is captured when enabling, so this runs after geometry).
	await call("set_node_transform", { nodeName: "sun", direction: [-0.45, -1, 0.35], position: [2000, 4000, -1500] });
	await call("set_node_properties", { nodeName: "sun", properties: { intensity: 2.2 } });
	await call("set_light_shadows", { nodeName: "sun", enabled: false }).catch(() => undefined);
	await call("set_light_shadows", {
		nodeName: "sun",
		enabled: true,
		generatorType: "classic",
		mapSize: 2048,
		filter: "pcf",
		filteringQuality: "high",
		bias: 0.002,
		normalBias: 0.02,
		darkness: 0.25,
	});
	for (const nodeId of [floor, plateau, rampSouth, rampNorth, ...pillars]) {
		await call("set_node_properties", { nodeId, properties: { receiveShadows: true } });
	}

	// 6. Sounds (original, procedurally generated WAV files copied into assets/audio).
	await call("create_sound", { path: "assets/audio/music.wav", name: "Music", spatial: false, volume: 0.35 });
	for (const [name, file, volume] of [
		["SFX Pickup", "pickup", 0.8],
		["SFX Jump", "jump", 0.6],
		["SFX Impact", "impact", 0.8],
		["SFX Bump", "bump", 0.9],
		["SFX Tick", "tick", 0.6],
		["SFX Start", "start", 0.7],
		["SFX Win", "win", 0.9],
		["SFX Lose", "lose", 0.9],
	]) {
		await call("create_sound", { path: `assets/audio/${file}.wav`, name, spatial: false, volume });
	}
	await call("create_sound", {
		path: "assets/audio/impact.wav",
		name: "SFX Crate",
		spatial: true,
		volume: 0.8,
		maxDistance: 4000,
		distanceModel: "inverse",
		position: [0, 50, 0],
	});

	// 7. Scripts: write sources, type-check, attach.
	for (const file of await listFiles(join(sourceDirectory, "src"))) {
		const path = relative(sourceDirectory, file).split("\\").join("/");
		await call("create_script", { path, template: "empty" }).catch(() => undefined);
		await call("write_script", { path, content: await readFile(file, "utf8") });
	}
	for (const path of ["src/scripts/player-controller.ts", "src/scripts/follow-camera.ts", "src/scripts/spinner.ts", "src/scripts/game-manager.ts"]) {
		const diagnostics = await call("get_script_semantic_diagnostics", { path });
		const errors = (diagnostics.diagnostics ?? []).filter((entry) => entry.category === "error" || entry.severity === "error");
		console.log(`[orb-rush] ${path}: ${errors.length} error(s)${errors.length ? ` ${JSON.stringify(errors).slice(0, 800)}` : ""}`);
	}
	await call("attach_script", { nodeId: player, path: "src/scripts/player-controller.ts" });
	await call("attach_script", { nodeName: "camera", path: "src/scripts/follow-camera.ts" });
	await call("attach_script", { nodeId: sweeper, path: "src/scripts/spinner.ts" });
	await call("attach_script", { path: "src/scripts/game-manager.ts" });
}

async function finish() {
	// 8. Camera and post-processing.
	await call("set_node_transform", { nodeName: "camera", position: [0, 485, -2120], target: [0, 115, -1350] });
	await call("set_camera_properties", { nodeName: "camera", properties: { fov: 0.9, minZ: 10, maxZ: 20000 } });
	await call("set_active_camera", { nodeName: "camera" });
	await call("set_camera_post_process", {
		nodeName: "camera",
		type: "default",
		enabled: true,
		properties: {
			bloomEnabled: true,
			bloomWeight: 0.45,
			bloomThreshold: 0.7,
			bloomKernel: 64,
			toneMappingEnabled: true,
			toneMappingType: 1,
			exposure: 1.15,
			contrast: 1.15,
			vignetteEnabled: true,
			vignetteWeight: 1.6,
			fxaaEnabled: true,
		},
	});

	// 9. Save and capture a preview.
	await call("save_scene");
	await call("focus_node", { nodeName: "Plateau" }).catch(() => undefined);
	const screenshot = await call("get_screenshot", { width: 1280, height: 720 });
	if (screenshot?.image?.data) {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(sourceDirectory, "editor-preview.png"), Buffer.from(screenshot.image.data, "base64"));
	}
}

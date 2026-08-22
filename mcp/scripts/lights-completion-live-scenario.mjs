#!/usr/bin/env node
/** Positive live lifecycle for all previously uncovered Lighting MCP tools. */
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

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"bake_baked_gi",
	"clear_baked_gi",
	"create_light_probe_volume",
	"set_light_probe_volume",
	"bake_light_probe_volume",
	"delete_light_probe_volume",
	"create_lighting_scenario",
	"apply_lighting_scenario",
	"blend_lighting_scenario",
	"delete_lighting_scenario",
	"get_light",
	"create_area_light",
	"get_area_light",
	"set_area_light",
	"get_light_cookie",
	"set_light_cookie",
	"clear_light_cookie",
	"set_light_properties",
	"set_ibl_shadows",
	"set_light_shadows",
	"remove_light_shadows",
	"create_clustered_light_container",
	"add_light_to_clustered_container",
	"remove_light_from_clustered_container",
];
const suffix = `${Date.now()}-${process.pid}`;
const cookieFolder = `assets/mcp-lights-${suffix}`;
const cookiePath = `${cookieFolder}/cookie.png`;
const setupScriptName = `lights-cookie-setup-${suffix}.js`;
const probeName = `MCP Probe Volume ${suffix}`;
const scenarioName = `MCP Lighting Scenario ${suffix}`;
const nodeIds = new Set();
let material;
let probe;
let scenario;

async function cleanup() {
	if (scenario?.id) {
		const current = await call("list_lighting_scenarios", { id: scenario.id }).catch(() => undefined);
		const entry = current?.scenarios?.[0];
		if (entry) await call("delete_lighting_scenario", { id: entry.id, expectedRevision: entry.revision, confirm: true }).catch(() => undefined);
	}
	if (probe?.id) {
		const current = await call("list_light_probe_volumes", { id: probe.id, limit: 1 }).catch(() => undefined);
		const entry = current?.volumes?.[0];
		if (entry) await call("delete_light_probe_volume", { id: entry.id, expectedRevision: entry.revision, confirm: true }).catch(() => undefined);
	}
	const gi = await call("get_baked_gi").catch(() => undefined);
	if (gi?.configured) await call("clear_baked_gi", { expectedBakeId: gi.bakeId, confirm: true }).catch(() => undefined);
	for (const nodeId of [...nodeIds].reverse()) await call("delete_node", { nodeId }).catch(() => undefined);
	if (material?.id) await call("delete_material", { materialId: material.id }).catch(() => undefined);
	for (const assetPath of [
		material?.path,
		`${cookiePath}.bjsmeta.json`,
		cookiePath,
		cookieFolder,
		`agentdata/${setupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
	].filter(Boolean)) {
		await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
	}
	await call("set_ibl_shadows", { enabled: false }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lights-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Lighting completion testing.");

	const surface = await call("create_primitive_mesh", {
		type: "ground",
		name: `MCP GI Surface ${suffix}`,
		position: [0, 0, 0],
		options: { width: 300, height: 300, subdivisions: 1 },
	});
	const receiver = await call("create_primitive_mesh", { type: "box", name: `MCP Probe Receiver ${suffix}`, position: [0, 60, 0], options: { size: 100 } });
	nodeIds.add(surface.id);
	nodeIds.add(receiver.id);
	material = await call("create_material", { type: "standard", name: `MCP GI Material ${suffix}`, folder: cookieFolder });
	await call("set_mesh_material", { nodeId: surface.id, materialId: material.id });
	await call("set_mesh_material", { nodeId: receiver.id, materialId: material.id });

	const directional = await call("create_light", { type: "directional", name: `MCP Sun ${suffix}`, direction: [-0.4, -1, 0.2], color: [1, 0.9, 0.75], intensity: 1.5 });
	const spot = await call("create_light", {
		type: "spot",
		name: `MCP Cookie Spot ${suffix}`,
		position: [0, 250, 0],
		direction: [0, -1, 0],
		color: [0.8, 0.9, 1],
		intensity: 2,
		range: 800,
		angle: 1,
	});
	const point = await call("create_light", { type: "point", name: `MCP Cluster Point ${suffix}`, position: [150, 100, 0], color: [1, 0.3, 0.2], intensity: 1, range: 500 });
	for (const light of [directional, spot, point]) nodeIds.add(light.id);
	const light = await call("get_light", { nodeId: directional.id });
	if (light.className !== "DirectionalLight") throw new Error("Directional light readback is incomplete.");
	await call("set_light_properties", { nodeId: directional.id, direction: [-0.25, -1, 0.1], diffuse: [1, 0.85, 0.7], specular: [1, 1, 1], properties: { intensity: 1.25 } });
	await call("set_light_shadows", {
		nodeId: directional.id,
		enabled: true,
		generatorType: "classic",
		mapSize: 256,
		filter: "pcf",
		filteringQuality: "low",
		bias: 0.001,
		normalBias: 0.02,
		darkness: 0.2,
	});
	await call("remove_light_shadows", { nodeId: directional.id });

	const container = await call("create_clustered_light_container");
	if (!container.id) throw new Error("Clustered light container creation evidence is incomplete.");
	await call("add_light_to_clustered_container", { nodeId: point.id });
	await call("remove_light_from_clustered_container", { nodeId: point.id });
	await call("set_ibl_shadows", { enabled: false, properties: { resolutionExp: 6, sampleDirections: 2, shadowRemanence: 0.75, shadowOpacity: 0.5 } });

	const area = await call("create_area_light", {
		shape: "rectangle",
		name: `MCP Area ${suffix}`,
		position: [-150, 200, 0],
		direction: [0, -1, 0],
		upDirection: [0, 0, 1],
		width: 180,
		height: 90,
		color: [1, 0.7, 0.5],
		intensity: 2,
		range: 800,
	});
	nodeIds.add(area.light.id);
	let areaRead = await call("get_area_light", { nodeId: area.light.id });
	await call("set_area_light", { nodeId: area.light.id, expectedRevision: areaRead.areaLight.revision, shape: "disc", radius: 75, intensity: 2.5, enabled: true });
	areaRead = await call("get_area_light", { nodeId: area.light.id });
	if (areaRead.areaLight.shape !== "disc") throw new Error("Area-light mutation evidence is incomplete.");

	const cookieSource = `
import { dirname, join } from "path";
import { ensureDir } from "fs-extra";
import sharp from "sharp";
export async function main(editor) {
	const folder = join(dirname(editor.state.projectPath), ${JSON.stringify(cookieFolder)});
	await ensureDir(folder);
	const pixels = Buffer.from([255,255,255,255, 0,0,0,255, 0,0,0,255, 255,255,255,255]);
	await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(join(folder, "cookie.png"));
	return "cookie texture created";
}`;
	await call("run_agent_script", { name: setupScriptName, content: cookieSource });
	let cookie = await call("get_light_cookie", { nodeId: spot.id });
	if (cookie.cookie !== null) throw new Error("Fresh spot light unexpectedly has a cookie.");
	await call("set_light_cookie", { nodeId: spot.id, texturePath: cookiePath, enabled: true, intensity: 0.8, near: 1, far: 800, upDirection: [0, 0, 1] });
	cookie = await call("get_light_cookie", { nodeId: spot.id });
	if (!cookie.cookie?.revision) throw new Error("Light-cookie assignment evidence is incomplete.");
	await call("clear_light_cookie", { nodeId: spot.id, expectedRevision: cookie.cookie.revision, confirm: true });

	const gi = await call("bake_baked_gi", {
		meshIds: [surface.id],
		resolution: 16,
		samples: 1,
		bounces: 0,
		shadowing: false,
		dilation: 0,
		uvChannel: "uv0",
		outputDirectory: `${cookieFolder}/BakedGI`,
	});
	if (!gi.configured || !gi.bakeId) throw new Error("Baked-GI evidence is incomplete.");
	await call("clear_baked_gi", { expectedBakeId: gi.bakeId, confirm: true });

	const createdProbe = await call("create_light_probe_volume", {
		name: probeName,
		minimum: [-200, 0, -200],
		maximum: [200, 250, 200],
		baseResolution: [2, 2, 2],
		adaptiveLevels: 0,
		blendDistance: 50,
		targetMeshIds: [receiver.id],
	});
	probe = createdProbe.volume;
	let volumes = await call("list_light_probe_volumes", { id: probe.id, limit: 1 });
	await call("set_light_probe_volume", {
		id: probe.id,
		expectedRevision: volumes.volumes[0].revision,
		newName: `${probeName} Updated`,
		priority: 1,
		blendDistance: 60,
		enabled: true,
	});
	volumes = await call("list_light_probe_volumes", { id: probe.id, limit: 1 });
	const bakedProbe = await call("bake_light_probe_volume", {
		id: probe.id,
		expectedRevision: volumes.volumes[0].revision,
		samples: 8,
		maxDistance: 1000,
		shadowBias: 1,
		environmentIntensity: 0.5,
		directIntensity: 1,
		bounceIntensity: 0,
		geometryMeshIds: [surface.id],
	});
	probe = bakedProbe.volume;
	if (!bakedProbe.baked || !probe.bake?.bakeId || probe.bake.evidence?.probeCount < 8) throw new Error("Light Probe Volume bake evidence is incomplete.");
	await call("delete_light_probe_volume", { id: probe.id, expectedRevision: probe.revision, confirm: true });
	probe = undefined;

	scenario = await call("create_lighting_scenario", { name: scenarioName, lightNodeIds: [directional.id, spot.id, point.id, area.light.id], captureBakedLighting: false });
	await call("apply_lighting_scenario", { id: scenario.id, expectedRevision: scenario.revision });
	await call("blend_lighting_scenario", { id: scenario.id, expectedRevision: scenario.revision, durationMs: 0 });
	await call("delete_lighting_scenario", { id: scenario.id, expectedRevision: scenario.revision, confirm: true });
	scenario = undefined;

	await cleanup();
	console.log(
		`[lights-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, GI/probes/scenarios/area/cookies/shadows/clustering, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[lights-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

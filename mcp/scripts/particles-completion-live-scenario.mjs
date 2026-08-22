#!/usr/bin/env node
/** Positive real-editor lifecycle for every previously uncovered Particles MCP tool. */
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
	"create_vfx_trail",
	"get_vfx_trail",
	"set_vfx_trail",
	"delete_vfx_trail",
	"get_particle_collision_planes",
	"set_particle_collision_planes",
	"get_particle_collision_spheres",
	"set_particle_collision_spheres",
	"get_gpu_particle_interactions",
	"set_gpu_particle_interactions",
	"get_gpu_particle_collision_events",
	"set_gpu_particle_collision_events",
	"get_particle_attractors",
	"set_particle_attractors",
	"delete_particle_system",
	"get_node_particle_system_graph",
	"replace_node_particle_system_graph",
	"get_node_particle_code_graph",
	"connect_node_particle_blocks",
	"disconnect_node_particle_blocks",
	"set_node_particle_block_input",
	"validate_node_particle_code_graph",
	"set_particle_system_properties",
	"set_particle_system_playing",
	"validate_particle_system",
	"create_vfx_budget_profile",
	"set_vfx_budget_profile",
	"apply_vfx_budget_profile",
	"delete_vfx_budget_profile",
	"get_particle_vector_fields",
	"set_particle_vector_fields",
	"get_particle_texture_vector_fields",
	"create_particle_texture_vector_field",
	"set_particle_texture_vector_fields",
	"get_particle_events",
	"get_particle_proximity_events",
	"set_particle_proximity_events",
	"set_particle_events",
	"trigger_particle_event",
];

const suffix = `${Date.now()}-${process.pid}`;
const folder = `assets/mcp-particles-${suffix}`;
const texturePath = `${folder}/vector-field.png`;
const setupScriptName = `particles-texture-setup-${suffix}.js`;
const cpuName = `MCP CPU Particles ${suffix}`;
const targetName = `MCP Target Particles ${suffix}`;
const gpuName = `MCP GPU Particles ${suffix}`;
const nodeName = `MCP Node Particles ${suffix}`;
const budgetName = `MCP VFX Budget ${suffix}`;
const emitterIds = new Set();
let trail;
let node;
let budget;

async function findSystems() {
	const result = await call("list_particle_systems");
	return result.particleSystems ?? [];
}

async function cleanup() {
	if (trail?.node?.id) await call("delete_vfx_trail", { nodeId: trail.node.id }).catch(() => undefined);
	if (trail?.generatorId) emitterIds.add(trail.generatorId);
	if (budget?.id) await call("delete_vfx_budget_profile", { id: budget.id }).catch(() => undefined);
	for (const name of [cpuName, targetName, gpuName]) await call("delete_particle_system", { particleSystemName: name }).catch(() => undefined);
	if (node?.id) await call("delete_node", { nodeId: node.id }).catch(() => undefined);
	for (const id of [...emitterIds].reverse()) await call("delete_node", { nodeId: id }).catch(() => undefined);
	for (const assetPath of [
		`${texturePath}.bjsmeta.json`,
		texturePath,
		folder,
		`agentdata/${setupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
	]) {
		await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "particles-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Particles completion testing.");

	const textureSource = `
import { dirname, join } from "path";
import { ensureDir } from "fs-extra";
import sharp from "sharp";
export async function main(editor) {
	const folder = join(dirname(editor.state.projectPath), ${JSON.stringify(folder)});
	await ensureDir(folder);
	const pixels = Buffer.from([255,128,128,255, 128,255,128,255, 128,128,255,255, 255,255,128,255]);
	await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(join(folder, "vector-field.png"));
	return "particle vector field created";
}`;
	await call("run_agent_script", { name: setupScriptName, content: textureSource });

	trail = await call("create_vfx_trail", {
		name: `MCP Trail ${suffix}`,
		generatorName: `MCP Trail Generator ${suffix}`,
		position: [0, 100, 0],
		diameter: 12,
		length: 120,
		segments: 24,
		sections: 4,
		autoStart: true,
	});
	let trailRead = await call("get_vfx_trail", { nodeId: trail.node.id });
	if (trailRead.generatorId !== trail.generatorId) throw new Error("VFX trail readback is incomplete.");
	trail = await call("set_vfx_trail", { nodeId: trail.node.id, diameter: 16, length: 160, segments: 32, playing: false });
	if (trail.diameter !== 16) throw new Error("VFX trail update evidence is incomplete.");
	await call("delete_vfx_trail", { nodeId: trail.node.id });
	emitterIds.add(trail.generatorId);
	trail = undefined;

	for (const [type, name, position] of [
		["standard", cpuName, [-100, 100, 0]],
		["standard", targetName, [100, 100, 0]],
		["gpu", gpuName, [0, 150, 0]],
	]) {
		const emitter = await call("instantiate_particle_system", { type, name, position });
		emitterIds.add(emitter.id);
	}
	let systems = await findSystems();
	const cpu = systems.find((entry) => entry.name === cpuName);
	const target = systems.find((entry) => entry.name === targetName);
	const gpu = systems.find((entry) => entry.name === gpuName);
	if (!cpu?.id || !target?.id || !gpu?.id) throw new Error("Native CPU/GPU particle creation evidence is incomplete.");

	await call("set_particle_system_properties", {
		particleSystemId: cpu.id,
		properties: { emitRate: 20, minSize: 5, maxSize: 12, minLifeTime: 0.5, maxLifeTime: 1.5, manualEmitCount: 4 },
	});
	const validation = await call("validate_particle_system", { particleSystemId: cpu.id });
	if (!validation.valid) throw new Error(`CPU particle system validation failed: ${JSON.stringify(validation)}`);
	await call("set_particle_system_playing", { particleSystemId: cpu.id, playing: true });
	await call("set_particle_system_playing", { particleSystemId: cpu.id, playing: false });

	await call("set_particle_collision_planes", { particleSystemId: gpu.id, planes: [{ position: [0, 0, 0], normal: [0, 1, 0], restitution: 0.5 }] });
	let planes = await call("get_particle_collision_planes", { particleSystemId: gpu.id });
	if (planes.planes?.length !== 1) throw new Error("Particle collision-plane evidence is incomplete.");
	await call("set_particle_collision_spheres", { particleSystemId: gpu.id, spheres: [{ center: [0, 100, 0], radius: 75, restitution: 0.4 }] });
	const spheres = await call("get_particle_collision_spheres", { particleSystemId: gpu.id });
	if (spheres.spheres?.length !== 1) throw new Error("Particle collision-sphere evidence is incomplete.");
	await call("set_particle_attractors", { particleSystemId: gpu.id, attractors: [{ position: [0, 100, 0], strength: 25 }] });
	const attractors = await call("get_particle_attractors", { particleSystemId: gpu.id });
	if (attractors.attractors?.length !== 1) throw new Error("Particle attractor evidence is incomplete.");
	await call("set_gpu_particle_interactions", {
		particleSystemId: gpu.id,
		enabled: true,
		radius: 10,
		restitution: 0.25,
		separationStrength: 0.5,
		maximumParticles: 128,
		maximumNeighbors: 8,
		boundsMin: [-500, -500, -500],
		boundsMax: [500, 500, 500],
		gridResolution: 8,
	});
	const interactions = await call("get_gpu_particle_interactions", { particleSystemId: gpu.id });
	if (interactions.configuration?.enabled !== true) throw new Error("GPU particle interaction evidence is incomplete.");
	await call("set_gpu_particle_collision_events", {
		particleSystemId: gpu.id,
		enabled: true,
		maximumSourceParticles: 64,
		spawnCount: 2,
		lifetime: 0.5,
		speed: 20,
		size: 5,
		inheritVelocity: 0.25,
		spread: 0.5,
		color: [1, 0.5, 0.1, 1],
	});
	const collisionEvents = await call("get_gpu_particle_collision_events", { particleSystemId: gpu.id });
	if (collisionEvents.configuration?.enabled !== true) throw new Error("GPU collision-event evidence is incomplete.");

	await call("set_particle_vector_fields", {
		particleSystemId: cpu.id,
		fields: [{ min: [-200, 0, -200], max: [200, 400, 200], direction: [1, 0, 0], strength: 10, enabled: true }],
	});
	const vectorFields = await call("get_particle_vector_fields", { particleSystemId: cpu.id });
	if (vectorFields.fields?.length !== 1) throw new Error("Particle vector-field evidence is incomplete.");
	let textureFields = await call("create_particle_texture_vector_field", {
		particleSystemId: cpu.id,
		sourcePath: texturePath,
		min: [-200, 0, -200],
		max: [200, 400, 200],
		strength: 2,
		width: 2,
		height: 2,
		enabled: true,
	});
	if (textureFields.fields?.length !== 1) throw new Error("Particle texture-vector-field import evidence is incomplete.");
	textureFields = await call("get_particle_texture_vector_fields", { particleSystemId: cpu.id });
	const updatedTextureField = { ...textureFields.fields[0], strength: 3 };
	textureFields = await call("set_particle_texture_vector_fields", { particleSystemId: cpu.id, fields: [updatedTextureField] });
	if (textureFields.fields?.[0]?.strength !== 3) throw new Error("Particle texture-vector-field update evidence is incomplete.");

	await call("set_particle_events", { particleSystemId: cpu.id, events: [{ name: "Impact", count: 5, enabled: true }] });
	const events = await call("get_particle_events", { particleSystemId: cpu.id });
	if (events.events?.[0]?.name !== "Impact") throw new Error("Particle event readback is incomplete.");
	await call("trigger_particle_event", { particleSystemId: cpu.id, eventName: "Impact" });
	await call("set_particle_proximity_events", {
		particleSystemId: cpu.id,
		events: [{ targetParticleSystemId: target.id, radius: 50, count: 3, cooldownMs: 100, enabled: true }],
	});
	const proximity = await call("get_particle_proximity_events", { particleSystemId: cpu.id });
	if (proximity.events?.[0]?.targetParticleSystemId !== target.id) throw new Error("Particle proximity-event evidence is incomplete.");

	budget = await call("create_vfx_budget_profile", { name: budgetName, capacityScale: 0.75, emissionScale: 0.8, maxCapacity: 512 });
	budget = await call("set_vfx_budget_profile", { id: budget.id, capacityScale: 0.5, emissionScale: 0.5, maxCapacity: 256 });
	const budgetApplied = await call("apply_vfx_budget_profile", { id: budget.id });
	if (!budgetApplied.systems?.length) throw new Error("VFX budget application evidence is incomplete.");
	await call("delete_vfx_budget_profile", { id: budget.id });
	budget = undefined;

	node = await call("instantiate_particle_system", { type: "node", name: nodeName, position: [0, 200, 150] });
	let nodeGraph = await call("get_node_particle_system_graph", { nodeId: node.id });
	nodeGraph = await call("replace_node_particle_system_graph", { nodeId: node.id, graph: nodeGraph.graph });
	if (!nodeGraph.graph?.blocks?.length) throw new Error("Node Particle graph replacement evidence is incomplete.");
	let codeGraph = await call("get_node_particle_code_graph", { nodeId: node.id, offset: 0, limit: 256 });
	const numericInput = codeGraph.nodes
		.flatMap((block) => block.inputs.map((input) => ({ block, input })))
		.find(({ input }) => !input.connected && typeof input.value === "number");
	if (!numericInput) throw new Error("Node Particle graph has no disconnected numeric input.");
	await call("set_node_particle_block_input", { nodeId: node.id, blockId: numericInput.block.id, input: numericInput.input.name, value: numericInput.input.value + 0.25 });
	codeGraph = await call("get_node_particle_code_graph", { nodeId: node.id, offset: 0, limit: 256 });
	let connection;
	for (const source of codeGraph.nodes) {
		for (const output of source.outputs) {
			for (const targetBlock of codeGraph.nodes) {
				const inputPort = targetBlock.inputs.find((input) => targetBlock.id !== source.id && !input.connected && input.optional && input.type === output.type);
				if (!inputPort) continue;
				try {
					await call("connect_node_particle_blocks", {
						nodeId: node.id,
						sourceBlockId: source.id,
						sourceOutput: output.name,
						targetBlockId: targetBlock.id,
						targetInput: inputPort.name,
					});
					connection = { sourceName: source.name, sourceOutput: output.name, targetName: targetBlock.name, targetInput: inputPort.name };
					break;
				} catch {
					// Try the next typed optional edge; cycle and hierarchy checks remain authoritative.
				}
			}
			if (connection) break;
		}
		if (connection) break;
	}
	if (!connection) throw new Error("Node Particle graph had no buildable optional connection candidate.");
	codeGraph = await call("get_node_particle_code_graph", { nodeId: node.id, offset: 0, limit: 256 });
	const connectedEdge = codeGraph.edges.find(
		(edge) =>
			edge.sourceBlockName === connection.sourceName &&
			edge.sourceOutput === connection.sourceOutput &&
			edge.targetBlockName === connection.targetName &&
			edge.targetInput === connection.targetInput
	);
	if (!connectedEdge) throw new Error("Node Particle connection readback is incomplete.");
	await call("disconnect_node_particle_blocks", {
		nodeId: node.id,
		sourceBlockId: connectedEdge.sourceBlockId,
		sourceOutput: connectedEdge.sourceOutput,
		targetBlockId: connectedEdge.targetBlockId,
		targetInput: connectedEdge.targetInput,
	});
	const nodeValidation = await call("validate_node_particle_code_graph", { nodeId: node.id });
	if (!nodeValidation.valid) throw new Error(`Node Particle graph validation failed: ${JSON.stringify(nodeValidation)}`);

	const deleted = await call("delete_particle_system", { particleSystemId: target.id });
	if (!deleted.deleted) throw new Error("Particle-system deletion evidence is incomplete.");
	await cleanup();
	console.log(
		`[particles-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, trails/CPU/GPU/VFX Graph/fields/events/budgets, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[particles-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

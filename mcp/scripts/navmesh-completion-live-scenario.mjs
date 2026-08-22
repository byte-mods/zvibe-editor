#!/usr/bin/env node
/** Positive live lifecycle for all previously uncovered NavMesh MCP tools. */
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
	"list_navmesh_areas",
	"set_navmesh_areas",
	"list_navmesh_surfaces",
	"set_navmesh_surface_area",
	"sample_navmesh_area",
	"list_navmesh_obstacles",
	"create_navmesh_obstacle",
	"set_navmesh_obstacle",
	"delete_navmesh_obstacle",
	"get_navmesh_obstacle_runtime",
	"refresh_navmesh_obstacles",
	"list_navmesh_links",
	"create_navmesh_link",
	"set_navmesh_link",
	"delete_navmesh_link",
	"compute_navmesh_path",
	"create_nav_agent",
	"set_nav_agent",
	"set_nav_agent_destination",
	"delete_nav_agent",
	"start_nav_agent",
	"stop_nav_agent",
	"set_nav_crowd",
	"get_nav_agent_runtime",
	"teleport_nav_agent",
	"get_navmesh",
	"create_navmesh",
	"set_navmesh_configuration",
	"rebuild_navmesh",
	"get_navmesh_data",
];
const suffix = `${Date.now()}-${process.pid}`;
const path = `assets/mcp-navmesh-${suffix}.navmesh`;
const agentId = `mcp-nav-agent-${suffix}`;
const linkId = `mcp-nav-link-${suffix}`;
const nodeIds = new Set();
let obstacleId;

async function cleanup() {
	await call("delete_nav_agent", { id: agentId }).catch(() => undefined);
	if (obstacleId) await call("delete_navmesh_obstacle", { path, nodeId: obstacleId }).catch(() => undefined);
	await call("delete_navmesh_link", { path, id: linkId }).catch(() => undefined);
	for (const nodeId of [...nodeIds].reverse()) await call("delete_node", { nodeId }).catch(() => undefined);
	for (const assetPath of [`${path}.bjsmeta.json`, path]) await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "navmesh-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for NavMesh completion testing.");

	const ground = await call("create_primitive_mesh", {
		type: "ground",
		name: `MCP Nav Ground ${suffix}`,
		position: [0, 0, 0],
		options: { width: 1000, height: 500, subdivisions: 2 },
	});
	const mudGround = await call("create_primitive_mesh", {
		type: "ground",
		name: `MCP Nav Mud ${suffix}`,
		position: [0, 0, 400],
		options: { width: 200, height: 200, subdivisions: 1 },
	});
	const obstacle = await call("create_primitive_mesh", { type: "box", name: `MCP Nav Obstacle ${suffix}`, position: [0, 50, 0], options: { width: 80, height: 100, depth: 80 } });
	const agentNode = await call("create_primitive_mesh", { type: "sphere", name: `MCP Nav Agent ${suffix}`, position: [-300, 0, 0], options: { diameter: 40, segments: 8 } });
	for (const node of [ground, mudGround, obstacle, agentNode]) nodeIds.add(node.id);
	obstacleId = obstacle.id;

	await call("create_navmesh", {
		path,
		configuration: {
			navMeshParameters: { cs: 10, ch: 2, walkableHeight: 90, walkableClimb: 20, walkableRadius: 20, tileSize: 32, maxObstacles: 8, expectedLayersPerTile: 1 },
			staticMeshes: [
				{ id: ground.id, enabled: true, area: 0 },
				{ id: mudGround.id, enabled: true, area: 0 },
			],
			obstacleMeshes: [],
			areas: [{ id: 0, name: "Walkable", cost: 1 }],
		},
	});
	let navmesh = await call("get_navmesh", { path });
	if (!navmesh.configuration?.staticMeshes?.length) throw new Error("NavMesh configuration readback is incomplete.");
	await call("set_navmesh_areas", {
		path,
		areas: [
			{ id: 0, name: "Walkable", cost: 1 },
			{ id: 4, name: "Mud", cost: 3 },
		],
	});
	const areas = await call("list_navmesh_areas", { path });
	if (areas.areas?.length !== 2) throw new Error("NavMesh area readback is incomplete.");
	await call("set_navmesh_configuration", {
		path,
		configuration: {
			navMeshParameters: { cs: 10, ch: 2, walkableHeight: 90, walkableClimb: 20, walkableRadius: 20, tileSize: 32, maxObstacles: 8, expectedLayersPerTile: 1 },
			staticMeshes: [
				{ id: ground.id, enabled: true, area: 0 },
				{ id: mudGround.id, enabled: true, area: 0 },
			],
			obstacleMeshes: [],
		},
	});
	await call("set_navmesh_surface_area", { path, nodeId: mudGround.id, area: 4 });
	const surfaces = await call("list_navmesh_surfaces", { path });
	if (!surfaces.surfaces?.some((surface) => surface.id === mudGround.id && surface.area === 4)) throw new Error("NavMesh surface-area painting evidence is incomplete.");
	const link = await call("create_navmesh_link", { path, id: linkId, start: [-100, 0, -50], end: [100, 0, 50], radius: 20, bidirectional: true, area: 0, flags: 1 });
	await call("set_navmesh_link", { path, id: link.id, radius: 25, bidirectional: true, area: 0 });
	const links = await call("list_navmesh_links", { path });
	if (!links.links?.some((entry) => entry.id === link.id)) throw new Error("NavMesh link readback is incomplete.");
	await call("delete_navmesh_link", { path, id: link.id });

	const rebuilt = await call("rebuild_navmesh", { path });
	if (!rebuilt.rebuilt) throw new Error("NavMesh rebuild did not report success.");
	const data = await call("get_navmesh_data", { path });
	if (!data.navmeshBase64 || !data.tileCacheBase64) throw new Error("Generated NavMesh binary evidence is missing.");
	const sample = await call("sample_navmesh_area", { path, position: [0, 0, 400], halfExtents: [100, 100, 100] });
	if (sample.area?.id !== 4) throw new Error("NavMesh area sampling did not find the painted area.");
	const routeStart = await call("sample_navmesh_area", { path, position: [-300, 0, 0], halfExtents: [100, 100, 100] });
	const routeEnd = await call("sample_navmesh_area", { path, position: [300, 0, 0], halfExtents: [100, 100, 100] });
	const route = await call("compute_navmesh_path", { path, start: routeStart.nearestPoint, destination: routeEnd.nearestPoint, areaCosts: { 4: 2 } });
	if (!route.path?.length) throw new Error(`NavMesh route computation returned no points: ${JSON.stringify(route)}`);
	await call("set_nav_crowd", {
		navMeshPath: path,
		maxAgents: 16,
		maxAgentRadius: 25,
		timeStep: 1 / 60,
		maxSubStepCount: 4,
		queryExtent: [100, 200, 100],
		filters: [{ index: 0, includeFlags: 65535, excludeFlags: 0, areaCosts: { 4: 2 } }],
	});

	await call("create_navmesh_obstacle", {
		path,
		nodeId: obstacle.id,
		type: "box",
		carving: true,
		dynamic: true,
		moveThreshold: 1,
		timeToStationary: 0.05,
		updateInterval: 0.01,
	});
	await call("set_navmesh_obstacle", { path, nodeId: obstacle.id, carveOnlyStationary: false, moveThreshold: 2, updateInterval: 0.02, enabled: true });
	const obstacles = await call("list_navmesh_obstacles", { path });
	if (!obstacles.obstacles?.some((entry) => entry.id === obstacle.id)) throw new Error("NavMesh obstacle readback is incomplete.");

	const agent = await call("create_nav_agent", {
		id: agentId,
		nodeId: agentNode.id,
		navMeshPath: path,
		radius: 20,
		height: 180,
		maxSpeed: 3,
		maxAcceleration: 8,
		collisionQueryRange: 100,
		separationWeight: 2,
	});
	if (agent.id !== agentId) throw new Error("NavMesh agent creation evidence is incomplete.");
	await call("teleport_nav_agent", { id: agentId, position: routeStart.nearestPoint });
	await call("refresh_navmesh_obstacles", { path });
	const obstacleRuntime = await call("get_navmesh_obstacle_runtime", { path, nodeId: obstacle.id });
	if (obstacleRuntime.id !== obstacle.id) throw new Error("NavMesh obstacle runtime evidence is incomplete.");
	await call("set_nav_agent", { id: agentId, maxSpeed: 4, maxAcceleration: 10, avoidanceEnabled: true, updateRotation: true, angularSpeed: 3, autoRepath: true });
	const planned = await call("set_nav_agent_destination", { id: agentId, destination: routeEnd.nearestPoint, startMoving: false });
	if (planned.pointCount < 2) throw new Error(`NavMesh agent destination produced no route: ${JSON.stringify(planned)}`);
	await call("start_nav_agent", { id: agentId });
	const runtime = await call("get_nav_agent_runtime", { id: agentId });
	if (runtime.id !== agentId || runtime.crowdAgentIndex === null) throw new Error("Live Detour agent evidence is incomplete.");
	await call("stop_nav_agent", { id: agentId });
	const warped = await call("teleport_nav_agent", { id: agentId, position: [0, 0, 0] });
	if (Math.abs(warped.position?.[0] ?? Infinity) > 0.01) throw new Error("NavMesh agent teleport evidence is incomplete.");
	await call("delete_nav_agent", { id: agentId });
	await call("delete_navmesh_obstacle", { path, nodeId: obstacle.id });
	obstacleId = undefined;
	await cleanup();
	console.log(
		`[navmesh-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, Recast rebuild/data/areas/links/obstacles/crowd agents, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[navmesh-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

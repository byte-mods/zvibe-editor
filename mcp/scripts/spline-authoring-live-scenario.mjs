#!/usr/bin/env node
/** Positive live lifecycle for spline edit/assets/terrain projection/evaluation/followers. */
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

function rpc(method, params = {}, timeoutMs = 120_000) {
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
const assetPath = `assets/mcp-spline-${suffix}.spline.json`;
const nodeIds = [];

async function cleanup() {
	for (const nodeId of nodeIds.reverse()) await call("delete_node", { nodeId }).catch(() => undefined);
	nodeIds.length = 0;
	await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "spline-authoring-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.activeScenePath) throw new Error("A ready editor with an active scene is required.");
	const baseline = await call("get_scene_diagnostics");
	const terrain = await call("create_primitive_mesh", {
		type: "ground",
		name: `MCP Spline Terrain ${suffix}`,
		position: [0, 0, 0],
		options: { width: 1000, height: 1000, subdivisions: 4 },
	});
	nodeIds.push(terrain.id);
	const spline = await call("create_spline", {
		name: `MCP Spline ${suffix}`,
		points: [
			[-250, 120, -100],
			[0, 180, 100],
			[250, 120, -100],
		],
		radius: 6,
		tessellation: 12,
		closed: false,
	});
	nodeIds.push(spline.node.id);
	let inspected = await call("get_spline", { nodeId: spline.node.id });
	if (inspected.points.length !== 3 || inspected.radius !== 6) throw new Error(`Spline inspection failed: ${JSON.stringify(inspected)}`);
	inspected = await call("set_spline", {
		nodeId: spline.node.id,
		points: [
			[-250, 140, -100],
			[-80, 190, 80],
			[100, 160, 120],
			[250, 130, -100],
		],
		radius: 8,
		tessellation: 16,
		closed: false,
	});
	if (inspected.points.length !== 4 || inspected.radius !== 8 || inspected.tessellation !== 16) throw new Error(`Spline update failed: ${JSON.stringify(inspected)}`);
	const projected = await call("project_spline_to_terrain", { nodeId: spline.node.id, terrainId: terrain.id, offset: 12, projectTangents: true });
	if (projected.terrain.id !== terrain.id || projected.spline.points.some((point) => Math.abs(point[1] - 12) > 0.01)) {
		throw new Error(`Spline terrain projection failed: ${JSON.stringify(projected)}`);
	}
	const evaluated = await call("evaluate_spline", { nodeId: spline.node.id, t: 0.5 });
	if (evaluated.t !== 0.5 || evaluated.length <= 0 || evaluated.position.length !== 3 || evaluated.tangent.length !== 3) {
		throw new Error(`Spline evaluation failed: ${JSON.stringify(evaluated)}`);
	}
	const saved = await call("save_spline_asset", { nodeId: spline.node.id, path: assetPath });
	if (saved.path !== assetPath || saved.asset?.points?.length !== 4) throw new Error(`Spline asset save failed: ${JSON.stringify(saved)}`);
	const instantiated = await call("instantiate_spline_asset", { path: assetPath, name: `MCP Spline Instance ${suffix}` });
	nodeIds.push(instantiated.spline.node.id);
	if (instantiated.spline.points.length !== 4) throw new Error(`Spline asset instantiation failed: ${JSON.stringify(instantiated)}`);
	const follower = await call("create_primitive_mesh", { type: "box", name: `MCP Spline Follower ${suffix}`, options: { size: 24 } });
	nodeIds.push(follower.id);
	const assigned = await call("set_spline_follower", { nodeId: follower.id, splineId: spline.node.id, speed: 150, t: 0.25, loop: true, orientToPath: true });
	if (assigned.follower.splineId !== spline.node.id || assigned.follower.speed !== 150) throw new Error(`Spline follower assignment failed: ${JSON.stringify(assigned)}`);
	const deletedFollower = await call("delete_spline_follower", { nodeId: follower.id });
	if (!deletedFollower.deleted) throw new Error("Spline follower deletion did not return evidence.");
	await cleanup();
	const final = await call("get_scene_diagnostics");
	if (final.meshes !== baseline.meshes || final.materials !== baseline.materials)
		throw new Error(`Spline cleanup did not restore the scene baseline: ${JSON.stringify({ baseline, final })}`);
	console.log("[spline-authoring-live] PASS — get/set, terrain projection, distance evaluation, save/instantiate asset, follower set/delete, and MCP-only cleanup verified.");
} catch (error) {
	console.error(`[spline-authoring-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}

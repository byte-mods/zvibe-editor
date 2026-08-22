#!/usr/bin/env node
/** Real stdio/editor lifecycle for Behavior Graph authoring, runtime events, Blackboard, debugger, strict rejection, and cleanup. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "index.mjs");
const child = spawn("node", [server], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params, timeoutMs = 60_000) {
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
	const failed = !!response.error || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const text = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return text ?? JSON.stringify(response.error);
	return text ? JSON.parse(text) : result;
}

const name = `__Behavior Graph Live ${Date.now()}`;
let graphId = null;
let revision = null;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "behavior-graphs-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const baseline = await call("list_behavior_trees");
	const created = await call("create_behavior_tree", {
		name,
		blackboard: [{ id: "amount", name: "Amount", type: "number", scope: "graph", exposed: true, defaultValue: 1 }],
		root: {
			id: "root",
			type: "sequence",
			position: [20, 20],
			children: [
				{ id: "wait", type: "wait-event", position: [220, 20], eventName: "Go" },
				{ id: "write", type: "action-set-variable", position: [420, 20], variableId: "amount", value: 7 },
			],
		},
	});
	graphId = created.id;
	revision = created.revision;
	const fetched = await call("get_behavior_tree", { id: graphId });
	if (fetched.tree?.id !== graphId || fetched.tree.revision !== revision) throw new Error("Exact Behavior Graph read did not round-trip.");
	const renamed = await call("set_behavior_tree", { id: graphId, expectedRevision: revision, changes: { name: `${name} Updated` } });
	revision = renamed.revision;
	const variableCreated = await call("create_behavior_blackboard_variable", {
		id: graphId,
		expectedRevision: revision,
		variable: { id: "temporary", name: "Temporary", type: "number", scope: "graph", exposed: false, defaultValue: 2 },
	});
	revision = variableCreated.graphRevision;
	const variableSet = await call("set_behavior_blackboard_variable", {
		id: graphId,
		expectedRevision: revision,
		variableId: "temporary",
		changes: { name: "Temporary Updated", defaultValue: 3 },
	});
	revision = variableSet.graphRevision;
	const variableDeleted = await call("delete_behavior_blackboard_variable", {
		id: graphId,
		expectedRevision: revision,
		variableId: "temporary",
		confirm: true,
	});
	revision = variableDeleted.graphRevision;
	const nodeCreated = await call("create_behavior_tree_node", {
		id: graphId,
		expectedRevision: revision,
		parentId: "root",
		index: 1,
		node: { id: "temporary-node", type: "action-wait", name: "Temporary Wait", position: [320, 120], duration: 0.01 },
	});
	revision = nodeCreated.graphRevision;
	const nodeSet = await call("set_behavior_tree_node", {
		id: graphId,
		expectedRevision: revision,
		nodeId: "temporary-node",
		changes: { name: "Temporary Wait Updated", duration: 0.02 },
	});
	revision = nodeSet.graphRevision;
	const nodeMoved = await call("move_behavior_tree_node", { id: graphId, expectedRevision: revision, nodeId: "temporary-node", parentId: "root", index: 2 });
	revision = nodeMoved.graphRevision;
	const nodeDeleted = await call("delete_behavior_tree_node", { id: graphId, expectedRevision: revision, nodeId: "temporary-node", confirm: true });
	revision = nodeDeleted.graphRevision;
	const validation = await call("validate_behavior_trees");
	if (!validation.valid) throw new Error("Behavior Graph validation did not pass.");
	await call("set_behavior_tree", { id: graphId, expectedRevision: revision + 1, changes: { enabled: false } }, true);

	await call("reload_behavior_tree_runtime");
	const directlyRun = await call("run_behavior_tree", { id: graphId });
	if (directlyRun.status !== "running") throw new Error(`Behavior run endpoint did not enter the wait state: ${JSON.stringify(directlyRun)}`);
	const ticked = await call("tick_behavior_tree", { id: graphId, deltaSeconds: 0.016 });
	if (ticked.status !== "running") throw new Error("Behavior tick endpoint did not preserve the wait state.");
	const stoppedDirectly = await call("stop_behavior_tree", { id: graphId });
	if (stoppedDirectly.status !== "stopped") throw new Error(`Behavior stop endpoint did not return to stopped: ${JSON.stringify(stoppedDirectly)}`);
	const runtimeOverride = await call("set_behavior_tree_runtime_blackboard", { id: graphId, variableName: "Amount", value: 9 });
	if (runtimeOverride.blackboard.Amount !== 9) throw new Error("Runtime Blackboard override did not persist.");
	await call("set_behavior_tree_breakpoints", { id: graphId, nodeIds: ["wait"] });
	const paused = await call("start_behavior_tree", { id: graphId });
	if (paused.status !== "paused" || paused.currentNodeId !== "wait") throw new Error("Behavior runtime did not pause at the authored breakpoint.");
	const stepped = await call("step_behavior_tree", { id: graphId });
	if (stepped.status !== "paused") throw new Error("Behavior node step did not return to paused state.");
	const continued = await call("continue_behavior_tree", { id: graphId });
	if (continued.status !== "running") throw new Error("Behavior graph did not wait for its event after continue.");
	const dispatched = await call("dispatch_behavior_tree_event", { id: graphId, eventName: "Go", payload: { source: "live-scenario" } });
	if (dispatched.states[0].status !== "succeeded" || dispatched.states[0].blackboard.Amount !== 7)
		throw new Error("Behavior event did not complete the graph with the expected Blackboard value.");
	const runtime = await call("get_behavior_tree_runtime", { id: graphId });
	if (!runtime.trace.some((event) => event.phase === "breakpoint") || !runtime.trace.some((event) => event.phase === "event"))
		throw new Error("Behavior runtime trace is missing breakpoint or event evidence.");
	await call("clear_behavior_tree_trace", { confirm: true });
	await call("delete_behavior_tree", { id: graphId, expectedRevision: revision, confirm: true });
	graphId = null;
	const final = await call("list_behavior_trees");
	if (final.trees.some((graph) => graph.name === name)) throw new Error("Behavior Graph live scenario cleanup left authored residue.");
	console.log(
		`[behavior-graphs-live] PASS — ${baseline.trees.length} baseline graph(s), revision ${revision}, Blackboard 9→7, breakpoint/step/event/trace, stale rejection, exact cleanup.`
	);
} catch (error) {
	if (graphId && revision) {
		try {
			await call("delete_behavior_tree", { id: graphId, expectedRevision: revision, confirm: true });
		} catch {
			// Preserve the primary failure; the disposable project is removed by the caller.
		}
	}
	console.error(`[behavior-graphs-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

#!/usr/bin/env node
/** Real stdio/editor lifecycle for Visual Scripting authoring, runtime, debugger, strict rejection, and cleanup. */
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
		if (!line) {
			continue;
		}
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
	if (failed !== expectError) {
		throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	}
	const text = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) {
		return text ?? JSON.stringify(response.error);
	}
	return text ? JSON.parse(text) : result;
}

const name = `__Visual Script Live ${Date.now()}`;
let graphId = null;
let revision = null;
let stateGraphId = null;
let stateGraphRevision = null;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "visual-scripting-live-scenario", version: "1.0.0" } });
	if (initialized.error) {
		throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	}
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const baseline = await call("list_visual_script_graphs");
	const created = await call("create_visual_script_graph", { name });
	graphId = created.id;
	revision = created.revision;
	const fetched = await call("get_visual_script_graph", { id: graphId });
	if (fetched.graph?.id !== graphId || fetched.graph.revision !== revision) throw new Error("Exact Visual Script graph read did not round-trip.");
	const configuredGraph = await call("set_visual_script_graph", { id: graphId, expectedRevision: revision, changes: { enabled: true, autoStart: false } });
	revision = configuredGraph.revision;
	const variable = await call("create_visual_script_variable", {
		id: graphId,
		expectedRevision: revision,
		variable: { name: "Amount", scope: "graph", type: "number", defaultValue: 1 },
	});
	revision = variable.graphRevision;
	const updatedVariable = await call("set_visual_script_variable", {
		id: graphId,
		expectedRevision: revision,
		variableId: variable.variable.id,
		changes: { name: "Amount", defaultValue: 1 },
	});
	revision = updatedVariable.graphRevision;
	const temporaryVariable = await call("create_visual_script_variable", {
		id: graphId,
		expectedRevision: revision,
		variable: { id: "temporary-variable", name: "Temporary", scope: "graph", type: "number", defaultValue: 0 },
	});
	revision = temporaryVariable.graphRevision;
	const temporaryVariableUpdated = await call("set_visual_script_variable", {
		id: graphId,
		expectedRevision: revision,
		variableId: "temporary-variable",
		changes: { name: "Temporary Updated", defaultValue: 2 },
	});
	revision = temporaryVariableUpdated.graphRevision;
	const temporaryVariableDeleted = await call("delete_visual_script_variable", {
		id: graphId,
		expectedRevision: revision,
		variableId: "temporary-variable",
		confirm: true,
	});
	revision = temporaryVariableDeleted.graphRevision;
	const node = await call("create_visual_script_node", {
		id: graphId,
		expectedRevision: revision,
		node: { type: "set-variable", variableId: variable.variable.id, value: 7, position: [180, 20] },
	});
	revision = node.graphRevision;
	const updatedNode = await call("set_visual_script_node", {
		id: graphId,
		expectedRevision: revision,
		nodeId: node.node.id,
		changes: { name: "Set Amount", enabled: true },
	});
	revision = updatedNode.graphRevision;
	const positionedNode = await call("set_visual_script_node_position", { id: graphId, expectedRevision: revision, nodeId: node.node.id, position: [200, 40] });
	revision = positionedNode.graphRevision;
	const temporaryNode = await call("create_visual_script_node", {
		id: graphId,
		expectedRevision: revision,
		node: { id: "temporary-node", type: "log", name: "Temporary Log", value: "temporary", position: [500, 20] },
	});
	revision = temporaryNode.graphRevision;
	const temporaryNodeUpdated = await call("set_visual_script_node", {
		id: graphId,
		expectedRevision: revision,
		nodeId: "temporary-node",
		changes: { name: "Temporary Log Updated", value: "updated" },
	});
	revision = temporaryNodeUpdated.graphRevision;
	const temporaryNodeDeleted = await call("delete_visual_script_node", { id: graphId, expectedRevision: revision, nodeId: "temporary-node", confirm: true });
	revision = temporaryNodeDeleted.graphRevision;
	const edge = await call("create_visual_script_edge", {
		id: graphId,
		expectedRevision: revision,
		edge: { kind: "control", from: { nodeId: "start", port: "out" }, to: { nodeId: node.node.id, port: "in" } },
	});
	revision = edge.graphRevision;
	const updatedEdge = await call("set_visual_script_edge", { id: graphId, expectedRevision: revision, edgeId: edge.edge.id, changes: { order: 0 } });
	revision = updatedEdge.graphRevision;
	const group = await call("create_visual_script_group", {
		id: graphId,
		expectedRevision: revision,
		group: { id: "temporary-group", name: "Execution", color: "#2563eb", nodeIds: [node.node.id] },
	});
	revision = group.graphRevision;
	const updatedGroup = await call("set_visual_script_group", {
		id: graphId,
		expectedRevision: revision,
		groupId: "temporary-group",
		changes: { name: "Execution Updated", color: "#1d4ed8", nodeIds: [node.node.id] },
	});
	revision = updatedGroup.graphRevision;
	const deletedGroup = await call("delete_visual_script_group", { id: graphId, expectedRevision: revision, groupId: "temporary-group" });
	revision = deletedGroup.graphRevision;
	const stateGraph = await call("create_visual_script_graph", { name: `${name} State`, kind: "state" });
	stateGraphId = stateGraph.id;
	stateGraphRevision = stateGraph.revision;
	const secondState = await call("create_visual_script_state", {
		id: stateGraphId,
		expectedRevision: stateGraphRevision,
		state: { id: "secondary", name: "Secondary", position: [240, 20], initial: false },
	});
	stateGraphRevision = secondState.graphRevision;
	const secondStateUpdated = await call("set_visual_script_state", {
		id: stateGraphId,
		expectedRevision: stateGraphRevision,
		stateId: "secondary",
		changes: { name: "Secondary Updated", position: [260, 40] },
	});
	stateGraphRevision = secondStateUpdated.graphRevision;
	const transition = await call("create_visual_script_transition", {
		id: stateGraphId,
		expectedRevision: stateGraphRevision,
		transition: { id: "temporary-transition", fromStateId: "initial", toStateId: "secondary", eventName: "advance", priority: 0 },
	});
	stateGraphRevision = transition.graphRevision;
	const transitionUpdated = await call("set_visual_script_transition", {
		id: stateGraphId,
		expectedRevision: stateGraphRevision,
		transitionId: "temporary-transition",
		changes: { eventName: "advance-updated", priority: 1 },
	});
	stateGraphRevision = transitionUpdated.graphRevision;
	const transitionDeleted = await call("delete_visual_script_transition", {
		id: stateGraphId,
		expectedRevision: stateGraphRevision,
		transitionId: "temporary-transition",
	});
	stateGraphRevision = transitionDeleted.graphRevision;
	const stateDeleted = await call("delete_visual_script_state", {
		id: stateGraphId,
		expectedRevision: stateGraphRevision,
		stateId: "secondary",
		confirm: true,
	});
	stateGraphRevision = stateDeleted.graphRevision;
	await call("delete_visual_script_graph", { id: stateGraphId, expectedRevision: stateGraphRevision, confirm: true });
	stateGraphId = null;
	stateGraphRevision = null;
	const capabilities = await call("get_graph_toolkit_capabilities");
	if (capabilities.collections.maximumEditableElements !== 50 || capabilities.expression.maximumInputs !== 16 || !capabilities.presentation.verticalPorts) {
		throw new Error("Graph Toolkit capability evidence is incomplete.");
	}
	const styles = await call("set_graph_toolkit_type_styles", {
		id: graphId,
		expectedRevision: revision,
		typeStyles: [{ typeId: "damage", label: "Damage", color: "#dc2626", icon: "swords" }],
	});
	revision = styles.graphRevision;
	const collectionVariable = await call("create_visual_script_variable", {
		id: graphId,
		expectedRevision: revision,
		variable: { name: "Damage Values", scope: "graph", type: "untyped", collection: "list", dataType: "damage", defaultValue: [1, "critical"] },
	});
	revision = collectionVariable.graphRevision;
	const constant = await call("create_visual_script_node", {
		id: graphId,
		expectedRevision: revision,
		node: {
			type: "constant",
			collection: "array",
			dataType: "damage",
			value: [1, 2],
			position: [20, 150],
			presentation: { title: "Damage Array", icon: "swords", color: "#dc2626" },
		},
	});
	revision = constant.graphRevision;
	const constantValue = await call("set_visual_script_constant_value", { id: graphId, expectedRevision: revision, nodeId: constant.node.id, value: [3, 4, 5] });
	revision = constantValue.graphRevision;
	const expression = await call("create_visual_script_node", {
		id: graphId,
		expectedRevision: revision,
		node: {
			type: "expression",
			expression: "x * 2",
			expressionInputs: ["x"],
			position: [20, 250],
			portPresentation: [{ port: "x", type: "number", dataType: "damage", tooltip: "Damage input", multiline: true }],
			presentation: {
				title: "Damage Formula",
				category: "Math",
				subtitle: "Expression",
				tooltip: "Doubles damage",
				icon: "sigma",
				color: "#16a34a",
				portLayout: "vertical",
				optionEditors: { expression: "textarea" },
			},
		},
	});
	revision = expression.graphRevision;
	const portValue = await call("set_visual_script_port_value", { id: graphId, expectedRevision: revision, nodeId: expression.node.id, port: "x", value: 3 });
	revision = portValue.graphRevision;
	const expressionEdge = await call("create_visual_script_edge", {
		id: graphId,
		expectedRevision: revision,
		edge: { kind: "value", from: { nodeId: expression.node.id, port: "value" }, to: { nodeId: node.node.id, port: "value" } },
	});
	revision = expressionEdge.graphRevision;
	const inspected = await call("inspect_graph_toolkit_node", { id: graphId, nodeId: expression.node.id });
	if (!inspected.connected || inspected.presentation.portLayout !== "vertical" || inspected.portPresentation.find((port) => port.port === "x")?.style?.icon !== "swords") {
		throw new Error("Graph Toolkit node inspection did not resolve connectivity, layout, and custom type styling.");
	}
	const references = await call("list_visual_script_variable_nodes", { id: graphId, variableId: collectionVariable.variable.id, limit: 1 });
	if (references.total !== 0) {
		throw new Error("Graph Toolkit variable-node query returned unexpected references.");
	}
	const removed = await call("remove_visual_script_variable_from_graph", {
		id: graphId,
		expectedRevision: revision,
		variableId: collectionVariable.variable.id,
		confirm: true,
	});
	revision = removed.graphRevision;

	const validation = await call("validate_visual_script_graph", { id: graphId });
	const run = await call("run_visual_script_graph", { id: graphId });
	if (!validation.valid || run.variables.Amount !== 6 || validation.counts.typeStyles !== 1) {
		throw new Error("Visual Script validation/run evidence did not match authoring.");
	}
	await call("set_visual_script_graph", { id: graphId, expectedRevision: revision - 1, changes: { enabled: false } }, true);

	await call("reload_visual_script_runtime");
	await call("dispatch_visual_script_event", { id: graphId, event: "mcp-live", payload: { verified: true } });
	const runtimeVariable = await call("set_visual_script_runtime_variable", { id: graphId, variableName: "Amount", value: 9 });
	if (runtimeVariable.variables.Amount !== 9) {
		throw new Error("Runtime variable update did not persist in the live runtime.");
	}
	await call("set_visual_script_breakpoints", { id: graphId, nodeIds: [node.node.id] });
	const paused = await call("start_visual_script_runtime_graph", { id: graphId });
	if (paused.status !== "paused" || paused.currentNodeId !== node.node.id) {
		throw new Error("Live runtime did not pause at the authored breakpoint.");
	}
	const continued = await call("continue_visual_script_graph", { id: graphId });
	if (!["running", "succeeded"].includes(continued.status)) throw new Error(`Live runtime continue returned unexpected state: ${JSON.stringify(continued)}`);
	await call("stop_visual_script_runtime_graph", { id: graphId });
	const pausedAgain = await call("start_visual_script_runtime_graph", { id: graphId });
	if (pausedAgain.status !== "paused") throw new Error("Live runtime did not pause again for deterministic stepping.");
	const stepped = await call("step_visual_script_graph", { id: graphId });
	if (stepped.status !== "running" || stepped.variables.Amount !== 6) {
		throw new Error("Live runtime step did not execute the paused node.");
	}
	const runtime = await call("get_visual_script_runtime", { limit: 512 });
	if (!runtime.trace.events.some((event) => event.phase === "breakpoint")) {
		throw new Error("Live runtime trace is missing breakpoint evidence.");
	}
	await call("stop_visual_script_runtime_graph", { id: graphId });
	const cleared = await call("clear_visual_script_trace", { confirm: true });
	if (cleared.cleared < 1) {
		throw new Error("Live runtime trace did not clear.");
	}
	const deletedEdge = await call("delete_visual_script_edge", { id: graphId, expectedRevision: revision, edgeId: edge.edge.id });
	revision = deletedEdge.graphRevision;
	await call("delete_visual_script_graph", { id: graphId, expectedRevision: revision, confirm: true });
	graphId = null;
	const final = await call("list_visual_script_graphs");
	if (final.graphs.some((graph) => graph.name === name)) {
		throw new Error("Visual Script live scenario cleanup left authored residue.");
	}

	console.log(
		`[visual-scripting-live] PASS — ${baseline.graphs.length} baseline graph(s), revision ${revision}, expression result 6, untyped list/array + 50 cap, multiline/vertical ports, custom type style, runtime override 9, breakpoint/step/trace, stale rejection, exact cleanup.`
	);
} catch (error) {
	if (stateGraphId && stateGraphRevision) {
		await call("delete_visual_script_graph", { id: stateGraphId, expectedRevision: stateGraphRevision, confirm: true }).catch(() => undefined);
	}
	if (graphId && revision) {
		try {
			await call("delete_visual_script_graph", { id: graphId, expectedRevision: revision, confirm: true });
		} catch {
			// Preserve the primary failure; the disposable project is removed by the caller.
		}
	}
	console.error(`[visual-scripting-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) {
		console.error(stderr.trim());
	}
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identity = { id: z.string().min(1).max(128).optional(), name: z.string().min(1).max(128).optional() };
const exactRevision = z.number().int().min(1);
const position = z.array(z.number().finite().min(0).max(10_000)).length(2);
const variableScope = z.enum(["flow", "graph", "object", "scene", "application", "saved"]);
const valueType = z.enum(["any", "untyped", "boolean", "number", "string", "vector2", "vector3", "node"]);
const collectionKind = z.enum(["list", "array"]);
const nodeType = z.enum([
	"event-start",
	"event-update",
	"event-fixed-update",
	"event-custom",
	"branch",
	"sequence",
	"trigger-custom-event",
	"subgraph",
	"graph-input",
	"graph-output",
	"constant",
	"expression",
	"get-variable",
	"set-variable",
	"add",
	"subtract",
	"multiply",
	"divide",
	"compare",
	"and",
	"or",
	"not",
	"vector3",
	"get-position",
	"set-position",
	"translate",
	"set-enabled",
	"log",
	"custom",
]);
const unitPorts = z
	.object({
		controlInputs: z.array(z.string().min(1).max(64)).max(16),
		controlOutputs: z.array(z.string().min(1).max(64)).max(16),
		valueInputs: z.array(z.string().min(1).max(64)).max(16),
		valueOutputs: z.array(z.string().min(1).max(64)).max(16),
	})
	.strict();
const dataTypeStyle = z
	.object({
		typeId: z.string().min(1).max(64),
		label: z.string().min(1).max(64),
		color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		icon: z.string().min(1).max(64),
	})
	.strict();
const portPresentation = z
	.object({
		port: z.string().min(1).max(64),
		type: valueType,
		collection: collectionKind.optional(),
		dataType: z.string().min(1).max(64).optional(),
		tooltip: z.string().max(512).optional(),
		multiline: z.boolean().optional(),
	})
	.strict();
const nodePresentation = z
	.object({
		title: z.string().max(512).optional(),
		category: z.string().max(512).optional(),
		subtitle: z.string().max(512).optional(),
		tooltip: z.string().max(512).optional(),
		icon: z.string().max(512).optional(),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		portLayout: z.enum(["horizontal", "vertical"]).optional(),
		optionEditors: z.record(z.string().min(1).max(64), z.enum(["text", "textarea"])).optional(),
	})
	.strict();
const variable = z
	.object({
		id: z.string().min(1).max(128).optional(),
		name: z.string().min(1).max(128),
		scope: variableScope.optional(),
		type: valueType.optional(),
		defaultValue: z.any().optional(),
		collection: collectionKind.optional(),
		dataType: z.string().min(1).max(64).optional(),
	})
	.strict();
const variableChanges = z
	.object({
		name: z.string().min(1).max(128).optional(),
		scope: variableScope.optional(),
		type: valueType.optional(),
		defaultValue: z.any().optional(),
		collection: collectionKind.optional(),
		dataType: z.string().min(1).max(64).optional(),
	})
	.strict();
const node = z
	.object({
		id: z.string().min(1).max(128).optional(),
		type: nodeType,
		name: z.string().min(1).max(128).optional(),
		position: position.optional(),
		enabled: z.boolean().optional(),
		nodeId: z.string().min(1).max(128).optional(),
		variableId: z.string().min(1).max(128).optional(),
		value: z.any().optional(),
		collection: collectionKind.optional(),
		dataType: z.string().min(1).max(64).optional(),
		expression: z.string().min(1).max(2_048).optional(),
		expressionInputs: z.array(z.string().min(1).max(64)).max(16).optional(),
		eventName: z.string().min(1).max(128).optional(),
		subgraphId: z.string().min(1).max(128).optional(),
		portName: z.string().min(1).max(128).optional(),
		operator: z.enum(["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual"]).optional(),
		unitId: z.string().min(1).max(128).optional(),
		ports: unitPorts.optional(),
		portPresentation: z.array(portPresentation).max(32).optional(),
		presentation: nodePresentation.optional(),
		settings: z.record(z.string(), z.any()).optional(),
	})
	.strict();
const nodeChanges = node.partial().omit({ id: true }).strict();
const port = z.object({ nodeId: z.string().min(1).max(128), port: z.string().min(1).max(128) }).strict();
const edge = z
	.object({
		id: z.string().min(1).max(128).optional(),
		kind: z.enum(["control", "value"]),
		from: port,
		to: port,
		order: z.number().int().min(0).max(511).optional(),
	})
	.strict();
const edgeChanges = z
	.object({ kind: z.enum(["control", "value"]).optional(), from: port.optional(), to: port.optional(), order: z.number().int().min(0).max(511).optional() })
	.strict();
const group = z
	.object({
		id: z.string().min(1).max(128).optional(),
		name: z.string().min(1).max(128),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		nodeIds: z.array(z.string().min(1).max(128)).max(256).optional(),
	})
	.strict();
const groupChanges = z
	.object({
		name: z.string().min(1).max(128).optional(),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		nodeIds: z.array(z.string().min(1).max(128)).max(256).optional(),
	})
	.strict();
const state = z
	.object({
		id: z.string().min(1).max(128).optional(),
		name: z.string().min(1).max(128),
		position: position.optional(),
		initial: z.boolean().optional(),
		onEnterGraphId: z.string().min(1).max(128).optional(),
		onUpdateGraphId: z.string().min(1).max(128).optional(),
		onExitGraphId: z.string().min(1).max(128).optional(),
	})
	.strict();
const stateChanges = state.partial().omit({ id: true }).strict();
const transition = z
	.object({
		id: z.string().min(1).max(128).optional(),
		fromStateId: z.string().min(1).max(128),
		toStateId: z.string().min(1).max(128),
		eventName: z.string().min(1).max(128).optional(),
		conditionVariableId: z.string().min(1).max(128).optional(),
		invertCondition: z.boolean().optional(),
		priority: z.number().int().min(0).max(255).optional(),
	})
	.strict();
const transitionChanges = transition.partial().omit({ id: true }).strict();
const graphCollections = {
	variables: z.array(variable).max(128).optional(),
	nodes: z.array(node).max(256).optional(),
	edges: z.array(edge).max(512).optional(),
	groups: z.array(group).max(64).optional(),
	states: z.array(state).max(64).optional(),
	transitions: z.array(transition).max(256).optional(),
	typeStyles: z.array(dataTypeStyle).max(32).optional(),
};
const graphChanges = z
	.object({
		name: z.string().min(1).max(128).optional(),
		kind: z.enum(["flow", "state"]).optional(),
		enabled: z.boolean().optional(),
		autoStart: z.boolean().optional(),
		targetNodeId: z.string().min(1).max(128).optional(),
		...graphCollections,
	})
	.strict();
const page = { offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(512).optional() };

function readOnly(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict()) {
	return { title, description, inputSchema, annotations: { readOnlyHint: true } };
}

function mutation(title: string, description: string, inputSchema: z.ZodTypeAny) {
	return { title, description, inputSchema };
}

/** Registers complete portable Flow/State graph authoring, runtime, and debugger tools. */
export function registerVisualScriptingTools(server: McpServer): void {
	server.registerTool(
		"list_visual_script_graphs",
		readOnly("List Visual Script Graphs", "List complete normalized version-2 Flow and State graph authoring and exact revisions."),
		async () => callTextTool("list_visual_script_graphs")
	);
	server.registerTool(
		"get_visual_script_graph",
		readOnly("Get Visual Script Graph", "Read one complete Flow or State graph by exact id or name.", z.object(identity).strict()),
		async (args) => callTextTool("get_visual_script_graph", args)
	);
	server.registerTool(
		"get_graph_toolkit_capabilities",
		readOnly("Get Graph Toolkit Capabilities", "Discover expression grammar, untyped values, collection limits, presentation APIs, and exact-revision mutation support."),
		async () => callTextTool("get_graph_toolkit_capabilities")
	);
	server.registerTool(
		"inspect_graph_toolkit_node",
		readOnly(
			"Inspect Graph Toolkit Node",
			"Read one node's resolved title, category, subtitle, tooltip, icon, color, layout, typed/untyped ports, custom type styles, and connection state.",
			z.object({ ...identity, nodeId: z.string().min(1).max(128) }).strict()
		),
		async (args) => callTextTool("inspect_graph_toolkit_node", args)
	);
	server.registerTool(
		"list_visual_script_variable_nodes",
		readOnly(
			"List Visual Script Variable Nodes",
			"Page Get/Set nodes for one variable in stable graph order and report its exact graph revision.",
			z
				.object({
					...identity,
					variableId: z.string().min(1).max(128).optional(),
					variableName: z.string().min(1).max(128).optional(),
					offset: z.number().int().nonnegative().optional(),
					limit: z.number().int().min(1).max(256).optional(),
				})
				.strict()
		),
		async (args) => callTextTool("list_visual_script_variable_nodes", args)
	);
	server.registerTool(
		"set_graph_toolkit_type_styles",
		mutation(
			"Set Graph Toolkit Type Styles",
			"Replace the bounded custom data-type color/icon map under exact graph revision control.",
			z.object({ ...identity, expectedRevision: exactRevision, typeStyles: z.array(dataTypeStyle).max(32) }).strict()
		),
		async (args) => callTextTool("set_graph_toolkit_type_styles", args)
	);
	server.registerTool(
		"set_visual_script_constant_value",
		mutation(
			"Set Visual Script Constant Value",
			"Set one scalar, list, or array Constant value under exact revision control; editable collections are capped at 50 elements.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(128), value: z.any() }).strict()
		),
		async (args) => callTextTool("set_visual_script_constant_value", args)
	);
	server.registerTool(
		"set_visual_script_port_value",
		mutation(
			"Set Visual Script Port Value",
			"Set a typed/untyped fallback value on one currently unconnected value input under exact graph revision control.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(128), port: z.string().min(1).max(64), value: z.any() }).strict()
		),
		async (args) => callTextTool("set_visual_script_port_value", args)
	);
	server.registerTool(
		"remove_visual_script_variable_from_graph",
		mutation(
			"Remove Visual Script Variable From Graph",
			"Remove one unreferenced variable by id or name under exact graph revision control.",
			z
				.object({
					...identity,
					expectedRevision: exactRevision,
					variableId: z.string().min(1).max(128).optional(),
					variableName: z.string().min(1).max(128).optional(),
					confirm: z.literal(true),
				})
				.strict()
		),
		async (args) => callTextTool("remove_visual_script_variable_from_graph", args)
	);
	server.registerTool(
		"create_visual_script_graph",
		mutation(
			"Create Visual Script Graph",
			"Create a version-2 Flow or State graph with optional complete authoring.",
			z
				.object({
					id: z.string().min(1).max(128).optional(),
					name: z.string().min(1).max(128),
					kind: z.enum(["flow", "state"]).optional(),
					enabled: z.boolean().optional(),
					autoStart: z.boolean().optional(),
					targetNodeId: z.string().min(1).max(128).optional(),
					...graphCollections,
				})
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("create_visual_script_graph", args)
	);
	server.registerTool(
		"set_visual_script_graph",
		mutation(
			"Set Visual Script Graph",
			"Exact-revision atomic update of graph identity, kind, enable state, target, or complete collections.",
			z.object({ ...identity, expectedRevision: exactRevision, changes: graphChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_graph", args)
	);
	server.registerTool(
		"delete_visual_script_graph",
		mutation(
			"Delete Visual Script Graph",
			"Delete one unreferenced exact-revision graph.",
			z.object({ ...identity, expectedRevision: exactRevision, confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_graph", args)
	);

	server.registerTool(
		"create_visual_script_variable",
		mutation(
			"Create Visual Script Variable",
			"Create a typed Flow, Graph, Object, Scene, Application, or Saved variable.",
			z.object({ ...identity, expectedRevision: exactRevision, variable }).strict()
		),
		async (args) => callTextTool("create_visual_script_variable", args)
	);
	server.registerTool(
		"set_visual_script_variable",
		mutation(
			"Set Visual Script Variable",
			"Exact-revision update of one variable definition.",
			z.object({ ...identity, expectedRevision: exactRevision, variableId: z.string().min(1).max(128), changes: variableChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_variable", args)
	);
	server.registerTool(
		"delete_visual_script_variable",
		mutation(
			"Delete Visual Script Variable",
			"Delete one unreferenced exact-revision variable.",
			z.object({ ...identity, expectedRevision: exactRevision, variableId: z.string().min(1).max(128), confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_variable", args)
	);

	server.registerTool(
		"create_visual_script_node",
		mutation(
			"Create Visual Script Node",
			"Create one event, control, value, math, scene-action, reusable-subgraph, or registered custom unit.",
			z.object({ ...identity, expectedRevision: exactRevision, node }).strict()
		),
		async (args) => callTextTool("create_visual_script_node", args)
	);
	server.registerTool(
		"set_visual_script_node",
		mutation(
			"Set Visual Script Node",
			"Exact-revision update of one graph unit and its persisted settings.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(128), changes: nodeChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_node", args)
	);
	server.registerTool(
		"delete_visual_script_node",
		mutation(
			"Delete Visual Script Node",
			"Delete one exact-revision node plus its edges and group membership.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(128), confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_node", args)
	);
	server.registerTool(
		"set_visual_script_node_position",
		mutation(
			"Position Visual Script Node",
			"Exact-revision update of one bounded freeform node position.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(128), position }).strict()
		),
		async (args) => callTextTool("set_visual_script_node_position", args)
	);

	server.registerTool(
		"create_visual_script_edge",
		mutation("Create Visual Script Edge", "Connect explicit compatible control or value ports.", z.object({ ...identity, expectedRevision: exactRevision, edge }).strict()),
		async (args) => callTextTool("create_visual_script_edge", args)
	);
	server.registerTool(
		"set_visual_script_edge",
		mutation(
			"Set Visual Script Edge",
			"Exact-revision update of an edge kind, endpoints, or order.",
			z.object({ ...identity, expectedRevision: exactRevision, edgeId: z.string().min(1).max(128), changes: edgeChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_edge", args)
	);
	server.registerTool(
		"delete_visual_script_edge",
		mutation(
			"Delete Visual Script Edge",
			"Delete one exact-revision port connection.",
			z.object({ ...identity, expectedRevision: exactRevision, edgeId: z.string().min(1).max(128) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_edge", args)
	);

	server.registerTool(
		"create_visual_script_group",
		mutation("Create Visual Script Group", "Create a colored node group with bounded membership.", z.object({ ...identity, expectedRevision: exactRevision, group }).strict()),
		async (args) => callTextTool("create_visual_script_group", args)
	);
	server.registerTool(
		"set_visual_script_group",
		mutation(
			"Set Visual Script Group",
			"Exact-revision update of group label, color, or membership.",
			z.object({ ...identity, expectedRevision: exactRevision, groupId: z.string().min(1).max(128), changes: groupChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_group", args)
	);
	server.registerTool(
		"delete_visual_script_group",
		mutation(
			"Delete Visual Script Group",
			"Delete one exact-revision visual group without deleting nodes.",
			z.object({ ...identity, expectedRevision: exactRevision, groupId: z.string().min(1).max(128) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_group", args)
	);

	server.registerTool(
		"create_visual_script_state",
		mutation(
			"Create Visual Script State",
			"Create a State Graph state with optional Flow graph handlers.",
			z.object({ ...identity, expectedRevision: exactRevision, state }).strict()
		),
		async (args) => callTextTool("create_visual_script_state", args)
	);
	server.registerTool(
		"set_visual_script_state",
		mutation(
			"Set Visual Script State",
			"Exact-revision update of state identity, position, initial flag, or handlers.",
			z.object({ ...identity, expectedRevision: exactRevision, stateId: z.string().min(1).max(128), changes: stateChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_state", args)
	);
	server.registerTool(
		"delete_visual_script_state",
		mutation(
			"Delete Visual Script State",
			"Delete a non-initial state and its transitions.",
			z.object({ ...identity, expectedRevision: exactRevision, stateId: z.string().min(1).max(128), confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_state", args)
	);
	server.registerTool(
		"create_visual_script_transition",
		mutation(
			"Create Visual Script Transition",
			"Create a priority event/condition transition between State Graph states.",
			z.object({ ...identity, expectedRevision: exactRevision, transition }).strict()
		),
		async (args) => callTextTool("create_visual_script_transition", args)
	);
	server.registerTool(
		"set_visual_script_transition",
		mutation(
			"Set Visual Script Transition",
			"Exact-revision update of one State Graph transition.",
			z.object({ ...identity, expectedRevision: exactRevision, transitionId: z.string().min(1).max(128), changes: transitionChanges }).strict()
		),
		async (args) => callTextTool("set_visual_script_transition", args)
	);
	server.registerTool(
		"delete_visual_script_transition",
		mutation(
			"Delete Visual Script Transition",
			"Delete one exact-revision State Graph transition.",
			z.object({ ...identity, expectedRevision: exactRevision, transitionId: z.string().min(1).max(128) }).strict()
		),
		async (args) => callTextTool("delete_visual_script_transition", args)
	);

	server.registerTool(
		"validate_visual_script_graph",
		readOnly("Validate Visual Script Graph", "Validate the complete collection and report exact graph counts.", z.object(identity).strict()),
		async (args) => callTextTool("validate_visual_script_graph", args)
	);
	server.registerTool(
		"run_visual_script_graph",
		mutation(
			"Run Visual Script Graph",
			"Run one Flow start/custom event to completion or start one State Graph without changing authoring revision.",
			z.object({ ...identity, event: z.string().min(1).max(128).optional(), payload: z.any().optional() }).strict()
		),
		async (args) => callTextTool("run_visual_script_graph", args)
	);
	server.registerTool(
		"get_visual_script_runtime",
		readOnly("Get Visual Script Runtime", "Inspect every graph status, active state, node, scoped values, breakpoints, errors, and bounded trace.", z.object(page).strict()),
		async (args) => callTextTool("get_visual_script_runtime", args)
	);
	server.registerTool(
		"reload_visual_script_runtime",
		mutation(
			"Reload Visual Script Runtime",
			"Rebuild the transient live runtime/debugger from current validated authoring without changing graph revisions.",
			z.object(page).strict()
		),
		async (args) => callTextTool("reload_visual_script_runtime", args)
	);
	server.registerTool(
		"start_visual_script_runtime_graph",
		mutation("Start Visual Script Runtime Graph", "Start one active Flow or State graph.", z.object(identity).strict()),
		async (args) => callTextTool("start_visual_script_runtime_graph", args)
	);
	server.registerTool(
		"stop_visual_script_runtime_graph",
		mutation("Stop Visual Script Runtime Graph", "Stop one active graph and clear paused work.", z.object(identity).strict()),
		async (args) => callTextTool("stop_visual_script_runtime_graph", args)
	);
	server.registerTool(
		"dispatch_visual_script_event",
		mutation(
			"Dispatch Visual Script Event",
			"Dispatch a bounded custom event/payload to one Flow graph or State transition set.",
			z.object({ ...identity, event: z.string().min(1).max(128), payload: z.any().optional() }).strict()
		),
		async (args) => callTextTool("dispatch_visual_script_event", args)
	);
	server.registerTool(
		"set_visual_script_breakpoints",
		mutation(
			"Set Visual Script Breakpoints",
			"Replace the transient breakpoint set with executable control-node ids for one graph.",
			z.object({ ...identity, nodeIds: z.array(z.string().min(1).max(128)).max(64) }).strict()
		),
		async (args) => callTextTool("set_visual_script_breakpoints", args)
	);
	server.registerTool(
		"continue_visual_script_graph",
		mutation("Continue Visual Script Graph", "Continue one paused graph until completion or the next breakpoint.", z.object(identity).strict()),
		async (args) => callTextTool("continue_visual_script_graph", args)
	);
	server.registerTool(
		"step_visual_script_graph",
		mutation("Step Visual Script Graph", "Execute exactly one control node in a paused graph.", z.object(identity).strict()),
		async (args) => callTextTool("step_visual_script_graph", args)
	);
	server.registerTool(
		"set_visual_script_runtime_variable",
		mutation(
			"Set Visual Script Runtime Variable",
			"Set one non-authoring scoped runtime variable value.",
			z.object({ ...identity, variableId: z.string().min(1).max(128).optional(), variableName: z.string().min(1).max(128).optional(), value: z.any() }).strict()
		),
		async (args) => callTextTool("set_visual_script_runtime_variable", args)
	);
	server.registerTool(
		"clear_visual_script_trace",
		mutation("Clear Visual Script Trace", "Clear the bounded transient runtime debugger trace.", z.object({ confirm: z.literal(true) }).strict()),
		async (args) => callTextTool("clear_visual_script_trace", args)
	);
}

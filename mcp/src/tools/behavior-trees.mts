import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identity = { id: z.string().min(1).max(256).optional(), name: z.string().min(1).max(256).optional() };
const exactRevision = z.number().int().min(1);
const position = z.array(z.number().finite().min(-100_000).max(100_000)).length(2);
const valueType = z.enum(["boolean", "number", "string", "vector3", "node"]);
const variable = z
	.object({
		id: z.string().min(1).max(256).optional(),
		name: z.string().min(1).max(128),
		type: valueType.optional(),
		scope: z.enum(["graph", "scene"]).optional(),
		exposed: z.boolean().optional(),
		defaultValue: z.any().optional(),
	})
	.strict();
const variableChanges = z
	.object({
		name: z.string().min(1).max(128).optional(),
		type: valueType.optional(),
		scope: z.enum(["graph", "scene"]).optional(),
		exposed: z.boolean().optional(),
		defaultValue: z.any().optional(),
	})
	.strict();
const nodeType = z.enum([
	"sequence",
	"selector",
	"random",
	"parallel-all",
	"parallel-any",
	"utility-selector",
	"inverter",
	"succeeder",
	"repeat",
	"condition-node-enabled",
	"condition-variable",
	"condition-distance",
	"condition-nav-arrived",
	"action-set-enabled",
	"action-set-position",
	"action-set-variable",
	"action-wait",
	"action-log",
	"action-send-event",
	"action-nav-set-destination",
	"action-nav-start",
	"action-nav-stop",
	"action-nav-move-to",
	"wait-event",
	"subgraph",
	"custom",
]);
const utility = z
	.object({ variableId: z.string().min(1).max(256).optional(), constant: z.number().finite().optional(), weight: z.number().finite().optional(), invert: z.boolean().optional() })
	.strict();
const node: z.ZodTypeAny = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).max(256).optional(),
			type: nodeType,
			name: z.string().min(1).max(128).optional(),
			position: position.optional(),
			enabled: z.boolean().optional(),
			children: z.array(node).max(512).optional(),
			nodeId: z.string().min(1).max(256).optional(),
			navAgentId: z.string().min(1).max(256).optional(),
			variableId: z.string().min(1).max(256).optional(),
			value: z.any().optional(),
			eventName: z.string().min(1).max(128).optional(),
			duration: z.number().finite().min(0).max(86400).optional(),
			repeatCount: z.number().int().min(0).max(10000).optional(),
			subgraphId: z.string().min(1).max(256).optional(),
			operator: z.enum(["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual"]).optional(),
			utility: utility.optional(),
			unitId: z.string().min(1).max(128).optional(),
			settings: z.record(z.string(), z.any()).optional(),
		})
		.strict()
);
const nodeChanges = z
	.object({
		type: nodeType.optional(),
		name: z.string().min(1).max(128).optional(),
		position: position.optional(),
		enabled: z.boolean().optional(),
		children: z.array(node).max(512).optional(),
		nodeId: z.string().min(1).max(256).optional(),
		navAgentId: z.string().min(1).max(256).optional(),
		variableId: z.string().min(1).max(256).optional(),
		value: z.any().optional(),
		eventName: z.string().min(1).max(128).optional(),
		duration: z.number().finite().min(0).max(86400).optional(),
		repeatCount: z.number().int().min(0).max(10000).optional(),
		subgraphId: z.string().min(1).max(256).optional(),
		operator: z.enum(["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual"]).optional(),
		utility: utility.optional(),
		unitId: z.string().min(1).max(128).optional(),
		settings: z.record(z.string(), z.any()).optional(),
	})
	.strict();
const graphChanges = z
	.object({
		name: z.string().min(1).max(256).optional(),
		enabled: z.boolean().optional(),
		autoStart: z.boolean().optional(),
		startEvent: z.string().min(1).max(128).optional(),
		agentNodeId: z.string().min(1).max(256).optional(),
		blackboard: z.array(variable).max(128).optional(),
		root: node.optional(),
	})
	.strict();

function readOnly(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict()) {
	return { title, description, inputSchema, annotations: { readOnlyHint: true } };
}

function mutation(title: string, description: string, inputSchema: z.ZodTypeAny) {
	return { title, description, inputSchema };
}

/** Registers complete Behavior Graph authoring, Blackboard, utility/navigation runtime, event, and debugger tools. */
export function registerBehaviorTreeTools(server: McpServer): void {
	server.registerTool("list_behavior_trees", readOnly("List Behavior Graphs", "List normalized version-2 Behavior Graph authoring and exact revisions."), async () =>
		callTextTool("list_behavior_trees")
	);
	server.registerTool("get_behavior_tree", readOnly("Get Behavior Graph", "Read one complete Behavior Graph by exact id or name.", z.object(identity).strict()), async (args) =>
		callTextTool("get_behavior_tree", args)
	);
	server.registerTool(
		"create_behavior_tree",
		mutation(
			"Create Behavior Graph",
			"Create a validated graph with optional Blackboard, reusable/event settings, agent binding, and complete root hierarchy.",
			z
				.object({
					id: z.string().min(1).max(256).optional(),
					name: z.string().min(1).max(256),
					enabled: z.boolean().optional(),
					autoStart: z.boolean().optional(),
					startEvent: z.string().min(1).max(128).optional(),
					agentNodeId: z.string().min(1).max(256).optional(),
					blackboard: z.array(variable).max(128).optional(),
					root: node.optional(),
				})
				.strict()
		),
		async (args) => callTextTool("create_behavior_tree", args)
	);
	server.registerTool(
		"set_behavior_tree",
		mutation(
			"Set Behavior Graph",
			"Exact-revision atomic update of graph settings or complete authoring.",
			z.object({ ...identity, expectedRevision: exactRevision, changes: graphChanges }).strict()
		),
		async (args) => callTextTool("set_behavior_tree", args)
	);
	server.registerTool(
		"delete_behavior_tree",
		mutation(
			"Delete Behavior Graph",
			"Delete one unreferenced exact-revision Behavior Graph.",
			z.object({ ...identity, expectedRevision: exactRevision, confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_behavior_tree", args)
	);
	server.registerTool(
		"validate_behavior_trees",
		readOnly("Validate Behavior Graphs", "Validate all graphs, Blackboard data, node semantics, and acyclic subgraph references."),
		async () => callTextTool("validate_behavior_trees")
	);

	server.registerTool(
		"create_behavior_blackboard_variable",
		mutation(
			"Create Behavior Blackboard Variable",
			"Create one typed Graph- or Scene-scoped Blackboard variable.",
			z.object({ ...identity, expectedRevision: exactRevision, variable }).strict()
		),
		async (args) => callTextTool("create_behavior_blackboard_variable", args)
	);
	server.registerTool(
		"set_behavior_blackboard_variable",
		mutation(
			"Set Behavior Blackboard Variable",
			"Exact-revision update of one typed Blackboard definition.",
			z.object({ ...identity, expectedRevision: exactRevision, variableId: z.string().min(1).max(256), changes: variableChanges }).strict()
		),
		async (args) => callTextTool("set_behavior_blackboard_variable", args)
	);
	server.registerTool(
		"delete_behavior_blackboard_variable",
		mutation(
			"Delete Behavior Blackboard Variable",
			"Delete one unreferenced exact-revision Blackboard variable.",
			z.object({ ...identity, expectedRevision: exactRevision, variableId: z.string().min(1).max(256), confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_behavior_blackboard_variable", args)
	);

	server.registerTool(
		"create_behavior_tree_node",
		mutation(
			"Create Behavior Node",
			"Add one control, condition, action, utility, navigation, event, subgraph, or registered custom node under a parent.",
			z.object({ ...identity, expectedRevision: exactRevision, parentId: z.string().min(1).max(256), index: z.number().int().min(0).max(511).optional(), node }).strict()
		),
		async (args) => callTextTool("create_behavior_tree_node", args)
	);
	server.registerTool(
		"set_behavior_tree_node",
		mutation(
			"Set Behavior Node",
			"Exact-revision update of one node and its bounded authored settings.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(256), changes: nodeChanges }).strict()
		),
		async (args) => callTextTool("set_behavior_tree_node", args)
	);
	server.registerTool(
		"delete_behavior_tree_node",
		mutation(
			"Delete Behavior Node",
			"Delete one non-root exact-revision node and its descendants.",
			z.object({ ...identity, expectedRevision: exactRevision, nodeId: z.string().min(1).max(256), confirm: z.literal(true) }).strict()
		),
		async (args) => callTextTool("delete_behavior_tree_node", args)
	);
	server.registerTool(
		"move_behavior_tree_node",
		mutation(
			"Move Behavior Node",
			"Move one non-root node to a validated parent and sibling index.",
			z
				.object({
					...identity,
					expectedRevision: exactRevision,
					nodeId: z.string().min(1).max(256),
					parentId: z.string().min(1).max(256),
					index: z.number().int().min(0).max(511).optional(),
				})
				.strict()
		),
		async (args) => callTextTool("move_behavior_tree_node", args)
	);

	server.registerTool(
		"run_behavior_tree",
		mutation("Run Behavior Graph", "Reset and start one graph through the shared editor/export runtime.", z.object(identity).strict()),
		async (args) => callTextTool("run_behavior_tree", args)
	);
	server.registerTool(
		"reload_behavior_tree_runtime",
		mutation("Reload Behavior Graph Runtime", "Rebuild live runtime/debug state from current validated authoring.", z.object({}).strict()),
		async () => callTextTool("reload_behavior_tree_runtime")
	);
	server.registerTool(
		"get_behavior_tree_runtime",
		readOnly("Get Behavior Graph Runtime", "Inspect graph/node statuses, Blackboard values, breakpoints, errors, and bounded execution trace.", z.object(identity).strict()),
		async (args) => callTextTool("get_behavior_tree_runtime", args)
	);
	server.registerTool("start_behavior_tree", mutation("Start Behavior Graph", "Reset and start one enabled graph.", z.object(identity).strict()), async (args) =>
		callTextTool("start_behavior_tree", args)
	);
	server.registerTool("stop_behavior_tree", mutation("Stop Behavior Graph", "Stop one graph and its running custom nodes.", z.object(identity).strict()), async (args) =>
		callTextTool("stop_behavior_tree", args)
	);
	server.registerTool(
		"tick_behavior_tree",
		mutation(
			"Tick Behavior Graph",
			"Advance one running graph by a bounded delta for deterministic external verification.",
			z.object({ ...identity, deltaSeconds: z.number().finite().min(0).max(1).optional() }).strict()
		),
		async (args) => callTextTool("tick_behavior_tree", args)
	);
	server.registerTool(
		"dispatch_behavior_tree_event",
		mutation(
			"Dispatch Behavior Event",
			"Publish a typed JSON payload to waiting nodes and event-start graphs, optionally targeting one graph.",
			z.object({ ...identity, eventName: z.string().min(1).max(128), payload: z.any().optional() }).strict()
		),
		async (args) => callTextTool("dispatch_behavior_tree_event", args)
	);
	server.registerTool(
		"set_behavior_tree_runtime_blackboard",
		mutation(
			"Set Behavior Runtime Blackboard",
			"Set one typed transient runtime Blackboard value without changing authoring revision.",
			z.object({ ...identity, variableId: z.string().min(1).max(256).optional(), variableName: z.string().min(1).max(128).optional(), value: z.any() }).strict()
		),
		async (args) => callTextTool("set_behavior_tree_runtime_blackboard", args)
	);
	server.registerTool(
		"set_behavior_tree_breakpoints",
		mutation(
			"Set Behavior Breakpoints",
			"Replace one graph's transient breakpoint set with up to 64 exact node ids.",
			z.object({ ...identity, nodeIds: z.array(z.string().min(1).max(256)).max(64) }).strict()
		),
		async (args) => callTextTool("set_behavior_tree_breakpoints", args)
	);
	server.registerTool(
		"continue_behavior_tree",
		mutation("Continue Behavior Graph", "Continue one paused graph to completion or the next breakpoint.", z.object(identity).strict()),
		async (args) => callTextTool("continue_behavior_tree", args)
	);
	server.registerTool(
		"step_behavior_tree",
		mutation(
			"Step Behavior Graph",
			"Evaluate exactly one node in a paused graph.",
			z.object({ ...identity, deltaSeconds: z.number().finite().min(0).max(1).optional() }).strict()
		),
		async (args) => callTextTool("step_behavior_tree", args)
	);
	server.registerTool(
		"clear_behavior_tree_trace",
		mutation("Clear Behavior Trace", "Clear the bounded transient Behavior Graph trace.", z.object({ confirm: z.literal(true) }).strict()),
		async () => callTextTool("clear_behavior_tree_trace", { confirm: true })
	);
}

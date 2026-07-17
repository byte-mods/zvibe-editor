import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const tree = z.object({ id: z.string().optional(), name: z.string(), root: z.any(), autoRun: z.boolean().optional() });

/** Registers persisted behavior-tree authoring and execution tools. */
export function registerBehaviorTreeTools(server: McpServer): void {
	server.registerTool(
		"list_behavior_trees",
		{
			title: "List behavior trees",
			description: "List persisted behavior trees and their latest execution result.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_behavior_trees", {})
	);
	server.registerTool(
		"create_behavior_tree",
		{
			title: "Create behavior tree",
			description: "Create a behavior tree with sequence, selector, inverter, node-enabled condition, and set-enabled/set-position actions.",
			inputSchema: tree,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_behavior_tree", args)
	);
	server.registerTool(
		"set_behavior_tree",
		{
			title: "Set behavior tree",
			description: "Update a behavior tree root, name, or runtime auto-run setting.",
			inputSchema: tree.partial({ name: true, root: true }).extend({ id: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_behavior_tree", args)
	);
	server.registerTool(
		"run_behavior_tree",
		{
			title: "Run behavior tree",
			description: "Execute a behavior tree against active scene nodes now.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_behavior_tree", args)
	);
	server.registerTool(
		"delete_behavior_tree",
		{ title: "Delete behavior tree", description: "Delete a persisted behavior tree.", inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_behavior_tree", args)
	);
}

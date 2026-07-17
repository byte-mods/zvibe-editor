import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

const graph = z.object({
	id: z.string().optional(),
	name: z.string(),
	variables: z.record(z.string(), z.any()).optional(),
	nodes: z
		.array(
			z.object({
				id: z.string(),
				type: z.enum(["event-start", "set-position", "translate", "set-enabled", "set-variable"]),
				nodeId: z.string().optional(),
				variable: z.string().optional(),
				value: z.any().optional(),
				position: z.array(z.number().finite()).length(2).optional().describe("Persisted freeform canvas position `[x,y]` in graph-editor pixels."),
			})
		)
		.optional(),
	edges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
	autoRun: z.boolean().optional(),
});
/** Registers persisted executable visual-scripting graph tools. */
export function registerVisualScriptingTools(server: McpServer): void {
	server.registerTool(
		"list_visual_script_graphs",
		{
			title: "List visual script graphs",
			description: "List persisted visual-scripting graphs and latest execution state.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_visual_script_graphs", {})
	);
	server.registerTool(
		"create_visual_script_graph",
		{
			title: "Create visual script graph",
			description: "Create a persisted executable graph. Declare graph variables, set them with set-variable, and reference them in action values as { variable: name }.",
			inputSchema: graph,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_visual_script_graph", args)
	);
	server.registerTool(
		"set_visual_script_graph",
		{
			title: "Set visual script graph",
			description: "Update graph variables, nodes, edges, name, or auto-run state.",
			inputSchema: graph.partial({ name: true }).extend({ id: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_visual_script_graph", args)
	);
	server.registerTool(
		"set_visual_script_node_position",
		{
			title: "Position visual script node",
			description: "Persist a freeform canvas position for one visual-script node without replacing the graph.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional(), nodeId: z.string(), position: z.array(z.number().finite()).length(2) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_visual_script_node_position", args)
	);
	server.registerTool(
		"run_visual_script_graph",
		{
			title: "Run visual script graph",
			description: "Execute a graph over the active scene nodes now.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_visual_script_graph", args)
	);
	server.registerTool(
		"delete_visual_script_graph",
		{
			title: "Delete visual script graph",
			description: "Delete a persisted visual-scripting graph.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_visual_script_graph", args)
	);
}

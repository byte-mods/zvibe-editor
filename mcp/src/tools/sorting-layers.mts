import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
export function registerSortingLayerTools(server: McpServer): void {
	server.registerTool(
		"list_sorting_layers",
		{ title: "List sorting layers", description: "List persisted 2D render-order layers.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_sorting_layers", {})
	);
	server.registerTool(
		"create_sorting_layer",
		{
			title: "Create sorting layer",
			description: "Create a named render-order layer from 0 through 3.",
			inputSchema: z.object({ name: z.string(), order: z.number().int().min(0).max(3).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sorting_layer", args)
	);
	server.registerTool(
		"delete_sorting_layer",
		{
			title: "Delete sorting layer",
			description: "Delete one named/id sorting layer after confirm=true and reset every assigned renderable node to the default render order.",
			inputSchema: z
				.object({ layerId: z.string().min(1).optional(), layerName: z.string().min(1).optional(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.layerId || value.layerName), "Provide layerId or layerName."),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_sorting_layer", args)
	);
	server.registerTool(
		"set_node_sorting_layer",
		{
			title: "Set node sorting layer",
			description: "Assign a renderable node to a sorting layer and within-layer alpha index.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				layerId: z.string().optional(),
				layerName: z.string().optional(),
				orderInLayer: z.number().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_sorting_layer", args)
	);
}

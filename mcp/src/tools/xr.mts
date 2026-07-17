import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
export function registerXRTools(server: McpServer): void {
	server.registerTool(
		"get_xr_configuration",
		{
			title: "Get XR configuration",
			description: "Read persisted WebXR authoring settings for the active scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_xr_configuration", {})
	);
	server.registerTool(
		"set_xr_configuration",
		{
			title: "Set XR configuration",
			description: "Persist WebXR enablement, reference space, floor meshes, and requested features for the active scene.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				referenceSpaceType: z.enum(["local", "local-floor", "bounded-floor", "unbounded"]).optional(),
				floorMeshIds: z.array(z.string()).optional(),
				features: z.array(z.string()).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_xr_configuration", args)
	);
}

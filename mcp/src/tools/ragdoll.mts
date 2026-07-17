import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

export function registerRagdollTools(server: McpServer): void {
	server.registerTool(
		"list_ragdolls",
		{ title: "List ragdolls", description: "List editable .ragdoll configuration assets.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_ragdolls", {})
	);
	server.registerTool(
		"get_ragdoll",
		{
			title: "Get ragdoll",
			description: "Read a native Ragdoll Editor asset: source model, skeleton/root selection, scaling, bones, constraints, and axes.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_ragdoll", args)
	);
	server.registerTool(
		"save_ragdoll",
		{
			title: "Save ragdoll",
			description:
				"Create or update a native editable .ragdoll configuration. Supply the full runtimeConfiguration to author bones and constraints; use get_ragdoll first when modifying an existing asset.",
			inputSchema: z.object({ path: z.string(), configuration: z.record(z.string(), z.any()), overwrite: z.literal(true).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_ragdoll", args)
	);
}

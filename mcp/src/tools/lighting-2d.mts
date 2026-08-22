import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const runtimeTarget = z.enum(["auto", "edit", "play"]).optional().describe("auto selects active compiled Play when ready, otherwise the Edit scene.");

/** Registers bounded discovery and measured-runtime diagnostics for the extensible 2D lighting pipeline. */
export function registerLighting2DTools(server: McpServer): void {
	server.registerTool(
		"list_light2d_provider_types",
		{
			title: "List Light2D provider types",
			description:
				"List built-in and project-registered Light2D/ShadowShape2D provider definitions from the editor module or exact compiled Play bundle, including versions, defaults, and registry scope.",
			inputSchema: z
				.object({
					target: runtimeTarget,
					kind: z.enum(["light", "shadow", "all"]).optional(),
					cursor: z.string().regex(/^\d+$/).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_light2d_provider_types", args)
	);

	server.registerTool(
		"get_lighting2d_runtime",
		{
			title: "Get Light2D runtime evidence",
			description:
				"Read measured Light2D/ShadowCaster2D provider lifecycle, validation errors, resolved consumer counts, frame timing, dropped-capacity counts, and hard runtime limits from Edit or the exact compiled Play scene.",
			inputSchema: z.object({ target: runtimeTarget }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_lighting2d_runtime", args)
	);
}

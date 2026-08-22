import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerCollaborationTools(server: McpServer): void {
	server.registerTool(
		"get_project_collaboration_capabilities",
		{
			title: "Get project collaboration capabilities",
			description:
				"Inspect the exact Unity-comparable collaboration contract implemented by Zvibe Editor: roles, presence, revision-guarded scene edits, collaborative text and ordered data, semantic scene/prefab merge, asset locks, remote transports, and review workflows. Explicitly reports automatic-merge boundaries without changing the project or returning credentials.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_collaboration_capabilities")
	);

	server.registerTool(
		"validate_project_collaboration_readiness",
		{
			title: "Validate project collaboration readiness",
			description:
				"Audit the open project's legacy-local, authenticated-local, semantic-conflict, review, gateway, relay, discovery, and federated-lock readiness. Uses the active MCP collaboration session when present, returns actionable findings, never changes project state, and never returns credentials.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("validate_project_collaboration_readiness")
	);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const gizmoType = z.enum(["position", "rotation", "scaling", "none"]);

export function registerEditorControlTools(server: McpServer): void {
	server.registerTool(
		"get_gizmo_settings",
		{
			title: "Get gizmo settings",
			description: "Get the active transform gizmo, snap preferences, and local/world coordinate mode.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_gizmo_settings", {})
	);
	server.registerTool(
		"set_gizmo_settings",
		{
			title: "Set gizmo settings",
			description: "Set transform-gizmo mode, snap preferences, and coordinate mode in the editor viewport.",
			inputSchema: z.object({
				activeGizmo: gizmoType.optional(),
				coordinateMode: z.enum(["local", "world"]).optional(),
				snap: z
					.object({
						translationEnabled: z.boolean().optional(),
						translationStep: z.number().positive().optional(),
						rotationEnabled: z.boolean().optional(),
						rotationStepDegrees: z.number().positive().optional(),
						scaleEnabled: z.boolean().optional(),
						scaleStep: z.number().positive().optional(),
					})
					.optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gizmo_settings", args)
	);
	server.registerTool(
		"list_editor_tabs",
		{ title: "List editor tabs", description: "List editor panel tab identifiers that can be selected.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_editor_tabs", {})
	);
	server.registerTool(
		"select_editor_tab",
		{
			title: "Select editor tab",
			description: "Bring an existing editor panel tab to the foreground.",
			inputSchema: z.object({ tab: z.enum(["graph", "preview", "assets-browser", "console", "terminal", "inspector", "animations", "marketplace"]) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("select_editor_tab", args)
	);
	server.registerTool(
		"write_editor_console",
		{
			title: "Write editor console",
			description: "Write a log, warning, or error message to the editor console.",
			inputSchema: z.object({ message: z.string(), level: z.enum(["log", "warn", "error"]).default("log") }),
		},
		async (args): Promise<CallToolResult> => callTextTool("write_editor_console", args)
	);
	server.registerTool(
		"clear_editor_console",
		{ title: "Clear editor console", description: "Clear all messages from the editor console.", inputSchema: z.object({}), annotations: { destructiveHint: true } },
		async (): Promise<CallToolResult> => callTextTool("clear_editor_console", {})
	);
	server.registerTool(
		"run_editor_terminal_command",
		{
			title: "Run editor terminal command",
			description:
				"Run a shell command in the open project's root through the editor terminal and return its output. This can modify files or execute arbitrary code; requires explicit confirmation.",
			inputSchema: z.object({ command: z.string().min(1), confirm: z.literal(true) }),
			annotations: { destructiveHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("run_editor_terminal_command", args)
	);
}

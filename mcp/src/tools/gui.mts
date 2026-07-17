import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

const guiIdentity = { guiId: z.string().optional().describe("Fullscreen GUI id (preferred)."), guiName: z.string().optional().describe("Fullscreen GUI name.") };

export function registerGUITools(server: McpServer): void {
	server.registerTool(
		"list_guis",
		{
			title: "List GUI",
			description: "List fullscreen Advanced Dynamic Texture GUI instances in the active scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_guis", {})
	);
	server.registerTool(
		"create_gui_asset",
		{
			title: "Create GUI asset",
			description: "Create a saved, editable fullscreen `.gui` asset inside the project. Instantiate it separately to add it to the active scene.",
			inputSchema: z.object({ path: z.string().min(1).describe("Project-relative .gui path."), name: z.string().optional().describe("GUI display name.") }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_gui_asset", args)
	);
	server.registerTool(
		"get_gui_asset",
		{
			title: "Get GUI asset",
			description: "Read serialized content from a saved .gui asset.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_asset", args)
	);
	server.registerTool(
		"instantiate_gui_asset",
		{
			title: "Instantiate GUI asset",
			description: "Load a saved fullscreen .gui asset into the active editor scene.",
			inputSchema: z.object({ path: z.string().min(1).describe("Project-relative .gui path.") }),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_gui_asset", args)
	);
	server.registerTool(
		"get_gui_content",
		{
			title: "Get GUI content",
			description: "Get an active GUI's serialized control tree for inspection or modification.",
			inputSchema: z.object(guiIdentity),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_content", args)
	);
	server.registerTool(
		"set_gui_content",
		{
			title: "Set GUI content",
			description: "Rename an active GUI and/or replace its serialized AdvancedDynamicTexture control tree. Use get_gui_content first to preserve existing controls.",
			inputSchema: z.object({ ...guiIdentity, name: z.string().optional(), content: z.record(z.string(), z.any()).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_content", args)
	);
	server.registerTool(
		"validate_gui_accessibility",
		{
			title: "Validate GUI accessibility",
			description:
				"Read-only audit for duplicate GUI control names, text smaller than 12px, unlabeled interactive controls, and low contrast where explicit foreground/background colors can be read. Omit GUI identity to audit every fullscreen GUI in the active scene.",
			inputSchema: z.object(guiIdentity),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_gui_accessibility", args)
	);
	server.registerTool(
		"save_gui_asset",
		{
			title: "Save GUI asset",
			description: "Serialize an active fullscreen GUI to a project-relative .gui asset. Existing files require explicit overwrite confirmation.",
			inputSchema: z.object({ ...guiIdentity, path: z.string().min(1), overwrite: z.literal(true).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("save_gui_asset", args)
	);
}

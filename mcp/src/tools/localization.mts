import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
export function registerLocalizationTools(server: McpServer): void {
	server.registerTool(
		"list_localization_tables",
		{ title: "List localization tables", description: "List persisted project localization tables.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_localization_tables", {})
	);
	server.registerTool(
		"create_localization_table",
		{
			title: "Create localization table",
			description: "Create a locale table with a fallback locale.",
			inputSchema: z.object({ name: z.string(), fallbackLocale: z.string().optional(), entries: z.record(z.string(), z.record(z.string(), z.string())).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_localization_table", args)
	);
	server.registerTool(
		"delete_localization_table",
		{
			title: "Delete localization table",
			description: "Delete one persisted project localization table and all of its localized entries.",
			inputSchema: z.object({ name: z.string() }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_localization_table", args)
	);
	server.registerTool(
		"set_localization_entry",
		{
			title: "Set localization entry",
			description: "Set a localized string for a table key and locale.",
			inputSchema: z.object({ name: z.string(), key: z.string(), locale: z.string(), value: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_localization_entry", args)
	);
	server.registerTool(
		"delete_localization_entry",
		{
			title: "Delete localization entry",
			description: "Delete one locale value from a localization key; removes the key if no locales remain.",
			inputSchema: z.object({ name: z.string(), key: z.string(), locale: z.string() }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_localization_entry", args)
	);
	server.registerTool(
		"pseudo_localize_entry",
		{
			title: "Pseudo-localize entry",
			description: "Resolve an entry then return an expanded accented pseudo-locale string for UI layout testing.",
			inputSchema: z.object({ name: z.string(), key: z.string(), locale: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("pseudo_localize_entry", args)
	);
	server.registerTool(
		"resolve_localization_entry",
		{
			title: "Resolve localization entry",
			description: "Resolve a localized string with automatic fallback-locale lookup.",
			inputSchema: z.object({ name: z.string(), key: z.string(), locale: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("resolve_localization_entry", args)
	);
	server.registerTool(
		"validate_localization",
		{
			title: "Validate localization",
			description: "Report missing fallback strings, incomplete locale coverage, empty values, and {placeholder} mismatches. Omit name to validate every project table.",
			inputSchema: z.object({ name: z.string().optional().describe("Optional localization table name to validate.") }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_localization", args)
	);
}

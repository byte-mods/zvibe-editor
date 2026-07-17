import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
export function registerAddressableTools(server: McpServer): void {
	server.registerTool(
		"list_addressable_groups",
		{
			title: "List addressable groups",
			description: "List persisted addressable asset groups and memberships.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_addressable_groups", {})
	);
	server.registerTool(
		"create_addressable_group",
		{
			title: "Create addressable group",
			description: "Create a persisted addressable group, optionally with a remote content base URL.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string(), remoteUrl: z.string().url().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_addressable_group", args)
	);
	const asset = z.object({ id: z.string().optional(), name: z.string().optional(), assetPath: z.string() });
	server.registerTool(
		"assign_addressable_asset",
		{ title: "Assign addressable asset", description: "Assign a project file to one addressable group.", inputSchema: asset },
		async (args): Promise<CallToolResult> => callTextTool("assign_addressable_asset", args)
	);
	server.registerTool(
		"remove_addressable_asset",
		{ title: "Remove addressable asset", description: "Remove a file from an addressable group.", inputSchema: asset },
		async (args): Promise<CallToolResult> => callTextTool("remove_addressable_asset", args)
	);
	server.registerTool(
		"set_addressable_asset_labels",
		{
			title: "Set addressable labels",
			description: "Replace the labels assigned to an addressable asset in its group.",
			inputSchema: asset.extend({ labels: z.array(z.string().min(1)) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_addressable_asset_labels", args)
	);
	server.registerTool(
		"find_addressable_assets_by_labels",
		{
			title: "Find addressables by labels",
			description: "Find catalog source assets that have all (default) or any requested labels.",
			inputSchema: z.object({ labels: z.array(z.string().min(1)).min(1), match: z.enum(["all", "any"]).optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("find_addressable_assets_by_labels", args)
	);
	server.registerTool(
		"diff_addressable_catalogs",
		{
			title: "Diff addressable catalogs",
			description: "Compare two generated local catalogs and report added, changed, removed, and unchanged assets by group/path/content hash/labels.",
			inputSchema: z.object({ previousCatalogPath: z.string(), nextCatalogPath: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("diff_addressable_catalogs", args)
	);
	server.registerTool(
		"build_addressable_catalog",
		{
			title: "Build addressable catalog",
			description: "Generate a portable JSON catalog with group membership, file size, and SHA-256 content hashes.",
			inputSchema: z.object({ outputPath: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("build_addressable_catalog", args)
	);
}

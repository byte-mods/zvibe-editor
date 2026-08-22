import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const artifactKind = z.enum(["texture", "model", "audio", "video", "font", "material", "animation"]);
const outcome = z.enum(["bypass", "hit", "miss", "error"]);
const configurationPatch = z
	.object({
		enabled: z.boolean().optional(),
		endpoint: z.string().url().max(2048).optional(),
		namespacePrefix: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
			.optional(),
		downloadEnabled: z.boolean().optional(),
		uploadEnabled: z.boolean().optional(),
		authenticationEnvironmentVariable: z
			.string()
			.max(128)
			.refine((value) => value === "" || /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value), "Must be empty or a valid environment-variable name.")
			.optional(),
		contentValidation: z.enum(["disabled", "uploadOnly", "enabled", "required"]).optional(),
		downloadBatchSize: z.number().int().min(1).max(32).optional(),
		requestTimeoutMilliseconds: z.number().int().min(1000).max(300000).optional(),
		maximumResultSizeBytes: z.number().int().min(1_048_576).max(2_147_483_648).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "At least one Import Accelerator setting is required.");

export function registerImportAcceleratorTools(server: McpServer): void {
	server.registerTool(
		"get_import_accelerator_capabilities",
		{
			title: "Get Import Accelerator capabilities",
			description: "Read the cache protocol version, seven supported artifact kinds, and atomic integrity guarantees. Use before configuring or interpreting diagnostics.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_import_accelerator_capabilities", {})
	);

	server.registerTool(
		"get_import_accelerator_configuration",
		{
			title: "Get Import Accelerator configuration",
			description:
				"Read normalized project-owned endpoint, namespace, transfer, validation, batching, timeout, and size policy plus the exact Project Settings revision. Authentication values are never returned; only variable-name availability is reported.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_import_accelerator_configuration", {})
	);

	server.registerTool(
		"set_import_accelerator_configuration",
		{
			title: "Set Import Accelerator configuration",
			description:
				"Patch Import Accelerator policy at the exact Project Settings revision. Remote HTTP is rejected except on loopback; URL credentials, queries, and fragments reject; bearer secrets must stay in the named environment variable.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), configuration: configurationPatch }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_import_accelerator_configuration", args)
	);

	server.registerTool(
		"check_import_accelerator_connection",
		{
			title: "Check Import Accelerator connection",
			description:
				"Probe the configured /v1/health endpoint under the project timeout and environment-only authentication policy without uploading or modifying cache content.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("check_import_accelerator_connection", {})
	);

	server.registerTool(
		"get_import_accelerator_diagnostics",
		{
			title: "Get Import Accelerator diagnostics",
			description:
				"Read bounded hit, miss, bypass, error, byte, and recent-activity diagnostics with exact revision and pagination. Optional kind/outcome filters do not expose authorization values.",
			inputSchema: z
				.object({
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					kind: artifactKind.optional(),
					outcome: outcome.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_import_accelerator_diagnostics", args)
	);

	server.registerTool(
		"clear_import_accelerator_diagnostics",
		{
			title: "Clear Import Accelerator diagnostics",
			description:
				"Clear local Accelerator counters and recent activities only, under the exact diagnostics revision and confirm=true. Remote cached artifacts are not deleted.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_import_accelerator_diagnostics", args)
	);
}

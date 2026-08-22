import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const transientMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const transientCancel = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const transientReset = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const profileId = z.string().min(1).max(128);
const buildRevision = z.number().int().min(0);
const runtimeRevision = z.number().int().min(1);
const requestId = z
	.string()
	.regex(/^asset-stream-[1-9]\d*$/)
	.max(64);

export function registerAssetStreamingTools(server: McpServer): void {
	server.registerTool(
		"get_asset_streaming_capabilities",
		{
			title: "Get asset streaming capabilities",
			description:
				"Read the disabled-by-default Windows Electron setting, priority order, project probe roots, byte/job bounds, portable asynchronous-file backend, and explicit lack of bundled Microsoft DirectStorage/GPU-decompression identity.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_streaming_capabilities", {})
	);

	server.registerTool(
		"get_build_profile_asset_streaming_plan",
		{
			title: "Get Build Profile asset streaming plan",
			description:
				"Inspect one Electron Build Profile's normalized Windows opt-in and scheduler settings, exact Build Profiles revision, effective platform/backend, warnings, and native-adapter boundary without opening files or building.",
			inputSchema: z.object({ id: profileId }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_build_profile_asset_streaming_plan", args)
	);

	server.registerTool(
		"prepare_asset_streaming_runtime",
		{
			title: "Prepare asset streaming runtime",
			description:
				"Prepare a transient priority scheduler from one exact persisted Electron Build Profile and current project root. This replaces prior transient streaming evidence but does not change the profile or project files.",
			inputSchema: z.object({ id: profileId, expectedBuildRevision: buildRevision }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("prepare_asset_streaming_runtime", args)
	);

	server.registerTool(
		"get_asset_streaming_runtime",
		{
			title: "Get asset streaming runtime",
			description:
				"Read the prepared scheduler's exact runtime revision, queued/active requests, bounded event/totals diagnostics, and a paginated page of hash-only file-probe jobs. Use the latest revision before start, cancel, or reset.",
			inputSchema: z.object({ offset: z.number().int().min(0).max(256).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_streaming_runtime", args)
	);

	server.registerTool(
		"start_asset_streaming_file_probe",
		{
			title: "Start asset streaming file probe",
			description:
				"Start one cancellable, priority-scheduled background read of a bounded range inside project assets/ or public/. Results retain only request state, byte count, and SHA-256—never file bytes or absolute paths. Poll get_asset_streaming_runtime for completion.",
			inputSchema: z
				.object({
					expectedRuntimeRevision: runtimeRevision,
					path: z
						.string()
						.min(1)
						.max(2_048)
						.regex(/^(assets|public)\//),
					offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
					length: z
						.number()
						.int()
						.min(1)
						.max(64 * 1024 * 1024)
						.optional(),
					priority: z.enum(["critical", "high", "normal", "low", "background"]).optional(),
					chunkDelayMs: z.number().int().min(0).max(100).optional(),
				})
				.strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_asset_streaming_file_probe", args)
	);

	server.registerTool(
		"cancel_asset_streaming_request",
		{
			title: "Cancel asset streaming request",
			description:
				"Cancel exactly one currently queued or active file probe under the latest runtime revision. Completed evidence and all authored project files remain unchanged.",
			inputSchema: z.object({ expectedRuntimeRevision: runtimeRevision, requestId }).strict(),
			annotations: transientCancel,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_asset_streaming_request", args)
	);

	server.registerTool(
		"reset_asset_streaming_runtime",
		{
			title: "Reset asset streaming runtime",
			description:
				"Clear terminal probe jobs and bounded scheduler evidence under the latest runtime revision. Reset is rejected while work is queued/active and never changes persisted Build Profile settings or files.",
			inputSchema: z.object({ expectedRuntimeRevision: runtimeRevision, confirm: z.literal(true) }).strict(),
			annotations: transientReset,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_asset_streaming_runtime", args)
	);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identifier = z.string().min(1).max(160);
const revision = z.number().int().positive().describe("Exact revision returned by get_profiler_state or the preceding profiler mutation.");
const modules = z
	.array(z.enum(["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio", "2d"]))
	.min(1)
	.max(9)
	.refine((value) => new Set(value).size === value.length, "Profiler modules must be unique.");

export function registerProfilingTools(server: McpServer): void {
	server.registerTool(
		"get_profiler_capabilities",
		{
			title: "Get profiler capabilities",
			description: "Discover portable profiler targets, modules, views, hard bounds, and honest browser/backend limitations.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_profiler_capabilities")
	);

	server.registerTool(
		"get_profiler_state",
		{
			title: "Get profiler state",
			description:
				"Get the exact persisted profiler revision, active session, compact retained capture summaries, and compact memory-snapshot descriptions without large frame/marker arrays.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_profiler_state")
	);

	server.registerTool(
		"get_2d_profiler_state",
		{
			title: "Get 2D atlas profiler state",
			description:
				"Inspect bounded live sprite-atlas owners, texture allocation, region occupancy, sprite/tile usage, and draw-call estimates; or read aggregate 2D counters from one retained frame.",
			inputSchema: z
				.object({
					captureId: identifier.optional(),
					captureName: z.string().min(1).max(120).optional(),
					frameIndex: z.number().int().nonnegative().optional(),
				})
				.strict()
				.refine((value) => value.frameIndex === undefined || Boolean(value.captureId || value.captureName), "frameIndex requires captureId or captureName."),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_2d_profiler_state", args)
	);

	server.registerTool(
		"get_profiler_run_status",
		{
			title: "Get profiler run status",
			description: "Inspect transient Edit, Play, or connected-player capture progress, remote terminal/collectable state, and the latest completed capture summary.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_profiler_run_status")
	);

	server.registerTool(
		"list_profiler_captures",
		{
			title: "List profiler captures",
			description: "Page and filter retained CPU/GPU/rendering/memory/loading/script profiler summaries.",
			inputSchema: z
				.object({
					offset: z.number().int().nonnegative().optional(),
					limit: z.number().int().min(1).max(100).optional(),
					search: z.string().max(240).optional(),
					target: z.enum(["editor-edit", "editor-play", "connected-player"]).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_profiler_captures", args)
	);

	server.registerTool(
		"get_profiler_capture",
		{
			title: "Get profiler capture",
			description: "Read bounded pages of frames, raw/timeline markers or aggregated hierarchy/inverted hierarchy, and asset-loading events from one retained capture.",
			inputSchema: z
				.object({
					id: identifier.optional(),
					name: z.string().min(1).max(120).optional(),
					frameOffset: z.number().int().nonnegative().optional(),
					frameLimit: z.number().int().min(1).max(1_000).optional(),
					markerOffset: z.number().int().nonnegative().optional(),
					markerLimit: z.number().int().min(1).max(2_000).optional(),
					assetOffset: z.number().int().nonnegative().optional(),
					assetLimit: z.number().int().min(1).max(2_000).optional(),
					memorySnapshotOffset: z.number().int().nonnegative().optional(),
					memorySnapshotLimit: z.number().int().min(1).max(4).optional(),
					search: z.string().max(240).optional(),
					category: z.enum(["Scripts", "Rendering", "Physics", "Animation", "Assets", "Audio", "User"]).optional(),
					view: z.enum(["timeline", "hierarchy", "inverted-hierarchy", "raw-hierarchy"]).optional(),
				})
				.strict()
				.refine((value) => Boolean(value.id || value.name), "Provide id or name."),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_profiler_capture", args)
	);

	server.registerTool(
		"start_profiler_capture",
		{
			title: "Start profiler capture",
			description:
				"Start one bounded capture against the Edit scene, the real compiled Play scene, or an authenticated Device Lab player. Connected players require connectionId and confirm=true.",
			inputSchema: z
				.object({
					expectedRevision: revision,
					id: identifier.optional(),
					name: z.string().trim().min(1).max(120),
					target: z.enum(["editor-edit", "editor-play", "connected-player"]).optional(),
					connectionId: identifier.optional(),
					modules: modules.optional(),
					sampleEveryFrames: z.number().int().min(1).max(600).optional(),
					maximumFrames: z.number().int().min(1).max(36_000).optional(),
					maximumDurationMs: z.number().int().min(100).max(3_600_000).optional(),
					timeoutMs: z.number().int().min(250).max(600_000).optional(),
					confirm: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_profiler_capture", args)
	);

	server.registerTool(
		"stop_profiler_capture",
		{
			title: "Stop profiler capture",
			description:
				"Stop or cancel the active capture, dispose instrumentation, retrieve paged remote evidence when applicable, and retain the final report. A failed remote page/release remains reserved for retry; cancel=true deliberately releases already-stopped retry evidence.",
			inputSchema: z.object({ expectedRevision: revision, id: identifier.optional(), cancel: z.boolean().optional(), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_profiler_capture", args)
	);

	server.registerTool(
		"delete_profiler_capture",
		{
			title: "Delete profiler capture",
			description: "Permanently delete one inactive retained profiler capture.",
			inputSchema: z
				.object({ expectedRevision: revision, id: identifier.optional(), name: z.string().min(1).max(120).optional(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.id || value.name), "Provide id or name."),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_profiler_capture", args)
	);

	server.registerTool(
		"list_profiler_snapshots",
		{
			title: "List profiler memory snapshots",
			description: "Page compact retained JavaScript-heap, scene-resource estimate, and resource-count snapshot descriptions; use comparison for detailed growth evidence.",
			inputSchema: z.object({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_profiler_snapshots", args)
	);

	server.registerTool(
		"capture_profiler_snapshot",
		{
			title: "Capture profiler memory snapshot",
			description:
				"Capture current heap counters when exposed plus deterministic geometry/texture estimates and scene-resource counts; optionally associates the snapshot with the active local capture.",
			inputSchema: z.object({ expectedRevision: revision, name: z.string().trim().min(1).max(120), confirm: z.boolean().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_profiler_snapshot", args)
	);

	server.registerTool(
		"compare_profiler_snapshots",
		{
			title: "Compare profiler memory snapshots",
			description: "Compare heap/resource metrics and object counts, returning ranked potential growth without claiming that growth alone proves a leak.",
			inputSchema: z.object({ baseline: identifier, current: identifier }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("compare_profiler_snapshots", args)
	);

	server.registerTool(
		"delete_profiler_snapshot",
		{
			title: "Delete profiler memory snapshot",
			description: "Permanently delete one retained profiler memory snapshot.",
			inputSchema: z
				.object({ expectedRevision: revision, id: identifier.optional(), name: z.string().min(1).max(120).optional(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.id || value.name), "Provide id or name."),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_profiler_snapshot", args)
	);

	server.registerTool(
		"export_profiler_capture",
		{
			title: "Export profiler capture",
			description:
				"Atomically write one portable profiler capture as bounded project-contained JSON under .bjseditor/profiler by default. Explicit or existing paths require confirm=true.",
			inputSchema: z
				.object({
					id: identifier.optional(),
					name: z.string().min(1).max(120).optional(),
					path: z.string().min(1).max(1_024).optional(),
					confirm: z.literal(true).optional(),
				})
				.strict()
				.refine((value) => Boolean(value.id || value.name), "Provide id or name."),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("export_profiler_capture", args)
	);

	server.registerTool(
		"import_profiler_capture",
		{
			title: "Import profiler capture",
			description: "Validate and retain a portable v2 profiler JSON file (with strict v1 migration) from inside the open project, subject to a 50 MiB and 36,000-frame cap.",
			inputSchema: z.object({ expectedRevision: revision, path: z.string().min(1).max(1_024), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("import_profiler_capture", args)
	);

	server.registerTool(
		"clear_profiler_data",
		{
			title: "Clear profiler evidence",
			description: "Permanently clear all retained captures and memory snapshots after the active capture has stopped.",
			inputSchema: z.object({ expectedRevision: revision, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_profiler_data", args)
	);
}

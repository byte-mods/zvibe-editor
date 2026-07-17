import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerEditorTools(server: McpServer): void {
	server.registerTool(
		"get_editor_status",
		{
			title: "Get editor status",
			description:
				"Get the live Babylon.js Editor/project/preview status before making changes. Returns the open project and scene paths, play state, undo/redo state, experimental-feature flag, and scene resource counts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_editor_status")
	);

	server.registerTool(
		"get_editor_capabilities",
		{
			title: "Get editor MCP capabilities",
			description:
				"Discover which Babylon.js Editor feature domains are currently exposed through MCP. Call this before relying on a feature that may be unavailable in the connected editor version.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_editor_capabilities")
	);

	server.registerTool(
		"get_scene_diagnostics",
		{
			title: "Get scene diagnostics",
			description: "Get live frame timing, draw calls, active meshes, vertex count, and scene resource counts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_scene_diagnostics")
	);
	server.registerTool(
		"get_device_simulation",
		{
			title: "Get device simulation",
			description: "Get the persisted preview device simulator resolution, orientation, DPI, and safe-area profile.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_device_simulation")
	);
	server.registerTool(
		"set_device_simulation",
		{
			title: "Set device simulation",
			description:
				"Configure the editor preview's actual Babylon engine view for a mobile device resolution, orientation, DPI, and safe area. Set enabled false to return to panel-fit rendering.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				width: z.number().int().min(160).max(16384).optional(),
				height: z.number().int().min(160).max(16384).optional(),
				dpi: z.number().positive().max(2000).optional(),
				orientation: z.enum(["portrait", "landscape"]).optional(),
				safeArea: z.array(z.number().nonnegative()).length(4).optional().describe("[top, right, bottom, left] pixels."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_device_simulation", args)
	);

	server.registerTool(
		"list_profiler_snapshots",
		{ title: "List profiler snapshots", description: "List persisted renderer/scene diagnostics snapshots.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_profiler_snapshots")
	);
	server.registerTool(
		"capture_profiler_snapshot",
		{
			title: "Capture profiler snapshot",
			description: "Capture current scene diagnostics under a name; replaces an existing snapshot of the same name.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_profiler_snapshot", args)
	);
	server.registerTool(
		"compare_profiler_snapshots",
		{
			title: "Compare profiler snapshots",
			description: "Compare numeric diagnostics between two named/id profiler snapshots.",
			inputSchema: z.object({ baseline: z.string(), current: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("compare_profiler_snapshots", args)
	);
	server.registerTool(
		"list_profiler_captures",
		{
			title: "List profiler captures",
			description: "List bounded renderer/scene metric capture sessions with numeric summaries.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_profiler_captures")
	);
	server.registerTool(
		"get_profiler_capture",
		{
			title: "Get profiler capture",
			description: "Read a profiler capture's timestamped samples and per-metric min/max/average summary.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_profiler_capture", args)
	);
	server.registerTool(
		"start_profiler_capture",
		{
			title: "Start profiler capture",
			description: "Start a bounded preview profiler capture. Samples frame timing, draw calls, active meshes, vertices, and resource counts at a fixed interval.",
			inputSchema: z.object({
				id: z.string().optional(),
				name: z.string().min(1),
				sampleIntervalMs: z.number().int().min(1).max(10000).optional(),
				maxSamples: z.number().int().min(1).max(36000).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("start_profiler_capture", args)
	);
	server.registerTool(
		"stop_profiler_capture",
		{
			title: "Stop profiler capture",
			description: "Stop an active profiler capture while retaining its samples and summary.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_profiler_capture", args)
	);
	server.registerTool(
		"delete_profiler_capture",
		{
			title: "Delete profiler capture",
			description: "Delete a profiler capture and its sampled metrics.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_profiler_capture", args)
	);
	server.registerTool(
		"undo_editor",
		{
			title: "Undo editor operation",
			description: "Undo the latest operation recorded in the Babylon.js Editor undo stack. Returns `undone: false` when there is no operation to undo.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("undo_editor")
	);

	server.registerTool(
		"redo_editor",
		{
			title: "Redo editor operation",
			description: "Redo the next operation recorded in the Babylon.js Editor undo stack. Returns `redone: false` when there is no operation to redo.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("redo_editor")
	);

	server.registerTool(
		"set_preview_play_mode",
		{
			title: "Control preview play mode",
			description:
				"Play, stop, or restart the scene inside the editor preview. This is distinct from `run_project`, which starts the project's external development process.",
			inputSchema: z.object({
				action: z.enum(["play", "stop", "restart"]).describe("Preview action to perform."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_preview_play_mode", args)
	);
}

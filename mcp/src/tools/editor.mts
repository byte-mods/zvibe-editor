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
		"set_inspector_search",
		{
			title: "Set Inspector search",
			description:
				"Apply or clear the visible Inspector field filter through the same state used by direct UI input. Search is case-insensitive, normalizes camelCase and path separators, and requires every whitespace-separated term to match a field label, property path, tooltip, or nested section declaration. Pass an empty query to restore every field.",
			inputSchema: z.object({ query: z.string().max(128).describe("Inspector search text, or an empty string to clear the filter.") }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_inspector_search", args)
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
		"get_render_debug_view",
		{
			title: "Get render debug view",
			description:
				"Inspect the editor preview's transient overdraw or light-complexity view. Returns the exact revision lease, active mode, backend/shader language, readiness, target size, eligible mesh/light counts, light-count histogram, rendered-frame evidence, and explicit accuracy limitations. Use the returned revision with set_render_debug_view or capture_render_debug_view.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_render_debug_view")
	);

	server.registerTool(
		"set_render_debug_view",
		{
			title: "Set render debug view",
			description:
				"Exact-revision activation, reconfiguration, or disposal of the editor preview's transient renderer diagnostic overlay. Overdraw uses additive material-override fragment submissions with disabled depth and a configurable 4-32 display saturation. Light complexity heat-maps each eligible mesh by the 0-16 enabled Babylon lights accepted by its inclusion/layer filters. This does not modify authored materials or persisted scene data; pass mode disabled to release every transient target, layer, and material.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().positive().describe("Exact revision returned by get_render_debug_view."),
					mode: z.enum(["disabled", "overdraw", "light-complexity"]).describe("Transient diagnostic mode to activate, or disabled to release it."),
					maximumOverdraw: z.number().int().min(4).max(32).optional().describe("Overdraw display saturation count; defaults to the prior value or 8."),
					maximumLightCount: z.number().int().min(1).max(16).optional().describe("Highest light-count heat-map bucket; defaults to the prior value or 8."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_render_debug_view", args)
	);

	server.registerTool(
		"capture_render_debug_view",
		{
			title: "Capture render debug view",
			description:
				"Render and read the currently active transient overdraw/light-complexity target under an exact revision lease. Returns frame/resource evidence, pixel coverage, RGBA min/max/average, raw-pixel SHA-256, and a bounded PNG preview descriptor. The aspect-preserving source target is capped at 2048 per dimension and 4,194,304 pixels. Set includeImage true only when the PNG base64 is needed; the target remains active and no authored scene data changes.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().positive().describe("Exact active revision returned by get_render_debug_view."),
					width: z.number().int().min(16).max(512).optional().describe("Maximum preview PNG width; defaults to 256."),
					height: z.number().int().min(16).max(512).optional().describe("Maximum preview PNG height; defaults to 256."),
					includeImage: z.boolean().optional().describe("Include preview.pngBase64 when true; defaults to false for compact agent context."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_render_debug_view", args)
	);
	server.registerTool(
		"get_device_simulation",
		{
			title: "Get device simulation",
			description:
				"Get the exact persisted Device Simulator revision, selected profile, natural and resolved orientation dimensions/safe area, normalized Application/Screen/SystemInfo values, and explicit non-simulated limitations.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_device_simulation")
	);
	server.registerTool(
		"set_device_simulation",
		{
			title: "Set device simulation",
			description:
				"Exactly configure the actual preview engine view and simulated Application/Screen/SystemInfo environment, optionally applying a built-in/custom profile. Hardware performance remains explicitly unsimulated; set enabled=false to return to panel-fit rendering.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(0).optional(),
					enabled: z.boolean().optional(),
					profileId: z
						.string()
						.regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
						.nullable()
						.optional(),
					width: z.number().int().min(160).max(16384).optional(),
					height: z.number().int().min(160).max(16384).optional(),
					dpi: z.number().positive().max(2000).optional(),
					devicePixelRatio: z.number().positive().max(16).optional(),
					orientation: z.enum(["portrait", "landscape"]).optional(),
					safeArea: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]).optional(),
					platform: z.enum(["android", "ios", "tablet", "desktop-browser"]).optional(),
					operatingSystem: z.string().min(1).max(120).optional(),
					deviceModel: z.string().min(1).max(120).optional(),
					cpuCores: z.number().int().min(1).max(256).optional(),
					memoryMB: z.number().int().min(128).max(1048576).optional(),
					graphicsApi: z.string().min(1).max(120).optional(),
					touchPoints: z.number().int().min(0).max(32).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_device_simulation", args)
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

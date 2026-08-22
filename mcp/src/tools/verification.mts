import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callImageTool, callTextTool } from "./helpers.mjs";

export function registerVerificationTools(server: McpServer): void {
	server.registerTool(
		"get_screenshot",
		{
			title: "Get screenshot",
			description:
				"Capture a screenshot of the editor preview as an image, for VISUAL VERIFICATION. After composing or modifying a scene, call this and compare it to the user's description; iterate until the result matches. " +
				"Tip: use `focus_node` or `set_active_camera` first to frame the relevant content.",
			inputSchema: z.object({
				width: z.number().optional().describe("Screenshot width in pixels."),
				height: z.number().optional().describe("Screenshot height in pixels."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callImageTool("get_screenshot", args)
	);

	server.registerTool(
		"capture_visual_regression_baseline",
		{
			title: "Capture visual regression baseline",
			description: "Capture the live editor viewport and save it as a project PNG baseline for compare_visual_regression_images.",
			inputSchema: z.object({ path: z.string().describe("Project-relative output .png path."), width: z.number().optional(), height: z.number().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_visual_regression_baseline", args)
	);

	server.registerTool(
		"focus_node",
		{
			title: "Focus node",
			description: "Frame the editor camera on a node so it fills the view. Useful right before `get_screenshot` to verify a specific object.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the node to frame (preferred)."),
				nodeName: z.string().optional().describe("Name of the node to frame."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("focus_node", args)
	);

	server.registerTool(
		"run_project",
		{
			title: "Run project",
			description: "Start the project's dev/run process to play-test the game. Inspect it with get_project_run_status and release it with stop_project.",
			inputSchema: z.object({}),
			annotations: { openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("run_project", args)
	);

	server.registerTool(
		"get_project_run_status",
		{
			title: "Get project run status",
			description: "Read whether the external project development process is starting or running and its discovered loopback address, without launching or stopping it.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_run_status", {})
	);

	server.registerTool(
		"stop_project",
		{
			title: "Stop project",
			description: "Stop the external project development process started by run_project and release its terminal process. Repeated calls are safe.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("stop_project", {})
	);
}

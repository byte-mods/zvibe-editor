import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerCameraTools(server: McpServer): void {
	server.registerTool(
		"create_camera",
		{
			title: "Create camera",
			description:
				"Create a camera (free, arcrotate or universal). Positions/targets are in centimeters. " +
				"Use `set_active_camera` afterwards to make it the scene's active camera. A well-placed camera also improves `get_screenshot` framing.",
			inputSchema: z.object({
				type: z.enum(["free", "arcrotate", "universal"]).describe("The camera type."),
				name: z.string().optional().describe("Name for the new camera."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters."),
				target: z.array(z.number()).length(3).optional().describe("Target point `[x,y,z]` the camera looks at, in centimeters."),
				options: z.record(z.string(), z.any()).optional().describe("Extra camera options (e.g. `{ fov, minZ, maxZ, radius, alpha, beta }`)."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_camera", args)
	);

	server.registerTool(
		"get_camera",
		{
			title: "Get camera",
			description: "Get a camera's inspector state: perspective/orthographic projection, clipping planes, transform/target, ArcRotate parameters, and active status.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_camera", args)
	);

	server.registerTool(
		"set_camera_properties",
		{
			title: "Set camera properties",
			description:
				"Update a camera's transform/target and inspector properties. Supports `fov`, `minZ`, `maxZ`, `mode`, `orthoLeft/Right/Top/Bottom`, and ArcRotate `alpha`, `beta`, `radius`, limits, and `panningSensibility`.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				position: z.array(z.number()).length(3).optional(),
				target: z.array(z.number()).length(3).optional(),
				properties: z.record(z.string(), z.any()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_properties", args)
	);

	server.registerTool(
		"set_active_camera",
		{
			title: "Set active camera",
			description: "Set the scene's active camera. Use this to control the viewpoint used by the preview and by `get_screenshot`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the camera (preferred)."),
				nodeName: z.string().optional().describe("Name of the camera."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_active_camera", args)
	);
}

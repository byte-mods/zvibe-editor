import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

const identity = { virtualCameraId: z.string().optional(), virtualCameraName: z.string().optional() };
export function registerVirtualCameraTools(server: McpServer): void {
	server.registerTool(
		"list_virtual_cameras",
		{ title: "List virtual cameras", description: "List persisted virtual camera definitions.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_virtual_cameras")
	);
	server.registerTool(
		"create_virtual_camera",
		{
			title: "Create virtual camera",
			description: "Create a Cinemachine-style virtual camera over an existing editor camera.",
			inputSchema: z.object({
				name: z.string(),
				cameraId: z.string(),
				followNodeId: z.string().optional(),
				lookAtNodeId: z.string().optional(),
				offset: z.array(z.number()).length(3).optional(),
				priority: z.number().optional(),
				activate: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_virtual_camera", args)
	);
	server.registerTool(
		"list_camera_impulse_sources",
		{
			title: "List camera impulse sources",
			description: "List persisted decaying camera-shake source definitions.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_camera_impulse_sources")
	);
	server.registerTool(
		"set_camera_impulse_source",
		{
			title: "Set camera impulse source",
			description: "Create or update a persisted decaying camera-shake source. Distances are centimeters and duration is seconds.",
			inputSchema: z.object({
				impulseId: z.string().optional(),
				impulseName: z.string().optional(),
				name: z.string().optional(),
				amplitude: z.number().nonnegative(),
				duration: z.number().positive(),
				frequency: z.number().positive(),
				direction: z.array(z.number()).length(3),
				cameraId: z.string().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_impulse_source", args)
	);
	server.registerTool(
		"fire_camera_impulse",
		{
			title: "Fire camera impulse",
			description: "Fire a persisted camera-shake source in the editor preview.",
			inputSchema: z.object({ impulseId: z.string().optional(), impulseName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("fire_camera_impulse", args)
	);
	server.registerTool(
		"delete_camera_impulse_source",
		{
			title: "Delete camera impulse source",
			description: "Delete a persisted camera-shake source.",
			inputSchema: z.object({ impulseId: z.string().optional(), impulseName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_camera_impulse_source", args)
	);
	server.registerTool(
		"list_camera_target_groups",
		{ title: "List camera target groups", description: "List persisted weighted camera target groups.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_camera_target_groups")
	);
	server.registerTool(
		"set_camera_target_group",
		{
			title: "Set camera target group",
			description: "Create or update a weighted group of scene nodes for virtual-camera follow or look-at behavior.",
			inputSchema: z.object({
				targetGroupId: z.string().optional(),
				targetGroupName: z.string().optional(),
				name: z.string().optional(),
				members: z.array(z.object({ nodeId: z.string(), weight: z.number().positive() })).min(1),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_target_group", args)
	);
	server.registerTool(
		"set_virtual_camera_target_groups",
		{
			title: "Set virtual-camera target groups",
			description: "Assign or clear weighted follow/look-at target groups on a virtual camera.",
			inputSchema: z.object({ ...identity, followTargetGroupId: z.string().nullable().optional(), lookAtTargetGroupId: z.string().nullable().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_target_groups", args)
	);
	server.registerTool(
		"delete_camera_target_group",
		{
			title: "Delete camera target group",
			description: "Delete a target group and clear virtual-camera references.",
			inputSchema: z.object({ targetGroupId: z.string().optional(), targetGroupName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_camera_target_group", args)
	);
	server.registerTool(
		"set_virtual_camera_dolly",
		{
			title: "Set virtual-camera dolly",
			description: "Attach a virtual camera to an editor spline, or clear its dolly with splineId null. Speed is centimeters per second.",
			inputSchema: z.object({
				...identity,
				splineId: z.string().nullable(),
				t: z.number().min(0).max(1).optional(),
				speed: z.number().nonnegative().optional(),
				loop: z.boolean().optional(),
				orientToPath: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_dolly", args)
	);
	server.registerTool(
		"blend_virtual_camera",
		{
			title: "Blend virtual camera",
			description: "Interpolate active camera pose into a destination virtual camera, then activate it.",
			inputSchema: z.object({ ...identity, duration: z.number().nonnegative().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("blend_virtual_camera", args)
	);
	server.registerTool(
		"activate_virtual_camera",
		{ title: "Activate virtual camera", description: "Apply follow/look-at pose and activate a virtual camera.", inputSchema: z.object(identity) },
		async (args): Promise<CallToolResult> => callTextTool("activate_virtual_camera", args)
	);
	server.registerTool(
		"activate_highest_priority_virtual_camera",
		{ title: "Activate highest priority camera", description: "Activate the highest-priority virtual camera.", inputSchema: z.object({}) },
		async (): Promise<CallToolResult> => callTextTool("activate_highest_priority_virtual_camera")
	);
	server.registerTool(
		"delete_virtual_camera",
		{ title: "Delete virtual camera", description: "Delete a virtual camera definition without deleting its real camera.", inputSchema: z.object(identity) },
		async (args): Promise<CallToolResult> => callTextTool("delete_virtual_camera", args)
	);
}

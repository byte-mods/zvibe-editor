import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const pointSchema = z.array(z.number()).length(3);
const knotSchema = z.object({ position: pointSchema, inTangent: pointSchema.optional(), outTangent: pointSchema.optional() });

export function registerSplineTools(server: McpServer): void {
	server.registerTool(
		"list_splines",
		{ title: "List splines", description: "List persisted editable spline meshes in the active scene.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_splines")
	);
	server.registerTool(
		"create_spline",
		{
			title: "Create spline",
			description: "Create a persisted editable spline tube. Points are local centimeters.",
			inputSchema: z.object({
				name: z.string().optional(),
				parentId: z.string().optional(),
				parentName: z.string().optional(),
				points: z.array(pointSchema).min(2).optional(),
				knots: z.array(knotSchema).min(2).optional().describe("Optional cubic Bezier knots. position and tangents are local centimeters; tangents default to [0,0,0]."),
				radius: z.number().positive().optional(),
				tessellation: z.number().int().min(3).optional(),
				closed: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_spline", args)
	);
	server.registerTool(
		"get_spline",
		{
			title: "Get spline",
			description: "Get editable linear control points or optional cubic Bezier knots and tube settings.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_spline", args)
	);
	server.registerTool(
		"set_spline",
		{
			title: "Set spline",
			description: "Replace or update spline points, optional cubic Bezier knots, and tube settings. Existing point-only splines remain linear.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				points: z.array(pointSchema).min(2).optional(),
				knots: z.array(knotSchema).min(2).nullable().optional().describe("Set cubic Bezier knots, or null to clear knots and return to legacy linear points."),
				radius: z.number().positive().optional(),
				tessellation: z.number().int().min(3).optional(),
				closed: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_spline", args)
	);
	server.registerTool(
		"save_spline_asset",
		{
			title: "Save spline asset",
			description: "Save an editable spline as a reusable project-local .spline.json asset. Existing files require overwrite: true.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				path: z.string().min(1).describe("Project-relative .spline.json output path, for example assets/paths/road.spline.json."),
				overwrite: z.boolean().optional(),
			}),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_spline_asset", args)
	);
	server.registerTool(
		"list_spline_assets",
		{
			title: "List spline assets",
			description: "List valid reusable .spline.json assets inside the open project. Malformed files are skipped.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_spline_assets", {})
	);
	server.registerTool(
		"instantiate_spline_asset",
		{
			title: "Instantiate spline asset",
			description: "Create an editable scene spline from a reusable project-local .spline.json asset, with optional parent and name overrides.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Project-relative .spline.json asset path."),
				name: z.string().optional(),
				parentId: z.string().optional(),
				parentName: z.string().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_spline_asset", args)
	);
	server.registerTool(
		"project_spline_to_terrain",
		{
			title: "Project spline to terrain",
			description:
				"Snap every spline control point to a Ground terrain surface. Cubic Bezier spline anchors and tangent handles are projected by default, preserving a terrain-conforming curve. `offset` is vertical centimeters above the hit surface.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Spline node id."),
				nodeName: z.string().optional().describe("Spline node name."),
				terrainId: z.string().optional().describe("Ground terrain node id."),
				terrainName: z.string().optional().describe("Ground terrain node name."),
				offset: z.number().optional().describe("Vertical offset above terrain in centimeters."),
				projectTangents: z.boolean().optional().describe("For cubic Bezier splines, project tangent handles as well as anchors. Defaults to true."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("project_spline_to_terrain", args)
	);
	server.registerTool(
		"evaluate_spline",
		{
			title: "Evaluate spline",
			description: "Evaluate a spline at normalized path distance t and return local position/tangent.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), t: z.number().min(0).max(1) }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("evaluate_spline", args)
	);
	server.registerTool(
		"list_spline_followers",
		{
			title: "List spline followers",
			description: "List every persisted spline-follower component and its node.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_spline_followers", {})
	);
	server.registerTool(
		"set_spline_follower",
		{
			title: "Set spline follower",
			description:
				"Attach or update a persisted transform/mesh follower. It travels at centimeters per second in exported games, and can loop and orient to the spline tangent.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				splineId: z.string().optional(),
				splineName: z.string().optional(),
				speed: z.number().nonnegative().optional().describe("Travel speed in centimeters per second."),
				t: z.number().min(0).max(1).optional().describe("Normalized initial path distance."),
				loop: z.boolean().optional(),
				orientToPath: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_spline_follower", args)
	);
	server.registerTool(
		"delete_spline_follower",
		{
			title: "Delete spline follower",
			description: "Remove a persisted spline-follower component from a node.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_spline_follower", args)
	);
}

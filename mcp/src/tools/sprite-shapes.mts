import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identifier = z.string().min(1).max(256);
const projectPath = z.string().min(1).max(1024);
const coordinate = z.number().finite().min(-100_000_000).max(100_000_000);
const point2 = z.tuple([coordinate, coordinate]);
const color = z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)]);

const controlPoint = z
	.object({
		id: identifier.describe("Stable control-point id."),
		position: point2.describe("Local spline position [x, y] in centimeters."),
		leftTangent: point2.describe("Incoming Bezier tangent offset from position."),
		rightTangent: point2.describe("Outgoing Bezier tangent offset from position."),
		tangentMode: z.enum(["linear", "continuous", "broken"]),
		height: z.number().finite().min(0.001).max(1_000_000).describe("Rendered edge width in centimeters."),
		corner: z.boolean().describe("Force a hard linear corner at this point."),
	})
	.strict();

const angleRange = z
	.object({
		id: identifier.describe("Stable angle-range id."),
		name: identifier,
		minimumDegrees: z.number().finite().min(-180).max(180),
		maximumDegrees: z.number().finite().min(-180).max(180),
		order: z.number().int().min(-1_000).max(1_000).describe("Higher order wins when ranges overlap."),
		texturePath: projectPath.nullable().describe("Optional project-contained edge texture path."),
		color,
	})
	.strict()
	.refine((value) => value.minimumDegrees < value.maximumDegrees, "minimumDegrees must be below maximumDegrees.");

const colliderUpdate = z
	.object({
		enabled: z.boolean().optional(),
		type: z.enum(["edge", "polygon"]).optional().describe("Open shapes only support edge; closed shapes support edge or polygon."),
		detail: z.number().int().min(1).max(8).optional(),
		offset: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		edgeRadius: z.number().finite().min(0.001).max(1_000_000).optional(),
		optimize: z.boolean().optional(),
		isTrigger: z.boolean().optional(),
		friction: z.number().finite().min(0).max(1).optional(),
		restitution: z.number().finite().min(0).max(1).optional(),
	})
	.strict();

const definitionUpdate = z
	.object({
		profileId: identifier.optional().describe("Retarget to an existing Sprite Shape profile id."),
		closed: z.boolean().optional(),
		detail: z.number().int().min(1).max(32).optional(),
		adaptiveUV: z.boolean().optional(),
		stretchUV: z.boolean().optional(),
		worldSpaceUV: z.boolean().optional(),
		fillOffset: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		geometryOptimization: z.boolean().optional(),
		enableTangents: z.boolean().optional(),
		points: z.array(controlPoint).min(2).max(64).optional(),
		collider: colliderUpdate.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Sprite Shape update must contain at least one field.");

const createDefinition = z
	.object({
		closed: z.boolean().optional(),
		detail: z.number().int().min(1).max(32).optional(),
		adaptiveUV: z.boolean().optional(),
		stretchUV: z.boolean().optional(),
		worldSpaceUV: z.boolean().optional(),
		fillOffset: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		geometryOptimization: z.boolean().optional(),
		enableTangents: z.boolean().optional(),
		points: z.array(controlPoint).min(2).max(64).optional(),
		collider: colliderUpdate.optional(),
	})
	.strict();

const profileUpdate = z
	.object({
		name: identifier.optional(),
		edgeTexturePath: projectPath.nullable().optional(),
		fillTexturePath: projectPath.nullable().optional(),
		edgeColor: color.optional(),
		fillColor: color.optional(),
		pixelsPerUnit: z.number().finite().min(0.001).max(1_000_000).optional(),
		useSpriteBorders: z.boolean().optional(),
		angleRanges: z.array(angleRange).max(16).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Sprite Shape profile update must contain at least one field.");

const profileIdentity = {
	profileId: identifier.optional().describe("Profile id (preferred)."),
	profileName: identifier.optional().describe("Exact profile name."),
};
const shapeIdentity = {
	nodeId: identifier.optional().describe("Sprite Shape mesh id (preferred)."),
	nodeName: identifier.optional().describe("Exact Sprite Shape mesh name."),
};
const pagination = {
	offset: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).max(100).default(20),
};
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updateAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const deleteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Registers reusable Sprite Shape profile and generated spline-mesh lifecycle tools. */
export function registerSpriteShapeTools(server: McpServer): void {
	server.registerTool(
		"list_sprite_shape_profiles",
		{
			title: "List Sprite Shape profiles",
			description: "List reusable Unity-style Sprite Shape profiles with exact revisions, texture assignments, angle-range counts, usage counts, and bounded pagination.",
			inputSchema: z.object(pagination).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_sprite_shape_profiles", args)
	);

	server.registerTool(
		"get_sprite_shape_profile",
		{
			title: "Get Sprite Shape profile",
			description:
				"Read one complete reusable Sprite Shape profile, including exact revision, edge/fill textures and colors, border-safe UV settings, and ordered angle ranges.",
			inputSchema: z
				.object(profileIdentity)
				.strict()
				.refine((value) => Boolean(value.profileId || value.profileName), "Provide profileId or profileName."),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_sprite_shape_profile", args)
	);

	server.registerTool(
		"create_sprite_shape_profile",
		{
			title: "Create Sprite Shape profile",
			description:
				"Create a bounded reusable Sprite Shape rendering profile. Texture paths must resolve inside the open project; returns the complete profile and revision 1.",
			inputSchema: z
				.object({
					id: identifier.optional(),
					name: identifier.optional(),
					edgeTexturePath: projectPath.nullable().optional(),
					fillTexturePath: projectPath.nullable().optional(),
					edgeColor: color.optional(),
					fillColor: color.optional(),
					pixelsPerUnit: z.number().finite().min(0.001).max(1_000_000).optional(),
					useSpriteBorders: z.boolean().optional(),
					angleRanges: z.array(angleRange).max(16).optional(),
				})
				.strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_shape_profile", args)
	);

	server.registerTool(
		"set_sprite_shape_profile",
		{
			title: "Set Sprite Shape profile",
			description:
				"Exact-revision update one reusable Sprite Shape profile and atomically rebuild every dependent shape. Reread get_sprite_shape_profile after a stale-revision error.",
			inputSchema: z
				.object({ ...profileIdentity, expectedRevision: z.number().int().min(0), update: profileUpdate })
				.strict()
				.refine((value) => Boolean(value.profileId || value.profileName), "Provide profileId or profileName."),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_shape_profile", args)
	);

	server.registerTool(
		"delete_sprite_shape_profile",
		{
			title: "Delete Sprite Shape profile",
			description: "Delete an exact-revision Sprite Shape profile only when no shape references it. Retarget or delete dependent shapes first.",
			inputSchema: z
				.object({ ...profileIdentity, expectedRevision: z.number().int().min(0) })
				.strict()
				.refine((value) => Boolean(value.profileId || value.profileName), "Provide profileId or profileName."),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_sprite_shape_profile", args)
	);

	server.registerTool(
		"list_sprite_shapes",
		{
			title: "List Sprite Shapes",
			description: "List editable Sprite Shape meshes with controller/profile identity, exact revisions, control-point counts, and generated geometry/collider evidence.",
			inputSchema: z.object(pagination).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_sprite_shapes", args)
	);

	server.registerTool(
		"get_sprite_shape",
		{
			title: "Get Sprite Shape",
			description: "Read one complete Sprite Shape controller, every spline point/tangent, its shared profile, exact revision, and generated mesh/collider evidence.",
			inputSchema: z
				.object(shapeIdentity)
				.strict()
				.refine((value) => Boolean(value.nodeId || value.nodeName), "Provide nodeId or nodeName."),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_sprite_shape", args)
	);

	server.registerTool(
		"create_sprite_shape",
		{
			title: "Create Sprite Shape",
			description:
				"Create a real hand-editable Sprite Shape mesh through the normal editor hierarchy, using an existing profile or an automatic default. Generates fill, angle-routed edge materials, tangents, and optional 2D collision.",
			inputSchema: z
				.object({
					name: identifier.optional(),
					parentId: identifier.optional(),
					parentName: identifier.optional(),
					profileId: identifier.optional(),
					profileName: identifier.optional(),
					definition: createDefinition.optional(),
				})
				.strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_shape", args)
	);

	server.registerTool(
		"set_sprite_shape",
		{
			title: "Set Sprite Shape",
			description:
				"Exact-revision atomically update profile assignment, topology, Bezier points/tangents, UV behavior, fill offset, geometry optimization, tangents, or generated collider settings. Reread get_sprite_shape after a stale-revision error.",
			inputSchema: z
				.object({ ...shapeIdentity, expectedRevision: z.number().int().min(0), update: definitionUpdate })
				.strict()
				.refine((value) => Boolean(value.nodeId || value.nodeName), "Provide nodeId or nodeName."),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_shape", args)
	);

	server.registerTool(
		"delete_sprite_shape",
		{
			title: "Delete Sprite Shape",
			description: "Delete one exact-revision Sprite Shape mesh and only the generated materials and 2D collider it owns; shared profiles remain available.",
			inputSchema: z
				.object({ ...shapeIdentity, expectedRevision: z.number().int().min(0) })
				.strict()
				.refine((value) => Boolean(value.nodeId || value.nodeName), "Provide nodeId or nodeName."),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_sprite_shape", args)
	);
}

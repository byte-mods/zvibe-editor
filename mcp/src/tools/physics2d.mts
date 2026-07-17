import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const collider = z.discriminatedUnion("shape", [
	z.object({ shape: z.literal("box"), size: z.array(z.number().positive()).length(2) }),
	z.object({ shape: z.literal("circle"), radius: z.number().positive() }),
	z.object({
		shape: z.literal("polygon"),
		points: z
			.array(z.array(z.number().finite()).length(2))
			.min(3)
			.max(64)
			.describe(
				"Simple convex or concave, consistently wound local [x, y] vertices in centimeters. Concave outlines are decomposed into persisted convex triangle parts; holes and self-intersections are unsupported."
			),
	}),
]);
const vector2 = z.array(z.number()).length(2);

/** Registers 2D body/collider simulation tools. */
export function registerPhysics2DTools(server: McpServer): void {
	server.registerTool(
		"get_physics2d_settings",
		{ title: "Get 2D physics settings", description: "Get persisted 2D solver iteration settings.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("get_physics2d_settings", {})
	);
	server.registerTool(
		"set_physics2d_settings",
		{
			title: "Set 2D physics settings",
			description: "Set persisted 2D solver iterations used in editor preview and exported runtime.",
			inputSchema: z.object({ solverIterations: z.number().int().min(1).max(16) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_settings", args)
	);
	server.registerTool(
		"list_physics2d_effectors",
		{
			title: "List 2D effectors",
			description: "List node-bound Point, Area, Surface, and one-way Platform effectors.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_effectors", {})
	);
	server.registerTool(
		"create_physics2d_effector",
		{
			title: "Create 2D effector",
			description:
				"Create a node-bound Point, Area, Surface, or Platform effector. Platform requires a static 2D body on the same node and resolves collisions only from platformAngle's outward side.",
			inputSchema: z.object({
				id: z.string().optional(),
				nodeId: z.string(),
				type: z.enum(["point", "area", "surface", "platform"]).optional(),
				radius: z.number().positive().optional(),
				force: z.number().finite().optional(),
				falloff: z.number().nonnegative().optional(),
				forceAngle: z.number().finite().optional().describe("Area force direction in degrees; 0 points along +X."),
				surfaceThickness: z.number().positive().optional().describe("Surface ring thickness in centimeters."),
				platformAngle: z.number().finite().optional().describe("Platform outward collision side in degrees; 90 is upward."),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_effector", args)
	);
	server.registerTool(
		"set_physics2d_effector",
		{
			title: "Set 2D effector",
			description: "Update an effector's Point/Area/Surface/Platform type, node, force settings, Surface thickness, Platform side angle, or enabled state.",
			inputSchema: z.object({
				id: z.string(),
				nodeId: z.string().optional(),
				type: z.enum(["point", "area", "surface", "platform"]).optional(),
				radius: z.number().positive().optional(),
				force: z.number().finite().optional(),
				falloff: z.number().nonnegative().optional(),
				forceAngle: z.number().finite().optional(),
				surfaceThickness: z.number().positive().optional(),
				platformAngle: z.number().finite().optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_effector", args)
	);
	server.registerTool(
		"delete_physics2d_effector",
		{
			title: "Delete 2D effector",
			description: "Delete an authored 2D Point, Area, Surface, or Platform effector without deleting its scene node.",
			inputSchema: z.object({ id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_effector", args)
	);
	server.registerTool(
		"list_physics2d_materials",
		{
			title: "List 2D physics materials",
			description: "List reusable 2D physics materials with friction and restitution.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_materials", {})
	);
	server.registerTool(
		"create_physics2d_material",
		{
			title: "Create 2D physics material",
			description: "Create a reusable 2D material. Friction affects tangential collision response; restitution controls bounce. Both range from 0 to 1.",
			inputSchema: z.object({
				id: z.string().optional(),
				name: z.string().min(1),
				friction: z.number().min(0).max(1).optional(),
				restitution: z.number().min(0).max(1).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_material", args)
	);
	server.registerTool(
		"set_physics2d_material",
		{
			title: "Set 2D physics material",
			description: "Update the name, friction, or restitution of a reusable 2D physics material.",
			inputSchema: z.object({
				id: z.string(),
				name: z.string().min(1).optional(),
				friction: z.number().min(0).max(1).optional(),
				restitution: z.number().min(0).max(1).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_material", args)
	);
	server.registerTool(
		"delete_physics2d_material",
		{ title: "Delete 2D physics material", description: "Delete an unused 2D physics material. Reassign bodies first.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_material", args)
	);
	server.registerTool(
		"list_physics2d_joints",
		{
			title: "List 2D joints",
			description: "List persisted distance, fixed, and pivot-hinge 2D joints, including hinge limits and motor settings.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_joints", {})
	);
	server.registerTool(
		"create_physics2d_joint",
		{
			title: "Create 2D joint",
			description:
				"Create a persisted distance, fixed, or pivot-hinge joint between two nodes that already have 2D physics bodies. A hinge maintains one shared local pivot, optional relative angular limits, and an optional motor speed with a solver authority cap.",
			inputSchema: z.object({
				id: z.string().optional(),
				type: z.enum(["distance", "fixed", "hinge"]).optional(),
				firstNodeId: z.string(),
				secondNodeId: z.string(),
				distance: z.number().nonnegative().optional(),
				anchor: vector2.optional().describe("World-space pivot [x, y] for a hinge; defaults to the midpoint between bodies."),
				minAngle: z.number().optional().describe("Minimum relative hinge angle in radians, measured from the creation pose."),
				maxAngle: z.number().optional().describe("Maximum relative hinge angle in radians, measured from the creation pose."),
				motorSpeed: z.number().finite().optional().describe("Target hinge relative rotation speed in radians per second. Omit to disable the motor."),
				maxMotorTorque: z.number().finite().nonnegative().optional().describe("Non-negative motor authority cap used by the lightweight solver; defaults to 10000."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_joint", args)
	);
	server.registerTool(
		"set_physics2d_joint",
		{
			title: "Set 2D joint",
			description: "Update a distance joint's distance or a hinge's angular limits and optional motor speed/authority without recreating the joint.",
			inputSchema: z.object({
				id: z.string(),
				distance: z.number().nonnegative().optional(),
				minAngle: z.number().finite().optional(),
				maxAngle: z.number().finite().optional(),
				motorSpeed: z.number().finite().optional(),
				maxMotorTorque: z.number().finite().nonnegative().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_joint", args)
	);
	server.registerTool(
		"delete_physics2d_joint",
		{ title: "Delete 2D joint", description: "Delete a 2D joint without deleting its bodies.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_joint", args)
	);
	server.registerTool(
		"list_physics2d_bodies",
		{
			title: "List 2D physics bodies",
			description: "List persisted 2D bodies/colliders, live velocities, and the previous-frame collision count.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_bodies", {})
	);
	server.registerTool(
		"set_physics2d_body",
		{
			title: "Set 2D physics body",
			description:
				"Attach or update a lightweight 2D body and box/circle/simple-polygon collider on a mesh or transform node. Concave polygon outlines are decomposed into collision-safe convex parts; holes and self-intersections are unsupported. It simulates in the node's local X/Y plane; values use centimeters and seconds.",
			inputSchema: z.object({
				nodeId: z.string(),
				bodyType: z.enum(["dynamic", "static"]).optional(),
				collider: collider.optional(),
				gravity: vector2.optional(),
				gravityScale: z.number().nonnegative().optional(),
				linearDamping: z.number().min(0).max(0.999).optional(),
				materialId: z.string().nullable().optional().describe("Optional reusable 2D physics material id. Pass null to clear the material assignment."),
				friction: z.number().min(0).max(1).optional().describe("Per-body friction override; omit to use the assigned material."),
				restitution: z.number().min(0).max(1).optional(),
				velocity: vector2.optional(),
				isTrigger: z.boolean().optional().describe("Report overlaps without applying physical separation or impulse."),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_body", args)
	);
	server.registerTool(
		"generate_physics2d_polygon_collider",
		{
			title: "Generate 2D polygon collider from image alpha",
			description:
				"Sample a project raster image's opaque pixels into a deterministic convex hull or largest traced concave outline for a scene node. Concave output is decomposed into collision-safe parts; holes and disconnected islands are not preserved.",
			inputSchema: z.object({
				nodeId: z.string(),
				imagePath: z.string().describe("Project-relative PNG/JPG/WebP/BMP/SVG raster asset path."),
				size: vector2.optional().describe("Collider width and height in centimeters. Defaults to [100, 100]."),
				alphaThreshold: z.number().int().min(1).max(255).optional().describe("Opaque alpha threshold from 1 to 255. Defaults to 1."),
				outline: z.enum(["convex", "concave"]).optional().describe("Use convex (default) for a hull, or concave to trace the largest simple opaque silhouette boundary."),
				maxVertices: z
					.number()
					.int()
					.min(3)
					.max(64)
					.optional()
					.describe("Maximum persisted collider vertices. Defaults to 32; concave tracing increases its sampling stride to stay within the limit."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_physics2d_polygon_collider", args)
	);
	server.registerTool(
		"remove_physics2d_body",
		{ title: "Remove 2D physics body", description: "Remove a 2D body/collider while keeping its scene node.", inputSchema: z.object({ nodeId: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("remove_physics2d_body", args)
	);
}

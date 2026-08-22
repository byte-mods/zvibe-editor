import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";
import {
	applyPhysics2DForceSchema,
	applyPhysics2DTorqueSchema,
	createPhysics2DEffectorSchema,
	createPhysics2DJointSchema,
	createPhysics2DMaterialSchema,
	createPhysics2DWorldSchema,
	deletePhysics2DWorldSchema,
	deletePhysics2DResourceSchema,
	physics2DCreateOrUpdateRevision,
	physics2DPolygonContour,
	physics2DRevision,
	getPhysics2DDebugRenderingSchema,
	setPhysics2DBodySchema,
	setPhysics2DEffectorSchema,
	setPhysics2DJointSchema,
	setPhysics2DMaterialSchema,
	setPhysics2DRuntimeVelocitySchema,
	setPhysics2DSettingsSchema,
	setPhysics2DWorldSchema,
} from "./physics2d-schemas.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const create = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const update = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const runtime = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const empty = z.object({}).strict();

/** Registers complete Unity-style 2D authoring and live simulation tools. */
export function registerPhysics2DTools(server: McpServer): void {
	server.registerTool(
		"get_physics2d_settings",
		{
			title: "Get Physics 2D settings",
			description: "Read the versioned exact revision and independent velocity/position solver iteration counts shared by editor preview and exported games.",
			inputSchema: empty,
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics2d_settings", {})
	);
	server.registerTool(
		"set_physics2d_settings",
		{
			title: "Set Physics 2D settings",
			description: "Atomically update split Physics 2D solver iterations under the exact revision returned by get_physics2d_settings.",
			inputSchema: setPhysics2DSettingsSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_settings", args)
	);
	server.registerTool(
		"create_physics2d_world",
		{
			title: "Create Physics 2D world",
			description:
				"Create one of at most eight scene-owned worlds with per-world solver, plane, transform-write/tween, contact-filter, drawing, and camera policies under the exact settings revision.",
			inputSchema: createPhysics2DWorldSchema,
			annotations: create,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_world", args)
	);
	server.registerTool(
		"set_physics2d_world",
		{
			title: "Set Physics 2D world",
			description:
				"Atomically update one existing Physics 2D world's bounded solver, custom plane, transform, filtering, drawing, or multi-camera policy under the exact scene-settings revision.",
			inputSchema: setPhysics2DWorldSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_world", args)
	);
	server.registerTool(
		"delete_physics2d_world",
		{
			title: "Delete Physics 2D world",
			description: "Delete one exact-settings-revision unused non-default Physics 2D world. Reassign every owned body first.",
			inputSchema: deletePhysics2DWorldSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_world", args)
	);
	server.registerTool(
		"get_physics2d_debug_rendering",
		{
			title: "Get Physics 2D debug rendering",
			description:
				"Read a bounded paginated per-camera body/joint draw snapshot, release-build availability, and caller-supplied custom elements ordered after automatic scene drawing.",
			inputSchema: getPhysics2DDebugRenderingSchema,
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_physics2d_debug_rendering", args)
	);

	server.registerTool(
		"list_physics2d_materials",
		{
			title: "List Physics Material 2D resources",
			description: "List reusable versioned Physics Material 2D resources with exact revisions, friction, restitution, ids, and names.",
			inputSchema: empty,
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_materials", {})
	);
	server.registerTool(
		"create_physics2d_material",
		{
			title: "Create Physics Material 2D",
			description: "Create a reusable versioned Physics Material 2D resource. Friction and restitution are each bounded from 0 through 1.",
			inputSchema: createPhysics2DMaterialSchema,
			annotations: create,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_material", args)
	);
	server.registerTool(
		"set_physics2d_material",
		{
			title: "Set Physics Material 2D",
			description: "Atomically rename or update friction/restitution under the exact material revision returned by list_physics2d_materials.",
			inputSchema: setPhysics2DMaterialSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_material", args)
	);
	server.registerTool(
		"delete_physics2d_material",
		{
			title: "Delete Physics Material 2D",
			description: "Delete one exact-revision unassigned Physics Material 2D resource. Bodies must be reassigned first.",
			inputSchema: deletePhysics2DResourceSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_material", args)
	);

	server.registerTool(
		"list_physics2d_bodies",
		{
			title: "List Rigidbody 2D and Collider 2D state",
			description:
				"List complete versioned bodies and all five collider families, live velocities, mass/inertia/center state, constraints, materials, contacts/triggers, layer overrides, and shared simulation evidence.",
			inputSchema: empty,
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_bodies", {})
	);
	server.registerTool(
		"set_physics2d_body",
		{
			title: "Set Rigidbody 2D and Collider 2D",
			description:
				"Create with expectedRevision:0 or exact-revision update a complete dynamic, kinematic, or static X/Y-plane body with Box, Circle, Capsule, Polygon, or Edge collider. Units are centimeters, seconds, kilograms, and radians.",
			inputSchema: setPhysics2DBodySchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_body", args)
	);
	server.registerTool(
		"remove_physics2d_body",
		{
			title: "Remove Rigidbody 2D",
			description: "Remove one exact-revision Rigidbody 2D and its collider while preserving the scene node.",
			inputSchema: z.object({ nodeId: z.string().trim().min(1).max(256), expectedRevision: physics2DRevision }).strict(),
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_physics2d_body", args)
	);

	server.registerTool(
		"get_physics2d_polygon_collider",
		{
			title: "Get compound Polygon Collider 2D",
			description: "Read one polygon collider's exact revision, stable disconnected contours, holes, canonical winding, area evidence, and derived convex collision parts.",
			inputSchema: z.object({ nodeId: z.string().trim().min(1).max(256) }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_physics2d_polygon_collider", args)
	);
	server.registerTool(
		"set_physics2d_polygon_collider",
		{
			title: "Set compound Polygon Collider 2D",
			description:
				"Create with expectedRevision:0 or atomically replace an exact-revision compound Polygon Collider 2D with disconnected islands and holes. The editor validates rings and derives bounded convex parts.",
			inputSchema: z
				.object({
					nodeId: z.string().trim().min(1).max(256),
					expectedRevision: physics2DCreateOrUpdateRevision,
					contours: z.array(physics2DPolygonContour).min(1).max(16).describe("At most 512 vertices total across outer rings and holes."),
				})
				.strict(),
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_polygon_collider", args)
	);
	server.registerTool(
		"generate_physics2d_polygon_collider",
		{
			title: "Generate Polygon Collider 2D from image alpha",
			description:
				"Create with expectedRevision:0 or exact-revision replace a convex, concave, or compound alpha silhouette from a project raster image, preserving holes and disconnected islands when requested.",
			inputSchema: z
				.object({
					nodeId: z.string().trim().min(1).max(256),
					expectedRevision: physics2DCreateOrUpdateRevision,
					imagePath: z.string().trim().min(1).max(2048),
					size: z.array(z.number().positive().max(1_000_000)).length(2).optional(),
					alphaThreshold: z.number().int().min(0).max(255).optional(),
					outline: z.enum(["convex", "concave", "compound"]).optional(),
					maxVertices: z.number().int().min(3).max(512).optional(),
				})
				.strict(),
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_physics2d_polygon_collider", args)
	);

	server.registerTool(
		"list_physics2d_joints",
		{
			title: "List Joint 2D resources",
			description:
				"List all nine versioned Joint 2D families with exact revisions, body/world connections, anchors, break behavior, limits, motors, targets, offsets, and suspension.",
			inputSchema: empty,
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_joints", {})
	);
	server.registerTool(
		"create_physics2d_joint",
		{
			title: "Create Joint 2D",
			description: "Create a Distance, Fixed, Friction, Hinge, Relative, Slider, Spring, Target, or Wheel Joint 2D between authored bodies or the fixed world.",
			inputSchema: createPhysics2DJointSchema,
			annotations: create,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_joint", args)
	);
	server.registerTool(
		"set_physics2d_joint",
		{
			title: "Set Joint 2D",
			description: "Atomically update one named Joint 2D family under its exact revision; the family is immutable and cross-family fields reject.",
			inputSchema: setPhysics2DJointSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_joint", args)
	);
	server.registerTool(
		"delete_physics2d_joint",
		{
			title: "Delete Joint 2D",
			description: "Delete one exact-revision Joint 2D while preserving both bodies and scene nodes.",
			inputSchema: deletePhysics2DResourceSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_joint", args)
	);

	server.registerTool(
		"list_physics2d_effectors",
		{
			title: "List Effector 2D resources",
			description: "List all versioned Point, Area, Surface, Platform, and Buoyancy Effector 2D resources with exact revisions and complete family-specific controls.",
			inputSchema: empty,
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics2d_effectors", {})
	);
	server.registerTool(
		"create_physics2d_effector",
		{
			title: "Create Effector 2D",
			description: "Create a Point, Area, Surface, Platform, or Buoyancy Effector 2D. Platform and Buoyancy require a static owner body.",
			inputSchema: createPhysics2DEffectorSchema,
			annotations: create,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics2d_effector", args)
	);
	server.registerTool(
		"set_physics2d_effector",
		{
			title: "Set Effector 2D",
			description: "Atomically update or switch an Effector 2D family under its exact revision; unknown and cross-family fields reject.",
			inputSchema: setPhysics2DEffectorSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_effector", args)
	);
	server.registerTool(
		"delete_physics2d_effector",
		{
			title: "Delete Effector 2D",
			description: "Delete one exact-revision Effector 2D while preserving its owner body and scene node.",
			inputSchema: deletePhysics2DResourceSchema,
			annotations: update,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_physics2d_effector", args)
	);

	server.registerTool(
		"apply_physics2d_force",
		{
			title: "Apply Physics 2D force or impulse",
			description: "Apply a bounded force or impulse to an exact-revision live dynamic body, optionally at a world-space point. Persisted authoring data is unchanged.",
			inputSchema: applyPhysics2DForceSchema,
			annotations: runtime,
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_physics2d_force", args)
	);
	server.registerTool(
		"apply_physics2d_torque",
		{
			title: "Apply Physics 2D torque or angular impulse",
			description: "Apply bounded torque or angular impulse to an exact-revision live dynamic body. Persisted authoring data is unchanged.",
			inputSchema: applyPhysics2DTorqueSchema,
			annotations: runtime,
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_physics2d_torque", args)
	);
	server.registerTool(
		"set_physics2d_runtime_velocity",
		{
			title: "Set Physics 2D runtime velocity",
			description: "Replace transient linear and/or angular velocity on an exact-revision live body without changing persisted authoring defaults.",
			inputSchema: setPhysics2DRuntimeVelocitySchema,
			annotations: runtime,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics2d_runtime_velocity", args)
	);
}

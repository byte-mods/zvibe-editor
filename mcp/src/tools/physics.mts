import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const vector = z.array(z.number()).length(3);
const vehicleWheel = z.object({
	id: z.string().min(1).max(128),
	name: z.string().min(1).max(128).optional(),
	connectionPoint: vector.describe("Wheel suspension mount in chassis-local centimeters."),
	radius: z.number().positive().max(1000),
	suspensionRestLength: z.number().positive().max(2000),
	maxTravel: z.number().min(0).max(1000),
	springStrength: z.number().min(0).max(1000000),
	damping: z.number().min(0).max(100000),
	steering: z.boolean().optional(),
	driven: z.boolean().optional(),
	brake: z.boolean().optional(),
});

export function registerPhysicsTools(server: McpServer): void {
	server.registerTool(
		"list_physics_constraints",
		{
			title: "List physics constraints",
			description: "List persisted native Havok constraints and whether each is active in the live scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_physics_constraints", {})
	);
	server.registerTool(
		"validate_physics_scene",
		{
			title: "Validate physics scene",
			description:
				"Validate active physics setup before play/export: physics engine availability, dynamic body mass, expensive dynamic mesh shapes, serialized constraint node/body references, self-constraints, and inactive saved constraints. Does not alter the scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("validate_physics_scene", {})
	);
	server.registerTool(
		"get_physics_simulation_state",
		{
			title: "Get physics simulation state",
			description:
				"Read live 3D physics body motion type, mass, shape, pose, available velocities, serialized constraint activity, and validation diagnostics. Does not advance or alter simulation.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_simulation_state", {})
	);
	server.registerTool(
		"get_physics_simulation_control",
		{
			title: "Get physics simulation control",
			description: "Read whether automatic Havok simulation is paused and the accumulated manual-step statistics.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_simulation_control", {})
	);
	server.registerTool(
		"set_physics_simulation_paused",
		{
			title: "Pause or resume physics simulation",
			description: "Pause automatic Havok updates while the editor keeps rendering, or resume the scene’s prior automatic-physics state.",
			inputSchema: z.object({ paused: z.boolean() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_simulation_paused", args)
	);
	server.registerTool(
		"step_physics_simulation",
		{
			title: "Step paused physics simulation",
			description: "Advance a paused Havok simulation by 1–120 deterministic fixed steps while emitting Babylon before/after physics observables.",
			inputSchema: z.object({ steps: z.number().int().min(1).max(120).optional(), deltaSeconds: z.number().min(0.001).max(0.1).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("step_physics_simulation", args)
	);
	server.registerTool(
		"get_physics_contact_visualization",
		{
			title: "Get physics contact visualization",
			description: "Read transient viewport contact-overlay settings and the current overlay count.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_contact_visualization", {})
	);
	server.registerTool(
		"set_physics_contact_visualization",
		{
			title: "Set physics contact visualization",
			description:
				"Enable/configure transient non-pickable viewport crosses and normal vectors for newly captured Havok contacts. Debug meshes are hidden from the graph and never serialized.",
			inputSchema: z.object({
				enabled: z.boolean().optional(),
				normalScale: z.number().min(1).max(10000).optional(),
				pointSize: z.number().min(1).max(1000).optional(),
				lifetimeMs: z.number().min(50).max(60000).optional(),
				clear: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_contact_visualization", args)
	);
	server.registerTool(
		"start_physics_contact_capture",
		{
			title: "Start physics contact capture",
			description:
				"Start a bounded live Havok contact capture for current physics bodies. Captures contact point, normal, impulse, penetration distance, event type, and node identities.",
			inputSchema: z.object({
				maxEvents: z.number().int().min(1).max(1000).optional(),
				includeContinued: z.boolean().optional().describe("Include per-step COLLISION_CONTINUED events; defaults false to reduce noise."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("start_physics_contact_capture", args)
	);
	server.registerTool(
		"get_physics_contact_capture",
		{
			title: "Get physics contact capture",
			description: "Read the active bounded contact capture, including dropped-event count and serialized collision contacts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_contact_capture", {})
	);
	server.registerTool(
		"clear_physics_contact_capture",
		{
			title: "Clear physics contact capture",
			description: "Clear captured contact events and dropped-event count without stopping the active session.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("clear_physics_contact_capture", {})
	);
	server.registerTool(
		"stop_physics_contact_capture",
		{
			title: "Stop physics contact capture",
			description: "Stop contact capture, restore every body’s previous callback-enabled state, and return the final bounded event snapshot.",
			inputSchema: z.object({}),
		},
		async (): Promise<CallToolResult> => callTextTool("stop_physics_contact_capture", {})
	);
	server.registerTool(
		"list_vehicles",
		{
			title: "List arcade vehicles",
			description: "List persisted arcade-vehicle chassis controllers and their active preview input overrides.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_vehicles", {})
	);
	server.registerTool(
		"create_vehicle",
		{
			title: "Create arcade vehicle",
			description: "Create a persisted force-based arcade vehicle on a dynamic Havok chassis. Optional Input Action names drive it in preview and exported games.",
			inputSchema: z.object({
				id: z.string().optional(),
				name: z.string().min(1).max(128).optional(),
				chassisNodeId: z.string(),
				enabled: z.boolean().optional(),
				maxEngineForce: z.number().min(0).max(1000000).optional(),
				maxBrakeForce: z.number().min(0).max(1000000).optional(),
				maxSpeed: z.number().positive().max(100000).optional(),
				maxSteerAngle: z
					.number()
					.min(0)
					.max(Math.PI / 2)
					.optional(),
				wheelBase: z.number().positive().max(10000).optional(),
				lateralGrip: z.number().min(0).max(1000).optional(),
				actionMapName: z.string().min(1).nullable().optional(),
				accelerateActionName: z.string().min(1).optional(),
				reverseActionName: z.string().min(1).optional(),
				leftActionName: z.string().min(1).optional(),
				rightActionName: z.string().min(1).optional(),
				brakeActionName: z.string().min(1).optional(),
				wheels: z.array(vehicleWheel).min(2).max(16).optional().describe("Optional wheel setup; omitted creates a four-wheel default in editor centimeters."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_vehicle", args)
	);
	server.registerTool(
		"set_vehicle",
		{
			title: "Set arcade vehicle",
			description: "Update persisted arcade-vehicle force, handling, enabled, or input-action configuration.",
			inputSchema: z.object({
				id: z.string(),
				enabled: z.boolean().optional(),
				maxEngineForce: z.number().min(0).max(1000000).optional(),
				maxBrakeForce: z.number().min(0).max(1000000).optional(),
				maxSpeed: z.number().positive().max(100000).optional(),
				maxSteerAngle: z
					.number()
					.min(0)
					.max(Math.PI / 2)
					.optional(),
				wheelBase: z.number().positive().max(10000).optional(),
				lateralGrip: z.number().min(0).max(1000).optional(),
				actionMapName: z.string().min(1).nullable().optional(),
				accelerateActionName: z.string().min(1).optional(),
				reverseActionName: z.string().min(1).optional(),
				leftActionName: z.string().min(1).optional(),
				rightActionName: z.string().min(1).optional(),
				brakeActionName: z.string().min(1).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vehicle", args)
	);
	server.registerTool(
		"delete_vehicle",
		{
			title: "Delete arcade vehicle",
			description: "Delete one persisted arcade-vehicle controller without removing its chassis mesh or physics body.",
			inputSchema: z.object({ id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_vehicle", args)
	);
	server.registerTool(
		"set_vehicle_wheels",
		{
			title: "Set vehicle wheels",
			description:
				"Replace the complete 2–16 wheel raycast-suspension setup for an arcade vehicle. Each wheel authors a local mount, radius, spring/damper travel, and steering/drive/brake roles.",
			inputSchema: z.object({ id: z.string(), wheels: z.array(vehicleWheel).min(2).max(16) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vehicle_wheels", args)
	);
	server.registerTool(
		"set_vehicle_input",
		{
			title: "Set live vehicle input",
			description: "Set transient throttle (-1 to 1), steering (-1 to 1), and brake (0 to 1) for an active editor vehicle preview. This input is not saved.",
			inputSchema: z.object({
				id: z.string(),
				throttle: z.number().min(-1).max(1).optional(),
				steering: z.number().min(-1).max(1).optional(),
				brake: z.number().min(0).max(1).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vehicle_input", args)
	);
	server.registerTool(
		"create_physics_constraint",
		{
			title: "Create physics constraint",
			description: "Create a persisted native Havok joint between two meshes that already have enabled physics bodies. Pivots and axes are in each body’s local space.",
			inputSchema: z.object({
				id: z.string().optional(),
				type: z.enum(["ball", "distance", "hinge", "slider", "lock", "prismatic"]),
				parentNodeId: z.string(),
				childNodeId: z.string(),
				pivotA: vector.optional(),
				pivotB: vector.optional(),
				axisA: vector.optional(),
				axisB: vector.optional(),
				perpAxisA: vector.optional(),
				perpAxisB: vector.optional(),
				maxDistance: z.number().nonnegative().optional(),
				collision: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_physics_constraint", args)
	);
	server.registerTool(
		"delete_physics_constraint",
		{ title: "Delete physics constraint", description: "Dispose and remove a persisted Havok constraint.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_physics_constraint", args)
	);
}

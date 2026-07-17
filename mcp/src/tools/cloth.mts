import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const vector = z.array(z.number()).length(3);
const collisionPlane = z.object({ normal: vector, offset: z.number().optional(), restitution: z.number().min(0).max(1).optional() });
const collisionSpheres = z.array(z.object({ center: vector, radius: z.number().positive(), restitution: z.number().min(0).max(1).optional() })).max(32);
const collisionBoxes = z.array(z.object({ center: vector, size: z.array(z.number().positive()).length(3), restitution: z.number().min(0).max(1).optional() })).max(32);

/** Registers persistent cloth authoring and simulation controls. */
export function registerClothTools(server: McpServer): void {
	server.registerTool(
		"list_cloths",
		{
			title: "List cloth components",
			description: "List persisted cloth meshes and whether each simulation is active in the current scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_cloths", {})
	);
	server.registerTool(
		"create_cloth",
		{
			title: "Create cloth",
			description:
				"Create a vertical gridded cloth mesh and a persistent, pinned Verlet-style cloth simulation. Dimensions and position are in centimeters; the top row is pinned by default.",
			inputSchema: z.object({
				id: z.string().optional(),
				name: z.string().optional(),
				width: z.number().positive().optional(),
				height: z.number().positive().optional(),
				subdivisions: z.number().int().min(2).max(64).optional(),
				position: vector.optional(),
				gravity: vector.optional(),
				damping: z.number().min(0).max(0.999).optional(),
				constraintIterations: z.number().int().min(1).max(16).optional(),
				pinnedVertices: z.array(z.number().int().nonnegative()).optional(),
				collisionPlane: collisionPlane.optional().describe("Optional local-space one-sided plane; cloth vertices stay on the normal side."),
				collisionSpheres: collisionSpheres.optional().describe("Optional local-space spherical colliders; cloth vertices are projected outside each sphere."),
				collisionBoxes: collisionBoxes.optional().describe("Optional local-space box colliders; cloth vertices are projected to the nearest exterior face."),
				collisionMeshIds: z.array(z.string()).max(16).optional().describe("Optional scene mesh ids used as dynamic transformed bounding-box colliders."),
				selfCollision: z.boolean().optional().describe("Enable bounded grid-cloth self-collision. Defaults to false."),
				selfCollisionRadius: z.number().positive().optional().describe("Minimum separation between non-neighbouring cloth vertices in centimeters. Defaults to 5."),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cloth", args)
	);
	server.registerTool(
		"set_cloth",
		{
			title: "Set cloth",
			description: "Update simulation gravity, damping, solver iterations, enabled state, or reset the cloth to its authored rest pose.",
			inputSchema: z.object({
				id: z.string(),
				gravity: vector.optional(),
				damping: z.number().min(0).max(0.999).optional(),
				constraintIterations: z.number().int().min(1).max(16).optional(),
				collisionPlane: collisionPlane.nullable().optional().describe("Set a plane or null to clear the cloth collision constraint."),
				collisionSpheres: collisionSpheres.nullable().optional().describe("Set local-space spherical colliders or null to clear them."),
				collisionBoxes: collisionBoxes.nullable().optional().describe("Set local-space box colliders or null to clear them."),
				collisionMeshIds: z.array(z.string()).max(16).nullable().optional().describe("Set dynamic scene mesh bounding-box colliders or null to clear them."),
				selfCollision: z.boolean().optional().describe("Enable or disable bounded grid-cloth self-collision."),
				selfCollisionRadius: z.number().positive().optional().describe("Minimum separation between non-neighbouring cloth vertices in centimeters."),
				pinnedVertices: z
					.array(z.number().int().nonnegative())
					.optional()
					.describe("Replace pinned cloth vertex indices. Indices range from 0 through (subdivisions + 1)^2 - 1."),
				enabled: z.boolean().optional(),
				reset: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cloth", args)
	);
	server.registerTool(
		"delete_cloth",
		{
			title: "Delete cloth component",
			description: "Stop and remove a cloth component while preserving its scene mesh for normal editing.",
			inputSchema: z.object({ id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cloth", args)
	);
}

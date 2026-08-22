import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const vector = z.array(z.number()).length(3);
const collisionPlane = z.object({ normal: vector, offset: z.number().optional(), restitution: z.number().min(0).max(1).optional() }).strict();
const collisionSpheres = z.array(z.object({ center: vector, radius: z.number().positive(), restitution: z.number().min(0).max(1).optional() }).strict()).max(32);
const collisionBoxes = z.array(z.object({ center: vector, size: z.array(z.number().positive()).length(3), restitution: z.number().min(0).max(1).optional() }).strict()).max(32);
const vertexConstraint = z
	.object({ vertexIndex: z.number().int().nonnegative(), maxDistance: z.number().min(0).max(100000).optional(), surfacePenetration: z.number().min(0).max(100000).optional() })
	.strict()
	.refine((value) => value.maxDistance !== undefined || value.surfacePenetration !== undefined, "A vertex constraint must define maxDistance, surfacePenetration, or both.");
const triangleCollider = z
	.object({
		meshId: z.string().min(1),
		thickness: z.number().positive().max(1000).optional(),
		restitution: z.number().min(0).max(1).optional(),
		friction: z.number().min(0).max(1).optional(),
	})
	.strict();

/** Registers persistent cloth authoring and simulation controls. */
export function registerClothTools(server: McpServer): void {
	server.registerTool(
		"list_cloths",
		{
			title: "List cloth components",
			description:
				"List persisted cloth meshes plus shared editor/export runtime activity, pause state, enabled count, automatic/manual fixed-step totals, exact last delta, work count, and last bounded failure.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_cloths", {})
	);
	server.registerTool(
		"get_cloth_constraints",
		{
			title: "Get cloth constraints",
			description:
				"Read one cloth's sparse maximum-distance and surface-penetration vertex constraints, exact mutation revision, stable vertex count, and a deterministic bounded page.",
			inputSchema: z.object({ id: z.string().min(1), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_cloth_constraints", args)
	);
	server.registerTool(
		"get_cloth_collision_diagnostics",
		{
			title: "Get cloth collision diagnostics",
			description:
				"Read bounded runtime evidence for transformed triangle colliders: configured/active/skipped colliders, triangle and candidate counts, contacts, work truncation, and constraint counts. This never advances simulation.",
			inputSchema: z.object({ id: z.string().min(1).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_cloth_collision_diagnostics", args)
	);
	server.registerTool(
		"create_cloth",
		{
			title: "Create cloth",
			description:
				"Create a vertical gridded cloth mesh and a persistent, pinned Verlet-style cloth simulation. Dimensions and position are in centimeters; the top row is pinned by default.",
			inputSchema: z
				.object({
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
					vertexConstraints: z.array(vertexConstraint).max(4225).optional().describe("Sparse local-rest-pose motion and surface penetration limits, in centimeters."),
					collisionPlane: collisionPlane.optional().describe("Optional local-space one-sided plane; cloth vertices stay on the normal side."),
					collisionSpheres: collisionSpheres.optional().describe("Optional local-space spherical colliders; cloth vertices are projected outside each sphere."),
					collisionBoxes: collisionBoxes.optional().describe("Optional local-space box colliders; cloth vertices are projected to the nearest exterior face."),
					collisionMeshIds: z.array(z.string()).max(16).optional().describe("Optional scene mesh ids used as dynamic transformed bounding-box colliders."),
					triangleColliders: z
						.array(triangleCollider)
						.max(8)
						.optional()
						.describe("Optional current-transformed arbitrary mesh or physics-body triangle colliders; each source is limited to 4096 triangles."),
					selfCollision: z.boolean().optional().describe("Enable bounded grid-cloth self-collision. Defaults to false."),
					selfCollisionRadius: z.number().positive().optional().describe("Minimum separation between non-neighbouring cloth vertices in centimeters. Defaults to 5."),
					enabled: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cloth", args)
	);
	server.registerTool(
		"set_cloth",
		{
			title: "Set cloth",
			description: "Update simulation gravity, damping, solver iterations, enabled state, or reset the cloth to its authored rest pose.",
			inputSchema: z
				.object({
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
					expectedConstraintRevision: z.number().int().min(1).optional().describe("Required exact lease when replacing vertexConstraints."),
					vertexConstraints: z.array(vertexConstraint).max(4225).optional().describe("Atomically replace sparse vertex constraints and issue the next revision."),
					triangleColliders: z.array(triangleCollider).max(8).nullable().optional().describe("Set current-transformed triangle colliders or null to clear them."),
					enabled: z.boolean().optional(),
					reset: z.boolean().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.vertexConstraints !== undefined && value.expectedConstraintRevision === undefined) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							path: ["expectedConstraintRevision"],
							message: "expectedConstraintRevision is required with vertexConstraints.",
						});
					}
					if (value.expectedConstraintRevision !== undefined && value.vertexConstraints === undefined) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							path: ["vertexConstraints"],
							message: "vertexConstraints is required with expectedConstraintRevision.",
						});
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cloth", args)
	);
	server.registerTool(
		"paint_cloth_constraints",
		{
			title: "Paint cloth constraints",
			description:
				"Atomically paint or erase one persistent per-vertex cloth constraint channel with an exact revision. The spherical brush is in current cloth-local centimeters, uses bounded deterministic vertex selection, and never advances simulation.",
			inputSchema: z
				.object({
					id: z.string().min(1),
					expectedConstraintRevision: z.number().int().min(1),
					center: vector,
					radius: z.number().positive().max(100000),
					channel: z.enum(["maxDistance", "surfacePenetration"]),
					mode: z.enum(["paint", "erase"]),
					value: z.number().min(0).max(100000).optional(),
					strength: z.number().positive().max(1).default(1),
					falloff: z.enum(["constant", "linear", "smooth"]).default("smooth"),
					maxAffectedVertices: z.number().int().min(1).max(4096).default(1024),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.mode === "paint" && value.value === undefined) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "value is required when mode is paint." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_cloth_constraints", args)
	);
	server.registerTool(
		"delete_cloth",
		{
			title: "Delete cloth component",
			description: "Stop and remove a cloth component while preserving its scene mesh for normal editing.",
			inputSchema: z.object({ id: z.string() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cloth", args)
	);
}

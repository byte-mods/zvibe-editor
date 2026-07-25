import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const fingerprint = z
	.string()
	.length(64)
	.regex(/^[a-f0-9]{64}$/);
const nodeSelectorShape = {
	nodeId: z.string().min(1).max(128).optional(),
	nodeName: z.string().min(1).max(128).optional(),
};
const exactNodeSelector = <T extends z.ZodRawShape>(shape: T) =>
	z
		.object({ ...nodeSelectorShape, ...shape })
		.strict()
		.refine(
			(value) => {
				const selector = value as { nodeId?: string; nodeName?: string };
				return Boolean(selector.nodeId) !== Boolean(selector.nodeName);
			},
			{ message: "Provide exactly one of nodeId or nodeName." }
		);

const jsonObject = z.record(z.string().min(1).max(128), z.unknown());
const vector3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export function registerComponentTools(server: McpServer): void {
	server.registerTool(
		"list_game_object_component_types",
		{
			title: "List GameObject component types",
			description:
				"List the closed first-class component registry, duplicate/dependency rules, and optional node-specific availability. Transform is required; data, behavior script, and real Physics Body 3D adapters are authorable.",
			inputSchema: z
				.object(nodeSelectorShape)
				.strict()
				.refine((value) => !(value.nodeId && value.nodeName), { message: "Provide at most one of nodeId or nodeName." }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_game_object_component_types", args)
	);

	server.registerTool(
		"inspect_game_object_components",
		{
			title: "Inspect GameObject components",
			description:
				"Inspect one node's exact ordered component stack, stable component ids, real adapter values, dependencies, duplicate rules, clipboard state, and SHA-256 mutation fingerprint.",
			inputSchema: exactNodeSelector({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_game_object_components", args)
	);

	server.registerTool(
		"add_game_object_component",
		{
			title: "Add GameObject component",
			description:
				"Add one custom data component, existing src/ behavior script, real Havok Physics Body 3D, Entity (ECS) archetype, or Network Replication contract under the exact inspected stack fingerprint. Duplicate and target-support rules are enforced atomically with editor Undo/Redo.",
			inputSchema: exactNodeSelector({
				expectedFingerprint: fingerprint,
				type: z.enum(["data", "script", "physics3d", "entity", "network"]),
				name: z.string().min(1).max(80).optional(),
				values: jsonObject.optional(),
				path: z.string().min(1).max(512).optional(),
				enabled: z.boolean().optional(),
				/** Seed payload for `entity` (archetype/values) and `network` (replication) components. */
				data: jsonObject.optional(),
				shapeType: z.enum(["box", "sphere", "capsule", "cylinder", "mesh"]).optional(),
				motionType: z.enum(["static", "dynamic", "animated"]).optional(),
				mass: z.number().finite().min(0).max(1_000_000).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_game_object_component", args)
	);

	server.registerTool(
		"set_game_object_component",
		{
			title: "Set GameObject component",
			description:
				"Update one stable component without replacing its identity. Type-specific fields are validated and applied to the actual transform, script attachment, PhysicsAggregate, or runtime data component with Undo/Redo.",
			inputSchema: exactNodeSelector({
				expectedFingerprint: fingerprint,
				componentId: z.string().min(1).max(128),
				enabled: z.boolean().optional(),
				name: z.string().min(1).max(80).optional(),
				values: jsonObject.optional(),
				/** Partial update for `entity` (archetype/values) and `network` (replication) components; merged then re-normalized. */
				data: jsonObject.optional(),
				transform: z.object({ position: vector3.optional(), rotation: vector3.optional(), scaling: vector3.optional() }).strict().optional(),
				script: z
					.object({ executionOrder: z.number().int().min(-32000).max(32000).optional(), values: jsonObject.optional() })
					.strict()
					.optional(),
				physics: z
					.object({
						shapeType: z.enum(["box", "sphere", "capsule", "cylinder", "mesh"]).optional(),
						motionType: z.enum(["static", "dynamic", "animated"]).optional(),
						mass: z.number().finite().min(0).max(1_000_000).optional(),
						friction: z.number().finite().min(0).max(1).optional(),
						restitution: z.number().finite().min(0).max(1).optional(),
					})
					.strict()
					.optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_game_object_component", args)
	);

	server.registerTool(
		"move_game_object_component",
		{
			title: "Reorder GameObject component",
			description: "Move one component to an exact 1-based authored order while preserving required dependency order. Transform remains fixed at order 0.",
			inputSchema: exactNodeSelector({ expectedFingerprint: fingerprint, componentId: z.string().min(1).max(128), targetOrder: z.number().int().min(1).max(128) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("move_game_object_component", args)
	);

	server.registerTool(
		"remove_game_object_component",
		{
			title: "Remove GameObject component",
			description:
				"Remove a stable component and its real adapter state under an exact lease. Required Transform removal is rejected; dependent rows require explicit cascade=true.",
			inputSchema: exactNodeSelector({ expectedFingerprint: fingerprint, componentId: z.string().min(1).max(128), cascade: z.boolean().optional() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_game_object_component", args)
	);

	server.registerTool(
		"reset_game_object_component",
		{
			title: "Reset GameObject component",
			description:
				"Reset the selected transform, data, behavior script, or physics component to deterministic defaults while retaining its stable component identity where applicable.",
			inputSchema: exactNodeSelector({ expectedFingerprint: fingerprint, componentId: z.string().min(1).max(128) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_game_object_component", args)
	);

	server.registerTool(
		"copy_game_object_component",
		{
			title: "Copy GameObject component",
			description: "Copy an exact component snapshot into the shared editor/MCP clipboard and return its SHA-256 clipboard fingerprint for guarded paste.",
			inputSchema: exactNodeSelector({ expectedFingerprint: fingerprint, componentId: z.string().min(1).max(128) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("copy_game_object_component", args)
	);

	server.registerTool(
		"paste_game_object_component",
		{
			title: "Paste GameObject component",
			description:
				"Paste guarded clipboard values onto a same-type target, or create a new duplicate-compatible component. Both target stack and clipboard fingerprints must match; Undo/Redo restores the complete state.",
			inputSchema: exactNodeSelector({
				expectedFingerprint: fingerprint,
				expectedClipboardFingerprint: fingerprint,
				mode: z.enum(["values", "new"]),
				componentId: z.string().min(1).max(128).optional(),
			}).refine((value) => value.mode !== "values" || Boolean(value.componentId), { message: "mode=values requires componentId." }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("paste_game_object_component", args)
	);
}

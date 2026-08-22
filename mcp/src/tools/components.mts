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
const componentIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ecsIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const ecsFieldValue = z.union([
	z.number().finite(),
	z.boolean(),
	z.tuple([z.number().finite(), z.number().finite()]),
	z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
	z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
]);
const entityComponentData = z
	.object({
		version: z.union([z.literal(2), z.literal(3)]).optional(),
		archetype: z.string().min(1).max(120).optional(),
		sectionId: ecsIdentifier.optional(),
		values: z.record(ecsIdentifier, z.number().finite()).optional(),
		components: z.record(ecsIdentifier, z.record(ecsIdentifier, ecsFieldValue)).optional(),
		bakingEnabled: z.boolean().optional(),
		hiddenInHierarchy: z.boolean().optional(),
	})
	.strict();
const networkComponentData = z
	.object({
		networkId: componentIdentifier.optional(),
		authority: z.enum(["server", "owner"]).optional(),
		syncTransform: z.boolean().optional(),
		syncAnimation: z.boolean().optional(),
		sendRateHz: z.number().int().min(1).max(120).optional(),
		interpolate: z.boolean().optional(),
	})
	.strict();
const point2D = z.tuple([z.number().finite().min(-1_000_000).max(1_000_000), z.number().finite().min(-1_000_000).max(1_000_000)]);
const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/);
const sortingLayerIds = z.array(z.string().min(1).max(128)).max(32);
const light2DComponentData = z
	.object({
		model: z.literal("unity-light2d-v1").optional(),
		version: z.literal(1).optional(),
		lightType: z.enum(["global", "point", "freeform", "sprite", "provider"]).optional(),
		providerId: providerId.optional(),
		providerVersion: z.number().int().min(1).max(100_000).optional(),
		providerData: jsonObject.optional(),
		color: z.tuple([z.number().finite().min(0).max(16), z.number().finite().min(0).max(16), z.number().finite().min(0).max(16), z.number().finite().min(0).max(1)]).optional(),
		intensity: z.number().finite().min(0).max(64).optional(),
		falloffIntensity: z.number().finite().min(0).max(1).optional(),
		innerRadius: z.number().finite().min(0).max(1_000_000).optional(),
		outerRadius: z.number().finite().min(0.001).max(1_000_000).optional(),
		innerAngleDegrees: z.number().finite().min(0).max(360).optional(),
		outerAngleDegrees: z.number().finite().min(0.001).max(360).optional(),
		shapePath: z.array(point2D).min(3).max(32).optional(),
		overlapOperation: z.enum(["additive", "alpha-blend"]).optional(),
		lightOrder: z.number().int().min(-32_000).max(32_000).optional(),
		shadowsEnabled: z.boolean().optional(),
		shadowIntensity: z.number().finite().min(0).max(1).optional(),
		targetSortingLayerIds: sortingLayerIds.optional(),
	})
	.strict();
const shadowCaster2DComponentData = z
	.object({
		model: z.literal("unity-shadow-caster2d-v1").optional(),
		version: z.literal(1).optional(),
		sourceType: z.enum(["shape-editor", "node-bounds", "provider"]).optional(),
		providerId: providerId.optional(),
		providerVersion: z.number().int().min(1).max(100_000).optional(),
		providerData: jsonObject.optional(),
		shapePath: z.array(point2D).min(3).max(64).optional(),
		castingOption: z.enum(["cast-shadow", "self-shadow", "cast-and-self-shadow", "no-shadow"]).optional(),
		priority: z.number().int().min(-32_000).max(32_000).optional(),
		targetSortingLayerIds: sortingLayerIds.optional(),
	})
	.strict();
const componentData = z.union([networkComponentData, entityComponentData, light2DComponentData, shadowCaster2DComponentData]);

export function registerComponentTools(server: McpServer): void {
	server.registerTool(
		"list_game_object_component_types",
		{
			title: "List GameObject component types",
			description:
				"List the closed first-class component registry, duplicate/dependency rules, and optional node-specific availability. Includes runtime Light2D and ShadowCaster2D provider components.",
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
				"Add one data, behavior, Physics Body 3D, Entity, Network Replication, Light2D, or ShadowCaster2D component under the exact inspected stack fingerprint. Duplicate and target-support rules are enforced atomically with editor Undo/Redo.",
			inputSchema: exactNodeSelector({
				expectedFingerprint: fingerprint,
				type: z.enum(["data", "script", "physics3d", "entity", "network", "light2d", "shadowcaster2d"]),
				name: z.string().min(1).max(80).optional(),
				values: jsonObject.optional(),
				path: z.string().min(1).max(512).optional(),
				enabled: z.boolean().optional(),
				/** Seed payload for Entity, Network, Light2D, and ShadowCaster2D components. */
				data: componentData.optional(),
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
				/** Partial update for Entity, Network, Light2D, and ShadowCaster2D components; merged then re-normalized. */
				data: componentData.optional(),
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

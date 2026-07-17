import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerPrefabTools(server: McpServer): void {
	const prefabProperties = z.object({
		name: z.string().min(1).max(256).optional(),
		position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
		rotation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
		scaling: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
		visibility: z.number().finite().min(0).max(1).optional(),
		isVisible: z.boolean().optional(),
	});
	const nonEmptyPrefabProperties = prefabProperties.refine((value) => Object.keys(value).length > 0, { message: "At least one prefab property is required." });
	const structuralProperties = prefabProperties.omit({ name: true });
	const serializedMesh = z
		.json()
		.refine((value) => !!value && typeof value === "object" && !Array.isArray(value), { message: "serializedMesh must be a serialized Babylon mesh object." })
		.refine((value) => JSON.stringify(value).length <= 2 * 1024 * 1024, { message: "serializedMesh must not exceed 2 MiB." });
	const propertyPath = z
		.string()
		.min(1)
		.max(512)
		.regex(/^\//, "Use an RFC 6901 JSON Pointer beginning with /.")
		.describe("Existing serialized node property as JSON Pointer, for example /metadata/gameplay/health.");
	const propertyValue = z.json().refine((value) => JSON.stringify(value).length <= 64 * 1024, { message: "Serialized property value must not exceed 64 KiB." });
	const propertyOverrides = z.array(z.object({ nodeName: z.string().min(1).max(256), path: propertyPath, value: propertyValue })).max(512);
	const structuralOverrides = z.object({
		removals: z.array(z.string().min(1).max(256)).max(512).optional(),
		additions: z
			.array(
				z.object({
					nodeName: z.string().min(1).max(256).describe("New stable source identity, unique across the resolved prefab."),
					displayName: z.string().min(1).max(256),
					parentNodeName: z.string().min(1).max(256).nullable().describe("Stable parent identity; null means the prefab root."),
					kind: z.enum(["transform", "cloneMesh", "nestedPrefab", "mesh"]),
					cloneSourceNodeName: z.string().min(1).max(256).optional().describe("Required mesh source identity when kind is cloneMesh."),
					prefabPath: z.string().min(1).max(512).optional().describe("Required contained .prefab asset path when kind is nestedPrefab."),
					serializedMesh: serializedMesh.optional().describe("Required one-mesh bounded Babylon serialization when kind is mesh."),
					properties: structuralProperties.optional(),
				})
			)
			.max(256)
			.optional(),
		reparents: z
			.array(
				z.object({
					nodeName: z.string().min(1).max(256),
					parentNodeName: z.string().min(1).max(256).nullable().describe("Stable parent identity; null means the prefab root."),
				})
			)
			.max(512)
			.optional(),
	});
	const componentKey = z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
		.describe("Serialized node metadata key. Prefab identity/runtime keys are protected.");
	const componentValue = z.json().refine((value) => JSON.stringify(value).length <= 64 * 1024, { message: "Serialized component value must not exceed 64 KiB." });
	const componentOverrides = z.object({
		additions: z
			.array(z.object({ nodeName: z.string().min(1).max(256), componentKey, value: componentValue }))
			.max(512)
			.optional(),
		removals: z
			.array(z.object({ nodeName: z.string().min(1).max(256), componentKey }))
			.max(512)
			.optional(),
	});
	server.registerTool(
		"list_prefabs",
		{ title: "List prefabs", description: "List persisted .prefab mesh-hierarchy assets in the project.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_prefabs", {})
	);
	server.registerTool(
		"get_prefab",
		{
			title: "Get prefab",
			description: "Read a persisted prefab asset's serialized mesh hierarchy.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_prefab", args)
	);
	server.registerTool(
		"create_prefab",
		{
			title: "Create prefab",
			description: "Serialize a mesh root and its hierarchy into a reusable project-relative .prefab asset. Existing assets require explicit overwrite confirmation.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), path: z.string(), overwrite: z.literal(true).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_prefab", args)
	);
	server.registerTool(
		"create_prefab_variant",
		{
			title: "Create prefab variant",
			description:
				"Create a derived prefab asset from a base prefab with root, named-node, arbitrary property, and bounded add/remove/reparent structural overrides. The variant uses recursive live composition and the normal prefab instantiate workflow.",
			inputSchema: z.object({
				basePath: z.string(),
				path: z.string(),
				rootOverrides: z
					.object({
						name: z.string().optional(),
						position: z.array(z.number()).length(3).optional(),
						rotation: z.array(z.number()).length(3).optional(),
						scaling: z.array(z.number()).length(3).optional(),
						visibility: z.number().optional(),
						isVisible: z.boolean().optional(),
					})
					.optional(),
				nodeOverrides: z
					.array(
						z.object({
							nodeName: z.string(),
							properties: z.object({
								name: z.string().optional(),
								position: z.array(z.number()).length(3).optional(),
								rotation: z.array(z.number()).length(3).optional(),
								scaling: z.array(z.number()).length(3).optional(),
								visibility: z.number().optional(),
								isVisible: z.boolean().optional(),
							}),
						})
					)
					.optional(),
				propertyOverrides: propertyOverrides.optional(),
				structuralOverrides: structuralOverrides.optional(),
				componentOverrides: componentOverrides.optional(),
				overwrite: z.literal(true).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_prefab_variant", args)
	);
	server.registerTool(
		"inspect_prefab_variant_rebase",
		{
			title: "Inspect prefab variant rebase",
			description:
				"Resolve a prefab recursively from its current base chain without writing files. Returns exact base/resolved SHA-256 revisions, stale state, inheritance chain, node count, and missing/ambiguous override conflicts. Normal prefabs report variant=false.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_rebase", args)
	);
	server.registerTool(
		"rebase_prefab_variant",
		{
			title: "Rebase prefab variant",
			description:
				"After confirm=true, persist a dynamically resolved prefab variant against its current recursive base only when expectedBaseRevision exactly matches fresh inspection. Missing/ambiguous override targets block the write; source assets are never overwritten indirectly.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedBaseRevision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebase_prefab_variant", args)
	);
	server.registerTool(
		"set_prefab_variant_overrides",
		{
			title: "Set prefab variant overrides",
			description:
				"After confirm=true, replace the complete root, stable-source-node, arbitrary property, and optional structural override set of a prefab variant under an exact resolved-revision lease. Use this to repair conflicts after a base change. Every target must exist uniquely in the current recursively resolved base before the variant is rewritten.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				rootOverrides: prefabProperties.optional(),
				nodeOverrides: z
					.array(z.object({ nodeName: z.string().min(1).max(256), properties: nonEmptyPrefabProperties }))
					.max(512)
					.optional(),
				propertyOverrides: propertyOverrides.optional(),
				structuralOverrides: structuralOverrides.optional(),
				componentOverrides: componentOverrides.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_variant_overrides", args)
	);
	server.registerTool(
		"inspect_prefab_variant_structure",
		{
			title: "Inspect prefab variant structure",
			description:
				"Resolve a prefab's stable-source hierarchy without writing. Returns node/display/parent/kind/origin records, the complete current add/remove/reparent override set, conflicts, inheritance chain, and the exact revision required for structural mutation.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_structure", args)
	);
	server.registerTool(
		"set_prefab_variant_structure",
		{
			title: "Set prefab variant structure",
			description:
				"After confirm=true, replace a variant's complete bounded subtree-removal, empty-transform/mesh-clone addition, and reparent set under an exact resolved-revision lease. Root removal, duplicate identities, missing/ambiguous nodes or parents, invalid clone sources, and cycles are rejected atomically; property overrides are preserved.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), structuralOverrides, confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_variant_structure", args)
	);
	server.registerTool(
		"inspect_prefab_variant_components",
		{
			title: "Inspect prefab variant components",
			description:
				"Resolve a prefab without writing and return bounded per-node serialized metadata-component key/type/size inventories, current add/remove overrides, conflicts, and the exact revision required for mutation. Component values remain available through get_prefab.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_variant_components", args)
	);
	server.registerTool(
		"set_prefab_variant_components",
		{
			title: "Set prefab variant components",
			description:
				"After confirm=true, replace a variant's complete serialized metadata-component add/remove set under an exact resolved-revision lease. Adds require an absent key, removals require an inherited key, identities are protected, JSON is bounded to 64 KiB, and scripts/physicsAggregate values receive stricter runtime-shape validation.",
			inputSchema: z.object({ path: z.string().min(1).max(512), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), componentOverrides, confirm: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_variant_components", args)
	);
	server.registerTool(
		"set_prefab_asset_node_properties",
		{
			title: "Set prefab asset node properties",
			description:
				"After confirm=true, update one stable source node's name/transform/visibility in a prefab asset. An optional exact resolved revision prevents stale Prefab Mode writes. Variant edits are stored as overrides so future base rebases preserve them; unresolved variant conflicts block editing.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				sourceNodeName: z.string().min(1).max(256),
				properties: nonEmptyPrefabProperties,
				expectedRevision: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_asset_node_properties", args)
	);
	server.registerTool(
		"inspect_prefab_asset_node_property",
		{
			title: "Inspect prefab asset node property",
			description:
				"Read one existing arbitrary serialized property on a stable prefab source node. Returns its bounded JSON value, whether the path is a variant override, conflicts, and the exact revision lease required for a write.",
			inputSchema: z.object({ path: z.string().min(1).max(512), sourceNodeName: z.string().min(1).max(256), propertyPath }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_asset_node_property", args)
	);
	server.registerTool(
		"set_prefab_asset_node_property",
		{
			title: "Set prefab asset node property",
			description:
				"After confirm=true, update one existing arbitrary serialized node property under the exact revision returned by inspection. Prototype, identity, hierarchy and standard transform/name paths are blocked. Variant writes persist as path overrides and survive rebases.",
			inputSchema: z.object({
				path: z.string().min(1).max(512),
				sourceNodeName: z.string().min(1).max(256),
				propertyPath,
				value: propertyValue,
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_prefab_asset_node_property", args)
	);
	server.registerTool(
		"inspect_prefab_instance_links",
		{
			title: "Inspect prefab instance source links",
			description:
				"Inspect one live instantiated prefab mesh and return its ordered outer-to-inner source-asset boundary links, stable source-node identity at each boundary, exact resolved SHA-256 revision, variant/stale/conflict state, live transform/visibility, and public serialized component keys. Use a returned targetPath and revision for boundary Apply/Revert or unpack.",
			inputSchema: z.object({ nodeId: z.string().min(1).optional(), nodeName: z.string().min(1).max(256).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_instance_links", args)
	);
	server.registerTool(
		"inspect_prefab_instance_structure",
		{
			title: "Inspect live prefab instance structure",
			description:
				"Automatically compare one live prefab instance hierarchy with an exact outer or nested source boundary without changing either. Returns detected additions, removals, reparents, transform differences, unsupported-change blockers, a deterministic comparison signature, and the complete proposed structural override set for capture.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional().describe("Optional exact boundary path returned by inspect_prefab_instance_links; outermost by default."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_prefab_instance_structure", args)
	);
	server.registerTool(
		"capture_prefab_instance_structure",
		{
			title: "Capture live prefab instance structure",
			description:
				"After confirm=true, capture automatically detected live additions, removals, and reparents into one instantiated prefab variant under the exact revision returned by inspect_prefab_instance_structure. New mesh geometry is serialized with bounded resource limits, and separately instantiated nested prefabs retain ordered outer-to-inner source links. Stale instances, unsafe or oversized payloads, source conflicts, and base-prefab targets block before writing.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_prefab_instance_structure", args)
	);
	server.registerTool(
		"compare_prefab_instances",
		{
			title: "Compare prefab instances",
			description:
				"Search and compare up to 200 live outer instances of one prefab asset. Returns per-instance structural/transform/blocker counts, deterministic signatures, and signature groups so matching and divergent override sets can be found without modifying the scene.",
			inputSchema: z.object({
				path: z.string().min(1).max(512).describe("Project-relative outer prefab asset path."),
				query: z.string().max(256).optional().describe("Optional case-insensitive root name, node id, or instance id filter."),
				limit: z.number().int().min(1).max(200).optional().describe("Maximum live instances. Defaults to 50."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("compare_prefab_instances", args)
	);
	server.registerTool(
		"apply_prefab_instance_boundary",
		{
			title: "Apply prefab instance values to a source boundary",
			description:
				"After confirm=true, apply selected live transform/visibility and bounded serialized metadata-component set/remove changes to one exact outer or nested source asset boundary. targetPath and expectedRevision must come from inspect_prefab_instance_links; variants retain changes as overrides while base assets are updated directly.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				transformVisibility: z.boolean().default(true),
				componentChanges: z
					.array(
						z.discriminatedUnion("action", [
							z.object({ action: z.literal("set"), componentKey, value: propertyValue }),
							z.object({ action: z.literal("remove"), componentKey }),
						])
					)
					.max(64)
					.optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_boundary", args)
	);
	server.registerTool(
		"revert_prefab_instance_boundary",
		{
			title: "Revert prefab instance values from a source boundary",
			description:
				"After confirm=true, replace selected live transform/visibility and component values from one exact outer or nested source asset boundary without modifying any asset. Missing selected components are removed from the live node. targetPath and expectedRevision must come from inspect_prefab_instance_links.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				transformVisibility: z.boolean().default(true),
				componentKeys: z.array(componentKey).max(64).optional(),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_boundary", args)
	);
	server.registerTool(
		"unpack_prefab_instance",
		{
			title: "Unpack prefab instance",
			description:
				"After confirm=true, detach the selected live prefab subtree. outermost removes the selected source boundary while preserving deeper nested-prefab links; completely removes every prefab link in the subtree. Scene objects and hierarchy remain in place and source assets are never modified.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512).optional(),
				mode: z.enum(["outermost", "completely"]),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("unpack_prefab_instance", args)
	);
	server.registerTool(
		"promote_prefab_instance_boundary_overrides",
		{
			title: "Promote nested prefab boundary overrides",
			description:
				"After confirm=true, move selected transform, arbitrary-property, serialized-component, and/or descendant structural overrides from the containing prefab variant into one nested source asset boundary. Stable identities are translated into the target asset, both exact revisions are required, promoted copies are removed from the container, and the target file is restored if the containing write fails.",
			inputSchema: z.object({
				nodeId: z.string().min(1).optional(),
				nodeName: z.string().min(1).max(256).optional(),
				targetPath: z.string().min(1).max(512),
				expectedContainerRevision: z.string().regex(/^[a-f0-9]{64}$/),
				expectedTargetRevision: z.string().regex(/^[a-f0-9]{64}$/),
				categories: z
					.array(z.enum(["transforms", "properties", "components", "structure"]))
					.min(1)
					.max(4),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("promote_prefab_instance_boundary_overrides", args)
	);
	server.registerTool(
		"apply_prefab_instance_root",
		{
			title: "Apply prefab instance root",
			description: "Apply a prefab instance root's transform and visibility into its linked prefab (or variant) asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_root", args)
	);
	server.registerTool(
		"revert_prefab_instance_root",
		{
			title: "Revert prefab instance root",
			description: "Restore a prefab instance root's transform and visibility from its linked prefab asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_root", args)
	);
	server.registerTool(
		"apply_prefab_instance_node",
		{
			title: "Apply prefab instance node",
			description: "Apply a nested prefab mesh node's transform and visibility into its linked prefab asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_prefab_instance_node", args)
	);
	server.registerTool(
		"revert_prefab_instance_node",
		{
			title: "Revert prefab instance node",
			description: "Restore a nested prefab mesh node's transform and visibility from its linked prefab asset.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_prefab_instance_node", args)
	);
	server.registerTool(
		"instantiate_prefab",
		{
			title: "Instantiate prefab",
			description: "Load a persisted prefab mesh hierarchy into the active scene and mark the created nodes with prefab instance metadata.",
			inputSchema: z.object({ path: z.string(), name: z.string().optional(), position: z.array(z.number()).length(3).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_prefab", args)
	);
}

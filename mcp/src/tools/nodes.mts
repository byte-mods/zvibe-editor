import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerNodeTools(server: McpServer): void {
	const transformFields = {
		position: z.array(z.number().finite()).length(3).optional().describe("Position [x,y,z] in editor centimeters."),
		rotation: z.array(z.number().finite()).length(3).optional().describe("Euler rotation [x,y,z] in radians."),
		scaling: z.array(z.number().finite()).length(3).optional().describe("Scaling [x,y,z]."),
		direction: z.array(z.number().finite()).length(3).optional().describe("Light direction [x,y,z]."),
		target: z.array(z.number().finite()).length(3).optional().describe("Camera target [x,y,z] in editor centimeters."),
	};

	server.registerTool(
		"get_node",
		{
			title: "Get node",
			description:
				"Get full details of a single node: id, name, className, position, rotation, scaling, enabled/visible state, parent id, material id and metadata. " +
				"Address the node by `nodeId` (preferred, the Babylon `node.id`) or `nodeName`. Use it to read current values before modifying them.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred). Get it from `get_scene_hierarchy`."),
				nodeName: z.string().optional().describe("Name of the target node. Used only if `nodeId` is not provided or does not resolve."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node", args)
	);

	server.registerTool(
		"get_collaboration_node_revision",
		{
			title: "Get collaboration node revision",
			description:
				"Read a node's live transform and optimistic-concurrency revision. Use the returned revision as expectedRevision in apply_collaborative_node_transform to avoid overwriting another editor's change.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().min(1).max(128).optional().describe("Name of the target node if its id is unavailable."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_collaboration_node_revision", args)
	);

	server.registerTool(
		"apply_collaborative_node_transform",
		{
			title: "Apply revision-guarded node transform",
			description:
				"Atomically apply a transform only when expectedRevision still matches the live node. Returns status=conflict with the current transform/revision instead of overwriting concurrent work. Reusing the same operationId and arguments safely replays the first result; use a new operationId after resolving a conflict.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().min(1).max(128).optional().describe("Name of the target node if its id is unavailable."),
				expectedRevision: z.number().int().nonnegative().safe().describe("Revision returned by get_collaboration_node_revision."),
				operationId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
					.describe("Caller-generated unique id used to make retries idempotent."),
				...transformFields,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_collaborative_node_transform", args)
	);

	server.registerTool(
		"get_collaboration_node_edit_revision",
		{
			title: "Get collaboration node-edit revision",
			description:
				"Read a node's live non-transform editing state and optimistic-concurrency revision. The state covers enabled/visible, mesh material, layer/tags, isPickable, checkCollisions, receiveShadows, and applyGravity. Use the revision with apply_collaborative_node_edit.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().min(1).max(128).optional().describe("Name of the target node if its id is unavailable."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_collaboration_node_edit_revision", args)
	);

	server.registerTool(
		"apply_collaborative_node_edit",
		{
			title: "Apply revision-guarded node edit",
			description:
				"Atomically edit common non-transform node state only when expectedRevision matches the live node. A stale write returns status=conflict and the complete current state without overwriting it. Identical operationId retries replay safely; after a conflict use the returned revision with a new operationId.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().min(1).max(128).optional().describe("Name of the target node if its id is unavailable."),
				expectedRevision: z.number().int().nonnegative().safe().describe("Revision returned by get_collaboration_node_edit_revision."),
				operationId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
					.describe("Caller-generated unique id for idempotent retries."),
				enabled: z.boolean().optional().describe("Enable or disable the node."),
				visible: z.boolean().optional().describe("Set mesh visibility."),
				materialId: z.string().min(1).max(128).nullable().optional().describe("Assign a scene material by id, or null to clear a mesh material."),
				layer: z.string().min(1).max(128).optional().describe("Set the Unity-style editor layer."),
				tags: z.array(z.string().min(1).max(64)).max(64).optional().describe("Replace editor tags."),
				isPickable: z.boolean().optional(),
				checkCollisions: z.boolean().optional(),
				receiveShadows: z.boolean().optional(),
				applyGravity: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_collaborative_node_edit", args)
	);

	server.registerTool(
		"get_collaboration_hierarchy_revision",
		{
			title: "Get collaboration hierarchy revision",
			description: "Read a node's current parent and independent optimistic-concurrency hierarchy revision before reparenting it.",
			inputSchema: z.object({ nodeId: z.string().min(1).max(128).optional(), nodeName: z.string().min(1).max(128).optional() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_collaboration_hierarchy_revision", args)
	);

	server.registerTool(
		"apply_collaborative_hierarchy_edit",
		{
			title: "Apply revision-guarded hierarchy edit",
			description:
				"Atomically reparent a node only when expectedRevision matches its live hierarchy. Pass parentId=null for the scene root. Self/descendant cycles are rejected; stale writes return the current parent/revision without overwriting it; identical operationId retries replay safely.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional(),
				nodeName: z.string().min(1).max(128).optional(),
				parentId: z.string().min(1).max(128).nullable(),
				expectedRevision: z.number().int().nonnegative().safe(),
				operationId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_collaborative_hierarchy_edit", args)
	);

	server.registerTool(
		"get_collaboration_node_property_revision",
		{
			title: "Get collaboration property-path revision",
			description:
				"Read 1-32 existing safe dotted node properties as bounded JSON plus an optimistic-concurrency revision scoped to exactly that sorted path set. Prototype, identity, hierarchy, transform, material, metadata, and dedicated node-state paths are rejected.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional(),
				nodeName: z.string().min(1).max(128).optional(),
				paths: z.array(z.string().min(1).max(256)).min(1).max(32),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_collaboration_node_property_revision", args)
	);

	server.registerTool(
		"apply_collaborative_node_properties",
		{
			title: "Apply revision-guarded node properties",
			description:
				"Atomically set 1-32 existing safe dotted properties only when the revision for that exact path set matches. Values are bounded to 64 KiB JSON with finite numbers, limited arrays/objects/depth, and engine vector/color coercion. Unsafe/prototype/function/new-property writes are rejected. Conflicts return current values; identical operationId retries replay safely.",
			inputSchema: z.object({
				nodeId: z.string().min(1).max(128).optional(),
				nodeName: z.string().min(1).max(128).optional(),
				expectedRevision: z.number().int().nonnegative().safe(),
				operationId: z
					.string()
					.min(1)
					.max(128)
					.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
				properties: z.record(z.string().min(1).max(256), z.unknown()).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32, {
					message: "properties must contain 1 through 32 paths.",
				}),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_collaborative_node_properties", args)
	);

	server.registerTool(
		"get_node_classification",
		{
			title: "Get node layer and tags",
			description: "Get a node's persisted editor layer and tags.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_classification", args)
	);
	server.registerTool(
		"set_node_classification",
		{
			title: "Set node layer and tags",
			description: "Set a node's persisted Unity-style editor layer and tags.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				layer: z.string().min(1).optional(),
				tags: z.array(z.string().min(1)).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_classification", args)
	);

	server.registerTool(
		"set_node_transform",
		{
			title: "Set node transform",
			description:
				"Set a node's transform. Works for meshes/transform nodes (position/rotation/scaling), lights (position and/or direction) and cameras (position, rotation and/or target). " +
				"Positions/targets are in editor units (centimeters); rotation/direction are in radians/world units. Only the provided and node-supported fields are applied; " +
				"the change is reflected live in the editor inspector. Use `get_node` first to see which of these properties a given node exposes.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters (meshes, cameras, point/spot/directional lights)."),
				rotation: z.array(z.number()).length(3).optional().describe("Euler rotation `[x,y,z]` in radians (meshes, transform nodes, free/universal cameras)."),
				scaling: z.array(z.number()).length(3).optional().describe("Scaling `[x,y,z]` (meshes and transform nodes only)."),
				direction: z.array(z.number()).length(3).optional().describe("Direction vector `[x,y,z]` for directional/spot/hemispheric lights (the way the light points)."),
				target: z.array(z.number()).length(3).optional().describe("Point `[x,y,z]` (centimeters) a camera looks at. Applies to cameras that support `setTarget`."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_transform", args)
	);

	server.registerTool(
		"set_node_properties",
		{
			title: "Set node properties",
			description:
				'Deep-set arbitrary node properties by dotted path, e.g. `"material.albedoColor"`, `"isVisible"`, `"receiveShadows"`. ' +
				"Values may be numbers, strings, booleans, or `[r,g,b]`/`[x,y,z]` arrays which are coerced to Color3/Vector3 based on the existing property type. " +
				"This is the catch-all for DEEP customization not covered by a dedicated tool — including built-in collisions: " +
				'`"checkCollisions"` (true to make a mesh block moveWithCollisions), `"ellipsoid"`/`"ellipsoidOffset"` ([x,y,z], the collider used for character-style movement), `"isPickable"`, `"applyGravity"`. ' +
				"For Havok rigid-body physics use `set_mesh_physics` instead. You can set many properties at once via the `properties` map, and many nodes at once via `execute_batch`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				properties: z.record(z.string(), z.any()).describe("Map of dotted property path to value."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_properties", args)
	);

	server.registerTool(
		"set_node_parent",
		{
			title: "Set node parent",
			description:
				"Reparent a node while preserving its world transform. Pass `parentId`/`parentName` to set the new parent, or omit both to move the node to the scene root. " +
				"Note: a non-shadow light should live in the ClusteredLightContainer for performance; reparenting such a light into the container attaches it correctly.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the node to reparent (preferred)."),
				nodeName: z.string().optional().describe("Name of the node to reparent."),
				parentId: z.string().optional().describe("Id of the new parent. Omit (and omit parentName) to move to the scene root."),
				parentName: z.string().optional().describe("Name of the new parent."),
				preserveWorldTransform: z.boolean().optional().describe("Keep the node's world transform after reparenting. Defaults to true."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_parent", args)
	);

	server.registerTool(
		"rename_node",
		{
			title: "Rename node",
			description: "Rename a node. The new name appears immediately in the editor's scene graph.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				newName: z.string().describe("The new name for the node."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("rename_node", args)
	);

	server.registerTool(
		"delete_node",
		{
			title: "Delete node",
			description: "Remove a node and all of its descendants from the scene. This is destructive; verify the target with `get_node` first if unsure.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
			}),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_node", args)
	);

	server.registerTool(
		"select_node",
		{
			title: "Select node",
			description: "Select and focus a node in the editor (UX only, no scene change). Helps the user follow what the agent is doing.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("select_node", args)
	);

	server.registerTool(
		"get_selected_nodes",
		{
			title: "Get selected nodes",
			description:
				"Get the nodes the user has currently selected in the editor's scene graph, as an array of node summaries (id, name, className, transform, …). " +
				'Use this whenever the user refers to "the selected node(s)" — e.g. "instantiate the selected node 100 times to build a forest". ' +
				"Returns `{ count, nodes }`; if `count` is 0, ask the user to select a node in the editor first. " +
				"Then drive instancing with the returned `id` (prefer `create_instance` over `clone_mesh` for performance) and scatter the copies with `set_node_transform`.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_selected_nodes", args)
	);
}

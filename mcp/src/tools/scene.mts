import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerSceneTools(server: McpServer): void {
	server.registerTool(
		"get_scene_hierarchy",
		{
			title: "Get scene hierarchy",
			description:
				"Retrieve the hierarchy of nodes in the current scene as a tree of `{ id, name, type, children[] }`. " +
				"This is the starting point for almost every task: call it first to understand what already exists, find existing meshes/lights/cameras to reuse, and get the `id` of nodes you want to modify. " +
				"Most other tools accept a `nodeId` (preferred) or `nodeName` taken from this tree. " +
				"Typical workflow to build a scene: `get_scene_hierarchy` to inspect, then `create_primitive_mesh`/`create_light`/`create_camera`/`instantiate_mesh_asset` to add content, then `get_screenshot` to verify the result.",
			inputSchema: z.object({
				rootNodeName: z.string().optional().describe("Name of the root node to get the hierarchy from. If not provided, the whole scene hierarchy is returned."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_scene_hierarchy", args)
	);

	server.registerTool(
		"list_scenes",
		{
			title: "List scenes",
			description:
				"List project `.scene` assets in build order with active, enabled, and build-index state. Results are bounded and paginated. A project can contain multiple scenes that share assets.",
			inputSchema: z
				.object({
					offset: z.number().int().nonnegative().optional().describe("Zero-based result offset. Defaults to 0."),
					limit: z.number().int().min(1).max(100).optional().describe("Maximum results. Defaults to 50 and is capped at 100."),
				})
				.strict(),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_scenes", args)
	);

	server.registerTool(
		"get_scene_build_settings",
		{
			title: "Get scene build settings",
			description: "Get the complete ordered scene build list, enabled state, and exact fingerprint required to update it safely.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_scene_build_settings", {})
	);

	server.registerTool(
		"set_scene_build_settings",
		{
			title: "Set scene build settings",
			description:
				"Replace scene build order and enabled state under an exact fingerprint lease. Include every discovered .scene exactly once; disable scenes instead of omitting them.",
			inputSchema: z
				.object({
					expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_build_settings."),
					scenes: z.array(z.object({ path: z.string().min(1).max(1024).describe("Project-relative .scene path."), enabled: z.boolean() }).strict()).max(512),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_scene_build_settings", args)
	);

	server.registerTool(
		"get_scene_workspace",
		{
			title: "Get additive scene workspace",
			description:
				"Inspect every authored scene currently loaded together in the editor, including independent root nodes, active/lighting/dirty flags, owned-object counts, and the exact fingerprint required by lifecycle mutations.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_scene_workspace", {})
	);

	server.registerTool(
		"load_scene_additive",
		{
			title: "Load authored scene additively",
			description:
				"Load one project .scene into the current authoring workspace without resetting existing scenes. Content remains independently owned, saveable, revertible, movable, and unloadable.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Existing project-relative .scene path."),
					expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_workspace."),
					makeActive: z.boolean().optional().describe("Also make this scene receive newly authored root content."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("load_scene_additive", args)
	);

	server.registerTool(
		"set_active_workspace_scene",
		{
			title: "Set active authored scene",
			description: "Select the loaded scene that owns newly created or imported root objects without changing lighting configuration.",
			inputSchema: z
				.object({ path: z.string().min(1).max(1024), expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_workspace.") })
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_active_workspace_scene", args)
	);

	server.registerTool(
		"set_lighting_workspace_scene",
		{
			title: "Set lighting authored scene",
			description: "Select the loaded scene whose environment, fog, gravity, rendering, and other global configuration is applied to the shared preview.",
			inputSchema: z
				.object({ path: z.string().min(1).max(1024), expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_workspace.") })
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_lighting_workspace_scene", args)
	);

	server.registerTool(
		"save_workspace_scene",
		{
			title: "Save one authored scene",
			description: "Save exactly one loaded scene with ownership filtering and clear only that scene's dirty flag.",
			inputSchema: z
				.object({ path: z.string().min(1).max(1024), expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_workspace.") })
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_workspace_scene", args)
	);

	server.registerTool(
		"revert_workspace_scene",
		{
			title: "Revert one authored scene",
			description: "Discard one loaded scene's in-memory edits and reload only that scene while every other loaded scene remains intact.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024),
					expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_workspace."),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("revert_workspace_scene", args)
	);

	server.registerTool(
		"unload_scene_additive",
		{
			title: "Unload authored scene",
			description:
				"Unload one authored scene and its exact resources while preserving all others. Dirty scenes require confirm:true; the last authored scene cannot be unloaded.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024),
					expectedFingerprint: z.string().length(64).describe("Fingerprint returned by get_scene_workspace."),
					confirm: z.literal(true).optional().describe("Required when the selected scene has unsaved edits."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("unload_scene_additive", args)
	);

	const sceneMoveNodesSchema = z
		.array(z.string().min(1).max(256))
		.min(1)
		.max(128)
		.refine((values) => new Set(values).size === values.length, "nodeIds must be unique.");

	server.registerTool(
		"inspect_scene_object_move",
		{
			title: "Inspect cross-scene object move",
			description:
				"Plan a lossless move of authored scene roots, including their exclusive materials, textures, geometry, skeletons, morph data, particle systems, shadows, and animation groups. Rejects partial cross-scene animations.",
			inputSchema: z.object({ nodeIds: sceneMoveNodesSchema, targetScene: z.string().min(1).max(1024) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_scene_object_move", args)
	);

	server.registerTool(
		"move_scene_objects",
		{
			title: "Move objects between authored scenes",
			description: "Apply an exact inspected root/dependency move between loaded scenes with world-transform preservation and complete editor undo/redo support.",
			inputSchema: z
				.object({
					nodeIds: sceneMoveNodesSchema,
					targetScene: z.string().min(1).max(1024),
					expectedPlanFingerprint: z.string().length(64).describe("planFingerprint returned by inspect_scene_object_move."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("move_scene_objects", args)
	);

	server.registerTool(
		"list_scene_templates",
		{
			title: "List scene templates",
			description: "List reusable self-contained `.scenetemplate` assets with source scene and creation metadata. Results are bounded and paginated.",
			inputSchema: z
				.object({
					offset: z.number().int().nonnegative().optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_scene_templates", args)
	);

	server.registerTool(
		"create_scene_template",
		{
			title: "Create scene template",
			description: "Save the active scene when applicable, then atomically capture a project scene as a self-contained reusable `.scenetemplate` asset.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).max(1024).describe("Existing project-relative .scene path."),
					templatePath: z.string().min(1).max(1024).describe("New project-relative .scenetemplate path."),
					name: z.string().min(1).max(128).optional(),
					description: z.string().max(1024).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_scene_template", args)
	);

	server.registerTool(
		"instantiate_scene_template",
		{
			title: "Instantiate scene template",
			description: "Atomically create a new `.scene` from a self-contained template and add it to scene build settings.",
			inputSchema: z
				.object({
					templatePath: z.string().min(1).max(1024).describe("Existing project-relative .scenetemplate path."),
					destinationPath: z.string().min(1).max(1024).describe("New project-relative .scene path."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_scene_template", args)
	);

	server.registerTool(
		"delete_scene_template",
		{
			title: "Delete scene template",
			description: "Permanently delete a `.scenetemplate` asset after explicit confirmation.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Existing project-relative .scenetemplate path."), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_scene_template", args)
	);

	server.registerTool(
		"create_scene",
		{
			title: "Create scene",
			description: "Create and open a new project-relative .scene directory with the editor's default camera, ground, box, and directional light.",
			inputSchema: z.object({ path: z.string().min(1).describe("New project-relative scene path ending in .scene.") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_scene", args)
	);

	server.registerTool(
		"open_scene",
		{
			title: "Open scene",
			description: "Reset the editor preview and open an existing project-relative .scene directory.",
			inputSchema: z.object({ path: z.string().min(1).describe("Existing project-relative scene path ending in .scene.") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_scene", args)
	);

	server.registerTool(
		"duplicate_scene",
		{
			title: "Duplicate scene",
			description: "Duplicate a scene directory to a new project-relative .scene path and update copied scene-internal references.",
			inputSchema: z.object({
				sourcePath: z.string().min(1).describe("Existing project-relative .scene path."),
				destinationPath: z.string().min(1).describe("New project-relative .scene path."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("duplicate_scene", args)
	);

	server.registerTool(
		"delete_scene",
		{
			title: "Delete scene",
			description: "Permanently delete a non-active scene directory. You must set confirm to true after verifying the path.",
			inputSchema: z.object({ path: z.string().min(1).describe("Project-relative .scene path to delete."), confirm: z.literal(true) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_scene", args)
	);

	server.registerTool(
		"list_scene_links",
		{
			title: "List scene links",
			description: "List SceneLink nodes in the active scene and the project-relative scenes they load.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_scene_links")
	);

	server.registerTool(
		"create_scene_link",
		{
			title: "Create scene link",
			description: "Create a SceneLink node in the active scene and load the specified project-relative .scene asset beneath it.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Existing project-relative .scene path."),
				name: z.string().optional().describe("Optional SceneLink node name."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_scene_link", args)
	);

	server.registerTool(
		"reload_scene_link",
		{
			title: "Reload scene link",
			description: "Reload a SceneLink node from its linked scene asset after the source scene changes.",
			inputSchema: z.object({ nodeId: z.string().optional().describe("SceneLink node id."), nodeName: z.string().optional().describe("SceneLink node name.") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reload_scene_link", args)
	);

	server.registerTool(
		"get_active_scene",
		{
			title: "Get active scene",
			description:
				"Get the name/path of the currently edited scene plus counts of meshes, lights and materials. Useful to gauge scene complexity before adding more content.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_active_scene", args)
	);

	server.registerTool(
		"save_scene",
		{
			title: "Save scene",
			description: "Save the current scene/project to disk. Call this once you are satisfied with the result so the user's work is persisted.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_scene", args)
	);

	server.registerTool(
		"get_scene_settings",
		{
			title: "Get scene settings",
			description:
				"Get scene-level settings: clear color, ambient color, environment texture, fog and active camera. Inspect these before tuning the overall mood/lighting of a scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_scene_settings", args)
	);

	server.registerTool(
		"set_scene_settings",
		{
			title: "Set scene settings",
			description:
				"Set scene-level settings via dotted property paths (e.g. `clearColor`, `ambientColor`, `fogMode`, `fogColor`, `fogDensity`). " +
				"Color values can be passed as `[r,g,b]` arrays and are coerced to the existing property type. " +
				"Use this for atmosphere tuning, e.g. a warm clear color for a sunset scene.",
			inputSchema: z.object({
				properties: z
					.record(z.string(), z.any())
					.describe(
						"Map of dotted property path to value. Arrays like `[r,g,b]` are coerced to Color3/Color4 and `[x,y,z]` to Vector3 based on the existing property type."
					),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_scene_settings", args)
	);

	server.registerTool(
		"get_2d_scene_mode",
		{
			title: "Get 2D scene mode",
			description: "Get the active scene's persisted 2D orthographic-authoring configuration and camera id.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_2d_scene_mode", {})
	);

	server.registerTool(
		"set_2d_scene_mode",
		{
			title: "Set 2D scene mode",
			description:
				"Enable an orthographic camera setup for sprite, tilemap, and 2D-physics authoring. Creates a 2D Camera when the scene has no active camera. Disable to return the configured camera to perspective mode.",
			inputSchema: z.object({
				enabled: z.boolean(),
				cameraId: z.string().optional().describe("Existing camera id to configure. Omit to use the active camera or create a 2D Camera."),
				orthographicSize: z.number().positive().optional().describe("Half-height of the orthographic view in editor centimeters. Defaults to 500."),
				aspectRatio: z.number().positive().optional().describe("View width/height ratio used to calculate left/right extents. Defaults to 1."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_2d_scene_mode", args)
	);

	server.registerTool(
		"get_physics_collision_layers",
		{
			title: "Get physics collision layers",
			description: "Read the active scene's persisted named 3D physics collision layers and collision masks.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_physics_collision_layers", {})
	);
	server.registerTool(
		"set_physics_collision_layers",
		{
			title: "Set physics collision layers",
			description: "Replace the active scene's named 3D physics collision layers. Each layer uses a unique power-of-two bit and a 16-bit collidesWith mask.",
			inputSchema: z.object({
				layers: z
					.array(z.object({ name: z.string().min(1), bit: z.number().int().positive(), collidesWith: z.number().int().nonnegative() }))
					.min(1)
					.max(16),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_physics_collision_layers", args)
	);
}

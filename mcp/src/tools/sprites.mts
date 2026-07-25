import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const managerIdentity = {
	managerNodeId: z.string().optional().describe("Sprite Manager node id (preferred)."),
	managerNodeName: z.string().optional().describe("Sprite Manager node name."),
};
const mapIdentity = { mapNodeId: z.string().optional().describe("Sprite Map node id (preferred)."), mapNodeName: z.string().optional().describe("Sprite Map node name.") };
const vector3 = z.array(z.number()).length(3);

export function registerSpriteTools(server: McpServer): void {
	server.registerTool(
		"list_sprite_managers",
		{
			title: "List sprite managers",
			description: "List editor Sprite Manager nodes and their assigned sheets/atlases.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_sprite_managers", {})
	);
	server.registerTool(
		"create_sprite_manager",
		{
			title: "Create sprite manager",
			description: "Create a Sprite Manager node, optionally configured from a project-relative spritesheet image or atlas JSON.",
			inputSchema: z.object({ name: z.string().optional(), parentId: z.string().optional(), imagePath: z.string().optional(), atlasJsonPath: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_manager", args)
	);
	server.registerTool(
		"set_sprite_manager",
		{
			title: "Set sprite manager",
			description:
				"Assign/change a Sprite Manager spritesheet/atlas or editor-exposed SpriteManager properties (capacity, cellWidth/cellHeight, fogEnabled, blendMode, pixelPerfect, etc.).",
			inputSchema: z.object({
				...managerIdentity,
				name: z.string().optional(),
				imagePath: z.string().optional(),
				atlasJsonPath: z.string().optional(),
				properties: z.record(z.string(), z.any()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_manager", args)
	);
	server.registerTool(
		"pack_sprite_atlas",
		{
			title: "Pack PNG sprite atlas",
			description:
				"Pack project PNG assets into a deterministic power-of-two atlas PNG and TexturePacker-compatible JSON descriptor. Optional transparent trimming preserves source offsets; optional clockwise 90-degree rotation reduces shelf height and is decoded by both exported Sprite Managers and Sprite Maps. Returns exact rotated-frame evidence.",
			inputSchema: z
				.object({
					sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512).describe("Unique project-relative PNG asset paths to pack."),
					outputPath: z.string().min(1).max(1024).describe("Project-relative output .png atlas path, e.g. assets/atlases/characters.png."),
					padding: z.number().int().min(0).max(64).optional().describe("Transparent pixel padding between sprites. Defaults to 2."),
					trimTransparent: z.boolean().optional().describe("Crop transparent borders and emit TexturePacker trim offsets. Defaults to false."),
					allowRotation: z.boolean().optional().describe("Permit deterministic clockwise 90-degree packing with rotated=true descriptor evidence. Defaults to false."),
					maxSize: z.number().int().min(64).max(8192).optional().describe("Maximum power-of-two atlas dimension. Defaults to 2048."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("pack_sprite_atlas", args)
	);
	server.registerTool(
		"slice_sprite_sheet",
		{
			title: "Slice irregular sprite sheet",
			description:
				"Write a TexturePacker-compatible atlas JSON descriptor for named irregular rectangles on one project image. Use the resulting JSON with Sprite Managers or Sprite Maps.",
			inputSchema: z.object({
				sourcePath: z.string().describe("Project-relative source image path."),
				outputPath: z.string().describe("Project-relative output .json atlas descriptor path."),
				frames: z
					.array(
						z.object({
							name: z.string(),
							x: z.number().int().nonnegative(),
							y: z.number().int().nonnegative(),
							width: z.number().int().positive(),
							height: z.number().int().positive(),
						})
					)
					.min(1)
					.describe("Named source-image rectangles in pixels."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("slice_sprite_sheet", args)
	);
	server.registerTool(
		"list_sprites",
		{
			title: "List sprites",
			description: "List sprites owned by a Sprite Manager with transform, atlas cell, color, and animation data.",
			inputSchema: z.object(managerIdentity),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_sprites", args)
	);
	server.registerTool(
		"create_sprite",
		{
			title: "Create sprite",
			description: "Create a sprite in a configured Sprite Manager.",
			inputSchema: z.object({
				...managerIdentity,
				name: z.string().optional(),
				position: vector3.optional(),
				width: z.number().optional(),
				height: z.number().optional(),
				cellIndex: z.number().optional(),
				cellRef: z.string().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite", args)
	);
	server.registerTool(
		"set_sprite",
		{
			title: "Set sprite",
			description: "Edit a sprite's transform, dimensions, atlas cell, visual settings, and animation list.",
			inputSchema: z.object({
				...managerIdentity,
				spriteId: z.string().optional(),
				spriteName: z.string().optional(),
				name: z.string().optional(),
				position: vector3.optional(),
				width: z.number().optional(),
				height: z.number().optional(),
				angle: z.number().optional(),
				cellIndex: z.number().optional(),
				cellRef: z.string().optional(),
				invertU: z.boolean().optional(),
				invertV: z.boolean().optional(),
				isVisible: z.boolean().optional(),
				color: z.array(z.number()).length(4).optional(),
				animations: z.array(z.object({ name: z.string(), from: z.number(), to: z.number(), loop: z.boolean(), delay: z.number() })).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite", args)
	);
	server.registerTool(
		"play_sprite_animation",
		{
			title: "Play sprite animation",
			description: "Play or stop a configured Sprite animation by frame range.",
			inputSchema: z.object({
				...managerIdentity,
				spriteId: z.string().optional(),
				spriteName: z.string().optional(),
				from: z.number().optional(),
				to: z.number().optional(),
				loop: z.boolean().optional(),
				delay: z.number().optional(),
				stop: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("play_sprite_animation", args)
	);
	server.registerTool(
		"list_sprite_maps",
		{
			title: "List sprite maps",
			description: "List editor Sprite Map nodes with atlas options and tile sets.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_sprite_maps", {})
	);
	server.registerTool(
		"create_sprite_map",
		{
			title: "Create sprite map",
			description: "Create an editable Sprite Map from a project-relative atlas JSON.",
			inputSchema: z.object({
				name: z.string().optional(),
				parentId: z.string().optional(),
				atlasJsonPath: z.string().optional(),
				options: z
					.object({
						layerCount: z.number().int().min(1).max(8).optional(),
						stageSize: z.array(z.number()).length(2).optional(),
						outputSize: z.array(z.number()).length(2).optional(),
						colorMultiply: vector3.optional(),
					})
					.optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_map", args)
	);
	server.registerTool(
		"set_sprite_map",
		{
			title: "Set sprite map",
			description: "Change a Sprite Map atlas or its stage/output/layer/color options.",
			inputSchema: z.object({
				...mapIdentity,
				name: z.string().optional(),
				atlasJsonPath: z.string().optional(),
				options: z
					.object({
						layerCount: z.number().int().min(1).max(8).optional(),
						stageSize: z.array(z.number()).length(2).optional(),
						outputSize: z.array(z.number()).length(2).optional(),
						colorMultiply: vector3.optional(),
					})
					.optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_map", args)
	);
	server.registerTool(
		"set_sprite_map_rule_tiles",
		{
			title: "Set Sprite Map rule tiles",
			description:
				"Set persisted eight-neighbor tile rules. Rules map a source atlas frame to an output frame when cardinal or diagonal neighbors are same, different, or any.",
			inputSchema: z.object({
				...mapIdentity,
				rules: z.array(
					z.object({
						sourceTile: z.union([z.string(), z.number().int().nonnegative()]),
						outputTile: z.union([z.string(), z.number().int().nonnegative()]).optional(),
						variants: z.array(z.object({ tile: z.union([z.string(), z.number().int().nonnegative()]), weight: z.number().positive() })).optional(),
						seed: z.number().int().optional(),
						neighbors: z.record(z.string(), z.enum(["same", "different", "any"])).optional(),
					})
				),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_map_rule_tiles", args)
	);
	server.registerTool(
		"resolve_sprite_map_rule_tiles",
		{ title: "Resolve Sprite Map rule tiles", description: "Re-evaluate persisted Sprite Map neighbor rules after tile edits.", inputSchema: z.object(mapIdentity) },
		async (args): Promise<CallToolResult> => callTextTool("resolve_sprite_map_rule_tiles", args)
	);
	server.registerTool(
		"set_sprite_map_tiles",
		{
			title: "Set sprite map tiles",
			description: "Replace, add, or remove editable Sprite Map tile sets.",
			inputSchema: z.object({
				...mapIdentity,
				mode: z.enum(["replace", "add", "remove"]),
				tiles: z.array(z.record(z.string(), z.any())).optional(),
				tileIds: z.array(z.string()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_map_tiles", args)
	);
	const paletteReference = { paletteId: z.string().optional(), paletteName: z.string().optional() };
	server.registerTool(
		"list_tile_palettes",
		{
			title: "List tile palettes",
			description: "List reusable Sprite Map tile-palette assets persisted with the scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_tile_palettes", {})
	);
	server.registerTool(
		"create_tile_palette",
		{
			title: "Create tile palette",
			description: "Create a reusable brush palette from atlas tile indexes for a Sprite Map.",
			inputSchema: z.object({
				...mapIdentity,
				name: z.string(),
				tileIndexes: z.array(z.number().int().nonnegative()).min(1),
				activeTileIndex: z.number().int().nonnegative().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_tile_palette", args)
	);
	server.registerTool(
		"set_tile_palette",
		{
			title: "Set tile palette",
			description: "Change a palette name, membership, or active paint-brush tile.",
			inputSchema: z.object({
				...paletteReference,
				name: z.string().optional(),
				tileIndexes: z.array(z.number().int().nonnegative()).min(1).optional(),
				activeTileIndex: z.number().int().nonnegative().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_tile_palette", args)
	);
	server.registerTool(
		"paint_tile_palette",
		{
			title: "Paint tile palette",
			description: "Paint or erase a rectangular grid brush stroke with a persisted palette. Coordinates are Sprite Map grid cells.",
			inputSchema: z.object({
				...paletteReference,
				mapNodeId: z.string().optional(),
				position: z.array(z.number().int()).length(2),
				width: z.number().int().positive().optional(),
				height: z.number().int().positive().optional(),
				layer: z.number().int().nonnegative().optional(),
				tileIndex: z.number().int().nonnegative().optional(),
				mode: z.enum(["paint", "erase"]).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_tile_palette", args)
	);
	server.registerTool(
		"delete_tile_palette",
		{ title: "Delete tile palette", description: "Delete a palette asset without removing its painted Sprite Map cells.", inputSchema: z.object(paletteReference) },
		async (args): Promise<CallToolResult> => callTextTool("delete_tile_palette", args)
	);
	const animatedTileReference = { id: z.string().optional(), name: z.string().optional() };
	server.registerTool(
		"list_animated_tiles",
		{
			title: "List animated tiles",
			description: "List persisted atlas-frame sequences for a Sprite Map.",
			inputSchema: z.object(mapIdentity),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_animated_tiles", args)
	);
	server.registerTool(
		"create_animated_tile",
		{
			title: "Create animated tile",
			description: "Cycle existing Sprite Map cells through at least two atlas frames in editor and exported runtime.",
			inputSchema: z.object({
				...mapIdentity,
				name: z.string(),
				tileIds: z.array(z.string()).min(1),
				frames: z.array(z.number().int().nonnegative()).min(2),
				frameDuration: z.number().positive().describe("Milliseconds per frame."),
				loop: z.boolean().optional(),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_animated_tile", args)
	);
	server.registerTool(
		"set_animated_tile",
		{
			title: "Set animated tile",
			description: "Change an animated tile sequence, cell targets, timing, loop, or enabled state.",
			inputSchema: z.object({
				...mapIdentity,
				...animatedTileReference,
				tileIds: z.array(z.string()).min(1).optional(),
				frames: z.array(z.number().int().nonnegative()).min(2).optional(),
				frameDuration: z.number().positive().optional(),
				loop: z.boolean().optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animated_tile", args)
	);
	server.registerTool(
		"delete_animated_tile",
		{
			title: "Delete animated tile",
			description: "Delete a tile animation without removing painted Sprite Map cells.",
			inputSchema: z.object({ ...mapIdentity, ...animatedTileReference }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_animated_tile", args)
	);
	server.registerTool(
		"get_tile_collider_generator",
		{
			title: "Get tile colliders",
			description: "Read a Sprite Map's generated static 2D tile-collider configuration.",
			inputSchema: z.object(mapIdentity),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_tile_collider_generator", args)
	);
	server.registerTool(
		"generate_tile_colliders",
		{
			title: "Generate tile colliders",
			description:
				"Create static 2D box bodies for painted Sprite Map cells. Composite mode greedily merges adjacent cells into deterministic rectangles; existing generated colliders for that map are replaced.",
			inputSchema: z.object({
				...mapIdentity,
				tileIndexes: z.array(z.number().int().nonnegative()).optional().describe("Optional atlas frames to collide; omit for all painted cells."),
				layer: z.number().int().nonnegative().optional(),
				merge: z.boolean().optional().describe("Merge adjacent cells into deterministic composite rectangular box bodies (default true)."),
				isTrigger: z.boolean().optional(),
				friction: z.number().min(0).max(1).optional(),
				restitution: z.number().min(0).max(1).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_tile_colliders", args)
	);
	server.registerTool(
		"clear_tile_collider_generator",
		{
			title: "Clear tile colliders",
			description: "Remove generated static tile-body nodes and their 2D physics bodies without changing painted cells.",
			inputSchema: z.object(mapIdentity),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_tile_collider_generator", args)
	);
	server.registerTool(
		"refresh_tile_colliders",
		{
			title: "Refresh tile colliders",
			description:
				"Rebuild generated Sprite Map tile colliders after painting changes, preserving the saved tile filter, rectangle-merge mode, trigger, friction, and restitution settings.",
			inputSchema: z.object(mapIdentity),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_tile_colliders", args)
	);
}

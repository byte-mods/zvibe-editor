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
const tileColliderPoint = z.tuple([z.number().finite().min(-0.5).max(0.5), z.number().finite().min(-0.5).max(0.5)]);
const tileColliderHole = z.object({ id: z.string().min(1).max(128), points: z.array(tileColliderPoint).min(3).max(128) }).strict();
const tileColliderContour = z.object({ id: z.string().min(1).max(128), points: z.array(tileColliderPoint).min(3).max(128), holes: z.array(tileColliderHole).max(32) }).strict();
const tileColliderTypeRecord = z
	.record(z.string().regex(/^\d+$/), z.enum(["none", "grid", "sprite"]))
	.refine((value) => Object.keys(value).length <= 4096, "tileColliderTypes supports at most 4096 atlas-frame entries.");
const tileColliderShapeRecord = z
	.record(z.string().regex(/^\d+$/), z.array(tileColliderContour).min(1).max(32))
	.refine((value) => Object.keys(value).length <= 4096, "spriteShapes supports at most 4096 atlas-frame entries.");
const tileColliderLayerOverrides = z
	.object({
		priority: z.number().int().min(-128).max(127),
		includeLayers: z.number().int().min(0).max(0xffffffff),
		excludeLayers: z.number().int().min(0).max(0xffffffff),
		forceSendLayers: z.number().int().min(0).max(0xffffffff),
		forceReceiveLayers: z.number().int().min(0).max(0xffffffff),
		contactCaptureLayers: z.number().int().min(0).max(0xffffffff),
		callbackLayers: z.number().int().min(0).max(0xffffffff),
	})
	.strict();
const tileColliderSettingsShape = {
	compositeOperation: z.enum(["none", "merge", "intersect", "difference", "flip"]),
	geometryType: z.enum(["polygons", "outlines"]),
	generationType: z.enum(["synchronous", "manual"]),
	useDelaunayMesh: z.boolean(),
	maxTileChangeCount: z.number().int().min(1).max(1_000_000),
	extrusionFactor: z.number().finite().min(0).max(1_000_000),
	vertexDistance: z.number().finite().min(0.000001).max(1_000_000),
	offsetDistance: z.number().finite().min(0).max(1_000_000),
	offset: z.tuple([z.number().finite().min(-1_000_000).max(1_000_000), z.number().finite().min(-1_000_000).max(1_000_000)]),
	edgeRadius: z.number().finite().min(0.001).max(1_000_000),
	tileColliderTypes: tileColliderTypeRecord,
	spriteShapes: tileColliderShapeRecord,
	materialId: z.string().min(1).max(256).nullable(),
	isTrigger: z.boolean(),
	usedByEffector: z.boolean(),
	friction: z.number().finite().min(0).max(1),
	restitution: z.number().finite().min(0).max(1),
	collisionLayer: z.number().int().min(0).max(31),
	layerOverrides: tileColliderLayerOverrides,
};
const optionalTileColliderSettingsShape = Object.fromEntries(Object.entries(tileColliderSettingsShape).map(([key, schema]) => [key, schema.optional()]));
const spriteSkinIdentityFields = {
	nodeId: z.string().min(1).max(512).optional().describe("Sprite skin mesh node id (preferred)."),
	nodeName: z.string().min(1).max(256).optional().describe("Unique sprite skin mesh name."),
};
const spriteSkinIdentity = z
	.object(spriteSkinIdentityFields)
	.strict()
	.refine((value) => Boolean(value.nodeId) !== Boolean(value.nodeName), { message: "Provide exactly one of nodeId or nodeName." });
const spriteSkinBone = z
	.object({
		id: z.string().min(1).max(128),
		name: z.string().min(1).max(128),
		parentId: z.string().min(1).max(128).nullable(),
		position: z
			.tuple([z.number().finite().min(-100_000).max(100_000), z.number().finite().min(-100_000).max(100_000)])
			.describe("Parent-local planar [x,y] position in centimeters."),
		rotationDegrees: z.number().finite().min(-360_000).max(360_000),
		length: z.number().finite().min(0.001).max(100_000).describe("Planar bone display/influence length in centimeters."),
		sourceLayerIndex: z.number().int().min(0).nullable().optional(),
	})
	.strict();
const spriteSkinGeometryFields = {
	documentWidthPixels: z.number().int().min(1).max(32_768),
	documentHeightPixels: z.number().int().min(1).max(32_768),
	pixelsPerUnit: z.number().finite().min(0.01).max(100_000).optional().describe("Pixels per one 100-centimeter world unit; defaults to 100."),
	columns: z.number().int().min(1).max(64).optional().describe("Horizontal deformation grid segments; defaults to 16."),
	rows: z.number().int().min(1).max(64).optional().describe("Vertical deformation grid segments; defaults to 16."),
};
const psdSpriteRigFields = {
	sourcePath: z.string().min(1).max(1024).describe("Project-contained .psd or .psb path."),
	pixelsPerUnit: z.number().finite().min(0.01).max(100_000).optional(),
	columns: z.number().int().min(1).max(64).optional(),
	rows: z.number().int().min(1).max(64).optional(),
	includeHidden: z.boolean().optional().describe("Include hidden pixel/group layers; defaults to false."),
	includeGroupBones: z.boolean().optional().describe("Materialize PSD group markers as parent bones; defaults to true."),
	layerIndices: z.array(z.number().int().min(0)).max(128).optional().describe("Optional unique pixel-layer index filter."),
};

export function registerSpriteTools(server: McpServer): void {
	server.registerTool(
		"list_sprite_skins",
		{
			title: "List Weighted 2D Sprite Skins",
			description:
				"List every first-class weighted planar sprite mesh with its Babylon skeleton, versioned rig definition, exact revision/fingerprint lease, topology counts, PSD provenance, and editable AnimationGroups.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_sprite_skins", args)
	);
	server.registerTool(
		"get_sprite_skin",
		{
			title: "Get Weighted 2D Sprite Skin",
			description:
				"Inspect one weighted sprite mesh, complete parent-local bone hierarchy, normalized deformation topology, backing skeleton, PSD provenance, editable clips, and the exact revision plus SHA-256 fingerprint required by rig mutations.",
			inputSchema: spriteSkinIdentity,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_sprite_skin", args)
	);
	server.registerTool(
		"open_sprite_skinning_workspace",
		{
			title: "Open 2D Animation Workspace",
			description: "Open the editor's focused 2D Animation workspace and optionally select one weighted sprite mesh for visible hand authoring.",
			inputSchema: z.object(spriteSkinIdentityFields).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_sprite_skinning_workspace", args)
	);
	server.registerTool(
		"create_sprite_skin",
		{
			title: "Create Weighted 2D Sprite Skin",
			description:
				"Create a hand-editable tessellated XY mesh, optional project texture material, real Babylon skeleton/bones, normalized automatic skin weights, and versioned sprite-rig metadata. The result saves, exports, deforms, paints, and animates through the normal editor/runtime paths.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256).optional(),
					sourcePath: z.string().min(1).max(1024).optional().describe("Optional project-contained PNG/JPEG/WebP texture path."),
					...spriteSkinGeometryFields,
					bones: z.array(spriteSkinBone).min(1).max(128).optional().describe("Complete parented bind-pose hierarchy; omit for one centered Root bone."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_skin", args)
	);
	server.registerTool(
		"replace_sprite_skin_bones",
		{
			title: "Replace 2D Sprite Bone Hierarchy",
			description:
				"Replace one sprite skin's complete unique acyclic bone hierarchy under an exact revision/fingerprint lease, rebuild Babylon bind matrices, and deterministically regenerate normalized automatic weights. Use get/paint/optimize/mirror_mesh_skin_weights for fine bone painting afterwards.",
			inputSchema: z
				.object({
					...spriteSkinIdentityFields,
					expectedRevision: z.number().int().min(1),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					bones: z.array(spriteSkinBone).min(1).max(128),
				})
				.strict()
				.refine((value) => Boolean(value.nodeId) !== Boolean(value.nodeName), { message: "Provide exactly one of nodeId or nodeName." }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("replace_sprite_skin_bones", args)
	);
	server.registerTool(
		"inspect_psd_sprite_skin_rig",
		{
			title: "Inspect PSD To 2D Bone Rig",
			description:
				"Read a bounded project PSD/PSB and deterministically plan Root, optional group, and eligible pixel-layer bones from document-space bounds. Returns exclusions, warnings, source SHA-256, and an exact plan fingerprint without changing the scene or files.",
			inputSchema: z
				.object(psdSpriteRigFields)
				.strict()
				.refine((value) => !value.layerIndices || new Set(value.layerIndices).size === value.layerIndices.length, { message: "layerIndices must be unique." }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_psd_sprite_skin_rig", args)
	);
	server.registerTool(
		"apply_psd_sprite_skin_rig",
		{
			title: "Build PSD 2D Bone Rig",
			description:
				"Reinspect a PSD/PSB and create its exact leased hierarchical bone plan as a real weighted sprite mesh and Babylon skeleton. An optional extracted/merged PNG supplies the visible material; PSD provenance remains attached to the authored rig.",
			inputSchema: z
				.object({
					...psdSpriteRigFields,
					name: z.string().min(1).max(256).optional(),
					texturePath: z.string().min(1).max(1024).optional().describe("Optional project-contained extracted/merged PNG/JPEG/WebP path."),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				})
				.strict()
				.refine((value) => !value.layerIndices || new Set(value.layerIndices).size === value.layerIndices.length, { message: "layerIndices must be unique." }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_psd_sprite_skin_rig", args)
	);
	server.registerTool(
		"create_sprite_skin_animation_clip",
		{
			title: "Create 2D Bone Animation Clip",
			description:
				"Create an ordinary editable AnimationGroup from bounded planar bone position [x,y] and rotation-degree tracks under the sprite rig's exact lease, then open it in the full Dope Sheet/Curve Animation Window.",
			inputSchema: z
				.object({
					...spriteSkinIdentityFields,
					expectedRevision: z.number().int().min(1),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					name: z.string().min(1).max(256),
					framesPerSecond: z.number().finite().min(1).max(240).optional(),
					tracks: z
						.array(
							z
								.object({
									boneName: z.string().min(1).max(128),
									property: z.enum(["position", "rotation"]),
									keys: z
										.array(
											z
												.object({
													frame: z.number().finite().min(-1_000_000).max(1_000_000),
													value: z.union([z.number().finite(), z.tuple([z.number().finite(), z.number().finite()])]),
												})
												.strict()
										)
										.min(1)
										.max(4096),
								})
								.strict()
								.superRefine((track, context) => {
									for (const [index, key] of track.keys.entries()) {
										if ((track.property === "position") !== Array.isArray(key.value)) {
											context.addIssue({
												code: "custom",
												path: ["keys", index, "value"],
												message: `${track.property} keys require ${track.property === "position" ? "[x,y]" : "degree-number"} values.`,
											});
										}
										if (index > 0 && key.frame <= track.keys[index - 1].frame) {
											context.addIssue({ code: "custom", path: ["keys", index, "frame"], message: "Key frames must be strictly increasing." });
										}
									}
								})
						)
						.min(1)
						.max(256),
				})
				.strict()
				.refine((value) => Boolean(value.nodeId) !== Boolean(value.nodeName), { message: "Provide exactly one of nodeId or nodeName." }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_skin_animation_clip", args)
	);
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
	const tileLayout = z.enum(["rectangular", "isometric", "hexagonal-point-top", "hexagonal-flat-top"]);
	const tileTransform = z.object({ quarterTurns: z.number().int().min(0).max(3).optional(), flipX: z.boolean().optional(), flipY: z.boolean().optional() }).strict();
	const paletteCell = z
		.object({
			position: z.tuple([z.number().int().min(-1024).max(1024), z.number().int().min(-1024).max(1024)]),
			tileIndex: z.number().int().nonnegative(),
			transform: tileTransform.optional(),
		})
		.strict();
	const brushPrimitive = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
	const brushData = z
		.record(z.string().min(1).max(128), z.union([brushPrimitive, z.array(brushPrimitive).max(256)]))
		.refine((value) => Object.keys(value).length <= 128, "GridBrush data supports at most 128 top-level fields.");
	const gridBrush = z
		.object({
			type: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/),
			dataVersion: z.number().int().min(1).max(100000).optional(),
			data: brushData.optional(),
			transform: tileTransform.optional(),
		})
		.strict();
	const exactPaletteReference = z
		.object({ ...paletteReference })
		.strict()
		.refine((value) => Boolean(value.paletteId) !== Boolean(value.paletteName), { message: "Provide exactly one of paletteId or paletteName." });
	server.registerTool(
		"list_tile_palettes",
		{
			title: "List tile palettes",
			description: "List reusable Sprite Map tile-palette assets persisted with the scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_tile_palettes", {})
	);
	server.registerTool(
		"get_tile_palette",
		{
			title: "Get tile palette",
			description: "Read one version-2 Tile Palette's exact revision, layout, ordered editable cells, atlas membership, active tile, and GridBrush configuration.",
			inputSchema: exactPaletteReference,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_tile_palette", args)
	);
	server.registerTool(
		"get_tile_grid_configuration",
		{
			title: "Get tile grid configuration",
			description: "Read a Sprite Map's exact layout revision and rectangular, isometric, or hexagonal projection used by rendering and picking.",
			inputSchema: z.object(mapIdentity).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_tile_grid_configuration", args)
	);
	server.registerTool(
		"set_tile_grid_configuration",
		{
			title: "Set tile grid configuration",
			description: "Reproject one Sprite Map to rectangular, isometric, point-top hexagonal, or flat-top hexagonal layout under an exact grid revision lease.",
			inputSchema: z
				.object({
					...mapIdentity,
					expectedRevision: z.number().int().nonnegative(),
					layout: tileLayout.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_tile_grid_configuration", args)
	);
	server.registerTool(
		"list_grid_brush_types",
		{
			title: "List GridBrush types",
			description: "List built-in and currently loaded project-script GridBrush registrations with stable ids, versions, descriptions, and default JSON data.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_grid_brush_types", {})
	);
	server.registerTool(
		"create_tile_palette",
		{
			title: "Create tile palette",
			description: "Create a reusable brush palette from atlas tile indexes for a Sprite Map.",
			inputSchema: z
				.object({
					...mapIdentity,
					name: z.string().min(1).max(128),
					tileIndexes: z.array(z.number().int().nonnegative()).min(1).max(4096),
					activeTileIndex: z.number().int().nonnegative().optional(),
					layout: tileLayout.optional(),
					cells: z.array(paletteCell).max(4096).optional(),
					brush: gridBrush.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_tile_palette", args)
	);
	server.registerTool(
		"set_tile_palette",
		{
			title: "Set tile palette",
			description: "Change a palette name, membership, or active paint-brush tile.",
			inputSchema: z
				.object({
					...paletteReference,
					expectedRevision: z.number().int().nonnegative(),
					name: z.string().min(1).max(128).optional(),
					tileIndexes: z.array(z.number().int().nonnegative()).min(1).max(4096).optional(),
					activeTileIndex: z.number().int().nonnegative().optional(),
					layout: tileLayout.optional(),
					cells: z.array(paletteCell).max(4096).optional(),
					brush: gridBrush.optional(),
				})
				.strict()
				.refine((value) => Boolean(value.paletteId) !== Boolean(value.paletteName), { message: "Provide exactly one of paletteId or paletteName." }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_tile_palette", args)
	);
	server.registerTool(
		"paint_tile_palette",
		{
			title: "Paint tile palette",
			description: "Paint or erase a rectangular grid brush stroke with a persisted palette. Coordinates are Sprite Map grid cells.",
			inputSchema: z
				.object({
					...paletteReference,
					mapNodeId: z.string().optional(),
					position: z.array(z.number().int()).length(2),
					width: z.number().int().min(1).max(32).optional(),
					height: z.number().int().min(1).max(32).optional(),
					layer: z.number().int().min(0).max(7).optional(),
					tileIndex: z.number().int().nonnegative().optional(),
					mode: z.enum(["paint", "erase"]).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_tile_palette", args)
	);
	const tilePaintBrushSize = z
		.tuple([z.number().int().min(1).max(32), z.number().int().min(1).max(32)])
		.describe("Brush width and height in grid cells; each value is 1 through 32.");
	const tilePaintCell = z.tuple([z.number().int(), z.number().int()]).describe("Top-left-origin Sprite Map grid coordinate [x, y].");
	server.registerTool(
		"get_tile_paint_viewport",
		{
			title: "Get Tile Paint viewport",
			description:
				"Read the Unity-style scene-view Tile Paint tool, exact tool and Sprite Map revisions, selected map/palette, paint or erase mode, layer, brush size, grid bounds, and latest bounded stroke evidence.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_tile_paint_viewport", {})
	);
	server.registerTool(
		"set_tile_paint_viewport",
		{
			title: "Set Tile Paint viewport",
			description:
				"Enable, retarget, configure, or disable the shared scene-view Tile Paint tool under its exact revision lease. Enabling requires a Sprite Map id and one of that map's persisted palette ids. Returns the new revision and grid evidence.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().nonnegative().describe("Exact revision returned by get_tile_paint_viewport."),
					enabled: z.boolean().optional().describe("Enable or disable scene-view painting."),
					mapNodeId: z
						.string()
						.min(1)
						.nullable()
						.optional()
						.describe("Target Sprite Map node id, or null to clear it while disabled. Required when enabling an unconfigured tool."),
					paletteId: z.string().min(1).nullable().optional().describe("Persisted palette id owned by the target Sprite Map, or null to clear it while disabled."),
					mode: z.enum(["paint", "erase", "fill", "pick", "select"]).optional().describe("Default scene-view operation."),
					target: z.enum(["map", "palette"]).optional().describe("Edit Sprite Map cells or the palette asset's own editable cell canvas."),
					layer: z.number().int().min(0).max(7).optional().describe("Sprite Map layer to edit."),
					brushSize: tilePaintBrushSize.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_tile_paint_viewport", args)
	);
	server.registerTool(
		"apply_tile_paint_viewport_stroke",
		{
			title: "Apply Tile Paint viewport stroke",
			description:
				"Apply one atomic bounded scene-view-equivalent Tile Paint stroke using one position or a drag path of up to 256 anchors and at most 1,024 unique affected cells. Requires exact tool and map revisions; validates stage/layer/palette bounds and returns every affected cell plus rule-tile changes.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().nonnegative().describe("Exact Tile Paint tool revision returned by get_tile_paint_viewport."),
					expectedMapRevision: z.number().int().nonnegative().describe("Exact Sprite Map tile revision returned by get_tile_paint_viewport."),
					position: tilePaintCell.optional().describe("One brush anchor. Provide this or anchors, not both."),
					anchors: z.array(tilePaintCell).min(1).max(256).optional().describe("Ordered drag-path anchors. Duplicate/overlapping affected cells are coalesced."),
					mode: z.enum(["paint", "erase"]).optional().describe("Override the configured mode for this stroke."),
					layer: z.number().int().min(0).max(7).optional().describe("Override the configured target layer."),
					brushSize: tilePaintBrushSize.optional().describe("Override the configured brush size for this stroke."),
					tileIndex: z.number().int().nonnegative().optional().describe("Override atlas tile; it must belong to the configured palette when painting."),
				})
				.strict()
				.superRefine((value, context) => {
					if (Boolean(value.position) === Boolean(value.anchors)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of position or anchors." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_tile_paint_viewport_stroke", args)
	);
	server.registerTool(
		"apply_tile_palette_operation",
		{
			title: "Apply Tile Palette operation",
			description:
				"Apply one bounded exact-leased map or palette operation: paint, erase, flood fill, picker, rectangular selection, selection move/rotate/flip, or a registered project GridBrush. Returns affected cells, updated revisions, picker/selection evidence, and mutation flags.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().nonnegative(),
					expectedMapRevision: z.number().int().nonnegative(),
					expectedPaletteRevision: z.number().int().nonnegative(),
					operation: z.enum(["paint", "erase", "fill", "pick", "select", "custom", "move", "rotate", "flip-x", "flip-y"]),
					target: z.enum(["map", "palette"]).optional(),
					position: tilePaintCell.optional(),
					endPosition: tilePaintCell.optional().describe("Inclusive opposite corner for select."),
					offset: tilePaintCell.optional().describe("Integer selection translation for move."),
					quarterTurns: z.number().int().min(1).max(3).optional().describe("Clockwise quarter turns for rotate; defaults to one."),
					layer: z.number().int().min(0).max(7).optional(),
					tileIndex: z.number().int().nonnegative().optional(),
					brushSize: tilePaintBrushSize.optional(),
					brushType: z
						.string()
						.regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/)
						.optional(),
					brushData: brushData.optional(),
					transform: tileTransform.optional(),
					maxCells: z.number().int().min(1).max(4096).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (["paint", "erase", "fill", "pick", "select", "custom"].includes(value.operation) && !value.position) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: `${value.operation} requires position.` });
					}
					if (value.operation === "move" && !value.offset) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "move requires offset." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_tile_palette_operation", args)
	);
	server.registerTool(
		"delete_tile_palette",
		{
			title: "Delete tile palette",
			description: "Delete an exact Tile Palette revision without removing its painted Sprite Map cells.",
			inputSchema: z
				.object({ ...paletteReference, expectedRevision: z.number().int().nonnegative() })
				.strict()
				.refine((value) => Boolean(value.paletteId) !== Boolean(value.paletteName), { message: "Provide exactly one of paletteId or paletteName." }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
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
			title: "Get Tilemap Collider 2D",
			description:
				"Read one Sprite Map's complete Unity-style Tilemap Collider 2D configuration, exact configuration/geometry/map revisions, pending tile-change count, stable generated node ids, and last full/incremental box/polygon/edge/Delaunay evidence.",
			inputSchema: z.object(mapIdentity).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_tile_collider_generator", args)
	);
	server.registerTool(
		"generate_tile_colliders",
		{
			title: "Create or replace Tilemap Collider 2D",
			description:
				"Create the first or exact-revision replace an existing Unity-style Tilemap Collider 2D configuration and generate deterministic static bodies. Supports per-frame None/Grid/Sprite compound shapes, occupancy composite operations, polygon or outline geometry, bounded Delaunay edge legalization, manual/synchronous updates, materials, triggers/effectors, filters, and complete layer overrides. Omit expectedRevision only when no configuration exists; otherwise read and pass the current revision.",
			inputSchema: z
				.object({
					...mapIdentity,
					expectedRevision: z.number().int().min(1).optional(),
					tileIndexes: z
						.array(z.number().int().min(0).max(1_000_000))
						.min(1)
						.max(4096)
						.optional()
						.describe("Optional unique atlas frames to collide; omit for all painted cells."),
					layer: z.number().int().min(0).max(255).optional(),
					merge: z.boolean().optional().describe("Deprecated compatibility alias: false selects compositeOperation=none; otherwise merge is the default."),
					...optionalTileColliderSettingsShape,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_tile_colliders", args)
	);
	server.registerTool(
		"set_tile_collider_generator",
		{
			title: "Set Tilemap Collider 2D",
			description:
				"Exact-revision update selected Tilemap Collider 2D settings. Synchronous configurations atomically rebuild geometry; manual configurations retain current bodies and report pending state until refresh_tile_colliders is called. Read get_tile_collider_generator after every mutation and retry stale writes with the returned revision.",
			inputSchema: z
				.object({
					...mapIdentity,
					expectedRevision: z.number().int().min(1),
					update: z
						.object({
							tileIndexes: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(4096).nullable().optional(),
							layer: z.number().int().min(0).max(255).nullable().optional(),
							...optionalTileColliderSettingsShape,
						})
						.strict(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_tile_collider_generator", args)
	);
	server.registerTool(
		"clear_tile_collider_generator",
		{
			title: "Clear Tilemap Collider 2D",
			description:
				"Exact-revision remove the Tilemap Collider 2D configuration, every owned generated helper node, and every generated 2D physics body without changing painted Sprite Map cells.",
			inputSchema: z.object({ ...mapIdentity, expectedRevision: z.number().int().min(1) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_tile_collider_generator", args)
	);
	server.registerTool(
		"refresh_tile_colliders",
		{
			title: "Generate Tilemap Collider 2D geometry",
			description:
				"Exact-revision generate current Tilemap Collider 2D geometry after manual tile changes or explicitly rebuild synchronous geometry. By default it performs stable-node incremental reuse while the changed-cell count stays within Max Tile Change Count; forceFull replaces every owned body.",
			inputSchema: z.object({ ...mapIdentity, expectedRevision: z.number().int().min(1), forceFull: z.boolean().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_tile_colliders", args)
	);
}

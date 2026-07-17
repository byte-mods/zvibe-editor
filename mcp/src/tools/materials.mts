import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerMaterialTools(server: McpServer): void {
	server.registerTool(
		"list_materials",
		{
			title: "List materials",
			description: "List all materials in the scene/project (including `.material` assets). Use the returned `id` with `set_mesh_material` or `set_material_properties`.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_materials", args)
	);

	server.registerTool(
		"list_material_types",
		{
			title: "List material types",
			description:
				"List every material type the editor can create — including the Babylon.js Materials Library (sky, grid, normal, water, lava, triplanar, cell, fire, gradient) — with each type's purpose and its KEY controllable properties. " +
				"Call this to discover what's available before `create_material`, and to learn which properties to pass to `set_material_properties` (e.g. a SkyMaterial's `inclination`/`azimuth`/`luminance`/`turbidity`). " +
				"Use these specialized materials for authored, hand-editable effects (procedural sky, water, lava, toon shading, reference grid) instead of faking them in code.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_material_types", args)
	);

	server.registerTool(
		"create_material",
		{
			title: "Create material",
			description:
				"Create a new material and persist it as a `.material` asset so it appears in the editor's assets browser. " +
				"Prefer `pbr` for realistic surfaces and `standard` for simple ones. The Materials Library types are for authored special effects: " +
				"`sky` (procedural sky on a skybox), `water` (lakes/oceans), `lava`, `fire`, `cell` (toon shading), `grid` (blueprint floor), `gradient`, `triplanar` (texturing meshes without UVs), `terrain` (three diffuse layers blended by an RGB splat map), `normal`. " +
				"Call `list_material_types` first to see each type's key properties. Returns `{ id, name, path }`; assign it with `set_mesh_material` and tune it with `set_material_properties` " +
				"(e.g. a sunset sky: create a `sky` material on a `skybox` mesh, then set `inclination`/`azimuth`/`luminance`/`turbidity`).",
			inputSchema: z.object({
				type: z
					.enum(["pbr", "standard", "sky", "grid", "normal", "water", "lava", "triplanar", "terrain", "cell", "fire", "gradient", "node"])
					.describe("The material type to create."),
				name: z.string().optional().describe("Name for the new material."),
				folder: z.string().optional().describe("Project-relative folder to store the `.material` asset in. Defaults to the assets root."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_material", args)
	);

	server.registerTool(
		"list_material_presets",
		{
			title: "List material presets",
			description: "List persistent scene-level material inspector presets, including the material class and captured compatible properties.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_material_presets", args)
	);

	server.registerTool(
		"create_material_preset",
		{
			title: "Create material preset",
			description: "Capture curated inspector properties from a material as a persistent reusable preset. Optional properties override or extend the captured values.",
			inputSchema: z.object({ materialId: z.string(), name: z.string().min(1), properties: z.record(z.string(), z.any()).optional() }),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_material_preset", args)
	);

	server.registerTool(
		"apply_material_preset",
		{
			title: "Apply material preset",
			description: "Apply a named material preset to a material of the same Babylon material class.",
			inputSchema: z.object({ materialId: z.string(), name: z.string().min(1) }),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_material_preset", args)
	);

	server.registerTool(
		"delete_material_preset",
		{
			title: "Delete material preset",
			description: "Delete a persistent scene-level material inspector preset.",
			inputSchema: z.object({ name: z.string().min(1) }),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_material_preset", args)
	);

	server.registerTool(
		"create_material_variant",
		{
			title: "Create material variant",
			description: "Clone a material into a separate persisted .material variant, preserving its textures and settings while applying optional overrides.",
			inputSchema: z.object({ baseMaterialId: z.string(), name: z.string(), folder: z.string().optional(), properties: z.record(z.string(), z.any()).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_material_variant", args)
	);

	server.registerTool(
		"get_material_variant",
		{
			title: "Get material variant",
			description: "Read a base-linked material variant's base material, explicitly tracked overrides, and optional persisted asset path.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_material_variant", args)
	);

	server.registerTool(
		"rebase_material_variant",
		{
			title: "Rebase material variant",
			description:
				"Refresh a base-linked variant's curated inherited material values from its base while preserving the variant's explicitly tracked overrides. The linked .material asset is updated when one was created by this editor.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebase_material_variant", args)
	);

	server.registerTool(
		"delete_material",
		{
			title: "Delete scene material",
			description:
				"Dispose a material from the scene and unassign it from meshes. Delete any persisted .material file separately with delete_asset after confirming its path.",
			inputSchema: z.object({ materialId: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_material", args)
	);

	server.registerTool(
		"set_material_properties",
		{
			title: "Set material properties",
			description:
				"Deep-set material properties by dotted path: `albedoColor`, `metallic`, `roughness`, `emissiveColor`, `alpha`, `wireframe` (PBR) or `diffuseColor`, `specularColor`, etc. (Standard). " +
				"Color values can be `[r,g,b]` arrays and are coerced to Color3. Use this to tune a skybox's colors for a sunset, make a surface metallic, etc. " +
				"Materials Library types are tuned here too, each via its own properties (so you usually do NOT need a separate `list_material_types` call); most common: " +
				"`sky` -> `inclination` (sun height / time of day), `azimuth`, `luminance`, `turbidity`; " +
				"`water` -> `waveHeight`, `waveLength`, `windForce`, `waveSpeed`, `bumpHeight`, `waterColor` (animated waves work out of the box); " +
				"`gradient` -> `topColor`, `bottomColor`, `offset`; `grid` -> `mainColor`, `lineColor`, `gridRatio`. Call `list_material_types` only when you need the full per-type list. " +
				'You can also reach nested objects — e.g. tile a ground texture with `{ "albedoTexture.uScale": 20, "albedoTexture.vScale": 20 }` (after assigning it via `assign_texture_to_material`).',
			inputSchema: z.object({
				materialId: z.string().describe("Id of the material to modify."),
				properties: z.record(z.string(), z.any()).describe("Map of dotted property path to value. `[r,g,b]` arrays are coerced to Color3."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_material_properties", args)
	);

	server.registerTool(
		"assign_texture_to_material",
		{
			title: "Assign texture to material",
			description:
				"Load a texture asset from the project and assign it to a material channel (albedoTexture, bumpTexture, metallicTexture, emissiveTexture, diffuseTexture, opacityTexture, ...). " +
				"Use `list_assets` to find available textures, or download new ones via the visible marketplace tools.",
			inputSchema: z.object({
				materialId: z.string().describe("Id of the target material."),
				channel: z
					.string()
					.describe("Material texture channel, e.g. `albedoTexture`, `bumpTexture`, `metallicTexture`, `emissiveTexture`, `diffuseTexture`, `opacityTexture`."),
				texturePath: z.string().describe("Project-relative or absolute path to the texture asset."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("assign_texture_to_material", args)
	);

	server.registerTool(
		"get_material_lightmap",
		{
			title: "Get material lightmap",
			description: "Read a PBR or Standard material's assigned pre-baked lightmap, UV set, intensity, and shadowmap mode.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_material_lightmap", args)
	);

	server.registerTool(
		"set_material_lightmap",
		{
			title: "Set material lightmap",
			description:
				"Assign or clear a pre-baked lightmap on a PBR or Standard material. Choose the UV channel (Unity lightmaps normally use UV2, index 1), intensity, and whether it acts only as a shadowmap. This consumes baked light data; it does not bake global illumination in the editor.",
			inputSchema: z.object({
				materialId: z.string(),
				texturePath: z.string().min(1).nullable().optional(),
				coordinatesIndex: z.number().int().min(0).max(5).optional(),
				level: z.number().nonnegative().optional(),
				useLightmapAsShadowmap: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_material_lightmap", args)
	);

	server.registerTool(
		"paint_terrain_layer",
		{
			title: "Paint terrain layer",
			description:
				"Paint a soft circular brush into a TerrainMaterial RGB splat map. Layer 0 is red/diffuseTexture1, layer 1 is green/diffuseTexture2, and layer 2 is blue/diffuseTexture3. The generated PNG is a project asset and is assigned to mixTexture automatically. Coordinates, radius, and strength use normalized 0..1 texture space; this is the terrain-layer painting workflow, not geometry sculpting.",
			inputSchema: z.object({
				materialId: z.string().describe("TerrainMaterial id."),
				outputPath: z.string().describe("Project-relative .png splat-map output path. Existing files are updated in place."),
				sourcePath: z.string().optional().describe("Optional project-relative PNG/image to start from. Omit to continue outputPath or create a red base layer."),
				center: z.array(z.number().min(0).max(1)).length(2).describe("Normalized splat-map brush centre [u, v]."),
				radius: z.number().positive().max(1).describe("Normalized brush radius."),
				strength: z.number().min(0).max(1).describe("Brush blend strength, from 0 to 1."),
				layer: z.number().int().min(0).max(2).describe("Terrain layer: 0 red, 1 green, or 2 blue."),
				hardness: z.number().positive().max(16).optional().describe("Brush falloff exponent; 1 is a linear soft brush."),
				width: z.number().int().min(1).max(4096).optional().describe("New splat-map width when no source image exists. Defaults to 1024."),
				height: z.number().int().min(1).max(4096).optional().describe("New splat-map height when no source image exists. Defaults to width."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_terrain_layer", args)
	);

	server.registerTool(
		"get_node_material_blackboard",
		{
			title: "Get Shader Graph blackboard",
			description: "Read persistent Shader Graph-style parameters bound to Node Material input blocks.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_material_blackboard", args)
	);
	server.registerTool(
		"set_node_material_blackboard",
		{
			title: "Set Shader Graph blackboard",
			description: "Replace persistent Shader Graph-style parameters, each bound to an existing Node Material input block. Read the graph first to discover block names.",
			inputSchema: z.object({
				materialId: z.string(),
				parameters: z.array(
					z.object({
						name: z.string().min(1),
						inputName: z.string().min(1),
						label: z.string().optional(),
						min: z.number().optional(),
						max: z.number().optional(),
						defaultValue: z.any().optional(),
					})
				),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_material_blackboard", args)
	);
	server.registerTool(
		"set_node_material_blackboard_values",
		{
			title: "Set Shader Graph blackboard values",
			description: "Set Node Material input values through their persistent Shader Graph blackboard parameter names.",
			inputSchema: z.object({ materialId: z.string(), values: z.array(z.object({ name: z.string().min(1), value: z.any() })).min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_material_blackboard_values", args)
	);
	server.registerTool(
		"list_node_material_variants",
		{
			title: "List Shader Graph variants",
			description: "List named reusable blackboard-value variants for a Node Material.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_node_material_variants", args)
	);
	server.registerTool(
		"set_node_material_variant",
		{
			title: "Set Shader Graph variant",
			description: "Create or replace a named Shader Graph variant containing values for existing blackboard parameters.",
			inputSchema: z.object({ materialId: z.string(), name: z.string().min(1), values: z.array(z.object({ name: z.string().min(1), value: z.any() })).min(1) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_material_variant", args)
	);
	server.registerTool(
		"apply_node_material_variant",
		{
			title: "Apply Shader Graph variant",
			description: "Apply one named Shader Graph variant through its blackboard bindings.",
			inputSchema: z.object({ materialId: z.string(), name: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_node_material_variant", args)
	);
	server.registerTool(
		"delete_node_material_variant",
		{
			title: "Delete Shader Graph variant",
			description: "Delete a named Shader Graph variant without changing the graph.",
			inputSchema: z.object({ materialId: z.string(), name: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_node_material_variant", args)
	);
	server.registerTool(
		"get_node_material_graph",
		{
			title: "Get Node Material graph",
			description: "Read a Node Material's complete serialized Node Material Editor graph, plus inspector-visible input blocks and texture blocks.",
			inputSchema: z.object({ materialId: z.string().describe("Id of the Node Material.") }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_material_graph", args)
	);
	server.registerTool(
		"list_node_material_custom_blocks",
		{
			title: "List Shader Graph custom code blocks",
			description: "List graph-native Babylon CustomBlocks and their serialized GLSL source, parameters, and shader stage.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_node_material_custom_blocks", args)
	);
	server.registerTool(
		"add_node_material_custom_block",
		{
			title: "Add Shader Graph custom code block",
			description:
				"Add a serialized Babylon CustomBlock with trusted GLSL source to a Node Material graph. The block is immediately available in the Node Material Editor; wire its inputs/outputs to the graph there or through a serialized graph edit before building. Function signature, code, and parameter names/types must agree.",
			inputSchema: z.object({
				materialId: z.string(),
				name: z
					.string()
					.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
					.describe("Unique GLSL-safe block name."),
				target: z.enum(["Vertex", "Fragment", "VertexAndFragment"]).optional(),
				functionName: z.string().min(1).describe("Full GLSL function signature, e.g. `void doubleValue(float value, out float result)`."),
				code: z.string().min(1).describe("Trusted GLSL function definition."),
				inputs: z
					.array(
						z.object({
							name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
							type: z.enum(["Float", "Vector2", "Vector3", "Vector4", "Color3", "Color4", "Matrix", "sampler2D", "samplerCube", "sampler2DArray"]),
						})
					)
					.min(1),
				outputs: z
					.array(
						z.object({
							name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
							type: z.enum(["Float", "Vector2", "Vector3", "Vector4", "Color3", "Color4", "Matrix", "sampler2D", "samplerCube", "sampler2DArray"]),
						})
					)
					.min(1),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_node_material_custom_block", args)
	);
	server.registerTool(
		"delete_node_material_custom_block",
		{
			title: "Delete Shader Graph custom code block",
			description: "Remove one CustomBlock by name. Remove or rewire dependent graph connections before the next material build.",
			inputSchema: z.object({ materialId: z.string(), name: z.string().min(1) }),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_node_material_custom_block", args)
	);
	server.registerTool(
		"save_node_material_subgraph",
		{
			title: "Save Shader Graph subgraph",
			description: "Save a Node Material graph and its Shader Graph blackboard as a reusable project-local .shadergraph.json asset.",
			inputSchema: z.object({ materialId: z.string(), outputPath: z.string().describe("Project-relative .shadergraph.json path."), name: z.string().min(1).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("save_node_material_subgraph", args)
	);
	server.registerTool(
		"get_node_material_subgraph",
		{
			title: "Get Shader Graph subgraph",
			description: "Read a reusable project-local .shadergraph.json asset before applying it to a Node Material.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_material_subgraph", args)
	);
	server.registerTool(
		"apply_node_material_subgraph",
		{
			title: "Apply Shader Graph subgraph",
			description: "Replace an existing Node Material graph with a reusable project-local Shader Graph subgraph while retaining mesh assignments and material identity.",
			inputSchema: z.object({ materialId: z.string(), path: z.string(), name: z.string().min(1).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_node_material_subgraph", args)
	);

	server.registerTool(
		"validate_node_material_graph",
		{
			title: "Validate Node Material graph",
			description:
				"Build a Node Material graph without replacing it and return actionable diagnostics: compiler errors, disconnected required inputs, blocks that cannot reach an output, output nodes, and shader/block statistics. Use this after editing a graph and before export; it does not mutate serialized graph data.",
			inputSchema: z.object({ materialId: z.string().describe("Id of the Node Material to validate.") }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_node_material_graph", args)
	);
	server.registerTool(
		"strip_node_material_unused_blocks",
		{
			title: "Strip unused Shader Graph blocks",
			description:
				"Remove only Node Material blocks that cannot reach a vertex or fragment output. Returns every removed block; this does not optimize connected shader code.",
			inputSchema: z.object({ materialId: z.string() }),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("strip_node_material_unused_blocks", args)
	);

	server.registerTool(
		"set_node_material_inputs",
		{
			title: "Set Node Material inputs",
			description: "Set values for named Node Material input blocks without changing the graph. Inspect available blocks with get_node_material_graph first.",
			inputSchema: z.object({
				materialId: z.string().describe("Id of the Node Material."),
				inputs: z
					.array(z.object({ name: z.string().describe("Input block name."), value: z.any().describe("New scalar, vector/color array, or compatible value.") }))
					.min(1),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_material_inputs", args)
	);

	server.registerTool(
		"replace_node_material_graph",
		{
			title: "Replace Node Material graph",
			description:
				"Replace a Node Material's entire serialized graph. Call get_node_material_graph first, modify the returned graph deliberately, then provide it here. Meshes using the material remain assigned to the replacement.",
			inputSchema: z.object({
				materialId: z.string().describe("Id of the Node Material to replace."),
				graph: z.record(z.string(), z.any()).describe("Serialized NodeMaterial graph."),
				name: z.string().optional().describe("Optional replacement display name."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("replace_node_material_graph", args)
	);

	server.registerTool(
		"set_environment_texture",
		{
			title: "Set environment texture",
			description:
				"Set the scene's environment/skybox from a `.env`/`.hdr` cube texture asset, optionally creating a skybox. Great for establishing ambient lighting and the sky backdrop.",
			inputSchema: z.object({
				texturePath: z.string().describe("Project-relative or absolute path to the `.env`/`.hdr` cube texture."),
				createSkybox: z.boolean().optional().describe("Also create a skybox mesh using this texture."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_environment_texture", args)
	);
}

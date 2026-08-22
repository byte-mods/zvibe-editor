import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const nodeMaterialOptimizationSettingsSchema = z
	.object({
		stripUnreachable: z.boolean().optional().describe("Remove blocks without a dependency path to an output; defaults to true."),
		simplifyIdentityMath: z.boolean().optional().describe("Bypass connected add-zero, subtract-zero, multiply-zero/one, and divide-one blocks; defaults to true."),
		foldConstants: z.boolean().optional().describe("Fold connected finite scalar/vector/color constant arithmetic; defaults to true."),
		mergeDuplicateConstants: z.boolean().optional().describe("Rewire and merge byte-equivalent connected constant inputs; defaults to true."),
		minifyCustomCode: z.boolean().optional().describe("Remove comments and redundant whitespace from connected CustomBlock GLSL; defaults to true."),
	})
	.strict();

const scatteringDistanceSchema = z.tuple([z.number().min(0.001).max(1000), z.number().min(0.001).max(1000), z.number().min(0.001).max(1000)]);
const transmissionTintSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const thicknessRemapSchema = z
	.tuple([z.number().min(0).max(10000), z.number().min(0).max(10000)])
	.refine(([minimum, maximum]) => maximum >= minimum, { message: "Thickness remap maximum must be greater than or equal to its minimum." });
const diffusionProfileFieldsSchema = {
	scatteringDistance: scatteringDistanceSchema.optional().describe("Per-channel scattering distance in millimetres; each value must be 0.001–1000."),
	transmissionTint: transmissionTintSchema.optional().describe("Linear RGB transmission tint; each value must be 0–1."),
	thicknessRemap: thicknessRemapSchema.optional().describe("Minimum/maximum authored thickness in millimetres."),
	worldScale: z.number().min(0.001).max(1000).optional().describe("Profile-specific scale applied to scattering distance."),
	indexOfRefraction: z.number().min(1).max(3).optional().describe("Material volume index of refraction."),
};
const exactContentRevisionSchema = z
	.string()
	.regex(/^[0-9a-f]{64}$/)
	.describe("Exact SHA-256 content revision returned by the corresponding read tool.");
const projectShaderPathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
		"Path must be a project-relative POSIX path without traversal segments."
	);
const shaderGraphSwitchCaseSchema = z
	.object({
		label: z.string().min(1).max(64),
		match: z.number().finite(),
	})
	.strict();
const shaderGraphEnumOptionSchema = z
	.object({
		label: z.string().min(1).max(64),
		value: z.number().finite(),
	})
	.strict();

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
			description:
				"Inspect a base-linked material variant's complete nested inheritance chain, explicit overrides, inherited changes, untracked local edits, three-way conflicts, base-state hash, exact stale-operation fingerprint, and optional persisted asset path.",
			inputSchema: z.object({
				materialId: z.string().describe("Variant material id."),
				paths: z
					.array(z.string().min(1))
					.max(128)
					.optional()
					.describe("Optional exact serializable property/texture paths whose current variant and immediate-base values should be returned."),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_material_variant", args)
	);

	server.registerTool(
		"rebase_material_variant",
		{
			title: "Rebase material variant",
			description:
				"Refresh every serializable property and texture from the immediate base of a nested material variant, preserve explicit and unambiguous local overrides, and resolve exact three-way conflicts. Call get_material_variant first and pass its fingerprint to reject stale rebases. The linked .material asset is updated when present.",
			inputSchema: z.object({
				materialId: z.string().describe("Variant material id."),
				expectedFingerprint: z.string().length(64).optional().describe("Exact fingerprint returned by get_material_variant."),
				recursive: z.boolean().optional().describe("Rebase nested variant ancestors from root to leaf before this variant."),
				conflictPolicy: z.enum(["abort", "useBase", "keepVariant"]).optional().describe("Fallback for unresolved conflicts; defaults to abort."),
				resolutions: z
					.record(z.string(), z.enum(["useBase", "keepVariant"]))
					.optional()
					.describe("Per-conflict path resolutions that override conflictPolicy."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebase_material_variant", args)
	);

	server.registerTool(
		"clear_material_variant_overrides",
		{
			title: "Clear material variant overrides",
			description:
				"Remove one or more exact explicit override paths from a material variant and immediately restore those complete properties or textures from its immediate base.",
			inputSchema: z.object({
				materialId: z.string().describe("Variant material id."),
				paths: z.array(z.string().min(1)).min(1).max(128).describe("Exact paths listed in get_material_variant.overridePaths."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_material_variant_overrides", args)
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
				"Deep-set material properties by dotted path: `albedoColor`, `metallic`, `roughness`, `emissiveColor`, `emissiveIntensity`, `alpha`, `wireframe` (PBR); `diffuseColor`, `specularColor`, `emissiveColor` (Standard/PBR simple); or `emissionColor` and `emissionLuminance` (OpenPBR). The response includes every deferred-camera runtime so emission edits explicitly show whether an exact-leased rebuild is required. " +
				"Color values can be `[r,g,b]` arrays and are coerced to Color3. Use this to tune a skybox's colors for a sunset, make a surface metallic, etc. " +
				"Materials Library types are tuned here too, each via its own properties (so you usually do NOT need a separate `list_material_types` call); most common: " +
				"`sky` -> `inclination` (sun height / time of day), `azimuth`, `luminance`, `turbidity`; " +
				"`water` -> `waveHeight`, `waveLength`, `windForce`, `waveSpeed`, `bumpHeight`, `waterColor` (animated waves work out of the box); " +
				"`gradient` -> `topColor`, `bottomColor`, `offset`; `grid` -> `mainColor`, `lineColor`, `gridRatio`. Call `list_material_types` only when you need the full per-type list. " +
				'You can also reach nested objects — e.g. tile a ground texture with `{ "albedoTexture.uScale": 20, "albedoTexture.vScale": 20 }` (after assigning it via `assign_texture_to_material`).',
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256).describe("Id of the authored material to modify; runtime-only deferred adapters are excluded from list_materials."),
					properties: z
						.record(z.string().min(1).max(256), z.any())
						.refine((properties) => Object.keys(properties).length <= 256, "At most 256 material property paths may be changed per call.")
						.describe("Map of dotted property path to value. `[r,g,b]` arrays are coerced to Color3."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_material_properties", args)
	);

	server.registerTool(
		"assign_texture_to_material",
		{
			title: "Assign texture to material",
			description:
				"Load a texture asset from the project and assign it to a material channel (albedoTexture, bumpTexture, metallicTexture, emissiveTexture, emissionColorTexture, diffuseTexture, opacityTexture, ...). The response includes every deferred-camera runtime so an emissive assignment explicitly shows whether an exact-leased rebuild is required. " +
				"TGA and supported merged-composite PSD sources are validated and atomically imported to PNG first. HDR/EXR sources are decoded and re-emitted as linear format-preserving high-dynamic artifacts. Every decoded source retains its authored path for save/build runtime redirects. Use `list_assets` to find available textures, or download new ones via the visible marketplace tools.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256).describe("Id of the target material."),
					channel: z
						.string()
						.min(1)
						.max(128)
						.describe(
							"Material texture channel, e.g. `albedoTexture`, `bumpTexture`, `metallicTexture`, `emissiveTexture`, OpenPBR `emissionColorTexture`, `diffuseTexture`, or `opacityTexture`."
						),
					texturePath: z.string().min(1).max(1024).describe("Project-relative or absolute path to the texture asset."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
		"get_shader_graph_capabilities",
		{
			title: "Get Shader Graph 6.5 capabilities",
			description:
				"Read the portable Shader Graph template, multi-case Switch, static subgraph-input, float-mode, and reflected-GLSL capability envelope plus the explicit Unity compatibility boundary.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_shader_graph_capabilities", {})
	);

	server.registerTool(
		"list_shader_graph_templates",
		{
			title: "Search Shader Graph templates",
			description:
				"Search the deterministic Shader Graph template catalog, including portable Decal Projector and Fullscreen Renderer starters. Use its exact catalogRevision when creating or applying a template.",
			inputSchema: z
				.object({
					query: z.string().max(256).optional(),
					category: z.enum(["Surface", "Rendering", "Procedural"]).optional(),
					offset: z.number().int().min(0).max(10000).optional(),
					limit: z.number().int().min(1).max(50).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_shader_graph_templates", args)
	);

	server.registerTool(
		"create_shader_graph_from_template",
		{
			title: "Create Shader Graph from template",
			description:
				"Create a real persisted Babylon Node Material from one searched Shader Graph template under the exact template-catalog revision. The new .material asset is selected in the normal editor Inspector.",
			inputSchema: z
				.object({
					templateId: z.string().min(1).max(128),
					expectedCatalogRevision: exactContentRevisionSchema,
					name: z.string().min(1).max(128).optional(),
					folder: projectShaderPathSchema.optional().describe("Project-relative output folder; defaults to assets."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_shader_graph_from_template", args)
	);

	server.registerTool(
		"apply_shader_graph_template",
		{
			title: "Apply Shader Graph template",
			description:
				"Replace one Node Material graph with a searched template while retaining material identity and mesh assignments. Requires exact graph/catalog revisions and explicit destructive confirmation.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					templateId: z.string().min(1).max(128),
					expectedCatalogRevision: exactContentRevisionSchema,
					expectedGraphRevision: exactContentRevisionSchema,
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_shader_graph_template", args)
	);

	server.registerTool(
		"get_shader_graph_extensions",
		{
			title: "Get Shader Graph extensions",
			description:
				"Read a Node Material's exact graph revision, originating template, multi-case Switch nodes, and reflected GLSL function blocks before making a stale-safe change.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_shader_graph_extensions", args)
	);

	server.registerTool(
		"open_shader_graph_inspector",
		{
			title: "Open Shader Graph Inspector",
			description:
				"Select one Node Material in the normal editor Inspector so its searchable Shader Graph 6.5 templates, visual port graph, Switch/reflection evidence, and float-mode blackboard controls are visible.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_shader_graph_inspector", args)
	);

	server.registerTool(
		"set_shader_graph_switch",
		{
			title: "Set multi-case Shader Graph Switch",
			description:
				"Create or update a real graph-native multi-case float/enum Switch CustomBlock under the exact graph revision. Updates preserve connections and therefore cannot change an existing Switch's port count or value type.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					expectedGraphRevision: exactContentRevisionSchema,
					switchId: z.string().uuid().optional().describe("Existing Switch id from get_shader_graph_extensions; omit to create."),
					name: z
						.string()
						.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
						.max(128),
					mode: z.enum(["float", "enum"]),
					valueType: z.enum(["Float", "Vector2", "Vector3", "Vector4", "Color3", "Color4", "Matrix"]),
					target: z.enum(["Vertex", "Fragment", "VertexAndFragment"]).optional(),
					cases: z.array(shaderGraphSwitchCaseSchema).min(2).max(16),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_shader_graph_switch", args)
	);

	server.registerTool(
		"delete_shader_graph_switch",
		{
			title: "Delete Shader Graph Switch",
			description: "Disconnect and delete one multi-case Switch node under the exact graph revision returned by get_shader_graph_extensions.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					switchId: z.string().uuid(),
					expectedGraphRevision: exactContentRevisionSchema,
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_shader_graph_switch", args)
	);

	server.registerTool(
		"inspect_shader_graph_reflected_function",
		{
			title: "Inspect reflected Shader Graph function",
			description:
				"Parse one dependency-free function from a bounded, non-symlink, project-contained GLSL source and return its typed ports plus exact source revision without changing the graph.",
			inputSchema: z
				.object({
					sourcePath: projectShaderPathSchema.describe("Project-relative .glsl, .fx, .frag, or .vert path."),
					functionName: z
						.string()
						.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
						.max(128),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_shader_graph_reflected_function", args)
	);

	server.registerTool(
		"add_shader_graph_reflected_function",
		{
			title: "Add reflected Shader Graph function",
			description:
				"Add one inspected GLSL function as a serialized graph-native CustomBlock under exact source and graph revisions. Supports in/out value ports and function return values; inout is deliberately rejected.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					expectedGraphRevision: exactContentRevisionSchema,
					sourcePath: projectShaderPathSchema,
					expectedSourceRevision: exactContentRevisionSchema,
					functionName: z
						.string()
						.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
						.max(128),
					blockName: z.string().min(1).max(128).optional(),
					target: z.enum(["Vertex", "Fragment", "VertexAndFragment"]).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_shader_graph_reflected_function", args)
	);

	server.registerTool(
		"set_shader_graph_subgraph_input",
		{
			title: "Set Shader Graph subgraph input",
			description:
				"Update one reusable .shadergraph.json input's connector visibility, static compile value, float UX mode, enum options, and description under the asset's exact revision. Legacy v1 assets migrate to v2 atomically.",
			inputSchema: z
				.object({
					path: projectShaderPathSchema.describe("Project-relative .shadergraph.json path."),
					expectedRevision: exactContentRevisionSchema,
					parameterName: z.string().min(1).max(128),
					connectorEnabled: z.boolean(),
					floatMode: z.enum(["default", "slider", "integer", "enum"]),
					staticValue: z.any().optional(),
					enumOptions: z.array(shaderGraphEnumOptionSchema).min(1).max(32).optional(),
					description: z.string().max(512).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.floatMode === "enum" && !value.enumOptions?.length) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["enumOptions"], message: "Enum float mode requires enumOptions." });
					}
				}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_shader_graph_subgraph_input", args)
	);

	server.registerTool(
		"get_node_material_blackboard",
		{
			title: "Get Shader Graph blackboard",
			description: "Read persistent Shader Graph-style parameters bound to Node Material input blocks.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_material_blackboard", args)
	);
	server.registerTool(
		"set_node_material_blackboard",
		{
			title: "Set Shader Graph blackboard",
			description: "Replace persistent Shader Graph-style parameters, each bound to an existing Node Material input block. Read the graph first to discover block names.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					parameters: z
						.array(
							z
								.object({
									name: z.string().min(1),
									inputName: z.string().min(1),
									label: z.string().optional(),
									min: z.number().optional(),
									max: z.number().optional(),
									defaultValue: z.any().optional(),
									connectorEnabled: z.boolean().optional().describe("False removes the reusable-subgraph connector and compiles staticValue/defaultValue."),
									floatMode: z.enum(["default", "slider", "integer", "enum"]).optional(),
									enumOptions: z.array(shaderGraphEnumOptionSchema).min(1).max(32).optional(),
									staticValue: z.any().optional(),
									description: z.string().max(512).optional(),
								})
								.strict()
						)
						.max(128),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_material_blackboard", args)
	);
	server.registerTool(
		"set_node_material_blackboard_values",
		{
			title: "Set Shader Graph blackboard values",
			description: "Set Node Material input values through their persistent Shader Graph blackboard parameter names.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					values: z
						.array(z.object({ name: z.string().min(1).max(128), value: z.any() }).strict())
						.min(1)
						.max(128),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
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
		"set_node_material_custom_block",
		{
			title: "Update Shader Graph custom code block",
			description:
				"Update trusted GLSL, function signature, and/or shader stage on one graph-native CustomBlock while atomically preserving all compatible input/output wiring. Select the block by numeric id from get_node_material_code_graph when names are ambiguous.",
			inputSchema: z
				.object({
					materialId: z.string().describe("Node Material id."),
					blockId: z.number().int().positive().optional().describe("Exact numeric block id."),
					name: z.string().min(1).optional().describe("Exact block name; use blockId when duplicate names exist."),
					functionName: z.string().min(1).max(4096).optional().describe("Complete GLSL function signature."),
					code: z.string().min(1).max(65536).optional().describe("Trusted GLSL function definition."),
					target: z.enum(["Vertex", "Fragment", "VertexAndFragment"]).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_material_custom_block", args)
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
		"get_node_material_code_graph",
		{
			title: "Get visual Shader Graph code graph",
			description:
				"Return a bounded paginated port graph for the Node Material Inspector canvas: block ids/names/classes/stages, typed input/output ports, reachability, CustomBlock metadata, and edges. Code is summarized by size unless includeCode=true.",
			inputSchema: z
				.object({
					materialId: z.string().describe("Node Material id."),
					query: z.string().max(256).optional().describe("Optional case-insensitive block name/class filter."),
					offset: z.number().int().min(0).optional().describe("Zero-based block offset; defaults to 0."),
					limit: z.number().int().min(1).max(256).optional().describe("Maximum blocks; defaults to 64."),
					includeCode: z.boolean().optional().describe("Include complete trusted CustomBlock GLSL instead of only its character count."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_material_code_graph", args)
	);
	server.registerTool(
		"connect_node_material_blocks",
		{
			title: "Connect Shader Graph blocks",
			description:
				"Connect one exact source output to one exact target input with port-type, occupancy, and dependency-cycle validation. Use numeric block ids from get_node_material_code_graph; replace=true atomically replaces an occupied target input.",
			inputSchema: z
				.object({
					materialId: z.string(),
					sourceBlockId: z.number().int().positive().optional(),
					sourceBlockName: z.string().min(1).optional(),
					sourceOutput: z.string().min(1),
					targetBlockId: z.number().int().positive().optional(),
					targetBlockName: z.string().min(1).optional(),
					targetInput: z.string().min(1),
					replace: z.boolean().optional().describe("Replace an occupied target input atomically; defaults to false."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("connect_node_material_blocks", args)
	);
	server.registerTool(
		"disconnect_node_material_blocks",
		{
			title: "Disconnect Shader Graph blocks",
			description:
				"Disconnect the current source from one exact target input. Optional source id/name/output fields act as stale guards so a changed edge is not removed accidentally.",
			inputSchema: z
				.object({
					materialId: z.string(),
					targetBlockId: z.number().int().positive().optional(),
					targetBlockName: z.string().min(1).optional(),
					targetInput: z.string().min(1),
					sourceBlockId: z.number().int().positive().optional(),
					sourceBlockName: z.string().min(1).optional(),
					sourceOutput: z.string().min(1).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("disconnect_node_material_blocks", args)
	);
	server.registerTool(
		"inspect_node_material_optimization",
		{
			title: "Inspect Shader Graph optimization",
			description:
				"Build the current Node Material and an isolated optimized clone, then return an exact SHA-256 lease, planned actions, before/after block and shader-size evidence, and compile diagnostics without changing the active material.",
			inputSchema: z.object({ materialId: z.string(), settings: nodeMaterialOptimizationSettingsSchema.optional() }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_node_material_optimization", args)
	);
	server.registerTool(
		"optimize_node_material_graph",
		{
			title: "Optimize Shader Graph",
			description:
				"Reproduce an exact inspected optimization lease on an isolated clone, compile it, and atomically replace the active material only when valid. Performs unreachable stripping, identity simplification, finite constant folding, duplicate-constant merging, and connected CustomBlock GLSL minification.",
			inputSchema: z
				.object({
					materialId: z.string(),
					expectedFingerprint: z.string().length(64).describe("Exact fingerprint from inspect_node_material_optimization using identical settings."),
					settings: nodeMaterialOptimizationSettingsSchema.optional(),
					confirm: z.literal(true).describe("Explicit confirmation after reviewing the inspected actions."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("optimize_node_material_graph", args)
	);
	server.registerTool(
		"save_node_material_subgraph",
		{
			title: "Save Shader Graph subgraph",
			description: "Save a Node Material graph and its Shader Graph blackboard as a reusable project-local .shadergraph.json asset.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					outputPath: projectShaderPathSchema.describe("Project-relative .shadergraph.json path."),
					name: z.string().min(1).max(128).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_node_material_subgraph", args)
	);
	server.registerTool(
		"get_node_material_subgraph",
		{
			title: "Get Shader Graph subgraph",
			description: "Read a reusable project-local .shadergraph.json asset before applying it to a Node Material.",
			inputSchema: z.object({ path: projectShaderPathSchema }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_material_subgraph", args)
	);
	server.registerTool(
		"apply_node_material_subgraph",
		{
			title: "Apply Shader Graph subgraph",
			description: "Replace an existing Node Material graph with a reusable project-local Shader Graph subgraph while retaining mesh assignments and material identity.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256), path: projectShaderPathSchema, name: z.string().min(1).max(128).optional() }).strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
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
		"get_environment_lighting",
		{
			title: "Get Environment Lighting",
			description:
				"Read the scene's exact SHA-256 environment-lighting lease, IBL intensity, cube/HDR texture source and readiness, tool-owned skyboxes, plus per-camera deferred environment-IBL execution evidence. Call this before set_environment_texture.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_environment_lighting", {})
	);

	server.registerTool(
		"set_environment_texture",
		{
			title: "Set Environment Lighting",
			description:
				"Under the exact lease from get_environment_lighting, assign, tune, or clear the scene environment and tool-owned skybox. `.env` loads prefiltered data; `.hdr`/`.exr` use the shared Texture Importer high-dynamic artifact. texturePath:null clears the environment and owned skyboxes; omitted preserves it. Replacing/clearing disposes only textures owned by this tool and no longer referenced by materials. Any configured deferred camera is intentionally invalidated and must be rebuilt through rebuild_deferred_lighting.",
			inputSchema: z
				.object({
					expectedRevision: z
						.string()
						.regex(/^[0-9a-f]{64}$/)
						.describe("Exact SHA-256 revision returned by get_environment_lighting."),
					texturePath: z
						.string()
						.min(1)
						.max(1024)
						.nullable()
						.optional()
						.describe("Project-relative/absolute `.env`, `.hdr`, or `.exr`; null clears; omit to preserve while tuning intensity/skybox."),
					iblIntensity: z.number().min(0).max(16).optional().describe("Scene IBL multiplier; omit to preserve."),
					createSkybox: z.boolean().optional().describe("True replaces the tool-owned skybox with one using the resulting environment; omit/false preserves it."),
					removeSkyboxes: z.boolean().optional().describe("True removes only skyboxes previously created by this tool."),
					skyboxSize: z.number().gt(0).max(10_000_000).optional().describe("Created skybox size in editor centimeters; defaults to 10000."),
					skyboxBlur: z.number().min(0).max(1).optional().describe("Created skybox roughness/blur; defaults to 0.3."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_environment_texture", args)
	);

	server.registerTool(
		"create_diffusion_profile",
		{
			title: "Create diffusion profile",
			description:
				"Create a strict versioned `.diffusionprofile.json` asset for real Babylon Burley screen-space subsurface scattering and transmission. The profile stores Unity-style scattering distance, transmission tint, thickness remap, world scale, and IOR; use set_subsurface_material to assign the exact returned revision.",
			inputSchema: z
				.object({ path: z.string().min(1).max(1024), name: z.string().min(1).max(128), id: z.string().min(1).max(128).optional(), ...diffusionProfileFieldsSchema })
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_diffusion_profile", args)
	);

	server.registerTool(
		"list_diffusion_profiles",
		{
			title: "List diffusion profiles",
			description:
				"Page validated project diffusion-profile assets with exact SHA-256 revisions. Invalid files are returned as bounded errors instead of being silently accepted.",
			inputSchema: z
				.object({ search: z.string().max(256).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(128).optional() })
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_diffusion_profiles", args)
	);

	server.registerTool(
		"get_diffusion_profile",
		{
			title: "Get diffusion profile",
			description: "Read one complete validated diffusion-profile asset and its exact SHA-256 content revision before updating, assigning, or deleting it.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_diffusion_profile", args)
	);

	server.registerTool(
		"set_diffusion_profile",
		{
			title: "Set diffusion profile",
			description:
				"Replace one exact diffusion-profile revision and refresh all live material snapshots that reference it. The native Burley pre-pass is rebuilt atomically; invalid values, stale revisions, or more than 15 effective view profiles reject.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024),
					expectedRevision: exactContentRevisionSchema,
					name: z.string().min(1).max(128).optional(),
					...diffusionProfileFieldsSchema,
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_diffusion_profile", args)
	);

	server.registerTool(
		"delete_diffusion_profile",
		{
			title: "Delete diffusion profile",
			description:
				"Delete one exact unreferenced diffusion-profile asset. The operation requires its current SHA-256 revision and confirm:true and refuses any live material reference.",
			inputSchema: z.object({ path: z.string().min(1).max(1024), expectedRevision: exactContentRevisionSchema, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_diffusion_profile", args)
	);

	server.registerTool(
		"get_subsurface_material",
		{
			title: "Get subsurface material",
			description:
				"Read one PBR material's exact portable diffusion-profile assignment, independent red-channel subsurface-mask texture, native scattering/transmission/thickness state, camera-independent transport caches, and live renderer evidence.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_subsurface_material", args)
	);

	server.registerTool(
		"get_subsurface_transport",
		{
			title: "Get subsurface transport",
			description:
				"Read one PBR material's exact camera-independent subsurface transport caches, material/settings leases, signed geometry/profile/lighting state, texture/ray/thickness evidence, active/stale reasons, backend, and explicit limitations before baking or clearing.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_subsurface_transport", args)
	);

	server.registerTool(
		"bake_subsurface_transport",
		{
			title: "Bake subsurface transport",
			description:
				"Under the exact material/cache lease, trace bounded camera-independent rays through one indexed PBR mesh, evaluate off-screen exit lighting and geometry occlusion, write an atomic linear-RGBM project texture, sign geometry/profile/lighting state, replace only that mesh cache, and rebuild shared editor/export runtime evidence. This is a static CPU ray-traced web backend, not hardware DXR.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					meshId: z.string().min(1).max(256),
					expectedRevision: z.number().int().min(1).describe("Exact material revision returned by get_subsurface_transport."),
					expectedCacheRevision: z.number().int().min(1).optional().describe("Required exact cache revision when replacing an existing cache; omit for the first bake."),
					outputPath: z.string().min(1).max(1024).optional().describe("Fresh project-relative `.png`; omit for a revisioned generated path."),
					resolution: z.number().int().min(16).max(256).optional(),
					sampleCount: z.number().int().min(1).max(64).optional(),
					maxDistance: z.number().gt(0).max(1_000_000).optional().describe("Maximum internal ray distance in editor centimeters."),
					bias: z.number().gt(0).max(1000).optional().describe("Self-intersection bias in editor centimeters."),
					shadowing: z.boolean().optional(),
					dilation: z.number().int().min(0).max(16).optional(),
					uvChannel: z.enum(["uv0", "uv2"]).optional(),
					intensity: z.number().min(0).max(16).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_subsurface_transport", args)
	);

	server.registerTool(
		"clear_subsurface_transport",
		{
			title: "Clear subsurface transport",
			description:
				"Under exact material and per-mesh cache revisions, remove one portable transport assignment and its editor-generated texture/sidecar as one confirmation-gated transaction, then rebuild runtime evidence without touching other caches.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					meshId: z.string().min(1).max(256),
					expectedRevision: z.number().int().min(1),
					expectedCacheRevision: z.number().int().min(1),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_subsurface_transport", args)
	);

	server.registerTool(
		"set_subsurface_material",
		{
			title: "Set subsurface material",
			description:
				"Assign or exact-revision update real screen-space subsurface scattering/transmission on a PBRMaterial. First assignment uses expectedRevision:0 plus an exact profilePath/profile revision. An optional independent project 2D subsurface-mask texture uses its red channel and is multiplied by subsurfaceMask; the separate optional thickness texture drives native transmission. Shared custom deferred rendering routes the material through native forward/pre-pass composition.",
			inputSchema: z
				.object({
					materialId: z.string().min(1).max(256),
					expectedRevision: z.number().int().min(0),
					profilePath: z.string().min(1).max(1024).optional(),
					expectedProfileRevision: exactContentRevisionSchema.optional(),
					mode: z.enum(["subsurface-scattering", "translucent"]).optional(),
					subsurfaceMask: z.number().min(0).max(1).optional(),
					subsurfaceMaskTexturePath: z.string().min(1).max(1024).nullable().optional(),
					transmissionEnabled: z.boolean().optional(),
					transmissionIntensity: z.number().min(0).max(16).optional(),
					thicknessMultiplier: z.number().min(0).max(1000).optional(),
					useThicknessTexture: z.boolean().optional(),
					thicknessTexturePath: z.string().min(1).max(1024).nullable().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (Boolean(value.profilePath) !== Boolean(value.expectedProfileRevision)) {
						context.addIssue({ code: "custom", message: "profilePath and expectedProfileRevision must be supplied together." });
					}
					if (value.expectedRevision === 0 && !value.profilePath) {
						context.addIssue({ code: "custom", message: "The first subsurface assignment requires profilePath and expectedProfileRevision." });
					}
				}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_subsurface_material", args)
	);

	server.registerTool(
		"clear_subsurface_material",
		{
			title: "Clear subsurface material",
			description:
				"Remove one exact portable subsurface assignment and disable its native scattering/transmission state without deleting its profile or texture assets. Requires confirm:true.",
			inputSchema: z.object({ materialId: z.string().min(1).max(256), expectedRevision: z.number().int().min(1), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_subsurface_material", args)
	);

	server.registerTool(
		"get_subsurface_runtime",
		{
			title: "Get subsurface runtime",
			description:
				"Read exact scene-wide quality/sample/scale/transport settings and live native pre-pass, camera-independent transport cache, profile, material, texture, backend, frame, warning, limitation, and error evidence.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_subsurface_runtime", {})
	);

	server.registerTool(
		"set_subsurface_runtime",
		{
			title: "Set subsurface runtime",
			description:
				"Exact-revision update of the native Burley runtime: enable state, low/medium/high/custom screen-space sample policy, scene metres-per-unit scale, screen-space versus baked-ray-traced transport mode, and portable transport intensity.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(1),
					enabled: z.boolean().optional(),
					quality: z.enum(["low", "medium", "high", "custom"]).optional(),
					sampleBudget: z.number().int().min(8).max(256).optional(),
					metersPerUnit: z.number().min(0.000001).max(1000).optional(),
					transportMode: z.enum(["screen-space", "baked-ray-traced"]).optional(),
					transportIntensity: z.number().min(0).max(16).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_subsurface_runtime", args)
	);

	server.registerTool(
		"clear_subsurface_runtime",
		{
			title: "Clear subsurface runtime",
			description:
				"Remove one exact explicit scene-wide subsurface policy and restore the side-effect-free portable defaults. Requires the current numeric revision and confirm:true.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(1), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_subsurface_runtime", args)
	);

	server.registerTool(
		"refresh_subsurface_profile_assignments",
		{
			title: "Refresh subsurface profile assignments",
			description:
				"Under the exact SHA-256 lease returned by get_diffusion_profile, refresh only stale live material snapshots from an externally edited validated profile and rebuild runtime evidence. Repeating the same exact revision is a no-op.",
			inputSchema: z.object({ path: z.string().min(1).max(1024), expectedRevision: exactContentRevisionSchema }).strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_subsurface_profile_assignments", args)
	);
}

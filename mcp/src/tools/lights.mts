import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerLightTools(server: McpServer): void {
	const lightingScenarioReference = {
		id: z.string().min(1).max(128).optional().describe("Stable lighting-scenario id; preferred over name."),
		name: z.string().min(1).max(128).optional().describe("Exact lighting-scenario name fallback."),
	};
	const vector3 = z.tuple([z.number(), z.number(), z.number()]);
	const positiveVector3 = z.tuple([z.number().gt(0), z.number().gt(0), z.number().gt(0)]);
	const reflectionProbeReference = {
		id: z.string().min(1).max(128).optional().describe("Stable reflection-probe id; preferred over name."),
		name: z.string().min(1).max(128).optional().describe("Exact reflection-probe name fallback."),
	};
	const lightProbeReference = {
		id: z.string().min(1).max(128).optional().describe("Stable Light Probe Volume id; preferred over name."),
		name: z.string().min(1).max(128).optional().describe("Exact volume name; use id when available."),
	};
	const lightingSearchProvider = z.enum(["lights", "mesh-renderers", "lightmaps", "reflection-probes", "probe-volumes", "materials", "lighting-settings"]);
	const lightingSearchPipeline = z.enum(["all", "native-forward", "clustered-forward", "portable-deferred", "baked-gi"]);
	const lightingSearchFilter = z
		.object({
			field: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[A-Za-z][A-Za-z0-9]*$/),
			operator: z.enum(["eq", "ne", "contains", "gt", "gte", "lt", "lte"]),
			value: z.union([z.string().max(256), z.number().finite(), z.boolean()]),
		})
		.strict();
	const lightingSearchStateFingerprint = z.string().regex(/^lighting-search-sha256-v1:[0-9a-f]{64}$/);
	const lightingSearchItemFingerprint = z.string().regex(/^lighting-search-item-sha256-v1:[0-9a-f]{64}$/);
	const lightingSearchItemLease = {
		id: z.string().min(1).max(256),
		expectedFingerprint: lightingSearchItemFingerprint.describe("Exact current item fingerprint returned by query_lighting_search."),
	};

	server.registerTool(
		"inspect_lighting_search",
		{
			title: "Inspect Lighting Search",
			description:
				"Read the permanent Lighting Search workspace contract, exact custom-query-tree lease, immutable built-in tree, provider/pipeline/filter inventory, editable providers, bounds, and honest Unity/Babylon portability limits.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("inspect_lighting_search", {})
	);
	server.registerTool(
		"save_lighting_search_query",
		{
			title: "Save Lighting Search Query",
			description:
				"Create or update one project-persisted custom query-tree node under the exact global tree revision/fingerprint. Existing queries also require their exact query revision. Built-in nodes are immutable and custom queries can be rooted or placed under a built-in folder.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(1),
					expectedFingerprint: lightingSearchStateFingerprint,
					id: z.string().min(1).max(128).optional().describe("Existing custom query id to update; omit to create a UUID-backed query."),
					expectedQueryRevision: z.number().int().min(1).optional().describe("Required only when updating an existing custom query."),
					query: z
						.object({
							name: z.string().min(1).max(128),
							parentId: z.string().min(1).max(128).nullable().optional(),
							provider: lightingSearchProvider,
							search: z.string().max(512).optional(),
							pipeline: lightingSearchPipeline.optional(),
							filters: z.array(lightingSearchFilter).max(16).optional(),
							columns: z
								.array(
									z
										.string()
										.min(1)
										.max(64)
										.regex(/^[A-Za-z][A-Za-z0-9]*$/)
								)
								.max(24)
								.optional(),
						})
						.strict(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_lighting_search_query", args)
	);
	server.registerTool(
		"delete_lighting_search_query",
		{
			title: "Delete Lighting Search Query",
			description: "Delete one custom exact-revision Lighting Search query after literal confirmation. Built-in query-tree nodes cannot be deleted.",
			inputSchema: z
				.object({
					expectedRevision: z.number().int().min(1),
					expectedFingerprint: lightingSearchStateFingerprint,
					id: z.string().min(1).max(128),
					expectedQueryRevision: z.number().int().min(1),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_lighting_search_query", args)
	);
	server.registerTool(
		"query_lighting_search",
		{
			title: "Query Lighting Search",
			description:
				"Query one lighting provider or saved/built-in query using bounded text, typed filters, portable pipeline selection, stable sorting, and pagination. Results include exact item fingerprints, pipeline support, complete table properties, and provider-specific editable fields.",
			inputSchema: z
				.object({
					queryId: z.string().min(1).max(128).optional(),
					provider: lightingSearchProvider.optional(),
					search: z.string().max(512).optional(),
					pipeline: lightingSearchPipeline.optional(),
					filters: z.array(lightingSearchFilter).max(16).optional(),
					columns: z
						.array(
							z
								.string()
								.min(1)
								.max(64)
								.regex(/^[A-Za-z][A-Za-z0-9]*$/)
						)
						.max(24)
						.optional(),
					sortField: z
						.string()
						.min(1)
						.max(64)
						.regex(/^[A-Za-z][A-Za-z0-9]*$/)
						.optional(),
					sortDirection: z.enum(["asc", "desc"]).optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict()
				.refine((value) => Boolean(value.queryId) !== Boolean(value.provider), { message: "Provide exactly one queryId or provider." }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("query_lighting_search", args)
	);
	server.registerTool(
		"get_lighting_search_lightmap_preview",
		{
			title: "Get Lighting Search Lightmap Preview",
			description:
				"Open one exact-fingerprint project-contained lightmap for the permanent preview workspace and return its file URL, dimensions/format/compression/UV evidence, bounded byte count, SHA-256, and -16..+16 EV exposure multiplier without changing source bytes.",
			inputSchema: z
				.object({
					...lightingSearchItemLease,
					exposureEV: z.number().min(-16).max(16).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_lighting_search_lightmap_preview", args)
	);
	const lightingSearchLightOperation = z
		.object({
			provider: z.literal("lights"),
			...lightingSearchItemLease,
			properties: z
				.object({
					name: z.string().min(1).max(256).optional(),
					enabled: z.boolean().optional(),
					intensity: z.number().min(0).max(10_000_000).optional(),
					diffuse: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
					specular: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
					range: z.number().min(0).max(10_000_000).optional(),
					angle: z.number().min(0).max(10_000_000).optional(),
					includeOnlyWithLayerMask: z.number().int().min(0).max(4_294_967_295).optional(),
					excludeWithLayerMask: z.number().int().min(0).max(4_294_967_295).optional(),
				})
				.strict()
				.refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "Provide at least one light property." }),
		})
		.strict();
	const lightingSearchMeshOperation = z
		.object({
			provider: z.literal("mesh-renderers"),
			...lightingSearchItemLease,
			properties: z
				.object({
					name: z.string().min(1).max(256).optional(),
					enabled: z.boolean().optional(),
					visibility: z.number().min(0).max(1).optional(),
					receiveShadows: z.boolean().optional(),
					renderingGroupId: z.number().int().min(0).max(3).optional(),
					layerMask: z.number().int().min(0).max(4_294_967_295).optional(),
				})
				.strict()
				.refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "Provide at least one mesh-renderer property." }),
		})
		.strict();
	const lightingSearchMaterialOperation = z
		.object({
			provider: z.literal("materials"),
			...lightingSearchItemLease,
			properties: z
				.object({
					name: z.string().min(1).max(256).optional(),
					alpha: z.number().min(0).max(1).optional(),
					backFaceCulling: z.boolean().optional(),
					wireframe: z.boolean().optional(),
					emissiveColor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
					emissiveIntensity: z.number().min(0).max(1_000_000).optional(),
				})
				.strict()
				.refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "Provide at least one material property." }),
		})
		.strict();
	const lightingSearchSettingsOperation = z
		.object({
			provider: z.literal("lighting-settings"),
			...lightingSearchItemLease,
			properties: z
				.object({
					environmentIntensity: z.number().min(0).max(1_000_000).optional(),
					ambientColor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
					clearColor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
					fogEnabled: z.boolean().optional(),
				})
				.strict()
				.refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "Provide at least one scene-lighting property." }),
		})
		.strict();
	server.registerTool(
		"set_lighting_search_properties",
		{
			title: "Set Lighting Search Properties",
			description:
				"Atomically edit 1–50 exact-fingerprint light, mesh-renderer, material, or scene-lighting rows from the Lighting Search table. Every target and provider-specific property is prevalidated; any failure rolls back the entire batch, and successful edits produce one Undo/Redo transaction.",
			inputSchema: z
				.object({
					operations: z
						.array(
							z.discriminatedUnion("provider", [
								lightingSearchLightOperation,
								lightingSearchMeshOperation,
								lightingSearchMaterialOperation,
								lightingSearchSettingsOperation,
							])
						)
						.min(1)
						.max(50),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_lighting_search_properties", args)
	);
	server.registerTool(
		"get_baked_gi",
		{
			title: "Get baked global illumination",
			description:
				"Inspect the active scene's automatic baked-GI manifest, exact backend/settings, per-mesh UV channel and generated lightmap, coverage/overlap/saturation counts, ray workload, and reversible material identities. Returns configured=false when no bake is applied.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_baked_gi", {})
	);
	server.registerTool(
		"bake_baked_gi",
		{
			title: "Bake global illumination",
			description:
				"Automatically rasterize selected static indexed meshes into one generated lightmap each, using authored UV2 when available (otherwise UV0), realtime-light direct illumination with geometry shadow rays, and an optional deterministic diffuse bounce. The bounded CPU backend validates every target, publishes PNG files atomically inside the project, clones PBR/Standard materials per mesh, persists exact evidence and original-material snapshots, and rolls back on failure. Clear an existing bake before replacing it.",
			inputSchema: z
				.object({
					meshIds: z.array(z.string().min(1)).max(128).optional().describe("Stable mesh IDs to bake; omit to bake all eligible enabled visible authored meshes."),
					resolution: z.number().int().min(16).max(256).optional().describe("Square lightmap resolution per mesh; defaults to 64."),
					samples: z.number().int().min(1).max(32).optional().describe("Deterministic hemisphere samples per covered texel; defaults to 4."),
					bounces: z
						.union([z.literal(0), z.literal(1)])
						.optional()
						.describe("Diffuse indirect bounces; defaults to 1 and is bounded to one."),
					directIntensity: z.number().min(0).max(8).optional().describe("Direct and ambient light multiplier; defaults to 1."),
					indirectIntensity: z.number().min(0).max(8).optional().describe("One-bounce indirect multiplier; defaults to 0.5."),
					shadowing: z.boolean().optional().describe("Cast real scene-geometry shadow rays for direct lights; defaults to true."),
					shadowBias: z.number().min(0).max(100).optional().describe("Surface ray bias in editor centimeters; defaults to 0.05."),
					maxDistance: z.number().gt(0).max(1000000).optional().describe("Maximum directional/indirect ray distance in editor centimeters; defaults to 10000."),
					dilation: z.number().int().min(0).max(16).optional().describe("Chart-padding dilation iterations; defaults to 2."),
					uvChannel: z.enum(["auto", "uv0", "uv2"]).optional().describe("UV channel; auto prefers authored UV2 then falls back to UV0."),
					outputDirectory: z.string().min(1).optional().describe("Project-relative generated root; defaults to assets/Lighting/BakedGI."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_baked_gi", args)
	);
	server.registerTool(
		"clear_baked_gi",
		{
			title: "Clear baked global illumination",
			description:
				"Restore every surviving baked mesh's exact original material (including from persisted snapshots after reload), dispose only bake-owned material/texture resources, remove the active manifest, and delete only its generated lightmap directory. Inspect first and pass the exact bake ID for stale-operation protection.",
			inputSchema: z
				.object({
					expectedBakeId: z.string().min(1).describe("Exact bakeId returned by get_baked_gi; stale IDs are rejected before mutation."),
					confirm: z.literal(true).describe("Required acknowledgement that generated lightmap files will be deleted and original materials restored."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_baked_gi", args)
	);
	server.registerTool(
		"list_light_probe_volumes",
		{
			title: "List Light Probe Volumes",
			description:
				"List persisted adaptive Light Probe Volumes with exact revisions, bounds, base-grid/adaptive settings, target meshes, bounded SH9 bake settings/evidence, and shared preview/export runtime state. Select one volume and set includeBakeData to page its exact 27-float RGB coefficients and adaptive cell topology without returning an unbounded payload.",
			inputSchema: z
				.object({
					...lightProbeReference,
					offset: z.number().int().min(0).optional().describe("Volume page offset; defaults to 0."),
					limit: z.number().int().min(1).max(50).optional().describe("Volume page size; defaults to 20."),
					includeBakeData: z.boolean().optional().describe("Page exact probes/cells for one selected baked volume; defaults to false."),
					probeOffset: z.number().int().min(0).optional().describe("Exact baked-probe page offset."),
					probeLimit: z.number().int().min(1).max(64).optional().describe("Exact baked-probe page size; defaults to 16."),
					cellOffset: z.number().int().min(0).optional().describe("Adaptive-cell page offset."),
					cellLimit: z.number().int().min(1).max(64).optional().describe("Adaptive-cell page size; defaults to 16."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_light_probe_volumes", args)
	);
	server.registerTool(
		"create_light_probe_volume",
		{
			title: "Create Light Probe Volume",
			description:
				"Create one bounded adaptive probe volume persisted in the active scene. Bounds use editor centimeters. The base grid contains 2–8 probes per axis; adaptiveLevels 1–2 recursively refines cells intersecting static bake geometry. targetMeshIds selects moving PBR/Standard meshes that receive trilinearly interpolated SH9 indirect light in editor preview and exported games. Omit targets to select all currently eligible meshes.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(128).describe("Unique authored volume name."),
					enabled: z.boolean().optional().describe("Runtime enabled state; defaults to true."),
					priority: z.number().int().min(-100).max(100).optional().describe("Overlap priority; defaults to 0."),
					minimum: vector3.optional().describe("World AABB minimum in centimeters; omit for padded scene bounds."),
					maximum: vector3.optional().describe("World AABB maximum in centimeters; omit for padded scene bounds."),
					baseResolution: z
						.tuple([z.number().int().min(2).max(8), z.number().int().min(2).max(8), z.number().int().min(2).max(8)])
						.optional()
						.describe("Base probe counts XYZ; defaults to [3,3,3]."),
					adaptiveLevels: z.number().int().min(0).max(2).optional().describe("Geometry-driven octree refinement levels; defaults to 1."),
					blendDistance: z.number().min(0).max(100000).optional().describe("Fade distance outside bounds in centimeters; defaults to 100."),
					targetMeshIds: z
						.array(z.string().min(1).max(256))
						.min(1)
						.max(256)
						.optional()
						.describe("Dynamic PBR/Standard mesh ids receiving probe lighting; omit for all eligible meshes."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_light_probe_volume", args)
	);
	server.registerTool(
		"set_light_probe_volume",
		{
			title: "Set Light Probe Volume",
			description:
				"Update a Light Probe Volume under an exact revision lease. Changing bounds, base resolution, or adaptive levels invalidates its old bake before publication; changing target meshes, enable state, priority, blend distance, or name preserves valid coefficients and immediately rebuilds the shared editor/export runtime.",
			inputSchema: z
				.object({
					...lightProbeReference,
					expectedRevision: z.number().int().min(1).describe("Exact current revision from list_light_probe_volumes; stale writes reject."),
					newName: z.string().min(1).max(128).optional().describe("Optional replacement name; id remains the stable selector."),
					enabled: z.boolean().optional(),
					priority: z.number().int().min(-100).max(100).optional(),
					minimum: vector3.optional(),
					maximum: vector3.optional(),
					baseResolution: z.tuple([z.number().int().min(2).max(8), z.number().int().min(2).max(8), z.number().int().min(2).max(8)]).optional(),
					adaptiveLevels: z.number().int().min(0).max(2).optional(),
					blendDistance: z.number().min(0).max(100000).optional(),
					targetMeshIds: z.array(z.string().min(1).max(256)).min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_probe_volume", args)
	);
	server.registerTool(
		"bake_light_probe_volume",
		{
			title: "Bake Light Probe Volume",
			description:
				"Atomically bake one adaptive volume into nine RGB spherical-harmonic coefficients per probe. The bounded CPU backend builds geometry-intersecting adaptive cells, traces deterministic full-sphere rays, evaluates ambient/hemispheric/environment background, analytic directional/point/spot lights with geometry occlusion, emissive surfaces, and one diffuse bounce, then rebuilds the real GLSL/WGSL runtime only after all probes succeed.",
			inputSchema: z
				.object({
					...lightProbeReference,
					expectedRevision: z.number().int().min(1).describe("Exact current revision; stale bakes reject before work or mutation."),
					samples: z.number().int().min(8).max(256).optional().describe("Deterministic sphere rays per probe; defaults to 32."),
					maxDistance: z.number().min(10).max(1000000).optional().describe("Maximum probe/bounce ray distance in centimeters; defaults to 10000."),
					shadowBias: z.number().gt(0).max(1000).optional().describe("Ray origin bias in centimeters; defaults to 1."),
					environmentIntensity: z.number().min(0).max(16).optional().describe("Ambient/background/hemispheric contribution; defaults to 1."),
					directIntensity: z.number().min(0).max(16).optional().describe("Realtime analytic light contribution; defaults to 1."),
					bounceIntensity: z.number().min(0).max(16).optional().describe("Static-surface outgoing-radiance contribution; defaults to 1."),
					geometryMeshIds: z
						.array(z.string().min(1).max(256))
						.max(256)
						.optional()
						.describe("Exact static indexed geometry ids; omit to use all indexed meshes except target meshes."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_light_probe_volume", args)
	);
	server.registerTool(
		"delete_light_probe_volume",
		{
			title: "Delete Light Probe Volume",
			description:
				"Permanently remove one probe volume and all of its baked SH9 coefficients under an exact revision lease, then rebuild the shared runtime. This does not delete meshes, materials, lights, or external files.",
			inputSchema: z
				.object({
					...lightProbeReference,
					expectedRevision: z.number().int().min(1).describe("Exact current revision from list_light_probe_volumes."),
					confirm: z.literal(true).describe("Required acknowledgement that persisted baked coefficients are permanently removed."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_light_probe_volume", args)
	);
	server.registerTool(
		"get_light_probe_runtime",
		{
			title: "Get Light Probe Runtime",
			description:
				"Read exact shared preview/export execution evidence: adaptive backend, installed material-plugin count, GLSL/WGSL support, volume/target counts, interpolation query counters, last matched cells and L00 coefficient. Optionally evaluate one mesh at its current bounding center or an explicit world position and return the complete interpolated 27-float SH9 payload, contributing volume ids, normalized weights, and adaptive levels.",
			inputSchema: z
				.object({
					meshId: z.string().min(1).max(256).optional().describe("Mesh id to evaluate; preferred."),
					meshName: z.string().min(1).max(256).optional().describe("Mesh name fallback."),
					position: vector3.optional().describe("Optional explicit world position in centimeters; defaults to the mesh bounding center."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_light_probe_runtime", args)
	);
	server.registerTool(
		"list_lighting_scenarios",
		{
			title: "List Lighting Scenarios",
			description:
				"List bounded versioned realtime plus baked-lighting scenario summaries, revisions, retained bake ownership, lightmap/APV evidence, and exact shared preview/export runtime state. Large SH9 probe payloads are intentionally summarized.",
			inputSchema: z
				.object({
					id: z.string().min(1).max(128).optional(),
					name: z.string().min(1).max(128).optional(),
					offset: z.number().int().min(0).max(31).optional(),
					limit: z.number().int().min(1).max(32).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_lighting_scenarios", args)
	);
	server.registerTool(
		"create_lighting_scenario",
		{
			title: "Capture Lighting Scenario",
			description:
				"Capture selected/all realtime lights and, by default, the active automatic baked-GI material/lightmap ownership plus complete validated adaptive SH9 probe volumes. Retained baked files/materials survive clear_baked_gi and are released only after the final exact-leased scenario owner is deleted.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(128),
					lightNodeIds: z.array(z.string().min(1).max(256)).max(256).optional(),
					captureBakedLighting: z.boolean().optional().describe("Defaults true; false captures realtime lights only."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_lighting_scenario", args)
	);
	server.registerTool(
		"apply_lighting_scenario",
		{
			title: "Apply Lighting Scenario",
			description:
				"Atomically apply a saved scenario's realtime lights, retained lightmap materials, and adaptive SH9 volumes through the shared editor/export runtime. Returns missing light/mesh identities and exact runtime evidence.",
			inputSchema: z
				.object({
					...lightingScenarioReference,
					expectedRevision: z.number().int().min(1).optional().describe("Optional exact revision lease from list_lighting_scenarios."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_lighting_scenario", args)
	);
	server.registerTool(
		"blend_lighting_scenario",
		{
			title: "Blend Lighting Scenario",
			description:
				"Cross-fade realtime lights, compatible retained PBR/Standard/MultiMaterial lightmaps, and adaptive SH9 probe evaluation through one GLSL/WGSL preview/export runtime. Nonzero lightmap blends require a compatible currently applied baked scenario; use durationMs=0 for the initial apply.",
			inputSchema: z
				.object({
					...lightingScenarioReference,
					expectedRevision: z.number().int().min(1).optional(),
					durationMs: z.number().min(0).max(60000).optional().describe("Cross-fade duration in milliseconds; defaults to 1000."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("blend_lighting_scenario", args)
	);
	server.registerTool(
		"delete_lighting_scenario",
		{
			title: "Delete Lighting Scenario",
			description:
				"Delete one inactive exact-leased scenario and release its retained generated lightmap directory/materials only when no active bake or other scenario still owns them. Requires literal confirmation and the current revision.",
			inputSchema: z
				.object({
					...lightingScenarioReference,
					expectedRevision: z.number().int().min(1),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_lighting_scenario", args)
	);
	server.registerTool(
		"get_lighting_scenario_runtime",
		{
			title: "Get Lighting Scenario Runtime",
			description:
				"Read exact shared preview/export scenario execution evidence: active/target scenario, blend weight/duration, retained lightmap and APV counts, GLSL/WGSL support, last application, and validation errors.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_lighting_scenario_runtime", {})
	);
	server.registerTool(
		"list_reflection_probes",
		{
			title: "List Reflection Probes",
			description:
				"List bounded native realtime reflection probes with stable IDs/revisions, cubemap readiness, capture settings, influence bounds, box projection, Unity-style importance/blend distance, exact render/material assignments, and per-camera deferred-IBL blend execution evidence. Page the result before any mutation.",
			inputSchema: z
				.object({
					...reflectionProbeReference,
					offset: z.number().int().min(0).optional().describe("Probe page offset; defaults to 0."),
					limit: z.number().int().min(1).max(50).optional().describe("Probe page size; defaults to 32."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_reflection_probes", args)
	);
	server.registerTool(
		"create_reflection_probe",
		{
			title: "Create Reflection Probe",
			description:
				"Create one serialized native realtime cubemap probe with a stable revision lease, influence volume, Unity-style importance/edge blend, optional box projection, and optional complete material assignment set. The shared deferred runtime blends equal-importance overlapping probes per pixel and fades unused weight to the material cubemap or scene environment. Mipmaps default on for roughness LOD; rebuild configured deferred cameras after changes.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(128).describe("Unique probe name."),
					size: z.number().int().min(16).max(2048).optional().describe("Power-of-two cube-face size; defaults to 256."),
					position: vector3.optional().describe("Capture position in editor centimeters."),
					refreshRate: z.number().int().min(0).max(2).optional().describe("Babylon refresh rate: 0 once, 1 every frame, 2 every second frame."),
					samples: z.number().int().min(1).max(16).optional().describe("Cubemap MSAA samples."),
					generateMipMaps: z.boolean().optional().describe("Generate roughness LOD mipmaps; defaults to true."),
					useFloat: z.boolean().optional().describe("Use a floating-point render target when supported."),
					linearSpace: z.boolean().optional().describe("Capture in linear color space."),
					intensity: z.number().min(0).max(16).optional().describe("Probe IBL intensity multiplier; defaults to 1."),
					boxProjection: z.boolean().optional().describe("Enable local box-projected reflections; defaults to false."),
					influencePosition: vector3.optional().describe("Influence-box center in editor centimeters; defaults to capture position."),
					influenceSize: positiveVector3.optional().describe("Positive influence-box XYZ size in editor centimeters; defaults to [1000,1000,1000]."),
					importance: z.number().int().min(0).max(1000).optional().describe("Unity-style overlap priority; the highest importance at a pixel wins. Defaults to 1."),
					blendDistance: z
						.number()
						.min(0)
						.max(100000)
						.optional()
						.describe("Linear fade distance inside influence-box edges; must not exceed half the smallest influenceSize component."),
					attachedMeshId: z.string().min(1).max(256).optional().describe("Optional mesh id whose world position drives capture."),
					attachedMeshName: z.string().min(1).max(256).optional().describe("Exact mesh-name fallback for attachment."),
					renderListIds: z.array(z.string().min(1).max(256)).max(512).optional().describe("Exact meshes captured by the probe; omit for Babylon's default."),
					assignMaterialIds: z
						.array(z.string().min(1).max(256))
						.max(512)
						.optional()
						.describe("Complete authored material set receiving this probe; one material may belong to multiple probes for overlap blending."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_reflection_probe", args)
	);
	server.registerTool(
		"set_reflection_probe",
		{
			title: "Set Reflection Probe",
			description:
				"Update one exact-revision probe atomically. assignMaterialIds is full replacement and may overlap other probes; omitted preserves assignments and [] clears them. Equal-importance overlaps blend by each probe's inner-edge weight, higher importance wins, and remaining weight falls back to the material cubemap or scene environment. renderListIds is full replacement; null restores unrestricted capture. Blend/bounds/intensity/assignment changes invalidate configured deferred cameras; rebuild using the exact renderer selection revision.",
			inputSchema: z
				.object({
					...reflectionProbeReference,
					expectedRevision: z.number().int().min(1).describe("Exact revision returned by list_reflection_probes; stale leases are rejected before mutation."),
					position: vector3.optional().describe("Capture position in editor centimeters; also moves influence center unless influencePosition is supplied."),
					refreshRate: z.number().int().min(0).max(2).optional(),
					samples: z.number().int().min(1).max(16).optional(),
					intensity: z.number().min(0).max(16).optional().describe("Probe IBL intensity multiplier."),
					boxProjection: z.boolean().optional().describe("Enable or disable local box projection."),
					influencePosition: vector3.optional().describe("Influence-box center in editor centimeters."),
					influenceSize: positiveVector3.optional().describe("Positive influence-box XYZ size in editor centimeters."),
					importance: z.number().int().min(0).max(1000).optional().describe("Unity-style overlap priority."),
					blendDistance: z
						.number()
						.min(0)
						.max(100000)
						.optional()
						.describe("Linear fade distance inside influence-box edges; must not exceed half the smallest influenceSize component."),
					attachedMeshId: z.string().min(1).max(256).nullable().optional().describe("Mesh id, or null to detach."),
					attachedMeshName: z.string().min(1).max(256).nullable().optional().describe("Exact mesh-name fallback, or null to detach."),
					renderListIds: z
						.array(z.string().min(1).max(256))
						.max(512)
						.nullable()
						.optional()
						.describe("Exact capture render list; [] captures none, null restores unrestricted capture."),
					assignMaterialIds: z
						.array(z.string().min(1).max(256))
						.max(512)
						.optional()
						.describe(
							"Complete replacement set of compatible PBR/Standard/OpenPBR material ids; a material may belong to multiple probes; [] clears this probe's set."
						),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_reflection_probe", args)
	);
	server.registerTool(
		"delete_reflection_probe",
		{
			title: "Delete Reflection Probe",
			description:
				"Dispose one exact-revision realtime probe and its generated cubemap after literal confirmation. Materials referencing that exact cubemap are cleared; unrelated environment/reflection textures are preserved. Rebuild any deferred cameras that previously consumed it.",
			inputSchema: z
				.object({
					...reflectionProbeReference,
					expectedRevision: z.number().int().min(1).describe("Exact current revision from list_reflection_probes."),
					confirm: z.literal(true).describe("Required acknowledgement that the realtime cubemap will be disposed and exact material references cleared."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_reflection_probe", args)
	);
	server.registerTool(
		"create_light",
		{
			title: "Create light",
			description:
				"Create a light (directional, point, spot or hemispheric). Positions are in centimeters; `color` is `[r,g,b]` (0..1). " +
				"PERFORMANCE RULE: only lights that CAST SHADOWS should be regular scene lights (e.g. the sun as a directional light with a shadow generator). " +
				"Every light that does NOT cast shadows (street lamps, decorative point lights, etc.) must be placed in the scene's ClusteredLightContainer — create it with `create_clustered_light_container` and move lights into it with `add_light_to_clustered_container`. " +
				"For a sunset, create a directional light with a warm color and tune its intensity/direction, then verify with `get_screenshot`.",
			inputSchema: z.object({
				type: z.enum(["directional", "point", "spot", "hemispheric"]).describe("The light type."),
				name: z.string().optional().describe("Name for the new light."),
				parentId: z
					.string()
					.optional()
					.describe(
						"Id of the parent node. To add a non-shadow light directly under the clustered container, pass its id here or use `add_light_to_clustered_container` afterwards."
					),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters (point/spot)."),
				direction: z.array(z.number()).length(3).optional().describe("Direction `[x,y,z]` (directional/spot/hemispheric)."),
				color: z.array(z.number()).length(3).optional().describe("Diffuse color `[r,g,b]` in 0..1."),
				intensity: z.number().optional().describe("Light intensity."),
				range: z.number().optional().describe("Range in centimeters (point/spot)."),
				angle: z.number().optional().describe("Cone angle in radians (spot)."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_light", args)
	);

	server.registerTool(
		"get_light",
		{
			title: "Get light",
			description: "Read a light's full inspector-relevant transform, color, intensity, range/cone, and shadow-generator state.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_light", args)
	);

	server.registerTool(
		"create_area_light",
		{
			title: "Create area light",
			description:
				"Create one regular, one-sided Unity-style rectangle or disc area light in editor centimeters. Rectangles use Babylon's native LTC forward/deferred model; discs use the explicit bounded rectangle-forward and 16-gon LTC deferred model. Both participate in deterministic soft baked-GI and SH-probe sampling. Area lights cannot use realtime shadow generators or the ClusteredLightContainer.",
			inputSchema: z
				.object({
					shape: z.enum(["rectangle", "disc"]).describe("Authored Unity-style area shape."),
					name: z.string().min(1).max(256).optional().describe("Optional authored light name."),
					parentId: z.string().min(1).max(256).optional().describe("Optional regular parent-node id; clustered containers reject."),
					parentName: z.string().min(1).max(256).optional().describe("Exact parent-name fallback."),
					position: vector3.optional().describe("Local position in editor centimeters; defaults to [100,200,100]."),
					direction: vector3.optional().describe("Non-zero local one-sided emission direction; defaults to [0,-1,0]."),
					upDirection: vector3.optional().describe("Non-zero local orientation-up hint; defaults to [0,0,1]."),
					width: z.number().gt(0).max(10_000_000).optional().describe("Rectangle width in centimeters; defaults to 200."),
					height: z.number().gt(0).max(10_000_000).optional().describe("Rectangle height in centimeters; defaults to 100."),
					radius: z.number().gt(0).max(5_000_000).optional().describe("Disc radius in centimeters; defaults to 75."),
					color: z
						.tuple([z.number().min(0), z.number().min(0), z.number().min(0)])
						.optional()
						.describe("Linear diffuse RGB color."),
					specular: z
						.tuple([z.number().min(0), z.number().min(0), z.number().min(0)])
						.optional()
						.describe("Linear specular RGB color."),
					intensity: z.number().min(0).max(1_000_000).optional().describe("Native light intensity; defaults to 1."),
					range: z.number().gt(0).max(10_000_000).optional().describe("Bounded attenuation range in centimeters; defaults to 1000."),
					enabled: z.boolean().optional().describe("Initial enabled state; defaults to true."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_area_light", args)
	);

	server.registerTool(
		"get_area_light",
		{
			title: "Get area light",
			description:
				"Read one rectangle or disc area light without mutation, including its exact revision lease, local and world basis, dimensions, area, one-sided state, forward/deferred/baked models, native LTC readiness through configured deferred cameras, and explicit realtime-shadow limitation.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional().describe("Stable area-light id; preferred over name."),
					nodeName: z.string().min(1).max(256).optional().describe("Exact area-light name fallback."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_area_light", args)
	);

	server.registerTool(
		"set_area_light",
		{
			title: "Set area light",
			description:
				"Atomically update one area light under the exact revision returned by get_area_light. Shape switches, dimensions, orientation, transform, color, intensity, range, enabled state, and name advance the portable revision once and deliberately invalidate configured deferred cameras until their renderer data is rebuilt.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional().describe("Stable area-light id; preferred over name."),
					nodeName: z.string().min(1).max(256).optional().describe("Exact area-light name fallback."),
					expectedRevision: z.number().int().min(1).describe("Exact current revision; stale or missing leases reject before mutation."),
					shape: z.enum(["rectangle", "disc"]).optional(),
					name: z.string().min(1).max(256).optional(),
					position: vector3.optional().describe("Replacement local position in centimeters."),
					direction: vector3.optional().describe("Replacement non-zero local emission direction."),
					upDirection: vector3.optional().describe("Replacement non-zero local orientation-up hint."),
					width: z.number().gt(0).max(10_000_000).optional(),
					height: z.number().gt(0).max(10_000_000).optional(),
					radius: z.number().gt(0).max(5_000_000).optional(),
					color: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]).optional(),
					specular: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]).optional(),
					intensity: z.number().min(0).max(1_000_000).optional(),
					range: z.number().gt(0).max(10_000_000).optional(),
					enabled: z.boolean().optional(),
				})
				.strict()
				.refine(
					(value) =>
						["shape", "name", "position", "direction", "upDirection", "width", "height", "radius", "color", "specular", "intensity", "range", "enabled"].some(
							(key) => value[key as keyof typeof value] !== undefined
						),
					{ message: "Provide at least one area-light property to change." }
				),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_area_light", args)
	);

	server.registerTool(
		"get_light_cookie",
		{
			title: "Get light cookie",
			description:
				"Read one spot 2D, directional tiled-2D, or point cubemap cookie, including its exact revision lease, portable texture identity/readiness, projection controls, and every configured deferred camera's execution evidence. Returns cookie=null when unassigned.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional().describe("Stable light id; preferred over name."),
					nodeName: z.string().min(1).max(256).optional().describe("Exact light name fallback."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_light_cookie", args)
	);

	server.registerTool(
		"set_light_cookie",
		{
			title: "Set light cookie",
			description:
				"Assign or atomically update one Unity-style light cookie. Spot and directional lights require a project-local 2D texture; point lights require a project-local cubemap such as .env or .dds. Existing cookies require the exact revision from get_light_cookie. Changes deliberately invalidate configured deferred cameras until rebuild_deferred_lighting is called with each camera's own exact renderer-data selection revision.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional().describe("Stable light id; preferred over name."),
					nodeName: z.string().min(1).max(256).optional().describe("Exact light name fallback."),
					expectedRevision: z.number().int().min(1).optional().describe("Required exact current cookie revision when updating; omit only for the first assignment."),
					texturePath: z
						.string()
						.min(1)
						.max(1024)
						.optional()
						.describe("Project-relative cookie texture path. Required for the first assignment; omitted preserves the current texture."),
					enabled: z.boolean().optional().describe("Enable or suspend cookie modulation without clearing authored settings."),
					intensity: z.number().min(0).max(1).optional().describe("Cookie modulation strength: 0 is white/no modulation and 1 applies the authored color fully."),
					size: z
						.tuple([z.number().gt(0).max(10_000_000), z.number().gt(0).max(10_000_000)])
						.optional()
						.describe("Directional cookie world-space width/height in editor centimeters."),
					offset: z
						.tuple([z.number().min(-1_000_000).max(1_000_000), z.number().min(-1_000_000).max(1_000_000)])
						.optional()
						.describe("Directional tiled-cookie UV offset."),
					near: z.number().gt(0).max(1_000_000).optional().describe("Spot projection near clip in editor centimeters."),
					far: z.number().gt(0).max(10_000_000).optional().describe("Spot projection far clip in editor centimeters; must exceed near."),
					upDirection: vector3.optional().describe("Normalized projection-up hint used by spot and directional cookies."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_cookie", args)
	);

	server.registerTool(
		"clear_light_cookie",
		{
			title: "Clear light cookie",
			description:
				"Permanently clear one exact-revision light-cookie assignment and its portable projection settings after literal confirmation. The source asset file is preserved. Rebuild any deferred cameras returned by the result.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional().describe("Stable light id; preferred over name."),
					nodeName: z.string().min(1).max(256).optional().describe("Exact light name fallback."),
					expectedRevision: z.number().int().min(1).describe("Exact current revision returned by get_light_cookie."),
					confirm: z.literal(true).describe("Required acknowledgement that the light-cookie assignment and settings are removed."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_light_cookie", args)
	);

	server.registerTool(
		"set_light_properties",
		{
			title: "Set light properties",
			description:
				"Update all inspector-visible light values: transform/direction, diffuse/specular color, intensity, range, spot cone/exponent, PBR light parameters, and type-specific fields.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				position: z.array(z.number()).length(3).optional(),
				direction: z.array(z.number()).length(3).optional(),
				diffuse: z.array(z.number()).length(3).optional(),
				specular: z.array(z.number()).length(3).optional(),
				properties: z.record(z.string(), z.any()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_properties", args)
	);

	server.registerTool(
		"set_ibl_shadows",
		{
			title: "Set IBL shadows",
			description: "Enable/disable and configure the editor IBL Shadows rendering pipeline. Use resolutionExp, sampleDirections, shadowRemanence, and shadowOpacity.",
			inputSchema: z.object({ enabled: z.boolean().optional(), properties: z.record(z.string(), z.any()).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_ibl_shadows", args)
	);

	server.registerTool(
		"set_light_shadows",
		{
			title: "Set light shadows",
			description:
				"Enable or disable and fully configure a native Babylon shadow generator. Classic directional/spot shadows support hard, Poisson, exponential/blurred exponential, close-exponential/blurred close-exponential, PCF, and PCSS. " +
				"Point-light cube shadows support hard, Poisson, exponential, and close-exponential; use Poisson for soft point shadows. Cascaded directional shadows support hard, PCF, and PCSS. " +
				"Configure up to eight regular scene lights independently; the shared deferred runtime resolves their heterogeneous native maps simultaneously when the active backend's exact fragment-texture sampler budget permits it. " +
				"Choose `generatorType`: 'classic' (default, works for any shadow light) or 'cascaded' to use a CascadedShadowGenerator — ideal for large outdoor scenes and a directional sun light, but ONLY valid on a directional light. " +
				"The returned shadow evidence reports the effective native filter and all authored quality parameters. A light that casts shadows must remain a regular scene light, not in the ClusteredLightContainer. To stop casting, prefer `remove_light_shadows`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target light (preferred)."),
				nodeName: z.string().optional().describe("Name of the target light."),
				enabled: z.boolean().describe("Whether the light casts shadows."),
				generatorType: z
					.enum(["classic", "cascaded"])
					.optional()
					.describe(
						"Shadow generator type. 'classic' (default) for any shadow light; 'cascaded' (CascadedShadowGenerator) only for directional lights, best for large outdoor scenes."
					),
				mapSize: z
					.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)])
					.optional()
					.describe("Power-of-two shadow map resolution."),
				filter: z
					.enum(["hard", "poisson", "exponential", "blur-exponential", "close-exponential", "blur-close-exponential", "pcf", "pcss"])
					.optional()
					.describe("Native shadow filter. Defaults to hard for point lights and PCF otherwise; unsupported generator/light combinations are rejected."),
				filteringQuality: z.enum(["low", "medium", "high"]).optional().describe("PCF/PCSS sample quality. Defaults to high."),
				bias: z.number().min(0).max(1).optional().describe("Depth bias in 0..1."),
				normalBias: z.number().min(0).max(1).optional().describe("Receiver normal bias in 0..1."),
				darkness: z.number().min(0).max(1).optional().describe("Minimum shadow visibility in 0..1; 0 is fully dark."),
				blurScale: z.number().min(0).max(10).optional().describe("Poisson or exponential blur scale."),
				blurKernel: z.number().int().min(1).max(64).optional().describe("Kernel size for blurred exponential filters."),
				blurBoxOffset: z.number().min(0).max(10).optional().describe("Box blur offset when kernel blur is disabled."),
				useKernelBlur: z.boolean().optional().describe("Use kernel blur instead of box blur for blurred exponential filters."),
				depthScale: z.number().min(0.0001).max(1000).optional().describe("Exponential shadow depth scale."),
				contactHardeningLightSizeUVRatio: z.number().min(0).max(1).optional().describe("PCSS light size as a shadow-map UV ratio."),
				transparencyShadow: z.boolean().optional().describe("Allow transparent casters."),
				enableSoftTransparentShadow: z.boolean().optional().describe("Apply soft filtering to transparent shadow casters."),
				refreshRate: z
					.union([z.literal(0), z.literal(1), z.literal(2)])
					.optional()
					.describe("Shadow-map refresh: 0 once, 1 every frame, 2 every two frames."),
				numCascades: z.number().int().min(2).max(4).optional().describe("Directional cascade count, 2 through 4."),
				lambda: z.number().min(0).max(1).optional().describe("Cascade split blend in 0..1; closer to 1 favors logarithmic splits."),
				stabilizeCascades: z.boolean().optional().describe("Stabilize cascade projections against camera movement."),
				depthClamp: z.boolean().optional().describe("Clamp cascaded shadow depth to reduce near-plane clipping."),
				autoCalcDepthBounds: z.boolean().optional().describe("Automatically fit cascaded depth bounds to visible casters."),
				autoCalcDepthBoundsRefreshRate: z.number().int().min(0).max(240).optional().describe("Frames between automatic cascade-depth-bound updates."),
				cascadeBlendPercentage: z.number().min(0).max(1).optional().describe("Fraction of each cascade used to blend into the next."),
				penumbraDarkness: z.number().min(0).max(1).optional().describe("Cascaded PCSS penumbra-darkness correction."),
				useBlurExponentialShadowMap: z.boolean().optional().describe("Deprecated compatibility alias; true selects blur-exponential when filter is omitted."),
			}),
			annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_shadows", args)
	);

	server.registerTool(
		"remove_light_shadows",
		{
			title: "Remove light shadows",
			description:
				"Remove the shadow generator from a light so it stops casting shadows. " +
				"After removing shadows, a light can be moved into the scene's ClusteredLightContainer for performance with `add_light_to_clustered_container`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target light (preferred)."),
				nodeName: z.string().optional().describe("Name of the target light."),
			}),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_light_shadows", args)
	);

	server.registerTool(
		"create_clustered_light_container",
		{
			title: "Create clustered light container",
			description:
				"Create the scene's ClusteredLightContainer if it does not already exist. This is the performance-friendly home for all NON-shadow-casting lights. " +
				"Create it once, then add lights with `add_light_to_clustered_container`.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_clustered_light_container", args)
	);

	server.registerTool(
		"add_light_to_clustered_container",
		{
			title: "Add light to clustered container",
			description:
				"Move a non-shadow-casting light into the scene's ClusteredLightContainer for performance (e.g. many street lights in a city scene). " +
				"Do NOT add shadow-casting lights here — the container does not support them; keep those as regular scene lights.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the light to move (preferred)."),
				nodeName: z.string().optional().describe("Name of the light to move."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_light_to_clustered_container", args)
	);

	server.registerTool(
		"remove_light_from_clustered_container",
		{
			title: "Remove light from clustered container",
			description:
				"Remove a light from the scene's ClusteredLightContainer. The light is automatically added back to the scene as a regular light, " +
				"after which it can cast shadows again (e.g. with `set_light_shadows`).",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the light to remove (preferred)."),
				nodeName: z.string().optional().describe("Name of the light to remove."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_light_from_clustered_container", args)
	);
}

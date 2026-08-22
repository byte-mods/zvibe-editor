import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const transientMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Exact current scene Occlusion Culling revision returned by get_occlusion_culling.");
const objectRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Exact current mesh, camera, or area revision returned by get_occlusion_culling.");
const fingerprint = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 fingerprint returned by the corresponding inspect or read tool.");
const objectId = z.string().min(1).max(256).describe("Exact Babylon scene object id; names are not accepted because they can be ambiguous.");
const areaId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
	.describe("Stable Occlusion Area id returned by get_occlusion_culling or create_occlusion_culling_area.");
const finiteCoordinate = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const positiveExtent = z.number().finite().min(0.001).max(1_000_000_000);
const vector3 = z.tuple([finiteCoordinate, finiteCoordinate, finiteCoordinate]).describe("Three finite Babylon scene coordinates in centimeters: [x, y, z].");
const size3 = z.tuple([positiveExtent, positiveExtent, positiveExtent]).describe("Three strictly positive full extents in centimeters: [width, height, depth].");

const bakeSettingsPatch = z
	.object({
		smallestOccluder: z.number().finite().min(0).max(1_000_000_000).optional().describe("Minimum world-space occluder dimension in centimeters."),
		smallestHole: z.number().finite().min(0).max(1_000_000_000).optional().describe("Minimum opening size preserved by the conservative five-ray clearance bundle."),
		backfaceThreshold: z.number().finite().min(0).max(100).optional().describe("Maximum back-facing surface percentage allowed for a valid camera cell."),
		cellSize: z.number().finite().min(0.001).max(1_000_000_000).optional().describe("Maximum generated cell size in centimeters."),
		viewSamples: z.number().int().min(1).max(9).optional().describe("Bounded view sample count per cell axis set."),
		targetSamples: z.number().int().min(1).max(9).optional().describe("Bounded target sample count per static occludee."),
		maximumCells: z.number().int().min(1).max(4096).optional(),
		maximumRayTests: z.number().int().min(1).max(2_000_000).optional(),
		maximumRelationships: z.number().int().min(1).max(2_000_000).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "settings must change at least one bounded bake field.");

const meshSettingsPatch = z
	.object({
		staticOccluder: z.boolean().optional().describe("Whether this opaque static triangle mesh contributes to the baked occlusion test."),
		staticOccludee: z.boolean().optional().describe("Whether this mesh receives baked cell/PVS visibility."),
		dynamicOcclusion: z.boolean().optional().describe("Whether Babylon hardware occlusion queries supplement the static bake for this mesh."),
		queryMode: z.enum(["optimistic", "strict"]).optional(),
		queryRetryCount: z.number().int().min(0).max(1000).optional(),
		forceRenderingWhenOccluded: z.boolean().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "settings must change at least one mesh occlusion field.");

const areaPatch = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		center: vector3.optional(),
		size: size3.optional(),
		isViewVolume: z.boolean().optional(),
		enabled: z.boolean().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "patch must change at least one Occlusion Area field.");

/** Registers Unity-style static PVS authoring, bake, visualization, and Babylon query tools. */
export function registerOcclusionCullingTools(server: McpServer): void {
	server.registerTool(
		"get_occlusion_culling_capabilities",
		{
			title: "Get Occlusion Culling capabilities",
			description:
				"Read the portable Unity-style static occluder/occludee, camera, area, PVS bake, visualization, additive-runtime, hardware-query, work-limit, and explicit non-Umbra boundaries.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_occlusion_culling_capabilities", {})
	);

	server.registerTool(
		"get_occlusion_culling",
		{
			title: "Get Occlusion Culling",
			description:
				"Read exact scene configuration and bake revisions, bounded independently paged mesh/camera authoring, persisted bake status, active job, transient visualization, and per-camera runtime evidence before changing anything.",
			inputSchema: z
				.object({
					offset: z.number().int().min(0).max(1_000_000).optional().describe("Zero-based mesh page offset."),
					limit: z.number().int().min(1).max(500).optional().describe("Mesh page size, at most 500."),
					cameraOffset: z.number().int().min(0).max(1_000_000).optional().describe("Zero-based camera page offset."),
					cameraLimit: z.number().int().min(1).max(500).optional().describe("Camera page size, at most 500."),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_occlusion_culling", args)
	);

	server.registerTool(
		"set_occlusion_culling_settings",
		{
			title: "Set Occlusion Culling settings",
			description:
				"Under the exact scene revision, enable/disable the runtime and/or patch bounded Smallest Occluder, Smallest Hole, Backface Threshold, cell sampling, and work ceilings. Bake-affecting changes advance bakeRevision and make old data fail open.",
			inputSchema: z
				.object({ expectedRevision: revision, enabled: z.boolean().optional(), settings: bakeSettingsPatch.optional() })
				.strict()
				.refine((value) => value.enabled !== undefined || value.settings !== undefined, "Provide enabled and/or settings."),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_occlusion_culling_settings", args)
	);

	server.registerTool(
		"set_occlusion_culling_mesh",
		{
			title: "Set mesh Occlusion Culling",
			description:
				"Under exact scene and mesh revisions, patch Static Occluder, Static Occludee, and supplementary dynamic Babylon query policy. Static role changes invalidate the previous bake; dynamic meshes never become static occluders implicitly.",
			inputSchema: z.object({ meshId: objectId, expectedRevision: revision, expectedObjectRevision: objectRevision, settings: meshSettingsPatch }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_occlusion_culling_mesh", args)
	);

	server.registerTool(
		"set_camera_occlusion_culling",
		{
			title: "Set camera Occlusion Culling",
			description: "Under exact scene and camera revisions, enable or disable baked static PVS application for one camera without fabricating bake data.",
			inputSchema: z.object({ cameraId: objectId, expectedRevision: revision, expectedObjectRevision: objectRevision, enabled: z.boolean() }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_occlusion_culling", args)
	);

	server.registerTool(
		"create_occlusion_culling_area",
		{
			title: "Create Occlusion Culling area",
			description:
				"Under the exact scene revision, create one bounded axis-aligned Occlusion Area or camera View Volume. The full size must be positive; up to 256 authored areas and 4,096 generated cells are supported.",
			inputSchema: z
				.object({
					expectedRevision: revision,
					id: areaId.optional(),
					name: z.string().trim().min(1).max(128),
					center: vector3,
					size: size3,
					isViewVolume: z.boolean().optional(),
					enabled: z.boolean().optional(),
				})
				.strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_occlusion_culling_area", args)
	);

	server.registerTool(
		"update_occlusion_culling_area",
		{
			title: "Update Occlusion Culling area",
			description:
				"Under exact scene and area revisions, patch one area's name, center, positive size, View Volume role, or enabled state and invalidate the previous bake revision.",
			inputSchema: z.object({ areaId, expectedRevision: revision, expectedObjectRevision: objectRevision, patch: areaPatch }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("update_occlusion_culling_area", args)
	);

	server.registerTool(
		"delete_occlusion_culling_area",
		{
			title: "Delete Occlusion Culling area",
			description: "After confirm=true and under exact scene and area revisions, delete one authored Occlusion Area/View Volume and invalidate the previous bake revision.",
			inputSchema: z.object({ areaId, expectedRevision: revision, expectedObjectRevision: objectRevision, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_occlusion_culling_area", args)
	);

	server.registerTool(
		"inspect_occlusion_culling_bake",
		{
			title: "Inspect Occlusion Culling bake",
			description:
				"At the exact scene revision, validate opaque occluders, occludees, areas, generated cells, and work ceilings; return the exact SHA-256 source lease required by bake_occlusion_culling without mutating the scene.",
			inputSchema: z.object({ expectedRevision: revision }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_occlusion_culling_bake", args)
	);

	server.registerTool(
		"bake_occlusion_culling",
		{
			title: "Bake Occlusion Culling",
			description:
				"Run the bounded conservative ray/PVS bake only when the exact scene revision and inspected source fingerprint still match. Publication is atomic; source changes, cancellation, invalid cells, or work-limit failures never publish partial data.",
			inputSchema: z.object({ expectedRevision: revision, expectedSourceFingerprint: fingerprint }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_occlusion_culling", args)
	);

	server.registerTool(
		"cancel_occlusion_culling_bake",
		{
			title: "Cancel Occlusion Culling bake",
			description:
				"Request cooperative cancellation of the exact running bake job and revision. Completed cells remain transient and are never published after cancellation.",
			inputSchema: z
				.object({
					id: z.string().regex(/^occlusion-bake-[A-Za-z0-9_-]{1,128}$/),
					expectedJobRevision: z
						.number()
						.int()
						.min(1)
						.max(Number.MAX_SAFE_INTEGER)
						.describe("Exact running job control revision; progress updates do not invalidate this cancellation lease."),
				})
				.strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_occlusion_culling_bake", args)
	);

	server.registerTool(
		"clear_occlusion_culling_bake",
		{
			title: "Clear Occlusion Culling bake",
			description:
				"After confirm=true, delete only the exact persisted bake fingerprint under the current scene revision while preserving mesh, camera, settings, and area authoring.",
			inputSchema: z.object({ expectedRevision: revision, expectedBakeFingerprint: fingerprint, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_occlusion_culling_bake", args)
	);

	server.registerTool(
		"get_occlusion_culling_runtime",
		{
			title: "Get Occlusion Culling runtime",
			description:
				"Read exact per-camera baked-cell application, culled mesh ids, stale/fail-open reasons, additive configuration count, dynamic query mesh ids, hardware-query support, and runtime errors.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_occlusion_culling_runtime", {})
	);

	server.registerTool(
		"set_occlusion_culling_visualization",
		{
			title: "Set Occlusion Culling visualization",
			description:
				"Set transient editor-only cell/PVS debug drawing and optionally select an exact baked cell. Debug meshes are non-persistent, non-pickable, and excluded from save/export.",
			inputSchema: z
				.object({
					enabled: z.boolean().optional(),
					showCells: z.boolean().optional(),
					showVisible: z.boolean().optional(),
					showOccluded: z.boolean().optional(),
					selectedCellId: z.string().min(1).max(256).nullable().optional(),
				})
				.strict()
				.refine((value) => Object.keys(value).length > 0, "Provide at least one visualization change."),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_occlusion_culling_visualization", args)
	);

	server.registerTool(
		"reset_occlusion_culling",
		{
			title: "Reset Occlusion Culling",
			description:
				"After confirm=true and under the exact scene revision, remove all scene, mesh, camera, bake, job, visualization, and dynamic-query Occlusion Culling state and restore affected native visibility/query settings.",
			inputSchema: z.object({ expectedRevision: revision, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_occlusion_culling", args)
	);
}

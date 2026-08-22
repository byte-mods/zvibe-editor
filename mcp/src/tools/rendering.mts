import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerRenderingTools(server: McpServer): void {
	const profileSelector = { id: z.string().min(1).optional(), name: z.string().min(1).optional() };
	const profileConfigurations = z.record(z.enum(["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"]), z.any().nullable());
	const renderingTarget = z.enum(["web-performance", "mobile", "desktop", "xr", "custom"]);
	const sceneQuality = z.enum(["very-low", "low", "medium", "high"]);
	const profileQuality = z
		.object({
			textures: sceneQuality,
			shadows: sceneQuality,
			lods: sceneQuality,
			renderScale: z.number().min(0.25).max(2),
			performancePriority: z.enum(["backward-compatible", "intermediate", "aggressive"]),
			shadowsEnabled: z.boolean(),
			particlesEnabled: z.boolean(),
			postProcessesEnabled: z.boolean(),
			skipPointerMovePicking: z.boolean(),
		})
		.strict();
	const profileRequirements = z
		.object({
			webgl2: z.boolean().optional(),
			webgpu: z.boolean().optional(),
			drawBuffers: z.boolean().optional(),
			floatRenderTargets: z.boolean().optional(),
			halfFloatRenderTargets: z.boolean().optional(),
			depthTexture: z.boolean().optional(),
			computeShaders: z.boolean().optional(),
			multiview: z.boolean().optional(),
			minimumTextureSize: z.number().int().min(256).max(65_536).optional(),
			minimumDrawBuffers: z.number().int().min(1).max(16).optional(),
			minimumMsaaSamples: z.number().int().min(1).max(16).optional(),
		})
		.strict();
	const annotations = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) => ({
		readOnlyHint,
		destructiveHint,
		idempotentHint,
		openWorldHint: false,
	});
	const dynamicResolutionConfigurationPatch = z
		.object({
			mode: z
				.enum(["disabled", "fixed", "adaptive"])
				.optional()
				.describe("Disabled uses the profile's static renderScale; fixed uses fixedScale; adaptive samples frame cadence."),
			minimumScale: z.number().min(0.25).max(2).optional(),
			maximumScale: z.number().min(0.25).max(2).optional(),
			initialScale: z.number().min(0.25).max(2).optional(),
			fixedScale: z.number().min(0.25).max(2).optional(),
			targetFrameRate: z.number().min(15).max(240).optional(),
			sampleFrames: z.number().int().min(2).max(240).optional(),
			cooldownFrames: z.number().int().min(0).max(600).optional(),
			downscaleFrameTimeRatio: z.number().min(1.01).max(3).optional(),
			upscaleFrameTimeRatio: z.number().min(0.1).max(0.99).optional(),
			downscaleStep: z.number().min(0.01).max(0.5).optional(),
			upscaleStep: z.number().min(0.01).max(0.5).optional(),
			upscaler: z.enum(["browser-linear", "browser-pixelated"]).optional(),
		})
		.strict()
		.refine((value) => Object.keys(value).length > 0, "Provide at least one dynamic-resolution setting.");
	const renderReconstructionConfigurationPatch = z
		.object({
			mode: z
				.enum(["disabled", "spatial", "temporal"])
				.optional()
				.describe("Spatial reconstructs a low-resolution scene at full output size; temporal also accumulates history."),
			sharpness: z.number().min(0).max(1).optional(),
			edgeThreshold: z.number().min(0.001).max(1).optional(),
			historyWeight: z.number().min(0).max(0.98).optional(),
			disocclusionThreshold: z.number().min(0.001).max(1).optional(),
			jitterSamples: z.number().int().min(2).max(32).optional(),
			clampHistory: z.boolean().optional(),
			reprojectHistory: z.boolean().optional(),
			resetOnCameraCut: z.boolean().optional(),
			cameraCutPositionThreshold: z.number().min(0).max(1_000_000).optional(),
			cameraCutRotationThreshold: z.number().min(0).max(180).optional(),
		})
		.strict()
		.refine((value) => Object.keys(value).length > 0, "Provide at least one render-reconstruction setting.");

	server.registerTool(
		"list_rendering_profiles",
		{
			title: "List rendering profiles",
			description: "List at most 32 versioned camera/project render-pipeline profiles, active selection, quality tiers, target requirements, and bounded runtime evidence.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("list_rendering_profiles", {})
	);
	server.registerTool(
		"create_rendering_profile",
		{
			title: "Create rendering profile",
			description:
				"Create one versioned project render-pipeline profile from a Web Performance, Mobile, Desktop, XR, or Custom target preset. Optional closed quality/capability overrides are validated before publication; omit configurations to snapshot the target camera.",
			inputSchema: z
				.object({
					name: z.string().min(1),
					nodeId: z.string().optional().describe("Camera to snapshot when configurations are omitted."),
					nodeName: z.string().optional().describe("Camera name to snapshot when configurations are omitted."),
					target: renderingTarget.optional(),
					quality: profileQuality.optional(),
					requirements: profileRequirements.optional(),
					reconstruction: renderReconstructionConfigurationPatch.optional(),
					configurations: profileConfigurations.optional(),
				})
				.strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rendering_profile", args)
	);
	server.registerTool(
		"set_rendering_profile",
		{
			title: "Set rendering profile",
			description: "Version-leased update of a render-pipeline profile name, target, bounded quality tier, capability requirements, or camera configurations.",
			inputSchema: z
				.object({
					...profileSelector,
					revision: z.number().int().positive().optional(),
					name: z.string().min(1).optional(),
					target: renderingTarget.optional(),
					quality: profileQuality.optional(),
					requirements: profileRequirements.optional(),
					reconstruction: renderReconstructionConfigurationPatch.optional(),
					configurations: profileConfigurations.optional(),
				})
				.strict()
				.refine((value) => Boolean(value.id || value.name), "Provide id or name."),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rendering_profile", args)
	);
	server.registerTool(
		"apply_rendering_profile",
		{
			title: "Apply rendering profile",
			description:
				"Apply every camera setting and optionally activate the version-leased profile as the scene's project pipeline, validating device capabilities before changing global render scale, quality, performance, shadows, particles, and post-process state.",
			inputSchema: z
				.object({
					...profileSelector,
					revision: z.number().int().positive().optional(),
					nodeId: z.string().optional(),
					nodeName: z.string().optional(),
					activateProject: z.boolean().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.id && !value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name." });
					}
					if (value.activateProject && value.revision === undefined) {
						context.addIssue({ code: "custom", message: "Project activation requires the exact revision." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_rendering_profile", args)
	);
	server.registerTool(
		"get_rendering_profile_runtime",
		{
			title: "Get rendering profile runtime",
			description:
				"Read the active project render-pipeline profile, exact applied quality state, backend capability table, compatibility errors/warnings, and camera-application evidence.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_rendering_profile_runtime", {})
	);
	server.registerTool(
		"clear_active_rendering_profile",
		{
			title: "Clear active rendering profile",
			description:
				"Clear the exact active project rendering-profile lease and restore the pre-activation global render-quality baseline. Camera-authored post-process settings remain explicit camera data.",
			inputSchema: z.object({ id: z.string().min(1), revision: z.number().int().positive(), confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_active_rendering_profile", args)
	);
	server.registerTool(
		"delete_rendering_profile",
		{
			title: "Delete rendering profile",
			description: "Delete one inactive, unreferenced rendering profile under its exact current revision and literal confirmation.",
			inputSchema: z
				.object({ ...profileSelector, revision: z.number().int().positive(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.id || value.name), "Provide id or name."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_rendering_profile", args)
	);
	server.registerTool(
		"get_dynamic_resolution",
		{
			title: "Get dynamic resolution",
			description:
				"Read one rendering profile's versioned dynamic-resolution policy and, when active, bounded live frame-cadence, requested/effective scale, hardware scaling, hysteresis, cooldown, presentation upscaler, warning, and scale-change evidence. Omitting id/name selects the active profile.",
			inputSchema: z
				.object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
				.strict()
				.refine((value) => !(value.id && value.name), "Provide id or name, not both."),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_dynamic_resolution", args)
	);
	server.registerTool(
		"set_dynamic_resolution",
		{
			title: "Set dynamic resolution",
			description:
				"Update one exact rendering-profile revision with a closed partial disabled/fixed/adaptive policy. The active profile restarts through the shared editor/export runtime. Adaptive mode measures engine frame cadence, uses a complete bounded sample window plus asymmetric hysteresis/cooldown, and never claims GPU timing, FSR, DLSS, or XeSS.",
			inputSchema: z
				.object({
					id: z.string().min(1).optional(),
					name: z.string().min(1).optional(),
					revision: z.number().int().positive(),
					configuration: dynamicResolutionConfigurationPatch,
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.id && !value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name." });
					}
					if (value.id && value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name, not both." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_dynamic_resolution", args)
	);
	server.registerTool(
		"reset_dynamic_resolution_runtime",
		{
			title: "Reset dynamic resolution runtime",
			description:
				"Under the exact active rendering-profile lease, clear bounded cadence/history counters and return fixed/adaptive execution to its configured scale without changing persisted settings.",
			inputSchema: z
				.object({ id: z.string().min(1).optional(), name: z.string().min(1).optional(), revision: z.number().int().positive() })
				.strict()
				.superRefine((value, context) => {
					if (!value.id && !value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name." });
					}
					if (value.id && value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name, not both." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_dynamic_resolution_runtime", args)
	);
	server.registerTool(
		"get_render_reconstruction",
		{
			title: "Get render reconstruction",
			description:
				"Read one profile's versioned spatial/temporal reconstruction policy and, when active, exact low-resolution source/full-resolution output sizes, shader readiness, velocity availability, history/jitter counters, reset reason, post-process order, warnings, and errors. Omitting id/name selects the active profile.",
			inputSchema: z
				.object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
				.strict()
				.refine((value) => !(value.id && value.name), "Provide id or name, not both."),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_render_reconstruction", args)
	);
	server.registerTool(
		"set_render_reconstruction",
		{
			title: "Set render reconstruction",
			description:
				"Update one exact rendering-profile revision with a closed partial disabled, full-resolution spatial, or velocity-reprojected temporal reconstruction policy. Active profiles rebuild through the shared editor/export runtime. This bounded implementation does not claim FSR, DLSS, XeSS, or vendor pixel identity.",
			inputSchema: z
				.object({
					id: z.string().min(1).optional(),
					name: z.string().min(1).optional(),
					revision: z.number().int().positive(),
					configuration: renderReconstructionConfigurationPatch,
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.id && !value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name." });
					}
					if (value.id && value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name, not both." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_render_reconstruction", args)
	);
	server.registerTool(
		"reset_render_reconstruction_history",
		{
			title: "Reset render reconstruction history",
			description:
				"Under the exact active rendering-profile lease, invalidate temporal history, restart Halton jitter, and preserve the current reconstruction policy and source scale. Spatial or inactive profiles reject with an actionable error.",
			inputSchema: z
				.object({ id: z.string().min(1).optional(), name: z.string().min(1).optional(), revision: z.number().int().positive() })
				.strict()
				.superRefine((value, context) => {
					if (!value.id && !value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name." });
					}
					if (value.id && value.name) {
						context.addIssue({ code: "custom", message: "Provide id or name, not both." });
					}
				}),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_render_reconstruction_history", args)
	);
	const onTileFingerprint = z
		.string()
		.length(16)
		.regex(/^[0-9a-f]{16}$/)
		.describe("Exact 16-hex On-Tile state fingerprint returned by get_on_tile_rendering.");
	const onTileLease = {
		expectedRevision: z.number().int().positive().describe("Exact current On-Tile configuration revision."),
		expectedFingerprint: onTileFingerprint,
	};
	const onTilePostProcessing = z
		.object({
			enabled: z.boolean(),
			exposure: z.number().min(-16).max(16),
			contrast: z.number().min(0).max(4),
			saturation: z.number().min(0).max(4),
			vignette: z.number().min(0).max(1),
			vignetteSmoothness: z.number().min(0.01).max(1),
		})
		.strict();
	const onTileSettings = z
		.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.number().finite())
		.refine((value) => Object.keys(value).length <= 16, "At most 16 provider settings are allowed.");
	const onTileSelectorFields = { id: z.string().min(1).max(128).optional(), name: z.string().min(1).max(128).optional() };
	server.registerTool(
		"get_on_tile_rendering",
		{
			title: "Get On-Tile rendering",
			description:
				"Read the exact version-1 Tile-Only policy, fingerprint, active-camera/backend eligibility, incompatible camera/graph features, reversible suppression intent, registered extensions, and observed portable composite evidence. Native tile-memory and GPU bandwidth evidence remain explicitly unavailable.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_on_tile_rendering", {})
	);
	server.registerTool(
		"set_on_tile_rendering",
		{
			title: "Set On-Tile rendering",
			description:
				"Exact-leased update of opt-in enablement, off/warn/enforce validation, Tile-Only Mode, or the complete bounded fused color adjustment/vignette block. The real editor preview reapplies atomically with Undo/Redo; enforce mode suppresses incompatible runtime features without deleting authored definitions.",
			inputSchema: z
				.object({
					...onTileLease,
					enabled: z.boolean().optional(),
					validationMode: z.enum(["off", "warn", "enforce"]).optional(),
					tileOnlyMode: z.boolean().optional(),
					postProcessing: onTilePostProcessing.optional(),
				})
				.strict()
				.refine((value) => ["enabled", "validationMode", "tileOnlyMode", "postProcessing"].some((key) => key in value), "Provide at least one On-Tile setting."),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_on_tile_rendering", args)
	);
	server.registerTool(
		"list_on_tile_renderer_providers",
		{
			title: "List On-Tile renderer providers",
			description:
				"List bounded built-in and trusted project-code provider descriptors, versions, parameter defaults/ranges, and extension limits without returning executable shader source.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("list_on_tile_renderer_providers", {})
	);
	server.registerTool(
		"create_on_tile_renderer_extension",
		{
			title: "Create On-Tile renderer extension",
			description:
				"Create one exact-leased ordered instance of a currently registered fused On-Tile color provider, validate bounded numeric settings, rebuild preview, and add one Undo/Redo operation.",
			inputSchema: z
				.object({
					...onTileLease,
					name: z.string().min(1).max(128),
					providerId: z.string().min(1).max(128),
					enabled: z.boolean().optional(),
					order: z.number().min(-10_000).max(10_000).optional(),
					settings: onTileSettings.optional(),
				})
				.strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_on_tile_renderer_extension", args)
	);
	server.registerTool(
		"set_on_tile_renderer_extension",
		{
			title: "Set On-Tile renderer extension",
			description:
				"Update one exact-leased extension name, enablement, order, or complete bounded numeric setting map, then atomically validate/rebuild the fused preview with Undo/Redo.",
			inputSchema: z
				.object({
					...onTileSelectorFields,
					...onTileLease,
					newName: z.string().min(1).max(128).optional(),
					enabled: z.boolean().optional(),
					order: z.number().min(-10_000).max(10_000).optional(),
					settings: onTileSettings.optional(),
				})
				.strict()
				.refine((value) => Boolean(value.id || value.name) && !(value.id && value.name), "Provide exactly one extension id or name.")
				.refine((value) => ["newName", "enabled", "order", "settings"].some((key) => key in value), "Provide at least one extension setting."),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_on_tile_renderer_extension", args)
	);
	server.registerTool(
		"delete_on_tile_renderer_extension",
		{
			title: "Delete On-Tile renderer extension",
			description: "Delete one exact-leased extension under literal confirmation, rebuild the portable composite, and preserve Undo/Redo restoration.",
			inputSchema: z
				.object({ ...onTileSelectorFields, ...onTileLease, confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.id || value.name) && !(value.id && value.name), "Provide exactly one extension id or name."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_on_tile_renderer_extension", args)
	);
	server.registerTool(
		"validate_on_tile_rendering",
		{
			title: "Validate On-Tile rendering",
			description:
				"Run a no-write eligibility audit over the active camera, WebGL/WebGPU backend, external camera post-processes, enabled custom render passes, provider registration, and settings. Every finding has a stable code, severity, target, and action.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("validate_on_tile_rendering", {})
	);
	server.registerTool(
		"apply_on_tile_rendering",
		{
			title: "Apply On-Tile rendering",
			description:
				"Under the exact policy lease, validate and rebuild one real Babylon portable composite. Enforce mode reversibly detaches incompatible camera effects and suppresses custom graph execution while preserving authored state; failures restore the prior runtime.",
			inputSchema: z.object(onTileLease).strict(),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_on_tile_rendering", args)
	);
	server.registerTool(
		"get_on_tile_rendering_runtime",
		{
			title: "Get On-Tile rendering runtime",
			description:
				"Read current backend/camera, composite attachment/readiness, real apply-frame count, active extensions, reversibly suppressed feature ids, runtime error, and explicit null native tile-memory/bandwidth evidence without advancing a frame.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_on_tile_rendering_runtime", {})
	);
	const shaderVariantFingerprint = z
		.string()
		.length(16)
		.regex(/^[0-9a-f]{16}$/)
		.describe("Exact 16-hex fingerprint returned by get_shader_variant_collection.");
	const shaderVariantLease = {
		expectedRevision: z.number().int().positive().describe("Exact current Shader Variant Collection revision."),
		expectedFingerprint: shaderVariantFingerprint,
	};
	server.registerTool(
		"get_shader_variant_collection",
		{
			title: "Get Shader Variant Collection",
			description:
				"Read Project Settings > Graphics automatic tracing/prewarming policy, the exact collection revision/fingerprint, bounded portable material/effect records, current resource/backend validation, and runtime evidence. This does not claim Unity GraphicsStateCollection or native PSO identity.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_shader_variant_collection", {})
	);
	server.registerTool(
		"set_shader_variant_collection",
		{
			title: "Set Shader Variant Collection",
			description:
				"Under the exact revision/fingerprint lease, update enablement, automatic rendered-variant tracing, automatic scene-load prewarming, the 1–4096 collection cap, or the 1–512 startup-prewarm cap. Reconfigures the shared editor/export runtime atomically and creates one Undo/Redo entry.",
			inputSchema: z
				.object({
					...shaderVariantLease,
					enabled: z.boolean().optional(),
					automaticTracing: z.boolean().optional(),
					automaticPrewarming: z.boolean().optional(),
					maximumVariants: z.number().int().min(1).max(4_096).optional(),
					maximumPrewarmPerLoad: z.number().int().min(1).max(512).optional(),
				})
				.strict()
				.refine(
					(value) => ["enabled", "automaticTracing", "automaticPrewarming", "maximumVariants", "maximumPrewarmPerLoad"].some((key) => key in value),
					"Provide at least one Shader Variant Collection setting."
				),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_shader_variant_collection", args)
	);
	server.registerTool(
		"clear_shader_variant_collection",
		{
			title: "Clear Shader Variant Collection",
			description:
				"Delete all retained portable variants under the exact collection lease and literal confirmation while preserving the Graphics tracing/prewarming policy. Reconfigures runtime and creates one Undo/Redo entry.",
			inputSchema: z.object({ ...shaderVariantLease, confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_shader_variant_collection", args)
	);
	server.registerTool(
		"trace_shader_variant_frame",
		{
			title: "Trace Shader Variant Frame",
			description:
				"Capture actual ready Babylon effects from the current bounded active-mesh frame into the exact portable collection, deduplicate records, increment revision only when records are added, and make the authored capture Undo/Redo-able.",
			inputSchema: z.object(shaderVariantLease).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("trace_shader_variant_frame", args)
	);
	server.registerTool(
		"prewarm_shader_variant_collection",
		{
			title: "Prewarm Shader Variant Collection",
			description:
				"Under the exact collection lease, resolve unique retained material/mesh/submesh assignments and run bounded four-wide Babylon forceCompilationAsync prewarming with per-request timeout, skipped/stale counts, and contained error evidence. Authored metadata is unchanged.",
			inputSchema: z.object(shaderVariantLease).strict(),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("prewarm_shader_variant_collection", args)
	);
	server.registerTool(
		"validate_shader_variant_collection",
		{
			title: "Validate Shader Variant Collection",
			description:
				"Run a pure bounded audit for missing, stale, class-changed, backend-mismatched, or ambiguous material/mesh/submesh records and return stable issue codes plus exact revision/fingerprint evidence.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("validate_shader_variant_collection", {})
	);
	server.registerTool(
		"get_shader_variant_collection_runtime",
		{
			title: "Get Shader Variant Collection Runtime",
			description:
				"Read actual backend, tracing/prewarming state, frame/variant/drop counts, prewarm run/attempt/success/skip/failure counts, and bounded errors without tracing a frame or compiling a material.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_shader_variant_collection_runtime", {})
	);
	const rendererDataSettings = z
		.object({
			version: z.literal(1),
			renderingPath: z.enum(["forward", "forward-plus", "deferred"]),
			fallbackToForward: z.boolean(),
			layerMask: z.number().int().min(0).max(4_294_967_295),
			postProcessesEnabled: z.boolean(),
			depthTexture: z
				.object({
					mode: z.enum(["disabled", "linear", "non-linear", "camera-space-z"]),
					force32BitsFloat: z.boolean(),
					includeTransparent: z.boolean(),
				})
				.strict(),
			depthPrimingMode: z.enum(["disabled", "auto", "forced"]),
			forwardPlus: z
				.object({
					horizontalTiles: z.number().int().min(1).max(256),
					verticalTiles: z.number().int().min(1).max(256),
					depthSlices: z.number().int().min(1).max(256),
					maxRange: z.number().min(0.01).max(1_000_000),
				})
				.strict(),
			rendererFeatureInstanceIds: z.array(z.string().min(1).max(128)).max(64).nullable(),
		})
		.strict();
	const rendererDataPath = z.string().min(1).max(4096).endsWith(".rendererdata.json").describe("Project-relative .rendererdata.json asset path.");
	const contentRevision = z
		.string()
		.length(64)
		.regex(/^[0-9a-f]+$/)
		.describe("Exact lowercase SHA-256 content revision returned by a read/list tool.");
	server.registerTool(
		"create_renderer_data_asset",
		{
			title: "Create renderer-data asset",
			description:
				"Create one atomic versioned .rendererdata.json project asset. Use a preset renderingPath or provide the complete closed settings object for native forward, Babylon clustered Forward+, explicit deferred fallback/refusal, layer mask, post-process, per-camera depth texture/priming, cluster tiling, and renderer-feature selection.",
			inputSchema: z
				.object({
					path: rendererDataPath,
					name: z.string().min(1).max(128),
					renderingPath: z.enum(["forward", "forward-plus", "deferred"]).optional(),
					settings: rendererDataSettings.optional(),
				})
				.strict()
				.refine((value) => !(value.renderingPath && value.settings), "Provide renderingPath or settings, not both."),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_renderer_data_asset", args)
	);
	server.registerTool(
		"list_renderer_data_assets",
		{
			title: "List renderer-data assets",
			description:
				"List bounded renderer-data project assets, malformed-file evidence, exact content revisions, persisted default/per-camera snapshots, and current Babylon runtime/fallback evidence.",
			inputSchema: z
				.object({ search: z.string().max(256).optional(), offset: z.number().int().min(0).max(511).optional(), limit: z.number().int().min(1).max(128).optional() })
				.strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("list_renderer_data_assets", args)
	);
	server.registerTool(
		"get_renderer_data_asset",
		{
			title: "Get renderer-data asset",
			description: "Read one complete validated renderer-data asset and its exact SHA-256 content lease without changing scene state.",
			inputSchema: z.object({ path: rendererDataPath }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_renderer_data_asset", args)
	);
	server.registerTool(
		"update_renderer_data_asset",
		{
			title: "Update renderer-data asset",
			description:
				"Atomically replace one exact renderer-data asset revision. Existing scene assignments retain their portable snapshot until explicitly reassigned, preventing silent runtime drift.",
			inputSchema: z
				.object({ path: rendererDataPath, expectedRevision: contentRevision, name: z.string().min(1).max(128).optional(), settings: rendererDataSettings.optional() })
				.strict()
				.refine((value) => value.name !== undefined || value.settings !== undefined, "Provide name or settings."),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("update_renderer_data_asset", args)
	);
	server.registerTool(
		"assign_renderer_data",
		{
			title: "Assign renderer data",
			description:
				"Under exact asset and scene-selection leases, snapshot a renderer-data asset as the scene default or one camera override, then atomically apply native masks, depth targets, post-process policy, Forward+ configuration, and renderer-feature selection. Unsupported no-fallback requests reject and roll back.",
			inputSchema: z
				.object({
					path: rendererDataPath,
					expectedRevision: contentRevision,
					selectionRevision: z.number().int().positive(),
					cameraId: z.string().min(1).max(256).optional(),
				})
				.strict(),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("assign_renderer_data", args)
	);
	server.registerTool(
		"clear_renderer_data_assignment",
		{
			title: "Clear renderer-data assignment",
			description:
				"Clear the exact default or per-camera renderer-data selection and restore every camera mask, owned depth renderer, clustered-light setting, and post-process baseline.",
			inputSchema: z.object({ selectionRevision: z.number().int().positive(), cameraId: z.string().min(1).max(256).optional() }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_renderer_data_assignment", args)
	);
	server.registerTool(
		"get_renderer_data_state",
		{
			title: "Get renderer-data state",
			description:
				"Read exact default/per-camera renderer-data snapshots and honest native runtime evidence for every camera: requested/effective path, fallbacks, masks, depth texture readiness and size, Forward+ support/lights/tiles, independently executing multi-camera deferred/forward hybrid composition over the shared scene G-buffer, up to eight simultaneous heterogeneous classic/cube/cascaded native shadow sources with exact map/sampler/readiness evidence, feature selection, warnings, and errors.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_renderer_data_state", {})
	);
	server.registerTool(
		"get_deferred_lighting_state",
		{
			title: "Get deferred lighting state",
			description:
				"Read distinct bounded native deferred-lighting runtime evidence for all requesting cameras or one exact camera: renderer-data selection revision, effective fallback, shared MRT plus camera-owned albedo and emissive allocation/readiness, projected decal and exact emissive evidence, shader backend, viewport, deferred counts, and up to eight simultaneous heterogeneous classic/cube/cascaded shadow sources with per-light slot/filter/quality/map/cascade/caster/receiver/sampler/readiness plus aggregate backend-budget/frame detail, native forward composition, warnings, errors, and explicit limitations.",
			inputSchema: z.object({ cameraId: z.string().min(1).max(256).optional() }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_deferred_lighting_state", args)
	);
	server.registerTool(
		"rebuild_deferred_lighting",
		{
			title: "Rebuild deferred lighting",
			description:
				"Under the exact renderer-data selection lease, atomically rebuild all selected camera contexts after decal, material, emissive, IBL, shadow-source-set, or mesh changes while returning the requested camera's distinct bounded native deferred, projected-decal, emissive, simultaneous heterogeneous classic/cube/cascaded shadow, and forward-composition evidence without changing any asset snapshot. Other selected deferred cameras remain configured over the shared G-buffer; returns exact source/map/sampler compatibility, fallback, allocation/readiness, consumer/frame counts, warnings, errors, and limitations.",
			inputSchema: z.object({ cameraId: z.string().min(1).max(256), selectionRevision: z.number().int().positive() }).strict(),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("rebuild_deferred_lighting", args)
	);
	server.registerTool(
		"delete_renderer_data_asset",
		{
			title: "Delete renderer-data asset",
			description: "Permanently delete one exact renderer-data file only when it has no default or camera assignment in the current scene.",
			inputSchema: z.object({ path: rendererDataPath, expectedRevision: contentRevision, confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_renderer_data_asset", args)
	);
	const volumeReference = z.object({ id: z.string().optional(), name: z.string().optional() });
	server.registerTool(
		"list_rendering_volumes",
		{
			title: "List rendering volumes",
			description: "List camera rendering volumes, including priority, edge blend distance, and global weight.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_rendering_volumes", {})
	);
	server.registerTool(
		"create_rendering_volume",
		{
			title: "Create rendering volume",
			description: "Create an axis-aligned 3D volume that blends its rendering profile by distance and weight. Overlapping volumes compose from low to high priority.",
			inputSchema: z.object({
				name: z.string().min(1),
				profileId: z.string(),
				center: z.array(z.number()).length(3).optional(),
				size: z.array(z.number().positive()).length(3).optional(),
				priority: z.number().optional(),
				blendDistance: z.number().nonnegative().optional().describe("World-space falloff distance outside the volume bounds. Defaults to 0 (hard edge)."),
				weight: z.number().min(0).max(1).optional().describe("Maximum influence of this volume. Defaults to 1."),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rendering_volume", args)
	);
	server.registerTool(
		"set_rendering_volume",
		{
			title: "Set rendering volume",
			description: "Change a rendering volume's profile, bounds, priority, edge blend distance, weight, or enabled state.",
			inputSchema: volumeReference.extend({
				profileId: z.string().optional(),
				center: z.array(z.number()).length(3).optional(),
				size: z.array(z.number().positive()).length(3).optional(),
				priority: z.number().optional(),
				blendDistance: z.number().nonnegative().optional(),
				weight: z.number().min(0).max(1).optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rendering_volume", args)
	);
	server.registerTool(
		"evaluate_rendering_volumes",
		{
			title: "Evaluate rendering volumes",
			description:
				"Evaluate and apply every enabled rendering volume influencing the active camera. Returns each contribution's blendFactor and the highest-priority volume in the legacy volume field.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("evaluate_rendering_volumes", {})
	);
	server.registerTool(
		"delete_rendering_volume",
		{ title: "Delete rendering volume", description: "Delete a volume without deleting its reusable rendering profile.", inputSchema: volumeReference },
		async (args): Promise<CallToolResult> => callTextTool("delete_rendering_volume", args)
	);

	const cameraStackSelector = {
		stackId: z.string().min(1).max(128).optional().describe("Stable stack id; preferred over stackName."),
		stackName: z.string().min(1).max(128).optional().describe("Exact stack name when its id is unavailable."),
	};
	const cameraStackViewportMode = z.enum(["inherit-base", "camera"]);
	const cameraStackOverlayFields = {
		cameraId: z.string().min(1).max(128).optional(),
		enabled: z.boolean().optional(),
		order: z.number().int().min(-1000).max(1000).optional(),
		clearColor: z.boolean().optional(),
		clearDepth: z.boolean().optional(),
		postProcessing: z.boolean().optional(),
		viewportMode: cameraStackViewportMode.optional(),
	};
	server.registerTool(
		"list_camera_stacks",
		{
			title: "List camera stacks",
			description: "List a bounded page of versioned base/overlay camera stacks, the exact active lease, up to 64 available cameras, and current ordered runtime evidence.",
			inputSchema: z.object({ offset: z.number().int().min(0).max(31).optional(), limit: z.number().int().min(1).max(32).optional() }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("list_camera_stacks", args)
	);
	server.registerTool(
		"create_camera_stack",
		{
			title: "Create camera stack",
			description:
				"Create one inactive schema-v1 camera stack with a real Babylon base camera and explicit base color/depth clear policy. Add overlays separately before applying it.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(128),
					baseCameraId: z.string().min(1).max(128),
					enabled: z.boolean().optional(),
					baseClearColor: z.boolean().optional(),
					baseClearDepth: z.boolean().optional(),
				})
				.strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_camera_stack", args)
	);
	server.registerTool(
		"set_camera_stack",
		{
			title: "Set camera stack",
			description:
				"Version-leased update of a camera stack's name, enabled state, base camera, or base clear policy. Active stacks are re-applied atomically at the new revision.",
			inputSchema: z
				.object({
					...cameraStackSelector,
					revision: z.number().int().positive(),
					newName: z.string().min(1).max(128).optional(),
					enabled: z.boolean().optional(),
					baseCameraId: z.string().min(1).max(128).optional(),
					baseClearColor: z.boolean().optional(),
					baseClearDepth: z.boolean().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.stackId && !value.stackName) {
						context.addIssue({ code: "custom", message: "Provide stackId or stackName." });
					}
					if ([value.newName, value.enabled, value.baseCameraId, value.baseClearColor, value.baseClearDepth].every((entry) => entry === undefined)) {
						context.addIssue({ code: "custom", message: "Provide at least one stack field to update." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_stack", args)
	);
	server.registerTool(
		"add_camera_stack_overlay",
		{
			title: "Add camera stack overlay",
			description:
				"Add one of at most eight ordered overlay cameras under an exact stack revision, with explicit color/depth clear, post-process, and base-viewport inheritance policy.",
			inputSchema: z
				.object({
					...cameraStackSelector,
					revision: z.number().int().positive(),
					cameraId: z.string().min(1).max(128),
					enabled: z.boolean().optional(),
					order: z.number().int().min(-1000).max(1000).optional(),
					clearColor: z.boolean().optional(),
					clearDepth: z.boolean().optional(),
					postProcessing: z.boolean().optional(),
					viewportMode: cameraStackViewportMode.optional(),
				})
				.strict()
				.refine((value) => Boolean(value.stackId || value.stackName), "Provide stackId or stackName."),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("add_camera_stack_overlay", args)
	);
	server.registerTool(
		"set_camera_stack_overlay",
		{
			title: "Set camera stack overlay",
			description: "Version-leased update of one stable overlay entry. Active stacks rebuild atomically while preserving their original pre-stack camera baseline.",
			inputSchema: z
				.object({
					...cameraStackSelector,
					revision: z.number().int().positive(),
					overlayId: z.string().min(1).max(128),
					...cameraStackOverlayFields,
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.stackId && !value.stackName) {
						context.addIssue({ code: "custom", message: "Provide stackId or stackName." });
					}
					if (Object.keys(cameraStackOverlayFields).every((key) => value[key as keyof typeof value] === undefined)) {
						context.addIssue({ code: "custom", message: "Provide at least one overlay field to update." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_stack_overlay", args)
	);
	server.registerTool(
		"remove_camera_stack_overlay",
		{
			title: "Remove camera stack overlay",
			description: "Remove one stable overlay under the exact current stack revision and atomically re-apply the stack when active.",
			inputSchema: z
				.object({ ...cameraStackSelector, revision: z.number().int().positive(), overlayId: z.string().min(1).max(128) })
				.strict()
				.refine((value) => Boolean(value.stackId || value.stackName), "Provide stackId or stackName."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_camera_stack_overlay", args)
	);
	server.registerTool(
		"apply_camera_stack",
		{
			title: "Apply camera stack",
			description:
				"Activate an exact stack revision, assigning Babylon's ordered active camera list and bounded per-camera clear, viewport, and attached-post-process behavior atomically.",
			inputSchema: z
				.object({ ...cameraStackSelector, revision: z.number().int().positive() })
				.strict()
				.refine((value) => Boolean(value.stackId || value.stackName), "Provide stackId or stackName."),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_camera_stack", args)
	);
	server.registerTool(
		"clear_active_camera_stack",
		{
			title: "Clear active camera stack",
			description:
				"Clear the exact active stack lease and restore the pre-activation active camera list, individual camera selection, overlay viewports, and post-process arrays.",
			inputSchema: z.object({ stackId: z.string().min(1).max(128), revision: z.number().int().positive(), confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_active_camera_stack", args)
	);
	server.registerTool(
		"delete_camera_stack",
		{
			title: "Delete camera stack",
			description: "Delete one inactive stack under its exact current revision and literal confirmation; cameras and their post-process assets remain untouched.",
			inputSchema: z
				.object({ ...cameraStackSelector, revision: z.number().int().positive(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.stackId || value.stackName), "Provide stackId or stackName."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_camera_stack", args)
	);
	server.registerTool(
		"get_camera_stack_runtime",
		{
			title: "Get camera stack runtime",
			description:
				"Read the current stack backend, exact lease, ordered cameras, effective viewports/layer masks/post-process counts, latest render sequence, clear operations, suppression evidence, errors, and limitations.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_camera_stack_runtime", {})
	);

	const renderingLayerSelector = {
		layerId: z.string().min(1).max(128).optional().describe("Stable rendering-layer id; preferred over layerName."),
		layerName: z.string().min(1).max(128).optional().describe("Exact rendering-layer name."),
	};
	const rendererListSelector = {
		rendererListId: z.string().min(1).max(128).optional().describe("Stable renderer-list id; preferred over rendererListName."),
		rendererListName: z.string().min(1).max(128).optional().describe("Exact renderer-list name."),
	};
	const nodeSelector = {
		nodeId: z.string().min(1).max(256).optional(),
		nodeName: z.string().min(1).max(256).optional(),
	};
	const layerIds = z
		.array(z.string().min(1).max(128))
		.max(32)
		.refine((values) => new Set(values).size === values.length, "Layer ids must be unique.");
	const unsignedMask = z.number().int().min(0).max(4_294_967_295);
	const renderingSortMode = z.enum(["none", "frontToBack", "backToFront", "material", "defaultTransparent"]);
	const rendererListFields = {
		name: z.string().min(1).max(128).optional(),
		enabled: z.boolean().optional(),
		cameraId: z.string().min(1).max(256).nullable().optional(),
		meshIds: z
			.array(z.string().min(1).max(256))
			.max(4096)
			.refine((values) => new Set(values).size === values.length, "Mesh ids must be unique.")
			.optional(),
		includeDescendants: z.boolean().optional(),
		includeLayerMask: unsignedMask.nullable().optional(),
		excludeLayerMask: unsignedMask.optional(),
		respectCameraLayerMask: z.boolean().optional(),
		renderingGroupIds: z
			.array(z.number().int().min(0).max(3))
			.max(4)
			.refine((values) => new Set(values).size === values.length, "Rendering group ids must be unique.")
			.optional(),
		queue: z.enum(["all", "opaque", "alphaTest", "transparent"]).optional(),
		sortMode: renderingSortMode.optional(),
		includeDisabled: z.boolean().optional(),
		includeInvisible: z.boolean().optional(),
	};
	server.registerTool(
		"list_rendering_layers",
		{
			title: "List rendering layers",
			description:
				"List named native 32-bit rendering layers, all four Babylon rendering-group clear/sort policies, and exact mesh/camera/light mask usage. These masks drive camera culling, light include/exclude filtering, renderer lists, and custom raster passes.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("list_rendering_layers", {})
	);
	server.registerTool(
		"create_rendering_layer",
		{
			title: "Create rendering layer",
			description: "Create one uniquely named project rendering layer on an available or explicitly selected native bit from 0 through 31.",
			inputSchema: z.object({ name: z.string().min(1).max(128), bit: z.number().int().min(0).max(31).optional() }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rendering_layer", args)
	);
	server.registerTool(
		"set_rendering_layer",
		{
			title: "Set rendering layer",
			description:
				"Version-leased rename or bit migration for one rendering layer. Bit changes require migrateAssignments=true and atomically rewrite every mesh, camera, light, and renderer-list mask.",
			inputSchema: z
				.object({
					...renderingLayerSelector,
					revision: z.number().int().positive(),
					name: z.string().min(1).max(128).optional(),
					bit: z.number().int().min(0).max(31).optional(),
					migrateAssignments: z.boolean().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.layerId && !value.layerName) {
						context.addIssue({ code: "custom", message: "Provide layerId or layerName." });
					}
					if (value.name === undefined && value.bit === undefined) {
						context.addIssue({ code: "custom", message: "Provide name or bit." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rendering_layer", args)
	);
	server.registerTool(
		"delete_rendering_layer",
		{
			title: "Delete rendering layer",
			description:
				"Delete one exact layer revision. Consumers block deletion unless clearAssignments=true, which removes the bit atomically from meshes, cameras, lights, and renderer lists.",
			inputSchema: z
				.object({ ...renderingLayerSelector, revision: z.number().int().positive(), clearAssignments: z.boolean().optional(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.layerId || value.layerName), "Provide layerId or layerName."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_rendering_layer", args)
	);
	server.registerTool(
		"set_node_rendering_layers",
		{
			title: "Set node rendering layers",
			description:
				"Assign a mesh or camera native layer mask by exact unsigned value or named layer ids. Meshes may also set Babylon renderingGroupId 0–3 and alphaIndex for deterministic draw ordering.",
			inputSchema: z
				.object({
					...nodeSelector,
					mask: unsignedMask.optional(),
					layerIds: layerIds.optional(),
					renderingGroupId: z.number().int().min(0).max(3).optional(),
					alphaIndex: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.nodeId && !value.nodeName) {
						context.addIssue({ code: "custom", message: "Provide nodeId or nodeName." });
					}
					if ((value.mask === undefined) === (value.layerIds === undefined)) {
						context.addIssue({ code: "custom", message: "Provide exactly one of mask or layerIds." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_rendering_layers", args)
	);
	server.registerTool(
		"set_light_rendering_layers",
		{
			title: "Set light rendering layers",
			description: "Assign non-overlapping native include/exclude rendering-layer masks to a Babylon light by exact unsigned masks or named layer ids.",
			inputSchema: z
				.object({
					...nodeSelector,
					includeMask: unsignedMask.optional(),
					includeLayerIds: layerIds.optional(),
					excludeMask: unsignedMask.optional(),
					excludeLayerIds: layerIds.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.nodeId && !value.nodeName) {
						context.addIssue({ code: "custom", message: "Provide nodeId or nodeName." });
					}
					if ((value.includeMask === undefined) === (value.includeLayerIds === undefined)) {
						context.addIssue({ code: "custom", message: "Provide exactly one include mask representation." });
					}
					if ((value.excludeMask === undefined) === (value.excludeLayerIds === undefined)) {
						context.addIssue({ code: "custom", message: "Provide exactly one exclude mask representation." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_rendering_layers", args)
	);
	server.registerTool(
		"set_rendering_group",
		{
			title: "Set rendering group",
			description:
				"Version-leased upsert of one Babylon rendering group 0–3, including depth/stencil clear policy and built-in opaque, alpha-test, and transparent sort comparators.",
			inputSchema: z
				.object({
					groupId: z.number().int().min(0).max(3),
					revision: z.number().int().positive(),
					name: z.string().min(1).max(128).optional(),
					autoClearDepthStencil: z.boolean().optional(),
					clearDepth: z.boolean().optional(),
					clearStencil: z.boolean().optional(),
					opaqueSort: renderingSortMode.optional(),
					alphaTestSort: renderingSortMode.optional(),
					transparentSort: renderingSortMode.optional(),
				})
				.strict()
				.refine(
					(value) =>
						[value.name, value.autoClearDepthStencil, value.clearDepth, value.clearStencil, value.opaqueSort, value.alphaTestSort, value.transparentSort].some(
							(entry) => entry !== undefined
						),
					"Provide at least one group field to update."
				),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rendering_group", args)
	);
	server.registerTool(
		"reset_rendering_group",
		{
			title: "Reset rendering group",
			description:
				"Remove one exact authored Babylon rendering-group policy and immediately restore the engine defaults for depth/stencil clearing and opaque, alpha-test, and transparent sorting.",
			inputSchema: z.object({ groupId: z.number().int().min(0).max(3), revision: z.number().int().positive(), confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_rendering_group", args)
	);
	server.registerTool(
		"list_renderer_lists",
		{
			title: "List renderer lists",
			description: "List a bounded page of versioned renderer-list descriptors with live validity, resolved mesh count, and opaque/alpha-test/transparent queue counts.",
			inputSchema: z.object({ offset: z.number().int().min(0).max(63).optional(), limit: z.number().int().min(1).max(64).optional() }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("list_renderer_lists", args)
	);
	server.registerTool(
		"create_renderer_list",
		{
			title: "Create renderer list",
			description:
				"Create a reusable versioned draw-list descriptor from camera culling, explicit roots/descendants, include/exclude rendering-layer masks, rendering groups, material queue, sort mode, and visibility state.",
			inputSchema: z.object({ ...rendererListFields, name: z.string().min(1).max(128) }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_renderer_list", args)
	);
	server.registerTool(
		"set_renderer_list",
		{
			title: "Set renderer list",
			description: "Version-leased renderer-list update with validation and atomic refresh of every custom raster pass assigned to the list.",
			inputSchema: z
				.object({ ...rendererListSelector, revision: z.number().int().positive(), ...rendererListFields })
				.strict()
				.superRefine((value, context) => {
					if (!value.rendererListId && !value.rendererListName) {
						context.addIssue({ code: "custom", message: "Provide rendererListId or rendererListName." });
					}
					if (Object.keys(rendererListFields).every((key) => value[key as keyof typeof value] === undefined)) {
						context.addIssue({ code: "custom", message: "Provide at least one renderer-list field to update." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_renderer_list", args)
	);
	server.registerTool(
		"resolve_renderer_list",
		{
			title: "Resolve renderer list",
			description:
				"Resolve and page the exact live mesh candidates, native masks, rendering groups, alpha indices, material queues, camera, filters, and queue counts for one reusable renderer list.",
			inputSchema: z
				.object({ ...rendererListSelector, offset: z.number().int().min(0).max(4095).optional(), limit: z.number().int().min(1).max(512).optional() })
				.strict()
				.refine((value) => Boolean(value.rendererListId || value.rendererListName), "Provide rendererListId or rendererListName."),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("resolve_renderer_list", args)
	);
	server.registerTool(
		"delete_renderer_list",
		{
			title: "Delete renderer list",
			description: "Delete one exact renderer-list revision only when no custom raster pass references it.",
			inputSchema: z
				.object({ ...rendererListSelector, revision: z.number().int().positive(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.rendererListId || value.rendererListName), "Provide rendererListId or rendererListName."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_renderer_list", args)
	);

	const customPassReference = z.object({ id: z.string().optional(), name: z.string().optional() }).strict();
	const computeNodeType = z.enum([
		"global-id",
		"output-size",
		"constant-color",
		"constant-scalar",
		"uv-color",
		"texture-load",
		"uniform-color",
		"storage-load",
		"add",
		"subtract",
		"multiply",
		"divide",
		"minimum",
		"maximum",
		"lerp",
		"clamp",
		"abs",
		"sin",
		"cos",
		"normalize",
		"dot",
		"length",
		"select",
		"combine-vector",
		"split-component",
		"splat",
		"swizzle",
		"compare",
		"boolean-not",
		"boolean-and",
		"boolean-or",
		"branch",
		"storage-store",
		"output-store",
	]);
	const computeNode = z.object({
		id: z.string().min(1),
		type: computeNodeType,
		position: z.tuple([z.number(), z.number()]),
		value: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("RGBA value used by constant-color."),
		scalarValue: z.number().optional().describe("Finite scalar used by constant-scalar."),
		resourceName: z.string().min(1).optional().describe("Texture input, uniform-buffer binding, or storage-buffer binding used by resource nodes."),
		fieldName: z.string().min(1).optional().describe("vec4 uniform field used by uniform-color."),
		component: z.enum(["x", "y", "z", "w"]).optional().describe("Component selected by split-component."),
		swizzle: z
			.string()
			.regex(/^[xyzw]{4}$/)
			.optional()
			.describe("Exactly four xyzw selectors used by swizzle, for example wzyx or xxxx."),
		comparison: z.enum(["equal", "notEqual", "less", "lessEqual", "greater", "greaterEqual"]).optional().describe("Operation used by compare."),
	});
	const computeNodeValueType = z.enum(["f32", "vec3u", "vec2u", "vec4f", "vec4b"]);
	const computeSubgraphPort = z.object({ name: z.string().min(1), nodeId: z.string().min(1), port: z.string().min(1), type: computeNodeValueType });
	const computeSubgraphInstance = z.object({
		id: z.string().min(1),
		prefix: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		assetPath: z.string().min(1),
		assetName: z.string().min(1),
		assetVersion: z.union([z.literal(1), z.literal(2)]),
		assetRevision: z.string().regex(/^[a-f0-9]{64}$/),
		nodeIds: z.array(z.string().min(1)).min(1).max(128),
		inputs: z.array(computeSubgraphPort).max(256),
		output: computeSubgraphPort,
		position: z.tuple([z.number(), z.number()]),
		collapsed: z.boolean(),
	});
	const computeNodeGraph = z.object({
		version: z.literal(1),
		nodes: z.array(computeNode).min(1).max(128),
		edges: z
			.array(
				z.object({
					from: z.string().min(1),
					fromPort: z.literal("value"),
					to: z.string().min(1),
					toPort: z.string().min(1),
				})
			)
			.max(256),
		subgraphInstances: z.array(computeSubgraphInstance).max(64).optional(),
	});
	const customPassFields = {
		passType: z
			.enum(["shader", "copy", "raster", "compute"])
			.optional()
			.describe("Pass execution type. shader runs authored GLSL; copy uses a fixed texture copy; raster draws scene meshes; compute dispatches authored WGSL on WebGPU."),
		injectionPoint: z
			.enum(["beforeRendering", "afterRenderingPrePasses", "beforeRenderingPostProcessing", "afterRenderingPostProcessing"])
			.optional()
			.describe(
				"Exact runtime injection point. Raster supports beforeRendering; compute supports afterRenderingPrePasses; shader/copy support beforeRenderingPostProcessing or afterRenderingPostProcessing."
			),
		copySource: z
			.object({
				source: z.enum(["screen", "depth", "normal", "texture", "pass"]),
				path: z.string().min(1).max(4096).optional().describe("Required project-relative path for a texture copy."),
				output: z.string().min(1).optional().describe("Required named producer output for a pass copy."),
			})
			.optional()
			.describe("Fixed-function copy source. screen copies the prior screen color; other sources copy one graph/external texture through copySampler."),
		rasterSettings: z
			.object({
				rendererListId: z
					.string()
					.min(1)
					.max(128)
					.nullable()
					.optional()
					.describe("Reusable renderer-list id. When assigned, cameraId/meshIds/includeDescendants/layerMask must remain at their defaults."),
				cameraId: z.string().min(1).nullable().optional().describe("Camera id for the offscreen draw; null uses the graph camera."),
				meshIds: z.array(z.string().min(1)).max(4096).optional().describe("Explicit mesh ids. An empty array renders all current scene meshes."),
				includeDescendants: z.boolean().optional().describe("Expand explicit mesh ids to all descendant meshes before layer filtering."),
				layerMask: z.number().int().min(0).max(4_294_967_295).nullable().optional().describe("Unsigned layer-mask filter; null accepts every selected mesh."),
				materialId: z.string().min(1).nullable().optional().describe("Optional scene material id cloned as an isolated override material for this graphics pass."),
				clearColor: z.array(z.number().min(0).max(1)).length(4).optional().describe("RGBA target clear color."),
				clearMode: z.enum(["colorDepth", "depthOnly", "none"]).optional().describe("Attachment clear operation before drawing."),
				depthTest: z.boolean().optional().describe("Enable LEQUAL depth testing on the override material; false uses ALWAYS."),
				depthWrite: z.boolean().optional().describe("Enable depth writes on the override material."),
				cullMode: z.enum(["back", "front", "none"]).optional().describe("Triangle culling applied to the override material."),
				blendMode: z.enum(["opaque", "alpha", "additive", "multiply", "premultiplied"]).optional().describe("Blend state applied to the override material."),
				renderParticles: z.boolean().optional(),
				renderSprites: z.boolean().optional(),
				useCameraPostProcesses: z.boolean().optional(),
				refreshRate: z.enum(["once", "everyFrame", "everyTwoFrames"]).optional(),
			})
			.strict()
			.optional()
			.describe("General offscreen graphics-pass configuration with render-list filters, isolated material/state overrides, and explicit clear behavior."),
		computeSettings: z
			.object({
				wgsl: z.string().max(100_000).optional().describe("WGSL source containing an @compute entry point and writable storage texture."),
				entryPoint: z.string().min(1).optional().describe("WGSL compute entry point. Defaults to main."),
				outputBindingName: z.string().min(1).optional().describe("Storage-texture variable receiving this pass's named output."),
				outputGroup: z.number().int().min(0).max(15).optional(),
				outputBinding: z.number().int().min(0).max(15).optional(),
				dispatch: z.array(z.number().int().min(1).max(65535)).length(3).optional().describe("X/Y/Z workgroup counts."),
				dispatchMode: z.enum(["once", "everyFrame"]).optional(),
				dispatchType: z.enum(["direct", "indirect"]).optional().describe("Direct uses dispatch; indirect reads three uint32 workgroup counts from indirectBuffer."),
				submitAfterDispatch: z
					.boolean()
					.optional()
					.describe("Submit recorded GPU commands immediately after this pass. Defaults to false; use only for an intentional synchronization/readback boundary."),
				indirectBuffer: z.string().min(1).nullable().optional().describe("Storage-buffer binding name used for indirect dispatch."),
				indirectOffset: z.number().int().min(0).max(1_048_576).optional().describe("4-byte-aligned offset of the indirect X/Y/Z uint32 values."),
				uniformBuffers: z
					.array(
						z.object({
							name: z.string().min(1).describe("WGSL uniform-buffer variable name."),
							group: z.number().int().min(0).max(15),
							binding: z.number().int().min(0).max(15),
							uniforms: z
								.array(
									z.object({
										name: z.string().min(1).describe("WGSL struct member name, in declaration order."),
										type: z.enum(["float", "vec2", "vec3", "vec4", "int", "uint"]),
										value: z.array(z.number()).min(1).max(4),
									})
								)
								.min(1)
								.max(64),
						})
					)
					.max(16)
					.optional(),
				storageBuffers: z
					.array(
						z.object({
							name: z.string().min(1).describe("WGSL storage-buffer variable name."),
							group: z.number().int().min(0).max(15),
							binding: z.number().int().min(0).max(15),
							dataType: z.enum(["float32", "int32", "uint32"]),
							data: z.array(z.number()).min(1).max(262_144).describe("Typed initial buffer values."),
							indirect: z.boolean().optional().describe("Allocate with GPU indirect-dispatch usage. Defaults to false."),
							sharedResource: z
								.string()
								.min(1)
								.nullable()
								.optional()
								.describe("Graph-wide resource key. Matching keys share one GPU allocation across compute passes."),
							access: z
								.enum(["read", "write", "readWrite"])
								.optional()
								.describe("Declared hazard access. Defaults to readWrite; conflicting shared usages require dependency ordering."),
						})
					)
					.max(16)
					.optional(),
			})
			.optional()
			.describe(
				"Native WebGPU compute dispatch, uniform/storage-buffer, and indirect-dispatch settings. Compute passes require one RGBA, 1x-MSAA named storage-texture output."
			),
		enabled: z.boolean().optional(),
		order: z.number().optional().describe("Scheduling preference used when multiple dependency-ready passes are available."),
		dependencies: z.array(z.string()).max(64).optional().describe("Ids of passes that must execute before this pass."),
		fragmentShader: z
			.string()
			.max(100_000)
			.optional()
			.describe(
				"Complete GLSL fragment shader containing void main(), textureSampler, and declarations for every supplied uniform. MRT passes must write gl_FragData[0] through gl_FragData[N]."
			),
		uniforms: z
			.record(z.string(), z.union([z.number(), z.array(z.number()).min(2).max(4)]))
			.optional()
			.describe("Named float or vec2/vec3/vec4 values bound on every pass application."),
		inputs: z
			.record(
				z.string(),
				z.object({
					source: z.enum(["depth", "normal", "texture", "pass"]),
					path: z.string().min(1).max(4096).optional().describe("Required project-relative asset path when source is texture."),
					output: z.string().min(1).optional().describe("Required named producer output when source is pass."),
					group: z.number().int().min(0).max(15).optional().describe("Required WebGPU bind group for compute inputs."),
					binding: z.number().int().min(0).max(15).optional().describe("Required WebGPU binding index for compute inputs."),
				})
			)
			.optional()
			.describe(
				"Named texture resources. Shader passes declare each key in fragmentShader. Compute passes accept project textures or prior raster/compute outputs and require group/binding locations matching WGSL."
			),
		output: z.string().min(1).nullable().optional().describe("Optional unique named output captured from this pass. Set null to remove when no consumers remain."),
		outputType: z.enum(["uint8", "halfFloat", "float"]).optional().describe("Named-output precision. Defaults to uint8."),
		outputFormat: z.enum(["r", "rg", "rgba"]).optional().describe("Named-output channel format. Defaults to rgba."),
		outputSamples: z.number().int().min(1).max(8).optional().describe("Named-output MSAA sample count. Defaults to 1 and must be supported by the active backend."),
		additionalOutputs: z
			.array(
				z.object({
					name: z.string().min(1).describe("Unique output name consumed by downstream pass inputs."),
					outputType: z.enum(["uint8", "halfFloat", "float"]),
					outputFormat: z.enum(["r", "rg", "rgba"]),
					outputSamples: z.number().int().min(1).max(8),
				})
			)
			.max(3)
			.optional()
			.describe(
				"Up to three additional real MRT attachments. Requires a primary output; every attachment must use the same MSAA count and fragmentShader must write gl_FragData[0..N]."
			),
		ratio: z.number().positive().max(1).optional().describe("Render resolution ratio from greater than 0 through 1."),
		samplingMode: z.enum(["nearest", "bilinear", "trilinear"]).optional(),
	};
	const frameDebuggerQuery = z
		.object({
			passType: z.enum(["shader", "copy", "raster", "compute"]).optional().describe("Optional pass-type filter."),
			status: z.enum(["all", "active", "culled", "error"]).optional().describe("Optional pass-state filter; defaults to all."),
			passOffset: z.number().int().min(0).max(64).optional().describe("Pass-page offset. Defaults to 0."),
			passLimit: z.number().int().min(1).max(64).optional().describe("Maximum pass records. Defaults to 32."),
			resourceOffset: z.number().int().min(0).max(256).optional().describe("Resource-page offset. Defaults to 0."),
			resourceLimit: z.number().int().min(1).max(128).optional().describe("Maximum resource records. Defaults to 64."),
			resourceName: z.string().min(1).optional().describe("Exact named-output resource filter."),
			producerId: z.string().min(1).optional().describe("Exact resource producer-pass id filter."),
		})
		.strict();
	const renderGraphAssetPath = z.string().min(1).max(4096).describe("Project-relative .rendergraph.json asset path.");
	const renderGraphAssetRevision = z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.describe("Exact SHA-256 content revision returned by an asset read/list/apply operation.");
	const rendererFeatureAssetPath = z.string().min(1).max(4096).describe("Project-relative .renderfeature.json asset path.");
	const rendererFeatureRevision = z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.describe("Exact SHA-256 renderer-feature content revision returned by a read or list operation.");
	const rendererFeatureCameraIds = z
		.array(z.string().min(1).max(256))
		.max(64)
		.refine((values) => new Set(values).size === values.length, "Camera ids must be unique.");
	const rendererFeatureCameraFilter = z
		.object({
			cameraIds: rendererFeatureCameraIds.optional().describe("Allow only these camera ids; an empty list allows every camera not explicitly excluded."),
			excludeCameraIds: rendererFeatureCameraIds.optional().describe("Camera ids excluded even when otherwise allowed."),
			projection: z.enum(["any", "perspective", "orthographic"]).optional(),
			layerMask: z
				.number()
				.int()
				.min(0)
				.max(4_294_967_295)
				.nullable()
				.optional()
				.describe("Require at least one bit shared with the active camera layer mask; null disables this filter."),
		})
		.strict();
	const rendererFeatureSelectorFields = {
		instanceId: z.string().min(1).max(128).optional().describe("Stable renderer-feature instance id (preferred)."),
		instanceName: z.string().min(1).max(128).optional().describe("Renderer-feature instance name."),
	};
	server.registerTool(
		"list_custom_render_passes",
		{
			title: "List custom render passes",
			description:
				"List persisted shader/copy/scene-graphics/WebGPU-compute passes, graphics state, dependency execution order, named-output lifetimes, and allocation slots.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("list_custom_render_passes", {})
	);
	server.registerTool(
		"create_custom_render_pass",
		{
			title: "Create custom render pass",
			description:
				"Create a persisted shader, fixed-function copy, general scene-graphics, or native WebGPU compute pass. Graphics passes draw filtered mesh lists with optional descendant expansion, layer masks, cloned material overrides, explicit clear behavior, and isolated depth/culling/blending state. Compute passes dispatch authored WGSL into one RGBA 1x-MSAA storage texture, bind textures/uniform/storage buffers, use direct/indirect dispatch, and may share storage allocations across dependency-ordered passes with declared read/write access. Copy passes copy screen/pass/depth/normal/project textures. Shader passes may publish a primary output plus three MRT attachments. Preview reports backend/resource limitations without discarding authored data.",
			inputSchema: z.object({ name: z.string().min(1), ...customPassFields }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_custom_render_pass", args)
	);
	server.registerTool(
		"set_custom_render_pass",
		{
			title: "Set custom render pass",
			description:
				"Update pass type, copy source, graphics render-list/material/depth/culling/blending/clear state, WGSL compute/dispatch/bindings/shared-resource access/submission boundary, GLSL shader, inputs, outputs, target format/MSAA, dependencies, order, ratio, or sampling and rebuild preview. Copy, graphics, and compute passes use one output and no MRT additions; compute requires RGBA and 1x MSAA. Renaming outputs migrates consumers atomically. Preview reports backend/resource limitations without discarding authored data.",
			inputSchema: customPassReference.extend({ name: z.string().min(1).optional(), ...customPassFields }),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_render_pass", args)
	);
	server.registerTool(
		"delete_custom_render_pass",
		{
			title: "Delete custom render pass",
			description: "Delete one custom pass and remove its id from downstream dependency lists.",
			inputSchema: customPassReference,
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_render_pass", args)
	);
	server.registerTool(
		"evaluate_custom_render_pass_graph",
		{
			title: "Evaluate custom render-pass graph",
			description: "Validate dependency/resource edges, rebuild the active camera's shader/copy/scene-graphics/compute graph, and return its resolved execution order.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(false, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("evaluate_custom_render_pass_graph", {})
	);
	server.registerTool(
		"get_custom_render_pass_diagnostics",
		{
			title: "Get custom render-pass diagnostics",
			description:
				"Read live shader/compute readiness, compiler or dispatch errors, exported-runtime restoration errors, real MRT/raster/compute target readiness, and external/pass-output resource readiness for every custom pass attached to the active camera. Render or take a screenshot before checking.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_custom_render_pass_diagnostics", {})
	);
	server.registerTool(
		"get_render_graph_conformance",
		{
			title: "Get render-graph conformance",
			description:
				"Inspect the current graph's exact backend requirements, static WebGL2/WebGPU API blockers and device checks, current-device capabilities, graph signature, and persisted live run evidence. A backend is reported passed only when that exact graph executed there; unexecuted or changed graphs remain notRun.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_render_graph_conformance", {})
	);
	server.registerTool(
		"run_render_graph_conformance",
		{
			title: "Run render-graph conformance",
			description:
				"Rebuild the exact current graph, submit 1–8 real frames on the editor's current WebGL2 or WebGPU device, capture pass/resource/target readiness and compute dispatch evidence, and persist only that observed backend result. Pass expectedRevision=null when no prior evidence exists; otherwise pass the exact revision returned by get_render_graph_conformance.",
			inputSchema: z.object({ expectedRevision: z.number().int().positive().nullable(), frameCount: z.number().int().min(1).max(8).optional() }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_render_graph_conformance", args)
	);
	server.registerTool(
		"clear_render_graph_conformance",
		{
			title: "Clear render-graph conformance",
			description: "Delete one exact persisted cross-backend conformance revision without changing the authored graph or its live render resources.",
			inputSchema: z.object({ revision: z.number().int().positive(), confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_render_graph_conformance", args)
	);
	server.registerTool(
		"get_custom_render_pass_schedule",
		{
			title: "Get custom render-pass schedule",
			description:
				"Read dependency execution order, named-output lifetimes/allocation slots, and graph-wide shared compute-buffer usages. Shared resources report read/write access and implicit WebGPU command-order synchronization after hazard validation.",
			inputSchema: z.object({}).strict(),
			annotations: annotations(true, false, true),
		},
		async (): Promise<CallToolResult> => callTextTool("get_custom_render_pass_schedule", {})
	);
	server.registerTool(
		"capture_custom_render_pass_frame",
		{
			title: "Capture custom render-graph frame",
			description:
				"Freeze one bounded debugger snapshot of the currently applied custom render graph after a rendered frame. Returns backend/camera/frame evidence, execution phases and dependency order, active versus disabled/isolation-culled passes, exact JavaScript submission timing/counters, real hardware GPU samples only when available, and named-resource lifetime/allocation/texture state with independent pass/resource pagination.",
			inputSchema: frameDebuggerQuery,
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_custom_render_pass_frame", args)
	);
	server.registerTool(
		"get_custom_render_pass_frame",
		{
			title: "Get captured custom render-graph frame",
			description:
				"Read and filter/page the last immutable render-graph frame snapshot without recapturing it. Returns no-capture guidance when the graph has not yet been evaluated, rendered, and captured. CPU values measure JavaScript submission callbacks; unavailable GPU timing remains null rather than being estimated.",
			inputSchema: frameDebuggerQuery,
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_render_pass_frame", args)
	);
	server.registerTool(
		"set_custom_render_pass_frame_isolation",
		{
			title: "Set custom render-pass frame isolation",
			description:
				"Transiently isolate one enabled pass plus its complete dependency closure, or clear isolation, then atomically rebuild preview. Persisted pass enablement is never changed; failure restores the previous isolation/runtime. Capture a new frame afterward because changing isolation clears the prior snapshot.",
			inputSchema: z
				.object({
					id: z.string().min(1).optional().describe("Pass id to isolate (preferred)."),
					name: z.string().min(1).optional().describe("Pass name to isolate."),
					clear: z.boolean().optional().describe("Set true without id/name to clear transient isolation."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.clear === true && (value.id || value.name)) {
						context.addIssue({ code: "custom", message: "Clear isolation without an id or name." });
					}
					if (value.clear !== true && !value.id && !value.name) {
						context.addIssue({ code: "custom", message: "Provide id/name to isolate, or clear=true." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_render_pass_frame_isolation", args)
	);
	server.registerTool(
		"save_custom_render_graph_asset",
		{
			title: "Save custom render-graph asset",
			description:
				"Save the current validated pass graph as an atomic reusable version-2 project asset. Replacement requires overwrite=true and the exact current content revision; an assigned asset's scene lease is refreshed after saving.",
			inputSchema: z
				.object({
					path: renderGraphAssetPath,
					assetName: z.string().min(1).max(128).optional(),
					overwrite: z.boolean().optional(),
					expectedRevision: renderGraphAssetRevision.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.overwrite === true && !value.expectedRevision) {
						context.addIssue({ code: "custom", message: "Replacing an asset requires expectedRevision." });
					}
				}),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("save_custom_render_graph_asset", args)
	);
	server.registerTool(
		"list_custom_render_graph_assets",
		{
			title: "List custom render-graph assets",
			description:
				"List bounded reusable project render-graph assets with schema/revision/pass/resource summaries, malformed-file evidence, paging, and current scene assignment/dirty state.",
			inputSchema: z
				.object({
					search: z.string().min(1).max(256).optional(),
					offset: z.number().int().min(0).max(512).optional(),
					limit: z.number().int().min(1).max(128).optional(),
				})
				.strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("list_custom_render_graph_assets", args)
	);
	server.registerTool(
		"get_custom_render_graph_asset",
		{
			title: "Get custom render-graph asset",
			description:
				"Read one exact reusable render-graph asset, its normalized pass graph, content/pass revisions, schedule summary, and pending migration steps without changing it.",
			inputSchema: z.object({ path: renderGraphAssetPath }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_render_graph_asset", args)
	);
	server.registerTool(
		"get_custom_render_graph_asset_migration",
		{
			title: "Inspect custom render-graph migration",
			description:
				"Dry-run deterministic v1-to-v2 render-graph migration and return exact source/target revisions, semantic steps, and the content-addressed backup path without writing files.",
			inputSchema: z.object({ path: renderGraphAssetPath }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_render_graph_asset_migration", args)
	);
	server.registerTool(
		"migrate_custom_render_graph_asset",
		{
			title: "Migrate custom render-graph asset",
			description:
				"Atomically migrate one exact legacy asset revision to version 2, adding deterministic identity/revision leases and normalized pass defaults while preserving semantics; a content-addressed backup is retained by default.",
			inputSchema: z.object({ path: renderGraphAssetPath, expectedSourceRevision: renderGraphAssetRevision, backup: z.boolean().optional() }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("migrate_custom_render_graph_asset", args)
	);
	server.registerTool(
		"apply_custom_render_graph_asset",
		{
			title: "Apply custom render-graph asset",
			description:
				"Assign one exact current asset revision to the scene, embed a portable pass snapshot for exported games, clear debugger isolation, and atomically rebuild the active camera with rollback on failure.",
			inputSchema: z.object({ path: renderGraphAssetPath, expectedRevision: renderGraphAssetRevision }).strict(),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_custom_render_graph_asset", args)
	);
	server.registerTool(
		"update_assigned_custom_render_graph_asset",
		{
			title: "Update assigned custom render-graph asset",
			description:
				"Write the current embedded graph back to its assigned project asset under an exact content-revision lease, incrementing the asset revision and refreshing the scene assignment.",
			inputSchema: z.object({ expectedRevision: renderGraphAssetRevision, assetName: z.string().min(1).max(128).optional() }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("update_assigned_custom_render_graph_asset", args)
	);
	server.registerTool(
		"detach_custom_render_graph_asset",
		{
			title: "Detach custom render-graph asset",
			description: "Detach the exact current scene assignment while retaining its embedded graph snapshot and active runtime unchanged.",
			inputSchema: z.object({ id: z.string().min(1).max(128), expectedRevision: renderGraphAssetRevision }).strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("detach_custom_render_graph_asset", args)
	);
	server.registerTool(
		"delete_custom_render_graph_asset",
		{
			title: "Delete custom render-graph asset",
			description: "Permanently delete one unassigned exact project asset revision. The current scene must be detached first and literal confirmation is required.",
			inputSchema: z.object({ path: renderGraphAssetPath, expectedRevision: renderGraphAssetRevision, confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_render_graph_asset", args)
	);
	server.registerTool(
		"save_renderer_feature_asset",
		{
			title: "Save renderer feature asset",
			description:
				"Save 1–64 selected base render passes and their complete selected dependency closure as one reusable atomic .renderfeature.json subpass asset. Feature-owned generated passes cannot be nested. Replacement requires overwrite=true and the exact current SHA-256 revision.",
			inputSchema: z
				.object({
					path: rendererFeatureAssetPath,
					assetName: z.string().min(1).max(128).optional(),
					passIds: z
						.array(z.string().min(1).max(256))
						.min(1)
						.max(64)
						.refine((values) => new Set(values).size === values.length, "Pass ids must be unique."),
					overwrite: z.boolean().optional(),
					expectedRevision: rendererFeatureRevision.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.overwrite === true && !value.expectedRevision) {
						context.addIssue({ code: "custom", message: "Replacing an asset requires expectedRevision." });
					}
				}),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("save_renderer_feature_asset", args)
	);
	server.registerTool(
		"list_renderer_feature_assets",
		{
			title: "List renderer feature assets",
			description:
				"List bounded project .renderfeature.json assets with stable identity, revision, pass/resource counts, injection-point summaries, paging, and malformed-file evidence.",
			inputSchema: z
				.object({
					search: z.string().min(1).max(256).optional(),
					offset: z.number().int().min(0).max(512).optional(),
					limit: z.number().int().min(1).max(128).optional(),
				})
				.strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("list_renderer_feature_assets", args)
	);
	server.registerTool(
		"get_renderer_feature_asset",
		{
			title: "Get renderer feature asset",
			description:
				"Read and validate one reusable renderer-feature asset, including its exact SHA-256 revision, complete subpass graph, outputs, and injection-point summary.",
			inputSchema: z.object({ path: rendererFeatureAssetPath }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_renderer_feature_asset", args)
	);
	server.registerTool(
		"instantiate_renderer_feature",
		{
			title: "Instantiate renderer feature",
			description:
				"Instantiate one exact renderer-feature revision into the current scene. Every pass and named output receives a collision-safe stable namespace; enabled state, order group, and camera id/projection/layer filters are applied atomically with runtime rollback.",
			inputSchema: z
				.object({
					path: rendererFeatureAssetPath,
					expectedRevision: rendererFeatureRevision,
					instanceId: z.string().min(1).max(128).optional(),
					instanceName: z.string().min(1).max(128).optional(),
					prefix: z
						.string()
						.regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
						.optional(),
					enabled: z.boolean().optional(),
					order: z.number().int().min(-1000).max(1000).optional(),
					cameraFilter: rendererFeatureCameraFilter.optional(),
				})
				.strict(),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_renderer_feature", args)
	);
	server.registerTool(
		"list_renderer_feature_instances",
		{
			title: "List renderer feature instances",
			description:
				"List bounded scene renderer-feature instances with exact instance/asset revisions, pass/output namespace mappings, camera filters, and active-camera eligibility.",
			inputSchema: z
				.object({
					search: z.string().min(1).max(256).optional(),
					offset: z.number().int().min(0).max(64).optional(),
					limit: z.number().int().min(1).max(64).optional(),
				})
				.strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("list_renderer_feature_instances", args)
	);
	server.registerTool(
		"set_renderer_feature_instance",
		{
			title: "Set renderer feature instance",
			description:
				"Update one exact instance revision's name, enabled state, order group, or complete camera filter, then atomically republish every owned pass without permitting direct edits to generated passes.",
			inputSchema: z
				.object({
					...rendererFeatureSelectorFields,
					revision: z.number().int().positive(),
					name: z.string().min(1).max(128).optional().describe("Replacement display name; use instanceName only as a selector."),
					enabled: z.boolean().optional(),
					order: z.number().int().min(-1000).max(1000).optional(),
					cameraFilter: rendererFeatureCameraFilter.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.instanceId && !value.instanceName) {
						context.addIssue({ code: "custom", message: "Provide instanceId or instanceName." });
					}
					if (value.name === undefined && value.enabled === undefined && value.order === undefined && value.cameraFilter === undefined) {
						context.addIssue({ code: "custom", message: "Provide name, enabled, order, or cameraFilter." });
					}
				}),
			annotations: annotations(false, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_renderer_feature_instance", args)
	);
	server.registerTool(
		"get_renderer_feature_diagnostics",
		{
			title: "Get renderer feature diagnostics",
			description:
				"Compare every bounded scene instance with its source asset and report current/outdated/missing state, exact revisions, active-camera filter result, active pass count, and injection-point distribution.",
			inputSchema: z.object({ offset: z.number().int().min(0).max(64).optional(), limit: z.number().int().min(1).max(64).optional() }).strict(),
			annotations: annotations(true, false, true),
		},
		async (args): Promise<CallToolResult> => callTextTool("get_renderer_feature_diagnostics", args)
	);
	server.registerTool(
		"refresh_renderer_feature_instance",
		{
			title: "Refresh renderer feature instance",
			description:
				"Refresh one exact instance from one exact latest source-asset revision while preserving its stable namespace, settings, and compatible external references. Validation and runtime rebuild are atomic with rollback.",
			inputSchema: z
				.object({
					...rendererFeatureSelectorFields,
					revision: z.number().int().positive(),
					expectedAssetRevision: rendererFeatureRevision,
				})
				.strict()
				.refine((value) => Boolean(value.instanceId || value.instanceName), "Provide instanceId or instanceName."),
			annotations: annotations(false, false, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_renderer_feature_instance", args)
	);
	server.registerTool(
		"delete_renderer_feature_instance",
		{
			title: "Delete renderer feature instance",
			description:
				"Delete one exact renderer-feature instance and all owned generated passes after proving no external pass depends on its pass ids or named outputs. The reusable asset remains unchanged.",
			inputSchema: z
				.object({ ...rendererFeatureSelectorFields, revision: z.number().int().positive(), confirm: z.literal(true) })
				.strict()
				.refine((value) => Boolean(value.instanceId || value.instanceName), "Provide instanceId or instanceName."),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_renderer_feature_instance", args)
	);
	server.registerTool(
		"delete_renderer_feature_asset",
		{
			title: "Delete renderer feature asset",
			description: "Permanently delete one exact unreferenced .renderfeature.json asset revision after literal confirmation. Delete all scene instances first.",
			inputSchema: z.object({ path: rendererFeatureAssetPath, expectedRevision: rendererFeatureRevision, confirm: z.literal(true) }).strict(),
			annotations: annotations(false, true, false),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_renderer_feature_asset", args)
	);
	server.registerTool(
		"set_custom_render_pass_gpu_profiling",
		{
			title: "Set custom render-pass GPU profiling",
			description:
				"Enable or disable isolated hardware GPU timing for the active camera's custom render graph and rebuild its runtime resources. WebGPU uses per-render-target and per-compute-shader timestamp counters; compatible WebGL timestamp backends rotate one pass per query. Unsupported backends return an explicit reason and never substitute CPU or whole-frame timing.",
			inputSchema: z.object({
				enabled: z.boolean().describe("Enable or disable transient GPU pass profiling."),
				sampleCapacity: z.number().int().min(8).max(600).optional().describe("Retained samples per pass. Defaults to 120."),
				includeSamples: z.boolean().optional().describe("Include recent raw millisecond samples in the immediate result. Defaults to false."),
				sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum raw samples returned per pass. Defaults to 60."),
			}),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_render_pass_gpu_profiling", args)
	);
	server.registerTool(
		"get_custom_render_pass_gpu_profile",
		{
			title: "Get custom render-pass GPU profile",
			description:
				"Read isolated hardware GPU duration statistics for every enabled shader, copy, scene-raster, MRT, and compute pass. Returns backend capability/reason, sampling strategy, source, sample count/age, last/average/min/max milliseconds, dropped samples, and optionally bounded raw samples. No CPU or frame-wide value is presented as a pass duration.",
			inputSchema: z.object({
				includeSamples: z.boolean().optional().describe("Include recent raw millisecond samples. Defaults to false."),
				sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum raw samples returned per pass. Defaults to 60."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_render_pass_gpu_profile", args)
	);
	server.registerTool(
		"get_custom_compute_node_graph",
		{
			title: "Get custom compute node graph",
			description: "Read the persisted typed node graph and generated WGSL for one custom WebGPU compute pass.",
			inputSchema: customPassReference,
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_node_graph", args)
	);
	server.registerTool(
		"initialize_custom_compute_node_graph",
		{
			title: "Initialize custom compute node graph",
			description:
				"Create and compile a valid UV-gradient starter graph for a compute pass. Existing graphs are preserved unless replace is true. Generated WGSL becomes the pass source and preview is rebuilt.",
			inputSchema: customPassReference.extend({ replace: z.boolean().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("initialize_custom_compute_node_graph", args)
	);
	server.registerTool(
		"set_custom_compute_node_graph",
		{
			title: "Set custom compute node graph",
			description:
				"Replace a compute pass's typed graph. Node identities, ports, edge types and cycles are validated; complete graphs compile to WGSL by default. Set compile false to persist an intentionally incomplete graph while authoring.",
			inputSchema: customPassReference.extend({ graph: computeNodeGraph, compile: z.boolean().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_node_graph", args)
	);
	server.registerTool(
		"add_custom_compute_node",
		{
			title: "Add custom compute node",
			description:
				"Add one typed node to a persisted compute graph. The node library includes invocation/output inputs, scalar/vector constants, texture/uniform/storage loads, vector arithmetic/functions, split/combine/splat/swizzle conversions, typed comparison/Boolean/branch control, storage write, and output write. Connections are authored separately, so incomplete required inputs are allowed until compilation.",
			inputSchema: customPassReference.extend({ node: computeNode.extend({ id: z.string().min(1).optional(), position: z.tuple([z.number(), z.number()]).optional() }) }),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_custom_compute_node", args)
	);
	server.registerTool(
		"set_custom_compute_node",
		{
			title: "Set custom compute node",
			description: "Update a node type, canvas position, constant RGBA value, or bound texture/uniform resource. Existing node id is preserved.",
			inputSchema: customPassReference.extend({
				nodeId: z.string().min(1),
				update: z.object({
					type: computeNodeType.optional(),
					position: z.tuple([z.number(), z.number()]).optional(),
					value: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
					resourceName: z.string().min(1).optional(),
					fieldName: z.string().min(1).optional(),
				}),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_node", args)
	);
	server.registerTool(
		"delete_custom_compute_node",
		{
			title: "Delete custom compute node",
			description: "Delete a node and all of its incident edges. The required output-store node cannot be deleted without replacing the whole graph.",
			inputSchema: customPassReference.extend({ nodeId: z.string().min(1) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_compute_node", args)
	);
	server.registerTool(
		"connect_custom_compute_nodes",
		{
			title: "Connect custom compute nodes",
			description: "Connect a source node's typed value output to one named target input. Duplicate, incompatible, unknown-port and cyclic edges are rejected.",
			inputSchema: customPassReference.extend({ from: z.string().min(1), to: z.string().min(1), toPort: z.string().min(1) }),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("connect_custom_compute_nodes", args)
	);
	server.registerTool(
		"disconnect_custom_compute_nodes",
		{
			title: "Disconnect custom compute nodes",
			description: "Remove one connection identified by source node, target node and target port. The graph may remain intentionally incomplete until reconnected.",
			inputSchema: customPassReference.extend({ from: z.string().min(1), to: z.string().min(1), toPort: z.string().min(1) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("disconnect_custom_compute_nodes", args)
	);
	server.registerTool(
		"compile_custom_compute_node_graph",
		{
			title: "Compile custom compute node graph",
			description:
				"Validate a complete acyclic typed graph, generate full WGSL declarations and compute entry point from current pass resources, store the WGSL on the pass, and rebuild preview.",
			inputSchema: customPassReference,
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("compile_custom_compute_node_graph", args)
	);
	server.registerTool(
		"save_custom_compute_subgraph",
		{
			title: "Save custom compute subgraph",
			description:
				"Save selected pure value-producing nodes from one compute pass as a reusable project-local .computegraph.json graph-function asset. Internal edges are retained, disconnected typed inputs become the asset interface, every node must contribute to outputNodeId, and storage/output sink nodes are rejected.",
			inputSchema: customPassReference.extend({
				path: z.string().min(1).describe("Project-relative .computegraph.json output path."),
				assetName: z.string().min(1).optional(),
				nodeIds: z.array(z.string().min(1)).min(1).max(128),
				outputNodeId: z.string().min(1).describe("Selected value-producing node exported as the function output."),
				inputNames: z.record(z.string(), z.string().min(1)).optional().describe('Optional boundary key (for example "multiply.a") to reusable interface name mapping.'),
				overwrite: z.boolean().optional(),
			}),
			annotations: { idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_custom_compute_subgraph", args)
	);
	server.registerTool(
		"list_custom_compute_subgraphs",
		{
			title: "List custom compute subgraphs",
			description: "List valid reusable .computegraph.json graph-function assets in the open project, including typed input/output interfaces and node counts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_custom_compute_subgraphs", {})
	);
	server.registerTool(
		"get_custom_compute_subgraph",
		{
			title: "Get custom compute subgraph",
			description: "Read and fully validate one project-local compute graph-function asset without changing the scene.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_subgraph", args)
	);
	server.registerTool(
		"get_custom_compute_subgraph_migration",
		{
			title: "Get custom compute subgraph migration",
			description:
				"Dry-run the deterministic migration of one legacy .computegraph.json asset. Reports source/target versions and revisions, semantic steps, changed/created nodes, and the content-addressed backup path without modifying the file.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_subgraph_migration", args)
	);
	server.registerTool(
		"migrate_custom_compute_subgraph",
		{
			title: "Migrate custom compute subgraph",
			description:
				"Atomically migrate one legacy project-local compute graph-function asset to the current schema. Version 1 numeric select nodes become typed compare-and-branch control while stable interface names/types are preserved. A content-addressed backup is written by default.",
			inputSchema: z.object({
				path: z.string().min(1),
				backup: z.boolean().optional().describe("Write a content-addressed backup before replacement. Defaults to true."),
			}),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("migrate_custom_compute_subgraph", args)
	);
	server.registerTool(
		"insert_custom_compute_subgraph",
		{
			title: "Insert custom compute subgraph",
			description:
				"Insert a renamed instance of a reusable graph-function asset into a compute pass. Returns mapped typed boundary inputs and output for subsequent connect_custom_compute_nodes calls; insertion deliberately permits temporarily unwired inputs.",
			inputSchema: customPassReference.extend({
				path: z.string().min(1),
				instanceId: z.string().min(1).optional().describe("Stable tracked instance id; defaults to prefix."),
				prefix: z
					.string()
					.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
					.optional()
					.describe("Stable WGSL-safe prefix for every inserted node id."),
				position: z.tuple([z.number(), z.number()]).optional().describe("Top-left canvas position for the inserted instance."),
				collapsed: z.boolean().optional().describe("Show one encapsulated call node in the editor. Defaults to true."),
			}),
			annotations: { idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("insert_custom_compute_subgraph", args)
	);
	server.registerTool(
		"delete_custom_compute_subgraph",
		{
			title: "Delete custom compute subgraph",
			description: "Delete one project-local compute graph-function asset without changing any instances already expanded into pass graphs.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_compute_subgraph", args)
	);
	server.registerTool(
		"list_custom_compute_subgraph_instances",
		{
			title: "List custom compute subgraph instances",
			description: "List tracked expanded graph-function instances, asset revisions, typed interfaces, owned nodes, positions, and collapse state for one compute pass.",
			inputSchema: customPassReference,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_custom_compute_subgraph_instances", args)
	);
	server.registerTool(
		"set_custom_compute_subgraph_instance",
		{
			title: "Set custom compute subgraph instance",
			description: "Collapse/expand one tracked call node or move its call-node position and every expanded child node together.",
			inputSchema: customPassReference.extend({ instanceId: z.string().min(1), collapsed: z.boolean().optional(), position: z.tuple([z.number(), z.number()]).optional() }),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_subgraph_instance", args)
	);
	server.registerTool(
		"get_custom_compute_subgraph_diagnostics",
		{
			title: "Get custom compute subgraph diagnostics",
			description:
				"Compare tracked instances with project asset revisions and report current/outdated/missing/invalid state, interface compatibility, connection counts, unmanaged internal-node connections, and safe-refresh readiness.",
			inputSchema: customPassReference,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_subgraph_diagnostics", args)
	);
	server.registerTool(
		"refresh_custom_compute_subgraph_instance",
		{
			title: "Refresh custom compute subgraph instance",
			description:
				"Replace expanded child nodes from the latest asset revision while preserving compatible external connections by stable typed interface name. Incompatible interfaces or unmanaged connections are rejected. Compilation is deferred unless compile is true.",
			inputSchema: customPassReference.extend({ instanceId: z.string().min(1), compile: z.boolean().optional() }),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_custom_compute_subgraph_instance", args)
	);
	server.registerTool(
		"delete_custom_compute_subgraph_instance",
		{
			title: "Delete custom compute subgraph instance",
			description: "Remove one tracked instance, all expanded child nodes, and every incident connection without deleting its reusable asset.",
			inputSchema: customPassReference.extend({ instanceId: z.string().min(1) }),
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_compute_subgraph_instance", args)
	);
	const computePreviewFields = {
		invocationId: z
			.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)])
			.optional()
			.describe("Representative global invocation id. Defaults to [0,0,0]."),
		outputSize: z
			.tuple([z.number().int().min(1), z.number().int().min(1)])
			.optional()
			.describe("Representative output dimensions. Defaults to the current pass target size."),
		textureSamples: z
			.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()]))
			.optional()
			.describe("Deterministic RGBA samples for texture-load nodes, keyed by compute input binding name."),
	};
	server.registerTool(
		"preview_custom_compute_node_graph",
		{
			title: "Preview custom compute nodes",
			description:
				"Evaluate one representative invocation entirely on CPU and return typed values/status for each node without mutating textures or buffers. Authored uniform/storage defaults are used; provide textureSamples for deterministic texture-load previews. This is a debugging preview, not GPU execution.",
			inputSchema: customPassReference.extend({
				...computePreviewFields,
				nodeIds: z.array(z.string().min(1)).max(128).optional().describe("Optional node-id filter for focused output."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("preview_custom_compute_node_graph", args)
	);
	server.registerTool(
		"get_custom_compute_texture_node_previews",
		{
			title: "Get custom compute texture-node previews",
			description:
				"Decode bounded PNG thumbnails for project-backed texture-load nodes in one compute graph. Returns source/thumbnail dimensions, sampling mode, pixel SHA-256, average/min/max RGBA, alpha coverage, and optional base64 PNG data. Live named-pass outputs are reported unavailable rather than fabricated.",
			inputSchema: customPassReference.extend({
				nodeIds: z.array(z.string().min(1)).max(32).optional().describe("Optional texture-load node filter. At most 32 nodes are returned."),
				width: z.number().int().min(16).max(128).optional().describe("Maximum thumbnail width. Defaults to 96."),
				height: z.number().int().min(16).max(128).optional().describe("Maximum thumbnail height. Defaults to 96."),
				sampling: z.enum(["nearest", "bilinear"]).optional().describe("Thumbnail resampling. Defaults from the pass sampling mode."),
				includeImage: z.boolean().optional().describe("Include bounded base64 PNG bytes. Defaults to true; false returns metadata and hashes only."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_texture_node_previews", args)
	);
	server.registerTool(
		"capture_custom_render_pass_output",
		{
			title: "Capture custom render-pass output",
			description:
				"Read one live named shader, copy, scene-raster, WebGPU-compute, or MRT attachment output through its stable texture and encode a bounded PNG preview. Returns source/output formats and dimensions, readiness, orientation, non-finite float count, source/preview pixel hashes, average/min/max RGBA, alpha coverage, and optional base64 PNG bytes.",
			inputSchema: z.object({
				output: z.string().min(1).describe("Named render-graph output or MRT attachment to read."),
				width: z.number().int().min(16).max(256).optional().describe("Maximum preview width. Defaults to 128."),
				height: z.number().int().min(16).max(256).optional().describe("Maximum preview height. Defaults to 128."),
				sampling: z.enum(["nearest", "bilinear"]).optional().describe("Preview resampling. Defaults to bilinear."),
				flipY: z.boolean().optional().describe("Flip GPU bottom-up rows to display orientation. Defaults to true."),
				includeImage: z.boolean().optional().describe("Include bounded base64 PNG bytes. Defaults to true."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_custom_render_pass_output", args)
	);
	server.registerTool(
		"debug_custom_compute_node_graph",
		{
			title: "Debug custom compute node graph",
			description:
				"Return static topology/missing-input/dead-node analysis, compiler status/order, CPU node previews, live target readiness/errors, dispatch counters and CPU submission timing, plus isolated hardware GPU pass timing when profiling is enabled and supported. Whole-frame GPU context remains separately labeled.",
			inputSchema: customPassReference.extend({
				...computePreviewFields,
				includeWgsl: z.boolean().optional().describe("Include generated WGSL in the response. Defaults to false."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("debug_custom_compute_node_graph", args)
	);
	server.registerTool(
		"get_custom_compute_node_profile",
		{
			title: "Get custom compute node profile",
			description:
				"Read live per-pass dispatch count and CPU submission duration plus isolated hardware GPU timestamp statistics from the render-graph profiler. Returns explicit capability/reason and separately labeled frame context; CPU or whole-frame timing is never substituted for pass duration.",
			inputSchema: customPassReference.extend({
				includeSamples: z.boolean().optional().describe("Include recent raw isolated GPU millisecond samples. Defaults to false."),
				sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum raw samples returned. Defaults to 60."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_node_profile", args)
	);
	server.registerTool(
		"set_custom_compute_storage_buffer_data",
		{
			title: "Set custom compute storage-buffer data",
			description:
				"Update a bounded typed range in a compute pass storage buffer without rebuilding the graph. Persisted updates fan out atomically to every pass using the same sharedResource. By default values become future initial data and are also applied to the live WebGPU allocation. persist false is live-only and errors when no live compute runtime exists.",
			inputSchema: customPassReference.extend({
				bufferName: z.string().min(1).describe("WGSL storage-buffer binding name."),
				data: z.array(z.number()).min(1).max(65_536).describe("Replacement typed values; numeric type and 32-bit range follow the authored buffer dataType."),
				elementOffset: z.number().int().min(0).optional().describe("Destination element offset. Defaults to 0."),
				persist: z.boolean().optional().describe("Persist values as authored initial data. Defaults to true."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_storage_buffer_data", args)
	);
	server.registerTool(
		"set_custom_compute_uniform_buffer_values",
		{
			title: "Set custom compute uniform-buffer values",
			description:
				"Update selected fields of one structured compute uniform buffer without rebuilding the graph. Values are validated against each authored float/vector/int/uint field. Defaults to persisting the values and applying them to the live WebGPU buffer; persist false requires a live runtime.",
			inputSchema: customPassReference.extend({
				bufferName: z.string().min(1).describe("WGSL uniform-buffer binding name."),
				values: z
					.record(z.string(), z.array(z.number()).min(1).max(4))
					.refine((value) => Object.keys(value).length > 0, "Provide at least one uniform field.")
					.describe("Uniform field names mapped to scalar/vector values."),
				persist: z.boolean().optional().describe("Persist values as authored defaults. Defaults to true."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_uniform_buffer_values", args)
	);
	server.registerTool(
		"read_custom_compute_storage_buffer",
		{
			title: "Read custom compute storage buffer",
			description:
				"Read a bounded typed storage-buffer range. source runtime performs real asynchronous GPU readback and requires a live WebGPU compute graph; source authored returns persisted initial values without GPU access. Use small ranges to keep responses focused.",
			inputSchema: customPassReference.extend({
				bufferName: z.string().min(1),
				source: z.enum(["runtime", "authored"]).optional().describe("Defaults to runtime."),
				elementOffset: z.number().int().min(0).optional(),
				elementCount: z.number().int().min(1).max(65_536).optional(),
				noDelay: z.boolean().optional().describe("Request immediate GPU flushing for runtime readback. Defaults to false and may reduce performance when true."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("read_custom_compute_storage_buffer", args)
	);

	server.registerTool(
		"get_camera_post_processes",
		{
			title: "Get camera post-processes",
			description:
				"Read the post-process / rendering pipeline configurations attached to a camera: `default` (bloom, tone mapping, FXAA, vignette, depth of field, chromatic aberration, grain, sharpen, glow, color grading/curves), " +
				"`ssao` (ambient occlusion), `ssr` (screen-space reflections), `motionBlur`, `vls` (volumetric light scattering), `taa` (temporal anti-aliasing), and `customColor` (tint, saturation, contrast, brightness). " +
				"Each entry is the post-process config object, or null when that post-process is disabled for the camera. Use this before `set_camera_post_process` to read current values.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target camera (preferred). Get it from `get_scene_hierarchy`."),
				nodeName: z.string().optional().describe("Name of the target camera."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_camera_post_processes", args)
	);

	server.registerTool(
		"set_camera_post_process",
		{
			title: "Set camera post-process",
			description:
				"Enable, disable and customize a per-camera post-process in realtime. IMPORTANT: post-processes are per-camera, so this switches the editor's active camera to the target camera " +
				"so the effect is set up on it and will be available at runtime in the game. Pass `enabled:false` to remove the post-process. " +
				"Pass `properties` (a flat map) to configure it; create the post-process first by calling with `enabled:true`. " +
				"Examples — type `default`: `{ bloomEnabled:true, bloomWeight:0.6, toneMappingEnabled:true, toneMappingType:1, exposure:1.2, vignetteEnabled:true, depthOfFieldEnabled:true, fStop:1.4, focusDistance:55000, fxaaEnabled:true, grainEnabled:true, grainIntensity:15, chromaticAberrationEnabled:true }`; " +
				"type `ssao`: `{ radius:2, totalStrength:1, samples:16 }`; type `ssr`: `{ strength:1, thickness:0.5, samples:16 }`; type `motionBlur`: `{ motionStrength:1, isObjectBased:true }`; type `vls`: `{ exposure:0.3, decay:0.96, weight:0.4, density:0.9 }`; type `customColor`: `{ tint:[1,0.8,0.7], tintStrength:0.4, saturation:1.15, contrast:1.1, brightness:0.02 }`. " +
				"Returns the resulting config. Verify the look with `get_screenshot`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target camera (preferred)."),
				nodeName: z.string().optional().describe("Name of the target camera."),
				type: z.enum(["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"]).describe("Which post-process / rendering pipeline to configure."),
				enabled: z.boolean().optional().describe("Enable (create if missing) or disable (remove) the post-process for this camera. Defaults to true."),
				properties: z
					.record(z.string(), z.any())
					.optional()
					.describe(
						"Flat map of post-process properties to set. Keys depend on `type` (see the examples in this tool's description). Arrays are coerced to colors/vectors where relevant."
					),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_post_process", args)
	);
}

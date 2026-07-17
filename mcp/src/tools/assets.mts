import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callImageTool, callTextTool } from "./helpers.mjs";

const importerKindSchema = z.enum(["texture", "model", "audio", "video", "font", "material", "animation", "custom"]);
const importerSettingsSchema = z
	.record(z.string().min(1).max(64), z.union([z.boolean(), z.number().finite(), z.string().max(65_536)]))
	.refine((value) => Object.keys(value).length <= 64, "Importer settings support at most 64 fields.");
const modelAnimationClipSchema = z
	.object({
		name: z.string().trim().min(1).max(128).describe("Unique output AnimationGroup name."),
		sourceAnimationGroup: z.string().trim().min(1).max(256).describe("Exact imported source AnimationGroup name."),
		from: z.number().finite().min(-10_000_000).max(10_000_000).describe("Inclusive source start frame."),
		to: z.number().finite().min(-10_000_000).max(10_000_000).describe("Inclusive source end frame; must be greater than from."),
		loopTime: z.boolean().optional().describe("Mark the generated AnimationGroup as looping."),
		loopPose: z.boolean().optional().describe("Make the generated final key match its first pose; requires loopTime=true."),
		rootMotionNode: z.string().trim().max(256).optional().describe("Optional exact animated target name or id used for root-motion validation/metadata."),
		rootMotionPosition: z.enum(["none", "xz", "xyz"]).optional().describe("Position components requested from rootMotionNode."),
		rootMotionRotationY: z.boolean().optional().describe("Request Y-rotation root motion from rootMotionNode."),
		targetMask: z
			.array(z.string().trim().min(1).max(256))
			.max(256)
			.optional()
			.describe("Optional exact target names/ids retained in this clip; omitted or empty retains every source track."),
	})
	.strict();
const modelMaterialRemapSchema = z
	.object({
		sourceMaterial: z.string().trim().min(1).max(512).describe("Exact case-sensitive material name discovered by get_model_material_remaps."),
		materialPath: z
			.string()
			.trim()
			.min(10)
			.max(1024)
			.refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && value.toLowerCase().endsWith(".material"), {
				message: "materialPath must be a contained project-relative .material asset path.",
			})
			.describe("Contained project-relative .material replacement path, for example assets/materials/hero-body.material."),
	})
	.strict();
const modelGeneratedLodSchema = z
	.object({
		quality: z.number().finite().min(0.01).max(0.99).describe("Target retained triangle ratio; later levels must use a strictly lower value."),
		distance: z.number().finite().gt(0).max(1_000_000_000).describe("Camera transition distance in editor centimeters; levels must be strictly increasing."),
	})
	.strict();
const modelAuthoredLodLevelSchema = z
	.object({
		mesh: z.string().trim().min(1).max(512).describe("Exact case-sensitive imported mesh name used for this lower-detail level."),
		distance: z.number().finite().gt(0).max(1_000_000_000).describe("Camera transition distance in editor centimeters; levels must be strictly increasing."),
	})
	.strict();
const modelAuthoredLodGroupSchema = z
	.object({
		sourceMesh: z.string().trim().min(1).max(512).describe("Exact case-sensitive highest-detail imported mesh name (LOD0)."),
		levels: z.array(modelAuthoredLodLevelSchema).min(1).max(8).describe("Ordered existing lower-detail meshes and increasing transition distances."),
	})
	.strict();
const modelPlatformOverrideSchema = z
	.object({
		enabled: z.boolean().describe("Whether this target uses the supplied values instead of Default model settings."),
		scaleFactor: z.number().finite().min(0.0001).max(100000).optional(),
		convertUnits: z.boolean().optional(),
		importMaterials: z.boolean().optional(),
		generatedLods: z.array(modelGeneratedLodSchema).max(8).optional(),
		importTextures: z.boolean().optional(),
		importAnimations: z.boolean().optional(),
		animationType: z.enum(["none", "generic", "humanoid"]).optional(),
		optimizeGameObjects: z.boolean().optional(),
		generateColliders: z.boolean().optional(),
		meshCompression: z.enum(["none", "low", "medium", "high"]).optional(),
		optimizeMesh: z.boolean().optional(),
		weldVertices: z.boolean().optional(),
		normals: z.enum(["import", "calculate", "none"]).optional(),
		tangents: z.enum(["import", "calculate", "none"]).optional(),
	})
	.strict();

export function registerAssetTools(server: McpServer): void {
	server.registerTool(
		"list_asset_importer_types",
		{
			title: "List asset importer types",
			description:
				"List the versioned texture, model, audio, video, font, material, animation, and custom importer contracts with supported extensions, bounded field descriptors, enum/range constraints, and effective defaults.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_asset_importer_types", {})
	);
	server.registerTool(
		"get_asset_importer",
		{
			title: "Get asset importer",
			description: "Read one existing file asset's inferred importer kind and effective versioned settings after legacy metadata migration.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_importer", args)
	);
	server.registerTool(
		"open_asset_inspector",
		{
			title: "Open asset Inspector",
			description:
				"Open the editor's normal File Inspector for one indexed project asset and browse its containing folder. This exposes organization, import health, type-specific importer controls, dependency evidence, and specialized preview UI without modifying the asset.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_asset_inspector", args)
	);
	server.registerTool(
		"validate_asset_importer_settings",
		{
			title: "Validate asset importer settings",
			description:
				"Validate a bounded type-specific importer settings patch against one existing asset without changing the project. Returns the complete effective configuration or an actionable range/enum/type error.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				settings: importerSettingsSchema,
				replace: z.boolean().optional().describe("Reset unspecified fields to type defaults before validation."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_asset_importer_settings", args)
	);
	server.registerTool(
		"set_asset_importer_settings",
		{
			title: "Set asset importer settings",
			description:
				"Validate every target, then apply one bounded importer settings patch to up to 100 compatible file assets. All paths are validated before any sidecar is written. includeInBuild is honored for every packaged asset; executed texture, audio, video, font, material, and animation changes are previewed and applied through their get_*_importer_result then apply_*_importer tools.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
				settings: importerSettingsSchema,
				replace: z.boolean().optional().describe("Reset unspecified fields to type defaults before applying."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_importer_settings", args)
	);
	server.registerTool(
		"get_texture_importer_result",
		{
			title: "Get texture importer result",
			description:
				"Inspect one PNG/JPEG/BMP/WebP/GIF/TIFF/SVG texture under its exact source/settings fingerprint without modifying files. Returns current/stale preview state, source/output format, dimensions, channels, alpha, byte size, resizing, effective sRGB/linear sampling, generated mip paths, CPU-readable RGBA8 artifacts, compression settings, warnings, and portable paths.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative supported LDR texture asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_texture_importer_result", args)
	);
	server.registerTool(
		"apply_texture_importer",
		{
			title: "Apply texture importer",
			description:
				"After confirm=true, execute one supported LDR texture's current importer under the exact fingerprint returned by get_texture_importer_result. Atomically publishes a project-local preview artifact, applies max-size/aspect-safe resizing, alpha removal, deterministic per-format compression, texture-type color-space semantics, two runtime quality mip variants, and optional bounded RGBA8 CPU-readable output. Editor and CLI builds publish the same portable .bjstexture.json redirect/metadata contract.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative supported LDR texture asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_texture_importer_result."),
					confirm: z.boolean().describe("Must be true to publish or replace imported preview artifacts."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_texture_importer", args)
	);
	server.registerTool(
		"get_audio_importer_result",
		{
			title: "Get audio importer result",
			description:
				"Inspect one audio asset's exact source/settings fingerprint and deterministic project-local imported artifact. Returns current/stale state plus source/output codec, container, duration, sample rate, channel count, bit rate, byte size, transcode status, and effective runtime load type without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative MP3/OGG/WAV/FLAC/M4A asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_audio_importer_result", args)
	);
	server.registerTool(
		"apply_audio_importer",
		{
			title: "Apply audio importer",
			description:
				"After confirm=true, apply one audio asset's current importer under the exact fingerprint returned by get_audio_importer_result. Uses bounded shell-free FFmpeg/FFprobe execution to preserve or transcode the container, set sample rate, downmix mono, normalize loudness, apply quality, and atomically publish the preview/runtime artifact with probe evidence.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_audio_importer", args)
	);
	server.registerTool(
		"get_video_importer_result",
		{
			title: "Get video importer result",
			description:
				"Inspect one video asset's exact source/settings fingerprint and deterministic project-local imported artifact. Returns current/stale state plus container, duration, dimensions, frame rate, video/audio codecs, bit rates, byte sizes, transcode status, and the effective output path without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative MP4/WebM/OGV/MOV asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_video_importer_result", args)
	);
	server.registerTool(
		"apply_video_importer",
		{
			title: "Apply video importer",
			description:
				"After confirm=true, apply one video's importer under the exact fingerprint returned by get_video_importer_result. Uses bounded shell-free FFmpeg/FFprobe execution to preserve or transcode MP4/WebM/OGV/MOV, cap dimensions without stretching, map quality, optionally remove audio, and atomically publish the preview/runtime artifact with probe evidence.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_video_importer", args)
	);
	server.registerTool(
		"get_font_importer_result",
		{
			title: "Get font importer result",
			description:
				"Inspect one font asset's exact source/settings fingerprint and deterministic imported artifacts. Reports dynamic/bitmap/SDF/MSDF mode, family, glyph and missing-codepoint counts, atlas pages and dimensions, byte sizes, and portable manifest paths without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative TTF/OTF/WOFF/WOFF2 font asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_font_importer_result", args)
	);
	server.registerTool(
		"apply_font_importer",
		{
			title: "Apply font importer",
			description:
				"After confirm=true, apply one font's importer under the exact fingerprint returned by get_font_importer_result. Dynamic mode publishes the source font and browser FontFace metadata; bitmap, SDF, and genuine MSDF modes generate packed Unicode glyph pages, metrics, kerning, and a portable runtime manifest using a bundled WASM atlas generator.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_font_importer", args)
	);
	server.registerTool(
		"get_material_importer_result",
		{
			title: "Get material importer result",
			description:
				"Inspect one .material or Wavefront .mtl asset's exact source/settings fingerprint and current imported evidence. Reports Babylon/Node/MTL type, project/embedded/remote texture references, missing textures, extracted PNG/JPEG files, Node Material compile errors/warnings/statistics, and overall validity without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative .material or .mtl asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_material_importer_result", args)
	);
	server.registerTool(
		"apply_material_importer",
		{
			title: "Apply material importer",
			description:
				"After confirm=true, apply one material's importer under the exact fingerprint returned by get_material_importer_result. Validates project texture references, extracts bounded embedded PNG/JPEG data into deterministic files when enabled, compiles Babylon Node Material graphs when enabled, and atomically publishes the preview/report artifact.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_material_importer", args)
	);
	server.registerTool(
		"get_model_importer_result",
		{
			title: "Get model importer result",
			description:
				"Inspect one GLB, glTF, Babylon, OBJ, STL, FBX, DAE, or 3DS asset under its exact source/settings/dependency fingerprint. Executes the headless import plan and reports native or Assimp-to-GLB2 conversion evidence, tracked dependencies, unit scaling, geometry/resources, Humanoid/Generic rig validation, Optimize Game Object candidates/removals, retargeted animation tracks, requested/automatic/missing exposed transforms, warnings, errors, and validity without changing project files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_importer_result", args)
	);
	server.registerTool(
		"set_model_rig_optimization",
		{
			title: "Set model rig optimization",
			description:
				"Configure Unity-style Optimize Game Object for one model asset. When enabled on a Generic or Humanoid rig, importer execution removes skeleton-only Transform nodes, retargets their animation tracks to internal Babylon bones, flattens the retained hierarchy, and preserves requested hierarchy paths or unique bone names as synchronized script/attachment proxies. Returns a new exact importer fingerprint; inspect it with get_model_importer_result before apply_model_importer.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
				enabled: z.boolean(),
				exposedTransforms: z
					.array(z.string().min(1).max(512))
					.max(128)
					.optional()
					.describe("Full hierarchy paths or unique bone names to keep available for scripts, IK targets, sockets, and attachments."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_rig_optimization", args)
	);
	server.registerTool(
		"get_model_animation_clips",
		{
			title: "Get model animation clips",
			description:
				"Read one model asset's exact importer fingerprint, persisted Unity-style clip definitions, and latest processed source/output AnimationGroup evidence. Source evidence includes group names, ranges, FPS, track/key counts, and targets; generated evidence includes rebased ranges, loop controls, target masks, and root-motion resolution. Apply an unconfigured Model Importer once when no source evidence exists.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative GLB, glTF, Babylon, OBJ, STL, FBX, DAE, or 3DS asset path."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_animation_clips", args)
	);
	server.registerTool(
		"set_model_animation_clips",
		{
			title: "Set model animation clips",
			description:
				"Atomically replace up to 64 per-model animation clip definitions under the exact fingerprint from get_model_animation_clips. Each clip slices one imported AnimationGroup by frame range, rebases it to frame zero, optionally closes the loop pose, filters exact animated targets, and validates selected position/Y-rotation root-motion tracks. This updates importer metadata only; inspect and apply the returned model-importer fingerprint to publish the processed Babylon model.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_animation_clips."),
					clips: z.array(modelAnimationClipSchema).max(64).describe("Complete replacement clip set; send an empty array to preserve source groups unchanged."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_animation_clips", args)
	);
	server.registerTool(
		"get_model_material_remaps",
		{
			title: "Get model material remaps",
			description:
				"Read one model asset's exact importer fingerprint, complete persisted material-remap table, and latest executed source-material evidence. Evidence reports exact source names, duplicate material-object counts, mesh/submesh reference counts, texture counts, replacement resolution, warnings, and errors. Apply an unconfigured Model Importer once when source evidence is empty.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative GLB, glTF, Babylon, OBJ, STL, FBX, DAE, or 3DS asset path."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_material_remaps", args)
	);
	server.registerTool(
		"set_model_material_remaps",
		{
			title: "Set model material remaps",
			description:
				"Atomically replace up to 128 exact source-material to project .material mappings under the fingerprint from get_model_material_remaps. The importer resolves contained replacement assets, supports direct and MultiMaterial/submesh references, records replacement assets as build dependencies, and invalidates its exact lease when they change. This updates metadata only; inspect and apply the returned fingerprint to publish the processed model.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_material_remaps."),
					remaps: z.array(modelMaterialRemapSchema).max(128).describe("Complete replacement table; send an empty array to remove every remap."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_material_remaps", args)
	);
	server.registerTool(
		"get_model_material_search",
		{
			title: "Get model material search",
			description:
				"Read one model asset's exact importer fingerprint, Unity-style material naming/search configuration, explicit-remap priority, and latest deterministic match evidence. The result reports the generated candidate name, searched material count, ordered candidate paths, unique match, and ambiguity for every imported source material.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_material_search", args)
	);
	server.registerTool(
		"set_model_material_search",
		{
			title: "Set model material search",
			description:
				"Atomically replace one model's automatic material naming and search configuration under the exact fingerprint from get_model_material_search. Search can be disabled, limited to the adjacent Materials folder, walk parent Materials folders nearest-first, or cover the project. Naming can use the source material, first base-texture name with source fallback, or model-plus-material. Explicit material remaps always take priority; ambiguous best-rank matches are never guessed.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_material_search."),
					naming: z.enum(["sourceMaterial", "baseTextureName", "modelAndMaterial"]).describe("Complete automatic naming mode."),
					search: z.enum(["none", "local", "recursiveUp", "projectWide"]).describe("Complete automatic search scope."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_material_search", args)
	);
	server.registerTool(
		"get_model_platform_overrides",
		{
			title: "Get model platform overrides",
			description:
				"Read one model asset's complete Web/Desktop override map, exact importer fingerprint, and fully resolved effective settings for both targets. Web build profiles execute Web values; Electron profiles execute Desktop values; disabled or absent targets inherit Default settings. The selected target participates in editor/CLI cache keys and result evidence.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_platform_overrides", args)
	);
	server.registerTool(
		"set_model_platform_overrides",
		{
			title: "Set model platform overrides",
			description:
				"Atomically replace the complete closed Web/Desktop model-import override map under the exact fingerprint from get_model_platform_overrides. Each enabled target may override scale/unit conversion, material/texture/animation inclusion, rig optimization, collider generation, mesh compression/optimization/welding, normals/tangents, and up to eight generated LOD levels. Send an empty overrides object to inherit Default settings everywhere; then run the matching Web or Electron build profile.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_platform_overrides."),
					overrides: z
						.object({ web: modelPlatformOverrideSchema.optional(), desktop: modelPlatformOverrideSchema.optional() })
						.strict()
						.describe("Complete replacement map; omission of a target removes its stored override."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_platform_overrides", args)
	);
	server.registerTool(
		"inspect_model_material_extraction",
		{
			title: "Inspect model material extraction",
			description:
				"Plan Unity-style extraction of every embedded model material into editable project .material assets without modifying files. The bounded plan uses the sibling Materials folder by default, sanitizes portable filenames, reports create/reuse/conflict decisions, reuses only content-equivalent assets, and never overwrites an existing file.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative GLB, glTF, Babylon, OBJ, STL, FBX, DAE, or 3DS model path."),
					destinationFolder: z.string().min(6).max(1024).optional().describe("Optional contained project Assets folder; defaults to a sibling Materials folder."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_model_material_extraction", args)
	);
	server.registerTool(
		"extract_model_materials",
		{
			title: "Extract model materials",
			description:
				"After confirm=true, execute the exact collision-safe plan from inspect_model_material_extraction. Atomically creates new editable .material assets, reuses only equivalent existing assets, rolls back newly created files on failure, and persists exact source-material remaps so editor preview and editor/CLI builds use the extracted assets. Existing files are never overwritten.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					destinationFolder: z
						.string()
						.min(6)
						.max(1024)
						.optional()
						.describe("Must match the optional destinationFolder used while inspecting; omission uses the same sibling Materials default."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by inspect_model_material_extraction."),
					confirm: z.boolean().describe("Must be true to create material assets and update the model importer remaps."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("extract_model_materials", args)
	);
	server.registerTool(
		"inspect_model_texture_extraction",
		{
			title: "Inspect model texture extraction",
			description:
				"After embedded materials have been extracted, plan Unity-style extraction of their embedded PNG/JPEG payloads into editable project textures without modifying files. The exact bounded plan deduplicates identical images, validates signatures and size limits, defaults to a sibling Textures folder, reports create/reuse/conflict decisions, and lists every editable material that will be rewritten.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path whose exact material remaps identify editable materials."),
					destinationFolder: z.string().min(6).max(1024).optional().describe("Optional contained project Assets folder; defaults to a sibling Textures folder."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_model_texture_extraction", args)
	);
	server.registerTool(
		"extract_model_textures",
		{
			title: "Extract model textures",
			description:
				"After confirm=true, execute the exact plan from inspect_model_texture_extraction. Atomically creates or content-reuses editable PNG/JPEG assets and rewrites the model's extracted .material files from embedded data to project texture paths. Existing textures are never overwritten, material originals are transactionally backed up, and all created files/material changes roll back on failure.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					destinationFolder: z.string().min(6).max(1024).optional().describe("Must match inspection; omission uses the sibling Textures default."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by inspect_model_texture_extraction."),
					confirm: z.boolean().describe("Must be true to create textures and rewrite editable material files."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("extract_model_textures", args)
	);
	server.registerTool(
		"get_model_authored_lods",
		{
			title: "Get authored model LODs",
			description:
				"Read one model asset's exact importer fingerprint, complete artist-authored LOD group table, latest applied geometry/deformation evidence, and deterministic suggestions for exact Name_LOD0/Name_LOD1/... mesh conventions. Apply an unconfigured Model Importer once when mesh-name suggestions are empty.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_authored_lods", args)
	);
	server.registerTool(
		"set_model_authored_lods",
		{
			title: "Set authored model LODs",
			description:
				"Atomically replace up to 128 explicit imported-mesh LOD groups under the exact fingerprint from get_model_authored_lods. Each mesh may appear once, every group has one exact LOD0 source and up to eight existing lower-detail meshes, and transition distances strictly increase. The next importer application validates all names before mutation, attaches Babylon runtime LOD switching, disables collisions on lower levels, preserves authored geometry/materials/skin/morph data, excludes assigned meshes from generated simplification, and serializes the links for editor and CLI builds.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_authored_lods."),
					groups: z.array(modelAuthoredLodGroupSchema).max(128).describe("Complete ordered replacement table; send an empty array to clear authored assignments."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_authored_lods", args)
	);
	server.registerTool(
		"get_model_generated_lods",
		{
			title: "Get generated model LODs",
			description:
				"Read one model asset's exact importer fingerprint, complete generated-LOD level table, and latest per-source execution evidence. Evidence includes deformation mode, source/output vertices and triangles, exact provenance count, preserved vertex/skin streams, reconstructed morph targets and animation tracks, actual reduction, transition distance, authored-LOD skips, bounded-processing errors, and warnings. Apply an unconfigured Model Importer once when generated evidence is empty.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_generated_lods", args)
	);
	server.registerTool(
		"set_model_generated_lods",
		{
			title: "Set generated model LODs",
			description:
				"Atomically replace up to eight ordered quadratic-error LOD definitions under the exact fingerprint from get_model_generated_lods. Distances must strictly increase and retained quality must strictly decrease. The next importer application generates bounded static, skinned, and morph-target LOD geometry; reconstructs bone streams and morph deltas from exact source-vertex provenance; preserves morph animation bindings, transforms, materials, and MultiMaterial slots; serializes runtime switching and influence synchronization metadata; and skips already-authored LOD meshes with diagnostics.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_generated_lods."),
					levels: z.array(modelGeneratedLodSchema).max(8).describe("Complete ordered replacement level table; send an empty array to disable generation."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_generated_lods", args)
	);
	server.registerTool(
		"apply_model_importer",
		{
			title: "Apply model importer",
			description:
				"After confirm=true, execute one model asset's importer under the exact fingerprint from get_model_importer_result and atomically publish a processed Babylon model. Applies scale/unit conversion, Unity-style deterministic material search plus exact project-material remaps including MultiMaterial/submesh slots, bounded deformation-safe generated static/skinned/morph LODs, material/texture/animation inclusion, Humanoid/Generic rig analysis, Optimize Game Object with synchronized exposed attachment transforms, collision flags, welding, index optimization, normals/tangents policy, and bounded vertex quantization. Native and bounded Assimp-converted formats use the same processor.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_model_importer", args)
	);
	server.registerTool(
		"get_animation_importer_result",
		{
			title: "Get animation importer result",
			description:
				"Inspect one .animation/.animations clip asset or .animator/.controller state-machine asset under its exact source/settings fingerprint. Reports source format, clip/track timing, source/output frame rates, source/resampled/output key counts, loop state, root-motion resolution, and Unity YAML controller layer/parameter/state/transition/Blend Tree/reference-binding diagnostics without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative .animation, .animations, .animator, or .controller asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animation_importer_result", args)
	);
	server.registerTool(
		"apply_animation_importer",
		{
			title: "Apply animation importer",
			description:
				"After confirm=true, execute one animation asset's importer under the exact fingerprint from get_animation_importer_result. Resamples clip curves or converts bounded Unity multi-document YAML Animator Controllers into portable editor-controller artifacts with explicit Motion/AvatarMask binding requirements, diagnostics, and unsupported-feature evidence, then publishes atomically.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_animation_importer", args)
	);

	server.registerTool(
		"get_asset_registry_status",
		{
			title: "Get asset registry status",
			description: "Report the persistent GUID-first asset registry version, entry/hash counts, generation time, and duplicate GUID conflicts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_registry_status", {})
	);
	server.registerTool(
		"get_asset_indexing_status",
		{
			title: "Get background asset indexing status",
			description:
				"Read isolated-worker availability/runtime, default concurrency, the active background rebuild/refresh phase and file progress, plus up to 20 recent completed, cancelled, or failed jobs. This never starts a scan.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_indexing_status", {})
	);
	server.registerTool(
		"start_asset_indexing",
		{
			title: "Start background asset indexing",
			description:
				"Start one non-blocking worker-backed asset registry job. Rebuild discovers the complete contained project index; refresh rescans exactly 1-100 contained paths. Returns a job id immediately; poll get_asset_indexing_status for authoritative completion. The previous registry remains authoritative until atomic publication.",
			inputSchema: z.object({
				mode: z.enum(["rebuild", "refresh"]).optional().describe("Full rebuild by default, or bounded path refresh."),
				paths: z.array(z.string().min(1).max(1024)).min(1).max(100).optional().describe("Required only for refresh mode; project-relative files or folders."),
				workerCount: z.number().int().min(1).max(8).optional().describe("Bounded isolated-worker concurrency; defaults to min(4, logical CPUs minus one)."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_asset_indexing", args)
	);
	server.registerTool(
		"cancel_asset_indexing",
		{
			title: "Cancel background asset indexing",
			description:
				"Request cooperative cancellation of the active queued/running asset-indexing job by exact UUID. Workers terminate before publication, so the last complete registry remains authoritative. Poll status until the job reports cancelled.",
			inputSchema: z.object({ jobId: z.string().uuid() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_asset_indexing", args)
	);
	server.registerTool(
		"query_asset_registry",
		{
			title: "Query asset registry",
			description:
				"Query the persistent assets/src registry by stable GUID, path text, type, folder, label, tag, favorite state, or import status with bounded pagination and content fingerprints.",
			inputSchema: z.object({
				guid: z.string().min(1).optional(),
				query: z.string().optional(),
				type: z.string().min(1).optional(),
				folder: z.string().optional(),
				recursive: z.boolean().optional().describe("Include nested descendants of folder. Defaults to true; false returns direct file children only."),
				label: z.string().optional(),
				tag: z.string().min(1).max(64).optional(),
				favorite: z.boolean().optional(),
				importStatus: z.enum(["native", "unchecked", "current", "stale", "missing", "error"]).optional(),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("query_asset_registry", args)
	);
	server.registerTool(
		"rebuild_asset_registry",
		{
			title: "Rebuild asset registry",
			description:
				"Atomically rebuild the persistent registry and missing GUID sidecars. Duplicate GUIDs are diagnostic-only unless repairDuplicateGuids and confirmRepair are both true; repair preserves the first sorted path and regenerates later identities.",
			inputSchema: z.object({
				repairDuplicateGuids: z.boolean().optional(),
				confirmRepair: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebuild_asset_registry", args)
	);
	server.registerTool(
		"refresh_asset_registry_paths",
		{
			title: "Refresh asset registry paths",
			description: "Incrementally remove or rescan bounded project-contained files/folders in the persistent asset registry after external changes.",
			inputSchema: z.object({ paths: z.array(z.string().min(1)).min(1).max(100) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_asset_registry_paths", args)
	);

	server.registerTool(
		"get_asset_watch_status",
		{
			title: "Get asset watch status",
			description:
				"Report whether automatic local watching of the active project's assets/src folders is running, together with the detected change count and latest external file event.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_watch_status", {})
	);
	server.registerTool(
		"refresh_watched_assets",
		{
			title: "Refresh watched assets",
			description: "Force the Assets Browser to immediately rebuild its watched project asset tree/items. Automatic watching normally does this after a short debounce.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("refresh_watched_assets", {})
	);

	server.registerTool(
		"list_assets",
		{
			title: "List assets",
			description:
				"List the project's assets, optionally filtered by `type` and/or `folder`. Each entry reports `hasPreview` indicating whether the containing folder has an `editor_preview` image. " +
				"Always check existing assets BEFORE downloading from the marketplace — reuse what is already in the project when it fits the request.",
			inputSchema: z.object({
				type: z
					.enum([
						"texture",
						"cube-texture",
						"mesh",
						"sound",
						"video",
						"material",
						"particle",
						"gui",
						"navmesh",
						"scene",
						"prefab",
						"animation",
						"shader",
						"script",
						"style",
						"markup",
						"font",
						"data",
						"other",
					])
					.optional()
					.describe("Filter by asset type."),
				folder: z.string().optional().describe("Project-relative folder to list. Defaults to the whole assets tree."),
				recursive: z.boolean().optional().describe("Include nested descendants of folder. Defaults to true; false returns direct file children only."),
				query: z.string().optional().describe("Case-insensitive text to search in project-relative asset paths."),
				label: z.string().optional().describe("Return only assets with this persisted label."),
				tag: z.string().min(1).max(64).optional().describe("Return only assets with this project tag."),
				favorite: z.boolean().optional().describe("Filter by project-local favorite state."),
				importStatus: z.enum(["native", "unchecked", "current", "stale", "missing", "error"]).optional(),
				offset: z.number().int().min(0).optional().describe("Zero-based result offset. Defaults to 0."),
				limit: z.number().int().min(1).max(500).optional().describe("Maximum results to return. Defaults to 100."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_assets", args)
	);

	server.registerTool(
		"list_asset_dependency_scanners",
		{
			title: "List asset dependency scanners",
			description:
				"Discover persistent dependency scanner kinds, supported extensions, byte limits, and parsing scope for editor/source text, GLB, FBX, 3DS, and bounded ZIP/TAR/TAR-GZip/Unity-package compound assets.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_asset_dependency_scanners", {})
	);
	server.registerTool(
		"get_asset_dependencies",
		{
			title: "Get asset dependencies",
			description:
				"Read one asset's persistent indexed direct dependencies or reverse references without rescanning the project. Archive results include bounded member inventory plus internal, missing, and project-external references. Every result reports complete, deferred, malformed, or not-applicable scanner status.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Project-relative file asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Dependencies by default; referencedBy finds text files that mention this asset path."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_dependencies", args)
	);
	server.registerTool(
		"get_asset_dependency_graph",
		{
			title: "Get asset dependency graph",
			description:
				"Traverse persistent asset dependency or reverse-reference edges from one indexed project file. Archive roots expand into virtual member and internal-reference nodes. Returns bounded nodes/edges, stable GUIDs/types, missing targets, cycles, containment relationships, and truncation state.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative root asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Traverse forward dependencies by default or reverse references."),
				depth: z.number().int().min(1).max(16).optional().describe("Maximum traversal depth. Defaults to 1."),
				includeMissing: z.boolean().optional().describe("Include missing forward targets. Defaults to true."),
				limit: z.number().int().min(1).max(1000).optional().describe("Maximum returned edges. Defaults to 200."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_dependency_graph", args)
	);
	server.registerTool(
		"export_asset_dependency_graph",
		{
			title: "Export asset dependency graph",
			description:
				"Format one bounded persistent asset dependency or reverse-reference graph as structured JSON, Graphviz DOT, or Mermaid text. Returns the complete content plus node/edge/cycle counts and a suggested filename without writing a file.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative root asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Traverse forward dependencies by default or reverse references."),
				depth: z.number().int().min(1).max(16).optional().describe("Maximum traversal depth. Defaults to 1."),
				includeMissing: z.boolean().optional().describe("Include missing forward targets. Defaults to true."),
				limit: z.number().int().min(1).max(1000).optional().describe("Maximum returned edges. Defaults to 200."),
				format: z.enum(["json", "dot", "mermaid"]).optional().describe("JSON by default, Graphviz DOT, or Mermaid flowchart text."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("export_asset_dependency_graph", args)
	);
	server.registerTool(
		"open_asset_dependency_graph",
		{
			title: "Open asset dependency graph",
			description:
				"Open the editor's interactive visual dependency canvas for one indexed asset after validating the requested bounded graph. The canvas supports Uses/Used By traversal, missing and cycle highlighting, search, zoom, rerooting, and Inspector navigation.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative root asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Initial traversal direction. Defaults to dependencies."),
				depth: z.number().int().min(1).max(16).optional().describe("Initial bounded traversal depth. Defaults to 1."),
				includeMissing: z.boolean().optional().describe("Include missing forward targets. Defaults to true."),
				limit: z.number().int().min(1).max(1000).optional().describe("Validation edge limit. Defaults to 200."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_asset_dependency_graph", args)
	);
	server.registerTool(
		"get_asset_dependency_diagnostics",
		{
			title: "Get asset dependency diagnostics",
			description:
				"List persistent project and inside-archive missing-reference diagnostics, dependency cycles, deferred size-bounded scans, and malformed GLB/FBX/3DS/archive dependency sources.",
			inputSchema: z.object({
				query: z.string().max(512).optional().describe("Case-insensitive source/target path filter."),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_dependency_diagnostics", args)
	);
	server.registerTool(
		"rebuild_asset_dependency_index",
		{
			title: "Rebuild asset dependency index",
			description:
				"Atomically rescan bounded project text, binary models, and compound archives, then rebuild forward/reverse/missing dependency edges and container-member evidence together with registry fingerprints.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("rebuild_asset_dependency_index", {})
	);
	server.registerTool(
		"get_asset_by_guid",
		{
			title: "Get asset by GUID",
			description:
				"Resolve a persisted Babylon.js Editor asset GUID to its current project-relative path and metadata. Use this after an asset may have been renamed or moved.",
			inputSchema: z.object({ guid: z.string().min(1) }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_by_guid", args)
	);
	server.registerTool(
		"get_asset_details",
		{
			title: "Get asset details",
			description: "Get an asset's path, type, file size, timestamps, directory status, and preview availability.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Project-relative asset or folder path."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_details", args)
	);

	server.registerTool(
		"import_asset",
		{
			title: "Import local asset",
			description:
				"Copy a local file or folder into the open project. The source must be an absolute local path; the destination must stay inside the project and defaults to `assets/<source name>`. This does not alter the source file.",
			inputSchema: z.object({
				sourcePath: z.string().min(1).describe("Absolute local file or folder path to copy into the project."),
				destinationPath: z.string().optional().describe("Project-relative destination path. Defaults to `assets/<source name>`."),
				labels: z.array(z.string().min(1)).optional().describe("Persisted asset labels to assign on import."),
				importer: z.record(z.string(), z.any()).optional().describe("Importer settings to persist in the asset sidecar."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("import_asset", args)
	);

	server.registerTool(
		"get_asset_preview",
		{
			title: "Get asset preview",
			description:
				"Return the preview image for an asset/folder (the folder's `editor_preview.png/jpg/bmp`, or a generated thumbnail) as an image. " +
				"BEFORE using an existing asset in the scene, view its preview here to confirm it visually matches the user's description.",
			inputSchema: z.object({
				path: z.string().describe("Project-relative or absolute path to the asset (or its folder)."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callImageTool("get_asset_preview", args)
	);

	server.registerTool(
		"convert_image_asset",
		{
			title: "Convert image asset",
			description:
				"Convert and optionally resize a project raster or SVG image. SVG sources are rasterized deterministically. `png`, `jpeg`, and `webp` create standard texture assets. `bitmap` creates an uncompressed `.rgba` RGBA8 pixel buffer plus a JSON descriptor for custom game/runtime asset pipelines.",
			inputSchema: z.object({
				sourcePath: z.string().min(1).describe("Project-relative source raster or SVG image path."),
				outputPath: z.string().min(1).describe("New project-relative output path; use .png, .jpg/.jpeg, .webp, or .rgba according to format."),
				format: z.enum(["png", "jpeg", "webp", "bitmap"]),
				width: z.number().int().positive().optional(),
				height: z.number().int().positive().optional(),
				fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
				withoutEnlargement: z.boolean().optional(),
				quality: z.number().int().min(1).max(100).optional().describe("JPEG/WebP quality. Defaults to 90."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("convert_image_asset", args)
	);

	server.registerTool(
		"set_asset_metadata",
		{
			title: "Set asset metadata",
			description:
				"Persist labels, separate project tags, favorite state, and importer settings in an atomic sidecar without changing source asset bytes. Importer settings are arbitrary JSON used by editor/build workflows.",
			inputSchema: z.object({
				path: z.string().min(1),
				labels: z.array(z.string().min(1)).max(64).optional(),
				tags: z.array(z.string().min(1).max(64)).max(64).optional(),
				favorite: z.boolean().optional(),
				importer: z.record(z.string(), z.any()).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_metadata", args)
	);
	server.registerTool(
		"set_asset_organization",
		{
			title: "Set asset tags and favorites",
			description:
				"Atomically replace separate project tags and/or project-local favorite state for up to 100 existing file assets while preserving GUIDs, labels, importer settings, and source bytes.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
				tags: z.array(z.string().min(1).max(64)).max(64).optional(),
				favorite: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_organization", args)
	);
	server.registerTool(
		"get_asset_import_status",
		{
			title: "Get asset import status",
			description:
				"Read one indexed asset's stable GUID, tags, favorite state, recorded source path, and persisted native/unchecked/current/stale/missing/error import state without touching the external source.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_import_status", args)
	);
	server.registerTool(
		"refresh_asset_import_states",
		{
			title: "Refresh asset import states",
			description:
				"Recheck bounded recorded source fingerprints for selected assets, or up to 500 imported assets, then atomically persist current, stale, missing, or error status. This reads recorded local source paths but never changes them.",
			inputSchema: z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(100).optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_asset_import_states", args)
	);
	server.registerTool(
		"list_asset_import_diagnostics",
		{
			title: "List asset import diagnostics",
			description:
				"List persisted unchecked, stale, missing-source, or failed-import diagnostics with bounded filtering and pagination. This does not access external sources; refresh first when current source state is required.",
			inputSchema: z.object({
				status: z.enum(["unchecked", "stale", "missing", "error"]).optional(),
				query: z.string().max(512).optional(),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_asset_import_diagnostics", args)
	);
	server.registerTool(
		"list_asset_importer_presets",
		{
			title: "List asset importer presets",
			description: "List project-persisted named importer presets, including settings, labels, and extension filters.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_asset_importer_presets", {})
	);
	server.registerTool(
		"set_asset_importer_preset",
		{
			title: "Set asset importer preset",
			description: "Create or replace a named project importer preset. The preset is saved under .bjseditor and does not modify assets until applied.",
			inputSchema: z.object({
				name: z.string().min(1),
				kind: importerKindSchema.optional(),
				importer: importerSettingsSchema,
				labels: z.array(z.string().min(1)).optional(),
				extensions: z.array(z.string().min(1)).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_importer_preset", args)
	);
	server.registerTool(
		"apply_asset_importer_preset",
		{
			title: "Apply asset importer preset",
			description:
				"Apply a named importer preset to project file assets. Importer settings and labels merge by default; set replaceImporter or mergeLabels false for replacement behavior.",
			inputSchema: z.object({
				name: z.string().min(1),
				paths: z.array(z.string().min(1)).min(1),
				replaceImporter: z.boolean().optional(),
				mergeLabels: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_asset_importer_preset", args)
	);
	server.registerTool(
		"delete_asset_importer_preset",
		{
			title: "Delete asset importer preset",
			description: "Delete a named importer preset without modifying any existing asset sidecars.",
			inputSchema: z.object({ name: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_asset_importer_preset", args)
	);
	server.registerTool(
		"reimport_asset",
		{
			title: "Reimport asset",
			description:
				"Replace an imported project asset with its recorded original source while retaining GUID, labels, and importer settings. Fails safely when no accessible source was recorded.",
			inputSchema: z.object({ path: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("reimport_asset", args)
	);
	server.registerTool(
		"instantiate_mesh_asset",
		{
			title: "Instantiate mesh asset",
			description:
				"Load a mesh asset (`.glb/.gltf/.babylon/.fbx`) into the scene — the equivalent of drag'n'dropping it in the editor preview. This is the main way to bring in rich, hand-editable content: trees, rocks, buildings, props, characters, vehicles, weapons, etc. glTF/glb assets are auto-scaled (x100) to editor units; do NOT re-apply scaling. " +
				"IMPORTANT for performance: import a mesh ONCE, then use `create_instance` to place many copies (e.g. a forest of trees, a street of identical buildings, a crowd). Importing the same asset repeatedly duplicates the geometry and is wasteful. " +
				"Find assets with `list_assets`, or download new ones via the visible marketplace tools. Returns `{ rootNodeId, createdNodes[] }`. Some assets ship multiple LOD meshes named `name_LOD0`, `name_LOD1`, ...; the editor does not wire LODs automatically.",
			inputSchema: z.object({
				path: z.string().describe("Project-relative or absolute path to the mesh asset."),
				name: z.string().optional().describe("Name for the instantiated root node."),
				parentId: z.string().optional().describe("Id of the parent node. Omit to add at the scene root."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_mesh_asset", args)
	);

	server.registerTool(
		"create_asset_folder",
		{
			title: "Create asset folder",
			description: "Create a folder inside the currently open Babylon.js Editor project. The path must be project-relative and cannot escape the project directory.",
			inputSchema: z.object({ path: z.string().min(1).describe("Project-relative path of the new folder.") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_asset_folder", args)
	);

	server.registerTool(
		"inspect_asset_move",
		{
			title: "Inspect semantic asset move",
			description:
				"Dry-run an asset or folder move using the persistent dependency index. Returns the stable source GUID, exact source/file leases, semantic text/GLB/ASCII-or-binary-FBX/3DS and bounded ZIP/TAR/TAR.GZ/Unity-package member rewrites, member/format evidence, malformed/oversized/semantic blockers, replacement counts, and a plan fingerprint without changing the project.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).max(1024).describe("Existing project-relative asset or folder path."),
					destinationPath: z.string().min(1).max(1024).describe("Unoccupied project-relative destination path."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_asset_move", args)
	);

	server.registerTool(
		"apply_asset_move",
		{
			title: "Apply semantic asset move",
			description:
				"Apply an exact inspect_asset_move plan. Preserves the sidecar GUID; atomically rewrites indexed text, GLB, ASCII/binary FBX, 3DS, and bounded ZIP/TAR/TAR.GZ/Unity-package members; verifies the plan fingerprint; and rolls back rebuilt archives, other rewritten files, and the move if any write fails. Malformed, oversized, or semantically unsafe referencers block by default.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).max(1024),
					destinationPath: z.string().min(1).max(1024),
					expectedPlanFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by inspect_asset_move."),
					allowUnsupportedReferences: z
						.boolean()
						.optional()
						.describe("Allow the move while leaving explicitly reported malformed, oversized, or semantically unsafe references unchanged. Defaults to false."),
					updateReferences: z
						.boolean()
						.optional()
						.describe("Apply planned semantic text/GLB/FBX/3DS/archive rewrites. Defaults to true; false performs an identity-preserving filesystem move only."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_asset_move", args)
	);

	server.registerTool(
		"move_asset",
		{
			title: "Move or rename asset",
			description:
				"Convenience move/rename using the same GUID-preserving semantic transaction as inspect_asset_move/apply_asset_move. Rewrites indexed relative/root text, GLB, ASCII/binary FBX, 3DS, and bounded ZIP/TAR/TAR.GZ/Unity-package members with rollback; malformed or unsafe sources block unless explicitly allowed. Prefer inspect then apply when concurrency safety matters.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).describe("Existing project-relative asset or folder path."),
					destinationPath: z.string().min(1).describe("New project-relative asset or folder path."),
					expectedPlanFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.optional()
						.describe("Optional exact dry-run fingerprint; stale plans are rejected."),
					allowUnsupportedReferences: z.boolean().optional(),
					updateReferences: z
						.boolean()
						.optional()
						.describe("Apply semantic reference rewrites. Defaults to true; set false for an identity-preserving filesystem-only move."),
					updateTextReferences: z.boolean().optional().describe("Deprecated alias for updateReferences retained for older clients."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("move_asset", args)
	);

	server.registerTool(
		"delete_asset",
		{
			title: "Delete asset",
			description: "Permanently delete an asset or folder inside the open project. You must set confirm to true after checking the path. The project root cannot be deleted.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Project-relative asset or folder path to delete."),
				confirm: z.literal(true).describe("Explicit confirmation for this destructive operation."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_asset", args)
	);
}

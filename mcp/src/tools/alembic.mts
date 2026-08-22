import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updateMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const artifactMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const identifier = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
	.describe("Exact stable Alembic player id returned by instantiate_alembic_asset or list_alembic_players.");
const playerName = z.string().trim().min(1).max(512);
const projectPath = z
	.string()
	.trim()
	.min(1)
	.max(4096)
	.refine((value) => value.toLowerCase().endsWith(".abc"), "Alembic project path must end with .abc.")
	.describe("Project-relative `.abc` source inside `assets/`, for example `assets/caches/cloth.abc`.");
const fingerprint = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 source/settings lease returned by inspect_alembic_import.");
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("Exact authored player revision returned by get_alembic_player or list_alembic_players.");
const time = z.number().finite().min(-1_000_000).max(1_000_000);
const positiveSize = z.number().finite().min(0.01).max(1000);
const speed = z
	.number()
	.finite()
	.min(-100)
	.max(100)
	.refine((value) => value !== 0, "Alembic playback speed must be non-zero.");
const coordinate = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const objectOffset = z.number().int().min(0).max(4096).default(0).describe("Zero-based object-table offset.");
const objectLimit = z.number().int().min(1).max(200).default(100).describe("Maximum object descriptors returned in one response.");
const frameOffset = z.number().int().min(0).max(10_000).default(0).describe("Zero-based frame-table offset.");
const frameLimit = z.number().int().min(1).max(500).default(200).describe("Maximum frame descriptors returned in one response.");

const mutableFields = {
	name: playerName.optional(),
	enabled: z.boolean().optional(),
	playOnAwake: z.boolean().optional(),
	loop: z.boolean().optional(),
	speed: speed.optional(),
	interpolation: z.enum(["hold", "linear"]).optional().describe("Linear blends only stable topology; variable topology always uses exact discrete samples."),
	startTimeSeconds: time.nullable().optional().describe("Optional playback subrange start; null uses the cache start."),
	endTimeSeconds: time.nullable().optional().describe("Optional playback subrange end; null uses the cache end."),
	pointSize: positiveSize.optional(),
	curveWidth: positiveSize.optional(),
};

/** Registers the complete portable Alembic authoring, cache, scene-instantiation, and playback surface. */
export function registerAlembicTools(server: McpServer): void {
	server.registerTool(
		"get_alembic_capabilities",
		{
			title: "Get Alembic capabilities",
			description:
				"Read the exact portable `.abc` authoring boundary, Blender conversion prerequisite, sampled mesh/point/curve/camera and visibility support, stable/variable topology behavior, runtime dependency, memory/work ceilings, and shared Codex/Claude client scope without changing the project.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_alembic_capabilities", {})
	);

	server.registerTool(
		"inspect_alembic_import",
		{
			title: "Inspect Alembic import",
			description:
				"Hash one real project `.abc` source plus its strict importer settings and return the exact fingerprint, current/stale artifact state, Blender/cache evidence, bounded object/frame pages, time range, topology classification, bounds, and byte counts. This is read-only and must precede apply_alembic_import.",
			inputSchema: z.object({ path: projectPath, objectOffset, objectLimit, frameOffset, frameLimit }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_alembic_import", args)
	);

	server.registerTool(
		"apply_alembic_import",
		{
			title: "Apply Alembic import",
			description:
				"After confirm=true, use installed/configured Blender to convert the exact inspected `.abc` source/settings lease into an atomically published bounded ZVABC Web/Desktop cache. Missing Blender, changed bytes/settings, corrupt output, timeout, or limit failure publishes nothing and returns an actionable error.",
			inputSchema: z.object({ path: projectPath, expectedFingerprint: fingerprint, confirm: z.literal(true) }).strict(),
			annotations: artifactMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_alembic_import", args)
	);

	server.registerTool(
		"instantiate_alembic_asset",
		{
			title: "Instantiate Alembic asset",
			description:
				"Instantiate a current converted `.abc` artifact as one persistent editable scene root with sampled Babylon meshes, point clouds, curves, cameras, face-set material slots, visibility, and a two-frame playback owner. The source remains an asset; generated scene nodes are normally selectable and saveable.",
			inputSchema: z
				.object({
					path: projectPath,
					id: identifier.optional(),
					name: playerName.optional(),
					parentId: z.string().min(1).max(256).optional(),
					parentName: z.string().min(1).max(512).optional(),
					position: z.tuple([coordinate, coordinate, coordinate]).optional().describe("Root position in Babylon scene centimeters."),
					enabled: z.boolean().optional(),
					playOnAwake: z.boolean().optional(),
					loop: z.boolean().optional(),
					speed: speed.optional(),
					interpolation: z.enum(["hold", "linear"]).optional(),
					startTimeSeconds: time.nullable().optional(),
					endTimeSeconds: time.nullable().optional(),
					pointSize: positiveSize.optional(),
					curveWidth: positiveSize.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.parentId !== undefined && value.parentName !== undefined) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide parentId or parentName, not both." });
					}
					if (
						value.startTimeSeconds !== null &&
						value.startTimeSeconds !== undefined &&
						value.endTimeSeconds !== null &&
						value.endTimeSeconds !== undefined &&
						value.endTimeSeconds < value.startTimeSeconds
					) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["endTimeSeconds"], message: "endTimeSeconds must be greater than or equal to startTimeSeconds." });
					}
				}),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_alembic_asset", args)
	);

	server.registerTool(
		"list_alembic_players",
		{
			title: "List Alembic players",
			description:
				"List a bounded page of live Alembic roots with exact authored revision, source/cache hashes, bounds, playback range/clock/frame blend, two-frame residency, topology statistics, and last runtime error without returning each potentially large object table or changing playback. Use get_alembic_player to page one root's object descriptors.",
			inputSchema: z
				.object({
					offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).describe("Zero-based player offset."),
					limit: z.number().int().min(1).max(100).default(50).describe("Maximum player summaries returned."),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_alembic_players", args)
	);

	server.registerTool(
		"get_alembic_player",
		{
			title: "Get Alembic player",
			description:
				"Read one exact-id/name Alembic player, its persistent configuration revision, cache/source/settings evidence, a bounded page of object kinds/topology, current/next frame, interpolation amount, resident frames, and runtime failure state before updating or controlling it.",
			inputSchema: z
				.object({ id: identifier.optional(), name: playerName.optional(), objectOffset, objectLimit })
				.strict()
				.superRefine((value, context) => {
					if ((value.id === undefined) === (value.name === undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Alembic player id or name." });
					}
				}),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_alembic_player", args)
	);

	server.registerTool(
		"set_alembic_player",
		{
			title: "Set Alembic player",
			description:
				"Identify one player by exact id or currentName and, under its exact current revision, atomically patch its new name, enabled/play-on-awake/loop state, signed speed, stable-topology interpolation policy, playback subrange, point size, or curve width; persist the new revision and reapply the current sample.",
			inputSchema: z
				.object({ id: identifier.optional(), currentName: playerName.optional(), expectedRevision: revision, ...mutableFields })
				.strict()
				.superRefine((value, context) => {
					if ((value.id === undefined) === (value.currentName === undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one current Alembic player id or currentName." });
					}
					if (Object.keys(value).every((key) => key === "id" || key === "currentName" || key === "expectedRevision")) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one Alembic player field to update." });
					}
					if (
						value.startTimeSeconds !== null &&
						value.startTimeSeconds !== undefined &&
						value.endTimeSeconds !== null &&
						value.endTimeSeconds !== undefined &&
						value.endTimeSeconds < value.startTimeSeconds
					) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["endTimeSeconds"], message: "endTimeSeconds must be greater than or equal to startTimeSeconds." });
					}
				}),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_alembic_player", args)
	);

	server.registerTool(
		"control_alembic_player",
		{
			title: "Control Alembic player",
			description:
				"Play, pause, stop-and-rewind, or seek one exact-id/name live Alembic player. Seeking validates/decodes exact frame hashes, keeps at most two frames resident, linearly blends only stable topology, and leaves variable topology on discrete samples.",
			inputSchema: z
				.object({ id: identifier.optional(), name: playerName.optional(), action: z.enum(["play", "pause", "stop", "seek"]), timeSeconds: time.optional() })
				.strict()
				.superRefine((value, context) => {
					if ((value.id === undefined) === (value.name === undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Alembic player id or name." });
					}
					if ((value.action === "seek") !== (value.timeSeconds !== undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["timeSeconds"], message: "timeSeconds is required only when action=seek." });
					}
				}),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_alembic_player", args)
	);

	server.registerTool(
		"delete_alembic_player",
		{
			title: "Delete Alembic player",
			description:
				"After confirm=true, delete one exact-id/name Alembic root and only its generated scene meshes, curves, points, cameras, materials, observers, frame cache, and runtime registration. The source `.abc` and converted importer artifact remain unchanged.",
			inputSchema: z
				.object({ id: identifier.optional(), name: playerName.optional(), confirm: z.literal(true) })
				.strict()
				.superRefine((value, context) => {
					if ((value.id === undefined) === (value.name === undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Alembic player id or name." });
					}
				}),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_alembic_player", args)
	);
}

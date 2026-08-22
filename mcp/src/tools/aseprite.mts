import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const controlMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const artifactMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const asepritePath = z
	.string()
	.trim()
	.min(1)
	.max(4096)
	.refine((value) => value.startsWith("assets/") && !value.includes("\\") && !value.split("/").includes(".."), "Aseprite path must be a project-relative file inside assets/.")
	.refine((value) => /\.(?:ase|aseprite)$/i.test(value), "Aseprite path must end with .ase or .aseprite.")
	.describe("Project-relative `.ase` or `.aseprite` source inside `assets/`, for example `assets/sprites/hero.aseprite`.");
const identifier = z.string().trim().min(1).max(256).describe("Exact stable Aseprite root id returned by instantiate_aseprite_asset or list_aseprite_instances.");
const instanceName = z.string().trim().min(1).max(256).describe("Exact Aseprite root name.");
const animationName = z.string().trim().min(1).max(256).describe("Exact animation tag name returned by get_aseprite_instance.");
const fingerprint = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 import lease returned by inspect_aseprite_import.");
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("Exact instance revision returned by get_aseprite_instance or list_aseprite_instances.");
const speed = z.number().finite().gt(0).max(100).describe("Positive playback speed multiplier, at most 100.");
const coordinate = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const managerOffset = z.number().int().min(0).max(4096).default(0).describe("Zero-based SpriteManager stream offset.");
const managerLimit = z.number().int().min(1).max(200).default(100).describe("Maximum SpriteManager stream summaries returned.");

const exactInstance = {
	id: identifier.optional(),
	name: instanceName.optional(),
};

function requireExactInstance(value: { id?: string; name?: string }, context: z.RefinementCtx): void {
	if ((value.id === undefined) === (value.name === undefined)) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Aseprite instance id or name." });
	}
}

/** Registers the complete bounded Aseprite import, instantiation, inspection, playback, and deletion lifecycle. */
export function registerAsepriteTools(server: McpServer): void {
	server.registerTool(
		"get_aseprite_capabilities",
		{
			title: "Get Aseprite capabilities",
			description:
				"Read the native `.ase`/`.aseprite` importer models, indexed/grayscale/RGBA depths, image/group/tilemap layers, linked and compressed cels, all 19 blend modes, external tilesets, animation directions, slices, pivots, nine-patch metadata, and hard work limits without changing the project.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_aseprite_capabilities", {})
	);

	server.registerTool(
		"inspect_aseprite_import",
		{
			title: "Inspect Aseprite import",
			description:
				"Inspect one contained Aseprite source and its recursively resolved external tilesets. Returns the exact source/settings/dependency fingerprint, current-or-stale artifact state, document evidence, and independent bounded pages for dependencies, layers, tags, slices, tilesets, and atlas frames. This read must precede apply_aseprite_import.",
			inputSchema: z
				.object({
					path: asepritePath,
					dependencyOffset: z.number().int().min(0).max(4096).default(0),
					dependencyLimit: z.number().int().min(1).max(100).default(100),
					layerOffset: z.number().int().min(0).max(4096).default(0),
					layerLimit: z.number().int().min(1).max(200).default(100),
					tagOffset: z.number().int().min(0).max(4096).default(0),
					tagLimit: z.number().int().min(1).max(200).default(100),
					sliceOffset: z.number().int().min(0).max(4096).default(0),
					sliceLimit: z.number().int().min(1).max(200).default(100),
					tilesetOffset: z.number().int().min(0).max(4096).default(0),
					tilesetLimit: z.number().int().min(1).max(200).default(100),
					frameOffset: z.number().int().min(0).max(65_536).default(0),
					frameLimit: z.number().int().min(1).max(500).default(200),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_aseprite_import", args)
	);

	server.registerTool(
		"apply_aseprite_import",
		{
			title: "Apply Aseprite import",
			description:
				"After confirm=true, parse and composite the exact inspected Aseprite source/settings/dependency lease, then atomically publish its PNG atlas, atlas JSON, and import manifest. Changed sources, settings, dependencies, malformed chunks, unsafe external tilesets, excessive work, or publication failure leave no partial artifact.",
			inputSchema: z.object({ path: asepritePath, expectedFingerprint: fingerprint, confirm: z.literal(true) }).strict(),
			annotations: artifactMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_aseprite_import", args)
	);

	server.registerTool(
		"instantiate_aseprite_asset",
		{
			title: "Instantiate Aseprite asset",
			description:
				"Instantiate a current Aseprite artifact as either one composite SpriteManager or a persistent mirrored group/layer hierarchy. Generated sprites retain exact variable frame durations, tag direction/repeat, pivots, pixel aspect, hidden/empty-frame visibility, local transforms, and cel events and remain selectable, saveable, and editable.",
			inputSchema: z
				.object({
					path: asepritePath,
					id: identifier.optional(),
					name: instanceName.optional(),
					parentId: z.string().trim().min(1).max(256).optional(),
					parentName: z.string().trim().min(1).max(512).optional(),
					position: z.tuple([coordinate, coordinate, coordinate]).optional().describe("Root position in Babylon scene centimeters."),
					mode: z.enum(["composite", "layers"]).default("composite"),
					animationName: animationName.optional(),
					playOnAwake: z.boolean().optional(),
					speed: speed.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.parentId !== undefined && value.parentName !== undefined) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide parentId or parentName, not both." });
					}
				}),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_aseprite_asset", args)
	);

	server.registerTool(
		"list_aseprite_instances",
		{
			title: "List Aseprite instances",
			description:
				"List a bounded page of persistent Aseprite scene roots with source/import identity, exact revision, mode, transform, enabled state, and SpriteManager count without returning every animation stream or changing playback.",
			inputSchema: z
				.object({
					offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
					limit: z.number().int().min(1).max(100).default(50),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_aseprite_instances", args)
	);

	server.registerTool(
		"get_aseprite_instance",
		{
			title: "Get Aseprite instance",
			description:
				"Read one exact-id/name Aseprite root, source/import identity, exact revision, and a bounded page of layer SpriteManagers with animation names, frame counts, repeat/duration evidence, and live playback cursors before controlling or deleting it.",
			inputSchema: z
				.object({ ...exactInstance, managerOffset, managerLimit })
				.strict()
				.superRefine(requireExactInstance),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_aseprite_instance", args)
	);

	server.registerTool(
		"control_aseprite_animation",
		{
			title: "Control Aseprite animation",
			description:
				"Under one exact instance revision, atomically play/resume, pause, stop-and-rewind, or seek every composite/layer animation stream. Play can restart explicitly; seek requires one exact frame cursor and may retain a bounded elapsed offset and playing state. Any invalid layer or runtime failure restores every stream.",
			inputSchema: z
				.object({
					...exactInstance,
					expectedRevision: revision,
					action: z.enum(["play", "pause", "stop", "seek"]),
					animationName: animationName.optional(),
					speed: speed.optional(),
					restart: z.boolean().optional(),
					frameCursor: z.number().int().min(0).max(65_535).optional(),
					elapsedMs: z.number().finite().min(0).max(86_400_000).optional(),
					playing: z.boolean().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					requireExactInstance(value, context);
					if ((value.action === "seek") !== (value.frameCursor !== undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["frameCursor"], message: "frameCursor is required only when action=seek." });
					}
					if (value.action !== "seek" && (value.elapsedMs !== undefined || value.playing !== undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "elapsedMs and playing are valid only when action=seek." });
					}
					if (value.action !== "play" && value.restart !== undefined) {
						context.addIssue({ code: z.ZodIssueCode.custom, path: ["restart"], message: "restart is valid only when action=play." });
					}
					if (value.action === "pause" && (value.animationName !== undefined || value.speed !== undefined)) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "pause retains the current animation and speed; omit animationName and speed." });
					}
				}),
			annotations: controlMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_aseprite_animation", args)
	);

	server.registerTool(
		"delete_aseprite_instance",
		{
			title: "Delete Aseprite instance",
			description:
				"After confirm=true, delete one exact-id/name Aseprite root and only its generated group, SpriteManager, sprite, animation-controller, and event-observer hierarchy. The source `.ase`/`.aseprite` file and generated importer artifact remain unchanged.",
			inputSchema: z
				.object({ ...exactInstance, confirm: z.literal(true) })
				.strict()
				.superRefine(requireExactInstance),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_aseprite_instance", args)
	);
}

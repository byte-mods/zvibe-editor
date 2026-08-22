import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identifier = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const playerName = z.string().trim().min(1).max(128);
const sourceType = z.enum(["asset", "url"]);
const targetMode = z.enum(["material", "renderTexture", "cameraNearPlane", "cameraFarPlane", "apiOnly"]);
const textureSlot = z.enum(["diffuseTexture", "albedoTexture", "emissiveTexture", "opacityTexture"]);
const updateMode = z.enum(["audioTime", "gameTime", "unscaledGameTime"]);
const aspectRatio = z.enum(["noScaling", "fitVertically", "fitHorizontally", "fitInside", "fitOutside", "stretch"]);
const stereoLayout = z.enum(["none", "sideBySide", "overUnder"]);
const stereoEye = z.enum(["left", "right"]);
const colorSpace = z.enum(["auto", "srgb", "linear"]);
const audioOutputMode = z.enum(["direct", "none"]);

const playerReference = z
	.object({ id: identifier.optional(), name: playerName.optional() })
	.strict()
	.superRefine((value, context) => {
		if ((value.id === undefined) === (value.name === undefined)) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Video Player id or name." });
		}
	});

const playerFields = {
	sourceType: sourceType.optional().describe("Project asset (default) or an absolute HTTP/HTTPS URL."),
	path: z.string().trim().min(1).max(4096).describe("Normalized project-relative MP4/WebM/OGV/MOV path, or an HTTP/HTTPS URL when sourceType=url."),
	targetMode: targetMode.optional().describe("Material slot, named render-texture/API output, camera near/far plane, or API-only texture."),
	materialId: identifier.nullable().optional().describe("Required only for targetMode=material."),
	textureSlot: textureSlot.optional(),
	cameraId: identifier.nullable().optional().describe("Camera target; null uses the active camera."),
	playOnAwake: z.boolean().optional(),
	waitForFirstFrame: z.boolean().optional(),
	loop: z.boolean().optional(),
	skipOnDrop: z.boolean().optional(),
	playbackSpeed: z.number().finite().min(0.01).max(10).optional(),
	updateMode: updateMode.optional(),
	muted: z.boolean().optional().describe("Keep enabled for browser-safe autoplay unless user interaction starts playback."),
	volume: z.number().finite().min(0).max(1).optional(),
	audioOutputMode: audioOutputMode.optional(),
	startTime: z.number().finite().min(0).max(86_400).optional(),
	aspectRatio: aspectRatio.optional(),
	alpha: z.number().finite().min(0).max(1).optional(),
	stereoLayout: stereoLayout.optional(),
	stereoEye: stereoEye.optional(),
	colorSpace: colorSpace.optional(),
};

function validatePlayerTarget(value: Record<string, unknown>, context: z.RefinementCtx, creation: boolean): void {
	const mode = value.targetMode ?? (creation ? "material" : undefined);
	if (mode === "material" && (creation || value.targetMode === "material" || value.materialId !== undefined) && !value.materialId) {
		context.addIssue({ code: z.ZodIssueCode.custom, path: ["materialId"], message: "targetMode=material requires materialId." });
	}
	if ((mode === "cameraNearPlane" || mode === "cameraFarPlane") && value.materialId) {
		context.addIssue({ code: z.ZodIssueCode.custom, path: ["materialId"], message: "Camera targets do not use materialId." });
	}
}

const createPlayer = z
	.object({ name: playerName, ...playerFields })
	.strict()
	.superRefine((value, context) => validatePlayerTarget(value, context, true));
const setPlayer = z
	.object({ id: identifier.optional(), currentName: playerName.optional(), name: playerName.optional(), ...playerFields, path: playerFields.path.optional() })
	.strict()
	.superRefine((value, context) => {
		if ((value.id === undefined) === (value.currentName === undefined)) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Video Player id or name." });
		}
		if (Object.keys(value).every((key) => key === "id" || key === "currentName")) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one Video Player field to update." });
		}
		validatePlayerTarget(value, context, false);
	});
const controlPlayer = z
	.object({ id: identifier.optional(), name: playerName.optional(), action: z.enum(["play", "pause", "seek"]), time: z.number().finite().min(0).optional() })
	.strict()
	.superRefine((value, context) => {
		if ((value.id === undefined) === (value.name === undefined)) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Video Player id or name." });
		}
		if ((value.action === "seek") !== (value.time !== undefined)) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "time is required only when action=seek." });
		}
	});

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updateMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const controlMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Registers the complete persistent Video Player surface shared by Codex CLI and Claude CLI. */
export function registerVideoTools(server: McpServer): void {
	server.registerTool(
		"list_video_players",
		{
			title: "List Video Players",
			description: "List every normalized persistent Video Player plus live decode, clock, source, target, duration, readiness, and playback diagnostics.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_video_players", {})
	);
	server.registerTool(
		"create_video_player",
		{
			title: "Create Video Player",
			description:
				"Create and preview one persistent Unity-style Video Player from a project asset or HTTP(S) URL with material, named render-texture/API, camera-plane, or API-only output and complete clock/playback/audio/aspect/stereo/color settings.",
			inputSchema: createPlayer,
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_video_player", args)
	);
	server.registerTool(
		"set_video_player",
		{
			title: "Set Video Player",
			description: "Atomically update one exact-id/name Video Player and recreate its live preview target; failed source or target changes roll back to the prior player.",
			inputSchema: setPlayer,
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_video_player", args)
	);
	server.registerTool(
		"control_video_player",
		{
			title: "Control Video Player preview",
			description: "Play, pause, or seek one persistent Video Player in the running editor using its selected browser or deterministic scene clock.",
			inputSchema: controlPlayer,
			annotations: controlMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_video_player", args)
	);
	server.registerTool(
		"delete_video_player",
		{
			title: "Delete Video Player",
			description:
				"Delete one exact-id/name player and restore/dispose only its owned material, camera-layer, texture, listener, observer, and scene-map resources; the source asset remains.",
			inputSchema: playerReference,
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_video_player", args)
	);
}

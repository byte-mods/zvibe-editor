import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const playerReference = z.object({ id: z.string().optional(), name: z.string().optional() });
const playerFields = {
	path: z.string().describe("Project-relative or absolute .mp4, .webm, .ogv, or .mov video asset path."),
	materialId: z.string().describe("Material id that receives the video texture."),
	textureSlot: z.enum(["diffuseTexture", "albedoTexture", "emissiveTexture", "opacityTexture"]).optional(),
	autoPlay: z.boolean().optional(),
	loop: z.boolean().optional(),
	muted: z.boolean().optional().describe("Keep true for reliable browser autoplay."),
	volume: z.number().min(0).max(1).optional(),
	startTime: z.number().min(0).optional().describe("Initial playback position in seconds."),
};

/** Registers persistent VideoTexture player tools shared by Codex CLI and Claude CLI. */
export function registerVideoTools(server: McpServer): void {
	server.registerTool(
		"list_video_players",
		{
			title: "List video players",
			description: "List persistent material-targeted video players in the scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_video_players", {})
	);
	server.registerTool(
		"create_video_player",
		{
			title: "Create video player",
			description: "Create a persistent VideoTexture player from a project video asset and attach it to a material slot in exported games.",
			inputSchema: z.object({ name: z.string(), ...playerFields }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_video_player", args)
	);
	server.registerTool(
		"set_video_player",
		{
			title: "Set video player",
			description: "Update the persisted source, target material, texture slot, or playback defaults for a video player.",
			inputSchema: playerReference.extend({
				name: z.string().optional(),
				path: playerFields.path.optional(),
				materialId: playerFields.materialId.optional(),
				textureSlot: playerFields.textureSlot,
				autoPlay: playerFields.autoPlay,
				loop: playerFields.loop,
				muted: playerFields.muted,
				volume: playerFields.volume,
				startTime: playerFields.startTime,
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_video_player", args)
	);
	server.registerTool(
		"control_video_player",
		{
			title: "Control video preview",
			description: "Play, pause, or seek a persistent VideoTexture in the live editor preview. The project and source asset must be available to the editor.",
			inputSchema: playerReference.extend({
				action: z.enum(["play", "pause", "seek"]),
				time: z.number().min(0).optional().describe("Required for seek; seconds from the start of the video."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("control_video_player", args)
	);
	server.registerTool(
		"delete_video_player",
		{ title: "Delete video player", description: "Delete a player configuration without deleting its source asset or material.", inputSchema: playerReference },
		async (args): Promise<CallToolResult> => callTextTool("delete_video_player", args)
	);
}

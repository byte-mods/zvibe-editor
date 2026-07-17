import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

export function registerCinematicTools(server: McpServer): void {
	server.registerTool(
		"list_cinematics",
		{ title: "List cinematics", description: "List editable .cinematic assets in the project.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_cinematics", {})
	);
	server.registerTool(
		"get_cinematic",
		{
			title: "Get cinematic",
			description: "Read a cinematic's full serialized timeline: tracks, keys/cuts/tangents, sound cues, animation-group clips, events, and settings.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_cinematic", args)
	);
	server.registerTool(
		"create_cinematic",
		{
			title: "Create cinematic",
			description: "Create an editable .cinematic asset. Provide optional serialized tracks to author the entire timeline in one call.",
			inputSchema: z.object({
				path: z.string(),
				name: z.string().optional(),
				framesPerSecond: z.number().positive().optional(),
				outputFramesPerSecond: z.number().positive().optional(),
				tracks: z.array(z.record(z.string(), z.any())).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic", args)
	);
	server.registerTool(
		"save_cinematic",
		{
			title: "Save cinematic",
			description:
				"Validate against the current scene, serialize, and save a full editable cinematic timeline. The cinematic object accepts every native track/key/event field returned by get_cinematic.",
			inputSchema: z.object({ path: z.string(), cinematic: z.record(z.string(), z.any()), overwrite: z.literal(true).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_cinematic", args)
	);
	server.registerTool(
		"play_cinematic",
		{
			title: "Play cinematic",
			description: "Generate and preview a saved cinematic in the editor, including property tracks, events, animation clips, and optionally sound.",
			inputSchema: z.object({ path: z.string(), loop: z.boolean().optional(), speedRatio: z.number().positive().optional(), ignoreSounds: z.boolean().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("play_cinematic", args)
	);
}

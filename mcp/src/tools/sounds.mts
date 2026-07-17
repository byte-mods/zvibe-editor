import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerSoundTools(server: McpServer): void {
	const snapshot = z.object({ id: z.string().optional(), name: z.string().optional() });
	server.registerTool(
		"list_audio_mixer_snapshots",
		{ title: "List audio mixer snapshots", description: "List saved mixer-bus gain and mute snapshots.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_audio_mixer_snapshots", {})
	);
	server.registerTool(
		"create_audio_mixer_snapshot",
		{ title: "Create audio mixer snapshot", description: "Capture current audio-bus gains and mute states as a named snapshot.", inputSchema: z.object({ name: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("create_audio_mixer_snapshot", args)
	);
	server.registerTool(
		"apply_audio_mixer_snapshot",
		{ title: "Apply audio mixer snapshot", description: "Apply a saved snapshot to current audio buses.", inputSchema: snapshot },
		async (args): Promise<CallToolResult> => callTextTool("apply_audio_mixer_snapshot", args)
	);
	server.registerTool(
		"delete_audio_mixer_snapshot",
		{ title: "Delete audio mixer snapshot", description: "Delete a saved mixer snapshot.", inputSchema: snapshot },
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_mixer_snapshot", args)
	);
	server.registerTool(
		"list_audio_buses",
		{ title: "List audio buses", description: "List persisted mixer buses.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_audio_buses")
	);
	server.registerTool(
		"list_audio_runtime_diagnostics",
		{
			title: "List audio runtime diagnostics",
			description:
				"Inspect every SoundNode's loaded/playing state, spatial mode, base/effective volume, mixer-bus influence, and stale mixer assignments. This reads current preview/runtime state without changing playback.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_audio_runtime_diagnostics", {})
	);
	server.registerTool(
		"create_audio_bus",
		{
			title: "Create audio bus",
			description: "Create a mixer bus that applies gain to assigned SoundNodes.",
			inputSchema: z.object({
				name: z.string(),
				gain: z.number().nonnegative().optional(),
				muted: z.boolean().optional(),
				solo: z.boolean().optional(),
				soundNodeIds: z.array(z.string()).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_audio_bus", args)
	);
	server.registerTool(
		"set_audio_bus",
		{
			title: "Set audio bus",
			description: "Change mixer bus gain, mute/solo state, or assigned SoundNodes.",
			inputSchema: z.object({
				busId: z.string().optional(),
				busName: z.string().optional(),
				gain: z.number().nonnegative().optional(),
				muted: z.boolean().optional(),
				solo: z.boolean().optional(),
				soundNodeIds: z.array(z.string()).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_bus", args)
	);
	server.registerTool(
		"assign_sound_node_to_audio_bus",
		{
			title: "Assign sound to audio bus",
			description: "Exclusively assign one SoundNode to a mixer bus, or pass null to clear its assignment and restore its base volume.",
			inputSchema: z.object({ nodeId: z.string(), busId: z.string().nullable() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("assign_sound_node_to_audio_bus", args)
	);
	server.registerTool(
		"delete_audio_bus",
		{
			title: "Delete audio bus",
			description: "Delete a mixer bus without deleting sounds.",
			inputSchema: z.object({ busId: z.string().optional(), busName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_bus", args)
	);
	server.registerTool(
		"list_sound_assets",
		{
			title: "List sound assets",
			description:
				"List the `.mp3`/`.ogg`/`.wav` sound assets available in the project (equivalent to `list_assets type:sound`). " +
				"Use this to find ambience/music files before calling `create_sound`. If nothing suitable exists, download more via the marketplace tools.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_sound_assets", args)
	);

	server.registerTool(
		"create_sound",
		{
			title: "Create sound",
			description:
				"Create a `SoundNode` in the scene from a sound asset and load it (e.g. 'sounds of nature', 'people talking in the market place'). " +
				"`spatial: true` (default) creates a 3D positional sound emitted FROM the node's transform — parent it under a node and/or set `position` (centimeters) to place the source (a fountain, a market stall, a campfire, a cluster of fireflies). " +
				"`spatial: false` creates a global, non-positional 2D ambience/music bed that plays everywhere. " +
				"Tune falloff with `maxDistance`/`distanceModel` ('linear'|'inverse'|'exponential') and stereo rendering with `panningModel` ('HRTF'|'equalpower'). " +
				"After creation the node is selected and shown in the inspector.",
			inputSchema: z.object({
				path: z.string().describe("Project-relative or absolute path to the `.mp3`/`.ogg`/`.wav` sound asset."),
				name: z.string().optional().describe("Name for the created SoundNode."),
				parentId: z.string().optional().describe("Id of the parent node to attach the sound to."),
				parentName: z.string().optional().describe("Name of the parent node to attach the sound to."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters where the sound should be emitted."),
				volume: z.number().optional().describe("Playback volume in 0..1."),
				spatial: z.boolean().optional().describe("Whether the sound is 3D positional (default true). Set false for a global 2D ambience/music bed."),
				maxDistance: z.number().optional().describe("Distance (centimeters) at which the spatial sound becomes inaudible."),
				distanceModel: z.enum(["linear", "inverse", "exponential"]).optional().describe("Falloff curve for the spatial sound's volume over distance."),
				panningModel: z.enum(["HRTF", "equalpower"]).optional().describe("Stereo panning algorithm for the spatial sound."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sound", args)
	);

	server.registerTool(
		"get_sound",
		{
			title: "Get sound",
			description: "Read a SoundNode's asset, spatialization, attenuation, volume, and preview playback state.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_sound", args)
	);

	server.registerTool(
		"set_sound_playing",
		{
			title: "Play or stop sound",
			description: "Start or stop a SoundNode in the editor preview. startOffset is in seconds.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), playing: z.boolean(), startOffset: z.number().min(0).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sound_playing", args)
	);

	server.registerTool(
		"set_sound_properties",
		{
			title: "Set sound properties",
			description:
				"Update properties of an existing `SoundNode` (resolved by `nodeId`/`nodeName`). Only the provided fields are applied. " +
				"Use this to adjust volume, switch between spatial/global, or retune falloff/panning after `create_sound`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target SoundNode (preferred)."),
				nodeName: z.string().optional().describe("Name of the target SoundNode."),
				volume: z.number().optional().describe("Playback volume in 0..1."),
				spatial: z.boolean().optional().describe("Whether the sound is 3D positional."),
				maxDistance: z.number().optional().describe("Distance (centimeters) at which the spatial sound becomes inaudible."),
				distanceModel: z.enum(["linear", "inverse", "exponential"]).optional().describe("Falloff curve for the spatial sound's volume over distance."),
				panningModel: z.enum(["HRTF", "equalpower"]).optional().describe("Stereo panning algorithm for the spatial sound."),
				autoUpdateSpatial: z.boolean().optional().describe("Whether the spatial position auto-updates as the node's transform changes."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sound_properties", args)
	);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const transientMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const transientReset = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const profileId = z.string().min(1).max(128);
const buildRevision = z.number().int().min(0);
const runtimeRevision = z.number().int().min(1);

export function registerPlatformPlayerTools(server: McpServer): void {
	server.registerTool(
		"get_platform_player_capabilities",
		{
			title: "Get platform player capabilities",
			description:
				"Read the bounded Electron/Linux LTO and IBUS/FCITX5 IME contract, macOS display-link/frame-pacing contract, limits, and explicit native toolchain/adapter boundaries.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_platform_player_capabilities", {})
	);

	server.registerTool(
		"get_build_profile_platform_player_plan",
		{
			title: "Get Build Profile platform player plan",
			description:
				"Inspect one Electron profile's normalized Linux variant/LTO/IME or macOS display-link plan, exact Build Profiles revision, applied environment/flags, warnings, and honest execution scope without building.",
			inputSchema: z.object({ id: profileId }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_build_profile_platform_player_plan", args)
	);

	server.registerTool(
		"prepare_platform_player_runtime",
		{
			title: "Prepare platform player runtime",
			description:
				"Prepare bounded transient composition and frame-pacing evidence from one exact persisted Electron Build Profile. This changes no authored profile or build artifact.",
			inputSchema: z.object({ id: profileId, expectedBuildRevision: buildRevision }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("prepare_platform_player_runtime", args)
	);

	server.registerTool(
		"get_platform_player_runtime",
		{
			title: "Get platform player runtime",
			description:
				"Read the prepared profile identity, exact transient revision, bounded IME composition history, measured frame-pacing statistics, backend, warnings, and limits.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_platform_player_runtime", {})
	);

	server.registerTool(
		"simulate_platform_player_ime",
		{
			title: "Simulate platform player IME",
			description:
				"Under the exact transient revision, inject 1–32 explicitly labelled editor-simulation composition start/update/end records. This validates lifecycle handling but is not Linux daemon/hardware evidence.",
			inputSchema: z
				.object({
					expectedRuntimeRevision: runtimeRevision,
					events: z
						.array(z.object({ type: z.enum(["start", "update", "end"]), text: z.string().max(1_024) }).strict())
						.min(1)
						.max(32),
				})
				.strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_platform_player_ime", args)
	);

	server.registerTool(
		"sample_platform_player_frame_pacing",
		{
			title: "Sample platform player frame pacing",
			description:
				"Under the exact transient revision, capture 2–240 real requestAnimationFrame deltas in the current Electron renderer and publish min/max/mean/deviation/p95 plus the effective Chromium or native-adapter backend.",
			inputSchema: z.object({ expectedRuntimeRevision: runtimeRevision, sampleCount: z.number().int().min(2).max(240) }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("sample_platform_player_frame_pacing", args)
	);

	server.registerTool(
		"reset_platform_player_runtime",
		{
			title: "Reset platform player runtime",
			description: "Clear only bounded transient IME and frame-pacing evidence under the exact runtime revision; persisted Build Profile settings are unchanged.",
			inputSchema: z.object({ expectedRuntimeRevision: runtimeRevision, confirm: z.literal(true) }).strict(),
			annotations: transientReset,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_platform_player_runtime", args)
	);
}

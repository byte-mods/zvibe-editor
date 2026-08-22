import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().safe().min(1);
const provider = z.enum(["auto", "basic", "apple"]);
const platform = z.enum(["web", "electron", "android", "ios", "tvos", "visionos", "unknown"]);
const thermalState = z.enum(["unknown", "nominal", "fair", "serious", "critical"]);
const scalerId = z.enum(["render-scale", "lod-quality", "shadow-quality", "view-distance", "post-process", "particles"]);
const scalerChange = z
	.object({
		id: scalerId,
		enabled: z.boolean().optional(),
		minimumScale: z.number().finite().min(0).max(2).optional(),
		maximumScale: z.number().finite().min(0).max(2).optional(),
		maximumLevel: z.number().int().min(1).max(32).optional(),
		visualImpact: z.enum(["low", "medium", "high"]).optional(),
		target: z.enum(["cpu", "gpu", "fillrate", "all"]).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 1, "Provide at least one scaler field in addition to id.");
const configurationChanges = z
	.object({
		enabled: z.boolean().optional(),
		provider: provider.optional(),
		platform: platform.optional(),
		targetFrameRate: z.number().finite().min(15).max(240).optional(),
		sampleFrames: z.number().int().min(2).max(240).optional(),
		thermalActionDelaySeconds: z.number().finite().min(0).max(600).optional(),
		performanceActionDelaySeconds: z.number().finite().min(0).max(600).optional(),
		downscaleFrameTimeRatio: z.number().finite().min(1.01).max(3).optional(),
		upscaleFrameTimeRatio: z.number().finite().min(0.1).max(0.99).optional(),
		scalers: z.array(scalerChange).min(1).max(6).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Adaptive Performance setting.")
	.superRefine((value, context) => {
		const ids = value.scalers?.map((scaler) => scaler.id) ?? [];
		if (new Set(ids).size !== ids.length) {
			context.addIssue({ code: "custom", path: ["scalers"], message: "Scaler ids must be unique." });
		}
	});

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const authoredWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const transientWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const transientReset = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerAdaptivePerformanceTools(server: McpServer): void {
	server.registerTool(
		"get_adaptive_performance_capabilities",
		{
			title: "Get Adaptive Performance capabilities",
			description:
				"Discover the Basic provider, Apple iOS/tvOS/visionOS bridge contract, six concrete Babylon quality scalers, thermal states, bottleneck signals, editor simulation, and explicit hardware-evidence boundaries. Use this before authoring a policy; it does not inspect or change scene state.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_adaptive_performance_capabilities")
	);
	server.registerTool(
		"get_adaptive_performance_configuration",
		{
			title: "Get Adaptive Performance configuration",
			description:
				"Read the complete normalized version-1 provider, platform, target cadence, indexer delays/hysteresis, all six scaler settings, exact revision, and matching live runtime evidence. Preserve configuration.revision before calling a write or transient control tool.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_adaptive_performance_configuration")
	);
	server.registerTool(
		"set_adaptive_performance_configuration",
		{
			title: "Set Adaptive Performance configuration",
			description:
				"Atomically patch the Basic/Apple provider, target platform, bounded indexer timing, or one or more stable-id scalers under the exact current revision. The editor records Undo/Redo and restarts the shared preview/export runtime with exact baseline restoration. Apple on non-Apple targets and a missing native bridge remain visible warnings rather than fabricated support.",
			inputSchema: z.object({ expectedRevision: exactRevision, changes: configurationChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_adaptive_performance_configuration", args)
	);
	server.registerTool(
		"get_adaptive_performance_runtime",
		{
			title: "Get Adaptive Performance runtime",
			description:
				"Read bounded active-provider/fallback source, frame/optional CPU/GPU timing windows, bottleneck, thermal warning, low-power state, quality index, every scaler level/applied action, last decision, warnings, errors, and the most recent 64 provider/actions events.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_adaptive_performance_runtime")
	);
	server.registerTool(
		"simulate_adaptive_performance_state",
		{
			title: "Simulate Adaptive Performance state",
			description:
				"Under the exact authored revision, inject a clearly labeled non-hardware thermal state and/or 1–240 deterministic frame samples into the active editor runtime. Use thermal simulation to test Apple warning/scaler policy; use optional CPU/GPU times only with frameTimeMs to test bottleneck selection. This changes transient preview quality and evidence but never persisted authoring.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					thermalState: thermalState.optional(),
					temperatureLevel: z.number().finite().min(0).max(1).nullable().optional(),
					lowPowerMode: z.boolean().nullable().optional(),
					frameTimeMs: z.number().finite().min(1).max(1000).optional(),
					cpuFrameTimeMs: z.number().finite().min(0).max(1000).optional(),
					gpuFrameTimeMs: z.number().finite().min(0).max(1000).optional(),
					repeat: z.number().int().min(1).max(240).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.thermalState === undefined && value.frameTimeMs === undefined) {
						context.addIssue({ code: "custom", message: "Provide thermalState and/or frameTimeMs." });
					}
					if (value.thermalState === undefined && (value.temperatureLevel !== undefined || value.lowPowerMode !== undefined)) {
						context.addIssue({ code: "custom", path: ["thermalState"], message: "temperatureLevel and lowPowerMode require thermalState." });
					}
					if (value.frameTimeMs === undefined && (value.cpuFrameTimeMs !== undefined || value.gpuFrameTimeMs !== undefined || value.repeat !== undefined)) {
						context.addIssue({ code: "custom", path: ["frameTimeMs"], message: "CPU/GPU timings and repeat require frameTimeMs." });
					}
				}),
			annotations: transientWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_adaptive_performance_state", args)
	);
	server.registerTool(
		"reset_adaptive_performance_runtime",
		{
			title: "Reset Adaptive Performance runtime",
			description:
				"Under the exact authored revision, restore every scaler-owned render/LOD/shadow/view/post-process/particle baseline and clear transient timing, thermal, warning, quality-index, and bounded action evidence without changing persisted configuration.",
			inputSchema: z.object({ expectedRevision: exactRevision }).strict(),
			annotations: transientReset,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_adaptive_performance_runtime", args)
	);
}

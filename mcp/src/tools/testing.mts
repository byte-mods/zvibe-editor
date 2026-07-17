import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
const assertion = z.discriminatedUnion("type", [
	z.object({ type: z.literal("node-position"), nodeId: z.string(), equals: z.array(z.number()).length(3), epsilon: z.number().positive().optional() }),
	z.object({ type: z.literal("node-enabled"), nodeId: z.string(), equals: z.boolean() }),
]);
const performanceLimits = z.record(
	z.enum([
		"frameTimeMs",
		"drawCalls",
		"activeMeshes",
		"totalVertices",
		"meshes",
		"materials",
		"textures",
		"lights",
		"cameras",
		"particleSystems",
		"gpuFrameTimeMs",
		"gpuFrameTimeAverageMs",
	]),
	z.number().finite().nonnegative()
);
export function registerTestingTools(server: McpServer): void {
	server.registerTool(
		"compare_visual_regression_images",
		{
			title: "Compare visual regression images",
			description:
				"Compare baseline and candidate project images in RGBA space. Returns differing-pixel count and fails on dimension mismatch or pixels exceeding tolerance.",
			inputSchema: z.object({ baselinePath: z.string(), candidatePath: z.string(), tolerance: z.number().int().min(0).max(255).optional(), diffPath: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("compare_visual_regression_images", args)
	);
	server.registerTool(
		"list_performance_budgets",
		{
			title: "List performance budgets",
			description: "List persisted diagnostics threshold sets and their latest results.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_performance_budgets", {})
	);
	server.registerTool(
		"create_performance_budget",
		{
			title: "Create performance budget",
			description: "Create a persisted max-threshold set for renderer diagnostics such as drawCalls, frameTimeMs, totalVertices, textures, or particleSystems.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().min(1), limits: performanceLimits }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_performance_budget", args)
	);
	server.registerTool(
		"set_performance_budget",
		{
			title: "Set performance budget",
			description: "Rename or replace the max diagnostic thresholds in a persisted performance budget.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional(), limits: performanceLimits.optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_performance_budget", args)
	);
	server.registerTool(
		"run_performance_budgets",
		{
			title: "Run performance budgets",
			description:
				"Evaluate one named/id budget or all persisted performance budgets against current scene diagnostics. Unavailable backend metrics are reported as unavailable rather than fabricated.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_performance_budgets", args)
	);
	server.registerTool(
		"delete_performance_budget",
		{
			title: "Delete performance budget",
			description: "Delete a persisted diagnostics threshold set.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_performance_budget", args)
	);
	server.registerTool(
		"list_scene_tests",
		{ title: "List scene tests", description: "List persisted scene assertions and their last results.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_scene_tests", {})
	);
	server.registerTool(
		"create_scene_test",
		{
			title: "Create scene test",
			description: "Create a persisted play-mode-style scene test with node transform/enabled assertions.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string(), assertions: z.array(assertion) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_scene_test", args)
	);
	server.registerTool(
		"set_scene_test",
		{
			title: "Set scene test",
			description: "Update a persisted scene test name and/or its node position/enabled assertions.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional(), assertions: z.array(assertion).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_scene_test", args)
	);
	server.registerTool(
		"run_scene_tests",
		{
			title: "Run scene tests",
			description: "Run one named/id scene test or all persisted scene tests.",
			inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_scene_tests", args)
	);
	server.registerTool(
		"delete_scene_test",
		{ title: "Delete scene test", description: "Delete a persisted scene test.", inputSchema: z.object({ id: z.string().optional(), name: z.string().optional() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_scene_test", args)
	);
}

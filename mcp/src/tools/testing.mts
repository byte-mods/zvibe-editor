import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
const assertion = z.discriminatedUnion("type", [
	z.object({ type: z.literal("node-position"), nodeId: z.string(), equals: z.array(z.number()).length(3), epsilon: z.number().positive().optional() }),
	z.object({ type: z.literal("node-enabled"), nodeId: z.string(), equals: z.boolean() }),
]);
const performanceLimits = z.partialRecord(
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
const identifier = z.string().min(1).max(160);
const categories = z.array(z.string().min(1).max(64)).max(32);
const vector3 = z.array(z.number().finite()).length(3);
const portableStep = z.discriminatedUnion("type", [
	z.object({ type: z.literal("wait-frames"), frames: z.number().int().min(1).max(600) }),
	z.object({ type: z.literal("wait-ms"), milliseconds: z.number().int().min(0).max(10_000) }),
	z.object({ type: z.literal("set-node-enabled"), nodeId: identifier, enabled: z.boolean() }),
	z.object({ type: z.literal("set-node-position"), nodeId: identifier, value: vector3 }),
	z.object({ type: z.literal("set-node-rotation"), nodeId: identifier, value: vector3 }),
	z.object({ type: z.literal("set-node-scaling"), nodeId: identifier, value: vector3 }),
	z.object({
		type: z.literal("dispatch-pointer"),
		phase: z.enum(["down", "move", "up"]),
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		button: z.number().int().min(0).max(4).optional(),
	}),
]);
const portableAssertion = z.discriminatedUnion("type", [
	z.object({ type: z.literal("node-exists"), nodeId: identifier, exists: z.boolean() }),
	z.object({ type: z.literal("node-enabled"), nodeId: identifier, equals: z.boolean() }),
	z.object({ type: z.literal("node-position"), nodeId: identifier, equals: vector3, epsilon: z.number().positive().optional() }),
	z.object({ type: z.literal("node-rotation"), nodeId: identifier, equals: vector3, epsilon: z.number().positive().optional() }),
	z.object({ type: z.literal("node-scaling"), nodeId: identifier, equals: vector3, epsilon: z.number().positive().optional() }),
	z.object({
		type: z.literal("node-property"),
		nodeId: identifier,
		path: z.string().min(1).max(256),
		operator: z.enum(["equals", "not-equals", "greater-than", "greater-than-or-equal", "less-than", "less-than-or-equal", "contains"]),
		expected: z.unknown(),
		epsilon: z.number().positive().optional(),
	}),
	z.object({
		type: z.literal("scene-count"),
		collection: z.enum(["nodes", "meshes", "materials", "textures", "lights", "cameras", "particleSystems", "animationGroups"]),
		operator: z.enum(["equals", "greater-than-or-equal", "less-than-or-equal"]),
		expected: z.number().int().min(0).max(1_000_000),
	}),
]);
const performanceMetric = z.enum([
	"frameRate",
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
]);
const performanceConfiguration = z.object({
	warmupFrames: z.number().int().min(0).max(600),
	measurementFrames: z.number().int().min(1).max(600),
	thresholds: z
		.array(
			z.object({
				metric: performanceMetric,
				statistic: z.enum(["minimum", "maximum", "mean", "median", "p95"]),
				operator: z.enum(["less-than-or-equal", "greater-than-or-equal"]),
				value: z.number().finite(),
				allowUnavailable: z.boolean().optional(),
			})
		)
		.min(1)
		.max(32),
});
const visualConfiguration = z.object({
	baselinePath: z.string().min(1).max(512),
	tolerance: z.number().int().min(0).max(255),
	maximumDifferingPixels: z.number().int().min(0).max(100_000_000),
	diffPath: z.string().min(1).max(512).optional(),
});
const commonTestFields = {
	id: identifier.optional(),
	name: identifier,
	enabled: z.boolean().optional(),
	categories: categories.optional(),
	timeoutMs: z.number().int().min(100).max(600_000).optional(),
	repeat: z.number().int().min(1).max(100).optional(),
	setup: z.array(portableStep).max(128).optional(),
	steps: z.array(portableStep).max(128).optional(),
	teardown: z.array(portableStep).max(128).optional(),
	assertions: z.array(portableAssertion).max(128).optional(),
};
const portableTestCase = z.discriminatedUnion("kind", [
	z.object({ ...commonTestFields, kind: z.literal("scene"), assertions: z.array(portableAssertion).min(1).max(128) }),
	z.object({ ...commonTestFields, kind: z.literal("performance"), performance: performanceConfiguration }),
	z.object({ ...commonTestFields, kind: z.literal("visual"), visual: visualConfiguration }),
]);
const portableTestPatch = z.object({
	name: identifier.optional(),
	enabled: z.boolean().optional(),
	kind: z.enum(["scene", "performance", "visual"]).optional(),
	categories: categories.optional(),
	timeoutMs: z.number().int().min(100).max(600_000).optional(),
	repeat: z.number().int().min(1).max(100).optional(),
	setup: z.array(portableStep).max(128).optional(),
	steps: z.array(portableStep).max(128).optional(),
	teardown: z.array(portableStep).max(128).optional(),
	assertions: z.array(portableAssertion).max(128).optional(),
	performance: performanceConfiguration.optional(),
	visual: visualConfiguration.optional(),
});
const suiteSelector = { suiteId: identifier.optional(), suiteName: identifier.optional() };
const testSelector = { ...suiteSelector, testId: identifier.optional(), testName: identifier.optional() };
const runFilter = {
	suiteIds: z.array(identifier).max(128).optional(),
	testIds: z.array(identifier).max(1024).optional(),
	modes: z
		.array(z.enum(["edit", "play"]))
		.max(2)
		.optional(),
	categories: categories.optional(),
	search: z.string().max(256).optional(),
	failedOnly: z.boolean().optional(),
	failFast: z.boolean().optional(),
	repeatOverride: z.number().int().min(1).max(100).optional(),
};
export function registerTestingTools(server: McpServer): void {
	server.registerTool(
		"compare_visual_regression_images",
		{
			title: "Compare visual regression images",
			description:
				"Compare baseline and candidate project images in RGBA space. Returns differing-pixel count and fails on dimension mismatch or pixels exceeding tolerance.",
			inputSchema: z.object({ baselinePath: z.string(), candidatePath: z.string(), tolerance: z.number().int().min(0).max(255).optional(), diffPath: z.string().optional() }),
			annotations: { idempotentHint: true },
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
	server.registerTool(
		"get_testing_capabilities",
		{
			title: "Get testing capabilities",
			description: "Read the exact portable Test Runner modes, case kinds, actions, assertions, metrics, report formats, limits, and explicit non-capabilities.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_testing_capabilities", {})
	);
	server.registerTool(
		"get_testing_state",
		{
			title: "Get testing state",
			description: "Read the complete version-2 exact-revision suite/case model and bounded retained run history.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_testing_state", {})
	);
	server.registerTool(
		"set_testing_settings",
		{
			title: "Set testing settings",
			description: "Update default case timeout, Play preparation timeout, and retained-run limit under the exact current revision.",
			inputSchema: z.object({
				expectedRevision: z.number().int().min(0),
				settings: z.object({
					defaultTimeoutMs: z.number().int().min(100).max(600_000).optional(),
					playPreparationTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
					maximumRetainedRuns: z.number().int().min(1).max(20).optional(),
				}),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_testing_settings", args)
	);
	server.registerTool(
		"create_test_suite",
		{
			title: "Create test suite",
			description: "Create one exact-revision Edit or Play suite with categories, optional timeout/hooks, and optional bounded cases.",
			inputSchema: z.object({
				expectedRevision: z.number().int().min(0),
				id: identifier.optional(),
				name: identifier,
				enabled: z.boolean().optional(),
				mode: z.enum(["edit", "play"]),
				categories: categories.optional(),
				timeoutMs: z.number().int().min(100).max(600_000).optional(),
				beforeEach: z.array(portableStep).max(128).optional(),
				afterEach: z.array(portableStep).max(128).optional(),
				tests: z.array(portableTestCase).max(1024).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_test_suite", args)
	);
	server.registerTool(
		"set_test_suite",
		{
			title: "Set test suite",
			description: "Patch one suite's authoring fields under the exact current testing revision.",
			inputSchema: z.object({
				expectedRevision: z.number().int().min(0),
				...suiteSelector,
				name: identifier.optional(),
				enabled: z.boolean().optional(),
				mode: z.enum(["edit", "play"]).optional(),
				categories: categories.optional(),
				timeoutMs: z.number().int().min(100).max(600_000).optional(),
				beforeEach: z.array(portableStep).max(128).optional(),
				afterEach: z.array(portableStep).max(128).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_test_suite", args)
	);
	server.registerTool(
		"delete_test_suite",
		{
			title: "Delete test suite",
			description: "Delete one suite and its cases under the exact revision. Explicit confirmation is required.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), ...suiteSelector, confirm: z.literal(true) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_test_suite", args)
	);
	server.registerTool(
		"create_test_case",
		{
			title: "Create test case",
			description: "Create a bounded scene, sampled-performance, or visual-regression case inside one exact suite.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), ...suiteSelector, test: portableTestCase }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_test_case", args)
	);
	server.registerTool(
		"set_test_case",
		{
			title: "Set test case",
			description: "Patch one case's validated authoring fields under the exact current testing revision.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), ...testSelector, patch: portableTestPatch }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_test_case", args)
	);
	server.registerTool(
		"delete_test_case",
		{
			title: "Delete test case",
			description: "Delete one case under the exact revision. Explicit confirmation is required.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), ...testSelector, confirm: z.literal(true) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_test_case", args)
	);
	server.registerTool(
		"run_testing",
		{
			title: "Run testing",
			description:
				"Run selected Edit and/or Play suites under the exact authoring revision. Play cases use the real exported/compiled editor Play scene; runs are bounded, cancellable, isolated for authored mutations, and retained with assertion/performance/visual evidence.",
			inputSchema: z.object({
				expectedRevision: z.number().int().min(0),
				target: z.enum(["local", "connected-player"]).optional(),
				connectionId: identifier.optional(),
				timeoutMs: z.number().int().min(250).max(600_000).optional(),
				confirm: z.literal(true).optional(),
				...runFilter,
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_testing", args)
	);
	server.registerTool(
		"get_testing_run_status",
		{
			title: "Get testing run status",
			description: "Read active progress and the latest retained Test Runner report.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_testing_run_status", {})
	);
	server.registerTool(
		"cancel_testing_run",
		{
			title: "Cancel testing run",
			description: "Cancel the active bounded Test Runner operation and trigger cleanup. Explicit confirmation is required.",
			inputSchema: z.object({ runId: identifier.optional(), confirm: z.literal(true) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_testing_run", args)
	);
	server.registerTool(
		"list_testing_runs",
		{
			title: "List testing runs",
			description: "List bounded newest-first retained Test Runner reports with pagination.",
			inputSchema: z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_testing_runs", args)
	);
	server.registerTool(
		"get_testing_run",
		{
			title: "Get testing run",
			description: "Read one retained Test Runner report including per-repeat assertions, samples, thresholds, visual artifacts, errors, and limitations.",
			inputSchema: z.object({ runId: identifier }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_testing_run", args)
	);
	server.registerTool(
		"export_testing_run_report",
		{
			title: "Export testing run report",
			description: "Export one retained run as bounded project JSON or a JUnit/NUnit-compatible XML subset.",
			inputSchema: z.object({ runId: identifier, format: z.enum(["json", "junit"]).optional(), path: z.string().min(1).max(512).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("export_testing_run_report", args)
	);
	server.registerTool(
		"clear_testing_runs",
		{
			title: "Clear testing runs",
			description: "Clear selected retained run ids or the complete bounded report history under the exact authoring revision. Explicit confirmation is required.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), runIds: z.array(identifier).min(1).max(20).optional(), confirm: z.literal(true) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_testing_runs", args)
	);
	server.registerTool(
		"get_project_code_tests",
		{
			title: "Get project code tests",
			description: "Discover bounded project test/spec files, package scripts, detected framework, configuration, active process, and retained native-run output.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_code_tests", {})
	);
	server.registerTool(
		"set_project_code_tests",
		{
			title: "Set project code tests",
			description: "Select existing project-owned package scripts and bounded timeout/output caps under the exact code-test revision.",
			inputSchema: z.object({
				expectedRevision: z.number().int().min(0),
				packageScript: identifier.optional(),
				coverageScript: identifier.nullable().optional(),
				timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
				maximumOutputBytes: z.number().int().min(16_384).max(4_194_304).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_code_tests", args)
	);
	server.registerTool(
		"run_project_code_tests",
		{
			title: "Run project code tests",
			description:
				"Execute the configured project-owned test or coverage package script without a shell, with bounded output/timeout and retained exit evidence. Explicit confirmation is required.",
			inputSchema: z.object({ expectedRevision: z.number().int().min(0), coverage: z.boolean().optional(), ci: z.boolean().optional(), confirm: z.literal(true) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("run_project_code_tests", args)
	);
	server.registerTool(
		"cancel_project_code_tests",
		{
			title: "Cancel project code tests",
			description: "Terminate the active project-owned code-test process. Explicit confirmation is required.",
			inputSchema: z.object({ runId: identifier.optional(), confirm: z.literal(true) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_project_code_tests", args)
	);
}

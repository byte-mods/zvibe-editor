import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const category = z.enum(["auth", "cloudSave", "analytics", "iap", "ads", "matchmaking", "leaderboards", "remoteConfig", "contentDelivery", "cloudFunctions"]);
const environmentId = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,63}$/)
	.describe("Stable lowercase environment slug returned by get_project_services_configuration.");
const expectedRevision = z.number().int().nonnegative().safe().describe("Exact current project-services revision; stale values are rejected.");
const scalar = z.union([z.string().max(512), z.number().finite(), z.boolean()]);
const options = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/), scalar).superRefine((value, context) => {
	if (Object.keys(value).length > 64) {
		context.addIssue({ code: "custom", message: "Service options support at most 64 entries." });
	}
	for (const key of Object.keys(value)) {
		if (/(?:secret|password|private[_.-]?key|access[_.-]?token|refresh[_.-]?token)/i.test(key)) {
			context.addIssue({ code: "custom", message: `Service option ${key} looks secret; provide credentials only through named environment variables.` });
		}
	}
});
const serviceSettings = z
	.object({
		enabled: z.boolean(),
		provider: z.string().max(128),
		endpoint: z.string().max(512),
		options,
	})
	.strict();
const analyticsParameter = z
	.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), type: z.enum(["string", "integer", "number", "boolean", "timestamp"]), required: z.boolean() })
	.strict();
const analyticsEvent = z
	.object({
		name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
		description: z.string().max(512),
		enabled: z.boolean(),
		parameters: z.array(analyticsParameter).max(64),
	})
	.strict();
const payout = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), quantity: z.number().int().min(1).max(1_000_000_000) }).strict();
const iapProduct = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
		type: z.enum(["consumable", "non-consumable", "subscription"]),
		title: z.string().min(1).max(128),
		description: z.string().max(1024),
		currency: z.string().regex(/^[A-Z]{3}$/),
		priceMicros: z.number().int().nonnegative().safe(),
		payouts: z.array(payout).max(8),
	})
	.strict();
const adPlacement = z
	.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), type: z.enum(["rewarded", "interstitial", "banner"]), reward: payout.nullable() })
	.strict()
	.refine((value) => value.type !== "rewarded" || value.reward !== null, { message: "Rewarded placements require a reward." });
const matchmakingQueue = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
		minPlayers: z.number().int().min(1).max(100),
		maxPlayers: z.number().int().min(1).max(100),
		ticketTimeoutSeconds: z.number().int().min(5).max(3600),
		skillTolerance: z.number().int().min(0).max(1_000_000).nullable(),
		relaxationSeconds: z.number().int().min(0).max(3600).nullable(),
	})
	.strict()
	.refine((value) => value.maxPlayers >= value.minPlayers, { message: "maxPlayers must be at least minPlayers." });
const jsonValue: z.ZodTypeAny = z.lazy(() =>
	z.union([
		z.string().max(16_384),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValue).max(256),
		z.record(z.string().min(1).max(128), jsonValue).superRefine((value, context) => {
			if (Object.keys(value).length > 256) {
				context.addIssue({ code: "custom", message: "JSON objects support at most 256 keys." });
			}
		}),
	])
);
const leaderboard = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
		name: z.string().min(1).max(128),
		sortOrder: z.enum(["descending", "ascending"]),
		keepBest: z.boolean(),
		maxEntries: z.number().int().min(1).max(100_000),
	})
	.strict();
const remoteConfigEntry = z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), value: jsonValue }).strict();
const contentDeliveryEntry = z
	.object({
		key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
		url: z.string().url().max(2048),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		bytes: z
			.number()
			.int()
			.nonnegative()
			.max(2 * 1024 * 1024 * 1024),
		contentType: z.string().min(1).max(128),
	})
	.strict();
const contentDeliveryRelease = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), entries: z.array(contentDeliveryEntry).max(1_000) }).strict();
const contentDeliveryBucket = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
		badges: z
			.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) }).strict())
			.max(100),
		releases: z.array(contentDeliveryRelease).max(100),
	})
	.strict();
const cloudFunction = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
		entryPoint: z
			.string()
			.min(1)
			.max(1024)
			.regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s)$/),
		timeoutMs: z.number().int().min(100).max(120_000),
		authenticated: z.boolean(),
		emulatorResponse: jsonValue,
	})
	.strict();
const resources = z
	.object({
		analyticsEvents: z.array(analyticsEvent).max(100),
		iapProducts: z.array(iapProduct).max(500),
		adPlacements: z.array(adPlacement).max(100),
		matchmakingQueues: z.array(matchmakingQueue).max(50),
		leaderboards: z.array(leaderboard).max(100).optional(),
		remoteConfig: z.array(remoteConfigEntry).max(1_000).optional(),
		contentDeliveryBuckets: z.array(contentDeliveryBucket).max(64).optional(),
		cloudFunctions: z.array(cloudFunction).max(256).optional(),
	})
	.strict();
const deployment = z
	.object({
		script: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
		credentialEnvironmentVariables: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/)).max(32),
	})
	.strict();

export function registerServiceTools(server: McpServer): void {
	server.registerTool(
		"get_project_services_capabilities",
		{
			title: "Get project services capabilities",
			description:
				"Read the exact provider-neutral service categories, resources, environment/deployment/emulator guarantees, secret boundary, and services that are deliberately not core adapters.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_services_capabilities", {})
	);
	server.registerTool(
		"get_project_services_configuration",
		{
			title: "Get project services configuration",
			description:
				"Read the exact revision, active environment, all provider-neutral service settings, resource catalogs, and deployment configuration without changing the scene.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_services_configuration", {})
	);
	server.registerTool(
		"set_project_service_environment",
		{
			title: "Create or update service environment",
			description:
				"Create or update one development, staging, or production service environment at an exact revision. Deployment, when provided, replaces its fixed package script and credential environment-variable names; credential values are never accepted.",
			inputSchema: z
				.object({
					expectedRevision,
					id: environmentId,
					name: z.string().min(1).max(128).optional(),
					kind: z.enum(["development", "staging", "production"]).optional(),
					deployment: deployment.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_service_environment", args)
	);
	server.registerTool(
		"set_active_project_service_environment",
		{
			title: "Set active service environment",
			description: "Select the environment mirrored into exported runtime scene metadata. Requires the exact current revision and changes no remote provider state.",
			inputSchema: z.object({ expectedRevision, id: environmentId }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_active_project_service_environment", args)
	);
	server.registerTool(
		"delete_project_service_environment",
		{
			title: "Delete service environment",
			description: "Delete one non-active, non-last service environment at an exact revision after explicit confirmation. Does not delete remote provider resources.",
			inputSchema: z.object({ expectedRevision, id: environmentId, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_service_environment", args)
	);
	server.registerTool(
		"set_project_service_category",
		{
			title: "Set project service category",
			description:
				"Replace one environment's auth, Cloud Save, analytics, IAP, ads, matchmaking, Leaderboards, Remote Config, Cloud Content Delivery, or Cloud Functions routing at an exact revision. Endpoints must be HTTPS or loopback HTTP at readiness/runtime; options accept only bounded non-secret scalars.",
			inputSchema: z.object({ expectedRevision, environmentId, category, settings: serviceSettings }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_service_category", args)
	);
	server.registerTool(
		"set_project_service_resources",
		{
			title: "Set project service resources",
			description:
				"Replace validated analytics schemas, IAP products, ads, matchmaking queues, leaderboards, Remote Config values, content buckets/releases/badges, and Cloud Function definitions for one environment at an exact revision.",
			inputSchema: z.object({ expectedRevision, environmentId, resources }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_service_resources", args)
	);
	server.registerTool(
		"validate_project_services_readiness",
		{
			title: "Validate project services readiness",
			description:
				"Audit runtime endpoints/provider boundaries, enabled categories, fixed deployment script presence, and credential environment-variable availability. Returns names/availability only, never credential values.",
			inputSchema: z.object({ environmentId: environmentId.optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_project_services_readiness", args)
	);
	server.registerTool(
		"plan_project_services_deployment",
		{
			title: "Plan project services deployment",
			description:
				"Create a ten-minute no-write deployment plan from the exact service revision and package fingerprint. Defaults to dry-run, reports the shell-free command/readiness/resources, and never returns credential values.",
			inputSchema: z
				.object({
					expectedRevision,
					environmentId: environmentId.optional(),
					dryRun: z.boolean().optional(),
					reconcile: z.boolean().optional(),
					timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_project_services_deployment", args)
	);
	server.registerTool(
		"deploy_project_services",
		{
			title: "Deploy project services",
			description:
				"Apply one exact unexpired valid plan after confirmation: atomically write the provider-neutral artifact, execute only the environment's fixed package script without a shell, and retain a bounded report. The project script may contact external providers.",
			inputSchema: z.object({ planId: z.string().uuid(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("deploy_project_services", args)
	);
	server.registerTool(
		"cancel_project_services_deployment",
		{
			title: "Cancel project services deployment",
			description: "Cancel the active bounded services deployment child process, optionally requiring its exact operation id; returns a no-op reason when none is running.",
			inputSchema: z.object({ operationId: z.string().uuid().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_project_services_deployment", args)
	);
	server.registerTool(
		"list_project_services_deployment_reports",
		{
			title: "List services deployment reports",
			description: "List up to 20 retained bounded service deployment reports, newest first, without changing project or provider state.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_project_services_deployment_reports", {})
	);
	server.registerTool(
		"get_project_services_deployment_report",
		{
			title: "Get services deployment report",
			description: "Read one retained services deployment report by exact id, including bounded redacted stdout/stderr and artifact path.",
			inputSchema: z.object({ reportId: z.string().uuid() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_services_deployment_report", args)
	);
	server.registerTool(
		"delete_project_services_deployment_report",
		{
			title: "Delete services deployment report",
			description: "Delete one local retained deployment report after explicit confirmation; does not affect its artifact or remote provider resources.",
			inputSchema: z.object({ reportId: z.string().uuid(), confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_project_services_deployment_report", args)
	);
	server.registerTool(
		"start_project_services_emulator",
		{
			title: "Start project services emulator",
			description:
				"Start one persistent HTTP development backend bound only to 127.0.0.1 for all ten portable service routes. Requires the exact configuration revision; port 0 selects a free local port. Writes only bounded local emulator state.",
			inputSchema: z
				.object({
					expectedRevision,
					environmentId: environmentId.optional(),
					port: z
						.number()
						.int()
						.min(0)
						.max(65535)
						.refine((value) => value === 0 || value >= 1024, { message: "port must be 0 or 1024–65535." })
						.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_project_services_emulator", args)
	);
	server.registerTool(
		"stop_project_services_emulator",
		{
			title: "Stop project services emulator",
			description: "Stop the active loopback emulator after draining accepted mutations. Persistent local test data remains available for restart.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("stop_project_services_emulator", {})
	);
	server.registerTool(
		"get_project_services_emulator_status",
		{
			title: "Get project services emulator status",
			description: "Read loopback endpoint, environment, persistence path, uptime, and bounded local data counts without exposing sessions or credentials.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_services_emulator_status", {})
	);
	server.registerTool(
		"get_project_services_emulator_events",
		{
			title: "Get project services emulator events",
			description:
				"Read a bounded sequence page of sanitized local service actions, optionally filtered by category, action, or player id. Tokens and credentials are never recorded.",
			inputSchema: z
				.object({
					afterSequence: z.number().int().nonnegative().safe().optional(),
					limit: z.number().int().min(1).max(200).optional(),
					category: category.optional(),
					action: z.string().min(1).max(128).optional(),
					playerId: z.string().uuid().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_services_emulator_events", args)
	);
	server.registerTool(
		"reset_project_services_emulator",
		{
			title: "Reset project services emulator",
			description:
				"Permanently clear all persistent local players, saves, events, purchases, ad impressions, tickets, and sessions for the running emulator after explicit confirmation.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_project_services_emulator", args)
	);
}

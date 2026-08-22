import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;
const transientMutation = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false } as const;
const assetMutation = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false } as const;
const category = z.enum(["serialization", "obsolete-api", "particle-texture-readability", "atlas-waste"]);
const severity = z.enum(["error", "warning", "info"]);
const revision = z.number().int().min(1);
const jobId = z.string().uuid();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const settings = z
	.object({
		categories: z
			.array(category)
			.min(1)
			.max(4)
			.refine((value) => new Set(value).size === value.length, "categories must be unique.")
			.optional(),
		obsoleteTargetVersion: z
			.string()
			.regex(/^\d+\.\d+\.\d+$/)
			.optional()
			.describe("Portable editor/API version to include when detecting future-obsolete TypeScript declarations."),
		maximumIssues: z.number().int().min(1).max(10_000).optional(),
		atlasAllocationWasteThresholdPercent: z.number().finite().min(1).max(100).optional(),
		atlasUnusedRegionThresholdPercent: z.number().finite().min(1).max(100).optional(),
	})
	.strict();

export function registerProjectAuditorTools(server: McpServer): void {
	server.registerTool(
		"get_project_auditor_capabilities",
		{
			title: "Get Project Auditor capabilities",
			description:
				"Read the portable asynchronous Project Auditor contract, analyzer categories, safe-fix scope, hard scan limits, and explicit Unity/Roslyn non-identity boundaries.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_auditor_capabilities", {})
	);

	server.registerTool(
		"get_project_auditor_state",
		{
			title: "Get Project Auditor state",
			description: "Read the exact global revision, current non-blocking audit job, and up to 20 bounded recent jobs without starting analysis.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_auditor_state", {})
	);

	server.registerTool(
		"start_project_audit",
		{
			title: "Start project audit",
			description:
				"Start one cooperative background audit under the exact global revision. It checks compile-time Inspector serialization, resolved deprecated/future-obsolete TypeScript APIs, GPU-only particle textures with unnecessary CPU Readable output, and project/live sprite-atlas waste.",
			inputSchema: z
				.object({
					expectedRevision: revision.describe("Exact revision returned by get_project_auditor_state."),
					settings: settings.optional(),
				})
				.strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_project_audit", args)
	);

	server.registerTool(
		"get_project_audit",
		{
			title: "Get project audit",
			description: "Read one retained asynchronous audit's status, progress, settings, summary, result fingerprint, and exact job revision.",
			inputSchema: z.object({ id: jobId }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_project_audit", args)
	);

	server.registerTool(
		"list_project_audit_issues",
		{
			title: "List project audit issues",
			description:
				"Read one stable filtered issue page under the exact job revision. Each issue includes deterministic identity, severity, source/node location, bounded evidence, recommendation, safe-fix availability, and resolution state.",
			inputSchema: z
				.object({
					id: jobId,
					expectedJobRevision: revision.describe("Exact revision returned by get_project_audit."),
					category: category.optional(),
					severity: severity.optional(),
					search: z.string().trim().min(1).max(256).optional(),
					includeResolved: z.boolean().optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_audit_issues", args)
	);

	server.registerTool(
		"cancel_project_audit",
		{
			title: "Cancel project audit",
			description:
				"Request cooperative cancellation of the queued/running audit under the exact global revision; analysis never publishes partial fixes or changes project files.",
			inputSchema: z.object({ id: jobId, expectedRevision: revision.describe("Exact revision returned by get_project_auditor_state.") }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_project_audit", args)
	);

	server.registerTool(
		"apply_project_auditor_fix",
		{
			title: "Apply Project Auditor fix",
			description:
				"After confirm=true, apply one supported issue fix under exact global, job, and issue leases. Version 1 only disables unnecessary CPU Readable texture-importer output for GPU-only Babylon particle properties; source texture bytes are never changed.",
			inputSchema: z
				.object({
					id: jobId,
					issueId: z.string().regex(/^[a-f0-9]{24}$/),
					expectedIssueFingerprint: fingerprint,
					expectedRevision: revision.describe("Exact global revision returned by get_project_auditor_state."),
					expectedJobRevision: revision.describe("Exact job revision returned by get_project_audit."),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: assetMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_project_auditor_fix", args)
	);
}

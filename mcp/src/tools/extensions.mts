import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const fingerprint = z
	.string()
	.length(64)
	.regex(/^[a-f0-9]{64}$/);
const packageName = z
	.string()
	.min(1)
	.max(214)
	.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/);
const contributionId = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const capability = z.enum(["inspectors", "windows", "menus", "tests", "buildProfiles", "editor"]);
const profileId = z.string().min(1).max(128);

export function registerExtensionTools(server: McpServer): void {
	server.registerTool(
		"get_editor_extension_sdk",
		{
			title: "Get editor extension SDK",
			description:
				"Get the versioned Zvibe Editor extension manifest, lifecycle, capability, contribution, trust, and bounded-runtime contract without inspecting or executing installed package code.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_editor_extension_sdk")
	);

	server.registerTool(
		"list_editor_extensions",
		{
			title: "List editor extensions",
			description:
				"Inspect direct project dependencies for strict zvibeEditor manifests and return exact package/content fingerprints, shared enablement, machine-local trust, runtime state, issues, and pagination without executing extension code.",
			inputSchema: z
				.object({ offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional(), query: z.string().max(214).optional() })
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_editor_extensions", args)
	);

	server.registerTool(
		"plan_editor_extension_change",
		{
			title: "Plan editor extension change",
			description:
				"Create a single-use 15-minute exact-state plan to enable, disable, trust, revoke trust for, or remove shared configuration for one installed editor extension. Trust requires the exact currently requested capability set.",
			inputSchema: z
				.object({
					operation: z.enum(["enable", "disable", "trust", "revoke-trust", "remove-configuration"]),
					packageName,
					expectedStateFingerprint: fingerprint,
					capabilities: z.array(capability).max(6).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_editor_extension_change", args)
	);

	server.registerTool(
		"apply_editor_extension_plan",
		{
			title: "Apply editor extension plan",
			description:
				"Apply one exact, non-expired, single-use extension plan. Shared enablement changes are persisted to the project; trust changes stay machine-local. Current package/config/trust fingerprints must still match.",
			inputSchema: z.object({ planId: z.string().uuid(), expectedStateFingerprint: fingerprint, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_editor_extension_plan", args)
	);

	server.registerTool(
		"reload_editor_extension",
		{
			title: "Reload editor extension",
			description: "Dispose, re-inspect, trust-check, and reactivate one active editor extension only when its exact runtime fingerprint still matches.",
			inputSchema: z.object({ packageName, expectedExtensionFingerprint: fingerprint }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reload_editor_extension", args)
	);

	server.registerTool(
		"open_editor_extension_window",
		{
			title: "Open editor extension window",
			description: "Open a manifest-declared dockable window owned by one active extension under its exact runtime fingerprint.",
			inputSchema: z.object({ packageName, expectedExtensionFingerprint: fingerprint, windowId: contributionId }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_editor_extension_window", args)
	);

	server.registerTool(
		"invoke_editor_extension_menu",
		{
			title: "Invoke editor extension menu",
			description: "Invoke a manifest-declared menu command owned by one active extension under its exact runtime fingerprint; extension failures and timeouts are returned.",
			inputSchema: z.object({ packageName, expectedExtensionFingerprint: fingerprint, menuId: contributionId }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("invoke_editor_extension_menu", args)
	);

	server.registerTool(
		"list_build_profile_footer_actions",
		{
			title: "List Build Profile footer actions",
			description:
				"List paginated active extension actions that match one selected Build Profile target and active state, including exact profile revision and extension fingerprints, without executing extension code.",
			inputSchema: z
				.object({
					profileId: profileId.optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					query: z.string().max(160).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_build_profile_footer_actions", args)
	);

	server.registerTool(
		"invoke_build_profile_footer_action",
		{
			title: "Invoke Build Profile footer action",
			description:
				"Invoke one active manifest-declared Build Profile footer action after exact Build Profile revision, package content fingerprint, declaration, target filter, and active-profile eligibility checks.",
			inputSchema: z
				.object({
					packageName,
					expectedExtensionFingerprint: fingerprint,
					actionId: contributionId,
					profileId: profileId.optional(),
					expectedConfigurationRevision: z.number().int().min(0),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("invoke_build_profile_footer_action", args)
	);

	server.registerTool(
		"run_editor_extension_tests",
		{
			title: "Run editor extension tests",
			description:
				"Run up to 100 selected manifest-declared editor-only tests from one active extension, sequentially, with a 30-second maximum per-test timeout and exact runtime fingerprint guard.",
			inputSchema: z
				.object({
					packageName,
					expectedExtensionFingerprint: fingerprint,
					ids: z.array(contributionId).max(100).optional(),
					timeoutMs: z.number().int().min(1).max(30_000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("run_editor_extension_tests", args)
	);
}

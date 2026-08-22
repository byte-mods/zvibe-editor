import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().safe().min(1);
const artifactRevision = z.number().int().safe().min(0);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const environmentName = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.max(128);
const relativePath = z
	.string()
	.min(1)
	.max(1_024)
	.refine((value) => {
		const normalized = value.replaceAll("\\", "/");
		return normalized !== "." && !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && !normalized.split("/").includes("..");
	}, "Use a bounded project-relative path without traversal.");
const route = z.string().regex(/^\/[A-Za-z0-9/_-]{0,127}$/);
const operation = z.enum(["build", "validate", "container-build", "deploy", "scale", "restart", "stop", "logs", "profile", "certify"]);
const provider = z.enum(["local", "container", "kubernetes", "console"]);
const jobStatus = z.enum(["queued", "running", "succeeded", "failed", "canceling", "canceled"]);
const planId = z.string().regex(/^server-plan-[a-f0-9]{24}$/);
const jobId = z.string().regex(/^server-job-[a-f0-9]{24}$/);
const instanceId = z.string().regex(/^server-instance-[a-f0-9]{24}$/);

const headlessChanges = z
	.object({
		buildProfileId: identifier.nullable().optional(),
		initialScenePath: z.string().max(1_024).nullable().optional(),
		publicHost: z
			.string()
			.regex(/^[A-Za-z0-9.:-]{1,255}$/)
			.optional(),
		port: z.number().int().min(1_024).max(65_535).optional(),
		tickRate: z.number().int().min(1).max(240).optional(),
		maximumCatchUpSteps: z.number().int().min(1).max(16).optional(),
		maximumPlayers: z.number().int().min(1).max(256).optional(),
		joinCodeEnvironment: environmentName.optional(),
		healthPath: route.optional(),
		metricsPath: route.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Headless field.");
const containerChanges = z
	.object({
		engine: z.enum(["docker", "podman"]).optional(),
		image: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9./_:@-]{0,255}$/)
			.optional(),
		dockerfilePath: relativePath.optional(),
		registryCredentialEnvironment: environmentName.nullable().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Container field.");
const deploymentChanges = z
	.object({
		provider: provider.optional(),
		replicas: z.number().int().min(0).max(256).optional(),
		namespace: z
			.string()
			.regex(/^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/)
			.optional(),
		kubeContext: z.string().trim().min(1).max(256).nullable().optional(),
		consoleProviderId: identifier.nullable().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Deployment field.");
const observabilityChanges = z
	.object({ logLimitBytes: z.number().int().min(1_024).max(1_048_576).optional(), metrics: z.boolean().optional(), portableProfiling: z.boolean().optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Observability field.");
const configurationChanges = z
	.object({
		headless: headlessChanges.optional(),
		container: containerChanges.optional(),
		deployment: deploymentChanges.optional(),
		observability: observabilityChanges.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Console & Server block.");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const externalRead = { ...readOnly, openWorldHint: true };
const authoredWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const externalPlan = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructiveExternal = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function readTool(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict(), annotations = readOnly) {
	return { title, description, inputSchema, annotations };
}

export function registerConsoleServerTools(server: McpServer): void {
	server.registerTool(
		"get_console_server_capabilities",
		readTool(
			"Get Console & Server capabilities",
			"Read the production NullEngine/WebSocket/container/Kubernetes/fleet surface, licensed-provider contract, security controls, and honest external boundaries."
		),
		async (): Promise<CallToolResult> => callTextTool("get_console_server_capabilities")
	);
	server.registerTool(
		"get_console_server_configuration",
		readTool(
			"Get Console & Server configuration",
			"Read exact-revision headless, container, deployment, and observability settings. Only environment-variable names are persisted."
		),
		async (): Promise<CallToolResult> => callTextTool("get_console_server_configuration")
	);
	server.registerTool(
		"set_console_server_configuration",
		{
			title: "Set Console & Server configuration",
			description: "Exact-revision patch production server, container, provider, fleet, or observability settings with Undo/Redo.",
			inputSchema: z.object({ expectedRevision: exactRevision, changes: configurationChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_console_server_configuration", args)
	);
	server.registerTool(
		"list_console_providers",
		readTool("List console providers", "List strict project-contained licensed console provider manifests plus isolated bounded validation errors."),
		async (): Promise<CallToolResult> => callTextTool("list_console_providers")
	);
	server.registerTool(
		"get_console_provider",
		readTool(
			"Get console provider",
			"Read one exact provider manifest, declared platforms, environment references, fixed commands, and content fingerprint.",
			z.object({ id: identifier }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_console_provider", args)
	);
	server.registerTool(
		"validate_console_server_target",
		readTool(
			"Validate Console & Server target",
			"Audit exact authoring, selected headless Build Profile/scene, scaffold and deployment hashes, host commands, provider manifest, and environment references without executing anything.",
			z.object({}).strict(),
			externalRead
		),
		async (): Promise<CallToolResult> => callTextTool("validate_console_server_target")
	);
	server.registerTool(
		"generate_server_deployment_artifacts",
		{
			title: "Generate server deployment artifacts",
			description:
				"Generate hash-owned Kubernetes, environment-example, and deployment documentation files under .zvibe/server against exact configuration/scaffold revisions.",
			inputSchema: z
				.object({
					expectedRevision: artifactRevision,
					expectedConfigurationRevision: exactRevision,
					expectedScaffoldRevision: exactRevision,
					overwrite: z.boolean().optional(),
					confirm: z.boolean().optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.overwrite === true && value.confirm !== true) {
						context.addIssue({ code: "custom", path: ["confirm"], message: "overwrite=true requires confirm=true." });
					}
				}),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_server_deployment_artifacts", args)
	);
	server.registerTool(
		"get_server_deployment_artifacts",
		readTool("Get server deployment artifacts", "Read the deployment artifact revision, exact source revisions, generated files, and SHA-256 integrity evidence."),
		async (): Promise<CallToolResult> => callTextTool("get_server_deployment_artifacts")
	);
	server.registerTool(
		"remove_server_deployment_artifacts",
		{
			title: "Remove server deployment artifacts",
			description: "Confirmed exact-revision removal of only hash-owned files under .zvibe/server; modified files require forceModified=true.",
			inputSchema: z.object({ expectedRevision: exactRevision, confirm: z.literal(true), forceModified: z.literal(true).optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_server_deployment_artifacts", args)
	);
	server.registerTool(
		"plan_console_server_workflow",
		{
			title: "Plan Console & Server workflow",
			description:
				"Create a single-use ten-minute plan bound to exact configuration, headless scaffold, deployment artifact, and console-provider fingerprints. Planning performs no external mutation.",
			inputSchema: z
				.object({
					operation,
					expectedConfigurationRevision: exactRevision,
					expectedScaffoldRevision: exactRevision,
					expectedArtifactsRevision: artifactRevision,
					durationSeconds: z.number().int().min(1).max(3_600).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if ((value.operation === "profile") !== (value.durationSeconds !== undefined)) {
						context.addIssue({ code: "custom", path: ["durationSeconds"], message: "profile requires durationSeconds; other operations do not accept it." });
					}
				}),
			annotations: externalPlan,
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_console_server_workflow", args)
	);
	server.registerTool(
		"get_console_server_workflow_plan",
		readTool("Get Console & Server workflow plan", "Read one unconsumed exact-state plan and expiration evidence.", z.object({ planId }).strict()),
		async (args): Promise<CallToolResult> => callTextTool("get_console_server_workflow_plan", args)
	);
	server.registerTool(
		"execute_console_server_workflow_plan",
		{
			title: "Execute Console & Server workflow plan",
			description: "Consume and execute one exact plan through fixed no-shell Node/container/Kubernetes/licensed-provider commands. confirm=true is mandatory.",
			inputSchema: z.object({ planId, confirm: z.literal(true) }).strict(),
			annotations: destructiveExternal,
		},
		async (args): Promise<CallToolResult> => callTextTool("execute_console_server_workflow_plan", args)
	);
	server.registerTool(
		"get_console_server_job",
		readTool("Get Console & Server job", "Read one retained job with redacted bounded output, fixed commands, and lifecycle evidence.", z.object({ jobId }).strict()),
		async (args): Promise<CallToolResult> => callTextTool("get_console_server_job", args)
	);
	server.registerTool(
		"list_console_server_jobs",
		readTool(
			"List Console & Server jobs",
			"Page retained redacted build, validation, deployment, fleet, log, profile, and certification job evidence.",
			z
				.object({
					provider: provider.optional(),
					operation: operation.optional(),
					status: jobStatus.optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("list_console_server_jobs", args)
	);
	server.registerTool(
		"cancel_console_server_job",
		{
			title: "Cancel Console & Server job",
			description: "Confirm and terminate one active fixed-command process while retaining final redacted evidence.",
			inputSchema: z.object({ jobId, confirm: z.literal(true) }).strict(),
			annotations: destructiveExternal,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_console_server_job", args)
	);
	server.registerTool(
		"list_server_instances",
		readTool(
			"List server instances",
			"Page editor-launched local instances and externally evidenced fleet operations without claiming provider-side discovery.",
			z
				.object({
					provider: provider.optional(),
					state: z.enum(["starting", "running", "stopping", "stopped", "failed", "external"]).optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("list_server_instances", args)
	);
	server.registerTool(
		"get_server_instance",
		readTool("Get server instance", "Read one retained server-instance lifecycle, endpoint, job, and bounded output record.", z.object({ instanceId }).strict()),
		async (args): Promise<CallToolResult> => callTextTool("get_server_instance", args)
	);
	server.registerTool(
		"stop_server_instance",
		{
			title: "Stop local server instance",
			description: "Confirm and stop only one local process launched by this editor. External fleets require an exact stop workflow plan.",
			inputSchema: z.object({ instanceId, confirm: z.literal(true) }).strict(),
			annotations: destructiveExternal,
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_server_instance", args)
	);
	server.registerTool(
		"inspect_server_endpoint",
		readTool(
			"Inspect server endpoint",
			"Read the configured HTTP health or metrics route with a five-second timeout and configured response-size bound.",
			z.object({ kind: z.enum(["health", "metrics"]) }).strict(),
			externalRead
		),
		async (args): Promise<CallToolResult> => callTextTool("inspect_server_endpoint", args)
	);
}

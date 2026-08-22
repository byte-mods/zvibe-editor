import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().safe().min(1);
const mobileTarget = z.enum(["android", "ios"]);
const touchId = z.string().trim().min(1).max(128);
const environmentName = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.max(128);
const applicationId = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/)
	.max(255);
const relativePath = z
	.string()
	.min(1)
	.max(1_024)
	.refine((value) => {
		const normalized = value.replaceAll("\\", "/");
		return normalized !== "." && !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && !normalized.split("/").includes("..");
	}, "Use a bounded project-relative path without traversal.");
const color = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const rect = z
	.object({
		x: z.number().finite().min(0).max(1).optional(),
		y: z.number().finite().min(0).max(1).optional(),
		width: z.number().finite().min(0.03).max(1).optional(),
		height: z.number().finite().min(0.03).max(1).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one rect field.");
const touchControlChanges = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		type: z.enum(["button", "stick"]).optional(),
		controlPath: z
			.string()
			.regex(/^<touch>\/[A-Za-z0-9][A-Za-z0-9_./-]{0,111}$/)
			.optional(),
		label: z.string().max(32).optional(),
		rect: rect.optional(),
		backgroundColor: color.optional(),
		pressedColor: color.optional(),
		buttonValue: z.number().finite().min(Number.EPSILON).max(1).optional(),
		stickDeadzone: z.number().finite().min(0).max(0.999999).optional(),
		stickAxis: z.enum(["both", "horizontal", "vertical"]).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Touch Control field.");
const touchConfigurationChanges = z
	.object({
		enabled: z.boolean().optional(),
		visibleInEditor: z.boolean().optional(),
		respectSafeArea: z.boolean().optional(),
		opacity: z.number().finite().min(0.05).max(1).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Touch Controls setting.");

const androidSigning = z
	.object({
		enabled: z.boolean().optional(),
		keystorePathEnvironment: environmentName.nullable().optional(),
		keystorePasswordEnvironment: environmentName.nullable().optional(),
		keyAliasEnvironment: environmentName.nullable().optional(),
		keyPasswordEnvironment: environmentName.nullable().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Android signing field.");
const androidStore = z
	.object({
		credentialPathEnvironment: environmentName.nullable().optional(),
		track: z.enum(["internal", "alpha", "beta", "production"]).optional(),
		releaseStatus: z.enum(["draft", "completed"]).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Google Play field.");
const androidChanges = z
	.object({
		variant: z.enum(["debug", "release"]).optional(),
		format: z.enum(["apk", "aab"]).optional(),
		applicationId: applicationId.optional(),
		launchActivity: z
			.string()
			.regex(/^\.?[A-Za-z][A-Za-z0-9_.$]{0,254}$/)
			.optional(),
		gradleTask: z
			.string()
			.regex(/^[A-Za-z][A-Za-z0-9:._-]{0,127}$/)
			.nullable()
			.optional(),
		signing: androidSigning.optional(),
		store: androidStore.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one Android deployment field.");
const iosSigning = z
	.object({ enabled: z.boolean().optional(), teamIdEnvironment: environmentName.nullable().optional(), identityEnvironment: environmentName.nullable().optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one iOS signing field.");
const iosStore = z
	.object({ apiKeyPathEnvironment: environmentName.nullable().optional(), submitForReview: z.boolean().optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one App Store field.");
const iosChanges = z
	.object({
		variant: z.enum(["debug", "release"]).optional(),
		applicationId: applicationId.optional(),
		workspace: relativePath.optional(),
		scheme: z
			.string()
			.trim()
			.min(1)
			.max(128)
			.regex(/^[^\r\n\0]+$/)
			.optional(),
		archivePath: relativePath.optional(),
		exportDirectory: relativePath.optional(),
		exportMethod: z.enum(["development", "ad-hoc", "app-store-connect"]).optional(),
		signing: iosSigning.optional(),
		store: iosStore.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide at least one iOS deployment field.");
const deploymentChanges = z
	.object({ android: androidChanges.optional(), ios: iosChanges.optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Provide Android or iOS deployment changes.");

const operation = z.enum(["package", "install", "launch", "logs", "submit"]);
const deviceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const planId = z.string().regex(/^mobile-plan-[a-f0-9]{24}$/);
const jobId = z.string().regex(/^mobile-job-[a-f0-9]{24}$/);
const planInput = z
	.object({
		target: mobileTarget,
		operation,
		expectedRevision: exactRevision,
		expectedScaffoldRevision: exactRevision,
		artifactPath: relativePath.optional(),
		deviceId: deviceId.optional(),
		durationSeconds: z.number().int().min(1).max(3_600).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const needsArtifact = value.operation === "install" || value.operation === "submit";
		const needsDevice = value.operation === "install" || value.operation === "launch" || value.operation === "logs";
		if (needsArtifact !== Boolean(value.artifactPath)) {
			context.addIssue({ code: "custom", path: ["artifactPath"], message: `${value.operation} ${needsArtifact ? "requires" : "does not accept"} artifactPath.` });
		}
		if (needsDevice !== Boolean(value.deviceId)) {
			context.addIssue({ code: "custom", path: ["deviceId"], message: `${value.operation} ${needsDevice ? "requires" : "does not accept"} deviceId.` });
		}
		if ((value.operation === "logs") !== (value.durationSeconds !== undefined)) {
			context.addIssue({
				code: "custom",
				path: ["durationSeconds"],
				message: `${value.operation} ${value.operation === "logs" ? "requires" : "does not accept"} durationSeconds.`,
			});
		}
	});

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const diagnosticRead = { ...readOnly, openWorldHint: true };
const authoredWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const transientWrite = { ...authoredWrite };
const nativePlan = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructiveLocal = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const destructiveNative = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function readTool(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict(), annotations = readOnly) {
	return { title, description, inputSchema, annotations };
}

export function registerMobileTools(server: McpServer): void {
	server.registerTool(
		"get_mobile_capabilities",
		readTool(
			"Get Mobile capabilities",
			"Read the shipped on-screen touch, Android/iOS package/sign/device/log/store workflows, tool dependencies, security controls, and honest vendor boundaries."
		),
		async (): Promise<CallToolResult> => callTextTool("get_mobile_capabilities")
	);
	server.registerTool(
		"get_touch_controls_configuration",
		readTool("Get Touch Controls configuration", "Read the complete versioned on-screen button/stick configuration and exact scene revision."),
		async (): Promise<CallToolResult> => callTextTool("get_touch_controls_configuration")
	);
	server.registerTool(
		"set_touch_controls_configuration",
		{
			title: "Set Touch Controls configuration",
			description: "Exact-revision patch runtime enabled, editor visibility, safe-area, or opacity settings.",
			inputSchema: z.object({ expectedRevision: exactRevision, changes: touchConfigurationChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_touch_controls_configuration", args)
	);
	server.registerTool(
		"create_touch_control",
		{
			title: "Create Touch Control",
			description: "Create one bounded hand-editable on-screen button or fixed-center stick with a normalized viewport rect and Input Actions <touch>/ path.",
			inputSchema: z.object({ expectedRevision: exactRevision, control: touchControlChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_touch_control", args)
	);
	server.registerTool(
		"set_touch_control",
		{
			title: "Set Touch Control",
			description: "Exact-revision update one stable-id button/stick layout, binding, appearance, or value/deadzone field.",
			inputSchema: z.object({ expectedRevision: exactRevision, id: touchId, changes: touchControlChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_touch_control", args)
	);
	server.registerTool(
		"delete_touch_control",
		{
			title: "Delete Touch Control",
			description: "Delete one exact-revision on-screen control and clear its transient preview value.",
			inputSchema: z.object({ expectedRevision: exactRevision, id: touchId, confirm: z.literal(true) }).strict(),
			annotations: destructiveLocal,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_touch_control", args)
	);
	server.registerTool(
		"validate_touch_controls",
		readTool("Validate Touch Controls", "Audit viewport bounds, stable identity, uniqueness, appearance values, and Input Actions path bindings without changing the scene."),
		async (): Promise<CallToolResult> => callTextTool("validate_touch_controls")
	);
	server.registerTool(
		"simulate_touch_control",
		{
			title: "Simulate Touch Control",
			description: "Press, move, or release one authored control through the active Input Actions preview runtime without changing persisted authoring.",
			inputSchema: z
				.object({
					id: touchId,
					phase: z.enum(["press", "move", "release"]),
					value: z.tuple([z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1)]).optional(),
				})
				.strict(),
			annotations: transientWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_touch_control", args)
	);
	server.registerTool(
		"get_touch_controls_runtime",
		readTool("Get Touch Controls runtime", "Read bounded active pointer and Input Actions values for the current editor viewport overlay."),
		async (): Promise<CallToolResult> => callTextTool("get_touch_controls_runtime")
	);

	server.registerTool(
		"get_mobile_deployment_configuration",
		readTool(
			"Get Mobile deployment configuration",
			"Read exact-revision Android/iOS package, signing-environment-reference, output, and store settings; secret values are never returned."
		),
		async (): Promise<CallToolResult> => callTextTool("get_mobile_deployment_configuration")
	);
	server.registerTool(
		"set_mobile_deployment_configuration",
		{
			title: "Set Mobile deployment configuration",
			description: "Exact-revision patch Android/iOS native deployment settings. Credential/signing fields accept environment-variable names only, never secret values.",
			inputSchema: z.object({ expectedRevision: exactRevision, changes: deploymentChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mobile_deployment_configuration", args)
	);
	server.registerTool(
		"validate_mobile_target",
		readTool(
			"Validate Mobile target",
			"Audit the exact deployment configuration, scaffold integrity, native project, host tools, environment references, package/device/store readiness, and vendor prerequisites without executing a workflow.",
			z.object({ target: mobileTarget }).strict(),
			diagnosticRead
		),
		async (args): Promise<CallToolResult> => callTextTool("validate_mobile_target", args)
	);
	server.registerTool(
		"plan_mobile_workflow",
		{
			title: "Plan Mobile workflow",
			description:
				"Create a one-time ten-minute package/install/launch/log/store plan bound to exact deployment/scaffold revisions, artifact hash, device id, and required installed tools. Planning performs no native mutation.",
			inputSchema: planInput,
			annotations: nativePlan,
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_mobile_workflow", args)
	);
	server.registerTool(
		"get_mobile_workflow_plan",
		readTool("Get Mobile workflow plan", "Read one unexpired exact-state Mobile plan and its artifact hash/warnings.", z.object({ planId }).strict()),
		async (args): Promise<CallToolResult> => callTextTool("get_mobile_workflow_plan", args)
	);
	server.registerTool(
		"execute_mobile_workflow_plan",
		{
			title: "Execute Mobile workflow plan",
			description:
				"Consume and execute one exact Mobile plan through fixed no-shell vendor commands. May package/sign, mutate a connected device, capture logs, or submit to a configured store track; confirm=true is mandatory.",
			inputSchema: z.object({ planId, confirm: z.literal(true) }).strict(),
			annotations: destructiveNative,
		},
		async (args): Promise<CallToolResult> => callTextTool("execute_mobile_workflow_plan", args)
	);
	server.registerTool(
		"get_mobile_job",
		readTool(
			"Get Mobile job",
			"Read one retained Mobile job with redacted commands/output, lifecycle state, error, and hash-verified produced artifacts.",
			z.object({ jobId }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_mobile_job", args)
	);
	server.registerTool(
		"list_mobile_jobs",
		readTool(
			"List Mobile jobs",
			"Page retained redacted Mobile package/device/log/store job evidence.",
			z
				.object({
					target: mobileTarget.optional(),
					status: z.enum(["queued", "running", "succeeded", "failed", "canceling", "canceled"]).optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("list_mobile_jobs", args)
	);
	server.registerTool(
		"cancel_mobile_job",
		{
			title: "Cancel Mobile job",
			description: "Confirm and terminate one active native vendor process while retaining its final redacted evidence.",
			inputSchema: z.object({ jobId, confirm: z.literal(true) }).strict(),
			annotations: destructiveNative,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_mobile_job", args)
	);
	server.registerTool(
		"list_mobile_artifacts",
		readTool(
			"List Mobile artifacts",
			"Page project-contained APK, AAB, and IPA artifacts with size, modification time, and SHA-256 evidence.",
			z.object({ target: mobileTarget.optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("list_mobile_artifacts", args)
	);
	server.registerTool(
		"list_mobile_devices",
		readTool(
			"List Mobile devices",
			"Query installed adb or xcrun tooling for connected Android/iOS physical devices and simulators without changing them.",
			z.object({ target: mobileTarget, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
			diagnosticRead
		),
		async (args): Promise<CallToolResult> => callTextTool("list_mobile_devices", args)
	);
}

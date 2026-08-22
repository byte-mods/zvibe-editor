import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().min(0);
const packageScript = z
	.string()
	.regex(/^[A-Za-z0-9:_-]+$/)
	.max(128);
const scaffoldTarget = z.enum(["headless", "android", "ios"]);
const platformTarget = z.enum(["web", "electron", "headless", "android", "ios", "webxr", "console"]);
const mutation = z.object({ expectedRevision: exactRevision, overwrite: z.boolean().optional(), confirm: z.boolean().optional() });
const headlessSettings = z
	.object({
		baseBuildScript: packageScript.optional(),
		host: z.string().min(1).max(255).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		tickRate: z.number().int().min(1).max(240).optional(),
		maximumCatchUpSteps: z.number().int().min(1).max(16).optional(),
	})
	.strict();
const androidSettings = z
	.object({
		baseBuildScript: packageScript.optional(),
		orientation: z.enum(["any", "portrait", "landscape"]).optional(),
		syncNativeProject: z.boolean().optional(),
		minimumSdk: z.number().int().min(21).max(100).optional(),
		targetSdk: z.number().int().min(21).max(100).optional(),
		format: z.enum(["project", "apk", "aab"]).optional(),
	})
	.strict();
const iosSettings = z
	.object({
		baseBuildScript: packageScript.optional(),
		orientation: z.enum(["any", "portrait", "landscape"]).optional(),
		syncNativeProject: z.boolean().optional(),
		deploymentTarget: z
			.string()
			.regex(/^\d{1,2}\.\d{1,2}$/)
			.optional(),
		deviceFamily: z.enum(["iphone", "ipad", "universal"]).optional(),
		targetMinimumVisionOSVersion: z
			.string()
			.regex(/^\d{1,2}\.\d{1,2}$/)
			.optional(),
		projectType: z.enum(["capacitor", "swift"]).optional(),
	})
	.strict();
const generateInput = mutation
	.extend({ target: scaffoldTarget, settings: z.union([headlessSettings, androidSettings, iosSettings]).optional() })
	.strict()
	.superRefine((value, context) => {
		const schema = value.target === "headless" ? headlessSettings : value.target === "android" ? androidSettings : iosSettings;
		const parsed = schema.safeParse(value.settings ?? {});
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				context.addIssue({ ...issue, path: ["settings", ...issue.path] });
			}
		}
	});

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const diagnosticAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export function registerPlatformTools(server: McpServer): void {
	server.registerTool(
		"list_platform_capabilities",
		{
			title: "List platform capabilities",
			description:
				"Read the honest Web, Electron desktop, Android, iOS, Dedicated Server, WebXR, and closed-console support inventory, including built-in/scaffolded/integrated/unsupported status, host requirements, existing subsystem integrations, and limitations.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("list_platform_capabilities")
	);
	server.registerTool(
		"get_platform_diagnostics",
		{
			title: "Get platform diagnostics",
			description:
				"Inspect the current host, architecture, SDK environment, required commands, package scripts, scaffold integrity, project-export readiness, and native-package readiness for one or every supported platform without installing or launching anything.",
			inputSchema: z.object({ target: platformTarget.optional() }).strict(),
			annotations: diagnosticAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_platform_diagnostics", args)
	);
	server.registerTool(
		"get_ios_project_generation_capabilities",
		{
			title: "Get iOS project generation capabilities",
			description:
				"Read the Capacitor and experimental SwiftUI/WKWebView iOS project types, minimum versions, deterministic generated paths, external Xcode/signing requirements, and explicitly unsupported experimental boundaries.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("get_ios_project_generation_capabilities")
	);
	server.registerTool(
		"get_platform_scaffold",
		{
			title: "Get platform scaffold",
			description:
				"Read one Android, iOS, or Dedicated Server scaffold's exact revision, settings, package-script ownership, preserved user files, and generated-file hash integrity.",
			inputSchema: z.object({ target: scaffoldTarget }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_platform_scaffold", args)
	);
	server.registerTool(
		"generate_platform_scaffold",
		{
			title: "Generate platform scaffold",
			description:
				"Generate or exactly revise one project-contained Android Capacitor, iOS Capacitor, or fixed-rate Dedicated Server scaffold and its package scripts. Modified generated files or existing scripts require overwrite=true and confirm=true; the server-game hook remains preserved.",
			inputSchema: generateInput,
			annotations: writeAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_platform_scaffold", args)
	);
	server.registerTool(
		"remove_platform_scaffold",
		{
			title: "Remove platform scaffold",
			description:
				"At the exact current revision and confirm=true, remove only editor-owned generated Android, iOS, or Dedicated Server scaffold files and restore package scripts replaced by generation; preserved game-owned server hooks are not deleted.",
			inputSchema: z.object({ target: scaffoldTarget, expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_platform_scaffold", args)
	);
	server.registerTool(
		"validate_ios_generated_project",
		{
			title: "Validate generated iOS project",
			description:
				"Validate one exact experimental Swift iOS scaffold revision, all editor-owned hashes, Xcode project/scheme structure, SwiftUI entry point, WKWebView host, and Info.plist markers without compiling, signing, or launching it.",
			inputSchema: z.object({ expectedRevision: exactRevision.optional() }).strict(),
			annotations: diagnosticAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_ios_generated_project", args)
	);
	server.registerTool(
		"validate_platform_build_matrix",
		{
			title: "Validate platform build matrix",
			description:
				"Validate every authored Build Profile together with its current host/toolchain/scaffold readiness and report separate project-export and native-package readiness without building, installing, signing, or deploying.",
			inputSchema: z.object({}).strict(),
			annotations: diagnosticAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("validate_platform_build_matrix")
	);
	server.registerTool(
		"get_installed_platform_restart_status",
		{
			title: "Get installed-platform restart status",
			description:
				"Inspect exact Build Profile revision, host/toolchain/scaffold readiness, deterministic diagnostic fingerprint, and latest relaunch evidence for one platform without saving or restarting the editor.",
			inputSchema: z.object({ target: z.enum(["web", "electron", "headless", "android", "ios"]) }).strict(),
			annotations: diagnosticAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_installed_platform_restart_status", args)
	);
	server.registerTool(
		"plan_installed_platform_restart",
		{
			title: "Plan installed-platform restart",
			description:
				"Create a bounded, single-use five-minute restart lease for installed project platform support under one exact diagnostic fingerprint; this does not save or relaunch the editor.",
			inputSchema: z
				.object({
					target: z.enum(["web", "electron", "headless", "android", "ios"]),
					expectedDiagnosticFingerprint: z
						.string()
						.length(64)
						.regex(/^[a-f0-9]{64}$/),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("plan_installed_platform_restart", args)
	);
	server.registerTool(
		"restart_editor_for_installed_platform",
		{
			title: "Restart editor for installed platform",
			description:
				"Consume one exact, non-expired platform restart lease, persist the project, and schedule a Zvibe Editor relaunch that reopens the same project with verifiable target/plan evidence.",
			inputSchema: z
				.object({
					planId: z.string().uuid(),
					expectedDiagnosticFingerprint: z
						.string()
						.length(64)
						.regex(/^[a-f0-9]{64}$/),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("restart_editor_for_installed_platform", args)
	);
}

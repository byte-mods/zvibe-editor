import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerExportTools(server: McpServer): void {
	server.registerTool(
		"list_build_profiles",
		{ title: "List build profiles", description: "List persisted export profiles.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_build_profiles")
	);
	server.registerTool(
		"create_build_profile",
		{
			title: "Create build profile",
			description: "Create a named export profile backed by the editor export pipeline.",
			inputSchema: z.object({
				name: z.string(),
				target: z.enum(["web", "electron", "headless", "android", "ios"]).optional(),
				options: z.record(z.string(), z.any()).optional(),
				settings: z
					.record(z.string(), z.any())
					.optional()
					.describe(
						"Persisted target settings, such as output directory, product name, version, and platform preferences. Web PWA profiles accept settings.pwa with name, shortName, startUrl, display, backgroundColor, themeColor, manifestPath, and optional manifest icons."
					),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_build_profile", args)
	);
	server.registerTool(
		"delete_build_profile",
		{
			title: "Delete build profile",
			description: "Delete a persisted export profile without removing any already-generated output.",
			inputSchema: z.object({ name: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_build_profile", args)
	);
	server.registerTool(
		"set_build_profile",
		{
			title: "Update build profile",
			description: "Update a persisted profile's target, export options, or target settings.",
			inputSchema: z.object({
				name: z.string(),
				target: z.enum(["web", "electron", "headless", "android", "ios"]).optional(),
				options: z.record(z.string(), z.any()).optional(),
				settings: z
					.record(z.string(), z.any())
					.optional()
					.describe(
						"Full persisted target settings. For a Web manifest, use settings.pwa with name, shortName, startUrl, display, backgroundColor, themeColor, manifestPath, and optional icons."
					),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_build_profile", args)
	);
	server.registerTool(
		"run_build_profile",
		{ title: "Run build profile", description: "Run the existing export pipeline with a named build profile.", inputSchema: z.object({ name: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("run_build_profile", args)
	);
	server.registerTool(
		"get_build_profile_environment",
		{
			title: "Get build profile environment",
			description:
				"Get the non-secret BJS_EDITOR_* variables injected into the selected profile's web/Electron build scripts, including product, version, output directory, and serialized settings.",
			inputSchema: z.object({ name: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_build_profile_environment", args)
	);
	server.registerTool(
		"validate_build_profile",
		{
			title: "Validate build profile",
			description:
				"Check whether a profile's web, Electron, headless, Android, or iOS target has the required project package scripts before running a full application build.",
			inputSchema: z.object({ name: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_build_profile", args)
	);
	server.registerTool(
		"build_build_profile",
		{
			title: "Build target profile",
			description:
				"Export the active scene and run the selected profile's project build scripts. Web runs `build`; Electron runs `build` then `package`; headless runs `build:headless`; Android/iOS run `build:android`/`build:ios`. This writes target artifacts to the project.",
			inputSchema: z.object({ name: z.string() }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("build_build_profile", args)
	);
	server.registerTool(
		"generate_pwa_manifest",
		{
			title: "Generate PWA manifest",
			description:
				"Write a Web build profile's persisted PWA manifest into the project. This generates only manifest metadata; service-worker/offline caching remains the web app's responsibility.",
			inputSchema: z.object({ name: z.string().describe("Web build profile name with optional settings.pwa configuration.") }),
			annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_pwa_manifest", args)
	);
	server.registerTool(
		"generate_pwa_service_worker",
		{
			title: "Generate PWA service worker",
			description:
				"Write a cache-first, offline-fallback service worker for a Web build profile. Configure settings.pwa.serviceWorkerPath, precacheUrls, and offlineFallbackUrl; register the returned script from the web application entry point.",
			inputSchema: z.object({ name: z.string().describe("Web build profile name with settings.pwa service-worker configuration.") }),
			annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_pwa_service_worker", args)
	);
	server.registerTool(
		"install_pwa_service_worker_registration",
		{
			title: "Install PWA service-worker registration",
			description:
				"Idempotently install or update the generated PWA worker registration in a Web profile's root index.html. Generate the worker first. Framework projects without a root index.html receive an actionable manual-registration error instead of source edits.",
			inputSchema: z.object({ name: z.string().describe("Web build profile name whose generated public service worker should be registered.") }),
			annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("install_pwa_service_worker_registration", args)
	);
	server.registerTool(
		"list_build_reports",
		{
			title: "List build reports",
			description:
				"List the latest persisted scene export/build reports, including output file counts, byte totals, extension breakdowns, profile, outcome, and build commands when available.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_build_reports", {})
	);
	server.registerTool(
		"get_generate_options",
		{
			title: "Get generate options",
			description: "Get the editor's supported project-generation options and defaults. Generation packaging is currently performed by the editor Generate dialog.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_generate_options", {})
	);
	server.registerTool(
		"get_export_report",
		{
			title: "Get export report",
			description: "Report the active scene's export output directory, last modification time, file count, bytes, and extension breakdown.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_export_report", {})
	);
	server.registerTool(
		"export_active_scene",
		{
			title: "Export active scene",
			description: "Run the editor's export pipeline for the active scene. This writes generated scene and asset files into the current project's public/scene directory.",
			inputSchema: z.object({ optimize: z.boolean().default(true).describe("Optimize exported assets and remove stale exported files.") }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("export_active_scene", args)
	);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().min(0);
const id = z.string().min(1).max(128);
const name = z.string().min(1).max(128);
const projectPath = z.string().min(1).max(1024);
const packageScript = z
	.string()
	.regex(/^[A-Za-z0-9:_-]+$/)
	.max(128);
const environment = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.max(128);
const target = z.enum(["web", "electron", "headless", "android", "ios"]);
const options = z
	.object({ optimize: z.boolean().optional(), mergeDecals: z.boolean().optional(), mergeGeometries: z.boolean().optional(), uploadToS3: z.boolean().optional() })
	.strict();
const signing = z
	.object({
		enabled: z.boolean(),
		identityEnvironment: environment.optional(),
		certificateEnvironment: environment.optional(),
		passwordEnvironment: environment.optional(),
		provisioningProfileEnvironment: environment.optional(),
	})
	.strict();
const pwaIcon = z
	.object({
		src: z.string().min(1).max(1024),
		sizes: z.string().min(1).max(128).optional(),
		type: z.string().min(1).max(128).optional(),
		purpose: z.enum(["any", "maskable", "monochrome"]).optional(),
	})
	.strict();
const pwa = z
	.object({
		name: name.optional(),
		shortName: z.string().min(1).max(64).optional(),
		startUrl: z.string().startsWith("/").max(2048).optional(),
		display: z.enum(["fullscreen", "standalone", "minimal-ui", "browser"]).optional(),
		backgroundColor: z
			.string()
			.regex(/^#[a-fA-F0-9]{6}$/)
			.optional(),
		themeColor: z
			.string()
			.regex(/^#[a-fA-F0-9]{6}$/)
			.optional(),
		manifestPath: projectPath.optional(),
		serviceWorkerPath: projectPath.optional(),
		precacheUrls: z.array(z.string().startsWith("/").max(2048)).max(512).optional(),
		offlineFallbackUrl: z.string().startsWith("/").max(2048).optional(),
		icons: z.array(pwaIcon).max(64).optional(),
	})
	.strict();
const settings = z
	.object({
		productName: name.optional(),
		companyName: name.optional(),
		version: z.string().min(1).max(64).optional(),
		applicationId: z
			.string()
			.regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/)
			.max(255)
			.optional(),
		outputDirectory: projectPath.optional(),
		buildMode: z.enum(["development", "release"]).optional(),
		cleanBuild: z.boolean().optional(),
		incremental: z.boolean().optional(),
		sourceMaps: z.boolean().optional(),
		minify: z.boolean().optional(),
		codeCoverage: z.boolean().optional(),
		compression: z.enum(["none", "gzip", "brotli"]).optional(),
		defineSymbols: z
			.array(
				z
					.string()
					.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
					.max(128)
			)
			.max(128)
			.optional(),
		preBuildScripts: z.array(packageScript).max(16).optional(),
		buildScripts: z.array(packageScript).min(1).max(16).optional(),
		postBuildScripts: z.array(packageScript).max(16).optional(),
		runScript: packageScript.optional(),
		signing: signing.optional(),
		web: z
			.object({
				basePath: z.string().startsWith("/").max(2048).optional(),
				mode: z.enum(["browser", "pwa", "webxr"]).optional(),
				clientBrowser: z.enum(["system", "chrome", "firefox", "safari", "edge"]).optional(),
				optimization: z.enum(["fast-build", "balanced", "runtime-performance", "small-download"]).optional(),
				moduleStripping: z.boolean().optional(),
				webAssembly2023: z.boolean().optional(),
				emscriptenToolchain: z.enum(["typescript-bundler", "external-4.0.19"]).optional(),
				emscriptenExecutable: z
					.string()
					.min(1)
					.max(2048)
					.regex(/^[^\0\r\n]+$/)
					.optional(),
			})
			.strict()
			.optional(),
		android: z
			.object({
				linkTimeOptimization: z.enum(["none", "thin", "full"]).optional(),
				xrLinkTimeOptimization: z.enum(["inherit", "thin"]).optional(),
				initializationProfiling: z.boolean().optional(),
			})
			.strict()
			.optional(),
		headless: z
			.object({
				operatingSystem: z.literal("linux").optional(),
				architecture: z.enum(["x64", "arm64"]).optional(),
				sourceBuild: z.literal(true).optional(),
				nodeMajor: z.literal(22).optional(),
			})
			.strict()
			.optional(),
		pwa: pwa.optional(),
		electronPlatform: z.enum(["darwin", "win32", "linux"]).optional(),
		electronArch: z.enum(["x64", "arm64"]).optional(),
		electronAsar: z.boolean().optional(),
		electronIcon: projectPath.optional(),
		platformPlayer: z
			.object({
				version: z.literal(1).optional(),
				linux: z
					.object({
						variant: z.enum(["desktop", "embedded"]).optional(),
						lto: z.enum(["thin", "full"]).optional(),
						ime: z.enum(["disabled", "ibus", "fcitx5"]).optional(),
					})
					.strict()
					.optional(),
				macos: z
					.object({ useDisplayLink: z.boolean().optional(), maximumQueuedFrames: z.number().int().min(1).max(3).optional() })
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
		assetStreaming: z
			.object({
				version: z.literal(1).optional(),
				windows: z
					.object({
						enableDirectStorage: z.boolean().optional(),
						maximumConcurrentReads: z.number().int().min(1).max(64).optional(),
						maximumQueuedRequests: z.number().int().min(1).max(10_000).optional(),
						requestTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
						chunkSizeBytes: z
							.number()
							.int()
							.min(64 * 1024)
							.max(4 * 1024 * 1024)
							.optional(),
						maximumAssetBytes: z
							.number()
							.int()
							.min(1_024)
							.max(2 * 1024 * 1024 * 1024)
							.optional(),
					})
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const replaceAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const processAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function readOnly(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict()) {
	return { title, description, inputSchema, annotations: readAnnotations };
}

export function registerExportTools(server: McpServer): void {
	server.registerTool(
		"list_build_profiles",
		readOnly(
			"List Build Profiles",
			"Read the complete normalized version-2 Build Pipeline configuration, exact revision, active profile, targets, export options, Android LTO/initialization profiling, Linux ARM64 public-source server settings, Electron Linux/macOS platform-player settings, package-script stages, and signing environment references."
		),
		async (): Promise<CallToolResult> => callTextTool("list_build_profiles")
	);
	server.registerTool(
		"create_build_profile",
		{
			title: "Create Build Profile",
			description: "Create one bounded Web, Electron, Headless, Android, or iOS profile at an exact configuration revision.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					id: id.optional(),
					name,
					target: target.optional(),
					enabled: z.boolean().optional(),
					options: options.optional(),
					settings: settings.optional(),
				})
				.strict(),
			annotations: writeAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_build_profile", args)
	);
	server.registerTool(
		"duplicate_build_profile",
		{
			title: "Duplicate Build Profile",
			description: "Clone one complete profile under a new stable id and unique name at an exact revision.",
			inputSchema: z.object({ expectedRevision: exactRevision, id, newId: id.optional(), newName: name }).strict(),
			annotations: writeAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("duplicate_build_profile", args)
	);
	server.registerTool(
		"set_active_build_profile",
		{
			title: "Set Active Build Profile",
			description: "Select the default Build/Build & Run profile at an exact revision.",
			inputSchema: z.object({ expectedRevision: exactRevision, id }).strict(),
			annotations: replaceAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_active_build_profile", args)
	);
	server.registerTool(
		"set_build_profile",
		{
			title: "Set Build Profile",
			description:
				"Atomically rename, enable, retarget, or replace one profile's export options and complete target settings—including Android project-native/XR LTO and initialization markers, Headless Linux ARM64 public-source packaging, and Electron Linux LTO/IME and macOS display-link policy—at an exact revision.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					id,
					name: name.optional(),
					target: target.optional(),
					enabled: z.boolean().optional(),
					options: options.optional(),
					settings: settings.optional(),
				})
				.strict(),
			annotations: replaceAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_build_profile", args)
	);
	server.registerTool(
		"delete_build_profile",
		{
			title: "Delete Build Profile",
			description: "Delete one profile at an exact revision without removing generated output.",
			inputSchema: z.object({ expectedRevision: exactRevision, id }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_build_profile", args)
	);
	server.registerTool(
		"get_build_profile_environment",
		readOnly(
			"Get Build Profile Environment",
			"Read non-secret BJS_EDITOR_* variables, including Android, Linux ARM64 Headless, and Electron platform-player build plans/settings plus persisted credential-environment names injected into package scripts; secret values are never returned.",
			z.object({ id }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_build_profile_environment", args)
	);
	server.registerTool(
		"get_android_build_profile_plan",
		readOnly(
			"Get Android Build Profile plan",
			"Read one Android Build Profile's portable project-native None/Thin/Full LTO flags, XR ThinLTO adapter definition, generated early Android Trace initialization markers, bounded evidence capacity, and explicit prebuilt-library/Unity-IL2CPP boundary.",
			z.object({ id }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_android_build_profile_plan", args)
	);
	server.registerTool(
		"get_linux_arm64_server_source_build_plan",
		readOnly(
			"Get Linux ARM64 server source-build plan",
			"Read one Headless Build Profile's deterministic public Node/TypeScript Linux ARM64 source-package plan, Node major, fixed output artifacts, container platform, native-addon requirement, SHA-256 lease, and explicit non-Unity/internal-tool boundary.",
			z.object({ id }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_linux_arm64_server_source_build_plan", args)
	);
	server.registerTool(
		"verify_linux_arm64_server_source_build",
		readOnly(
			"Verify Linux ARM64 server source build",
			"At the exact Build Pipeline revision and source-build plan fingerprint, verify the generated bounded descriptor, every fixed artifact SHA-256/size, Linux/arm64 package restrictions, Node syntax, public-toolchain evidence, and portability boundary without running the server.",
			z
				.object({
					expectedRevision: exactRevision,
					expectedPlanFingerprint: z
						.string()
						.length(64)
						.regex(/^[a-f0-9]{64}$/),
					id,
				})
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("verify_linux_arm64_server_source_build", args)
	);
	server.registerTool(
		"inspect_web_build_plan",
		readOnly(
			"Inspect Web Build Plan",
			"Analyze bounded project inputs at an exact Build Pipeline revision without executing authored programs, and return deterministic ESM module keep/strip decisions, WebAssembly 2023 policy, selected external Emscripten 4.0.19 build-time verification requirements or the default no-Emscripten boundary, PNG/JPEG browser-codec evidence, and an exact plan fingerprint.",
			z.object({ expectedRevision: exactRevision, id }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("inspect_web_build_plan", args)
	);
	server.registerTool(
		"verify_web_build_output",
		readOnly(
			"Verify Web Build Output",
			"Re-scan one generated Web output under its exact Build Pipeline revision and plan fingerprint, verify generated toolchain proof and planned module-marker absence, validate WebAssembly binaries, prove libpng/libjpeg marker absence, and detect artifact changes after manifest generation without executing programs or modifying files.",
			z.object({ expectedRevision: exactRevision, id, expectedPlanFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("verify_web_build_output", args)
	);
	server.registerTool(
		"get_development_build_coverage",
		readOnly(
			"Get Development Build Coverage",
			"Inspect one Electron development profile's exact generated source-instrumentation manifest, bounded source points, runtime snapshot/export API, compatibility, and current Build Pipeline revision. This never launches or mutates a player.",
			z
				.object({
					id,
					path: z
						.string()
						.startsWith("src/")
						.max(1024)
						.regex(/^src\/(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$)).+\.(?:[cm]?[jt]sx?)$/)
						.optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(10_000).optional(),
				})
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_development_build_coverage", args)
	);
	server.registerTool(
		"get_project_serialization_session",
		readOnly(
			"Get Project Serialization Session",
			"Read the editor session's exact oldest serialized file/version, bounded ordered file evidence, load counts, current editor serialization version, revision, and truncation state. This does not rewrite or migrate files.",
			z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_project_serialization_session", args)
	);
	server.registerTool(
		"validate_build_profile",
		readOnly(
			"Validate Build Profile",
			"Validate package scripts, profile/settings bounds, Linux ARM64 Headless native-addon portability warnings, Electron Linux/macOS platform-player limitations, output/icon containment, signing prerequisites, host constraints, and available scenes before execution.",
			z.object({ id }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("validate_build_profile", args)
	);
	server.registerTool(
		"run_build_profile",
		{
			title: "Export Build Profile",
			description:
				"Run the canonical editor export stage for one profile under an exact revision and retain a structured report. Set background=true for large projects; poll get_build_pipeline_status with the returned job id so no individual MCP request remains blocked for the duration of the export.",
			inputSchema: z.object({ expectedRevision: exactRevision, id, background: z.boolean().optional() }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("run_build_profile", args)
	);
	server.registerTool(
		"build_build_profile",
		{
			title: "Build Target Profile",
			description:
				"Validate, optionally clean, export, execute bounded pre/build/post package scripts—including Linux ARM64 Headless source packaging and Electron project-native LTO/IME/display policy—apply environment-only signing credentials, hash target artifacts, and retain a staged report. Exact input/output hashes provide verified incremental cache hits.",
			inputSchema: z.object({ expectedRevision: exactRevision, id, force: z.boolean().optional(), background: z.boolean().optional() }).strict(),
			annotations: processAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("build_build_profile", args)
	);
	server.registerTool(
		"build_and_run_build_profile",
		{
			title: "Build and Run Profile",
			description:
				"Build one exact profile, then launch only its explicitly configured package runScript and return a transient run id. Set background=true for a non-blocking retained job and poll get_build_pipeline_status with its id.",
			inputSchema: z.object({ expectedRevision: exactRevision, id, force: z.boolean().optional(), background: z.boolean().optional() }).strict(),
			annotations: processAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("build_and_run_build_profile", args)
	);
	server.registerTool(
		"stop_build_profile_run",
		{
			title: "Stop Build Profile Run",
			description: "Stop one transient Build & Run child process by exact run id.",
			inputSchema: z.object({ runId: id, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_build_profile_run", args)
	);
	server.registerTool(
		"get_build_pipeline_status",
		readOnly(
			"Get Build Pipeline Status",
			"Read the exact configuration revision, active profile, bounded running/stopping/exited Build & Run processes, and up to 32 non-blocking export/build jobs. Supply an exact jobId and includeResult=true only after success to retrieve that job's result.",
			z
				.object({
					jobId: z
						.string()
						.regex(/^build-job-[a-f0-9]{24}$/)
						.optional(),
					includeResult: z.boolean().optional(),
				})
				.strict()
				.refine((value) => !value.includeResult || Boolean(value.jobId), { message: "includeResult requires jobId." })
		),
		async (args): Promise<CallToolResult> => callTextTool("get_build_pipeline_status", args)
	);
	server.registerTool(
		"clean_build_profile_output",
		{
			title: "Clean Build Profile Output",
			description: "Hash and delete only one validated project-local target output directory, then retain a clean report.",
			inputSchema: z.object({ expectedRevision: exactRevision, id, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("clean_build_profile_output", args)
	);
	server.registerTool(
		"generate_pwa_manifest",
		{
			title: "Generate PWA Manifest",
			description: "Write one Web profile's validated PWA manifest inside the project under an exact profile revision.",
			inputSchema: z.object({ expectedRevision: exactRevision, id }).strict(),
			annotations: replaceAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_pwa_manifest", args)
	);
	server.registerTool(
		"generate_pwa_service_worker",
		{
			title: "Generate PWA Service Worker",
			description: "Write a bounded cache-first/offline-fallback service worker for one exact Web profile.",
			inputSchema: z.object({ expectedRevision: exactRevision, id }).strict(),
			annotations: replaceAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_pwa_service_worker", args)
	);
	server.registerTool(
		"install_pwa_service_worker_registration",
		{
			title: "Install PWA Service Worker Registration",
			description: "Idempotently install or update generated-worker registration in a root Web index under an exact profile revision.",
			inputSchema: z.object({ expectedRevision: exactRevision, id }).strict(),
			annotations: replaceAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("install_pwa_service_worker_registration", args)
	);
	server.registerTool(
		"list_build_reports",
		readOnly(
			"List Build Reports",
			"List the newest 50 versioned build/export/clean/cache/failure reports with stage, command-tail, fingerprint, output, and artifact evidence."
		),
		async (): Promise<CallToolResult> => callTextTool("list_build_reports", {})
	);
	server.registerTool(
		"get_build_report",
		readOnly("Get Build Report", "Read one retained complete Build Pipeline report by stable id.", z.object({ id }).strict()),
		async (args): Promise<CallToolResult> => callTextTool("get_build_report", args)
	);
	server.registerTool(
		"delete_build_report",
		{
			title: "Delete Build Report",
			description: "Delete one retained Build Pipeline report by stable id; authored profiles and generated output are unchanged.",
			inputSchema: z.object({ id, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_build_report", args)
	);
	server.registerTool(
		"get_generate_options",
		readOnly("Get Generate Options", "Read the editor export options and defaults used by legacy active-scene generation."),
		async (): Promise<CallToolResult> => callTextTool("get_generate_options", {})
	);
	server.registerTool(
		"get_export_report",
		readOnly("Get Export Report", "Hash and report the active scene export directory, modification time, counts, bytes, extensions, and bounded artifact manifest."),
		async (): Promise<CallToolResult> => callTextTool("get_export_report", {})
	);
	server.registerTool(
		"export_active_scene",
		{
			title: "Export Active Scene",
			description: "Run the canonical active-scene export into public/scene and retain a structured report.",
			inputSchema: z.object({ optimize: z.boolean().optional() }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("export_active_scene", args)
	);
}

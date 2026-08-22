import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().min(0);
const id = z.string().min(1).max(128);
const name = z.string().min(1).max(128);
const path = z.string().min(1).max(1024);
const url = z
	.string()
	.url()
	.refine((value) => value.startsWith("http://") || value.startsWith("https://"), "URL must use HTTP or HTTPS");
const environment = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.max(128);
const labels = z.array(z.string().min(1).max(128)).max(64);
const pagination = { offset: z.number().int().min(0).max(8_192).optional(), limit: z.number().int().min(1).max(500).optional() };
const schemaId = z.string().regex(/^zvtts-[a-f0-9]{64}$/);
const bundleId = z.string().regex(/^zvpb-[a-f0-9]{64}$/);
const identity = { id: id.optional(), name: name.optional() };
const query = z
	.object({
		groupNames: z.array(z.string().min(1).max(128)).max(128).optional(),
		addresses: z.array(z.string().min(1).max(512)).max(2048).optional(),
		labels: labels.optional(),
		match: z.enum(["all", "any"]).optional(),
	})
	.strict();
const profile = z
	.object({
		id: id.optional(),
		name,
		localBuildPath: path,
		localLoadPath: path,
		remoteBuildPath: path,
		remoteLoadPath: url,
	})
	.strict();
const profileChanges = profile.partial().omit({ id: true }).strict();
const groupChanges = z
	.object({
		name: name.optional(),
		delivery: z.enum(["local", "remote"]).optional(),
		updateRestriction: z.enum(["static", "dynamic"]).optional(),
		bundleMode: z.enum(["pack-together", "pack-separately"]).optional(),
		buildPath: path.optional(),
		loadPath: z.string().min(1).max(2048).optional(),
		clearBuildPath: z.boolean().optional(),
		clearLoadPath: z.boolean().optional(),
	})
	.strict();
const filesystemTarget = z.object({ id, name, provider: z.literal("filesystem"), destinationPath: path, publicBaseUrl: url }).strict();
const httpTarget = z.object({ id, name, provider: z.literal("http"), baseUrl: url, publicBaseUrl: url, authorizationEnvironment: environment.optional() }).strict();
const s3Target = z
	.object({
		id,
		name,
		provider: z.literal("s3"),
		bucket: z.string().min(1).max(255),
		region: z.string().min(1).max(128),
		endpoint: url.optional(),
		keyPrefix: path,
		publicBaseUrl: url,
		accessKeyIdEnvironment: environment,
		secretAccessKeyEnvironment: environment,
		sessionTokenEnvironment: environment.optional(),
	})
	.strict();
const deploymentTarget = z.discriminatedUnion("provider", [filesystemTarget, httpTarget, s3Target]);
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const replaceAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const networkAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function readOnly(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict()) {
	return { title, description, inputSchema, annotations: readAnnotations };
}

export function registerAddressableTools(server: McpServer): void {
	server.registerTool(
		"list_addressable_groups",
		readOnly(
			"List Addressables",
			"Read the complete normalized version-2 Addressables configuration, exact revision, profiles, group schemas, addressed entries, settings, and deployment targets."
		),
		async () => callTextTool("list_addressable_groups")
	);
	server.registerTool(
		"validate_addressable_content",
		readOnly("Validate Addressable Content", "Hash and validate every source entry for one profile without writing a build.", z.object({ profileId: id.optional() }).strict()),
		async (args) => callTextTool("validate_addressable_content", args)
	);
	server.registerTool(
		"analyze_addressable_type_trees",
		readOnly(
			"Analyze Addressable TypeTrees",
			"Analyze bounded structured JSON entries for one profile without writing files. Returns exact net-saving evidence, the shared registry reference, and paginated portable bundle plans; malformed/non-JSON assets remain raw.",
			z.object({ profileId: id.optional(), ...pagination }).strict()
		),
		async (args) => callTextTool("analyze_addressable_type_trees", args)
	);
	server.registerTool(
		"set_addressable_settings",
		{
			title: "Set Addressable Settings",
			description:
				"Atomically update the active profile, remote-catalog switch/file, hash verification, request concurrency/timeout, or bounded runtime cache using an exact revision.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					activeProfileId: id.optional(),
					remoteCatalog: z.boolean().optional(),
					remoteCatalogFile: path.optional(),
					verifyHashes: z.boolean().optional(),
					extractTypeTrees: z.boolean().optional(),
					requestTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
					maxConcurrentRequests: z.number().int().min(1).max(32).optional(),
					cacheMaxBytes: z.number().int().min(0).max(2_147_483_648).optional(),
				})
				.strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("set_addressable_settings", args)
	);
	server.registerTool(
		"create_addressable_profile",
		{
			title: "Create Addressable Profile",
			description: "Create a profile with explicit local/remote build and load paths at an exact configuration revision.",
			inputSchema: profile.extend({ expectedRevision: exactRevision }).strict(),
			annotations: writeAnnotations,
		},
		async (args) => callTextTool("create_addressable_profile", args)
	);
	server.registerTool(
		"set_addressable_profile",
		{
			title: "Set Addressable Profile",
			description: "Atomically update one profile's local/remote build-load paths using an exact revision.",
			inputSchema: profileChanges.extend({ id, expectedRevision: exactRevision }).strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("set_addressable_profile", args)
	);
	server.registerTool(
		"delete_addressable_profile",
		{
			title: "Delete Addressable Profile",
			description: "Delete a non-final profile and select a deterministic fallback if it was active.",
			inputSchema: z.object({ id, expectedRevision: exactRevision }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args) => callTextTool("delete_addressable_profile", args)
	);
	server.registerTool(
		"create_addressable_group",
		{
			title: "Create Addressable Group",
			description: "Create a local or remote Addressable group with explicit content-update restriction, bundle mode, and optional custom build/load paths.",
			inputSchema: groupChanges.extend({ expectedRevision: exactRevision, id: id.optional(), name }).strict(),
			annotations: writeAnnotations,
		},
		async (args) => callTextTool("create_addressable_group", args)
	);
	server.registerTool(
		"set_addressable_group",
		{
			title: "Set Addressable Group",
			description: "Atomically update one group's delivery and content-update schema at an exact revision; local groups remain static.",
			inputSchema: groupChanges.extend({ id, expectedRevision: exactRevision }).strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("set_addressable_group", args)
	);
	server.registerTool(
		"delete_addressable_group",
		{
			title: "Delete Addressable Group",
			description: "Delete one group and all of its Addressable assignments using an exact revision.",
			inputSchema: z.object({ id, expectedRevision: exactRevision }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args) => callTextTool("delete_addressable_group", args)
	);
	server.registerTool(
		"assign_addressable_asset",
		{
			title: "Assign Addressable Asset",
			description: "Move one existing project file into a group and set its unique runtime address and labels using an exact revision.",
			inputSchema: z
				.object({ ...identity, expectedRevision: exactRevision, assetPath: path, address: z.string().min(1).max(512).optional(), labels: labels.optional() })
				.strict(),
			annotations: writeAnnotations,
		},
		async (args) => callTextTool("assign_addressable_asset", args)
	);
	server.registerTool(
		"set_addressable_asset",
		{
			title: "Set Addressable Asset",
			description: "Atomically update the unique address or complete labels of one assigned asset using an exact revision.",
			inputSchema: z
				.object({
					...identity,
					expectedRevision: exactRevision,
					assetPathOrAddress: z.string().min(1).max(1024),
					address: z.string().min(1).max(512).optional(),
					labels: labels.optional(),
				})
				.strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("set_addressable_asset", args)
	);
	server.registerTool(
		"remove_addressable_asset",
		{
			title: "Remove Addressable Asset",
			description: "Remove one file/address assignment from a group using an exact revision without deleting the source file.",
			inputSchema: z.object({ ...identity, expectedRevision: exactRevision, assetPathOrAddress: z.string().min(1).max(1024) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args) => callTextTool("remove_addressable_asset", args)
	);
	server.registerTool(
		"set_addressable_asset_labels",
		{
			title: "Set Addressable Labels",
			description: "Compatibility endpoint that replaces the complete labels of one assigned asset using an exact revision.",
			inputSchema: z.object({ ...identity, expectedRevision: exactRevision, assetPathOrAddress: z.string().min(1).max(1024), labels }).strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("set_addressable_asset_labels", args)
	);
	server.registerTool(
		"find_addressable_assets_by_labels",
		readOnly(
			"Find Addressables by Labels",
			"Find source entries carrying all or any requested labels.",
			z.object({ labels: labels.min(1), match: z.enum(["all", "any"]).optional() }).strict()
		),
		async (args) => callTextTool("find_addressable_assets_by_labels", args)
	);
	server.registerTool(
		"diff_addressable_catalogs",
		readOnly(
			"Diff Addressable Catalogs",
			"Compare two generated project-local catalogs by unique address, source group, SHA-256 hash, and labels.",
			z.object({ previousCatalogPath: path, nextCatalogPath: path }).strict()
		),
		async (args) => callTextTool("diff_addressable_catalogs", args)
	);
	server.registerTool(
		"build_addressable_catalog",
		{
			title: "Build Addressable Catalog",
			description: "Write one canonical version-2 catalog for inspection without copying or publishing content.",
			inputSchema: z.object({ expectedRevision: exactRevision, outputPath: path.optional(), profileId: id.optional() }).strict(),
			annotations: writeAnnotations,
		},
		async (args) => callTextTool("build_addressable_catalog", args)
	);
	server.registerTool(
		"set_addressable_deployment_target",
		{
			title: "Set Addressable Deployment Target",
			description:
				"Create or replace a filesystem, HTTP PUT, or S3-compatible deployment target. Only environment-variable names are persisted; secrets are never accepted or returned.",
			inputSchema: z.object({ expectedRevision: exactRevision, target: deploymentTarget, makeActive: z.boolean().optional() }).strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("set_addressable_deployment_target", args)
	);
	server.registerTool(
		"delete_addressable_deployment_target",
		{
			title: "Delete Addressable Deployment Target",
			description: "Delete one deployment target configuration without deleting remote content.",
			inputSchema: z.object({ id, expectedRevision: exactRevision }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args) => callTextTool("delete_addressable_deployment_target", args)
	);
	server.registerTool(
		"build_addressable_content",
		{
			title: "Build Addressable Content",
			description:
				"Atomically create a full or previous-state incremental content build with immutable SHA-256 assets, catalog/hash, content state, pointer preview, and detailed report.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					buildType: z.enum(["full", "update"]),
					profileId: id.optional(),
					outputPath: path.optional(),
					previousStatePath: path.optional(),
				})
				.strict(),
			annotations: writeAnnotations,
		},
		async (args) => callTextTool("build_addressable_content", args)
	);
	server.registerTool(
		"list_addressable_build_reports",
		readOnly("List Addressable Build Reports", "List up to 256 retained full/update build reports and exact artifact evidence."),
		async () => callTextTool("list_addressable_build_reports")
	);
	server.registerTool(
		"get_addressable_build_report",
		readOnly(
			"Get Addressable Build Report",
			"Read and validate one project-local Addressables build report and its artifact existence.",
			z.object({ reportPath: path }).strict()
		),
		async (args) => callTextTool("get_addressable_build_report", args)
	);
	server.registerTool(
		"get_addressable_type_tree_build",
		readOnly(
			"Get Addressable TypeTree Build",
			"Inspect the shared TypeTree registry reference, exact byte-saving summary, and a bounded page of portable bundles from one verified project-local build report.",
			z.object({ reportPath: path, ...pagination }).strict()
		),
		async (args) => callTextTool("get_addressable_type_tree_build", args)
	);
	server.registerTool(
		"get_addressable_type_tree_schema",
		readOnly(
			"Get Addressable TypeTree Schema",
			"Verify a built registry and return one schema's identity plus a bounded depth-first page of node paths and kinds.",
			z.object({ reportPath: path, schemaId, ...pagination }).strict()
		),
		async (args) => callTextTool("get_addressable_type_tree_schema", args)
	);
	server.registerTool(
		"validate_addressable_portable_bundle",
		readOnly(
			"Validate Addressable Portable Bundle",
			"Verify one built portable bundle against its report, catalog, shared registry, bundle identity, and every entry hash; returns a bounded page of entry evidence.",
			z.object({ reportPath: path, bundleId, ...pagination }).strict()
		),
		async (args) => callTextTool("validate_addressable_portable_bundle", args)
	);
	server.registerTool(
		"deploy_addressable_content",
		{
			title: "Deploy Addressable Content",
			description:
				"Publish one exact build to a configured target. Immutable files are uploaded and verified first; confirmPublish=true switches the remote catalog pointer last.",
			inputSchema: z.object({ reportPath: path, targetId: id.optional(), expectedCatalogHash: z.string().regex(/^[a-f0-9]{64}$/), confirmPublish: z.literal(true) }).strict(),
			annotations: networkAnnotations,
		},
		async (args) => callTextTool("deploy_addressable_content", args)
	);
	server.registerTool(
		"verify_addressable_deployment",
		{
			title: "Verify Addressable Deployment",
			description: "Fetch the publication pointer, catalog, and hash from a configured target and prove an exact build is currently addressable.",
			inputSchema: z.object({ targetId: id.optional(), pointerPath: path.optional(), expectedBuildId: id, expectedCatalogHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
			annotations: { ...readAnnotations, openWorldHint: true },
		},
		async (args) => callTextTool("verify_addressable_deployment", args)
	);
	server.registerTool(
		"list_addressable_deployment_receipts",
		readOnly("List Addressable Deployment Receipts", "List bounded local receipts for verified pointer-last Addressables publications."),
		async () => callTextTool("list_addressable_deployment_receipts")
	);
	server.registerTool(
		"reload_addressable_runtime",
		{
			title: "Reload Addressable Runtime",
			description: "Replace the editor-preview Addressables runtime from one exact configuration revision and profile.",
			inputSchema: z.object({ expectedRevision: exactRevision, profileId: id.optional() }).strict(),
			annotations: replaceAnnotations,
		},
		async (args) => callTextTool("reload_addressable_runtime", args)
	);
	server.registerTool(
		"get_addressable_runtime_status",
		readOnly("Get Addressable Runtime Status", "Read active build/profile identity, catalog state, in-flight requests, cache evidence, and last update error."),
		async () => callTextTool("get_addressable_runtime_status")
	);
	server.registerTool(
		"check_addressable_catalog_updates",
		{
			title: "Check Addressable Catalog Updates",
			description: "Fetch the configured remote publication pointer without changing the active runtime catalog.",
			inputSchema: z.object({}).strict(),
			annotations: { ...readAnnotations, openWorldHint: true },
		},
		async () => callTextTool("check_addressable_catalog_updates")
	);
	server.registerTool(
		"update_addressable_catalog",
		{
			title: "Update Addressable Catalog",
			description: "Fetch and SHA-256 verify the remote pointer, catalog, and hash before atomically replacing the runtime catalog.",
			inputSchema: z.object({}).strict(),
			annotations: { ...replaceAnnotations, openWorldHint: true },
		},
		async () => callTextTool("update_addressable_catalog")
	);
	server.registerTool(
		"get_addressable_download_size",
		readOnly("Get Addressable Download Size", "Calculate uncached bytes for bounded group/address/label selectors.", query),
		async (args) => callTextTool("get_addressable_download_size", args)
	);
	server.registerTool(
		"download_addressable_dependencies",
		{
			title: "Download Addressable Dependencies",
			description: "Prefetch selected assets with bounded concurrency, request deduplication, size checks, SHA-256 verification, and LRU caching.",
			inputSchema: query,
			annotations: { ...writeAnnotations, openWorldHint: true },
		},
		async (args) => callTextTool("download_addressable_dependencies", args)
	);
	server.registerTool(
		"clear_addressable_cache",
		{
			title: "Clear Addressable Cache",
			description: "Evict all or selected group/address/label entries from the transient runtime cache without changing authoring data.",
			inputSchema: query,
			annotations: destructiveAnnotations,
		},
		async (args) => callTextTool("clear_addressable_cache", args)
	);
}

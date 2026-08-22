import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const providerExecution = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const sha256 = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 fingerprint returned by the corresponding read or inspect tool.");
const providerId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
	.describe("Filename-safe provider id from list_generative_asset_providers.");
const jobId = z
	.string()
	.regex(/^generative-job-[a-f0-9]{24}$/)
	.describe("Retained job id returned by start_generative_asset_job or list_generative_asset_jobs.");
const candidateId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
	.describe("Exact validated candidate id returned by the retained succeeded job.");
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("Exact current retained job revision.");
const modality = z.enum(["image", "sprite", "material", "animation", "audio"]);
const classification = z.enum(["generative-ai", "procedural", "test-fixture"]);
const referenceRole = z.enum(["content", "style", "character", "motion", "audio-guide", "mask"]);
const materialMap = z.enum(["base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height", "emissive", "opacity"]);
const projectPath = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((segment) => !segment || segment === "." || segment === ".."), {
		message: "Path must be a project-relative POSIX path without empty, current-directory, or parent-directory segments.",
	});
const reference = z.object({ path: projectPath, role: referenceRole }).strict();
const parameterScalar = z.union([
	z
		.string()
		.max(1024)
		.refine((value) => !value.includes("\0")),
	z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
	z.boolean(),
]);
const parameterValue = z.union([parameterScalar, z.array(parameterScalar).min(1).max(64)]);
const parameters = z
	.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/), parameterValue)
	.refine((value) => Object.keys(value).length <= 32, "Generative parameters support at most 32 fields.")
	.refine((value) => JSON.stringify(value).length <= 32_768, "Generative parameters must serialize to at most 32 KiB.");

const imageOptions = z
	.object({
		modality: z.literal("image"),
		value: z.object({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096), transparent: z.boolean() }).strict(),
	})
	.strict();
const spriteOptions = z
	.object({
		modality: z.literal("sprite"),
		value: z
			.object({
				width: z.number().int().min(64).max(4096),
				height: z.number().int().min(64).max(4096),
				transparent: z.boolean(),
				removeBackground: z.boolean(),
				pixelsPerUnit: z.number().finite().min(0.001).max(1_000_000),
				spritesheet: z
					.object({ columns: z.number().int().min(1).max(16), rows: z.number().int().min(1).max(16), framesPerSecond: z.number().finite().min(1).max(120) })
					.strict()
					.refine((value) => value.columns * value.rows <= 256, "Sprite sheets contain at most 256 cells.")
					.nullable(),
			})
			.strict(),
	})
	.strict();
const materialOptions = z
	.object({
		modality: z.literal("material"),
		value: z
			.object({
				resolution: z.number().int().min(64).max(4096),
				tileable: z.boolean(),
				maps: z
					.array(materialMap)
					.min(1)
					.max(8)
					.refine((value) => new Set(value).size === value.length, "Material maps must be unique."),
			})
			.strict(),
	})
	.strict();
const animationOptions = z
	.object({
		modality: z.literal("animation"),
		value: z
			.object({
				durationSeconds: z.number().finite().min(0.1).max(300),
				framesPerSecond: z.number().finite().min(1).max(240),
				loop: z.boolean(),
				rig: z.enum(["none", "generic", "humanoid", "sprite"]),
			})
			.strict(),
	})
	.strict();
const audioOptions = z
	.object({
		modality: z.literal("audio"),
		value: z
			.object({
				durationSeconds: z.number().finite().min(0.1).max(600),
				sampleRate: z.number().int().min(8000).max(192000),
				channels: z.union([z.literal(1), z.literal(2)]),
				loop: z.boolean(),
			})
			.strict(),
	})
	.strict();
const request = z
	.object({
		version: z.literal(1),
		modality,
		prompt: z.string().trim().min(1).max(8192),
		negativePrompt: z.string().trim().min(1).max(8192).nullable(),
		style: z.string().trim().min(1).max(512).nullable(),
		seed: z.number().int().min(0).max(4_294_967_295).nullable(),
		count: z.number().int().min(1).max(4),
		references: z
			.array(reference)
			.max(8)
			.refine((value) => new Set(value.map((entry) => entry.path.toLowerCase())).size === value.length, "Reference paths must be unique."),
		parameters,
		options: z.discriminatedUnion("modality", [imageOptions, spriteOptions, materialOptions, animationOptions, audioOptions]),
	})
	.strict()
	.refine((value) => value.modality === value.options.modality, "request.modality must match request.options.modality.");

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const executableTransport = z
	.object({
		kind: z.literal("executable"),
		executable: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/),
		args: z
			.array(
				z
					.string()
					.min(1)
					.max(1024)
					.regex(/^[^\0\r\n]+$/)
			)
			.max(64),
		credentialEnvironments: z.array(environmentName).max(32),
	})
	.strict();
const headerName = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/)
	.refine((value) => !/authorization|cookie|token|secret|password|key/i.test(value), "Credentials must use authorizationEnvironment, not static headers.");
const httpTransport = z
	.object({
		kind: z.literal("http"),
		endpoint: z
			.url()
			.max(2048)
			.refine((value) => {
				const url = new URL(value);
				const loopback = url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127.");
				return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.password && !url.search && !url.hash;
			}, "Endpoint must use HTTPS or loopback HTTP and contain no credentials, query, or fragment."),
		authorizationEnvironment: environmentName.nullable(),
		headers: z
			.record(
				headerName,
				z
					.string()
					.max(1024)
					.regex(/^[^\0\r\n]*$/)
			)
			.refine((value) => Object.keys(value).length <= 16, "At most 16 static headers are supported."),
	})
	.strict();
const providerManifest = z
	.object({
		version: z.literal(1),
		id: providerId,
		name: z.string().trim().min(1).max(128),
		vendor: z.string().trim().min(1).max(128),
		classification,
		modalities: z
			.array(modality)
			.min(1)
			.max(5)
			.refine((value) => new Set(value).size === value.length, "Provider modalities must be unique."),
		hostPlatforms: z
			.array(z.enum(["darwin", "win32", "linux"]))
			.max(3)
			.refine((value) => new Set(value).size === value.length, "Host platforms must be unique."),
		maximumOutputBytes: z
			.number()
			.int()
			.min(1024 * 1024)
			.max(512 * 1024 * 1024),
		maximumDurationSeconds: z.number().int().min(1).max(1800),
		transport: z.discriminatedUnion("kind", [executableTransport, httpTransport]),
	})
	.strict();

const publicationDestination = z
	.string()
	.trim()
	.min(6)
	.max(1024)
	.refine((value) => {
		const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
		const segments = normalized.split("/");
		return (
			!value.includes("\\") &&
			!value.includes("\0") &&
			!value.startsWith("/") &&
			segments[0] === "assets" &&
			!segments.some((segment) => !segment || segment === "." || segment === "..")
		);
	}, "destinationDirectory must be a project-relative POSIX path under assets/.");
const baseName = z
	.string()
	.max(128)
	.regex(/^[^\\/\0\r\n]+$/)
	.describe("Portable base filename; unsafe characters are normalized by the Editor.");
const publicationLease = {
	jobId,
	expectedRevision: revision,
	expectedResultFingerprint: sha256,
	candidateId,
	destinationDirectory: publicationDestination.optional(),
	baseName: baseName.optional(),
	overwrite: z.boolean().optional(),
};

/** Registers the complete provider, generation-job, preview, and transactional asset-publication lifecycle. */
export function registerGenerativeAssetTools(server: McpServer): void {
	server.registerTool(
		"get_generative_asset_capabilities",
		{
			title: "Get generative asset capabilities",
			description:
				"Read the editor-native image, sprite, PBR material, animation, and audio generation contract; provider classifications and transports; queue, staging, preview, publication, provenance, and safety limits.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_generative_asset_capabilities", {})
	);

	server.registerTool(
		"list_generative_asset_providers",
		{
			title: "List generative asset providers",
			description:
				"Read bounded project provider manifests, exact inventory/provider SHA-256 fingerprints, declared modalities, AI/procedural/fixture classification, host/executable/credential-name readiness, and isolated validation errors. Credential values are never returned.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_generative_asset_providers", {})
	);

	server.registerTool(
		"set_generative_asset_provider",
		{
			title: "Set generative asset provider",
			description:
				"Create or exact-fingerprint replace one closed project provider manifest. Only environment-variable names may identify credentials; values are never accepted or persisted. Re-read the inventory after any concurrent change.",
			inputSchema: z.object({ expectedInventoryFingerprint: sha256, expectedProviderFingerprint: sha256.optional(), provider: providerManifest }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_generative_asset_provider", args)
	);

	server.registerTool(
		"delete_generative_asset_provider",
		{
			title: "Delete generative asset provider",
			description:
				"After confirm=true, remove one exact project provider manifest under current inventory and provider fingerprints. Existing retained jobs and published assets are preserved.",
			inputSchema: z.object({ id: providerId, expectedInventoryFingerprint: sha256, expectedProviderFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_generative_asset_provider", args)
	);

	server.registerTool(
		"start_generative_asset_job",
		{
			title: "Start generative asset job",
			description:
				"After confirm=true, resolve and SHA-256 lease project references, then queue one bounded request against the exact available executable or HTTP provider fingerprint. Provider execution can contact an external service; output remains private until strict validation and explicit publication.",
			inputSchema: z.object({ providerId, expectedProviderFingerprint: sha256, request, confirm: z.literal(true) }).strict(),
			annotations: providerExecution,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_generative_asset_job", args)
	);

	server.registerTool(
		"list_generative_asset_jobs",
		{
			title: "List generative asset jobs",
			description:
				"Read a stable bounded page of retained project jobs with exact revisions, requests, reference/result fingerprints, status/progress, validated candidates, diagnostics, publication history, and isolated retained-state load errors without returning artifact bytes.",
			inputSchema: z
				.object({
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					status: z.enum(["queued", "running", "canceling", "succeeded", "failed", "canceled", "timed-out"]).optional(),
					providerId: providerId.optional(),
					modality: modality.optional(),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_generative_asset_jobs", args)
	);

	server.registerTool(
		"get_generative_asset_job",
		{
			title: "Get generative asset job",
			description:
				"Read one exact retained generation job, including request/reference/result evidence, validated candidates, execution diagnostics, and normal-asset publication history.",
			inputSchema: z.object({ jobId }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_generative_asset_job", args)
	);

	server.registerTool(
		"cancel_generative_asset_job",
		{
			title: "Cancel generative asset job",
			description:
				"After confirm=true and under the exact job revision, cancel a queued request or cooperatively abort its active process/HTTP provider. Canceled staged output is never accepted or published.",
			inputSchema: z.object({ jobId, expectedRevision: revision, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_generative_asset_job", args)
	);

	server.registerTool(
		"retry_generative_asset_job",
		{
			title: "Retry generative asset job",
			description:
				"After confirm=true, create a new attempt from one terminal retained job under its exact revision and the provider's current exact fingerprint. The provider may execute code or contact an external endpoint again.",
			inputSchema: z.object({ jobId, expectedRevision: revision, expectedProviderFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: providerExecution,
		},
		async (args): Promise<CallToolResult> => callTextTool("retry_generative_asset_job", args)
	);

	server.registerTool(
		"get_generative_asset_preview",
		{
			title: "Get generative asset preview",
			description:
				"Return one bounded base64 visual/audio preview only after exact succeeded-result and candidate validation. The private staging path is never exposed; previews larger than maximumBytes return explicit unavailable evidence.",
			inputSchema: z
				.object({
					jobId,
					expectedResultFingerprint: sha256,
					candidateId,
					maximumBytes: z
						.number()
						.int()
						.min(1)
						.max(8 * 1024 * 1024)
						.optional(),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_generative_asset_preview", args)
	);

	server.registerTool(
		"inspect_generative_asset_publication",
		{
			title: "Inspect generative asset publication",
			description:
				"Revalidate the exact succeeded job, provider, references, staged artifacts, destinations, metadata, and importer intent; return an immutable collision-safe SHA-256 publication plan without changing project assets.",
			inputSchema: z.object(publicationLease).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_generative_asset_publication", args)
	);

	server.registerTool(
		"publish_generative_asset_candidate",
		{
			title: "Publish generative asset candidate",
			description:
				"After confirm=true, apply one exact publication-plan fingerprint transactionally through normal texture, sprite, PBR material, animation, audio, and video asset importers. Asset files, metadata, importer caches, GUIDs, and retained provenance commit or roll back together.",
			inputSchema: z.object({ ...publicationLease, expectedPlanFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("publish_generative_asset_candidate", args)
	);

	server.registerTool(
		"delete_generative_asset_job",
		{
			title: "Delete generative asset job",
			description:
				"After confirm=true and under the exact terminal job revision, delete only its private retained staging and evidence. Normally published project assets and their provenance remain untouched.",
			inputSchema: z.object({ jobId, expectedRevision: revision, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_generative_asset_job", args)
	);
}

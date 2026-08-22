import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const execution = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const finiteValue = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const parameters = z.record(id, finiteValue).refine((value) => Object.keys(value).length <= 64, "At most 64 numeric environment parameters are supported.");

const observation = z
	.object({
		name: id,
		size: z.number().int().min(1).max(4096),
		stacking: z.number().int().min(1).max(64),
		normalization: z.object({ minimum: finiteValue, maximum: finiteValue }).strict().nullable(),
	})
	.strict()
	.refine((value) => value.normalization === null || value.normalization.maximum > value.normalization.minimum, "Observation normalization maximum must exceed minimum.");
const actions = z
	.object({ continuousSize: z.number().int().min(0).max(256), discreteBranches: z.array(z.number().int().min(2).max(256)).max(32) })
	.strict()
	.refine((value) => value.continuousSize > 0 || value.discreteBranches.length > 0, "At least one action is required.");
const behavior = z
	.object({
		id,
		name: z.string().trim().min(1).max(128),
		agentNodeIds: z.array(id).max(1024),
		behaviorGraphId: id.nullable(),
		observations: z.array(observation).min(1).max(64),
		actions,
		decisionPeriod: z.number().int().min(1).max(1024),
		maxEpisodeSteps: z.number().int().min(1).max(10_000_000),
		inferenceModelPath: z
			.string()
			.max(1024)
			.regex(/^assets\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\0]+\.(?:onnx|tflite|pt2)$/i)
			.nullable(),
	})
	.strict();
const lesson = z.object({ id, name: z.string().trim().min(1).max(128), minimumMeanReward: finiteValue.nullable(), parameters }).strict();
const configurationReplacement = z
	.object({ enabled: z.boolean(), timeScale: z.number().finite().min(0.01).max(100), behaviors: z.array(behavior).max(128), curriculum: z.array(lesson).max(64) })
	.strict();
const step = z
	.object({
		observations: z.array(z.number().finite()).min(1).max(65536),
		continuousActions: z.array(z.number().finite().min(-1).max(1)).max(256),
		discreteActions: z.array(z.number().int().min(0).max(255)).max(32),
		reward: z.number().finite().min(-1_000_000).max(1_000_000),
		done: z.boolean(),
		interrupted: z.boolean(),
	})
	.strict();
const episode = z
	.object({ id, behaviorId: id, agentId: id, lessonId: id.nullable(), parameters, steps: z.array(step).min(1).max(10_000_000) })
	.strict()
	.refine((value) => value.steps.at(-1)?.done === true && value.steps.slice(0, -1).every((entry) => !entry.done), "Only the final episode step must set done=true.");
const algorithm = z.enum(["behavior-cloning", "ppo", "sac", "imitation", "external"]);
const settings = z
	.object({
		algorithm,
		seed: z.number().int().min(0).max(0x7fffffff).optional(),
		maxSteps: z.number().int().min(1).max(1_000_000_000).optional(),
		batchSize: z.number().int().min(1).max(65536).optional(),
		bufferSize: z.number().int().min(1).max(10_000_000).optional(),
		learningRate: z.number().finite().min(0.000000001).max(1).optional(),
		gamma: z.number().finite().min(0).max(1).optional(),
		gaeLambda: z.number().finite().min(0).max(1).optional(),
		entropy: z.number().finite().min(0).max(100).optional(),
		epochs: z.number().int().min(1).max(1000).optional(),
		checkpointInterval: z.number().int().min(1).max(1_000_000_000).optional(),
	})
	.strict();
const providerManifest = z
	.object({
		version: z.literal(1),
		id,
		name: z.string().trim().min(1).max(128),
		algorithms: z
			.array(z.enum(["ppo", "sac", "imitation", "external"]))
			.min(1)
			.max(4),
		executable: z
			.string()
			.trim()
			.min(1)
			.max(1024)
			.regex(/^[^\0\r\n]+$/),
		args: z
			.array(
				z
					.string()
					.max(1024)
					.regex(/^[^\0\r\n]*$/)
			)
			.max(32),
		credentialEnvironments: z.array(environmentName).max(32),
		maximumDurationSeconds: z.number().int().min(1).max(86400),
	})
	.strict();
const jobId = z.string().regex(/^ml-training-job-[a-f0-9]{24}$/);
const jobLease = { jobId, expectedRevision: revision };
const publicationPath = z
	.string()
	.trim()
	.min(13)
	.max(1024)
	.regex(/^assets\/(?!.*\\)[^\0]+\.onnx$/i)
	.refine((value) => !value.split("/").some((segment) => !segment || segment === "." || segment === ".."), "Path segments must be canonical and contained.");
const publicationLease = { ...jobLease, expectedResultFingerprint: sha256, path: publicationPath, overwrite: z.boolean() };

/** Registers Agent authoring, demonstrations, trainer orchestration, metrics, and exact Runtime AI checkpoint publication. */
export function registerMlTrainingTools(server: McpServer): void {
	server.registerTool(
		"get_ml_training_capabilities",
		{
			title: "Get ML training capabilities",
			description:
				"Read the portable Agent observation/action/reward/episode bridge, curriculum, recorded demonstrations, built-in real behavior-cloning ONNX trainer, external PPO/SAC/imitation executable adapters, job limits, metrics, checkpoint publication, and explicit Unity ML-Agents non-claims.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_ml_training_capabilities", {})
	);
	server.registerTool(
		"get_ml_training_configuration",
		{
			title: "Get ML training configuration",
			description:
				"Read exact-revision scene Agent behaviors, observation/action spaces, node and Behavior Graph links, curriculum, inference-model links, and live exported-runtime Agent state.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_ml_training_configuration", {})
	);
	server.registerTool(
		"set_ml_training_configuration",
		{
			title: "Set ML training configuration",
			description:
				"Atomically replace scene Agent behaviors and curriculum under the exact configuration revision after validating every scene-node and optional Behavior Graph link.",
			inputSchema: z.object({ expectedRevision: revision, configuration: configurationReplacement }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_ml_training_configuration", args)
	);
	server.registerTool(
		"list_ml_training_providers",
		{
			title: "List ML training providers",
			description:
				"List the built-in behavior-cloning trainer and bounded project executable providers with exact fingerprints, algorithms, availability, warnings, and credential environment-variable names but never values.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("list_ml_training_providers", {})
	);
	server.registerTool(
		"set_ml_training_provider",
		{
			title: "Set ML training provider",
			description:
				"Create or exact-fingerprint replace one shell-free executable PPO, SAC, imitation, or external trainer manifest; credentials remain environment-name-only.",
			inputSchema: z.object({ provider: providerManifest, expectedFingerprint: sha256.optional() }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_ml_training_provider", args)
	);
	server.registerTool(
		"delete_ml_training_provider",
		{
			title: "Delete ML training provider",
			description: "After confirm=true, delete one inactive external trainer under its exact fingerprint; the built-in trainer and retained jobs are unaffected.",
			inputSchema: z.object({ id, expectedFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: destructive,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_ml_training_provider", args)
	);
	server.registerTool(
		"record_ml_training_episode",
		{
			title: "Record ML training episode",
			description:
				"Append one exact, fully shape-checked demonstration episode with observations, continuous/discrete actions, rewards, lesson parameters, and a required final episode boundary.",
			inputSchema: z.object({ expectedConfigurationRevision: revision, episode }).strict(),
			annotations: mutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("record_ml_training_episode", args)
	);
	server.registerTool(
		"list_ml_training_episodes",
		{
			title: "List ML training episodes",
			description: "Read a bounded summary page and exact dataset SHA-256 for one authored behavior without returning every observation/action value.",
			inputSchema: z.object({ behaviorId: id, offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_ml_training_episodes", args)
	);
	server.registerTool(
		"get_ml_training_episode",
		{
			title: "Get ML training episode",
			description: "Read an exact dataset-leased episode with independently bounded step paging.",
			inputSchema: z
				.object({
					behaviorId: id,
					episodeId: id,
					expectedDatasetFingerprint: sha256,
					stepOffset: z.number().int().min(0).max(10_000_000).optional(),
					stepLimit: z.number().int().min(1).max(1000).optional(),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_ml_training_episode", args)
	);
	server.registerTool(
		"clear_ml_training_dataset",
		{
			title: "Clear ML training dataset",
			description: "After confirm=true, remove all demonstrations for one behavior under the exact dataset fingerprint without affecting jobs or published models.",
			inputSchema: z.object({ behaviorId: id, expectedDatasetFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: destructive,
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_ml_training_dataset", args)
	);
	server.registerTool(
		"start_ml_training_job",
		{
			title: "Start ML training job",
			description:
				"After confirm=true, snapshot exact scene/provider/dataset leases and run the built-in real ONNX trainer or a shell-free external trainer inside bounded private staging.",
			inputSchema: z
				.object({
					behaviorId: id,
					expectedConfigurationRevision: revision,
					providerId: id,
					expectedProviderFingerprint: sha256,
					expectedDatasetFingerprint: sha256,
					settings,
					confirm: z.literal(true),
				})
				.strict(),
			annotations: execution,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_ml_training_job", args)
	);
	server.registerTool(
		"list_ml_training_jobs",
		{
			title: "List ML training jobs",
			description: "Read a stable bounded page of retained training jobs, metrics summaries, checkpoint evidence, progress, errors, and publication history.",
			inputSchema: z
				.object({
					status: z.enum(["queued", "running", "canceling", "succeeded", "failed", "canceled", "timed-out"]).optional(),
					behaviorId: id.optional(),
					offset: z.number().int().min(0).max(1_000_000).optional(),
					limit: z.number().int().min(1).max(100).optional(),
				})
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_ml_training_jobs", args)
	);
	server.registerTool(
		"get_ml_training_job",
		{
			title: "Get ML training job",
			description:
				"Read one retained job's exact revision, immutable dataset/provider/settings snapshot, bounded metrics, checkpoint hash, diagnostics, and publication history.",
			inputSchema: z.object({ jobId }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_ml_training_job", args)
	);
	server.registerTool(
		"cancel_ml_training_job",
		{
			title: "Cancel ML training job",
			description: "After confirm=true, cancel a queued job or cooperatively terminate its active trainer under the exact job revision; late output is rejected.",
			inputSchema: z.object({ ...jobLease, confirm: z.literal(true) }).strict(),
			annotations: destructive,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_ml_training_job", args)
	);
	server.registerTool(
		"retry_ml_training_job",
		{
			title: "Retry ML training job",
			description: "Create a new attempt from one terminal job's trainer settings while requiring fresh exact scene, provider, and dataset leases.",
			inputSchema: z
				.object({ ...jobLease, expectedConfigurationRevision: revision, expectedProviderFingerprint: sha256, expectedDatasetFingerprint: sha256, confirm: z.literal(true) })
				.strict(),
			annotations: execution,
		},
		async (args): Promise<CallToolResult> => callTextTool("retry_ml_training_job", args)
	);
	server.registerTool(
		"inspect_ml_training_checkpoint_publication",
		{
			title: "Inspect ML checkpoint publication",
			description: "Compute an exact non-mutating publication plan for one succeeded ONNX checkpoint, including destination and existing-content evidence.",
			inputSchema: z.object(publicationLease).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_ml_training_checkpoint_publication", args)
	);
	server.registerTool(
		"publish_ml_training_checkpoint",
		{
			title: "Publish ML checkpoint",
			description:
				"After confirm=true, transactionally publish one exact current ONNX plan with normal AI Model importer metadata, provenance, registry refresh, and real Runtime AI compilation verification.",
			inputSchema: z.object({ ...publicationLease, expectedPlanFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: destructive,
		},
		async (args): Promise<CallToolResult> => callTextTool("publish_ml_training_checkpoint", args)
	);
	server.registerTool(
		"delete_ml_training_job",
		{
			title: "Delete ML training job",
			description: "After confirm=true, delete one idle terminal private job directory under its exact revision; published Runtime AI models remain untouched.",
			inputSchema: z.object({ ...jobLease, confirm: z.literal(true) }).strict(),
			annotations: destructive,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_ml_training_job", args)
	);
}

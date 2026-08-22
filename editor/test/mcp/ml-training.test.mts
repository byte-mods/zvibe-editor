import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";
import { trainPortableBehaviorCloning } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../src/project/configuration";
import {
	clearMlTrainingDataset,
	getMlTrainingCapabilities,
	getMlTrainingJob,
	inspectMlTrainingCheckpointPublication,
	listMlTrainingEpisodes,
	listMlTrainingProviders,
	publishMlTrainingCheckpoint,
	recordMlTrainingEpisode,
	setMlTrainingConfiguration,
	setMlTrainingProvider,
	shutdownMlTraining,
	startMlTrainingJob,
} from "../../src/mcp/ai/ml-training";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; scene: Scene; options: any }> {
	const root = await mkdtemp(join(tmpdir(), "zvibe-ml-training-"));
	roots.push(root);
	await writeFile(join(root, "project.bjseditor"), "{}\n");
	projectConfiguration.path = join(root, "project.bjseditor");
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const agent = new TransformNode("Agent", scene);
	agent.id = "agent-node";
	const editor: any = {
		sceneWorkspace: {},
		layout: {
			inspector: { forceUpdate: () => undefined },
			assets: { refresh: async () => undefined },
		},
	};
	return { root, scene, options: { editor } };
}

afterEach(async () => {
	projectConfiguration.path = null;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ML training editor owner", () => {
	test("authors one exact behavior, records a bounded episode, trains ONNX, and transactionally publishes to Runtime AI", async () => {
		const { root, scene, options } = await fixture();
		const configured: any = setMlTrainingConfiguration(
			scene,
			{
				expectedRevision: 1,
				configuration: {
					enabled: true,
					timeScale: 2,
					behaviors: [
						{
							id: "walker",
							name: "Walker",
							agentNodeIds: ["agent-node"],
							behaviorGraphId: null,
							observations: [{ name: "state", size: 2, stacking: 1, normalization: null }],
							actions: { continuousSize: 1, discreteBranches: [2] },
							decisionPeriod: 1,
							maxEpisodeSteps: 16,
							inferenceModelPath: null,
						},
					],
					curriculum: [{ id: "start", name: "Start", minimumMeanReward: null, parameters: { distance: 1 } }],
				},
			},
			options
		);
		expect(configured.configuration.revision).toBe(2);
		expect((getMlTrainingCapabilities(scene, {}, options) as any).features.builtInBehaviorCloning).toBe(true);
		const recorded: any = await recordMlTrainingEpisode(
			scene,
			{
				expectedConfigurationRevision: 2,
				episode: {
					id: "episode-1",
					behaviorId: "walker",
					agentId: "agent-1",
					lessonId: "start",
					parameters: { distance: 1 },
					steps: [
						{ observations: [0, 0], continuousActions: [0], discreteActions: [0], reward: 0, done: false, interrupted: false },
						{ observations: [1, 1], continuousActions: [1], discreteActions: [1], reward: 1, done: true, interrupted: false },
					],
				},
			},
			options
		);
		const listed: any = await listMlTrainingEpisodes(scene, { behaviorId: "walker", offset: 0, limit: 20 }, options);
		expect(listed.totalSteps).toBe(2);
		const providers: any = await listMlTrainingProviders(scene, {}, options);
		const provider = providers.providers[0];
		const started = await startMlTrainingJob(
			scene,
			{
				behaviorId: "walker",
				expectedConfigurationRevision: 2,
				providerId: provider.id,
				expectedProviderFingerprint: provider.fingerprint,
				expectedDatasetFingerprint: recorded.datasetFingerprint,
				settings: { algorithm: "behavior-cloning", epochs: 4, learningRate: 0.01 },
				confirm: true,
			},
			options
		);
		let job = started;
		for (let index = 0; index < 100 && !["succeeded", "failed"].includes(job.status); index++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			job = await getMlTrainingJob(scene, { jobId: job.id }, options);
		}
		expect(job.status, job.error ?? "").toBe("succeeded");
		expect(job.result?.metrics).toHaveLength(4);
		const plan: any = await inspectMlTrainingCheckpointPublication(
			scene,
			{ jobId: job.id, expectedRevision: job.revision, expectedResultFingerprint: job.resultFingerprint, path: "assets/models/walker.onnx", overwrite: false },
			options
		);
		await expect(
			publishMlTrainingCheckpoint(
				scene,
				{
					jobId: job.id,
					expectedRevision: job.revision,
					expectedResultFingerprint: job.resultFingerprint,
					path: "assets/models/walker.onnx",
					overwrite: false,
					expectedPlanFingerprint: "0".repeat(64),
					confirm: true,
				},
				options
			)
		).rejects.toThrow(/plan changed/);
		const published: any = await publishMlTrainingCheckpoint(
			scene,
			{
				jobId: job.id,
				expectedRevision: job.revision,
				expectedResultFingerprint: job.resultFingerprint,
				path: "assets/models/walker.onnx",
				overwrite: false,
				expectedPlanFingerprint: plan.planFingerprint,
				confirm: true,
			},
			options
		);
		expect(published.runtimeAi.description.inputs[0].name).toBe("observations");
		expect(await readFile(join(root, "assets/models/walker.onnx"))).toBeTruthy();
		expect(await readFile(join(root, "assets/models/walker.onnx.ml-training.json"))).toBeTruthy();
		const cleared: any = await clearMlTrainingDataset(scene, { behaviorId: "walker", expectedDatasetFingerprint: recorded.datasetFingerprint, confirm: true }, options);
		expect(cleared.removedEpisodes).toBe(1);
		await shutdownMlTraining(options.editor);
		scene.getEngine().dispose();
	});

	test("executes a shell-free external trainer and validates its exact ONNX policy shape", async () => {
		const { root, scene, options } = await fixture();
		const behavior = {
			id: "external-behavior",
			name: "External Behavior",
			agentNodeIds: ["agent-node"],
			behaviorGraphId: null,
			observations: [{ name: "state", size: 2, stacking: 1, normalization: null }],
			actions: { continuousSize: 1, discreteBranches: [2] },
			decisionPeriod: 1,
			maxEpisodeSteps: 16,
			inferenceModelPath: null,
		} as const;
		setMlTrainingConfiguration(scene, { expectedRevision: 1, configuration: { enabled: true, timeScale: 1, behaviors: [behavior], curriculum: [] } }, options);
		const episode = {
			id: "external-episode",
			behaviorId: behavior.id,
			agentId: "agent-1",
			lessonId: null,
			parameters: {},
			steps: [{ observations: [1, 0], continuousActions: [0.5], discreteActions: [1], reward: 1, done: true, interrupted: false }],
		};
		const recorded: any = await recordMlTrainingEpisode(scene, { expectedConfigurationRevision: 2, episode }, options);
		const model = trainPortableBehaviorCloning(
			{ contract: "zvibe-ml-training-v1", version: 1, behavior, episodes: [episode] },
			{ algorithm: "behavior-cloning", epochs: 1 }
		).model;
		const scriptPath = join(root, "external-trainer.mjs");
		await writeFile(
			scriptPath,
			`import { writeFileSync } from "node:fs";\nlet input=""; for await (const chunk of process.stdin) input += chunk; const request=JSON.parse(input); writeFileSync(request.outputDirectory + "/policy.onnx", Buffer.from("${Buffer.from(model).toString("base64")}", "base64")); process.stdout.write(JSON.stringify({ modelPath:"policy.onnx", inputName:"observations", outputName:"actions", metrics:[{step:1,epoch:1,loss:0.25,meanReward:1}] }));\n`
		);
		const providerResult: any = await setMlTrainingProvider(
			scene,
			{
				provider: {
					version: 1,
					id: "external-ppo",
					name: "External PPO",
					algorithms: ["ppo"],
					executable: process.execPath,
					args: [scriptPath],
					credentialEnvironments: [],
					maximumDurationSeconds: 30,
				},
			},
			options
		);
		let job = await startMlTrainingJob(
			scene,
			{
				behaviorId: behavior.id,
				expectedConfigurationRevision: 2,
				providerId: providerResult.provider.id,
				expectedProviderFingerprint: providerResult.provider.fingerprint,
				expectedDatasetFingerprint: recorded.datasetFingerprint,
				settings: { algorithm: "ppo", epochs: 1 },
				confirm: true,
			},
			options
		);
		for (let index = 0; index < 100 && !["succeeded", "failed"].includes(job.status); index++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			job = await getMlTrainingJob(scene, { jobId: job.id }, options);
		}
		expect(job.status, job.error ?? "").toBe("succeeded");
		expect(job.provider.builtIn).toBe(false);
		expect(job.result?.metrics[0]).toMatchObject({ loss: 0.25, meanReward: 1 });
		await shutdownMlTraining(options.editor);
		scene.getEngine().dispose();
	});
});

import { describe, expect, test } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import {
	configureMlTrainingRuntime,
	getMlTrainingRuntime,
	IMlTrainingBehavior,
	normalizeMlTrainingConfiguration,
	normalizeMlTrainingEpisode,
	trainPortableBehaviorCloning,
} from "../../src/ai/ml-training";
import { inspectRuntimeAiModelGraph } from "../../src/loading/runtime-ai-model";

const behavior: IMlTrainingBehavior = {
	id: "walker",
	name: "Walker",
	agentNodeIds: ["walker-node"],
	behaviorGraphId: null,
	observations: [{ name: "state", size: 2, stacking: 1, normalization: null }],
	actions: { continuousSize: 1, discreteBranches: [2] },
	decisionPeriod: 1,
	maxEpisodeSteps: 8,
	inferenceModelPath: null,
};

describe("portable ML training", () => {
	test("normalizes bounded behavior, curriculum, and exact episode shapes", () => {
		const configuration = normalizeMlTrainingConfiguration({
			version: 1,
			revision: 3,
			enabled: true,
			timeScale: 4,
			behaviors: [behavior],
			curriculum: [{ id: "lesson-1", name: "Start", minimumMeanReward: null, parameters: { distance: 2 } }],
		});
		expect(configuration.behaviors[0].id).toBe("walker");
		expect(
			normalizeMlTrainingEpisode(
				{
					id: "episode-1",
					behaviorId: "walker",
					agentId: "agent-1",
					lessonId: "lesson-1",
					parameters: { distance: 2 },
					steps: [{ observations: [0, 1], continuousActions: [0.5], discreteActions: [1], reward: 1, done: true, interrupted: false }],
				},
				behavior
			).steps
		).toHaveLength(1);
		expect(() => normalizeMlTrainingConfiguration({ ...configuration, unknown: true })).toThrow(/unsupported fields/);
		expect(() =>
			normalizeMlTrainingEpisode(
				{
					id: "bad",
					behaviorId: "walker",
					agentId: "agent-1",
					steps: [{ observations: [0], continuousActions: [0], discreteActions: [0], reward: 0, done: true }],
				},
				behavior
			)
		).toThrow(/exactly 2/);
	});

	test("trains a real bounded ONNX policy and exposes the exported Agent bridge", () => {
		const episode = {
			id: "episode-1",
			behaviorId: "walker",
			agentId: "agent-1",
			lessonId: null,
			parameters: {},
			steps: [
				{ observations: [0, 0], continuousActions: [0], discreteActions: [0], reward: 0, done: false, interrupted: false },
				{ observations: [1, 1], continuousActions: [1], discreteActions: [1], reward: 1, done: true, interrupted: false },
			],
		};
		const trained = trainPortableBehaviorCloning(
			{ contract: "zvibe-ml-training-v1", version: 1, behavior, episodes: [episode] },
			{ algorithm: "behavior-cloning", epochs: 4, learningRate: 0.01 }
		);
		expect(trained.metrics).toHaveLength(4);
		expect(trained.model.byteLength).toBeGreaterThan(100);
		const graph = inspectRuntimeAiModelGraph("onnx", trained.model);
		expect(graph.inputs).toEqual(["observations"]);
		expect(graph.outputs).toEqual(["actions"]);

		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = { babylonEditorMlTraining: { version: 1, revision: 1, enabled: true, timeScale: 1, behaviors: [behavior], curriculum: [] } };
		const runtime = configureMlTrainingRuntime(scene);
		runtime.setDecisionHandler(() => ({ continuousActions: [0.25], discreteActions: [1] }));
		expect(runtime.requestDecision("walker", "agent-1", [0, 1])).toEqual({ continuousActions: [0.25], discreteActions: [1] });
		expect(runtime.addReward("agent-1", 2).cumulativeReward).toBe(2);
		expect(runtime.endEpisode("agent-1").ended).toBe(true);
		expect(getMlTrainingRuntime(scene)).toBe(runtime);
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});
});

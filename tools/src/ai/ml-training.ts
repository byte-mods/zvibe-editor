import type { onnx } from "onnx-proto";
import { onnxProto } from "../tools/onnx-proto";

import type { Scene } from "@babylonjs/core/scene";

export const ML_TRAINING_CONTRACT = "zvibe-ml-training-v1" as const;
export const ML_TRAINING_CONTRACT_VERSION = 1 as const;

export const mlTrainingAlgorithms = ["behavior-cloning", "ppo", "sac", "imitation", "external"] as const;
export type MlTrainingAlgorithm = (typeof mlTrainingAlgorithms)[number];

export interface IMlObservationSpec {
	name: string;
	size: number;
	stacking: number;
	normalization: { minimum: number; maximum: number } | null;
}

export interface IMlActionSpec {
	continuousSize: number;
	discreteBranches: number[];
}

export interface IMlTrainingBehavior {
	id: string;
	name: string;
	agentNodeIds: string[];
	behaviorGraphId: string | null;
	observations: IMlObservationSpec[];
	actions: IMlActionSpec;
	decisionPeriod: number;
	maxEpisodeSteps: number;
	inferenceModelPath: string | null;
}

export interface IMlCurriculumLesson {
	id: string;
	name: string;
	minimumMeanReward: number | null;
	parameters: Record<string, number>;
}

export interface IMlTrainingConfiguration {
	version: 1;
	revision: number;
	enabled: boolean;
	timeScale: number;
	behaviors: IMlTrainingBehavior[];
	curriculum: IMlCurriculumLesson[];
}

export interface IMlTrainingSettings {
	algorithm: MlTrainingAlgorithm;
	seed: number;
	maxSteps: number;
	batchSize: number;
	bufferSize: number;
	learningRate: number;
	gamma: number;
	gaeLambda: number;
	entropy: number;
	epochs: number;
	checkpointInterval: number;
}

export interface IMlTrainingStep {
	observations: number[];
	continuousActions: number[];
	discreteActions: number[];
	reward: number;
	done: boolean;
	interrupted: boolean;
}

export interface IMlTrainingEpisode {
	id: string;
	behaviorId: string;
	agentId: string;
	lessonId: string | null;
	parameters: Record<string, number>;
	steps: IMlTrainingStep[];
}

export interface IMlTrainingDataset {
	contract: typeof ML_TRAINING_CONTRACT;
	version: 1;
	behavior: IMlTrainingBehavior;
	episodes: IMlTrainingEpisode[];
}

export interface IMlTrainingMetric {
	step: number;
	epoch: number;
	loss: number;
	meanReward: number;
}

export interface IPortableMlTrainingResult {
	model: Uint8Array;
	modelFormat: "onnx";
	inputName: "observations";
	outputName: "actions";
	inputSize: number;
	outputSize: number;
	metrics: IMlTrainingMetric[];
	algorithm: "behavior-cloning";
	seed: number;
}

export interface IMlPolicyOnnxEvidence {
	inputName: string;
	outputName: string;
	inputSize: number;
	outputSize: number;
	operatorCount: number;
}

export interface IMlTrainingDecision {
	continuousActions: number[];
	discreteActions: number[];
}

export interface IMlTrainingAgentState {
	agentId: string;
	behaviorId: string;
	episode: number;
	step: number;
	cumulativeReward: number;
	ended: boolean;
	interrupted: boolean;
	lastObservation: number[];
	lastDecision: IMlTrainingDecision;
}

export type MlTrainingDecisionHandler = (behavior: IMlTrainingBehavior, agentId: string, observations: number[], state: Readonly<IMlTrainingAgentState>) => IMlTrainingDecision;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const assetPathPattern = /^assets\/(?!.*\\)[^\0]{1,1000}\.(?:onnx|tflite|pt2)$/i;

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function exact(source: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function string(value: unknown, label: string, maximum = 128): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain from 1 through ${maximum} characters.`);
	}
	return value;
}

function identifier(value: unknown, label: string): string {
	const result = string(value, label);
	if (!identifierPattern.test(result)) {
		throw new Error(`${label} is invalid.`);
	}
	return result;
}

function number(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be finite from ${minimum} through ${maximum}.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	const result = number(value, label, minimum, maximum);
	if (!Number.isSafeInteger(result)) {
		throw new Error(`${label} must be an integer.`);
	}
	return result;
}

function numericRecord(value: unknown, label: string, maximumEntries = 64): Record<string, number> {
	const source = value === undefined ? {} : object(value, label);
	if (Object.keys(source).length > maximumEntries) {
		throw new Error(`${label} contains more than ${maximumEntries} entries.`);
	}
	return Object.fromEntries(
		Object.entries(source).map(([key, entry]) => {
			identifier(key, `${label} key`);
			return [key, number(entry, `${label}.${key}`, -1_000_000_000, 1_000_000_000)];
		})
	);
}

export function mlObservationSize(behavior: IMlTrainingBehavior): number {
	return behavior.observations.reduce((total, observation) => total + observation.size * observation.stacking, 0);
}

export function mlActionOutputSize(actions: IMlActionSpec): number {
	return actions.continuousSize + actions.discreteBranches.reduce((total, branch) => total + branch, 0);
}

function normalizeObservation(value: unknown, index: number): IMlObservationSpec {
	const source = object(value, `observations[${index}]`);
	exact(source, ["name", "size", "stacking", "normalization"], `observations[${index}]`);
	let normalization: IMlObservationSpec["normalization"] = null;
	if (source.normalization !== undefined && source.normalization !== null) {
		const range = object(source.normalization, `observations[${index}].normalization`);
		exact(range, ["minimum", "maximum"], `observations[${index}].normalization`);
		const minimum = number(range.minimum, `observations[${index}].normalization.minimum`, -1_000_000_000, 1_000_000_000);
		const maximum = number(range.maximum, `observations[${index}].normalization.maximum`, -1_000_000_000, 1_000_000_000);
		if (maximum <= minimum) {
			throw new Error(`observations[${index}] normalization maximum must be greater than minimum.`);
		}
		normalization = { minimum, maximum };
	}
	return {
		name: identifier(source.name, `observations[${index}].name`),
		size: integer(source.size, `observations[${index}].size`, 1, 4096),
		stacking: integer(source.stacking ?? 1, `observations[${index}].stacking`, 1, 64),
		normalization,
	};
}

function normalizeActions(value: unknown): IMlActionSpec {
	const source = object(value, "actions");
	exact(source, ["continuousSize", "discreteBranches"], "actions");
	const continuousSize = integer(source.continuousSize ?? 0, "actions.continuousSize", 0, 256);
	if (!Array.isArray(source.discreteBranches) || source.discreteBranches.length > 32) {
		throw new Error("actions.discreteBranches must contain at most 32 entries.");
	}
	const discreteBranches = source.discreteBranches.map((entry, index) => integer(entry, `actions.discreteBranches[${index}]`, 2, 256));
	if (continuousSize === 0 && discreteBranches.length === 0) {
		throw new Error("An ML behavior requires at least one continuous or discrete action.");
	}
	if (continuousSize + discreteBranches.reduce((total, branch) => total + branch, 0) > 4096) {
		throw new Error("Encoded ML action output exceeds 4096 values.");
	}
	return { continuousSize, discreteBranches };
}

export function normalizeMlTrainingBehavior(value: unknown, index = 0): IMlTrainingBehavior {
	const source = object(value, `behaviors[${index}]`);
	exact(source, ["id", "name", "agentNodeIds", "behaviorGraphId", "observations", "actions", "decisionPeriod", "maxEpisodeSteps", "inferenceModelPath"], `behaviors[${index}]`);
	if (!Array.isArray(source.agentNodeIds) || source.agentNodeIds.length > 1024) {
		throw new Error(`behaviors[${index}].agentNodeIds must contain at most 1024 entries.`);
	}
	const agentNodeIds = source.agentNodeIds.map((entry, agentIndex) => identifier(entry, `behaviors[${index}].agentNodeIds[${agentIndex}]`));
	if (new Set(agentNodeIds).size !== agentNodeIds.length) {
		throw new Error(`behaviors[${index}].agentNodeIds must be unique.`);
	}
	if (!Array.isArray(source.observations) || source.observations.length < 1 || source.observations.length > 64) {
		throw new Error(`behaviors[${index}].observations must contain from 1 through 64 entries.`);
	}
	const observations = source.observations.map(normalizeObservation);
	if (new Set(observations.map((entry) => entry.name.toLowerCase())).size !== observations.length) {
		throw new Error(`behaviors[${index}] observation names must be unique.`);
	}
	const result: IMlTrainingBehavior = {
		id: identifier(source.id, `behaviors[${index}].id`),
		name: string(source.name, `behaviors[${index}].name`),
		agentNodeIds,
		behaviorGraphId: source.behaviorGraphId === undefined || source.behaviorGraphId === null ? null : identifier(source.behaviorGraphId, `behaviors[${index}].behaviorGraphId`),
		observations,
		actions: normalizeActions(source.actions),
		decisionPeriod: integer(source.decisionPeriod ?? 1, `behaviors[${index}].decisionPeriod`, 1, 1024),
		maxEpisodeSteps: integer(source.maxEpisodeSteps ?? 5000, `behaviors[${index}].maxEpisodeSteps`, 1, 10_000_000),
		inferenceModelPath:
			source.inferenceModelPath === undefined || source.inferenceModelPath === null
				? null
				: string(source.inferenceModelPath, `behaviors[${index}].inferenceModelPath`, 1024),
	};
	if (
		result.inferenceModelPath &&
		(!assetPathPattern.test(result.inferenceModelPath) || result.inferenceModelPath.split("/").some((segment) => !segment || segment === "." || segment === ".."))
	) {
		throw new Error(`behaviors[${index}].inferenceModelPath must be a contained Runtime AI model under assets/.`);
	}
	if (mlObservationSize(result) > 65536) {
		throw new Error(`behaviors[${index}] encoded observations exceed 65536 values.`);
	}
	return result;
}

export function normalizeMlTrainingConfiguration(value: unknown): IMlTrainingConfiguration {
	const source = value === undefined || value === null ? {} : object(value, "ML training configuration");
	exact(source, ["version", "revision", "enabled", "timeScale", "behaviors", "curriculum"], "ML training configuration");
	if (source.version !== undefined && source.version !== 1) {
		throw new Error("ML training configuration version must be 1.");
	}
	const rawBehaviors = source.behaviors ?? [];
	const rawCurriculum = source.curriculum ?? [];
	if (!Array.isArray(rawBehaviors) || rawBehaviors.length > 128) {
		throw new Error("ML training configuration supports at most 128 behaviors.");
	}
	if (!Array.isArray(rawCurriculum) || rawCurriculum.length > 64) {
		throw new Error("ML training configuration supports at most 64 curriculum lessons.");
	}
	const behaviors = rawBehaviors.map(normalizeMlTrainingBehavior);
	if (new Set(behaviors.map((entry) => entry.id)).size !== behaviors.length || new Set(behaviors.map((entry) => entry.name.toLowerCase())).size !== behaviors.length) {
		throw new Error("ML behavior ids and names must be unique.");
	}
	const curriculum = rawCurriculum.map((value, index): IMlCurriculumLesson => {
		const lesson = object(value, `curriculum[${index}]`);
		exact(lesson, ["id", "name", "minimumMeanReward", "parameters"], `curriculum[${index}]`);
		return {
			id: identifier(lesson.id, `curriculum[${index}].id`),
			name: string(lesson.name, `curriculum[${index}].name`),
			minimumMeanReward:
				lesson.minimumMeanReward === undefined || lesson.minimumMeanReward === null
					? null
					: number(lesson.minimumMeanReward, `curriculum[${index}].minimumMeanReward`, -1_000_000_000, 1_000_000_000),
			parameters: numericRecord(lesson.parameters, `curriculum[${index}].parameters`),
		};
	});
	if (new Set(curriculum.map((entry) => entry.id)).size !== curriculum.length) {
		throw new Error("ML curriculum lesson ids must be unique.");
	}
	for (let index = 1; index < curriculum.length; index++) {
		const previous = curriculum[index - 1].minimumMeanReward;
		const current = curriculum[index].minimumMeanReward;
		if (previous !== null && current !== null && current < previous) {
			throw new Error("ML curriculum reward thresholds must be non-decreasing.");
		}
	}
	return {
		version: 1,
		revision: integer(source.revision ?? 1, "ML training configuration revision", 1, Number.MAX_SAFE_INTEGER),
		enabled: source.enabled === undefined ? true : Boolean(source.enabled),
		timeScale: number(source.timeScale ?? 1, "ML training timeScale", 0.01, 100),
		behaviors,
		curriculum,
	};
}

export function normalizeMlTrainingSettings(value: unknown): IMlTrainingSettings {
	const source = value === undefined ? {} : object(value, "ML trainer settings");
	exact(
		source,
		["algorithm", "seed", "maxSteps", "batchSize", "bufferSize", "learningRate", "gamma", "gaeLambda", "entropy", "epochs", "checkpointInterval"],
		"ML trainer settings"
	);
	const algorithm = (source.algorithm ?? "behavior-cloning") as MlTrainingAlgorithm;
	if (!mlTrainingAlgorithms.includes(algorithm)) {
		throw new Error("ML trainer algorithm is unsupported.");
	}
	const batchSize = integer(source.batchSize ?? 64, "ML trainer batchSize", 1, 65536);
	const bufferSize = integer(source.bufferSize ?? 10240, "ML trainer bufferSize", batchSize, 10_000_000);
	return {
		algorithm,
		seed: integer(source.seed ?? 0, "ML trainer seed", 0, 0x7fffffff),
		maxSteps: integer(source.maxSteps ?? 500000, "ML trainer maxSteps", 1, 1_000_000_000),
		batchSize,
		bufferSize,
		learningRate: number(source.learningRate ?? 0.0003, "ML trainer learningRate", 0.000000001, 1),
		gamma: number(source.gamma ?? 0.99, "ML trainer gamma", 0, 1),
		gaeLambda: number(source.gaeLambda ?? 0.95, "ML trainer gaeLambda", 0, 1),
		entropy: number(source.entropy ?? 0.005, "ML trainer entropy", 0, 100),
		epochs: integer(source.epochs ?? 20, "ML trainer epochs", 1, 1000),
		checkpointInterval: integer(source.checkpointInterval ?? 50000, "ML trainer checkpointInterval", 1, 1_000_000_000),
	};
}

export function normalizeMlTrainingEpisode(value: unknown, behavior: IMlTrainingBehavior): IMlTrainingEpisode {
	const source = object(value, "ML training episode");
	exact(source, ["id", "behaviorId", "agentId", "lessonId", "parameters", "steps"], "ML training episode");
	if (source.behaviorId !== behavior.id) {
		throw new Error(`ML training episode behaviorId must be ${behavior.id}.`);
	}
	if (!Array.isArray(source.steps) || source.steps.length < 1 || source.steps.length > behavior.maxEpisodeSteps) {
		throw new Error(`ML training episode steps must contain from 1 through ${behavior.maxEpisodeSteps} entries.`);
	}
	const observationSize = mlObservationSize(behavior);
	const steps = source.steps.map((value, index): IMlTrainingStep => {
		const step = object(value, `steps[${index}]`);
		exact(step, ["observations", "continuousActions", "discreteActions", "reward", "done", "interrupted"], `steps[${index}]`);
		if (
			!Array.isArray(step.observations) ||
			step.observations.length !== observationSize ||
			!step.observations.every((entry) => typeof entry === "number" && Number.isFinite(entry))
		) {
			throw new Error(`steps[${index}].observations must contain exactly ${observationSize} finite values.`);
		}
		if (!Array.isArray(step.continuousActions) || step.continuousActions.length !== behavior.actions.continuousSize) {
			throw new Error(`steps[${index}].continuousActions must contain exactly ${behavior.actions.continuousSize} values.`);
		}
		const continuousActions = step.continuousActions.map((entry, actionIndex) => number(entry, `steps[${index}].continuousActions[${actionIndex}]`, -1, 1));
		if (!Array.isArray(step.discreteActions) || step.discreteActions.length !== behavior.actions.discreteBranches.length) {
			throw new Error(`steps[${index}].discreteActions must contain exactly ${behavior.actions.discreteBranches.length} values.`);
		}
		const discreteActions = step.discreteActions.map((entry, branchIndex) =>
			integer(entry, `steps[${index}].discreteActions[${branchIndex}]`, 0, behavior.actions.discreteBranches[branchIndex] - 1)
		);
		return {
			observations: [...step.observations] as number[],
			continuousActions,
			discreteActions,
			reward: number(step.reward, `steps[${index}].reward`, -1_000_000, 1_000_000),
			done: Boolean(step.done),
			interrupted: Boolean(step.interrupted),
		};
	});
	if (!steps.at(-1)!.done) {
		throw new Error("An ML training episode must end with done=true.");
	}
	if (steps.slice(0, -1).some((step) => step.done)) {
		throw new Error("Only the final ML training step can set done=true.");
	}
	return {
		id: identifier(source.id, "ML training episode id"),
		behaviorId: behavior.id,
		agentId: identifier(source.agentId, "ML training episode agentId"),
		lessonId: source.lessonId === undefined || source.lessonId === null ? null : identifier(source.lessonId, "ML training episode lessonId"),
		parameters: numericRecord(source.parameters, "ML training episode parameters"),
		steps,
	};
}

function targets(step: IMlTrainingStep, actions: IMlActionSpec): number[] {
	const result = [...step.continuousActions];
	for (let branch = 0; branch < actions.discreteBranches.length; branch++) {
		for (let option = 0; option < actions.discreteBranches[branch]; option++) {
			result.push(step.discreteActions[branch] === option ? 1 : 0);
		}
	}
	return result;
}

/** Rejects a trainer checkpoint unless its named float tensors exactly match the authored observation/action policy shape. */
export function validateMlPolicyOnnx(bytes: Uint8Array, inputSize: number, outputSize: number, requestedInputName?: string, requestedOutputName?: string): IMlPolicyOnnxEvidence {
	let model: onnx.IModelProto;
	try {
		model = onnxProto.ModelProto.decode(bytes);
	} catch (error) {
		throw new Error(`ML policy ONNX is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const graph = model.graph;
	if (!graph) {
		throw new Error("ML policy ONNX has no graph.");
	}
	const input = requestedInputName ? graph.input?.find((entry) => entry.name === requestedInputName) : graph.input?.[0];
	const output = requestedOutputName ? graph.output?.find((entry) => entry.name === requestedOutputName) : graph.output?.[0];
	if (!input?.name || !output?.name) {
		throw new Error("ML policy ONNX requires the requested input and output tensors.");
	}
	const validateShape = (value: onnx.IValueInfoProto, expected: number, label: string): void => {
		if (value.type?.tensorType?.elemType !== 1) {
			throw new Error(`ML policy ${label} must use float32.`);
		}
		const dimensions = value.type.tensorType.shape?.dim ?? [];
		if (dimensions.length !== 2) {
			throw new Error(`ML policy ${label} must have rank 2 [batch, values].`);
		}
		const batch = Number(dimensions[0].dimValue ?? 0);
		const values = Number(dimensions[1].dimValue ?? 0);
		if ((batch !== 0 && batch !== 1) || values !== expected) {
			throw new Error(`ML policy ${label} must have shape [1, ${expected}] or [dynamic, ${expected}].`);
		}
	};
	validateShape(input, inputSize, "input");
	validateShape(output, outputSize, "output");
	if (!graph.node?.length || graph.node.length > 100_000) {
		throw new Error("ML policy ONNX must contain from 1 through 100000 operators.");
	}
	return { inputName: input.name, outputName: output.name, inputSize, outputSize, operatorCount: graph.node.length };
}

/** Executes a deterministic, bounded linear behavior-cloning baseline and emits a real ONNX model consumable by Runtime AI. */
export function trainPortableBehaviorCloning(datasetValue: unknown, settingsValue: unknown): IPortableMlTrainingResult {
	const datasetSource = object(datasetValue, "ML training dataset");
	exact(datasetSource, ["contract", "version", "behavior", "episodes"], "ML training dataset");
	if (datasetSource.contract !== ML_TRAINING_CONTRACT || datasetSource.version !== 1) {
		throw new Error("ML training dataset contract/version is unsupported.");
	}
	const behavior = normalizeMlTrainingBehavior(datasetSource.behavior);
	if (!Array.isArray(datasetSource.episodes) || datasetSource.episodes.length < 1 || datasetSource.episodes.length > 10000) {
		throw new Error("ML training dataset must contain from 1 through 10000 episodes.");
	}
	const episodes = datasetSource.episodes.map((episode) => normalizeMlTrainingEpisode(episode, behavior));
	const steps = episodes.flatMap((episode) => episode.steps);
	if (steps.length > 1_000_000) {
		throw new Error("ML training dataset exceeds 1000000 steps.");
	}
	const settings = normalizeMlTrainingSettings(settingsValue);
	if (settings.algorithm !== "behavior-cloning") {
		throw new Error("The built-in portable trainer supports behavior-cloning only; use an external provider for PPO, SAC, or imitation trainers.");
	}
	const inputSize = mlObservationSize(behavior);
	const outputSize = mlActionOutputSize(behavior.actions);
	const weights = new Array<number>(inputSize * outputSize).fill(0);
	const bias = new Array<number>(outputSize).fill(0);
	const metrics: IMlTrainingMetric[] = [];
	const learningRate = settings.learningRate;
	for (let epoch = 0; epoch < settings.epochs; epoch++) {
		const weightGradient = new Array<number>(weights.length).fill(0);
		const biasGradient = new Array<number>(bias.length).fill(0);
		let loss = 0;
		for (const step of steps) {
			const target = targets(step, behavior.actions);
			for (let output = 0; output < outputSize; output++) {
				let predicted = bias[output];
				for (let input = 0; input < inputSize; input++) {
					predicted += step.observations[input] * weights[input * outputSize + output];
				}
				const error = predicted - target[output];
				loss += error * error;
				biasGradient[output] += error;
				for (let input = 0; input < inputSize; input++) {
					weightGradient[input * outputSize + output] += error * step.observations[input];
				}
			}
		}
		const scale = 2 / steps.length;
		for (let index = 0; index < weights.length; index++) {
			weights[index] -= learningRate * scale * weightGradient[index];
		}
		for (let index = 0; index < bias.length; index++) {
			bias[index] -= learningRate * scale * biasGradient[index];
		}
		metrics.push({
			step: Math.min(settings.maxSteps, (epoch + 1) * steps.length),
			epoch: epoch + 1,
			loss: loss / (steps.length * outputSize),
			meanReward: episodes.reduce((total, episode) => total + episode.steps.reduce((reward, step) => reward + step.reward, 0), 0) / episodes.length,
		});
	}
	const tensorType = (size: number): onnx.ITypeProto => ({ tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }, { dimValue: size }] } } });
	const model = onnxProto.ModelProto.create({
		irVersion: 8,
		producerName: "Zvibe Portable ML Trainer",
		producerVersion: "1.0.0",
		domain: "com.zvibe.ml-training",
		modelVersion: 1,
		opsetImport: [{ domain: "", version: 18 }],
		graph: {
			name: behavior.name,
			input: [{ name: "observations", type: tensorType(inputSize) }],
			output: [{ name: "actions", type: tensorType(outputSize) }],
			node: [{ name: "LinearPolicy", opType: "Gemm", input: ["observations", "weights", "bias"], output: ["actions"] }],
			initializer: [
				{ name: "weights", dataType: 1, dims: [inputSize, outputSize], floatData: weights },
				{ name: "bias", dataType: 1, dims: [outputSize], floatData: bias },
			],
		},
	});
	const verification = onnxProto.ModelProto.verify(model);
	if (verification) {
		throw new Error(`Portable ML trainer produced an invalid ONNX model: ${verification}.`);
	}
	const modelBytes = onnxProto.ModelProto.encode(model).finish();
	validateMlPolicyOnnx(modelBytes, inputSize, outputSize, "observations", "actions");
	return {
		model: modelBytes,
		modelFormat: "onnx",
		inputName: "observations",
		outputName: "actions",
		inputSize,
		outputSize,
		metrics,
		algorithm: "behavior-cloning",
		seed: settings.seed,
	};
}

const runtimes = new WeakMap<Scene, MlTrainingRuntime>();

/** Shared exported-game bridge for Agent-style observations, actions, rewards, and episode boundaries. */
export class MlTrainingRuntime {
	private _agents = new Map<string, IMlTrainingAgentState>();
	private _handler: MlTrainingDecisionHandler | null = null;

	public constructor(
		private _scene: Scene,
		private _configuration: IMlTrainingConfiguration
	) {}

	public setDecisionHandler(handler: MlTrainingDecisionHandler | null): void {
		this._handler = handler;
	}

	public requestDecision(behaviorId: string, agentId: string, observations: number[]): IMlTrainingDecision {
		const behavior = this._behavior(behaviorId);
		identifier(agentId, "ML agent id");
		if (observations.length !== mlObservationSize(behavior) || !observations.every((value) => Number.isFinite(value))) {
			throw new Error(`ML agent observations must contain exactly ${mlObservationSize(behavior)} finite values.`);
		}
		let state = this._agents.get(agentId);
		if (state && state.behaviorId !== behavior.id) {
			throw new Error(`ML agent ${agentId} is already registered to behavior ${state.behaviorId}.`);
		}
		if (!state || state.ended) {
			state = {
				agentId,
				behaviorId: behavior.id,
				episode: (state?.episode ?? 0) + 1,
				step: 0,
				cumulativeReward: 0,
				ended: false,
				interrupted: false,
				lastObservation: [],
				lastDecision: {
					continuousActions: new Array(behavior.actions.continuousSize).fill(0),
					discreteActions: new Array(behavior.actions.discreteBranches.length).fill(0),
				},
			};
			this._agents.set(agentId, state);
		}
		state.step++;
		state.lastObservation = [...observations];
		const decision = this._handler?.(behavior, agentId, [...observations], structuredClone(state)) ?? {
			continuousActions: new Array(behavior.actions.continuousSize).fill(0),
			discreteActions: new Array(behavior.actions.discreteBranches.length).fill(0),
		};
		this._validateDecision(behavior, decision);
		state.lastDecision = structuredClone(decision);
		if (state.step >= behavior.maxEpisodeSteps) {
			this.endEpisode(agentId, true);
		}
		return structuredClone(decision);
	}

	public addReward(agentId: string, reward: number): IMlTrainingAgentState {
		const state = this._agent(agentId);
		if (state.ended) {
			throw new Error(`ML agent ${agentId} episode has ended.`);
		}
		state.cumulativeReward += number(reward, "ML reward", -1_000_000, 1_000_000);
		return structuredClone(state);
	}

	public endEpisode(agentId: string, interrupted = false): IMlTrainingAgentState {
		const state = this._agent(agentId);
		state.ended = true;
		state.interrupted = Boolean(interrupted);
		return structuredClone(state);
	}

	public getState(): { configuration: IMlTrainingConfiguration; agents: IMlTrainingAgentState[] } {
		return { configuration: structuredClone(this._configuration), agents: [...this._agents.values()].map((state) => structuredClone(state)) };
	}

	public dispose(): void {
		this._agents.clear();
		this._handler = null;
		if (runtimes.get(this._scene) === this) {
			runtimes.delete(this._scene);
		}
		if ((this._scene as any).mlTraining === this) {
			delete (this._scene as any).mlTraining;
		}
	}

	private _behavior(id: string): IMlTrainingBehavior {
		const behavior = this._configuration.behaviors.find((entry) => entry.id === id);
		if (!behavior) {
			throw new Error(`ML behavior ${id} was not found.`);
		}
		return behavior;
	}

	private _agent(id: string): IMlTrainingAgentState {
		const state = this._agents.get(id);
		if (!state) {
			throw new Error(`ML agent ${id} has not requested a decision.`);
		}
		return state;
	}

	private _validateDecision(behavior: IMlTrainingBehavior, decision: IMlTrainingDecision): void {
		if (
			decision.continuousActions.length !== behavior.actions.continuousSize ||
			decision.continuousActions.some((value) => !Number.isFinite(value) || value < -1 || value > 1)
		) {
			throw new Error(`ML decision requires ${behavior.actions.continuousSize} continuous actions from -1 through 1.`);
		}
		if (
			decision.discreteActions.length !== behavior.actions.discreteBranches.length ||
			decision.discreteActions.some((value, index) => !Number.isSafeInteger(value) || value < 0 || value >= behavior.actions.discreteBranches[index])
		) {
			throw new Error(`ML decision discrete actions do not match behavior ${behavior.id}.`);
		}
	}
}

export function configureMlTrainingRuntime(scene: Scene): MlTrainingRuntime {
	const previous = runtimes.get(scene);
	previous?.dispose();
	const runtime = new MlTrainingRuntime(scene, normalizeMlTrainingConfiguration(scene.metadata?.babylonEditorMlTraining));
	runtimes.set(scene, runtime);
	(scene as any).mlTraining = runtime;
	scene.onDisposeObservable.addOnce(() => runtime.dispose());
	return runtime;
}

export function getMlTrainingRuntime(scene: Scene): MlTrainingRuntime | null {
	return runtimes.get(scene) ?? null;
}

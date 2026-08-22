import { Scene } from "@babylonjs/core/scene";

import { HumanBone, HumanoidMuscleValue, IHumanoidMusclePose, IHumanoidMusclePoseEntry } from "../assets/humanoid-avatar";
import { getHumanoidAvatar, getHumanoidMusclePose } from "./humanoid-avatar";

export const ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY = 256;
export const ANIMATOR_HUMANOID_MUSCLE_TRACE_PHASE = "postAnimatorPreMuscleLimit" as const;

export interface IAnimatorHumanoidMuscleTraceController {
	id: string;
	name: string;
	humanoidAvatarId?: string;
	activeState?: string;
	layers?: Array<{ name: string; weight?: number; activeState?: string }>;
}

export interface IAnimatorHumanoidMuscleTraceEntry extends IHumanoidMusclePoseEntry {
	deltaNormalized: HumanoidMuscleValue;
}

export interface IAnimatorHumanoidMuscleTraceSample {
	sequence: number;
	runtimeSeconds: number;
	deltaSeconds: number;
	samplingPhase: typeof ANIMATOR_HUMANOID_MUSCLE_TRACE_PHASE;
	baseState: string | null;
	layers: Array<{ name: string; activeState: string | null; weight: number }>;
	activeMuscleCount: number;
	mappedMuscleCount: number;
	limitViolationCount: number;
	maximumAbsoluteNormalized: number;
	maximumAbsoluteDeltaNormalized: number;
	muscles: IAnimatorHumanoidMuscleTraceEntry[];
	warnings: string[];
}

export interface IAnimatorHumanoidMuscleTracePage {
	offset: number;
	limit: number;
	count: number;
	total: number;
	hasMore: boolean;
	nextOffset: number | null;
	items: IAnimatorHumanoidMuscleTraceSample[];
}

export interface IAnimatorHumanoidMuscleTraceSnapshot {
	controllerId: string;
	controllerName: string;
	avatarId: string | null;
	avatarName: string | null;
	skeletonId: string | null;
	enabled: boolean;
	samplingPhase: typeof ANIMATOR_HUMANOID_MUSCLE_TRACE_PHASE;
	capacity: number;
	revision: number;
	droppedSampleCount: number;
	lastError: string | null;
	selectedRoles: HumanBone[] | null;
	current: IHumanoidMusclePose | null;
	latest: IAnimatorHumanoidMuscleTraceSample | null;
	history: IAnimatorHumanoidMuscleTracePage;
}

interface IAnimatorHumanoidMuscleTraceState {
	avatarId: string | null;
	history: IAnimatorHumanoidMuscleTraceSample[];
	droppedSampleCount: number;
	nextSequence: number;
	revision: number;
	lastError: string | null;
}

const traceStates = new WeakMap<Scene, Map<string, IAnimatorHumanoidMuscleTraceState>>();

function stateMap(scene: Scene): Map<string, IAnimatorHumanoidMuscleTraceState> {
	let states = traceStates.get(scene);
	if (!states) {
		states = new Map<string, IAnimatorHumanoidMuscleTraceState>();
		traceStates.set(scene, states);
	}
	return states;
}

function traceState(scene: Scene, controller: IAnimatorHumanoidMuscleTraceController): IAnimatorHumanoidMuscleTraceState {
	const states = stateMap(scene);
	const assignedAvatarId = controller.humanoidAvatarId ?? null;
	let state = states.get(controller.id);
	if (!state || state.avatarId !== assignedAvatarId) {
		state = {
			avatarId: assignedAvatarId,
			history: [],
			droppedSampleCount: 0,
			nextSequence: 1,
			revision: (state?.revision ?? 0) + 1,
			lastError: null,
		};
		states.set(controller.id, state);
	}
	return state;
}

function maximumAbsolute(values: number[]): number {
	return values.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
}

function filteredPose(pose: IHumanoidMusclePose, roles: Set<HumanBone> | null): IHumanoidMusclePose {
	if (!roles) {
		return structuredClone(pose);
	}
	const muscles = pose.muscles.filter((muscle) => roles.has(muscle.role));
	return {
		...structuredClone(pose),
		muscles,
		activeMuscleCount: muscles.filter((muscle) => muscle.normalized.some((value) => Math.abs(value) > 1e-4)).length,
		mappedMuscleCount: muscles.length,
	};
}

function filteredSample(sample: IAnimatorHumanoidMuscleTraceSample, roles: Set<HumanBone> | null): IAnimatorHumanoidMuscleTraceSample {
	if (!roles) {
		return structuredClone(sample);
	}
	const muscles = sample.muscles.filter((muscle) => roles.has(muscle.role));
	return {
		...structuredClone(sample),
		muscles,
		activeMuscleCount: muscles.filter((muscle) => muscle.normalized.some((value) => Math.abs(value) > 1e-4)).length,
		mappedMuscleCount: muscles.length,
		limitViolationCount: muscles.filter((muscle) => !muscle.withinLimits).length,
		maximumAbsoluteNormalized: maximumAbsolute(muscles.flatMap((muscle) => muscle.normalized)),
		maximumAbsoluteDeltaNormalized: maximumAbsolute(muscles.flatMap((muscle) => muscle.deltaNormalized)),
	};
}

/** Captures one bounded controller-driven Humanoid pose sample after Animator, behaviour, IK, and root-motion evaluation. */
export function captureAnimatorHumanoidMuscleTrace(
	scene: Scene,
	controller: IAnimatorHumanoidMuscleTraceController,
	context: { runtimeSeconds: number; deltaSeconds: number }
): IAnimatorHumanoidMuscleTraceSample | null {
	const state = traceState(scene, controller);
	if (!controller.humanoidAvatarId) {
		state.lastError = null;
		return null;
	}
	try {
		const pose = getHumanoidMusclePose(scene, controller.humanoidAvatarId);
		const previous = state.history.at(-1);
		const previousByRole = new Map(previous?.muscles.map((muscle) => [muscle.role, muscle.normalized]) ?? []);
		const muscles = pose.muscles.map((muscle) => {
			const previousNormalized = previousByRole.get(muscle.role) ?? muscle.normalized;
			return {
				...structuredClone(muscle),
				deltaNormalized: muscle.normalized.map((value, axis) => value - previousNormalized[axis]) as HumanoidMuscleValue,
			};
		});
		const sample: IAnimatorHumanoidMuscleTraceSample = {
			sequence: state.nextSequence++,
			runtimeSeconds: context.runtimeSeconds,
			deltaSeconds: context.deltaSeconds,
			samplingPhase: ANIMATOR_HUMANOID_MUSCLE_TRACE_PHASE,
			baseState: controller.activeState ?? null,
			layers: (controller.layers ?? []).slice(0, 64).map((layer) => ({
				name: layer.name,
				activeState: layer.activeState ?? null,
				weight: layer.weight ?? 1,
			})),
			activeMuscleCount: pose.activeMuscleCount,
			mappedMuscleCount: pose.mappedMuscleCount,
			limitViolationCount: muscles.filter((muscle) => !muscle.withinLimits).length,
			maximumAbsoluteNormalized: maximumAbsolute(muscles.flatMap((muscle) => muscle.normalized)),
			maximumAbsoluteDeltaNormalized: maximumAbsolute(muscles.flatMap((muscle) => muscle.deltaNormalized)),
			muscles,
			warnings: [...pose.warnings],
		};
		state.history.push(sample);
		if (state.history.length > ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY) {
			const removed = state.history.length - ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY;
			state.history.splice(0, removed);
			state.droppedSampleCount += removed;
		}
		state.lastError = null;
		state.revision++;
		return structuredClone(sample);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (state.lastError !== message) {
			state.lastError = message;
			state.revision++;
		}
		return null;
	}
}

/** Returns the current pose and a newest-first, bounded page of controller muscle history without advancing runtime state. */
export function getAnimatorHumanoidMuscleTrace(
	scene: Scene,
	controller: IAnimatorHumanoidMuscleTraceController,
	options: { roles?: HumanBone[]; offset?: number; limit?: number } = {}
): IAnimatorHumanoidMuscleTraceSnapshot {
	const state = traceState(scene, controller);
	const roles = options.roles?.length ? new Set(options.roles) : null;
	const offset = Number.isInteger(options.offset) ? Math.max(0, options.offset!) : 0;
	const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY, options.limit!)) : 16;
	const newestFirst = [...state.history].reverse();
	const items = newestFirst.slice(offset, offset + limit).map((sample) => filteredSample(sample, roles));
	let current: IHumanoidMusclePose | null = null;
	if (controller.humanoidAvatarId) {
		try {
			current = filteredPose(getHumanoidMusclePose(scene, controller.humanoidAvatarId), roles);
		} catch {
			// Capture owns lastError/revision mutations. Reads deliberately remain side-effect free.
		}
	}
	const avatar = controller.humanoidAvatarId ? getHumanoidAvatar(scene, controller.humanoidAvatarId) : null;
	return {
		controllerId: controller.id,
		controllerName: controller.name,
		avatarId: controller.humanoidAvatarId ?? null,
		avatarName: avatar?.name ?? null,
		skeletonId: avatar?.skeletonId ?? null,
		enabled: !!controller.humanoidAvatarId,
		samplingPhase: ANIMATOR_HUMANOID_MUSCLE_TRACE_PHASE,
		capacity: ANIMATOR_HUMANOID_MUSCLE_TRACE_CAPACITY,
		revision: state.revision,
		droppedSampleCount: state.droppedSampleCount,
		lastError: state.lastError,
		selectedRoles: options.roles?.length ? [...options.roles] : null,
		current,
		latest: state.history.length ? filteredSample(state.history[state.history.length - 1], roles) : null,
		history: {
			offset,
			limit,
			count: items.length,
			total: state.history.length,
			hasMore: offset + items.length < state.history.length,
			nextOffset: offset + items.length < state.history.length ? offset + items.length : null,
			items,
		},
	};
}

/** Clears one controller's runtime-only muscle history while preserving its Avatar assignment. */
export function clearAnimatorHumanoidMuscleTrace(scene: Scene, controller: IAnimatorHumanoidMuscleTraceController): IAnimatorHumanoidMuscleTraceSnapshot {
	const state = traceState(scene, controller);
	state.history = [];
	state.droppedSampleCount = 0;
	state.nextSequence = 1;
	state.lastError = null;
	state.revision++;
	return getAnimatorHumanoidMuscleTrace(scene, controller);
}

/** Releases runtime-only muscle trace data when a controller is deleted or its runtime is disposed. */
export function deleteAnimatorHumanoidMuscleTrace(scene: Scene, controllerId: string): void {
	traceStates.get(scene)?.delete(controllerId);
}

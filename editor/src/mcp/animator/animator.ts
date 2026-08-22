import { createHash } from "node:crypto";

import { AnimationGroup, AnimationGroupMask, Scene, Tools } from "babylonjs";
import {
	compileAnimatorMachine,
	IAnimatorGraphMachine,
	IAnimatorGraphState,
	IAnimatorGraphTransition,
	IAnimatorSubgraphDefinition,
	IAnimatorSubStateMachineInstance,
	AnimatorLayerAnimationGroups,
	AnimatorLayerBlendingMode,
	evaluateAnimatorBlendTreeMotions,
	getAnimatorBlendTreeAnimationGroups,
	getAnimatorBlendTreeMotions,
	getAnimatorBlendTreeParameters,
	IAnimatorBlendTreeMotion,
	IAnimatorLayerReferencePose,
	ICompiledAnimatorMachine,
	ICompiledAnimatorState,
	ICompiledAnimatorTransition,
	IHumanoidAvatar,
	IHumanoidAvatarMask,
	HumanBone,
	HUMAN_BONES,
	captureAnimatorHumanoidMuscleTrace,
	clearAnimatorHumanoidMuscleTrace,
	deleteAnimatorHumanoidMuscleTrace,
	applyAnimatorFootIK,
	deleteAnimatorFootIKDiagnostics,
	getAnimatorFootIKDiagnostics,
	applyAnimatorWriteDefaults,
	deleteAnimatorWriteDefaults,
	getAnimatorWriteDefaultsDiagnostics,
	getAnimatorHumanoidMuscleTrace,
	getAnimatorIKPassDiagnostics,
	getAnimatorStateBehaviourDiagnostics,
	getAnimatorStateMachineBehaviourTransitions,
	invokeAnimatorIKPass,
	invokeAnimatorStateBehaviours,
	invokeAnimatorStateMachineBehaviours,
	resolveHumanoidAvatarMaskTargetNames,
	resolveAnimatorStatePlayback,
	scriptsDictionary,
	validateAnimatorStateBehaviours,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

type IAnimatorState = IAnimatorGraphState & { synchronizedSourceState?: string };
type IAnimatorTransitionCondition = NonNullable<IAnimatorGraphTransition["conditions"]>[number];
type IAnimatorTransition = IAnimatorGraphTransition;

interface IAnimatorLayer extends IAnimatorGraphMachine {
	name: string;
	weight?: number;
	maskTargetNames?: string[];
	avatarMaskId?: string;
	blendingMode?: AnimatorLayerBlendingMode;
	referencePose?: IAnimatorLayerReferencePose;
	synchronizedLayer?: "$base" | string;
	synchronizedTiming?: boolean;
	synchronizedStateMap?: Record<string, string>;
	synchronizedMotionOverrides?: Record<string, Pick<IAnimatorState, "animationGroup" | "blendTree">>;
	synchronizedBehaviourOverrides?: Record<string, NonNullable<IAnimatorState["behaviours"]>>;
	ikPass?: boolean;
}

interface IAnimatorRootMotion {
	enabled: boolean;
	sourceNodeId: string;
	targetNodeId: string;
	applyPosition?: boolean;
	applyRotationY?: boolean;
}

type IAnimatorParameterType = "float" | "int" | "bool" | "trigger" | "string";

interface IAnimatorController extends IAnimatorGraphMachine {
	id: string;
	name: string;
	targetNodeId?: string;
	humanoidAvatarId?: string;
	parameters: Record<string, string | number | boolean>;
	parameterTypes?: Record<string, IAnimatorParameterType>;
	baseIKPass?: boolean;
	subgraphs?: IAnimatorSubgraphDefinition[];
	layers?: IAnimatorLayer[];
	rootMotion?: IAnimatorRootMotion;
}

export const ANIMATOR_ANY_STATE = "$any";
export const ANIMATOR_EXIT_STATE = "$exit";

interface IAnimatorTransitionMatch {
	transition: IAnimatorTransition;
	index: number;
	evaluatedState: string;
	interrupted: boolean;
}

interface IAnimatorFade {
	sources: { state: IAnimatorState; weight: number }[];
	to?: IAnimatorState;
	toStartWeight: number;
	targetWeight: number;
	elapsed: number;
	duration: number;
	layer?: IAnimatorLayer;
	transition?: IAnimatorTransition;
	transitionIndex?: number;
	sourceState?: string;
	interrupted?: boolean;
}

interface IAnimatorDebugBreakpoint {
	id: string;
	layer: "$base" | string;
	from?: string;
	to?: string;
	enabled: boolean;
}

interface IAnimatorTransitionHistoryEntry {
	sequence: number;
	runtimeSeconds: number;
	layer: "$base" | string;
	from: string;
	authoredFrom: string;
	to: string;
	transitionIndex: number;
	interrupted: boolean;
	durationSeconds: number;
	conditions: Array<{ parameter: string; operator: string; authoredValue: string | number | boolean; runtimeValue: string | number | boolean | null }>;
	hitBreakpointIds: string[];
}

interface IAnimatorRuntimeDebugState {
	paused: boolean;
	breakpoints: IAnimatorDebugBreakpoint[];
	history: IAnimatorTransitionHistoryEntry[];
	droppedHistoryCount: number;
	nextSequence: number;
	runtimeSeconds: number;
	revision: number;
}

const rootMotionSamples = new WeakMap<Scene, Map<string, { position: any; rotationY: number }>>();
const rootMotionObservers = new WeakMap<Scene, any>();
const animatorElapsedSeconds = new WeakMap<Scene, Map<string, number>>();
const animatorFades = new WeakMap<Scene, Map<string, IAnimatorFade>>();
const animatorLayerAnimationGroups = new WeakMap<Scene, AnimatorLayerAnimationGroups>();
const animatorBehaviourActiveStates = new WeakMap<Scene, Map<string, IAnimatorState>>();
const animatorRuntimeDebugStates = new WeakMap<Scene, Map<string, IAnimatorRuntimeDebugState>>();
const maximumAnimatorTransitionHistory = 256;

function getAnimatorRuntimeDebugState(scene: Scene, controllerId: string): IAnimatorRuntimeDebugState {
	let states = animatorRuntimeDebugStates.get(scene);
	if (!states) {
		states = new Map();
		animatorRuntimeDebugStates.set(scene, states);
	}
	let state = states.get(controllerId);
	if (!state) {
		state = { paused: false, breakpoints: [], history: [], droppedHistoryCount: 0, nextSequence: 1, runtimeSeconds: 0, revision: 0 };
		states.set(controllerId, state);
	}
	return state;
}

function animatorRuntimeDebugFingerprint(controller: IAnimatorController, state: IAnimatorRuntimeDebugState): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				controllerId: controller.id,
				paused: state.paused,
				breakpoints: state.breakpoints,
				revision: state.revision,
				lastSequence: state.history.at(-1)?.sequence ?? 0,
			})
		)
		.digest("hex");
}

function behaviourStateKey(controller: IAnimatorController, layer?: IAnimatorLayer): string {
	return layer ? `${controller.id}:layer:${layer.name}` : `${controller.id}:base`;
}

function getBehaviourActiveStates(scene: Scene): Map<string, IAnimatorState> {
	let states = animatorBehaviourActiveStates.get(scene);
	if (!states) {
		states = new Map();
		animatorBehaviourActiveStates.set(scene, states);
	}
	return states;
}

// eslint-disable-next-line max-params -- lifecycle dispatch needs controller, compiled state, timing, layer, and interruption context together.
function enterAnimatorBehaviourState(
	scene: Scene,
	controller: IAnimatorController,
	machine: ICompiledAnimatorMachine,
	state: IAnimatorState,
	elapsedSeconds: number,
	normalizedTime: number,
	layer?: IAnimatorLayer,
	interrupted = false
): void {
	const states = getBehaviourActiveStates(scene);
	const key = behaviourStateKey(controller, layer);
	const previous = states.get(key);
	if (previous) {
		invokeAnimatorStateBehaviours(scene as any, controller, previous, "exit", { layerName: layer?.name, elapsedSeconds, normalizedTime, interrupted });
	}
	for (const transition of getAnimatorStateMachineBehaviourTransitions(machine, previous, state)) {
		invokeAnimatorStateMachineBehaviours(scene as any, controller, transition.behaviours, transition.machinePath, transition.phase, {
			layerName: layer?.name,
			interrupted,
		});
	}
	states.set(key, state);
	invokeAnimatorStateBehaviours(scene as any, controller, state, "enter", { layerName: layer?.name, elapsedSeconds, normalizedTime, interrupted });
}

// eslint-disable-next-line max-params -- lifecycle dispatch needs controller, compiled state, timing, layer, and interruption context together.
function exitAnimatorBehaviourState(
	scene: Scene,
	controller: IAnimatorController,
	machine: ICompiledAnimatorMachine,
	elapsedSeconds: number,
	normalizedTime: number,
	layer?: IAnimatorLayer,
	interrupted = false
): void {
	const states = getBehaviourActiveStates(scene);
	const key = behaviourStateKey(controller, layer);
	const previous = states.get(key);
	if (previous) {
		invokeAnimatorStateBehaviours(scene as any, controller, previous, "exit", { layerName: layer?.name, elapsedSeconds, normalizedTime, interrupted });
	}
	for (const transition of getAnimatorStateMachineBehaviourTransitions(machine, previous, null)) {
		invokeAnimatorStateMachineBehaviours(scene as any, controller, transition.behaviours, transition.machinePath, transition.phase, {
			layerName: layer?.name,
			interrupted,
		});
	}
	states.delete(key);
}

function getLayerAnimationGroups(scene: Scene): AnimatorLayerAnimationGroups {
	let groups = animatorLayerAnimationGroups.get(scene);
	if (!groups) {
		groups = new AnimatorLayerAnimationGroups(scene as any);
		animatorLayerAnimationGroups.set(scene, groups);
		scene.onDisposeObservable.addOnce(() => groups?.dispose());
	}
	return groups;
}

function resolveAnimationGroup(scene: Scene, controller: IAnimatorController, groupName: string, layer?: IAnimatorLayer): AnimationGroup | null {
	return layer
		? (getLayerAnimationGroups(scene).resolve(
				`${controller.id}:${layer.name}`,
				groupName,
				layer.blendingMode ?? "override",
				layer.referencePose ?? { normalizedTime: 0 }
			) as AnimationGroup | null)
		: scene.getAnimationGroupByName(groupName);
}

function stateMotion<T extends IAnimatorBlendTreeMotion>(controller: IAnimatorController, state: IAnimatorState, motion: T): T {
	const playback = resolveAnimatorStatePlayback(state, controller.parameters);
	return {
		...motion,
		cycleOffset: (((motion.cycleOffset + playback.cycleOffset) % 1) + 1) % 1,
		mirror: motion.mirror !== playback.mirror,
	} as T;
}

function stateMotions(controller: IAnimatorController, state: IAnimatorState): IAnimatorBlendTreeMotion[] {
	const motions = state.blendTree
		? getAnimatorBlendTreeMotions(state.blendTree)
		: state.animationGroup
			? [{ key: "state", animationGroup: state.animationGroup, timeScale: 1, cycleOffset: 0, mirror: false }]
			: [];
	return motions.map((motion) => stateMotion(controller, state, motion));
}

function activeAnimatorMotionGroups(scene: Scene, controller: IAnimatorController): AnimationGroup[] {
	const groups = new Map<number, AnimationGroup>();
	const addState = (state: IAnimatorState | undefined, layer?: IAnimatorLayer): void => {
		for (const motion of state ? stateMotions(controller, state) : []) {
			const group = resolveStateMotionGroup(scene, controller, state!, motion, layer);
			if (group) {
				groups.set(group.uniqueId, group);
			}
		}
	};
	const baseMachine = compileControllerMachine(controller);
	addState(baseMachine.states.find((state) => state.name === controller.activeState));
	for (const state of animatorFades
		.get(scene)
		?.get(`${controller.id}:base`)
		?.sources.map((source) => source.state) ?? []) {
		addState(state);
	}
	addState(animatorFades.get(scene)?.get(`${controller.id}:base`)?.to);
	for (const layer of controller.layers ?? []) {
		const machine = compileLayerMachine(controller, layer);
		addState(
			machine.states.find((state) => state.name === layer.activeState),
			layer
		);
		const fade = animatorFades.get(scene)?.get(`${controller.id}:layer:${layer.name}`);
		for (const source of fade?.sources ?? []) {
			addState(source.state, layer);
		}
		addState(fade?.to, layer);
	}
	return [...groups.values()];
}

function setAnimatorMotionGroupsPaused(scene: Scene, controller: IAnimatorController, paused: boolean): void {
	for (const group of activeAnimatorMotionGroups(scene, controller)) {
		if (paused && group.isPlaying) {
			group.pause();
		} else if (!paused && group.isStarted && !group.isPlaying) {
			group.restart();
		}
	}
}

function validateAnimatorDebugBreakpoints(controller: IAnimatorController, breakpoints: any[]): IAnimatorDebugBreakpoint[] {
	if (!Array.isArray(breakpoints) || breakpoints.length > 64) {
		throw new Error("Animator runtime debugging accepts at most 64 transition breakpoints.");
	}
	const ids = new Set<string>();
	return breakpoints.map((breakpoint, index) => {
		if (!breakpoint || typeof breakpoint !== "object") {
			throw new Error(`Animator breakpoint ${index} must be an object.`);
		}
		const id = breakpoint.id;
		if (typeof id !== "string" || id.length < 1 || id.length > 128 || ids.has(id)) {
			throw new Error(`Animator breakpoint ${index} requires a unique id containing 1 through 128 characters.`);
		}
		ids.add(id);
		const layer = breakpoint.layer ?? "$base";
		const machine = layer === "$base" ? compileControllerMachine(controller) : compileLayerMachine(controller, findLayer(controller, layer));
		const stateNames = new Set(machine.states.map((state) => state.name));
		if (breakpoint.from !== undefined && (typeof breakpoint.from !== "string" || !stateNames.has(breakpoint.from))) {
			throw new Error(`Animator breakpoint "${id}" source state "${String(breakpoint.from)}" was not found in ${layer}.`);
		}
		if (breakpoint.to !== undefined && (typeof breakpoint.to !== "string" || (breakpoint.to !== ANIMATOR_EXIT_STATE && !stateNames.has(breakpoint.to)))) {
			throw new Error(`Animator breakpoint "${id}" destination state "${String(breakpoint.to)}" was not found in ${layer}.`);
		}
		if (breakpoint.from === undefined && breakpoint.to === undefined) {
			throw new Error(`Animator breakpoint "${id}" requires from, to, or both.`);
		}
		return {
			id,
			layer,
			...(breakpoint.from === undefined ? {} : { from: breakpoint.from }),
			...(breakpoint.to === undefined ? {} : { to: breakpoint.to }),
			enabled: breakpoint.enabled !== false,
		};
	});
}

function transitionConditionEvidence(controller: IAnimatorController, transition: IAnimatorTransition): IAnimatorTransitionHistoryEntry["conditions"] {
	return (authoredTransition(transition).conditions ?? []).map((condition) => {
		const operator =
			condition.equals !== undefined ? "equals" : condition.notEquals !== undefined ? "notEquals" : condition.greaterThan !== undefined ? "greaterThan" : "lessThan";
		const authoredValue = condition[operator] as string | number | boolean;
		return { parameter: condition.parameter, operator, authoredValue, runtimeValue: controller.parameters[condition.parameter] ?? null };
	});
}

function recordAnimatorTransition(scene: Scene, controller: IAnimatorController, layer: "$base" | string, match: IAnimatorTransitionMatch, durationSeconds: number): void {
	const state = getAnimatorRuntimeDebugState(scene, controller.id);
	const authored = authoredTransition(match.transition);
	const hitBreakpointIds = state.breakpoints
		.filter(
			(breakpoint) =>
				breakpoint.enabled &&
				breakpoint.layer === layer &&
				(breakpoint.from === undefined || breakpoint.from === match.evaluatedState) &&
				(breakpoint.to === undefined || breakpoint.to === match.transition.to)
		)
		.map((breakpoint) => breakpoint.id);
	state.history.push({
		sequence: state.nextSequence++,
		runtimeSeconds: state.runtimeSeconds,
		layer,
		from: match.evaluatedState,
		authoredFrom: authored.from,
		to: match.transition.to,
		transitionIndex: match.index,
		interrupted: match.interrupted,
		durationSeconds,
		conditions: transitionConditionEvidence(controller, match.transition),
		hitBreakpointIds,
	});
	if (state.history.length > maximumAnimatorTransitionHistory) {
		const removed = state.history.length - maximumAnimatorTransitionHistory;
		state.history.splice(0, removed);
		state.droppedHistoryCount += removed;
	}
	state.revision++;
	if (hitBreakpointIds.length) {
		state.paused = true;
		setAnimatorMotionGroupsPaused(scene, controller, true);
	}
}

function resolveStateMotionGroup(
	scene: Scene,
	controller: IAnimatorController,
	state: IAnimatorState,
	motion: IAnimatorBlendTreeMotion,
	layer?: IAnimatorLayer
): AnimationGroup | null {
	const playback = resolveAnimatorStatePlayback(state, controller.parameters);
	const requiresIndependentMotion =
		state.cycleOffset !== undefined ||
		state.mirror !== undefined ||
		!!playback.bindings.cycleOffset ||
		!!playback.bindings.mirror ||
		motion.timeScale !== 1 ||
		motion.cycleOffset !== 0 ||
		motion.mirror ||
		stateMotions(controller, state).filter((candidate) => candidate.animationGroup === motion.animationGroup).length > 1;
	if (!requiresIndependentMotion) {
		return resolveAnimationGroup(scene, controller, motion.animationGroup, layer);
	}
	return getLayerAnimationGroups(scene).resolve(
		`${controller.id}:${layer?.name ?? "$base"}:${state.name}`,
		motion.animationGroup,
		layer?.blendingMode ?? "override",
		layer?.referencePose ?? { normalizedTime: 0 },
		motion
	) as AnimationGroup | null;
}

function stopStateGroups(scene: Scene, controller: IAnimatorController, state: IAnimatorState, layer?: IAnimatorLayer): void {
	stateMotions(controller, state).forEach((motion) => resolveStateMotionGroup(scene, controller, state, motion, layer)?.stop());
}

function stopStateGroupsExcept(scene: Scene, controller: IAnimatorController, from: IAnimatorState, keep: IAnimatorState, layer?: IAnimatorLayer): void {
	const keepGroups = new Set(stateMotions(controller, keep).map((motion) => resolveStateMotionGroup(scene, controller, keep, motion, layer)));
	stateMotions(controller, from)
		.map((motion) => resolveStateMotionGroup(scene, controller, from, motion, layer))
		.filter((group) => group && !keepGroups.has(group))
		.forEach((group) => group?.stop());
}

function stateDurationSeconds(scene: Scene, controller: IAnimatorController, state: IAnimatorState): number | null {
	const motion = stateMotions(controller, state)[0];
	const group = motion ? scene.getAnimationGroupByName(motion.animationGroup) : null;
	const framesPerSecond = group?.targetedAnimations[0]?.animation.framePerSecond;
	if (!group || !framesPerSecond || group.to <= group.from) {
		return null;
	}
	const effectiveSpeed = resolveAnimatorStatePlayback(state, controller.parameters).effectiveSpeed;
	return effectiveSpeed !== 0 ? (group.to - group.from) / framesPerSecond / Math.abs(effectiveSpeed * (motion?.timeScale ?? 1)) : null;
}

function applyRootMotion(scene: Scene, controller: IAnimatorController): void {
	const config = controller.rootMotion;
	const samples = rootMotionSamples.get(scene)!;
	if (!config?.enabled) {
		samples.delete(controller.id);
		return;
	}
	const state = compileControllerMachine(controller).states.find((candidate) => candidate.name === controller.activeState);
	if (state && resolveAnimatorStatePlayback(state, controller.parameters).timeDriven) {
		samples.delete(controller.id);
		return;
	}
	const source: any = scene.getNodeById(config.sourceNodeId);
	const target: any = scene.getNodeById(config.targetNodeId);
	if (!source?.position || !target?.position || source === target) {
		return;
	}
	const sample = { position: source.position.clone(), rotationY: source.rotation?.y ?? 0 };
	const previous = samples.get(controller.id);
	if (!previous) {
		samples.set(controller.id, sample);
		return;
	}
	if (config.applyPosition !== false) {
		target.position.addInPlace(sample.position.subtract(previous.position));
	}
	if (config.applyRotationY) {
		target.rotation.y += sample.rotationY - previous.rotationY;
	}
	samples.set(controller.id, sample);
}

function advanceAnimatorControllerRuntime(scene: Scene, controller: IAnimatorController, deltaSeconds: number, ignorePause = false): boolean {
	const debug = getAnimatorRuntimeDebugState(scene, controller.id);
	if (debug.paused && !ignorePause) {
		return false;
	}
	const previousSequence = debug.history[debug.history.length - 1]?.sequence ?? 0;
	debug.runtimeSeconds += deltaSeconds;
	const elapsed = animatorElapsedSeconds.get(scene)!;
	const consumedTriggers = new Set<string>();
	advanceAnimatorFade(scene, controller, deltaSeconds);
	const baseMachine = compileControllerMachine(controller);
	const state = baseMachine.states.find((candidate) => candidate.name === controller.activeState);
	if (state) {
		const total = (elapsed.get(controller.id) ?? 0) + deltaSeconds;
		elapsed.set(controller.id, total);
		const progress = stateProgress(scene, controller, state, total);
		applyStateWriteDefaults(scene, controller, state);
		seekStateGroups(scene, controller, state, progress);
		if (getBehaviourActiveStates(scene).get(behaviourStateKey(controller))?.name === state.name) {
			invokeAnimatorStateBehaviours(scene as any, controller, state, "update", { elapsedSeconds: total, normalizedTime: progress, deltaSeconds });
		}
		const activeFade = animatorFades.get(scene)?.get(`${controller.id}:base`);
		const transition = activeFade
			? findInterruptionTransition(baseMachine.transitions, activeFade, controller.parameters)
			: findEligibleTransition(baseMachine.transitions, state.name, controller.parameters, progress);
		if (transition) {
			applyBaseTransition(scene, controller, transition);
			for (const condition of transition.transition.conditions ?? []) {
				if (controller.parameterTypes?.[condition.parameter] === "trigger") {
					consumedTriggers.add(condition.parameter);
				}
			}
		}
	}
	for (const layer of controller.layers ?? []) {
		if (layer.synchronizedLayer) {
			synchronizeAnimatorLayer(scene, controller, layer);
			const synchronizedState = getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer));
			if (synchronizedState) {
				const elapsedKey = `${controller.id}:layer:${layer.name}`;
				const total = elapsed.get(elapsedKey) ?? 0;
				const progress = stateProgress(scene, controller, synchronizedState, total, layer);
				invokeAnimatorStateBehaviours(scene as any, controller, synchronizedState, "update", {
					layerName: layer.name,
					elapsedSeconds: total,
					normalizedTime: progress,
					deltaSeconds,
				});
			}
			continue;
		}
		const layerMachine = compileLayerMachine(controller, layer);
		const layerState = layerMachine.states.find((candidate) => candidate.name === layer.activeState);
		if (!layerState) {
			continue;
		}
		const elapsedKey = `${controller.id}:layer:${layer.name}`;
		const total = (elapsed.get(elapsedKey) ?? 0) + deltaSeconds;
		elapsed.set(elapsedKey, total);
		const progress = stateProgress(scene, controller, layerState, total, layer);
		applyStateWriteDefaults(scene, controller, layerState, layer);
		seekStateGroups(scene, controller, layerState, progress, layer);
		if (getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer))?.name === layerState.name) {
			invokeAnimatorStateBehaviours(scene as any, controller, layerState, "update", {
				layerName: layer.name,
				elapsedSeconds: total,
				normalizedTime: progress,
				deltaSeconds,
			});
		}
		const activeFade = animatorFades.get(scene)?.get(`${controller.id}:layer:${layer.name}`);
		const transition = activeFade
			? findInterruptionTransition(layerMachine.transitions, activeFade, controller.parameters)
			: findEligibleTransition(layerMachine.transitions, layerState.name, controller.parameters, progress);
		if (transition) {
			applyLayerTransition(scene, controller, layer, transition);
			for (const condition of transition.transition.conditions ?? []) {
				if (controller.parameterTypes?.[condition.parameter] === "trigger") {
					consumedTriggers.add(condition.parameter);
				}
			}
		}
	}
	for (const parameter of consumedTriggers) {
		controller.parameters[parameter] = false;
	}
	if (state) {
		applyAnimatorFootIK(scene as any, controller, { name: "$base", weight: 1 }, state);
	}
	for (const layer of controller.layers ?? []) {
		const footIKState = layer.synchronizedLayer
			? getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer))
			: compileLayerMachine(controller, layer).states.find((candidate) => candidate.name === layer.activeState);
		if (footIKState) {
			applyAnimatorFootIK(scene as any, controller, layer, footIKState);
		}
	}
	if (controller.baseIKPass === true) {
		const ikState = compileControllerMachine(controller).states.find((candidate) => candidate.name === controller.activeState);
		if (ikState) {
			const elapsedSeconds = elapsed.get(controller.id) ?? 0;
			const normalizedTime = stateProgress(scene, controller, ikState, elapsedSeconds);
			invokeAnimatorIKPass(scene as any, controller, { name: "$base", weight: 1, ikPass: true }, ikState, {
				elapsedSeconds,
				normalizedTime,
				deltaSeconds,
			});
		}
	}
	for (const layer of controller.layers ?? []) {
		if (layer.ikPass !== true) {
			continue;
		}
		const ikState = layer.synchronizedLayer
			? getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer))
			: compileLayerMachine(controller, layer).states.find((candidate) => candidate.name === layer.activeState);
		if (!ikState) {
			continue;
		}
		const elapsedSeconds = elapsed.get(`${controller.id}:layer:${layer.name}`) ?? 0;
		const normalizedTime = stateProgress(scene, controller, ikState, elapsedSeconds, layer);
		invokeAnimatorIKPass(scene as any, controller, layer, ikState, { elapsedSeconds, normalizedTime, deltaSeconds });
	}
	applyRootMotion(scene, controller);
	captureAnimatorHumanoidMuscleTrace(scene as any, controller, { runtimeSeconds: debug.runtimeSeconds, deltaSeconds });
	if (debug.paused) {
		setAnimatorMotionGroupsPaused(scene, controller, true);
	}
	const latest = debug.history[debug.history.length - 1];
	return !!latest && latest.sequence > previousSequence && latest.hitBreakpointIds.length > 0;
}

function ensureRootMotion(scene: Scene): void {
	if (rootMotionObservers.has(scene)) {
		return;
	}
	rootMotionSamples.set(scene, new Map());
	animatorElapsedSeconds.set(scene, new Map());
	animatorFades.set(scene, new Map());
	animatorBehaviourActiveStates.set(scene, new Map());
	rootMotionObservers.set(
		scene,
		scene.onBeforeRenderObservable.add(
			() => {
				const deltaSeconds = scene.getEngine().getDeltaTime() / 1000;
				for (const controller of getControllers(scene)) {
					advanceAnimatorControllerRuntime(scene, controller, deltaSeconds);
				}
			},
			-1,
			true
		)
	);
}

function getControllers(scene: Scene): IAnimatorController[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorAnimatorControllers ??= [];
	return scene.metadata.babylonEditorAnimatorControllers;
}

function findController(scene: Scene, data: any): IAnimatorController {
	const controllers = (scene.metadata?.babylonEditorAnimatorControllers as IAnimatorController[] | undefined) ?? [];
	const controller = controllers.find((candidate) => candidate.id === data.controllerId || candidate.name === data.controllerName);
	if (!controller) {
		throw new Error("Animator controller not found. Provide controllerId (preferred) or controllerName.");
	}
	return controller;
}

function humanoidAvatars(scene: Scene): IHumanoidAvatar[] {
	return ((scene.metadata?.babylonEditorHumanoidAvatars as IHumanoidAvatar[] | undefined) ?? []).filter((avatar) => avatar.animationType === "humanoid");
}

function validateControllerHumanoidAvatar(scene: Scene, avatarId: string | undefined): IHumanoidAvatar | null {
	if (avatarId === undefined) {
		return null;
	}
	const avatar = humanoidAvatars(scene).find((candidate) => candidate.id === avatarId);
	if (!avatar) {
		throw new Error(`Humanoid Avatar "${avatarId}" was not found.`);
	}
	if (!scene.skeletons.some((skeleton) => skeleton.id === avatar.skeletonId)) {
		throw new Error(`Skeleton "${avatar.skeletonId}" for Humanoid Avatar "${avatarId}" was not found.`);
	}
	return avatar;
}

function normalizeMuscleTraceRoles(roles: unknown): HumanBone[] | undefined {
	if (roles === undefined) {
		return undefined;
	}
	if (!Array.isArray(roles) || roles.length > HUMAN_BONES.length) {
		throw new Error(`roles must be an array of at most ${HUMAN_BONES.length} Humanoid bone roles.`);
	}
	const known = new Set<string>(HUMAN_BONES);
	const normalized = roles.map((role) => {
		if (typeof role !== "string" || !known.has(role)) {
			throw new Error(`Unknown Humanoid muscle role "${String(role)}".`);
		}
		return role as HumanBone;
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new Error("roles must not contain duplicates.");
	}
	return normalized;
}

function animatorHumanoidMuscleTraceFingerprint(scene: Scene, controller: IAnimatorController): string {
	const avatar = controller.humanoidAvatarId ? humanoidAvatars(scene).find((candidate) => candidate.id === controller.humanoidAvatarId) : null;
	const skeleton = avatar ? scene.skeletons.find((candidate) => candidate.id === avatar.skeletonId) : null;
	const trace = getAnimatorHumanoidMuscleTrace(scene as any, controller, { limit: 1 });
	return createHash("sha256")
		.update(
			JSON.stringify({
				controller: { id: controller.id, name: controller.name, humanoidAvatarId: controller.humanoidAvatarId ?? null },
				avatar: avatar ?? null,
				skeleton: skeleton ? skeleton.bones.map((bone) => ({ name: bone.name, parentName: bone.getParent()?.name ?? null, index: bone.getIndex() })) : null,
				trace: {
					revision: trace.revision,
					total: trace.history.total,
					droppedSampleCount: trace.droppedSampleCount,
					latestSequence: trace.latest?.sequence ?? null,
					lastError: trace.lastError,
				},
			})
		)
		.digest("hex");
}

function compileControllerMachine(controller: IAnimatorController): ICompiledAnimatorMachine {
	return compileAnimatorMachine(controller, controller.subgraphs ?? []);
}

function compileLayerMachine(controller: IAnimatorController, layer: IAnimatorLayer): ICompiledAnimatorMachine {
	return compileAnimatorMachine(layer, controller.subgraphs ?? []);
}

function resolveAnimatorEntryState(machine: ICompiledAnimatorMachine, parameters: IAnimatorController["parameters"], routes = machine.entryTransitions): string {
	return routes.find((route) => route.fallback || conditionsMatch(parameters, route.conditions ?? []))?.to ?? machine.entryState;
}

function resolveCompiledState(machine: ICompiledAnimatorMachine, name: string, parameters?: IAnimatorController["parameters"]): IAnimatorState {
	const entryRoutes = machine.machineEntryTransitions[name];
	const resolvedName = machine.states.some((state) => state.name === name)
		? name
		: entryRoutes && parameters
			? resolveAnimatorEntryState(machine, parameters, entryRoutes)
			: (machine.nodeEntries[name] ?? name);
	const state = machine.states.find((candidate) => candidate.name === resolvedName);
	if (!state) {
		throw new Error(`Animator state or sub-state-machine "${name}" was not found.`);
	}
	return state;
}

function synchronizedTargetState(controller: IAnimatorController, layer: IAnimatorLayer, sourceState: IAnimatorState): IAnimatorState {
	const targetMachine = compileLayerMachine(controller, layer);
	const mappedName = layer.synchronizedStateMap?.[sourceState.name] ?? sourceState.name;
	const exact = targetMachine.states.find((candidate) => candidate.name === mappedName);
	const sourceStateName = (sourceState as ICompiledAnimatorState).sourceStateName ?? sourceState.name;
	const sourceNameMatches = targetMachine.states.filter((candidate) => candidate.sourceStateName === sourceStateName);
	const targetState = exact ?? (sourceNameMatches.length === 1 ? sourceNameMatches[0] : undefined);
	if (!targetState) {
		throw new Error(`Animator synchronized layer "${layer.name}" cannot map source state "${sourceState.name}".`);
	}
	const overrideKey = Object.prototype.hasOwnProperty.call(layer.synchronizedMotionOverrides ?? {}, sourceState.name)
		? sourceState.name
		: Object.prototype.hasOwnProperty.call(layer.synchronizedMotionOverrides ?? {}, sourceStateName)
			? sourceStateName
			: null;
	const behaviourKey = Object.prototype.hasOwnProperty.call(layer.synchronizedBehaviourOverrides ?? {}, sourceState.name)
		? sourceState.name
		: Object.prototype.hasOwnProperty.call(layer.synchronizedBehaviourOverrides ?? {}, sourceStateName)
			? sourceStateName
			: null;
	const motionOverride = overrideKey ? layer.synchronizedMotionOverrides?.[overrideKey] : undefined;
	const behaviourOverride = behaviourKey ? layer.synchronizedBehaviourOverrides?.[behaviourKey] : undefined;
	return {
		...targetState,
		synchronizedSourceState: sourceState.name,
		...(motionOverride
			? {
					animationGroup: motionOverride.animationGroup,
					blendTree: motionOverride.blendTree,
				}
			: {}),
		...(behaviourOverride ? { behaviours: behaviourOverride } : behaviourKey ? { behaviours: [] } : {}),
	};
}

function effectiveStateDuration(scene: Scene, controller: IAnimatorController, state: IAnimatorState, sourceLayer?: IAnimatorLayer): number | null {
	let duration = stateDurationSeconds(scene, controller, state);
	if (!duration || sourceLayer?.synchronizedLayer) {
		return duration;
	}
	const sourceName = sourceLayer?.name ?? "$base";
	for (const layer of controller.layers ?? []) {
		if (layer.synchronizedLayer !== sourceName || layer.synchronizedTiming !== true) {
			continue;
		}
		const targetDuration = stateDurationSeconds(scene, controller, synchronizedTargetState(controller, layer, state));
		if (targetDuration) {
			duration += (targetDuration - duration) * Math.min(1, Math.max(0, layer.weight ?? 1));
		}
	}
	return duration;
}

function stateProgress(scene: Scene, controller: IAnimatorController, state: IAnimatorState, elapsedSeconds: number, layer?: IAnimatorLayer): number {
	const playback = resolveAnimatorStatePlayback(state, controller.parameters);
	if (playback.time !== null) {
		return (state.loop ?? true) ? ((playback.time % 1) + 1) % 1 : Math.min(1, Math.max(0, playback.time));
	}
	const duration = effectiveStateDuration(scene, controller, state, layer);
	return duration ? ((state.loop ?? true) ? (elapsedSeconds % duration) / duration : Math.min(1, elapsedSeconds / duration)) : 0;
}

function stateMotionPhase(controller: IAnimatorController, state: IAnimatorState, motion: IAnimatorBlendTreeMotion, normalizedTime: number): number {
	const playback = resolveAnimatorStatePlayback(state, controller.parameters);
	const raw = normalizedTime * (playback.timeDriven ? 1 : Math.sign(playback.effectiveSpeed || 1)) * motion.timeScale + motion.cycleOffset;
	return (state.loop ?? true) ? ((raw % 1) + 1) % 1 : Math.min(1, Math.max(0, raw));
}

function seekStateGroups(scene: Scene, controller: IAnimatorController, state: IAnimatorState, normalizedTime: number, layer?: IAnimatorLayer): void {
	for (const motion of stateMotions(controller, state)) {
		const group = resolveStateMotionGroup(scene, controller, state, motion, layer);
		if (group?.isStarted) {
			const phase = stateMotionPhase(controller, state, motion, normalizedTime);
			group.goToFrame(group.from + (group.to - group.from) * phase);
		}
	}
}

function inferParameterType(value: string | number | boolean): IAnimatorParameterType {
	if (typeof value === "boolean") {
		return "bool";
	}
	if (typeof value === "number") {
		return "float";
	}
	return "string";
}

function defaultParameterValue(type: IAnimatorParameterType): string | number | boolean {
	if (type === "float" || type === "int") {
		return 0;
	}
	if (type === "bool" || type === "trigger") {
		return false;
	}
	return "";
}

function validateParameterValue(name: string, type: IAnimatorParameterType, value: string | number | boolean): void {
	if (type === "float" && (typeof value !== "number" || !Number.isFinite(value))) {
		throw new Error(`Animator float parameter "${name}" requires a finite number.`);
	}
	if (type === "int" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
		throw new Error(`Animator int parameter "${name}" requires a safe integer.`);
	}
	if ((type === "bool" || type === "trigger") && typeof value !== "boolean") {
		throw new Error(`Animator ${type} parameter "${name}" requires a boolean value.`);
	}
	if (type === "string" && typeof value !== "string") {
		throw new Error(`Legacy Animator string parameter "${name}" requires a string value.`);
	}
}

function normalizeParameterTypes(parameters: IAnimatorController["parameters"], parameterTypes?: Record<string, IAnimatorParameterType>): Record<string, IAnimatorParameterType> {
	const normalized: Record<string, IAnimatorParameterType> = {};
	for (const [name, value] of Object.entries(parameters)) {
		const type = parameterTypes?.[name] ?? inferParameterType(value);
		if (!["float", "int", "bool", "trigger", "string"].includes(type)) {
			throw new Error(`Animator parameter "${name}" has unsupported type "${String(type)}".`);
		}
		validateParameterValue(name, type, value);
		normalized[name] = type;
	}
	const unknownType = Object.keys(parameterTypes ?? {}).find((name) => !(name in parameters));
	if (unknownType) {
		throw new Error(`Animator parameter type "${unknownType}" has no matching parameter value.`);
	}
	return normalized;
}

function validateStates(scene: Scene, states: IAnimatorState[]): void {
	if (!Array.isArray(states) || !states.length) {
		throw new Error("Animator controllers require at least one state.");
	}
	const names = new Set<string>();
	for (const state of states) {
		if (!state?.name || (!state.animationGroup && !state.blendTree)) {
			throw new Error("Each animator state requires a name and animationGroup or blendTree.");
		}
		if (state.name === ANIMATOR_ANY_STATE || state.name === ANIMATOR_EXIT_STATE) {
			throw new Error(`Animator state name "${state.name}" is reserved for the state-machine graph.`);
		}
		validateAnimatorStateBehaviours(state.behaviours);
		if (names.has(state.name)) {
			throw new Error(`Animator state "${state.name}" is duplicated.`);
		}
		if (state.animationGroup && !scene.getAnimationGroupByName(state.animationGroup)) {
			throw new Error(`Animation group "${state.animationGroup}" was not found.`);
		}
		if (state.blendTree) {
			validateBlendTree(scene, state.name, state.blendTree);
		}
		if (state.speed !== undefined && (!Number.isFinite(state.speed) || state.speed === 0)) {
			throw new Error(`Animator state "${state.name}" speed must be a finite non-zero number.`);
		}
		if (state.cycleOffset !== undefined && (!Number.isFinite(state.cycleOffset) || state.cycleOffset < 0 || state.cycleOffset > 1)) {
			throw new Error(`Animator state "${state.name}" cycleOffset must be normalized between 0 and 1.`);
		}
		if (state.tag !== undefined && (typeof state.tag !== "string" || state.tag.length > 256)) {
			throw new Error(`Animator state "${state.name}" tag cannot exceed 256 characters.`);
		}
		if (state.graphPosition && (state.graphPosition.length !== 2 || state.graphPosition.some((value) => !Number.isFinite(value)))) {
			throw new Error(`Animator state "${state.name}" graphPosition must contain two finite numbers.`);
		}
		validateMaskReference(scene, state.avatarMaskId, `Animator state "${state.name}"`);
		const knownTargets = new Set(getStateTargetNames(scene, state));
		const unknownTarget = (state.maskTargetNames ?? []).find((targetName) => !knownTargets.has(targetName));
		if (unknownTarget) {
			throw new Error(`Animator state "${state.name}" mask target "${unknownTarget}" is not animated by its clips.`);
		}
		names.add(state.name);
	}
}

function validateBlendTree(scene: Scene, stateName: string, tree: NonNullable<IAnimatorState["blendTree"]>, depth = 0, counter = { children: 0 }): void {
	if (depth > 6) {
		throw new Error(`Blend tree state "${stateName}" cannot exceed 6 nested levels.`);
	}
	if (tree.children.length < 2 || tree.children.length > 64) {
		throw new Error(`Blend tree state "${stateName}" requires between 2 and 64 children per tree.`);
	}
	counter.children += tree.children.length;
	if (counter.children > 256) {
		throw new Error(`Blend tree state "${stateName}" cannot contain more than 256 recursive children.`);
	}
	const isDirect = tree.blendMode === "direct";
	const is2D = !isDirect && (!!tree.parameterX || !!tree.parameterY);
	if (is2D && (!tree.parameterX || !tree.parameterY)) {
		throw new Error(`2D blend tree state "${stateName}" requires parameterX and parameterY.`);
	}
	if (tree.blendMode && !["cartesian", "directional", "freeformDirectional", "direct"].includes(tree.blendMode)) {
		throw new Error(`Blend tree state "${stateName}" blendMode must be cartesian, directional, freeformDirectional, or direct.`);
	}
	if (isDirect && (tree.parameter || tree.parameterX || tree.parameterY)) {
		throw new Error(`Direct blend tree state "${stateName}" uses per-child directParameter values instead of tree parameters.`);
	}
	if (!isDirect && !is2D && !tree.parameter) {
		throw new Error(`1D blend tree state "${stateName}" requires a parameter.`);
	}
	if (tree.normalizeWeights !== undefined && (!isDirect || typeof tree.normalizeWeights !== "boolean")) {
		throw new Error(`Blend tree state "${stateName}" normalizeWeights is a Direct-mode boolean.`);
	}
	const locations = new Set<string>();
	for (const child of tree.children) {
		if (child.timeScale !== undefined && (!Number.isFinite(child.timeScale) || child.timeScale === 0)) {
			throw new Error(`Blend tree state "${stateName}" child timeScale must be a finite non-zero number.`);
		}
		if (child.cycleOffset !== undefined && (!Number.isFinite(child.cycleOffset) || child.cycleOffset < 0 || child.cycleOffset > 1)) {
			throw new Error(`Blend tree state "${stateName}" child cycleOffset must be normalized between 0 and 1.`);
		}
		if (child.mirror !== undefined && typeof child.mirror !== "boolean") {
			throw new Error(`Blend tree state "${stateName}" child mirror must be a boolean.`);
		}
		if ((isDirect && (child.threshold !== undefined || child.position !== undefined)) || (!isDirect && child.directParameter !== undefined)) {
			throw new Error(`Blend tree state "${stateName}" child coordinates must match its 1D, 2D, or Direct mode.`);
		}
		const location = isDirect ? child.directParameter : is2D ? child.position : child.threshold;
		if (
			!!child.animationGroup === !!child.blendTree ||
			(isDirect
				? !child.directParameter
				: is2D
					? !Array.isArray(child.position) ||
						child.position.length !== 2 ||
						child.position.some((value) => !Number.isFinite(value)) ||
						locations.has(child.position.join(","))
					: !Number.isFinite(child.threshold) || locations.has(String(child.threshold)))
		) {
			throw new Error(
				`Blend tree state "${stateName}" requires one Animation Group or nested Blend Tree per child and ${isDirect ? "a non-empty directParameter per child" : `finite unique ${is2D ? "2D positions" : "thresholds"}`}.`
			);
		}
		if (child.animationGroup && !scene.getAnimationGroupByName(child.animationGroup)) {
			throw new Error(`Animation group "${child.animationGroup}" was not found.`);
		}
		if (child.blendTree) {
			validateBlendTree(scene, stateName, child.blendTree, depth + 1, counter);
		}
		if (!isDirect) {
			locations.add(is2D ? (location as number[]).join(",") : String(location));
		}
	}
}

function validateBlendTreeParameters(parameters: IAnimatorController["parameters"], states: IAnimatorState[]): void {
	for (const state of states) {
		if (!state.blendTree) {
			continue;
		}
		for (const parameter of getAnimatorBlendTreeParameters(state.blendTree)) {
			if (!parameter || typeof parameters[parameter] !== "number") {
				throw new Error(`Blend tree state "${state.name}" requires numeric parameter "${parameter}".`);
			}
		}
	}
}

function stateGroups(state: IAnimatorState): string[] {
	return state.blendTree ? getAnimatorBlendTreeAnimationGroups(state.blendTree) : state.animationGroup ? [state.animationGroup] : [];
}

function humanoidMaskNames(scene: Scene, maskId: string): string[] {
	const mask = (scene.metadata?.babylonEditorHumanoidAvatarMasks as IHumanoidAvatarMask[] | undefined)?.find((candidate) => candidate.id === maskId);
	if (!mask) {
		throw new Error(`Humanoid Avatar Mask "${maskId}" was not found.`);
	}
	const avatar = (scene.metadata?.babylonEditorHumanoidAvatars as IHumanoidAvatar[] | undefined)?.find((candidate) => candidate.id === mask.avatarId);
	if (!avatar) {
		throw new Error(`Humanoid Avatar "${mask.avatarId}" referenced by mask "${mask.name}" was not found.`);
	}
	return resolveHumanoidAvatarMaskTargetNames(avatar, mask.bodyParts, mask.transformNames);
}

function validateMaskReference(scene: Scene, maskId: string | undefined, owner: string): void {
	if (!maskId) {
		return;
	}
	try {
		humanoidMaskNames(scene, maskId);
	} catch (error) {
		throw new Error(`${owner} has an invalid Avatar Mask: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function applyStateMask(
	scene: Scene,
	state: IAnimatorState,
	fallbackTargetNames: string[] = [],
	fallbackAvatarMaskId?: string,
	controller?: IAnimatorController,
	layer?: IAnimatorLayer
): void {
	const avatarMaskId = state.avatarMaskId ?? fallbackAvatarMaskId;
	const legacyNames = state.maskTargetNames ?? fallbackTargetNames;
	const names = [...new Set([...(avatarMaskId ? humanoidMaskNames(scene, avatarMaskId) : []), ...legacyNames])];
	const configured = !!avatarMaskId || names.length > 0;
	const motions = controller
		? stateMotions(controller, state)
		: state.blendTree
			? getAnimatorBlendTreeMotions(state.blendTree)
			: state.animationGroup
				? [{ key: "state", animationGroup: state.animationGroup, timeScale: 1, cycleOffset: state.cycleOffset ?? 0, mirror: state.mirror === true }]
				: [];
	for (const motion of motions) {
		const group = controller ? resolveStateMotionGroup(scene, controller, state, motion, layer) : scene.getAnimationGroupByName(motion.animationGroup);
		if (group) {
			group.mask = configured ? new AnimationGroupMask(names) : null;
		}
	}
}

function getStateTargetNames(scene: Scene, state: IAnimatorState): string[] {
	return [
		...new Set(
			stateGroups(state).flatMap(
				(groupName) =>
					scene
						.getAnimationGroupByName(groupName)
						?.targetedAnimations.map((targeted) => targeted.target?.name)
						.filter(Boolean) ?? []
			)
		),
	];
}

function applyBlendTree(scene: Scene, controller: IAnimatorController, state: IAnimatorState, weight = 1, layer?: IAnimatorLayer): void {
	const tree = state.blendTree;
	if (!tree) {
		return;
	}
	for (const evaluatedMotion of evaluateAnimatorBlendTreeMotions(tree, controller.parameters)) {
		const motion = stateMotion(controller, state, evaluatedMotion);
		const group = resolveStateMotionGroup(scene, controller, state, motion, layer);
		if (group) {
			group.weight = motion.weight * weight;
		}
	}
}

function applyStateWeight(scene: Scene, controller: IAnimatorController, state: IAnimatorState, weight: number, layer?: IAnimatorLayer): void {
	if (state.blendTree) {
		applyBlendTree(scene, controller, state, weight, layer);
	} else {
		stateMotions(controller, state).forEach((motion) => {
			const group = resolveStateMotionGroup(scene, controller, state, motion, layer);
			if (group) {
				group.weight = weight;
			}
		});
	}
}

function fadeWeights(fade: IAnimatorFade): Map<string, { state: IAnimatorState; weight: number }> {
	const amount = Math.min(1, fade.elapsed / fade.duration);
	const weights = new Map<string, { state: IAnimatorState; weight: number }>();
	for (const source of fade.sources) {
		const weight = source.weight * (1 - amount);
		if (weight > 0) {
			weights.set(source.state.name, { state: source.state, weight });
		}
	}
	if (fade.to) {
		const weight = fade.toStartWeight + (fade.targetWeight - fade.toStartWeight) * amount;
		if (weight > 0) {
			weights.set(fade.to.name, { state: fade.to, weight });
		}
	}
	return weights;
}

function advanceAnimatorFade(scene: Scene, controller: IAnimatorController, deltaSeconds: number): void {
	const fades = animatorFades.get(scene)!;
	for (const [key, fade] of fades) {
		if (!key.startsWith(`${controller.id}:`)) {
			continue;
		}
		fade.elapsed += deltaSeconds;
		const amount = Math.min(1, fade.elapsed / fade.duration);
		for (const source of fade.sources) {
			applyStateWeight(scene, controller, source.state, source.weight * (1 - amount), fade.layer);
		}
		if (fade.to) {
			applyStateWeight(scene, controller, fade.to, fade.toStartWeight + (fade.targetWeight - fade.toStartWeight) * amount, fade.layer);
		}
		if (amount < 1) {
			continue;
		}
		for (const source of fade.sources) {
			if (fade.to) {
				stopStateGroupsExcept(scene, controller, source.state, fade.to, fade.layer);
			} else {
				stopStateGroups(scene, controller, source.state, fade.layer);
			}
		}
		fades.delete(key);
	}
}

function validateTransitions(machine: IAnimatorGraphMachine): void {
	const names = new Set([...machine.states.map((state) => state.name), ...(machine.subStateMachines ?? []).map((instance) => instance.name)]);
	for (const transition of machine.entryTransitions ?? []) {
		if (!names.has(transition.to)) {
			throw new Error(`Animator Entry transition destination "${transition.to}" must reference an existing state or sub-state-machine.`);
		}
		for (const condition of transition.conditions ?? []) {
			const operatorCount = [condition.equals, condition.notEquals, condition.greaterThan, condition.lessThan].filter((value) => value !== undefined).length;
			if (!condition.parameter || operatorCount !== 1) {
				throw new Error("Animator Entry transition conditions require a parameter and exactly one equals, notEquals, greaterThan, or lessThan operator.");
			}
		}
	}
	for (const transition of machine.transitions ?? []) {
		if (!names.has(transition.from) && transition.from !== ANIMATOR_ANY_STATE) {
			throw new Error(`Animator transition source "${transition.from}" must reference an existing state or "${ANIMATOR_ANY_STATE}".`);
		}
		if (!names.has(transition.to) && transition.to !== ANIMATOR_EXIT_STATE) {
			throw new Error(`Animator transition destination "${transition.to}" must reference an existing state or "${ANIMATOR_EXIT_STATE}".`);
		}
		if (transition.from === ANIMATOR_ANY_STATE && transition.to === ANIMATOR_EXIT_STATE) {
			throw new Error("An Any State transition cannot exit the state machine without first entering a concrete state.");
		}
		if (transition.exitTime !== undefined && (!Number.isFinite(transition.exitTime) || transition.exitTime < 0 || transition.exitTime > 1)) {
			throw new Error("Animator transition exitTime must be a normalized value between 0 and 1.");
		}
		if (transition.duration !== undefined && (!Number.isFinite(transition.duration) || transition.duration < 0)) {
			throw new Error("Animator transition duration must be a finite number of seconds greater than or equal to 0.");
		}
		if (transition.durationMode !== undefined && transition.durationMode !== "seconds" && transition.durationMode !== "normalized") {
			throw new Error("Animator transition durationMode must be seconds or normalized.");
		}
		if (transition.offset !== undefined && (!Number.isFinite(transition.offset) || transition.offset < 0 || transition.offset > 1)) {
			throw new Error("Animator transition offset must be a normalized value between 0 and 1.");
		}
		if (
			transition.interruptionSource !== undefined &&
			!["none", "source", "destination", "sourceThenDestination", "destinationThenSource"].includes(transition.interruptionSource)
		) {
			throw new Error("Animator transition interruptionSource is invalid.");
		}
		if (transition.orderedInterruption !== undefined && typeof transition.orderedInterruption !== "boolean") {
			throw new Error("Animator transition orderedInterruption must be a boolean.");
		}
		if (transition.canTransitionToSelf !== undefined && typeof transition.canTransitionToSelf !== "boolean") {
			throw new Error("Animator transition canTransitionToSelf must be a boolean.");
		}
		if (transition.to === ANIMATOR_EXIT_STATE && transition.offset !== undefined) {
			throw new Error("Animator Exit transitions cannot use a destination offset.");
		}
		for (const condition of transition.conditions ?? []) {
			const operatorCount = [condition.equals, condition.notEquals, condition.greaterThan, condition.lessThan].filter((value) => value !== undefined).length;
			if (!condition.parameter || operatorCount !== 1) {
				throw new Error("Animator transition conditions require a parameter and exactly one equals, notEquals, greaterThan, or lessThan operator.");
			}
		}
	}
}

function validateTransitionParameters(
	parameters: IAnimatorController["parameters"],
	parameterTypes: Record<string, IAnimatorParameterType>,
	transitions: Array<Pick<IAnimatorTransition, "conditions">>,
	owner: string
): void {
	for (const transition of transitions) {
		for (const condition of transition.conditions ?? []) {
			if (!(condition.parameter in parameters)) {
				throw new Error(`${owner} transition condition references missing parameter "${condition.parameter}".`);
			}
			const type = parameterTypes[condition.parameter];
			if ((condition.greaterThan !== undefined || condition.lessThan !== undefined) && type !== "float" && type !== "int") {
				throw new Error(`${owner} numeric transition condition requires a float or int parameter, not "${type}".`);
			}
			if (type === "trigger" && condition.equals !== true) {
				throw new Error(`${owner} trigger condition "${condition.parameter}" must use equals: true.`);
			}
		}
	}
}

function validateStatePlaybackParameters(
	parameters: IAnimatorController["parameters"],
	parameterTypes: Record<string, IAnimatorParameterType>,
	states: IAnimatorState[],
	owner: string
): void {
	for (const state of states) {
		for (const [field, parameter, expectedType] of [
			["speedParameter", state.speedParameter === undefined ? state.unitySource?.speedParameter : state.speedParameter, "float"],
			["mirrorParameter", state.mirrorParameter === undefined ? state.unitySource?.mirrorParameter : state.mirrorParameter, "bool"],
			["cycleOffsetParameter", state.cycleOffsetParameter === undefined ? state.unitySource?.cycleOffsetParameter : state.cycleOffsetParameter, "float"],
			["timeParameter", state.timeParameter === undefined ? state.unitySource?.timeParameter : state.timeParameter, "float"],
		] as const) {
			if (!parameter) {
				continue;
			}
			if (!Object.prototype.hasOwnProperty.call(parameters, parameter)) {
				throw new Error(`${owner} state "${state.name}" ${field} references missing parameter "${parameter}".`);
			}
			if (parameterTypes[parameter] !== expectedType) {
				throw new Error(`${owner} state "${state.name}" ${field} requires a ${expectedType} parameter, not "${parameterTypes[parameter]}".`);
			}
		}
	}
}

function validateEntryState(machine: IAnimatorGraphMachine, entryState: string | undefined, owner: string): string {
	const resolved = entryState ?? machine.states[0]?.name;
	if (!resolved || (!machine.states.some((state) => state.name === resolved) && !(machine.subStateMachines ?? []).some((instance) => instance.name === resolved))) {
		throw new Error(`${owner} entryState must reference an existing direct state or sub-state-machine.`);
	}
	return resolved;
}

function validateSubgraphs(
	scene: Scene,
	parameters: IAnimatorController["parameters"],
	parameterTypes: Record<string, IAnimatorParameterType>,
	subgraphs: IAnimatorSubgraphDefinition[]
): void {
	for (const subgraph of subgraphs) {
		validateStates(scene, subgraph.states);
		validateBlendTreeParameters(parameters, subgraph.states);
		validateStatePlaybackParameters(parameters, parameterTypes, subgraph.states, `Animator subgraph "${subgraph.name}"`);
		validateTransitions(subgraph);
		validateTransitionParameters(parameters, parameterTypes, subgraph.transitions ?? [], `Animator subgraph "${subgraph.name}"`);
		validateTransitionParameters(parameters, parameterTypes, subgraph.entryTransitions ?? [], `Animator subgraph "${subgraph.name}" Entry`);
		validateEntryState(subgraph, subgraph.entryState ?? subgraph.activeState, `Animator subgraph "${subgraph.name}"`);
	}
}

function validateLayers(
	scene: Scene,
	parameters: IAnimatorController["parameters"],
	parameterTypes: Record<string, IAnimatorParameterType>,
	layers: IAnimatorLayer[],
	subgraphs: IAnimatorSubgraphDefinition[],
	rootMachine: IAnimatorGraphMachine
): void {
	const names = new Set<string>();
	for (const layer of layers) {
		if (!layer.name || names.has(layer.name)) {
			throw new Error("Animator layer names must be unique.");
		}
		if (layer.weight !== undefined && (!Number.isFinite(layer.weight) || layer.weight < 0 || layer.weight > 1)) {
			throw new Error(`Animator layer "${layer.name}" weight must be between 0 and 1.`);
		}
		if (layer.blendingMode !== undefined && layer.blendingMode !== "override" && layer.blendingMode !== "additive") {
			throw new Error(`Animator layer "${layer.name}" blendingMode must be override or additive.`);
		}
		if (
			layer.referencePose !== undefined &&
			(!Number.isFinite(layer.referencePose.normalizedTime) || layer.referencePose.normalizedTime < 0 || layer.referencePose.normalizedTime > 1)
		) {
			throw new Error(`Animator layer "${layer.name}" reference pose normalizedTime must be between 0 and 1.`);
		}
		if (layer.synchronizedLayer && (layer.transitions.length || (layer.entryTransitions?.length ?? 0))) {
			throw new Error(`Animator synchronized layer "${layer.name}" inherits transitions and Entry routing from its source and cannot define independent transitions.`);
		}
		if (layer.synchronizedLayer !== undefined && layer.synchronizedLayer !== "$base" && !names.has(layer.synchronizedLayer)) {
			throw new Error(`Animator synchronized layer "${layer.name}" must reference the base or an earlier layer.`);
		}
		if (layer.synchronizedTiming !== undefined && typeof layer.synchronizedTiming !== "boolean") {
			throw new Error(`Animator layer "${layer.name}" synchronizedTiming must be a boolean.`);
		}
		if (Object.keys(layer.synchronizedStateMap ?? {}).length > 512) {
			throw new Error(`Animator layer "${layer.name}" synchronizedStateMap cannot contain more than 512 entries.`);
		}
		if (Object.keys(layer.synchronizedMotionOverrides ?? {}).length > 512 || Object.keys(layer.synchronizedBehaviourOverrides ?? {}).length > 512) {
			throw new Error(`Animator layer "${layer.name}" synchronized overrides cannot contain more than 512 source states.`);
		}
		if (!layer.synchronizedLayer && (Object.keys(layer.synchronizedMotionOverrides ?? {}).length || Object.keys(layer.synchronizedBehaviourOverrides ?? {}).length)) {
			throw new Error(`Animator layer "${layer.name}" must be synchronized before defining motion or behaviour overrides.`);
		}
		validateStates(scene, layer.states);
		validateBlendTreeParameters(parameters, layer.states);
		validateStatePlaybackParameters(parameters, parameterTypes, layer.states, `Animator layer "${layer.name}"`);
		validateTransitions(layer);
		validateTransitionParameters(parameters, parameterTypes, layer.transitions ?? [], `Animator layer "${layer.name}"`);
		validateTransitionParameters(parameters, parameterTypes, layer.entryTransitions ?? [], `Animator layer "${layer.name}" Entry`);
		validateEntryState(layer, layer.entryState ?? layer.activeState, `Animator layer "${layer.name}"`);
		const compiled = compileAnimatorMachine(layer, subgraphs);
		if (layer.activeState) {
			resolveCompiledState(compiled, layer.activeState);
		}
		const knownTargets = new Set(compiled.states.flatMap((state) => getStateTargetNames(scene, state)));
		const unknown = (layer.maskTargetNames ?? []).find((targetName) => !knownTargets.has(targetName));
		if (unknown) {
			throw new Error(`Animator layer mask target "${unknown}" is not animated by layer "${layer.name}".`);
		}
		validateMaskReference(scene, layer.avatarMaskId, `Animator layer "${layer.name}"`);
		if (layer.synchronizedLayer) {
			const source =
				layer.synchronizedLayer === "$base"
					? compileAnimatorMachine(rootMachine, subgraphs)
					: compileAnimatorMachine(layers.find((candidate) => candidate.name === layer.synchronizedLayer)!, subgraphs);
			for (const sourceState of source.states) {
				const mappedName = layer.synchronizedStateMap?.[sourceState.name] ?? sourceState.name;
				const exact = compiled.states.find((candidate) => candidate.name === mappedName);
				const sourceNameMatches = compiled.states.filter((candidate) => candidate.sourceStateName === sourceState.sourceStateName);
				if (!exact && sourceNameMatches.length !== 1) {
					throw new Error(`Animator synchronized layer "${layer.name}" cannot map source state "${sourceState.name}".`);
				}
			}
			for (const [sourceState, targetState] of Object.entries(layer.synchronizedStateMap ?? {})) {
				if (!source.states.some((candidate) => candidate.name === sourceState)) {
					throw new Error(`Animator synchronized layer "${layer.name}" map source "${sourceState}" was not found.`);
				}
				resolveCompiledState(compiled, targetState);
			}
			for (const [sourceState, motion] of Object.entries(layer.synchronizedMotionOverrides ?? {})) {
				if (!source.states.some((candidate) => candidate.name === sourceState)) {
					throw new Error(`Animator synchronized layer "${layer.name}" motion override source "${sourceState}" was not found.`);
				}
				if (!!motion.animationGroup === !!motion.blendTree) {
					throw new Error(`Animator synchronized layer "${layer.name}" motion override "${sourceState}" requires exactly one animationGroup or blendTree.`);
				}
				const overrideState: IAnimatorState = { name: "Override", ...motion };
				validateStates(scene, [overrideState]);
				validateBlendTreeParameters(parameters, [overrideState]);
			}
			for (const [sourceState, behaviours] of Object.entries(layer.synchronizedBehaviourOverrides ?? {})) {
				if (!source.states.some((candidate) => candidate.name === sourceState)) {
					throw new Error(`Animator synchronized layer "${layer.name}" behaviour override source "${sourceState}" was not found.`);
				}
				validateAnimatorStateBehaviours(behaviours);
			}
		}
		names.add(layer.name);
	}
}

function validateRootMotion(scene: Scene, rootMotion: IAnimatorRootMotion | undefined): void {
	if (!rootMotion) {
		return;
	}
	if (typeof rootMotion.enabled !== "boolean" || !rootMotion.sourceNodeId || !rootMotion.targetNodeId) {
		throw new Error("Root motion requires enabled, sourceNodeId, and targetNodeId.");
	}
	const source = scene.getNodeById(rootMotion.sourceNodeId) as any;
	const target = scene.getNodeById(rootMotion.targetNodeId) as any;
	if (!source?.position || !target?.position) {
		throw new Error("Root-motion source and target must be transformable scene nodes.");
	}
	if (source === target) {
		throw new Error("Root-motion source and target must differ so the animated source can be extracted safely.");
	}
}

function getState(controller: { states: IAnimatorState[] }, name: string): IAnimatorState {
	const state = controller.states.find((candidate) => candidate.name === name);
	if (!state) {
		throw new Error(`Animator state "${name}" was not found.`);
	}
	return state;
}

function validateBehaviourScriptBindings(scene: Scene, controller: IAnimatorController, behaviours: NonNullable<IAnimatorState["behaviours"]>): void {
	validateAnimatorStateBehaviours(behaviours);
	if (!behaviours.length) {
		return;
	}
	if (!controller.targetNodeId) {
		throw new Error("Animator state behaviours require the controller to reference a targetNodeId.");
	}
	const target = scene.getNodeById(controller.targetNodeId) as any;
	if (!target) {
		throw new Error(`Animator target node "${controller.targetNodeId}" was not found.`);
	}
	const attachedKeys = new Set<string>([
		...((target.metadata?.scripts ?? []).map((script: any) => script.key) as string[]),
		...((scriptsDictionary.get(target) ?? []).map((script) => script.key) as string[]),
	]);
	const missing = behaviours.find((behaviour) => !attachedKeys.has(behaviour.scriptKey));
	if (missing) {
		throw new Error(`Animator state behaviour script "${missing.scriptKey}" is not attached to target node "${target.name}".`);
	}
}

function validateAllBehaviourScriptBindings(
	scene: Scene,
	controller: IAnimatorController,
	rootMachine: IAnimatorGraphMachine,
	subgraphs: IAnimatorSubgraphDefinition[],
	layers: IAnimatorLayer[]
): void {
	const validateMachine = (machine: IAnimatorGraphMachine): void => {
		validateBehaviourScriptBindings(scene, controller, machine.behaviours ?? []);
		for (const state of machine.states) {
			validateBehaviourScriptBindings(scene, controller, state.behaviours ?? []);
		}
	};
	validateMachine(rootMachine);
	for (const subgraph of subgraphs) {
		validateMachine(subgraph);
	}
	for (const layer of layers) {
		validateMachine(layer);
		for (const behaviours of Object.values(layer.synchronizedBehaviourOverrides ?? {})) {
			validateBehaviourScriptBindings(scene, controller, behaviours);
		}
	}
}

// eslint-disable-next-line max-params -- state playback needs the controller, mask, offset, and optional layer context together.
function startStateGroups(
	scene: Scene,
	controller: IAnimatorController,
	state: IAnimatorState,
	fallbackTargetNames: string[] = [],
	fallbackAvatarMaskId?: string,
	offset = 0,
	layer?: IAnimatorLayer
): void {
	const avatarMaskId = state.avatarMaskId ?? fallbackAvatarMaskId;
	const legacyNames = state.maskTargetNames ?? fallbackTargetNames;
	const names = [...new Set([...(avatarMaskId ? humanoidMaskNames(scene, avatarMaskId) : []), ...legacyNames])];
	const configured = !!avatarMaskId || names.length > 0;
	const playback = resolveAnimatorStatePlayback(state, controller.parameters);
	const normalizedOffset = playback.time === null ? offset : (state.loop ?? true) ? ((playback.time % 1) + 1) % 1 : Math.min(1, Math.max(0, playback.time));
	const motions = stateMotions(controller, state)
		.map((motion) => ({ motion, group: resolveStateMotionGroup(scene, controller, state, motion, layer) }))
		.filter((entry): entry is { motion: IAnimatorBlendTreeMotion; group: AnimationGroup } => !!entry.group);
	for (const { group } of motions) {
		group.mask = configured ? new AnimationGroupMask(names) : null;
	}
	applyStateWriteDefaults(scene, controller, state, layer);
	for (const { motion, group } of motions) {
		const phase = stateMotionPhase(controller, state, motion, normalizedOffset);
		const from = group.from + (group.to - group.from) * phase;
		group.start(state.loop ?? true, playback.effectiveSpeed * motion.timeScale, from, group.to, layer?.blendingMode === "additive");
		group.goToFrame(from);
	}
}

function applyStateWriteDefaults(scene: Scene, controller: IAnimatorController, state: IAnimatorState, layer?: IAnimatorLayer): void {
	const groups = stateMotions(controller, state)
		.map((motion) => resolveStateMotionGroup(scene, controller, state, motion, layer))
		.filter((group): group is AnimationGroup => !!group);
	applyAnimatorWriteDefaults(scene as any, controller, layer?.name ?? "$base", state, groups);
}

function transitionSources(
	previous: IAnimatorState | null,
	existingFade: IAnimatorFade | undefined,
	targetState?: IAnimatorState,
	fallbackWeight = 1
): { sources: { state: IAnimatorState; weight: number }[]; targetStartWeight: number } {
	const weights = existingFade ? fadeWeights(existingFade) : previous ? new Map([[previous.name, { state: previous, weight: fallbackWeight }]]) : new Map();
	const targetStartWeight = targetState ? (weights.get(targetState.name)?.weight ?? 0) : 0;
	if (targetState) {
		weights.delete(targetState.name);
	}
	return { sources: [...weights.values()], targetStartWeight };
}

function startState(scene: Scene, controller: IAnimatorController, stateName: string, transitionDuration = 0, offset = 0, match?: IAnimatorTransitionMatch): IAnimatorController {
	const machine = compileControllerMachine(controller);
	const state = resolveCompiledState(machine, stateName, controller.parameters);
	const previous = controller.activeState ? resolveCompiledState(machine, controller.activeState) : null;
	const fadeKey = `${controller.id}:base`;
	const fades = animatorFades.get(scene);
	const existingFade = fades?.get(fadeKey);
	const selfTransition = previous === state;
	const canCrossFade = !!previous && !selfTransition && Number.isFinite(transitionDuration) && transitionDuration > 0;
	if (!canCrossFade) {
		machine.states.forEach((candidate) => stopStateGroups(scene, controller, candidate));
	}
	startStateGroups(scene, controller, state, [], undefined, offset);
	controller.activeState = state.name;
	const durationSeconds = effectiveStateDuration(scene, controller, state);
	const elapsedSeconds = durationSeconds ? durationSeconds * offset : 0;
	animatorElapsedSeconds.get(scene)?.set(controller.id, elapsedSeconds);
	enterAnimatorBehaviourState(scene, controller, machine, state, elapsedSeconds, offset, undefined, match?.interrupted === true);
	rootMotionSamples.get(scene)?.delete(controller.id);
	fades?.delete(fadeKey);
	if (canCrossFade) {
		const { sources, targetStartWeight } = transitionSources(previous, existingFade, state, 1);
		applyStateWeight(scene, controller, state, targetStartWeight);
		fades?.set(fadeKey, {
			sources,
			to: state,
			toStartWeight: targetStartWeight,
			targetWeight: 1,
			elapsed: 0,
			duration: transitionDuration,
			transition: match?.transition,
			transitionIndex: match?.index,
			sourceState: match?.evaluatedState ?? previous?.name,
			interrupted: match?.interrupted,
		});
	} else {
		applyStateWeight(scene, controller, state, 1);
	}
	return controller;
}

function findLayer(controller: IAnimatorController, name: string): IAnimatorLayer {
	const layer = controller.layers?.find((candidate) => candidate.name === name);
	if (!layer) {
		throw new Error(`Animator layer "${name}" was not found.`);
	}
	return layer;
}

function startLayerState(
	scene: Scene,
	controller: IAnimatorController,
	layerName: string,
	stateName: string,
	transitionOptions: { duration?: number; offset?: number; match?: IAnimatorTransitionMatch; synchronized?: boolean; stateOverride?: IAnimatorState } = {}
): IAnimatorLayer {
	const transitionDuration = transitionOptions.duration ?? 0;
	const offset = transitionOptions.offset ?? 0;
	const match = transitionOptions.match;
	const layer = findLayer(controller, layerName);
	if (layer.synchronizedLayer && !transitionOptions.synchronized) {
		throw new Error(`Animator layer "${layer.name}" is synchronized to "${layer.synchronizedLayer}" and cannot be played independently.`);
	}
	const machine = compileLayerMachine(controller, layer);
	const state = transitionOptions.stateOverride ?? resolveCompiledState(machine, stateName, controller.parameters);
	const previous = getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer)) ?? (layer.activeState ? resolveCompiledState(machine, layer.activeState) : null);
	const fadeKey = `${controller.id}:layer:${layer.name}`;
	const fades = animatorFades.get(scene);
	const existingFade = fades?.get(fadeKey);
	const selfTransition = previous?.name === state.name;
	const canCrossFade = !!previous && !selfTransition && Number.isFinite(transitionDuration) && transitionDuration > 0;
	if (!canCrossFade) {
		machine.states.forEach((candidate) => stopStateGroups(scene, controller, candidate, layer));
		stopStateGroups(scene, controller, previous ?? state, layer);
	}
	startStateGroups(scene, controller, state, layer.maskTargetNames ?? [], layer.avatarMaskId, offset, layer);
	layer.activeState = state.name;
	const durationSeconds = effectiveStateDuration(scene, controller, state, layer);
	const elapsedSeconds = durationSeconds ? durationSeconds * offset : 0;
	animatorElapsedSeconds.get(scene)?.set(fadeKey, elapsedSeconds);
	enterAnimatorBehaviourState(scene, controller, machine, state, elapsedSeconds, offset, layer, match?.interrupted === true);
	fades?.delete(fadeKey);
	if (canCrossFade) {
		const { sources, targetStartWeight } = transitionSources(previous, existingFade, state, layer.weight ?? 1);
		applyStateWeight(scene, controller, state, targetStartWeight, layer);
		fades?.set(fadeKey, {
			sources,
			to: state,
			toStartWeight: targetStartWeight,
			targetWeight: layer.weight ?? 1,
			elapsed: 0,
			duration: transitionDuration,
			layer,
			transition: match?.transition,
			transitionIndex: match?.index,
			sourceState: match?.evaluatedState ?? previous?.name,
			interrupted: match?.interrupted,
		});
	} else {
		applyStateWeight(scene, controller, state, layer.weight ?? 1, layer);
	}
	return layer;
}

function synchronizeAnimatorLayer(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer): void {
	const sourceLayer = layer.synchronizedLayer === "$base" ? undefined : controller.layers?.find((candidate) => candidate.name === layer.synchronizedLayer);
	if (layer.synchronizedLayer !== "$base" && !sourceLayer) {
		throw new Error(`Animator synchronized layer "${layer.name}" references missing source layer "${String(layer.synchronizedLayer)}".`);
	}
	const sourceMachine = sourceLayer ? compileLayerMachine(controller, sourceLayer) : compileControllerMachine(controller);
	const sourceStateName = sourceLayer ? sourceLayer.activeState : controller.activeState;
	const sourceState = sourceMachine.states.find((candidate) => candidate.name === sourceStateName);
	if (!sourceState) {
		exitLayerState(scene, controller, layer);
		return;
	}
	const targetState = synchronizedTargetState(controller, layer, sourceState);
	const sourceElapsedKey = sourceLayer ? `${controller.id}:layer:${sourceLayer.name}` : controller.id;
	const sourceElapsed = animatorElapsedSeconds.get(scene)?.get(sourceElapsedKey) ?? 0;
	const normalizedTime = stateProgress(scene, controller, sourceState, sourceElapsed, sourceLayer);
	const sourceMotion = stateMotions(controller, sourceState)[0];
	const sourceGroup = sourceMotion ? resolveStateMotionGroup(scene, controller, sourceState, sourceMotion, sourceLayer) : null;
	if (!sourceGroup?.isStarted) {
		layer.activeState = targetState.name;
		return;
	}
	const lifecycleState = getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer));
	if (layer.activeState !== targetState.name || lifecycleState?.synchronizedSourceState !== sourceState.name) {
		startLayerState(scene, controller, layer.name, targetState.name, {
			offset: normalizedTime,
			synchronized: true,
			stateOverride: targetState,
		});
	}
	const elapsedKey = `${controller.id}:layer:${layer.name}`;
	const targetDuration = stateDurationSeconds(scene, controller, targetState);
	animatorElapsedSeconds.get(scene)?.set(elapsedKey, targetDuration ? targetDuration * normalizedTime : 0);
	applyStateWriteDefaults(scene, controller, targetState, layer);
	for (const motion of stateMotions(controller, targetState)) {
		const group = resolveStateMotionGroup(scene, controller, targetState, motion, layer);
		if (!group) {
			continue;
		}
		if (!group.isStarted) {
			startStateGroups(scene, controller, targetState, layer.maskTargetNames ?? [], layer.avatarMaskId, normalizedTime, layer);
			break;
		}
		const phase = stateMotionPhase(controller, targetState, motion, normalizedTime);
		group.goToFrame(group.from + (group.to - group.from) * phase);
	}
	applyStateWeight(scene, controller, targetState, layer.weight ?? 1, layer);
}

function synchronizeAnimatorLayers(scene: Scene, controller: IAnimatorController): void {
	for (const layer of controller.layers ?? []) {
		if (layer.synchronizedLayer) {
			synchronizeAnimatorLayer(scene, controller, layer);
		}
	}
}

function conditionsMatch(parameters: IAnimatorController["parameters"], conditions: IAnimatorTransitionCondition[]): boolean {
	return conditions.every((condition) => {
		const value = parameters[condition.parameter];
		if (condition.equals !== undefined && value !== condition.equals) {
			return false;
		}
		if (condition.notEquals !== undefined && value === condition.notEquals) {
			return false;
		}
		if (condition.greaterThan !== undefined && (typeof value !== "number" || value <= condition.greaterThan)) {
			return false;
		}
		if (condition.lessThan !== undefined && (typeof value !== "number" || value >= condition.lessThan)) {
			return false;
		}
		return true;
	});
}

function transitionConsumesParameter(transition: IAnimatorTransition | undefined, parameter: string): boolean {
	return !!transition?.conditions?.some((condition) => condition.parameter === parameter);
}

function authoredTransition(transition: IAnimatorTransition): IAnimatorTransition {
	return (transition as ICompiledAnimatorTransition).sourceTransition ?? transition;
}

function transitionMatches(candidate: IAnimatorTransition, evaluatedState: string, parameters: IAnimatorController["parameters"], progress?: number): boolean {
	return (
		(candidate.from === evaluatedState || candidate.from === ANIMATOR_ANY_STATE) &&
		(candidate.to !== evaluatedState || candidate.canTransitionToSelf === true) &&
		(candidate.exitTime === undefined || (progress !== undefined && progress >= candidate.exitTime)) &&
		conditionsMatch(parameters, candidate.conditions ?? [])
	);
}

function findEligibleTransition(
	transitions: IAnimatorTransition[],
	activeState: string,
	parameters: IAnimatorController["parameters"],
	progress?: number
): IAnimatorTransitionMatch | undefined {
	const index = transitions.findIndex((candidate) => transitionMatches(candidate, activeState, parameters, progress));
	return index >= 0 ? { transition: transitions[index], index, evaluatedState: activeState, interrupted: false } : undefined;
}

function findInterruptionTransition(
	transitions: IAnimatorTransition[],
	fade: IAnimatorFade | undefined,
	parameters: IAnimatorController["parameters"]
): IAnimatorTransitionMatch | undefined {
	const activeTransition = (fade?.transition as ICompiledAnimatorTransition | undefined)?.sourceTransition ?? fade?.transition;
	const source = activeTransition?.interruptionSource ?? "none";
	if (!fade || !fade.transition || source === "none") {
		return undefined;
	}
	const sourceState = fade.sourceState ?? fade.sources[0]?.state.name;
	const destinationState = fade.to?.name;
	const order =
		source === "source"
			? [sourceState]
			: source === "destination"
				? [destinationState]
				: source === "sourceThenDestination"
					? [sourceState, destinationState]
					: [destinationState, sourceState];
	for (const evaluatedState of order.filter((value): value is string => !!value)) {
		for (let index = 0; index < transitions.length; index++) {
			if (index === fade.transitionIndex || (activeTransition?.orderedInterruption === true && fade.transitionIndex !== undefined && index >= fade.transitionIndex)) {
				continue;
			}
			if (transitionMatches(transitions[index], evaluatedState, parameters)) {
				return { transition: transitions[index], index, evaluatedState, interrupted: true };
			}
		}
	}
	return undefined;
}

function exitState(scene: Scene, controller: IAnimatorController, transitionDuration = 0, match?: IAnimatorTransitionMatch): void {
	const machine = compileControllerMachine(controller);
	const previous = controller.activeState ? resolveCompiledState(machine, controller.activeState) : null;
	const fades = animatorFades.get(scene);
	const fadeKey = `${controller.id}:base`;
	const existingFade = fades?.get(fadeKey);
	fades?.delete(fadeKey);
	if (previous && Number.isFinite(transitionDuration) && transitionDuration > 0) {
		const { sources } = transitionSources(previous, existingFade, undefined, 1);
		fades?.set(fadeKey, {
			sources,
			toStartWeight: 0,
			targetWeight: 0,
			elapsed: 0,
			duration: transitionDuration,
			transition: match?.transition,
			transitionIndex: match?.index,
			sourceState: match?.evaluatedState ?? previous.name,
			interrupted: match?.interrupted,
		});
	} else {
		machine.states.forEach((candidate) => stopStateGroups(scene, controller, candidate));
	}
	const elapsedSeconds = animatorElapsedSeconds.get(scene)?.get(controller.id) ?? 0;
	const duration = previous ? effectiveStateDuration(scene, controller, previous) : null;
	exitAnimatorBehaviourState(scene, controller, machine, elapsedSeconds, duration ? elapsedSeconds / duration : 0, undefined, match?.interrupted === true);
	controller.activeState = undefined;
	animatorElapsedSeconds.get(scene)?.delete(controller.id);
	rootMotionSamples.get(scene)?.delete(controller.id);
}

function exitLayerState(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, transitionDuration = 0, match?: IAnimatorTransitionMatch): void {
	const machine = compileLayerMachine(controller, layer);
	const previous = layer.activeState ? resolveCompiledState(machine, layer.activeState) : null;
	const fadeKey = `${controller.id}:layer:${layer.name}`;
	const fades = animatorFades.get(scene);
	const existingFade = fades?.get(fadeKey);
	fades?.delete(fadeKey);
	if (previous && Number.isFinite(transitionDuration) && transitionDuration > 0) {
		const { sources } = transitionSources(previous, existingFade, undefined, layer.weight ?? 1);
		fades?.set(fadeKey, {
			sources,
			toStartWeight: 0,
			targetWeight: 0,
			elapsed: 0,
			duration: transitionDuration,
			layer,
			transition: match?.transition,
			transitionIndex: match?.index,
			sourceState: match?.evaluatedState ?? previous.name,
			interrupted: match?.interrupted,
		});
	} else {
		machine.states.forEach((candidate) => stopStateGroups(scene, controller, candidate, layer));
	}
	const elapsedSeconds = animatorElapsedSeconds.get(scene)?.get(fadeKey) ?? 0;
	const duration = previous ? effectiveStateDuration(scene, controller, previous, layer) : null;
	exitAnimatorBehaviourState(scene, controller, machine, elapsedSeconds, duration ? elapsedSeconds / duration : 0, layer, match?.interrupted === true);
	layer.activeState = undefined;
	animatorElapsedSeconds.get(scene)?.delete(fadeKey);
}

function applyBaseTransition(scene: Scene, controller: IAnimatorController, match: IAnimatorTransitionMatch): void {
	const machine = compileControllerMachine(controller);
	const source = machine.states.find((state) => state.name === match.evaluatedState);
	const duration =
		match.transition.durationMode === "normalized" && source
			? (match.transition.duration ?? 0) * (effectiveStateDuration(scene, controller, source) ?? 0)
			: (match.transition.duration ?? 0);
	if (match.transition.to === ANIMATOR_EXIT_STATE) {
		exitState(scene, controller, duration, match);
	} else {
		startState(scene, controller, match.transition.to, duration, match.transition.offset ?? 0, match);
	}
	recordAnimatorTransition(scene, controller, "$base", match, duration);
}

function applyLayerTransition(scene: Scene, controller: IAnimatorController, layer: IAnimatorLayer, match: IAnimatorTransitionMatch): void {
	const machine = compileLayerMachine(controller, layer);
	const source = machine.states.find((state) => state.name === match.evaluatedState);
	const duration =
		match.transition.durationMode === "normalized" && source
			? (match.transition.duration ?? 0) * (effectiveStateDuration(scene, controller, source, layer) ?? 0)
			: match.transition.duration;
	if (match.transition.to === ANIMATOR_EXIT_STATE) {
		exitLayerState(scene, controller, layer, duration ?? 0, match);
	} else {
		startLayerState(scene, controller, layer.name, match.transition.to, {
			duration,
			offset: match.transition.offset,
			match,
		});
	}
	recordAnimatorTransition(scene, controller, layer.name, match, duration ?? 0);
}

function animationGroupDebug(scene: Scene, controller: IAnimatorController, state: IAnimatorState, motion: IAnimatorBlendTreeMotion, layer?: IAnimatorLayer): any {
	const group = resolveStateMotionGroup(scene, controller, state, motion, layer);
	const animatables = (group as any)?.animatables as { masterFrame?: number; fromFrame?: number }[] | undefined;
	return group
		? {
				name: group.name,
				sourceAnimationGroup: motion.animationGroup,
				motionKey: motion.key,
				timeScale: motion.timeScale,
				cycleOffset: motion.cycleOffset,
				mirrored: motion.mirror,
				found: true,
				started: group.isStarted,
				playing: group.isPlaying,
				paused: group.isStarted && !group.isPlaying,
				weight: group.weight,
				additive: group.isAdditive,
				internalLayerClone: group.metadata?.babylonEditorInternalAnimatorLayer === true,
				speedRatio: group.speedRatio,
				from: group.from,
				to: group.to,
				playbackFromFrame: animatables?.[0]?.fromFrame ?? null,
				currentFrame: animatables?.[0]?.masterFrame ?? null,
				targetedAnimationCount: group.targetedAnimations.length,
			}
		: { name: motion.animationGroup, sourceAnimationGroup: motion.animationGroup, motionKey: motion.key, found: false };
}

// eslint-disable-next-line max-params -- debugger snapshots require distinct runtime keys plus optional layer playback context.
function animatorMachineDebug(
	scene: Scene,
	machine: ICompiledAnimatorMachine,
	activeStateName: string | undefined,
	elapsedKey: string,
	fadeKey: string,
	includeAllClips: boolean,
	controller: IAnimatorController,
	layer?: IAnimatorLayer,
	activeStateOverride?: IAnimatorState
): any {
	const activeState = activeStateOverride ?? machine.states.find((state) => state.name === activeStateName);
	const elapsedSeconds = animatorElapsedSeconds.get(scene)?.get(elapsedKey) ?? 0;
	const durationSeconds = activeState
		? layer?.synchronizedLayer
			? stateDurationSeconds(scene, controller, activeState)
			: effectiveStateDuration(scene, controller, activeState, layer)
		: null;
	const normalizedTime = activeState ? stateProgress(scene, controller, activeState, elapsedSeconds, layer) : 0;
	const playback = activeState ? resolveAnimatorStatePlayback(activeState, controller.parameters) : null;
	const fade = animatorFades.get(scene)?.get(fadeKey);
	const transitionProgress = fade ? Math.min(1, fade.elapsed / fade.duration) : null;
	const fadeSourceNames = new Set(fade?.sources.map((source) => source.state.name) ?? []);
	const debugStates = activeStateOverride ? [...machine.states.filter((state) => state.name !== activeStateOverride.name), activeStateOverride] : machine.states;
	const relevantStates = includeAllClips
		? debugStates
		: debugStates.filter((state) => state.name === activeState?.name || fadeSourceNames.has(state.name) || state.name === fade?.to?.name);
	const clips = relevantStates.flatMap((state) =>
		stateMotions(controller, state).map((motion) => ({ state: state.name, ...animationGroupDebug(scene, controller, state, motion, layer) }))
	);
	const warnings: string[] = [];
	if (activeStateName && !activeState) {
		warnings.push(`Active state "${activeStateName}" is missing.`);
	}
	for (const clip of clips) {
		if (!clip.found) {
			warnings.push(`Animation Group "${clip.name}" referenced by state "${clip.state}" is missing.`);
		}
	}
	const activeTransition = (fade?.transition as ICompiledAnimatorTransition | undefined)?.sourceTransition ?? fade?.transition;
	return {
		entryState: machine.entryState,
		activeState: activeState?.name ?? null,
		activeMachinePath: (activeState as ICompiledAnimatorState | undefined)?.machinePath ?? [],
		activeSubgraphId: (activeState as ICompiledAnimatorState | undefined)?.subgraphId ?? null,
		exited: !activeState,
		elapsedSeconds,
		durationSeconds,
		normalizedTime,
		loopProgress: activeState ? ((activeState.loop ?? true) ? ((normalizedTime % 1) + 1) % 1 : Math.min(1, Math.max(0, normalizedTime))) : 0,
		speed: activeState?.speed ?? null,
		effectiveSpeed: playback?.effectiveSpeed ?? null,
		cycleOffset: playback?.cycleOffset ?? 0,
		mirror: playback?.mirror ?? false,
		timeDriven: playback?.timeDriven ?? false,
		time: playback?.time ?? null,
		playbackBindings: playback?.bindings ?? null,
		loop: activeState?.loop ?? null,
		tag: activeState?.tag ?? null,
		footIK: activeState?.footIK ?? null,
		writeDefaultValues: activeState?.writeDefaultValues ?? null,
		unitySource: activeState?.unitySource ?? null,
		transition: fade
			? {
					from: fade.sourceState ?? fade.sources[0]?.state.name ?? null,
					to: fade.to?.name ?? ANIMATOR_EXIT_STATE,
					elapsedSeconds: fade.elapsed,
					durationSeconds: fade.duration,
					authoredDuration: activeTransition?.duration ?? 0,
					durationMode: activeTransition?.durationMode ?? "seconds",
					progress: transitionProgress,
					sourceWeights: fade.sources.map((source) => ({ state: source.state.name, weight: source.weight * (1 - transitionProgress!) })),
					fromWeight: fade.sources.reduce((sum, source) => sum + source.weight * (1 - transitionProgress!), 0),
					toWeight: fade.to ? fade.toStartWeight + (fade.targetWeight - fade.toStartWeight) * transitionProgress! : 0,
					interrupted: fade.interrupted === true,
					interruptionSource: activeTransition?.interruptionSource ?? "none",
					orderedInterruption: activeTransition?.orderedInterruption === true,
					offset: activeTransition?.offset ?? 0,
					canTransitionToSelf: activeTransition?.canTransitionToSelf === true,
				}
			: null,
		clips,
		warnings,
	};
}

function describeController(controller: IAnimatorController): IAnimatorController {
	return structuredClone(controller);
}

/** Lists persisted editor animator controllers. */
export function listAnimatorControllers(scene: Scene): any {
	const controllers = (scene.metadata?.babylonEditorAnimatorControllers as IAnimatorController[] | undefined) ?? [];
	return { controllers: controllers.map(describeController) };
}

/** Creates a persisted state-machine controller over existing Babylon animation groups. */
export function createAnimatorController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const states = data.states ?? [];
	const transitions = data.transitions ?? [];
	const subStateMachines = data.subStateMachines ?? [];
	const subgraphs = data.subgraphs ?? [];
	const parameters = data.parameters ?? {};
	const parameterTypes = normalizeParameterTypes(parameters, data.parameterTypes);
	const layers = (data.layers ?? []).map((layer: IAnimatorLayer) => ({
		...layer,
		behaviours: layer.behaviours ?? [],
		transitions: layer.transitions ?? [],
		entryTransitions: layer.entryTransitions ?? [],
		subStateMachines: layer.subStateMachines ?? [],
		entryState: layer.entryState ?? layer.activeState ?? layer.states?.[0]?.name,
	}));
	const rootMachine: IAnimatorGraphMachine = {
		behaviours: data.behaviours ?? [],
		states,
		transitions,
		entryTransitions: data.entryTransitions ?? [],
		subStateMachines,
		entryState: data.entryState,
		activeState: data.activeState,
	};
	validateStates(scene, states);
	validateBlendTreeParameters(parameters, states);
	validateStatePlaybackParameters(parameters, parameterTypes, states, "Animator controller");
	validateTransitions(rootMachine);
	validateTransitionParameters(parameters, parameterTypes, transitions, "Animator controller");
	validateTransitionParameters(parameters, parameterTypes, rootMachine.entryTransitions ?? [], "Animator controller Entry");
	validateSubgraphs(scene, parameters, parameterTypes, subgraphs);
	validateLayers(scene, parameters, parameterTypes, layers, subgraphs, rootMachine);
	validateRootMotion(scene, data.rootMotion);
	validateControllerHumanoidAvatar(scene, data.humanoidAvatarId);
	if (getControllers(scene).some((controller) => controller.name === data.name)) {
		throw new Error(`Animator controller "${data.name}" already exists.`);
	}
	const entryState = validateEntryState(rootMachine, data.entryState ?? data.activeState, "Animator controller");
	rootMachine.entryState = entryState;
	const compiled = compileAnimatorMachine(rootMachine, subgraphs);
	const activeState = resolveCompiledState(compiled, data.activeState ?? resolveAnimatorEntryState(compiled, parameters), parameters).name;
	const normalizedLayers = layers.map((layer) => {
		const layerCompiled = compileAnimatorMachine(layer, subgraphs);
		return {
			...layer,
			activeState: resolveCompiledState(layerCompiled, layer.activeState ?? resolveAnimatorEntryState(layerCompiled, parameters), parameters).name,
		};
	});
	const controller: IAnimatorController = {
		id: Tools.RandomId(),
		name: data.name,
		targetNodeId: data.targetNodeId,
		humanoidAvatarId: data.humanoidAvatarId,
		parameters,
		parameterTypes,
		baseIKPass: data.baseIKPass ?? false,
		behaviours: rootMachine.behaviours,
		states,
		transitions,
		entryTransitions: data.entryTransitions ?? [],
		subStateMachines,
		subgraphs,
		entryState,
		activeState,
		layers: normalizedLayers,
		rootMotion: data.rootMotion,
	};
	validateAllBehaviourScriptBindings(scene, controller, rootMachine, subgraphs, normalizedLayers);
	getControllers(scene).push(controller);
	ensureRootMotion(scene);
	if (data.playOnCreate) {
		startState(scene, controller, activeState);
		controller.layers?.forEach((layer) =>
			layer.synchronizedLayer
				? synchronizeAnimatorLayer(scene, controller, layer)
				: startLayerState(scene, controller, layer.name, layer.activeState ?? compileLayerMachine(controller, layer).entryState)
		);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return describeController(controller);
}

/** Reads a persisted animator controller. */
export function getAnimatorController(scene: Scene, data: any): any {
	return describeController(findController(scene, data));
}

/** Returns the deterministic flattened leaf-state graph used by preview and exported runtime. */
export function getAnimatorCompiledGraph(scene: Scene, data: any): any {
	const controller = findController(scene, data);
	const layer = data.layer ? findLayer(controller, data.layer) : null;
	const compiled = layer ? compileLayerMachine(controller, layer) : compileControllerMachine(controller);
	return {
		controllerId: controller.id,
		controllerName: controller.name,
		layer: layer?.name ?? null,
		entryState: compiled.entryState,
		resolvedEntryState: resolveAnimatorEntryState(compiled, controller.parameters),
		entryTransitions: compiled.entryTransitions,
		activeState: layer?.activeState ?? controller.activeState ?? null,
		states: compiled.states.map((state) => ({
			name: state.name,
			sourceStateName: state.sourceStateName,
			machinePath: state.machinePath,
			subgraphId: state.subgraphId ?? null,
			animationGroup: state.animationGroup ?? null,
			blendTree: state.blendTree ?? null,
		})),
		transitions: compiled.transitions.map((transition, index) => ({
			index,
			from: transition.from,
			to: transition.to,
			conditions: transition.conditions ?? [],
			exitTime: transition.exitTime ?? null,
			duration: transition.duration ?? null,
			offset: transition.offset ?? null,
			sourceMachinePath: transition.sourceMachinePath,
			sourceTransitionIndex: transition.sourceTransitionIndex,
		})),
		machineEntries: compiled.machineEntries,
		machineEntryTransitions: compiled.machineEntryTransitions,
		machineLeaves: compiled.machineLeaves,
	};
}

/** Creates or atomically updates one reusable Animator subgraph definition. */
export function setAnimatorSubgraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const existing = data.subgraphId ? controller.subgraphs?.find((subgraph) => subgraph.id === data.subgraphId) : undefined;
	if (data.subgraphId && !existing) {
		throw new Error(`Animator reusable subgraph "${data.subgraphId}" was not found.`);
	}
	if (!existing && (!data.name || !data.states)) {
		throw new Error("Creating an Animator reusable subgraph requires name and states.");
	}
	const replacement: IAnimatorSubgraphDefinition = {
		id: existing?.id ?? Tools.RandomId(),
		name: data.name ?? existing!.name,
		behaviours: data.behaviours ?? existing?.behaviours ?? [],
		states: data.states ?? existing!.states,
		transitions: data.transitions ?? existing?.transitions ?? [],
		entryTransitions: data.entryTransitions ?? existing?.entryTransitions ?? [],
		subStateMachines: data.subStateMachines ?? existing?.subStateMachines ?? [],
		entryState: data.entryState ?? existing?.entryState ?? data.states?.[0]?.name ?? existing?.states[0]?.name,
	};
	const subgraphs = existing
		? (controller.subgraphs ?? []).map((subgraph) => (subgraph.id === existing.id ? replacement : subgraph))
		: [...(controller.subgraphs ?? []), replacement];
	const result = setAnimatorController(scene, { controllerId: controller.id, subgraphs }, options);
	return { ...result, subgraph: structuredClone(replacement), created: !existing };
}

function removeSubStateMachine(machine: IAnimatorGraphMachine, name: string): IAnimatorGraphMachine {
	const subStateMachines = (machine.subStateMachines ?? []).filter((instance) => instance.name !== name);
	const transitions = machine.transitions.filter((transition) => transition.from !== name && transition.to !== name);
	const entryTransitions = (machine.entryTransitions ?? []).filter((transition) => transition.to !== name);
	const entryState = machine.entryState === name ? machine.states[0]?.name : machine.entryState;
	return { ...machine, subStateMachines, transitions, entryTransitions, entryState };
}

/** Deletes one reusable subgraph, optionally removing every instance that references it. */
export function deleteAnimatorSubgraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const subgraph = controller.subgraphs?.find((candidate) => candidate.id === data.subgraphId);
	if (!subgraph) {
		throw new Error(`Animator reusable subgraph "${data.subgraphId}" was not found.`);
	}
	const references = [
		...(controller.subStateMachines ?? []).filter((instance) => instance.subgraphId === subgraph.id).map((instance) => `base:${instance.name}`),
		...(controller.layers ?? []).flatMap((layer) =>
			(layer.subStateMachines ?? []).filter((instance) => instance.subgraphId === subgraph.id).map((instance) => `layer:${layer.name}:${instance.name}`)
		),
		...(controller.subgraphs ?? []).flatMap((owner) =>
			(owner.subStateMachines ?? []).filter((instance) => instance.subgraphId === subgraph.id).map((instance) => `subgraph:${owner.name}:${instance.name}`)
		),
	];
	if (references.length && data.cascade !== true) {
		throw new Error(`Animator reusable subgraph "${subgraph.name}" is still instantiated by ${references.join(", ")}. Set cascade true to remove those instances.`);
	}
	let root: IAnimatorGraphMachine = controller;
	let layers = controller.layers ?? [];
	let subgraphs = (controller.subgraphs ?? []).filter((candidate) => candidate.id !== subgraph.id);
	if (data.cascade) {
		for (const instance of controller.subStateMachines ?? []) {
			if (instance.subgraphId === subgraph.id) {
				root = removeSubStateMachine(root, instance.name);
			}
		}
		layers = layers.map((layer) => {
			let replacement: IAnimatorGraphMachine = layer;
			for (const instance of layer.subStateMachines ?? []) {
				if (instance.subgraphId === subgraph.id) {
					replacement = removeSubStateMachine(replacement, instance.name);
				}
			}
			return { ...layer, ...replacement };
		});
		subgraphs = subgraphs.map((owner) => {
			let replacement: IAnimatorGraphMachine = owner;
			for (const instance of owner.subStateMachines ?? []) {
				if (instance.subgraphId === subgraph.id) {
					replacement = removeSubStateMachine(replacement, instance.name);
				}
			}
			return { ...owner, ...replacement };
		});
	}
	const result = setAnimatorController(
		scene,
		{
			controllerId: controller.id,
			subgraphs,
			subStateMachines: root.subStateMachines ?? [],
			transitions: root.transitions,
			entryTransitions: root.entryTransitions ?? [],
			entryState: root.entryState,
			layers,
		},
		options
	);
	return { ...result, deletedSubgraph: { id: subgraph.id, name: subgraph.name }, removedReferences: references };
}

/** Creates, updates, or removes one sub-state-machine instance in the base, a layer, or a reusable subgraph. */
export function setAnimatorSubStateMachine(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (data.layer && data.parentSubgraphId) {
		throw new Error("Choose either layer or parentSubgraphId for an Animator sub-state-machine owner, not both.");
	}
	const targetSubgraph = data.subgraphId ? controller.subgraphs?.find((subgraph) => subgraph.id === data.subgraphId) : undefined;
	if (data.remove !== true && !targetSubgraph) {
		throw new Error(`Animator reusable subgraph "${String(data.subgraphId)}" was not found.`);
	}
	const parentSubgraph = data.parentSubgraphId ? controller.subgraphs?.find((subgraph) => subgraph.id === data.parentSubgraphId) : undefined;
	if (data.parentSubgraphId && !parentSubgraph) {
		throw new Error(`Animator parent subgraph "${data.parentSubgraphId}" was not found.`);
	}
	const layer = data.layer ? findLayer(controller, data.layer) : undefined;
	const owner: IAnimatorGraphMachine = parentSubgraph ?? layer ?? controller;
	const existingName = data.existingName ?? data.name;
	const existing = (owner.subStateMachines ?? []).find((instance) => instance.name === existingName);
	if (data.remove) {
		if (!existing) {
			throw new Error(`Animator sub-state-machine instance "${existingName}" was not found.`);
		}
		const replacement = removeSubStateMachine(owner, existing.name);
		if (parentSubgraph) {
			const subgraphs = (controller.subgraphs ?? []).map((subgraph) => (subgraph.id === parentSubgraph.id ? { ...parentSubgraph, ...replacement } : subgraph));
			return setAnimatorController(scene, { controllerId: controller.id, subgraphs }, options);
		}
		if (layer) {
			return setAnimatorLayer(scene, { controllerId: controller.id, layer: layer.name, ...replacement }, options);
		}
		return setAnimatorController(scene, { controllerId: controller.id, ...replacement }, options);
	}
	if (!data.name) {
		throw new Error("Animator sub-state-machine instances require a name.");
	}
	const instance: IAnimatorSubStateMachineInstance = {
		name: data.name,
		subgraphId: data.subgraphId,
		...(data.graphPosition ? { graphPosition: data.graphPosition } : existing?.graphPosition ? { graphPosition: existing.graphPosition } : {}),
	};
	const subStateMachines = existing
		? (owner.subStateMachines ?? []).map((candidate) => (candidate.name === existing.name ? instance : candidate))
		: [...(owner.subStateMachines ?? []), instance];
	const renamed = existing && existing.name !== instance.name;
	const renameNode = (name: string): string => (renamed && name === existing.name ? instance.name : name);
	const renameActiveState = (name: string | undefined): string | undefined =>
		renamed && name ? (name === existing.name ? instance.name : name.startsWith(`${existing.name}/`) ? `${instance.name}${name.slice(existing.name.length)}` : name) : name;
	const machineUpdate: Partial<IAnimatorGraphMachine> = {
		subStateMachines,
		...(renamed
			? {
					transitions: owner.transitions.map((transition) => ({ ...transition, from: renameNode(transition.from), to: renameNode(transition.to) })),
					entryTransitions: (owner.entryTransitions ?? []).map((transition) => ({ ...transition, to: renameNode(transition.to) })),
					entryState: renameNode(owner.entryState ?? owner.activeState ?? owner.states[0].name),
					activeState: renameActiveState(owner.activeState),
				}
			: {}),
	};
	if (parentSubgraph) {
		const subgraphs = (controller.subgraphs ?? []).map((subgraph) => (subgraph.id === parentSubgraph.id ? { ...parentSubgraph, ...machineUpdate } : subgraph));
		return setAnimatorController(scene, { controllerId: controller.id, subgraphs }, options);
	}
	if (layer) {
		return setAnimatorLayer(scene, { controllerId: controller.id, layer: layer.name, ...machineUpdate }, options);
	}
	return setAnimatorController(scene, { controllerId: controller.id, ...machineUpdate }, options);
}

function animatorRuntimeDebuggerSnapshot(controller: IAnimatorController, state: IAnimatorRuntimeDebugState, historyLimit: number): any {
	const history = state.history.slice(-historyLimit);
	return {
		fingerprint: animatorRuntimeDebugFingerprint(controller, state),
		paused: state.paused,
		runtimeSeconds: state.runtimeSeconds,
		breakpoints: structuredClone(state.breakpoints),
		history: structuredClone(history),
		historyCount: state.history.length,
		droppedHistoryCount: state.droppedHistoryCount,
		historyTruncated: state.droppedHistoryCount > 0 || history.length < state.history.length,
		lastSequence: state.history[state.history.length - 1]?.sequence ?? 0,
	};
}

/** Atomically replaces runtime-only debugger pause/breakpoint state and optionally clears its bounded transition history. */
export function setAnimatorRuntimeDebug(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	ensureRootMotion(scene);
	const state = getAnimatorRuntimeDebugState(scene, controller.id);
	if (data.expectedFingerprint !== animatorRuntimeDebugFingerprint(controller, state)) {
		throw new Error("Animator runtime debugger changed after inspection. Call get_animator_runtime_debug again and use its exact debugger fingerprint.");
	}
	if (data.paused === undefined && data.breakpoints === undefined && data.clearHistory !== true) {
		throw new Error("Animator runtime debugger update requires paused, breakpoints, or clearHistory=true.");
	}
	const breakpoints = data.breakpoints === undefined ? state.breakpoints : validateAnimatorDebugBreakpoints(controller, data.breakpoints);
	const paused = data.paused === undefined ? state.paused : data.paused;
	if (typeof paused !== "boolean") {
		throw new Error("Animator runtime debugger paused must be a boolean.");
	}
	state.breakpoints = breakpoints;
	state.paused = paused;
	if (data.clearHistory === true) {
		state.history = [];
		state.droppedHistoryCount = 0;
	}
	state.revision++;
	setAnimatorMotionGroupsPaused(scene, controller, paused);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { controllerId: controller.id, controllerName: controller.name, debugger: animatorRuntimeDebuggerSnapshot(controller, state, 64) };
}

/** Advances one paused Animator controller by an exact bounded delta without advancing other controllers or relying on wall-clock rendering. */
export function stepAnimatorRuntimeDebug(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	ensureRootMotion(scene);
	const state = getAnimatorRuntimeDebugState(scene, controller.id);
	if (data.expectedFingerprint !== animatorRuntimeDebugFingerprint(controller, state)) {
		throw new Error("Animator runtime debugger changed after inspection. Call get_animator_runtime_debug again and use its exact debugger fingerprint.");
	}
	if (!state.paused) {
		throw new Error("Pause the Animator runtime debugger before stepping it.");
	}
	const deltaSeconds = data.deltaSeconds ?? 1 / 60;
	const steps = data.steps ?? 1;
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0.0001 || deltaSeconds > 1) {
		throw new Error("Animator debugger step deltaSeconds must be between 0.0001 and 1.");
	}
	if (!Number.isInteger(steps) || steps < 1 || steps > 120 || deltaSeconds * steps > 5) {
		throw new Error("Animator debugger stepping requires 1 through 120 steps totaling at most 5 seconds.");
	}
	let completedSteps = 0;
	let haltedByBreakpoint = false;
	for (; completedSteps < steps; completedSteps++) {
		haltedByBreakpoint = advanceAnimatorControllerRuntime(scene, controller, deltaSeconds, true);
		if (haltedByBreakpoint) {
			completedSteps++;
			break;
		}
	}
	state.paused = true;
	state.revision++;
	setAnimatorMotionGroupsPaused(scene, controller, true);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return {
		controllerId: controller.id,
		controllerName: controller.name,
		stepped: { requestedSteps: steps, completedSteps, deltaSeconds, elapsedSeconds: completedSteps * deltaSeconds, haltedByBreakpoint },
		debugger: animatorRuntimeDebuggerSnapshot(controller, state, 64),
		base: animatorMachineDebug(scene, compileControllerMachine(controller), controller.activeState, controller.id, `${controller.id}:base`, false, controller),
	};
}

/** Captures the live Animator state, timing, cross-fade, parameter, layer, clip-weight, root-motion, and debugger evidence. */
export function getAnimatorRuntimeDebug(scene: Scene, data: any): any {
	const controller = findController(scene, data);
	ensureRootMotion(scene);
	const includeAllClips = data.includeAllClips === true;
	const historyLimit = Number.isInteger(data.historyLimit) ? Math.max(1, Math.min(256, data.historyLimit)) : 64;
	const debugState = getAnimatorRuntimeDebugState(scene, controller.id);
	const parameters = Object.entries(controller.parameters)
		.sort(([first], [second]) => first.localeCompare(second))
		.map(([name, value]) => ({ name, type: controller.parameterTypes?.[name] ?? inferParameterType(value), runtimeType: typeof value, value }));
	const layers = (controller.layers ?? []).map((layer) => ({
		name: layer.name,
		weight: layer.weight ?? 1,
		avatarMaskId: layer.avatarMaskId ?? null,
		maskTargetNames: layer.maskTargetNames ?? [],
		blendingMode: layer.blendingMode ?? "override",
		referencePose: layer.referencePose ?? { normalizedTime: 0 },
		synchronizedLayer: layer.synchronizedLayer ?? null,
		synchronizedTiming: layer.synchronizedTiming === true,
		synchronizedStateMap: layer.synchronizedStateMap ?? {},
		synchronizedMotionOverrides: layer.synchronizedMotionOverrides ?? {},
		synchronizedBehaviourOverrides: layer.synchronizedBehaviourOverrides ?? {},
		activeSynchronizedSourceState: getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer))?.synchronizedSourceState ?? null,
		ikPass: layer.ikPass === true,
		...animatorMachineDebug(
			scene,
			compileLayerMachine(controller, layer),
			layer.activeState,
			`${controller.id}:layer:${layer.name}`,
			`${controller.id}:layer:${layer.name}`,
			includeAllClips,
			controller,
			layer,
			layer.synchronizedLayer ? getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer)) : undefined
		),
	}));
	const rootMotion = controller.rootMotion
		? {
				...controller.rootMotion,
				sourceFound: !!scene.getNodeById(controller.rootMotion.sourceNodeId),
				targetFound: !!scene.getNodeById(controller.rootMotion.targetNodeId),
				sampled: rootMotionSamples.get(scene)?.has(controller.id) ?? false,
				suppressedByTimeParameter: compileControllerMachine(controller).states.some(
					(state) => state.name === controller.activeState && resolveAnimatorStatePlayback(state, controller.parameters).timeDriven
				),
			}
		: null;
	return {
		controllerId: controller.id,
		controllerName: controller.name,
		targetNodeId: controller.targetNodeId ?? null,
		baseIKPass: controller.baseIKPass === true,
		parameters,
		base: animatorMachineDebug(scene, compileControllerMachine(controller), controller.activeState, controller.id, `${controller.id}:base`, includeAllClips, controller),
		layers,
		rootMotion,
		stateBehaviours: getAnimatorStateBehaviourDiagnostics(scene as any, controller),
		ikPasses: getAnimatorIKPassDiagnostics(scene as any, controller, [{ name: "$base", weight: 1, ikPass: controller.baseIKPass }, ...(controller.layers ?? [])]),
		footIK: getAnimatorFootIKDiagnostics(scene as any, controller, [{ name: "$base", weight: 1 }, ...(controller.layers ?? [])]),
		writeDefaults: getAnimatorWriteDefaultsDiagnostics(scene as any, controller.id),
		humanoidMuscleTrace: getAnimatorHumanoidMuscleTrace(scene as any, controller, { limit: 16 }),
		engineDeltaTimeMs: scene.getEngine().getDeltaTime(),
		debugger: animatorRuntimeDebuggerSnapshot(controller, debugState, historyLimit),
	};
}

/** Reads one controller's Avatar binding, current Humanoid pose, and newest-first bounded runtime muscle trace. */
export function getAnimatorHumanoidMuscleTraceForController(scene: Scene, data: any): any {
	const controller = findController(scene, data);
	ensureRootMotion(scene);
	const roles = normalizeMuscleTraceRoles(data.roles);
	const snapshot = getAnimatorHumanoidMuscleTrace(scene as any, controller, {
		roles,
		offset: data.offset,
		limit: data.limit,
	});
	return {
		...snapshot,
		availableAvatars: humanoidAvatars(scene).map((avatar) => ({
			id: avatar.id,
			name: avatar.name,
			skeletonId: avatar.skeletonId,
			skeletonFound: scene.skeletons.some((skeleton) => skeleton.id === avatar.skeletonId),
			mappedBoneCount: Object.keys(avatar.mapping).length,
			muscleLimitsEnabled: avatar.muscleLimitsEnabled === true,
		})),
		fingerprint: animatorHumanoidMuscleTraceFingerprint(scene, controller),
	};
}

/** Assigns or clears a controller Humanoid Avatar and/or clears its runtime-only muscle history under an exact lease. */
export function setAnimatorHumanoidMuscleTrace(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const currentFingerprint = animatorHumanoidMuscleTraceFingerprint(scene, controller);
	if (data.expectedFingerprint !== currentFingerprint) {
		throw new Error(`Animator Humanoid muscle trace changed since it was read. Expected fingerprint "${currentFingerprint}".`);
	}
	const changesAvatar = Object.prototype.hasOwnProperty.call(data, "humanoidAvatarId");
	if (!changesAvatar && data.clearHistory !== true) {
		throw new Error("Provide humanoidAvatarId (string or null) and/or clearHistory: true.");
	}
	if (changesAvatar) {
		if (data.humanoidAvatarId !== null && typeof data.humanoidAvatarId !== "string") {
			throw new Error("humanoidAvatarId must be a string or null.");
		}
		const avatarId = data.humanoidAvatarId === null ? undefined : data.humanoidAvatarId;
		validateControllerHumanoidAvatar(scene, avatarId);
		controller.humanoidAvatarId = avatarId;
		deleteAnimatorHumanoidMuscleTrace(scene as any, controller.id);
		deleteAnimatorFootIKDiagnostics(scene as any, controller.id);
	}
	if (data.clearHistory === true) {
		clearAnimatorHumanoidMuscleTrace(scene as any, controller);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return getAnimatorHumanoidMuscleTraceForController(scene, { controllerId: controller.id, offset: 0, limit: data.limit });
}

/** Opens the Animator panel on one controller and enables its live debugger. */
export function openAnimatorRuntimeDebugger(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	options.editor.layout.selectTab("animations");
	options.editor.layout.animations.openAnimatorDebugger(controller.id);
	return { opened: true, controllerId: controller.id, controllerName: controller.name, mode: "animator-debugger" };
}

/** Replaces selected persisted animator-controller fields after validating clip/state references. */
export function setAnimatorController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const states = data.states ?? controller.states;
	const transitions = data.transitions ?? controller.transitions;
	const entryTransitions = data.entryTransitions ?? controller.entryTransitions ?? [];
	const subStateMachines = data.subStateMachines ?? controller.subStateMachines ?? [];
	const subgraphs = data.subgraphs ?? controller.subgraphs ?? [];
	const parameters = data.parameters ?? controller.parameters;
	const inheritedParameterTypes = Object.fromEntries(
		Object.entries(controller.parameterTypes ?? {}).filter(([name]) => Object.prototype.hasOwnProperty.call(parameters, name))
	) as Record<string, IAnimatorParameterType>;
	const parameterTypes = normalizeParameterTypes(parameters, data.parameterTypes ?? inheritedParameterTypes);
	const layers = (data.layers ?? controller.layers ?? []).map((layer: IAnimatorLayer) => ({
		...layer,
		behaviours: layer.behaviours ?? [],
		transitions: layer.transitions ?? [],
		entryTransitions: layer.entryTransitions ?? [],
		subStateMachines: layer.subStateMachines ?? [],
		entryState: layer.entryState ?? layer.activeState ?? layer.states?.[0]?.name,
	}));
	const rootMachine: IAnimatorGraphMachine = {
		behaviours: data.behaviours ?? controller.behaviours ?? [],
		states,
		transitions,
		entryTransitions,
		subStateMachines,
		entryState: data.entryState ?? controller.entryState,
		activeState: data.activeState ?? controller.activeState,
	};
	validateStates(scene, states);
	validateBlendTreeParameters(parameters, states);
	validateStatePlaybackParameters(parameters, parameterTypes, states, "Animator controller");
	validateTransitions(rootMachine);
	validateTransitionParameters(parameters, parameterTypes, transitions, "Animator controller");
	validateTransitionParameters(parameters, parameterTypes, entryTransitions, "Animator controller Entry");
	validateSubgraphs(scene, parameters, parameterTypes, subgraphs);
	validateLayers(scene, parameters, parameterTypes, layers, subgraphs, rootMachine);
	const entryState = validateEntryState(rootMachine, data.entryState ?? controller.entryState, "Animator controller");
	rootMachine.entryState = entryState;
	const compiled = compileAnimatorMachine(rootMachine, subgraphs);
	const rootMotion = data.rootMotion === undefined ? controller.rootMotion : data.rootMotion;
	validateRootMotion(scene, rootMotion);
	const humanoidAvatarId = Object.prototype.hasOwnProperty.call(data, "humanoidAvatarId")
		? data.humanoidAvatarId === null
			? undefined
			: data.humanoidAvatarId
		: controller.humanoidAvatarId;
	validateControllerHumanoidAvatar(scene, humanoidAvatarId);
	const proposedController: IAnimatorController = {
		...controller,
		targetNodeId: data.targetNodeId ?? controller.targetNodeId,
		humanoidAvatarId,
		behaviours: rootMachine.behaviours,
		states,
		transitions,
		entryTransitions,
		subStateMachines,
		subgraphs,
		layers,
	};
	validateAllBehaviourScriptBindings(scene, proposedController, rootMachine, subgraphs, layers);
	if (data.name !== undefined) {
		controller.name = data.name;
	}
	if (data.targetNodeId !== undefined) {
		controller.targetNodeId = data.targetNodeId;
	}
	if (Object.prototype.hasOwnProperty.call(data, "humanoidAvatarId") && controller.humanoidAvatarId !== humanoidAvatarId) {
		controller.humanoidAvatarId = humanoidAvatarId;
		deleteAnimatorHumanoidMuscleTrace(scene as any, controller.id);
		deleteAnimatorFootIKDiagnostics(scene as any, controller.id);
	}
	if (data.parameters !== undefined) {
		controller.parameters = parameters;
	}
	controller.parameterTypes = parameterTypes;
	controller.baseIKPass = data.baseIKPass ?? controller.baseIKPass ?? false;
	controller.behaviours = rootMachine.behaviours;
	controller.states = states;
	controller.transitions = transitions;
	controller.entryTransitions = entryTransitions;
	controller.subStateMachines = subStateMachines;
	controller.subgraphs = subgraphs;
	controller.entryState = entryState;
	controller.layers = layers.map((layer) => {
		const layerCompiled = compileAnimatorMachine(layer, subgraphs);
		const requested = layer.activeState ?? layer.entryState ?? layerCompiled.entryState;
		try {
			return { ...layer, activeState: resolveCompiledState(layerCompiled, requested).name };
		} catch {
			return { ...layer, activeState: resolveAnimatorEntryState(layerCompiled, parameters) };
		}
	});
	controller.rootMotion = rootMotion;
	deleteAnimatorWriteDefaults(scene as any, controller.id);
	ensureRootMotion(scene);
	const requestedActiveState = data.activeState ?? controller.activeState ?? compiled.entryState;
	try {
		controller.activeState = resolveCompiledState(compiled, requestedActiveState).name;
	} catch (error) {
		if (data.activeState !== undefined) {
			throw error;
		}
		controller.activeState = resolveAnimatorEntryState(compiled, parameters);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return describeController(controller);
}

/** Configures persisted extraction of animated source motion onto a separate target node. */
export function setAnimatorRootMotion(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (data.enabled === false) {
		controller.rootMotion = undefined;
		options.editor.layout.inspector.forceUpdate();
		return describeController(controller);
	}
	const rootMotion = {
		enabled: data.enabled ?? controller.rootMotion?.enabled ?? true,
		sourceNodeId: data.sourceNodeId ?? controller.rootMotion?.sourceNodeId,
		targetNodeId: data.targetNodeId ?? controller.rootMotion?.targetNodeId,
		applyPosition: data.applyPosition ?? controller.rootMotion?.applyPosition ?? true,
		applyRotationY: data.applyRotationY ?? controller.rootMotion?.applyRotationY ?? false,
	};
	return setAnimatorController(scene, { controllerId: controller.id, rootMotion }, options);
}

/** Updates one independent weighted animation layer without replacing the whole controller. */
export function setAnimatorLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const layer = findLayer(controller, data.layer);
	for (const behaviours of Object.values((data.synchronizedBehaviourOverrides ?? {}) as Record<string, NonNullable<IAnimatorState["behaviours"]>>)) {
		validateBehaviourScriptBindings(scene, controller, behaviours);
	}
	const clearingSynchronization = data.synchronizedLayer === null;
	const enablingSynchronization = data.synchronizedLayer !== undefined && data.synchronizedLayer !== null;
	const replacement: IAnimatorLayer = {
		...layer,
		name: data.name ?? layer.name,
		behaviours: data.behaviours ?? layer.behaviours ?? [],
		weight: data.weight ?? layer.weight ?? 1,
		maskTargetNames: data.maskTargetNames ?? layer.maskTargetNames ?? [],
		avatarMaskId: data.avatarMaskId === null ? undefined : (data.avatarMaskId ?? layer.avatarMaskId),
		blendingMode: data.blendingMode ?? layer.blendingMode ?? "override",
		referencePose: data.referencePose ?? layer.referencePose ?? { normalizedTime: 0 },
		synchronizedLayer: clearingSynchronization ? undefined : (data.synchronizedLayer ?? layer.synchronizedLayer),
		synchronizedTiming: clearingSynchronization ? false : (data.synchronizedTiming ?? layer.synchronizedTiming ?? false),
		synchronizedStateMap: clearingSynchronization ? {} : (data.synchronizedStateMap ?? layer.synchronizedStateMap ?? {}),
		synchronizedMotionOverrides: clearingSynchronization ? {} : (data.synchronizedMotionOverrides ?? layer.synchronizedMotionOverrides ?? {}),
		synchronizedBehaviourOverrides: clearingSynchronization ? {} : (data.synchronizedBehaviourOverrides ?? layer.synchronizedBehaviourOverrides ?? {}),
		ikPass: data.ikPass ?? layer.ikPass ?? false,
		states: data.states ?? layer.states,
		transitions: enablingSynchronization ? [] : (data.transitions ?? layer.transitions),
		entryTransitions: enablingSynchronization ? [] : (data.entryTransitions ?? layer.entryTransitions ?? []),
		subStateMachines: data.subStateMachines ?? layer.subStateMachines ?? [],
		entryState: data.entryState ?? layer.entryState ?? layer.activeState ?? layer.states[0]?.name,
		activeState: data.activeState ?? layer.activeState,
	};
	if (data.name !== undefined || data.blendingMode !== undefined || data.referencePose !== undefined) {
		compileLayerMachine(controller, layer).states.forEach((state) => stopStateGroups(scene, controller, state, layer));
	}
	const layers = (controller.layers ?? []).map((candidate) => {
		if (candidate.name === layer.name) {
			return replacement;
		}
		return candidate.synchronizedLayer === layer.name && replacement.name !== layer.name ? { ...candidate, synchronizedLayer: replacement.name } : candidate;
	});
	const result = setAnimatorController(scene, { controllerId: controller.id, layers }, options);
	const updatedLayer = findLayer(controller, replacement.name);
	if (updatedLayer.synchronizedLayer) {
		synchronizeAnimatorLayer(scene, controller, updatedLayer);
	} else if (updatedLayer.activeState && (data.blendingMode !== undefined || data.referencePose !== undefined)) {
		startLayerState(scene, controller, updatedLayer.name, updatedLayer.activeState);
	} else if (updatedLayer.activeState) {
		applyStateMask(
			scene,
			resolveCompiledState(compileLayerMachine(controller, updatedLayer), updatedLayer.activeState),
			updatedLayer.maskTargetNames ?? [],
			updatedLayer.avatarMaskId,
			controller,
			updatedLayer
		);
	}
	return result;
}

/** Updates Unity-style additive/reference-pose and synchronized-layer settings through a focused MCP workflow. */
export function setAnimatorLayerBlending(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (
		data.blendingMode === undefined &&
		data.referencePoseNormalizedTime === undefined &&
		data.synchronizedLayer === undefined &&
		data.synchronizedTiming === undefined &&
		data.synchronizedStateMap === undefined
	) {
		throw new Error("Provide at least one Animator layer blending or synchronization setting.");
	}
	return setAnimatorLayer(
		scene,
		{
			controllerId: data.controllerId,
			controllerName: data.controllerName,
			layer: data.layer,
			...(data.blendingMode !== undefined ? { blendingMode: data.blendingMode } : {}),
			...(data.referencePoseNormalizedTime !== undefined ? { referencePose: { normalizedTime: data.referencePoseNormalizedTime } } : {}),
			...(data.synchronizedLayer !== undefined ? { synchronizedLayer: data.synchronizedLayer } : {}),
			...(data.synchronizedTiming !== undefined ? { synchronizedTiming: data.synchronizedTiming } : {}),
			...(data.synchronizedStateMap !== undefined
				? { synchronizedStateMap: data.synchronizedStateMap }
				: data.synchronizedLayer === null
					? { synchronizedStateMap: {} }
					: {}),
			...(data.synchronizedLayer === null ? { synchronizedMotionOverrides: {}, synchronizedBehaviourOverrides: {} } : {}),
			...(data.synchronizedLayer !== undefined && data.synchronizedLayer !== null ? { transitions: [], entryTransitions: [] } : {}),
		},
		options
	);
}

/** Atomically replaces Unity-style per-source-state motion and StateMachineBehaviour overrides on one synchronized layer. */
export function setAnimatorSynchronizedLayerOverrides(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const layer = findLayer(controller, data.layer);
	if (!layer.synchronizedLayer) {
		throw new Error(`Animator layer "${layer.name}" must be synchronized before defining motion or behaviour overrides.`);
	}
	const synchronizedMotionOverrides = structuredClone(data.motionOverrides ?? {}) as NonNullable<IAnimatorLayer["synchronizedMotionOverrides"]>;
	const synchronizedBehaviourOverrides = structuredClone(data.behaviourOverrides ?? {}) as NonNullable<IAnimatorLayer["synchronizedBehaviourOverrides"]>;
	for (const behaviours of Object.values(synchronizedBehaviourOverrides)) {
		validateBehaviourScriptBindings(scene, controller, behaviours);
	}
	return setAnimatorLayer(
		scene,
		{
			controllerId: controller.id,
			layer: layer.name,
			synchronizedMotionOverrides,
			synchronizedBehaviourOverrides,
		},
		options
	);
}

/** Enables or disables Unity-style OnAnimatorIK execution for one Animator layer. */
export function setAnimatorLayerIKPass(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.layer === "$base") {
		return setAnimatorController(scene, { controllerId: data.controllerId, controllerName: data.controllerName, baseIKPass: data.enabled }, options);
	}
	return setAnimatorLayer(scene, { controllerId: data.controllerId, controllerName: data.controllerName, layer: data.layer, ikPass: data.enabled }, options);
}

/** Atomically updates one ordered transition in the base machine or a named layer. */
export function setAnimatorTransition(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const machine = data.layer ? findLayer(controller, data.layer) : controller;
	if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index >= machine.transitions.length) {
		throw new Error(`Animator transition index must be between 0 and ${Math.max(0, machine.transitions.length - 1)}.`);
	}
	const mutableFields = ["from", "to", "conditions", "exitTime", "duration", "offset", "interruptionSource", "orderedInterruption", "canTransitionToSelf"];
	if (!mutableFields.some((field) => Object.prototype.hasOwnProperty.call(data, field))) {
		throw new Error("Provide at least one Animator transition field to update.");
	}
	const current = machine.transitions[data.index];
	const replacement: IAnimatorTransition = { ...current };
	for (const field of mutableFields) {
		if (!Object.prototype.hasOwnProperty.call(data, field)) {
			continue;
		}
		const value = data[field];
		if ((field === "exitTime" || field === "duration" || field === "offset") && value === null) {
			delete (replacement as any)[field];
		} else {
			(replacement as any)[field] = value;
		}
	}
	const transitions = machine.transitions.map((transition, index) => (index === data.index ? replacement : transition));
	return data.layer
		? setAnimatorLayer(scene, { controllerId: controller.id, layer: machine.name, transitions }, options)
		: setAnimatorController(scene, { controllerId: controller.id, transitions }, options);
}

/** Atomically replaces ordered conditional Entry transitions on the base machine, one layer, or one reusable subgraph. */
export function setAnimatorEntryTransitions(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.layer && data.subgraphId) {
		throw new Error("Choose either layer or subgraphId when setting Animator Entry transitions, not both.");
	}
	const controller = findController(scene, data);
	const entryTransitions = structuredClone(data.entryTransitions ?? []);
	if (data.layer) {
		return setAnimatorLayer(scene, { controllerId: controller.id, layer: data.layer, entryTransitions }, options);
	}
	if (data.subgraphId) {
		return setAnimatorSubgraph(scene, { controllerId: controller.id, subgraphId: data.subgraphId, entryTransitions }, options);
	}
	return setAnimatorController(scene, { controllerId: controller.id, entryTransitions }, options);
}

/** Sets the concrete state reached by the Entry node for the base machine or one layer. */
export function setAnimatorEntryState(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (data.layer) {
		const layer = findLayer(controller, data.layer);
		if (layer.synchronizedLayer) {
			throw new Error(`Animator layer "${layer.name}" inherits its Entry state from synchronized source "${layer.synchronizedLayer}".`);
		}
		validateEntryState(layer, data.state, `Animator layer "${layer.name}"`);
		const result = setAnimatorLayer(scene, { controllerId: controller.id, layer: layer.name, entryState: data.state }, options);
		if (data.play) {
			const updatedLayer = findLayer(controller, layer.name);
			const machine = compileLayerMachine(controller, updatedLayer);
			startLayerState(scene, controller, layer.name, resolveAnimatorEntryState(machine, controller.parameters));
		}
		return data.play ? describeController(controller) : result;
	}
	validateEntryState(controller, data.state, "Animator controller");
	const result = setAnimatorController(scene, { controllerId: controller.id, entryState: data.state }, options);
	if (data.play) {
		const machine = compileControllerMachine(controller);
		startState(scene, controller, resolveAnimatorEntryState(machine, controller.parameters));
	}
	return data.play ? describeController(controller) : result;
}

/** Adds or changes one typed Animator parameter definition and a validated default/current value. */
export function setAnimatorParameterDefinition(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const type = data.type as IAnimatorParameterType;
	if (!["float", "int", "bool", "trigger", "string"].includes(type)) {
		throw new Error(`Unsupported Animator parameter type "${String(type)}".`);
	}
	let value = data.defaultValue ?? controller.parameters[data.parameter] ?? defaultParameterValue(type);
	try {
		validateParameterValue(data.parameter, type, value);
	} catch (error) {
		if (data.defaultValue !== undefined) {
			throw error;
		}
		value = defaultParameterValue(type);
	}
	const parameters = { ...controller.parameters, [data.parameter]: value };
	const parameterTypes = { ...(controller.parameterTypes ?? {}), [data.parameter]: type };
	return setAnimatorController(scene, { controllerId: controller.id, parameters, parameterTypes }, options);
}

/** Plays a state in one layer while preserving the base state and other layers. */
export function setAnimatorLayerState(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	startLayerState(scene, controller, data.layer, data.state);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return describeController(controller);
}

/** Updates one 1D blend-tree state without requiring an MCP client to replace the whole controller. */
export function setAnimatorBlendTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const state = getState(controller, data.state);
	if (!state.blendTree) {
		throw new Error(`Animator state "${data.state}" is not a blend tree.`);
	}
	const blendTree = {
		...state.blendTree,
		...(data.parameter !== undefined ? { parameter: data.parameter } : {}),
		...(data.parameterX !== undefined ? { parameterX: data.parameterX } : {}),
		...(data.parameterY !== undefined ? { parameterY: data.parameterY } : {}),
		...(data.blendMode !== undefined ? { blendMode: data.blendMode } : {}),
		...(data.normalizeWeights !== undefined ? { normalizeWeights: data.normalizeWeights } : {}),
		...(data.children !== undefined ? { children: data.children } : {}),
	};
	if (data.blendMode === "direct") {
		delete blendTree.parameter;
		delete blendTree.parameterX;
		delete blendTree.parameterY;
	} else if (data.parameter !== undefined) {
		delete blendTree.parameterX;
		delete blendTree.parameterY;
		delete blendTree.normalizeWeights;
		if (blendTree.blendMode === "direct") {
			delete blendTree.blendMode;
		}
	} else if (data.parameterX !== undefined || data.parameterY !== undefined) {
		delete blendTree.parameter;
		delete blendTree.normalizeWeights;
		if (blendTree.blendMode === "direct") {
			blendTree.blendMode = "cartesian";
		}
	}
	const parameters = { ...controller.parameters };
	for (const parameter of getAnimatorBlendTreeParameters(blendTree)) {
		if (parameter && typeof parameters[parameter] !== "number") {
			parameters[parameter] = 0;
		}
	}
	const states = controller.states.map((candidate) => (candidate.name === state.name ? { ...candidate, blendTree } : candidate));
	return setAnimatorController(scene, { controllerId: controller.id, states, parameters }, options);
}

/** Sets the target-name include mask for one controller state. An empty list clears the mask. */
export function setAnimatorStateMask(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const state = getState(controller, data.state);
	const targetNames = [...new Set<string>(data.targetNames ?? [])];
	const knownTargets = new Set(getStateTargetNames(scene, state));
	const unknown = targetNames.find((name) => !knownTargets.has(name));
	if (unknown) {
		throw new Error(`Animation mask target "${unknown}" is not animated by state "${state.name}".`);
	}
	const states = controller.states.map((candidate) => (candidate.name === state.name ? { ...candidate, maskTargetNames: targetNames } : candidate));
	const result = setAnimatorController(scene, { controllerId: controller.id, states }, options);
	if (controller.activeState === state.name) {
		applyStateMask(scene, getState(controller, state.name), [], undefined, controller);
	}
	return result;
}

/** Assigns or clears a reusable humanoid Avatar Mask on one base state. */
export function setAnimatorStateAvatarMask(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const state = getState(controller, data.state);
	if (data.avatarMaskId !== null) {
		validateMaskReference(scene, data.avatarMaskId, `Animator state "${state.name}"`);
	}
	const states = controller.states.map((candidate) =>
		candidate.name === state.name ? { ...candidate, avatarMaskId: data.avatarMaskId === null ? undefined : data.avatarMaskId } : candidate
	);
	const result = setAnimatorController(scene, { controllerId: controller.id, states }, options);
	if (controller.activeState === state.name) {
		applyStateMask(scene, getState(controller, state.name), [], undefined, controller);
	}
	return result;
}

/** Replaces the ordered Unity-style script behaviour bindings on one base, layer, or reusable-subgraph state. */
export function setAnimatorStateBehaviours(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (data.layer && data.subgraphId) {
		throw new Error("Choose either layer or subgraphId when setting Animator state behaviours, not both.");
	}
	const behaviours = structuredClone(data.behaviours ?? []) as NonNullable<IAnimatorState["behaviours"]>;
	validateBehaviourScriptBindings(scene, controller, behaviours);
	if (data.layer) {
		const layer = findLayer(controller, data.layer);
		const state = getState(layer, data.state);
		const states = layer.states.map((candidate) => (candidate.name === state.name ? { ...candidate, behaviours } : candidate));
		const result = setAnimatorLayer(scene, { controllerId: controller.id, layer: layer.name, states }, options);
		return { ...result, behaviourOwner: { type: "layer", name: layer.name, state: state.name } };
	}
	if (data.subgraphId) {
		const subgraph = controller.subgraphs?.find((candidate) => candidate.id === data.subgraphId);
		if (!subgraph) {
			throw new Error(`Animator reusable subgraph "${data.subgraphId}" was not found.`);
		}
		const state = getState(subgraph, data.state);
		const states = subgraph.states.map((candidate) => (candidate.name === state.name ? { ...candidate, behaviours } : candidate));
		const result = setAnimatorSubgraph(scene, { controllerId: controller.id, subgraphId: subgraph.id, states }, options);
		return { ...result, behaviourOwner: { type: "subgraph", id: subgraph.id, name: subgraph.name, state: state.name } };
	}
	const state = getState(controller, data.state);
	const states = controller.states.map((candidate) => (candidate.name === state.name ? { ...candidate, behaviours } : candidate));
	const result = setAnimatorController(scene, { controllerId: controller.id, states }, options);
	return { ...result, behaviourOwner: { type: "base", state: state.name } };
}

/** Persists one Animator graph node's canvas position without changing its clip or transitions. */
export function setAnimatorStateGraphPosition(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	const state = getState(controller, data.state);
	if (!Array.isArray(data.position) || data.position.length !== 2 || data.position.some((value: any) => !Number.isFinite(value))) {
		throw new Error("Animator graph position must contain two finite numbers.");
	}
	const graphPosition: [number, number] = [data.position[0], data.position[1]];
	const states = controller.states.map((candidate) => (candidate.name === state.name ? { ...candidate, graphPosition } : candidate));
	return setAnimatorController(scene, { controllerId: controller.id, states }, options);
}

/** Starts a named controller state, stopping its other state clips first. */
export function setAnimatorState(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	startState(scene, controller, data.state);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return describeController(controller);
}

/** Sets a parameter and applies the first eligible transition from the active state. */
export function setAnimatorParameter(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (!Object.prototype.hasOwnProperty.call(controller.parameters, data.parameter)) {
		throw new Error(`Animator parameter "${data.parameter}" was not found. Define it before setting a value.`);
	}
	const parameterType = controller.parameterTypes?.[data.parameter] ?? inferParameterType(controller.parameters[data.parameter]);
	validateParameterValue(data.parameter, parameterType, data.value);
	const elapsed = animatorElapsedSeconds.get(scene)!;
	const baseBefore = compileControllerMachine(controller).states.find((candidate) => candidate.name === controller.activeState);
	const baseProgress = baseBefore ? stateProgress(scene, controller, baseBefore, elapsed.get(controller.id) ?? 0) : 0;
	const layersBefore = new Map(
		(controller.layers ?? []).map((layer) => {
			const state = layer.synchronizedLayer
				? getBehaviourActiveStates(scene).get(behaviourStateKey(controller, layer))
				: compileLayerMachine(controller, layer).states.find((candidate) => candidate.name === layer.activeState);
			const elapsedKey = `${controller.id}:layer:${layer.name}`;
			return [layer.name, { layer, state, progress: state ? stateProgress(scene, controller, state, elapsed.get(elapsedKey) ?? 0, layer) : 0 }] as const;
		})
	);
	const affectsPlayback = (state: IAnimatorState | undefined): boolean => {
		const bindings = state ? resolveAnimatorStatePlayback(state, controller.parameters).bindings : null;
		return !!bindings && Object.values(bindings).includes(data.parameter);
	};
	if (affectsPlayback(baseBefore)) {
		stopStateGroups(scene, controller, baseBefore!);
	}
	for (const { layer, state } of layersBefore.values()) {
		if (affectsPlayback(state)) {
			stopStateGroups(scene, controller, state!, layer);
		}
	}
	controller.parameters[data.parameter] = data.value;
	const activeState = controller.activeState;
	const baseMachine = compileControllerMachine(controller);
	const activeBaseFade = animatorFades.get(scene)?.get(`${controller.id}:base`);
	const transition = controller.activeState
		? activeBaseFade
			? findInterruptionTransition(baseMachine.transitions, activeBaseFade, controller.parameters)
			: findEligibleTransition(baseMachine.transitions, controller.activeState, controller.parameters)
		: undefined;
	if (transition) {
		applyBaseTransition(scene, controller, transition);
	} else if (controller.activeState) {
		const active = resolveCompiledState(baseMachine, controller.activeState);
		if (affectsPlayback(active)) {
			startStateGroups(scene, controller, active, [], undefined, baseProgress);
			const duration = effectiveStateDuration(scene, controller, active);
			elapsed.set(controller.id, duration ? duration * baseProgress : 0);
		}
		applyBlendTree(scene, controller, active);
	}
	let triggerConsumedByLayer = false;
	const layerTransitions = (controller.layers ?? []).flatMap((layer) => {
		if (layer.synchronizedLayer) {
			return [];
		}
		const layerMachine = compileLayerMachine(controller, layer);
		const activeLayerFade = animatorFades.get(scene)?.get(`${controller.id}:layer:${layer.name}`);
		const layerTransition = layer.activeState
			? activeLayerFade
				? findInterruptionTransition(layerMachine.transitions, activeLayerFade, controller.parameters)
				: findEligibleTransition(layerMachine.transitions, layer.activeState, controller.parameters)
			: undefined;
		if (layerTransition) {
			const from = layer.activeState;
			triggerConsumedByLayer ||= transitionConsumesParameter(layerTransition.transition, data.parameter);
			applyLayerTransition(scene, controller, layer, layerTransition);
			const authored = authoredTransition(layerTransition.transition);
			return [{ layer: layer.name, from, source: authored.from, to: layerTransition.transition.to, interrupted: layerTransition.interrupted }];
		}
		if (layer.activeState) {
			const active = resolveCompiledState(layerMachine, layer.activeState);
			const previous = layersBefore.get(layer.name);
			if (affectsPlayback(active)) {
				startStateGroups(scene, controller, active, layer.maskTargetNames ?? [], layer.avatarMaskId, previous?.progress ?? 0, layer);
				const duration = effectiveStateDuration(scene, controller, active, layer);
				elapsed.set(`${controller.id}:layer:${layer.name}`, duration ? duration * (previous?.progress ?? 0) : 0);
			}
			applyBlendTree(scene, controller, active, layer.weight ?? 1, layer);
		}
		return [];
	});
	synchronizeAnimatorLayers(scene, controller);
	const triggerConsumed = parameterType === "trigger" && data.value === true && (transitionConsumesParameter(transition?.transition, data.parameter) || triggerConsumedByLayer);
	if (triggerConsumed) {
		controller.parameters[data.parameter] = false;
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return {
		...describeController(controller),
		transitioned: transition
			? { from: activeState, source: authoredTransition(transition.transition).from, to: transition.transition.to, interrupted: transition.interrupted }
			: null,
		layerTransitions,
		trigger: parameterType === "trigger" ? { parameter: data.parameter, consumed: triggerConsumed, armed: controller.parameters[data.parameter] === true } : null,
	};
}

/** Arms one trigger parameter, evaluates transitions once, and resets it only when a matching transition consumes it. */
export function setAnimatorTrigger(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (controller.parameterTypes?.[data.parameter] !== "trigger") {
		throw new Error(`Animator parameter "${data.parameter}" is not declared as a trigger.`);
	}
	return setAnimatorParameter(scene, { controllerId: controller.id, parameter: data.parameter, value: true }, options);
}

/** Clears one trigger parameter without evaluating transitions. */
export function resetAnimatorTrigger(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	if (controller.parameterTypes?.[data.parameter] !== "trigger") {
		throw new Error(`Animator parameter "${data.parameter}" is not declared as a trigger.`);
	}
	controller.parameters[data.parameter] = false;
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { ...describeController(controller), trigger: { parameter: data.parameter, consumed: false, armed: false, reset: true } };
}

/** Deletes a persisted animator controller without deleting its animation clips. */
export function deleteAnimatorController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = findController(scene, data);
	activeAnimatorMotionGroups(scene, controller).forEach((group) => group.stop());
	const controllers = getControllers(scene);
	controllers.splice(controllers.indexOf(controller), 1);
	rootMotionSamples.get(scene)?.delete(controller.id);
	animatorRuntimeDebugStates.get(scene)?.delete(controller.id);
	deleteAnimatorHumanoidMuscleTrace(scene as any, controller.id);
	deleteAnimatorFootIKDiagnostics(scene as any, controller.id);
	deleteAnimatorWriteDefaults(scene as any, controller.id);
	for (const key of animatorElapsedSeconds.get(scene)?.keys() ?? []) {
		if (key === controller.id || key.startsWith(`${controller.id}:`)) {
			animatorElapsedSeconds.get(scene)?.delete(key);
		}
	}
	for (const key of animatorBehaviourActiveStates.get(scene)?.keys() ?? []) {
		if (key.startsWith(`${controller.id}:`)) {
			animatorBehaviourActiveStates.get(scene)?.delete(key);
		}
	}
	for (const key of animatorFades.get(scene)?.keys() ?? []) {
		if (key.startsWith(`${controller.id}:`)) {
			animatorFades.get(scene)?.delete(key);
		}
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: controller.id };
}

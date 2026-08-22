import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { AnimationGroupMask } from "@babylonjs/core/Animations/animationGroupMask";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { IHumanoidAvatar, IHumanoidAvatarMask, resolveHumanoidAvatarMaskTargetNames } from "../assets/humanoid-avatar";
import {
	compileAnimatorMachine,
	IAnimatorGraphMachine,
	IAnimatorGraphState,
	IAnimatorGraphTransition,
	IAnimatorSubgraphDefinition,
	ICompiledAnimatorMachine,
	ICompiledAnimatorState,
	ICompiledAnimatorTransition,
	resolveAnimatorStatePlayback,
} from "./animator-graph";
import { AnimatorLayerAnimationGroups, AnimatorLayerBlendingMode, IAnimatorLayerReferencePose } from "./animator-layer-groups";
import { applyAnimatorFootIK, deleteAnimatorFootIKDiagnostics, getAnimatorFootIKDiagnostics } from "./animator-foot-ik";
import { applyAnimatorWriteDefaults, deleteAnimatorWriteDefaults, getAnimatorWriteDefaultsDiagnostics } from "./animator-write-defaults";
import { evaluateAnimatorBlendTreeMotions, getAnimatorBlendTreeMotions, IAnimatorBlendTreeMotion } from "./animator-blend-tree";
import { getAnimatorIKPassDiagnostics, invokeAnimatorIKPass } from "./animator-ik-pass";
import { captureAnimatorHumanoidMuscleTrace, deleteAnimatorHumanoidMuscleTrace, getAnimatorHumanoidMuscleTrace } from "./animator-muscle-trace";
import {
	getAnimatorStateBehaviourDiagnostics,
	getAnimatorStateMachineBehaviourTransitions,
	invokeAnimatorStateBehaviours,
	invokeAnimatorStateMachineBehaviours,
} from "./animator-state-behaviours";

type IController = IAnimatorGraphMachine & {
	id: string;
	name: string;
	humanoidAvatarId?: string;
	parameters: Record<string, string | number | boolean>;
	parameterTypes?: Record<string, "float" | "int" | "bool" | "trigger" | "string">;
	baseIKPass?: boolean;
	subgraphs?: IAnimatorSubgraphDefinition[];
	layers?: (IAnimatorGraphMachine & {
		name: string;
		weight?: number;
		maskTargetNames?: string[];
		avatarMaskId?: string;
		blendingMode?: AnimatorLayerBlendingMode;
		referencePose?: IAnimatorLayerReferencePose;
		synchronizedLayer?: "$base" | string;
		synchronizedTiming?: boolean;
		synchronizedStateMap?: Record<string, string>;
		synchronizedMotionOverrides?: Record<string, Pick<IAnimatorGraphState, "animationGroup" | "blendTree">>;
		synchronizedBehaviourOverrides?: Record<string, NonNullable<IAnimatorGraphState["behaviours"]>>;
		ikPass?: boolean;
	})[];
	rootMotion?: { enabled: boolean; sourceNodeId: string; targetNodeId: string; applyPosition?: boolean; applyRotationY?: boolean };
};

type IState = IAnimatorGraphState & { synchronizedSourceState?: string };
type ITransition = IAnimatorGraphTransition;
type ILayer = NonNullable<IController["layers"]>[number];

type ITransitionMatch = {
	transition: ITransition;
	index: number;
	evaluatedState: string;
	interrupted: boolean;
};

type IRuntimeFade = {
	sources: { state: IState; weight: number }[];
	to?: IState;
	toStartWeight: number;
	targetWeight: number;
	elapsed: number;
	duration: number;
	transition?: ITransition;
	transitionIndex?: number;
	sourceState?: string;
	interrupted?: boolean;
};

type IPendingStateBehaviour = {
	kind: "state";
	phase: "enter" | "exit";
	state: IState;
	layer?: ILayer;
	elapsedSeconds: number;
	normalizedTime: number;
	interrupted: boolean;
};

type IPendingStateMachineBehaviour = {
	kind: "machine";
	phase: "machineEnter" | "machineExit";
	behaviours: NonNullable<IAnimatorGraphMachine["behaviours"]>;
	machinePath: string[];
	layer?: ILayer;
	interrupted: boolean;
};

export const ANIMATOR_ANY_STATE = "$any";
export const ANIMATOR_EXIT_STATE = "$exit";

function inferParameterType(value: string | number | boolean): "float" | "int" | "bool" | "string" {
	if (typeof value === "boolean") {
		return "bool";
	}
	if (typeof value === "number") {
		return "float";
	}
	return "string";
}

function validateParameterValue(name: string, type: string, value: string | number | boolean): void {
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

function avatarMaskNames(scene: Scene, maskId: string | undefined): string[] {
	if (!maskId) {
		return [];
	}
	const mask = (scene.metadata?.babylonEditorHumanoidAvatarMasks as IHumanoidAvatarMask[] | undefined)?.find((candidate) => candidate.id === maskId);
	const avatar = mask ? (scene.metadata?.babylonEditorHumanoidAvatars as IHumanoidAvatar[] | undefined)?.find((candidate) => candidate.id === mask.avatarId) : undefined;
	return mask && avatar ? resolveHumanoidAvatarMaskTargetNames(avatar, mask.bodyParts, mask.transformNames) : [];
}

function applyMask(scene: Scene, animationGroup: AnimationGroup, state: IState, fallbackTargetNames: string[] = [], fallbackAvatarMaskId?: string): void {
	const avatarMaskId = state.avatarMaskId ?? fallbackAvatarMaskId;
	const names = [...new Set([...avatarMaskNames(scene, avatarMaskId), ...(state.maskTargetNames ?? fallbackTargetNames)])];
	animationGroup.mask = avatarMaskId || names.length ? new AnimationGroupMask(names) : null;
}

function matches(parameters: IController["parameters"], conditions: any[]): boolean {
	return conditions.every((condition) => {
		const value = parameters[condition.parameter];
		return (
			(condition.equals === undefined || value === condition.equals) &&
			(condition.notEquals === undefined || value !== condition.notEquals) &&
			(condition.greaterThan === undefined || (typeof value === "number" && value > condition.greaterThan)) &&
			(condition.lessThan === undefined || (typeof value === "number" && value < condition.lessThan))
		);
	});
}

function transitionMatches(candidate: ITransition, evaluatedState: string, parameters: IController["parameters"], progress?: number): boolean {
	return (
		(candidate.from === evaluatedState || candidate.from === ANIMATOR_ANY_STATE) &&
		(candidate.to !== evaluatedState || candidate.canTransitionToSelf === true) &&
		(candidate.exitTime === undefined || (progress !== undefined && progress >= candidate.exitTime)) &&
		matches(parameters, candidate.conditions ?? [])
	);
}

function findEligibleTransition(transitions: ITransition[], activeState: string, parameters: IController["parameters"], progress?: number): ITransitionMatch | undefined {
	const index = transitions.findIndex((candidate) => transitionMatches(candidate, activeState, parameters, progress));
	return index >= 0 ? { transition: transitions[index], index, evaluatedState: activeState, interrupted: false } : undefined;
}

function fadeWeights(fade: IRuntimeFade): Map<string, { state: IState; weight: number }> {
	const amount = Math.min(1, fade.elapsed / fade.duration);
	const weights = new Map<string, { state: IState; weight: number }>();
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

function findInterruptionTransition(transitions: ITransition[], fade: IRuntimeFade | undefined, parameters: IController["parameters"]): ITransitionMatch | undefined {
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

/** Runtime controller API reconstructed from editor animator metadata. */
export class AnimatorControllerRuntime {
	private _lastRootSample: { position: Vector3; rotationY: number } | null = null;
	private _elapsedSeconds = 0;
	private _transition: IRuntimeFade | null = null;
	private _layerTransitions = new Map<string, IRuntimeFade>();
	private _layerElapsedSeconds = new Map<string, number>();
	private _layerAnimationGroups: AnimatorLayerAnimationGroups;
	private _baseLifecycleState: string | null = null;
	private _layerLifecycleStates = new Map<string, IState>();
	private _pendingStateBehaviours: Array<IPendingStateBehaviour | IPendingStateMachineBehaviour> = [];
	private _runtimeSeconds = 0;
	private _disposed = false;

	public constructor(
		private _scene: Scene,
		private _controller: IController
	) {
		this._layerAnimationGroups = new AnimatorLayerAnimationGroups(this._scene);
		this._scene.onDisposeObservable.addOnce(() => this._layerAnimationGroups.dispose());
	}

	/** Stops this controller and releases its non-serialized layer animation groups. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._layerAnimationGroups.dispose();
		deleteAnimatorHumanoidMuscleTrace(this._scene, this._controller.id);
		deleteAnimatorFootIKDiagnostics(this._scene, this._controller.id);
		deleteAnimatorWriteDefaults(this._scene, this._controller.id);
	}
	public setParameter(name: string, value: string | number | boolean): boolean {
		if (!Object.prototype.hasOwnProperty.call(this._controller.parameters, name)) {
			throw new Error(`Animator parameter "${name}" was not found.`);
		}
		const parameterType = this._controller.parameterTypes?.[name] ?? inferParameterType(this._controller.parameters[name]);
		validateParameterValue(name, parameterType, value);
		const baseBefore = this._compileBaseMachine().states.find((candidate) => candidate.name === this._controller.activeState);
		const baseProgress = baseBefore ? this._stateProgress(baseBefore, this._elapsedSeconds) : 0;
		const layersBefore = new Map(
			(this._controller.layers ?? []).map((layer) => {
				const state = layer.synchronizedLayer
					? this._layerLifecycleStates.get(layer.name)
					: this._compileLayerMachine(layer).states.find((candidate) => candidate.name === layer.activeState);
				return [layer.name, { layer, state, progress: state ? this._stateProgress(state, this._layerElapsedSeconds.get(layer.name) ?? 0, layer) : 0 }] as const;
			})
		);
		const affectsPlayback = (state: IState | undefined): boolean => {
			const bindings = state ? resolveAnimatorStatePlayback(state, this._controller.parameters).bindings : null;
			return !!bindings && Object.values(bindings).includes(name);
		};
		if (affectsPlayback(baseBefore)) {
			this._stopStateGroups(baseBefore!);
		}
		for (const { layer, state } of layersBefore.values()) {
			if (affectsPlayback(state)) {
				this._stopStateGroups(state!, layer);
			}
		}
		this._controller.parameters[name] = value;
		const baseMachine = this._compileBaseMachine();
		const transition = this._controller.activeState
			? this._transition
				? findInterruptionTransition(baseMachine.transitions, this._transition, this._controller.parameters)
				: findEligibleTransition(baseMachine.transitions, this._controller.activeState, this._controller.parameters)
			: undefined;
		if (transition) {
			this._applyBaseTransition(transition);
		} else {
			const active = baseMachine.states.find((candidate) => candidate.name === this._controller.activeState);
			if (active) {
				if (affectsPlayback(active)) {
					this._startStateGroups(active, [], undefined, baseProgress);
					const duration = this._effectiveStateDuration(active);
					this._elapsedSeconds = duration ? duration * baseProgress : 0;
				}
				this._applyBlendTree(active);
			}
		}
		let transitioned = !!transition;
		let triggerConsumedByLayer = false;
		for (const layer of this._controller.layers ?? []) {
			if (layer.synchronizedLayer) {
				continue;
			}
			const layerMachine = this._compileLayerMachine(layer);
			const activeLayerFade = this._layerTransitions.get(layer.name);
			const layerTransition = layer.activeState
				? activeLayerFade
					? findInterruptionTransition(layerMachine.transitions, activeLayerFade, this._controller.parameters)
					: findEligibleTransition(layerMachine.transitions, layer.activeState, this._controller.parameters)
				: undefined;
			if (layerTransition) {
				triggerConsumedByLayer ||= !!layerTransition.transition.conditions?.some((condition) => condition.parameter === name);
				this._applyLayerTransition(layer, layerTransition);
				transitioned = true;
			} else {
				const layerState = layerMachine.states.find((candidate) => candidate.name === layer.activeState);
				if (layerState) {
					const previous = layersBefore.get(layer.name);
					if (affectsPlayback(layerState)) {
						this._startStateGroups(layerState, layer.maskTargetNames ?? [], layer.avatarMaskId, previous?.progress ?? 0, layer);
						const duration = this._effectiveStateDuration(layerState, layer);
						this._layerElapsedSeconds.set(layer.name, duration ? duration * (previous?.progress ?? 0) : 0);
					}
					this._applyBlendTree(layerState, layer.weight ?? 1, layer);
				}
			}
		}
		this._synchronizeLayers();
		if (parameterType === "trigger" && value === true && (!!transition?.transition.conditions?.some((condition) => condition.parameter === name) || triggerConsumedByLayer)) {
			this._controller.parameters[name] = false;
		}
		return transitioned;
	}
	/** Arms one trigger and consumes it only when a matching base/layer transition fires. */
	public setTrigger(name: string): boolean {
		if (this._controller.parameterTypes?.[name] !== "trigger") {
			throw new Error(`Animator parameter "${name}" is not declared as a trigger.`);
		}
		return this.setParameter(name, true);
	}
	/** Clears one trigger without evaluating transitions. */
	public resetTrigger(name: string): void {
		if (this._controller.parameterTypes?.[name] !== "trigger") {
			throw new Error(`Animator parameter "${name}" is not declared as a trigger.`);
		}
		this._controller.parameters[name] = false;
	}
	/** Plays the configured Entry destination for the base machine or one named layer. */
	public playEntry(layerName?: string): void {
		if (layerName) {
			const layer = this._controller.layers?.find((candidate) => candidate.name === layerName);
			if (!layer) {
				throw new Error(`Animator layer "${layerName}" was not found.`);
			}
			if (layer.synchronizedLayer) {
				this._synchronizeLayer(layer);
				return;
			}
			const machine = this._compileLayerMachine(layer);
			this.playLayer(layer.name, this._resolveEntryState(machine));
			return;
		}
		const machine = this._compileBaseMachine();
		this.play(this._resolveEntryState(machine));
	}
	/** Returns a non-mutating runtime debugger snapshot for custom in-game tooling and automated diagnostics. */
	public getDebugSnapshot(includeAllClips = false): any {
		return {
			controllerId: this._controller.id,
			controllerName: this._controller.name,
			humanoidAvatarId: this._controller.humanoidAvatarId ?? null,
			baseIKPass: this._controller.baseIKPass === true,
			parameters: Object.entries(this._controller.parameters)
				.sort(([first], [second]) => first.localeCompare(second))
				.map(([name, value]) => ({
					name,
					type: this._controller.parameterTypes?.[name] ?? inferParameterType(value),
					runtimeType: typeof value,
					value,
				})),
			base: this._debugMachine(this._compileBaseMachine(), this._controller.activeState, this._elapsedSeconds, this._transition, includeAllClips),
			layers: (this._controller.layers ?? []).map((layer) => ({
				name: layer.name,
				weight: layer.weight ?? 1,
				blendingMode: layer.blendingMode ?? "override",
				referencePose: layer.referencePose ?? { normalizedTime: 0 },
				synchronizedLayer: layer.synchronizedLayer ?? null,
				synchronizedTiming: layer.synchronizedTiming === true,
				synchronizedStateMap: layer.synchronizedStateMap ?? {},
				synchronizedMotionOverrides: layer.synchronizedMotionOverrides ?? {},
				synchronizedBehaviourOverrides: layer.synchronizedBehaviourOverrides ?? {},
				ikPass: layer.ikPass === true,
				...this._debugMachine(
					this._compileLayerMachine(layer),
					layer.activeState,
					this._layerElapsedSeconds.get(layer.name) ?? 0,
					this._layerTransitions.get(layer.name) ?? null,
					includeAllClips,
					layer
				),
			})),
			rootMotion: this._controller.rootMotion
				? {
						...this._controller.rootMotion,
						sourceFound: !!this._scene.getNodeById(this._controller.rootMotion.sourceNodeId),
						targetFound: !!this._scene.getNodeById(this._controller.rootMotion.targetNodeId),
						sampled: !!this._lastRootSample,
						suppressedByTimeParameter: this._compileBaseMachine().states.some(
							(state) => state.name === this._controller.activeState && resolveAnimatorStatePlayback(state, this._controller.parameters).timeDriven
						),
					}
				: null,
			stateBehaviours: getAnimatorStateBehaviourDiagnostics(this._scene, this._controller),
			ikPasses: getAnimatorIKPassDiagnostics(this._scene, this._controller, [
				{ name: "$base", weight: 1, ikPass: this._controller.baseIKPass },
				...(this._controller.layers ?? []),
			]),
			footIK: getAnimatorFootIKDiagnostics(this._scene, this._controller, [{ name: "$base", weight: 1 }, ...(this._controller.layers ?? [])]),
			writeDefaults: getAnimatorWriteDefaultsDiagnostics(this._scene, this._controller.id),
			humanoidMuscleTrace: getAnimatorHumanoidMuscleTrace(this._scene, this._controller, { limit: 16 }),
			engineDeltaTimeMs: this._scene.getEngine().getDeltaTime(),
		};
	}
	public play(stateName: string, transitionDuration = 0, offset = 0, match?: ITransitionMatch): void {
		const machine = this._compileBaseMachine();
		const resolvedStateName = this._resolveStateName(machine, stateName);
		const state = machine.states.find((value) => value.name === resolvedStateName);
		if (!state) {
			throw new Error(`Animator state "${stateName}" was not found.`);
		}
		const previous = machine.states.find((value) => value.name === this._controller.activeState);
		const existingFade = this._transition;
		const selfTransition = previous === state;
		const canCrossFade = !!previous && !selfTransition && Number.isFinite(transitionDuration) && transitionDuration > 0;
		if (!canCrossFade) {
			machine.states.forEach((value) => this._stopStateGroups(value));
		}
		this._startStateGroups(state, [], undefined, offset);
		const lifecyclePrevious = this._baseLifecycleState ? machine.states.find((value) => value.name === this._baseLifecycleState) : undefined;
		if (lifecyclePrevious) {
			this._queueStateBehaviour("exit", lifecyclePrevious, undefined, match?.interrupted === true);
		}
		this._queueStateMachineBehaviours(machine, lifecyclePrevious, state, undefined, match?.interrupted === true);
		this._baseLifecycleState = state.name;
		this._controller.activeState = state.name;
		const durationSeconds = this._effectiveStateDuration(state);
		this._elapsedSeconds = durationSeconds ? durationSeconds * offset : 0;
		this._queueStateBehaviour("enter", state, undefined, match?.interrupted === true);
		this._lastRootSample = null;
		this._transition = null;
		if (canCrossFade) {
			const { sources, targetStartWeight } = this._transitionSources(previous!, existingFade, state, 1);
			this._applyStateWeight(state, targetStartWeight);
			this._transition = {
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
			};
		} else {
			this._applyStateWeight(state, 1);
		}
	}
	/** Advances automatic exit-time transitions using normalized current-state clip progress. */
	public update(deltaSeconds: number): boolean {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
			return false;
		}
		this._flushPendingStateBehaviours();
		this._advanceTransitions(deltaSeconds);
		const baseMachine = this._compileBaseMachine();
		const state = baseMachine.states.find((candidate) => candidate.name === this._controller.activeState);
		let transitioned = false;
		const consumedTriggers = new Set<string>();
		if (state) {
			this._elapsedSeconds += deltaSeconds;
			const progress = this._stateProgress(state, this._elapsedSeconds);
			this._applyWriteDefaults(state);
			this._seekStateGroups(state, progress);
			this._invokeStateBehaviourUpdate(state, deltaSeconds, this._elapsedSeconds, progress);
			const transition = this._transition
				? findInterruptionTransition(baseMachine.transitions, this._transition, this._controller.parameters)
				: findEligibleTransition(baseMachine.transitions, state.name, this._controller.parameters, progress);
			if (transition) {
				this._applyBaseTransition(transition);
				for (const condition of transition.transition.conditions ?? []) {
					if (this._controller.parameterTypes?.[condition.parameter] === "trigger") {
						consumedTriggers.add(condition.parameter);
					}
				}
				transitioned = true;
			}
		}
		for (const layer of this._controller.layers ?? []) {
			if (layer.synchronizedLayer) {
				this._synchronizeLayer(layer);
				const synchronizedState = this._layerLifecycleStates.get(layer.name);
				if (synchronizedState) {
					const synchronizedElapsed = this._layerElapsedSeconds.get(layer.name) ?? 0;
					const synchronizedProgress = this._stateProgress(synchronizedState, synchronizedElapsed, layer);
					this._invokeStateBehaviourUpdate(synchronizedState, deltaSeconds, synchronizedElapsed, synchronizedProgress, layer);
				}
				continue;
			}
			const layerMachine = this._compileLayerMachine(layer);
			const layerState = layerMachine.states.find((candidate) => candidate.name === layer.activeState);
			if (!layerState) {
				continue;
			}
			const elapsed = (this._layerElapsedSeconds.get(layer.name) ?? 0) + deltaSeconds;
			this._layerElapsedSeconds.set(layer.name, elapsed);
			const layerProgress = this._stateProgress(layerState, elapsed, layer);
			this._applyWriteDefaults(layerState, layer);
			this._seekStateGroups(layerState, layerProgress, layer);
			this._invokeStateBehaviourUpdate(layerState, deltaSeconds, elapsed, layerProgress, layer);
			const activeLayerFade = this._layerTransitions.get(layer.name);
			const layerTransition = activeLayerFade
				? findInterruptionTransition(layerMachine.transitions, activeLayerFade, this._controller.parameters)
				: findEligibleTransition(layerMachine.transitions, layerState.name, this._controller.parameters, layerProgress);
			if (!layerTransition) {
				continue;
			}
			this._applyLayerTransition(layer, layerTransition);
			for (const condition of layerTransition.transition.conditions ?? []) {
				if (this._controller.parameterTypes?.[condition.parameter] === "trigger") {
					consumedTriggers.add(condition.parameter);
				}
			}
			transitioned = true;
		}
		for (const parameter of consumedTriggers) {
			this._controller.parameters[parameter] = false;
		}
		this._flushPendingStateBehaviours();
		this._invokeIKPasses(deltaSeconds);
		this._runtimeSeconds += deltaSeconds;
		captureAnimatorHumanoidMuscleTrace(this._scene, this._controller, { runtimeSeconds: this._runtimeSeconds, deltaSeconds });
		return transitioned;
	}
	public playLayer(layerName: string, stateName: string, transitionDuration = 0, offset = 0, match?: ITransitionMatch): void {
		const layer = this._controller.layers?.find((candidate) => candidate.name === layerName);
		if (!layer) {
			throw new Error(`Animator layer "${layerName}" was not found.`);
		}
		if (layer.synchronizedLayer) {
			throw new Error(`Animator layer "${layerName}" is synchronized to "${layer.synchronizedLayer}" and cannot be played independently.`);
		}
		this._playLayerState(layer, stateName, transitionDuration, offset, match);
	}
	private _playLayerState(layer: ILayer, stateName: string, transitionDuration = 0, offset = 0, match?: ITransitionMatch, stateOverride?: IState): void {
		const machine = this._compileLayerMachine(layer);
		const resolvedStateName = this._resolveStateName(machine, stateName);
		const state = stateOverride ?? machine.states.find((value) => value.name === resolvedStateName);
		if (!state) {
			throw new Error(`Animator layer state "${stateName}" was not found.`);
		}
		const lifecyclePrevious = this._layerLifecycleStates.get(layer.name);
		const previous = lifecyclePrevious ?? machine.states.find((value) => value.name === layer.activeState);
		const existingFade = this._layerTransitions.get(layer.name);
		const selfTransition = previous?.name === state.name;
		const canCrossFade = !!previous && !selfTransition && Number.isFinite(transitionDuration) && transitionDuration > 0;
		if (!canCrossFade) {
			machine.states.forEach((value) => this._stopStateGroups(value, layer));
			this._stopStateGroups(previous ?? state, layer);
		}
		this._startStateGroups(state, layer.maskTargetNames ?? [], layer.avatarMaskId, offset, layer);
		if (lifecyclePrevious) {
			this._queueStateBehaviour("exit", lifecyclePrevious, layer, match?.interrupted === true);
		}
		this._queueStateMachineBehaviours(machine, lifecyclePrevious, state, layer, match?.interrupted === true);
		this._layerLifecycleStates.set(layer.name, state);
		layer.activeState = state.name;
		const durationSeconds = this._effectiveStateDuration(state, layer);
		this._layerElapsedSeconds.set(layer.name, durationSeconds ? durationSeconds * offset : 0);
		this._queueStateBehaviour("enter", state, layer, match?.interrupted === true);
		this._layerTransitions.delete(layer.name);
		if (canCrossFade) {
			const targetWeight = layer.weight ?? 1;
			const { sources, targetStartWeight } = this._transitionSources(previous!, existingFade, state, targetWeight);
			this._applyStateWeight(state, targetStartWeight, layer);
			this._layerTransitions.set(layer.name, {
				sources,
				to: state,
				toStartWeight: targetStartWeight,
				targetWeight,
				elapsed: 0,
				duration: transitionDuration,
				transition: match?.transition,
				transitionIndex: match?.index,
				sourceState: match?.evaluatedState ?? previous?.name,
				interrupted: match?.interrupted,
			});
		} else {
			this._applyStateWeight(state, layer.weight ?? 1, layer);
		}
	}
	/** Applies the animated source transform delta to the configured separate character target. */
	public applyRootMotion(): boolean {
		const config = this._controller.rootMotion;
		if (!config?.enabled) {
			this._lastRootSample = null;
			return false;
		}
		const state = this._compileBaseMachine().states.find((candidate) => candidate.name === this._controller.activeState);
		if (state && resolveAnimatorStatePlayback(state, this._controller.parameters).timeDriven) {
			this._lastRootSample = null;
			return false;
		}
		const source: any = this._scene.getNodeById(config.sourceNodeId);
		const target: any = this._scene.getNodeById(config.targetNodeId);
		if (!source?.position || !target?.position || source === target) {
			return false;
		}
		const sample = { position: source.position.clone(), rotationY: source.rotation?.y ?? 0 };
		if (!this._lastRootSample) {
			this._lastRootSample = sample;
			return false;
		}
		if (config.applyPosition !== false) {
			target.position.addInPlace(sample.position.subtract(this._lastRootSample.position));
		}
		if (config.applyRotationY) {
			target.rotation.y += sample.rotationY - this._lastRootSample.rotationY;
		}
		this._lastRootSample = sample;
		return true;
	}
	private _applyBaseTransition(match: ITransitionMatch): void {
		const duration = this._transitionDurationSeconds(match.transition, match.evaluatedState);
		if (match.transition.to === ANIMATOR_EXIT_STATE) {
			this._exit(duration, match);
		} else {
			this.play(match.transition.to, duration, match.transition.offset ?? 0, match);
		}
	}
	private _applyLayerTransition(layer: ILayer, match: ITransitionMatch): void {
		const duration = this._transitionDurationSeconds(match.transition, match.evaluatedState, layer);
		if (match.transition.to === ANIMATOR_EXIT_STATE) {
			this._exitLayer(layer, duration, match);
		} else {
			this.playLayer(layer.name, match.transition.to, duration, match.transition.offset ?? 0, match);
		}
	}
	private _transitionDurationSeconds(transition: ITransition, sourceState: string, layer?: ILayer): number {
		const duration = transition.duration ?? 0;
		if (transition.durationMode !== "normalized" || duration <= 0) {
			return duration;
		}
		const machine = layer ? this._compileLayerMachine(layer) : this._compileBaseMachine();
		const state = machine.states.find((candidate) => candidate.name === sourceState);
		return state ? duration * (this._effectiveStateDuration(state, layer) ?? 0) : 0;
	}
	private _exit(transitionDuration: number, match?: ITransitionMatch): void {
		const machine = this._compileBaseMachine();
		const previous = machine.states.find((state) => state.name === this._controller.activeState);
		const existingFade = this._transition;
		this._transition = null;
		if (previous && Number.isFinite(transitionDuration) && transitionDuration > 0) {
			const { sources } = this._transitionSources(previous, existingFade, undefined, 1);
			this._transition = {
				sources,
				toStartWeight: 0,
				targetWeight: 0,
				elapsed: 0,
				duration: transitionDuration,
				transition: match?.transition,
				transitionIndex: match?.index,
				sourceState: match?.evaluatedState ?? previous.name,
				interrupted: match?.interrupted,
			};
		} else {
			machine.states.forEach((state) => this._stopStateGroups(state));
		}
		const lifecyclePrevious = this._baseLifecycleState ? machine.states.find((state) => state.name === this._baseLifecycleState) : undefined;
		if (lifecyclePrevious) {
			this._queueStateBehaviour("exit", lifecyclePrevious, undefined, match?.interrupted === true);
		}
		this._queueStateMachineBehaviours(machine, lifecyclePrevious, null, undefined, match?.interrupted === true);
		this._baseLifecycleState = null;
		this._controller.activeState = undefined;
		this._elapsedSeconds = 0;
		this._lastRootSample = null;
	}
	private _exitLayer(layer: ILayer, transitionDuration: number, match?: ITransitionMatch): void {
		const machine = this._compileLayerMachine(layer);
		const previous = machine.states.find((state) => state.name === layer.activeState);
		const existingFade = this._layerTransitions.get(layer.name);
		this._layerTransitions.delete(layer.name);
		if (previous && Number.isFinite(transitionDuration) && transitionDuration > 0) {
			const { sources } = this._transitionSources(previous, existingFade, undefined, layer.weight ?? 1);
			this._layerTransitions.set(layer.name, {
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
			machine.states.forEach((state) => this._stopStateGroups(state, layer));
		}
		const lifecyclePrevious = this._layerLifecycleStates.get(layer.name);
		if (lifecyclePrevious) {
			this._queueStateBehaviour("exit", lifecyclePrevious, layer, match?.interrupted === true);
		}
		this._queueStateMachineBehaviours(machine, lifecyclePrevious, null, layer, match?.interrupted === true);
		this._layerLifecycleStates.delete(layer.name);
		layer.activeState = undefined;
		this._layerElapsedSeconds.delete(layer.name);
	}
	private _debugMachine(
		machine: ICompiledAnimatorMachine,
		activeStateName: string | undefined,
		elapsedSeconds: number,
		transition: IRuntimeFade | null,
		includeAllClips: boolean,
		layer?: ILayer
	): any {
		const activeState = layer?.synchronizedLayer
			? (this._layerLifecycleStates.get(layer.name) ?? machine.states.find((state) => state.name === activeStateName))
			: machine.states.find((state) => state.name === activeStateName);
		const durationSeconds = activeState ? this._effectiveStateDuration(activeState, layer) : null;
		const normalizedTime = activeState ? this._stateProgress(activeState, elapsedSeconds, layer) : 0;
		const playback = activeState ? resolveAnimatorStatePlayback(activeState, this._controller.parameters) : null;
		const transitionProgress = transition ? Math.min(1, transition.elapsed / transition.duration) : null;
		const transitionSourceNames = new Set(transition?.sources.map((source) => source.state.name) ?? []);
		const debugStates = layer?.synchronizedLayer && activeState ? [...machine.states.filter((state) => state.name !== activeState.name), activeState] : machine.states;
		const relevantStates = includeAllClips
			? debugStates
			: debugStates.filter((state) => state.name === activeState?.name || transitionSourceNames.has(state.name) || state.name === transition?.to?.name);
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
			transition: transition
				? {
						from: transition.sourceState ?? transition.sources[0]?.state.name ?? null,
						to: transition.to?.name ?? ANIMATOR_EXIT_STATE,
						elapsedSeconds: transition.elapsed,
						durationSeconds: transition.duration,
						authoredDuration: transition.transition?.duration ?? 0,
						durationMode: transition.transition?.durationMode ?? "seconds",
						progress: transitionProgress,
						sourceWeights: transition.sources.map((source) => ({ state: source.state.name, weight: source.weight * (1 - transitionProgress!) })),
						fromWeight: transition.sources.reduce((sum, source) => sum + source.weight * (1 - transitionProgress!), 0),
						toWeight: transition.to ? transition.toStartWeight + (transition.targetWeight - transition.toStartWeight) * transitionProgress! : 0,
						interrupted: transition.interrupted === true,
						interruptionSource: transition.transition?.interruptionSource ?? "none",
						orderedInterruption: transition.transition?.orderedInterruption === true,
						offset: transition.transition?.offset ?? 0,
						canTransitionToSelf: transition.transition?.canTransitionToSelf === true,
					}
				: null,
			clips: relevantStates.flatMap((state) =>
				this._stateMotions(state).map((motion) => {
					const animationGroup = this._stateMotionGroup(state, motion, layer);
					const animatables = (animationGroup as any)?.animatables as { masterFrame?: number; fromFrame?: number }[] | undefined;
					return animationGroup
						? {
								state: state.name,
								name: motion.animationGroup,
								motionKey: motion.key,
								timeScale: motion.timeScale,
								cycleOffset: motion.cycleOffset,
								mirrored: motion.mirror,
								found: true,
								started: animationGroup.isStarted,
								playing: animationGroup.isPlaying,
								paused: animationGroup.isStarted && !animationGroup.isPlaying,
								weight: animationGroup.weight,
								speedRatio: animationGroup.speedRatio,
								additive: animationGroup.isAdditive,
								internalLayerClone: animationGroup.metadata?.babylonEditorInternalAnimatorLayer === true,
								playbackFromFrame: animatables?.[0]?.fromFrame ?? null,
								currentFrame: animatables?.[0]?.masterFrame ?? null,
							}
						: { state: state.name, name: motion.animationGroup, motionKey: motion.key, found: false };
				})
			),
		};
	}
	private _stateMotions(state: IState): IAnimatorBlendTreeMotion[] {
		const motions = state.blendTree
			? getAnimatorBlendTreeMotions(state.blendTree)
			: state.animationGroup
				? [{ key: "state", animationGroup: state.animationGroup, timeScale: 1, cycleOffset: 0, mirror: false }]
				: [];
		return motions.map((motion) => this._stateMotion(state, motion));
	}
	private _stateMotion<T extends IAnimatorBlendTreeMotion>(state: IState, motion: T): T {
		const playback = resolveAnimatorStatePlayback(state, this._controller.parameters);
		return {
			...motion,
			cycleOffset: (((motion.cycleOffset + playback.cycleOffset) % 1) + 1) % 1,
			mirror: motion.mirror !== playback.mirror,
		} as T;
	}
	private _stateMotionGroup(state: IState, motion: IAnimatorBlendTreeMotion, layer?: ILayer): AnimationGroup | null {
		const playback = resolveAnimatorStatePlayback(state, this._controller.parameters);
		const requiresIndependentMotion =
			state.cycleOffset !== undefined ||
			state.mirror !== undefined ||
			!!playback.bindings.cycleOffset ||
			!!playback.bindings.mirror ||
			motion.timeScale !== 1 ||
			motion.cycleOffset !== 0 ||
			motion.mirror ||
			this._stateMotions(state).filter((candidate) => candidate.animationGroup === motion.animationGroup).length > 1;
		if (!requiresIndependentMotion) {
			return this._animationGroup(motion.animationGroup, layer);
		}
		return this._layerAnimationGroups.resolve(
			`${this._controller.id}:${layer?.name ?? "$base"}:${state.name}`,
			motion.animationGroup,
			layer?.blendingMode ?? "override",
			layer?.referencePose ?? { normalizedTime: 0 },
			motion
		);
	}
	private _stopStateGroups(state: IState, layer?: ILayer): void {
		this._stateMotions(state).forEach((motion) => this._stateMotionGroup(state, motion, layer)?.stop());
	}
	private _queueStateBehaviour(phase: "enter" | "exit", state: IState, layer?: ILayer, interrupted = false): void {
		const elapsedSeconds = layer ? (this._layerElapsedSeconds.get(layer.name) ?? 0) : this._elapsedSeconds;
		const duration = this._effectiveStateDuration(state, layer);
		this._pendingStateBehaviours.push({
			kind: "state",
			phase,
			state,
			layer,
			elapsedSeconds,
			normalizedTime: duration ? elapsedSeconds / duration : 0,
			interrupted,
		});
	}
	private _queueStateMachineBehaviours(
		machine: ICompiledAnimatorMachine,
		previous: IState | null | undefined,
		next: IState | null | undefined,
		layer?: ILayer,
		interrupted = false
	): void {
		for (const transition of getAnimatorStateMachineBehaviourTransitions(machine, previous, next)) {
			this._pendingStateBehaviours.push({ kind: "machine", ...transition, layer, interrupted });
		}
	}
	private _flushPendingStateBehaviours(): void {
		for (const event of this._pendingStateBehaviours.splice(0)) {
			if (event.kind === "machine") {
				invokeAnimatorStateMachineBehaviours(this._scene, this._controller, event.behaviours, event.machinePath, event.phase, {
					layerName: event.layer?.name,
					interrupted: event.interrupted,
				});
			} else {
				invokeAnimatorStateBehaviours(this._scene, this._controller, event.state, event.phase, {
					layerName: event.layer?.name,
					elapsedSeconds: event.elapsedSeconds,
					normalizedTime: event.normalizedTime,
					interrupted: event.interrupted,
				});
			}
		}
	}
	private _invokeStateBehaviourUpdate(state: IState, deltaSeconds: number, elapsedSeconds: number, normalizedTime: number, layer?: ILayer): void {
		invokeAnimatorStateBehaviours(this._scene, this._controller, state, "update", {
			layerName: layer?.name,
			elapsedSeconds,
			normalizedTime,
			deltaSeconds,
		});
	}
	private _invokeIKPasses(deltaSeconds: number): void {
		const baseState = this._compileBaseMachine().states.find((candidate) => candidate.name === this._controller.activeState);
		if (baseState) {
			applyAnimatorFootIK(this._scene, this._controller, { name: "$base", weight: 1 }, baseState);
		}
		if (this._controller.baseIKPass === true) {
			const state = baseState;
			if (state) {
				const normalizedTime = this._stateProgress(state, this._elapsedSeconds);
				invokeAnimatorIKPass(this._scene, this._controller, { name: "$base", weight: 1, ikPass: true }, state, {
					elapsedSeconds: this._elapsedSeconds,
					normalizedTime,
					deltaSeconds,
				});
			}
		}
		for (const layer of this._controller.layers ?? []) {
			const state = layer.synchronizedLayer
				? this._layerLifecycleStates.get(layer.name)
				: this._compileLayerMachine(layer).states.find((candidate) => candidate.name === layer.activeState);
			if (state) {
				applyAnimatorFootIK(this._scene, this._controller, layer, state);
			}
			if (layer.ikPass !== true) {
				continue;
			}
			if (!state) {
				continue;
			}
			const elapsedSeconds = this._layerElapsedSeconds.get(layer.name) ?? 0;
			const normalizedTime = this._stateProgress(state, elapsedSeconds, layer);
			invokeAnimatorIKPass(this._scene, this._controller, layer, state, { elapsedSeconds, normalizedTime, deltaSeconds });
		}
	}
	private _compileBaseMachine(): ICompiledAnimatorMachine {
		return compileAnimatorMachine(this._controller, this._controller.subgraphs ?? []);
	}
	private _compileLayerMachine(layer: ILayer): ICompiledAnimatorMachine {
		return compileAnimatorMachine(layer, this._controller.subgraphs ?? []);
	}
	private _resolveStateName(machine: ICompiledAnimatorMachine, stateName: string): string {
		if (machine.states.some((state) => state.name === stateName)) {
			return stateName;
		}
		const routes = machine.machineEntryTransitions[stateName];
		return routes ? this._resolveEntryState(machine, routes) : (machine.nodeEntries[stateName] ?? stateName);
	}
	private _resolveEntryState(machine: ICompiledAnimatorMachine, routes = machine.entryTransitions): string {
		return routes.find((route) => route.fallback || matches(this._controller.parameters, route.conditions ?? []))?.to ?? machine.entryState;
	}
	private _stateDurationSeconds(state: IState): number | null {
		const motion = this._stateMotions(state)[0];
		const group = motion ? this._scene.getAnimationGroupByName(motion.animationGroup) : null;
		const framesPerSecond = group?.targetedAnimations[0]?.animation.framePerSecond;
		const effectiveSpeed = resolveAnimatorStatePlayback(state, this._controller.parameters).effectiveSpeed;
		return group && framesPerSecond && group.to > group.from && effectiveSpeed !== 0
			? (group.to - group.from) / framesPerSecond / Math.abs(effectiveSpeed * (motion?.timeScale ?? 1))
			: null;
	}
	private _stateProgress(state: IState, elapsedSeconds: number, layer?: ILayer): number {
		const playback = resolveAnimatorStatePlayback(state, this._controller.parameters);
		if (playback.time !== null) {
			return (state.loop ?? true) ? ((playback.time % 1) + 1) % 1 : Math.min(1, Math.max(0, playback.time));
		}
		const duration = this._effectiveStateDuration(state, layer);
		return duration ? ((state.loop ?? true) ? (elapsedSeconds % duration) / duration : Math.min(1, elapsedSeconds / duration)) : 0;
	}
	private _mappedSynchronizedState(layer: ILayer, sourceState: IState): IState {
		const targetMachine = this._compileLayerMachine(layer);
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
	private _effectiveStateDuration(state: IState, sourceLayer?: ILayer): number | null {
		let duration = this._stateDurationSeconds(state);
		if (!duration || sourceLayer?.synchronizedLayer) {
			return duration;
		}
		const sourceName = sourceLayer?.name ?? "$base";
		for (const layer of this._controller.layers ?? []) {
			if (layer.synchronizedLayer !== sourceName || layer.synchronizedTiming !== true) {
				continue;
			}
			const targetDuration = this._stateDurationSeconds(this._mappedSynchronizedState(layer, state));
			if (targetDuration) {
				duration += (targetDuration - duration) * Math.min(1, Math.max(0, layer.weight ?? 1));
			}
		}
		return duration;
	}
	private _stateMotionPhase(state: IState, motion: IAnimatorBlendTreeMotion, normalizedTime: number): number {
		const playback = resolveAnimatorStatePlayback(state, this._controller.parameters);
		const raw = normalizedTime * (playback.timeDriven ? 1 : Math.sign(playback.effectiveSpeed || 1)) * motion.timeScale + motion.cycleOffset;
		return (state.loop ?? true) ? ((raw % 1) + 1) % 1 : Math.min(1, Math.max(0, raw));
	}
	private _seekStateGroups(state: IState, normalizedTime: number, layer?: ILayer): void {
		for (const motion of this._stateMotions(state)) {
			const group = this._stateMotionGroup(state, motion, layer);
			if (group?.isStarted) {
				const phase = this._stateMotionPhase(state, motion, normalizedTime);
				group.goToFrame(group.from + (group.to - group.from) * phase);
			}
		}
	}
	private _synchronizeLayers(): void {
		for (const layer of this._controller.layers ?? []) {
			if (layer.synchronizedLayer) {
				this._synchronizeLayer(layer);
			}
		}
	}
	private _synchronizeLayer(layer: ILayer): void {
		const sourceLayer = layer.synchronizedLayer === "$base" ? undefined : this._controller.layers?.find((candidate) => candidate.name === layer.synchronizedLayer);
		if (layer.synchronizedLayer !== "$base" && !sourceLayer) {
			throw new Error(`Animator synchronized layer "${layer.name}" references missing source layer "${String(layer.synchronizedLayer)}".`);
		}
		const sourceMachine = sourceLayer ? this._compileLayerMachine(sourceLayer) : this._compileBaseMachine();
		const sourceStateName = sourceLayer ? sourceLayer.activeState : this._controller.activeState;
		const sourceState = sourceMachine.states.find((candidate) => candidate.name === sourceStateName);
		if (!sourceState) {
			this._exitLayer(layer, 0);
			return;
		}
		const targetState = this._mappedSynchronizedState(layer, sourceState);
		const sourceElapsed = sourceLayer ? (this._layerElapsedSeconds.get(sourceLayer.name) ?? 0) : this._elapsedSeconds;
		const normalizedTime = this._stateProgress(sourceState, sourceElapsed, sourceLayer);
		const lifecycleState = this._layerLifecycleStates.get(layer.name);
		if (layer.activeState !== targetState.name || lifecycleState?.synchronizedSourceState !== sourceState.name) {
			this._playLayerState(layer, targetState.name, 0, normalizedTime, undefined, targetState);
		}
		const targetDuration = this._stateDurationSeconds(targetState);
		this._layerElapsedSeconds.set(layer.name, targetDuration ? targetDuration * normalizedTime : 0);
		this._applyWriteDefaults(targetState, layer);
		for (const motion of this._stateMotions(targetState)) {
			const group = this._stateMotionGroup(targetState, motion, layer);
			if (!group) {
				continue;
			}
			if (!group.isStarted) {
				this._startStateGroups(targetState, layer.maskTargetNames ?? [], layer.avatarMaskId, normalizedTime, layer);
				break;
			}
			const phase = this._stateMotionPhase(targetState, motion, normalizedTime);
			group.goToFrame(group.from + (group.to - group.from) * phase);
		}
		this._applyStateWeight(targetState, layer.weight ?? 1, layer);
	}
	private _animationGroup(name: string, layer?: ILayer): AnimationGroup | null {
		return layer
			? this._layerAnimationGroups.resolve(`${this._controller.id}:${layer.name}`, name, layer.blendingMode ?? "override", layer.referencePose ?? { normalizedTime: 0 })
			: this._scene.getAnimationGroupByName(name);
	}
	private _applyWriteDefaults(state: IState, layer?: ILayer): void {
		const groups = this._stateMotions(state)
			.map((motion) => this._stateMotionGroup(state, motion, layer))
			.filter((group): group is AnimationGroup => !!group);
		applyAnimatorWriteDefaults(this._scene, this._controller, layer?.name ?? "$base", state, groups);
	}
	private _startStateGroups(state: IState, fallbackTargetNames: string[], fallbackAvatarMaskId: string | undefined, offset: number, layer?: ILayer): void {
		const playback = resolveAnimatorStatePlayback(state, this._controller.parameters);
		const normalizedOffset = playback.time === null ? offset : (state.loop ?? true) ? ((playback.time % 1) + 1) % 1 : Math.min(1, Math.max(0, playback.time));
		const motions = this._stateMotions(state)
			.map((motion) => ({ motion, animationGroup: this._stateMotionGroup(state, motion, layer) }))
			.filter((entry): entry is { motion: IAnimatorBlendTreeMotion; animationGroup: AnimationGroup } => !!entry.animationGroup);
		for (const { animationGroup } of motions) {
			applyMask(this._scene, animationGroup, state, fallbackTargetNames, fallbackAvatarMaskId);
		}
		this._applyWriteDefaults(state, layer);
		for (const { motion, animationGroup } of motions) {
			const phase = this._stateMotionPhase(state, motion, normalizedOffset);
			const from = animationGroup.from + (animationGroup.to - animationGroup.from) * phase;
			animationGroup.start(state.loop ?? true, playback.effectiveSpeed * motion.timeScale, from, animationGroup.to, layer?.blendingMode === "additive");
			animationGroup.goToFrame(from);
		}
	}
	private _transitionSources(
		previous: IState,
		existingFade: IRuntimeFade | undefined | null,
		targetState: IState | undefined,
		fallbackWeight: number
	): { sources: { state: IState; weight: number }[]; targetStartWeight: number } {
		const weights = existingFade ? fadeWeights(existingFade) : new Map([[previous.name, { state: previous, weight: fallbackWeight }]]);
		const targetStartWeight = targetState ? (weights.get(targetState.name)?.weight ?? 0) : 0;
		if (targetState) {
			weights.delete(targetState.name);
		}
		return { sources: [...weights.values()], targetStartWeight };
	}
	private _applyStateWeight(state: IState, weight: number, layer?: ILayer): void {
		if (state.blendTree) {
			this._applyBlendTree(state, weight, layer);
		} else {
			this._stateMotions(state).forEach((motion) => {
				const group = this._stateMotionGroup(state, motion, layer);
				if (group) {
					group.weight = weight;
				}
			});
		}
	}
	private _advanceTransitions(deltaSeconds: number): void {
		if (this._transition) {
			const transition = this._transition;
			transition.elapsed += deltaSeconds;
			const amount = Math.min(1, transition.elapsed / transition.duration);
			for (const source of transition.sources) {
				this._applyStateWeight(source.state, source.weight * (1 - amount));
			}
			if (transition.to) {
				this._applyStateWeight(transition.to, transition.toStartWeight + (transition.targetWeight - transition.toStartWeight) * amount);
			}
			if (amount === 1) {
				if (transition.to) {
					transition.sources.forEach((source) => this._stopStateGroupsExcept(source.state, transition.to!));
				} else {
					transition.sources.forEach((source) => this._stopStateGroups(source.state));
				}
				this._transition = null;
			}
		}
		for (const [layerName, transition] of this._layerTransitions) {
			const layer = this._controller.layers?.find((candidate) => candidate.name === layerName);
			if (!layer) {
				continue;
			}
			transition.elapsed += deltaSeconds;
			const amount = Math.min(1, transition.elapsed / transition.duration);
			for (const source of transition.sources) {
				this._applyStateWeight(source.state, source.weight * (1 - amount), layer);
			}
			if (transition.to) {
				this._applyStateWeight(transition.to, transition.toStartWeight + (transition.targetWeight - transition.toStartWeight) * amount, layer);
			}
			if (amount === 1) {
				if (transition.to) {
					transition.sources.forEach((source) => this._stopStateGroupsExcept(source.state, transition.to!, layer));
				} else {
					transition.sources.forEach((source) => this._stopStateGroups(source.state, layer));
				}
				this._layerTransitions.delete(layerName);
			}
		}
	}
	private _stopStateGroupsExcept(from: IState, keep: IState, layer?: ILayer): void {
		const keepGroups = new Set(this._stateMotions(keep).map((motion) => this._stateMotionGroup(keep, motion, layer)));
		this._stateMotions(from)
			.map((motion) => this._stateMotionGroup(from, motion, layer))
			.filter((group) => group && !keepGroups.has(group))
			.forEach((group) => group?.stop());
	}
	private _applyBlendTree(state: IState, weight = 1, layer?: ILayer): void {
		const tree = state.blendTree;
		if (!tree) {
			return;
		}
		for (const evaluatedMotion of evaluateAnimatorBlendTreeMotions(tree, this._controller.parameters)) {
			const motion = this._stateMotion(state, evaluatedMotion);
			const group = this._stateMotionGroup(state, motion, layer);
			if (group) {
				group.weight = motion.weight * weight;
			}
		}
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		animators?: Map<string, AnimatorControllerRuntime>;
	}
}

export function configureAnimators(scene: Scene): void {
	const controllers = scene.metadata?.babylonEditorAnimatorControllers as IController[] | undefined;
	if (!controllers) {
		return;
	}
	scene.animators = new Map();
	for (const controller of controllers) {
		const runtime = new AnimatorControllerRuntime(scene, controller);
		scene.animators.set(controller.id, runtime);
		runtime.playEntry();
		for (const layer of controller.layers ?? []) {
			runtime.playEntry(layer.name);
		}
		scene.onBeforeRenderObservable.add(
			() => {
				runtime.update(scene.getEngine().getDeltaTime() / 1000);
				if (controller.rootMotion?.enabled) {
					runtime.applyRootMotion();
				}
			},
			-1,
			true
		);
	}
}

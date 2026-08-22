import { Scene } from "@babylonjs/core/scene";

import { AnimatorStateLifecyclePhase, AnimatorStateMachineLifecyclePhase, IAnimatorStateInfo, IAnimatorStateMachineInfo, IScript } from "../script";
import { IAnimatorGraphState, IAnimatorStateBehaviour, ICompiledAnimatorMachine, ICompiledAnimatorState } from "./animator-graph";
import { scriptsDictionary } from "./script/apply";

export interface IAnimatorStateBehaviourController {
	id: string;
	name: string;
	targetNodeId?: string;
}

export interface IAnimatorStateBehaviourInvocationOptions {
	layerName?: string;
	elapsedSeconds?: number;
	normalizedTime?: number;
	deltaSeconds?: number;
	interrupted?: boolean;
}

export interface IAnimatorStateBehaviourEvent {
	timestamp: number;
	behaviourId: string;
	scriptKey: string;
	phase: AnimatorStateLifecyclePhase | AnimatorStateMachineLifecyclePhase;
	layerName: string | null;
	stateName: string | null;
	machinePath: string[];
	status: "called" | "missing-target" | "missing-script" | "missing-callback" | "error";
	message?: string;
}

export interface IAnimatorStateBehaviourDiagnostics {
	controllerId: string;
	targetNodeId: string | null;
	enterCalls: number;
	updateCalls: number;
	exitCalls: number;
	machineEnterCalls: number;
	machineExitCalls: number;
	missingTargets: number;
	missingScripts: number;
	missingCallbacks: number;
	errorCount: number;
	lastError: { behaviourId: string; scriptKey: string; phase: AnimatorStateLifecyclePhase | AnimatorStateMachineLifecyclePhase; message: string; timestamp: number } | null;
	recentEvents: IAnimatorStateBehaviourEvent[];
}

const diagnosticsByScene = new WeakMap<Scene, Map<string, IAnimatorStateBehaviourDiagnostics>>();
const MAX_RECENT_EVENTS = 64;

export interface IAnimatorStateMachineBehaviourTransition {
	phase: AnimatorStateMachineLifecyclePhase;
	machinePath: string[];
	behaviours: IAnimatorStateBehaviour[];
}

/** Computes deepest-first exits and root-first entries for one compiled state change. */
export function getAnimatorStateMachineBehaviourTransitions(
	machine: ICompiledAnimatorMachine,
	previous: IAnimatorGraphState | null | undefined,
	next: IAnimatorGraphState | null | undefined
): IAnimatorStateMachineBehaviourTransition[] {
	const previousPath = previous ? ((previous as ICompiledAnimatorState).machinePath ?? []) : null;
	const nextPath = next ? ((next as ICompiledAnimatorState).machinePath ?? []) : null;
	let commonLength = 0;
	if (previousPath && nextPath) {
		while (commonLength < previousPath.length && commonLength < nextPath.length && previousPath[commonLength] === nextPath[commonLength]) {
			commonLength++;
		}
	}
	const transitions: IAnimatorStateMachineBehaviourTransition[] = [];
	if (previousPath) {
		const stop = nextPath ? commonLength + 1 : 0;
		for (let length = previousPath.length; length >= stop; length--) {
			const machinePath = previousPath.slice(0, length);
			const behaviours = machine.machineBehaviours[machinePath.join("/")] ?? [];
			if (behaviours.length) {
				transitions.push({ phase: "machineExit", machinePath, behaviours });
			}
		}
	}
	if (nextPath) {
		const start = previousPath ? commonLength + 1 : 0;
		for (let length = start; length <= nextPath.length; length++) {
			const machinePath = nextPath.slice(0, length);
			const behaviours = machine.machineBehaviours[machinePath.join("/")] ?? [];
			if (behaviours.length) {
				transitions.push({ phase: "machineEnter", machinePath, behaviours });
			}
		}
	}
	return transitions;
}

function getDiagnostics(scene: Scene, controller: IAnimatorStateBehaviourController): IAnimatorStateBehaviourDiagnostics {
	let sceneDiagnostics = diagnosticsByScene.get(scene);
	if (!sceneDiagnostics) {
		sceneDiagnostics = new Map();
		diagnosticsByScene.set(scene, sceneDiagnostics);
	}
	let diagnostics = sceneDiagnostics.get(controller.id);
	if (!diagnostics) {
		diagnostics = {
			controllerId: controller.id,
			targetNodeId: controller.targetNodeId ?? null,
			enterCalls: 0,
			updateCalls: 0,
			exitCalls: 0,
			machineEnterCalls: 0,
			machineExitCalls: 0,
			missingTargets: 0,
			missingScripts: 0,
			missingCallbacks: 0,
			errorCount: 0,
			lastError: null,
			recentEvents: [],
		};
		sceneDiagnostics.set(controller.id, diagnostics);
	}
	diagnostics.targetNodeId = controller.targetNodeId ?? null;
	return diagnostics;
}

function pushEvent(diagnostics: IAnimatorStateBehaviourDiagnostics, event: IAnimatorStateBehaviourEvent): void {
	diagnostics.recentEvents.push(event);
	if (diagnostics.recentEvents.length > MAX_RECENT_EVENTS) {
		diagnostics.recentEvents.splice(0, diagnostics.recentEvents.length - MAX_RECENT_EVENTS);
	}
}

function callbackForPhase(script: IScript, phase: AnimatorStateLifecyclePhase): ((object: unknown, state: IAnimatorStateInfo) => void) | undefined {
	if (phase === "enter") {
		return script.onAnimatorStateEnter?.bind(script);
	}
	if (phase === "update") {
		return script.onAnimatorStateUpdate?.bind(script);
	}
	return script.onAnimatorStateExit?.bind(script);
}

function stateInfo(
	controller: IAnimatorStateBehaviourController,
	state: IAnimatorGraphState,
	phase: AnimatorStateLifecyclePhase,
	options: IAnimatorStateBehaviourInvocationOptions
): IAnimatorStateInfo {
	const compiled = state as ICompiledAnimatorState;
	return {
		controllerId: controller.id,
		controllerName: controller.name,
		layerName: options.layerName ?? null,
		stateName: state.name,
		sourceStateName: compiled.sourceStateName ?? state.name,
		machinePath: compiled.machinePath ?? [],
		subgraphId: compiled.subgraphId ?? null,
		phase,
		elapsedSeconds: options.elapsedSeconds ?? 0,
		normalizedTime: options.normalizedTime ?? 0,
		deltaSeconds: options.deltaSeconds ?? 0,
		interrupted: options.interrupted === true,
	};
}

/** Invokes every enabled state behaviour against matching scripts on the Animator target node without interrupting animation playback on script errors. */
export function invokeAnimatorStateBehaviours(
	scene: Scene,
	controller: IAnimatorStateBehaviourController,
	state: IAnimatorGraphState,
	phase: AnimatorStateLifecyclePhase,
	options: IAnimatorStateBehaviourInvocationOptions = {}
): IAnimatorStateBehaviourDiagnostics {
	const diagnostics = getDiagnostics(scene, controller);
	const behaviours = state.behaviours?.filter((behaviour) => behaviour.enabled !== false) ?? [];
	if (!behaviours.length) {
		return structuredClone(diagnostics);
	}
	const timestamp = Date.now();
	const target = controller.targetNodeId ? scene.getNodeById(controller.targetNodeId) : null;
	const info = stateInfo(controller, state, phase, options);
	for (const behaviour of behaviours) {
		if (!target) {
			diagnostics.missingTargets++;
			pushEvent(diagnostics, {
				timestamp,
				behaviourId: behaviour.id,
				scriptKey: behaviour.scriptKey,
				phase,
				layerName: info.layerName,
				stateName: state.name,
				machinePath: info.machinePath,
				status: "missing-target",
			});
			continue;
		}
		const scripts = (scriptsDictionary.get(target) ?? []).filter((script) => script.key === behaviour.scriptKey);
		if (!scripts.length) {
			diagnostics.missingScripts++;
			pushEvent(diagnostics, {
				timestamp,
				behaviourId: behaviour.id,
				scriptKey: behaviour.scriptKey,
				phase,
				layerName: info.layerName,
				stateName: state.name,
				machinePath: info.machinePath,
				status: "missing-script",
			});
			continue;
		}
		for (const script of scripts) {
			const callback = callbackForPhase(script.instance, phase);
			if (!callback) {
				diagnostics.missingCallbacks++;
				pushEvent(diagnostics, {
					timestamp,
					behaviourId: behaviour.id,
					scriptKey: behaviour.scriptKey,
					phase,
					layerName: info.layerName,
					stateName: state.name,
					machinePath: info.machinePath,
					status: "missing-callback",
				});
				continue;
			}
			try {
				callback(target, info);
				diagnostics[`${phase}Calls`]++;
				pushEvent(diagnostics, {
					timestamp,
					behaviourId: behaviour.id,
					scriptKey: behaviour.scriptKey,
					phase,
					layerName: info.layerName,
					stateName: state.name,
					machinePath: info.machinePath,
					status: "called",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.errorCount++;
				diagnostics.lastError = { behaviourId: behaviour.id, scriptKey: behaviour.scriptKey, phase, message, timestamp };
				pushEvent(diagnostics, {
					timestamp,
					behaviourId: behaviour.id,
					scriptKey: behaviour.scriptKey,
					phase,
					layerName: info.layerName,
					stateName: state.name,
					machinePath: info.machinePath,
					status: "error",
					message,
				});
				console.error(`Animator state behaviour "${behaviour.scriptKey}" failed during ${phase}.`, error);
			}
		}
	}
	return structuredClone(diagnostics);
}

/** Invokes enabled behaviours when evaluation crosses one root or nested state-machine boundary. */
export function invokeAnimatorStateMachineBehaviours(
	scene: Scene,
	controller: IAnimatorStateBehaviourController,
	behaviours: IAnimatorStateBehaviour[] | undefined,
	machinePath: string[],
	phase: AnimatorStateMachineLifecyclePhase,
	options: Pick<IAnimatorStateBehaviourInvocationOptions, "layerName" | "interrupted"> = {}
): IAnimatorStateBehaviourDiagnostics {
	const diagnostics = getDiagnostics(scene, controller);
	const enabledBehaviours = behaviours?.filter((behaviour) => behaviour.enabled !== false) ?? [];
	if (!enabledBehaviours.length) {
		return structuredClone(diagnostics);
	}
	const timestamp = Date.now();
	const target = controller.targetNodeId ? scene.getNodeById(controller.targetNodeId) : null;
	const info: IAnimatorStateMachineInfo = {
		controllerId: controller.id,
		controllerName: controller.name,
		layerName: options.layerName ?? null,
		machinePath: [...machinePath],
		phase,
		interrupted: options.interrupted === true,
	};
	for (const behaviour of enabledBehaviours) {
		if (!target) {
			diagnostics.missingTargets++;
			pushEvent(diagnostics, {
				timestamp,
				behaviourId: behaviour.id,
				scriptKey: behaviour.scriptKey,
				phase,
				layerName: info.layerName,
				stateName: null,
				machinePath: info.machinePath,
				status: "missing-target",
			});
			continue;
		}
		const scripts = (scriptsDictionary.get(target) ?? []).filter((script) => script.key === behaviour.scriptKey);
		if (!scripts.length) {
			diagnostics.missingScripts++;
			pushEvent(diagnostics, {
				timestamp,
				behaviourId: behaviour.id,
				scriptKey: behaviour.scriptKey,
				phase,
				layerName: info.layerName,
				stateName: null,
				machinePath: info.machinePath,
				status: "missing-script",
			});
			continue;
		}
		for (const script of scripts) {
			const callback =
				phase === "machineEnter" ? script.instance.onAnimatorStateMachineEnter?.bind(script.instance) : script.instance.onAnimatorStateMachineExit?.bind(script.instance);
			if (!callback) {
				diagnostics.missingCallbacks++;
				pushEvent(diagnostics, {
					timestamp,
					behaviourId: behaviour.id,
					scriptKey: behaviour.scriptKey,
					phase,
					layerName: info.layerName,
					stateName: null,
					machinePath: info.machinePath,
					status: "missing-callback",
				});
				continue;
			}
			try {
				callback(target, info);
				diagnostics[`${phase}Calls`]++;
				pushEvent(diagnostics, {
					timestamp,
					behaviourId: behaviour.id,
					scriptKey: behaviour.scriptKey,
					phase,
					layerName: info.layerName,
					stateName: null,
					machinePath: info.machinePath,
					status: "called",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.errorCount++;
				diagnostics.lastError = { behaviourId: behaviour.id, scriptKey: behaviour.scriptKey, phase, message, timestamp };
				pushEvent(diagnostics, {
					timestamp,
					behaviourId: behaviour.id,
					scriptKey: behaviour.scriptKey,
					phase,
					layerName: info.layerName,
					stateName: null,
					machinePath: info.machinePath,
					status: "error",
					message,
				});
				console.error(`Animator state-machine behaviour "${behaviour.scriptKey}" failed during ${phase}.`, error);
			}
		}
	}
	return structuredClone(diagnostics);
}

/** Returns bounded non-mutating state-behaviour telemetry for an Animator debugger. */
export function getAnimatorStateBehaviourDiagnostics(scene: Scene, controller: IAnimatorStateBehaviourController): IAnimatorStateBehaviourDiagnostics {
	return structuredClone(getDiagnostics(scene, controller));
}

/** Validates one complete state-behaviour list before persistence. */
export function validateAnimatorStateBehaviours(behaviours: IAnimatorStateBehaviour[] | undefined): void {
	if ((behaviours?.length ?? 0) > 16) {
		throw new Error("Animator states cannot contain more than 16 state behaviours.");
	}
	const ids = new Set<string>();
	for (const behaviour of behaviours ?? []) {
		if (!behaviour.id || !behaviour.scriptKey) {
			throw new Error("Animator state behaviours require non-empty id and scriptKey values.");
		}
		if (ids.has(behaviour.id)) {
			throw new Error("Animator state behaviour ids must be unique within a state.");
		}
		if (behaviour.unitySource) {
			const source = behaviour.unitySource;
			if (
				!source.bindingKey.startsWith("@unity-behaviour:") ||
				!source.behaviourFileId ||
				(source.scriptContentHash !== null && !/^[a-f0-9]{64}$/.test(source.scriptContentHash)) ||
				(source.scriptMetaHash !== null && !/^[a-f0-9]{64}$/.test(source.scriptMetaHash)) ||
				source.serializedFieldsJson.length > 65_536
			) {
				throw new Error("Animator Unity behaviour source evidence is malformed or exceeds its bounded serialized-field limit.");
			}
			try {
				const fields = JSON.parse(source.serializedFieldsJson);
				if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
					throw new Error("not an object");
				}
			} catch {
				throw new Error("Animator Unity behaviour serializedFieldsJson must contain one JSON object.");
			}
		}
		ids.add(behaviour.id);
	}
}

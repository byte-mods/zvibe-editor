import { Scene } from "@babylonjs/core/scene";

import { IAnimatorIKInfo } from "../script";
import { IAnimatorGraphState, ICompiledAnimatorState } from "./animator-graph";
import { scriptsDictionary } from "./script/apply";

export interface IAnimatorIKPassController {
	id: string;
	name: string;
	targetNodeId?: string;
}

export interface IAnimatorIKPassLayer {
	name: string;
	weight?: number;
	ikPass?: boolean;
}

export interface IAnimatorIKPassInvocationOptions {
	elapsedSeconds?: number;
	normalizedTime?: number;
	deltaSeconds?: number;
}

export interface IAnimatorIKPassEvent {
	timestamp: number;
	layerName: string;
	stateName: string;
	scriptKey: string | null;
	status: "called" | "missing-target" | "missing-script" | "missing-callback" | "error";
	message?: string;
}

export interface IAnimatorIKPassLayerDiagnostics {
	layerName: string;
	enabled: boolean;
	invocations: number;
	callbackCalls: number;
	missingTargets: number;
	missingScripts: number;
	missingCallbacks: number;
	errorCount: number;
	lastError: { scriptKey: string; message: string; timestamp: number } | null;
	recentEvents: IAnimatorIKPassEvent[];
}

export interface IAnimatorIKPassDiagnostics {
	controllerId: string;
	targetNodeId: string | null;
	layers: IAnimatorIKPassLayerDiagnostics[];
}

const diagnosticsByScene = new WeakMap<Scene, Map<string, Map<string, IAnimatorIKPassLayerDiagnostics>>>();
const MAX_RECENT_EVENTS = 64;

function getLayerDiagnostics(scene: Scene, controller: IAnimatorIKPassController, layer: IAnimatorIKPassLayer): IAnimatorIKPassLayerDiagnostics {
	let sceneDiagnostics = diagnosticsByScene.get(scene);
	if (!sceneDiagnostics) {
		sceneDiagnostics = new Map();
		diagnosticsByScene.set(scene, sceneDiagnostics);
	}
	let controllerDiagnostics = sceneDiagnostics.get(controller.id);
	if (!controllerDiagnostics) {
		controllerDiagnostics = new Map();
		sceneDiagnostics.set(controller.id, controllerDiagnostics);
	}
	let diagnostics = controllerDiagnostics.get(layer.name);
	if (!diagnostics) {
		diagnostics = {
			layerName: layer.name,
			enabled: layer.ikPass === true,
			invocations: 0,
			callbackCalls: 0,
			missingTargets: 0,
			missingScripts: 0,
			missingCallbacks: 0,
			errorCount: 0,
			lastError: null,
			recentEvents: [],
		};
		controllerDiagnostics.set(layer.name, diagnostics);
	}
	diagnostics.enabled = layer.ikPass === true;
	return diagnostics;
}

function pushEvent(diagnostics: IAnimatorIKPassLayerDiagnostics, event: IAnimatorIKPassEvent): void {
	diagnostics.recentEvents.push(event);
	if (diagnostics.recentEvents.length > MAX_RECENT_EVENTS) {
		diagnostics.recentEvents.splice(0, diagnostics.recentEvents.length - MAX_RECENT_EVENTS);
	}
}

function ikInfo(controller: IAnimatorIKPassController, layer: IAnimatorIKPassLayer, state: IAnimatorGraphState, options: IAnimatorIKPassInvocationOptions): IAnimatorIKInfo {
	const compiled = state as ICompiledAnimatorState;
	return {
		controllerId: controller.id,
		controllerName: controller.name,
		layerName: layer.name,
		layerWeight: layer.weight ?? 1,
		stateName: state.name,
		sourceStateName: compiled.sourceStateName ?? state.name,
		machinePath: compiled.machinePath ?? [],
		subgraphId: compiled.subgraphId ?? null,
		elapsedSeconds: options.elapsedSeconds ?? 0,
		normalizedTime: options.normalizedTime ?? 0,
		deltaSeconds: options.deltaSeconds ?? 0,
	};
}

/** Invokes Unity-style per-layer Animator IK callbacks after animation sampling without interrupting playback on script errors. */
export function invokeAnimatorIKPass(
	scene: Scene,
	controller: IAnimatorIKPassController,
	layer: IAnimatorIKPassLayer,
	state: IAnimatorGraphState,
	options: IAnimatorIKPassInvocationOptions = {}
): IAnimatorIKPassLayerDiagnostics {
	const diagnostics = getLayerDiagnostics(scene, controller, layer);
	if (layer.ikPass !== true) {
		return structuredClone(diagnostics);
	}
	diagnostics.invocations++;
	const timestamp = Date.now();
	const target = controller.targetNodeId ? scene.getNodeById(controller.targetNodeId) : null;
	if (!target) {
		diagnostics.missingTargets++;
		pushEvent(diagnostics, { timestamp, layerName: layer.name, stateName: state.name, scriptKey: null, status: "missing-target" });
		return structuredClone(diagnostics);
	}
	const scripts = scriptsDictionary.get(target) ?? [];
	if (!scripts.length) {
		diagnostics.missingScripts++;
		pushEvent(diagnostics, { timestamp, layerName: layer.name, stateName: state.name, scriptKey: null, status: "missing-script" });
		return structuredClone(diagnostics);
	}
	const info = ikInfo(controller, layer, state, options);
	for (const script of scripts) {
		const callback = script.instance.onAnimatorIK?.bind(script.instance);
		if (!callback) {
			diagnostics.missingCallbacks++;
			pushEvent(diagnostics, { timestamp, layerName: layer.name, stateName: state.name, scriptKey: script.key, status: "missing-callback" });
			continue;
		}
		try {
			callback(target, info);
			diagnostics.callbackCalls++;
			pushEvent(diagnostics, { timestamp, layerName: layer.name, stateName: state.name, scriptKey: script.key, status: "called" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.errorCount++;
			diagnostics.lastError = { scriptKey: script.key, message, timestamp };
			pushEvent(diagnostics, { timestamp, layerName: layer.name, stateName: state.name, scriptKey: script.key, status: "error", message });
			console.error(`Animator IK callback "${script.key}" failed for layer "${layer.name}".`, error);
		}
	}
	return structuredClone(diagnostics);
}

/** Returns bounded non-mutating IK Pass telemetry for an Animator debugger. */
export function getAnimatorIKPassDiagnostics(scene: Scene, controller: IAnimatorIKPassController, layers: IAnimatorIKPassLayer[] = []): IAnimatorIKPassDiagnostics {
	const known = diagnosticsByScene.get(scene)?.get(controller.id);
	const layerNames = new Set([...layers.map((layer) => layer.name), ...(known?.keys() ?? [])]);
	return {
		controllerId: controller.id,
		targetNodeId: controller.targetNodeId ?? null,
		layers: [...layerNames]
			.sort((first, second) => first.localeCompare(second))
			.map((name) => {
				const layer = layers.find((candidate) => candidate.name === name) ?? { name, ikPass: false };
				return structuredClone(getLayerDiagnostics(scene, controller, layer));
			}),
	};
}

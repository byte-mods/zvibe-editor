import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";
import { PointerInfo } from "@babylonjs/core/Events/pointerEvents";
import { KeyboardInfo } from "@babylonjs/core/Events/keyboardEvents";
import { IParticleSystem } from "@babylonjs/core/Particles/IParticleSystem";

import { IScript } from "../../script";

import { applyDecorators } from "../../decorators/apply";

import { beginPortableProfilerMarker } from "../../profiling/profiling";

import { isAnyParticleSystem, isNode, isScene, isSoundNode } from "../../tools/guards";

import { ScriptMap } from "../loader";
import { beginScriptSourceInvocation, getScriptSourceDebuggerHitSequence } from "./source-debugger";

/**
 * @internal
 */
export function _applyScriptsForObject(scene: Scene, object: any, scriptsMap: ScriptMap, rootUrl: string): void {
	_applyScriptsForObjects(scene, [object], scriptsMap, rootUrl);
}

/** Applies all serialized script attachments globally in deterministic execution-order order. */
export function _applyScriptsForObjects(scene: Scene, objects: any[], scriptsMap: ScriptMap, rootUrl: string): void {
	const projectOrders = scene.metadata?.babylonEditorProjectScriptExecutionOrders ?? {};
	const sceneOrders = scene.metadata?.babylonEditorScriptExecutionOrders ?? {};
	let sequence = 0;
	const entries = objects.flatMap((object) =>
		(object.metadata?.scripts ?? []).map((script: any, attachmentIndex: number) => ({
			object,
			script,
			attachmentIndex,
			sequence: sequence++,
			order: sceneOrders[script.key] ?? projectOrders[script.key] ?? script.executionOrder ?? 0,
		}))
	);
	entries.sort((left, right) => left.order - right.order || left.sequence - right.sequence);

	entries.forEach(({ object, script }) => {
		if (!script.enabled) {
			return;
		}

		const exports = scriptsMap[script.key];
		if (!exports) {
			return;
		}

		let result = exports;

		const observers: IRegisteredScriptObservers = {};
		const diagnostics = createScriptRuntimeDiagnostics();

		if (exports.default) {
			result = new exports.default(object);

			const decoratorsResult = applyDecorators(scene, object, script, result, rootUrl);
			Object.assign(observers, decoratorsResult?.observers ?? {});
		}

		const registeredScript = _registerScriptInstance(object, result, script.key, observers, diagnostics, scene);
		installAutomaticLifecycleObservers(scene, object, registeredScript);
	});

	objects.forEach((object) => {
		if (object.metadata?.scripts) {
			object.metadata.scripts = undefined;
		}
	});
}

/**
 * Applies the given script constructor on the given object on the fly.
 * @param object defines the reference to the object on which the script must be applied.
 * @param scriptConstructor defines the constructor of the script to apply on the object.
 * @param scene defines the reference to the scene. If not provided, will try to get it from object.getScene()
 * @example
 * import { applyScriptOnObject } from "babylonjs-editor-tools";
 * ...
 * const instance = applyScriptOnObject(mesh, MyScriptClass);
 */
export function applyScriptOnObject(object: any, scriptConstructor: new (...args: any) => any, scene?: Scene) {
	scene ??= object.getScene?.();
	if (!scene) {
		throw new Error("Cannot apply script on object: no scene available.");
	}

	const instance = new scriptConstructor(object);
	const observers: IRegisteredScriptObservers = {};
	const diagnostics = createScriptRuntimeDiagnostics();

	const script = {
		values: {},
	};

	applyDecorators(scene, object, script, instance, "");

	const registeredScript = _registerScriptInstance(object, instance, "runtime", observers, diagnostics, scene);
	installAutomaticLifecycleObservers(scene, object, registeredScript);

	return instance;
}

export interface IRegisteredScript {
	/**
	 * Defines the key of the script. Refer to scriptMap.
	 */
	key: string;
	/**
	 * Defines the instance of the script that was created while loading the scene.
	 */
	instance: IScript;
	/**
	 * Defines the dictionary of all registered observers for this script.
	 */
	observers: IRegisteredScriptObservers;
	/** Runtime lifecycle/error telemetry for diagnostics and tooling. */
	diagnostics: IScriptRuntimeDiagnostics;
}

export interface IScriptRuntimeDiagnostics {
	onStartCalls: number;
	onUpdateCalls: number;
	onStopCalls: number;
	manualOnStartCalls: number;
	manualOnUpdateCalls: number;
	lastManualDeltaSeconds: number | null;
	errorCount: number;
	lastError: { lifecycle: "onStart" | "onUpdate" | "onStop"; message: string; timestamp: number } | null;
}

export interface IRegisteredScriptObservers {
	onStartObserver?: Observer<Scene> | null;
	onUpdateObserver?: Observer<Scene> | null;
	pointerObserver?: Observer<PointerInfo> | null;
	keyboardObserver?: Observer<KeyboardInfo> | null;
}

export const scriptsDictionary = new Map<Node | IParticleSystem | Scene, IRegisteredScript[]>();

export interface IScriptSimulationError {
	key: string;
	objectId: string | null;
	objectName: string;
	lifecycle: "onStart" | "onUpdate";
	message: string;
	timestamp: number;
}

export interface IScriptSimulationControl {
	paused: boolean;
	executingManualStep: boolean;
	registeredScripts: number;
	startedScripts: number;
	totalManualSteps: number;
	totalManualSeconds: number;
	totalManualStartCalls: number;
	totalManualUpdateCalls: number;
	lastStepSeconds: number | null;
	lastError: IScriptSimulationError | null;
}

export interface IScriptSimulationStepResult {
	deltaSeconds: number;
	registeredScripts: number;
	startedScripts: number;
	startCalls: number;
	updateCalls: number;
	updatedScriptKeys: string[];
	breakpointHit: boolean;
}

interface IRegisteredScriptRuntime {
	scene: Scene;
	object: any;
	registeredScript: IRegisteredScript;
	started: boolean;
}

interface ISceneScriptSimulationRuntime {
	paused: boolean;
	executingManualStep: boolean;
	registrations: IRegisteredScriptRuntime[];
	totalManualSteps: number;
	totalManualSeconds: number;
	totalManualStartCalls: number;
	totalManualUpdateCalls: number;
	lastStepSeconds: number | null;
	lastError: IScriptSimulationError | null;
}

const registeredScriptRuntimes = new WeakMap<IRegisteredScript, IRegisteredScriptRuntime>();
const sceneScriptSimulationRuntimes = new WeakMap<Scene, ISceneScriptSimulationRuntime>();

function getSceneScriptSimulationRuntime(scene: Scene): ISceneScriptSimulationRuntime {
	let runtime = sceneScriptSimulationRuntimes.get(scene);
	if (!runtime) {
		runtime = {
			paused: false,
			executingManualStep: false,
			registrations: [],
			totalManualSteps: 0,
			totalManualSeconds: 0,
			totalManualStartCalls: 0,
			totalManualUpdateCalls: 0,
			lastStepSeconds: null,
			lastError: null,
		};
		sceneScriptSimulationRuntimes.set(scene, runtime);
	}
	return runtime;
}

function describeScriptObject(object: any): { id: string | null; name: string } {
	const id = typeof object?.id === "string" ? object.id : null;
	const name = typeof object?.name === "string" && object.name.trim() ? object.name : isScene(object) ? "Scene" : (id ?? "Unidentified object");
	return { id, name };
}

function installAutomaticLifecycleObservers(scene: Scene, object: any, registeredScript: IRegisteredScript): void {
	const runtime = registeredScriptRuntimes.get(registeredScript)!;
	const simulation = getSceneScriptSimulationRuntime(scene);

	if (registeredScript.instance.onStart) {
		registeredScript.observers.onStartObserver = scene.onBeforeRenderObservable.add(() => {
			if (simulation.paused || simulation.executingManualStep || runtime.started) {
				return;
			}
			runtime.started = true;
			registeredScript.observers.onStartObserver?.remove(true);
			registeredScript.observers.onStartObserver = null;
			invokeScriptLifecycle(
				{ scene, scriptKey: registeredScript.key, object, scriptInstance: registeredScript.instance, diagnostics: registeredScript.diagnostics },
				"onStart",
				() => registeredScript.instance.onStart!(object)
			);
		});
	}

	if (registeredScript.instance.onUpdate) {
		registeredScript.observers.onUpdateObserver = scene.onBeforeRenderObservable.add(() => {
			if (simulation.paused || simulation.executingManualStep || !runtime.started) {
				return;
			}
			invokeScriptLifecycle(
				{ scene, scriptKey: registeredScript.key, object, scriptInstance: registeredScript.instance, diagnostics: registeredScript.diagnostics },
				"onUpdate",
				() => registeredScript.instance.onUpdate!(object)
			);
		});
	}
}

/** Returns deterministic attached-script pause and fixed-step telemetry for one scene. */
export function getScriptSimulationControl(scene: Scene): IScriptSimulationControl {
	const runtime = getSceneScriptSimulationRuntime(scene);
	return {
		paused: runtime.paused,
		executingManualStep: runtime.executingManualStep,
		registeredScripts: runtime.registrations.length,
		startedScripts: runtime.registrations.filter((registration) => registration.started).length,
		totalManualSteps: runtime.totalManualSteps,
		totalManualSeconds: runtime.totalManualSeconds,
		totalManualStartCalls: runtime.totalManualStartCalls,
		totalManualUpdateCalls: runtime.totalManualUpdateCalls,
		lastStepSeconds: runtime.lastStepSeconds,
		lastError: runtime.lastError ? { ...runtime.lastError } : null,
	};
}

/** Pauses or resumes automatic onStart/onUpdate delivery while the scene may continue rendering. */
export function setScriptSimulationPaused(scene: Scene, paused: boolean): IScriptSimulationControl {
	getSceneScriptSimulationRuntime(scene).paused = paused;
	return getScriptSimulationControl(scene);
}

/**
 * Advances all attached script lifecycles by one deterministic fixed frame.
 * Pending onStart methods execute first in registration/execution-order order,
 * followed by onUpdate methods in the same order. The engine delta is restored
 * even when a user script throws.
 */
export function stepPausedScriptSimulation(scene: Scene, deltaSeconds: number): IScriptSimulationStepResult {
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 1 / 1000 || deltaSeconds > 0.1) {
		throw new Error("deltaSeconds must be from 0.001 through 0.1 seconds.");
	}
	const simulation = getSceneScriptSimulationRuntime(scene);
	if (!simulation.paused) {
		throw new Error("Pause game-script simulation before manually stepping it.");
	}
	if (simulation.executingManualStep) {
		throw new Error("A game-script manual step is already executing for this scene.");
	}

	const engine = scene.getEngine() as any;
	const previousDeltaTime = engine._deltaTime;
	const registrations = simulation.registrations.slice();
	let startCalls = 0;
	let updateCalls = 0;
	const updatedScriptKeys: string[] = [];
	let breakpointHit = false;

	const invokeManual = (registration: IRegisteredScriptRuntime, lifecycle: "onStart" | "onUpdate", callback: () => void): boolean => {
		try {
			return invokeScriptLifecycle(
				{
					scene: registration.scene,
					scriptKey: registration.registeredScript.key,
					object: registration.object,
					scriptInstance: registration.registeredScript.instance,
					diagnostics: registration.registeredScript.diagnostics,
				},
				lifecycle,
				callback,
				deltaSeconds
			);
		} catch (error) {
			const object = describeScriptObject(registration.object);
			const message = error instanceof Error ? error.message : String(error);
			simulation.lastError = { key: registration.registeredScript.key, objectId: object.id, objectName: object.name, lifecycle, message, timestamp: Date.now() };
			throw new Error(`Script "${registration.registeredScript.key}" on "${object.name}" failed during ${lifecycle} in a manual fixed step: ${message}`, {
				cause: error,
			});
		}
	};

	simulation.executingManualStep = true;
	simulation.lastError = null;
	engine._deltaTime = deltaSeconds * 1000;
	try {
		for (const registration of registrations) {
			if (registration.started || !registration.registeredScript.instance.onStart) {
				continue;
			}
			registration.started = true;
			registration.registeredScript.observers.onStartObserver?.remove();
			registration.registeredScript.observers.onStartObserver = null;
			startCalls++;
			breakpointHit = invokeManual(registration, "onStart", () => registration.registeredScript.instance.onStart!(registration.object));
			if (breakpointHit) {
				break;
			}
		}

		if (!breakpointHit) {
			for (const registration of registrations) {
				if (!registration.started || !registration.registeredScript.instance.onUpdate || !simulation.registrations.includes(registration)) {
					continue;
				}
				updateCalls++;
				updatedScriptKeys.push(registration.registeredScript.key);
				breakpointHit = invokeManual(registration, "onUpdate", () => registration.registeredScript.instance.onUpdate!(registration.object));
				if (breakpointHit) {
					break;
				}
			}
		}

		simulation.totalManualSteps++;
		simulation.totalManualSeconds += deltaSeconds;
		simulation.totalManualStartCalls += startCalls;
		simulation.totalManualUpdateCalls += updateCalls;
		simulation.lastStepSeconds = deltaSeconds;
		return {
			deltaSeconds,
			registeredScripts: simulation.registrations.length,
			startedScripts: simulation.registrations.filter((registration) => registration.started).length,
			startCalls,
			updateCalls,
			updatedScriptKeys,
			breakpointHit,
		};
	} finally {
		engine._deltaTime = previousDeltaTime;
		simulation.executingManualStep = false;
	}
}

/**
 * When a scene is being loaded, scripts that were attached to objects in the scene using the Editor are processed.
 * This function registers the instance of scripts per object in order to retrieve them later.
 * @internal
 */
export function _registerScriptInstance(
	object: any,
	scriptInstance: IScript,
	key: string,
	observers: IRegisteredScriptObservers,
	diagnostics = createScriptRuntimeDiagnostics(),
	scene?: Scene
): IRegisteredScript {
	const registeredScript = {
		key,
		observers,
		instance: scriptInstance,
		diagnostics,
	} as IRegisteredScript;
	const owningScene = scene ?? (isScene(object) ? object : object.getScene?.());
	if (owningScene) {
		const runtime: IRegisteredScriptRuntime = { scene: owningScene, object, registeredScript, started: !scriptInstance.onStart };
		registeredScriptRuntimes.set(registeredScript, runtime);
		getSceneScriptSimulationRuntime(owningScene).registrations.push(runtime);
	}

	if (!scriptsDictionary.has(object)) {
		scriptsDictionary.set(object, [registeredScript]);
	} else {
		scriptsDictionary.get(object)!.push(registeredScript);
	}

	if (isNode(object) || isAnyParticleSystem(object) || isScene(object) || isSoundNode(object)) {
		object.onDisposeObservable.addOnce((() => {
			const scripts = scriptsDictionary.get(object)?.slice();
			scripts?.forEach((s) => {
				_removeRegisteredScriptInstance(object, s);
			});

			scriptsDictionary.delete(object);
		}) as any);
	}

	return registeredScript;
}

/**
 * When a node is disposed, or for hot reload purpose, the script should be unregistered and all observers removed.
 * @internal
 */
export function _removeRegisteredScriptInstance(object: any, registeredScript: IRegisteredScript) {
	registeredScript.observers.onStartObserver?.remove();
	registeredScript.observers.onUpdateObserver?.remove();

	registeredScript.observers.pointerObserver?.remove();
	registeredScript.observers.keyboardObserver?.remove();

	const runtime = registeredScriptRuntimes.get(registeredScript);
	try {
		if (registeredScript.instance.onStop) {
			invokeScriptLifecycle(
				{ scene: runtime?.scene, scriptKey: registeredScript.key, object, scriptInstance: registeredScript.instance, diagnostics: registeredScript.diagnostics },
				"onStop",
				() => registeredScript.instance.onStop!(object)
			);
		}
	} catch (e) {
		console.error(`Failed to call onStop for script ${registeredScript.key} on object ${object}`, e);
	}

	const runningScripts = scriptsDictionary.get(object);
	const index = runningScripts?.indexOf(registeredScript) ?? -1;
	if (index !== -1) {
		runningScripts?.splice(index, 1);
	}

	if (runtime) {
		const simulation = getSceneScriptSimulationRuntime(runtime.scene);
		const runtimeIndex = simulation.registrations.indexOf(runtime);
		if (runtimeIndex !== -1) {
			simulation.registrations.splice(runtimeIndex, 1);
		}
		registeredScriptRuntimes.delete(registeredScript);
	}
}

function createScriptRuntimeDiagnostics(): IScriptRuntimeDiagnostics {
	return { onStartCalls: 0, onUpdateCalls: 0, onStopCalls: 0, manualOnStartCalls: 0, manualOnUpdateCalls: 0, lastManualDeltaSeconds: null, errorCount: 0, lastError: null };
}

interface IScriptLifecycleInvocation {
	scene: Scene | undefined;
	scriptKey: string;
	object: any;
	scriptInstance: IScript;
	diagnostics: IScriptRuntimeDiagnostics;
}

function invokeScriptLifecycle(invocation: IScriptLifecycleInvocation, lifecycle: "onStart" | "onUpdate" | "onStop", callback: () => void, manualDeltaSeconds?: number): boolean {
	const { scene, scriptKey, object, scriptInstance, diagnostics } = invocation;
	const hitSequence = scene ? getScriptSourceDebuggerHitSequence(scene) : 0;
	const endSourceInvocation = scene ? beginScriptSourceInvocation(scene, scriptKey, lifecycle, object, scriptInstance) : null;
	diagnostics[`${lifecycle}Calls`]++;
	if (manualDeltaSeconds !== undefined) {
		if (lifecycle === "onStart") {
			diagnostics.manualOnStartCalls++;
		}
		if (lifecycle === "onUpdate") {
			diagnostics.manualOnUpdateCalls++;
		}
		diagnostics.lastManualDeltaSeconds = manualDeltaSeconds;
	}
	const target = describeScriptObject(object);
	const marker = scene
		? beginPortableProfilerMarker(scene, `${scriptKey}.${lifecycle}`, "Scripts", {
				objectId: target.id,
				objectName: target.name,
				scriptKey,
				lifecycle,
			})
		: null;
	try {
		callback();
		marker?.end();
	} catch (error) {
		marker?.end(error);
		diagnostics.errorCount++;
		diagnostics.lastError = {
			lifecycle,
			message: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		throw error;
	} finally {
		endSourceInvocation?.();
	}
	return scene ? getScriptSourceDebuggerHitSequence(scene) !== hitSequence : false;
}

/**
 * Returns all the instances of the script attached to the given object that matches the given class type.
 * The same script can be attached multiple times to the same object. If you ensure that ONLY DISTINCT scripts
 * are attached to the object, you can use `getScriptByClassForObject` which will return the unique instance for the given object.
 * @param object defines the reference to the object where the script to retrieve is attached to.
 * @param classType defines the class of the type to retrieve
 * @example
 * import { IScript, getAllScriptsByClassForObject } from "babylonjs-editor-tools";
 *
 * class ScriptClass implements IScript {
 * 	public onStart(): void {
 * 		const instances = getAllScriptsByClassForObject(mesh, OtherScriptClass);
 * 		instances.forEach((i) => {
 * 			i.doSomething();
 * 		});
 * 	}
 * }
 *
 * class OtherScriptClass implements IScript {
 * 	public doSomething(): void {
 * 		console.log("Doing something!");
 * 	}
 * }
 */
export function getAllScriptsByClassForObject<T extends new (...args: any) => any>(object: any, classType: T) {
	const data = scriptsDictionary.get(object);
	const result = data?.filter((s) => s.instance.constructor === classType);

	return (result?.map((r) => r.instance) as InstanceType<T>[]) ?? null;
}

/**
 * Returns the instance of the script attached to the given object that matches the given class type.
 * @param object defines the reference to the object where the script to retrieve is attached to.
 * @param classType defines the class of the type to retrieve
 * @example
 * import { IScript, getScriptByClassForObject } from "babylonjs-editor-tools";
 *
 * class ScriptClass implements IScript {
 * 	public onStart(): void {
 * 		const instance = getScriptByClassForObject(mesh, OtherScriptClass);
 * 		instance.doSomething();
 * 	}
 * }
 *
 * class OtherScriptClass implements IScript {
 * 	public doSomething(): void {
 * 		console.log("Doing something!");
 * 	}
 * }
 */
export function getScriptByClassForObject<T extends new (...args: any) => any>(object: any, classType: T) {
	const result = getAllScriptsByClassForObject<T>(object, classType);
	return (result?.[0] as InstanceType<T>) ?? null;
}

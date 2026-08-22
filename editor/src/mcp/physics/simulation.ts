import { Scene } from "babylonjs";
import {
	getClothSimulationControl,
	getPhysics2DSimulationControl,
	getScriptSimulationControl,
	setClothSimulationPaused,
	setPhysics2DSimulationPaused,
	setScriptSimulationPaused,
	stepPausedClothSimulation,
	stepPausedPhysics2DSimulation,
	stepPausedScriptSimulation,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { IPhysicsEditorTarget, resolvePhysicsEditorTarget } from "./target";

interface IPhysicsSimulationControl {
	paused: boolean;
	previousPhysicsEnabled: boolean;
	totalManualSteps: number;
	totalManualSeconds: number;
	lastStepSeconds: number | null;
	lastError: { message: string; phase: string; completedSteps: number; completedPhases: string[]; timestamp: number } | null;
}

const controls = new WeakMap<Scene, IPhysicsSimulationControl>();

function state(scene: Scene): IPhysicsSimulationControl {
	let value = controls.get(scene);
	if (!value) {
		value = { paused: false, previousPhysicsEnabled: scene.physicsEnabled, totalManualSteps: 0, totalManualSeconds: 0, lastStepSeconds: null, lastError: null };
		controls.set(scene, value);
	}
	return value;
}

function getTargetScriptSimulationControl(target: IPhysicsEditorTarget): any {
	return target.play ? target.play.getScriptSimulationControl() : getScriptSimulationControl(target.scene as any);
}

function setTargetScriptSimulationPaused(target: IPhysicsEditorTarget, paused: boolean): any {
	return target.play ? target.play.setScriptSimulationPaused(paused) : setScriptSimulationPaused(target.scene as any, paused);
}

function stepTargetScriptSimulation(target: IPhysicsEditorTarget, deltaSeconds: number): any {
	return target.play ? target.play.stepPausedScriptSimulation(deltaSeconds) : stepPausedScriptSimulation(target.scene as any, deltaSeconds);
}

function getTargetClothSimulationControl(target: IPhysicsEditorTarget): any {
	return target.play ? target.play.getClothSimulationControl() : getClothSimulationControl(target.scene as any);
}

function setTargetClothSimulationPaused(target: IPhysicsEditorTarget, paused: boolean): any {
	return target.play ? target.play.setClothSimulationPaused(paused) : setClothSimulationPaused(target.scene as any, paused);
}

function stepTargetClothSimulation(target: IPhysicsEditorTarget, deltaSeconds: number): any {
	return target.play ? target.play.stepPausedClothSimulation(deltaSeconds) : stepPausedClothSimulation(target.scene as any, deltaSeconds);
}

function getTargetPhysics2DSimulationControl(target: IPhysicsEditorTarget): any {
	return target.play ? target.play.getPhysics2DSimulationControl() : getPhysics2DSimulationControl(target.scene as any);
}

function setTargetPhysics2DSimulationPaused(target: IPhysicsEditorTarget, paused: boolean): any {
	return target.play ? target.play.setPhysics2DSimulationPaused(paused) : setPhysics2DSimulationPaused(target.scene as any, paused);
}

function stepTargetPhysics2DSimulation(target: IPhysicsEditorTarget, deltaSeconds: number): any {
	return target.play ? target.play.stepPausedPhysics2DSimulation(deltaSeconds) : stepPausedPhysics2DSimulation(target.scene as any, deltaSeconds);
}

export function getPhysicsSimulationControl(scene: Scene, _data?: any, options?: IMCPActionOptions): any {
	const target = resolvePhysicsEditorTarget(scene, options);
	const value = state(target.scene);
	return {
		target: target.target,
		physicsEngineActive: !!target.scene.getPhysicsEngine(),
		paused: value.paused,
		automaticPhysicsEnabled: target.scene.physicsEnabled,
		totalManualSteps: value.totalManualSteps,
		totalManualSeconds: value.totalManualSeconds,
		lastStepSeconds: value.lastStepSeconds,
		lastError: value.lastError ? { ...value.lastError } : null,
		gameScripts: getTargetScriptSimulationControl(target),
		cloth: getTargetClothSimulationControl(target),
		physics2D: getTargetPhysics2DSimulationControl(target),
	};
}

/**
 * Reads the simulation state for Inspector rendering without allowing an older
 * project-owned Play bundle to take down the entire Scene Inspector. Mutating
 * MCP operations remain strict and continue to reject an incompatible bundle.
 */
export function getPhysicsSimulationControlForInspector(scene: Scene, options: IMCPActionOptions): { control: any | null; error: string | null } {
	try {
		return { control: getPhysicsSimulationControl(scene, {}, options), error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			return { control: getPhysicsSimulationControl(scene), error: message };
		} catch (fallbackError) {
			const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
			return { control: null, error: `${message} Edit-scene fallback also failed: ${fallbackMessage}` };
		}
	}
}

export function setPhysicsSimulationPaused(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (typeof data.paused !== "boolean") {
		throw new Error("paused must be a boolean.");
	}
	const target = resolvePhysicsEditorTarget(scene, options);
	const value = state(target.scene);
	const paused = data.paused === true;
	// Preflight every exact owner before mutating any solver. Old Play bundles therefore
	// reject without leaving scripts, cloth, Physics 2D, or Havok in a split pause state.
	const previous = {
		scripts: getTargetScriptSimulationControl(target).paused === true,
		cloth: getTargetClothSimulationControl(target).paused === true,
		physics2D: getTargetPhysics2DSimulationControl(target).paused === true,
	};
	try {
		setTargetScriptSimulationPaused(target, paused);
		setTargetClothSimulationPaused(target, paused);
		setTargetPhysics2DSimulationPaused(target, paused);
		if (paused && !value.paused) {
			value.previousPhysicsEnabled = target.scene.physicsEnabled;
			if (target.scene.getPhysicsEngine()) {
				target.scene.physicsEnabled = false;
			}
			value.paused = true;
		} else if (!paused && value.paused) {
			if (target.scene.getPhysicsEngine()) {
				target.scene.physicsEnabled = value.previousPhysicsEnabled;
			}
			value.paused = false;
		}
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const [label, restore] of [
			["Physics 2D", () => setTargetPhysics2DSimulationPaused(target, previous.physics2D)],
			["cloth", () => setTargetClothSimulationPaused(target, previous.cloth)],
			["scripts", () => setTargetScriptSimulationPaused(target, previous.scripts)],
		] as const) {
			try {
				restore();
			} catch (rollbackError) {
				rollbackErrors.push(`${label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(rollbackErrors.length ? `${message} Pause rollback also failed (${rollbackErrors.join("; ")}).` : message);
	}
	options.editor.layout.inspector.forceUpdate();
	return getPhysicsSimulationControl(scene, {}, options);
}

export function stepPhysicsSimulation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const target = resolvePhysicsEditorTarget(scene, options);
	const engine = target.scene.getPhysicsEngine() as any;
	const value = state(target.scene);
	if (!value.paused || (engine && target.scene.physicsEnabled)) {
		throw new Error(`Pause the ${target.target} simulation before manually stepping it.`);
	}
	if (engine && typeof engine._step !== "function") {
		throw new Error("The active physics engine does not support manual stepping.");
	}
	const steps = data.steps ?? 1;
	const deltaSeconds = data.deltaSeconds ?? 1 / 60;
	if (!Number.isInteger(steps) || steps < 1 || steps > 120) {
		throw new Error("steps must be an integer from 1 through 120.");
	}
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 1 / 1000 || deltaSeconds > 0.1) {
		throw new Error("deltaSeconds must be from 0.001 through 0.1 seconds.");
	}
	const previousTimeStep = engine?.getTimeStep?.();
	const renderEngine = target.scene.getEngine() as any;
	const previousRenderDeltaTime = renderEngine._deltaTime;
	let completedSteps = 0;
	let scriptStartCalls = 0;
	let scriptUpdateCalls = 0;
	const updatedScriptKeys = new Set<string>();
	let clothStep: any = null;
	let physics2DStep: any = null;
	let phase = "scripts";
	let completedPhases: string[] = [];
	value.lastError = null;
	try {
		engine?.setTimeStep?.(deltaSeconds);
		for (let index = 0; index < steps; index++) {
			renderEngine._deltaTime = deltaSeconds * 1000;
			completedPhases = [];
			phase = "scripts";
			const scripts = stepTargetScriptSimulation(target, deltaSeconds);
			scriptStartCalls += scripts.startCalls;
			scriptUpdateCalls += scripts.updateCalls;
			scripts.updatedScriptKeys.forEach((key) => updatedScriptKeys.add(key));
			completedPhases.push("scripts");
			phase = "cloth";
			clothStep = stepTargetClothSimulation(target, deltaSeconds);
			completedPhases.push("cloth");
			phase = "physics2D";
			physics2DStep = stepTargetPhysics2DSimulation(target, deltaSeconds);
			completedPhases.push("physics2D");
			if (engine) {
				phase = "beforePhysics3D";
				target.scene.onBeforePhysicsObservable.notifyObservers(target.scene);
				completedPhases.push("beforePhysics3D");
				phase = "physics3D";
				engine._step(deltaSeconds);
				completedPhases.push("physics3D");
				phase = "afterPhysics3D";
				target.scene.onAfterPhysicsObservable.notifyObservers(target.scene);
				completedPhases.push("afterPhysics3D");
			}
			completedSteps++;
			value.totalManualSteps++;
			value.totalManualSeconds += deltaSeconds;
			value.lastStepSeconds = deltaSeconds;
		}
	} catch (error) {
		value.lastError = { message: error instanceof Error ? error.message : String(error), phase, completedSteps, completedPhases: [...completedPhases], timestamp: Date.now() };
		throw error;
	} finally {
		if (engine && previousTimeStep !== undefined) {
			engine.setTimeStep?.(previousTimeStep);
		}
		renderEngine._deltaTime = previousRenderDeltaTime;
		options.editor.layout.inspector.forceUpdate();
	}
	return {
		...getPhysicsSimulationControl(scene, {}, options),
		stepped: completedSteps,
		advancedSeconds: completedSteps * deltaSeconds,
		gameScriptStep: { startCalls: scriptStartCalls, updateCalls: scriptUpdateCalls, updatedScriptKeys: [...updatedScriptKeys] },
		clothStep,
		physics2DStep,
	};
}

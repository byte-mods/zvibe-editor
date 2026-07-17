import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

interface IPhysicsSimulationControl {
	paused: boolean;
	previousPhysicsEnabled: boolean;
	totalManualSteps: number;
	totalManualSeconds: number;
	lastStepSeconds: number | null;
}

const controls = new WeakMap<Scene, IPhysicsSimulationControl>();

function state(scene: Scene): IPhysicsSimulationControl {
	let value = controls.get(scene);
	if (!value) {
		value = { paused: false, previousPhysicsEnabled: scene.physicsEnabled, totalManualSteps: 0, totalManualSeconds: 0, lastStepSeconds: null };
		controls.set(scene, value);
	}
	return value;
}

export function getPhysicsSimulationControl(scene: Scene): any {
	const value = state(scene);
	return {
		physicsEngineActive: !!scene.getPhysicsEngine(),
		paused: value.paused,
		automaticPhysicsEnabled: scene.physicsEnabled,
		totalManualSteps: value.totalManualSteps,
		totalManualSeconds: value.totalManualSeconds,
		lastStepSeconds: value.lastStepSeconds,
	};
}

export function setPhysicsSimulationPaused(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!scene.getPhysicsEngine()) throw new Error("No physics engine is active in the current scene.");
	const value = state(scene);
	if (data.paused === true && !value.paused) {
		value.previousPhysicsEnabled = scene.physicsEnabled;
		scene.physicsEnabled = false;
		value.paused = true;
	} else if (data.paused === false && value.paused) {
		scene.physicsEnabled = value.previousPhysicsEnabled;
		value.paused = false;
	}
	options.editor.layout.inspector.forceUpdate();
	return getPhysicsSimulationControl(scene);
}

export function stepPhysicsSimulation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const engine = scene.getPhysicsEngine() as any;
	if (!engine?._step) throw new Error("The active physics engine does not support manual stepping.");
	const value = state(scene);
	if (!value.paused || scene.physicsEnabled) throw new Error("Pause the physics simulation before manually stepping it.");
	const steps = data.steps ?? 1;
	const deltaSeconds = data.deltaSeconds ?? 1 / 60;
	if (!Number.isInteger(steps) || steps < 1 || steps > 120) throw new Error("steps must be an integer from 1 through 120.");
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 1 / 1000 || deltaSeconds > 0.1) throw new Error("deltaSeconds must be from 0.001 through 0.1 seconds.");
	const previousTimeStep = engine.getTimeStep?.();
	try {
		engine.setTimeStep?.(deltaSeconds);
		for (let index = 0; index < steps; index++) {
			scene.onBeforePhysicsObservable.notifyObservers(scene);
			engine._step(deltaSeconds);
			scene.onAfterPhysicsObservable.notifyObservers(scene);
		}
	} finally {
		if (previousTimeStep !== undefined) engine.setTimeStep?.(previousTimeStep);
	}
	value.totalManualSteps += steps;
	value.totalManualSeconds += steps * deltaSeconds;
	value.lastStepSeconds = deltaSeconds;
	options.editor.layout.inspector.forceUpdate();
	return { ...getPhysicsSimulationControl(scene), stepped: steps, advancedSeconds: steps * deltaSeconds };
}

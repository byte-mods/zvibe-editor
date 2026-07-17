import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Observable, Scene } from "babylonjs";

import { getPhysicsSimulationControl, setPhysicsSimulationPaused, stepPhysicsSimulation } from "../../src/mcp/physics/simulation";

describe("mcp/physics simulation control", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("pauses automatic updates, advances bounded fixed steps, and restores prior state", () => {
		let timeStep = 1 / 60;
		const physics = {
			_step: vi.fn(),
			getTimeStep: () => timeStep,
			setTimeStep: vi.fn((value: number) => (timeStep = value)),
		};
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue(physics as any);
		(scene as any).onBeforePhysicsObservable = new Observable<Scene>();
		(scene as any).onAfterPhysicsObservable = new Observable<Scene>();
		const before = vi.fn();
		const after = vi.fn();
		scene.onBeforePhysicsObservable.add(before);
		scene.onAfterPhysicsObservable.add(after);
		scene.physicsEnabled = true;

		expect(setPhysicsSimulationPaused(scene, { paused: true }, options)).toMatchObject({ paused: true, automaticPhysicsEnabled: false });
		expect(() => stepPhysicsSimulation(scene, { steps: 121 }, options)).toThrow("1 through 120");
		expect(stepPhysicsSimulation(scene, { steps: 3, deltaSeconds: 0.02 }, options)).toMatchObject({ paused: true, stepped: 3, advancedSeconds: 0.06, totalManualSteps: 3 });
		expect(physics._step).toHaveBeenCalledTimes(3);
		expect(physics._step).toHaveBeenLastCalledWith(0.02);
		expect(before).toHaveBeenCalledTimes(3);
		expect(after).toHaveBeenCalledTimes(3);
		expect(timeStep).toBeCloseTo(1 / 60);
		expect(setPhysicsSimulationPaused(scene, { paused: false }, options)).toMatchObject({ paused: false, automaticPhysicsEnabled: true });
		expect(getPhysicsSimulationControl(scene)).toMatchObject({ totalManualSteps: 3, totalManualSeconds: 0.06 });
	});
});

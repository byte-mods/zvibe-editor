import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, NullEngine, Observable, Scene, TransformNode, VertexBuffer } from "babylonjs";
import {
	applyScriptOnObject,
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

import { getPhysicsSimulationControl, getPhysicsSimulationControlForInspector, setPhysicsSimulationPaused, stepPhysicsSimulation } from "../../src/mcp/physics/simulation";

describe("mcp/physics simulation control", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;
	const playBridge = (playScene: Scene): any => ({
		canPlayScene: true,
		scene: playScene,
		getScriptSimulationControl: vi.fn(() => getScriptSimulationControl(playScene as any)),
		setScriptSimulationPaused: vi.fn((paused: boolean) => setScriptSimulationPaused(playScene as any, paused)),
		stepPausedScriptSimulation: vi.fn((deltaSeconds: number) => stepPausedScriptSimulation(playScene as any, deltaSeconds)),
		getClothSimulationControl: vi.fn(() => getClothSimulationControl(playScene as any)),
		setClothSimulationPaused: vi.fn((paused: boolean) => setClothSimulationPaused(playScene as any, paused)),
		stepPausedClothSimulation: vi.fn((deltaSeconds: number) => stepPausedClothSimulation(playScene as any, deltaSeconds)),
		getPhysics2DSimulationControl: vi.fn(() => getPhysics2DSimulationControl(playScene as any)),
		setPhysics2DSimulationPaused: vi.fn((paused: boolean) => setPhysics2DSimulationPaused(playScene as any, paused)),
		stepPausedPhysics2DSimulation: vi.fn((deltaSeconds: number) => stepPausedPhysics2DSimulation(playScene as any, deltaSeconds)),
	});

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

	test("keeps the Scene Inspector renderable when a project Play bundle lacks the current simulation bridge", () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		const playOptions = {
			editor: {
				layout: {
					preview: {
						play: {
							canPlayScene: true,
							scene: playScene,
							getScriptSimulationControl: () => {
								throw new Error('The compiled Play game-script bridge "getScriptSimulationControl" is unavailable.');
							},
						},
					},
				},
			},
		} as any;

		const inspection = getPhysicsSimulationControlForInspector(scene, playOptions);
		expect(inspection.error).toContain("getScriptSimulationControl");
		expect(inspection.control).toMatchObject({ target: "editor", paused: false, gameScripts: { registeredScripts: 0 } });

		playScene.dispose();
		playEngine.dispose();
	});

	test("steps scripts, cloth, and Physics 2D without requiring Havok", () => {
		const scriptNode = new Mesh("Script Node", scene);
		const body = new TransformNode("2D Body", scene);
		const cloth = new Mesh("Cloth", scene);
		cloth.setVerticesData(VertexBuffer.PositionKind, new Float32Array(27), true);
		cloth.setVerticesData(VertexBuffer.NormalKind, new Float32Array(27), true);
		cloth.setIndices([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7]);
		scene.metadata = {
			babylonEditorCloths: [{ id: "cloth", meshId: cloth.id, subdivisions: 2, pinnedVertices: [0], gravity: [0, -100, 0] }],
			babylonEditorPhysics2D: [{ nodeId: body.id, bodyType: "dynamic", collider: { shape: "circle", radius: 10 }, gravity: [0, -100] }],
		};
		applyScriptOnObject(
			scriptNode,
			class {
				public onUpdate(): void {
					body.position.y = 0;
				}
			}
		);

		expect(setPhysicsSimulationPaused(scene, { paused: true }, options)).toMatchObject({
			paused: true,
			physicsEngineActive: false,
			cloth: { paused: true, registeredCloths: 1 },
			physics2D: { paused: true, registeredBodies: 1 },
		});
		const result = stepPhysicsSimulation(scene, { steps: 1, deltaSeconds: 0.02 }, options);
		expect(result).toMatchObject({
			stepped: 1,
			clothStep: { steppedCloths: 1, totalManualSteps: 1 },
			physics2DStep: { steppedBodies: 1, totalManualSteps: 1 },
			gameScriptStep: { updateCalls: 1 },
		});
		expect(body.position.y).toBeCloseTo(-0.04, 8);
		expect(cloth.getVerticesData(VertexBuffer.PositionKind)![4]).toBeLessThan(0);
		expect(setPhysicsSimulationPaused(scene, { paused: false }, options)).toMatchObject({ cloth: { paused: false }, physics2D: { paused: false } });
	});

	test("leaves Play physics unchanged when the compiled script bridge is unavailable", () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		const playPhysics = { _step: vi.fn() };
		vi.spyOn(playScene, "getPhysicsEngine").mockReturnValue(playPhysics as any);
		playScene.physicsEnabled = true;
		const playOptions = {
			editor: {
				layout: {
					preview: {
						play: {
							canPlayScene: true,
							scene: playScene,
							getScriptSimulationControl: vi.fn(() => {
								throw new Error("compiled Play bridge unavailable");
							}),
						},
					},
					inspector: { forceUpdate: vi.fn() },
				},
			},
		} as any;

		expect(() => setPhysicsSimulationPaused(scene, { paused: true }, playOptions)).toThrow("compiled Play bridge unavailable");
		expect(playScene.physicsEnabled).toBe(true);
		expect(playPhysics._step).not.toHaveBeenCalled();

		playScene.dispose();
		playEngine.dispose();
	});

	test("rolls back earlier Play solver pauses when a later solver setter fails", () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		const playPhysics = { _step: vi.fn() };
		vi.spyOn(playScene, "getPhysicsEngine").mockReturnValue(playPhysics as any);
		playScene.physicsEnabled = true;
		const bridge = playBridge(playScene);
		bridge.setPhysics2DSimulationPaused = vi.fn((paused: boolean) => {
			if (paused) {
				throw new Error("expected Physics 2D pause failure");
			}
			return setPhysics2DSimulationPaused(playScene as any, false);
		});
		const playOptions = { editor: { layout: { preview: { play: bridge }, inspector: { forceUpdate: vi.fn() } } } } as any;

		expect(() => setPhysicsSimulationPaused(scene, { paused: true }, playOptions)).toThrow("expected Physics 2D pause failure");
		expect(getScriptSimulationControl(playScene as any).paused).toBe(false);
		expect(getClothSimulationControl(playScene as any).paused).toBe(false);
		expect(getPhysics2DSimulationControl(playScene as any).paused).toBe(false);
		expect(playScene.physicsEnabled).toBe(true);
		expect(playPhysics._step).not.toHaveBeenCalled();

		playScene.dispose();
		playEngine.dispose();
	});

	test("targets the live play scene and advances attached scripts once before each physics step", () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		const editPhysics = { _step: vi.fn() };
		const order: string[] = [];
		let timeStep = 1 / 60;
		const playPhysics = {
			_step: vi.fn(() => order.push("physics")),
			getTimeStep: () => timeStep,
			setTimeStep: vi.fn((value: number) => (timeStep = value)),
		};
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue(editPhysics as any);
		vi.spyOn(playScene, "getPhysicsEngine").mockReturnValue(playPhysics as any);
		(playScene as any).onBeforePhysicsObservable = new Observable<Scene>();
		(playScene as any).onAfterPhysicsObservable = new Observable<Scene>();
		playScene.physicsEnabled = true;
		playScene.onBeforePhysicsObservable.add(() => order.push("before-physics"));
		playScene.onAfterPhysicsObservable.add(() => order.push("after-physics"));
		const mesh = new Mesh("Runtime Script Node", playScene);
		applyScriptOnObject(
			mesh,
			class {
				public onStart(): void {
					order.push(`start:${playEngine.getDeltaTime()}`);
				}

				public onUpdate(): void {
					order.push(`update:${playEngine.getDeltaTime()}`);
				}
			}
		);
		const bridge = playBridge(playScene);
		const playOptions = {
			editor: {
				layout: {
					preview: { play: bridge },
					inspector: { forceUpdate: vi.fn() },
				},
			},
		} as any;

		expect(setPhysicsSimulationPaused(scene, { paused: true }, playOptions)).toMatchObject({
			target: "play",
			paused: true,
			automaticPhysicsEnabled: false,
			gameScripts: { paused: true, registeredScripts: 1, startedScripts: 0 },
		});
		playScene.onBeforeRenderObservable.notifyObservers(playScene);
		expect(order).toEqual([]);

		const result = stepPhysicsSimulation(scene, { steps: 2, deltaSeconds: 0.02 }, playOptions);
		expect(result).toMatchObject({
			target: "play",
			stepped: 2,
			advancedSeconds: 0.04,
			gameScriptStep: { startCalls: 1, updateCalls: 2, updatedScriptKeys: ["runtime"] },
			gameScripts: { paused: true, totalManualSteps: 2, totalManualUpdateCalls: 2, lastStepSeconds: 0.02 },
		});
		expect(order).toEqual(["start:20", "update:20", "before-physics", "physics", "after-physics", "update:20", "before-physics", "physics", "after-physics"]);
		expect(editPhysics._step).not.toHaveBeenCalled();
		expect(playPhysics._step).toHaveBeenCalledTimes(2);
		expect(bridge.stepPausedScriptSimulation).toHaveBeenCalledTimes(2);
		expect(bridge.stepPausedClothSimulation).toHaveBeenCalledTimes(2);
		expect(bridge.stepPausedPhysics2DSimulation).toHaveBeenCalledTimes(2);
		expect(timeStep).toBeCloseTo(1 / 60);
		expect(getPhysicsSimulationControl(scene, {}, playOptions)).toMatchObject({ target: "play", totalManualSteps: 2, gameScripts: { startedScripts: 1 } });
		expect(setPhysicsSimulationPaused(scene, { paused: false }, playOptions)).toMatchObject({ paused: false, automaticPhysicsEnabled: true, gameScripts: { paused: false } });

		playScene.dispose();
		playEngine.dispose();
	});

	test("keeps the play simulation paused and restores both clocks when an attached script fails", () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		let timeStep = 1 / 60;
		const playPhysics = {
			_step: vi.fn(),
			getTimeStep: () => timeStep,
			setTimeStep: vi.fn((value: number) => (timeStep = value)),
		};
		vi.spyOn(playScene, "getPhysicsEngine").mockReturnValue(playPhysics as any);
		(playScene as any).onBeforePhysicsObservable = new Observable<Scene>();
		(playScene as any).onAfterPhysicsObservable = new Observable<Scene>();
		playScene.physicsEnabled = true;
		const mesh = new Mesh("Failing Runtime Script", playScene);
		applyScriptOnObject(
			mesh,
			class {
				public onUpdate(): void {
					throw new Error("expected play failure");
				}
			}
		);
		const bridge = playBridge(playScene);
		const playOptions = { editor: { layout: { preview: { play: bridge }, inspector: { forceUpdate: vi.fn() } } } } as any;
		(playEngine as any)._deltaTime = 11;

		setPhysicsSimulationPaused(scene, { paused: true }, playOptions);
		expect(() => stepPhysicsSimulation(scene, { steps: 2, deltaSeconds: 0.025 }, playOptions)).toThrow('Script "runtime" on "Failing Runtime Script"');
		expect(playPhysics._step).not.toHaveBeenCalled();
		expect(bridge.stepPausedScriptSimulation).toHaveBeenCalledTimes(1);
		expect(bridge.stepPausedClothSimulation).not.toHaveBeenCalled();
		expect(bridge.stepPausedPhysics2DSimulation).not.toHaveBeenCalled();
		expect(timeStep).toBeCloseTo(1 / 60);
		expect(playEngine.getDeltaTime()).toBe(11);
		expect(getPhysicsSimulationControl(scene, {}, playOptions)).toMatchObject({
			target: "play",
			paused: true,
			automaticPhysicsEnabled: false,
			totalManualSteps: 0,
			lastError: { phase: "scripts", completedSteps: 0, completedPhases: [], message: expect.stringContaining("expected play failure") },
			gameScripts: {
				paused: true,
				executingManualStep: false,
				totalManualSteps: 0,
				lastError: { lifecycle: "onUpdate", message: "expected play failure" },
			},
		});
		setPhysicsSimulationPaused(scene, { paused: false }, playOptions);
		playScene.dispose();
		playEngine.dispose();
	});
});

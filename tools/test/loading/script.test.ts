import { afterEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "@babylonjs/core";

import {
	_applyScriptsForObjects,
	_removeRegisteredScriptInstance,
	applyScriptOnObject,
	getScriptSimulationControl,
	scriptsDictionary,
	setScriptSimulationPaused,
	stepPausedScriptSimulation,
} from "../../src/loading/script/apply";

describe("loading/script", () => {
	afterEach(() => {
		for (const [object, scripts] of scriptsDictionary) {
			scripts.slice().forEach((script) => _removeRegisteredScriptInstance(object, script));
			scriptsDictionary.delete(object);
		}
	});

	describe("applyScriptOnObject", () => {
		test("should onStart and onUpdate", async () => {
			const ScriptClass = class {
				onStart = vi.fn();
				onUpdate = vi.fn();
			};

			const scene: any = {
				onBeforeRenderObservable: {
					addOnce: vi.fn((fn) => fn()),
					add: vi.fn((fn) => fn()),
				},
			};

			const targertObject = {
				getScene() {
					return scene;
				},
			};

			const instance = applyScriptOnObject(targertObject, ScriptClass);

			expect(instance.onStart).toHaveBeenCalledTimes(1);
			expect(instance.onUpdate).toHaveBeenCalledTimes(1);
			expect(scriptsDictionary.get(targertObject as any)?.[0].diagnostics).toEqual({
				onStartCalls: 1,
				onUpdateCalls: 1,
				onStopCalls: 0,
				manualOnStartCalls: 0,
				manualOnUpdateCalls: 0,
				lastManualDeltaSeconds: null,
				errorCount: 0,
				lastError: null,
			});
		});

		test("records lifecycle errors before preserving their original propagation", () => {
			let onStart: (() => void) | undefined;
			const scene: any = {
				onBeforeRenderObservable: {
					add: (callback: () => void) => {
						onStart = callback;
						return null;
					},
				},
			};
			const target = { getScene: () => scene };

			applyScriptOnObject(
				target,
				class {
					public onStart(): void {
						throw new Error("expected runtime failure");
					}
				}
			);

			expect(onStart).toBeDefined();
			expect(onStart!).toThrow("expected runtime failure");
			expect(scriptsDictionary.get(target as any)?.[0].diagnostics).toMatchObject({
				onStartCalls: 1,
				errorCount: 1,
				lastError: { lifecycle: "onStart", message: "expected runtime failure" },
			});
		});
	});

	test("pauses render delivery and manually steps every script in deterministic phases with a fixed engine delta", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const calls: string[] = [];
		const early = { id: "early", name: "Early", metadata: { scripts: [{ key: "early.ts", enabled: true, executionOrder: -10 }] } };
		const late = { id: "late", name: "Late", metadata: { scripts: [{ key: "late.ts", enabled: true, executionOrder: 10 }] } };

		_applyScriptsForObjects(
			scene,
			[late, early],
			{
				"early.ts": {
					default: class {
						public onStart(): void {
							calls.push(`early:start:${engine.getDeltaTime()}`);
						}
						public onUpdate(): void {
							calls.push(`early:update:${engine.getDeltaTime()}`);
						}
					},
				},
				"late.ts": {
					default: class {
						public onStart(): void {
							calls.push(`late:start:${engine.getDeltaTime()}`);
						}
						public onUpdate(): void {
							calls.push(`late:update:${engine.getDeltaTime()}`);
						}
					},
				},
			},
			""
		);

		(engine as any)._deltaTime = 7;
		setScriptSimulationPaused(scene, true);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(calls).toEqual([]);

		const first = stepPausedScriptSimulation(scene, 0.02);
		expect(first).toEqual({
			deltaSeconds: 0.02,
			registeredScripts: 2,
			startedScripts: 2,
			startCalls: 2,
			updateCalls: 2,
			updatedScriptKeys: ["early.ts", "late.ts"],
			breakpointHit: false,
		});
		expect(calls).toEqual(["early:start:20", "late:start:20", "early:update:20", "late:update:20"]);
		expect(engine.getDeltaTime()).toBe(7);

		stepPausedScriptSimulation(scene, 0.02);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(calls.slice(-2)).toEqual(["early:update:20", "late:update:20"]);
		expect(getScriptSimulationControl(scene)).toMatchObject({
			paused: true,
			executingManualStep: false,
			registeredScripts: 2,
			startedScripts: 2,
			totalManualSteps: 2,
			totalManualSeconds: 0.04,
			totalManualStartCalls: 2,
			totalManualUpdateCalls: 4,
			lastStepSeconds: 0.02,
			lastError: null,
		});

		setScriptSimulationPaused(scene, false);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(calls.slice(-2)).toEqual(["early:update:7", "late:update:7"]);
		scene.dispose();
		engine.dispose();
	});

	test("restores the engine delta and keeps scripts paused after an actionable manual lifecycle failure", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const target = { id: "failing", name: "Failing Script", getScene: () => scene };
		applyScriptOnObject(
			target,
			class {
				public onUpdate(): void {
					throw new Error("expected fixed-step failure");
				}
			}
		);
		(engine as any)._deltaTime = 13;
		setScriptSimulationPaused(scene, true);

		expect(() => stepPausedScriptSimulation(scene, 0.025)).toThrow('Script "runtime" on "Failing Script" failed during onUpdate');
		expect(engine.getDeltaTime()).toBe(13);
		expect(getScriptSimulationControl(scene)).toMatchObject({
			paused: true,
			executingManualStep: false,
			totalManualSteps: 0,
			lastError: { key: "runtime", objectId: "failing", lifecycle: "onUpdate", message: "expected fixed-step failure" },
		});
		expect(scriptsDictionary.get(target as any)?.[0].diagnostics).toMatchObject({
			onUpdateCalls: 1,
			manualOnUpdateCalls: 1,
			lastManualDeltaSeconds: 0.025,
			errorCount: 1,
		});
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(scriptsDictionary.get(target as any)?.[0].diagnostics.onUpdateCalls).toBe(1);
		scene.dispose();
		engine.dispose();
	});
});

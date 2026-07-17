import { describe, expect, test, vi } from "vitest";

import { applyScriptOnObject, scriptsDictionary } from "../../src/loading/script/apply";

describe("loading/script", () => {
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
			expect(scriptsDictionary.get(targertObject as any)?.[0].diagnostics).toEqual({ onStartCalls: 1, onUpdateCalls: 1, onStopCalls: 0, errorCount: 0, lastError: null });
			scriptsDictionary.delete(targertObject as any);
		});

		test("records lifecycle errors before preserving their original propagation", () => {
			let onStart: (() => void) | undefined;
			const scene: any = {
				onBeforeRenderObservable: {
					addOnce: (callback: () => void) => {
						onStart = callback;
						return null;
					},
					add: () => null,
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
			scriptsDictionary.delete(target as any);
		});
	});
});

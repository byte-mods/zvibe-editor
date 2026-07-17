import { describe, expect, test } from "vitest";

import { _applyScriptsForObject, _applyScriptsForObjects } from "../../src/loading/script/apply";

describe("loading/script execution order", () => {
	test("instantiates and schedules attached scripts by ascending execution order", () => {
		const calls: string[] = [];
		const scene: any = {
			onBeforeRenderObservable: {
				addOnce: (callback: () => void) => {
					callback();
					return null;
				},
				add: () => null,
			},
		};
		const object = {
			metadata: {
				scripts: [
					{ key: "late.ts", enabled: true, executionOrder: 50 },
					{ key: "early.ts", enabled: true, executionOrder: -50 },
				],
			},
		};

		_applyScriptsForObject(
			scene,
			object,
			{
				"late.ts": {
					default: class {
						public onStart(): void {
							calls.push("late");
						}
					},
				},
				"early.ts": {
					default: class {
						public onStart(): void {
							calls.push("early");
						}
					},
				},
			},
			""
		);

		expect(calls).toEqual(["early", "late"]);
	});

	test("uses project script-path overrides across different objects", () => {
		const calls: string[] = [];
		const scene: any = {
			metadata: { babylonEditorScriptExecutionOrders: { "bootstrap.ts": -100 } },
			onBeforeRenderObservable: {
				addOnce: (callback: () => void) => {
					callback();
					return null;
				},
				add: () => null,
			},
		};
		const firstObject = { metadata: { scripts: [{ key: "gameplay.ts", enabled: true, executionOrder: -50 }] } };
		const secondObject = { metadata: { scripts: [{ key: "bootstrap.ts", enabled: true, executionOrder: 100 }] } };

		_applyScriptsForObjects(
			scene,
			[firstObject, secondObject],
			{
				"gameplay.ts": {
					default: class {
						public onStart(): void {
							calls.push("gameplay");
						}
					},
				},
				"bootstrap.ts": {
					default: class {
						public onStart(): void {
							calls.push("bootstrap");
						}
					},
				},
			},
			""
		);

		expect(calls).toEqual(["bootstrap", "gameplay"]);
	});

	test("uses project-wide orders unless a scene-local override is present", () => {
		const calls: string[] = [];
		const scene: any = {
			metadata: { babylonEditorProjectScriptExecutionOrders: { "shared.ts": -100 }, babylonEditorScriptExecutionOrders: { "scene.ts": -200 } },
			onBeforeRenderObservable: { addOnce: (callback: () => void) => (callback(), null), add: () => null },
		};
		_applyScriptsForObjects(
			scene,
			[
				{
					metadata: {
						scripts: [
							{ key: "shared.ts", enabled: true, executionOrder: 100 },
							{ key: "scene.ts", enabled: true, executionOrder: 100 },
						],
					},
				},
			],
			{
				"shared.ts": {
					default: class {
						public onStart(): void {
							calls.push("shared");
						}
					},
				},
				"scene.ts": {
					default: class {
						public onStart(): void {
							calls.push("scene");
						}
					},
				},
			},
			""
		);
		expect(calls).toEqual(["scene", "shared"]);
	});
});

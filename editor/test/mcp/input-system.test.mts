import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";
import { InputActions } from "babylonjs-editor-tools";

import {
	applyInputBindingOverride,
	createInputAction,
	createInputActionBinding,
	createInputActionMap,
	createInputControlScheme,
	getInputActionTrace,
	getInputRuntime,
	getInputSystemSettings,
	listInputActionMaps,
	readInputActionRuntime,
	saveInputBindingOverrides,
	setInputAction,
	setInputRuntimeControlScheme,
	setInputSystemSettings,
	simulateInputControl,
} from "../../src/mcp/input/input";

describe("mcp/input complete system", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("authors maps/actions/composites/schemes/settings with exact revisions", () => {
		let map = createInputActionMap(scene, { name: "Player" }, options);
		expect(map).toMatchObject({ version: 2, revision: 1, name: "Player", enabled: true });
		const actionResult = createInputAction(
			scene,
			{ mapId: map.id, expectedRevision: map.revision, action: { name: "Move", type: "value", expectedControlType: "vector2" } },
			options
		);
		map = listInputActionMaps(scene).maps[0];
		expect(actionResult.mapRevision).toBe(2);
		const bindingResult = createInputActionBinding(
			scene,
			{
				mapId: map.id,
				actionId: actionResult.action.id,
				expectedRevision: map.revision,
				binding: {
					composite: {
						type: "vector2",
						parts: [
							{ name: "Up", path: "<keyboard>/keyw" },
							{ name: "Down", path: "<keyboard>/keys" },
							{ name: "Left", path: "<keyboard>/keya" },
							{ name: "Right", path: "<keyboard>/keyd" },
						],
					},
					processors: [{ type: "stickDeadzone", min: 0.1, max: 0.9 }],
				},
			},
			options
		);
		map = listInputActionMaps(scene).maps[0];
		expect(bindingResult.mapRevision).toBe(3);
		const schemeResult = createInputControlScheme(
			scene,
			{ mapId: map.id, expectedRevision: map.revision, scheme: { name: "Desktop", devices: ["keyboard", "mouse"] } },
			options
		);
		expect(schemeResult.mapRevision).toBe(4);
		const settings = getInputSystemSettings(scene).settings;
		expect(setInputSystemSettings(scene, { expectedRevision: settings.revision, changes: { updateMode: "manual", maxTraceEvents: 64 } }, options).settings).toMatchObject({
			revision: 2,
			updateMode: "manual",
			maxTraceEvents: 64,
		});
		const baseline = structuredClone(scene.metadata.babylonEditorInputActionMaps);
		expect(() => setInputAction(scene, { mapId: map.id, actionId: actionResult.action.id, expectedRevision: 1, changes: { name: "Stale" } }, options)).toThrow("stale");
		expect(scene.metadata.babylonEditorInputActionMaps).toEqual(baseline);
	});

	test("keeps legacy migration ids stable across read and exact-revision mutation", () => {
		scene.metadata = { babylonEditorInputActionMaps: [{ name: "Legacy", actions: [{ name: "Jump", bindings: ["space"] }] }] };
		const first = listInputActionMaps(scene).maps[0];
		const second = listInputActionMaps(scene).maps[0];
		expect(second).toEqual(first);
		const result = setInputAction(scene, { mapId: first.id, actionId: first.actions[0].id, expectedRevision: first.revision, changes: { name: "Leap" } }, options);
		expect(result.action.name).toBe("Leap");
		expect(result.mapRevision).toBe(2);
	});

	test("exposes runtime values, schemes, trace, devices, and saveable overrides", () => {
		const map = createInputActionMap(
			scene,
			{
				name: "Player",
				actions: [{ id: "jump", name: "Jump", bindings: [{ id: "jump-key", path: "<keyboard>/space", groups: ["Keyboard"] }] }],
				controlSchemes: [
					{ id: "keyboard", name: "Keyboard", devices: ["keyboard", "mouse"] },
					{ id: "gamepad", name: "Gamepad", devices: ["gamepad"] },
				],
			},
			options
		);
		(scene as any).inputActions = new InputActions(scene.metadata.babylonEditorInputActionMaps, new EventTarget(), scene.metadata.babylonEditorInputSystemSettings);
		expect(simulateInputControl(scene, { path: "<keyboard>/space", value: 1 }, options)).toMatchObject({ simulated: true });
		expect(readInputActionRuntime(scene, { mapId: map.id, actionId: "jump" })).toMatchObject({ phase: "performed", value: 1, isPressed: true, device: "keyboard" });
		expect(getInputRuntime(scene, { limit: 20 })).toMatchObject({ lastUsedDevice: "keyboard", maps: [{ activeControlScheme: "Keyboard" }] });
		expect(getInputActionTrace(scene, {}).events.map((event: any) => event.phase)).toEqual(["started", "performed"]);
		expect(setInputRuntimeControlScheme(scene, { mapId: map.id, schemeId: "gamepad" }, options)).toMatchObject({ controlScheme: "Gamepad" });
		expect(applyInputBindingOverride(scene, { mapId: map.id, actionId: "jump", bindingId: "jump-key", path: "<keyboard>/enter" }, options)).toMatchObject({ applied: true });
		const saved = saveInputBindingOverrides(scene);
		expect(saved.byteLength).toBeGreaterThan(0);
		expect(JSON.parse(saved.json).overrides).toEqual([{ mapId: map.id, actionId: "jump", bindingId: "jump-key", path: "<keyboard>/enter" }]);
	});
});

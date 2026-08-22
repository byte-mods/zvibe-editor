import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene } from "babylonjs";

import { InputActions } from "babylonjs-editor-tools";

import {
	createTouchControl,
	deleteTouchControl,
	getTouchControlsConfiguration,
	setTouchControl,
	setTouchControlsConfiguration,
	simulateTouchControl,
	validateTouchControls,
} from "../../src/mcp/mobile/touch-controls";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

describe("mcp/mobile touch controls", () => {
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		clearUndoRedo();
		scene = new Scene(new NullEngine());
		options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() }, mobile: { forceUpdate: vi.fn() } } } };
	});

	afterEach(() => {
		clearUndoRedo();
		scene.dispose();
	});

	test("authors exact controls with Undo/Redo and validates Input Actions bindings", () => {
		const metadataBefore = scene.metadata;
		expect(getTouchControlsConfiguration(scene)).toMatchObject({ version: 1, revision: 1, enabled: false, controls: [] });
		expect(scene.metadata).toBe(metadataBefore);
		const configured = setTouchControlsConfiguration(scene, { expectedRevision: 1, changes: { enabled: true, opacity: 0.8 } }, options);
		const created = createTouchControl(
			scene,
			{
				expectedRevision: configured.revision,
				control: { name: "Move", type: "stick", controlPath: "<touch>/move", rect: { x: 0.05, y: 0.7, width: 0.2, height: 0.2 } },
			},
			options
		);
		expect(created).toMatchObject({ configuration: { revision: 3, controls: [{ name: "Move", type: "stick" }] } });
		expect(validateTouchControls(scene)).toMatchObject({ valid: false, errors: [{ code: "unbound_control_path" }] });
		scene.metadata.babylonEditorInputActionMaps = [
			{
				version: 2,
				revision: 1,
				id: "gameplay",
				name: "Gameplay",
				enabled: true,
				actions: [
					{
						id: "move",
						name: "Move",
						type: "value",
						expectedControlType: "vector2",
						enabled: true,
						initialStateCheck: true,
						processors: [],
						interactions: [],
						bindings: [{ id: "touch", path: "<touch>/move" }],
					},
				],
				controlSchemes: [],
			},
		];
		expect(validateTouchControls(scene)).toMatchObject({ valid: true, boundControlCount: 1 });
		undo();
		expect(getTouchControlsConfiguration(scene)).toMatchObject({ revision: 2, controls: [] });
		redo();
		expect(getTouchControlsConfiguration(scene)).toMatchObject({ revision: 3, controls: [{ id: created.control.id }] });
	});

	test("updates and deletes by exact revision while rejecting surplus and stale input", () => {
		const created = createTouchControl(scene, { expectedRevision: 1, control: { name: "Jump", type: "button", controlPath: "<touch>/jump" } }, options);
		expect(() => setTouchControl(scene, { expectedRevision: 1, id: created.control.id, changes: { label: "J" } }, options)).toThrow("revision is stale");
		expect(() => setTouchControl(scene, { expectedRevision: 2, id: created.control.id, changes: { script: "bad" } }, options)).toThrow("unsupported fields");
		const updated = setTouchControl(scene, { expectedRevision: 2, id: created.control.id, changes: { label: "J", buttonValue: 0.75, rect: { x: 0.7 } } }, options);
		expect(updated.control).toMatchObject({ id: created.control.id, label: "J", buttonValue: 0.75, rect: { x: 0.7, width: created.control.rect.width } });
		expect(() => setTouchControl(scene, { expectedRevision: 3, id: created.control.id, changes: { type: "slider" } }, options)).toThrow("button or stick");
		expect(() => deleteTouchControl(scene, { expectedRevision: 3, id: created.control.id }, options)).toThrow("confirm=true");
		expect(deleteTouchControl(scene, { expectedRevision: 3, id: created.control.id, confirm: true }, options)).toMatchObject({
			deleted: true,
			configuration: { revision: 4, controls: [] },
		});
	});

	test("routes authored button and stick simulation through the active Input Actions runtime", () => {
		scene.metadata = {
			babylonEditorInputActionMaps: [
				{
					version: 2,
					revision: 1,
					id: "gameplay",
					name: "Gameplay",
					enabled: true,
					actions: [
						{
							id: "jump",
							name: "Jump",
							type: "button",
							expectedControlType: "button",
							enabled: true,
							initialStateCheck: true,
							processors: [],
							interactions: [],
							bindings: [{ id: "jump-touch", path: "<touch>/jump" }],
						},
						{
							id: "move",
							name: "Move",
							type: "value",
							expectedControlType: "vector2",
							enabled: true,
							initialStateCheck: true,
							processors: [],
							interactions: [],
							bindings: [{ id: "move-touch", path: "<touch>/move" }],
						},
					],
					controlSchemes: [],
				},
			],
		};
		(scene as any).inputActions = new InputActions(scene.metadata.babylonEditorInputActionMaps, new EventTarget());
		const jump = createTouchControl(scene, { expectedRevision: 1, control: { name: "Jump", type: "button", controlPath: "<touch>/jump" } }, options);
		const move = createTouchControl(scene, { expectedRevision: 2, control: { name: "Move", type: "stick", controlPath: "<touch>/move" } }, options);
		expect(simulateTouchControl(scene, { id: jump.control.id, phase: "press" }, options)).toMatchObject({ value: 1 });
		expect((scene as any).inputActions).toBeDefined();
		expect((scene as any).inputActions.readValue("Gameplay", "Jump")).toBe(1);
		expect(simulateTouchControl(scene, { id: move.control.id, phase: "move", value: [0.5, -0.25] }, options)).toMatchObject({ value: [0.5, -0.25] });
		expect((scene as any).inputActions.readValue("Gameplay", "Move")).toEqual([0.5, -0.25]);
		simulateTouchControl(scene, { id: jump.control.id, phase: "release" }, options);
		expect((scene as any).inputActions.readValue("Gameplay", "Jump")).toBe(0);
	});
});

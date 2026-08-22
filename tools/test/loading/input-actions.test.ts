import { afterEach, describe, expect, test, vi } from "vitest";

import { Observable } from "@babylonjs/core/Misc/observable";

import { configureInputActions, InputActions } from "../../src/loading/input-actions";

describe("InputActions gamepad bindings", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("reads gamepad button and axis action states", () => {
		vi.stubGlobal("navigator", {
			getGamepads: () => [
				{
					buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 0 ? 1 : 0 })),
					axes: [0.75, 0, 0, 0],
				},
			],
		});
		const actions = new InputActions(
			[
				{
					id: "player",
					name: "Player",
					actions: [
						{ name: "Jump", bindings: ["<gamepad>/buttonSouth"] },
						{ name: "Move", type: "value", bindings: ["<gamepad>/leftStick/x"] },
					],
				},
			],
			new EventTarget()
		);
		expect(actions.isPressed("Player", "Jump")).toBe(true);
		expect(actions.getValue("Player", "Move")).toBe(0.75);
	});

	test("filters bindings by an active persisted control scheme", () => {
		vi.stubGlobal("navigator", {
			getGamepads: () => [{ buttons: Array.from({ length: 16 }, (_, index) => ({ value: index === 0 ? 1 : 0 })), axes: [0, 0, 0, 0] }],
		});
		const target = new EventTarget();
		const actions = new InputActions(
			[
				{
					id: "player",
					name: "Player",
					controlSchemes: [
						{ name: "Keyboard", devices: ["keyboard"] },
						{ name: "Gamepad", devices: ["gamepad"] },
					],
					actions: [{ name: "Jump", bindings: ["<keyboard>/space", "<gamepad>/buttonSouth"] }],
				},
			],
			target
		);
		const keyDown = new Event("keydown");
		Object.assign(keyDown, { key: " ", code: "Space" });
		target.dispatchEvent(keyDown);
		expect(actions.isPressed("Player", "Jump")).toBe(true);
		const keyUp = new Event("keyup");
		Object.assign(keyUp, { key: " ", code: "Space" });
		target.dispatchEvent(keyUp);
		expect(actions.isPressed("Player", "Jump")).toBe(false);
		expect(actions.setControlScheme("Player", "Gamepad")).toBe(true);
		expect(actions.getControlScheme("Player")).toBe("Gamepad");
		expect(actions.isPressed("Player", "Jump")).toBe(true);
		expect(actions.setControlScheme("Player", "Missing")).toBe(false);
	});

	test("reads touch press and normalized touch-position action values", () => {
		vi.stubGlobal("innerWidth", 200);
		vi.stubGlobal("innerHeight", 100);
		const target = new EventTarget();
		const actions = new InputActions(
			[
				{
					id: "mobile",
					name: "Mobile",
					controlSchemes: [{ name: "Touch", devices: ["touch"] }],
					actions: [
						{ name: "Tap", bindings: ["<touch>/press"] },
						{ name: "Horizontal", type: "value", bindings: ["<touch>/position/x"] },
						{ name: "Vertical", type: "value", bindings: ["<touch>/position/y"] },
					],
				},
			],
			target
		);
		const pointerDown = new Event("pointerdown");
		Object.assign(pointerDown, { pointerType: "touch", clientX: 50, clientY: 75 });
		target.dispatchEvent(pointerDown);
		expect(actions.isPressed("Mobile", "Tap")).toBe(true);
		expect(actions.getValue("Mobile", "Horizontal")).toBe(0.25);
		expect(actions.getValue("Mobile", "Vertical")).toBe(0.75);
		const pointerUp = new Event("pointerup");
		Object.assign(pointerUp, { pointerType: "touch", clientX: 50, clientY: 75 });
		target.dispatchEvent(pointerUp);
		expect(actions.isPressed("Mobile", "Tap")).toBe(false);
	});

	test("accepts clamped deterministic touch simulation for preview hosts", () => {
		const actions = new InputActions(
			[
				{
					id: "mobile",
					name: "Mobile",
					actions: [
						{ name: "Tap", bindings: ["<touch>/press"] },
						{ name: "Horizontal", bindings: ["<touch>/position/x"] },
					],
				},
			],
			new EventTarget()
		);
		expect(actions.simulateTouch(true, 1.5, -0.2)).toBe(true);
		expect(actions.isPressed("Mobile", "Tap")).toBe(true);
		expect(actions.getValue("Mobile", "Horizontal")).toBe(1);
		expect(actions.simulateTouch(false, Number.NaN, 0)).toBe(false);
	});

	test("captures the next keyboard key as an interactive action rebind", async () => {
		const target = new EventTarget();
		const actions = new InputActions([{ id: "player", name: "Player", actions: [{ name: "Jump", bindings: ["<keyboard>/space"] }] }], target);
		const rebind = actions.rebindNextKey("Player", "Jump");
		const keyDown = new Event("keydown");
		Object.assign(keyDown, { key: "q", code: "KeyQ" });
		target.dispatchEvent(keyDown);
		expect(await rebind).toBe("<keyboard>/keyq");
		expect(actions.getMaps()[0].actions[0].bindings.map((binding) => binding.path)).toEqual(["<keyboard>/keyq"]);
	});

	test("captures the next gamepad button as an interactive action rebind", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { getGamepads: () => [{ buttons: [{ value: 0 }, { value: 0.8 }], axes: [0, 0] }] });
		const actions = new InputActions([{ id: "player", name: "Player", actions: [{ name: "Fire", bindings: ["<keyboard>/space"] }] }], new EventTarget());
		const rebind = actions.rebindNextGamepad("Player", "Fire");
		await vi.advanceTimersByTimeAsync(20);
		expect(await rebind).toBe("<gamepad>/button1");
		expect(actions.getMaps()[0].actions[0].bindings.map((binding) => binding.path)).toEqual(["<gamepad>/button1"]);
		vi.useRealTimers();
	});

	test("captures the next touch press as an interactive action rebind", async () => {
		const target = new EventTarget();
		const actions = new InputActions(
			[
				{
					id: "mobile",
					name: "Mobile",
					actions: [
						{ name: "Tap", bindings: ["<keyboard>/space"] },
						{ name: "Vertical", bindings: [] },
					],
				},
			],
			target
		);
		const rebind = actions.rebindNextTouch("Mobile", "Tap");
		const pointerDown = new Event("pointerdown");
		Object.assign(pointerDown, { pointerType: "touch", clientX: 10, clientY: 20 });
		target.dispatchEvent(pointerDown);
		expect(await rebind).toBe("<touch>/press");
		expect(actions.getMaps()[0].actions[0].bindings.map((binding) => binding.path)).toEqual(["<touch>/press"]);
		const axisRebind = actions.rebindNextTouch("Mobile", "Vertical", undefined, "position/y");
		target.dispatchEvent(pointerDown);
		expect(await axisRebind).toBeNull();
		expect(actions.getMaps()[0].actions[1].bindings).toEqual([]);
	});

	test("preserves signed axes and evaluates normalized 2D composites", () => {
		vi.stubGlobal("navigator", { getGamepads: () => [{ index: 0, id: "Pad", connected: true, mapping: "standard", buttons: [], axes: [-0.75, 0.5, 0, 0] }] });
		const actions = new InputActions(
			[
				{
					id: "player",
					name: "Player",
					actions: [
						{ name: "Steer", type: "value", expectedControlType: "axis", processors: [{ type: "invert" }], bindings: ["<gamepad>/leftStick/x"] },
						{
							name: "Move",
							type: "value",
							expectedControlType: "vector2",
							bindings: [
								{
									id: "wasd",
									composite: {
										type: "vector2",
										parts: [
											{ name: "Up", path: "<keyboard>/keyw" },
											{ name: "Down", path: "<keyboard>/keys" },
											{ name: "Left", path: "<keyboard>/keya" },
											{ name: "Right", path: "<keyboard>/keyd" },
										],
									},
								},
							],
						},
					],
				},
			],
			new EventTarget()
		);
		expect(actions.getValue("Player", "Steer")).toBeCloseTo(0.75);
		actions.simulateControl("<keyboard>/keyw", 1);
		actions.simulateControl("<keyboard>/keyd", 1);
		expect(actions.getVector2("Player", "Move")[0]).toBeCloseTo(Math.SQRT1_2);
		expect(actions.getVector2("Player", "Move")[1]).toBeCloseTo(Math.SQRT1_2);
	});

	test("emits hold phases, traces them, and preserves non-destructive overrides", () => {
		const target = new EventTarget();
		const authored = [
			{
				id: "player",
				name: "Player",
				actions: [
					{
						id: "charge",
						name: "Charge",
						type: "button" as const,
						interactions: [{ type: "hold" as const, duration: 0.25 }],
						bindings: [{ id: "charge-key", path: "<keyboard>/space" }],
					},
				],
			},
		];
		const actions = new InputActions(authored, target);
		const keyDown = new Event("keydown");
		Object.assign(keyDown, { key: " ", code: "Space" });
		target.dispatchEvent(keyDown);
		actions.update(0.3);
		const keyUp = new Event("keyup");
		Object.assign(keyUp, { key: " ", code: "Space" });
		target.dispatchEvent(keyUp);
		expect(actions.getTrace().events.map((event) => event.phase)).toEqual(["started", "performed", "canceled"]);

		expect(actions.applyBindingOverride("Player", "Charge", "charge-key", "<keyboard>/enter")).toBe(true);
		const overrides = actions.saveBindingOverrides();
		expect(actions.getMaps()[0].actions[0].bindings[0].path).toBe("<keyboard>/enter");
		const restored = new InputActions(authored, new EventTarget());
		expect(restored.loadBindingOverrides(overrides)).toBe(1);
		expect(restored.getMaps()[0].actions[0].bindings[0].path).toBe("<keyboard>/enter");
		expect(restored.clearBindingOverride("Player", "Charge", "charge-key")).toBe(true);
		expect(restored.getMaps()[0].actions[0].bindings[0].path).toBe("<keyboard>/space");
	});

	test("runtime enable overrides authored state and honors initial-state suppression", () => {
		const actions = new InputActions(
			[
				{
					id: "player",
					name: "Player",
					enabled: false,
					actions: [{ id: "jump", name: "Jump", initialStateCheck: false, bindings: [{ id: "jump-key", path: "<keyboard>/space" }] }],
				},
			],
			new EventTarget()
		);
		actions.simulateControl("<keyboard>/space", 1);
		expect(actions.isPressed("Player", "Jump")).toBe(false);
		expect(actions.setMapEnabled("Player", true)).toBe(true);
		expect(actions.isPressed("Player", "Jump")).toBe(true);
		expect(actions.getTrace().events).toEqual([]);
		actions.clearSimulatedControl("<keyboard>/space");
		expect(actions.getTrace().events).toEqual([]);
		actions.simulateControl("<keyboard>/space", 1);
		expect(actions.getTrace().events.map((event) => event.phase)).toEqual(["started", "performed"]);
		expect(actions.setActionEnabled("Player", "Jump", false)).toBe(true);
		expect(actions.getActionState("Player", "Jump")?.phase).toBe("disabled");
	});

	test("configures fixed update through the animation fallback and disposes scene ownership", () => {
		vi.stubGlobal("addEventListener", vi.fn());
		vi.stubGlobal("removeEventListener", vi.fn());
		const beforeAnimations = new Observable<void>();
		const onDispose = new Observable<void>();
		const scene: any = {
			metadata: {
				babylonEditorInputActionMaps: [{ name: "Player", actions: [{ name: "Jump", bindings: ["space"] }] }],
				babylonEditorInputSystemSettings: { updateMode: "fixed" },
			},
			onBeforeAnimationsObservable: beforeAnimations,
			onDisposeObservable: onDispose,
			getEngine: () => ({ getDeltaTime: () => 16 }),
		};
		const runtime = configureInputActions(scene)!;
		expect(scene.inputActions).toBe(runtime);
		expect(beforeAnimations.observers).toHaveLength(1);
		beforeAnimations.notifyObservers();
		onDispose.notifyObservers();
		expect(beforeAnimations.hasObservers()).toBe(false);
		expect(globalThis.removeEventListener).toHaveBeenCalled();
	});

	test("reads mouse vectors and supports runtime map disabling", () => {
		vi.stubGlobal("innerWidth", 200);
		vi.stubGlobal("innerHeight", 100);
		const target = new EventTarget();
		const actions = new InputActions(
			[{ id: "player", name: "Player", actions: [{ name: "Look", type: "passThrough", expectedControlType: "vector2", bindings: ["<mouse>/delta"] }] }],
			target
		);
		const move = new Event("mousemove");
		Object.assign(move, { clientX: 50, clientY: 25, movementX: -5, movementY: 3 });
		target.dispatchEvent(move);
		expect(actions.getVector2("Player", "Look")).toEqual([-5, 3]);
		expect(actions.setMapEnabled("Player", false)).toBe(true);
		expect(actions.getActionState("Player", "Look")).toMatchObject({ enabled: false, phase: "disabled" });
	});
});

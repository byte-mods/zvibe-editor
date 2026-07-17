import { afterEach, describe, expect, test, vi } from "vitest";

import { InputActions } from "../../src/loading/input-actions";

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
		expect(actions.getMaps()[0].actions[0].bindings).toEqual(["<keyboard>/keyq"]);
	});

	test("captures the next gamepad button as an interactive action rebind", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { getGamepads: () => [{ buttons: [{ value: 0 }, { value: 0.8 }], axes: [0, 0] }] });
		const actions = new InputActions([{ id: "player", name: "Player", actions: [{ name: "Fire", bindings: ["<keyboard>/space"] }] }], new EventTarget());
		const rebind = actions.rebindNextGamepad("Player", "Fire");
		await vi.advanceTimersByTimeAsync(20);
		expect(await rebind).toBe("<gamepad>/button1");
		expect(actions.getMaps()[0].actions[0].bindings).toEqual(["<keyboard>/space", "<gamepad>/button1"]);
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
		expect(actions.getMaps()[0].actions[0].bindings).toEqual(["<keyboard>/space", "<touch>/press"]);
		const axisRebind = actions.rebindNextTouch("Mobile", "Vertical", undefined, "position/y");
		target.dispatchEvent(pointerDown);
		expect(await axisRebind).toBe("<touch>/position/y");
		expect(actions.getMaps()[0].actions[1].bindings).toEqual(["<touch>/position/y"]);
	});
});

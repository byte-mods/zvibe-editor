import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { simulateInputTouch } from "../../src/mcp/input/input";

describe("mcp/input touch simulation", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("delegates normalized touch state to an active preview runtime", () => {
		const simulateTouch = vi.fn(() => true);
		(scene as any).inputActions = { simulateTouch };
		expect(simulateInputTouch(scene, { pressed: true, x: 1.5, y: -0.5 })).toEqual({ simulated: true, pressed: true, x: 1, y: 0 });
		expect(simulateTouch).toHaveBeenCalledWith(true, 1.5, -0.5);
	});

	test("requires an active preview runtime", () => {
		expect(() => simulateInputTouch(scene, {})).toThrow("runtime is not active");
	});
});

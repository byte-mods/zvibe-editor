import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene } from "babylonjs";
import { createInputActionMap, generateInputActionWrapper } from "../../src/mcp/input/input";

describe("mcp/input-wrapper", () => {
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
	test("generates deterministic TypeScript map/action constants", () => {
		createInputActionMap(scene, { name: "Player Controls", actions: [{ name: "Jump" }, { name: "Move Left" }] }, options);
		const source = generateInputActionWrapper(scene, { mapName: "Player Controls" }).source;
		expect(source).toContain('export const Player_ControlsMap = "Player Controls" as const;');
		expect(source).toContain('Move_Left: "Move Left"');
	});
});

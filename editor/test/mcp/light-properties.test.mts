import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Color3, HemisphericLight, NullEngine, Scene, Vector3 } from "babylonjs";

import { setLightProperties } from "../../src/mcp/lights/lights";

describe("mcp/light-properties", () => {
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
		vi.clearAllMocks();
	});

	test("coerces inspector color arrays instead of corrupting Babylon color properties", () => {
		const light = new HemisphericLight("Moon", Vector3.Down(), scene);

		setLightProperties(scene, { nodeId: light.id, properties: { groundColor: [0.03, 0.02, 0.11], intensity: 0.62 } }, options);

		expect(light.groundColor).toBeInstanceOf(Color3);
		expect(light.groundColor.asArray()).toEqual([0.03, 0.02, 0.11]);
		expect(light.intensity).toBe(0.62);
	});
});

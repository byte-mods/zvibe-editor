import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Camera, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { get2DSceneMode, set2DSceneMode } from "../../src/mcp/scene/scene";

describe("mcp/scene-2d", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates and persists an orthographic 2D camera configuration", () => {
		const enabled = set2DSceneMode(scene, { enabled: true, orthographicSize: 200, aspectRatio: 1.5 }, options);
		expect(enabled).toMatchObject({ enabled: true, orthographicSize: 200, aspectRatio: 1.5 });
		expect(scene.activeCamera?.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
		expect(scene.activeCamera?.orthoLeft).toBe(-300);
		expect(scene.activeCamera?.orthoTop).toBe(200);
		expect(get2DSceneMode(scene)).toEqual(enabled);

		const disabled = set2DSceneMode(scene, { enabled: false }, options);
		expect(disabled.enabled).toBe(false);
		expect(scene.activeCamera?.mode).toBe(Camera.PERSPECTIVE_CAMERA);
	});
});

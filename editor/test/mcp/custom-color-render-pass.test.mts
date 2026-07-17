import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { createCustomColorPostProcess, disposeCustomColorPostProcess, parseCustomColorPostProcess, serializeCustomColorPostProcess } from "../../src/editor/rendering/custom-color";

describe("editor/rendering/custom-color", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const editor = { layout: { preview: { scene: null } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		disposeCustomColorPostProcess();
		scene.dispose();
		engine.dispose();
	});

	test("creates and serializes a configurable custom color render pass", () => {
		expect(createCustomColorPostProcess(editor)).toBeTruthy();
		parseCustomColorPostProcess(editor, { tint: [1, 0.5, 0.25], tintStrength: 0.6, saturation: 0.8, contrast: 1.2, brightness: -0.1 });
		expect(serializeCustomColorPostProcess()).toEqual({ tint: [1, 0.5, 0.25], tintStrength: 0.6, saturation: 0.8, contrast: 1.2, brightness: -0.1 });
	});
});

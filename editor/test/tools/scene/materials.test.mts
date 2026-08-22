import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene, StandardMaterial } from "babylonjs";

import { forceCompileAllSceneMaterials } from "../../../src/tools/scene/materials";

describe("tools/scene/materials", () => {
	let engine: NullEngine;
	let scene: Scene;
	let material: StandardMaterial;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
		scene = new Scene(engine);
		material = new StandardMaterial("Surface", scene);
		MeshBuilder.CreateBox("Box", {}, scene).material = material;
	});

	afterEach(() => {
		if (!scene.isDisposed) {
			scene.dispose();
		}
		engine.dispose();
		vi.restoreAllMocks();
	});

	test("releases an outstanding material compilation when its scene is disposed", async () => {
		vi.spyOn(material, "forceCompilationAsync").mockImplementation(() => new Promise<void>(() => undefined));

		const compilation = forceCompileAllSceneMaterials(scene);
		await Promise.resolve();
		scene.dispose();

		await expect(compilation).resolves.toBeUndefined();
	});

	test("propagates a material compilation failure while the scene remains active", async () => {
		vi.spyOn(material, "forceCompilationAsync").mockRejectedValue(new Error("shader compile failed"));

		await expect(forceCompileAllSceneMaterials(scene)).rejects.toThrow("shader compile failed");
	});
});

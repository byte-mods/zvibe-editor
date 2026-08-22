import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NodeMaterial, NullEngine, Scene } from "babylonjs";

import { deleteMaterial } from "../../src/mcp/materials/materials";

describe("material deletion selection cleanup", () => {
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

	test("moves a directly selected material back to the Scene Inspector before disposal", async () => {
		const material = new NodeMaterial("Selected", scene);
		const setEditedObject = vi.fn((_object: unknown, onChanged?: () => void) => onChanged?.());
		const forceUpdate = vi.fn();
		const options = { editor: { layout: { inspector: { state: { editedObject: material }, setEditedObject, forceUpdate } } } } as never;

		await expect(deleteMaterial(scene, { materialId: material.id }, options)).resolves.toMatchObject({ deleted: true, id: material.id });
		expect(setEditedObject).toHaveBeenCalledWith(scene, expect.any(Function));
		expect(scene.materials).not.toContain(material);
		expect(forceUpdate).toHaveBeenCalledOnce();
	});

	test("supports external deletion while the lazy Inspector panel is not mounted", async () => {
		const material = new NodeMaterial("Headless", scene);
		const options = { editor: { layout: { inspector: undefined } } } as never;

		await expect(deleteMaterial(scene, { materialId: material.id }, options)).resolves.toMatchObject({ deleted: true, id: material.id });
		expect(scene.materials).not.toContain(material);
	});
});

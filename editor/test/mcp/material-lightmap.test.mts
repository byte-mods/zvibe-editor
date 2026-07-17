import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, PBRMaterial, Scene, Texture } from "babylonjs";

import { getMaterialLightmap, setMaterialLightmap } from "../../src/mcp/materials/materials";

describe("mcp/material-lightmap", () => {
	let engine: NullEngine;
	let scene: Scene;
	let material: PBRMaterial;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		material = new PBRMaterial("Baked Wall", scene);
		material.lightmapTexture = new Texture("lightmap.png", scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reads, configures, and clears baked-lightmap consumption", () => {
		expect(setMaterialLightmap(scene, { materialId: material.id, coordinatesIndex: 1, level: 0.75, useLightmapAsShadowmap: true }, options)).toMatchObject({
			lightmapTexture: { coordinatesIndex: 1, level: 0.75 },
			useLightmapAsShadowmap: true,
		});
		expect(getMaterialLightmap(scene, { materialId: material.id }).lightmapTexture).toMatchObject({ name: "lightmap.png" });
		expect(setMaterialLightmap(scene, { materialId: material.id, texturePath: null }, options)).toMatchObject({ lightmapTexture: null });
	});

	test("requires an assigned lightmap before texture settings", () => {
		material.lightmapTexture?.dispose();
		material.lightmapTexture = null;
		expect(() => setMaterialLightmap(scene, { materialId: material.id, coordinatesIndex: 1 }, options)).toThrow("Assign a lightmap");
	});
});

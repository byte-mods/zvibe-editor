import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";
import { TerrainMaterial } from "babylonjs-materials";

vi.mock("babylonjs-editor-tools", () => ({}));

import { setMaterialProperties } from "../../src/mcp/materials/materials";
import { addTerrainMaterial } from "../../src/project/add/material";

describe("mcp/terrain-material", () => {
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

	test("creates a Babylon TerrainMaterial and exposes its layer controls through MCP material properties", () => {
		const material = addTerrainMaterial(scene);
		material.name = "Landscape";
		expect(material).toBeInstanceOf(TerrainMaterial);
		expect(material.getClassName()).toBe("TerrainMaterial");

		const result = setMaterialProperties(scene, { materialId: material.id, properties: { specularPower: 12, "diffuseColor.r": 0.5, disableLighting: true } }, options);
		expect(result).toMatchObject({ id: material.id, className: "TerrainMaterial" });
		expect(material.specularPower).toBe(12);
		expect(material.diffuseColor.r).toBe(0.5);
		expect(material.disableLighting).toBe(true);
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PBRMaterial, Scene, StandardMaterial, NullEngine } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { applyMaterialPreset, createMaterialPreset, deleteMaterialPreset, listMaterialPresets } from "../../src/mcp/materials/materials";

describe("mcp/material-presets", () => {
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

	test("captures curated PBR inspector values and reapplies them to another PBR material", () => {
		const source = new PBRMaterial("Source", scene);
		source.albedoColor.set(0.1, 0.2, 0.3);
		source.metallic = 0.8;
		source.roughness = 0.15;
		const target = new PBRMaterial("Target", scene);
		target.metallic = 0;
		target.roughness = 1;
		const preset = createMaterialPreset(scene, { materialId: source.id, name: "Metal" }, options);
		expect(preset).toMatchObject({ name: "Metal", className: "PBRMaterial", properties: { albedoColor: [0.1, 0.2, 0.3], metallic: 0.8, roughness: 0.15 } });
		applyMaterialPreset(scene, { materialId: target.id, name: "Metal" }, options);
		expect(target.albedoColor.asArray()).toEqual([0.1, 0.2, 0.3]);
		expect(target.metallic).toBe(0.8);
		expect(target.roughness).toBe(0.15);
		expect(listMaterialPresets(scene).presets).toHaveLength(1);
		expect(deleteMaterialPreset(scene, { name: "Metal" }, options)).toEqual({ deleted: true, name: "Metal" });
	});

	test("rejects duplicate names and class-incompatible preset application", () => {
		const pbr = new PBRMaterial("PBR", scene);
		const standard = new StandardMaterial("Standard", scene);
		createMaterialPreset(scene, { materialId: pbr.id, name: "PBR Preset" }, options);
		expect(() => createMaterialPreset(scene, { materialId: pbr.id, name: "PBR Preset" }, options)).toThrow("already exists");
		expect(() => applyMaterialPreset(scene, { materialId: standard.id, name: "PBR Preset" }, options)).toThrow("not StandardMaterial");
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Color3, NullEngine, PBRMaterial, Scene } from "babylonjs";

import { getMaterialVariant, rebaseMaterialVariant, setMaterialProperties } from "../../src/mcp/materials/materials";

describe("mcp/material variants", () => {
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

	test("rebases curated inherited properties while retaining tracked overrides", async () => {
		const base = new PBRMaterial("Base", scene);
		base.albedoColor = new Color3(0.2, 0.3, 0.4);
		base.metallic = 0.1;
		base.roughness = 0.8;
		const variant = base.clone("Variant")!;
		variant.metadata = { babylonEditorMaterialVariant: { baseMaterialId: base.id, overrides: { roughness: 0.15 } } };
		setMaterialProperties(scene, { materialId: variant.id, properties: { roughness: 0.25 } }, options);
		base.albedoColor = new Color3(0.9, 0.8, 0.7);
		base.metallic = 0.6;
		base.roughness = 0.95;

		const result = await rebaseMaterialVariant(scene, { materialId: variant.id }, options);
		expect(variant.albedoColor).toEqual(new Color3(0.9, 0.8, 0.7));
		expect(variant.metallic).toBe(0.6);
		expect(variant.roughness).toBe(0.25);
		expect(result).toMatchObject({ rebased: true, baseMaterialId: base.id, overrides: { roughness: 0.25 } });
		expect(getMaterialVariant(scene, { materialId: variant.id }).overrides).toEqual({ roughness: 0.25 });
	});
});

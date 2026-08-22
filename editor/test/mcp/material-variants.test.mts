import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { Color3, NullEngine, PBRMaterial, Scene, Texture } from "babylonjs";

import { clearMaterialVariantOverrides, createMaterialVariant, getMaterialVariant, rebaseMaterialVariant, setMaterialProperties } from "../../src/mcp/materials/materials";
import { projectConfiguration } from "../../src/project/configuration";

function materialState(material: PBRMaterial): Record<string, any> {
	const state = structuredClone(material.serialize());
	for (const key of ["name", "id", "uniqueId", "metadata", "tags", "customType"]) delete state[key];
	return state;
}

describe("mcp/material variants", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() }, inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

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

	test("creates every persisted variant with a scene-unique identity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "material-variant-"));
		const previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		try {
			const base = new PBRMaterial("Base", scene);
			base.id = "stable-base-id";
			const middle = await createMaterialVariant(scene, { baseMaterialId: base.id, name: "Middle" }, options);
			const leaf = await createMaterialVariant(scene, { baseMaterialId: middle.id, name: "Leaf" }, options);
			expect(new Set([base.id, middle.id, leaf.id]).size).toBe(3);
			expect(getMaterialVariant(scene, { materialId: leaf.id }).chain.map((entry: any) => entry.name)).toEqual(["Leaf", "Middle", "Base"]);
		} finally {
			projectConfiguration.path = previousPath;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("inherits complete serializable properties and textures and clears exact overrides", async () => {
		const base = new PBRMaterial("Base", scene);
		base.albedoTexture = new Texture("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", scene);
		base.albedoTexture.uScale = 1;
		base.forceIrradianceInFragment = false;
		const variant = base.clone("Variant")!;
		variant.metadata = {
			babylonEditorMaterialVariant: {
				version: 2,
				baseMaterialId: base.id,
				overrides: { roughness: 0.2 },
				baseSnapshot: materialState(base),
			},
		};
		variant.roughness = 0.2;
		base.albedoTexture.uScale = 4;
		base.forceIrradianceInFragment = true;
		base.roughness = 0.9;

		const inspected = getMaterialVariant(scene, { materialId: variant.id });
		expect(inspected.inheritedChangedPaths).toEqual(expect.arrayContaining(["albedoTexture.uScale", "forceIrradianceInFragment", "roughness"]));
		expect(inspected.conflicts).toEqual([]);
		await rebaseMaterialVariant(scene, { materialId: variant.id, expectedFingerprint: inspected.fingerprint }, options);
		expect(variant.albedoTexture?.uScale).toBe(4);
		expect(variant.forceIrradianceInFragment).toBe(true);
		expect(variant.roughness).toBe(0.2);

		await clearMaterialVariantOverrides(scene, { materialId: variant.id, paths: ["roughness"] }, options);
		expect(variant.roughness).toBe(0.9);
		expect(getMaterialVariant(scene, { materialId: variant.id }).overridePaths).toEqual([]);
	});

	test("detects three-way conflicts and resolves them with exact stale protection", async () => {
		const base = new PBRMaterial("Base", scene);
		base.metallic = 0.1;
		const variant = base.clone("Variant")!;
		variant.metadata = {
			babylonEditorMaterialVariant: { version: 2, baseMaterialId: base.id, overrides: {}, baseSnapshot: materialState(base) },
		};
		base.metallic = 0.8;
		variant.metallic = 0.4;

		const inspected = getMaterialVariant(scene, { materialId: variant.id });
		expect(inspected.conflicts).toMatchObject([{ path: "metallic", previousBaseValue: 0.1, currentBaseValue: 0.8, variantValue: 0.4 }]);
		await expect(rebaseMaterialVariant(scene, { materialId: variant.id, expectedFingerprint: inspected.fingerprint }, options)).rejects.toThrow("unresolved conflict");
		await expect(rebaseMaterialVariant(scene, { materialId: variant.id, expectedFingerprint: "0".repeat(64), conflictPolicy: "keepVariant" }, options)).rejects.toThrow(
			"changed after inspection"
		);
		const result = await rebaseMaterialVariant(scene, { materialId: variant.id, expectedFingerprint: inspected.fingerprint, conflictPolicy: "keepVariant" }, options);
		expect(variant.metallic).toBe(0.4);
		expect(result.overrides.metallic).toBe(0.4);
		expect(result.resolvedConflicts).toEqual([{ path: "metallic", resolution: "keepVariant" }]);
	});

	test("rebases nested variants root-to-leaf and rejects inheritance cycles", async () => {
		const root = new PBRMaterial("Root", scene);
		root.metallic = 0.1;
		const middle = root.clone("Middle")!;
		middle.metadata = { babylonEditorMaterialVariant: { version: 2, baseMaterialId: root.id, overrides: {}, baseSnapshot: materialState(root) } };
		const leaf = middle.clone("Leaf")!;
		leaf.metadata = { babylonEditorMaterialVariant: { version: 2, baseMaterialId: middle.id, overrides: { roughness: 0.3 }, baseSnapshot: materialState(middle) } };
		leaf.roughness = 0.3;
		root.metallic = 0.75;

		const inspected = getMaterialVariant(scene, { materialId: leaf.id });
		expect(inspected.chain.map((entry: any) => entry.name)).toEqual(["Leaf", "Middle", "Root"]);
		await rebaseMaterialVariant(scene, { materialId: leaf.id, expectedFingerprint: inspected.fingerprint, recursive: true }, options);
		expect(middle.metallic).toBe(0.75);
		expect(leaf.metallic).toBe(0.75);
		expect(leaf.roughness).toBe(0.3);

		root.metadata = { babylonEditorMaterialVariant: { version: 2, baseMaterialId: leaf.id, overrides: {}, baseSnapshot: materialState(leaf) } };
		expect(() => getMaterialVariant(scene, { materialId: leaf.id })).toThrow("inheritance cycle");
	});
});

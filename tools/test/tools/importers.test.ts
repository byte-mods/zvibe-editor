import { describe, expect, test } from "vitest";

import {
	getDefaultAssetImporterConfiguration,
	inferAssetImporterKind,
	listAssetImporterDefinitions,
	normalizeAssetImporterConfiguration,
	validateAssetImporterConfiguration,
} from "../../src/assets/importers";

describe("asset importer contracts", () => {
	test("classifies all supported importer families and returns isolated definitions", () => {
		expect(["hero.png", "hero.glb", "theme.ogg", "intro.webm", "ui.woff2", "metal.material", "walk.animation", "level.custom"].map(inferAssetImporterKind)).toEqual([
			"texture",
			"model",
			"audio",
			"video",
			"font",
			"material",
			"animation",
			"custom",
		]);
		const first = listAssetImporterDefinitions();
		first[0].fields[0].label = "changed";
		expect(listAssetImporterDefinitions()[0].fields[0].label).toBe("Include In Build");
	});

	test("migrates legacy texture settings while preserving unknown extension data", () => {
		expect(normalizeAssetImporterConfiguration("hero.png", { maxSize: 1024, compression: "high", pluginFlag: "keep" })).toMatchObject({
			version: 1,
			kind: "texture",
			settings: { includeInBuild: true, maxSize: 1024, compression: "high" },
			extra: { pluginFlag: "keep" },
		});
	});

	test("validates bounds, enums, importer identity, and texture power-of-two sizes", () => {
		const defaults = getDefaultAssetImporterConfiguration("hero.png");
		expect(validateAssetImporterConfiguration("hero.png", { ...defaults, settings: { ...defaults.settings, maxSize: 2048, textureType: "normalMap" } }).valid).toBe(true);
		expect(() => validateAssetImporterConfiguration("hero.png", { ...defaults, settings: { ...defaults.settings, maxSize: 1000 } })).toThrow("power of two");
		expect(() => validateAssetImporterConfiguration("hero.png", { ...defaults, settings: { ...defaults.settings, textureType: "invalid" } })).toThrow("must be one of");
		expect(() => validateAssetImporterConfiguration("hero.png", { version: 1, kind: "audio", settings: getDefaultAssetImporterConfiguration("audio").settings })).toThrow(
			"require the texture importer"
		);
	});

	test("validates and defaults Unity-style model hierarchy optimization settings", () => {
		const defaults = getDefaultAssetImporterConfiguration("hero.glb");
		expect(defaults.settings).toMatchObject({ animationType: "generic", optimizeGameObjects: false, exposedTransforms: "" });
		expect(
			validateAssetImporterConfiguration("hero.glb", {
				...defaults,
				settings: { ...defaults.settings, optimizeGameObjects: true, exposedTransforms: "Armature/Hips/RightHand\nArmature/Hips/Head" },
			}).configuration.settings
		).toMatchObject({ optimizeGameObjects: true, exposedTransforms: "Armature/Hips/RightHand\nArmature/Hips/Head" });
		expect(() => validateAssetImporterConfiguration("hero.glb", { ...defaults, settings: { ...defaults.settings, exposedTransforms: "x".repeat(4097) } })).toThrow("too long");
	});

	test("rejects unknown typed settings but keeps valid bounded custom importer settings", () => {
		const texture = getDefaultAssetImporterConfiguration("texture");
		expect(() => validateAssetImporterConfiguration("hero.png", { ...texture, settings: { ...texture.settings, unknown: true } })).toThrow(
			"Unsupported texture importer setting"
		);
		const custom = getDefaultAssetImporterConfiguration("file.xyz");
		expect(
			validateAssetImporterConfiguration("file.xyz", { ...custom, settings: { ...custom.settings, importerId: "studio.mesh-v2" } }).configuration.settings.importerId
		).toBe("studio.mesh-v2");
		expect(() => validateAssetImporterConfiguration("file.xyz", { ...custom, settings: { ...custom.settings, importerId: "bad id" } })).toThrow("Importer ID");
	});
});

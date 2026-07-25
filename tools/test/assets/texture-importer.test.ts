import { afterEach, describe, expect, test, vi } from "vitest";

import {
	normalizeTextureImporterSettings,
	textureImporterEffectiveColorSpace,
	textureImporterEncodingOptions,
	textureImporterOutputExtension,
} from "../../src/assets/texture-importer";
import {
	normalizeTextureImporterPlatformOverrides,
	resolveTextureImporterPlatformSettings,
	serializeTextureImporterPlatformOverrides,
} from "../../src/assets/texture-platform-overrides";
import { configureImportedTextures } from "../../src/loading/texture";

describe("texture importer contract", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("normalizes execution settings and maps portable formats and compression", () => {
		const settings = normalizeTextureImporterSettings({
			textureType: "normalMap",
			colorSpace: "sRGB",
			alphaSource: "none",
			generateMipmaps: true,
			maxSize: 1024,
			resizeAlgorithm: "bicubic",
			compression: "high",
			readable: true,
		});
		expect(settings).toMatchObject({ textureType: "normalMap", maxSize: 1024, compression: "high", readable: true });
		expect(textureImporterEffectiveColorSpace(settings)).toBe("linear");
		expect(textureImporterOutputExtension("assets/source.jpeg")).toBe(".jpg");
		expect(textureImporterOutputExtension("assets/source.svg")).toBe(".png");
		expect(textureImporterEncodingOptions("high")).toEqual({ quality: 96, compressionLevel: 9, lossless: false });
	});

	test("strictly normalizes and resolves Web/Desktop texture overrides", () => {
		const overrides = normalizeTextureImporterPlatformOverrides({
			web: { enabled: true, maxSize: 512, compression: "low", generateMipmaps: false },
			desktop: { enabled: false, readable: true },
		});
		const settings = normalizeTextureImporterSettings({
			textureType: "default",
			colorSpace: "sRGB",
			alphaSource: "input",
			generateMipmaps: true,
			maxSize: 4096,
			resizeAlgorithm: "lanczos3",
			compression: "high",
			readable: false,
			platformOverrides: serializeTextureImporterPlatformOverrides(overrides),
		});
		expect(resolveTextureImporterPlatformSettings(settings, "web")).toMatchObject({
			platform: "web",
			overrideApplied: true,
			settings: { maxSize: 512, compression: "low", generateMipmaps: false, readable: false },
		});
		expect(resolveTextureImporterPlatformSettings(settings, "electron")).toMatchObject({
			platform: "desktop",
			overrideApplied: false,
			settings: { maxSize: 4096, readable: false },
		});
		expect(() => normalizeTextureImporterPlatformOverrides({ mobile: { enabled: true } })).toThrow("Unsupported texture importer platform");
		expect(() => normalizeTextureImporterPlatformOverrides({ web: { enabled: true, maxSize: 300 } })).toThrow("power of two");
		expect(() => normalizeTextureImporterPlatformOverrides({ web: { enabled: true, mystery: true } })).toThrow("Unsupported texture platform override setting");
	});

	test("applies build redirects and sampling semantics before final scene readiness", async () => {
		const updateURL = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					version: 1,
					outputPath: "assets/normal.png",
					textureType: "normalMap",
					colorSpace: "linear",
					alphaSource: "none",
					generateMipmaps: true,
					readableBitmapPath: null,
					readableDescriptorPath: null,
					mipmaps: [],
				}),
			}))
		);
		const texture = { name: "assets/normal.bmp", url: "assets/normal.bmp", gammaSpace: true, metadata: null, updateURL };
		const applied = await configureImportedTextures({ textures: [texture] } as any, "/scene/");
		expect(applied).toBe(1);
		expect(texture.gammaSpace).toBe(false);
		expect(texture.metadata).toMatchObject({ babylonEditorTextureImporter: { textureType: "normalMap" } });
		expect(updateURL).toHaveBeenCalledWith("/scene/assets/normal.png");
	});

	test("retains KTX2 build selection while resolving importer metadata from the authored texture path", async () => {
		const updateURL = vi.fn();
		const fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				version: 1,
				outputPath: "assets/albedo.png",
				textureType: "default",
				colorSpace: "sRGB",
				alphaSource: "input",
				generateMipmaps: true,
				readableBitmapPath: null,
				readableDescriptorPath: null,
				mipmaps: [],
			}),
		}));
		vi.stubGlobal("fetch", fetch);
		const texture = {
			name: "assets/albedo.ktx2",
			url: "/scene/assets/albedo.ktx2",
			gammaSpace: false,
			metadata: { babylonEditorAuthoredTexturePath: "assets/albedo.bmp" },
			updateURL,
		};
		const applied = await configureImportedTextures({ textures: [texture] } as any, "/scene/");
		expect(applied).toBe(1);
		expect(fetch).toHaveBeenCalledWith("/scene/assets/albedo.bmp.bjstexture.json");
		expect(texture.gammaSpace).toBe(true);
		expect(updateURL).not.toHaveBeenCalled();
	});
});

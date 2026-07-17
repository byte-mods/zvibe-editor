import { afterEach, describe, expect, test, vi } from "vitest";

import {
	normalizeTextureImporterSettings,
	textureImporterEffectiveColorSpace,
	textureImporterEncodingOptions,
	textureImporterOutputExtension,
} from "../../src/assets/texture-importer";
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

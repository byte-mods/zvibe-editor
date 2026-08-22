import { afterEach, describe, expect, test, vi } from "vitest";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";

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
		expect(settings).toMatchObject({
			outputFormat: "automatic",
			alphaIsTransparency: false,
			nonPowerOfTwo: "none",
			mipmapFilter: "kaiser",
			filterMode: "trilinear",
			wrapModeU: "repeat",
			wrapModeV: "repeat",
			anisoLevel: 1,
			normalMapSource: "color",
			spritePixelsPerUnit: 100,
		});
		expect(textureImporterEffectiveColorSpace(settings)).toBe("linear");
		expect(textureImporterOutputExtension("assets/source.jpeg")).toBe(".jpg");
		expect(textureImporterOutputExtension("assets/source.svg")).toBe(".png");
		expect(textureImporterOutputExtension("assets/source.png", { outputFormat: "webp" })).toBe(".webp");
		expect(textureImporterOutputExtension("assets/source.exr", { outputFormat: "webp" })).toBe(".exr");
		expect(textureImporterEncodingOptions("high")).toEqual({ quality: 96, compressionLevel: 9, lossless: false });
		expect(() => normalizeTextureImporterSettings({ maxSize: 300 })).toThrow("power of two");
		expect(() => normalizeTextureImporterSettings({ anisoLevel: 17 })).toThrow("anisoLevel");
		expect(() => normalizeTextureImporterSettings({ generateMipmaps: "false" })).toThrow("generateMipmaps must be a boolean");
	});

	test("strictly normalizes and resolves Web/Desktop texture overrides", () => {
		const overrides = normalizeTextureImporterPlatformOverrides({
			web: { enabled: true, outputFormat: "webp", maxSize: 512, compression: "low", generateMipmaps: false },
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
			settings: { outputFormat: "webp", maxSize: 512, compression: "low", generateMipmaps: false, readable: false },
		});
		expect(resolveTextureImporterPlatformSettings(settings, "ios")).toMatchObject({
			platform: "web",
			overrideApplied: true,
			settings: { outputFormat: "webp", maxSize: 512, compression: "low" },
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
		const updateSamplingMode = vi.fn();
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
		const texture = {
			name: "assets/normal.bmp",
			url: "assets/normal.bmp",
			gammaSpace: true,
			metadata: null,
			wrapU: -1,
			wrapV: -1,
			anisotropicFilteringLevel: -1,
			updateURL,
			updateSamplingMode,
		};
		const applied = await configureImportedTextures({ textures: [texture] } as any, "/scene/");
		expect(applied).toBe(1);
		expect(texture.gammaSpace).toBe(false);
		expect(texture.metadata).toMatchObject({ babylonEditorTextureImporter: { version: 2, textureType: "normalMap", filterMode: "trilinear" } });
		expect(updateURL).toHaveBeenCalledWith("/scene/assets/normal.png");
		expect(updateSamplingMode).toHaveBeenCalledWith(Texture.TRILINEAR_SAMPLINGMODE);
		expect(texture).toMatchObject({ wrapU: Texture.WRAP_ADDRESSMODE, wrapV: Texture.WRAP_ADDRESSMODE, anisotropicFilteringLevel: 1 });
	});

	test("applies strict v2 point sampling, independent wrap axes, and anisotropy", async () => {
		const updateSamplingMode = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					version: 2,
					outputPath: "assets/sprite.webp",
					textureType: "sprite",
					colorSpace: "sRGB",
					alphaSource: "grayscale",
					generateMipmaps: false,
					filterMode: "point",
					wrapModeU: "clamp",
					wrapModeV: "mirror",
					anisoLevel: 8,
					sprite: { pixelsPerUnit: 64, meshType: "tight", extrude: 2, bounds: { x: 1, y: 2, width: 3, height: 4 } },
					processing: {
						outputFormat: "webp",
						maxSizeApplied: false,
						nonPowerOfTwoApplied: true,
						fullMipChain: true,
						alphaDerivedFromGrayscale: true,
						transparentColorsDilated: true,
						normalMapGenerated: false,
						mipmapCoveragePreserved: false,
					},
				}),
			}))
		);
		const texture = {
			name: "assets/sprite.png",
			url: "assets/sprite.png",
			gammaSpace: false,
			metadata: null,
			wrapU: -1,
			wrapV: -1,
			anisotropicFilteringLevel: -1,
			updateURL: vi.fn(),
			updateSamplingMode,
		};
		expect(await configureImportedTextures({ textures: [texture] } as any, "/scene/")).toBe(1);
		expect(texture).toMatchObject({ gammaSpace: true, wrapU: Texture.CLAMP_ADDRESSMODE, wrapV: Texture.MIRROR_ADDRESSMODE, anisotropicFilteringLevel: 8 });
		expect(updateSamplingMode).toHaveBeenCalledWith(Texture.NEAREST_SAMPLINGMODE);
		expect(texture.metadata).toMatchObject({ babylonEditorTextureImporter: { sprite: { pixelsPerUnit: 64 }, processing: { nonPowerOfTwoApplied: true } } });
	});

	test("rejects malformed v2 sampler state instead of partially applying it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					version: 2,
					outputPath: "assets/bad.png",
					textureType: "default",
					colorSpace: "sRGB",
					alphaSource: "input",
					generateMipmaps: true,
					filterMode: "trilinear",
					wrapModeU: "repeat",
					wrapModeV: "repeat",
					anisoLevel: 17,
					sprite: null,
					processing: {
						outputFormat: "png",
						maxSizeApplied: false,
						nonPowerOfTwoApplied: false,
						fullMipChain: true,
						alphaDerivedFromGrayscale: false,
						transparentColorsDilated: false,
						normalMapGenerated: false,
						mipmapCoveragePreserved: false,
					},
				}),
			}))
		);
		const updateURL = vi.fn();
		const updateSamplingMode = vi.fn();
		const texture = { name: "assets/bad.png", url: "assets/bad.png", gammaSpace: false, metadata: null, updateURL, updateSamplingMode };
		expect(await configureImportedTextures({ textures: [texture] } as any, "/scene/")).toBe(0);
		expect(updateURL).not.toHaveBeenCalled();
		expect(updateSamplingMode).not.toHaveBeenCalled();
	});

	test("does not probe importer sidecars for runtime textures or paths outside the canonical assets root", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const scene = {
			textures: [
				{ name: "sun_CSMShadowMap", url: "sun_CSMShadowMap" },
				{ name: "race/legacy.png", url: "race/legacy.png" },
				{ name: "assets/country.env", url: "assets/country.env" },
				{ name: "assets/reflection.dds", url: "assets/reflection.dds" },
			],
		};

		expect(await configureImportedTextures(scene as any, "/scene/")).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
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

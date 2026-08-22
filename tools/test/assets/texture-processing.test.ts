import { describe, expect, test } from "vitest";

import { normalizeTextureImporterSettings } from "../../src/assets/texture-importer";
import {
	preserveTextureImporterAlphaCoverage,
	textureImporterAlphaCoverage,
	textureImporterMipmapDimensions,
	textureImporterOutputDimensions,
	textureImporterSpriteMetadata,
	transformTextureImporterPixels,
} from "../../src/assets/texture-processing";

describe("texture importer processing policy", () => {
	test("applies Max Size before each Unity-style NPOT policy", () => {
		const base = normalizeTextureImporterSettings({ maxSize: 4096 });
		expect(textureImporterOutputDimensions(8000, 4000, base)).toEqual({ width: 4096, height: 2048 });
		expect(textureImporterOutputDimensions(300, 100, { ...base, nonPowerOfTwo: "toNearest" })).toEqual({ width: 256, height: 128 });
		expect(textureImporterOutputDimensions(300, 100, { ...base, nonPowerOfTwo: "toLarger" })).toEqual({ width: 512, height: 128 });
		expect(textureImporterOutputDimensions(300, 100, { ...base, nonPowerOfTwo: "toSmaller" })).toEqual({ width: 256, height: 64 });
	});

	test("generates a complete non-square mip chain through 1x1", () => {
		expect(textureImporterMipmapDimensions(8, 4)).toEqual([
			{ width: 4, height: 2 },
			{ width: 2, height: 1 },
			{ width: 1, height: 1 },
		]);
		expect(textureImporterMipmapDimensions(1, 1)).toEqual([]);
	});

	test("derives grayscale alpha and dilates transparent edge colors deterministically", () => {
		const settings = normalizeTextureImporterSettings({ alphaSource: "input", alphaIsTransparency: true });
		const result = transformTextureImporterPixels(new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]), 3, 1, settings);
		expect(Array.from(result.pixels)).toEqual([255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0]);
		expect(result.transparentColorsDilated).toBe(true);

		const grayscale = transformTextureImporterPixels(new Uint8Array([255, 255, 255, 1, 0, 0, 0, 255]), 2, 1, {
			...settings,
			alphaSource: "grayscale",
			alphaIsTransparency: false,
		});
		expect([grayscale.pixels[3], grayscale.pixels[7]]).toEqual([255, 0]);
		expect(grayscale.alphaDerivedFromGrayscale).toBe(true);
	});

	test("converts flat height data to neutral tangent-space normals", () => {
		const settings = normalizeTextureImporterSettings({ textureType: "normalMap", normalMapSource: "height" });
		const result = transformTextureImporterPixels(new Uint8Array([64, 64, 64, 255, 64, 64, 64, 255, 64, 64, 64, 255, 64, 64, 64, 255]), 2, 2, settings);
		expect(Array.from(result.pixels)).toEqual([128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255]);
		expect(result.normalMapGenerated).toBe(true);
	});

	test("preserves requested alpha-test coverage without changing RGB", () => {
		const pixels = new Uint8Array([9, 8, 7, 64, 6, 5, 4, 0]);
		const result = preserveTextureImporterAlphaCoverage(pixels, 0.5, 0.5);
		expect(textureImporterAlphaCoverage(pixels, 0.5)).toBe(0.5);
		expect(Array.from(pixels.filter((_value, index) => index % 4 !== 3))).toEqual([9, 8, 7, 6, 5, 4]);
		expect(result.adjusted).toBe(true);
	});

	test("derives extruded tight sprite bounds from either integer or float alpha", () => {
		const settings = normalizeTextureImporterSettings({ textureType: "sprite", spritePixelsPerUnit: 32, spriteMeshType: "tight", spriteExtrude: 1 });
		const pixels = new Float32Array(4 * 3 * 4);
		pixels[(1 * 4 + 2) * 4 + 3] = 0.5;
		expect(textureImporterSpriteMetadata(pixels, 4, 3, settings)).toEqual({
			pixelsPerUnit: 32,
			meshType: "tight",
			extrude: 1,
			bounds: { x: 1, y: 0, width: 3, height: 3 },
		});
	});
});

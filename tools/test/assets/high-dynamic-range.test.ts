import { describe, expect, it } from "vitest";

import {
	convertHighDynamicRangePanoramaToCubeFaces,
	decodeOpenExr,
	decodeRadianceHdr,
	defaultCubeFaceSize,
	encodeOpenExr,
	encodeRadianceHdr,
	executeHighDynamicRangeTextureImport,
	IHighDynamicRangeImage,
	isEquirectangularPanorama,
	resizeHighDynamicRange,
	toneMapHighDynamicRange,
} from "../../src/assets/high-dynamic-range";
import { normalizeTextureImporterSettings } from "../../src/assets/texture-importer";

function image(width: number, height: number): IHighDynamicRangeImage {
	const pixels = new Float32Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 4;
			pixels[offset] = x + 0.25;
			pixels[offset + 1] = y + 0.5;
			pixels[offset + 2] = x + y + 1;
			pixels[offset + 3] = (x + 1) / width;
		}
	}
	return {
		format: "exr",
		width,
		height,
		channels: 4,
		hasAlpha: true,
		pixelType: "float32",
		compression: "raw",
		pixels,
		statistics: { minimum: [0, 0, 0, 0], maximum: [0, 0, 0, 0], average: [0, 0, 0, 0], nonFiniteCount: 0 },
	};
}

describe("high-dynamic-range assets", () => {
	it("round-trips raw and scanline-RLE Radiance RGBE while preserving orientation", () => {
		const source = image(8, 2);
		for (const useRle of [false, true]) {
			const encoded = encodeRadianceHdr(source, useRle);
			const decoded = decodeRadianceHdr(encoded);
			expect(decoded).toMatchObject({ format: "hdr", width: 8, height: 2, channels: 3, hasAlpha: false, pixelType: "rgbe8" });
			expect(decoded.pixels[0]).toBeCloseTo(0.25, 2);
			expect(decoded.pixels[1]).toBeCloseTo(0.5, 2);
			expect(decoded.pixels[8 * 4 + 1]).toBeCloseTo(1.5, 2);
		}
	});

	it("round-trips a deterministic uncompressed FLOAT RGBA OpenEXR", async () => {
		const source = image(3, 2);
		const encoded = encodeOpenExr(source);
		const decoded = await decodeOpenExr(encoded);
		expect(decoded).toMatchObject({ format: "exr", width: 3, height: 2, channels: 4, hasAlpha: true, pixelType: "float32", compression: "raw" });
		expect(Array.from(decoded.pixels)).toEqual(Array.from(source.pixels));
	});

	it("uses the requested high-quality kernel for aspect-safe float resizing", () => {
		const source = image(8, 4);
		const resized = resizeHighDynamicRange(source, 4, "lanczos3");
		expect(resized.width).toBe(4);
		expect(resized.height).toBe(2);
		expect(resized.pixels).toHaveLength(32);
		expect(resized.statistics.maximum[0]).toBeGreaterThan(resized.statistics.minimum[0]);
	});

	it("executes NPOT, height-normal, alpha-edge, and complete-mip policies without leaving float precision", async () => {
		const source = image(3, 2);
		for (let offset = 3; offset < source.pixels.length; offset += 4) {
			source.pixels[offset] = offset === 3 ? 1 : 0;
		}
		const executed = await executeHighDynamicRangeTextureImport(
			encodeOpenExr(source),
			"exr",
			normalizeTextureImporterSettings({
				textureType: "normalMap",
				normalMapSource: "height",
				alphaIsTransparency: true,
				nonPowerOfTwo: "toLarger",
				generateMipmaps: true,
			})
		);
		expect(executed).toMatchObject({
			output: { width: 4, height: 2, pixelType: "float32" },
			resized: true,
			transparentColorsDilated: true,
			normalMapGenerated: true,
		});
		expect(executed.mipmaps.map((mipmap) => [mipmap.image.width, mipmap.image.height])).toEqual([
			[2, 1],
			[1, 1],
		]);
	});

	it("creates six finite cubemap faces from a 2:1 panorama", () => {
		const source = image(8, 4);
		expect(isEquirectangularPanorama(source.width, source.height)).toBe(true);
		expect(defaultCubeFaceSize(source.width, source.height)).toBe(16);
		const faces = convertHighDynamicRangePanoramaToCubeFaces(source, 16);
		expect(faces.map((face) => face.face)).toEqual(["px", "nx", "py", "ny", "pz", "nz"]);
		expect(faces.every((face) => face.pixels.length === 16 * 16 * 4 && face.pixels.every(Number.isFinite))).toBe(true);
	});

	it("produces bounded tone-mapped RGBA8 preview pixels", () => {
		const source = image(2, 1);
		source.pixels[0] = Number.POSITIVE_INFINITY;
		source.pixels[1] = -5;
		const preview = toneMapHighDynamicRange(source.pixels);
		expect(preview).toHaveLength(8);
		expect(Array.from(preview)).toEqual(expect.arrayContaining([0, 255]));
	});

	it("rejects malformed Radiance headers, scanlines, and trailing bytes", () => {
		expect(() => decodeRadianceHdr(new TextEncoder().encode("not hdr\n"))).toThrow(/signature/i);
		const valid = encodeRadianceHdr(image(8, 1));
		expect(() => decodeRadianceHdr(valid.subarray(0, valid.length - 1))).toThrow(/truncated|exceeds/i);
		const trailing = new Uint8Array(valid.length + 1);
		trailing.set(valid);
		expect(() => decodeRadianceHdr(trailing)).toThrow(/trailing byte/i);
	});

	it("rejects unsafe OpenEXR versions, offset tables, and unsupported layouts before decoding", async () => {
		const valid = encodeOpenExr(image(2, 2));
		const badVersion = valid.slice();
		badVersion[4] = 3;
		await expect(decodeOpenExr(badVersion)).rejects.toThrow(/version 3/i);
		const multipart = valid.slice();
		multipart[5] |= 0x10;
		await expect(decodeOpenExr(multipart)).rejects.toThrow(/multipart/i);
		await expect(decodeOpenExr(valid.subarray(0, valid.length - 5))).rejects.toThrow(/exceeds|truncated|outside/i);
	});
});

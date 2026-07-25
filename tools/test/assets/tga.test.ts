import { describe, expect, test } from "vitest";

import { decodeTga, inspectTga } from "../../src/assets/tga";

function header(options: {
	width: number;
	height: number;
	imageType: number;
	pixelDepth: number;
	descriptor?: number;
	colorMapType?: number;
	colorMapFirst?: number;
	colorMapLength?: number;
	colorMapDepth?: number;
}): Uint8Array {
	const bytes = new Uint8Array(18);
	bytes[1] = options.colorMapType ?? 0;
	bytes[2] = options.imageType;
	bytes[3] = (options.colorMapFirst ?? 0) & 0xff;
	bytes[4] = (options.colorMapFirst ?? 0) >> 8;
	bytes[5] = (options.colorMapLength ?? 0) & 0xff;
	bytes[6] = (options.colorMapLength ?? 0) >> 8;
	bytes[7] = options.colorMapDepth ?? 0;
	bytes[12] = options.width & 0xff;
	bytes[13] = options.width >> 8;
	bytes[14] = options.height & 0xff;
	bytes[15] = options.height >> 8;
	bytes[16] = options.pixelDepth;
	bytes[17] = options.descriptor ?? 0;
	return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

describe("bounded TGA decoder", () => {
	test("normalizes an uncompressed bottom-left 24-bit image to top-left RGBA8", () => {
		const source = concat(header({ width: 2, height: 2, imageType: 2, pixelDepth: 24 }), new Uint8Array([255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0]));
		expect(inspectTga(source)).toMatchObject({ width: 2, height: 2, kind: "trueColor", rle: false, topOrigin: false, channels: 3, hasAlpha: false });
		expect([...decodeTga(source).pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
	});

	test("decodes RLE BGRA with a top-right origin and preserves alpha", () => {
		const source = concat(header({ width: 3, height: 1, imageType: 10, pixelDepth: 32, descriptor: 0x38 }), new Uint8Array([0x81, 0, 255, 0, 64, 0x00, 0, 0, 255, 255]));
		const decoded = decodeTga(source);
		expect(decoded).toMatchObject({ rle: true, rightOrigin: true, channels: 4, hasAlpha: true });
		expect([...decoded.pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 64, 0, 255, 0, 64]);
	});

	test("resolves a non-zero color-map origin and grayscale alpha", () => {
		const mapped = concat(
			header({ width: 2, height: 1, imageType: 1, pixelDepth: 8, descriptor: 0x20, colorMapType: 1, colorMapFirst: 5, colorMapLength: 2, colorMapDepth: 24 }),
			new Uint8Array([0, 0, 255, 0, 255, 0, 5, 6])
		);
		expect([...decodeTga(mapped).pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);

		const grayscale = concat(header({ width: 1, height: 1, imageType: 3, pixelDepth: 16, descriptor: 0x28 }), new Uint8Array([127, 32]));
		expect(decodeTga(grayscale)).toMatchObject({ channels: 2, hasAlpha: true, pixels: new Uint8Array([127, 127, 127, 32]) });
	});

	test("rejects packet overruns, invalid indices, interleaving, and unsupported depth", () => {
		expect(() => decodeTga(concat(header({ width: 1, height: 1, imageType: 10, pixelDepth: 24 }), new Uint8Array([0x81, 0, 0, 0])))).toThrow(
			"exceeds the declared pixel count"
		);
		expect(() =>
			decodeTga(
				concat(
					header({ width: 1, height: 1, imageType: 1, pixelDepth: 8, colorMapType: 1, colorMapFirst: 5, colorMapLength: 1, colorMapDepth: 24 }),
					new Uint8Array([0, 0, 0, 4])
				)
			)
		).toThrow("outside 5..5");
		expect(() => inspectTga(header({ width: 1, height: 1, imageType: 2, pixelDepth: 24, descriptor: 0x40 }))).toThrow("interleaving");
		expect(() => inspectTga(header({ width: 1, height: 1, imageType: 2, pixelDepth: 12 }))).toThrow("true-color depth 12");
	});
});

export type TgaImageKind = "colorMapped" | "trueColor" | "grayscale";

export interface ITgaImageInfo {
	width: number;
	height: number;
	pixelDepth: number;
	channels: number;
	hasAlpha: boolean;
	kind: TgaImageKind;
	rle: boolean;
	topOrigin: boolean;
	rightOrigin: boolean;
}

export interface IDecodedTgaImage extends ITgaImageInfo {
	pixels: Uint8Array;
}

const TGA_HEADER_BYTES = 18;
const MAXIMUM_TGA_PIXELS = 67_108_864;
const MAXIMUM_TGA_COLOR_MAP_ENTRIES = 65_536;

function assertRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
		throw new Error(`Malformed TGA: ${label} exceeds the source byte range.`);
	}
}

function readUint16(bytes: Uint8Array, offset: number): number {
	assertRange(bytes, offset, 2, "16-bit field");
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function imageKind(imageType: number): { kind: TgaImageKind; rle: boolean } {
	switch (imageType) {
		case 1:
			return { kind: "colorMapped", rle: false };
		case 2:
			return { kind: "trueColor", rle: false };
		case 3:
			return { kind: "grayscale", rle: false };
		case 9:
			return { kind: "colorMapped", rle: true };
		case 10:
			return { kind: "trueColor", rle: true };
		case 11:
			return { kind: "grayscale", rle: true };
		default:
			throw new Error(`Unsupported TGA image type ${imageType}; supported types are color-mapped, true-color, grayscale, and their RLE variants.`);
	}
}

function bytesPerPixel(bits: number, label: string): number {
	if (!Number.isInteger(bits) || bits <= 0 || bits % 8 !== 0) {
		throw new Error(`Unsupported TGA ${label} depth ${bits}; byte-aligned pixels are required.`);
	}
	return bits / 8;
}

function decodeBgr555(value: number, alpha: boolean): [number, number, number, number] {
	const expand = (component: number): number => Math.round((component * 255) / 31);
	return [expand((value >> 10) & 31), expand((value >> 5) & 31), expand(value & 31), alpha ? ((value & 0x8000) !== 0 ? 255 : 0) : 255];
}

function decodePaletteEntry(bytes: Uint8Array, offset: number, bits: number): [number, number, number, number] {
	switch (bits) {
		case 15:
			return decodeBgr555(readUint16(bytes, offset), false);
		case 16:
			return decodeBgr555(readUint16(bytes, offset), true);
		case 24:
			assertRange(bytes, offset, 3, "24-bit color-map entry");
			return [bytes[offset + 2], bytes[offset + 1], bytes[offset], 255];
		case 32:
			assertRange(bytes, offset, 4, "32-bit color-map entry");
			return [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]];
		default:
			throw new Error(`Unsupported TGA color-map entry depth ${bits}; expected 15, 16, 24, or 32 bits.`);
	}
}

function parseInfo(bytes: Uint8Array): ITgaImageInfo & {
	idLength: number;
	colorMapType: number;
	colorMapFirst: number;
	colorMapLength: number;
	colorMapDepth: number;
	imageType: number;
	alphaBits: number;
} {
	assertRange(bytes, 0, TGA_HEADER_BYTES, "header");
	const idLength = bytes[0];
	const colorMapType = bytes[1];
	const imageType = bytes[2];
	const { kind, rle } = imageKind(imageType);
	const colorMapFirst = readUint16(bytes, 3);
	const colorMapLength = readUint16(bytes, 5);
	const colorMapDepth = bytes[7];
	const width = readUint16(bytes, 12);
	const height = readUint16(bytes, 14);
	const pixelDepth = bytes[16];
	const descriptor = bytes[17];
	const alphaBits = descriptor & 0x0f;

	if (width === 0 || height === 0 || width * height > MAXIMUM_TGA_PIXELS) {
		throw new Error(`Unsupported TGA dimensions ${width}x${height}; decoded images are limited to ${MAXIMUM_TGA_PIXELS.toLocaleString()} pixels.`);
	}
	if ((descriptor & 0xc0) !== 0) {
		throw new Error("Unsupported TGA interleaving mode; only non-interleaved images can be imported.");
	}
	if (colorMapType !== 0 && colorMapType !== 1) {
		throw new Error(`Unsupported TGA color-map type ${colorMapType}.`);
	}
	if (kind === "colorMapped") {
		if (colorMapType !== 1 || colorMapLength === 0 || colorMapLength > MAXIMUM_TGA_COLOR_MAP_ENTRIES) {
			throw new Error("Malformed TGA: color-mapped images require a bounded non-empty color map.");
		}
		if (pixelDepth !== 8 && pixelDepth !== 16) {
			throw new Error(`Unsupported TGA color-map index depth ${pixelDepth}; expected 8 or 16 bits.`);
		}
	} else if (colorMapType !== 0) {
		throw new Error("Malformed TGA: true-color and grayscale images must not declare a color map.");
	}
	if (kind === "trueColor" && ![15, 16, 24, 32].includes(pixelDepth)) {
		throw new Error(`Unsupported TGA true-color depth ${pixelDepth}; expected 15, 16, 24, or 32 bits.`);
	}
	if (kind === "grayscale" && pixelDepth !== 8 && pixelDepth !== 16) {
		throw new Error(`Unsupported TGA grayscale depth ${pixelDepth}; expected 8 or 16 bits.`);
	}
	if (alphaBits > 8) {
		throw new Error(`Unsupported TGA alpha depth ${alphaBits}; at most 8 attribute bits are supported.`);
	}

	const channels = kind === "grayscale" ? (pixelDepth === 16 ? 2 : 1) : pixelDepth === 32 || (pixelDepth === 16 && alphaBits > 0) ? 4 : 3;
	return {
		width,
		height,
		pixelDepth,
		channels,
		hasAlpha: channels === 2 || channels === 4,
		kind,
		rle,
		topOrigin: (descriptor & 0x20) !== 0,
		rightOrigin: (descriptor & 0x10) !== 0,
		idLength,
		colorMapType,
		colorMapFirst,
		colorMapLength,
		colorMapDepth,
		imageType,
		alphaBits,
	};
}

/** Reads bounded TGA metadata without decoding the pixel stream. */
export function inspectTga(bytes: Uint8Array): ITgaImageInfo {
	const {
		idLength: _idLength,
		colorMapType: _colorMapType,
		colorMapFirst: _colorMapFirst,
		colorMapLength: _colorMapLength,
		colorMapDepth: _colorMapDepth,
		imageType: _imageType,
		alphaBits: _alphaBits,
		...info
	} = parseInfo(bytes);
	return info;
}

/** Decodes supported uncompressed/RLE TGA variants into top-left-origin RGBA8 pixels. */
export function decodeTga(bytes: Uint8Array): IDecodedTgaImage {
	const parsed = parseInfo(bytes);
	const colorMapEntryBytes = parsed.colorMapLength > 0 ? Math.ceil(parsed.colorMapDepth / 8) : 0;
	const colorMapOffset = TGA_HEADER_BYTES + parsed.idLength;
	const colorMapBytes = parsed.colorMapLength * colorMapEntryBytes;
	assertRange(bytes, TGA_HEADER_BYTES, parsed.idLength, "image ID");
	if (parsed.colorMapLength > 0) {
		if (![15, 16, 24, 32].includes(parsed.colorMapDepth)) {
			throw new Error(`Unsupported TGA color-map entry depth ${parsed.colorMapDepth}; expected 15, 16, 24, or 32 bits.`);
		}
		assertRange(bytes, colorMapOffset, colorMapBytes, "color map");
	}
	let offset = colorMapOffset + colorMapBytes;
	const sourcePixelBytes = parsed.pixelDepth === 15 ? 2 : bytesPerPixel(parsed.pixelDepth, "pixel");
	const pixelCount = parsed.width * parsed.height;
	const output = new Uint8Array(pixelCount * 4);

	const readPixel = (): [number, number, number, number] => {
		assertRange(bytes, offset, sourcePixelBytes, "pixel data");
		let rgba: [number, number, number, number];
		if (parsed.kind === "colorMapped") {
			const index = sourcePixelBytes === 1 ? bytes[offset] : readUint16(bytes, offset);
			const relativeIndex = index - parsed.colorMapFirst;
			if (relativeIndex < 0 || relativeIndex >= parsed.colorMapLength) {
				throw new Error(`Malformed TGA: color-map index ${index} is outside ${parsed.colorMapFirst}..${parsed.colorMapFirst + parsed.colorMapLength - 1}.`);
			}
			rgba = decodePaletteEntry(bytes, colorMapOffset + relativeIndex * colorMapEntryBytes, parsed.colorMapDepth);
		} else if (parsed.kind === "grayscale") {
			rgba = [bytes[offset], bytes[offset], bytes[offset], sourcePixelBytes === 2 ? bytes[offset + 1] : 255];
		} else if (parsed.pixelDepth === 15 || parsed.pixelDepth === 16) {
			rgba = decodeBgr555(readUint16(bytes, offset), parsed.pixelDepth === 16 && parsed.alphaBits > 0);
		} else {
			rgba = [bytes[offset + 2], bytes[offset + 1], bytes[offset], sourcePixelBytes === 4 ? bytes[offset + 3] : 255];
		}
		offset += sourcePixelBytes;
		return rgba;
	};

	const writePixel = (sourceIndex: number, rgba: [number, number, number, number]): void => {
		if (sourceIndex >= pixelCount) {
			throw new Error("Malformed TGA: pixel packets exceed the declared dimensions.");
		}
		const sourceX = sourceIndex % parsed.width;
		const sourceY = Math.floor(sourceIndex / parsed.width);
		const x = parsed.rightOrigin ? parsed.width - sourceX - 1 : sourceX;
		const y = parsed.topOrigin ? sourceY : parsed.height - sourceY - 1;
		output.set(rgba, (y * parsed.width + x) * 4);
	};

	if (parsed.rle) {
		let decodedCount = 0;
		while (decodedCount < pixelCount) {
			assertRange(bytes, offset, 1, "RLE packet header");
			const header = bytes[offset++];
			const count = (header & 0x7f) + 1;
			if (decodedCount + count > pixelCount) {
				throw new Error("Malformed TGA: an RLE packet exceeds the declared pixel count.");
			}
			if ((header & 0x80) !== 0) {
				const pixel = readPixel();
				for (let i = 0; i < count; ++i) {
					writePixel(decodedCount++, pixel);
				}
			} else {
				for (let i = 0; i < count; ++i) {
					writePixel(decodedCount++, readPixel());
				}
			}
		}
	} else {
		for (let i = 0; i < pixelCount; ++i) {
			writePixel(i, readPixel());
		}
	}

	const {
		idLength: _idLength,
		colorMapType: _colorMapType,
		colorMapFirst: _colorMapFirst,
		colorMapLength: _colorMapLength,
		colorMapDepth: _colorMapDepth,
		imageType: _imageType,
		alphaBits: _alphaBits,
		...info
	} = parsed;
	return { ...info, pixels: output };
}

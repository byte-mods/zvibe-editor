import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
	ASEPRITE_ATLAS_MODEL,
	bindAsepriteExternalTilesets,
	buildAsepriteAtlas,
	createAsepriteAtlasJson,
	normalizeAsepriteImporterSettings,
	parseAseprite,
	renderAsepriteFrame,
	summarizeAsepriteDocument,
} from "../../src/assets/aseprite";

class Writer {
	private readonly _bytes: number[] = [];

	public u8(value: number): this {
		this._bytes.push(value & 255);
		return this;
	}

	public u16(value: number): this {
		return this.u8(value).u8(value >>> 8);
	}

	public i16(value: number): this {
		return this.u16(value & 0xffff);
	}

	public u32(value: number): this {
		return this.u8(value)
			.u8(value >>> 8)
			.u8(value >>> 16)
			.u8(value >>> 24);
	}

	public i32(value: number): this {
		return this.u32(value >>> 0);
	}

	public fixed(value: number): this {
		return this.i32(Math.round(value * 65_536));
	}

	public string(value: string): this {
		const bytes = new TextEncoder().encode(value);
		this.u16(bytes.byteLength).bytes(bytes);
		return this;
	}

	public bytes(value: Uint8Array | number[]): this {
		this._bytes.push(...value);
		return this;
	}

	public zeroes(count: number): this {
		this._bytes.push(...new Array(count).fill(0));
		return this;
	}

	public value(): Uint8Array {
		return Uint8Array.from(this._bytes);
	}
}

function chunk(type: number, content: Uint8Array): Uint8Array {
	return new Writer()
		.u32(content.byteLength + 6)
		.u16(type)
		.bytes(content)
		.value();
}

function layer(
	name: string,
	options: { type?: number; childLevel?: number; visible?: boolean; opacity?: number; blendMode?: number; tilesetIndex?: number; background?: boolean; reference?: boolean } = {}
): Uint8Array {
	const flags = (options.visible === false ? 0 : 1) | 2 | (options.background ? 8 : 0) | (options.reference ? 64 : 0);
	const content = new Writer()
		.u16(flags)
		.u16(options.type ?? 0)
		.u16(options.childLevel ?? 0)
		.u16(0)
		.u16(0)
		.u16(options.blendMode ?? 0)
		.u8(options.opacity ?? 255)
		.zeroes(3)
		.string(name);
	if (options.type === 2) {
		content.u32(options.tilesetIndex ?? 0);
	}
	return chunk(0x2004, content.value());
}

function imageCel(
	layerIndex: number,
	x: number,
	y: number,
	width: number,
	height: number,
	pixels: Uint8Array,
	options: { compressed?: boolean; opacity?: number } = {}
): Uint8Array {
	const encoded = options.compressed ? zlibSync(pixels) : pixels;
	return chunk(
		0x2005,
		new Writer()
			.u16(layerIndex)
			.i16(x)
			.i16(y)
			.u8(options.opacity ?? 255)
			.u16(options.compressed ? 2 : 0)
			.i16(0)
			.zeroes(5)
			.u16(width)
			.u16(height)
			.bytes(encoded)
			.value()
	);
}

function linkedCel(layerIndex: number, frameIndex: number, x: number, y: number): Uint8Array {
	return chunk(0x2005, new Writer().u16(layerIndex).i16(x).i16(y).u8(255).u16(1).i16(0).zeroes(5).u16(frameIndex).value());
}

function celExtra(x: number, y: number, width: number, height: number): Uint8Array {
	return chunk(0x2006, new Writer().u32(1).fixed(x).fixed(y).fixed(width).fixed(height).zeroes(16).value());
}

function tilemapCel(
	layerIndex: number,
	width: number,
	height: number,
	values: number[],
	options: { bitDepth?: 8 | 16 | 32; idMask?: number; xFlipMask?: number; yFlipMask?: number; diagonalFlipMask?: number } = {}
): Uint8Array {
	const bitDepth = options.bitDepth ?? 32;
	const decoded = new Writer();
	for (const value of values) {
		bitDepth === 8 ? decoded.u8(value) : bitDepth === 16 ? decoded.u16(value) : decoded.u32(value);
	}
	return chunk(
		0x2005,
		new Writer()
			.u16(layerIndex)
			.i16(0)
			.i16(0)
			.u8(255)
			.u16(3)
			.i16(0)
			.zeroes(5)
			.u16(width)
			.u16(height)
			.u16(bitDepth)
			.u32(options.idMask ?? 0x1fffffff)
			.u32(options.xFlipMask ?? 0x80000000)
			.u32(options.yFlipMask ?? 0x40000000)
			.u32(options.diagonalFlipMask ?? 0x20000000)
			.zeroes(10)
			.bytes(zlibSync(decoded.value()))
			.value()
	);
}

function tileset(
	name: string,
	pixels: Uint8Array,
	options: { id?: number; tileCount?: number; tileWidth?: number; tileHeight?: number; baseIndex?: number; zeroIsEmpty?: boolean } = {}
): Uint8Array {
	const encoded = zlibSync(pixels);
	return chunk(
		0x2023,
		new Writer()
			.u32(options.id ?? 17)
			.u32(2 | (options.zeroIsEmpty === false ? 0 : 4))
			.u32(options.tileCount ?? 2)
			.u16(options.tileWidth ?? 2)
			.u16(options.tileHeight ?? 2)
			.i16(options.baseIndex ?? 1)
			.zeroes(14)
			.string(name)
			.u32(encoded.byteLength)
			.bytes(encoded)
			.value()
	);
}

function externalFiles(): Uint8Array {
	return chunk(0x2008, new Writer().u32(1).zeroes(8).u32(9).u8(1).zeroes(7).string("shared-tiles.aseprite").value());
}

function externalTileset(): Uint8Array {
	return chunk(0x2023, new Writer().u32(18).u32(1).u32(2).u16(2).u16(2).i16(1).zeroes(14).string("External").u32(9).u32(27).value());
}

function userData(text: string): Uint8Array {
	return chunk(0x2020, new Writer().u32(1).string(text).value());
}

function tags(): Uint8Array {
	return chunk(0x2018, new Writer().u16(1).zeroes(8).u16(0).u16(2).u8(2).u16(2).zeroes(6).bytes([20, 40, 60]).u8(0).string("Run").value());
}

function slice(): Uint8Array {
	return chunk(0x2022, new Writer().u32(1).u32(3).u32(0).string("Body").u32(0).i32(0).i32(0).u32(4).u32(4).i32(1).i32(1).u32(2).u32(2).i32(1).i32(2).value());
}

function frame(chunks: Uint8Array[], durationMs: number): Uint8Array {
	const payload = chunks.reduce((result, value) => {
		const merged = new Uint8Array(result.byteLength + value.byteLength);
		merged.set(result);
		merged.set(value, result.byteLength);
		return merged;
	}, new Uint8Array());
	return new Writer()
		.u32(payload.byteLength + 16)
		.u16(0xf1fa)
		.u16(chunks.length)
		.u16(durationMs)
		.zeroes(2)
		.u32(chunks.length)
		.bytes(payload)
		.value();
}

function aseprite(frames: Uint8Array[], width: number, height: number, depth: 8 | 16 | 32, transparent = 0, colors = 256, headerFlags = 3): Uint8Array {
	const header = new Writer()
		.u32(0)
		.u16(0xa5e0)
		.u16(frames.length)
		.u16(width)
		.u16(height)
		.u16(depth)
		.u32(headerFlags)
		.u16(100)
		.u32(0)
		.u32(0)
		.u8(transparent)
		.zeroes(3)
		.u16(colors)
		.u8(1)
		.u8(1)
		.i16(0)
		.i16(0)
		.u16(16)
		.u16(16)
		.zeroes(84)
		.value();
	const size = header.byteLength + frames.reduce((sum, value) => sum + value.byteLength, 0);
	new DataView(header.buffer).setUint32(0, size, true);
	const result = new Uint8Array(size);
	result.set(header);
	let offset = header.byteLength;
	for (const value of frames) {
		result.set(value, offset);
		offset += value.byteLength;
	}
	return result;
}

function solid(width: number, height: number, color: [number, number, number, number]): Uint8Array {
	const result = new Uint8Array(width * height * 4);
	for (let offset = 0; offset < result.length; offset += 4) result.set(color, offset);
	return result;
}

function renderBlendPixel(backdrop: [number, number, number, number], source: [number, number, number, number], blendMode: number): number[] {
	const document = parseAseprite(
		aseprite(
			[frame([layer("Backdrop"), layer("Source", { blendMode }), imageCel(0, 0, 0, 1, 1, solid(1, 1, backdrop)), imageCel(1, 0, 0, 1, 1, solid(1, 1, source))], 100)],
			1,
			1,
			32
		)
	);
	return [...renderAsepriteFrame(document, 0)];
}

function rgbaFixture(): Uint8Array {
	return aseprite(
		[
			frame(
				[
					layer("Actor", { type: 1, opacity: 128 }),
					layer("Hero", { childLevel: 1 }),
					layer("Hidden FX", { visible: false }),
					imageCel(1, 1, 1, 2, 2, solid(2, 2, [255, 0, 0, 255]), { compressed: true }),
					imageCel(2, 0, 0, 1, 1, solid(1, 1, [0, 255, 0, 255])),
					tags(),
					slice(),
				],
				80
			),
			frame([linkedCel(1, 0, 1, 1), imageCel(2, 0, 0, 1, 1, solid(1, 1, [0, 0, 255, 255]))], 120),
			frame([imageCel(1, 1, 1, 2, 2, solid(2, 2, [255, 255, 0, 255]), { compressed: true })], 200),
		],
		4,
		4,
		32
	);
}

function palette(colors: Array<[number, number, number, number]>): Uint8Array {
	const writer = new Writer()
		.u32(colors.length)
		.u32(0)
		.u32(colors.length - 1)
		.zeroes(8);
	for (const color of colors) writer.u16(0).bytes(color);
	return chunk(0x2019, writer.value());
}

describe("Aseprite binary importer", () => {
	it("decodes compressed/raw/linked RGBA cels, hierarchy, tags, slices, and deterministic atlas metadata", () => {
		const document = parseAseprite(rgbaFixture());
		expect(document).toMatchObject({
			width: 4,
			height: 4,
			colorDepth: 32,
			statistics: { celCount: 5, compressedCelCount: 2, rawCelCount: 2, linkedCelCount: 1 },
		});
		expect(document.layers.map((entry) => ({ name: entry.name, type: entry.type, parent: entry.parentIndex, visible: entry.visible }))).toEqual([
			{ name: "Actor", type: "group", parent: null, visible: true },
			{ name: "Hero", type: "image", parent: 0, visible: true },
			{ name: "Hidden FX", type: "image", parent: null, visible: false },
		]);
		expect(document.frames.map((entry) => entry.durationMs)).toEqual([80, 120, 200]);
		expect(document.tags).toEqual([expect.objectContaining({ name: "Run", from: 0, to: 2, direction: "pingpong", repeat: 2 })]);
		expect(document.slices).toEqual([expect.objectContaining({ name: "Body", ninePatch: true, hasPivot: true, keys: [expect.objectContaining({ pivot: { x: 1, y: 2 } })] })]);

		const first = renderAsepriteFrame(document, 0);
		expect([...first.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)]).toEqual([255, 0, 0, 128]);
		expect([...first.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
		const withHidden = renderAsepriteFrame(document, 0, { includeHiddenLayers: true });
		expect([...withHidden.subarray(0, 4)]).toEqual([0, 255, 0, 255]);

		const atlas = buildAsepriteAtlas(document, { layerMode: "compositeAndLayers", maximumAtlasSize: 256 });
		expect(atlas.model).toBe(ASEPRITE_ATLAS_MODEL);
		expect(atlas.frames).toHaveLength(6);
		expect(atlas.statistics).toMatchObject({ compositeEntryCount: 3, layerEntryCount: 3, mergedDuplicateCount: 4 });
		expect(atlas.frames[0]).toMatchObject({ durationMs: 80, trimmed: true, spriteSourceSize: { x: 1, y: 1, w: 2, h: 2 }, pivot: { x: 0, y: 0.5 } });
		expect(atlas.frameTags[0].name).toBe("Run");
		expect(atlas.slices[0].keys[0].center).toEqual({ x: 1, y: 1, width: 2, height: 2 });
		expect(atlas.width & (atlas.width - 1)).toBe(0);
		expect(atlas.height & (atlas.height - 1)).toBe(0);
		expect(atlas.pixels.some((value) => value !== 0)).toBe(true);
		const summary = summarizeAsepriteDocument(document);
		expect(summary).toMatchObject({ width: 4, height: 4, frameCount: 3, frameDurationsMs: [80, 120, 200] });
		expect(summary.tilesets.every((entry) => !("pixels" in entry) && !("palette" in entry))).toBe(true);
		const json = createAsepriteAtlasJson(document, atlas, { name: "hero.aseprite", bytes: rgbaFixture().byteLength, sha256: "a".repeat(64) }, "b".repeat(64), []);
		expect(json).toMatchObject({
			meta: {
				app: "Zvibe Editor",
				image: "atlas.png",
				size: { w: atlas.width, h: atlas.height },
				zvibe: { model: ASEPRITE_ATLAS_MODEL, source: { name: "hero.aseprite" }, document: { frameCount: 3 } },
			},
		});
		expect(Object.keys(json.frames as Record<string, unknown>)).toHaveLength(atlas.frames.length);
	});

	it("decodes indexed palettes/transparency and grayscale alpha", () => {
		const indexed = parseAseprite(
			aseprite(
				[
					frame(
						[
							layer("Indexed"),
							palette([
								[10, 20, 30, 255],
								[200, 100, 50, 220],
							]),
							imageCel(0, 0, 0, 2, 1, Uint8Array.of(0, 1), { compressed: true }),
						],
						90
					),
				],
				2,
				1,
				8,
				0,
				2
			)
		);
		expect([...renderAsepriteFrame(indexed, 0)]).toEqual([0, 0, 0, 0, 200, 100, 50, 220]);

		const grayscale = parseAseprite(aseprite([frame([layer("Gray"), imageCel(0, 0, 0, 1, 1, Uint8Array.of(120, 200))], 90)], 1, 1, 16));
		expect([...renderAsepriteFrame(grayscale, 0)]).toEqual([120, 120, 120, 200]);

		const legacyOpacity = parseAseprite(aseprite([frame([layer("Legacy", { opacity: 1 }), imageCel(0, 0, 0, 1, 1, solid(1, 1, [40, 50, 60, 255]))], 90)], 1, 1, 32, 0, 256, 0));
		expect(legacyOpacity.layers[0].opacity).toBe(255);
		expect([...renderAsepriteFrame(legacyOpacity, 0)]).toEqual([40, 50, 60, 255]);

		const legacyGroup = parseAseprite(
			aseprite(
				[frame([layer("Group", { type: 1, opacity: 1, blendMode: 1 }), layer("Child", { childLevel: 1 }), imageCel(1, 0, 0, 1, 1, solid(1, 1, [40, 50, 60, 255]))], 90)],
				1,
				1,
				32,
				0,
				256,
				1
			)
		);
		expect(legacyGroup.layers[0]).toMatchObject({ blendModeCode: 1, effectiveBlendModeCode: 0, opacity: 255 });

		const background = parseAseprite(
			aseprite([frame([layer("Background", { background: true, opacity: 1, blendMode: 1 }), imageCel(0, 0, 0, 1, 1, solid(1, 1, [40, 50, 60, 255]))], 90)], 1, 1, 32)
		);
		expect(background.layers[0]).toMatchObject({ effectiveBlendModeCode: 0, opacity: 255 });

		const referencePixels = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255);
		const reference = parseAseprite(aseprite([frame([layer("Reference", { reference: true }), imageCel(0, 0, 0, 2, 2, referencePixels), celExtra(0, 0, 4, 4)], 90)], 4, 4, 32));
		const renderedReference = renderAsepriteFrame(reference, 0);
		const referencePixel = (x: number, y: number): number[] => [...renderedReference.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
		expect(referencePixel(0, 0)).toEqual([255, 0, 0, 255]);
		expect(referencePixel(1, 1)).toEqual([255, 0, 0, 255]);
		expect(referencePixel(2, 0)).toEqual([0, 255, 0, 255]);
		expect(referencePixel(0, 3)).toEqual([0, 0, 255, 255]);
		expect(referencePixel(3, 3)).toEqual([255, 255, 255, 255]);
	});

	it("decodes embedded and external tileset contracts plus compressed tile values and user data", () => {
		const transparentTile = solid(2, 2, [0, 0, 0, 0]);
		const visibleTile = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255);
		const tilesetPixels = new Uint8Array(transparentTile.byteLength + visibleTile.byteLength);
		tilesetPixels.set(transparentTile);
		tilesetPixels.set(visibleTile, transparentTile.byteLength);
		const document = parseAseprite(
			aseprite(
				[
					frame(
						[
							layer("Map", { type: 2, tilesetIndex: 17 }),
							externalFiles(),
							tileset("Embedded", tilesetPixels),
							userData("tileset"),
							userData("empty"),
							userData("solid"),
							externalTileset(),
							tilemapCel(0, 2, 1, [1, 0x80000001]),
						],
						100
					),
				],
				4,
				2,
				32
			)
		);
		expect(document.externalFiles).toEqual([{ id: 9, type: "tileset", name: "shared-tiles.aseprite" }]);
		expect(document.tilesets).toHaveLength(2);
		expect(document.tilesets[0]).toMatchObject({ id: 17, tileCount: 2, tileWidth: 2, tileHeight: 2, userData: { text: "tileset" } });
		expect(document.tilesets[0].tileUserData).toEqual([{ text: "empty" }, { text: "solid" }]);
		expect(document.tilesets[0].pixels).toEqual(tilesetPixels);
		expect(document.tilesets[1]).toMatchObject({ externalFileId: 9, externalTilesetId: 27, pixels: null });
		expect(document.frames[0].cels[0]).toMatchObject({ type: "tilemap", tileBitDepth: 32, tileIdMask: 0x1fffffff });
		expect([...document.frames[0].cels[0].tiles!]).toEqual([1, 0, 0, 0, 1, 0, 0, 128]);
		expect(document.statistics).toMatchObject({ tilemapCelCount: 1, embeddedTilesetCount: 1, externalTilesetCount: 1 });
		const renderedDocument = renderAsepriteFrame(document, 0);
		const documentPixel = (x: number, y: number): number[] => [...renderedDocument.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
		expect(documentPixel(0, 0)).toEqual([255, 0, 0, 255]);
		expect(documentPixel(1, 0)).toEqual([0, 255, 0, 255]);
		expect(documentPixel(2, 0)).toEqual([0, 255, 0, 255]);
		expect(documentPixel(3, 0)).toEqual([255, 0, 0, 255]);
		expect(documentPixel(0, 1)).toEqual([0, 0, 255, 255]);
		expect(documentPixel(3, 1)).toEqual([0, 0, 255, 255]);

		const flips = parseAseprite(
			aseprite(
				[
					frame([layer("Map", { type: 2, tilesetIndex: 17 }), tileset("Embedded", tilesetPixels), tilemapCel(0, 4, 1, [1, 0x80000001, 0x40000001, 0x20000001])], 80),
					frame([linkedCel(0, 0, 0, 0)], 120),
				],
				8,
				2,
				32
			)
		);
		for (const frameIndex of [0, 1]) {
			const rendered = renderAsepriteFrame(flips, frameIndex);
			const pixel = (x: number, y: number): number[] => [...rendered.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
			expect(pixel(0, 0)).toEqual([255, 0, 0, 255]);
			expect(pixel(2, 0)).toEqual([0, 255, 0, 255]);
			expect(pixel(4, 0)).toEqual([0, 0, 255, 255]);
			expect(pixel(6, 0)).toEqual([255, 0, 0, 255]);
			expect(pixel(7, 0)).toEqual([0, 0, 255, 255]);
			expect(pixel(6, 1)).toEqual([0, 255, 0, 255]);
		}
		const atlas = buildAsepriteAtlas(flips, { layerMode: "compositeAndLayers", maximumAtlasSize: 64 });
		expect(atlas.frames.map((entry) => entry.name)).toEqual(["composite/frame-0000", "composite/frame-0001", "layer-0000-Map/frame-0000", "layer-0000-Map/frame-0001"]);
		expect(atlas.statistics.mergedDuplicateCount).toBe(3);

		for (const compact of [
			{ bitDepth: 8 as const, idMask: 0x1f, xFlipMask: 0x80, yFlipMask: 0x40, diagonalFlipMask: 0x20 },
			{ bitDepth: 16 as const, idMask: 0x1fff, xFlipMask: 0x8000, yFlipMask: 0x4000, diagonalFlipMask: 0x2000 },
		]) {
			const compactDocument = parseAseprite(
				aseprite([frame([layer("Map", { type: 2, tilesetIndex: 17 }), tileset("Embedded", tilesetPixels), tilemapCel(0, 1, 1, [1], compact)], 100)], 2, 2, 32)
			);
			expect(compactDocument.frames[0].cels[0].tileBitDepth).toBe(compact.bitDepth);
			expect(renderAsepriteFrame(compactDocument, 0)).toEqual(visibleTile);
		}

		const wideTile = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255);
		const diagonalWideTile = parseAseprite(
			aseprite(
				[
					frame(
						[
							layer("Wide Map", { type: 2, tilesetIndex: 23 }),
							tileset("Wide", wideTile, { id: 23, tileCount: 1, tileWidth: 3, tileHeight: 2, baseIndex: 0, zeroIsEmpty: false }),
							tilemapCel(0, 1, 1, [0x20000000]),
						],
						100
					),
				],
				3,
				2,
				32
			)
		);
		expect([...renderAsepriteFrame(diagonalWideTile, 0)]).toEqual([255, 0, 0, 255, 255, 255, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255, 0, 0, 0, 0]);

		const externalDocument = parseAseprite(
			aseprite(
				[
					frame(
						[
							layer("External Source"),
							palette([
								[0, 0, 0, 0],
								[12, 34, 56, 255],
							]),
							tileset("External Pixels", Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 1), { id: 27 }),
						],
						100
					),
				],
				2,
				2,
				8
			)
		);
		const externalTarget = parseAseprite(
			aseprite([frame([layer("External Map", { type: 2, tilesetIndex: 18 }), externalFiles(), externalTileset(), tilemapCel(0, 1, 1, [1])], 100)], 2, 2, 32)
		);
		expect(() => bindAsepriteExternalTilesets(externalTarget, [])).toThrow("unresolved external file ID 9");
		expect(bindAsepriteExternalTilesets(externalTarget, [{ externalFileId: 9, document: externalDocument }])).toBe(1);
		expect(externalTarget.tilesets[0]).toMatchObject({ boundExternal: true, pixelColorDepth: 8 });
		expect(externalTarget.statistics).toMatchObject({ boundExternalTilesetCount: 1, decodedTilesetBytes: 8 });
		expect(renderAsepriteFrame(externalTarget, 0)).toEqual(solid(2, 2, [12, 34, 56, 255]));
	});

	it("rejects malformed headers, unsafe links, invalid zlib payloads, and contradictory settings", () => {
		const fixture = rgbaFixture();
		const badMagic = fixture.slice();
		new DataView(badMagic.buffer).setUint16(4, 0, true);
		expect(() => parseAseprite(badMagic)).toThrow("magic");
		const badLength = fixture.slice();
		new DataView(badLength.buffer).setUint32(0, fixture.byteLength + 1, true);
		expect(() => parseAseprite(badLength)).toThrow("declares");
		const unsafeLink = aseprite([frame([layer("Hero"), linkedCel(0, 0, 0, 0)], 100)], 1, 1, 32);
		expect(() => parseAseprite(unsafeLink)).toThrow("earlier frame");
		const invalidCompressed = aseprite([frame([layer("Hero"), imageCel(0, 0, 0, 1, 1, Uint8Array.of(1, 2, 3, 4), { compressed: true }).slice(0, -2)], 100)], 1, 1, 32);
		expect(() => parseAseprite(invalidCompressed)).toThrow();
		expect(() => normalizeAsepriteImporterSettings({ padding: 1, extrude: 2 })).toThrow("extrude");
		expect(() => normalizeAsepriteImporterSettings({ maximumAtlasSize: 63 })).toThrow("64");
		expect(() => normalizeAsepriteImporterSettings({ maximumAtlasSize: 300, powerOfTwo: true })).toThrow("power of two");
		const missingTileset = aseprite([frame([layer("Map", { type: 2, tilesetIndex: 0 }), tilemapCel(0, 1, 1, [1])], 100)], 2, 2, 32);
		expect(() => parseAseprite(missingTileset)).toThrow("missing tileset ID");
		const overlappingMasks = aseprite(
			[frame([layer("Map", { type: 2, tilesetIndex: 17 }), tileset("Embedded", new Uint8Array(32)), tilemapCel(0, 1, 1, [1], { xFlipMask: 1 })], 100)],
			2,
			2,
			32
		);
		expect(() => parseAseprite(overlappingMasks)).toThrow("overlapping tile masks");
		const missingExternal = aseprite([frame([layer("Image"), externalTileset()], 100)], 2, 2, 32);
		expect(() => parseAseprite(missingExternal)).toThrow("missing external tileset file ID");
		const unresolvedExternal = parseAseprite(
			aseprite([frame([layer("Map", { type: 2, tilesetIndex: 18 }), externalFiles(), externalTileset(), tilemapCel(0, 1, 1, [1])], 100)], 2, 2, 32)
		);
		expect(() => renderAsepriteFrame(unresolvedExternal, 0)).toThrow("requires embedded pixels");
		const nestedMemory = aseprite([frame([layer("Root", { type: 1 }), layer("Nested", { type: 1, childLevel: 1 }), layer("Image", { childLevel: 2 })], 100)], 8192, 8192, 32);
		expect(() => parseAseprite(nestedMemory)).toThrow("working-memory budget");
		const excessiveAtlasWork = parseAseprite(aseprite([frame([layer("Image"), imageCel(0, 0, 0, 1, 1, solid(1, 1, [1, 2, 3, 255]))], 100)], 1, 1, 32));
		excessiveAtlasWork.width = 8192;
		excessiveAtlasWork.height = 8192;
		excessiveAtlasWork.frames = Array.from({ length: 5 }, (_, index) => ({ ...excessiveAtlasWork.frames[0], index }));
		expect(() => buildAsepriteAtlas(excessiveAtlasWork)).toThrow("rendered pixels");
	});

	it("keeps duplicate layer names unique while sharing only byte-identical frame pixels", () => {
		const document = parseAseprite(
			aseprite(
				[frame([layer("Hero/Body"), layer("Hero/Body"), imageCel(0, 0, 0, 1, 1, solid(1, 1, [1, 2, 3, 255])), imageCel(1, 0, 0, 1, 1, solid(1, 1, [1, 2, 4, 128]))], 100)],
				1,
				1,
				32
			)
		);
		const atlas = buildAsepriteAtlas(document, { layerMode: "compositeAndLayers", maximumAtlasSize: 64 });
		expect(new Set(atlas.frames.map((entry) => entry.name)).size).toBe(atlas.frames.length);
		expect(atlas.frames.map((entry) => entry.name)).toEqual(["composite/frame-0000", "layer-0000-Hero_Body/frame-0000", "layer-0001-Hero_Body/frame-0000"]);
		expect(atlas.statistics.mergedDuplicateCount).toBe(0);
	});

	it("executes every documented Aseprite blend mode deterministically", () => {
		const outputs = Array.from({ length: 19 }, (_, blendMode) => renderBlendPixel([64, 128, 192, 255], [192, 96, 32, 255], blendMode));
		expect(outputs).toEqual([
			[192, 96, 32, 255],
			[48, 48, 24, 255],
			[208, 176, 200, 255],
			[96, 97, 145, 255],
			[64, 96, 32, 255],
			[192, 128, 192, 255],
			[255, 205, 220, 255],
			[1, 0, 0, 255],
			[161, 96, 48, 255],
			[96, 112, 156, 255],
			[128, 32, 160, 255],
			[160, 128, 176, 255],
			[175, 98, 47, 255],
			[51, 131, 211, 255],
			[190, 94, 30, 255],
			[65, 129, 193, 255],
			[255, 224, 224, 255],
			[0, 32, 160, 255],
			[85, 255, 255, 255],
		]);

		expect(renderBlendPixel([0, 0, 0, 255], [255, 255, 255, 255], 6)).toEqual([0, 0, 0, 255]);
		expect(renderBlendPixel([255, 255, 255, 255], [0, 0, 0, 255], 7)).toEqual([255, 255, 255, 255]);
		expect(renderBlendPixel([0, 0, 0, 255], [0, 0, 0, 255], 18)).toEqual([0, 0, 0, 255]);
		expect(renderBlendPixel([64, 128, 192, 255], [0, 0, 0, 255], 18)).toEqual([255, 255, 255, 255]);
	});
});

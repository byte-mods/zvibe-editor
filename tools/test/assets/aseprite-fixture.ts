import { zlibSync } from "fflate";

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

	public string(value: string): this {
		const bytes = new TextEncoder().encode(value);
		return this.u16(bytes.byteLength).bytes(bytes);
	}

	public bytes(value: Uint8Array | number[]): this {
		this._bytes.push(...value);
		return this;
	}

	public zeroes(count: number): this {
		return this.bytes(new Uint8Array(count));
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

function layer(name: string, type = 0, tilesetIndex = 0): Uint8Array {
	const content = new Writer().u16(3).u16(type).u16(0).u16(0).u16(0).u16(0).u8(255).zeroes(3).string(name);
	if (type === 2) {
		content.u32(tilesetIndex);
	}
	return chunk(0x2004, content.value());
}

function imageCel(layerIndex: number, color: [number, number, number, number]): Uint8Array {
	return chunk(0x2005, new Writer().u16(layerIndex).i16(0).i16(0).u8(255).u16(0).i16(0).zeroes(5).u16(1).u16(1).bytes(color).value());
}

function tilemapCel(layerIndex: number): Uint8Array {
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
			.u16(1)
			.u16(1)
			.u16(32)
			.u32(0x1fffffff)
			.u32(0x80000000)
			.u32(0x40000000)
			.u32(0x20000000)
			.zeroes(10)
			.bytes(zlibSync(new Writer().u32(0).value()))
			.value()
	);
}

function externalFile(name: string): Uint8Array {
	return chunk(0x2008, new Writer().u32(1).zeroes(8).u32(9).u8(1).zeroes(7).string(name).value());
}

function externalTileset(): Uint8Array {
	return chunk(0x2023, new Writer().u32(18).u32(1).u32(1).u16(1).u16(1).i16(1).zeroes(14).string("External").u32(9).u32(27).value());
}

function embeddedTileset(color: [number, number, number, number]): Uint8Array {
	const encoded = zlibSync(Uint8Array.from(color));
	return chunk(0x2023, new Writer().u32(27).u32(2).u32(1).u16(1).u16(1).i16(1).zeroes(14).string("Shared").u32(encoded.byteLength).bytes(encoded).value());
}

function frame(chunks: Uint8Array[], durationMs: number): Uint8Array {
	const payloadBytes = chunks.reduce((sum, value) => sum + value.byteLength, 0);
	const payload = new Uint8Array(payloadBytes);
	let offset = 0;
	for (const value of chunks) {
		payload.set(value, offset);
		offset += value.byteLength;
	}
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

function file(frames: Uint8Array[], width: number, height: number): Uint8Array {
	const header = new Writer()
		.u32(0)
		.u16(0xa5e0)
		.u16(frames.length)
		.u16(width)
		.u16(height)
		.u16(32)
		.u32(3)
		.u16(100)
		.u32(0)
		.u32(0)
		.u8(0)
		.zeroes(3)
		.u16(256)
		.u8(1)
		.u8(1)
		.i16(0)
		.i16(0)
		.u16(16)
		.u16(16)
		.zeroes(84)
		.value();
	const result = new Uint8Array(header.byteLength + frames.reduce((sum, value) => sum + value.byteLength, 0));
	new DataView(header.buffer).setUint32(0, result.byteLength, true);
	result.set(header);
	let offset = header.byteLength;
	for (const value of frames) {
		result.set(value, offset);
		offset += value.byteLength;
	}
	return result;
}

export function createSimpleAsepriteFixture(color: [number, number, number, number] = [255, 0, 0, 255]): Uint8Array {
	return file([frame([layer("Hero"), imageCel(0, color)], 80)], 1, 1);
}

export function createExternalAsepriteFixture(
	name = "shared.aseprite",
	color: [number, number, number, number] = [12, 34, 56, 255]
): { source: Uint8Array; dependency: Uint8Array } {
	return {
		source: file([frame([layer("Map", 2, 18), externalFile(name), externalTileset(), tilemapCel(0)], 120)], 1, 1),
		dependency: file([frame([layer("Shared"), embeddedTileset(color)], 120)], 1, 1),
	};
}

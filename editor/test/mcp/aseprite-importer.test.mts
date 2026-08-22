import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { mkdir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { zlibSync } from "fflate";

import { applyAsepriteImporterArtifact, getAsepriteImporterArtifactStatus } from "../../src/mcp/assets/aseprite-importer";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

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

	public bytes(value: Uint8Array | number[]): this {
		this._bytes.push(...value);
		return this;
	}

	public zeroes(count: number): this {
		this._bytes.push(...new Array(count).fill(0));
		return this;
	}

	public string(value: string): this {
		const bytes = new TextEncoder().encode(value);
		return this.u16(bytes.byteLength).bytes(bytes);
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

function layer(name: string, type = 0, tilesetId = 0): Uint8Array {
	const writer = new Writer().u16(3).u16(type).u16(0).u16(0).u16(0).u16(0).u8(255).zeroes(3).string(name);
	if (type === 2) writer.u32(tilesetId);
	return chunk(0x2004, writer.value());
}

function imageCel(layerIndex: number, width: number, height: number, pixels: Uint8Array): Uint8Array {
	return chunk(0x2005, new Writer().u16(layerIndex).i16(0).i16(0).u8(255).u16(2).i16(0).zeroes(5).u16(width).u16(height).bytes(zlibSync(pixels)).value());
}

function tilemapCel(layerIndex: number, tileId: number): Uint8Array {
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
			.bytes(zlibSync(new Writer().u32(tileId).value()))
			.value()
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

function embeddedTileset(id: number, pixels: Uint8Array): Uint8Array {
	const encoded = zlibSync(pixels);
	return chunk(0x2023, new Writer().u32(id).u32(6).u32(2).u16(2).u16(2).i16(1).zeroes(14).string("Shared Tiles").u32(encoded.byteLength).bytes(encoded).value());
}

function externalFiles(name: string): Uint8Array {
	return chunk(0x2008, new Writer().u32(1).zeroes(8).u32(9).u8(1).zeroes(7).string(name).value());
}

function externalTileset(): Uint8Array {
	return chunk(0x2023, new Writer().u32(18).u32(1).u32(2).u16(2).u16(2).i16(1).zeroes(14).string("External Tiles").u32(9).u32(27).value());
}

function userData(text: string, color: [number, number, number, number]): Uint8Array {
	return chunk(0x2020, new Writer().u32(3).string(text).bytes(color).value());
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

function aseprite(frames: Uint8Array[], width: number, height: number, depth: 8 | 32, transparent = 0): Uint8Array {
	const header = new Writer()
		.u32(0)
		.u16(0xa5e0)
		.u16(frames.length)
		.u16(width)
		.u16(height)
		.u16(depth)
		.u32(3)
		.u16(100)
		.zeroes(8)
		.u8(transparent)
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
	const byteLength = header.byteLength + frames.reduce((sum, value) => sum + value.byteLength, 0);
	new DataView(header.buffer).setUint32(0, byteLength, true);
	const result = new Uint8Array(byteLength);
	result.set(header);
	let offset = header.byteLength;
	for (const value of frames) {
		result.set(value, offset);
		offset += value.byteLength;
	}
	return result;
}

function animatedFixture(color: [number, number, number, number] = [180, 40, 20, 255]): Uint8Array {
	return aseprite(
		[
			frame([layer("Hero"), imageCel(0, 2, 2, Uint8Array.from([...color, ...color, ...color, ...color])), userData("Footstep", [5, 10, 15, 255])], 80),
			frame([imageCel(0, 2, 2, Uint8Array.from([20, 40, 180, 255, 20, 40, 180, 255, 20, 40, 180, 255, 20, 40, 180, 255]))], 140),
		],
		2,
		2,
		32
	);
}

function externalSourceFixture(color: [number, number, number, number]): Uint8Array {
	return aseprite([frame([layer("External Source"), palette([[0, 0, 0, 0], color]), embeddedTileset(27, Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 1))], 100)], 2, 2, 8);
}

function externalTargetFixture(name: string): Uint8Array {
	return aseprite([frame([layer("Map", 2, 18), externalFiles(name), externalTileset(), tilemapCel(0, 1)], 100)], 2, 2, 32);
}

describe("native Aseprite artifact importer", () => {
	let directory: string;
	let sourcePath: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-aseprite-importer-"));
		await mkdir(join(directory, "assets"), { recursive: true });
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		sourcePath = join(directory, "assets", "hero.aseprite");
		await writeFile(sourcePath, animatedFixture());
		await readAssetMetadata(sourcePath);
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("leases and publishes deterministic PNG, JSON, and manifest artifacts", async () => {
		const planned = await getAsepriteImporterArtifactStatus(sourcePath);
		expect(planned).toMatchObject({ current: false, exists: false, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), dependencies: [] });
		const applied = await applyAsepriteImporterArtifact(sourcePath, planned.fingerprint);
		expect(applied).toMatchObject({
			current: true,
			result: {
				sourceBytes: expect.any(Number),
				document: { frameCount: 2, frameDurationsMs: [80, 140], celUserData: [{ frameIndex: 0, layerIndex: 0, text: "Footstep", color: [5, 10, 15, 255] }] },
			},
		});
		const image = await sharp(applied.result!.atlasImagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(image.info).toMatchObject({ channels: 4 });
		expect(image.data.some((value) => value !== 0)).toBe(true);
		const atlas = await readJSON(applied.result!.atlasJsonPath);
		expect(atlas).toMatchObject({ meta: { app: "Zvibe Editor", version: "1.0.0", zvibe: { source: { sha256: planned.sourceSha256 }, dependencies: [] } } });
		expect(Object.keys(atlas.frames)).toHaveLength(2);
		expect(await getAsepriteImporterArtifactStatus(sourcePath)).toMatchObject({ current: true, fingerprint: planned.fingerprint });

		const firstImageSha256 = applied.result!.atlasImageSha256;
		const reapplied = await applyAsepriteImporterArtifact(sourcePath, planned.fingerprint);
		expect(reapplied.result!.atlasImageSha256).toBe(firstImageSha256);
	});

	test("invalidates tampered output and stale source/settings leases without deleting the last good artifact", async () => {
		const planned = await getAsepriteImporterArtifactStatus(sourcePath);
		const applied = await applyAsepriteImporterArtifact(sourcePath, planned.fingerprint);
		const originalImage = await readFile(applied.result!.atlasImagePath);
		await writeFile(applied.result!.atlasImagePath, Buffer.from("tampered"));
		expect(await getAsepriteImporterArtifactStatus(sourcePath)).toMatchObject({ current: false, exists: true, result: null });
		await writeFile(applied.result!.atlasImagePath, originalImage);
		expect((await getAsepriteImporterArtifactStatus(sourcePath)).current).toBe(true);

		const metadata = await readAssetMetadata(sourcePath);
		metadata.importer.settings = { ...metadata.importer.settings, padding: 8 };
		await writeAssetMetadata(sourcePath, metadata);
		const changedSettings = await getAsepriteImporterArtifactStatus(sourcePath);
		expect(changedSettings).toMatchObject({ current: false, exists: true });
		await expect(applyAsepriteImporterArtifact(sourcePath, planned.fingerprint)).rejects.toThrow("plan changed");
		expect(await pathExists(applied.result!.atlasImagePath)).toBe(true);

		await writeFile(sourcePath, Buffer.from("invalid-source"));
		await expect(applyAsepriteImporterArtifact(sourcePath, changedSettings.fingerprint)).rejects.toThrow(/128 through|declares|invalid/i);
		expect(await readFile(applied.result!.atlasImagePath)).toEqual(originalImage);
	});

	test("binds project-contained external indexed tilesets and leases every dependency byte", async () => {
		const dependencyPath = join(dirname(sourcePath), "shared.aseprite");
		await writeFile(dependencyPath, externalSourceFixture([12, 34, 56, 255]));
		await writeFile(sourcePath, externalTargetFixture("shared.aseprite"));
		const planned = await getAsepriteImporterArtifactStatus(sourcePath);
		expect(planned.dependencies).toEqual([
			expect.objectContaining({
				ownerPath: "assets/hero.aseprite",
				externalFileId: 9,
				path: "assets/shared.aseprite",
				tilesetIds: [27],
				sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		]);
		const applied = await applyAsepriteImporterArtifact(sourcePath, planned.fingerprint);
		expect(applied.result).toMatchObject({
			document: { statistics: { boundExternalTilesetCount: 1 }, tilesets: [{ boundExternal: true, pixelColorDepth: 8, pixelBytes: 8 }] },
		});
		const pixels = await sharp(applied.result!.atlasImagePath).ensureAlpha().raw().toBuffer();
		expect([...pixels.subarray(0, 4)]).toEqual([12, 34, 56, 255]);

		await writeFile(dependencyPath, externalSourceFixture([90, 80, 70, 255]));
		const changed = await getAsepriteImporterArtifactStatus(sourcePath);
		expect(changed).toMatchObject({ current: false, exists: true });
		expect(changed.fingerprint).not.toBe(planned.fingerprint);
		await expect(applyAsepriteImporterArtifact(sourcePath, planned.fingerprint)).rejects.toThrow("plan changed");
	});

	test("rejects external traversal and manifest path substitution", async () => {
		const outside = join(directory, "..", `outside-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}.aseprite`);
		await writeFile(outside, externalSourceFixture([1, 2, 3, 255]));
		try {
			await writeFile(sourcePath, externalTargetFixture(`../../${outside.split("/").at(-1)}`));
			await expect(getAsepriteImporterArtifactStatus(sourcePath)).rejects.toThrow(/inside the open project/i);

			await writeFile(sourcePath, animatedFixture());
			const planned = await getAsepriteImporterArtifactStatus(sourcePath);
			const applied = await applyAsepriteImporterArtifact(sourcePath, planned.fingerprint);
			const manifest = await readJSON(applied.manifestPath);
			manifest.result.atlasImagePath = outside;
			await writeJSON(applied.manifestPath, manifest, { spaces: "\t" });
			expect(await getAsepriteImporterArtifactStatus(sourcePath)).toMatchObject({ current: false, exists: true, result: null });
		} finally {
			await remove(outside);
		}
	});
});

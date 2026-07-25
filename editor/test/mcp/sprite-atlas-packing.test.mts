import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, pathExists, readJSON, remove } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import sharp from "sharp";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { packSpriteAtlas, sliceSpriteSheet } from "../../src/mcp/sprites/sprites";

describe("mcp/sprite-atlas-packing", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-sprite-atlas-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
		await sharp({ create: { width: 3, height: 5, channels: 4, background: "#ff0000" } })
			.png()
			.toFile(join(directory, "hero.png"));
		await sharp({ create: { width: 7, height: 2, channels: 4, background: "#00ff00" } })
			.png()
			.toFile(join(directory, "enemy.png"));
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("writes a deterministic power-of-two PNG atlas and compatible JSON frames", async () => {
		const result = await packSpriteAtlas(scene, { sourcePaths: ["hero.png", "enemy.png"], outputPath: "assets/atlas.png", padding: 2, maxSize: 64 }, options);
		expect(result).toMatchObject({ atlasPath: "assets/atlas.png", atlasJsonPath: "assets/atlas.json", width: 16, height: 16, frames: ["enemy.png", "hero.png"] });
		expect(await pathExists(join(directory, "assets/atlas.png"))).toBe(true);
		const atlas = await readJSON(join(directory, "assets/atlas.json"));
		expect(atlas.meta.image).toBe("atlas.png");
		expect(atlas.frames["hero.png"].frame).toMatchObject({ w: 3, h: 5 });
		expect(atlas.frames["enemy.png"].frame).toMatchObject({ w: 7, h: 2 });
	});

	test("trims transparent source borders while retaining TexturePacker source metadata", async () => {
		const pixels = Buffer.alloc(6 * 4 * 4);
		for (let x = 2; x < 4; x++) {
			const offset = (1 * 6 + x) * 4;
			pixels[offset] = 255;
			pixels[offset + 3] = 255;
		}
		await sharp(pixels, { raw: { width: 6, height: 4, channels: 4 } })
			.png()
			.toFile(join(directory, "trimmed.png"));
		const result = await packSpriteAtlas(
			scene,
			{ sourcePaths: ["trimmed.png"], outputPath: "assets/trimmed-atlas.png", padding: 1, maxSize: 64, trimTransparent: true },
			options
		);
		const atlas = await readJSON(join(directory, "assets/trimmed-atlas.json"));
		expect(result).toMatchObject({ trimTransparent: true });
		expect(atlas.frames["trimmed.png"]).toMatchObject({
			frame: { w: 2, h: 1 },
			trimmed: true,
			spriteSourceSize: { x: 2, y: 1, w: 2, h: 1 },
			sourceSize: { w: 6, h: 4 },
		});
	});

	test("packs deterministic clockwise-rotated frames and preserves exact source pixels", async () => {
		const result = await packSpriteAtlas(
			scene,
			{ sourcePaths: ["hero.png", "enemy.png"], outputPath: "assets/rotated-atlas.png", padding: 1, maxSize: 64, allowRotation: true },
			options
		);
		expect(result).toMatchObject({ allowRotation: true, rotatedFrames: ["enemy.png"], frames: ["enemy.png", "hero.png"] });
		const atlas = await readJSON(join(directory, "assets/rotated-atlas.json"));
		expect(atlas.frames["hero.png"]).toMatchObject({ rotated: false, frame: { w: 3, h: 5 } });
		expect(atlas.frames["enemy.png"]).toMatchObject({
			rotated: true,
			frame: { w: 2, h: 7 },
			spriteSourceSize: { x: 0, y: 0, w: 7, h: 2 },
			sourceSize: { w: 7, h: 2 },
		});
		const frame = atlas.frames["enemy.png"].frame;
		const restored = await sharp(join(directory, "assets/rotated-atlas.png"))
			.extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
			.rotate(-90)
			.ensureAlpha()
			.raw()
			.toBuffer();
		const source = await sharp(join(directory, "enemy.png")).ensureAlpha().raw().toBuffer();
		expect(restored).toEqual(source);
	});

	test("writes validated named irregular source-image frames", async () => {
		const result = await sliceSpriteSheet(
			scene,
			{
				sourcePath: "hero.png",
				outputPath: "assets/hero-frames.json",
				frames: [
					{ name: "head", x: 0, y: 0, width: 3, height: 2 },
					{ name: "body", x: 0, y: 2, width: 3, height: 3 },
				],
			},
			options
		);
		expect(result).toMatchObject({ sourcePath: "hero.png", atlasJsonPath: "assets/hero-frames.json", width: 3, height: 5, frames: ["head", "body"] });
		const atlas = await readJSON(join(directory, "assets/hero-frames.json"));
		expect(atlas.meta.image).toBe("../hero.png");
		expect(atlas.frames.body.frame).toEqual({ x: 0, y: 2, w: 3, h: 3 });
		await expect(
			sliceSpriteSheet(scene, { sourcePath: "hero.png", outputPath: "assets/bad.json", frames: [{ name: "outside", x: 3, y: 0, width: 1, height: 1 }] }, options)
		).rejects.toThrow("must stay within");
	});
});

import { ensureDir, mkdtemp, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import sharp from "sharp";
import { getDefaultAssetImporterConfiguration, normalizeTextureImporterSettings } from "babylonjs-editor-tools";
import { afterEach, describe, expect, test } from "vitest";

import { processImportedTexture } from "../src/pack/assets/texture-importer.mjs";
import { processAssetFile } from "../src/pack/assets/process.mjs";

describe("CLI executed texture importer", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("produces the same resized, alpha-free, mipmapped, readable build output", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-texture-"));
		directories.push(project);
		const source = join(project, "assets", "source.bmp");
		const output = join(project, "public", "scene", "assets", "source.bmp");
		await ensureDir(join(project, "assets"));
		await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.25 } } })
			.png()
			.toFile(source);
		const result = await processImportedTexture(
			source,
			output,
			normalizeTextureImporterSettings({
				textureType: "lightmap",
				colorSpace: "sRGB",
				alphaSource: "none",
				generateMipmaps: true,
				maxSize: 128,
				resizeAlgorithm: "bicubic",
				compression: "normal",
				readable: true,
			})
		);
		expect(result).toMatchObject({
			outputPath: expect.stringMatching(/source\.png$/),
			resized: true,
			alphaRemoved: true,
			effectiveColorSpace: "linear",
			output: { width: 128, height: 64, channels: 3 },
			mipmaps: [
				{ width: 85, height: 42 },
				{ width: 42, height: 21 },
			],
		});
		expect(await pathExists(result.outputPath)).toBe(true);
		expect((await stat(result.readableBitmapPath!)).size).toBe(128 * 64 * 4);
		expect(await readJSON(result.readableDescriptorPath!)).toMatchObject({ pixelFormat: "rgba8", byteLength: 128 * 64 * 4 });
	});

	test("publishes the portable sidecar through the real CLI asset build path", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-texture-build-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		const source = join(assets, "build.bmp");
		await ensureDir(assets);
		await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 10, g: 30, b: 50, alpha: 0.5 } } })
			.png()
			.toFile(source);
		const importer = getDefaultAssetImporterConfiguration(source);
		importer.settings = { ...importer.settings, textureType: "normalMap", alphaSource: "none", maxSize: 128, readable: true };
		await writeJSON(`${source}.bjsmeta.json`, { version: 1, guid: "texture-build-guid", importer });
		const exportedAssets: string[] = [];
		await processAssetFile(source, {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			optimize: false,
			exportedAssets,
			cache: {},
			compressedTexturesEnabled: false,
		});
		const sidecarPath = join(publicDir, "assets", "build.bmp.bjstexture.json");
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({
			outputPath: "assets/build.png",
			textureType: "normalMap",
			colorSpace: "linear",
			readableBitmapPath: "assets/build.png.rgba",
			result: { output: { width: 128, height: 64, channels: 3 } },
		});
		expect(await pathExists(join(publicDir, sidecar.outputPath))).toBe(true);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(publicDir, "assets", "build.png"), sidecarPath]));
	});
});

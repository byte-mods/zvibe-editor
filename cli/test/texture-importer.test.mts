import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import sharp from "sharp";
import { encodeOpenExr, encodeRadianceHdr, getDefaultAssetImporterConfiguration, normalizeTextureImporterSettings, type IHighDynamicRangeImage } from "babylonjs-editor-tools";
import { afterEach, describe, expect, test } from "vitest";

import { processImportedTexture } from "../src/pack/assets/texture-importer.mjs";
import { processAssetFile } from "../src/pack/assets/process.mjs";

describe("CLI executed texture importer", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	async function createTga(path: string): Promise<void> {
		const header = Buffer.alloc(18);
		header[2] = 2;
		header.writeUInt16LE(2, 12);
		header.writeUInt16LE(1, 14);
		header[16] = 24;
		header[17] = 0x20;
		await writeFile(path, Buffer.concat([header, Buffer.from([0, 0, 255, 0, 255, 0])]));
	}

	async function createPsd(path: string, psb = false, depth: 8 | 16 | 32 = 8): Promise<void> {
		const header = Buffer.alloc(26);
		header.write("8BPS", 0, "ascii");
		header.writeUInt16BE(psb ? 2 : 1, 4);
		header.writeUInt16BE(4, 12);
		header.writeUInt32BE(1, 14);
		header.writeUInt32BE(2, 18);
		header.writeUInt16BE(depth, 22);
		header.writeUInt16BE(3, 24);
		const sections = Buffer.alloc(psb ? 16 : 12);
		const compression = Buffer.alloc(2);
		compression.writeUInt16BE(0);
		const values = [255, 0, 0, 255, 0, 0, 64, 255];
		const pixels =
			depth === 32
				? Buffer.concat(
						values.map((value, index) => {
							const normalized = value / 255;
							const sample = index >= 6 ? normalized : normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
							const bytes = Buffer.alloc(4);
							bytes.writeFloatBE(sample);
							return bytes;
						})
					)
				: depth === 16
					? Buffer.from(values.flatMap((value) => [value, value]))
					: Buffer.from(values);
		await writeFile(path, Buffer.concat([header, sections, compression, pixels]));
	}

	async function createHighDynamicRange(path: string, format: "hdr" | "exr"): Promise<void> {
		const pixels = new Float32Array(8 * 4 * 4);
		for (let pixel = 0; pixel < 8 * 4; ++pixel) {
			pixels[pixel * 4] = (pixel % 8) * 0.5;
			pixels[pixel * 4 + 1] = Math.floor(pixel / 8) * 0.75;
			pixels[pixel * 4 + 2] = 2;
			pixels[pixel * 4 + 3] = 1;
		}
		const image: IHighDynamicRangeImage = {
			format,
			compression: "none",
			width: 8,
			height: 4,
			pixels,
			statistics: { minimum: [0, 0, 0, 1], maximum: [3.5, 2.25, 2, 1], average: [1.75, 1.125, 2, 1], nonFiniteCount: 0 },
		};
		await writeFile(path, format === "exr" ? encodeOpenExr(image) : encodeRadianceHdr(image));
	}

	test("copies retained UXML and USS sources byte-exactly into CLI build output", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-retained-ui-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		await ensureDir(assets);
		const uxml = join(assets, "hud.uxml");
		const uss = join(assets, "hud.uss");
		const uxmlSource = `<UXML><Style src="hud.uss"/><Label name="title" text="Ready"/></UXML>`;
		const ussSource = `.title:hover { color: #73a7ff; }`;
		await writeFile(uxml, uxmlSource);
		await writeFile(uss, ussSource);
		const exportedAssets: string[] = [];
		const options = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			optimize: false,
			exportedAssets,
			cache: {},
			compressedTexturesEnabled: false,
		};
		await processAssetFile(uxml, options);
		await processAssetFile(uss, options);
		expect(await readFile(join(publicDir, "assets", "hud.uxml"), "utf8")).toBe(uxmlSource);
		expect(await readFile(join(publicDir, "assets", "hud.uss"), "utf8")).toBe(ussSource);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(publicDir, "assets", "hud.uxml"), join(publicDir, "assets", "hud.uss")]));
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
				{ width: 64, height: 32 },
				{ width: 32, height: 16 },
				{ width: 16, height: 8 },
				{ width: 8, height: 4 },
				{ width: 4, height: 2 },
				{ width: 2, height: 1 },
				{ width: 1, height: 1 },
			],
			processing: { outputFormat: "png", maxSizeApplied: true, fullMipChain: true },
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
			version: 2,
			outputPath: "assets/build.png",
			textureType: "normalMap",
			colorSpace: "linear",
			filterMode: "trilinear",
			wrapModeU: "repeat",
			wrapModeV: "repeat",
			anisoLevel: 1,
			readableBitmapPath: "assets/build.png.rgba",
			result: { output: { width: 128, height: 64, channels: 3 } },
		});
		expect(await pathExists(join(publicDir, sidecar.outputPath))).toBe(true);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(publicDir, "assets", "build.png"), sidecarPath]));
	});

	test("executes Web/Desktop texture overrides through the real CLI cache and sidecar path", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-texture-platform-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		const source = join(assets, "platform.png");
		await ensureDir(assets);
		await sharp({ create: { width: 300, height: 150, channels: 4, background: { r: 25, g: 50, b: 75, alpha: 1 } } })
			.png()
			.toFile(source);
		const importer = getDefaultAssetImporterConfiguration(source);
		importer.settings.platformOverrides = JSON.stringify({
			web: { enabled: true, outputFormat: "webp", maxSize: 64, generateMipmaps: false, compression: "low", readable: false },
			desktop: { enabled: true, maxSize: 128, generateMipmaps: true, compression: "high", readable: true },
		});
		await writeJSON(`${source}.bjsmeta.json`, { version: 1, guid: "texture-platform-guid", importer });
		const baseOptions = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			exportedAssets: [] as string[],
			optimize: false,
			cache: {} as Record<string, string>,
			compressedTexturesEnabled: false,
		};
		await processAssetFile(source, { ...baseOptions, assetPlatform: "web" });
		const sidecarPath = join(publicDir, "assets", "platform.png.bjstexture.json");
		expect(await readJSON(sidecarPath)).toMatchObject({
			outputPath: "assets/platform.webp",
			result: { platform: "web", platformOverrideApplied: true, processing: { outputFormat: "webp" }, output: { width: 64, height: 32 }, mipmaps: [] },
		});
		expect(await pathExists(join(publicDir, "assets", "platform.webp"))).toBe(true);
		await processAssetFile(source, { ...baseOptions, exportedAssets: [], assetPlatform: "desktop" });
		expect(await readJSON(sidecarPath)).toMatchObject({
			result: { platform: "desktop", platformOverrideApplied: true, output: { width: 128, height: 64 }, readablePixelFormat: "rgba8" },
		});
	});

	test("publishes a validated TGA as a portable PNG through the real CLI build path", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-tga-build-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		const source = join(assets, "source.tga");
		await ensureDir(assets);
		await createTga(source);
		const importer = getDefaultAssetImporterConfiguration(source);
		await writeJSON(`${source}.bjsmeta.json`, { version: 1, guid: "texture-tga-guid", importer });
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
		const sidecarPath = join(publicDir, "assets", "source.tga.bjstexture.json");
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({ outputPath: "assets/source.png", result: { source: { format: "tga", width: 2, height: 1 }, output: { format: "png" } } });
		const pixels = await sharp(join(publicDir, "assets", "source.png"))
			.ensureAlpha()
			.raw()
			.toBuffer();
		expect([...pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(publicDir, "assets", "source.png"), sidecarPath]));
	});

	test.each([
		["psd", false, 8],
		["psb", true, 8],
		["psd", false, 16],
		["psb", true, 16],
		["psd", false, 32],
		["psb", true, 32],
	] as const)("publishes a validated %s %i-bit merged composite as a portable PNG through the real CLI build path", async (format, psb, depth) => {
		const project = await mkdtemp(join(tmpdir(), `babylon-cli-${format}-build-`));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		const source = join(assets, `source.${format}`);
		await ensureDir(assets);
		await createPsd(source, psb, depth);
		const importer = getDefaultAssetImporterConfiguration(source);
		await writeJSON(`${source}.bjsmeta.json`, { version: 1, guid: `texture-${format}-guid`, importer });
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
		const sidecarPath = join(publicDir, "assets", `source.${format}.bjstexture.json`);
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({
			outputPath: "assets/source.png",
			result: {
				source: { format, width: 2, height: 1, channels: 4, hasAlpha: true },
				output: { format: "png" },
				warnings: [
					expect.stringContaining(
						` ${depth}-bit source imported from its merged raw composite through ${
							depth === 32 ? "bounded-linear-float32-to-rgba8-v1" : depth === 16 ? "bounded-uint16-to-rgba8-v1" : "identity-uint8"
						}`
					),
				],
			},
		});
		expect(sidecar.result.warnings).toEqual([expect.stringContaining("merged raw composite")]);
		const pixels = await sharp(join(publicDir, "assets", "source.png"))
			.ensureAlpha()
			.raw()
			.toBuffer();
		expect([...pixels]).toEqual([255, 0, 0, 64, 0, 255, 0, 255]);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(publicDir, "assets", "source.png"), sidecarPath]));
	});

	test.each(["hdr", "exr"] as const)("publishes linear %s, RGBA32F, ACES preview, and cubemap evidence through the real CLI build path", async (format) => {
		const project = await mkdtemp(join(tmpdir(), `babylon-cli-${format}-build-`));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		const source = join(assets, `source.${format}`);
		await ensureDir(assets);
		await createHighDynamicRange(source, format);
		const importer = getDefaultAssetImporterConfiguration(source);
		importer.settings = { ...importer.settings, colorSpace: "sRGB", readable: true };
		await writeJSON(`${source}.bjsmeta.json`, { version: 1, guid: `texture-${format}-guid`, importer });
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
		const sidecarPath = join(publicDir, "assets", `source.${format}.bjstexture.json`);
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({
			outputPath: `assets/source.${format}`,
			previewPath: `assets/source.${format}.preview.png`,
			colorSpace: "linear",
			readableBitmapPath: `assets/source.${format}.rgba32f`,
			result: {
				effectiveColorSpace: "linear",
				readablePixelFormat: "rgba32f",
				highDynamicRange: { equirectangular: true, cubeFaceSize: 16 },
			},
		});
		expect(sidecar.result.highDynamicRange.cubeFaces).toHaveLength(6);
		expect(sidecar.result.highDynamicRange.cubeFaces).toEqual(expect.arrayContaining([expect.objectContaining({ face: "px", width: 16, height: 16 })]));
		const expectedEnvironmentPath = format === "exr" ? "assets/source.exr.environment.hdr" : "assets/source.hdr";
		expect(sidecar.environmentPath).toBe(expectedEnvironmentPath);
		expect((await stat(join(publicDir, sidecar.readableBitmapPath))).size).toBe(8 * 4 * 4 * 4);
		expect(await pathExists(join(publicDir, sidecar.previewPath))).toBe(true);
		expect(await pathExists(join(publicDir, expectedEnvironmentPath))).toBe(true);
		expect((await Promise.all(sidecar.result.highDynamicRange.cubeFaces.map((face: { path: string }) => pathExists(join(publicDir, face.path))))).every(Boolean)).toBe(true);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(publicDir, `assets/source.${format}`), join(publicDir, sidecar.previewPath), sidecarPath]));
	});
});

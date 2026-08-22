import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, stat, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene, StandardMaterial } from "babylonjs";
import sharp from "sharp";
import { encodeOpenExr, encodeRadianceHdr, IHighDynamicRangeImage, normalizeTextureImporterSettings, serializeTextureImporterPlatformOverrides } from "babylonjs-editor-tools";

import { applyTextureImporterArtifact, getTextureImporterArtifactStatus, processTextureImporterOutput } from "../../src/mcp/assets/texture-importer";
import { applyTextureImporter, getTextureImporterResult, getTexturePlatformOverrides, setTexturePlatformOverrides } from "../../src/mcp/assets/assets";
import { getAssetTypeFromPath, readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";
import { processAssetFile } from "../../src/project/export/assets";
import { assignTextureToMaterial } from "../../src/mcp/materials/materials";

async function createImage(path: string): Promise<void> {
	await sharp({ create: { width: 300, height: 150, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 0.5 } } })
		.png()
		.toFile(path);
}

async function createTga(path: string): Promise<void> {
	const header = Buffer.alloc(18);
	header[2] = 10;
	header.writeUInt16LE(4, 12);
	header.writeUInt16LE(2, 14);
	header[16] = 32;
	header[17] = 0x28;
	const pixels = Buffer.from([0x83, 10, 20, 30, 128, 0x83, 200, 150, 100, 255]);
	await writeFile(path, Buffer.concat([header, pixels]));
}

async function createPsd(path: string, psb = false, depth: 8 | 16 | 32 = 8): Promise<void> {
	const header = Buffer.alloc(26);
	header.write("8BPS", 0, "ascii");
	header.writeUInt16BE(psb ? 2 : 1, 4);
	header.writeUInt16BE(4, 12);
	header.writeUInt32BE(2, 14);
	header.writeUInt32BE(4, 18);
	header.writeUInt16BE(depth, 22);
	header.writeUInt16BE(3, 24);
	const sections = Buffer.alloc(psb ? 16 : 12);
	const compression = Buffer.alloc(2);
	compression.writeUInt16BE(1);
	const values = [10, 100, 20, 150, 30, 200, 128, 255];
	const rows = values.map((value, index) => {
		if (depth !== 32) return Buffer.from([depth === 16 ? 249 : 253, value]);
		const normalized = value / 255;
		const sample = index >= 6 ? normalized : normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
		const bytes = Buffer.alloc(4);
		bytes.writeFloatBE(sample);
		return Buffer.concat([Buffer.from([15]), Buffer.concat([bytes, bytes, bytes, bytes])]);
	});
	const rowTable = Buffer.alloc(values.length * (psb ? 4 : 2));
	rows.forEach((row, index) => (psb ? rowTable.writeUInt32BE(row.length, index * 4) : rowTable.writeUInt16BE(row.length, index * 2)));
	await writeFile(path, Buffer.concat([header, sections, compression, rowTable, ...rows]));
}

async function createHighDynamicRange(path: string, format: "hdr" | "exr"): Promise<void> {
	const width = 8;
	const height = 4;
	const pixels = new Float32Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 4;
			pixels[offset] = x + 0.25;
			pixels[offset + 1] = y + 0.5;
			pixels[offset + 2] = 4;
			pixels[offset + 3] = x % 2 ? 0.5 : 1;
		}
	}
	const image: IHighDynamicRangeImage = {
		format,
		width,
		height,
		channels: format === "exr" ? 4 : 3,
		hasAlpha: format === "exr",
		pixelType: format === "exr" ? "float32" : "rgbe8",
		compression: "raw",
		pixels,
		statistics: { minimum: [0, 0, 0, 0], maximum: [0, 0, 0, 0], average: [0, 0, 0, 0], nonFiniteCount: 0 },
	};
	await writeFile(path, format === "exr" ? encodeOpenExr(image) : encodeRadianceHdr(image));
}

describe("executed texture importer", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-texture-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("executes resize, alpha, compression, sampling, mip, and readable settings", async () => {
		const source = join(directory, "assets", "source.png");
		const output = join(directory, "build", "source.png");
		await createImage(source);
		const result = await processTextureImporterOutput(
			source,
			output,
			normalizeTextureImporterSettings({
				textureType: "normalMap",
				colorSpace: "sRGB",
				alphaSource: "none",
				generateMipmaps: true,
				maxSize: 128,
				resizeAlgorithm: "lanczos3",
				compression: "high",
				readable: true,
			})
		);
		expect(result).toMatchObject({
			resized: true,
			alphaRemoved: true,
			effectiveColorSpace: "linear",
			output: { width: 128, height: 64, channels: 3, hasAlpha: false },
			mipmaps: [
				{ width: 64, height: 32 },
				{ width: 32, height: 16 },
				{ width: 16, height: 8 },
				{ width: 8, height: 4 },
				{ width: 4, height: 2 },
				{ width: 2, height: 1 },
				{ width: 1, height: 1 },
			],
			processing: { outputFormat: "png", maxSizeApplied: true, nonPowerOfTwoApplied: false, fullMipChain: true },
		});
		expect(result.warnings[0]).toContain("sampled as linear");
		expect((await stat(result.readableBitmapPath!)).size).toBe(128 * 64 * 4);
		expect(await readJSON(result.readableDescriptorPath!)).toMatchObject({ width: 128, height: 64, channels: 4, pixelFormat: "rgba8" });
		expect((await Promise.all(result.mipmaps.map((mipmap) => pathExists(mipmap.path)))).every(Boolean)).toBe(true);
	});

	test("executes NPOT, grayscale alpha, full mip coverage, portable format, and sprite metadata together", async () => {
		const source = join(directory, "assets", "sprite.png");
		await createImage(source);
		const result = await processTextureImporterOutput(
			source,
			join(directory, "build", "sprite.png"),
			normalizeTextureImporterSettings({
				textureType: "sprite",
				outputFormat: "webp",
				alphaSource: "grayscale",
				alphaIsTransparency: true,
				nonPowerOfTwo: "toNearest",
				generateMipmaps: true,
				mipmapFilter: "box",
				mipmapPreserveCoverage: true,
				mipmapAlphaTestReference: 0.5,
				compression: "none",
				spritePixelsPerUnit: 64,
				spriteMeshType: "tight",
				spriteExtrude: 2,
			})
		);
		expect(result).toMatchObject({
			outputPath: expect.stringMatching(/sprite\.webp$/),
			output: { width: 256, height: 128, format: "webp", hasAlpha: true },
			processing: {
				outputFormat: "webp",
				nonPowerOfTwoApplied: true,
				fullMipChain: true,
				alphaDerivedFromGrayscale: true,
				mipmapCoveragePreserved: true,
			},
			sprite: { pixelsPerUnit: 64, meshType: "tight", extrude: 2, bounds: { x: 0, y: 0, width: 256, height: 128 } },
		});
		expect(result.mipmaps).toHaveLength(8);
		expect(result.mipmaps.every((mipmap) => mipmap.alphaCoverageBefore !== undefined && mipmap.alphaCoverageAfter !== undefined)).toBe(true);
	});

	test("leases and atomically publishes a complete preview artifact", async () => {
		const path = join(directory, "assets", "leased.png");
		await createImage(path);
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = { ...metadata.importer.settings, maxSize: 128, alphaSource: "none", readable: true };
		await writeAssetMetadata(path, metadata);
		const planned = await getTextureImporterArtifactStatus(path);
		expect(planned).toMatchObject({ current: false, exists: false });
		const applied = await applyTextureImporterArtifact(path, planned.fingerprint);
		expect(applied).toMatchObject({ current: true, result: { output: { width: 128, height: 64 }, alphaRemoved: true } });
		expect((await getTextureImporterArtifactStatus(path)).current).toBe(true);
		await remove(applied.result!.readableBitmapPath!);
		expect(await getTextureImporterArtifactStatus(path)).toMatchObject({ current: false, exists: true, result: null });

		metadata.importer.settings.compression = "high";
		await writeAssetMetadata(path, metadata);
		await expect(applyTextureImporterArtifact(path, planned.fingerprint)).rejects.toThrow("plan changed");
	});

	test("exposes the leased workflow through shared MCP actions with portable paths", async () => {
		const path = join(directory, "assets", "mcp.png");
		await createImage(path);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const planned = await getTextureImporterResult(scene, { path: "assets/mcp.png" });
		expect(planned).toMatchObject({ current: false, path: "assets/mcp.png", artifactPath: expect.stringContaining(".bjseditor/imported-assets/") });
		await expect(applyTextureImporter(scene, { path: "assets/mcp.png", expectedFingerprint: planned.fingerprint, confirm: false }, {} as any)).rejects.toThrow("confirm=true");
		const applied = await applyTextureImporter(scene, { path: "assets/mcp.png", expectedFingerprint: planned.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as any);
		expect(applied).toMatchObject({ applied: true, current: true, path: "assets/mcp.png", result: { output: { width: 300, height: 150 } } });
		scene.dispose();
		engine.dispose();
	});

	test("leases texture platform override mutation and executes distinct Web/Desktop editor outputs", async () => {
		const path = join(directory, "assets", "platform.png");
		await createImage(path);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const planned = await getTexturePlatformOverrides(scene, { path: "assets/platform.png" });
		expect(planned).toMatchObject({ overrides: {}, effective: { web: { overrideApplied: false }, desktop: { overrideApplied: false } } });
		const overrides = {
			web: { enabled: true, outputFormat: "webp", maxSize: 64, compression: "low", generateMipmaps: false, readable: false },
			desktop: { enabled: true, maxSize: 128, compression: "high", generateMipmaps: true, readable: true },
		};
		await expect(setTexturePlatformOverrides(scene, { path: "assets/platform.png", expectedFingerprint: "0".repeat(64), overrides }, {} as any)).rejects.toThrow(
			"plan changed"
		);
		const updated = await setTexturePlatformOverrides(scene, { path: "assets/platform.png", expectedFingerprint: planned.fingerprint, overrides }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as any);
		expect(updated).toMatchObject({ updated: true, current: false, effective: { web: { overrideApplied: true }, desktop: { overrideApplied: true } } });
		const scenePath = join(directory, "public", "scene");
		const baseOptions = { optimize: false, scenePath, projectDir: directory, exportedAssets: [], cache: {} };
		await processAssetFile({} as any, path, { ...baseOptions, assetPlatform: "web" });
		expect(await readJSON(join(scenePath, "assets", "platform.png.bjstexture.json"))).toMatchObject({
			outputPath: "assets/platform.webp",
			result: { platform: "web", platformOverrideApplied: true, processing: { outputFormat: "webp" }, output: { width: 64, height: 32 }, mipmaps: [] },
		});
		expect(await pathExists(join(scenePath, "assets", "platform.webp"))).toBe(true);
		await processAssetFile({} as any, path, { ...baseOptions, exportedAssets: [], assetPlatform: "desktop" });
		expect(await readJSON(join(scenePath, "assets", "platform.png.bjstexture.json"))).toMatchObject({
			result: { platform: "desktop", platformOverrideApplied: true, output: { width: 128, height: 64 }, readablePixelFormat: "rgba8" },
		});
		const metadata = await readAssetMetadata(path);
		expect(metadata.importer.settings.platformOverrides).toBe(serializeTextureImporterPlatformOverrides(overrides));
		scene.dispose();
		engine.dispose();
	});

	test("publishes portable editor-build output and runtime metadata", async () => {
		const path = join(directory, "assets", "build.bmp");
		await createImage(path);
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = {
			...metadata.importer.settings,
			textureType: "lightmap",
			colorSpace: "sRGB",
			alphaSource: "none",
			maxSize: 128,
			readable: true,
		};
		await writeAssetMetadata(path, metadata);
		const scenePath = join(directory, "public", "scene");
		const exportedAssets: string[] = [];
		await processAssetFile({} as any, path, { optimize: false, scenePath, projectDir: directory, exportedAssets, cache: {} });
		const sidecarPath = join(scenePath, "assets", "build.bmp.bjstexture.json");
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({
			version: 2,
			outputPath: "assets/build.png",
			textureType: "lightmap",
			colorSpace: "linear",
			alphaSource: "none",
			filterMode: "trilinear",
			wrapModeU: "repeat",
			wrapModeV: "repeat",
			anisoLevel: 1,
			readableBitmapPath: "assets/build.png.rgba",
			result: { output: { width: 128, height: 64, channels: 3 } },
		});
		expect(await pathExists(join(scenePath, sidecar.outputPath))).toBe(true);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(scenePath, "assets", "build.png"), sidecarPath]));
	});

	test("decodes RLE TGA through preview, shared MCP, and the real editor build", async () => {
		const path = join(directory, "assets", "source.tga");
		await createTga(path);
		expect(getAssetTypeFromPath(path)).toBe("texture");
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const planned = await getTextureImporterResult(scene, { path: "assets/source.tga" });
		const applied = await applyTextureImporter(scene, { path: "assets/source.tga", expectedFingerprint: planned.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as any);
		expect(applied).toMatchObject({
			applied: true,
			current: true,
			result: {
				converted: true,
				source: { format: "tga", width: 4, height: 2, channels: 4, hasAlpha: true },
				output: { format: "png", width: 4, height: 2 },
			},
		});
		const decoded = await sharp(join(directory, applied.result.outputPath)).ensureAlpha().raw().toBuffer();
		expect([...decoded.subarray(0, 4)]).toEqual([30, 20, 10, 128]);
		expect([...decoded.subarray(4 * 4, 4 * 4 + 4)]).toEqual([100, 150, 200, 255]);
		const material = new StandardMaterial("TGA Material", scene);
		const assigned = await assignTextureToMaterial(scene, { materialId: material.id, channel: "diffuseTexture", texturePath: "assets/source.tga" }, {
			editor: { layout: { inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined } } },
		} as any);
		expect(assigned).toMatchObject({ channel: "diffuseTexture", texture: "assets/source.tga" });
		expect(material.diffuseTexture).toMatchObject({ name: "assets/source.tga", url: "assets/source.tga", metadata: { babylonEditorAuthoredTexturePath: "assets/source.tga" } });

		const scenePath = join(directory, "public", "scene");
		const exportedAssets: string[] = [];
		await processAssetFile({} as any, path, { optimize: false, scenePath, projectDir: directory, exportedAssets, cache: {} });
		const sidecarPath = join(scenePath, "assets", "source.tga.bjstexture.json");
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({ outputPath: "assets/source.png", result: { source: { format: "tga" }, output: { format: "png" } } });
		expect(await pathExists(join(scenePath, "assets", "source.png"))).toBe(true);
		scene.dispose();
		engine.dispose();
	});

	test.each([
		["psd", false, 8],
		["psb", true, 8],
		["psd", false, 16],
		["psb", true, 16],
		["psd", false, 32],
		["psb", true, 32],
	] as const)("decodes a merged RLE %s at %i-bit through preview, shared MCP, material assignment, and the real editor build", async (format, psb, depth) => {
		const assetPath = `assets/source.${format}`;
		const path = join(directory, assetPath);
		await createPsd(path, psb, depth);
		expect(getAssetTypeFromPath(path)).toBe("texture");
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const planned = await getTextureImporterResult(scene, { path: assetPath });
		const applied = await applyTextureImporter(scene, { path: assetPath, expectedFingerprint: planned.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as any);
		expect(applied).toMatchObject({
			applied: true,
			current: true,
			result: {
				converted: true,
				source: { format, width: 4, height: 2, channels: 4, hasAlpha: true },
				output: { format: "png", width: 4, height: 2 },
				warnings: [
					expect.stringContaining(
						` ${depth}-bit source imported from its merged rle composite through ${
							depth === 32 ? "bounded-linear-float32-to-rgba8-v1" : depth === 16 ? "bounded-uint16-to-rgba8-v1" : "identity-uint8"
						}`
					),
				],
			},
		});
		const decoded = await sharp(join(directory, applied.result.outputPath)).ensureAlpha().raw().toBuffer();
		expect([...decoded.subarray(0, 4)]).toEqual([10, 20, 30, 128]);
		expect([...decoded.subarray(4 * 4, 4 * 4 + 4)]).toEqual([100, 150, 200, 255]);
		const material = new StandardMaterial(`${format.toUpperCase()} Material`, scene);
		const assigned = await assignTextureToMaterial(scene, { materialId: material.id, channel: "diffuseTexture", texturePath: assetPath }, {
			editor: { layout: { inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined } } },
		} as any);
		expect(assigned).toMatchObject({ channel: "diffuseTexture", texture: assetPath });
		expect(material.diffuseTexture).toMatchObject({
			name: assetPath,
			url: assetPath,
			metadata: { babylonEditorAuthoredTexturePath: assetPath },
		});

		const scenePath = join(directory, "public", "scene");
		const exportedAssets: string[] = [];
		await processAssetFile({} as any, path, { optimize: false, scenePath, projectDir: directory, exportedAssets, cache: {} });
		const sidecarPath = join(scenePath, "assets", `source.${format}.bjstexture.json`);
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({ outputPath: "assets/source.png", result: { source: { format }, output: { format: "png" } } });
		expect(await pathExists(join(scenePath, "assets", "source.png"))).toBe(true);
		scene.dispose();
		engine.dispose();
	});

	test.each(["hdr", "exr"] as const)("executes linear %s import with tone-mapped and cubemap evidence through MCP and editor build", async (format) => {
		const path = join(directory, "assets", `source.${format}`);
		await createHighDynamicRange(path, format);
		expect(getAssetTypeFromPath(path)).toBe("cube-texture");
		const metadata = await readAssetMetadata(path);
		metadata.importer.settings = { ...metadata.importer.settings, colorSpace: "sRGB", readable: true };
		await writeAssetMetadata(path, metadata);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const planned = await getTextureImporterResult(scene, { path: `assets/source.${format}` });
		const applied = await applyTextureImporter(scene, { path: `assets/source.${format}`, expectedFingerprint: planned.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as any);
		expect(applied).toMatchObject({
			applied: true,
			current: true,
			result: {
				effectiveColorSpace: "linear",
				source: { format, width: 8, height: 4, space: "linear" },
				output: { format, width: 8, height: 4, space: "linear" },
				readablePixelFormat: "rgba32f",
				highDynamicRange: { equirectangular: true, cubeFaceSize: 16 },
			},
		});
		expect(applied.result.highDynamicRange.cubeFaces).toEqual(expect.arrayContaining([expect.objectContaining({ face: "px", width: 16, height: 16 })]));
		expect(applied.result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("linear high-dynamic-range")]));
		expect((await stat(join(directory, applied.result.readableBitmapPath))).size).toBe(8 * 4 * 4 * 4);
		expect(await pathExists(join(directory, applied.result.previewPath))).toBe(true);
		expect((await Promise.all(applied.result.highDynamicRange.cubeFaces.map((face: any) => pathExists(join(directory, face.path))))).every(Boolean)).toBe(true);

		const scenePath = join(directory, "public", "scene");
		const exportedAssets: string[] = [];
		await processAssetFile({} as any, path, { optimize: false, scenePath, projectDir: directory, exportedAssets, cache: {} });
		const sidecarPath = join(scenePath, "assets", `source.${format}.bjstexture.json`);
		const sidecar = await readJSON(sidecarPath);
		expect(sidecar).toMatchObject({
			outputPath: `assets/source.${format}`,
			previewPath: `assets/source.${format}.preview.png`,
			colorSpace: "linear",
			result: { readablePixelFormat: "rgba32f", highDynamicRange: { equirectangular: true, cubeFaces: expect.any(Array) } },
		});
		const expectedEnvironmentPath = format === "exr" ? "assets/source.exr.environment.hdr" : "assets/source.hdr";
		expect(sidecar.environmentPath).toBe(expectedEnvironmentPath);
		expect(await pathExists(join(scenePath, expectedEnvironmentPath))).toBe(true);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(scenePath, `assets/source.${format}`), join(scenePath, `assets/source.${format}.preview.png`), sidecarPath]));
		scene.dispose();
		engine.dispose();
	});

	test("skips a file mislabeled as an image without blocking the build", async () => {
		const path = join(directory, "assets", "broken.png");
		const scenePath = join(directory, "public", "scene");
		const exportedAssets: string[] = [];
		const cache: Record<string, string> = {};
		const warn = vi.fn();
		await writeFile(path, "this is not image data");

		await expect(
			processAssetFile({ layout: { console: { warn } } } as any, path, { optimize: false, scenePath, projectDir: directory, exportedAssets, cache })
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipped invalid image asset "assets/broken.png"'));
		expect(cache).not.toHaveProperty("assets/broken.png");
		expect(exportedAssets).toEqual([]);
		expect(await pathExists(join(scenePath, "assets", "broken.png"))).toBe(false);
	});
});

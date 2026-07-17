import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, stat, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";
import { normalizeTextureImporterSettings } from "babylonjs-editor-tools";

import { applyTextureImporterArtifact, getTextureImporterArtifactStatus, processTextureImporterOutput } from "../../src/mcp/assets/texture-importer";
import { applyTextureImporter, getTextureImporterResult } from "../../src/mcp/assets/assets";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";
import { processAssetFile } from "../../src/project/export/assets";

async function createImage(path: string): Promise<void> {
	await sharp({ create: { width: 300, height: 150, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 0.5 } } })
		.png()
		.toFile(path);
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
				{ width: 85, height: 42 },
				{ width: 42, height: 21 },
			],
		});
		expect(result.warnings[0]).toContain("sampled as linear");
		expect((await stat(result.readableBitmapPath!)).size).toBe(128 * 64 * 4);
		expect(await readJSON(result.readableDescriptorPath!)).toMatchObject({ width: 128, height: 64, channels: 4, pixelFormat: "rgba8" });
		expect((await Promise.all(result.mipmaps.map((mipmap) => pathExists(mipmap.path)))).every(Boolean)).toBe(true);
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
			version: 1,
			outputPath: "assets/build.png",
			textureType: "lightmap",
			colorSpace: "linear",
			alphaSource: "none",
			readableBitmapPath: "assets/build.png.rgba",
			result: { output: { width: 128, height: 64, channels: 3 } },
		});
		expect(await pathExists(join(scenePath, sidecar.outputPath))).toBe(true);
		expect(exportedAssets).toEqual(expect.arrayContaining([join(scenePath, "assets", "build.png"), sidecarPath]));
	});
});

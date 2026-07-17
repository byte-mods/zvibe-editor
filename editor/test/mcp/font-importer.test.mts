import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, pathExists, readFile, readJSON, remove, stat, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import sharp from "sharp";
import { Scene } from "babylonjs";
import { normalizeFontImporterSettings } from "babylonjs-editor-tools";

import { applyFontImporterArtifact, getFontImporterArtifactStatus, processFontImporterOutput } from "../../src/mcp/assets/font-importer";
import { applyFontImporter, getFontImporterResult } from "../../src/mcp/assets/assets";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

const fixture = join(import.meta.dirname, "../../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");

describe("executed font importer", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let source: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-font-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		source = join(directory, "assets", "game.ttf");
		await copyFile(fixture, source);
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("generates dynamic, bitmap, SDF, and genuine multi-channel MSDF artifacts", async () => {
		const baseSettings = normalizeFontImporterSettings({
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "AVgΩ",
			fontSize: 48,
			padding: 4,
			distanceRange: 6,
		});
		const dynamic = await processFontImporterOutput(source, join(directory, "dynamic", "game.ttf"), { ...baseSettings, renderMode: "dynamic" });
		expect(dynamic).toMatchObject({ renderMode: "dynamic", glyphCount: 0, pages: [], dynamicFontPath: expect.stringMatching(/game\.ttf$/) });
		expect((await stat(dynamic.dynamicFontPath!)).size).toBe((await stat(source)).size);

		const bitmap = await processFontImporterOutput(source, join(directory, "bitmap", "game.ttf"), { ...baseSettings, renderMode: "bitmap" });
		const sdf = await processFontImporterOutput(source, join(directory, "sdf", "game.ttf"), { ...baseSettings, renderMode: "sdf" });
		const msdf = await processFontImporterOutput(source, join(directory, "msdf", "game.ttf"), baseSettings);
		for (const result of [bitmap, sdf, msdf]) {
			expect(result.glyphCount).toBeGreaterThanOrEqual(3);
			expect(result.pages).toHaveLength(1);
			expect(await pathExists(result.manifestPath)).toBe(true);
			expect(await readJSON(result.manifestPath)).toMatchObject({
				version: 1,
				renderMode: result.renderMode,
				fontSize: 48,
				padding: 4,
				distanceRange: 6,
				pages: ["game.font-0.png"],
				characters: expect.arrayContaining([expect.objectContaining({ id: 65, char: "A", page: 0 })]),
			});
		}

		const bitmapPixels = await sharp(bitmap.pages[0].path).ensureAlpha().raw().toBuffer();
		for (let offset = 0; offset < bitmapPixels.length; offset += 4) {
			expect(bitmapPixels[offset]).toBe(255);
			expect(bitmapPixels[offset + 1]).toBe(255);
			expect(bitmapPixels[offset + 2]).toBe(255);
		}
		const sdfPixels = await sharp(sdf.pages[0].path).ensureAlpha().raw().toBuffer();
		for (let offset = 0; offset < sdfPixels.length; offset += 4) {
			expect(sdfPixels[offset]).toBe(sdfPixels[offset + 1]);
			expect(sdfPixels[offset + 1]).toBe(sdfPixels[offset + 2]);
		}
		const msdfPixels = await sharp(msdf.pages[0].path).ensureAlpha().raw().toBuffer();
		expect(
			Array.from({ length: msdfPixels.length / 4 }, (_, index) => index * 4).some(
				(offset) => msdfPixels[offset] !== msdfPixels[offset + 1] || msdfPixels[offset + 1] !== msdfPixels[offset + 2]
			)
		).toBe(true);
	});

	test("leases, applies, invalidates, and exposes font artifacts through MCP", async () => {
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = {
			...metadata.importer.settings,
			renderMode: "msdf",
			characterSet: "custom",
			customCharacters: "Babylon 361",
			fontSize: 40,
			distanceRange: 5,
		};
		await writeAssetMetadata(source, metadata);

		const planned = await getFontImporterArtifactStatus(source);
		expect(planned).toMatchObject({ current: false, exists: false, result: null });
		const applied = await applyFontImporterArtifact(source, planned.fingerprint);
		expect(applied).toMatchObject({
			current: true,
			result: { renderMode: "msdf", glyphCount: expect.any(Number), pages: [expect.objectContaining({ width: expect.any(Number) })] },
		});
		expect(await pathExists(applied.result!.manifestPath)).toBe(true);

		metadata.importer.settings.fontSize = 44;
		await writeAssetMetadata(source, metadata);
		expect(await getFontImporterArtifactStatus(source)).toMatchObject({ current: false, exists: true });
		await expect(applyFontImporterArtifact(source, planned.fingerprint)).rejects.toThrow("plan changed");

		const scene = {} as Scene;
		const mcpPlan = await getFontImporterResult(scene, { path: "assets/game.ttf" });
		expect(mcpPlan).toMatchObject({ current: false, path: "assets/game.ttf", artifactDirectory: expect.stringContaining(".bjseditor/imported-assets/") });
		await expect(applyFontImporter(scene, { path: "assets/game.ttf", expectedFingerprint: mcpPlan.fingerprint, confirm: false }, {} as never)).rejects.toThrow("confirm=true");
		const refresh = vi.fn();
		const mcpResult = await applyFontImporter(scene, { path: "assets/game.ttf", expectedFingerprint: mcpPlan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh } } },
		} as never);
		expect(mcpResult).toMatchObject({
			applied: true,
			current: true,
			result: { sourcePath: "assets/game.ttf", outputDirectory: expect.stringContaining(".bjseditor/imported-assets/"), renderMode: "msdf" },
		});
		expect(JSON.stringify(mcpResult)).not.toContain(directory);
		expect(refresh).toHaveBeenCalledOnce();
		expect(await readFile(join(directory, mcpResult.manifestPath), "utf-8")).toContain(mcpResult.fingerprint);
	});
});

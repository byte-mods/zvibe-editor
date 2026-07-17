import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, pathExists, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { convertImageAsset, listAssets } from "../../src/mcp/assets/assets";
import { compareVisualRegressionImages } from "../../src/mcp/testing/tests";

describe("mcp/svg-assets", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-svg-assets-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await writeFile(join(directory, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="#ff0000"/></svg>');
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("classifies SVG as a texture and rasterizes it to PNG and portable bitmap", async () => {
		expect((await listAssets(scene, { folder: "." })).assets).toEqual(expect.arrayContaining([expect.objectContaining({ path: "icon.svg", type: "texture" })]));
		expect(await convertImageAsset(scene, { sourcePath: "icon.svg", outputPath: "assets/icon.png", format: "png", width: 24 }, options)).toMatchObject({
			width: 24,
			height: 16,
		});
		expect(await pathExists(join(directory, "assets/icon.png"))).toBe(true);
		const bitmap = await convertImageAsset(scene, { sourcePath: "icon.svg", outputPath: "assets/icon.rgba", format: "bitmap", width: 6, height: 4 }, options);
		expect(bitmap).toMatchObject({ width: 6, height: 4, bitmapDescriptorPath: "assets/icon.rgba.json" });
		expect(await readJSON(join(directory, "assets/icon.rgba.json"))).toMatchObject({ width: 6, height: 4, pixelFormat: "rgba8" });
	});

	test("compares visual baselines with deterministic tolerance", async () => {
		await convertImageAsset(scene, { sourcePath: "icon.svg", outputPath: "baseline.png", format: "png" }, options);
		await convertImageAsset(scene, { sourcePath: "icon.svg", outputPath: "candidate.png", format: "png" }, options);
		expect(await compareVisualRegressionImages(scene, { baselinePath: "baseline.png", candidatePath: "candidate.png" }, options)).toMatchObject({
			passed: true,
			differingPixels: 0,
		});
		await writeFile(join(directory, "changed.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="#0000ff"/></svg>');
		await convertImageAsset(scene, { sourcePath: "changed.svg", outputPath: "changed.png", format: "png" }, options);
		expect(await compareVisualRegressionImages(scene, { baselinePath: "baseline.png", candidatePath: "changed.png", diffPath: "assets/diff.png" }, options)).toMatchObject({
			passed: false,
			diffPath: "assets/diff.png",
		});
		expect(await pathExists(join(directory, "assets/diff.png"))).toBe(true);
	});
});

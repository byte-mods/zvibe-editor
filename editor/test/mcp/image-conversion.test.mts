import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";

vi.mock("babylonjs-editor-tools", async () => import("../../../tools/src/assets/importers"));

import { convertImageAsset } from "../../src/mcp/assets/assets";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/image-conversion", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "babylon-image-conversion-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
			.png()
			.toFile(join(projectDirectory, "source.png"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		scene.dispose();
		engine.dispose();
		await remove(projectDirectory);
	});

	test("converts an image to portable RGBA8 bytes with a descriptor", async () => {
		const result = await convertImageAsset(scene, { sourcePath: "source.png", outputPath: "assets/source-bitmap.rgba", format: "bitmap" }, options);
		expect(result).toMatchObject({ format: "bitmap", width: 3, height: 2, sizeBytes: 24, bitmapDescriptorPath: "assets/source-bitmap.rgba.json" });
		const descriptor = await readJSON(join(projectDirectory, "assets/source-bitmap.rgba.json"));
		expect(descriptor).toMatchObject({ width: 3, height: 2, channels: 4, pixelFormat: "rgba8", byteLength: 24 });
	});
});

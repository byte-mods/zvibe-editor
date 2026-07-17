import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";
import { TerrainMaterial } from "babylonjs-materials";

vi.mock("babylonjs-editor-tools", () => ({}));

import { paintTerrainLayer } from "../../src/mcp/materials/materials";
import { projectConfiguration } from "../../src/project/configuration";
import { addTerrainMaterial } from "../../src/project/add/material";

describe("mcp/terrain-painting", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = { editor: { layout: { assets: { refresh: vi.fn() }, inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "babylon-terrain-paint-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Terrain.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		scene.dispose();
		engine.dispose();
		await remove(projectDirectory);
	});

	test("creates a persisted splat map, normalizes RGB weights, and assigns it to the terrain material", async () => {
		const material = addTerrainMaterial(scene);
		expect(material).toBeInstanceOf(TerrainMaterial);

		const result = await paintTerrainLayer(
			scene,
			{ materialId: material.id, outputPath: "assets/terrain/splat.png", center: [0.5, 0.5], radius: 0.5, strength: 1, layer: 1, width: 17, height: 17 },
			options
		);

		expect(result).toMatchObject({ outputPath: "assets/terrain/splat.png", width: 17, height: 17, layer: 1 });
		expect(result.changedPixels).toBeGreaterThan(0);
		expect(material.mixTexture).toBeTruthy();
		expect(material.metadata.babylonEditorTerrainSplatMap.lastBrush).toMatchObject({ layer: 1, strength: 1 });

		const output = await readFile(join(projectDirectory, "assets/terrain/splat.png"));
		const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
		const centre = ((8 * 17 + 8) * 4) as number;
		expect(decoded.data[centre]).toBe(0);
		expect(decoded.data[centre + 1]).toBe(255);
		expect(decoded.data[centre + 2]).toBe(0);
		expect(decoded.data[centre] + decoded.data[centre + 1] + decoded.data[centre + 2]).toBe(255);
	});
});

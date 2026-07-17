import { ensureDir, mkdtemp, pathExists, readJSON, remove, writeJSON } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import { NodeMaterial, NullEngine, Scene } from "babylonjs";
import { normalizeMaterialImporterSettings } from "babylonjs-editor-tools";
import { afterEach, describe, expect, test } from "vitest";

import { processExportedMaterialImporter } from "../src/pack/assets/material.mjs";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKVQAAAABJRU5ErkJggg==";

describe("CLI executed material importer", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("extracts embedded textures from standard PBR materials with the portable SHA-256 naming contract", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-material-"));
		directories.push(project);
		const source = join(project, "assets", "surface.material");
		const output = join(project, "public", "scene", "assets", "surface.material");
		await ensureDir(join(project, "assets"));
		await writeJSON(source, {
			customType: "BABYLON.PBRMaterial",
			albedoTexture: { name: ONE_PIXEL_PNG, url: ONE_PIXEL_PNG, coordinatesMode: 0 },
		});
		const result = await processExportedMaterialImporter(
			source,
			output,
			join(project, "public", "scene"),
			project,
			normalizeMaterialImporterSettings({ validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true })
		);
		expect(result).toMatchObject({
			sourceKind: "babylon-material",
			valid: true,
			extractedTextures: [expect.stringMatching(/^assets\/editor-generated_extracted-textures\/[a-f0-9]{64}\.png$/)],
			compile: { requested: true, attempted: false, valid: null },
		});
		expect(await pathExists(join(project, "public", "scene", result.extractedTextures[0]))).toBe(true);
		expect(JSON.stringify(await readJSON(output))).not.toContain("data:image");
	});

	test("compiles a real Babylon Node Material graph during CLI export", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-node-material-"));
		directories.push(project);
		const source = join(project, "assets", "graph.material");
		const output = join(project, "public", "scene", "assets", "graph.material");
		await ensureDir(join(project, "assets"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const material = new NodeMaterial("CLI Graph", scene);
		material.setToDefault();
		await writeJSON(source, material.serialize());
		material.dispose();
		scene.dispose();
		engine.dispose();

		const result = await processExportedMaterialImporter(
			source,
			output,
			join(project, "public", "scene"),
			project,
			normalizeMaterialImporterSettings({ validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true })
		);
		expect(result).toMatchObject({
			sourceKind: "node-material",
			valid: true,
			compile: {
				requested: true,
				attempted: true,
				valid: true,
				statistics: { outputBlockCount: 2, compiledShaderCharacters: expect.any(Number) },
			},
		});
		expect(result.compile.statistics!.compiledShaderCharacters).toBeGreaterThan(0);
	});
});

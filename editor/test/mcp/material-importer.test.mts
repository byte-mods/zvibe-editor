import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NodeMaterial, NullEngine, Scene } from "babylonjs";
import { normalizeMaterialImporterSettings } from "babylonjs-editor-tools";

import { applyMaterialImporterArtifact, getMaterialImporterArtifactStatus, processMaterialImporterOutput } from "../../src/mcp/assets/material-importer";
import { applyMaterialImporter, getMaterialImporterResult } from "../../src/mcp/assets/assets";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKVQAAAABJRU5ErkJggg==";

function defaultNodeMaterialData(): Record<string, unknown> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const material = new NodeMaterial("Importer Node Material", scene);
	material.setToDefault();
	const data = material.serialize();
	material.dispose();
	scene.dispose();
	engine.dispose();
	return data;
}

describe("executed material importer", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-material-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("extracts embedded textures, reports missing references, and preserves a portable material copy", async () => {
		const source = join(directory, "assets", "surface.material");
		await writeJSON(source, {
			customType: "BABYLON.PBRMaterial",
			albedoTexture: { name: ONE_PIXEL_PNG, url: ONE_PIXEL_PNG, coordinatesMode: 0 },
			bumpTexture: { name: "assets/missing-normal.png", url: "assets/missing-normal.png", samplingMode: 3 },
		});
		const outputRoot = join(directory, "build");
		const result = await processMaterialImporterOutput(
			source,
			join(outputRoot, "assets", "surface.material"),
			outputRoot,
			directory,
			normalizeMaterialImporterSettings({ validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true })
		);
		expect(result).toMatchObject({
			sourceKind: "babylon-material",
			valid: false,
			missingTextures: ["assets/missing-normal.png"],
			extractedTextures: [expect.stringMatching(/^assets\/editor-generated_extracted-textures\/[a-f0-9]{64}\.png$/)],
			compile: { requested: true, attempted: false, valid: null },
		});
		expect(await pathExists(join(outputRoot, result.extractedTextures[0]))).toBe(true);
		const output = await readJSON(result.outputPath);
		expect(output.albedoTexture.name).toBe(result.extractedTextures[0]);
		expect(JSON.stringify(output)).not.toContain("data:image");
	});

	test("compiles Node Materials and validates Wavefront MTL texture references", async () => {
		const nodePath = join(directory, "assets", "graph.material");
		await writeJSON(nodePath, defaultNodeMaterialData());
		const compiled = await processMaterialImporterOutput(
			nodePath,
			join(directory, "build", "assets", "graph.material"),
			join(directory, "build"),
			directory,
			normalizeMaterialImporterSettings({ validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true })
		);
		expect(compiled).toMatchObject({
			sourceKind: "node-material",
			valid: true,
			compile: { attempted: true, valid: true, statistics: { attachedBlockCount: expect.any(Number), outputBlockCount: 2, compiledShaderCharacters: expect.any(Number) } },
		});
		expect(compiled.compile.statistics!.compiledShaderCharacters).toBeGreaterThan(0);

		await mkdir(join(directory, "assets", "textures"));
		await writeFile(join(directory, "assets", "textures", "albedo.png"), "texture");
		const mtlPath = join(directory, "assets", "body.mtl");
		await writeFile(mtlPath, "newmtl Body\nmap_Kd textures/albedo.png\nmap_Bump textures/missing.png\n");
		const mtl = await processMaterialImporterOutput(
			mtlPath,
			join(directory, "build", "assets", "body.mtl"),
			join(directory, "build"),
			directory,
			normalizeMaterialImporterSettings({ validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true })
		);
		expect(mtl).toMatchObject({
			sourceKind: "mtl",
			valid: false,
			missingTextures: ["assets/textures/missing.png"],
			compile: { attempted: false },
		});
		expect(await readFile(mtl.outputPath, "utf-8")).toContain("map_Kd textures/albedo.png");
	});

	test("leases, invalidates, and applies valid Node Material evidence through MCP", async () => {
		const source = join(directory, "assets", "leased.material");
		await writeJSON(source, defaultNodeMaterialData());
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = { ...metadata.importer.settings, validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true };
		await writeAssetMetadata(source, metadata);
		const planned = await getMaterialImporterArtifactStatus(source);
		expect(planned).toMatchObject({ current: false, exists: false });
		const applied = await applyMaterialImporterArtifact(source, planned.fingerprint);
		expect(applied).toMatchObject({ current: true, result: { valid: true, sourceKind: "node-material", compile: { valid: true } } });

		const changed = await readJSON(source);
		changed.name = "Changed";
		await writeJSON(source, changed);
		expect(await getMaterialImporterArtifactStatus(source)).toMatchObject({ current: false, exists: true });
		await expect(applyMaterialImporterArtifact(source, planned.fingerprint)).rejects.toThrow("plan changed");

		const scene = {} as Scene;
		const mcpPlan = await getMaterialImporterResult(scene, { path: "assets/leased.material" });
		await expect(applyMaterialImporter(scene, { path: "assets/leased.material", expectedFingerprint: mcpPlan.fingerprint, confirm: false }, {} as never)).rejects.toThrow(
			"confirm=true"
		);
		const refresh = vi.fn();
		const mcpResult = await applyMaterialImporter(scene, { path: "assets/leased.material", expectedFingerprint: mcpPlan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh } } },
		} as never);
		expect(mcpResult).toMatchObject({ applied: true, current: true, result: { sourcePath: "assets/leased.material", valid: true, compile: { valid: true } } });
		expect(JSON.stringify(mcpResult)).not.toContain(directory);
		expect(refresh).toHaveBeenCalledOnce();
	});
});

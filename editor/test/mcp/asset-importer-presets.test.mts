import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", async () => import("../../../tools/src/assets/importers"));

import {
	applyAssetImporterPreset,
	getAssetByGuid,
	getAssetDependencies,
	getAssetImportStatus,
	getAssetImporter,
	importAsset,
	listAssetImportDiagnostics,
	listAssetImporterPresets,
	listAssetImporterTypes,
	moveAsset,
	refreshAssetImportStates,
	reimportAsset,
	setAssetImporterPreset,
	setAssetImporterSettings,
	setAssetOrganization,
	validateAssetImporterSettings,
} from "../../src/mcp/assets/assets";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/asset importer presets", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "babylon-importer-presets-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await writeFile(join(projectDirectory, "texture.png"), "texture bytes");
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		scene.dispose();
		engine.dispose();
		await remove(projectDirectory);
	});

	test("persists and batch-applies extension-filtered importer settings without replacing GUIDs", async () => {
		await setAssetImporterPreset(scene, { name: "Mobile Texture", importer: { maxSize: 1024, compression: "high" }, labels: ["mobile"], extensions: ["png"] });
		expect((await listAssetImporterPresets()).presets).toHaveLength(1);
		const result = await applyAssetImporterPreset(scene, { name: "Mobile Texture", paths: ["texture.png"] }, options);
		expect(result).toMatchObject({ preset: "Mobile Texture", applied: ["texture.png"] });
		const metadata = await readJSON(join(projectDirectory, "texture.png.bjsmeta.json"));
		expect(metadata).toMatchObject({ labels: ["mobile"], importer: { version: 1, kind: "texture", settings: { maxSize: 1024, compression: "high" } } });
		expect(typeof metadata.guid).toBe("string");
		await expect(applyAssetImporterPreset(scene, { name: "Mobile Texture", paths: ["Game.bjseditor"] }, options)).rejects.toThrow("does not support");
	});

	test("discovers, validates, and atomically applies type-specific importer settings", async () => {
		expect(listAssetImporterTypes().importers.map((importer: any) => importer.kind)).toEqual(["texture", "model", "audio", "video", "font", "material", "animation", "custom"]);
		await setAssetImporterSettings(scene, { paths: ["texture.png"], settings: { maxSize: 1024, generateMipmaps: false, textureType: "normalMap" } }, options);
		expect(await getAssetImporter(scene, { path: "texture.png" })).toMatchObject({
			inferredKind: "texture",
			importer: { version: 1, kind: "texture", settings: { maxSize: 1024, generateMipmaps: false, textureType: "normalMap" } },
		});
		expect(await validateAssetImporterSettings(scene, { path: "texture.png", settings: { maxSize: 2048 } })).toMatchObject({
			valid: true,
			importer: { settings: { maxSize: 2048 } },
		});
		await expect(setAssetImporterSettings(scene, { paths: ["texture.png"], settings: { maxSize: 1000 } }, options)).rejects.toThrow("power of two");
		expect((await getAssetImporter(scene, { path: "texture.png" })).importer.settings.maxSize).toBe(1024);
	});

	test("finds direct and reverse project text-asset references without inferring binary content", async () => {
		await mkdir(join(projectDirectory, "assets"));
		await writeFile(join(projectDirectory, "assets", "tree.glb"), "not parsed as text");
		await writeFile(join(projectDirectory, "scene.json"), JSON.stringify({ mesh: "assets/tree.glb" }));

		expect(await getAssetDependencies(scene, { path: "scene.json" })).toMatchObject({ path: "scene.json", direction: "dependencies", references: ["assets/tree.glb"] });
		expect(await getAssetDependencies(scene, { path: "assets/tree.glb", direction: "referencedBy" })).toMatchObject({
			path: "assets/tree.glb",
			direction: "referencedBy",
			references: ["scene.json"],
		});
	});

	test("finds local image dependencies in validated GLB JSON chunks", async () => {
		await mkdir(join(projectDirectory, "assets"));
		await writeFile(join(projectDirectory, "assets", "albedo.png"), "texture bytes");
		const json = Buffer.from(
			JSON.stringify({
				asset: { version: "2.0" },
				images: [{ uri: "albedo.png" }, { uri: "data:image/png;base64,AAAA" }],
				buffers: [{ uri: "https://example.invalid/model.bin" }],
			})
		);
		const paddedLength = Math.ceil(json.length / 4) * 4;
		const glb = Buffer.alloc(20 + paddedLength, 0x20);
		glb.writeUInt32LE(0x46546c67, 0);
		glb.writeUInt32LE(2, 4);
		glb.writeUInt32LE(glb.length, 8);
		glb.writeUInt32LE(paddedLength, 12);
		glb.writeUInt32LE(0x4e4f534a, 16);
		json.copy(glb, 20);
		await writeFile(join(projectDirectory, "assets", "model.glb"), glb);

		expect(await getAssetDependencies(scene, { path: "assets/model.glb" })).toMatchObject({ references: ["assets/albedo.png"], scannedBinaryGlbFiles: 1 });
		expect(await getAssetDependencies(scene, { path: "assets/albedo.png", direction: "referencedBy" })).toMatchObject({
			references: ["assets/model.glb"],
			scannedBinaryGlbFiles: 1,
		});
	});

	test("moves an asset while preserving sidecar metadata and migrating project text references", async () => {
		await mkdir(join(projectDirectory, "assets"));
		await writeFile(join(projectDirectory, "assets", "tree.glb"), "binary content");
		await writeFile(join(projectDirectory, "assets", "tree.glb.bjsmeta.json"), JSON.stringify({ guid: "tree-guid", labels: [], importer: {} }));
		await writeFile(join(projectDirectory, "scene.json"), JSON.stringify({ mesh: "assets/tree.glb" }));
		await writeFile(join(projectDirectory, "src.ts"), 'const meshPath = "assets/tree.glb"; const backupPath = "assets/tree.glb.backup";');
		const assetBrowser = { refresh: vi.fn(), handleFileRenamed: vi.fn() };

		const result = await moveAsset(scene, { sourcePath: "assets/tree.glb", destinationPath: "assets/environment/tree.glb" }, {
			editor: { layout: { assets: assetBrowser } },
		} as any);

		expect(result).toMatchObject({ moved: true, updatedTextReferences: ["scene.json", "src.ts"] });
		expect(await readFile(join(projectDirectory, "scene.json"), "utf-8")).toContain("assets/environment/tree.glb");
		const source = await readFile(join(projectDirectory, "src.ts"), "utf-8");
		expect(source).toContain("assets/environment/tree.glb");
		expect(source).toContain("assets/tree.glb.backup");
		expect(await readJSON(join(projectDirectory, "assets", "environment", "tree.glb.bjsmeta.json"))).toMatchObject({ guid: "tree-guid" });
		expect(assetBrowser.handleFileRenamed).toHaveBeenCalledWith(join(projectDirectory, "assets", "tree.glb"), join(projectDirectory, "assets", "environment", "tree.glb"));
	});

	test("resolves an asset by its persisted GUID after a path change", async () => {
		await mkdir(join(projectDirectory, "assets"));
		await writeFile(join(projectDirectory, "assets", "tree.glb"), "binary content");
		await writeFile(join(projectDirectory, "assets", "tree.glb.bjsmeta.json"), JSON.stringify({ guid: "tree-guid", labels: ["environment"], importer: {} }));

		expect(await getAssetByGuid(scene, { guid: "tree-guid" })).toMatchObject({ path: "assets/tree.glb", guid: "tree-guid", labels: ["environment"] });
		await expect(getAssetByGuid(scene, { guid: "missing-guid" })).rejects.toThrow("not found");
	});

	test("tracks separate tags, project favorites, stale sources, successful reimports, and durable failures", async () => {
		await mkdir(join(projectDirectory, "assets"));
		const source = join(projectDirectory, "source.png");
		await writeFile(source, "version one");
		await importAsset(scene, { sourcePath: source, destinationPath: "assets/imported.png" }, options);
		const initial = await getAssetImportStatus(scene, { path: "assets/imported.png" });
		expect(initial).toMatchObject({ importState: { status: "current" }, tags: [], favorite: false });

		await setAssetOrganization(scene, { paths: ["assets/imported.png"], tags: ["hero", "ui"], favorite: true }, options);
		const organized = await getAssetImportStatus(scene, { path: "assets/imported.png" });
		expect(organized).toMatchObject({ guid: initial.guid, tags: ["hero", "ui"], favorite: true });

		await writeFile(source, "version two");
		expect(await refreshAssetImportStates(scene, { paths: ["assets/imported.png"] }, options)).toMatchObject({ refreshed: [{ path: "assets/imported.png", status: "stale" }] });
		expect(await listAssetImportDiagnostics(scene, { status: "stale" })).toMatchObject({ totalCount: 1 });

		await reimportAsset(scene, { path: "assets/imported.png" }, options);
		expect(await readFile(join(projectDirectory, "assets", "imported.png"), "utf-8")).toBe("version two");
		expect(await getAssetImportStatus(scene, { path: "assets/imported.png" })).toMatchObject({ guid: initial.guid, importState: { status: "current" } });

		await remove(source);
		await expect(reimportAsset(scene, { path: "assets/imported.png" }, options)).rejects.toThrow("Reimport failed");
		expect(await getAssetImportStatus(scene, { path: "assets/imported.png" })).toMatchObject({
			guid: initial.guid,
			importState: { status: "error", error: { code: "REIMPORT_FAILED" } },
		});
		expect(await listAssetImportDiagnostics(scene, { status: "error" })).toMatchObject({ totalCount: 1 });
	});
});

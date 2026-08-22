import { tmpdir } from "os";
import { join } from "path";

import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile } from "fs-extra";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getAsepriteBuildOutputPaths } from "babylonjs-editor-cli";

import { createExternalAsepriteFixture, createSimpleAsepriteFixture } from "../../../tools/test/assets/aseprite-fixture";
import { processAssetFile } from "../../src/project/export/assets";
import { projectConfiguration } from "../../src/project/configuration";
import { readAssetMetadata, writeAssetMetadata } from "../../src/mcp/assets/registry";

describe("Editor Aseprite asset export", () => {
	let project: string;
	let previousProjectPath: string | null;
	const editor = { layout: { console: { warn: vi.fn() } } } as any;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "zvibe-editor-aseprite-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(project, "Game.bjseditor");
		await ensureDir(join(project, "assets"));
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(project);
	});

	test("exports the exact leased atlas lifecycle and removes only excluded output", async () => {
		const assets = join(project, "assets");
		const sourcePath = join(assets, "map.aseprite");
		const dependencyPath = join(assets, "shared.aseprite");
		const outputRoot = join(project, "build");
		const destination = join(outputRoot, "assets", "map.aseprite");
		const fixture = createExternalAsepriteFixture();
		await writeFile(sourcePath, fixture.source);
		await writeFile(dependencyPath, fixture.dependency);
		const metadata = await readAssetMetadata(sourcePath);
		metadata.guid = "editor-map-guid";
		metadata.importer.settings.maximumAtlasSize = 64;
		await writeAssetMetadata(sourcePath, metadata);
		const cache: Record<string, string> = {};
		const options = { optimize: true, scenePath: outputRoot, projectDir: project, exportedAssets: [] as string[], cache };

		await processAssetFile(editor, sourcePath, options);
		const paths = getAsepriteBuildOutputPaths(outputRoot, destination, metadata.guid);
		expect(options.exportedAssets).toEqual([paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest]);
		expect(await readFile(destination)).toEqual(Buffer.from(fixture.source));
		expect(await readJSON(paths.runtimeManifest)).toMatchObject({
			version: 1,
			source: { path: "assets/map.aseprite" },
			artifactDirectory: ".bjseditor/imported-assets/editor-map-guid",
			dependencies: [expect.objectContaining({ path: "assets/shared.aseprite" })],
		});
		const firstCache = cache["assets/map.aseprite"];

		options.exportedAssets.length = 0;
		await processAssetFile(editor, sourcePath, options);
		expect(options.exportedAssets).toEqual([paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest]);
		expect(cache["assets/map.aseprite"]).toBe(firstCache);

		await writeFile(paths.atlasJson, "{}");
		options.exportedAssets.length = 0;
		await processAssetFile(editor, sourcePath, options);
		expect((await readJSON(paths.atlasJson)).meta.zvibe.source.name).toBe("map.aseprite");

		await writeFile(dependencyPath, createExternalAsepriteFixture("shared.aseprite", [90, 80, 70, 255]).dependency);
		options.exportedAssets.length = 0;
		await processAssetFile(editor, sourcePath, options);
		expect(cache["assets/map.aseprite"]).not.toBe(firstCache);

		metadata.guid = "editor-map-guid-2";
		await writeAssetMetadata(sourcePath, metadata);
		await processAssetFile(editor, sourcePath, { ...options, exportedAssets: [] });
		const replacement = getAsepriteBuildOutputPaths(outputRoot, destination, metadata.guid);
		expect(await pathExists(paths.artifactDirectory)).toBe(false);
		expect(await pathExists(replacement.atlasJson)).toBe(true);

		metadata.importer.settings.includeInBuild = false;
		await writeAssetMetadata(sourcePath, metadata);
		const excluded: string[] = [];
		await processAssetFile(editor, sourcePath, { ...options, exportedAssets: excluded });
		expect(excluded).toEqual([]);
		expect(
			await Promise.all(
				[replacement.source, replacement.runtimeManifest, replacement.atlasImage, replacement.atlasJson, replacement.importManifest].map((path) => pathExists(path))
			)
		).toEqual([false, false, false, false, false]);
	});

	test("exports the short ase extension through the same deterministic artifact contract", async () => {
		const sourcePath = join(project, "assets", "hero.ase");
		const outputRoot = join(project, "build");
		const destination = join(outputRoot, "assets", "hero.ase");
		await writeFile(sourcePath, createSimpleAsepriteFixture([1, 2, 3, 255]));
		const metadata = await readAssetMetadata(sourcePath);
		metadata.guid = "editor-hero-guid";
		await writeAssetMetadata(sourcePath, metadata);
		const exportedAssets: string[] = [];
		await processAssetFile(editor, sourcePath, { optimize: false, scenePath: outputRoot, projectDir: project, exportedAssets, cache: {} });
		const paths = getAsepriteBuildOutputPaths(outputRoot, destination, metadata.guid);
		expect(exportedAssets).toEqual([paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest]);
		expect((await readJSON(paths.atlasJson)).meta.zvibe.source.name).toBe("hero.ase");
	});
});

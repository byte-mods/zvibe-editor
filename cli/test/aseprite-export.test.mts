import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { afterEach, describe, expect, test } from "vitest";

import { getDefaultAssetImporterConfiguration } from "babylonjs-editor-tools";

import { createExternalAsepriteFixture } from "../../tools/test/assets/aseprite-fixture";
import { getAsepriteBuildOutputPaths } from "../src/aseprite/exporter.mjs";
import { processAssetFile, supportedExtensions } from "../src/pack/assets/process.mjs";

describe("CLI Aseprite asset export", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("packs source and GUID atlas, invalidates dependency/tamper drift, and removes excluded output", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-cli-aseprite-"));
		directories.push(project);
		const assets = join(project, "assets");
		const sourcePath = join(assets, "map.aseprite");
		const dependencyPath = join(assets, "shared.aseprite");
		const publicDir = join(project, "public", "scene");
		const destination = join(publicDir, "assets", "map.aseprite");
		await ensureDir(assets);
		const fixture = createExternalAsepriteFixture();
		await writeFile(sourcePath, fixture.source);
		await writeFile(dependencyPath, fixture.dependency);
		const importer = getDefaultAssetImporterConfiguration(sourcePath);
		importer.settings.maximumAtlasSize = 64;
		await writeJSON(`${sourcePath}.bjsmeta.json`, { version: 1, guid: "map-guid", importer });
		const cache: Record<string, string> = {};
		const options = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			optimize: true,
			exportedAssets: [] as string[],
			cache,
			compressedTexturesEnabled: false,
		};
		await processAssetFile(sourcePath, options);
		const paths = getAsepriteBuildOutputPaths(publicDir, destination, "map-guid");
		expect(supportedExtensions).toEqual(expect.arrayContaining([".ase", ".aseprite"]));
		expect(options.exportedAssets).toEqual([paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest]);
		expect(await readFile(destination)).toEqual(Buffer.from(fixture.source));
		expect(await readJSON(paths.runtimeManifest)).toMatchObject({
			version: 1,
			source: { path: "assets/map.aseprite" },
			artifactDirectory: ".bjseditor/imported-assets/map-guid",
			dependencies: [expect.objectContaining({ path: "assets/shared.aseprite" })],
		});
		const firstCache = cache["assets/map.aseprite"];

		options.exportedAssets.length = 0;
		await processAssetFile(sourcePath, options);
		expect(options.exportedAssets).toEqual([paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest]);
		expect(cache["assets/map.aseprite"]).toBe(firstCache);

		await writeFile(paths.atlasJson, "{}");
		options.exportedAssets.length = 0;
		await processAssetFile(sourcePath, options);
		expect((await readJSON(paths.atlasJson)).meta.zvibe.source.name).toBe("map.aseprite");

		await writeFile(dependencyPath, createExternalAsepriteFixture("shared.aseprite", [99, 88, 77, 255]).dependency);
		options.exportedAssets.length = 0;
		await processAssetFile(sourcePath, options);
		expect(cache["assets/map.aseprite"]).not.toBe(firstCache);
		expect((await readJSON(paths.runtimeManifest)).dependencies[0].sourceSha256).toMatch(/^[a-f0-9]{64}$/);
		await writeJSON(`${sourcePath}.bjsmeta.json`, { version: 1, guid: "map-guid-2", importer });
		options.exportedAssets.length = 0;
		await processAssetFile(sourcePath, options);
		const replacementPaths = getAsepriteBuildOutputPaths(publicDir, destination, "map-guid-2");
		expect(await pathExists(paths.artifactDirectory)).toBe(false);
		expect(await pathExists(replacementPaths.atlasJson)).toBe(true);

		importer.settings.includeInBuild = false;
		await writeJSON(`${sourcePath}.bjsmeta.json`, { version: 1, guid: "map-guid-2", importer });
		options.exportedAssets.length = 0;
		await processAssetFile(sourcePath, options);
		expect(options.exportedAssets).toEqual([]);
		expect(
			await Promise.all(
				[replacementPaths.source, replacementPaths.runtimeManifest, replacementPaths.atlasImage, replacementPaths.atlasJson, replacementPaths.importManifest].map((path) =>
					pathExists(path)
				)
			)
		).toEqual([false, false, false, false, false]);
	});
});

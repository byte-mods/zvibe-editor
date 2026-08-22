import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import { chmod, ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { afterEach, describe, expect, test } from "vitest";

import { getDefaultAssetImporterConfiguration, normalizeAlembicImporterSettings, parseAlembicCache } from "babylonjs-editor-tools";

import { createAlembicTestCache, rewriteAlembicManifest } from "../../tools/test/assets/alembic-fixture";
import { processAssetFile, supportedExtensions } from "../src/pack/assets/process.mjs";

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Test value is not JSON serializable.");
	return encoded;
}

describe("CLI Alembic export", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("builds a portable cache, reuses exact evidence, repairs tampering, and removes excluded outputs", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-cli-alembic-"));
		directories.push(project);
		const sourcePath = join(project, "assets", "caches", "complex.abc");
		const publicDir = join(project, "public", "scene");
		const executable = join(project, "fake blender");
		const fixturePath = join(project, "fixture.zvabc");
		const invocationLog = join(project, "blender-invocations.txt");
		await ensureDir(join(project, "assets", "caches"));
		const source = Buffer.from("exact-build-alembic-source");
		await writeFile(sourcePath, source);
		const importer = getDefaultAssetImporterConfiguration(sourcePath);
		const settings = normalizeAlembicImporterSettings(importer.settings);
		const fixture = rewriteAlembicManifest(createAlembicTestCache().bytes, (manifest) => {
			manifest.source.name = "complex.abc";
			manifest.source.bytes = source.byteLength;
			manifest.source.sha256 = createHash("sha256").update(source).digest("hex");
			manifest.settingsSha256 = createHash("sha256").update(canonicalJson(settings)).digest("hex");
		});
		await writeFile(fixturePath, fixture);
		await writeJSON(`${sourcePath}.bjsmeta.json`, { version: 1, guid: "alembic-build", importer });
		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
fs.copyFileSync(${JSON.stringify(fixturePath)}, process.argv[process.argv.length - 2]);
fs.appendFileSync(${JSON.stringify(invocationLog)}, "converted\\n");
`,
			"utf-8"
		);
		await chmod(executable, 0o755);
		const previous = process.env.BJS_EDITOR_BLENDER_EXECUTABLE;
		process.env.BJS_EDITOR_BLENDER_EXECUTABLE = executable;
		try {
			const cache: Record<string, string> = {};
			const options = {
				projectDir: project,
				publicDir,
				baseAssetsDir: join(project, "assets"),
				outputAssetsDir: join(publicDir, "assets"),
				optimize: false,
				exportedAssets: [] as string[],
				cache,
				compressedTexturesEnabled: false,
			};
			expect(supportedExtensions).toContain(".abc");
			await processAssetFile(sourcePath, options);
			const outputPath = join(publicDir, "assets", "caches", "complex.abc");
			const runtimePath = `${outputPath}.bjsalembic.json`;
			expect(parseAlembicCache(new Uint8Array(await readFile(outputPath))).manifest).toMatchObject({ sampleCount: 3, source: { bytes: source.byteLength } });
			expect(await readJSON(runtimePath)).toMatchObject({ version: 1, format: "zvibe-alembic-cache", cacheSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
			expect(options.exportedAssets).toEqual(expect.arrayContaining([outputPath, runtimePath]));

			await processAssetFile(sourcePath, { ...options, exportedAssets: [] });
			expect((await readFile(invocationLog, "utf-8")).trim().split("\n")).toHaveLength(1);
			await writeFile(outputPath, Buffer.from("tampered"));
			await processAssetFile(sourcePath, { ...options, exportedAssets: [] });
			expect(parseAlembicCache(new Uint8Array(await readFile(outputPath))).manifest.sampleCount).toBe(3);
			expect((await readFile(invocationLog, "utf-8")).trim().split("\n")).toHaveLength(2);
			const runtime = await readJSON(runtimePath);
			runtime.cacheSha256 = "0".repeat(64);
			await writeJSON(runtimePath, runtime);
			await processAssetFile(sourcePath, { ...options, exportedAssets: [] });
			expect((await readFile(invocationLog, "utf-8")).trim().split("\n")).toHaveLength(3);

			importer.settings.includeInBuild = false;
			await writeJSON(`${sourcePath}.bjsmeta.json`, { version: 1, guid: "alembic-build", importer });
			await processAssetFile(sourcePath, { ...options, exportedAssets: [] });
			expect(await pathExists(outputPath)).toBe(false);
			expect(await pathExists(runtimePath)).toBe(false);
			expect(cache["assets/caches/complex.abc"]).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.BJS_EDITOR_BLENDER_EXECUTABLE;
			else process.env.BJS_EDITOR_BLENDER_EXECUTABLE = previous;
		}
	});
});

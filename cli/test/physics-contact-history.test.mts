import { afterEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import { processAssetFile } from "../src/pack/assets/process.mjs";

describe("CLI physics contact history assets", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("copies a retained physics-contact history semantically intact into generated assets", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-physics-contact-history-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public", "scene");
		await ensureDir(assets);
		const sourcePath = join(assets, "impact.physicscontacts.json");
		const source = `${JSON.stringify(
			{
				version: 1,
				type: "babylon-editor-physics-contact-history",
				id: "history-1",
				name: "Impact",
				revision: 1,
				createdAt: "2026-07-30T00:00:00.000Z",
				durationMs: 10,
				source: { target: "play", scenePath: "assets/main.scene", includeContinued: false, droppedEvents: 0, capturedBodyCount: 2, maxEvents: 100 },
				events: [],
			},
			null,
			"\t"
		)}\n`;
		await writeFile(sourcePath, source);
		const exportedAssets: string[] = [];
		await processAssetFile(sourcePath, {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			optimize: false,
			exportedAssets,
			cache: {},
			compressedTexturesEnabled: false,
		});
		const outputPath = join(publicDir, "assets", "impact.physicscontacts.json");
		expect(await readJSON(outputPath)).toEqual(JSON.parse(source));
		expect(exportedAssets).toContain(outputPath);
	});
});

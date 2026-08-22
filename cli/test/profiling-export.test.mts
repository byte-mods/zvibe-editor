import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, test } from "vitest";

import { createBabylonScene } from "../src/pack/scene.mjs";
import { ensureSceneDirectories, readSceneDirectories } from "../src/tools/scene.mjs";

describe("CLI profiling metadata export", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	test("does not publish retained editor profiler evidence in packed scenes", async () => {
		const root = await mkdtemp(join(tmpdir(), "zvibe-profiler-cli-"));
		temporaryDirectories.push(root);
		const sceneFile = join(root, "authoring");
		const publicDir = join(root, "public", "scene");
		await ensureSceneDirectories(sceneFile);
		await fs.ensureDir(publicDir);
		await createBabylonScene({
			buildTime: 1,
			sceneFile,
			sceneName: "world",
			publicDir,
			babylonjsEditorToolsVersion: "5.4.3",
			exportedAssets: [],
			optimize: false,
			compressedTexturesEnabled: false,
			mergeGeometries: false,
			config: {
				clearColor: [0, 0, 0, 1],
				ambientColor: [0, 0, 0],
				gravity: [0, -9.81, 0],
				fog: { fogMode: 0, fogColor: [0, 0, 0], fogStart: 0, fogEnd: 1000, fogDensity: 0 },
				physics: { gravity: [0, -9.81, 0] },
				metadata: {
					runtimeAuthored: { mode: "campaign" },
					babylonEditorProfilerState: { version: 1, captures: [{ id: "private-profile", markers: [{ scriptKey: "src/private.ts" }] }] },
				},
				rendering: {},
				clusteredLight: {},
				animations: [],
				environment: { environmentTexture: null, environmentIntensity: 1, iblIntensity: 1 },
			},
			directories: await readSceneDirectories(sceneFile),
		});

		const packed = await fs.readJSON(join(publicDir, "world.babylon"));
		expect(packed.metadata).toMatchObject({ runtimeAuthored: { mode: "campaign" } });
		expect(packed.metadata).not.toHaveProperty("babylonEditorProfilerState");
	});
});

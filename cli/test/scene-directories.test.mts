import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureSceneDirectories, readSceneDirectories } from "../src/tools/scene.mjs";

describe("scene directory discovery", () => {
	let sceneDirectory: string;

	beforeEach(async () => {
		sceneDirectory = await mkdtemp(join(tmpdir(), "zvibe-scene-directories-"));
		await ensureSceneDirectories(sceneDirectory);
	});

	afterEach(async () => {
		await rm(sceneDirectory, { recursive: true, force: true });
	});

	test("returns deterministic content files without asset metadata or nested directories", async () => {
		const meshesDirectory = join(sceneDirectory, "meshes");
		await writeFile(join(meshesDirectory, "b.json"), "{}");
		await writeFile(join(meshesDirectory, "a.json"), "{}");
		await writeFile(join(meshesDirectory, "a.json.bjsmeta.json"), "{}");
		await writeFile(join(meshesDirectory, ".DS_Store"), "ignored");
		await mkdir(join(meshesDirectory, "nested"));

		const directories = await readSceneDirectories(sceneDirectory);

		expect(directories.meshesFiles).toEqual(["a.json", "b.json"]);
	});
});

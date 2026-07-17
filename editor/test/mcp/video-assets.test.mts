import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { listAssets } from "../../src/mcp/assets/assets";

describe("mcp/video-assets", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-video-assets-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		await writeFile(join(directory, "assets", "intro.webm"), "video bytes");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("classifies supported web video files as first-class video assets", async () => {
		expect(await listAssets(scene, { type: "video" })).toMatchObject({ assets: [{ path: "assets/intro.webm", type: "video" }], totalCount: 1 });
	});
});

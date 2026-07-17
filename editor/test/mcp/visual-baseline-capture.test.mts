import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

vi.mock("../../src/tools/scene/screenshot", () => ({ getBase64SceneScreenshot: vi.fn(async () => "data:image/png;base64,AQID") }));

import { projectConfiguration } from "../../src/project/configuration";
import { captureVisualRegressionBaseline } from "../../src/mcp/screenshot";

describe("mcp/visual-baseline-capture", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-visual-baseline-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("writes captured viewport bytes to a project PNG path", async () => {
		expect(await captureVisualRegressionBaseline(scene, { path: "assets/baselines/scene.png" })).toMatchObject({ captured: true, path: "assets/baselines/scene.png" });
		expect(await readFile(join(directory, "assets/baselines/scene.png"))).toEqual(Buffer.from([1, 2, 3]));
	});
});

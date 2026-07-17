import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";

import { createSpline, getSpline, instantiateSplineAsset, listSplineAssets, saveSplineAsset } from "../../src/mcp/splines/splines";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/spline assets", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = {
		editor: {
			layout: {
				preview: { gizmo: { setAttachedObject: vi.fn() } },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				graph: { refresh: vi.fn(() => Promise.resolve()), setSelectedNode: vi.fn() },
			},
		},
	} as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options.editor.layout.preview.scene = scene;
		projectDirectory = await mkdtemp(join(tmpdir(), "babylon-spline-assets-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		scene.dispose();
		engine.dispose();
		await remove(projectDirectory);
	});

	test("saves, lists, and instantiates a reusable cubic spline asset", async () => {
		const source = createSpline(
			scene,
			{
				name: "Road Curve",
				knots: [
					{ position: [0, 0, 0], outTangent: [50, 0, 0] },
					{ position: [100, 0, 100], inTangent: [-25, 0, 0] },
				],
				radius: 12,
				closed: true,
			},
			options
		);

		const saved = await saveSplineAsset(scene, { nodeId: source.node.id, path: "assets/paths/road.spline.json" });
		expect(saved.path).toBe("assets/paths/road.spline.json");
		expect(await readJSON(join(projectDirectory, saved.path))).toMatchObject({ version: 1, type: "babylonEditorSpline", name: "Road Curve", closed: true });
		expect((await listSplineAssets()).assets).toHaveLength(1);

		const instantiated = await instantiateSplineAsset(scene, { path: saved.path, name: "Road Curve Copy" }, options);
		expect(instantiated.spline.node.name).toBe("Road Curve Copy");
		expect(getSpline(scene, { nodeId: instantiated.spline.node.id })).toMatchObject({ knots: source.knots, radius: 12, closed: true });
	});

	test("requires an explicit overwrite and keeps asset paths inside the project", async () => {
		const spline = createSpline(scene, { points: [[0, 0, 0], [100, 0, 0]] }, options);
		await saveSplineAsset(scene, { nodeId: spline.node.id, path: "assets/path.spline.json" });
		await expect(saveSplineAsset(scene, { nodeId: spline.node.id, path: "assets/path.spline.json" })).rejects.toThrow("Set overwrite: true");
		await expect(saveSplineAsset(scene, { nodeId: spline.node.id, path: "../outside.spline.json" })).rejects.toThrow("inside the open project directory");
	});
});

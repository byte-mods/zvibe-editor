import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { join } from "path/posix";
import { tmpdir } from "os";
import { Scene, NullEngine } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	assignAddressableAsset,
	createAddressableGroup,
	diffAddressableCatalogs,
	findAddressableAssetsByLabels,
	setAddressableAssetLabels,
} from "../../src/mcp/addressables/addressables";

describe("mcp/addressable-labels", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-addressable-labels-"));
		await writeJSON(join(directory, "project.bjseditor"), {});
		await writeFile(join(directory, "hero.glb"), "hero");
		await writeFile(join(directory, "forest.glb"), "forest");
		projectConfiguration.path = join(directory, "project.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = "";
		await remove(directory);
	});

	test("persists labels and finds assets using all/any matching", async () => {
		await createAddressableGroup(scene, { name: "Content" }, options);
		await assignAddressableAsset(scene, { name: "Content", assetPath: "hero.glb" }, options);
		await assignAddressableAsset(scene, { name: "Content", assetPath: "forest.glb" }, options);
		await setAddressableAssetLabels(scene, { name: "Content", assetPath: "hero.glb", labels: ["character", "featured", "character"] }, options);
		await setAddressableAssetLabels(scene, { name: "Content", assetPath: "forest.glb", labels: ["environment", "featured"] }, options);
		expect(await findAddressableAssetsByLabels(scene, { labels: ["featured"] })).toMatchObject({ assets: [{ path: "hero.glb" }, { path: "forest.glb" }] });
		expect(await findAddressableAssetsByLabels(scene, { labels: ["featured", "character"], match: "all" })).toMatchObject({
			assets: [{ path: "hero.glb", labels: ["character", "featured"] }],
		});
	});

	test("reports content additions, hash/label changes, and removals between catalogs", async () => {
		await writeJSON(join(directory, "previous.catalog.json"), {
			groups: [
				{
					id: "content",
					name: "Content",
					assets: [
						{ path: "hero.glb", hash: "old", labels: ["character"] },
						{ path: "removed.glb", hash: "gone" },
					],
				},
			],
		});
		await writeJSON(join(directory, "next.catalog.json"), {
			groups: [
				{
					id: "content",
					name: "Content",
					assets: [
						{ path: "hero.glb", hash: "new", labels: ["character"] },
						{ path: "forest.glb", hash: "forest", labels: ["environment"] },
					],
				},
			],
		});
		expect(await diffAddressableCatalogs(scene, { previousCatalogPath: "previous.catalog.json", nextCatalogPath: "next.catalog.json" })).toMatchObject({
			summary: { added: 1, changed: 1, removed: 1, unchanged: 0 },
			added: [{ path: "forest.glb" }],
			removed: [{ path: "removed.glb" }],
		});
	});
});

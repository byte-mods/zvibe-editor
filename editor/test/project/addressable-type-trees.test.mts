import { afterEach, describe, expect, test } from "vitest";

import { join } from "node:path/posix";
import { tmpdir } from "node:os";
import { mkdtemp, remove, writeFile } from "fs-extra";

import { normalizeAddressableConfiguration, validateAddressableTypeTreeRegistry } from "babylonjs-editor-tools";

import { createAddressableCatalog } from "../../src/project/export/addressables";
import { createAddressablePortableBuildPlan } from "../../src/project/export/addressable-type-trees";

describe("project/export/addressable-type-trees", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) {
			await remove(directory);
		}
	});

	test("extracts one shared schema and respects pack-together topology when total bytes decrease", async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-addressable-type-trees-"));
		const hero = Array.from({ length: 100 }, (_, index) => ({ veryLongDisplayNameProperty: `Hero ${index}`, repeatedDescriptionProperty: "friendly" }));
		const enemy = Array.from({ length: 100 }, (_, index) => ({ repeatedDescriptionProperty: "hostile", veryLongDisplayNameProperty: `Enemy ${index}` }));
		await writeFile(join(directory, "hero.json"), JSON.stringify(hero));
		await writeFile(join(directory, "enemy.json"), JSON.stringify(enemy));
		const configuration = normalizeAddressableConfiguration({
			version: 2,
			groups: [
				{
					id: "characters",
					name: "Characters",
					delivery: "local",
					updateRestriction: "static",
					bundleMode: "pack-together",
					assets: [
						{ path: "hero.json", address: "hero", labels: [] },
						{ path: "enemy.json", address: "enemy", labels: [] },
					],
				},
			],
			settings: { extractTypeTrees: true },
		});
		const created = await createAddressableCatalog(directory, configuration);
		const plan = await createAddressablePortableBuildPlan(
			created.catalog,
			configuration,
			created.sources.map((source) => ({ groupId: source.group.id, address: source.asset.address, sourcePath: source.sourcePath }))
		);
		expect(plan.summary).toMatchObject({ enabled: true, schemaCount: 1, bundleCount: 1, structuredAssetCount: 2 });
		expect(plan.summary.savedBytes).toBeGreaterThan(0);
		expect(created.catalog.groups[0].assets.every((asset) => asset.portableBundleId === created.catalog.portableBundles![0].id)).toBe(true);
		const registry = JSON.parse(plan.artifacts.find((artifact) => artifact.kind === "type-tree-registry")!.bytes.toString("utf8"));
		expect((await validateAddressableTypeTreeRegistry(registry)).size).toBe(1);
	});

	test("keeps tiny and malformed JSON as raw assets when extraction cannot save bytes", async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-addressable-type-trees-fallback-"));
		await writeFile(join(directory, "tiny.json"), "{}");
		await writeFile(join(directory, "broken.json"), "{broken");
		const configuration = normalizeAddressableConfiguration({
			version: 2,
			groups: [{ id: "data", name: "Data", delivery: "local", updateRestriction: "static", assets: ["tiny.json", "broken.json"] }],
			settings: { extractTypeTrees: true },
		});
		const created = await createAddressableCatalog(directory, configuration);
		const original = structuredClone(created.catalog.groups[0].assets);
		const plan = await createAddressablePortableBuildPlan(
			created.catalog,
			configuration,
			created.sources.map((source) => ({ groupId: source.group.id, address: source.asset.address, sourcePath: source.sourcePath }))
		);
		expect(plan.summary.enabled).toBe(false);
		expect(plan.artifacts).toEqual([]);
		expect(created.catalog.groups[0].assets).toEqual(original);
	});
});

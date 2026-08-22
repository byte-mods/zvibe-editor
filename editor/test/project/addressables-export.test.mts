import { afterEach, describe, expect, test } from "vitest";

import { join } from "node:path/posix";
import { tmpdir } from "node:os";
import { mkdtemp, pathExists, readJSON, remove, writeFile, writeJSON } from "fs-extra";

import { exportAddressables } from "../../src/project/export/addressables";

describe("project/export/addressables", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) {
			await remove(directory);
		}
	});

	test("embeds a canonical remote-updatable catalog and copies only local content", async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-addressables-export-"));
		const sceneDirectory = join(directory, "public/scene");
		await writeFile(join(directory, "local.txt"), "local");
		await writeFile(join(directory, "remote.txt"), "remote");
		await writeJSON(join(directory, "addressables.json"), {
			version: 2,
			revision: 3,
			activeProfileId: "production",
			profiles: [
				{
					id: "production",
					name: "Production",
					localBuildPath: "AddressableBuilds/local",
					localLoadPath: "./",
					remoteBuildPath: "AddressableBuilds/remote",
					remoteLoadPath: "https://cdn.test/game",
				},
			],
			groups: [
				{
					id: "local",
					name: "Local",
					delivery: "local",
					updateRestriction: "static",
					bundleMode: "pack-separately",
					assets: [{ path: "local.txt", address: "local", labels: [] }],
				},
				{
					id: "remote",
					name: "Remote",
					delivery: "remote",
					updateRestriction: "dynamic",
					bundleMode: "pack-separately",
					assets: [{ path: "remote.txt", address: "remote", labels: ["download"] }],
				},
			],
			settings: {
				remoteCatalog: true,
				remoteCatalogFile: "addressables.current.json",
				verifyHashes: true,
				requestTimeoutMs: 20_000,
				maxConcurrentRequests: 4,
				cacheMaxBytes: 4096,
			},
		});
		const result = await exportAddressables(directory, sceneDirectory);
		expect(result.catalog).toMatchObject({
			version: 3,
			profileId: "production",
			remoteCatalog: { pointerUrl: "https://cdn.test/game/addressables.current.json" },
			runtime: { verifyHashes: true, maxConcurrentRequests: 4, cacheMaxBytes: 4096 },
		});
		expect(await pathExists(join(sceneDirectory, "local.txt"))).toBe(true);
		expect(await pathExists(join(sceneDirectory, "remote.txt"))).toBe(false);
		const catalog = await readJSON(join(sceneDirectory, "addressables.catalog.json"));
		const remote = catalog.groups.find((group: any) => group.id === "remote").assets[0];
		expect(remote.internalId).toMatch(/^content\/[a-f0-9]{2}\/[a-f0-9]{64}\.txt$/);
		expect(remote.address).toBe("remote");
	});

	test("exports shared TypeTree registry and pack-together bundle instead of repeated structured files", async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-addressables-portable-export-"));
		const records = (prefix: string) => Array.from({ length: 100 }, (_, index) => ({ veryLongDisplayNameProperty: `${prefix} ${index}`, veryLongCategoryProperty: prefix }));
		await writeFile(join(directory, "hero.json"), JSON.stringify(records("Hero")));
		await writeFile(join(directory, "enemy.json"), JSON.stringify(records("Enemy")));
		await writeJSON(join(directory, "addressables.json"), {
			version: 2,
			groups: [
				{
					id: "data",
					name: "Data",
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
		const sceneDirectory = join(directory, "public/scene");
		const result = await exportAddressables(directory, sceneDirectory);
		expect(result.catalog?.typeTreeSummary).toMatchObject({ enabled: true, schemaCount: 1, bundleCount: 1, structuredAssetCount: 2 });
		expect(await pathExists(join(sceneDirectory, "hero.json"))).toBe(false);
		expect(await pathExists(join(sceneDirectory, "enemy.json"))).toBe(false);
		expect(await pathExists(join(sceneDirectory, result.catalog!.typeTreeRegistry!.internalId))).toBe(true);
		expect(await pathExists(join(sceneDirectory, result.catalog!.portableBundles![0].internalId))).toBe(true);
	});
});

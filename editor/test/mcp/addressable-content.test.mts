import { afterEach, describe, expect, test } from "vitest";

import { join, relative } from "node:path/posix";
import { tmpdir } from "node:os";
import { mkdtemp, pathExists, readJSON, remove, writeFile } from "fs-extra";

import { normalizeAddressableConfiguration } from "babylonjs-editor-tools";

import { buildAddressableContent } from "../../src/mcp/addressables/content";
import { deployAddressableBuild, listAddressableDeploymentReceipts, verifyAddressableDeployment } from "../../src/mcp/addressables/deployment";

describe("mcp/addressable-content", () => {
	let projectDirectory: string | undefined;

	afterEach(async () => {
		if (projectDirectory) {
			await remove(projectDirectory);
		}
	});

	test("builds full and incremental content, redirects static changes, deploys pointer-last, verifies, and rejects corrupt artifacts", async () => {
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-addressables-content-"));
		await writeFile(join(projectDirectory, "hero.txt"), "hero-v1");
		await writeFile(join(projectDirectory, "forest.txt"), "forest-v1");
		const configuration = normalizeAddressableConfiguration({
			version: 2,
			revision: 4,
			activeProfileId: "production",
			profiles: [
				{
					id: "production",
					name: "Production",
					localBuildPath: "AddressableBuilds/{profile}/local",
					localLoadPath: "./",
					remoteBuildPath: "AddressableBuilds/{profile}/remote",
					remoteLoadPath: "https://cdn.test/game",
				},
			],
			groups: [
				{
					id: "local-static",
					name: "Local Static",
					delivery: "local",
					updateRestriction: "static",
					bundleMode: "pack-separately",
					assets: [{ path: "hero.txt", address: "hero", labels: ["character"] }],
				},
				{
					id: "remote-dynamic",
					name: "Remote Dynamic",
					delivery: "remote",
					updateRestriction: "dynamic",
					bundleMode: "pack-separately",
					assets: [{ path: "forest.txt", address: "forest", labels: ["environment"] }],
				},
			],
			settings: {
				remoteCatalog: true,
				remoteCatalogFile: "addressables.current.json",
				verifyHashes: true,
				requestTimeoutMs: 10_000,
				maxConcurrentRequests: 4,
				cacheMaxBytes: 1024 * 1024,
			},
		});

		const full = await buildAddressableContent(projectDirectory, configuration, { buildType: "full", outputPath: "build/full" });
		expect(full.report).toMatchObject({ buildType: "full", addedCount: 2, changedCount: 0, localAssetCount: 1, remoteAssetCount: 1, staticRedirectCount: 0 });
		expect(await pathExists(full.catalogPath)).toBe(true);
		expect(await pathExists(join(projectDirectory, "build/full/local/hero.txt"))).toBe(true);
		expect(full.report.artifacts.some((artifact) => artifact.kind === "remote-content" && artifact.deployPath?.startsWith("content/"))).toBe(true);

		await writeFile(join(projectDirectory, "hero.txt"), "hero-v2");
		await writeFile(join(projectDirectory, "forest.txt"), "forest-v2");
		const update = await buildAddressableContent(projectDirectory, configuration, {
			buildType: "update",
			outputPath: "build/update",
			previousStatePath: relative(projectDirectory, full.statePath),
		});
		expect(update.report).toMatchObject({
			buildType: "update",
			baseBuildId: full.report.buildId,
			addedCount: 0,
			changedCount: 2,
			unchangedCount: 0,
			staticRedirectCount: 1,
			localAssetCount: 0,
			remoteAssetCount: 2,
		});
		expect(update.catalog.groups.some((group) => group.id.startsWith("local-static-update-") && group.assets.some((asset) => asset.address === "hero"))).toBe(true);
		expect(update.report.artifacts.some((artifact) => artifact.kind === "local-content")).toBe(false);

		const target = {
			id: "filesystem",
			name: "Filesystem CDN",
			provider: "filesystem" as const,
			destinationPath: "published",
			publicBaseUrl: "https://cdn.test/game",
		};
		const receipt = await deployAddressableBuild(projectDirectory, relative(projectDirectory, update.reportPath), target, update.report.catalogHash, true);
		expect(receipt).toMatchObject({ buildId: update.report.buildId, pointerPublishedLast: true, verified: true });
		const pointer = await readJSON(join(projectDirectory, "published/addressables.current.json"));
		expect(pointer).toMatchObject({ buildId: update.report.buildId, catalogHash: update.report.catalogHash });
		expect(await verifyAddressableDeployment(projectDirectory, target, "addressables.current.json", update.report.buildId, update.report.catalogHash)).toMatchObject({
			verified: true,
		});
		expect(await listAddressableDeploymentReceipts(projectDirectory)).toHaveLength(1);
		const mismatchedTarget = { ...target, id: "wrong-cdn", name: "Wrong CDN", destinationPath: "wrong-publication", publicBaseUrl: "https://other.test/game" };
		await expect(deployAddressableBuild(projectDirectory, relative(projectDirectory, update.reportPath), mismatchedTarget, update.report.catalogHash, true)).rejects.toThrow(
			/does not match remote group/
		);
		expect(await pathExists(join(projectDirectory, "wrong-publication/addressables.current.json"))).toBe(false);

		const corruptArtifact = update.report.artifacts.find((artifact) => artifact.kind === "remote-content")!;
		await writeFile(join(projectDirectory, "build/update", corruptArtifact.relativePath), "corrupt");
		const failedTarget = { ...target, id: "failed", name: "Failed", destinationPath: "failed-publication" };
		await expect(deployAddressableBuild(projectDirectory, relative(projectDirectory, update.reportPath), failedTarget, update.report.catalogHash, true)).rejects.toThrow(
			/no longer matches/
		);
		expect(await pathExists(join(projectDirectory, "failed-publication/addressables.current.json"))).toBe(false);
	});

	test("emits shared schemas and treats pack-together bundles as one incremental change unit", async () => {
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-addressables-portable-content-"));
		const records = (prefix: string) => Array.from({ length: 100 }, (_, index) => ({ veryLongDisplayNameProperty: `${prefix} ${index}`, veryLongCategoryProperty: prefix }));
		await writeFile(join(projectDirectory, "hero.json"), JSON.stringify(records("Hero")));
		await writeFile(join(projectDirectory, "enemy.json"), JSON.stringify(records("Enemy")));
		await writeFile(join(projectDirectory, "remote.txt"), "remote");
		const configuration = normalizeAddressableConfiguration({
			version: 2,
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
			activeProfileId: "production",
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
				{
					id: "remote",
					name: "Remote",
					delivery: "remote",
					updateRestriction: "dynamic",
					assets: [{ path: "remote.txt", address: "remote", labels: [] }],
				},
			],
			settings: { extractTypeTrees: true, remoteCatalog: true },
		});
		const full = await buildAddressableContent(projectDirectory, configuration, { buildType: "full", outputPath: "build/portable-full" });
		expect(full.report).toMatchObject({ typeTreeSchemaCount: 1, portableBundleCount: 1, addedCount: 3 });
		expect(full.report.typeTreeSavedBytes).toBeGreaterThan(0);
		expect(full.report.artifacts.filter((artifact) => artifact.kind === "portable-bundle")).toHaveLength(1);
		expect(full.report.artifacts.filter((artifact) => artifact.kind === "type-tree-registry")).toHaveLength(1);
		expect(full.report.artifacts.some((artifact) => artifact.kind === "local-content")).toBe(false);

		await writeFile(join(projectDirectory, "hero.json"), JSON.stringify(records("Hero Updated")));
		const update = await buildAddressableContent(projectDirectory, configuration, {
			buildType: "update",
			outputPath: "build/portable-update",
			previousStatePath: relative(projectDirectory, full.statePath),
		});
		expect(update.report).toMatchObject({ changedCount: 2, unchangedCount: 1, staticRedirectCount: 2, portableBundleCount: 1 });
		expect(update.catalog.groups.find((group) => group.id.startsWith("characters-update-"))?.assets).toHaveLength(2);
		expect(update.catalog.typeTreeRegistry?.loadPaths).toContain("https://cdn.test/game");
		expect(update.report.artifacts.some((artifact) => artifact.kind === "portable-bundle" && artifact.deployPath?.startsWith("bundles/"))).toBe(true);
		const target = {
			id: "portable-filesystem",
			name: "Portable Filesystem",
			provider: "filesystem" as const,
			destinationPath: "portable-published",
			publicBaseUrl: "https://cdn.test/game",
		};
		await deployAddressableBuild(projectDirectory, relative(projectDirectory, update.reportPath), target, update.report.catalogHash, true);
		await expect(verifyAddressableDeployment(projectDirectory, target, "addressables.current.json", update.report.buildId, update.report.catalogHash)).resolves.toMatchObject({
			verified: true,
		});
		await writeFile(join(projectDirectory, "portable-published", update.catalog.typeTreeRegistry!.internalId), "corrupt");
		await expect(verifyAddressableDeployment(projectDirectory, target, "addressables.current.json", update.report.buildId, update.report.catalogHash)).rejects.toThrow(
			/registry failed verification/
		);
	});
});

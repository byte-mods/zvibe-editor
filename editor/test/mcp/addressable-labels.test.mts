import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { join } from "path/posix";
import { tmpdir } from "os";
import { Scene, NullEngine } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	assignAddressableAsset,
	createAddressableGroup,
	createAddressableProfile,
	diffAddressableCatalogs,
	findAddressableAssetsByLabels,
	getAddressableDownloadSize,
	getAddressableRuntimeStatus,
	listAddressableGroups,
	reloadAddressableRuntime,
	setAddressableDeploymentTarget,
	setAddressableAssetLabels,
	setAddressableGroup,
	setAddressableSettings,
	validateAddressableContent,
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
		await createAddressableGroup(scene, { name: "Content", expectedRevision: 0 }, options);
		await assignAddressableAsset(scene, { name: "Content", assetPath: "hero.glb", expectedRevision: 1 }, options);
		await assignAddressableAsset(scene, { name: "Content", assetPath: "forest.glb", expectedRevision: 2 }, options);
		await setAddressableAssetLabels(scene, { name: "Content", assetPath: "hero.glb", labels: ["character", "featured", "character"], expectedRevision: 3 }, options);
		await setAddressableAssetLabels(scene, { name: "Content", assetPath: "forest.glb", labels: ["environment", "featured"], expectedRevision: 4 }, options);
		expect(await findAddressableAssetsByLabels(scene, { labels: ["featured"] })).toMatchObject({ assets: [{ path: "hero.glb" }, { path: "forest.glb" }] });
		expect(await findAddressableAssetsByLabels(scene, { labels: ["featured", "character"], match: "all" })).toMatchObject({
			assets: [{ path: "hero.glb", labels: ["character", "featured"] }],
		});
		expect(await listAddressableGroups()).toMatchObject({ version: 2, revision: 5, groups: [{ assets: [{ address: "hero.glb" }, { address: "forest.glb" }] }] });
		await expect(assignAddressableAsset(scene, { name: "Content", assetPath: "hero.glb", expectedRevision: 4 }, options)).rejects.toThrow(/Stale Addressables revision/);
	});

	test("authors profiles, settings, deployment targets, validates content, and runs the shared preview cache", async () => {
		await createAddressableProfile(
			scene,
			{
				expectedRevision: 0,
				id: "production",
				name: "Production",
				localBuildPath: "AddressableBuilds/{profile}/local",
				localLoadPath: "./",
				remoteBuildPath: "AddressableBuilds/{profile}/remote",
				remoteLoadPath: "https://cdn.test/game",
			},
			options
		);
		await setAddressableSettings(scene, { expectedRevision: 1, activeProfileId: "production", cacheMaxBytes: 1024 }, options);
		await createAddressableGroup(scene, { expectedRevision: 2, id: "content", name: "Content", delivery: "local" }, options);
		await setAddressableGroup(scene, { expectedRevision: 3, id: "content", buildPath: "custom/build", loadPath: "./custom" }, options);
		const cleared = await setAddressableGroup(scene, { expectedRevision: 4, id: "content", clearBuildPath: true, clearLoadPath: true }, options);
		expect(cleared.groups[0]).not.toHaveProperty("buildPath");
		expect(cleared.groups[0]).not.toHaveProperty("loadPath");
		await assignAddressableAsset(scene, { expectedRevision: 5, id: "content", assetPath: "hero.glb", address: "hero", labels: ["featured"] }, options);
		await setAddressableDeploymentTarget(
			scene,
			{
				expectedRevision: 6,
				makeActive: true,
				target: { id: "local-cdn", name: "Local CDN", provider: "filesystem", destinationPath: "deploy", publicBaseUrl: "https://cdn.test/game" },
			},
			options
		);
		expect(await validateAddressableContent(scene, {})).toMatchObject({ valid: true, revision: 7, profileId: "production", groupCount: 1, assetCount: 1 });
		expect(await reloadAddressableRuntime(scene, { expectedRevision: 7 })).toMatchObject({ profileId: "production", assetCount: 1, cache: { entryCount: 0 } });
		expect(getAddressableDownloadSize(scene, { addresses: ["hero"] })).toEqual({ sizeBytes: 4, query: { addresses: ["hero"] } });
		expect(getAddressableRuntimeStatus(scene)).toMatchObject({ profileId: "production", remoteCatalogConfigured: false });
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

	test("maps the complete profile/build/deploy/runtime surface and advertises every Addressables capability", () => {
		for (const endpoint of [
			"list_addressable_groups",
			"analyze_addressable_type_trees",
			"validate_addressable_content",
			"set_addressable_settings",
			"create_addressable_profile",
			"set_addressable_profile",
			"delete_addressable_profile",
			"create_addressable_group",
			"set_addressable_group",
			"delete_addressable_group",
			"assign_addressable_asset",
			"set_addressable_asset",
			"remove_addressable_asset",
			"set_addressable_asset_labels",
			"find_addressable_assets_by_labels",
			"diff_addressable_catalogs",
			"build_addressable_catalog",
			"set_addressable_deployment_target",
			"delete_addressable_deployment_target",
			"build_addressable_content",
			"list_addressable_build_reports",
			"get_addressable_build_report",
			"get_addressable_type_tree_build",
			"get_addressable_type_tree_schema",
			"validate_addressable_portable_bundle",
			"deploy_addressable_content",
			"verify_addressable_deployment",
			"list_addressable_deployment_receipts",
			"reload_addressable_runtime",
			"get_addressable_runtime_status",
			"check_addressable_catalog_updates",
			"update_addressable_catalog",
			"get_addressable_download_size",
			"download_addressable_dependencies",
			"clear_addressable_cache",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		expect(getEditorCapabilities(scene, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any).features).toMatchObject({
			addressablesCatalog: true,
			addressablesRuntime: true,
			addressablesProfiles: true,
			addressablesContentUpdates: true,
			addressablesRemoteCatalogs: true,
			addressablesDeployment: true,
			addressablesBuildReports: true,
			addressablesRuntimeCache: true,
			addressablesSharedTypeTrees: true,
			addressablesPortableBundles: true,
		});
	});
});

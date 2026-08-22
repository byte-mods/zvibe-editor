import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { join } from "node:path/posix";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, remove, writeFile, writeJSON } from "fs-extra";
import { NullEngine, Scene } from "babylonjs";

import { normalizeAddressableConfiguration } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../src/project/configuration";
import {
	analyzeAddressableTypeTrees,
	buildAddressableContentAction,
	downloadAddressableDependencies,
	getAddressableTypeTreeBuild,
	getAddressableTypeTreeSchema,
	setAddressableSettings,
	reloadAddressableRuntime,
	validateAddressablePortableBundleAction,
} from "../../src/mcp/addressables/addressables";

describe("mcp/addressable-type-trees", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-addressable-type-trees-"));
		await writeJSON(join(directory, "project.bjseditor"), {});
		const records = (prefix: string) =>
			Array.from({ length: 160 }, (_, index) => ({ veryLongDisplayNameProperty: `${prefix} ${index}`, veryLongCategoryProperty: prefix, enabled: index % 2 === 0 }));
		await writeFile(join(directory, "hero.json"), JSON.stringify(records("Hero")));
		await writeFile(join(directory, "enemy.json"), JSON.stringify(records("Enemy")));
		await writeJSON(
			join(directory, "addressables.json"),
			normalizeAddressableConfiguration({
				version: 2,
				groups: [
					{
						id: "characters",
						name: "Characters",
						delivery: "local",
						updateRestriction: "static",
						bundleMode: "pack-separately",
						assets: [
							{ path: "hero.json", address: "hero", labels: [] },
							{ path: "enemy.json", address: "enemy", labels: [] },
						],
					},
				],
			})
		);
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

	test("analyzes disabled extraction as a what-if and verifies built schemas and bundles with pagination", async () => {
		const analysis = (await analyzeAddressableTypeTrees(scene, { offset: 0, limit: 1 })) as any;
		expect(analysis).toMatchObject({ extractionEnabled: false, analysisMode: "what-if-enabled", total: 2, count: 1, hasMore: true, nextOffset: 1 });
		expect(analysis.summary).toMatchObject({ enabled: true, schemaCount: 1, bundleCount: 2, structuredAssetCount: 2 });
		expect(analysis.summary.savedBytes).toBeGreaterThan(0);

		await setAddressableSettings(scene, { expectedRevision: 0, extractTypeTrees: true }, options);
		const report = (await buildAddressableContentAction(scene, { expectedRevision: 1, buildType: "full", outputPath: "build/type-trees" }, options)) as any;
		expect(report).toMatchObject({ typeTreeSchemaCount: 1, portableBundleCount: 2 });

		const build = (await getAddressableTypeTreeBuild(scene, { reportPath: report.reportPath, offset: 1, limit: 1 })) as any;
		expect(build).toMatchObject({ buildId: report.buildId, total: 2, count: 1, offset: 1, hasMore: false });
		const catalogPath = join(directory, report.catalogPath);
		const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
		const builtSchemaId = catalog.groups[0].assets[0].typeTreeSchemaId as string;
		const schema = (await getAddressableTypeTreeSchema(scene, { reportPath: report.reportPath, schemaId: builtSchemaId, offset: 1, limit: 2 })) as any;
		expect(schema).toMatchObject({ buildId: report.buildId, count: 2, offset: 1, hasMore: true, schema: { id: builtSchemaId } });

		const bundleId = build.bundles[0].id as string;
		const validated = (await validateAddressablePortableBundleAction(scene, { reportPath: report.reportPath, bundleId, offset: 0, limit: 1 })) as any;
		expect(validated).toMatchObject({ valid: true, buildId: report.buildId, total: 1, count: 1, entries: [{ schemaId: builtSchemaId }] });

		expect(await reloadAddressableRuntime(scene, { expectedRevision: 1 })).toMatchObject({ typeTreeSchemaCount: 1, portableBundleCount: 2 });
		expect(await downloadAddressableDependencies(scene, { addresses: ["hero"] })).toMatchObject({ downloadedCount: 1, cachedCount: 0 });
	});

	test("rejects a built portable bundle that no longer matches its report", async () => {
		await setAddressableSettings(scene, { expectedRevision: 0, extractTypeTrees: true }, options);
		const report = (await buildAddressableContentAction(scene, { expectedRevision: 1, buildType: "full", outputPath: "build/tamper" }, options)) as any;
		const build = (await getAddressableTypeTreeBuild(scene, { reportPath: report.reportPath })) as any;
		const artifact = report.artifacts.find((candidate: any) => candidate.kind === "portable-bundle" && candidate.relativePath.endsWith(build.bundles[0].internalId));
		await writeFile(join(directory, "build/tamper", artifact.relativePath), "corrupt");
		await expect(validateAddressablePortableBundleAction(scene, { reportPath: report.reportPath, bundleId: build.bundles[0].id })).rejects.toThrow(
			/no longer matches its report/
		);
	});
});

import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copy, mkdir, mkdtemp, readFile, remove, writeFile, writeJSON } from "fs-extra";
import sharp from "sharp";

import {
	getAutoReimportOriginPaths,
	getAutoReimportStatus,
	inspectAutoReimport,
	processAutoReimportOriginChanges,
	runAutoReimport,
	setAutoReimportSettings,
} from "../../src/mcp/assets/auto-reimport";
import { getMaterialImporterArtifactStatus } from "../../src/mcp/assets/material-importer";
import { getTextureImporterArtifactStatus } from "../../src/mcp/assets/texture-importer";
import { readAssetMetadata, rebuildAssetRegistry, refreshAssetRegistryPaths, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";
import { inspectAutoReimportAction, runAutoReimportAction, setAutoReimportSettingsAction } from "../../src/mcp/assets/assets";

async function png(red: number, green: number, blue: number): Promise<Buffer> {
	return sharp({ create: { width: 2, height: 1, channels: 4, background: { r: red, g: green, b: blue, alpha: 1 } } })
		.png()
		.toBuffer();
}

describe("dependency-triggered Auto Reimport", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-auto-reimport-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "project.bjseditor");
		await writeJSON(projectConfiguration.path, {});
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("plans and rebuilds a changed source plus recursively affected material dependency under one exact lease", async () => {
		const texturePath = join(directory, "assets/albedo.png");
		const materialPath = join(directory, "assets/surface.material");
		await writeFile(texturePath, await png(255, 0, 0));
		await writeJSON(materialPath, {
			customType: "BABYLON.PBRMaterial",
			name: "Surface",
			albedoTexture: { name: "assets/albedo.png", url: "assets/albedo.png" },
		});
		await rebuildAssetRegistry();

		const first = await inspectAutoReimport({ paths: ["assets/albedo.png"] });
		expect(first).toMatchObject({ blocked: false, candidateCount: 2, applyCount: 2 });
		expect(first.candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "assets/albedo.png", kind: "texture", reasons: ["source"], state: "stale", willApply: true }),
				expect.objectContaining({ path: "assets/surface.material", kind: "material", reasons: ["dependency"], willApply: true }),
			])
		);
		const firstJob = await runAutoReimport(first.fingerprint, { paths: ["assets/albedo.png"] });
		expect(firstJob).toMatchObject({ status: "completed", appliedCount: 2, failedCount: 0 });
		expect(await getTextureImporterArtifactStatus(texturePath)).toMatchObject({ current: true });
		expect(await getMaterialImporterArtifactStatus(materialPath)).toMatchObject({ current: true });

		await writeFile(texturePath, await png(0, 255, 0));
		await refreshAssetRegistryPaths([texturePath]);
		const second = await inspectAutoReimport({ paths: ["assets/albedo.png"] });
		expect(second.candidates.find((candidate) => candidate.path === "assets/albedo.png")).toMatchObject({ current: false, willApply: true });
		expect(second.candidates.find((candidate) => candidate.path === "assets/surface.material")).toMatchObject({ current: true, reasons: ["dependency"], willApply: true });
		const secondJob = await runAutoReimport(second.fingerprint, { paths: ["assets/albedo.png"] });
		expect(secondJob.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "assets/albedo.png", status: "applied" }),
				expect.objectContaining({ path: "assets/surface.material", status: "applied", reasons: ["dependency"] }),
			])
		);
		expect((await getAutoReimportStatus()).lastJob).toMatchObject({ id: secondJob.id, status: "completed", appliedCount: 2 });
	});

	test("atomically synchronizes explicitly enabled external origins and rejects stale setting/plan leases", async () => {
		const originDirectory = await mkdtemp(join(tmpdir(), "zvibe-auto-origin-"));
		try {
			const originPath = join(originDirectory, "origin.png");
			const assetPath = join(directory, "assets/imported.png");
			await writeFile(originPath, await png(10, 20, 30));
			await copy(originPath, assetPath);
			const metadata = await readAssetMetadata(assetPath);
			metadata.originPath = originPath;
			metadata.importState = { status: "unchecked" };
			await writeAssetMetadata(assetPath, metadata);
			await rebuildAssetRegistry();

			const before = await getAutoReimportStatus();
			const configured = await setAutoReimportSettings(before.settingsFingerprint, { ...before.settings, watchImportedSources: true });
			await expect(setAutoReimportSettings(before.settingsFingerprint, configured.settings)).rejects.toThrow("settings changed");
			expect(await getAutoReimportOriginPaths()).toEqual([originPath]);

			const stalePlan = await inspectAutoReimport({ paths: ["assets/imported.png"] });
			await writeFile(originPath, await png(200, 150, 100));
			const job = await processAutoReimportOriginChanges([originPath]);
			expect(job).toMatchObject({ status: "completed", sourceCopies: [{ originPath, assetPath: "assets/imported.png", status: "copied", error: null }], appliedCount: 1 });
			expect(await readFile(assetPath)).toEqual(await readFile(originPath));
			await expect(runAutoReimport(stalePlan.fingerprint, { paths: ["assets/imported.png"] })).rejects.toThrow("plan changed");
			expect((await readAssetMetadata(assetPath)).importState.status).toBe("current");
		} finally {
			await remove(originDirectory);
		}
	});

	test("exposes the same exact settings/plan/execute contract through editor MCP actions", async () => {
		await writeFile(join(directory, "assets/action.png"), await png(1, 2, 3));
		await rebuildAssetRegistry();
		const refreshAutoReimportWatchers = vi.fn(async () => undefined);
		const refresh = vi.fn();
		const getAssetWatchStatus = vi.fn(() => ({ watching: true }));
		const options = { editor: { layout: { assets: { refreshAutoReimportWatchers, refresh, getAssetWatchStatus } } } } as never;
		const scene = {} as never;

		const inspected = await inspectAutoReimportAction(scene, { paths: ["assets/action.png"] });
		expect(inspected.plan).toMatchObject({ applyCount: 1, candidates: [expect.objectContaining({ path: "assets/action.png", willApply: true })] });
		await expect(runAutoReimportAction(scene, { paths: ["assets/action.png"], expectedFingerprint: inspected.plan.fingerprint, confirm: false }, options)).rejects.toThrow(
			"confirm=true"
		);
		const executed = await runAutoReimportAction(scene, { paths: ["assets/action.png"], expectedFingerprint: inspected.plan.fingerprint, confirm: true }, options);
		expect(executed).toMatchObject({ executed: true, job: { status: "completed", appliedCount: 1 } });
		expect(refresh).toHaveBeenCalledOnce();

		const status = await getAutoReimportStatus();
		const updated = await setAutoReimportSettingsAction(
			scene,
			{
				expectedSettingsFingerprint: status.settingsFingerprint,
				settings: { ...status.settings, enabled: false },
			},
			options
		);
		expect(updated).toMatchObject({ updated: true, settings: { enabled: false }, watcher: { watching: true } });
		expect(refreshAutoReimportWatchers).toHaveBeenCalledTimes(2);
	});
});

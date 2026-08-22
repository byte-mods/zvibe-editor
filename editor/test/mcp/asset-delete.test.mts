import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { basename, join } from "path";

import { deleteAsset, removeAssetPathAndImporterArtifacts } from "../../src/mcp/assets/assets";
import { removeDeletedPathsFromAutoReimportStatus } from "../../src/mcp/assets/auto-reimport";
import { getFbxExportManifestPath, withFbxExportLane } from "../../src/mcp/assets/fbx-export-state";
import { projectConfiguration } from "../../src/project/configuration";
import { rebuildAssetRegistry } from "../../src/mcp/assets/registry";
import { FileInspectorObject } from "../../src/editor/layout/inspector/file";

describe("asset deletion importer-artifact cleanup", () => {
	let root: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "babylon-asset-delete-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(root, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(root);
	});

	test("removes the exact GUID-owned importer artifact with a deleted asset", async () => {
		const asset = join(root, "assets/material.material");
		const guid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const retainedGuid = "11111111-2222-4333-8444-555555555555";
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(asset, "material");
		await writeJSON(`${asset}.bjsmeta.json`, { guid });
		await mkdir(join(root, ".bjseditor/imported-assets", guid), { recursive: true });
		await writeFile(join(root, ".bjseditor/imported-assets", guid, "material-import.json"), "{}");
		await mkdir(join(root, ".bjseditor/imported-assets", retainedGuid), { recursive: true });

		expect(await removeAssetPathAndImporterArtifacts(asset)).toEqual({
			removedImporterArtifacts: [`.bjseditor/imported-assets/${guid}`],
			removedFbxExportEvidence: [],
			removedMlTrainingProvenance: [],
		});
		expect(await pathExists(asset)).toBe(false);
		expect(await pathExists(`${asset}.bjsmeta.json`)).toBe(false);
		expect(await pathExists(join(root, ".bjseditor/imported-assets", guid))).toBe(false);
		expect(await pathExists(join(root, ".bjseditor/imported-assets", retainedGuid))).toBe(true);
	});

	test("unmounts an open File Inspector before deleting its backing asset", async () => {
		const asset = join(root, "assets/preview.mp4");
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(asset, "video");
		await rebuildAssetRegistry();
		const scene = { marker: "scene" } as never;
		const setEditedObject = vi.fn((_object: unknown, onChanged?: () => void) => onChanged?.());
		const refresh = vi.fn();
		const options = {
			editor: {
				layout: {
					inspector: { state: { editedObject: new FileInspectorObject(asset) }, setEditedObject },
					assets: { refresh },
				},
			},
		} as never;
		expect(await deleteAsset(scene, { path: "assets/preview.mp4", confirm: true }, options)).toMatchObject({ deleted: true, path: "assets/preview.mp4" });
		expect(setEditedObject).toHaveBeenCalledWith(scene, expect.any(Function));
		expect(refresh).toHaveBeenCalledOnce();
		expect(await pathExists(asset)).toBe(false);
	});

	test("deletes through MCP while the lazy Inspector panel is not mounted", async () => {
		const asset = join(root, "assets/headless.txt");
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(asset, "headless");
		await rebuildAssetRegistry();
		const refresh = vi.fn();
		const options = { editor: { layout: { inspector: undefined, assets: { refresh } } } } as never;
		expect(await deleteAsset({} as never, { path: "assets/headless.txt", confirm: true }, options)).toMatchObject({ deleted: true, path: "assets/headless.txt" });
		expect(refresh).toHaveBeenCalledOnce();
		expect(await pathExists(asset)).toBe(false);
	});

	test("collects nested asset GUIDs before deleting a folder and ignores unsafe metadata identities", async () => {
		const folder = join(root, "assets/collection");
		const first = join(folder, "first.png");
		const second = join(folder, "nested/second.material");
		const exported = join(folder, "nested/hero.fbx");
		const firstGuid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
		const secondGuid = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
		await mkdir(join(folder, "nested"), { recursive: true });
		await writeFile(first, "first");
		await writeFile(second, "second");
		await writeFile(exported, "fbx");
		await writeJSON(`${first}.bjsmeta.json`, { guid: firstGuid });
		await writeJSON(`${second}.bjsmeta.json`, { guid: secondGuid });
		await writeJSON(join(folder, "unsafe.bjsmeta.json"), { guid: "../../outside" });
		await mkdir(join(root, ".bjseditor/imported-assets", firstGuid), { recursive: true });
		await mkdir(join(root, ".bjseditor/imported-assets", secondGuid), { recursive: true });
		const exportEvidence = getFbxExportManifestPath(root, "assets/collection/nested/hero.fbx");
		const retainedEvidence = getFbxExportManifestPath(root, "assets/retained.fbx");
		await mkdir(join(root, ".bjseditor/fbx-exports"), { recursive: true });
		await writeJSON(exportEvidence, { destinationPath: "assets/collection/nested/hero.fbx" });
		await writeJSON(retainedEvidence, { destinationPath: "assets/retained.fbx" });

		expect(await removeAssetPathAndImporterArtifacts(folder)).toEqual({
			removedImporterArtifacts: [`.bjseditor/imported-assets/${firstGuid}`, `.bjseditor/imported-assets/${secondGuid}`],
			removedFbxExportEvidence: [`.bjseditor/fbx-exports/${basename(exportEvidence)}`],
			removedMlTrainingProvenance: [],
		});
		expect(await pathExists(folder)).toBe(false);
		expect(await pathExists(join(root, ".bjseditor/imported-assets", firstGuid))).toBe(false);
		expect(await pathExists(join(root, ".bjseditor/imported-assets", secondGuid))).toBe(false);
		expect(await pathExists(exportEvidence)).toBe(false);
		expect(await pathExists(retainedEvidence)).toBe(true);
	});

	test("waits for an in-flight FBX export before deleting its asset and evidence", async () => {
		const asset = join(root, "assets/exported.fbx");
		const evidence = getFbxExportManifestPath(root, "assets/exported.fbx");
		await mkdir(join(root, "assets"), { recursive: true });
		await mkdir(join(root, ".bjseditor/fbx-exports"), { recursive: true });
		await writeFile(asset, "fbx");
		await writeJSON(evidence, { destinationPath: "assets/exported.fbx" });
		let releaseExport!: () => void;
		let markExportStarted!: () => void;
		const exportStarted = new Promise<void>((resolve) => (markExportStarted = resolve));
		const exportBlocked = new Promise<void>((resolve) => (releaseExport = resolve));
		const exportOperation = withFbxExportLane(asset, async () => {
			markExportStarted();
			await exportBlocked;
		});
		await exportStarted;
		let deletionFinished = false;
		const deletion = removeAssetPathAndImporterArtifacts(asset).then((result) => {
			deletionFinished = true;
			return result;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(deletionFinished).toBe(false);
		expect(await pathExists(asset)).toBe(true);
		releaseExport();
		await exportOperation;
		expect(await deletion).toEqual({
			removedImporterArtifacts: [],
			removedFbxExportEvidence: [`.bjseditor/fbx-exports/${basename(evidence)}`],
			removedMlTrainingProvenance: [],
		});
		expect(await pathExists(asset)).toBe(false);
		expect(await pathExists(evidence)).toBe(false);
	});

	test("removes ML training provenance with its normally published model", async () => {
		const asset = join(root, "assets/policy.onnx");
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(asset, "onnx");
		await writeJSON(`${asset}.ml-training.json`, { contract: "zvibe-ml-training-v1" });
		expect(await removeAssetPathAndImporterArtifacts(asset)).toEqual({
			removedImporterArtifacts: [],
			removedFbxExportEvidence: [],
			removedMlTrainingProvenance: ["assets/policy.onnx.ml-training.json"],
		});
		expect(await pathExists(`${asset}.ml-training.json`)).toBe(false);
	});

	test("rejects a queued deletion when the open project changes before its mutation", async () => {
		const asset = join(root, "assets/retained.fbx");
		const otherRoot = await mkdtemp(join(tmpdir(), "babylon-asset-delete-other-"));
		try {
			await mkdir(join(root, "assets"), { recursive: true });
			await writeFile(asset, "fbx");
			let releaseExport!: () => void;
			let markExportStarted!: () => void;
			const exportStarted = new Promise<void>((resolve) => (markExportStarted = resolve));
			const exportBlocked = new Promise<void>((resolve) => (releaseExport = resolve));
			const exportOperation = withFbxExportLane(asset, async () => {
				markExportStarted();
				await exportBlocked;
			});
			await exportStarted;
			const deletion = removeAssetPathAndImporterArtifacts(asset);
			const deletionRejection = expect(deletion).rejects.toThrow(/open project changed/i);
			projectConfiguration.path = join(otherRoot, "Other.bjseditor");
			releaseExport();
			await exportOperation;
			await deletionRejection;
			expect(await pathExists(asset)).toBe(true);
		} finally {
			projectConfiguration.path = join(root, "Game.bjseditor");
			await remove(otherRoot);
		}
	});

	test("purges deleted paths from persisted Auto Reimport evidence without discarding unrelated results", async () => {
		const statusPath = join(root, ".bjseditor/auto-reimport-status.json");
		await mkdir(join(root, ".bjseditor"), { recursive: true });
		await writeJSON(statusPath, {
			id: "job",
			status: "completed",
			createdAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:00:01.000Z",
			planFingerprint: "fingerprint",
			triggerPaths: ["assets/deleted", "assets/retained.png"],
			results: [
				{ path: "assets/deleted/material.material", kind: "material", status: "applied", fingerprint: "a", triggers: ["assets/deleted"], reasons: ["source"], error: null },
				{ path: "assets/retained.png", kind: "texture", status: "current", fingerprint: "b", triggers: ["assets/retained.png"], reasons: ["source"], error: null },
			],
			sourceCopies: [
				{ originPath: "/outside/deleted", assetPath: "assets/deleted/material.material", status: "copied", error: null },
				{ originPath: "/outside/retained", assetPath: "assets/retained.png", status: "failed", error: "offline" },
			],
			appliedCount: 1,
			currentCount: 1,
			failedCount: 1,
		});

		expect(await removeDeletedPathsFromAutoReimportStatus([join(root, "assets/deleted")])).toBe(true);
		expect(await readJSON(statusPath)).toMatchObject({
			triggerPaths: ["assets/retained.png"],
			results: [{ path: "assets/retained.png", triggers: ["assets/retained.png"] }],
			sourceCopies: [{ assetPath: "assets/retained.png" }],
			appliedCount: 0,
			currentCount: 1,
			failedCount: 1,
		});
		expect(await removeDeletedPathsFromAutoReimportStatus([join(root, "assets/retained.png")])).toBe(true);
		expect(await pathExists(statusPath)).toBe(false);
	});
});

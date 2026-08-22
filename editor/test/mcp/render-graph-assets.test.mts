import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph } from "babylonjs-editor-tools";

import { createCustomRenderPass, listCustomRenderPasses, setCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import {
	applyCustomRenderGraphAsset,
	deleteCustomRenderGraphAsset,
	detachCustomRenderGraphAsset,
	getCustomRenderGraphAsset,
	getCustomRenderGraphAssetMigration,
	listCustomRenderGraphAssets,
	migrateCustomRenderGraphAsset,
	saveCustomRenderGraphAsset,
	updateAssignedCustomRenderGraphAsset,
} from "../../src/mcp/rendering/render-graph-assets";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/render-graph assets", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	let directory: string;
	let outsideDirectory: string;
	let previousPath: string | null;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		directory = await mkdtemp(join(tmpdir(), "babylon-render-graph-asset-"));
		outsideDirectory = await mkdtemp(join(tmpdir(), "babylon-render-graph-outside-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		disposeCustomRenderPassGraph(camera as any);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await rm(directory, { recursive: true, force: true });
		await rm(outsideDirectory, { recursive: true, force: true });
	});

	function graph(): { producer: any; consumer: any } {
		const producer = createCustomRenderPass(scene, { name: "Reusable Producer", output: "assetColor", ratio: 0.5 }, options);
		const consumer = createCustomRenderPass(
			scene,
			{
				name: "Reusable Consumer",
				dependencies: [producer.id],
				inputs: { assetSampler: { source: "pass", output: "assetColor" } },
				fragmentShader:
					"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D assetSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(assetSampler, vUV); }",
			},
			options
		);
		return { producer, consumer };
	}

	test("saves, lists, applies, dirty-tracks, updates, detaches and deletes a reusable graph asset", async () => {
		const { producer } = graph();
		const path = "assets/rendering/main.rendergraph.json";
		const saved = await saveCustomRenderGraphAsset(scene, { path, assetName: "Main Render Graph" }, options);
		expect(saved).toMatchObject({ path, name: "Main Render Graph", version: 2, assetRevision: 1, passCount: 2, enabledPassCount: 2, resourceCount: 1 });
		expect(saved.contentRevision).toMatch(/^[0-9a-f]{64}$/);
		expect((await listCustomRenderGraphAssets(scene, { limit: 1 })).assets).toEqual([expect.objectContaining({ path, passCount: 2 })]);
		expect(await getCustomRenderGraphAsset(scene, { path })).toMatchObject({ asset: { id: saved.id, revision: 1, passes: expect.any(Array) } });
		await expect(saveCustomRenderGraphAsset(scene, { path, assetName: "No Lease", overwrite: true, expectedRevision: "0".repeat(64) }, options)).rejects.toThrow(
			"revision is stale"
		);

		const applied = await applyCustomRenderGraphAsset(scene, { path, expectedRevision: saved.contentRevision }, options);
		expect(applied).toMatchObject({ applied: true, assignment: { path, id: saved.id, assetRevision: 1 }, executionOrder: [producer.id, expect.any(String)] });
		expect(listCustomRenderPasses(scene).renderGraphAsset).toMatchObject({ dirty: false, assignment: { path, contentRevision: saved.contentRevision } });

		setCustomRenderPass(scene, { id: producer.id, ratio: 0.25 }, options);
		expect(listCustomRenderPasses(scene).renderGraphAsset.dirty).toBe(true);
		await expect(updateAssignedCustomRenderGraphAsset(scene, { expectedRevision: "f".repeat(64) }, options)).rejects.toThrow("revision is stale");
		const updated = await updateAssignedCustomRenderGraphAsset(scene, { expectedRevision: saved.contentRevision, assetName: "Main Render Graph Updated" }, options);
		expect(updated).toMatchObject({ assetRevision: 2, name: "Main Render Graph Updated" });
		expect(updated.contentRevision).not.toBe(saved.contentRevision);
		expect(listCustomRenderPasses(scene).renderGraphAsset).toMatchObject({ dirty: false, assignment: { assetRevision: 2, contentRevision: updated.contentRevision } });

		await expect(deleteCustomRenderGraphAsset(scene, { path, expectedRevision: updated.contentRevision, confirm: true }, options)).rejects.toThrow("Detach");
		expect(detachCustomRenderGraphAsset(scene, { id: saved.id, expectedRevision: updated.contentRevision }, options)).toMatchObject({ detached: true, retainedPassCount: 2 });
		expect(listCustomRenderPasses(scene).renderGraphAsset.assignment).toBeNull();
		expect(await deleteCustomRenderGraphAsset(scene, { path, expectedRevision: updated.contentRevision, confirm: true }, options)).toMatchObject({ deleted: true, path });
		expect((await listCustomRenderGraphAssets(scene, {})).assets).toEqual([]);
		expect(options.editor.layout.assets.refresh).toHaveBeenCalled();
	});

	test("dry-runs and atomically persists deterministic v1-to-v2 migration with a backup", async () => {
		graph();
		const currentPath = "current.rendergraph.json";
		const saved = await saveCustomRenderGraphAsset(scene, { path: currentPath, assetName: "Legacy Graph" }, options);
		const current = JSON.parse(await readFile(join(directory, currentPath), "utf-8"));
		const path = "legacy.rendergraph.json";
		await writeFile(join(directory, path), JSON.stringify({ version: 1, type: current.type, name: current.name, passes: current.passes }, null, 2));

		const dryRun = await getCustomRenderGraphAssetMigration(scene, { path });
		expect(dryRun).toMatchObject({ sourceVersion: 1, targetVersion: 2, migrationRequired: true, steps: [{ id: "v1-identities-and-version-leases" }] });
		expect(dryRun.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
		const inMemory = await getCustomRenderGraphAsset(scene, { path });
		expect(inMemory).toMatchObject({ sourceVersion: 1, version: 2, migrationRequired: true, passCount: 2 });
		expect(inMemory.id).toMatch(/^rendergraph-/);

		await expect(migrateCustomRenderGraphAsset(scene, { path, expectedSourceRevision: saved.contentRevision }, options)).rejects.toThrow("revision is stale");
		const migrated = await migrateCustomRenderGraphAsset(scene, { path, expectedSourceRevision: dryRun.sourceRevision }, options);
		expect(migrated).toMatchObject({ migrated: true, path, version: 2, backupPath: dryRun.backupPath });
		expect(JSON.parse(await readFile(join(directory, path), "utf-8"))).toMatchObject({ version: 2, id: inMemory.id, revision: 1 });
		expect(JSON.parse(await readFile(join(directory, dryRun.backupPath), "utf-8"))).toMatchObject({ version: 1, name: "Legacy Graph" });
		expect(await applyCustomRenderGraphAsset(scene, { path, expectedRevision: dryRun.targetRevision }, options)).toMatchObject({ applied: true, id: inMemory.id });
	});

	test("rejects traversal, wrong extensions, symlink escapes, oversized or malformed assets, and stale apply without changing the scene", async () => {
		graph();
		const before = structuredClone(scene.metadata.babylonEditorCustomRenderPasses);
		await expect(saveCustomRenderGraphAsset(scene, { path: "../escape.rendergraph.json" }, options)).rejects.toThrow("stay inside");
		await expect(saveCustomRenderGraphAsset(scene, { path: "assets/graph.json" }, options)).rejects.toThrow(".rendergraph.json extension");
		await symlink(outsideDirectory, join(directory, "outside-link"));
		await expect(saveCustomRenderGraphAsset(scene, { path: "outside-link/escape.rendergraph.json" }, options)).rejects.toThrow("symbolic link outside");
		await writeFile(
			join(directory, "bad.rendergraph.json"),
			JSON.stringify({ version: 2, type: "babylon-editor-render-graph", id: "bad", name: "Bad", revision: 1, passes: [{}] })
		);
		await expect(getCustomRenderGraphAsset(scene, { path: "bad.rendergraph.json" })).rejects.toThrow("is invalid");

		const path = "safe.rendergraph.json";
		const saved = await saveCustomRenderGraphAsset(scene, { path, assetName: "Safe" }, options);
		await expect(applyCustomRenderGraphAsset(scene, { path, expectedRevision: "0".repeat(64) }, options)).rejects.toThrow("revision is stale");
		expect(scene.metadata.babylonEditorCustomRenderPasses).toEqual(before);
		expect(listCustomRenderPasses(scene).renderGraphAsset.assignment).toBeNull();
		expect(saved.passCount).toBe(2);
	});

	test("pages and searches a bounded asset library while surfacing malformed-file evidence", async () => {
		graph();
		for (const [path, name] of [
			["graphs/alpha.rendergraph.json", "Alpha"],
			["graphs/beta.rendergraph.json", "Beta"],
			["graphs/gamma.rendergraph.json", "Gamma"],
		] as const)
			await saveCustomRenderGraphAsset(scene, { path, assetName: name }, options);
		await writeFile(join(directory, "graphs/broken.rendergraph.json"), "{}");
		const page = await listCustomRenderGraphAssets(scene, { offset: 1, limit: 1 });
		expect(page).toMatchObject({ page: { total: 3, offset: 1, count: 1, hasMore: true }, errors: [{ path: "graphs/broken.rendergraph.json" }], truncated: false });
		expect(page.assets).toHaveLength(1);
		expect((await listCustomRenderGraphAssets(scene, { search: "GAMMA" })).assets).toEqual([expect.objectContaining({ name: "Gamma" })]);
	});
});

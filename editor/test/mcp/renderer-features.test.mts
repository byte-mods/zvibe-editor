import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph } from "babylonjs-editor-tools";

import { createCustomRenderPass, deleteCustomRenderPass, listCustomRenderPasses, setCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import { applyCustomRenderGraphAsset, getCustomRenderGraphAsset, saveCustomRenderGraphAsset } from "../../src/mcp/rendering/render-graph-assets";
import {
	deleteRendererFeatureAsset,
	deleteRendererFeatureInstance,
	getRendererFeatureAsset,
	getRendererFeatureDiagnostics,
	instantiateRendererFeature,
	listRendererFeatureAssets,
	listRendererFeatureInstances,
	refreshRendererFeatureInstance,
	saveRendererFeatureAsset,
	setRendererFeatureInstance,
} from "../../src/mcp/rendering/renderer-features";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/renderer features", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	let directory: string;
	let previousPath: string | null;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Feature Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		directory = await mkdtemp(join(tmpdir(), "babylon-renderer-feature-"));
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
	});

	function baseGraph(): { producer: any; consumer: any } {
		const producer = createCustomRenderPass(scene, { name: "Feature Producer", injectionPoint: "beforeRenderingPostProcessing", output: "featureColor", ratio: 0.5 }, options);
		const consumer = createCustomRenderPass(
			scene,
			{
				name: "Feature Consumer",
				injectionPoint: "afterRenderingPostProcessing",
				dependencies: [producer.id],
				inputs: { featureSampler: { source: "pass", output: "featureColor" } },
				fragmentShader:
					"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D featureSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(featureSampler, vUV); }",
			},
			options
		);
		return { producer, consumer };
	}

	test("saves, instantiates, filters, versions, refreshes and deletes exact renderer-feature revisions", async () => {
		const { producer, consumer } = baseGraph();
		const path = "assets/rendering/outline.renderfeature.json";
		const saved = await saveRendererFeatureAsset(scene, { path, assetName: "Outline Feature", passIds: [producer.id, consumer.id] }, options);
		expect(saved).toMatchObject({ path, name: "Outline Feature", assetRevision: 1, passCount: 2, resourceCount: 1 });
		expect(saved.contentRevision).toMatch(/^[0-9a-f]{64}$/);
		expect((await listRendererFeatureAssets(scene, { search: "OUTLINE", limit: 1 })).assets).toEqual([
			expect.objectContaining({
				path,
				passCount: 2,
				injectionPoints: expect.objectContaining({ beforeRenderingPostProcessing: 1, afterRenderingPostProcessing: 1 }),
			}),
		]);
		expect(await getRendererFeatureAsset(scene, { path })).toMatchObject({ asset: { id: saved.id, revision: 1, passes: expect.any(Array) } });
		await expect(instantiateRendererFeature(scene, { path, expectedRevision: "0".repeat(64), prefix: "outline" }, options)).rejects.toThrow("revision is stale");

		const created = await instantiateRendererFeature(
			scene,
			{
				path,
				expectedRevision: saved.contentRevision,
				instanceId: "outline-instance",
				instanceName: "Outline Instance",
				prefix: "outline",
				cameraFilter: { cameraIds: [camera.id], projection: "perspective" },
			},
			options
		);
		expect(created).toMatchObject({ instance: { id: "outline-instance", revision: 1, prefix: "outline" }, generatedPassIds: [expect.any(String), expect.any(String)] });
		expect(created.generatedPassIds.every((id: string) => id.startsWith("outline_"))).toBe(true);
		const listed = listRendererFeatureInstances(scene, { limit: 64 });
		expect(listed.instances).toEqual([expect.objectContaining({ id: "outline-instance", activeForCamera: true, passes: expect.any(Array), outputs: expect.any(Array) })]);
		const generatedProducer = created.instance.passes.find((pass: any) => pass.sourcePassId === producer.id);
		expect(() => setCustomRenderPass(scene, { id: generatedProducer.generatedPassId, ratio: 0.25 }, options)).toThrow("owned by renderer-feature instance");

		const filtered = setRendererFeatureInstance(
			scene,
			{ instanceId: "outline-instance", revision: 1, order: 3, cameraFilter: { cameraIds: ["other-camera"], projection: "any" } },
			options
		);
		expect(filtered.instance).toMatchObject({ revision: 2, order: 3, cameraFilter: { cameraIds: ["other-camera"] } });
		expect(listRendererFeatureInstances(scene, {}).instances[0].activeForCamera).toBe(false);
		expect(await getRendererFeatureDiagnostics(scene, {})).toMatchObject({ diagnostics: [{ status: "current", activeForCamera: false, activePassCount: 0 }] });

		setCustomRenderPass(scene, { id: producer.id, ratio: 0.25 }, options);
		const updated = await saveRendererFeatureAsset(
			scene,
			{ path, assetName: "Outline Feature", passIds: [producer.id, consumer.id], overwrite: true, expectedRevision: saved.contentRevision },
			options
		);
		expect(updated).toMatchObject({ assetRevision: 2 });
		expect(updated.contentRevision).not.toBe(saved.contentRevision);
		expect(await getRendererFeatureDiagnostics(scene, {})).toMatchObject({ diagnostics: [{ status: "outdated", latestAssetRevision: updated.contentRevision }] });
		await expect(refreshRendererFeatureInstance(scene, { instanceId: "outline-instance", revision: 2, expectedAssetRevision: "f".repeat(64) }, options)).rejects.toThrow(
			"revision is stale"
		);
		const refreshed = await refreshRendererFeatureInstance(scene, { instanceId: "outline-instance", revision: 2, expectedAssetRevision: updated.contentRevision }, options);
		expect(refreshed.instance).toMatchObject({ revision: 3, assetRevision: updated.contentRevision, prefix: "outline" });

		const refreshedProducer = refreshed.instance.passes.find((pass: any) => pass.sourcePassId === producer.id);
		const refreshedOutput = refreshed.instance.outputs.find((output: any) => output.sourceName === "featureColor");
		const external = createCustomRenderPass(
			scene,
			{
				name: "External Consumer",
				dependencies: [refreshedProducer.generatedPassId],
				inputs: { featureSampler: { source: "pass", output: refreshedOutput.generatedName } },
				fragmentShader:
					"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D featureSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(featureSampler, vUV); }",
			},
			options
		);
		expect(() => deleteRendererFeatureInstance(scene, { instanceId: "outline-instance", revision: 3, confirm: true }, options)).toThrow("Disconnect external passes");
		await expect(deleteRendererFeatureAsset(scene, { path, expectedRevision: updated.contentRevision, confirm: true }, options)).rejects.toThrow("instances");
		deleteCustomRenderPass(scene, { id: external.id }, options);
		expect(deleteRendererFeatureInstance(scene, { instanceId: "outline-instance", revision: 3, confirm: true }, options)).toMatchObject({
			deleted: true,
			instanceId: "outline-instance",
		});
		expect(await deleteRendererFeatureAsset(scene, { path, expectedRevision: updated.contentRevision, confirm: true }, options)).toMatchObject({ deleted: true, path });
		expect((await listRendererFeatureAssets(scene, {})).assets).toEqual([]);
	});

	test("keeps renderer-feature instances layered over reusable base render-graph assets", async () => {
		const { producer, consumer } = baseGraph();
		const featurePath = "feature.renderfeature.json";
		const feature = await saveRendererFeatureAsset(scene, { path: featurePath, passIds: [producer.id, consumer.id] }, options);
		await instantiateRendererFeature(scene, { path: featurePath, expectedRevision: feature.contentRevision, prefix: "layered" }, options);
		const graphPath = "base.rendergraph.json";
		const graph = await saveCustomRenderGraphAsset(scene, { path: graphPath, assetName: "Base Only" }, options);
		expect(graph.passCount).toBe(2);
		expect((await getCustomRenderGraphAsset(scene, { path: graphPath })).asset.passes.every((pass: any) => pass.rendererFeature === null)).toBe(true);
		await applyCustomRenderGraphAsset(scene, { path: graphPath, expectedRevision: graph.contentRevision }, options);
		expect(listCustomRenderPasses(scene).passes).toHaveLength(4);
		expect(listRendererFeatureInstances(scene, {}).instances).toHaveLength(1);
	});

	test("rejects incomplete closures, unsafe paths, wrong extensions, duplicate namespaces and stale destructive leases", async () => {
		const { producer, consumer } = baseGraph();
		await expect(saveRendererFeatureAsset(scene, { path: "incomplete.renderfeature.json", passIds: [consumer.id] }, options)).rejects.toThrow("unselected dependencies");
		await expect(saveRendererFeatureAsset(scene, { path: "../escape.renderfeature.json", passIds: [producer.id] }, options)).rejects.toThrow("stay inside");
		await expect(saveRendererFeatureAsset(scene, { path: "feature.json", passIds: [producer.id] }, options)).rejects.toThrow(".renderfeature.json extension");
		const path = "safe.renderfeature.json";
		const asset = await saveRendererFeatureAsset(scene, { path, passIds: [producer.id, consumer.id] }, options);
		await instantiateRendererFeature(scene, { path, expectedRevision: asset.contentRevision, prefix: "safe" }, options);
		await expect(instantiateRendererFeature(scene, { path, expectedRevision: asset.contentRevision, prefix: "safe" }, options)).rejects.toThrow("already exists");
		await expect(deleteRendererFeatureAsset(scene, { path, expectedRevision: "0".repeat(64), confirm: true }, options)).rejects.toThrow("revision is stale");
	});
});

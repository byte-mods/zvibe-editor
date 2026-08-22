import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { FreeCamera as CoreFreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine as CoreNullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 as CoreVector3 } from "@babylonjs/core/Maths/math.vector";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import { Scene as CoreScene } from "@babylonjs/core/scene";
import { configureDeferredLighting, rendererDataSettingsPreset, restoreRendererDataSelectionsBaseline, stopDeferredLighting } from "babylonjs-editor-tools";

import {
	assignRendererData,
	clearRendererDataAssignment,
	createRendererDataAsset,
	deleteRendererDataAsset,
	getRendererDataAsset,
	getDeferredLightingState,
	getRendererDataState,
	listRendererDataAssets,
	rebuildDeferredLighting,
	updateRendererDataAsset,
} from "../../src/mcp/rendering/renderer-data";
import { listMaterials, setMaterialProperties } from "../../src/mcp/materials/materials";
import { projectConfiguration } from "../../src/project/configuration";

function installGeometryBuffer(scene: CoreScene): void {
	const target = { textures: [{}, {}, {}], count: 3, getSize: () => ({ width: 320, height: 180 }), isReady: () => true };
	const renderer = {
		isSupported: true,
		normalsAreUnsigned: true,
		enableDepth: true,
		enableNormal: true,
		enablePosition: false,
		enableVelocity: false,
		enableVelocityLinear: false,
		enableReflectivity: false,
		enableScreenspaceDepth: false,
		enableIrradiance: false,
		getGBuffer: () => target,
		getTextureIndex: (type: number) => (type === 2 ? 0 : type === 1 ? 1 : type === 4 ? 2 : -1),
	} as unknown as GeometryBufferRenderer;
	scene.enableGeometryBufferRenderer = () => {
		(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = renderer;
		return renderer;
	};
	scene.disableGeometryBufferRenderer = () => {
		(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = null;
	};
}

describe("mcp/renderer-data", () => {
	let engine: NullEngine;
	let scene: Scene;
	let primary: FreeCamera;
	let secondary: FreeCamera;
	let directory: string;
	let previousPath: string | null;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() }, assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		primary = new FreeCamera("Primary", Vector3.Zero(), scene);
		secondary = new FreeCamera("Secondary", Vector3.Zero(), scene);
		scene.activeCamera = primary;
		directory = await mkdtemp(join(tmpdir(), "babylon-renderer-data-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		restoreRendererDataSelectionsBaseline(scene as any);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await rm(directory, { recursive: true, force: true });
	});

	test("creates, versions, assigns default and camera snapshots, clears, and deletes exact assets", async () => {
		const path = "assets/rendering/desktop.rendererdata.json";
		const created = await createRendererDataAsset(scene, { path, name: "Desktop Renderer", renderingPath: "forward" }, options);
		const metadataPath = join(directory, `${path}.bjsmeta.json`);
		await writeFile(metadataPath, JSON.stringify({ guid: "renderer-data-test-guid" }));
		expect(created).toMatchObject({ path, name: "Desktop Renderer", assetRevision: 1, renderingPath: "forward" });
		expect(created.contentRevision).toMatch(/^[0-9a-f]{64}$/);
		expect((await listRendererDataAssets(scene, { search: "DESKTOP" })).assets).toEqual([expect.objectContaining({ path, name: "Desktop Renderer" })]);

		const defaultAssignment = await assignRendererData(scene, { path, expectedRevision: created.contentRevision, selectionRevision: 1 }, options);
		expect(defaultAssignment).toMatchObject({ assigned: true, target: { type: "default" }, selections: { revision: 2 }, runtime: { configured: true } });
		await expect(deleteRendererDataAsset(scene, { path, expectedRevision: created.contentRevision, confirm: true }, options)).rejects.toThrow("assigned 1 time");

		const current = await getRendererDataAsset(scene, { path });
		const settings = rendererDataSettingsPreset("forward");
		settings.layerMask = 15;
		settings.depthTexture.mode = "linear";
		settings.depthPrimingMode = "forced";
		const updated = await updateRendererDataAsset(scene, { path, expectedRevision: current.contentRevision, name: "Desktop Renderer 2", settings }, options);
		expect(updated).toMatchObject({ assetRevision: 2, name: "Desktop Renderer 2", layerMask: 15, depthTextureMode: "linear" });
		expect(updated.contentRevision).not.toBe(current.contentRevision);
		expect(getRendererDataState(scene).selections.default).toMatchObject({ assetRevision: 1, contentRevision: created.contentRevision });

		const override = await assignRendererData(scene, { path, expectedRevision: updated.contentRevision, selectionRevision: 2, cameraId: secondary.id }, options);
		expect(override).toMatchObject({ selections: { revision: 3, cameras: [{ cameraId: secondary.id, asset: { assetRevision: 2 } }] } });
		expect(secondary.layerMask).toBe(15);
		expect(getRendererDataState(scene).runtime.cameras.find((camera: any) => camera.cameraId === secondary.id)).toMatchObject({
			source: "camera",
			depthTexture: { requestedMode: "linear", active: true },
		});

		expect(clearRendererDataAssignment(scene, { selectionRevision: 3, cameraId: secondary.id }, options)).toMatchObject({ cleared: true, selections: { revision: 4 } });
		expect(clearRendererDataAssignment(scene, { selectionRevision: 4 }, options)).toMatchObject({ cleared: true, selections: { revision: 5 }, runtime: { configured: false } });
		expect(await deleteRendererDataAsset(scene, { path, expectedRevision: updated.contentRevision, confirm: true }, options)).toMatchObject({
			deleted: true,
			path,
			metadataDeleted: true,
		});
		await expect(access(metadataPath)).rejects.toThrow();
		expect((await listRendererDataAssets(scene, {})).assets).toEqual([]);
	});

	test("rejects stale leases, unsupported no-fallback paths, traversal, and malformed assets atomically", async () => {
		const path = "deferred.rendererdata.json";
		const settings = rendererDataSettingsPreset("deferred");
		settings.fallbackToForward = false;
		const created = await createRendererDataAsset(scene, { path, name: "Deferred", settings }, options);
		await expect(assignRendererData(scene, { path, expectedRevision: "0".repeat(64), selectionRevision: 1 }, options)).rejects.toThrow("revision is stale");
		await expect(assignRendererData(scene, { path, expectedRevision: created.contentRevision, selectionRevision: 1 }, options)).rejects.toThrow(
			"Deferred rendering is unavailable"
		);
		expect(getRendererDataState(scene).selections).toMatchObject({ revision: 1, default: null, cameras: [] });
		await expect(createRendererDataAsset(scene, { path: "../escape.rendererdata.json", name: "Escape" }, options)).rejects.toThrow("stay inside");
		await writeFile(join(directory, "bad.rendererdata.json"), JSON.stringify({ version: 1, type: "babylon-editor-renderer-data", extra: true }));
		await expect(getRendererDataAsset(scene, { path: "bad.rendererdata.json" })).rejects.toThrow("unknown fields");
	});

	test("reports and exact-leased rebuilds a bounded deferred request with truthful forward fallback", async () => {
		const path = "assets/rendering/deferred.rendererdata.json";
		const created = await createRendererDataAsset(scene, { path, name: "Deferred Renderer", renderingPath: "deferred" }, options);
		const assigned = await assignRendererData(scene, { path, expectedRevision: created.contentRevision, selectionRevision: 1, cameraId: primary.id }, options);
		expect(assigned.runtime).toMatchObject({
			configured: true,
			cameras: [
				{
					cameraId: primary.id,
					requestedRenderingPath: "deferred",
					effectiveRenderingPath: "forward",
					deferred: { configured: false, active: false, errors: [expect.stringContaining("four simultaneous draw buffers")] },
				},
			],
		});
		const state = getDeferredLightingState(scene, { cameraId: primary.id });
		expect(state).toMatchObject({ selectionRevision: 2, requestedCameras: [{ cameraId: primary.id }], runtime: { active: false, cameraId: primary.id } });
		expect(() => rebuildDeferredLighting(scene, { cameraId: primary.id, selectionRevision: 1 }, options)).toThrow("selection revision is stale");
		expect(rebuildDeferredLighting(scene, { cameraId: primary.id, selectionRevision: 2 }, options)).toMatchObject({
			rebuilt: true,
			selectionRevision: 2,
			camera: { cameraId: primary.id, effectiveRenderingPath: "forward" },
			runtime: { active: false },
		});
	});

	test("returns deferred emissive attachment and authored material evidence through the MCP handler", () => {
		const localEngine = new CoreNullEngine();
		localEngine.getCaps().drawBuffersExtension = true;
		localEngine.getCaps().maxDrawBuffers = 8;
		const localScene = new CoreScene(localEngine);
		const localCamera = new CoreFreeCamera("MCP Deferred Camera", CoreVector3.Zero(), localScene);
		localScene.activeCamera = localCamera;
		try {
			installGeometryBuffer(localScene);
			const material = new StandardMaterial("MCP Deferred Emission", localScene);
			material.emissiveColor = new Color3(3, 0.25, 0.5);
			const box = CreateBox("MCP Deferred Emissive Box", { size: 10 }, localScene);
			box.material = material;
			const configured = configureDeferredLighting(localScene as any, localCamera as any);
			expect(configured.errors).toEqual([]);
			expect(configured).toMatchObject({ active: true, emissiveActive: true, emissiveMaterialCount: 1, emissiveMeshCount: 1 });

			const state = getDeferredLightingState(localScene as any, { cameraId: localCamera.id });
			expect(state.runtime).toMatchObject({
				cameraId: localCamera.id,
				emissiveActive: true,
				emissiveReady: false,
				emissiveMaterialCount: 1,
				emissiveMeshCount: 1,
				emissiveTextureCount: 0,
				emissiveSources: [
					{
						materialId: material.id,
						materialName: material.name,
						materialClassName: "StandardMaterial",
						meshCount: 1,
						color: [3, 0.25, 0.5],
						intensity: 1,
						textureName: null,
					},
				],
			});
			expect(listMaterials(localScene as any).materials).toEqual([expect.objectContaining({ id: material.id, name: material.name, className: "StandardMaterial" })]);
			const edited = setMaterialProperties(localScene as any, { materialId: material.id, properties: { "emissiveColor.g": 1 } }, options);
			expect(edited.deferredCameras).toEqual([
				expect.objectContaining({
					cameraId: localCamera.id,
					active: false,
					errors: [expect.stringContaining("emissive material color, texture, intensity, or mesh assignment changed")],
				}),
			]);
			expect(getDeferredLightingState(localScene as any, { cameraId: localCamera.id }).runtime).toMatchObject({
				active: false,
				errors: [expect.stringContaining("emissive material color, texture, intensity, or mesh assignment changed")],
			});
		} finally {
			stopDeferredLighting(localScene as any);
			localScene.dispose();
			localEngine.dispose();
		}
	});

	test("returns every simultaneous heterogeneous shadow source and invalidation through the MCP handler", () => {
		const localEngine = new CoreNullEngine();
		localEngine.getCaps().drawBuffersExtension = true;
		localEngine.getCaps().maxDrawBuffers = 8;
		localEngine.getCaps().maxTexturesImageUnits = 16;
		(localEngine as any)._features.supportShadowSamplers = true;
		const localScene = new CoreScene(localEngine);
		const localCamera = new CoreFreeCamera("MCP Multi-shadow Camera", CoreVector3.Zero(), localScene);
		localScene.activeCamera = localCamera;
		try {
			installGeometryBuffer(localScene);
			const material = new StandardMaterial("MCP Multi-shadow Material", localScene);
			const receiver = CreateBox("MCP Multi-shadow Receiver", { size: 10 }, localScene);
			receiver.material = material;
			receiver.receiveShadows = true;
			const caster = CreateBox("MCP Multi-shadow Caster", { size: 2 }, localScene);
			caster.material = material;

			const point = new PointLight("MCP Point Shadow", new CoreVector3(-2, 3, -4), localScene);
			point.shadowMinZ = 0.1;
			point.shadowMaxZ = 20;
			const pointGenerator = new ShadowGenerator(256, point, true);
			pointGenerator.filter = ShadowGenerator.FILTER_POISSONSAMPLING;
			pointGenerator.getShadowMap()!.renderList = [caster];

			const spot = new SpotLight("MCP Spot Shadow", new CoreVector3(2, 3, -4), new CoreVector3(-2, -3, 5), Math.PI / 2, 2, localScene);
			spot.shadowMinZ = 0.1;
			spot.shadowMaxZ = 20;
			const spotGenerator = new ShadowGenerator(512, spot, true);
			spotGenerator.filter = ShadowGenerator.FILTER_PCF;
			spotGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
			spotGenerator.getShadowMap()!.renderList = [caster];

			const configured = configureDeferredLighting(localScene as any, localCamera as any);
			expect(configured.errors).toEqual([]);
			const state = getDeferredLightingState(localScene as any, { cameraId: localCamera.id });
			expect(state.runtime).toMatchObject({
				active: true,
				shadowLightCount: 2,
				shadowMaximumSources: 8,
				shadowMapCount: 7,
				shadowSamplerCount: 3,
				shadowReceiverCount: 1,
				shadowSources: [
					{ lightId: point.id, mapType: "cube", filter: "poisson", mapCount: 6, casterCount: 1, receiverCount: 1, samplerCount: 1 },
					{ lightId: spot.id, mapType: "2d", filter: "pcf", mapCount: 1, casterCount: 1, receiverCount: 1, samplerCount: 1 },
				],
			});
			expect(state.runtimes).toEqual([expect.objectContaining({ cameraId: localCamera.id, shadowLightCount: 2 })]);

			spot.shadowEnabled = false;
			expect(getDeferredLightingState(localScene as any, { cameraId: localCamera.id }).runtime).toMatchObject({
				active: false,
				shadowLightCount: 1,
				errors: [expect.stringContaining("shadow generator changed")],
			});
		} finally {
			stopDeferredLighting(localScene as any);
			localScene.dispose();
			localEngine.dispose();
		}
	});

	test("returns distinct runtime evidence and exact rebuild targeting for every deferred camera", async () => {
		const path = "assets/rendering/multi-camera-deferred.rendererdata.json";
		const created = await createRendererDataAsset(scene, { path, name: "Multi-camera Deferred", renderingPath: "deferred" }, options);
		const assigned = await assignRendererData(scene, { path, expectedRevision: created.contentRevision, selectionRevision: 1 }, options);
		expect(assigned.runtime.cameras).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cameraId: primary.id, requestedRenderingPath: "deferred" }),
				expect.objectContaining({ cameraId: secondary.id, requestedRenderingPath: "deferred" }),
			])
		);
		const state = getDeferredLightingState(scene);
		expect(state.requestedCameras).toHaveLength(2);
		expect(state.runtimes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cameraId: primary.id, active: false, errors: [expect.stringContaining("four simultaneous draw buffers")] }),
				expect.objectContaining({ cameraId: secondary.id, active: false, errors: [expect.stringContaining("four simultaneous draw buffers")] }),
			])
		);
		expect(getDeferredLightingState(scene, { cameraId: secondary.id })).toMatchObject({
			requestedCameras: [{ cameraId: secondary.id }],
			runtime: { cameraId: secondary.id },
			runtimes: [{ cameraId: secondary.id }],
		});
		expect(rebuildDeferredLighting(scene, { cameraId: secondary.id, selectionRevision: 2 }, options)).toMatchObject({
			rebuilt: true,
			camera: { cameraId: secondary.id },
			runtime: { cameraId: secondary.id },
		});
	});
});

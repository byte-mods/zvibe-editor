import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, RawTexture, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";

import {
	configureRendererDataSelections,
	getRendererDataRuntime,
	IRendererDataAssetSnapshot,
	rendererDataAllowsFeature,
	rendererDataSelectionsMetadataKey,
	rendererDataSettingsPreset,
	restoreRendererDataSelectionsBaseline,
	validateRendererDataSettings,
} from "../../src/loading/renderer-data";

function asset(id: string, overrides: Record<string, unknown> = {}): IRendererDataAssetSnapshot {
	const settings = rendererDataSettingsPreset();
	return {
		version: 1,
		path: `assets/rendering/${id}.rendererdata.json`,
		id,
		name: id,
		assetRevision: 1,
		contentRevision: id.padEnd(64, "0").slice(0, 64),
		settings: validateRendererDataSettings({ ...settings, ...overrides }),
	};
}

function activeObserverCount(observers: Array<{ _willBeUnregistered: boolean }>): number {
	return observers.filter((observer) => !observer._willBeUnregistered).length;
}

function installGeometryBuffer(scene: Scene): void {
	const textures = [
		RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene),
		RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 255, 255]), 1, 1, scene),
		RawTexture.CreateRGBATexture(new Uint8Array([10, 10, 10, 255]), 1, 1, scene),
	];
	const target = { textures, count: 3, getSize: () => ({ width: 320, height: 180 }), isReady: () => true };
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

describe("loading/renderer-data", () => {
	let engine: NullEngine;
	let scene: Scene;
	let primary: FreeCamera;
	let secondary: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		primary = new FreeCamera("Primary", Vector3.Zero(), scene);
		secondary = new FreeCamera("Secondary", Vector3.Zero(), scene);
		scene.activeCamera = primary;
		primary.layerMask = 0xff;
		secondary.layerMask = 0xffff;
	});

	afterEach(() => {
		restoreRendererDataSelectionsBaseline(scene);
		scene.dispose();
		engine.dispose();
	});

	test("validates closed settings and rejects malformed nested fields", () => {
		expect(rendererDataSettingsPreset("forward-plus")).toMatchObject({ version: 1, renderingPath: "forward-plus", depthPrimingMode: "auto" });
		expect(() => validateRendererDataSettings({ ...rendererDataSettingsPreset(), unknown: true })).toThrow("unknown field");
		expect(() =>
			validateRendererDataSettings({ ...rendererDataSettingsPreset(), depthTexture: { mode: "linear", force32BitsFloat: false, includeTransparent: false, extra: true } })
		).toThrow("unknown field");
	});

	test("applies default and camera renderer selection, depth output, feature filtering, and exact baselines", () => {
		const defaultAsset = asset("default", {
			layerMask: 0x0f,
			postProcessesEnabled: false,
			depthTexture: { mode: "linear", force32BitsFloat: false, includeTransparent: true },
			depthPrimingMode: "forced",
			rendererFeatureInstanceIds: ["outline"],
		});
		const override = asset("override", { layerMask: 0xf0, rendererFeatureInstanceIds: [] });
		scene.metadata = {
			babylonEditorRendererFeatureInstances: [{ id: "outline" }],
			[rendererDataSelectionsMetadataKey]: { version: 1, revision: 3, default: defaultAsset, cameras: [{ cameraId: secondary.id, asset: override }] },
		};
		const runtime = configureRendererDataSelections(scene);
		expect(runtime).toMatchObject({ configured: true, revision: 3, defaultAssetId: "default", cameras: [{ cameraId: primary.id }, { cameraId: secondary.id }] });
		expect(primary.layerMask).toBe(0x0f);
		expect(secondary.layerMask).toBe(0xf0);
		expect(runtime.cameras[0].depthTexture).toMatchObject({ requestedMode: "linear", active: true, owned: true, includeTransparent: true });
		expect(rendererDataAllowsFeature(scene, primary, "outline")).toBe(true);
		expect(rendererDataAllowsFeature(scene, primary, "other")).toBe(false);
		expect(rendererDataAllowsFeature(scene, secondary, "outline")).toBe(false);

		restoreRendererDataSelectionsBaseline(scene);
		expect(primary.layerMask).toBe(0xff);
		expect(secondary.layerMask).toBe(0xffff);
		expect(getRendererDataRuntime(scene)).toMatchObject({ configured: false, cameras: [] });
	});

	test("reports and rolls back unsupported deferred selection when fallback is forbidden", () => {
		scene.metadata = {
			[rendererDataSelectionsMetadataKey]: {
				version: 1,
				revision: 2,
				default: asset("deferred", { renderingPath: "deferred", fallbackToForward: false, layerMask: 7 }),
				cameras: [],
			},
		};
		const runtime = configureRendererDataSelections(scene);
		expect(runtime).toMatchObject({ configured: false, revision: 2 });
		expect(runtime.cameras).toHaveLength(2);
		expect(runtime.cameras).toEqual(expect.arrayContaining([expect.objectContaining({ requestedRenderingPath: "deferred", effectiveRenderingPath: "forward" })]));
		expect(runtime.errors.join(" ")).toContain("Deferred rendering is unavailable");
		expect(primary.layerMask).toBe(0xff);
		expect(secondary.layerMask).toBe(0xffff);
	});

	test("configures, reports, and exactly restores multiple deferred cameras over one shared G-buffer", () => {
		engine.getCaps().drawBuffersExtension = true;
		engine.getCaps().maxDrawBuffers = 8;
		installGeometryBuffer(scene);
		const box = CreateBox("Deferred renderer-data box", { size: 100 }, scene);
		box.material = new StandardMaterial("Deferred renderer-data material", scene);
		new PointLight("Deferred renderer-data light", new Vector3(0, 200, -200), scene);
		scene.metadata = {
			[rendererDataSelectionsMetadataKey]: {
				version: 1,
				revision: 4,
				default: asset("multi-deferred", { renderingPath: "deferred", fallbackToForward: false }),
				cameras: [],
			},
		};

		const runtime = configureRendererDataSelections(scene);
		expect(runtime).toMatchObject({
			configured: true,
			revision: 4,
			cameras: [
				{ cameraId: primary.id, effectiveRenderingPath: "deferred", deferred: { active: true, cameraId: primary.id } },
				{ cameraId: secondary.id, effectiveRenderingPath: "deferred", deferred: { active: true, cameraId: secondary.id } },
			],
		});
		expect(scene.customRenderTargets).toHaveLength(2);
		expect(scene.geometryBufferRenderer).not.toBeNull();
		expect(getRendererDataRuntime(scene).cameras.map((camera) => camera.deferred?.cameraId)).toEqual([primary.id, secondary.id]);

		restoreRendererDataSelectionsBaseline(scene);
		expect(scene.customRenderTargets).toHaveLength(0);
		expect(scene.geometryBufferRenderer).toBeNull();
	});

	test("configures shared Forward+ tiles once instead of reallocating clustered resources every camera frame", () => {
		const clustered = new ClusteredLightContainer("Clustered", [], scene);
		vi.spyOn(clustered, "isSupported", "get").mockReturnValue(true);
		const horizontal = vi.spyOn(clustered, "horizontalTiles", "set");
		const vertical = vi.spyOn(clustered, "verticalTiles", "set");
		const slices = vi.spyOn(clustered, "depthSlices", "set");
		const range = vi.spyOn(clustered, "maxRange", "set");
		const enabled = vi.spyOn(clustered, "setEnabled");
		scene.metadata = {
			[rendererDataSelectionsMetadataKey]: {
				version: 1,
				revision: 1,
				default: asset("forward-plus", {
					renderingPath: "forward-plus",
					fallbackToForward: false,
					forwardPlus: { horizontalTiles: 10, verticalTiles: 6, depthSlices: 12, maxRange: 25_000 },
				}),
				cameras: [],
			},
		};
		const runtime = configureRendererDataSelections(scene);
		expect(runtime.configured).toBe(true);
		expect(runtime.cameras.every((camera) => camera.effectiveRenderingPath === "forward-plus")).toBe(true);
		expect([horizontal.mock.calls.length, vertical.mock.calls.length, slices.mock.calls.length, range.mock.calls.length]).toEqual([1, 1, 1, 1]);
		expect(enabled).not.toHaveBeenCalled();
		for (let index = 0; index < 20; index++) {
			scene.onBeforeCameraRenderObservable.notifyObservers(primary);
			scene.onAfterCameraRenderObservable.notifyObservers(primary);
		}
		expect([horizontal.mock.calls.length, vertical.mock.calls.length, slices.mock.calls.length, range.mock.calls.length]).toEqual([1, 1, 1, 1]);
		expect(enabled).not.toHaveBeenCalled();
	});

	test("refreshes once after cameras are added or removed without re-registering during observable dispatch", async () => {
		scene.metadata = {
			[rendererDataSelectionsMetadataKey]: {
				version: 1,
				revision: 1,
				default: asset("dynamic-cameras", { layerMask: 0x07 }),
				cameras: [],
			},
		};
		expect(configureRendererDataSelections(scene)).toMatchObject({ configured: true, cameras: [{ cameraId: primary.id }, { cameraId: secondary.id }] });
		expect(activeObserverCount(scene.onNewCameraAddedObservable.observers)).toBe(1);
		expect(activeObserverCount(scene.onCameraRemovedObservable.observers)).toBe(1);

		const added = new FreeCamera("Added after renderer-data configuration", Vector3.Zero(), scene);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(getRendererDataRuntime(scene).cameras).toEqual(expect.arrayContaining([expect.objectContaining({ cameraId: added.id, layerMask: 0x07 })]));
		expect(added.layerMask).toBe(0x07);
		expect(activeObserverCount(scene.onNewCameraAddedObservable.observers)).toBe(1);
		expect(activeObserverCount(scene.onCameraRemovedObservable.observers)).toBe(1);

		added.dispose();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(getRendererDataRuntime(scene).cameras.map((camera) => camera.cameraId)).not.toContain(added.id);
		expect(activeObserverCount(scene.onNewCameraAddedObservable.observers)).toBe(1);
		expect(activeObserverCount(scene.onCameraRemovedObservable.observers)).toBe(1);
	});
});

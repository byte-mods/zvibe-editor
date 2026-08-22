import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import {
	activeCameraStackMetadataKey,
	cameraStacksMetadataKey,
	configureCameraStacks,
	getCameraStackRuntime,
	restoreCameraStackBaseline,
	validateCameraStacks,
} from "../../src/loading/camera-stacks";

describe("loading/camera-stacks", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editorCamera: FreeCamera;
	let base: FreeCamera;
	let overlay: FreeCamera;
	let ownViewportOverlay: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editorCamera = new FreeCamera("Editor", Vector3.Zero(), scene);
		base = new FreeCamera("Base", new Vector3(0, 0, -10), scene);
		overlay = new FreeCamera("Overlay", new Vector3(0, 0, -10), scene);
		ownViewportOverlay = new FreeCamera("Minimap", new Vector3(0, 10, 0), scene);
		scene.activeCamera = editorCamera;
		scene.activeCameras = null;
		base.viewport = new Viewport(0.1, 0.2, 0.7, 0.6);
		overlay.viewport = new Viewport(0, 0, 0.25, 0.25);
		ownViewportOverlay.viewport = new Viewport(0.75, 0.75, 0.25, 0.25);
		scene.metadata = {
			[cameraStacksMetadataKey]: [
				{
					version: 1,
					id: "game-stack",
					name: "Game Stack",
					revision: 3,
					enabled: true,
					baseCameraId: base.id,
					baseClearColor: true,
					baseClearDepth: true,
					overlays: [
						{
							id: "hud-overlay",
							cameraId: overlay.id,
							enabled: true,
							order: 5,
							clearColor: false,
							clearDepth: false,
							postProcessing: false,
							viewportMode: "inherit-base",
						},
						{
							id: "minimap-overlay",
							cameraId: ownViewportOverlay.id,
							enabled: true,
							order: -5,
							clearColor: true,
							clearDepth: true,
							postProcessing: true,
							viewportMode: "camera",
						},
					],
				},
			],
			[activeCameraStackMetadataKey]: { id: "game-stack", revision: 3 },
		};
	});

	afterEach(() => {
		restoreCameraStackBaseline(scene);
		scene.dispose();
		engine.dispose();
	});

	test("renders the base and ordered overlays with exact clear, viewport and post-process policy", () => {
		const overlayPostProcess = { name: "Overlay Effect", dispose: () => undefined };
		(overlay as any)._postProcesses = [overlayPostProcess];
		const originalOverlayPostProcesses = (overlay as any)._postProcesses;
		const runtime = configureCameraStacks(scene);
		expect(runtime).toMatchObject({ active: true, stackId: "game-stack", revision: 3, valid: true });
		expect(scene.activeCamera).toBe(base);
		expect(scene.activeCameras?.map((camera) => camera.id)).toEqual([base.id, ownViewportOverlay.id, overlay.id]);

		scene.render();
		const rendered = getCameraStackRuntime(scene);
		expect(rendered.renderedCameraIds).toEqual([base.id, ownViewportOverlay.id, overlay.id]);
		expect(rendered.clearOperations).toEqual([
			{ cameraId: base.id, role: "base", clearColor: true, clearDepth: true },
			{ cameraId: ownViewportOverlay.id, role: "overlay", clearColor: true, clearDepth: true },
			{ cameraId: overlay.id, role: "overlay", clearColor: false, clearDepth: false },
		]);
		expect(rendered.suppressedPostProcessCameraIds).toEqual([overlay.id]);
		expect((overlay as any)._postProcesses).toBe(originalOverlayPostProcesses);
		expect((overlay as any)._postProcesses).toContain(overlayPostProcess);
		expect([overlay.viewport.x, overlay.viewport.y, overlay.viewport.width, overlay.viewport.height]).toEqual([0.1, 0.2, 0.7, 0.6]);
		expect([ownViewportOverlay.viewport.x, ownViewportOverlay.viewport.y, ownViewportOverlay.viewport.width, ownViewportOverlay.viewport.height]).toEqual([
			0.75, 0.75, 0.25, 0.25,
		]);

		restoreCameraStackBaseline(scene);
		expect(scene.activeCamera).toBe(editorCamera);
		expect(scene.activeCameras).toBeNull();
		expect([overlay.viewport.x, overlay.viewport.y, overlay.viewport.width, overlay.viewport.height]).toEqual([0, 0, 0.25, 0.25]);
	});

	test("reports stale active leases without mutating the current camera", () => {
		scene.metadata[activeCameraStackMetadataKey] = { id: "game-stack", revision: 2 };
		expect(configureCameraStacks(scene)).toMatchObject({ active: false, valid: false, error: "Active camera stack lease is stale. Expected revision 3." });
		expect(scene.activeCamera).toBe(editorCamera);
		expect(scene.activeCameras).toBeNull();
	});

	test("rejects unknown schema fields, duplicate cameras, rigs, and output render targets", () => {
		const source = scene.metadata[cameraStacksMetadataKey][0];
		expect(() => validateCameraStacks([{ ...source, surprise: true }])).toThrow("unsupported field");
		expect(() => validateCameraStacks([{ ...source, overlays: [...source.overlays, { ...source.overlays[0], id: "duplicate" }] }])).toThrow("more than once");

		(base as any).outputRenderTarget = {};
		expect(configureCameraStacks(scene)).toMatchObject({ active: false, valid: false, error: expect.stringContaining("output render target") });
		(base as any).outputRenderTarget = null;
		base.cameraRigMode = 1;
		expect(configureCameraStacks(scene)).toMatchObject({ active: false, valid: false, error: expect.stringContaining("camera rig") });
	});
});

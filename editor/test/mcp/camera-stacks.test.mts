import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { getCameraStackRuntime, restoreCameraStackBaseline } from "babylonjs-editor-tools";

import {
	addCameraStackOverlay,
	applyCameraStack,
	clearActiveCameraStack,
	createCameraStack,
	deleteCameraStack,
	listCameraStacks,
	removeCameraStackOverlay,
	setCameraStack,
	setCameraStackOverlay,
} from "../../src/mcp/rendering/camera-stacks";

describe("mcp/camera-stacks", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editorCamera: FreeCamera;
	let base: FreeCamera;
	let hud: FreeCamera;
	let minimap: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editorCamera = new FreeCamera("Editor Camera", Vector3.Zero(), scene);
		base = new FreeCamera("Game Camera", Vector3.Zero(), scene);
		hud = new FreeCamera("HUD Camera", Vector3.Zero(), scene);
		minimap = new FreeCamera("Minimap Camera", Vector3.Zero(), scene);
		scene.activeCamera = editorCamera;
		scene.activeCameras = null;
	});

	afterEach(() => {
		restoreCameraStackBaseline(scene as any);
		scene.dispose();
		engine.dispose();
	});

	test("authors, orders, applies, revisions, clears, and deletes a complete stack lifecycle", () => {
		const created = createCameraStack(scene, { name: "Gameplay", baseCameraId: base.id, baseClearColor: true, baseClearDepth: true }, options);
		expect(created.stack).toMatchObject({ revision: 1, baseCameraId: base.id, overlays: [] });
		const first = addCameraStackOverlay(
			scene,
			{ stackId: created.stack.id, revision: 1, cameraId: hud.id, order: 10, clearDepth: false, postProcessing: false, viewportMode: "inherit-base" },
			options
		);
		expect(first).toMatchObject({ stack: { revision: 2 }, overlay: { cameraId: hud.id, clearDepth: false } });
		const second = addCameraStackOverlay(
			scene,
			{ stackId: created.stack.id, revision: 2, cameraId: minimap.id, order: -10, clearColor: true, postProcessing: true, viewportMode: "camera" },
			options
		);
		expect(second.stack.revision).toBe(3);

		const applied = applyCameraStack(scene, { stackId: created.stack.id, revision: 3 }, options);
		expect(applied.runtime.cameras.map((camera: any) => camera.cameraId)).toEqual([base.id, minimap.id, hud.id]);
		expect(scene.activeCameras?.map((camera) => camera.id)).toEqual([base.id, minimap.id, hud.id]);
		expect(() => deleteCameraStack(scene, { stackId: created.stack.id, revision: 3, confirm: true }, options)).toThrow("is active");

		const updated = setCameraStackOverlay(
			scene,
			{ stackId: created.stack.id, revision: 3, overlayId: first.overlay.id, order: -20, clearColor: true, clearDepth: true },
			options
		);
		expect(updated).toMatchObject({ active: true, stack: { revision: 4 }, runtime: { active: true, revision: 4 } });
		expect(scene.activeCameras?.map((camera) => camera.id)).toEqual([base.id, hud.id, minimap.id]);

		const removed = removeCameraStackOverlay(scene, { stackId: created.stack.id, revision: 4, overlayId: second.overlay.id }, options);
		expect(removed).toMatchObject({ removed: true, stack: { revision: 5, overlays: [{ id: first.overlay.id }] }, active: true });
		expect(scene.activeCameras?.map((camera) => camera.id)).toEqual([base.id, hud.id]);
		expect(listCameraStacks(scene, { offset: 0, limit: 1 })).toMatchObject({ total: 1, hasMore: false, active: { id: created.stack.id, revision: 5 } });

		expect(clearActiveCameraStack(scene, { stackId: created.stack.id, revision: 5, confirm: true }, options)).toMatchObject({ cleared: true });
		expect(scene.activeCamera).toBe(editorCamera);
		expect(scene.activeCameras).toBeNull();
		expect(deleteCameraStack(scene, { stackId: created.stack.id, revision: 5, confirm: true }, options)).toMatchObject({ deleted: true, revision: 5 });
		expect(listCameraStacks(scene, {}).stacks).toEqual([]);
	});

	test("rejects stale revisions, duplicate cameras, unsupported targets, and false destructive confirmation atomically", () => {
		const created = createCameraStack(scene, { name: "Safe", baseCameraId: base.id }, options).stack;
		expect(() => setCameraStack(scene, { stackId: created.id, revision: 2, newName: "Stale" }, options)).toThrow("stale");
		const first = addCameraStackOverlay(scene, { stackId: created.id, revision: 1, cameraId: hud.id }, options);
		expect(() => addCameraStackOverlay(scene, { stackId: created.id, revision: 2, cameraId: hud.id }, options)).toThrow("more than once");
		expect(listCameraStacks(scene, {}).stacks[0]).toMatchObject({ revision: 2, overlays: [{ id: first.overlay.id }] });

		(minimap as any).outputRenderTarget = {};
		expect(() => addCameraStackOverlay(scene, { stackId: created.id, revision: 2, cameraId: minimap.id }, options)).toThrow("output render target");
		expect(listCameraStacks(scene, {}).stacks[0]).toMatchObject({ revision: 2, overlays: [{ id: first.overlay.id }] });
		expect(() => deleteCameraStack(scene, { stackId: created.id, revision: 2, confirm: false }, options)).toThrow("confirm: true");
	});

	test("reapplies active base changes without losing the original pre-stack camera baseline", () => {
		const created = createCameraStack(scene, { name: "Switchable", baseCameraId: base.id }, options).stack;
		applyCameraStack(scene, { stackId: created.id, revision: 1 }, options);
		const updated = setCameraStack(scene, { stackId: created.id, revision: 1, baseCameraId: minimap.id, baseClearColor: false }, options);
		expect(updated).toMatchObject({ active: true, stack: { revision: 2, baseCameraId: minimap.id }, runtime: { active: true } });
		expect(scene.activeCamera).toBe(minimap);
		expect(getCameraStackRuntime(scene as any)).toMatchObject({ stackId: created.id, revision: 2, cameras: [{ cameraId: minimap.id }] });
		clearActiveCameraStack(scene, { stackId: created.id, revision: 2, confirm: true }, options);
		expect(scene.activeCamera).toBe(editorCamera);
	});
});

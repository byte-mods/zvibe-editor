import { describe, expect, test } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import { configureTerrainStreaming } from "../../src/loading/terrain-streaming";

describe("loading/terrain-streaming", () => {
	test("activates only Ground tiles near the active camera in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const near = MeshBuilder.CreateGround("Near", { width: 10, height: 10 }, scene);
		const far = MeshBuilder.CreateGround("Far", { width: 10, height: 10 }, scene);
		far.position.x = 100;
		scene.metadata = { babylonEditorTerrainStreamingGroups: [{ terrainIds: [near.id, far.id], distance: 50, enabled: true }] };

		configureTerrainStreaming(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(near.isEnabled()).toBe(true);
		expect(far.isEnabled()).toBe(false);
		camera.position.x = 100;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(near.isEnabled()).toBe(false);
		expect(far.isEnabled()).toBe(true);
		scene.dispose();
		engine.dispose();
	});

	test("releases and restores already-loaded terrain geometry when configured", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const near = MeshBuilder.CreateGround("Near", { width: 10, height: 10 }, scene);
		const far = MeshBuilder.CreateGround("Far", { width: 10, height: 10 }, scene);
		far.position.x = 100;
		scene.metadata = { babylonEditorTerrainStreamingGroups: [{ terrainIds: [near.id, far.id], distance: 50, enabled: true, releaseGeometry: true }] };

		configureTerrainStreaming(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(far.getTotalVertices()).toBe(0);
		camera.position.x = 100;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(far.isEnabled()).toBe(true);
		expect(far.getTotalVertices()).toBeGreaterThan(0);
		scene.dispose();
		engine.dispose();
	});
});

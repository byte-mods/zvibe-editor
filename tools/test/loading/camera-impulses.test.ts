import { describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import { configureCameraImpulses, triggerCameraImpulse } from "../../src/loading/camera-impulses";

describe("loading/camera-impulses", () => {
	test("triggers a persisted decaying camera impulse in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		scene.metadata = { babylonEditorCameraImpulseSources: [{ id: "explosion", name: "Explosion", amplitude: 10, duration: 1, frequency: 0.5, direction: [1, 0, 0] }] };
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);

		configureCameraImpulses(scene);
		expect(triggerCameraImpulse(scene, "explosion")).toBe(true);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(camera.position.x).toBe(5);
		expect(triggerCameraImpulse(scene, "missing")).toBe(false);
		scene.dispose();
		engine.dispose();
	});
});

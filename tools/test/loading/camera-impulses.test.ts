import { describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Observable, Scene, Vector3 } from "@babylonjs/core";

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

	test("fires a channel-filtered collision impulse from physics contact context", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		const collider = MeshBuilder.CreateBox("Collider", { size: 1 }, scene);
		const collisionObservable = new Observable<any>();
		const setCollisionCallbackEnabled = vi.fn();
		(collider as any).physicsAggregate = { body: { setCollisionCallbackEnabled } };
		(scene as any)._physicsEngine = { getPhysicsPlugin: () => ({ onCollisionObservable: collisionObservable }) };
		scene.activeCamera = camera;
		scene.metadata = {
			babylonEditorActiveVirtualCameraId: "listener",
			babylonEditorVirtualCameras: [{ id: "listener", cameraId: camera.id, offset: [0, 0, 0], priority: 0, impulseChannelMask: 2 }],
			babylonEditorCameraImpulseSources: [
				{
					id: "impact",
					name: "Impact",
					amplitude: 1,
					duration: 1,
					frequency: 0.5,
					direction: [0, 1, 0],
					channelMask: 2,
					trigger: { type: "collision", nodeId: collider.id, minimumImpact: 1, includeContinued: false, cooldownSeconds: 0, useImpactDirection: true },
				},
			],
		};
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(500);

		configureCameraImpulses(scene);
		expect(setCollisionCallbackEnabled).toHaveBeenCalledWith(true);
		collisionObservable.notifyObservers({
			type: "COLLISION_STARTED",
			collider: { transformNode: collider },
			collidedAgainst: { transformNode: MeshBuilder.CreateBox("Other", { size: 1 }, scene) },
			point: Vector3.Zero(),
			normal: Vector3.Right(),
			impulse: 2,
		});
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(camera.position.x).toBeCloseTo(1, 6);
		scene.dispose();
		engine.dispose();
	});
});

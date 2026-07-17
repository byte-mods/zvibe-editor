import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Observable, Scene, Vector3 } from "babylonjs";

import {
	getPhysicsContactCapture,
	getPhysicsContactVisualization,
	setPhysicsContactVisualization,
	startPhysicsContactCapture,
	stopPhysicsContactCapture,
} from "../../src/mcp/physics/contacts";

describe("mcp/physics contact capture", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("captures bounded contact details and restores prior callback states", () => {
		const first = MeshBuilder.CreateBox("First", {}, scene);
		const second = MeshBuilder.CreateBox("Second", {}, scene);
		const makeBody = (node: any, enabled: boolean) => ({
			transformNode: node,
			_collisionCBEnabled: enabled,
			setCollisionCallbackEnabled(value: boolean) {
				this._collisionCBEnabled = value;
			},
		});
		const firstBody = makeBody(first, false);
		const secondBody = makeBody(second, true);
		(first as any).physicsAggregate = { body: firstBody };
		(second as any).physicsAggregate = { body: secondBody };
		const observable = new Observable<any>();
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ getPhysicsPlugin: () => ({ onCollisionObservable: observable }) } as any);

		expect(setPhysicsContactVisualization(scene, { enabled: true, normalScale: 50, pointSize: 5, lifetimeMs: 1000 }, options)).toMatchObject({
			enabled: true,
			normalScale: 50,
		});
		expect(startPhysicsContactCapture(scene, { maxEvents: 1 }, options)).toMatchObject({ active: true, capturedBodyCount: 2 });
		observable.notifyObservers({
			collider: firstBody,
			collidedAgainst: secondBody,
			colliderIndex: 0,
			collidedAgainstIndex: 0,
			type: "COLLISION_CONTINUED",
			point: Vector3.Zero(),
			normal: Vector3.Up(),
			distance: -1,
			impulse: 2,
		});
		observable.notifyObservers({
			collider: firstBody,
			collidedAgainst: secondBody,
			colliderIndex: 0,
			collidedAgainstIndex: 0,
			type: "COLLISION_STARTED",
			point: new Vector3(1, 2, 3),
			normal: Vector3.Up(),
			distance: -2,
			impulse: 4,
		});
		observable.notifyObservers({
			collider: secondBody,
			collidedAgainst: firstBody,
			colliderIndex: 0,
			collidedAgainstIndex: 0,
			type: "COLLISION_STARTED",
			point: new Vector3(4, 5, 6),
			normal: Vector3.Down(),
			distance: -3,
			impulse: 8,
		});

		expect(getPhysicsContactCapture(scene)).toMatchObject({
			active: true,
			eventCount: 1,
			droppedEvents: 1,
			events: [{ colliderNodeId: second.id, collidedAgainstNodeId: first.id, point: [4, 5, 6], impulse: 8 }],
		});
		expect(getPhysicsContactVisualization(scene)).toMatchObject({ enabled: true, activeOverlayCount: 2 });
		const overlay = scene.meshes.find((mesh) => mesh.name === "Physics Contact Debug")!;
		expect(overlay).toMatchObject({ isPickable: false, metadata: { doNotSerialize: true, notVisibleInGraph: true } });
		expect(stopPhysicsContactCapture(scene, {}, options)).toMatchObject({ active: false, stopped: true, eventCount: 1 });
		expect(firstBody._collisionCBEnabled).toBe(false);
		expect(secondBody._collisionCBEnabled).toBe(true);
		expect(getPhysicsContactVisualization(scene)).toMatchObject({ enabled: true, activeOverlayCount: 0 });
		expect(getPhysicsContactCapture(scene)).toMatchObject({ active: false, eventCount: 0, droppedEvents: 0, events: [] });
	});
});

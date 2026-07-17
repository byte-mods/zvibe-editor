import { describe, expect, test, vi } from "vitest";

import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { configureVehicles } from "../../src/loading/vehicles";

describe("loading/vehicles", () => {
	test("applies persisted engine force through authored input actions", () => {
		const callback = vi.fn();
		const body = { getMotionType: () => PhysicsMotionType.DYNAMIC, getLinearVelocity: () => Vector3.Zero(), getMassProperties: () => ({ mass: 10 }), applyForce: vi.fn() };
		const chassis = {
			physicsAggregate: { body },
			computeWorldMatrix: vi.fn(),
			getDirection: (axis: Vector3) => axis.clone(),
			getAbsolutePosition: () => Vector3.Zero(),
		};
		const scene = {
			metadata: {
				babylonEditorVehicles: [
					{
						id: "car",
						chassisNodeId: "chassis",
						enabled: true,
						maxEngineForce: 100,
						maxBrakeForce: 50,
						maxSpeed: 1000,
						maxSteerAngle: 0,
						wheelBase: 10,
						lateralGrip: 0,
						actionMapName: "Driving",
						accelerateActionName: "Accelerate",
						reverseActionName: "Reverse",
					},
				],
			},
			inputActions: { getValue: (_map: string, action: string) => (action === "Accelerate" ? 1 : 0) },
			getNodeById: () => chassis,
			getPhysicsEngine: () => null,
			getEngine: () => ({ getDeltaTime: () => 16 }),
			onBeforePhysicsObservable: {
				add: (value: any) => {
					callback.mockImplementation(value);
					return value;
				},
			},
		} as any;
		configureVehicles(scene);
		callback();
		expect(body.applyForce).toHaveBeenCalledWith(expect.objectContaining({ z: 100 }), expect.any(Vector3));
	});

	test("raycasts an authored wheel and applies suspension plus driven-wheel force", () => {
		const callback = vi.fn();
		const body = { getMotionType: () => PhysicsMotionType.DYNAMIC, getLinearVelocity: () => Vector3.Zero(), getMassProperties: () => ({ mass: 10 }), applyForce: vi.fn() };
		const chassis = {
			physicsAggregate: { body },
			computeWorldMatrix: vi.fn(),
			getWorldMatrix: () => Matrix.Identity(),
			getDirection: (axis: Vector3) => axis.clone(),
			getAbsolutePosition: () => Vector3.Zero(),
		};
		const scene = {
			metadata: {
				babylonEditorVehicles: [
					{
						id: "suspension-car",
						chassisNodeId: "chassis",
						enabled: true,
						maxEngineForce: 100,
						maxBrakeForce: 50,
						maxSpeed: 1000,
						maxSteerAngle: 0,
						lateralGrip: 0,
						actionMapName: "Driving",
						accelerateActionName: "Accelerate",
						reverseActionName: "Reverse",
						wheels: [{ id: "wheel", connectionPoint: [0, 0, 0], radius: 10, suspensionRestLength: 20, maxTravel: 10, springStrength: 100, damping: 0, driven: true }],
					},
				],
			},
			inputActions: { getValue: (_map: string, action: string) => (action === "Accelerate" ? 1 : 0) },
			getNodeById: () => chassis,
			getPhysicsEngine: () => ({ getTimeStep: () => 1 / 60, raycast: vi.fn(() => ({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(0, -15, 0) })) }),
			getEngine: () => ({ getDeltaTime: () => 16 }),
			onBeforePhysicsObservable: {
				add: (value: any) => {
					callback.mockImplementation(value);
					return value;
				},
			},
		} as any;
		configureVehicles(scene);
		callback();
		expect(body.applyForce).toHaveBeenCalledWith(expect.objectContaining({ y: 1500 }), expect.any(Vector3));
		expect(body.applyForce).toHaveBeenCalledWith(expect.objectContaining({ z: 100 }), expect.objectContaining({ y: -15 }));
	});
});

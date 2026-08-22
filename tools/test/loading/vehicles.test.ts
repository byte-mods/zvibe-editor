import { describe, expect, test, vi } from "vitest";

import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { createDefaultVehicleDrivetrain } from "../../src/loading/vehicle-drivetrain";
import { configureVehicles, getVehicleDrivetrainRuntimeState } from "../../src/loading/vehicles";

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

	test("couples an asymmetric authored axle with equal-and-opposite capped anti-roll forces", () => {
		const callback = vi.fn();
		const body = { getMotionType: () => PhysicsMotionType.DYNAMIC, getLinearVelocity: () => Vector3.Zero(), getMassProperties: () => ({ mass: 10 }), applyForce: vi.fn() };
		const chassis = {
			physicsAggregate: { body },
			computeWorldMatrix: vi.fn(),
			getWorldMatrix: () => Matrix.Identity(),
			getDirection: (axis: Vector3) => axis.clone(),
			getAbsolutePosition: () => Vector3.Zero(),
		};
		const raycast = vi
			.fn()
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(-10, -15, 0) })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 25, hitPointWorld: new Vector3(10, -25, 0) })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(-10, -15, 0) })
			.mockReturnValueOnce({ hasHit: false });
		const wheel = (id: string, x: number) => ({
			id,
			connectionPoint: [x, 0, 0],
			radius: 10,
			suspensionRestLength: 20,
			maxTravel: 10,
			springStrength: 0,
			damping: 0,
			antiRollGroup: "front",
		});
		const scene = {
			metadata: {
				babylonEditorVehicles: [
					{
						id: "anti-roll-car",
						chassisNodeId: "chassis",
						enabled: true,
						maxEngineForce: 0,
						maxBrakeForce: 0,
						maxSpeed: 1000,
						maxSteerAngle: 0,
						lateralGrip: 0,
						antiRollStiffness: 100,
						maxAntiRollForce: 500,
						wheels: [wheel("left", -10), wheel("right", 10)],
					},
				],
			},
			getNodeById: () => chassis,
			getPhysicsEngine: () => ({ getTimeStep: () => 1 / 60, raycast }),
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

		expect(body.applyForce).toHaveBeenCalledTimes(2);
		expect(body.applyForce).toHaveBeenNthCalledWith(1, expect.objectContaining({ y: 500 }), expect.objectContaining({ x: -10 }));
		expect(body.applyForce).toHaveBeenNthCalledWith(2, expect.objectContaining({ y: -500 }), expect.objectContaining({ x: 10 }));

		body.applyForce.mockClear();
		callback();
		expect(body.applyForce).toHaveBeenCalledTimes(1);
		expect(body.applyForce).toHaveBeenCalledWith(expect.objectContaining({ y: 500 }), expect.objectContaining({ x: -10 }));
	});

	test("reconstructs wheel-contact velocity and applies separate authored tire curves", () => {
		const callback = vi.fn();
		const body = {
			getMotionType: () => PhysicsMotionType.DYNAMIC,
			getLinearVelocity: () => new Vector3(40, 0, 0),
			getAngularVelocity: () => new Vector3(0, 1, 0),
			getMassProperties: () => ({ mass: 10 }),
			applyForce: vi.fn(),
		};
		const chassis = {
			physicsAggregate: { body },
			computeWorldMatrix: vi.fn(),
			getWorldMatrix: () => Matrix.Identity(),
			getDirection: (axis: Vector3) => axis.clone(),
			getAbsolutePosition: () => Vector3.Zero(),
		};
		const raycast = vi
			.fn()
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(-10, -15, 0) })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(10, -15, 0) });
		const curve = { extremumSlip: 0.4, extremumValue: 2, asymptoteSlip: 0.8, asymptoteValue: 0.5, stiffness: 1 };
		const wheel = (id: string, x: number) => ({
			id,
			connectionPoint: [x, 0, 0],
			radius: 10,
			mass: 20,
			dampingRate: 0,
			suspensionRestLength: 20,
			maxTravel: 10,
			springStrength: 0,
			damping: 0,
			driven: true,
		});
		const scene = {
			metadata: {
				babylonEditorVehicles: [
					{
						id: "tire-car",
						chassisNodeId: "chassis",
						enabled: true,
						maxEngineForce: 24000,
						maxBrakeForce: 0,
						maxSpeed: 2500,
						maxSteerAngle: 0,
						forwardFriction: curve,
						sidewaysFriction: curve,
						antiRollStiffness: 0,
						actionMapName: "Driving",
						accelerateActionName: "Accelerate",
						reverseActionName: "Reverse",
						wheels: [wheel("left", -10), wheel("right", 10)],
					},
				],
			},
			inputActions: { getValue: (_map: string, action: string) => (action === "Accelerate" ? 1 : 0) },
			getNodeById: () => chassis,
			getPhysicsEngine: () => ({ getTimeStep: () => 1 / 60, raycast }),
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

		const forwardForces = body.applyForce.mock.calls.map(([force]) => force.z).filter((value) => Math.abs(value) > 0.001);
		const sidewaysForces = body.applyForce.mock.calls.map(([force]) => force.x).filter((value) => Math.abs(value) > 0.001);
		expect(forwardForces).toHaveLength(2);
		expect(forwardForces.every((value) => value > 0)).toBe(true);
		expect(sidewaysForces).toHaveLength(2);
		expect(sidewaysForces.every((value) => value < 0)).toBe(true);
	});

	test("runs the shared geared drivetrain from exported Input Actions and exposes detached live state", () => {
		const callback = vi.fn();
		const body = {
			getMotionType: () => PhysicsMotionType.DYNAMIC,
			getLinearVelocity: () => Vector3.Zero(),
			getAngularVelocity: () => Vector3.Zero(),
			getMassProperties: () => ({ mass: 100 }),
			applyForce: vi.fn(),
		};
		const chassis = {
			physicsAggregate: { body },
			computeWorldMatrix: vi.fn(),
			getWorldMatrix: () => Matrix.Identity(),
			getDirection: (axis: Vector3) => axis.clone(),
			getAbsolutePosition: () => Vector3.Zero(),
		};
		const curve = { extremumSlip: 0.4, extremumValue: 1, asymptoteSlip: 0.8, asymptoteValue: 0.5, stiffness: 1 };
		const wheel = (id: string, radius: number) => ({
			id,
			connectionPoint: [id === "left" ? -10 : 10, 0, 0],
			radius,
			mass: 20,
			dampingRate: 0,
			suspensionRestLength: 20,
			maxTravel: 10,
			springStrength: 0,
			damping: 0,
			driven: true,
		});
		const drivetrain = {
			...createDefaultVehicleDrivetrain(),
			automatic: false,
			shiftDuration: 0,
			clutchEngagementRate: 100,
			differentialType: "limited-slip" as const,
			limitedSlipBias: 3,
		};
		let shiftUp = true;
		const scene = {
			metadata: {
				babylonEditorVehicles: [
					{
						id: "geared-car",
						chassisNodeId: "chassis",
						enabled: true,
						maxBrakeForce: 0,
						maxSpeed: 2500,
						maxSteerAngle: 0,
						forwardFriction: curve,
						sidewaysFriction: curve,
						drivetrain,
						actionMapName: "Driving",
						accelerateActionName: "Accelerate",
						reverseActionName: "Reverse",
						shiftUpActionName: "Shift Up",
						shiftDownActionName: "Shift Down",
						wheels: [wheel("left", 10), wheel("right", 20)],
					},
				],
			},
			inputActions: { getValue: (_map: string, action: string) => (action === "Accelerate" ? 1 : action === "Shift Up" && shiftUp ? 1 : 0) },
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
		const first = getVehicleDrivetrainRuntimeState(scene, "geared-car")!;
		expect(first).toMatchObject({ currentGear: 2, pendingGear: null, gearRatio: drivetrain.forwardGearRatios[1] });
		expect(first.outputTorque).toBeGreaterThan(0);
		shiftUp = false;
		callback();
		const live = getVehicleDrivetrainRuntimeState(scene, "geared-car")!;
		expect(live.currentGear).toBe(2);
		expect(live.wheelTorques.right.torqueShare).toBeGreaterThan(live.wheelTorques.left.torqueShare);
		expect(live.wheelTorques.right.torqueShare / live.wheelTorques.left.torqueShare).toBeLessThanOrEqual(3);
		live.currentGear = -1;
		expect(getVehicleDrivetrainRuntimeState(scene, "geared-car")!.currentGear).toBe(2);
	});
});

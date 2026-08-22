import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, PhysicsMotionType, Scene, Vector3 } from "babylonjs";
import { createDefaultVehicleDrivetrain } from "babylonjs-editor-tools";

import { createVehicle, deleteVehicle, listVehicles, setVehicle, setVehicleInput, setVehicleWheels, validateVehicles } from "../../src/mcp/physics/vehicles";

describe("mcp/vehicles", () => {
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

	test("persists a dynamic chassis controller and keeps injected preview input transient", () => {
		const chassis = MeshBuilder.CreateBox("Chassis", { size: 100 }, scene);
		(chassis as any).physicsAggregate = { body: { getMotionType: () => PhysicsMotionType.DYNAMIC } };

		expect(createVehicle(scene, { id: "car", name: "Player Car", chassisNodeId: chassis.id }, options)).toMatchObject({
			id: "car",
			chassisNodeId: chassis.id,
			maxEngineForce: 25000,
			forwardFriction: { extremumSlip: 0.4, extremumValue: 1, asymptoteSlip: 0.8, asymptoteValue: 0.5, stiffness: 1 },
			sidewaysFriction: { extremumSlip: 0.4, extremumValue: 1, asymptoteSlip: 0.8, asymptoteValue: 0.5, stiffness: 1 },
			drivetrain: {
				idleRpm: 800,
				redlineRpm: 6500,
				forwardGearRatios: [3.5, 2.2, 1.5, 1.15, 0.9, 0.75],
				differentialType: "limited-slip",
			},
			antiRollStiffness: 2000,
			maxAntiRollForce: 100000,
			wheels: [
				{ id: "front-left", mass: 20, dampingRate: 0.25, antiRollGroup: "front" },
				{ id: "front-right", antiRollGroup: "front" },
				{ id: "rear-left", antiRollGroup: "rear" },
				{ id: "rear-right", antiRollGroup: "rear" },
			],
		});
		expect(setVehicleInput(scene, { id: "car", throttle: 1, steering: -0.5, brake: 0.25, shiftUp: true })).toMatchObject({
			input: { throttle: 1, steering: -0.5, brake: 0.25, shiftUp: true, shiftDown: false },
		});
		expect(listVehicles(scene).vehicles).toMatchObject([{ id: "car", input: { throttle: 1, steering: -0.5, brake: 0.25, shiftUp: true } }]);
		expect(scene.metadata.babylonEditorVehicles[0]).not.toHaveProperty("input");
		expect(() => setVehicleInput(scene, { id: "car", shiftUp: true, shiftDown: true })).toThrow("exactly one gear command");
		expect(() => setVehicleWheels(scene, { id: "car", wheels: [{ id: "same" }, { id: "same" }] }, options)).toThrow("connectionPoint");
	});

	test("evaluates authored forward/sideways curves from per-contact velocity and publishes live slip evidence", () => {
		const chassis = MeshBuilder.CreateBox("Tire Chassis", { size: 100 }, scene);
		const applyForce = vi.fn();
		let linearVelocity = new Vector3(40, 0, 0);
		(chassis as any).physicsAggregate = {
			body: {
				getMotionType: () => PhysicsMotionType.DYNAMIC,
				getLinearVelocity: () => linearVelocity.clone(),
				getAngularVelocity: () => new Vector3(0, 1, 0),
				getMassProperties: () => ({ mass: 10 }),
				applyForce,
			},
		};
		const raycast = vi
			.fn()
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(-10, -15, 0) })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(10, -15, 0) })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(-10, -15, 0) })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(10, -15, 0) })
			.mockReturnValueOnce({ hasHit: false })
			.mockReturnValueOnce({ hasHit: false });
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ getTimeStep: () => 1 / 60, raycast } as any);
		const curve = { extremumSlip: 0.4, extremumValue: 2, asymptoteSlip: 0.8, asymptoteValue: 0.5, stiffness: 1 };

		createVehicle(
			scene,
			{
				id: "tire-car",
				chassisNodeId: chassis.id,
				maxEngineForce: 24000,
				forwardFriction: curve,
				sidewaysFriction: curve,
				antiRollStiffness: 0,
				wheels: [
					{
						id: "left",
						connectionPoint: [-10, 0, 0],
						radius: 10,
						mass: 20,
						dampingRate: 0,
						suspensionRestLength: 20,
						maxTravel: 10,
						springStrength: 0,
						damping: 0,
						driven: true,
					},
					{
						id: "right",
						connectionPoint: [10, 0, 0],
						radius: 10,
						mass: 20,
						dampingRate: 0,
						suspensionRestLength: 20,
						maxTravel: 10,
						springStrength: 0,
						damping: 0,
						driven: true,
					},
				],
			},
			options
		);
		// This assertion protects the exact curve-only #692 path used by saved vehicles authored before drivetrain metadata existed.
		delete scene.metadata.babylonEditorVehicles[0].drivetrain;
		setVehicleInput(scene, { id: "tire-car", throttle: 1 });
		scene.onBeforeRenderObservable.notifyObservers(scene);

		const states = listVehicles(scene).vehicles[0].wheelStates;
		expect(states.left.longitudinalSpeed).toBeCloseTo(10);
		expect(states.right.longitudinalSpeed).toBeCloseTo(-10);
		expect(states.left.sidewaysSlip).toBeCloseTo(0.4);
		expect(states.left.sidewaysGrip).toBeCloseTo(2);
		expect(states.left.forwardSlip).toBeCloseTo(-0.2);
		expect(states.left.forwardGrip).toBeCloseTo(1.5);
		expect(states.left.forwardForce).toBeGreaterThan(0);
		expect(states.left.sidewaysForce).toBeLessThan(0);
		expect(states.left.rpm).toBeGreaterThan(0);
		expect(applyForce).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number) }), expect.any(Vector3));
		linearVelocity = new Vector3(80, 0, 0);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listVehicles(scene).vehicles[0].wheelStates.left.sidewaysSlip).toBeCloseTo(0.8);
		expect(listVehicles(scene).vehicles[0].wheelStates.left.sidewaysGrip).toBeCloseTo(0.5);
		const groundedRpm = listVehicles(scene).vehicles[0].wheelStates.left.rpm;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listVehicles(scene).vehicles[0].wheelStates.left).toMatchObject({ grounded: false, forwardSlip: 0, sidewaysSlip: 0 });
		expect(listVehicles(scene).vehicles[0].wheelStates.left.rpm).toBeGreaterThan(groundedRpm);

		const before = structuredClone(scene.metadata.babylonEditorVehicles[0]);
		expect(() => setVehicle(scene, { id: "tire-car", forwardFriction: { ...curve, asymptoteSlip: 0.2 } }, options)).toThrow("asymptoteSlip must be at least");
		expect(scene.metadata.babylonEditorVehicles[0]).toEqual(before);
	});

	test("executes a manual geared drivetrain and publishes bounded differential torque evidence", () => {
		const chassis = MeshBuilder.CreateBox("Drivetrain Chassis", { size: 100 }, scene);
		const applyForce = vi.fn();
		(chassis as any).physicsAggregate = {
			body: {
				getMotionType: () => PhysicsMotionType.DYNAMIC,
				getLinearVelocity: () => Vector3.Zero(),
				getAngularVelocity: () => Vector3.Zero(),
				getMassProperties: () => ({ mass: 100 }),
				applyForce,
			},
		};
		const raycast = vi.fn(() => ({ hasHit: true, hitDistance: 15, hitPointWorld: new Vector3(0, -15, 0) }));
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ getTimeStep: () => 1 / 60, raycast } as any);
		const drivetrain = {
			...createDefaultVehicleDrivetrain(),
			automatic: false,
			shiftDuration: 0,
			clutchEngagementRate: 100,
			differentialType: "limited-slip" as const,
			limitedSlipBias: 3,
		};
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

		createVehicle(scene, { id: "geared-car", chassisNodeId: chassis.id, drivetrain, antiRollStiffness: 0, wheels: [wheel("left", 10), wheel("right", 20)] }, options);
		setVehicleInput(scene, { id: "geared-car", throttle: 1, gear: 2 });
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const firstStep = listVehicles(scene).vehicles[0];
		expect(firstStep.drivetrainState.outputTorque).toBeGreaterThan(0);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		const live = listVehicles(scene).vehicles[0];
		expect(live.drivetrainState).toMatchObject({ currentGear: 2, pendingGear: null, gearRatio: drivetrain.forwardGearRatios[1] });
		expect(live.drivetrainState.engineRpm).toBeGreaterThanOrEqual(drivetrain.idleRpm);
		expect(live.wheelStates.left).toMatchObject({ driveTorque: expect.any(Number), differentialTorque: 0, brakeTorque: 0, totalTorque: expect.any(Number) });
		expect(live.wheelStates.right.torqueShare).toBeGreaterThan(live.wheelStates.left.torqueShare);
		expect(live.wheelStates.right.torqueShare / live.wheelStates.left.torqueShare).toBeLessThanOrEqual(3);
		expect(applyForce).toHaveBeenCalled();

		const before = structuredClone(scene.metadata.babylonEditorVehicles[0]);
		expect(() => setVehicle(scene, { id: "geared-car", drivetrain: { ...drivetrain, upshiftRpm: drivetrain.downshiftRpm } }, options)).toThrow("upshiftRpm");
		expect(scene.metadata.babylonEditorVehicles[0]).toEqual(before);
		deleteVehicle(scene, { id: "geared-car" }, options);
		createVehicle(scene, before, options);
		expect(listVehicles(scene).vehicles[0].drivetrainState).toBeNull();
		deleteVehicle(scene, { id: "geared-car" }, options);

		let shiftUp = true;
		(scene as any).inputActions = {
			getValue: (_map: string, action: string) => (action === "Accelerate" ? 1 : action === "Shift Up" && shiftUp ? 1 : 0),
		};
		createVehicle(
			scene,
			{ id: "action-car", chassisNodeId: chassis.id, drivetrain, actionMapName: "Driving", antiRollStiffness: 0, wheels: [wheel("left", 10), wheel("right", 20)] },
			options
		);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listVehicles(scene).vehicles[0].drivetrainState.currentGear).toBe(2);
		shiftUp = false;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(listVehicles(scene).vehicles[0].drivetrainState.currentGear).toBe(2);
	});

	test("applies bounded axle anti-roll forces and rejects invalid updates atomically", () => {
		const chassis = MeshBuilder.CreateBox("Anti-roll Chassis", { size: 100 }, scene);
		const applyForce = vi.fn();
		(chassis as any).physicsAggregate = {
			body: {
				getMotionType: () => PhysicsMotionType.DYNAMIC,
				getLinearVelocity: () => ({ x: 0, y: 0, z: 0, lengthSquared: () => 0 }),
				getMassProperties: () => ({ mass: 10 }),
				applyForce,
			},
		};
		const raycast = vi
			.fn()
			.mockReturnValueOnce({ hasHit: true, hitDistance: 15, hitPointWorld: { x: -10, y: -15, z: 0, asArray: () => [-10, -15, 0] } })
			.mockReturnValueOnce({ hasHit: true, hitDistance: 25, hitPointWorld: { x: 10, y: -25, z: 0, asArray: () => [10, -25, 0] } });
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ getTimeStep: () => 1 / 60, raycast } as any);

		createVehicle(
			scene,
			{
				id: "anti-roll-car",
				chassisNodeId: chassis.id,
				antiRollStiffness: 100,
				maxAntiRollForce: 500,
				wheels: [
					{
						id: "left",
						connectionPoint: [-10, 0, 0],
						radius: 10,
						suspensionRestLength: 20,
						maxTravel: 10,
						springStrength: 0,
						damping: 0,
						antiRollGroup: "front",
					},
					{
						id: "right",
						connectionPoint: [10, 0, 0],
						radius: 10,
						suspensionRestLength: 20,
						maxTravel: 10,
						springStrength: 0,
						damping: 0,
						antiRollGroup: "front",
					},
				],
			},
			options
		);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(applyForce).toHaveBeenCalledWith(expect.objectContaining({ y: 500 }), expect.objectContaining({ x: -10 }));
		expect(applyForce).toHaveBeenCalledWith(expect.objectContaining({ y: -500 }), expect.objectContaining({ x: 10 }));
		expect(listVehicles(scene).vehicles[0].wheelStates).toMatchObject({ left: { antiRollForce: 500 }, right: { antiRollForce: -500 } });

		const before = structuredClone(scene.metadata.babylonEditorVehicles[0]);
		expect(() => setVehicle(scene, { id: "anti-roll-car", antiRollStiffness: 1000001 }, options)).toThrow("antiRollStiffness");
		expect(scene.metadata.babylonEditorVehicles[0]).toEqual(before);
		expect(() =>
			setVehicleWheels(
				scene,
				{
					id: "anti-roll-car",
					wheels: [
						{ ...before.wheels[0], antiRollGroup: "unpaired" },
						{ ...before.wheels[1], antiRollGroup: null },
					],
				},
				options
			)
		).toThrow('anti-roll group "unpaired" must contain exactly two wheels');
		expect(scene.metadata.babylonEditorVehicles[0]).toEqual(before);

		deleteVehicle(scene, { id: "anti-roll-car" }, options);
		createVehicle(scene, before, options);
		expect(listVehicles(scene).vehicles[0].wheelStates).toEqual({});
	});

	test("rejects a non-dynamic chassis and reports missing input mapping as a warning", () => {
		const chassis = MeshBuilder.CreateBox("Static Chassis", { size: 100 }, scene);
		(chassis as any).physicsAggregate = { body: { getMotionType: () => PhysicsMotionType.STATIC } };
		expect(() => createVehicle(scene, { chassisNodeId: chassis.id }, options)).toThrow("dynamic physics body");
		(scene.metadata ??= {}).babylonEditorVehicles = [
			{
				id: "broken",
				name: "Broken",
				chassisNodeId: chassis.id,
				enabled: true,
				maxEngineForce: 1,
				maxBrakeForce: 1,
				maxSpeed: 1,
				maxSteerAngle: 0,
				wheelBase: 1,
				lateralGrip: 0,
			},
		];
		expect(validateVehicles(scene)).toMatchObject({ errors: [expect.stringContaining("dynamic chassis")], warnings: [expect.stringContaining("no input action map")] });
	});
});

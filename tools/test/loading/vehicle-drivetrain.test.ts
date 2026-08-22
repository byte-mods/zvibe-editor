import { describe, expect, test } from "vitest";

import {
	createDefaultVehicleDrivetrain,
	createInitialVehicleDrivetrainState,
	evaluateVehicleEngineTorque,
	stepVehicleDrivetrain,
	validateVehicleDrivetrain,
} from "../../src/loading/vehicle-drivetrain";

const wheels = [
	{ id: "left", rpm: 100, driven: true, grounded: true, forwardSlip: 0.1 },
	{ id: "right", rpm: 300, driven: true, grounded: true, forwardSlip: 1.5 },
];

describe("loading/vehicle-drivetrain", () => {
	test("validates a complete bounded configuration and interpolates its engine torque curve", () => {
		const configuration = createDefaultVehicleDrivetrain();
		expect(() => validateVehicleDrivetrain(configuration)).not.toThrow();
		expect(evaluateVehicleEngineTorque(configuration, 2150)).toBeCloseTo(350);
		expect(evaluateVehicleEngineTorque(configuration, 100000)).toBe(300);

		expect(() => validateVehicleDrivetrain({ ...configuration, forwardGearRatios: [3, 3] })).toThrow("strictly decreasing");
		expect(() => validateVehicleDrivetrain({ ...configuration, upshiftRpm: configuration.downshiftRpm })).toThrow("upshiftRpm");
		expect(() => validateVehicleDrivetrain({ ...configuration, magicTorque: 1 })).toThrow("unsupported field");
		expect(() =>
			validateVehicleDrivetrain({ ...configuration, engineTorqueCurve: configuration.engineTorqueCurve.map((key, index) => (index === 0 ? { ...key, boost: 1 } : key)) })
		).toThrow("unsupported field");
	});

	test("shifts automatic and manual transmissions through a timed clutch with bounded RPM", () => {
		const automatic = { ...createDefaultVehicleDrivetrain(), shiftDuration: 0.1, clutchEngagementRate: 10 };
		let state = { ...createInitialVehicleDrivetrainState(automatic), engineRpm: automatic.upshiftRpm };
		state = stepVehicleDrivetrain(automatic, state, { throttle: 1, shiftUp: false, shiftDown: false }, wheels, 0.05);
		expect(state).toMatchObject({ currentGear: 1, pendingGear: 2, clutch: 0, outputTorque: 0 });
		state = stepVehicleDrivetrain(automatic, state, { throttle: 1, shiftUp: false, shiftDown: false }, wheels, 0.05);
		expect(state).toMatchObject({ currentGear: 1, pendingGear: 2, shiftTimeRemaining: 0.05 });
		state = stepVehicleDrivetrain(automatic, state, { throttle: 1, shiftUp: false, shiftDown: false }, wheels, 0.05);
		expect(state).toMatchObject({ currentGear: 2, pendingGear: null });
		expect(state.engineRpm).toBeGreaterThanOrEqual(automatic.idleRpm);
		expect(state.engineRpm).toBeLessThanOrEqual(automatic.redlineRpm);

		const manual = { ...automatic, automatic: false, shiftDuration: 0 };
		let manualState = createInitialVehicleDrivetrainState(manual);
		manualState = stepVehicleDrivetrain(manual, manualState, { throttle: 1, shiftUp: true, shiftDown: false }, wheels, 1 / 60);
		expect(manualState.currentGear).toBe(2);
		manualState = stepVehicleDrivetrain(manual, manualState, { throttle: 1, shiftUp: true, shiftDown: false }, wheels, 1 / 60);
		expect(manualState.currentGear).toBe(2);
		manualState = stepVehicleDrivetrain(manual, manualState, { throttle: 0, shiftUp: false, shiftDown: false, requestedGear: -1 }, wheels, 1 / 60);
		expect(manualState.currentGear).toBe(-1);
		manualState = stepVehicleDrivetrain(manual, manualState, { throttle: 0, shiftUp: false, shiftDown: false, requestedGear: Number.NaN }, wheels, 1 / 60);
		expect(manualState.currentGear).toBe(-1);
	});

	test("distributes open, limited-slip, and locked differential torque without creating net coupling torque", () => {
		const baseline = { ...createDefaultVehicleDrivetrain(), shiftDuration: 0, clutchEngagementRate: 100 };
		const initial = createInitialVehicleDrivetrainState(baseline);
		const open = stepVehicleDrivetrain({ ...baseline, differentialType: "open" }, initial, { throttle: 1, shiftUp: false, shiftDown: false }, wheels, 1 / 60);
		expect(open.wheelTorques.left.driveTorque).toBeCloseTo(open.wheelTorques.right.driveTorque);
		expect(open.wheelTorques.left.differentialTorque).toBe(0);

		const limited = stepVehicleDrivetrain(
			{ ...baseline, differentialType: "limited-slip", limitedSlipBias: 3 },
			initial,
			{ throttle: 1, shiftUp: false, shiftDown: false },
			wheels,
			1 / 60
		);
		expect(limited.wheelTorques.left.driveTorque).toBeGreaterThan(limited.wheelTorques.right.driveTorque);
		expect(limited.wheelTorques.left.torqueShare / limited.wheelTorques.right.torqueShare).toBeLessThanOrEqual(3);

		const locked = stepVehicleDrivetrain(
			{ ...baseline, differentialType: "locked", differentialLockStrength: 5 },
			initial,
			{ throttle: 1, shiftUp: false, shiftDown: false },
			wheels,
			1 / 60
		);
		expect(locked.wheelTorques.left.differentialTorque).toBeGreaterThan(0);
		expect(locked.wheelTorques.right.differentialTorque).toBeLessThan(0);
		expect(locked.wheelTorques.left.differentialTorque + locked.wheelTorques.right.differentialTorque).toBeCloseTo(0);
		expect(locked.wheelTorques.left.totalTorque + locked.wheelTorques.right.totalTorque).toBeCloseTo(locked.outputTorque);

		const malformed = stepVehicleDrivetrain(
			{ ...baseline, differentialType: "locked" },
			initial,
			{ throttle: 1, shiftUp: false, shiftDown: false },
			[{ ...wheels[0], rpm: Number.NaN, forwardSlip: Number.NaN }, wheels[1]],
			1 / 60
		);
		expect(Object.values(malformed.wheelTorques).every((wheel) => Number.isFinite(wheel.totalTorque))).toBe(true);
	});
});

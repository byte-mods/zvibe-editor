/** Differential policies supported by the portable raycast-wheel solver. */
export type VehicleDifferentialType = "open" | "limited-slip" | "locked";

/** One absolute N·m sample on the bounded engine torque curve. */
export interface IVehicleEngineTorqueKey {
	rpm: number;
	torque: number;
}

/** Complete persisted drivetrain authoring shared by editor preview and exported games. */
export interface IVehicleDrivetrainConfiguration {
	engineTorqueCurve: IVehicleEngineTorqueKey[];
	idleRpm: number;
	redlineRpm: number;
	engineInertia: number;
	engineBrakingTorque: number;
	forwardGearRatios: number[];
	reverseGearRatio: number;
	finalDriveRatio: number;
	transmissionEfficiency: number;
	automatic: boolean;
	downshiftRpm: number;
	upshiftRpm: number;
	shiftDuration: number;
	clutchEngagementRate: number;
	differentialType: VehicleDifferentialType;
	limitedSlipBias: number;
	differentialLockStrength: number;
}

/** Previous-step wheel evidence used to couple engine and differential state without a second raycast. */
export interface IVehicleDrivetrainWheelSample {
	id: string;
	rpm: number;
	driven: boolean;
	grounded: boolean;
	forwardSlip: number;
}

/** Driver commands consumed by one fixed step; requestedGear is meaningful only in manual mode. */
export interface IVehicleDrivetrainInput {
	throttle: number;
	shiftUp: boolean;
	shiftDown: boolean;
	requestedGear?: number;
}

/** Per-wheel N·m output split into engine share and differential coupling evidence. */
export interface IVehicleDrivetrainWheelTorque {
	driveTorque: number;
	differentialTorque: number;
	totalTorque: number;
	torqueShare: number;
}

/** Transient vehicle-level state returned to diagnostics but never written into scene metadata. */
export interface IVehicleDrivetrainState {
	engineRpm: number;
	currentGear: number;
	pendingGear: number | null;
	shiftTimeRemaining: number;
	clutch: number;
	engineTorque: number;
	gearRatio: number;
	outputTorque: number;
	shiftUpHeld: boolean;
	shiftDownHeld: boolean;
	wheelTorques: Record<string, IVehicleDrivetrainWheelTorque>;
}

/** Closed authoring surface used to reject accidental metadata that no runtime would execute. */
const drivetrainKeys = new Set([
	"engineTorqueCurve",
	"idleRpm",
	"redlineRpm",
	"engineInertia",
	"engineBrakingTorque",
	"forwardGearRatios",
	"reverseGearRatio",
	"finalDriveRatio",
	"transmissionEfficiency",
	"automatic",
	"downshiftRpm",
	"upshiftRpm",
	"shiftDuration",
	"clutchEngagementRate",
	"differentialType",
	"limitedSlipBias",
	"differentialLockStrength",
]);

/** Central numeric guard keeps validation errors consistent across every nested drivetrain field. */
function finite(value: unknown, minimum: number, maximum: number, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

/** Advances a scalar without overshooting, including deterministic zero-duration boundaries. */
function moveTowards(value: number, target: number, maximumDelta: number): number {
	return Math.abs(target - value) <= maximumDelta ? target : value + Math.sign(target - value) * maximumDelta;
}

/** Resolves signed reverse/neutral/forward ratios while leaving final drive separate. */
function gearRatio(configuration: IVehicleDrivetrainConfiguration, gear: number): number {
	if (gear === -1) {
		return -configuration.reverseGearRatio;
	}
	return gear > 0 ? (configuration.forwardGearRatios[gear - 1] ?? 0) : 0;
}

/** Sanitizes transient or script-provided gears into the authored transmission range. */
function clampGear(configuration: IVehicleDrivetrainConfiguration, gear: number): number {
	return Number.isFinite(gear) ? Math.max(-1, Math.min(configuration.forwardGearRatios.length, Math.trunc(gear))) : 0;
}

/** Creates a road-car baseline whose torque units are N·m and whose ratios are dimensionless. */
export function createDefaultVehicleDrivetrain(): IVehicleDrivetrainConfiguration {
	return {
		engineTorqueCurve: [
			{ rpm: 800, torque: 280 },
			{ rpm: 3500, torque: 420 },
			{ rpm: 6500, torque: 300 },
		],
		idleRpm: 800,
		redlineRpm: 6500,
		engineInertia: 0.3,
		engineBrakingTorque: 60,
		forwardGearRatios: [3.5, 2.2, 1.5, 1.15, 0.9, 0.75],
		reverseGearRatio: 3.2,
		finalDriveRatio: 3.42,
		transmissionEfficiency: 0.9,
		automatic: true,
		downshiftRpm: 1800,
		upshiftRpm: 6000,
		shiftDuration: 0.2,
		clutchEngagementRate: 8,
		differentialType: "limited-slip",
		limitedSlipBias: 2,
		differentialLockStrength: 2,
	};
}

/** Rejects partial, unbounded, or internally inconsistent drivetrain authoring before publication. */
export function validateVehicleDrivetrain(value: unknown, name = "drivetrain"): asserts value is IVehicleDrivetrainConfiguration {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be a drivetrain object.`);
	}
	const configuration = value as Record<string, unknown>;
	const unknown = Object.keys(configuration).filter((key) => !drivetrainKeys.has(key));
	if (unknown.length) {
		throw new Error(`${name} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
	const idleRpm = finite(configuration.idleRpm, 100, 5000, `${name}.idleRpm`);
	const redlineRpm = finite(configuration.redlineRpm, idleRpm + 100, 30000, `${name}.redlineRpm`);
	finite(configuration.engineInertia, 0.01, 100, `${name}.engineInertia`);
	finite(configuration.engineBrakingTorque, 0, 5000, `${name}.engineBrakingTorque`);
	finite(configuration.reverseGearRatio, 0.1, 20, `${name}.reverseGearRatio`);
	finite(configuration.finalDriveRatio, 0.1, 20, `${name}.finalDriveRatio`);
	finite(configuration.transmissionEfficiency, 0, 1, `${name}.transmissionEfficiency`);
	if (typeof configuration.automatic !== "boolean") {
		throw new Error(`${name}.automatic must be a boolean.`);
	}
	const downshiftRpm = finite(configuration.downshiftRpm, idleRpm, redlineRpm, `${name}.downshiftRpm`);
	finite(configuration.upshiftRpm, downshiftRpm + 100, redlineRpm, `${name}.upshiftRpm`);
	finite(configuration.shiftDuration, 0, 5, `${name}.shiftDuration`);
	finite(configuration.clutchEngagementRate, 0.1, 100, `${name}.clutchEngagementRate`);
	if (!(["open", "limited-slip", "locked"] as unknown[]).includes(configuration.differentialType)) {
		throw new Error(`${name}.differentialType must be open, limited-slip, or locked.`);
	}
	finite(configuration.limitedSlipBias, 1, 10, `${name}.limitedSlipBias`);
	finite(configuration.differentialLockStrength, 0, 1000, `${name}.differentialLockStrength`);

	if (!Array.isArray(configuration.engineTorqueCurve) || configuration.engineTorqueCurve.length < 2 || configuration.engineTorqueCurve.length > 16) {
		throw new Error(`${name}.engineTorqueCurve must contain from 2 through 16 keys.`);
	}
	let previousRpm = -1;
	for (const [index, rawKey] of configuration.engineTorqueCurve.entries()) {
		if (!rawKey || typeof rawKey !== "object" || Array.isArray(rawKey)) {
			throw new Error(`${name}.engineTorqueCurve[${index}] must be an object.`);
		}
		const key = rawKey as Record<string, unknown>;
		const unknownKeyFields = Object.keys(key).filter((field) => field !== "rpm" && field !== "torque");
		if (unknownKeyFields.length) {
			throw new Error(`${name}.engineTorqueCurve[${index}] contains unsupported field${unknownKeyFields.length === 1 ? "" : "s"}: ${unknownKeyFields.join(", ")}.`);
		}
		const rpm = finite(key.rpm, 0, 30000, `${name}.engineTorqueCurve[${index}].rpm`);
		finite(key.torque, 0, 5000, `${name}.engineTorqueCurve[${index}].torque`);
		if (rpm <= previousRpm) {
			throw new Error(`${name}.engineTorqueCurve RPM keys must be strictly increasing.`);
		}
		previousRpm = rpm;
	}
	const curve = configuration.engineTorqueCurve as IVehicleEngineTorqueKey[];
	if (curve[0].rpm > idleRpm || curve[curve.length - 1].rpm < redlineRpm) {
		throw new Error(`${name}.engineTorqueCurve must span idleRpm through redlineRpm.`);
	}

	if (!Array.isArray(configuration.forwardGearRatios) || configuration.forwardGearRatios.length < 1 || configuration.forwardGearRatios.length > 12) {
		throw new Error(`${name}.forwardGearRatios must contain from 1 through 12 ratios.`);
	}
	let previousRatio = Number.POSITIVE_INFINITY;
	for (const [index, rawRatio] of configuration.forwardGearRatios.entries()) {
		const ratio = finite(rawRatio, 0.1, 20, `${name}.forwardGearRatios[${index}]`);
		if (ratio >= previousRatio) {
			throw new Error(`${name}.forwardGearRatios must be strictly decreasing.`);
		}
		previousRatio = ratio;
	}
}

/** Returns null for corrupt legacy metadata so exported fixed steps fail closed instead of throwing. */
export function getRuntimeVehicleDrivetrain(value: unknown): IVehicleDrivetrainConfiguration | null {
	try {
		validateVehicleDrivetrain(value);
		return value;
	} catch {
		return null;
	}
}

/** Linearly samples the authored engine torque curve and clamps outside its key range. */
export function evaluateVehicleEngineTorque(configuration: IVehicleDrivetrainConfiguration, rpm: number): number {
	const curve = configuration.engineTorqueCurve;
	if (rpm <= curve[0].rpm) {
		return curve[0].torque;
	}
	for (let index = 1; index < curve.length; index++) {
		const next = curve[index];
		if (rpm <= next.rpm) {
			const previous = curve[index - 1];
			const ratio = (rpm - previous.rpm) / (next.rpm - previous.rpm);
			return previous.torque + (next.torque - previous.torque) * ratio;
		}
	}
	return curve[curve.length - 1].torque;
}

/** Starts transient simulation in first gear; no runtime state is serialized into the scene. */
export function createInitialVehicleDrivetrainState(configuration: IVehicleDrivetrainConfiguration): IVehicleDrivetrainState {
	return {
		engineRpm: configuration.idleRpm,
		currentGear: 1,
		pendingGear: null,
		shiftTimeRemaining: 0,
		clutch: 1,
		engineTorque: evaluateVehicleEngineTorque(configuration, configuration.idleRpm),
		gearRatio: configuration.forwardGearRatios[0],
		outputTorque: 0,
		shiftUpHeld: false,
		shiftDownHeld: false,
		wheelTorques: {},
	};
}

/** Starts or immediately completes one shift without allowing another request to replace it. */
function requestShift(
	configuration: IVehicleDrivetrainConfiguration,
	state: Pick<IVehicleDrivetrainState, "currentGear" | "pendingGear" | "shiftTimeRemaining" | "clutch">,
	target: number
): void {
	const gear = clampGear(configuration, target);
	if (gear === state.currentGear || state.pendingGear !== null) {
		return;
	}
	if (configuration.shiftDuration === 0) {
		state.currentGear = gear;
		state.clutch = 0;
		return;
	}
	state.pendingGear = gear;
	state.shiftTimeRemaining = configuration.shiftDuration;
	state.clutch = 0;
}

/** Conserves engine torque while applying bounded traction bias or zero-sum locked coupling. */
function distributeWheelTorque(
	configuration: IVehicleDrivetrainConfiguration,
	totalTorque: number,
	wheels: IVehicleDrivetrainWheelSample[]
): Record<string, IVehicleDrivetrainWheelTorque> {
	const driven = wheels.filter((wheel) => wheel.driven);
	if (!driven.length) {
		return {};
	}
	let shares = driven.map(() => 1 / driven.length);
	if (configuration.differentialType === "limited-slip") {
		const scores = driven.map((wheel) => (wheel.grounded ? 1 / (1 + Math.abs(Number.isFinite(wheel.forwardSlip) ? wheel.forwardSlip : 0)) : 1 / configuration.limitedSlipBias));
		const maximum = Math.max(...scores, Number.EPSILON);
		const minimumScale = 1 / configuration.limitedSlipBias;
		const bounded = scores.map((score) => Math.max(minimumScale, score / maximum));
		const sum = bounded.reduce((total, score) => total + score, 0);
		shares = bounded.map((score) => score / sum);
	}

	const differentialTorques = driven.map(() => 0);
	if (configuration.differentialType === "locked" && configuration.differentialLockStrength > 0) {
		const rpm = driven.map((wheel) => (Number.isFinite(wheel.rpm) ? wheel.rpm : 0));
		const averageRpm = rpm.reduce((total, value) => total + value, 0) / driven.length;
		const raw = rpm.map((value) => (averageRpm - value) * configuration.differentialLockStrength);
		const maximum = Math.max(0, ...raw.map(Math.abs));
		const scale = maximum > 10000 ? 10000 / maximum : 1;
		for (let index = 0; index < raw.length; index++) {
			differentialTorques[index] = raw[index] * scale;
		}
	}

	return Object.fromEntries(
		driven.map((wheel, index) => {
			const driveTorque = totalTorque * shares[index];
			const differentialTorque = differentialTorques[index];
			return [wheel.id, { driveTorque, differentialTorque, totalTorque: driveTorque + differentialTorque, torqueShare: shares[index] }];
		})
	);
}

/** Advances one bounded drivetrain step using previous wheel evidence, then returns per-wheel axle torque for the tire solver. */
export function stepVehicleDrivetrain(
	configuration: IVehicleDrivetrainConfiguration,
	previous: IVehicleDrivetrainState | undefined,
	input: IVehicleDrivetrainInput,
	wheels: IVehicleDrivetrainWheelSample[],
	deltaSeconds: number
): IVehicleDrivetrainState {
	const source = previous ?? createInitialVehicleDrivetrainState(configuration);
	const state = {
		currentGear: clampGear(configuration, Number.isFinite(source.currentGear) ? source.currentGear : 1),
		pendingGear: source.pendingGear === null || source.pendingGear === undefined ? null : clampGear(configuration, source.pendingGear),
		shiftTimeRemaining: Math.max(0, Number.isFinite(source.shiftTimeRemaining) ? source.shiftTimeRemaining : 0),
		clutch: Math.max(0, Math.min(1, Number.isFinite(source.clutch) ? source.clutch : 1)),
	};
	const step = Math.max(0, Math.min(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0.1));
	const throttle = Math.max(-1, Math.min(1, Number.isFinite(input.throttle) ? input.throttle : 0));
	let completedShift = false;

	if (state.shiftTimeRemaining > 0) {
		state.shiftTimeRemaining = Math.max(0, state.shiftTimeRemaining - step);
		if (state.shiftTimeRemaining < 1e-9) {
			state.shiftTimeRemaining = 0;
		}
		if (state.shiftTimeRemaining === 0 && state.pendingGear !== null) {
			state.currentGear = state.pendingGear;
			state.pendingGear = null;
			completedShift = true;
		}
	}

	// Never chain two shifts in one fixed step; the new ratio must produce a wheel-coupled RPM sample first.
	if (!completedShift && state.shiftTimeRemaining === 0 && state.pendingGear === null) {
		if (configuration.automatic) {
			if (throttle < -0.05 && state.currentGear !== -1) {
				requestShift(configuration, state, -1);
			} else if (throttle > 0.05 && state.currentGear < 1) {
				requestShift(configuration, state, 1);
			} else if (state.currentGear > 0 && source.engineRpm >= configuration.upshiftRpm && state.currentGear < configuration.forwardGearRatios.length) {
				requestShift(configuration, state, state.currentGear + 1);
			} else if (state.currentGear > 1 && source.engineRpm <= configuration.downshiftRpm) {
				requestShift(configuration, state, state.currentGear - 1);
			}
		} else if (input.requestedGear !== undefined && Number.isFinite(input.requestedGear)) {
			requestShift(configuration, state, input.requestedGear);
		} else if (input.shiftUp && !source.shiftUpHeld) {
			requestShift(configuration, state, state.currentGear + 1);
		} else if (input.shiftDown && !source.shiftDownHeld) {
			requestShift(configuration, state, state.currentGear - 1);
		}
	}

	const ratio = gearRatio(configuration, state.currentGear);
	if (state.shiftTimeRemaining > 0 || !ratio) {
		state.clutch = moveTowards(state.clutch, 0, configuration.clutchEngagementRate * step);
	} else {
		state.clutch = moveTowards(state.clutch, 1, configuration.clutchEngagementRate * step);
	}
	const driven = wheels.filter((wheel) => wheel.driven);
	const averageWheelRpm = driven.length ? driven.reduce((total, wheel) => total + (Number.isFinite(wheel.rpm) ? wheel.rpm : 0), 0) / driven.length : 0;
	const sourceRpm = Number.isFinite(source.engineRpm) ? source.engineRpm : configuration.idleRpm;
	const gearThrottle = state.currentGear === -1 ? Math.max(0, -throttle) : state.currentGear > 0 ? Math.max(0, throttle) : 0;
	const freeTorque = evaluateVehicleEngineTorque(configuration, sourceRpm) * gearThrottle - configuration.engineBrakingTorque * (1 - gearThrottle);
	const freeRpm = Math.max(configuration.idleRpm, Math.min(configuration.redlineRpm, sourceRpm + (freeTorque / configuration.engineInertia) * (60 / (Math.PI * 2)) * step));
	const coupledRpm = Math.max(configuration.idleRpm, Math.min(configuration.redlineRpm, Math.abs(averageWheelRpm * ratio * configuration.finalDriveRatio)));
	const engineRpm = freeRpm + (coupledRpm - freeRpm) * state.clutch;
	const engineTorque = evaluateVehicleEngineTorque(configuration, engineRpm);
	let outputTorque = 0;
	if (state.shiftTimeRemaining === 0 && ratio) {
		const atLimiter = engineRpm >= configuration.redlineRpm - 1 && coupledRpm >= configuration.redlineRpm - 1;
		if (gearThrottle > 0 && !atLimiter) {
			outputTorque = engineTorque * gearThrottle * ratio * configuration.finalDriveRatio * configuration.transmissionEfficiency * state.clutch;
		} else if (gearThrottle === 0 && Math.abs(averageWheelRpm) > 0.01) {
			outputTorque =
				-Math.sign(averageWheelRpm) *
				configuration.engineBrakingTorque *
				Math.abs(ratio) *
				configuration.finalDriveRatio *
				configuration.transmissionEfficiency *
				state.clutch;
		}
	}

	return {
		engineRpm,
		currentGear: state.currentGear,
		pendingGear: state.pendingGear,
		shiftTimeRemaining: state.shiftTimeRemaining,
		clutch: state.clutch,
		engineTorque,
		gearRatio: ratio,
		outputTorque,
		shiftUpHeld: !!input.shiftUp,
		shiftDownHeld: !!input.shiftDown,
		wheelTorques: distributeWheelTorque(configuration, outputTorque, wheels),
	};
}

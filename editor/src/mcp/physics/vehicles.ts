import { Matrix, PhysicsMotionType, Scene, Tools, Vector3 } from "babylonjs";
import {
	createDefaultVehicleDrivetrain,
	getRuntimeVehicleDrivetrain,
	IVehicleDrivetrainConfiguration,
	IVehicleDrivetrainState,
	stepVehicleDrivetrain,
	validateVehicleDrivetrain,
} from "babylonjs-editor-tools";

import { isAbstractMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

const observers = new WeakMap<Scene, any>();

/** One normalized preview control sample, including edge-triggered manual transmission commands. */
interface IVehicleInput {
	throttle: number;
	steering: number;
	brake: number;
	shiftUp: boolean;
	shiftDown: boolean;
	gear?: number;
}

const manualInputs = new WeakMap<Scene, Map<string, IVehicleInput>>();
const drivetrainStates = new WeakMap<Scene, Map<string, IVehicleDrivetrainState>>();

/** Transient current-step evidence returned to the Inspector and MCP without entering scene metadata. */
interface IVehicleWheelRuntimeState {
	grounded: boolean;
	compression: number;
	contactPoint: number[] | null;
	antiRollForce: number;
	forwardSlip: number;
	sidewaysSlip: number;
	longitudinalSpeed: number;
	sidewaysSpeed: number;
	surfaceSpeed: number;
	forwardGrip: number;
	sidewaysGrip: number;
	forwardForce: number;
	sidewaysForce: number;
	angularSpeed: number;
	rpm: number;
	driveTorque: number;
	differentialTorque: number;
	brakeTorque: number;
	totalTorque: number;
	torqueShare: number;
}

interface IVehicleFrictionCurve {
	extremumSlip: number;
	extremumValue: number;
	asymptoteSlip: number;
	asymptoteValue: number;
	stiffness: number;
}

/** Current raycast result retained until paired anti-roll forces can be solved order-independently. */
interface IVehicleWheelFrame {
	id: string;
	antiRollGroup: string | null;
	mount: Vector3;
	grounded: boolean;
	compression: number;
}

/** Shared immutable inputs for one vehicle fixed-step, grouped to keep the hot-path signature bounded. */
interface IVehicleStepContext {
	forward: Vector3;
	right: Vector3;
	input: IVehicleInput;
	deltaSeconds: number;
}

const wheelStates = new WeakMap<Scene, Map<string, Map<string, IVehicleWheelRuntimeState>>>();

/** Unity-compatible default WheelFrictionCurve control points, interpreted as a normal-load multiplier. */
export function createDefaultVehicleFrictionCurve(): IVehicleFrictionCurve {
	return { extremumSlip: 0.4, extremumValue: 1, asymptoteSlip: 0.8, asymptoteValue: 0.5, stiffness: 1 };
}

function vehicles(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorVehicles ??= []);
}

function clamp(value: unknown, minimum: number, maximum: number, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

/** Validates the complete two-segment tire curve before it is persisted. */
function validateFrictionCurve(value: unknown, name: string): asserts value is IVehicleFrictionCurve {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be a friction curve object.`);
	}
	const curve = value as Record<string, unknown>;
	clamp(curve.extremumSlip, 0.001, 10, `${name}.extremumSlip`);
	clamp(curve.extremumValue, 0, 10, `${name}.extremumValue`);
	clamp(curve.asymptoteSlip, 0.001, 20, `${name}.asymptoteSlip`);
	clamp(curve.asymptoteValue, 0, 10, `${name}.asymptoteValue`);
	clamp(curve.stiffness, 0, 10, `${name}.stiffness`);
	if ((curve.asymptoteSlip as number) - (curve.extremumSlip as number) < 0.001) {
		throw new Error(`${name}.asymptoteSlip must be at least 0.001 greater than ${name}.extremumSlip.`);
	}
}

/** Rejects corrupt legacy curve data without making the fixed-step fail. */
function getRuntimeFrictionCurve(value: unknown): IVehicleFrictionCurve | null {
	try {
		validateFrictionCurve(value, "frictionCurve");
		return value;
	} catch {
		return null;
	}
}

/** Evaluates the two-piece curve with finite origin slope and zero tangents at the extremum/asymptote. */
function evaluateFrictionCurve(curve: IVehicleFrictionCurve, slip: number): number {
	const magnitude = Math.abs(slip);
	if (magnitude >= curve.asymptoteSlip) {
		return curve.asymptoteValue * curve.stiffness;
	}
	if (magnitude <= curve.extremumSlip) {
		const ratio = magnitude / curve.extremumSlip;
		return curve.extremumValue * ratio * (2 - ratio) * curve.stiffness;
	}
	const ratio = (magnitude - curve.extremumSlip) / (curve.asymptoteSlip - curve.extremumSlip);
	const smooth = ratio * ratio * (3 - 2 * ratio);
	return (curve.extremumValue + (curve.asymptoteValue - curve.extremumValue) * smooth) * curve.stiffness;
}

function moveTowards(value: number, target: number, maximumDelta: number): number {
	return Math.abs(target - value) <= maximumDelta ? target : value + Math.sign(target - value) * maximumDelta;
}

/** Combines the authored vehicle-speed ceiling with the active gear's engine-redline ceiling. */
function getMaximumWheelAngularSpeed(vehicle: any, wheel: any, drivetrain: IVehicleDrivetrainConfiguration | null, state: IVehicleDrivetrainState | null): number {
	const redlineLimit =
		drivetrain && state?.gearRatio ? (drivetrain.redlineRpm * 2 * Math.PI) / 60 / Math.abs(state.gearRatio * drivetrain.finalDriveRatio) : Number.POSITIVE_INFINITY;
	return Math.min((vehicle.maxSpeed ?? 2500) / wheel.radius, redlineLimit);
}

/** Reconstructs velocity at a wheel contact because PhysicsBody exposes only COM linear/angular velocity. */
function getPointVelocity(chassis: any, body: any, point: Vector3): Vector3 {
	const linearValue = body.getLinearVelocity?.();
	const angularValue = body.getAngularVelocity?.();
	const linear = linearValue instanceof Vector3 ? linearValue : new Vector3(linearValue?.x ?? 0, linearValue?.y ?? 0, linearValue?.z ?? 0);
	const angular = angularValue instanceof Vector3 ? angularValue : new Vector3(angularValue?.x ?? 0, angularValue?.y ?? 0, angularValue?.z ?? 0);
	const centerOfMass = body.getMassProperties?.().centerOfMass;
	const center = centerOfMass ? Vector3.TransformCoordinates(centerOfMass, chassis.getWorldMatrix()) : chassis.getAbsolutePosition();
	return linear.add(Vector3.Cross(angular, point.subtract(center)));
}

function getVehicle(scene: Scene, id: string): any {
	const vehicle = vehicles(scene).find((candidate) => candidate.id === id);
	if (!vehicle) {
		throw new Error(`Vehicle "${id}" was not found.`);
	}
	return vehicle;
}

/** Reads one control sample and consumes MCP/manual shift pulses without persisting them. */
function getInput(scene: Scene, vehicle: any): IVehicleInput {
	const manual = manualInputs.get(scene)?.get(vehicle.id);
	if (manual) {
		const sample = { ...manual };
		manual.shiftUp = false;
		manual.shiftDown = false;
		delete manual.gear;
		return sample;
	}
	const input = (scene as any).inputActions;
	if (!input || !vehicle.actionMapName) {
		return { throttle: 0, steering: 0, brake: 0, shiftUp: false, shiftDown: false };
	}
	const value = (name: string | undefined): number => (name ? input.getValue(vehicle.actionMapName, name) : 0);
	return {
		throttle: Math.max(-1, Math.min(1, value(vehicle.accelerateActionName) - value(vehicle.reverseActionName))),
		steering: Math.max(-1, Math.min(1, value(vehicle.rightActionName) - value(vehicle.leftActionName))),
		brake: Math.max(0, Math.min(1, value(vehicle.brakeActionName))),
		shiftUp: value(vehicle.shiftUpActionName) > 0.5,
		shiftDown: value(vehicle.shiftDownActionName) > 0.5,
	};
}

/** Creates a four-wheel layout with explicit front and rear anti-roll axle pairs. */
export function createDefaultVehicleWheels(): any[] {
	return [
		{
			id: "front-left",
			name: "Front Left",
			connectionPoint: [-60, -40, 90],
			radius: 35,
			mass: 20,
			dampingRate: 0.25,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: true,
			driven: true,
			brake: true,
			antiRollGroup: "front",
		},
		{
			id: "front-right",
			name: "Front Right",
			connectionPoint: [60, -40, 90],
			radius: 35,
			mass: 20,
			dampingRate: 0.25,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: true,
			driven: true,
			brake: true,
			antiRollGroup: "front",
		},
		{
			id: "rear-left",
			name: "Rear Left",
			connectionPoint: [-60, -40, -90],
			radius: 35,
			mass: 20,
			dampingRate: 0.25,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: false,
			driven: true,
			brake: true,
			antiRollGroup: "rear",
		},
		{
			id: "rear-right",
			name: "Rear Right",
			connectionPoint: [60, -40, -90],
			radius: 35,
			mass: 20,
			dampingRate: 0.25,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: false,
			driven: true,
			brake: true,
			antiRollGroup: "rear",
		},
	];
}

/** Validates the complete wheel replacement, including exact two-wheel anti-roll groups. */
function validateWheels(value: unknown): asserts value is any[] {
	if (!Array.isArray(value) || value.length < 2 || value.length > 16) {
		throw new Error("Vehicle wheels must contain from 2 through 16 entries.");
	}
	const ids = new Set<string>();
	const antiRollGroups = new Map<string, number>();
	for (const wheel of value) {
		if (!wheel?.id?.trim() || ids.has(wheel.id)) {
			throw new Error("Every vehicle wheel requires a unique non-empty id.");
		}
		ids.add(wheel.id);
		if (wheel.antiRollGroup !== undefined && wheel.antiRollGroup !== null) {
			if (typeof wheel.antiRollGroup !== "string" || !wheel.antiRollGroup.trim() || wheel.antiRollGroup.length > 64 || wheel.antiRollGroup !== wheel.antiRollGroup.trim()) {
				throw new Error(`Vehicle wheel "${wheel.id}" antiRollGroup must be a trimmed non-empty string of at most 64 characters or null.`);
			}
			antiRollGroups.set(wheel.antiRollGroup, (antiRollGroups.get(wheel.antiRollGroup) ?? 0) + 1);
		}
		if (!Array.isArray(wheel.connectionPoint) || wheel.connectionPoint.length !== 3 || !wheel.connectionPoint.every(Number.isFinite)) {
			throw new Error(`Vehicle wheel "${wheel.id}" requires a finite local connectionPoint [x,y,z].`);
		}
		for (const [name, number, minimum, maximum] of [
			["radius", wheel.radius, 1, 1000],
			["mass", wheel.mass ?? 20, 0.1, 10000],
			["dampingRate", wheel.dampingRate ?? 0.25, 0, 100],
			["suspensionRestLength", wheel.suspensionRestLength, 1, 2000],
			["maxTravel", wheel.maxTravel, 0, 1000],
			["springStrength", wheel.springStrength, 0, 1000000],
			["damping", wheel.damping, 0, 100000],
		] as Array<[string, number, number, number]>) {
			clamp(number, minimum, maximum, `${wheel.id}.${name}`);
		}
		if (wheel.forwardFriction !== undefined) {
			validateFrictionCurve(wheel.forwardFriction, `${wheel.id}.forwardFriction`);
		}
		if (wheel.sidewaysFriction !== undefined) {
			validateFrictionCurve(wheel.sidewaysFriction, `${wheel.id}.sidewaysFriction`);
		}
	}
	for (const [group, count] of antiRollGroups) {
		if (count !== 2) {
			throw new Error(`Vehicle anti-roll group "${group}" must contain exactly two wheels; received ${count}.`);
		}
	}
}

/** Applies one bounded axle-coupling force after every wheel has a current-frame compression sample. */
function applyAntiRollForces(vehicle: any, body: any, up: Vector3, states: Map<string, IVehicleWheelRuntimeState>, frame: IVehicleWheelFrame[]): void {
	const stiffness = Number.isFinite(vehicle.antiRollStiffness) ? vehicle.antiRollStiffness : 0;
	const maximumForce = Number.isFinite(vehicle.maxAntiRollForce) ? vehicle.maxAntiRollForce : 100000;
	if (stiffness <= 0 || maximumForce <= 0) {
		return;
	}

	const groups = new Map<string, IVehicleWheelFrame[]>();
	for (const wheel of frame) {
		if (!wheel.antiRollGroup) {
			continue;
		}
		const group = groups.get(wheel.antiRollGroup) ?? [];
		group.push(wheel);
		groups.set(wheel.antiRollGroup, group);
	}
	for (const wheels of groups.values()) {
		// Persisted authoring validates exact pairs; this guard keeps corrupt legacy metadata non-fatal at runtime.
		if (wheels.length !== 2) {
			continue;
		}
		const [first, second] = wheels;
		const force = Math.max(-maximumForce, Math.min(maximumForce, (first.compression - second.compression) * stiffness));
		if (!force) {
			continue;
		}
		if (first.grounded) {
			body.applyForce?.(up.scale(force), first.mount);
			const state = states.get(first.id);
			if (state) {
				state.antiRollForce = force;
			}
		}
		if (second.grounded) {
			body.applyForce?.(up.scale(-force), second.mount);
			const state = states.get(second.id);
			if (state) {
				state.antiRollForce = -force;
			}
		}
	}
}

/** Raycasts every wheel, applies its local forces, publishes evidence, then resolves paired axle coupling. */
function applyWheelSuspension(scene: Scene, vehicle: any, chassis: any, body: any, context: IVehicleStepContext): boolean {
	if (!Array.isArray(vehicle.wheels) || !vehicle.wheels.length) {
		return false;
	}
	const physics = scene.getPhysicsEngine() as any;
	if (!physics?.raycast) {
		return false;
	}
	let sceneStates = wheelStates.get(scene);
	if (!sceneStates) {
		wheelStates.set(scene, (sceneStates = new Map()));
	}
	let states = sceneStates.get(vehicle.id);
	if (!states) {
		sceneStates.set(vehicle.id, (states = new Map()));
	}
	const drivetrain = getRuntimeVehicleDrivetrain(vehicle.drivetrain);
	let drivetrainState: IVehicleDrivetrainState | null = null;
	if (drivetrain) {
		let sceneDrivetrainStates = drivetrainStates.get(scene);
		if (!sceneDrivetrainStates) {
			drivetrainStates.set(scene, (sceneDrivetrainStates = new Map()));
		}
		drivetrainState = stepVehicleDrivetrain(
			drivetrain,
			sceneDrivetrainStates.get(vehicle.id),
			{ throttle: context.input.throttle, shiftUp: context.input.shiftUp, shiftDown: context.input.shiftDown, requestedGear: context.input.gear },
			vehicle.wheels.map((wheel: any) => {
				const state = states.get(wheel.id);
				return { id: wheel.id, rpm: state?.rpm ?? 0, driven: !!wheel.driven, grounded: state?.grounded ?? false, forwardSlip: state?.forwardSlip ?? 0 };
			}),
			context.deltaSeconds
		);
		sceneDrivetrainStates.set(vehicle.id, drivetrainState);
	}
	const up = chassis.getDirection(Vector3.Up()).normalize();
	const world = chassis.getWorldMatrix();
	const { forward, right, input, deltaSeconds } = context;
	const mass = body.getMassProperties?.().mass ?? 1;
	const drivenCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.driven).length);
	const brakeCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.brake).length);
	const frame: IVehicleWheelFrame[] = [];
	for (const wheel of vehicle.wheels) {
		const wheelTorque = drivetrainState?.wheelTorques[wheel.id];
		const driveTorque = wheelTorque?.driveTorque ?? 0;
		const differentialTorque = wheelTorque?.differentialTorque ?? 0;
		const totalTorque = wheelTorque?.totalTorque ?? 0;
		const torqueShare = wheelTorque?.torqueShare ?? 0;
		const mount = Vector3.TransformCoordinates(Vector3.FromArray(wheel.connectionPoint), world);
		const antiRollGroup = typeof wheel.antiRollGroup === "string" && wheel.antiRollGroup ? wheel.antiRollGroup : null;
		const rayLength = wheel.suspensionRestLength + wheel.maxTravel + wheel.radius;
		const result = physics.raycast(mount, mount.subtract(up.scale(rayLength)), { ignoreBody: body });
		const existing = states.get(wheel.id);
		const previous = existing ?? {
			grounded: false,
			compression: 0,
			contactPoint: null,
			antiRollForce: 0,
			forwardSlip: 0,
			sidewaysSlip: 0,
			longitudinalSpeed: 0,
			sidewaysSpeed: 0,
			surfaceSpeed: 0,
			forwardGrip: 0,
			sidewaysGrip: 0,
			forwardForce: 0,
			sidewaysForce: 0,
			angularSpeed: 0,
			rpm: 0,
			driveTorque: 0,
			differentialTorque: 0,
			brakeTorque: 0,
			totalTorque: 0,
			torqueShare: 0,
		};
		if (!result?.hasHit) {
			let angularSpeed = previous.angularSpeed;
			let brakeTorque = 0;
			// New drivetrains use N·m axle torque; curve-only legacy vehicles retain direct force-to-wheel integration.
			if (getRuntimeFrictionCurve(wheel.forwardFriction ?? vehicle.forwardFriction)) {
				const inertia = Math.max(0.5 * (wheel.mass ?? 20) * wheel.radius * wheel.radius, 0.001);
				if (wheelTorque) {
					angularSpeed += ((totalTorque * 100) / inertia) * deltaSeconds;
				} else if (!drivetrainState) {
					const driveForce = wheel.driven ? ((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount : 0;
					angularSpeed += ((driveForce * wheel.radius) / inertia) * deltaSeconds;
				}
				if (wheel.brake && input.brake > 0) {
					const brakeForce = ((vehicle.maxBrakeForce ?? 35000) / brakeCount) * input.brake;
					brakeTorque = (brakeForce * wheel.radius) / 100;
					const brakeAcceleration = (brakeForce * wheel.radius) / inertia;
					angularSpeed = moveTowards(angularSpeed, 0, brakeAcceleration * deltaSeconds);
				}
				const maximumAngularSpeed = getMaximumWheelAngularSpeed(vehicle, wheel, drivetrain, drivetrainState);
				angularSpeed = Math.max(-maximumAngularSpeed, Math.min(maximumAngularSpeed, angularSpeed));
			}
			angularSpeed *= Math.exp(-(wheel.dampingRate ?? 0.25) * deltaSeconds);
			states.set(wheel.id, {
				grounded: false,
				compression: 0,
				contactPoint: null,
				antiRollForce: 0,
				forwardSlip: 0,
				sidewaysSlip: 0,
				longitudinalSpeed: 0,
				sidewaysSpeed: 0,
				surfaceSpeed: angularSpeed * wheel.radius,
				forwardGrip: 0,
				sidewaysGrip: 0,
				forwardForce: 0,
				sidewaysForce: 0,
				angularSpeed,
				rpm: (angularSpeed * 60) / (Math.PI * 2),
				driveTorque,
				differentialTorque,
				brakeTorque,
				totalTorque,
				torqueShare,
			});
			frame.push({ id: wheel.id, antiRollGroup, mount, grounded: false, compression: 0 });
			continue;
		}
		const suspensionLength = Math.max(0, result.hitDistance - wheel.radius);
		const compression = Math.max(0, Math.min(wheel.suspensionRestLength + wheel.maxTravel, wheel.suspensionRestLength - suspensionLength));
		const compressionVelocity = (compression - previous.compression) / Math.max(deltaSeconds, 1 / 120);
		const suspensionForce = Math.max(0, wheel.springStrength * compression + wheel.damping * compressionVelocity);
		const hitPoint = result.hitPointWorld ?? result.hitPoint;
		const contact = hitPoint instanceof Vector3 ? hitPoint : new Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
		if (suspensionForce) {
			body.applyForce?.(up.scale(suspensionForce), mount);
		}
		const steerAngle = wheel.steering ? input.steering * (vehicle.maxSteerAngle ?? 0.55) : 0;
		const wheelForward = steerAngle ? Vector3.TransformNormal(forward, Matrix.RotationAxis(up, steerAngle)).normalize() : forward;
		const wheelRight = Vector3.Cross(up, wheelForward).normalize();
		const forwardCurve = getRuntimeFrictionCurve(wheel.forwardFriction ?? vehicle.forwardFriction);
		const sidewaysCurve = getRuntimeFrictionCurve(wheel.sidewaysFriction ?? vehicle.sidewaysFriction);
		const velocity = forwardCurve || sidewaysCurve ? getPointVelocity(chassis, body, contact) : (body.getLinearVelocity?.() ?? Vector3.Zero());
		const longitudinalSpeed = Vector3.Dot(velocity, wheelForward);
		const lateralSpeed = Vector3.Dot(velocity, wheelRight);
		let forwardSlip = 0;
		let sidewaysSlip = 0;
		let forwardGrip = 0;
		let sidewaysGrip = 0;
		let forwardForce = 0;
		let sidewaysForce = 0;
		let brakeTorque = 0;
		let angularSpeed = existing ? previous.angularSpeed : longitudinalSpeed / wheel.radius;
		let surfaceSpeed = angularSpeed * wheel.radius;
		if (forwardCurve) {
			const wheelMass = wheel.mass ?? 20;
			const inertia = Math.max(0.5 * wheelMass * wheel.radius * wheel.radius, 0.001);
			if (wheelTorque) {
				angularSpeed += ((totalTorque * 100) / inertia) * deltaSeconds;
			} else if (!drivetrainState) {
				const canAccelerate = Math.abs(longitudinalSpeed) < (vehicle.maxSpeed ?? 2500) || Math.sign(input.throttle) !== Math.sign(longitudinalSpeed);
				const driveForce = wheel.driven && canAccelerate ? ((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount : 0;
				angularSpeed += ((driveForce * wheel.radius) / inertia) * deltaSeconds;
			}
			if (wheel.brake && input.brake > 0) {
				const brakeForce = ((vehicle.maxBrakeForce ?? 35000) / brakeCount) * input.brake;
				brakeTorque = (brakeForce * wheel.radius) / 100;
				const brakeAcceleration = (brakeForce * wheel.radius) / inertia;
				angularSpeed = moveTowards(angularSpeed, 0, brakeAcceleration * deltaSeconds);
			}
			angularSpeed *= Math.exp(-(wheel.dampingRate ?? 0.25) * deltaSeconds);
			surfaceSpeed = angularSpeed * wheel.radius;
			const slipScale = Math.max(Math.abs(longitudinalSpeed), 100);
			forwardSlip = (longitudinalSpeed - surfaceSpeed) / slipScale;
			forwardGrip = evaluateFrictionCurve(forwardCurve, forwardSlip);
			const normalLoad = Math.max(suspensionForce, (mass * Math.max(scene.gravity?.length() ?? 981, 1)) / vehicle.wheels.length);
			const capacity = normalLoad * forwardGrip;
			const desiredForce = (-(longitudinalSpeed - surfaceSpeed) * mass) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length;
			forwardForce = Math.max(-capacity, Math.min(capacity, desiredForce));
			if (Math.abs(forwardForce) > 0.001) {
				body.applyForce?.(wheelForward.scale(forwardForce), contact);
				angularSpeed -= ((forwardForce * wheel.radius) / inertia) * deltaSeconds;
			}
			const maximumAngularSpeed = getMaximumWheelAngularSpeed(vehicle, wheel, drivetrain, drivetrainState);
			angularSpeed = Math.max(-maximumAngularSpeed, Math.min(maximumAngularSpeed, angularSpeed));
		} else {
			// Vehicles authored before #692 retain the exact scalar drive/brake path until a forward curve is opted in.
			if (wheel.driven && input.throttle) {
				forwardForce = ((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount;
				body.applyForce?.(wheelForward.scale(forwardForce), contact);
			}
			if (wheel.brake && input.brake > 0 && velocity.lengthSquared() > 0.001) {
				forwardForce = (-(vehicle.maxBrakeForce ?? 35000) * input.brake) / brakeCount;
				body.applyForce?.(velocity.normalize().scale(-Math.abs(forwardForce)), contact);
			}
		}
		if (sidewaysCurve) {
			const slipScale = Math.max(Math.abs(longitudinalSpeed), 100);
			sidewaysSlip = lateralSpeed / slipScale;
			sidewaysGrip = evaluateFrictionCurve(sidewaysCurve, sidewaysSlip);
			const normalLoad = Math.max(suspensionForce, (mass * Math.max(scene.gravity?.length() ?? 981, 1)) / vehicle.wheels.length);
			const capacity = normalLoad * sidewaysGrip;
			const desiredForce = (-lateralSpeed * mass) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length;
			sidewaysForce = Math.max(-capacity, Math.min(capacity, desiredForce));
			if (Math.abs(sidewaysForce) > 0.001) {
				body.applyForce?.(wheelRight.scale(sidewaysForce), contact);
			}
		} else if (Math.abs(lateralSpeed) > 0.001) {
			sidewaysForce = (-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length;
			body.applyForce?.(right.scale(sidewaysForce), contact);
		}
		states.set(wheel.id, {
			grounded: true,
			compression,
			contactPoint: contact.asArray(),
			antiRollForce: 0,
			forwardSlip,
			sidewaysSlip,
			longitudinalSpeed,
			sidewaysSpeed: lateralSpeed,
			surfaceSpeed,
			forwardGrip,
			sidewaysGrip,
			forwardForce,
			sidewaysForce,
			angularSpeed,
			rpm: (angularSpeed * 60) / (Math.PI * 2),
			driveTorque,
			differentialTorque,
			brakeTorque,
			totalTorque,
			torqueShare,
		});
		frame.push({ id: wheel.id, antiRollGroup, mount, grounded: true, compression });
	}
	applyAntiRollForces(vehicle, body, up, states, frame);
	return true;
}

function applyVehicle(scene: Scene, vehicle: any, deltaSeconds: number): void {
	if (!vehicle.enabled) {
		return;
	}
	const chassis = scene.getNodeById(vehicle.chassisNodeId);
	if (!isAbstractMesh(chassis) || !chassis.physicsAggregate) {
		return;
	}
	const body = chassis.physicsAggregate.body as any;
	if (body.getMotionType?.() !== PhysicsMotionType.DYNAMIC) {
		return;
	}
	const input = getInput(scene, vehicle);
	const velocity = body.getLinearVelocity?.();
	if (!velocity) {
		return;
	}
	chassis.computeWorldMatrix(true);
	const forward = chassis.getDirection(Vector3.Forward()).normalize();
	const right = chassis.getDirection(Vector3.Right()).normalize();
	const forwardSpeed = Vector3.Dot(velocity, forward);
	const lateralSpeed = Vector3.Dot(velocity, right);
	const maxSpeed = vehicle.maxSpeed ?? 2500;
	const steering = input.steering * (vehicle.maxSteerAngle ?? 0.55);
	const steeredForward = new Vector3(
		forward.x * Math.cos(steering) + right.x * Math.sin(steering),
		forward.y,
		forward.z * Math.cos(steering) + right.z * Math.sin(steering)
	).normalize();
	const canAccelerate = Math.abs(forwardSpeed) < maxSpeed || Math.sign(input.throttle) !== Math.sign(forwardSpeed);
	const engineForce = canAccelerate ? (vehicle.maxEngineForce ?? 25000) * input.throttle : 0;
	const mass = body.getMassProperties?.().mass ?? 1;
	const position = chassis.getAbsolutePosition();
	if (applyWheelSuspension(scene, vehicle, chassis, body, { forward, right, input, deltaSeconds })) {
		return;
	}
	const frontContact = position.add(forward.scale(vehicle.wheelBase ?? 180));
	if (engineForce) {
		body.applyForce?.(steeredForward.scale(engineForce), frontContact);
	}
	if (Math.abs(lateralSpeed) > 0.001) {
		body.applyForce?.(right.scale((-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120)), position);
	}
	if (input.brake > 0 && velocity.lengthSquared() > 0.001) {
		body.applyForce?.(velocity.normalize().scale(-(vehicle.maxBrakeForce ?? 35000) * input.brake), position);
	}
}

function ensureVehicleController(scene: Scene): void {
	if (observers.has(scene)) {
		return;
	}
	const updateObservable = scene.onBeforePhysicsObservable ?? scene.onBeforeRenderObservable;
	observers.set(
		scene,
		updateObservable.add(() => {
			const deltaSeconds = Math.min(Math.max((scene.getPhysicsEngine() as any)?.getTimeStep?.() ?? scene.getEngine().getDeltaTime() / 1000, 0), 1 / 30);
			if (!deltaSeconds) {
				return;
			}
			for (const vehicle of vehicles(scene)) {
				applyVehicle(scene, vehicle, deltaSeconds);
			}
		})
	);
}

/** Validates a detached complete vehicle configuration before any persisted state is replaced. */
function validateConfiguration(scene: Scene, config: any): void {
	const chassis = resolveNode({ scene, nodeId: config.chassisNodeId });
	if (!isAbstractMesh(chassis) || !chassis.physicsAggregate) {
		throw new Error("Vehicle chassis must be a mesh with an enabled physics body.");
	}
	if (chassis.physicsAggregate.body.getMotionType() !== PhysicsMotionType.DYNAMIC) {
		throw new Error("Vehicle chassis requires a dynamic physics body.");
	}
	for (const [name, value, minimum, maximum] of [
		["maxEngineForce", config.maxEngineForce, 0, 1000000],
		["maxBrakeForce", config.maxBrakeForce, 0, 1000000],
		["maxSpeed", config.maxSpeed, 1, 100000],
		["maxSteerAngle", config.maxSteerAngle, 0, Math.PI / 2],
		["wheelBase", config.wheelBase, 1, 10000],
		["lateralGrip", config.lateralGrip, 0, 1000],
		["antiRollStiffness", config.antiRollStiffness ?? 0, 0, 1000000],
		["maxAntiRollForce", config.maxAntiRollForce ?? 100000, 0, 1000000],
	] as Array<[string, number, number, number]>) {
		clamp(value, minimum, maximum, name);
	}
	if (config.forwardFriction !== undefined) {
		validateFrictionCurve(config.forwardFriction, "forwardFriction");
	}
	if (config.sidewaysFriction !== undefined) {
		validateFrictionCurve(config.sidewaysFriction, "sidewaysFriction");
	}
	if (config.drivetrain !== undefined) {
		validateVehicleDrivetrain(config.drivetrain);
	}
	if (config.wheels !== undefined) {
		validateWheels(config.wheels);
	}
}

/** Restores editor-authored vehicle force controllers after a saved scene is loaded. */
export function restoreVehicles(scene: Scene): void {
	ensureVehicleController(scene);
}

/** Returns persisted vehicle authoring plus current non-serialized input, tire, and drivetrain evidence. */
export function listVehicles(scene: Scene): any {
	return {
		vehicles: structuredClone(vehicles(scene)).map((vehicle) => ({
			...vehicle,
			input: manualInputs.get(scene)?.get(vehicle.id) ?? null,
			active: !!scene.getNodeById(vehicle.chassisNodeId),
			wheelStates: Object.fromEntries(wheelStates.get(scene)?.get(vehicle.id) ?? []),
			drivetrainState: structuredClone(drivetrainStates.get(scene)?.get(vehicle.id) ?? null),
		})),
	};
}

/** Validates persisted vehicle chassis references and controller ranges without changing the scene. */
export function validateVehicles(scene: Scene): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const vehicle of vehicles(scene)) {
		const chassis = scene.getNodeById(vehicle.chassisNodeId);
		if (!isAbstractMesh(chassis) || !chassis.physicsAggregate) {
			errors.push(`Vehicle "${vehicle.name}" requires its chassis mesh with an enabled physics body.`);
			continue;
		}
		if (chassis.physicsAggregate.body.getMotionType() !== PhysicsMotionType.DYNAMIC) {
			errors.push(`Vehicle "${vehicle.name}" requires a dynamic chassis body.`);
		} else {
			try {
				validateConfiguration(scene, vehicle);
			} catch (error) {
				errors.push(`Vehicle "${vehicle.name}": ${error instanceof Error ? error.message : "invalid configuration."}`);
			}
		}
		if (!vehicle.actionMapName) {
			warnings.push(`Vehicle "${vehicle.name}" has no input action map; drive it through set_vehicle_input or a game script.`);
		}
	}
	return { errors, warnings };
}

/** Creates and validates a persisted vehicle without retaining caller-owned wheel objects. */
export function createVehicle(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = {
		id: data.id ?? Tools.RandomId(),
		name: data.name?.trim() || "Vehicle",
		chassisNodeId: data.chassisNodeId,
		enabled: data.enabled ?? true,
		maxEngineForce: data.maxEngineForce ?? 25000,
		maxBrakeForce: data.maxBrakeForce ?? 35000,
		maxSpeed: data.maxSpeed ?? 2500,
		maxSteerAngle: data.maxSteerAngle ?? 0.55,
		wheelBase: data.wheelBase ?? 180,
		lateralGrip: data.lateralGrip ?? 12,
		forwardFriction: structuredClone(data.forwardFriction ?? createDefaultVehicleFrictionCurve()),
		sidewaysFriction: structuredClone(data.sidewaysFriction ?? createDefaultVehicleFrictionCurve()),
		antiRollStiffness: data.antiRollStiffness ?? 2000,
		maxAntiRollForce: data.maxAntiRollForce ?? 100000,
		actionMapName: data.actionMapName ?? null,
		accelerateActionName: data.accelerateActionName ?? "Accelerate",
		reverseActionName: data.reverseActionName ?? "Reverse",
		leftActionName: data.leftActionName ?? "Steer Left",
		rightActionName: data.rightActionName ?? "Steer Right",
		brakeActionName: data.brakeActionName ?? "Brake",
		shiftUpActionName: data.shiftUpActionName ?? "Shift Up",
		shiftDownActionName: data.shiftDownActionName ?? "Shift Down",
		drivetrain: structuredClone(data.drivetrain ?? createDefaultVehicleDrivetrain()),
		wheels: structuredClone(data.wheels ?? createDefaultVehicleWheels()),
	};
	if (vehicles(scene).some((vehicle) => vehicle.id === config.id)) {
		throw new Error(`Vehicle "${config.id}" already exists.`);
	}
	validateConfiguration(scene, config);
	vehicles(scene).push(config);
	ensureVehicleController(scene);
	options.editor.layout.inspector.forceUpdate();
	return { ...config, active: true };
}

/** Atomically replaces wheel authoring and invalidates every wheel-derived transient state. */
export function setVehicleWheels(scene: Scene, data: any, options: IMCPActionOptions): any {
	const vehicle = getVehicle(scene, data.id);
	validateWheels(data.wheels);
	vehicle.wheels = structuredClone(data.wheels);
	wheelStates.get(scene)?.delete(vehicle.id);
	drivetrainStates.get(scene)?.delete(vehicle.id);
	options.editor.layout.inspector.forceUpdate();
	return { id: vehicle.id, wheels: structuredClone(vehicle.wheels) };
}

/** Atomically replaces provided vehicle fields only after the detached candidate passes full validation. */
export function setVehicle(scene: Scene, data: any, options: IMCPActionOptions): any {
	const vehicle = getVehicle(scene, data.id);
	const update = { ...data };
	delete update.id;
	const candidate = { ...structuredClone(vehicle), ...update };
	if (typeof candidate.name === "string") {
		candidate.name = candidate.name.trim();
	}
	// Validate a detached candidate so a rejected MCP/editor request cannot partially corrupt persisted metadata.
	validateConfiguration(scene, candidate);
	Object.assign(vehicle, candidate);
	if (Object.hasOwn(update, "drivetrain")) {
		drivetrainStates.get(scene)?.delete(vehicle.id);
	}
	ensureVehicleController(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(vehicle);
}

/** Removes persisted authoring and all transient input, tire, and drivetrain state owned by the vehicle. */
export function deleteVehicle(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = vehicles(scene).findIndex((vehicle) => vehicle.id === data.id);
	if (index === -1) {
		throw new Error(`Vehicle "${data.id}" was not found.`);
	}
	vehicles(scene).splice(index, 1);
	manualInputs.get(scene)?.delete(data.id);
	wheelStates.get(scene)?.delete(data.id);
	drivetrainStates.get(scene)?.delete(data.id);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Overrides vehicle controls in the active preview; inputs are transient and are not saved with the scene. */
export function setVehicleInput(scene: Scene, data: any): any {
	const vehicle = getVehicle(scene, data.id);
	let inputs = manualInputs.get(scene);
	if (!inputs) {
		manualInputs.set(scene, (inputs = new Map()));
	}
	const input = {
		throttle: clamp(data.throttle ?? 0, -1, 1, "throttle"),
		steering: clamp(data.steering ?? 0, -1, 1, "steering"),
		brake: clamp(data.brake ?? 0, 0, 1, "brake"),
		shiftUp: data.shiftUp ?? false,
		shiftDown: data.shiftDown ?? false,
		...(data.gear !== undefined ? { gear: data.gear } : {}),
	};
	if (typeof input.shiftUp !== "boolean" || typeof input.shiftDown !== "boolean") {
		throw new Error("shiftUp and shiftDown must be booleans.");
	}
	if ((input.shiftUp && input.shiftDown) || (input.gear !== undefined && (input.shiftUp || input.shiftDown))) {
		throw new Error("Choose exactly one gear command: shiftUp, shiftDown, or gear.");
	}
	if (input.gear !== undefined) {
		const drivetrain = getRuntimeVehicleDrivetrain(vehicle.drivetrain);
		if (!Number.isInteger(input.gear) || input.gear < -1 || input.gear > (drivetrain?.forwardGearRatios.length ?? 12)) {
			throw new Error(`gear must be an integer from -1 through ${drivetrain?.forwardGearRatios.length ?? 12}.`);
		}
	}
	inputs.set(data.id, input);
	ensureVehicleController(scene);
	return { id: data.id, input };
}
